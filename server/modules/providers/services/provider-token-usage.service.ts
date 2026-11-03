import fsSync, { type Dirent } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { sessionsDb } from '@/modules/database/index.js';
import { resolveContextWindow } from '@/modules/providers/services/launch-spec.service.js';
import { resolveModelContextWindowRow } from '@/modules/providers/services/model-launch-spec.service.js';
import type { AnyRecord } from '@/shared/types.js';
import { AppError, getOpenCodeDatabasePath } from '@/shared/utils.js';

type SessionRow = NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;

type FileTail = {
  content: string;
  /** True when `content` is the whole file, not just its trailing bytes. */
  isComplete: boolean;
};

type ProviderTokenUsageServiceDependencies = {
  getSessionById: (sessionId: string) => SessionRow | null | undefined;
  getHomeDirectory: () => string;
  getOpenCodeDatabasePath: () => string;
  fileExists: (filePath: string) => boolean;
  readDirectory: (directoryPath: string) => Promise<Dirent[]>;
  readTextFile: (filePath: string) => Promise<string>;
  readTextFileTail: (filePath: string, maxBytes: number) => Promise<FileTail>;
  getClaudeContextWindow: () => string | undefined;
  /** The model entry's CLAUDE_CODE_MAX_CONTEXT_TOKENS row for a Claude model id, if any. */
  getClaudeModelContextWindow?: (modelId: string) => string | undefined;
  isProviderSessionSuperseded: (providerSessionId: string, provider: string) => boolean;
};

/**
 * One turn's spend, measured from the last human prompt to its final response.
 *
 * The composer renders this beside the context-window counter: `tps` answers
 * "how fast did the model actually write", `elapsedMs` "how long did I wait",
 * and `costUsd` "what did this turn cost" — none of which the context-window
 * reading can answer, because it describes one request rather than a turn.
 */
type TurnTokenUsage = {
  /** Prompt + output tokens this turn billed, cache reads included. */
  used: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Share of this turn's prompt tokens served from cache, 0..1. */
  cacheHitRate: number;
  /** Wall-clock milliseconds from the prompt to the turn's last response row. */
  elapsedMs: number;
  /** Sum of every request's API latency; the denominator of `tps`. */
  apiMs: number;
  /** End-to-end output tokens per second across the turn. */
  tps: number;
  /** Estimated USD at the configured gateway rates. */
  costUsd: number;
  /** API requests the turn made. */
  calls: number;
};

type TokenUsageResult = {
  used: number;
  total?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheTokens?: number;
  breakdown: {
    input: number;
    output: number;
  };
  unsupported?: boolean;
  message?: string;
  /** The current turn's spend; absent when the transcript carries no request timing. */
  turn?: TurnTokenUsage;
};

/** USD per million tokens at this deployment's gateway (fjbigmodel / LiteLLM). */
const DEFAULT_TOKEN_PRICING = {
  input: 0.9,
  output: 3.6,
  cacheRead: 0.018,
  cacheWrite: 0,
} as const;

type TokenPricing = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/**
 * Rates for the configured model, overridable per deployment with
 * `CLOUDCLI_TOKEN_PRICING` (JSON with input/output/cacheRead/cacheWrite).
 * A gateway that renames models keeps this file generic; the environment
 * variable is the only place a new rate needs to land.
 */
function readTokenPricing(): TokenPricing {
  const raw = process.env.CLOUDCLI_TOKEN_PRICING;
  if (!raw) {
    return { ...DEFAULT_TOKEN_PRICING };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<TokenPricing>;
    return {
      input: readUsageNumber(parsed.input ?? DEFAULT_TOKEN_PRICING.input),
      output: readUsageNumber(parsed.output ?? DEFAULT_TOKEN_PRICING.output),
      cacheRead: readUsageNumber(parsed.cacheRead ?? DEFAULT_TOKEN_PRICING.cacheRead),
      cacheWrite: readUsageNumber(parsed.cacheWrite ?? DEFAULT_TOKEN_PRICING.cacheWrite),
    };
  } catch {
    return { ...DEFAULT_TOKEN_PRICING };
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
 * Whether a user row is the human's own prompt. Mirrors the history reader's
 * `isUserPromptRow` but also rejects the CLI's injected `<local-command…>` and
 * `<command-…>` rows, which are user rows with no turn of their own — treating
 * one as a turn start would report the previous turn's spend against it.
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

/**
 * Measures the current turn from rows already parsed by the history reader.
 *
 * `requestRows` carries the `api-request` capture rows, which the reader drops
 * from the message stream but which hold each request's start timestamp. The
 * assistant row's `requestRef` joins the two; without it a turn can only be
 * timed end-to-end, where tool calls dominate and `tps` describes nothing.
 * Returns undefined when the transcript has no request timing to join against.
 */
function summarizeClaudeTurnUsage(
  entries: AnyRecord[],
  requestRows: AnyRecord[] | undefined,
  pricing: TokenPricing,
): TurnTokenUsage | undefined {
  if (!requestRows || requestRows.length === 0) {
    return undefined;
  }

  const requestStarts = new Map<string, number>();
  for (const row of requestRows) {
    if (typeof row.id !== 'string') {
      continue;
    }
    const at = readTimeMs(row.timestamp);
    if (at !== null) {
      requestStarts.set(row.id, at);
    }
  }

  let turnStartMs: number | null = null;
  const answers = new Map<string, { at: number; usage: AnyRecord }>();
  for (const entry of entries) {
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
    const ref = entry.requestRef;
    if (!usage || typeof ref !== 'string') {
      continue;
    }
    const at = readTimeMs(entry.timestamp);
    if (at === null) {
      continue;
    }
    const previous = answers.get(ref);
    // A streamed reply writes one row per content block; the last row is the
    // one that finished, and its usage is the whole request's.
    if (!previous || at >= previous.at) {
      answers.set(ref, { at, usage });
    }
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let apiMs = 0;
  let lastAt: number | null = null;
  let calls = 0;

  for (const [ref, answer] of answers) {
    if (turnStartMs !== null && answer.at < turnStartMs) {
      continue;
    }
    inputTokens += readUsageNumber(answer.usage.input_tokens ?? answer.usage.inputTokens);
    outputTokens += readUsageNumber(answer.usage.output_tokens ?? answer.usage.outputTokens);
    cacheReadTokens += readUsageNumber(
      answer.usage.cache_read_input_tokens ?? answer.usage.cacheReadInputTokens ?? answer.usage.cacheReadTokens,
    );
    cacheCreationTokens += readUsageNumber(
      answer.usage.cache_creation_input_tokens
        ?? answer.usage.cacheCreationInputTokens
        ?? answer.usage.cacheCreationTokens,
    );
    const startedAt = requestStarts.get(ref);
    if (startedAt !== undefined && answer.at >= startedAt) {
      apiMs += answer.at - startedAt;
    }
    lastAt = lastAt === null ? answer.at : Math.max(lastAt, answer.at);
    calls += 1;
  }

  if (calls === 0) {
    return undefined;
  }

  const promptTokens = inputTokens + cacheReadTokens + cacheCreationTokens;
  const used = promptTokens + outputTokens;
  const elapsedMs = turnStartMs !== null && lastAt !== null
    ? Math.max(0, lastAt - turnStartMs)
    : 0;

  return {
    used,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheHitRate: promptTokens > 0 ? cacheReadTokens / promptTokens : 0,
    elapsedMs,
    apiMs,
    tps: apiMs > 0 ? (outputTokens * 1000) / apiMs : 0,
    costUsd:
      (inputTokens * pricing.input
        + outputTokens * pricing.output
        + cacheReadTokens * pricing.cacheRead
        + cacheCreationTokens * pricing.cacheWrite) / 1_000_000,
    calls,
  };
}

type OpenCodeTokenRow = {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
};

/**
 * Both JSONL usage readers below only need the newest usage row, which sits at
 * or near the end of the transcript. Reading just this much of the tail keeps
 * a session-open usage lookup O(1) in the transcript's size; the rare tail
 * with no usage row at all falls back to the full read.
 */
const TOKEN_USAGE_TAIL_BYTES = 4 * 1024 * 1024;

const defaultDependencies: ProviderTokenUsageServiceDependencies = {
  getSessionById: (sessionId) => sessionsDb.getSessionById(sessionId),
  getHomeDirectory: () => os.homedir(),
  getOpenCodeDatabasePath,
  fileExists: (filePath) => fsSync.existsSync(filePath),
  readDirectory: (directoryPath) => fsp.readdir(directoryPath, { withFileTypes: true }),
  readTextFile: (filePath) => fsp.readFile(filePath, 'utf8'),
  readTextFileTail: async (filePath, maxBytes) => {
    const handle = await fsp.open(filePath, 'r');
    try {
      const { size } = await handle.stat();
      if (size <= maxBytes) {
        return { content: await handle.readFile({ encoding: 'utf8' }), isComplete: true };
      }

      const buffer = Buffer.alloc(maxBytes);
      await handle.read(buffer, 0, maxBytes, size - maxBytes);
      const content = buffer.toString('utf8');
      // The window almost never starts on a row boundary; dropping everything
      // up to the first newline discards the partial row (and any split
      // multi-byte character with it).
      const firstNewline = content.indexOf('\n');
      return {
        content: firstNewline === -1 ? '' : content.slice(firstNewline + 1),
        isComplete: false,
      };
    } finally {
      await handle.close();
    }
  },
  getClaudeContextWindow: () => process.env.CONTEXT_WINDOW,
  getClaudeModelContextWindow: (modelId) => resolveModelContextWindowRow('claude', modelId),
  isProviderSessionSuperseded: (providerSessionId, provider) =>
    sessionsDb.isProviderSessionSuperseded(providerSessionId, provider),
};

function readUsageNumber(value: unknown): number {
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) ? parsedValue : 0;
}

async function findCodexSessionFile(
  directoryPath: string,
  providerSessionId: string,
  dependencies: ProviderTokenUsageServiceDependencies,
): Promise<string | null> {
  let entries: Dirent[];
  try {
    entries = await dependencies.readDirectory(directoryPath);
  } catch {
    // Codex session folders are date-partitioned and can disappear while a
    // cleanup is running. An unreadable branch is simply not a match.
    return null;
  }

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      const nestedMatch = await findCodexSessionFile(entryPath, providerSessionId, dependencies);
      if (nestedMatch) {
        return nestedMatch;
      }
      continue;
    }

    if (entry.name.includes(providerSessionId) && entry.name.endsWith('.jsonl')) {
      return entryPath;
    }
  }

  return null;
}

/** Newest `token_count` snapshot in the given JSONL text, or null when it has none. */
function findCodexTokenUsage(fileContent: string): TokenUsageResult | null {
  const lines = fileContent.trim().split('\n');

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index]) as AnyRecord;
      const tokenInfo = entry.type === 'event_msg' && entry.payload?.type === 'token_count'
        ? entry.payload.info
        : null;
      if (!tokenInfo) {
        continue;
      }

      let inputTokens = 0;
      let outputTokens = 0;
      let totalTokens = 0;
      if (tokenInfo.total_token_usage) {
        inputTokens = readUsageNumber(tokenInfo.total_token_usage.input_tokens);
        outputTokens = readUsageNumber(tokenInfo.total_token_usage.output_tokens);
        totalTokens = readUsageNumber(tokenInfo.total_token_usage.total_tokens)
          || inputTokens + outputTokens;
      }
      return {
        used: totalTokens,
        total: readUsageNumber(tokenInfo.model_context_window) || 200_000,
        inputTokens,
        outputTokens,
        breakdown: { input: inputTokens, output: outputTokens },
      };
    } catch {
      // A provider may be writing the last JSONL line while this read happens.
    }
  }

  return null;
}

function emptyCodexTokenUsage(): TokenUsageResult {
  return {
    used: 0,
    total: 200_000,
    inputTokens: 0,
    outputTokens: 0,
    breakdown: { input: 0, output: 0 },
  };
}

// Model id of the newest main-thread assistant turn; its library entry's env row supplies the window.
function findNewestClaudeModelId(entries: AnyRecord[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.isSidechain !== true && entry?.type === 'assistant' && typeof entry.message?.model === 'string') {
      return entry.message.model;
    }
  }
  return null;
}

/**
 * Latest context-window usage from a Claude transcript's already-parsed rows.
 *
 * Exported because the session-messages reader hands the same usage back on
 * every history page, the way the Codex and OpenCode readers do. Without that,
 * a Claude session's counter only moved when the session was reselected, and
 * the store's "this provider reports no usage" path overwrote it with zero.
 *
 * Reads the newest assistant turn only: `input_tokens + cache_read +
 * cache_creation` is that one request's whole prompt, i.e. what the context
 * window currently holds. Summing turns would count the same cached prefix
 * once per turn.
 */
export function summarizeClaudeTokenUsage(
  entries: AnyRecord[],
  configuredContextWindow: string | undefined = process.env.CONTEXT_WINDOW,
  modelContextWindow?: number | string | null,
  requestRows?: AnyRecord[],
): TokenUsageResult {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    // A subagent's turns report the subagent's context window, not this
    // conversation's; reading one makes the counter drop to the subagent's
    // number and bounce back on the next main-thread turn.
    if (entry?.isSidechain === true) {
      continue;
    }

    const usage = entry?.type === 'assistant' ? entry.message?.usage : null;
    if (!usage) {
      continue;
    }

    const directInputTokens = readUsageNumber(usage.input_tokens ?? usage.inputTokens);
    const rowCacheReadTokens = readUsageNumber(
      usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cacheReadTokens,
    );
    const rowCacheCreationTokens = readUsageNumber(
      usage.cache_creation_input_tokens
        ?? usage.cacheCreationInputTokens
        ?? usage.cacheCreationTokens,
    );
    const rowInputTokens = directInputTokens + rowCacheReadTokens + rowCacheCreationTokens;
    const rowOutputTokens = readUsageNumber(usage.output_tokens ?? usage.outputTokens);

    // `<synthetic>` rows — interrupts, API errors, "No response requested" —
    // are written with an all-zero usage block rather than none at all. They
    // never carried a prompt, so treating one as the newest turn zeroed a
    // counter that a live event had just set correctly.
    if (rowInputTokens === 0 && rowOutputTokens === 0) {
      continue;
    }

    cacheReadTokens = rowCacheReadTokens;
    cacheCreationTokens = rowCacheCreationTokens;
    inputTokens = rowInputTokens;
    outputTokens = rowOutputTokens;
    break;
  }

  const contextWindow = resolveContextWindow(modelContextWindow, configuredContextWindow);
  const cacheTokens = cacheReadTokens + cacheCreationTokens;

  const usage: TokenUsageResult = {
    used: inputTokens + outputTokens,
    total: contextWindow,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheTokens,
    breakdown: { input: inputTokens, output: outputTokens },
  };
  // Only present when the caller supplied request timing; a transcript read
  // without it keeps the shape every existing consumer already asserted.
  const turn = summarizeClaudeTurnUsage(entries, requestRows, readTokenPricing());
  if (turn) {
    usage.turn = turn;
  }
  return usage;
}

function parseClaudeUsageEntries(fileContent: string): AnyRecord[] {
  const entries: AnyRecord[] = [];
  for (const line of fileContent.trim().split('\n')) {
    try {
      entries.push(JSON.parse(line) as AnyRecord);
    } catch {
      // Skip malformed lines without discarding usage from earlier messages.
    }
  }
  return entries;
}

function claudeEntriesHaveUsage(entries: AnyRecord[]): boolean {
  return entries.some((entry) => entry?.type === 'assistant' && entry.message?.usage);
}

function readOpenCodeTokenUsage(databasePath: string, providerSessionId: string): TokenUsageResult {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const columns = database.prepare('PRAGMA table_info(session)').all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));
    const requiredColumns = [
      'tokens_input',
      'tokens_output',
      'tokens_reasoning',
      'tokens_cache_read',
      'tokens_cache_write',
    ];

    if (!requiredColumns.every((column) => columnNames.has(column))) {
      return {
        used: 0,
        inputTokens: 0,
        outputTokens: 0,
        breakdown: { input: 0, output: 0 },
        unsupported: true,
        message: 'Token usage tracking is not available in this OpenCode database schema',
      };
    }

    const row = database.prepare(`
      SELECT
        tokens_input AS inputTokens,
        tokens_output AS outputTokens,
        tokens_reasoning AS reasoningTokens,
        tokens_cache_read AS cacheReadTokens,
        tokens_cache_write AS cacheWriteTokens
      FROM session
      WHERE id = ?
    `).get(providerSessionId) as OpenCodeTokenRow | undefined;

    if (!row) {
      throw new AppError('OpenCode session was not found.', {
        code: 'OPENCODE_SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const inputTokens = readUsageNumber(row.inputTokens) + readUsageNumber(row.cacheReadTokens);
    const outputTokens = readUsageNumber(row.outputTokens);
    const used = readUsageNumber(row.inputTokens)
      + outputTokens
      + readUsageNumber(row.reasoningTokens)
      + readUsageNumber(row.cacheReadTokens)
      + readUsageNumber(row.cacheWriteTokens);

    return {
      used,
      inputTokens,
      outputTokens,
      breakdown: { input: inputTokens, output: outputTokens },
    };
  } finally {
    database.close();
  }
}

/**
 * Creates the provider token-usage service used by the provider routes. The
 * provider test suite supplies isolated filesystem and session dependencies so
 * every calculator can be exercised without touching a developer's real data.
 */
export function createProviderTokenUsageService(
  dependencyOverrides: Partial<ProviderTokenUsageServiceDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };

  return {
    /**
     * Resolves all provider-specific storage details from one app-facing
     * session id, then returns the latest usage snapshot for that provider.
     */
    async getSessionTokenUsage(sessionId: string): Promise<TokenUsageResult> {
      const session = dependencies.getSessionById(sessionId);
      if (!session) {
        throw new AppError(`Session "${sessionId}" was not found.`, {
          code: 'SESSION_NOT_FOUND',
          statusCode: 404,
        });
      }

      // The fallback covers rows whose provider id was never recorded, and for
      // a session discovered from disk the app id *is* its provider id. That
      // stops being true the moment an edit rewinds the conversation off a
      // thread: until the replacement run announces its own id, the fallback
      // would resolve the retired transcript and report the discarded
      // conversation's usage against an empty one.
      if (
        !session.provider_session_id
        && dependencies.isProviderSessionSuperseded(sessionId, session.provider)
      ) {
        return {
          used: 0,
          inputTokens: 0,
          outputTokens: 0,
          breakdown: { input: 0, output: 0 },
        };
      }

      const providerSessionId = session.provider_session_id || sessionId;

      if (session.provider === 'cursor') {
        return {
          used: 0,
          total: 0,
          inputTokens: 0,
          outputTokens: 0,
          breakdown: { input: 0, output: 0 },
          unsupported: true,
          message: 'Token usage tracking not available for Cursor sessions',
        };
      }

      if (session.provider === 'opencode') {
        const databasePath = dependencies.getOpenCodeDatabasePath();
        if (!dependencies.fileExists(databasePath)) {
          throw new AppError('OpenCode database was not found.', {
            code: 'OPENCODE_DATABASE_NOT_FOUND',
            statusCode: 404,
          });
        }

        return readOpenCodeTokenUsage(databasePath, providerSessionId);
      }

      if (session.provider === 'codex') {
        const indexedFilePath = session.jsonl_path && dependencies.fileExists(session.jsonl_path)
          ? session.jsonl_path
          : null;
        const sessionFilePath = indexedFilePath ?? await findCodexSessionFile(
          path.join(dependencies.getHomeDirectory(), '.codex', 'sessions'),
          providerSessionId,
          dependencies,
        );

        if (!sessionFilePath) {
          throw new AppError(`Codex session file for "${sessionId}" was not found.`, {
            code: 'CODEX_SESSION_FILE_NOT_FOUND',
            statusCode: 404,
          });
        }

        const tail = await dependencies.readTextFileTail(sessionFilePath, TOKEN_USAGE_TAIL_BYTES);
        const tailUsage = findCodexTokenUsage(tail.content);
        if (tailUsage || tail.isComplete) {
          return tailUsage ?? emptyCodexTokenUsage();
        }

        // A tail this large with no token_count row is pathological, but the
        // whole file is still authoritative when it happens.
        return findCodexTokenUsage(await dependencies.readTextFile(sessionFilePath))
          ?? emptyCodexTokenUsage();
      }

      let sessionFilePath = session.jsonl_path;
      if (!sessionFilePath) {
        if (!session.project_path) {
          throw new AppError(`Session file for "${sessionId}" was not found.`, {
            code: 'SESSION_FILE_NOT_FOUND',
            statusCode: 404,
          });
        }

        const encodedProjectPath = session.project_path.replace(/[^a-zA-Z0-9-]/g, '-');
        const projectDirectory = path.join(
          dependencies.getHomeDirectory(),
          '.claude',
          'projects',
          encodedProjectPath,
        );
        sessionFilePath = path.join(projectDirectory, `${providerSessionId}.jsonl`);

        const relativePath = path.relative(path.resolve(projectDirectory), path.resolve(sessionFilePath));
        if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
          throw new AppError('Resolved session path is invalid.', {
            code: 'INVALID_SESSION_PATH',
            statusCode: 400,
          });
        }
      }

      // The session row is created when the provider allocates it, but the
      // transcript only appears when the first turn is written — for a fresh
      // Claude session the file can lag the row by many seconds. In that window
      // the file the row names is legitimately absent, and reporting 404 left
      // the composer's token/context counter blank until the first turn
      // completed (or a realtime token_budget frame arrived). The session is
      // known and simply has no usage recorded yet, so answer with the same
      // zero reading the file-exists-with-no-usage path returns: an empty
      // summary that still carries the context window. That is what
      // `emptyCodexTokenUsage` reports for its own "no usage yet" case, and it
      // keeps the panel's context row populated instead of dropping to no row
      // at all. A genuinely unknown session is still SESSION_NOT_FOUND.
      if (!dependencies.fileExists(sessionFilePath)) {
        const modelRow = session.model
          ? dependencies.getClaudeModelContextWindow?.(session.model)
          : undefined;
        return summarizeClaudeTokenUsage([], dependencies.getClaudeContextWindow(), modelRow);
      }

      const tail = await dependencies.readTextFileTail(sessionFilePath, TOKEN_USAGE_TAIL_BYTES);
      let entries = parseClaudeUsageEntries(tail.content);
      if (!claudeEntriesHaveUsage(entries) && !tail.isComplete) {
        entries = parseClaudeUsageEntries(await dependencies.readTextFile(sessionFilePath));
      }
      const modelId = session.model || findNewestClaudeModelId(entries);
      const modelRow = modelId ? dependencies.getClaudeModelContextWindow?.(modelId) : undefined;
      return summarizeClaudeTokenUsage(entries, dependencies.getClaudeContextWindow(), modelRow);
    },
  };
}

/**
 * Used by the provider routes to serve token usage from only an app session id.
 */
export const providerTokenUsageService = createProviderTokenUsageService();
