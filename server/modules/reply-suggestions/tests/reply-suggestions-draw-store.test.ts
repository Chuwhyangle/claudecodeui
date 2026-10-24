/**
 * Reply-suggestions draw-store criterion.
 *
 * The store is a plain in-memory unit: every leg builds one, drives the same
 * operations the service uses, and reads the observable results. The 200-key
 * bound, the message-id reset, the batch cache, the coalescing map and the copy
 * discipline are each pinned separately.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/reply-suggestions/tests/reply-suggestions-draw-store.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDrawStore,
  REPLY_SUGGESTIONS_DRAW_STORE_SIZE,
} from '../reply-suggestions-draw-store.js';

test('(a) one message: recordDraw advances draw and appends the shown chips', () => {
  const store = createDrawStore();
  assert.deepEqual(store.shownChips('s-1', 'm-1'), [], 'nothing is shown before the first draw');

  assert.equal(store.recordDraw('s-1', 'm-1', ['a', 'b']), 1);
  assert.deepEqual(store.shownChips('s-1', 'm-1'), ['a', 'b']);

  assert.equal(store.recordDraw('s-1', 'm-1', ['c']), 2);
  assert.deepEqual(store.shownChips('s-1', 'm-1'), ['a', 'b', 'c']);
});

test('(b) a new assistant message id resets draw, shown chips and the cached batch', () => {
  const store = createDrawStore();
  store.recordDraw('s-2', 'm-1', ['a', 'b']);
  store.recordBatch('s-2', 'm-1', 'v1', ['a', 'b'], 1);
  assert.deepEqual(store.readBatch('s-2', 'm-1', 'v1'), { chips: ['a', 'b'], draw: 1 });

  assert.deepEqual(store.shownChips('s-2', 'm-2'), [], 'a new message has nothing shown');
  assert.equal(store.readBatch('s-2', 'm-2', 'v1'), undefined, 'the old batch is not reachable from the new message');
  assert.equal(store.recordDraw('s-2', 'm-2', ['x']), 1, 'the draw counter restarts at 1');
  assert.deepEqual(store.shownChips('s-2', 'm-2'), ['x']);
});

test('(c) the current batch is read back, replaced, and forgotten', () => {
  const store = createDrawStore();
  store.recordDraw('s-3', 'm-1', ['shown-once']);
  store.recordBatch('s-3', 'm-1', 'v1', ['first-a', 'first-b'], 1);
  assert.deepEqual(store.readBatch('s-3', 'm-1', 'v1'), { chips: ['first-a', 'first-b'], draw: 1 });

  // A different settings version is a different cache key.
  assert.equal(store.readBatch('s-3', 'm-1', 'v2'), undefined);

  store.recordBatch('s-3', 'm-1', 'v1', ['second-a'], 2);
  assert.deepEqual(store.readBatch('s-3', 'm-1', 'v1'), { chips: ['second-a'], draw: 2 });

  store.forgetBatch('s-3', 'm-1', 'v1');
  assert.equal(store.readBatch('s-3', 'm-1', 'v1'), undefined, 'a forgotten batch is a miss');
  // Forgetting one key must not erase the session's draw state.
  assert.deepEqual(store.shownChips('s-3', 'm-1'), ['shown-once']);
});

test('(d) the store keeps 200 sessions, evicts the least-recently-used, and has no time expiry', () => {
  assert.equal(REPLY_SUGGESTIONS_DRAW_STORE_SIZE, 200);
  const store = createDrawStore();

  for (let index = 0; index < REPLY_SUGGESTIONS_DRAW_STORE_SIZE; index += 1) {
    store.recordDraw(`session-${index}`, 'm-1', [`chip-${index}`]);
  }
  // Touch the oldest session so it is the MOST recently used before the bound
  // is crossed; the second-oldest is then the one to go.
  assert.deepEqual(store.shownChips('session-0', 'm-1'), ['chip-0']);
  store.recordDraw('session-overflow', 'm-1', ['overflow']);

  assert.deepEqual(store.shownChips('session-0', 'm-1'), ['chip-0'], 'the touched session survived');
  assert.deepEqual(store.shownChips('session-1', 'm-1'), [], 'the second-oldest session was evicted');
  assert.deepEqual(store.shownChips('session-overflow', 'm-1'), ['overflow']);
  // There is no clock in the store at all, so no record can expire by time:
  // only the LRU bound removes one.
  assert.deepEqual(store.shownChips(`session-${REPLY_SUGGESTIONS_DRAW_STORE_SIZE - 1}`, 'm-1'),
    [`chip-${REPLY_SUGGESTIONS_DRAW_STORE_SIZE - 1}`]);
});

test('(e) identical concurrent requests coalesce into one task', async () => {
  const store = createDrawStore();
  let runs = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const task = async (): Promise<string> => {
    runs += 1;
    await gate;
    return 'shared';
  };

  const first = store.coalesce('key-1', task);
  const second = store.coalesce('key-1', task);
  await new Promise((resolve) => setImmediate(resolve));
  release?.();
  assert.deepEqual(await Promise.all([first, second]), ['shared', 'shared']);
  assert.equal(runs, 1, 'the same key ran its task once');

  // Once settled, the key is free again and a later call runs afresh.
  assert.equal(await store.coalesce('key-1', task), 'shared');
  assert.equal(runs, 2);
  // A different key never shares.
  const [left, right] = await Promise.all([
    store.coalesce('key-a', async () => 'a'),
    store.coalesce('key-b', async () => 'b'),
  ]);
  assert.deepEqual([left, right], ['a', 'b']);
});

test('(f) arrays crossing the store boundary are copies', () => {
  const store = createDrawStore();
  const incoming = ['one', 'two'];
  store.recordDraw('s-6', 'm-1', incoming);
  incoming.push('three');
  assert.deepEqual(store.shownChips('s-6', 'm-1'), ['one', 'two'], 'recordDraw copied the input');

  const shownReturned = store.shownChips('s-6', 'm-1');
  shownReturned.push('mutated');
  assert.deepEqual(store.shownChips('s-6', 'm-1'), ['one', 'two'], 'shownChips returned a copy');

  store.recordBatch('s-6', 'm-1', 'v1', ['cached-a'], 1);
  const batch = store.readBatch('s-6', 'm-1', 'v1');
  assert.ok(batch !== undefined);
  batch.chips.push('mutated');
  assert.deepEqual(store.readBatch('s-6', 'm-1', 'v1'), { chips: ['cached-a'], draw: 1 }, 'readBatch returned a copy');
});
