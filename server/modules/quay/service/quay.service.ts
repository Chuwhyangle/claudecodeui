import path from 'node:path';

import type { QuaySnapshot } from '@/shared/types.js';

import type { QuayFleetAvailability, QuayFleetProjectIdResolver } from '../fleet/quay-fleet-project-id.js';
import type { QuayProjectStatus } from '../read/quay-snapshot-types.js';
import { isReadOnlyQuayCommand } from '../read/quay-read-verbs.js';
import {
  createQuayFleetCliWallReader,
  createQuayUriResolver,
  type QuayFleetWallReader,
} from '../read/quay-uri-resolve.js';

import { createQuayFleetSummaryReader } from './quay-fleet-summary.service.js';
import {
  createGanttCollector,
  createQuaySnapshotReader,
  createSuiteFanInCache,
} from './quay-snapshot-read.service.js';
import type { QuayServiceDependencies, QuaySnapshotOptions } from './quay-service-dependencies.js';
import { createQuayTaskIndex } from './quay-task-index.service.js';

export type { QuayServiceDependencies, QuaySnapshotOptions } from './quay-service-dependencies.js';

/**
 * Creates the quay read-only display service.
 *
 * This file is the COMPOSITION only: it builds the guarded command runner, the fleet identity
 * join and the fleet-availability reading, then hands them to the three concern factories
 * (snapshot read, task index, fleet summary) and wires the wall-URI resolver on top of the
 * snapshot cache. Every filesystem, clock and subprocess access stays an injected dependency,
 * so the composition root binds production adapters while tests drive pure fakes.
 *
 * The package concerns live behind narrow barrels: `read/` (whitelist, gantt parser, carrier
 * and summary readers), `fleet/` (binary seam, registry, initiatives, liveness), `task/`
 * (capability probe, task-log readers, event refresh) and `service/` (this file plus the three
 * stateful factories). Directory edges run root -> every subpackage, `read`/`fleet`/`task` ->
 * `cli`, and `service` -> the other four; nothing imports the package root, so the directory
 * graph stays a DAG.
 */
export function createQuayService(dependencies: QuayServiceDependencies) {
  /**
   * The Cloudpit project id → fleet registry id join. A composition without a fleet answers
   * `null` for every project — the honest "nothing is registered here" reading that makes the
   * UI render 「未登记到 quay-fleet」 instead of minting a UUID reference the fleet cannot read.
   */
  const fleetProjectIds: QuayFleetProjectIdResolver = dependencies.fleetProjectIdResolver ?? {
    resolveFleetProjectId: async () => null,
    resolveFleetProject: async () => null,
    // Nothing was composed to ask the fleet with: that is "the CLI is not available here",
    // not "every project is unregistered".
    resolveFleetAvailability: async () => ({
      available: false,
      state: 'missing',
      binPath: null,
      version: null,
      contracts: null,
      reason: 'quay-fleet is not configured on this server (set QUAY_FLEET_BIN)',
    }),
  };

  /** Tier-1 detection: a pure path check, never a subprocess. */
  const detectQuayConfig = (projectPath: string): boolean =>
    dependencies.fileExists(path.join(projectPath, '.quay', 'config.yml'));

  /**
   * Runs one whitelisted read-only command; refuses anything else without spawning.
   * `timeoutMs` is per call because the snapshot's reads do not have equal cold costs;
   * omitting it keeps the shared `commandTimeoutMs` default.
   */
  const runQuayCommand = async (
    cwd: string,
    args: readonly string[],
    timeoutMs: number = dependencies.commandTimeoutMs,
  ) => {
    if (!isReadOnlyQuayCommand(args)) {
      return {
        ok: false,
        code: null,
        stdout: '',
        stderr: '',
        error: `refused: "${args.join(' ')}" is not on the quay read-only command whitelist`,
      };
    }

    return dependencies.runCommand(cwd, args, { timeoutMs });
  };

  /**
   * Whether the fleet could be asked. A resolver that does not expose the reading (an older
   * composition) keeps the pre-existing behaviour: the join answers per project and the
   * summary does not claim the CLI is missing.
   */
  const readFleetAvailability = async (): Promise<QuayFleetAvailability> => {
    if (fleetProjectIds.resolveFleetAvailability === undefined) {
      return {
        available: true,
        state: 'ok',
        binPath: null,
        version: null,
        contracts: null,
        reason: null,
      };
    }
    try {
      return await fleetProjectIds.resolveFleetAvailability();
    } catch {
      return {
        available: false,
        state: 'no-handshake',
        binPath: null,
        version: null,
        contracts: null,
        reason: 'quay-fleet availability could not be read',
      };
    }
  };

  const readSuiteFanIn = createSuiteFanInCache(dependencies, runQuayCommand);
  const collectGantt = createGanttCollector(runQuayCommand);

  const taskIndex = createQuayTaskIndex({
    now: dependencies.now,
    resolveProjectPathById: dependencies.resolveProjectPathById,
    onTaskIndexRead: dependencies.onTaskIndexRead,
    runQuayCommand,
  });

  const snapshots = createQuaySnapshotReader({
    dependencies,
    runQuayCommand,
    readFleetAvailability,
    readSuiteFanIn,
    collectGantt,
  });

  const fleetSummary = createQuayFleetSummaryReader({
    now: dependencies.now,
    detectQuayConfig,
    listProjects: dependencies.listProjects,
    resolveFleetProjectId: fleetProjectIds.resolveFleetProjectId,
    readFleetAvailability,
    readContextEventsStatus: dependencies.readContextEventsStatus,
    runQuayCommand,
    readFile: dependencies.readFile,
    collectGantt,
    readSuiteFanIn,
  });

  const getQuayStatus = (projectId: string): QuayProjectStatus | null => {
    const projectPath = dependencies.resolveProjectPathById(projectId);
    if (!projectPath) {
      return null;
    }

    return { projectId, projectPath, hasQuayConfig: detectQuayConfig(projectPath) };
  };

  /**
   * The Tier-2 snapshot as `GET /api/quay/:projectId/snapshot` answers it: the stored reading
   * plus the project's `fleetProjectId`. The join is stamped here, on every branch, because it
   * is what the wall mints its project segment from — a cached snapshot body carrying a stale
   * (or absent) join would let the renderer fall back to the Cloudpit id.
   */
  const getQuaySnapshot = async (
    projectId: string,
    options: QuaySnapshotOptions = {},
  ): Promise<QuaySnapshot | null> => {
    const snapshot = await snapshots.readQuaySnapshot(projectId, options);
    if (snapshot === null) {
      return null;
    }
    const fleetProjectId = await fleetProjectIds.resolveFleetProjectId(projectId);
    // Omitted rather than `null` when unregistered: the shared type documents absent and null
    // as the same reading, and an older snapshot shape stays byte-comparable. The object is
    // returned AS-IS when there is nothing to stamp, so two concurrent opens share one
    // reference through the in-flight promise (the panel's dedupe criterion measures this).
    return fleetProjectId === null ? snapshot : { ...snapshot, fleetProjectId };
  };

  // ── wall URI dereference (quay-wall-uri-dereference-with-snapshot-fallback) ──────────────
  //
  // The resolver is composed from the SAME snapshot reading the panel uses, so a fallback
  // answer cannot disagree with what the panel shows. The fleet reader is tried first; the
  // snapshot is read only when that port is unavailable, and the read path never generates
  // an L2 summary.
  const fleetWallReader: QuayFleetWallReader | null =
    dependencies.fleetWallReader !== undefined
      ? dependencies.fleetWallReader
      : createQuayFleetCliWallReader({ timeoutMs: dependencies.commandTimeoutMs });

  const quayUriResolver = createQuayUriResolver({
    fleetWallReader,
    // The project segment is a quay-fleet REGISTRY ID. The join names the registered root the
    // fleet read port is called with, and the Cloudpit project (if any) whose snapshot can
    // supplement a task reference.
    resolveFleetProject: (projectSegment) => fleetProjectIds.resolveFleetProject(projectSegment),
    // Cached first, so dereferencing a URI the panel just rendered spawns nothing. A cold
    // cache loads the same snapshot the panel loads; the TTL then serves both surfaces.
    readSnapshot: async (projectId) => snapshots.getCachedSnapshot(projectId) ?? getQuaySnapshot(projectId),
  });

  const resolveQuayUri = (uri: string) => quayUriResolver.resolve(uri);
  const getQuayUriSummary = (uri: string) => quayUriResolver.summary(uri);

  return {
    detectQuayConfig,
    runQuayCommand,
    getQuayStatus,
    getQuaySnapshot,
    getCachedSnapshot: snapshots.getCachedSnapshot,
    // The title bar's lanes-only reading: one `lanes` child per (project, window) per TTL,
    // and nothing else. `gantt`/`ganttUnavailable` are the snapshot's own fields.
    getQuayLanes: snapshots.getQuayLanes,
    // The `changes` Quay source (AC-348): a reader that never loads, plus the
    // non-blocking request that fills it. These two are why `changes` can report
    // full coverage without ever waiting on — or spawning — a snapshot.
    readTaskIndex: taskIndex.readTaskIndex,
    requestTaskIndexLoad: taskIndex.requestTaskIndexLoad,
    // The event-driven refresh's three primitives (quay-task-events.service.ts):
    // the baseline instant its ISO seed and rollback guard need, the row update an applied
    // transition writes, and the lanes invalidation a `worker-dispatch.json` change triggers.
    getTaskIndexLoadStartedAtMs: taskIndex.getTaskIndexLoadStartedAtMs,
    updateTaskIndexRow: taskIndex.updateTaskIndexRow,
    invalidateLanesForProject: snapshots.invalidateLanesForProject,
    // The eager cross-project reading (fleet-overview P2): driver state + task counts
    // for every quay project, per-project TTL, bounded fan-out. The sidebar consumes it
    // for the project-row task badges; the lazy Tier-2 snapshot stays the expanded view.
    getFleetSummary: fleetSummary.getFleetSummary,
    // The wall's dereference entry points (quay-wall-uri-dereference-with-snapshot-fallback):
    // `resolveQuayUri` answers the L1 reference (fleet first, snapshot for tasks), and
    // `getQuayUriSummary` the L2 stored summary (absent when the fleet has not stored one).
    resolveQuayUri,
    getQuayUriSummary,
  };
}
