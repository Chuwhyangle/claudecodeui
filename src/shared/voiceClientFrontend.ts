/**
 * The client-side recogniser's audio front end and CTC post-processing, as pure functions.
 *
 * WHAT THIS IS. The browser-local ASR path (D2, `docs/proposals/voice-correction-feedback-loop.md`
 * §5.10) runs SenseVoice-Small int8 on `onnxruntime-web` inside a Web Worker. Everything between the
 * recorded WAV and the model's token list is here: the Kaldi-compatible fbank, the LFR 7/6 window
 * with FunASR-style left padding plus CMVN, the ONNX `metadata_props` reader, log-softmax, and the
 * CTC greedy decode. The `onnxruntime-web` session itself is NOT here — it lives in the worker
 * (`@/shared/voiceClientAsrWorker`) — because this module has to stay runnable, and
 * therefore testable, with no model and no runtime.
 *
 * WHERE IT COMES FROM. This is a port of the feasibility probe's front end
 * (`experiments/voice-client-asr-probe/probe.mjs`), which was validated frame-for-frame against the
 * project's server-side Python reference (`experiments/voice-index-loop/sv/svlib.py`) on the same
 * `kaldi_native_fbank` oracle BEFORE any reading was taken: fbank `max|Δ| = 0`, LFR+CMVN
 * `max|Δ| = 1.7e-5` (float32 rounding), and the recorded token regression — clip 1's first six
 * tokens `检/t=4 查/t=7 we/t=12 b/t=15 ▁server/t=18 进/t=25`. The probe's readings are the only
 * test oracle this port has, because the probe deliberately kept no model weights or audio in the
 * tree (see `docs/experiments/2026-10-06-voice-client-asr-probe.md` §12).
 *
 * WHY THE SHAPE MATTERS. `tokens` come out as `{ tok, p, t }`, the same shape the server's
 * `sv2/sv.jsonl` records: `t` is the frame index AFTER the four prefix frames are dropped, so two
 * paths that drop the prefix the same way have the same `t` axis and "same position" needs no
 * registration (§0.1 constraint 1). The three parameters the probe pinned — per-frame mean removal,
 * pre-emphasis with the first sample using itself, and no mel normalisation — are what take the
 * fbank delta from 0 to 4.92 when one is wrong (§3), so they are kept verbatim.
 *
 * NO NODE BUILT-INS AND NO ES2021+ LIBRARY FEATURES. Root `tsconfig.json` compiles this file for the
 * browser (ES2020 + DOM) and `server/tsconfig.json` deliberately excludes `../src`, but the same
 * discipline the repository-root `shared/` tree keeps is applied here anyway: the module is a
 * candidate for reuse and the cheap rule is to depend on nothing that is not ES2020.
 */

/** The fbank floor: `std::numeric_limits<float>::epsilon()`, Kaldi's own silence floor. */
const FLOOR = 1.1920928955078125e-7;

/** The frontier frame each decode drops: the model emits `frames + PREFIX_FRAMES` rows. */
const PREFIX_FRAMES = 4;

/** The probe build this front end is a port of, recorded so a reading can name its producer. */
export const VOICE_CLIENT_PROBE_VERSION = 'v1';

/** A decoded 16-bit PCM WAV: mono float samples at the file's own rate. */
export type VoiceClientWav = {
  samples: Float32Array;
  sampleRate: number;
  channels: number;
};

/** A filterbank: `frames × bins` row-major log-energies. */
export type VoiceClientFbank = {
  data: Float32Array;
  frames: number;
  bins: number;
};

/** LFR+CMVN features: `frames × dim` row-major, `dim = bins × lfrWindow`. */
export type VoiceClientFeatures = {
  data: Float32Array;
  frames: number;
  dim: number;
};

/** One CTC token: the piece, its confidence `p` in `(0, 1]`, and its frame `t`. */
export type VoiceClientToken = {
  tok: string;
  p: number;
  t: number;
};

/** A decoded answer: the joined text and the tokens it was joined from. */
export type VoiceClientDecode = {
  text: string;
  tokens: VoiceClientToken[];
};

/** The ONNX `metadata_props` table, key to value; a key with no value maps to null. */
export type VoiceClientModelMeta = Record<string, string | null>;

/** The fbank's Kaldi defaults. Every field has the probe's value; callers normally pass none. */
export type VoiceClientFbankOptions = {
  numBins?: number;
  frameLength?: number;
  frameShift?: number;
  sampleRate?: number;
  lowFreq?: number;
  highFreq?: number;
  /** FFT length; 512 is the probe's zero-padded size for a 400-sample frame. */
  pad?: number;
  preemph?: number;
};

/**
 * Reads a 16-bit PCM WAV into mono float samples.
 *
 * Chunks are walked rather than assumed at fixed offsets, so a file with an extra `LIST`/`fact`
 * chunk before `data` still parses. Only 16-bit PCM is accepted: the recorder emits nothing else and
 * a second bit depth would need its own scaling rule rather than a silent reinterpretation.
 */
export function parseWav(buf: ArrayBuffer): VoiceClientWav {
  const b = new Uint8Array(buf);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 12;
  let dataOff = -1;
  let dataLen = 0;
  let sampleRate = 16000;
  let bits = 16;
  let channels = 1;
  while (off + 8 <= b.length) {
    const id = String.fromCharCode(b[off], b[off + 1], b[off + 2], b[off + 3]);
    const size = dv.getUint32(off + 4, true);
    if (id === 'fmt ') {
      channels = dv.getUint16(off + 10, true);
      sampleRate = dv.getUint32(off + 12, true);
      bits = dv.getUint16(off + 22, true);
    } else if (id === 'data') {
      dataOff = off + 8;
      dataLen = size;
      break;
    }
    off += 8 + size + (size & 1);
  }
  if (dataOff < 0) throw new Error('wav: no data chunk');
  if (bits !== 16) throw new Error(`wav: only 16-bit PCM supported (got ${bits})`);
  const n = Math.floor(dataLen / 2 / channels);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(dataOff + i * 2 * channels, true);
  return { samples: out, sampleRate, channels };
}

/** The Hamming window a Kaldi fbank frame is multiplied by. */
function hamming(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/** The mel scale Kaldi's filterbank is built on. */
function melScale(f: number): number {
  return 1127.0 * Math.log(1.0 + f / 700.0);
}

/**
 * Builds `numBins` triangular mel filters over `fftLen / 2` FFT bins.
 *
 * A non-positive `highFreq` means the Nyquist frequency, which is how the caller asks for the
 * default band without knowing the sample rate. The filter edge rule is Kaldi's `mel_freq > left &&
 * mel_freq < right` with the triangular peak clamped into `[0, 1]` — matching the reference
 * exactly is what the fbank `max|Δ| = 0` reading rests on.
 */
export function makeMelBanks(
  numBins: number,
  fftLen: number,
  sampleRate: number,
  lowFreq: number,
  highFreq: number,
): Float64Array[] {
  const fftBinWidth = sampleRate / fftLen;
  const numFftBins = fftLen / 2;
  const high = highFreq <= 0 ? sampleRate / 2 : highFreq;
  const melLow = melScale(lowFreq);
  const melHigh = melScale(high);
  const delta = (melHigh - melLow) / (numBins + 1);
  const banks: Float64Array[] = [];
  for (let m = 0; m < numBins; m++) {
    const left = melLow + m * delta;
    const center = melLow + (m + 1) * delta;
    const right = melLow + (m + 2) * delta;
    const w = new Float64Array(numFftBins);
    for (let i = 0; i < numFftBins; i++) {
      const mf = melScale(fftBinWidth * i);
      if (mf > left && mf < right) {
        const up = (mf - left) / (center - left);
        const down = (right - mf) / (right - center);
        w[i] = Math.max(0, Math.min(up, down));
      }
    }
    banks.push(w);
  }
  return banks;
}

/** An in-place iterative radix-2 FFT, the same transform the probe and `svlib.py` compute. */
function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + half] * cwr - im[i + k + half] * cwi;
        const vi = re[i + k + half] * cwi + im[i + k + half] * cwr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + half] = ur - vr;
        im[i + k + half] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
}

/**
 * Kaldi fbank: 80 mel bins, hamming window, `snip_edges = true`, `dither = 0`.
 *
 * THE THREE THINGS THAT LOOK LIKE DETAILS AND ARE NOT (probe §3): every frame has its own mean
 * removed; pre-emphasis runs backwards over the frame with the first sample multiplied by itself
 * rather than by the sample before the frame; and the mel energies are NOT normalised before the
 * log. Get one wrong and the fbank `max|Δ|` against the oracle jumps from 0 to 4.92.
 */
export function fbank(samples: Float32Array, options: VoiceClientFbankOptions = {}): VoiceClientFbank {
  const numBins = options.numBins ?? 80;
  const frameLength = options.frameLength ?? 400;
  const frameShift = options.frameShift ?? 160;
  const sampleRate = options.sampleRate ?? 16000;
  const lowFreq = options.lowFreq ?? 20;
  const highFreq = options.highFreq ?? 0;
  const pad = options.pad ?? 512;
  const preemph = options.preemph ?? 0.97;

  const win = hamming(frameLength);
  const banks = makeMelBanks(numBins, pad, sampleRate, lowFreq, highFreq);
  const numFrames = Math.floor((samples.length - frameLength) / frameShift) + 1;
  if (numFrames <= 0) return { data: new Float32Array(0), frames: 0, bins: numBins };
  const out = new Float32Array(numFrames * numBins);
  const re = new Float64Array(pad);
  const im = new Float64Array(pad);
  const frame = new Float64Array(frameLength);
  for (let f = 0; f < numFrames; f++) {
    const start = f * frameShift;
    let mean = 0;
    for (let i = 0; i < frameLength; i++) mean += samples[start + i];
    mean /= frameLength;
    for (let i = 0; i < frameLength; i++) frame[i] = samples[start + i] - mean;
    for (let j = frameLength - 1; j >= 1; j--) frame[j] -= preemph * frame[j - 1];
    frame[0] -= preemph * frame[0];
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < frameLength; i++) re[i] = frame[i] * win[i];
    fftInPlace(re, im);
    for (let m = 0; m < numBins; m++) {
      let e = 0;
      const w = banks[m];
      for (let i = 0; i < pad / 2; i++) {
        const pw = re[i] * re[i] + im[i] * im[i];
        e += pw * w[i];
      }
      out[f * numBins + m] = Math.log(e < FLOOR ? FLOOR : e);
    }
  }
  return { data: out, frames: numFrames, bins: numBins };
}

/**
 * LFR 7/6 with FunASR-style left padding (three copies of the first frame), then per-dim CMVN.
 *
 * `NEG` and `INV` are the model's `neg_mean` and `inv_stddev`, and they are 560-dimensional — the
 * LFR dimension, not the 80-bin one — which is why the two vectors are indexed by the stacked
 * window position `j * bins + d` rather than by `d` alone. The tail is clamped to the last real
 * frame (`T + 2` in the padded index space) so the final window is complete rather than short.
 */
export function lfrCmvn(
  F: Float32Array,
  T: number,
  bins: number,
  NEG: Float32Array,
  INV: Float32Array,
): VoiceClientFeatures {
  const Fp = new Float32Array((T + 3) * bins);
  Fp.set(F.subarray(0, bins), 0);
  Fp.set(F.subarray(0, bins), bins);
  Fp.set(F.subarray(0, bins), 2 * bins);
  Fp.set(F.subarray(0, T * bins), 3 * bins);
  const n = Math.floor((T + 5) / 6);
  const D = bins * 7;
  const out = new Float32Array(n * D);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < 7; j++) {
      const src = i * 6 + j < T + 3 ? i * 6 + j : T + 2;
      for (let d = 0; d < bins; d++) {
        const k = j * bins + d;
        out[i * D + k] = (Fp[src * bins + d] + NEG[k]) * INV[k];
      }
    }
  }
  return { data: out, frames: n, dim: D };
}

/**
 * Reads the ONNX model's `metadata_props` (protobuf field 14) with a minimal wire-format walk.
 *
 * The model's own `neg_mean` / `inv_stddev` / `lfr_window_size` live here, and reading them at
 * runtime rather than pinning them as constants is the probe's discipline: the CMVN statistics
 * belong to the weights, so a swapped checkpoint must not keep the old ones silently. Unknown
 * fields are skipped by wire type, so a model with extra metadata still parses.
 */
export function parseOnnxMetadata(buf: ArrayBuffer): VoiceClientModelMeta {
  const b = new Uint8Array(buf);
  let p = 0;
  const readVarint = (): number => {
    let r = 0;
    let s = 0;
    for (;;) {
      const c = b[p++];
      r += (c & 0x7f) * Math.pow(2, s);
      if (!(c & 0x80)) return r;
      s += 7;
    }
  };
  const readString = (len: number): string => {
    const s = p;
    p += len;
    return new TextDecoder().decode(b.subarray(s, s + len));
  };
  const skip = (wire: number): void => {
    if (wire === 0) readVarint();
    else if (wire === 1) p += 8;
    else if (wire === 2) {
      const len = readVarint();
      p += len;
    } else if (wire === 5) p += 4;
    else throw new Error(`protobuf: bad wire type ${wire}`);
  };
  const meta: VoiceClientModelMeta = {};
  while (p < b.length) {
    const tag = readVarint();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 14 && wire === 2) {
      const len = readVarint();
      const end = p + len;
      let key: string | null = null;
      let value: string | null = null;
      while (p < end) {
        const t2 = readVarint();
        const f2 = t2 >>> 3;
        const w2 = t2 & 7;
        if (f2 === 1 && w2 === 2) key = readString(readVarint());
        else if (f2 === 2 && w2 === 2) value = readString(readVarint());
        else skip(w2);
      }
      if (key !== null) meta[key] = value;
    } else {
      skip(wire);
    }
  }
  return meta;
}

/**
 * Turns logits into per-frame log-probabilities in place: subtract the row max, exp, normalise, log.
 *
 * Done on the row rather than with a separate softmax array because the callers hand it the whole
 * `frames × vocab` matrix at once and the intermediate probabilities are not needed.
 */
export function logSoftmaxInPlace(lp: Float32Array, dim: number, n: number): void {
  for (let t = 0; t < dim; t++) {
    const base = t * n;
    let mx = -Infinity;
    for (let i = 0; i < n; i++) if (lp[base + i] > mx) mx = lp[base + i];
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const e = Math.exp(lp[base + i] - mx);
      lp[base + i] = e;
      sum += e;
    }
    for (let i = 0; i < n; i++) lp[base + i] = Math.log(lp[base + i] / sum);
  }
}

/**
 * CTC greedy decode over a `dim × vocab` log-probability matrix.
 *
 * Three rules the probe pinned and this keeps: a frame whose argmax is the blank (id 0) emits
 * nothing; a frame that repeats the previous argmax extends that token's confidence by the maximum
 * of the two softmax values (`p` is "the best evidence this repeated run had") rather than starting
 * a new token; and `<|…|>` special tokens are dropped after decoding. `p` is `exp` of the
 * log-probability, so a caller reading `p ≥ 0.85` is reading the confidence §0.1 constraint 4
 * describes.
 */
export function greedyDecode(lp: Float32Array, dim: number, tokens: readonly string[]): VoiceClientToken[] {
  const toks: VoiceClientToken[] = [];
  let prev = -1;
  const vocab = tokens.length;
  for (let t = 0; t < dim; t++) {
    let bi = 0;
    let bp = lp[t * vocab];
    for (let i = 1; i < vocab; i++) {
      const v = lp[t * vocab + i];
      if (v > bp) {
        bp = v;
        bi = i;
      }
    }
    const pk = Math.exp(bp);
    if (bi !== prev && bi !== 0) {
      toks.push({ tok: tokens[bi], p: pk, t });
    } else if (bi === prev && bi !== 0 && toks.length > 0) {
      const last = toks[toks.length - 1];
      last.p = Math.max(last.p, pk);
    }
    prev = bi;
  }
  return toks.filter((k) => !k.tok.startsWith('<|'));
}

/** Joins tokens into text: the `▁` word boundary becomes a space, and the ends are trimmed. */
export function tokensToText(tokens: readonly VoiceClientToken[]): string {
  return tokens
    .map((k) => k.tok)
    .join('')
    .replace(/▁/g, ' ')
    .trim();
}

/**
 * The whole post-processing pass over one clip's logits: drop the four prefix frames, log-softmax,
 * greedy decode, join.
 *
 * THIS IS THE ONLY PLACE THE PREFIX IS DROPPED, and dropping it here rather than at each caller is
 * what makes `t` mean the same thing on every path — the probe's `t` and the server's `t` both start
 * at the first frame after the prefix, so a token at `t = 18` on both is at the same position with
 * no registration step (§0.1 constraint 1). `logits` is the model's `[1, frames + 4, vocab]` output
 * flattened, and the caller passes `frames` as the feature-frame count, not the logits' row count.
 */
export function decodeLogits(
  logits: Float32Array,
  frames: number,
  tokens: readonly string[],
): VoiceClientDecode {
  const vocab = tokens.length;
  const lp = new Float32Array(frames * vocab);
  const total = (frames + PREFIX_FRAMES) * vocab;
  lp.set(logits.subarray(PREFIX_FRAMES * vocab, total));
  logSoftmaxInPlace(lp, frames, vocab);
  const decoded = greedyDecode(lp, frames, tokens);
  return { text: tokensToText(decoded), tokens: decoded };
}
