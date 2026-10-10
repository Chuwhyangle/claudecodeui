/**
 * Group B adapter — Pipecat Smart Turn v3.2, real local ONNX inference on CPU.
 *
 * WHAT THIS IS. The semantic turn detector Pipecat ships for on-device use: a Whisper-Tiny encoder
 * plus a shallow linear head, exported to ONNX (`smart-turn-v3.2-cpu.onnx`, the int8 CPU build).
 * It reads a raw waveform — NOT a transcript — and answers one question: has the speaker finished
 * their turn? Output is a single sigmoid probability in [0, 1]; `> 0.5` means END.
 *
 * WHY THE PREPROCESSING IS REPRODUCED HERE RATHER THAN COPIED. The model consumes Whisper log-mel
 * features, and the exact feature recipe decides the probability. Rather than trust a paraphrase,
 * this file re-implements the OFFICIAL recipe from the two upstream sources that define it:
 *
 *   · pipecat's `LocalSmartTurnAnalyzerV3._predict_endpoint` — truncate to the last 8 s, compute
 *     `compute_whisper_log_mel_features(audio, do_normalize=True)`, run ONNX with key
 *     `input_features`, read `outputs[0][0]` as the sigmoid probability.
 *     https://reference-server.pipecat.ai/en/stable/_modules/pipecat/audio/turn/smart_turn/local_smart_turn_v3.html
 *   · huggingface/transformers `WhisperFeatureExtractor` + `audio_utils.mel_filter_bank/spectrogram`,
 *     which is what the standalone `smart-turn/inference.py` calls via `WhisperFeatureExtractor(chunk_length=8)`.
 *     https://github.com/huggingface/transformers/blob/main/src/transformers/models/whisper/feature_extraction_whisper.py
 *     https://github.com/huggingface/transformers/blob/main/src/transformers/audio_utils.py
 *
 * The port is validated numerically against a Python oracle that vendors those same two upstream
 * files verbatim (see `scripts/voice-turn-detection-compare.mjs` and RESULT.json's `groupB.validation`).
 *
 * WHICH NUMERICAL TYPE AT WHICH STEP — this is not cosmetic. HF computes the power spectrogram, the
 * mel projection and `log10` in float64, then casts to float32 before the `maximum(x, max-8)` /
 * `(x+4)/4` normalisation. Reproducing that split (f64 through the log, f32 for the normalisation)
 * is what keeps the output within ~1e-6 of the oracle; doing everything in f32 drifts further.
 *
 * The ONNX session is created with the same options Pipecat uses: ORT_SEQUENTIAL, intra-op threads
 * = cpuCount, graph optimisation ENABLE_ALL. Those options are what the latency reading is about.
 */
import { readFileSync } from 'node:fs';

import * as ort from 'onnxruntime-web';

export const MODEL_SAMPLE_RATE = 16000;
export const WINDOW_SECONDS = 8;
export const N_FFT = 400;
export const HOP_LENGTH = 160;
export const N_MELS = 80;

/** Decode a 16-bit PCM mono (or downmixed) RIFF WAVE into float32 samples in [-1, 1]. */
export function decodeWav(path: string): { sampleRate: number; samples: Float32Array } {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`not a RIFF file: ${path}`);
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  let data: Buffer | null = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(off + 8),
        channels: buf.readUInt16LE(off + 10),
        sampleRate: buf.readUInt32LE(off + 12),
        bits: buf.readUInt16LE(off + 22),
      };
    } else if (id === 'data') {
      data = buf.subarray(off + 8, off + 8 + size);
    }
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`missing fmt or data chunk: ${path}`);
  if (fmt.bits !== 16 || (fmt.format !== 1 && fmt.format !== 0xfffe)) {
    throw new Error(`expected 16-bit PCM, got format=${fmt.format} bits=${fmt.bits}: ${path}`);
  }
  const frames = data.length / (fmt.channels * 2);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < fmt.channels; c++) acc += data.readInt16LE((i * fmt.channels + c) * 2) / 32768;
    samples[i] = acc / fmt.channels;
  }
  return { sampleRate: fmt.sampleRate, samples };
}

/** Truncate to the last `n_seconds` (keeping the end) or zero-pad at the FRONT to reach it. */
export function truncateToLastSeconds(samples: Float32Array, nSeconds = WINDOW_SECONDS, rate = MODEL_SAMPLE_RATE): Float32Array {
  const max = nSeconds * rate;
  if (samples.length > max) return samples.subarray(samples.length - max);
  if (samples.length < max) {
    const out = new Float32Array(max);
    out.set(samples, max - samples.length);
    return out;
  }
  return samples;
}

// ── mel filter bank (HF audio_utils, slaney scale + slaney norm) ──────────────────────────────

function hertzToMelSlaney(freq: number): number {
  const minLogHertz = 1000.0;
  const minLogMel = 15.0;
  const logstep = 27.0 / Math.log(6.4);
  let mels = (3.0 * freq) / 200.0;
  if (freq >= minLogHertz) mels = minLogMel + Math.log(freq / minLogHertz) * logstep;
  return mels;
}

function melToHertzSlaney(mels: number): number {
  const minLogHertz = 1000.0;
  const minLogMel = 15.0;
  const logstep = Math.log(6.4) / 27.0;
  let freq = (200.0 * mels) / 3.0;
  if (mels >= minLogMel) freq = minLogHertz * Math.exp(logstep * (mels - minLogMel));
  return freq;
}

/** `mel_filter_bank(num_frequency_bins=201, num_mel_filters=80, 0..8000 Hz, 16 kHz, slaney/slaney)`. */
export function melFilterBank(): Float64Array[] {
  const numFrequencyBins = 1 + N_FFT / 2; // 201
  const numMelFilters = N_MELS;
  const minFrequency = 0.0;
  const maxFrequency = 8000.0;
  const samplingRate = MODEL_SAMPLE_RATE;

  const melMin = hertzToMelSlaney(minFrequency);
  const melMax = hertzToMelSlaney(maxFrequency);
  const melFreqs = new Float64Array(numMelFilters + 2);
  for (let i = 0; i < melFreqs.length; i++) melFreqs[i] = melMin + ((melMax - melMin) * i) / (numMelFilters + 1);
  const filterFreqs = new Float64Array(melFreqs.length);
  for (let i = 0; i < melFreqs.length; i++) filterFreqs[i] = melToHertzSlaney(melFreqs[i]);
  const fftFreqs = new Float64Array(numFrequencyBins);
  for (let i = 0; i < numFrequencyBins; i++) fftFreqs[i] = ((samplingRate / 2) * i) / (numFrequencyBins - 1); // linspace(0, 8000, 201)

  const filterDiff = new Float64Array(filterFreqs.length - 1);
  for (let i = 0; i < filterDiff.length; i++) filterDiff[i] = filterFreqs[i + 1] - filterFreqs[i];

  const bank: Float64Array[] = [];
  for (let b = 0; b < numFrequencyBins; b++) {
    const row = new Float64Array(numMelFilters);
    for (let m = 0; m < numMelFilters; m++) {
      // down_slopes = -slopes[:, :-2] / filter_diff[:-1] ; up_slopes = slopes[:, 2:] / filter_diff[1:]
      // slopes[:, j] = filter_freqs[j] - fft_freq; down_slopes[:, m] = (fft_freq - filter_freqs[m]) / diff[m]
      const down = (fftFreqs[b] - filterFreqs[m]) / filterDiff[m];
      const up = (filterFreqs[m + 2] - fftFreqs[b]) / filterDiff[m + 1];
      row[m] = Math.max(0, Math.min(down, up));
    }
    bank.push(row);
  }
  // slaney area normalisation
  for (let m = 0; m < numMelFilters; m++) {
    const enorm = 2.0 / (filterFreqs[m + 2] - filterFreqs[m]);
    for (let b = 0; b < numFrequencyBins; b++) bank[b][m] *= enorm;
  }
  return bank; // bank[freqBin][mel]
}

/** Periodic Hann window of length N: numpy.hanning(N+1)[:-1] = 0.5 - 0.5*cos(2*pi*n/N). */
function hannPeriodic(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/**
 * Real-input DFT, one-sided (bins 0..N/2), computed naively — N is 400, so 201 bins x 400 samples
 * per frame. The trig table is indexed by `(k*n) % 400`, which is exact for k*n up to 400*400.
 */
function rfft400(frame: Float64Array, cosTab: Float64Array, sinTab: Float64Array): Float64Array {
  const n = N_FFT;
  const bins = n / 2 + 1;
  const out = new Float64Array(bins * 2); // interleaved re, im
  for (let k = 0; k < bins; k++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const idx = (k * i) % n;
      const c = cosTab[idx];
      const s = sinTab[idx];
      re += frame[i] * c;
      im -= frame[i] * s;
    }
    out[k * 2] = re;
    out[k * 2 + 1] = im;
  }
  return out;
}

const COS_TAB = (() => {
  const t = new Float64Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) t[i] = Math.cos((2 * Math.PI * i) / N_FFT);
  return t;
})();
const SIN_TAB = (() => {
  const t = new Float64Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) t[i] = Math.sin((2 * Math.PI * i) / N_FFT);
  return t;
})();
const MEL_BANK = melFilterBank();
const WINDOW = hannPeriodic(N_FFT);

/**
 * Whisper log-mel features: shape [N_MELS][frames=800] for an 8 s window, row-major (mel-major),
 * matching `WhisperFeatureExtractor(chunk_length=8)(..., do_normalize=True).input_features`.
 */
export function whisperLogMel(samples8s: Float32Array, framesOut = 800): Float32Array {
  const n = N_FFT;
  const hop = HOP_LENGTH;
  // center pad, reflect mode, frame_length//2 on both sides
  const pad = Math.floor(n / 2);
  const len = samples8s.length + 2 * pad;
  const padded = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    let j = i - pad;
    // reflect: no repeat of the edge sample (numpy 'reflect')
    while (j < 0 || j >= samples8s.length) {
      if (j < 0) j = -j;
      else j = 2 * samples8s.length - 2 - j;
    }
    padded[i] = samples8s.length === 0 ? 0 : samples8s[j];
  }
  const numFrames = 1 + Math.floor((padded.length - n) / hop);
  const frame = new Float64Array(n);
  const powerFlat = new Float64Array(numFrames * (n / 2 + 1)); // [frame][freqBin]
  for (let t = 0; t < numFrames; t++) {
    const start = t * hop;
    for (let i = 0; i < n; i++) frame[i] = padded[start + i] * WINDOW[i];
    const spec = rfft400(frame, COS_TAB, SIN_TAB);
    const base = t * (n / 2 + 1);
    for (let k = 0; k <= n / 2; k++) {
      const re = spec[k * 2];
      const im = spec[k * 2 + 1];
      powerFlat[base + k] = re * re + im * im;
    }
  }
  const freqBins = n / 2 + 1;
  // mel projection in float64: mel_spec[m][t] = sum_b bank[b][m] * power[t][b]
  const melFrames = numFrames - 1; // log_spec[:, :-1]
  const mel = new Float64Array(N_MELS * melFrames);
  for (let m = 0; m < N_MELS; m++) {
    for (let t = 0; t < melFrames; t++) {
      let acc = 0;
      const pbase = t * freqBins;
      for (let b = 0; b < freqBins; b++) acc += MEL_BANK[b][m] * powerFlat[pbase + b];
      const clamped = Math.max(1e-10, acc);
      mel[m * melFrames + t] = Math.log10(clamped);
    }
  }
  const outLen = N_MELS * framesOut;
  const out = new Float32Array(outLen);
  // cast to float32, then normalise in float32 (HF: np.asarray(..., float32) then max(x, max-8), (x+4)/4)
  let max = -Infinity;
  const f32 = new Float32Array(N_MELS * melFrames);
  for (let i = 0; i < f32.length; i++) {
    f32[i] = mel[i];
    if (f32[i] > max) max = f32[i];
  }
  const floor = max - 8.0;
  const copy = Math.min(framesOut, melFrames);
  for (let m = 0; m < N_MELS; m++) {
    for (let t = 0; t < copy; t++) {
      const v = Math.max(f32[m * melFrames + t], floor);
      out[m * framesOut + t] = (v + 4.0) / 4.0;
    }
  }
  return out;
}

export type SmartTurnSession = ort.InferenceSession;

export async function createSmartTurnSession(modelPath: string, cpuCount = 1): Promise<SmartTurnSession> {
  const session = await ort.InferenceSession.create(modelPath, {
    executionMode: 'sequential',
    intraOpNumThreads: cpuCount,
    interOpNumThreads: 1,
    graphOptimizationLevel: 'all',
  });
  return session;
}

/**
 * `featureMs` and `inferenceMs` are split out because they have different fixes: the featurisation is
 * this file's JS log-mel (a naive DFT), the inference is the ONNX int8 kernel. A realtime budget that
 * misses can be met by either, and which one is the cost decides whether the model is usable at all.
 */
export type SmartTurnResult = { prediction: 0 | 1; probability: number; featureMs: number; inferenceMs: number };

/** `LocalSmartTurnAnalyzerV3._predict_endpoint`: 8 s window → log-mel → ONNX → sigmoid probability. */
export async function predictEndpoint(session: SmartTurnSession, samples: Float32Array, rate = MODEL_SAMPLE_RATE): Promise<SmartTurnResult> {
  if (rate !== MODEL_SAMPLE_RATE) throw new Error(`resampling not implemented; expected ${MODEL_SAMPLE_RATE} Hz, got ${rate}`);
  const tf0 = process.hrtime.bigint();
  const windowed = truncateToLastSeconds(samples, WINDOW_SECONDS, rate);
  const feats = whisperLogMel(windowed);
  const tf1 = process.hrtime.bigint();
  const tensor = new ort.Tensor('float32', feats, [1, N_MELS, 800]);
  const outputs = await session.run({ input_features: tensor });
  const ti1 = process.hrtime.bigint();
  const first = Object.values(outputs)[0];
  const raw = first.data as Float32Array;
  const probability = raw[0];
  return {
    prediction: probability > 0.5 ? 1 : 0,
    probability,
    featureMs: Number(tf1 - tf0) / 1e6,
    inferenceMs: Number(ti1 - tf1) / 1e6,
  };
}

// ── CLI: `tsx smart-turn-v3.mts <wav> <model.onnx>` → one JSON line (used by the oracle check) ──
if (import.meta.url === `file://${process.argv[1]}`) {
  const [wavPath, modelPath] = process.argv.slice(2);
  const { sampleRate, samples } = decodeWav(wavPath);
  const session = await createSmartTurnSession(modelPath);
  const t0 = process.hrtime.bigint();
  const result = await predictEndpoint(session, samples, sampleRate);
  const t1 = process.hrtime.bigint();
  const windowed = truncateToLastSeconds(samples, WINDOW_SECONDS, sampleRate);
  const feats = whisperLogMel(windowed);
  let mean = 0;
  for (const v of feats) mean += v;
  mean /= feats.length;
  console.log(JSON.stringify({
    wav: wavPath,
    samples: samples.length,
    featureShape: [N_MELS, 800],
    featureMean: mean,
    probability: result.probability,
    prediction: result.prediction,
    inferenceMs: Number(t1 - t0) / 1e6,
  }));
}
