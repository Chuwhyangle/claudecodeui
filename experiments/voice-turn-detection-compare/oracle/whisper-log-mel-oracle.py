#!/usr/bin/env python3
"""Independent control for group B's front-end: the OFFICIAL Whisper log-mel recipe, in numpy.

WHY THIS FILE EXISTS (SPEC P0.5, AC1 — "Smart Turn 根因"). P0 measured group B's end-to-end
decision latency at p90 167.4 ms, of which 128.5 ms was the harness's OWN JS log-mel front-end (a
naive DFT: 201 bins x 400 samples x 800 frames). That number was never checked against the path
Pipecat actually runs, so it could not be told apart from a measurement artefact. This script is
the control: it computes the SAME features with an INDEPENDENT implementation (numpy's FFT) of the
SAME recipe, so the reader can see (a) whether the JS front-end is numerically right, and (b) how
much of the 128.5 ms is the naive-DFT implementation versus the algorithm itself.

WHAT "OFFICIAL" MEANS HERE, EXACTLY. Pipecat's `LocalSmartTurnAnalyzerV3._predict_endpoint` calls
`compute_whisper_log_mel_features(audio, do_normalize=True)`, which is HuggingFace
`WhisperFeatureExtractor(chunk_length=8)`: a periodic-Hann-windowed 400-point STFT at hop 160,
power spectrum, a slaney mel filter bank (80 filters, 0–8000 Hz), `log10` clamped at 1e-10, then
`max(x, max-8)` and `(x+4)/4`. This file reproduces that recipe with numpy. It is NOT the HF
library itself — `transformers`/`torch` are not installed in this environment (checked: only numpy
2.5.3) — so it is an independent implementation of the same algorithm, which is exactly what a
control needs to be. The numerical policy mirrors the JS adapter: float64 through the power
spectrum, mel projection and log10, then cast to float32 before the max/or-normalise step.

INPUT/OUTPUT CONTRACT. Driven by `run.mts`, which writes each sample's JS features (float32,
[80,800] row-major) to `--js-features <dir>/<id>.f32` first. This script reads that manifest of
work items, computes its own features, times the featurisation (cold = the very first call, warm =
the rest), diffs against the JS features, writes its own features to `--py-features <dir>/<id>.f32`,
and emits one JSON object to `--out`.

Usage:
  python3 whisper-log-mel-oracle.py --items items.json --out out.json \
      --js-features <dir> --py-features <dir>
"""

import argparse
import json
import os
import struct
import sys
import time

import numpy as np

N_FFT = 400
HOP_LENGTH = 160
N_MELS = 80
SAMPLE_RATE = 16000
WINDOW_SECONDS = 8
FRAMES_OUT = 800
N_SAMPLES = WINDOW_SECONDS * SAMPLE_RATE  # 128000
MIN_LOG = 1e-10


# ── slaney mel scale (HF audio_utils.mel_filter_bank) ──────────────────────────────────────────

def hertz_to_mel_slaney(freq):
    """Vectorised (np.where) so it accepts a scalar or an array — the JS side applies it element-wise."""
    min_log_hertz = 1000.0
    min_log_mel = 15.0
    logstep = 27.0 / np.log(6.4)
    freq = np.asarray(freq, dtype=np.float64)
    mels = (3.0 * freq) / 200.0
    with np.errstate(divide="ignore", invalid="ignore"):
        log_part = min_log_mel + np.log(freq / min_log_hertz) * logstep
    return np.where(freq >= min_log_hertz, log_part, mels)


def mel_to_hertz_slaney(mels):
    """Vectorised (np.where) — called with the whole mel_freqs array by mel_filter_bank."""
    min_log_hertz = 1000.0
    min_log_mel = 15.0
    logstep = np.log(6.4) / 27.0
    mels = np.asarray(mels, dtype=np.float64)
    freq = (200.0 * mels) / 3.0
    return np.where(mels >= min_log_mel, min_log_hertz * np.exp(logstep * (mels - min_log_mel)), freq)


def mel_filter_bank():
    """Returns (n_mels, n_freq_bins) — the projection matrix HF stores as mel_filters."""
    num_freq_bins = 1 + N_FFT // 2  # 201
    num_mel = N_MELS
    min_freq, max_freq = 0.0, 8000.0
    mel_min = hertz_to_mel_slaney(min_freq)
    mel_max = hertz_to_mel_slaney(max_freq)
    mel_freqs = np.linspace(mel_min, mel_max, num_mel + 2)
    filter_freqs = mel_to_hertz_slaney(mel_freqs)
    fft_freqs = np.linspace(0.0, SAMPLE_RATE / 2, num_freq_bins)
    filter_diff = np.diff(filter_freqs)

    bank = np.zeros((num_freq_bins, num_mel))
    for b in range(num_freq_bins):
        down = (fft_freqs[b] - filter_freqs[:-2]) / filter_diff[:-1]
        up = (filter_freqs[2:] - fft_freqs[b]) / filter_diff[1:]
        bank[b] = np.maximum(0.0, np.minimum(down, up))
    enorm = 2.0 / (filter_freqs[2:] - filter_freqs[:-2])
    bank *= enorm[None, :]
    return bank.T  # (n_mels, n_freq_bins)


MEL = mel_filter_bank()
WINDOW = 0.5 - 0.5 * np.cos(2.0 * np.pi * np.arange(N_FFT) / N_FFT)  # numpy.hanning(N+1)[:-1]


def decode_wav(path):
    """16-bit PCM RIFF WAVE -> (sample_rate, float32 mono in [-1,1]), mirroring decodeWav."""
    with open(path, "rb") as fh:
        buf = fh.read()
    if buf[0:4] != b"RIFF":
        raise ValueError(f"not a RIFF file: {path}")
    fmt = None
    data = None
    off = 12
    while off + 8 <= len(buf):
        cid = buf[off:off + 4]
        size = struct.unpack_from("<I", buf, off + 4)[0]
        if cid == b"fmt ":
            # <HHIIHH: format, channels, sampleRate, byteRate, blockAlign, bitsPerSample
            fmt = struct.unpack_from("<HHIIHH", buf, off + 8)
        elif cid == b"data":
            data = buf[off + 8:off + 8 + size]
        off += 8 + size + (size % 2)
    if fmt is None or data is None:
        raise ValueError(f"missing fmt or data chunk: {path}")
    fmt_tag, channels, rate, _byte_rate, _block_align, bits = fmt
    if bits != 16 or fmt_tag not in (1, 0xFFFE):
        raise ValueError(f"expected 16-bit PCM, got format={fmt_tag} bits={bits}")
    frames = len(data) // (channels * 2)
    raw = np.frombuffer(data[: frames * channels * 2], dtype="<i2").astype(np.float64)
    raw = raw.reshape(frames, channels).sum(axis=1) / 32768.0 / channels
    return rate, raw.astype(np.float32)


def truncate_to_last_seconds(audio, n_samples=N_SAMPLES):
    if audio.shape[0] > n_samples:
        return audio[audio.shape[0] - n_samples:]
    if audio.shape[0] < n_samples:
        out = np.zeros(n_samples, dtype=np.float32)
        out[n_samples - audio.shape[0]:] = audio
        return out
    return audio


def whisper_log_mel(audio):
    """(n_mels, 800) float32, the HF recipe, numpy FFT."""
    pad = N_FFT // 2
    padded = np.pad(audio.astype(np.float64), (pad, pad), mode="reflect")
    n_frames = 1 + (len(padded) - N_FFT) // HOP_LENGTH
    idx = np.arange(N_FFT)[None, :] + HOP_LENGTH * np.arange(n_frames)[:, None]
    frames = padded[idx] * WINDOW[None, :]
    spec = np.fft.rfft(frames, n=N_FFT, axis=1)  # (n_frames, 201)
    power = (spec.real ** 2 + spec.imag ** 2)[:-1]  # drop the last frame (HF stft[..., :-1])
    mel = power @ MEL.T  # (mel_frames, 80)
    log = np.log10(np.maximum(mel, MIN_LOG))  # float64
    f32 = log.astype(np.float32)
    top = float(f32.max())
    norm = np.maximum(f32, top - 8.0)
    norm = (norm + 4.0) / 4.0
    return np.ascontiguousarray(norm.T)  # (80, mel_frames)


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--items", required=True, help="JSON list of {id,wav}")
    ap.add_argument("--out", required=True)
    ap.add_argument("--js-features", default="")
    ap.add_argument("--py-features", default="")
    args = ap.parse_args(argv)

    with open(args.items, "r", encoding="utf-8") as fh:
        items = json.load(fh)

    if args.py_features:
        os.makedirs(args.py_features, exist_ok=True)

    records = []
    cold_ms = None
    for i, item in enumerate(items):
        _rate, audio = decode_wav(item["wav"])
        windowed = truncate_to_last_seconds(audio)
        t0 = time.perf_counter()
        feats = whisper_log_mel(windowed)
        t1 = time.perf_counter()
        wall_ms = (t1 - t0) * 1000.0
        if i == 0:
            cold_ms = wall_ms
        rec = {
            "id": item["id"],
            "shape": list(feats.shape),
            "featureMean": float(feats.mean()),
            "featurisationWallMs": round(wall_ms, 3),
            "phase": "cold" if i == 0 else "warm",
        }
        if args.py_features:
            feats.astype(np.float32).tofile(os.path.join(args.py_features, f"{item['id']}.f32"))
        js_path = os.path.join(args.js_features, f"{item['id']}.f32") if args.js_features else ""
        if js_path and os.path.exists(js_path):
            js = np.fromfile(js_path, dtype=np.float32)
            if js.shape[0] == feats.size:
                py = feats.astype(np.float32).reshape(-1)
                diff = np.abs(py - js)
                rec["vsJs"] = {
                    "maxAbsDiff": float(diff.max()),
                    "meanAbsDiff": float(diff.mean()),
                    "agreesWithin1e_4": bool(diff.max() < 1e-4),
                }
            else:
                rec["vsJs"] = {"error": f"shape mismatch js={js.shape[0]} py={feats.size}"}
        records.append(rec)

    warm = [r["featurisationWallMs"] for r in records if r["phase"] == "warm"]
    warm_sorted = sorted(warm)
    p50 = warm_sorted[len(warm_sorted) // 2] if warm_sorted else None
    p90 = warm_sorted[max(0, int(np.ceil(0.9 * len(warm_sorted))) - 1)] if warm_sorted else None
    out = {
        "tool": "whisper-log-mel-oracle",
        "implementation": "vendored numpy port of the HF WhisperFeatureExtractor recipe (independent of the JS front-end; transformers/torch not installed so this is not the HF library itself)",
        "numpyVersion": np.__version__,
        "recipe": {
            "n_fft": N_FFT, "hop_length": HOP_LENGTH, "n_mels": N_MELS,
            "sample_rate": SAMPLE_RATE, "window_seconds": WINDOW_SECONDS,
            "window": "periodic Hann", "pad": "reflect, n_fft//2 both sides",
            "mel": "slaney scale + slaney area norm, 0-8000 Hz",
            "log": f"log10(max(x,{MIN_LOG})), then max(x,max-8), (x+4)/4, float32 for the normalise step",
        },
        "coldFeaturisationWallMs": None if cold_ms is None else round(cold_ms, 3),
        "warmFeaturisationP50Ms": p50,
        "warmFeaturisationP90Ms": p90,
        "samples": records,
    }
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2)
        fh.write("\n")
    print(f"oracle: wrote {args.out} ({len(records)} samples, warm p90 {p90} ms)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
