import path from 'node:path';

import type { QuayFileReader } from './quay.service.js';

/**
 * The largest `worker-dispatch.json` this reader will evaluate. The carrier is the worker
 * driver's small per-task index (a handful of fields per in-flight task), so anything this
 * large is not the document we think it is; it is refused WHOLE rather than half-read into a
 * misleading "no tasks running" answer.
 */
export const QUAY_DISPATCH_MAX_BYTES = 1024 * 1024;

/** The only path this reader is allowed to touch, relative to the project root. */
const QUAY_DISPATCH_RELATIVE_PATH = path.join('.quay', 'worker-dispatch.json');

/**
 * One in-flight dispatch record, evaluated against the live process table.
 *
 * `live` means the recorded `workerPid` exists; `residue` means it does not — the driver writes
 * atomically and deletes on terminal, so a record outliving its process is a crash residue, not
 * a running worker. `EPERM` from the liveness probe counts as LIVE: the process exists but this
 * server may not signal it.
 */
export type QuayDispatchEntry = {
  taskId: string;
  runId: string | null;
  workerPid: number | null;
  startedAtMs: number | null;
  timeoutDeadlineMs: number | null;
  cmdlineFingerprint: string | null;
  state: 'live' | 'residue';
};

/**
 * The four-state reading of a project's dispatch carrier.
 *
 * The states are deliberately distinct: `absent` (no file), `empty` (`{}` — the driver's own
 * "nothing in flight" shape), `present` (entries, each judged live/residue), and
 * `not-evaluated` (unreadable: invalid JSON, not an object, over the size ceiling). Collapsing
 * `not-evaluated` into `empty` would report "nothing is running" for a document we could not
 * read, which is exactly the false-empty a caller must be able to tell apart.
 */
export type QuayDispatchSet =
  | { state: 'absent' }
  | { state: 'empty' }
  | { state: 'present'; entries: QuayDispatchEntry[] }
  | { state: 'not-evaluated'; reason: string };

/** The injectable boundaries of the dispatch carrier reader. */
export type QuayDispatchCarrierDependencies = {
  /** CloudCLI project id → the project root the carrier path is joined under. */
  resolveProjectPathById(projectId: string): string | null;
  /** The service's read-only filesystem boundary (stat size + whole-file UTF-8 read). */
  readFile: QuayFileReader;
  /** Whether `pid` names a live process; `EPERM` must answer `true`. Injected for determinism. */
  isProcessAlive(pid: number): boolean;
  /** Override the size ceiling (tests); defaults to {@link QUAY_DISPATCH_MAX_BYTES}. */
  maxBytes?: number;
};

/** The read-only dispatch carrier surface consumed by `quay.module.ts` / the panel. */
export type QuayDispatchCarrier = {
  /** Reads one project's `<projectRoot>/.quay/worker-dispatch.json` and evaluates each entry. */
  readDispatchSet(projectId: string): Promise<QuayDispatchSet>;
};

/** A finite, integer-valued number from an untyped record field, or `null`. */
function readInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const numeric = Number(value);
    return Number.isInteger(numeric) ? numeric : null;
  }
  return null;
}

/** A non-empty string field, or `null`. */
function readString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Creates the read-only `worker-dispatch.json` reader.
 *
 * Consumers: `quay.module.ts` exposes it as `quayDispatchCarrier`; `quay-task-events.service.ts`
 * uses the file's CHANGE (never its contents) as the lanes-cache invalidation signal. This
 * reader deliberately provides no `phase` — phase stays a lanes-only reading.
 */
export function createQuayDispatchCarrier(
  dependencies: QuayDispatchCarrierDependencies,
): QuayDispatchCarrier {
  const maxBytes = dependencies.maxBytes ?? QUAY_DISPATCH_MAX_BYTES;

  const readDispatchSet = async (projectId: string): Promise<QuayDispatchSet> => {
    const projectPath = dependencies.resolveProjectPathById(projectId);
    if (projectPath === null) {
      return { state: 'not-evaluated', reason: `unknown project ${projectId}` };
    }

    // The path is built from the project root here, never accepted from a request, so a caller
    // cannot make this reader stat or read an arbitrary file.
    const filePath = path.join(projectPath, QUAY_DISPATCH_RELATIVE_PATH);

    let size: number | null;
    try {
      size = await dependencies.readFile.size(filePath);
    } catch {
      size = null;
    }
    if (size === null) {
      return { state: 'absent' };
    }
    if (size > maxBytes) {
      return {
        state: 'not-evaluated',
        reason: `${filePath} is ${size} bytes, above the ${maxBytes}-byte ceiling`,
      };
    }

    let text: string;
    try {
      text = await dependencies.readFile.readText(filePath);
    } catch (error) {
      return {
        state: 'not-evaluated',
        reason: `${filePath} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      return {
        state: 'not-evaluated',
        reason: `${filePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { state: 'not-evaluated', reason: `${filePath} is not a JSON object` };
    }

    const entries: QuayDispatchEntry[] = [];
    for (const [taskId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        continue;
      }
      const record = value as Record<string, unknown>;
      const workerPid = readInteger(record.workerPid);
      entries.push({
        taskId,
        runId: readString(record.runId),
        workerPid,
        startedAtMs: readInteger(record.startedAtMs),
        timeoutDeadlineMs: readInteger(record.timeoutDeadlineMs),
        cmdlineFingerprint: readString(record.cmdlineFingerprint),
        // No usable pid means no live process was identified; that is residue, never live.
        state: workerPid !== null && dependencies.isProcessAlive(workerPid) ? 'live' : 'residue',
      });
    }

    if (entries.length === 0) {
      return { state: 'empty' };
    }
    return { state: 'present', entries };
  };

  return { readDispatchSet };
}
