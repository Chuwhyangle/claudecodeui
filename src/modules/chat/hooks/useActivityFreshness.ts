/**
 * The browser's liveness reading for one session's activity dock.
 *
 * This is the wiring AC-183 deliberately left out: it feeds the pure freshness
 * machine from the app's own socket — the `chat_subscribed` hello and the
 * `activity.heartbeat` beat — so the dock has an authoritative "is the server
 * still there" reading instead of a local table nothing on a dead server can
 * clear.
 *
 * The mapping is deliberately conservative. Only the gateway frames that carry
 * the activity contract count as evidence; provider messages do not, because a
 * replayed message's `timestamp` is when it was produced, not when the server
 * last spoke, and folding it in would move the elapsed anchor backwards. Those
 * frames are the `chat_subscribed` hello, the `activity.heartbeat` beat, and the
 * `activity.snapshot` / `activity.upsert` frames the activity feed pushes. The
 * hello states `isProcessing`, and a beat states the run registry's own
 * in-flight bit *and* the reduced `phase`. The in-flight bit is the authority —
 * it is what distinguishes a turn that ended from a turn the phase tracker has
 * simply never seen a frame for (its `idle` covers both) — and a beat that
 * reports it false is the frame that ends a turn a hello pinned. A beat that
 * omits the bit (a server predating the field) falls back to the phase, whose
 * `idle` was the only ending signal before the authority existed, and a beat
 * that carries neither says nothing about the turn and only advances the clock.
 *
 * The snapshot is where the turn's *start* comes from. The hello and the beat
 * only prove the server is there; their `asOf` is when the frame was made, never
 * when the turn began. The snapshot carries `turn.startedAt` on the server's own
 * clock, and that is the anchor the elapsed reading adopts — so a refreshed or
 * remounted dock reads the turn's real age from the replayed snapshot instead of
 * a clock restarted at subscribe time. When no frame has named a start (a server
 * without the snapshot feed), the hello's own `asOf` stands in, which is the
 * only turn evidence there is.
 *
 * The silence threshold is the one the server announced
 * (`unreachableAfterMs`) — never a client constant.
 *
 * Used by chat's `ActivityIndicator` and `ChatComposer`; the decision it feeds
 * is `deriveActivityDockView`, and its criterion is
 * `src/modules/chat/tests/activityDockUnreachable.test.tsx`.
 */

import { useContext, useEffect, useReducer, useRef } from 'react';

import WebSocketContext from '@/shared/context/WebSocketContext';
import type { ActivityConnection, ActivityPhase, ServerEvent } from '@/shared/types';
import {
  createActivityFreshness,
  type ActivityFreshness,
  type ActivityLiveness,
} from '@/modules/chat/utils/activityFreshness';

/** What the dock needs to know about liveness, with nothing transport-shaped in it. */
export type ActivityFreshnessReading = {
  /** Fresh while frames keep arriving; unreachable once the silence budget is spent. */
  liveness: ActivityLiveness;
  /** Server-derived elapsed ms of the turn, frozen while unreachable; null when unknown. */
  elapsedMs: number | null;
  /** True while the machine still holds a turn anchor the server confirmed. */
  hasTurnAnchor: boolean;
  /** True when a liveness channel exists at all; without one no unreachability can be claimed. */
  wired: boolean;
  /** The phase the server last reported for this session's turn; `idle` when none. */
  phase: ActivityPhase;
  /** The pending tool's name while `phase` is `tool`, else null. */
  toolName: string | null;
};

/** One session's machine plus the last threshold the server announced. */
type MachineSlot = {
  sessionId: string | null | undefined;
  machine: ActivityFreshness;
  staleAfter: number | null;
  /** The server's last reported phase for this session; survives a silence, like the elapsed. */
  phase: ActivityPhase;
  toolName: string | null;
};

/** Every phase the server may report, so an unrecognised value is ignored rather than drawn. */
const ACTIVITY_PHASES: ReadonlySet<string> = new Set<ActivityPhase>([
  'idle',
  'thinking',
  'writing',
  'tool',
  'awaitingPermission',
  'compacting',
]);

/** The phase one frame carries, or null when it reports none this build knows. */
const readPhase = (value: unknown): ActivityPhase | null =>
  typeof value === 'string' && ACTIVITY_PHASES.has(value) ? (value as ActivityPhase) : null;

/** The tool name one frame carries, or null. Only meaningful alongside a `tool` phase. */
const readToolName = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/**
 * The turn start one activity-snapshot frame carries, or null.
 *
 * The snapshot channel states the run the turn *is* and when the driver opened
 * it — `turn.startedAt`, on the server's own clock. That value, and only that
 * value, is the anchor the elapsed reading must use: the hello and the beat
 * prove the server is still there, but their `asOf` is when the *frame* was
 * made, never when the turn began. Anchoring on the snapshot's start is what
 * lets a refreshed or remounted dock read the turn's real age instead of a
 * clock restarted at the moment it happened to subscribe.
 */
const readTurnStart = (turn: unknown): number | null => {
  if (typeof turn !== 'object' || turn === null) return null;
  return parseServerTime((turn as { startedAt?: unknown }).startedAt);
};

/** A server time reading from either an ISO string or an epoch-milliseconds number. */
const parseServerTime = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

/** A strictly positive finite number, or null — the guard the threshold fields need. */
const positiveNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

/**
 * The last silence budget a server announced, shared by every machine this page builds.
 *
 * Only the `chat_subscribed` hello carries the budget; a bare heartbeat does not. A machine is
 * born when its surface *mounts*, and a surface can mount long after the hello that would have
 * taught it: moving between the dock's two mount sites — the composer's from `md` up, the
 * transcript's below it, which is what a rotated phone or a resized window does — builds a fresh
 * machine with no hello behind it. That machine would then drop every heartbeat it ever receives
 * (there is no threshold to judge them against), read `unreachable` for as long as it lives, and
 * say so about a server that is beating at it once every `ACTIVITY_HEARTBEAT_INTERVAL_MS`.
 *
 * The budget is a property of the *server*, not of the surface that happened to hear it, so the
 * last announced value is remembered here and adopted by a machine that has not heard a hello
 * yet. A later hello overwrites it, which is what keeps a restarted server's new budget honest.
 */
let lastAnnouncedStaleAfter: number | null = null;

export const useActivityFreshness = (
  sessionId?: string | null,
  connection?: ActivityConnection | null,
): ActivityFreshnessReading => {
  // The context is read directly rather than through `useWebSocket` so a unit
  // test can render the dock with no provider and hand it its own channel.
  const contextConnection = useContext(WebSocketContext);
  const activeConnection = connection ?? contextConnection;
  const subscribe = activeConnection?.subscribe;
  const isConnected = activeConnection?.isConnected ?? false;
  const wired = Boolean(activeConnection);

  // The machine mutates outside React, so every frame and connection change is
  // answered with one forced render — the dock never depends on a parent commit.
  const [, forceRender] = useReducer((count: number) => count + 1, 0);

  const slotRef = useRef<MachineSlot | null>(null);
  if (slotRef.current === null || slotRef.current.sessionId !== sessionId) {
    // A navigation to another session starts from no evidence again: the old
    // machine's timers are dropped so they cannot fire against an unused slot.
    slotRef.current?.machine.dispose();
    slotRef.current = {
      sessionId,
      machine: createActivityFreshness(),
      // Born with whatever the page last heard, so a surface that mounts mid-conversation is not
      // blind to every beat until the next hello (see `lastAnnouncedStaleAfter`).
      staleAfter: lastAnnouncedStaleAfter,
      // Nothing has reported a phase for this session yet; `idle` is the honest start.
      phase: 'idle',
      toolName: null,
    };
  }
  const slot = slotRef.current;

  useEffect(() => {
    if (!subscribe) {
      return undefined;
    }

    const listener = (event: ServerEvent) => {
      const { machine } = slot;
      // A dock with no session (a fresh New Session draft) has no turn to report. Frames
      // are matched strictly, so a still-running previous session's hello/beat cannot
      // anchor a turn here and keep the dock popping up in the new session.

      if (event.kind === 'chat_subscribed') {
        if (event.sessionId !== sessionId) return;

        const asOf = parseServerTime(event.timestamp);
        if (asOf === null) return;
        // The hello is where a threshold is announced; remember it for the
        // heartbeats, which are bare and carry no timings of their own.
        const announced = positiveNumber(event.unreachableAfterMs);
        if (announced !== null) {
          slot.staleAfter = announced;
          lastAnnouncedStaleAfter = announced;
        }
        if (slot.staleAfter === null) return;

        const bootId = typeof event.bootId === 'string' ? event.bootId : '';
        const rev = typeof event.rev === 'number' ? event.rev : 0;
        const snapshot = machine.getSnapshot();
        // Carry the turn's anchor across a re-subscribe while the same server
        // process is in force, so a reconnect does not restart the clock. The
        // anchor the server itself named (from the snapshot channel) is preferred
        // over this frame's `asOf`; only when no server start is known does the
        // hello's own `asOf` stand in, and only across the same process. A new
        // boot identity voids it: that turn belonged to a process that is gone.
        const sameIdentity = snapshot.bootId !== null && snapshot.bootId === bootId;
        const carriedStart = sameIdentity && snapshot.turnStartedAt !== null ? snapshot.turnStartedAt : asOf;
        const turn = event.isProcessing === true ? { startedAt: carriedStart } : { startedAt: null };

        machine.onFrame({ bootId, rev, asOf, staleAfter: slot.staleAfter, turn });
        // The hello carries the session's phase as of subscribe time. Absent on
        // every server that predates the field, which must not blank a phase a
        // heartbeat already delivered.
        slot.phase = readPhase(event.phase) ?? slot.phase;
        slot.toolName = readToolName(event.toolName);
        forceRender();
        return;
      }

      if (event.kind === 'activity.snapshot' || event.kind === 'activity.upsert') {
        if (event.sessionId !== sessionId) return;
        // A snapshot before any hello has no threshold to judge silence against,
        // exactly like a beat.
        if (slot.staleAfter === null) return;

        const asOf = parseServerTime(event.asOf);
        if (asOf === null) return;

        // The one frame that names when the turn began on the server's own clock.
        // Feeding it to the machine as the turn anchor — rather than the frame's
        // `asOf` — is what makes the elapsed reading survive a remount: the fresh
        // machine adopts the same start from the replayed snapshot instead of
        // restarting the clock at the moment it happened to hear a frame. A
        // snapshot carrying no start asserts no new turn (no run is bound to it),
        // so it advances the clock and leaves the anchor alone, like a bare beat.
        const turnStart = readTurnStart(event.turn);
        machine.onFrame({
          bootId: typeof event.bootId === 'string' ? event.bootId : '',
          rev: typeof event.rev === 'number' ? event.rev : 0,
          asOf,
          staleAfter: slot.staleAfter,
          ...(turnStart === null ? {} : { turn: { startedAt: turnStart } }),
        });
        forceRender();
        return;
      }

      if (event.kind === 'activity.heartbeat') {
        if (event.sessionId !== sessionId) return;
        // A heartbeat before any hello has no threshold to judge against.
        if (slot.staleAfter === null) return;

        const asOf = parseServerTime(event.timestamp);
        if (asOf === null) return;

        const bootId = typeof event.bootId === 'string' ? event.bootId : '';
        // The beat is where a phase change arrives: the server reduces the raw
        // frame stream and stamps the result onto every beat, so a browser reads
        // what the turn is really doing without a clock of its own.
        const reportedPhase = readPhase(event.phase);
        // The run registry's own "is a run in flight for this session" bit, which
        // the server reads at beat time and folds onto every heartbeat. It is the
        // authority for whether the turn is over: the phase tracker reports `idle`
        // both when a turn *ended* and when it has simply never seen a
        // phase-carrying frame for a turn that is running, so the phase alone
        // cannot tell the two apart. Absent on a server built before the field,
        // where the phase is the only turn evidence there is.
        const reportedInFlight = typeof event.isProcessing === 'boolean' ? event.isProcessing : null;
        const snapshot = machine.getSnapshot();

        // The beat is also the frame that can *end* a turn. Which evidence decides
        // it, in order of authority:
        let turn: { startedAt: number | null } | undefined;
        if (reportedInFlight === null) {
          // Fallback (a server predating the field): the phase alone. `idle` is the
          // absence of a turn, so it clears the anchor a hello pinned; a running
          // phase confirms the turn and carries its anchor forward, so the clock
          // continues rather than restarting at the beat that delivered it; and no
          // known phase asserts nothing at all, leaving a bare beat's elapsed
          // reading untouched.
          turn = reportedPhase === null
            ? undefined
            : reportedPhase === 'idle'
              ? { startedAt: null }
              : {
                  // Carry the anchor across a beat only while the same server process
                  // is in force; a new boot identity voids the turn that process began.
                  startedAt: snapshot.bootId === bootId ? (snapshot.turnStartedAt ?? asOf) : asOf,
                };
        } else if (!reportedInFlight) {
          // The registry says no run is in flight: the turn really ended (or never
          // began), so the anchor is cleared. This is the guarantee the idle-beat
          // clearing was introduced for — a finished turn must not count up forever.
          turn = { startedAt: null };
        } else {
          // A run *is* in flight. The tracker may still report `idle` because it has
          // seen no phase-carrying frame, and that must not be read as an ended turn:
          // the anchor is kept (or re-anchored) so the server-derived elapsed keeps
          // advancing, which is what the dock's recovered reading depends on.
          turn = {
            // Carry the anchor across a beat only while the same server process is in
            // force; a new boot identity voids the turn that process began.
            startedAt: snapshot.bootId === bootId ? (snapshot.turnStartedAt ?? asOf) : asOf,
          };
        }

        machine.onFrame({
          bootId,
          rev: typeof event.rev === 'number' ? event.rev : 0,
          asOf,
          staleAfter: slot.staleAfter,
          ...(turn === undefined ? {} : { turn }),
        });
        slot.phase = reportedPhase ?? slot.phase;
        slot.toolName = readToolName(event.toolName);
        forceRender();
      }
    };

    return subscribe(listener);
  }, [subscribe, sessionId, slot, forceRender]);

  useEffect(() => {
    if (isConnected) {
      return;
    }
    // The socket is gone; degrade now rather than waiting the budget out. This
    // leaves the turn and its anchor untouched, so the elapsed reading freezes.
    slot.machine.onSocketClose();
    forceRender();
  }, [isConnected, slot, forceRender]);

  // A live one-second tick keeps the dock mounted even when no frame is arriving.
  // It cannot make the elapsed reading advance: that comes from the server's
  // `asOf`, so an unreachable turn keeps the same number across every tick.
  useEffect(() => {
    const timer = setInterval(() => forceRender(), 1_000);
    return () => clearInterval(timer);
  }, [forceRender]);

  const snapshot = slot.machine.getSnapshot();

  return {
    liveness: snapshot.liveness,
    elapsedMs: slot.machine.getElapsedMs(),
    hasTurnAnchor: snapshot.turnStartedAt !== null,
    wired,
    phase: slot.phase,
    toolName: slot.toolName,
  };
};
