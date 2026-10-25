#!/usr/bin/env python3
"""Score the confirmed target files and a large local negative pool against the
5-clip enrollment centroid. Used to pick TRACK/MATCH_FAST with a real FAR estimate.

Negative pool:
  - 400 EOT-Bench English turns (local, CC-BY-4.0, ignored by git)
  - 16 LibriSpeech clips
  - 46 TTS clips from the repo fixtures
The target files are the 15 confirmed 02/03 clips (the 5 enrollment clips define
the centroid and are excluded).
"""
from __future__ import annotations
import csv, glob, json, os, statistics, time
import numpy as np, soundfile as sf, sherpa_onnx

HERE = os.path.dirname(__file__)
AUD = "/tmp/speaker-gate-audition-2026-10-20"
MODEL = "/tmp/tse-eval-models/alt/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"
SR = 16000


def read(p):
    x, sr = sf.read(p, dtype="float32")
    return x.mean(1) if x.ndim > 1 else x


class E:
    def __init__(self):
        self.ex = sherpa_onnx.SpeakerEmbeddingExtractor(
            sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=MODEL, num_threads=4)
        )

    def __call__(self, x):
        s = self.ex.create_stream(); s.accept_waveform(SR, x.astype(np.float32))
        if not self.ex.is_ready(s): return None
        v = np.asarray(self.ex.compute(s), dtype=np.float32)
        return v / (np.linalg.norm(v) + 1e-12)


def pct(scores, p):
    return scores[min(len(scores) - 1, int(round(p / 100 * (len(scores) - 1))))]


def main():
    e = E()
    enroll = [read(f) for f in sorted(glob.glob(os.path.join(AUD, "01-enroll/*.wav")))]
    core = np.mean([e(x) for x in enroll], axis=0); core /= np.linalg.norm(core) + 1e-12
    rows = list(csv.DictReader(open(os.path.join(HERE, "labels.csv"))))
    test = [r for r in rows if r["label"] == "target" and r["category"] != "01-enroll"]
    t_scores = sorted(float(np.dot(core, e(read(r["file"])))) for r in test)
    t_long = sorted(float(np.dot(core, e(read(r["file"])))) for r in test if float(r["duration_s"]) >= 2.0)
    pools = {
        "eot-bench-400": glob.glob("experiments/voice-turn-detection-compare/worst-cases-replay/data/eot-bench-audio/*.wav"),
        "librispeech-16": glob.glob("experiments/voice-turn-detection-compare/worst-cases-replay/data/corpus-a/*.wav"),
        "tts-46": (glob.glob("experiments/voice-trim/fixtures/*.wav")
                   + glob.glob("experiments/voice-provider-paired-quality/fixtures/*.wav")
                   + glob.glob("experiments/voice-realtime-ambiguity/fixtures/audio/*.wav")),
        # Newly confirmed non-targets that are NOT already in the pools above.
        "confirmed-new-nontarget": [r["file"] for r in rows
                                    if r["label"] == "nontarget"
                                    and r["category"] in ("03-low-confidence", "04-session-segment-nontarget")],
    }
    out = {"target": {"n": len(t_scores), "min": round(t_scores[0], 4),
                      "median": round(statistics.median(t_scores), 4),
                      "max": round(t_scores[-1], 4)},
           "target_ge_2s": {"n": len(t_long), "min": round(t_long[0], 4),
                            "median": round(statistics.median(t_long), 4),
                            "max": round(t_long[-1], 4)},
           "pools": {}}
    thresholds = [0.25, 0.28, 0.30, 0.32, 0.35, 0.40, 0.45]
    print(f"target n={len(t_scores)} min={t_scores[0]:.3f} median={statistics.median(t_scores):.3f} max={t_scores[-1]:.3f}")
    all_neg = []
    for name, files in pools.items():
        t0 = time.time(); scores = []
        for f in files:
            try: x = read(f)
            except Exception: continue
            v = e(x)
            if v is not None: scores.append(float(np.dot(core, v)))
        scores.sort(); all_neg += scores
        row = {"n": len(scores), "secs": round(time.time() - t0, 1),
               "p50": round(pct(scores, 50), 4), "p90": round(pct(scores, 90), 4),
               "p95": round(pct(scores, 95), 4), "p99": round(pct(scores, 99), 4),
               "max": round(scores[-1], 4),
               "counts": {str(t): sum(1 for s in scores if s >= t) for t in thresholds}}
        out["pools"][name] = row
        print(f"\n{name}: n={row['n']} p50={row['p50']} p90={row['p90']} p95={row['p95']} p99={row['p99']} max={row['max']}")
        print("  " + " ".join(f">={t}:{row['counts'][str(t)]}" for t in thresholds))
    all_neg.sort()
    out["all_negatives"] = {"n": len(all_neg), **{f"p{p}": round(pct(all_neg, p), 4) for p in [50, 90, 95, 99, 99.5, 99.9]},
                            "max": round(all_neg[-1], 4),
                            "counts": {str(t): sum(1 for s in all_neg if s >= t) for t in thresholds}}
    print(f"\nall negatives n={len(all_neg)} max={all_neg[-1]:.3f}")
    print("  " + " ".join(f">={t}:{out['all_negatives']['counts'][str(t)]}" for t in thresholds))
    path = os.path.join(HERE, "out", "negative_calibration.json")
    with open(path, "w") as f: json.dump(out, f, indent=2)
    print("wrote", path)


if __name__ == "__main__":
    main()
