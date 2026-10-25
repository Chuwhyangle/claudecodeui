#!/usr/bin/env python3
"""Pilot: Vanta (from-scratch TSE, 16 kHz) on the selected samples.

Vanta's own README reports +9.28 dB median SI-SDR on unseen English speakers.
This script checks whether that transfers to the Chinese target samples used by
the other TSE runs. It is a pilot, not a full matrix: 3 enrollment modes on two
Chinese targets at 0 dB, plus one English in-domain control.
"""
from __future__ import annotations
import csv, io, os, sys, time
import numpy as np, soundfile as sf
from scipy.signal import correlate

SR = 16000
AUD = "/tmp/speaker-gate-audition-2026-10-20"
VANTA_REPO = "/tmp/Vanta"


def read(p):
    x, sr = sf.read(p, dtype="float32")
    return x.mean(1) if x.ndim > 1 else x


def frames(x):
    n = len(x) // 320 * 320
    f = x[:n].reshape(-1, 320)
    return np.sqrt((f * f).mean(1) + 1e-12)


def sm(x):
    r = frames(x)
    return r > max(0.005, float(np.percentile(r, 90)) * 0.1)


def scale(t, i, snr):
    n = min(len(t), len(i)) // 320 * 320
    m = np.repeat(sm(t[:n]), 320)[:n]
    rt = np.sqrt((t[:n][m] ** 2).mean())
    ri = np.sqrt((i[:n][m] ** 2).mean())
    return rt / ri * 10 ** (-snr / 20)


def fit(x, p=0.7):
    m = float(np.abs(x).max())
    return x * (p / m) if m > p else x


def align(e, r):
    c = correlate(e, r, mode="full")
    lag = int(np.argmax(np.abs(c)) - (len(r) - 1))
    lag = int(np.clip(lag, -4000, 4000))
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


def wb(x):
    b = io.BytesIO()
    sf.write(b, x, SR, format="WAV", subtype="PCM_16")
    return b.getvalue()


def main():
    sys.path.insert(0, VANTA_REPO)
    from vanta.inference import VantaInference

    inf = VantaInference(
        os.path.join(VANTA_REPO, "checkpoints/fully_ours/best.pt"),
        repeats=3, device="cpu",
        speaker_encoder_ckpt=os.path.join(VANTA_REPO, "checkpoints/spk_encoder/best.pt"),
    )
    enrollments = {
        "same_day": os.path.join(AUD, "01-enroll/enroll-01_363d1ca4.wav"),
        "cross_day": os.path.join(AUD, "01-enroll/enroll-04_77f36308.wav"),
    }
    cases = [
        ("zh_test-03", "02-test-utterance/test-03_clean_36ec3cc9.wav",
         "05-nontarget-eotbench/en__994_43__user_turn_002.wav"),
        ("zh_test-04", "02-test-utterance/test-04_4e06e56c.wav",
         "05-nontarget-eotbench/en__1118_47__user_turn_005.wav"),
        ("en_librispeech-004", "04-nontarget-librispeech/librispeech-004.wav",
         "05-nontarget-eotbench/en__954_24__user_turn_004.wav"),
    ]
    rows = []
    for key, trel, irel in cases:
        t = read(os.path.join(AUD, trel))
        i = read(os.path.join(AUD, irel))
        i = np.tile(i, int(np.ceil(len(t) / len(i))))[:len(t)]
        mix = fit(t + scale(t, i, 0) * i)
        mix_si = si(mix, t)
        modes = {"oracle": t, **{k: read(p) for k, p in enrollments.items()}}
        if key.startswith("en_"):
            modes["other_en"] = read(os.path.join(AUD, "04-nontarget-librispeech/librispeech-000.wav"))
        for mode, enr in modes.items():
            t0 = time.time()
            est, _, _ = inf.extract(wb(mix), wb(enr))
            o, _ = sf.read(io.BytesIO(est), dtype="float32")
            dt = time.time() - t0
            s = si(o, t)
            row = dict(case=key, enrollment=mode, mix_si_sdr=round(mix_si, 3),
                       si_sdr=round(s, 3), si_sdr_improvement=round(s - mix_si, 3),
                       rtf=round(dt / (len(mix) / SR), 3), duration_s=round(len(t) / SR, 2))
            rows.append(row)
            print(row)
    out = os.path.join(os.path.dirname(__file__), "out", "vanta_pilot.csv")
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=sorted({k for r in rows for k in r}))
        w.writeheader(); w.writerows(rows)
    print("wrote", out)


if __name__ == "__main__":
    main()
