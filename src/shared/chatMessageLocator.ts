/**
 * The shared seam between the architecture module and the chat module for
 * "locate a message by id".
 *
 * The architecture inspector lists the transcript messages that mention an
 * entity, and clicking one must centre that message in the Chat tab. Both
 * modules own their UI and must not import each other, so the request crosses
 * through this subscription store — the same shape as `src/shared/chatDrafts.ts`.
 *
 * A request is REMEMBERED as well as announced. Clicking a hit while the
 * architecture tab is open happens with the chat pane mounted but hidden
 * (`WorkspaceMain` keeps it in the tree and hides it), and scrolling a hidden
 * pane would centre nothing; the chat consumer therefore reads
 * {@link consumePendingLocateRequest} when it becomes visible. Announcing the
 * request as well keeps the visible case one render away instead of polling.
 *
 * Consumers: `ArchitectureInspector.tsx` (requests) and `ChatInterface.tsx`
 * (consumes when active); `tests/chatMessageLocator.test.ts`.
 */

/** One request: the transcript message the reader asked to see. */
export type ChatMessageLocateRequest = {
  readonly messageId: string;
};

type LocateListener = (request: ChatMessageLocateRequest) => void;

const listeners = new Set<LocateListener>();

/**
 * The request not yet consumed, if any. `null` before the first request and
 * after {@link consumePendingLocateRequest}. Only the latest request is kept:
 * two clicks in a row name one destination, and the second is the one the
 * reader means.
 */
let pending: ChatMessageLocateRequest | null = null;

/**
 * Ask the chat to centre the message with `messageId`. An empty id is ignored:
 * a hit row always carries one, so an empty value is a caller bug, not a
 * destination.
 */
export function requestLocateMessage(messageId: string): void {
  const trimmed = messageId.trim();
  if (trimmed === '') return;
  pending = { messageId: trimmed };
  for (const listener of [...listeners]) listener(pending);
}

/** The request waiting to be handled, without consuming it. */
export function readPendingLocateRequest(): ChatMessageLocateRequest | null {
  return pending;
}

/**
 * Take the pending request, if any. The chat calls this once it is visible;
 * consuming it here is what makes "hidden first, placed when shown" run once
 * instead of on every re-render.
 */
export function consumePendingLocateRequest(): ChatMessageLocateRequest | null {
  const request = pending;
  pending = null;
  return request;
}

/**
 * Listen for new requests. Returns the unsubscribe function; while no chat
 * pane is mounted (or while the tab is hidden) the request stays pending and
 * is read from {@link readPendingLocateRequest} on mount/visibility.
 */
export function subscribeToLocateRequests(listener: LocateListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
