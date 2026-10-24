import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type {
  ReplySuggestionsEventName,
  ReplySuggestionsExpansionSource,
  ReplySuggestionsResult,
  ReplySuggestionsStatus,
} from '@/shared/types';

/**
 * How many consecutive expansion requests one pick chain may make. Clicking a
 * chip can expand again from its own text; past this depth the chip is accepted
 * as the draft and the chain stops.
 */
export const REPLY_SUGGESTIONS_MAX_EXPANSION_DEPTH = 5;

/**
 * How many `${sessionId}\u0000${assistantMessageId}` batches the page remembers.
 * Browser memory only: a reload empties it and the server cache answers instead.
 */
export const REPLY_SUGGESTIONS_BATCH_CACHE_SIZE = 20;

type CachedBatch = { chips: string[]; draw: number };

/**
 * Module-level, so it survives both a session switch and an unmount/remount of
 * the composer on the same page (a `useRef` would die with the hook instance).
 * Map insertion order is the LRU order: reading a key moves it to the end.
 */
const batchCache = new Map<string, CachedBatch>();

/** Test seam: forget every remembered batch. */
export function resetReplySuggestionsBatchCache(): void {
  batchCache.clear();
}

function batchKey(sessionId: string, messageId: string): string {
  return `${sessionId}\u0000${messageId}`;
}

function readCachedBatch(key: string): CachedBatch | null {
  const cached = batchCache.get(key);
  if (cached === undefined) return null;
  batchCache.delete(key);
  batchCache.set(key, cached);
  return cached;
}

function writeCachedBatch(key: string, batch: CachedBatch): void {
  // An empty batch is not a batch: remembering it would suppress the retry the
  // next visit should make. This mirrors the server, which never caches one.
  if (batch.chips.length === 0) {
    batchCache.delete(key);
    return;
  }
  batchCache.delete(key);
  batchCache.set(key, batch);
  while (batchCache.size > REPLY_SUGGESTIONS_BATCH_CACHE_SIZE) {
    const oldest = batchCache.keys().next().value;
    if (oldest === undefined) break;
    batchCache.delete(oldest);
  }
}

/**
 * The composer's LLM-generated reply chips and their Suggest button.
 *
 * Three rules shape this hook:
 *
 * - A draw belongs to one assistant message. The hook asks the server once for
 *   `${sessionId}:${lastAssistantMessageId}`. The batch it got back is kept in a
 *   page-level, 20-key in-memory table keyed the same way: a re-render, an
 *   emptied input box, a mounted/unmounted strip, or a switch back to a
 *   conversation restores that batch instead of requesting it again. A changed
 *   id (the assistant answered again) asks for a new draw. A reload loses the
 *   table and the server's cache answers, still without an upstream call.
 * - Disabled is silent. `/status` answers `enabled: false` for every install that
 *   has not opted in, and a failed draw falls back to the habit chips: nothing here
 *   throws into the composer or draws an error. The one exception is the Suggest
 *   control itself: it reports a failed redraw through `redraw`'s `false`, so a
 *   press with no answer is not mistaken for a press that did nothing.
 * - Absent when there is nothing to draw from. A conversation with no assistant
 *   message reads as `enabled: false`; the control is not offered as a no-op.
 * - The ledger is a readout. `picked` / `cleared` / `redrawn` / `sent` posts are
 *   fire-and-forget, and a refused write never changes the surface.
 *
 * The experimental expansion (settings `expansion: "vary"`) is a second draw on
 * the same message: a picked reply (`seed`) asks for variants, a quoted passage
 * (`focus`) asks for responses. Its chips live in their own state because they
 * answer the draft in the box, not the empty box the model batch is drawn for;
 * the chain caps at {@link REPLY_SUGGESTIONS_MAX_EXPANSION_DEPTH} requests and is
 * dropped whenever the draft is manually edited, cleared or sent.
 *
 * Consumers: `useChatComposerState` (which feeds the merged strip in
 * `useInputSuggestions`) and the reply-suggestions criterion.
 */
type UseReplySuggestionsOptions = {
  /** The open conversation, or null before one exists. */
  sessionId: string | null;
  /**
   * Stable identity of the last assistant message. Its change is the extraction
   * trigger; null means there is no answer to draw from yet.
   */
  lastAssistantMessageId: string | null;
  /**
   * The model chips' display conditions hold (empty box, idle, no menu, no queued
   * draft or attachment, no background job). Extraction follows visibility, so a
   * strip that is hidden never asks the server.
   */
  active: boolean;
  /** Transcript selection text sent as `focus` when the person asks for a fresh batch. */
  focus?: string | null;
};

export type UseReplySuggestionsResult = {
  /**
   * Whether the Suggest control should be drawn: the feature is on AND there is
   * an assistant message to draw replies from. A new conversation has nothing to
   * suggest from, so the control is absent rather than a silent no-op.
   */
  enabled: boolean;
  /** The full public reading, for the expandable strip's own limits. */
  status: ReplySuggestionsStatus | null;
  /** The current batch, in the server's order. Replaced wholesale, never appended. */
  chips: string[];
  /** The batch id the ledger events refer to. */
  draw: number | null;
  /** A draw is in flight: the Suggest button is disabled and shows its progress state. */
  loading: boolean;
  /**
   * Asks for a completely new batch (with `focus` when a selection exists).
   * Resolves true only when a fresh batch was applied, so the button can show a
   * short failure state instead of being a silent no-op when the request fails.
   */
  redraw: () => Promise<boolean>;
  /** Reports one ledger event; failures are swallowed. `source` marks an expansion pick. */
  reportEvent: (event: ReplySuggestionsEventName, index?: number, source?: ReplySuggestionsExpansionSource) => void;
  /** True when the settings say `expansion: "vary"` and the feature is otherwise on. */
  expansionEnabled: boolean;
  /** The variant/response chips for the draft in the box. Empty when no chain is live. */
  expansionChips: string[];
  /** Which anchor produced `expansionChips`: a picked reply or a quoted passage. */
  expansionSource: ReplySuggestionsExpansionSource | null;
  /** An expansion request is in flight. */
  expansionLoading: boolean;
  /** How many expansion requests this chain has made; resets when the chips are dropped. */
  expansionDepth: number;
  /** Whether another expansion may be requested (enabled and under the depth cap). */
  canExpand: boolean;
  /**
   * Asks for variants of `seed`, or responses to `focus` when the seed is empty.
   * A no-op while the feature is off, an expansion is already in flight, or the
   * chain is at {@link REPLY_SUGGESTIONS_MAX_EXPANSION_DEPTH}.
   */
  requestExpansion: (request: { seed?: string; focus?: string }) => void;
  /** Drops the expansion chips and resets the chain depth (manual edit, clear, send). */
  clearExpansion: () => void;
};

/** Reads the server's `{ chips, draw }` defensively: a malformed answer is an empty batch. */
function readDraw(body: unknown, maxChips: number): ReplySuggestionsResult {
  if (!body || typeof body !== 'object') {
    return { chips: [], draw: 0 };
  }
  const record = body as Record<string, unknown>;
  const chips: string[] = [];
  if (Array.isArray(record.chips)) {
    for (const item of record.chips) {
      if (typeof item !== 'string') continue;
      const text = item.trim();
      if (!text) continue;
      chips.push(text);
      if (chips.length >= maxChips) break;
    }
  }
  return {
    chips,
    draw: typeof record.draw === 'number' && Number.isFinite(record.draw) ? record.draw : 0,
  };
}

export function useReplySuggestions({
  sessionId,
  lastAssistantMessageId,
  active,
  focus = null,
}: UseReplySuggestionsOptions): UseReplySuggestionsResult {
  // The `/status` reading. Null is "not answered yet", which is deliberately not the
  // same as disabled: no request may leave before the server has said the feature is on.
  const [status, setStatus] = useState<ReplySuggestionsStatus | null>(null);
  // The batch currently on screen. Replaced by each successful draw; cleared on a session switch.
  const [chips, setChips] = useState<string[]>([]);
  // The batch id the ledger events carry.
  const [draw, setDraw] = useState<number | null>(null);
  // A redraw is in flight. State because the button draws from it; the ref is what
  // the synchronous re-entry guard checks.
  const [loading, setLoading] = useState(false);
  // The expansion experiment's chips, separate from the model batch: they answer
  // the draft in the box, so the empty-box strip cannot own them. `source` is
  // what each pick reports and `depth` caps the chain.
  const [expansionChips, setExpansionChips] = useState<string[]>([]);
  const [expansionSource, setExpansionSource] = useState<ReplySuggestionsExpansionSource | null>(null);
  const [expansionLoading, setExpansionLoading] = useState(false);
  const [expansionDepth, setExpansionDepth] = useState(0);

  const statusRef = useRef<ReplySuggestionsStatus | null>(null);
  const sessionRef = useRef<string | null>(sessionId);
  const drawRef = useRef<number | null>(null);
  // The `${session}:${message}` key this hook has already asked for.
  const extractedRef = useRef<string | null>(null);
  const loadingRef = useRef(false);
  const mountedRef = useRef(true);
  // Synchronous guards for the expansion chain, for the same reason `loadingRef`
  // exists: two clicks in one frame must not become two requests.
  const expansionLoadingRef = useRef(false);
  const expansionDepthRef = useRef(0);
  // Bumped on every request and on every clear, so a late answer from a chain the
  // person abandoned cannot repopulate the strip.
  const expansionRequestSeqRef = useRef(0);

  // Set true in the effect BODY, not only initialized true: React's development
  // StrictMode mounts, cleans up and mounts again, so a cleanup that only ever writes
  // `false` would leave the ref false for the component's whole life and the redraw
  // would never clear its own loading state.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // The four-field public reading, once per mount. A refused or failed read leaves the
  // feature off: the composer then draws only its habit chips.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await api.replySuggestions.status();
        if (!response.ok) return;
        const body = (await response.json()) as unknown;
        if (cancelled || !body || typeof body !== 'object') return;
        const record = body as Record<string, unknown>;
        setStatus({
          enabled: record.enabled === true,
          expansion: record.expansion === 'vary' ? 'vary' : 'off',
          maxChips: typeof record.maxChips === 'number' ? record.maxChips : 3,
          maxChipChars: typeof record.maxChipChars === 'number' ? record.maxChipChars : 120,
        });
      } catch {
        // The status endpoint is the feature's own switch; a failure is "off", never an error.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Another conversation is a new batch: neither the previous session's chips nor its
  // extraction memory may leak across the switch.
  useEffect(() => {
    sessionRef.current = sessionId;
    extractedRef.current = null;
    setChips((previous) => (previous.length === 0 ? previous : []));
    setDraw((previous) => (previous === null ? previous : null));
    drawRef.current = null;
    // The expansion chain belongs to one conversation's draft, never to the next one.
    expansionRequestSeqRef.current += 1;
    expansionLoadingRef.current = false;
    expansionDepthRef.current = 0;
    setExpansionLoading(false);
    setExpansionDepth(0);
    setExpansionSource(null);
    setExpansionChips((previous) => (previous.length === 0 ? previous : []));
  }, [sessionId]);

  /** Drops the expansion chips and resets the chain depth. A late answer is ignored. */
  const clearExpansion = useCallback(() => {
    expansionRequestSeqRef.current += 1;
    expansionLoadingRef.current = false;
    expansionDepthRef.current = 0;
    setExpansionLoading(false);
    setExpansionDepth(0);
    setExpansionSource(null);
    setExpansionChips((previous) => (previous.length === 0 ? previous : []));
  }, []);

  const applyResult = useCallback((result: ReplySuggestionsResult) => {
    setChips(result.chips);
    setDraw(result.draw);
    drawRef.current = result.draw;
  }, []);

  const applyDraw = useCallback((body: unknown): ReplySuggestionsResult => {
    const limit = statusRef.current?.maxChips ?? 3;
    const result = readDraw(body, limit);
    applyResult(result);
    return result;
  }, [applyResult]);

  const reportEvent = useCallback((
    event: ReplySuggestionsEventName,
    index?: number,
    source?: ReplySuggestionsExpansionSource,
  ) => {
    if (!sessionId) {
      return;
    }
    const payload = {
      sessionId,
      draw: drawRef.current ?? 0,
      event,
      ...(index === undefined ? {} : { index }),
      ...(source === undefined ? {} : { source }),
    };
    void (async () => {
      try {
        await api.replySuggestions.event(payload);
      } catch {
        // The ledger is a local readout; losing one row must not disturb the composer.
      }
    })();
  }, [sessionId]);

  // One draw per assistant message, and only while the chips could actually be seen.
  // A batch this page already drew for the same `${session}:${message}` is restored
  // from the in-memory table instead of being requested again: a conversation
  // switch or a remount costs nothing. A reload loses the table and falls back to
  // the server's cache, which still makes no upstream call.
  useEffect(() => {
    if (!status?.enabled || !active || !sessionId || !lastAssistantMessageId) {
      return undefined;
    }
    const key = batchKey(sessionId, lastAssistantMessageId);
    if (extractedRef.current === key) {
      return undefined;
    }
    // Marked BEFORE the await: a re-render during the request must not start a second one.
    extractedRef.current = key;
    const cached = readCachedBatch(key);
    if (cached !== null) {
      applyResult(cached);
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await api.replySuggestions.suggest({ sessionId });
        if (!response.ok) {
          return;
        }
        const body = (await response.json()) as unknown;
        if (cancelled || sessionRef.current !== sessionId) {
          return;
        }
        writeCachedBatch(key, applyDraw(body));
      } catch {
        // Silent fallback: the habit chips are already drawn by `useInputSuggestions`.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, applyDraw, applyResult, lastAssistantMessageId, sessionId, status]);

  /**
   * One expansion draw. The two anchors are exclusive in practice: a picked reply
   * wins (`seed`), otherwise the quoted passage is the anchor (`focus`). The
   * response replaces the previous expansion chips wholesale.
   */
  const requestExpansion = useCallback((request: { seed?: string; focus?: string }) => {
    const currentStatus = statusRef.current;
    if (!currentStatus?.enabled || currentStatus.expansion !== 'vary' || !sessionId) {
      return;
    }
    if (expansionLoadingRef.current || expansionDepthRef.current >= REPLY_SUGGESTIONS_MAX_EXPANSION_DEPTH) {
      return;
    }
    const seed = request.seed?.trim() ?? '';
    const focus = request.focus?.trim() ?? '';
    if (seed === '' && focus === '') {
      return;
    }
    const source: ReplySuggestionsExpansionSource = seed !== '' ? 'seed' : 'focus';
    const depth = expansionDepthRef.current + 1;
    expansionRequestSeqRef.current += 1;
    const requestId = expansionRequestSeqRef.current;
    expansionLoadingRef.current = true;
    setExpansionLoading(true);
    // The old chips answered the previous anchor; keeping them under a click that
    // is already in flight would let a second pick race the request.
    setExpansionChips((previous) => (previous.length === 0 ? previous : []));
    setExpansionSource(null);
    void (async () => {
      try {
        const response = await api.replySuggestions.suggest({
          sessionId,
          expand: true,
          ...(seed === '' ? {} : { seed }),
          ...(focus === '' ? {} : { focus }),
        });
        if (!response.ok) {
          return;
        }
        const body = (await response.json()) as unknown;
        if (
          sessionRef.current !== sessionId
          || expansionRequestSeqRef.current !== requestId
          || !mountedRef.current
        ) {
          return;
        }
        const result = readDraw(body, statusRef.current?.maxChips ?? 3);
        // The expansion batch is its own draw id: the `picked` event for one of
        // its chips must name this draw, not the model batch it grew from.
        drawRef.current = result.draw;
        setDraw(result.draw);
        setExpansionChips(result.chips);
        setExpansionSource(result.chips.length > 0 ? source : null);
        expansionDepthRef.current = depth;
        setExpansionDepth(depth);
      } catch {
        // A failed expansion leaves the draft and the chain depth as they were;
        // the person can still send what is in the box.
      } finally {
        if (expansionRequestSeqRef.current === requestId) {
          expansionLoadingRef.current = false;
          if (mountedRef.current) {
            setExpansionLoading(false);
          }
        }
      }
    })();
  }, [sessionId]);

  const redraw = useCallback(async (): Promise<boolean> => {
    if (!statusRef.current?.enabled || !sessionId || loadingRef.current) {
      return false;
    }
    // A fresh model batch answers the same message, not the draft: an expansion
    // chain anchored on the old pick no longer describes anything on screen.
    clearExpansion();
    loadingRef.current = true;
    setLoading(true);
    const trimmedFocus = focus?.trim() ?? '';
    try {
      const response = await api.replySuggestions.suggest({
        sessionId,
        redraw: true,
        ...(trimmedFocus ? { focus: trimmedFocus } : {}),
      });
      if (!response.ok) {
        return false;
      }
      const body = (await response.json()) as unknown;
      if (sessionRef.current !== sessionId) {
        return false;
      }
      const result = applyDraw(body);
      // The new batch replaces the remembered one for this message, so a switch
      // away and back restores what the person is looking at now.
      if (lastAssistantMessageId !== null) {
        writeCachedBatch(batchKey(sessionId, lastAssistantMessageId), result);
      }
      reportEvent('redrawn');
      return true;
    } catch {
      // A failed redraw keeps the previous batch on screen; the button shows its
      // short failure state on the `false` this returns.
      return false;
    } finally {
      loadingRef.current = false;
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [applyDraw, clearExpansion, focus, lastAssistantMessageId, reportEvent, sessionId]);

  return {
    // A conversation with no assistant message has nothing to suggest from: the
    // control is absent rather than a silent no-op, matching the disabled case.
    enabled: status?.enabled === true && lastAssistantMessageId !== null,
    status,
    chips,
    draw,
    loading,
    redraw,
    reportEvent,
    expansionEnabled: status?.enabled === true && status.expansion === 'vary',
    expansionChips,
    expansionSource,
    expansionLoading,
    expansionDepth,
    canExpand: status?.enabled === true
      && status.expansion === 'vary'
      && expansionDepth < REPLY_SUGGESTIONS_MAX_EXPANSION_DEPTH,
    requestExpansion,
    clearExpansion,
  };
}
