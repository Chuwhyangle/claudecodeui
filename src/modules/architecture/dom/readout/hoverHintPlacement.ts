/**
 * Where the transient hover reading may be drawn on the canvas.
 *
 * The hint used to be pinned to the canvas's top-left corner (`left-3 top-3`).
 * The class drawing paints each package's TAB along the top edge of its frame,
 * so the pinned hint sat on top of the outer package's tabs and class names —
 * the one row of text the reader was aiming at. This module decides a position
 * from the geometry instead: the hint may not intersect a package tab, a class
 * name, or the canvas's own corner chrome, and it stays inside the canvas.
 *
 * Kept pure (plain rectangles in, a position out) so the rule is testable in
 * jsdom, where no layout engine exists to produce the rectangles: the panel
 * measures the live DOM and hands the boxes over.
 *
 * Used by `ArchitecturePanel`, which draws the hover hint over the drawing.
 */

/** A screen-space rectangle, in the shape `getBoundingClientRect` reports. */
export type ArchitectureHintRect = {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
};

/** The hint's size. A zero-area hint (jsdom) still gets the fallback corner. */
export type ArchitectureHintSize = {
  readonly width: number;
  readonly height: number;
};

/** A chosen position, in the canvas's own coordinates (already margin-applied). */
export type ArchitectureHoverHintPlacement = {
  readonly left: number;
  readonly top: number;
  /**
   * True when no candidate was free of obstacles and the least-covered
   * candidate was used. The caller draws it anyway (a hint under a tab is
   * better than no hint), but the reading stays honest about what happened.
   */
  readonly overlapsObstacle: boolean;
};

/** How far the hint keeps from the canvas edges by default, in CSS pixels. */
export const HOVER_HINT_MARGIN_PX = 8;

/** How far each candidate steps towards the other edge, in CSS pixels. */
const HOVER_HINT_STEP_PX = 12;

/** The overlapped area of two rectangles, or 0 when they do not intersect. */
function overlapArea(a: ArchitectureHintRect, b: ArchitectureHintRect): number {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * Place the hover hint inside `container` without covering any obstacle.
 *
 * Candidates are tried bottom-first: the drawing's package tabs live along its
 * TOP edge, so the free band is usually below them. Within one row the left
 * edge is tried before the right (the minimap sits bottom-left and the zoom
 * cluster bottom-right on the desktop tier), and when the row is taken the
 * candidate walks up the canvas in `HOVER_HINT_STEP_PX` steps.
 *
 * The returned `left`/`top` are relative to the container's top-left corner —
 * the hint is an absolutely positioned child of it. A container smaller than
 * the hint clamps to its top-left corner rather than producing negative
 * coordinates (a negative offset would paint outside the canvas the panel
 * clips).
 */
export function placeHoverHint(input: {
  readonly container: ArchitectureHintRect;
  readonly hint: ArchitectureHintSize;
  readonly obstacles: readonly ArchitectureHintRect[];
  readonly margin?: number;
}): ArchitectureHoverHintPlacement {
  const margin = input.margin ?? HOVER_HINT_MARGIN_PX;
  const container = input.container;
  const width = Math.max(0, Math.min(input.hint.width, container.right - container.left - margin * 2));
  const height = Math.max(0, Math.min(input.hint.height, container.bottom - container.top - margin * 2));
  const lowest = container.bottom - margin - height;
  const highest = container.top + margin;
  const leftEdge = container.left + margin;
  const rightEdge = container.right - margin - width;

  // Every row between the bottom edge and the top edge, bottom first.
  const rows: number[] = [];
  for (let top = lowest; top > highest; top -= HOVER_HINT_STEP_PX) rows.push(top);
  rows.push(highest);

  let best: { left: number; top: number; covered: number } | null = null;
  for (const top of rows) {
    for (const left of leftEdge <= rightEdge ? [leftEdge, rightEdge] : [leftEdge]) {
      const box: ArchitectureHintRect = { left, top, right: left + width, bottom: top + height };
      const covered = input.obstacles.reduce((total, obstacle) => total + overlapArea(box, obstacle), 0);
      if (covered === 0) {
        return { left: left - container.left, top: top - container.top, overlapsObstacle: false };
      }
      if (best === null || covered < best.covered) best = { left, top, covered };
    }
  }

  // Every candidate touches something (a canvas almost entirely covered by one
  // package frame): take the least-covered one instead of refusing to draw.
  const chosen = best ?? { left: leftEdge, top: highest, covered: 0 };
  return { left: chosen.left - container.left, top: chosen.top - container.top, overlapsObstacle: true };
}
