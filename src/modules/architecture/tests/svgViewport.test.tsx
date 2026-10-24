import assert from 'node:assert/strict';

import { beforeEach, test } from 'vitest';

import {
  applyZoomScale,
  centeredScrollForDrawingRect,
  clampZoomScale,
  createSvgDragPan,
  createSvgViewport,
  fitAllZoomScale,
  fitAreaInsets,
  fitAvoidingCorners,
  fitPlacementAvoidingCorners,
  fitZoomScale,
  measureHostSize,
  measureViewportSize,
  MAX_ZOOM_SCALE,
  MIN_READABLE_ZOOM_SCALE,
  MIN_USEFUL_OVERVIEW_SCALE,
  MIN_ZOOM_SCALE,
  PAN_THRESHOLD_PX,
  readSvgNaturalSize,
  zoomedSvgSize,
} from '@/modules/architecture/svgViewport';
import {
  MIN_READABLE_FONT_PX,
  READABLE_ZOOM_SCALE,
  RENDERED_LABEL_FONT_PX,
} from '@/modules/architecture/readableZoom';

/**
 * The renderer-neutral SVG viewport used by PlantUmlGraph.
 *
 * The renderer emits SVGs at their natural size and has no zoom API, so the
 * panel resizes the SVG by rewriting `width`/`height` from its `viewBox`. These
 * cases pin the arithmetic (aspect ratio, the 100% fit ceiling, the readable fit
 * floor and the 5%–400% manual clamp) and the two DOM consequences the panel
 * depends on: the element's laid out size — which is what gives the scroll
 * container its extent — equals the scaled natural size, and an anchored wheel
 * zoom scrolls the container so the point under the cursor does not move.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A minimal stand-in for a renderer SVG: natural size carried by the viewBox. */
function makeSvg(viewBox = '0 0 1000 500'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  svg.setAttribute('viewBox', viewBox);
  const [, , width, height] = viewBox.split(/\s+/);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  return svg;
}

/** jsdom performs no layout, so the container's content box is pinned by hand. */
function makeContainer(width: number, height: number, svg: SVGSVGElement): HTMLDivElement {
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(container, 'clientHeight', { configurable: true, value: height });
  container.append(svg);
  document.body.append(container);
  return container;
}

/** The production formatter rounds to hundredths; mirror it when comparing. */
function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * jsdom ships no `PointerEvent`. This stand-in extends `MouseEvent` (so
 * `clientX`/`clientY`/`button` are real) and adds the two fields the drag layer
 * reads: `pointerId` to follow one gesture and `pointerType` to hand fingers to
 * the touch gesture layer.
 */
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? '';
  }
}

/** Dispatch one pointer event to `target` (the pan watches moves on the window). */
function pointer(target: EventTarget, type: string, init: PointerEventInit = {}): MouseEvent {
  const event = new TestPointerEvent(type, { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

/** A click as the browser emits it after a release. */
function click(target: EventTarget): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  document.body.replaceChildren();
});

test('fit keeps the aspect ratio and never upscales past 100%', () => {
  const natural = { width: 1000, height: 500 };

  // The height is the binding dimension: 900/1000 = 0.9, 400/500 = 0.8. This is
  // above the readable floor, so the fit is the geometric one.
  assert.equal(fitZoomScale(natural, { width: 900, height: 400 }), 0.8);
  const fitted = zoomedSvgSize(natural, 0.8);
  assert.deepEqual(fitted, { width: 800, height: 400 });
  assert.equal(fitted.width / fitted.height, natural.width / natural.height, 'the drawing keeps its shape');

  // A diagram smaller than its container is shown at natural size, not blown up.
  assert.equal(fitZoomScale(natural, { width: 2000, height: 2000 }), 1);

  // An unmeasurable container (hidden tab, jsdom) keeps the natural size.
  assert.equal(fitZoomScale(natural, { width: 0, height: 0 }), 1);
});

test('the fit floor is derived from the smallest readable label, not the 5% manual clamp', () => {
  // The lower bound is 9px of on-screen text ÷ the renderer's 13px label.
  assert.equal(MIN_READABLE_FONT_PX, 9);
  assert.equal(RENDERED_LABEL_FONT_PX, 13);
  assert.equal(READABLE_ZOOM_SCALE, MIN_READABLE_FONT_PX / RENDERED_LABEL_FONT_PX);
  assert.equal(MIN_READABLE_ZOOM_SCALE, READABLE_ZOOM_SCALE);

  // A graph that would need 3.5% to fit a 1151px panel returns the readable
  // floor from fit(), while the explicit whole-graph fit still reaches 5%.
  const natural = { width: 32880, height: 9860 };
  const viewport = { width: 1151, height: 700 };
  assert.equal(fitZoomScale(natural, viewport), MIN_READABLE_ZOOM_SCALE);
  assert.equal(fitZoomScale(natural, viewport, MIN_ZOOM_SCALE), MIN_ZOOM_SCALE);
  assert.equal(fitAllZoomScale(natural, viewport), MIN_ZOOM_SCALE);

  // The readable floor is still bounded by the manual range.
  assert.ok(MIN_READABLE_ZOOM_SCALE > MIN_ZOOM_SCALE && MIN_READABLE_ZOOM_SCALE < MAX_ZOOM_SCALE);
});

test('semantic mode records the scale and never rewrites the SVG size (k = 1)', () => {
  // The semantic engine owns the ONLY proportion: it rewrites the geometry and
  // sizes the element 1:1. The controller must therefore record the scale and
  // leave width/height ALONE — a second CSS factor on top of the map is the
  // double-scale defect the fit solve removes.
  const svg = makeSvg('0 0 1000 500');
  const container = makeContainer(800, 600, svg);
  const controller = createSvgViewport(container);
  controller.setSemanticMode({ width: 1000, height: 500 });
  assert.equal(controller.attach(svg), 1);
  const widthBefore = svg.getAttribute('width');
  const heightBefore = svg.getAttribute('height');

  assert.equal(controller.zoomTo(0.37), 0.37);
  assert.equal(controller.zoomBy(1.5), 0.37 * 1.5);
  assert.equal(svg.getAttribute('width'), widthBefore, 'the semantic drawing stays 1:1');
  assert.equal(svg.getAttribute('height'), heightBefore);
  assert.deepEqual(controller.semanticBaseSize(), { width: 1000, height: 500 });
});

test('zoom rewrites width/height from the viewBox and leaves the drawing untouched', () => {
  const svg = makeSvg('0 0 1000 500');

  assert.equal(applyZoomScale(svg, 2), 2);
  assert.equal(svg.getAttribute('width'), '2000');
  assert.equal(svg.getAttribute('height'), '1000');
  assert.equal(svg.getAttribute('viewBox'), '0 0 1000 500', 'the viewBox is what keeps the SVG vector-sharp');

  assert.equal(applyZoomScale(svg, 0.25), 0.25);
  assert.equal(svg.getAttribute('width'), '250');
  assert.equal(svg.getAttribute('height'), '125');
});

test('the scale is clamped to 5%–400%', () => {
  assert.equal(clampZoomScale(0.001), MIN_ZOOM_SCALE);
  assert.equal(clampZoomScale(100), MAX_ZOOM_SCALE);
  assert.equal(clampZoomScale(Number.NaN), 1, 'a non-finite request means natural size');

  const svg = makeSvg();
  assert.equal(applyZoomScale(svg, 0.0001), MIN_ZOOM_SCALE);
  assert.equal(svg.getAttribute('width'), '50');
  assert.equal(applyZoomScale(svg, 99), MAX_ZOOM_SCALE);
  assert.equal(svg.getAttribute('width'), '4000');
  assert.equal(svg.getAttribute('height'), '2000');
});

test('the natural size comes from the viewBox, falling back to the root size', () => {
  assert.deepEqual(readSvgNaturalSize(makeSvg('10 20 300 200')), { width: 300, height: 200 });

  const noViewBox = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  noViewBox.setAttribute('width', '640');
  noViewBox.setAttribute('height', '480');
  assert.deepEqual(readSvgNaturalSize(noViewBox), { width: 640, height: 480 });

  const percentages = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  percentages.setAttribute('width', '100%');
  percentages.setAttribute('height', '100%');
  assert.equal(readSvgNaturalSize(percentages), null, 'percentage sizes are not a coordinate space');
});

test('the laid-out SVG size — the scroll extent — equals the scaled natural size', () => {
  const svg = makeSvg('0 0 1586 1176');
  const container = makeContainer(400, 600, svg);
  const viewport = createSvgViewport(container);
  viewport.attach(svg);

  // The whole-graph fit is min(400/1586, 600/1176, 1) = 0.25220… (below the
  // readable floor, which is exactly why it is not the default).
  const fitAll = viewport.fitAll();
  const natural = readSvgNaturalSize(svg);
  assert.ok(natural);
  const fitted = zoomedSvgSize(natural, fitAll);
  assert.equal(rounded(fitted.width), 400);
  assert.equal(Number(svg.getAttribute('width')), rounded(fitted.width));
  assert.equal(Number(svg.getAttribute('height')), rounded(fitted.height));

  // The readable `fit()` stops at the legible floor, so the drawing keeps its
  // scroll extent (it is wider/taller than the box) instead of shrinking into
  // an unreadable smear.
  const readable = viewport.fit();
  assert.equal(readable, MIN_READABLE_ZOOM_SCALE);
  assert.equal(Number(svg.getAttribute('width')), rounded(natural.width * readable));
  assert.ok(natural.width * readable > container.clientWidth, 'a readable fit can require scrolling');

  // Zooming in grows the element itself, so the container's scroll extent grows
  // with it — no CSS transform and no manual scroll-range bookkeeping.
  viewport.zoomTo(2);
  const zoomed = zoomedSvgSize(natural, 2);
  assert.equal(Number(svg.getAttribute('width')), zoomed.width);
  assert.equal(Number(svg.getAttribute('height')), zoomed.height);
  assert.equal(zoomed.width / zoomed.height, natural.width / natural.height);
});

test('an anchored zoom scrolls the container so the point under the cursor stays put', () => {
  const svg = makeSvg('0 0 1000 500');
  const container = makeContainer(400, 300, svg);
  // jsdom reports a zero rect. Pin the drawn SVG's box so the anchor math has
  // a real origin to work from.
  svg.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500,
    toJSON: () => ({}),
  }) as DOMRect;

  const viewport = createSvgViewport(container);
  viewport.attach(svg);
  viewport.zoomTo(1);

  // Doubling around (300, 100): that point is 300/100 user units from the SVG
  // origin, so at 2× it lands 600/200 px away and the container must scroll by
  // the 300/100 px difference to keep it under the pointer.
  assert.equal(viewport.zoomBy(2, { clientX: 300, clientY: 100 }), 2);
  assert.equal(container.scrollLeft, 300);
  assert.equal(container.scrollTop, 100);

  // Without an anchor the size still changes, but the scroll position does not.
  const before = container.scrollLeft;
  assert.equal(viewport.zoomBy(0.5), 1);
  assert.equal(container.scrollLeft, before);
});

test('the controller clamps zoom-by at the range ends instead of overshooting', () => {
  const svg = makeSvg();
  const container = makeContainer(800, 600, svg);
  const viewport = createSvgViewport(container);
  viewport.attach(svg);

  viewport.zoomTo(4);
  assert.equal(viewport.zoomBy(2), MAX_ZOOM_SCALE);
  assert.equal(svg.getAttribute('width'), '4000');

  viewport.zoomTo(0.05);
  assert.equal(viewport.zoomBy(0.5), MIN_ZOOM_SCALE);
  assert.equal(svg.getAttribute('width'), '50');
});

test('a drag pans the container only after it travels the 4px threshold', () => {
  const svg = makeSvg();
  const container = makeContainer(400, 300, svg);
  const pan = createSvgDragPan(container, { canPanFrom: () => true });
  try {
    assert.equal(PAN_THRESHOLD_PX, 4);
    assert.equal(container.style.cursor, 'grab', 'the canvas advertises that it can be dragged');

    pointer(container, 'pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 200, clientY: 200 });
    // Below the threshold: a shaky click must not move the drawing.
    pointer(window, 'pointermove', { pointerId: 1, pointerType: 'mouse', clientX: 197, clientY: 200 });
    assert.equal(container.scrollLeft, 0, 'a 3px wobble is still a click');
    assert.equal(container.style.cursor, 'grab');

    // Past it: the whole delta from the press applies, not just the excess.
    pointer(window, 'pointermove', { pointerId: 1, pointerType: 'mouse', clientX: 180, clientY: 160 });
    assert.equal(container.scrollLeft, 20, 'the drawing follows the pointer leftwards');
    assert.equal(container.scrollTop, 40, 'and upwards');
    assert.equal(container.style.cursor, 'grabbing');

    pointer(window, 'pointerup', { pointerId: 1, pointerType: 'mouse', clientX: 180, clientY: 160 });
    assert.equal(container.style.cursor, 'grab', 'the drag state ends with the press');
  } finally {
    pan.destroy();
  }
});

test('a press on a node is never a pan; a middle-button drag is, and a left drag swallows its click', () => {
  const svg = makeSvg();
  const container = makeContainer(400, 300, svg);
  const node = document.createElementNS(SVG_NS, 'rect');
  node.setAttribute('data-entity-id', 'src/a.ts');
  svg.append(node);
  const pan = createSvgDragPan(container, {
    canPanFrom: (target) => !(target instanceof Element && target.closest('[data-entity-id]') !== null),
  });
  try {
    // Left button on the node: selection/drill, never a pan.
    pointer(node, 'pointerdown', { pointerId: 2, pointerType: 'mouse', button: 0, clientX: 100, clientY: 100 });
    pointer(window, 'pointermove', { pointerId: 2, pointerType: 'mouse', clientX: 50, clientY: 50 });
    assert.equal(container.scrollLeft, 0, 'a press on a node stays a click');
    pointer(window, 'pointerup', { pointerId: 2, pointerType: 'mouse', clientX: 50, clientY: 50 });
    assert.equal(click(node).defaultPrevented, false, 'the node click still reaches the drawing');

    // Middle button pans from anywhere, the node included.
    pointer(node, 'pointerdown', { pointerId: 3, pointerType: 'mouse', button: 1, clientX: 300, clientY: 300 });
    pointer(window, 'pointermove', { pointerId: 3, pointerType: 'mouse', clientX: 250, clientY: 300 });
    assert.equal(container.scrollLeft, 50, 'a middle-button drag pans');
    pointer(window, 'pointerup', { pointerId: 3, pointerType: 'mouse', clientX: 250, clientY: 300 });
    assert.equal(
      click(node).defaultPrevented,
      false,
      'a middle release fires auxclick, not click: it must not eat the next left click',
    );

    // A LEFT drag does produce a click on release, and that one is swallowed.
    pointer(container, 'pointerdown', { pointerId: 6, pointerType: 'mouse', button: 0, clientX: 300, clientY: 300 });
    pointer(window, 'pointermove', { pointerId: 6, pointerType: 'mouse', clientX: 250, clientY: 300 });
    pointer(window, 'pointerup', { pointerId: 6, pointerType: 'mouse', clientX: 250, clientY: 300 });
    assert.equal(click(node).defaultPrevented, true, 'the release click of a pan is swallowed');
    assert.equal(click(node).defaultPrevented, false, 'only the release click is swallowed');
  } finally {
    pan.destroy();
  }
});

test('a cancelled drag leaves no drag state behind and touch stays with the gesture layer', () => {
  const svg = makeSvg();
  const container = makeContainer(400, 300, svg);
  const pan = createSvgDragPan(container, { canPanFrom: () => true });
  try {
    pointer(container, 'pointerdown', { pointerId: 4, pointerType: 'mouse', button: 0, clientX: 300, clientY: 300 });
    pointer(window, 'pointermove', { pointerId: 4, pointerType: 'mouse', clientX: 200, clientY: 300 });
    assert.equal(container.scrollLeft, 100);

    pointer(container, 'pointercancel', { pointerId: 4, pointerType: 'mouse', clientX: 200, clientY: 300 });
    assert.equal(container.style.cursor, 'grab', 'cancel ends the pan');
    pointer(window, 'pointermove', { pointerId: 4, pointerType: 'mouse', clientX: 100, clientY: 100 });
    assert.equal(container.scrollLeft, 100, 'a cancelled gesture must not keep panning');
    assert.equal(click(container).defaultPrevented, false, 'no drag is pending, so the next click is a click');

    // Fingers are the touch gesture layer's input, never the mouse pan's.
    pointer(container, 'pointerdown', { pointerId: 5, pointerType: 'touch', button: 0, clientX: 300, clientY: 300 });
    pointer(window, 'pointermove', { pointerId: 5, pointerType: 'touch', clientX: 200, clientY: 300 });
    assert.equal(container.scrollLeft, 100, 'a finger must not be panned twice');
    pointer(window, 'pointerup', { pointerId: 5, pointerType: 'touch', clientX: 200, clientY: 300 });
  } finally {
    pan.destroy();
  }
});

/**
 * The fitted drawing's box as the layout draws it: horizontally and vertically
 * centred (`margin: 0 auto` + auto block margins), and top-aligned once it is
 * taller than the box. Mirrors the CSS the host uses, so an "intersection" here
 * is the browser's.
 */
function fittedDrawingRect(
  natural: { width: number; height: number },
  host: { width: number; height: number },
  scale: number,
): { left: number; top: number; right: number; bottom: number } {
  const width = natural.width * scale;
  const height = natural.height * scale;
  return {
    left: (host.width - width) / 2,
    right: (host.width + width) / 2,
    top: height <= host.height ? (host.height - height) / 2 : 0,
    bottom: height <= host.height ? (host.height + height) / 2 : height,
  };
}

/** Strict rectangle intersection: touching edges do not count. */
function intersects(
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; width: number; height: number },
): boolean {
  return a.left < b.left + b.width && b.left < a.right
    && a.top < b.top + b.height && b.top < a.bottom;
}

const NATURAL = { width: 1000, height: 500 };
const HOST = { width: 800, height: 600 };
/** The bottom-right minimap: it reaches into the fitted drawing's band. */
const CORNER = { left: 500, top: 450, width: 100, height: 100 };

test('fitAvoidingCorners returns the plain fit when no corner intersects it', () => {
  // The geometric fit is 0.8 (800×400); this corner sits in the free top-left.
  const clear = { left: 0, top: 0, width: 80, height: 40 };
  assert.equal(fitAvoidingCorners(NATURAL, HOST, []), fitZoomScale(NATURAL, HOST));
  assert.equal(fitAvoidingCorners(NATURAL, HOST, [clear]), fitZoomScale(NATURAL, HOST));
  // "Byte-identical", not merely close: the same call returns the same double.
  assert.ok(Object.is(
    fitAvoidingCorners(NATURAL, HOST, [clear]),
    fitZoomScale(NATURAL, HOST),
  ));
  // The minScale argument is forwarded to the same fit, so the fallback sits on
  // the whole-graph floor when that is what the caller asked for.
  assert.equal(
    fitAvoidingCorners(NATURAL, HOST, [clear], MIN_ZOOM_SCALE),
    fitZoomScale(NATURAL, HOST, MIN_ZOOM_SCALE),
  );
});

test('fitAvoidingCorners shrinks to the largest scale that clears an intersecting corner', () => {
  const fit = fitZoomScale(NATURAL, HOST);
  assert.equal(fit, 0.8);
  assert.ok(intersects(fittedDrawingRect(NATURAL, HOST, fit), CORNER), 'the fixture really overlaps at the fit');

  const scale = fitAvoidingCorners(NATURAL, HOST, [CORNER]);
  // Clearing vertically is cheaper than clearing horizontally here:
  // 2·450 − 600 = 300 → 300/500 = 0.6, versus 500/1000 = 0.5.
  assert.equal(scale, 0.6);
  assert.equal(
    intersects(fittedDrawingRect(NATURAL, HOST, scale), CORNER),
    false,
    'the returned scale must not intersect the corner',
  );
  assert.ok(
    intersects(fittedDrawingRect(NATURAL, HOST, scale + 0.001), CORNER),
    'one step above it must intersect: 0.6 is the LARGEST clearing scale',
  );
});

test('fitAvoidingCorners takes the most conservative limit across several corners', () => {
  // The drawing is horizontally centred, so a corner's horizontal limit is
  // (2·left − host.width)/natural.width: loose 600/1000 = 0.6, tight 400/1000 =
  // 0.4. The vertical route is cheaper for each (bottom ≤ top: 0.64 and 0.6),
  // so the largest clearing scale is 0.64 and 0.6 respectively.
  const loose = { left: 700, top: 460, width: 100, height: 140 };   // clears at 0.64
  const tight = { left: 600, top: 450, width: 200, height: 150 };   // clears at 0.6
  const looseScale = fitAvoidingCorners(NATURAL, HOST, [loose]);
  const tightScale = fitAvoidingCorners(NATURAL, HOST, [tight]);
  assert.equal(looseScale, 0.64);
  assert.equal(tightScale, 0.6);
  assert.ok(!intersects(fittedDrawingRect(NATURAL, HOST, looseScale), loose), 'loose corner is cleared');
  assert.ok(!intersects(fittedDrawingRect(NATURAL, HOST, tightScale), tight), 'tight corner is cleared');
  assert.equal(
    fitAvoidingCorners(NATURAL, HOST, [loose, tight]),
    Math.min(looseScale, tightScale),
    'the drawing must clear BOTH corners, so the tighter limit wins',
  );
  // Order must not matter: the answer is the same set of constraints.
  assert.equal(
    fitAvoidingCorners(NATURAL, HOST, [tight, loose]),
    fitAvoidingCorners(NATURAL, HOST, [loose, tight]),
  );
});

/* ── the measured form: one-sided yielding instead of a symmetric shrink ─────────────────── */

const MEASURED_NATURAL = { width: 4395.67, height: 1943.7 };
const MEASURED_VIEWPORT = { width: 1151, height: 615 };
/** The minimap and the zoom cluster, both anchored to the bottom-right corner. */
const MEASURED_CORNERS = [
  { left: 985, top: 509, width: 166, height: 106 },
  { left: 1074, top: 482, width: 77, height: 133 },
];
/** What the canvas really affords: (1151−24)/4395.67 — the p-3 padding is 12px a side. */
const THEORETICAL_FIT = Math.min((1151 - 24) / 4395.67, (615 - 24) / 1943.7);

/** The drawing's box at a placement, in the content box's coordinates. */
function placedDrawingRect(
  natural: { width: number; height: number },
  placement: { scale: number; offsetX: number; offsetY: number },
): { left: number; top: number; right: number; bottom: number } {
  return {
    left: placement.offsetX,
    top: placement.offsetY,
    right: placement.offsetX + natural.width * placement.scale,
    bottom: placement.offsetY + natural.height * placement.scale,
  };
}

test('the measured form keeps ≥95% of the theoretical fit by YIELDING to the corner chrome', () => {
  // The shipped behaviour shrank the drawing symmetrically to 18.1% of the
  // canvas, leaving 30% of the width unused, because a CENTRED drawing can only
  // clear a bottom-right corner by getting smaller.
  const placement = fitPlacementAvoidingCorners(
    MEASURED_NATURAL,
    MEASURED_VIEWPORT,
    MEASURED_CORNERS,
    MIN_ZOOM_SCALE,
  );

  assert.ok(
    placement.scale >= THEORETICAL_FIT * 0.95,
    `the fit must keep at least 95% of the theoretical maximum ${THEORETICAL_FIT}: `
      + `got ${placement.scale} at (${placement.offsetX}, ${placement.offsetY})`,
  );

  // The drawing really is clear of BOTH corner rectangles at that placement.
  const rect = placedDrawingRect(MEASURED_NATURAL, placement);
  for (const corner of MEASURED_CORNERS) assert.equal(intersects(rect, corner), false);
  assert.ok(rect.left >= 0 && rect.top >= 0, 'the yielded drawing stays inside the canvas');
  assert.ok(rect.right <= MEASURED_VIEWPORT.width + 1e-6);
  assert.ok(rect.bottom <= MEASURED_VIEWPORT.height + 1e-6);

  // The one-sided yield is what bought the size: the drawing is NOT centred
  // (the centred placement at this scale would overlap the chrome).
  assert.ok(
    Math.abs(placement.offsetY - (MEASURED_VIEWPORT.height - MEASURED_NATURAL.height * placement.scale) / 2) > 1,
    'the drawing must be moved off-centre to clear the chrome',
  );
});

test('when every placement intersects, the fit drops below the theoretical maximum', () => {
  // A full-width band across the bottom quarter leaves no horizontal way out
  // and only a third of the height: any placement at the fit intersects, so the
  // scale has to come down.
  const band = { left: 0, top: 300, width: MEASURED_VIEWPORT.width, height: 315 };
  const placement = fitPlacementAvoidingCorners(
    MEASURED_NATURAL,
    MEASURED_VIEWPORT,
    [band],
    MIN_ZOOM_SCALE,
  );
  assert.ok(
    placement.scale < THEORETICAL_FIT * 0.95,
    `no placement clears the band at the fit, so the scale must drop; got ${placement.scale}`,
  );
  const rect = placedDrawingRect(MEASURED_NATURAL, placement);
  assert.equal(intersects(rect, band), false, 'the reduced fit still clears the band');

  // The impossible case (a corner covering the whole canvas) degrades to the
  // plain centred fit instead of collapsing to nothing — the old fallback.
  const everywhere = { left: -10, top: -10, width: MEASURED_VIEWPORT.width + 20, height: MEASURED_VIEWPORT.height + 20 };
  const fallback = fitPlacementAvoidingCorners(MEASURED_NATURAL, MEASURED_VIEWPORT, [everywhere], MIN_ZOOM_SCALE);
  assert.equal(fallback.scale, fitZoomScale(MEASURED_NATURAL, MEASURED_VIEWPORT, MIN_ZOOM_SCALE));
});

test('fitAvoidingCorners falls back to the plain fit for an unmeasurable or oversized corner', () => {
  const fit = fitZoomScale(NATURAL, HOST);
  // A corner covering the whole canvas leaves no positive scale to clear:
  // degrade to the original fit instead of collapsing or throwing.
  assert.equal(
    fitAvoidingCorners(NATURAL, HOST, [{ left: -100, top: -100, width: 2000, height: 2000 }]),
    fit,
  );
  // An unmeasured (zero-area) corner constrains nothing.
  assert.equal(fitAvoidingCorners(NATURAL, HOST, [{ left: 0, top: 0, width: 0, height: 0 }]), fit);
  // A degenerate drawing/host is the same "cannot reason about it" case.
  assert.equal(fitAvoidingCorners({ width: 0, height: 0 }, HOST, [CORNER]), fitZoomScale({ width: 0, height: 0 }, HOST));
  assert.equal(fitAvoidingCorners(NATURAL, { width: 0, height: 0 }, [CORNER]), 1);
});

/* ── the phone geometry: 366×505 canvas, a 44px minimap button, a ~1.05:1 drawing ───────── */

/**
 * The narrow-container layout turns the session's 5116×2910 drawing into a
 * near-square one (~1.05:1). The phone canvas is 366×505 and its only corner
 * chrome by default is the 44×44 collapsed-minimap button at the bottom right.
 */
const PHONE_NATURAL = { width: 5116, height: 4872 };
const PHONE_VIEWPORT = { width: 366, height: 505 };
/** The collapsed minimap button: 44×44, 12px in from the canvas's bottom-right. */
const PHONE_MINIMAP = {
  left: PHONE_VIEWPORT.width - 12 - 44,
  top: PHONE_VIEWPORT.height - 12 - 44,
  width: 44,
  height: 44,
};
/** What the canvas's own content box affords for that drawing. */
const PHONE_THEORETICAL_FIT = Math.min(
  PHONE_VIEWPORT.width / PHONE_NATURAL.width,
  PHONE_VIEWPORT.height / PHONE_NATURAL.height,
  1,
);

test('the phone fit keeps ≥95% of the theoretical maximum and clears the minimap button', () => {
  const placement = fitPlacementAvoidingCorners(
    PHONE_NATURAL,
    PHONE_VIEWPORT,
    [PHONE_MINIMAP],
    MIN_ZOOM_SCALE,
  );
  assert.ok(
    placement.scale >= PHONE_THEORETICAL_FIT * 0.95,
    `the phone fit must keep ≥95% of ${PHONE_THEORETICAL_FIT}: got ${placement.scale}`,
  );
  const rect = placedDrawingRect(PHONE_NATURAL, placement);
  assert.equal(intersects(rect, PHONE_MINIMAP), false, 'the drawing must not run under the minimap button');
  assert.ok(rect.left >= 0 && rect.top >= 0, 'the drawing stays inside the canvas');
  assert.ok(rect.right <= PHONE_VIEWPORT.width + 1e-6);
  assert.ok(rect.bottom <= PHONE_VIEWPORT.height + 1e-6);
  // The drawing really fills the canvas width the task measures.
  assert.ok(rect.right - rect.left >= PHONE_VIEWPORT.width * 0.95);
});

test('the shipped tall corner column is avoided by TRANSLATING, not by shrinking', () => {
  // The pre-fix phone chrome was a 44px-wide column reaching ~256px up the
  // right edge (minimap button + gap + 204px zoom column). On the session's
  // wide drawing (5116×2910) the centred fit overlaps it; moving the drawing
  // to the top of the canvas clears it at the SAME scale.
  const wideNatural = { width: 5116, height: 2910 };
  const tallChrome = {
    left: PHONE_VIEWPORT.width - 12 - 44,
    top: PHONE_VIEWPORT.height - 12 - 256,
    width: 44,
    height: 256,
  };
  const fit = Math.min(PHONE_VIEWPORT.width / wideNatural.width, PHONE_VIEWPORT.height / wideNatural.height);
  assert.ok(intersects(fittedDrawingRect(wideNatural, PHONE_VIEWPORT, fit), tallChrome), 'the fixture really overlaps at the centred fit');

  const placement = fitPlacementAvoidingCorners(wideNatural, PHONE_VIEWPORT, [tallChrome], MIN_ZOOM_SCALE);
  assert.ok(
    placement.scale >= fit * 0.95,
    `a translation exists, so the fit must not shrink: got ${placement.scale} vs ${fit}`,
  );
  const rect = placedDrawingRect(wideNatural, placement);
  assert.equal(intersects(rect, tallChrome), false, 'the translated drawing clears the column');
  const centredTop = (PHONE_VIEWPORT.height - wideNatural.height * placement.scale) / 2;
  assert.ok(
    Math.abs(placement.offsetY - centredTop) > 1,
    'clearing the column is what moved the drawing off centre',
  );
});

test('only when every placement intersects does the phone fit drop below the maximum', () => {
  // A full-width band leaves less height than the fitted drawing needs in
  // every vertical position, so no translation can save the scale.
  const band = { left: 0, top: 300, width: PHONE_VIEWPORT.width, height: PHONE_VIEWPORT.height - 300 };
  const placement = fitPlacementAvoidingCorners(
    PHONE_NATURAL,
    PHONE_VIEWPORT,
    [band],
    MIN_ZOOM_SCALE,
  );
  assert.ok(
    placement.scale < PHONE_THEORETICAL_FIT * 0.95,
    `no placement clears the band at the fit, so the scale must drop; got ${placement.scale}`,
  );
  const rect = placedDrawingRect(PHONE_NATURAL, placement);
  assert.equal(intersects(rect, band), false, 'the reduced fit still clears the band');
});

test('the overview threshold sits below the readable floor and above the manual floor', () => {
  // It is a presentation cue for an unreadably small overview, not a zoom
  // limit: manual zoom-out still reaches MIN_ZOOM_SCALE.
  assert.ok(MIN_USEFUL_OVERVIEW_SCALE > MIN_ZOOM_SCALE);
  assert.ok(MIN_USEFUL_OVERVIEW_SCALE < MIN_READABLE_ZOOM_SCALE);
});

test('centeredScrollForDrawingRect centres a package frame in the drawing user units', () => {
  const offsets = centeredScrollForDrawingRect(
    { width: 366, height: 505 },
    { left: 2000, top: 1000, width: 400, height: 300 },
    0.5,
  );
  // The frame's centre in screen pixels is (2000+200)·0.5 = 1100 by
  // (1000+150)·0.5 = 575; minus half the content box.
  assert.equal(offsets.left, 1100 - 183);
  assert.equal(offsets.top, 575 - 252.5);
  // A frame at the drawing's origin clamps at zero instead of scrolling past it.
  assert.deepEqual(
    centeredScrollForDrawingRect({ width: 366, height: 505 }, { left: 0, top: 0, width: 100, height: 100 }, 0.5),
    { left: 0, top: 0 },
  );
});


/* ── the fullscreen Fit box: the host less its measured chrome ─────────────────────────────── */

test('fitAreaInsets turns the measured Fit area into the host padding', () => {
  // Fullscreen, 1440×765, toolbar band 76 at the top, a 60 px corner column
  // removed on the right. The insets are EXACTLY the chrome — no reserved
  // 12 px margin is added anywhere.
  assert.deepEqual(
    fitAreaInsets({ width: 1440, height: 765 }, { left: 0, top: 76, width: 1380, height: 689 }),
    { top: 76, right: 60, bottom: 0, left: 0 },
  );
  // No overlay measured: the area is the whole host and every inset is zero,
  // which is what makes the fullscreen canvas reserve nothing of its own.
  assert.deepEqual(
    fitAreaInsets({ width: 1440, height: 765 }, { left: 0, top: 0, width: 1440, height: 765 }),
    { top: 0, right: 0, bottom: 0, left: 0 },
  );
});

test('measureHostSize reads the FULL host box, unlike the content-box reading', () => {
  const host = document.createElement('div');
  host.style.padding = '12px';
  Object.defineProperty(host, 'clientWidth', { configurable: true, value: 1440 });
  Object.defineProperty(host, 'clientHeight', { configurable: true, value: 765 });
  document.body.append(host);
  // clientWidth/Height include padding; that is the fullscreen "whole host"
  // reading. measureViewportSize subtracts the declared padding (the in-flow
  // content box), so the two must not be confused on the overlay.
  assert.deepEqual(measureHostSize(host), { width: 1440, height: 765 });
  assert.deepEqual(measureViewportSize(host), { width: 1416, height: 741 });
  host.remove();
});
