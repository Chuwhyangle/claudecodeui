/**
 * The client's per-session background-work store: the task table and schedule
 * table a session's activity snapshot carries, and the hooks that read them.
 *
 * Why a store rather than component state. The two readings this module serves —
 * the dock's summary (`ActivityIndicator`) and a transcript card's live state
 * (`SubagentPanel` / `BashCommandDisplay`) — live in unrelated parts of the tree,
 * and both must react to the *same* frame. A store keyed by session id, written
 * once by the realtime handler and read through `useSyncExternalStore`, is what
 * makes the frame the one source: neither reader derives a state of its own.
 *
 * Where the data comes from. The server pushes a whole snapshot on
 * `activity.snapshot` (to a joiner, before any change) and again on every
 * `activity.upsert` (one revision per change). Both are the same shape, so a
 * frame *replaces* the session's view rather than patching it — a missed frame is
 * harmless because the next one carries everything. Nothing here polls
 * `/api/session-hosts`: the background panel is drawn from these frames, which is
 * the whole difference AC-194 pins.
 *
 * The task-by-tool-use-id lookup is deliberately cross-session: a `tool_use` id
 * is globally unique, and a transcript card knows only the id on its own row, so
 * scanning the held sessions is how a card joins its task without threading a
 * session id down through the transcript renderer.
 */

import { useContext, useEffect, useSyncExternalStore } from 'react';

import WebSocketContext from '@/shared/context/WebSocketContext';
import { fetchSessionActivity } from '@/shared/api';
import type { ActivityScheduleView, ActivityTaskState, ActivityTaskView, DeliveryView } from '@/shared/types';

/** One session's background-work view, as the last snapshot/upsert frame left it. */
export type SessionActivityView = {
  rev: number;
  tasks: ActivityTaskView[];
  schedules: ActivityScheduleView[];
  /**
   * The session's accepted deliveries, in send order, as the frame stated them.
   * This is where the transcript's pending rows come from: the chat store reads
   * them back through {@link readSessionDeliveries} rather than being handed a
   * second copy of the frame, so the snapshot has exactly one home on the client.
   */
  deliveries: DeliveryView[];
};

/**
 * The states from which a task cannot move again.
 *
 * The task table keeps a terminal row on purpose — a transcript card joins its
 * task by `toolUseId` to draw the state of a call that has already finished — so
 * this set is a *reading* filter, never a deletion. The dock speaks only about
 * work that is still live; the store keeps every row.
 */
export const TERMINAL_TASK_STATES: ReadonlySet<ActivityTaskState> = new Set<ActivityTaskState>([
  'completed',
  'failed',
  'stopped',
  'ended',
]);

/** True while a task can still move — `running` or `blocked`. */
export function isActiveTask(task: ActivityTaskView): boolean {
  return !TERMINAL_TASK_STATES.has(task.state);
}

/**
 * The tasks the activity dock speaks about: the ones that are not terminal.
 *
 * The single filter behind the dock's count, its `background` decision and the
 * panel's list — so those three can never disagree about which rows are live,
 * and a finished task leaves the dock instead of holding it open forever.
 */
export function selectActiveTasks(tasks: readonly ActivityTaskView[]): ActivityTaskView[] {
  return tasks.filter(isActiveTask);
}

/** The view a session with no frame yet reads: present, empty, stable by reference. */
const EMPTY_VIEW: SessionActivityView = { rev: 0, tasks: [], schedules: [], deliveries: [] };

/** The stable empty array a frame with no `deliveries` of its own reads as. */
const EMPTY_DELIVERIES: DeliveryView[] = [];

/**
 * A frame's raw `deliveries` field as the view array.
 *
 * The wire carries the field unvalidated — a frame written before this channel
 * existed simply has none — so a malformed or missing value reads as empty,
 * exactly as `tasks`/`schedules` do. A non-array here would otherwise put a
 * non-iterable into the store and crash the reader that maps over it.
 */
function readDeliveries(value: unknown): DeliveryView[] {
  return Array.isArray(value) ? (value as DeliveryView[]) : EMPTY_DELIVERIES;
}

const views = new Map<string, SessionActivityView>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

/**
 * Applies one whole activity frame for a session, replacing its view.
 *
 * The frame's `tasks`/`schedules` are validated as arrays here so a malformed or
 * partial frame cannot put a non-array into the store and crash a reader that
 * maps over it. A missing array reads as empty, exactly as the server's own
 * snapshot defaults would.
 */
export function applyActivityFrame(input: {
  sessionId?: string | null;
  rev?: unknown;
  tasks?: unknown;
  schedules?: unknown;
  deliveries?: unknown;
}): void {
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
  if (!sessionId) {
    return;
  }

  views.set(sessionId, {
    rev: typeof input.rev === 'number' && Number.isFinite(input.rev) ? input.rev : 0,
    tasks: Array.isArray(input.tasks) ? (input.tasks as ActivityTaskView[]) : [],
    schedules: Array.isArray(input.schedules) ? (input.schedules as ActivityScheduleView[]) : [],
    deliveries: readDeliveries(input.deliveries),
  });
  emit();
}

/** The session's current view, or the stable empty view when it has none. */
export function readSessionActivityView(sessionId?: string | null): SessionActivityView {
  if (!sessionId) {
    return EMPTY_VIEW;
  }
  return views.get(sessionId) ?? EMPTY_VIEW;
}

/**
 * The session's accepted deliveries as the last activity frame stated them.
 *
 * The read-only half of this store's delivery face, and the one the transcript's
 * pending rows are derived from: chat's realtime handler hands a frame to
 * {@link applyActivityFrame} and then reads the frame back through here, so the
 * snapshot has one home on the client and the rows can never disagree with the
 * view the dock is reading. A session with no frame yet answers empty.
 */
export function readSessionDeliveries(sessionId?: string | null): DeliveryView[] {
  return readSessionActivityView(sessionId).deliveries;
}

/** The task whose `tool_use` block is `toolUseId`, from any held session, or null. */
export function findTaskByToolUseId(toolUseId?: string | null): ActivityTaskView | null {
  if (!toolUseId) {
    return null;
  }
  for (const view of views.values()) {
    const task = view.tasks.find((candidate) => candidate.toolUseId === toolUseId);
    if (task) {
      return task;
    }
  }
  return null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Sessions whose REST snapshot has already been fetched. A one-shot per session
 * per page life: the socket pushes every later change, so re-reading on each
 * mount would be a poll.
 */
const snapshotFetched = new Set<string>();

/**
 * How long the join read waits for the socket to connect before it falls back to REST.
 *
 * The server births a session in its activity store on `activity.subscribe` and answers 404
 * to the REST read for anything it has not been told about, so firing the read at mount asks
 * before the only event that creates an answer. On a cold store — any server restart — that
 * is a guaranteed 404, which the browser logs as a failed resource and the client discards.
 * A socket that connects within this window hands over the same snapshot on subscribe, so the
 * common path never makes the request; only a genuinely dead socket falls back to it. Even
 * then the read can only answer for another tab's subscription.
 */
const JOIN_READ_GRACE_MS = 2_000;

/**
 * The join read: fetch the session's snapshot over REST once, so a page whose socket never
 * comes up can still restore the background panel when some other connection has subscribed
 * the session. A failure is silent — the socket's own `activity.snapshot` remains the primary
 * path, and this is only the fallback anchor.
 */
function ensureSnapshotFetched(sessionId?: string | null): void {
  if (!sessionId || snapshotFetched.has(sessionId)) {
    return;
  }
  snapshotFetched.add(sessionId);
  // Wrapped in try/catch as well as `.catch`: a document without `fetch` (a unit render) throws
  // synchronously out of the request constructor, which a promise `.catch` never sees.
  try {
    void fetchSessionActivity(sessionId)
      .then((frame) => {
        if (frame) {
          applyActivityFrame(frame);
        }
      })
      .catch(() => undefined);
  } catch {
    // No transport here; the socket's own `activity.snapshot` remains the primary path.
  }
}

/** The session's background-work view, re-rendering the caller when a frame arrives. */
export function useSessionActivity(sessionId?: string | null): SessionActivityView {
  // The context is read directly rather than through `useWebSocket` (the same
  // seam `useActivityFreshness` uses) so a unit test can render a reader with no
  // provider: with no socket there is simply nothing to ask.
  const contextConnection = useContext(WebSocketContext);
  const sendMessage = contextConnection?.sendMessage;
  const isConnected = contextConnection?.isConnected ?? false;

  // The join read is a fallback for a socket that does not come up, not a mount-time
  // guarantee: a connected socket's subscribe reply is the anchor, and asking the REST route
  // before the socket has subscribed asks a store that cannot answer yet (see
  // `JOIN_READ_GRACE_MS`). When the socket connects, this effect re-runs and cancels the timer.
  useEffect(() => {
    if (!sessionId || isConnected) {
      return;
    }
    const timer = setTimeout(() => ensureSnapshotFetched(sessionId), JOIN_READ_GRACE_MS);
    return () => clearTimeout(timer);
  }, [sessionId, isConnected]);

  // Ask the server to start pushing this session's activity frames. The verb is
  // its own — deliberately not `chat.subscribe` — because a `chat.subscribe`
  // reply is the run's frame sequence, which the per-run frame-parity criterion
  // pins against a frozen baseline and forbids adding frames to; the server
  // attaches this feed only on `activity.subscribe`. Re-sent whenever the socket
  // reports itself connected, so a reconnect re-arms the feed instead of leaving
  // the panel frozen on its last snapshot.
  useEffect(() => {
    if (!sessionId || !isConnected || !sendMessage) {
      return;
    }
    sendMessage({ type: 'activity.subscribe', sessionId });
  }, [sessionId, isConnected, sendMessage]);

  return useSyncExternalStore(
    subscribe,
    () => readSessionActivityView(sessionId),
    () => readSessionActivityView(sessionId),
  );
}

/**
 * The task behind one transcript card, read live.
 *
 * This is the reading AC-194's card requirement turns on: the card's state comes
 * from the task entity (by `toolUseId`), never from whether a folded row happens
 * to carry a result. When the task is not in any held session the hook answers
 * null and the card falls back to the transcript's own status.
 */
export function useTaskByToolUseId(toolUseId?: string | null): ActivityTaskView | null {
  return useSyncExternalStore(
    subscribe,
    () => findTaskByToolUseId(toolUseId),
    () => findTaskByToolUseId(toolUseId),
  );
}

/** Drops every session's view. Test-only; production never clears this. */
export function resetSessionActivityStore(): void {
  views.clear();
  snapshotFetched.clear();
  emit();
}
