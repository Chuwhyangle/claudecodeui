import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The ONE quay-fleet child-process pipeline shared by the Quay module's CLI readers.
 *
 * WHY THIS EXISTS. Four sibling modules — the locator, the project-id join, the interface-session
 * registry and the initiatives view — each carried a byte-for-byte copy of `defaultExecFile` and
 * `parseJsonObject`; two carried `canonicalPath`, and two carried the same "resolve the binary,
 * report a fixed error when there is none, otherwise execute" runner. Every copy promised the
 * same thing in a comment and every copy could drift on its own (indeed the locator's handshake
 * wording already differed from the other three). This file is the one definition: consumers
 * inject the same seams they always did, the failure text stays verbatim, and a change to the
 * classification has one place to land.
 *
 * NOTHING HERE THROWS. A failed spawn, a timeout and an unreadable document are all readings,
 * because every consumer is a server surface that must keep answering when the fleet is absent.
 *
 * Import discipline (AC-394): this leaf imports only `node:*` and its own directory's siblings,
 * so it adds no cross-directory edge in `server/`.
 */

/** Bound on one ordinary fleet CLI invocation (registry / initiative reads). */
export const QUAY_FLEET_TIMEOUT_MS = 10_000;

/** Default cap on captured stdout — 1 MiB; the initiatives reader passes its own 2 MiB bound. */
export const QUAY_FLEET_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * The fixed reading when no binary was found. Consumers surface this sentence verbatim, so it
 * lives once rather than in a copy per reader.
 */
export const QUAY_FLEET_BIN_NOT_FOUND_REASON =
  'quay-fleet was not found (checked QUAY_FLEET_BIN, PATH and ~/.quay-fleet/bin/quay-fleet)';

/** The answer to one fleet CLI invocation, in the same shape every quay adapter uses. */
export type QuayFleetCommandResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  /** Why the child could not be run or answered with a failure, when that is known. */
  error?: string;
  /**
   * Node's own STRING error code for a failure that carried no exit status — `ENOENT` for a
   * missing binary, `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` for a child that outran `maxBuffer`.
   *
   * Kept because the two share `code: null` and would otherwise be indistinguishable to a
   * consumer: a maxBuffer kill still delivered the bytes captured before the kill, while an
   * ENOENT delivered nothing. The cockpit's card provider uses exactly that difference to
   * salvage the complete JSONL prefix instead of discarding the whole batch.
   */
  errorCode?: string;
};

/** The options one child invocation is spawned with; every consumer uses the same shape. */
export type QuayFleetExecOptions = {
  timeout: number;
  maxBuffer: number;
  encoding: 'utf8';
  windowsHide: boolean;
};

/** The child-process seam; production binds {@link defaultQuayFleetExec}, a test may bind a stub. */
export type QuayFleetExec = (
  file: string,
  args: readonly string[],
  options: QuayFleetExecOptions,
) => Promise<QuayFleetCommandResult>;

/** The shape `execFile` reports a failed child in: an `Error` carrying a code and a kill flag. */
type QuayFleetExecError = Error & { code?: number | string | null; killed?: boolean };

/**
 * Binds Node's `execFile` and turns every failure into a value. Consumers: the locator (with
 * `quay-fleet --version` as the label), the project-id join, the registry and the initiatives
 * view (all with the plain `quay-fleet` label).
 *
 * The classification is the contract and its wording is load-bearing: `killed` is a TIMEOUT,
 * `ENOENT` is a MISSING BINARY and anything else is a FAILED run. The label only names the
 * invocation in the timeout/failure sentence; the missing-binary sentence is identical for all
 * consumers because the file path is the whole answer there.
 */
export function createQuayFleetExec(commandLabel = 'quay-fleet'): QuayFleetExec {
  return (file, args, options) =>
    new Promise((resolve) => {
      execFile(file, [...args], options, (error: QuayFleetExecError | null, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, code: 0, stdout: stdout ?? '', stderr: stderr ?? '' });
          return;
        }
        const reason = error.killed === true
          ? `${commandLabel} timed out: ${error.message}`
          : error.code === 'ENOENT'
            ? `quay-fleet was not found: ${file}`
            : `${commandLabel} failed: ${error.message}`;
        resolve({
          ok: false,
          code: typeof error.code === 'number' ? error.code : null,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          error: reason,
          // A string code is Node's classification of the failure itself (missing binary,
          // maxBuffer kill); a numeric code is the child's exit status and already rides `code`.
          ...(typeof error.code === 'string' ? { errorCode: error.code } : {}),
        });
      });
    });
}

/** The production child-process binding the registry / initiative / project-id readers default to. */
export const defaultQuayFleetExec: QuayFleetExec = createQuayFleetExec();

/**
 * Parses a JSON document, or `null` when the child (or a fleet-owned file) printed something
 * else. Consumers: the locator handshake, the project-id join, the registry and the initiatives
 * view; every one treats "not a JSON object" as an ordinary empty reading, never a throw.
 */
export function parseFleetJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * A path canonicalized for root comparison: symlinks resolved, trailing separators dropped.
 * Consumers: the project-id join and the registry, both matching a registered root against a
 * Cloudpit project path. An unresolvable path falls back to a lexical absolute form so a
 * project that has been moved still compares as itself.
 */
export function canonicalFleetPath(filePath: string): string {
  let resolved = filePath;
  try {
    resolved = fs.realpathSync.native(filePath);
  } catch {
    resolved = path.resolve(filePath);
  }
  const trimmed = resolved.replace(/[\\/]+$/, '');
  return trimmed === '' ? resolved : trimmed;
}

/** The seams one runner needs; `resolveBinPath` answers the lookup miss with `null`. */
export type QuayFleetRunnerOptions = {
  /** The binary this call should spawn, or `null` when this host has none. */
  resolveBinPath: () => string | null;
  /** Child-process seam; defaults to {@link defaultQuayFleetExec}. */
  exec?: QuayFleetExec;
  /** Bound on the child; defaults to {@link QUAY_FLEET_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Cap on captured stdout; defaults to {@link QUAY_FLEET_MAX_OUTPUT_BYTES}. */
  maxOutputBytes?: number;
};

/** One invocation: the normalized argv in, the classified child answer out. */
export type QuayFleetRunner = (args: readonly string[]) => Promise<QuayFleetCommandResult>;

/**
 * Builds the "resolve the binary → fixed miss reading → execute" runner. Consumers: the
 * interface-session registry and the initiatives view (the latter with a 2 MiB stdout cap).
 *
 * The binary is resolved PER CALL, so installing the fleet (or changing `QUAY_FLEET_BIN`)
 * reaches the next read without a restart. A lookup miss never forks a child: it returns the
 * fixed {@link QUAY_FLEET_BIN_NOT_FOUND_REASON} reading the consumers surface to the cockpit.
 */
export function createQuayFleetRunner(options: QuayFleetRunnerOptions): QuayFleetRunner {
  const exec = options.exec ?? defaultQuayFleetExec;
  const timeoutMs = options.timeoutMs ?? QUAY_FLEET_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? QUAY_FLEET_MAX_OUTPUT_BYTES;

  return async (args) => {
    const binPath = options.resolveBinPath();
    if (binPath === null) {
      return {
        ok: false,
        code: null,
        stdout: '',
        stderr: '',
        error: QUAY_FLEET_BIN_NOT_FOUND_REASON,
      };
    }
    return exec(binPath, args, {
      timeout: timeoutMs,
      maxBuffer: maxOutputBytes,
      encoding: 'utf8',
      windowsHide: true,
    });
  };
}
