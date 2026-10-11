#!/usr/bin/env python3
"""Real local inference of LiveKit's Turn Detector v1-mini, INSIDE the official livekit-agents
framework, for the P0.6 turn-detection comparison (group C).

WHY THE FRAMEWORK AND NOT THE MODEL DIRECTLY.
The LiveKit Model License (fetched 2026-10-11, "Last Updated: November 25, 2024") grants the right
to "use, reproduce, distribute, copy, and create derivative works of the LiveKit Materials", but
Section 3.b(i) conditions that right on NOT using a LiveKit Model "on a standalone basis or with any
frameworks other than LiveKit Agents". So the licensed way to exercise v1-mini is through the
framework. This script therefore drives `livekit.agents.inference.TurnDetector(version="v1-mini")`
and its `stream()` API — the same object an `AgentSession` mounts — rather than calling the
`livekit.local_inference.EOT` ctypes binding directly.

WHAT IT MEASURES. For each candidate point (the onset of a silence run, the same interrogation point
groups A and B answer), it feeds the clip from its start up to the onset through the framework's
streaming turn detector and reads `end_of_turn_probability`. It records, per point, the raw
probability, the framework's own `inference_duration`/`detection_delay`, and the wall-clock latency
of the decision; and — as the process's CPU time and peak RSS — the two resource readings the
comparison's other groups report.

THE INPUT OUTER (up to 1.2 s). The local transport keeps a 1.2 s ring buffer (`_CLIENT_BUFFER_SAMPLES
= 1.2 * 16000 = 19200`) and predicts over whatever it holds; that is the model's receptive field, so
"audio up to the onset" here means, in practice, the last 1.2 s ending at the onset — the same
horizon a live pipeline would use.

Usage:
  .venv/bin/python -I run_livekit_eot.py --items items.json --out out.json [--threshold 0.5]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import resource
import struct
import sys
import time

import numpy as np

DEFAULT_SAMPLE_RATE = 16000
# 1.2 s of 16 kHz — the local transport's ring-buffer capacity, pushed in 30 ms chunks so no single
# frame exceeds it.
PUSH_CHUNK = 480


def decode_wav16(path: str) -> tuple[int, np.ndarray]:
    """16-bit PCM RIFF WAVE -> (sample_rate, int16 mono). Mirrors the harness's decodeWav."""
    with open(path, "rb") as fh:
        buf = fh.read()
    if buf[0:4] != b"RIFF":
        raise ValueError(f"not a RIFF file: {path}")
    rate = channels = bits = None
    data = None
    off = 12
    while off + 8 <= len(buf):
        cid = buf[off : off + 4]
        size = struct.unpack_from("<I", buf, off + 4)[0]
        if cid == b"fmt ":
            fmt_tag, channels, rate, _br, _ba, bits = struct.unpack_from("<HHIIHH", buf, off + 8)
            if bits != 16 or fmt_tag not in (1, 0xFFFE):
                raise ValueError(f"expected 16-bit PCM, got fmt={fmt_tag} bits={bits}")
        elif cid == b"data":
            data = buf[off + 8 : off + 8 + size]
        off += 8 + size + (size % 2)
    if data is None or rate is None:
        raise ValueError(f"missing fmt or data chunk: {path}")
    frames = len(data) // (channels * 2)
    raw = np.frombuffer(data[: frames * channels * 2], dtype="<i2").reshape(frames, channels)
    mono = (raw.sum(axis=1) // channels).astype(np.int16)
    return int(rate), mono


async def main_async(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--items", required=True, help="JSON list of {id,wav,atMs,truth,pauseMs}")
    ap.add_argument("--out", required=True)
    ap.add_argument("--threshold", type=float, default=0.5)
    args = ap.parse_args(argv)

    with open(args.items, "r", encoding="utf-8") as fh:
        items = json.load(fh)

    # Imported here (not at module top) so the argparse/usage text above stays readable and so a
    # missing dependency surfaces as this script's own error, not an import-time traceback.
    from livekit import rtc
    from livekit.agents import inference

    detector = inference.TurnDetector(version="v1-mini")
    describe = detector.describe_options() if hasattr(detector, "describe_options") else {}

    rss_start = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss  # KiB on Linux

    records: list[dict] = []
    cold_ms: float | None = None
    rss_peak = rss_start
    cpu0 = time.process_time()

    for i, item in enumerate(items):
        rate, pcm = decode_wav16(item["wav"])
        if rate != DEFAULT_SAMPLE_RATE:
            raise ValueError(f"{item['id']}: expected {DEFAULT_SAMPLE_RATE} Hz, got {rate}")
        onset_sample = int(round((item["atMs"] / 1000.0) * rate))
        onset_sample = max(0, min(onset_sample, pcm.shape[0]))
        window = pcm[:onset_sample]  # audio from the clip start up to the candidate point

        stream = detector.stream()
        # Push the window in 30 ms chunks. The transport drains the channel asynchronously into its
        # 1.2 s ring buffer; yield once so the drain lands before predict() snapshots the buffer.
        for c0 in range(0, window.shape[0], PUSH_CHUNK):
            chunk = np.ascontiguousarray(window[c0 : c0 + PUSH_CHUNK])
            frame = rtc.AudioFrame(
                data=chunk.tobytes(),
                sample_rate=rate,
                num_channels=1,
                samples_per_channel=int(chunk.shape[0]),
            )
            stream.push_audio(frame)
        await asyncio.sleep(0.05)  # let `_drain_audio_channel` fill the ring buffer

        t0 = time.perf_counter()
        ev = await stream.predict()
        wall_ms = (time.perf_counter() - t0) * 1000.0
        prob = float(ev.end_of_turn_probability)
        if i == 0:
            cold_ms = wall_ms
        await stream.aclose()

        rss_peak = max(rss_peak, resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
        records.append(
            {
                "id": item["id"],
                "atMs": item["atMs"],
                "truth": item["truth"],
                "pauseMs": item.get("pauseMs"),
                "endOfTurnProbability": round(prob, 6),
                "predicted": "END" if prob >= args.threshold else "CONTINUE",
                "latencyMs": round(wall_ms, 3),
                "inferenceDurationMs": round(1000.0 * float(ev.inference_duration), 3)
                if getattr(ev, "inference_duration", None) is not None
                else None,
                "detectionDelayMs": round(1000.0 * float(ev.detection_delay), 3)
                if getattr(ev, "detection_delay", None) is not None
                else None,
                "phase": "cold" if i == 0 else "warm",
            }
        )

    cpu_ms = (time.process_time() - cpu0) * 1000.0
    warm = sorted(r["latencyMs"] for r in records if r["phase"] == "warm")

    def pct(p: float) -> float | None:
        if not warm:
            return None
        idx = min(len(warm) - 1, max(0, int(np.ceil(p * len(warm))) - 1))
        return round(warm[idx], 2)

    cont = [r for r in records if r["truth"] == "CONTINUE"]
    ends = [r for r in records if r["truth"] == "END"]
    corr = [r for r in records if r["truth"] == "CORRECTION"]
    false_cutoff = sum(1 for r in cont if r["predicted"] == "END")
    missed = sum(1 for r in ends if r["predicted"] == "CONTINUE")

    # A threshold sweep, so the 0.5 reading is not the only one on record and the reader can see how
    # separable this batch actually is.
    sweep = []
    for thr in [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]:
        fc = sum(1 for r in cont if r["endOfTurnProbability"] >= thr)
        ms = sum(1 for r in ends if r["endOfTurnProbability"] < thr)
        sweep.append({"threshold": thr, "falseCutoff": fc, "missedEndpoint": ms})

    out = {
        "tool": "run_livekit_eot.py",
        "framework": "livekit-agents (inference.TurnDetector)",
        "model": "turn-detector-v1-mini",
        "detectorOptions": describe,
        "sampleRate": DEFAULT_SAMPLE_RATE,
        "outerWindowSeconds": 1.2,
        "thresholdUsed": args.threshold,
        "license": {
            "document": "LiveKit Model License Agreement",
            "lastUpdated": "November 25, 2024",
            "fetchedAt": "2026-10-11",
            "section3b": "use permitted only together with the LiveKit Agents framework (not standalone / not other frameworks), and outputs must not be used to improve non-LiveKit models",
            "compliance": "exercised through livekit.agents.inference.TurnDetector(version='v1-mini') in an isolated sandbox venv; not linked into any ClaudeCodeUI build",
        },
        "coldLatencyMs": cold_ms,
        "warmLatencyP50Ms": pct(0.5),
        "warmLatencyP90Ms": pct(0.9),
        "cpuMsTotal": round(cpu_ms, 3),
        "cpuMsPerDecision": round(cpu_ms / max(1, len(records)), 3),
        "rssPeakMb": round(rss_peak / 1024.0, 1),
        "rssDeltaMb": round((rss_peak - rss_start) / 1024.0, 1),
        "counts": {
            "points": len(records),
            "continue": len(cont),
            "end": len(ends),
            "correction": len(corr),
            "falseCutoff": false_cutoff,
            "missedEndpoint": missed,
            "correctionEndDetected": sum(1 for r in corr if r["predicted"] == "END"),
        },
        "thresholdSweep": sweep,
        "readings": records,
    }
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2)
        fh.write("\n")
    print(
        f"livekit v1-mini: {len(records)} points, warm p50 {out['warmLatencyP50Ms']} ms "
        f"p90 {out['warmLatencyP90Ms']} ms, falseCutoff {false_cutoff}/{len(cont)}, missed {missed}/{len(ends)}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main_async(sys.argv[1:])))
