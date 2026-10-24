/**
 * The architecture structural delta — pure diff + producer criteria (AC1).
 *
 * AC1, over two snapshot fixtures:
 *   · the delta reports an added cycle and a removed cycle with their members;
 *   · a new edge that reverses an existing dependency is reported as a reverse edge, and a
 *     declared layer is used to call the same edge a cross-layer violation;
 *   · a project with no layer declaration reports plain new edges, not layer readings;
 *   · the top-five growth list is the five largest grows in the `additionsShare` caliber, the
 *     caliber field and every share are present, and the sixth grower is excluded;
 *   · the central package's growth is reported and `growthReturnedToHubs` says whether it is in
 *     that top-five list.
 *
 * AC1, through the producer:
 *   · a first read writes `cloudcli://architecture/<id>` with the snapshot and a first-reading
 *     sentence; a second trigger inside one hour does NOT call the snapshot reader again; a
 *     trigger after the hour does;
 *   · a failed snapshot is written as `unevaluated` WITH its reason (never a green reading);
 *   · a project without a fleet id is skipped (nowhere to show it).
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/observation/tests/architecture-delta.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type {
  ArchitectureStructureCycle,
  ArchitectureStructureEdge,
  ArchitectureStructureResult,
  ArchitectureStructureSnapshot,
} from '@/modules/architecture/index.js';
import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';

import {
  ARCHITECTURE_GROWTH_TOP_N,
  ARCHITECTURE_SIZE_CALIBER,
  diffArchitectureStructures,
} from '../architecture-delta.js';
import {
  ARCHITECTURE_DELTA_REFRESH_MS,
  createArchitectureDeltaProducer,
} from '../architecture-delta.producer.js';
import { formatArchitectureUri } from '../observation-uri.js';
import {
  createObservationStore,
  type ObservationStore,
  type ObservedObject,
} from '../observation-store.js';

/** A fixed instant; every fixture time is expressed relative to it. */
const NOW = 1_700_000_000_000;
const CLOUD_PROJECT_ID = 'cloudcli-uuid';
const FLEET_PROJECT_ID = 'claudecodeui';

let temporaryDirectory = '';
let previousDatabasePath: string | undefined;

let clock = NOW;
const store: ObservationStore = createObservationStore({ now: () => clock });

test.before(async () => {
  previousDatabasePath = process.env.DATABASE_PATH;
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'observation-architecture-delta-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(temporaryDirectory, 'auth.db');
  await initializeDatabase();
});

test.after(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) {
    delete process.env.DATABASE_PATH;
  } else {
    process.env.DATABASE_PATH = previousDatabasePath;
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test.beforeEach(() => {
  clock = NOW;
  const db = getConnection();
  db.exec('DELETE FROM observed_revisions');
  db.exec('DELETE FROM observed_objects');
  db.exec('DELETE FROM observation_seen_cursors');
});

function cycle(...members: string[]): ArchitectureStructureCycle {
  const sorted = [...members].sort();
  return { key: sorted.join('|'), members: sorted };
}

function edge(from: string, to: string, weight: number): ArchitectureStructureEdge {
  return { from, to, weight };
}

/** The snapshot the reader last saw. */
function previousSnapshot(): ArchitectureStructureSnapshot {
  return {
    id: 'snapshot-prev',
    packages: [
      { id: 'server/modules/core', files: 4, entities: 20, layer: null },
      { id: 'src/modules/alpha', files: 2, entities: 10, layer: null },
      { id: 'src/modules/beta', files: 2, entities: 10, layer: null },
      { id: 'src/modules/legacy', files: 3, entities: 8, layer: null },
      { id: 'src/modules/ui', files: 1, entities: 5, layer: null },
      { id: 'src/modules/delta', files: 1, entities: 2, layer: null },
      { id: 'src/modules/gamma', files: 1, entities: 3, layer: null },
      { id: 'src/modules/epsilon', files: 1, entities: 1, layer: null },
      { id: 'src/modules/zeta', files: 0, entities: 0, layer: null },
    ],
    edges: [
      edge('server/modules/core', 'src/modules/ui', 4),
      edge('src/modules/beta', 'server/modules/core', 3),
      edge('src/modules/legacy', 'server/modules/core', 1),
    ],
    cycles: [
      cycle('src/modules/a', 'src/modules/b'),
      cycle('src/modules/x', 'src/modules/y'),
    ],
    totals: { packages: 9, entities: 59, files: 15, edges: 3 },
    layers: null,
  };
}

/**
 * The snapshot taken now, with a layer declaration.
 *
 * Outer layers are listed first: `src` (index 0) is outer, `server` (index 1) is inner. An edge
 * from an outer to an inner layer follows the declared direction, so the NEW
 * `src/modules/ui → server/modules/core` is a legal cross-layer dependency; the NEW
 * `server/modules/core → src/modules/legacy` points from the inner layer back at the outer one
 * and is therefore both a reverse edge (its opposite already exists) and a layer violation.
 */
function currentSnapshot(): ArchitectureStructureSnapshot {
  return {
    id: 'snapshot-current',
    packages: [
      { id: 'server/modules/core', files: 4, entities: 23, layer: 'core' },
      { id: 'src/modules/alpha', files: 3, entities: 22, layer: 'ui' },
      { id: 'src/modules/beta', files: 2, entities: 14, layer: 'ui' },
      { id: 'src/modules/legacy', files: 2, entities: 3, layer: 'ui' },
      { id: 'src/modules/ui', files: 1, entities: 5, layer: 'ui' },
      { id: 'src/modules/delta', files: 1, entities: 5, layer: 'ui' },
      { id: 'src/modules/gamma', files: 2, entities: 8, layer: 'ui' },
      { id: 'src/modules/epsilon', files: 1, entities: 2, layer: 'ui' },
      { id: 'src/modules/zeta', files: 1, entities: 1, layer: 'ui' },
    ],
    edges: [
      edge('server/modules/core', 'src/modules/ui', 4),
      edge('src/modules/beta', 'server/modules/core', 3),
      edge('src/modules/ui', 'server/modules/core', 2),
      edge('src/modules/alpha', 'src/modules/beta', 1),
      edge('src/modules/gamma', 'server/modules/core', 1),
      edge('server/modules/core', 'src/modules/legacy', 1),
    ],
    cycles: [cycle('src/modules/a', 'src/modules/b'), cycle('src/modules/delta', 'src/modules/gamma')],
    totals: { packages: 9, entities: 83, files: 17, edges: 6 },
    layers: {
      layers: [
        { name: 'ui', packages: ['src'] },
        { name: 'core', packages: ['server'] },
      ],
    },
  };
}

function snapshotResult(snapshot: ArchitectureStructureSnapshot): ArchitectureStructureResult {
  return {
    snapshot,
    provenance: {
      generatedAt: '2026-10-24T00:00:00.000Z',
      fingerprints: [{ scope: 'server', archJsonHash: 'hash' }],
    },
  };
}

function digestOf(object: ObservedObject | null): Record<string, unknown> {
  assert.ok(object !== null, 'the producer must write a revision');
  return object.digest as Record<string, unknown>;
}

test('AC1: added/removed cycles, reverse edges and declared-layer violations are reported', () => {
  const diff = diffArchitectureStructures(previousSnapshot(), currentSnapshot());

  assert.deepEqual(
    diff.addedCycles.map((entry) => entry.key),
    [cycle('src/modules/delta', 'src/modules/gamma').key],
    'the cycle absent from the previous snapshot must be reported as added, with its members',
  );
  assert.deepEqual(
    diff.removedCycles.map((entry) => entry.key),
    [cycle('src/modules/x', 'src/modules/y').key],
    'the cycle only the previous snapshot had must be reported as removed',
  );
  assert.deepEqual(diff.addedCycles[0]!.members, ['src/modules/delta', 'src/modules/gamma']);

  assert.ok(
    diff.newReverseEdges.some(
      (entry) => entry.from === 'src/modules/ui' && entry.to === 'server/modules/core',
    ),
    'a new edge whose opposite direction already existed must be reported as a reverse edge',
  );
  assert.ok(
    !diff.newReverseEdges.some(
      (entry) => entry.from === 'src/modules/alpha' && entry.to === 'src/modules/beta',
    ),
    'a new edge with no existing opposite direction is not a reverse edge',
  );

  assert.ok(
    diff.newCrossLayerEdges.some(
      (entry) => entry.from === 'src/modules/ui' && entry.to === 'server/modules/core',
    ),
    'the declared layers must be used to classify a new cross-layer edge',
  );
  assert.deepEqual(
    diff.newLayerViolations.map((entry) => `${entry.from}>${entry.to}`),
    ['server/modules/core>src/modules/legacy'],
    'an inner layer depending on an outer one violates the outer-first declaration',
  );
  assert.ok(
    !diff.newLayerViolations.some(
      (entry) => entry.from === 'src/modules/ui' && entry.to === 'server/modules/core',
    ),
    'an outer layer depending on an inner one follows the declared direction and is not a violation',
  );
});

test('AC1: without a layer declaration only plain new edges are reported', () => {
  const previous = previousSnapshot();
  const current = { ...currentSnapshot(), layers: null };
  const diff = diffArchitectureStructures(previous, current);

  assert.deepEqual(diff.newLayerViolations, []);
  assert.deepEqual(diff.newCrossLayerEdges, []);
  assert.ok(
    diff.newEdges.some((entry) => entry.from === 'src/modules/ui' && entry.to === 'server/modules/core'),
    'the new edge is still reported',
  );
  assert.ok(
    diff.deltaItems.some((item) => item.startsWith('新增反向依赖 ')),
    'a reversing edge is still spelled with its reverse reading',
  );
});

test('AC1: growth ranking is the top five in the additionsShare caliber', () => {
  const diff = diffArchitectureStructures(previousSnapshot(), currentSnapshot());

  assert.equal(diff.sizeCaliber, ARCHITECTURE_SIZE_CALIBER);
  assert.equal(ARCHITECTURE_SIZE_CALIBER, 'additionsShare');
  assert.equal(diff.sizeUnit, 'entity');
  assert.equal(diff.growthTop5.length, ARCHITECTURE_GROWTH_TOP_N);

  // Growth: alpha +12, gamma +5, beta +4, core +3, delta +3; epsilon +1 and zeta +1 are the
  // sixth/seventh growers and must NOT be listed.
  assert.deepEqual(
    diff.growthTop5.map((row) => `${row.package}:${row.growth}`),
    [
      'src/modules/alpha:12',
      'src/modules/gamma:5',
      'src/modules/beta:4',
      'server/modules/core:3',
      'src/modules/delta:3',
    ],
  );

  // Added entities total 29 (12 + 5 + 4 + 3 + 3 + 1 + 1), so alpha holds 12/29.
  assert.equal(diff.totalAdded, 29);
  assert.equal(diff.growthTop5[0]!.additionsShare, 0.414);
  assert.equal(diff.growthTop5[3]!.additionsShare, 0.103);
  for (const row of diff.growthTop5) {
    assert.ok(row.additionsShare > 0 && row.additionsShare <= 1, `${row.package} share in (0, 1]`);
  }

  assert.equal(diff.hubPackage, 'server/modules/core', 'fan-in 3 names the central package');
  assert.equal(diff.hubAdditionsShare, 0.103);
  assert.equal(
    diff.growthReturnedToHubs,
    true,
    'the central package is among the top-five growers',
  );
});

test('AC1: a first reading is not a diff, and it states its caliber', () => {
  const diff = diffArchitectureStructures(null, currentSnapshot());

  assert.equal(diff.fromSnapshotId, null);
  assert.deepEqual(diff.addedCycles, []);
  assert.deepEqual(diff.removedCycles, []);
  assert.deepEqual(diff.newEdges, []);
  assert.equal(diff.deltaItems.length, 1);
  assert.match(diff.deltaItems[0]!, /^首次结构快照：/);
  assert.match(diff.deltaItems[0]!, /additionsShare/);
});

test('AC1: the producer writes the snapshot and diff, and throttles a second trigger for an hour', async () => {
  let reads = 0;
  const producer = createArchitectureDeltaProducer({
    store,
    now: () => clock,
    readStructure: async () => {
      reads += 1;
      return snapshotResult(currentSnapshot());
    },
  });
  const target = {
    projectId: CLOUD_PROJECT_ID,
    fleetProjectId: FLEET_PROJECT_ID,
    title: 'CloudCLI',
    sessionId: 'session-42',
  };

  const first = await producer.refreshProject(target);
  assert.equal(reads, 1);
  assert.ok(first !== null);
  assert.equal(first.uri, formatArchitectureUri(FLEET_PROJECT_ID));
  assert.equal(first.status.state, 'ok');
  const firstDigest = digestOf(first);
  assert.equal(firstDigest.snapshotId, 'snapshot-current');
  assert.equal(firstDigest.sizeCaliber, 'additionsShare');
  assert.equal(firstDigest.sessionId, 'session-42', 'the tab can be opened from the supplied session');
  assert.ok(Array.isArray(firstDigest.diffs) && firstDigest.diffs.length === 1);
  assert.match(String((firstDigest.diffs as string[])[0]), /^首次结构快照：/);
  assert.deepEqual(
    (firstDigest.snapshot as { id: string }).id,
    'snapshot-current',
    'the snapshot itself is persisted so the next run can diff against it',
  );

  // Inside the hour: the previous revision is the answer and NOTHING regenerates.
  clock = NOW + 10 * 60 * 1000;
  const throttled = await producer.refreshProject(target);
  assert.equal(reads, 1, 'a second trigger inside one hour must not call the snapshot reader');
  assert.equal(throttled?.revision, first.revision);

  // Past the hour: the reader runs again, against the stored snapshot.
  clock = NOW + ARCHITECTURE_DELTA_REFRESH_MS + 1;
  const refreshed = await producer.refreshProject(target);
  assert.equal(reads, 2);
  assert.ok(refreshed !== null);
  assert.ok(refreshed.revision > first.revision);
  const refreshedDigest = digestOf(refreshed);
  assert.deepEqual(
    refreshedDigest.diffs,
    refreshedDigest.deltaItems,
    'the tile preview reads the same sentences the revision appended',
  );
  assert.equal(
    (refreshedDigest.diff as { fromSnapshotId: string }).fromSnapshotId,
    'snapshot-current',
    'the refreshed diff is taken against the stored snapshot',
  );
});

test('AC1: a failed snapshot is unevaluated with its reason, never green', async () => {
  const producer = createArchitectureDeltaProducer({
    store,
    now: () => clock,
    readStructure: async () => {
      throw new Error('no .archguard/query/manifest.json');
    },
  });

  const object = await producer.refreshProject({
    projectId: CLOUD_PROJECT_ID,
    fleetProjectId: FLEET_PROJECT_ID,
  });
  assert.ok(object !== null);
  assert.equal(object.status.state, 'unevaluated');
  assert.match(object.status.reason ?? '', /结构快照生成失败：no \.archguard/);
  const digest = digestOf(object);
  assert.match(String((digest.diffs as string[])[0]), /结构快照生成失败：/);
  assert.equal(digest.error, object.status.reason);
  assert.equal(digest.diff, null);
});

test('AC1: a project without a fleet id is skipped', async () => {
  let reads = 0;
  const producer = createArchitectureDeltaProducer({
    store,
    now: () => clock,
    readStructure: async () => {
      reads += 1;
      return snapshotResult(currentSnapshot());
    },
  });

  const object = await producer.refreshProject({ projectId: CLOUD_PROJECT_ID, fleetProjectId: null });
  assert.equal(object, null);
  assert.equal(reads, 0);
});
