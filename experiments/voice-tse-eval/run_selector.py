#!/usr/bin/env python3
"""Does the confirmed core select the right 3 s window when a bystander speaks first?

Sequence A (bystander_first): 4 s bystander, 4 s target, 8 s overlap at 0 dB.
Sequence B (target_first)   : 4 s target, 4 s target, 8 s overlap at 0 dB.

Compared:
  mix                unprocessed
  live               VoxLock.live() — the loudness/energy auto-lock
  core_selected      first 3 s window with core cosine >= MATCH_FAST and speech >= 0.6
  first3_bystander   VoxLock.stream(bystander first 3 s) — what live() effectively locks to
"""
from __future__ import annotations
import glob, json, math, os
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
    mt = np.sqrt((t[:n].reshape(-1, 320) ** 2).mean(1) + 1e-12) > max(0.005, float(np.percentile(np.sqrt((t[:n].reshape(-1, 320) ** 2).mean(1) + 1e-12), 90)) * 0.1)
    m = np.repeat(mt, 320)[:n]
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


def run_case(e, core, name, first, target, bystander):
    g = scale_for_snr(target, bystander, 0.0)
    seq = fit(np.concatenate([first[:4 * SR], target[:4 * SR], target[4:12 * SR] + g * bystander[4:12 * SR]]))
    rows = []
    for start in np.arange(0, 10, 0.5):
        a = int(start * SR); w = seq[a:a + 2 * SR]
        if len(w) < 2 * SR: break
        rows.append((float(start), float(np.dot(core, e(w))), speech_ratio(w)))
    sel = None; sel_at = None
    for start, score, sp in rows:
        if score >= MATCH_FAST and sp >= SPEECH_MIN:
            a = int(start * SR); w = seq[a:a + 3 * SR]
            if len(w) == 3 * SR:
                sel = w; sel_at = start; break
    vl = voxlock.VoxLock()
    def stream(sample):
        st = vl.stream(sample)
        outs = [st.push(seq[k:k + 640]) for k in range(0, len(seq), 640)]
        outs.append(st.flush())
        return np.concatenate(outs)
    live_st = vl.live()
    outs = [live_st.push(seq[k:k + 640]) for k in range(0, len(seq), 640)]
    outs.append(live_st.flush()); live = np.concatenate(outs)
    chosen = stream(sel) if sel is not None else None
    first3 = stream(first[:3 * SR])
    a0 = 8 * SR
    tt = target[4:12 * SR]; bb = bystander[4:12 * SR]
    out = {"case": name, "selected_at_s": sel_at,
           "window_scores": [{"t": t, "score": round(s, 3), "speech": round(sp, 2)} for t, s, sp in rows],
           "readings": {}}
    for label, o in [("mix", seq), ("live", live), ("core_selected", chosen), ("first3_bystander", first3)]:
        if o is None: continue
        n = min(len(o) - a0, len(tt))
        oo = o[a0:a0 + n]; t2 = tt[:n]; b2 = bb[:n]
        out["readings"][label] = {
            "si_target": round(si(oo, t2), 2), "si_bystander": round(si(oo, b2), 2),
            "cos_target": round(float(np.dot(core, e(oo))), 3),
            "cos_bystander": round(float(np.dot(e(b2), e(oo))), 3),
        }
    print(f"\n## {name}  selected_at={sel_at}s")
    for r in rows: print(f"  t={r[0]:4.1f}s score={r[1]:+.3f} speech={r[2]:.2f}")
    for k, v in out["readings"].items(): print(f"  {k:18s} {v}")
    return out


def main():
    e = E()
    enroll = [read(f) for f in sorted(glob.glob(os.path.join(AUD, "01-enroll/*.wav")))]
    core = np.mean([e(x) for x in enroll], axis=0); core /= np.linalg.norm(core) + 1e-12
    target = read(os.path.join(AUD, "02-test-utterance/test-06_long_9f7298ad.wav"))
    bystander = read(os.path.join(AUD, "05-nontarget-eotbench/en__713_62__user_turn_003.wav"))
    bystander = np.tile(bystander, int(np.ceil(16 * SR / len(bystander))))[:16 * SR]
    res = [run_case(e, core, "bystander_first", bystander, target, bystander),
           run_case(e, core, "target_first", target, target, bystander)]
    path = os.path.join(HERE, "out", "selector_results.json")
    with open(path, "w") as f: json.dump(res, f, indent=2)
    print("\nwrote", path)


if __name__ == "__main__":
    main()
