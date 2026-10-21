/**
 * Renderer-neutral SVG viewport: fit and zoom an arbitrary `<svg>` by rewriting
 * only its `width`/`height` attributes.
 *
 * Used by the architecture module's `PlantUmlGraph`. The PlantUML/ELK renderer
 * exposes no zoom API, but every SVG it emits carries a `viewBox`, so scaling
 * the presentation size keeps the drawing vector-sharp and makes the scroll
 * container's extent follow the size automatically. Nothing here touches the
 * DOM structure, so the drawn ids, hover classes and click handlers stay as the
 * renderer produced them; and nothing here knows about PlantUML or React, so the
 * renderer package can adopt it later as `attachViewport(svg)`.
 *
 * The size math is deliberately split out as pure functions so it can be
 * reviewed and tested without a laid-out browser.
 */

/** A width/height pair, in SVG user units or CSS pixels. */
export type SvgViewportSize = {
  readonly width: number;
  readonly height: number;
};

/** The pointer position a wheel zoom is anchored to, in client coordinates. */
export type SvgViewportAnchor = {
  readonly clientX: number;
  readonly clientY: number;
};

/**
 * The bounds the proposal fixes: 5% keeps a huge graph navigable while 400%
 * leaves enough headroom to read a dense neighbourhood at detail scale.
 */
export const MIN_ZOOM_SCALE = 0.05;
export const MAX_ZOOM_SCALE = 4;

/** The multiplicative step one `+` / `−` press applies. */
export const ZOOM_STEP = 1.25;

/** Clamp a requested scale into the supported range; a non-finite value means "natural". */
export function clampZoomScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_ZOOM_SCALE, Math.max(MIN_ZOOM_SCALE, scale));
}

/** Read a positive numeric SVG length, ignoring percentages and unparseable values. */
function numericSvgLength(svg: SVGSVGElement, attribute: 'width' | 'height'): number | null {
  const raw = svg.getAttribute(attribute);
  if (raw === null || raw.trim().endsWith('%')) return null;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The SVG's natural drawing size in user units: the `viewBox` extent when one
 * is present, otherwise the root `width`/`height`. `null` when the element
 * carries no usable geometry (a renderer that emitted neither).
 */
export function readSvgNaturalSize(svg: SVGSVGElement): SvgViewportSize | null {
  const viewBox = svg.getAttribute('viewBox');
  if (viewBox !== null) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
      return { width: parts[2], height: parts[3] };
    }
  }
  const width = numericSvgLength(svg, 'width');
  const height = numericSvgLength(svg, 'height');
  return width !== null && height !== null ? { width, height } : null;
}

/**
 * The uniform scale that fits `natural` inside `viewport` while preserving its
 * aspect ratio. Never exceeds 100% — a diagram smaller than its container is
 * shown at natural size rather than blown up — and never leaves the 5%–400%
 * range. An unmeasurable viewport (width or height 0) means "natural size".
 */
export function fitZoomScale(natural: SvgViewportSize, viewport: SvgViewportSize): number {
  if (viewport.width <= 0 || viewport.height <= 0) return 1;
  return clampZoomScale(Math.min(viewport.width / natural.width, viewport.height / natural.height, 1));
}

/** The on-screen size of `natural` at `scale`, with the scale clamped first. */
export function zoomedSvgSize(natural: SvgViewportSize, scale: number): SvgViewportSize {
  const applied = clampZoomScale(scale);
  return { width: natural.width * applied, height: natural.height * applied };
}

/** Format a CSS length without trailing float noise ("800", not "800.0000000001"). */
function formatLength(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/**
 * Apply `scale` to the SVG's presentation size and return the scale actually
 * written (clamped). The viewBox is left alone, so the drawing scales as a
 * vector and the element's layout size — which is what gives the scroll
 * container its extent — always equals the scaled natural size.
 */
export function applyZoomScale(svg: SVGSVGElement, scale: number): number {
  const applied = clampZoomScale(scale);
  const natural = readSvgNaturalSize(svg);
  if (natural === null) return applied;
  const size = zoomedSvgSize(natural, applied);
  svg.setAttribute('width', formatLength(size.width));
  svg.setAttribute('height', formatLength(size.height));
  return applied;
}

/** A client-coordinate rectangle: the subset of `DOMRect` the centring math reads. */
export type ViewportRect = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
};

/**
 * The scroll offsets that put `target`'s centre at `viewport`'s centre, given
 * the container's current scroll position. Pure so the focus-recentre gesture
 * of the explosion LOD can be tested without a laid-out browser.
 */
export function centeredScrollOffsets(
  viewport: ViewportRect,
  target: ViewportRect,
  current: { readonly left: number; readonly top: number },
): { left: number; top: number } {
  return {
    left: current.left + (target.left + target.width / 2) - (viewport.left + viewport.width / 2),
    top: current.top + (target.top + target.height / 2) - (viewport.top + viewport.height / 2),
  };
}

/**
 * Scroll `container` so `target`'s centre sits in the middle of the visible
 * box. Used by the architecture explosion LOD when a zoom crosses a detail
 * level, so the package the user is focused on cannot run off-screen.
 *
 * `clientWidth`/`clientHeight` exclude scrollbars and are what the browser
 * centres within; a not-laid-out container (jsdom) falls back to its rect.
 */
export function centerElementInContainer(container: HTMLElement, target: Element): void {
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const width = container.clientWidth > 0 ? container.clientWidth : containerRect.width;
  const height = container.clientHeight > 0 ? container.clientHeight : containerRect.height;
  const offsets = centeredScrollOffsets(
    { left: containerRect.left, top: containerRect.top, width, height },
    { left: targetRect.left, top: targetRect.top, width: targetRect.width, height: targetRect.height },
    { left: container.scrollLeft, top: container.scrollTop },
  );
  container.scrollLeft = offsets.left;
  container.scrollTop = offsets.top;
}

/** The content box a fitted SVG may occupy, or `null` when the browser has not laid it out yet. */
function measureViewport(container: HTMLElement): SvgViewportSize | null {
  let paddingX = 0;
  let paddingY = 0;
  if (typeof getComputedStyle === 'function') {
    const style = getComputedStyle(container);
    const px = (value: string): number => {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    paddingX = px(style.paddingLeft) + px(style.paddingRight);
    paddingY = px(style.paddingTop) + px(style.paddingBottom);
  }
  const width = container.clientWidth - paddingX;
  const height = container.clientHeight - paddingY;
  if (width > 0 && height > 0) return { width, height };
  const rect = container.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0
    ? { width: rect.width - paddingX, height: rect.height - paddingY }
    : null;
}

/**
 * The imperative handle `PlantUmlGraph` keeps across renders. Every method that
 * changes the scale returns the scale actually applied; `attach` must be called
 * after each render because the renderer replaces the `<svg>` wholesale.
 */
export type SvgViewportController = {
  /** Point the controller at the SVG that was just injected, keeping the current scale. */
  attach(svg: SVGSVGElement): number;
  /** Recompute and apply the fit-to-container scale. */
  fit(): number;
  /** Apply an explicit scale (used by the +/- buttons and the 100% control). */
  zoomTo(scale: number): number;
  /** Multiply the current scale by `factor`, keeping the point under `anchor` fixed. */
  zoomBy(factor: number, anchor?: SvgViewportAnchor): number;
};

/**
 * Create a controller for one scroll container. Used by `PlantUmlGraph`; the
 * container's own size is re-read on every `fit()`, so a caller that owns a
 * ResizeObserver gets refit-on-resize for free.
 */
export function createSvgViewport(container: HTMLElement): SvgViewportController {
  let svg: SVGSVGElement | null = null;
  let scale = 1;

  return {
    attach(next: SVGSVGElement): number {
      svg = next;
      // A fresh SVG arrives at natural size; re-apply whatever the caller had
      // so the element never flashes at the wrong size between effects.
      scale = applyZoomScale(next, scale);
      return scale;
    },

    fit(): number {
      if (svg === null) return scale;
      const natural = readSvgNaturalSize(svg);
      const viewport = measureViewport(container);
      scale = natural === null || viewport === null
        ? applyZoomScale(svg, 1)
        : applyZoomScale(svg, fitZoomScale(natural, viewport));
      return scale;
    },

    zoomTo(next: number): number {
      scale = svg === null ? clampZoomScale(next) : applyZoomScale(svg, next);
      return scale;
    },

    zoomBy(factor: number, anchor?: SvgViewportAnchor): number {
      const next = clampZoomScale(scale * factor);
      if (svg === null || next === scale) {
        scale = next;
        return scale;
      }
      // Record the anchored point in SVG user units BEFORE resizing, then scroll
      // by however far the resize moved it. Because only width/height change,
      // the user-unit coordinate of the point under the cursor is stable.
      const before = svg.getBoundingClientRect();
      const userX = anchor === undefined ? null : (anchor.clientX - before.left) / scale;
      const userY = anchor === undefined ? null : (anchor.clientY - before.top) / scale;
      scale = applyZoomScale(svg, next);
      if (anchor !== undefined && userX !== null && userY !== null) {
        const after = svg.getBoundingClientRect();
        container.scrollLeft += after.left + userX * scale - anchor.clientX;
        container.scrollTop += after.top + userY * scale - anchor.clientY;
      }
      return scale;
    },
  };
}

/** One touch pointer's position, in client coordinates. */
export type SvgTouchPoint = { readonly clientX: number; readonly clientY: number };

/** What a two-finger pinch reads: the span between the fingers and its midpoint. */
export type PinchReading = {
  readonly distance: number;
  readonly midpoint: SvgViewportAnchor;
};

/**
 * Read a pinch from two finger positions. The distance is what a scale factor
 * is derived from; the midpoint is the anchor the zoom keeps fixed, so the
 * drawing grows/shrinks around where the fingers actually are.
 */
export function pinchReading(a: SvgTouchPoint, b: SvgTouchPoint): PinchReading {
  const dx = b.clientX - a.clientX;
  const dy = b.clientY - a.clientY;
  return {
    distance: Math.hypot(dx, dy),
    midpoint: { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 },
  };
}

/** The callbacks a touch gesture session reports to its owner. */
export type SvgTouchGestureOptions = {
  /** Called with the scale actually applied after a pinch; never for a pure drag. */
  readonly onZoom: (scale: number) => void;
};

/** The handle a caller keeps to tear the gesture listeners down on unmount. */
export type SvgTouchGestures = {
  destroy(): void;
};

/**
 * Add touch gestures to a scroll container that already owns an
 * `SvgViewportController`:
 *
 *  · one finger drags the drawing by scrolling the container (the SVG is
 *    larger than its box, so native scrolling is exactly the pan);
 *  · two fingers pinch-zoom around their midpoint through the SAME controller
 *    the toolbar and Ctrl+wheel use, so there is one zoom model, not two.
 *
 * The container must carry `touch-action: none` (PlantUmlGraph sets it): that
 * is what stops the browser from panning/zooming the page itself, and it is
 * also why the drag has to be implemented here rather than left to the
 * browser. Mouse and pen input are deliberately ignored — the desktop
 * wheel/scroll behaviour stays exactly as it was.
 *
 * A drag that turned into a pan or a pinch swallows the click the browser
 * would otherwise fire on release, so panning never selects a node.
 */
export function createSvgTouchGestures(
  container: HTMLElement,
  controller: SvgViewportController,
  options: SvgTouchGestureOptions,
): SvgTouchGestures {
  /** The fingers currently down, keyed by pointer id. */
  const pointers = new Map<number, SvgTouchPoint>();
  /** The previous pinch frame, `null` while fewer than two fingers are down. */
  let pinchFrom: PinchReading | null = null;
  /** The previous single-finger frame, `null` unless exactly one finger is down. */
  let panFrom: SvgTouchPoint | null = null;
  /** Set once a gesture moves enough to be a drag; the release click is then swallowed. */
  let dragged = false;

  const pointOf = (event: PointerEvent): SvgTouchPoint => ({
    clientX: event.clientX,
    clientY: event.clientY,
  });

  /** A pinch frame is read from the first two fingers in registration order. */
  const currentPinch = (): PinchReading | null => {
    const fingers = [...pointers.values()];
    if (fingers.length < 2) return null;
    return pinchReading(fingers[0], fingers[1]);
  };

  const onPointerDown = (event: PointerEvent): void => {
    // Desktop mouse/pen input keeps its existing behaviour.
    if (event.pointerType !== 'touch') return;
    // Only the FIRST finger of a gesture resets the drag flag: putting a second
    // finger down mid-drag must not turn the release into a click.
    if (pointers.size === 0) dragged = false;
    pointers.set(event.pointerId, pointOf(event));
    if (pointers.size === 1) {
      panFrom = pointOf(event);
      pinchFrom = null;
    } else {
      pinchFrom = currentPinch();
      panFrom = null;
    }
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, pointOf(event));

    if (pointers.size >= 2) {
      // The browser's own gesture is suppressed by touch-action; this keeps the
      // JS-side contract explicit (and is what a test can read as "not a page zoom").
      event.preventDefault();
      const previous = pinchFrom;
      const reading = currentPinch();
      pinchFrom = reading;
      if (previous === null || reading === null) return;
      if (reading.distance > 0 && previous.distance > 0) {
        const factor = reading.distance / previous.distance;
        if (Math.abs(factor - 1) > 1e-4) {
          options.onZoom(controller.zoomBy(factor, reading.midpoint));
        }
      }
      // Fingers moving together pan the drawing with them; the zoom above
      // already kept the midpoint's content fixed, so this is pure translation.
      container.scrollLeft += previous.midpoint.clientX - reading.midpoint.clientX;
      container.scrollTop += previous.midpoint.clientY - reading.midpoint.clientY;
      dragged = true;
      return;
    }

    const previous = panFrom;
    panFrom = pointOf(event);
    if (previous === null) return;
    const dx = previous.clientX - event.clientX;
    const dy = previous.clientY - event.clientY;
    if (dx !== 0 || dy !== 0) dragged = true;
    container.scrollLeft += dx;
    container.scrollTop += dy;
  };

  const onPointerEnd = (event: PointerEvent): void => {
    if (!pointers.delete(event.pointerId)) return;
    pinchFrom = currentPinch();
    const remaining = [...pointers.values()];
    panFrom = remaining.length === 1 ? remaining[0] : null;
  };

  const onClickCapture = (event: MouseEvent): void => {
    if (!dragged) return;
    dragged = false;
    event.preventDefault();
    event.stopPropagation();
  };

  container.addEventListener('pointerdown', onPointerDown);
  // Move/release are watched on the window so a finger that leaves the box
  // still pans and still ends the gesture.
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerEnd);
  window.addEventListener('pointercancel', onPointerEnd);
  container.addEventListener('click', onClickCapture, true);

  return {
    destroy(): void {
      container.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerEnd);
      window.removeEventListener('pointercancel', onPointerEnd);
      container.removeEventListener('click', onClickCapture, true);
      pointers.clear();
    },
  };
}
