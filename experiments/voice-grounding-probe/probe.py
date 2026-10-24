"""Tiny probe: synthesize pointing utterances (kokoro TTS) -> SenseVoice ASR -> closed-set grounding.

Measures (a) ASR latency per utterance on CPU, (b) top-1 grounding accuracy of three matchers
over the visible candidate set: exact substring, rapidfuzz on letters, pinyin+fuzzy.
Not an evaluation: ~20 synthetic utterances, one TTS voice. Run with the sv-probe venv:
  PYTHONPATH=/tmp/vgp/py /data/home/yale/work/sv-probe/v/bin/python3 probe.py
"""
import json, re, time, sys
sys.path.insert(0, "/tmp/vgp/py")
import numpy as np, sherpa_onnx
from pypinyin import lazy_pinyin
from rapidfuzz import fuzz

TTS_DIR = "/data/home/yale/.cache/claudecodeui/tts/kokoro-multi-lang-v1_1"
SV_DIR = "/data/home/yale/work/sv-probe/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"

# Visible set: fleet view (projects, ordinals) and a board view (in-flight tasks).
FLEET = [("quay://quay-fleet/board", "quay-fleet", "①"), ("quay://claudecodeui/board", "claudecodeui", "②"),
         ("quay://quay/board", "quay", "③"), ("quay://archguard/board", "archguard", "④"),
         ("quay://plantuml-js/board", "plantuml-js", "⑤")]
BOARD = [("quay://claudecodeui/task/cockpit-hub-cross-device-state", "cockpit hub cross device state", "①"),
         ("quay://claudecodeui/task/cockpit-phone-remote-input", "cockpit phone remote input", "②"),
         ("quay://claudecodeui/task/quay-fleet-cli-locator-and-handshake", "quay fleet cli locator and handshake", "③"),
         ("quay://claudecodeui/task/architecture-send-selection-to-chat-entry-points", "architecture send selection to chat", "④")]
ORD = {"一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5}

CASES = [  # (spoken text, view, expected uri)
    ("看 claudecodeui", "fleet", 1), ("打开 quay fleet 的任务板", "fleet", 0), ("看一下 archguard", "fleet", 3),
    ("plantuml js", "fleet", 4), ("quay 的任务板", "fleet", 2), ("第三个", "fleet", 2), ("第五个", "fleet", 4),
    ("看 claude code UI", "fleet", 1), ("第二个项目", "fleet", 1), ("打开 arch guard", "fleet", 3),
    ("cockpit hub 那个任务", "board", 0), ("手机遥控那个", "board", 1), ("phone remote", "board", 1),
    ("locator 那个任务", "board", 2), ("第四个", "board", 3), ("architecture 那个", "board", 3),
    ("看 handshake", "board", 2), ("第一个", "board", 0), ("cross device 那个", "board", 0),
    ("quay fleet cli 那个", "board", 2),
]

def norm_latin(s): return re.sub(r"[^a-z0-9]", "", s.lower())
def py(s): return "".join(lazy_pinyin(s)).lower()

def ordinal(text):
    m = re.search(r"第\s*([一二两三四五12345])\s*(个|条|项)?", text)
    return ORD[m.group(1)] - 1 if m else None

def match_exact(text, cands):
    o = ordinal(text)
    if o is not None and o < len(cands): return o
    t = norm_latin(text)
    hits = [i for i, c in enumerate(cands) if norm_latin(c[1]) and norm_latin(c[1]) in t]
    return max(hits, key=lambda i: len(cands[i][1])) if hits else None

def match_fuzzy(text, cands, use_pinyin):
    o = ordinal(text)
    if o is not None and o < len(cands): return o
    key = py(text) if use_pinyin else norm_latin(text)
    best, bi = 0, None
    for i, c in enumerate(cands):
        ck = py(c[1]) if use_pinyin else norm_latin(c[1])
        sc = fuzz.partial_ratio(ck, key) if len(ck) <= len(key) else fuzz.partial_ratio(key, ck)
        if sc > best: best, bi = sc, i
    return bi if best >= 60 else None

def main():
    tts = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(
        kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(model=f"{TTS_DIR}/model.onnx", voices=f"{TTS_DIR}/voices.bin",
            tokens=f"{TTS_DIR}/tokens.txt", data_dir=f"{TTS_DIR}/espeak-ng-data", dict_dir=f"{TTS_DIR}/dict",
            lexicon=f"{TTS_DIR}/lexicon-us-en.txt,{TTS_DIR}/lexicon-zh.txt"), num_threads=4)))
    rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(model=f"{SV_DIR}/model.int8.onnx", tokens=f"{SV_DIR}/tokens.txt",
                                                         num_threads=4, use_itn=True, language="auto")
    rows = []
    for text, view, exp in CASES:
        cands = FLEET if view == "fleet" else BOARD
        audio = tts.generate(text, sid=3, speed=1.0)
        s = rec.create_stream(); s.accept_waveform(audio.sample_rate, np.array(audio.samples, dtype=np.float32))
        t0 = time.perf_counter(); rec.decode_stream(s); asr_ms = (time.perf_counter() - t0) * 1000
        hyp = s.result.text
        t1 = time.perf_counter()
        r = {"said": text, "asr": hyp, "audio_s": round(len(audio.samples) / audio.sample_rate, 2), "asr_ms": round(asr_ms),
             "exact": match_exact(hyp, cands) == exp, "fuzzy": match_fuzzy(hyp, cands, False) == exp,
             "pinyin": match_fuzzy(hyp, cands, True) == exp}
        r["match_ms"] = round((time.perf_counter() - t1) * 1000 / 3, 2)
        rows.append(r); print(json.dumps(r, ensure_ascii=False), flush=True)
    n = len(rows)
    print(json.dumps({k: f"{sum(r[k] for r in rows)}/{n}" for k in ("exact", "fuzzy", "pinyin")} |
                     {"asr_ms_median": sorted(r["asr_ms"] for r in rows)[n // 2],
                      "audio_s_median": sorted(r["audio_s"] for r in rows)[n // 2]}, ensure_ascii=False))

if __name__ == "__main__":
    main()
