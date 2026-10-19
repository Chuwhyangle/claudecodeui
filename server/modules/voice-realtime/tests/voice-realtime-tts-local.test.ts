/**
 * The LOCAL CPU TTS leaf — a Kokoro sentence becomes a WAV through sherpa-onnx-node, framed exactly
 * like the cloud leaf.
 *
 * WHAT THIS FILE PINS, one reason per block:
 *
 *   · (a) `speak` frames the synthesizer's float32 samples as ONE mono 16-bit PCM RIFF/WAVE blob,
 *     reuses the shared emitter, and answers `tts_done` with the byte count and the sample-derived
 *     duration — the same readings the browser and the cloud-leaf criteria consume.
 *   · (b) an empty sentence is refused before the model is touched, and a missing model directory is
 *     `TTS_NOT_CONFIGURED` — both named failures, never an `ok` with zero bytes.
 *
 * The sherpa runtime is a TEST STAND-IN injected through `loadDependency`: the leaf is proven against
 * its shape, never against a real 325 MB ONNX load.
 *
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/voice-realtime/tests/voice-realtime-tts-local.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createLocalVoiceRealtimeTtsSeam } from '../voice-realtime-tts-local.js';
import type { VoiceRealtimeTtsFrame } from '../voice-realtime-tts.js';

/** A sherpa stand-in that answers every request with the same samples, and records the request. */
function fakeSherpa(samples: Float32Array, sampleRate: number): { runtime: unknown; requests: Array<{ text: string; sid: number; speed: number }> } {
  const requests: Array<{ text: string; sid: number; speed: number }> = [];
  const runtime = {
    OfflineTts: {
      async createAsync(_config: unknown) {
        return {
          generate(req: { text: string; sid: number; speed: number }) {
            requests.push(req);
            return { samples, sampleRate };
          },
        };
      },
    },
  };
  return { runtime, requests };
}

/** A temp dir with the one file `ensureTts` requires to consider the model present. */
function modelDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tts-local-'));
  writeFileSync(join(dir, 'model.onnx'), 'placeholder');
  return dir;
}

test('the local leaf frames float32 samples as one WAV and reports the sample-derived duration', async () => {
  const sampleRate = 24_000;
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25]);
  const { runtime, requests } = fakeSherpa(samples, sampleRate);
  const seam = createLocalVoiceRealtimeTtsSeam({
    modelDir: modelDir(),
    sid: 3,
    speed: 1.1,
    loadDependency: async () => runtime,
  });

  const frames: VoiceRealtimeTtsFrame[] = [];
  const result = await seam.speak({ utteranceId: 'u1', text: ' 哦。 ' }, (frame) => frames.push(frame));

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.text, '哦。', 'the trimmed text reaches the synthesizer');
  assert.equal(requests[0]!.sid, 3);
  assert.equal(requests[0]!.speed, 1.1);

  const audio = frames.filter((frame): frame is Extract<VoiceRealtimeTtsFrame, { type: 'tts_audio' }> => frame.type === 'tts_audio');
  assert.ok(audio.length >= 1, 'at least one tts_audio frame');
  const reassembled = Buffer.concat(audio.map((frame) => Buffer.from(frame.audio, 'base64')));
  assert.equal(reassembled.length, 44 + samples.length * 2, 'RIFF header + 16-bit PCM body');
  assert.equal(reassembled.toString('ascii', 0, 4), 'RIFF');
  assert.equal(reassembled.toString('ascii', 8, 12), 'WAVE');
  assert.equal(reassembled.readUInt16LE(20), 1, 'PCM');
  assert.equal(reassembled.readUInt16LE(22), 1, 'mono');
  assert.equal(reassembled.readUInt32LE(24), sampleRate);
  assert.equal(reassembled.readUInt16LE(34), 16, '16-bit');
  assert.equal(reassembled.readInt16LE(44), 0, 'first sample quantized to 0');

  const done = frames[frames.length - 1]!;
  assert.equal(done.type, 'tts_done');
  if (done.type === 'tts_done') {
    assert.equal(done.bytes, reassembled.length);
    assert.equal(done.frames, audio.length);
    assert.ok(Math.abs(done.durationMs! - (samples.length / sampleRate) * 1000) < 0.01);
    assert.equal(done.characters, 2, 'characters = trimmed text length');
  }
});

test('an empty sentence is refused before the model is touched', async () => {
  const { runtime, requests } = fakeSherpa(new Float32Array(0), 24_000);
  const seam = createLocalVoiceRealtimeTtsSeam({
    modelDir: modelDir(),
    loadDependency: async () => runtime,
  });

  const frames: VoiceRealtimeTtsFrame[] = [];
  const result = await seam.speak({ utteranceId: 'u2', text: '   ' }, (frame) => frames.push(frame));

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'TTS_EMPTY_TEXT');
  assert.equal(requests.length, 0, 'no synthesis request for empty text');
  assert.equal(frames.length, 0, 'no frames for empty text');
});

test('a missing model directory is TTS_NOT_CONFIGURED, not a throw', async () => {
  const seam = createLocalVoiceRealtimeTtsSeam({
    modelDir: '/nonexistent/tts-dir',
    loadDependency: async () => {
      throw new Error('must not be reached');
    },
  });

  const frames: VoiceRealtimeTtsFrame[] = [];
  const result = await seam.speak({ utteranceId: 'u3', text: '哦。' }, (frame) => frames.push(frame));

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'TTS_NOT_CONFIGURED');
    assert.match(result.message, /model\.onnx not found/);
  }
  assert.equal(frames.length, 0);
});
