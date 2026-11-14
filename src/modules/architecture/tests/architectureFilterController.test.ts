/**
 * `createArchitectureFilterController` — the architecture tab's filter/display
 * rules, exercised without React, `localStorage` or a wall clock.
 *
 * What the criterion names:
 * - a walk through the filter presets becomes ONE debounced request;
 * - returning to the request's own selection cancels the pending request;
 * - the filter, scope and detail are remembered per project and restored;
 * - a view (granularity) switch shows immediately and requests with the new
 *   view;
 * - `dispose` releases the pending debounce.
 */
import assert from 'node:assert/strict';

import { describe, it } from 'vitest';

import {
  createArchitectureFilterController,
  FILTER_REQUEST_DEBOUNCE_MS,
} from '@/modules/architecture/render/architectureFilterController';
import type { ArchitectureDetailTier } from '@/modules/architecture/dom/readout/detailRanking';
import {
  ARCHITECTURE_DEFAULT_FILTER,
  type ArchitectureElementRelationFilter,
} from '@/modules/architecture/dom/readout/elementRelationFilter';
import { filterStorageKey } from '@/modules/architecture/layout/panel/panelFilters';
import type { Clock } from '@/shared/types';
import type { PanelStorageLike } from '@/modules/architecture/layout/panel/panelPersistence';

type Timer = {
  handle: number;
  callback: () => void;
  due: number;
};

/** A deterministic clock: timers fire only when `advance` moves past them. */
function createFakeClock(): {
  clock: Clock;
  advance: (milliseconds: number) => void;
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
      throw new Error('the filter controller must not need an interval');
    },
    clearInterval: () => {},
  };

  const advance = (milliseconds: number): void => {
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
    }
    now = target;
  };

  return { clock, advance, pending: () => timers.size };
}

function memoryStorage(): PanelStorageLike & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

/** A selection that differs from the default on one axis. */
function filterWith(relations: ArchitectureElementRelationFilter['relations']): ArchitectureElementRelationFilter {
  return { ...ARCHITECTURE_DEFAULT_FILTER, relations };
}

function controllerFor(
  storage: PanelStorageLike,
  options: {
    projectId?: string | null;
    clock?: Clock;
    initialGranularity?: 'file' | 'entity';
    initialScope?: number;
    initialDetail?: ArchitectureDetailTier;
  } = {},
) {
  return createArchitectureFilterController({
    storage,
    projectId: options.projectId === undefined ? 'project-1' : options.projectId,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.initialGranularity === undefined ? {} : { initialGranularity: options.initialGranularity }),
    ...(options.initialScope === undefined ? {} : { initialScope: options.initialScope }),
    ...(options.initialDetail === undefined ? {} : { initialDetail: options.initialDetail }),
  });
}

describe('createArchitectureFilterController', () => {
  it('collapses a walk through the presets into one debounced request', () => {
    const { clock, advance } = createFakeClock();
    const controller = controllerFor(memoryStorage(), { clock });

    let requests = 0;
    let lastRequested = controller.getSnapshot().requestFilter;
    controller.subscribe(() => {
      const next = controller.getSnapshot().requestFilter;
      if (next !== lastRequested) {
        requests += 1;
        lastRequested = next;
      }
    });

    controller.changeFilter(filterWith('dependency'));
    controller.changeFilter(filterWith('call'));
    controller.changeFilter(filterWith('structural'));
    advance(FILTER_REQUEST_DEBOUNCE_MS - 1);
    assert.equal(requests, 0, 'nothing is requested before the debounce elapses');

    advance(1);
    assert.equal(requests, 1, 'the walk produces exactly one request');
    assert.deepEqual(controller.getSnapshot().requestFilter, filterWith('structural'));
    assert.deepEqual(controller.getSnapshot().filter, filterWith('structural'), 'the drawing narrowed immediately');
  });

  it('cancels the pending request when the selection returns to the request’s own', () => {
    const { clock, advance, pending } = createFakeClock();
    const controller = controllerFor(memoryStorage(), { clock });

    controller.changeFilter(filterWith('call'));
    assert.equal(pending(), 1);
    // Back to the selection the payload in hand was generated with.
    controller.changeFilter(ARCHITECTURE_DEFAULT_FILTER);
    assert.equal(pending(), 0, 'the pending request is cancelled');

    advance(FILTER_REQUEST_DEBOUNCE_MS * 2);
    assert.deepEqual(controller.getSnapshot().requestFilter, ARCHITECTURE_DEFAULT_FILTER);
  });

  it('shows a granularity switch now and requests with the new view after the debounce', () => {
    const { clock, advance } = createFakeClock();
    const controller = controllerFor(memoryStorage(), { clock });
    assert.equal(controller.getSnapshot().granularity, 'entity');

    controller.changeGranularity('file');
    assert.equal(controller.getSnapshot().granularity, 'file', 'the drawing switches immediately');
    assert.equal(controller.getSnapshot().requestGranularity, 'entity', 'the request has not moved yet');

    advance(FILTER_REQUEST_DEBOUNCE_MS);
    assert.equal(controller.getSnapshot().requestGranularity, 'file', 'the request follows the view');
  });

  it('remembers the filter, scope and detail per project and restores them', () => {
    const storage = memoryStorage();
    const projectOne = controllerFor(storage);
    projectOne.changeFilter(filterWith('call'));
    projectOne.changeScope(3);
    projectOne.changeDetail('core');
    projectOne.dispose();

    // A different project starts at the shipped defaults, not project one's choices.
    const projectTwo = controllerFor(storage, { projectId: 'project-2' });
    assert.deepEqual(projectTwo.getSnapshot().filter, ARCHITECTURE_DEFAULT_FILTER);
    assert.notEqual(projectTwo.getSnapshot().scope, 3);

    // Returning to project one restores every remembered knob.
    const projectOneAgain = controllerFor(storage);
    assert.deepEqual(projectOneAgain.getSnapshot().filter, filterWith('call'));
    assert.equal(projectOneAgain.getSnapshot().scope, 3);
    assert.equal(projectOneAgain.getSnapshot().detail, 'core');
  });

  it('prefers a deep link’s scope/detail/view for this mount without persisting them', () => {
    const storage = memoryStorage();
    const controller = controllerFor(storage, {
      initialGranularity: 'file',
      initialScope: 5,
      initialDetail: 'core',
    });
    assert.equal(controller.getSnapshot().granularity, 'file');
    assert.equal(controller.getSnapshot().scope, 5);
    assert.equal(controller.getSnapshot().detail, 'core');
    assert.equal(storage.map.size, 0, 'a link decides the first paint, not the stored choice');
  });

  it('dispose releases the pending debounce instead of requesting later', () => {
    const { clock, advance, pending } = createFakeClock();
    const controller = controllerFor(memoryStorage(), { clock });

    controller.changeFilter(filterWith('call'));
    assert.equal(pending(), 1);
    controller.dispose();
    assert.equal(pending(), 0);

    advance(FILTER_REQUEST_DEBOUNCE_MS * 2);
    assert.deepEqual(controller.getSnapshot().requestFilter, ARCHITECTURE_DEFAULT_FILTER);
  });

  it('adopts another tab’s filter write, including a localStorage clear', () => {
    const storage = memoryStorage();
    const controller = controllerFor(storage);
    assert.deepEqual(controller.getSnapshot().filter, ARCHITECTURE_DEFAULT_FILTER);

    storage.setItem(filterStorageKey('project-1'), JSON.stringify(filterWith('call')));
    controller.handleStorageChange(filterStorageKey('project-1'));
    assert.deepEqual(controller.getSnapshot().filter, filterWith('call'));
    assert.deepEqual(
      controller.getSnapshot().requestFilter,
      filterWith('call'),
      'the adopted selection is the request’s own again',
    );

    storage.map.clear();
    controller.handleStorageChange(null);
    assert.deepEqual(controller.getSnapshot().filter, ARCHITECTURE_DEFAULT_FILTER);
  });

  it('opens, anchors and closes the filter popover', () => {
    const controller = controllerFor(memoryStorage());
    controller.openFilterMenu({ left: 12, top: 40 });
    assert.equal(controller.getSnapshot().filterMenuOpen, true);
    assert.deepEqual(controller.getSnapshot().filterPosition, { left: 12, top: 40 });
    controller.closeFilterMenu();
    assert.equal(controller.getSnapshot().filterMenuOpen, false);
  });

  it('keeps the inspector’s tool-output switch', () => {
    const controller = controllerFor(memoryStorage());
    assert.equal(controller.getSnapshot().includeToolResults, false);
    controller.setIncludeToolResults(true);
    assert.equal(controller.getSnapshot().includeToolResults, true);
  });
});
