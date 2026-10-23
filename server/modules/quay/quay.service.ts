import path from 'node:path';

import type {
  QuayAdrCounts,
  QuayConfigIssueCounts,
  QuayDriverState,
  QuayDriverSummary,
  QuayFanInAttemptSummary,
  QuayFanInSummary,
  QuayGanttInterval,
  QuayGanttLanes,
  QuayGanttUnavailableReason,
  QuayGoalBreakdown,
  QuayGoalCounts,
  QuayInFlightPhase,
  QuayInFlightTask,
  QuayListItem,
  QuaySnapshot,
  QuaySuiteState,
  QuayTaskCounts,
  QuayTestRoundSummary,
  QuayTestsSummary,
} from '@/shared/types.js';

import {
  createQuayFleetCliWallReader,
  createQuayUriResolver,
  type QuayFleetWallReader,
} from './quay-uri-resolve.js';
import type { QuayFleetAvailability, QuayFleetProjectIdResolver } from './quay-fleet-project-id.js';

export type {
  QuayAdrCounts,
  QuayConfigIssueCounts,
  QuayDriverState,
  QuayDriverSummary,
  QuayFanInAttemptSummary,
  QuayFanInSummary,
  QuayGanttInterval,
  QuayGanttLanes,
  QuayGanttUnavailableReason,
  QuayGoalBreakdown,
  QuayGoalCounts,
  QuayInFlightPhase,
  QuayInFlightTask,
  QuayListItem,
  QuaySnapshot,
  QuaySuiteState,
  QuayTaskCounts,
  QuayTestRoundSummary,
  QuayTestsSummary,
};


/**
 * Why a quay invocation failed, at the granularity the panel reports it. Each
 * member maps to its own remedy, so the frontend can tell "the CLI is not
 * installed for this project" apart from "the process timed out" instead of
 * showing one generic "quay did not answer":
 *
 * - `entrypoint-missing` — no executable at `<projectRoot>/.quay/plugin/bin/quay`
 *   and no bare `quay` on `PATH`; the remedy is running `/quay:init` in the project.
 * - `entrypoint-not-executable` — the project entrypoint exists but lacks the
 *   execute permission bit, so it cannot be spawned.
 * - `timeout` — the child exceeded the per-command wall-clock bound and was killed.
 * - `nonzero-exit` — the child ran and exited non-zero (or wrote to stderr).
 * - `spawn-error` — any other failure to start the child (an unexpected errno).
 */
export type QuayCommandFailureKind =
  | 'entrypoint-missing'
  | 'entrypoint-not-executable'
  | 'timeout'
  | 'nonzero-exit'
  | 'spawn-error';

/**
 * Outcome of one quay CLI invocation, normalized so callers never have to read
 * child-process internals. `error` is set only when the command was refused
 * locally (not on the whitelist) or the process could not be started at all.
 */
export type QuayCommandResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  /**
   * Classification of a failure, set whenever `ok` is false other than for a
   * local whitelist refusal (which never spawns a child). Consumers branch on
   * this field rather than string-matching `error`, so the four failure
   * situations the panel distinguishes stay distinguishable end to end.
   */
  failureKind?: QuayCommandFailureKind;
};

/**
 * The injected child-process boundary. It always receives an argument array
 * (never a shell string) and a wall-clock bound, so the only way a caller can
 * influence what runs is through arguments that `runQuayCommand` has already
 * matched against the read-only whitelist.
 *
 * `cwd` is always the target project's root (the service passes the project's
 * `projectPath`). It is both the child's working directory and the base under
 * which the adapter resolves the project-scoped quay entrypoint, so a project
 * pinned to a particular quay version is driven by that project's own CLI.
 */
export type QuayCommandRunner = (
  cwd: string,
  args: readonly string[],
  options: { timeoutMs: number },
) => Promise<QuayCommandResult>;

/**
 * The injected read-only filesystem boundary for quay's carrier files (the suite
 * state and the two JSONL histories). It exposes only byte-range and whole-file
 * *reads*, so the panel can never write through it, and every path is joined
 * under the project root by the service rather than accepted from a request. The
 * byte-range read is what lets `readCarrierFileTail` stream a bounded window from
 * the end of a multi-megabyte history instead of materialising the whole file.
 */
export type QuayFileReader = {
  /** Byte length of the file, or `null` when it does not exist or cannot be stat-ed. */
  size(filePath: string): Promise<number | null>;
  /** Reads up to `length` bytes starting at byte `position`, decoded as UTF-8; shorter near EOF. */
  readChunk(filePath: string, position: number, length: number): Promise<string>;
  /** Reads a small file fully as UTF-8 text; used only for the tiny suite-state JSON. */
  readText(filePath: string): Promise<string>;
};







/** How many `recent` rows each detail list keeps; the cap the panel copy promises. */
export const QUAY_RECENT_LIST_LIMIT = 10;

/**
 * How long a project's compact task status index stays fresh. Past this the index
 * is reported `stale` — the previous reading is still SERVED, aged and labelled,
 * which is what lets a reader tell "the server has not looked lately" from "the
 * server has never looked" without spawning a CLI to find out.
 */
export const QUAY_TASK_INDEX_TTL_MS = 120_000;

/** The minimum interval between two index loads for the SAME project. */
export const QUAY_TASK_INDEX_MIN_INTERVAL_MS = 60_000;

/**
 * How many projects may load their index at once, across the whole process. A
 * burst of readers over a cold workspace is bounded to this many `quay` children
 * rather than one per project.
 */
export const QUAY_TASK_INDEX_MAX_CONCURRENT_LOADS = 2;

/**
 * The largest index stdout accepted. The quay repository's own reading is about
 * 1.36 MB; this ceiling is far above any real store and far below the point where
 * a single stdout would be a memory problem, and an over-size reading is refused
 * whole rather than half-applied.
 */
export const QUAY_TASK_INDEX_MAX_STDOUT_BYTES = 8 * 1024 * 1024;

/** How much of a task title the compact index keeps. */
export const QUAY_TASK_INDEX_TITLE_LIMIT = 80;

/**
 * How long one project's fleet-summary reading stays fresh. The summary is polled by
 * the sidebar; inside this window a repeat request must cost zero CLI spawns. Two
 * minutes is long enough that a busy front end polls the store at most a few times a
 * minute, and short enough that a flipped task reaches the badge promptly.
 */
export const QUAY_FLEET_SUMMARY_TTL_MS = 120_000;

/**
 * How many projects the fleet summary may read at once. Measured on a real fleet, four
 * concurrent `quay` reads take roughly the wall clock of one (the host absorbs the
 * parallelism) but their CPU and memory grow linearly, so this bounds the fan-out
 * rather than letting a twenty-project workspace spawn twenty children in one burst.
 */
export const QUAY_FLEET_SUMMARY_MAX_CONCURRENT_PROJECTS = 4;

/**
 * One task row of the compact status index: what `changes` needs to notice a
 * transition and to say when it happened, and nothing else. The whole task
 * document (body, children, extra) is deliberately absent — the index is built
 * from `task list --json --no-body` precisely so a status poll cannot carry one.
 */
export type QuayTaskStatusRow = {
  taskId: string;
  status: string;
  /** The record's own last-write instant as ISO-8601, or `null` when it carries none. */
  updatedAt: string | null;
  /** The task title, truncated to {@link QUAY_TASK_INDEX_TITLE_LIMIT} characters. */
  title: string;
};

/**
 * Where a project's task status index stands. `cold`/`warming` mean nothing has
 * ever been read (`warming` = a load is in flight); `ready`/`stale` are a real
 * reading inside / past its freshness window; `error` means the last load failed.
 */
export type QuayTaskIndexState = 'cold' | 'warming' | 'ready' | 'stale' | 'error';

/**
 * One project's compact task status index as a READER sees it — produced without
 * ever loading, so a read path can never be made to wait on a subprocess.
 */
export type QuayTaskIndexReading = {
  state: QuayTaskIndexState;
  /** Always `full`: every task the store has, never a page of ten. */
  coverage: 'full';
  /** How many tasks the last successful load saw (0 before one succeeds). */
  taskCount: number;
  /** When the last successful load observed the index (epoch ms), or `null`. */
  observedAtMs: number | null;
  /** Every task's last known status, keyed by task id. Empty until the first success. */
  tasks: ReadonlyMap<string, QuayTaskStatusRow>;
  /** Why the last load failed; present only while `state` is `error`. */
  reason?: string;
};



//----------------- FLEET SUMMARY ------------

/**
 * The task status counts one project contributes to the fleet summary. This is the
 * `--no-body` reading, narrowed to the five numbers the sidebar badge renders, so a
 * fleet request can never carry a task body (contrast {@link QuayTaskCounts}, whose
 * `byStatus`/`recent` serve the Tier-2 panel).
 */
export type QuayFleetTaskCounts = {
  total: number;
  todo: number;
  ready: number;
  needsHuman: number;
  done: number;
};

/**
 * One project's entry in the fleet summary. `driver`, `tasks` and `error` describe a
 * single reading taken together, so a consumer never mixes sections of two reads.
 */
export type QuayFleetProjectSummary = {
  projectId: string;
  projectPath: string;
  /**
   * The project's quay-fleet REGISTRY id — the only project segment a `quay://` reference may
   * mint. `null` means the root is not registered in the fleet, so this project declares no
   * addressable objects (falling back to the CloudCLI UUID would mint a reference the fleet
   * cannot dereference).
   */
  fleetProjectId: string | null;
  /**
   * The worker driver reading, or `{ state: 'unavailable' }` when that command did not
   * answer. `unavailable` is deliberately its own state rather than `stale`: a failed
   * read is "no reading", not the observation that the driver is not alive.
   */
  driver: { state: QuayDriverState | 'unavailable' };
  tasks: QuayFleetTaskCounts;
  /** `true` when this entry was served from the per-project TTL cache. */
  cached: boolean;
  /** Why this project's reading failed, or `null` when both commands answered. */
  error: string | null;
};

/**
 * The eager, cheap cross-project reading behind the sidebar's task-count badges:
 * driver state plus task status counts for every project with a `.quay/config.yml`.
 * It deliberately carries no goal, in-flight or gantt section — those stay on the
 * lazy Tier-2 snapshot, which is only read when a project is opened.
 */
export type QuayFleetSummary = {
  projects: QuayFleetProjectSummary[];
  /**
   * Whether this host could ask quay-fleet at all.
   *
   * A summary read while the CLI is missing still carries every project's quay CLI reading
   * (driver + task counts); what it cannot carry is a registry identity for ANY of them. The
   * UI must say that once, as "quay-fleet is not available (set QUAY_FLEET_BIN)", instead of
   * rendering each tile as an individually unregistered project.
   */
  fleet: QuayFleetAvailability;
  generatedAt: string;
  /** How long one project's cached reading stays fresh. */
  ttlPerProjectMs: number;
  /** `true` only when every project in the response came from the TTL cache. */
  cached: boolean;
};



















/**
 * The windows the Loop pulse card offers, in hours — quay's own set, with quay's own default.
 * A window is a *data* filter (the interval set is re-selected), never a visual zoom.
 */
export const QUAY_GANTT_WINDOW_HOURS = [1, 3, 6, 12] as const;
export const DEFAULT_QUAY_GANTT_WINDOW_HOURS = 3;

/**
 * Coerces a requested window to one this card offers, falling back to the default.
 *
 * The set is closed deliberately: the window drives how far back the history read and the
 * packing go, and the card has a button for exactly these four values. Anything else — a
 * negative, a fraction, a string from a stray query param — reads as "not a window I offer"
 * rather than being honoured, so a malformed request can never widen the read.
 */
export function normalizeGanttWindowHours(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    return DEFAULT_QUAY_GANTT_WINDOW_HOURS;
  }
  return (QUAY_GANTT_WINDOW_HOURS as readonly number[]).includes(parsed)
    ? parsed
    : DEFAULT_QUAY_GANTT_WINDOW_HOURS;
}

/**
 * Projects `quay lanes --json`'s payload onto the card's `QuayGanttLanes` contract.
 *
 * `null` — never a `{lanes: [], overflow: 0}` object — when the payload is not the documented
 * shape. The two are different readings and must stay so: an empty lane set is a real answer
 * ("nothing ran in this window"), so presenting an unreadable payload as one would turn a
 * failed read into a chart that merely looks idle. The verb keeps the same distinction at the
 * process boundary — a failed read exits non-zero and prints no document at all — and this
 * keeps it again at the object boundary.
 *
 * The collector relays the verb's output verbatim: `quay lanes` merges quay's live telemetry
 * with its worker-outcome history and packs the result onto the fixed five lanes using quay's
 * OWN kernel, so there is no second implementation of that algorithm here to drift from the
 * one the dashboard's "Loop pulse" card plots.
 */
export function readGanttLanes(value: unknown): QuayGanttLanes | null {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  const payload = value as { windowHours?: unknown; nowMs?: unknown; lanes?: unknown; overflow?: unknown };
  if (
    typeof payload.windowHours !== 'number' || !Number.isFinite(payload.windowHours)
    || typeof payload.nowMs !== 'number' || !Number.isFinite(payload.nowMs)
    || typeof payload.overflow !== 'number' || !Number.isFinite(payload.overflow)
    || !Array.isArray(payload.lanes)
  ) {
    return null;
  }

  const lanes: QuayGanttInterval[][] = [];
  for (const lane of payload.lanes) {
    if (!Array.isArray(lane)) {
      return null;
    }
    const intervals: QuayGanttInterval[] = [];
    for (const entry of lane) {
      const interval = readGanttInterval(entry);
      if (interval === null) {
        return null;
      }
      intervals.push(interval);
    }
    lanes.push(intervals);
  }

  return { windowHours: payload.windowHours, nowMs: payload.nowMs, lanes, overflow: payload.overflow };
}

/** One lane bar, or `null` when any documented field is missing or mistyped. */
function readGanttInterval(value: unknown): QuayGanttInterval | null {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.taskId !== 'string'
    || typeof entry.runId !== 'string'
    || typeof entry.startMs !== 'number' || !Number.isFinite(entry.startMs)
    || typeof entry.endMs !== 'number' || !Number.isFinite(entry.endMs)
  ) {
    return null;
  }
  return {
    taskId: entry.taskId,
    runId: entry.runId,
    startMs: entry.startMs,
    endMs: entry.endMs,
    phase: typeof entry.phase === 'string' ? entry.phase : null,
    finalState: typeof entry.finalState === 'string' ? entry.finalState : null,
    fanInOutcome: typeof entry.fanInOutcome === 'string' ? entry.fanInOutcome : null,
  };
}













/** Tier-1 reading: whether a project directory carries a `.quay/config.yml`. */
export type QuayProjectStatus = {
  projectId: string;
  projectPath: string;
  hasQuayConfig: boolean;
};

const QUAY_DRIVER_KINDS = ['promotion', 'worker', 'outer', 'quality', 'meta', 'goal'] as const;

/**
 * Leading argv of the Loop pulse card's `lanes` read — `quay lanes --json …`.
 *
 * ⛔ `--json` must stay FIRST, and this is not a style choice. quay's dispatcher splits the
 * argv as `[cmd, sub, ...rest]` and runs `parseFlags` over `rest` only, so whatever token
 * follows `lanes` is swallowed as the sub-command and never reaches the flag parser. Written
 * the other way round (`lanes --window-hours 12 --json`) the verb silently falls back to the
 * default 3 h window — measured against quay 0.19.0's real CLI, whose own help line
 * (`quay lanes [--json] [--window-hours N] [--root <path>]`) does not disclose the ordering.
 * With `--json` first, `sub` is a harmless marker the `lanes` handler ignores and both
 * options parse.
 */
const QUAY_LANES_PREFIX = ['lanes', '--json'] as const;

/**
 * The complete read-only command whitelist.
 *
 * `runQuayCommand` accepts an argv only when it equals one of these arrays
 * element-by-element, so no caller — and therefore no frontend request — can
 * reach a write command (`task create/edit/check`, `driver start/stop`,
 * `gate run`, `promote/retreat`, …). Widening the display surface means adding
 * an entry here; every entry must stay a read-only verb.
 *
 * `server status --json` is deliberately absent. It was the one source of the
 * panel's optional dashboard link, but answering it costs ~4 s of its own
 * driver-kind subprocesses — for one `web` host/port that the `.quay/server.json`
 * carrier already records. The dashboard reading now reads that carrier and
 * probes the recorded address directly, so the command is no longer reachable at
 * all rather than merely uncalled.
 */
export const QUAY_READ_ONLY_COMMANDS: readonly (readonly string[])[] = [
  ['config', 'validate', '--json'],
  ['task', 'list', '--json'],
  // The compact status index behind `changes` (AC-348): the same read with the
  // whole task document dropped. It is a SEPARATE exact-match entry rather than a
  // flag appended to the row above, so "no body" is the only widening this list
  // has taken and every other flag combination is still refused by equality.
  ['task', 'list', '--json', '--no-body'],
  ['goal', 'list', '--json'],
  ['adr', 'list', '--json'],
  ...QUAY_DRIVER_KINDS.map((kind) => ['driver', 'status', '--kind', kind, '--json']),
  // The Loop pulse gantt's packed lanes, printed by quay's own read-only `lanes` verb — which
  // merges quay's live telemetry with its worker-outcome history and packs the result onto the
  // fixed five lanes itself, so this service neither merges nor packs. The window is an enum,
  // so each offered value is its own exact-match entry rather than a prefix rule: the
  // whitelist stays an equality check, and a stray window can never widen the read.
  ...QUAY_GANTT_WINDOW_HOURS.map((hours) => [...QUAY_LANES_PREFIX, '--window-hours', String(hours)]),
];

/** True when `args` is exactly one of the whitelisted read-only commands. */
export function isReadOnlyQuayCommand(args: readonly string[]): boolean {
  return QUAY_READ_ONLY_COMMANDS.some(
    (allowed) =>
      allowed.length === args.length
      && allowed.every((value, index) => value === args[index]),
  );
}

type QuayServiceDependencies = {
  fileExists(filePath: string): boolean;
  resolveProjectPathById(projectId: string): string | null;
  /**
   * Every project the composition knows about, as (id, absolute path) pairs. The fleet
   * summary is the only reader: it must fan out over ALL projects rather than a request
   * roster, so it cannot be built from `resolveProjectPathById`. Optional so a
   * composition without a project registry yields an empty summary instead of a crash.
   */
  listProjects?(): readonly { projectId: string; projectPath: string }[];
  runCommand: QuayCommandRunner;
  /** Read-only filesystem boundary for the `.quay/` carrier files behind the Tests and Fan-in cards. */
  readFile: QuayFileReader;
  /**
   * Probes a project's `quay serve` web face and resolves `true` only when it answers.
   * Injected so the dashboard reading is exercised without opening a socket, and so the
   * composition root can pick the transport (an in-process HTTP `GET /health`). It must
   * never reject: an unreachable dashboard is a `null` link, not an error.
   */
  probeWebService(host: string, port: number): Promise<boolean>;
  now(): number;
  /** How long a Tier-2 snapshot stays fresh; requests inside the window reuse it. */
  snapshotTtlMs: number;
  /** Per-command subprocess timeout. */
  commandTimeoutMs: number;
  /**
   * The fleet wall read port (quay-fleet's `wall resolve` / `wall summary`) behind the
   * `quay://` dereference entry point. OPTIONAL so every existing criterion composing this
   * service is untouched: `undefined` builds the configured CLI adapter from
   * {@link QUAY_FLEET_BIN_ENV}; `null` disables the fleet path (task references read from
   * the snapshot); an injected reader is the seam the dereference criteria use.
   */
  fleetWallReader?: QuayFleetWallReader | null;
  /**
   * The CloudCLI project id → quay-fleet registry id join (`quay-fleet-project-id.ts`), behind
   * the wall's project segment and the per-project `fleetProjectId` reading. OPTIONAL so a
   * composition that does not run a fleet still works: absent means every project is
   * unregistered (`fleetProjectId: null`), which the UI renders as 「未登记到 quay-fleet」
   * rather than guessing an identity.
   */
  fleetProjectIdResolver?: QuayFleetProjectIdResolver | null;
};

type QuaySnapshotOptions = {
  /** Bypass the TTL cache for the manual refresh button. */
  forceRefresh?: boolean;
  /**
   * Loop pulse time window, in hours — the raw query value, coerced by
   * `normalizeGanttWindowHours` (it arrives as a string from the query, and an unrecognised
   * value must fall back to the default rather than being honoured).
   */
  windowHours?: unknown;
};

type QuayCacheEntry = {
  expiresAt: number;
  snapshot: QuaySnapshot;
};

function parseJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }
  return JSON.parse(trimmed);
}

/**
 * Parses a command's stdout when it may legitimately be empty. The fleet summary reads
 * the driver status this way: an absent body is "no reading" (reported as `unavailable`
 * by the caller), never a parse error that would hide the project from the response.
 */
function parseJsonOrNull(stdout: string): unknown {
  if (!stdout.trim()) {
    return null;
  }
  try {
    return parseJson(stdout);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readCount(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

/**
 * Projects a `task list --json` / `goal list --json` / `adr list --json` array
 * into the panel's detail rows: at most `QUAY_RECENT_LIST_LIMIT` entries, most
 * recently updated first (`updatedAt` descending, ties broken by id ascending so
 * the order is deterministic even when timestamps collide — and a row with no
 * timestamp is the *least* recent, so it sorts last rather than first).
 *
 * Each row keeps the ISO-8601 form of the very epoch it was ranked by, so the
 * order the reader sees is the order they can check. Records without a string id
 * are skipped rather than rendered as blank rows.
 */
function summarizeRecentItems(value: unknown): QuayListItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => asRecord(item))
    .filter((record): record is Record<string, unknown> => record !== null && typeof record.id === 'string')
    .map((record) => ({
      record,
      epochMs: readUpdatedAtEpochMs(record.updatedAt),
    }))
    .sort((a, b) => {
      // Descending by epoch; a missing timestamp has no instant to place, so it
      // goes after every dated row. `null`-vs-`null` falls through to the id
      // tie-break rather than comparing two absent numbers.
      if (a.epochMs !== b.epochMs) {
        if (a.epochMs === null) return 1;
        if (b.epochMs === null) return -1;
        return b.epochMs - a.epochMs;
      }
      return String(a.record.id).localeCompare(String(b.record.id));
    })
    .slice(0, QUAY_RECENT_LIST_LIMIT)
    .map(({ record, epochMs }) => ({
      id: String(record.id),
      title: typeof record.title === 'string' ? record.title : '',
      status: typeof record.status === 'string' ? record.status : 'unknown',
      // `readUpdatedAtEpochMs` has already refused anything a `Date` cannot hold,
      // so this conversion cannot throw.
      updatedAt: epochMs === null ? null : new Date(epochMs).toISOString(),
    }));
}

function summarizeTasks(value: unknown): QuayTaskCounts | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const byStatus: Record<string, number> = {};
  for (const task of value) {
    const status = typeof asRecord(task)?.status === 'string' ? (asRecord(task)?.status as string) : 'unknown';
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }

  return {
    total: value.length,
    byStatus,
    ready: byStatus.ready ?? 0,
    needsHuman: byStatus['needs-human'] ?? 0,
    done: byStatus.done ?? 0,
    recent: summarizeRecentItems(value),
  };
}

/** The all-zero counts a fleet entry carries when its task read did not answer. */
const EMPTY_FLEET_TASK_COUNTS: QuayFleetTaskCounts = {
  total: 0,
  todo: 0,
  ready: 0,
  needsHuman: 0,
  done: 0,
};

/**
 * Narrows a `task list --json --no-body` array to the five counts the fleet badge
 * renders. Any status the store reports that is not one of those four is still
 * counted in `total` (the badge's "all tasks" figure) but has no bucket of its own.
 * A non-array body is not a task list at all, so the caller gets `null` and keeps the
 * error it already recorded rather than a fabricated zero reading.
 */
function summarizeFleetTaskCounts(value: unknown): QuayFleetTaskCounts | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const counts = { ...EMPTY_FLEET_TASK_COUNTS, total: value.length };
  for (const task of value) {
    const status = asRecord(task)?.status;
    if (status === 'todo') counts.todo += 1;
    else if (status === 'ready') counts.ready += 1;
    else if (status === 'needs-human') counts.needsHuman += 1;
    else if (status === 'done') counts.done += 1;
  }
  return counts;
}

function summarizeGoals(value: unknown): QuayGoalCounts | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const byStatus: Record<string, number> = {};
  for (const goal of value) {
    const status = typeof asRecord(goal)?.status === 'string' ? (asRecord(goal)?.status as string) : 'unknown';
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }

  return {
    total: value.length,
    achieved: byStatus.achieved ?? 0,
    breakdown: { byStatus, recent: summarizeRecentItems(value) },
  };
}

function summarizeAdrs(value: unknown): QuayAdrCounts | null {
  return Array.isArray(value) ? { total: value.length, recent: summarizeRecentItems(value) } : null;
}

/** Reads a non-empty string field from an untyped JSON record, or `null`. */
function readNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Reads a finite number field from an untyped JSON record, or `null` for absent/non-numeric values. */
function readNullableNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
}

/**
 * A detail row's `updatedAt` as epoch milliseconds, or `null` when the record
 * carries no usable timestamp.
 *
 * `null` covers every shape that is not a real instant: an absent field, an
 * explicit `null`, a non-numeric string, `NaN`/`Infinity` — and a finite number
 * outside the range a `Date` can represent (`1e20`), which would otherwise throw
 * on `toISOString()` and take the whole snapshot down with it. Reading the sort
 * key and the displayed value from this one function is what keeps the list's
 * order and the time printed beside each row the same reading.
 */
function readUpdatedAtEpochMs(value: unknown): number | null {
  const epochMs = readNullableNumber(value);
  if (epochMs === null) {
    return null;
  }

  return Number.isNaN(new Date(epochMs).getTime()) ? null : epochMs;
}

/** Carrier files read under the project's `.quay/` directory by the Tests and Fan-in cards. */
const QUAY_SUITE_STATE_FILE = 'full-suite-state.json';
const QUAY_ROUND_HISTORY_FILE = 'verification-round.jsonl';
const QUAY_WORKER_OUTCOME_FILE = 'worker-outcome.jsonl';
/**
 * The worker driver's per-round heartbeat carrier. `quay serve`'s Live card reads this
 * same file for "which task is running"; this service reads its newest record only to supply
 * the In-flight card's supplementary fields (heartbeat, dispatch instant, worker pid) on top
 * of the task set the `lanes` reading already names.
 */
const QUAY_WORKER_ROUND_FILE = 'worker-round.jsonl';

/**
 * Bytes read per step when streaming a carrier file's tail. 64 KiB holds ten
 * lines of every carrier here except the per-file round history (whose lines run
 * tens of KB); there the window doubles a couple of times, still a few hundred KB
 * against a 16 MB file — never the whole file.
 */
const CARRIER_TAIL_WINDOW_BYTES = 64 * 1024;

/** Number of JSONL records a tail window currently holds, ignoring a possibly split leading line and blank segments. */
function countTailRecords(text: string, hasPartialLeadingLine: boolean): number {
  const lines = text.split('\n');
  if (hasPartialLeadingLine) {
    lines.shift();
  }
  return lines.filter((line) => line.trim() !== '').length;
}

/**
 * Reads a bounded trailing window of a JSONL carrier file and returns its non-blank
 * lines in file order. The byte window starts at `CARRIER_TAIL_WINDOW_BYTES` and doubles
 * until it holds at least `minLines` records or reaches the start of the file, so a
 * multi-megabyte history costs a fraction of its bytes rather than a whole-file read. A
 * non-zero window start can split one leading line in half, which is dropped (and not
 * counted by `countTailRecords`).
 */
async function readCarrierTailLines(
  reader: QuayFileReader,
  filePath: string,
  minLines: number,
): Promise<string[]> {
  if (minLines <= 0) {
    return [];
  }

  const size = await reader.size(filePath);
  if (size === null || size <= 0) {
    return [];
  }

  let windowBytes = Math.min(CARRIER_TAIL_WINDOW_BYTES, size);
  let text = '';
  let start = 0;
  // Grow the trailing window until it holds minLines records (a non-zero start can
  // split one leading line in half, which countTailRecords drops).
  for (;;) {
    start = Math.max(0, size - windowBytes);
    text = await reader.readChunk(filePath, start, size - start);
    if (start === 0 || countTailRecords(text, true) >= minLines) {
      break;
    }
    windowBytes *= 2;
  }

  const lines = text.split('\n');
  if (start > 0) {
    lines.shift();
  }

  return lines.filter((line) => line.trim() !== '');
}

/**
 * Streams the last `maxLines` newline-delimited JSON records out of a carrier
 * file without materialising the whole file: it reads a bounded byte window from
 * the end through the injected reader and, when that window holds too few
 * complete lines, doubles the window and re-reads. A 16 MB round history
 * therefore costs a few hundred KB of reads rather than 16 MB, and the read is a
 * byte-range read rather than a whole-file `readFile`.
 *
 * Malformed lines (a torn tail, a non-JSON record) are skipped, so a partially
 * written file degrades to fewer rows instead of failing the whole snapshot.
 */
export async function readCarrierFileTail(
  reader: QuayFileReader,
  filePath: string,
  maxLines: number,
): Promise<unknown[]> {
  const lines = await readCarrierTailLines(reader, filePath, maxLines);
  return lines
    .slice(-maxLines)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
}

/**
 * Reads the LAST parseable JSONL record from a carrier file's tail, or `null` when the
 * file is absent/empty or carries no parseable record at all.
 *
 * Used for the round heartbeat carrier, where only the newest record matters — so,
 * unlike {@link readCarrierFileTail}, the caller wants "the most recent readable row"
 * rather than a fixed-size history. A malformed trailing line (a torn append) is skipped
 * in favour of the previous parseable record in the same bounded window instead of
 * blanking the reading.
 */
async function readLastCarrierRecord(reader: QuayFileReader, filePath: string): Promise<unknown | null> {
  const lines = await readCarrierTailLines(reader, filePath, 1);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]) as unknown;
    } catch {
      // A torn/malformed line: keep scanning earlier records in the same window.
    }
  }
  return null;
}

/** Projects a parsed `full-suite-state.json` body; `null` when it carries no usable `state` string. */
function summarizeSuiteState(value: unknown): QuaySuiteState | null {
  const record = asRecord(value);
  const state = record ? readNullableString(record.state) : null;
  if (!record || !state) {
    return null;
  }

  return {
    state,
    runner: readNullableString(record.runner),
    scope: readNullableString(record.scope),
    startedAt: readNullableString(record.startedAt),
    finishedAt: readNullableNumber(record.finishedAt),
    durationMs: readNullableNumber(record.durationMs),
    laneCount: readNullableNumber(record.laneCount),
    commit: readNullableString(record.commit),
    taskId: readNullableString(record.taskId),
    runId: readNullableString(record.runId),
  };
}

/**
 * Reads `.quay/full-suite-state.json` and projects it to the Tests card's
 * "current" reading. A missing or unparseable file reads as `null` — the same
 * "nothing is running" state as a dashboard with no suite — so it is never
 * recorded as a warning.
 */
export async function readCurrentSuiteState(
  reader: QuayFileReader,
  filePath: string,
): Promise<QuaySuiteState | null> {
  let text: string;
  try {
    text = await reader.readText(filePath);
  } catch {
    return null;
  }

  try {
    return summarizeSuiteState(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

/** Projects round-history records to the panel's summary; the heavy `perFile` detail is deliberately dropped. */
function summarizeTestRounds(value: unknown): QuayTestRoundSummary[] {
  return asArray(value).flatMap((item) => {
    const record = asRecord(item);
    const state = record ? readNullableString(record.state) : null;
    if (!record || !state) {
      return [];
    }

    return [
      {
        round: readCount(record.round),
        startedAt: readNullableString(record.startedAt),
        durationMs: readNullableNumber(record.durationMs),
        pass: readNullableNumber(record.pass),
        fail: readNullableNumber(record.fail),
        tests: readNullableNumber(record.tests),
        state,
      },
    ];
  });
}

/** Keeps only the tasks whose outcome record carries a `mechanical_fan_in` block, projected to the Fan-in card's fields. */
function summarizeFanInAttempts(value: unknown): QuayFanInAttemptSummary[] {
  return asArray(value).flatMap((item) => {
    const record = asRecord(item);
    const fanIn = record ? asRecord(record.mechanical_fan_in) : null;
    const task = record ? readNullableString(record.task) : null;
    const outcome = fanIn ? readNullableString(fanIn.outcome) : null;
    if (!task || !outcome) {
      return [];
    }

    return [
      {
        task,
        outcome,
        lockAcquireEpoch: readNullableNumber(fanIn?.lockAcquireEpoch),
        lockReleaseEpoch: readNullableNumber(fanIn?.lockReleaseEpoch),
      },
    ];
  });
}

/**
 * Reads a round-carrier field persisted under its snake_case key (e.g. `in_flight_task_starts`)
 * or, when that is absent, the camelCase spelling the in-memory round options use (e.g.
 * `inFlightTaskStarts`). Quay's `writeRound` builds each record from camelCase options but
 * persists it through a snake_case projection, and this reading's own notes referenced the
 * option spelling; accepting both keeps a fixture written either way reading identically.
 */
function readRoundField(record: Record<string, unknown>, snakeCase: string, camelCase: string): unknown {
  return record[snakeCase] !== undefined ? record[snakeCase] : record[camelCase];
}

/**
 * Narrows a lane interval's `phase` string to quay's published in-flight phases. The interval
 * is non-null (it was selected for being in flight), so the only question is which phase; any
 * value outside quay's published set — an older/newer kernel spelling — reads as the neutral
 * `implementing` rather than being misreported as a specific state.
 */
function narrowInFlightPhase(value: string | null): QuayInFlightPhase {
  return value === 'fan-in' || value === 'awaiting-land' || value === 'landed' ? value : 'implementing';
}

/**
 * The in-flight intervals of a packed lane set — those quay's kernel marks as still running
 * (`phase` non-null; a finished interval carries `finalState` instead). This is exactly the set
 * the Loop pulse gantt plots, so the In-flight card takes its task list from here and the two
 * readings share one source. De-duplicated by task id (a task dispatched more than once inside
 * the window keeps its latest interval), preserving each task's interval for phase and start.
 */
function inFlightIntervals(lanes: QuayGanttLanes): QuayGanttInterval[] {
  const byTask = new Map<string, QuayGanttInterval>();
  for (const lane of lanes.lanes) {
    for (const interval of lane) {
      if (interval.phase === null) {
        continue;
      }
      const existing = byTask.get(interval.taskId);
      if (!existing || interval.startMs > existing.startMs) {
        byTask.set(interval.taskId, interval);
      }
    }
  }
  return [...byTask.values()];
}

/**
 * Projects the in-flight reading onto the snapshot's `inFlight` list.
 *
 * The task set and each row's `phase` come from the packed lane set (`inFlightIntervals`) — the
 * SAME reading the Loop pulse gantt plots — so a landed task (which quay's `readLive` drops and
 * the gantt therefore never draws) can never appear in the card, and the two readings cannot
 * disagree about which tasks are running. The round carrier is consulted only for the fields
 * the lanes do not carry: the ISO dispatch instant, the heartbeat and the worker pid.
 *
 * Returns `null` when there is no lane reading at all: with no lane set there is no authoritative
 * in-flight set to name, so the card reads "no reading" rather than inventing one from the round
 * carrier. A usable lane set always yields an array — `[]` when nothing is in flight — so "no
 * reading" and "nothing running" stay distinguishable.
 *
 * `roundRecord` is the newest `.quay/worker-round.jsonl` record, or `null` when the carrier is
 * absent/unreadable; when it carries no heartbeat the lane clock's own read instant stands in,
 * which never reads as stale because it is the instant the reading was taken.
 */
function summarizeInFlightTasks(
  ganttLanes: QuayGanttLanes | null,
  roundRecord: unknown,
): QuayInFlightTask[] | null {
  if (ganttLanes === null) {
    return null;
  }

  const record = asRecord(roundRecord);
  // `ts` is the persisted heartbeat key; `at` is the option spelling `writeRound` is
  // called with. Either names the same instant.
  const lastHeartbeat = record ? readNullableString(readRoundField(record, 'ts', 'at')) : null;
  const starts = record ? asRecord(readRoundField(record, 'in_flight_task_starts', 'inFlightTaskStarts')) : null;
  const workerPid = record ? readNullableNumber(record.pid) : null;
  const readAt = new Date(ganttLanes.nowMs).toISOString();

  return inFlightIntervals(ganttLanes).map((interval) => ({
    taskId: interval.taskId,
    phase: narrowInFlightPhase(interval.phase),
    startedAt: (starts ? readNullableString(starts[interval.taskId]) : null) ?? new Date(interval.startMs).toISOString(),
    lastHeartbeat: lastHeartbeat ?? readAt,
    workerPid,
  }));
}

/**
 * The state carrier `quay serve` publishes under the project's `.quay/`: which services
 * its one server process hosts and on which host/port each is bound. Read directly in
 * place of `quay server status --json`, which answers the same question only after
 * serially spawning one subprocess per driver kind — several seconds of work for the
 * single `web` entry the panel links to.
 */
const QUAY_SERVER_STATE_FILE = 'server.json';

/**
 * Resolves the `web` service's recorded bind address from a parsed `.quay/server.json`
 * body, or `null` when there is no usable one: no `services` array, no `web` entry, or a
 * `web` entry without a non-empty `host` and a positive `port`.
 *
 * The carrier's own `up` flag is deliberately NOT consulted: it is a write-time claim, and
 * a killed server leaves it `true` on disk. Liveness is established by a live probe
 * instead, so a stale carrier cannot produce a link to a dashboard that is not there.
 */
function readWebServiceAddress(value: unknown): { host: string; port: number } | null {
  const web = asArray(asRecord(value)?.services)
    .map((service) => asRecord(service))
    .find((service) => service?.name === 'web');
  if (!web) {
    return null;
  }

  const host = typeof web.host === 'string' && web.host ? web.host : null;
  const port = readCount(web.port);
  if (!host || port <= 0) {
    return null;
  }

  return { host, port };
}

/**
 * The address to dial and link to for a recorded bind host. A wildcard binding
 * (`0.0.0.0` / `::` / `*`) is not itself a destination — it is reachable on loopback, and
 * a browser cannot open `http://0.0.0.0:…/`. quay's own `server status` probe makes the
 * same substitution before dialling.
 */
function probeAddress(host: string): string {
  return host === '0.0.0.0' || host === '::' || host === '*' ? '127.0.0.1' : host;
}

function summarizeConfigIssues(value: unknown): QuayConfigIssueCounts | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const errors = value.filter((issue) => asRecord(issue)?.severity === 'error').length;
  return { total: value.length, errors };
}

function summarizeDriver(value: unknown): QuayDriverSummary | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  // `alive`/`running` arrive as numbers (0/1) from `--json`; a driver that is
  // configured but not alive reads `stale`, which is the state the badge paints
  // differently from a live-but-idle driver.
  const alive = Boolean(readCount(record.alive));
  const running = Boolean(readCount(record.running));
  const state: QuayDriverState = !alive ? 'stale' : running ? 'running' : 'idle';

  return {
    state,
    alive,
    running,
    lastRecordAt: typeof record.last_record_ts === 'string' ? record.last_record_ts : null,
  };
}

/**
 * Creates the quay read-only display service.
 *
 * Every filesystem, clock and subprocess access is an explicit dependency so the
 * composition root binds production adapters while tests drive pure fakes. The
 * Tier-2 snapshot keeps an in-memory TTL cache plus an in-flight promise map, so
 * a burst of panel opens for one project spawns the CLI once rather than once per
 * request — the concurrency guard against a subprocess storm.
 */
export function createQuayService(dependencies: QuayServiceDependencies) {
  const snapshotCache = new Map<string, QuayCacheEntry>();
  const inFlightSnapshots = new Map<string, Promise<QuaySnapshot>>();
  // The Loop pulse reading is the ONLY section a window change invalidates, so it carries its
  // own cache keyed by (project, window) — see `loadGantt`.
  const ganttCache = new Map<string, { expiresAt: number; gantt: QuayGanttLanes | null; unavailable: QuayGanttUnavailableReason | null }>();
  const inFlightGantt = new Map<string, Promise<{ gantt: QuayGanttLanes | null; unavailable: QuayGanttUnavailableReason | null }>>();

  /**
   * The CloudCLI project id → fleet registry id join. A composition without a fleet answers
   * `null` for every project — the honest "nothing is registered here" reading that makes the
   * UI render 「未登记到 quay-fleet」 instead of minting a UUID reference the fleet cannot read.
   */
  const fleetProjectIds: QuayFleetProjectIdResolver = dependencies.fleetProjectIdResolver ?? {
    resolveFleetProjectId: async () => null,
    resolveFleetProject: async () => null,
    // Nothing was composed to ask the fleet with: that is "the CLI is not available here",
    // not "every project is unregistered".
    resolveFleetAvailability: async () => ({
      available: false,
      state: 'missing',
      binPath: null,
      version: null,
      contracts: null,
      reason: 'quay-fleet is not configured on this server (set QUAY_FLEET_BIN)',
    }),
  };

  /** Tier-1 detection: a pure path check, never a subprocess. */
  const detectQuayConfig = (projectPath: string): boolean =>
    dependencies.fileExists(path.join(projectPath, '.quay', 'config.yml'));

  /** Runs one whitelisted read-only command; refuses anything else without spawning. */
  const runQuayCommand = async (
    cwd: string,
    args: readonly string[],
  ): Promise<QuayCommandResult> => {
    if (!isReadOnlyQuayCommand(args)) {
      return {
        ok: false,
        code: null,
        stdout: '',
        stderr: '',
        error: `refused: "${args.join(' ')}" is not on the quay read-only command whitelist`,
      };
    }

    return dependencies.runCommand(cwd, args, { timeoutMs: dependencies.commandTimeoutMs });
  };

  // --- the compact task status index (AC-348) ---
  //
  // Deliberately NOT the snapshot cache above it. That cache is an entry that
  // EXPIRES TO NOTHING, which made "the panel has not looked for thirty seconds"
  // indistinguishable from "there is no reading at all". This index instead keeps
  // the last full reading and AGES it (`ready` → `stale`), so a reader can still
  // diff against it and can say how old it is.
  const taskIndex = new Map<
    string,
    { tasks: Map<string, QuayTaskStatusRow>; observedAtMs: number | null; error?: string }
  >();
  const taskIndexLoading = new Set<string>();
  const taskIndexLastStartedAt = new Map<string, number>();
  let taskIndexInFlight = 0;

  /** The one argv the index is read with; it is on {@link QUAY_READ_ONLY_COMMANDS}. */
  const QUAY_TASK_INDEX_COMMAND: readonly string[] = ['task', 'list', '--json', '--no-body'];

  const EMPTY_TASK_INDEX: ReadonlyMap<string, QuayTaskStatusRow> = new Map();

  /**
   * Projects a project's index for a reader, WITHOUT loading. The answer is the
   * last reading with its age (`ready` inside the freshness window, `stale` past
   * it), or `cold` / `warming` when nothing has ever landed, or `error` when the
   * last load failed — in which case the previous reading is still served, since a
   * failed REFRESH is not a lost one.
   */
  const readTaskIndex = (projectId: string): QuayTaskIndexReading => {
    const entry = taskIndex.get(projectId);
    const tasks = entry?.tasks ?? EMPTY_TASK_INDEX;
    const observedAtMs = entry?.observedAtMs ?? null;
    const base = { coverage: 'full' as const, taskCount: tasks.size, observedAtMs, tasks };
    if (entry?.error !== undefined) {
      return { ...base, state: 'error', reason: entry.error };
    }
    if (observedAtMs === null) {
      return { ...base, state: taskIndexLoading.has(projectId) ? 'warming' : 'cold' };
    }
    const fresh = dependencies.now() - observedAtMs < QUAY_TASK_INDEX_TTL_MS;
    return { ...base, state: fresh ? 'ready' : 'stale' };
  };

  /** Records a failed load, RETAINING whatever the last successful one produced. */
  const recordTaskIndexFailure = (projectId: string, reason: string): void => {
    const previous = taskIndex.get(projectId);
    taskIndex.set(projectId, {
      tasks: previous?.tasks ?? new Map(),
      observedAtMs: previous?.observedAtMs ?? null,
      error: reason,
    });
  };

  /**
   * Replaces a project's index from one `task list --json --no-body` reading. The
   * new map is built whole and swapped in at the end, so a malformed payload
   * leaves the previous reading intact rather than half-applying a new one.
   */
  const applyTaskIndexStdout = (projectId: string, stdout: string): void => {
    const parsed = parseJson(stdout);
    if (!Array.isArray(parsed)) {
      throw new Error('the index command did not print a task array');
    }
    const tasks = new Map<string, QuayTaskStatusRow>();
    for (const item of parsed) {
      const record = asRecord(item);
      if (record === null || typeof record.id !== 'string') {
        continue;
      }
      const epochMs = readUpdatedAtEpochMs(record.updatedAt);
      tasks.set(String(record.id), {
        taskId: String(record.id),
        status: typeof record.status === 'string' ? record.status : 'unknown',
        // `readUpdatedAtEpochMs` has already refused anything a `Date` cannot hold.
        updatedAt: epochMs === null ? null : new Date(epochMs).toISOString(),
        title: typeof record.title === 'string' ? record.title.slice(0, QUAY_TASK_INDEX_TITLE_LIMIT) : '',
      });
    }
    taskIndex.set(projectId, { tasks, observedAtMs: dependencies.now() });
  };

  /**
   * Asks for a background load of a project's compact status index. It returns
   * IMMEDIATELY and reports nothing: its callers are read paths that must never
   * wait on a subprocess, and the reading they take is whatever the last load
   * left behind. A request is dropped when the project already has a load in
   * flight, when it loaded inside {@link QUAY_TASK_INDEX_MIN_INTERVAL_MS}, or when
   * {@link QUAY_TASK_INDEX_MAX_CONCURRENT_LOADS} projects are already loading — so
   * twenty readers, or one reader polling twenty times a minute, still cost one
   * `quay` child per project per interval and never a whole snapshot.
   */
  const requestTaskIndexLoad = (projectId: string): void => {
    if (taskIndexLoading.has(projectId) || taskIndexInFlight >= QUAY_TASK_INDEX_MAX_CONCURRENT_LOADS) {
      return;
    }
    const lastStartedAt = taskIndexLastStartedAt.get(projectId);
    if (lastStartedAt !== undefined && dependencies.now() - lastStartedAt < QUAY_TASK_INDEX_MIN_INTERVAL_MS) {
      return;
    }
    const projectPath = dependencies.resolveProjectPathById(projectId);
    if (!projectPath) {
      return;
    }

    taskIndexLoading.add(projectId);
    taskIndexLastStartedAt.set(projectId, dependencies.now());
    taskIndexInFlight += 1;
    // Fire-and-forget, with every failure path swallowed into the index's own
    // `error` state: a detached rejection here would be an unhandled one, and the
    // reader only ever learns about it through `readTaskIndex`.
    void (async () => {
      try {
        const result = await runQuayCommand(projectPath, QUAY_TASK_INDEX_COMMAND);
        if (!result.ok) {
          recordTaskIndexFailure(
            projectId,
            result.error ?? `the index command exited ${result.code === null ? 'abnormally' : result.code}`,
          );
          return;
        }
        if (Buffer.byteLength(result.stdout, 'utf8') > QUAY_TASK_INDEX_MAX_STDOUT_BYTES) {
          recordTaskIndexFailure(
            projectId,
            `the index reading exceeded ${QUAY_TASK_INDEX_MAX_STDOUT_BYTES} bytes`,
          );
          return;
        }
        applyTaskIndexStdout(projectId, result.stdout);
      } catch (error) {
        recordTaskIndexFailure(projectId, error instanceof Error ? error.message : String(error));
      } finally {
        taskIndexLoading.delete(projectId);
        taskIndexInFlight -= 1;
      }
    })();
  };

  const getQuayStatus = (projectId: string): QuayProjectStatus | null => {
    const projectPath = dependencies.resolveProjectPathById(projectId);
    if (!projectPath) {
      return null;
    }

    return { projectId, projectPath, hasQuayConfig: detectQuayConfig(projectPath) };
  };

  /**
   * Resolves a project's `quay serve` dashboard URL without spawning a CLI, from the two
   * things the panel actually needs: the `web` service's recorded host/port, read out of
   * the `.quay/server.json` carrier, and a live probe of that address to confirm something
   * is still answering there.
   *
   * Every absence resolves `null` and is never a warning, because a machine with no
   * dashboard running is a normal state rather than a failed command: no carrier file (no
   * server was ever started here), a carrier that cannot be read or parsed, no `web`
   * entry, a `web` entry without a usable host/port, and a `web` entry whose probe does not
   * answer (a stopped or SIGKILLed server whose carrier was left behind).
   */
  const readDashboardUrl = async (projectPath: string): Promise<string | null> => {
    let text: string;
    try {
      text = await dependencies.readFile.readText(
        path.join(projectPath, '.quay', QUAY_SERVER_STATE_FILE),
      );
    } catch {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return null;
    }

    const address = readWebServiceAddress(parsed);
    if (!address) {
      return null;
    }

    const host = probeAddress(address.host);
    const alive = await dependencies.probeWebService(host, address.port);
    return alive ? `http://${host}:${address.port}/` : null;
  };

  /**
   * Reads the Loop pulse lane set for one window by spawning ONLY quay's `lanes` verb.
   *
   * This is the whole cost of a window switch. A window is a *data* filter over the same
   * project — the task/goal/ADR/driver/config sections do not depend on it — so re-reading
   * them on every click is pure waste (and, on a large store, 3–4 s of it). The full pass
   * still uses this for its `gantt` field, so there is one implementation of the read.
   *
   * A missing reading is classified rather than flattened: "the plugin has no such verb" and
   * "the verb ran but its document was unreadable" are different facts, and the panel states
   * which one it is. A non-zero exit is the CLI refusing the sub-command (an un-upgraded
   * plugin); anything else that yields no document is a read failure.
   */
  const collectGantt = async (
    projectPath: string,
    windowHours: number,
  ): Promise<{ gantt: QuayGanttLanes | null; unavailable: QuayGanttUnavailableReason | null }> => {
    const result = await runQuayCommand(projectPath, [...QUAY_LANES_PREFIX, '--window-hours', String(windowHours)]);
    if (!result.ok) {
      return {
        gantt: null,
        unavailable: result.failureKind === 'nonzero-exit' ? 'plugin-lacks-lanes-verb' : 'lanes-read-failed',
      };
    }
    if (!result.stdout.trim()) {
      return { gantt: null, unavailable: 'lanes-read-failed' };
    }
    try {
      const gantt = readGanttLanes(parseJson(result.stdout));
      return gantt ? { gantt, unavailable: null } : { gantt: null, unavailable: 'lanes-read-failed' };
    } catch {
      return { gantt: null, unavailable: 'lanes-read-failed' };
    }
  };

  const collectSnapshot = async (
    projectId: string,
    projectPath: string,
    windowHours: number = DEFAULT_QUAY_GANTT_WINDOW_HOURS,
  ): Promise<QuaySnapshot> => {
    const warnings: string[] = [];
    const quayDir = path.join(projectPath, '.quay');

    /**
     * Runs one command and reads its JSON body. A non-zero exit is not on its
     * own a failure of this read: `quay config validate --json` prints its issue
     * list and then exits 1 to signal that issues exist, and that list is exactly
     * the reading we want. So stdout is parsed first, and the exit status only
     * decides the outcome when nothing parseable came back.
     *
     * The warning is *returned* rather than pushed, so that the caller can append the
     * collected warnings in a fixed order even though the reads below run concurrently —
     * a shared array written from each read would order the panel's banner by whichever
     * child happened to finish first.
     */
    const readJson = async (
      args: readonly string[],
    ): Promise<{ value: unknown; warning: string | null }> => {
      const result = await runQuayCommand(projectPath, args);

      if (result.stdout.trim()) {
        try {
          return { value: parseJson(result.stdout), warning: null };
        } catch {
          // Fall through: an unparseable body is reported below.
        }
      }

      const reason = result.error ?? (result.stderr.trim() || `exit code ${result.code}`);
      // Tag the warning with the failure category so the panel can show *which*
      // failure this was (missing CLI vs. timeout vs. non-zero exit), rather than
      // the one generic "quay did not answer" the four situations used to collapse to.
      const detail = result.failureKind ? `[${result.failureKind}] ${reason}` : reason;
      return {
        value: null,
        warning: `${args.join(' ')}: ${result.ok ? 'returned non-JSON output' : detail}`,
      };
    };

    // Every section is independent of every other, so they are gathered in ONE parallel
    // pass: the cold path then costs the slowest single read instead of their sum. That
    // sum was the defect — six strictly serial `await`s over a 2.5k-task store put ~9.5 s
    // in front of a panel open, while the slowest single read is ~3 s. The carrier reads
    // (Tests, Fan-in, dashboard) sit under the trusted project root, never a request path;
    // a missing file there is a normal empty reading and never a warning.
    const [
      tasksRead,
      goalsRead,
      adrsRead,
      driverRead,
      configRead,
      currentSuite,
      recentRoundRecords,
      fanInRecords,
      workerRoundRecord,
      dashboardUrl,
      ganttRead,
    ] = await Promise.all([
      readJson(['task', 'list', '--json']),
      readJson(['goal', 'list', '--json']),
      readJson(['adr', 'list', '--json']),
      readJson(['driver', 'status', '--kind', 'worker', '--json']),
      readJson(['config', 'validate', '--json']),
      readCurrentSuiteState(dependencies.readFile, path.join(quayDir, QUAY_SUITE_STATE_FILE)),
      readCarrierFileTail(
        dependencies.readFile,
        path.join(quayDir, QUAY_ROUND_HISTORY_FILE),
        QUAY_RECENT_LIST_LIMIT,
      ),
      readCarrierFileTail(
        dependencies.readFile,
        path.join(quayDir, QUAY_WORKER_OUTCOME_FILE),
        QUAY_RECENT_LIST_LIMIT,
      ),
      readLastCarrierRecord(dependencies.readFile, path.join(quayDir, QUAY_WORKER_ROUND_FILE)),
      readDashboardUrl(projectPath),
      collectGantt(projectPath, windowHours),
    ]);

    // Fixed order, matching the panel's reading order, so the banner is deterministic.
    for (const read of [tasksRead, goalsRead, adrsRead, driverRead, configRead]) {
      if (read.warning) {
        warnings.push(read.warning);
      }
    }

    // The fan-in attempts feed the Fan-in card. (The in-flight tasks' `phase` no longer
    // derives from them: it is read off the same `lanes` document as the Loop pulse gantt,
    // so the card and the chart can never disagree — see `summarizeInFlightTasks`.)
    const fanInAttempts = summarizeFanInAttempts(fanInRecords);

    return {
      projectId,
      projectPath,
      generatedAt: new Date(dependencies.now()).toISOString(),
      cached: false,
      driver: summarizeDriver(driverRead.value),
      tasks: summarizeTasks(tasksRead.value),
      goals: summarizeGoals(goalsRead.value),
      adrs: summarizeAdrs(adrsRead.value),
      configIssues: summarizeConfigIssues(configRead.value),
      tests: { current: currentSuite, recentRounds: summarizeTestRounds(recentRoundRecords) },
      fanIn: { recent: fanInAttempts },
      // The In-flight card and the Loop pulse gantt are two projections of ONE reading:
      // `ganttRead.gantt`, the `lanes` document relayed by `collectGantt`. Deriving the card
      // from the same lanes (rather than from the raw round carrier) is what keeps the two
      // from contradicting each other; `workerRoundRecord` only supplies `startedAt` /
      // `lastHeartbeat` / `workerPid` for tasks the lanes already put in flight.
      inFlight: summarizeInFlightTasks(ganttRead.gantt, workerRoundRecord),
      gantt: ganttRead.gantt,
      ganttUnavailable: ganttRead.unavailable,
      dashboardUrl,
      warnings,
      // The host-level CLI reading travels WITH the snapshot so the panel can state one cause
      // (missing / incompatible / no-handshake) instead of blaming each project's registration.
      // Collected inside the shared in-flight pass, so concurrent opens still receive the SAME
      // object and pay for one handshake (the reader's own TTL covers later opens).
      fleet: await readFleetAvailability(),
    };
  };

  /**
   * Loads (and caches) the FULL snapshot for one project at one window.
   *
   * The per-project cache and in-flight dedupe are keyed by `projectId` alone and hold the
   * DEFAULT window — that is the reading AC-247's `overview` fans out over, and its contract
   * is one entry per project. It is only entered when no fresh default reading can answer the
   * request: a window change reuses the default reading's non-gantt sections and re-reads just
   * the lanes (`loadGantt`), and `forceRefresh` recomputes everything in place. A non-default
   * window therefore reaches `collectSnapshot` directly and writes nothing to the per-project
   * cache.
   */
  const loadSnapshot = (
    projectId: string,
    projectPath: string,
    windowHours: number = DEFAULT_QUAY_GANTT_WINDOW_HOURS,
  ): Promise<QuaySnapshot> => {
    if (windowHours !== DEFAULT_QUAY_GANTT_WINDOW_HOURS) {
      return collectSnapshot(projectId, projectPath, windowHours);
    }

    const pending = inFlightSnapshots.get(projectId);
    if (pending) {
      return pending;
    }

    const promise = collectSnapshot(projectId, projectPath, windowHours)
      .then((snapshot) => {
        snapshotCache.set(projectId, {
          expiresAt: dependencies.now() + dependencies.snapshotTtlMs,
          snapshot,
        });
        return snapshot;
      })
      .finally(() => {
        inFlightSnapshots.delete(projectId);
      });

    inFlightSnapshots.set(projectId, promise);
    return promise;
  };

  /**
   * Loads (and caches) the Loop pulse lane set for one (project, window), spawning only the
   * `lanes` verb.
   *
   * This is what makes a window switch cheap: the sections that do not depend on the window
   * are reused from the fresh default reading, and only this read is re-run. The cache is
   * keyed by BOTH ids because the window is part of the question — a 3h entry must never
   * answer a 12h request (`{lanes, overflow}` differ per window) — and `cached: true` says
   * this exact (project, window) reading was reused rather than re-spawned.
   */
  const loadGantt = async (
    projectId: string,
    projectPath: string,
    windowHours: number,
  ): Promise<{ gantt: QuayGanttLanes | null; unavailable: QuayGanttUnavailableReason | null; cached: boolean }> => {
    const key = `${projectId}::${windowHours}`;
    const cached = ganttCache.get(key);
    if (cached && cached.expiresAt > dependencies.now()) {
      return { gantt: cached.gantt, unavailable: cached.unavailable, cached: true };
    }

    const pending = inFlightGantt.get(key);
    if (pending) {
      const read = await pending;
      return { gantt: read.gantt, unavailable: read.unavailable, cached: false };
    }

    const promise = collectGantt(projectPath, windowHours)
      .then((read) => {
        ganttCache.set(key, { expiresAt: dependencies.now() + dependencies.snapshotTtlMs, gantt: read.gantt, unavailable: read.unavailable });
        return read;
      })
      .finally(() => {
        inFlightGantt.delete(key);
      });

    inFlightGantt.set(key, promise);
    const read = await promise;
    return { gantt: read.gantt, unavailable: read.unavailable, cached: false };
  };

  /**
   * The snapshot itself, WITHOUT the fleet registry join. Kept separate so every branch above
   * (cache hit, in-flight join, window-switch reuse, full pass) is stamped with
   * `fleetProjectId` exactly once, in {@link getQuaySnapshot}.
   */
  const readQuaySnapshot = async (
    projectId: string,
    options: QuaySnapshotOptions = {},
  ): Promise<QuaySnapshot | null> => {
    const projectPath = dependencies.resolveProjectPathById(projectId);
    if (!projectPath) {
      return null;
    }

    const windowHours = normalizeGanttWindowHours(options.windowHours);

    // The default window keeps the per-project read-on-demand path: TTL cache, then the
    // shared in-flight promise, then a full pass.
    if (!options.forceRefresh && windowHours === DEFAULT_QUAY_GANTT_WINDOW_HOURS) {
      const cached = snapshotCache.get(projectId);
      if (cached && cached.expiresAt > dependencies.now()) {
        return { ...cached.snapshot, cached: true };
      }

      const pending = inFlightSnapshots.get(projectId);
      if (pending) {
        return pending;
      }
    }

    // A non-default window is the SAME project reading filtered to a different window: every
    // section but the Loop pulse family (the pulse chart, and the In-flight card that is a
    // projection of the same lanes document) is window-independent, so it reuses the fresh
    // default reading and re-reads only the lanes. `cached` reports whether that lanes read
    // itself was reused — a repeat of the same (project, window) spawns nothing.
    if (!options.forceRefresh && windowHours !== DEFAULT_QUAY_GANTT_WINDOW_HOURS) {
      const base = snapshotCache.get(projectId);
      if (base && base.expiresAt > dependencies.now()) {
        const { gantt, unavailable, cached } = await loadGantt(projectId, projectPath, windowHours);
        // The In-flight card is a projection of the pulse's lanes, so a window switch must
        // re-derive it too: reusing `base.snapshot.inFlight` (the default window's reading)
        // would re-open the exact card-vs-chart contradiction this panel was fixed to close.
        // The round carrier only supplements fields and is a local file read, never a
        // subprocess, so the window change still spawns the lanes verb alone.
        const workerRoundRecord = await readLastCarrierRecord(
          dependencies.readFile,
          path.join(projectPath, '.quay', QUAY_WORKER_ROUND_FILE),
        );
        return {
          ...base.snapshot,
          inFlight: summarizeInFlightTasks(gantt, workerRoundRecord),
          gantt,
          ganttUnavailable: unavailable,
          cached,
        };
      }
    }

    return loadSnapshot(projectId, projectPath, windowHours);
  };

  /**
   * The Tier-2 snapshot as `GET /api/quay/:projectId/snapshot` answers it: the stored reading
   * plus the project's `fleetProjectId`. The join is stamped here, on every branch, because it
   * is what the wall mints its project segment from — a cached snapshot body carrying a stale
   * (or absent) join would let the renderer fall back to the CloudCLI id.
   */
  const getQuaySnapshot = async (
    projectId: string,
    options: QuaySnapshotOptions = {},
  ): Promise<QuaySnapshot | null> => {
    const snapshot = await readQuaySnapshot(projectId, options);
    if (snapshot === null) {
      return null;
    }
    const fleetProjectId = await fleetProjectIds.resolveFleetProjectId(projectId);
    // Omitted rather than `null` when unregistered: the shared type documents absent and null
    // as the same reading, and an older snapshot shape stays byte-comparable. The object is
    // returned AS-IS when there is nothing to stamp, so two concurrent opens share one
    // reference through the in-flight promise (the panel's dedupe criterion measures this).
    return fleetProjectId === null ? snapshot : { ...snapshot, fleetProjectId };
  };

  /**
   * Reads a project's Tier-2 snapshot from the in-memory TTL cache WITHOUT ever
   * loading it: the two outcomes are the cached snapshot (marked `cached: true`)
   * or `null` on a miss / an expired entry. It never calls {@link loadSnapshot}
   * / {@link collectSnapshot} / `runCommand`, so a caller fanning out over N
   * projects spawns zero quay CLI processes — the property the MCP `overview`
   * tool (AC-247) rests on, where an unbounded cold-cache fan-out would otherwise
   * spawn one `quay` invocation per project.
   *
   * The freshness test is the SAME predicate `getQuaySnapshot`'s cache branch
   * uses (`cached.expiresAt > now()`), so the Tier-2 panel and the MCP gateway can
   * never disagree about whether a reading is fresh.
   *
   * Consumer: `server/index.ts` binds the MCP gateway's `McpQuayRunner.readCached`
   * to this method (AC-247); `getQuaySnapshot` keeps its existing load-on-demand
   * semantics and is bound to `refresh` instead.
   */
  const getCachedSnapshot = (projectId: string): QuaySnapshot | null => {
    const cached = snapshotCache.get(projectId);
    if (cached && cached.expiresAt > dependencies.now()) {
      return { ...cached.snapshot, cached: true };
    }
    return null;
  };

  // ── the fleet summary (fleet-overview P2) ─────────────────────────────────────────────────
  //
  // A per-project reading of driver state + task counts, so the sidebar can show every
  // project's board at a glance without opening any of them. Each entry has its own TTL,
  // because projects are read independently: a project whose cache is still fresh is served
  // without touching the CLI even when another project in the same request is stale.
  const fleetSummaryCache = new Map<string, { expiresAt: number; summary: QuayFleetProjectSummary }>();
  const inFlightFleetProjects = new Map<string, Promise<QuayFleetProjectSummary>>();

  /** The cheapest task read the CLI offers: no bodies, only the status the badge counts. */
  const QUAY_FLEET_TASKS_COMMAND: readonly string[] = ['task', 'list', '--json', '--no-body'];
  const QUAY_FLEET_DRIVER_COMMAND: readonly string[] = ['driver', 'status', '--kind', 'worker', '--json'];

  // A counting semaphore over PROJECT loads. It is deliberately not a per-command limiter:
  // a project load spawns its two reads concurrently, so bounding projects at N also bounds
  // each command at N. A released slot is handed straight to the next waiter without
  // decrementing, so a waiter can never race a fresh acquirer past the ceiling.
  let fleetProjectsInFlight = 0;
  const fleetSlotWaiters: (() => void)[] = [];

  const acquireFleetSlot = (): Promise<void> => {
    if (fleetProjectsInFlight < QUAY_FLEET_SUMMARY_MAX_CONCURRENT_PROJECTS) {
      fleetProjectsInFlight += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => fleetSlotWaiters.push(resolve));
  };

  const releaseFleetSlot = (): void => {
    const next = fleetSlotWaiters.shift();
    if (next) {
      // The slot's ownership transfers; the count already includes it.
      next();
      return;
    }
    fleetProjectsInFlight -= 1;
  };

  /** Reads one project's driver state and task counts, with at most two child processes. */
  const loadFleetProject = async (
    candidate: { projectId: string; projectPath: string },
  ): Promise<QuayFleetProjectSummary> => {
    await acquireFleetSlot();
    try {
      const [tasksRead, driverRead, fleetProjectId] = await Promise.all([
        runQuayCommand(candidate.projectPath, QUAY_FLEET_TASKS_COMMAND),
        runQuayCommand(candidate.projectPath, QUAY_FLEET_DRIVER_COMMAND),
        // The registry reading is cached per TTL, so this is one `quay-fleet` call per window
        // for the whole fan-out rather than one per project.
        fleetProjectIds.resolveFleetProjectId(candidate.projectId),
      ]);

      const failures: string[] = [];
      let tasks: QuayFleetTaskCounts | null = null;
      if (!tasksRead.ok) {
        failures.push(`task list: ${tasksRead.error ?? `exit ${tasksRead.code === null ? 'abnormally' : tasksRead.code}`}`);
      } else {
        try {
          tasks = summarizeFleetTaskCounts(parseJson(tasksRead.stdout));
        } catch {
          // Reported through the same `error` channel as a failed child, so the caller has
          // one place to look for "this project's counts are not a reading".
        }
        if (tasks === null) {
          failures.push('task list: returned no task array');
        }
      }

      let driver: QuayFleetProjectSummary['driver'] = { state: 'unavailable' };
      if (driverRead.ok) {
        const summary = summarizeDriver(parseJsonOrNull(driverRead.stdout));
        if (summary) {
          driver = { state: summary.state };
        } else {
          failures.push('driver status: returned no driver record');
        }
      } else {
        failures.push(`driver status: ${driverRead.error ?? `exit ${driverRead.code === null ? 'abnormally' : driverRead.code}`}`);
      }

      return {
        projectId: candidate.projectId,
        projectPath: candidate.projectPath,
        fleetProjectId,
        driver,
        tasks: tasks ?? EMPTY_FLEET_TASK_COUNTS,
        cached: false,
        error: failures.length > 0 ? failures.join('; ') : null,
      };
    } finally {
      releaseFleetSlot();
    }
  };

  /**
   * Whether the fleet could be asked. A resolver that does not expose the reading (an older
   * composition) keeps the pre-existing behaviour: the join answers per project and the
   * summary does not claim the CLI is missing.
   */
  const readFleetAvailability = async (): Promise<QuayFleetAvailability> => {
    if (fleetProjectIds.resolveFleetAvailability === undefined) {
      return {
        available: true,
        state: 'ok',
        binPath: null,
        version: null,
        contracts: null,
        reason: null,
      };
    }
    try {
      return await fleetProjectIds.resolveFleetAvailability();
    } catch {
      return {
        available: false,
        state: 'no-handshake',
        binPath: null,
        version: null,
        contracts: null,
        reason: 'quay-fleet availability could not be read',
      };
    }
  };

  /**
   * Reads the fleet summary: every project with a `.quay/config.yml`, each carrying its
   * driver state and task counts. Projects without that carrier are absent from the
   * result — the fleet is quay projects, not every project the server knows.
   *
   * A project inside its TTL window is served from cache and marked `cached: true`; a
   * project already loading has its in-flight read joined rather than duplicated, so
   * concurrent requests cost one child per project. Failed readings are returned (with
   * their `error`) but not cached, so a transient CLI failure cannot pin a wrong reading
   * for a whole TTL.
   */
  const getFleetSummary = async (): Promise<QuayFleetSummary> => {
    const candidates = (dependencies.listProjects?.() ?? []).filter((candidate) =>
      detectQuayConfig(candidate.projectPath),
    );

    // Availability is read alongside the projects rather than before them: both share the
    // resolver's one cached registry read, so this adds no child process to the fan-out.
    const [projects, fleet] = await Promise.all([
      Promise.all(
        candidates.map(async (candidate): Promise<QuayFleetProjectSummary> => {
          const cached = fleetSummaryCache.get(candidate.projectId);
          if (cached && cached.expiresAt > dependencies.now()) {
            return { ...cached.summary, cached: true };
          }

          const pending = inFlightFleetProjects.get(candidate.projectId);
          if (pending) {
            return pending;
          }

          const load = (async (): Promise<QuayFleetProjectSummary> => {
            try {
              const reading = await loadFleetProject(candidate);
              if (reading.error === null) {
                fleetSummaryCache.set(candidate.projectId, {
                  expiresAt: dependencies.now() + QUAY_FLEET_SUMMARY_TTL_MS,
                  summary: reading,
                });
              }
              return reading;
            } finally {
              inFlightFleetProjects.delete(candidate.projectId);
            }
          })();
          inFlightFleetProjects.set(candidate.projectId, load);
          return load;
        }),
      ),
      readFleetAvailability(),
    ]);

    return {
      projects,
      fleet,
      generatedAt: new Date(dependencies.now()).toISOString(),
      ttlPerProjectMs: QUAY_FLEET_SUMMARY_TTL_MS,
      cached: projects.length > 0 && projects.every((project) => project.cached),
    };
  };

  // ── wall URI dereference (quay-wall-uri-dereference-with-snapshot-fallback) ──────────────
  //
  // The resolver is composed from the SAME snapshot reading the panel uses, so a fallback
  // answer cannot disagree with what the panel shows. The fleet reader is tried first; the
  // snapshot is read only when that port is unavailable, and the read path never generates
  // an L2 summary.
  const fleetWallReader: QuayFleetWallReader | null =
    dependencies.fleetWallReader !== undefined
      ? dependencies.fleetWallReader
      : createQuayFleetCliWallReader({ timeoutMs: dependencies.commandTimeoutMs });

  const quayUriResolver = createQuayUriResolver({
    fleetWallReader,
    // The project segment is a quay-fleet REGISTRY ID. The join names the registered root the
    // fleet read port is called with, and the CloudCLI project (if any) whose snapshot can
    // supplement a task reference.
    resolveFleetProject: (projectSegment) => fleetProjectIds.resolveFleetProject(projectSegment),
    // Cached first, so dereferencing a URI the panel just rendered spawns nothing. A cold
    // cache loads the same snapshot the panel loads; the TTL then serves both surfaces.
    readSnapshot: async (projectId) => getCachedSnapshot(projectId) ?? getQuaySnapshot(projectId),
  });

  const resolveQuayUri = (uri: string) => quayUriResolver.resolve(uri);
  const getQuayUriSummary = (uri: string) => quayUriResolver.summary(uri);

  return {
    detectQuayConfig,
    runQuayCommand,
    getQuayStatus,
    getQuaySnapshot,
    getCachedSnapshot,
    // The `changes` Quay source (AC-348): a reader that never loads, plus the
    // non-blocking request that fills it. These two are why `changes` can report
    // full coverage without ever waiting on — or spawning — a snapshot.
    readTaskIndex,
    requestTaskIndexLoad,
    // The eager cross-project reading (fleet-overview P2): driver state + task counts
    // for every quay project, per-project TTL, bounded fan-out. The sidebar consumes it
    // for the project-row task badges; the lazy Tier-2 snapshot stays the expanded view.
    getFleetSummary,
    // The wall's dereference entry points (quay-wall-uri-dereference-with-snapshot-fallback):
    // `resolveQuayUri` answers the L1 reference (fleet first, snapshot for tasks), and
    // `getQuayUriSummary` the L2 stored summary (absent when the fleet has not stored one).
    resolveQuayUri,
    getQuayUriSummary,
  };
}
