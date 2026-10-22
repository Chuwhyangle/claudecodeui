import { createHash } from 'node:crypto';

/**
 * Content-addressed memoisation for the session architecture tab (GOAL-049 /
 * ADR-005 decision 6).
 *
 * The future endpoint (`server/modules/architecture/routes.ts`, AC-418) asks this
 * cache for a rendered reading every time the tab is activated. Two layers keep
 * that cheap without ever serving stale content:
 *
 *  1. **Parse layer** — a parsed `arch-index.json` is memoised by
 *     `(scope, archJsonHash)`. `archJsonHash` is the fingerprint the file itself
 *     carries, so a re-analysis of `.archguard` changes it; the old entry cannot
 *     be returned for the new content.
 *  2. **Result layer** — a finished reading is memoised by the full content key
 *     `hash(projectId, sessionId, extractedSeeds, params, indexes)`. A different
 *     session, seed list, generation parameter, or scope fingerprint is a
 *     different key and therefore a miss.
 *
 * There is no TTL, no event, and no explicit eviction: the key *is* the
 * invalidation. Both layers are bounded LRUs, because the key space is unbounded
 * over a long-lived server (one entry per distinct transcript/seeds/params
 * tuple, and one parsed index per `.archguard` analysis).
 *
 * The caller supplies the per-scope `archJsonHash` it observed. A caller that
 * wants live `.archguard` refresh re-reads the fingerprint before asking; a
 * caller that wants a zero-disk-read hit reuses the fingerprints it already
 * holds. The cache itself never touches the filesystem — `readIndex` is injected
 * — so a same-key hit performs no filesystem work at all.
 */

/**
 * The minimum shape a parsed `.archguard/query/<scope>/arch-index.json` must
 * expose to the cache: its own content fingerprint.
 *
 * Consumers (`generator.ts`, and the AC-418 service) carry the full parsed index
 * as the generic `TIndex`; the cache only reads `archJsonHash`, but requires the
 * field so a file without a fingerprint fails at the boundary instead of being
 * cached under an `undefined` key.
 */
export type ArchitectureFingerprintedIndex = {
  readonly archJsonHash: string;
};

/**
 * One scope's parsed-index identity. `scope` is opaque to the cache and is
 * passed straight to the injected `readIndex` (the AC-418 service will pass the
 * scope directory or the stable scope key from `.archguard/query/manifest.json`).
 *
 * `archJsonHash` is the fingerprint observed for that scope. It is part of both
 * cache layers, so changing it is what makes a `.archguard` re-analysis visible.
 */
export type ArchitectureIndexRef = {
  readonly scope: string;
  readonly archJsonHash: string;
};

/**
 * The seed lists extracted from a transcript (AC-416). Order is meaningful: the
 * extractor preserves first-occurrence order, and the cache treats two seed
 * lists with the same elements in a different order as different content.
 */
export type ArchitectureSeeds = {
  readonly files: readonly string[];
  readonly identifiers: readonly string[];
};

/**
 * The full content-addressed key for a generated reading. Every component is
 * part of the digest, so changing any one of them is a miss by construction.
 */
export type ArchitectureReadingKey<TParams = unknown> = {
  readonly projectId: string;
  readonly sessionId: string;
  readonly seeds: ArchitectureSeeds;
  readonly params: TParams;
  readonly indexes: readonly ArchitectureIndexRef[];
  /**
   * Version of the MERGE rules that produced the reading (see
   * `scope-hygiene.ts`'s `SCOPE_HYGIENE_RULES_VERSION`).
   *
   * The merged index is not part of the key — only the scopes' fingerprints
   * are — so a rule change that leaves every `.archguard` byte unchanged would
   * otherwise keep serving a reading merged by the old rules. Bumping the
   * version is what makes that a miss. Optional so a caller with no merge step
   * (and every pre-existing key) keeps its exact old digest.
   */
  readonly rulesVersion?: string;
};

/**
 * Construction options for a cache instance.
 *
 * `readIndex` is the only I/O the cache performs, and only on a parse-layer
 * miss. `maxEntries` bounds the result layer; `maxIndexEntries` bounds the parse
 * layer (defaults to `maxEntries`).
 */
export type ArchitectureCacheOptions<TIndex extends ArchitectureFingerprintedIndex> = {
  readonly readIndex: (scope: string) => TIndex | Promise<TIndex>;
  readonly maxEntries?: number;
  readonly maxIndexEntries?: number;
};

/**
 * The cache surface consumed by the AC-418 service/routes.
 *
 * `getReading` returns the cached reading object itself when the key is
 * unchanged (reference equality), and calls `build` with the parsed indexes in
 * canonical scope order on a miss.
 */
export type ArchitectureCache<TIndex extends ArchitectureFingerprintedIndex, TReading, TParams = unknown> = {
  getIndex(ref: ArchitectureIndexRef): Promise<TIndex>;
  getReading(
    key: ArchitectureReadingKey<TParams>,
    build: (indexes: readonly TIndex[]) => TReading | Promise<TReading>,
  ): Promise<TReading>;
};

/**
 * Raised when the caller's cached fingerprint disagrees with the fingerprint the
 * file actually carries. That means the caller's key describes a different
 * content snapshot; serving it would cache new data under a stale key, so the
 * cache fails closed and the caller re-reads the fingerprint.
 *
 * Consumers: the AC-418 service (catch → re-read the scope fingerprint and
 * retry), and this module's invalidation criterion.
 */
export class ArchitectureCacheFingerprintMismatchError extends Error {
  readonly scope: string;
  readonly requestedArchJsonHash: string;
  readonly actualArchJsonHash: string;

  constructor(scope: string, requestedArchJsonHash: string, actualArchJsonHash: string) {
    super(
      `arch-index for scope '${scope}' reports archJsonHash ${actualArchJsonHash}, ` +
        `but the cache key supplied ${requestedArchJsonHash} — the caller's fingerprint is stale`,
    );
    this.name = 'ArchitectureCacheFingerprintMismatchError';
    this.scope = scope;
    this.requestedArchJsonHash = requestedArchJsonHash;
    this.actualArchJsonHash = actualArchJsonHash;
  }
}

const DEFAULT_MAX_ENTRIES = 64;

function assertCapacity(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer, received ${value}`);
  }
}

/**
 * Inserts or refreshes an entry and evicts the least-recently-used entries until
 * the map is within capacity. `Map` iteration order is insertion order, so
 * delete-then-set is what moves a hit to the newest end.
 */
function touchLru<K, V>(map: Map<K, V>, key: K, value: V, capacity: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > capacity) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

/**
 * Deterministic serialisation of a cache key.
 *
 * Object property order is not semantic (two callers can build `{hops, maxNodes}`
 * in either order), so keys are sorted; array order is semantic (seed order is
 * part of the content), so arrays are preserved. Values are expected to be
 * JSON-serialisable — a BigInt or a function in `params` is a programming error,
 * not a cache concern.
 */
function canonicalize(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  const parts = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
  return `{${parts.join(',')}}`;
}

function readingKeyDigest(key: ArchitectureReadingKey<unknown>): string {
  return createHash('sha256')
    .update(
      canonicalize({
        projectId: key.projectId,
        sessionId: key.sessionId,
        seeds: key.seeds,
        params: key.params,
        indexes: key.indexes,
        // `null`, not `undefined`: a key without a version must hash the same
        // way whether the caller omitted the field or set it to `undefined`.
        rulesVersion: key.rulesVersion ?? null,
      }),
    )
    .digest('hex');
}

/**
 * Sorts and de-duplicates scope refs so that two equivalent key objects (for
 * example, scopes discovered in a different order) hash to the same digest and
 * `build` always receives indexes in the same order.
 */
function normalizeIndexRefs(refs: readonly ArchitectureIndexRef[]): ArchitectureIndexRef[] {
  const seen = new Set<string>();
  const unique: ArchitectureIndexRef[] = [];
  for (const ref of refs) {
    const identity = `${ref.scope}\u0000${ref.archJsonHash}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    unique.push(ref);
  }
  return unique.sort((left, right) => {
    if (left.scope !== right.scope) return left.scope < right.scope ? -1 : 1;
    if (left.archJsonHash !== right.archJsonHash) return left.archJsonHash < right.archJsonHash ? -1 : 1;
    return 0;
  });
}

/**
 * Creates a two-layer content-addressed cache.
 *
 * Consumers: the AC-418 architecture service creates one instance at module
 * scope (the app's lifetime) and calls `getReading` per request; tests create
 * short-lived instances with a counting `readIndex`.
 */
export function createArchitectureCache<
  TIndex extends ArchitectureFingerprintedIndex,
  TReading,
  TParams = unknown,
>(options: ArchitectureCacheOptions<TIndex>): ArchitectureCache<TIndex, TReading, TParams> {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxIndexEntries = options.maxIndexEntries ?? maxEntries;
  assertCapacity('maxEntries', maxEntries);
  assertCapacity('maxIndexEntries', maxIndexEntries);

  // Layer 1: parsed arch-index, keyed by the file's own content fingerprint.
  const indexCache = new Map<string, TIndex>();
  // Layer 2: rendered reading, keyed by the full content digest.
  const readingCache = new Map<string, TReading>();

  function indexKey(ref: ArchitectureIndexRef): string {
    return `${ref.scope}\u0000${ref.archJsonHash}`;
  }

  async function getIndex(ref: ArchitectureIndexRef): Promise<TIndex> {
    const key = indexKey(ref);
    if (indexCache.has(key)) {
      const cached = indexCache.get(key) as TIndex;
      touchLru(indexCache, key, cached, maxIndexEntries);
      return cached;
    }

    const parsed = await options.readIndex(ref.scope);
    if (!parsed || typeof parsed.archJsonHash !== 'string' || parsed.archJsonHash.length === 0) {
      throw new TypeError(`readIndex('${ref.scope}') returned an index without a string archJsonHash`);
    }
    if (parsed.archJsonHash !== ref.archJsonHash) {
      throw new ArchitectureCacheFingerprintMismatchError(ref.scope, ref.archJsonHash, parsed.archJsonHash);
    }

    touchLru(indexCache, key, parsed, maxIndexEntries);
    return parsed;
  }

  async function getReading(
    key: ArchitectureReadingKey<TParams>,
    build: (indexes: readonly TIndex[]) => TReading | Promise<TReading>,
  ): Promise<TReading> {
    const indexes = normalizeIndexRefs(key.indexes);
    const digest = readingKeyDigest({
      projectId: key.projectId,
      sessionId: key.sessionId,
      seeds: key.seeds,
      params: key.params,
      indexes,
      ...(key.rulesVersion === undefined ? {} : { rulesVersion: key.rulesVersion }),
    });

    if (readingCache.has(digest)) {
      const cached = readingCache.get(digest) as TReading;
      touchLru(readingCache, digest, cached, maxEntries);
      return cached;
    }

    // Parse-layer hits (same scope+fingerprint) perform no `readIndex` call, so a
    // seed/param-only change re-renders without touching the filesystem.
    const parsedIndexes = await Promise.all(indexes.map((ref) => getIndex(ref)));
    const reading = await build(parsedIndexes);
    touchLru(readingCache, digest, reading, maxEntries);
    return reading;
  }

  return { getIndex, getReading };
}
