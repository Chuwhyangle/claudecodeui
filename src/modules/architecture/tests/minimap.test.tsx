import assert from 'node:assert/strict';

import { act, fireEvent, render, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { beforeEach, test, vi } from 'vitest';

import enCommon from '@/modules/i18n/locales/en/common.json';
import {
  ArchitectureMinimap,
  drawingFitsInViewport,
  MINIMAP_HEIGHT_PX,
  MINIMAP_WIDTH_PX,
  minimapDragToScroll,
  minimapLayout,
  minimapPointToScroll,
  readMinimapBoxes,
  visibleDrawingRect,
  visiblePercent,
  visibleRangeRect,
  type MinimapViewportReading,
} from '@/modules/architecture/ArchitectureMinimap';

/**
 * The architecture canvas minimap.
 *
 * Two kinds of reading live here, and the split is the point:
 *  · the range-box arithmetic is pure, so "where is the visible window inside
 *    the drawing" is pinned without a laid-out browser (jsdom has no layout at
 *    all);
 *  · the component's contract — one geometry read and ONE round of `fillRect`
 *    per drawing, the frame following every pan/zoom without repainting the
 *    nodes, a click centring the view and a drag clamping at the drawing's
 *    edge — is pinned against a recording canvas context.
 */

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['common'],
  defaultNS: 'common',
  resources: { en: { common: enCommon } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_MAP = { width: MINIMAP_WIDTH_PX, height: MINIMAP_HEIGHT_PX };

/** A reading over a 4000×1000 drawing shown at 5% in a 100×20 box. */
const READING: MinimapViewportReading = {
  natural: { width: 4000, height: 1000 },
  scale: 0.05,
  viewport: { width: 100, height: 20 },
  scroll: { left: 0, top: 0 },
};

test('the letterbox preserves the aspect ratio and centres the drawing', () => {
  const layout = minimapLayout({ width: 4000, height: 1000 });
  assert.ok(layout !== null);
  assert.equal(layout.scale, 0.04, '160/4000 is the limiting ratio');
  assert.equal(layout.width, 160);
  assert.equal(layout.height, 40);
  assert.equal(layout.offsetX, 0);
  assert.equal(layout.offsetY, 30, 'the vertical remainder is split evenly');

  // A portrait drawing letterboxes the other way round.
  const portrait = minimapLayout({ width: 1000, height: 4000 });
  assert.ok(portrait !== null);
  assert.equal(portrait.width, 25);
  assert.equal(portrait.height, 100);
  assert.equal(portrait.offsetX, 67.5);
  assert.equal(portrait.offsetY, 0);

  assert.equal(minimapLayout({ width: 0, height: 10 }), null, 'an unmeasurable drawing has no layout');
});

test('the visible range maps through the zoom, the scroll offset and the letterbox', () => {
  // At 5% the drawing is 200×50 CSS px, so a 100×20 window sees half its width.
  const visible = visibleDrawingRect(READING);
  assert.deepEqual(visible, { left: 0, top: 0, width: 2000, height: 400 });

  const scrolled = visibleDrawingRect({ ...READING, scroll: { left: 50, top: 25 } });
  assert.deepEqual(scrolled, { left: 1000, top: 500, width: 2000, height: 400 });

  const range = visibleRangeRect({ ...READING, scroll: { left: 50, top: 25 } }, DEFAULT_MAP);
  assert.ok(range !== null);
  // 1000 user units × 0.04 = 40 map px, plus the 30px letterbox band on top.
  assert.deepEqual(range, { left: 40, top: 50, width: 80, height: 16 });

  // Zoomed to 10% the same window covers a QUARTER of the drawing: the frame
  // shrinks in map pixels even though the drawing is drawn larger on screen.
  const zoomedIn = visibleRangeRect({ ...READING, scale: 0.1 }, DEFAULT_MAP);
  assert.ok(zoomedIn !== null);
  assert.deepEqual(zoomedIn, { left: 0, top: 30, width: 40, height: 8 });

  // Scrolling past the drawing's end is clamped, not extrapolated.
  const overscrolled = visibleDrawingRect({ ...READING, scroll: { left: 4000, top: 4000 } });
  assert.deepEqual(overscrolled, { left: 2000, top: 600, width: 2000, height: 400 });
});

test('a minimap click centres the view on the point under the pointer', () => {
  // (2600, 600) in drawing units lands at map (104, 54) at the 4% letterbox.
  const target = minimapPointToScroll(READING, { x: 104, y: 54 });
  assert.deepEqual(target, { left: 80, top: 20 });

  // A click in the letterbox band clamps onto the drawing's edge.
  assert.deepEqual(minimapPointToScroll(READING, { x: 0, y: 0 }), { left: 0, top: 0 });

  // A click near the end is clamped by the scrollable extent, never past it.
  const far = minimapPointToScroll(READING, { x: 160, y: 100 });
  assert.deepEqual(far, {
    left: READING.natural.width * READING.scale - READING.viewport.width,
    top: READING.natural.height * READING.scale - READING.viewport.height,
  });
});

test('dragging the frame moves the view by the letterbox-scaled delta and clamps at the edge', () => {
  // One map pixel is 0.04 user units; at 5% that is 1.25 screen pixels.
  const moved = minimapDragToScroll(READING, { left: 10, top: 5 }, { x: 8, y: 4 });
  assert.deepEqual(moved, { left: 20, top: 10 });

  // The drawing is 200×50 at this scale in a 100×20 window: the furthest the
  // view may scroll is 100×30. A drag far past it stops there.
  const clamped = minimapDragToScroll(READING, { left: 0, top: 0 }, { x: 1000, y: 1000 });
  assert.deepEqual(clamped, { left: 100, top: 30 });

  // Dragging backwards stops at the origin.
  assert.deepEqual(minimapDragToScroll(READING, { left: 10, top: 5 }, { x: -1000, y: -1000 }), {
    left: 0,
    top: 0,
  });
});

test('a drawing that fits one screen needs no map', () => {
  assert.equal(drawingFitsInViewport({ width: 100, height: 50 }, { width: 160, height: 120 }), true);
  assert.equal(drawingFitsInViewport({ width: 4000, height: 1000 }, { width: 160, height: 120 }), false);
  assert.equal(drawingFitsInViewport({ width: 4000, height: 50 }, { width: 160, height: 120 }), false, 'one axis overflowing is enough');
  assert.equal(drawingFitsInViewport({ width: 0, height: 0 }, { width: 160, height: 120 }), false, 'an unmeasured drawing is not "fitted"');
});

test('the accessible reading states the share of the drawing on screen', () => {
  // 2000×400 of 4000×1000 is a fifth.
  assert.equal(visiblePercent(READING), 20);
  assert.equal(visiblePercent({ ...READING, scale: 0.1 }), 5, 'zooming in shrinks the share on screen');
  // Never reads as "0%" while a sliver is visible.
  const sliver: MinimapViewportReading = { ...READING, scroll: { left: 0, top: 0 }, viewport: { width: 1, height: 1 } };
  assert.equal(visiblePercent(sliver), 1);
});

/** One node box the fixture drawing carries. */
type BoxSpec = {
  x: number;
  y: number;
  width: number;
  height: number;
  id?: string;
  group?: boolean;
  seed?: boolean;
};

/** Build a renderer-shaped SVG: each box is a `<g>` with one absolute `<rect>`. */
function makeDrawing(width: number, height: number, boxes: BoxSpec[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  for (const box of boxes) {
    const node = document.createElementNS(SVG_NS, 'g');
    node.setAttribute('class', box.group ? 'uml-package' : 'uml-node');
    if (box.id !== undefined) node.setAttribute('data-entity-id', box.id);
    if (box.seed === true) node.classList.add('arch-seed');
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(box.x));
    rect.setAttribute('y', String(box.y));
    rect.setAttribute('width', String(box.width));
    rect.setAttribute('height', String(box.height));
    node.append(rect);
    svg.append(node);
  }
  return svg;
}

/** The scroll container, with the content box jsdom cannot compute pinned by hand. */
function makeHost(svg: SVGSVGElement, width: number, height: number): HTMLDivElement {
  const host = document.createElement('div');
  Object.defineProperty(host, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(host, 'clientHeight', { configurable: true, value: height });
  host.append(svg);
  document.body.append(host);
  return host;
}

/** jsdom ships no `PointerEvent`; this stand-in carries the four fields the map reads. */
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}
(window as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent =
  TestPointerEvent as unknown as typeof PointerEvent;

/** The recording 2D context the paint is measured with. */
type CanvasRecorder = {
  fillRect: number;
  strokeRect: number;
  drawImage: number;
  lineWidths: number[];
};

/**
 * Install a counting `getContext('2d')` for every canvas, including the
 * offscreen bitmap. The component treats a `null` context as "this platform
 * cannot draw" (jsdom's real answer), so the mock is what lets a case observe
 * the paint schedule at all.
 */
function recordCanvas(): CanvasRecorder {
  const recorder: CanvasRecorder = { fillRect: 0, strokeRect: 0, drawImage: 0, lineWidths: [] };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function recording(this: HTMLCanvasElement) {
    const context = {
      canvas: this,
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      setTransform: () => {},
      clearRect: () => {},
      fillRect: () => {
        recorder.fillRect += 1;
      },
      drawImage: () => {
        recorder.drawImage += 1;
      },
      strokeRect: () => {
        recorder.strokeRect += 1;
        recorder.lineWidths.push(context.lineWidth);
      },
    };
    return context as unknown as CanvasRenderingContext2D;
  });
  return recorder;
}

/** Count the geometry reads the box reader performs (four attributes per rect). */
function countRectReads(): { reads: number } {
  const original = Element.prototype.getAttribute;
  const counter = { reads: 0 };
  vi.spyOn(Element.prototype, 'getAttribute').mockImplementation(function counting(this: Element, name: string) {
    if (
      this.tagName.toLowerCase() === 'rect'
      && (name === 'x' || name === 'y' || name === 'width' || name === 'height')
    ) {
      counter.reads += 1;
    }
    return original.call(this, name);
  });
  return counter;
}

/** The canvas, once the measurement effect has made it visible. */
function minimapCanvas(): HTMLCanvasElement {
  const canvas = document.querySelector('[data-architecture-minimap-canvas]');
  assert.ok(canvas instanceof HTMLCanvasElement, 'the minimap canvas must be rendered');
  return canvas;
}

/** Pin the canvas's client box so a pointer position maps onto the map. */
function pinCanvasBox(canvas: HTMLCanvasElement): void {
  canvas.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: MINIMAP_WIDTH_PX,
    height: MINIMAP_HEIGHT_PX,
    x: 0,
    y: 0,
    right: MINIMAP_WIDTH_PX,
    bottom: MINIMAP_HEIGHT_PX,
    toJSON: () => ({}),
  }) as DOMRect;
}

beforeEach(() => {
  window.localStorage.clear();
  document.body.replaceChildren();
});

test('the box reader marks package frames, grp:: groups and seeds', () => {
  const svg = makeDrawing(400, 200, [
    { x: 0, y: 0, width: 400, height: 200, group: true },
    { x: 20, y: 20, width: 60, height: 40, id: 'src/a.ts', seed: true },
    { x: 100, y: 20, width: 60, height: 40, id: 'grp::src/b' },
    { x: 0, y: 0, width: 0, height: 0, id: 'degenerate' },
  ]);

  const boxes = readMinimapBoxes(svg);
  assert.equal(boxes.length, 3, 'a zero-sized box is not a box');
  assert.deepEqual(
    boxes.map((box) => `${box.kind}:${String(box.seed)}`),
    ['group:false', 'group:false', 'entity:true'],
    'group boxes come first, then entities; the seed is marked',
  );
});

test('1000 node boxes are read once and filled in one round; a pan or zoom never redraws them', async () => {
  const boxes = Array.from({ length: 1000 }, (_unused, index) => ({
    x: (index % 40) * 100,
    y: Math.floor(index / 40) * 100,
    width: 60,
    height: 40,
    id: `src/n${String(index)}.ts`,
  }));
  const host = makeHost(makeDrawing(4000, 2500, boxes), 200, 100);
  const hostRef = { current: host };
  const recorder = recordCanvas();
  const reads = countRectReads();

  const { rerender } = render(
    <ArchitectureMinimap hostRef={hostRef} revision={1} scale={0.1} />,
  );
  const canvas = minimapCanvas();
  pinCanvasBox(canvas);

  // One background fill plus one rectangle per node — and 4 attribute reads each.
  await waitFor(() => assert.equal(recorder.fillRect, 1001, 'the nodes are painted in a single round'));
  assert.equal(reads.reads, 4000, 'the drawing geometry is read once');
  assert.equal(canvas.getAttribute('data-architecture-minimap-range'), '0,0,80,40');

  // A pan changes only the frame: the bitmap is blitted, never re-filled.
  host.scrollLeft = 120;
  host.scrollTop = 40;
  act(() => {
    host.dispatchEvent(new Event('scroll'));
  });
  await waitFor(() => assert.equal(canvas.getAttribute('data-architecture-minimap-range'), '48,16,80,40'));
  assert.equal(recorder.fillRect, 1001, 'panning does not repaint the node rectangles');
  assert.equal(reads.reads, 4000, 'panning does not re-read the geometry');
  assert.ok(recorder.drawImage >= 1, 'the cached bitmap is blitted');
  assert.ok(recorder.strokeRect >= 1, 'the frame is stroked on every paint');

  // A zoom is the same story: the drawing identity did not change.
  rerender(<ArchitectureMinimap hostRef={hostRef} revision={1} scale={0.2} />);
  await waitFor(() => assert.equal(canvas.getAttribute('data-architecture-minimap-range'), '24,8,40,20'));
  assert.equal(recorder.fillRect, 1001, 'zooming does not repaint the node rectangles');
  assert.equal(reads.reads, 4000, 'zooming does not re-read the geometry');

  // The frame is marked by WIDTH: every stroke is the documented 2px.
  assert.ok(recorder.lineWidths.length > 0);
  assert.deepEqual([...new Set(recorder.lineWidths)], [2], 'the range box is set apart by line width, not colour alone');
});

test('clicking the map centres the main viewport on that point', () => {
  const host = makeHost(
    makeDrawing(4000, 1000, [{ x: 0, y: 0, width: 100, height: 50, id: 'src/a.ts' }]),
    100,
    20,
  );
  render(<ArchitectureMinimap hostRef={{ current: host }} revision="click" scale={0.05} />);
  const canvas = minimapCanvas();
  pinCanvasBox(canvas);

  // Map (104, 54) is drawing (2600, 600); centring it in a 100×20 window is scroll (80, 20).
  fireEvent.pointerDown(canvas, { pointerId: 7, clientX: 104, clientY: 54, button: 0 });
  fireEvent.pointerUp(canvas, { pointerId: 7, clientX: 104, clientY: 54, button: 0 });

  assert.equal(host.scrollLeft, 80);
  assert.equal(host.scrollTop, 20);
});

test('dragging the frame pans the view and stops at the drawing’s edge', () => {
  const host = makeHost(
    makeDrawing(4000, 1000, [{ x: 0, y: 0, width: 100, height: 50, id: 'src/a.ts' }]),
    100,
    20,
  );
  render(<ArchitectureMinimap hostRef={{ current: host }} revision="drag" scale={0.05} />);
  const canvas = minimapCanvas();
  pinCanvasBox(canvas);

  // The frame starts at map x 0…80, y 30…46; (40, 38) is inside it.
  fireEvent.pointerDown(canvas, { pointerId: 11, clientX: 40, clientY: 38, button: 0 });
  assert.equal(host.scrollLeft, 0, 'grabbing the frame does not jump the view');
  fireEvent.pointerMove(canvas, { pointerId: 11, clientX: 60, clientY: 40, button: 0 });
  assert.equal(host.scrollLeft, 25, '20 map px is 20 user units, i.e. 25 screen px at 5%');
  assert.equal(host.scrollTop, 2.5);

  // The frame followed the scroll; grab it again and drag far past the end.
  fireEvent.pointerUp(canvas, { pointerId: 11, clientX: 60, clientY: 40, button: 0 });
  fireEvent.pointerDown(canvas, { pointerId: 12, clientX: 40, clientY: 38, button: 0 });
  fireEvent.pointerMove(canvas, { pointerId: 12, clientX: 600, clientY: 38, button: 0 });
  assert.equal(host.scrollLeft, 100, 'the drag is clamped to the drawing, not past it');
  assert.equal(host.scrollTop, 2.5, 'an untouched axis does not move');
  fireEvent.pointerUp(canvas, { pointerId: 12, clientX: 600, clientY: 38, button: 0 });
});

test('a focused map moves the view with the arrow keys and exposes its reading', async () => {
  const host = makeHost(
    makeDrawing(4000, 1000, [{ x: 0, y: 0, width: 100, height: 50, id: 'src/a.ts' }]),
    100,
    20,
  );
  render(<ArchitectureMinimap hostRef={{ current: host }} revision="keys" scale={0.05} />);
  const canvas = minimapCanvas();

  assert.equal(canvas.getAttribute('role'), 'img');
  await waitFor(() =>
    assert.match(canvas.getAttribute('aria-label') ?? '', /Graph overview, showing 20% of the drawing/),
  );
  canvas.focus();
  assert.equal(document.activeElement, canvas, 'the map is a keyboard focus target');

  assert.equal(fireEvent.keyDown(canvas, { key: 'ArrowRight' }), false, 'the map consumes its pan keys');
  assert.equal(host.scrollLeft, 40);
  fireEvent.keyDown(canvas, { key: 'ArrowDown' });
  assert.equal(host.scrollTop, 30, 'the vertical scroll clamps at the drawing edge (30 max)');
  fireEvent.keyDown(canvas, { key: 'ArrowLeft' });
  assert.equal(host.scrollLeft, 0);
  assert.equal(fireEvent.keyDown(canvas, { key: 'Escape' }), true, 'Escape stays available to the page');
});

test('a drawing that already fits one screen renders no minimap', () => {
  const fitted = makeHost(
    makeDrawing(100, 50, [{ x: 0, y: 0, width: 100, height: 50, id: 'src/a.ts' }]),
    160,
    120,
  );
  render(<ArchitectureMinimap hostRef={{ current: fitted }} revision="fitted" scale={1} />);
  assert.equal(
    document.querySelector('[data-architecture-minimap]'),
    null,
    'a map of a fully visible drawing says nothing',
  );

  const overflowing = makeHost(
    makeDrawing(4000, 1000, [{ x: 0, y: 0, width: 100, height: 50, id: 'src/a.ts' }]),
    160,
    120,
  );
  render(<ArchitectureMinimap hostRef={{ current: overflowing }} revision="overflowing" scale={0.05} />);
  assert.ok(
    document.querySelector('[data-architecture-minimap]'),
    'the same component overflows and therefore draws the map',
  );
});

test('collapsing and expanding is remembered across mounts', () => {
  const view = (host: HTMLElement) => (
    <ArchitectureMinimap hostRef={{ current: host }} revision="memory" scale={0.05} />
  );
  const first = makeHost(
    makeDrawing(4000, 1000, [{ x: 0, y: 0, width: 100, height: 50, id: 'src/a.ts' }]),
    100,
    20,
  );
  const { unmount } = render(view(first));
  minimapCanvas();

  fireEvent.click(document.querySelector('[data-architecture-minimap-collapse]') as Element);
  assert.equal(document.querySelector('[data-architecture-minimap-canvas]'), null, 'the map collapses to a button');
  const expand = document.querySelector('[data-architecture-minimap-expand]');
  assert.ok(expand instanceof HTMLElement);
  assert.equal(
    getComputedStyle(expand).minHeight,
    '44px',
    'the collapsed form keeps a 44px target',
  );
  unmount();

  // A fresh mount on a fresh drawing still remembers the choice.
  const second = makeHost(
    makeDrawing(4000, 1000, [{ x: 0, y: 0, width: 100, height: 50, id: 'src/a.ts' }]),
    100,
    20,
  );
  render(view(second));
  assert.equal(document.querySelector('[data-architecture-minimap-canvas]'), null, 'the collapsed state survives a mount');
  const reopen = document.querySelector('[data-architecture-minimap-expand]') as Element;
  fireEvent.click(reopen);
  assert.ok(
    document.querySelector('[data-architecture-minimap-canvas]'),
    'expanding restores the map',
  );
});
