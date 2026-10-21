/**
 * The MCP gateway's `overview` and `quay_snapshot` handlers (AC-247).
 *
 * `overview` answers the whole workspace in one reading: the sessions currently
 * running (project, title, turn phase, elapsed), the sessions parked
 * `awaitingPermission`, the runs aborted inside the run registry's retention
 * window, the resident host listing, and — per project — the quay state read
 * EXCLUSIVELY from the in-memory snapshot cache. A cache miss is reported as
 * `unknown`; `overview` never loads a snapshot, so a workspace of twenty
 * projects answers with zero quay CLI invocations.
 *
 * Its declared `project` argument SCOPES that reading to one project rather than
 * being ignored (gap-mcp-resolve-deps-production-wiring). It was a declared but
 * unread field before; the ruling there was to make it real, because the tool's
 * own description is "Project overview" and its output is already project-
 * keyed. The target gate resolves a caller's name to an id before the handler
 * runs, so `overview({ project: "…" })` accepts a name end to end; an id nothing
 * matches is refused as `PROJECT_NOT_FOUND`, not read as "that project is quiet".
 *
 * The argument also accepts an ARRAY of projects (gap-mcp-cross-project-session-
 * aggregation): one call then reads the union of those projects, with every row
 * still carrying its own `projectId` / `project` attribution. An array element
 * nothing matches is refused whole, so a partially-scoped reading is never
 * returned.
 *
 * That "never fan out" property is STRUCTURAL, not a promise: {@link buildOverview}
 * accepts {@link McpOverviewReadDeps}, whose `quay` exposes only
 * `hasQuayConfig` / `readCached` — the `refresh` verb is not on the type, so the
 * overview path cannot call it even by accident. `refresh` is reachable only
 * through {@link buildQuaySnapshot}, and only when the caller asks for it
 * (`refresh: true`), where it makes exactly one runner call for exactly one
 * project.
 *
 * Cross-module vocabulary comes through the barrels (`QuaySnapshot` from the quay
 * module); the sibling read-tool types come from the module-local
 * `mcp-gateway.read-tools.js`. Only types are imported from that sibling, so the
 * runtime import graph stays acyclic (read-tools imports these values; this
 * module imports none of its values back).
 */

import { z } from 'zod';

import { hasArchguardCache } from '@/modules/architecture/index.js';
import type { QuaySnapshot } from '@/modules/quay/index.js';

import { MCP_ERROR_CODES, McpToolError } from './mcp-error-envelope.js';
import type { McpToolInputSchema } from './mcp-gateway.audit.js';
import type {
  McpReadToolDeps,
  McpReadToolSeam,
  McpRunSummary,
  McpRunningRun,
} from './mcp-gateway.read-tools.js';

// --------------------------- injected quay runner ---------------------------

/**
 * The injected quay command runner, the seam the read tools answer through.
 *
 * Production (`server/index.ts`) binds the three verbs to the quay service:
 * `hasQuayConfig` to `getQuayStatus(projectId)?.hasQuayConfig ?? false` (a pure
 * path check, no subprocess), `readCached` to the new `getCachedSnapshot`
 * (cache-only, no subprocess), and `refresh` to
 * `getQuaySnapshot(projectId, { forceRefresh: true })` (the one load-on-demand
 * path). The criterion binds a counting fake so "how many runner calls did this
 * reading cost" is a number it asserts instead of a behaviour it infers.
 *
 * A `refresh` call = exactly one snapshot load for exactly one project; that is
 * the quantity the criterion counts as `refreshCount`.
 */
export type McpQuayRunner = {
  /** Whether the project directory carries a `.quay/config.yml`; never spawns. */
  hasQuayConfig(projectId: string): boolean;
  /** The cached snapshot or `null`; never spawns. */
  readCached(projectId: string): QuaySnapshot | null;
  /** Loads (or force-reloads) exactly this project's snapshot; one runner call. */
  refresh(projectId: string): Promise<QuaySnapshot | null>;
};

/** The cache-only slice `overview` is allowed to read: no `refresh`. */
type CachedQuayReader = Pick<McpQuayRunner, 'hasQuayConfig' | 'readCached'>;

/**
 * The turn-phase reader. Production passes the process `activityStore`, whose
 * `snapshot(sessionId)` carries `turn.phase`; the criterion passes a fake that
 * forces one session to `awaitingPermission`. `null` means "this store has never
 * been told about the session", which `overview` reports as `unknown` rather than
 * inventing a phase.
 */
export type McpActivityReader = {
  snapshot(sessionId: string): { turn: { phase: string } } | null;
};

/**
 * The services `overview` / `quay_snapshot` answer from: the read tools' deps
 * plus the two capabilities only these tools need — the activity store (turn
 * phase) and the quay runner. `runs` is narrowed to require both run readers.
 * Everything else (`projects`, `sessions`, `hosts`, `now`) is inherited from
 * {@link McpReadToolDeps}.
 */
export type McpOverviewDeps = Omit<McpReadToolDeps, 'runs'> & {
  quay: McpQuayRunner;
  activity: McpActivityReader;
  /** Both run readers are required here; `isOverviewWired` checks `listRecentRuns`. */
  runs: {
    listRunningRuns(): McpRunningRun[];
    listRecentRuns(): McpRunSummary[];
  };
};

/**
 * The dependency slice {@link buildOverview} accepts: the full overview deps with
 * `quay` narrowed to the cache-only reader. This is what makes "`overview` never
 * calls refresh" a type-level fact rather than a comment.
 */
export type McpOverviewReadDeps = Omit<McpOverviewDeps, 'quay'> & { quay: CachedQuayReader };

/**
 * Whether a read-tool deps bag carries the three capabilities the overview tools
 * need — the quay runner, the activity store and the run-history reader.
 * `registerMcpReadTools` uses it to route: wired deps get the real handlers,
 * unwired ones keep the named `MCP_TOOL_NOT_IMPLEMENTED` refusal so a mount that
 * never wired quay (AC-240/244/245's criteria) reads exactly as it did before
 * this task.
 */
export function isOverviewWired(deps: McpReadToolDeps): deps is McpOverviewDeps {
  return (
    deps.quay !== undefined
    && deps.activity !== undefined
    && deps.runs.listRecentRuns !== undefined
  );
}

// --------------------------- overview payload ---------------------------

/** One running session's reading. */
export type McpOverviewRunning = {
  sessionId: string;
  projectId: string | null;
  /** The project's display name when resolvable, else its id, else null. */
  project: string | null;
  title: string;
  /** The activity store's `turn.phase`, or `unknown` when the store has none. */
  phase: string;
  elapsedMs: number;
};

/** One session parked on a permission prompt. */
export type McpOverviewAwaiting = {
  sessionId: string;
  projectId: string | null;
  project: string | null;
  title: string;
  phase: string;
};

/** One aborted run still inside the registry's retention window. */
export type McpOverviewAborted = {
  runId: string;
  sessionId: string;
  status: string;
  startedAt: number;
  completedAt: number | null;
  /**
   * The project the aborted run's session belongs to (gap-mcp-cross-project-
   * session-aggregation): the same attribution the running/host rows carry, so
   * a multi-project reading says which project each row came from.
   */
  projectId: string | null;
  project: string | null;
};

/** One resident host binding. */
export type McpOverviewHost = {
  hostId: string;
  state: string;
  sessionId: string;
  peerName: string | null;
  /** The binding's leases, copied verbatim — a lease IS why the process lives. */
  leases: unknown[];
  /** The project the bound session belongs to; the host row's attribution. */
  projectId: string | null;
  project: string | null;
};

/**
 * The fields every quay entry carries: which project it describes, by id and by
 * the display name the other lists use. The attribution a multi-project reading
 * needs to say whose snapshot this is.
 */
type McpOverviewQuayScope = { projectId: string; project: string };

/** One project's quay reading inside `overview`. */
export type McpOverviewQuayEntry =
  | (McpOverviewQuayScope & { status: 'no_quay_config'; note: string })
  | (McpOverviewQuayScope & { status: 'unknown'; note: string })
  | (McpOverviewQuayScope & {
      status: 'cached';
      cached: boolean;
      tasks: { total: number; ready: number; needsHuman: number; done: number } | null;
      driver: { state: string } | null;
      suite: { state: string } | null;
    });

/**
 * One project's Tier-1 architecture reading inside `overview` (AC-418 /
 * ADR-005 decision 1). It is the same pure path check the project listing
 * carries, reported per project so a caller can tell which projects the
 * architecture tab can open without asking each one.
 */
export type McpOverviewArchguardEntry = {
  projectId: string;
  project: string;
  hasArchguardCache: boolean;
};

/** The whole `overview` reading. */
export type OverviewPayload = {
  running: McpOverviewRunning[];
  awaitingPermission: McpOverviewAwaiting[];
  aborted: McpOverviewAborted[];
  hosts: McpOverviewHost[];
  quay: McpOverviewQuayEntry[];
  archguard: McpOverviewArchguardEntry[];
};

/**
 * The declared output shape of `overview`: the ONE description of the reading
 * {@link buildOverview} returns, written as the same six top-level keys, so
 * `tools/list` advertises exactly what a caller reads back.
 *
 * It replaces AC-247's `{ overview: z.unknown().optional() }` placeholder, which
 * was both MISNAMED (the handler returns the reading directly, never wrapped
 * under an `overview` key) and WRONGLY WIDE-but-narrow at once: `z.unknown()`
 * admitted anything inside the wrapper, yet the conversion emitted
 * `additionalProperties: false`, so the REAL payload (`running` / `hosts` / … at
 * the top level) failed a warm client's output validation with `-32602`. The
 * `quay` arm is a `discriminatedUnion` on `status` — the same three-arm union as
 * {@link McpOverviewQuayEntry} — rather than `z.unknown()`, so a caller reads the
 * per-status fields off the wire.
 *
 * Consumers: `mcp-gateway.read-tools.js`'s `TOOL_BODIES.overview`, which hands it
 * to the registration seam, the transport's audited wrapper (which optionalizes
 * it and splices in the error envelope), and the criterion, which validates a
 * real `buildOverview` reading against it with `z.object(...).strict()`.
 */
export const overviewOutputSchema: z.ZodRawShape = {
  running: z.array(
    z.object({
      sessionId: z.string(),
      projectId: z.string().nullable(),
      project: z.string().nullable(),
      title: z.string(),
      phase: z.string(),
      elapsedMs: z.number(),
    }),
  ),
  awaitingPermission: z.array(
    z.object({
      sessionId: z.string(),
      projectId: z.string().nullable(),
      project: z.string().nullable(),
      title: z.string(),
      phase: z.string(),
    }),
  ),
  aborted: z.array(
    z.object({
      runId: z.string(),
      sessionId: z.string(),
      status: z.string(),
      startedAt: z.number(),
      completedAt: z.number().nullable(),
      projectId: z.string().nullable(),
      project: z.string().nullable(),
    }),
  ),
  hosts: z.array(
    z.object({
      hostId: z.string(),
      state: z.string(),
      sessionId: z.string(),
      peerName: z.string().nullable(),
      // The leases are the opaque `HostLease` union copied verbatim — a lease IS
      // why the process lives, and `overview` never reinterprets its shape.
      leases: z.array(z.unknown()),
      projectId: z.string().nullable(),
      project: z.string().nullable(),
    }),
  ),
  quay: z.array(
    z.discriminatedUnion('status', [
      z.object({ projectId: z.string(), project: z.string(), status: z.literal('no_quay_config'), note: z.string() }),
      z.object({ projectId: z.string(), project: z.string(), status: z.literal('unknown'), note: z.string() }),
      z.object({
        projectId: z.string(),
        project: z.string(),
        status: z.literal('cached'),
        cached: z.boolean(),
        tasks: z
          .object({ total: z.number(), ready: z.number(), needsHuman: z.number(), done: z.number() })
          .nullable(),
        driver: z.object({ state: z.string() }).nullable(),
        suite: z.object({ state: z.string() }).nullable(),
      }),
    ]),
  ),
  archguard: z.array(
    z.object({ projectId: z.string(), project: z.string(), hasArchguardCache: z.boolean() }),
  ),
};

/** The note reported for a project whose directory has no `.quay/config.yml`. */
export const NO_QUAY_NOTE = 'This project has no quay';
/** The note reported for a project whose snapshot is not cached. */
export const UNKNOWN_QUAY_NOTE =
  'Unknown: this project has no cached snapshot (overview does not load it; use quay_snapshot to refresh)';

/** How many recent sessions one overview reads when mapping ids to titles/projects. */
const OVERVIEW_SESSION_PAGE = 500;

// --------------------------- overview ---------------------------

/** Reads a session's turn phase, or `unknown` when the store has no snapshot. */
function phaseOf(deps: McpOverviewReadDeps, sessionId: string): string {
  return deps.activity.snapshot(sessionId)?.turn.phase ?? 'unknown';
}

/** Projects a snapshot onto the compact quay reading the overview carries. */
function summarizeCachedQuay(snapshot: QuaySnapshot, scope: McpOverviewQuayScope): McpOverviewQuayEntry {
  return {
    projectId: scope.projectId,
    project: scope.project,
    status: 'cached',
    cached: snapshot.cached,
    tasks:
      snapshot.tasks === null
        ? null
        : {
            total: snapshot.tasks.total,
            ready: snapshot.tasks.ready,
            needsHuman: snapshot.tasks.needsHuman,
            done: snapshot.tasks.done,
          },
    driver: snapshot.driver === null ? null : { state: snapshot.driver.state },
    suite: snapshot.tests.current === null ? null : { state: snapshot.tests.current.state },
  };
}

/**
 * Builds the reading.
 *
 * Without a `projectId` the reading is the WHOLE workspace; with one, every list
 * is restricted to that single project (see the parameter's note). Either way
 * the quay side iterates the in-scope project listing and, per project, asks
 * only {@link CachedQuayReader}: a project
 * without `.quay/config.yml` reads {@link NO_QUAY_NOTE}, one whose snapshot is
 * not cached reads {@link UNKNOWN_QUAY_NOTE}, and a cache hit carries the task
 * counts, driver state and suite state. No path here touches `refresh`, so the
 * runner-call count for this function is identically zero regardless of how many
 * projects are in scope.
 *
 * Async because resolving project display names reads the (async) project
 * listing; everything else is synchronous.
 *
 * @param projectIds When supplied, restrict every list — running, awaiting,
 *   aborted, hosts and quay — to the project(s) with these ids, i.e. that
 *   project's (or those projects') overview. This is the field the `overview`
 *   tool's `project` argument carries: the target gate resolves a caller's name
 *   to an id BEFORE the handler runs, so in production these ids always name
 *   projects the active listing carries. Each id is re-checked here against the
 *   listing this reading uses, and a project nothing matches is refused as
 *   `PROJECT_NOT_FOUND` rather than read as "that project has no activity" — the
 *   same existence gate {@link buildQuaySnapshot} applies. An ARRAY scopes to the
 *   union of those projects (gap-mcp-cross-project-session-aggregation), which is
 *   how one call reads several projects at once; every row still carries its own
 *   `projectId` / `project`, so the union stays attributable. `undefined` (the
 *   tool's default) keeps the whole-workspace reading every criterion before this
 *   one measured.
 */
export async function buildOverview(
  deps: McpOverviewReadDeps,
  projectIds?: string | readonly string[],
): Promise<OverviewPayload> {
  const at = deps.now();
  const sessionPage = deps.sessions.listRecentSessions(OVERVIEW_SESSION_PAGE, 0);
  const sessionById = new Map(sessionPage.conversations.map((row) => [row.sessionId, row]));
  const projects = await deps.projects.getProjectsWithSessions({
    skipSynchronization: true,
    includeHidden: true,
  });

  // The scope as a SET, so one id and an array of ids take the one path: `null`
  // is "the whole workspace", anything else is the exact set of projects in
  // scope. A scoped session with no resolvable project (`null`) is out of scope.
  const scope: Set<string> | null =
    projectIds === undefined
      ? null
      : new Set(typeof projectIds === 'string' ? [projectIds] : projectIds);
  const knownProjectIds = new Set(projects.map((project) => project.projectId));

  // A scoped reading is only defined for projects that exist: the caller named
  // them, and "no such project" must not read as "that project is quiet". Each
  // named id is checked, so an array with one bad element is refused whole
  // rather than answered for the rest.
  if (scope !== null) {
    for (const projectId of scope) {
      if (!knownProjectIds.has(projectId)) {
        throw new McpToolError(
          MCP_ERROR_CODES.PROJECT_NOT_FOUND,
          `No project has id "${projectId}".`,
          false,
          { project: projectId },
        );
      }
    }
  }

  const scopedProjects =
    scope === null ? projects : projects.filter((project) => scope.has(project.projectId));
  const projectNameById = new Map(scopedProjects.map((project) => [project.projectId, project.displayName]));

  /**
   * Whether a session's project is inside the reading's scope. Unscoped, every
   * session is in scope — including one whose project could not be resolved
   * (a `null` id), which the whole-workspace reading still reports.
   */
  const inScope = (sessionProjectId: string | null): boolean =>
    scope === null || (sessionProjectId !== null && scope.has(sessionProjectId));

  /** Resolves a session's project id to the project's display name, else the id. */
  function projectRef(sessionProjectId: string | null): Pick<McpOverviewRunning, 'projectId' | 'project'> {
    return {
      projectId: sessionProjectId,
      project: sessionProjectId === null ? null : projectNameById.get(sessionProjectId) ?? sessionProjectId,
    };
  }

  const running: McpOverviewRunning[] = deps.runs
    .listRunningRuns()
    .map((run) => {
      const row = sessionById.get(run.sessionId);
      return {
        sessionId: run.sessionId,
        ...projectRef(row?.projectId ?? null),
        title: row?.sessionTitle ?? '',
        phase: phaseOf(deps, run.sessionId),
        elapsedMs: Math.max(0, at - run.startedAt),
      };
    })
    .filter((entry) => inScope(entry.projectId));

  const awaitingPermission: McpOverviewAwaiting[] = sessionPage.conversations
    .filter((row) => phaseOf(deps, row.sessionId) === 'awaitingPermission')
    .filter((row) => inScope(row.projectId))
    .map((row) => ({
      sessionId: row.sessionId,
      ...projectRef(row.projectId),
      title: row.sessionTitle,
      phase: 'awaitingPermission',
    }));

  const aborted: McpOverviewAborted[] = deps.runs
    .listRecentRuns()
    .filter((run) => run.status === 'aborted')
    .filter((run) => inScope(sessionById.get(run.sessionId)?.projectId ?? null))
    .map((run) => ({
      runId: run.runId,
      sessionId: run.sessionId,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      ...projectRef(sessionById.get(run.sessionId)?.projectId ?? null),
    }));

  const hosts: McpOverviewHost[] = deps.hosts
    .snapshot()
    .flatMap((host) =>
      [...host.bindings.entries()].map(([sessionId, binding]) => ({
        hostId: host.hostId,
        state: host.state,
        sessionId,
        peerName: binding.peerName,
        leases: binding.leases.map((lease) => ({ ...lease })),
        ...projectRef(sessionById.get(sessionId)?.projectId ?? null),
      })),
    )
    .filter((entry) => inScope(entry.projectId));

  const quay: McpOverviewQuayEntry[] = scopedProjects.map((project) => {
    const scopeRef: McpOverviewQuayScope = { projectId: project.projectId, project: project.displayName };
    if (!deps.quay.hasQuayConfig(project.projectId)) {
      return { ...scopeRef, status: 'no_quay_config', note: NO_QUAY_NOTE };
    }
    const cached = deps.quay.readCached(project.projectId);
    return cached === null
      ? { ...scopeRef, status: 'unknown', note: UNKNOWN_QUAY_NOTE }
      : summarizeCachedQuay(cached, scopeRef);
  });

  // The architecture tab's Tier-1 gate, read the same way `hasQuayConfig` is: a
  // pure path check over each in-scope project's directory, never a parse and
  // never a subprocess.
  const archguard: McpOverviewArchguardEntry[] = scopedProjects.map((project) => ({
    projectId: project.projectId,
    project: project.displayName,
    hasArchguardCache: hasArchguardCache(project.path),
  }));

  return { running, awaitingPermission, aborted, hosts, quay, archguard };
}

// --------------------------- quay_snapshot ---------------------------

/** The `quay_snapshot` tool's input. `project` is a single string, never an array. */
export type McpQuaySnapshotInput = { project: string; refresh?: boolean };

/** The full snapshot reading `quay_snapshot` returns on a hit. */
export type McpQuaySnapshotReading = {
  generatedAt: string;
  cached: boolean;
  tasks: QuaySnapshot['tasks'];
  goals: QuaySnapshot['goals'];
  adrs: QuaySnapshot['adrs'];
  driver: QuaySnapshot['driver'];
  suite: QuaySnapshot['tests'];
  fanIn: QuaySnapshot['fanIn'];
  /** Tasks the quay worker driver reports in flight (taskId/phase/startedAt/lastHeartbeat/workerPid), read from `.quay/worker-round.jsonl`. */
  inFlight: QuaySnapshot['inFlight'];
  dashboardUrl: string | null;
  warnings: string[];
};

/** The `quay_snapshot` tool's SUCCESS result. A project that does not exist is thrown. */
export type McpQuaySnapshotPayload = {
  project: string;
  hasQuayConfig: boolean;
  status: 'cached' | 'refreshed' | 'unknown' | 'no_quay_config';
  note?: string;
  snapshot?: McpQuaySnapshotReading;
};

/** Projects a loaded snapshot onto the tool's reading. */
function summarizeSnapshot(snapshot: QuaySnapshot): McpQuaySnapshotReading {
  return {
    generatedAt: snapshot.generatedAt,
    cached: snapshot.cached,
    tasks: snapshot.tasks,
    goals: snapshot.goals,
    adrs: snapshot.adrs,
    driver: snapshot.driver,
    suite: snapshot.tests,
    fanIn: snapshot.fanIn,
    inFlight: snapshot.inFlight,
    dashboardUrl: snapshot.dashboardUrl,
    warnings: snapshot.warnings,
  };
}

/**
 * Reads one project's quay snapshot.
 *
 * `refresh` absent/false reads the TTL cache through `readCached` (zero runner
 * calls). `refresh: true` calls `quay.refresh(project)` exactly once, for the one
 * named project, and never touches any other project.
 *
 * The FIRST thing it does is establish that the project EXISTS (AC-287), and it
 * reads that from the projects store (`deps.projects`), never from
 * `hasQuayConfig`'s false: a project id nothing matches is a reference to
 * nothing and throws `PROJECT_NOT_FOUND`. Only once the project is known to
 * exist does the quay-config branch run, so a project without
 * `.quay/config.yml` reads {@link NO_QUAY_NOTE} with `hasQuayConfig: false` (a
 * real state of a real project, still a success) and an uncached project reads
 * {@link UNKNOWN_QUAY_NOTE}. The two cases are no longer conflated.
 */
export async function buildQuaySnapshot(
  input: McpQuaySnapshotInput,
  deps: McpOverviewDeps,
): Promise<McpQuaySnapshotPayload> {
  const project = input.project;
  const projects = await deps.projects.getProjectsWithSessions({
    skipSynchronization: true,
    includeHidden: true,
  });
  if (!projects.some((row) => row.projectId === project)) {
    throw new McpToolError(
      MCP_ERROR_CODES.PROJECT_NOT_FOUND,
      `No project has id "${project}".`,
      false,
      { project },
    );
  }

  if (!deps.quay.hasQuayConfig(project)) {
    return { project, hasQuayConfig: false, status: 'no_quay_config', note: NO_QUAY_NOTE };
  }

  if (input.refresh === true) {
    const snapshot = await deps.quay.refresh(project);
    return snapshot === null
      ? { project, hasQuayConfig: true, status: 'unknown', note: UNKNOWN_QUAY_NOTE }
      : { project, hasQuayConfig: true, status: 'refreshed', snapshot: summarizeSnapshot(snapshot) };
  }

  const cached = deps.quay.readCached(project);
  return cached === null
    ? { project, hasQuayConfig: true, status: 'unknown', note: UNKNOWN_QUAY_NOTE }
    : { project, hasQuayConfig: true, status: 'cached', snapshot: summarizeSnapshot(cached) };
}

// --------------------------- registration ---------------------------

/**
 * One of the two tools' metadata, as `registerMcpReadTools` passes it down from
 * {@link MCP_STAGE3_READ_TOOLS}. The table stays the single statement of a tool's
 * name/description/scope; this module only attaches a real handler to it.
 */
export type McpOverviewRegistration = {
  name: string;
  description: string;
  requiredScope: string;
  /**
   * AC-288: `registerMcpReadTools` passes this down from the one stage-3 body
   * table, which now holds a raw shape OR a built schema carrying a constraint a
   * raw shape cannot express. The two tools this module registers still declare a
   * raw shape; the wider type is only what the shared table hands over.
   */
  inputSchema: McpToolInputSchema;
  outputSchema: z.ZodRawShape;
};

/**
 * Reads the OPTIONAL `project` argument of `overview`.
 *
 * Absent means the whole-workspace reading. A non-empty string is one project to
 * scope to; an ARRAY is the union of projects to aggregate across
 * (gap-mcp-cross-project-session-aggregation) — in production the target gate has
 * already rewritten each caller-supplied name to a project id, so these are ids
 * that reach `buildOverview`. Blank strings are dropped (a caller who named only
 * blanks named nothing, which reads as absent); an array left empty after that
 * reads as absent too. Any other type is a caller error.
 */
function readOverviewProjectArgument(args: Record<string, unknown>): string[] | undefined {
  const value = args.project;
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : [trimmed];
  }
  if (Array.isArray(value)) {
    const ids = value
      .filter((element): element is string => typeof element === 'string')
      .map((element) => element.trim())
      .filter((element) => element.length > 0);
    return ids.length === 0 ? undefined : ids;
  }
  throw new Error('"project" must be a string or an array of strings when supplied.');
}

/**
 * Reads the required `project` argument of `quay_snapshot`.
 *
 * gap-mcp-session-get-past-recents-page-and-small-envelope-defects: a missing or
 * blank `project` is a CALLER error, so it is refused with the modeled
 * `INVALID_ARGUMENT` envelope. A plain `Error` here would be caught by the
 * audited wrapper's catch-all and reported as `INTERNAL_ERROR` — telling the
 * caller its own argument was a server fault and giving it nothing to fix.
 */
function readProjectArgument(args: Record<string, unknown>): string {
  const value = args.project;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new McpToolError(
      MCP_ERROR_CODES.INVALID_ARGUMENT,
      '"project" is required and must be a non-empty string.',
      false,
      { fields: [{ path: 'project', problem: 'required, expected a non-empty string' }] },
    );
  }
  return value;
}

/**
 * Registers `overview` and `quay_snapshot` with their real handlers through the
 * audited registration seam. Consumers: `registerMcpReadTools`, which routes the
 * two names here when the deps are wired (the tool metadata is passed in from the
 * one `MCP_STAGE3_READ_TOOLS` table), and the criterion, which drives the seam
 * directly to read back the registered names.
 */
export function registerMcpOverviewTools(
  seam: McpReadToolSeam,
  deps: McpOverviewDeps,
  registrations: { overview: McpOverviewRegistration; quaySnapshot: McpOverviewRegistration },
): void {
  seam({
    name: registrations.overview.name,
    description: registrations.overview.description,
    requiredScope: registrations.overview.requiredScope,
    inputSchema: registrations.overview.inputSchema,
    outputSchema: registrations.overview.outputSchema,
    // The declared `project` argument is READ here, not ignored: it is the
    // project (or the array of projects) to scope the reading to
    // (gap-mcp-resolve-deps-production-wiring). The target gate has already
    // resolved a caller's name to an id by this point, so a name is accepted end
    // to end instead of being silently dropped — in either form.
    handler: (args) => buildOverview(deps, readOverviewProjectArgument(args)),
  });

  seam({
    name: registrations.quaySnapshot.name,
    description: registrations.quaySnapshot.description,
    requiredScope: registrations.quaySnapshot.requiredScope,
    inputSchema: registrations.quaySnapshot.inputSchema,
    outputSchema: registrations.quaySnapshot.outputSchema,
    handler: (args) =>
      buildQuaySnapshot(
        { project: readProjectArgument(args), refresh: args.refresh === true },
        deps,
      ),
  });
}
