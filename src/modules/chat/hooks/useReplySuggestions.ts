import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { api } from '@/shared/api';
import {
  createReplySuggestionsController,
  replySuggestionsBatchCache,
} from '@/modules/chat/utils/replySuggestionsController';
import type {
  ReplySuggestionsEventName,
  ReplySuggestionsExpansionSource,
  ReplySuggestionsStatus,
} from '@/shared/types';

/**
 * The composer's LLM-generated reply chips and their Suggest button.
 *
 * Every rule lives in {@link createReplySuggestionsController}: when a draw is
 * allowed, which assistant message owns it, the page-level batch cache, the
 * stale-answer guards, the expansion chain's depth and ordering, and the ledger.
 * This hook is the React binding only — it subscribes to the controller's
 * snapshot with `useSyncExternalStore`, hands the session/message/visibility
 * reading to `setContext` in one effect, and disposes the controller on unmount.
 *
 * The result is grouped by surface: `firstDraw` is the empty-box batch and its
 * Suggest control, `expansion` is the post-pick chain, and the readings every
 * chip surface shares (`enabled`, `status`) stay top-level.
 *
 * Consumers: `useSuggestionChips` and the reply-suggestions criteria.
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
   * draft or attachment). Extraction follows visibility: a hidden strip never asks.
   */
  active: boolean;
  /** Transcript selection text sent as `focus` when the person asks for a fresh batch. */
  focus?: string | null;
};

export type UseReplySuggestionsResult = {
  /** The feature is on AND there is an assistant message to draw replies from. */
  enabled: boolean;
  /** The full public reading, for the expandable strip's own limits. */
  status: ReplySuggestionsStatus | null;
  /** The empty-box model batch and its Suggest control. */
  firstDraw: {
    /** The current batch, in the server's order. Replaced wholesale, never appended. */
    chips: string[];
    /** The batch id the ledger events refer to. */
    draw: number | null;
    /** A draw is in flight: the Suggest button is disabled and shows its progress state. */
    loading: boolean;
    /**
     * Asks for a new batch (with `focus` when a selection exists); resolves true
     * only when one was applied, so the button can show a short failure state.
     */
    redraw: () => Promise<boolean>;
  };
  /** The experimental expansion chain anchored on the draft in the box. */
  expansion: {
    /** True when the settings say `expansion: "vary"` and the feature is otherwise on. */
    enabled: boolean;
    /** The variant/response chips; empty when no chain is live. */
    chips: string[];
    /** Which anchor produced `chips`: a picked reply or a quoted passage. */
    source: ReplySuggestionsExpansionSource | null;
    /** An expansion request is in flight. */
    loading: boolean;
    /** How many expansion requests this chain has made; resets when the chips are dropped. */
    depth: number;
    /** Whether another expansion may be requested (enabled and under the depth cap). */
    canExpand: boolean;
    /**
     * Asks for variants of `seed` (or responses to `focus` when it is empty). A
     * no-op while the feature is off, a request is in flight, or at the cap.
     */
    request: (request: { seed?: string; focus?: string }) => void;
    /** Drops the expansion chips and resets the chain depth (manual edit, clear, send). */
    clear: () => void;
  };
  /** Reports one ledger event; failures are swallowed. `source` marks an expansion pick. */
  reportEvent: (
    event: ReplySuggestionsEventName,
    index?: number,
    source?: ReplySuggestionsExpansionSource,
  ) => void;
};

/** One controller per composer mount; the module-level cache keeps batches across mounts. */
export function useReplySuggestions({
  sessionId,
  lastAssistantMessageId,
  active,
  focus = null,
}: UseReplySuggestionsOptions): UseReplySuggestionsResult {
  const controller = useMemo(
    () => createReplySuggestionsController({
      api: api.replySuggestions,
      cache: replySuggestionsBatchCache,
    }),
    [],
  );
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  // The page's reading is handed over once per change; the controller decides
  // whether that means a new draw, a restore, or nothing at all.
  useEffect(() => {
    controller.setContext({ sessionId, lastAssistantMessageId, active, focus });
  }, [active, controller, focus, lastAssistantMessageId, sessionId]);

  // A controller owns timers and subscribers; the composer leaving the page ends them.
  useEffect(() => () => controller.dispose(), [controller]);

  return {
    enabled: snapshot.enabled,
    status: snapshot.status,
    firstDraw: {
      chips: snapshot.chips,
      draw: snapshot.draw,
      loading: snapshot.loading,
      redraw: controller.redraw,
    },
    expansion: {
      enabled: snapshot.expansionEnabled,
      chips: snapshot.expansionChips,
      source: snapshot.expansionSource,
      loading: snapshot.expansionLoading,
      depth: snapshot.expansionDepth,
      canExpand: snapshot.canExpand,
      request: controller.requestExpansion,
      clear: controller.clearExpansion,
    },
    reportEvent: controller.reportEvent,
  };
}
