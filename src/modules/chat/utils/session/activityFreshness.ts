/**
 * Client-side freshness state machine for Claude session activity.
 *
 * The client renders "a turn is in progress" from a local table that nothing on a dead
 * server can ever clear; this machine is the missing half — it turns the server's own
 * activity frames into an honest liveness reading, so the client stops claiming activity
 * once the evidence runs out.
 *
 * It is deliberately pure: no React, no WebSocket context, no network. Frames and the
 * socket lifetime arrive through `onFrame` / `onSocketClose`; wall-clock time and timers
 * arrive through injected dependencies (defaulting to the globals), so a test drives every
 * boundary with a fake clock and an in-memory frame source.
 *
 * Used by chat's activity-dock wiring and by this file's own criterion
 * (`src/modules/chat/tests/activityFreshness.test.ts`).
 */

/** How much evidence the client currently has that the server is alive. */
export type ActivityLiveness = 'fresh' | 'unreachable';

/** The in-progress turn as the server last reported it; `startedAt` is null when idle. */
export type ActivityTurnSnapshot = {
  /** Server clock reading at which the running turn began, or null when no turn is running. */
  startedAt: number | null;
};

/**
 * One frame from the server's activity stream (a snapshot or a heartbeat). It carries both
 * the liveness evidence (`bootId` / `rev` / `asOf` / `staleAfter`) and, when it is a
 * snapshot rather than a bare heartbeat, the turn state the client should adopt.
 */
export type ActivityFrame = {
  /** Identifier of the server process that produced the frame; a change means it restarted. */
  bootId: string;
  /** Session-scoped monotonic version of the activity state. */
  rev: number;
  /** Server clock reading at which this frame was produced. */
  asOf: number;
  /** Server-declared silence budget: no frame for this many ms means unreachable. */
  staleAfter: number;
  /** The turn snapshot this frame carries; absent on a bare heartbeat. */
  turn?: ActivityTurnSnapshot;
};

/** Read-only view of the machine, for selectors and tests. */
export type ActivityFreshnessSnapshot = {
  liveness: ActivityLiveness;
  bootId: string | null;
  rev: number | null;
  /** Server clock reading of the last frame, or null while only a local turn is assumed. */
  asOf: number | null;
  turnStartedAt: number | null;
  staleAfter: number | null;
  /** True while `turnStartedAt` is a local send-time assumption the server has not confirmed. */
  turnIsLocal: boolean;
};

/** Timer handle type; follows the repository's `ReturnType<typeof setTimeout>` convention. */
type TimerHandle = ReturnType<typeof setTimeout>;

/** Injectable clock and timer seams, so the machine is testable without real time. */
export type ActivityFreshnessDeps = {
  now: () => number;
  setTimeout: (handler: () => void, ms: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
};

/** The machine's public surface. */
export type ActivityFreshness = {
  /** Feed one server frame; any frame is fresh evidence and re-arms the silence timer. */
  onFrame: (frame: ActivityFrame) => void;
  /** The socket closed: degrade immediately instead of waiting the budget out. */
  onSocketClose: () => void;
  /** Locally assume a turn began (e.g. the client just sent); not evidence the server is up. */
  markLocalTurnStarted: (startedAt?: number) => void;
  getLiveness: () => ActivityLiveness;
  /** Elapsed time of the in-progress turn, or null when idle or unconfirmed. */
  getElapsedMs: () => number | null;
  getSnapshot: () => ActivityFreshnessSnapshot;
  /** Drop any pending timer; call when the owner unmounts. */
  dispose: () => void;
};

/**
 * The production seams. The arrow bodies resolve the globals at call time, so fake timers
 * installed by a test are honored even though this object is created once at module load.
 */
const DEFAULT_DEPS: ActivityFreshnessDeps = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

/**
 * Build a fresh state machine. All state is per-call; the factory holds none, so two
 * sessions never share a liveness reading.
 */
export const createActivityFreshness = (
  deps: ActivityFreshnessDeps = DEFAULT_DEPS,
): ActivityFreshness => {
  // Until a frame proves otherwise there is no evidence, and "no evidence" must read as
  // unreachable — the benign default is exactly what let the old indicator keep lying.
  let liveness: ActivityLiveness = 'unreachable';
  let bootId: string | null = null;
  let rev: number | null = null;
  let asOf: number | null = null;
  let staleAfter: number | null = null;
  let turnStartedAt: number | null = null;
  // Whether `turnStartedAt` is a local send-time assumption rather than a server snapshot.
  let turnIsLocal = false;
  let timer: TimerHandle | null = null;

  const clearTimer = () => {
    if (timer !== null) {
      deps.clearTimeout(timer);
      timer = null;
    }
  };

  // Arm (or re-arm) the silence timer, which fires once `staleAfter` passes with no frame.
  const armTimer = () => {
    clearTimer();
    if (staleAfter === null) return;
    timer = deps.setTimeout(() => {
      timer = null;
      liveness = 'unreachable';
    }, staleAfter);
  };

  const onFrame = (frame: ActivityFrame) => {
    // A frame whose bootId is not the one in force means the server process was replaced (or
    // the very first frame has just arrived). Any in-progress turn we merely *assumed*
    // belonged to that other process, so it is void and the frame's snapshot is the authority.
    const bootIdentityChanged = frame.bootId !== bootId;
    if (bootIdentityChanged) {
      turnIsLocal = false;
      turnStartedAt = null;
      asOf = null;
    }

    bootId = frame.bootId;
    rev = frame.rev;
    staleAfter = frame.staleAfter;

    if (frame.turn) {
      // A same-identity idle snapshot cannot refute a turn this client optimistically marked:
      // the frame may predate the send that produced the assumption. A boot identity change
      // (above) or the server reporting a turn replaces the assumption.
      const keepLocalTurn = frame.turn.startedAt === null && turnIsLocal;
      if (!keepLocalTurn) {
        turnStartedAt = frame.turn.startedAt;
        asOf = frame.asOf;
        turnIsLocal = false;
      }
    } else if (!turnIsLocal) {
      // Bare heartbeat: advance the elapsed anchor without asserting a new turn state.
      asOf = frame.asOf;
    }

    liveness = 'fresh';
    armTimer();
  };

  const onSocketClose = () => {
    // The connection is gone but a local clock is not evidence of anything: degrade now and
    // leave the turn and its anchor untouched, so the elapsed reading stays frozen.
    clearTimer();
    liveness = 'unreachable';
  };

  const markLocalTurnStarted = (startedAt?: number) => {
    turnStartedAt = startedAt ?? deps.now();
    // No server `asOf` exists yet, so there is nothing elapsed to report until a frame lands.
    asOf = null;
    turnIsLocal = true;
    // Liveness is intentionally untouched: a local send is not evidence the server is up.
  };

  const getElapsedMs = (): number | null => {
    // Elapsed is derived only from what the server told us — never from a local clock. The
    // anchor (`asOf`) is fixed between frames, so an unreachable turn keeps the same reading
    // while wall-clock time passes; that freezing is this fact, not an extra branch.
    if (turnStartedAt === null || asOf === null) return null;
    return asOf - turnStartedAt;
  };

  const getSnapshot = (): ActivityFreshnessSnapshot => ({
    liveness,
    bootId,
    rev,
    asOf,
    turnStartedAt,
    staleAfter,
    turnIsLocal,
  });

  const dispose = () => {
    clearTimer();
  };

  return {
    onFrame,
    onSocketClose,
    markLocalTurnStarted,
    getLiveness: () => liveness,
    getElapsedMs,
    getSnapshot,
    dispose,
  };
};
