/**
 * `createGraphLayoutPipeline` — the architecture canvas's layout pipeline owner
 * (semantic tier, aspect re-layout, direction policy), exercised without React
 * and without a laid-out browser.
 *
 * The readings this file pins:
 * - a burst of manual zoom requests is coalesced into ONE semantic application,
 *   fired after the LOD debounce, reading the settled scale at fire time;
 * - a container shape change earns a re-layout only past the aspect threshold,
 *   and only after the container has held still for the debounce;
 * - the relayout lock freezes that decision; lifting the lock reconciles the
 *   ratio ONCE by re-basing it (the dock transition is not itself a shape
 *   change — the same rule `layoutAspect.test.tsx` pins), and a genuine later
 *   change still earns exactly one re-layout;
 * - the orientation cache answers a repeated (graph, canvas band) without a
 *   second comparison layout;
 * - `dispose` clears both timers.
 *
 * The clock, the solvers and the LOD scheduler are all injected, so nothing
 * here sleeps or depends on a real ELK run.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ExplosionLodScheduler } from '@/modules/architecture/dom/planning/explosionLod';
import type { SemanticCapture } from '@/modules/architecture/layout/drawing/graphDom';
import {
  createGraphLayoutPipeline,
  type GraphLayoutActions,
  type GraphLayoutCommit,
} from '@/modules/architecture/layout/drawing/graphLayoutPipeline';
import type { SemanticTier, SemanticZoomLayout } from '@/modules/architecture/layout/engine/semanticZoomLayout';
import type { Clock } from '@/shared/types';

/**
 * A manual `Clock`: timers fire only when the test advances time, so both
 * debounces are asserted without sleeping.
 */
function createManualClock() {
  let now = 0;
  let nextHandle = 1;
  const timers = new Map<number, { readonly at: number; readonly run: () => void }>();
  const clock: Clock = {
    setTimeout: (callback, milliseconds) => {
      const handle = nextHandle;
      nextHandle += 1;
      timers.set(handle, { at: now + milliseconds, run: callback });
      return handle;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    setInterval: () => 0,
    clearInterval: () => undefined,
    now: () => now,
  };
  return {
    clock,
    advance(milliseconds: number): void {
      now += milliseconds;
      for (const [handle, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > now) continue;
        timers.delete(handle);
        timer.run();
      }
    },
    pending(): number {
      return timers.size;
    },
  };
}

/** The zoom-burst debouncer on the same manual clock (production uses 200 ms). */
function createManualLodScheduler(clock: Clock): ExplosionLodScheduler {
  let pending: (() => void) | null = null;
  let timer: unknown = null;
  return {
    request(task) {
      if (timer !== null) clock.clearTimeout(timer);
      pending = task;
      timer = clock.setTimeout(() => {
        timer = null;
        const run = pending;
        pending = null;
        run?.();
      }, 200);
    },
    cancel() {
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}

/** A layout carrying only the readings the owner reads; the DOM half is faked. */
function layoutOf(tier: SemanticTier, scale: number, foldDepth: number | null = null): SemanticZoomLayout {
  return { tier, scale, foldDepth } as unknown as SemanticZoomLayout;
}

/** A capture the solvers never inspect (the fake solvers ignore the geometry). */
const CAPTURE = {} as SemanticCapture;

function mounted(options: { aspect?: number } = {}) {
  const time = createManualClock();
  const commits: GraphLayoutCommit[] = [];
  const solveSemanticZoom = vi.fn((_geometry: unknown, request: { readonly scale: number }) =>
    layoutOf('B', request.scale));
  const solveFitScale = vi.fn(() => ({
    scale: 0.8,
    layout: layoutOf('B', 0.8),
    fits: true,
    iterations: 1,
    foldDepth: null,
  }));
  let measuredAspect = options.aspect ?? 2;
  const recordFitViewport = vi.fn();
  const actions: GraphLayoutActions = {
    fitViewport: () => ({ width: 600, height: 300 }),
    recordFitViewport,
    semanticFontPx: () => 10,
    commitSemantic: (commit) => commits.push(commit),
    measureAspect: () => measuredAspect,
    forcedDefaultFocus: () => false,
  };
  const pipeline = createGraphLayoutPipeline({
    clock: time.clock,
    aspectDebounceMs: 250,
    solvers: { solveFitScale, solveSemanticZoom },
    createLodScheduler: () => createManualLodScheduler(time.clock),
  });
  pipeline.setActions(actions);
  return {
    pipeline,
    time,
    commits,
    recordFitViewport,
    solveFitScale,
    solveSemanticZoom,
    setMeasuredAspect: (aspect: number) => {
      measuredAspect = aspect;
    },
  };
}

describe('createGraphLayoutPipeline', () => {
  it('coalesces a zoom burst into one semantic application after the LOD debounce', () => {
    const { pipeline, time, commits } = mounted();
    pipeline.markDrawn({ viewKey: 'class', capture: CAPTURE, aspect: 2 });

    // Three wheel steps in the same tick: the settled scale is the one applied.
    pipeline.scheduleSemanticApply(() => ({ fit: false, scale: 0.4 }));
    pipeline.scheduleSemanticApply(() => ({ fit: false, scale: 0.55 }));
    pipeline.scheduleSemanticApply(() => ({ fit: false, scale: 0.7 }));

    time.advance(199);
    expect(commits).toHaveLength(0);
    time.advance(1);
    expect(commits).toHaveLength(1);
    expect(commits[0].scale).toBeCloseTo(0.7);
    expect(pipeline.getSnapshot().drawnRevision).toBe(1);

    // Nothing is left pending: no second application arrives.
    time.advance(1000);
    expect(commits).toHaveLength(1);
  });

  it('re-lays out on a container shape change only past the threshold, after the debounce', () => {
    const { pipeline, time } = mounted();
    pipeline.markDrawn({ viewKey: 'class', capture: CAPTURE, aspect: 2 });

    // 2 → 2.05 is inside the 0.15 band: no re-layout, and no timer either.
    pipeline.reportAspect(2.05);
    time.advance(250);
    expect(pipeline.getSnapshot().layoutAspect).toBeNull();
    expect(time.pending()).toBe(0);

    // 2 → 2.5 crosses it; the reading lands only when the container settles.
    pipeline.reportAspect(2.5);
    time.advance(249);
    expect(pipeline.getSnapshot().layoutAspect).toBeNull();
    time.advance(1);
    expect(pipeline.getSnapshot().layoutAspect).toBeCloseTo(2.5);
  });

  it('keeps one re-layout for a resize stream: the latest reading wins', () => {
    const { pipeline, time } = mounted();
    pipeline.markDrawn({ viewKey: 'class', capture: CAPTURE, aspect: 2 });

    pipeline.reportAspect(2.4);
    time.advance(100);
    pipeline.reportAspect(2.9);
    time.advance(100);
    pipeline.reportAspect(3.2);
    time.advance(249);
    expect(pipeline.getSnapshot().layoutAspect).toBeNull();
    time.advance(1);
    expect(pipeline.getSnapshot().layoutAspect).toBeCloseTo(3.2);

    // Exactly one timer was ever left standing.
    expect(time.pending()).toBe(0);
  });

  it('freezes re-layout while locked, reconciles once on unlock, then re-lays out once', () => {
    const { pipeline, time, setMeasuredAspect } = mounted();
    pipeline.markDrawn({ viewKey: 'class', capture: CAPTURE, aspect: 2 });

    pipeline.lockRelayout();
    pipeline.reportAspect(3);
    time.advance(1000);
    expect(pipeline.getSnapshot().layoutAspect).toBeNull();
    expect(pipeline.getSnapshot().relayoutLocked).toBe(true);

    // Lifting the lock reconciles the container's ratio ONCE, by re-basing it:
    // the dock transition must not itself become a shape change.
    setMeasuredAspect(3);
    pipeline.unlockRelayout();
    expect(pipeline.getSnapshot().relayoutLocked).toBe(false);
    expect(pipeline.getSnapshot().drawnAspect).toBeCloseTo(3);
    time.advance(1000);
    expect(pipeline.getSnapshot().layoutAspect).toBeNull();

    // A genuine change after the transition still earns exactly one layout.
    // (The ratio is clamped to [0.4, 3], so the comparison base is 3 here.)
    pipeline.reportAspect(2.2);
    time.advance(249);
    expect(pipeline.getSnapshot().layoutAspect).toBeNull();
    time.advance(1);
    expect(pipeline.getSnapshot().layoutAspect).toBeCloseTo(2.2);
  });

  it('answers a repeated (graph, canvas band) from the orientation cache without a second layout', async () => {
    const { pipeline } = mounted();
    const rendered: string[] = [];
    const canvas = { width: 1200, height: 400 };
    const render = async (direction: 'DOWN' | 'RIGHT') => {
      rendered.push(direction);
      return {
        // A narrow downward drawing in a wide canvas is the dual-layout case.
        size: direction === 'DOWN' ? { width: 400, height: 400 } : { width: 800, height: 300 },
        drawnFitScale: () => null,
        elapsedMs: 5,
        drawn: direction,
      };
    };

    const first = await pipeline.orientLayout({
      fingerprint: 'graph|class|entity',
      canvas,
      entities: 4,
      forced: null,
      render,
    });
    expect(first.decision.direction).toBe('RIGHT');
    expect(first.cacheHit).toBe(false);
    expect(first.renders).toBe(2);
    expect(rendered).toEqual(['DOWN', 'RIGHT']);

    rendered.length = 0;
    const second = await pipeline.orientLayout({
      fingerprint: 'graph|class|entity',
      canvas,
      entities: 4,
      forced: null,
      render,
    });
    expect(second.cacheHit).toBe(true);
    expect(second.renders).toBe(1);
    expect(rendered).toEqual(['RIGHT']);
    expect(pipeline.getSnapshot().layoutDirection).toBe('RIGHT');
    expect(pipeline.getSnapshot().layoutDirectionReason).not.toBeNull();
  });

  it('dispose clears the pending semantic application and the aspect timer', () => {
    const { pipeline, time, commits } = mounted();
    pipeline.markDrawn({ viewKey: 'class', capture: CAPTURE, aspect: 2 });
    pipeline.scheduleSemanticApply(() => ({ fit: false, scale: 0.5 }));
    pipeline.reportAspect(3);
    expect(time.pending()).toBeGreaterThan(0);

    pipeline.dispose();
    time.advance(5000);

    expect(commits).toHaveLength(0);
    expect(pipeline.getSnapshot().layoutAspect).toBeNull();
  });
});
