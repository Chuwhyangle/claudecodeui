/**
 * The canvas FIT / ZOOM half: the auto-fit re-solve, the resize + overlay
 * observers that decide when to re-fit or re-lay out, the two zoom commands the
 * toolbar and the keyboard share, and the explicit whole-graph fit.
 *
 * Extracted from `PlantUmlGraph.tsx` unchanged (residual-oversize split,
 * `gap-routine-architecture-analysis-architecture-panel-plantuml-residual-oversize`).
 * The debounce, the `auto`-mode gate and the control arm's "refit off" reading
 * still live in the viewport owner; this hook is the drawing-bound half.
 */
import { useCallback, useEffect, type RefObject } from 'react';

import type { ArchitectureRendererGraph } from '@/modules/architecture/dom/rendererContract';
import type { GraphLayoutPipeline } from '@/modules/architecture/layout/drawing/graphLayoutPipeline';
import type { GraphViewportController, GraphZoom, GraphViewportFitRequest } from '@/modules/architecture/layout/drawing/graphViewportController';
import { solveFitArea, type FitOverlayRect } from '@/modules/architecture/layout/engine/semanticZoomLayout';
import type { SvgFitPlacement, SvgViewportSize } from '@/modules/architecture/layout/engine/svgViewport';
import { clampZoomScale, fitAreaInsets, measureHostSize, measureViewportSize } from '@/modules/architecture/layout/engine/svgViewport';
import { measureLayoutAspect } from '@/modules/architecture/layout/drawing/graphDom';
import { forcedFullscreenReservedMargins } from '@/modules/architecture/render/plantUmlControlArm';

/** Every reading the fit/zoom half closes over. */
export type CanvasFitZoomArgs = {
  readonly hostRef: RefObject<HTMLDivElement | null>;
  readonly graph: ArchitectureRendererGraph;
  readonly fullscreen: boolean;
  readonly zoom: GraphZoom;
  readonly fitRequest: GraphViewportFitRequest | null;
  readonly layoutPipeline: GraphLayoutPipeline;
  readonly viewportController: GraphViewportController;
  readonly revealSelectedRef: RefObject<(() => void) | null>;
  readonly applyPlacement: (drawing: SVGSVGElement | null, placement: SvgFitPlacement | null) => void;
  readonly applyZoom: (next: GraphZoom) => boolean;
  readonly controllerZoom: () => GraphZoom;
  readonly fitPlacementFor: (natural: SvgViewportSize, box: SvgViewportSize) => SvgFitPlacement;
  readonly naturalOfDrawing: (drawing: SVGSVGElement | null) => SvgViewportSize | null;
  readonly currentFitViewport: (host: HTMLElement) => SvgViewportSize | null;
  readonly recordFitViewport: (box: SvgViewportSize | null) => void;
  readonly fullscreenOverlays: () => FitOverlayRect[];
  readonly onZoomModeChange?: (mode: 'fit' | 'custom') => void;
};

/** The actions the toolbar, the keyboard and the owner re-bind each render. */
export type CanvasFitZoom = {
  readonly runAutoFit: () => void;
  readonly zoomToScale: (scale: number) => void;
  readonly zoomByStep: (factor: number) => void;
  readonly fitDiagram: () => void;
};

/** Bind the fit/zoom observers and return the four drawing-bound actions. */
export function useCanvasFitZoom(args: CanvasFitZoomArgs): CanvasFitZoom {
  const {
    hostRef,
    fullscreen,
    zoom,
    fitRequest,
    layoutPipeline,
    viewportController,
    revealSelectedRef,
    applyPlacement,
    applyZoom,
    controllerZoom,
    fitPlacementFor,
    naturalOfDrawing,
    currentFitViewport,
    recordFitViewport,
    fullscreenOverlays,
    onZoomModeChange,
  } = args;

// The auto-fit re-solve. The debounce, the `auto`-mode gate and the control
// arm's "refit off" reading live in the viewport owner; this is only the
// drawing-bound half (semantic rewrite vs. CSS resize + placement).
const runAutoFit = useCallback((): void => {
  if (layoutPipeline.getSnapshot().semanticCapture !== null) {
    layoutPipeline.applySemantic({ fit: true, scale: controllerZoom().scale });
    return;
  }
  const host = hostRef.current;
  const viewport = viewportController.viewport();
  if (host === null || viewport === null) return;
  const drawing = host.querySelector('svg');
  const natural = naturalOfDrawing(drawing);
  const box = currentFitViewport(host);
  recordFitViewport(box);
  if (natural === null || box === null) return;
  const placement = fitPlacementFor(natural, box);
  const scale = viewport.zoomTo(placement.scale);
  applyPlacement(drawing, placement);
  applyZoom({ scale, fit: 'auto' });
}, [applyPlacement, applyZoom, controllerZoom, currentFitViewport, fitPlacementFor, layoutPipeline, naturalOfDrawing, recordFitViewport, viewportController]);

// Every canvas size change — window resize, fullscreen, the inspector/drawer/
// tray opening, a phone rotation, a re-layout — reaches this observer. Under
// `auto` it re-solves the fit; under `manual` the reader's scale is kept and
// only the selected box is panned back into view.
//
// The same observer notices a SHAPE change: a resize that only re-fits is
// cheap, but one that turns the container landscape/portrait makes the
// drawing's proportions wrong, which only a new layout fixes. That path is
// behind `shouldRelayoutForAspect`'s threshold and its own debounce.
useEffect(() => {
  const host = hostRef.current;
  if (host === null || typeof ResizeObserver !== 'function') return;
  const observer = new ResizeObserver(() => {
    // The owner holds the threshold, the lock and the debounce: this only
    // reports what the container now measures.
    layoutPipeline.reportAspect(measureLayoutAspect(host));
    revealSelectedRef.current?.();
    viewportController.scheduleAutoFit();
  });
  observer.observe(host);
  // The corner chrome decides the CSS-scaled fit, and the minimap mounts a
  // beat after the drawing does (it needs the drawn node rectangles).
  // Observing the overlay column re-runs the fit once that chrome has a size.
  const overlays = host.parentElement?.querySelector<HTMLElement>('[data-architecture-canvas-overlays]');
  if (overlays !== undefined && overlays !== null) observer.observe(overlays);
  return () => observer.disconnect();
}, [layoutPipeline, viewportController]);

// Remember the box the ordinary (non-fullscreen) layout fits against. The
// control arm's lever reads it to restore the retired defect; the shipped
// path never does. A no-dependency effect runs on every render, which is
// exactly the cadence "the last box this canvas had" needs.
useEffect(() => {
  if (fullscreen) return;
  const host = hostRef.current;
  if (host === null) return;
  viewportController.reportFlowViewport(measureViewportSize(host));
});

// The overlay's Fit area: the viewport-sized host less the chrome actually
// painted over it. Its insets become the host's padding, so the flex
// centring, the scroll extent and `measureViewportSize` all describe the same
// overlay-free rectangle the solve used.
//
// Re-measured whenever the top/bottom chrome changes AND whenever the corner
// slot (the minimap mounts a beat after the drawing) or the selection tray
// resizes; the latter re-solves through the SAME 150 ms debounce a canvas
// resize uses, which is what makes opening/closing an overlay re-fit.
useEffect(() => {
  if (!fullscreen) {
    viewportController.setFullscreenInsets(null);
    return;
  }
  const host = hostRef.current;
  if (host === null) return;
  const measure = (): void => {
    const hostSize = measureHostSize(host);
    if (hostSize === null) return;
    if (forcedFullscreenReservedMargins()) {
      // The control arm keeps the retired rule: no chrome is deducted, so no
      // inset is written and the drawing is centred in the whole overlay.
      viewportController.setFullscreenInsets({ top: 0, right: 0, bottom: 0, left: 0 });
      return;
    }
    const area = solveFitArea(hostSize, fullscreenOverlays());
    // The owner ignores a sub-half-pixel-unchanged reading, so a re-measure
    // that found the same chrome is not a second re-fit.
    viewportController.setFullscreenInsets(fitAreaInsets(hostSize, area));
  };
  measure();
  // One frame after the overlay mounts, its chrome rows are laid out.
  const frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(measure) : null;
  const observer = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => {
        measure();
        viewportController.scheduleAutoFit();
      })
    : null;
  if (observer !== null) {
    // The host itself is observed so a browser-fullscreen resize (or a phone
    // rotation) re-reads where the absolute chrome now sits; its content box
    // also changes when the insets below are applied, and re-measuring the
    // same numbers is a no-op.
    observer.observe(host);
    const canvas = host.parentElement;
    const panel = host.closest('[data-architecture-panel]');
    const surfaces = [
      canvas?.querySelector<HTMLElement>('[data-architecture-canvas-overlays]') ?? null,
      canvas?.querySelector<HTMLElement>('[data-architecture-tray-root]') ?? null,
      panel?.querySelector<HTMLElement>('[data-architecture-source-footer]') ?? null,
      panel?.querySelector<HTMLElement>('[data-architecture-fullscreen-dock]') ?? null,
    ];
    for (const surface of surfaces) if (surface !== null) observer.observe(surface);
  }
  return () => {
    if (frame !== null) cancelAnimationFrame(frame);
    observer?.disconnect();
  };
}, [fullscreen, fullscreenOverlays, viewportController]);

// The scale is read from the owner at FIRE time, so a burst of wheel updates
// coalesces into one rewrite rather than walking every intermediate level.
// Auto-fit re-solves are driven by the resize path above; this effect only
// answers explicit (manual) scales.
useEffect(() => {
  if (zoom.fit !== 'manual') return;
  layoutPipeline.scheduleSemanticApply(() => ({ fit: false, scale: controllerZoom().scale }));
}, [controllerZoom, layoutPipeline, zoom.fit, zoom.scale]);

const zoomToScale = (scale: number): void => {
  if (layoutPipeline.getSnapshot().semanticCapture !== null) {
    const applied = clampZoomScale(scale);
    applyZoom({ scale: applied, fit: 'manual' });
    layoutPipeline.applySemantic({ fit: false, scale: applied });
    return;
  }
  // The owner applies the CSS scale through the viewport and clamps it.
  viewportController.zoomTo(scale);
};

const zoomByStep = (factor: number): void => {
  if (layoutPipeline.getSnapshot().semanticCapture !== null) {
    const applied = clampZoomScale(controllerZoom().scale * factor);
    applyZoom({ scale: applied, fit: 'manual' });
    layoutPipeline.applySemantic({ fit: false, scale: applied });
    return;
  }
  viewportController.zoomBy(factor);
};

/**
 * Fit: return to the sticky `auto` state and solve the largest scale whose
 * mapped content fits the canvas. A semantic drawing never takes a CSS factor
 * here — the solved scale is written into the geometry and shown 1:1.
 */
const fitDiagram = (): void => {
  // A fit is the whole-graph reading: the package zoom the hint offered is
  // over, and its row must not keep asking the reader to go back.
  viewportController.setPackageFocus(null);
  if (layoutPipeline.getSnapshot().semanticCapture !== null) {
    applyZoom({ scale: controllerZoom().scale, fit: 'auto' });
    layoutPipeline.applySemantic({ fit: true, scale: controllerZoom().scale });
    return;
  }
  const host = hostRef.current;
  const viewport = viewportController.viewport();
  if (host === null || viewport === null) {
    applyZoom({ scale: 1, fit: 'auto' });
    return;
  }
  const drawing = host.querySelector('svg');
  const natural = naturalOfDrawing(drawing);
  const box = currentFitViewport(host);
  recordFitViewport(box);
  if (natural === null || box === null) {
    applyZoom({ scale: viewport.fitAll(), fit: 'auto' });
    return;
  }
  const placement = fitPlacementFor(natural, box);
  const scale = viewport.zoomTo(placement.scale);
  applyPlacement(drawing, placement);
  applyZoom({ scale, fit: 'auto' });
};

// The owner publishes the mode the panel needs (the condition under which a
// fullscreen toggle may re-fit): a new parent render identity is just a new
// callback slot, never a second write path. The two drawing-bound actions are
// re-bound every render so they close over the latest props and refs.
useEffect(() => {
  viewportController.setActions({
    fit: fitDiagram,
    autoFit: runAutoFit,
    onZoomModeChange,
  });
});

// A fit request comes from the PANEL's own size change (the fullscreen
// overlay swaps the region's `flex-1` for `fixed; inset: 0`). The owner
// answers each token once, and only while it is in Fit mode: the overlay must
// not undo a manual zoom. `force` is the fresh-analysis case: the content the
// reader had zoomed is gone, so the panel asks for a fit.
useEffect(() => {
  viewportController.requestFit(fitRequest);
}, [fitRequest, viewportController]);

  return { runAutoFit, zoomToScale, zoomByStep, fitDiagram };
}
