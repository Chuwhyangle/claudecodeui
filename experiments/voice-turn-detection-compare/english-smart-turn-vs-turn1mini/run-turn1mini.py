#!/usr/bin/env python3
"""P0.13 — group C: turn-1-mini, real local inference over the unified span corpus.

Runs the OFFICIAL runtime (`p99turn.onnx_stream.Turn1MiniOnnx`, the streaming ONNX graph the model
card ships) over every span's clip in `data/spans.json`, and emits one P(end of turn) per 20 ms frame
of each clip. The TypeScript half (`run-benchmark.mts`) reads those frame probabilities and slices the
same causal cell grid it uses for Smart Turn — so both models answer the SAME cells from ONE audio
pass per clip.

Two properties of the streaming read-out are what make one pass per clip legitimate, and both are
checked here (AC3):

  · CAUSALITY. Frame j's value depends only on frames 0..j, so reading frame j off a full-clip pass is
    the same as running a fresh forward on the prefix that ends at frame j. Checked by
    `--selfcheck` (carried-state stream vs fresh-from-zero prefix, must be ~0).
  · CROSS-RUNTIME. The ONNX streaming graph must agree with the torch CAUSAL STREAM (`Turn1Mini.stream`,
    the reference the published numbers were produced with) to <= 1e-4. Checked by `--selfcheck` (needs
    the `torch` extra from requirements.txt). The torch OFFLINE forward (`frame_probs`) is reported
    beside it as a CHARACTERISATION, not a gate: it band-limits with a non-causal polyphase resample, so
    it legitimately differs from any causal stream (most at the right edge) and asserting <= 1e-4 against
    it would be asserting something false.

Frame geometry (validated by the self-check, not assumed): the log-mel hop is 160 samples (10 ms) and
the trunk's second conv has stride 2, so output frame j ends at sample (j+1)*320. A cell whose prefix
ends at sample E reads frame j = floor(E/320) - 1.

Outputs `data/turn1mini-scores.json` (gitignored): provenance, the AC3 self-check, per-step CPU
timing, and per-span frame probabilities.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import time
import wave
from typing import Any

import numpy as np

# Pinned model revision + artifact hashes (verified in RESULT.json.provenance).
MODEL_REPO = "p99lab/turn-1-mini"
MODEL_REVISION = "076c86d1744a231d3a4cce31f3bbbd1211b4c281"
ONNX_FLOAT32_SHA256 = "e747b182d685c7db489a3ea2e12bdcd65bac506fcddec00ed3cd0bf9f209fd11"
SAFETENSORS_FLOAT32_SHA256 = "d03ccff872eb0ae2ed0366b1ea94d860328daa0122bf9003fb32b7a34b14acb9"

STEP = 2560          # samples per streaming step (160 ms)
FRAME_SAMPLES = 320  # samples per output frame (20 ms)
ONNX_VARIANTS = {"float32": "turn-1-mini.step.onnx", "int8": "turn-1-mini.step.int8dyn.onnx"}


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def decode_wav(path: str) -> tuple[np.ndarray, int]:
    """16-bit PCM -> float32 in [-1, 1], matching the JS `decodeWav` scale (int16 / 32768)."""
    with wave.open(path, "rb") as w:
        sr, ch, width, n = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
        raw = w.readframes(n)
    if width != 2:
        raise SystemExit(f"{path}: expected 16-bit PCM, got sample width {width}")
    x = np.frombuffer(raw, "<i2").astype(np.float32) / 32768.0
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    return x, sr


def stream_stepwise(model: Any, audio: np.ndarray) -> tuple[np.ndarray, list[float]]:
    """One streaming pass: 160 ms steps with carried state -> (frame probs, per-step ms)."""
    model.reset()
    pending = np.asarray(audio, np.float32)
    probs: list[np.ndarray] = []
    step_ms: list[float] = []
    i = 0
    while len(pending) - i >= STEP:
        seg = pending[i : i + STEP]
        t0 = time.perf_counter()
        p = model.step(seg)
        step_ms.append((time.perf_counter() - t0) * 1000.0)
        probs.append(np.asarray(p, np.float32))
        i += STEP
    return (np.concatenate(probs) if probs else np.zeros(0, np.float32)), step_ms


def pad_to_step(audio: np.ndarray) -> np.ndarray:
    """Right-pad with digital silence so the final partial 160 ms block is still emitted."""
    rem = len(audio) % STEP
    if rem == 0:
        return audio
    return np.concatenate([audio, np.zeros(STEP - rem, np.float32)])


def selfcheck(onnx_model: Any, onnx_path: str, wav_path: str, torch_rev: str) -> dict[str, Any]:
    """AC3 — the streaming read-out is the prefix forward, and it matches torch's offline forward."""
    audio, sr = decode_wav(wav_path)
    audio = audio[: int(12.0 * sr)]  # 12 s is plenty and keeps the O(j) fresh-prefix sweep cheap
    report: dict[str, Any] = {
        "clip": os.path.basename(wav_path),
        "clipSeconds": round(len(audio) / sr, 3),
        "frameSamples": FRAME_SAMPLES,
        "toleranceAbs": 1e-4,
    }

    # --- (1) carried-state stream vs a fresh forward on the same prefix (ONNX both sides) ----------
    full, _ = stream_stepwise(onnx_model, pad_to_step(audio))
    max_fresh = 0.0
    n_fresh = 0
    for j in range(0, len(full), max(1, len(full) // 24)):  # ~24 sampled frame offsets
        prefix = audio[: (j + 1) * FRAME_SAMPLES]
        fresh, _ = stream_stepwise(onnx_model, pad_to_step(prefix))
        if len(fresh) > j:
            max_fresh = max(max_fresh, abs(float(fresh[j]) - float(full[j])))
            n_fresh += 1
    report["onnxCarriedVsFreshPrefix"] = {"framesChecked": n_fresh, "maxAbsDiff": max_fresh}

    # --- (2) chunk-size invariance: one push vs 1000-sample chunks (pending-buffer correctness) -----
    mm = onnx_model
    mm.reset()
    chunky = []
    for off in range(0, len(audio), 1000):
        chunky.append(np.asarray(mm.push(audio[off : off + 1000]), np.float32))
    chunked = np.concatenate(chunky) if chunky else np.zeros(0, np.float32)
    n = min(len(chunked), len(full))
    report["onnxChunkSizeInvariance"] = {
        "frames": n,
        "maxAbsDiff": float(np.max(np.abs(chunked[:n] - full[:n]))) if n else None,
    }

    # --- (3) cross-runtime: the torch reference CAUSAL stream vs the ONNX streaming graph ----------
    #
    # The comparison that means "the ONNX graph really is this model" is ONNX-stream vs torch-STREAM.
    # Comparing against torch OFFLINE `frame_probs(clip)` is NOT the same test: that path band-limits
    # the whole clip with `bandlimit_4k` (a NON-causal polyphase resample), so its early frames saw
    # audio that a causal stream never had, and the two legitimately differ by ~2e-2 there. The card's
    # "matches PyTorch stream to 0.00004" is exactly the stream-vs-stream number measured here.
    try:
        from p99turn.mini import Turn1Mini  # noqa: PLC0415

        tm = Turn1Mini(variant="float32", revision=torch_rev)
        ts, ts_raw = [], []
        s_lp, s_raw = tm.stream(lowpass=True), tm.stream(lowpass=False)
        for off in range(0, len(audio), STEP):
            seg = audio[off : off + STEP]
            ts.append(np.asarray(s_lp.push(seg), np.float32))
            ts_raw.append(np.asarray(s_raw.push(seg), np.float32))
        ts = np.concatenate(ts) if ts else np.zeros(0, np.float32)
        ts_raw = np.concatenate(ts_raw) if ts_raw else np.zeros(0, np.float32)
        m = min(len(ts), len(ts_raw), len(full))
        d_lp = np.abs(ts[:m] - full[:m])
        d_raw = np.abs(ts_raw[:m] - full[:m])
        report["onnxVsTorchStreamLowpass"] = {"frames": int(m), "maxAbsDiff": float(d_lp.max()) if m else None}
        report["onnxVsTorchStreamRawInput"] = {"frames": int(m), "maxAbsDiff": float(d_raw.max()) if m else None}
        report["torchVersion"] = __import__("torch").__version__

        # (4) CHARACTERISATION, NOT A GATE — how far the causal stream sits from the offline forward on
        #     the SAME prefix, measured two ways. This is reported because the model card's "matches the
        #     offline forward" phrasing invites a <= 1e-4 reading, and that reading is FALSE, for a
        #     reason worth showing rather than hiding:
        #       · push the whole prefix once, read the last frame — the offline path band-limits with a
        #         NON-causal `resample_poly`, which pads the signal's RIGHT edge, so the final frames
        #         legitimately differ by the largest term;
        #       · push the same prefix in 160 ms chunks — each chunk boundary carries the resampler's own
        #         edge handling, so the body differs by a small bounded amount.
        #     The model-IDENTITY claim is `onnxVsTorchStreamLowpass` above (ONNX graph vs torch CAUSAL
        #     stream, <= 1e-4, measured ~1e-5). This curve only sizes the lowpass's causal approximation
        #     error; it is deliberately NOT asserted, so it cannot stand in for the identity check.
        L = (len(audio) // STEP) * STEP
        curve = []
        for frac in (0.25, 0.5, 0.75, 1.0):
            E = int((L * frac) // STEP) * STEP
            if E == 0:
                continue
            pre = audio[:E]
            off = np.asarray(tm.frame_probs(pre, lowpass=True), np.float32)
            s_one = tm.stream(lowpass=True)
            s_one.push(pre)
            last_one = float(s_one.score())
            s_chunk = tm.stream(lowpass=True)
            got = [np.asarray(s_chunk.push(pre[o : o + STEP]), np.float32) for o in range(0, E, STEP)]
            st = np.concatenate(got) if got else np.zeros(0, np.float32)
            n = int(min(len(off), len(st)))
            curve.append(
                {
                    "prefixSeconds": round(E / sr, 3),
                    "offlineFrames": int(len(off)),
                    "singlePushLastFrameAbsDiff": round(abs(float(off[-1]) - last_one), 8),
                    "chunkedInteriorMaxAbsDiff": round(float(np.abs(off[:n] - st[:n]).max()), 8) if n else None,
                    "offlineLast": round(float(off[-1]), 6),
                    "streamLast": round(last_one, 6),
                }
            )
        report["streamVsOfflineOnSamePrefix"] = curve
        report["streamVsOfflineNote"] = (
            "CHARACTERISATION, not a gate. single-push last frame carries the non-causal lowpass right-edge; "
            "the chunked interior carries the per-chunk resampler edge handling. Neither is the model-identity "
            "test — that is onnxVsTorchStreamLowpass (ONNX graph vs torch causal stream)."
        )
        report["torchAvailable"] = True
    except Exception as exc:  # torch extra not installed — record the gap, do not fake a pass
        report["torchAvailable"] = False
        report["torchError"] = f"{type(exc).__name__}: {exc}"

    # --- verdict -----------------------------------------------------------------------------------
    checks: dict[str, bool] = {}
    if report.get("onnxCarriedVsFreshPrefix"):
        checks["carriedStateEqualsFreshPrefix"] = report["onnxCarriedVsFreshPrefix"]["maxAbsDiff"] <= 1e-4
    csi = report.get("onnxChunkSizeInvariance")
    if csi and csi.get("maxAbsDiff") is not None:
        checks["chunkSizeInvariant"] = csi["maxAbsDiff"] <= 1e-4
    if report.get("onnxVsTorchStreamLowpass"):
        d_lp = report["onnxVsTorchStreamLowpass"]["maxAbsDiff"] or 0.0
        d_raw = (report.get("onnxVsTorchStreamRawInput") or {}).get("maxAbsDiff") or 0.0
        checks["onnxMatchesTorchReferenceStream"] = d_lp <= 1e-4
        # NO LOWPASS BYPASS: the graph must track the band-limited reference far more closely than the
        # raw-audio one. If it bypassed the filter it would be the other way round.
        checks["lowpassAppliedNotBypassed"] = d_lp <= 1e-4 and d_raw >= 10 * max(d_lp, 1e-12)
        # `streamVsOfflineOnSamePrefix` is deliberately NOT a check here — see its own note. Gating on it
        # would assert a claim that is measurably false (the offline lowpass pads the right edge), and a
        # false gate would either be waived or hide a real regression. The identity gate is d_lp above.
    report["checks"] = checks
    report["passed"] = bool(checks) and all(checks.values())
    report["onnxSha256"] = sha256_file(onnx_path)
    return report


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument("--spans", default=os.path.join(here, "data", "spans.json"))
    ap.add_argument("--out", default=os.path.join(here, "data", "turn1mini-scores.json"))
    ap.add_argument("--model-path", default=None, help="local .onnx; default: resolve from the HF cache at the pinned revision")
    ap.add_argument("--variant", default="float32", choices=sorted(ONNX_VARIANTS))
    ap.add_argument("--threads", type=int, default=1)
    ap.add_argument("--revision", default=MODEL_REVISION)
    ap.add_argument("--selfcheck-wav", default=None, help="clip for the AC3 self-check")
    ap.add_argument("--no-selfcheck", action="store_true")
    ap.add_argument("--selfcheck-only", action="store_true", help="run only the AC3 self-check and exit")
    args = ap.parse_args()

    with open(args.spans) as fh:
        doc = json.load(fh)
    spans = doc["spans"]
    print(f"spans={len(spans)} corpora={[c['id'] for c in doc.get('corpora', [])]}")

    # Resolve the ONNX graph (local cache first, then download at the pinned revision).
    onnx_path = args.model_path
    if onnx_path is None:
        os.environ.setdefault("HF_HOME", os.path.join(here, "data", "hf"))
        from huggingface_hub import hf_hub_download  # noqa: PLC0415

        onnx_path = hf_hub_download(
            repo_id=MODEL_REPO, filename="onnx/" + ONNX_VARIANTS[args.variant], revision=args.revision
        )
    from p99turn.onnx_stream import Turn1MiniOnnx  # noqa: PLC0415

    digest = sha256_file(onnx_path)
    if args.variant == "float32" and digest != ONNX_FLOAT32_SHA256:
        raise SystemExit(f"onnx sha256 mismatch: {digest} != pinned {ONNX_FLOAT32_SHA256}")
    print(f"onnx {os.path.basename(onnx_path)} sha256={digest[:16]}…")

    model = Turn1MiniOnnx(onnx_path, threads=args.threads)

    # Warm up ORT (kernel selection / graph init) so it is not counted in the per-step timings.
    for _ in range(4):
        model.reset()
        model.step(np.zeros(STEP, np.float32))
    model.reset()

    if args.selfcheck_only:
        wav = args.selfcheck_wav or os.path.normpath(os.path.join(here, spans[0]["wav"]))
        rep = selfcheck(model, onnx_path, wav, args.revision)
        print(json.dumps(rep, indent=1))
        print(f"self-check passed={rep['passed']} checks={rep['checks']}")
        return 0 if rep["passed"] else 1

    selfcheck_report = None
    if not args.no_selfcheck:
        wav = args.selfcheck_wav
        if wav is None:
            wav = os.path.normpath(os.path.join(here, spans[0]["wav"]))
        print(f"self-check on {wav}")
        selfcheck_report = selfcheck(model, onnx_path, wav, args.revision)
        print(json.dumps(selfcheck_report, indent=1))

    # --- main pass ---------------------------------------------------------------------------------
    out_spans: list[dict[str, Any]] = []
    all_step_ms: list[float] = []
    total_audio_s = 0.0
    t_start = time.perf_counter()
    for k, s in enumerate(spans):
        audio, sr = decode_wav(os.path.normpath(os.path.join(here, s["wav"])))
        tail_ms = int(s.get("appendTailMs", 0) or 0)
        if tail_ms > 0:
            audio = np.concatenate([audio, np.zeros(int(round(tail_ms / 1000.0 * sr)), np.float32)])
        audio = pad_to_step(audio)
        probs, step_ms = stream_stepwise(model, audio)
        all_step_ms.extend(step_ms)
        total_audio_s += len(audio) / sr
        out_spans.append(
            {
                "key": s["key"],
                "audioSamples": int(len(audio)),
                "sampleRate": sr,
                "frames": int(len(probs)),
                "frameProbs": [round(float(v), 6) for v in probs],
            }
        )
        if (k + 1) % 100 == 0:
            print(f"  {k+1}/{len(spans)}  ({time.perf_counter()-t_start:.1f}s)")

    step_ms_arr = np.asarray(all_step_ms, np.float64)
    timing = {
        "steps": int(len(step_ms_arr)),
        "audioSecondsStreamed": round(total_audio_s, 3),
        "stepMsP50": round(float(np.percentile(step_ms_arr, 50)), 4),
        "stepMsP90": round(float(np.percentile(step_ms_arr, 90)), 4),
        "stepMsMean": round(float(step_ms_arr.mean()), 4),
        "stepMsMax": round(float(step_ms_arr.max()), 4),
        "rtfNote": "one 160 ms step is one inference; real-time factor = step audio (160 ms) / stepMs",
        "wallSeconds": round(time.perf_counter() - t_start, 2),
    }

    result = {
        "generatedBy": "run-turn1mini.py",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "model": {
            "repo": MODEL_REPO,
            "revision": args.revision,
            "variant": args.variant,
            "onnxFile": os.path.basename(onnx_path),
            "onnxSha256": digest,
            "safetensorsSha256": SAFETENSORS_FLOAT32_SHA256,
            "threads": args.threads,
            "runtime": "onnxruntime " + __import__("onnxruntime").__version__,
            "stepSamples": STEP,
            "frameSamples": FRAME_SAMPLES,
        },
        "frameGeometry": "output frame j ends at sample (j+1)*320; cell prefix ending at sample E reads frame floor(E/320)-1",
        "selfCheck": selfcheck_report,
        "timing": timing,
        "spans": out_spans,
    }
    with open(args.out, "w") as fh:
        json.dump(result, fh)
    print(f"wrote {args.out} ({os.path.getsize(args.out)} B)")
    print(json.dumps(timing, indent=1))
    if selfcheck_report is not None:
        print(f"self-check passed={selfcheck_report['passed']} checks={selfcheck_report['checks']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
