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
 *  - the per-project Quay task status INDEX (`quay.index`) — every task, never a
 *    page, and never a CLI spawn on the read path.
 *
 * Everything is injected ({@link McpChangesDeps}), so the tool cannot reach a
 * full `synchronizeSessions` even if it wanted to: it is not a member. The Quay
 * side is an index READ plus a non-blocking, deduped, rate-limited load REQUEST
 * (`requestTaskIndexLoad`) whose result only ever appears on a later call — the
 * read path cannot wait on a subprocess because it is never handed a promise.
 * The criterion proves both with counting fakes and with the real service.
 *
 * Three things the contract requires and this module is built around:
 *
 *  - the CURSOR is opaque, self-describing AND BOUNDED ({@link McpChangesCursor}):
 *    a version byte, a watermark, the issuing process's `bootId`, the session
 *    keyset position, and — per in-scope Quay project — a compact
 *    `{baselineId, digest}` REFERENCE into a capacity-bounded server-side LRU of
 *    baselines ({@link McpChangesBaselineStore}). The per-task status table lives
 *    in that LRU, never in the cursor, so the cursor's size does not grow with the
 *    corpus, and a project the LRU no longer holds is REPORTED as `rebase` rather
 *    than silently re-baselined. A cursor this tool did not issue — tampered,
 *    truncated, a different version — is refused `INVALID_ARGUMENT`, never
 *    silently treated as "no cursor".
 *  - delivery is AT-LEAST-ONCE. Duplicates are allowed (the caller dedupes by
 *    `(kind, ref, at)`), but the watermark must never skip an event that was not
 *    emitted: when a page is truncated the next watermark stops at the last
 *    emitted event instead of jumping to `now()`.
 *  - the reading is HONEST about what it cannot see. A cursor issued by a
 *    previous boot cannot speak for the in-memory run/approval state that died
 *    with that process, so a `bootId` mismatch reports `gaps` and `complete:
 *    false` rather than pretending the view is whole; a Quay project whose index
 *    has not been read reports a gap carrying the state it is in, and asks for a
 *    background load rather than spawning one inline.
 *
 * `at` is the instant the change happened (a stored timestamp when the source
 * has one, the observation instant otherwise); `source.observedAt` / `ageMs` is
 * how fresh that reading is — the watcher's lag, made visible instead of
 * hidden. For a Quay task the two are kept apart by name: `at` is the RECORD's
 * own `updatedAt` (with `atSource: 'record.updatedAt'`), while
 * `source.observedAt` is when this server looked. `summary` never carries a
 * message body: it is titles, ids, tool names and transitions only.
 *
 * `sources` says, per covered project, WHERE its Quay reading stands — `ready`,
 * `stale`, `cold`, `warming`, `bootstrap`, `rebase` or `error` — so "I looked and
 * there was nothing" is never confused with "I could not look", and a lost
 * baseline is never confused with a first sighting. `complete` requires every one
 * of them to be `ready`.
 *
 * Cross-module vocabulary comes through the barrels, exactly as the sibling
 * `mcp-run-get.js` does; the import edge back to
 * `mcp-gateway.read-tools.js` closes the same cycle whose only members are
 * hoisted function declarations (`formatMcpTime`), none read at
 * module-evaluation time.
 */

import { createHash } from 'node:crypto';

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
 * The version byte this build ISSUES. v3 (AC-349) REPLACED the cursor's embedded
 * per-project Quay head with a compact `{baselineId, digest}` reference into a
 * bounded server-side LRU ({@link McpChangesBaselineStore}); v2 added the session
 * keyset position ({@link McpChangesCursor.sessionKey}) so a truncated session
 * page resumes from a total order instead of a watermark that had already passed
 * the unread rows.
 */
const MCP_CHANGES_CURSOR_VERSION = 3;

/**
 * Every version this build still ACCEPTS: the two legacy bytes and its own. A v1
 * cursor has no session keyset position and both legacy versions embed a
 * per-project task table — so a legacy cursor is diffed against that table ONCE
 * and the cursor handed back is v3 (AC-349 (e)). Any other first byte was not
 * issued by this tool.
 */
const MCP_CHANGES_LEGACY_CURSOR_VERSIONS = new Set([1, 2, MCP_CHANGES_CURSOR_VERSION]);

/**
 * The most bytes an encoded `changes` cursor may occupy. The cursor travels
 * inside an MCP tool result, so it has to stay small no matter how many projects
 * a workspace has or how many tasks they hold (AC-349 (a)); the refs that do not
 * fit are dropped from the cursor and their projects report `rebase` next call.
 */
export const MCP_CHANGES_CURSOR_MAX_BYTES = 8192;

/**
 * How many Quay baselines the server-side LRU holds. Every project's baseline is
 * a full `taskId → status` table, so the store is bounded by COUNT rather than by
 * bytes: past the capacity the oldest baseline is evicted and any cursor still
 * referencing it reports `rebase` (AC-349 (c), (f)).
 */
export const MCP_CHANGES_BASELINE_LRU_CAPACITY = 256;

/**
 * The most tasks one baseline may hold. A baseline exists so a later call can
 * DIFF it, so a project past this cap cannot be baselined at all: it reports
 * `rebase` (with the cap named in the reason) instead of pinning an unbounded
 * table in memory (AC-349 (f)).
 */
export const MCP_CHANGES_BASELINE_MAX_TASKS = 10000;

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
 * yet); `quay.cache` is the AC-335 spelling, retained so an old reader's enum
 * still parses, while a Quay event now names `quay.index` — the full-coverage
 * status index this module reads instead of the panel's truncated `recent` list.
 */
export type McpChangesSourceType = 'db.sessions' | 'mem.runs' | 'mem.approvals' | 'quay.cache' | 'quay.index' | 'git';

/**
 * The whole `state` vocabulary a Quay source can report, in the contract's order.
 * `bootstrap` and `rebase` are this tool's own verdicts — `bootstrap` is a
 * project the cursor has NEVER seen (the index is fine, there is just no baseline
 * to compare with), `rebase` is a project whose baseline WAS held and is now
 * LOST (LRU eviction, a digest mismatch, a restart, or a cursor too large to keep
 * the ref) — while the rest are the index's own states.
 */
export const MCP_CHANGES_SOURCE_STATES = ['ready', 'stale', 'cold', 'warming', 'bootstrap', 'rebase', 'error'] as const;

/** Where one Quay source stands, as `changes` reports it. */
export type McpChangesSourceState = (typeof MCP_CHANGES_SOURCE_STATES)[number];

/**
 * The states only the INDEX itself reports — what `readTaskIndex` hands back. The
 * two cursor-derived verdicts (`bootstrap`, `rebase`) are this module's own, so
 * they can never be mistaken for something the index said.
 */
export type McpChangesIndexState = Exclude<McpChangesSourceState, 'bootstrap' | 'rebase'>;

/**
 * One source this reading covers, with the freshness of that coverage. Today the
 * only source with a per-project state is Quay; the field exists so "I looked and
 * there was nothing" can be told apart from "I could not look".
 */
export type McpChangesSource = {
  kind: 'quay_task';
  /** The project's id — the `sources` analogue of an event's `project`. */
  project: string;
  state: McpChangesSourceState;
  /** `full` when the reading covers every task the store has, not a bounded page. */
  coverage: 'full';
  /** How many tasks the index held; 0 until a load has succeeded. */
  taskCount: number;
  /** When the index was observed, or `null` when there is no reading at all. */
  observedAt: McpTime | null;
  /** How old that observation is, or `null` when there is none. */
  ageMs: number | null;
};

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
 * One Quay task as the INDEX reports it: the id, its title, its status, and the
 * timestamp the store last wrote (an ISO string or `null`). A full-coverage
 * reading of every task the project has, never a bounded page of ten.
 */
export type McpChangesQuayTaskRow = {
  taskId: string;
  title: string;
  status: string;
  updatedAt: string | null;
};

/**
 * One project's compact task status index, as read — never loaded — by this
 * module. `state` is `cold` / `warming` before anything has landed, `ready` or
 * `stale` for a reading inside / past its freshness window, and `error` when the
 * last load failed (in which case the previous reading is still carried). The
 * `tasks` map is keyed by task id and covers the whole store.
 */
export type McpChangesQuayTaskIndex = {
  state: McpChangesIndexState;
  coverage: 'full';
  taskCount: number;
  observedAtMs: number | null;
  tasks: ReadonlyMap<string, McpChangesQuayTaskRow>;
  reason?: string;
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
 * `sessions.listChangedSince` is the incremental session reader: an ASCENDING
 * keyset page over `(updated_at, sessionId)`, taken from the position `after`,
 * narrowed in SQL by `projectIds` (`null` = every project), at most `limit` rows
 * — and it reports `hasMore`, so a page holding exactly `limit` rows is still
 * known to be truncated. `sessions.projectForSession` resolves a run's or
 * approval's session to its project, so those events are attributed without a
 * second reader. `quay` reads the INDEX only — `readTaskIndex` reports where the
 * last load left it (`cold` / `warming` / `ready` / `stale` / `error`) and never
 * loads, `requestTaskIndexLoad` returns `void` so nothing here can await it, and
 * there is deliberately no `refresh` member, so filling a cold index by spawning
 * the whole-snapshot CLI is structurally impossible. `now` and `bootId` are the
 * clock and process identity (`BOOT_ID`), read once per call.
 */
export type McpChangesDeps = {
  sessions: {
    /**
     * One keyset page of sessions strictly after `after`, ascending, at most
     * `limit` rows, plus whether the reader held a further row back. `after`
     * names the last session already emitted (`sessionId: null` = nothing yet).
     * `projectIds` narrows the page in the reader; `null` means every project.
     */
    listChangedSince(
      after: { atMs: number; sessionId: string | null },
      projectIds: string[] | null,
      limit: number,
    ): { rows: McpChangesSessionRow[]; hasMore: boolean };
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
    /**
     * The project's compact task status index as of the last load, WITHOUT
     * loading: the reading is `cold` / `warming` / `ready` / `stale` / `error`,
     * and a stale or failed one still carries the previous rows.
     */
    readTaskIndex(projectId: string): McpChangesQuayTaskIndex;
    /**
     * Asks for a background, deduped, rate-limited index load and returns at
     * once. A read path calls it to make the NEXT reading better; it never
     * reports progress, and nothing here may wait on it.
     */
    requestTaskIndexLoad(projectId: string): void;
  };
  projects: {
    /** Every project, so an event can name its title. */
    list(): McpChangesProjectRow[];
  };
  now: () => number;
  /** The current process identity — the activity protocol's own `BOOT_ID`. */
  bootId: () => string;
  /**
   * The bounded server-side store the cursor's `{baselineId, digest}` refs point
   * into. Optional: the module falls back to its own process-wide LRU
   * ({@link defaultChangesBaselineStore}), which is what production uses, and a
   * criterion injects a sized store so LRU eviction is deterministic.
   */
  baselines?: McpChangesBaselineStore;
};

// --------------------------- the cursor ---------------------------

/**
 * One project's Quay reading as a LEGACY (v1 / v2) cursor remembered it: each
 * task's last status, EMBEDDED in the cursor. v3 cursors no longer carry this —
 * they reference a server-side baseline ({@link McpChangesBaselineRef}) instead —
 * so the type survives only as the DECODED form of a legacy cursor, diffed
 * against exactly once (AC-349 (e)).
 */
export type McpChangesProjectHead = { tasks: Record<string, string> };

/**
 * Where the session source stopped: the `(instant, sessionId)` pair of the last
 * session event emitted. The next call reads every session strictly AFTER it, so
 * rows sharing one `updatedAt` continue across the page boundary by id rather
 * than being re-read or skipped. `null` means "no keyset position yet" — a
 * reading still bounded by {@link McpChangesCursor.watermark} alone (which is
 * all a v1 cursor carries).
 */
export type McpChangesSessionKey = { atMs: number; sessionId: string };

/** The cursor's compact reference to one SERVER-SIDE baseline. */
export type McpChangesBaselineRef = {
  /** The baseline's id in the store — the key {@link McpChangesBaselineStore.get} looks up. */
  baselineId: string;
  /** sha256 of the baseline's content, so a tampered or foreign ref is detected. */
  digest: string;
};

/** One baseline as the store holds it: its ref plus the table the ref stands for. */
type McpChangesBaseline = McpChangesBaselineRef & { tasks: Record<string, string> };

/**
 * What {@link McpChangesBaselineStore.get} found: the baseline, `'miss'` when the
 * id is not (or is no longer) held, or `'digest'` when the held baseline's
 * content no longer matches the ref. Both losses are reported as a `rebase`.
 */
export type McpChangesBaselineLookup = McpChangesBaseline | 'miss' | 'digest';

/**
 * The capacity-bounded server-side store of Quay baselines the cursor's refs
 * point into. The cursor carries only ids, so this is where the corpus actually
 * lives; it is bounded by COUNT (an LRU) so a long-lived server's memory cannot
 * grow with the number of projects it has seen.
 */
export type McpChangesBaselineStore = {
  /** Records `tasks` under a ref and returns it, deduplicating identical content. */
  put(tasks: Record<string, string>): McpChangesBaselineRef;
  /** Looks a ref up, touching it in the LRU; encodes the two ways it can be lost. */
  get(ref: McpChangesBaselineRef): McpChangesBaselineLookup;
  /** How many baselines are held — the criterion asserts the bound actually bites. */
  readonly size: number;
};

/** sha256 of a baseline's canonical content: task ids sorted, then `[id, status]` pairs. */
function digestOfTasks(tasks: Record<string, string>): string {
  const canonical = Object.keys(tasks)
    .sort()
    .map((taskId) => [taskId, tasks[taskId]]);
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

/**
 * A capacity-bounded LRU over Quay baselines. `get` is a real read (it touches
 * the entry); past `capacity` the OLDEST baseline is evicted, and a cursor still
 * referencing it is answered `'miss'` — the signal to report `rebase`, never to
 * silently re-baseline. Identical content deduplicates to one entry, so two calls
 * that read the same world hand back the SAME ref (the cursor is repeatable).
 * Consumers: {@link buildChanges} through {@link McpChangesDeps.baselines}, and
 * {@link defaultChangesBaselineStore}, the process-wide instance production uses.
 */
export function createChangesBaselineStore(
  capacity: number = MCP_CHANGES_BASELINE_LRU_CAPACITY,
): McpChangesBaselineStore {
  const entries = new Map<string, McpChangesBaseline>();
  const idByDigest = new Map<string, string>();
  let sequence = 0;

  const put = (tasks: Record<string, string>): McpChangesBaselineRef => {
    const digest = digestOfTasks(tasks);
    const existing = idByDigest.get(digest);
    if (existing !== undefined) {
      const held = entries.get(existing);
      if (held !== undefined) {
        // A use: move it to the young end so the LRU evicts the coldest entry.
        entries.delete(existing);
        entries.set(existing, held);
        return { baselineId: existing, digest };
      }
    }
    const ref: McpChangesBaselineRef = { baselineId: `b${(sequence += 1).toString(36)}`, digest };
    entries.set(ref.baselineId, { ...ref, tasks });
    idByDigest.set(digest, ref.baselineId);
    while (entries.size > capacity) {
      const oldest = entries.keys().next();
      if (oldest.done) {
        break;
      }
      const victimId = oldest.value;
      const victim = entries.get(victimId);
      entries.delete(victimId);
      if (victim !== undefined && idByDigest.get(victim.digest) === victimId) {
        idByDigest.delete(victim.digest);
      }
    }
    return ref;
  };

  return {
    put,
    get(ref) {
      const entry = entries.get(ref.baselineId);
      if (entry === undefined) {
        return 'miss';
      }
      if (entry.digest !== ref.digest) {
        return 'digest';
      }
      entries.delete(ref.baselineId);
      entries.set(ref.baselineId, entry);
      return entry;
    },
    get size() {
      return entries.size;
    },
  };
}

/**
 * The process-wide baseline store. Production wires no `baselines` dep, so this
 * is the one the `changes` handler uses; a restart makes a new process with a
 * new, EMPTY store, which is exactly why a `bootId` change also reports `rebase`.
 */
const defaultChangesBaselineStore = createChangesBaselineStore();

/**
 * The decoded cursor. `watermark` is the instant (epoch ms) the issuing call read
 * up to; an event is visible when its `at` is strictly after it. `bootId` records
 * which process issued it, so a restart is detectable. `baselines` is the
 * per-project REFERENCE into the server-side LRU — a status TRANSITION, not a
 * still-current status, is what an event means — and `rebased` lists the projects
 * whose ref the issuer had to DROP to stay within the cursor's byte budget, so
 * the next call reports them as `rebase` rather than as first sightings.
 * `sessionKey` is the ascending keyset position the session source resumes from
 * (`null` on a v1 cursor, or on a page that ended before any session event).
 * `legacyHead` is DECODED-ONLY: a v1 / v2 cursor's embedded table, diffed against
 * once and never re-encoded (AC-349 (e)).
 */
export type McpChangesCursor = {
  v: number;
  watermark: number;
  bootId: string;
  baselines: Record<string, McpChangesBaselineRef>;
  rebased: string[];
  sessionKey: McpChangesSessionKey | null;
  /** A legacy (v1 / v2) cursor's embedded per-project head; never encoded. */
  legacyHead?: Record<string, McpChangesProjectHead>;
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
 * byte alone. Only the CURRENT (`v3`) body is written, so a decoded legacy cursor
 * is upgraded when it is re-encoded; the decoded-only `legacyHead` is dropped.
 */
export function encodeChangesCursor(cursor: McpChangesCursor): string {
  const body = {
    v: MCP_CHANGES_CURSOR_VERSION,
    watermark: cursor.watermark,
    bootId: cursor.bootId,
    sessionKey: cursor.sessionKey,
    baselines: cursor.baselines,
    rebased: cursor.rebased,
  };
  const json = Buffer.from(JSON.stringify(body), 'utf8');
  const payload = Buffer.concat([Buffer.from([MCP_CHANGES_CURSOR_VERSION]), json]);
  return payload.toString('base64url');
}

/**
 * Whether a value has the shape an embedded legacy per-project head must have:
 * an object of `{ tasks }` objects whose values are status strings. Validated for
 * EVERY version that carries the field — so a v3 cursor that smuggles a malformed
 * one is refused too — and REQUIRED by the two versions that embed it.
 */
function hasLegacyHeadShape(head: unknown): boolean {
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

/** Whether a value has the shape a v3 body must have: the baseline refs and the dropped list. */
function hasV3Shape(cursor: Record<string, unknown>): boolean {
  const baselines = cursor.baselines;
  if (typeof baselines !== 'object' || baselines === null || Array.isArray(baselines)) {
    return false;
  }
  for (const ref of Object.values(baselines as Record<string, unknown>)) {
    if (typeof ref !== 'object' || ref === null) {
      return false;
    }
    const pair = ref as Record<string, unknown>;
    if (typeof pair.baselineId !== 'string' || typeof pair.digest !== 'string') {
      return false;
    }
  }
  const rebased = cursor.rebased;
  return Array.isArray(rebased) && rebased.every((projectId) => typeof projectId === 'string');
}

/** Whether a decoded value has the shape a cursor must have (any accepted version). */
function hasCursorShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const cursor = value as Record<string, unknown>;
  if (typeof cursor.watermark !== 'number' || !Number.isFinite(cursor.watermark)) {
    return false;
  }
  if (typeof cursor.v !== 'number' || !MCP_CHANGES_LEGACY_CURSOR_VERSIONS.has(cursor.v)) {
    return false;
  }
  if (typeof cursor.bootId !== 'string') {
    return false;
  }
  // The session keyset position is present from v2 on: `null` (nothing emitted
  // yet) or a finite `(atMs, sessionId)` pair. A v1 cursor has no such field.
  if (cursor.v >= 2) {
    const key = cursor.sessionKey;
    if (key !== null) {
      if (typeof key !== 'object' || Array.isArray(key)) {
        return false;
      }
      const pair = key as Record<string, unknown>;
      if (typeof pair.atMs !== 'number' || !Number.isFinite(pair.atMs)) {
        return false;
      }
      if (typeof pair.sessionId !== 'string') {
        return false;
      }
    }
  }
  // v1 and v2 EMBED a per-project head and must carry a well-shaped one; a v3
  // cursor does not carry one, but must not smuggle a malformed one either.
  if (cursor.v < MCP_CHANGES_CURSOR_VERSION || cursor.perProjectHead !== undefined) {
    if (!hasLegacyHeadShape(cursor.perProjectHead)) {
      return false;
    }
  }
  return cursor.v === MCP_CHANGES_CURSOR_VERSION ? hasV3Shape(cursor) : true;
}

/**
 * Decodes a caller-supplied cursor, throwing {@link invalidCursorError} for
 * anything this tool did not issue: a non-base64url character, an empty payload,
 * a first byte that is not an accepted version, malformed JSON, or a payload
 * missing a field. A legacy (v1 / v2) payload is ACCEPTED and normalised: its
 * embedded head is carried as {@link McpChangesCursor.legacyHead} for the one
 * diff this reading does against it, and `sessionKey` defaults to `null`, so the
 * session source resumes from its watermark exactly as that build left it
 * (AC-347 (e), AC-349 (e)).
 */
export function decodeChangesCursor(raw: string): McpChangesCursor {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw invalidCursorError();
  }
  const payload = Buffer.from(raw, 'base64url');
  if (payload.length === 0 || !MCP_CHANGES_LEGACY_CURSOR_VERSIONS.has(payload[0])) {
    throw invalidCursorError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.subarray(1).toString('utf8'));
  } catch {
    throw invalidCursorError();
  }
  if (!hasCursorShape(parsed)) {
    throw invalidCursorError();
  }
  const body = parsed as {
    v: number;
    watermark: number;
    bootId: string;
    sessionKey?: McpChangesSessionKey | null;
    baselines?: Record<string, McpChangesBaselineRef>;
    rebased?: string[];
    perProjectHead?: Record<string, McpChangesProjectHead>;
  };
  const cursor: McpChangesCursor = {
    v: body.v,
    watermark: body.watermark,
    bootId: body.bootId,
    baselines: body.baselines ?? {},
    rebased: body.rebased ?? [],
    sessionKey: body.sessionKey ?? null,
  };
  if (body.v < MCP_CHANGES_CURSOR_VERSION) {
    cursor.legacyHead = body.perProjectHead ?? {};
  }
  return cursor;
}

// --------------------------- payload ---------------------------

/** A change's reference: which ids the event names, per the contract's vocabulary. */
export type McpChangesRef = {
  sessionId?: string;
  runId?: string;
  taskId?: string;
  commit?: string;
};

/**
 * What changed about a Quay task, in one field for all three cases: a status
 * move has both sides (`todo` → `ready`), an APPEARANCE has no prior status and a
 * REMOVAL has no new one. Keeping them in one shape is what lets a caller page on
 * `(kind, ref, at)` without a second discriminator.
 */
export type McpChangesTransition = { from: string | null; to: string | null };

/**
 * Which instant the event's `at` came from. `record.updatedAt` is a time the
 * STORE recorded; `index.observedAt` is the time THIS SERVER looked. A removal
 * has no record to date it, so it is stamped with the observation — and saying
 * which is which is the difference between a fact and a guess.
 */
export type McpChangesAtSource = 'record.updatedAt' | 'index.observedAt';

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
  /** Present on a Quay task event: what moved, appeared or went away. */
  transition?: McpChangesTransition;
  /** Present on a Quay task event: which instant `at` actually is. */
  atSource?: McpChangesAtSource;
};

/**
 * One thing this reading cannot see, and why. `state` carries the source state
 * the gap came from, so a caller can branch on it instead of matching prose.
 */
export type McpChangesGap = { kind: McpChangesKind; reason: string; state?: McpChangesSourceState };

/** The `changes` tool's response. */
export type McpChangesPayload = {
  cursor: string;
  generatedAt: McpTime;
  bootId: string;
  /**
   * True only when nothing was hidden: no gap, no truncated page, AND every
   * in-scope Quay source actually `ready`. A `bootstrap` (no baseline yet) or a
   * `stale` index hides whatever moved since it was read, so neither may claim
   * completeness — see AC-348 / the ledger's "不得宣称 complete".
   */
  complete: boolean;
  events: McpChangesEvent[];
  gaps: McpChangesGap[];
  /** The Quay projects this reading covered, and how fresh each coverage is. */
  sources: McpChangesSource[];
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
 * The compact form of one project's index: task id → status, and nothing else.
 * This is what a SERVER-SIDE baseline holds (never the cursor, from v3 on), so it
 * is the shape {@link McpChangesBaselineStore.put} hashes and stores.
 */
function statusesOf(index: McpChangesQuayTaskIndex): Record<string, string> {
  const tasks: Record<string, string> = {};
  for (const [taskId, row] of index.tasks) {
    tasks[taskId] = row.status;
  }
  return tasks;
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
  //
  // The one source read as an ASCENDING keyset page (AC-347): the project filter
  // travels into the reader's SQL and the page is taken from the cursor's own
  // `(atMs, sessionId)` position, so a page that happens to hold exactly `limit`
  // rows still resumes from the row AFTER its last one instead of from a
  // watermark that had already passed the unread rows. The reader also reports
  // whether it held a row back, which is what makes that full page legible as a
  // truncation rather than a complete reading.
  let sessionsHaveMore = false;
  const sessionKeyOf = new Map<CandidateEvent, McpChangesSessionKey>();
  if (kinds.has('session')) {
    const after = cursor?.sessionKey ?? { atMs: lowerBound, sessionId: null };
    const page = deps.sessions.listChangedSince(after, input.projects ?? null, input.limit);
    sessionsHaveMore = page.hasMore;
    for (const row of page.rows) {
      const { at, ageMs } = timeAndAge(row.updatedAtMs, observedAt);
      const candidate: CandidateEvent = {
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
      };
      candidates.push(candidate);
      sessionKeyOf.set(candidate, { atMs: row.updatedAtMs, sessionId: row.sessionId });
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

  // --- quay (the full-coverage status index, never a spawn) ---
  //
  // A project that carries no `.quay/config.yml` is not a Quay source at all: it
  // is absent from `sources`, it produces no event, and any baseline REF the
  // cursor already holds for it rides through untouched. A project that IS a Quay
  // source gets one `sources` entry saying where its index stands, and a diff
  // against its SERVER-SIDE baseline — or, when this cursor has never seen it, a
  // baseline and nothing else; or, when its baseline was LOST, a `rebase` gap.
  const baselines = deps.baselines ?? defaultChangesBaselineStore;
  const bootChanged = cursor !== null && cursor.bootId !== bootId;
  const sources: McpChangesSource[] = [];
  // Carried refs survive a scope switch untouched; on a restart they do not,
  // because the process that held the store is gone.
  const nextBaselines: Record<string, McpChangesBaselineRef> = bootChanged ? {} : { ...(cursor?.baselines ?? {}) };
  // A project whose ref the previous cursor could not keep (trimmed to the byte
  // budget), or which a restart invalidated, must report `rebase` on its next
  // in-scope reading rather than masquerade as a first sighting.
  const rebased = new Set<string>(cursor?.rebased ?? []);
  if (bootChanged) {
    for (const projectId of Object.keys(cursor?.baselines ?? {})) {
      rebased.add(projectId);
    }
  }
  const legacyHead = bootChanged ? undefined : cursor?.legacyHead;
  // The projects THIS reading reported as `rebase` — used below so a truncated
  // page does not re-attach a ref it has just declared lost.
  const rebasedNow = new Set<string>();

  for (const projectId of scopeIds) {
    if (!deps.quay.hasQuayConfig(projectId)) {
      continue;
    }

    // Reading NEVER loads. The request below only makes the next reading better,
    // and it is placed before the diff so this call's `state` is the one it read.
    const index = deps.quay.readTaskIndex(projectId);
    deps.quay.requestTaskIndexLoad(projectId);
    const sourceOf = (state: McpChangesSourceState): McpChangesSource => ({
      kind: 'quay_task',
      project: projectId,
      state,
      coverage: index.coverage,
      taskCount: index.taskCount,
      observedAt: index.observedAtMs === null ? null : formatMcpTime(index.observedAtMs, () => observedAt),
      ageMs: index.observedAtMs === null ? null : Math.max(0, observedAt - index.observedAtMs),
    });

    if (index.observedAtMs === null) {
      // Nothing has ever landed: `cold` (never asked), `warming` (a load is in
      // flight) or `error` (the last attempt failed). There is nothing to diff, so
      // the reading declares itself — with a machine-readable state beside the
      // prose — instead of inventing events or quietly claiming completeness.
      const state: McpChangesIndexState = index.state;
      gaps.push({
        kind: 'quay_task',
        reason: `Quay task index for project ${projectId} is ${state}.`,
        state,
      });
      sources.push(sourceOf(state));
      continue;
    }

    const tasks = statusesOf(index);

    // A project past the per-baseline cap cannot be baselined at all: report the
    // loss with the cap named, rather than pinning an unbounded table in memory.
    if (index.tasks.size > MCP_CHANGES_BASELINE_MAX_TASKS) {
      gaps.push({
        kind: 'quay_task',
        state: 'rebase',
        reason: `Project ${projectId} holds ${index.tasks.size} tasks, over the ${MCP_CHANGES_BASELINE_MAX_TASKS}-task baseline cap, so no baseline is kept for it; status changes since the last reading may not be reported.`,
      });
      sources.push(sourceOf('rebase'));
      rebasedNow.add(projectId);
      delete nextBaselines[projectId];
      continue;
    }

    // The baseline this reading diffs against — or WHY it has none it may use.
    // Every way a baseline can be LOST becomes an explicit `rebase`, so a caller
    // is told the window may be unreported instead of being handed a fabricated
    // "everything appeared" burst.
    const previousRef = cursor?.baselines[projectId];
    const previousLegacy = legacyHead?.[projectId]?.tasks;
    let baseline: Record<string, string> | null = null;
    let lost: string | null = null;
    if (bootChanged && (previousRef !== undefined || previousLegacy !== undefined)) {
      lost = `The service restarted since this cursor was issued; the Quay statuses it had recorded for ${projectId} cannot be compared across the restart, so status changes in the window may not be reported.`;
    } else if (previousRef !== undefined) {
      const found = baselines.get(previousRef);
      if (found === 'miss') {
        lost = `The server no longer holds the Quay baseline this cursor referenced for ${projectId} (the baseline store is bounded and the entry was evicted), so status changes in the window since it was dropped may not be reported.`;
      } else if (found === 'digest') {
        lost = `The Quay baseline this cursor referenced for ${projectId} no longer matches its recorded digest (the store entry was overwritten), so status changes in the window may not be reported.`;
      } else {
        baseline = found.tasks;
      }
    } else if (rebased.has(projectId)) {
      lost = `The cursor had to drop ${projectId}'s Quay baseline to stay within its byte budget, so status changes in the window since it was dropped may not be reported.`;
    } else if (previousLegacy !== undefined) {
      // A legacy (v1 / v2) cursor embedded its own table: diff against it ONCE,
      // then hand back a v3 cursor reference (AC-349 (e)).
      baseline = previousLegacy;
    }

    if (lost !== null) {
      gaps.push({ kind: 'quay_task', state: 'rebase', reason: lost });
      sources.push(sourceOf('rebase'));
      rebasedNow.add(projectId);
      // Re-establish a baseline from what is readable NOW, so the NEXT call is
      // `ready` again: the loss is reported, not repeated.
      nextBaselines[projectId] = baselines.put(tasks);
      rebased.delete(projectId);
      continue;
    }

    if (baseline === null) {
      // The cursor has never seen this project: this reading IS the baseline. It
      // emits nothing — a first sighting is not a change — and it says so, so a
      // caller can tell "nothing moved" from "I have nothing to compare with".
      nextBaselines[projectId] = baselines.put(tasks);
      rebased.delete(projectId);
      sources.push(sourceOf('bootstrap'));
      continue;
    }

    const previousTasks = baseline;
    // A stale (or failed-but-retained) index still DIFFS: refusing to read it
    // would lose the very change the caller is asking about, and its age is
    // already on the source entry.
    sources.push(sourceOf(index.state));
    if (kinds.has('quay_task')) {
      for (const [taskId, row] of index.tasks) {
        const previous = previousTasks[taskId];
        if (previous === row.status) {
          continue;
        }
        const recordAtMs = row.updatedAt === null ? null : Date.parse(row.updatedAt);
        const dated = recordAtMs !== null && Number.isFinite(recordAtMs);
        // A transition is dated by the STORE's own instant; an appearance has the
        // record's instant too. Only a removal has no record to date it, and that
        // one is stamped with the observation and labelled as such.
        const atMs = dated ? (recordAtMs as number) : observedAt;
        candidates.push({
          atMs,
          event: {
            kind: 'quay_task',
            project: projectOf(projectId),
            at: formatMcpTime(atMs, () => observedAt),
            signal: 'progress',
            ref: { taskId },
            summary:
              previous === undefined
                ? `Quay task ${taskId} (${JSON.stringify(row.title)}) appeared as ${row.status}.`
                : `Quay task ${taskId} moved from ${previous} to ${row.status}.`,
            transition: { from: previous ?? null, to: row.status },
            atSource: dated ? 'record.updatedAt' : 'index.observedAt',
            source: {
              type: 'quay.index',
              observedAt: formatMcpTime(index.observedAtMs, () => observedAt),
              ageMs: Math.max(0, index.observedAtMs - atMs),
            },
          },
        });
      }
      // A task the baseline held and the full index no longer has is a REMOVAL:
      // the only reading a ten-row `recent` page could never have produced.
      for (const taskId of Object.keys(previousTasks)) {
        if (index.tasks.has(taskId)) {
          continue;
        }
        candidates.push({
          atMs: observedAt,
          event: {
            kind: 'quay_task',
            project: projectOf(projectId),
            at: formatMcpTime(observedAt, () => observedAt),
            signal: 'progress',
            ref: { taskId },
            summary: `Quay task ${taskId} is gone (was ${previousTasks[taskId]}).`,
            transition: { from: previousTasks[taskId], to: null },
            atSource: 'index.observedAt',
            source: {
              type: 'quay.index',
              observedAt: formatMcpTime(index.observedAtMs, () => observedAt),
              ageMs: Math.max(0, observedAt - index.observedAtMs),
            },
          },
        });
      }
    }
    // The baseline moves forward to what this reading saw, so the next call
    // diffs against THIS one.
    nextBaselines[projectId] = baselines.put(tasks);
    rebased.delete(projectId);
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

  // A page is truncated when the combined page overflowed `limit` OR the session
  // reader held a row back. The second disjunct is the AC-347 fix: `DESC … LIMIT`
  // plus a `> limit` test reads false on a page holding exactly `limit` rows, so
  // the unread (older) rows were lost.
  const truncated = candidates.length > input.limit || sessionsHaveMore;
  const emitted = candidates.length > input.limit ? candidates.slice(0, input.limit) : candidates;

  // The next watermark must not skip an event that was not emitted: full page →
  // `observedAt`; truncated page → one millisecond before the last emitted
  // instant, so the boundary event (and everything after it) is re-read next call
  // and the caller's `(kind, ref, at)` dedup absorbs the repeat.
  const lastEmittedAt = emitted.length > 0 ? emitted[emitted.length - 1].atMs : observedAt;
  const nextWatermark = truncated ? Math.max(0, lastEmittedAt - 1) : observedAt;
  // A truncated page leaves the Quay baselines where the cursor had them, so the
  // statuses it could not report are re-diffed (and re-emitted) on the next call.
  // The projects THIS reading declared `rebase` are the exception: their ref must
  // not be re-attached, or the loss they just reported would hide behind it.
  const finalBaselines: Record<string, McpChangesBaselineRef> = truncated
    ? { ...(cursor?.baselines ?? {}) }
    : nextBaselines;
  if (truncated) {
    for (const projectId of rebasedNow) {
      delete finalBaselines[projectId];
    }
  }
  const finalRebased: string[] = truncated
    ? [...new Set([...(cursor?.rebased ?? []), ...rebasedNow])].sort()
    : [...rebased].sort();

  // The session keyset position is the last session EVENT emitted — never a
  // watermark, which can only name an instant and would drag every row sharing it
  // along. When this page emitted no session, the position the caller handed in
  // is carried forward unchanged.
  let nextSessionKey: McpChangesSessionKey | null = cursor?.sessionKey ?? null;
  for (const candidate of emitted) {
    const key = sessionKeyOf.get(candidate);
    if (key !== undefined) {
      nextSessionKey = key;
    }
  }

  const nextCursor: McpChangesCursor = {
    v: MCP_CHANGES_CURSOR_VERSION,
    watermark: nextWatermark,
    bootId,
    baselines: finalBaselines,
    rebased: finalRebased,
    sessionKey: nextSessionKey,
  };

  // The cursor is BOUNDED, and the bound is enforced here rather than trusted to
  // the refs staying small: past `MCP_CHANGES_CURSOR_MAX_BYTES`, refs are dropped
  // in a deterministic (sorted) order, and every dropped project is recorded in
  // `rebased` so its next reading reports the loss instead of hiding it. When
  // even the marker list cannot fit, the marker list itself is trimmed from the
  // end — the earliest losses are the ones a caller is least able to act on.
  let encodedCursor = encodeChangesCursor(nextCursor);
  while (encodedCursor.length > MCP_CHANGES_CURSOR_MAX_BYTES) {
    const ids = Object.keys(nextCursor.baselines).sort();
    if (ids.length > 0) {
      const dropped = ids[ids.length - 1];
      delete nextCursor.baselines[dropped];
      if (!nextCursor.rebased.includes(dropped)) {
        nextCursor.rebased = [...nextCursor.rebased, dropped].sort();
      }
    } else if (nextCursor.rebased.length > 0) {
      nextCursor.rebased = nextCursor.rebased.slice(0, -1);
    } else {
      break;
    }
    encodedCursor = encodeChangesCursor(nextCursor);
  }

  return {
    cursor: encodedCursor,
    generatedAt: formatMcpTime(observedAt, () => observedAt),
    bootId,
    // Completeness now also requires every in-scope Quay source to be `ready`: a
    // `bootstrap` reading has no baseline to compare against and a `stale` one
    // cannot see what moved since it was taken, so neither hid "nothing".
    complete: gaps.length === 0 && !truncated && sources.every((source) => source.state === 'ready'),
    events: emitted.map((candidate) => candidate.event),
    gaps,
    sources,
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
        type: z.enum(['db.sessions', 'mem.runs', 'mem.approvals', 'quay.cache', 'quay.index', 'git']),
        observedAt: changesTimeSchema,
        ageMs: z.number(),
      }),
      // Optional and additive: only a Quay task event carries either, and an
      // older reader that ignores them still parses every field it knew.
      transition: z.object({ from: z.string().nullable(), to: z.string().nullable() }).optional(),
      atSource: z.enum(['record.updatedAt', 'index.observedAt']).optional(),
    }),
  ),
  gaps: z.array(
    z.object({
      kind: z.enum(MCP_CHANGES_KINDS),
      reason: z.string(),
      state: z.enum(MCP_CHANGES_SOURCE_STATES).optional(),
    }),
  ),
  sources: z.array(
    z.object({
      kind: z.literal('quay_task'),
      project: z.string(),
      state: z.enum(MCP_CHANGES_SOURCE_STATES),
      coverage: z.literal('full'),
      taskCount: z.number(),
      observedAt: changesTimeSchema.nullable(),
      ageMs: z.number().nullable(),
    }),
  ),
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
