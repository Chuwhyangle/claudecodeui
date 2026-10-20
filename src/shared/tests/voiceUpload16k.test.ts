/**
 * The upload is written at 16 kHz — a third of the bytes — and it stays the same audio.
 *
 * WHY THIS FILE EXISTS. `prepareUpload` hands the recogniser a WAV re-encode of the trimmed
 * recording, and that WAV used to be written at the decoded rate (48 kHz, 96 KB/s of 16-bit PCM
 * before base64). The recognisers work at 16 kHz, so the extra rate bought nothing and cost two
 * thirds of every request — which is the difference between a long clip fitting one inline request
 * and being refused as oversize. This file pins both halves of the change: the audio survives the
 * resample (a 1 kHz tone is still 1 kHz, and nothing above 8 kHz folds back in), and the bytes
 * really shrink.
 *
 * THE ANTI-ALIAS ASSERTION HAS A FALSIFIER IN IT. "Downsample" is easy to satisfy by dropping every
 * third sample, and a decimation would pass any test that only checked the rate and the length. The
 * 20 kHz case is what tells them apart: above the 16 kHz output's Nyquist it must be filtered to
 * near-nothing, and the same measurement on a decimated copy — asserted right beside it — is full
 * strength. A test that went green under the fake form would be measuring nothing.
 *
 * The hook's own half is driven through `transcribeFile`, the same chain a recording travels, with
 * only the browser seams (no audio stack in jsdom) doubled — `src/shared/tests/voiceTrim.test.ts`
 * owns the DSP, and `voiceTrimCapabilityWiring.test.tsx` owns who decides whether it runs.
 */

import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import type { PauseCuesDeclaration } from '@shared/asr/asrRegistry';

import { useVoiceInput } from '@/modules/chat/hooks/useVoiceInput';
import * as audio from '@/modules/chat/utils/voice/audioDecode';
import type * as SharedApi from '@/shared/api';

// The module under test, kept as a namespace because the hook's mock below is built from it.
const { downsampleVoice, encodeWavBlob } = audio;

const DECODE_RATE = 48_000;
const TONE_AMPLITUDE = 0.8;

/**
 * `corpus/long/L4-nonstop.wav` is the long sample this task is sized against — 140.8 s. The file
 * itself is not checked into the repository, and it does not need to be: the byte ratio between two
 * PCM rates is independent of the clip's length, so a synthesised clip of the same duration
 * measures the same fact the corpus sample would.
 */
const LONG_FORM_SEC = 140.8;

/** A mono sine at `rate`, `seconds` long, at a known amplitude. */
function sine(seconds: number, rate: number, frequency: number, amplitude = TONE_AMPLITUDE): Float32Array {
  const samples = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = amplitude * Math.sin((i / rate) * 2 * Math.PI * frequency);
  }
  return samples;
}

/** Mean power of a signal: the reading the "energy below 1%" claim is made on. */
function meanPower(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let energy = 0;
  for (let i = 0; i < samples.length; i += 1) energy += samples[i] * samples[i];
  return energy / samples.length;
}

/**
 * The amplitude of `frequency` in `samples`, by the Goertzel sum.
 *
 * For a tone that holds a whole number of cycles over the window this is the tone's own amplitude,
 * to machine precision — which is why the fixtures are sized to be exactly periodic rather than
 * merely long.
 */
function toneAmplitude(samples: Float32Array, rate: number, frequency: number): number {
  const w = (2 * Math.PI * frequency) / rate;
  let re = 0;
  let im = 0;
  for (let n = 0; n < samples.length; n += 1) {
    re += samples[n] * Math.cos(w * n);
    im -= samples[n] * Math.sin(w * n);
  }
  return (2 / samples.length) * Math.hypot(re, im);
}

/** The bytes behind a Blob, so a WAV header can be read back the way a recogniser reads it. */
async function blobBytes(blob: Blob): Promise<DataView> {
  // jsdom's Blob predates `arrayBuffer()`; FileReader is the path it does implement.
  if (typeof blob.arrayBuffer === 'function') return new DataView(await blob.arrayBuffer());
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('could not read the blob'));
    reader.readAsArrayBuffer(blob);
  });
  return new DataView(buffer);
}

/** The sample rate a WAV header carries (offset 24, little-endian). */
async function wavSampleRate(blob: Blob): Promise<number> {
  return (await blobBytes(blob)).getUint32(24, true);
}

test('the downsample keeps the duration and the WAV header carries 16 kHz', async () => {
  const input = sine(1, DECODE_RATE, 1000);
  const { samples, sampleRate } = downsampleVoice(input, DECODE_RATE);

  assert.equal(sampleRate, 16_000, 'the output did not declare the upload rate');
  assert.equal(samples.length, Math.round(input.length / 3), 'the output is not one third as long');

  // The same clip, read as time on both sides: a whole sample at the output rate is the tolerance.
  const inputSec = input.length / DECODE_RATE;
  const outputSec = samples.length / sampleRate;
  assert.ok(
    Math.abs(outputSec - inputSec) <= 1 / sampleRate,
    `${inputSec}s in came back as ${outputSec}s out — more than one sample of drift`,
  );

  const wav = encodeWavBlob(samples, sampleRate);
  const view = await blobBytes(wav);
  assert.equal(view.getUint32(24, true), 16_000, 'the WAV header does not declare 16 kHz');
  assert.equal(view.getUint16(22, true), 1, 'the upload is not mono');
  assert.equal(view.getUint16(34, true), 16, 'the upload is not 16-bit PCM');
});

test('a 1 kHz tone survives the downsample at 1 kHz', () => {
  // 48 samples per cycle at 48 kHz and 16 at 16 kHz: a whole number of cycles in the window, so the
  // Goertzel reading is the tone's amplitude rather than a leakage estimate.
  const input = sine(1, DECODE_RATE, 1000);
  const { samples } = downsampleVoice(input, DECODE_RATE);

  assert.ok(
    toneAmplitude(samples, 16_000, 1000) >= 0.9 * TONE_AMPLITUDE,
    'the 1 kHz tone was attenuated by the resample',
  );

  // And it is still the dominant component: nothing the resample added is louder than the tone.
  const candidates = [250, 500, 1000, 1500, 2000, 3000, 4000];
  const readings = candidates.map((f) => toneAmplitude(samples, 16_000, f));
  const loudest = candidates[readings.indexOf(Math.max(...readings))];
  assert.equal(loudest, 1000, `the loudest component is ${loudest} Hz, not the 1 kHz that went in`);
});

test('a 20 kHz tone — above the output Nyquist — is filtered to near-nothing, not folded back', () => {
  const input = sine(1, DECODE_RATE, 20_000);
  const { samples } = downsampleVoice(input, DECODE_RATE);

  const ratio = meanPower(samples) / meanPower(input);
  assert.ok(ratio < 0.01, `the folded-back 20 kHz kept ${(ratio * 100).toFixed(2)}% of its energy`);

  // The falsifier: the same measurement on a decimated copy. Dropping every third sample is what
  // "downsampling" means when the anti-alias filter is forgotten, and it must NOT pass the line
  // above — if it did, this test would be green under the fake form.
  const decimated = new Float32Array(Math.round(input.length / 3));
  for (let n = 0; n < decimated.length; n += 1) decimated[n] = input[n * 3];
  const decimatedRatio = meanPower(decimated) / meanPower(input);
  assert.ok(
    decimatedRatio > 0.5,
    `the discriminator is inert: decimation kept only ${decimatedRatio.toFixed(3)} of the 20 kHz energy`,
  );
});

test('the 16 kHz upload is at most 36% of the 48 kHz bytes for the long-form sample scale', () => {
  const input = sine(LONG_FORM_SEC, DECODE_RATE, 300);

  const before = encodeWavBlob(input, DECODE_RATE).size;
  const { samples, sampleRate } = downsampleVoice(input, DECODE_RATE);
  const after = encodeWavBlob(samples, sampleRate).size;

  console.log(
    `voiceUpload16k long-form bytes: 48kHz=${before} 16kHz=${after} ratio=${(after / before).toFixed(4)}`,
  );
  assert.ok(
    after <= before * 0.36,
    `${after} bytes at 16 kHz is not at most 36% of ${before} bytes at 48 kHz`,
  );
});

/*
 * The hook's half: what actually reaches the recogniser.
 *
 * `transcribeFile` is the same chain a listen travels, so the upload read here is the one a
 * dictation would make: the file is decoded, cut into segments by the shared VAD and segmenter, and
 * each segment uploaded as 16 kHz WAV. Only the browser seams are doubled: `decodeVoiceBlob`
 * returns a fixture instead of driving an `AudioContext` jsdom does not have, and `transcribeVoice`
 * records the body. Everything between them — the real VAD, the real segmenter, the real
 * downsample — runs.
 */

const { transcribeVoice } = vi.hoisted(() => ({ transcribeVoice: vi.fn() }));

/** What the doubled decoder hands the chain; `speech` decides a trim that runs from a guard that fired. */
const { decoderFixture } = vi.hoisted(() => ({ decoderFixture: { speech: true } }));

vi.mock('@/modules/chat/utils/voice/audioDecode', async (importOriginal) => ({
  ...(await importOriginal<typeof audio>()),
  decodeVoiceBlob: async () => ({
    // One second of speech at 48 kHz, or one second of digital silence: the second makes the real
    // `trimVoiceAudio` return its `noSpeech` guard, which is the fallback path under test.
    samples: decoderFixture.speech
      ? (() => {
        const samples = new Float32Array(48_000);
        for (let i = 12_000; i < 36_000; i += 1) {
          samples[i] = 0.5 * Math.sin((i / 48_000) * 2 * Math.PI * 220);
        }
        return samples;
      })()
      : new Float32Array(48_000),
    sampleRate: 48_000,
  }),
}));

/** The recogniser declares the trim; the switch agrees; the endpoint is a recorder. */
const { voiceProfile } = vi.hoisted(() => ({
  voiceProfile: { declaration: null as null | PauseCuesDeclaration },
}));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApi>();
  return {
    ...actual,
    transcribeVoice,
    effectivePauseCuesDeclaration: () => voiceProfile.declaration,
  };
});

vi.mock('@/shared/voiceDebug', () => ({
  isVoiceDebugEnabled: () => false,
  isVoiceTrimEnabled: () => true,
  // VAD on, the shipped default, so these cases still run the segmenting path.
  isVoiceVadEnabled: () => true,
  // The silence flush's window switch: absent means the shipped 5 s default, which these cases run under.
  voiceDebugFlushSilenceSec: () => undefined,
  voiceDebugMinSegmentSec: () => undefined,
  voiceDebugIdleSec: () => undefined,
  voiceDebugOriginalCapSec: () => undefined,
}));

/** The recording as the chain receives it: a real container, over the 800-byte floor. */
const RECORDING_BYTES = 4000;
const recording = () => new File([new Uint8Array(RECORDING_BYTES)], 'take.webm', { type: 'audio/webm' });

/** What the chain uploaded, in the shape the recogniser sees it. */
const uploaded = () => {
  const call = transcribeVoice.mock.calls[0];
  assert.ok(call, 'nothing reached the recogniser');
  return { body: call[0] as Blob, filename: call[1] as string };
};

/** One capture: a file through the chain a recording travels, drained to the end of the upload. */
const uploadAFile = async () => {
  const view = renderHook(() => useVoiceInput(vi.fn(), vi.fn()));
  await act(async () => {
    view.result.current.transcribeFile(recording());
  });
  await act(async () => {});
  return view;
};

beforeEach(() => {
  transcribeVoice.mockReset();
  transcribeVoice.mockResolvedValue({ ok: true, json: async () => ({ text: 'hello' }) });
  decoderFixture.speech = true;
  voiceProfile.declaration = { provider: 'fixture-recogniser', capability: 'destructive' };
});

test('a chosen file is uploaded as a 16 kHz WAV segment, not as the file it arrived as', async () => {
  await uploadAFile();

  const { body, filename } = uploaded();
  assert.equal(filename, 'segment-1.wav', 'the upload was not a segment of the decoded file');
  assert.equal(body.type, 'audio/wav', 'the upload is not a WAV segment');
  assert.notEqual(body.size, RECORDING_BYTES, 'the source file was uploaded unchanged');
  assert.equal(await wavSampleRate(body), 16_000, 'the uploaded WAV does not declare 16 kHz');
});

test('a file with no speech spends no request: there is no segment to upload', async () => {
  // Digital silence drives the shared VAD to no speech run at all, so the segmenter emits nothing.
  decoderFixture.speech = false;

  await uploadAFile();

  assert.equal(transcribeVoice.mock.calls.length, 0, 'silence produced an upload');
});
