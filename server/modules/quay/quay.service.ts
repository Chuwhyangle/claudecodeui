import path from 'node:path';
import { pathToFileURL } from 'node:url';

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

/** Driver summary rendered by the sidebar badge and the Tier-2 panel header. */
export type QuayDriverState = 'running' | 'idle' | 'stale';

export type QuayDriverSummary = {
  state: QuayDriverState;
  alive: boolean;
  running: boolean;
  lastRecordAt: string | null;
};

/**
 * One row of a per-entity detail list (tasks, goals or ADRs). Only the fields the
 * panel renders are kept; the source command returns whole documents (body,
 * children, extra, …) which would bloat every snapshot response.
 */
export type QuayListItem = {
  id: string;
  title: string;
  status: string;
  /**
   * The row's last-updated instant as ISO-8601, converted from the epoch
   * **milliseconds** the CLI prints (`1786439928515.85`), or `null` when the
   * record carried no usable timestamp. This is the value the list is ranked by,
   * so the panel can show the ordering key instead of an invisible one. It is
   * never epoch 0 (`1970-01-01T00:00:00.000Z`) for a missing reading, and never
   * an `Invalid Date` string.
   */
  updatedAt: string | null;
};

/** How many `recent` rows each detail list keeps; the cap the panel copy promises. */
export const QUAY_RECENT_LIST_LIMIT = 10;

export type QuayTaskCounts = {
  total: number;
  byStatus: Record<string, number>;
  ready: number;
  needsHuman: number;
  done: number;
  /** Up to `QUAY_RECENT_LIST_LIMIT` tasks, most recently updated first. */
  recent: QuayListItem[];
};

/** Goal counts read from `quay goal list --json`; the panel shows the stage breakdown. */
export type QuayGoalCounts = {
  total: number;
  achieved: number;
  /** Per-status grouping plus the most recent goals, for the panel's "Stage goals" card. */
  breakdown: QuayGoalBreakdown;
};

/**
 * Stage-goals card payload: how many goals sit in each status the CLI reports,
 * plus the most recently updated goals as display rows.
 */
export type QuayGoalBreakdown = {
  /** Counts keyed by the CLI's own status string (`active`/`achieved`/`draft`/`superseded`/…). */
  byStatus: Record<string, number>;
  /** Up to `QUAY_RECENT_LIST_LIMIT` goals, most recently updated first. */
  recent: QuayListItem[];
};

export type QuayAdrCounts = {
  total: number;
  /** Up to `QUAY_RECENT_LIST_LIMIT` ADRs, most recently updated first. */
  recent: QuayListItem[];
};

/**
 * Current full-suite reading from `.quay/full-suite-state.json`, rendered as the
 * "current" half of the Tests card. `null` means no run state is on disk — a
 * normal "nothing running" state, never a warning.
 */
export type QuaySuiteState = {
  state: string;
  runner: string | null;
  scope: string | null;
  /** ISO timestamp the run started, as the carrier file stores it. */
  startedAt: string | null;
  /** Unix epoch **seconds** the run finished, as the carrier file stores it. */
  finishedAt: number | null;
  durationMs: number | null;
  laneCount: number | null;
  commit: string | null;
  taskId: string | null;
  runId: string | null;
};

/** One history round projected from `.quay/verification-round.jsonl`; the heavy per-file detail is dropped. */
export type QuayTestRoundSummary = {
  round: number;
  startedAt: string | null;
  durationMs: number | null;
  pass: number | null;
  fail: number | null;
  tests: number | null;
  state: string;
};

/** Tests card payload: the current run (if any) plus the most recent history rounds. */
export type QuayTestsSummary = {
  current: QuaySuiteState | null;
  recentRounds: QuayTestRoundSummary[];
};

/**
 * One merged in-flight-or-historical run interval for the Loop pulse gantt.
 *
 * Field-for-field what quay's `dashboard-kernel` publishes as `LiveGanttInterval`. This is
 * re-declared rather than imported from the plugin because the plugin is an external,
 * per-project artifact resolved at runtime — the shape is the contract, and the kernel
 * module itself supplies the values.
 */
export type QuayGanttInterval = {
  taskId: string;
  runId: string;
  startMs: number;
  endMs: number;
  phase: string | null;
  finalState: string | null;
  fanInOutcome: string | null;
};

/**
 * Loop pulse card payload: quay's `packLanes` output over one time window.
 *
 * `overflow` counts the intervals that found no free lane. quay deliberately does not drop
 * them, so `lanes` alone does NOT account for the whole window whenever it is non-zero —
 * a consumer must render the count or it silently loses runs.
 */
export type QuayGanttLanes = {
  windowHours: number;
  nowMs: number;
  lanes: QuayGanttInterval[][];
  overflow: number;
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
 * How many history records to read for the gantt. Much larger than
 * `QUAY_RECENT_LIST_LIMIT`: that limit serves "the last few attempts" cards, whereas a gantt
 * window of up to 12 hours can legitimately contain hundreds of runs. The window filter
 * itself is the kernel's, so over-reading here only costs parse time, while under-reading
 * would silently show a sparse chart.
 */
export const QUAY_GANTT_HISTORY_LIMIT = 500;

/** Relative to a project root: the installed plugin's vendored kernel build. */
const QUAY_KERNEL_REL = path.join('.quay', 'plugin', 'vendor', 'quay', 'dist', 'dashboard-kernel.js');

type QuayKernelModule = {
  mergeLiveAndHistoryIntervals: (
    inFlight: readonly { taskId: string; runId: string; startedAtMs: number; phase: string | null }[],
    records: readonly unknown[],
    windowStartMs: number,
    nowMs: number,
  ) => QuayGanttInterval[];
  packLanes: (
    intervals: readonly QuayGanttInterval[],
    maxLanes?: number,
  ) => { lanes: QuayGanttInterval[][]; overflow: number };
};

/** Successful loads only; a failure is retried, so a plugin upgrade is picked up. */
const kernelLoads = new Map<string, Promise<QuayKernelModule>>();

/**
 * Loads quay's own gantt packing kernel out of the project's installed plugin.
 *
 * Resolved through the project's `.quay/plugin` pointer rather than a plugin-cache path:
 * that symlink is what `/quay:init` maintains across upgrades, so a version directory moving
 * never invalidates this lookup — a hardcoded `…/quay/quay/<version>/…` would.
 *
 * The kernel is consumed instead of reimplemented on purpose: `mergeLiveAndHistoryIntervals`
 * and `packLanes` ARE the semantics this card is supposed to mirror, and a local copy would
 * be a second implementation that drifts. A load failure resolves `null` and never throws —
 * a project whose plugin predates the kernel simply has no gantt reading.
 */
async function loadQuayKernel(projectPath: string): Promise<QuayKernelModule | null> {
  const kernelPath = path.join(projectPath, QUAY_KERNEL_REL);
  const cached = kernelLoads.get(kernelPath);
  if (cached) {
    return cached;
  }

  const load = import(pathToFileURL(kernelPath).href) as Promise<QuayKernelModule>;
  kernelLoads.set(kernelPath, load);
  try {
    const mod = await load;
    if (typeof mod.packLanes !== 'function' || typeof mod.mergeLiveAndHistoryIntervals !== 'function') {
      kernelLoads.delete(kernelPath);
      return null;
    }
    return mod;
  } catch {
    // Not cached: a plugin upgraded after this call must be able to succeed on the next one.
    kernelLoads.delete(kernelPath);
    return null;
  }
}

/**
 * Projects `quay driver live --json`'s payload down to what the kernel needs.
 *
 * `null` — never `[]` — when the payload is not the documented shape: presenting an
 * unreadable in-flight reading to the kernel as "nothing in flight" would turn a failed read
 * into a chart that looks merely idle. The kernel exposes exactly these four fields.
 */
export function readInFlightRuns(
  value: unknown,
): { taskId: string; runId: string; startedAtMs: number; phase: string | null }[] | null {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  const list = (value as { inFlight?: unknown }).inFlight;
  if (!Array.isArray(list)) {
    return null;
  }

  const runs: { taskId: string; runId: string; startedAtMs: number; phase: string | null }[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') {
      continue;
    }
    const task = entry as { taskId?: unknown; runId?: unknown; startedAtMs?: unknown; phase?: unknown };
    if (typeof task.taskId !== 'string' || typeof task.startedAtMs !== 'number' || !Number.isFinite(task.startedAtMs)) {
      continue;
    }
    runs.push({
      taskId: task.taskId,
      runId: typeof task.runId === 'string' ? task.runId : '',
      startedAtMs: task.startedAtMs,
      phase: typeof task.phase === 'string' ? task.phase : null,
    });
  }
  return runs;
}

/** One fan-in attempt projected from `.quay/worker-outcome.jsonl`. */
export type QuayFanInAttemptSummary = {
  task: string;
  outcome: string;
  /** Lock acquisition as Unix epoch **seconds** (quay's own unit); the panel converts to ms. */
  lockAcquireEpoch: number | null;
  /** Lock release as Unix epoch **seconds**; `null` when the attempt never released the lock. */
  lockReleaseEpoch: number | null;
};

/** Fan-in card payload: the most recent mechanical fan-in attempts across all tasks. */
export type QuayFanInSummary = {
  recent: QuayFanInAttemptSummary[];
};

/**
 * One task a project's Quay worker driver currently reports as in flight, read from the
 * `.quay/worker-round.jsonl` carrier — the SAME file the `quay serve` Web dashboard's
 * "Live" card renders from. It closes the gap this reading exists for: the driver-status
 * CLI answers only `alive`/`running`/`last_record_ts` (never WHICH task), so a CloudCLI
 * client could see a driver running but never learn what it was running.
 *
 * Consumer: the MCP `quay_snapshot` tool (`mcp-overview-tools.ts`) surfaces the whole
 * list as `snapshot.inFlight`.
 */
export type QuayInFlightTask = {
  taskId: string;
  /**
   * `'fan-in'` when the task's most recent attempt in the Fan-in card's reading holds the
   * fan-in lock (`lockAcquireEpoch` non-null, `lockReleaseEpoch` still null); otherwise
   * `'implementing'`. Both states are derived from the already-collected `fanIn.recent`
   * reading rather than a second state machine.
   */
  phase: 'implementing' | 'fan-in';
  /** The task's dispatch instant (ISO) from the round record's per-task start map, or `null` when it carries none. */
  startedAt: string | null;
  /** The round record's own heartbeat instant (ISO) — i.e. when this reading was written. */
  lastHeartbeat: string;
  /**
   * The worker-driver loop's own process id from the round record — the `--kind worker`
   * instance, NOT a per-task child/session pid (the carrier holds no per-task pid). `null`
   * when the record carries none.
   */
  workerPid: number | null;
};

export type QuayConfigIssueCounts = {
  total: number;
  errors: number;
};

/**
 * Everything the Tier-2 panel renders, assembled from whitelisted read-only
 * commands. A section is `null` when its command failed or returned unparseable
 * output; the failure is recorded in `warnings` rather than thrown, so one
 * misbehaving subcommand never blanks the whole panel.
 */
export type QuaySnapshot = {
  projectId: string;
  projectPath: string;
  generatedAt: string;
  cached: boolean;
  driver: QuayDriverSummary | null;
  tasks: QuayTaskCounts | null;
  goals: QuayGoalCounts | null;
  adrs: QuayAdrCounts | null;
  configIssues: QuayConfigIssueCounts | null;
  /** Tests card: the current suite run plus recent history rounds, read from `.quay/` carrier files. */
  tests: QuayTestsSummary;
  /** Fan-in card: recent mechanical fan-in attempts, read from `.quay/worker-outcome.jsonl`. */
  fanIn: QuayFanInSummary;
  /**
   * Tasks the worker driver currently reports in flight, read from `.quay/worker-round.jsonl`
   * (the same carrier `quay serve`'s Live card renders from). `null` = the carrier is absent,
   * unreadable, or carried no parseable record ("no reading"); `[]` = the carrier read but
   * names no in-flight task ("nothing running"). The two are deliberately distinct — the same
   * null-vs-empty convention `tests.current` and `driver` follow — so "could not read" is
   * never shown as "nothing running".
   */
  inFlight: QuayInFlightTask[] | null;
  /**
   * Loop pulse card: the packed gantt lanes for this project's recent worker runs, produced
   * by quay's OWN packing kernel (`quay/dashboard-kernel`, shipped inside the installed
   * plugin). `null` = the reading could not be produced — the installed plugin carries no
   * kernel, the in-flight read failed, or the kernel threw. A null is never "no runs": an
   * unread lane set and a genuinely idle window are different readings, and only the second
   * means nothing ran (the same convention `inFlight` and `tests.current` follow).
   */
  gantt: QuayGanttLanes | null;
  /**
   * Link to quay's own `quay serve` dashboard, when a live web service is
   * reported for this project. `null` when no dashboard is running — an absent
   * dashboard is a normal state, never a warning.
   */
  dashboardUrl: string | null;
  warnings: string[];
};

/** Tier-1 reading: whether a project directory carries a `.quay/config.yml`. */
export type QuayProjectStatus = {
  projectId: string;
  projectPath: string;
  hasQuayConfig: boolean;
};

const QUAY_DRIVER_KINDS = ['promotion', 'worker', 'outer', 'quality', 'meta', 'goal'] as const;

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
  ['goal', 'list', '--json'],
  ['adr', 'list', '--json'],
  ...QUAY_DRIVER_KINDS.map((kind) => ['driver', 'status', '--kind', kind, '--json']),
  // The in-flight worker set for the Loop pulse gantt. `driver live` is the read-only verb
  // that exposes what the worker is running right now — the same `readLive` chain quay's own
  // dashboard card renders from — as opposed to `driver status`, which reports liveness only.
  ['driver', 'live', '--kind', 'worker', '--json'],
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
 * same file for "which task is running"; this service reads only its newest record for
 * the snapshot's `inFlight` reading (a different, lighter projection than the Live card's).
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
 * Reads the field the round carrier persists under its snake_case key (`in_flight_tasks`)
 * or, when that is absent, the camelCase spelling the in-memory round options use
 * (`inFlightTasks`). Quay's `writeRound` builds each record from camelCase options but
 * persists it through a snake_case projection, and this reading's own notes referenced the
 * option spelling; accepting both keeps a fixture written either way reading identically.
 */
function readRoundField(record: Record<string, unknown>, snakeCase: string, camelCase: string): unknown {
  return record[snakeCase] !== undefined ? record[snakeCase] : record[camelCase];
}

/** Reads a task-id array field, keeping only non-empty strings and de-duplicating while preserving order. */
function readInFlightTaskIds(value: unknown): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of asArray(value)) {
    if (typeof entry === 'string' && entry.length > 0 && !seen.has(entry)) {
      seen.add(entry);
      ids.push(entry);
    }
  }
  return ids;
}

/**
 * The phase for one in-flight task, from its most recent attempt in the Fan-in reading.
 * `fanInAttempts` is in file order (oldest → newest), so the LAST matching entry is the
 * task's most recent attempt: it holds the fan-in lock (`lockAcquireEpoch` non-null,
 * `lockReleaseEpoch` still null) exactly when the task is parked in fan-in. A task with no
 * attempt at all has never entered fan-in, so it reads `'implementing'`.
 */
function inFlightPhase(taskId: string, fanInAttempts: QuayFanInAttemptSummary[]): QuayInFlightTask['phase'] {
  for (let index = fanInAttempts.length - 1; index >= 0; index -= 1) {
    const attempt = fanInAttempts[index];
    if (attempt.task !== taskId) {
      continue;
    }
    return attempt.lockAcquireEpoch !== null && attempt.lockReleaseEpoch === null
      ? 'fan-in'
      : 'implementing';
  }
  return 'implementing';
}

/**
 * Projects one `.quay/worker-round.jsonl` record to the snapshot's in-flight list.
 *
 * Returns `null` when there is no usable reading — no record at all (the file is absent,
 * empty, or carried no parseable line) or a record without a heartbeat instant, which
 * leaves every row's required `lastHeartbeat` unfillable. A usable record always yields
 * an array, `[]` when it names no in-flight task, so "no reading" and "nothing running"
 * stay distinguishable.
 *
 * `fanInAttempts` is the already-collected Fan-in reading; it supplies each task's
 * `phase`, so this projection opens no second state machine.
 */
function summarizeInFlightTasks(
  roundRecord: unknown,
  fanInAttempts: QuayFanInAttemptSummary[],
): QuayInFlightTask[] | null {
  const record = asRecord(roundRecord);
  // `ts` is the persisted heartbeat key; `at` is the option spelling `writeRound` is
  // called with. Either names the same instant.
  const lastHeartbeat = record ? readNullableString(readRoundField(record, 'ts', 'at')) : null;
  if (!record || !lastHeartbeat) {
    return null;
  }

  const starts = asRecord(readRoundField(record, 'in_flight_task_starts', 'inFlightTaskStarts'));
  const workerPid = readNullableNumber(record.pid);

  return readInFlightTaskIds(readRoundField(record, 'in_flight_tasks', 'inFlightTasks')).map((taskId) => ({
    taskId,
    phase: inFlightPhase(taskId, fanInAttempts),
    startedAt: starts ? readNullableString(starts[taskId]) : null,
    lastHeartbeat,
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
      liveRead,
      ganttHistoryRecords,
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
      readJson(['driver', 'live', '--kind', 'worker', '--json']),
      readCarrierFileTail(
        dependencies.readFile,
        path.join(quayDir, QUAY_WORKER_OUTCOME_FILE),
        QUAY_GANTT_HISTORY_LIMIT,
      ),
    ]);

    // Fixed order, matching the panel's reading order, so the banner is deterministic.
    for (const read of [tasksRead, goalsRead, adrsRead, driverRead, configRead]) {
      if (read.warning) {
        warnings.push(read.warning);
      }
    }

    // The fan-in attempts feed two readings: the Fan-in card, and the in-flight tasks'
    // `phase` (a task holding an unreleased fan-in lock reads `'fan-in'`). Fold once.
    const fanInAttempts = summarizeFanInAttempts(fanInRecords);

    /**
     * Builds the Loop pulse lane set: quay's in-flight runs merged with the worker-outcome
     * history and packed onto ≤5 lanes — every step from quay's OWN kernel module.
     *
     * `null` means there is no reading: the installed plugin carries no kernel, or the
     * in-flight command did not answer. A kernel that IS present and returns zero intervals is
     * a real reading meaning the window is idle, so the two stay distinguishable — the same
     * null-vs-empty convention `inFlight` and `tests.current` follow.
     *
     * A failed `driver live` is NOT added to `warnings`: a plugin older than the `live` verb
     * is a normal state for a project that has not upgraded, not a fault of this panel.
     */
    const buildGantt = async (): Promise<QuayGanttLanes | null> => {
      if (liveRead.warning) {
        return null;
      }
      const inFlight = readInFlightRuns(liveRead.value);
      if (inFlight === null) {
        return null;
      }
      const kernel = await loadQuayKernel(projectPath);
      if (!kernel) {
        return null;
      }

      const nowMs = dependencies.now();
      const merged = kernel.mergeLiveAndHistoryIntervals(
        inFlight,
        ganttHistoryRecords,
        nowMs - windowHours * 3_600_000,
        nowMs,
      );
      const { lanes, overflow } = kernel.packLanes(merged);
      return { windowHours, nowMs, lanes, overflow };
    };

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
      inFlight: summarizeInFlightTasks(workerRoundRecord, fanInAttempts),
      gantt: await buildGantt(),
      dashboardUrl,
      warnings,
    };
  };

  /**
   * Loads (and caches) the snapshot for one project.
   *
   * The cache and the in-flight dedupe are keyed by `projectId` alone and are only used for
   * the DEFAULT window — that is the reading AC-247's `overview` fans out over, and its
   * contract is one entry per project. A panel that asks for a different window is asking a
   * different question about the same project, so it is computed on demand and neither read
   * from nor written to that cache; caching per window would silently serve a 3h lane set to
   * a 12h request.
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

  const getQuaySnapshot = async (
    projectId: string,
    options: QuaySnapshotOptions = {},
  ): Promise<QuaySnapshot | null> => {
    const projectPath = dependencies.resolveProjectPathById(projectId);
    if (!projectPath) {
      return null;
    }

    const windowHours = normalizeGanttWindowHours(options.windowHours);

    // A non-default window is a different question about the same project, so it is never
    // answered from the per-project cache (see `loadSnapshot`).
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

    return loadSnapshot(projectId, projectPath, windowHours);
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

  return {
    detectQuayConfig,
    runQuayCommand,
    getQuayStatus,
    getQuaySnapshot,
    getCachedSnapshot,
  };
}
