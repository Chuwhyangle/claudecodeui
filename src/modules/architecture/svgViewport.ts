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
