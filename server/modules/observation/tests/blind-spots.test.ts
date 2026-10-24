/**
 * The observation wall's blind-spot declaration (AC1).
 *
 * Every observed object is a projection, so every object must say what it drops. This criterion
 * proves four things against a real store over a throwaway SQLite database:
 *
 *   - a write that supplies no declaration gets the kind's defaults, and they are non-empty for
 *     all four readings (session/deterministic, session/llm, project, architecture);
 *   - a producer's appended declarations are merged with the defaults, not substituted for them,
 *     and an exact repeat — of a default or of the producer's own sentence — appears once;
 *   - a session written at `tier: 'llm'` carries the LLM-specific declarations in addition to the
 *     deterministic ones;
 *   - the wall returns a non-empty declaration for every entry, and the layer's own reading
 *     carries its heartbeat caveat.
 *
 * The merged list is persisted in the digest's reserved key, so `getObject` through a SECOND
 * store instance (no shared memory) is the reading that proves it survived the write.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/observation/tests/blind-spots.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';

import {
  BLIND_SPOTS_DIGEST_KEY,
  OBSERVATION_LAYER_BLIND_SPOTS,
  defaultBlindSpots,
} from '../blind-spots.js';
import {
  formatArchitectureUri,
  formatProjectUri,
  formatSessionUri,
} from '../observation-uri.js';
import { createObservationStore } from '../observation-store.js';
import type { ObservedStatus, WriteObservationInput } from '../observation-store.js';

const USER_ID = 'user-1';
const PRODUCER = 'blind-spots-criterion';

let temporaryDirectory = '';
let previousDatabasePath: string | undefined;
let clock = 1_000_000;

const store = createObservationStore({ now: () => clock });

test.before(async () => {
  previousDatabasePath = process.env.DATABASE_PATH;
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'observation-blind-spots-'));
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
  const db = getConnection();
  // Children first: the revision log has a foreign key back onto the object row.
  db.exec('DELETE FROM observed_revisions');
  db.exec('DELETE FROM observed_objects');
  db.exec('DELETE FROM observation_seen_cursors');
  db.exec('DELETE FROM observation_watch_entries');
  db.exec('DELETE FROM observation_producer_heartbeats');
  clock = 1_000_000;
});

/** One write with the fields every case varies; `at` advances so revisions order deterministically. */
function write(input: Omit<WriteObservationInput, 'provenance'> & {
  producer?: string;
  tier?: 'deterministic' | 'llm';
}): ReturnType<typeof store.writeRevision> {
  clock += 1_000;
  const { producer = PRODUCER, tier = 'deterministic', ...rest } = input;
  return store.writeRevision({
    ...rest,
    provenance: { producer, tier, evaluatedAt: clock },
  });
}

function writeSession(
  id: string,
  status: ObservedStatus,
  extra: { blindSpots?: string[]; tier?: 'deterministic' | 'llm' } = {},
) {
  return write({
    uri: formatSessionUri(id),
    kind: 'session',
    title: `Session ${id}`,
    status,
    digest: { sessionId: id },
    ...(extra.blindSpots === undefined ? {} : { blindSpots: extra.blindSpots }),
    ...(extra.tier === undefined ? {} : { tier: extra.tier }),
  });
}

// ---------------------------------------------------------------------------
// Four readings, four default declarations
// ---------------------------------------------------------------------------

test('AC1: each kind written without blindSpots carries its non-empty defaults', () => {
  const cases: Array<{
    label: string;
    uri: string;
    kind: 'session' | 'project' | 'architecture';
    tier: 'deterministic' | 'llm';
    /** A phrase that only this kind's (or tier's) declaration carries. */
    distinctive: string;
  }> = [
    {
      label: 'session / deterministic',
      uri: formatSessionUri('default-session'),
      kind: 'session',
      tier: 'deterministic',
      distinctive: '偏离意图',
    },
    {
      label: 'session / llm',
      uri: formatSessionUri('default-session-llm'),
      kind: 'session',
      tier: 'llm',
      distinctive: '编造',
    },
    {
      label: 'project',
      uri: formatProjectUri('default-project'),
      kind: 'project',
      tier: 'deterministic',
      distinctive: 'quay-fleet',
    },
    {
      label: 'architecture',
      uri: formatArchitectureUri('default-architecture'),
      kind: 'architecture',
      tier: 'deterministic',
      distinctive: '动态 import',
    },
  ];

  for (const testCase of cases) {
    const object = write({
      uri: testCase.uri,
      kind: testCase.kind,
      title: testCase.label,
      status: { state: 'attention', reason: 'written for the criterion' },
      tier: testCase.tier,
    });

    assert.ok(object.blindSpots.length > 0, `${testCase.label}: the declaration must not be empty`);
    assert.ok(
      object.blindSpots.some((spot) => spot.includes(testCase.distinctive)),
      `${testCase.label}: expected a declaration mentioning “${testCase.distinctive}”, got ${JSON.stringify(object.blindSpots)}`,
    );
    assert.deepEqual(
      object.blindSpots,
      defaultBlindSpots(testCase.kind, testCase.tier),
      `${testCase.label}: the object carries exactly its kind's defaults`,
    );
  }
});

test('AC1: a producer-appended declaration is merged with the defaults and de-duplicated', () => {
  const defaults = defaultBlindSpots('session', 'deterministic');
  const repeatedDefault = defaults[0]!;
  const appended = ['看不见网络延迟', repeatedDefault, '看不见网络延迟'];

  const object = writeSession('merge', { state: 'attention', reason: 'merge' }, { blindSpots: appended });

  assert.deepEqual(
    object.blindSpots,
    [...defaults, '看不见网络延迟'],
    'defaults first, then the producer tail; exact repeats appear once',
  );
  assert.equal(
    object.blindSpots.filter((spot) => spot === repeatedDefault).length,
    1,
    'a producer repeating a default does not draw it twice',
  );
  assert.equal(
    object.blindSpots.filter((spot) => spot === '看不见网络延迟').length,
    1,
    'a producer repeating its own sentence does not draw it twice',
  );

  // The merged list survives the write: a second store instance reads the same database row.
  const fromSecondStore = createObservationStore({ now: () => clock }).getObject(object.uri);
  assert.deepEqual(fromSecondStore?.blindSpots, object.blindSpots);

  // The reserved digest key is storage, not the producer's document.
  assert.equal(
    BLIND_SPOTS_DIGEST_KEY in (fromSecondStore?.digest ?? {}),
    false,
    'the declaration must not leak into the digest the wall returns',
  );
  assert.deepEqual(fromSecondStore?.digest, { sessionId: 'merge' });
});

test('AC1: a tier=llm session carries the LLM declarations in addition to the deterministic ones', () => {
  const deterministic = writeSession('tier-det', { state: 'attention', reason: 'x' });
  const llm = writeSession('tier-llm', { state: 'attention', reason: 'x' }, { tier: 'llm' });

  const missing = deterministic.blindSpots.filter((spot) => !llm.blindSpots.includes(spot));
  assert.deepEqual(missing, [], 'every deterministic session declaration is still present for an LLM reading');
  assert.ok(
    llm.blindSpots.length > deterministic.blindSpots.length,
    'the LLM reading adds declarations rather than replacing them',
  );
  assert.ok(llm.blindSpots.some((spot) => spot.includes('编造')));
  assert.ok(llm.blindSpots.some((spot) => spot.includes('仅作建议')));
});

test('AC1: a non-array blindSpots field is refused instead of silently coerced', () => {
  assert.throws(
    () =>
      store.writeRevision({
        uri: formatSessionUri('invalid'),
        kind: 'session',
        title: 'invalid',
        status: { state: 'ok' },
        // The cast models a JSON producer that sent the wrong shape.
        blindSpots: [1, 2] as unknown as string[],
        provenance: { producer: PRODUCER, tier: 'deterministic' },
      }),
    /blindSpots/,
  );
});

// ---------------------------------------------------------------------------
// The wall
// ---------------------------------------------------------------------------

test('AC1: every object on the wall carries a non-empty declaration, and the layer declares itself', () => {
  writeSession('wall-session', { state: 'attention', reason: 'waiting' }, {
    blindSpots: ['看不见未落入 transcript 的副作用'],
  });
  write({
    uri: formatProjectUri('wall-project'),
    kind: 'project',
    title: 'wall project',
    status: { state: 'red', reason: 'driver crashed' },
  });
  write({
    uri: formatArchitectureUri('wall-architecture'),
    kind: 'architecture',
    title: 'wall architecture',
    status: { state: 'attention', reason: 'graph drifted' },
  });
  // A registered producer that never ran makes the layer's own reading present.
  store.registerProducer('session-digest', 60_000);

  const wall = store.getWall(USER_ID);
  assert.equal(wall.entries.length, 3, 'the three loud objects surface on the wall');
  for (const entry of wall.entries) {
    assert.ok(
      entry.object.blindSpots.length > 0,
      `${entry.object.uri}: every wall object must declare what it cannot see`,
    );
    for (const spot of entry.object.blindSpots) {
      assert.ok(spot.trim().length > 0, `${entry.object.uri}: declarations are non-empty short sentences`);
    }
  }

  assert.ok(wall.self !== null, 'a producer that never ran makes the layer read as not-ok');
  assert.ok(wall.self.blindSpots.length > 0);
  assert.deepEqual(wall.self.blindSpots, [...OBSERVATION_LAYER_BLIND_SPOTS]);
  assert.ok(
    wall.self.blindSpots.some((spot) => spot.includes('不证明读数正确')),
    'the layer says a heartbeat is not a correctness reading',
  );
  assert.equal(
    wall.self.blindSpots.includes('看不见会话是否偏离意图'),
    false,
    'the layer does not borrow an object kind\'s declaration',
  );
});
