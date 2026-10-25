#!/usr/bin/env python3
"""Offline validation of target-speaker extraction (TSE) on the selected samples.

Methods
  none                 unprocessed mixture
  gtcrn                streaming speech enhancement (not target-aware)
  vox_*                VoxLock (Apache-2.0, ONNX, CPU, 16 kHz)
  osb_*                OpenSpeakerBeam-SS (MIT, PyTorch/CPU, 16 kHz)
  vfl_*                open-voicefilter-lite (Apache-2.0, ONNX, CPU, 16 kHz)

Enrollment conditions
  oracle               sample taken from the test clip itself (upper bound / leak)
  same_day             sample from a different clip recorded the same day
  cross_day            sample from a fixed clip recorded on 2026-10-07

Metrics
  SI-SDRi = SI-SDR(estimate, clean target) - SI-SDR(mixture, clean target)
  cos_t   = cosine(CAM++(estimate), CAM++(clean target))
  cos_i   = max cosine to any interferer used in the mixture (NaN for noise)
  margin  = cos_t - cos_i
  rtf     = processing seconds / audio seconds

Audio is never committed. The script reads the audition set under
/tmp/speaker-gate-audition-2026-10-20 and writes results under out/.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import os
import sys
import time
from dataclasses import dataclass, asdict
from typing import Any

import numpy as np
import soundfile as sf
from scipy.signal import correlate

SR = 16000
DEFAULT_AUD = "/tmp/speaker-gate-audition-2026-10-20"
DEFAULT_MODELS = "/tmp/tse-eval-models"
DEFAULT_OSB = "/tmp/OpenSpeakerBeam-SS"


# ---------------------------------------------------------------- audio helpers

def read(p: str) -> np.ndarray:
    x, sr = sf.read(p, dtype="float32")
    if x.ndim > 1:
        x = x.mean(axis=1)
    if sr != SR:
        raise ValueError(f"{p}: expected {SR} Hz, got {sr}")
    return x.astype(np.float32)


def active_rms(x: np.ndarray, frame: int = 320) -> float:
    n = len(x) // frame * frame
    if n == 0:
        return 1e-6
    f = x[:n].reshape(-1, frame)
    r = np.sqrt((f * f).mean(axis=1) + 1e-12)
    thr = max(0.005, float(np.percentile(r, 90)) * 0.1)
    v = r[r > thr]
    return float(np.sqrt((v * v).mean())) if len(v) else 1e-6


def fit_peak(x: np.ndarray, peak: float = 0.7) -> np.ndarray:
    m = float(np.abs(x).max())
    return (x * (peak / m)).astype(np.float32) if m > peak else x.astype(np.float32)


def tile_to(x: np.ndarray, n: int) -> np.ndarray:
    if len(x) >= n:
        return x[:n]
    return np.tile(x, int(np.ceil(n / len(x))))[:n]


def pink(n: int, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    x = rng.normal(size=n)
    f = np.fft.rfftfreq(n, 1 / SR)
    f[0] = f[1]
    y = np.fft.irfft(np.fft.rfft(x) / np.sqrt(f), n)
    return (y / (np.std(y) + 1e-12)).astype(np.float32)


def align(est: np.ndarray, ref: np.ndarray, max_lag: int = 4000):
    c = correlate(est, ref, mode="full")
    lag = int(np.argmax(np.abs(c)) - (len(ref) - 1))
    lag = int(np.clip(lag, -max_lag, max_lag))
    if lag > 0:
        est = est[lag:]
    elif lag < 0:
        ref = ref[-lag:]
    n = min(len(est), len(ref))
    return est[:n], ref[:n], lag


def si_sdr(est: np.ndarray, ref: np.ndarray) -> tuple[float, int]:
    est, ref, lag = align(est, ref)
    est = est - est.mean()
    ref = ref - ref.mean()
    a = float(np.dot(est, ref) / (np.dot(ref, ref) + 1e-12))
    noise = est - a * ref
    return float(10 * math.log10((np.dot(a * ref, a * ref) + 1e-12) / (np.dot(noise, noise) + 1e-12) + 1e-12)), lag


# ---------------------------------------------------------------- model wrappers

class Cam:
    def __init__(self, models_dir: str):
        import sherpa_onnx
        self.ex = sherpa_onnx.SpeakerEmbeddingExtractor(
            sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                model=os.path.join(models_dir, "3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx"),
                num_threads=2,
            )
        )

    def emb(self, x: np.ndarray) -> np.ndarray:
        s = self.ex.create_stream()
        s.accept_waveform(SR, x.astype(np.float32))
        return np.asarray(self.ex.compute(s), dtype=np.float32)

    @staticmethod
    def cos(a: np.ndarray, b: np.ndarray) -> float:
        return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-12))


class Gtcrn:
    def __init__(self, models_dir: str):
        import sherpa_onnx
        cfg = sherpa_onnx.OnlineSpeechDenoiserConfig()
        cfg.model.gtcrn.model = os.path.join(models_dir, "gtcrn_simple.onnx")
        self.d = sherpa_onnx.OnlineSpeechDenoiser(cfg)
        self.shift = self.d.frame_shift_in_samples

    def run(self, x: np.ndarray) -> np.ndarray:
        self.d.reset()
        outs = []
        for k in range(0, len(x), self.shift):
            r = self.d.run(x[k:k + self.shift], SR)
            outs.append(np.asarray(r.samples, dtype=np.float32))
        r = self.d.flush()
        outs.append(np.asarray(r.samples, dtype=np.float32))
        return np.concatenate(outs)[:len(x)]


class Vox:
    def __init__(self):
        import voxlock
        self.voxlock = voxlock
        self.vl = voxlock.VoxLock()

    def isolate(self, x: np.ndarray, sample: np.ndarray | None) -> np.ndarray:
        return np.asarray(self.vl.isolate(x, sample=sample), dtype=np.float32)[:len(x)]

    def stream(self, x: np.ndarray, sample: np.ndarray, chunk: int = 640) -> np.ndarray:
        st = self.vl.stream(sample)
        outs = [st.push(x[k:k + chunk]) for k in range(0, len(x), chunk)]
        outs.append(st.flush())
        return np.concatenate(outs)[: len(x) + chunk]

    def live(self, x: np.ndarray, chunk: int = 640):
        st = self.vl.live()
        outs = [st.push(x[k:k + chunk]) for k in range(0, len(x), chunk)]
        outs.append(st.flush())
        return np.concatenate(outs), getattr(st, "locked", None)


class Vfl:
    def __init__(self):
        from voicefilter_lite import StreamingVoiceFilter
        self.cls = StreamingVoiceFilter

    def run(self, x: np.ndarray, enroll: np.ndarray) -> np.ndarray:
        v = self.cls()
        v.set_enrollment(enroll)
        hop = v.hop_length
        n = len(x) // hop * hop
        out = np.zeros(n, dtype=np.float32)
        for k in range(0, n, hop):
            out[k:k + hop] = v.step(x[k:k + hop])
        return out


class Osb:
    def __init__(self, repo: str, checkpoint: str):
        sys.path.insert(0, repo)
        import torch
        from model import SpeakerBeamSS
        from resemblyzer import VoiceEncoder
        from tools import get_speaker_embeddings_batch
        self.torch = torch
        self.get_emb = get_speaker_embeddings_batch
        self.model = SpeakerBeamSS()
        sd = torch.load(checkpoint, map_location="cpu")
        if isinstance(sd, dict) and "model_state_dict" in sd:
            sd = sd["model_state_dict"]
        self.model.load_state_dict(sd)
        self.model.eval()
        self.encoder = VoiceEncoder(device="cpu")

    @staticmethod
    def _prep(x: np.ndarray) -> np.ndarray:
        x = x.astype(np.float32)
        n = len(x) // 160 * 160
        if n < len(x):
            x = np.pad(x, (0, n + 160 - len(x)))
        return x

    def run(self, mix: np.ndarray, enroll: np.ndarray) -> np.ndarray:
        m = self.torch.from_numpy(self._prep(mix)).unsqueeze(0).unsqueeze(0)
        e = self.torch.from_numpy(self._prep(enroll)).unsqueeze(0).unsqueeze(0)
        emb = self.get_emb(self.encoder, e)
        with self.torch.no_grad():
            out = self.model(m, emb)
        return out.squeeze().detach().cpu().numpy().astype(np.float32)[: len(mix)]


# ---------------------------------------------------------------- experiment

@dataclass(frozen=True)
class Target:
    key: str
    file: str
    same_day_enroll: str | None


TARGETS = [
    Target("test-03_clean_36ec3cc9", "02-test-utterance/test-03_clean_36ec3cc9.wav", "01-enroll/enroll-01_363d1ca4.wav"),
    Target("test-04_4e06e56c", "02-test-utterance/test-04_4e06e56c.wav", "01-enroll/enroll-01_363d1ca4.wav"),
    Target("test-05_long_6576828c", "02-test-utterance/test-05_long_6576828c.wav", None),
    Target("test-06_long_9f7298ad", "02-test-utterance/test-06_long_9f7298ad.wav", "01-enroll/enroll-05_3a895548.wav"),
    Target("edge-01_quiet_a21eccb6", "02-test-utterance/edge-01_quiet_a21eccb6.wav", None),
    Target("edge-03_quiet_long_ef31fecb", "02-test-utterance/edge-03_quiet_long_ef31fecb.wav", "01-enroll/enroll-04_77f36308.wav"),
]

INTERFERERS = [
    "05-nontarget-eotbench/en__994_43__user_turn_002.wav",
    "05-nontarget-eotbench/en__1118_47__user_turn_005.wav",
    "05-nontarget-eotbench/en__713_62__user_turn_003.wav",
    "05-nontarget-eotbench/en__954_24__user_turn_004.wav",
    "05-nontarget-eotbench/en__571_24__user_turn_014.wav",
    "05-nontarget-eotbench/en__224_147__user_turn_006.wav",
]
CROSS_ENROLL = "01-enroll/enroll-04_77f36308.wav"
CONDITIONS = ["speech_0", "speech_5", "speech_10", "babble_0", "noise_0", "noise_10"]


def speech_frames(x: np.ndarray, frame: int = 320) -> np.ndarray:
    n = len(x) // frame * frame
    f = x[:n].reshape(-1, frame)
    r = np.sqrt((f * f).mean(axis=1) + 1e-12)
    thr = max(0.005, float(np.percentile(r, 90)) * 0.1)
    return r > thr


def scale_for_snr(t: np.ndarray, interference: np.ndarray, snr_db: float) -> float:
    """Scale interference so the SNR DURING TARGET SPEECH is snr_db.

    Overall-RMS scaling is misleading when the interferer speaks only part of the
    time; this matches the level where the target is actually talking.
    """
    n = min(len(t), len(interference))
    mask = np.repeat(speech_frames(t[:n]), 320)[:n]
    if mask.sum() < 320:
        mask = np.ones(n, dtype=bool)
    rt = float(np.sqrt((t[:n][mask] ** 2).mean()))
    ri = float(np.sqrt((interference[:n][mask] ** 2).mean()))
    if ri < 1e-8:
        ri = active_rms(interference[:n])
    return rt / ri * 10 ** (-snr_db / 20)


def build_condition(t: np.ndarray, condition: str, inter: list[np.ndarray], idx: int):
    n = len(t)
    if condition.startswith("speech_"):
        snr = float(condition.split("_")[1])
        i = tile_to(inter[idx % len(inter)], n)
        return fit_peak(t + scale_for_snr(t, i, snr) * i), [i]
    if condition.startswith("babble_"):
        snr = float(condition.split("_")[1])
        parts = [tile_to(inter[(idx + k) % len(inter)], n) for k in range(3)]
        b = sum(p * (0.7 if k == 1 else 0.6) for k, p in enumerate(parts))
        return fit_peak(t + scale_for_snr(t, b, snr) * b), parts
    if condition.startswith("noise_"):
        snr = float(condition.split("_")[1])
        nz = pink(n, seed=idx)
        return fit_peak(t + scale_for_snr(t, nz, snr) * nz), []
    raise ValueError(condition)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audition-dir", default=DEFAULT_AUD)
    ap.add_argument("--models-dir", default=DEFAULT_MODELS)
    ap.add_argument("--osb-repo", default=DEFAULT_OSB)
    ap.add_argument("--osb-checkpoint", default=os.path.join(DEFAULT_OSB, "checkpoints/best_model.pth"))
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "out"))
    ap.add_argument("--targets", default="all")
    ap.add_argument("--methods", default="all")
    ap.add_argument("--conditions", default="all")
    ap.add_argument("--save-examples", action="store_true")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    aud = args.audition_dir
    targets = TARGETS if args.targets == "all" else [x for x in TARGETS if x.key in args.targets.split(",")]
    conditions = CONDITIONS if args.conditions == "all" else args.conditions.split(",")
    methods = (
        ["none", "gtcrn", "vox_oracle", "vox_same_day", "vox_cross_day", "vox_auto",
         "osb_oracle", "osb_cross_day", "vfl_oracle", "vfl_same_day", "vfl_cross_day"]
        if args.methods == "all" else args.methods.split(",")
    )

    # Lazy construction: a method is built only if it is in the run.
    cam = Cam(args.models_dir)
    inter = [read(os.path.join(aud, p)) for p in INTERFERERS]
    inter_emb = [cam.emb(x) for x in inter]
    cross_sample = None
    gtcrn = vox = osb = vfl = None
    if "gtcrn" in methods:
        gtcrn = Gtcrn(args.models_dir)
    if any(m.startswith("vox_") for m in methods):
        vox = Vox()
    if any(m.startswith("osb_") for m in methods):
        osb = Osb(args.osb_repo, args.osb_checkpoint)
    if any(m.startswith("vfl_") for m in methods):
        vfl = Vfl()

    rows: list[dict[str, Any]] = []
    examples = os.path.join(args.out, "examples")
    if args.save_examples:
        os.makedirs(examples, exist_ok=True)

    for ti, target in enumerate(targets):
        t = read(os.path.join(aud, target.file))
        et = cam.emb(t)
        same_sample = None
        if target.same_day_enroll:
            same_sample = __import__("voxlock").loud_sample(read(os.path.join(aud, target.same_day_enroll)))
        if cross_sample is None:
            cross_sample = __import__("voxlock").loud_sample(read(os.path.join(aud, CROSS_ENROLL)))
        oracle_sample = __import__("voxlock").loud_sample(t)

        for condition in conditions:
            mix, used = build_condition(t, condition, inter, ti)
            mix_si, _ = si_sdr(mix, t)
            mix_emb = cam.emb(mix)
            ci = max((cam.cos(e, mix_emb) for e in inter_emb[:len(used)]) if used else [float("nan")])
            print(f"\n[{target.key}] {condition}  dur={len(t)/SR:.2f}s  mixSI={mix_si:.2f}")

            for method in methods:
                if method == "none":
                    out, rtf = mix, 0.0
                else:
                    t0 = time.time()
                    try:
                        if method == "gtcrn":
                            out = gtcrn.run(mix)
                        elif method == "vox_oracle":
                            out = vox.isolate(mix, oracle_sample)
                        elif method == "vox_same_day":
                            if same_sample is None:
                                continue
                            out = vox.isolate(mix, same_sample)
                        elif method == "vox_cross_day":
                            out = vox.isolate(mix, cross_sample)
                        elif method == "vox_auto":
                            out = vox.isolate(mix, None)
                        elif method == "osb_oracle":
                            out = osb.run(mix, oracle_sample)
                        elif method == "osb_cross_day":
                            out = osb.run(mix, cross_sample)
                        elif method == "vfl_oracle":
                            out = vfl.run(mix, oracle_sample)
                        elif method == "vfl_same_day":
                            if same_sample is None:
                                continue
                            out = vfl.run(mix, same_sample)
                        elif method == "vfl_cross_day":
                            out = vfl.run(mix, cross_sample)
                        else:
                            raise ValueError(method)
                    except Exception as e:  # noqa: BLE001
                        print(f"  {method:16s} FAILED {type(e).__name__}: {e}")
                        rows.append(dict(target=target.key, condition=condition, method=method,
                                         error=f"{type(e).__name__}: {e}"))
                        continue
                    rtf = (time.time() - t0) / (len(mix) / SR)

                s, lag = si_sdr(out, t)
                eo = cam.emb(out)
                cos_t = cam.cos(et, eo)
                cos_i = max((cam.cos(e, eo) for e in inter_emb[:len(used)]) if used else [float("nan")])
                margin = cos_t - cos_i if used else float("nan")
                row = dict(
                    target=target.key, condition=condition, method=method,
                    duration_s=round(len(t) / SR, 3), mix_si_sdr=round(mix_si, 3),
                    si_sdr=round(s, 3), si_sdr_improvement=round(s - mix_si, 3),
                    cos_target=round(cos_t, 4), cos_interferer=round(cos_i, 4) if used else None,
                    cos_margin=round(margin, 4) if used else None,
                    rtf=round(rtf, 4), out_rms=round(float(np.sqrt((out * out).mean())), 5),
                    lag=lag,
                )
                rows.append(row)
                print(f"  {method:16s} SI-SDRi {row['si_sdr_improvement']:+6.2f}  cosT {cos_t:.3f}  "
                      f"cosI {cos_i:.3f}  margin {margin:.3f}  RTF {rtf:.3f}")
                if args.save_examples and method in ("none", "gtcrn", "vox_oracle", "vox_same_day", "vox_cross_day", "osb_oracle", "vfl_oracle"):
                    sf.write(os.path.join(examples, f"{target.key}__{condition}__{method}.wav"), out, SR)

    csv_path = os.path.join(args.out, "results.csv")
    fields = sorted({k for r in rows for k in r})
    with open(csv_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    with open(os.path.join(args.out, "results.json"), "w") as f:
        json.dump(rows, f, indent=2)

    # Medians over successful runs.
    import statistics
    summary: dict[str, Any] = {}
    for method in methods:
        per = {}
        for condition in conditions:
            rs = [r for r in rows if r.get("method") == method and r.get("condition") == condition and "error" not in r]
            if rs:
                per[condition] = {
                    "n": len(rs),
                    "si_sdr_improvement_median": round(statistics.median(r["si_sdr_improvement"] for r in rs), 3),
                    "cos_target_median": round(statistics.median(r["cos_target"] for r in rs), 3),
                    "cos_margin_median": (round(statistics.median(r["cos_margin"] for r in rs), 3)
                                          if all(r.get("cos_margin") is not None for r in rs) else None),
                    "rtf_median": round(statistics.median(r["rtf"] for r in rs), 3),
                }
        if per:
            summary[method] = per
    with open(os.path.join(args.out, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2)
    print(f"\nwrote {csv_path}")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
