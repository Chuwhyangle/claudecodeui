/**
 * The OPT-IN local debug ledger for the composer's ✦ draft rewrite.
 *
 * WHY IT EXISTS. The ordinary metadata line says an attempt happened; it deliberately never
 * holds the draft or the candidate, so "why did this attempt produce this candidate" cannot be
 * answered from it. This second, default-OFF ledger writes the FULL draft and full candidate
 * for one attempt per line, under `~/.cloudpit/reply-suggestions-debug.jsonl` — the same local
 * root the attachment and browser-profile stores use, and a different file from
 * `reply-suggestions-usage.jsonl` (which keeps its no-text guarantee).
 *
 * WHAT IT NEVER HOLDS. No API key, no credential-file content, no `baseUrl` and no prompt text:
 * the typed record below carries only correlation facts, the model/protocol/version labels, the
 * draft and the candidate. The system prompt is named by its version alone.
 *
 * SIZE IS BOUNDED. A file that would exceed 2 MB is rotated before the append, keeping the
 * current file plus `.1`, `.2`, `.3` (about 8 MB total); the oldest is discarded. Rotation is
 * the ONLY retention policy — there is no clear action in the UI.
 *
 * FAILURE IS CONTAINED. A refused write (read-only directory, full disk, a stubbed `fs` that
 * throws) is logged as ONE warning that carries no draft, candidate or path content, and
 * `record` never throws: the rewrite response and its candidate are unaffected.
 *
 * Consumers: `reply-suggestions.service.ts` (the write-time `debugLog` gate and the injected
 * sink), `reply-suggestions.module.ts` (the one production writer) and the debug-log criterion.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defaultCloudpitDataRoot } from '@/shared/data-root.js';

/** The default cap for one debug file: 2 MB. */
export const REPLY_SUGGESTIONS_DEBUG_LOG_MAX_BYTES = 2 * 1024 * 1024;

/**
 * How many trailing candidate characters one line may hold. A longer candidate is not refused
 * by the feature (that ceiling is 6000 characters); the log simply keeps its first 6000 and
 * says so in `outputTruncatedForLog`.
 */
export const REPLY_SUGGESTIONS_DEBUG_LOG_MAX_OUTPUT_CHARS = 6000;

/** The file name under the `~/.cloudpit` root; the DoD reads exactly this path. */
export const REPLY_SUGGESTIONS_DEBUG_LOG_FILE_NAME = 'reply-suggestions-debug.jsonl';

/**
 * How one attempt ended, as the row reports it. `error:<category>` reuses the failure
 * vocabulary; `rejected:<reason>` is one of the three rewrite-only refusals.
 */
export type ReplySuggestionsDebugOutcome =
  | 'ok'
  | `error:${string}`
  | 'rejected:truncated'
  | 'rejected:empty-output'
  | 'rejected:output-too-long';

/**
 * One attempt handed to the writer. `input` is the draft this attempt rewrote; `output` is the
 * accepted candidate on success and the RAW upstream answer on a refusal (also for a truncated
 * or empty answer, so the log shows what the model actually said).
 */
export type ReplySuggestionsDebugAttempt = {
  requestId: string;
  /** The conversation the composer was rewriting in, when one existed. Log correlation only. */
  sessionId?: string | null;
  outcome: ReplySuggestionsDebugOutcome;
  durationMs: number;
  model: string;
  protocol: string;
  version: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  input: string;
  output: string;
};

/** One line of the debug ledger, exactly as it is serialised. */
export type ReplySuggestionsDebugRow = {
  at: string;
  type: 'draftRewrite';
  requestId: string;
  sessionId?: string;
  outcome: ReplySuggestionsDebugOutcome;
  durationMs: number;
  model: string;
  protocol: string;
  version: string;
  inputTokens?: number;
  outputTokens?: number;
  inputChars: number;
  outputChars: number;
  input: string;
  output: string;
  outputTruncatedForLog?: boolean;
};

/**
 * The writer seam the service depends on: one line per attempt, and the path it writes.
 *
 * Consumers: `reply-suggestions.service.ts` (its injected `debugLog`),
 * `reply-suggestions.module.ts` (builds one) and the debug-log criterion.
 */
export type ReplySuggestionsDebugLog = {
  readonly path: string;
  record(attempt: ReplySuggestionsDebugAttempt): void;
};

/** Build one JSONL line from a typed attempt; the only place the row shape is assembled. */
function buildRow(attempt: ReplySuggestionsDebugAttempt, at: string): ReplySuggestionsDebugRow {
  const outputTruncated = attempt.output.length > REPLY_SUGGESTIONS_DEBUG_LOG_MAX_OUTPUT_CHARS;
  const output = outputTruncated
    ? attempt.output.slice(0, REPLY_SUGGESTIONS_DEBUG_LOG_MAX_OUTPUT_CHARS)
    : attempt.output;
  const sessionId = attempt.sessionId;
  return {
    at,
    type: 'draftRewrite',
    requestId: attempt.requestId,
    ...(sessionId === undefined || sessionId === null || sessionId === '' ? {} : { sessionId }),
    outcome: attempt.outcome,
    durationMs: attempt.durationMs,
    model: attempt.model,
    protocol: attempt.protocol,
    version: attempt.version,
    ...(attempt.inputTokens === undefined || attempt.inputTokens === null ? {} : { inputTokens: attempt.inputTokens }),
    ...(attempt.outputTokens === undefined || attempt.outputTokens === null ? {} : { outputTokens: attempt.outputTokens }),
    inputChars: attempt.input.length,
    outputChars: attempt.output.length,
    input: attempt.input,
    output,
    ...(outputTruncated ? { outputTruncatedForLog: true } : {}),
  };
}

/**
 * Rotate one over-cap file: `.2`→`.3`, `.1`→`.2`, file→`.1`. `renameSync` replaces the
 * destination on POSIX, so the oldest copy is discarded by the first step and no `.4` exists.
 */
function rotate(filePath: string): void {
  // A rotation chain that is still filling up has missing intermediate names (the first
  // rotation has no `.1` yet); skipping a missing one keeps the order and lets the oldest
  // existing copy be the one overwritten.
  if (existsSync(`${filePath}.2`)) renameSync(`${filePath}.2`, `${filePath}.3`);
  if (existsSync(`${filePath}.1`)) renameSync(`${filePath}.1`, `${filePath}.2`);
  renameSync(filePath, `${filePath}.1`);
}

/**
 * Build a debug-ledger writer for one file.
 *
 * `filePath`/`maxBytes`/`homeDir`/`now`/`logger` are injected by the composition root (criteria
 * pass their own). The parent directory is created on the first write — and with mode 0700 —
 * so a disabled feature does no filesystem work at start-up.
 *
 * Consumers: `reply-suggestions.module.ts` (production), `reply-suggestions.service.ts` (the
 * default when a criterion does not inject one) and the debug-log criterion.
 */
export function createReplySuggestionsDebugLog(
  options: {
    filePath?: string;
    maxBytes?: number;
    homeDir?: string;
    now?: () => number;
    logger?: (line: string) => void;
  } = {},
): ReplySuggestionsDebugLog {
  const homeDir = options.homeDir ?? os.homedir();
  const filePath = options.filePath
    ?? path.join(defaultCloudpitDataRoot(homeDir), REPLY_SUGGESTIONS_DEBUG_LOG_FILE_NAME);
  const maxBytes = options.maxBytes ?? REPLY_SUGGESTIONS_DEBUG_LOG_MAX_BYTES;
  const now = options.now ?? Date.now;
  const logger = options.logger ?? ((line: string) => console.warn(line));

  return {
    path: filePath,
    record(attempt: ReplySuggestionsDebugAttempt): void {
      try {
        const row = buildRow(attempt, new Date(now()).toISOString());
        const line = `${JSON.stringify(row)}\n`;
        const bytes = Buffer.byteLength(line, 'utf8');
        const directory = path.dirname(filePath);
        mkdirSync(directory, { recursive: true, mode: 0o700 });

        // Rotate BEFORE appending, so one file never grows past its cap by more than a line.
        if (existsSync(filePath)) {
          const size = statSync(filePath).size;
          if (size > 0 && size + bytes > maxBytes) {
            rotate(filePath);
          }
        }

        appendFileSync(filePath, line, { encoding: 'utf8', mode: 0o600 });
      } catch (failure) {
        // One warning, no draft/candidate/credential content — the response must not change.
        const reason = failure instanceof Error ? failure.name : 'unknown';
        logger(`[reply-suggestions] debug log write failed: ${reason}`);
      }
    },
  };
}
