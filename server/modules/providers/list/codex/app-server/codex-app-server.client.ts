import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import readline from 'node:readline';

import { AppError, readObjectRecord, readOptionalString } from '@/shared/utils.js';
import type { CodexAppServerLaunch } from '@/modules/providers/list/codex/app-server/codex-app-server.connection.js';
import { startCodexAppServerProcess } from '@/modules/providers/list/codex/app-server/codex-app-server-process.js';

/**
 * Minimal JSON-RPC client for `codex app-server`.
 *
 * Codex ships two entry points and they expose different things. The
 * `@openai/codex-sdk` this app runs conversations through is a wrapper around
 * `codex exec`, and its whole surface is `startThread` and `resumeThread` —
 * there is no way to branch a thread or to resume one partway. The same
 * binary's `app-server` subcommand speaks JSON-RPC and does have that
 * primitive, `thread/fork`, which is what the Codex IDE clients build their
 * own "fork" and "edit an earlier message" on top of.
 *
 * So this is a second transport to the same CLI, opened only for the
 * operations the SDK cannot express: `thread/fork`, and `model/list`, which is
 * how the picker reads the CLI's own catalog. Everything else still goes
 * through the SDK.
 */

/** How long a single request may take before the child is killed. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Deadline for the whole `model/list` read, handshake included.
 *
 * Unlike a fork, this is on a picker's read path: the catalog is only an
 * enhancement over the source-controlled fallback, so a slow or hung app-server
 * must not hold the request open. The read is retried after the adapter's short
 * failure cache instead.
 */
const MODEL_LIST_TIMEOUT_MS = 3_000;

/** Page ceiling, so a server repeating a cursor cannot spin forever. */
const MODEL_LIST_MAX_PAGES = 50;

type JsonRpcResponse = {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
};

/**
 * One entry of the app-server `model/list` reply, narrowed to the fields a
 * model picker maps.
 *
 * The reply carries more (upgrade hints, UX nudges); those are deliberately not
 * modeled so a server-side addition cannot change what this client reads.
 */
export type CodexModelDescriptor = {
  id: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: Array<{ reasoningEffort?: string; description?: string }>;
  /**
   * A custom catalog (`model_catalog_url`) may declare the model's window and
   * auto-compaction threshold per entry. Codex 0.166's own `model/list` reply
   * does not carry them, so they stay optional and are read from either the
   * Codex-native snake_case or the app's camelCase spelling.
   */
  modelContextWindow?: number;
  modelAutoCompactTokenLimit?: number;
};

/** Reads a positive integer quantity a catalog entry may report; anything else is absent. */
const readPositiveModelQuantity = (value: unknown): number | undefined => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const readModelDescriptor = (value: unknown): CodexModelDescriptor | null => {
  const record = readObjectRecord(value);
  // `id` is the field the picker selects by; `model` is the same value on the
  // measured replies and is kept as a fallback for protocol drift.
  const id = readOptionalString(record?.id) ?? readOptionalString(record?.model);
  if (!record || !id) {
    return null;
  }

  const efforts = Array.isArray(record.supportedReasoningEfforts)
    ? record.supportedReasoningEfforts
      .map((entry) => {
        const effort = readOptionalString(readObjectRecord(entry)?.reasoningEffort);
        if (effort === undefined) return undefined;
        const description = readOptionalString(readObjectRecord(entry)?.description);
        return {
          reasoningEffort: effort,
          ...(description === undefined ? {} : { description }),
        };
      })
      .filter((effort): effort is { reasoningEffort: string; description?: string } => effort !== undefined)
    : undefined;

  const contextWindow = readPositiveModelQuantity(
    record.model_context_window ?? record.modelContextWindow,
  );
  const autoCompactTokenLimit = readPositiveModelQuantity(
    record.model_auto_compact_token_limit ?? record.modelAutoCompactTokenLimit,
  );

  return {
    id,
    displayName: readOptionalString(record.displayName),
    description: readOptionalString(record.description),
    hidden: typeof record.hidden === 'boolean' ? record.hidden : undefined,
    isDefault: typeof record.isDefault === 'boolean' ? record.isDefault : undefined,
    defaultReasoningEffort: readOptionalString(record.defaultReasoningEffort),
    supportedReasoningEfforts: efforts,
    ...(contextWindow === undefined ? {} : { modelContextWindow: contextWindow }),
    ...(autoCompactTokenLimit === undefined
      ? {}
      : { modelAutoCompactTokenLimit: autoCompactTokenLimit }),
  };
};

/**
 * Reads every page of the app-server `model/list` reply, keyed by id.
 *
 * Exported as a pure function over `call` so pagination and de-duplication can
 * be exercised without spawning a CLI. A repeated id keeps the LAST page's
 * copy, which is what a server appending a refreshed entry would mean.
 */
export const collectModelPages = async (
  call: (method: string, params: unknown) => Promise<unknown>,
): Promise<CodexModelDescriptor[]> => {
  const byId = new Map<string, CodexModelDescriptor>();
  let cursor: string | null = null;
  for (let page = 0; page < MODEL_LIST_MAX_PAGES; page += 1) {
    const result = readObjectRecord(await call('model/list', cursor ? { cursor } : {}));
    const data = Array.isArray(result?.data) ? result.data : [];
    for (const entry of data) {
      const model = readModelDescriptor(entry);
      if (model) {
        byId.set(model.id, model);
      }
    }
    cursor = readOptionalString(result?.nextCursor) ?? null;
    if (!cursor) {
      break;
    }
  }
  return [...byId.values()];
};

/**
 * One fork of a Codex thread.
 *
 * `path` is returned by the server rather than reconstructed: the rollout
 * lands in today's date directory, not next to the file it was copied from,
 * so deriving it from the source path would be wrong roughly every day.
 */
export type CodexThreadFork = {
  threadId: string;
  path: string;
};

/** What the CLI reports for one thread when asked to include its turns. */
export type CodexThreadReading = {
  threadId: string;
  /** Number of turns the CLI would replay for this thread. */
  turns: number;
  /** The text of every item the CLI returns, in turn order. */
  texts: string[];
};

/**
 * Resolves the `codex` launcher shipped in node_modules.
 *
 * Deliberately not the `codex` on PATH: a machine can have a second, older
 * install, and the protocol this speaks is only guaranteed against the
 * version this package depends on.
 */
function resolveCodexLauncher(): string {
  const require_ = createRequire(import.meta.url);
  try {
    return require_.resolve('@openai/codex/bin/codex.js');
  } catch {
    throw new AppError('The Codex CLI package is not installed, so Codex conversations cannot be branched.', {
      code: 'CODEX_APP_SERVER_UNAVAILABLE',
      statusCode: 501,
    });
  }
}

/**
 * Runs one exchange against a freshly spawned `codex app-server`.
 *
 * A process per operation rather than a pooled long-lived one: the handshake
 * costs a fraction of a second, forking happens at most once per user action,
 * and a shared child would need lifecycle handling — restarts, back-pressure,
 * a crash taking every pending fork with it — for no measurable gain next to
 * the model turn that follows.
 */
async function withAppServer<T>(
  run: (call: (method: string, params: unknown) => Promise<unknown>) => Promise<T>,
  options: { timeoutMs?: number; launch?: CodexAppServerLaunch } = {},
): Promise<T> {
  const launcher = resolveCodexLauncher();
  // The app-server owns descendants (plugin-sync git, and whatever else the
  // binary starts), so it runs as its own process group and the finally below
  // stops the whole group instead of only the direct child.
  const codexProcess = startCodexAppServerProcess(
    launcher,
    ['app-server', ...(options.launch?.args ?? [])],
    {
      env: { ...process.env, ...(options.launch?.env ?? {}) },
      ...(options.launch?.cwd ? { cwd: options.launch.cwd } : {}),
    },
  );
  const child = codexProcess.child;

  // The server logs sandbox and skill warnings to stderr on every start. They
  // are not failures and drowning the app log in them helps nobody, so stderr
  // is only kept around to explain a spawn that dies.
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-2000);
  });

  let nextRequestId = 1;
  const pending = new Map<number, (response: JsonRpcResponse) => void>();
  let exitReason: string | null = null;

  const reader = readline.createInterface({ input: child.stdout });
  reader.on('line', (line) => {
    if (!line.trim()) {
      return;
    }
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      // Server-to-client notifications and any non-JSON banner are not
      // replies to anything this client asked for.
      return;
    }
    if (typeof message.id !== 'number') {
      return;
    }
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });

  const failPending = (reason: string) => {
    exitReason = reason;
    for (const resolve of pending.values()) {
      resolve({ error: { message: reason } });
    }
    pending.clear();
  };

  child.on('error', (error) => failPending(error.message));
  child.on('exit', (code, signal) => {
    failPending(`codex app-server exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`);
  });
  // A child that dies mid-request leaves its pipes broken, and the next write
  // raises EPIPE on the stream rather than at the call site. Without a
  // listener that is an unhandled 'error' event, which takes the whole server
  // down over one failed fork.
  child.stdin?.on('error', (error) => failPending(error.message));
  child.stdout?.on('error', (error) => failPending(error.message));
  child.stderr?.on('error', () => {});

  // An op-level deadline, distinct from the per-request one: `run` may make
  // several calls (model/list pages), and what is bounded here is the whole
  // exchange. Failing pending calls makes `run` throw, and the finally below
  // kills the child.
  const deadlineTimer = options.timeoutMs === undefined
    ? null
    : setTimeout(() => {
      failPending(`codex app-server did not finish within ${options.timeoutMs}ms`);
    }, options.timeoutMs);

  const call = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (exitReason) {
        reject(new AppError(`Codex app-server is not running: ${exitReason}`, {
          code: 'CODEX_APP_SERVER_UNAVAILABLE',
          statusCode: 502,
        }));
        return;
      }

      const id = nextRequestId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new AppError(`Codex app-server did not answer "${method}" within ${REQUEST_TIMEOUT_MS}ms.`, {
          code: 'CODEX_APP_SERVER_TIMEOUT',
          statusCode: 504,
        }));
      }, REQUEST_TIMEOUT_MS);

      pending.set(id, (response) => {
        clearTimeout(timer);
        if (response.error) {
          reject(new AppError(response.error.message || `Codex app-server rejected "${method}".`, {
            code: 'CODEX_APP_SERVER_ERROR',
            statusCode: 502,
            details: { method, rpcCode: response.error.code },
          }));
          return;
        }
        resolve(response.result);
      });

      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  try {
    // `capabilities` is deliberately empty. `thread/fork` with `lastTurnId` is
    // in the stable protocol; only `beforeTurnId` and the turn-listing methods
    // are gated behind `experimentalApi`, and neither is needed here.
    await call('initialize', {
      clientInfo: { name: 'cloudpit', title: 'Cloudpit', version: '1' },
      capabilities: {},
    });
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);

    return await run(call);
  } catch (error) {
    if (error instanceof AppError && exitReason) {
      throw new AppError(`${error.message}${stderr ? ` — ${stderr.trim().split('\n').slice(-1)[0]}` : ''}`, {
        code: error.code,
        statusCode: error.statusCode,
      });
    }
    throw error;
  } finally {
    if (deadlineTimer) {
      clearTimeout(deadlineTimer);
    }
    reader.close();
    // Await the group stop: the caller's next step may remove this child's
    // `CODEX_HOME`, and a descendant still writing there turns that removal
    // into ENOTEMPTY. `groupEmpty === false` is only a diagnostic — the
    // exchange above already succeeded or failed on its own terms.
    const stopped = await codexProcess.stop();
    if (!stopped.groupEmpty) {
      console.warn(
        `[CodexAppServer] process group ${codexProcess.pid ?? 'unknown'} still had members after stop `
        + `(escalated=${stopped.escalated}, groupStop=${stopped.groupStop}).`,
      );
    }
  }
}

export const codexAppServer = {
  /**
   * Copies a thread into a new one that ends at `lastTurnId`, or copies the
   * whole thread when it is omitted.
   *
   * `lastTurnId` is inclusive of the turn it names, which is the same
   * convention the app's edit anchor uses ("the last row to keep").
   *
   * `cwd` decides the working directory recorded in the copy's `session_meta`,
   * and that field is what the session indexer keys a session's project off —
   * omitting it would file every fork under whatever directory this server
   * happens to be running from.
   */
  async forkThread(input: {
    threadId: string;
    lastTurnId?: string;
    cwd: string;
    /** The provider launch the fork's short-lived app-server must run under. */
    launch?: CodexAppServerLaunch;
  }): Promise<CodexThreadFork> {
    return withAppServer(async (call) => {
      const result = await call('thread/fork', {
        threadId: input.threadId,
        ...(input.lastTurnId ? { lastTurnId: input.lastTurnId } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
      }) as { thread?: { id?: unknown; path?: unknown } } | undefined;

      const threadId = typeof result?.thread?.id === 'string' ? result.thread.id : '';
      const path = typeof result?.thread?.path === 'string' ? result.thread.path : '';
      if (!threadId || !path) {
        throw new AppError('Codex reported a fork without a thread id or transcript path.', {
          code: 'FORK_FAILED',
          statusCode: 502,
        });
      }

      // Confirmed rather than trusted: both callers are about to point a
      // database row at this file, and a row naming a transcript that is not
      // there is a session that can never be opened.
      try {
        await stat(path);
      } catch {
        throw new AppError('Codex reported a fork but wrote no transcript for it.', {
          code: 'FORK_FAILED',
          statusCode: 502,
        });
      }

      return { threadId, path };
    }, { launch: input.launch });
  },

  /**
   * Reads a thread back through the CLI's own protocol, turns included.
   *
   * A fork of a `paginated` rollout is a pointer file, so the app-side reader
   * has to follow `forked_from_id` to show the conversation. This call is the
   * other half of the same question, answered by the CLI alone: `thread/read`
   * resolves the pointer on its side, and what it returns is the context the
   * next turn of that thread would run with. A fork that the app could read but
   * the CLI reported empty (or vice versa) would be two readings of one fact
   * that disagree — which is exactly the defect that made the history vanish.
   */
  async readThread(input: {
    threadId: string;
    includeTurns?: boolean;
  }): Promise<CodexThreadReading> {
    return withAppServer(async (call) => {
      const result = await call('thread/read', {
        threadId: input.threadId,
        includeTurns: input.includeTurns ?? true,
      });
      const record = readObjectRecord(result);
      const thread = readObjectRecord(record?.thread) ?? record;
      const threadId = readOptionalString(thread?.id) ?? input.threadId;
      const rawTurns = Array.isArray(thread?.turns) ? thread.turns : [];
      const texts: string[] = [];
      for (const rawTurn of rawTurns) {
        const turn = readObjectRecord(rawTurn);
        const items = Array.isArray(turn?.items) ? turn.items : [];
        for (const rawItem of items) {
          const item = readObjectRecord(rawItem);
          const direct = readOptionalString(item?.text);
          if (direct) {
            texts.push(direct);
            continue;
          }
          const content = Array.isArray(item?.content) ? item.content : [];
          for (const rawPart of content) {
            const type = readObjectRecord(rawPart)?.type;
            const text = readObjectRecord(rawPart)?.text;
            if (type === 'text' && typeof text === 'string') {
              texts.push(text);
            }
          }
        }
      }
      return { threadId, turns: rawTurns.length, texts };
    });
  },

  /**
   * Reads the CLI's own model catalog through `model/list`.
   *
   * Returns `null` rather than throwing when the launcher is missing, the
   * handshake fails, or the read misses its deadline. The adapter owns a
   * source-controlled fallback, and a picker that fails closed is worse than one
   * offering the last measured catalog.
   */
  async listModels(): Promise<CodexModelDescriptor[] | null> {
    try {
      return await withAppServer(
        (call) => collectModelPages(call),
        { timeoutMs: MODEL_LIST_TIMEOUT_MS },
      );
    } catch {
      return null;
    }
  },
};
