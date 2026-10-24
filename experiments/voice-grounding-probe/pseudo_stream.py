"""Pseudo-streaming probe: re-decode the growing audio prefix every STEP seconds with the
non-streaming SenseVoice model, to see whether partial hypotheses arrive fast enough for
per-word highlight feedback. One synthetic utterance per case; CPU, 4 threads."""
import sys, time
sys.path.insert(0, "/tmp/vgp/py")
import numpy as np, sherpa_onnx
sys.path.insert(0, "/data/home/yale/work/claudecodeui/experiments/voice-grounding-probe")
from probe import TTS_DIR, SV_DIR
STEP = 0.16
tts = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(
    kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(model=f"{TTS_DIR}/model.onnx", voices=f"{TTS_DIR}/voices.bin",
        tokens=f"{TTS_DIR}/tokens.txt", data_dir=f"{TTS_DIR}/espeak-ng-data", dict_dir=f"{TTS_DIR}/dict",
        lexicon=f"{TTS_DIR}/lexicon-us-en.txt,{TTS_DIR}/lexicon-zh.txt"), num_threads=4)))
rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(model=f"{SV_DIR}/model.int8.onnx", tokens=f"{SV_DIR}/tokens.txt",
                                                     num_threads=4, use_itn=True, language="auto")
for text in ["打开第三个项目，然后看它的第二条验收标准", "cross device 那个任务的第四条"]:
    a = tts.generate(text, sid=3, speed=1.0); x = np.array(a.samples, dtype=np.float32); sr = a.sample_rate
    print(f"== {text}  ({len(x)/sr:.2f}s)")
    prev, costs = None, []
    for end in np.arange(STEP, len(x) / sr + STEP, STEP):
        s = rec.create_stream(); s.accept_waveform(sr, x[: int(end * sr)])
        t0 = time.perf_counter(); rec.decode_stream(s); ms = (time.perf_counter() - t0) * 1000; costs.append(ms)
        if s.result.text != prev:
            print(f"  t={end:4.2f}s  decode={ms:4.0f}ms  {s.result.text}"); prev = s.result.text
    print(f"  decode per step: median {sorted(costs)[len(costs)//2]:.0f}ms, max {max(costs):.0f}ms, steps {len(costs)}")
