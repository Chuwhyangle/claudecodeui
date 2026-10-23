import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createQuayFleetProjectIdResolver,
  QUAY_FLEET_PROJECT_ID_TTL_MS,
  type QuayFleetProjectIdDependencies,
} from '../quay-fleet-project-id.js';
import { createQuayService } from '../quay.service.js';

/**
 * The CloudCLI project id → quay-fleet registry id join (quay-fleet-project-id).
 *
 * THE MATCH IS BY ROOT, NOT BY NAME. The fleet registry is the authority for project identity,
 * and it registers a project by its root path; CloudCLI knows projects by a database id. The
 * join therefore canonicalizes BOTH sides — a trailing separator and a symlinked checkout are
 * the same project — and only an exact (canonical) root match yields a registry id.
 *
 * Everything below drives the real factory with an injected `exec`, so the assertions measure
 * the production join, its cache and its failure readings rather than a reimplementation.
 *
 * RUNNER NOTE: a server test, run through `tsx --test` (see `scripts/test.sh`); vitest's
 * include is `src/**` and would find no tests here.
 */

type ExecCall = { file: string; args: readonly string[] };

/** A registry document as `quay-fleet registry list --json` prints it. */
function registryDocument(projects: { id: string; root: string; enabled?: boolean }[]): string {
  return JSON.stringify({
    version: 1,
    projects: projects.map((project) => ({ enabled: true, ...project })),
    interfaceSessionIds: [],
    devSessionIds: [],
  });
}

/** The `quay-fleet --version --json` document a healthy CLI prints (the availability read). */
const HANDSHAKE_DOCUMENT = JSON.stringify({
  name: 'quay-fleet',
  version: '1.4.0',
  contracts: { wallUri: 'v0', registry: 1, interfaceSession: 'v0' },
});

/** An exec seam answering every call with `stdout`, recording the argv it was handed. */
function staticExec(stdout: string, calls: ExecCall[] = []): QuayFleetProjectIdDependencies['exec'] {
  return async (file, args) => {
    calls.push({ file, args: [...args] });
    // The availability reading now handshakes over the same seam; a stub that answered a
    // registry document for `--version` would model a fleet that cannot report contracts.
    if (args.includes('--version')) {
      return { ok: true, code: 0, stdout: HANDSHAKE_DOCUMENT, stderr: '' };
    }
    return { ok: true, code: 0, stdout, stderr: '' };
  };
}

/**
 * A temp workspace: `real/` is the checkout, `link/` a symlink to it. The registry registers
 * `real/` (with a trailing slash) while CloudCLI addresses the project through `link/` — the
 * two spellings must still join.
 */
function createWorkspace(): {
  directory: string;
  real: string;
  link: string;
  unregistered: string;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quay-fleet-project-id-'));
  const real = path.join(directory, 'my-checkout');
  const link = path.join(directory, 'linked-checkout');
  const unregistered = path.join(directory, 'elsewhere');
  fs.mkdirSync(real);
  fs.mkdirSync(unregistered);
  fs.symlinkSync(real, link, 'dir');
  return { directory, real, link, unregistered };
}

test('AC3: a registered root matches through a trailing separator and a symlink', async () => {
  const workspace = createWorkspace();
  try {
    const calls: ExecCall[] = [];
    const resolver = createQuayFleetProjectIdResolver({
      resolveProjectPathById: (projectId) =>
        projectId === 'cloud-project'
          // CloudCLI stored the SYMLINKED path, with a trailing separator of its own.
          ? `${workspace.link}${path.sep}`
          : null,
      listProjects: () => [{ projectId: 'cloud-project', projectPath: workspace.link }],
      exec: staticExec(
        registryDocument([
          // The fleet registered the REAL path, also with a trailing separator.
          { id: 'claudecodeui', root: `${workspace.real}${path.sep}` },
        ]),
        calls,
      ),
      binPath: '/usr/local/bin/quay-fleet',
    });

    assert.equal(await resolver.resolveFleetProjectId('cloud-project'), 'claudecodeui');
    // The registry is the authority for the id→root direction too.
    assert.deepEqual(await resolver.resolveFleetProject('claudecodeui'), {
      fleetProjectId: 'claudecodeui',
      root: fs.realpathSync.native(workspace.real),
      projectId: 'cloud-project',
    });

    // Both joins were answered from ONE registry read.
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args, ['registry', 'list', '--json']);
  } finally {
    fs.rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test('AC3: an unregistered root and an unregistered segment are null, never a guess', async () => {
  const workspace = createWorkspace();
  try {
    const resolver = createQuayFleetProjectIdResolver({
      resolveProjectPathById: (projectId) =>
        projectId === 'elsewhere' ? workspace.unregistered : null,
      listProjects: () => [{ projectId: 'elsewhere', projectPath: workspace.unregistered }],
      exec: staticExec(registryDocument([{ id: 'claudecodeui', root: workspace.real }])),
    });

    assert.equal(await resolver.resolveFleetProjectId('elsewhere'), null);
    // An unknown CloudCLI project is null without even reading the registry.
    assert.equal(await resolver.resolveFleetProjectId('no-such-project'), null);
    // A registry id nobody registered is null; CloudCLI ids are never accepted as segments.
    assert.equal(await resolver.resolveFleetProject('cloud-uuid'), null);
  } finally {
    fs.rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test('AC3: an unavailable registry reads every project as unregistered and never throws', async () => {
  const workspace = createWorkspace();
  try {
    const failures: QuayFleetProjectIdDependencies['exec'][] = [
      // CLI absent / non-zero exit.
      async () => ({ ok: false, code: null, stdout: '', stderr: '', error: 'ENOENT' }),
      // CLI present but printed something that is not the registry document.
      async () => ({ ok: true, code: 0, stdout: 'not json', stderr: '' }),
      // A document with no projects array.
      async () => ({ ok: true, code: 0, stdout: JSON.stringify({ version: 1 }), stderr: '' }),
      // A seam that throws outright (a spawn failure the adapter did not catch).
      async () => {
        throw new Error('spawn quay-fleet ENOENT');
      },
    ];

    for (const exec of failures) {
      const resolver = createQuayFleetProjectIdResolver({
        resolveProjectPathById: (projectId) =>
          projectId === 'p1' ? workspace.real : projectId === 'p2' ? workspace.unregistered : null,
        listProjects: () => [
          { projectId: 'p1', projectPath: workspace.real },
          { projectId: 'p2', projectPath: workspace.unregistered },
        ],
        exec,
      });

      assert.equal(await resolver.resolveFleetProjectId('p1'), null);
      assert.equal(await resolver.resolveFleetProjectId('p2'), null);
      assert.equal(await resolver.resolveFleetProject('claudecodeui'), null);
      // The failure is a value the UI can print, not a silent per-project "unregistered".
      const availability = await resolver.resolveFleetAvailability?.();
      assert.equal(availability?.available, false);
      assert.ok((availability?.reason ?? '').length > 0, 'an unavailable fleet must state why');
    }
  } finally {
    fs.rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test('AC3: the registry reading is cached for its TTL, then read again', async () => {
  const workspace = createWorkspace();
  try {
    let now = 1_000_000;
    let reads = 0;
    const exec: QuayFleetProjectIdDependencies['exec'] = async () => {
      reads += 1;
      return {
        ok: true,
        code: 0,
        stdout: registryDocument([{ id: 'claudecodeui', root: workspace.real }]),
        stderr: '',
      };
    };
    const resolver = createQuayFleetProjectIdResolver({
      resolveProjectPathById: () => workspace.real,
      exec,
      now: () => now,
    });

    assert.equal(await resolver.resolveFleetProjectId('p1'), 'claudecodeui');
    assert.equal(reads, 1);
    // Inside the TTL: no second spawn.
    now += 1_000;
    assert.equal(await resolver.resolveFleetProjectId('p1'), 'claudecodeui');
    assert.equal(reads, 1);
    // Past the TTL: the operator-edited registry is read again.
    now += QUAY_FLEET_PROJECT_ID_TTL_MS;
    assert.equal(await resolver.resolveFleetProjectId('p1'), 'claudecodeui');
    assert.equal(reads, 2);
  } finally {
    fs.rmSync(workspace.directory, { recursive: true, force: true });
  }
});

/**
 * The REAL fleet summary, composed from the same service `GET /api/quay/fleet-summary` reads,
 * with only the two CLI seams faked: the `quay-fleet` registry join and quay's own per-project
 * reading. The assertion therefore measures the response shape the cockpit receives.
 */
function fleetSummaryService(exec: QuayFleetProjectIdDependencies['exec'], projectPath: string) {
  const projects = () => [{ projectId: 'p1', projectPath }];
  return createQuayService({
    // Every candidate is a quay project: the summary filters on this carrier.
    fileExists: (filePath) => filePath.endsWith(path.join('.quay', 'config.yml')),
    resolveProjectPathById: (projectId) => (projectId === 'p1' ? projectPath : null),
    listProjects: projects,
    runCommand: async (_cwd, args) =>
      args[0] === 'task'
        ? { ok: true, code: 0, stdout: '[]', stderr: '' }
        : { ok: true, code: 0, stdout: JSON.stringify({ alive: 1, running: 0 }), stderr: '' },
    readFile: {
      size: async () => null,
      readChunk: async () => '',
      readText: async () => '',
    },
    probeWebService: async () => false,
    now: () => 1_000_000,
    snapshotTtlMs: 30_000,
    commandTimeoutMs: 10_000,
    fleetProjectIdResolver: createQuayFleetProjectIdResolver({
      resolveProjectPathById: (projectId) => (projectId === 'p1' ? projectPath : null),
      listProjects: projects,
      exec,
      binPath: '/usr/local/bin/quay-fleet',
    }),
  });
}

test('AC1: a missing fleet CLI is fleet.available=false with a reason, not a per-project verdict', async () => {
  const workspace = createWorkspace();
  try {
    const service = fleetSummaryService(
      // What the production adapter reports when `quay-fleet` is not on PATH and no
      // QUAY_FLEET_BIN is set.
      async () => ({
        ok: false,
        code: null,
        stdout: '',
        stderr: '',
        error: 'quay-fleet was not found: /usr/local/bin/quay-fleet',
      }),
      workspace.real,
    );

    const summary = await service.getFleetSummary();

    assert.equal(summary.fleet.available, false);
    assert.ok(
      (summary.fleet.reason ?? '').length > 0,
      'the UI needs a reason to print beside the missing-CLI notice',
    );
    // The project's own quay reading still answered; only the fleet identity is unknown.
    assert.equal(summary.projects.length, 1);
    assert.equal(summary.projects[0]?.fleetProjectId, null);
  } finally {
    fs.rmSync(workspace.directory, { recursive: true, force: true });
  }
});

test('AC1: an answering fleet with no matching project is available=true and fleetProjectId=null', async () => {
  const workspace = createWorkspace();
  try {
    const service = fleetSummaryService(
      // A healthy registry that registers some OTHER checkout: the CLI works, this project
      // simply is not in it. That is the honest per-project answer, not a missing CLI.
      staticExec(registryDocument([{ id: 'elsewhere', root: workspace.unregistered }])),
      workspace.real,
    );

    const summary = await service.getFleetSummary();

    assert.equal(summary.fleet.available, true);
    assert.equal(summary.fleet.reason, null);
    assert.equal(summary.projects.length, 1);
    assert.equal(summary.projects[0]?.fleetProjectId, null);
  } finally {
    fs.rmSync(workspace.directory, { recursive: true, force: true });
  }
});
