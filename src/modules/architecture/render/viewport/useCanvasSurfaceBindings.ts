/**
 * The canvas SURFACE bindings: the layout pipeline's action slot, the viewport
 * mode/dispose bindings, the sticky-label re-placement and the four input
 * families the host binds directly (touch gestures, mouse/pen pan, the
 * text-selection guard, the Shift capture and the marquee).
 *
 * Extracted from `PlantUmlGraph.tsx` unchanged (residual-oversize split,
 * `gap-routine-architecture-analysis-architecture-panel-plantuml-residual-oversize`).
 * Each effect forwards to an owner; none of them owns state.
 */
import { useEffect, type RefObject } from 'react';

import type { GraphGestureController } from '@/modules/architecture/dom/graphGestureController';
import type { GraphSelectionController } from '@/modules/architecture/dom/graphSelectionController';
import type { GraphLayoutPipeline, GraphLayoutCommit } from '@/modules/architecture/layout/graphLayoutPipeline';
import type { GraphViewportController, GraphZoom } from '@/modules/architecture/layout/graphViewportController';
import type { SvgViewportSize } from '@/modules/architecture/layout/svgViewport';
import {
  createSvgDragPan,
  createSvgTouchGestures,
  createSvgViewport,
} from '@/modules/architecture/layout/svgViewport';
import { measureLayoutAspect, drawStickyLabels, positionOverviewHint } from '@/modules/architecture/layout/graphDom';
import { SEMANTIC_MIN_FONT_MOBILE_PX, SEMANTIC_MIN_FONT_PX } from '@/modules/architecture/dom/semanticZoomPlan';
import { forcedDefaultFocus } from '@/modules/architecture/render/viewport/plantUmlControlArm';

/** Every reading the surface bindings close over. */
export type CanvasSurfaceBindingArgs = {
  readonly hostRef: RefObject<HTMLDivElement | null>;
  readonly layoutPipeline: GraphLayoutPipeline;
  readonly viewportController: GraphViewportController;
  readonly gestureController: GraphGestureController;
  readonly selectionController: GraphSelectionController;
  readonly commitSemantic: (commit: GraphLayoutCommit) => void;
  readonly applyZoom: (next: GraphZoom) => boolean;
  readonly currentFitViewport: (host: HTMLElement) => SvgViewportSize | null;
  readonly recordFitViewport: (box: SvgViewportSize | null) => void;
  readonly exitEntityNavigation: (host: HTMLElement) => void;
};

/** Bind every pending drawing-bound action slot the owners re-read each render. */
export function useCanvasSurfaceBindings(args: CanvasSurfaceBindingArgs): void {
  const {
    hostRef,
    layoutPipeline,
    viewportController,
    gestureController,
    selectionController,
    commitSemantic,
    applyZoom,
    currentFitViewport,
    recordFitViewport,
    exitEntityNavigation,
  } = args;

// The pipeline owns WHICH layout is drawn and WHEN; these actions are the
// DOM-bound half it cannot do itself. Re-registered per render so a callback
// identity change reaches the owner without re-creating it.
useEffect(() => {
  layoutPipeline.setActions({
    fitViewport: () => (hostRef.current === null ? null : currentFitViewport(hostRef.current)),
    recordFitViewport,
    semanticFontPx: () =>
      gestureController.isCoarsePointer() ? SEMANTIC_MIN_FONT_MOBILE_PX : SEMANTIC_MIN_FONT_PX,
    commitSemantic,
    measureAspect: () => (hostRef.current === null ? null : measureLayoutAspect(hostRef.current)),
    forcedDefaultFocus,
  });
}, [layoutPipeline, commitSemantic, currentFitViewport, recordFitViewport, gestureController]);
// The viewport controller lives in the owner: it survives the renderer
// replacing the SVG (each render re-attaches), so the mode and scale outlive
// a single drawing, while the owner clears its debounce timer on unmount.
useEffect(() => {
  const host = hostRef.current;
  if (host === null) return;
  viewportController.attachViewport(createSvgViewport(host));
  return () => {
    viewportController.attachViewport(null);
  };
}, [viewportController]);
useEffect(() => () => viewportController.dispose(), [viewportController]);

// A sticky package name belongs to the VIEWPORT, not to the drawing: panning
// must move the ghost labels with the reader, and must never leave one over a
// class name it no longer clears. Re-place them (and the hint) on the settled
// frame after each scroll, from the layout last applied.
useEffect(() => {
  const host = hostRef.current;
  if (host === null) return;
  let frame: number | null = null;
  const repaint = (): void => {
    frame = null;
    const applied = layoutPipeline.getSnapshot();
    if (applied.appliedLayout === null || applied.semanticCapture === null) return;
    drawStickyLabels(host, applied.appliedLayout, applied.appliedFontPx);
    positionOverviewHint(host);
  };
  const onScroll = (): void => {
    if (frame !== null) return;
    if (typeof window.requestAnimationFrame !== 'function') {
      repaint();
      return;
    }
    frame = window.requestAnimationFrame(repaint);
  };
  host.addEventListener('scroll', onScroll, { passive: true });
  return () => {
    host.removeEventListener('scroll', onScroll);
    if (frame !== null) window.cancelAnimationFrame(frame);
  };
}, [layoutPipeline]);

// Touch gestures ride on the SAME controller the toolbar and Ctrl+wheel use,
// so pinch never introduces a second zoom model. The host's `touch-action:
// none` (below) is what suppresses the browser's own page pan/zoom; that is
// also why the single-finger drag has to pan the container here.
useEffect(() => {
  const host = hostRef.current;
  const viewport = viewportController.viewport();
  if (host === null || viewport === null) return;
  const gestures = createSvgTouchGestures(host, viewport, {
    onZoom: (scale) => applyZoom({ scale, fit: 'manual' }),
  });
  return () => gestures.destroy();
}, [applyZoom, viewportController]);

// Mouse/pen panning rides on the same scroll container the touch gestures
// pan: left-drag from the blank canvas and middle-drag from anywhere scroll
// it. Presses on a node are refused so they stay selection/drill gestures,
// and fingers are left to `createSvgTouchGestures` — one pan, two input
// families, never two competing drag states.
// Shift+drag is the marquee (below): refusing a pan while Shift is held is
// what keeps the two drag readings from running at the same time.
useEffect(() => {
  const host = hostRef.current;
  if (host === null) return;
  const pan = createSvgDragPan(host, {
    canPanFrom: (target) => !gestureController.isShiftHeld()
      && !(target instanceof Element && target.closest('[data-entity-id]') !== null),
  });
  return () => pan.destroy();
}, [gestureController]);

// A press inside the drawing never starts the browser's own text selection.
// The `user-select` rules already refuse it, but a drag can begin on a label
// the browser treats as selectable content (and a selection that started
// OUTSIDE the canvas survives a drag over it), so the primary-button default
// is cancelled too — `mousedown`'s default action IS "begin a selection".
// Cancelling it does not cancel the `click` the drawing's own select/drill
// handlers ride on, and the wheel is a different event family entirely.
//
// The refusal is read from the PRESS TARGET's computed policy rather than
// assumed: only an element declared `user-select: none` has a selection worth
// refusing. A canvas whose policy is switched back to `auto` (the e2e control
// arm, or a future selectable-drawing mode) keeps the browser's own
// behaviour, which is what makes the criterion able to read a false.
//
// `preventDefault` also suppresses the focus a press would give the scroll
// host, so the host is focused explicitly: click-then-arrow-keys keeps
// panning the way it did before this guard existed.
useEffect(() => {
  const host = hostRef.current;
  if (host === null || typeof window === 'undefined') return;
  const onMouseDown = (event: MouseEvent): void => {
    // Right/middle presses have their own browser meanings (context menu,
    // autoscroll) and never start a selection.
    if (event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target === null || window.getComputedStyle(target).userSelect !== 'none') return;
    event.preventDefault();
    const selection = window.getSelection();
    if (selection !== null && selection.rangeCount > 0) selection.removeAllRanges();
    if (document.activeElement !== host) host.focus({ preventScroll: true });
    // A pointer press is not the keyboard: leaving the navigation state
    // clears the ring and the active descendant. The modality gate above
    // keeps the focus this press just gave the host from re-entering it.
    if (selectionController.getSnapshot().navigationActive) exitEntityNavigation(host);
  };
  host.addEventListener('mousedown', onMouseDown);
  return () => host.removeEventListener('mousedown', onMouseDown);
}, []);

// Whether Shift is held, kept fresh by a window CAPTURE listener: the capture
// phase runs before the canvas's own bubble listeners, so the drag-pan
// predicate reads the modifier of the very press that starts the gesture.
useEffect(() => {
  if (typeof window === 'undefined') return;
  const record = (event: KeyboardEvent | PointerEvent): void => {
    gestureController.recordModifier(event.shiftKey);
  };
  window.addEventListener('keydown', record, true);
  window.addEventListener('keyup', record, true);
  window.addEventListener('pointerdown', record, true);
  return () => {
    window.removeEventListener('keydown', record, true);
    window.removeEventListener('keyup', record, true);
    window.removeEventListener('pointerdown', record, true);
  };
}, [gestureController]);

// Which input modality is about to move focus. Read by the host's focus
// handler: Tab (a keydown) is the only way into entity navigation; a press
// focuses the host for click-then-arrow panning and must not paint a ring.
useEffect(() => {
  if (typeof window === 'undefined') return;
  const fromPointer = (): void => selectionController.setFocusModality('pointer');
  const fromKeyboard = (): void => selectionController.setFocusModality('keyboard');
  window.addEventListener('pointerdown', fromPointer, true);
  window.addEventListener('keydown', fromKeyboard, true);
  return () => {
    window.removeEventListener('pointerdown', fromPointer, true);
    window.removeEventListener('keydown', fromKeyboard, true);
  };
}, []);

// Shift+drag marquee: the gesture owner keeps the rectangle (in canvas
// coordinates, so the overlay follows the pointer exactly), decides whether a
// release travelled far enough to be a marquee, and reports the hit set. This
// effect only binds the pointer family and forwards it.
useEffect(() => {
  const host = hostRef.current;
  if (host === null || typeof window === 'undefined') return;
  const onDown = (event: PointerEvent): void => {
    if (gestureController.pointerDown({
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      button: event.button,
      shiftKey: event.shiftKey,
      clientX: event.clientX,
      clientY: event.clientY,
    })) event.preventDefault();
  };
  const onMove = (event: PointerEvent): void => {
    if (gestureController.pointerMove({
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
    })) event.preventDefault();
  };
  const onUp = (event: PointerEvent): void => {
    gestureController.pointerUp({
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
    });
  };
  const onCancel = (event: PointerEvent): void => {
    gestureController.pointerCancel(event.pointerId);
  };

  host.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  return () => {
    host.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
  };
}, [gestureController]);
}
