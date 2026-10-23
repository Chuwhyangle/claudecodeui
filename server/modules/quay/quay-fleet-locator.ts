import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The ONE place that decides which `quay-fleet` binary this server talks to, and the ONE place
 * that asks it what it is.
 *
 * WHY THIS EXISTS. Three consumers used to resolve the binary themselves — the project-id join,
 * the interface-session registry and the wall read port — and they disagreed: two fell back to
 * `quay-fleet` on `PATH`, one only read `QUAY_FLEET_BIN`. On a host where neither was set the
 * wall and the cockpit silently emptied, and the three surfaces could not even agree about WHY.
 * This module replaces those three parsers with one lookup order:
 *
 *   1. `QUAY_FLEET_BIN` (an explicit operator override, used verbatim);
 *   2. `quay-fleet` on `PATH`;
 *   3. `~/.quay-fleet/bin/quay-fleet` (the stable symlink `quay-fleet self-install` maintains).
 *
 * THE HANDSHAKE IS THE CONTRACT, NOT THE VERSION STRING. A located CLI is asked once for
 * `--version --json`, whose `contracts` document is compared against
 * {@link QUAY_FLEET_SUPPORTED_CONTRACTS}. `version` is logged for humans; `contracts` decides
 * compatibility. Four states are reported so the cockpit can say one true sentence:
 *
 *   - `ok`             — the CLI answered and speaks every contract this build does;
 *   - `missing`        — none of the three lookups found an executable;
 *   - `incompatible`   — the CLI answered but a contract differs (the reason names it);
 *   - `no-handshake`   — the CLI exists but did not report contracts (an older fleet, or a
 *                        timeout). Treated as compatible for the transition period, but marked
 *                        so the UI can say the handshake never happened.
 *
 * NOTHING HERE THROWS. A failed lookup, a failed child and unreadable output are all readings,
 * because every consumer is a server surface that must keep answering when the fleet is absent.
 */

/** The environment variable an operator uses to point CloudCLI at one exact binary. */
export const QUAY_FLEET_BIN_ENV = 'QUAY_FLEET_BIN';

/** The contract versions THIS build of CloudCLI speaks. */
export const QUAY_FLEET_SUPPORTED_CONTRACTS = {
  wallUri: 'v0',
  registry: 1,
  interfaceSession: 'v0',
} as const;

/** One versioned handshake document, as `quay-fleet --version --json` prints it. */
export type QuayFleetContracts = {
  wallUri: string;
  registry: number;
  interfaceSession: string;
};

/** The four readings of "can this host talk to quay-fleet, and does it speak our contracts". */
export type QuayFleetCliState = 'ok' | 'missing' | 'incompatible' | 'no-handshake';

/**
 * The complete locator reading. `available` is `false` exactly for `missing` and
 * `incompatible`: in both cases no consumer may mint a fleet handle; `no-handshake` stays
 * available so an un-upgraded (but otherwise compatible) fleet keeps working.
 */
export type QuayFleetCliReading = {
  available: boolean;
  state: QuayFleetCliState;
  /** The binary the lookup selected, or `null` when none was found. */
  binPath: string | null;
  /** The CLI's own version string when it reported one; informational only. */
  version: string | null;
  /** The contracts it declared, or `null` when it did not handshake. */
  contracts: QuayFleetContracts | null;
  /** One sentence for the UI when the state is not `ok`; `null` exactly when it is `ok`. */
  reason: string | null;
};

/** Where the selected binary came from; `null` when no binary was found. */
export type QuayFleetCliSource = 'env' | 'path' | 'home' | null;

/** The pure lookup result, before any handshake. */
export type QuayFleetCliLocation = {
  binPath: string | null;
  source: QuayFleetCliSource;
};

/** The answer to one child invocation, in the same shape the quay adapters use. */
export type QuayFleetCliCommandResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  /** Why the child could not be run or answered with a failure, when that is known. */
  error?: string;
};

/** The child-process seam; production binds {@link defaultExecFile}, a test may bind a stub. */
export type QuayFleetCliExec = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; encoding: 'utf8'; windowsHide: boolean },
) => Promise<QuayFleetCliCommandResult>;

/** Filesystem / environment seams; every one defaults to the real host. */
export type QuayFleetCliLocateOptions = {
  /** The environment to read; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** The `PATH`-style string to search; defaults to `env.PATH`. */
  pathEnv?: string;
  /** Home directory; defaults to `os.homedir()`. */
  homeDir?: string;
  /** Platform, for the executable suffix; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Executable probe; defaults to `fs.accessSync(file, X_OK)` plus a regular-file check. */
  isExecutable?: (filePath: string) => boolean;
};

/** The reader seam consumed by the project-id join, the registry and the service summary. */
export type QuayFleetCliReader = {
  read(): Promise<QuayFleetCliReading>;
};

export type QuayFleetCliReaderOptions = QuayFleetCliLocateOptions & {
  /**
   * Overrides the lookup entirely. The join composes this so an injected `binPath` (or an
   * injected exec seam in a test) is honoured without reaching into the environment.
   */
  locate?: () => QuayFleetCliLocation;
  /** Child-process seam, defaulting to Node's `execFile`. */
  exec?: QuayFleetCliExec;
  /** Bound on the `--version --json` child. */
  timeoutMs?: number;
  /** How long one handshake reading is reused. */
  ttlMs?: number;
  /** Clock seam for the TTL; defaults to `Date.now`. */
  now?: () => number;
  /** The contracts this build speaks; defaults to {@link QUAY_FLEET_SUPPORTED_CONTRACTS}. */
  supportedContracts?: QuayFleetContracts;
};

/** Bound on the handshake child. A CLI that cannot print a small JSON document in this window
 * is treated as "did not handshake", never as a missing binary. */
export const QUAY_FLEET_HANDSHAKE_TIMEOUT_MS = 10_000;

/** How long one handshake is reused. Long enough that a polling cockpit does not fork a child
 * per request, short enough that an `upgrade` reaches the UI without a restart. */
export const QUAY_FLEET_HANDSHAKE_TTL_MS = 60_000;

/** Cap on captured stdout — the handshake document is tiny; this only bounds a runaway child. */
const QUAY_FLEET_HANDSHAKE_MAX_OUTPUT_BYTES = 64 * 1024;

type QuayFleetExecError = Error & { code?: number | string | null; killed?: boolean };

/** Production child-process binding; every failure is a value, so the caller never sees a throw. */
const defaultExecFile: QuayFleetCliExec = (file, args, options) =>
  new Promise((resolve) => {
    execFile(file, [...args], options, (error: QuayFleetExecError | null, stdout, stderr) => {
      if (!error) {
        resolve({ ok: true, code: 0, stdout: stdout ?? '', stderr: stderr ?? '' });
        return;
      }
      const reason = error.killed === true
        ? `quay-fleet --version timed out: ${error.message}`
        : error.code === 'ENOENT'
          ? `quay-fleet was not found: ${file}`
          : `quay-fleet --version failed: ${error.message}`;
      resolve({
        ok: false,
        code: typeof error.code === 'number' ? error.code : null,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        error: reason,
      });
    });
  });

/** True when `filePath` names an executable regular file. */
function defaultIsExecutable(filePath: string): boolean {
  try {
    if (!fs.statSync(filePath).isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The executable names to try in one directory. Windows needs the launcher suffixes; the
 * extension-less name is last so a real POSIX build is preferred when both exist.
 */
function executableNames(platform: NodeJS.Platform): readonly string[] {
  return platform === 'win32'
    ? ['quay-fleet.cmd', 'quay-fleet.exe', 'quay-fleet']
    : ['quay-fleet'];
}

/**
 * Finds the fleet CLI without spawning it. An explicit `QUAY_FLEET_BIN` wins as-is — the
 * operator named that file and a wrong path must read as a failed spawn (with the path in the
 * error) rather than silently falling through to a different binary.
 */
export function locateQuayFleetCli(options: QuayFleetCliLocateOptions = {}): QuayFleetCliLocation {
  const env = options.env ?? process.env;
  const configured = env[QUAY_FLEET_BIN_ENV]?.trim();
  if (configured !== undefined && configured !== '') {
    return { binPath: configured, source: 'env' };
  }

  const platform = options.platform ?? process.platform;
  const isExecutable = options.isExecutable ?? defaultIsExecutable;
  const names = executableNames(platform);

  const pathValue = options.pathEnv ?? env.PATH ?? '';
  for (const entry of pathValue.split(path.delimiter)) {
    // A PATH entry may be quoted (Windows); empty entries mean "the current directory", which
    // a server should not treat as a fleet installation.
    const directory = entry.trim().replace(/^"(.*)"$/, '$1');
    if (directory === '') continue;
    for (const name of names) {
      const candidate = path.resolve(directory, name);
      if (isExecutable(candidate)) {
        return { binPath: candidate, source: 'path' };
      }
    }
  }

  const home = options.homeDir ?? os.homedir();
  if (home !== '') {
    for (const name of names) {
      const candidate = path.join(home, '.quay-fleet', 'bin', name);
      if (isExecutable(candidate)) {
        return { binPath: candidate, source: 'home' };
      }
    }
  }

  return { binPath: null, source: null };
}

/**
 * The binary a spawn should name. The lookup result when one was found; otherwise the bare
 * `quay-fleet`, which lets an injected exec seam (a test) and an OS-level `PATH` lookup still
 * answer. Callers that need the honest "not found" reading call {@link locateQuayFleetCli}.
 */
export function quayFleetBinPath(options: QuayFleetCliLocateOptions = {}): string {
  return locateQuayFleetCli(options).binPath ?? 'quay-fleet';
}

/** Parses a JSON object, or `null` when the child printed something else. */
function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Reads the `contracts` document, or `null` when the CLI did not declare one. */
function readContracts(value: unknown): QuayFleetContracts | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const { wallUri, registry, interfaceSession } = record;
  return typeof wallUri === 'string'
    && typeof registry === 'number'
    && typeof interfaceSession === 'string'
    ? { wallUri, registry, interfaceSession }
    : null;
}

/**
 * Compares the fleet's declared contracts with this build's. Returns one human-readable line
 * per mismatch, each NAMING the contract so the cockpit can say which one went stale.
 */
function contractMismatches(
  fleet: QuayFleetContracts,
  supported: QuayFleetContracts,
): string[] {
  const mismatches: string[] = [];
  if (fleet.wallUri !== supported.wallUri) {
    mismatches.push(`wallUri: fleet speaks ${fleet.wallUri}, this build supports ${supported.wallUri}`);
  }
  if (fleet.registry !== supported.registry) {
    mismatches.push(`registry: fleet speaks ${fleet.registry}, this build supports ${supported.registry}`);
  }
  if (fleet.interfaceSession !== supported.interfaceSession) {
    mismatches.push(
      `interfaceSession: fleet speaks ${fleet.interfaceSession}, this build supports ${supported.interfaceSession}`,
    );
  }
  return mismatches;
}

/** The lookup-miss reading. A missing CLI is the only state with no `binPath` to report. */
function missingReading(): QuayFleetCliReading {
  return {
    available: false,
    state: 'missing',
    binPath: null,
    version: null,
    contracts: null,
    reason: 'quay-fleet was not found (checked QUAY_FLEET_BIN, PATH and ~/.quay-fleet/bin/quay-fleet)',
  };
}

/**
 * Builds a handshake reader with its own TTL cache.
 *
 * The binary is re-located on every read (so setting `QUAY_FLEET_BIN` or completing
 * `self-install` reaches the server without a restart) and the handshake is cached per
 * resolved path for {@link QuayFleetCliReaderOptions.ttlMs}. Concurrent readers share the
 * in-flight child rather than forking one each.
 */
export function createQuayFleetCliReader(options: QuayFleetCliReaderOptions = {}): QuayFleetCliReader {
  const exec = options.exec ?? defaultExecFile;
  const timeoutMs = options.timeoutMs ?? QUAY_FLEET_HANDSHAKE_TIMEOUT_MS;
  const ttlMs = options.ttlMs ?? QUAY_FLEET_HANDSHAKE_TTL_MS;
  const now = options.now ?? Date.now;
  const supported = options.supportedContracts ?? QUAY_FLEET_SUPPORTED_CONTRACTS;
  const locate = options.locate ?? (() => locateQuayFleetCli(options));

  let cached: { binPath: string; expiresAt: number; reading: QuayFleetCliReading } | null = null;
  let inFlight: { binPath: string; reading: Promise<QuayFleetCliReading> } | null = null;

  const readHandshake = async (binPath: string): Promise<QuayFleetCliReading> => {
    let result: QuayFleetCliCommandResult;
    try {
      result = await exec(binPath, ['--version', '--json'], {
        timeout: timeoutMs,
        maxBuffer: QUAY_FLEET_HANDSHAKE_MAX_OUTPUT_BYTES,
        encoding: 'utf8',
        windowsHide: true,
      });
    } catch (error) {
      // A seam that throws is still "the CLI did not handshake"; the transition period keeps
      // it available rather than taking the whole fleet surface down.
      return noHandshake(binPath, error instanceof Error && error.message !== ''
        ? `quay-fleet --version could not be run: ${error.message}`
        : 'quay-fleet --version could not be run');
    }

    if (!result.ok) {
      // An older fleet has no `--version`; any refusal is the same reading — no handshake —
      // and its stated reason is what the operator sees.
      const detail = result.error ?? (result.stderr.trim() || `quay-fleet --version exited ${result.code === null ? 'without a status' : `with ${result.code}`}`);
      return noHandshake(binPath, detail);
    }

    const document = parseJsonObject(result.stdout);
    const contracts = readContracts(document?.contracts);
    if (contracts === null) {
      return noHandshake(binPath, 'quay-fleet --version did not report contracts (older quay-fleet?)');
    }

    const version = typeof document?.version === 'string' ? document.version : null;
    const mismatches = contractMismatches(contracts, supported);
    if (mismatches.length > 0) {
      return {
        available: false,
        state: 'incompatible',
        binPath,
        version,
        contracts,
        reason: `quay-fleet contracts do not match this build: ${mismatches.join('; ')}`,
      };
    }

    return { available: true, state: 'ok', binPath, version, contracts, reason: null };
  };

  return {
    async read() {
      const { binPath } = locate();
      if (binPath === null) {
        return missingReading();
      }
      if (cached !== null && cached.binPath === binPath && cached.expiresAt > now()) {
        return { ...cached.reading };
      }
      if (inFlight !== null && inFlight.binPath === binPath) {
        return { ...(await inFlight.reading) };
      }

      const reading = readHandshake(binPath).then((resolved) => {
        cached = { binPath, expiresAt: now() + ttlMs, reading: resolved };
        return resolved;
      }).finally(() => {
        if (inFlight?.binPath === binPath) inFlight = null;
      });
      inFlight = { binPath, reading };
      return { ...(await reading) };
    },
  };
}

/** The "CLI exists but did not handshake" reading, kept as compatible for the transition. */
function noHandshake(binPath: string, reason: string): QuayFleetCliReading {
  return {
    available: true,
    state: 'no-handshake',
    binPath,
    version: null,
    contracts: null,
    reason,
  };
}
