import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type {
  ReplySuggestionsEventName,
  ReplySuggestionsResult,
  ReplySuggestionsStatus,
} from '@/shared/types';

/**
 * The composer's LLM-generated reply chips and their Suggest button.
 *
 * Three rules shape this hook:
 *
 * - A draw belongs to one assistant message. The hook remembers
 *   `${sessionId}:${lastAssistantMessageId}` and asks the server once for it, so a
 *   re-render, an emptied input box or a mounted/unmounted strip never becomes a
 *   second request. A changed id (the assistant answered again) or another
 *   conversation re-arms it.
 * - Disabled is silent. `/status` answers `enabled: false` for every install that
 *   has not opted in, and a failed draw falls back to the habit chips: nothing here
 *   throws into the composer or draws an error.
 * - The ledger is a readout. `picked` / `cleared` / `redrawn` / `sent` posts are
 *   fire-and-forget, and a refused write never changes the surface.
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
  /** Whether the feature is on. False until `/status` answers, so no draw is ever a guess. */
  enabled: boolean;
  /** The full public reading, for the expandable strip's own limits. */
  status: ReplySuggestionsStatus | null;
  /** The current batch, in the server's order. Replaced wholesale, never appended. */
  chips: string[];
  /** The batch id the ledger events refer to. */
  draw: number | null;
  /** A draw is in flight: the Suggest button is disabled and shows its progress state. */
  loading: boolean;
  /** Asks for a completely new batch (with `focus` when a selection exists). */
  redraw: () => void;
  /** Reports one ledger event; failures are swallowed. */
  reportEvent: (event: ReplySuggestionsEventName, index?: number) => void;
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

  const statusRef = useRef<ReplySuggestionsStatus | null>(null);
  const sessionRef = useRef<string | null>(sessionId);
  const drawRef = useRef<number | null>(null);
  // The `${session}:${message}` key this hook has already asked for.
  const extractedRef = useRef<string | null>(null);
  const loadingRef = useRef(false);
  const mountedRef = useRef(true);

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
  }, [sessionId]);

  const applyDraw = useCallback((body: unknown) => {
    const limit = statusRef.current?.maxChips ?? 3;
    const result = readDraw(body, limit);
    setChips(result.chips);
    setDraw(result.draw);
    drawRef.current = result.draw;
  }, []);

  const reportEvent = useCallback((event: ReplySuggestionsEventName, index?: number) => {
    if (!sessionId) {
      return;
    }
    const payload = {
      sessionId,
      draw: drawRef.current ?? 0,
      event,
      ...(index === undefined ? {} : { index }),
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
  useEffect(() => {
    if (!status?.enabled || !active || !sessionId || !lastAssistantMessageId) {
      return undefined;
    }
    const key = `${sessionId}:${lastAssistantMessageId}`;
    if (extractedRef.current === key) {
      return undefined;
    }
    // Marked BEFORE the await: a re-render during the request must not start a second one.
    extractedRef.current = key;
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
        applyDraw(body);
      } catch {
        // Silent fallback: the habit chips are already drawn by `useInputSuggestions`.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, applyDraw, lastAssistantMessageId, sessionId, status]);

  const redraw = useCallback(() => {
    if (!statusRef.current?.enabled || !sessionId || loadingRef.current) {
      return;
    }
    loadingRef.current = true;
    setLoading(true);
    const trimmedFocus = focus?.trim() ?? '';
    void (async () => {
      try {
        const response = await api.replySuggestions.suggest({
          sessionId,
          redraw: true,
          ...(trimmedFocus ? { focus: trimmedFocus } : {}),
        });
        if (!response.ok) {
          return;
        }
        const body = (await response.json()) as unknown;
        if (sessionRef.current !== sessionId) {
          return;
        }
        applyDraw(body);
        reportEvent('redrawn');
      } catch {
        // A failed redraw keeps the previous batch on screen; the button simply recovers.
      } finally {
        loadingRef.current = false;
        if (mountedRef.current) {
          setLoading(false);
        }
      }
    })();
  }, [applyDraw, focus, reportEvent, sessionId]);

  return {
    enabled: status?.enabled === true,
    status,
    chips,
    draw,
    loading,
    redraw,
    reportEvent,
  };
}
