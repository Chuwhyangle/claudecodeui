
import type { QuayCommandResult } from '../read/quay-command-port.js';
import { asRecord, parseJson, readUpdatedAtEpochMs } from '../read/quay-snapshot-summaries.js';
import {
  QUAY_TASK_INDEX_MAX_CONCURRENT_LOADS,
  QUAY_TASK_INDEX_MAX_STDOUT_BYTES,
  QUAY_TASK_INDEX_MIN_INTERVAL_MS,
  QUAY_TASK_INDEX_TITLE_LIMIT,
  QUAY_TASK_INDEX_TTL_MS,
  type QuayTaskIndexReading,
  type QuayTaskStatusRow,
} from '../read/quay-snapshot-types.js';

/**
 * The compact task status index (AC-348): a read model that NEVER waits on a subprocess.
 * It keeps the last full `task list --json --no-body` reading and AGES it (`ready` → `stale`),
 * so a reader can say how old its answer is; a background load is rate-limited per project and
 * capped process-wide. The event-driven refresh writes single rows through
 * `updateTaskIndexRow` without moving the reading's age.
 *
 * All mutable state lives in this factory's closure — the object is the lifecycle owner.
 * Consumers: `service/quay.service.ts` (the public surface) and the task-event service.
 */

export type QuayTaskIndexDependencies = {
  now(): number;
  resolveProjectPathById(projectId: string): string | null;
  onTaskIndexRead?: (projectId: string) => void;
  runQuayCommand(cwd: string, args: readonly string[], timeoutMs?: number): Promise<QuayCommandResult>;
};

export type QuayTaskIndex = {
  readTaskIndex(projectId: string): QuayTaskIndexReading;
  requestTaskIndexLoad(projectId: string, options?: { minIntervalMs?: number }): void;
  getTaskIndexLoadStartedAtMs(projectId: string): number | null;
  updateTaskIndexRow(
    projectId: string,
    taskId: string,
    row: Pick<QuayTaskStatusRow, 'status' | 'updatedAt'>,
  ): boolean;
};

export function createQuayTaskIndex(dependencies: QuayTaskIndexDependencies): QuayTaskIndex {
  const runQuayCommand = dependencies.runQuayCommand;

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
  // The START instant of the load that produced the CURRENT reading. Distinct from
  // `taskIndexLastStartedAt` (which also moves for a load that later fails): the event path's
  // ISO seed and its "an event older than the baseline must not roll back a manual edit" rule
  // both need the instant of the load whose rows are being read.
  const taskIndexBaselineStartedAt = new Map<string, number>();
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
    // The read hook fires on every read, including the event service's own poll-time read.
    // Consumers use it as an ACTIVITY signal (has this project been read in the last 10 min?),
    // never as a load trigger, so a fire-and-forget callback is the right shape here.
    dependencies.onTaskIndexRead?.(projectId);
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
      // `--no-body` rows still carry `goal_ac`; reading it from the SAME load is what lets the
      // session mention join answer a task's goal without a second CLI call.
      const goalAc =
        typeof record.goal_ac === 'string' && record.goal_ac.trim() !== '' ? record.goal_ac.trim() : null;
      tasks.set(String(record.id), {
        taskId: String(record.id),
        status: typeof record.status === 'string' ? record.status : 'unknown',
        // `readUpdatedAtEpochMs` has already refused anything a `Date` cannot hold.
        updatedAt: epochMs === null ? null : new Date(epochMs).toISOString(),
        title: typeof record.title === 'string' ? record.title.slice(0, QUAY_TASK_INDEX_TITLE_LIMIT) : '',
        goalAc,
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
   *
   * `options.minIntervalMs` lets the EVENT path ask for a shorter floor (5 s) than the TTL
   * path's {@link QUAY_TASK_INDEX_MIN_INTERVAL_MS}: a burst of creation events must not stall
   * for a minute, but it still must not turn into one `task list` per event. The exported TTL
   * constants themselves do not change.
   */
  const requestTaskIndexLoad = (
    projectId: string,
    options?: { minIntervalMs?: number },
  ): void => {
    const minIntervalMs = options?.minIntervalMs ?? QUAY_TASK_INDEX_MIN_INTERVAL_MS;
    if (taskIndexLoading.has(projectId) || taskIndexInFlight >= QUAY_TASK_INDEX_MAX_CONCURRENT_LOADS) {
      return;
    }
    const lastStartedAt = taskIndexLastStartedAt.get(projectId);
    if (lastStartedAt !== undefined && dependencies.now() - lastStartedAt < minIntervalMs) {
      return;
    }
    const projectPath = dependencies.resolveProjectPathById(projectId);
    if (!projectPath) {
      return;
    }

    const startedAtMs = dependencies.now();
    taskIndexLoading.add(projectId);
    taskIndexLastStartedAt.set(projectId, startedAtMs);
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
        // Only a SUCCESSFUL load moves the baseline: a failed refresh leaves the previous
        // rows (and their baseline) in place, which is what the event path must keep using.
        taskIndexBaselineStartedAt.set(projectId, startedAtMs);
      } catch (error) {
        recordTaskIndexFailure(projectId, error instanceof Error ? error.message : String(error));
      } finally {
        taskIndexLoading.delete(projectId);
        taskIndexInFlight -= 1;
      }
    })();
  };

  /**
   * The START instant of the full load that produced the current index rows, or `null` when no
   * successful load has landed. The event service derives its ISO seed from this (`start - 2 s`)
   * and compares each transition's `at` against it, so a manual edit the full read already saw
   * cannot be rolled back by an older event.
   */
  const getTaskIndexLoadStartedAtMs = (projectId: string): number | null =>
    taskIndexBaselineStartedAt.get(projectId) ?? null;

  /**
   * Applies one event-vetted status to one EXISTING row. Returns `false` when the project has
   * no index or the task is not in it (the caller then requests a full load rather than
   * inventing a row from an event, which carries no title and no goal_ac).
   *
   * The index's `observedAtMs`/baseline are deliberately untouched: the row changed from an
   * event, not from a full read, so the reading must keep ageing towards its TTL refresh.
   */
  const updateTaskIndexRow = (
    projectId: string,
    taskId: string,
    row: Pick<QuayTaskStatusRow, 'status' | 'updatedAt'>,
  ): boolean => {
    const entry = taskIndex.get(projectId);
    if (entry === undefined) {
      return false;
    }
    const existing = entry.tasks.get(taskId);
    if (existing === undefined) {
      return false;
    }
    entry.tasks.set(taskId, { ...existing, status: row.status, updatedAt: row.updatedAt });
    return true;
  };

  return {
    readTaskIndex,
    requestTaskIndexLoad,
    getTaskIndexLoadStartedAtMs,
    updateTaskIndexRow,
  };
}
