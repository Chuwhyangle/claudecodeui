import type { ProviderTokenUsageReading, TurnTokenUsage } from '@/shared/interfaces.js';
import type { AnyRecord } from '@/shared/types.js';
import { readReportedUsageNumber, readUsageNumber } from '@/shared/utils.js';

//----------------- CURRENT TURN ------------

/** USD per million tokens, configured once per deployment (never baked in). */
type TokenPricing = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/**
 * Rates from `CLOUDPIT_TOKEN_PRICING` (JSON: `input`/`output`/`cacheRead`/
 * `cacheWrite`, USD per million tokens). Returns null when it is unset or
 * malformed, so an unpriced deployment reports no `costUsd` at all rather than
 * a fabricated one; no gateway price is hard-coded here. A gateway that renames
 * models keeps this reader generic — the environment variable is the only place
 * a rate has to land.
 */
function readTokenPricing(): TokenPricing | null {
  const raw = process.env.CLOUDPIT_TOKEN_PRICING;
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<TokenPricing>;
    const input = readReportedUsageNumber(parsed.input);
    const output = readReportedUsageNumber(parsed.output);
    if (input === null || output === null) {
      return null;
    }
    return {
      input,
      output,
      cacheRead: readReportedUsageNumber(parsed.cacheRead) ?? 0,
      cacheWrite: readReportedUsageNumber(parsed.cacheWrite) ?? 0,
    };
  } catch {
    return null;
  }
}

/** ISO timestamp → epoch milliseconds, or null when the row carries none. */
function readTimeMs(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Whether a `user` row is the human's own prompt. Rejects the CLI's injected
 * `<local-command…>`, `<command-…>` and `<system-reminder>` rows: they are user
 * rows with no turn of their own, and treating one as a turn start would report
 * the previous turn's spend against it.
 */
function isHumanPromptRow(row: AnyRecord): boolean {
  if (row.type !== 'user' || row.isMeta === true || row.isCompactSummary === true) {
    return false;
  }
  const content = row.message?.content;
  if (Array.isArray(content)) {
    return content.some((part: AnyRecord) => part?.type === 'text' || part?.type === 'image');
  }
  if (typeof content !== 'string') {
    return false;
  }
  const text = content.trim();
  if (!text) {
    return false;
  }
  return !/^<(?:local-command-|command-name>|command-message>|command-args>|system-reminder>|user-prompt-submit-hook>)/.test(text);
}

/** One API request's finished usage, keyed by its `requestRef`. */
type TurnAnswer = {
  at: number;
  directInput: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  sawCacheRead: boolean;
  sawCacheWrite: boolean;
};

/**
 * Measures the CURRENT turn from rows a usage reader already parsed: the last
 * human prompt up to the final assistant row after it.
 *
 * A streamed reply writes one assistant row per content block, all sharing the
 * request's `requestRef` and repeating that request's usage; the last row of a
 * ref is the finished one, so answers are deduplicated by ref. Joining each ref
 * to its `api-request` row — present in the service path's full transcript, and
 * dropped by the history projection — sums API latency for `tps`; without those
 * rows the end-to-end wall clock is the only denominator left. Returns undefined
 * when there is no assistant usage after the last prompt to measure.
 *
 * Consumed by `summarizeClaudeHistoryTokenUsage` (history refresh) and
 * `ClaudeTokenUsageProvider.readSessionUsage` (the live service), through
 * {@link withClaudeTurn}. A type-only leaf of the Claude provider so the main
 * usage reader stays near its original size.
 */
export function summarizeClaudeTurnUsage(
  entries: AnyRecord[],
  pricing: TokenPricing | null = readTokenPricing(),
): TurnTokenUsage | undefined {
  const requestStarts = new Map<string, number>();
  for (const entry of entries) {
    if (entry?.type !== 'api-request' || typeof entry.id !== 'string') {
      continue;
    }
    const at = readTimeMs(entry.timestamp);
    if (at !== null) {
      requestStarts.set(entry.id, at);
    }
  }

  let turnStartMs: number | null = null;
  const answers = new Map<string, TurnAnswer>();
  let rowIndex = 0;
  for (const entry of entries) {
    rowIndex += 1;
    if (entry?.type === 'user' && isHumanPromptRow(entry)) {
      const at = readTimeMs(entry.timestamp);
      if (at !== null) {
        turnStartMs = at;
      }
      continue;
    }
    if (entry?.type !== 'assistant' || entry.isSidechain === true) {
      continue;
    }
    const usage = entry.message?.usage as AnyRecord | undefined;
    if (!usage) {
      continue;
    }
    const at = readTimeMs(entry.timestamp);
    if (at === null) {
      continue;
    }

    const directInput = readUsageNumber(usage.input_tokens ?? usage.inputTokens);
    const output = readUsageNumber(usage.output_tokens ?? usage.outputTokens);
    const cacheReadValue = readReportedUsageNumber(
      usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cacheReadTokens,
    );
    const cacheWriteValue = readReportedUsageNumber(
      usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? usage.cacheCreationTokens,
    );
    const cacheRead = cacheReadValue ?? 0;
    const cacheWrite = cacheWriteValue ?? 0;
    // `<synthetic>` rows carry an all-zero usage block; they never billed.
    if (directInput === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) {
      continue;
    }

    // Same ref, later row = the same request's finished answer, not a new call.
    const ref = typeof entry.requestRef === 'string' && entry.requestRef
      ? entry.requestRef
      : `row:${rowIndex}`;
    const previous = answers.get(ref);
    if (!previous || at >= previous.at) {
      answers.set(ref, {
        at,
        directInput,
        output,
        cacheRead,
        cacheWrite,
        sawCacheRead: cacheReadValue !== null,
        sawCacheWrite: cacheWriteValue !== null,
      });
    }
  }

  let directInputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let sawCacheRead = false;
  let sawCacheWrite = false;
  let apiMs = 0;
  let joinedTiming = false;
  let lastAt: number | null = null;
  let calls = 0;

  for (const [ref, answer] of answers) {
    // Answers before the last human prompt belong to a replaced turn.
    if (turnStartMs !== null && answer.at < turnStartMs) {
      continue;
    }
    directInputTokens += answer.directInput;
    outputTokens += answer.output;
    cacheReadTokens += answer.cacheRead;
    cacheWriteTokens += answer.cacheWrite;
    sawCacheRead ||= answer.sawCacheRead;
    sawCacheWrite ||= answer.sawCacheWrite;
    const startedAt = requestStarts.get(ref);
    if (startedAt !== undefined && answer.at >= startedAt) {
      apiMs += answer.at - startedAt;
      joinedTiming = true;
    }
    lastAt = lastAt === null ? answer.at : Math.max(lastAt, answer.at);
    calls += 1;
  }

  if (calls === 0) {
    return undefined;
  }

  const inputTokens = directInputTokens + cacheReadTokens + cacheWriteTokens;
  const elapsedMs = turnStartMs !== null && lastAt !== null
    ? Math.max(0, lastAt - turnStartMs)
    : 0;
  const tps = joinedTiming && apiMs > 0
    ? (outputTokens * 1000) / apiMs
    : elapsedMs > 0
      ? (outputTokens * 1000) / elapsedMs
      : undefined;

  const turn: TurnTokenUsage = {
    totalTokens: inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    elapsedMs,
    calls,
    ...(sawCacheRead ? { cacheReadTokens } : {}),
    ...(sawCacheWrite ? { cacheWriteTokens } : {}),
    ...(joinedTiming ? { apiMs } : {}),
    ...(tps !== undefined ? { tps } : {}),
  };
  if (sawCacheRead && inputTokens > 0) {
    turn.cacheHitRatio = cacheReadTokens / inputTokens;
    turn.fresh = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);
  }
  if (pricing) {
    turn.costUsd = (
      directInputTokens * pricing.input
      + outputTokens * pricing.output
      + cacheReadTokens * pricing.cacheRead
      + cacheWriteTokens * pricing.cacheWrite
    ) / 1_000_000;
  }
  return turn;
}

/**
 * Attaches the current turn's spend to a reading when the transcript has one.
 * Kept beside the summarizer so the history and live-service paths attach it
 * the same way; a reading without a turn is returned untouched.
 */
export function withClaudeTurn(
  reading: ProviderTokenUsageReading,
  entries: AnyRecord[],
): ProviderTokenUsageReading {
  const turn = summarizeClaudeTurnUsage(entries);
  return turn ? { ...reading, turn } : reading;
}
