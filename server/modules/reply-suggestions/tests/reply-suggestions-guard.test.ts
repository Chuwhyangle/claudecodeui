/**
 * Reply-suggestions upstream-guard criterion.
 *
 * The guard is driven with an injected clock and a counting `call`, so the
 * circuit, the two sliding windows and the instance-local state are read without
 * sleeping and without ever reaching a gateway.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/reply-suggestions/tests/reply-suggestions-guard.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createUpstreamGuard,
  REPLY_SUGGESTIONS_CIRCUIT_COOLDOWN_MS,
  REPLY_SUGGESTIONS_CIRCUIT_FAILURE_THRESHOLD,
  type ReplySuggestionsLimits,
} from '../reply-suggestions-guard.js';

const GENEROUS: ReplySuggestionsLimits = { maxCallsPerMinute: 1000, maxCallsPerDay: 100_000 };

/** A clock the leg moves by hand; the guard never reads the wall clock. */
function clockAt(start: number): { now: () => number; advance: (ms: number) => void } {
  let clock = start;
  return {
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

/** A `call` that succeeds and counts itself. */
function countingSuccess(counts: { calls: number }, value = 'ok') {
  return async (): Promise<string> => {
    counts.calls += 1;
    return value;
  };
}

/** A `call` that always fails and counts itself. */
function countingFailure(counts: { calls: number }) {
  return async (): Promise<string> => {
    counts.calls += 1;
    throw new Error('upstream failed');
  };
}

function isCircuitOpen(failure: unknown): boolean {
  const error = failure as { statusCode?: number; code?: string; message?: string };
  return error.statusCode === 502
    && error.code === 'REPLY_SUGGESTIONS_UPSTREAM_FAILED'
    && (error.message ?? '').includes('circuit-open');
}

function isRateLimited(failure: unknown): boolean {
  const error = failure as { statusCode?: number; code?: string };
  return error.statusCode === 429 && error.code === 'REPLY_SUGGESTIONS_RATE_LIMITED';
}

test('(a) five consecutive failures open the circuit; an open circuit never calls upstream', async () => {
  const clock = clockAt(1_000_000);
  const guard = createUpstreamGuard({ now: clock.now });
  const counts = { calls: 0 };

  for (let attempt = 1; attempt <= REPLY_SUGGESTIONS_CIRCUIT_FAILURE_THRESHOLD; attempt += 1) {
    await assert.rejects(() => guard.run(GENEROUS, countingFailure(counts)));
  }
  assert.equal(counts.calls, REPLY_SUGGESTIONS_CIRCUIT_FAILURE_THRESHOLD);

  // Open: the next run rejects as circuit-open without invoking `call`.
  await assert.rejects(() => guard.run(GENEROUS, countingSuccess(counts)), isCircuitOpen);
  assert.equal(counts.calls, REPLY_SUGGESTIONS_CIRCUIT_FAILURE_THRESHOLD, 'the open circuit did not call upstream');
});

test('(b) the cooldown lets one trial through; a success recovers, a failure re-opens', async () => {
  const clock = clockAt(2_000_000);

  const recovering = createUpstreamGuard({ now: clock.now });
  const recoverCalls = { calls: 0 };
  for (let attempt = 1; attempt <= REPLY_SUGGESTIONS_CIRCUIT_FAILURE_THRESHOLD; attempt += 1) {
    await assert.rejects(() => recovering.run(GENEROUS, countingFailure(recoverCalls)));
  }
  clock.advance(REPLY_SUGGESTIONS_CIRCUIT_COOLDOWN_MS + 1);
  assert.equal(await recovering.run(GENEROUS, countingSuccess(recoverCalls, 'recovered')), 'recovered');
  assert.equal(recoverCalls.calls, REPLY_SUGGESTIONS_CIRCUIT_FAILURE_THRESHOLD + 1, 'one trial call went through');
  // The success closed the circuit: a further run is a normal call.
  assert.equal(await recovering.run(GENEROUS, countingSuccess(recoverCalls, 'again')), 'again');

  const reOpening = createUpstreamGuard({ now: clock.now });
  const reOpenCalls = { calls: 0 };
  for (let attempt = 1; attempt <= REPLY_SUGGESTIONS_CIRCUIT_FAILURE_THRESHOLD; attempt += 1) {
    await assert.rejects(() => reOpening.run(GENEROUS, countingFailure(reOpenCalls)));
  }
  clock.advance(REPLY_SUGGESTIONS_CIRCUIT_COOLDOWN_MS + 1);
  // The trial fails: the circuit opens again for another cooldown.
  await assert.rejects(() => reOpening.run(GENEROUS, countingFailure(reOpenCalls)));
  const callsAfterTrial = reOpenCalls.calls;
  await assert.rejects(() => reOpening.run(GENEROUS, countingSuccess(reOpenCalls)), isCircuitOpen);
  assert.equal(reOpenCalls.calls, callsAfterTrial, 'the re-opened circuit does not call upstream');

  // A second cooldown lets exactly one more trial through.
  clock.advance(REPLY_SUGGESTIONS_CIRCUIT_COOLDOWN_MS + 1);
  assert.equal(await reOpening.run(GENEROUS, countingSuccess(reOpenCalls, 'late')), 'late');
});

test('(c1) the per-minute cap rejects past the limit and recovers when the window slides', async () => {
  const clock = clockAt(3_000_000);
  const guard = createUpstreamGuard({ now: clock.now });
  const counts = { calls: 0 };
  const limits: ReplySuggestionsLimits = { maxCallsPerMinute: 2, maxCallsPerDay: 1000 };

  await guard.run(limits, countingSuccess(counts));
  await guard.run(limits, countingSuccess(counts));
  await assert.rejects(() => guard.run(limits, countingSuccess(counts)), isRateLimited);
  assert.equal(counts.calls, 2, 'the rejected attempt never reached upstream');

  clock.advance(60_001);
  await guard.run(limits, countingSuccess(counts));
  assert.equal(counts.calls, 3, 'the window slid past the first two calls');
});

test('(c2) the per-day cap rejects past the limit and recovers when the day window slides', async () => {
  const clock = clockAt(4_000_000);
  const guard = createUpstreamGuard({ now: clock.now });
  const counts = { calls: 0 };
  const limits: ReplySuggestionsLimits = { maxCallsPerMinute: 1000, maxCallsPerDay: 2 };

  await guard.run(limits, countingSuccess(counts));
  await guard.run(limits, countingSuccess(counts));
  await assert.rejects(() => guard.run(limits, countingSuccess(counts)), isRateLimited);
  assert.equal(counts.calls, 2);

  clock.advance(86_400_001);
  await guard.run(limits, countingSuccess(counts));
  assert.equal(counts.calls, 3, 'the day window slid past the first two calls');
});

test('(d) only an attempt that reaches `call` spends budget; rejected attempts spend none', async () => {
  const clock = clockAt(5_000_000);
  const guard = createUpstreamGuard({ now: clock.now });
  const counts = { calls: 0 };
  const limits: ReplySuggestionsLimits = { maxCallsPerMinute: 1, maxCallsPerDay: 1000 };

  await guard.run(limits, countingSuccess(counts));
  // A rate-limited attempt is refused BEFORE `call`, so it must not consume a
  // second slot: after the window slides, exactly one more call is allowed.
  await assert.rejects(() => guard.run(limits, countingSuccess(counts)), isRateLimited);
  assert.equal(counts.calls, 1);
  clock.advance(60_001);
  await guard.run(limits, countingSuccess(counts));
  assert.equal(counts.calls, 2);

  // An open circuit's rejected attempt likewise spends nothing: the cooldown
  // trial is still one call, not one plus the rejected attempts.
  const tripping = createUpstreamGuard({ now: clock.now });
  const tripCounts = { calls: 0 };
  for (let attempt = 1; attempt <= REPLY_SUGGESTIONS_CIRCUIT_FAILURE_THRESHOLD; attempt += 1) {
    await assert.rejects(() => tripping.run(GENEROUS, countingFailure(tripCounts)));
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await assert.rejects(() => tripping.run(GENEROUS, countingSuccess(tripCounts)), isCircuitOpen);
  }
  assert.equal(tripCounts.calls, REPLY_SUGGESTIONS_CIRCUIT_FAILURE_THRESHOLD, 'open-circuit rejections never called');
});

test('(e) two guard instances keep independent state', async () => {
  const clock = clockAt(6_000_000);
  const left = createUpstreamGuard({ now: clock.now });
  const right = createUpstreamGuard({ now: clock.now });
  const leftCalls = { calls: 0 };
  const rightCalls = { calls: 0 };
  const limits: ReplySuggestionsLimits = { maxCallsPerMinute: 1, maxCallsPerDay: 1000 };

  await left.run(limits, countingSuccess(leftCalls));
  await assert.rejects(() => left.run(limits, countingSuccess(leftCalls)), isRateLimited);
  // The right guard never saw that call, so its own budget is untouched.
  await right.run(limits, countingSuccess(rightCalls));
  assert.equal(leftCalls.calls, 1);
  assert.equal(rightCalls.calls, 1);

  // A breaker opened in one instance does not open the other.
  for (let attempt = 1; attempt <= REPLY_SUGGESTIONS_CIRCUIT_FAILURE_THRESHOLD; attempt += 1) {
    await assert.rejects(() => left.run(GENEROUS, countingFailure(leftCalls)));
  }
  await assert.rejects(() => left.run(GENEROUS, countingSuccess(leftCalls)), isCircuitOpen);
  assert.equal(await right.run(GENEROUS, countingSuccess(rightCalls, 'independent')), 'independent');
});
