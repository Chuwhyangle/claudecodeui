/**
 * AC-405: the Live Voice TTS leaf — text becomes Qwen3-TTS audio, the audio reaches the browser as
 * ordered downlink frames, and every refusal is a named failure rather than silence.
 *
 * WHAT THIS FILE PINS, one reason per block:
 *
 *   · THE HAPPY PATH IS THE WHOLE CHAIN. One text goes through the shipped request builder to the
 *     documented multimodal-generation endpoint, the stand-in answers with the SSE shape the real
 *     service documents (`output.audio.data` base64 chunks inside `result` events), and the
 *     criterion reads the frames the downlink sink received. The base64 pieces are reassembled and
 *     compared with the bytes the stand-in produced, so a module that forwards only the first
 *     chunk, reorders chunks, or drops one is red.
 *
 *   · "SAME ORDER OF MAGNITUDE" IS MEASURED FROM THE BYTES, NOT ESTIMATED FROM THE TEXT. The
 *     stand-in builds a WAV whose PCM length is exactly 250 ms per input character; the assertion
 *     compares the module's own `durationMs` (read from the returned RIFF header) with that
 *     duration and with a 100–1000 ms-per-character band. A truncated stream would already fail the
 *     byte comparison, and a fabricated duration would fail here.
 *
 *   · A FAKE MODEL NAME FAILS WITH THE SERVICE'S OWN CODE. The stand-in refuses the request with
 *     DashScope's documented error envelope (`{code, message, request_id}`), and the criterion
 *     asserts `TTS_UPSTREAM_ERROR` + `upstreamCode: 'InvalidParameter'`, that the fake model name
 *     reached the request body, that NO `tts_audio`/`tts_done` frame was emitted, and that exactly
 *     one `tts_error` frame carries the refusal. This is the AC's "必失败且错误码上报".
 *
 *   · A 200 WITH NO AUDIO IS NOT SUCCESS. The AC's parenthetical "非静默空音频" is pinned by its own
 *     leg: a stream that closes with `finish_reason: stop` and zero payload bytes reports
 *     `TTS_EMPTY_AUDIO` and sends only an error frame. A module that treated "HTTP 200" as "done"
 *     would hand the page a zero-length utterance and pass a weaker assertion.
 *
 * The remaining legs cover the pre-request refusals (no voice, blank text) and a malformed base64
 * chunk. Each is cheap and each names a distinct way the module could otherwise go quiet.
 *
 * Run with this repo's TS-ESM test runner:
 *
 *     npx tsx --tsconfig server/tsconfig.json --test \
 *       server/modules/voice-realtime/tests/voice-realtime-tts.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

// The registry is entered BEFORE the rule module: its own table reads this provider module's
// exports while it evaluates, so importing the provider first is a TDZ. The same side-effect import
// and the same ordering rule as `voice-realtime-dashscope-transport.test.ts`.
import '../../../../shared/asr/asrRegistry.js';
import { PUBLIC_HOSTNAME } from '../../../../shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.js';
import {
  DEFAULT_VOICE_REALTIME_TTS_BASE_URL,
  DEFAULT_VOICE_REALTIME_TTS_MODEL,
  DEFAULT_VOICE_REALTIME_TTS_SAMPLE_RATE,
  VOICE_REALTIME_TTS_PATH,
  speakVoiceRealtimeText,
  synthesizeVoiceRealtimeSpeech,
  type VoiceRealtimeTtsFrame,
  type VoiceRealtimeTtsOptions,
} from '../voice-realtime-tts.js';

// ── the stand-in upstream ────────────────────────────────────────────────────────────────────────

/** One request the stand-in saw, so the criterion can read the wire instead of trusting the module. */
type CapturedRequest = { url: string; init: RequestInit };

/**
 * A `fetch` that answers with one SSE body and records the request.
 *
 * The body is enqueued in SMALL byte slices rather than as one chunk: the module's SSE reader has to
 * survive an event split across reads (and a multi-byte character split across reads), which is
 * exactly what a real socket does. A reader that assumed one event per read would be green on a
 * single-chunk stand-in and red here.
 */
function sseFetch(events: readonly string[], requests: CapturedRequest[]): typeof fetch {
  const body = events.map((event) => `data: ${event}\n\n`).join('');
  return (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    const encoder = new TextEncoder();
    const bytes = encoder.encode(body);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // 61 is prime and larger than one SSE line's `data: ` prefix, so events and the payload
        // characters inside them are still split across reads without creating tens of thousands
        // of microtask-sized reads.
        for (let offset = 0; offset < bytes.length; offset += 61) {
          controller.enqueue(bytes.subarray(offset, Math.min(offset + 61, bytes.length)));
        }
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
}

/** A `fetch` that answers with one JSON error, recording the request. */
function errorFetch(status: number, document: unknown, requests: CapturedRequest[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(document), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

/** A `fetch` that must never be called; records it if it is. */
function forbiddenFetch(requests: CapturedRequest[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    throw new Error('the criterion expected no request');
  }) as typeof fetch;
}

// ── a real RIFF/WAVE blob with a known duration ─────────────────────────────────────────────────

/** Writes ASCII at `offset`. */
function writeAscii(bytes: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) bytes[offset + index] = text.charCodeAt(index);
}

/** Writes one little-endian unsigned 16-bit integer. */
function writeUint16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

/** Writes one little-endian unsigned 32-bit integer. */
function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

/**
 * A mono PCM16 WAV of exactly `samples / sampleRate` seconds.
 *
 * The sample count — not a nominal duration — is what the module reads back, so the expected
 * duration in the assertions is derived from the same count. The tone makes the payload non-trivial
 * and deterministic without needing a fixture file.
 */
function makeWav(sampleCount: number, sampleRate: number): Uint8Array {
  const channels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = (bitsPerSample / 8) * channels;
  const dataSize = sampleCount * bytesPerSample;
  const bytes = new Uint8Array(44 + dataSize);

  writeAscii(bytes, 0, 'RIFF');
  writeUint32(bytes, 4, 36 + dataSize);
  writeAscii(bytes, 8, 'WAVE');
  writeAscii(bytes, 12, 'fmt ');
  writeUint32(bytes, 16, 16);
  writeUint16(bytes, 20, 1); // PCM
  writeUint16(bytes, 22, channels);
  writeUint32(bytes, 24, sampleRate);
  writeUint32(bytes, 28, sampleRate * bytesPerSample); // byte rate
  writeUint16(bytes, 32, bytesPerSample); // block align
  writeUint16(bytes, 34, bitsPerSample);
  writeAscii(bytes, 36, 'data');
  writeUint32(bytes, 40, dataSize);

  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.round(Math.sin(index / 8) * 8_000);
    writeUint16(bytes, 44 + index * 2, sample < 0 ? sample + 0x1_0000 : sample);
  }
  return bytes;
}

/** Base64 of one byte range, the shape DashScope puts in `output.audio.data`. */
function base64Slice(bytes: Uint8Array, start: number, end: number): string {
  return Buffer.from(bytes.subarray(start, end)).toString('base64');
}

/**
 * The SSE events the stand-in emits for one synthesis.
 *
 * The WAV is cut at IRREGULAR boundaries (7 bytes, then 601, then the rest) so that a client
 * reassembling chunks by a fixed size — or ignoring a chunk that is not a whole sample — cannot
 * accidentally pass. The `sentence-begin` and final events mirror the documented shapes, including
 * the empty `data` the final event carries.
 */
function synthesisEvents(wav: Uint8Array, characters: number): string[] {
  const first = base64Slice(wav, 0, 7);
  const second = base64Slice(wav, 7, 608);
  const third = base64Slice(wav, 608, wav.length);
  return [
    JSON.stringify({
      request_id: 'req-1',
      output: { finish_reason: 'null', type: 'sentence-begin', audio: { data: '' } },
      usage: { characters },
    }),
    JSON.stringify({ output: { type: 'sentence-synthesis', audio: { data: first } } }),
    JSON.stringify({ output: { type: 'sentence-synthesis', audio: { data: second } } }),
    JSON.stringify({ output: { type: 'sentence-synthesis', audio: { data: third } } }),
    JSON.stringify({
      request_id: 'req-1',
      output: { finish_reason: 'stop', type: 'sentence-end', audio: { data: '', url: 'https://example.invalid/x.wav' } },
      usage: { characters },
    }),
  ];
}

// ── shared readings ─────────────────────────────────────────────────────────────────────────────

/** The text the happy path speaks. Chinese characters are ~250 ms each at this module's pace. */
const TEXT = '好的，我来查一下 quay 最活跃的会话';
const TEXT_CHARS = Array.from(TEXT).length;
const SAMPLE_RATE = DEFAULT_VOICE_REALTIME_TTS_SAMPLE_RATE;
const MS_PER_CHAR = 250;
const SAMPLE_COUNT = Math.round((TEXT_CHARS * MS_PER_CHAR * SAMPLE_RATE) / 1000);
const EXPECTED_DURATION_MS = (SAMPLE_COUNT / SAMPLE_RATE) * 1000;

/** A complete option set, so each leg overrides only the field it is about. */
function optionsWith(overrides: Partial<VoiceRealtimeTtsOptions> = {}): VoiceRealtimeTtsOptions {
  return {
    apiKey: 'test-dashscope-key',
    voice: 'test-voice',
    ...overrides,
  };
}

/** The request body of the one captured call, parsed. */
function capturedBody(requests: readonly CapturedRequest[]): Record<string, unknown> {
  assert.equal(requests.length, 1, 'exactly one synthesis request');
  const body = requests[0]!.init.body;
  assert.equal(typeof body, 'string');
  return JSON.parse(body as string) as Record<string, unknown>;
}

// ── AC-140: the base URL has one source ────────────────────────────────────────────────────────

test('AC-140 the TTS base URL is composed from the endpoint rule module, not spelled here', () => {
  assert.equal(
    DEFAULT_VOICE_REALTIME_TTS_BASE_URL,
    `https://${PUBLIC_HOSTNAME}`,
    'the host lives once, in the endpoint rule module; this leaf composes its base URL from it',
  );
  assert.equal(
    DEFAULT_VOICE_REALTIME_TTS_BASE_URL,
    'https://dashscope.aliyuncs.com',
    'the composed value is byte-for-byte the base URL shipped before the single-source fix',
  );
});

// ── AC-405: text → non-empty audio → browser downlink frames ───────────────────────────────────

test('AC-405 text is synthesized into non-empty audio whose frames arrive in order and reassemble exactly', async () => {
  const wav = makeWav(SAMPLE_COUNT, SAMPLE_RATE);
  assert.ok(wav.length > 44, 'the stand-in produced a non-empty WAV');
  const requests: CapturedRequest[] = [];
  const frames: VoiceRealtimeTtsFrame[] = [];

  const result = await speakVoiceRealtimeText(
    { utteranceId: 'utterance-1', text: TEXT },
    optionsWith({ fetch: sseFetch(synthesisEvents(wav, TEXT_CHARS), requests) }),
    (frame) => frames.push(frame),
  );

  // The wire: the documented endpoint, the credential, the SSE opt-in, and the documented body.
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, `${DEFAULT_VOICE_REALTIME_TTS_BASE_URL}${VOICE_REALTIME_TTS_PATH}`);
  assert.equal(requests[0]!.init.method, 'POST');
  const headers = requests[0]!.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer test-dashscope-key');
  assert.equal(headers['X-DashScope-SSE'], 'enable');
  assert.equal(headers['Content-Type'], 'application/json');

  const body = capturedBody(requests);
  assert.equal(body.model, DEFAULT_VOICE_REALTIME_TTS_MODEL);
  const input = body.input as Record<string, unknown>;
  assert.deepEqual(input, {
    text: TEXT,
    voice: 'test-voice',
  });

  // Non-empty audio, and the frame contract around it.
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.bytes > 44, 'the synthesis returned real audio bytes, not an empty payload');
  assert.ok(result.frames >= 1, 'at least one downlink audio frame');
  assert.equal(frames.length, result.frames + 1, 'one done frame after the audio frames');
  assert.equal(result.characters, TEXT_CHARS);

  const audioFrames = frames.filter((frame) => frame.type === 'tts_audio');
  assert.equal(audioFrames.length, result.frames);

  // Reassembly must be byte-for-byte the stand-in's WAV. This is the reading that catches a
  // dropped, duplicated or reordered chunk.
  const reassembled = Buffer.concat(
    audioFrames.map((frame) => {
      assert.equal(frame.utteranceId, 'utterance-1');
      assert.equal(frame.format, 'wav');
      assert.equal(frame.sampleRate, SAMPLE_RATE);
      assert.ok(Buffer.from(frame.audio, 'base64').length <= 16 * 1024, 'each frame respects the byte bound');
      return Buffer.from(frame.audio, 'base64');
    }),
  );
  assert.deepEqual(new Uint8Array(reassembled), wav);

  // Sequence numbers are dense and zero-based, in emission order.
  assert.deepEqual(
    audioFrames.map((frame) => (frame.type === 'tts_audio' ? frame.seq : -1)),
    Array.from({ length: result.frames }, (_, index) => index),
  );

  // "Same order of magnitude": the module read the duration from the audio it delivered, and the
  // reading is in the 100–1000 ms-per-character band for the text that was spoken.
  assert.notEqual(result.durationMs, null);
  assert.ok(Math.abs((result.durationMs ?? 0) - EXPECTED_DURATION_MS) < 0.001);
  const msPerCharacter = (result.durationMs ?? 0) / TEXT_CHARS;
  assert.ok(msPerCharacter >= 100 && msPerCharacter <= 1000, `duration ${result.durationMs}ms for ${TEXT_CHARS} chars`);
  assert.ok(result.durationMs! > 0, 'the audio is not zero-length');

  const done = frames.at(-1);
  assert.equal(done?.type, 'tts_done');
  if (done?.type !== 'tts_done') return;
  assert.equal(done.utteranceId, 'utterance-1');
  assert.equal(done.frames, result.frames);
  assert.equal(done.bytes, result.bytes);
  assert.equal(done.durationMs, result.durationMs);
  assert.equal(done.characters, result.characters);
});

test('AC-405 the synthesis function alone returns the bytes and reads the same duration', async () => {
  const wav = makeWav(SAMPLE_COUNT, SAMPLE_RATE);
  const requests: CapturedRequest[] = [];
  const synthesis = await synthesizeVoiceRealtimeSpeech(
    TEXT,
    optionsWith({ fetch: sseFetch(synthesisEvents(wav, TEXT_CHARS), requests) }),
  );

  assert.equal(synthesis.ok, true);
  if (!synthesis.ok) return;
  assert.deepEqual(synthesis.bytes, wav);
  assert.equal(synthesis.format, 'wav');
  assert.equal(synthesis.sampleRate, SAMPLE_RATE);
  assert.equal(synthesis.characters, TEXT_CHARS);
  assert.ok(Math.abs((synthesis.durationMs ?? 0) - EXPECTED_DURATION_MS) < 0.001);
});

// ── AC-405 false form: a fake model name must fail with a reported code ───────────────────────

test('AC-405 a fake model name fails with the service code, and no audio frame is ever sent', async () => {
  const requests: CapturedRequest[] = [];
  const frames: VoiceRealtimeTtsFrame[] = [];
  const fakeModel = 'qwen3-tts-imaginary';

  const result = await speakVoiceRealtimeText(
    { utteranceId: 'utterance-bad-model', text: TEXT },
    optionsWith({
      model: fakeModel,
      fetch: errorFetch(
        400,
        {
          request_id: 'req-bad',
          code: 'InvalidParameter',
          message: `Model not found: ${fakeModel}`,
        },
        requests,
      ),
    }),
    (frame) => frames.push(frame),
  );

  // The fake name really left the client — otherwise the refusal would prove nothing.
  assert.equal(capturedBody(requests).model, fakeModel);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'TTS_UPSTREAM_ERROR');
  assert.equal(result.upstreamCode, 'InvalidParameter');
  assert.equal(result.httpStatus, 400);
  assert.match(result.message, /not found/i);

  // ONE error frame, NO audio and NO done frame: a refusal can never look like a short utterance.
  assert.equal(frames.length, 1);
  const frame = frames[0]!;
  assert.equal(frame.type, 'tts_error');
  if (frame.type !== 'tts_error') return;
  assert.equal(frame.utteranceId, 'utterance-bad-model');
  assert.equal(frame.code, 'TTS_UPSTREAM_ERROR');
  assert.equal(frame.upstreamCode, 'InvalidParameter');
  assert.equal(frame.httpStatus, 400);
});

test('AC-405 a 200 answer with no audio bytes is TTS_EMPTY_AUDIO, not a silent success', async () => {
  const requests: CapturedRequest[] = [];
  const frames: VoiceRealtimeTtsFrame[] = [];
  const emptyEvents = [
    JSON.stringify({ output: { finish_reason: 'null', type: 'sentence-begin', audio: { data: '' } } }),
    JSON.stringify({ output: { finish_reason: 'stop', type: 'sentence-end', audio: { data: '' } } }),
  ];

  const result = await speakVoiceRealtimeText(
    { utteranceId: 'utterance-empty', text: TEXT },
    optionsWith({ fetch: sseFetch(emptyEvents, requests) }),
    (frame) => frames.push(frame),
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'TTS_EMPTY_AUDIO');
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.type, 'tts_error');
  if (frames[0]!.type !== 'tts_error') return;
  assert.equal(frames[0]!.code, 'TTS_EMPTY_AUDIO');
});

test('AC-405 an error event inside a 200 stream is reported, not parsed as audio', async () => {
  const requests: CapturedRequest[] = [];
  const frames: VoiceRealtimeTtsFrame[] = [];
  const events = [
    JSON.stringify({ output: { type: 'sentence-begin', audio: { data: '' } } }),
    JSON.stringify({ code: 'Throttling.RateQuota', message: 'Requests rate limit exceeded' }),
  ];

  const result = await speakVoiceRealtimeText(
    { utteranceId: 'utterance-stream-error', text: TEXT },
    optionsWith({ fetch: sseFetch(events, requests) }),
    (frame) => frames.push(frame),
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'TTS_UPSTREAM_ERROR');
  assert.equal(result.upstreamCode, 'Throttling.RateQuota');
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.type, 'tts_error');
});

// ── pre-request refusals and a malformed payload ───────────────────────────────────────────────

test('a missing voice is refused before any request is made', async () => {
  const requests: CapturedRequest[] = [];
  const frames: VoiceRealtimeTtsFrame[] = [];
  const result = await speakVoiceRealtimeText(
    { utteranceId: 'utterance-1', text: TEXT },
    optionsWith({ voice: '   ', fetch: forbiddenFetch(requests) }),
    (frame) => frames.push(frame),
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'TTS_NOT_CONFIGURED');
  assert.equal(requests.length, 0, 'an unconfigured call reaches no network');
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.type, 'tts_error');
});

test('blank text is refused before any request is made', async () => {
  const requests: CapturedRequest[] = [];
  const frames: VoiceRealtimeTtsFrame[] = [];
  const result = await speakVoiceRealtimeText(
    { utteranceId: 'utterance-1', text: '   ' },
    optionsWith({ fetch: forbiddenFetch(requests) }),
    (frame) => frames.push(frame),
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'TTS_EMPTY_TEXT');
  assert.equal(requests.length, 0);
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.type, 'tts_error');
});

test('a malformed base64 chunk fails the synthesis instead of delivering shortened audio', async () => {
  const requests: CapturedRequest[] = [];
  const frames: VoiceRealtimeTtsFrame[] = [];
  const events = [
    JSON.stringify({ output: { type: 'sentence-synthesis', audio: { data: 'not*base64*data' } } }),
    JSON.stringify({ output: { finish_reason: 'stop', audio: { data: '' } } }),
  ];

  const result = await speakVoiceRealtimeText(
    { utteranceId: 'utterance-malformed', text: TEXT },
    optionsWith({ fetch: sseFetch(events, requests) }),
    (frame) => frames.push(frame),
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'TTS_MALFORMED_RESPONSE');
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.type, 'tts_error');
});
