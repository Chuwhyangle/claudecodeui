#!/usr/bin/env python3
"""Confirmed-label experiments (labels from the user's listening pass, 2026-10-21).

1. Score calibration: confirmed target vs non-target against the 5-clip centroid.
2. Bystander-first attractor: a non-target cluster that forms the session attractor,
   then the real user speaks — does the user get rejected?
3. VoxLock on real session turns: session-local first turn vs cross-day clip vs auto.
"""
from __future__ import annotations
import csv, glob, json, math, os, statistics, sys, time
import numpy as np, soundfile as sf
from scipy.signal import correlate
import sherpa_onnx
import voxlock

SR = 16000
HERE = os.path.dirname(__file__)
AUD = "/tmp/speaker-gate-audition-2026-10-20"
RC = os.path.expanduser("~/.cloudcli/voice-realtime-capture")
MODEL = "/tmp/tse-eval-models/alt/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"
CORE_FILES = [f for f in sorted(glob.glob(os.path.join(AUD, "01-enroll/*.wav")))]
MATCH_FAST = 0.35
TRACK = 0.30
CONSISTENCY = 0.60


def read(p):
    x, sr = sf.read(p, dtype="float32")
    if x.ndim > 1:
        x = x.mean(1)
    return x.astype(np.float32)


class Embedder:
    def __init__(self, path=MODEL):
        self.ex = sherpa_onnx.SpeakerEmbeddingExtractor(
            sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=path, num_threads=2)
        )

    def emb(self, x):
        s = self.ex.create_stream()
        s.accept_waveform(SR, x.astype(np.float32))
        if not self.ex.is_ready(s):
            return None
        v = np.asarray(self.ex.compute(s), dtype=np.float32)
        return v / (np.linalg.norm(v) + 1e-12)


def cos(a, b):
    return float(np.dot(a, b))


def labels():
    return list(csv.DictReader(open(os.path.join(HERE, "labels.csv"))))


def score_calibration(e: Embedder, core):
    rows = labels()
    targets = [r for r in rows if r["label"] == "target" and r["category"] != "01-enroll"]
    non = [r for r in rows if r["label"] == "nontarget"]
    t_scores = []; n_scores = []
    for r in targets:
        v = e.emb(read(r["file"]))
        if v is not None: t_scores.append((cos(core, v), r["name"], r["category"]))
    for r in non:
        v = e.emb(read(r["file"]))
        if v is not None: n_scores.append((cos(core, v), r["name"], r["category"]))
    print("\n=== score calibration (centroid of 5 enrollment clips) ===")
    for s, n, c in sorted(t_scores, reverse=True): print(f"  TARGET    {s:+.3f}  {c:28s} {n}")
    for s, n, c in sorted(n_scores, reverse=True): print(f"  NONTARGET {s:+.3f}  {c:28s} {n}")
    print("threshold sweep:")
    sweep = []
    for t in [0.20, 0.25, 0.28, 0.30, 0.32, 0.35, 0.40, 0.45]:
        far = sum(1 for s, _, _ in n_scores if s >= t) / max(len(n_scores), 1)
        frr = sum(1 for s, _, _ in t_scores if s < t) / max(len(t_scores), 1)
        sweep.append(dict(threshold=t, far=round(far, 3), frr=round(frr, 3)))
        print(f"  t={t:.2f} FAR={far:.3f} FRR={frr:.3f}")
    return dict(target=[dict(score=round(s, 4), name=n, category=c) for s, n, c in t_scores],
                nontarget=[dict(score=round(s, 4), name=n, category=c) for s, n, c in n_scores],
                sweep=sweep)


def split_turns(x, turn_s=2.0, hop_s=2.0):
    n = int(turn_s * SR); hop = int(hop_s * SR)
    return [x[i:i + n] for i in range(0, max(1, len(x) - n + 1), hop) if len(x[i:i + n]) >= SR]


def bystander_attractor(e: Embedder, core):
    """A non-target speaker forms the session attractor first; then the user speaks."""
    rows = labels()
    non = [r for r in rows if r["label"] == "nontarget"]
    targets = [r for r in rows if r["label"] == "target" and r["category"] != "01-enroll"]
    target_embs = [(r["name"], e.emb(read(r["file"]))) for r in targets]
    target_embs = [(n, v) for n, v in target_embs if v is not None]
    out = []
    print("\n=== bystander-first attractor ===")
    for r in non:
        x = read(r["file"])
        turns = split_turns(x)
        if len(turns) < 2: continue
        embs = [e.emb(t) for t in turns]
        embs = [v for v in embs if v is not None]
        if len(embs) < 2: continue
        first = embs[0]
        first_core = cos(core, first)
        within = [cos(embs[i], embs[j]) for i in range(len(embs)) for j in range(i + 1, len(embs))]
        cons = statistics.median(within) if within else 0.0
        forms = (first_core < MATCH_FAST and cons >= CONSISTENCY)
        # if it forms, use the bystander cluster as the session attractor
        attr = np.mean(embs, axis=0); attr = attr / (np.linalg.norm(attr) + 1e-12)
        # then a real user turn arrives: score against the bystander attractor and the core
        user_scores = [(n, cos(attr, v), cos(core, v)) for n, v in target_embs]
        rejected_by_attr = sum(1 for _, sa, _ in user_scores if sa < TRACK)
        accepted_by_core = sum(1 for _, _, sc in user_scores if sc >= TRACK)
        out.append(dict(bystander=r["name"], first_vs_core=round(first_core, 3),
                        consistency=round(cons, 3), forms_attractor=forms,
                        user_rejected_by_attr=rejected_by_attr, user_total=len(user_scores),
                        user_accepted_by_core=accepted_by_core))
        print(f"  {r['name'][:34]:34s} first_vs_core={first_core:+.3f} cons={cons:.2f} forms={forms} "
              f"user_rejected_by_attr={rejected_by_attr}/{len(user_scores)} user_ok_by_core={accepted_by_core}/{len(user_scores)}")
    return out


def real_session_turns():
    out = []
    for tl in glob.glob(os.path.join(RC, "*.timeline.jsonl")):
        wav = tl.replace(".timeline.jsonl", ".wav")
        if not os.path.exists(wav): continue
        x, sr = sf.read(wav, dtype="float32")
        segs = []; cur = None
        for line in open(tl):
            try: ev = json.loads(line)
            except: continue
            if ev.get("kind") == "speech_started": cur = ev.get("offsetMs")
            if ev.get("kind") == "speech_stopped" and cur is not None:
                segs.append((cur, ev.get("offsetMs"))); cur = None
        turns = []
        for a, b in segs:
            if b - a < 2000: continue
            s = max(0, int((a - 100) / 1000 * SR)); e2 = min(len(x), int((b + 100) / 1000 * SR))
            turns.append(x[s:e2])
        if len(turns) >= 2: out.append((os.path.basename(wav)[:8], turns))
    return out


def active_rms(x, fl=320):
    n = len(x) // fl * fl
    if n == 0: return 1e-6
    f = x[:n].reshape(-1, fl); r = np.sqrt((f * f).mean(1) + 1e-12)
    thr = max(0.005, float(np.percentile(r, 90)) * 0.1); v = r[r > thr]
    return float(np.sqrt((v * v).mean())) if len(v) else 1e-6


def speech_mask(x):
    n = len(x) // 320 * 320
    f = x[:n].reshape(-1, 320); r = np.sqrt((f * f).mean(1) + 1e-12)
    return r > max(0.005, float(np.percentile(r, 90)) * 0.1)


def mix_at(t, i, snr):
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


def voxlock_real_sessions(e: Embedder, core):
    rows = labels()
    non = [r for r in rows if r["label"] == "nontarget"]
    inter = [read(r["file"]) for r in non if r["category"] == "05-nontarget-eotbench"]
    cross_sample = voxlock.loud_sample(read(os.path.join(AUD, "01-enroll/enroll-04_77f36308.wav")))
    vl = voxlock.VoxLock()
    out = []
    print("\n=== VoxLock on real session turns (0 dB synthetic interferer) ===")
    for key, turns in real_session_turns():
        sample = voxlock.loud_sample(turns[0], sec=min(3.0, len(turns[0]) / SR))
        if len(sample) < int(2.5 * SR):
            continue
        for tidx, t in enumerate(turns[1:], start=2):
            i = inter[(tidx + hash(key)) % len(inter)]
            mix = mix_at(t, i, 0)
            base = si(mix, t)
            for name, smp in [("session", sample), ("cross", cross_sample), ("auto", None)]:
                t0 = time.time()
                try:
                    y = vl.isolate(mix, sample=smp)
                except Exception as ex:
                    print("  fail", key, name, ex); continue
                rtf = (time.time() - t0) / (len(mix) / SR)
                s = si(y, t)
                ey = e.emb(y); et = e.emb(t); ei = e.emb(i)
                row = dict(session=key, turn=tidx, method=name, mix_si=round(base, 2),
                           si=round(s, 2), si_sdr_i=round(s - base, 2), rtf=round(rtf, 2),
                           cos_target=round(cos(core, ey), 3) if ey is not None else None,
                           cos_inter=round(cos(ei, ey), 3) if ey is not None and ei is not None else None)
                out.append(row)
                print(f"  {key} t{tidx} {name:7s} SI-SDRi {row['si_sdr_i']:+6.2f} "
                      f"cosT {row['cos_target']} cosI {row['cos_inter']} RTF {rtf:.2f}")
    return out


def main():
    e = Embedder()
    core = np.mean([e.emb(read(f)) for f in CORE_FILES], axis=0); core = core / (np.linalg.norm(core) + 1e-12)
    res = {}
    res["calibration"] = score_calibration(e, core)
    res["bystander"] = bystander_attractor(e, core)
    res["voxlock_real"] = voxlock_real_sessions(e, core)
    out = os.path.join(HERE, "out", "confirmed_experiments.json")
    with open(out, "w") as f: json.dump(res, f, indent=2)
    print("\nwrote", out)


if __name__ == "__main__":
    main()
