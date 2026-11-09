
import { execFile } from 'node:child_process';

import { locateQuayFleetCli } from '../cli/quay-fleet-locator.js';

/**
 * The fleet's ONE normalized liveness read port (`liveness --json`, falling back to the
 * transition-period `status --json`). Both document shapes are normalized here so swapping
 * the read port later changes exactly this file. A host with no reachable fleet answers
 * `available: false` with one sentence, never a throw.
 *
 * Consumers: `server/modules/observation/producers/project-truth.producer.ts` (the default
 * reader) and the module barrel, which re-exports the factory and its vocabulary.
 */

//----------------- FLEET LIVENESS READ PORT ------------

/**
 * The fleet's three-state liveness vocabulary. `unknown` is 「没读到」 — never 「不健康」.
 *
 * Consumers: `server/modules/observation/project-truth.ts` (the project tile's 活性 layer) and
 * the quay service's own reader below.
 */
export type QuayFleetLivenessState = 'ok' | 'stale' | 'unknown';

/** One fleet-registered project's liveness, normalized from either fleet document shape. */
export type QuayFleetProjectLiveness = {
  projectId: string;
  driverState: QuayFleetLivenessState;
  driverAgeSec: number | null;
  /** Why `driverState` is `unknown`, when the source said why. */
  driverReason: string | null;
  /** The project's last gate instant as ISO-8601, or `null` when the document carries none. */
  lastGateAt: string | null;
  /** `true` when a human pinned this project's driver stopped. */
  halted: boolean;
};

/**
 * The ONE reading the observation layer consumes for fleet liveness.
 *
 * The target port is `quay-fleet liveness --json` (`fleet-liveness-read-port`: `fleet.{state,
 * lastTickAt, ageSec}`, `projects[].driver.{state,ageSec}`, `lastGateAt`, `halted`). During the
 * transition the fleet may not ship that verb yet, so the reader falls back to the older
 * `quay-fleet status --json` (`projects[].drivers.{worker,promotion,goal,outer}` + `service`).
 * Both shapes are normalized HERE, so swapping the read port later changes exactly this file.
 *
 * `available: false` is the read port's own failure ("could not ask the fleet"), which the
 * project tile renders as `unevaluated` with `reason` — never as a green reading.
 */
export type QuayFleetLivenessReading = {
  available: boolean;
  /** Which document answered; diagnostic only — both shapes produce the same project rows. */
  source: 'liveness' | 'status' | 'none';
  at: string | null;
  fleet: {
    state: QuayFleetLivenessState;
    lastTickAt: string | null;
    ageSec: number | null;
  } | null;
  projects: QuayFleetProjectLiveness[];
  /** Why the read port could not answer; non-null exactly when `available` is false. */
  reason: string | null;
};

/** One fleet CLI child's answer, in the same value-shaped form the other fleet adapters use. */
export type QuayFleetLivenessCommandResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

/** The child seam; production binds {@link defaultQuayFleetLivenessExec}, a test may stub it. */
export type QuayFleetLivenessExec = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; encoding: 'utf8'; windowsHide: boolean },
) => Promise<QuayFleetLivenessCommandResult>;

/** Bound on one fleet liveness/status child. Both documents are small. */
export const QUAY_FLEET_LIVENESS_TIMEOUT_MS = 10_000;

/**
 * The threshold used ONLY when a document carries an age but no state. The fleet itself applies
 * `liveness.staleAfterSec` from its own checkout's `.quay/config.yml`; this mirrors its declared
 * default so a transition-period document without a state still reads honestly.
 */
export const QUAY_FLEET_LIVENESS_DEFAULT_STALE_AFTER_SEC = 300;

const QUAY_FLEET_LIVENESS_MAX_OUTPUT_BYTES = 1024 * 1024;

type QuayFleetLivenessExecError = Error & { code?: number | string | null; killed?: boolean };

/** Production child binding; failures are values so this reader never throws. */
const defaultQuayFleetLivenessExec: QuayFleetLivenessExec = (file, args, options) =>
  new Promise((resolve) => {
    execFile(file, [...args], options, (error: QuayFleetLivenessExecError | null, stdout, stderr) => {
      if (!error) {
        resolve({ ok: true, code: 0, stdout: stdout ?? '', stderr: stderr ?? '' });
        return;
      }
      resolve({
        ok: false,
        code: typeof error.code === 'number' ? error.code : null,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        error: error.killed === true
          ? `quay-fleet ${args[0] ?? ''} timed out: ${error.message}`
          : error.code === 'ENOENT'
            ? `quay-fleet was not found: ${file}`
            : `quay-fleet ${args[0] ?? ''} failed: ${error.message}`,
      });
    });
  });

/** The reader's injectable world; every field defaults to the real host. */
export type QuayFleetLivenessReaderOptions = {
  exec?: QuayFleetLivenessExec;
  /** Overrides the binary lookup entirely (the locator is the default). */
  locate?: () => { binPath: string | null };
  timeoutMs?: number;
  /** Fallback threshold for documents that carry ages but no states. */
  staleAfterSec?: number;
};

export type QuayFleetLivenessReader = {
  read(): Promise<QuayFleetLivenessReading>;
};

function readJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asLivenessRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readLivenessNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readLivenessString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Maps a document's own state string, falling back to the age against the threshold. */
function livenessStateOf(
  value: unknown,
  ageSec: number | null,
  staleAfterSec: number,
): QuayFleetLivenessState {
  if (value === 'ok' || value === 'stale' || value === 'unknown') return value;
  if (ageSec === null) return 'unknown';
  return ageSec <= staleAfterSec ? 'ok' : 'stale';
}

/** Projects one project row out of the fleet's `liveness` document shape. */
function readLivenessProject(
  value: unknown,
  staleAfterSec: number,
): QuayFleetProjectLiveness | null {
  const record = asLivenessRecord(value);
  if (record === null || typeof record.projectId !== 'string') return null;

  const driver = asLivenessRecord(record.driver);
  const ageSec = readLivenessNumber(driver?.ageSec);
  return {
    projectId: record.projectId,
    driverState: livenessStateOf(driver?.state, ageSec, staleAfterSec),
    driverAgeSec: ageSec,
    driverReason: null,
    lastGateAt: readLivenessString(record.lastGateAt),
    halted: record.halted === true,
  };
}

/** The fleet's `liveness --json` shape → the normalized reading, or `null` when it is not one. */
function readFleetLivenessDocument(
  document: Record<string, unknown>,
  staleAfterSec: number,
): QuayFleetLivenessReading | null {
  if (!Array.isArray(document.projects)) return null;

  const fleet = asLivenessRecord(document.fleet);
  const fleetAgeSec = readLivenessNumber(fleet?.ageSec);
  return {
    available: true,
    source: 'liveness',
    at: readLivenessString(document.at),
    fleet:
      fleet === null
        ? null
        : {
            state: livenessStateOf(fleet.state, fleetAgeSec, staleAfterSec),
            lastTickAt: readLivenessString(fleet.lastTickAt),
            ageSec: fleetAgeSec,
          },
    projects: document.projects
      .map((project) => readLivenessProject(project, staleAfterSec))
      .filter((project): project is QuayFleetProjectLiveness => project !== null),
    reason: null,
  };
}

/** The four driver kinds `status --json` reports, in the order their states are compared. */
const STATUS_DRIVER_KINDS = ['worker', 'promotion', 'goal', 'outer'] as const;

/** `stale` is a real observed silence; it outranks `unknown` because it is actionable. */
const DRIVER_STATE_RANK: Record<QuayFleetLivenessState, number> = { unknown: 1, stale: 2, ok: 0 };

/** Projects one project row out of the fleet's transition-period `status` document shape. */
function readStatusProject(
  value: unknown,
  halted: Record<string, unknown> | null,
  staleAfterSec: number,
): QuayFleetProjectLiveness | null {
  const record = asLivenessRecord(value);
  if (record === null || typeof record.projectId !== 'string') return null;

  const drivers = asLivenessRecord(record.drivers);
  const reads = STATUS_DRIVER_KINDS.map((kind) => asLivenessRecord(drivers?.[kind])).filter(
    (driver): driver is Record<string, unknown> => driver !== null,
  );

  let driverState: QuayFleetLivenessState = 'ok';
  let driverAgeSec: number | null = null;
  let driverReason: string | null = null;
  for (const driver of reads) {
    const ageSec = readLivenessNumber(driver.ageSec);
    const state = livenessStateOf(driver.state, ageSec, staleAfterSec);
    if (ageSec !== null && (driverAgeSec === null || ageSec > driverAgeSec)) {
      driverAgeSec = ageSec;
    }
    // The worst state wins; the age reported beside it is the longest silence in the reading.
    if (DRIVER_STATE_RANK[state] > DRIVER_STATE_RANK[driverState]) {
      driverState = state;
    }
  }
  if (reads.length === 0) {
    driverState = 'unknown';
    driverReason = '没有 driver 读数';
  } else if (driverState === 'unknown') {
    driverReason = 'driver 状态未知';
  }
  // A `null` anchorAlive means the reading does not carry it; only `false` is a real fact.
  if (record.anchorAlive === false && driverState === 'ok') {
    driverState = 'unknown';
    driverReason = 'anchor 进程不在';
  }

  const projectId = record.projectId;
  return {
    projectId,
    driverState,
    driverAgeSec,
    driverReason,
    lastGateAt: null,
    halted: halted !== null && (halted.project == null || halted.project === projectId),
  };
}

/** The fleet's `status --json` shape → the normalized reading, or `null` when it is not one. */
function readFleetStatusDocument(
  document: Record<string, unknown>,
  staleAfterSec: number,
): QuayFleetLivenessReading | null {
  if (!Array.isArray(document.projects)) return null;

  const service = asLivenessRecord(document.service);
  const serviceAgeSec = readLivenessNumber(service?.ageSec);
  const serviceAlive = service?.alive;
  const halted = asLivenessRecord(document.halted);
  return {
    available: true,
    source: 'status',
    at: readLivenessString(document.at),
    fleet:
      service === null
        ? null
        : {
            state:
              serviceAlive === true
                ? livenessStateOf(null, serviceAgeSec, staleAfterSec)
                : 'unknown',
            lastTickAt: readLivenessString(service.at),
            ageSec: serviceAgeSec,
          },
    projects: document.projects
      .map((project) => readStatusProject(project, halted, staleAfterSec))
      .filter((project): project is QuayFleetProjectLiveness => project !== null),
    reason: null,
  };
}

/**
 * Builds the fleet liveness reader the observation layer uses.
 *
 * It asks `liveness --json` first and falls back to `status --json`; both are read-only verbs.
 * A host with no reachable fleet answers `available: false` with one sentence, never a throw —
 * the cockpit page must keep working when the fleet is absent.
 *
 * Consumers: `server/modules/observation/project-truth.producer.ts` (the default reader).
 */
export function createQuayFleetLivenessReader(
  options: QuayFleetLivenessReaderOptions = {},
): QuayFleetLivenessReader {
  const exec = options.exec ?? defaultQuayFleetLivenessExec;
  const timeoutMs = options.timeoutMs ?? QUAY_FLEET_LIVENESS_TIMEOUT_MS;
  const staleAfterSec = options.staleAfterSec ?? QUAY_FLEET_LIVENESS_DEFAULT_STALE_AFTER_SEC;
  const locate = options.locate ?? (() => locateQuayFleetCli());

  const run = (binPath: string, verb: 'liveness' | 'status'): Promise<QuayFleetLivenessCommandResult> =>
    exec(binPath, [verb, '--json'], {
      timeout: timeoutMs,
      maxBuffer: QUAY_FLEET_LIVENESS_MAX_OUTPUT_BYTES,
      encoding: 'utf8',
      windowsHide: true,
    });

  return {
    async read(): Promise<QuayFleetLivenessReading> {
      const { binPath } = locate();
      if (binPath === null) {
        return {
          available: false,
          source: 'none',
          at: null,
          fleet: null,
          projects: [],
          reason: 'quay-fleet 不可用（QUAY_FLEET_BIN、PATH、~/.quay-fleet/bin 都没有找到）',
        };
      }

      const failures: string[] = [];
      for (const verb of ['liveness', 'status'] as const) {
        let result: QuayFleetLivenessCommandResult;
        try {
          result = await run(binPath, verb);
        } catch (error) {
          failures.push(`${verb}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        if (!result.ok) {
          failures.push(
            `${verb}: ${result.error ?? (result.stderr.trim() || `exit ${result.code === null ? 'abnormally' : result.code}`)}`,
          );
          continue;
        }
        const document = readJsonRecord(result.stdout);
        const reading =
          document === null
            ? null
            : verb === 'liveness'
              ? readFleetLivenessDocument(document, staleAfterSec)
              : readFleetStatusDocument(document, staleAfterSec);
        if (reading !== null) return reading;
        failures.push(`${verb}: 返回的不是可读的 ${verb} 文档`);
      }

      return {
        available: false,
        source: 'none',
        at: null,
        fleet: null,
        projects: [],
        reason: `quay-fleet 读口不可用：${failures.join('；')}`,
      };
    },
  };
}
