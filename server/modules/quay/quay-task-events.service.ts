import path from 'node:path';

import type { QuayCapabilityReader } from './quay-capabilities.js';
import type {
  QuayCommandRunner,
  QuayTaskIndexReading,
  QuayTaskStatusRow,
} from './quay.service.js';

/**
 * The opaque resume cursor printed by `quay task log --json` and accepted back verbatim as
 * `--since`. Delivery is AT-LEAST-ONCE (the resume is inclusive of the boundary event), so a
 * consumer MUST dedupe by `eventId` and MUST NOT re-serialise the cursor into a different key
 * order — the object is passed through exactly as the CLI printed it.
 */
export type QuayTaskLogCursor = {
  v: number;
  carrierEpoch: string;
  seq: number;
};

/**
 * One transition as `task log` prints it, narrowed to what the task index consumes. The
 * remaining v1 fields (`actor`, `cause`, `evidence`, `coverage`, …) are deliberately dropped:
 * this server's index stores status and time, nothing else.
 */
export type QuayTaskStatusTransition = {
  /** Carrier position (0-based line index); the fallback ordering key when `seq` is absent. */
  order: number | null;
  /** The v1 sequence number, or `null` on a legacy v0 record. */
  seq: number | null;
  /** The documented dedupe key; `null` on a legacy v0 record. */
  eventId: string | null;
  carrierEpoch: string | null;
  taskId: string;
  from: string | null;
  to: string | null;
  /** `create` for a creation event; otherwise the lifecycle edge name (`promote`, `retreat`, …). */
  kind: string | null;
  /** When the transition happened (ISO-8601). */
  at: string | null;
  /** When the carrier recorded it (ISO-8601); may lag `at`. */
  recordedAt: string | null;
};

/** One parsed page of the transition carrier. */
export type QuayTaskLogPage = {
  transitions: QuayTaskStatusTransition[];
  nextCursor: QuayTaskLogCursor | null;
  /** The (future) current-tail cursor; when present it is the authoritative seed. */
  tailCursor: QuayTaskLogCursor | null;
  rebase: boolean;
};

/** The timer boundary, injected so a criterion can advance a fake clock deterministically. */
export type QuayTaskEventsTimers = {
  setTimeout(handler: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
};

/** The directory-watch boundary. `watchPath` returns `null` when the directory is not watchable. */
export type QuayDirWatcher = {
  close(): void;
  onError(handler: (error: Error) => void): void;
};

/** The persisted cursor state of one active monitor. `unseeded` means "recompute on next poll". */
type CursorSeed =
  | { kind: 'unseeded' }
  | { kind: 'iso'; value: string }
  | { kind: 'cursor'; value: QuayTaskLogCursor };

/** One project's live monitor. */
type Monitor = {
  projectId: string;
  projectPath: string;
  quayDir: string;
  watcher: QuayDirWatcher;
  /** `degraded` while a `task log` retry is pending; the watcher stays open. */
  state: 'active' | 'degraded';
  degradedReason: string | null;
  seed: CursorSeed;
  lastActivityAtMs: number;
  debounceHandle: unknown;
  retryHandle: unknown;
  idleHandle: unknown;
  running: boolean;
  /** A change arrived while a poll was in flight: run exactly one more afterwards. */
  pending: boolean;
  backoffMs: number;
  seenEventIds: Set<string>;
};

/** The read-only monitor state behind the capability/degration log and its criteria. */
export type QuayTaskEventsMonitorState = {
  state: 'off' | 'active' | 'degraded';
  reason: string | null;
  seedKind: 'unseeded' | 'iso' | 'cursor';
};

/** The injectable boundaries of the event-driven task-index refresh. */
export type QuayTaskEventsDependencies = {
  now(): number;
  resolveProjectPathById(projectId: string): string | null;
  /** The index as the service holds it (rows + the load instant the baseline check uses). */
  readTaskIndex(projectId: string): QuayTaskIndexReading;
  /** The START instant of the last successful full load, or `null` when none has landed. */
  taskIndexLoadStartedAtMs(projectId: string): number | null;
  /**
   * Requests a background full load. The event path passes its own 5 s minimum interval so a
   * burst of creation events cannot turn into a `task list` storm, while the TTL path keeps the
   * service's 60 s interval.
   */
  requestTaskIndexLoad(projectId: string, options?: { minIntervalMs?: number }): void;
  /** Applies one already-vetted status to one known row; answers `false` when the row is gone. */
  updateTaskIndexRow(
    projectId: string,
    taskId: string,
    row: Pick<QuayTaskStatusRow, 'status' | 'updatedAt'>,
  ): boolean;
  capabilities: QuayCapabilityReader;
  /** Runs the whitelisted `task log` argv through the project-scoped adapter. */
  runCommand: QuayCommandRunner;
  /** Watches one directory; the callback's `filename` is `null` when the platform omits it. */
  watchPath(
    dirPath: string,
    onChange: (eventType: string, filename: string | null) => void,
  ): QuayDirWatcher | null;
  /**
   * Whether the watched directory is still at its path. Injected (default: assume present) so
   * the service stays filesystem-free; production binds `fs.existsSync`. It answers the one
   * event `fs.watch` cannot express: the watched directory ITSELF was renamed away, which
   * arrives as a `rename` of the directory's own basename while the watcher keeps following
   * the moved inode.
   */
  directoryExists?(dirPath: string): boolean;
  /** The lanes-cache invalidation seam, called when `worker-dispatch.json` changes. */
  onDispatchFileChanged(projectId: string): void;
  log?(message: string): void;
  timers?: QuayTaskEventsTimers;
  /** Registers the process-exit teardown. Defaults to `process.once('exit', …)`. */
  registerExitHook?(handler: () => void): void;
  debounceMs?: number;
  idleTimeoutMs?: number;
  maxActiveMonitors?: number;
  taskLogLimit?: number;
  maxPages?: number;
  eventLoadMinIntervalMs?: number;
  retryBaseMs?: number;
  retryCapMs?: number;
  commandTimeoutMs?: number;
  seedLookbackMs?: number;
};

/** The service surface the composition root wires into the quay service's read hook. */
export type QuayTaskEventsService = {
  /** Records a read of one project's index; activates a monitor when the conditions hold. */
  noteProjectRead(projectId: string): void;
  /** Ensures a monitor is active for one project (idempotent; never throws). */
  ensureMonitored(projectId: string): Promise<void>;
  /** Runs one refresh cycle now (the retry timer and criteria use this seam). */
  pollProject(projectId: string): Promise<void>;
  /** Closes every watcher and clears every timer (process exit). */
  stopAll(): void;
  /** The monitor's current state, for the capability/degration log and its criteria. */
  readMonitorState(projectId: string): QuayTaskEventsMonitorState;
};

const TASK_STATUS_EVENTS_FILE = 'task-status-events.jsonl';
const WORKER_DISPATCH_FILE = 'worker-dispatch.json';

const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_IDLE_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_ACTIVE_MONITORS = 16;
const DEFAULT_TASK_LOG_LIMIT = 500;
const DEFAULT_MAX_PAGES = 5;
const DEFAULT_EVENT_LOAD_MIN_INTERVAL_MS = 5_000;
const DEFAULT_RETRY_BASE_MS = 5_000;
const DEFAULT_RETRY_CAP_MS = 60_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 8_000;
const DEFAULT_SEED_LOOKBACK_MS = 2_000;
/** Upper bound on the per-project eventId dedupe ledger (the at-least-once window is one event). */
const SEEN_EVENT_ID_CAP = 5_000;

const defaultTimers: QuayTaskEventsTimers = {
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => {
    if (handle !== null && handle !== undefined) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    }
  },
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * A response cursor, normalised to exactly the three documented keys in their documented
 * order. Rebuilding (rather than passing the parsed object through) is what guarantees the
 * next `--since` is the three-key shape the whitelist accepts, while preserving the cursor's
 * VALUES verbatim (`v`, `carrierEpoch`, `seq`).
 */
export function readTaskLogCursor(value: unknown): QuayTaskLogCursor | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const keys = Object.keys(record);
  if (keys.length !== 3 || !keys.includes('v') || !keys.includes('carrierEpoch') || !keys.includes('seq')) {
    return null;
  }
  if (record.v !== 1) {
    return null;
  }
  if (typeof record.carrierEpoch !== 'string' || record.carrierEpoch.length === 0) {
    return null;
  }
  if (typeof record.seq !== 'number' || !Number.isInteger(record.seq) || record.seq < 0) {
    return null;
  }
  // The key order is fixed here, so the serialised cursor is stable across resumes.
  return { v: 1, carrierEpoch: record.carrierEpoch, seq: record.seq };
}

/** One transition object, or `null` when it is missing a field the index cannot work without. */
function readTransition(value: unknown): QuayTaskStatusTransition | null {
  const record = asRecord(value);
  if (record === null || typeof record.taskId !== 'string' || record.taskId === '') {
    return null;
  }
  const readStringOrNull = (key: string): string | null => {
    const raw = record[key];
    if (raw === undefined || raw === null) {
      return null;
    }
    return typeof raw === 'string' ? raw : null;
  };
  return {
    order: asNumber(record.order),
    seq: asNumber(record.seq),
    eventId: asString(record.eventId),
    carrierEpoch: asString(record.carrierEpoch),
    taskId: record.taskId,
    from: readStringOrNull('from'),
    to: readStringOrNull('to'),
    kind: readStringOrNull('kind'),
    at: readStringOrNull('at'),
    recordedAt: readStringOrNull('recordedAt'),
  };
}

/**
 * Parses one `task log --json` page. `null` means the document is not the contract (invalid
 * JSON, a missing `transitions` array, a malformed cursor, or a transition missing its task
 * id) — the caller treats that as a full-resync, never as an empty page.
 */
export function readTaskLogPage(stdout: string): QuayTaskLogPage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return null;
  }
  const document = asRecord(parsed);
  if (document === null) {
    return null;
  }
  if (!Array.isArray(document.transitions)) {
    return null;
  }
  if (!Object.prototype.hasOwnProperty.call(document, 'nextCursor')) {
    return null;
  }
  const nextCursor = document.nextCursor === null ? null : readTaskLogCursor(document.nextCursor);
  if (document.nextCursor !== null && nextCursor === null) {
    return null;
  }

  let tailCursor: QuayTaskLogCursor | null = null;
  if (Object.prototype.hasOwnProperty.call(document, 'tailCursor') && document.tailCursor !== null) {
    tailCursor = readTaskLogCursor(document.tailCursor);
    if (tailCursor === null) {
      return null;
    }
  }

  const transitions: QuayTaskStatusTransition[] = [];
  for (const item of document.transitions) {
    const transition = readTransition(item);
    if (transition === null) {
      return null;
    }
    transitions.push(transition);
  }

  return {
    transitions,
    nextCursor,
    tailCursor,
    // `complete` is always false on this host's quay (no reconcile scheduler) and is ignored;
    // `rebase` is the only response flag that changes the cursor's meaning.
    rebase: document.rebase === true,
  };
}

/** The ordering key of one transition: the v1 seq, else the carrier position. */
function transitionOrder(transition: QuayTaskStatusTransition): number {
  return transition.seq ?? transition.order ?? 0;
}

/**
 * Creates the event-driven task-index refresh.
 *
 * Consumers: `quay.module.ts` (composition; its `onTaskIndexRead` calls `noteProjectRead`,
 * and `onDispatchFileChanged` invalidates the lanes cache) and
 * `server/modules/quay/tests/quay-live-refresh.test.ts`.
 *
 * The full `task list --json --no-body` TTL path is NOT touched or shortened here: events
 * accelerate a status change, they never replace the periodic full read (the carrier has no
 * reconcile scheduler on this host and manual edits emit no event).
 */
export function createQuayTaskEvents(
  dependencies: QuayTaskEventsDependencies,
): QuayTaskEventsService {
  const timers = dependencies.timers ?? defaultTimers;
  const log = dependencies.log ?? ((message: string) => console.log(message));
  const debounceMs = dependencies.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const idleTimeoutMs = dependencies.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maxActiveMonitors = dependencies.maxActiveMonitors ?? DEFAULT_MAX_ACTIVE_MONITORS;
  const taskLogLimit = dependencies.taskLogLimit ?? DEFAULT_TASK_LOG_LIMIT;
  const maxPages = dependencies.maxPages ?? DEFAULT_MAX_PAGES;
  const eventLoadMinIntervalMs =
    dependencies.eventLoadMinIntervalMs ?? DEFAULT_EVENT_LOAD_MIN_INTERVAL_MS;
  const retryBaseMs = dependencies.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const retryCapMs = dependencies.retryCapMs ?? DEFAULT_RETRY_CAP_MS;
  const commandTimeoutMs = dependencies.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const seedLookbackMs = dependencies.seedLookbackMs ?? DEFAULT_SEED_LOOKBACK_MS;
  const directoryExists = dependencies.directoryExists ?? (() => true);

  const monitors = new Map<string, Monitor>();
  /** Projects whose WATCHER failed: they fall back to the TTL path permanently for the process. */
  const degradedProjects = new Map<string, string>();
  /** Projects whose activation is in flight, so a read burst cannot start two probes. */
  const activating = new Set<string>();

  const disposeMonitor = (monitor: Monitor): void => {
    if (monitor.debounceHandle !== null) {
      timers.clearTimeout(monitor.debounceHandle);
      monitor.debounceHandle = null;
    }
    if (monitor.retryHandle !== null) {
      timers.clearTimeout(monitor.retryHandle);
      monitor.retryHandle = null;
    }
    if (monitor.idleHandle !== null) {
      timers.clearTimeout(monitor.idleHandle);
      monitor.idleHandle = null;
    }
    try {
      monitor.watcher.close();
    } catch {
      // Closing an already-closed watcher is a no-op, not a failure of the teardown.
    }
    monitors.delete(monitor.projectId);
  };

  const touch = (monitor: Monitor): void => {
    monitor.lastActivityAtMs = dependencies.now();
    scheduleIdle(monitor);
  };

  function scheduleIdle(monitor: Monitor): void {
    if (monitor.idleHandle !== null) {
      timers.clearTimeout(monitor.idleHandle);
    }
    monitor.idleHandle = timers.setTimeout(() => {
      monitor.idleHandle = null;
      if (monitors.get(monitor.projectId) !== monitor) {
        return;
      }
      if (dependencies.now() - monitor.lastActivityAtMs < idleTimeoutMs) {
        scheduleIdle(monitor);
        return;
      }
      log(`quay task events: idle for ${idleTimeoutMs} ms, stopped watching ${monitor.quayDir}`);
      disposeMonitor(monitor);
    }, idleTimeoutMs);
  }

  const evictLeastRecentlyUsed = (): void => {
    let oldest: Monitor | null = null;
    for (const monitor of monitors.values()) {
      if (oldest === null || monitor.lastActivityAtMs < oldest.lastActivityAtMs) {
        oldest = monitor;
      }
    }
    if (oldest !== null) {
      log(
        `quay task events: active monitor limit ${maxActiveMonitors} reached, evicting `
        + `least-recently-used ${oldest.projectPath}`,
      );
      disposeMonitor(oldest);
    }
  };

  const scheduleDebouncedPoll = (monitor: Monitor): void => {
    if (monitor.debounceHandle !== null) {
      timers.clearTimeout(monitor.debounceHandle);
    }
    monitor.debounceHandle = timers.setTimeout(() => {
      monitor.debounceHandle = null;
      void runPoll(monitor);
    }, debounceMs);
  };

  const onDirEvent = (
    monitor: Monitor,
    _eventType: string,
    filename: string | null,
  ): void => {
    const dirName = path.basename(monitor.quayDir);
    if (filename === null || filename === dirName) {
      // `fs.watch` reports the removal/rename of the WATCHED DIRECTORY itself as a `rename`
      // of its own basename (measured: `EVENT rename "<dir basename>"`), and keeps following
      // the moved inode. That is not a status event: re-check the path and either re-watch it
      // (it still exists) or go off (this project falls back to the TTL path and the next read
      // re-activates it).
      if (!directoryExists(monitor.quayDir)) {
        log(
          `quay task events: ${monitor.quayDir} no longer exists; `
          + 'the monitor is off and this project falls back to the TTL path',
        );
        disposeMonitor(monitor);
        return;
      }
      if (filename === null) {
        // The platform omitted the name and the directory is still there: treat it as a
        // status change, because it cannot be filtered.
        scheduleDebouncedPoll(monitor);
        return;
      }
      // Renamed and re-created at the same path: the old watcher follows the OLD inode, so
      // replace it. `ensureMonitored` opens a fresh watcher on the current directory.
      log(`quay task events: ${monitor.quayDir} was replaced; re-watching it`);
      disposeMonitor(monitor);
      void ensureMonitored(monitor.projectId).catch(() => undefined);
      return;
    }
    if (filename === TASK_STATUS_EVENTS_FILE) {
      scheduleDebouncedPoll(monitor);
      return;
    }
    if (filename === WORKER_DISPATCH_FILE) {
      touch(monitor);
      // The dispatch carrier is a lanes-cache invalidation signal only; it never supplies a
      // phase and never triggers a task-log read.
      dependencies.onDispatchFileChanged(monitor.projectId);
      return;
    }
    // Every other filename (e.g. `gate-events.jsonl`) is ignored: no spawn, no invalidation.
  };

  const onWatcherError = (monitor: Monitor, error: Error): void => {
    const reason = error.message === '' ? 'watcher error' : error.message;
    log(
      `quay task events: watcher for ${monitor.quayDir} failed (${reason}); `
      + 'this project falls back to the TTL path',
    );
    disposeMonitor(monitor);
    degradedProjects.set(monitor.projectId, reason);
  };

  const resolveSeedArg = (monitor: Monitor): string | null => {
    if (monitor.seed.kind === 'cursor') {
      return JSON.stringify(monitor.seed.value);
    }
    if (monitor.seed.kind === 'iso') {
      return monitor.seed.value;
    }
    const loadStartedAtMs = dependencies.taskIndexLoadStartedAtMs(monitor.projectId);
    if (loadStartedAtMs === null) {
      return null;
    }
    const iso = new Date(loadStartedAtMs - seedLookbackMs).toISOString();
    monitor.seed = { kind: 'iso', value: iso };
    return iso;
  };

  const resetSeed = (monitor: Monitor): void => {
    monitor.seed = { kind: 'unseeded' };
  };

  const markSeen = (monitor: Monitor, eventId: string): boolean => {
    if (monitor.seenEventIds.has(eventId)) {
      return false;
    }
    monitor.seenEventIds.add(eventId);
    if (monitor.seenEventIds.size > SEEN_EVENT_ID_CAP) {
      // The at-least-once window is one event, so the oldest entries can be dropped.
      const oldest = monitor.seenEventIds.values().next().value;
      if (oldest !== undefined) {
        monitor.seenEventIds.delete(oldest);
      }
    }
    return true;
  };

  /**
   * Applies one page's transitions to the index. Ordering is by `seq` (the v1 sequence) so a
   * page that arrived out of order still lands the LAST transition on each task. Returns
   * whether an event requires a full load (a creation, or a task the index does not know).
   */
  const applyTransitions = (
    monitor: Monitor,
    transitions: readonly QuayTaskStatusTransition[],
  ): { needsFullLoad: boolean } => {
    let needsFullLoad = false;
    const baselineStartedAtMs = dependencies.taskIndexLoadStartedAtMs(monitor.projectId);
    const baselineMs = baselineStartedAtMs ?? dependencies.readTaskIndex(monitor.projectId).observedAtMs;

    const ordered = [...transitions].sort((left, right) => transitionOrder(left) - transitionOrder(right));
    for (const transition of ordered) {
      if (transition.eventId !== null && !markSeen(monitor, transition.eventId)) {
        continue;
      }
      if (transition.kind === 'create') {
        needsFullLoad = true;
        continue;
      }
      if (!dependencies.readTaskIndex(monitor.projectId).tasks.has(transition.taskId)) {
        needsFullLoad = true;
        continue;
      }
      if (transition.to === null) {
        needsFullLoad = true;
        continue;
      }
      const atMs = transition.at === null ? null : Date.parse(transition.at);
      // A transition older than the row's baseline load cannot roll back a manual edit the
      // full read already saw; the row keeps the read state and the event is consumed.
      if (baselineMs !== null && atMs !== null && Number.isFinite(atMs) && atMs < baselineMs) {
        continue;
      }
      dependencies.updateTaskIndexRow(monitor.projectId, transition.taskId, {
        status: transition.to,
        updatedAt: transition.at,
      });
    }
    return { needsFullLoad };
  };

  const degradeTaskLog = (monitor: Monitor, reason: string): void => {
    monitor.state = 'degraded';
    monitor.degradedReason = reason;
    const delayMs = monitor.backoffMs;
    monitor.backoffMs = Math.min(monitor.backoffMs * 2, retryCapMs);
    log(
      `quay task events: task log failed for ${monitor.projectPath} (${reason}); `
      + `retrying in ${delayMs} ms`,
    );
    if (monitor.retryHandle !== null) {
      timers.clearTimeout(monitor.retryHandle);
    }
    monitor.retryHandle = timers.setTimeout(() => {
      monitor.retryHandle = null;
      if (monitors.get(monitor.projectId) !== monitor) {
        return;
      }
      monitor.state = 'active';
      void runPoll(monitor);
    }, delayMs);
  };

  /** One poll: pages the transition carrier and applies it. Never throws. */
  const pollOnce = async (monitor: Monitor): Promise<void> => {
    touch(monitor);

    const capabilities = dependencies.capabilities.read(monitor.projectPath);
    if (capabilities.taskLog !== 'available') {
      // A verb that disappeared is "no more events", not "retry forever": stop watching and
      // leave the TTL path, exactly as an absent verb never got a monitor in the first place.
      log(
        `quay task events: task log is ${capabilities.taskLog} for ${monitor.projectPath}; `
        + 'stopping the event path and leaving the TTL path',
      );
      disposeMonitor(monitor);
      return;
    }

    let needsFullLoad = false;
    let pages = 0;
    let sinceArg = resolveSeedArg(monitor);
    if (sinceArg === null) {
      // Nothing has been fully loaded yet: the caller's condition is "index loaded once".
      return;
    }

    while (pages < maxPages) {
      pages += 1;
      const sentCursor = monitor.seed.kind === 'cursor' ? monitor.seed.value : null;
      const result = await dependencies.runCommand(
        monitor.projectPath,
        ['task', 'log', '--json', '--since', sinceArg, '--limit', String(taskLogLimit)],
        { timeoutMs: commandTimeoutMs },
      );
      if (!result.ok) {
        degradeTaskLog(
          monitor,
          result.error ?? `task log exited ${result.code === null ? 'abnormally' : result.code}`,
        );
        return;
      }

      const page = readTaskLogPage(result.stdout);
      if (page === null) {
        needsFullLoad = true;
        resetSeed(monitor);
        break;
      }

      const responseEpoch =
        page.tailCursor?.carrierEpoch ?? page.nextCursor?.carrierEpoch ?? null;
      const carrierRotated =
        page.rebase
        || (sentCursor !== null && responseEpoch !== null && responseEpoch !== sentCursor.carrierEpoch);
      if (carrierRotated) {
        needsFullLoad = true;
        resetSeed(monitor);
        break;
      }

      const applied = applyTransitions(monitor, page.transitions);
      if (applied.needsFullLoad) {
        needsFullLoad = true;
      }

      const pageIsFull = page.transitions.length >= taskLogLimit;
      if (pageIsFull && page.nextCursor !== null) {
        // A truncated page: follow it immediately (bounded by `maxPages`).
        monitor.seed = { kind: 'cursor', value: page.nextCursor };
        sinceArg = JSON.stringify(page.nextCursor);
        continue;
      }
      if (page.tailCursor !== null) {
        // The published tail is the authoritative resume point, ahead of any page cursor.
        monitor.seed = { kind: 'cursor', value: page.tailCursor };
      } else if (page.nextCursor !== null) {
        monitor.seed = { kind: 'cursor', value: page.nextCursor };
      }
      // A null `nextCursor` and no tail keep the ISO seed for the next poll.
      break;
    }

    monitor.state = 'active';
    monitor.degradedReason = null;
    monitor.backoffMs = retryBaseMs;
    if (needsFullLoad) {
      dependencies.requestTaskIndexLoad(monitor.projectId, {
        minIntervalMs: eventLoadMinIntervalMs,
      });
    }
  };

  /** Single-flight: a change during a poll schedules exactly ONE trailing poll. */
  const runPoll = async (monitor: Monitor): Promise<void> => {
    if (monitor.running) {
      monitor.pending = true;
      return;
    }
    monitor.running = true;
    try {
      await pollOnce(monitor);
    } catch (error) {
      degradeTaskLog(monitor, error instanceof Error ? error.message : String(error));
    } finally {
      monitor.running = false;
      if (monitor.pending) {
        monitor.pending = false;
        if (monitors.get(monitor.projectId) === monitor) {
          void runPoll(monitor);
        }
      }
    }
  };

  const ensureMonitored = async (projectId: string): Promise<void> => {
    if (monitors.has(projectId) || degradedProjects.has(projectId) || activating.has(projectId)) {
      const existing = monitors.get(projectId);
      if (existing !== undefined) {
        touch(existing);
      }
      return;
    }

    // Marked BEFORE the index read below: `readTaskIndex` calls the service's read hook,
    // which calls back into `noteProjectRead` → `ensureMonitored`. Without this guard that
    // would recurse until the capability probe is reached.
    activating.add(projectId);
    try {
      const projectPath = dependencies.resolveProjectPathById(projectId);
      if (projectPath === null) {
        return;
      }
      // Condition 1: the index must have loaded successfully at least once.
      if (dependencies.readTaskIndex(projectId).observedAtMs === null) {
        return;
      }

      // Condition 2: `task log` must be available. `absent` and `unknown` both mean NO
      // monitor and zero `task log` spawns; an `unknown` is retried on the next read once its
      // backoff expires.
      const capabilities = await dependencies.capabilities.probe(projectPath);
      if (capabilities.taskLog !== 'available') {
        return;
      }
      if (monitors.has(projectId) || degradedProjects.has(projectId)) {
        return;
      }

      const quayDir = path.join(projectPath, '.quay');
      // Condition 3 (dir exists) is the watcher's own answer: a missing directory is `null`
      // (project off, next activation retries), never a throw.
      const watcher = dependencies.watchPath(quayDir, (_eventType, filename) => {
        const monitor = monitors.get(projectId);
        if (monitor !== undefined) {
          onDirEvent(monitor, _eventType, filename);
        }
      });
      if (watcher === null) {
        log(`quay task events: ${quayDir} is not watchable; ${projectPath} stays on the TTL path`);
        return;
      }

      if (monitors.size >= maxActiveMonitors) {
        evictLeastRecentlyUsed();
      }

      const monitor: Monitor = {
        projectId,
        projectPath,
        quayDir,
        watcher,
        state: 'active',
        degradedReason: null,
        seed: { kind: 'unseeded' },
        lastActivityAtMs: dependencies.now(),
        debounceHandle: null,
        retryHandle: null,
        idleHandle: null,
        running: false,
        pending: false,
        backoffMs: retryBaseMs,
        seenEventIds: new Set(),
      };
      monitors.set(projectId, monitor);
      watcher.onError((error) => onWatcherError(monitor, error));
      scheduleIdle(monitor);
      log(`quay task events: watching ${quayDir} (task log available)`);
    } finally {
      activating.delete(projectId);
    }
  };

  const stopAll = (): void => {
    for (const monitor of [...monitors.values()]) {
      disposeMonitor(monitor);
    }
  };

  if (dependencies.registerExitHook !== undefined) {
    dependencies.registerExitHook(stopAll);
  } else {
    process.once('exit', stopAll);
  }

  return {
    noteProjectRead: (projectId) => {
      const monitor = monitors.get(projectId);
      if (monitor !== undefined) {
        touch(monitor);
        return;
      }
      if (degradedProjects.has(projectId)) {
        return;
      }
      // Activation is async (it probes `--help`); the read path must not wait on it.
      void ensureMonitored(projectId).catch((error: unknown) => {
        log(
          `quay task events: could not activate ${projectId}: `
          + `${error instanceof Error ? error.message : String(error)}`,
        );
      });
    },
    ensureMonitored,
    pollProject: async (projectId) => {
      const monitor = monitors.get(projectId);
      if (monitor !== undefined) {
        await runPoll(monitor);
      }
    },
    stopAll,
    readMonitorState: (projectId) => {
      const degradedReason = degradedProjects.get(projectId);
      if (degradedReason !== undefined) {
        return { state: 'degraded', reason: degradedReason, seedKind: 'unseeded' };
      }
      const monitor = monitors.get(projectId);
      if (monitor === undefined) {
        return { state: 'off', reason: null, seedKind: 'unseeded' };
      }
      return {
        state: monitor.state,
        reason: monitor.degradedReason,
        seedKind: monitor.seed.kind,
      };
    },
  };
}
