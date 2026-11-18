import type {
  Clock,
  ReplySuggestionsEventInput,
  ReplySuggestionsEventName,
  ReplySuggestionsExpansionSource,
  ReplySuggestionsFailure,
  ReplySuggestionsRequest,
  ReplySuggestionsResult,
  ReplySuggestionsStatus,
  ReplySuggestionsSuggestResponse,
} from '@/shared/types';
import { createBoundedLru, createExternalStore, defaultClock } from '@/shared/utils';

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
 * - A failed draw is visible, never thrown. A refused `/status` still falls back to
 *   the habit chips, but a failed automatic draw becomes the snapshot's `failure`
 *   episode (the inline notice); any later success clears it. The same
 *   `code + httpStatus + requestId` only advances the count. `dismissFailure` hides
 *   the notice for this session without erasing the episode; a conversation switch
 *   resets both. `redraw` keeps returning `false` so the button can show its short
 *   failure state.
 * - The experimental expansion (`expansion: "vary"`) is a second draw on the same
 *   message: a picked reply (`seed`) asks for variants of that reply. Its chips
 *   live beside the model batch because they answer the draft in the box, not the
 *   empty box the model batch is drawn for; the chain caps at
 *   {@link REPLY_SUGGESTIONS_MAX_EXPANSION_DEPTH} and is dropped whenever the
 *   draft is edited, cleared or sent.
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

/** Starts and cancels the one settle timer, and stamps a failure's observation time;
 * injectable so tests need no wall clock. */
export type ReplySuggestionsClock = Pick<Clock, 'setTimeout' | 'clearTimeout'> & { now?: () => number };

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
  const batches = createBoundedLru<string, CachedBatch>(capacity);

  const read = (key: string): CachedBatch | null => batches.get(key) ?? null;

  const write = (key: string, batch: CachedBatch): void => {
    // An empty batch is not a batch: remembering it would suppress the retry the
    // next visit should make. This mirrors the server, which never caches one.
    if (batch.chips.length === 0) {
      batches.delete(key);
      return;
    }
    // `set` refreshes recency and evicts the oldest key past capacity.
    batches.set(key, batch);
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
 * The three endpoint calls the controller makes. `status` answers `null` for a
 * refused or unreadable response (which reads as the feature being off);
 * `suggest` answers the typed discriminated result, so a refusal is a failure
 * episode rather than an ambiguous "nothing".
 */
export type ReplySuggestionsApi = {
  status: () => Promise<ReplySuggestionsStatus | null>;
  suggest: (
    request: ReplySuggestionsRequest,
    options?: { maxChips?: number },
  ) => Promise<ReplySuggestionsSuggestResponse>;
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
  /** Which anchor produced `expansionChips`: the picked reply (`seed`). */
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
  /** The failure episode this session is showing, or null after a success. */
  failure: ReplySuggestionsFailure | null;
  /** True once the person dismissed the notice; auto-shown failures stay hidden for this session. */
  failureDismissed: boolean;
  /** How many consecutive failures the current episode has counted. */
  failureCount: number;
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
  /** Asks for variants of `seed`; a blank seed asks for nothing. */
  requestExpansion: (request: { seed: string }) => void;
  /** Drops the expansion chips and resets the chain depth. */
  clearExpansion: () => void;
  /** Reports one ledger event; failures are swallowed. */
  reportEvent: (
    event: ReplySuggestionsEventName,
    index?: number,
    source?: ReplySuggestionsExpansionSource,
  ) => void;
  /** Hides the failure notice for the rest of this session; the episode is kept. */
  dismissFailure: () => void;
  /** Stops timers and subscribers; a controller is not reusable afterwards. */
  dispose: () => void;
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
  const now = clock.now ?? defaultClock.now;
  const cache = options.cache ?? createReplySuggestionsBatchCache();

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
  let failure: ReplySuggestionsFailure | null = null;
  let failureCount = 0;
  let failureDismissed = false;

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
    failure,
    failureCount,
    failureDismissed,
    // A conversation with no assistant message has nothing to suggest from: the
    // control is absent rather than a silent no-op, matching the disabled case.
    enabled: status?.enabled === true && context.lastAssistantMessageId !== null,
    expansionEnabled: status?.enabled === true && status.expansion === 'vary',
    canExpand: status?.enabled === true
      && status.expansion === 'vary'
      && expansionDepth < REPLY_SUGGESTIONS_MAX_EXPANSION_DEPTH,
  });

  const store = createExternalStore<ReplySuggestionsSnapshot>(buildSnapshot());

  /** Rebuilds the snapshot and notifies only when a published field changed. */
  const publish = (): void => {
    if (disposed) return;
    const next = buildSnapshot();
    const previous = store.getSnapshot();
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
      && previous.failure === next.failure
      && previous.failureCount === next.failureCount
      && previous.failureDismissed === next.failureDismissed
    ) {
      return;
    }
    store.set(next);
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

  /** The typed failure of a thrown call, which has no server body to read. */
  const transportFailure = (reason: unknown): ReplySuggestionsFailure => ({
    at: new Date(now()).toISOString(),
    code: 'unknown',
    category: 'network',
    httpStatus: null,
    requestId: null,
    model: null,
    message: reason instanceof Error ? reason.message : String(reason),
  });

  /**
   * One failure episode. The same `code + httpStatus + requestId` is the same
   * failure arriving again: it only advances the count and the timestamp instead
   * of being announced as new. A different failure starts a new episode.
   */
  const applyFailure = (next: ReplySuggestionsFailure): void => {
    const sameEpisode = failure !== null
      && failure.code === next.code
      && failure.httpStatus === next.httpStatus
      && next.requestId !== null
      && failure.requestId === next.requestId;
    failureCount = sameEpisode ? failureCount + 1 : 1;
    failure = next;
    publish();
  };

  /** A success means the feature works again; the notice goes, the dismissal stands. */
  const clearFailure = (): void => {
    if (failure === null && failureCount === 0) return;
    failure = null;
    failureCount = 0;
    publish();
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
          const response = await api.suggest({ sessionId }, { maxChips: maxChips() });
          if (disposed || requestId !== extractionSeq || context.sessionId !== sessionId) {
            return;
          }
          if (!response.ok) {
            // A refused draw is a visible episode now, not a silent fallback.
            applyFailure(response.failure);
            return;
          }
          clearFailure();
          applyResult(response.result);
          cache.write(key, response.result);
          publish();
        } catch (reason) {
          if (disposed || requestId !== extractionSeq || context.sessionId !== sessionId) return;
          applyFailure(transportFailure(reason));
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
   * A misconfigured settings file is the one non-draw failure the composer can
   * name: the feature is asked for but a required item is missing. It becomes the
   * same episode a failed draw produces, so the inline notice explains it instead
   * of the surface staying blank; a fixed configuration clears it again.
   */
  const applyStatusFailure = (reading: ReplySuggestionsStatus | null): void => {
    if (reading?.state === 'misconfigured') {
      if (failure === null || failure.category !== 'misconfigured') {
        failure = {
          at: new Date(now()).toISOString(),
          code: 'REPLY_SUGGESTIONS_MISCONFIGURED',
          category: 'misconfigured',
          httpStatus: null,
          requestId: null,
          model: null,
          message: reading.problems.join('; ') || 'reply suggestions are not fully configured',
        };
        failureCount = 1;
      }
      return;
    }
    if (failure?.category === 'misconfigured') {
      failure = null;
      failureCount = 0;
    }
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
        applyStatusFailure(reading);
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
      // A failure episode and its dismissal belong to the conversation that saw
      // it; another conversation starts visible again.
      failure = null;
      failureCount = 0;
      failureDismissed = false;
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
      const response = await api.suggest({
        sessionId,
        redraw: true,
        ...(trimmedFocus ? { focus: trimmedFocus } : {}),
      }, { maxChips: maxChips() });
      if (disposed || requestId !== redrawSeq || context.sessionId !== sessionId) {
        return false;
      }
      if (!response.ok) {
        // A manual retry that fails updates the episode too; the button keeps its
        // own short `failed` reading from the `false` returned here.
        applyFailure(response.failure);
        return false;
      }
      clearFailure();
      applyResult(response.result);
      // The new batch replaces the remembered one for this message, so a switch
      // away and back restores what the person is looking at now.
      const messageId = context.lastAssistantMessageId;
      if (messageId !== null) {
        cache.write(batchKey(sessionId, messageId), response.result);
      }
      reportEvent('redrawn');
      return true;
    } catch (reason) {
      if (!disposed && requestId === redrawSeq && context.sessionId === sessionId) {
        applyFailure(transportFailure(reason));
      }
      return false;
    } finally {
      if (requestId === redrawSeq) {
        loading = false;
        publish();
      }
    }
  };

  /**
   * One expansion draw. The anchor is always a picked reply (`seed`) — the
   * response replaces the previous expansion chips wholesale.
   */
  const requestExpansion = (request: { seed: string }): void => {
    const currentStatus = status;
    const sessionId = context.sessionId;
    if (disposed || currentStatus?.enabled !== true || currentStatus.expansion !== 'vary' || sessionId === null) {
      return;
    }
    if (expansionLoading || expansionDepth >= REPLY_SUGGESTIONS_MAX_EXPANSION_DEPTH) {
      return;
    }
    const seed = request.seed.trim();
    if (seed === '') return;
    const source: ReplySuggestionsExpansionSource = 'seed';
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
        const response = await api.suggest({
          sessionId,
          expand: true,
          seed,
        }, { maxChips: currentStatus.maxChips });
        if (disposed || expansionSeq !== requestId || context.sessionId !== sessionId) {
          return;
        }
        if (!response.ok) {
          // An expansion draw answers the draft in the box; a refusal is the same
          // visible episode as a failed model draw.
          applyFailure(response.failure);
          return;
        }
        // The expansion batch is its own draw id: the `picked` event for one of
        // its chips must name this draw, not the model batch it grew from.
        draw = response.result.draw;
        expansionChips = response.result.chips;
        expansionSource = response.result.chips.length > 0 ? source : null;
        expansionDepth = depth;
        clearFailure();
      } catch (reason) {
        // A failed expansion leaves the draft and the chain depth as they were;
        // the person can still send what is in the box.
        if (!disposed && expansionSeq === requestId) applyFailure(transportFailure(reason));
      } finally {
        if (!disposed && expansionSeq === requestId) {
          expansionLoading = false;
        }
        publish();
      }
    })();
  };

  return {
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,
    setContext,
    redraw,
    requestExpansion,
    clearExpansion,
    reportEvent,
    dismissFailure: () => {
      if (failureDismissed) return;
      failureDismissed = true;
      publish();
    },
    dispose: () => {
      disposed = true;
      clearSettleTimer();
    },
  };
}
