/**
 * The project-truth producer — one five-layer revision per fleet-registered project.
 *
 * It reads each project's board, deployment freshness and the fleet's liveness, hands them to
 * `buildProjectTruth` in `project-truth.ts`, and writes ONE observation revision through the
 * store. The store appends the delta items and fans the revision out; this file only decides
 * WHAT the reading is and WHEN it is written.
 *
 * WHICH PROJECTS IT WRITES FOR. Every project the caller hands it whose root the fleet
 * registered. An unregistered project has no `quay://` handle (see `observation-uri.ts`), so a
 * tile for it would be unaddressable — it is skipped rather than mint an id the fleet cannot
 * dereference.
 *
 * A FAILED SOURCE IS A READING, NOT AN EXCEPTION. An unreadable board, a missing fleet and a
 * deploy check that could not answer all produce a layer that says `unevaluated` with its
 * reason. Only a failure of the STORE itself suppresses the write (`refreshProject` answers
 * `null`), because there is nowhere to put the reading.
 *
 * The deploy reader reuses `scripts/check-deploy-freshness.mjs` (invoked with `--json`) instead
 * of re-implementing its comparison: the running build's `/health` `buildSha` against the
 * project's git ref. Only a project with a `deploy` target is asked at all.
 *
 * Consumers: the composition root (periodically, on the quay snapshot's TTL, and on task-status
 * transitions) and `server/modules/observation/tests/project-truth.test.ts`.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';

import {
  createQuayFleetLivenessReader,
  type QuayFleetLivenessReading,
} from '@/modules/quay/index.js';

import { formatProjectUri } from './observation-uri.js';
import type { ObservedObject, ObservationStore } from './observation-store.js';
import {
  buildProjectTruth,
  type ProjectTruthBoardReading,
  type ProjectTruthDeployReading,
  type ProjectTruthDeployTarget,
  type ProjectTruthDigest,
  type ProjectTruthProjectRef,
} from './project-truth.js';

/** The producer name every project revision is stamped with. */
export const PROJECT_TRUTH_PRODUCER = 'project-truth';

/**
 * The producer's cadence. It matches the quay snapshot's TTL on purpose: the snapshot is the
 * in-flight source, so refreshing faster would only re-read the same snapshot.
 */
export const PROJECT_TRUTH_REFRESH_MS = 30_000;

/** The child a deploy check runs into; production binds Node's `execFile`. */
export type ProjectTruthDeployExecResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

export type ProjectTruthDeployExec = (
  file: string,
  args: readonly string[],
  options: { cwd: string; timeout: number; maxBuffer: number; encoding: 'utf8'; windowsHide: boolean },
) => Promise<ProjectTruthDeployExecResult>;

/**
 * Reads a project's deployed build against its ref by running the repo's own one-shot detector.
 *
 * The script answers its verdict as JSON on stdout (`--json`) and keeps its documented exit
 * codes; both are read so a script that answered but printed something unexpected is
 * `unknown` with the child's stderr rather than a silent green.
 *
 * Consumer: {@link createProjectTruthProducer}'s default `readDeploy`.
 */
export function createCheckDeployFreshnessReader(options: {
  exec?: ProjectTruthDeployExec;
  nodePath?: string;
  timeoutMs?: number;
  now?: () => number;
} = {}): (project: ProjectTruthProjectRef) => Promise<ProjectTruthDeployReading> {
  const exec = options.exec ?? defaultDeployExec;
  const nodePath = options.nodePath ?? process.execPath;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const now = options.now ?? (() => Date.now());

  return async (project) => {
    const target = project.deploy;
    if (target === null) {
      return { kind: 'not-applicable', reason: '该项目没有部署概念（目前只有 CloudCLI 自身有部署）' };
    }

    const scriptPath = path.join(project.projectPath, 'scripts', 'check-deploy-freshness.mjs');
    const checkedAt = now();
    let result: ProjectTruthDeployExecResult;
    try {
      result = await exec(
        nodePath,
        [scriptPath, '--url', target.healthUrl, '--ref', target.ref, '--json'],
        { cwd: project.projectPath, timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf8', windowsHide: true },
      );
    } catch (error) {
      return {
        kind: 'unknown',
        reason: `部署检查无法运行：${error instanceof Error ? error.message : String(error)}`,
        checkedAt,
      };
    }

    const document = parseDeployDocument(result.stdout);
    if (document === null) {
      const detail = result.stderr.trim() || result.error || `check-deploy-freshness 退出 ${result.code === null ? '异常' : result.code}`;
      return { kind: 'unknown', reason: `部署检查没有给出可读 JSON：${detail}`, checkedAt };
    }

    const verdict = typeof document.verdict === 'string' ? document.verdict : '';
    const buildSha = typeof document.buildSha === 'string' ? document.buildSha : '';
    const headSha = typeof document.refSha === 'string' ? document.refSha : '';
    switch (verdict) {
      case 'fresh':
        return { kind: 'fresh', buildSha, headSha, checkedAt };
      case 'stale': {
        const behindBy = typeof document.behindBy === 'number' && Number.isFinite(document.behindBy)
          ? document.behindBy
          : 0;
        return { kind: 'behind', buildSha, headSha, behindBy, checkedAt };
      }
      case 'diverged':
        return { kind: 'diverged', buildSha, headSha, checkedAt };
      default:
        return {
          kind: 'unknown',
          reason:
            typeof document.reason === 'string' && document.reason !== ''
              ? document.reason
              : result.stderr.trim() || '部署检查返回了未识别的读数',
          checkedAt,
        };
    }
  };
}

function parseDeployDocument(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const defaultDeployExec: ProjectTruthDeployExec = (file, args, options) =>
  new Promise((resolve) => {
    execFile(file, [...args], options, (error, stdout, stderr) => {
      // A non-zero status is the detector's normal "STALE"/"DIVERGED" answer, so it is NOT an
      // error here: the JSON on stdout decides the reading.
      resolve({
        code: error === null ? 0 : typeof (error as { code?: unknown }).code === 'number'
          ? ((error as { code?: number }).code as number)
          : null,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        ...(error === null ? {} : { error: error.message }),
      });
    });
  });

/** What the producer needs from the world. Production supplies the default readers. */
export type ProjectTruthProducerDeps = {
  /** The observation store every revision is written through. */
  store: ObservationStore;
  /**
   * Reads one project's board: the compact full task list, the snapshot's in-flight set and
   * the goal/AC gate records. REQUIRED because the quay service already owns those reads —
   * the composition root passes them in rather than this module re-implementing the CLI.
   */
  readBoard: (project: ProjectTruthProjectRef) => Promise<ProjectTruthBoardReading>;
  /** Deploy freshness; defaults to {@link createCheckDeployFreshnessReader}. */
  readDeploy?: (project: ProjectTruthProjectRef) => Promise<ProjectTruthDeployReading>;
  /** Fleet liveness; defaults to the quay service's one normalized reader. */
  readFleetLiveness?: () => Promise<QuayFleetLivenessReading>;
  /** The clock stamped onto the write and the digest. Defaults to `Date.now`. */
  now?: () => number;
};

/** The producer's two verbs. */
export type ProjectTruthProducer = {
  /** Refreshes ONE project. Answers `null` when the project is unaddressable or the store failed. */
  refreshProject(project: ProjectTruthProjectRef): Promise<ObservedObject | null>;
  /** Refreshes every project sequentially, so a fan-out never becomes a subprocess storm. */
  refreshAll(projects: readonly ProjectTruthProjectRef[]): Promise<ObservedObject[]>;
};

/**
 * The window the next reading measures landings against.
 *
 * It is the previous reading's observation instant ONLY when that reading actually read the
 * task list. If the task list was unreadable, the previous window's `since` is carried forward:
 * a failed read must not silently swallow the landings that happened while it failed.
 */
function readLandingCursor(previous: ProjectTruthDigest | null): number | null {
  if (previous === null) return null;
  const landed = previous.layers.landed;
  return landed.state === 'ok' ? previous.observedAt : landed.since;
}

/** A previous digest is only a cursor when it is the shape this producer wrote. */
function readPreviousDigest(object: ObservedObject | null): ProjectTruthDigest | null {
  if (object === null) return null;
  const digest = object.digest as Partial<ProjectTruthDigest> | undefined;
  if (digest === undefined) return null;
  if (typeof digest.observedAt !== 'number' || !Number.isFinite(digest.observedAt)) return null;
  if (digest.layers === null || typeof digest.layers !== 'object') return null;
  const landed = (digest.layers as { landed?: unknown }).landed;
  if (landed === null || typeof landed !== 'object') return null;
  return digest as ProjectTruthDigest;
}

/** An empty board whose every source carries the same failure — used when the read threw. */
function unavailableBoard(reason: string): ProjectTruthBoardReading {
  return {
    tasks: [],
    inFlight: [],
    goals: [],
    inFlightUnavailableReason: reason,
    tasksUnavailableReason: reason,
    goalsUnavailableReason: reason,
  };
}

/** The reading the producer uses when the fleet read itself threw. */
function unavailableLiveness(reason: string): QuayFleetLivenessReading {
  return { available: false, source: 'none', at: null, fleet: null, projects: [], reason };
}

/** Builds the producer over its injected world. */
export function createProjectTruthProducer(deps: ProjectTruthProducerDeps): ProjectTruthProducer {
  const now = deps.now ?? (() => Date.now());
  const readDeploy = deps.readDeploy ?? createCheckDeployFreshnessReader({ now });
  const defaultLivenessReader = deps.readFleetLiveness === undefined
    ? createQuayFleetLivenessReader()
    : null;
  const readFleetLiveness = deps.readFleetLiveness ?? (() => defaultLivenessReader!.read());

  const refreshProject = async (project: ProjectTruthProjectRef): Promise<ObservedObject | null> => {
    // No fleet id ⇒ no `quay://<id>/board` address ⇒ nowhere the wall could dereference it.
    if (project.fleetProjectId === null) return null;

    const uri = formatProjectUri(project.fleetProjectId);
    const previousObject = deps.store.getObject(uri);
    const previous = readPreviousDigest(previousObject);
    const cursor = readLandingCursor(previous);

    const [board, liveness, deploy] = await Promise.all([
      deps.readBoard(project).catch((error: unknown) =>
        unavailableBoard(`board 读取失败：${error instanceof Error ? error.message : String(error)}`),
      ),
      readFleetLiveness().catch((error: unknown) =>
        unavailableLiveness(`quay-fleet 读取失败：${error instanceof Error ? error.message : String(error)}`),
      ),
      project.deploy === null
        ? Promise.resolve<ProjectTruthDeployReading>({
            kind: 'not-applicable',
            reason: '该项目没有部署概念（目前只有 CloudCLI 自身有部署）',
          })
        : readDeploy(project).catch(
            (error: unknown): ProjectTruthDeployReading => ({
              kind: 'unknown',
              reason: `部署检查失败：${error instanceof Error ? error.message : String(error)}`,
              checkedAt: null,
            }),
          ),
    ]);

    const reading = buildProjectTruth({
      project,
      board,
      deploy,
      liveness,
      cursor,
      previous,
      now: now(),
    });

    try {
      return deps.store.writeRevision({
        uri,
        kind: 'project',
        title: project.title.trim() || project.fleetProjectId,
        status: reading.status,
        digest: reading.digest as unknown as Record<string, unknown>,
        deltaItems: reading.deltaItems,
        provenance: {
          producer: PROJECT_TRUTH_PRODUCER,
          tier: 'deterministic',
          evaluatedAt: reading.digest.observedAt,
        },
      });
    } catch {
      // A store failure has nowhere to be recorded; the next refresh retries.
      return null;
    }
  };

  return {
    refreshProject,
    async refreshAll(projects) {
      const written: ObservedObject[] = [];
      for (const project of projects) {
        const object = await refreshProject(project);
        if (object !== null) written.push(object);
      }
      return written;
    },
  };
}
