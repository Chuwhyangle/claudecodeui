/**
 * The client ASR model's download and cache, judged against a host this file owns end to end.
 *
 * WHAT IS BEING PINNED, AND WHY EACH READING MATTERS. The model is 239 MB, so the cache's promises are
 * the difference between a usable feature and one nobody waits for twice:
 *   - a valid cache hit makes ZERO requests, which is what the cache exists for;
 *   - a download that is truncated or does not match its pinned sha256 is NEVER written, which is the
 *     ordering defect the probe left behind (`docs/experiments/2026-10-06-voice-client-asr-probe.md`
 *     §5 called `cache.put` before validating) and the one rule this file must not regress;
 *   - a cache ENTRY that no longer matches is discarded and refetched rather than trusted;
 *   - a host with no Cache API, or one that refuses the write, still yields a working model plus a
 *     user-visible sentence — never a silent "it will download again every visit";
 *   - progress readings are cumulative, so they never go backwards.
 * Each of those is a case below, and each asserts the negative as hard as the positive: the
 * zero-request case fails loudly if `fetch` is reached at all, and the rejection cases assert
 * `cache.put` was called ZERO times rather than merely that a throw happened.
 *
 * THE DIGEST IS A STAND-IN, DELIBERATELY. `crypto.subtle` is not what these cases are about — the
 * CONTRACT around the hash is — so the injected `sha256Hex` reads the buffer's first byte and pads it
 * to sha256's width. That makes "this buffer hashes to the pinned value" exactly controllable and
 * collision-free by construction, so a case that means to test a hash MISMATCH cannot accidentally
 * pass because two real digests collided.
 */

import { describe, expect, it } from 'vitest';

import {
  DEGRADED_CACHE_WRITE_FAILED,
  DEGRADED_NO_CACHE_API,
  VOICE_CLIENT_MODEL_CACHE_KEY,
  clearVoiceClientModel,
  loadVoiceModel,
  type VoiceClientModelSpec,
  type VoiceModelCacheEnv,
  type VoiceModelCacheStore,
} from '@/shared/voiceModelCache';

/** The whole model, in miniature: 512 bytes whose first byte is the tag the digest reads. */
const MODEL_BYTES = 512;
/** The first byte every valid copy of this model starts with — the stand-in for its sha256. */
const MODEL_TAG = 0x2a;

/** A fresh, valid copy of the model. New every call, so a case cannot mutate another's fixture. */
function modelBytes(): Uint8Array {
  const bytes = new Uint8Array(MODEL_BYTES).fill(0x01);
  bytes[0] = MODEL_TAG;
  return bytes;
}

/**
 * The same bytes as a plain `ArrayBuffer`, which is the shape the cache store and the spec deal in.
 *
 * The assertion is narrowing rather than a claim: `Uint8Array.buffer` is typed `ArrayBufferLike`
 * (an `ArrayBuffer` or a `SharedArrayBuffer`), and a buffer built above is never the shared kind.
 */
function modelBuffer(): ArrayBuffer {
  return modelBytes().buffer as ArrayBuffer;
}

/** The digest the spec pins: the first byte, hex, padded to sha256's 64 characters. */
async function tagSha256(bytes: ArrayBuffer): Promise<string> {
  return new Uint8Array(bytes)[0].toString(16).padStart(64, '0');
}

const SPEC: VoiceClientModelSpec = {
  url: 'https://models.example/sensevoice-small.int8.onnx',
  sha256: MODEL_TAG.toString(16).padStart(64, '0'),
  bytes: MODEL_BYTES,
  buildId: 'ort-web 1.30.0 | sensevoice-small-int8-2024-07-17 | probe-v1 | sha256:c71f0ce00bec95b0',
};

/** A `Response` whose body arrives chunk by chunk, so progress is observable. */
function streamedResponse(chunks: Uint8Array[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(body);
}

type HarnessOptions = {
  /** The entry already in the cache, or absent. */
  cached?: ArrayBuffer | null;
  /** What the network answers with; the default is a complete, valid model in one chunk. */
  respond?: (url: string) => Response;
  /** Whether the host has a Cache API at all. */
  cachesAvailable?: boolean;
  /** Whether the cache refuses writes, as it does when the storage quota is exhausted. */
  putThrows?: boolean;
};

type Harness = {
  env: VoiceModelCacheEnv;
  entries: Map<string, ArrayBuffer>;
  counters: { fetch: string[]; put: number; delete: number; persist: number };
};

/** Builds a complete fake host: the cache, the network and the counters every case reads. */
function makeHarness(options: HarnessOptions = {}): Harness {
  const {
    cached = null,
    respond = () => streamedResponse([modelBytes()]),
    cachesAvailable = true,
    putThrows = false,
  } = options;

  const entries = new Map<string, ArrayBuffer>();
  if (cached !== null) entries.set(VOICE_CLIENT_MODEL_CACHE_KEY, cached);
  const counters = { fetch: [] as string[], put: 0, delete: 0, persist: 0 };

  const store: VoiceModelCacheStore = {
    async match(request) {
      const hit = entries.get(request);
      // A fresh buffer per read, as the real Cache hands back: a caller that mutated what it got
      // must not be able to corrupt the stored entry.
      return hit === undefined ? undefined : { arrayBuffer: async () => hit.slice(0) };
    },
    async put(request, response) {
      counters.put += 1;
      if (putThrows) throw new Error('QuotaExceededError');
      entries.set(request, await response.arrayBuffer());
    },
    async delete(request) {
      counters.delete += 1;
      return entries.delete(request);
    },
  };

  const fetchImpl: typeof fetch = async (input) => {
    counters.fetch.push(String(input));
    return respond(String(input));
  };

  const env: VoiceModelCacheEnv = {
    fetchImpl,
    cachesImpl: cachesAvailable ? { open: async () => store } : null,
    sha256Hex: tagSha256,
    persist: async () => {
      counters.persist += 1;
      return true;
    },
  };

  return { env, entries, counters };
}

describe('the client ASR model cache', () => {
  it('serves a valid cache hit without making a single request', async () => {
    const harness = makeHarness({
      cached: modelBuffer(),
      respond: () => {
        throw new Error('a valid cache hit must never reach the network');
      },
    });

    const load = await loadVoiceModel({ spec: SPEC, env: harness.env });

    expect(harness.counters.fetch).toEqual([]);
    expect(load.source).toBe('cache');
    expect(load.degraded).toBeNull();
    expect(new Uint8Array(load.modelBytes)).toEqual(modelBytes());
    expect(harness.counters.put).toBe(0);
  });

  it('never caches a truncated download', async () => {
    const truncated = modelBytes().subarray(0, 100);
    const harness = makeHarness({ respond: () => streamedResponse([truncated]) });

    await expect(loadVoiceModel({ spec: SPEC, env: harness.env })).rejects.toThrow(/expected 512/);

    // The defect this port fixes: the write must not have happened before the length was checked.
    expect(harness.counters.put).toBe(0);
    expect(harness.entries.size).toBe(0);
    expect(harness.counters.persist).toBe(0);
  });

  it('never caches a download whose hash does not match', async () => {
    const corrupt = modelBytes();
    corrupt[0] = 0x2b; // the right length, the wrong content — only the hash can catch this.

    const harness = makeHarness({ respond: () => streamedResponse([corrupt]) });

    await expect(loadVoiceModel({ spec: SPEC, env: harness.env })).rejects.toThrow(/sha256/);

    expect(harness.counters.put).toBe(0);
    expect(harness.entries.size).toBe(0);
  });

  it('discards a cache entry that no longer matches and downloads it again', async () => {
    const corrupt = modelBytes();
    corrupt[0] = 0x2b;
    const harness = makeHarness({
      cached: corrupt.buffer as ArrayBuffer,
      respond: () => streamedResponse([modelBytes()]),
    });

    const load = await loadVoiceModel({ spec: SPEC, env: harness.env });

    expect(harness.counters.delete).toBe(1);
    expect(harness.counters.fetch).toEqual([SPEC.url]);
    expect(load.source).toBe('network');
    expect(load.degraded).toBeNull();
    // The bad entry is gone and the good bytes took its place.
    const stored = harness.entries.get(VOICE_CLIENT_MODEL_CACHE_KEY);
    expect(stored).toBeDefined();
    expect(new Uint8Array(stored as ArrayBuffer)).toEqual(modelBytes());
  });

  it('stays usable, and says so, when the host has no Cache API', async () => {
    const harness = makeHarness({
      cachesAvailable: false,
      respond: () => streamedResponse([modelBytes()]),
    });

    const load = await loadVoiceModel({ spec: SPEC, env: harness.env });

    expect(load.source).toBe('network');
    expect(load.degraded).toBe(DEGRADED_NO_CACHE_API);
    // The notice is user-visible prose, not an error code: it has to name the consequence.
    expect(load.degraded).toMatch(/downloaded again next time/);
    expect(new Uint8Array(load.modelBytes)).toEqual(modelBytes());
    expect(harness.counters.persist).toBe(1);
  });

  it('stays usable, and says so, when the cache refuses the write', async () => {
    const harness = makeHarness({
      putThrows: true,
      respond: () => streamedResponse([modelBytes()]),
    });

    const load = await loadVoiceModel({ spec: SPEC, env: harness.env });

    expect(load.degraded).toBe(DEGRADED_CACHE_WRITE_FAILED);
    expect(harness.counters.put).toBe(1);
    expect(new Uint8Array(load.modelBytes)).toEqual(modelBytes());
  });

  it('reports progress that never goes backwards', async () => {
    const full = modelBytes();
    const chunks = [full.subarray(0, 40), full.subarray(40, 41), full.subarray(41, 300), full.subarray(300)];
    const harness = makeHarness({ respond: () => streamedResponse(chunks) });
    const readings: number[] = [];

    await loadVoiceModel({
      spec: SPEC,
      env: harness.env,
      onProgress: (progress) => {
        readings.push(progress.receivedBytes);
        expect(progress.totalBytes).toBe(SPEC.bytes);
        expect(progress.receivedBytes).toBeLessThanOrEqual(SPEC.bytes);
      },
    });

    expect(readings).toHaveLength(chunks.length);
    for (let i = 1; i < readings.length; i++) {
      expect(readings[i]).toBeGreaterThanOrEqual(readings[i - 1]);
    }
    // Every byte is accounted for, so the last reading is the whole file rather than a partial count.
    expect(readings[readings.length - 1]).toBe(SPEC.bytes);
  });

  it('clears the cached model on request, and is a no-op without a cache', async () => {
    const harness = makeHarness({ cached: modelBuffer() });
    expect(harness.entries.size).toBe(1);

    await clearVoiceClientModel(harness.env);

    expect(harness.entries.size).toBe(0);
    expect(harness.counters.delete).toBe(1);

    const bare = makeHarness({ cachesAvailable: false });
    await expect(clearVoiceClientModel(bare.env)).resolves.toBeUndefined();
  });
});
