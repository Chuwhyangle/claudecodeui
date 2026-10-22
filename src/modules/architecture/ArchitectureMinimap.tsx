import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from 'react';
import { useTranslation } from 'react-i18next';

import { TOUCH_TARGET_STYLE, useTouchLayout } from '@/modules/architecture/hooks/useTouchLayout';
import {
  measureViewportSize,
  readSvgNaturalSize,
  type SvgViewportSize,
} from '@/modules/architecture/svgViewport';

/**
 * The on-canvas minimap for the architecture diagram.
 *
 * A drawing can be tens of thousands of user units wide (the entity graph of a
 * large repository measured 49052×6930), so the reader has no way to tell where
 * the visible window sits in the whole drawing. This component paints the whole
 * drawing into a small `<canvas>` at the bottom-right of the canvas and frames
 * the part that is on screen; clicking or dragging that frame moves the view.
 *
 * The node geometry is read from the rendered SVG ONCE per drawing and painted
 * into an offscreen canvas; every pan/zoom only blits that bitmap and strokes
 * the frame, so a 1000-node drawing never enters the React render tree. The
 * arithmetic is split out as pure functions because jsdom has no layout and the
 * range box must be reviewable (and testable) without a browser.
 */

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

/** How far one arrow-key press on the focused minimap moves the view, in CSS pixels. */
const KEYBOARD_PAN_STEP_PX = 40;

/**
 * The smallest the frame is DRAWN, in minimap pixels. A frame thinner than the
 * line width would be invisible and impossible to grab; the reading itself is
 * never rounded by this, only the painted box.
 */
const FRAME_MIN_SIZE_PX = 8;

/**
 * The frame is marked by WIDTH, not colour alone: a 2px stroke reads as the
 * range box in greyscale and for a colour-blind reader, which a tinted 1px line
 * does not.
 */
const FRAME_LINE_WIDTH_PX = 2;

/** The localStorage key that remembers the reader's collapsed/expanded choice. */
const COLLAPSED_STORAGE_KEY = 'architecture.minimap.collapsed';

/** The minimap's own paint colours; the diagram's palette is irrelevant at this size. */
const BACKGROUND_COLOR = '#f8fafc';
const GROUP_COLOR = '#e2e8f0';
const ENTITY_COLOR = '#94a3b8';
const SEED_COLOR = '#b45309';
const FRAME_COLOR = '#1d4ed8';

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

/** Clamp a finite number into `[min, max]`; a non-finite value falls back to `min`. */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

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
function clampScroll(reading: MinimapViewportReading, desired: MinimapScroll): MinimapScroll {
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
      seed: element.classList.contains('arch-seed')
        || element.getAttribute('data-architecture-seed') === 'true',
    });
  }
  // Stable in modern engines, but state the ordering the painter relies on.
  return boxes.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'group' ? -1 : 1));
}

/** The collapsed/expanded choice, or `null` when the reader has not made one. */
function readCollapsedPreference(): 'collapsed' | 'expanded' | null {
  try {
    const stored = window.localStorage.getItem(COLLAPSED_STORAGE_KEY);
    return stored === 'collapsed' || stored === 'expanded' ? stored : null;
  } catch {
    // A browser with storage disabled simply has no memory across visits.
    return null;
  }
}

/** Remember the reader's choice; a failed write must not break the toggle. */
function writeCollapsedPreference(value: 'collapsed' | 'expanded'): void {
  try {
    window.localStorage.setItem(COLLAPSED_STORAGE_KEY, value);
  } catch {
    // Private mode / quota: the choice still applies for this session.
  }
}

/** The device pixel ratio, with a safe fallback for a non-browser render. */
function pixelRatio(): number {
  if (typeof window === 'undefined') return 1;
  return Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
    ? window.devicePixelRatio
    : 1;
}

/** The measured drawing plus the content box it is shown in. */
type MinimapFrameReading = {
  readonly natural: SvgViewportSize;
  readonly viewport: SvgViewportSize;
};

type ArchitectureMinimapProps = {
  /** The scroll container that owns the drawing; the minimap reads and writes its scroll. */
  hostRef: MinimapHostRef;
  /** Identity of the drawing on screen — a new value re-reads the node boxes once. */
  revision: unknown;
  /** The scale the viewport controller applied, so the frame follows a zoom. */
  scale: number;
};

/**
 * The minimap chrome of the architecture canvas.
 *
 * Used by `PlantUmlGraph` only, which mounts it inside its canvas container next
 * to the zoom cluster. The component observes its own host (scroll, resize) and
 * redraws imperatively on an animation frame, so panning never re-renders the
 * React tree. The node rectangles are painted once into an offscreen canvas and
 * blitted afterwards; the visible-range frame is the only thing redrawn.
 */
export function ArchitectureMinimap({ hostRef, revision, scale }: ArchitectureMinimapProps) {
  const { t } = useTranslation();
  // A phone has no room for the map, so it starts collapsed (only the 44px
  // button); the expanded mobile form is the mobile layout task's arrangement.
  const { isMobile, touchUi } = useTouchLayout();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The measured drawing and content box. A resize is the only thing that
  // changes it, so it is state (it decides whether the map is shown at all);
  // the scroll offsets are read live at paint time instead.
  const [measurement, setMeasurement] = useState<MinimapFrameReading | null>(null);
  // The reader's explicit choice; `null` means "follow the device default".
  const [preference, setPreference] = useState<'collapsed' | 'expanded' | null>(readCollapsedPreference);
  // The painted node rectangles are cached offscreen, keyed by the drawing's
  // identity: a re-layout re-reads them once, a pan or zoom never does.
  const baseRef = useRef<{ revision: unknown; canvas: HTMLCanvasElement } | null>(null);
  // The JS paint queue: one animation frame at a time, whatever the event burst.
  const frameRef = useRef<number | null>(null);
  // The active drag: which pointer, where the scroll started and where the
  // finger started on the map. A drag without it is a one-off centring click.
  const dragRef = useRef<{
    pointerId: number;
    startScroll: MinimapScroll;
    startX: number;
    startY: number;
  } | null>(null);
  // `getContext` returning null (jsdom) is permanent for the element; remember
  // it so a scroll burst does not retry a call that only logs a warning each time.
  const contextUnavailableRef = useRef(false);
  // The map's own size: 160×100 on a fine pointer, the phone's glance-sized
  // 96×64 when the layout tier is mobile. The imperative painter reads it from
  // a ref for the same reason it reads the scale from one — paint runs outside
  // the render that produced it.
  const mapSizeRef = useRef({ width: MINIMAP_WIDTH_PX, height: MINIMAP_HEIGHT_PX });

  // Live mirrors for the imperative paint, which runs outside the render that
  // produced them. Assigning during render keeps them one render ahead, never
  // stale, and none of them is read by React itself.
  const measurementRef = useRef(measurement);
  measurementRef.current = measurement;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const revisionRef = useRef(revision);
  revisionRef.current = revision;
  const translateRef = useRef(t);
  translateRef.current = t;

  const collapsed = preference === null ? isMobile : preference === 'collapsed';
  const mapWidth = isMobile ? MINIMAP_MOBILE_WIDTH_PX : MINIMAP_WIDTH_PX;
  const mapHeight = isMobile ? MINIMAP_MOBILE_HEIGHT_PX : MINIMAP_HEIGHT_PX;
  mapSizeRef.current = { width: mapWidth, height: mapHeight };

  /** The current reading, with the host's live scroll offsets folded in. */
  const liveReading = useCallback((): MinimapViewportReading | null => {
    const host = hostRef.current;
    const measured = measurementRef.current;
    if (host === null || measured === null) return null;
    return {
      natural: measured.natural,
      viewport: measured.viewport,
      scale: scaleRef.current,
      scroll: { left: host.scrollLeft, top: host.scrollTop },
    };
  }, [hostRef]);

  /** The range frame the paint (and the hit test) uses, widened so it can be seen and grabbed. */
  const paintedRange = useCallback((): MinimapRect | null => {
    const reading = liveReading();
    if (reading === null) return null;
    const range = visibleRangeRect(reading);
    if (range === null) return null;
    const { width: mapWidth, height: mapHeight } = mapSizeRef.current;
    const width = Math.min(
      mapWidth,
      Math.max(range.width, FRAME_MIN_SIZE_PX),
    );
    const height = Math.min(
      mapHeight,
      Math.max(range.height, FRAME_MIN_SIZE_PX),
    );
    const left = clamp(range.left + range.width / 2 - width / 2, 0, mapWidth - width);
    const top = clamp(range.top + range.height / 2 - height / 2, 0, mapHeight - height);
    return { left, top, width, height };
  }, [liveReading]);

  /** Paint the node boxes into a bitmap, re-reading the drawing only when its identity changed. */
  const baseBitmap = useCallback((): HTMLCanvasElement | null => {
    const cached = baseRef.current;
    if (cached !== null && cached.revision === revisionRef.current) return cached.canvas;
    const host = hostRef.current;
    const drawing = host === null ? null : host.querySelector('svg');
    if (drawing === null) return null;
    const ratio = pixelRatio();
    const { width: mapWidth, height: mapHeight } = mapSizeRef.current;
    const base = document.createElement('canvas');
    base.width = Math.round(mapWidth * ratio);
    base.height = Math.round(mapHeight * ratio);
    const context = base.getContext('2d');
    if (context === null) return null;
    const natural = measurementRef.current?.natural ?? readSvgNaturalSize(drawing as SVGSVGElement);
    const layout = natural === null ? null : minimapLayout(natural, { width: mapWidth, height: mapHeight });
    if (layout === null) return null;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, mapWidth, mapHeight);
    context.fillStyle = BACKGROUND_COLOR;
    context.fillRect(0, 0, mapWidth, mapHeight);
    for (const box of readMinimapBoxes(drawing)) {
      context.fillStyle = box.seed
        ? SEED_COLOR
        : box.kind === 'group'
          ? GROUP_COLOR
          : ENTITY_COLOR;
      context.fillRect(
        layout.offsetX + box.left * layout.scale,
        layout.offsetY + box.top * layout.scale,
        Math.max(0.5, box.width * layout.scale),
        Math.max(0.5, box.height * layout.scale),
      );
    }
    baseRef.current = { revision: revisionRef.current, canvas: base };
    return base;
  }, [hostRef]);

  /** Blit the cached drawing and stroke the live range frame. */
  const paint = useCallback((): void => {
    const canvas = canvasRef.current;
    const reading = liveReading();
    if (canvas === null || reading === null) return;
    const range = paintedRange();
    // The reading is exposed to the DOM first: it is what a test (and a reader
    // inspecting the element) can see even where canvas is unavailable.
    if (range !== null) {
      canvas.setAttribute(
        'data-architecture-minimap-range',
        [range.left, range.top, range.width, range.height].map((value) => Math.round(value * 100) / 100).join(','),
      );
    }
    const percent = visiblePercent(reading);
    canvas.setAttribute('data-architecture-minimap-visible-percent', String(percent));
    canvas.setAttribute(
      'aria-label',
      translateRef.current('architecture.plantuml.minimap.label', {
        defaultValue: 'Graph overview, showing {{percent}}% of the drawing',
        percent,
      }),
    );
    if (contextUnavailableRef.current) return;
    const context = canvas.getContext('2d');
    if (context === null) {
      contextUnavailableRef.current = true;
      return;
    }
    const ratio = pixelRatio();
    const { width: mapWidth, height: mapHeight } = mapSizeRef.current;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, mapWidth, mapHeight);
    const base = baseBitmap();
    if (base !== null) context.drawImage(base, 0, 0, mapWidth, mapHeight);
    if (range === null) return;
    context.lineWidth = FRAME_LINE_WIDTH_PX;
    context.strokeStyle = FRAME_COLOR;
    // A single 2px stroke: the frame is identified by its WIDTH, which survives
    // a greyscale print and a colour-blind reading (see FRAME_LINE_WIDTH_PX).
    context.strokeRect(range.left, range.top, range.width, range.height);
  }, [baseBitmap, liveReading, paintedRange]);

  /** Queue one paint on the next animation frame (coalesces a scroll/wheel burst). */
  const schedulePaint = useCallback((): void => {
    if (frameRef.current !== null) return;
    const run = (): void => {
      frameRef.current = null;
      paint();
    };
    // The pending sentinel is set BEFORE the callback can run, so an
    // environment that invokes `requestAnimationFrame` synchronously still
    // leaves the queue free for the next schedule.
    frameRef.current = -1;
    const handle = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(run)
      : (setTimeout(run, 0) as unknown as number);
    if (frameRef.current === -1) frameRef.current = handle;
  }, [paint]);

  // Measure on mount and after every host resize; follow the container's scroll
  // here rather than in React, because a pan must not re-render the tree. A new
  // drawing (`revision`) is re-measured too: the first SVG arrives AFTER mount,
  // and every later one may have a different natural size.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const measure = (): void => {
      const drawing = host.querySelector('svg');
      const natural = drawing === null ? null : readSvgNaturalSize(drawing as SVGSVGElement);
      const viewport = measureViewportSize(host);
      setMeasurement(natural !== null && viewport !== null ? { natural, viewport } : null);
    };
    measure();
    const onScroll = (): void => schedulePaint();
    host.addEventListener('scroll', onScroll);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(host);
    return () => {
      host.removeEventListener('scroll', onScroll);
      observer?.disconnect();
    };
  }, [hostRef, revision, schedulePaint]);

  // A new drawing (revision) or a zoom (scale) changes the bitmap's identity and
  // the range's geometry; a resize changes the measurement. All three converge
  // on the same coalesced paint.
  useEffect(() => {
    schedulePaint();
  }, [measurement, revision, scale, collapsed, schedulePaint]);

  useEffect(() => () => {
    if (frameRef.current !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(frameRef.current);
    }
    frameRef.current = null;
  }, []);

  // A graph that already fits its container says nothing in a map, so the
  // component draws nothing at all (not even the collapsed button); `collapsed`
  // only chooses between the map and the 44px button.
  const visible = measurement !== null
    && !drawingFitsInViewport(measurement.natural, measurement.viewport);

  /** The pointer position in minimap pixels (the canvas is the coordinate origin). */
  const canvasPoint = (event: ReactPointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const canvas = canvasRef.current;
    const rect = canvas === null ? { left: 0, top: 0 } : canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const host = hostRef.current;
    const reading = liveReading();
    if (host === null || reading === null) return;
    if (event.button !== 0) return;
    // The map owns this gesture: the canvas pan/selection layers sit below it
    // and must not act on the same press.
    event.preventDefault();
    event.stopPropagation();
    const point = canvasPoint(event);
    const range = paintedRange();
    const grabbed = range !== null
      && point.x >= range.left - FRAME_MIN_SIZE_PX / 2
      && point.x <= range.left + range.width + FRAME_MIN_SIZE_PX / 2
      && point.y >= range.top - FRAME_MIN_SIZE_PX / 2
      && point.y <= range.top + range.height + FRAME_MIN_SIZE_PX / 2;
    if (!grabbed) {
      // Clicking elsewhere on the map is the "jump there" gesture; the drag
      // below continues from the re-centred position, so a press-and-slide
      // works from any point.
      const target = minimapPointToScroll(reading, point);
      host.scrollLeft = target.left;
      host.scrollTop = target.top;
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startScroll: { left: host.scrollLeft, top: host.scrollTop },
      startX: point.x,
      startY: point.y,
    };
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // jsdom and detached nodes refuse capture; the win-level move/up
        // listeners below still receive the rest of the gesture.
      }
    }
    schedulePaint();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current;
    const host = hostRef.current;
    const reading = liveReading();
    if (drag === null || host === null || reading === null || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const point = canvasPoint(event);
    const target = minimapDragToScroll(reading, drag.startScroll, {
      x: point.x - drag.startX,
      y: point.y - drag.startY,
    });
    host.scrollLeft = target.left;
    host.scrollTop = target.top;
    schedulePaint();
  };

  const endDrag = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current;
    if (drag === null || event.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    if (typeof event.currentTarget.releasePointerCapture === 'function') {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Never captured (see onPointerDown); nothing to release.
      }
    }
    schedulePaint();
  };

  // The focused map is a keyboard navigation target too: arrows move the view
  // by one step, mirroring the canvas's own arrow-key pan and stopping at the
  // same drawing bounds a drag stops at.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLCanvasElement>): void => {
    const host = hostRef.current;
    const reading = liveReading();
    if (host === null || reading === null || event.ctrlKey || event.metaKey || event.altKey) return;
    let delta: MinimapScroll;
    switch (event.key) {
      case 'ArrowLeft':
        delta = { left: -KEYBOARD_PAN_STEP_PX, top: 0 };
        break;
      case 'ArrowRight':
        delta = { left: KEYBOARD_PAN_STEP_PX, top: 0 };
        break;
      case 'ArrowUp':
        delta = { left: 0, top: -KEYBOARD_PAN_STEP_PX };
        break;
      case 'ArrowDown':
        delta = { left: 0, top: KEYBOARD_PAN_STEP_PX };
        break;
      default:
        return;
    }
    event.preventDefault();
    const target = clampScroll(reading, {
      left: host.scrollLeft + delta.left,
      top: host.scrollTop + delta.top,
    });
    host.scrollLeft = target.left;
    host.scrollTop = target.top;
    schedulePaint();
  };

  const setCollapsed = (next: boolean): void => {
    setPreference(next ? 'collapsed' : 'expanded');
    writeCollapsedPreference(next ? 'collapsed' : 'expanded');
  };

  if (!visible) return null;

  const expandLabel = t('architecture.plantuml.minimap.show', { defaultValue: 'Show graph overview' });
  const collapseLabel = t('architecture.plantuml.minimap.hide', { defaultValue: 'Collapse graph overview' });
  const ratio = pixelRatio();

  return (
    <div
      data-architecture-minimap="true"
      className="pointer-events-auto flex flex-col items-end"
      // The map is not the drawing: a wheel here must not zoom the diagram
      // (the canvas's wheel listener is on the scroll host, which this is not
      // a descendant of, but the contract is stated explicitly).
      onWheel={(event: ReactWheelEvent<HTMLDivElement>) => event.stopPropagation()}
    >
      {collapsed ? (
        <button
          type="button"
          data-architecture-minimap-expand="true"
          aria-expanded={false}
          aria-label={expandLabel}
          onClick={() => setCollapsed(false)}
          style={touchUi ? TOUCH_TARGET_STYLE : {
            minHeight: `${MINIMAP_COLLAPSED_TARGET_PX}px`,
            minWidth: `${MINIMAP_COLLAPSED_TARGET_PX}px`,
          }}
          className="rounded border border-border/60 bg-background/90 text-[11px] font-medium text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          ▣
        </button>
      ) : (
        <div
          data-architecture-minimap-panel="true"
          className="relative rounded-lg border border-border/60 bg-background/90 p-0.5 shadow-sm"
        >
          <button
            type="button"
            data-architecture-minimap-collapse="true"
            aria-expanded
            aria-label={collapseLabel}
            onClick={() => setCollapsed(true)}
            style={touchUi ? TOUCH_TARGET_STYLE : undefined}
            className="absolute right-0 top-0 z-10 rounded bg-background/90 px-1 text-[10px] leading-none text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            −
          </button>
          <canvas
            ref={canvasRef}
            data-architecture-minimap-canvas="true"
            role="img"
            aria-label={t('architecture.plantuml.minimap.label', {
              defaultValue: 'Graph overview, showing {{percent}}% of the drawing',
              percent: 100,
            })}
            tabIndex={0}
            width={Math.round(mapWidth * ratio)}
            height={Math.round(mapHeight * ratio)}
            style={{ width: `${mapWidth}px`, height: `${mapHeight}px`, touchAction: 'none' }}
            className="block cursor-crosshair rounded outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onKeyDown={onKeyDown}
          />
        </div>
      )}
    </div>
  );
}
