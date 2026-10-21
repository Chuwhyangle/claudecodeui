import assert from 'node:assert/strict';

import { beforeEach, test } from 'vitest';

import {
  applyZoomScale,
  clampZoomScale,
  createSvgViewport,
  fitZoomScale,
  MAX_ZOOM_SCALE,
  MIN_ZOOM_SCALE,
  readSvgNaturalSize,
  zoomedSvgSize,
} from '@/modules/architecture/svgViewport';

/**
 * The renderer-neutral SVG viewport used by PlantUmlGraph.
 *
 * The renderer emits SVGs at their natural size and has no zoom API, so the
 * panel resizes the SVG by rewriting `width`/`height` from its `viewBox`. These
 * cases pin the arithmetic (aspect ratio, the 100% fit ceiling, the 5%–400%
 * clamp) and the two DOM consequences the panel depends on: the element's laid
 * out size — which is what gives the scroll container its extent — equals the
 * scaled natural size, and an anchored wheel zoom scrolls the container so the
 * point under the cursor does not move.
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

beforeEach(() => {
  document.body.replaceChildren();
});

test('fit keeps the aspect ratio and never upscales past 100%', () => {
  const natural = { width: 1000, height: 500 };

  // The height is the binding dimension: 400/1000 = 0.4, 400/500 = 0.8.
  assert.equal(fitZoomScale(natural, { width: 400, height: 400 }), 0.4);
  const fitted = zoomedSvgSize(natural, 0.4);
  assert.deepEqual(fitted, { width: 400, height: 200 });
  assert.equal(fitted.width / fitted.height, natural.width / natural.height, 'the drawing keeps its shape');

  // A diagram smaller than its container is shown at natural size, not blown up.
  assert.equal(fitZoomScale(natural, { width: 2000, height: 2000 }), 1);

  // An unmeasurable container (hidden tab, jsdom) keeps the natural size.
  assert.equal(fitZoomScale(natural, { width: 0, height: 0 }), 1);
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

  const scale = viewport.fit();
  const natural = readSvgNaturalSize(svg);
  assert.ok(natural);
  const fitted = zoomedSvgSize(natural, scale);
  // Fit is min(400/1586, 600/1176, 1) = 0.25220…
  assert.equal(rounded(fitted.width), 400);
  assert.equal(Number(svg.getAttribute('width')), rounded(fitted.width));
  assert.equal(Number(svg.getAttribute('height')), rounded(fitted.height));

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
