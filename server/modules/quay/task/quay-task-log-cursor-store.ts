import type { QuayCommandRunner } from '../read/quay-command-port.js';
import type { QuayTaskIndexReading, QuayTaskStatusRow } from '../read/quay-snapshot-types.js';

import {
  readTaskLogPage,
  transitionOrder,
  type QuayDirWatcher,
  type QuayTaskLogCursor,
  type QuayTaskStatusTransition,
} from './quay-task-log-parse.js';

/** The persisted cursor state of one active monitor. `unseeded` means "recompute on next poll". */
export type QuayTaskLogCursorSeed =
  | { kind: 'unseeded' }
  | { kind: 'iso'; value: string }
  | { kind: 'cursor'; value: QuayTaskLogCursor };

/** Upper bound on the per-project eventId dedupe ledger (the at-least-once window is one event). */
const SEEN_EVENT_ID_CAP = 5_000;

/** The read-only monitor state behind the capability/degration log and its criteria. */
export type QuayTaskEventsMonitorState = {
  state: 'off' | 'active' | 'degraded';
  reason: string | null;
  seedKind: 'unseeded' | 'iso' | 'cursor';
};

/** One project's live monitor. Consumers: `quay-task-events.service.ts`'s registry. */
export type QuayTaskEventsMonitor = {
  projectId: string;
  projectPath: string;
  quayDir: string;
  watcher: QuayDirWatcher;
  /** `degraded` while a `task log` retry is pending; the watcher stays open. */
  state: 'active' | 'degraded';
  degradedReason: string | null;
  /** The seed, dedupe ledger and carrier paging of this monitor. */
  cursors: QuayTaskLogCursorStore;
  lastActivityAtMs: number;
  debounceHandle: unknown;
  retryHandle: unknown;
  idleHandle: unknown;
  running: boolean;
  /** A change arrived while a poll was in flight: run exactly one more afterwards. */
  pending: boolean;
  backoffMs: number;
};

/**
 * The injectable boundaries of one monitor's cursor state and page application; the service
 * creates one per monitor with project-scoped closures plus its retry callback.
 */
export type QuayTaskLogCursorStoreDependencies = {
  /** The project whose `.quay/task-status-events.jsonl` is read through `task log`. */
  projectPath: string;
  /** The START instant of the last successful full load, or `null` when none has landed. */
  taskIndexLoadStartedAtMs(): number | null;
  /** The index as the service holds it (rows + the load instant the baseline check uses). */
  readTaskIndex(): QuayTaskIndexReading;
  /** Applies one already-vetted status to one known row; answers `false` when the row is gone. */
  updateTaskIndexRow(taskId: string, row: Pick<QuayTaskStatusRow, 'status' | 'updatedAt'>): boolean;
  /** Runs the whitelisted `task log` argv through the project-scoped adapter. */
  runCommand: QuayCommandRunner;
  /**
   * Called when one `task log` read fails. The caller owns the retry timer and backoff; the
   * store only stops paging and answers `failed` so the poll can return without resetting state.
   */
  onCommandFailure(reason: string): void;
  taskLogLimit: number;
  maxPages: number;
  commandTimeoutMs: number;
  seedLookbackMs: number;
};

/** One monitor's cursor state and carrier paging; `kind` is the seed kind the state reports. */
export type QuayTaskLogCursorStore = {
  readonly kind: QuayTaskLogCursorSeed['kind'];
  /**
   * Runs one bounded paging pass. `skipped` means no seed is derivable yet (the index has never
   * loaded); `failed` means `onCommandFailure` was called and the caller's retry timer is armed;
   * `done` carries whether the applied transitions require a full index load.
   */
  poll(): Promise<QuayTaskLogPollOutcome>;
  /** Drops the seed so the next poll re-derives it from the index's last load instant. */
  reset(): void;
};

/** The three terminal states of one bounded paging pass. */
export type QuayTaskLogPollOutcome =
  | { status: 'skipped' } | { status: 'failed' } | { status: 'done'; needsFullLoad: boolean };

/** Creates the cursor state machine for one monitor. See the type docs above for the contract. */
export function createTaskLogCursorStore(
  dependencies: QuayTaskLogCursorStoreDependencies,
): QuayTaskLogCursorStore {
  let seed: QuayTaskLogCursorSeed = { kind: 'unseeded' };
  const seenEventIds = new Set<string>();

  /** True the first time an eventId is seen; the at-least-once window only needs one event back. */
  const markSeen = (eventId: string): boolean => {
    if (seenEventIds.has(eventId)) {
      return false;
    }
    seenEventIds.add(eventId);
    if (seenEventIds.size > SEEN_EVENT_ID_CAP) {
      // The at-least-once window is one event, so the oldest entries can be dropped.
      const oldest = seenEventIds.values().next().value;
      if (oldest !== undefined) {
        seenEventIds.delete(oldest);
      }
    }
    return true;
  };

  const resetSeed = (): void => {
    seed = { kind: 'unseeded' };
  };

  /**
   * The `--since` argument for the next read. An unseeded monitor derives an ISO instant one
   * lookback window before the index's last successful load; without that load there is nothing
   * to resume from and the poll is skipped.
   */
  const resolveSeedArg = (): string | null => {
    if (seed.kind === 'cursor') {
      return JSON.stringify(seed.value);
    }
    if (seed.kind === 'iso') {
      return seed.value;
    }
    const loadStartedAtMs = dependencies.taskIndexLoadStartedAtMs();
    if (loadStartedAtMs === null) {
      return null;
    }
    const iso = new Date(loadStartedAtMs - dependencies.seedLookbackMs).toISOString();
    seed = { kind: 'iso', value: iso };
    return iso;
  };

  /**
   * Applies one page's transitions to the index. Ordering is by `seq` (the v1 sequence) so a
   * page that arrived out of order still lands the LAST transition on each task. Returns
   * whether an event requires a full load (a creation, or a task the index does not know).
   */
  const applyTransitions = (transitions: readonly QuayTaskStatusTransition[]): boolean => {
    let needsFullLoad = false;
    const baselineStartedAtMs = dependencies.taskIndexLoadStartedAtMs();
    const baselineMs = baselineStartedAtMs ?? dependencies.readTaskIndex().observedAtMs;

    for (const transition of transitions) {
      if (transition.kind === 'create') {
        needsFullLoad = true;
        continue;
      }
      if (!dependencies.readTaskIndex().tasks.has(transition.taskId)) {
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
      dependencies.updateTaskIndexRow(transition.taskId, {
        status: transition.to,
        updatedAt: transition.at,
      });
    }
    return needsFullLoad;
  };

  /** Pages the carrier, applying each page and advancing the cursor as the response dictates. */
  const poll = async (): Promise<QuayTaskLogPollOutcome> => {
    let needsFullLoad = false;
    let pages = 0;
    let sinceArg = resolveSeedArg();
    if (sinceArg === null) {
      // Nothing has been fully loaded yet: the caller's condition is "index loaded once".
      return { status: 'skipped' };
    }

    while (pages < dependencies.maxPages) {
      pages += 1;
      const sentCursor = seed.kind === 'cursor' ? seed.value : null;
      const result = await dependencies.runCommand(
        dependencies.projectPath,
        ['task', 'log', '--json', '--since', sinceArg, '--limit', String(dependencies.taskLogLimit)],
        { timeoutMs: dependencies.commandTimeoutMs },
      );
      if (!result.ok) {
        dependencies.onCommandFailure(
          result.error ?? `task log exited ${result.code === null ? 'abnormally' : result.code}`,
        );
        return { status: 'failed' };
      }

      const page = readTaskLogPage(result.stdout);
      if (page === null) {
        needsFullLoad = true;
        resetSeed();
        break;
      }

      const responseEpoch =
        page.tailCursor?.carrierEpoch ?? page.nextCursor?.carrierEpoch ?? null;
      const carrierRotated =
        page.rebase
        || (sentCursor !== null && responseEpoch !== null && responseEpoch !== sentCursor.carrierEpoch);
      if (carrierRotated) {
        needsFullLoad = true;
        resetSeed();
        break;
      }

      // Order first, then drop the events already applied: the last transition on each task wins.
      const fresh = page.transitions
        .slice()
        .sort((left, right) => transitionOrder(left) - transitionOrder(right))
        .filter((transition) => transition.eventId === null || markSeen(transition.eventId));
      if (applyTransitions(fresh)) {
        needsFullLoad = true;
      }

      const pageIsFull = page.transitions.length >= dependencies.taskLogLimit;
      if (pageIsFull && page.nextCursor !== null) {
        // A truncated page: follow it immediately (bounded by `maxPages`).
        seed = { kind: 'cursor', value: page.nextCursor };
        sinceArg = JSON.stringify(page.nextCursor);
        continue;
      }
      if (page.tailCursor !== null) {
        // The published tail is the authoritative resume point, ahead of any page cursor.
        seed = { kind: 'cursor', value: page.tailCursor };
      } else if (page.nextCursor !== null) {
        seed = { kind: 'cursor', value: page.nextCursor };
      }
      // A null `nextCursor` and no tail keep the ISO seed for the next poll.
      break;
    }

    return { status: 'done', needsFullLoad };
  };

  return {
    get kind() {
      return seed.kind;
    },
    poll,
    reset: resetSeed,
  };
}
