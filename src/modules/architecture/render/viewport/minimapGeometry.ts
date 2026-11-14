/**
 * Pure minimap geometry for `ArchitectureMinimap`.
 *
 * The arithmetic is kept out of the component so jsdom (which has no layout) can
 * assert the letterbox, the visible-range frame and the pointer/drag conversions
 * without a browser. `ArchitectureMinimap` re-exports this surface, so the
 * geometry test keeps reading it from the component module.
 */
import { type SvgViewportSize } from '@/modules/architecture/layout/engine/svgViewport';
import { clamp } from '@/shared/utils';

/** The PC minimap size the proposal fixes; the drawing is letterboxed inside it. */
export const MINIMAP_WIDTH_PX = 160;
export const MINIMAP_HEIGHT_PX = 100;

/**
 * The phone's expanded minimap. The bottom sheet owns the knobs, so the map is
 * a glance-only 96×64 thumbnail above the zoom cluster; 160×100 would cover
 * the drawing it is meant to summarise.
 */
export const MINIMAP_MOBILE_WIDTH_PX = 96;
export const MINIMAP_MOBILE_HEIGHT_PX = 64;

/** The collapsed form's hit area (a phone shows only this button by default). */
export const MINIMAP_COLLAPSED_TARGET_PX = 44;

/** A rectangle in drawing user units (`left`/`top` relative to the drawing origin). */
export type MinimapRect = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
};

/** A scroll offset of the diagram's container, in CSS pixels. */
export type MinimapScroll = {
  readonly left: number;
  readonly top: number;
};

/** One node/group box the minimap paints, read once per drawing. */
export type MinimapBox = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** Package frames and `grp::` overview nodes are scaffolding: painted pale, behind entities. */
  readonly kind: 'entity' | 'group';
  /** A transcript seed (distance 0) is painted in the accent colour. */
  readonly seed: boolean;
};

/** The letterboxed placement of the whole drawing inside the minimap canvas. */
export type MinimapLayout = {
  /** Drawing user units → minimap CSS pixels. */
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
  /** The drawn drawing's size in minimap pixels (the box inside the letterbox). */
  readonly width: number;
  readonly height: number;
};

/**
 * Everything the range rectangle is derived from: the drawing's natural size,
 * the scale the viewport controller applied, the visible content box and the
 * container's scroll offsets. `PlantUmlGraph` supplies these from the same
 * viewport controller that owns the zoom, so the minimap never invents a second
 * scale model.
 */
export type MinimapViewportReading = {
  readonly natural: SvgViewportSize;
  readonly scale: number;
  readonly viewport: SvgViewportSize;
  readonly scroll: MinimapScroll;
};

/** The subset of a React ref this component needs: the owner's scroll container. */
export type MinimapHostRef = { readonly current: HTMLElement | null };

/** A usable scale: the caller's value when positive and finite, otherwise 100%. */
function effectiveScale(scale: number): number {
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/**
 * The scroll offsets the drawing supports at this scale: `0` in an axis whose
 * drawing already fits, which is what makes a clamped drag stop at the edge
 * instead of scrolling past the drawing.
 */
function scrollLimits(reading: MinimapViewportReading): MinimapScroll {
  const scale = effectiveScale(reading.scale);
  return {
    left: Math.max(0, reading.natural.width * scale - reading.viewport.width),
    top: Math.max(0, reading.natural.height * scale - reading.viewport.height),
  };
}

/** Clamp a desired scroll offset into the range the drawing actually supports. */
export function clampScroll(reading: MinimapViewportReading, desired: MinimapScroll): MinimapScroll {
  const limits = scrollLimits(reading);
  return {
    left: clamp(desired.left, 0, limits.left),
    top: clamp(desired.top, 0, limits.top),
  };
}

/**
 * Where the whole drawing sits inside a fixed-size minimap, preserving the
 * drawing's aspect ratio and centring the remainder (the letterbox bands). The
 * default target is the PC minimap; a caller may pass its own box.
 */
export function minimapLayout(
  natural: SvgViewportSize,
  map: SvgViewportSize = { width: MINIMAP_WIDTH_PX, height: MINIMAP_HEIGHT_PX },
): MinimapLayout | null {
  if (!(natural.width > 0) || !(natural.height > 0) || !(map.width > 0) || !(map.height > 0)) {
    return null;
  }
  const scale = Math.min(map.width / natural.width, map.height / natural.height);
  const width = natural.width * scale;
  const height = natural.height * scale;
  return { scale, offsetX: (map.width - width) / 2, offsetY: (map.height - height) / 2, width, height };
}

/**
 * The part of the drawing currently on screen, in drawing user units.
 *
 * The container's own padding cancels out of this reading: at `scroll = 0` the
 * content box starts one padding in, exactly where the drawing starts, and the
 * scrollable extent is `padding + scaled drawing + padding - client size` — the
 * same `scaled drawing - content box` the scroll limit uses. A drawing that is
 * narrower than its container is centred by the stylesheet and has no
 * horizontal scroll, which the `min(natural - left, viewport / scale)` width
 * handles without a special case.
 */
export function visibleDrawingRect(reading: MinimapViewportReading): MinimapRect {
  const scale = effectiveScale(reading.scale);
  const scroll = clampScroll(reading, reading.scroll);
  const left = scroll.left / scale;
  const top = scroll.top / scale;
  return {
    left,
    top,
    width: Math.max(0, Math.min(reading.natural.width - left, reading.viewport.width / scale)),
    height: Math.max(0, Math.min(reading.natural.height - top, reading.viewport.height / scale)),
  };
}

/**
 * The range frame in minimap pixels: the visible part of the drawing mapped
 * through the same letterbox as the drawing itself. `null` when the drawing has
 * no usable size. The painter may widen a very thin frame for visibility; this
 * conversion stays exact so it can be asserted without a browser.
 */
export function visibleRangeRect(
  reading: MinimapViewportReading,
  map: SvgViewportSize = { width: MINIMAP_WIDTH_PX, height: MINIMAP_HEIGHT_PX },
): MinimapRect | null {
  const layout = minimapLayout(reading.natural, map);
  if (layout === null) return null;
  const visible = visibleDrawingRect(reading);
  return {
    left: layout.offsetX + visible.left * layout.scale,
    top: layout.offsetY + visible.top * layout.scale,
    width: visible.width * layout.scale,
    height: visible.height * layout.scale,
  };
}

/**
 * The scroll offset that centres the viewport on the drawing point under a
 * minimap click. Points in the letterbox bands map outside the drawing and are
 * clamped onto it, so a click on the padding still lands on the nearest edge.
 */
export function minimapPointToScroll(
  reading: MinimapViewportReading,
  point: { readonly x: number; readonly y: number },
  map: SvgViewportSize = { width: MINIMAP_WIDTH_PX, height: MINIMAP_HEIGHT_PX },
): MinimapScroll {
  const layout = minimapLayout(reading.natural, map);
  if (layout === null) return { left: 0, top: 0 };
  const scale = effectiveScale(reading.scale);
  const drawingX = clamp((point.x - layout.offsetX) / layout.scale, 0, reading.natural.width);
  const drawingY = clamp((point.y - layout.offsetY) / layout.scale, 0, reading.natural.height);
  return clampScroll(reading, {
    left: drawingX * scale - reading.viewport.width / 2,
    top: drawingY * scale - reading.viewport.height / 2,
  });
}

/**
 * The scroll offset after dragging the range frame by `delta` minimap pixels.
 * The delta is converted to drawing units through the letterbox scale and then
 * to screen pixels through the zoom scale, and the result is clamped so the
 * view can never leave the drawing.
 */
export function minimapDragToScroll(
  reading: MinimapViewportReading,
  start: MinimapScroll,
  delta: { readonly x: number; readonly y: number },
  map: SvgViewportSize = { width: MINIMAP_WIDTH_PX, height: MINIMAP_HEIGHT_PX },
): MinimapScroll {
  const layout = minimapLayout(reading.natural, map);
  if (layout === null) return { left: 0, top: 0 };
  const scale = effectiveScale(reading.scale);
  const perMinimapPixel = scale / layout.scale;
  return clampScroll(reading, {
    left: start.left + delta.x * perMinimapPixel,
    top: start.top + delta.y * perMinimapPixel,
  });
}

/**
 * Whether the whole drawing already fits its container. That is exactly the
 * case the minimap refuses to render: a range frame covering the entire map
 * says nothing, and the fit scale of such a drawing is 100% or more.
 */
export function drawingFitsInViewport(natural: SvgViewportSize, viewport: SvgViewportSize): boolean {
  return natural.width > 0
    && natural.height > 0
    && viewport.width >= natural.width
    && viewport.height >= natural.height;
}

/** The share of the drawing on screen, as the accessible name states it. */
export function visiblePercent(reading: MinimapViewportReading): number {
  const total = reading.natural.width * reading.natural.height;
  if (!(total > 0)) return 0;
  const visible = visibleDrawingRect(reading);
  const share = (visible.width * visible.height) / total;
  return clamp(Math.round(share * 100), 1, 100);
}

/** Read one `<rect>`'s geometry from the attributes the renderer emitted. */
function rectAttributes(rect: Element): MinimapRect | null {
  const left = Number.parseFloat(rect.getAttribute('x') ?? '');
  const top = Number.parseFloat(rect.getAttribute('y') ?? '');
  const width = Number.parseFloat(rect.getAttribute('width') ?? '');
  const height = Number.parseFloat(rect.getAttribute('height') ?? '');
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { left, top, width, height };
}

/**
 * A fallback for a renderer that draws no `<rect>` (or a transformed group):
 * the element's own bbox. Absent in jsdom, hence the feature test.
 */
function bboxOf(element: Element): MinimapRect | null {
  const withBBox = element as Element & { getBBox?: () => DOMRect };
  if (typeof withBBox.getBBox !== 'function') return null;
  try {
    const box = withBBox.getBBox();
    return box.width > 0 && box.height > 0
      ? { left: box.x, top: box.y, width: box.width, height: box.height }
      : null;
  } catch {
    return null;
  }
}

/**
 * Read every node box the rendering emitted, in ONE pass. The PlantUML/ELK
 * renderer writes absolute coordinates into each entity's and package's first
 * `<rect>`, so no transform bookkeeping is needed; the bbox fallback covers a
 * renderer that omits the rect.
 *
 * Group boxes come first so the painter can put them behind the entities
 * without a second sort of its own. View scaffolding (`stub::` nodes) is an
 * entity box like any other — it is drawn, it is simply not clickable.
 */
export function readMinimapBoxes(root: ParentNode): MinimapBox[] {
  const boxes: MinimapBox[] = [];
  for (const element of root.querySelectorAll('.uml-node, .uml-package')) {
    const rect = element.querySelector('rect');
    const geometry = rect === null ? null : rectAttributes(rect);
    const box = geometry ?? bboxOf(element);
    if (box === null) continue;
    const packageFrame = element.classList.contains('uml-package');
    const entityId = element.getAttribute('data-entity-id') ?? '';
    boxes.push({
      ...box,
      kind: packageFrame || entityId.startsWith('grp::') ? 'group' : 'entity',
      // The seed marker has two forms (`arch-seed` and the light
      // `arch-seed-light`); both are seeds, and `data-architecture-seed`
      // carries `true` or `light` depending on which form is in use.
      seed: element.classList.contains('arch-seed')
        || element.classList.contains('arch-seed-light')
        || element.getAttribute('data-architecture-seed') !== null,
    });
  }
  // Stable in modern engines, but state the ordering the painter relies on.
  return boxes.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'group' ? -1 : 1));
}
