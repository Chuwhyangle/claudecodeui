/**
 * AC6 — the observation layer's own liveness.
 *
 * A quiet wall must not look healthy because nothing is on it. Every producer registers its
 * expected cadence, and this criterion drives the pure reading with a fake clock:
 *
 *   · an attempt inside 2 × cadence                    → `ok`
 *   · nothing for more than 2 × cadence                → stale (`attention`)
 *   · the latest attempt carried an error              → `red`
 *   · registered but never attempted                   → `unevaluated`
 *   · any producer not `ok`                            → the wall carries 「观察层自身」
 *
 * The last reading also proves the self entry is OUTSIDE the 12-block cap: the wall is filled
 * with surfaced objects and the self entry is still there while the object count stays capped.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/observation/tests/producer-liveness.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';

import { formatSessionUri } from '../observation-uri.js';
import { createObservationStore, DEFAULT_OBSERVATION_WALL_LIMIT } from '../observation-store.js';
import { PRODUCER_STALE_MULTIPLIER } from '../producer-liveness.js';

const USER_ID = 'liveness-user';
const CADENCE_MS = 60_000;

let temporaryDirectory = '';
let previousDatabasePath: string | undefined;
let clock = 5_000_000;

const store = createObservationStore({ now: () => clock });

test.before(async () => {
  previousDatabasePath = process.env.DATABASE_PATH;
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'observation-liveness-'));
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
  db.exec('DELETE FROM observed_revisions');
  db.exec('DELETE FROM observed_objects');
  db.exec('DELETE FROM observation_seen_cursors');
  db.exec('DELETE FROM observation_watch_entries');
  db.exec('DELETE FROM observation_producer_heartbeats');
  clock = 5_000_000;
});

function writeAttention(id: string) {
  clock += 1_000;
  return store.writeRevision({
    uri: formatSessionUri(id),
    kind: 'session',
    title: `Session ${id}`,
    status: { state: 'attention', reason: 'waiting' },
    digest: {},
    deltaItems: [],
    provenance: { producer: 'session-digest', tier: 'deterministic' },
  });
}

test('AC6: a producer that attempted inside its cadence reads ok, and the wall has no self entry', () => {
  store.registerProducer('session-digest', CADENCE_MS);
  store.recordProducerAttempt('session-digest');

  const wall = store.getWall(USER_ID);
  assert.equal(wall.producers.length, 1);
  assert.equal(wall.producers[0]!.producer, 'session-digest');
  assert.equal(wall.producers[0]!.state, 'ok');
  assert.equal(wall.producers[0]!.stale, false);
  assert.equal(wall.producers[0]!.reason, null);
  assert.equal(wall.self, null, 'every producer is ok — the layer has nothing to admit');
});

test('AC6: silence past 2 × expectedIntervalMs reads stale, and the wall admits it', () => {
  store.registerProducer('session-digest', CADENCE_MS);
  store.recordProducerAttempt('session-digest');
  clock += PRODUCER_STALE_MULTIPLIER * CADENCE_MS + 1;

  const wall = store.getWall(USER_ID);
  const reading = wall.producers.find((producer) => producer.producer === 'session-digest')!;
  assert.equal(reading.stale, true);
  assert.equal(reading.state, 'attention');
  assert.match(reading.reason ?? '', /no attempt for/);

  assert.notEqual(wall.self, null);
  assert.equal(wall.self!.title, '观察层自身');
  assert.equal(wall.self!.state, 'attention');
  assert.match(wall.self!.reason, /session-digest/);
});

test('AC6: the most recent attempt carrying an error reads red', () => {
  store.registerProducer('session-digest', CADENCE_MS);
  store.recordProducerAttempt('session-digest');
  store.recordProducerAttempt('session-digest', 'transcript read failed');

  const reading = store.getWall(USER_ID).producers[0]!;
  assert.equal(reading.state, 'red');
  assert.equal(reading.reason, 'transcript read failed');

  // A later successful attempt clears the error, so red is "the LAST attempt failed", not
  // "this producer ever failed".
  store.recordProducerAttempt('session-digest');
  assert.equal(store.getWall(USER_ID).producers[0]!.state, 'ok');
});

test('AC6: a registered producer that never ran reads unevaluated with a reason', () => {
  store.registerProducer('project-truth', 30_000);

  const reading = store.getWall(USER_ID).producers[0]!;
  assert.equal(reading.producer, 'project-truth');
  assert.equal(reading.state, 'unevaluated');
  assert.notEqual(reading.reason, null);
  assert.equal(store.getWall(USER_ID).self?.title, '观察层自身');
});

test('AC6: the self entry is never folded by the 12-block cap', () => {
  store.registerProducer('session-digest', CADENCE_MS); // never attempted => unevaluated => self

  // Fill the wall well past its cap with automatically surfaced objects.
  for (let index = 0; index < DEFAULT_OBSERVATION_WALL_LIMIT + 3; index += 1) {
    writeAttention(`cap-${index}`);
  }

  const wall = store.getWall(USER_ID);
  assert.equal(wall.entries.length, DEFAULT_OBSERVATION_WALL_LIMIT, 'the object list stays capped');
  assert.equal(wall.collapsedCount, 3, 'the overflow is reported, not silently dropped');
  assert.equal(wall.self?.title, '观察层自身', 'the layer-level entry survives a full wall');
  assert.equal(wall.self?.state, 'attention');
});
