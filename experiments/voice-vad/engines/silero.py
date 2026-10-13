#!/usr/bin/env python3
"""Silero VAD (v5 ONNX) -> per-20 ms-frame speech probability, on the shared grid.

Real weights only: the official `silero_vad.onnx` is loaded by onnxruntime and every
frame's reading is a model output. Nothing here is simulated, and nothing decides on
turn/endpointing: the output is one probability per frame, thresholded at the levels the
caller asks for.

Grid contract shared by every engine adapter in this directory (so the Node runner can
compare them without per-engine special cases):

  * 16 kHz mono, PCM16 in.
  * hop = 320 samples = 20 ms -- the same grid the shipped STS gate runs on.
  * `levels` is a dict `"<label>" -> "<string of '0'/'1', one char per 20 ms frame>"`.
    A `1` means "this engine calls this frame speech", BEFORE any postfilter. The runner
    applies one shared postfilter afterwards, so the postfilter is never double-counted.

Usage:
  python engines/silero.py --wav in.wav --out out.json [--levels 0.2,0.35,0.5,0.65,0.8]

Env:  SILERO_ONNX  path to silero_vad.onnx (default the probe copy under ~yale)
"""

import argparse
import array
import hashlib
import json
import os
import resource
import time
import wave

import numpy as np
import onnxruntime as ort

SR = 16_000
HOP = 320  # 20 ms
WINDOW = 512  # Silero v5's 16 kHz chunk
CONTEXT = 64  # Silero v5's 16 kHz context
DEFAULT_MODEL = os.environ.get(
    "SILERO_ONNX", "/data/home/yale/work/voice-vad-engines/silero/silero_vad.onnx"
)
# Byte-verified 2026-10-13: this URL's body is byte-identical to DEFAULT_MODEL
# (2327524 bytes, sha256[0:16] = 1a153a22f4509e29).
SOURCE_URL = (
    "https://raw.githubusercontent.com/snakers4/silero-vad/master/src/silero_vad/data/silero_vad.onnx"
)
DEFAULT_LEVELS = "0.2,0.35,0.5,0.65,0.8"


def read_wav(path):
    """16 kHz mono PCM16 -> float32 in [-1, 1). Refuses anything else rather than guess."""
    with wave.open(path, "rb") as w:
        channels = w.getnchannels()
        width = w.getsampwidth()
        rate = w.getframerate()
        frames = w.getnframes()
        raw = w.readframes(frames)
    if channels != 1 or width != 2:
        raise SystemExit(f"{path}: need mono PCM16, got channels={channels} width={width}")
    if rate != SR:
        raise SystemExit(f"{path}: need {SR} Hz, got {rate}")
    samples = array.array("h")
    samples.frombytes(raw)
    return np.asarray(samples, dtype=np.float32) / 32768.0


def sha256_16(path):
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()[:16]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--levels", default=DEFAULT_LEVELS)
    args = ap.parse_args()

    levels = [float(x) for x in args.levels.split(",") if x.strip()]
    x = read_wav(args.wav)
    n_frames = len(x) // HOP

    session = ort.InferenceSession(args.model, providers=["CPUExecutionProvider"])
    state = np.zeros((2, 1, 128), dtype=np.float32)
    sr = np.array(SR, dtype=np.int64)
    prev = np.zeros(CONTEXT, dtype=np.float32)
    probs = np.zeros(n_frames, dtype=np.float32)

    wall0, cpu0 = time.perf_counter(), time.process_time()
    for i in range(0, len(x), WINDOW):
        chunk = x[i : i + WINDOW]
        if len(chunk) < WINDOW:
            chunk = np.pad(chunk, (0, WINDOW - len(chunk)))
        inp = np.concatenate([prev, chunk]).reshape(1, -1)
        prev = chunk[-CONTEXT:]
        out = session.run(None, {"input": inp, "state": state, "sr": sr})
        state = np.asarray(out[1], dtype=np.float32)
        # The chunk's probability is a reading of the 512 samples it consumed. Attribute it to
        # every 20 ms frame those samples touch; later chunks overwrite, so a frame ends up
        # carrying the reading of the last window that covered it.
        p = float(np.asarray(out[0]).reshape(-1)[0])
        first = i // HOP
        last = min(n_frames, (i + WINDOW + HOP - 1) // HOP)
        for k in range(first, last):
            probs[k] = p
    wall = time.perf_counter() - wall0
    cpu = time.process_time() - cpu0
    rss_kb = int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)

    levels_out = {}
    for level in levels:
        bits = "".join("1" if probs[k] >= level else "0" for k in range(n_frames))
        levels_out[f"{level:g}"] = bits

    duration = n_frames * (HOP / SR)
    result = {
        "engine": "silero",
        "label": "Silero VAD v5 (ONNX Runtime)",
        "wav": os.path.abspath(args.wav),
        "sampleRate": SR,
        "hopSamples": HOP,
        "frameCount": n_frames,
        "durationSec": duration,
        "levels": levels_out,
        "levelKind": "probability-threshold",
        "probability": {
            "p10": float(np.percentile(probs, 10)),
            "p50": float(np.percentile(probs, 50)),
            "p90": float(np.percentile(probs, 90)),
            "max": float(probs.max()),
        },
        "probabilityPerFrame": [round(float(p), 5) for p in probs],
        "cost": {"wallSec": wall, "cpuSec": cpu, "rssPeakKb": rss_kb, "rtf": wall / duration},
        "weights": [
            {
                "path": os.path.abspath(args.model),
                "sha256_16": sha256_16(args.model),
                "sourceUrl": SOURCE_URL,
                "bytes": os.path.getsize(args.model),
            }
        ],
        "notes": (
            "512-sample windows with 64-sample context; each window's probability is attributed "
            "to the 20 ms frames its samples touch. Threshold applies to Silero's own speech "
            "probability, so the tradeoff rows are thresholds on one real distribution."
        ),
    }
    with open(args.out, "w") as handle:
        json.dump(result, handle)
    print(
        f"silero: frames={n_frames} dur={duration:.2f}s rtf={wall / duration:.4f} "
        f"cpu={cpu:.2f}s rss={rss_kb}KB sha={result['weights'][0]['sha256_16']}"
    )


if __name__ == "__main__":
    main()
