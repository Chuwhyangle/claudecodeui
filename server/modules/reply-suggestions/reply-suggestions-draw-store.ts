/**
 * The per-session draw store: how many draws a session's current assistant
 * message has served, which chips were already shown, the batch last returned
 * and the in-flight coalescing map — behind ONE bounded store.
 *
 * ONE BOUND, NO TIMED EXPIRY. Both the session state and the cached batch live
 * on the same least-recently-used record, keyed by session id. The store keeps
 * at most 200 entries (`REPLY_SUGGESTIONS_DRAW_STORE_SIZE`); past that bound the
 * least-recently-used session is dropped. There is no clock at all, so a quiet
 * batch never expires by time — a restart is what loses it.
 *
 * A NEW MESSAGE RESETS. Every record names the assistant message it belongs to.
 * A record whose message id no longer matches reports no shown chips, no batch
 * and starts the draw counter again, so a new assistant message is a fresh draw.
 *
 * COPIES CROSS THE BOUNDARY. Every array handed to a caller is a copy, and every
 * array handed in is copied on the way in; mutating a returned list can never
 * rewrite the store's state.
 *
 * Consumers: `reply-suggestions.service.ts` (the whole draw path) and the store
 * criterion in `tests/reply-suggestions-draw-store.test.ts`.
 */

/**
 * How many session records the store keeps. Least-recently-used entries are evicted past this.
 *
 * Consumers: `createDrawStore` below and the store criterion in
 * `tests/reply-suggestions-draw-store.test.ts`.
 */
export const REPLY_SUGGESTIONS_DRAW_STORE_SIZE = 200;

/** One batch returned to the client for a cached draw. */
type ReplySuggestionsCachedBatch = {
  chips: string[];
  draw: number;
};

type SessionRecord = {
  /** The assistant message this record belongs to; '' before the first draw. */
  messageId: string;
  draw: number;
  shown: string[];
  /** The batch last returned for this session's current message and settings version. */
  batch: { version: string; chips: string[]; draw: number } | null;
};

type ReplySuggestionsDrawStore = {
  /** The chips already shown for this session's current message, as a copy. */
  shownChips(sessionId: string, messageId: string): string[];
  /** Record the chips selected for this message; returns the new draw number. */
  recordDraw(sessionId: string, messageId: string, chips: readonly string[]): number;
  /** The cached batch for (session, message, settings version), as a copy; undefined on a miss. */
  readBatch(sessionId: string, messageId: string, version: string): ReplySuggestionsCachedBatch | undefined;
  /** Store (or replace) the batch just returned; the chips are copied on the way in. */
  recordBatch(sessionId: string, messageId: string, version: string, chips: readonly string[], draw: number): void;
  /** Drop the cached batch (an empty draw must never be served later). */
  forgetBatch(sessionId: string, messageId: string, version: string): void;
  /** Run `task` once while an identical key is already in flight; the others share it. */
  coalesce<T>(key: string, task: () => Promise<T>): Promise<T>;
};

/**
 * Build one store. `capacity` is injectable for a criterion that wants a smaller
 * bound; production uses the shipped 200-key bound.
 *
 * Consumers: `reply-suggestions.service.ts` (the whole draw path) and the store
 * criterion in `tests/reply-suggestions-draw-store.test.ts`.
 */
export function createDrawStore(options: { capacity?: number } = {}): ReplySuggestionsDrawStore {
  const capacity = options.capacity ?? REPLY_SUGGESTIONS_DRAW_STORE_SIZE;
  // Insertion order is the LRU order: every access deletes and re-inserts.
  const records = new Map<string, SessionRecord>();
  const inflight = new Map<string, Promise<unknown>>();

  /** The current record for a session, moved to the most-recently-used end. */
  function touch(sessionId: string): SessionRecord {
    const existing = records.get(sessionId);
    if (existing !== undefined) {
      records.delete(sessionId);
      records.set(sessionId, existing);
      return existing;
    }
    const created: SessionRecord = { messageId: '', draw: 0, shown: [], batch: null };
    records.set(sessionId, created);
    while (records.size > capacity) {
      const oldest = records.keys().next().value;
      if (oldest === undefined) break;
      records.delete(oldest);
    }
    return created;
  }

  /** Start every message-dependent field over when the assistant message changed. */
  function recordFor(sessionId: string, messageId: string): SessionRecord {
    const record = touch(sessionId);
    if (record.messageId !== messageId) {
      record.messageId = messageId;
      record.draw = 0;
      record.shown = [];
      record.batch = null;
    }
    return record;
  }

  return {
    shownChips(sessionId: string, messageId: string): string[] {
      const record = touch(sessionId);
      if (record.messageId !== messageId) return [];
      return [...record.shown];
    },

    recordDraw(sessionId: string, messageId: string, chips: readonly string[]): number {
      const record = recordFor(sessionId, messageId);
      record.draw += 1;
      record.shown = [...record.shown, ...chips];
      return record.draw;
    },

    readBatch(sessionId: string, messageId: string, version: string): ReplySuggestionsCachedBatch | undefined {
      const record = touch(sessionId);
      if (record.messageId !== messageId || record.batch === null || record.batch.version !== version) {
        return undefined;
      }
      return { chips: [...record.batch.chips], draw: record.batch.draw };
    },

    recordBatch(sessionId: string, messageId: string, version: string, chips: readonly string[], draw: number): void {
      const record = recordFor(sessionId, messageId);
      record.batch = { version, chips: [...chips], draw };
    },

    forgetBatch(sessionId: string, messageId: string, version: string): void {
      const record = touch(sessionId);
      if (record.messageId === messageId && record.batch?.version === version) {
        record.batch = null;
      }
    },

    coalesce<T>(key: string, task: () => Promise<T>): Promise<T> {
      const running = inflight.get(key) as Promise<T> | undefined;
      if (running !== undefined) return running;
      const created = task().finally(() => {
        inflight.delete(key);
      });
      inflight.set(key, created);
      return created;
    },
  };
}
