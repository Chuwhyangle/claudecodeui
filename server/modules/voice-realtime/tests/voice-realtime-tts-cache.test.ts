/**
 * The per-connection announce TTS cache: pre-synthesis, hits, misses, de-duplication and fallback.
 *
 * WHAT THIS FILE PINS, one block per AC leg:
 *
 *   · HIT — after `warm()`, `speak()` of a warmed phrase issues ZERO `fetch` calls, and the frames it
 *     emits are frame-for-frame identical to `speakVoiceRealtimeText()` synthesizing the same bytes.
 *     The comparison is on the whole frame sequence (including `seq` and `tts_done` readings), so a
 *     cache that re-framed cached audio differently would be red.
 *   · MISS — a cold `speak()` issues exactly one request.
 *   · DEDUPE — two concurrent `speak()` calls for one text share one request.
 *   · FAILURE — a failed synthesis is never cached: the next call dials again.
 *   · EVICTION — beyond `maxEntries`, the OLDEST entry is discarded first.
 *   · WARM — every configured phrase is pre-synthesized once, then every phrase speaks with no
 *     further request and produces `tts_audio` + `tts_done`; a phrase whose warm-up failed falls
 *     back to on-the-spot synthesis and still produces audio.
 *   · WARM TRANSIENT — a phrase whose first warm-up attempt fails is retried once, logged as
 *     `tts cache warm failed … attempt=1` then `tts cache warm recovered … attempt=2`, and is a hit.
 *   · WARM PERMANENT — a phrase that fails both attempts is logged twice, never cached, and its
 *     next `speak()` falls back to exactly one on-the-spot synthesis.
 *
 * The stand-in `fetch` speaks the same SSE wire the real service documents and records every
 * request, so "the cache served this" is read from the network rather than from the cache's own
 * bookkeeping.
 *
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/voice-realtime/tests/voice-realtime-tts-cache.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ANNOUNCE_PHRASES } from '../voice-realtime-announce-phrases.js';
import {
  createVoiceRealtimeTtsCache,
  type VoiceRealtimeTtsCache,
} from '../voice-realtime-tts-cache.js';
import {
  speakVoiceRealtimeText,
  type VoiceRealtimeTtsFrame,
  type VoiceRealtimeTtsOptions,
} from '../voice-realtime-tts.js';

// ── a stand-in upstream ─────────────────────────────────────────────────────────────────────────

type CapturedRequest = { url: string; init: RequestInit };

/** One mono PCM16 WAV of `sampleCount` samples at `sampleRate`. */
function makeWav(sampleCount: number, sampleRate = 24_000): Uint8Array {
  const dataBytes = sampleCount * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const writeAscii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) bytes[offset + index] = text.charCodeAt(index);
  };
  const writeUint32 = (offset: number, value: number): void => {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >>> 8) & 0xff;
    bytes[offset + 2] = (value >>> 16) & 0xff;
    bytes[offset + 3] = (value >>> 24) & 0xff;
  };
  const writeUint16 = (offset: number, value: number): void => {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >>> 8) & 0xff;
  };
  writeAscii(0, 'RIFF');
  writeUint32(4, 36 + dataBytes);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  writeUint32(16, 16);
  writeUint16(20, 1);
  writeUint16(22, 1);
  writeUint32(24, sampleRate);
  writeUint32(28, sampleRate * 2);
  writeUint16(32, 2);
  writeUint16(34, 16);
  writeAscii(36, 'data');
  writeUint32(40, dataBytes);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.round(Math.sin(index / 8) * 8_000);
    writeUint16(44 + index * 2, sample < 0 ? sample + 0x1_0000 : sample);
  }
  return bytes;
}

const WAV = makeWav(18_000);

/** The SSE body one synthesis answers with, cut at irregular boundaries. */
function sseBody(wav: Uint8Array, characters: number): string {
  const slice = (start: number, end: number): string =>
    Buffer.from(wav.subarray(start, end)).toString('base64');
  return [
    JSON.stringify({
      output: { finish_reason: 'null', type: 'sentence-begin', audio: { data: '' } },
      usage: { characters },
    }),
    JSON.stringify({ output: { type: 'sentence-synthesis', audio: { data: slice(0, 7) } } }),
    JSON.stringify({ output: { type: 'sentence-synthesis', audio: { data: slice(7, 608) } } }),
    JSON.stringify({ output: { type: 'sentence-synthesis', audio: { data: slice(608, wav.length) } } }),
    JSON.stringify({ output: { finish_reason: 'stop', type: 'sentence-end', audio: { data: '' } } }),
  ]
    .map((event) => `data: ${event}\n\n`)
    .join('');
}

/** The text of the synthesis request, read from the body the stand-in received. */
function requestText(init: RequestInit): string {
  if (typeof init.body !== 'string') return '';
  try {
    const body = JSON.parse(init.body) as { input?: { text?: unknown } };
    return typeof body.input?.text === 'string' ? body.input.text : '';
  } catch {
    return '';
  }
}

/** A `fetch` that answers one synthesis, records the request, and counts. */
function countingFetch(requests: CapturedRequest[], delayMs = 0): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const text = requestText(init ?? {});
    return new Response(sseBody(WAV, text.length), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof fetch;
}

/** A `fetch` that refuses every synthesis with the documented DashScope error envelope. */
function failingFetch(requests: CapturedRequest[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ code: 'InvalidParameter', message: 'stand-in refusal' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

/**
 * A `fetch` that refuses one exact text a bounded number of times and answers it normally after
 * that (every other text always answers normally). The budget is what distinguishes a transient
 * warm-up failure ({@link 1} refusal: the retry succeeds) from a permanent one ({@link 2} refusals:
 * both warm-up attempts fail, and the later on-the-spot `speak()` succeeds).
 */
function failTextTimesFetch(requests: CapturedRequest[], failingText: string, failures: number): typeof fetch {
  const fallback = countingFetch(requests);
  let remainingFailures = failures;
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (remainingFailures > 0 && requestText(init ?? {}) === failingText) {
      remainingFailures -= 1;
      requests.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ code: 'InvalidParameter', message: 'warm-up refusal' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    return fallback(url, init);
  }) as typeof fetch;
}

/** How many requests the stand-in received for one exact text. */
function requestCount(requests: CapturedRequest[], text: string): number {
  return requests.filter((request) => requestText(request.init) === text).length;
}

// ── shared readings ─────────────────────────────────────────────────────────────────────────────

function optionsWith(overrides: Partial<VoiceRealtimeTtsOptions> = {}): VoiceRealtimeTtsOptions {
  return { apiKey: 'test-dashscope-key', voice: 'test-voice', ...overrides };
}

function cacheWith(input: {
  fetch: typeof fetch;
  phrases?: readonly string[];
  maxEntries?: number;
  log?: (line: string) => void;
}): VoiceRealtimeTtsCache {
  return createVoiceRealtimeTtsCache({
    options: optionsWith({ fetch: input.fetch }),
    phrases: input.phrases ?? ANNOUNCE_PHRASES,
    ...(input.maxEntries === undefined ? {} : { maxEntries: input.maxEntries }),
    ...(input.log === undefined ? {} : { log: input.log }),
  });
}

/** Collects frames from one `speak()` call. */
async function speak(
  cache: VoiceRealtimeTtsCache,
  utteranceId: string,
  text: string,
): Promise<{ frames: VoiceRealtimeTtsFrame[]; result: Awaited<ReturnType<VoiceRealtimeTtsCache['speak']>> }> {
  const frames: VoiceRealtimeTtsFrame[] = [];
  const result = await cache.speak({ utteranceId, text }, (frame) => frames.push(frame));
  return { frames, result };
}

/** The byte sequence a frame list reassembles to. */
const assembled = (frames: VoiceRealtimeTtsFrame[]): Buffer =>
  Buffer.concat(
    frames
      .filter((frame): frame is Extract<VoiceRealtimeTtsFrame, { type: 'tts_audio' }> => frame.type === 'tts_audio')
      .map((frame) => Buffer.from(frame.audio, 'base64')),
  );

// ── HIT: warm, then zero requests and the same frames as a direct synthesis ────────────────────

test('cache hit: a warmed phrase speaks with zero fetch calls and frame-for-frame equals direct synthesis', async () => {
  const phrase = ANNOUNCE_PHRASES[0]!;
  const warmRequests: CapturedRequest[] = [];
  const cache = cacheWith({ fetch: countingFetch(warmRequests), phrases: [phrase] });

  await cache.warm();
  assert.equal(warmRequests.length, 1, 'warm-up synthesized the phrase once');

  // Reset the count after warm-up: the reading that matters is what `speak` itself dials.
  warmRequests.length = 0;
  const hit = await speak(cache, 'announce-0', phrase);
  assert.equal(warmRequests.length, 0, 'a hit must not dial the TTS service');

  const baselineFrames: VoiceRealtimeTtsFrame[] = [];
  const baseline = await speakVoiceRealtimeText(
    { utteranceId: 'announce-0', text: phrase },
    optionsWith({ fetch: countingFetch([]) }),
    (frame) => baselineFrames.push(frame),
  );

  assert.equal(hit.result.ok, true);
  assert.deepEqual(hit.frames, baselineFrames, 'cached frames must equal the direct synthesis frame sequence');
  assert.equal(baseline.ok, true);
});

// ── MISS: exactly one request ───────────────────────────────────────────────────────────────────

test('cache miss: a cold phrase is synthesized with exactly one fetch and then cached', async () => {
  const requests: CapturedRequest[] = [];
  const cache = cacheWith({ fetch: countingFetch(requests), phrases: [ANNOUNCE_PHRASES[0]!] });

  const first = await speak(cache, 'announce-0', ANNOUNCE_PHRASES[0]!);
  assert.equal(requests.length, 1, 'a miss dials once');
  assert.equal(first.result.ok, true);
  assert.deepEqual(assembled(first.frames), Buffer.from(WAV), 'the miss path delivers the synthesized bytes');

  // The miss stored the bytes: the next call is a hit.
  const second = await speak(cache, 'announce-1', ANNOUNCE_PHRASES[0]!);
  assert.equal(requests.length, 1, 'the second call is served from the cache');
  assert.equal(second.frames.at(-1)?.type, 'tts_done');
});

// ── DEDUPE: two concurrent requests share one synthesis ───────────────────────────────────────

test('cache dedupe: two concurrent requests for one text issue exactly one fetch', async () => {
  const requests: CapturedRequest[] = [];
  const cache = cacheWith({ fetch: countingFetch(requests, 20), phrases: [] });
  const text = ANNOUNCE_PHRASES[1]!;

  const [first, second] = await Promise.all([
    speak(cache, 'announce-0', text),
    speak(cache, 'announce-1', text),
  ]);

  assert.equal(requests.length, 1, 'the in-flight map must collapse two concurrent misses into one request');
  assert.equal(first.result.ok, true);
  assert.equal(second.result.ok, true);
  assert.deepEqual(assembled(first.frames), Buffer.from(WAV));
  assert.deepEqual(assembled(second.frames), Buffer.from(WAV));
});

// ── FAILURE: never cached ──────────────────────────────────────────────────────────────────────

test('cache failure: a failed synthesis is not stored, so the next call dials again', async () => {
  const requests: CapturedRequest[] = [];
  const cache = cacheWith({ fetch: failingFetch(requests), phrases: [] });
  const text = ANNOUNCE_PHRASES[2]!;

  const first = await speak(cache, 'announce-0', text);
  assert.equal(requests.length, 1);
  assert.equal(first.result.ok, false);
  assert.equal(first.frames.length, 1);
  assert.equal(first.frames[0]!.type, 'tts_error');

  const second = await speak(cache, 'announce-1', text);
  assert.equal(requests.length, 2, 'a failed synthesis must not be cached');
  assert.equal(second.result.ok, false);
  assert.equal(second.frames[0]!.type, 'tts_error');
});

// ── EVICTION: oldest first ────────────────────────────────────────────────────────────────────

test('cache eviction: beyond maxEntries the oldest entry is discarded first', async () => {
  const requests: CapturedRequest[] = [];
  const cache = cacheWith({ fetch: countingFetch(requests), phrases: [], maxEntries: 2 });
  const texts = [ANNOUNCE_PHRASES[0]!, ANNOUNCE_PHRASES[1]!, ANNOUNCE_PHRASES[2]!];

  for (const [index, text] of texts.entries()) {
    await speak(cache, `announce-${index}`, text);
  }
  assert.equal(requests.length, 3, 'three distinct texts, three syntheses');

  // t1 was inserted first, so it is the oldest and must have been evicted by t3.
  await speak(cache, 'announce-3', texts[0]!);
  assert.equal(requests.length, 4, 'the oldest entry was evicted and re-synthesized');

  // t3 is still resident: speaking it must not dial again.
  await speak(cache, 'announce-4', texts[2]!);
  assert.equal(requests.length, 4, 'the newest entry was retained');
});

// ── WARM: every phrase pre-synthesized, then no requests; a failed one falls back ──────────────

test('cache warm: every phrase is pre-synthesized, then all speak with no request and produce audio', async () => {
  const requests: CapturedRequest[] = [];
  const log: string[] = [];
  const cache = cacheWith({ fetch: countingFetch(requests), log: (line) => log.push(line) });

  await cache.warm();
  assert.equal(requests.length, ANNOUNCE_PHRASES.length, 'warm-up dials once per phrase');
  assert.equal(
    log.filter((line) => line.includes('tts cache warm failed')).length,
    0,
    'a fully successful warm-up logs no failure',
  );

  requests.length = 0;
  for (const [index, phrase] of ANNOUNCE_PHRASES.entries()) {
    const { frames, result } = await speak(cache, `announce-${index}`, phrase);
    assert.equal(result.ok, true, `warmed phrase ${index} must speak`);
    assert.ok(frames.some((frame) => frame.type === 'tts_audio'), `phrase ${index} produced audio`);
    assert.equal(frames.at(-1)?.type, 'tts_done', `phrase ${index} closed with tts_done`);
  }
  assert.equal(requests.length, 0, 'every warmed phrase is served without a request');
});

// ── WARM TRANSIENT: one failed attempt, one retry, then a hit ─────────────────────────────────

test('cache warm transient: a phrase that fails once is retried, logged as recovered, and then hits', async () => {
  const phrase = ANNOUNCE_PHRASES[1]!;
  const requests: CapturedRequest[] = [];
  const log: string[] = [];
  const cache = cacheWith({
    fetch: failTextTimesFetch(requests, phrase, 1),
    log: (line) => log.push(line),
  });

  await cache.warm();

  assert.equal(requestCount(requests, phrase), 2, 'the transient phrase was attempted twice');
  const failures = log.filter(
    (line) => line.includes('tts cache warm failed') && line.includes(`text=${phrase}`),
  );
  assert.equal(failures.length, 1, 'exactly one failed attempt is logged');
  assert.match(failures[0]!, /attempt=1/, 'the failure is the first attempt');
  const recovered = log.filter(
    (line) => line.includes('tts cache warm recovered') && line.includes(`text=${phrase}`),
  );
  assert.equal(recovered.length, 1, 'the successful retry is logged');
  assert.match(recovered[0]!, /attempt=2/, 'the recovery is the second attempt');

  const before = requestCount(requests, phrase);
  const { frames, result } = await speak(cache, 'announce-1', phrase);
  assert.equal(result.ok, true);
  assert.ok(frames.some((frame) => frame.type === 'tts_audio'));
  assert.equal(requestCount(requests, phrase), before, 'the recovered phrase is served from the cache');
  assert.ok(
    log.includes(`tts cache hit text=${phrase} chars=${phrase.trim().length}`),
    'the speak after a recovered warm-up is a hit',
  );
});

// ── WARM PERMANENT: both attempts fail, never cached, the speak falls back ────────────────────

test('cache warm permanent: two failed attempts are logged, nothing is cached, and speak falls back', async () => {
  const phrase = ANNOUNCE_PHRASES[1]!;
  const requests: CapturedRequest[] = [];
  const log: string[] = [];
  const cache = cacheWith({
    fetch: failTextTimesFetch(requests, phrase, 2),
    log: (line) => log.push(line),
  });

  await cache.warm();

  const failures = log.filter(
    (line) => line.includes('tts cache warm failed') && line.includes(`text=${phrase}`),
  );
  assert.equal(failures.length, 2, 'both attempts are logged');
  assert.match(failures[0]!, /attempt=1/);
  assert.match(failures[1]!, /attempt=2/);
  assert.equal(
    log.filter((line) => line.includes('tts cache warm recovered')).length,
    0,
    'a permanent failure never logs a recovery',
  );
  assert.equal(requestCount(requests, phrase), 2, 'the bounded retry stops after two attempts');

  const { frames, result } = await speak(cache, 'announce-1', phrase);
  assert.equal(requestCount(requests, phrase), 3, 'the miss dials on the spot exactly once');
  assert.equal(result.ok, true);
  assert.ok(frames.some((frame) => frame.type === 'tts_audio'), 'the fallback still produces audio');
  assert.equal(frames.at(-1)?.type, 'tts_done');
});

test('cache warm failure: the failed phrase falls back to on-the-spot synthesis and still speaks', async () => {
  const failingText = ANNOUNCE_PHRASES[1]!;
  const requests: CapturedRequest[] = [];
  // A permanent failure: with the bounded warm retry, the phrase needs TWO refusals to stay
  // uncached (the first attempt plus its retry).
  const cache = cacheWith({ fetch: failTextTimesFetch(requests, failingText, 2) });

  await cache.warm();
  assert.equal(
    requests.length,
    ANNOUNCE_PHRASES.length + 1,
    'warm-up attempted every phrase, and the failed one was retried once',
  );

  requests.length = 0;
  const warmed = await speak(cache, 'announce-0', ANNOUNCE_PHRASES[0]!);
  assert.equal(requests.length, 0, 'a successful warm-up phrase is a hit');

  const fallback = await speak(cache, 'announce-1', failingText);
  assert.equal(requests.length, 1, 'the failed phrase is synthesized on the spot');
  assert.equal(fallback.result.ok, true, 'the fallback path still produces audio');
  assert.ok(fallback.frames.some((frame) => frame.type === 'tts_audio'));
  assert.equal(fallback.frames.at(-1)?.type, 'tts_done');
  assert.equal(warmed.result.ok, true);
});
