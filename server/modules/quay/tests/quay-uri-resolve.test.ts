import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { createQuayRouter } from '../quay.routes.js';
import {
  createQuayUriResolver,
  type QuayFleetL1,
  type QuayFleetL2,
  type QuayFleetWallReader,
  type QuayUriSnapshotTasks,
} from '../quay-uri-resolve.js';
import { createQuayService } from '../quay.service.js';

/**
 * The wall's dereference contract (quay-wall-uri-dereference-with-snapshot-fallback).
 *
 * The resolver is driven through its REAL factory and the same snapshot seam the service
 * composes, so the assertions measure the production read path rather than a reimplementation
 * of it. The fleet side is a stub whose payloads use quay-fleet's v0 enum
 * (`config/object-uri.types.v0.json`) verbatim.
 *
 * RUNNER NOTE: this is a server test, so it runs under the repository's canonical server
 * runner (`tsx --test`, `scripts/test.sh`), not vitest — vitest's `include` is `src/**` only
 * and would report "No test files found" for this path.
 */

const PROJECT = 'wall-proj';
const TASK_URI = 'quay://wall-proj/task/T-42';
const AC_URI = 'quay://wall-proj/task/T-42#ac-3';
const GOAL_URI = 'quay://wall-proj/goal/G-1';
const PROJECT_ROOT = '/workspace/wall-proj';

/** quay-fleet's v0 action enum, copied from its `config/object-uri.types.v0.json` fixture. */
const V0_ACTIONS = {
  task: ['read', 'check', 'edit', 'promote', 'retreat', 'complete', 'log', 'gate'],
  goal: ['read', 'check', 'gate', 'write'],
  ledger: ['read'],
  board: ['read'],
  fragmentAc: ['read', 'check', 'edit'],
} as const;

/**
 * L1 documents the stub fleet resolves; their shape is `wall resolve --json` verbatim, and
 * their KEYS are quay-fleet's own project-less address forms — the resolver must translate
 * the wall's project-scoped reference into these before calling the read port.
 */
const L1_BY_URI: Record<string, QuayFleetL1> = {
  'quay://task/T-42': { uri: 'quay://task/T-42', type: 'task', label: 'T-42', actions: V0_ACTIONS.task },
  'quay://task/T-42#ac-3': {
    uri: 'quay://task/T-42#ac-3',
    type: 'task',
    label: 'T-42#ac-3',
    actions: V0_ACTIONS.fragmentAc,
    fragment: { kind: 'ac', index: 3 },
  },
  'quay://goal/G-1': { uri: 'quay://goal/G-1', type: 'goal', label: 'G-1', actions: V0_ACTIONS.goal },
};

/** L2 ledger rows in write order per fleet address; the stub returns the LAST one, as the fleet does. */
const L2_ROWS: Record<string, QuayFleetL2[]> = {
  'quay://task/T-42': [
    {
      state: 'ok',
      uri: 'quay://task/T-42',
      summary: 'older stored summary',
      generatedAt: '2026-10-23T00:00:00.000Z',
      sourceEventId: 'evt-older',
    },
    {
      state: 'ok',
      uri: 'quay://task/T-42',
      summary: 'newest stored summary',
      generatedAt: '2026-10-23T01:00:00.000Z',
      sourceEventId: 'evt-newest',
    },
  ],
};

/** The snapshot fixture the fallback reads: the same stored task rows the panel renders. */
const SNAPSHOT: QuayUriSnapshotTasks = {
  tasks: {
    total: 1,
    byStatus: { ready: 1 },
    ready: 1,
    needsHuman: 0,
    done: 0,
    recent: [
      {
        id: 'T-42',
        title: '在途任务真实标题',
        status: 'ready',
        updatedAt: '2026-10-23T01:02:03.000Z',
      },
    ],
  },
};

/** A stub fleet read port: canned L1/L2 documents, `null` when it cannot answer. */
function createStubFleet(available = true, calls: string[] = []): QuayFleetWallReader {
  return {
    async resolve(uri: string): Promise<QuayFleetL1 | null> {
      calls.push(`resolve ${uri}`);
      if (!available) return null;
      return L1_BY_URI[uri] ?? null;
    },
    async summary(uri: string): Promise<QuayFleetL2 | null> {
      calls.push(`summary ${uri}`);
      if (!available) return null;
      const rows = L2_ROWS[uri] ?? [];
      return rows.length === 0 ? { state: 'absent', uri } : rows[rows.length - 1];
    },
  };
}

/** Resolves the one fixture project (and nothing else) to its workspace root. */
function resolveProjectRoot(projectId: string): string | null {
  return projectId === PROJECT ? PROJECT_ROOT : null;
}

test('AC1: fleet L1/L2 documents pass through, including the #ac-<n> fragment', async () => {
  const fleetCalls: string[] = [];
  const resolver = createQuayUriResolver({
    fleetWallReader: createStubFleet(true, fleetCalls),
    resolveProjectRoot,
    readSnapshot: async () => {
      throw new Error('the fallback snapshot must not be read while the fleet port answers');
    },
  });

  // A plain task reference returns the stub's type and action list VERBATIM.
  const plain = await resolver.resolve(TASK_URI);
  assert.equal(plain.ok, true);
  if (!plain.ok) return;
  assert.equal(plain.type, 'task');
  assert.deepEqual(plain.actions, V0_ACTIONS.task);
  assert.equal(plain.source, 'fleet');
  assert.equal(plain.fragment, undefined);
  // The response keeps the wall's project-scoped form, not the fleet's internal one.
  assert.equal(plain.uri, TASK_URI);

  // The `#ac-<n>` reference forwards the stub's `fragment` field unchanged.
  const ac = await resolver.resolve(AC_URI);
  assert.equal(ac.ok, true);
  if (!ac.ok) return;
  assert.deepEqual(ac.fragment, { kind: 'ac', index: 3 });
  assert.deepEqual(ac.actions, V0_ACTIONS.fragmentAc);
  assert.equal(ac.source, 'fleet');
  assert.equal(ac.uri, AC_URI);

  // L2 returns the ledger's LAST row for the URI.
  const summary = await resolver.summary(TASK_URI);
  assert.equal(summary.ok, true);
  if (!summary.ok) return;
  assert.equal(summary.state, 'ok');
  assert.equal(summary.summary, 'newest stored summary');
  assert.equal(summary.generatedAt, '2026-10-23T01:00:00.000Z');
  assert.equal(summary.sourceEventId, 'evt-newest');
  assert.equal(summary.source, 'fleet');
  assert.equal(summary.uri, TASK_URI);

  // No stored row is `absent` — a reading, not a failed read and never a generated summary.
  const absent = await resolver.summary(GOAL_URI);
  assert.equal(absent.ok, true);
  if (!absent.ok) return;
  assert.equal(absent.state, 'absent');
  assert.equal(absent.source, 'fleet');

  // The read port was called in quay-fleet's OWN forms: the project segment selects the
  // workspace root (--root), it is not part of the fleet's address.
  assert.ok(fleetCalls.includes('resolve quay://task/T-42'));
  assert.ok(fleetCalls.includes('resolve quay://task/T-42#ac-3'));
  assert.ok(fleetCalls.includes('summary quay://task/T-42'));
  assert.ok(fleetCalls.includes('summary quay://goal/G-1'));
  assert.ok(
    fleetCalls.every((call) => !call.includes(`/${PROJECT}/`)),
    'no project segment may leak into a fleet call',
  );
});

test('AC2: an unavailable fleet port reads a task back from the snapshot fixture', async () => {
  const resolver = createQuayUriResolver({
    fleetWallReader: null,
    resolveProjectRoot,
    readSnapshot: async () => SNAPSHOT,
  });

  const resolved = await resolver.resolve(TASK_URI);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;

  // The returned fields are the snapshot's own stored values, field for field.
  const fixture = SNAPSHOT.tasks?.recent[0];
  assert.ok(fixture !== undefined);
  assert.deepEqual(resolved.task, {
    id: fixture.id,
    title: fixture.title,
    status: fixture.status,
    updatedAt: fixture.updatedAt,
  });

  // The fallback declares itself, and invents no actions (the fleet owns that enum).
  assert.equal(resolved.source, 'snapshot-fallback');
  assert.deepEqual(resolved.actions, []);
  assert.equal(resolved.type, 'task');

  // There is no snapshot L2 ledger, so the honest reading is absent — never manufactured.
  const summary = await resolver.summary(TASK_URI);
  assert.equal(summary.ok, true);
  if (!summary.ok) return;
  assert.equal(summary.state, 'absent');
  assert.equal(summary.source, 'snapshot-fallback');
  assert.equal(summary.summary, undefined);
});

test('AC3: invalid references are named failures (never throws) and nothing generates', async () => {
  const generationCalls: string[] = [];
  const fleet = {
    async resolve(): Promise<QuayFleetL1 | null> {
      return null;
    },
    async summary(): Promise<QuayFleetL2 | null> {
      return null;
    },
    /** A generation seam that must stay untouched: the read path never synthesises an L2. */
    generateSummary(uri: string): string {
      generationCalls.push(uri);
      return 'synthesised summary';
    },
  };

  const resolver = createQuayUriResolver({
    fleetWallReader: fleet,
    resolveProjectRoot,
    readSnapshot: async () => SNAPSHOT,
  });

  const cases: { uri: string; code: string }[] = [
    // The project-less draft form.
    { uri: 'quay://task/T-42', code: 'missing-project' },
    // An invented object kind.
    { uri: 'quay://wall-proj/widget/T-42', code: 'unknown-type' },
    // Not a quay:// reference at all.
    { uri: 'https://example.test/task/T-42', code: 'not-a-quay-uri' },
    // A known kind with an empty id.
    { uri: 'quay://wall-proj/task/', code: 'empty-id' },
  ];

  for (const { uri, code } of cases) {
    const resolved = await resolver.resolve(uri);
    assert.equal(resolved.ok, false, `${uri} must not resolve`);
    if (resolved.ok) continue;
    assert.equal(resolved.error.code, code, `${uri} must name ${code}`);

    const summary = await resolver.summary(uri);
    assert.equal(summary.ok, false, `${uri} must not summarise`);
    if (summary.ok) continue;
    assert.equal(summary.error.code, code, `${uri} must name ${code}`);
  }

  // No LLM/generation call was made anywhere on these paths.
  assert.deepEqual(generationCalls, []);
});

test('AC3: the routes answer invalid references with 4xx and no read port with 503, never 500', async () => {
  const service = createQuayService({
    fileExists: () => true,
    resolveProjectPathById: (projectId) => (projectId === PROJECT ? PROJECT_ROOT : null),
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
    fleetWallReader: null,
  });

  const app = express();
  app.use('/api/quay', createQuayRouter({ quayService: service }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}/api/quay`;

    const invalid = await fetch(`${base}/resolve?uri=${encodeURIComponent('quay://task/T-42')}`);
    assert.equal(invalid.status, 400);
    const invalidBody = (await invalid.json()) as { ok: boolean; error: { code: string } };
    assert.equal(invalidBody.ok, false);
    assert.equal(invalidBody.error.code, 'missing-project');

    const missing = await fetch(`${base}/summary`);
    assert.equal(missing.status, 400);
    const missingBody = (await missing.json()) as { error: { code: string } };
    assert.equal(missingBody.error.code, 'missing-uri');

    // A goal reference has no snapshot fallback: the unavailable port is a 503, not a 500.
    const unavailable = await fetch(`${base}/resolve?uri=${encodeURIComponent(GOAL_URI)}`);
    assert.equal(unavailable.status, 503);
    const unavailableBody = (await unavailable.json()) as { error: { code: string } };
    assert.equal(unavailableBody.error.code, 'fleet-unavailable');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('AC1: the service composes the injected fleet reader into its dereference method', async () => {
  const service = createQuayService({
    fileExists: () => true,
    resolveProjectPathById: (projectId) => (projectId === PROJECT ? PROJECT_ROOT : null),
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
    fleetWallReader: createStubFleet(),
  });

  const resolved = await service.resolveQuayUri(TASK_URI);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.deepEqual(resolved.actions, V0_ACTIONS.task);
  assert.equal(resolved.source, 'fleet');
});
