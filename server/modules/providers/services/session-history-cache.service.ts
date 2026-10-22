import fsp from 'node:fs/promises';

import type { FetchHistoryResult } from '@/shared/types.js';

/**
 * Full-transcript cache for session history reads.
 *
 * Every provider history reader materializes the complete normalized
 * transcript and then slices out the requested page, so serving a 20-row page
 * of a large session re-read and re-parsed the whole transcript file on every
 * request — opening a session, each older page while scrolling up, and every
 * post-turn refresh. For a multi-megabyte JSONL that is most of a second of
 * CPU per request.
 *
 * Entries are keyed by app session id and validated with one `stat` per
 * request against the transcript file's identity (path + mtime + size), so
 * only the first read after the file changes pays the parse. A reader that can
 * resume from a byte offset leaves a token on its entry (`resume`) and is
 * handed it back through a per-load context on the next reload, so a plain
 * append re-parses only the new tail; anything else (truncation, rewrite,
 * mtime backwards) makes the reader fall back and it re-parses the file whole.
 *
 * Only history readers that read `jsonl_path` itself may use this cache —
 * callers pass `transcriptPath: null` for providers whose messages live
 * elsewhere (Cursor's store.db, OpenCode's shared SQLite), which bypasses
 * caching entirely.
 */

type CacheEntry = {
  transcriptPath: string;
  mtimeMs: number;
  /** File size in bytes; doubles as the entry's cost against the byte budget. */
  size: number;
  /**
   * Whether the session was running when `full` was read. Part of the entry's
   * identity, not just its payload: a running read withholds the last turn's
   * `forkAnchorId`, so serving it back after the run ends (the file is
   * unchanged for a beat) would hand the client a final reply with no fork
   * button — and the reverse would offer a fork into a half-written turn.
   */
  running: boolean;
  full: FetchHistoryResult;
  /**
   * Opaque parse state the reader returned for `full`, handed back to it on the
   * next reload so a plain append can resume from the previous offset. Absent
   * when the reader cannot resume.
   */
  resume?: unknown;
};

type GetFullHistoryArgs = {
  sessionId: string;
  /** Path of the file the provider's history reader actually parses, or null to bypass. */
  transcriptPath: string | null | undefined;
  /**
   * Whether the session's run is in flight right now. Rides the entry identity
   * so a running/idle flip re-reads rather than serving the other's result.
   */
  running?: boolean;
  /** Loads the complete transcript (`limit: null, offset: 0`) from the provider. */
  loadFull: () => Promise<FetchHistoryResult>;
};

/**
 * Per-session scratch the cache publishes around one full read.
 *
 * `getFullHistory` installs one immediately before calling the reader's
 * `loadFull`, and removes it once the read settles. A reader that can resume
 * from a byte offset calls `takeHistoryLoadContext(sessionId)` to read
 * `previous` (the parse state the entry being replaced carried) and to publish
 * the state its own parse produced on `producedResume`. Readers that cannot
 * resume ignore it, and a read that did not go through the cache finds none.
 */
export type HistoryLoadContext = {
  previous: { resume: unknown; size: number; mtimeMs: number } | null;
  producedResume: unknown;
};

/**
 * A transcript entry's heap cost is roughly the file it was parsed from, so
 * the budget is expressed in file bytes. The newest entry is always retained
 * even when it alone exceeds the budget — evicting it would just re-parse the
 * same file on the next request.
 */
const MAX_CACHED_TRANSCRIPT_FILE_BYTES = 256 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 8;

/**
 * Owns the history cache's two pieces of per-session state: the parsed-entry
 * store (bounded by the byte/entry budget) and the scratch context published
 * to a reader for the duration of one full read.
 *
 * Consumed by `sessions.service` (through the `sessionHistoryCache` singleton)
 * and by the provider history readers (through `takeHistoryLoadContext`).
 */
export class SessionHistoryCache {
  /**
   * In-flight load contexts, one per session currently being re-read.
   *
   * Class-private rather than module-level so the map has an owner and one
   * invalidation path (`putLoadContext` / `invalidateLoadContext`) instead of
   * being mutated from anywhere in the module.
   *
   * Static (shared by every instance) because the reader reaches it through the
   * module-level `takeHistoryLoadContext(sessionId)`, which has no cache
   * instance in hand. A per-instance map would leave the singleton working but
   * silently disable resume for an independently constructed cache — the shape
   * the incremental-read tests build — because the reader's lookup would miss
   * the context the instance installed.
   */
  private static readonly loadContexts = new Map<string, HistoryLoadContext>();

  private readonly entries = new Map<string, CacheEntry>();
  private readonly pendingLoads = new Map<string, Promise<FetchHistoryResult>>();

  constructor(
    private readonly maxTotalFileBytes = MAX_CACHED_TRANSCRIPT_FILE_BYTES,
    private readonly maxEntries = MAX_CACHE_ENTRIES,
  ) {}

  /** Returns the in-flight load context for `sessionId`, or null when none is installed. */
  getLoadContext(sessionId: string): HistoryLoadContext | null {
    return SessionHistoryCache.loadContexts.get(sessionId) ?? null;
  }

  /** Installs the load context a reader will see for `sessionId` during one full read. */
  putLoadContext(sessionId: string, context: HistoryLoadContext): void {
    SessionHistoryCache.loadContexts.set(sessionId, context);
  }

  /** Removes the load context for `sessionId` once its full read has settled. */
  invalidateLoadContext(sessionId: string): void {
    SessionHistoryCache.loadContexts.delete(sessionId);
  }

  private evictOverBudget(): void {
    let totalBytes = 0;
    for (const entry of this.entries.values()) {
      totalBytes += entry.size;
    }
    for (const key of this.entries.keys()) {
      if (this.entries.size <= 1 || (totalBytes <= this.maxTotalFileBytes && this.entries.size <= this.maxEntries)) {
        break;
      }
      totalBytes -= this.entries.get(key)!.size;
      this.entries.delete(key);
    }
  }

  /**
   * Returns the session's full transcript through the cache, or null when
   * the session is not cacheable (no transcript path, or the file cannot be
   * stat'ed) — the caller then falls back to a plain provider read.
   */
  async getFullHistory({ sessionId, transcriptPath, running = false, loadFull }: GetFullHistoryArgs): Promise<FetchHistoryResult | null> {
    if (!transcriptPath) {
      return null;
    }

    let stat;
    try {
      stat = await fsp.stat(transcriptPath);
    } catch {
      this.entries.delete(sessionId);
      return null;
    }
    if (!stat.isFile()) {
      this.entries.delete(sessionId);
      return null;
    }

    const cached = this.entries.get(sessionId);
    if (
      cached
      && cached.transcriptPath === transcriptPath
      && cached.mtimeMs === stat.mtimeMs
      && cached.size === stat.size
      && cached.running === running
    ) {
      // Re-insert to mark as most recently used.
      this.entries.delete(sessionId);
      this.entries.set(sessionId, cached);
      return cached.full;
    }

    // Concurrent requests for the same session share one parse. The file may
    // gain rows while the load runs; the pre-load stat is what the entry is
    // keyed by, so the next request would see a changed stat and re-read.
    const pending = this.pendingLoads.get(sessionId);
    if (pending) {
      return pending;
    }

    // The reader sees the entry being replaced (its resume, size and mtime)
    // and can publish the state its own parse produced. Installed before the
    // load starts and removed once it settles, so a reader invoked outside
    // the cache — a direct provider read — finds nothing and parses whole.
    const context: HistoryLoadContext = {
      previous: cached
        ? { resume: cached.resume, size: cached.size, mtimeMs: cached.mtimeMs }
        : null,
      producedResume: undefined,
    };
    this.putLoadContext(sessionId, context);

    const load = loadFull()
      .then((full) => {
        this.entries.delete(sessionId);
        this.entries.set(sessionId, {
          transcriptPath,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          running,
          full,
          resume: context.producedResume,
        });
        this.evictOverBudget();
        return full;
      })
      .finally(() => {
        this.invalidateLoadContext(sessionId);
      });
    this.pendingLoads.set(sessionId, load);
    try {
      return await load;
    } finally {
      this.pendingLoads.delete(sessionId);
    }
  }
}

/**
 * The process-wide cache instance consumed by `sessions.service` for every
 * history page read.
 */
export const sessionHistoryCache = new SessionHistoryCache();

/**
 * Builds an independently budgeted cache instance.
 *
 * Consumed by the session-history cache tests, which need two caches over the
 * same transcript to compare an incremental read against a cold full parse.
 */
export function createSessionHistoryCache(
  maxTotalFileBytes = MAX_CACHED_TRANSCRIPT_FILE_BYTES,
  maxEntries = MAX_CACHE_ENTRIES,
): SessionHistoryCache {
  return new SessionHistoryCache(maxTotalFileBytes, maxEntries);
}

/**
 * Returns the in-flight load context for `sessionId`, or null when no cache
 * reload is in flight for it.
 *
 * Consumed by `claude-sessions.provider`'s history reader. The returned object
 * is live: a reader hands its resume token back by assigning `producedResume`.
 */
export function takeHistoryLoadContext(sessionId: string): HistoryLoadContext | null {
  return sessionHistoryCache.getLoadContext(sessionId);
}
