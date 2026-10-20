import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { useVoiceInput } from '@/modules/chat/hooks/useVoiceInput';
import type * as AudioDecode from '@/modules/chat/utils/voice/audioDecode';
import type * as SharedApi from '@/shared/api';

/**
 * The audio-file entry travels the ONE capture path, and the recogniser's declaration decides what
 * that path does to a long pause.
 *
 * WHAT THIS FILE MEASURES. The trim itself — the batch re-encode of a finished clip — is gone:
 * `a88f5c2a` made segment-then-commit the only input path, and the audio is cut by the shared VAD
 * and uploaded as 16 kHz PCM WAV segments. What survives of the capability's say is the segmenter's
 * GAP FILTER, and that is what is read here: a stepped-over pause longer than the keep length is
 * compressed for a recogniser that declares `destructive`, and kept whole for one that does not.
 * The two arms below differ only in the declaration `effectivePauseCuesDeclaration()` returns, so
 * the bytes the recogniser is handed are a reading of the capability and not of the audio.
 *
 * Everything the chain needs is doubled below (the decoder; the recogniser; the declaration) because
 * jsdom has no audio stack, no offline recogniser and no published voice profile. The segmenter and
 * the VAD between them are the shipping modules — this file does not re-implement the cut, it
 * observes the WAV that leaves it.
 */

const { transcribeVoice, effectivePauseCuesDeclaration } = vi.hoisted(() => ({
  transcribeVoice: vi.fn(),
  effectivePauseCuesDeclaration: vi.fn(),
}));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApi>();
  return {
    transcribeVoice,
    // The raw-corpus upload the hook fires after a listen; doubled so this whole-module mock stays
    // complete. It is never awaited, so it cannot perturb the trim readings this file is about.
    captureRawVoice: vi.fn(),
    // The recogniser that will transcribe the audio, as the one read point asks for it. Doubled so a
    // case can declare `destructive` or `neutral` and nothing else changes between the two runs.
    effectivePauseCuesDeclaration,
    voiceConfigSignature: () => 'test-signature',
    // The same parse the shipping hook performs.
    parseTranscriptionResponse: actual.parseTranscriptionResponse,
  };
});

/** The PCM the decoder hands the chain. Reassigned per case so the two arms share one decoder. */
const decoded: { samples: Float32Array; sampleRate: number } = { samples: new Float32Array(0), sampleRate: 16_000 };

/** The decoder, doubled because jsdom has none; the segmenter above it is the shipping module. */
vi.mock('@/modules/chat/utils/voice/audioDecode', async (importOriginal) => ({
  ...(await importOriginal<typeof AudioDecode>()),
  decodeVoiceBlob: async () => ({ samples: decoded.samples, sampleRate: decoded.sampleRate }),
}));

const RATE = 16_000;

/**
 * One second of 16 kHz audio with a burst of speech in the middle.
 *
 * Not silence: the VAD only starts a segment on speech, so a buffer it found no speech in would
 * produce no upload at all — the absence this file asserts against would hold for the wrong reason.
 */
const speechSamples = (): Float32Array => {
  const samples = new Float32Array(RATE);
  for (let i = 3_000; i < 9_000; i++) samples[i] = 0.5 * Math.sin((i / RATE) * 2 * Math.PI * 220);
  return samples;
};

/**
 * Two 1.5 s speech runs separated by a 1.5 s pause, with half a second of leading silence.
 *
 * The leading silence is load-bearing: the VAD estimates its noise floor from the head of the
 * buffer, so a run that starts mid-phoneme reads as noise and no segment is cut at all. The pause
 * itself is longer than the gap filter's 1.0 s keep length — so a trimming recogniser drops its
 * excess — and shorter than the 2.0 s cut threshold, so with the segment minimum at its shipped 30 s
 * the pause is stepped over rather than cut: exactly the silence the gap filter decides about.
 */
const gappedSamples = (): Float32Array => {
  const samples = new Float32Array(Math.round(5 * RATE));
  const burst = (fromSec: number, toSec: number): void => {
    for (let i = Math.round(fromSec * RATE); i < Math.round(toSec * RATE); i++) {
      samples[i] = 0.5 * Math.sin((i / RATE) * 2 * Math.PI * 220);
    }
  };
  burst(0.5, 2);
  burst(3.5, 5);
  return samples;
};

const recording = () => new File([new Uint8Array(4000)], 'take.webm', { type: 'audio/webm' });

const uploaded = () => {
  const call = transcribeVoice.mock.calls[0];
  assert.ok(call, 'nothing reached the recogniser');
  return { body: call[0] as Blob, filename: call[1] as string };
};

/** The byte length of the WAV the recogniser was handed — read off the upload, not re-derived. */
const uploadedWavBytes = (): number => uploaded().body.size;

beforeEach(() => {
  transcribeVoice.mockReset();
  transcribeVoice.mockResolvedValue({ ok: true, json: async () => ({ text: 'hello' }) });
  effectivePauseCuesDeclaration.mockReset();
  decoded.samples = speechSamples();
  decoded.sampleRate = RATE;
});

test('a chosen audio file is cut and uploaded as a WAV segment, not as the file it arrived as', async () => {
  effectivePauseCuesDeclaration.mockReturnValue(null);
  const view = renderHook(() => useVoiceInput(vi.fn(), vi.fn()));
  await act(async () => {
    view.result.current.transcribeFile(recording());
  });
  // `transcribeFile` returns before the upload settles; drain that tail so the call is observable.
  await act(async () => {});

  const { body, filename } = uploaded();
  assert.equal(body.type, 'audio/wav', 'the file entry uploaded its input instead of a segment');
  assert.equal(filename, 'segment-1.wav');
  assert.equal(view.result.current.state, 'idle', 'the file run must return to idle when it settles');
});

/**
 * The load-bearing reading: the gap filter follows the recogniser's declaration, not a constant.
 *
 * Two runs over the very same audio — only `effectivePauseCuesDeclaration()` differs. A recogniser
 * that declares `destructive` gets its 1.5 s paused gap compressed to the filter's 1.0 s; one that
 * declares `neutral` keeps it whole, so its upload is materially larger. Deleting the capability
 * read from the consumer (hardcoding the shipped gap filter) collapses the two arms into one and
 * reds this assertion — which is what makes the wiring a measurement rather than a decoration.
 */
test('the recogniser declaration decides whether a stepped-over pause is compressed', async () => {
  decoded.samples = gappedSamples();

  effectivePauseCuesDeclaration.mockReturnValue({ provider: 'openai-compatible', capability: 'destructive' });
  const trimming = renderHook(() => useVoiceInput(vi.fn(), vi.fn()));
  await act(async () => {
    trimming.result.current.transcribeFile(recording());
  });
  await act(async () => {});
  const compressedBytes = uploadedWavBytes();

  // A fresh run, so the second arm's upload is `calls[0]` again.
  transcribeVoice.mockReset();
  transcribeVoice.mockResolvedValue({ ok: true, json: async () => ({ text: 'hello' }) });
  effectivePauseCuesDeclaration.mockReturnValue({ provider: 'dashscope-omni', capability: 'neutral' });
  const keeping = renderHook(() => useVoiceInput(vi.fn(), vi.fn()));
  await act(async () => {
    keeping.result.current.transcribeFile(recording());
  });
  await act(async () => {});
  const keptBytes = uploadedWavBytes();

  // 0.5 s of pause kept at 16 kHz mono 16-bit is 16 000 bytes; a floor well under that absorbs the
  // VAD's frame-quantised boundaries while still reding a hardcoded filter (which would make the two
  // arms exactly equal).
  assert.ok(
    keptBytes - compressedBytes >= 10_000,
    `destructive must compress the pause and neutral must keep it: kept=${keptBytes} bytes, compressed=${compressedBytes} bytes`,
  );
});
