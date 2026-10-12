/**
 * The upstream SESSION POOL — one active Realtime session plus at most one pre-warmed
 * standby, and a transparent idle rotation between them (SPEC §C3).
 *
 * WHY IT EXISTS. Measured on the real upstream (P0a / S2): opening a Realtime session and
 * getting to `session.updated` costs `p50=259ms p90=736ms min=130ms max=736ms`, and the
 * socket is NOT warmed before the response is done (`warmed_before_done=false`). A relay
 * that opens its session only when the user starts speaking therefore spends that latency
 * on the first thing they say. The fix P0a concluded workable is what this module ships:
 * keep a session open, keep a SECOND one opening next to it, and when the active one has
 * been idle long enough, switch to the standby and refill in the background.
 *
 * WHAT IT IS. A `RealtimeBridge`. Every method the proxy calls is forwarded to whichever
 * session is active at that instant, so the proxy, the executor and the page cannot tell a
 * pool from a single session. A rotation swaps the session UNDER those calls — it never
 * migrates history: the context is re-injected into the new session by the context pack
 * (SPEC §C2), which is why a rotation is only ever attempted while nothing is in flight.
 *
 * TWO RULES THE SPEC IS EXPLICIT ABOUT, and where they live:
 *  1. NO ROTATION WHILE SOMETHING IS IN FLIGHT — a segment's audio, or a commit whose
 *     response is still owed, keeps the current session. Switching there would strand the
 *     half-delivered utterance on a session that is about to be closed. See
 *     {@link canSwitchNow}.
 *  2. THE STANDBY GETS NO AUDIO — it opens a connection and is told the session
 *     instructions (so it is warmed through `session.updated`, the P0a measurement), and
 *     that is all. Audio frames go to the active session only; the criterion counts the
 *     standby's `input_audio_buffer.append` frames and requires 0 before a rotation.
 *
 * WHAT A ROTATION COSTS, AND WHAT IT SAYS. The switch is synchronous once the standby is
 * known ready: from the trigger to the flip the pool only awaits the standby's `open`
 * (usually already true, so a microtask), and the retired session is closed OFF the hot
 * path. `rotate` is logged with the facts the SPEC asks for —
 * `rotate from=<n> to=<n> idleMs=<n> standbyAgeMs=<n>` — plus `switchMs`, the measured
 * trigger→flip latency the criterion bounds against the P0a baseline.
 */
import type {
  RealtimeBridge,
  RealtimeBridgeHooks,
  RealtimeBridgeState,
} from './voice-realtime-bridge.service.js';

/**
 * How long the active session may sit idle before the pool switches to the standby.
 *
 * The SPEC's default is 90 s. Idle means: no segment in flight, no commit awaiting its
 * response, and no audio arrived — a person who pauses for a minute and a half is very
 * likely done, and the switch costs nothing they can perceive because the standby is
 * already open.
 */
export const DEFAULT_IDLE_ROTATE_MS = 90_000;

/**
 * How long a rotation may wait for a standby that is still opening.
 *
 * The standby is opened right after the previous rotation, so by the time the idle
 * threshold fires it is `open` and this wait is skipped. It is not skipped when the
 * standby's socket failed: there the pool gives up, throws the broken standby away and
 * leaves the active session alone — an upstream that cannot keep a spare open must not
 * cost the one that works.
 */
export const DEFAULT_STANDBY_READY_TIMEOUT_MS = 5_000;

/** One performed rotation, as {@link UpstreamPool.rotations} reports it. */
export type UpstreamPoolRotation = {
  /** The ordinal of the session that was active before the switch. */
  from: number;
  /** The ordinal of the (previously standby) session that is active after it. */
  to: number;
  /** How long the old session had been idle when the switch was triggered (ms). */
  idleMs: number;
  /** How long the standby had been open, from its construction to the trigger (ms). */
  standbyAgeMs: number;
  /**
   * Trigger → the new session being able to accept audio (ms). This is the number the
   * SPEC's criterion bounds against the P0a-S2 session-open baseline ×1.5.
   */
  switchMs: number;
};

/** The pool's own hooks — the bridge's, plus what only a pool can report. */
export type UpstreamPoolHooks = RealtimeBridgeHooks & {
  /** One completed rotation. Also available afterwards on `UpstreamPool.rotations`. */
  onRotate?: (rotation: UpstreamPoolRotation) => void;
  /**
   * A rotation was attempted and did not happen. Rotation is opportunistic by design, so
   * this is a report, not an error: the connection keeps running on the active session.
   */
  onRotateFailed?: (failure: { reason: string }) => void;
};

/** How {@link createUpstreamPool} is configured. */
export type UpstreamPoolOptions = {
  /**
   * Opens ONE session. Called once for the active session and once per standby, and again
   * after every rotation. The pool never reuses a session object: a retired one is closed.
   */
  createSession: (hooks: RealtimeBridgeHooks) => RealtimeBridge;
  /** Idle threshold before a switch. Default {@link DEFAULT_IDLE_ROTATE_MS}; `0` disables rotation. */
  idleRotateMs?: number;
  /** Ceiling on the wait for a standby to open. Default {@link DEFAULT_STANDBY_READY_TIMEOUT_MS}. */
  standbyReadyTimeoutMs?: number;
  hooks?: UpstreamPoolHooks;
  /** Injectable clock, for a criterion that wants deterministic readings. Default `Date.now`. */
  now?: () => number;
  /** One plain log line per pool event. `rotate` is the SPEC's line; failures are logged too. */
  log?: (line: string) => void;
};

/** A pool is a bridge; the extra readers are what the criteria and the diagnosis report use. */
export type UpstreamPool = RealtimeBridge & {
  /** The ordinal of the session that is active right now. Starts at 1, +1 per rotation. */
  readonly activeOrdinal: number;
  /** The ordinal of the pre-warmed standby, or `null` while it is being (re)built. */
  readonly standbyOrdinal: number | null;
  /** The idle threshold in force, as the pool resolved it. */
  readonly idleRotateMs: number;
  /** Every rotation performed, oldest first. Never cleared — the pool's own ledger. */
  readonly rotations: readonly UpstreamPoolRotation[];
};

/** One session the pool is holding, and what the pool knows about it. */
type PooledSession = {
  bridge: RealtimeBridge;
  ordinal: number;
  /** The session every forwarded call currently goes to. Exactly one is true at a time. */
  active: boolean;
  /** When this session's `connect` was issued — the age a rotation reports. */
  openedAt: number;
  /** Whether the session instructions have been written to this session already. */
  instructed: boolean;
};

/**
 * Builds the pool.
 *
 * The active session is created here and the standby right after it, so a connection that
 * is handed a pool starts warming its replacement in the same tick. Consumers:
 * `voice-realtime-ws-proxy.service.ts` when its `upstreamPool` seam is set (which is what
 * `server/index.ts` does for a deployment, under {@link VOICE_REALTIME_IDLE_ROTATE_MS_ENV}).
 */
export function createUpstreamPool(options: UpstreamPoolOptions): UpstreamPool {
  const hooks = options.hooks ?? {};
  const now = options.now ?? Date.now;
  const idleRotateMs = options.idleRotateMs ?? DEFAULT_IDLE_ROTATE_MS;
  const standbyReadyTimeoutMs = options.standbyReadyTimeoutMs ?? DEFAULT_STANDBY_READY_TIMEOUT_MS;

  const sessions = new Set<PooledSession>();
  const rotations: UpstreamPoolRotation[] = [];
  let ordinalCounter = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  /** One rotation at a time: the timer and an explicit refill must not race the same standby. */
  let rotating = false;
  /** When the active session last saw anything worth calling activity. */
  let lastActivityAt = now();
  /** The instructions last handed to `sendSessionUpdate`, replayed into every new session. */
  let instructions: string | null = null;

  function poolLog(line: string): void {
    options.log?.(`upstream-pool ${line}`);
  }

  function armIdleTimer(): void {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (closed || idleRotateMs <= 0) {
      return;
    }
    idleTimer = setTimeout(() => {
      idleTimer = null;
      void attemptRotation();
    }, idleRotateMs);
    // The pool must never be the reason a process stays up.
    idleTimer.unref?.();
  }

  /** Anything the user did: the idle clock restarts. */
  function touch(): void {
    lastActivityAt = now();
    armIdleTimer();
  }

  /**
   * Writes the session instructions into `session` once, if they are known and it is open.
   *
   * This is what WARMS the standby the way P0a measured (`session.updated` reached before
   * the first segment). It deliberately carries no audio: the standby is a connection that
   * is ready, not a session that has heard anything.
   */
  function ensureInstructed(session: PooledSession): void {
    if (instructions === null || session.instructed || session.bridge.state !== 'open') {
      return;
    }
    session.instructed = true;
    session.bridge.sendSessionUpdate(instructions);
  }

  function makeSession(): PooledSession | null {
    ordinalCounter += 1;
    const pooled: PooledSession = {
      bridge: null as unknown as RealtimeBridge,
      ordinal: ordinalCounter,
      active: false,
      openedAt: now(),
      instructed: false,
    };
    try {
      pooled.bridge = options.createSession({
        onStateChange: (next, previous) => {
          ensureInstructed(pooled);
          // Only the active session's state reaches the page. A retired session's close,
          // and a standby's open, are the pool's business: the connection never blinks.
          if (pooled.active) {
            hooks.onStateChange?.(next, previous);
          }
        },
        onError: (error) => {
          if (pooled.active) {
            hooks.onError?.(error);
          }
        },
        onCaption: (caption) => {
          if (!pooled.active) {
            return;
          }
          touch();
          hooks.onCaption?.(caption);
        },
        onSegmentPhase: (event) => {
          if (!pooled.active) {
            return;
          }
          touch();
          hooks.onSegmentPhase?.(event);
        },
        // The committed-user-utterance signal belongs to the ACTIVE upstream only: a standby
        // session carries no user audio yet, and a retired one's events are the pool's business,
        // not the connection's. Forwarded so the proxy's continuous-mode duplicate guard keeps
        // counting commits after a rotation — without this the guard silently stops seeing them
        // whenever {@link UpstreamPoolOptions.idleRotateMs} is enabled. The payload (the item id and
        // the seq its commit belongs to) is forwarded UNCHANGED: it is the session's own answer about
        // its own commit, and the pool has no standing to reinterpret it.
        onUserAudioCommitted: (event) => {
          if (!pooled.active) {
            return;
          }
          touch();
          hooks.onUserAudioCommitted?.(event);
        },
        // Same rule for a refused commit: the seq is the ACTIVE session's. A retired session's
        // refusal is a fact about a segment that was already reported on that session, and the pool
        // never migrates a segment across a rotation.
        onSegmentCommitRejected: (event) => {
          if (!pooled.active) {
            return;
          }
          touch();
          hooks.onSegmentCommitRejected?.(event);
        },
      });
    } catch (cause) {
      poolLog(`session open failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      return null;
    }
    sessions.add(pooled);
    ensureInstructed(pooled);
    return pooled;
  }

  /**
   * Whether the active session may be swapped out right now.
   *
   * A segment still being written (`openSegmentSeq`) or a commit whose response has not
   * come back (`committedSegmentSeq`) owns the session: the utterance is half-delivered,
   * and its remainder would land on a session that is about to be closed. Both readings
   * come from the bridge itself, so the pool needs no notion of what a segment is.
   */
  function canSwitchNow(): boolean {
    return active.bridge.openSegmentSeq === null && active.bridge.committedSegmentSeq === null;
  }

  /** Waits until `bridge` is open, or gives up. Never rejects, so a timer can call it. */
  async function waitForOpen(bridge: RealtimeBridge, timeoutMs: number): Promise<boolean> {
    const deadline = now() + timeoutMs;
    for (;;) {
      // Read once per turn: the state is a live reading of a socket, not a value that stays
      // narrowed across an `await`.
      const state: RealtimeBridgeState = bridge.state;
      if (state === 'open') {
        return true;
      }
      if (state === 'closed') {
        return false;
      }
      if (now() >= deadline) {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  /** Throws a standby away — it did not become ready, so it is not worth keeping. */
  function discardStandby(candidate: PooledSession, reason: string): void {
    if (standby === candidate) {
      standby = null;
    }
    sessions.delete(candidate);
    void candidate.bridge.close().catch(() => undefined);
    poolLog(`ROTATE_FAILED ${reason}`);
    hooks.onRotateFailed?.({ reason });
  }

  async function attemptRotation(): Promise<void> {
    if (closed || rotating) {
      return;
    }
    if (!canSwitchNow()) {
      poolLog('rotate postponed: a segment is still in flight');
      armIdleTimer();
      return;
    }
    let candidate = standby;
    if (candidate === null) {
      candidate = makeSession();
      standby = candidate;
      if (candidate === null) {
        poolLog('ROTATE_FAILED the standby session could not be created');
        hooks.onRotateFailed?.({ reason: 'the standby session could not be created' });
        armIdleTimer();
        return;
      }
    }
    const triggeredAt = now();
    rotating = true;
    try {
      const ready = await waitForOpen(candidate.bridge, standbyReadyTimeoutMs);
      if (closed) {
        return;
      }
      if (!ready || candidate.bridge.state !== 'open') {
        discardStandby(candidate, 'the standby session did not become ready in time');
        armIdleTimer();
        return;
      }
      // The wait yielded: a segment may have opened on the active session meanwhile. That
      // segment still owns the active session, so this attempt is the one that waits.
      if (!canSwitchNow()) {
        poolLog('rotate postponed: a segment arrived while the standby was being awaited');
        armIdleTimer();
        return;
      }
      const previous = active;
      const rotation: UpstreamPoolRotation = {
        from: previous.ordinal,
        to: candidate.ordinal,
        idleMs: triggeredAt - lastActivityAt,
        standbyAgeMs: triggeredAt - candidate.openedAt,
        switchMs: now() - triggeredAt,
      };
      // The flip. Everything above may await; this may not — from here the new session
      // takes the next frame, whichever microtask it arrives on.
      previous.active = false;
      candidate.active = true;
      active = candidate;
      standby = null;
      rotations.push(rotation);
      lastActivityAt = triggeredAt;
      poolLog(
        `rotate from=${rotation.from} to=${rotation.to} idleMs=${rotation.idleMs} standbyAgeMs=${rotation.standbyAgeMs} switchMs=${rotation.switchMs}`,
      );
      hooks.onRotate?.(rotation);
    } finally {
      rotating = false;
    }
    // Off the hot path: the retired session goes, a replacement standby comes.
    const retired = [...sessions].find((session) => !session.active && session !== standby && session !== candidate);
    if (retired !== undefined) {
      sessions.delete(retired);
      void retired.bridge.close().catch(() => undefined);
    }
    if (!closed && standby === null) {
      standby = makeSession();
    }
    // NO re-arm. A rotation ENDS an idle period: the clock starts again on the next thing
    // the user does (`touch`, from any forwarded call or caption), so a connection left
    // quiet overnight rotates once rather than opening a fresh upstream every 90 s forever.
    // The failure and postponed paths above DO re-arm — there the attempt bought nothing,
    // and the pool should try again rather than wait for activity that may never come.
  }

  const first = makeSession();
  if (first === null) {
    throw new Error('the upstream session pool could not open its first session');
  }
  first.active = true;
  let active: PooledSession = first;
  let standby: PooledSession | null = makeSession();
  lastActivityAt = now();
  armIdleTimer();

  return {
    get state(): RealtimeBridgeState {
      return active.bridge.state;
    },
    get openAttempts(): number {
      return active.bridge.openAttempts;
    },
    get activeOrdinal(): number {
      return active.ordinal;
    },
    get standbyOrdinal(): number | null {
      return standby?.ordinal ?? null;
    },
    get idleRotateMs(): number {
      return idleRotateMs;
    },
    get rotations(): readonly UpstreamPoolRotation[] {
      return rotations;
    },
    whenConnected: () => active.bridge.whenConnected(),
    sendSessionUpdate(text: string): void {
      instructions = text;
      // The active session is told now; the standby is told too, so a rotation does not
      // arrive at a session that never received the prompt. Both are idempotent by flag.
      for (const session of sessions) {
        ensureInstructed(session);
      }
      touch();
    },
    sendAudioFrame(audio: string): void {
      active.bridge.sendAudioFrame(audio);
      touch();
    },
    // Forwarded to the ACTIVE session, like every other per-connection verb: the utterance was
    // heard on this connection, and a rotation between its start and its end must not leave the
    // claim on a bridge that no longer owns the audio.
    noteLocalUtteranceStart(): void {
      active.bridge.noteLocalUtteranceStart();
      touch();
    },
    noteLocalUtteranceEnd(): void {
      active.bridge.noteLocalUtteranceEnd();
      touch();
    },
    // The audio arrived, even if Silence Tail Suppression chose not to forward it. Without this the
    // pool would read a suppressed quiet stretch as an idle connection and rotate out of it (see
    // `RealtimeBridge.noteLocalActivity`); the microphone was never idle.
    noteLocalActivity(): void {
      touch();
    },
    startSegment(seq: number): void {
      active.bridge.startSegment(seq);
      touch();
    },
    sendSegmentAudio(seq: number, audio: string): void {
      active.bridge.sendSegmentAudio(seq, audio);
      touch();
    },
    endSegment(seq: number): void {
      active.bridge.endSegment(seq);
      touch();
    },
    flushOpenSegment(): number | null {
      const seq = active.bridge.flushOpenSegment();
      if (seq !== null) {
        touch();
      }
      return seq;
    },
    get openSegmentSeq(): number | null {
      return active.bridge.openSegmentSeq;
    },
    get committedSegmentSeq(): number | null {
      return active.bridge.committedSegmentSeq;
    },
    async close(): Promise<void> {
      closed = true;
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      const held = [...sessions];
      sessions.clear();
      standby = null;
      await Promise.all(held.map((session) => session.bridge.close().catch(() => undefined)));
    },
  };
}

/**
 * The environment variable that moves a deployment's idle threshold, in milliseconds.
 *
 * Exists because the seams are built by `server/index.ts` for BOTH the browser path and
 * the HTTP diagnosis path, and neither the websocket handshake nor the diagnosis body
 * carries a pool setting — the route's body is transport input, and a rotation threshold
 * is not transport input. A diagnosis run that wants to OBSERVE a rotation sets this to a
 * few hundred ms; a deployment leaves it unset and rotates at {@link DEFAULT_IDLE_ROTATE_MS}.
 * `0` (or any non-positive value) turns rotation off.
 */
export const VOICE_REALTIME_IDLE_ROTATE_MS_ENV = 'VOICE_REALTIME_IDLE_ROTATE_MS';
