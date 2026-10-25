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
import { createQuayCapabilities, type QuayEntrypointIdentity } from './quay-capabilities.js';
import { createQuayDispatchCarrier } from './quay-dispatch-carrier.js';
import { QUAY_COMMAND_TIMEOUT_MS, createQuayProcessRunner } from './quay-process.js';
import { createQuayTaskEvents } from './quay-task-events.service.js';
import { createQuayRouter } from './quay.routes.js';
import { createQuayService, type QuayFileReader } from './quay.service.js';
import {
  createSessionMentionsService,
  type SessionMentionsGoalRow,
  type SessionMentionsTaskRow,
} from './session-mentions.service.js';
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

/**
 * The event-driven refresh's read hook, installed on the service just below. The service is
 * created first (it owns the task index), and the events service is created after it (it
 * consumes the index primitives); this holder lets the service's read path reach the events
 * service without a circular construction. Until it is installed the hook is a no-op, and it
 * only ever fires on a real read, never at module-evaluation time.
 */
const taskIndexReadListener: { current: (projectId: string) => void } = { current: () => undefined };

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
  // Every task-index read is an activity signal for the event-driven refresh.
  onTaskIndexRead: (projectId) => taskIndexReadListener.current(projectId),
});

/**
 * The path the project-scoped adapter will spawn: `<projectRoot>/.quay/plugin/bin/quay` when
 * present, else the first `quay` on this process's PATH (the adapter's own migration-period
 * fallback). Resolving it here — rather than duplicating the spawn logic — is what lets the
 * capability cache key on the binary that will actually run.
 */
function resolveQuayEntrypointPath(projectPath: string): string | null {
  const scoped = path.join(projectPath, '.quay', 'plugin', 'bin', 'quay');
  if (fs.existsSync(scoped)) {
    return scoped;
  }
  const pathValue = process.env.PATH ?? '';
  for (const dir of pathValue.split(path.delimiter)) {
    if (dir === '') {
      continue;
    }
    const candidate = path.join(dir, 'quay');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** The realpath+mtime+size identity the capability cache re-probes on, or `null`. */
function readQuayEntrypointIdentity(projectPath: string): QuayEntrypointIdentity | null {
  const entrypoint = resolveQuayEntrypointPath(projectPath);
  if (entrypoint === null) {
    return null;
  }
  try {
    const realpath = fs.realpathSync(entrypoint);
    const stats = fs.statSync(realpath);
    return stats.isFile()
      ? { realpath, mtimeMs: stats.mtimeMs, size: stats.size }
      : null;
  } catch {
    return null;
  }
}

/**
 * The production directory watcher behind the event-driven refresh. It watches the `.quay`
 * DIRECTORY (not the two files): the driver replaces both carriers by atomic rename, which
 * would leave a file-level watcher pinned to the old inode. `persistent: false` means the
 * watcher never keeps the server process alive; a missing/unwatchable directory answers
 * `null` (project off) rather than throwing.
 */
function watchQuayDirectory(
  dirPath: string,
  onChange: (eventType: string, filename: string | null) => void,
): { close(): void; onError(handler: (error: Error) => void): void } | null {
  try {
    const watcher = fs.watch(dirPath, { persistent: false }, (eventType, filename) => {
      onChange(eventType, filename === null ? null : String(filename));
    });
    return {
      close: () => watcher.close(),
      onError: (handler) => {
        watcher.on('error', handler);
      },
    };
  } catch {
    return null;
  }
}

/** `kill(pid, 0)` liveness; `EPERM` means the process exists but may not be signalled. */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The per-project verb capability probe (`--help` → `task log` / `lanes`). Consumers:
 * `quayTaskEvents` (it may only watch/call `task log` when the verb is available).
 */
export const quayCapabilities = createQuayCapabilities({
  // The same whitelisted boundary every other read goes through; `--help` is on the whitelist.
  runCommand: (cwd, args) => quayService.runQuayCommand(cwd, args),
  readEntrypoint: readQuayEntrypointIdentity,
  now: () => Date.now(),
  log: (message) => console.log(message),
  commandTimeoutMs: QUAY_COMMAND_TIMEOUT_MS,
});

/**
 * The read-only `worker-dispatch.json` reader. Consumers: the panel-facing quay API and the
 * event service's lanes invalidation (the latter only observes the file's change, not its
 * contents). `phase` is deliberately absent — it stays a lanes-only reading.
 */
export const quayDispatchCarrier = createQuayDispatchCarrier({
  resolveProjectPathById: (projectId) => projectsDb.getProjectPathById(projectId),
  readFile: quayFileReader,
  isProcessAlive: processIsAlive,
});

/**
 * The event-driven task-index refresh. Consumers: `quayService.readTaskIndex` reports every
 * read through `noteProjectRead` (installed just below), and the `.quay/worker-dispatch.json`
 * change invalidates that project's lanes cache. The TTL full read is left exactly as it was.
 */
export const quayTaskEvents = createQuayTaskEvents({
  now: () => Date.now(),
  resolveProjectPathById: (projectId) => projectsDb.getProjectPathById(projectId),
  readTaskIndex: (projectId) => quayService.readTaskIndex(projectId),
  taskIndexLoadStartedAtMs: (projectId) => quayService.getTaskIndexLoadStartedAtMs(projectId),
  requestTaskIndexLoad: (projectId, options) => quayService.requestTaskIndexLoad(projectId, options),
  updateTaskIndexRow: (projectId, taskId, row) => quayService.updateTaskIndexRow(projectId, taskId, row),
  capabilities: quayCapabilities,
  runCommand: (cwd, args) => quayService.runQuayCommand(cwd, args),
  watchPath: watchQuayDirectory,
  onDispatchFileChanged: (projectId) => quayService.invalidateLanesForProject(projectId),
  log: (message) => console.log(message),
});

// The service was created before the events service existed; install the read hook now.
taskIndexReadListener.current = quayTaskEvents.noteProjectRead;

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

/** A transcript file's size in bytes, or `null` when it cannot be stat-ed. */
async function readTranscriptSize(transcriptPath: string): Promise<number | null> {
  try {
    const stats = await fs.promises.stat(transcriptPath);
    return stats.isFile() ? stats.size : null;
  } catch {
    return null;
  }
}

/**
 * Bytes from `start` to EOF decoded as UTF-8, or `null` when the file cannot be read.
 *
 * Shared by both session readers (the write-chain scan and the mention scan): the two read the
 * same transcript under the same byte-offset contract, and a second implementation could drift
 * on the one thing they must agree about — where a chunk begins.
 */
async function readTranscriptRangeFrom(transcriptPath: string, start: number): Promise<string | null> {
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
}

/** Parses one whitelisted command's JSON stdout, or `null` when it is not a JSON document. */
function parseJsonStdout(stdout: string): unknown {
  if (stdout.trim() === '') return null;
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    return null;
  }
}

/** Whether a value is a non-array object. */
function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The session → task flow chain reading. Every dependency is a reader: task files, the
 * project's git history and the two build fingerprints. Nothing here writes, builds or restarts.
 */
export const sessionTaskChain = createSessionTaskChainService({
  resolveProjectPath: (projectId) => projectsDb.getProjectPathById(projectId),
  resolveTranscriptPath: ({ sessionId }) => sessionsDb.getSessionById(sessionId)?.jsonl_path ?? null,
  transcriptSize: readTranscriptSize,
  readTranscriptRange: readTranscriptRangeFrom,
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

/** One `task list --json --no-body` array narrowed to the mention join's rows, or `null`. */
function parseTaskRowsForMentions(stdout: string): SessionMentionsTaskRow[] | null {
  const parsed = parseJsonStdout(stdout);
  if (!Array.isArray(parsed)) return null;

  const rows: SessionMentionsTaskRow[] = [];
  for (const item of parsed) {
    if (!isRecordValue(item) || typeof item.id !== 'string') continue;
    rows.push({
      taskId: item.id,
      title: typeof item.title === 'string' && item.title !== '' ? item.title : item.id,
      status: typeof item.status === 'string' ? item.status : 'unknown',
      // `--no-body` rows still carry `goal_ac`; the shared index row type deliberately does
      // not, so this reading carries its own copy rather than widening the MCP-visible shape.
      goalAc: typeof item.goal_ac === 'string' && item.goal_ac.trim() !== '' ? item.goal_ac.trim() : null,
    });
  }
  return rows;
}

/** One `goal list --json` array narrowed to goals AND their criterion rows, or `null`. */
function parseGoalRowsForMentions(stdout: string): SessionMentionsGoalRow[] | null {
  const parsed = parseJsonStdout(stdout);
  if (!Array.isArray(parsed)) return null;

  const rows: SessionMentionsGoalRow[] = [];
  for (const item of parsed) {
    if (!isRecordValue(item) || typeof item.id !== 'string') continue;
    rows.push({
      id: item.id,
      title: typeof item.title === 'string' ? item.title : '',
      status: typeof item.status === 'string' ? item.status : 'unknown',
      kind: typeof item.kind === 'string' ? item.kind : null,
      goal: typeof item.goal === 'string' && item.goal.trim() !== '' ? item.goal.trim() : null,
    });
  }
  return rows;
}

/**
 * The session's mention reading: which tasks and goals the conversation's prose names.
 *
 * Its two vocabulary reads reuse the display service's whitelisted command boundary (so the
 * exact-match whitelist stays the single way a `quay` child is spawned here), and its phase join
 * reuses `getQuayLanes` — the same `lanes` reading the Loop pulse plots — rather than a second
 * gantt read.
 */
export const sessionMentions = createSessionMentionsService({
  resolveProjectPath: (projectId) => projectsDb.getProjectPathById(projectId),
  resolveTranscriptPath: ({ sessionId }) => sessionsDb.getSessionById(sessionId)?.jsonl_path ?? null,
  transcriptSize: readTranscriptSize,
  readTranscriptRange: readTranscriptRangeFrom,
  readTaskRows: async (projectPath) => {
    const result = await quayService.runQuayCommand(projectPath, ['task', 'list', '--json', '--no-body']);
    return result.ok ? parseTaskRowsForMentions(result.stdout) : null;
  },
  readGoalRows: async (projectPath) => {
    const result = await quayService.runQuayCommand(projectPath, ['goal', 'list', '--json']);
    return result.ok ? parseGoalRowsForMentions(result.stdout) : null;
  },
  readLanes: async ({ projectId }) => {
    const reading = await quayService.getQuayLanes(projectId);
    return reading?.gantt ?? null;
  },
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
  sessionMentions,
});
