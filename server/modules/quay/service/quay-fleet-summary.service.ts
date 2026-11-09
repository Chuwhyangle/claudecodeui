
import path from 'node:path';

import type { QuayFleetAvailability } from '../fleet/quay-fleet-project-id.js';
import { summarizeBlockers } from '../read/quay-blockers-summary.js';
import {
  QUAY_WORKER_ROUND_FILE,
  enrichTaskRecordsWithStoreEdges,
  readLastCarrierRecord,
  summarizeInFlightTasks,
} from '../read/quay-carrier-readers.js';
import type { QuayFileReader } from '../read/quay-command-port.js';
import { DEFAULT_QUAY_GANTT_WINDOW_HOURS } from '../read/quay-read-verbs.js';
import {
  EMPTY_FLEET_TASK_COUNTS,
  parseJson,
  parseJsonOrNull,
  summarizeDriver,
  summarizeFleetTaskCounts,
} from '../read/quay-snapshot-summaries.js';
import {
  QUAY_FLEET_SUMMARY_MAX_CONCURRENT_PROJECTS,
  QUAY_FLEET_SUMMARY_TTL_MS,
  type QuayContextEventsStatus,
  type QuayFleetProjectSummary,
  type QuayFleetSummary,
  type QuayFleetTaskCounts,
} from '../read/quay-snapshot-types.js';

import type { GanttCollector, RunQuayCommand, SuiteFanInReader } from './quay-snapshot-read.service.js';

/**
 * The eager cross-project reading behind the sidebar's task-count badges (fleet-overview P2):
 * driver state + task counts for every project with a `.quay/config.yml`, plus the compact
 * pulse rows a cockpit tile draws. Each entry has its own TTL and its own in-flight join, so a
 * fresh project is served without touching the CLI even when a sibling is stale, and a failed
 * reading is returned but never cached. The project fan-out is bounded by a counting semaphore.
 *
 * All mutable state lives in this factory's closure — the object is the lifecycle owner.
 * Consumer: `service/quay.service.ts`'s `getFleetSummary`.
 */

export type QuayFleetSummaryDependencies = {
  now(): number;
  detectQuayConfig(projectPath: string): boolean;
  listProjects?(): readonly { projectId: string; projectPath: string }[];
  resolveFleetProjectId(projectId: string): Promise<string | null>;
  readFleetAvailability(): Promise<QuayFleetAvailability>;
  readContextEventsStatus?(): QuayContextEventsStatus;
  runQuayCommand: RunQuayCommand;
  readFile: QuayFileReader;
  collectGantt: GanttCollector;
  readSuiteFanIn: SuiteFanInReader;
};

export type QuayFleetSummaryReader = {
  getFleetSummary(): Promise<QuayFleetSummary>;
};

export function createQuayFleetSummaryReader(
  dependencies: QuayFleetSummaryDependencies,
): QuayFleetSummaryReader {
  const runQuayCommand = dependencies.runQuayCommand;

  // ── the fleet summary (fleet-overview P2) ─────────────────────────────────────────────────
  //
  // A per-project reading of driver state + task counts, so the sidebar can show every
  // project's board at a glance without opening any of them. Each entry has its own TTL,
  // because projects are read independently: a project whose cache is still fresh is served
  // without touching the CLI even when another project in the same request is stale.
  const fleetSummaryCache = new Map<string, { expiresAt: number; summary: QuayFleetProjectSummary }>();
  const inFlightFleetProjects = new Map<string, Promise<QuayFleetProjectSummary>>();

  /** The cheapest task read the CLI offers: no bodies, only the status the badge counts. */
  const QUAY_FLEET_TASKS_COMMAND: readonly string[] = ['task', 'list', '--json', '--no-body'];
  const QUAY_FLEET_DRIVER_COMMAND: readonly string[] = ['driver', 'status', '--kind', 'worker', '--json'];

  // A counting semaphore over PROJECT loads. It is deliberately not a per-command limiter:
  // a project load spawns its two reads concurrently, so bounding projects at N also bounds
  // each command at N. A released slot is handed straight to the next waiter without
  // decrementing, so a waiter can never race a fresh acquirer past the ceiling.
  let fleetProjectsInFlight = 0;
  const fleetSlotWaiters: (() => void)[] = [];

  const acquireFleetSlot = (): Promise<void> => {
    if (fleetProjectsInFlight < QUAY_FLEET_SUMMARY_MAX_CONCURRENT_PROJECTS) {
      fleetProjectsInFlight += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => fleetSlotWaiters.push(resolve));
  };

  const releaseFleetSlot = (): void => {
    const next = fleetSlotWaiters.shift();
    if (next) {
      // The slot's ownership transfers; the count already includes it.
      next();
      return;
    }
    fleetProjectsInFlight -= 1;
  };

  /** Reads one project's driver state and task counts, with at most two child processes. */
  const loadFleetProject = async (
    candidate: { projectId: string; projectPath: string },
  ): Promise<QuayFleetProjectSummary> => {
    await acquireFleetSlot();
    try {
      const quayDir = path.join(candidate.projectPath, '.quay');
      // The pulse rows ride this project load (and therefore its TTL entry) rather than a
      // separate request: one cockpit tile needs one consistent reading, and the local carrier
      // reads are files while `lanes` and the Tests / Fan-in pair are read-only children.
      // `generatedAt` below is the single clock all four rows share.
      const [
        tasksRead,
        driverRead,
        fleetProjectId,
        ganttRead,
        suiteFanIn,
        workerRoundRecord,
      ] = await Promise.all([
        runQuayCommand(candidate.projectPath, QUAY_FLEET_TASKS_COMMAND),
        runQuayCommand(candidate.projectPath, QUAY_FLEET_DRIVER_COMMAND),
        // The registry reading is cached per TTL, so this is one `quay-fleet` call per window
        // for the whole fan-out rather than one per project.
        dependencies.resolveFleetProjectId(candidate.projectId),
        // The strip plots in-flight rows from the live intervals of this lane set; its window is
        // irrelevant to them (an in-flight run ends at `now`), so the default is reused.
        dependencies.collectGantt(candidate.projectPath, DEFAULT_QUAY_GANTT_WINDOW_HOURS),
        // The SAME reading the Tier-2 snapshot uses, through the shared TTL cache: a project
        // open in the panel and drawn in a cockpit tile costs one pair of verbs, not two.
        dependencies.readSuiteFanIn(candidate.projectPath),
        readLastCarrierRecord(dependencies.readFile, path.join(quayDir, QUAY_WORKER_ROUND_FILE)),
      ]);

      const failures: string[] = [];
      let tasks: QuayFleetTaskCounts | null = null;
      let taskRecords: unknown = null;
      if (!tasksRead.ok) {
        failures.push(`task list: ${tasksRead.error ?? `exit ${tasksRead.code === null ? 'abnormally' : tasksRead.code}`}`);
      } else {
        try {
          taskRecords = parseJson(tasksRead.stdout);
          tasks = summarizeFleetTaskCounts(taskRecords);
        } catch {
          // Reported through the same `error` channel as a failed child, so the caller has
          // one place to look for "this project's counts are not a reading".
        }
        if (tasks === null) {
          failures.push('task list: returned no task array');
        }
      }

      let driver: QuayFleetProjectSummary['driver'] = { state: 'unavailable' };
      if (driverRead.ok) {
        const summary = summarizeDriver(parseJsonOrNull(driverRead.stdout));
        if (summary) {
          driver = { state: summary.state };
        } else {
          failures.push('driver status: returned no driver record');
        }
      } else {
        failures.push(`driver status: ${driverRead.error ?? `exit ${driverRead.code === null ? 'abnormally' : driverRead.code}`}`);
      }

      const blockers = summarizeBlockers(
        await enrichTaskRecordsWithStoreEdges(dependencies.readFile, candidate.projectPath, taskRecords),
      );

      return {
        projectId: candidate.projectId,
        projectPath: candidate.projectPath,
        fleetProjectId,
        driver,
        tasks: tasks ?? EMPTY_FLEET_TASK_COUNTS,
        pulse: {
          generatedAt: new Date(dependencies.now()).toISOString(),
          inFlight: summarizeInFlightTasks(ganttRead.gantt, workerRoundRecord),
          gantt: ganttRead.gantt,
          tests: suiteFanIn.tests,
          fanIn: suiteFanIn.fanIn,
          blockers,
        },
        cached: false,
        error: failures.length > 0 ? failures.join('; ') : null,
      };
    } finally {
      releaseFleetSlot();
    }
  };

  /**
   * Reads the fleet summary: every project with a `.quay/config.yml`, each carrying its
   * driver state and task counts. Projects without that carrier are absent from the
   * result — the fleet is quay projects, not every project the server knows.
   *
   * A project inside its TTL window is served from cache and marked `cached: true`; a
   * project already loading has its in-flight read joined rather than duplicated, so
   * concurrent requests cost one child per project. Failed readings are returned (with
   * their `error`) but not cached, so a transient CLI failure cannot pin a wrong reading
   * for a whole TTL.
   */
  const getFleetSummary = async (): Promise<QuayFleetSummary> => {
    const candidates = (dependencies.listProjects?.() ?? []).filter((candidate) =>
      dependencies.detectQuayConfig(candidate.projectPath),
    );

    // Availability is read alongside the projects rather than before them: both share the
    // resolver's one cached registry read, so this adds no child process to the fan-out.
    const [projects, fleet] = await Promise.all([
      Promise.all(
        candidates.map(async (candidate): Promise<QuayFleetProjectSummary> => {
          const cached = fleetSummaryCache.get(candidate.projectId);
          if (cached && cached.expiresAt > dependencies.now()) {
            return { ...cached.summary, cached: true };
          }

          const pending = inFlightFleetProjects.get(candidate.projectId);
          if (pending) {
            return pending;
          }

          const load = (async (): Promise<QuayFleetProjectSummary> => {
            try {
              const reading = await loadFleetProject(candidate);
              if (reading.error === null) {
                fleetSummaryCache.set(candidate.projectId, {
                  expiresAt: dependencies.now() + QUAY_FLEET_SUMMARY_TTL_MS,
                  summary: reading,
                });
              }
              return reading;
            } finally {
              inFlightFleetProjects.delete(candidate.projectId);
            }
          })();
          inFlightFleetProjects.set(candidate.projectId, load);
          return load;
        }),
      ),
      dependencies.readFleetAvailability(),
    ]);

    return {
      projects,
      fleet,
      generatedAt: new Date(dependencies.now()).toISOString(),
      ttlPerProjectMs: QUAY_FLEET_SUMMARY_TTL_MS,
      cached: projects.length > 0 && projects.every((project) => project.cached),
      // Read after the fan-out, so the status is a fresh reading of the same
      // request rather than a value captured at construction.
      contextEvents: dependencies.readContextEventsStatus?.() ?? null,
    };
  };

  return { getFleetSummary };
}
