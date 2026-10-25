#!/usr/bin/env python3
"""Transcribe every arm with SenseVoice and report CER / SI-SDR.

The clean clip's own transcript is the reference. That makes this a relative
ASR experiment: the clean recogniser can itself be wrong, but every arm is
scored against the same string, so the comparison of noisy vs enhanced is
apples-to-apples. The real DashScope model should confirm the winner on a few
clips before production (see REPORT.md).

Run with the SenseVoice virtualenv:
  /data/home/yale/work/sv-probe/v/bin/python3 evaluate.py
"""

from __future__ import annotations

import csv
import json
import os
import re
from collections import defaultdict
from pathlib import Path

import numpy as np
import sherpa_onnx
import soundfile as sf

OUT = Path("/tmp/voice-denoise-eval")
DATASET = OUT / "dataset"
ENHANCED = OUT / "enhanced"
MODEL_DIR = Path(
    "/data/home/yale/work/sv-probe/"
    "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"
)
ARMS = ["raw", "gtcrn", "dpdfnet", "rnnoise", "rnnoise085"]

PUNCT = re.compile(r"[\s，。！？、；：,.!?;:\"'“”‘’（）()\[\]【】《》<>·…—-]+")


def normalize(text: str) -> str:
    return PUNCT.sub("", text).lower()


def edit_distance(a: str, b: str) -> int:
    if len(a) < len(b):
        a, b = b, a
    previous = list(range(len(b) + 1))
    for i, left in enumerate(a, 1):
        current = [i]
        for j, right in enumerate(b, 1):
            current.append(
                min(
                    previous[j] + 1,
                    current[j - 1] + 1,
                    previous[j - 1] + (left != right),
                )
            )
        previous = current
    return previous[-1]


def cer(reference: str, hypothesis: str) -> float:
    ref = normalize(reference)
    hyp = normalize(hypothesis)
    if not ref:
        return 0.0 if not hyp else 1.0
    return edit_distance(ref, hyp) / len(ref)


def rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(x, dtype=np.float64)) + 1e-12))


def si_sdr(reference: np.ndarray, estimate: np.ndarray) -> float:
    n = min(len(reference), len(estimate))
    if n == 0:
        return float("-inf")
    ref = reference[:n].astype(np.float64)
    est = estimate[:n].astype(np.float64)
    ref -= ref.mean()
    est -= est.mean()
    alpha = float(np.dot(est, ref) / (np.dot(ref, ref) + 1e-12))
    target = alpha * ref
    noise = est - target
    return float(10.0 * np.log10((np.sum(target * target) + 1e-12) / (np.sum(noise * noise) + 1e-12)))


def read(path: Path) -> tuple[np.ndarray, int]:
    audio, sr = sf.read(path, dtype="float32", always_2d=False)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    return audio.astype(np.float32), int(sr)


def main() -> None:
    recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=str(MODEL_DIR / "model.int8.onnx"),
        tokens=str(MODEL_DIR / "tokens.txt"),
        use_itn=True,
        language="auto",
        num_threads=4,
        debug=False,
    )

    def transcribe(path: Path) -> str:
        audio, sr = read(path)
        stream = recognizer.create_stream()
        stream.accept_waveform(sr, audio)
        recognizer.decode_stream(stream)
        return stream.result.text

    manifest = json.loads((DATASET / "manifest.json").read_text(encoding="utf-8"))
    rows = []
    references = {}
    for item in manifest:
        clean, sr = read(Path(item["cleanFile"]))
        references[item["id"]] = transcribe(Path(item["cleanFile"]))
        for arm in ARMS:
            if arm == "raw":
                path = Path(item["noisy"])
            else:
                path = ENHANCED / f"{item['id']}_{arm}.wav"
            if not path.exists():
                print(f"skip missing {path}")
                continue
            enhanced, enhanced_sr = read(path)
            text = transcribe(path)
            rows.append(
                {
                    "id": item["id"],
                    "snr": item["snr"],
                    "arm": arm,
                    "durationSec": item["durationSec"],
                    "cer": cer(references[item["id"]], text),
                    "siSdrDb": si_sdr(clean, enhanced),
                    "reference": references[item["id"]],
                    "text": text,
                }
            )
            print(f"{item['id']} {arm:10s} cer={rows[-1]['cer']:.3f} si_sdr={rows[-1]['siSdrDb']:.1f} text={text!r}")

    (OUT / "results.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    with (OUT / "results.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)

    by_arm = defaultdict(list)
    for row in rows:
        by_arm[(row["snr"], row["arm"])].append(row)
    print("\n## Macro mean CER / SI-SDR")
    for (snr, arm), group in sorted(by_arm.items()):
        mean_cer = float(np.mean([r["cer"] for r in group]))
        mean_sdr = float(np.mean([r["siSdrDb"] for r in group]))
        print(f"snr={snr:>4} arm={arm:10s} n={len(group):2d} CER={mean_cer:.4f} SI-SDR={mean_sdr:6.1f} dB")

    print("\n## Micro CER")
    for (snr, arm), group in sorted(by_arm.items()):
        ref_len = sum(len(normalize(r["reference"])) for r in group)
        edits = sum(edit_distance(normalize(r["reference"]), normalize(r["text"])) for r in group)
        print(f"snr={snr:>4} arm={arm:10s} chars={ref_len:4d} edits={edits:4d} CER={edits / max(1, ref_len):.4f}")


if __name__ == "__main__":
    main()
