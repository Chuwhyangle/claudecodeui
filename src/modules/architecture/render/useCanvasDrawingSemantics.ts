/**
 * The drawing's SEMANTIC write path: the per-view resets, the structural-diff
 * repaint, and the two callbacks that write a solved layout onto the captured
 * drawing (including the folded tier's omissions).
 *
 * Extracted from `PlantUmlGraph.tsx` unchanged (residual-oversize split,
 * `gap-routine-architecture-analysis-architecture-panel-plantuml-residual-oversize`).
 * The pipeline still owns WHICH layout is drawn and WHEN; these are only the
 * DOM-bound halves it cannot perform itself.
 */
import { useCallback, useEffect, type RefObject } from 'react';

import type { ArchitectureDiffHighlight, ArchitectureNodeIdShape } from '@/modules/architecture/dom/rendererContract';
import type { ArchitectureDiagramView } from '@/modules/architecture/layout/plantuml/archguardToPlantUml';
import type { GraphGestureController } from '@/modules/architecture/dom/interaction/graphGestureController';
import type { GraphSelectionController } from '@/modules/architecture/dom/interaction/graphSelectionController';
import type { GraphLayoutPipeline, GraphLayoutCommit, GraphLayoutSnapshot } from '@/modules/architecture/layout/drawing/graphLayoutPipeline';
import type { GraphZoom } from '@/modules/architecture/layout/drawing/graphViewportController';
import type { SemanticCapture } from '@/modules/architecture/layout/drawing/graphDom';
import type { SemanticZoomLayout } from '@/modules/architecture/layout/engine/semanticZoomLayout';
import { forcedFitCssFactor } from '@/modules/architecture/render/plantUmlControlArm';
import { applyDiffStyles, pinFocusMarker } from '@/modules/architecture/render/plantUmlNavigation';
import { addNodeHitTargets, defaultViewOf, drawSemanticLayout, drawStickyLabels, highlightSelection, markDrawingUnselectable, nodeElement, positionOverviewHint } from '@/modules/architecture/layout/drawing/graphDom';
import { applyZoomScale } from '@/modules/architecture/layout/engine/svgViewport';

/** Every reading the semantic write path closes over. */
export type CanvasDrawingSemanticsArgs = {
  readonly hostRef: RefObject<HTMLDivElement | null>;
  readonly view: ArchitectureDiagramView;
  readonly idShape: ArchitectureNodeIdShape;
  readonly focusNodeId: string | null;
  readonly setView: (next: ArchitectureDiagramView) => void;
  readonly diffHighlightRef: { current: ArchitectureDiffHighlight | null };
  readonly diffHighlight: ArchitectureDiffHighlight | null;
  readonly layoutPipeline: GraphLayoutPipeline;
  readonly layoutSnapshot: GraphLayoutSnapshot;
  readonly gestureController: GraphGestureController;
  readonly selectionController: GraphSelectionController;
  readonly applyZoom: (next: GraphZoom) => boolean;
  readonly paintSelectionStyles: (
    host: HTMLElement,
    nodeIds: readonly string[],
    relations: readonly { readonly from: string; readonly to: string }[],
  ) => void;
};

/** The two writers the draw effect and the pipeline binding call. */
export type CanvasDrawingSemantics = {
  readonly applySemanticLayout: (
    host: HTMLElement,
    capture: SemanticCapture,
    layout: SemanticZoomLayout,
    fontPx: number,
  ) => void;
  readonly commitSemantic: (commit: GraphLayoutCommit) => void;
};

/** Bind the semantic write path and return its two writers. */
export function useCanvasDrawingSemantics(args: CanvasDrawingSemanticsArgs): CanvasDrawingSemantics {
  const {
    hostRef,
    idShape,
    focusNodeId,
    setView,
    diffHighlight,
    diffHighlightRef,
    layoutPipeline,
    layoutSnapshot,
    gestureController,
    selectionController,
    applyZoom,
    paintSelectionStyles,
  } = args;

// Switching the class/file subgraph is a new drawing, so a drill-down state
// from the previous one must not be carried over: a neighbourhood opened in
// the class diagram used to reappear after switching to the file graph and
// back. The default view is the discriminator (hierarchy vs. overview).
useEffect(() => {
  if (!layoutPipeline.observeIdShape(idShape)) return;
  setView(defaultViewOf(idShape));
}, [idShape, layoutPipeline]);

// Repaint the structural diff whenever the panel hands a new set in, and after every draw:
// the two subgraphs (and the drill-down views) each rewrite the SVG, and a marker applied to
// the previous drawing is gone with it.
useEffect(() => {
  diffHighlightRef.current = diffHighlight;
  const host = hostRef.current;
  if (host !== null) applyDiffStyles(host, diffHighlight);
}, [diffHighlight, layoutSnapshot.drawnRevision]);

/**
 * Write one semantic layout onto the captured drawing, INCLUDING the folded
 * tier's omissions.
 *
 * The scale is the drawing's ONLY scale: `drawSemanticLayout` bakes the
 * engine's map into the geometry and sizes the SVG to the mapped content, so
 * the element is shown 1:1 (`k = 1`). No CSS factor is ever applied on top —
 * the retired Fit path multiplied the already-mapped drawing by
 * `min(1, canvas ÷ content)`, which is what made a 17 % map print 74 % and
 * push 10 px floor text down to 7.4 px.
 *
 * `drawSemanticLayout` also hands the folded tier the drawings it owns (it
 * drops whole sub-packages and every relation); those consequences live here
 * rather than in the DOM writer because they are the CALLER's view of the
 * layout.
 */
const applySemanticLayout = useCallback((
  host: HTMLElement,
  capture: SemanticCapture,
  layout: SemanticZoomLayout,
  fontPx: number,
): void => {
  drawSemanticLayout(host, capture, layout, fontPx);
  // The rewritten drawing rebuilds every node group's children, so the
  // coarse-pointer hit rectangles are laid down again on the geometry that is
  // actually on screen (they are not part of `capture.inner`, which stays the
  // undecorated snapshot).
  addNodeHitTargets(host, gestureController.isCoarsePointer());
  // The renderer's own `.uml-canvas` rectangle is a paper-coloured fill sized
  // to the mapped CONTENT. Once the geometry pass reshapes the drawing, that
  // leaves a white rectangle around the content with the panel's own
  // background showing outside it — the seam the review found on both
  // viewports. The rectangle is made transparent, so the canvas background IS
  // the panel's background; no second colour is painted anywhere.
  for (const canvasRect of host.querySelectorAll<SVGRectElement>('svg .uml-canvas')) {
    canvasRect.setAttribute('fill', 'none');
  }
  if (layout.foldDepth !== null) {
    const drawnPackages = new Set(layout.packages.map((entry) => entry.id));
    for (const group of host.querySelectorAll('.uml-package[data-package-id]')) {
      if (!drawnPackages.has(group.getAttribute('data-package-id') ?? '')) {
        (group as SVGGElement).style.display = 'none';
      }
    }
    // The folded tier draws packages only: the entity relations were mapped
    // for a geometry that no longer exists.
    for (const group of host.querySelectorAll('.uml-edge[data-edge-source]')) {
      (group as SVGGElement).style.display = 'none';
    }
  }
  // The DEV-only control-arm lever. Production builds do not contain this
  // branch; when an arm asks for it, the retired CSS factor is re-applied so
  // the arm can prove its min-font reading lands on the failing side.
  const controlFactor = forcedFitCssFactor();
  if (controlFactor !== null) applyZoomScale(capture.svg, controlFactor);
}, [gestureController]);

/**
 * Write a layout the pipeline solved onto the drawing, in the same order as
 * the old inline application: geometry first, then the viewport scale, then
 * the DOM readings that depend on the rewritten elements, and the sticky
 * labels LAST because they are positioned from the scroll offset written
 * just above them.
 */
const commitSemantic = useCallback((commit: GraphLayoutCommit): void => {
  const host = hostRef.current;
  if (host === null) return;
  const { capture, layout, fontPx } = commit;
  applySemanticLayout(host, capture, layout, fontPx);
  applyZoom({ scale: commit.scale, fit: commit.fit ? 'auto' : 'manual' });
  // A rewritten SVG is a fresh set of elements: re-pin the selection and the
  // unselectable declaration, exactly as the render effect does.
  const selection = selectionController.getSnapshot();
  paintSelectionStyles(host, selection.panel.nodeIds, selection.panel.relations);
  highlightSelection(host, selection.primaryNodeId);
  markDrawingUnselectable(host);
  applyDiffStyles(host, diffHighlightRef.current);
  const center = layoutPipeline.getSnapshot().neighborCenter;
  if (center !== null) nodeElement(host, center)?.classList.add('arch-center');
  pinFocusMarker(host, focusNodeId);
  // The zoom anchor is the densest window of the mapped layout, not the
  // bounding-box centre: on a sparse drawing the centre is blank space. A
  // "tap a package" request overrides it with that package's frame.
  const width = host.clientWidth;
  const height = host.clientHeight;
  if (width > 0 && height > 0) {
    const target = commit.centerPackage === null
      ? null
      : layout.packages.find((entry) => entry.id === commit.centerPackage) ?? null;
    if (target === null) {
      host.scrollLeft = Math.max(0, layout.anchor.x - width / 2);
      host.scrollTop = Math.max(0, layout.anchor.y - height / 2);
    } else {
      const centreX = target.frame.x - layout.content.x + target.frame.width / 2;
      const centreY = target.frame.y - layout.content.y + target.frame.height / 2;
      host.scrollLeft = Math.max(0, centreX - width / 2);
      host.scrollTop = Math.max(0, centreY - height / 2);
    }
  }
  // The sticky labels and the hint are positioned FROM the applied scroll
  // offset, so they are drawn after it (inside the pass reads the old one).
  drawStickyLabels(host, layout, fontPx);
  positionOverviewHint(host);
}, [applySemanticLayout, applyZoom, focusNodeId, layoutPipeline, selectionController]);

  return { applySemanticLayout, commitSemantic };
}
