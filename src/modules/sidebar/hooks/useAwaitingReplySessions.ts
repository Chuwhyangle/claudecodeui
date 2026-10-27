import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '@/shared/api';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type {
  AwaitingReplyChangedEvent,
  AwaitingReplyListItem,
  AwaitingReplyListState,
} from '@/shared/types';

/**
 * The REST envelope both awaiting-reply routes answer with: the server builds
 * every success body through `createApiSuccessResponse`, so the rows always sit
 * one `data` level down. Read the same way `fetchArchivedSessions` reads the
 * archive listing in `useSidebarController`.
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
 * Three ways the list arrives, in the order they are trusted:
 *  - on mount and on every window `focus`, a whole-list read, because a tab left
 *    open for hours would otherwise never learn about a wait that began while it
 *    was hidden;
 *  - on every `awaiting_reply_changed` frame, the snapshot the server assembled
 *    itself. The frame carries the WHOLE list, so it replaces the local copy
 *    instead of being merged: a row dismissed in another browser must not
 *    linger here because this client never saw its removal as a delta.
 *
 * `dismiss` is the one local write: the row leaves immediately and comes back in
 * place if the server refuses, so a slow DELETE never reads as a dead button.
 */
export function useAwaitingReplySessions(): AwaitingReplyListState {
  const { subscribe } = useWebSocket();
  const { t } = useTranslation('sidebar');

  // The list exactly as the server last reported it. State rather than a derived
  // read because two writers own it (the REST read and the pushed snapshot) and
  // `dismiss` edits it optimistically; nothing else on the page can rebuild it.
  const [sessions, setSessions] = useState<AwaitingReplyListItem[]>([]);
  // Distinguishes "nothing is waiting" from "the first read has not landed yet":
  // both are an empty array, and only the second should draw a skeleton.
  const [isLoading, setIsLoading] = useState(true);
  // The last read's failure, kept so the view can say the list may be stale
  // instead of drawing an empty list that looks like an answer.
  const [error, setError] = useState<string | null>(null);

  // The rows as of the last render, readable synchronously inside `dismiss`. The
  // state updater that removes a row may not run until React flushes, which can
  // be after the DELETE has already been answered — so the row to restore and its
  // position are captured from here, not from inside the updater.
  const sessionsRef = useRef<AwaitingReplyListItem[]>(sessions);
  sessionsRef.current = sessions;
  // The newest read wins. A pushed snapshot bumps this too, so a REST answer that
  // started before the snapshot cannot overwrite the fresher list with an older
  // one.
  const readSeqRef = useRef(0);

  const reload = useCallback(async () => {
    const seq = ++readSeqRef.current;
    setIsLoading(true);

    try {
      const response = await api.awaitingReplySessions();
      if (!response.ok) {
        throw new Error(`Failed to load awaiting reply sessions: ${response.status}`);
      }

      const payload = (await response.json()) as AwaitingReplyApiPayload;
      if (seq !== readSeqRef.current) {
        return;
      }

      setSessions(Array.isArray(payload.data?.sessions) ? payload.data.sessions : []);
      setError(null);
    } catch (readError: unknown) {
      if (seq !== readSeqRef.current) {
        return;
      }
      // The technical message goes to the console for whoever reads the log; the
      // person sees the sidebar's own sentence, because a status code or a stack
      // trace in the list is not something they can act on.
      console.error('[Sidebar] Failed to load awaiting-reply sessions:', readError);
      setError(t(LOAD_ERROR_KEY, LOAD_ERROR_FALLBACK));
    } finally {
      if (seq === readSeqRef.current) {
        setIsLoading(false);
      }
    }
  }, [t]);

  const dismiss = useCallback(async (sessionId: string) => {
    const previous = sessionsRef.current;
    const index = previous.findIndex((session) => session.sessionId === sessionId);
    if (index === -1) {
      // Already gone — a second click, or a snapshot that arrived first. The
      // DELETE would be a no-op on the server, so there is nothing to announce.
      return;
    }
    const removed = previous[index];

    // Optimistic removal: the row has to leave on the click, not on the round
    // trip, or the control reads as unresponsive.
    setSessions((current) => current.filter((session) => session.sessionId !== sessionId));

    try {
      const response = await api.dismissAwaitingReply(sessionId);
      if (!response.ok) {
        throw new Error(`Failed to remove the session from awaiting reply: ${response.status}`);
      }
    } catch (dismissError: unknown) {
      // Put the row back where it was rather than appending it: the list is
      // ordered by how long the user has owed a reply, and a row that jumped to
      // the end would misstate that.
      setSessions((current) => {
        if (current.some((session) => session.sessionId === removed.sessionId)) {
          return current;
        }
        const restored = [...current];
        restored.splice(Math.min(index, restored.length), 0, removed);
        return restored;
      });
      // The server's refusal is shown rather than swallowed, the way the Running
      // view reports a refused host close: a row that silently came back would
      // leave the user clicking a button that appears broken.
      setError(dismissError instanceof Error ? dismissError.message : String(dismissError));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // A pushed frame is a complete list, so it replaces the local copy outright
  // and invalidates any read still in flight.
  useEffect(() => subscribe((event) => {
    if (event.kind !== 'awaiting_reply_changed') {
      return;
    }

    const snapshot = event as AwaitingReplyChangedEvent;
    if (!Array.isArray(snapshot.sessions)) {
      return;
    }

    readSeqRef.current += 1;
    setSessions(snapshot.sessions);
    setError(null);
    setIsLoading(false);
  }), [subscribe]);

  // The fallback for a page left open: a tab that was hidden through a whole
  // turn heard the frame on a socket that may already have been replaced, so
  // coming back to the window re-reads what the server holds now.
  useEffect(() => {
    const handleFocus = (): void => {
      void reload();
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [reload]);

  return {
    sessions,
    count: sessions.length,
    isLoading,
    error,
    dismiss,
    reload,
  };
}
