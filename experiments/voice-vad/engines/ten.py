#!/usr/bin/env python3
"""TEN VAD (ONNX) -> per-20 ms-frame speech decision, read window-by-window.

Real weights: the official `ten-vad.onnx` is driven through sherpa-onnx's TEN wrapper, which
runs the model's own feature pipeline (41-dim filterbank over 3-frame context, 4x64 LSTM
state) — this adapter does not reimplement the front end.

The raw reading used here is sherpa's per-window verdict (`is_speech_detected()`, one call
per 256-sample window), NOT its segment list: segments additionally apply
`min_silence_duration`/`min_speech_duration`, i.e. endpointing the other engines do not get.
Using the per-window verdict keeps all four model engines on the same footing — a raw frame
decision followed by one shared postfilter.

Same grid contract as `silero.py` -- see that file's docstring for the shared IO shape.

Usage:
  python engines/ten.py --wav in.wav --out out.json [--levels 0.2,0.35,0.5,0.65,0.8]

Env:  TEN_ONNX  path to ten-vad.onnx (default the probe copy under /tmp/vad5/models)
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
import sherpa_onnx

SR = 16_000
HOP = 320  # 20 ms shared grid
WINDOW = 256  # TEN VAD's own window
DEFAULT_MODEL = os.environ.get(
    "TEN_ONNX", "/data/home/yale/work/voice-vad-engines/ten-vad/ten-vad.onnx"
)
# Byte-verified 2026-10-13: this release asset's body is byte-identical to DEFAULT_MODEL
# (332211 bytes, sha256[0:16] = 718cb7eef47e3cf5).
SOURCE_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/ten-vad.onnx"
WRAPPER_URL = "https://github.com/k2-fsa/sherpa-onnx"
# The model itself is TEN-framework's (github.com/TEN-framework/ten-vad). sherpa ships its own
# copy of the same network with metadata added, which is the one its loader accepts; that copy
# is what SOURCE_URL resolves to and what the sha above pins. TEN-framework's own
# `src/onnx_model/ten-vad.onnx` is 315449 bytes, sha256[0:16] = e10b98a0cab1c98e.
UPSTREAM_URL = "https://github.com/TEN-framework/ten-vad"
DEFAULT_LEVELS = "0.2,0.35,0.5,0.65,0.8"


def read_wav(path):
    with wave.open(path, "rb") as w:
        channels = w.getnchannels()
        width = w.getsampwidth()
        rate = w.getframerate()
        raw = w.readframes(w.getnframes())
    if channels != 1 or width != 2:
        raise SystemExit(f"{path}: need mono PCM16, got channels={channels} width={width}")
    if rate != SR:
        raise SystemExit(f"{path}: need {SR} Hz, got {rate}")
    samples = array.array("h")
    samples.frombytes(raw)
    return np.asarray(samples, dtype=np.float32) / 32768.0


def windows_to_frames(flags, n_frames):
    """Rasterize per-window verdicts onto the 20 ms grid: a frame is speech if any window
    overlapping it is speech."""
    bits = ["0"] * n_frames
    for index, flag in enumerate(flags):
        if not flag:
            continue
        start = index * WINDOW
        end = start + WINDOW
        first = start // HOP
        last = min(n_frames, (end + HOP - 1) // HOP)
        for k in range(first, last):
            bits[k] = "1"
    return "".join(bits)


def run_level(x, threshold, model_path, n_frames):
    config = sherpa_onnx.VadModelConfig()
    config.ten_vad.model = model_path
    config.ten_vad.threshold = threshold
    config.sample_rate = SR
    config.num_threads = 1
    detector = sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=120)

    wall0, cpu0 = time.perf_counter(), time.process_time()
    flags = []
    for i in range(0, len(x), WINDOW):
        chunk = x[i : i + WINDOW]
        if len(chunk) < WINDOW:
            chunk = np.pad(chunk, (0, WINDOW - len(chunk)))
        detector.accept_waveform(chunk.tolist())
        flags.append(1 if detector.is_speech_detected() else 0)
    detector.flush()
    wall = time.perf_counter() - wall0
    cpu = time.process_time() - cpu0
    return windows_to_frames(flags, n_frames), wall, cpu


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--levels", default=DEFAULT_LEVELS)
    args = ap.parse_args()

    levels = [float(v) for v in args.levels.split(",") if v.strip()]
    x = read_wav(args.wav)
    n_frames = len(x) // HOP
    duration = n_frames * (HOP / SR)

    levels_out = {}
    costs = {}
    for level in levels:
        bits, wall, cpu = run_level(x, level, args.model, n_frames)
        levels_out[f"{level:g}"] = bits
        costs[f"{level:g}"] = {
            "wallSec": wall,
            "cpuSec": cpu,
            "rtf": wall / duration,
            "speechFrames": bits.count("1"),
        }

    rss_kb = int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    baseline = costs["0.5"] if "0.5" in costs else next(iter(costs.values()))
    result = {
        "engine": "ten",
        "label": "TEN VAD (ONNX, via sherpa-onnx)",
        "wav": os.path.abspath(args.wav),
        "sampleRate": SR,
        "hopSamples": HOP,
        "frameCount": n_frames,
        "durationSec": duration,
        "levels": levels_out,
        "levelKind": "probability-threshold",
        "cost": {
            "wallSec": baseline["wallSec"],
            "cpuSec": baseline["cpuSec"],
            "rssPeakKb": rss_kb,
            "rtf": baseline["rtf"],
            "perLevel": costs,
        },
        "weights": [
            {
                "path": os.path.abspath(args.model),
                "sha256_16": hashlib.sha256(open(args.model, "rb").read()).hexdigest()[:16],
                "sourceUrl": SOURCE_URL,
                "upstreamOf": UPSTREAM_URL,
                "bytes": os.path.getsize(args.model),
                "note": (
                    f"driven by the sherpa-onnx wrapper ({WRAPPER_URL}), which owns the feature "
                    f"pipeline; the network is TEN-framework's ({UPSTREAM_URL}), redistributed by "
                    "sherpa with the metadata its loader requires"
                ),
            }
        ],
        "notes": (
            f"Per-window verdict from sherpa's TEN wrapper at {WINDOW}-sample windows, rasterized "
            "to the 20 ms grid (a frame is speech if any window touching it is). Cost row is the "
            "0.5 run; every level re-runs inference because sherpa takes the threshold at "
            "construction."
        ),
    }
    with open(args.out, "w") as handle:
        json.dump(result, handle)
    print(
        f"ten: frames={n_frames} dur={duration:.2f}s rtf={baseline['rtf']:.4f} "
        f"cpu={baseline['cpuSec']:.2f}s rss={rss_kb}KB "
        + " ".join(f"{k}:{v['speechFrames'] / n_frames:.3f}" for k, v in costs.items())
    )


if __name__ == "__main__":
    main()
