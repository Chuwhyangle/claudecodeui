import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '@/shared/api';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import {
  defaultClock,
  playNotificationSound,
  syncAwaitingReplyTitleIndicator,
} from '@/shared/utils';
import { createAwaitingReplyController } from '@/modules/sidebar/utils/awaitingReplyController';
import type {
  AwaitingReplyChangedEvent,
  AwaitingReplyListItem,
  AwaitingReplyListState,
} from '@/shared/awaitingReplyType';

/**
 * The REST envelope both awaiting-reply routes answer with: the server builds
 * every success body through `createApiSuccessResponse`, so the rows always sit
 * one `data` level down.
 */
type AwaitingReplyApiPayload = {
  success?: boolean;
  data?: {
    sessions?: AwaitingReplyListItem[];
  };
};

/** The user-facing sentence for the last failed read, from the sidebar namespace. */
const LOAD_ERROR_KEY = 'awaitingReply.loadError';
const LOAD_ERROR_FALLBACK = 'Could not load the list.';

/**
 * The sidebar's awaiting-reply list, read once per page and shared by the header
 * badge and the list view.
 *
 * Used by `useSidebarController`, which hands the result to `SidebarHeader` (the
 * count) and to `AwaitingReplyView` (the rows) — one hook instance, so the badge
 * and the rows cannot describe two different lists.
 *
 * The React half only binds; every rule — newest-read-wins, the optimistic
 * dismissal and its in-place restore, the chime throttle, history-vs-news —
 * lives in the React-free controller under `utils/awaitingReplyController.ts`,
 * so those rules are testable without rendering anything.
 */
export function useAwaitingReplySessions(): AwaitingReplyListState {
  const { subscribe, isConnected } = useWebSocket();
  const { t } = useTranslation('sidebar');

  // Read through a ref so the controller — created once — always renders the
  // current language's sentence without being rebuilt (a rebuild would drop the
  // list and re-run the first read on every locale change). Updated in an effect
  // rather than during render so a render never writes a ref.
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const controller = useMemo(
    () => createAwaitingReplyController({
      listSessions: async () => {
        const response = await api.awaitingReplySessions();
        if (!response.ok) {
          throw new Error(`Failed to load awaiting reply sessions: ${response.status}`);
        }
        const payload = (await response.json()) as AwaitingReplyApiPayload;
        return Array.isArray(payload.data?.sessions) ? payload.data.sessions : [];
      },
      dismissSession: async (sessionId: string) => {
        const response = await api.dismissAwaitingReply(sessionId);
        if (!response.ok) {
          throw new Error(`Failed to remove the session from awaiting reply: ${response.status}`);
        }
      },
      playChime: () => playNotificationSound(),
      syncTitle: syncAwaitingReplyTitleIndicator,
      loadErrorMessage: () => tRef.current(LOAD_ERROR_KEY, LOAD_ERROR_FALLBACK),
      reportError: (message, failure) => console.error(message, failure),
      clock: defaultClock,
    }),
    [],
  );

  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  useEffect(() => {
    controller.start();
    return () => controller.dispose();
  }, [controller]);

  // A pushed frame is a complete list, so it replaces the local copy outright
  // and invalidates any read still in flight.
  useEffect(() => subscribe((event) => {
    if (event.kind !== 'awaiting_reply_changed') {
      return;
    }

    const snapshotEvent = event as unknown as AwaitingReplyChangedEvent;
    if (!Array.isArray(snapshotEvent.sessions)) {
      return;
    }

    controller.acceptSnapshot(snapshotEvent.sessions);
  }), [controller, subscribe]);

  // The fallback for a page left open: a tab that was hidden through a whole
  // turn heard the frame on a socket that may already have been replaced, so
  // coming back to the window re-reads what the server holds now.
  useEffect(() => {
    const handleFocus = (): void => {
      void controller.reload();
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [controller]);

  return {
    sessions: snapshot.sessions,
    count: snapshot.sessions.length,
    isLoading: snapshot.isLoading,
    error: snapshot.error,
    isConnected,
    dismiss: controller.dismiss,
    reload: controller.reload,
  };
}
