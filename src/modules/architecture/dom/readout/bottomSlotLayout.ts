/**
 * The architecture canvas's bottom-slot layout: the ONE statement of which
 * surface owns which part of the canvas's bottom band.
 *
 * Before this module the four bottom surfaces each chose their own position:
 * the minimap and the zoom cluster shared a flex column anchored bottom-right,
 * the selection pill floated bottom-centre (and, on a phone, spanned the whole
 * width), and the transient hover reading was placed by a rule that knew about
 * the minimap and the cluster but not about the pill. The pill therefore landed
 * on top of the corner chrome and the hover reading could land under either.
 *
 * The fix is a shared slot model rather than four local nudges:
 *  · the CORNER slot (bottom-right) belongs to the minimap and the zoom
 *    controls — a row on a touch tier, a column on a fine pointer;
 *  · the INFO slot (bottom-left) belongs to the selection pill, and the hover
 *    reading is placed above/inside the same slot by `placeHoverHint`.
 *
 * `ArchitectureMinimap`/`PlantUmlGraph` and `ArchitectureSelectionTray` read the
 * constants and helpers below, and the tests model the same geometry without a
 * laid-out browser (jsdom performs no layout at all).
 *
 * Used by `PlantUmlGraph`, `ArchitectureSelectionTray`, `ArchitecturePanel` and
 * their tests.
 */

/** A screen-space rectangle in the shape `getBoundingClientRect` reports. */
export type BottomSlotRect = {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
};

/** A width/height pair, in CSS pixels. */
export type BottomSlotSize = {
  readonly width: number;
  readonly height: number;
};

/** Which way the corner slot's two boxes are arranged. */
export type BottomCornerDirection = 'column' | 'row';

/** The distance the corner slot keeps from the canvas's bottom/right edges. */
export const BOTTOM_SLOT_CORNER_INSET_PX = 12;
/** The landscape phone's trimmed inset: the drawing pays for every pixel of chrome. */
export const BOTTOM_SLOT_CORNER_INSET_SHORT_PX = 4;
/** The gap between the minimap and the zoom controls inside the corner slot. */
export const BOTTOM_SLOT_GAP_PX = 8;
/** The landscape phone's trimmed gap. */
export const BOTTOM_SLOT_GAP_SHORT_PX = 4;
/** The distance the INFO slot (pill / hover reading) keeps from the left/bottom edges. */
export const BOTTOM_SLOT_INFO_INSET_PX = 8;

/**
 * The corner slot and the gaps for one layout tier.
 *
 * A touch tier spends ONE row on the corner chrome (map beside controls), so a
 * phone does not lose a 204px column down the drawing's right edge; a fine
 * pointer keeps the stacked column beside the drawing.
 */
export function bottomCornerLayout(input: {
  readonly touchUi: boolean;
  readonly shortTouch: boolean;
}): { readonly direction: BottomCornerDirection; readonly inset: number; readonly gap: number } {
  if (!input.touchUi) {
    return {
      direction: 'column',
      inset: BOTTOM_SLOT_CORNER_INSET_PX,
      gap: BOTTOM_SLOT_GAP_PX,
    };
  }
  return input.shortTouch
    ? { direction: 'row', inset: BOTTOM_SLOT_CORNER_INSET_SHORT_PX, gap: BOTTOM_SLOT_GAP_SHORT_PX }
    : { direction: 'row', inset: BOTTOM_SLOT_CORNER_INSET_PX, gap: BOTTOM_SLOT_GAP_PX };
}

/**
 * The two boxes of the corner slot inside `container`.
 *
 * This is the model the flex column/row realises at runtime: the minimap sits
 * above (column) or left of (row) the zoom controls, with one positive gap
 * between them, and the pair is anchored to the container's bottom-right edge.
 */
export function cornerChromeRects(input: {
  readonly container: BottomSlotRect;
  readonly minimap: BottomSlotSize;
  readonly controls: BottomSlotSize;
  readonly layout: { readonly direction: BottomCornerDirection; readonly inset: number; readonly gap: number };
}): { readonly minimap: BottomSlotRect; readonly controls: BottomSlotRect } {
  const { container, minimap, controls, layout } = input;
  if (layout.direction === 'row') {
    // Both boxes share a bottom edge; the controls hold the right edge and the
    // map is placed one gap to their left.
    const bottom = container.bottom - layout.inset;
    const top = bottom - Math.max(minimap.height, controls.height);
    const controlsRight = container.right - layout.inset;
    const controlsLeft = controlsRight - controls.width;
    const minimapRight = controlsLeft - layout.gap;
    return {
      minimap: { left: minimapRight - minimap.width, top, right: minimapRight, bottom },
      controls: { left: controlsLeft, top, right: controlsRight, bottom },
    };
  }
  // Both boxes share a right edge; the controls hold the bottom edge and the
  // map is placed one gap above them.
  const right = container.right - layout.inset;
  const bottom = container.bottom - layout.inset;
  const controlsTop = bottom - controls.height;
  const minimapBottom = controlsTop - layout.gap;
  return {
    minimap: { left: right - minimap.width, top: minimapBottom - minimap.height, right, bottom: minimapBottom },
    controls: { left: right - controls.width, top: controlsTop, right, bottom },
  };
}

/**
 * The INFO slot's box: the bottom-left band the selection pill anchors to.
 *
 * The hover reading is placed inside the SAME band (see
 * `placeHoverHint`), which is what makes the two surfaces unable to share
 * screen space: the pill claims a strip at the slot's bottom edge and the
 * reading walks upwards from it.
 */
export function bottomInfoSlotRect(input: {
  readonly container: BottomSlotRect;
  readonly size: BottomSlotSize;
  readonly inset?: number;
}): BottomSlotRect {
  const inset = input.inset ?? BOTTOM_SLOT_INFO_INSET_PX;
  const left = input.container.left + inset;
  const bottom = input.container.bottom - inset;
  return {
    left,
    top: bottom - input.size.height,
    right: left + input.size.width,
    bottom,
  };
}

/** The overlapped span of two boxes, or 0 when they do not intersect. */
function overlapSpan(a: BottomSlotRect, b: BottomSlotRect): { width: number; height: number } {
  return {
    width: Math.min(a.right, b.right) - Math.max(a.left, b.left),
    height: Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top),
  };
}

/**
 * Whether two slots share screen space by MORE than `tolerance` pixels.
 *
 * The tolerance exists because a 1px anti-aliased seam between two controls is
 * not an overlap a reader can see; the criteria state the same 1px.
 */
export function rectsOverlap(a: BottomSlotRect, b: BottomSlotRect, tolerance = 0): boolean {
  const span = overlapSpan(a, b);
  return span.width > tolerance && span.height > tolerance;
}

/**
 * The DEV-only lever this criterion's control arm pulls.
 *
 * `null` is the shipped layout. Each other value restores ONE of the defects
 * the task removed, so the SAME reading function can be shown landing on its
 * failing side:
 *  · `duplicate-readout` — draw the zoom percentage a second time in the cluster;
 *  · `solid-minimap` — paint filled node blocks instead of outlines;
 *  · `no-slot-layout` — float the pill bottom-centre again, across the corner slot.
 *
 * Production builds contain none of these branches, so no reader can turn the
 * defects back on.
 */
export type OverlayLayoutDefect = 'duplicate-readout' | 'solid-minimap' | 'no-slot-layout';

/** The localStorage key the control arm writes. */
export const OVERLAY_LAYOUT_STORAGE_KEY = 'architecture-overlay-layout';

/** Which defect the DEV lever restores, or `null` for the shipped layout. */
export function overlayLayoutDefect(): OverlayLayoutDefect | null {
  if (!import.meta.env.DEV) return null;
  try {
    const stored = window.localStorage.getItem(OVERLAY_LAYOUT_STORAGE_KEY);
    return stored === 'duplicate-readout' || stored === 'solid-minimap' || stored === 'no-slot-layout'
      ? stored
      : null;
  } catch {
    // Private mode: the lever is unreadable, so the shipped layout applies.
    return null;
  }
}
