import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  CURATION_LIMITS,
  CURATION_STORAGE_PREFIX,
  CURATION_UNDO_DEPTH,
  createCurationStore,
  curationStorageKey,
  emptyCurationState,
  parseCurationState,
  readCurationState,
  type ArchitectureCurationItem,
  type CurationStorageLike,
} from '@/modules/architecture/curationStore';

/**
 * The manual-curation store (pins / removals / hidden relations).
 *
 * The storage seam is a plain in-memory map, so every reading here is about the
 * store's own rules — mutual exclusion, the undo depth, the caps, session
 * scoping, corrupt-document fallback and `(file, name)` re-anchoring — not
 * about the browser's `localStorage`.
 */
function memoryStorage(): CurationStorageLike & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

function item(id: string, name = id, file = `${id}.ts`): ArchitectureCurationItem {
  return { id, name, file };
}

function storeFor(
  storage: CurationStorageLike,
  projectId: string | null = 'project-1',
  sessionId: string | null = 'session-1',
) {
  return createCurationStore({ storage, projectId, sessionId });
}

test('存储键按 <projectId>:<sessionId> 隔离，换会话不串', () => {
  const storage = memoryStorage();
  assert.equal(
    curationStorageKey('project-1', 'session-1'),
    `${CURATION_STORAGE_PREFIX}:project-1:session-1`,
  );
  assert.equal(curationStorageKey('project-1', null), null, 'no session ⇒ no key');
  assert.deepEqual(emptyCurationState(), { pins: [], excluded: [], hiddenEdges: [] });

  const first = storeFor(storage);
  assert.equal(first.pin(item('A')).ok, true, 'a session-scoped store can write');
  assert.deepEqual(storeFor(storage, 'project-1', 'session-2').getState(), emptyCurationState());
  assert.deepEqual(storeFor(storage, 'project-2', 'session-1').getState(), emptyCurationState());
});

test('钉住与移除互斥，后做的覆盖先做的', () => {
  const storage = memoryStorage();
  const store = storeFor(storage);

  assert.equal(store.pin(item('A', 'Alpha', 'a.ts')).ok, true);
  assert.deepEqual(store.getState().pins.map((entry) => entry.id), ['A']);

  // Removal after pin: the pin is gone, the removal holds.
  assert.equal(store.exclude(item('A', 'Alpha', 'a.ts')).ok, true);
  assert.deepEqual(store.getState().pins, [], 'a removal supersedes an earlier pin');
  assert.deepEqual(store.getState().excluded.map((entry) => entry.id), ['A']);

  // Pin after removal: the removal is gone, the pin holds.
  assert.equal(store.pin(item('A', 'Alpha', 'a.ts')).ok, true);
  assert.deepEqual(store.getState().excluded, [], 'a pin supersedes an earlier removal');
  assert.deepEqual(store.getState().pins.map((entry) => entry.id), ['A']);

  // Pinning twice is idempotent, not a duplicate.
  store.pin(item('A', 'Alpha', 'a.ts'));
  assert.equal(store.getState().pins.length, 1);

  // Restore removes a removal; unpin removes a pin.
  store.unpin('A');
  assert.deepEqual(store.getState().pins, []);
  store.exclude(item('B'));
  store.restore('B');
  assert.deepEqual(store.getState().excluded, []);
});

test('撤销栈深 20：最近一次先回滚，超过深度后最早的调整不可再撤销', () => {
  const storage = memoryStorage();
  const store = storeFor(storage);

  // One ordered leg: A, B, C then two undos give B's absence back, then A's.
  store.pin(item('A'));
  store.pin(item('B'));
  store.pin(item('C'));
  assert.equal(store.canUndo(), true);
  store.undo();
  assert.deepEqual(store.getState().pins.map((entry) => entry.id), ['A', 'B'], 'undo reverts the LAST adjustment');
  store.undo();
  assert.deepEqual(store.getState().pins.map((entry) => entry.id), ['A']);

  // Depth leg: 25 distinct pins keep only the last 20 states.
  const deep = storeFor(memoryStorage());
  for (let index = 0; index < 25; index += 1) deep.pin(item(`p${index}`));
  let undos = 0;
  while (deep.canUndo()) {
    deep.undo();
    undos += 1;
  }
  assert.equal(undos, CURATION_UNDO_DEPTH, 'the undo stack holds exactly 20 states');
  assert.equal(deep.getState().pins.length, 5, 'the five adjustments older than the stack survive');
  assert.equal(deep.getState().pins[0]?.id, 'p0');
});

test('上限与超出提示：钉住 200、移除 500、隐藏关系 500', () => {
  const storage = memoryStorage();
  const store = storeFor(storage);

  for (let index = 0; index < CURATION_LIMITS.pins; index += 1) {
    assert.equal(store.pin(item(`pin-${index}`)).ok, true);
  }
  const overPin = store.pin(item('pin-over'));
  assert.equal(overPin.ok, false);
  if (!overPin.ok) {
    assert.equal(overPin.code, 'LIMIT_REACHED');
    assert.equal(overPin.limit, CURATION_LIMITS.pins);
  }
  assert.equal(store.getState().pins.length, CURATION_LIMITS.pins, 'the refused pin did not enter the list');

  const excludedStore = storeFor(memoryStorage());
  for (let index = 0; index < CURATION_LIMITS.excluded; index += 1) {
    assert.equal(excludedStore.exclude(item(`ex-${index}`)).ok, true);
  }
  const overExcluded = excludedStore.exclude(item('ex-over'));
  assert.equal(overExcluded.ok, false);

  const edgeStore = storeFor(memoryStorage());
  for (let index = 0; index < CURATION_LIMITS.hiddenEdges; index += 1) {
    assert.equal(edgeStore.hideEdge({ from: `from-${index}`, to: `to-${index}`, type: 'dependency' }).ok, true);
  }
  assert.equal(edgeStore.hideEdge({ from: 'x', to: 'y', type: 'call' }).ok, false);
});

test('没有 sessionId 时拒绝写入并说明原因', () => {
  const storage = memoryStorage();
  const store = createCurationStore({ storage, projectId: 'project-1', sessionId: null });
  assert.equal(store.canEdit, false);
  const result = store.pin(item('A'));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'NO_SESSION');
  assert.equal(storage.map.size, 0, 'a disabled store never touches storage');
  assert.deepEqual(store.getState(), emptyCurationState());
});

test('读到损坏的 JSON 时回落为空并不抛错', () => {
  const storage = memoryStorage();
  const key = curationStorageKey('project-1', 'session-1');
  if (key === null) throw new Error('the fixture key must exist');

  for (const corrupted of ['{not json', '[]', 'null', '{"pins":"nope"}', '{"pins":[{"id":""}]}']) {
    storage.map.set(key, corrupted);
    assert.deepEqual(readCurationState(storage, 'project-1', 'session-1'), emptyCurationState());
  }
  // A half-valid document keeps the well-formed entries and drops the rest.
  storage.map.set(
    key,
    JSON.stringify({
      pins: [{ id: 'A', name: 'Alpha', file: 'a.ts' }, { id: '' }],
      excluded: 'nope',
      hiddenEdges: [{ from: 'A', to: 'B', type: 'call' }],
    }),
  );
  const parsed = parseCurationState(storage.getItem(key));
  assert.deepEqual(parsed.pins.map((entry) => entry.id), ['A']);
  assert.deepEqual(parsed.excluded, []);
  assert.deepEqual(parsed.hiddenEdges, [{ from: 'A', to: 'B', type: 'call' }]);
});

test('(file, name) 重新对应：失效项更新为新 id，仍找不到的保持已失效', () => {
  const storage = memoryStorage();
  const store = storeFor(storage);
  store.pin({ id: 'old-alpha', name: 'Alpha', file: 'src/alpha.ts' });
  store.exclude({ id: 'old-gone', name: 'Gone', file: 'src/gone.ts' });

  store.reconcile([
    { name: 'Alpha', file: 'src/alpha.ts', id: 'new-alpha' },
    { name: 'Gone', file: 'src/gone.ts', id: null },
  ]);

  const alpha = store.getState().pins[0];
  assert.equal(alpha?.id, 'new-alpha', 'the pin is re-anchored onto the current id');
  assert.equal(alpha?.stale, undefined, 'a resolved item is not stale');
  const gone = store.getState().excluded[0];
  assert.equal(gone?.id, 'old-gone', 'an unresolved item keeps its stored id for the reader to clear');
  assert.equal(gone?.stale, true, 'an unresolved item is marked stale, never dropped');

  // A later analysis that DOES contain it clears the stale mark.
  store.reconcile([{ name: 'Gone', file: 'src/gone.ts', id: 'new-gone' }]);
  assert.equal(store.getState().excluded[0]?.id, 'new-gone');
  assert.equal(store.getState().excluded[0]?.stale, undefined);

  // The reader can clear a stale row explicitly.
  store.reconcile([{ name: 'Gone', file: 'src/other.ts', id: null }]);
  assert.equal(store.getState().excluded[0]?.stale, true);
  store.clearItem('excluded', 'new-gone');
  assert.deepEqual(store.getState().excluded, []);
});

test('调整按会话持久化，新建 store 能读回', () => {
  const storage = memoryStorage();
  const first = storeFor(storage);
  first.pin(item('A', 'Alpha', 'a.ts'));
  first.exclude(item('B', 'Beta', 'b.ts'));
  first.hideEdge({ from: 'A', to: 'B', type: 'call' });

  const second = storeFor(storage);
  assert.deepEqual(second.getState().pins.map((entry) => entry.id), ['A']);
  assert.deepEqual(second.getState().excluded.map((entry) => entry.id), ['B']);
  assert.deepEqual(second.getState().hiddenEdges, [{ from: 'A', to: 'B', type: 'call' }]);

  // A different session shares nothing.
  const otherSession = storeFor(storage, 'project-1', 'session-2');
  assert.deepEqual(otherSession.getState(), emptyCurationState());
  // A different project likewise.
  const otherProject = storeFor(storage, 'project-2', 'session-1');
  assert.deepEqual(otherProject.getState(), emptyCurationState());
});

test('隐藏关系只改显示列表：可还原、可全部还原', () => {
  const storage = memoryStorage();
  const store = storeFor(storage);
  const edge = { from: 'A', to: 'B', type: 'dependency' };
  store.hideEdge(edge);
  store.hideEdge(edge);
  assert.equal(store.getState().hiddenEdges.length, 1, 'the same edge is hidden once');
  store.showEdge(edge);
  assert.deepEqual(store.getState().hiddenEdges, []);

  store.pin(item('A'));
  store.exclude(item('B'));
  store.hideEdge(edge);
  store.restoreAll();
  assert.deepEqual(store.getState(), emptyCurationState());
  store.undo();
  assert.equal(store.getState().pins.length + store.getState().excluded.length + store.getState().hiddenEdges.length, 3);
});
