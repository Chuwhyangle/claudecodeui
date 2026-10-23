import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createQuayRouter } from '../quay.routes.js';
import type { QuayFleetProjectIdResolver } from '../quay-fleet-project-id.js';
import {
  createQuayFleetCliWallReader,
  createQuayUriResolver,
  QUAY_FLEET_BIN_ENV,
  type QuayFleetL1,
  type QuayFleetL2,
  type QuayFleetWallReader,
  type QuayUriSnapshotTasks,
} from '../quay-uri-resolve.js';
import { createQuayService } from '../quay.service.js';

/**
 * The wall's dereference contract (quay-wall-uri-dereference-with-snapshot-fallback), now with
 * the project segment resolved through the quay-fleet REGISTRY ID.
 *
 * The resolver is driven through its REAL factory and the same snapshot seam the service
 * composes, so the assertions measure the production read path rather than a reimplementation
 * of it. The fleet side is a stub whose payloads use quay-fleet's v0 enum
 * (`config/object-uri.types.v0.json`) verbatim.
 *
 * THE TWO IDENTITIES ARE DELIBERATELY DIFFERENT. `CLOUD_PROJECT_ID` is what CloudCLI's database
 * keys the project by; `FLEET_PROJECT_ID` is the registry id a `quay://` reference carries. A
 * UUID-shaped project segment must NOT resolve (it is the shape this task removed), and the
 * snapshot fallback must still be read through the CloudCLI id — the join is what proves both.
 *
 * RUNNER NOTE: this is a server test, so it runs under the repository's canonical server
 * runner (`tsx --test`, `scripts/test.sh`), not vitest — vitest's `include` is `src/**` only
 * and would report "No test files found" for this path.
 */

const CLOUD_PROJECT_ID = '86168fbf-16c9-4178-b23b-36b74c2eb695';
const FLEET_PROJECT_ID = 'claudecodeui';
const TASK_URI = `quay://${FLEET_PROJECT_ID}/task/T-42`;
const AC_URI = `quay://${FLEET_PROJECT_ID}/task/T-42#ac-3`;
const GOAL_URI = `quay://${FLEET_PROJECT_ID}/goal/G-1`;
const PROJECT_ROOT = '/workspace/claudecodeui';

/** A project segment in the shape the removed mapping used to accept: CloudCLI's own UUID. */
const UUID_URI = `quay://${CLOUD_PROJECT_ID}/task/T-42`;

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
  // The fleet ledger keys rows by the exact address, fragment included, so an AC address can
  // carry its own stored row. Keeping one here leaves the AC1 resolve on the fleet path.
  'quay://task/T-42#ac-3': [
    {
      state: 'ok',
      uri: 'quay://task/T-42#ac-3',
      summary: 'stored AC summary',
      generatedAt: '2026-10-23T01:10:00.000Z',
      sourceEventId: 'evt-ac',
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

/**
 * Resolves the one fixture fleet project to its registered root and CloudCLI project.
 *
 * Only the fleet REGISTRY id resolves; the CloudCLI project id (a UUID) is deliberately absent,
 * which is what makes a UUID-shaped project segment an `unknown-project`.
 */
function resolveFleetProject(
  projectSegment: string,
): Promise<{ fleetProjectId: string; root: string; projectId: string | null } | null> {
  return Promise.resolve(
    projectSegment === FLEET_PROJECT_ID
      ? { fleetProjectId: FLEET_PROJECT_ID, root: PROJECT_ROOT, projectId: CLOUD_PROJECT_ID }
      : null,
  );
}

/**
 * The project-id seam the service composes: the CloudCLI id joins to the fleet registry id
 * only through the registry, and the fleet id joins back to this fixture's root + CloudCLI id.
 */
const fleetProjectIdResolver: QuayFleetProjectIdResolver = {
  async resolveFleetProjectId(projectId) {
    return projectId === CLOUD_PROJECT_ID ? FLEET_PROJECT_ID : null;
  },
  resolveFleetProject,
};

test('AC1: fleet L1/L2 documents pass through, including the #ac-<n> fragment', async () => {
  const fleetCalls: string[] = [];
  const resolver = createQuayUriResolver({
    fleetWallReader: createStubFleet(true, fleetCalls),
    resolveFleetProject,
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
    fleetCalls.every((call) => !call.includes(`/${FLEET_PROJECT_ID}/`)),
    'no project segment may leak into a fleet call',
  );
});

test('AC2: an unavailable fleet port reads a task back from the snapshot fixture', async () => {
  const resolver = createQuayUriResolver({
    fleetWallReader: null,
    resolveFleetProject,
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
  assert.equal(resolved.reason, 'reader-unavailable');
  assert.deepEqual(resolved.actions, []);
  assert.equal(resolved.type, 'task');

  // There is no snapshot L2 ledger, so the honest reading is absent — never manufactured.
  const summary = await resolver.summary(TASK_URI);
  assert.equal(summary.ok, true);
  if (!summary.ok) return;
  assert.equal(summary.state, 'absent');
  assert.equal(summary.source, 'snapshot-fallback');
  assert.equal(summary.reason, 'reader-unavailable');
  assert.equal(summary.summary, undefined);
});

test('fallback reason no-summary: the fleet answered L1 but has stored no L2 row', async () => {
  // The write path is not wired yet, so `wall summary` answers `absent` for every URI. That
  // is NOT a reader failure: the fleet still supplies L1, and the snapshot supplies content.
  const noSummaryFleet: QuayFleetWallReader = {
    async resolve(uri: string): Promise<QuayFleetL1 | null> {
      return uri === 'quay://task/T-99'
        ? { uri, type: 'task', label: 'T-99', actions: V0_ACTIONS.task }
        : null;
    },
    async summary(uri: string): Promise<QuayFleetL2 | null> {
      return { state: 'absent', uri };
    },
  };
  const snapshot: QuayUriSnapshotTasks = {
    tasks: {
      total: 1,
      byStatus: { todo: 1 },
      ready: 0,
      needsHuman: 0,
      done: 0,
      recent: [
        { id: 'T-99', title: '无摘要任务的真实标题', status: 'todo', updatedAt: '2026-10-23T02:00:00.000Z' },
      ],
    },
  };
  const resolver = createQuayUriResolver({
    fleetWallReader: noSummaryFleet,
    resolveFleetProject,
    readSnapshot: async () => snapshot,
  });

  const resolved = await resolver.resolve(`quay://${FLEET_PROJECT_ID}/task/T-99`);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.source, 'snapshot-fallback');
  assert.equal(resolved.reason, 'no-summary');
  // The fleet's own enum is kept: a stored miss is not the same as an unreadable port.
  assert.deepEqual(resolved.actions, V0_ACTIONS.task);
  assert.equal(resolved.task?.title, '无摘要任务的真实标题');
  assert.equal(resolved.task?.status, 'todo');

  const summarized = await resolver.summary(`quay://${FLEET_PROJECT_ID}/task/T-99`);
  assert.equal(summarized.ok, true);
  if (!summarized.ok) return;
  assert.equal(summarized.state, 'absent');
  assert.equal(summarized.source, 'snapshot-fallback');
  assert.equal(summarized.reason, 'no-summary');
});

test('fallback reason reader-unavailable: a configured-but-failing read port is not a stored miss', async () => {
  // The adapter turns a missing CLI, a non-zero exit and an unparseable document into `null`;
  // the resolver must report that as `reader-unavailable`, separate from `no-summary`.
  const failingFleet: QuayFleetWallReader = {
    async resolve(): Promise<QuayFleetL1 | null> {
      return null;
    },
    async summary(): Promise<QuayFleetL2 | null> {
      return null;
    },
  };
  const resolver = createQuayUriResolver({
    fleetWallReader: failingFleet,
    resolveFleetProject,
    readSnapshot: async () => SNAPSHOT,
  });

  const resolved = await resolver.resolve(TASK_URI);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.source, 'snapshot-fallback');
  assert.equal(resolved.reason, 'reader-unavailable');
  assert.deepEqual(resolved.actions, []);
  assert.equal(resolved.task?.title, SNAPSHOT.tasks?.recent[0]?.title);

  const summarized = await resolver.summary(TASK_URI);
  assert.equal(summarized.ok, true);
  if (!summarized.ok) return;
  assert.equal(summarized.state, 'absent');
  assert.equal(summarized.reason, 'reader-unavailable');
});

test('the fleet read port is the CLI: missing/non-zero/unparseable output all read unavailable', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quay-fleet-reader-'));
  const writeExecutable = (name: string, body: string): string => {
    const filePath = path.join(directory, name);
    fs.writeFileSync(filePath, body);
    fs.chmodSync(filePath, 0o755);
    return filePath;
  };
  try {
    const missing = path.join(directory, 'does-not-exist');
    const nonZero = writeExecutable('non-zero.sh', '#!/bin/sh\nexit 3\n');
    const unparseable = writeExecutable('unparseable.sh', '#!/bin/sh\necho not-json\n');
    const good = writeExecutable(
      'good.sh',
      `#!/bin/sh\necho '${JSON.stringify({
        ok: true,
        uri: 'quay://task/T-1',
        type: 'task',
        label: 'T-1',
        actions: ['read'],
      })}'\n`,
    );

    for (const binaryPath of [missing, nonZero, unparseable]) {
      const reader = createQuayFleetCliWallReader({ binaryPath, timeoutMs: 2_000 });
      assert.ok(reader !== null);
      assert.equal(await reader.resolve('quay://task/T-1'), null, `${binaryPath} must read unavailable`);
      assert.equal(await reader.summary('quay://task/T-1', PROJECT_ROOT), null);
    }

    const reader = createQuayFleetCliWallReader({ binaryPath: good, timeoutMs: 2_000 });
    assert.ok(reader !== null);
    const l1 = await reader.resolve('quay://task/T-1');
    assert.equal(l1?.type, 'task');
    assert.deepEqual(l1?.actions, ['read']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }

  // No binary configured is the honest "no read port" reading, never a guessed host path.
  const previous = process.env[QUAY_FLEET_BIN_ENV];
  delete process.env[QUAY_FLEET_BIN_ENV];
  try {
    assert.equal(createQuayFleetCliWallReader({ binaryPath: null, timeoutMs: 2_000 }), null);
  } finally {
    if (previous !== undefined) process.env[QUAY_FLEET_BIN_ENV] = previous;
  }
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
    resolveFleetProject,
    readSnapshot: async () => SNAPSHOT,
  });

  const cases: { uri: string; code: string }[] = [
    // The project-less draft form.
    { uri: 'quay://task/T-42', code: 'missing-project' },
    // An invented object kind.
    { uri: `quay://${FLEET_PROJECT_ID}/widget/T-42`, code: 'unknown-type' },
    // Not a quay:// reference at all.
    { uri: 'https://example.test/task/T-42', code: 'not-a-quay-uri' },
    // A known kind with an empty id.
    { uri: `quay://${FLEET_PROJECT_ID}/task/`, code: 'empty-id' },
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

test('AC4: the project segment is a fleet registry id, and a UUID segment is unknown-project', async () => {
  const roots: string[] = [];
  const fleet: QuayFleetWallReader = {
    async resolve(uri: string): Promise<QuayFleetL1 | null> {
      return { uri, type: 'task', label: 'T-42', actions: V0_ACTIONS.task };
    },
    async summary(uri: string, projectRoot: string): Promise<QuayFleetL2 | null> {
      // The registered root is the fleet's `--root`: the project segment selects it and is
      // never part of the fleet's own address.
      roots.push(projectRoot);
      return { state: 'absent', uri };
    },
  };
  const resolver = createQuayUriResolver({
    fleetWallReader: fleet,
    resolveFleetProject,
    readSnapshot: async (projectId) => {
      // The snapshot is read through the CLOUDCLI project id the registry id joined to.
      assert.equal(projectId, CLOUD_PROJECT_ID);
      return SNAPSHOT;
    },
  });

  const resolved = await resolver.resolve(TASK_URI);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.uri, TASK_URI);
  assert.deepEqual(roots, [PROJECT_ROOT], 'the fleet summary must be called with the registered root');

  // The removed shape: a CloudCLI UUID as the project segment. The registry does not know it,
  // so the reference is named `unknown-project` and no fleet read is attempted for it.
  const before = roots.length;
  for (const result of [await resolver.resolve(UUID_URI), await resolver.summary(UUID_URI)]) {
    assert.equal(result.ok, false, 'a UUID-shaped project segment must not resolve');
    if (result.ok) continue;
    assert.equal(result.error.code, 'unknown-project');
  }
  assert.equal(roots.length, before, 'an unregistered segment must not reach the fleet read port');
});

test('AC3: the routes answer invalid references with 4xx and no read port with 503, never 500', async () => {
  const service = createQuayService({
    fileExists: () => true,
    resolveProjectPathById: (projectId) => (projectId === CLOUD_PROJECT_ID ? PROJECT_ROOT : null),
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
    fleetProjectIdResolver,
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

    // A project segment the fleet does not register (CloudCLI's UUID, the removed shape) is
    // a 404 naming `unknown-project` — never a UUID-addressed read.
    const unknown = await fetch(`${base}/resolve?uri=${encodeURIComponent(UUID_URI)}`);
    assert.equal(unknown.status, 404);
    const unknownBody = (await unknown.json()) as { error: { code: string } };
    assert.equal(unknownBody.error.code, 'unknown-project');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('AC1: the service composes the injected fleet reader into its dereference method', async () => {
  const service = createQuayService({
    fileExists: () => true,
    resolveProjectPathById: (projectId) => (projectId === CLOUD_PROJECT_ID ? PROJECT_ROOT : null),
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
    fleetProjectIdResolver,
  });

  const resolved = await service.resolveQuayUri(TASK_URI);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.deepEqual(resolved.actions, V0_ACTIONS.task);
  assert.equal(resolved.source, 'fleet');

  // The Tier-2 snapshot carries the same join: its project segment is the registry id, never
  // the CloudCLI id the request was keyed by.
  const snapshot = await service.getQuaySnapshot(CLOUD_PROJECT_ID);
  assert.equal(snapshot?.projectId, CLOUD_PROJECT_ID);
  assert.equal(snapshot?.fleetProjectId, FLEET_PROJECT_ID);
});
