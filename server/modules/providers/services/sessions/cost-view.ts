import type { ProviderTokenUsageCounts, TurnTokenUsage } from '@/shared/interfaces.js';

//----------------- COST VIEW ------------

/**
 * The cache-accounting statement `/cost` shows for each selectable provider.
 *
 * Every provider reports cache quantities as a SUBSET of input rather than as
 * separate spend, but they name the quantities differently; the statement says
 * which quantities the provider's own reading reports so a reader does not add
 * the cache rows to input a second time. The mapping lives here rather than as a
 * branch in the panel: adding a provider adds one row.
 */
const COST_ACCOUNTING_NOTES: Record<string, string> = {
  claude:
    'Input already includes cache reads and cache writes. Anthropic reports them separately as '
    + 'cache_read_input_tokens and cache_creation_input_tokens, but they are a breakdown of input, '
    + 'never additional tokens.',
  cursor:
    'Input already includes any cached prompt tokens Cursor reports; cached quantities are a '
    + 'subset of input, never additional tokens.',
  codex:
    'Input already includes cached input tokens (cached_input_tokens). Cache writes '
    + '(cache_write_input_tokens) are the write half of that same prompt, so neither is added again.',
  opencode:
    'Input already includes cache reads and cache writes. The cache rows are a breakdown of input, '
    + 'never additional tokens.',
};

/**
 * The accounting statement for a provider id this build has no row for.
 *
 * It states the contract every provider satisfies — cache quantities are a
 * subset of input — without claiming which quantities that provider reports.
 */
const FALLBACK_COST_ACCOUNTING_NOTE =
  'Input includes any cached prompt tokens this provider reports; cache reads and cache writes are '
  + 'a breakdown of input, never additional tokens.';

/**
 * One session's whole-spend view, already normalized across providers.
 *
 * `total`, `input` and `output` describe the session, never one request's
 * context occupancy: a context-scoped reading (Claude) contributes its
 * cumulative block here while its newest-turn occupancy stays in
 * {@link CostViewContext.used}. Cache quantities are detail reads that are
 * already contained in `input`; they are never re-added to it.
 */
export type CostViewSession = {
  /** Whole-session spend: the source's own total, else input + output. */
  total?: number;
  input?: number;
  output?: number;
  /** Cached input tokens read back; a subset of `input`. */
  cacheRead?: number;
  /** Cached input tokens written; a subset of `input`, absent when not reported. */
  cacheWrite?: number;
  /** Reasoning tokens; a subset of `output`. */
  reasoningOutput?: number;
  /**
   * `cacheRead / input`. Emitted only when the source reported cache reads and
   * a positive input, because a missing numerator is not a claimed "0% cached".
   */
  cacheHitRatio?: number;
  /** `input - cacheRead - cacheWrite`, floored at 0; emitted only with `cacheHitRatio`. */
  fresh?: number;
};

/** The current context reading: what this session's newest request occupies. */
export type CostViewContext = {
  /** Newest-turn occupancy for a context-scoped reading; absent for a cumulative one. */
  used?: number;
  /** Window capacity in tokens, independent of either occupancy or session total. */
  window?: number;
};

/**
 * The `/cost` answer the browser renders: one provider-agnostic view of the
 * session, its newest request and its window, plus the provider's accounting
 * statement. The panel renders these values and derives nothing itself.
 */
export type CostView = {
  session?: CostViewSession;
  context?: CostViewContext;
  /** Newest single request, as the provider reported it; only a context estimate. */
  lastRequest?: ProviderTokenUsageCounts;
  /**
   * The current turn's own spend, passed through from the provider reading
   * unchanged: the panel renders these values and derives nothing, the same
   * contract the session block follows.
   */
  turn?: TurnTokenUsage;
  /** The provider's own cache-accounting statement, resolved server-side. */
  accountingNote: string;
};

/**
 * The reading `/cost` derives its view from.
 *
 * Only the first-class fields are consumed: `sessionSpend` is the whole
 * session, `contextOccupancy` the newest request plus the window. The legacy
 * dual-meaning fields (`used`, `usageScope`, the flat counts) stay declared so
 * an older wire payload still parses, but this module never reads them — that
 * is what stops one reading from meaning two things.
 */
export type CostViewReading = {
  /** The session's whole spend; the sole source of the `session` block. */
  sessionSpend?: unknown;
  /** The newest request's occupancy and the window capacity. */
  contextOccupancy?: { used?: unknown; total?: unknown };
  /** Newest single request in the counts shape, for the detail row. */
  lastRequest?: unknown;
  /** The current turn's spend, passed through to the panel untouched. */
  turn?: unknown;
  /** @deprecated Never consumed; the dual-meaning legacy number. */
  used?: unknown;
  /** @deprecated Never consumed; legacy window field. */
  total?: unknown;
  /** @deprecated Never consumed; legacy window field. */
  contextWindow?: unknown;
  /** @deprecated Never consumed. */
  totalUsed?: unknown;
  /** @deprecated Never consumed. */
  total_tokens?: unknown;
  /** @deprecated Never consumed. */
  inputTokens?: unknown;
  /** @deprecated Never consumed. */
  input_tokens?: unknown;
  /** @deprecated Never consumed. */
  input?: unknown;
  /** @deprecated Never consumed. */
  cumulativeInputTokens?: unknown;
  /** @deprecated Never consumed. */
  promptTokens?: unknown;
  /** @deprecated Never consumed. */
  outputTokens?: unknown;
  /** @deprecated Never consumed. */
  output_tokens?: unknown;
  /** @deprecated Never consumed. */
  output?: unknown;
  /** @deprecated Never consumed. */
  cumulativeOutputTokens?: unknown;
  /** @deprecated Never consumed. */
  completionTokens?: unknown;
  /** @deprecated Never consumed. */
  cacheReadTokens?: unknown;
  /** @deprecated Never consumed. */
  cache_read_input_tokens?: unknown;
  /** @deprecated Never consumed. */
  cacheReadInputTokens?: unknown;
  /** @deprecated Never consumed. */
  cacheCreationTokens?: unknown;
  /** @deprecated Never consumed. */
  cache_creation_input_tokens?: unknown;
  /** @deprecated Never consumed. */
  cacheCreationInputTokens?: unknown;
  /** @deprecated Never consumed. */
  breakdown?: { input?: unknown; output?: unknown };
  /** @deprecated Never consumed; `sessionSpend` replaces it. */
  cumulative?: unknown;
  /** @deprecated Never consumed; the first-class shape names both meanings. */
  usageScope?: 'context' | 'session-cumulative';
};

/** Reads one numeric quantity while preserving "unknown" as `undefined`. */
const readQuantity = (value: unknown): number | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * Copies only the quantities a usage block actually reported.
 *
 * Fields the source did not report are omitted, not zero-filled; an explicit
 * zero survives. snake_case fallbacks keep an older payload readable.
 */
const readCounts = (value: unknown): ProviderTokenUsageCounts | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const counts: ProviderTokenUsageCounts = {};
  const add = (field: keyof ProviderTokenUsageCounts, ...keys: string[]) => {
    for (const key of keys) {
      const quantity = readQuantity(record[key]);
      if (quantity !== undefined) {
        counts[field] = quantity;
        return;
      }
    }
  };

  add('inputTokens', 'inputTokens', 'input_tokens');
  add('outputTokens', 'outputTokens', 'output_tokens');
  add('cacheReadTokens', 'cacheReadTokens', 'cache_read_input_tokens', 'cached_input_tokens');
  add('cacheWriteTokens', 'cacheWriteTokens', 'cache_write_input_tokens');
  add('reasoningOutputTokens', 'reasoningOutputTokens', 'reasoning_output_tokens');
  add('totalTokens', 'totalTokens', 'total_tokens');
  return Object.keys(counts).length > 0 ? counts : undefined;
};

/** Reads the occupancy object only when the wire actually sent one. */
const isRecordLike = (value: unknown): value is { used?: unknown; total?: unknown } =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Passes a turn block through only when it carries its required quantities.
 *
 * The turn is measured server-side (in the provider reader) and the panel
 * renders it untouched, so this copies the optional detail fields as reported
 * — absent stays absent — rather than re-deriving any of them.
 */
const readTurn = (value: unknown): TurnTokenUsage | undefined => {
  if (!isRecordLike(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const required = ['totalTokens', 'inputTokens', 'outputTokens', 'elapsedMs', 'calls'] as const;
  if (!required.every((field) => readQuantity(record[field]) !== undefined)) {
    return undefined;
  }
  const turn: TurnTokenUsage = {
    totalTokens: readQuantity(record.totalTokens) as number,
    inputTokens: readQuantity(record.inputTokens) as number,
    outputTokens: readQuantity(record.outputTokens) as number,
    elapsedMs: readQuantity(record.elapsedMs) as number,
    calls: readQuantity(record.calls) as number,
  };
  for (const field of ['cacheReadTokens', 'cacheWriteTokens', 'cacheHitRatio', 'fresh', 'apiMs', 'tps', 'costUsd'] as const) {
    const quantity = readQuantity(record[field]);
    if (quantity !== undefined) {
      turn[field] = quantity;
    }
  }
  return turn;
};

/**
 * Derives the unified `/cost` view from one provider reading.
 *
 * The two meanings are read from their own fields, never inferred from one
 * number: `sessionSpend` is the whole session's spend and is the ONLY source
 * of the `session` block, while `contextOccupancy` is the newest request's
 * occupancy plus the window. A reading that reports only a context occupancy
 * therefore produces a `context` block and no `session` block — nothing is
 * stitched from request counts (the defect this shape removes). The ratio and
 * the fresh remainder are derived here too, so the panel computes nothing.
 *
 * Consumed by the commands module's `/cost` handler, which returns the result
 * as `data.cost`.
 */
export function buildCostView(
  reading: CostViewReading,
  provider: string | null | undefined,
): CostView {
  const spend = readCounts(reading.sessionSpend);
  const occupancy = isRecordLike(reading.contextOccupancy) ? reading.contextOccupancy : undefined;
  const occupancyUsed = readQuantity(occupancy?.used);
  const window = readQuantity(occupancy?.total);
  const lastRequest = readCounts(reading.lastRequest);
  const turn = readTurn(reading.turn);

  const input = spend?.inputTokens;
  const output = spend?.outputTokens;
  const cacheRead = spend?.cacheReadTokens;
  const cacheWrite = spend?.cacheWriteTokens;
  const reportedTotal = spend?.totalTokens;
  const summedTotal =
    input !== undefined && output !== undefined ? input + output : undefined;
  const sessionTotal = reportedTotal ?? summedTotal;

  const session: CostViewSession = {};
  if (sessionTotal !== undefined) session.total = sessionTotal;
  if (input !== undefined) session.input = input;
  if (output !== undefined) session.output = output;
  if (cacheRead !== undefined) {
    session.cacheRead = cacheRead;
    if (input !== undefined && input > 0) {
      session.cacheHitRatio = cacheRead / input;
      session.fresh = Math.max(0, input - cacheRead - (cacheWrite ?? 0));
    }
  }
  if (cacheWrite !== undefined) session.cacheWrite = cacheWrite;
  if (spend?.reasoningOutputTokens !== undefined) {
    session.reasoningOutput = spend.reasoningOutputTokens;
  }

  const context: CostViewContext = {};
  if (occupancyUsed !== undefined) context.used = occupancyUsed;
  if (window !== undefined) context.window = window;

  return {
    ...(Object.keys(session).length > 0 ? { session } : {}),
    ...(Object.keys(context).length > 0 ? { context } : {}),
    ...(lastRequest ? { lastRequest } : {}),
    ...(turn ? { turn } : {}),
    accountingNote:
      COST_ACCOUNTING_NOTES[provider ?? ''] ?? FALLBACK_COST_ACCOUNTING_NOTE,
  };
}
