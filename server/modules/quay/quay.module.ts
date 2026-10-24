import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { readContextEventStatus } from '@/modules/context-events/index.js';
import { projectsDb, sessionsDb, uiLastOpenedDb } from '@/modules/database/index.js';
import { parseFrontMatter } from '@/shared/frontmatter.js';
import { readInitiativeAuditRatio } from '@/shared/ports/initiative-audit-ratio.port.js';
import { findApplicationRoot, getModuleDirectory } from '@/shared/utils.js';

import { createQuayFleetProjectIdResolver } from './quay-fleet-project-id.js';
import { createQuayFleetRegistry } from './quay-fleet-registry.js';
import { DEFAULT_INITIATIVE_AUDIT_RATIO, createQuayInitiatives } from './quay-initiatives.js';
import { QUAY_COMMAND_TIMEOUT_MS, createQuayProcessRunner } from './quay-process.js';
import { createQuayRouter } from './quay.routes.js';
import { createQuayService, type QuayFileReader } from './quay.service.js';
import {
  createSessionTaskChainService,
  type SessionTaskChainDependencies,
  type SessionTaskStoreRecord,
} from './session-task-chain.service.js';

/** How long a fetched snapshot stays fresh before a panel reopen spawns the CLI again. */
const SNAPSHOT_TTL_MS = 30_000;

/**
 * Production read-only filesystem adapter for the `.quay/` carrier files. Only
 * byte-range/whole-file reads are exposed; paths are joined under the project
 * root by the service, so a request can never name an arbitrary file.
 */
const quayFileReader: QuayFileReader = {
  size: async (filePath) => {
    try {
      const stats = await fs.promises.stat(filePath);
      return stats.isFile() ? stats.size : null;
    } catch {
      return null;
    }
  },
  readChunk: async (filePath, position, length) => {
    const handle = await fs.promises.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  },
  readText: (filePath) => fs.promises.readFile(filePath, 'utf8'),
};

/**
 * Bound on the dashboard liveness probe. It is deliberately far below the child-process
 * bound (`QUAY_COMMAND_TIMEOUT_MS`): the probe runs in-process, concurrently with the
 * snapshot's CLI reads, and is only ever reached after the carrier has already named a
 * `web` address. A refused localhost connection settles immediately, so this ceiling only
 * ever applies to a black-holed address.
 */
const DASHBOARD_PROBE_TIMEOUT_MS = 2_000;

/**
 * In-process liveness probe for a project's `quay serve` web face: one HTTP `GET /health`
 * with a hard timeout, answering `true` only for a 2xx. It takes the reading quay's own
 * `server status` used to take, without that command's six driver-kind subprocesses.
 *
 * It never rejects — a refused connection, a timeout, an unresolvable host and a non-2xx
 * answer all read `false` — so an unreachable dashboard becomes a `null` link rather than
 * an error the panel has to report.
 */
const probeWebService = async (host: string, port: number): Promise<boolean> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DASHBOARD_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`http://${host}:${port}/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * The CloudCLI project id → quay-fleet registry id join behind every `quay://` project segment.
 * The fleet is the authority for project identity: a reference must say `quay://claudecodeui/…`,
 * never the CloudCLI UUID, so the registry id is looked up per registered root and cached for a
 * short TTL. A host without the fleet CLI reads every project as unregistered instead of failing.
 */
export const quayFleetProjectIds = createQuayFleetProjectIdResolver({
  resolveProjectPathById: (projectId) => projectsDb.getProjectPathById(projectId),
  listProjects: () =>
    projectsDb.getProjectPaths().map((project) => ({
      projectId: project.project_id,
      projectPath: project.project_path,
    })),
});

/** The single quay display service instance; also used by the projects module for Tier-1 detection. */
export const quayService = createQuayService({
  fileExists: (filePath) => fs.existsSync(filePath),
  resolveProjectPathById: (projectId) => projectsDb.getProjectPathById(projectId),
  // The fleet summary fans out over the whole active project registry, so it needs the
  // listing itself rather than one id at a time. Archived projects are excluded by
  // `getProjectPaths`, matching what the sidebar shows.
  listProjects: () =>
    projectsDb.getProjectPaths().map((project) => ({
      projectId: project.project_id,
      projectPath: project.project_path,
    })),
  // Binary resolution is project-scoped inside the adapter: the service passes each
  // project's `projectPath` as the runner's `cwd`, and the adapter resolves
  // `<cwd>/.quay/plugin/bin/quay` from it. The explicit `warn` binding routes the
  // migration-period bare-PATH fallback into the server log instead of leaving it silent.
  runCommand: createQuayProcessRunner({ warn: (message) => console.warn(message) }),
  readFile: quayFileReader,
  // The dashboard link's liveness reading: an in-process HTTP probe, so it costs no child
  // process (the gap this task closes) while still refusing to link to a dead server.
  probeWebService,
  now: () => Date.now(),
  snapshotTtlMs: SNAPSHOT_TTL_MS,
  commandTimeoutMs: QUAY_COMMAND_TIMEOUT_MS,
  fleetProjectIdResolver: quayFleetProjectIds,
  // The context-event stream's state rides beside the fleet reading: both answer
  // "is this host recording anything?", and a reader should not have to call two
  // endpoints to find out.
  readContextEventsStatus: () => readContextEventStatus(),
});

/**
 * The fleet registry seam the cockpit's pinned-target read/write goes through. It maps a
 * CloudCLI project id to the fleet's own registry id by comparing registered roots, and every
 * failure is an answer (`{ok:false, reason}`) rather than a thrown error — a host without the
 * fleet CLI still renders and routes, falling back to the last-opened session.
 */
export const quayFleetRegistry = createQuayFleetRegistry({
  resolveProjectPathById: (projectId) => projectsDb.getProjectPathById(projectId),
});

/**
 * The initiative view / decision queue reading. The spot-check sampling ratio is the SERVER
 * settings file's `initiative.auditRatio`, which `server/index.ts` reads once at boot and
 * installs through the shared port — importing the settings module from here would close
 * `quay -> settings -> mcp-gateway -> quay` and pull this module into AC-394's provider cycle.
 * The read is lazy because the port is installed after this module evaluates; the service
 * memoizes the first answer. An uninstalled port keeps the shipped default, exactly what the
 * settings loader would answer for an unconfigured deployment.
 */
export const quayInitiatives = createQuayInitiatives({
  resolveAuditRatio: () => readInitiativeAuditRatio() ?? DEFAULT_INITIATIVE_AUDIT_RATIO,
});

/** The app root this module was loaded from; the deploy fingerprints live at its root. */
const SESSION_CHAIN_APP_ROOT = findApplicationRoot(getModuleDirectory(import.meta.url));

/** One build fingerprint file's `gitSha`; absent or malformed is `null`, never a throw. */
function readFingerprintGitSha(filePath: string): string | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return null;
    const sha = (parsed as { gitSha?: unknown }).gitSha;
    return typeof sha === 'string' ? sha : null;
  } catch {
    return null;
  }
}

/**
 * The build the running process was STARTED from, captured at module evaluation (boot).
 *
 * `dist-server/build-info.json` is also what the last build wrote, so it may move ahead of this
 * value after a rebuild; that gap is exactly what 「已构建待重启」 means. Keeping the boot
 * reading in its own constant is what stops a fresh build from being reported as live.
 */
const RUNNING_BUILD_SHA = readFingerprintGitSha(
  path.join(SESSION_CHAIN_APP_ROOT, 'dist-server', 'build-info.json'),
);

/** One task file under `<projectPath>/tasks/`, parsed; absent or unreadable is `null`. */
function readProjectTask(projectPath: string, taskId: string): SessionTaskStoreRecord | null {
  // The task id reaches this through transcript content, so it is validated before any join.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId)) return null;
  try {
    const raw = fs.readFileSync(path.join(projectPath, 'tasks', `${taskId}.md`), 'utf8');
    const parsed = parseFrontMatter(raw);
    const data = parsed.data as Record<string, unknown>;
    const status = typeof data.status === 'string' ? data.status : 'unknown';
    const title = typeof data.title === 'string' && data.title.trim() !== '' ? data.title : taskId;
    return { status, title, body: parsed.content };
  } catch {
    return null;
  }
}

/** Runs one read-only git command in a project; a non-zero exit or spawn failure is `null`. */
function gitOutput(projectPath: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', ['-C', projectPath, ...args], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/** The task ids whose branch (`task/<id>`) is checked out in a worktree of this project. */
function readWorktreeTaskIds(projectPath: string): ReadonlySet<string> {
  const ids = new Set<string>();
  const listing = gitOutput(projectPath, ['worktree', 'list', '--porcelain']);
  if (listing === null) return ids;
  for (const line of listing.split(/\r?\n/)) {
    const match = /^branch refs\/heads\/task\/(\S+)$/.exec(line.trim());
    if (match?.[1] !== undefined && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(match[1])) {
      ids.add(match[1]);
    }
  }
  return ids;
}

/**
 * The commit that landed a task: the newest develop commit whose message names it, either as
 * the task branch (`task/<id>`) or the task-store subject (`tasks: <id> …`). `develop` first,
 * then HEAD, so a project without a develop line still answers from its default line.
 */
function findLandCommit(projectPath: string, taskId: string): string | null {
  for (const ref of ['develop', 'HEAD']) {
    for (const needle of [`task/${taskId}`, `tasks: ${taskId}`]) {
      const sha = gitOutput(projectPath, [
        'log', ref, '-n', '1', '--format=%H', '--fixed-strings', `--grep=${needle}`,
      ]);
      const trimmed = sha?.trim() ?? '';
      if (trimmed !== '') return trimmed.split(/\r?\n/)[0];
    }
  }
  return null;
}

/** `git merge-base --is-ancestor`; exit 1 (not an ancestor) and spawn errors both answer false. */
function isGitAncestor(projectPath: string, ancestor: string, descendant: string): boolean {
  try {
    execFileSync('git', ['-C', projectPath, 'merge-base', '--is-ancestor', ancestor, descendant], {
      stdio: 'ignore',
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The session → task flow chain reading. Every dependency is a reader: task files, the
 * project's git history and the two build fingerprints. Nothing here writes, builds or restarts.
 */
export const sessionTaskChain = createSessionTaskChainService({
  resolveProjectPath: (projectId) => projectsDb.getProjectPathById(projectId),
  resolveTranscriptPath: ({ sessionId }) => sessionsDb.getSessionById(sessionId)?.jsonl_path ?? null,
  transcriptSize: async (transcriptPath) => {
    try {
      const stats = await fs.promises.stat(transcriptPath);
      return stats.isFile() ? stats.size : null;
    } catch {
      return null;
    }
  },
  readTranscriptRange: async (transcriptPath, start) => {
    let handle: fs.promises.FileHandle | null = null;
    try {
      handle = await fs.promises.open(transcriptPath, 'r');
      const { size } = await handle.stat();
      if (start >= size) return '';
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  },
  readTask: readProjectTask,
  worktreeTaskIds: readWorktreeTaskIds,
  findLandCommit,
  isAncestor: isGitAncestor,
  readDeployShas: () => ({
    // The disk's last build may be newer than the process; only `builtSha` follows it.
    builtSha: readFingerprintGitSha(path.join(SESSION_CHAIN_APP_ROOT, 'dist-server', 'build-info.json')),
    runningSha: RUNNING_BUILD_SHA,
  }),
  now: () => Date.now(),
});

/**
 * Used by the server entrypoint to mount the authenticated Quay endpoints. The write surface is
 * the interface-session triple; everything else stays read-only.
 */
export const quayRoutes = createQuayRouter({
  quayService,
  fleetRegistry: quayFleetRegistry,
  readLastOpenedSession: () => uiLastOpenedDb.read(),
  initiatives: quayInitiatives,
  sessionTaskChain,
});
