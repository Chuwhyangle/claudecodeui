#!/usr/bin/env python3
"""VoxLock on the user-confirmed labels: session-local first turn vs cross-day vs auto.

The target turns are real Live Voice turns (the same user), mixed with a confirmed
non-target clip at 0 dB. The session-local sample is the first turn of that session
(padded to 3 s); the cross-day sample is a confirmed 2026-10-07 enrollment clip.
"""
from __future__ import annotations
import csv, glob, json, math, os, statistics, time
import numpy as np, soundfile as sf
from scipy.signal import correlate
import onnxruntime as ort
ort.set_default_logger_severity(3)
import voxlock

SR = 16000
HERE = os.path.dirname(__file__)
AUD = "/tmp/speaker-gate-audition-2026-10-20"
RC = os.path.expanduser("~/.cloudcli/voice-realtime-capture")


def read(p):
    x, sr = sf.read(p, dtype="float32")
    return x.mean(1) if x.ndim > 1 else x


def loud_sample(x, sec=3.0):
    return voxlock.loud_sample(np.asarray(x, np.float32), sec=sec)


def pad3(x):
    n = int(3 * SR)
    return x[:n] if len(x) >= n else np.pad(x, (0, n - len(x)))


def speech_mask(x):
    n = len(x) // 320 * 320
    f = x[:n].reshape(-1, 320); r = np.sqrt((f * f).mean(1) + 1e-12)
    return r > max(0.005, float(np.percentile(r, 90)) * 0.1)


def mix_at(t, i, snr=0.0):
    if len(i) < len(t): i = np.tile(i, int(np.ceil(len(t) / len(i))))
    i = i[:len(t)]
    n = min(len(t), len(i)) // 320 * 320
    m = np.repeat(speech_mask(t[:n]), 320)[:n]
    rt = float(np.sqrt((t[:n][m] ** 2).mean())); ri = float(np.sqrt((i[:n][m] ** 2).mean()))
    g = rt / (ri + 1e-9) * 10 ** (-snr / 20)
    y = t + g * i
    peak = float(np.abs(y).max())
    return (y * (0.7 / peak)).astype(np.float32) if peak > 0.7 else y.astype(np.float32)


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


def sessions():
    out = []
    for tl in glob.glob(os.path.join(RC, "*.timeline.jsonl")):
        wav = tl.replace(".timeline.jsonl", ".wav")
        if not os.path.exists(wav): continue
        x, _ = sf.read(wav, dtype="float32"); segs = []; cur = None
        for line in open(tl):
            try: ev = json.loads(line)
            except: continue
            if ev.get("kind") == "speech_started": cur = ev.get("offsetMs")
            if ev.get("kind") == "speech_stopped" and cur is not None:
                segs.append((cur, ev.get("offsetMs"))); cur = None
        turns = []
        for a, b in segs:
            if b - a < 2000: continue
            s = max(0, int((a - 100) / 1000 * SR)); e = min(len(x), int((b + 100) / 1000 * SR))
            turns.append(x[s:e])
        if len(turns) >= 2:
            out.append((os.path.basename(wav)[:8], turns))
    return sorted(out)


def main():
    rows = list(csv.DictReader(open(os.path.join(HERE, "labels.csv"))))
    inter = [read(r["file"]) for r in rows if r["category"] == "05-nontarget-eotbench"]
    cross = pad3(loud_sample(read(os.path.join(AUD, "01-enroll/enroll-04_77f36308.wav"))))
    vl = voxlock.VoxLock()
    out = []
    for key, turns in sessions():
        sample = pad3(loud_sample(turns[0]))
        for tidx, t in enumerate(turns[1:], start=2):
            i = inter[(tidx + len(key)) % len(inter)]
            mix = mix_at(t, i, 0.0)
            base = si(mix, t)
            for name, smp in [("session", sample), ("cross", cross), ("auto", None)]:
                t0 = time.time()
                try:
                    y = vl.isolate(mix, sample=smp)
                except Exception as ex:
                    print(f"  {key} t{tidx} {name} FAILED {type(ex).__name__}")
                    continue
                rtf = (time.time() - t0) / (len(mix) / SR)
                s = si(y, t)
                out.append(dict(session=key, turn=tidx, method=name,
                                mix_si=round(base, 2), si=round(s, 2),
                                si_sdr_i=round(s - base, 2), rtf=round(rtf, 2),
                                duration=round(len(t) / SR, 2)))
                print(f"  {key} t{tidx:02d} {name:7s} SI-SDRi {s-base:+6.2f} RTF {rtf:.2f}")
    path = os.path.join(HERE, "out", "voxlock_confirmed.csv")
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=sorted({k for r in out for k in r}))
        w.writeheader(); w.writerows(out)
    print("\nmedians")
    for m in ("session", "cross", "auto"):
        rs = [r for r in out if r["method"] == m]
        if rs:
            vals = [r["si_sdr_i"] for r in rs]
            print(f"  {m:7s} n={len(rs):2d} median={statistics.median(vals):+.2f} "
                  f"mean={statistics.mean(vals):+.2f} min={min(vals):+.2f} max={max(vals):+.2f} "
                  f"positive={sum(1 for v in vals if v > 0)}/{len(vals)}")
    print("wrote", path)


if __name__ == "__main__":
    main()
