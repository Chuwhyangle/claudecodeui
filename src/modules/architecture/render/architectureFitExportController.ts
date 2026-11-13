/**
 * The architecture panel's fit/export/refresh-state owner: when a Fit request is
 * sent, which export notice is on screen, what the export menu serializes, the
 * refresh dialog's open state and return target, and the scope-change disclosure.
 *
 * WHY A CONTROLLER. These readings used to be a cluster of `useState`/`useRef`
 * declarations and effects in `ArchitecturePanel`: the fit token and its two
 * "measure the viewport once" refs, the zoom-mode report, the fullscreen
 * enter/leave flag, the export status and its manual-copy fallback, the drawn
 * model mirrored into a ref so a click could read the latest value, the refresh
 * dialog's open flag and trigger, and the previous-scope reading used to state a
 * hidden delta. Every one has more than one writer or a rule about when it may
 * change, so they belong to one owner with one write path per command. The panel
 * subscribes and renders.
 *
 * NO REACT, NO DOM. The viewport readings, the frame scheduler, the clipboard,
 * the downloads and the rasteriser are injected seams, so the rules are
 * exercised without React, a browser or a wall clock by
 * `tests/architectureFitExportController.test.ts`.
 *
 * Consumers: `ArchitecturePanel.tsx` (subscribes with `useSyncExternalStore`)
 * and `tests/architectureFitExportController.test.ts`.
 */
import type { Clock } from '@/shared/types';
import { createExternalStore, defaultClock } from '@/shared/utils';

import type { ArchitectureDiagramView } from '@/modules/architecture/layout/archguardToPlantUml';
import {
  downloadBlob,
  downloadTextFile,
  EXPORT_PNG_MAX_EDGE,
  pngTargetSize,
  rasterizeSvgToPng,
  type ArchitectureExportSize,
  type ArchitecturePngTarget,
} from '@/modules/architecture/render/exportArtifacts';
import type {
  ArchitectureDrawnPlantUml,
  ArchitectureEntityKind,
  ArchitectureFitRequest,
} from '@/modules/architecture/dom/rendererContract';

/** The one-line export notice the menu's `aria-live` region states. */
export type ArchitectureExportNotice =
  | { readonly kind: 'copied' }
  | { readonly kind: 'notReady' }
  | { readonly kind: 'pngScaled'; readonly edge: number }
  | { readonly kind: 'pngFailed' };

/** One scope transition's hidden-by-the-filter reading, once it deserves a notice. */
export type ArchitectureScopeHiddenDelta = {
  readonly scope: number;
  readonly found: number;
  readonly kinds: readonly { readonly kind: ArchitectureEntityKind; readonly count: number }[];
  readonly relations: readonly { readonly type: string; readonly count: number }[];
};

/** What `observeScope` compares: one settled payload and the readings beside it. */
export type ArchitectureScopeReading = {
  /** The payload identity; a repeated reading of the same payload is ignored. */
  readonly result: unknown;
  readonly scope: number;
  readonly related: number;
  readonly hidden: number;
  readonly kinds: Readonly<Record<string, number>>;
  readonly relations: Readonly<Record<string, number>>;
};

/** The DOM geometry the fit rules consume at frame time. */
export type ArchitectureFitExportGeometry = {
  /** The canvas region's current height (what a leaving-overlay fit uses). */
  readonly canvasHeight: number;
  /** The viewport height (what an overlay fit uses). */
  readonly windowHeight: number;
  /** The last in-flow chrome row's bottom edge, i.e. the covered band. */
  readonly chromeBottom: number;
};

/** Everything the panel reads through `useSyncExternalStore`. */
export type ArchitectureFitExportSnapshot = {
  /** The latest request to fit the drawing again, or null before the first one. */
  readonly fitRequest: ArchitectureFitRequest | null;
  /** The export menu's last outcome, or null when there is nothing to announce. */
  readonly exportStatus: ArchitectureExportNotice | null;
  /** The PlantUML text offered in the manual-copy dialog; null keeps it shut. */
  readonly copyFallbackText: string | null;
  /** The view the mounted renderer is drawing; the export rebuilds exactly it. */
  readonly diagramView: ArchitectureDiagramView;
  /**
   * The model the renderer laid out and drew. One copy only: the export reads it
   * synchronously so a click in the render-before-commit window still exports
   * the document the Text page will settle on.
   */
  readonly drawnPlantUml: ArchitectureDrawnPlantUml | null;
  /** Whether the manual re-analysis dialog is on screen. */
  readonly refreshDialogOpen: boolean;
  /** The control that opened the refresh dialog; focus returns here on close. */
  readonly refreshDialogReturnFocus: HTMLElement | null;
  /** The last scope transition that found more AND hid it, or null. */
  readonly scopeHiddenDelta: ArchitectureScopeHiddenDelta | null;
};

/** The export mechanics and the frame/clock seams, all injectable. */
export type ArchitectureFitExportDeps = {
  /** Reads the canvas geometry when the owner is about to send a fit. */
  readonly measure: () => ArchitectureFitExportGeometry;
  /** Publishes the covered chrome band to the chrome owner. */
  readonly reportTopChrome: (pixels: number) => void;
  /** Schedules one frame; defaults to `requestAnimationFrame` (or a clock tick). */
  readonly scheduleFrame?: (callback: () => void) => unknown;
  /** Cancels one pending frame; defaults to `cancelAnimationFrame`. */
  readonly cancelFrame?: (handle: unknown) => void;
  /** Timer seam, used only when the runtime has no `requestAnimationFrame`. */
  readonly clock?: Clock;
  /** Writes the clipboard; rejects when the browser refuses or the API is absent. */
  readonly writeClipboard?: (text: string) => Promise<void>;
  /** Writes a text artifact. */
  readonly downloadText?: (contents: string, filename: string, mimeType?: string) => void;
  /** Writes a binary artifact. */
  readonly downloadBlob?: (blob: Blob, filename: string) => void;
  /** Rasterises an SVG document to a PNG at the requested bitmap size. */
  readonly rasterize?: (svgText: string, target: Pick<ArchitecturePngTarget, 'width' | 'height'>) => Promise<Blob>;
};

/** The commands and subscription surface the panel drives. */
export type ArchitectureFitExportController = {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => ArchitectureFitExportSnapshot;

  /** The renderer answered which zoom mode it is in (`fit` allows a re-fit). */
  readonly reportZoomMode: (mode: 'fit' | 'custom') => void;
  /** Reports the drawing's viewport-filled state and the loaded-view status beside it. */
  readonly applyViewport: (input: {
    readonly fillsViewport: boolean;
    readonly viewStatus: 'idle' | 'loading' | 'error' | 'loaded';
  }) => void;
  /** Reports a fullscreen transition; returns the element the panel must focus. */
  readonly applyFullscreen: (active: boolean) => 'canvas' | 'toggle' | null;

  /** A refresh job this tab watched reached `succeeded`: arm the post-refresh fit. */
  readonly refreshSucceeded: () => void;
  /** Reports the graph reading; consumes the armed post-refresh fit exactly once. */
  readonly applyRefreshReading: (input: {
    readonly viewStatus: 'idle' | 'loading' | 'error' | 'loaded';
    readonly refreshing: boolean;
  }) => void;
  /** A succeeded job closes the confirmation dialog on its own. */
  readonly refreshStatusChanged: (state: 'idle' | 'running' | 'succeeded' | 'failed') => void;
  /** Opens the dialog, remembering the control focus returns to. */
  readonly openRefreshDialog: (trigger: HTMLElement | null) => void;
  /** Closes the dialog without cancelling the job. */
  readonly closeRefreshDialog: () => void;

  /** The renderer reports the view it is drawing (the export rebuilds it). */
  readonly setDiagramView: (view: ArchitectureDiagramView) => void;
  /** The renderer reports the model it drew; this is the single copy. */
  readonly reportDrawn: (drawn: ArchitectureDrawnPlantUml | null) => void;
  /** The synchronous drawn model, for an export click that races the render. */
  readonly getDrawnPlantUml: () => ArchitectureDrawnPlantUml | null;

  /** Downloads the PlantUML document. */
  readonly exportPlantUml: (text: string, filename: string) => void;
  /** Copies the PlantUML document, falling back to the manual-copy dialog. */
  readonly copyPlantUml: (text: string) => Promise<void>;
  /** Writes the already-serialised SVG, or states that the drawing is not ready. */
  readonly exportSvg: (svgText: string | null, filename: string) => void;
  /** Rasterises the already-serialised SVG and writes the PNG. */
  readonly exportPng: (
    svgText: string | null,
    natural: ArchitectureExportSize | null,
    filename: string,
  ) => Promise<void>;
  /** Writes the legacy Mermaid document (unchanged pre-menu download). */
  readonly exportMermaid: (text: string, filename: string) => void;
  /** Closes the manual-copy dialog. */
  dismissCopyFallback: () => void;

  /** Compares one settled scope reading with the previous one. */
  readonly observeScope: (reading: ArchitectureScopeReading) => void;

  /**
   * Releases the pending frame and makes the controller ignore async answers.
   * A later subscriber revives it, so StrictMode's teardown-and-reset does not
   * leave the panel unable to copy or export.
   */
  readonly dispose: () => void;
};

/** The browser's clipboard, read at call time so a replaced `navigator` is seen. */
function defaultWriteClipboard(text: string): Promise<void> {
  if (typeof navigator === 'undefined' || navigator.clipboard?.writeText === undefined) {
    return Promise.reject(new Error('clipboard-unavailable'));
  }
  return navigator.clipboard.writeText(text);
}

/** `requestAnimationFrame` when the runtime has one, else one clock tick. */
function makeFrameSeams(clock: Clock, deps: ArchitectureFitExportDeps): {
  schedule: (callback: () => void) => unknown;
  cancel: (handle: unknown) => void;
} {
  if (deps.scheduleFrame !== undefined) {
    return {
      schedule: deps.scheduleFrame,
      cancel: deps.cancelFrame ?? (() => {}),
    };
  }
  if (typeof globalThis.requestAnimationFrame === 'function') {
    return {
      schedule: (callback) => globalThis.requestAnimationFrame(callback),
      cancel: (handle) => globalThis.cancelAnimationFrame(handle as number),
    };
  }
  return {
    schedule: (callback) => clock.setTimeout(callback, 16),
    cancel: (handle) => clock.clearTimeout(handle),
  };
}

function sameDelta(
  left: ArchitectureScopeHiddenDelta | null,
  right: ArchitectureScopeHiddenDelta | null,
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return left.scope === right.scope
    && left.found === right.found
    && left.kinds.length === right.kinds.length
    && left.kinds.every((entry, index) => {
      const other = right.kinds[index];
      return other !== undefined && other.kind === entry.kind && other.count === entry.count;
    })
    && left.relations.length === right.relations.length
    && left.relations.every((entry, index) => {
      const other = right.relations[index];
      return other !== undefined && other.type === entry.type && other.count === entry.count;
    });
}

/** Build one controller for one panel mount. */
export function createArchitectureFitExportController(
  deps: ArchitectureFitExportDeps,
): ArchitectureFitExportController {
  const clock = deps.clock ?? defaultClock;
  const frames = makeFrameSeams(clock, deps);
  const writeClipboard = deps.writeClipboard ?? defaultWriteClipboard;
  const downloadText = deps.downloadText ?? downloadTextFile;
  const writeBlob = deps.downloadBlob ?? downloadBlob;
  const rasterize = deps.rasterize ?? rasterizeSvgToPng;

  let disposed = false;

  // ---- fit / fullscreen state ----
  let zoomMode: 'fit' | 'custom' = 'fit';
  let fitRequest: ArchitectureFitRequest | null = null;
  let fitToken = 0;
  let filledViewportMeasured = false;
  let lastFillsViewport = false;
  let wasFullscreen = false;
  let pendingRefreshFit = false;
  let frame: unknown = null;
  let frameScheduled = false;

  // ---- export state ----
  let exportStatus: ArchitectureExportNotice | null = null;
  let copyFallbackText: string | null = null;
  let diagramView: ArchitectureDiagramView = { kind: 'overview' };
  let drawnPlantUml: ArchitectureDrawnPlantUml | null = null;

  // ---- refresh dialog state ----
  let refreshDialogOpen = false;
  let refreshDialogReturnFocus: HTMLElement | null = null;

  // ---- scope reading state ----
  let scopeHiddenDelta: ArchitectureScopeHiddenDelta | null = null;
  let scopeResult: unknown = null;
  let previousScope: (Omit<ArchitectureScopeReading, 'result'> & {
    readonly kinds: Record<string, number>;
    readonly relations: Record<string, number>;
  }) | null = null;

  const buildSnapshot = (): ArchitectureFitExportSnapshot => ({
    fitRequest,
    exportStatus,
    copyFallbackText,
    diagramView,
    drawnPlantUml,
    refreshDialogOpen,
    refreshDialogReturnFocus,
    scopeHiddenDelta,
  });

  const store = createExternalStore<ArchitectureFitExportSnapshot>(buildSnapshot(), {
    // StrictMode tears the subscription down once before its real setup; a
    // dispose is a resource release, not a kill switch for the instance.
    onFirstSubscriber: () => {
      disposed = false;
    },
  });

  /** Rebuilds the snapshot and notifies only when a published field changed. */
  const publish = (): void => {
    if (disposed) return;
    const next = buildSnapshot();
    const previous = store.getSnapshot();
    if (
      previous.fitRequest === next.fitRequest
      && previous.exportStatus === next.exportStatus
      && previous.copyFallbackText === next.copyFallbackText
      && previous.diagramView === next.diagramView
      && previous.drawnPlantUml === next.drawnPlantUml
      && previous.refreshDialogOpen === next.refreshDialogOpen
      && previous.refreshDialogReturnFocus === next.refreshDialogReturnFocus
      && sameDelta(previous.scopeHiddenDelta, next.scopeHiddenDelta)
    ) {
      return;
    }
    store.set(next);
  };

  const cancelFrame = (): void => {
    if (!frameScheduled) return;
    frames.cancel(frame);
    frame = null;
    frameScheduled = false;
  };

  const schedule = (callback: () => void): void => {
    cancelFrame();
    frameScheduled = true;
    frame = frames.schedule(() => {
      frameScheduled = false;
      frame = null;
      if (disposed) return;
      callback();
    });
  };

  /** Sends one fit request. The token makes each request distinguishable. */
  const requestFit = (viewportHeight: number, force = false): void => {
    fitToken += 1;
    fitRequest = {
      token: fitToken,
      viewportHeight,
      ...(force ? { force: true } : {}),
    };
    publish();
  };

  return {
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,

    reportZoomMode(mode) {
      zoomMode = mode;
    },

    applyViewport({ fillsViewport, viewStatus }) {
      if (disposed) return;
      const transitioned = lastFillsViewport !== fillsViewport;
      lastFillsViewport = fillsViewport;

      if (!fillsViewport) {
        if (!transitioned) return;
        // Back to the flex column: the drawing's height is the region's own.
        filledViewportMeasured = false;
        deps.reportTopChrome(0);
        if (zoomMode !== 'fit') return;
        schedule(() => requestFit(deps.measure().canvasHeight));
        return;
      }

      // The chrome rows live inside the loaded branch. Measuring before they
      // mount would read 0 and never re-measure.
      if (viewStatus !== 'loaded') return;
      if (!transitioned && filledViewportMeasured) return;
      // One frame after the toggle (or the first reading): the overlay's box,
      // or the region's return to the flex column, is laid out by then.
      schedule(() => {
        filledViewportMeasured = true;
        // The readout row is the LAST in-flow chrome row, so its bottom edge is
        // the covered band's height.
        const geometry = deps.measure();
        deps.reportTopChrome(Math.ceil(geometry.chromeBottom));
        // A manual zoom is the reader's; only a fit may be re-issued.
        if (zoomMode !== 'fit') return;
        requestFit(geometry.windowHeight);
      });
    },

    applyFullscreen(active) {
      if (active) {
        wasFullscreen = true;
        return 'canvas';
      }
      if (!wasFullscreen) return null;
      wasFullscreen = false;
      return 'toggle';
    },

    refreshSucceeded() {
      pendingRefreshFit = true;
    },

    applyRefreshReading({ viewStatus, refreshing }) {
      if (disposed || !pendingRefreshFit) return;
      if (viewStatus !== 'loaded' || refreshing) return;
      pendingRefreshFit = false;
      // "Fit" after a refresh is the same reading the Fit control means: the
      // refreshed drawing is fitted even if the reader had zoomed the old one.
      zoomMode = 'fit';
      requestFit(deps.measure().canvasHeight, true);
    },

    refreshStatusChanged(state) {
      if (state !== 'succeeded' || !refreshDialogOpen) return;
      refreshDialogOpen = false;
      publish();
    },

    openRefreshDialog(trigger) {
      if (disposed) return;
      refreshDialogReturnFocus = trigger;
      refreshDialogOpen = true;
      publish();
    },

    closeRefreshDialog() {
      if (disposed || !refreshDialogOpen) return;
      refreshDialogOpen = false;
      publish();
    },

    setDiagramView(view) {
      if (disposed || diagramView === view) return;
      diagramView = view;
      publish();
    },

    reportDrawn(drawn) {
      if (disposed || drawnPlantUml === drawn) return;
      drawnPlantUml = drawn;
      publish();
    },

    getDrawnPlantUml() {
      return drawnPlantUml;
    },

    exportPlantUml(text, filename) {
      if (disposed) return;
      exportStatus = null;
      publish();
      downloadText(text, filename);
    },

    async copyPlantUml(text) {
      if (disposed) return;
      try {
        await writeClipboard(text);
        if (disposed) return;
        exportStatus = { kind: 'copied' };
        publish();
      } catch {
        if (disposed) return;
        // Documented fallback: when the clipboard is unavailable, show the same
        // text selected in a dialog the reader can copy by hand.
        copyFallbackText = text;
        publish();
      }
    },

    exportSvg(svgText, filename) {
      if (disposed) return;
      if (svgText === null) {
        exportStatus = { kind: 'notReady' };
        publish();
        return;
      }
      exportStatus = null;
      publish();
      downloadText(svgText, filename, 'image/svg+xml;charset=utf-8');
    },

    async exportPng(svgText, natural, filename) {
      if (disposed) return;
      if (svgText === null || natural === null) {
        exportStatus = { kind: 'notReady' };
        publish();
        return;
      }
      exportStatus = null;
      publish();
      const target = pngTargetSize(natural);
      try {
        const blob = await rasterize(svgText, target);
        if (disposed) return;
        writeBlob(blob, filename);
        if (target.downscaled) {
          exportStatus = { kind: 'pngScaled', edge: EXPORT_PNG_MAX_EDGE };
          publish();
        }
      } catch {
        if (disposed) return;
        exportStatus = { kind: 'pngFailed' };
        publish();
      }
    },

    exportMermaid(text, filename) {
      if (disposed) return;
      exportStatus = null;
      publish();
      downloadText(text, filename);
    },

    dismissCopyFallback() {
      if (disposed || copyFallbackText === null) return;
      copyFallbackText = null;
      publish();
    },

    observeScope(reading) {
      if (disposed || reading.result === null) return;
      if (scopeResult === reading.result) return;
      scopeResult = reading.result;
      const current = {
        scope: reading.scope,
        related: reading.related,
        hidden: reading.hidden,
        kinds: { ...reading.kinds },
        relations: { ...reading.relations },
      };
      const previous = previousScope;
      previousScope = current;
      if (previous === null) return;

      const found = current.related - previous.related;
      const hiddenDelta = current.hidden - previous.hidden;
      // Only an INCREASE in scope can produce "it found more and hid it"; any
      // other settled reading makes the notice stale, so it is cleared.
      if (current.scope <= previous.scope || found <= 0 || hiddenDelta < found) {
        if (scopeHiddenDelta === null) return;
        scopeHiddenDelta = null;
        publish();
        return;
      }
      // Only the NEW removals belong to this transition, not the whole reading.
      const kinds = Object.entries(current.kinds)
        .map(([kind, count]) => ({
          kind: kind as ArchitectureEntityKind,
          count: count - (previous.kinds[kind] ?? 0),
        }))
        .filter((entry) => entry.count > 0);
      const relations = Object.entries(current.relations)
        .map(([type, count]) => ({ type, count: count - (previous.relations[type] ?? 0) }))
        .filter((entry) => entry.count > 0);
      const next: ArchitectureScopeHiddenDelta = { scope: current.scope, found, kinds, relations };
      if (sameDelta(scopeHiddenDelta, next)) return;
      scopeHiddenDelta = next;
      publish();
    },

    dispose() {
      disposed = true;
      cancelFrame();
    },
  };
}
