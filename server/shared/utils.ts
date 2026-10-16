import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { parseFrontMatter } from '@/shared/frontmatter.js';
import type {
  AnyRecord,
  ApiSuccessShape,
  AppErrorOptions,
  ClaudeBackgroundSessionOwner,
  ClaudeSessionOccupancy,
  ClaudeSessionRegistryLister,
  NormalizedMessage,
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
  ProviderSkillSource,
  SubagentActivity,
  WorkspacePathValidationResult,
} from '@/shared/types.js';

//----------------- ENVIRONMENT UTILITIES ------------
/**
 * Indicates whether the backend is running in hosted Platform mode rather than
 * self-hosted OSS mode. The server bootstrap, Agent, Auth, and Browser Use
 * modules use this shared flag to keep environment-dependent behavior aligned.
 * Environment variables must be loaded before this module is evaluated.
 */
export const IS_PLATFORM = process.env.VITE_IS_PLATFORM === 'true';

/**
 * Whether a resident session's run IS its turn (SPEC §6, `RESIDENT_RUN_IS_TURN`).
 *
 * The one place the flag is spelled. The resident host driver
 * (`claude-host-driver.provider.ts`) and the websocket run registry
 * (`chat-run-registry.service.ts`, and through it `chat-websocket.service.ts`
 * and `chat-control.service.ts`) both import it from here; `modules/websocket`'s
 * barrel re-exports it for the MCP gateway's criteria, which print it beside
 * their readings.
 *
 * It lives in this leaf rather than in either consumer because the two sides
 * sit on an ESM evaluation-order boundary: the providers module may not import
 * the websocket module (that edge would close a cycle and trip the
 * `providerRegistry` TDZ), so before this leaf each side carried its own copy of
 * the predicate — two spellings of one string. This module imports only
 * `@/shared/frontmatter.js` and `@/shared/types.js`, so both sides can reach it
 * without closing anything.
 *
 * Read at CALL time, never cached at module load: a criterion sets the variable
 * in its own body, after every importer has been evaluated, so a module-level
 * constant would answer the flag-off value and the criterion would measure the
 * old path while believing it measured the new one. The flag is off unless the
 * variable is exactly `1`.
 */
export function residentRunIsTurn(): boolean {
  return process.env.RESIDENT_RUN_IS_TURN === '1';
}

// ---------------------------
//----------------- NORMALIZED MESSAGE HELPER INPUT TYPES ------------
/**
 * Input payload accepted by `createNormalizedMessage`.
 *
 * Callers provide provider-specific fields plus the required `kind/provider`
 * pair; this helper fills missing envelope fields (`id`, `sessionId`,
 * `timestamp`) in a consistent way.
 */
type NormalizedMessageInput =
  {
    kind: NormalizedMessage['kind'];
    provider: NormalizedMessage['provider'];
    id?: string | null;
    sessionId?: string | null;
    timestamp?: string | null;
  } & Record<string, unknown>;

// ---------------------------
//----------------- HTTP HANDLER UTILITIES ------------
/**
 * Wraps arbitrary data in the standard API success envelope.
 *
 * Use this helper in route handlers to keep successful JSON responses consistent
 * across endpoints.
 */
export function createApiSuccessResponse<TData>(
  data: TData,
): ApiSuccessShape<TData> {
  return {
    success: true,
    data,
  };
}

/**
 * Converts an async Express handler into a standard `RequestHandler` and routes
 * rejected promises to Express error middleware.
 *
 * Use this to avoid repeating `try/catch(next)` in every async route.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };
}

// ---------------------------
//----------------- AUTHORIZATION HEADER UTILITIES ------------
/** The only `Authorization` scheme the backend's bearer-token endpoints accept. */
const BEARER_PREFIX = 'Bearer ';

/**
 * Returns the token carried by an `Authorization: Bearer <token>` header, or
 * `null` when the header is absent, uses another scheme, or carries no value.
 *
 * Consumers: the OAuth module's `/api/oauth/token-info` route and the
 * mcp-gateway module's `/mcp` authentication middleware. Both parse the header
 * HERE so a header one endpoint accepts is never refused by the other.
 */
export function bearerToken(header: string | undefined): string | null {
  if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) {
    return null;
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

// ---------------------------
//----------------- SHARED ERROR UTILITIES ------------
/**
 * Shared application error with HTTP status and machine-readable code metadata.
 *
 * Throw this from service/route layers when the caller should receive a
 * controlled error response rather than a generic 500.
 */
export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message);
    this.name = 'AppError';
    this.code = options.code ?? 'INTERNAL_ERROR';
    this.statusCode = options.statusCode ?? 500;
    this.details = options.details;
  }
}

// ---------------------------
//----------------- WORKSPACE PATH VALIDATION UTILITIES ------------
/**
 * Root directory that all workspace/project paths must stay under.
 *
 * This is resolved from `WORKSPACES_ROOT` when configured; otherwise it falls
 * back to the current user's home directory.
 */
export const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT || os.homedir();

/**
 * System-critical paths that must never be used as workspace roots.
 *
 * The validation helper blocks these values directly and also blocks paths
 * nested under them (with explicit allow-list exceptions where necessary).
 */
export const FORBIDDEN_WORKSPACE_PATHS = [
  // Unix
  '/',
  '/etc',
  '/bin',
  '/sbin',
  '/usr',
  '/dev',
  '/proc',
  '/sys',
  '/var',
  '/boot',
  '/root',
  '/lib',
  '/lib64',
  '/opt',
  '/tmp',
  '/run',
  // Windows
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
  'C:\\System Volume Information',
  'C:\\$Recycle.Bin',
];

function stripWindowsLongPathPrefix(inputPath: string): string {
  if (inputPath.startsWith('\\\\?\\UNC\\')) {
    return `\\\\${inputPath.slice('\\\\?\\UNC\\'.length)}`;
  }

  if (inputPath.startsWith('\\\\?\\')) {
    return inputPath.slice('\\\\?\\'.length);
  }

  return inputPath;
}

function shouldUseWindowsPathNormalization(inputPath: string): boolean {
  if (process.platform === 'win32') {
    return true;
  }

  return inputPath.startsWith('\\\\') || /^[a-zA-Z]:([\\/]|$)/.test(inputPath);
}

/**
 * Canonicalizes project/workspace paths for stable DB keys and comparisons.
 *
 * Normalization rules:
 * - trim whitespace
 * - strip Windows long-path prefixes (`\\?\` and `\\?\UNC\`)
 * - normalize path separators and dot segments
 * - trim trailing separators except for filesystem roots
 */
export function normalizeProjectPath(inputPath: string): string {
  if (typeof inputPath !== 'string') {
    return '';
  }

  const trimmed = inputPath.trim();
  if (!trimmed) {
    return '';
  }

  const withoutLongPrefix = stripWindowsLongPathPrefix(trimmed);
  const useWindowsPathRules = shouldUseWindowsPathNormalization(withoutLongPrefix);
  const normalized = useWindowsPathRules
    ? path.win32.normalize(withoutLongPrefix)
    : path.posix.normalize(withoutLongPrefix);

  if (!normalized) {
    return '';
  }

  const parser = useWindowsPathRules ? path.win32 : path.posix;
  const root = parser.parse(normalized).root;
  if (normalized === root) {
    return normalized;
  }

  return normalized.replace(/[\\/]+$/, '');
}

/**
 * Validates that a user-supplied workspace path is safe to use.
 *
 * Call this before any filesystem mutation that creates or registers projects.
 * The function resolves symlinks, enforces `WORKSPACES_ROOT` containment, and
 * blocks known system directories.
 */
export async function validateWorkspacePath(requestedPath: string): Promise<WorkspacePathValidationResult> {
  try {
    const normalizedRequestedPath = normalizeProjectPath(requestedPath);
    if (!normalizedRequestedPath) {
      return {
        valid: false,
        error: 'Workspace path is required',
      };
    }

    const absolutePath = path.resolve(normalizedRequestedPath);
    const normalizedPath = normalizeProjectPath(absolutePath);

    if (FORBIDDEN_WORKSPACE_PATHS.includes(normalizedPath) || normalizedPath === '/') {
      return {
        valid: false,
        error: 'Cannot use system-critical directories as workspace locations',
      };
    }

    for (const forbiddenPath of FORBIDDEN_WORKSPACE_PATHS) {
      const normalizedForbiddenPath = normalizeProjectPath(forbiddenPath);
      if (
        normalizedPath === normalizedForbiddenPath
        || normalizedPath.startsWith(`${normalizedForbiddenPath}${path.sep}`)
      ) {
        // Allow specific user-writable folders under /var.
        if (
          normalizedForbiddenPath === '/var'
          && (normalizedPath.startsWith('/var/tmp') || normalizedPath.startsWith('/var/folders'))
        ) {
          continue;
        }

        return {
          valid: false,
          error: `Cannot create workspace in system directory: ${forbiddenPath}`,
        };
      }
    }

    let resolvedPath = normalizeProjectPath(absolutePath);
    try {
      await access(absolutePath);
      resolvedPath = normalizeProjectPath(await realpath(absolutePath));
    } catch (error) {
      const fileError = error as NodeJS.ErrnoException;
      if (fileError.code !== 'ENOENT') {
        throw fileError;
      }

      const parentPath = path.dirname(absolutePath);
      try {
        const parentRealPath = await realpath(parentPath);
        resolvedPath = normalizeProjectPath(path.join(parentRealPath, path.basename(absolutePath)));
      } catch (parentError) {
        const parentFileError = parentError as NodeJS.ErrnoException;
        if (parentFileError.code !== 'ENOENT') {
          throw parentFileError;
        }
      }
    }

    const resolvedWorkspaceRoot = normalizeProjectPath(await realpath(WORKSPACES_ROOT));
    if (
      !resolvedPath.startsWith(`${resolvedWorkspaceRoot}${path.sep}`)
      && resolvedPath !== resolvedWorkspaceRoot
    ) {
      return {
        valid: false,
        error: `Workspace path must be within the allowed workspace root: ${WORKSPACES_ROOT}`,
      };
    }

    try {
      await access(absolutePath);
      const pathStats = await lstat(absolutePath);
      if (pathStats.isSymbolicLink()) {
        const symlinkTarget = await readlink(absolutePath);
        const resolvedSymlinkPath = path.resolve(path.dirname(absolutePath), symlinkTarget);
        const realSymlinkPath = await realpath(resolvedSymlinkPath);
        if (
          !realSymlinkPath.startsWith(`${resolvedWorkspaceRoot}${path.sep}`)
          && realSymlinkPath !== resolvedWorkspaceRoot
        ) {
          return {
            valid: false,
            error: 'Symlink target is outside the allowed workspace root',
          };
        }
      }
    } catch (error) {
      const fileError = error as NodeJS.ErrnoException;
      if (fileError.code !== 'ENOENT') {
        throw fileError;
      }
    }

    return {
      valid: true,
      resolvedPath,
    };
  } catch (error) {
    return {
      valid: false,
      error: `Path validation failed: ${(error as Error).message}`,
    };
  }
}

// ---------------------------
//----------------- NORMALIZED PROVIDER MESSAGE UTILITIES ------------
/**
 * Generates a stable unique id for normalized provider messages.
 */
export function generateMessageId(prefix = 'msg'): string {
  return `${prefix}_${randomUUID()}`;
}

/**
 * Creates a normalized provider message and fills the shared envelope fields.
 *
 * Provider adapters and live SDK handlers pass through provider-specific fields,
 * while this helper guarantees every emitted event has an id, session id,
 * timestamp, and provider marker.
 */
export function createNormalizedMessage(fields: NormalizedMessageInput): NormalizedMessage {
  return {
    ...fields,
    id: fields.id || generateMessageId(fields.kind),
    sessionId: fields.sessionId || '',
    timestamp: fields.timestamp || new Date().toISOString(),
    provider: fields.provider,
  };
}

/**
 * Build the unified terminal `complete` lifecycle message.
 *
 * Contract: every provider run ends with exactly one `complete` (the
 * abort-session handler emits it on behalf of cancelled runs, so aborted runs
 * must NOT emit their own). The frontend treats `complete` as the only
 * terminal signal and never needs provider-specific handling:
 *
 * - `sessionId`     — the id the client knows this run by ('' if never discovered)
 * - `actualSessionId` — canonical id after the run; equals `sessionId` unless
 *                       the provider rewrote it mid-run
 * - `exitCode`      — 0 on success; a missing/null code (e.g. killed process)
 *                     is reported as failure
 * - `success`       — exitCode === 0 and not aborted
 * - `aborted`       — run was cancelled by the user
 */
export function createCompleteMessage(opts: {
  provider: NormalizedMessage['provider'];
  sessionId?: string | null;
  actualSessionId?: string | null;
  exitCode?: number | null;
  aborted?: boolean;
}): NormalizedMessage {
  const exitCode = typeof opts.exitCode === 'number' ? opts.exitCode : 1;
  const aborted = Boolean(opts.aborted);

  return createNormalizedMessage({
    kind: 'complete',
    provider: opts.provider,
    sessionId: opts.sessionId || null,
    actualSessionId: opts.actualSessionId || opts.sessionId || null,
    exitCode,
    success: exitCode === 0 && !aborted,
    aborted,
  });
}

// ---------------------------
//----------------- SUBAGENT TIMELINE UTILITIES ------------
/**
 * Longest tool output kept on one subagent activity.
 *
 * A subagent's timeline is nested inside a collapsed panel, so it is a preview
 * of what the agent did, never the primary place its output is read. Sending
 * every child command's full output made the history payload of an
 * agent-heavy session grow by megabytes for content almost nobody expands.
 */
const MAX_SUBAGENT_ACTIVITY_CONTENT = 4000;

function truncateForPreview(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || value.length <= MAX_SUBAGENT_ACTIVITY_CONTENT) {
    return value;
  }
  const omitted = value.length - MAX_SUBAGENT_ACTIVITY_CONTENT;
  return `${value.slice(0, MAX_SUBAGENT_ACTIVITY_CONTENT)}\n… ${omitted} more characters`;
}

/**
 * Trims one subagent activity down to what its nested preview can show.
 *
 * Used by both provider session adapters so a Claude agent's timeline and a
 * Codex agent's timeline cost the same to transport.
 */
export function truncateSubagentActivity(activity: SubagentActivity): SubagentActivity {
  const truncatedContent = truncateForPreview(activity.content);
  const truncatedResult = activity.toolResult
    ? { ...activity.toolResult, content: truncateForPreview(activity.toolResult.content) }
    : activity.toolResult;

  if (truncatedContent === activity.content && truncatedResult === activity.toolResult) {
    return activity;
  }

  return { ...activity, content: truncatedContent, toolResult: truncatedResult };
}

// ---------------------------
//----------------- CONVERSATION HISTORY PAGINATION UTILITIES ------------
/**
 * Slices one page from the END of a chronologically ordered message list.
 *
 * This is the single pagination contract for conversation history across all
 * providers: `offset = 0` returns the most recent `limit` items, increasing
 * offsets walk backwards in time (for "scroll up to load older" UIs), and a
 * `null` limit returns everything. Items must already be sorted oldest-first;
 * the returned page preserves that order.
 *
 * Every provider history reader must use this helper instead of slicing
 * manually so `offset`/`limit` query params behave identically regardless of
 * which provider produced the session.
 */
export function sliceTailPage<T>(
  items: T[],
  limit: number | null,
  offset: number,
): { page: T[]; hasMore: boolean } {
  const total = items.length;
  const normalizedOffset = Math.max(0, offset);

  if (limit === null) {
    // A null limit returns the full list; offset still trims newest entries
    // so "everything before the page I already have" stays expressible.
    const end = Math.max(0, total - normalizedOffset);
    return {
      page: items.slice(0, end),
      hasMore: false,
    };
  }

  const end = Math.max(0, total - normalizedOffset);
  const start = Math.max(0, end - Math.max(0, limit));
  return {
    page: items.slice(start, end),
    hasMore: start > 0,
  };
}

/**
 * Slices a symmetric window around one located item, by absolute subscript.
 *
 * This is the read contract for "load the neighborhood of message X": the
 * caller resolves `X` to its subscript in the same oldest-first array
 * `sliceTailPage` slices, then asks for `before` items on either side and
 * `after` items on the other. `match` is a predicate rather than an index so the
 * id-matching rule stays with the caller (a transcript may identify a row by its
 * provider anchor or by its synthesized id), while the boundary arithmetic —
 * the part every caller must get identically right — stays here.
 *
 * Unlike a tail offset, `startIndex`/`total` are *absolute*: they are the
 * subscripts in the full array, so appending newer items to the end never moves
 * an already-read window. The result is `null` when `match` finds nothing, which
 * is what lets a caller answer "not found" instead of falling back to the
 * newest page.
 */
export function sliceAroundIndex<T>(
  items: T[],
  match: (item: T) => boolean,
  before: number,
  after: number,
): {
  page: T[];
  startIndex: number;
  total: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
} | null {
  const total = items.length;
  const index = items.findIndex(match);

  if (index < 0) {
    return null;
  }

  const start = Math.max(0, index - Math.max(0, before));
  const end = Math.min(total, index + Math.max(0, after) + 1);

  return {
    page: items.slice(start, end),
    startIndex: start,
    total,
    hasMoreBefore: start > 0,
    hasMoreAfter: end < total,
  };
}

// ---------------------------
//----------------- MCP CONFIG PARSING UTILITIES ------------
/**
 * Safely narrows an unknown value to a plain object record.
 *
 * This deliberately rejects arrays, `null`, and primitive values so callers can
 * treat the returned value as a JSON-style object map without repeating the same
 * defensive shape checks at every config read site.
 */
export const readObjectRecord = (value: any): AnyRecord | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as AnyRecord;
};

/**
 * Reads an optional string from unknown input and normalizes empty or whitespace-only
 * values to `undefined`.
 *
 * This is useful when parsing config files where a field may be missing, present
 * with the wrong type, or present as an empty string that should be treated as
 * "not configured".
 */
export const readOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

/**
 * Reads an optional string array from unknown input.
 *
 * Non-array values are ignored, and any array entries that are not strings are
 * filtered out. This lets provider config readers consume loosely shaped JSON/TOML
 * data without failing on incidental invalid members.
 */
export const readStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((entry): entry is string => typeof entry === 'string');
};

/**
 * Reads an optional string-to-string map from unknown input.
 *
 * The function first ensures the source value is a plain object, then keeps only
 * keys whose values are strings. If no valid entries remain, it returns `undefined`
 * so callers can distinguish "no usable map" from an empty object that was
 * intentionally authored downstream.
 */
export const readStringRecord = (value: unknown): Record<string, string> | undefined => {
  const record = readObjectRecord(value);
  if (!record) {
    return undefined;
  }

  const normalized: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'string') {
      normalized[key] = entry;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

// ---------------------------
//----------------- PROVIDER MODEL LOOKUP UTILITIES ------------
/**
 * Builds the standard "default current model" result used when a provider
 * cannot resolve a session-backed active model.
 *
 * Provider model adapters should call this after loading their supported model
 * catalog so the fallback stays aligned with the provider's current `DEFAULT`
 * selection instead of drifting to a hard-coded duplicate.
 */
export function buildDefaultProviderCurrentActiveModel(
  models: ProviderModelsDefinition,
): ProviderCurrentActiveModel {
  return {
    model: models.DEFAULT,
  };
}

// ---------------------------
//----------------- WEBSOCKET PAYLOAD PARSING UTILITIES ------------
/**
 * Parses one websocket message payload into a plain JSON object record.
 *
 * Use this in realtime handlers that receive raw websocket payloads as `string`,
 * `Buffer`, `ArrayBuffer`, or chunk arrays. The helper converts supported
 * payload formats to UTF-8 text, parses JSON, and returns only object payloads.
 * Primitive/array/invalid payloads return `null` so callers can handle bad input
 * without throwing from deeply nested message handlers.
 */
export const parseIncomingJsonObject = (payload: unknown): AnyRecord | null => {
  let text: string | null = null;

  if (typeof payload === 'string') {
    text = payload;
  } else if (Buffer.isBuffer(payload)) {
    text = payload.toString('utf8');
  } else if (payload instanceof ArrayBuffer) {
    text = Buffer.from(payload).toString('utf8');
  } else if (Array.isArray(payload)) {
    const buffers = payload
      .map((entry) => {
        if (Buffer.isBuffer(entry)) {
          return entry;
        }

        if (entry instanceof ArrayBuffer) {
          return Buffer.from(entry);
        }

        if (ArrayBuffer.isView(entry)) {
          return Buffer.from(entry.buffer, entry.byteOffset, entry.byteLength);
        }

        return null;
      })
      .filter((entry): entry is Buffer => entry !== null);

    if (buffers.length > 0) {
      text = Buffer.concat(buffers).toString('utf8');
    }
  }

  if (typeof text !== 'string' || text.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    return readObjectRecord(parsed);
  } catch {
    return null;
  }
};

/**
 * Reads a JSON config file and guarantees a plain object result.
 *
 * Missing files are treated as an empty config object so provider-specific MCP
 * readers can operate against first-run environments without special-case file
 * existence checks. If the file exists but contains invalid JSON, the parse error
 * is preserved and rethrown.
 */
export const readJsonConfig = async (filePath: string): Promise<Record<string, unknown>> => {
  try {
    const content = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return readObjectRecord(parsed) ?? {};
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {};
    }

    throw error;
  }
};

/**
 * Writes a JSON config file with stable, human-readable formatting.
 *
 * The parent directory is created automatically so callers can persist config into
 * provider-specific folders without pre-creating the directory tree. Output always
 * ends with a trailing newline to keep the file diff-friendly.
 */
export const writeJsonConfig = async (filePath: string, data: Record<string, unknown>): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
};

// ---------------------------
//----------------- PROVIDER SKILL FILE UTILITIES ------------
async function hasGitMarker(dirPath: string): Promise<boolean> {
  try {
    const gitMarkerStats = await stat(path.join(dirPath, '.git'));
    return gitMarkerStats.isDirectory() || gitMarkerStats.isFile();
  } catch {
    return false;
  }
}

/**
 * Finds the highest git worktree root visible from a starting directory.
 *
 * Provider skill systems such as Codex and OpenCode walk upward through parent
 * folders when resolving repository/project skills. Use this helper when a
 * provider needs the topmost `.git` marker instead of only the nearest one, so
 * monorepos and nested package folders discover shared root-level skills once.
 */
export async function findTopmostGitRoot(startPath: string): Promise<string | null> {
  let currentPath = path.resolve(startPath);
  let topmostGitRoot: string | null = null;

  while (true) {
    if (await hasGitMarker(currentPath)) {
      topmostGitRoot = currentPath;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      break;
    }

    currentPath = parentPath;
  }

  return topmostGitRoot;
}

/**
 * Adds one provider skill source after normalizing and de-duplicating its root.
 *
 * Provider skill lookup rules often point at overlapping folders (for example a
 * workspace folder can also be the git root). Use this helper while building a
 * provider's `ProviderSkillSource[]` so the shared skills scanner reads each
 * physical root once and still preserves provider-specific scope/command data.
 */
export function addUniqueProviderSkillSource(
  sources: ProviderSkillSource[],
  seenRootDirs: Set<string>,
  source: ProviderSkillSource,
): void {
  const normalizedRootDir = path.resolve(source.rootDir);
  if (seenRootDirs.has(normalizedRootDir)) {
    return;
  }

  seenRootDirs.add(normalizedRootDir);
  sources.push({ ...source, rootDir: normalizedRootDir });
}

// ---------------------------
//----------------- PROVIDER SKILL MARKDOWN UTILITIES ------------
/**
 * Finds direct child skill markdown files under a provider skill root.
 *
 * Skill systems usually store one skill per child directory, so direct mode
 * scans only `<root>/<skill-name>/SKILL.md`. Recursive mode is reserved for
 * provider sources that can nest skills arbitrarily, and it returns every
 * descendant `SKILL.md`. Missing or unreadable roots return an empty list
 * because users may not have every provider installed or configured.
 */
export async function findProviderSkillMarkdownFiles(
  rootDir: string,
  options: { recursive?: boolean } = {},
): Promise<string[]> {
  const skillFiles: string[] = [];

  const collectRecursive = async (dirPath: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    try {
      const skillPath = path.join(dirPath, 'SKILL.md');
      const skillStats = await stat(skillPath);
      if (skillStats.isFile()) {
        skillFiles.push(skillPath);
      }
    } catch {
      // Directories without SKILL.md are expected while walking plugin trees.
    }

    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        await collectRecursive(path.join(dirPath, entry.name));
      }
    }
  };

  if (options.recursive) {
    await collectRecursive(rootDir);
    return skillFiles.sort((left, right) => left.localeCompare(right));
  }

  try {
    const entries = await readdir(rootDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }

      const skillPath = path.join(rootDir, entry.name, 'SKILL.md');
      try {
        const skillStats = await stat(skillPath);
        if (skillStats.isFile()) {
          skillFiles.push(skillPath);
        }
      } catch {
        // A partial skill directory should not block discovery of sibling skills.
      }
    }

    return skillFiles.sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

/**
 * Reads the `name` and `description` fields from a provider skill markdown file.
 *
 * The metadata is expected in markdown front matter. If a skill omits `name`, the
 * parent directory name is used as a stable fallback so providers can still
 * expose the skill. Missing descriptions are normalized to an empty string.
 */
export async function readProviderSkillMarkdownDefinition(
  skillPath: string,
): Promise<{ name: string; description: string }> {
  const content = await readFile(skillPath, 'utf8');
  return readProviderSkillMarkdownDefinitionFromContent(
    content,
    path.basename(path.dirname(skillPath)),
  );
}

/**
 * Reads the `name` and `description` fields from raw skill markdown content.
 *
 * This keeps filesystem discovery and newly uploaded skill creation aligned on
 * the same front matter parsing rules. `fallbackName` is used when the markdown
 * omits a `name` field so callers still get a stable, non-empty skill id.
 */
export function readProviderSkillMarkdownDefinitionFromContent(
  content: string,
  fallbackName: string,
): { name: string; description: string } {
  const parsed = parseFrontMatter(content);
  const data = readObjectRecord(parsed.data) ?? {};

  return {
    name: readOptionalString(data.name) ?? fallbackName,
    description: readOptionalString(data.description) ?? '',
  };
}

// ---------------------------
//----------------- SESSION SYNCHRONIZER TITLE HELPERS ------------
/**
 * Produces a compact session title suitable for UI rendering and DB storage.
 *
 * Use this when converting provider-native names into a consistent title value.
 * The helper collapses repeated whitespace, trims the result, and truncates it
 * to 120 characters so every provider writes stable and bounded metadata.
 * If the normalized input is empty, it returns the supplied fallback title.
 */
export function normalizeSessionName(rawValue: string | undefined, fallback: string): string {
  const normalized = (rawValue ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return fallback;
  }

  return normalized.slice(0, 120);
}

// ---------------------------
//----------------- PROVIDER SESSION VALUE NORMALIZATION UTILITIES ------------
/**
 * Converts provider-native timestamps into ISO strings.
 *
 * Provider CLIs commonly persist epoch timestamps as milliseconds, seconds, or
 * already-formatted date strings. Use this helper when normalizing session
 * metadata or transcript events so every provider writes the same ISO timestamp
 * shape to API responses and database rows.
 */
export function normalizeProviderTimestamp(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const millis = value < 1_000_000_000_000 ? value * 1000 : value;
    return new Date(millis).toISOString();
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return normalizeProviderTimestamp(parsed);
    }

    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }

  return new Date().toISOString();
}

/**
 * Parses a JSON string or narrows an existing object into a plain record.
 *
 * Use this when provider databases store structured JSON inside text columns.
 * Invalid JSON, arrays, and primitive values return `null` so callers can skip
 * malformed optional metadata without hiding the rest of a session transcript.
 */
export function readJsonRecord(value: unknown): AnyRecord | null {
  if (typeof value !== 'string') {
    return readObjectRecord(value);
  }

  try {
    return readObjectRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

// ---------------------------
//----------------- OPENCODE SESSION STORAGE UTILITIES ------------
/**
 * Resolves the OpenCode SQLite session database path.
 *
 * OpenCode stores session, message, part, and project metadata in one shared
 * `opencode.db` file under its XDG data directory. Provider readers and
 * synchronizers should use this path for read-only access and should never store
 * it as a deletable transcript path for an individual app session row.
 */
export function getOpenCodeDatabasePath(): string {
  return path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

/**
 * Decodes an OpenCode text payload that was persisted as a JSON string literal.
 *
 * OpenCode can store the first user prompt (and other text parts) as `"hello"`
 * instead of `hello`. Used by both the OpenCode session reader (transcript
 * history) and the OpenCode synchronizer (session titling) so a session name or
 * message body never surfaces with surrounding quote characters. Only fully
 * quoted, valid JSON string literals are unwrapped; ordinary prose that merely
 * happens to start/end with a quote is returned untouched.
 */
export function unwrapJsonStringLiteral(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) {
    return value;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === 'string' ? parsed : value;
  } catch {
    return value;
  }
}

// ---------------------------
//----------------- SAFE DIRECTORY NAME UTILITIES ------------
/**
 * Validates that a user or provider supplied identifier can safely be treated
 * as one leaf directory name under an existing root folder.
 *
 * Use this before composing paths like `<root>/<session-id>/file.db>` to block
 * path traversal and accidental nested paths. The returned string is trimmed but
 * otherwise unchanged so callers can still match the provider's on-disk naming.
 */
export function sanitizeLeafDirectoryName(inputName: string, label = 'directory name'): string {
  const normalized = inputName.trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }

  if (
    normalized.includes('..')
    || normalized.includes(path.posix.sep)
    || normalized.includes(path.win32.sep)
    || normalized !== path.basename(normalized)
  ) {
    throw new Error(`Invalid ${label} "${inputName}".`);
  }

  return normalized;
}

// ---------------------------
//----------------- SESSION SYNCHRONIZER FILESYSTEM HELPERS ------------
/**
 * Recursively discovers files that match one extension, with optional incremental filtering.
 *
 * Provider synchronizers call this to find transcript artifacts under provider
 * home directories. Pass `lastScanAt` to include only files created after the
 * previous scan, or pass `null` to perform a full rescan. Missing directories
 * are treated as empty because not every provider exists on every machine.
 */
export async function findFilesRecursivelyCreatedAfter(
  rootDir: string,
  extension: string,
  lastScanAt: Date | null,
  fileList: string[] = []
): Promise<string[]> {
  try {
    const entries = await readdir(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(rootDir, entry.name);

      if (entry.isDirectory()) {
        await findFilesRecursivelyCreatedAfter(fullPath, extension, lastScanAt, fileList);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(extension)) {
        continue;
      }

      if (!lastScanAt) {
        fileList.push(fullPath);
        continue;
      }

      const fileStat = await stat(fullPath);
      if (fileStat.birthtime > lastScanAt) {
        fileList.push(fullPath);
      }
    }
  } catch {
    // Missing provider folders are expected in first-run or partial setups.
  }

  return fileList;
}

/**
 * Reads file creation/update timestamps and maps them to DB-friendly ISO strings.
 *
 * Session indexers use this to persist `created_at` and `updated_at` metadata
 * when upserting sessions. If the file cannot be read, an empty object is
 * returned so indexing can continue for other files.
 */
export async function readFileTimestamps(
  filePath: string
): Promise<{ createdAt?: string; updatedAt?: string }> {
  try {
    const fileStat = await stat(filePath);
    return {
      createdAt: fileStat.birthtime.toISOString(),
      updatedAt: fileStat.mtime.toISOString(),
    };
  } catch {
    return {};
  }
}

/**
 * The tail window `readTranscriptLastActivity` starts from, and the ceiling it
 * may grow to.
 *
 * A transcript ends with a run of bookkeeping records — `last-prompt`,
 * `cost-state`, `mode`, `permission-mode`, `atis-latch` — that carry no
 * `timestamp`, so the newest real activity can sit well behind the end of the
 * file. Measured over one machine's corpus (1189 transcripts): a 64 KiB window
 * answered 1144 of them, 256 KiB answered 37 more, and 512 KiB answered the
 * last 6. The two that no window answers are ~700-byte files that record no
 * activity at all, so nothing on that corpus asked to look further back than
 * the ceiling. Starting small keeps the common case to one 64 KiB read; the
 * ceiling stops a pathological file from turning a sidebar refresh into a
 * whole-file read, and keeps one synchronizer pass over a large transcript
 * inside the byte budget its callers are held to.
 */
const TRANSCRIPT_ACTIVITY_INITIAL_WINDOW_BYTES = 64 * 1024;
const TRANSCRIPT_ACTIVITY_MAX_WINDOW_BYTES = 512 * 1024;

/**
 * Reads the newest activity time a transcript's own content records.
 *
 * Session indexers must not take a session's "last activity" from the
 * transcript's mtime. A file's mtime moves for reasons that are not user
 * activity — a CLI flushing bookkeeping records, an external process rewriting
 * or restoring the file — so a session idle for days can be shown as active
 * minutes ago. The records that do describe activity are the ones carrying a
 * `timestamp`, which is what this helper returns.
 *
 * Only a bounded tail window is read, growing from
 * `TRANSCRIPT_ACTIVITY_INITIAL_WINDOW_BYTES` to
 * `TRANSCRIPT_ACTIVITY_MAX_WINDOW_BYTES`: the newest activity is at the end of
 * the file, and transcripts reach hundreds of megabytes, so walking the whole
 * file line by line is not an option. Within a window the lines are walked
 * backwards, and the first parseable record with a usable `timestamp` wins.
 *
 * Returns the record's timestamp string exactly as stored, or null when no
 * record in the scanned window carries one. Callers must fall back to a
 * filesystem timestamp on null: a transcript that was just created has no
 * records yet, and it still needs an activity time. A missing or unreadable
 * file also returns null rather than throwing, so one bad transcript cannot
 * abort a scan.
 */
export async function readTranscriptLastActivity(filePath: string): Promise<string | null> {
  let handle: FileHandle | undefined;

  try {
    handle = await open(filePath, 'r');

    const { size } = await handle.stat();
    if (size <= 0) {
      return null;
    }

    let windowBytes = Math.min(TRANSCRIPT_ACTIVITY_INITIAL_WINDOW_BYTES, size);
    let windowStart = size - windowBytes;
    let window = await readFileRange(handle, windowStart, windowBytes);

    for (;;) {
      const timestamp = findLastRecordedTimestamp(
        window.toString('utf8'),
        await startsMidLine(handle, windowStart)
      );
      if (timestamp) {
        return timestamp;
      }

      // The window already covered the whole file, so the transcript records
      // no activity at all; enlarging it further cannot change that.
      if (windowStart === 0 || windowBytes >= TRANSCRIPT_ACTIVITY_MAX_WINDOW_BYTES) {
        return null;
      }

      // Widening reads only the bytes the window does not already hold: the
      // newest activity usually sits in the first window, and a transcript that
      // needs the ceiling should cost one read of the ceiling rather than the
      // sum of every window on the way there.
      const widenedBytes = Math.min(windowBytes * 4, TRANSCRIPT_ACTIVITY_MAX_WINDOW_BYTES, size);
      const widenedStart = size - widenedBytes;
      const prefix = await readFileRange(handle, widenedStart, windowStart - widenedStart);
      if (prefix.length === 0) {
        // The file shrank under the scan, so there is nothing older to read
        // and the window that was already searched is all this file has.
        return null;
      }

      window = Buffer.concat([prefix, window]);
      windowStart -= prefix.length;
      windowBytes = window.length;
    }
  } catch {
    return null;
  } finally {
    try {
      await handle?.close();
    } catch {
      // A close failure cannot change the answer this helper already produced.
    }
  }
}

/**
 * Reads up to `length` bytes at `offset`, returning fewer when the file ends.
 *
 * One `FileHandle.read` is allowed to return a short count — and does when
 * another process rewrites or truncates a transcript mid-scan — so a caller
 * cannot treat a single read as the whole range it asked for. Callers therefore
 * advance their cursors by `buffer.length`, which keeps the buffer's start
 * offset honest even when the read came up short.
 */
async function readFileRange(handle: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;

  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
    if (bytesRead === 0) {
      break;
    }
    filled += bytesRead;
  }

  return filled === length ? buffer : buffer.subarray(0, filled);
}

/**
 * Reports whether a read starting at `offset` begins inside a line.
 *
 * A window that opens mid-line begins with the tail of a record whose head lies
 * before it, and a fragment is not evidence of anything — so the caller drops
 * it. Testing the byte that precedes the offset, rather than assuming any
 * offset past zero is mid-line, keeps a window that happens to open exactly on
 * a line boundary from discarding the complete record sitting there.
 */
async function startsMidLine(handle: FileHandle, offset: number): Promise<boolean> {
  if (offset <= 0) {
    return false;
  }

  const precedingByte = Buffer.allocUnsafe(1);
  const { bytesRead } = await handle.read(precedingByte, 0, 1, offset - 1);
  return bytesRead === 1 && precedingByte[0] !== 0x0a;
}

/**
 * Walks one tail window backwards for the newest record that reports activity.
 *
 * `hasLeadingFragment` drops the window's first line when the read started
 * mid-line: that line is the tail of a record whose head lies before the window,
 * and a fragment is not evidence of anything. The last line needs no such
 * treatment — a record still being written fails `JSON.parse` and falls through
 * to the record before it, which is how a half-written append must behave
 * instead of throwing.
 */
function findLastRecordedTimestamp(windowText: string, hasLeadingFragment: boolean): string | null {
  const lines = windowText.split('\n');
  if (hasLeadingFragment) {
    lines.shift();
  }

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line) {
      continue;
    }

    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    const timestamp = readRecordedTimestamp(record);
    if (timestamp) {
      return timestamp;
    }
  }

  return null;
}

/**
 * Reads the activity timestamp one transcript record carries, if it carries one.
 *
 * A value the database layer cannot parse would be written as
 * `CURRENT_TIMESTAMP` — i.e. "active just now", the exact reading this helper
 * exists to stop — so an unparseable `timestamp` is treated as no timestamp and
 * the walk continues to an older record.
 */
function readRecordedTimestamp(record: unknown): string | null {
  const value = readObjectRecord(record)?.timestamp;
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  return Number.isNaN(new Date(value).getTime()) ? null : value;
}

// ---------------------------
//----------------- SESSION SYNCHRONIZER JSONL PARSING HELPERS ------------
/**
 * Builds a first-seen key/value lookup map from a JSONL file.
 *
 * Use this for provider index files where session id -> display name metadata
 * is stored line-by-line. The first value for each key wins, preserving the
 * earliest known label while avoiding repeated map overwrites.
 */
export async function buildLookupMap(
  filePath: string,
  keyField: string,
  valueField: string
): Promise<Map<string, string>> {
  const lookup = new Map<string, string>();

  try {
    const fileStream = fs.createReadStream(filePath);
    const lineReader = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of lineReader) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const key = parsed[keyField];
      const value = parsed[valueField];

      if (typeof key === 'string' && typeof value === 'string' && !lookup.has(key)) {
        lookup.set(key, value);
      }
    }
  } catch {
    // Missing or unreadable lookup files should not block session sync.
  }

  return lookup;
}

/**
 * Reads a JSONL file and returns the first extracted payload that matches caller criteria.
 *
 * The caller supplies an `extractor` that validates provider-specific row
 * shapes. This helper centralizes line-by-line parsing and lets indexers stop
 * scanning as soon as one valid row is found.
 */
export async function extractFirstValidJsonlData<T>(
  filePath: string,
  extractor: (parsedJson: unknown) => T | null | undefined
): Promise<T | null> {
  try {
    const fileStream = fs.createReadStream(filePath);
    const lineReader = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of lineReader) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      const parsed = JSON.parse(trimmed);
      const extracted = extractor(parsed);
      if (extracted) {
        lineReader.close();
        fileStream.close();
        return extracted;
      }
    }
  } catch {
    // Ignore malformed or missing artifacts so full scans keep progressing.
  }

  return null;
}

// ---------------------------
//----------------- CLI PROMPT ARGUMENT UTILITIES ------------
/**
 * Makes a prompt safe to pass as one CLI argument to `.cmd`-shimmed tools on
 * Windows (cursor-agent and opencode installed via npm-style shims).
 *
 * cmd.exe cannot carry newlines inside an argument: everything after the
 * first newline is silently dropped before the target CLI ever sees it, which
 * truncates multi-line prompts and any appended `<images_input>` block.
 * Collapsing newline runs to single spaces loses formatting but never loses
 * content, so runtimes should call this on win32 right before spawning.
 *
 * Used by the cursor and opencode spawn runtimes.
 */
export function flattenPromptForWindowsShell(prompt: string): string {
  if (process.platform !== 'win32' || typeof prompt !== 'string') {
    return prompt;
  }
  return prompt.replace(/\s*\r?\n\s*/g, ' ').trim();
}

// ---------------------------
//----------------- TERMINAL OUTPUT UTILITIES ------------
/**
 * Matches the escape sequences a CLI emits when it believes it is writing to a
 * terminal, in the three shapes those tools actually produce:
 * - OSC (`ESC ]` … terminated by BEL or ST), used for titles and hyperlinks.
 * - CSI (`ESC [`, or the 8-bit `\u009B` introducer that stands in for both
 *   bytes), used for SGR colors and cursor control.
 * - any other ECMA-48 escape sequence: `ESC`, optional intermediate bytes
 *   (`0x20`-`0x2F`), one final byte (`0x30`-`0x7E`), such as `ESC ( B`.
 *
 * OSC and CSI are listed first so their terminators are consumed by the
 * specific alternative rather than by the generic one.
 */
const ANSI_ESCAPE_SEQUENCE_REGEX =
  /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]|\u001B[ -/]*[0-~]/g;

/**
 * Removes ANSI escape sequences from text captured off a CLI's stdout or
 * stderr. Provider runtimes, session readers, and the shell WebSocket share
 * this because every one of them forwards captured process output to a web
 * client that renders plain text: left in, the escapes show up verbatim
 * (`[93m[1m!`) instead of as styling.
 *
 * The result can be empty when the input was styling only, so callers that
 * forward the text should re-check for emptiness after cleaning.
 */
export function stripAnsiSequences(value: string): string {
  return value.replace(ANSI_ESCAPE_SEQUENCE_REGEX, '');
}

const ANSI_TERMINAL_STYLES = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
} as const;

/**
 * Applies the small, consistent ANSI style vocabulary used by backend
 * terminal output. The CLI and server bootstrap share these formatters so
 * status, warning, and startup messages use one implementation. Callers
 * should pass complete display strings and write the returned value directly
 * to stdout or stderr; the reset suffix prevents styling subsequent output.
 */
export const terminalTextStyles = {
  info: (text: string): string =>
    `${ANSI_TERMINAL_STYLES.cyan}${text}${ANSI_TERMINAL_STYLES.reset}`,
  ok: (text: string): string =>
    `${ANSI_TERMINAL_STYLES.green}${text}${ANSI_TERMINAL_STYLES.reset}`,
  warn: (text: string): string =>
    `${ANSI_TERMINAL_STYLES.yellow}${text}${ANSI_TERMINAL_STYLES.reset}`,
  error: (text: string): string =>
    `${ANSI_TERMINAL_STYLES.yellow}${text}${ANSI_TERMINAL_STYLES.reset}`,
  tip: (text: string): string =>
    `${ANSI_TERMINAL_STYLES.blue}${text}${ANSI_TERMINAL_STYLES.reset}`,
  bright: (text: string): string =>
    `${ANSI_TERMINAL_STYLES.bright}${text}${ANSI_TERMINAL_STYLES.reset}`,
  dim: (text: string): string =>
    `${ANSI_TERMINAL_STYLES.dim}${text}${ANSI_TERMINAL_STYLES.reset}`,
};

// ---------------------------
//----------------- ACCESS-TOKEN LAST-USED THROTTLE UTILITIES ------------
/**
 * Minimum age of a token's recorded `last_used` before an accepted verification
 * rewrites it.
 *
 * `/mcp` verifies a bearer token on every request, so stamping `last_used` on
 * every acceptance would turn a busy client into one database write per call.
 * Throttling to at most one write per window keeps the reading useful — it still
 * answers "when was this token last used?" — without the write amplification.
 * The interval is a product decision, deliberately not configurable.
 */
const LAST_USED_STAMP_INTERVAL_MS = 60 * 1000;

/**
 * The ISO instant an accepted verification should record as `last_used`, or
 * `null` when the existing stamp is still inside the throttle window and the
 * write should be skipped.
 *
 * `previousLastUsed` is the value currently stored on the row (null when the
 * token or grant has never been used); `now` is the caller's injected clock, so
 * the decision is deterministic under test. A stored value that does not parse
 * as a date is treated as stale, so a corrupt row self-heals on the next use.
 *
 * Consumers: the OAuth module's `access-tokens.service.ts` (personal-access-token
 * verification) and `oauth-provider.service.ts` (OAuth access-token verification,
 * which throttles the owning grant with the same window). Both verify paths call
 * this one helper rather than each carrying its own comparison, so the two cannot
 * drift apart.
 */
export function lastUsedStamp(previousLastUsed: string | null, now: Date): string | null {
  if (previousLastUsed !== null) {
    const previous = new Date(previousLastUsed).getTime();
    if (!Number.isNaN(previous) && now.getTime() - previous < LAST_USED_STAMP_INTERVAL_MS) {
      return null;
    }
  }
  return now.toISOString();
}

// ---------------------------
//----------------- RUNTIME PATH RESOLUTION UTILITIES ------------
/**
 * Resolves the directory containing an ES module from `import.meta.url`.
 * Backend entrypoints and feature composition roots use this instead of
 * recreating CommonJS `__dirname` logic.
 */
export function getModuleDirectory(importMetaUrl: string): string {
  return path.dirname(fileURLToPath(importMetaUrl));
}

/**
 * Walks upward to the nearest `server` directory in either source or compiled
 * output. Callers use this stable anchor for server-relative resources.
 */
export function findServerRoot(startDirectory: string): string {
  let currentDirectory = startDirectory;
  while (path.basename(currentDirectory) !== 'server') {
    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      throw new Error(`Could not resolve the backend server root from "${startDirectory}".`);
    }
    currentDirectory = parentDirectory;
  }
  return currentDirectory;
}

/**
 * Resolves the application root from a source or `dist-server/server` path so
 * package-level resources work identically before and after compilation.
 */
export function findApplicationRoot(startDirectory: string): string {
  const serverRoot = findServerRoot(startDirectory);
  const parentDirectory = path.dirname(serverRoot);
  return path.basename(parentDirectory) === 'dist-server'
    ? path.dirname(parentDirectory)
    : parentDirectory;
}

/**
 * Overlays a compiled launch spec onto a spawn environment and returns a new
 * object: `spec.env` is merged over `base`, then every `spec.unsetEnv` key is
 * deleted. Used by the Claude SDK runtime (sdkOptions.env, which replaces the
 * child env) and the shell pty spawn so `unset` rows take effect on the final
 * env object in both paths. Never mutates `base`.
 */
export function applyLaunchSpecEnv<TBase extends Record<string, string | undefined>>(
  base: TBase,
  spec: { env: Record<string, string | undefined>; unsetEnv?: string[] },
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...base, ...spec.env };
  for (const key of spec.unsetEnv ?? []) {
    delete merged[key];
  }
  return merged;
}

// ---------------------------
//----------------- CLAUDE SESSION REGISTRY / OCCUPANCY UTILITIES ------------
/**
 * The config directory the Claude CLI this backend spawns will write its
 * transcript and session registry to.
 *
 * Read from the host's own environment rather than from a turn's option bag,
 * because the launch builder builds the child's environment from `process.env`
 * and ignores any `env` the caller supplied — so the bag is not what the process
 * was given, and reading it would be reading a value that never reached the CLI.
 *
 * Consumed by the Claude resident host driver (its Remote Control gate and its
 * occupancy gate) and by `readClaudeSessionOccupancy`'s default below.
 */
export function resolveClaudeConfigDir(): string {
  const fromEnv = process.env.CLAUDE_CONFIG_DIR;
  return fromEnv && fromEnv.trim() ? fromEnv : path.join(os.homedir(), '.claude');
}

/** The real directory listing, and the default every reader here is built on. */
const listSessionRegistryFiles: ClaudeSessionRegistryLister = (sessionsDirectory) =>
  fs.readdirSync(sessionsDirectory);

/**
 * Whether a registry row's process is still the process that wrote it.
 *
 * A registry file outlives a process that died without cleaning up, and pids are
 * recycled on a busy host, so "a signal can be delivered to that pid" is not
 * enough. Where `/proc` is readable the row's `procStart` (the process's start
 * time in clock ticks, field 22 of `/proc/<pid>/stat`) is compared as well; where
 * it is not, the signal probe alone decides. `EPERM` means the process exists
 * under another user, which is alive.
 */
function isRegistryProcessAlive(pid: number, procStart: string | null): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') {
      return false;
    }
  }
  if (!procStart) {
    return true;
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command name is parenthesised and may itself contain spaces or
    // parentheses, so the fields are counted from the last `)`.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    // Field 22 overall; the slice starts at field 3.
    return fields[19] === procStart;
  } catch {
    return true;
  }
}

/**
 * One parsed registry row, and the conversation it holds.
 *
 * The judgement is separated from the scan so the two readers below cannot
 * disagree about what an owner is. It answers with the row's *own* session id
 * rather than being told which id to look for, which is what lets a whole-table
 * reader key its table a row at a time instead of re-running the comparison
 * once per candidate.
 */
type ClaudeRegistryOccupant = { sessionId: string; owner: ClaudeBackgroundSessionOwner };

/**
 * Whether one parsed row is a live background job, and if so for which
 * conversation.
 *
 * `kind: "bg"` is the CLI's own mark for the agents view and `claude --bg`;
 * this app's resident processes register as `interactive` and are never an
 * owner. The pid has to be *the process that wrote the row* — see
 * {@link isRegistryProcessAlive} — because a registry file outlives a process
 * that died without cleaning up.
 *
 * `jobId` is the handle `claude stop` takes. The CLI writes one, but a row
 * without it still identifies the job well enough to name a command, so the
 * session id's first eight characters stand in for it — which is also the shape
 * the CLI prints as the short job id.
 */
function readRegistryOccupantRow(row: AnyRecord): ClaudeRegistryOccupant | null {
  if (row?.kind !== 'bg' || typeof row.sessionId !== 'string' || !row.sessionId) {
    return null;
  }
  if (typeof row.pid !== 'number') {
    return null;
  }
  if (!isRegistryProcessAlive(row.pid, typeof row.procStart === 'string' ? row.procStart : null)) {
    return null;
  }
  return {
    sessionId: row.sessionId,
    owner: {
      pid: row.pid,
      jobId: typeof row.jobId === 'string' && row.jobId ? row.jobId : row.sessionId.slice(0, 8),
      name: typeof row.name === 'string' && row.name ? row.name : null,
    },
  };
}

/**
 * The whole registry read once: every live background job, keyed by the
 * conversation it holds.
 *
 * Unreadable or unparseable rows are skipped, not errors: the registry is
 * another process's file, and one malformed row must not hide a real owner.
 * Where two rows claim the same conversation the first one wins, which is what
 * the single-conversation scan this replaced did — the registry is written one
 * file per process, so a duplicate means a recycled pid whose old file was never
 * cleaned up, and the row that sorts first is as good an answer as the other.
 *
 * Consumed by `findBackgroundSessionOwner` below and by `readClaudeSessionOccupancy`
 * (the host listing's whole-table reader); the two share this scan so a rule that
 * held for one could not disagree with the other.
 */
export function scanSessionRegistry(
  configDir: string,
  listFiles: ClaudeSessionRegistryLister,
): Map<string, ClaudeBackgroundSessionOwner> {
  const occupants = new Map<string, ClaudeBackgroundSessionOwner>();
  let files: string[];
  try {
    files = listFiles(path.join(configDir, 'sessions'));
  } catch {
    return occupants;
  }
  for (const file of files) {
    if (!file.endsWith('.json')) {
      continue;
    }
    let row: AnyRecord;
    try {
      row = JSON.parse(fs.readFileSync(path.join(configDir, 'sessions', file), 'utf8'));
    } catch {
      continue;
    }
    const occupant = readRegistryOccupantRow(row);
    if (!occupant || occupants.has(occupant.sessionId)) {
      continue;
    }
    occupants.set(occupant.sessionId, occupant.owner);
  }
  return occupants;
}

/**
 * The live Claude Code background job holding a conversation, or null.
 *
 * Claude Code refuses to resume a session that a background job (`claude --bg`,
 * the agents view) is running — the child exits with code 1 and says so only on
 * stderr — so a launch has to ask before it spawns one that cannot live. A job
 * that was detached from a terminal (`←` in `claude attach`) keeps running and
 * keeps its row, so detaching does not free the session; only `claude stop` does.
 *
 * Consumed by the Claude resident host driver (before it opens a resident host)
 * and by the Claude per-run runtime (before it creates a query). Those two
 * launch paths are the only consumers, and they share this one reader and the
 * refusal built from its answer.
 */
export function findBackgroundSessionOwner(
  configDir: string,
  providerSessionId: string | null | undefined,
): ClaudeBackgroundSessionOwner | null {
  if (!providerSessionId) {
    return null;
  }
  return scanSessionRegistry(configDir, listSessionRegistryFiles).get(providerSessionId) ?? null;
}

/**
 * Every conversation a Claude Code background job is holding on this host, keyed
 * by session id.
 *
 * Read from the registry the CLI this app spawns would write to: the config
 * directory is resolved here rather than taken as a parameter, exactly as the
 * resident launch resolves it, because the child's environment is built from
 * `process.env` and this is the directory the process would really register in.
 *
 * One scan for the whole answer, which is the shape the host listing needs: it
 * asks once per request for every session it is about to report, and it is
 * polled once a second. The `configDir` / `listFiles` parameters exist so a
 * criterion can point the same reader at a registry it owns and count the scans;
 * production callers pass neither.
 *
 * Re-exported through the providers barrel (via the Claude host driver) for
 * `server/index.ts`'s listing.
 */
export function readClaudeSessionOccupancy(
  configDir: string = resolveClaudeConfigDir(),
  listFiles: ClaudeSessionRegistryLister = listSessionRegistryFiles,
): Map<string, ClaudeSessionOccupancy> {
  const occupancy = new Map<string, ClaudeSessionOccupancy>();
  for (const [sessionId, owner] of scanSessionRegistry(configDir, listFiles)) {
    occupancy.set(sessionId, { jobId: owner.jobId, pid: owner.pid });
  }
  return occupancy;
}

/**
 * The refusal to resume a conversation a background job is holding.
 *
 * Thrown from a launch before any process exists, for the same reason the Remote
 * Control gate throws: the run has no room for an answer, and the dispatch
 * already handles a rejected run. `code` and `owner` are fields so a caller
 * branches on values; `message` is the sentence the user reads.
 *
 * Consumed by the Claude resident host driver and the Claude per-run runtime,
 * which throw the identical refusal so both server paths reject an occupied
 * session with the same words.
 */
export class ClaudeSessionOccupiedError extends Error {
  readonly code = 'session-occupied';
  readonly owner: ClaudeBackgroundSessionOwner;

  constructor(owner: ClaudeBackgroundSessionOwner) {
    super(
      `该会话正由 Claude Code 后台任务占用（job ${owner.jobId}，pid ${owner.pid}），CloudCLI 无法接管。` +
        `请先执行 \`claude stop ${owner.jobId}\` 停止它后重试，或 fork 该会话。`,
    );
    this.name = 'ClaudeSessionOccupiedError';
    this.owner = owner;
  }
}

// ---------------------------
//----------------- CLAUDE TRANSCRIPT ROW CLASSIFICATION UTILITIES ------------

/**
 * Row types the Claude CLI writes to record the request it sent to the API,
 * not the conversation. `api-request-blob` carries the wire message itself
 * (`message: { role, content }`) under the session's `sessionId` but with no
 * `uuid` or `timestamp`; the others are bookkeeping around it.
 */
const CLAUDE_REQUEST_CAPTURE_ROW_TYPES: ReadonlySet<string> = new Set([
  'api-request-blob',
  'api-request',
  'api-request-shape',
  'atis-latch',
]);

/**
 * Whether one parsed Claude transcript row is a request-capture row rather than
 * a conversation row.
 *
 * A reader that projects or indexes rows by `message.role` must skip these: a
 * blob looks like a user or assistant row, so it would surface as a duplicate
 * prompt under a generated id, and as speech the user never wrote (the text
 * blocks the CLI adds only to the wire request, such as `Tool loaded.`). Pass
 * an already `JSON.parse`d row; any non-object or row without a string `type`
 * is not a capture row.
 *
 * Consumed by the Claude history reader (`claude-sessions.provider`) and the
 * conversation search service, which each read the transcript line by line.
 */
export function isClaudeRequestCaptureRow(entry: unknown): boolean {
  if (entry === null || typeof entry !== 'object') {
    return false;
  }
  const type = (entry as { type?: unknown }).type;
  return typeof type === 'string' && CLAUDE_REQUEST_CAPTURE_ROW_TYPES.has(type);
}
