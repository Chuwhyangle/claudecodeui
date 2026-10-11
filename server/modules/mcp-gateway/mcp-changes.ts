/**
 * The MCP gateway's `changes` handler (AC-335).
 *
 * `changes` answers "what moved since the last time I asked", so an agent can
 * stop polling `sessions_list` / `session_get` between every write. It reads
 * four sources and compares each against the watermark a previous call handed
 * back:
 *
 *  - the session rows the WATCHER already wrote to the database
 *    (`db.sessions`), read newest-first from an injected incremental reader;
 *  - the in-flight and recently-settled runs the process registry holds
 *    (`mem.runs`);
 *  - the tool approvals currently waiting for a person (`mem.approvals`);
 *  - the Quay snapshot CACHE for a project (`quay.cache`) — never a CLI spawn.
 *
 * Everything is injected ({@link McpChangesDeps}), so the tool cannot reach a
 * full `synchronizeSessions` or a Quay CLI even if it wanted to: neither is a
 * member. The criterion proves that with counting fakes.
 *
 * Three things the contract requires and this module is built around:
 *
 *  - the CURSOR is opaque and self-describing ({@link McpChangesCursor}): a
 *    version byte, a watermark, the issuing process's `bootId`, and a per-project
 *    Quay head. A cursor this tool did not issue — tampered, truncated, a
 *    different version — is refused `INVALID_ARGUMENT`, never silently treated
 *    as "no cursor".
 *  - delivery is AT-LEAST-ONCE. Duplicates are allowed (the caller dedupes by
 *    `(kind, ref, at)`), but the watermark must never skip an event that was not
 *    emitted: when a page is truncated the next watermark stops at the last
 *    emitted event instead of jumping to `now()`.
 *  - the reading is HONEST about what it cannot see. A cursor issued by a
 *    previous boot cannot speak for the in-memory run/approval state that died
 *    with that process, so a `bootId` mismatch reports `gaps` and `complete:
 *    false` rather than pretending the view is whole; a Quay project with a
 *    config but a cold cache reports a `cache cold` gap (the tool refuses to
 *    spawn the CLI to fill it).
 *
 * `at` is the instant the change happened (a stored timestamp when the source
 * has one, the observation instant otherwise); `source.observedAt` / `ageMs` is
 * how fresh that reading is — the watcher's lag, made visible instead of
 * hidden. `summary` never carries a message body: it is titles, ids, tool names
 * and transitions only.
 *
 * Cross-module vocabulary comes through the barrels, exactly as the sibling
 * `mcp-run-get.js` does; the import edge back to
 * `mcp-gateway.read-tools.js` closes the same cycle whose only members are
 * hoisted function declarations (`formatMcpTime`), none read at
 * module-evaluation time.
 */

import { z } from 'zod';

import { MCP_ERROR_CODES, McpToolError } from './mcp-error-envelope.js';
import type { McpToolInputSchema } from './mcp-gateway.audit.js';
import { formatMcpTime } from './mcp-gateway.read-tools.js';
import type {
  McpReadToolContext,
  McpReadToolDeps,
  McpReadToolSeam,
  McpRunSummary,
  McpTime,
} from './mcp-gateway.read-tools.js';

// --------------------------- limits and vocabulary ---------------------------

/** How many events one `changes` page returns when the caller names no `limit`. */
export const MCP_CHANGES_DEFAULT_LIMIT = 50;

/** The smallest and largest `limit` `changes` accepts. */
export const MCP_CHANGES_MIN_LIMIT = 1;
export const MCP_CHANGES_MAX_LIMIT = 200;

/**
 * The one version byte the cursor payload starts with. A cursor whose first byte
 * is anything else was not issued by this build (a future format, or a tampered
 * string) and is refused rather than guessed at.
 */
const MCP_CHANGES_CURSOR_VERSION = 1;

/**
 * The whole `kind` vocabulary, in the contract's order. `quay_gate` and `commit`
 * are accepted as `kinds` filter values and reserved for later sources; this
 * implementation emits `session` / `run` / `interaction` / `quay_task`.
 */
export const MCP_CHANGES_KINDS = ['session', 'run', 'interaction', 'quay_task', 'quay_gate', 'commit'] as const;

/** Every `kind` a `changes` event can carry. */
export type McpChangesKind = (typeof MCP_CHANGES_KINDS)[number];

/** What an event means for the reader watching it. */
export type McpChangesSignal = 'liveness' | 'progress' | 'blocked';

/**
 * Where an event's fact came from. `git` is reserved (no git reader is wired
 * yet); the other four are the sources this module reads.
 */
export type McpChangesSourceType = 'db.sessions' | 'mem.runs' | 'mem.approvals' | 'quay.cache' | 'git';

// --------------------------- injected services ---------------------------

/**
 * One session row the incremental reader yields: the id, the project it belongs
 * to, its display title, and the instant its stored `updated_at` names (in epoch
 * milliseconds, already normalised by the caller so this module never parses a
 * SQLite timestamp).
 */
export type McpChangesSessionRow = {
  sessionId: string;
  projectId: string | null;
  title: string;
  updatedAtMs: number;
};

/**
 * One Quay task as the CACHE reports it: the id, its title, its status, and the
 * timestamp the store last wrote (an ISO string or `null`). Read from the
 * snapshot cache only — never from a CLI run.
 */
export type McpChangesQuayTaskRow = {
  taskId: string;
  title: string;
  status: string;
  updatedAt: string | null;
};

/** The pending approval rows this module reports, flattened across sessions. */
export type McpChangesApprovalRow = {
  requestId: string;
  sessionId: string;
  toolName: string;
  /** When the approval was received, in epoch milliseconds. */
  receivedAtMs: number;
};

/** A project, so an event can name its display title beside its id. */
export type McpChangesProjectRow = { id: string; title: string };

/**
 * Everything `changes` reads, all injected.
 *
 * `sessions.listUpdatedSince` is the incremental session reader (rows newer than
 * a lower bound, newest first, at most `limit`); `sessions.projectForSession`
 * resolves a run's or approval's session to its project, so those events are
 * attributed without a second reader. `quay` reads the CACHE only —
 * `readCachedTasks` answers `null` for a cold cache, and there is deliberately
 * no `refresh` member, so filling a cold cache by spawning the CLI is
 * structurally impossible here. `now` and `bootId` are the clock and process
 * identity (`BOOT_ID`), read once per call.
 */
export type McpChangesDeps = {
  sessions: {
    /** Rows whose stored `updated_at` is newer than `sinceIso`, newest first, at most `limit`. */
    listUpdatedSince(sinceIso: string, limit: number): McpChangesSessionRow[];
    /** The project a session belongs to, or `null` when it cannot be resolved. */
    projectForSession(sessionId: string): string | null;
  };
  runs: {
    /** Every run the registry still holds, as summaries. */
    listRecentRuns(): McpRunSummary[];
  };
  approvals: {
    /** The tool approvals currently waiting, across every session the caller owns. */
    listPending(): McpChangesApprovalRow[];
  };
  quay: {
    /** Whether the project carries a `.quay/config.yml`; never spawns. */
    hasQuayConfig(projectId: string): boolean;
    /** The cached task rows, or `null` when the cache is cold; never spawns. */
    readCachedTasks(projectId: string): McpChangesQuayTaskRow[] | null;
  };
  projects: {
    /** Every project, so an event can name its title. */
    list(): McpChangesProjectRow[];
  };
  now: () => number;
  /** The current process identity — the activity protocol's own `BOOT_ID`. */
  bootId: () => string;
};

// --------------------------- the cursor ---------------------------

/** One project's Quay reading as the cursor remembers it: each task's last status. */
export type McpChangesProjectHead = { tasks: Record<string, string> };

/**
 * The decoded cursor. `watermark` is the instant (epoch ms) the issuing call read
 * up to; an event is visible when its `at` is strictly after it. `bootId` records
 * which process issued it, so a restart is detectable. `perProjectHead` remembers
 * the Quay statuses a project last reported, so a status TRANSITION — not a
 * still-current status — is what an event means.
 */
export type McpChangesCursor = {
  v: number;
  watermark: number;
  bootId: string;
  perProjectHead: Record<string, McpChangesProjectHead>;
};

/** The `INVALID_ARGUMENT` envelope a cursor this tool did not issue is refused with. */
function invalidCursorError(): McpToolError {
  return new McpToolError(
    MCP_ERROR_CODES.INVALID_ARGUMENT,
    'The `cursor` is not a cursor this tool issued; pass back a cursor exactly as returned.',
    false,
    { field: 'cursor' },
  );
}

/**
 * Encodes a cursor as the opaque string a caller passes back: a version byte,
 * then the JSON payload, base64url-encoded. The version byte is outside the JSON
 * so a future format can tell its own cursors apart from this one's by the first
 * byte alone.
 */
export function encodeChangesCursor(cursor: McpChangesCursor): string {
  const json = Buffer.from(JSON.stringify(cursor), 'utf8');
  const payload = Buffer.concat([Buffer.from([MCP_CHANGES_CURSOR_VERSION]), json]);
  return payload.toString('base64url');
}

/** Whether a decoded value has the shape a cursor must have. */
function isCursorShape(value: unknown): value is McpChangesCursor {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const cursor = value as Record<string, unknown>;
  if (typeof cursor.watermark !== 'number' || !Number.isFinite(cursor.watermark)) {
    return false;
  }
  if (cursor.v !== MCP_CHANGES_CURSOR_VERSION) {
    return false;
  }
  if (typeof cursor.bootId !== 'string') {
    return false;
  }
  const head = cursor.perProjectHead;
  if (typeof head !== 'object' || head === null || Array.isArray(head)) {
    return false;
  }
  for (const entry of Object.values(head as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) {
      return false;
    }
    const tasks = (entry as Record<string, unknown>).tasks;
    if (typeof tasks !== 'object' || tasks === null || Array.isArray(tasks)) {
      return false;
    }
    for (const status of Object.values(tasks as Record<string, unknown>)) {
      if (typeof status !== 'string') {
        return false;
      }
    }
  }
  return true;
}

/**
 * Decodes a caller-supplied cursor, throwing {@link invalidCursorError} for
 * anything this tool did not issue: a non-base64url character, an empty payload,
 * a wrong version byte, malformed JSON, or a payload missing a field.
 */
export function decodeChangesCursor(raw: string): McpChangesCursor {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw invalidCursorError();
  }
  const payload = Buffer.from(raw, 'base64url');
  if (payload.length === 0 || payload[0] !== MCP_CHANGES_CURSOR_VERSION) {
    throw invalidCursorError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.subarray(1).toString('utf8'));
  } catch {
    throw invalidCursorError();
  }
  if (!isCursorShape(parsed)) {
    throw invalidCursorError();
  }
  return parsed;
}

// --------------------------- payload ---------------------------

/** A change's reference: which ids the event names, per the contract's vocabulary. */
export type McpChangesRef = {
  sessionId?: string;
  runId?: string;
  taskId?: string;
  commit?: string;
};

/** One change, with its fact-source and freshness. */
export type McpChangesEvent = {
  kind: McpChangesKind;
  project: { id: string | null; title: string };
  at: McpTime;
  signal: McpChangesSignal;
  ref: McpChangesRef;
  /** A body-free sentence: ids, titles, tool names and transitions only. */
  summary: string;
  source: { type: McpChangesSourceType; observedAt: McpTime; ageMs: number };
};

/** One thing this reading cannot see, and why. */
export type McpChangesGap = { kind: McpChangesKind; reason: string };

/** The `changes` tool's response. */
export type McpChangesPayload = {
  cursor: string;
  generatedAt: McpTime;
  bootId: string;
  /** True only when nothing was hidden: no gap and no truncated page. */
  complete: boolean;
  events: McpChangesEvent[];
  gaps: McpChangesGap[];
};

// --------------------------- input ---------------------------

/** The `changes` tool's typed input. */
export type McpChangesInput = {
  cursor?: string;
  /** The lower bound (epoch ms) when no cursor is passed; `null` means "from the beginning". */
  sinceMs: number | null;
  /** Project ids to scope to; absent means every project (workspace scope). */
  projects?: string[];
  /** Kinds to include; absent means every kind. */
  kinds?: McpChangesKind[];
  limit: number;
};

/**
 * Reads and validates `changes`' arguments. The wrapper has already type-checked
 * them against the advertised schema; this is the defensive second pass that also
 * turns a bad `since` into the same `INVALID_ARGUMENT` a bad `cursor` produces.
 */
export function readChangesInput(args: Record<string, unknown>): McpChangesInput {
  const cursor = typeof args.cursor === 'string' && args.cursor.length > 0 ? args.cursor : undefined;

  let sinceMs: number | null = null;
  if (args.since !== undefined) {
    if (typeof args.since !== 'string') {
      throw new McpToolError(MCP_ERROR_CODES.INVALID_ARGUMENT, 'The `since` argument must be an ISO 8601 string.', false, {
        field: 'since',
      });
    }
    const parsed = Date.parse(args.since);
    if (Number.isNaN(parsed)) {
      throw new McpToolError(MCP_ERROR_CODES.INVALID_ARGUMENT, 'The `since` argument is not a valid ISO 8601 timestamp.', false, {
        field: 'since',
      });
    }
    sinceMs = parsed;
  }

  const projects = Array.isArray(args.projects)
    ? args.projects.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : undefined;

  const kinds = Array.isArray(args.kinds)
    ? args.kinds.filter((entry): entry is McpChangesKind => MCP_CHANGES_KINDS.includes(entry as McpChangesKind))
    : undefined;

  // A present `limit` is validated, never clamped or silently replaced by the
  // default: the advertised schema already refuses a non-integer or an
  // out-of-range value, and a handler that answered `1.5` with a page of 50
  // would disagree with the contract a warm client validated against. An
  // ABSENT `limit` is the only path to the default.
  let limit = MCP_CHANGES_DEFAULT_LIMIT;
  if (args.limit !== undefined) {
    if (typeof args.limit !== 'number' || !Number.isInteger(args.limit)) {
      throw new McpToolError(
        MCP_ERROR_CODES.INVALID_ARGUMENT,
        'The `limit` argument must be an integer.',
        false,
        { field: 'limit' },
      );
    }
    if (args.limit < MCP_CHANGES_MIN_LIMIT || args.limit > MCP_CHANGES_MAX_LIMIT) {
      throw new McpToolError(
        MCP_ERROR_CODES.INVALID_ARGUMENT,
        `The \`limit\` argument must be between ${MCP_CHANGES_MIN_LIMIT} and ${MCP_CHANGES_MAX_LIMIT}.`,
        false,
        { field: 'limit' },
      );
    }
    limit = args.limit;
  }

  return { cursor, sinceMs, projects, kinds, limit };
}

// --------------------------- buildChanges ---------------------------

/** One candidate event before sorting, carrying the raw instant it sorts by. */
type CandidateEvent = { atMs: number; event: McpChangesEvent };

/** Builds the sentence for a session's change. Titles only — never a message body. */
function sessionSummary(title: string): string {
  return `Session ${JSON.stringify(title)} changed.`;
}

/** The relative+ISO reading of `atMs`, and the age that reading exposes. */
function timeAndAge(atMs: number, observedAt: number): { at: McpTime; ageMs: number } {
  return { at: formatMcpTime(atMs, () => observedAt), ageMs: Math.max(0, observedAt - atMs) };
}

/**
 * Computes the events, gaps and next cursor for one `changes` call.
 *
 * The watermark is `deps.now()` read ONCE at the top (`observedAt`): it is both
 * the instant the reading is taken and, unless the page is truncated, the next
 * cursor's watermark. Using one instant for both is what makes the at-least-once
 * guarantee structural — anything that happens after `observedAt` will be
 * strictly greater than the watermark the caller receives.
 */
export async function buildChanges(
  input: McpChangesInput,
  ctx: McpReadToolContext | undefined,
  deps: McpChangesDeps,
): Promise<McpChangesPayload> {
  // The scope gate is the audited wrapper's; the caller identity is not read here.
  void ctx;

  const observedAt = deps.now();
  const bootId = deps.bootId();
  const cursor = input.cursor === undefined ? null : decodeChangesCursor(input.cursor);
  const lowerBound = cursor !== null ? cursor.watermark : input.sinceMs ?? 0;

  const projects = deps.projects.list();
  const titleById = new Map(projects.map((project) => [project.id, project.title]));
  const scopeIds = input.projects ?? projects.map((project) => project.id);
  const scopeSet = new Set(scopeIds);
  const kinds = new Set<McpChangesKind>(input.kinds ?? MCP_CHANGES_KINDS);

  const gaps: McpChangesGap[] = [];
  const candidates: CandidateEvent[] = [];

  const projectOf = (projectId: string | null): { id: string | null; title: string } =>
    projectId === null
      ? { id: null, title: 'Unknown project' }
      : { id: projectId, title: titleById.get(projectId) ?? projectId };

  // Workspace scope (no `projects` filter) admits an unresolvable project too;
  // a project filter admits only the ids it named.
  const inScope = (projectId: string | null): boolean =>
    input.projects === undefined ? true : projectId !== null && scopeSet.has(projectId);

  // A cursor from another boot cannot speak for the in-memory run/approval state
  // that process held — saying so is the whole point of the boot check.
  if (cursor !== null && cursor.bootId !== bootId) {
    gaps.push({
      kind: 'run',
      reason: 'The service restarted since this cursor was issued; run changes from before the restart are not visible.',
    });
    gaps.push({
      kind: 'interaction',
      reason:
        'The service restarted since this cursor was issued; pending-approval changes from before the restart are not visible.',
    });
  }

  // --- sessions (the watcher's database) ---
  if (kinds.has('session')) {
    const rows = deps.sessions.listUpdatedSince(new Date(lowerBound).toISOString(), input.limit);
    for (const row of rows) {
      if (!inScope(row.projectId) || row.updatedAtMs <= lowerBound) {
        continue;
      }
      const { at, ageMs } = timeAndAge(row.updatedAtMs, observedAt);
      candidates.push({
        atMs: row.updatedAtMs,
        event: {
          kind: 'session',
          project: projectOf(row.projectId),
          at,
          signal: 'liveness',
          ref: { sessionId: row.sessionId },
          summary: sessionSummary(row.title),
          source: { type: 'db.sessions', observedAt: formatMcpTime(observedAt, () => observedAt), ageMs },
        },
      });
    }
  }

  // --- runs (the process registry) ---
  if (kinds.has('run')) {
    for (const run of deps.runs.listRecentRuns()) {
      const projectId = deps.sessions.projectForSession(run.sessionId);
      if (!inScope(projectId)) {
        continue;
      }
      if (run.startedAt > lowerBound) {
        const { at, ageMs } = timeAndAge(run.startedAt, observedAt);
        candidates.push({
          atMs: run.startedAt,
          event: {
            kind: 'run',
            project: projectOf(projectId),
            at,
            signal: 'progress',
            ref: { runId: run.runId, sessionId: run.sessionId },
            summary: `Run ${run.runId} started in session ${run.sessionId}.`,
            source: { type: 'mem.runs', observedAt: formatMcpTime(observedAt, () => observedAt), ageMs },
          },
        });
      }
      if (run.completedAt !== null && run.completedAt > lowerBound) {
        const { at, ageMs } = timeAndAge(run.completedAt, observedAt);
        candidates.push({
          atMs: run.completedAt,
          event: {
            kind: 'run',
            project: projectOf(projectId),
            at,
            signal: 'progress',
            ref: { runId: run.runId, sessionId: run.sessionId },
            summary: `Run ${run.runId} ended (${run.status}) in session ${run.sessionId}.`,
            source: { type: 'mem.runs', observedAt: formatMcpTime(observedAt, () => observedAt), ageMs },
          },
        });
      }
    }
  }

  // --- approvals (the process runtime) ---
  if (kinds.has('interaction')) {
    for (const approval of deps.approvals.listPending()) {
      const projectId = deps.sessions.projectForSession(approval.sessionId);
      if (!inScope(projectId) || approval.receivedAtMs <= lowerBound) {
        continue;
      }
      const { at, ageMs } = timeAndAge(approval.receivedAtMs, observedAt);
      candidates.push({
        atMs: approval.receivedAtMs,
        event: {
          kind: 'interaction',
          project: projectOf(projectId),
          at,
          signal: 'blocked',
          ref: { sessionId: approval.sessionId },
          summary: `Approval ${approval.requestId} for tool ${approval.toolName} is waiting in session ${approval.sessionId}.`,
          source: { type: 'mem.approvals', observedAt: formatMcpTime(observedAt, () => observedAt), ageMs },
        },
      });
    }
  }

  // --- quay (the snapshot cache only) ---
  //
  // A status is a TRANSITION when it differs from what the cursor's head recorded
  // for that task; a task the head never saw is new. A cold cache for a project
  // that HAS a config is a gap, not an event — and never a reason to spawn the CLI.
  const nextHead: Record<string, McpChangesProjectHead> = {};
  for (const projectId of scopeIds) {
    const previousTasks = cursor?.perProjectHead[projectId]?.tasks ?? {};
    const tasks: Record<string, string> = { ...previousTasks };
    const cached = deps.quay.readCachedTasks(projectId);
    if (cached === null) {
      if (deps.quay.hasQuayConfig(projectId)) {
        gaps.push({ kind: 'quay_task', reason: `Quay cache is cold for project ${projectId}.` });
      }
      nextHead[projectId] = { tasks };
      continue;
    }
    for (const task of cached) {
      const previous = previousTasks[task.taskId];
      tasks[task.taskId] = task.status;
      if (kinds.has('quay_task') && previous !== task.status) {
        const observedIso = task.updatedAt === null ? null : Date.parse(task.updatedAt);
        const ageMs = observedIso === null || Number.isNaN(observedIso) ? 0 : Math.max(0, observedAt - observedIso);
        candidates.push({
          atMs: observedAt,
          event: {
            kind: 'quay_task',
            project: projectOf(projectId),
            at: formatMcpTime(observedAt, () => observedAt),
            signal: 'progress',
            ref: { taskId: task.taskId },
            summary:
              previous === undefined
                ? `Quay task ${task.taskId} (${JSON.stringify(task.title)}) is ${task.status}.`
                : `Quay task ${task.taskId} moved from ${previous} to ${task.status}.`,
            source: { type: 'quay.cache', observedAt: formatMcpTime(observedAt, () => observedAt), ageMs },
          },
        });
      }
    }
    nextHead[projectId] = { tasks };
  }

  // Stable order: by instant, then kind, then the reference's own JSON.
  candidates.sort((left, right) => {
    if (left.atMs !== right.atMs) {
      return left.atMs - right.atMs;
    }
    if (left.event.kind !== right.event.kind) {
      return left.event.kind < right.event.kind ? -1 : 1;
    }
    const leftRef = JSON.stringify(left.event.ref);
    const rightRef = JSON.stringify(right.event.ref);
    return leftRef < rightRef ? -1 : leftRef > rightRef ? 1 : 0;
  });

  const truncated = candidates.length > input.limit;
  const emitted = truncated ? candidates.slice(0, input.limit) : candidates;

  // The next watermark must not skip an event that was not emitted: full page →
  // `observedAt`; truncated page → one millisecond before the last emitted
  // instant, so the boundary event (and everything after it) is re-read next call
  // and the caller's `(kind, ref, at)` dedup absorbs the repeat.
  const lastEmittedAt = emitted.length > 0 ? emitted[emitted.length - 1].atMs : observedAt;
  const nextWatermark = truncated ? Math.max(0, lastEmittedAt - 1) : observedAt;
  // A truncated page leaves the Quay head where it was, so the statuses it could
  // not report are re-diffed (and re-emitted) on the next call.
  const perProjectHead = truncated ? cursor?.perProjectHead ?? {} : nextHead;

  const nextCursor: McpChangesCursor = {
    v: MCP_CHANGES_CURSOR_VERSION,
    watermark: nextWatermark,
    bootId,
    perProjectHead,
  };

  return {
    cursor: encodeChangesCursor(nextCursor),
    generatedAt: formatMcpTime(observedAt, () => observedAt),
    bootId,
    complete: gaps.length === 0 && !truncated,
    events: emitted.map((candidate) => candidate.event),
    gaps,
  };
}

// --------------------------- registration ---------------------------

/** The advertised input shape: a raw shape the wrapper compiles and enforces. */
export const MCP_CHANGES_INPUT_SCHEMA: McpToolInputSchema = {
  cursor: z.string().optional(),
  since: z.string().optional(),
  projects: z.array(z.string()).optional(),
  kinds: z.array(z.enum(MCP_CHANGES_KINDS)).optional(),
  limit: z.number().int().min(MCP_CHANGES_MIN_LIMIT).max(MCP_CHANGES_MAX_LIMIT).optional(),
};

const changesTimeSchema = z.object({ relative: z.string(), iso: z.string() });

/** The advertised output shape, matching {@link McpChangesPayload} field for field. */
export const MCP_CHANGES_OUTPUT_SCHEMA: z.ZodRawShape = {
  cursor: z.string(),
  generatedAt: changesTimeSchema,
  bootId: z.string(),
  complete: z.boolean(),
  events: z.array(
    z.object({
      kind: z.enum(MCP_CHANGES_KINDS),
      project: z.object({ id: z.string().nullable(), title: z.string() }),
      at: changesTimeSchema,
      signal: z.enum(['liveness', 'progress', 'blocked']),
      ref: z.object({
        sessionId: z.string().optional(),
        runId: z.string().optional(),
        taskId: z.string().optional(),
        commit: z.string().optional(),
      }),
      summary: z.string(),
      source: z.object({
        type: z.enum(['db.sessions', 'mem.runs', 'mem.approvals', 'quay.cache', 'git']),
        observedAt: changesTimeSchema,
        ageMs: z.number(),
      }),
    }),
  ),
  gaps: z.array(z.object({ kind: z.enum(MCP_CHANGES_KINDS), reason: z.string() })),
};

/**
 * `changes`' metadata, as `registerMcpReadTools` passes it down from the one
 * {@link MCP_STAGE3_READ_TOOLS} table (name / description / scope / schemas), so
 * this module only attaches a real handler to a name the table already owns.
 */
export type McpChangesRegistration = {
  name: string;
  description: string;
  requiredScope: string;
  inputSchema: McpToolInputSchema;
  outputSchema: z.ZodRawShape;
};

/**
 * Whether a read-tool deps bag carries a wired `changes` deps bag.
 * `registerMcpReadTools` uses it to route the `changes` NAME to the real handler
 * when the composition root supplied one, and to keep the named
 * `MCP_TOOL_NOT_IMPLEMENTED` refusal on a mount that did not — the registered
 * name set is unchanged either way.
 */
export function isChangesWired(deps: McpReadToolDeps): deps is McpReadToolDeps & { changes: McpChangesDeps } {
  return deps.changes !== undefined;
}

/**
 * Registers `changes` with its real handler through the audited registration
 * seam. Consumers: `registerMcpReadTools`, which routes the one name here when
 * its deps are wired, and the criterion, which drives the seam directly to read
 * back the registered name.
 */
export function registerMcpChangesTool(
  seam: McpReadToolSeam,
  deps: McpChangesDeps,
  registration: McpChangesRegistration,
): void {
  seam({
    name: registration.name,
    description: registration.description,
    requiredScope: registration.requiredScope,
    inputSchema: registration.inputSchema,
    outputSchema: registration.outputSchema,
    handler: (args, ctx) => buildChanges(readChangesInput(args), ctx, deps),
  });
}
