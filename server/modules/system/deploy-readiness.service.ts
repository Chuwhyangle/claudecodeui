import fs from 'node:fs';
import path from 'node:path';

/**
 * Deployment readiness = "what is running, what is built, what is checked out, and what will
 * change if we build now". The cockpit's persistent deploy strip and the `POST
 * /api/system/deploy` action read this one service; nothing else compares fingerprints.
 *
 * The three readings it compares are deliberately kept separate rather than collapsed into a
 * single boolean:
 *   - `runningSha`  — the commit the running process was compiled from (`dist-server/build-info.json`
 *                     captured at boot; a `tsx` dev process has none);
 *   - `builtSha`    — the commit the LAST build on disk compiled (`dist-server/build-info.json`);
 *   - `clientBuiltSha` — the same record for the browser bundle (`dist/build-info.json`);
 *   - `headSha`     — the commit currently checked out.
 *
 * A commit that touches neither `src/` nor `server/` cannot require a build, which is why a
 * `docs/`-only or `tasks/`-only lead still reads as `fresh`.
 */

export type DeployStatus =
  | 'fresh'
  | 'pending-build'
  | 'built-pending-restart'
  | 'building'
  | 'restarting'
  | 'unknown';

/** One commit between the built sha and HEAD, with the task id its subject names (if any). */
export type DeployCommit = {
  sha: string;
  subject: string;
  taskId: string | null;
};

/** One post-restart verification item. `status` is the HTTP status when the check is a route. */
export type DeployCheck = {
  name: string;
  ok: boolean;
  status: number | null;
  detail: string;
};

/** The outcome of the last deploy this installation performed, written by the boot verifier. */
export type DeployLastDeploy = {
  targetSha: string;
  ok: boolean;
  checks: DeployCheck[];
  at: string;
};

/** The last failed build/restart step, with the tail of its output for the reading. */
export type DeployFailure = {
  step: 'build' | 'restart';
  outputTail: string;
  at: string;
};

/** The persisted deploy state, under `$HOME/.ccui-restart/deploy-state.json` by default. */
export type DeployPersistedState = {
  targetSha: string;
  requestedAt: string;
  phase: 'restarting' | 'verified' | 'failed';
  lastDeploy?: DeployLastDeploy;
  failure?: DeployFailure;
};

/** What the cockpit reads. */
export type DeployReadinessReading = {
  status: DeployStatus;
  runningSha: string | null;
  builtSha: string | null;
  clientBuiltSha: string | null;
  headSha: string | null;
  pendingCommits: DeployCommit[];
  lastDeploy: DeployLastDeploy | null;
  failure: DeployFailure | null;
  checkedAt: string;
};

/** The result of `POST /api/system/deploy`, before the fresh reading is attached. */
export type DeployExecutionResult =
  | { ok: true; step: 'restart'; targetSha: string }
  | { ok: false; step: 'build'; outputTail: string }
  | { ok: false; step: 'restart'; outputTail: string }
  | { ok: false; step: 'busy' };

/** One command's output, in the shape both the build and the restart adapter answer. */
export type DeployCommandResult = {
  exitCode: number | null;
  output: string;
  errorOutput: string;
};

/** A build fingerprint file's content. A missing/malformed record is `{null, null}`. */
export type DeployBuildFingerprint = {
  gitSha: string | null;
  builtAt: string | null;
};

/** The git reading a classification needs; injected so the criterion can stub it. */
export type DeployGitReading = {
  /** The checked-out commit, or null when git cannot answer. */
  headSha(): string | null;
  /** Commits reachable from `toSha` but not `fromSha`, newest first, with their touched paths. */
  commitsBetween(
    fromSha: string,
    toSha: string,
  ): { sha: string; subject: string; paths: string[] }[];
};

/** Where a deploy fingerprint lives, relative to the app root. */
const SERVER_BUILD_INFO = path.join('dist-server', 'build-info.json');
/** The browser bundle's own fingerprint, written by `scripts/write-client-build-info.mjs`. */
const CLIENT_BUILD_INFO = path.join('dist', 'build-info.json');

/**
 * Reads one build fingerprint. Missing, unreadable, or malformed files are expected states (a
 * dev instance has none, and an installation built before the client fingerprint shipped has no
 * `dist/build-info.json`), so they resolve to nulls rather than throwing.
 *
 * @param filePath absolute path of the `build-info.json` file
 */
export function readBuildFingerprint(filePath: string): DeployBuildFingerprint {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) {
      return { gitSha: null, builtAt: null };
    }
    const record = parsed as { gitSha?: unknown; builtAt?: unknown };
    return {
      gitSha: typeof record.gitSha === 'string' ? record.gitSha : null,
      builtAt: typeof record.builtAt === 'string' ? record.builtAt : null,
    };
  } catch {
    return { gitSha: null, builtAt: null };
  }
}

/** The `tasks: <id> …` / `task/<id>` conventions this repository's commits use. */
const TASK_ID_PATTERNS = [/^tasks:\s+([A-Za-z0-9][A-Za-z0-9-]*)/, /task\/([A-Za-z0-9][A-Za-z0-9-]*)/];

/**
 * Extracts the task id a commit subject names, or null. `tasks: <id> …` is the task-store
 * commit; the `task/<id>` form appears on a task branch's own commits.
 */
export function taskIdFromSubject(subject: string): string | null {
  for (const pattern of TASK_ID_PATTERNS) {
    const match = pattern.exec(subject);
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  return null;
}

/** Whether a commit's touched paths include application source (`src/` or `server/`). */
function touchesApplicationSource(paths: string[]): boolean {
  return paths.some((touched) => touched.startsWith('src/') || touched.startsWith('server/'));
}

/** The last `limit` characters of a build/restart transcript, for the failure reading. */
function tailOf(result: DeployCommandResult, limit = 2000): string {
  const combined = `${result.output}${result.errorOutput}`.trim();
  return combined.length <= limit ? combined : combined.slice(combined.length - limit);
}

type DeployStatusInput = {
  runningSha: string | null;
  builtSha: string | null;
  clientBuiltSha: string | null;
  headSha: string | null;
  inFlight: 'building' | 'restarting' | null;
  commitsBetween: DeployGitReading['commitsBetween'];
};

type DeployClassification = {
  status: DeployStatus;
  pendingCommits: DeployCommit[];
};

/**
 * The one classification rule. Kept as a free function so the criterion exercises exactly the
 * production decision rather than a re-implementation.
 *
 * Order matters: an in-flight build/restart overrides every fingerprint reading (the disk state
 * is expected to be inconsistent while it runs); a process with no running fingerprint is
 * `unknown`; and a build that already equals HEAD but is not running is the restart arm.
 */
export function classifyDeployStatus(input: DeployStatusInput): DeployClassification {
  if (input.inFlight === 'building') {
    return { status: 'building', pendingCommits: [] };
  }
  if (input.inFlight === 'restarting') {
    return { status: 'restarting', pendingCommits: [] };
  }
  if (input.runningSha === null || input.builtSha === null || input.headSha === null) {
    return { status: 'unknown', pendingCommits: [] };
  }

  if (input.builtSha === input.headSha) {
    // The server build is current. A client fingerprint that is present and behind HEAD means
    // only the browser bundle is stale — still a build, but usually the server's own record was
    // written by the same pass, so this is the rare "server rebuilt alone" case.
    if (
      input.clientBuiltSha !== null
      && input.clientBuiltSha !== input.headSha
      && input.runningSha === input.headSha
    ) {
      const clientAhead = input.commitsBetween(input.clientBuiltSha, input.headSha).filter(
        (commit) => touchesApplicationSource(commit.paths),
      );
      if (clientAhead.length > 0) {
        return {
          status: 'pending-build',
          pendingCommits: clientAhead.map((commit) => ({
            sha: commit.sha,
            subject: commit.subject,
            taskId: taskIdFromSubject(commit.subject),
          })),
        };
      }
    }
    return {
      status: input.runningSha === input.headSha ? 'fresh' : 'built-pending-restart',
      pendingCommits: [],
    };
  }

  const ahead = input.commitsBetween(input.builtSha, input.headSha);
  const sourceCommits = ahead
    .filter((commit) => touchesApplicationSource(commit.paths))
    .map((commit) => ({
      sha: commit.sha,
      subject: commit.subject,
      taskId: taskIdFromSubject(commit.subject),
    }));

  if (sourceCommits.length > 0) {
    return { status: 'pending-build', pendingCommits: sourceCommits };
  }

  // Only docs/tasks (or other non-source paths) landed since the build. Nothing needs
  // rebuilding; the only outstanding action, if any, is restarting the built artifacts.
  return {
    status: input.runningSha === input.builtSha ? 'fresh' : 'built-pending-restart',
    pendingCommits: [],
  };
}

export type DeployReadinessDependencies = {
  appRoot: string;
  /** Captured at boot; a long-lived process must not re-read its own identity per request. */
  runningBuildInfo: DeployBuildFingerprint;
  git: DeployGitReading;
  readState(): DeployPersistedState | null;
  writeState(state: DeployPersistedState): void;
  runBuild(): Promise<DeployCommandResult>;
  /** `--delay` is part of the argv the restart stub asserts. */
  runRestartScript(args: string[]): Promise<DeployCommandResult>;
  now(): number;
  /** Short read-through cache for the idle reading; the deploy action always invalidates it. */
  cacheTtlMs?: number;
  logInfo?(message: string): void;
  logError?(message: string): void;
  /** Injected event seams. Defaults do nothing; the host-level event stream binds them later. */
  onBuildFinished?(result: { ok: boolean; outputTail: string }): void;
  onRestartFinished?(result: { ok: boolean; targetSha: string }): void;
};

const DEFAULT_CACHE_TTL_MS = 5_000;

/**
 * Creates the readiness/deploy service. Every side effect (git, fingerprints, build, restart,
 * state file, clock) arrives as a dependency, so the criterion drives production logic with
 * stubs and no subprocess runs.
 */
export function createDeployReadinessService(dependencies: DeployReadinessDependencies) {
  const cacheTtlMs = dependencies.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  let inFlight: 'building' | 'restarting' | null = null;
  let cached: { at: number; reading: DeployReadinessReading } | null = null;
  let failure: DeployFailure | null = null;

  const readClientFingerprint = (): DeployBuildFingerprint =>
    readBuildFingerprint(path.join(dependencies.appRoot, CLIENT_BUILD_INFO));

  /** Reads every input and classifies one fresh reading. Never mutates deploy state. */
  const collectReading = (): DeployReadinessReading => {
    const runningSha = dependencies.runningBuildInfo.gitSha;
    const builtSha = readBuildFingerprint(
      path.join(dependencies.appRoot, SERVER_BUILD_INFO),
    ).gitSha;
    const clientBuiltSha = readClientFingerprint().gitSha;
    const headSha = dependencies.git.headSha();
    const state = dependencies.readState();
    const classification = classifyDeployStatus({
      runningSha,
      builtSha,
      clientBuiltSha,
      headSha,
      inFlight,
      commitsBetween: dependencies.git.commitsBetween,
    });

    return {
      ...classification,
      runningSha,
      builtSha,
      clientBuiltSha,
      headSha,
      lastDeploy: state?.lastDeploy ?? null,
      failure: failure ?? state?.failure ?? null,
      checkedAt: new Date(dependencies.now()).toISOString(),
    };
  };

  /** The cockpit's read; a short TTL keeps a polling strip from stat-ing per render. */
  const readReadiness = async (): Promise<DeployReadinessReading> => {
    const now = dependencies.now();
    if (inFlight === null && cached !== null && now - cached.at < cacheTtlMs) {
      return cached.reading;
    }
    const reading = collectReading();
    if (inFlight === null) {
      cached = { at: now, reading };
    }
    return reading;
  };

  /**
   * Builds in a transient unit, then — only on success — records the target sha and launches the
   * detached restarter exactly once. A failed build never restarts: applying a half-built tree
   * is the one outcome this action must not produce.
   */
  const deploy = async (): Promise<DeployExecutionResult> => {
    if (inFlight !== null) {
      return { ok: false, step: 'busy' };
    }

    inFlight = 'building';
    failure = null;
    cached = null;
    dependencies.logInfo?.('deploy: starting build');

    let buildResult: DeployCommandResult;
    try {
      buildResult = await dependencies.runBuild();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      buildResult = { exitCode: 1, output: '', errorOutput: message };
    }

    if (buildResult.exitCode !== 0) {
      const outputTail = tailOf(buildResult);
      failure = {
        step: 'build',
        outputTail,
        at: new Date(dependencies.now()).toISOString(),
      };
      inFlight = null;
      cached = null;
      dependencies.onBuildFinished?.({ ok: false, outputTail });
      dependencies.logError?.(`deploy: build failed: ${outputTail.split('\n').at(-1) ?? ''}`);
      return { ok: false, step: 'build', outputTail };
    }

    dependencies.onBuildFinished?.({ ok: true, outputTail: '' });

    const targetSha = dependencies.git.headSha() ?? dependencies.runningBuildInfo.gitSha ?? '';
    dependencies.writeState({
      targetSha,
      requestedAt: new Date(dependencies.now()).toISOString(),
      phase: 'restarting',
    });

    inFlight = 'restarting';
    cached = null;
    dependencies.logInfo?.(`deploy: build succeeded, restarting toward ${targetSha}`);

    let restartResult: DeployCommandResult;
    try {
      restartResult = await dependencies.runRestartScript(['--delay', '5']);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      restartResult = { exitCode: 1, output: '', errorOutput: message };
    }

    if (restartResult.exitCode !== 0) {
      const outputTail = tailOf(restartResult);
      failure = {
        step: 'restart',
        outputTail,
        at: new Date(dependencies.now()).toISOString(),
      };
      inFlight = null;
      cached = null;
      dependencies.onRestartFinished?.({ ok: false, targetSha });
      return { ok: false, step: 'restart', outputTail };
    }

    dependencies.onRestartFinished?.({ ok: true, targetSha });
    return { ok: true, step: 'restart', targetSha };
  };

  return {
    readReadiness,
    deploy,
  };
}

export type DeployVerificationDependencies = {
  /** The running process's own fingerprint, captured at boot. */
  runningSha: string | null;
  readState(): DeployPersistedState | null;
  writeState(state: DeployPersistedState): void;
  /** `GET /` and `GET /cockpit` status codes; null when the probe itself failed. */
  probeRoute(name: 'root' | 'cockpit'): Promise<number | null>;
  /** The fleet handshake state from the fleet-summary reading; null when unavailable. */
  readFleetState(): Promise<string | null>;
  now(): number;
  onVerificationFinished?(lastDeploy: DeployLastDeploy): void;
  logInfo?(message: string): void;
};

/**
 * The restart's second half: a new process reads the state file the deploy action wrote, then
 * verifies that it is actually the build that was requested and that the key surfaces answer.
 *
 * Returns null when there is no pending state — a plain boot, or a boot after a previous run
 * already recorded a `lastDeploy`, writes nothing and produces no `lastDeploy`.
 */
export async function verifyPendingDeploy(
  dependencies: DeployVerificationDependencies,
): Promise<DeployLastDeploy | null> {
  const state = dependencies.readState();
  if (state === null || state.targetSha === '') {
    return null;
  }
  // Already verified: a later `lastDeploy` is the same deploy's record, not a new one.
  if (state.lastDeploy !== undefined && state.lastDeploy.targetSha === state.targetSha) {
    return state.lastDeploy;
  }

  const [rootStatus, cockpitStatus, fleetState] = await Promise.all([
    dependencies.probeRoute('root'),
    dependencies.probeRoute('cockpit'),
    dependencies.readFleetState(),
  ]);

  const shaMatches = dependencies.runningSha === state.targetSha;
  const fleetOk = fleetState !== null && fleetState !== 'no-handshake' && fleetState !== 'unavailable';

  const checks: DeployCheck[] = [
    {
      name: 'build-sha',
      ok: shaMatches,
      status: shaMatches ? 200 : null,
      detail: shaMatches
        ? `running buildSha ${state.targetSha} matches the requested target`
        : `running buildSha ${dependencies.runningSha ?? '<none>'} != target ${state.targetSha}`,
    },
    {
      name: 'fleet-handshake',
      ok: fleetOk,
      status: fleetOk ? 200 : null,
      detail: `fleet state: ${fleetState ?? '<unavailable>'}`,
    },
    {
      name: 'route-root',
      ok: rootStatus === 200,
      status: rootStatus,
      detail: `GET / -> ${rootStatus ?? '<no answer>'}`,
    },
    {
      name: 'route-cockpit',
      ok: cockpitStatus === 200,
      status: cockpitStatus,
      detail: `GET /cockpit -> ${cockpitStatus ?? '<no answer>'}`,
    },
    {
      name: 'route-fleet-summary',
      ok: fleetOk,
      status: fleetOk ? 200 : null,
      detail: `GET /api/quay/fleet-summary -> ${fleetState === null ? '<no answer>' : '200 (fleet handshake readable)'}`,
    },
  ];

  const lastDeploy: DeployLastDeploy = {
    targetSha: state.targetSha,
    ok: checks.every((check) => check.ok),
    checks,
    at: new Date(dependencies.now()).toISOString(),
  };

  dependencies.writeState({
    ...state,
    phase: lastDeploy.ok ? 'verified' : 'failed',
    lastDeploy,
  });
  dependencies.onVerificationFinished?.(lastDeploy);
  dependencies.logInfo?.(
    `deploy: boot verification ${lastDeploy.ok ? 'passed' : 'FAILED'} for ${state.targetSha}`,
  );
  return lastDeploy;
}
