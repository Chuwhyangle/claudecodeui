/**
 * The reply-suggestions failure reading: the ONE place a failed draw becomes an
 * inspectable record, and the settings-derived state the `/status` route publishes.
 *
 * WHAT IT HOLDS. The most recent failure and a small ring of the ones before it
 * (20 by default). A failure is `{at, requestId, category, httpStatus,
 * durationMs, model, protocol}` — never the prompt, the answer body or the key.
 * The ring exists so a person can say when it started failing without reading
 * journalctl; the `lastFailure` is what the composer's inline notice renders.
 *
 * WHAT IT OWNS. The ring and the "current failure" pointer are closure state of
 * the factory, so nothing here is module-scope mutable state. `record` writes both
 * the pointer and the ring; `clear` empties only the pointer (a success means the
 * feature works again, not that the history never happened).
 *
 * THE STATE IS DERIVED, NOT STORED. `off` is an explicit `enabled: false`; a file
 * that asks for the feature but cannot name its gateway, model or key is
 * `misconfigured` (the settings reader has already put the missing items in
 * `diagnostics.problems`); only `ready` may draw chips.
 *
 * Consumers: `reply-suggestions.service.ts` (the tracker, the status projection
 * and the request id), `reply-suggestions-usage-log.ts` (the `failed` row's
 * category type) and the failure-reading criterion.
 */
import { randomBytes } from 'node:crypto';

import { AppError, isRecord } from '@/shared/utils.js';

import type { ReplySuggestionsProtocol, ReplySuggestionsSettings } from './reply-suggestions-settings.js';

/**
 * How many failures the in-memory ring keeps. Bounded so a long outage cannot
 * grow the process's memory; the ledger's `failed` rows are the long-lived record.
 *
 * Consumers: this file's default and the failure-reading criterion.
 */
export const REPLY_SUGGESTIONS_FAILURE_HISTORY_SIZE = 20;

/**
 * The failure vocabulary shared with the browser (`src/shared/types.ts`, pinned by
 * `replySuggestionsTypeSync.test.ts`). It names the coarse reason the notice copy
 * is chosen from: the client categories come from the gateway's `LlmClientError`,
 * `circuit-open` from the upstream guard, `rate-limit` from a spent call budget
 * and `misconfigured` from a settings file that cannot draw.
 *
 * Consumers: the failure record, `AppError.details.category`, the `/status`
 * reading and the browser's mirrored union.
 */
export type ReplySuggestionsFailureCategory =
  | 'timeout'
  | 'http'
  | 'network'
  | 'parse'
  | 'shape'
  | 'circuit-open'
  | 'rate-limit'
  | 'misconfigured'
  | 'unknown';

/** One failed draw, exactly as the `/status` reading and the ledger publish it.
 *
 * Consumers: `ReplySuggestionsStatus.lastFailure`, the `failed` ledger row and the
 * failure-reading criterion. */
export type ReplySuggestionsFailure = {
  /** When the drawing request failed, ISO-8601. */
  at: string;
  /** The id minted for that one POST; correlating the log line and the error body. */
  requestId: string;
  category: ReplySuggestionsFailureCategory;
  /** The upstream HTTP status when the failure was an HTTP answer, else null. */
  httpStatus: number | null;
  /** How long the failed draw spent before it gave up. */
  durationMs: number;
  /** The configured model name — never a key or a prompt. */
  model: string;
  protocol: ReplySuggestionsProtocol;
};

/** The three settings-derived states the composer distinguishes.
 *
 * Consumers: `ReplySuggestionsStatus.state` and the browser's inline notice. */
export type ReplySuggestionsState = 'off' | 'misconfigured' | 'ready';

/** The reading `GET /status` exposes — no key, no prompt and no response body.
 * Mirrors `src/shared/types.ts` (the expansion union and the failure record);
 * consumers: `reply-suggestions.routes.ts` and the failure-reading criterion. */
export type ReplySuggestionsStatus = {
  enabled: boolean;
  state: ReplySuggestionsState;
  /** What the settings reader found wrong; may name the settings path, never a key. */
  problems: string[];
  lastFailure: ReplySuggestionsFailure | null;
  expansion: ReplySuggestionsSettings['generation']['expansion'];
  maxChips: number;
  maxChipChars: number;
};

/** The category vocabulary as data, for validating a value that crossed the wire. */
const FAILURE_CATEGORIES: readonly ReplySuggestionsFailureCategory[] = [
  'timeout', 'http', 'network', 'parse', 'shape', 'circuit-open', 'rate-limit', 'misconfigured', 'unknown',
];

/**
 * Reads a wire value as a category, or null when it is not one. The `failed`
 * ledger row and the client's error reader both validate through this.
 *
 * Consumers: `describeFailure` here and the browser's error-body reader.
 */
export function readFailureCategory(value: unknown): ReplySuggestionsFailureCategory | null {
  return typeof value === 'string' && (FAILURE_CATEGORIES as readonly string[]).includes(value)
    ? value as ReplySuggestionsFailureCategory
    : null;
}

/**
 * The facts a recorded failure needs that the thrown error can carry: the
 * category and the upstream status. The draw layer puts them in
 * `AppError.details`; an error without them reads as `unknown` with no status.
 *
 * Consumers: `reply-suggestions.service.ts` and the failure-reading criterion.
 */
export function describeFailure(error: unknown): {
  category: ReplySuggestionsFailureCategory;
  httpStatus: number | null;
} {
  const details = error instanceof AppError && isRecord(error.details) ? error.details : {};
  const category = readFailureCategory(details.category);
  const httpStatus = typeof details.httpStatus === 'number' && Number.isInteger(details.httpStatus)
    ? details.httpStatus
    : null;
  return { category: category ?? 'unknown', httpStatus };
}

/**
 * One short, random id per suggest POST. It is a correlation label only — not a
 * persisted entity — so 8 hex characters are enough and never reach a file.
 *
 * Consumers: `reply-suggestions.service.ts` (once per draw).
 */
export function createReplySuggestionsRequestId(): string {
  return randomBytes(4).toString('hex');
}

/**
 * Derives the composer-visible state from one settings reading. `off` is the
 * explicit switch; `misconfigured` is "asked for, but a required item is
 * missing"; `ready` is the only state that draws.
 *
 * Consumers: `replySuggestionsStatus` below.
 */
export function replySuggestionsState(settings: ReplySuggestionsSettings): ReplySuggestionsState {
  if (!settings.diagnostics.configuredEnabled) return 'off';
  return settings.enabled ? 'ready' : 'misconfigured';
}

/**
 * Builds the `/status` reading from one settings reading and the last failure.
 * Kept here so the service file stays at its line ratchet and the status shape
 * has one owner.
 *
 * Consumers: `reply-suggestions.service.ts` (`status()`).
 */
export function replySuggestionsStatus(
  settings: ReplySuggestionsSettings,
  lastFailure: ReplySuggestionsFailure | null,
): ReplySuggestionsStatus {
  return {
    enabled: settings.enabled,
    state: replySuggestionsState(settings),
    problems: [...settings.diagnostics.problems],
    lastFailure,
    expansion: settings.generation.expansion,
    maxChips: settings.generation.maxChips,
    maxChipChars: settings.generation.maxChipChars,
  };
}

/**
 * The tracker seam the service depends on: record one failed draw, read the
 * current failure, mark a success, or read the bounded history.
 *
 * Consumers: `reply-suggestions.service.ts` (its injected `failureState`), the
 * diagnostics reading (`createReplySuggestionsDiagnostics`) and the
 * failure-reading criterion (which reads `history()`).
 */
export type ReplySuggestionsFailureState = {
  lastFailure: () => ReplySuggestionsFailure | null;
  /** When a draw last succeeded, ISO-8601; null until the first success. */
  lastSuccessAt: () => string | null;
  /** A copy, oldest first; writing to it cannot rewrite the ring. */
  history: () => readonly ReplySuggestionsFailure[];
  /** Records one failure as the current reading and appends it to the ring. */
  record: (failure: ReplySuggestionsFailure) => ReplySuggestionsFailure;
  /** Forgets the current failure and stamps the success time; the ring is deliberately kept. */
  clear: () => void;
};

/**
 * Builds one tracker. The size is injectable for criteria; production keeps the
 * default 20. The state lives in this closure, never at module scope.
 *
 * `now` is injectable so a criterion can pin the success timestamp; production
 * passes the service's clock. A success does not erase the failure ring — it
 * only moves `lastSuccessAt` past the current failure, which is what lets a
 * health reading tell "degraded now" apart from "failed earlier, since fixed".
 *
 * Consumers: `reply-suggestions.service.ts`, `server/index.ts` (the one shared
 * instance the diagnostics reader also reads), and criteria.
 */
export function createReplySuggestionsFailureState(
  size: number = REPLY_SUGGESTIONS_FAILURE_HISTORY_SIZE,
  now: () => number = Date.now,
): ReplySuggestionsFailureState {
  let current: ReplySuggestionsFailure | null = null;
  let lastSuccessAt: string | null = null;
  const ring: ReplySuggestionsFailure[] = [];

  return {
    lastFailure: () => current,
    lastSuccessAt: () => lastSuccessAt,
    history: () => [...ring],
    record: (failure) => {
      const entry = { ...failure };
      current = entry;
      ring.push(entry);
      if (ring.length > size) ring.shift();
      return entry;
    },
    clear: () => {
      current = null;
      lastSuccessAt = new Date(now()).toISOString();
    },
  };
}
