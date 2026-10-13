#!/usr/bin/env python3
"""WebRTC VAD (the real C extension) -> per-20 ms-frame speech decision.

The engine is the compiled GMM detector from WebRTC's `common_audio`, reached here through
the prebuilt `webrtcvad-wheels` package. It is not a reimplementation and not a stand-in:
its only knob is `aggressiveness` (0..3), so its tradeoff rows are four aggressiveness
modes rather than four thresholds.

Same grid contract as `silero.py` -- see that file's docstring for the shared IO shape.

Usage:
  python engines/webrtc.py --wav in.wav --out out.json [--levels 0,1,2,3]
"""

import argparse
import array
import json
import os
import resource
import time
import wave

import numpy as np
import webrtcvad

SR = 16_000
HOP = 320  # 20 ms, which is also WebRTC VAD's own 20 ms frame
DEFAULT_LEVELS = "0,1,2,3"
SOURCE_URL = "https://github.com/wiseman/py-webrtcvad"
WEIGHTS_URL = "https://pypi.org/project/webrtcvad-wheels/"


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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--levels", default=DEFAULT_LEVELS)
    args = ap.parse_args()

    modes = [int(x) for x in args.levels.split(",") if x.strip()]
    x = read_wav(args.wav)
    n_frames = len(x) // HOP
    pcm = np.clip(x * 32768.0, -32768, 32767).astype(np.int16)

    levels_out = {}
    costs = {}
    for mode in modes:
        vad = webrtcvad.Vad(mode)
        wall0, cpu0 = time.perf_counter(), time.process_time()
        bits = []
        for k in range(n_frames):
            frame = pcm[k * HOP : (k + 1) * HOP].tobytes()
            bits.append("1" if vad.is_speech(frame, SR) else "0")
        wall = time.perf_counter() - wall0
        cpu = time.process_time() - cpu0
        levels_out[str(mode)] = "".join(bits)
        costs[str(mode)] = {"wallSec": wall, "cpuSec": cpu, "rtf": wall / (n_frames * HOP / SR)}

    rss_kb = int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    # One cost row for the scheme: the run of its lightest mode (mode 0), plus every mode's own.
    duration = n_frames * (HOP / SR)
    result = {
        "engine": "webrtc",
        "label": "WebRTC VAD (webrtcvad-wheels C extension)",
        "wav": os.path.abspath(args.wav),
        "sampleRate": SR,
        "hopSamples": HOP,
        "frameCount": n_frames,
        "durationSec": duration,
        "levels": levels_out,
        "levelKind": "aggressiveness",
        "cost": {
            "wallSec": costs[str(modes[0])]["wallSec"],
            "cpuSec": costs[str(modes[0])]["cpuSec"],
            "rssPeakKb": rss_kb,
            "rtf": costs[str(modes[0])]["rtf"],
            "perLevel": costs,
        },
        "weights": [
            {
                "path": "webrtcvad._webrtcvad (compiled C extension)",
                "sha256_16": None,
                "sourceUrl": WEIGHTS_URL,
                "bytes": os.path.getsize(webrtcvad.__file__) if hasattr(webrtcvad, "__file__") else None,
                "note": "no weights file: the detector is code, distributed as a prebuilt wheel",
            }
        ],
        "notes": (
            "Binary decision per 20 ms frame, no probability. Tradeoff rows are aggressiveness "
            "0..3. Unlike the ONNX engines there is no weights file; the artifact is the "
            "compiled extension itself (wheel " + WEIGHTS_URL + ")."
        ),
    }
    with open(args.out, "w") as handle:
        json.dump(result, handle)
    print(
        f"webrtc: frames={n_frames} dur={duration:.2f}s modes={modes} "
        f"rtf={result['cost']['rtf']:.5f} rss={rss_kb}KB"
    )


if __name__ == "__main__":
    main()
