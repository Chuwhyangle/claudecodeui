/**
 * The canvas DRAW effect: ONE complete layout + render of the current graph.
 *
 * Extracted from `PlantUmlGraph.tsx` unchanged (residual-oversize split,
 * `gap-routine-architecture-analysis-architecture-panel-plantuml-residual-oversize`):
 * this is the DOM-bound half of the drawing pipeline. It imports the renderer
 * lazily (so the first-screen bundle keeps its async chunk), asks the layout
 * owner which orientation to draw, writes the SVG into the host and then
 * applies every post-render annotation the panel relies on (member caps,
 * selection, diff markers, sticky labels, hit targets).
 *
 * The hook owns no state: every reading it writes goes through the owners
 * passed in `args`, so the component keeps rendering their snapshots and the
 * draw ordering is byte-for-byte the effect it replaces.
 */
import { useEffect, type RefObject } from 'react';

import type { ArchitectureRendererEdge, ArchitectureNodeIdShape, ArchitectureRendererGraph, ArchitectureDiffHighlight } from '@/modules/architecture/dom/rendererContract';
import type { ArchitectureDiagramView } from '@/modules/architecture/layout/plantuml/archguardToPlantUml';
import type { GraphGestureController } from '@/modules/architecture/dom/interaction/graphGestureController';
import type { GraphSelectionController } from '@/modules/architecture/dom/interaction/graphSelectionController';
import type { GraphLayoutPipeline, GraphLayoutSnapshot } from '@/modules/architecture/layout/drawing/graphLayoutPipeline';
import type { GraphViewportController, GraphZoom } from '@/modules/architecture/layout/drawing/graphViewportController';
import type { SvgFitPlacement, SvgViewportSize } from '@/modules/architecture/layout/engine/svgViewport';
import type {
  PlantUmlApplyView,
  PlantUmlRenderDetailed,
  PlantUmlToPlantUml,
  SemanticCapture,
} from '@/modules/architecture/layout/drawing/graphDom';
import type { SemanticZoomLayout } from '@/modules/architecture/layout/engine/semanticZoomLayout';
import { archguardToPlantUml, parserSafePlantUml } from '@/modules/architecture/layout/plantuml/archguardToPlantUml';
import { standardiseDrawnStereotypes } from '@/modules/architecture/layout/plantuml/plantUmlText';
import {
  createLayoutEngine,
  type ArchitectureLayoutEngineClass,
} from '@/modules/architecture/layout/engine/elkAspectEngine';
import {
  graphFingerprint,
  type LayoutOrientation,
} from '@/modules/architecture/dom/planning/layoutOrientation';
import { semanticContentBounds } from '@/modules/architecture/layout/engine/semanticZoomLayout';
import { LAYOUT_STATUS_THRESHOLD_MS } from '@/modules/architecture/layout/drawing/graphLayoutPipeline';
import { capDrawnMemberRows, drawnFitScaleOf } from '@/modules/architecture/layout/drawing/drawnFit';
import { SEMANTIC_MIN_FONT_MOBILE_PX, SEMANTIC_MIN_FONT_PX } from '@/modules/architecture/dom/planning/semanticZoomPlan';
import { canvasIsTooWide } from '@/modules/architecture/layout/engine/readableZoom';
import { centerElementInContainer, measureViewportSize } from '@/modules/architecture/layout/engine/svgViewport';
import {
  addEdgeHitTargets,
  addNodeHitTargets,
  annotateNodes,
  captureSemanticDrawing,
  drawingKeyOf,
  drawStickyLabels,
  hideEdgeLabels,
  highlightSelection,
  markDrawingUnselectable,
  measureLayoutAspect,
  nodeElement,
  positionOverviewHint,
  rendererOptionsFor,
  restoreEntityIds,
  reverseAliases,
} from '@/modules/architecture/layout/drawing/graphDom';
import {
  afterPaint,
  applyDiffStyles,
  drawnMemberLimits,
  forcedLayoutOrientation,
  layoutSizeOf,
  pinFocusMarker,
  renderWithMemberDetail,
} from '@/modules/architecture/render/viewport/plantUmlNavigation';

/**
 * Every reading the draw effect closes over. The three controllers and the two
 * refs are the owners; the callbacks are the drawing-bound half the pipeline
 * cannot perform itself.
 */
export type PlantUmlDrawingArgs = {
  readonly hostRef: RefObject<HTMLDivElement | null>;
  readonly graph: ArchitectureRendererGraph;
  readonly view: ArchitectureDiagramView;
  readonly idShape: ArchitectureNodeIdShape;
  readonly coarsePointer: boolean;
  readonly entityGraph: boolean;
  readonly focusNodeId: string | null;
  readonly layoutPipeline: GraphLayoutPipeline;
  readonly layoutSnapshot: GraphLayoutSnapshot;
  readonly gestureController: GraphGestureController;
  readonly selectionController: GraphSelectionController;
  readonly viewportController: GraphViewportController;
  readonly diffHighlightRef: { current: ArchitectureDiffHighlight | null };
  readonly applyPlacement: (drawing: SVGSVGElement | null, placement: SvgFitPlacement | null) => void;
  readonly applyZoom: (next: GraphZoom) => boolean;
  readonly controllerZoom: () => GraphZoom;
  readonly fitPlacementFor: (natural: SvgViewportSize, box: SvgViewportSize) => SvgFitPlacement;
  readonly naturalOfDrawing: (drawing: SVGSVGElement | null) => SvgViewportSize | null;
  readonly paintSelectionStyles: (
    host: HTMLElement,
    nodeIds: readonly string[],
    relations: readonly ArchitectureRendererEdge[],
  ) => void;
  readonly setDrawn: (
    next: { readonly view: ArchitectureDiagramView; readonly nodes: number; readonly edges: number } | null,
  ) => void;
  readonly setFailure: (next: string | null) => void;
  readonly setLayoutMs: (next: number | null) => void;
  readonly setCollapsedNotice: (next: boolean) => void;
  readonly setView: (next: ArchitectureDiagramView) => void;
  readonly applySemanticLayout: (
    host: HTMLElement,
    capture: SemanticCapture,
    layout: SemanticZoomLayout,
    fontPx: number,
  ) => void;
};

/** Draw the current graph into `args.hostRef` and annotate it. */
export function usePlantUmlDrawing(args: PlantUmlDrawingArgs): void {
  const {
    hostRef,
    graph,
    view,
    idShape,
    coarsePointer,
    entityGraph,
    focusNodeId,
    layoutPipeline,
    layoutSnapshot,
    gestureController,
    selectionController,
    viewportController,
    diffHighlightRef,
    applyPlacement,
    applyZoom,
    controllerZoom,
    fitPlacementFor,
    naturalOfDrawing,
    paintSelectionStyles,
    setDrawn,
    setFailure,
    setLayoutMs,
    setCollapsedNotice,
    setView,
  } = args;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    let cancelled = false;
    const viewKey = drawingKeyOf(view);
    // A pending application belongs to the drawing being replaced; the new one
    // is applied synchronously below.
    layoutPipeline.beginDrawing();
    setFailure(null);
    gestureController.getHandlers().onNodeHover?.(null);
    // A reloaded graph may not contain the previously selected entity.
    const previousSelection = selectionController.getSnapshot().primaryNodeId;
    if (previousSelection !== null && !graph.nodes.some((node) => node.id === previousSelection)) {
      selectionController.clearSelection();
    }

    void (async () => {
      try {
        // The only plantuml-js/elkjs import in the module graph: Vite emits it
        // as its own async chunk, so the first-screen bundle stays untouched.
        const { renderDetailed, toPlantUml, applyView, ElkLayoutEngine } =
          (await import('@yalehwang/plantuml-js/elk')) as unknown as {
            renderDetailed: PlantUmlRenderDetailed;
            toPlantUml: PlantUmlToPlantUml;
            applyView: PlantUmlApplyView;
            ElkLayoutEngine: ArchitectureLayoutEngineClass;
          };
        if (cancelled) return;

        // The container's shape is a LAYOUT input, not a post-render scale: the
        // engine is CONSTRUCTED with it so ELK draws for this container instead
        // of for its own default proportions.
        const drawnAspect = layoutSnapshot.layoutAspect ?? measureLayoutAspect(host);
        // The panel is the adaptive consumer for the FILE graph: the bridge
        // collapses its directory layers itself (the renderer's
        // `groupByPathPrefix` would count a file name as a layer, which is the
        // bug this view exists to avoid). The CLASS graph is never folded: its
        // entities are what the reader asked to see, and the layout budget —
        // not a directory fold — keeps the drawing inside the node bound. The
        // panel also states how this subgraph's ids are shaped, so a file graph
        // keeps its top directory in every group prefix and label.
        const diagram = archguardToPlantUml(graph, {
          view,
          grouping: entityGraph ? 'raw' : 'adaptive',
          idShape,
        });
        // Layout + render is the expensive, blocking part (ELK runs on the main
        // thread); its duration is the DoD's per-view reading. `renderDetailed`
        // runs the same pipeline but hands back the model that was actually
        // drawn, which the text page serializes (see `onDrawnPlantUmlChange`).
        //
        // The layout cannot be interrupted or progressed: once it starts, the
        // main thread belongs to ELK until it returns. So the reading it is
        // ABOUT to cost (this drawing's entity count times the last layout of
        // the same kind, see `estimateLayoutMs`) is taken first, and a layout
        // expected to take more than a second announces itself and yields a
        // frame, so the status is ON SCREEN before the block begins. The
        // previous drawing stays in the host throughout: nothing replaces it
        // until the new SVG is ready.
        const layoutNodes = graph.nodes.length;
        const estimate = layoutPipeline.estimateLayoutMs(idShape, layoutNodes);
        const announce = estimate > LAYOUT_STATUS_THRESHOLD_MS;
        if (announce) {
          layoutPipeline.setLayoutStatus(layoutNodes);
          await afterPaint();
          if (cancelled) {
            layoutPipeline.setLayoutStatus(null);
            return;
          }
        }

        /**
         * One complete layout + render in one direction. The engine comes from
         * the single factory either way, so `direction` is a LAYOUT input (an
         * `elk.direction` option) and never a post-render transform.
         */
        const renderOnce = (direction?: LayoutOrientation): ReturnType<typeof renderWithMemberDetail> => {
          const engine = createLayoutEngine({
            aspectRatio: drawnAspect,
            ...(direction === undefined ? {} : { direction }),
            Engine: ElkLayoutEngine,
          });
          return renderWithMemberDetail(
            renderDetailed,
            // The document the reader copies uses real stereotypes
            // (`class "X" as n0 <<function>>`); the bundled parser needs that
            // token before the alias, so the DRAWING gets the parser-safe
            // spelling. `standardiseDrawnStereotypes` reverses it when the drawn
            // model is serialized for the text page.
            parserSafePlantUml(diagram.puml),
            {
              ...rendererOptionsFor(view, diagram, engine),
              // The box is sized from the text the renderer will PAINT: a member
              // line longer than MEMBER_MAX_CHARS is drawn with a trailing `…`,
              // BEFORE layout, so the width follows what the screen shows. Only
              // the LINES are capped here — the row cap (`MEMBER_MAX_ROWS`) is a
              // drawing rule applied after render, so no folded row ever enters
              // the model. `raw` keeps the full declaration for the Text page,
              // copy and Inspector.
              ...drawnMemberLimits(),
            },
          );
        };

        // The direction policy (see `layoutOrientation.ts`) lives in the
        // pipeline owner: draw the graph downward, and — only for a small graph
        // on a canvas clearly wider than that drawing — draw it once more to
        // the RIGHT, keeping whichever the canvas can show larger. The decision
        // is cached per graph + canvas band, so a shape-driven re-layout reuses
        // it instead of laying the graph out twice again.
        const canvasBox = measureViewportSize(host);
        const outcome = await layoutPipeline.orientLayout({
          fingerprint: graphFingerprint(graph, viewKey, idShape),
          canvas: canvasBox,
          entities: layoutNodes,
          forced: forcedLayoutOrientation(),
          render: async (direction) => {
            const startedAt = performance.now();
            const rendered = await renderOnce(direction === 'DOWN' ? undefined : direction);
            const renderedMs = Math.round(performance.now() - startedAt);
            return {
              size: layoutSizeOf(rendered),
              // Paid only when a second candidate exists (see the pipeline).
              drawnFitScale: () => {
                if (canvasBox === null) return null;
                const fontPx = gestureController.isCoarsePointer()
                  ? SEMANTIC_MIN_FONT_MOBILE_PX
                  : SEMANTIC_MIN_FONT_PX;
                return drawnFitScaleOf(rendered, graph, canvasBox, fontPx);
              },
              elapsedMs: renderedMs,
              drawn: { rendered, elapsedMs: renderedMs },
            };
          },
        });
        if (cancelled) return;
        const detailed = outcome.drawn.rendered;
        const elapsedMs = outcome.drawn.elapsedMs;
        // The next layout of this kind is estimated from this one: the sample is
        // the drawing kind's own, never another kind's. The orientation itself
        // is published by the policy as part of the layout reading, so a reader
        // (and the criterion's control arm) can tell the two layouts apart.
        layoutPipeline.recordLayoutSample(idShape, { nodes: layoutNodes, ms: elapsedMs });

        const { svg, model } = detailed;
        host.innerHTML = svg;
        // The row cap is a DRAWING rule (`MEMBER_MAX_ROWS`): it removes the
        // surplus rows from the DOM and paints the app's own fold label, so the
        // model the text page serializes keeps every authored member.
        capDrawnMemberRows(host);
        // The renderer's own `.uml-canvas` rectangle paints a paper colour
        // sized to the drawing. Against the panel's background that reads as a
        // second background with a seam around it, on every view — not only the
        // semantically rewritten one (which re-applies this after each pass).
        for (const canvasRect of host.querySelectorAll<SVGRectElement>('svg .uml-canvas')) {
          canvasRect.setAttribute('fill', 'none');
        }
        setLayoutMs(elapsedMs);
        // The new drawing is in the host, so the layout the status described is
        // over: it is cleared in this same commit. A state write here is safe
        // because the drawing the reader now sees is already the new one.
        layoutPipeline.setLayoutStatus(null);
        // The text page reads this: the model just drawn, plus the upstream
        // functions that serialize and scope it. `diagram.aliasOf` is the
        // graph-id (and overview `grp::` group) → drawn entity id map.
        gestureController.getHandlers().onDrawnChange?.({
          model,
          entityIdOf: diagram.aliasOf,
          // The drawn model names each function `<<function>> Name` (the
          // parser-safe spelling it was rendered from); the copied document
          // must carry the stereotype as a real token instead.
          toPlantUml: (drawnModel) => standardiseDrawnStereotypes(toPlantUml(drawnModel)),
          applyView,
        });
        restoreEntityIds(host, diagram.aliasOf);
        // Labels are off until a node is hovered/selected, and every entity
        // box carries its source file + seed marker (see `annotateNodes`).
        hideEdgeLabels(host);
        annotateNodes(host, graph, idShape);
        // Relations get their enlarged, invisible hit bands; the panel's
        // selection is repainted on top of the fresh drawing.
        addEdgeHitTargets(host, coarsePointer);
        // A drawing that is semantically zoomed is captured BEFORE any
        // selection decoration: every later application restores this snapshot,
        // so no decoration can accumulate. The grouped overview (a directory
        // map, not a UML drawing) keeps the ordinary CSS-scaled viewport.
        const semanticEligible = !diagram.grouped && !(view.kind === 'overview' && !entityGraph);
        const capture = semanticEligible ? captureSemanticDrawing(host, graph) : null;
        // One write path: the owner drops the replaced drawing's applied layout,
        // tier, status and neighbourhood centre, and records the ratio this
        // drawing was laid out with.
        layoutPipeline.markDrawn({ viewKey, capture, aspect: drawnAspect });
        const viewportForMode = viewportController.viewport();
        // The semantic base size is the SAME boundary the canvas will draw
        // (`semanticContentBounds`), not the renderer's pre-semantic viewBox:
        // the fit reading and the minimap must measure what is on screen.
        viewportForMode?.setSemanticMode(
          capture === null ? null : semanticContentBounds(capture.geometry),
        );
        paintSelectionStyles(
          host,
          selectionController.getSnapshot().panel.nodeIds,
          selectionController.getSnapshot().panel.relations,
        );
        applyDiffStyles(host, diffHighlightRef.current);
        // Every view has its own natural size, so the scale is re-derived here
        // rather than carried over; the fit/custom MODE survives so the resize
        // observer keeps following the container only for a fit user.
        //
        // The default is not "fit everything" any more: a fit below the
        // readable floor would draw sub-pixel labels, so the readable policy
        // focuses the densest seeded package at a legible scale instead. The
        // overview toggle still offers the explicit whole-graph fit.
        const drawing = host.querySelector('svg');
        if (drawing !== null) {
          // Vertical centring lives here, not in the CSS sheet: the host is a
          // flex column and the drawing owns the auto block margins, so a short
          // drawing is centred while a taller one (negative free space) starts
          // at the top and scrolls. `flex: none` keeps the explicit width/height
          // the viewport writes from being shrunk along the column's main axis.
          drawing.style.marginTop = 'auto';
          drawing.style.marginBottom = 'auto';
          drawing.style.flex = 'none';
        }
        const viewport = viewportController.viewport();
        if (drawing !== null && viewport !== null) {
          viewport.attach(drawing);
          const natural = naturalOfDrawing(drawing);
          const box = measureViewportSize(host);
          // A canvas several times wider than its container is a band, not a
          // diagram: collapse it to the directory overview and say so. Only the
          // file graph's explosion view can reach this — its overview is the
          // coarser drawing. The class view has NO coarser drawing to fall back
          // to, so it keeps its hierarchy.
          const aspectBounds = capture === null ? natural : semanticContentBounds(capture.geometry);
          if (view.kind === 'hierarchy' && !entityGraph
            && aspectBounds !== null && box !== null && canvasIsTooWide(aspectBounds, box)) {
            setCollapsedNotice(true);
            setView({ kind: 'overview' });
          } else if (view.kind === 'hierarchy') {
            setCollapsedNotice(false);
          }
          if (capture === null) {
            // The ordinary CSS-scaled drawing (a grouped directory map). `auto`
            // fits the whole drawing down to the manual floor; `manual` keeps
            // the reader's own scale. Either way the placement re-centres it.
            const placement = natural === null ? null : fitPlacementFor(natural, box ?? { width: 0, height: 0 });
            const drawnScale = controllerZoom().fit === 'auto'
              ? viewport.zoomTo(placement?.scale ?? controllerZoom().scale)
              : viewport.zoomTo(controllerZoom().scale);
            applyPlacement(drawing, placement);
            applyZoom({ scale: drawnScale, fit: controllerZoom().fit });
            // A fresh drawing is a new whole-graph view; a package zoom from
            // the previous one no longer names a frame on screen.
            viewportController.setPackageFocus(null);
          }
        }
        // A fresh SVG has no highlight classes; re-pin the current selection.
        highlightSelection(host, selectionController.getSnapshot().primaryNodeId);
        if (view.kind === 'neighborhood') {
          const center = diagram.rendererEntity;
          if (center !== null) {
            const id = reverseAliases(diagram.aliasOf).get(center);
            if (id !== undefined) {
              layoutPipeline.setNeighborCenter(id);
              nodeElement(host, id)?.classList.add('arch-center');
            }
          }
        }
        // A new drawing gets its semantic layout applied synchronously, so it
        // never flashes at the wrong detail before the debouncer fires. The
        // sticky fit state decides how: `auto` re-solves the scale against the
        // new drawing's canvas, `manual` keeps the reader's scale.
        if (capture === null) {
          // A drawing with no semantic pass still needs its coarse-pointer hit
          // rectangles; the captured path lays them down inside
          // `applySemanticLayout`, after the rewrite rebuilt the nodes.
          addNodeHitTargets(host, coarsePointer);
        } else {
          // The new drawing is applied through ONE path, so the draw and the
          // settled-zoom/resize paths can never disagree about which scale is
          // on screen.
          layoutPipeline.applySemantic({ fit: controllerZoom().fit === 'auto', scale: controllerZoom().scale });
        }
        // A focus request (search hit) is centred LAST: the reader asked for
        // THIS node, so it wins. The marker is what tests and sibling panels
        // read; the scroll is the actual "jump to it".
        const focused = pinFocusMarker(host, focusNodeId);
        if (focused !== null) centerElementInContainer(host, focused);
        // Every scroll above has landed: place the sticky package names and the
        // overview hint against the viewport the reader will actually see.
        const applied = layoutPipeline.getSnapshot();
        if (applied.appliedLayout !== null && applied.semanticCapture !== null) {
          drawStickyLabels(host, applied.appliedLayout, applied.appliedFontPx);
          positionOverviewHint(host);
        }
        setDrawn({
          view,
          nodes: host.querySelectorAll('[data-entity-id]').length,
          edges: host.querySelectorAll('[data-edge-source]').length,
        });
        // LAST DOM write of the drawing: every label, badge and hit band is in
        // place, so the unselectable declaration covers the finished drawing.
        markDrawingUnselectable(host);
      } catch (error) {
        if (cancelled) return;
        host.innerHTML = '';
        setDrawn(null);
        setLayoutMs(null);
        // The layout ended — badly — so the status that described it must not
        // outlive it; the failure line below is the reader's explanation.
        layoutPipeline.failDrawing();
        // The previous drawing is gone; the text page must not keep describing it.
        gestureController.getHandlers().onDrawnChange?.(null);
        setFailure(error instanceof Error ? error.message : 'unknown render error');
      }
    })();

    return () => {
      cancelled = true;
      // A superseded/unmounted drawing no longer describes the page's canvas.
      // The text page debounces its rebuild, so a redraw settling quickly never
      // flashes the bridge fallback.
      gestureController.getHandlers().onDrawnChange?.(null);
      // A status belongs to the layout that set it; the run replacing this one
      // decides again whether to announce (and clears it again when it ends).
      layoutPipeline.setLayoutStatus(null);
    };
  }, [applyPlacement, applyZoom, controllerZoom, coarsePointer, entityGraph, fitPlacementFor, focusNodeId, gestureController, graph, idShape, layoutPipeline, layoutSnapshot.layoutAspect, naturalOfDrawing, view, viewportController]);
}
