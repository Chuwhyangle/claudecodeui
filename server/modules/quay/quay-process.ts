import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createQuayEntrypointResolver,
  type QuayEntrypointFileSystem,
  type QuayEntrypointResolution,
  type QuayEntrypointResolver,
} from './read/quay-entrypoint-resolver.js';
import type {
  QuayCommandFailureKind,
  QuayCommandResult,
  QuayCommandRunner,
} from './read/quay-command-port.js';

/**
 * Default per-command subprocess bound. quay's read commands are JSON printers,
 * but their cost is not uniform: `quay task list --json` is linear in the store
 * size (it printed every task's whole body, ~3 s against this bound before the
 * snapshot read switched to `--no-body`), while `driver status` pays for probing
 * the driver subprocesses on a cold read.
 *
 * A command whose cold read is structurally more expensive than this must be
 * given its own ceiling through an injected dependency rather than widening this
 * one for every read — see {@link QUAY_DRIVER_STATUS_TIMEOUT_MS}.
 */
export const QUAY_COMMAND_TIMEOUT_MS = 8_000;

/**
 * Cap for `quay driver status --kind worker --json`, which is the one snapshot
 * read that is not a plain store print: a cold read measured ~5.9 s on this
 * workspace (its later reads answer from the warm state in ~0.8 s), so the
 * shared 8 s ceiling sat only ~2 s above a healthy cold reading and a loaded host
 * pushed it over. Widening this one command's bound is what keeps a cold snapshot
 * from degrading its driver/loop sections to `null`.
 *
 * It is injected (`QuayServiceDependencies.driverStatusTimeoutMs`) and wired here
 * so the snapshot's bound is a dependency a criterion can read, never a constant
 * buried in the read path.
 */
export const QUAY_DRIVER_STATUS_TIMEOUT_MS = 20_000;

/**
 * Cap on captured CLI stdout, so one runaway command cannot exhaust the server's
 * memory.
 *
 * It has to sit well above the largest *real* payload rather than at it.
 * `quay task list --json` carries every task's full body (~10 KB per task), so
 * this workspace's own quay store (2,531 tasks) prints ~26 MB. Under the previous
 * 8 MiB cap `execFile` killed the child mid-string, `JSON.parse` failed on the
 * torn tail, and the service degraded the Task ledger to `null` — which the panel
 * then rendered as "0 tasks". The cap is therefore sized for a store an order of
 * magnitude larger than the one that broke it, not for the one that fits today.
 */
export const QUAY_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * The binary is resolved per invocation by `quay-entrypoint-resolver.ts`, in priority order:
 * the SERVER settings override, Claude Code plugin scopes (local > project > user), the legacy
 * project pin `<projectRoot>/.quay/plugin/bin/quay` (only when it points outside the plugin
 * cache), then the bare PATH command. The resolver result is read before every spawn, so a
 * project's CLI can change without restarting the server.
 */

/** The bare command the resolver's last resort names. */
const QUAY_BARE_COMMAND = 'quay';

/**
 * The production filesystem seam for the entrypoint resolver. Kept here — beside the process
 * adapter that already owns the child-process boundary — so the resolver module itself performs
 * no direct reads and every branch is driven through injection in a criterion.
 */
function createNodeEntrypointFileSystem(): QuayEntrypointFileSystem {
  return {
    readText(filePath) {
      try {
        return fs.readFileSync(filePath, 'utf8');
      } catch {
        return null;
      }
    },
    stat(filePath) {
      try {
        const stats = fs.statSync(filePath);
        return {
          isFile: stats.isFile(),
          isDirectory: stats.isDirectory(),
          mtimeMs: stats.mtimeMs,
          size: stats.size,
        };
      } catch {
        return null;
      }
    },
    realpath(filePath) {
      try {
        return fs.realpathSync(filePath);
      } catch {
        return null;
      }
    },
    readlink(filePath) {
      try {
        return fs.readlinkSync(filePath);
      } catch {
        return null;
      }
    },
  };
}

/**
 * Builds the production resolver: the real filesystem, the process home, and the SERVER settings
 * file (`SERVER_SETTINGS_PATH`, else the shipped user copy). Consumers: `quay.module.ts` (the
 * spawn boundary, the capability identity read and the snapshot diagnostic) and this module's
 * own default when a caller does not inject a resolver.
 */
export function createSystemQuayEntrypointResolver(
  options: { homeDir?: string; settingsPath?: string } = {},
): QuayEntrypointResolver {
  const homeDir = options.homeDir ?? os.homedir();
  const settingsPath = options.settingsPath
    ?? process.env.SERVER_SETTINGS_PATH?.trim()
    ?? path.join(homeDir, '.config', 'claudecodeui', 'server.settings.json');
  return createQuayEntrypointResolver({
    fileSystem: createNodeEntrypointFileSystem(),
    homeDir,
    settingsPath,
  });
}

/** Minimal shape of the `execFile` error fields the failure classifier reads. */
type QuayExecFileError = Error & {
  /** Numeric exit code for a non-zero exit, an errno string (`ENOENT`, `EACCES`) for a spawn failure, or `null` on a signal kill. */
  code?: number | string | null;
  /** `true` when Node terminated the child because it exceeded `options.timeout`. */
  killed?: boolean;
  /** Signal that terminated the child (`SIGTERM` on a timeout). */
  signal?: string | null;
};

/** Options the adapter hands `execFile`: a subset of Node's `ExecFileOptions`, with a fixed encoding. */
type QuayExecFileOptions = {
  cwd: string;
  timeout: number;
  maxBuffer: number;
  encoding: 'utf8';
  windowsHide: boolean;
};

type QuayExecFileCallback = (
  error: QuayExecFileError | null,
  stdout: string,
  stderr: string,
) => void;

/**
 * The child-process spawn boundary. It is injected so `server/modules/quay/tests/quay-process.test.ts`
 * can record the exact command path the adapter resolved (and simulate errnos and
 * timeouts) without spawning a real process; production binds Node's `execFile`
 * through {@link defaultExecFile}.
 */
export type QuayExecFile = (
  file: string,
  args: readonly string[],
  options: QuayExecFileOptions,
  callback: QuayExecFileCallback,
) => void;

const defaultExecFile: QuayExecFile = (file, args, options, callback) => {
  execFile(file, [...args], options, callback);
};

/** Regular-file existence probe for the project entrypoint; `false` on any stat error (ENOENT, ENOTDIR, …). */
function entrypointIsFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Execute-permission probe (`X_OK`). A file with no execute bit set fails this
 * even when the server runs as root, which is exactly the "entrypoint exists but
 * cannot be spawned" case reported as `entrypoint-not-executable`.
 */
function entrypointIsExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Injectable boundaries of the quay process adapter. Every field is optional and
 * defaults to the production implementation, so the composition root
 * (`quay.module.ts`) calls `createQuayProcessRunner()` while tests bind fakes to
 * drive the resolution and failure branches deterministically.
 */
export type QuayProcessDependencies = {
  /** Spawns the resolved binary. Inject to record the command path or simulate errnos/timeouts. */
  execFile?: QuayExecFile;
  /**
   * Resolves the CLI for a project root. Inject with a deterministic resolution so the adapter
   * tests never depend on this machine's installed plugins. Defaults to the production
   * resolver (Claude plugin scopes, SERVER override, legacy pin, PATH).
   */
  resolveEntrypoint?: (projectRoot: string) => QuayEntrypointResolution;
  /** Entrypoint existence probe. Inject to drive the failure branches without touching disk. */
  fileExists?: (filePath: string) => boolean;
  /** Entrypoint execute-permission probe. Inject alongside `fileExists` in failure tests. */
  isExecutable?: (filePath: string) => boolean;
  /** Sink for the resolver's warning (skipped record / bare-PATH fallback). Defaults to `console.warn`. */
  warn?: (message: string) => void;
};

/** A failure raised before any child was spawned; `code` is `null` because no exit status exists. */
function localFailure(kind: QuayCommandFailureKind, error: string): QuayCommandResult {
  return { ok: false, code: null, stdout: '', stderr: '', error, failureKind: kind };
}

/** Maps an `execFile` error to the panel's failure taxonomy. */
function classifySpawnError(error: QuayExecFileError): QuayCommandFailureKind {
  if (error.killed === true) {
    return 'timeout';
  }
  if (error.code === 'ENOENT') {
    return 'entrypoint-missing';
  }
  if (error.code === 'EACCES' || error.code === 'EPERM') {
    return 'entrypoint-not-executable';
  }
  if (typeof error.code === 'number') {
    return 'nonzero-exit';
  }
  return 'spawn-error';
}

/**
 * Category-specific failure message. The `entrypoint-missing` text names the
 * remedy (`/quay:init`) so the panel's warning tells the user what to do rather
 * than restating that the command failed.
 */
function describeSpawnError(
  kind: QuayCommandFailureKind,
  error: QuayExecFileError,
  entrypoint: string,
  usedBareFallback: boolean,
): string {
  switch (kind) {
    case 'entrypoint-missing':
      return usedBareFallback
        ? `no quay CLI for this project: ${entrypoint} is missing and no "${QUAY_BARE_COMMAND}" is on PATH. Run /quay:init in this project to install a project-scoped CLI.`
        : `no quay CLI for this project: ${entrypoint} was not found when the command was spawned. Run /quay:init in this project to install a project-scoped CLI.`;
    case 'entrypoint-not-executable':
      return `quay entrypoint ${entrypoint} cannot be executed (missing execute permission).`;
    case 'timeout':
      return `quay command timed out: ${error.message}`;
    case 'nonzero-exit':
      return `quay exited with a non-zero status: ${error.message.trim()}`;
    default:
      return `failed to start the quay process: ${error.message}`;
  }
}

/**
 * Production subprocess adapter: runs one already-whitelisted quay argv and
 * captures its output. It uses `execFile` with an argument array and no shell, so
 * an argument can never be reinterpreted as shell syntax; the argv has been
 * matched against the service's read-only whitelist before it gets here.
 *
 * The binary is resolved per invocation from the target project's root rather
 * than from the server process's `PATH`: for `cwd` (which the service always
 * sets to the project's `projectPath`) the adapter asks the injected resolver
 * which CLI that project is driven with and spawns the returned absolute path.
 * Only the resolver's last resort returns the bare `quay` on `PATH`, and it
 * carries a warning that this adapter emits.
 *
 * The injected `execFile` seam lets `server/modules/quay/tests/quay-process.test.ts`
 * assert the resolved command path and the buffer policy against a stub payload.
 */
export function createQuayProcessRunner(
  dependencies: QuayProcessDependencies = {},
): QuayCommandRunner {
  const spawn = dependencies.execFile ?? defaultExecFile;
  const fileExists = dependencies.fileExists ?? entrypointIsFile;
  const isExecutable = dependencies.isExecutable ?? entrypointIsExecutable;
  const warn = dependencies.warn ?? ((message: string) => console.warn(message));

  // Built lazily so importing this module never reads the machine's home directory.
  let systemResolver: QuayEntrypointResolver | null = null;
  const resolveEntrypoint = dependencies.resolveEntrypoint ?? ((projectRoot: string) => {
    systemResolver ??= createSystemQuayEntrypointResolver();
    return systemResolver.resolve(projectRoot);
  });

  return (cwd, args, { timeoutMs }) =>
    new Promise<QuayCommandResult>((resolve) => {
      // `cwd` is always the target project's root (the service passes the
      // project's `projectPath`), which is what the resolver scopes its answer to.
      const resolution = resolveEntrypoint(cwd);
      const entrypoint = resolution.path;
      const usedBareFallback = resolution.source === 'path';

      // A skipped higher-priority record (a cleaned-up plugin version) is worth surfacing even
      // when a lower rule then answers — it is how every project used to read `entrypoint-missing`.
      if (resolution.warning !== null) {
        warn(resolution.warning);
      }

      if (!usedBareFallback && fileExists(entrypoint) && !isExecutable(entrypoint)) {
        resolve(localFailure(
          'entrypoint-not-executable',
          `quay entrypoint ${entrypoint} cannot be executed (missing execute permission).`,
        ));
        return;
      }

      spawn(
        entrypoint,
        args,
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: QUAY_MAX_OUTPUT_BYTES,
          encoding: 'utf8',
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ ok: true, code: 0, stdout: stdout ?? '', stderr: stderr ?? '' });
            return;
          }

          const kind = classifySpawnError(error);
          resolve({
            ok: false,
            code: typeof error.code === 'number' ? error.code : null,
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            error: describeSpawnError(kind, error, entrypoint, usedBareFallback),
            failureKind: kind,
          });
        },
      );
    });
}
