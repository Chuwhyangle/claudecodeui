/**
 * Turning a recording into samples, and samples back into something a recogniser accepts.
 *
 * The voice path records with `MediaRecorder` — a container it did not build and cannot read — and
 * the trim module `src/shared/voiceTrim.ts` works on a `Float32Array`. This file is the seam: it is
 * the only place in the frontend that touches WebAudio, so the "decode, trim, re-encode" step is
 * one call the hook makes rather than a codec conversation the hook has to have.
 *
 * Used by `src/modules/chat/hooks/useVoiceInput.ts`.
 */

/** A recording, decoded: mono samples and the rate they are at. */
export type DecodedVoice = {
  samples: Float32Array;
  sampleRate: number;
};

/**
 * The rate the decoded copy is asked for.
 *
 * `decodeAudioData` resamples to the context's rate, and a browser capture is 48 kHz, so asking for
 * it means the common case decodes without a resample — the samples that reach the trim module are
 * the ones the encoder produced. It is a request, not a requirement: a browser that refuses the
 * option gets a default context and the buffer's own rate is used, which the WAV header then
 * carries, so the duration is exact either way.
 */
const DECODE_SAMPLE_RATE = 48_000;

/**
 * The rate the upload is written at.
 *
 * The recognisers work at 16 kHz, so resampling to it before encoding spends nothing on
 * recognition and cuts the 16-bit PCM bytes to a third of the decoded 48 kHz copy — which is what
 * lets one inline request carry a longer clip. `downsampleVoice` targets it by default, and it is
 * the rate the WAV header then carries, so the duration a reader derives stays exact.
 */
export const UPLOAD_SAMPLE_RATE = 16_000;

/**
 * Half the taps of the anti-aliasing filter: 2 * 32 + 1 = 65 coefficients.
 *
 * Sized so the stopband is deep where it has to be — everything above the output's 8 kHz Nyquist
 * folds back into the passband, and at 20 kHz the Hamming-windowed sinc is already several
 * transition widths past the cutoff. A shorter filter leaves part of that folded energy audible
 * (it is the difference between a downsample and a decimation); a longer one spends multiply-adds
 * on attenuation nothing downstream can hear.
 */
const ANTIALIAS_HALF_TAPS = 32;

/** Bytes of a canonical 44-byte PCM WAV header: RIFF/WAVE/fmt/data, no extra chunks. */
const WAV_HEADER_BYTES = 44;

/**
 * The largest 16-bit sample value. A float sample is clamped to [-1, 1] before scaling, so the
 * negative end is -PCM_MAX — the asymmetry of the two's-complement range is inside the clamp.
 */
const PCM_MAX = 32_767;

/** The browser's audio decoder, or null where there is none (a non-browser context, an old engine). */
function audioContextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  const scope = window as typeof window & { webkitAudioContext?: typeof AudioContext };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/**
 * A single mono channel out of the decoded buffer.
 *
 * Multi-channel audio is averaged rather than taking channel 0: a recogniser is given one channel
 * either way, and dropping a channel that happens to hold the voice would be a silent quality
 * loss. `slice()` copies, so the result does not alias a buffer the decoder still owns.
 */
function downmix(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels;
  if (channels <= 1) return buffer.getChannelData(0).slice();

  const mixed = new Float32Array(buffer.length);
  for (let channel = 0; channel < channels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < mixed.length; i += 1) mixed[i] += data[i] / channels;
  }
  return mixed;
}

/**
 * Decodes `blob` into mono samples, or returns null when this browser cannot read the container.
 *
 * Null is the fallback signal, not an error: the caller uploads what it recorded. A recording the
 * app cannot decode is still a recording the recogniser may be able to, so refusing to send it
 * would turn a failed optimisation into a lost dictation.
 */
export async function decodeVoiceBlob(blob: Blob): Promise<DecodedVoice | null> {
  const AudioContextCtor = audioContextCtor();
  if (!AudioContextCtor || blob.size === 0) return null;

  let context: AudioContext;
  try {
    context = new AudioContextCtor({ sampleRate: DECODE_SAMPLE_RATE });
  } catch {
    try {
      context = new AudioContextCtor();
    } catch {
      return null;
    }
  }

  try {
    // `decodeAudioData` detaches the buffer it is handed, so each call gets its own copy.
    const bytes = await blob.arrayBuffer();
    const buffer = await context.decodeAudioData(bytes);
    return { samples: downmix(buffer), sampleRate: buffer.sampleRate };
  } catch {
    return null;
  } finally {
    // Not awaited: the samples are already out, and a context left open holds an audio device.
    void context.close();
  }
}

/**
 * A Hamming-windowed sinc low-pass kernel, normalised so a constant signal keeps unity gain.
 *
 * `cutoffHz` is the -6 dB point and must sit at or below the output's Nyquist frequency. The
 * window is what keeps the truncated sinc from ringing: an unwindowed 65-tap sinc leaks enough
 * near the cutoff to colour the audio it just passed through.
 */
function lowPassKernel(cutoffHz: number, rate: number, halfTaps: number): Float32Array {
  const cutoff = cutoffHz / rate; // cycles per sample, in 0..0.5
  const taps = halfTaps * 2 + 1;
  const kernel = new Float32Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i += 1) {
    const n = i - halfTaps;
    const sinc = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));
    kernel[i] = sinc * window;
    sum += kernel[i];
  }
  for (let i = 0; i < taps; i += 1) kernel[i] /= sum;
  return kernel;
}

/**
 * The filter's response at input index `center`, treating the signal as zero outside its bounds.
 *
 * Zero-padding at the ends is the honest reading for a recording: the capture starts and stops at
 * silence, so the few samples the kernel reaches past the edges carry no signal either way.
 */
function filterAt(
  samples: Float32Array,
  kernel: Float32Array,
  halfTaps: number,
  center: number,
): number {
  let acc = 0;
  for (let k = -halfTaps; k <= halfTaps; k += 1) {
    const index = center + k;
    if (index >= 0 && index < samples.length) acc += samples[index] * kernel[k + halfTaps];
  }
  return acc;
}

/**
 * Resamples `samples` down to `outputRate`, band-limiting to the output's Nyquist frequency first.
 *
 * This is a filter-then-resample, NOT a decimation. Dropping every third sample of a 48 kHz signal
 * folds everything above 8 kHz back into the passband — a 20 kHz component arrives as a 4 kHz tone
 * at full strength — so the low-pass runs at the INPUT rate, where its coefficients' cutoff is
 * exact, and each output sample is read off the filtered signal at its own output-rate position.
 *
 * A rate at or below the target comes back untouched: this is a downsampler, and resampling upward
 * would claim a rate the samples were never captured at.
 */
export function downsampleVoice(
  samples: Float32Array,
  inputRate: number,
  outputRate: number = UPLOAD_SAMPLE_RATE,
): DecodedVoice {
  if (!(inputRate > 0) || !(outputRate > 0) || inputRate <= outputRate || samples.length === 0) {
    return { samples, sampleRate: inputRate };
  }

  const kernel = lowPassKernel(outputRate / 2, inputRate, ANTIALIAS_HALF_TAPS);
  const ratio = inputRate / outputRate;
  const outputLength = Math.round(samples.length / ratio);
  const out = new Float32Array(outputLength);
  for (let n = 0; n < outputLength; n += 1) {
    const position = n * ratio;
    const at = Math.floor(position);
    const fraction = position - at;
    const left = filterAt(samples, kernel, ANTIALIAS_HALF_TAPS, at);
    const right = fraction === 0 ? left : filterAt(samples, kernel, ANTIALIAS_HALF_TAPS, at + 1);
    out[n] = left + (right - left) * fraction;
  }
  return { samples: out, sampleRate: outputRate };
}

/**
 * Encodes `samples` as a 16-bit PCM WAV.
 *
 * WAV rather than webm/opus on purpose. The trimmed audio is shorter than what was recorded, and
 * re-encoding it through a lossy codec would spend a second generation of quality on a clip that is
 * about to be transcribed; PCM costs bytes, which is the one thing the trim just saved, and is
 * decodable by every recogniser endpoint. The header carries the rate the samples are really at, so
 * the duration a reader derives from it is the duration of what was sent.
 */
export function encodeWavBlob(samples: Float32Array, sampleRate: number): Blob {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  const writeAscii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, WAV_HEADER_BYTES - 8 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size: PCM
  view.setUint16(20, 1, true); // format 1 = PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(WAV_HEADER_BYTES + i * 2, Math.round(clamped * PCM_MAX), true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
