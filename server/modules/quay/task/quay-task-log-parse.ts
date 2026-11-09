import type { QuayCommandRunner } from '../read/quay-command-port.js';
import type { QuayTaskIndexReading, QuayTaskStatusRow } from '../read/quay-snapshot-types.js';

import type { QuayCapabilityReader } from './quay-capabilities.js';

/**
 * Pure readers for the `quay task log --json` carrier plus the event service's type-only
 * contracts (no runtime code, no I/O). The cursor store consumes the readers; the watch loop
 * in `quay-task-events.service.ts` consumes the contracts and keeps only its own runtime.
 */

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
export function transitionOrder(transition: QuayTaskStatusTransition): number {
  return transition.seq ?? transition.order ?? 0;
}

// ---------------------------------------------------------------------------
// The event service's type-only contracts. Declared here (erased at build time) so the
// service file stays the watch loop + timers rather than carrying a second type module.
// ---------------------------------------------------------------------------

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
