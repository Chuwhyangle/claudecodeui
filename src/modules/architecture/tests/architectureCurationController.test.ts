/**
 * `createArchitectureCurationController` — the architecture tab's curation
 * rules, exercised without React, `localStorage` or a wall clock.
 *
 * What the criterion names:
 * - pin / remove / hide-relation followed by Undo;
 * - re-anchoring marks what the new analysis no longer contains as stale, and a
 *   failed resolve is retried on the next load instead of marking it stale;
 * - the Toast disappears after its window, a pause holds it, and `dispose`
 *   releases the timer;
 * - another tab's write is adopted by rebuilding the store.
 */
import assert from 'node:assert/strict';

import { describe, it, vi } from 'vitest';

import {
  createArchitectureCurationController,
  CURATION_TOAST_MS,
} from '@/modules/architecture/render/architectureCurationController';
import {
  curationStorageKey,
  type ArchitectureCurationItem,
  type CurationStorageLike,
} from '@/modules/architecture/dom/interaction/curationStore';
import type { Clock } from '@/shared/types';

type Timer = {
  handle: number;
  callback: () => void;
  due: number;
};

/**
 * A deterministic clock: timers fire only when `advance` moves past them, and
 * `pending()` reports how many are still armed (what `dispose` must clear).
 */
function createFakeClock(): {
  clock: Clock;
  advance: (milliseconds: number) => Promise<void>;
  pending: () => number;
} {
  let now = 1_000_000;
  let nextHandle = 1;
  const timers = new Map<number, Timer>();

  const clock: Clock = {
    now: () => now,
    setTimeout: (callback, milliseconds) => {
      const handle = nextHandle;
      nextHandle += 1;
      timers.set(handle, { handle, callback, due: now + milliseconds });
      return handle;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    setInterval: () => {
      throw new Error('the curation controller must not need an interval');
    },
    clearInterval: () => {},
  };

  const flush = async (): Promise<void> => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  };

  const advance = async (milliseconds: number): Promise<void> => {
    const target = now + milliseconds;
    for (;;) {
      let next: Timer | undefined;
      for (const timer of timers.values()) {
        if (timer.due <= target && (next === undefined || timer.due < next.due)) next = timer;
      }
      if (next === undefined) break;
      now = next.due;
      timers.delete(next.handle);
      next.callback();
      await flush();
    }
    now = target;
    await flush();
  };

  return { clock, advance, pending: () => timers.size };
}

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

function controllerFor(
  storage: CurationStorageLike,
  options: {
    projectId?: string | null;
    sessionId?: string | null;
    clock?: Clock;
    resolveItems?: Parameters<typeof createArchitectureCurationController>[0]['resolveItems'];
    toastDurationMs?: number;
  } = {},
) {
  return createArchitectureCurationController({
    storage,
    projectId: options.projectId === undefined ? 'project-1' : options.projectId,
    sessionId: options.sessionId === undefined ? 'session-1' : options.sessionId,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.resolveItems === undefined ? {} : { resolveItems: options.resolveItems }),
    ...(options.toastDurationMs === undefined ? {} : { toastDurationMs: options.toastDurationMs }),
  });
}

describe('createArchitectureCurationController', () => {
  it('pins, removes and hides a relation, and Undo steps back through each', () => {
    const storage = memoryStorage();
    const controller = controllerFor(storage);
    assert.equal(controller.getSnapshot().canEdit, true);

    assert.equal(controller.pin(item('A')).ok, true);
    assert.equal(controller.getSnapshot().state.pins.length, 1);
    assert.equal(controller.getSnapshot().canUndo, true);

    // A removal supersedes a pin of the same entity ("后做的覆盖先做的").
    assert.equal(controller.exclude(item('A')).ok, true);
    assert.equal(controller.getSnapshot().state.pins.length, 0);
    assert.equal(controller.getSnapshot().state.excluded.length, 1);

    assert.equal(controller.hideEdge({ from: 'A', to: 'B', type: 'call' }).ok, true);
    assert.deepEqual(controller.getSnapshot().state.hiddenEdges, [{ from: 'A', to: 'B', type: 'call' }]);

    // Undo unwinds the hide, then the removal.
    controller.undo();
    assert.equal(controller.getSnapshot().state.hiddenEdges.length, 0);
    controller.undo();
    assert.equal(controller.getSnapshot().state.excluded.length, 0);
  });

  it('marks items the new analysis no longer resolves as stale, re-anchoring the rest', () => {
    const storage = memoryStorage();
    const key = curationStorageKey('project-1', 'session-1');
    assert.ok(key !== null);
    // A previous visit saved two pins under the ids of an older analysis.
    storage.setItem(key, JSON.stringify({
      pins: [item('old-A', 'Alpha', 'src/a.ts'), item('old-Z', 'Zeta', 'src/z.ts')],
      excluded: [],
      hiddenEdges: [],
    }));

    const controller = controllerFor(storage);
    assert.equal(controller.getSnapshot().state.pins.length, 2);

    // The new analysis contains Alpha (new id) but no longer Zeta.
    controller.reconcile([{ name: 'Alpha', file: 'src/a.ts', id: 'new-A' }]);
    const pins = controller.getSnapshot().state.pins;
    assert.equal(pins[0]?.id, 'new-A', 'the resolved item is re-anchored onto the current id');
    assert.equal(pins[0]?.stale, undefined);
    assert.equal(pins[1]?.id, 'old-Z', 'an unresolved item keeps its last id');
    assert.equal(pins[1]?.stale, true, 'and is marked stale instead of silently dropped');
  });

  it('dismisses the Toast after its window and holds it while paused', async () => {
    const { clock, advance } = createFakeClock();
    const controller = controllerFor(memoryStorage(), { clock });

    controller.showToast('Pinned Alpha');
    assert.equal(controller.getSnapshot().toast?.message, 'Pinned Alpha');

    await advance(CURATION_TOAST_MS - 1);
    assert.ok(controller.getSnapshot().toast !== null, 'still on screen one tick before the window ends');

    await advance(1);
    assert.equal(controller.getSnapshot().toast, null, 'the window ends and the owner dismisses it');

    // Focus/hover pauses the timer; leaving restarts the full window.
    controller.showToast('Pinned Beta');
    controller.pauseToast();
    await advance(CURATION_TOAST_MS * 3);
    assert.equal(controller.getSnapshot().toast?.message, 'Pinned Beta', 'a pause holds the Toast open');
    controller.resumeToast();
    await advance(CURATION_TOAST_MS);
    assert.equal(controller.getSnapshot().toast, null);
  });

  it('dispose releases the Toast timer instead of letting it fire later', async () => {
    const { clock, advance, pending } = createFakeClock();
    const controller = controllerFor(memoryStorage(), { clock });

    controller.showToast('Pinned Alpha');
    assert.equal(pending(), 1);
    controller.dispose();
    assert.equal(pending(), 0, 'dispose clears the armed timer');

    await advance(CURATION_TOAST_MS * 2);
    assert.equal(controller.getSnapshot().toast?.message, 'Pinned Alpha', 'nothing fired after dispose');
  });

  it('re-anchors once per analysis and retries after a failed resolve', async () => {
    const storage = memoryStorage();
    const key = curationStorageKey('project-1', 'session-1');
    assert.ok(key !== null);
    storage.setItem(key, JSON.stringify({
      pins: [item('old-A', 'Alpha', 'src/a.ts')],
      excluded: [],
      hiddenEdges: [],
    }));

    const resolveItems = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue([{ name: 'Alpha', file: 'src/a.ts', id: 'new-A' }]);
    const controller = controllerFor(storage, { resolveItems });

    const items = [{ name: 'Alpha', file: 'src/a.ts' }];
    controller.reconcileForAnalysis('analysis-1', items);
    await vi.waitFor(() => assert.equal(resolveItems.mock.calls.length, 1));
    assert.equal(controller.getSnapshot().state.pins[0]?.id, 'old-A', 'a failed request keeps the saved ids');

    // The same key retries (a transport failure is not a re-analysis) …
    controller.reconcileForAnalysis('analysis-1', items);
    await vi.waitFor(() => assert.equal(resolveItems.mock.calls.length, 2));
    await vi.waitFor(() => assert.equal(controller.getSnapshot().state.pins[0]?.id, 'new-A'));

    // … and a SUCCESSFUL resolve is not repeated for that analysis.
    controller.reconcileForAnalysis('analysis-1', items);
    await Promise.resolve();
    assert.equal(resolveItems.mock.calls.length, 2, 'one re-anchoring per analysis');
  });

  it('adopts another tab’s write, and clears everything on localStorage.clear()', () => {
    const storage = memoryStorage();
    // The reader mounts BEFORE the other tab writes: its store read an empty
    // value and only the storage event tells it to re-read.
    const reader = controllerFor(storage);
    assert.equal(reader.getSnapshot().state.pins.length, 0);

    const writer = controllerFor(storage);
    writer.pin(item('A'));
    assert.equal(reader.getSnapshot().state.pins.length, 0, 'the reader has not adopted the write yet');

    const key = curationStorageKey('project-1', 'session-1');
    assert.ok(key !== null);
    reader.handleStorageChange(key);
    assert.equal(reader.getSnapshot().state.pins.length, 1, 'the key change rebuilds the store from storage');

    storage.map.clear();
    reader.handleStorageChange(null);
    assert.equal(reader.getSnapshot().state.pins.length, 0, 'a clear is adopted too');
  });

  it('refuses curation without a session and says why through the result', () => {
    const controller = controllerFor(memoryStorage(), { sessionId: null });
    assert.equal(controller.getSnapshot().canEdit, false);
    const result = controller.pin(item('A'));
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.code : '', 'NO_SESSION');
    assert.equal(controller.getSnapshot().state.pins.length, 0);
  });

  it('exposes the manager and solo disclosures through the snapshot', () => {
    const controller = controllerFor(memoryStorage());
    controller.setManagerOpen(true);
    controller.setSoloNodeId('A');
    assert.equal(controller.getSnapshot().managerOpen, true);
    assert.equal(controller.getSnapshot().soloNodeId, 'A');
    controller.setManagerOpen(false);
    controller.setSoloNodeId(null);
    assert.equal(controller.getSnapshot().managerOpen, false);
    assert.equal(controller.getSnapshot().soloNodeId, null);
  });
});
