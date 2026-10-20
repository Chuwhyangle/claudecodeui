/**
 * The delivery of one sent message: did the server actually take it?
 *
 * The composer used to treat "the frame was handed to the socket" as "the
 * message was sent": it marked the session processing and cleared the draft in
 * the same tick, while `WebSocketContext.sendMessage` silently dropped the
 * frame when the socket was not open. With the server gone, the local table
 * still said a turn was running, the six rotating words still turned, and the
 * user's text was already gone.
 *
 * This machine is the missing half — a `sending → delivered | failed` phase
 * around one send. `begin()` arms an ack deadline; `ack()` (any frame the
 * server sends back) settles it delivered; `fail()` settles it failed now; and
 * the deadline firing settles it failed on its own. Time and timers arrive
 * through injected dependencies (defaulting to the globals) exactly as
 * `activityFreshness` does, so a test drives every boundary with a fake clock
 * and no network.
 *
 * The deadline is a shipped constant ({@link SEND_DELIVERY_TIMEOUT_MS}, 5s).
 * A browser run may shorten it through the per-selection `VITE_` environment
 * variable, which is the only place a shortened value may come from — the
 * end-to-end criterion uses a sub-second deadline so the failure lands well
 * inside its own 5s reading, and never hard-codes 5000.
 *
 * Used by `useChatComposerState`; its criterion is
 * `src/modules/chat/tests/sendDelivery.test.ts`.
 */

/** The shipped ack deadline: how long a send waits for the server's first word. */
export const SEND_DELIVERY_TIMEOUT_MS = 5_000;

/** Which per-selection environment variable may shorten the deadline. */
export const SEND_DELIVERY_TIMEOUT_ENV = 'VITE_SEND_DELIVERY_TIMEOUT_MS';

/** The lifecycle of one send. */
export type SendDeliveryPhase = 'idle' | 'sending' | 'delivered' | 'failed';

/** Timer handle type; follows the repository's `ReturnType<typeof setTimeout>` convention. */
type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * Injectable clock and timer seams, so the machine is testable without real
 * time. Every field is optional: a caller with only a settle handler (the
 * composer) takes the production globals for everything else.
 */
export type SendDeliveryDeps = {
  now?: () => number;
  setTimeout?: (handler: () => void, ms: number) => TimerHandle;
  clearTimeout?: (handle: TimerHandle) => void;
  /** Called exactly once, when the phase settles to `delivered` or `failed`. */
  onSettle?: (phase: 'delivered' | 'failed') => void;
  /** The ack deadline in ms; defaults to the shipped constant, or the env override. */
  timeoutMs?: number;
};

/** The machine's public surface. */
export type SendDelivery = {
  /** Start (or restart) the send and arm the ack deadline. */
  begin: () => void;
  /** The server answered: settle delivered. A no-op unless still sending. */
  ack: () => void;
  /** Settle failed now: the socket is gone, the send was refused, or the caller gave up. */
  fail: () => void;
  /** The current phase. */
  getPhase: () => SendDeliveryPhase;
  /** Ms between `begin()` and settling, or null while unsettled. */
  getLatencyMs: () => number | null;
  /** Drop any pending deadline; call when the owner unmounts. */
  dispose: () => void;
};

/** Reads the shipped deadline, honoring a positive per-selection override. */
export const readSendDeliveryTimeoutMs = (): number => {
  const raw = import.meta.env?.[SEND_DELIVERY_TIMEOUT_ENV];
  const parsed = typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : SEND_DELIVERY_TIMEOUT_MS;
};

/**
 * The production seams. The arrow bodies resolve the globals at call time, so
 * fake timers installed by a test are honored even though this object is
 * created once at module load.
 */
const DEFAULT_DEPS: Required<Pick<SendDeliveryDeps, 'now' | 'setTimeout' | 'clearTimeout'>> = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

/**
 * Build a send-delivery machine. All state is per-call; the factory holds none,
 * so two sends never share a phase.
 */
export const createSendDelivery = (deps: SendDeliveryDeps = {}): SendDelivery => {
  const now = deps.now ?? DEFAULT_DEPS.now;
  const setTimer = deps.setTimeout ?? DEFAULT_DEPS.setTimeout;
  const clearTimerFn = deps.clearTimeout ?? DEFAULT_DEPS.clearTimeout;
  const timeoutMs = deps.timeoutMs ?? readSendDeliveryTimeoutMs();

  let phase: SendDeliveryPhase = 'idle';
  let begunAt: number | null = null;
  let settledAt: number | null = null;
  let timer: TimerHandle | null = null;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimerFn(timer);
      timer = null;
    }
  };

  const settle = (next: 'delivered' | 'failed') => {
    if (phase !== 'sending') return;
    clearTimer();
    phase = next;
    settledAt = now();
    deps.onSettle?.(next);
  };

  const begin = () => {
    clearTimer();
    phase = 'sending';
    begunAt = now();
    settledAt = null;
    timer = setTimer(() => {
      timer = null;
      settle('failed');
    }, timeoutMs);
  };

  const ack = () => settle('delivered');
  const fail = () => settle('failed');

  const getLatencyMs = (): number | null =>
    begunAt === null || settledAt === null ? null : settledAt - begunAt;

  const dispose = () => {
    clearTimer();
  };

  return {
    begin,
    ack,
    fail,
    getPhase: () => phase,
    getLatencyMs,
    dispose,
  };
};
