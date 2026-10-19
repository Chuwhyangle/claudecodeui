/**
 * The streaming half of the Live Voice TTS leaf: the first `tts_audio` frame leaves for the browser
 * while the SSE synthesis is STILL OPEN, and the frames still reassemble to the exact WAV.
 *
 * WHAT THIS FILE PINS, one reason per leg:
 *
 *   · FIRST FRAME BEFORE THE STREAM CLOSES. The stand-in upstream does not close its ReadableStream
 *     until the criterion has seen the first `tts_audio` frame on the downlink. A producer that
 *     awaits the whole synthesis before slicing (the defect this task closes) would never release
 *     that gate, so the criterion could not even finish — and the recorded `closed` reading at the
 *     first frame is the direct evidence that framing is incremental.
 *
 *   · THE FRAME CONTRACT IS UNCHANGED. `seq: 0` decodes to bytes starting with `RIFF`, the frames
 *     are dense and zero-based, and concatenating every `tts_audio` payload equals the stand-in's
 *     complete WAV byte-for-byte. That is what keeps an older page able to join the frames.
 *
 *   · THE HEADER MAY ARRIVE ACROSS EVENTS. The second leg splits the 44-byte RIFF header over three
 *     SSE events (12, 8 and the rest) and asserts the same reassembly, so a parser that only looked
 *     at the first event is red.
 *
 *   · AN ERROR BEFORE AUDIO IS ONE `tts_error`, NEVER A HALF UTTERANCE. The `error-leg` block pins
 *     the AC's refusal shape: no `tts_audio`, no `tts_done`, exactly one error frame.
 *
 * Run with this repo's TS-ESM test runner:
 *
 *     npx tsx --tsconfig server/tsconfig.json --test \
 *       server/modules/voice-realtime/tests/voice-realtime-tts-stream.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_VOICE_REALTIME_TTS_SAMPLE_RATE,
  streamVoiceRealtimeSpeech,
  type VoiceRealtimeTtsFrame,
  type VoiceRealtimeTtsOptions,
} from '../voice-realtime-tts.js';

// ── a real RIFF/WAVE blob ───────────────────────────────────────────────────────────────────────

function writeAscii(bytes: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) bytes[offset + index] = text.charCodeAt(index);
}

function writeUint16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

/** A mono PCM16 WAV: a 44-byte canonical header followed by `sampleCount` samples. */
function makeWav(sampleCount: number, sampleRate: number): Uint8Array {
  const bytesPerSample = 2;
  const dataSize = sampleCount * bytesPerSample;
  const bytes = new Uint8Array(44 + dataSize);

  writeAscii(bytes, 0, 'RIFF');
  writeUint32(bytes, 4, 36 + dataSize);
  writeAscii(bytes, 8, 'WAVE');
  writeAscii(bytes, 12, 'fmt ');
  writeUint32(bytes, 16, 16);
  writeUint16(bytes, 20, 1); // PCM
  writeUint16(bytes, 22, 1); // mono
  writeUint32(bytes, 24, sampleRate);
  writeUint32(bytes, 28, sampleRate * bytesPerSample);
  writeUint16(bytes, 32, bytesPerSample);
  writeUint16(bytes, 34, 16);
  writeAscii(bytes, 36, 'data');
  writeUint32(bytes, 40, dataSize);

  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.round(Math.sin(index / 16) * 9_000);
    writeUint16(bytes, 44 + index * 2, sample < 0 ? sample + 0x1_0000 : sample);
  }
  return bytes;
}

/** Base64 of one byte range, the shape DashScope puts in `output.audio.data`. */
function base64Slice(bytes: Uint8Array, start: number, end: number): string {
  return Buffer.from(bytes.subarray(start, end)).toString('base64');
}

/** One `sentence-synthesis` SSE event carrying one base64 audio slice. */
function audioEvent(bytes: Uint8Array, start: number, end: number): string {
  return JSON.stringify({ output: { type: 'sentence-synthesis', audio: { data: base64Slice(bytes, start, end) } } });
}

/** The opening event, which carries the billed character count. */
function openedEvent(characters: number): string {
  return JSON.stringify({
    request_id: 'req-stream',
    output: { finish_reason: 'null', type: 'sentence-begin', audio: { data: '' } },
    usage: { characters },
  });
}

/** The closing event, mirroring the documented shape (empty data, finish reason `stop`). */
function closingEvent(characters: number): string {
  return JSON.stringify({
    request_id: 'req-stream',
    output: { finish_reason: 'stop', type: 'sentence-end', audio: { data: '' } },
    usage: { characters },
  });
}

/** One captured request, so the criterion can prove the request really went out. */
type CapturedRequest = { url: string; init: RequestInit };

/**
 * A fetch whose body does not close until `release` resolves.
 *
 * `closed` is set at the same moment the stream is closed, so a frame recorded on the downlink can
 * report whether the synthesis had already finished when that frame left. The first event (the
 * opener) and the first audio slice go out immediately; the rest wait for the gate.
 */
function gatedSseFetch(
  firstEvents: readonly string[],
  restEvents: readonly string[],
  closed: { value: boolean },
  release: Promise<void>,
  requests: CapturedRequest[],
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const event of firstEvents) controller.enqueue(encoder.encode(`data: ${event}\n\n`));
        await release;
        for (const event of restEvents) controller.enqueue(encoder.encode(`data: ${event}\n\n`));
        controller.close();
        closed.value = true;
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
}

/** A fetch that answers with every event at once and records the request. */
function sseFetch(events: readonly string[], requests: CapturedRequest[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    const encoder = new TextEncoder();
    const body = events.map((event) => `data: ${event}\n\n`).join('');
    const bytes = encoder.encode(body);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Small slices on purpose: SSE events and their JSON payloads are split across reads,
        // exactly as a real socket delivers them.
        for (let offset = 0; offset < bytes.length; offset += 37) {
          controller.enqueue(bytes.subarray(offset, Math.min(offset + 37, bytes.length)));
        }
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
}

function optionsWith(overrides: Partial<VoiceRealtimeTtsOptions> = {}): VoiceRealtimeTtsOptions {
  return { apiKey: 'test-dashscope-key', voice: 'test-voice', ...overrides };
}

const TEXT = '好的，我来查一下 quay 最活跃的会话';
const TEXT_CHARS = Array.from(TEXT).length;
const SAMPLE_RATE = DEFAULT_VOICE_REALTIME_TTS_SAMPLE_RATE;
/** 24 000 samples is 500 ms of audio — several frames at the 4096-byte slice used below. */
const SAMPLE_COUNT = 12_000;
const FRAME_BYTES = 4096;

// ── the streaming criterion ─────────────────────────────────────────────────────────────────────

test('the first tts_audio frame reaches the downlink while the synthesis stream is still open', async () => {
  const wav = makeWav(SAMPLE_COUNT, SAMPLE_RATE);
  const requests: CapturedRequest[] = [];
  const closed = { value: false };
  const frames: VoiceRealtimeTtsFrame[] = [];

  let releaseFirstFrame!: () => void;
  const firstFrameSeen = new Promise<void>((resolve) => {
    releaseFirstFrame = resolve;
  });

  // The header and a first PCM slice go out immediately; the rest waits for the criterion to see
  // the first audio frame. A producer that awaits the whole WAV before framing deadlocks here.
  const firstEvents = [openedEvent(TEXT_CHARS), audioEvent(wav, 0, 44 + 3_000)];
  const restEvents = [
    audioEvent(wav, 3_044, 3_044 + 5_001),
    audioEvent(wav, 8_045, 8_045 + 7_777),
    audioEvent(wav, 15_822, wav.length),
    closingEvent(TEXT_CHARS),
  ];

  let firstAudioBeforeClose: boolean | null = null;
  const result = await streamVoiceRealtimeSpeech(
    { utteranceId: 'utterance-stream-1', text: TEXT },
    optionsWith({ frameBytes: FRAME_BYTES, fetch: gatedSseFetch(firstEvents, restEvents, closed, firstFrameSeen, requests) }),
    (frame) => {
      frames.push(frame);
      if (frame.type === 'tts_audio' && firstAudioBeforeClose === null) {
        // The reading the AC asks for: closed must still be false AT the first frame.
        firstAudioBeforeClose = closed.value;
        releaseFirstFrame();
      }
    },
  );

  assert.equal(requests.length, 1, 'exactly one synthesis request');
  assert.equal(firstAudioBeforeClose, false, 'the first tts_audio frame left BEFORE the SSE stream closed');

  assert.equal(result.ok, true);
  if (!result.ok) return;

  const audioFrames = frames.filter((frame) => frame.type === 'tts_audio');
  assert.ok(audioFrames.length >= 2, 'the audio was sliced into more than one frame');
  assert.equal(frames.at(-1)?.type, 'tts_done', 'tts_done is the last frame');
  assert.equal(
    frames.filter((frame) => frame.type === 'tts_done').length,
    1,
    'exactly one tts_done frame',
  );
  assert.equal(result.frames, audioFrames.length);

  // Dense, zero-based sequence numbers in emission order.
  assert.deepEqual(
    audioFrames.map((frame) => frame.seq),
    Array.from({ length: audioFrames.length }, (_, index) => index),
  );

  // seq 0 is the RIFF header — the frame a streaming page parses before any PCM is scheduled.
  const firstAudio = audioFrames[0]!;
  const headerBytes = Buffer.from(firstAudio.audio, 'base64');
  assert.equal(headerBytes.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(headerBytes.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.ok(headerBytes.length <= 44, 'seq 0 carries the header, not the whole first slice');

  // Joining every frame reproduces the stand-in's WAV exactly.
  const reassembled = Buffer.concat(audioFrames.map((frame) => Buffer.from(frame.audio, 'base64')));
  assert.deepEqual(new Uint8Array(reassembled), wav);

  // The closing readings are measured from what the stream actually delivered.
  const done = frames.at(-1);
  if (done?.type !== 'tts_done') return;
  assert.equal(done.utteranceId, 'utterance-stream-1');
  assert.equal(done.frames, audioFrames.length);
  assert.equal(done.bytes, wav.length);
  assert.equal(done.characters, TEXT_CHARS);
  assert.notEqual(done.durationMs, null);
  const expectedDurationMs = (SAMPLE_COUNT / SAMPLE_RATE) * 1000;
  assert.ok(Math.abs((done.durationMs ?? 0) - expectedDurationMs) < 0.001);
});

test('a RIFF header split across SSE events is still recognised and reassembles to the same WAV', async () => {
  const wav = makeWav(SAMPLE_COUNT, SAMPLE_RATE);
  const requests: CapturedRequest[] = [];
  const frames: VoiceRealtimeTtsFrame[] = [];

  // The 44-byte header arrives as 12 + 8 + the remaining 24 bytes, then the PCM in one event.
  const events = [
    openedEvent(TEXT_CHARS),
    audioEvent(wav, 0, 12),
    audioEvent(wav, 12, 20),
    audioEvent(wav, 20, 44),
    audioEvent(wav, 44, wav.length),
    closingEvent(TEXT_CHARS),
  ];

  const result = await streamVoiceRealtimeSpeech(
    { utteranceId: 'utterance-stream-split', text: TEXT },
    optionsWith({ frameBytes: FRAME_BYTES, fetch: sseFetch(events, requests) }),
    (frame) => frames.push(frame),
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const audioFrames = frames.filter((frame) => frame.type === 'tts_audio');
  assert.equal(frames.at(-1)?.type, 'tts_done');
  assert.equal(Buffer.from(audioFrames[0]!.audio, 'base64').subarray(0, 4).toString('ascii'), 'RIFF');
  const reassembled = Buffer.concat(audioFrames.map((frame) => Buffer.from(frame.audio, 'base64')));
  assert.deepEqual(new Uint8Array(reassembled), wav);
});

// ── AC error-leg: a refusal before audio is one tts_error, no half utterance ───────────────────

test('error-leg: an SSE error before any audio sends exactly one tts_error and no audio/done', async () => {
  const requests: CapturedRequest[] = [];
  const frames: VoiceRealtimeTtsFrame[] = [];
  const events = [
    openedEvent(TEXT_CHARS),
    JSON.stringify({ code: 'Throttling.RateQuota', message: 'Requests rate limit exceeded' }),
  ];

  const result = await streamVoiceRealtimeSpeech(
    { utteranceId: 'utterance-stream-error', text: TEXT },
    optionsWith({ fetch: sseFetch(events, requests) }),
    (frame) => frames.push(frame),
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'TTS_UPSTREAM_ERROR');
  assert.equal(result.upstreamCode, 'Throttling.RateQuota');

  assert.equal(frames.length, 1, 'exactly one frame: the error');
  const frame = frames[0]!;
  assert.equal(frame.type, 'tts_error');
  if (frame.type !== 'tts_error') return;
  assert.equal(frame.utteranceId, 'utterance-stream-error');
  assert.equal(frame.code, 'TTS_UPSTREAM_ERROR');
  assert.equal(frame.upstreamCode, 'Throttling.RateQuota');
  assert.equal(frames.filter((candidate) => candidate.type === 'tts_audio').length, 0);
  assert.equal(frames.filter((candidate) => candidate.type === 'tts_done').length, 0);
});
