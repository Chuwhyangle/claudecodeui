import fs from 'node:fs';

import { projectsDb, uiLastOpenedDb } from '@/modules/database/index.js';
import { loadServerSettings } from '@/modules/settings/index.js';

import { createQuayFleetProjectIdResolver } from './quay-fleet-project-id.js';
import { createQuayFleetRegistry } from './quay-fleet-registry.js';
import { createQuayInitiatives } from './quay-initiatives.js';
import { QUAY_COMMAND_TIMEOUT_MS, createQuayProcessRunner } from './quay-process.js';
import { createQuayRouter } from './quay.routes.js';
import { createQuayService, type QuayFileReader } from './quay.service.js';

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
 * The initiative view / decision queue reading. The sampling ratio is the SERVER settings
 * file's `initiative.auditRatio`, read here at import time (the module is composed at boot and
 * the knob is documented as read-once); a malformed value already fell back inside the loader.
 */
export const quayInitiatives = createQuayInitiatives({
  auditRatio: loadServerSettings().initiative.auditRatio,
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
});
