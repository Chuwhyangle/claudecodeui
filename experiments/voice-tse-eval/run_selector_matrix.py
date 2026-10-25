#!/usr/bin/env python3
"""Selector matrix: 3 targets × 3 bystanders × {bystander_first, target_first}.

For each sequence, compare VoxLock.live() (energy auto-lock) with a 3 s window
chosen by the confirmed core (CAM++ zh_en advanced). Metric region: the last 8 s.
"""
from __future__ import annotations
import csv, glob, json, math, os
import numpy as np, soundfile as sf
import onnxruntime as ort
ort.set_default_logger_severity(3)
import sherpa_onnx, voxlock
from scipy.signal import correlate

SR = 16000
HERE = os.path.dirname(__file__)
AUD = "/tmp/speaker-gate-audition-2026-10-20"
MODEL = "/tmp/tse-eval-models/alt/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"
MATCH_FAST = 0.35
SPEECH_MIN = 0.60
TARGETS = ["02-test-utterance/test-05_long_6576828c.wav",
           "02-test-utterance/test-06_long_9f7298ad.wav"]
BYSTANDERS = ["05-nontarget-eotbench/en__713_62__user_turn_003.wav",
              "05-nontarget-eotbench/en__224_147__user_turn_006.wav"]


def read(p):
    x, sr = sf.read(p, dtype="float32")
    return x.mean(1) if x.ndim > 1 else x


class E:
    def __init__(self):
        self.ex = sherpa_onnx.SpeakerEmbeddingExtractor(
            sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=MODEL, num_threads=2))
    def __call__(self, x):
        s = self.ex.create_stream(); s.accept_waveform(SR, x.astype(np.float32))
        if not self.ex.is_ready(s): return None
        v = np.asarray(self.ex.compute(s), dtype=np.float32)
        return v / (np.linalg.norm(v) + 1e-12)


def speech_ratio(x):
    n = len(x) // 320 * 320
    r = np.sqrt((x[:n].reshape(-1, 320) ** 2).mean(1) + 1e-12)
    return float((r > max(0.005, float(np.percentile(r, 90)) * 0.1)).mean())


def scale_for_snr(t, i, snr=0.0):
    n = min(len(t), len(i)) // 320 * 320
    r = np.sqrt((t[:n].reshape(-1, 320) ** 2).mean(1) + 1e-12)
    m = np.repeat(r > max(0.005, float(np.percentile(r, 90)) * 0.1), 320)[:n]
    rt = float(np.sqrt((t[:n][m] ** 2).mean())); ri = float(np.sqrt((i[:n][m] ** 2).mean()))
    return rt / (ri + 1e-9) * 10 ** (-snr / 20)


def fit(x, peak=0.9):
    m = float(np.abs(x).max())
    return x * (peak / m) if m > peak else x


def align(e, r, maxlag=8000):
    c = correlate(e, r, mode="full"); lag = int(np.argmax(np.abs(c)) - (len(r) - 1))
    lag = int(np.clip(lag, -maxlag, maxlag))
    if lag > 0: e = e[lag:]
    elif lag < 0: r = r[-lag:]
    n = min(len(e), len(r)); return e[:n], r[:n]


def si(e, r):
    e, r = align(e, r); e = e - e.mean(); r = r - r.mean()
    a = float(np.dot(e, r) / (np.dot(r, r) + 1e-12))
    return float(10 * math.log10((np.dot(a * r, a * r) + 1e-12) / (np.dot(e - a * r, e - a * r) + 1e-12) + 1e-12))


def build(first, target, bystander):
    g = scale_for_snr(target, bystander, 0.0)
    return fit(np.concatenate([first[:4 * SR], target[:4 * SR], target[4:12 * SR] + g * bystander[4:12 * SR]]))


def select(e, core, seq):
    for start in np.arange(0, 10, 0.5):
        a = int(start * SR); w = seq[a:a + 2 * SR]
        if len(w) < 2 * SR: break
        v = e(w)
        if v is not None and float(np.dot(core, v)) >= MATCH_FAST and speech_ratio(w) >= SPEECH_MIN:
            a3 = int(start * SR); w3 = seq[a3:a3 + 3 * SR]
            if len(w3) == 3 * SR: return w3, float(start)
    return None, None


def main():
    e = E()
    enroll = [read(f) for f in sorted(glob.glob(os.path.join(AUD, "01-enroll/*.wav")))]
    core = np.mean([e(x) for x in enroll], axis=0); core /= np.linalg.norm(core) + 1e-12
    vl = voxlock.VoxLock(threads=4)
    rows = []
    for trel in TARGETS:
        t = read(os.path.join(AUD, trel))
        for brel in BYSTANDERS:
            b = read(os.path.join(AUD, brel))
            b = np.tile(b, int(np.ceil(16 * SR / len(b))))[:16 * SR]
            for kind, first in [("bystander_first", b), ("target_first", t)]:
                seq = build(first, t, b)
                sample, at = select(e, core, seq)
                if sample is None:
                    print("no selection", trel, brel, kind); continue
                live_st = vl.live()
                outs = [live_st.push(seq[k:k + 640]) for k in range(0, len(seq), 640)]
                outs.append(live_st.flush()); live = np.concatenate(outs)
                st = vl.stream(sample)
                outs = [st.push(seq[k:k + 640]) for k in range(0, len(seq), 640)]
                outs.append(st.flush()); chosen = np.concatenate(outs)
                a0 = 8 * SR; n = min(len(live) - a0, len(chosen) - a0, len(t) - 4 * SR, len(b) - 4 * SR)
                tt = t[4:4 + n]; bb = b[4:4 + n]
                for method, o in [("live", live), ("core", chosen)]:
                    oo = o[a0:a0 + n]
                    rows.append(dict(target=os.path.basename(trel), bystander=os.path.basename(brel),
                                     sequence=kind, method=method, selected_at_s=at,
                                     si_target=round(si(oo, tt), 2), si_bystander=round(si(oo, bb), 2),
                                     cos_target=round(float(np.dot(core, e(oo))), 3),
                                     cos_bystander=round(float(np.dot(e(bb), e(oo))), 3)))
                    print(f"{os.path.basename(trel)[:12]:12s} + {os.path.basename(brel)[:12]:12s} {kind:15s} {method:5s} "
                          f"SI_T {rows[-1]['si_target']:+6.2f} SI_B {rows[-1]['si_bystander']:+6.2f} "
                          f"cosT {rows[-1]['cos_target']:.3f} cosB {rows[-1]['cos_bystander']:.3f} at {at}s")
    path = os.path.join(HERE, "out", "selector_matrix.csv")
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=sorted({k for r in rows for k in r}))
        w.writeheader(); w.writerows(rows)
    print("\nmedians by sequence/method")
    for kind in ("bystander_first", "target_first"):
        for method in ("live", "core"):
            rs = [r for r in rows if r["sequence"] == kind and r["method"] == method]
            if rs:
                print(f"  {kind:15s} {method:5s} n={len(rs)} SI_T median {sorted(r['si_target'] for r in rs)[len(rs)//2]:+.2f} "
                      f"SI_B median {sorted(r['si_bystander'] for r in rs)[len(rs)//2]:+.2f}")
    print("wrote", path)


if __name__ == "__main__":
    main()
