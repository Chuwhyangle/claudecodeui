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
  /** The shared reply-suggestions feature is enabled for this deployment. */
  enabled: boolean;
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
      api: { rewrite: api.replySuggestions.draftRewrite },
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
   * WHY BESIDE THE PROP: the reply-suggestions hook constructs its controller once and disposes
   * it from an effect cleanup; React's development StrictMode runs that cleanup and re-runs the
   * effect on the same instance, so its `status` stays null in a Vite dev page. Reading the same
   * public reading here (the settings are shared, not duplicated) keeps the ✦ chip available in
   * development and in production, and the prop still wins where a caller injects the reading.
   */
  const [featureEnabled, setFeatureEnabled] = useState(false);
  useEffect(() => {
    let alive = true;
    void api.replySuggestions.status()
      .then((reading) => {
        if (alive && reading !== null && reading.enabled) setFeatureEnabled(true);
      })
      .catch(() => {
        // A refused status is "off": the same fail-closed reading the controller uses.
      });
    return () => {
      alive = false;
    };
  }, []);
  const effectiveEnabled = enabled || featureEnabled;

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
