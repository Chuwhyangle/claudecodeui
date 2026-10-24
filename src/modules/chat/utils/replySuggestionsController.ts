import type {
  ReplySuggestionsEventInput,
  ReplySuggestionsEventName,
  ReplySuggestionsExpansionSource,
  ReplySuggestionsRequest,
  ReplySuggestionsResult,
  ReplySuggestionsStatus,
} from '@/shared/types';

/**
 * The composer's reply-chip controller: every rule of the model and expansion
 * draws, kept in one object that does not depend on React.
 *
 * The hook that used to own this logic rendered the rules through React state and
 * mirrored each piece of state into a ref so async callbacks could read it. Here
 * there is one mutable reading plus one cached snapshot: commands change the
 * reading and notify subscribers, and `getSnapshot` hands React a value whose
 * identity only changes when something actually changed.
 *
 * The rules, unchanged from the hook this replaced:
 *
 * - A draw belongs to one assistant message. The controller asks the server once
 *   for `${sessionId}\u0000${lastAssistantMessageId}` and remembers the batch in
 *   its injected cache, so a re-render, an emptied box, a mounted/unmounted strip
 *   or a switch back to a conversation restores the batch instead of requesting
 *   it again. A changed id (the assistant answered again) asks for a new draw.
 * - A session change invalidates everything in flight: chips, the expansion chain
 *   and any held draw are dropped, and the request sequence is bumped so a late
 *   answer from the conversation that was left cannot repopulate the strip.
 * - Disabled is silent. A refused `/status` or a failed draw falls back to the
 *   habit chips: nothing here throws into the composer or publishes an error.
 *   `redraw` is the one command that reports failure, through its `false`, so a
 *   press with no answer is not mistaken for a press that did nothing.
 * - The experimental expansion (`expansion: "vary"`) is a second draw on the same
 *   message: a picked reply (`seed`) asks for variants, a quoted passage
 *   (`focus`) asks for responses. Its chips live beside the model batch because
 *   they answer the draft in the box, not the empty box the model batch is drawn
 *   for; the chain caps at {@link REPLY_SUGGESTIONS_MAX_EXPANSION_DEPTH} and is
 *   dropped whenever the draft is edited, cleared or sent.
 * - The ledger is a readout. `picked` / `cleared` / `redrawn` / `sent` posts are
 *   fire-and-forget, and a refused write never changes the surface.
 *
 * Consumers: `useReplySuggestions` (which subscribes and translates the snapshot
 * into the hook's grouped result) and the controller criterion.
 */

/** How many consecutive expansion requests one pick chain may make. */
export const REPLY_SUGGESTIONS_MAX_EXPANSION_DEPTH = 5;

/**
 * How many `${sessionId}\u0000${assistantMessageId}` batches the page remembers.
 * Browser memory only: a reload empties it and the server cache answers instead.
 */
export const REPLY_SUGGESTIONS_BATCH_CACHE_SIZE = 20;

/**
 * How long a draw triggered by a message-id change is held before it may reach
 * the server.
 *
 * The session id and the last assistant message id reach the controller from two
 * different readings of the page. During an in-app conversation switch the
 * message id belongs to the incoming conversation for one render before the
 * session id follows, so that render looks like "the assistant answered again in
 * the outgoing conversation". Holding the draw for one beat lets the corrected
 * session id arrive and cancel it: switching between two conversations neither
 * asks the server nor draws. A message that really did arrive has no such
 * correction and goes out a fraction of a second later.
 */
const REPLY_SUGGESTIONS_SESSION_SETTLE_MS = 120;

/** Most chips one draw may return before `/status` has answered. */
const DEFAULT_MAX_CHIPS = 3;

/** One remembered batch: the chips and the draw id they belong to. */
type CachedBatch = { chips: string[]; draw: number };

/** Starts and cancels the one settle timer; injectable so tests need no wall clock. */
export type ReplySuggestionsClock = {
  setTimeout: (callback: () => void, milliseconds: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

/**
 * The page-level table of remembered batches.
 *
 * The hook keeps one at module scope so it survives an unmount/remount of the
 * composer; a controller created on its own gets a private one instead. Map
 * insertion order is the LRU order: reading a key moves it to the end.
 */
export type ReplySuggestionsBatchCache = {
  read: (key: string) => CachedBatch | null;
  write: (key: string, batch: CachedBatch) => void;
  clear: () => void;
};

/** Builds an empty batch table that keeps at most `capacity` keys. */
export function createReplySuggestionsBatchCache(
  capacity: number = REPLY_SUGGESTIONS_BATCH_CACHE_SIZE,
): ReplySuggestionsBatchCache {
  const batches = new Map<string, CachedBatch>();

  const read = (key: string): CachedBatch | null => {
    const cached = batches.get(key);
    if (cached === undefined) return null;
    batches.delete(key);
    batches.set(key, cached);
    return cached;
  };

  const write = (key: string, batch: CachedBatch): void => {
    // An empty batch is not a batch: remembering it would suppress the retry the
    // next visit should make. This mirrors the server, which never caches one.
    if (batch.chips.length === 0) {
      batches.delete(key);
      return;
    }
    batches.delete(key);
    batches.set(key, batch);
    while (batches.size > capacity) {
      const oldest = batches.keys().next().value;
      if (oldest === undefined) break;
      batches.delete(oldest);
    }
  };

  return { read, write, clear: () => batches.clear() };
}

/** The batch table the hook shares across composer mounts on one page. */
export const replySuggestionsBatchCache = createReplySuggestionsBatchCache();

/** Test seam: forget every batch the shared page-level table remembers. */
export function resetReplySuggestionsBatchCache(): void {
  replySuggestionsBatchCache.clear();
}

/**
 * The three endpoint calls the controller makes. `suggest` and `status` answer
 * `null` for a refused or unreadable response; the controller treats that as the
 * silent fallback and never touches a `Response` itself.
 */
export type ReplySuggestionsApi = {
  status: () => Promise<ReplySuggestionsStatus | null>;
  suggest: (
    request: ReplySuggestionsRequest,
    options?: { maxChips?: number },
  ) => Promise<ReplySuggestionsResult | null>;
  event: (event: ReplySuggestionsEventInput) => Promise<boolean>;
};

/** The page's reading of what the controller should draw, handed in every render. */
export type ReplySuggestionsContext = {
  /** The open conversation, or null before one exists. */
  sessionId: string | null;
  /** Stable identity of the last assistant message; its change is the extraction trigger. */
  lastAssistantMessageId: string | null;
  /** The model chips' display conditions hold (empty box, idle, no menu, no draft). */
  active: boolean;
  /** Transcript selection text sent as `focus` when the person asks for a fresh batch. */
  focus: string | null;
};

/** Everything the hook reads through `useSyncExternalStore`. */
export type ReplySuggestionsSnapshot = {
  /** The `/status` reading; null until the server has answered, which is not the same as off. */
  status: ReplySuggestionsStatus | null;
  /** The current model batch, in the server's order. Replaced wholesale, never appended. */
  chips: string[];
  /** The batch id the ledger events refer to. */
  draw: number | null;
  /** A draw is in flight: the Suggest button is disabled and shows its progress state. */
  loading: boolean;
  /** The variant/response chips for the draft in the box. Empty when no chain is live. */
  expansionChips: string[];
  /** Which anchor produced `expansionChips`: a picked reply or a quoted passage. */
  expansionSource: ReplySuggestionsExpansionSource | null;
  /** An expansion request is in flight. */
  expansionLoading: boolean;
  /** How many expansion requests this chain has made; resets when the chips are dropped. */
  expansionDepth: number;
  /** Whether the Suggest control should be drawn: the feature is on AND there is an answer. */
  enabled: boolean;
  /** True when the settings say `expansion: "vary"` and the feature is otherwise on. */
  expansionEnabled: boolean;
  /** Whether another expansion may be requested (enabled and under the depth cap). */
  canExpand: boolean;
};

/** The commands and subscription surface the hook drives. */
export type ReplySuggestionsController = {
  /** Registers a listener; the returned function unsubscribes it. */
  subscribe: (listener: () => void) => () => void;
  /** The stable snapshot; the identity changes only when the reading changed. */
  getSnapshot: () => ReplySuggestionsSnapshot;
  /** The page's current session/message/visibility; a new session starts over. */
  setContext: (context: ReplySuggestionsContext) => void;
  /** Asks for a completely new batch; resolves true only when one was applied. */
  redraw: () => Promise<boolean>;
  /** Asks for variants of `seed`, or responses to `focus` when the seed is empty. */
  requestExpansion: (request: { seed?: string; focus?: string }) => void;
  /** Drops the expansion chips and resets the chain depth. */
  clearExpansion: () => void;
  /** Reports one ledger event; failures are swallowed. */
  reportEvent: (
    event: ReplySuggestionsEventName,
    index?: number,
    source?: ReplySuggestionsExpansionSource,
  ) => void;
  /** Stops timers and subscribers; a controller is not reusable afterwards. */
  dispose: () => void;
};

const defaultClock: ReplySuggestionsClock = {
  setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const emptyContext: ReplySuggestionsContext = {
  sessionId: null,
  lastAssistantMessageId: null,
  active: false,
  focus: null,
};

function batchKey(sessionId: string, messageId: string): string {
  return `${sessionId}\u0000${messageId}`;
}

/**
 * Build one controller.
 *
 * `api` is the only transport it knows, `clock` is the only scheduler, and `cache`
 * is the only place batches are remembered — all three are injected so the rules
 * can be exercised without React, the network or a wall clock.
 */
export function createReplySuggestionsController(options: {
  api: ReplySuggestionsApi;
  clock?: ReplySuggestionsClock;
  cache?: ReplySuggestionsBatchCache;
}): ReplySuggestionsController {
  const { api } = options;
  const clock = options.clock ?? defaultClock;
  const cache = options.cache ?? createReplySuggestionsBatchCache();

  const listeners = new Set<() => void>();
  let context: ReplySuggestionsContext = emptyContext;
  let started = false;
  let disposed = false;

  let status: ReplySuggestionsStatus | null = null;
  let chips: string[] = [];
  let draw: number | null = null;
  let loading = false;
  let expansionChips: string[] = [];
  let expansionSource: ReplySuggestionsExpansionSource | null = null;
  let expansionLoading = false;
  let expansionDepth = 0;

  /** The `${session}:${message}` key this controller has already asked for (or restored). */
  let extractedKey: string | null = null;
  // Request tokens. Every session change and every new request bumps its own
  // counter, so a late answer can be told apart from the current one.
  let extractionSeq = 0;
  let redrawSeq = 0;
  let expansionSeq = 0;
  let settleTimer: unknown = null;

  const maxChips = (): number => status?.maxChips ?? DEFAULT_MAX_CHIPS;

  const buildSnapshot = (): ReplySuggestionsSnapshot => ({
    status,
    chips,
    draw,
    loading,
    expansionChips,
    expansionSource,
    expansionLoading,
    expansionDepth,
    // A conversation with no assistant message has nothing to suggest from: the
    // control is absent rather than a silent no-op, matching the disabled case.
    enabled: status?.enabled === true && context.lastAssistantMessageId !== null,
    expansionEnabled: status?.enabled === true && status.expansion === 'vary',
    canExpand: status?.enabled === true
      && status.expansion === 'vary'
      && expansionDepth < REPLY_SUGGESTIONS_MAX_EXPANSION_DEPTH,
  });

  let snapshot = buildSnapshot();

  const notify = (): void => {
    for (const listener of [...listeners]) {
      listener();
    }
  };

  /** Rebuilds the snapshot and notifies only when a published field changed. */
  const publish = (): void => {
    if (disposed) return;
    const next = buildSnapshot();
    const previous = snapshot;
    if (
      previous.status === next.status
      && previous.chips === next.chips
      && previous.draw === next.draw
      && previous.loading === next.loading
      && previous.expansionChips === next.expansionChips
      && previous.expansionSource === next.expansionSource
      && previous.expansionLoading === next.expansionLoading
      && previous.expansionDepth === next.expansionDepth
      && previous.enabled === next.enabled
      && previous.expansionEnabled === next.expansionEnabled
      && previous.canExpand === next.canExpand
    ) {
      return;
    }
    snapshot = next;
    notify();
  };

  const clearSettleTimer = (): void => {
    if (settleTimer === null) return;
    clock.clearTimeout(settleTimer);
    settleTimer = null;
  };

  const applyResult = (result: ReplySuggestionsResult): void => {
    chips = result.chips;
    draw = result.draw;
  };

  /** Drops the expansion chips and resets the chain depth. A late answer is ignored. */
  const clearExpansion = (): void => {
    expansionSeq += 1;
    expansionLoading = false;
    expansionDepth = 0;
    expansionSource = null;
    if (expansionChips.length > 0) expansionChips = [];
    publish();
  };

  const reportEvent = (
    event: ReplySuggestionsEventName,
    index?: number,
    source?: ReplySuggestionsExpansionSource,
  ): void => {
    const sessionId = context.sessionId;
    if (sessionId === null) return;
    const payload: ReplySuggestionsEventInput = {
      sessionId,
      draw: draw ?? 0,
      event,
      ...(index === undefined ? {} : { index }),
      ...(source === undefined ? {} : { source }),
    };
    void (async () => {
      try {
        await api.event(payload);
      } catch {
        // The ledger is a local readout; losing one row must not disturb the composer.
      }
    })();
  };

  /**
   * One draw per assistant message, and only while the chips could actually be
   * seen. A batch this page already drew for the same key is restored from the
   * cache instead of being requested again.
   */
  const maybeDraw = (): void => {
    const eligible = !disposed
      && status?.enabled === true
      && context.active
      && context.sessionId !== null
      && context.lastAssistantMessageId !== null;
    if (!eligible) {
      // A held draw that never started is cancelled when the reading becomes
      // ineligible, so the corrected render is free to draw it. A draw that was
      // not held stays marked: a re-render that hides and shows the strip again
      // must not become a second request for the same message.
      if (settleTimer !== null) {
        clearSettleTimer();
        extractedKey = null;
      }
      return;
    }
    const sessionId = context.sessionId as string;
    const messageId = context.lastAssistantMessageId as string;
    const key = batchKey(sessionId, messageId);
    if (extractedKey === key) return;
    // A held draw for the previous key is superseded by this reading.
    clearSettleTimer();
    const previousKey = extractedKey;
    // Marked BEFORE the await: a re-render during the request must not start a second one.
    extractedKey = key;
    const cached = cache.read(key);
    if (cached !== null) {
      applyResult(cached);
      publish();
      return;
    }
    const send = (): void => {
      if (disposed || extractedKey !== key) return;
      const requestId = ++extractionSeq;
      void (async () => {
        try {
          const result = await api.suggest({ sessionId }, { maxChips: maxChips() });
          if (disposed || requestId !== extractionSeq || context.sessionId !== sessionId) {
            return;
          }
          if (result === null) return;
          applyResult(result);
          cache.write(key, result);
          publish();
        } catch {
          // Silent fallback: the habit chips are already drawn by `useInputSuggestions`.
        }
      })();
    };
    // See REPLY_SUGGESTIONS_SESSION_SETTLE_MS: a message-id change that arrives
    // alongside a conversation switch is held one beat, so the corrected session
    // id can cancel it. Every other draw goes out at once.
    if (previousKey === null) {
      send();
      return;
    }
    settleTimer = clock.setTimeout(() => {
      settleTimer = null;
      send();
    }, REPLY_SUGGESTIONS_SESSION_SETTLE_MS);
  };

  /**
   * The first reading. A refused or failed `/status` leaves the feature off: the
   * composer then draws only its habit chips.
   */
  const loadStatus = (): void => {
    void (async () => {
      try {
        const reading = await api.status();
        if (disposed) return;
        status = reading;
        publish();
        maybeDraw();
      } catch {
        // The status endpoint is the feature's own switch; a failure is "off", never an error.
      }
    })();
  };

  const setContext = (next: ReplySuggestionsContext): void => {
    if (disposed) return;
    if (!started) {
      started = true;
      loadStatus();
    }
    const previousSessionId = context.sessionId;
    context = {
      sessionId: next.sessionId,
      lastAssistantMessageId: next.lastAssistantMessageId,
      active: next.active,
      focus: next.focus ?? null,
    };
    if (next.sessionId !== previousSessionId) {
      // Another conversation is a new batch: neither the previous session's chips
      // nor its extraction memory may leak across the switch, and every request
      // already in flight is invalidated by bumping its token.
      extractionSeq += 1;
      redrawSeq += 1;
      clearSettleTimer();
      extractedKey = null;
      loading = false;
      if (chips.length > 0) chips = [];
      draw = null;
      // The expansion chain belongs to one conversation's draft, never to the next one.
      expansionSeq += 1;
      expansionLoading = false;
      expansionDepth = 0;
      expansionSource = null;
      if (expansionChips.length > 0) expansionChips = [];
      publish();
    }
    maybeDraw();
  };

  const redraw = async (): Promise<boolean> => {
    const sessionId = context.sessionId;
    if (disposed || status?.enabled !== true || sessionId === null || loading) {
      return false;
    }
    // A fresh model batch answers the same message, not the draft: an expansion
    // chain anchored on the old pick no longer describes anything on screen.
    clearExpansion();
    loading = true;
    publish();
    const requestId = ++redrawSeq;
    const trimmedFocus = (context.focus ?? '').trim();
    try {
      const result = await api.suggest({
        sessionId,
        redraw: true,
        ...(trimmedFocus ? { focus: trimmedFocus } : {}),
      }, { maxChips: maxChips() });
      if (disposed || requestId !== redrawSeq || context.sessionId !== sessionId) {
        return false;
      }
      if (result === null) return false;
      applyResult(result);
      // The new batch replaces the remembered one for this message, so a switch
      // away and back restores what the person is looking at now.
      const messageId = context.lastAssistantMessageId;
      if (messageId !== null) {
        cache.write(batchKey(sessionId, messageId), result);
      }
      reportEvent('redrawn');
      return true;
    } catch {
      // A failed redraw keeps the previous batch on screen; the button shows its
      // short failure state on the `false` this returns.
      return false;
    } finally {
      if (requestId === redrawSeq) {
        loading = false;
        publish();
      }
    }
  };

  /**
   * One expansion draw. The two anchors are exclusive in practice: a picked reply
   * wins (`seed`), otherwise the quoted passage is the anchor (`focus`). The
   * response replaces the previous expansion chips wholesale.
   */
  const requestExpansion = (request: { seed?: string; focus?: string }): void => {
    const currentStatus = status;
    const sessionId = context.sessionId;
    if (disposed || currentStatus?.enabled !== true || currentStatus.expansion !== 'vary' || sessionId === null) {
      return;
    }
    if (expansionLoading || expansionDepth >= REPLY_SUGGESTIONS_MAX_EXPANSION_DEPTH) {
      return;
    }
    const seed = request.seed?.trim() ?? '';
    const focus = request.focus?.trim() ?? '';
    if (seed === '' && focus === '') return;
    const source: ReplySuggestionsExpansionSource = seed !== '' ? 'seed' : 'focus';
    const depth = expansionDepth + 1;
    const requestId = ++expansionSeq;
    expansionLoading = true;
    // The old chips answered the previous anchor; keeping them under a click that
    // is already in flight would let a second pick race the request.
    if (expansionChips.length > 0) expansionChips = [];
    expansionSource = null;
    publish();
    void (async () => {
      try {
        const result = await api.suggest({
          sessionId,
          expand: true,
          ...(seed === '' ? {} : { seed }),
          ...(focus === '' ? {} : { focus }),
        }, { maxChips: currentStatus.maxChips });
        if (disposed || expansionSeq !== requestId || context.sessionId !== sessionId) {
          return;
        }
        if (result === null) return;
        // The expansion batch is its own draw id: the `picked` event for one of
        // its chips must name this draw, not the model batch it grew from.
        draw = result.draw;
        expansionChips = result.chips;
        expansionSource = result.chips.length > 0 ? source : null;
        expansionDepth = depth;
      } catch {
        // A failed expansion leaves the draft and the chain depth as they were;
        // the person can still send what is in the box.
      } finally {
        if (!disposed && expansionSeq === requestId) {
          expansionLoading = false;
        }
        publish();
      }
    })();
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    setContext,
    redraw,
    requestExpansion,
    clearExpansion,
    reportEvent,
    dispose: () => {
      disposed = true;
      clearSettleTimer();
      listeners.clear();
    },
  };
}
