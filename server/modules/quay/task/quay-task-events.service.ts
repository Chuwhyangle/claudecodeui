import path from 'node:path';

import type {
  QuayTaskEventsDependencies,
  QuayTaskEventsTimers,
} from './quay-task-log-parse.js';
import {
  createTaskLogCursorStore,
  type QuayTaskEventsMonitor,
  type QuayTaskEventsMonitorState,
} from './quay-task-log-cursor-store.js';

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

const defaultTimers: QuayTaskEventsTimers = {
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => {
    if (handle !== null && handle !== undefined) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    }
  },
};

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
 *
 * Cursor state, the eventId dedupe ledger, carrier paging and page application live in
 * `quay-task-log-cursor-store.ts`; the pure page readers live in `quay-task-log-parse.ts`.
 * This file owns the `fs.watch` loop, the timers, and the monitor registry.
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

  const monitors = new Map<string, QuayTaskEventsMonitor>();
  /** Projects whose WATCHER failed: they fall back to the TTL path permanently for the process. */
  const degradedProjects = new Map<string, string>();
  /** Projects whose activation is in flight, so a read burst cannot start two probes. */
  const activating = new Set<string>();

  const disposeMonitor = (monitor: QuayTaskEventsMonitor): void => {
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

  const touch = (monitor: QuayTaskEventsMonitor): void => {
    monitor.lastActivityAtMs = dependencies.now();
    scheduleIdle(monitor);
  };

  function scheduleIdle(monitor: QuayTaskEventsMonitor): void {
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
    let oldest: QuayTaskEventsMonitor | null = null;
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

  const scheduleDebouncedPoll = (monitor: QuayTaskEventsMonitor): void => {
    if (monitor.debounceHandle !== null) {
      timers.clearTimeout(monitor.debounceHandle);
    }
    monitor.debounceHandle = timers.setTimeout(() => {
      monitor.debounceHandle = null;
      void runPoll(monitor);
    }, debounceMs);
  };

  const onDirEvent = (
    monitor: QuayTaskEventsMonitor,
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

  const onWatcherError = (monitor: QuayTaskEventsMonitor, error: Error): void => {
    const reason = error.message === '' ? 'watcher error' : error.message;
    log(
      `quay task events: watcher for ${monitor.quayDir} failed (${reason}); `
      + 'this project falls back to the TTL path',
    );
    disposeMonitor(monitor);
    degradedProjects.set(monitor.projectId, reason);
  };

  const degradeTaskLog = (monitor: QuayTaskEventsMonitor, reason: string): void => {
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
  const pollOnce = async (monitor: QuayTaskEventsMonitor): Promise<void> => {
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

    const outcome = await monitor.cursors.poll();
    if (outcome.status !== 'done') {
      // `skipped`: nothing has been fully loaded yet, so activation's condition ("the index
      // loaded once") is not met. `failed`: the store reported the reason and the retry timer
      // is armed; leave the degraded state exactly as it was.
      return;
    }

    monitor.state = 'active';
    monitor.degradedReason = null;
    monitor.backoffMs = retryBaseMs;
    if (outcome.needsFullLoad) {
      dependencies.requestTaskIndexLoad(monitor.projectId, {
        minIntervalMs: eventLoadMinIntervalMs,
      });
    }
  };

  /** Single-flight: a change during a poll schedules exactly ONE trailing poll. */
  const runPoll = async (monitor: QuayTaskEventsMonitor): Promise<void> => {
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

      const monitor: QuayTaskEventsMonitor = {
        projectId,
        projectPath,
        quayDir,
        watcher,
        state: 'active',
        degradedReason: null,
        cursors: createTaskLogCursorStore({
          projectPath,
          taskIndexLoadStartedAtMs: () => dependencies.taskIndexLoadStartedAtMs(projectId),
          readTaskIndex: () => dependencies.readTaskIndex(projectId),
          updateTaskIndexRow: (taskId, row) =>
            dependencies.updateTaskIndexRow(projectId, taskId, row),
          runCommand: dependencies.runCommand,
          onCommandFailure: (reason) => {
            const current = monitors.get(projectId);
            if (current !== undefined) {
              degradeTaskLog(current, reason);
            }
          },
          taskLogLimit,
          maxPages,
          commandTimeoutMs,
          seedLookbackMs,
        }),
        lastActivityAtMs: dependencies.now(),
        debounceHandle: null,
        retryHandle: null,
        idleHandle: null,
        running: false,
        pending: false,
        backoffMs: retryBaseMs,
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
        seedKind: monitor.cursors.kind,
      };
    },
  };
}
