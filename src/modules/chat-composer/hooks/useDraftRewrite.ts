import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { api } from '@/shared/api';
import {
  createDraftRewriteController,
  type DraftRewriteSnapshot,
} from '@/modules/chat-composer/utils/draftRewriteController';

/**
 * The React binding for the composer's ✦ draft-rewrite candidate.
 *
 * Every rule lives in {@link createDraftRewriteController}: the one-in-flight request, the
 * draft/scope snapshot a late answer is valid for, the collapsed candidate cache, the apply
 * guard and the reset points. This hook only subscribes, hands the current
 * session/scope/draft/enabled reading to `setContext` in one effect, and disposes on unmount.
 *
 * THE WRITER IS THE COMPOSER'S. `writeDraft` is the caller's one draft path (state +
 * send-time mirror + voice-range remap + chip attribution); this hook neither knows nor
 * duplicates it, and nothing here ever submits a message.
 *
 * Consumers: `useChatComposerState` (which owns the writer and the reset points) and the
 * composer criterion.
 */
type UseDraftRewriteOptions = {
  /** The open conversation, or null before one exists. */
  sessionId: string | null;
  /** The composer's draft scope (session id, or `project:<id>` before the first send). */
  draftScope: string | null;
  /** The draft exactly as the textarea shows it. */
  draft: string;
  /** The shared reply-suggestions feature switch; `null` while the shared reading is pending. */
  enabled: boolean | null;
  /** Writes the candidate through the composer's single draft path; never submits. */
  writeDraft: (text: string) => void;
};

export type UseDraftRewriteResult = DraftRewriteSnapshot & {
  /** Expand, restoring a cached candidate or starting the one request. */
  openOrRequest: () => void;
  /** Fold the panel; the candidate (and an in-flight request) survive. */
  collapse: () => void;
  /** Ask again; a no-op while a request is in flight. */
  retry: () => void;
  /** Replace the draft with the candidate through the composer's writer, then fold. */
  apply: () => void;
  /** Drop the candidate now (also driven by the composer's edit/clear/send paths). */
  invalidate: () => void;
  /** Drop the candidate, the error and the panel (clear/send/scope switch). */
  reset: () => void;
};

export function useDraftRewrite({
  sessionId,
  draftScope,
  draft,
  enabled,
  writeDraft,
}: UseDraftRewriteOptions): UseDraftRewriteResult {
  // The controller must outlive renders (it holds the candidate cache), but the writer it calls
  // must be the CURRENT composer callback: an edit changes the voice range and chip attribution
  // closures. A ref keeps the controller's identity stable and its writer current.
  const writeDraftRef = useRef(writeDraft);
  useEffect(() => {
    writeDraftRef.current = writeDraft;
  }, [writeDraft]);
  const writeDraftStable = useCallback((text: string) => {
    writeDraftRef.current(text);
  }, []);

  const controller = useMemo(
    () => createDraftRewriteController({
      // Property access is deferred to the call: a composer test that doubles `api` without the
      // rewrite verb can still mount (the verb is only reached when the chip is pressed).
      api: { rewrite: (request) => api.replySuggestions.draftRewrite(request) },
      writeDraft: writeDraftStable,
    }),
    [writeDraftStable],
  );
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  /**
   * The shared feature switch, read from the same `/status` endpoint the chip strip uses.
   *
   * WHY A FALLBACK AT ALL: the reply-suggestions hook constructs its controller once and disposes
   * it from an effect cleanup; React's development StrictMode runs that cleanup and re-runs the
   * effect on the same instance, so its `status` stays null in a Vite dev page while a request is
   * already in hand. The prop is authoritative when it is a boolean (`false` is a real "off" and
   * must NOT trigger a second read); only a still-pending `null` after one beat falls back to the
   * same public reading. In tests and production the prop arrives, so exactly one status call is
   * made by the existing hook — this hook adds none.
   */
  const [fallbackEnabled, setFallbackEnabled] = useState(false);
  useEffect(() => {
    if (enabled !== null) return undefined;
    let alive = true;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const statusApi = api.replySuggestions;
          if (statusApi === undefined || typeof statusApi.status !== 'function') return;
          const reading = await statusApi.status();
          if (alive && reading !== null && reading.enabled) setFallbackEnabled(true);
        } catch {
          // A refused status is "off": the same fail-closed reading the controller uses.
        }
      })();
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [enabled]);
  const effectiveEnabled = enabled === true || fallbackEnabled;

  /**
   * The controller's lifetime, StrictMode-safe.
   *
   * A dev StrictMode mount runs the cleanup and the setup again on the SAME controller; a plain
   * `dispose()` in the cleanup would leave the second mount with a dead instance (no status, no
   * candidate). Disposal is therefore deferred one task and cancelled by the next setup; a real
   * unmount has no next setup, so the timer fires and the controller is disposed for good.
   */
  const disposeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (disposeTimer.current !== null) {
      clearTimeout(disposeTimer.current);
      disposeTimer.current = null;
    }
    controller.setContext({ sessionId, draftScope, draft, enabled: effectiveEnabled });
    return () => {
      disposeTimer.current = setTimeout(() => {
        disposeTimer.current = null;
        controller.dispose();
      }, 0);
    };
  }, [controller, draft, draftScope, effectiveEnabled, sessionId]);

  return {
    available: snapshot.available,
    expanded: snapshot.expanded,
    loading: snapshot.loading,
    candidate: snapshot.candidate,
    failure: snapshot.failure,
    openOrRequest: controller.openOrRequest,
    collapse: controller.collapse,
    retry: controller.retry,
    apply: controller.apply,
    invalidate: controller.invalidate,
    reset: controller.reset,
  };
}
