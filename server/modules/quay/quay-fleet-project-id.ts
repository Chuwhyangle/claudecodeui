import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { QuayFleetExec } from './quay-fleet-registry.js';

/**
 * The CloudCLI project id → quay-fleet registry id mapping.
 *
 * WHY THIS EXISTS. A `quay://` reference's project segment is spoken out loud and dereferenced
 * by quay-fleet, so it must be the fleet's own stable identity (`projects[].id` in
 * `~/.quay-fleet/registry.json`, e.g. `claudecodeui`), never CloudCLI's internal project UUID.
 * The fleet registers projects by their ROOT path; CloudCLI addresses them by a database id.
 * This module is the single place that joins the two: the CloudCLI project's path (canonicalized,
 * so a trailing separator or a symlinked checkout still matches) is looked up in the registry's
 * project rows, and the registry id found there is the only project segment the wall may mint.
 *
 * The same join answers the other direction: given a registry id from an incoming reference,
 * it names the registered root (quay-fleet's `--root`) and, when CloudCLI knows that root, the
 * CloudCLI project whose snapshot can answer the read.
 *
 * A FLEET THAT CANNOT ANSWER IS AN ANSWER. No binary, a non-zero exit, malformed output — every
 * failure reads `null`, never throws. `null` is the honest "this project is not registered"
 * reading, and the UI renders it as 「未登记到 quay-fleet」 instead of falling back to a UUID.
 *
 * The registry document is cached for {@link QUAY_FLEET_PROJECT_ID_TTL_MS}; the join is
 * computed per call from that one small reading, so a summary over N projects costs at most
 * one `quay-fleet` invocation per TTL window.
 */

/** Subprocess bound. The fleet answers this join from one small JSON document. */
const QUAY_FLEET_TIMEOUT_MS = 10_000;

/** Cap on captured stdout — the registry document is small; this only bounds a runaway child. */
const QUAY_FLEET_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * How long one `quay-fleet registry list --json` reading is reused. Short because the registry
 * is an operator-edited file: a project added or renamed by hand should reach the wall within
 * a poll cycle, not after a server restart.
 */
export const QUAY_FLEET_PROJECT_ID_TTL_MS = 30_000;

/** One registered project row this module reads: the fleet id and the root it owns. */
export type QuayFleetRegisteredProject = {
  /** The fleet's stable identity — the `quay://` project segment. */
  id: string;
  /** The registered workspace root, already canonicalized for comparison. */
  root: string;
};

/**
 * One registry id joined to the CloudCLI project it names.
 *
 * `projectId` is `null` when CloudCLI does not know the registered root (an archived project,
 * or a fleet host whose registry lists a checkout this instance never added). The root is
 * still authoritative for the fleet read port; only the snapshot fallback needs `projectId`.
 */
export type QuayFleetProjectMatch = {
  fleetProjectId: string;
  root: string;
  projectId: string | null;
};

/**
 * The two joins the Quay module needs. Consumer: `quay.service.ts`, which stamps each fleet
 * summary entry and each snapshot with its `fleetProjectId`, and composes the URI resolver
 * over {@link QuayFleetProjectIdResolver.resolveFleetProject}.
 *
 * Both methods return `null` for "no such project" and never throw.
 */
export type QuayFleetProjectIdResolver = {
  /** CloudCLI project id → fleet registry id, or `null` when its root is not registered. */
  resolveFleetProjectId(projectId: string): Promise<string | null>;
  /** Fleet registry id → registered root + the CloudCLI project at that root. */
  resolveFleetProject(projectSegment: string): Promise<QuayFleetProjectMatch | null>;
};

/** The seams the mapper reads through; every one of them is replaceable in a test. */
export type QuayFleetProjectIdDependencies = {
  /** CloudCLI project id → absolute project path; `null`/absent for an unknown project. */
  resolveProjectPathById: (projectId: string) => string | null | undefined;
  /**
   * Every project this CloudCLI instance knows, used only for the reverse join
   * (registry id → CloudCLI project). Absent leaves `projectId: null` on every match, which
   * still resolves references through the fleet read port but has no snapshot fallback.
   */
  listProjects?: () => readonly { projectId: string; projectPath: string }[];
  /** The fleet CLI to spawn. Defaults to `QUAY_FLEET_BIN`, then `quay-fleet` on `PATH`. */
  binPath?: string;
  /** Child-process seam, defaulting to Node's `execFile`. */
  exec?: QuayFleetExec;
  /** Path normalizer used for root comparison. Defaults to realpath + trailing-slash trim. */
  normalizePath?: (filePath: string) => string;
  /** Clock seam for the TTL; defaults to `Date.now`. */
  now?: () => number;
  /** How long one registry reading is reused; defaults to {@link QUAY_FLEET_PROJECT_ID_TTL_MS}. */
  ttlMs?: number;
};

type QuayFleetExecError = Error & { code?: number | string | null; killed?: boolean };

/** Production child-process binding; every failure is a value, so the caller never sees a throw. */
const defaultExecFile: QuayFleetExec = (file, args, options) =>
  new Promise((resolve) => {
    execFile(file, [...args], options, (error: QuayFleetExecError | null, stdout, stderr) => {
      if (!error) {
        resolve({ ok: true, code: 0, stdout: stdout ?? '', stderr: stderr ?? '' });
        return;
      }
      const reason = error.killed === true
        ? `quay-fleet timed out: ${error.message}`
        : error.code === 'ENOENT'
          ? `quay-fleet was not found: ${file}`
          : `quay-fleet failed: ${error.message}`;
      resolve({
        ok: false,
        code: typeof error.code === 'number' ? error.code : null,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        error: reason,
      });
    });
  });

/** A path canonicalized for root comparison: symlinks resolved, trailing separators dropped. */
function canonicalPath(filePath: string): string {
  let resolved = filePath;
  try {
    resolved = fs.realpathSync.native(filePath);
  } catch {
    resolved = path.resolve(filePath);
  }
  const trimmed = resolved.replace(/[\\/]+$/, '');
  return trimmed === '' ? resolved : trimmed;
}

/** Parses a JSON document, or `null` when the child printed something else. */
function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Narrows one registry row to a usable `{id, root}` pair; `enabled` deliberately does not matter. */
function readProjectRow(value: unknown): { id: string; root: string } | null {
  if (value === null || typeof value !== 'object') return null;
  const row = value as { id?: unknown; root?: unknown };
  return typeof row.id === 'string' && row.id !== '' && typeof row.root === 'string' && row.root !== ''
    ? { id: row.id, root: row.root }
    : null;
}

/**
 * Builds the mapping service.
 *
 * The binary is resolved per call rather than captured at boot so an operator can install the
 * fleet CLI (or point `QUAY_FLEET_BIN` at a checkout) without restarting CloudCLI; a missing
 * binary is the ordinary "nothing is registered here" answer, not a boot failure.
 */
export function createQuayFleetProjectIdResolver(
  dependencies: QuayFleetProjectIdDependencies,
): QuayFleetProjectIdResolver {
  const exec = dependencies.exec ?? defaultExecFile;
  const normalize = dependencies.normalizePath ?? canonicalPath;
  const now = dependencies.now ?? Date.now;
  const ttlMs = dependencies.ttlMs ?? QUAY_FLEET_PROJECT_ID_TTL_MS;
  const binPath = dependencies.binPath ?? (process.env.QUAY_FLEET_BIN?.trim() || 'quay-fleet');

  /**
   * The cached registry reading. `entries: null` is a real reading too — "the fleet could not
   * be asked" — and is cached for the same short window so a down fleet is not re-spawned by
   * every project in a fan-out.
   */
  let cache: { expiresAt: number; entries: readonly QuayFleetRegisteredProject[] | null } | null = null;
  let inFlight: Promise<readonly QuayFleetRegisteredProject[] | null> | null = null;

  /** Runs `quay-fleet registry list --json` once and normalizes every registered root. */
  const readRegistry = async (): Promise<readonly QuayFleetRegisteredProject[] | null> => {
    let result;
    try {
      result = await exec(binPath, ['registry', 'list', '--json'], {
        timeout: QUAY_FLEET_TIMEOUT_MS,
        maxBuffer: QUAY_FLEET_MAX_OUTPUT_BYTES,
        encoding: 'utf8',
        windowsHide: true,
      });
    } catch {
      // A seam that throws is still "the fleet did not answer"; the caller maps it to null.
      return null;
    }
    if (!result.ok) return null;

    const document = parseJsonObject(result.stdout);
    const rows = document?.projects;
    if (!Array.isArray(rows)) return null;

    const entries: QuayFleetRegisteredProject[] = [];
    for (const row of rows) {
      const project = readProjectRow(row);
      if (project !== null) {
        entries.push({ id: project.id, root: normalize(project.root) });
      }
    }
    return entries;
  };

  /** The registry reading, from cache, from the one in-flight read, or fresh. */
  const registryEntries = async (): Promise<readonly QuayFleetRegisteredProject[] | null> => {
    if (cache !== null && cache.expiresAt > now()) {
      return cache.entries;
    }
    if (inFlight !== null) {
      return inFlight;
    }
    const read = readRegistry()
      .then((entries) => {
        cache = { expiresAt: now() + ttlMs, entries };
        return entries;
      })
      .finally(() => {
        inFlight = null;
      });
    inFlight = read;
    return read;
  };

  return {
    async resolveFleetProjectId(projectId) {
      const projectPath = dependencies.resolveProjectPathById(projectId);
      if (typeof projectPath !== 'string' || projectPath.trim() === '') {
        return null;
      }
      const entries = await registryEntries();
      if (entries === null) {
        return null;
      }
      const wanted = normalize(projectPath);
      const match = entries.find((entry) => entry.root === wanted);
      return match === undefined ? null : match.id;
    },

    async resolveFleetProject(projectSegment) {
      const entries = await registryEntries();
      if (entries === null) {
        return null;
      }
      const entry = entries.find((candidate) => candidate.id === projectSegment);
      if (entry === undefined) {
        return null;
      }

      const projects = dependencies.listProjects?.() ?? [];
      const project = projects.find((candidate) => normalize(candidate.projectPath) === entry.root);
      return { fleetProjectId: entry.id, root: entry.root, projectId: project?.projectId ?? null };
    },
  };
}
