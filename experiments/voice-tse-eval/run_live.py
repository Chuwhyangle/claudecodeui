#!/usr/bin/env python3
"""Session-local (live) TSE check: the target speaks alone first, then an interferer joins.

This is the realistic Live Voice condition for VoxLock: it locks onto the first
~3 s of the caller, then isolates. A pre-enrolled cross-session voiceprint is
tested separately in run_eval.py and is NOT the same condition.
"""
from __future__ import annotations
import csv, os, statistics, time
import numpy as np, soundfile as sf
import voxlock
from scipy.signal import correlate

SR = 16000
AUD = "/tmp/speaker-gate-audition-2026-10-20"
TARGETS = [
    ("test-03_clean_36ec3cc9", "02-test-utterance/test-03_clean_36ec3cc9.wav"),
    ("test-04_4e06e56c", "02-test-utterance/test-04_4e06e56c.wav"),
    ("test-05_long_6576828c", "02-test-utterance/test-05_long_6576828c.wav"),
    ("test-06_long_9f7298ad", "02-test-utterance/test-06_long_9f7298ad.wav"),
    ("edge-01_quiet_a21eccb6", "02-test-utterance/edge-01_quiet_a21eccb6.wav"),
    ("edge-03_quiet_long_ef31fecb", "02-test-utterance/edge-03_quiet_long_ef31fecb.wav"),
]
INTER = "05-nontarget-eotbench/en__1118_47__user_turn_005.wav"


def read(p):
    x, sr = sf.read(p, dtype="float32")
    return x.mean(1) if x.ndim > 1 else x


def frames(x):
    n = len(x) // 320 * 320
    f = x[:n].reshape(-1, 320)
    return np.sqrt((f * f).mean(1) + 1e-12)


def speech_mask(x):
    r = frames(x)
    return r > max(0.005, float(np.percentile(r, 90)) * 0.1)


def scale(t, i, snr_db):
    n = min(len(t), len(i))
    m = np.repeat(speech_mask(t[:n]), 320)[:n]
    rt = float(np.sqrt((t[:n][m] ** 2).mean()))
    ri = float(np.sqrt((i[:n][m] ** 2).mean()))
    return rt / ri * 10 ** (-snr_db / 20)


def fit(x, p=0.7):
    m = float(np.abs(x).max())
    return x * (p / m) if m > p else x


def align(e, r, max_lag=4000):
    c = correlate(e, r, mode="full")
    lag = int(np.argmax(np.abs(c)) - (len(r) - 1))
    lag = int(np.clip(lag, -max_lag, max_lag))
    if lag > 0:
        e = e[lag:]
    elif lag < 0:
        r = r[-lag:]
    n = min(len(e), len(r))
    return e[:n], r[:n]


def si(e, r):
    e, r = align(e, r)
    e = e - e.mean(); r = r - r.mean()
    a = float(np.dot(e, r) / (np.dot(r, r) + 1e-12))
    return float(10 * np.log10((np.dot(a * r, a * r) + 1e-12) / (np.dot(e - a * r, e - a * r) + 1e-12) + 1e-12))


def main():
    out = os.path.join(os.path.dirname(__file__), "out")
    os.makedirs(out, exist_ok=True)
    i0 = read(os.path.join(AUD, INTER))
    vl = voxlock.VoxLock()
    rows = []
    for key, rel in TARGETS:
        t = read(os.path.join(AUD, rel))
        # Extend short clips to 12 s by tiling the same speaker's audio, so the
        # post-lead overlap region is long enough to measure.
        if len(t) < 12 * SR:
            t = np.tile(t, int(np.ceil(12 * SR / len(t))))[: 12 * SR]
        i = np.tile(i0, int(np.ceil(len(t) / len(i0))))[:len(t)]
        g = scale(t, i, 0)
        for lead_s in (4.0,):
            lead = int(lead_s * SR)
            seq = t.copy()
            seq[lead:] = t[lead:] + g * i[lead:]
            seq = fit(seq)
            sample = voxlock.loud_sample(t)
            mix_si = si(seq[lead:], t[lead:])
            runs = {}

            t0 = time.time()
            st = vl.live()
            chunks = [st.push(seq[k:k + 640]) for k in range(0, len(seq), 640)]
            chunks.append(st.flush())
            live = np.concatenate(chunks)
            runs["vox_live"] = (live, time.time() - t0, getattr(st, "locked", None))

            t0 = time.time()
            stream = vl.stream(sample)
            chunks = [stream.push(seq[k:k + 640]) for k in range(0, len(seq), 640)]
            chunks.append(stream.flush())
            runs["vox_stream"] = (np.concatenate(chunks), time.time() - t0, None)

            t0 = time.time()
            iso = vl.isolate(seq, sample=sample)
            runs["vox_isolate"] = (iso, time.time() - t0, None)

            for method, (o, dt, locked) in runs.items():
                # compare the overlap region, 0.5 s after the join
                a = lead + int(0.5 * SR); b = min(len(o), len(seq))
                s = si(o[a:b], t[a:b])
                row = dict(target=key, lead_s=lead_s, method=method,
                           mix_si_sdr=round(mix_si, 3), si_sdr=round(s, 3),
                           si_sdr_improvement=round(s - mix_si, 3),
                           rtf=round(dt / (len(seq) / SR), 3), locked=locked,
                           duration_s=round(len(t) / SR, 2))
                rows.append(row)
                print(row)
    with open(os.path.join(out, "live_results.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=sorted({k for r in rows for k in r}))
        w.writeheader(); w.writerows(rows)
    print("\nmedians")
    for m in sorted({r["method"] for r in rows}):
        rs = [r for r in rows if r["method"] == m]
        print(m, "SI-SDRi median", round(statistics.median(r["si_sdr_improvement"] for r in rs), 2),
              "RTF", round(statistics.median(r["rtf"] for r in rs), 3))


if __name__ == "__main__":
    main()
