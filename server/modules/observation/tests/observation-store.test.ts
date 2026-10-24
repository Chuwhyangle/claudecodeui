/**
 * The observation store's two criteria (AC1, AC2).
 *
 * AC1: revisions are monotonic, the delta of revisions after the cursor is exactly the unseen
 * items, the cursor is a DATABASE row (a second SQLite connection reads the same value), and an
 * `unevaluated` status without a reason is refused.
 *
 * AC2: pinned objects are resident; unpinned `attention` / `red` objects surface automatically
 * and leave once their status recovers; past the 12-block cap the wall sorts red > attention >
 * ok by most recent revision and reports how many it folded.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/observation/tests/observation-store.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';

import { formatSessionUri, parseObservationUri } from '../observation-uri.js';
import { createObservationStore, DEFAULT_OBSERVATION_WALL_LIMIT } from '../observation-store.js';
import type { ObservedStatus } from '../observation-store.js';

const USER_ID = 'user-1';
const PRODUCER = 'session-digest';

let temporaryDirectory = '';
let databasePath = '';
let previousDatabasePath: string | undefined;
let clock = 1_000_000;

const store = createObservationStore({ now: () => clock });

test.before(async () => {
  previousDatabasePath = process.env.DATABASE_PATH;
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'observation-store-'));
  databasePath = path.join(temporaryDirectory, 'auth.db');
  closeConnection();
  process.env.DATABASE_PATH = databasePath;
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

/** Writes one session revision, advancing the fake clock first so timestamps order writes. */
function writeSession(
  id: string,
  status: ObservedStatus,
  deltaItems: string[] = [],
) {
  clock += 1_000;
  return store.writeRevision({
    uri: formatSessionUri(id),
    kind: 'session',
    title: `Session ${id}`,
    status,
    digest: { sessionId: id, turns: deltaItems.length },
    deltaItems,
    provenance: { producer: PRODUCER, tier: 'deterministic' },
  });
}

// ---------------------------------------------------------------------------
// AC1 — monotonic revisions, the cursor's delta, DB-backed cursor, unevaluated reason
// ---------------------------------------------------------------------------

test('AC1: revisions increase monotonically and each revision appends its delta items', () => {
  const first = writeSession('monotonic', { state: 'ok' }, ['created']);
  const second = writeSession('monotonic', { state: 'ok' }, ['新增 2 轮']);
  const third = writeSession('monotonic', { state: 'ok' }, ['落地 X']);

  assert.deepEqual([first.revision, second.revision, third.revision], [1, 2, 3]);
  assert.equal(store.getObject(formatSessionUri('monotonic'))?.revision, 3);
  assert.deepEqual(
    store.listRevisions(formatSessionUri('monotonic'), 0).map((revision) => revision.deltaItems),
    [['created'], ['新增 2 轮'], ['落地 X']],
  );
});

test('AC1: the wall shows exactly the delta items after the user cursor', () => {
  const uri = formatSessionUri('delta');
  writeSession('delta', { state: 'attention', reason: 'waiting' }, ['created']);
  writeSession('delta', { state: 'attention', reason: 'waiting' }, ['新增 2 轮']);
  writeSession('delta', { state: 'attention', reason: 'waiting' }, ['落地 X']);
  store.pin(USER_ID, uri);

  assert.deepEqual(store.getWall(USER_ID).entries[0]!.deltaItems, ['created', '新增 2 轮', '落地 X'], 'with no cursor every item is unseen');

  store.markSeen(USER_ID, uri, 1);
  assert.deepEqual(store.getWall(USER_ID).entries[0]!.deltaItems, ['新增 2 轮', '落地 X']);

  store.markSeen(USER_ID, uri, 3);
  assert.deepEqual(store.getWall(USER_ID).entries[0]!.deltaItems, [], 'advancing to the head clears the delta');
});

test('AC1: the seen cursor is a database row a different connection reads identically', () => {
  const uri = formatSessionUri('cursor-db');
  writeSession('cursor-db', { state: 'ok' }, []);
  writeSession('cursor-db', { state: 'ok' }, []);
  store.markSeen(USER_ID, uri, 2);

  const secondConnection = new Database(databasePath, { readonly: true });
  try {
    const row = secondConnection
      .prepare('SELECT user_id, uri, revision FROM observation_seen_cursors WHERE user_id = ? AND uri = ?')
      .get(USER_ID, uri) as { user_id: string; uri: string; revision: number } | undefined;
    assert.deepEqual(row, { user_id: USER_ID, uri, revision: 2 });
  } finally {
    secondConnection.close();
  }
});

test('AC1: an unevaluated status without a reason is rejected; with one it is stored', () => {
  assert.throws(
    () => writeSession('unevaluated', { state: 'unevaluated' }),
    /reason/,
    'an unevaluated reading with no reason must be refused — it would paint as a green reading nobody took',
  );
  assert.throws(() => writeSession('unevaluated', { state: 'unevaluated', reason: '   ' }), /reason/);

  const accepted = writeSession('unevaluated', { state: 'unevaluated', reason: 'transcript unreadable' });
  assert.deepEqual(accepted.status, { state: 'unevaluated', reason: 'transcript unreadable' });
  assert.deepEqual(store.getObject(formatSessionUri('unevaluated'))?.status, {
    state: 'unevaluated',
    reason: 'transcript unreadable',
  });
  assert.equal(parseObservationUri(accepted.uri)?.kind, 'session');
});

// ---------------------------------------------------------------------------
// AC2 — wall composition
// ---------------------------------------------------------------------------

test('AC2: a pinned object stays on the wall even while it reads ok', () => {
  const uri = formatSessionUri('pinned-ok');
  writeSession('pinned-ok', { state: 'ok' }, []);
  store.pin(USER_ID, uri);

  const wall = store.getWall(USER_ID);
  assert.equal(wall.entries.length, 1);
  assert.equal(wall.entries[0]!.object.uri, uri);
  assert.equal(wall.entries[0]!.pinned, true);
  assert.equal(wall.entries[0]!.object.status.state, 'ok');
});

test('AC2: an unpinned attention/red object surfaces, then leaves once its status recovers', () => {
  const uri = formatSessionUri('auto-surface');
  writeSession('auto-surface', { state: 'attention', reason: 'awaiting approval' }, ['needs a decision']);
  assert.deepEqual(store.getWall(USER_ID).entries.map((entry) => entry.object.uri), [uri]);

  // Advancing the cursor alone is not "handled": the object is still attention, so it stays.
  store.markSeen(USER_ID, uri, 1);
  assert.deepEqual(store.getWall(USER_ID).entries.map((entry) => entry.object.uri), [uri]);

  // Status recovery is what removes it from the automatic set.
  writeSession('auto-surface', { state: 'ok' }, []);
  assert.deepEqual(store.getWall(USER_ID).entries, [], 'a recovered unpinned object exits the wall');
});

test('AC2: unpinned ok objects never surface on their own', () => {
  writeSession('quiet-ok', { state: 'ok' }, []);
  assert.deepEqual(store.getWall(USER_ID).entries, []);
});

test('AC2: past the cap the wall sorts red > attention > ok by recent revision and returns the folded count', () => {
  assert.equal(DEFAULT_OBSERVATION_WALL_LIMIT, 12);

  const redUris: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    const id = `red-${index}`;
    writeSession(id, { state: 'red', reason: 'failed' }, []);
    redUris.push(formatSessionUri(id));
  }
  const attentionUris: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    const id = `attention-${index}`;
    writeSession(id, { state: 'attention', reason: 'waiting' }, []);
    attentionUris.push(formatSessionUri(id));
  }
  // An ok object must not consume a slot even when the wall is over the cap.
  writeSession('quiet-ok-over-cap', { state: 'ok' }, []);

  const wall = store.getWall(USER_ID);
  assert.equal(wall.entries.length, DEFAULT_OBSERVATION_WALL_LIMIT);
  assert.equal(wall.collapsedCount, 1, '5 red + 8 attention = 13 surfaced, 12 shown, 1 folded');
  assert.deepEqual(
    wall.entries.slice(0, 5).map((entry) => entry.object.uri),
    [...redUris].reverse(),
    'red outranks attention; within the rank the most recently revised object is first',
  );
  assert.ok(
    wall.entries.every((entry) => entry.object.status.state !== 'ok'),
    'an ok object never displaces a surfaced attention/red object',
  );

  // "× most recent revision": the folded object is the OLDEST attention one (lowest revision,
  // then oldest write), which is the last entry of the attention group by the wall's ordering.
  const shownUris = new Set(wall.entries.map((entry) => entry.object.uri));
  const folded = attentionUris.filter((uri) => !shownUris.has(uri));
  assert.deepEqual(folded, [attentionUris[0]], 'the oldest attention object is the one folded');
  assert.equal(
    wall.entries.at(-1)!.object.uri,
    attentionUris[1],
    'attention entries are newest-first, so the last SHOWN one is the second-oldest',
  );
});
