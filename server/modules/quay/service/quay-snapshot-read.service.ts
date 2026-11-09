
import path from 'node:path';

import type {
  QuayGanttLanes,
  QuayGanttUnavailableReason,
  QuaySnapshot,
} from '@/shared/types.js';

import type { QuayFleetAvailability } from '../fleet/quay-fleet-project-id.js';
import { summarizeBlockers } from '../read/quay-blockers-summary.js';
import {
  QUAY_WORKER_ROUND_FILE,
  enrichTaskRecordsWithStoreEdges,
  readLastCarrierRecord,
  summarizeInFlightTasks,
} from '../read/quay-carrier-readers.js';
import type { QuayCommandResult } from '../read/quay-command-port.js';
import { QUAY_SERVER_STATE_FILE, probeAddress, readWebServiceAddress } from '../read/quay-dashboard-carrier.js';
import { summarizeLoop } from '../read/quay-loop-status.js';
import {
  DEFAULT_QUAY_GANTT_WINDOW_HOURS,
  QUAY_LANES_PREFIX,
  normalizeGanttWindowHours,
  readGanttLanes,
} from '../read/quay-read-verbs.js';
import {
  parseJson,
  summarizeAdrs,
  summarizeConfigIssues,
  summarizeDriver,
  summarizeGoals,
  summarizeTasks,
} from '../read/quay-snapshot-summaries.js';
import type { QuayLanesReading } from '../read/quay-snapshot-types.js';
import { readQuaySuiteAndFanIn, type QuaySuiteFanInReading } from '../read/quay-suite-fanin-reader.js';

import type { QuayServiceDependencies, QuaySnapshotOptions } from './quay-service-dependencies.js';

/** One cached Tier-2 snapshot and its expiry instant. */
type QuayCacheEntry = { expiresAt: number; snapshot: QuaySnapshot };

/** The guarded, whitelist-checked command runner the composition hands to every read path. */
export type RunQuayCommand = (
  cwd: string,
  args: readonly string[],
  timeoutMs?: number,
) => Promise<QuayCommandResult>;

/** The shared Tests / Fan-in reading, cached per project so the panel and a cockpit tile agree. */
export type SuiteFanInReader = (projectPath: string, forceRefresh?: boolean) => Promise<QuaySuiteFanInReading>;

/** The lanes-only gantt read (one `quay lanes` child; no snapshot sections). */
export type GanttCollector = (
  projectPath: string,
  windowHours: number,
) => Promise<{ gantt: QuayGanttLanes | null; unavailable: QuayGanttUnavailableReason | null }>;

/**
 * Builds the cached Tests / Fan-in reader. The pair is cached TOGETHER (never per verb) so the
 * two cards always describe the same instant; the Tier-2 snapshot and the fleet summary's pulse
 * row share this one reader, so a project shown in both costs one pair of verbs per TTL.
 */
export function createSuiteFanInCache(
  dependencies: QuayServiceDependencies,
  runQuayCommand: RunQuayCommand,
): SuiteFanInReader {
  const suiteFanInCache = new Map<string, { expiresAt: number; reading: QuaySuiteFanInReading }>();
  const inFlightSuiteFanIn = new Map<string, Promise<QuaySuiteFanInReading>>();

  const readSuiteFanIn = (projectPath: string, forceRefresh = false): Promise<QuaySuiteFanInReading> => {
    if (!forceRefresh) {
      const cached = suiteFanInCache.get(projectPath);
      if (cached && cached.expiresAt > dependencies.now()) {
        return Promise.resolve(cached.reading);
      }
    }

    const pending = inFlightSuiteFanIn.get(projectPath);
    if (pending) {
      return pending;
    }

    const promise = readQuaySuiteAndFanIn(runQuayCommand, projectPath)
      .then((reading) => {
        suiteFanInCache.set(projectPath, {
          expiresAt: dependencies.now() + dependencies.snapshotTtlMs,
          reading,
        });
        return reading;
      })
      .finally(() => {
        inFlightSuiteFanIn.delete(projectPath);
      });

    inFlightSuiteFanIn.set(projectPath, promise);
    return promise;
  };
  return readSuiteFanIn;
}

/**
 * Builds the lanes-only collector: it spawns ONLY quay's `lanes` verb.
 *
 * This is the whole cost of a window switch. A window is a *data* filter over the same
 * project — the task/goal/ADR/driver/config sections do not depend on it — so re-reading
 * them on every click is pure waste (and, on a large store, 3–4 s of it). The full pass
 * still uses this collector for its `gantt` field, so there is one implementation of the read.
 *
 * A missing reading is classified rather than flattened: "the plugin has no such verb" and
 * "the verb ran but its document was unreadable" are different facts, and the panel states
 * which one it is. A non-zero exit is the CLI refusing the sub-command (an un-upgraded
 * plugin); anything else that yields no document is a read failure.
 */
export function createGanttCollector(runQuayCommand: RunQuayCommand): GanttCollector {
  const collectGantt = async (
    projectPath: string,
    windowHours: number,
  ): Promise<{ gantt: QuayGanttLanes | null; unavailable: QuayGanttUnavailableReason | null }> => {
    const result = await runQuayCommand(projectPath, [...QUAY_LANES_PREFIX, '--window-hours', String(windowHours)]);
    if (!result.ok) {
      return {
        gantt: null,
        unavailable: result.failureKind === 'nonzero-exit' ? 'plugin-lacks-lanes-verb' : 'lanes-read-failed',
      };
    }
    if (!result.stdout.trim()) {
      return { gantt: null, unavailable: 'lanes-read-failed' };
    }
    try {
      const gantt = readGanttLanes(parseJson(result.stdout));
      return gantt ? { gantt, unavailable: null } : { gantt: null, unavailable: 'lanes-read-failed' };
    } catch {
      return { gantt: null, unavailable: 'lanes-read-failed' };
    }
  };
  return collectGantt;
}

/** The snapshot/lanes read surface `createQuayService` exposes. */
export type QuaySnapshotReader = {
  readQuaySnapshot(projectId: string, options?: QuaySnapshotOptions): Promise<QuaySnapshot | null>;
  getCachedSnapshot(projectId: string): QuaySnapshot | null;
  getQuayLanes(projectId: string, windowHoursInput?: unknown): Promise<QuayLanesReading | null>;
  invalidateLanesForProject(projectId: string): void;
};

export type QuaySnapshotReaderOptions = {
  dependencies: QuayServiceDependencies;
  runQuayCommand: RunQuayCommand;
  readFleetAvailability(): Promise<QuayFleetAvailability>;
  readSuiteFanIn: SuiteFanInReader;
  collectGantt: GanttCollector;
};

/**
 * The Tier-2 snapshot cache and its lanes companion. Both keep an in-flight promise map as the
 * concurrency guard against a subprocess storm: a burst of panel opens for one project spawns
 * the CLI once, and a repeat of the same (project, window) lanes read spawns nothing.
 */
export function createQuaySnapshotReader(options: QuaySnapshotReaderOptions): QuaySnapshotReader {
  const { dependencies, runQuayCommand, readFleetAvailability, readSuiteFanIn, collectGantt } = options;
  const snapshotCache = new Map<string, QuayCacheEntry>();
  const inFlightSnapshots = new Map<string, Promise<QuaySnapshot>>();
  // The Loop pulse reading is the ONLY section a window change invalidates, so it carries its
  // own cache keyed by (project, window) — see `loadGantt`.
  const ganttCache = new Map<string, { expiresAt: number; gantt: QuayGanttLanes | null; unavailable: QuayGanttUnavailableReason | null }>();
  const inFlightGantt = new Map<string, Promise<{ gantt: QuayGanttLanes | null; unavailable: QuayGanttUnavailableReason | null }>>();

  /** The project's `quay serve` dashboard URL, or `null` for every normal absence. */
  const readDashboardUrl = async (projectPath: string): Promise<string | null> => {
    let text: string;
    try {
      text = await dependencies.readFile.readText(
        path.join(projectPath, '.quay', QUAY_SERVER_STATE_FILE),
      );
    } catch {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return null;
    }

    const address = readWebServiceAddress(parsed);
    if (!address) {
      return null;
    }

    const host = probeAddress(address.host);
    const alive = await dependencies.probeWebService(host, address.port);
    return alive ? `http://${host}:${address.port}/` : null;
  };

  const collectSnapshot = async (
    projectId: string,
    projectPath: string,
    windowHours: number = DEFAULT_QUAY_GANTT_WINDOW_HOURS,
    forceRefresh: boolean = false,
  ): Promise<{ snapshot: QuaySnapshot; complete: boolean }> => {
    const warnings: string[] = [];
    const quayDir = path.join(projectPath, '.quay');
    // Which CLI this snapshot's reads go through; resolved from the same cached resolver the
    // spawn boundary uses, so the diagnostic and the child process cannot disagree.
    const entrypointResolution = dependencies.resolveEntrypoint?.(projectPath) ?? null;
    // The driver read has its own injected ceiling; absent means the shared bound applies.
    const driverStatusTimeoutMs = dependencies.driverStatusTimeoutMs ?? dependencies.commandTimeoutMs;

    /**
     * Runs one command and reads its JSON body. A non-zero exit is not on its own a failure:
     * `quay config validate --json` prints its issue list and exits 1, and that list is the
     * reading we want — so stdout is parsed first and the exit status only decides when
     * nothing parseable came back. The warning is *returned* rather than pushed, so the
     * caller appends them in a fixed order despite the concurrent reads below.
     */
    const readJson = async (
      args: readonly string[],
      timeoutMs: number = dependencies.commandTimeoutMs,
    ): Promise<{ value: unknown; warning: string | null }> => {
      const result = await runQuayCommand(projectPath, args, timeoutMs);

      if (result.stdout.trim()) {
        try {
          return { value: parseJson(result.stdout), warning: null };
        } catch {
          // Fall through: an unparseable body is reported below.
        }
      }

      const reason = result.error ?? (result.stderr.trim() || `exit code ${result.code}`);
      // Tag the warning with the failure category so the panel can show *which*
      // failure this was (missing CLI vs. timeout vs. non-zero exit), rather than
      // the one generic "quay did not answer" the four situations used to collapse to.
      const detail = result.failureKind ? `[${result.failureKind}] ${reason}` : reason;
      return {
        value: null,
        warning: `${args.join(' ')}: ${result.ok ? 'returned non-JSON output' : detail}`,
      };
    };

    // Every section is independent, so they are gathered in ONE parallel pass: the cold path
    // costs the slowest single read, not their sum. The local carrier reads sit under the
    // trusted project root (a missing file is an empty reading, never a warning).
    const [
      tasksRead,
      goalsRead,
      adrsRead,
      driverRead,
      configRead,
      suiteFanIn,
      workerRoundRecord,
      dashboardUrl,
      ganttRead,
    ] = await Promise.all([
      // The whole array of ids/titles/statuses, without each task's ~10 KB body: the projection
      // below reads none of it. Measured on this project's 1.4k-task store: 18.4 MB / ~1.7 s
      // with bodies vs 715 KB / ~0.3 s without.
      readJson(['task', 'list', '--json', '--no-body']),
      readJson(['goal', 'list', '--json']),
      readJson(['adr', 'list', '--json']),
      // A cold driver status probes the driver subprocesses (~5.9 s measured): wider ceiling.
      readJson(['driver', 'status', '--kind', 'worker', '--json'], driverStatusTimeoutMs),
      readJson(['config', 'validate', '--json']),
      // The Tests and Fan-in cards are one reading in two projections, taken through quay's
      // own `suite` / `driver log` verbs (never by parsing the carrier files here). The pair
      // is shared with the fleet summary's pulse row through `readSuiteFanIn`.
      readSuiteFanIn(projectPath, forceRefresh),
      readLastCarrierRecord(dependencies.readFile, path.join(quayDir, QUAY_WORKER_ROUND_FILE)),
      readDashboardUrl(projectPath),
      collectGantt(projectPath, windowHours),
    ]);

    // Fixed order, matching the panel's reading order, so the banner is deterministic.
    for (const read of [tasksRead, goalsRead, adrsRead, driverRead, configRead]) {
      if (read.warning) {
        warnings.push(read.warning);
      }
    }
    // A skipped higher-priority plugin record (a cleaned-up version) or the bare-PATH fallback
    // is a real diagnostic the operator should see, not a silent internal decision.
    if (entrypointResolution?.warning) {
      warnings.push(entrypointResolution.warning);
    }

    // A `null` WITH a warning is a failed read (timeout, missing CLI, torn payload), so the
    // snapshot is partial; a warning-free `null` is just the CLI's JSON literal. Entrypoint
    // warnings are diagnostics, not failed reads, so they do not enter this predicate.
    const complete = [tasksRead, goalsRead, adrsRead, driverRead, configRead]
      .every((read) => read.value !== null || read.warning === null);

    // The pulse strip's blocked row. `depends_on` is absent from the CLI document, so the
    // unfinished tasks' store files supply the impact edges; `null` (task list unread) stays
    // null rather than becoming an empty row that would read as "nothing blocked".
    const blockers = summarizeBlockers(
      await enrichTaskRecordsWithStoreEdges(dependencies.readFile, projectPath, tasksRead.value),
    );

    const snapshot: QuaySnapshot = {
      projectId,
      projectPath,
      // Optional increment: `{ path, version, source }` only — never widening the driver summary.
      entrypoint: entrypointResolution === null
        ? null
        : {
            path: entrypointResolution.path,
            version: entrypointResolution.version,
            source: entrypointResolution.source,
          },
      generatedAt: new Date(dependencies.now()).toISOString(),
      cached: false,
      driver: summarizeDriver(driverRead.value),
      // The loop's overall status is projected from the SAME driver document above plus two
      // tiny file reads — it must never cost a second `driver status` spawn.
      loop: await summarizeLoop(dependencies.readFile, dependencies.now(), projectPath, driverRead.value),
      tasks: summarizeTasks(tasksRead.value),
      goals: summarizeGoals(goalsRead.value),
      adrs: summarizeAdrs(adrsRead.value),
      configIssues: summarizeConfigIssues(configRead.value),
      // The two card readings, adapted to the existing shapes by the reader. `carrierReadings`
      // says HOW they were obtained, so a missing verb is never drawn as an empty history.
      tests: suiteFanIn.tests,
      fanIn: suiteFanIn.fanIn,
      carrierReadings: suiteFanIn.carrierReadings,
      blockers,
      // The In-flight card and the Loop pulse gantt project ONE reading (`ganttRead.gantt`),
      // so they cannot contradict each other; `workerRoundRecord` only supplies timing fields.
      inFlight: summarizeInFlightTasks(ganttRead.gantt, workerRoundRecord),
      gantt: ganttRead.gantt,
      ganttUnavailable: ganttRead.unavailable,
      dashboardUrl,
      warnings,
      // The host-level CLI reading travels WITH the snapshot so the panel can state one cause
      // (missing / incompatible / no-handshake) instead of blaming each project's registration.
      // Collected inside the shared in-flight pass, so concurrent opens still receive the SAME
      // object and pay for one handshake (the reader's own TTL covers later opens).
      fleet: await readFleetAvailability(),
    };

    return { snapshot, complete };
  };

  /**
   * Loads (and caches) the FULL snapshot for one project at one window.
   *
   * The per-project cache and in-flight dedupe are keyed by `projectId` alone and hold the
   * DEFAULT window — that is the reading AC-247's `overview` fans out over, and its contract
   * is one entry per project. It is only entered when no fresh default reading can answer the
   * request: a window change reuses the default reading's non-gantt sections and re-reads just
   * the lanes (`loadGantt`), and `forceRefresh` recomputes everything in place. A non-default
   * window therefore reaches `collectSnapshot` directly and writes nothing to the per-project
   * cache.
   */
  const loadSnapshot = (
    projectId: string,
    projectPath: string,
    windowHours: number = DEFAULT_QUAY_GANTT_WINDOW_HOURS,
    forceRefresh: boolean = false,
  ): Promise<QuaySnapshot> => {
    if (windowHours !== DEFAULT_QUAY_GANTT_WINDOW_HOURS) {
      return collectSnapshot(projectId, projectPath, windowHours, forceRefresh)
        .then(({ snapshot }) => snapshot);
    }

    const pending = inFlightSnapshots.get(projectId);
    if (pending) {
      return pending;
    }

    const promise = collectSnapshot(projectId, projectPath, windowHours, forceRefresh)
      .then(({ snapshot, complete }) => {
        // A PARTIAL reading must not be cached: it would stick for the whole TTL and every retry
        // would answer `cached: true`. Retry it on the next open; cache complete readings.
        if (complete) {
          snapshotCache.set(projectId, {
            expiresAt: dependencies.now() + dependencies.snapshotTtlMs,
            snapshot,
          });
        }
        return snapshot;
      })
      .finally(() => {
        inFlightSnapshots.delete(projectId);
      });

    inFlightSnapshots.set(projectId, promise);
    return promise;
  };

  /**
   * Loads (and caches) the Loop pulse lane set for one (project, window), spawning only the
   * `lanes` verb.
   *
   * This is what makes a window switch cheap: the sections that do not depend on the window
   * are reused from the fresh default reading, and only this read is re-run. The cache is
   * keyed by BOTH ids because the window is part of the question — a 3h entry must never
   * answer a 12h request (`{lanes, overflow}` differ per window) — and `cached: true` says
   * this exact (project, window) reading was reused rather than re-spawned.
   */
  const loadGantt = async (
    projectId: string,
    projectPath: string,
    windowHours: number,
  ): Promise<{ gantt: QuayGanttLanes | null; unavailable: QuayGanttUnavailableReason | null; cached: boolean }> => {
    const key = `${projectId}::${windowHours}`;
    const cached = ganttCache.get(key);
    if (cached && cached.expiresAt > dependencies.now()) {
      return { gantt: cached.gantt, unavailable: cached.unavailable, cached: true };
    }

    const pending = inFlightGantt.get(key);
    if (pending) {
      const read = await pending;
      return { gantt: read.gantt, unavailable: read.unavailable, cached: false };
    }

    const promise = collectGantt(projectPath, windowHours)
      .then((read) => {
        ganttCache.set(key, { expiresAt: dependencies.now() + dependencies.snapshotTtlMs, gantt: read.gantt, unavailable: read.unavailable });
        return read;
      })
      .finally(() => {
        inFlightGantt.delete(key);
      });

    inFlightGantt.set(key, promise);
    const read = await promise;
    return { gantt: read.gantt, unavailable: read.unavailable, cached: false };
  };

  /**
   * Drops every cached lanes reading for one project (all windows). The event service calls
   * this when `<projectRoot>/.quay/worker-dispatch.json` changes, which is the signal that a
   * worker just started or finished — the next lanes read must spawn `lanes` again instead of
   * serving up to 30 s of stale in-flight data. Other projects' caches are untouched.
   */
  const invalidateLanesForProject = (projectId: string): void => {
    const prefix = `${projectId}::`;
    for (const key of [...ganttCache.keys()]) {
      if (key.startsWith(prefix)) {
        ganttCache.delete(key);
      }
    }
  };

  /**
   * The lanes-only reading (`GET /api/quay/:projectId/lanes`): one `quay lanes` read, reused
   * inside its TTL, with the window normalised through the same closed set the snapshot uses.
   *
   * It rides {@link loadGantt} rather than re-implementing the read, so the TTL cache, the
   * in-flight dedupe and the `plugin-lacks-lanes-verb` / `lanes-read-failed` classification are
   * the ones the snapshot already has. `null` is an unknown project, which the route answers 404.
   */
  const getQuayLanes = async (
    projectId: string,
    windowHoursInput?: unknown,
  ): Promise<QuayLanesReading | null> => {
    const projectPath = dependencies.resolveProjectPathById(projectId);
    if (!projectPath) {
      return null;
    }

    const windowHours = normalizeGanttWindowHours(windowHoursInput);
    const { gantt, unavailable } = await loadGantt(projectId, projectPath, windowHours);
    return {
      ok: true,
      gantt,
      ganttUnavailable: unavailable,
      generatedAt: new Date(dependencies.now()).toISOString(),
    };
  };

  /**
   * The snapshot itself, WITHOUT the fleet registry join. Kept separate so every branch above
   * (cache hit, in-flight join, window-switch reuse, full pass) is stamped with
   * `fleetProjectId` exactly once, in {@link getQuaySnapshot}.
   */
  const readQuaySnapshot = async (
    projectId: string,
    options: QuaySnapshotOptions = {},
  ): Promise<QuaySnapshot | null> => {
    const projectPath = dependencies.resolveProjectPathById(projectId);
    if (!projectPath) {
      return null;
    }

    const windowHours = normalizeGanttWindowHours(options.windowHours);

    // The default window keeps the per-project read-on-demand path: TTL cache, then the
    // shared in-flight promise, then a full pass.
    if (!options.forceRefresh && windowHours === DEFAULT_QUAY_GANTT_WINDOW_HOURS) {
      const cached = snapshotCache.get(projectId);
      if (cached && cached.expiresAt > dependencies.now()) {
        return { ...cached.snapshot, cached: true };
      }

      const pending = inFlightSnapshots.get(projectId);
      if (pending) {
        return pending;
      }
    }

    // A non-default window is the SAME project reading filtered to a different window: every
    // section but the Loop pulse family (the pulse chart, and the In-flight card that is a
    // projection of the same lanes document) is window-independent, so it reuses the fresh
    // default reading and re-reads only the lanes. `cached` reports whether that lanes read
    // itself was reused — a repeat of the same (project, window) spawns nothing.
    if (!options.forceRefresh && windowHours !== DEFAULT_QUAY_GANTT_WINDOW_HOURS) {
      const base = snapshotCache.get(projectId);
      if (base && base.expiresAt > dependencies.now()) {
        const { gantt, unavailable, cached } = await loadGantt(projectId, projectPath, windowHours);
        // The In-flight card is a projection of the pulse's lanes, so a window switch must
        // re-derive it too: reusing `base.snapshot.inFlight` (the default window's reading)
        // would re-open the exact card-vs-chart contradiction this panel was fixed to close.
        // The round carrier only supplements fields and is a local file read, never a
        // subprocess, so the window change still spawns the lanes verb alone.
        const workerRoundRecord = await readLastCarrierRecord(
          dependencies.readFile,
          path.join(projectPath, '.quay', QUAY_WORKER_ROUND_FILE),
        );
        return {
          ...base.snapshot,
          inFlight: summarizeInFlightTasks(gantt, workerRoundRecord),
          gantt,
          ganttUnavailable: unavailable,
          cached,
        };
      }
    }

    return loadSnapshot(projectId, projectPath, windowHours, options.forceRefresh === true);
  };

  /**
   * Reads a project's Tier-2 snapshot from the in-memory TTL cache WITHOUT ever
   * loading it: the two outcomes are the cached snapshot (marked `cached: true`)
   * or `null` on a miss / an expired entry. It never calls {@link loadSnapshot}
   * / {@link collectSnapshot} / `runCommand`, so a caller fanning out over N
   * projects spawns zero quay CLI processes — the property the MCP `overview`
   * tool (AC-247) rests on, where an unbounded cold-cache fan-out would otherwise
   * spawn one `quay` invocation per project.
   *
   * The freshness test is the SAME predicate `getQuaySnapshot`'s cache branch
   * uses (`cached.expiresAt > now()`), so the Tier-2 panel and the MCP gateway can
   * never disagree about whether a reading is fresh.
   *
   * Consumer: `server/index.ts` binds the MCP gateway's `McpQuayRunner.readCached`
   * to this method (AC-247); `getQuaySnapshot` keeps its existing load-on-demand
   * semantics and is bound to `refresh` instead.
   */
  const getCachedSnapshot = (projectId: string): QuaySnapshot | null => {
    const cached = snapshotCache.get(projectId);
    if (cached && cached.expiresAt > dependencies.now()) {
      return { ...cached.snapshot, cached: true };
    }
    return null;
  };

  return {
    readQuaySnapshot,
    getCachedSnapshot,
    getQuayLanes,
    invalidateLanesForProject,
  };
}
