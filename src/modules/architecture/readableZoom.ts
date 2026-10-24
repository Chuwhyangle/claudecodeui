import type { SvgViewportSize } from '@/modules/architecture/svgViewport';

/**
 * What remains of the readable-zoom policy after the single-scale contract.
 *
 * The canvas no longer chooses between a "focus" crop and a whole-graph
 * overview: the semantic layout engine owns the ONLY scale (`s`, applied to the
 * geometry) and Fit solves that scale against the canvas. Two readings are
 * still needed from this module:
 *
 *  · the readable floor constants, from which the viewport's minimum fit scale
 *    is derived (a CSS-scaled drawing still must not smear its labels);
 *  · the band test that collapses a drawing many times wider than its
 *    container to the coarser directory overview instead of drawing a
 *    one-pixel-tall strip.
 *
 * The focus decision, its persisted per-project choice and the session-seed
 * hierarchy that ranked a focus package are gone: none of them has a consumer
 * now that Fit is a solve and the drawing opens at the whole graph.
 *
 * Consumers: `svgViewport.ts` (the fit floor) and `PlantUmlGraph.tsx` (the
 * band-collapse test).
 */

/** The renderer's node-label font size, in SVG user units at 100% zoom. */
export const RENDERED_LABEL_FONT_PX = 13;

/** The smallest on-screen label that still reads as text rather than a smear. */
export const MIN_READABLE_FONT_PX = 9;

/**
 * The scale at which a rendered 13px label occupies 9 CSS pixels. Below this a
 * CSS-fitted drawing is technically complete but practically unreadable, which
 * is why the viewport's fit floor is this value rather than the manual 5%.
 */
export const READABLE_ZOOM_SCALE = MIN_READABLE_FONT_PX / RENDERED_LABEL_FONT_PX;

/**
 * How much wider than its container a drawing may be before it is a band rather
 * than a diagram. Expressed as the quotient of the two aspect ratios, so it is
 * independent of whether the container is landscape or portrait: a 17:1 drawing
 * in a 1.6:1 panel is ~10.8 and collapses; a 2:1 drawing in the same panel is
 * ~1.25 and is left alone.
 */
export const WIDE_CANVAS_ASPECT_RATIO = 6;

/**
 * The vocabulary the drawn readout still names. `graphDom.ts` models the zoom
 * hint with these two types; the contract retired their producers, so nothing
 * in this module constructs a decision any more.
 */
export type ReadableZoomMode = 'focus' | 'overview';

/** The values the (now retired) overview hint carried; kept as a public shape. */
export type ReadableZoomHint = {
  readonly packageId: string;
  readonly packageCount: number;
  readonly zoomPercent: number;
};

/**
 * Whether a drawing is a band in this container: its natural aspect ratio is
 * more than `threshold` times the container's. An unmeasured container or a
 * degenerate size is `false` — a missing measurement is not evidence of a band.
 */
export function canvasIsTooWide(
  natural: SvgViewportSize,
  viewport: SvgViewportSize,
  threshold: number = WIDE_CANVAS_ASPECT_RATIO,
): boolean {
  if (!(natural.width > 0) || !(natural.height > 0)) return false;
  if (!(viewport.width > 0) || !(viewport.height > 0)) return false;
  const naturalAspect = natural.width / natural.height;
  const containerAspect = viewport.width / viewport.height;
  return naturalAspect / containerAspect > threshold;
}
