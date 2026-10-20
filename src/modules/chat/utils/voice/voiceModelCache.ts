/**
 * The browser-local ASR model's download, hash validation and persistent cache.
 *
 * WHY THIS IS ITS OWN MODULE. The model is 239 233 841 B and, on the slow link the probe measured,
 * takes 8–10 minutes the first time (`docs/experiments/2026-10-06-voice-client-asr-probe.md` §10).
 * Re-downloading it on every page load would make the client path unusable, so caching is a hard
 * requirement of this feature rather than an optimisation — and the cache has a defect the probe
 * left behind that must not be carried into the product: the probe called `cache.put` BEFORE
 * validating the hash, so an interrupted or corrupted download left a broken file in the cache. This
 * module validates first and caches second, which is the one ordering rule the file exists to keep.
 *
 * THE ENVIRONMENT IS INJECTED. `fetch`, `caches`, `crypto.subtle` and `navigator.storage` are all
 * parameters, not globals, so every branch — a cache hit with zero requests, a truncated download
 * that must not be cached, a corrupted cache entry that is discarded and refetched, and a
 * `Cache`/quota failure that degrades to "usable this session, re-download next time" — is reachable
 * in a unit test with no browser and no network. The real implementations are supplied by the worker
 * (`@/modules/chat/audio/voiceClientAsrWorker`), which runs where those globals exist.
 *
 * DEGRADATION IS NEVER SILENT. Every way the cache can fail to keep the model this session returns a
 * user-visible sentence in `VoiceModelLoad.degraded`; the alternative — a model that quietly
 * re-downloads every visit — is the exact cost this module is here to remove, so the user is told
 * rather than left to notice.
 */

/** The slice of the `Cache` API this module uses; the DOM `Cache` satisfies it structurally. */
export type VoiceModelCacheStore = {
  match(request: string): Promise<VoiceModelCacheResponse | undefined>;
  put(request: string, response: Response): Promise<void>;
  delete(request: string): Promise<boolean>;
};

/** The slice of a cached entry this module reads. */
export type VoiceModelCacheResponse = {
  arrayBuffer(): Promise<ArrayBuffer>;
};

/** The slice of the `CacheStorage` API this module uses; the DOM `CacheStorage` satisfies it. */
export type VoiceModelCacheStorage = {
  open(name: string): Promise<VoiceModelCacheStore>;
};

/**
 * Everything the cache module needs from its host, injected.
 *
 * `sha256Hex` is a function rather than a call to `crypto.subtle` here so a test can drive the
 * hash-mismatch branches deterministically; `subtleSha256Hex` below is the browser implementation
 * the worker passes.
 */
export type VoiceModelCacheEnv = {
  fetchImpl: typeof fetch;
  /** The Cache API, or `null` where it does not exist (an insecure context, a locked-down profile). */
  cachesImpl: VoiceModelCacheStorage | null;
  /** The lowercase hex sha256 of a whole buffer. */
  sha256Hex: (bytes: ArrayBuffer) => Promise<string>;
  /** Requests durable storage; best-effort, so its answer is not read. */
  persist: () => Promise<boolean>;
};

/** The model to fetch, and the facts the download is verified against. */
export type VoiceClientModelSpec = {
  /** Where the weights are fetched from. Never part of the app bundle (S1 requirement 6). */
  url: string;
  /** The sha256 of the complete file, checked before anything is cached and again on every read. */
  sha256: string;
  /** The exact byte length; anything else is a truncated or corrupted download. */
  bytes: number;
  /** The build identity recorded with every recognition this model produces. */
  buildId: string;
};

/** One progress reading, in the units the UI shows. */
export type VoiceModelProgress = {
  /** Bytes received so far; never decreases across a download's readings. */
  receivedBytes: number;
  /** The expected total, from the spec. */
  totalBytes: number;
  /** Average bytes per second over the download so far, or 0 before the first byte lands. */
  bytesPerSec: number;
  /** Milliseconds left at that average, or null while the rate is still unknown. */
  remainingMs: number | null;
};

/** What a completed load produced, and whether it could be kept. */
export type VoiceModelLoad = {
  modelBytes: ArrayBuffer;
  source: 'cache' | 'network';
  /** A user-visible sentence when the model could not be cached, or null when it was. */
  degraded: string | null;
};

/** The options one load takes. */
export type VoiceModelLoadOptions = {
  spec: VoiceClientModelSpec;
  env: VoiceModelCacheEnv;
  onProgress?: (progress: VoiceModelProgress) => void;
};

/** The one cache bucket the model lives in. A version in the name lets a future model key separately. */
export const VOICE_CLIENT_MODEL_CACHE_NAME = 'voice-client-asr-model-v1';

/** The single entry's key inside that bucket. */
export const VOICE_CLIENT_MODEL_CACHE_KEY = '/voice-client-asr/model.int8.onnx';

/** Shown when the Cache API is absent: the model works now, but the next visit downloads it again. */
export const DEGRADED_NO_CACHE_API =
  'This browser cannot store the on-device speech model, so it will be downloaded again next time '
  + 'you open the page. The microphone still works now.';

/** Shown when the cache refused the write (usually the storage quota): same consequence, told plainly. */
export const DEGRADED_CACHE_WRITE_FAILED =
  'The on-device speech model could not be saved to this browser\'s storage, so it will be '
  + 'downloaded again next time you open the page. The microphone still works now.';

/**
 * The browser implementation of `VoiceModelCacheEnv.sha256Hex`, for the worker to pass.
 *
 * It is exported here, beside the type that consumes it, so there is exactly one sha256 implementation
 * on this path: a second one somewhere else could disagree about encoding and the cache would either
 * reject every good model or accept a bad one.
 */
export async function subtleSha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let hex = '';
  for (const byte of view) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** Opens the model's cache bucket, or `null` when the Cache API is missing or refuses to open one. */
async function openStore(env: VoiceModelCacheEnv): Promise<VoiceModelCacheStore | null> {
  if (env.cachesImpl === null) return null;
  try {
    return await env.cachesImpl.open(VOICE_CLIENT_MODEL_CACHE_NAME);
  } catch {
    return null;
  }
}

/** Whether `bytes` hashes to `expected`; a hash that cannot be computed is a hash that does not match. */
async function hashMatches(bytes: ArrayBuffer, expected: string, env: VoiceModelCacheEnv): Promise<boolean> {
  try {
    return (await env.sha256Hex(bytes)).toLowerCase() === expected.toLowerCase();
  } catch {
    return false;
  }
}

/** Drops one cached entry, swallowing a failure — a delete that could not run is not a load failure. */
async function discard(store: VoiceModelCacheStore): Promise<void> {
  try {
    await store.delete(VOICE_CLIENT_MODEL_CACHE_KEY);
  } catch {
    // The entry will be re-validated and rejected again next load; nothing here is fatal.
  }
}

/**
 * Reads the cached model, re-validating it, or `null` when there is nothing usable.
 *
 * THE RE-VALIDATION IS NOT PARANOIA. The probe's ordering defect is exactly what makes a corrupt
 * entry possible in the first place, and storage can be truncated by the platform. A cached entry
 * that does not hash to the pinned value is DISCARDED and treated as absent, so the caller falls
 * through to a fresh download rather than handing a broken model to the runtime.
 */
async function readCachedModel(
  store: VoiceModelCacheStore,
  spec: VoiceClientModelSpec,
  env: VoiceModelCacheEnv,
): Promise<ArrayBuffer | null> {
  let entry: VoiceModelCacheResponse | undefined;
  try {
    entry = await store.match(VOICE_CLIENT_MODEL_CACHE_KEY);
  } catch {
    return null;
  }
  if (entry === undefined) return null;

  let bytes: ArrayBuffer;
  try {
    bytes = await entry.arrayBuffer();
  } catch {
    await discard(store);
    return null;
  }
  if (bytes.byteLength !== spec.bytes || !(await hashMatches(bytes, spec.sha256, env))) {
    await discard(store);
    return null;
  }
  return bytes;
}

/** Concatenates streamed chunks into one exactly-sized buffer. */
function concatChunks(chunks: Uint8Array[], total: number): ArrayBuffer {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out.buffer;
}

/**
 * Fetches the model with progress, then verifies length AND hash before returning the bytes.
 *
 * THE VERIFICATION IS BEFORE ANY WRITE, which is the defect this port fixes: a truncated download
 * (fewer bytes than the spec declares) or a corrupted one (right length, wrong hash) throws here, and
 * the caller never reaches `cache.put`. The progress readings are cumulative, so they are
 * monotonically non-decreasing by construction rather than by a check.
 */
async function downloadModel(
  spec: VoiceClientModelSpec,
  env: VoiceModelCacheEnv,
  onProgress?: (progress: VoiceModelProgress) => void,
): Promise<ArrayBuffer> {
  const response = await env.fetchImpl(spec.url);
  if (!response.ok) {
    throw new Error(`model download failed: ${response.status} ${response.statusText}`);
  }
  const startedAt = Date.now();
  const chunks: Uint8Array[] = [];
  let received = 0;

  const report = (): void => {
    if (onProgress === undefined) return;
    const elapsedSec = (Date.now() - startedAt) / 1000;
    const bytesPerSec = elapsedSec > 0 ? received / elapsedSec : 0;
    onProgress({
      receivedBytes: received,
      totalBytes: spec.bytes,
      bytesPerSec,
      remainingMs:
        bytesPerSec > 0 ? Math.round(((spec.bytes - received) / bytesPerSec) * 1000) : null,
    });
  };

  const body = response.body;
  if (body === null) {
    // A host that cannot stream still yields a usable model; it simply gets no incremental progress.
    const all = new Uint8Array(await response.arrayBuffer());
    chunks.push(all);
    received = all.length;
    report();
  } else {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      chunks.push(value);
      received += value.length;
      report();
    }
  }

  if (received !== spec.bytes) {
    throw new Error(`model download was ${received} B, expected ${spec.bytes} B`);
  }
  const bytes = concatChunks(chunks, received);
  if (!(await hashMatches(bytes, spec.sha256, env))) {
    throw new Error('model download did not match its sha256');
  }
  return bytes;
}

/**
 * Writes the verified model to the cache and asks for durable storage, returning the degradation
 * notice when it could not be kept.
 *
 * `persist()` is asked for unconditionally — it is what stops the platform evicting a quarter-gigabyte
 * entry under pressure — but its answer is best-effort: a browser that refuses durability still
 * caches normally, so a refusal is not a degradation. A MISSING Cache API and a FAILED write are,
 * because both mean the next visit downloads 239 MB again.
 */
async function persistModel(
  store: VoiceModelCacheStore | null,
  bytes: ArrayBuffer,
  env: VoiceModelCacheEnv,
): Promise<string | null> {
  let degraded: string | null = null;
  if (store === null) {
    degraded = DEGRADED_NO_CACHE_API;
  } else {
    try {
      await store.put(VOICE_CLIENT_MODEL_CACHE_KEY, new Response(bytes));
    } catch {
      degraded = DEGRADED_CACHE_WRITE_FAILED;
    }
  }
  try {
    await env.persist();
  } catch {
    // Durable storage is an upgrade, not a requirement: a refusal leaves the model cached anyway.
  }
  return degraded;
}

/**
 * Loads the model: from a re-validated cache entry with zero requests, or by a verified download.
 *
 * THE ZERO-REQUEST PATH IS THE POINT. A valid cache hit returns before `fetch` is ever called, which
 * is the reading S1's first case asserts and the user-visible promise the whole cache exists to keep.
 * Anything else — a missing bucket, a corrupted entry, no entry at all — falls through to a download
 * whose bytes are validated before they can reach the cache.
 */
export async function loadVoiceModel(options: VoiceModelLoadOptions): Promise<VoiceModelLoad> {
  const { spec, env, onProgress } = options;
  const store = await openStore(env);

  if (store !== null) {
    const cached = await readCachedModel(store, spec, env);
    if (cached !== null) return { modelBytes: cached, source: 'cache', degraded: null };
  }

  const downloaded = await downloadModel(spec, env, onProgress);
  const degraded = await persistModel(store, downloaded, env);
  return { modelBytes: downloaded, source: 'network', degraded };
}

/** Removes the cached model, for the settings control that frees the storage by hand. */
export async function clearVoiceClientModel(env: VoiceModelCacheEnv): Promise<void> {
  const store = await openStore(env);
  if (store === null) return;
  await discard(store);
}
