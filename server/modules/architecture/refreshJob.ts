/**
 * The manual ArchGuard re-analysis job — one single-flight child per project root.
 *
 * WHY THIS EXISTS. The architecture tab reads `.archguard/query/**`, and until now
 * nothing in the UI could refresh it: `service.ts` only reads, and `cache.ts` treats
 * the manifest content as the invalidation key. This module is the write half — a
 * manual, whole-project re-analysis triggered from the tab's footer — plus the
 * coalescing that keeps several tabs or sessions from spawning the same multi-second
 * CLI run at once.
 *
 * THE CLI IS A CHILD PROCESS, NEVER A SHELL. `node <archguard>/dist/cli/index.js
 * analyze -s <sources…> --lang <language> -f json --work-dir <staging>` is spawned as
 * an argv array (`spawn`, no `shell`). `-f json` is deliberate: the Mermaid/SVG
 * renderer is not part of what the tab reads, and it can fail on a headless host
 * (`CSSStyleSheet is not defined`) while still writing correct `query/` artifacts —
 * measured during this task's spike, where the default (mermaid) form exited 1 with
 * valid artifacts. The JSON form exits 0 and produces the same `query/**`.
 *
 * ATOMIC PUBLISH, FAILURE KEEPS THE OLD ANALYSIS. ArchGuard writes each artifact
 * file atomically but the run as a whole is NOT atomic across scopes: a later scope
 * can fail after earlier ones were written, and the manifest is written last. So the
 * child always runs into `.archguard/refresh/<jobId>`; only on exit 0 is the staged
 * `query` directory renamed over the live one (old `query` moved aside first, restored
 * if the second rename fails). A failed or timed-out run therefore leaves the live
 * `.archguard/query` byte-for-byte untouched, and auxiliary query products
 * (`duplicates`, `git-history`, `shape-smells`, …) are carried from the old directory
 * into the new one so the swap does not delete artifacts this refresh does not own.
 *
 * WHERE THE KNOBS LIVE. The CLI entry, timeout, memory cap and the criterion's
 * fault lever are the `architecture.refresh` block of the server settings file
 * (`SERVER_SETTINGS_PATH`, then `~/.config/claudecodeui/server.settings.json`) — the
 * same deployment-editable file the other server knobs use. This module reads that
 * block itself rather than importing `modules/settings`: `modules/architecture` is a
 * leaf in the server import graph (AC-394), so reaching a sibling barrel is not
 * available to it. The block is re-read when its mtime changes, so a criterion can
 * rewrite the file between arms without restarting the server.
 *
 * THE MEMORY CAP. When `memoryLimitMb` is positive and a systemd user manager answers,
 * the child is started through `systemd-run --user --scope -p MemoryMax=…M
 * -p MemorySwapMax=0`, the same pattern as `scripts/with-memory-cap.sh`; the child is
 * spawned detached and killed through its process group, so terminating it never
 * depends on matching a command line and cannot miss the CLI's own worker processes.
 *
 * Consumers: `routes.ts` (the two HTTP verbs), `module.ts` (the process-wide instance
 * plus the shutdown hook), and `tests/refreshJob.test.ts`.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs, { promises as fsPromises } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import type {
  ArchitectureRefreshStage,
  ArchitectureRefreshStartResult,
  ArchitectureRefreshStatus,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/** The environment variable naming the server settings file (the same literal `modules/settings` reads). */
export const SERVER_SETTINGS_PATH_ENV = 'SERVER_SETTINGS_PATH';

/** The package whose CLI this job runs. */
const ARCHGUARD_PACKAGE = '@yalehwang/archguard';

/** The CLI entry inside the package (the same path `mcp-launcher.mjs` resolves). */
const ARCHGUARD_CLI_RELATIVE = path.join('dist', 'cli', 'index.js');

/** How many trailing stderr lines a status reading carries. */
const STDERR_TAIL_LINES = 40;

/** How long a child gets to exit after SIGTERM before the group is SIGKILLed. */
const KILL_GRACE_MS = 5_000;

/** Shipped `architecture.refresh` values. Mirrors `config/server.settings.example.json`. */
const DEFAULT_REFRESH_SETTINGS: {
  cliPath: string;
  timeoutMs: number;
  memoryLimitMb: number;
  defect: ArchitectureRefreshDefect;
} = {
  cliPath: '',
  timeoutMs: 20 * 60 * 1000,
  memoryLimitMb: 6144,
  defect: '',
};

/**
 * The criterion's fault lever. `no-coalesce` makes a concurrent start spawn its own
 * job (the absent single-flight); `no-preserve` runs the CLI against the LIVE
 * `.archguard` (the absent staging/swap, so a failure leaves partial artifacts).
 * Empty is the shipped behaviour; the e2e control arm drives these through the
 * settings file.
 */
export type ArchitectureRefreshDefect = '' | 'no-coalesce' | 'no-preserve';

/** One reading of the `architecture.refresh` block. */
type RefreshSettings = {
  /** Explicit CLI entry path; empty means "resolve it the way the launcher does". */
  readonly cliPath: string;
  /** Whole-child ceiling in milliseconds. */
  readonly timeoutMs: number;
  /** `MemoryMax` for the child's scope; 0 disables the cap (and the systemd-run wrapper). */
  readonly memoryLimitMb: number;
  /** The criterion seam; empty in production. */
  readonly defect: ArchitectureRefreshDefect;
  /** The file this reading came from, or null when no file was consulted. */
  readonly path: string | null;
  /** `default` when nothing was configured (or the file could not be read). */
  readonly source: 'default' | 'file';
  /** Every value that fell back to its shipped default, oldest first. */
  readonly problems: readonly string[];
};

type RefreshSettingsSource = {
  read(): RefreshSettings;
};

/**
 * The status/start surface `routes.ts` consumes.
 *
 * `start` never throws for a runtime failure (unresolvable CLI, spawn error, non-zero
 * exit): those are the job's `failed` reading, which the tab shows with a reason and a
 * Retry. It DOES throw `PROJECT_NOT_FOUND` for an unknown project id, like every other
 * architecture read.
 */
export type ArchguardRefreshJob = {
  start(projectId: string): ArchitectureRefreshStartResult;
  status(projectId: string): ArchitectureRefreshStatus;
  /** Kills a running child and waits for its close (the shutdown hook). */
  shutdown(): Promise<void>;
  /** The process-exit variant: SIGKILL the group synchronously, never await. */
  shutdownSync(): void;
};

/** The spawn signature this module uses; injectable so a criterion can count calls. */
export type RefreshSpawn = typeof spawn;

/** What one job record holds; the map is keyed by the resolved project root. */
type JobRecord = {
  readonly jobId: string;
  readonly projectPath: string;
  state: 'running' | 'succeeded' | 'failed';
  stage: ArchitectureRefreshStage;
  readonly startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  readonly stderr: string[];
  error: string | null;
  child: ChildProcess | null;
  killTimer: NodeJS.Timeout | null;
  /** Resolves when the record reaches a terminal state (status is live). */
  finished: Promise<void>;
  resolveFinished: () => void;
  /** Resolves when the child's `close` event has been processed. */
  closed: Promise<void>;
  resolveClosed: () => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Expand a leading `~` against the process home; any other path is returned unchanged. */
function expandHome(filePath: string, homeDir: string): string {
  if (filePath === '~') return homeDir;
  if (filePath.startsWith('~/')) return path.join(homeDir, filePath.slice(2));
  return filePath;
}

function errorMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/** The default settings location, resolved at call time so a process HOME is honoured. */
function defaultServerSettingsPath(homeDir: string): string {
  return path.join(homeDir, '.config', 'claudecodeui', 'server.settings.json');
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Builds one reading from an already-parsed settings document.
 *
 * Unknown keys are ignored and a malformed known value falls back field by field, so
 * a typo in `timeoutMs` cannot silently disable the whole refresh entry.
 */
function buildRefreshSettings(
  parsed: unknown,
  filePath: string | null,
  source: 'default' | 'file',
  problems: string[],
): RefreshSettings {
  const settings = {
    cliPath: DEFAULT_REFRESH_SETTINGS.cliPath,
    timeoutMs: DEFAULT_REFRESH_SETTINGS.timeoutMs,
    memoryLimitMb: DEFAULT_REFRESH_SETTINGS.memoryLimitMb,
    defect: DEFAULT_REFRESH_SETTINGS.defect as ArchitectureRefreshDefect,
    path: filePath,
    source,
    problems,
  };

  if (!isRecord(parsed)) {
    problems.push(`${filePath ?? '(settings)'} must contain a JSON object`);
    return settings;
  }
  const architecture = parsed.architecture;
  if (architecture === undefined) return settings;
  if (!isRecord(architecture)) {
    problems.push('`architecture` must be an object');
    return settings;
  }
  const block = architecture.refresh;
  if (block === undefined) return settings;
  if (!isRecord(block)) {
    problems.push('`architecture.refresh` must be an object');
    return settings;
  }

  if (block.cliPath !== undefined) {
    if (typeof block.cliPath === 'string') settings.cliPath = block.cliPath;
    else problems.push('`architecture.refresh.cliPath` must be a string');
  }
  if (block.timeoutMs !== undefined) {
    if (isPositiveInteger(block.timeoutMs)) settings.timeoutMs = block.timeoutMs;
    else problems.push('`architecture.refresh.timeoutMs` must be a positive integer');
  }
  if (block.memoryLimitMb !== undefined) {
    if (isPositiveInteger(block.memoryLimitMb)) settings.memoryLimitMb = block.memoryLimitMb;
    else problems.push('`architecture.refresh.memoryLimitMb` must be a positive integer');
  }
  if (block.defect !== undefined) {
    if (block.defect === '' || block.defect === 'no-coalesce' || block.defect === 'no-preserve') {
      settings.defect = block.defect;
    } else {
      problems.push('`architecture.refresh.defect` must be "", "no-coalesce" or "no-preserve"');
    }
  }
  return settings;
}

/**
 * Builds the mtime-cached settings reader.
 *
 * A missing file at the DEFAULT path is the ordinary "keep the shipped defaults"
 * state; a file named explicitly that cannot be read is reported in `problems` and
 * keeps the defaults — a bad knob must never stop a refresh from being attempted.
 */
function createRefreshSettingsSource(options: {
  settingsPath?: string | null;
  env?: Record<string, string | undefined>;
  homeDir?: string;
}): RefreshSettingsSource {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();

  let filePath: string | null;
  let explicit = false;
  if (options.settingsPath === null) {
    filePath = null;
  } else if (typeof options.settingsPath === 'string') {
    filePath = expandHome(options.settingsPath, homeDir);
    explicit = true;
  } else {
    const named = env[SERVER_SETTINGS_PATH_ENV];
    if (typeof named === 'string' && named.trim() !== '') {
      filePath = expandHome(named.trim(), homeDir);
      explicit = true;
    } else {
      filePath = defaultServerSettingsPath(homeDir);
    }
  }

  let cached: { mtimeMs: number; settings: RefreshSettings } | null = null;

  return {
    read(): RefreshSettings {
      if (filePath === null) return buildRefreshSettings({}, null, 'default', []);

      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(filePath).mtimeMs;
      } catch (failure) {
        cached = null;
        return buildRefreshSettings({}, filePath, 'default', explicit
          ? [`could not read ${filePath}: ${errorMessage(failure)}`]
          : []);
      }
      if (cached !== null && cached.mtimeMs === mtimeMs) return cached.settings;

      const problems: string[] = [];
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (failure) {
        problems.push(`could not read ${filePath}: ${errorMessage(failure)}`);
      }
      const settings = buildRefreshSettings(parsed, filePath, 'file', problems);
      cached = { mtimeMs, settings };
      return settings;
    },
  };
}

/**
 * Resolves the CLI entry the way `mcp-launcher.mjs` does: `createRequire` from the
 * project first, then a walk up its ancestors looking at `node_modules` and the
 * sibling `npm-cache/node_modules`, then the plugin cache under the process home.
 * Returns a readable reason instead of throwing, because an unresolvable CLI is a
 * failed job the tab must explain — never a crash.
 */
function resolveArchguardCli(
  projectPath: string,
  explicitPath: string,
  homeDir: string,
): { cliPath: string } | { error: string } {
  if (explicitPath.trim() !== '') {
    const resolved = expandHome(explicitPath.trim(), homeDir);
    if (fs.existsSync(resolved)) return { cliPath: resolved };
    return {
      error: `architecture.refresh.cliPath names ${resolved}, which does not exist`,
    };
  }

  try {
    const requireFromProject = createRequire(path.join(projectPath, 'package.json'));
    const resolved = requireFromProject.resolve(`${ARCHGUARD_PACKAGE}/${ARCHGUARD_CLI_RELATIVE.split(path.sep).join('/')}`);
    return { cliPath: resolved };
  } catch {
    // Fall through to the ancestor walk: the launcher's cache is not on the
    // project's require path.
  }

  for (let current = path.resolve(projectPath); ; current = path.dirname(current)) {
    for (const candidate of [
      path.join(current, 'node_modules', ARCHGUARD_PACKAGE, ARCHGUARD_CLI_RELATIVE),
      path.join(current, 'npm-cache', 'node_modules', ARCHGUARD_PACKAGE, ARCHGUARD_CLI_RELATIVE),
    ]) {
      if (fs.existsSync(candidate)) return { cliPath: candidate };
    }
    if (path.dirname(current) === current) break;
  }

  const pluginCache = path.join(
    homeDir,
    '.claude',
    'plugins',
    'npm-cache',
    'node_modules',
    ARCHGUARD_PACKAGE,
    ARCHGUARD_CLI_RELATIVE,
  );
  if (fs.existsSync(pluginCache)) return { cliPath: pluginCache };

  return {
    error:
      `Could not resolve ${ARCHGUARD_PACKAGE} (tried the project's node_modules, `
      + `each ancestor's node_modules and npm-cache/node_modules, and ${pluginCache}). `
      + 'Set architecture.refresh.cliPath in the server settings file to the CLI entry.',
  };
}

function realpathOrSelf(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return filePath;
  }
}

/** True when `child` is `parent` or lives beneath it. */
function isWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

/**
 * The source directories one whole-project refresh re-analyses.
 *
 * The current manifest is the authority: each scope's existing sources are reused,
 * which is what keeps the scope keys (`hashSources(sources, language)`) stable across
 * a refresh. Sources outside the project root and sources nested inside another
 * scope's source are dropped — the latter is what retires the legacy
 * `src/modules/chat` scope, whose artifacts the server's own merge already subsumes
 * into `src`. With no manifest at all (the tab would not be reachable), the project's
 * two source trees are used as a bootstrap; failing both, the project root itself.
 */
async function resolveRefreshSources(
  projectPath: string,
): Promise<{ sources: readonly string[]; language: string }> {
  const manifestPath = path.join(projectPath, '.archguard', 'query', 'manifest.json');
  let language = 'typescript';
  const candidates: string[] = [];
  try {
    const parsed: unknown = JSON.parse(await fsPromises.readFile(manifestPath, 'utf8'));
    if (isRecord(parsed) && Array.isArray(parsed.scopes)) {
      for (const scope of parsed.scopes) {
        if (!isRecord(scope)) continue;
        if (typeof scope.language === 'string' && scope.language.trim() !== '') {
          language = scope.language;
        }
        if (!Array.isArray(scope.sources)) continue;
        for (const source of scope.sources) {
          if (typeof source !== 'string' || source.trim() === '') continue;
          const absolute = realpathOrSelf(
            path.isAbsolute(source) ? source : path.resolve(projectPath, source),
          );
          if (!isWithin(projectPath, absolute)) continue;
          try {
            if (!fs.statSync(absolute).isDirectory()) continue;
          } catch {
            continue;
          }
          if (!candidates.includes(absolute)) candidates.push(absolute);
        }
      }
    }
  } catch {
    // No manifest (or an unreadable one): fall through to the bootstrap list.
  }

  // A nested source is already indexed by its ancestor scope: keep the outermost.
  const ordered = [...candidates].sort((a, b) => a.length - b.length);
  const outermost: string[] = [];
  for (const candidate of ordered) {
    if (outermost.some((kept) => isWithin(kept, candidate))) continue;
    outermost.push(candidate);
  }

  if (outermost.length > 0) return { sources: outermost, language };

  for (const relative of ['src', 'server']) {
    const absolute = path.join(projectPath, relative);
    try {
      if (fs.statSync(absolute).isDirectory()) outermost.push(absolute);
    } catch {
      // Not every project has both trees.
    }
  }
  return { sources: outermost.length === 0 ? [projectPath] : outermost, language };
}

/**
 * The argv the CLI is invoked with. `-f json` keeps the Mermaid/SVG renderer out of a
 * run the tab does not consume (see the module header). `--work-dir` is always
 * absolute, because ArchGuard derives the project root from its parent.
 */
function buildCliArgs(
  sources: readonly string[],
  language: string,
  workDir: string,
): string[] {
  return [
    'analyze',
    '-s',
    ...sources,
    '--lang',
    language,
    '-f',
    'json',
    '--work-dir',
    workDir,
  ];
}

/**
 * The command to spawn: the CLI directly, or the same command behind
 * `systemd-run --user --scope` when a memory cap was configured and the host has a
 * usable user manager.
 */
function buildSpawnCommand(
  nodePath: string,
  cliPath: string,
  cliArgs: readonly string[],
  memoryLimitMb: number,
  useSystemd: boolean,
): { command: string; args: string[] } {
  if (memoryLimitMb > 0 && useSystemd) {
    return {
      command: 'systemd-run',
      args: [
        '--user',
        '--scope',
        '--quiet',
        '-p',
        `MemoryMax=${memoryLimitMb}M`,
        '-p',
        'MemorySwapMax=0',
        '--',
        nodePath,
        cliPath,
        ...cliArgs,
      ],
    };
  }
  return { command: nodePath, args: [cliPath, ...cliArgs] };
}

/** Kills the child's whole process group (the CLI may have worker children). */
function killChildGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
    return;
  } catch {
    // Fall back to the child itself (a non-detached or already-reaped group).
  }
  try {
    child.kill(signal);
  } catch {
    // Already gone: nothing to kill.
  }
}

/** A default systemd-user probe; `systemd-run --version` is cheap and side-effect free. */
function defaultHasSystemdRun(): boolean {
  try {
    return spawnSync('systemd-run', ['--version'], { stdio: 'ignore', timeout: 2_000 }).status === 0;
  } catch {
    return false;
  }
}

function newJobId(): string {
  return `archguard-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Renames `stagedQuery` over `<projectRoot>/.archguard/query`, restoring the old
 * directory if the second rename fails.
 *
 * Auxiliary entries of the old `query` directory (anything that is not the manifest
 * and not a scope artifact — `duplicates`, `git-history`, `shape-smells`, …) are
 * moved into the new directory first, so the swap publishes the analysis without
 * deleting products this refresh does not produce. Scope directories the new analysis
 * did not write (the retired `chat` scope) are deliberately NOT carried over.
 */
async function installStagedQuery(
  projectPath: string,
  stagedWorkDir: string,
  jobId: string,
): Promise<void> {
  const archguardRoot = path.join(projectPath, '.archguard');
  const liveQuery = path.join(archguardRoot, 'query');
  const stagedQuery = path.join(stagedWorkDir, 'query');

  try {
    await fsPromises.access(path.join(stagedQuery, 'manifest.json'));
  } catch {
    throw new Error(`the analysis finished but wrote no ${path.join(stagedQuery, 'manifest.json')}`);
  }

  await fsPromises.mkdir(archguardRoot, { recursive: true });
  const previousQuery = path.join(archguardRoot, `query.previous-${jobId}`);
  let movedAside = false;
  try {
    try {
      await fsPromises.rename(liveQuery, previousQuery);
      movedAside = true;
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure;
    }

    try {
      await fsPromises.rename(stagedQuery, liveQuery);
    } catch (failure) {
      if (movedAside) await fsPromises.rename(previousQuery, liveQuery);
      throw failure;
    }

    if (movedAside) {
      await carryAuxiliaryQueryEntries(previousQuery, liveQuery);
      await fsPromises.rm(previousQuery, { recursive: true, force: true });
    }
  } catch (failure) {
    throw new Error(`could not install the refreshed analysis: ${errorMessage(failure)}`);
  }
}

/** Moves the old query directory's non-analysis entries into the new one. */
async function carryAuxiliaryQueryEntries(previousQuery: string, liveQuery: string): Promise<void> {
  const scopeKeys = new Set<string>();
  try {
    const parsed: unknown = JSON.parse(
      await fsPromises.readFile(path.join(previousQuery, 'manifest.json'), 'utf8'),
    );
    if (isRecord(parsed) && Array.isArray(parsed.scopes)) {
      for (const scope of parsed.scopes) {
        if (isRecord(scope) && typeof scope.key === 'string') scopeKeys.add(scope.key);
      }
    }
  } catch {
    // An unreadable old manifest has no keys to protect; only the heuristic applies.
  }

  let entries: fs.Dirent[];
  try {
    entries = await fsPromises.readdir(previousQuery, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'manifest.json') continue;
    if (scopeKeys.has(entry.name)) continue;
    // `hashSources` keys are eight lowercase hex characters; an orphaned scope
    // directory without a manifest entry is still an analysis artifact.
    if (/^[0-9a-f]{8}$/.test(entry.name)) continue;
    try {
      await fsPromises.rename(
        path.join(previousQuery, entry.name),
        path.join(liveQuery, entry.name),
      );
    } catch {
      // A carrier that already exists on both sides keeps the new one.
    }
  }
}

/**
 * Creates the process-wide refresh job.
 *
 * Consumers: `module.ts` (the production instance) and `tests/refreshJob.test.ts`,
 * which injects its own spawn and points the settings reader at files it owns.
 */
export function createArchguardRefreshJob(options: {
  readonly resolveProjectPath: (projectId: string) => string | null;
  /** `undefined` = env-or-default resolution, `null` = no settings file at all. */
  readonly settingsPath?: string | null;
  readonly env?: Record<string, string | undefined>;
  readonly homeDir?: string;
  readonly spawnImpl?: RefreshSpawn;
  readonly hasSystemdRun?: () => boolean;
  readonly now?: () => number;
  readonly createJobId?: () => string;
  readonly nodePath?: string;
}): ArchguardRefreshJob {
  const now = options.now ?? Date.now;
  const spawnChild = options.spawnImpl ?? spawn;
  const hasSystemdRun = options.hasSystemdRun ?? defaultHasSystemdRun;
  const createJobId = options.createJobId ?? newJobId;
  const nodePath = options.nodePath ?? process.execPath;
  const homeDir = options.homeDir ?? os.homedir();
  const settings = createRefreshSettingsSource({
    ...(options.settingsPath === undefined ? {} : { settingsPath: options.settingsPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
    homeDir,
  });

  /** One record per resolved project root; terminal records stay readable. */
  const jobs = new Map<string, JobRecord>();

  function resolveProject(projectId: string): string {
    const projectPath = options.resolveProjectPath(projectId);
    if (projectPath === null) {
      throw new AppError(`Project "${projectId}" was not found.`, {
        code: 'PROJECT_NOT_FOUND',
        statusCode: 404,
      });
    }
    return realpathOrSelf(projectPath);
  }

  function statusOf(record: JobRecord): ArchitectureRefreshStatus {
    const finishedAt = record.finishedAt;
    const end = finishedAt ?? now();
    return {
      state: record.state,
      jobId: record.jobId,
      startedAt: new Date(record.startedAt).toISOString(),
      finishedAt: finishedAt === null ? null : new Date(finishedAt).toISOString(),
      stage: record.stage,
      elapsedMs: Math.max(0, end - record.startedAt),
      exitCode: record.exitCode,
      stderrTail: [...record.stderr],
      error: record.error,
    };
  }

  const IDLE_STATUS: ArchitectureRefreshStatus = {
    state: 'idle',
    jobId: null,
    startedAt: null,
    finishedAt: null,
    stage: 'idle',
    elapsedMs: 0,
    exitCode: null,
    stderrTail: [],
    error: null,
  };

  function makeRecord(projectPath: string, jobId: string, finished = false): JobRecord {
    let resolveFinished = (): void => {};
    const finishedPromise = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });
    let resolveClosed = (): void => {};
    const closedPromise = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const stamp = now();
    return {
      jobId,
      projectPath,
      state: finished ? 'failed' : 'running',
      stage: finished ? 'failed' : 'preparing',
      startedAt: stamp,
      finishedAt: finished ? stamp : null,
      exitCode: null,
      stderr: [],
      error: finished ? '' : null,
      child: null,
      killTimer: null,
      finished: finishedPromise,
      resolveFinished,
      closed: closedPromise,
      resolveClosed,
    };
  }

  function appendStderr(record: JobRecord, chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trimEnd();
      if (trimmed === '') continue;
      record.stderr.push(trimmed);
    }
    if (record.stderr.length > STDERR_TAIL_LINES) {
      record.stderr.splice(0, record.stderr.length - STDERR_TAIL_LINES);
    }
  }

  function finish(record: JobRecord, state: 'succeeded' | 'failed', error: string | null): void {
    if (record.state !== 'running') return;
    record.state = state;
    record.stage = state;
    record.error = error;
    record.finishedAt = now();
    record.child = null;
    if (record.killTimer !== null) {
      clearTimeout(record.killTimer);
      record.killTimer = null;
    }
    record.resolveFinished();
  }

  function killRunningChild(record: JobRecord, signal: NodeJS.Signals): void {
    const child = record.child;
    if (child === null) return;
    killChildGroup(child, signal);
  }

  async function runJob(
    record: JobRecord,
    cliPath: string,
    reading: RefreshSettings,
  ): Promise<void> {
    const projectPath = record.projectPath;
    const defect = reading.defect;
    // `no-preserve` deliberately removes the staging directory: the CLI writes the
    // live analysis, which is the defect the control arm measures.
    const workDir = defect === 'no-preserve'
      ? path.join(projectPath, '.archguard')
      : path.join(projectPath, '.archguard', 'refresh', record.jobId);
    const discardStaging = async (): Promise<void> => {
      if (defect === 'no-preserve') return;
      await fsPromises.rm(workDir, { recursive: true, force: true }).catch(() => {});
    };

    try {
      const { sources, language } = await resolveRefreshSources(projectPath);
      if (defect !== 'no-preserve') {
        await fsPromises.mkdir(path.dirname(workDir), { recursive: true });
        await fsPromises.rm(workDir, { recursive: true, force: true });
      }
      const cliArgs = buildCliArgs(sources, language, workDir);
      const { command, args } = buildSpawnCommand(
        nodePath,
        cliPath,
        cliArgs,
        reading.memoryLimitMb,
        hasSystemdRun(),
      );

      if (record.state !== 'running') {
        await discardStaging();
        return;
      }
      record.stage = 'analyzing';
      const child = spawnChild(command, args, {
        cwd: projectPath,
        // A group of its own so a timeout/shutdown reaches the CLI's workers too.
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      record.child = child;
      child.stderr?.on('data', (chunk: Buffer) => appendStderr(record, chunk));
      child.on('error', (failure) => {
        void (async () => {
          finish(record, 'failed', `Could not start the ArchGuard CLI: ${errorMessage(failure)}`);
          record.resolveClosed();
          await discardStaging();
        })();
      });
      child.on('close', (code) => {
        void (async () => {
          record.exitCode = code;
          record.child = null;
          record.resolveClosed();
          if (record.state !== 'running') {
            // A timed-out or shut-down job: the record is already terminal.
            await discardStaging();
            return;
          }
          if (code !== 0) {
            const detail = record.stderr.at(-1);
            finish(
              record,
              'failed',
              `ArchGuard exited with code ${code ?? 'null'}${detail === undefined ? '' : `: ${detail}`}`,
            );
            await discardStaging();
            return;
          }
          record.stage = 'installing';
          try {
            if (defect !== 'no-preserve') {
              await installStagedQuery(projectPath, workDir, record.jobId);
            }
            finish(record, 'succeeded', null);
          } catch (failure) {
            finish(record, 'failed', errorMessage(failure));
          }
          await discardStaging();
        })();
      });

      const timeout = setTimeout(() => {
        if (record.state !== 'running') return;
        record.error = `ArchGuard did not finish within ${reading.timeoutMs} ms`;
        record.state = 'failed';
        record.stage = 'failed';
        record.finishedAt = now();
        record.resolveFinished();
        killRunningChild(record, 'SIGTERM');
        record.killTimer = setTimeout(() => {
          killRunningChild(record, 'SIGKILL');
        }, KILL_GRACE_MS);
      }, reading.timeoutMs);
      timeout.unref();
      child.once('close', () => clearTimeout(timeout));
    } catch (failure) {
      finish(record, 'failed', errorMessage(failure));
      await discardStaging();
    }
  }

  return {
    start(projectId: string): ArchitectureRefreshStartResult {
      const projectPath = resolveProject(projectId);
      const reading = settings.read();
      const existing = jobs.get(projectPath);
      if (
        reading.defect !== 'no-coalesce'
        && existing !== undefined
        && existing.state === 'running'
      ) {
        return {
          jobId: existing.jobId,
          coalesced: true,
          status: statusOf(existing),
        };
      }

      const jobId = createJobId();
      const resolved = resolveArchguardCli(projectPath, reading.cliPath, homeDir);
      if ('error' in resolved) {
        const record = makeRecord(projectPath, jobId, true);
        record.error = resolved.error;
        record.finishedAt = now();
        jobs.set(projectPath, record);
        return { jobId, coalesced: false, status: statusOf(record) };
      }

      const record = makeRecord(projectPath, jobId);
      jobs.set(projectPath, record);
      void runJob(record, resolved.cliPath, reading);
      return { jobId, coalesced: false, status: statusOf(record) };
    },

    status(projectId: string): ArchitectureRefreshStatus {
      const projectPath = resolveProject(projectId);
      const record = jobs.get(projectPath);
      return record === undefined ? IDLE_STATUS : statusOf(record);
    },

    async shutdown(): Promise<void> {
      const running = [...jobs.values()].filter((record) => record.state === 'running');
      for (const record of running) {
        record.error = 'the server shut down while the analysis was running';
        record.state = 'failed';
        record.stage = 'failed';
        record.finishedAt = now();
        record.resolveFinished();
        killRunningChild(record, 'SIGTERM');
      }
      await Promise.all(running.map(async (record) => {
        if (record.child === null) {
          // Still preparing (the spawn has not happened yet); the state guard in
          // `runJob` stops it from spawning.
          return;
        }
        await Promise.race([
          record.closed,
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, KILL_GRACE_MS);
            timer.unref();
          }),
        ]);
        if (record.child !== null) killRunningChild(record, 'SIGKILL');
      }));
    },

    shutdownSync(): void {
      for (const record of jobs.values()) {
        if (record.state === 'running') killRunningChild(record, 'SIGKILL');
      }
    },
  };
}
