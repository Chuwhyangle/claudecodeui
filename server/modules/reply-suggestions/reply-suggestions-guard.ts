/**
 * The upstream guard: the circuit breaker and the sliding call caps, owned in
 * one unit and used through a single `run(limits, call)` seam.
 *
 * WHAT IT OWNS. Five consecutive upstream failures open a 30-second circuit; an
 * attempt during the open period throws the circuit error WITHOUT calling `call`.
 * When the cooldown elapses exactly one trial call is allowed through (half
 * open): a success closes the circuit, a failure opens it again for another
 * cooldown. Separately, one-minute and one-day sliding windows cap how many real
 * calls a guard instance makes; an attempt past either cap throws the rate-limit
 * error WITHOUT calling `call`.
 *
 * WHAT IT DOES NOT OWN. Logging, prompt construction and per-session state live
 * elsewhere; `call` itself does its own logging and error mapping and rethrows an
 * AppError the guard passes through unchanged. A cached batch read never enters
 * `run`, so a cache hit spends no call budget and moves no breaker state.
 *
 * ONE INSTANCE PER SERVICE. The counters are closure state, so two guards are
 * independent; the service creates one guard per settings source (one per process).
 *
 * Consumers: `reply-suggestions-draw.ts` (its one completion attempt) and the
 * guard criterion in `tests/reply-suggestions-guard.test.ts`.
 */
import { AppError } from '@/shared/utils.js';

import type { ReplySuggestionsLimits } from './reply-suggestions-settings.js';

/**
 * Five consecutive failures open the circuit (documented in `docs/operations/reply-suggestions.md`).
 *
 * Consumers: this file and the guard criterion in
 * `tests/reply-suggestions-guard.test.ts`.
 */
export const REPLY_SUGGESTIONS_CIRCUIT_FAILURE_THRESHOLD = 5;

/**
 * How long the circuit stays open after the fifth consecutive failure.
 *
 * Consumers: this file, the guard criterion and the service criterion (which
 * advances its injected clock by this amount).
 */
export const REPLY_SUGGESTIONS_CIRCUIT_COOLDOWN_MS = 30_000;

/**
 * The 502 every failed upstream path answers with. `category` names the client
 * failure (`timeout`, `http`, `network`, `parse`, `shape`, `unknown`) or
 * `circuit-open`; the message never carries the key or a payload.
 *
 * Consumers: this file (`circuit-open`) and `reply-suggestions.service.ts`
 * (parse and call failures).
 */
export function replySuggestionsUpstreamError(category: string): AppError {
  return new AppError(`reply-suggestions upstream request failed (${category})`, {
    code: 'REPLY_SUGGESTIONS_UPSTREAM_FAILED',
    statusCode: 502,
  });
}

/** The 429 for an attempt past either call cap. */
function rateLimitedError(): AppError {
  return new AppError('reply suggestions are over their call limit', {
    code: 'REPLY_SUGGESTIONS_RATE_LIMITED',
    statusCode: 429,
  });
}

/**
 * The one method: run one upstream attempt under the breaker and the caps.
 *
 * Consumers: `reply-suggestions-draw.ts`, which holds one guard and wraps each
 * completion attempt in `run`.
 */
export type ReplySuggestionsUpstreamGuard = {
  run<T>(limits: ReplySuggestionsLimits, call: () => Promise<T>): Promise<T>;
};

/**
 * Build one guard. `now` is injectable so a criterion can move the clock instead
 * of sleeping; production leaves it as `Date.now`.
 *
 * Consumers: `reply-suggestions-draw.ts` only (one guard per draw runner).
 */
export function createUpstreamGuard(options: { now?: () => number } = {}): ReplySuggestionsUpstreamGuard {
  const now = options.now ?? Date.now;

  let consecutiveFailures = 0;
  let circuitOpenUntil = 0;
  // Sliding-window ledgers. Kept as sorted arrays of timestamps; pruned on every
  // check, so a quiet server carries only the last minute/day of entries.
  const minuteCalls: number[] = [];
  const dayCalls: number[] = [];

  function pruneCalls(window: number[], span: number, at: number): void {
    while (window.length > 0 && window[0] <= at - span) window.shift();
  }

  return {
    async run<T>(limits: ReplySuggestionsLimits, call: () => Promise<T>): Promise<T> {
      const at = now();
      let halfOpen = false;
      if (consecutiveFailures >= REPLY_SUGGESTIONS_CIRCUIT_FAILURE_THRESHOLD) {
        if (at < circuitOpenUntil) throw replySuggestionsUpstreamError('circuit-open');
        // Cooldown elapsed: allow exactly one trial call below. A success resets
        // the counter; a failure re-opens the circuit (see the catch branch).
        halfOpen = true;
        circuitOpenUntil = 0;
      }

      pruneCalls(minuteCalls, 60_000, at);
      pruneCalls(dayCalls, 86_400_000, at);
      if (minuteCalls.length >= limits.maxCallsPerMinute || dayCalls.length >= limits.maxCallsPerDay) {
        throw rateLimitedError();
      }
      minuteCalls.push(at);
      dayCalls.push(at);

      try {
        const result = await call();
        consecutiveFailures = 0;
        circuitOpenUntil = 0;
        return result;
      } catch (failure) {
        consecutiveFailures += 1;
        if (halfOpen || consecutiveFailures >= REPLY_SUGGESTIONS_CIRCUIT_FAILURE_THRESHOLD) {
          consecutiveFailures = REPLY_SUGGESTIONS_CIRCUIT_FAILURE_THRESHOLD;
          circuitOpenUntil = now() + REPLY_SUGGESTIONS_CIRCUIT_COOLDOWN_MS;
        }
        throw failure;
      }
    },
  };
}
