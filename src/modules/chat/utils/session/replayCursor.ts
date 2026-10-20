/**
 * The per-session `chat.subscribe` replay cursor and the rules that move it.
 *
 * `seq` is numbered per run by the server, so a client's cursor is only
 * meaningful for the run it was recorded against: the same number on a
 * different run means something else entirely. These helpers own the three
 * transitions that keep that straight — recording a live frame, reconciling the
 * `chat_subscribed` ack, and shaping the subscribe target — so the realtime
 * handler and both subscribe sites share one rule instead of each re-deriving
 * the identity check.
 *
 * Used by chat's realtime handler (`useChatRealtimeHandlers`) to record frames
 * and acks, and by chat's two `chat.subscribe` sites (`ChatInterface` on
 * reconnect and `useChatSessionState` on session open) to shape what they send.
 */

import type { ChatReplayCursor } from '@/shared/types';

/** Lifts either stored form of a cursor — the run-aware object or a bare seq — into the run-aware one. */
export const readReplayCursor = (
  value: ChatReplayCursor | number | undefined,
): ChatReplayCursor | undefined => {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === 'number' ? { runId: null, seq: value } : value;
};

/**
 * Folds one inbound live frame into a session's cursor.
 *
 * A frame that names a run is authoritative about identity: when its `runId`
 * differs from the cursor's, the whole cursor is replaced — the earlier run's
 * high-water mark says nothing about a run that numbers `seq` from 1 again.
 * Only a frame from the *same* run advances the seq, and only upward.
 *
 * A frame with no `runId` comes from a server that does not publish run ids;
 * `seq` is per session there, so the cursor keeps its original highest-wins
 * meaning and its bare-number form.
 */
export const recordReplayCursor = (
  current: ChatReplayCursor | number | undefined,
  frame: { runId?: unknown; seq: number },
): ChatReplayCursor | number => {
  const frameRunId =
    typeof frame.runId === 'string' && frame.runId.length > 0 ? frame.runId : null;

  if (frameRunId === null) {
    const known = readReplayCursor(current)?.seq ?? 0;
    return frame.seq > known ? frame.seq : current ?? 0;
  }

  const cursor = readReplayCursor(current);
  if (!cursor || cursor.runId !== frameRunId) {
    return { runId: frameRunId, seq: frame.seq };
  }
  return frame.seq > cursor.seq ? { runId: cursor.runId, seq: frame.seq } : cursor;
};

/**
 * Reconciles a session's cursor with a `chat_subscribed` ack.
 *
 * The ack names the run the server is on. When that differs from the cursor's,
 * the cursor is reset to the start of the acknowledged run: the server is about
 * to replay that run from its first event, and a seq carried over from another
 * run would only suppress it. An ack with no `runId` — a server without run
 * ids, or a session with no run in flight — leaves the cursor alone.
 */
export const reconcileReplayCursorOnAck = (
  current: ChatReplayCursor | number | undefined,
  ack: { runId?: unknown },
): ChatReplayCursor | number | undefined => {
  const ackRunId = typeof ack.runId === 'string' && ack.runId.length > 0 ? ack.runId : null;
  if (ackRunId === null) {
    return current;
  }
  if (readReplayCursor(current)?.runId === ackRunId) {
    return current;
  }
  return { runId: ackRunId, seq: 0 };
};

/**
 * Builds the `chat.subscribe` entry for one session from its cursor.
 *
 * `runId` is included only when the cursor has one, so a client that has seen
 * no run id keeps the field off the wire and the server keeps its plain
 * `seq > lastSeq` rule.
 */
export const subscribeTargetFor = (
  sessionId: string,
  current: ChatReplayCursor | number | undefined,
): { sessionId: string; lastSeq: number; runId?: string } => {
  const cursor = readReplayCursor(current);
  const target: { sessionId: string; lastSeq: number; runId?: string } = {
    sessionId,
    lastSeq: cursor?.seq ?? 0,
  };
  if (cursor?.runId) {
    target.runId = cursor.runId;
  }
  return target;
};
