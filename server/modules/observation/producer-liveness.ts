/**
 * The observation layer's OWN liveness — "a quiet wall does not mean nothing is wrong".
 *
 * Every producer (session digest, project truth, architecture delta, and anything added later)
 * registers its expected cadence and records each attempt. The wall reads those heartbeats
 * beside the observed objects and says, in the same three-state vocabulary, whether the layer
 * that fills it is itself alive. A producer that failed to start, crashed, or silently stopped
 * trying therefore shows up as `unevaluated` / `stale` / `red` instead of an empty, healthy
 * looking wall.
 *
 * The rules are pure and read through an injected `now`, so the criterion can drive them with
 * a fake clock rather than sleeping:
 *
 *   never attempted                     → `unevaluated` (reason says it has never run)
 *   most recent attempt carried an error → `red`          (reason is that error)
 *   no attempt for more than 2 × cadence → `attention` + `stale: true`
 *   otherwise                           → `ok`
 *
 * `red` outranks `stale`: the last thing we know is that the producer FAILED, which is a
 * stronger statement than "it has been quiet too long" even when both are true.
 *
 * Consumers: `server/modules/observation/observation-store.ts` (the wall's `producers[]` and
 * its 「观察层自身」 entry) and `server/modules/observation/tests/producer-liveness.test.ts`.
 */

/** How many expected intervals a silent producer may span before it reads as stale. */
export const PRODUCER_STALE_MULTIPLIER = 2;

/** The three-state reading a producer's heartbeat resolves to. */
export type ProducerLivenessState = 'ok' | 'attention' | 'red' | 'unevaluated';

/** One producer's stored heartbeat. Both timestamps are null until the first attempt. */
export type ProducerHeartbeat = {
  producer: string;
  lastAttemptAt: number | null;
  lastWriteAt: number | null;
  lastError: string | null;
  expectedIntervalMs: number;
};

/**
 * One producer's reading on the wall.
 *
 * `reason` is non-null exactly when the state is not `ok`, and `stale` is a separate boolean
 * because "too quiet" is orthogonal to the state it maps to: a red producer can also be stale.
 */
export type ProducerReading = {
  producer: string;
  state: ProducerLivenessState;
  stale: boolean;
  reason: string | null;
  lastAttemptAt: number | null;
  lastWriteAt: number | null;
  expectedIntervalMs: number;
};

/**
 * Resolves one stored heartbeat at `now`.
 *
 * A heartbeat registered but never attempted is the `unevaluated` case the wall must never
 * paint green — "we have no reading" and "the reading is healthy" are different facts.
 */
export function evaluateProducer(heartbeat: ProducerHeartbeat, now: number): ProducerReading {
  const base = {
    producer: heartbeat.producer,
    lastAttemptAt: heartbeat.lastAttemptAt,
    lastWriteAt: heartbeat.lastWriteAt,
    expectedIntervalMs: heartbeat.expectedIntervalMs,
  };

  if (heartbeat.lastAttemptAt === null) {
    return {
      ...base,
      state: 'unevaluated',
      stale: false,
      reason: 'producer has never run',
    };
  }

  const silentForMs = now - heartbeat.lastAttemptAt;
  const stale = silentForMs > PRODUCER_STALE_MULTIPLIER * heartbeat.expectedIntervalMs;

  if (heartbeat.lastError !== null) {
    return { ...base, state: 'red', stale, reason: heartbeat.lastError };
  }
  if (stale) {
    return {
      ...base,
      state: 'attention',
      stale: true,
      reason: `no attempt for ${silentForMs}ms (expected every ${heartbeat.expectedIntervalMs}ms)`,
    };
  }
  return { ...base, state: 'ok', stale: false, reason: null };
}
