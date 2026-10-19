import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createQuayRouter } from '../quay.routes.js';
import {
  createQuayService,
  QUAY_FLEET_SUMMARY_MAX_CONCURRENT_PROJECTS,
  QUAY_FLEET_SUMMARY_TTL_MS,
  type QuayCommandResult,
} from '../quay.service.js';

/**
 * The fleet summary's contract, TTL and fan-out ceiling.
 *
 * Everything below drives the REAL `createQuayService` with injected adapters, so the
 * assertions measure the production fan-out (the same function `GET /api/quay/fleet-summary`
 * relays) rather than a reimplementation of it in the test.
 */

type ServiceDependencies = Parameters<typeof createQuayService>[0];

const TASKS_COMMAND = 'task list --json --no-body';
const DRIVER_COMMAND = 'driver status --kind worker --json';

/** The task body every successful fixture returns; statuses cover all four badge buckets. */
const TASK_BODY = [
  { id: 't1', status: 'todo' },
  { id: 't2', status: 'todo' },
  { id: 't3', status: 'ready' },
  { id: 't4', status: 'ready' },
  { id: 't5', status: 'ready' },
  { id: 't6', status: 'needs-human' },
  { id: 't7', status: 'done' },
  // A status the badge has no bucket for: it counts toward `total` and nothing else.
  { id: 't8', status: 'blocked' },
];

/** The idle worker driver fixture (`alive: 1`, `running: 0` reads as `idle`). */
const DRIVER_BODY = { alive: 1, running: 0, last_record_ts: '2026-10-18T00:00:00.000Z' };

function projectPath(projectId: string): string {
  return path.join(path.sep, 'workspace', projectId);
}

function configPath(projectId: string): string {
  return path.join(projectPath(projectId), '.quay', 'config.yml');
}

/** Minimal dependency set; a test overrides only the seams it measures. */
function createDependencies(overrides: Partial<ServiceDependencies> = {}): ServiceDependencies {
  return {
    fileExists: () => false,
    resolveProjectPathById: () => null,
    listProjects: () => [],
    runCommand: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }),
    readFile: {
      size: async () => null,
      readChunk: async () => '',
      readText: async () => {
        throw new Error('ENOENT');
      },
    },
    probeWebService: async () => false,
    now: () => 1_000_000,
    snapshotTtlMs: 30_000,
    commandTimeoutMs: 8_000,
    ...overrides,
  };
}

/** A runner answering each fleet command with its fixture body and recording every argv. */
function createFleetRunner(
  recorded: { cwd: string; command: string }[],
): ServiceDependencies['runCommand'] {
  return async (cwd: string, args: readonly string[]): Promise<QuayCommandResult> => {
    const command = args.join(' ');
    recorded.push({ cwd, command });
    if (command === TASKS_COMMAND) {
      return { ok: true, code: 0, stdout: JSON.stringify(TASK_BODY), stderr: '' };
    }
    if (command === DRIVER_COMMAND) {
      return { ok: true, code: 0, stdout: JSON.stringify(DRIVER_BODY), stderr: '' };
    }
    return { ok: false, code: 1, stdout: '', stderr: `unexpected command: ${command}` };
  };
}

/** Routes the config check to the named quay project ids and nowhere else. */
function quayConfigs(...projectIds: string[]): ServiceDependencies['fileExists'] {
  const configured = new Set(projectIds.map(configPath));
  return (filePath: string) => configured.has(filePath);
}

test('AC1: the summary carries only quay projects, with driver state and the five task counts', async () => {
  const recorded: { cwd: string; command: string }[] = [];
  const service = createQuayService(createDependencies({
    fileExists: quayConfigs('quay-a', 'quay-b'),
    listProjects: () => [
      { projectId: 'quay-a', projectPath: projectPath('quay-a') },
      { projectId: 'plain', projectPath: projectPath('plain') },
      { projectId: 'quay-b', projectPath: projectPath('quay-b') },
    ],
    runCommand: createFleetRunner(recorded),
  }));

  const summary = await service.getFleetSummary();

  // Only projects with `.quay/config.yml`: `plain` is absent, not present-and-empty.
  assert.deepEqual(summary.projects.map((project) => project.projectId), ['quay-a', 'quay-b']);
  for (const project of summary.projects) {
    assert.deepEqual(project.driver, { state: 'idle' });
    assert.deepEqual(project.tasks, {
      total: 8,
      todo: 2,
      ready: 3,
      needsHuman: 1,
      done: 1,
    });
    assert.equal(project.error, null);
    assert.equal(project.cached, false);
  }

  // One `--no-body` task read and one driver read per quay project, addressed at that
  // project's path (never the fleet's or another project's).
  assert.equal(recorded.filter((entry) => entry.command === TASKS_COMMAND).length, 2);
  assert.equal(recorded.filter((entry) => entry.command === DRIVER_COMMAND).length, 2);
  for (const entry of recorded) {
    const expectedProject = entry.cwd.endsWith('quay-a') ? 'quay-a' : 'quay-b';
    assert.equal(entry.cwd, projectPath(expectedProject));
  }
});

test('AC1: GET /api/quay/fleet-summary relays the service reading unchanged', async () => {
  const service = createQuayService(createDependencies({
    fileExists: quayConfigs('quay-a'),
    listProjects: () => [{ projectId: 'quay-a', projectPath: projectPath('quay-a') }],
    runCommand: createFleetRunner([]),
  }));

  const app = express();
  app.use('/api/quay', createQuayRouter({ quayService: service }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/quay/fleet-summary`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      projects: { projectId: string; tasks: Record<string, number>; driver: { state: string } }[];
      ttlPerProjectMs: number;
    };
    assert.equal(body.projects.length, 1);
    assert.equal(body.projects[0].projectId, 'quay-a');
    assert.equal(body.projects[0].tasks.todo, 2);
    assert.equal(body.projects[0].tasks.ready, 3);
    assert.equal(body.projects[0].tasks.needsHuman, 1);
    assert.equal(body.projects[0].driver.state, 'idle');
    assert.equal(body.ttlPerProjectMs, QUAY_FLEET_SUMMARY_TTL_MS);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('AC2: a request inside the 2-minute TTL spawns no CLI and is marked cached', async () => {
  let now = 1_000_000;
  const recorded: { cwd: string; command: string }[] = [];
  const service = createQuayService(createDependencies({
    fileExists: quayConfigs('quay-a', 'quay-b'),
    listProjects: () => [
      { projectId: 'quay-a', projectPath: projectPath('quay-a') },
      { projectId: 'quay-b', projectPath: projectPath('quay-b') },
    ],
    runCommand: createFleetRunner(recorded),
    now: () => now,
  }));

  const first = await service.getFleetSummary();
  assert.equal(recorded.filter((entry) => entry.command === TASKS_COMMAND).length, 2);
  assert.equal(first.cached, false);

  // A poll one second later — well inside the TTL — must not spawn `quay task list` again.
  now += 1_000;
  const second = await service.getFleetSummary();
  assert.equal(recorded.filter((entry) => entry.command === TASKS_COMMAND).length, 2);
  assert.deepEqual(second.projects.map((project) => project.cached), [true, true]);
  assert.equal(second.cached, true);
  assert.deepEqual(second.projects[0].tasks, first.projects[0].tasks);

  // Past the TTL the project is read again, and the fresh reading is not marked cached.
  now += QUAY_FLEET_SUMMARY_TTL_MS;
  const third = await service.getFleetSummary();
  assert.equal(recorded.filter((entry) => entry.command === TASKS_COMMAND).length, 4);
  assert.deepEqual(third.projects.map((project) => project.cached), [false, false]);
});

test('AC3: six quay projects fan out with at most four concurrent task reads', async () => {
  const projectIds = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
  let activeTaskReads = 0;
  let peakTaskReads = 0;

  const service = createQuayService(createDependencies({
    fileExists: quayConfigs(...projectIds),
    listProjects: () => projectIds.map((projectId) => ({
      projectId,
      projectPath: projectPath(projectId),
    })),
    runCommand: async (_cwd, args): Promise<QuayCommandResult> => {
      const command = args.join(' ');
      if (command === DRIVER_COMMAND) {
        return { ok: true, code: 0, stdout: JSON.stringify(DRIVER_BODY), stderr: '' };
      }
      activeTaskReads += 1;
      peakTaskReads = Math.max(peakTaskReads, activeTaskReads);
      // Hold the read open so overlap (or its absence) is observable, then answer.
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      activeTaskReads -= 1;
      return { ok: true, code: 0, stdout: JSON.stringify(TASK_BODY), stderr: '' };
    },
  }));

  const summary = await service.getFleetSummary();

  assert.equal(summary.projects.length, 6);
  assert.equal(peakTaskReads, QUAY_FLEET_SUMMARY_MAX_CONCURRENT_PROJECTS);
  // The ceiling is only meaningful if reads really did overlap.
  assert.ok(peakTaskReads > 1, 'reads ran strictly one at a time; the ceiling was not exercised');
});
