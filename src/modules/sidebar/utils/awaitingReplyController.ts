import { createExternalStore } from '@/shared/utils';
import type { Clock } from '@/shared/types';
import type { AwaitingReplyListItem } from '@/shared/awaitingReplyType';

/**
 * The sidebar's awaiting-reply list, as a React-free controller.
 *
 * Every rule the list obeys lives here — the ordering the server hands down, the
 * optimistic dismissal and its in-place restore, the newest-read-wins guard, the
 * chime throttle and the history/news distinction — so the hook that binds it to
 * React (`useAwaitingReplySessions`) is only a `useSyncExternalStore` read, and
 * every rule is testable without rendering anything.
 *
 * Three ways the list arrives, in the order they are trusted:
 *  - on `start()` and on every window `focus`, a whole-list read, because a tab
 *    left open for hours would otherwise never learn about a wait that began
 *    while it was hidden;
 *  - on every `acceptSnapshot` call (the `awaiting_reply_changed` frame), the
 *    snapshot the server assembled itself. The frame carries the WHOLE list, so
 *    it replaces the local copy instead of being merged: a row dismissed in
 *    another browser must not linger here because this client never saw its
 *    removal as a delta.
 *
 * `dismiss` is the one local write: the row leaves immediately and comes back in
 * place if the server refuses, so a slow DELETE never reads as a dead button.
 */

/** What the hook reads through `useSyncExternalStore`. Immutable: every write publishes a fresh object. */
export type AwaitingReplySnapshot = {
  /** The rows exactly as the server last reported them; the controller never re-sorts. */
  sessions: AwaitingReplyListItem[];
  /** True only while a read is outstanding with nothing on screen yet. */
  isLoading: boolean;
  /** The last read's failure, or null. Dismiss failures are reported the same way. */
  error: string | null;
};

/** The one gap between two awaiting-reply chimes. One run routinely reports a permission request and then its completion seconds apart. */
const AWAITING_REPLY_CHIME_THROTTLE_MS = 3000;

export type AwaitingReplyControllerDeps = {
  /** Reads the whole list; resolves the rows or throws. */
  listSessions: () => Promise<AwaitingReplyListItem[]>;
  /** Removes one session; resolves when the server accepted it, throws otherwise. */
  dismissSession: (sessionId: string) => Promise<void>;
  /** The chime played for a wait the page had not shown before. */
  playChime: () => Promise<void> | void;
  /** Mirrors the count into the tab title. */
  syncTitle: (count: number) => void;
  /** The user-facing sentence for a failed read. */
  loadErrorMessage: () => string;
  /** Logs the technical failure for whoever reads the console. */
  reportError: (message: string, failure: unknown) => void;
  /** Whether the tab is hidden; a hidden tab does not chime. Defaults to `document.visibilityState`. */
  isPageHidden?: () => boolean;
  /** The clock every time-dependent rule reads. */
  clock: Clock;
};

export type AwaitingReplyController = {
  getSnapshot: () => AwaitingReplySnapshot;
  subscribe: (listener: () => void) => () => void;
  /** The first read; the caller runs it once on mount. */
  start: () => void;
  /** Re-reads the whole list; the fallback for a page left open. */
  reload: () => Promise<void>;
  /** Applies a pushed whole-list frame, which is authoritative over any read in flight. */
  acceptSnapshot: (sessions: AwaitingReplyListItem[]) => void;
  /** Takes one row off the list; puts it back in place if the server refuses. */
  dismiss: (sessionId: string) => Promise<void>;
  /** Stops every later write; the hook calls it on unmount. */
  dispose: () => void;
};

/** Builds the awaiting-reply controller over an injected dependency seam. */
export function createAwaitingReplyController(
  deps: AwaitingReplyControllerDeps,
): AwaitingReplyController {
  const store = createExternalStore<AwaitingReplySnapshot>({
    sessions: [],
    isLoading: true,
    error: null,
  });
  const isPageHidden = deps.isPageHidden
    ?? (() => typeof document !== 'undefined' && document.visibilityState === 'hidden');

  // The session ids the page has already shown. `null` until the first list lands,
  // because the list a page loads with is history rather than news: a tab opened
  // while three sessions wait must not chime for all three.
  let knownWaitIds: Set<string> | null = null;
  // The newest read wins. A pushed snapshot bumps this too, so a REST answer that
  // started before the snapshot cannot overwrite the fresher list with an older one.
  let readSeq = 0;
  // When the last chime played, read synchronously so two frames arriving in the
  // same tick cannot both pass the throttle.
  let lastChimeAt = 0;
  let disposed = false;

  /**
   * Chimes and marks the tab title for waits that were not in the previous list.
   *
   * Called after every write to the list, from both the REST read and the pushed
   * snapshot, and it must run before the store publishes the new list: the
   * comparison is against the ids captured here, not against state a render may
   * not have flushed yet.
   */
  const announceNewWaits = (list: AwaitingReplyListItem[]): void => {
    const ids = new Set(list.map((session) => session.sessionId));
    const previous = knownWaitIds;
    knownWaitIds = ids;

    deps.syncTitle(list.length);

    if (previous === null) {
      return;
    }

    if (!list.some((session) => !previous.has(session.sessionId))) {
      return;
    }

    const now = deps.clock.now();
    if (now - lastChimeAt < AWAITING_REPLY_CHIME_THROTTLE_MS) {
      return;
    }
    // A hidden tab draws no rows and the user is not looking at the title either;
    // the chime is withheld rather than queued so returning to the tab is silent.
    if (isPageHidden()) {
      return;
    }
    lastChimeAt = now;
    void deps.playChime();
  };

  const applySessions = (sessions: AwaitingReplyListItem[]): void => {
    announceNewWaits(sessions);
    store.update((current) => ({ ...current, sessions, error: null }));
  };

  const reload = async (): Promise<void> => {
    const seq = ++readSeq;
    store.update((current) => ({ ...current, isLoading: true }));

    try {
      const sessions = await deps.listSessions();
      if (disposed || seq !== readSeq) {
        return;
      }
      applySessions(sessions);
    } catch (readError: unknown) {
      if (disposed || seq !== readSeq) {
        return;
      }
      // The technical message goes to whoever reads the console; the person sees
      // one sentence, because a status code or a stack trace is not something
      // they can act on.
      deps.reportError('[Sidebar] Failed to load awaiting-reply sessions', readError);
      store.update((current) => ({ ...current, error: deps.loadErrorMessage() }));
    } finally {
      if (!disposed && seq === readSeq) {
        store.update((current) => ({ ...current, isLoading: false }));
      }
    }
  };

  const dismiss = async (sessionId: string): Promise<void> => {
    const previous = store.getSnapshot().sessions;
    const index = previous.findIndex((session) => session.sessionId === sessionId);
    if (index === -1) {
      // Already gone — a second click, or a snapshot that arrived first. The
      // DELETE would be a no-op on the server, so there is nothing to announce.
      return;
    }
    const removed = previous[index];

    // Optimistic removal: the row has to leave on the click, not on the round
    // trip, or the control reads as unresponsive. The moved-out row is recorded
    // as known history too, so a later snapshot without it does not count as
    // news.
    knownWaitIds = new Set(previous.filter((session) => session.sessionId !== sessionId).map((session) => session.sessionId));
    store.update((current) => ({
      ...current,
      sessions: current.sessions.filter((session) => session.sessionId !== sessionId),
    }));
    deps.syncTitle(previous.length - 1);

    try {
      await deps.dismissSession(sessionId);
    } catch (dismissError: unknown) {
      if (disposed) {
        return;
      }
      // Put the row back where it was rather than appending it: the list is
      // ordered by how long the user has owed a reply, and a row that jumped to
      // the end would misstate that.
      store.update((current) => {
        if (current.sessions.some((session) => session.sessionId === removed.sessionId)) {
          return current;
        }
        const restored = [...current.sessions];
        restored.splice(Math.min(index, restored.length), 0, removed);
        knownWaitIds = new Set(restored.map((session) => session.sessionId));
        return { ...current, sessions: restored };
      });
      deps.syncTitle(previous.length);
      // The server's refusal is shown rather than swallowed: a row that silently
      // came back would leave the user clicking a button that appears broken.
      store.update((current) => ({
        ...current,
        error: dismissError instanceof Error ? dismissError.message : String(dismissError),
      }));
    }
  };

  const acceptSnapshot = (sessions: AwaitingReplyListItem[]): void => {
    if (disposed) {
      return;
    }
    // A pushed frame is a complete list, so it invalidates any read still in flight.
    readSeq += 1;
    announceNewWaits(sessions);
    store.update((current) => ({ ...current, sessions, error: null, isLoading: false }));
  };

  return {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    start: () => {
      // A remount (React's StrictMode runs mount → unmount → mount) reuses this
      // controller; the start clears the disposed flag so the second mount's read
      // is not dropped as if the page had gone away.
      disposed = false;
      void reload();
    },
    reload,
    acceptSnapshot,
    dismiss,
    dispose: () => {
      disposed = true;
    },
  };
}
