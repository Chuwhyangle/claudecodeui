import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';

import {
  createExplosionLodScheduler,
  LOD_DEADZONE_RATIO,
  LOD_DEBOUNCE_MS,
  tierWithinDeadzone,
} from '@/modules/architecture/explosionLod';

/**
 * The zoom-transition plumbing that outlived the retired level thresholds.
 *
 * The canvas no longer hides whole layers at scale thresholds — it rewrites the
 * geometry (see `semanticZoomLayout.ts`). Two guarantees from the old mechanism
 * are still load-bearing and are pinned here:
 *
 *  · a wheel/pinch burst is coalesced into ONE application after the settle
 *    delay, never one per tick (the debounce), and a replaced drawing cancels a
 *    pending application;
 *  · a tier already on screen is kept inside an 8 % dead band around its
 *    stretch budget, so a scale resting on a boundary does not flap.
 *
 * Consumers: `PlantUmlGraph.tsx` drives the scheduler from its zoom state and
 * `selectSemanticTier` uses the dead-band predicate.
 */

describe('the zoom debouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('a burst of readings applies once, after the settle delay', () => {
    const scheduler = createExplosionLodScheduler();
    const applied: number[] = [];
    assert.equal(LOD_DEBOUNCE_MS, 200, 'the proposal fixes the 150–250 ms window');

    scheduler.request(() => applied.push(1));
    vi.advanceTimersByTime(50);
    scheduler.request(() => applied.push(2));
    vi.advanceTimersByTime(50);
    scheduler.request(() => applied.push(3));
    assert.deepEqual(applied, [], 'nothing runs while the wheel is still moving');

    vi.advanceTimersByTime(LOD_DEBOUNCE_MS - 1);
    assert.deepEqual(applied, [], 'the last reading is still pending at 199 ms');
    vi.advanceTimersByTime(1);
    assert.deepEqual(applied, [3], 'only the latest reading is applied');
  });

  test('a cancelled application never runs', () => {
    const scheduler = createExplosionLodScheduler(100);
    const applied: string[] = [];
    scheduler.request(() => applied.push('stale'));
    scheduler.cancel();
    vi.advanceTimersByTime(500);
    assert.equal(applied.length, 0);

    scheduler.request(() => applied.push('fresh'));
    vi.advanceTimersByTime(100);
    assert.deepEqual(applied, ['fresh'], 'the scheduler still works after a cancel');
  });
});

describe('the tier dead band', () => {
  test('the band is 8 % of the stretch budget', () => {
    assert.equal(LOD_DEADZONE_RATIO, 0.08);
  });

  test('a tier inside the budget is always kept', () => {
    assert.equal(tierWithinDeadzone(1.2, 1.8), true);
    assert.equal(tierWithinDeadzone(1.8, 1.8), true);
  });

  test('a tier slightly over the budget is kept; one far over it steps down', () => {
    // 1.8 × (1 + 0.08 / 2) = 1.872 — the boundary the dead band allows.
    assert.equal(tierWithinDeadzone(1.86, 1.8), true, 'inside the +4 % half-band');
    assert.equal(tierWithinDeadzone(1.88, 1.8), false, 'past the dead band');
    assert.equal(tierWithinDeadzone(2.5, 1.8), false);
  });

  test('a non-finite reading never earns the tier', () => {
    assert.equal(tierWithinDeadzone(Number.NaN, 1.8), false);
    assert.equal(tierWithinDeadzone(1.5, Number.POSITIVE_INFINITY), false);
  });
});
