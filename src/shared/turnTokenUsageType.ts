/**
 * The current-turn usage wire type, a type-only leaf directly under `src/shared`.
 *
 * WHY NOT `src/shared/types.ts`: that file is an oversize-ratchet baseline entry
 * that may only shrink, and the turn block is a new wire shape rather than an
 * addition to an existing one — the same reason `src/shared/ncLeaseType.ts`
 * sits here. `CostCommandData` imports it to type `cost.turn`; the composer chip
 * and the `/cost` panel name this leaf directly too.
 *
 * Mirrors the server's `TurnTokenUsage` in `server/shared/types/interfaces.ts`.
 *
 * `inputTokens` is the turn's WHOLE prompt, so the cache quantities are subsets
 * of it and never added again. Every optional field is presence-meaningful: an
 * absent `cacheReadTokens` means "no request reported one", and an absent
 * `costUsd` means the deployment configured no rates — neither is a zero.
 */
export type TurnTokenUsage = {
  /** Whole-turn billed tokens: input plus output. */
  totalTokens: number;
  /** The turn's whole prompt, cache reads and cache writes included. */
  inputTokens: number;
  outputTokens: number;
  /** Cached input tokens read back; a subset of `inputTokens`. */
  cacheReadTokens?: number;
  /** Cached input tokens written; a subset of `inputTokens`. */
  cacheWriteTokens?: number;
  /** `cacheRead / inputTokens`, 0..1. */
  cacheHitRatio?: number;
  /** `inputTokens - cacheReadTokens - cacheWriteTokens`, floored at 0. */
  fresh?: number;
  /** Wall-clock milliseconds from the turn's prompt to its last response. */
  elapsedMs: number;
  /** Sum of joined request latencies; absent when no request timing was joined. */
  apiMs?: number;
  /** Output tokens per second. */
  tps?: number;
  /** Estimated USD at the configured rates; absent when no rates are configured. */
  costUsd?: number;
  /** Distinct API requests the turn made. */
  calls: number;
};
