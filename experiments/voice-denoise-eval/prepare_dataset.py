#!/usr/bin/env python3
"""Build a controlled noisy-speech set from the project's existing clean clips.

The noise comes from a real Live Voice capture (`b8360029...`), using the
non-speech spans between the upstream's detected utterances. Each clean clip is
mixed with that noise at a fixed SNR, so every enhanced file has a clean
reference for SI-SDR and a clean-ASR transcript for CER.

Run with the SenseVoice virtualenv:
  /data/home/yale/work/sv-probe/v/bin/python3 prepare_dataset.py
"""

from __future__ import annotations

import json
import os
import wave
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent
OUT = Path("/tmp/voice-denoise-eval")
DATASET = OUT / "dataset"
CAPTURE = Path(
    "/data/home/yale/.cloudcli/voice-realtime-capture/"
    "b8360029-b6da-479b-8ea9-806e1bfbb632.wav"
)
TIMELINE = CAPTURE.with_suffix(".timeline.jsonl")

# Ten clean target clips, spanning short and long utterances. The enrollment
# clips are the cleanest; the extra-target clips are real session speech.
CLIPS = [
    "/tmp/speaker-gate-audition-2026-10-20/01-enroll/enroll-01_363d1ca4.wav",
    "/tmp/speaker-gate-audition-2026-10-20/01-enroll/enroll-02_4bea97df.wav",
    "/tmp/speaker-gate-audition-2026-10-20/01-enroll/enroll-03_1a3c7ff7.wav",
    "/tmp/speaker-gate-audition-2026-10-20/01-enroll/enroll-04_77f36308.wav",
    "/tmp/speaker-gate-audition-2026-10-20/01-enroll/enroll-05_3a895548.wav",
    "/tmp/speaker-gate-audition-2026-10-21/01-extra-target/extra-01_8c52b26c.wav",
    "/tmp/speaker-gate-audition-2026-10-21/01-extra-target/extra-02_e2fda1ad.wav",
    "/tmp/speaker-gate-audition-2026-10-21/01-extra-target/extra-03_46b164e0.wav",
    "/tmp/speaker-gate-audition-2026-10-21/01-extra-target/extra-05_7e729db5.wav",
    "/tmp/speaker-gate-audition-2026-10-21/01-extra-target/extra-07_dc6f668f.wav",
]

SNRS = [5.6, 10.0]


def read_mono(path: Path) -> tuple[np.ndarray, int]:
    audio, sr = sf.read(path, dtype="float32", always_2d=False)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    return audio.astype(np.float32), int(sr)


def rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(x, dtype=np.float64)) + 1e-12))


def active_rms(x: np.ndarray, sr: int) -> float:
    step = max(1, int(0.02 * sr))
    frames = x[: len(x) // step * step].reshape(-1, step)
    levels = np.sqrt(np.mean(np.square(frames, dtype=np.float64), axis=1))
    active = frames[levels >= 200.0]
    return rms(active.reshape(-1)) if active.size else rms(x)


def build_noise() -> np.ndarray:
    capture, sr = read_mono(CAPTURE)
    if sr != 16000:
        raise SystemExit(f"capture is {sr} Hz, expected 16000")
    intervals: list[tuple[int, int]] = []
    start = None
    for line in TIMELINE.read_text(encoding="utf-8").splitlines():
        event = json.loads(line)
        if event["kind"] == "speech_started":
            start = int(event["offsetMs"] * sr / 1000)
        elif event["kind"] == "speech_stopped" and start is not None:
            intervals.append((start, int(event["offsetMs"] * sr / 1000)))
            start = None
    mask = np.ones(len(capture), dtype=bool)
    for begin, end in intervals:
        mask[max(0, begin) : min(len(capture), end)] = False
    # Keep contiguous non-speech runs of at least 100 ms; concatenate them.
    runs: list[np.ndarray] = []
    begin = None
    for index, keep in enumerate(mask):
        if keep and begin is None:
            begin = index
        elif not keep and begin is not None:
            if index - begin >= int(0.1 * sr):
                runs.append(capture[begin:index])
            begin = None
    if begin is not None and len(capture) - begin >= int(0.1 * sr):
        runs.append(capture[begin:])
    if not runs:
        raise SystemExit("no non-speech runs in the capture")
    noise = np.concatenate(runs).astype(np.float32)
    print(f"noise buffer: {len(noise) / sr:.2f}s from {len(runs)} non-speech runs")
    return noise


def main() -> None:
    DATASET.mkdir(parents=True, exist_ok=True)
    noise = build_noise()
    noise_sr = 16000
    rows = []
    for clip_index, clip_name in enumerate(CLIPS):
        clean_path = Path(clip_name)
        clean, sr = read_mono(clean_path)
        if sr != noise_sr:
            raise SystemExit(f"{clean_path} is {sr} Hz, expected {noise_sr}")
        active = active_rms(clean, sr)
        for snr in SNRS:
            # A different noise segment per clip so the test is not one fixed
            # noise waveform repeated under every sentence.
            need = len(clean)
            offset = (clip_index * 7_919 + int(snr * 1000)) % max(1, len(noise) - need)
            segment = noise[offset : offset + need]
            if len(segment) < need:
                segment = np.tile(noise, int(np.ceil(need / len(noise))))[:need]
            noise_rms = rms(segment)
            scale = active / (10.0 ** (snr / 20.0) * noise_rms)
            noisy = clean + scale * segment
            peak = float(np.max(np.abs(noisy)))
            if peak > 0.98:
                noisy *= 0.98 / peak
            clip_id = f"c{clip_index + 1:02d}_snr{snr:g}"
            noisy_name = f"{clip_id}_noisy.wav"
            noisy_path = DATASET / noisy_name
            sf.write(noisy_path, noisy, sr, subtype="PCM_16")
            rows.append(
                {
                    "id": clip_id,
                    "snr": snr,
                    "clean": str(clean_path),
                    "cleanFile": str(DATASET / f"{clip_id}_clean.wav"),
                    "noisy": str(noisy_path),
                    "durationSec": round(len(clean) / sr, 3),
                    "cleanActiveRms": round(active, 1),
                    "noiseRms": round(noise_rms, 1),
                }
            )
            sf.write(DATASET / f"{clip_id}_clean.wav", clean, sr, subtype="PCM_16")
    manifest = DATASET / "manifest.json"
    manifest.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(rows)} mixtures -> {manifest}")


if __name__ == "__main__":
    main()
