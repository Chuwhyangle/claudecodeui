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

/** An exec seam answering every call with `stdout`, recording the argv it was handed. */
function staticExec(stdout: string, calls: ExecCall[] = []): QuayFleetProjectIdDependencies['exec'] {
  return async (file, args) => {
    calls.push({ file, args: [...args] });
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
