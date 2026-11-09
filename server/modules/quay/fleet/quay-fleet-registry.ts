import {
  canonicalFleetPath,
  createQuayFleetRunner,
  parseFleetJsonObject,
  type QuayFleetCommandResult,
  type QuayFleetExec,
} from '../cli/quay-fleet-cli.js';
import { locateQuayFleetCli } from '../cli/quay-fleet-locator.js';

/**
 * The fleet registry's per-project 「对人接口会话」, as the cockpit reads and writes it.
 *
 * THE FLEET IS THE AUTHORITY, and this module is the Cloudpit side of that contract. The registry
 * keeps the field as `projects[].interfaceSessionId` and exposes it through
 * `quay-fleet registry interface-session get|set|clear <project> --json`; the browser cannot spawn
 * that CLI, so the server is where the two calls live. Nothing here invents a project identity:
 * the Cloudpit project id is mapped to the fleet's own registry id by comparing the registered
 * ROOT with the project's path, because a Cloudpit UUID is not a fleet handle.
 *
 * A FLEET THAT CANNOT ANSWER IS AN ANSWER. Every failure — no binary, a non-zero exit, malformed
 * output — is reported as `{ok:false, reason}`, never thrown: the cockpit falls back to the
 * last-opened session and tells the person the pin could not be read. Throwing here would turn
 * "the fleet is not installed on this host" into a 500 on a page that otherwise works.
 */

/** The fleet registry reading for one project. */
export type QuayFleetInterfaceSessionReading =
  | { ok: true; project: string; interfaceSessionId: string | null }
  | { ok: false; reason: string; detail?: string };

/** The answer to a pin (`set`) or un-pin (`clear`). */
export type QuayFleetInterfaceSessionWrite =
  | { ok: true; project: string; interfaceSessionId: string | null }
  | { ok: false; reason: string; detail?: string };

/** The two operations the cockpit needs, both addressed by the Cloudpit project id. */
export type QuayFleetRegistryService = {
  /** Reads the project's pinned target conversation; `interfaceSessionId: null` means none. */
  readInterfaceSession(projectId: string): Promise<QuayFleetInterfaceSessionReading>;
  /** Pins `sessionId`, or un-pins when it is `null`. */
  writeInterfaceSession(
    projectId: string,
    sessionId: string | null,
  ): Promise<QuayFleetInterfaceSessionWrite>;
};

export type QuayFleetRegistryDependencies = {
  /** Cloudpit project id → absolute project path; `null` for an unknown project. */
  resolveProjectPathById: (projectId: string) => string | null | undefined;
  /** The fleet CLI to spawn. Defaults to the shared locator, which owns the lookup order. */
  binPath?: string;
  /** Child-process seam, defaulting to Node's `execFile`. */
  exec?: QuayFleetExec;
  /** Path normalizer used to match a registered root. Defaults to realpath + trailing-slash trim. */
  normalizePath?: (filePath: string) => string;
};

/** The project rows the `registry list --json` document carries that this module reads. */
type FleetRegistryProjectRow = { id?: unknown; root?: unknown };

/** Narrows one parsed project row to a usable `{id, root}` pair. */
function isProjectRow(value: unknown): value is { id: string; root: string } {
  if (value === null || typeof value !== 'object') return false;
  const row = value as FleetRegistryProjectRow;
  return typeof row.id === 'string' && row.id !== '' && typeof row.root === 'string' && row.root !== '';
}

/**
 * Builds the fleet-registry service.
 *
 * The binary is resolved per call rather than captured at boot so an operator can install the
 * fleet CLI (or point `QUAY_FLEET_BIN` at a checkout) without restarting Cloudpit; a missing
 * binary is the ordinary `fleet-cli-unavailable` answer, not a boot failure.
 */
export function createQuayFleetRegistry(
  dependencies: QuayFleetRegistryDependencies,
): QuayFleetRegistryService {
  const normalize = dependencies.normalizePath ?? canonicalFleetPath;

  /**
   * The binary each call spawns, resolved per call so an install (or a `QUAY_FLEET_BIN`
   * change) reaches the next read without a restart. An injected exec seam is honoured with
   * the bare name even when the host has no fleet installed; otherwise a lookup miss is the
   * ordinary `fleet-cli-unavailable` answer and no child is forked.
   */
  const resolveBinPath = (): string | null =>
    dependencies.binPath
    ?? locateQuayFleetCli().binPath
    ?? (dependencies.exec === undefined ? null : 'quay-fleet');

  const run = createQuayFleetRunner({ resolveBinPath, exec: dependencies.exec });

  /**
   * Resolves the Cloudpit project to the fleet's own registry id.
   *
   * The path comes from the database, never from the request, and the fleet id is matched by root
   * so a project Cloudpit knows but the fleet does not register is `unknown-project` rather than
   * being guessed from the display name.
   */
  const resolveFleetProject = async (
    projectId: string,
  ): Promise<{ ok: true; id: string } | { ok: false; reason: string; detail?: string }> => {
    const projectPath = dependencies.resolveProjectPathById(projectId);
    if (projectPath === null || projectPath === undefined || projectPath.trim() === '') {
      return { ok: false, reason: 'unknown-project', detail: `no project ${projectId}` };
    }

    const listed = await run(['registry', 'list', '--json']);
    if (!listed.ok) {
      return { ok: false, reason: 'fleet-cli-unavailable', detail: listed.error };
    }
    const document = parseFleetJsonObject(listed.stdout);
    const rows = document?.projects;
    if (!Array.isArray(rows)) {
      return { ok: false, reason: 'fleet-cli-invalid-output', detail: 'registry list carried no projects' };
    }
    const wanted = normalize(projectPath);
    const match = rows.find((row): row is { id: string; root: string } =>
      isProjectRow(row) && normalize(row.root) === wanted,
    );
    return match === undefined
      ? { ok: false, reason: 'unknown-project', detail: `no registered project at ${projectPath}` }
      : { ok: true, id: match.id };
  };

  /** Reads one JSON answer, translating the CLI's own `{ok:false, reason}` document verbatim. */
  const readAnswer = (
    result: QuayFleetCommandResult,
    failureReason: string,
  ): QuayFleetInterfaceSessionReading | QuayFleetInterfaceSessionWrite => {
    const document = parseFleetJsonObject(result.stdout);
    if (document === null) {
      return result.ok
        ? { ok: false, reason: 'fleet-cli-invalid-output' }
        : { ok: false, reason: failureReason, ...(result.error === undefined ? {} : { detail: result.error }) };
    }
    if (document.ok !== true) {
      const reason = typeof document.reason === 'string' && document.reason !== ''
        ? document.reason
        : failureReason;
      const detail = typeof document.detail === 'string' ? document.detail : undefined;
      return { ok: false, reason, ...(detail === undefined ? {} : { detail }) };
    }
    const project = typeof document.project === 'string' ? document.project : '';
    const interfaceSessionId =
      typeof document.interfaceSessionId === 'string' && document.interfaceSessionId !== ''
        ? document.interfaceSessionId
        : null;
    return { ok: true, project, interfaceSessionId };
  };

  return {
    async readInterfaceSession(projectId) {
      const project = await resolveFleetProject(projectId);
      if (!project.ok) return project;

      const result = await run(['registry', 'interface-session', 'get', project.id, '--json']);
      return readAnswer(result, 'fleet-cli-unavailable');
    },

    async writeInterfaceSession(projectId, sessionId) {
      const project = await resolveFleetProject(projectId);
      if (!project.ok) return project;

      const result = sessionId === null
        ? await run(['registry', 'interface-session', 'clear', project.id, '--json'])
        : await run(['registry', 'interface-session', 'set', project.id, sessionId, '--json']);
      return readAnswer(result, 'fleet-cli-unavailable');
    },
  };
}
