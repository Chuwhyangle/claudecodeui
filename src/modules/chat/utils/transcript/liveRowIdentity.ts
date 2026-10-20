/**
 * Identity for the transcript row the client is streaming a reply into.
 *
 * A live row is re-minted on every delta — new text, new timestamp, a new object
 * in the store — and again when the turn settles. Its `id` is the one part of it
 * that has to outlive both: it is what the transcript keys the row by, and a key
 * that changes is not a re-render but an unmount followed by a mount (see
 * `ChatMessagesPane`, which keys each row by `getIntrinsicMessageKey`).
 *
 * The identity is deliberately *not* minted per call: a settled turn keeps its
 * id, so the next turn of the same session has to mint its own or it would be
 * writing into the row it just settled. Hence one id per turn, held for the
 * turn's whole life.
 *
 * Used by chat's session store (`useSessionStore`) to mint and select the live
 * row, and by chat's projection to carry that id onto the rendered message.
 */

/** Namespace for this client's own live rows; no provider or server id uses it. */
const LIVE_ROW_ID_PREFIX = 'live:';

/**
 * Distinguishes the turns within a session. A counter rather than a timestamp or
 * a random suffix because the only property the id needs is that two turns of
 * the same session never share one, and a counter cannot collide at all.
 */
let liveRowSequence = 0;

/** The id for a fresh turn of `sessionId` — call once per turn, not once per delta. */
export const createLiveRowId = (sessionId: string): string => {
  liveRowSequence += 1;
  return `${LIVE_ROW_ID_PREFIX}${sessionId}:${liveRowSequence}`;
};

/** True for the id of a row this client streamed, whether the turn is still in flight or settled. */
export const isLiveRowId = (id: unknown): boolean =>
  typeof id === 'string' && id.startsWith(LIVE_ROW_ID_PREFIX);
