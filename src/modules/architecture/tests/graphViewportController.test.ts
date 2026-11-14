/**
 * `createGraphViewportController` — the architecture canvas's zoom, viewport and
 * auto-fit rules, exercised without React and without a laid-out browser.
 *
 * The readings the task names:
 * - an `auto` canvas size change re-solves the Fit after ONE debounce, and a
 *   `manual` scale suppresses it;
 * - an explicit zoom leaves `auto` mode and cancels a pending refit;
 * - a changed fullscreen inset is itself a re-fit trigger;
 * - one Fit token is answered once, and only in `auto` mode unless forced;
 * - zoom steps are clamped to the viewport's supported range;
 * - `dispose` clears the debounce timer.
 */
import { describe, expect, it, vi } from 'vitest';

import { createGraphViewportController } from '@/modules/architecture/layout/drawing/graphViewportController';
import { MAX_ZOOM_SCALE, MIN_ZOOM_SCALE } from '@/modules/architecture/layout/engine/svgViewport';
import type { Clock } from '@/shared/types';

/**
 * A manual `Clock`: timers fire only when the test advances time, so the
 * debounce is asserted without sleeping.
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

function mounted(options: {
  autoFitDisabled?: () => boolean;
  debounceMs?: number;
  onZoomModeChange?: (mode: 'fit' | 'custom') => void;
} = {}) {
  const time = createManualClock();
  const autoFit = vi.fn();
  const fit = vi.fn();
  const controller = createGraphViewportController({
    clock: time.clock,
    autoFitDisabled: options.autoFitDisabled,
    debounceMs: options.debounceMs ?? 150,
  });
  controller.setActions({
    fit,
    autoFit,
    onZoomModeChange: options.onZoomModeChange,
  });
  return { controller, time, autoFit, fit };
}

describe('createGraphViewportController', () => {
  it('debounces an auto size change into one re-solve', () => {
    const { controller, time, autoFit } = mounted();

    // A resize burst restarts the same timer instead of stacking re-solves.
    controller.scheduleAutoFit();
    time.advance(100);
    controller.scheduleAutoFit();
    time.advance(100);
    expect(autoFit).not.toHaveBeenCalled();

    time.advance(50);
    expect(autoFit).toHaveBeenCalledTimes(1);
  });

  it('stops auto-fitting after the reader sets a manual scale', () => {
    const { controller, time, autoFit } = mounted();

    expect(controller.zoomTo(2)).toBe(2);
    expect(controller.getSnapshot().zoom).toEqual({ scale: 2, fit: 'manual' });

    controller.scheduleAutoFit();
    time.advance(1_000);
    expect(autoFit).not.toHaveBeenCalled();
  });

  it('cancels a pending auto-fit when an explicit zoom lands inside the debounce', () => {
    const { controller, time, autoFit } = mounted();

    controller.scheduleAutoFit();
    time.advance(100);
    controller.zoomTo(1.5);
    time.advance(1_000);
    expect(autoFit).not.toHaveBeenCalled();
  });

  it('re-fits when the fullscreen insets change, and ignores an unchanged reading', () => {
    const { controller, time, autoFit } = mounted();

    controller.setFullscreenInsets({ top: 10, right: 0, bottom: 20, left: 0 });
    time.advance(150);
    expect(autoFit).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().fullscreenInsets).toEqual({ top: 10, right: 0, bottom: 20, left: 0 });

    // Sub-half-pixel noise is the same reading, not a second refit.
    controller.setFullscreenInsets({ top: 10.2, right: 0, bottom: 19.8, left: 0 });
    time.advance(1_000);
    expect(autoFit).toHaveBeenCalledTimes(1);

    controller.setFullscreenInsets({ top: 30, right: 0, bottom: 20, left: 0 });
    time.advance(150);
    expect(autoFit).toHaveBeenCalledTimes(2);
  });

  it('answers one Fit token once, and only in auto mode unless forced', () => {
    const { controller, fit } = mounted();

    expect(controller.requestFit({ token: 7 })).toBe(true);
    expect(fit).toHaveBeenCalledTimes(1);

    // The same token on a later render is the same answer.
    expect(controller.requestFit({ token: 7 })).toBe(false);
    expect(fit).toHaveBeenCalledTimes(1);

    expect(controller.requestFit({ token: 8 })).toBe(true);
    expect(fit).toHaveBeenCalledTimes(2);

    controller.zoomTo(2);
    expect(controller.requestFit({ token: 9 })).toBe(false);
    expect(fit).toHaveBeenCalledTimes(2);

    // A declined token is still answered: forcing the SAME token cannot refit.
    expect(controller.requestFit({ token: 9, force: true })).toBe(false);
    expect(fit).toHaveBeenCalledTimes(2);

    // A fresh forced token does fit through a manual scale.
    expect(controller.requestFit({ token: 10, force: true })).toBe(true);
    expect(fit).toHaveBeenCalledTimes(3);
  });

  it('clamps every explicit zoom step to the viewport range', () => {
    const { controller } = mounted();

    expect(controller.zoomTo(100)).toBe(MAX_ZOOM_SCALE);
    expect(controller.getSnapshot().zoom.scale).toBe(MAX_ZOOM_SCALE);

    expect(controller.zoomTo(0)).toBe(MIN_ZOOM_SCALE);
    expect(controller.zoomBy(100)).toBe(MAX_ZOOM_SCALE);
    expect(controller.zoomBy(0.0001)).toBe(MIN_ZOOM_SCALE);
    expect(controller.getSnapshot().zoom).toEqual({ scale: MIN_ZOOM_SCALE, fit: 'manual' });
  });

  it('clears the debounce timer on dispose', () => {
    const { controller, time, autoFit } = mounted();

    controller.scheduleAutoFit();
    expect(time.pending()).toBe(1);

    controller.dispose();
    expect(time.pending()).toBe(0);

    time.advance(1_000);
    expect(autoFit).not.toHaveBeenCalled();
  });

  it('publishes a stable snapshot and reports the mode once per change', () => {
    const onZoomModeChange = vi.fn();
    const { controller } = mounted({ onZoomModeChange });

    // The first `setActions` states the mode the panel must render.
    expect(onZoomModeChange).toHaveBeenCalledTimes(1);
    expect(onZoomModeChange).toHaveBeenLastCalledWith('fit');

    const before = controller.getSnapshot();
    expect(controller.getSnapshot()).toBe(before);

    controller.zoomTo(2);
    expect(onZoomModeChange).toHaveBeenCalledTimes(2);
    expect(onZoomModeChange).toHaveBeenLastCalledWith('custom');

    // A fit request does not run through the panel's mode callback twice.
    controller.zoomTo(2.5);
    expect(onZoomModeChange).toHaveBeenCalledTimes(2);
  });

  it('records the Fit box and the last flow box for the readout', () => {
    const { controller } = mounted();

    controller.reportFitViewport({ width: 640, height: 480 });
    expect(controller.getSnapshot().fitViewport).toEqual({ width: 640, height: 480 });

    // Sub-half-pixel drift is the same published box.
    controller.reportFitViewport({ width: 640.2, height: 479.8 });
    expect(controller.getSnapshot().fitViewport).toEqual({ width: 640, height: 480 });

    controller.reportFitViewport({ width: 0, height: 0 });
    expect(controller.getSnapshot().fitViewport).toEqual({ width: 640, height: 480 });

    controller.reportFlowViewport({ width: 800, height: 600 });
    expect(controller.lastFlowViewport()).toEqual({ width: 800, height: 600 });
  });
});
