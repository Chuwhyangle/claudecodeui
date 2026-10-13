#!/usr/bin/env python3
"""FunASR FSMN-VAD (ONNX) -> per-20 ms-frame speech decision, from the model's own scores.

Real weights: the ModelScope `damo/speech_fsmn_vad_zh-cn-16k-common-onnx` quantized ONNX,
run by `funasr-onnx`'s own front end (kaldi fbank + CMVN) and FSMN encoder. Nothing here is
simulated.

How the per-frame reading is produced. `funasr_onnx`'s `E2EVadModel` already computes, for
every 10 ms frame, a speech posterior `score` in (0, 1) and decides that frame with

    exp(speech_prob) >= exp(noise_prob) + speech_noise_thres      # speech_prob = log(score)
    <=>  2 * score - 1 >= speech_noise_thres

(`utils/e2e_vad.py:484`). This adapter records those scores and re-applies that same rule at
each requested level, so the rows of the tradeoff table are thresholds on ONE real score
distribution and inference runs once. The engine's own segment list (which carries its
min-duration hysteresis) is reported alongside as `ruleVsEngine` and `engineSegments`, but
the table rows use the pure score rule, so FSMN is read like the other engines.

10 ms -> 20 ms: shared frame k is speech when either of its two 10 ms sub-frames is.

Same grid contract as `silero.py` -- see that file's docstring for the shared IO shape.

Usage:
  python engines/fsmn.py --wav in.wav --out out.json [--levels 0.3,0.45,0.6,0.75,0.9]

Env:  FSMN_MODEL_DIR  funasr-onnx model dir (config.yaml + am.mvn + model_quant.onnx)
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

DEFAULT_MODEL_DIR = os.environ.get(
    "FSMN_MODEL_DIR", "/data/home/yale/work/voice-vad-engines/fsmn-vad-ms"
)
SOURCE_URL = "https://www.modelscope.cn/models/damo/speech_fsmn_vad_zh-cn-16k-common-onnx"
DEFAULT_LEVELS = "0.3,0.45,0.6,0.75,0.9"
SR = 16_000
HOP = 320  # 20 ms shared grid
FSMN_FRAME_MS = 10  # the engine's own frame shift


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
    ap.add_argument("--model-dir", default=DEFAULT_MODEL_DIR)
    ap.add_argument("--levels", default=DEFAULT_LEVELS)
    args = ap.parse_args()

    samples = read_wav(args.wav)
    n_shared = len(samples) // HOP

    # Patch the scorer class the engine constructs, so this adapter can read the per-frame
    # scores `E2EVadModel` computes anyway. `funasr_onnx.vad_bin` builds a fresh scorer per
    # `__call__` and clears its buffer on every `ResetDetection`, so both hooks snapshot.
    import funasr_onnx.vad_bin as vad_bin

    made = []
    original = vad_bin.E2EVadModel

    class Recording(original):
        def __init__(self, config):
            self.scores_all = []
            config = dict(config)
            config["output_frame_probs"] = True
            super().__init__(config)
            made.append(self)

        def ResetDetection(self):
            self.scores_all.extend(self.frame_probs)
            super().ResetDetection()

        def AllResetDetection(self):
            self.scores_all.extend(self.frame_probs)
            super().AllResetDetection()

    vad_bin.E2EVadModel = Recording

    model = vad_bin.Fsmn_vad(args.model_dir, quantize=True)
    wall0, cpu0 = time.perf_counter(), time.process_time()
    segments = model(args.wav)[0]
    wall = time.perf_counter() - wall0
    cpu = time.process_time() - cpu0
    rss_kb = int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)

    scorer = made[-1]
    # Later chunks can re-score a frame near a boundary; first reading wins so the map holds
    # one value per 10 ms frame, globally indexed.
    frame10 = {}
    for prob in scorer.scores_all:
        frame10.setdefault(prob.frame_id, prob.score)
    if not frame10:
        raise SystemExit("fsmn: no frame scores captured")
    keys = sorted(frame10)
    scores10 = np.asarray([frame10[k] for k in keys], dtype=np.float64)
    contiguous = keys == list(range(keys[0], keys[-1] + 1))

    def to_shared(decided_by_id):
        bits = []
        for k in range(n_shared):
            hit = decided_by_id.get(2 * k, False) or decided_by_id.get(2 * k + 1, False)
            bits.append("1" if hit else "0")
        return "".join(bits)

    levels = [float(v) for v in args.levels.split(",") if v.strip()]
    levels_out = {}
    for level in levels:
        decided = (2.0 * scores10 - 1.0) >= level
        levels_out[f"{level:g}"] = to_shared(
            {key: bool(flag) for key, flag in zip(keys, decided)}
        )

    # Cross-check at the engine's own configured threshold: the segment list its state machine
    # emits (with min-duration hysteresis) vs. the pure score rule at the same threshold.
    configured = float(scorer.vad_opts.speech_noise_thres)
    engine_frames = np.zeros(len(keys), dtype=bool)
    for start_ms, end_ms in segments:
        lo = max(0, (int(start_ms) + FSMN_FRAME_MS - 1) // FSMN_FRAME_MS - keys[0])
        hi = min(len(keys), (int(end_ms) + FSMN_FRAME_MS - 1) // FSMN_FRAME_MS - keys[0])
        engine_frames[lo:hi] = True
    rule_frames = (2.0 * scores10 - 1.0) >= configured
    rule_vs_engine = {
        "threshold": configured,
        "ruleSpeechFrac": float(rule_frames.mean()),
        "engineSegmentFrac": float(engine_frames.mean()),
        "agreement": float((rule_frames == engine_frames).mean()),
        "note": (
            "agreement < 1 is the engine's own hysteresis; the table rows use the pure score "
            "rule so FSMN is read like the other engines."
        ),
    }

    duration = n_shared * (HOP / SR)
    weights = []
    for name in ("config.yaml", "am.mvn", "model_quant.onnx"):
        path = os.path.join(args.model_dir, name)
        if os.path.exists(path):
            weights.append(
                {
                    "path": os.path.abspath(path),
                    "sha256_16": hashlib.sha256(open(path, "rb").read()).hexdigest()[:16],
                    "bytes": os.path.getsize(path),
                    "sourceUrl": SOURCE_URL,
                }
            )

    result = {
        "engine": "fsmn",
        "label": "FunASR FSMN-VAD (ONNX, zh-cn 16k, quantized)",
        "wav": os.path.abspath(args.wav),
        "sampleRate": SR,
        "hopSamples": HOP,
        "frameCount": n_shared,
        "durationSec": duration,
        "levels": levels_out,
        "levelKind": "probability-threshold",
        "scoreFrames10ms": len(keys),
        "scoreFramesContiguous": contiguous,
        "ruleVsEngine": rule_vs_engine,
        "engineSegments": [[int(a), int(b)] for a, b in segments],
        "cost": {"wallSec": wall, "cpuSec": cpu, "rssPeakKb": rss_kb, "rtf": wall / duration},
        "weights": weights,
        "notes": (
            "One inference; every level re-applies the engine's own decision rule "
            "(2*score-1 >= speech_noise_thres) to the recorded per-frame scores. The native "
            f"segment list is the engine's configured threshold ({configured:g}) and is NOT what "
            "the table rows use."
        ),
    }
    with open(args.out, "w") as handle:
        json.dump(result, handle)
    print(
        f"fsmn: frames={n_shared} dur={duration:.2f}s rtf={wall / duration:.4f} "
        f"cpu={cpu:.2f}s rss={rss_kb}KB segs={len(segments)} "
        f"agree={rule_vs_engine['agreement']:.4f} "
        + " ".join(f"{k}:{v.count('1') / n_shared:.3f}" for k, v in levels_out.items())
    )


if __name__ == "__main__":
    main()
