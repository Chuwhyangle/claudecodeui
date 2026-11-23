//----------------- CURRENT TURN USAGE ------------

/**
 * One turn's spend, measured from the last human prompt to its final response.
 *
 * The composer renders this beside the context-window counter: `tps` answers
 * "how fast did the model actually write", `elapsedMs` "how long did I wait",
 * and `costUsd` "what did this turn cost" — none of which the context-window
 * reading can answer, because it describes one request rather than a turn.
 *
 * `inputTokens` is the turn's WHOLE prompt (`direct input + cache reads + cache
 * writes`), so the cache quantities are subsets of it and never extra addends.
 * Every optional field is presence-meaningful: `cacheReadTokens` is absent when
 * no request reported one (never a fabricated zero), `apiMs`/`tps` are absent
 * only when there was no timing to compute them from, and `costUsd` is present
 * only when `CLOUDPIT_TOKEN_PRICING` configured rates.
 *
 * A type-only leaf beside `types/interfaces.ts` so the shared interface file
 * stays under the oversize ratchet; `server/shared/interfaces.ts` re-exports it
 * alongside `ProviderTokenUsageReading`.
 */
export type TurnTokenUsage = {
  /** Whole-turn billed tokens: `inputTokens + outputTokens`. */
  totalTokens: number;
  /** The turn's whole prompt, cache reads and cache writes included. */
  inputTokens: number;
  outputTokens: number;
  /** Cached input tokens read back; a subset of `inputTokens`, absent when unreported. */
  cacheReadTokens?: number;
  /** Cached input tokens written; a subset of `inputTokens`, absent when unreported. */
  cacheWriteTokens?: number;
  /** `cacheRead / inputTokens`, 0..1; emitted only with a reported cache read and positive input. */
  cacheHitRatio?: number;
  /** `inputTokens - cacheReadTokens - cacheWriteTokens`, floored at 0; emitted with `cacheHitRatio`. */
  fresh?: number;
  /** Wall-clock milliseconds from the turn's prompt to its last assistant row. */
  elapsedMs: number;
  /** Sum of every joined request's API latency; absent when no request timing could be joined. */
  apiMs?: number;
  /** Output tokens per second — over `apiMs` when joined, else over `elapsedMs`. */
  tps?: number;
  /** Estimated USD at the configured rates; absent when `CLOUDPIT_TOKEN_PRICING` is unset. */
  costUsd?: number;
  /** The number of distinct API requests this turn made. */
  calls: number;
};
