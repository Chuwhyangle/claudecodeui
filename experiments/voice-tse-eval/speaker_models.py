#!/usr/bin/env python3
"""Compare speaker-embedding models on the user-confirmed labels.

Labels (confirmed by listening, 2026-10-21):
  target    : 01-enroll/*.wav, 02-test-utterance/*.wav, 03-test-session/*.wav
  nontarget : 04-nontarget-librispeech/*.wav, 05-nontarget-eotbench/*.wav, 06-tts-negative/*.wav

Two readings:
  pair      : each enrollment clip vs each test clip (positive = target test)
  centroid  : mean of enrollment clips vs each test clip

The corpus is small (20 target / 16 non-target); treat EER as a ranking aid, not
a production estimate.
"""
from __future__ import annotations
import csv, json, os, statistics
import numpy as np
import soundfile as sf
import sherpa_onnx

HERE = os.path.dirname(__file__)
AUD = "/tmp/speaker-gate-audition-2026-10-20"
LABELS = os.path.join(HERE, "labels.csv")
CACHE = os.path.join(HERE, "out", "embeddings")
MODELS = {
    "campplus_zh": "/tmp/tse-eval-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx",
    "campplus_zh_en_adv": "/tmp/tse-eval-models/alt/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
    "eres2netv2_zh": "/tmp/tse-eval-models/alt/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx",
    "eres2net_base_200k_zh": "/tmp/tse-eval-models/alt/3dspeaker_speech_eres2net_base_200k_sv_zh-cn_16k-common.onnx",
    "wespeaker_zh_cnceleb_r34": "/tmp/tse-eval-models/alt/wespeaker_zh_cnceleb_resnet34_LM.onnx",
}
SR = 16000


def load_labels():
    with open(LABELS) as f:
        return list(csv.DictReader(f))


def read(p):
    x, sr = sf.read(p, dtype="float32")
    if x.ndim > 1:
        x = x.mean(1)
    if sr != SR:
        raise ValueError(f"{p}: {sr} Hz")
    return x


def embed(extractor, x):
    s = extractor.create_stream()
    s.accept_waveform(SR, x.astype(np.float32))
    if not extractor.is_ready(s):
        return None
    return np.asarray(extractor.compute(s), dtype=np.float32)


def unit(x):
    return x / (np.linalg.norm(x) + 1e-12)


def cos(a, b):
    return float(np.dot(unit(a), unit(b)))


def eer(scores, labels):
    """labels: 1 positive, 0 negative. Sweep every score as a threshold."""
    pairs = sorted(zip(scores, labels), reverse=True)
    pos = sum(labels); neg = len(labels) - pos
    if pos == 0 or neg == 0:
        return None
    best = None; best_gap = 1e9
    fp = tp = 0
    # threshold above the maximum: accept nothing
    for s, y in pairs:
        if y == 1:
            tp += 1
        else:
            fp += 1
        far = fp / neg
        frr = (pos - tp) / pos
        gap = abs(far - frr)
        if gap < best_gap:
            best_gap = gap; best = (s, far, frr)
    # also threshold below the minimum: accept everything
    far, frr = 1.0, 0.0
    if abs(far - frr) < best_gap:
        best = (min(scores) - 1e-9, far, frr)
    return {"threshold": best[0], "far": best[1], "frr": best[2], "eer": (best[1] + best[2]) / 2}


def date_of(r):
    """Calendar date for a labeled file, from voice-data JSON or the source capture mtime."""
    import datetime, glob, json
    name = r["name"]
    if r["category"] in ("01-enroll", "02-test-utterance", "01-extra-target", "03-low-confidence"):
        rid = name.split("_")[-1].replace(".wav", "")
        for j in glob.glob(os.path.expanduser("~/.cloudcli/voice-data/*.json")):
            if os.path.basename(j).startswith(rid):
                with open(j) as f: m = json.load(f)
                return datetime.datetime.fromtimestamp(m["ts"] / 1000).strftime("%Y-%m-%d")
    if r["category"] in ("03-test-session", "04-session-segment-target", "04-session-segment-nontarget"):
        key = name.split("_")[1]
        for w in glob.glob(os.path.expanduser(f"~/.cloudcli/voice-realtime-capture/{key}*.wav")):
            return datetime.datetime.fromtimestamp(os.path.getmtime(w)).strftime("%Y-%m-%d")
    return None


def auc(scores, labels):
    pos = [s for s, y in zip(scores, labels) if y == 1]
    neg = [s for s, y in zip(scores, labels) if y == 0]
    if not pos or not neg:
        return None
    wins = sum(1 for p in pos for n in neg if p > n) + 0.5 * sum(1 for p in pos for n in neg if p == n)
    return wins / (len(pos) * len(neg))


def main():
    rows = load_labels()
    targets = [r for r in rows if r["label"] == "target"]
    non = [r for r in rows if r["label"] == "nontarget"]
    enroll = [r for r in targets if r["category"] == "01-enroll"]
    test_target = [r for r in targets if r["category"] != "01-enroll"]
    print("target", len(targets), "enroll", len(enroll), "test_target", len(test_target), "nontarget", len(non))
    os.makedirs(CACHE, exist_ok=True)
    audio = {r["file"]: read(r["file"]) for r in rows}
    results = []
    for name, path in MODELS.items():
        if not os.path.exists(path):
            print("skip missing", name, path); continue
        ex = sherpa_onnx.SpeakerEmbeddingExtractor(
            sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=path, num_threads=2)
        )
        embs = {}
        for r in rows:
            e = embed(ex, audio[r["file"]])
            if e is not None:
                embs[r["file"]] = unit(e)
        # pair scores
        scores = []; ys = []; cross = []; cross_y = []
        for e in enroll:
            ed = date_of(e)
            for t in test_target:
                if e["file"] in embs and t["file"] in embs:
                    sc = cos(embs[e["file"]], embs[t["file"]])
                    scores.append(sc); ys.append(1)
                    if ed and date_of(t) and ed != date_of(t):
                        cross.append(sc); cross_y.append(1)
            for n in non:
                if e["file"] in embs and n["file"] in embs:
                    sc = cos(embs[e["file"]], embs[n["file"]])
                    scores.append(sc); ys.append(0)
                    # non-target has no calendar date; treat every such pair as cross-condition
                    cross.append(sc); cross_y.append(0)
        pair = eer(scores, ys); pair["auc"] = auc(scores, ys)
        cd = eer(cross, cross_y) if cross and 0 < sum(cross_y) < len(cross_y) else None
        pair["cross_day"] = cd
        if cd is not None:
            cd["auc"] = auc(cross, cross_y)
        pair["score_stats"] = {"target_min": round(min(s for s,y in zip(scores,ys) if y==1),3),
                               "target_median": round(statistics.median([s for s,y in zip(scores,ys) if y==1]),3),
                               "nontarget_max": round(max(s for s,y in zip(scores,ys) if y==0),3),
                               "nontarget_median": round(statistics.median([s for s,y in zip(scores,ys) if y==0]),3)}
        # centroid scores (all-enrollment mean; enrollment files excluded from test)
        cen = unit(np.mean([embs[e["file"]] for e in enroll if e["file"] in embs], axis=0))
        cs = []; cy = []
        for t in test_target:
            if t["file"] in embs: cs.append(cos(cen, embs[t["file"]])); cy.append(1)
        for n in non:
            if n["file"] in embs: cs.append(cos(cen, embs[n["file"]])); cy.append(0)
        cent = eer(cs, cy); cent["auc"] = auc(cs, cy)
        # category means
        by = {}
        for r in targets + non:
            if r["file"] not in embs: continue
            by.setdefault(r["category"], []).append(cos(cen, embs[r["file"]]))
        cat = {k: round(statistics.mean(v), 3) for k, v in sorted(by.items())}
        results.append(dict(model=name, pairs=len(scores), pair_eer=pair, centroid_eer=cent,
                            centroid_category_mean=cat,
                            dim=len(next(iter(embs.values())))))
        print(f"\n## {name}  dim={results[-1]['dim']}")
        print("  pair    EER %.3f FAR %.3f FRR %.3f AUC %.3f thr %.3f" % (
            pair["eer"], pair["far"], pair["frr"], pair["auc"], pair["threshold"]))
        print("  centroid EER %.3f FAR %.3f FRR %.3f AUC %.3f thr %.3f" % (
            cent["eer"], cent["far"], cent["frr"], cent["auc"], cent["threshold"]))
        print("  centroid mean by category:", cat)
    out = os.path.join(HERE, "out", "speaker_models.json")
    with open(out, "w") as f:
        json.dump(results, f, indent=2)
    print("\nwrote", out)


if __name__ == "__main__":
    main()
