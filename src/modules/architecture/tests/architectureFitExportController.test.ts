/**
 * `createArchitectureFitExportController` — the panel's fit/export/refresh-state
 * rules, exercised without React, a browser or a wall clock.
 *
 * What the criterion names:
 * - a Fit request is issued with a distinct token, and the renderer's zoom-mode
 *   answer decides whether a later size change may re-fit;
 * - a successful refresh arms exactly one forced fit, even over a manual zoom;
 * - leaving fullscreen restores focus to the toggle, entering sends it to the
 *   canvas, and a plain re-render restores nothing;
 * - the export notice follows success / failure / a downscaled PNG / the
 *   manual-copy fallback;
 * - a succeeded job closes the refresh dialog and the return target survives;
 * - `dispose` makes the controller ignore a late clipboard or rasterise answer
 *   and cancels a pending fit frame.
 */
import assert from 'node:assert/strict';

import { describe, it } from 'vitest';

import { EXPORT_PNG_MAX_EDGE } from '@/modules/architecture/render/curation/exportArtifacts';
import {
  createArchitectureFitExportController,
  type ArchitectureFitExportController,
  type ArchitectureFitExportDeps,
} from '@/modules/architecture/render/curation/architectureFitExportController';
import type { ArchitectureDrawnPlantUml } from '@/modules/architecture/dom/rendererContract';

type Frame = { callback: () => void };

/** A frame seam that runs only when the case flushes it. */
function createFakeFrames(): {
  schedule: (callback: () => void) => unknown;
  cancel: (handle: unknown) => void;
  flush: () => void;
  pending: () => number;
} {
  let nextHandle = 1;
  const frames = new Map<number, Frame>();
  return {
    schedule: (callback) => {
      const handle = nextHandle;
      nextHandle += 1;
      frames.set(handle, { callback });
      return handle;
    },
    cancel: (handle) => {
      frames.delete(handle as number);
    },
    flush: () => {
      const queued = [...frames.values()];
      frames.clear();
      for (const frame of queued) frame.callback();
    },
    pending: () => frames.size,
  };
}

type Harness = {
  controller: ArchitectureFitExportController;
  frames: ReturnType<typeof createFakeFrames>;
  downloads: { contents: string; filename: string; mimeType: string | undefined }[];
  blobs: { blob: Blob; filename: string }[];
  chromeReadings: number[];
};

function createHarness(overrides: Partial<ArchitectureFitExportDeps> = {}): Harness {
  const frames = createFakeFrames();
  const downloads: Harness['downloads'] = [];
  const blobs: Harness['blobs'] = [];
  const chromeReadings: number[] = [];
  const controller = createArchitectureFitExportController({
    measure: () => ({ canvasHeight: 688, windowHeight: 844, chromeBottom: 96 }),
    reportTopChrome: (pixels) => chromeReadings.push(pixels),
    scheduleFrame: frames.schedule,
    cancelFrame: frames.cancel,
    writeClipboard: () => Promise.resolve(),
    downloadText: (contents, filename, mimeType) => downloads.push({ contents, filename, mimeType }),
    downloadBlob: (blob, filename) => blobs.push({ blob, filename }),
    rasterize: () => Promise.resolve(new Blob(['png'], { type: 'image/png' })),
    ...overrides,
  });
  return { controller, frames, downloads, blobs, chromeReadings };
}

/** A deferred promise the case settles after a `dispose`. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const DRAWN = {
  model: {},
  entityIdOf: new Map(),
  toPlantUml: () => '',
  applyView: () => ({}),
} as unknown as ArchitectureDrawnPlantUml;

describe('createArchitectureFitExportController', () => {
  it('issues a fit token for a viewport transition and honours the renderer’s manual-zoom answer', () => {
    const { controller, frames } = createHarness();

    assert.equal(controller.getSnapshot().fitRequest, null, 'mounting is not a request');

    // Entering the overlay: one measured frame, then a fit against the viewport.
    controller.applyViewport({ fillsViewport: true, viewStatus: 'loaded' });
    assert.equal(frames.pending(), 1, 'the fit waits one frame for the settled box');
    frames.flush();
    const entry = controller.getSnapshot().fitRequest;
    assert.ok(entry !== null);
    assert.equal(entry.viewportHeight, 844);
    assert.equal(entry.force, undefined, 'a size change never forces over a zoom');
    assert.equal(typeof entry.token, 'number');

    // Leaving: the column's own height, and a DISTINCT token.
    controller.applyViewport({ fillsViewport: false, viewStatus: 'loaded' });
    frames.flush();
    const exit = controller.getSnapshot().fitRequest;
    assert.ok(exit !== null);
    assert.notEqual(exit.token, entry.token, 'each toggle is its own request');
    assert.equal(exit.viewportHeight, 688);

    // The renderer answers that the reader zoomed by hand: a new transition is
    // not re-fitted.
    controller.reportZoomMode('custom');
    const settledToken = controller.getSnapshot().fitRequest?.token;
    controller.applyViewport({ fillsViewport: true, viewStatus: 'loaded' });
    frames.flush();
    assert.equal(controller.getSnapshot().fitRequest?.token, settledToken, 'a manual zoom is not re-fitted');
  });

  it('fits exactly once after a successful refresh, forcing over a manual zoom', () => {
    const { controller, frames } = createHarness();
    controller.applyViewport({ fillsViewport: true, viewStatus: 'loaded' });
    frames.flush();
    controller.reportZoomMode('custom');
    const before = controller.getSnapshot().fitRequest?.token;

    controller.refreshSucceeded();
    // The old drawing is still on screen while the refetch runs: no fit yet.
    controller.applyRefreshReading({ viewStatus: 'loaded', refreshing: true });
    assert.equal(controller.getSnapshot().fitRequest?.token, before, 'the fit waits for the refetched reading');

    controller.applyRefreshReading({ viewStatus: 'loaded', refreshing: false });
    const refreshed = controller.getSnapshot().fitRequest;
    assert.ok(refreshed !== null);
    assert.notEqual(refreshed.token, before);
    assert.equal(refreshed.force, true, 'a fresh analysis replaces the content, so it is fitted despite the zoom');

    // Armed once: a later reading does not replay it, and the next unrelated
    // size change is its own unforced request.
    controller.applyRefreshReading({ viewStatus: 'loaded', refreshing: false });
    assert.equal(controller.getSnapshot().fitRequest?.token, refreshed.token);
    controller.applyViewport({ fillsViewport: false, viewStatus: 'loaded' });
    frames.flush();
    assertRefreshFitConsumedOnce(controller, refreshed.token);
  });

  it('moves focus into the canvas on entry and back to the toggle on exit', () => {
    const { controller } = createHarness();
    assert.equal(controller.applyFullscreen(false), null, 'mounting restores nothing');
    assert.equal(controller.applyFullscreen(true), 'canvas');
    assert.equal(controller.applyFullscreen(true), 'canvas', 'a repeated reading still targets the canvas');
    assert.equal(controller.applyFullscreen(false), 'toggle');
    assert.equal(controller.applyFullscreen(false), null, 'only the leave transition restores focus');
  });

  it('tracks the drawn model as the one synchronous copy', () => {
    const { controller } = createHarness();
    assert.equal(controller.getDrawnPlantUml(), null);
    controller.reportDrawn(DRAWN);
    assert.equal(controller.getDrawnPlantUml(), DRAWN);
    assert.equal(controller.getSnapshot().drawnPlantUml, DRAWN, 'the snapshot carries the same copy');
    controller.reportDrawn(null);
    assert.equal(controller.getDrawnPlantUml(), null);
  });

  it('announces copy success, and falls back to the manual-copy dialog when refused', async () => {
    const { controller } = createHarness();
    await controller.copyPlantUml('@startuml\nA --> B\n@enduml');
    assert.deepEqual(controller.getSnapshot().exportStatus, { kind: 'copied' });
    assert.equal(controller.getSnapshot().copyFallbackText, null);

    const refusing = createHarness({
      writeClipboard: () => Promise.reject(new Error('denied')),
    });
    await refusing.controller.copyPlantUml('document');
    assert.equal(refusing.controller.getSnapshot().copyFallbackText, 'document');
    assert.equal(refusing.controller.getSnapshot().exportStatus, null, 'the fallback is the reading');

    refusing.controller.dismissCopyFallback();
    assert.equal(refusing.controller.getSnapshot().copyFallbackText, null);
  });

  it('downloads PlantUML/SVG/Mermaid and states “not ready” when the drawing is absent', () => {
    const { controller, downloads } = createHarness();

    controller.exportPlantUml('puml-doc', 'diagram.puml');
    assert.deepEqual(downloads.at(-1), { contents: 'puml-doc', filename: 'diagram.puml', mimeType: undefined });

    controller.exportSvg('<svg/>', 'diagram.svg');
    assert.deepEqual(downloads.at(-1), {
      contents: '<svg/>',
      filename: 'diagram.svg',
      mimeType: 'image/svg+xml;charset=utf-8',
    });

    controller.exportMermaid('graph TD', 'architecture-file.mmd');
    assert.deepEqual(downloads.at(-1), { contents: 'graph TD', filename: 'architecture-file.mmd', mimeType: undefined });

    controller.exportSvg(null, 'diagram.svg');
    assert.deepEqual(controller.getSnapshot().exportStatus, { kind: 'notReady' });
    assert.equal(downloads.length, 3, 'a missing drawing downloads nothing');

    // A later successful action clears the stale notice.
    controller.exportPlantUml('again', 'diagram.puml');
    assert.equal(controller.getSnapshot().exportStatus, null);
  });

  it('reports a downscaled PNG and a rasteriser failure', async () => {
    const { controller, blobs } = createHarness();
    await controller.exportPng('<svg/>', { width: 5_000, height: 3_000 }, 'diagram.png');
    assert.equal(blobs.length, 1);
    assert.equal(blobs[0].filename, 'diagram.png');
    assert.deepEqual(controller.getSnapshot().exportStatus, {
      kind: 'pngScaled',
      edge: EXPORT_PNG_MAX_EDGE,
    });

    const failing = createHarness({
      rasterize: () => Promise.reject(new Error('no-canvas')),
    });
    await failing.controller.exportPng('<svg/>', { width: 100, height: 50 }, 'diagram.png');
    assert.deepEqual(failing.controller.getSnapshot().exportStatus, { kind: 'pngFailed' });
    assert.equal(failing.blobs.length, 0);

    // Without a drawing there is nothing to rasterise.
    await controller.exportPng(null, null, 'diagram.png');
    assert.deepEqual(controller.getSnapshot().exportStatus, { kind: 'notReady' });
  });

  it('closes the refresh dialog when the job succeeds and keeps the focus-return target', () => {
    const { controller } = createHarness();
    const trigger = {} as HTMLElement;
    controller.openRefreshDialog(trigger);
    assert.equal(controller.getSnapshot().refreshDialogOpen, true);
    assert.equal(controller.getSnapshot().refreshDialogReturnFocus, trigger);

    controller.refreshStatusChanged('running');
    assert.equal(controller.getSnapshot().refreshDialogOpen, true, 'a running job keeps the dialog');

    controller.refreshStatusChanged('succeeded');
    assert.equal(controller.getSnapshot().refreshDialogOpen, false, 'a succeeded job closes it');
    assert.equal(
      controller.getSnapshot().refreshDialogReturnFocus,
      trigger,
      'the panel’s ref binding still returns focus to the trigger',
    );

    const other = {} as HTMLElement;
    controller.openRefreshDialog(other);
    controller.closeRefreshDialog();
    assert.equal(controller.getSnapshot().refreshDialogOpen, false);
    assert.equal(controller.getSnapshot().refreshDialogReturnFocus, other);
  });

  it('states a scope-change hidden delta once per transition and clears a stale one', () => {
    const { controller } = createHarness();
    const first = {};
    controller.observeScope({
      result: first,
      scope: 2,
      related: 10,
      hidden: 1,
      kinds: { class: 1 },
      relations: { call: 1 },
    });
    assert.equal(controller.getSnapshot().scopeHiddenDelta, null, 'the first reading has no previous');

    // Same payload identity: not a new settled reading.
    controller.observeScope({
      result: first,
      scope: 2,
      related: 10,
      hidden: 1,
      kinds: { class: 1 },
      relations: { call: 1 },
    });
    assert.equal(controller.getSnapshot().scopeHiddenDelta, null);

    // Scope widened and the filter hid everything new.
    controller.observeScope({
      result: {},
      scope: 3,
      related: 14,
      hidden: 5,
      kinds: { class: 3, function: 1 },
      relations: { call: 3 },
    });
    const delta = controller.getSnapshot().scopeHiddenDelta;
    assert.ok(delta !== null);
    assert.equal(delta.scope, 3);
    assert.equal(delta.found, 4);
    assert.deepEqual(delta.kinds, [{ kind: 'class', count: 2 }, { kind: 'function', count: 1 }]);
    assert.deepEqual(delta.relations, [{ type: 'call', count: 2 }]);

    // A settled reading that reveals them again clears the notice.
    const third = {};
    controller.observeScope({
      result: third,
      scope: 3,
      related: 14,
      hidden: 0,
      kinds: {},
      relations: {},
    });
    assert.equal(controller.getSnapshot().scopeHiddenDelta, null);
  });

  it('ignores late clipboard and rasterise answers after dispose, and cancels the fit frame', async () => {
    const clipboard = deferred<void>();
    const raster = deferred<Blob>();
    const { controller, frames, downloads, blobs } = createHarness({
      writeClipboard: () => clipboard.promise,
      rasterize: () => raster.promise,
    });

    controller.applyViewport({ fillsViewport: true, viewStatus: 'loaded' });
    assert.equal(frames.pending(), 1);
    controller.dispose();
    assert.equal(frames.pending(), 0, 'dispose cancels the pending frame');
    frames.flush();
    assert.equal(controller.getSnapshot().fitRequest, null, 'a cancelled frame never fits');

    // Re-subscribing revives the controller (StrictMode teardown-and-reset).
    const unsubscribe = controller.subscribe(() => {});
    controller.applyViewport({ fillsViewport: true, viewStatus: 'loaded' });
    frames.flush();
    assert.ok(controller.getSnapshot().fitRequest !== null);

    const copy = controller.copyPlantUml('late');
    const png = controller.exportPng('<svg/>', { width: 100, height: 50 }, 'late.png');
    controller.dispose();
    clipboard.resolve();
    raster.resolve(new Blob(['late']));
    await copy;
    await png;

    assert.equal(controller.getSnapshot().exportStatus, null, 'a late clipboard answer is ignored');
    assert.equal(controller.getSnapshot().copyFallbackText, null);
    assert.equal(downloads.length, 0);
    assert.equal(blobs.length, 0, 'a late rasterised blob is not downloaded');
    unsubscribe();
  });
});

/**
 * After the armed fit is consumed, the following unrelated transition sends its
 * own (unforced) request — never a replay of the refresh fit. This keeps the
 * "exactly once" reading honest: the count of FORCED requests stays one.
 */
function assertRefreshFitConsumedOnce(
  controller: ArchitectureFitExportController,
  refreshToken: number,
): void {
  const latest = controller.getSnapshot().fitRequest;
  assert.ok(latest !== null);
  assert.notEqual(latest.token, refreshToken, 'the later toggle is a new request');
  assert.equal(latest.force, undefined, 'only the refresh fit is forced');
}
