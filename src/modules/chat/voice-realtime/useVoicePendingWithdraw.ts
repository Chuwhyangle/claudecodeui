import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { CommandLifecycleState, ServerEvent } from '@/shared/types';
import type { VoiceRealtimeDelivery } from '@/modules/chat/voice-realtime/useVoiceRealtimeSession';

/**
 * Where one withdrawn-able spoken command stands, as the host's own `command_lifecycle` events put
 * it. Same three states the typed-message pending row uses, and for the same reason: the queue is
 * the host's, and only the host says what became of a command.
 */
export type VoicePendingUtteranceState = 'queued' | 'started' | 'cancelled';

/**
 * One voice-delivered instruction the CLI's queue may still be holding — the unit a per-utterance
 * withdrawal addresses (SPEC §0.3 D-11, AC-351).
 *
 * It is keyed by `queuedMessageUuid`, the name the host stamped on the command and the only address
 * its queue answers to. The message and timestamp are carried along so the row can name WHICH
 * sentence is being offered back without the reader having to remember.
 */
export type VoicePendingUtterance = {
  /** The command's own queue id — the name a withdrawal sends, and the row's identity. */
  queuedMessageUuid: string;
  /** The text the delivery confirmed, so the row can show the sentence it is offering back. */
  message: string;
  /** When the delivery was confirmed, in epoch ms. Display only. */
  at: number;
  state: VoicePendingUtteranceState;
  /**
   * A fact about a REQUEST, not about the queue: the host answered a withdrawal with
   * `already-started`, so the sentence had been dequeued before the person asked. `null` while no
   * such answer has been heard. Kept separate from {@link state}, which the host's own lifecycle
   * owns, because the two have different authors: the state is what the queue did, the notice is
   * what the person's ask was told.
   */
  notice: 'already-started' | null;
};

/** The state a delivery has before the host says anything about it: the queue is holding it. */
const QUEUED: { state: VoicePendingUtteranceState; notice: VoicePendingUtterance['notice'] } = {
  state: 'queued',
  notice: null,
};

/**
 * One command's entry in this hook's own map. `completed` is a TOMBSTONE, not a rendered state: the
 * command ran and its row must go, but the entry cannot simply be deleted — a deletion would fall
 * back to {@link QUEUED} at read time and draw the row again. It is internal on purpose; the public
 * {@link VoicePendingUtteranceState} never carries it.
 */
type LifecycleEntry = {
  state: VoicePendingUtteranceState | 'completed';
  notice: VoicePendingUtterance['notice'];
};

/** The lifecycle states this hook reads; the frame's raw value is narrowed to these. */
const LIFECYCLE_STATES: readonly CommandLifecycleState[] = ['queued', 'started', 'cancelled', 'completed'];

function readLifecycleState(value: unknown): CommandLifecycleState | null {
  return LIFECYCLE_STATES.includes(value as CommandLifecycleState) ? (value as CommandLifecycleState) : null;
}

/**
 * The per-utterance withdrawal control for Live Voice (GOAL-041 / AC-351).
 *
 * WHY A SEPARATE HOOK, AND WHY THE VOICE SURFACE. The typed-message path already has a pending row
 * driven by the session store's `command_lifecycle` rows ({@link PendingResidentMessage}), but a
 * voice delivery never creates one of those rows: it reaches the session through `session_send`, and
 * the page learns only that a delivery landed. What the page DID discard — until
 * {@link VoiceRealtimeDelivery.queuedMessageUuid} — was the command's own queue id, the one name a
 * withdrawal can address. This hook takes those deliveries and the two host frames that talk about
 * them, and returns the rows a person can withdraw from.
 *
 * TWO SOURCES, TWO JOBS. The host's own `command_lifecycle` events drive {@link
 * VoicePendingUtterance.state}: `started` takes the button away (the sentence is a turn now),
 * `cancelled` marks it withdrawn, `completed` drops the row. The `queued_input_cancel_result`
 * verdict — deliberately dropped by the chat handler, and read here instead — carries the one thing
 * the lifecycle cannot say: an `already-started` answer to a withdrawal the person actually asked
 * for. It sets a NOTICE and moves the row to `started` (AC-287: that verdict IS the host saying the
 * command was already dequeued); a `withdrawn` verdict changes nothing, because the lifecycle's own
 * `cancelled` event is what this client treats as the withdrawal having happened.
 *
 * WITHDRAWAL NEVER ABORTS. The only outbound this hook can produce is `cancelQueued`, and it is
 * called for one command by its own uuid; nothing here can stop the run in flight (D-11, GOAL-041).
 *
 * THE RECONCILE FALLBACK. {@link VoiceRealtimeDelivery.queuePending} is a THIRD reading, from the
 * host's own queue account rather than the lifecycle channel: a `queued` delivery the host reports
 * as no longer held is dropped before it is drawn, so a row whose terminal `command_lifecycle`
 * frame never arrived (the 2026-10-14 defect — the host had read the dequeue, the browser had not
 * been told) is cleared anyway. It only ever REMOVES a `queued` row; `started`/`cancelled` are the
 * lifecycle's own business and are never overridden by it.
 */
export function useVoicePendingWithdraw({
  sessionId,
  deliveries,
  subscribe,
  cancelQueued,
}: {
  /** The bound session; a frame about another session is ignored, and no session means no control. */
  sessionId: string | null;
  /** The Live Voice deliveries the page holds — the source of every withdrawable command. */
  deliveries: readonly VoiceRealtimeDelivery[];
  /** The chat websocket's frame stream, where `command_lifecycle` and the cancel verdict arrive. */
  subscribe?: ((listener: (event: ServerEvent) => void) => () => void) | undefined;
  /**
   * Sends one withdrawal for one command. Injected rather than built here so the transport stays
   * the pane's business and this hook stays drivable: a test supplies its own spy, and the pane
   * supplies the `chat.cancel-queued` frame.
   */
  cancelQueued: (sessionId: string, queuedMessageUuid: string) => void;
}): {
  /** One entry per withdrawable-or-recently-withdrawn spoken command, oldest delivery first. */
  utterances: readonly VoicePendingUtterance[];
  /** Asks the host to take one command back, by its queue id. A no-op for anything not `queued`. */
  withdraw: (queuedMessageUuid: string) => void;
} {
  // Per-command state, keyed by the host's queue id. Held apart from `deliveries` so a lifecycle
  // frame that arrives BEFORE the delivery it belongs to (the two travel on different sockets) is
  // not lost: it is stored under its uuid and joined to the delivery the moment it appears.
  const [states, setStates] = useState<Record<string, LifecycleEntry>>({});
  // The freshest states for `withdraw`, which must read what is true NOW without being re-created on
  // every state change — it is handed to rows that re-render as the queue moves under them.
  const statesRef = useRef(states);
  useEffect(() => {
    statesRef.current = states;
  });

  const applyLifecycle = useCallback((uuid: string, state: CommandLifecycleState) => {
    setStates((previous) => {
      if (state === 'completed') {
        // The command ran: the turn's own rows are the record, and this row has nothing left to say.
        // A tombstone, not a delete — an absent entry reads as `queued` (see {@link LifecycleEntry}).
        if (previous[uuid]?.state === 'completed') return previous;
        return { ...previous, [uuid]: { state: 'completed', notice: null } };
      }
      if (state === 'queued') {
        // Adoption or re-queue: the queue holds it again, so the button comes back and any stale
        // notice goes — the fact the notice named (it had started) is no longer what is true.
        const current = previous[uuid];
        if (current && current.state === 'queued' && current.notice === null) return previous;
        return { ...previous, [uuid]: { ...QUEUED } };
      }
      const nextState: VoicePendingUtteranceState = state === 'started' ? 'started' : 'cancelled';
      // A withdrawal keeps no notice (the ask succeeded). A `started` keeps whatever the person was
      // told, so an `already-started` answer survives the lifecycle event that confirms it.
      const notice = nextState === 'cancelled' ? null : (previous[uuid]?.notice ?? null);
      const current = previous[uuid];
      if (current && current.state === nextState && current.notice === notice) return previous;
      return { ...previous, [uuid]: { state: nextState, notice } };
    });
  }, []);

  const applyVerdict = useCallback((uuid: string, result: unknown) => {
    if (result !== 'already-started') {
      // `withdrawn` is left to the host's own `cancelled` lifecycle event — the reading this client
      // treats as the withdrawal having happened — and `unknown`/`forbidden` confirmed nothing, so
      // the row must not claim a withdrawal that did not take place.
      return;
    }
    setStates((previous) => ({ ...previous, [uuid]: { state: 'started', notice: 'already-started' } }));
  }, []);

  useEffect(() => {
    if (!subscribe || !sessionId) return;
    return subscribe((event: ServerEvent) => {
      // Every one of these frames is addressed to a session; another session's is not ours to act on.
      if (event.sessionId !== sessionId) return;
      const kind = typeof event.kind === 'string' ? event.kind : '';
      if (kind === 'command_lifecycle') {
        const uuid = typeof event.commandUuid === 'string' ? event.commandUuid : '';
        const state = readLifecycleState(event.commandState);
        if (uuid === '' || state === null) return;
        applyLifecycle(uuid, state);
        return;
      }
      if (kind === 'queued_input_cancel_result') {
        const uuid = typeof event.messageUuid === 'string' ? event.messageUuid : '';
        if (uuid === '') return;
        applyVerdict(uuid, event.result);
      }
    });
  }, [subscribe, sessionId, applyLifecycle, applyVerdict]);

  const utterances = useMemo<VoicePendingUtterance[]>(() => {
    const rows: VoicePendingUtterance[] = [];
    for (const delivery of deliveries) {
      const uuid = delivery.queuedMessageUuid;
      // No uuid means the send opened a run rather than joining the queue: there is no command to
      // take back, and drawing a button for it would offer a withdrawal that cannot be addressed.
      if (typeof uuid !== 'string' || uuid === '') continue;
      const lifecycle = states[uuid] ?? QUEUED;
      // The command ran and its own turn rows took over: this row is done, and no tombstone is drawn.
      if (lifecycle.state === 'completed') continue;
      // THE RECONCILE READING. The host's own `started` set, carried here on the delivery as
      // `queuePending`, is the second source the 2026-10-14 defect needs: when the terminal
      // `command_lifecycle` frame never reached the browser, a row that would sit on `queued`
      // forever is cleared instead, because the host reports its command is no longer in the queue.
      // ONLY `queued` rows are dropped — `started`/`cancelled` are the host's own word already, and
      // `undefined` (no reconcile has named it) keeps the row, the same as before this reading.
      if (lifecycle.state === 'queued' && delivery.queuePending === false) continue;
      rows.push({
        queuedMessageUuid: uuid,
        message: delivery.message,
        at: delivery.at,
        state: lifecycle.state,
        notice: lifecycle.notice,
      });
    }
    return rows;
  }, [deliveries, states]);

  const withdraw = useCallback(
    (queuedMessageUuid: string) => {
      if (!sessionId || queuedMessageUuid === '') return;
      // Only a command the host is still holding can be taken back. The button is drawn only in that
      // state, and this guard keeps a click that raced the queue from addressing a command that has
      // since started — the host would answer `already-started` anyway, but a request we know is
      // spent is not worth sending.
      const current = statesRef.current[queuedMessageUuid];
      if (current && current.state !== 'queued') return;
      cancelQueued(sessionId, queuedMessageUuid);
    },
    [sessionId, cancelQueued],
  );

  return { utterances, withdraw };
}
