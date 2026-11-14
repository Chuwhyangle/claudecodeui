/**
 * The direction policy's DRAWING-side readings.
 *
 * `layoutOrientation.ts` compares two candidate layouts by the fit a reader
 * would actually see, but the renderer's own geometry still counts the blank
 * body of class frames whose member rows are not drawn. The semantic pass
 * reclaims that body (`planMemberRows` / `semanticZoomLayout.ts`), so the two
 * candidates must each be solved here — against the returned SVG, before it is
 * injected into the host — and compared post-reclaim.
 *
 * The row cap is part of that reading: it is a DRAWING rule applied before the
 * semantic capture, so the detached measurement must apply the same rule or it
 * plans rows nothing paints.
 *
 * These helpers live beside `PlantUmlGraph.tsx` rather than inside it because
 * the panel is ratcheted by size (`architecture-ratchet.test.ts`); the renderer
 * re-exports {@link capDrawnMemberRows} so its existing consumers are unchanged.
 */

import { MEMBER_MAX_ROWS, memberOverflowLabel } from '@/modules/architecture/layout/plantuml/archguardToPlantUml';
import { captureSemanticDrawing } from '@/modules/architecture/layout/drawing/graphDom';
import type { OrientationSize } from '@/modules/architecture/dom/planning/layoutOrientation';
import {
  solveFitScale,
  type SemanticDrawingGeometry,
} from '@/modules/architecture/layout/engine/semanticZoomLayout';

/**
 * The fit scale one RENDERED layout direction would be painted at, measured on
 * the drawing the semantic pass actually produces — the blank body of frames
 * whose member rows are not drawn is reclaimed before this size is taken.
 *
 * The architecture direction policy (`layoutOrientation.ts`) compares two
 * directions with this reading instead of the renderer's natural sizes. Those
 * are pre-reclaim: a tall downward column collapses to a short strip once its
 * hidden rows are reclaimed, so comparing natural sizes can pick the direction
 * the canvas shows smaller.
 *
 * Returns the same scale `solveFitScale` would apply, so the comparison is the
 * fit the reader gets, not an approximation of it. A zero/empty geometry has
 * no fit and answers `0`.
 */
export function semanticDrawnFitScale(
  geometry: SemanticDrawingGeometry,
  viewport: { readonly width: number; readonly height: number },
  minFontPx?: number,
): number {
  const fit = solveFitScale(geometry, { viewport, minFontPx });
  return Number.isFinite(fit.scale) && fit.scale > 0 ? fit.scale : 0;
}

/**
 * The semantic fit scale a finished render would be PAINTED at, measured on the
 * drawing AFTER the semantic pass reclaims the blank body of frames whose
 * member rows are not drawn.
 *
 * The renderer's own layout size still counts the rows nothing draws, so the
 * direction policy must compare what the reader sees (see
 * `layoutOrientation.ts`), and the two candidates are each solved once here.
 * The geometry is read from the render's own SVG in a DETACHED holder: at
 * decision time the drawing has not been injected into the host, and the reader
 * is read-only.
 */
export function drawnFitScaleOf(
  detailed: { readonly svg: string },
  graph: Parameters<typeof captureSemanticDrawing>[1],
  viewport: OrientationSize,
  fontPx: number,
): number | null {
  const holder = document.createElement('div');
  holder.innerHTML = detailed.svg;
  // The row cap is a DRAWING rule applied before the semantic capture, so the
  // detached reading must apply the same rule or it plans rows nothing paints.
  capDrawnMemberRows(holder);
  const capture = captureSemanticDrawing(holder, graph);
  if (capture === null || capture.geometry.nodes.length === 0) return null;
  const scale = semanticDrawnFitScale(capture.geometry, viewport, fontPx);
  return scale > 0 ? scale : null;
}

/**
 * Cap the member ROWS the drawing shows, after layout and before the drawing is
 * captured for semantic zoom.
 *
 * This is the drawing layer's rule, not the renderer's: `memberMaxRows` would
 * write the fold row into `model.entities[].members` as a synthetic member, and
 * the Text page / a copied document must never state a member the source did
 * not declare. The renderer is asked only to shorten LINES (`memberMaxChars`);
 * here the surplus rows are removed from the DOM and replaced by the same
 * `… +N more (M members)` row the renderer would emit — which the read layer
 * already parses back into `memberTotal`, so the count survives the fold.
 *
 * Rows the entity does not exceed are left untouched, and a box keeps the
 * rect the layout gave it: the drawing is not re-laid out for a display rule.
 *
 * The label is the LONG form on purpose, and only here: the read layer parses
 * `… +N more (M members)` as the total source, so the marker survives the
 * semantic pass as a count. The semantic pass's own `… +N more` stays short —
 * if IT painted the long form, a re-read drawing would count the app's own row
 * as an upstream overflow and trip the "one marker only" guard.
 */
export function capDrawnMemberRows(host: HTMLElement): void {
  for (const group of host.querySelectorAll('.uml-node[data-entity-id]')) {
    const rows = [...group.querySelectorAll<SVGTextElement>('text.uml-attr, text.uml-op')];
    if (rows.length <= MEMBER_MAX_ROWS) continue;
    const hidden = rows.slice(MEMBER_MAX_ROWS);
    // The marker inherits the first hidden row's position and font attributes.
    const marker = hidden[0].cloneNode(false) as SVGTextElement;
    for (const row of hidden) row.remove();
    marker.textContent = memberOverflowLabel(hidden.length, rows.length);
    group.appendChild(marker);
  }
}
