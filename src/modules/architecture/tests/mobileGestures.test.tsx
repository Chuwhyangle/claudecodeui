import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, test, vi } from 'vitest';

import type * as SharedApiModule from '@/shared/api';
import enCommon from '@/modules/i18n/locales/en/common.json';
import { ArchitecturePanel } from '@/modules/architecture';
import type { ArchitectureGraphResult } from '@/modules/architecture';
import { addNodeHitTargets, nearestNodeHitId } from '@/modules/architecture/graphDom';

/**
 * The architecture tab's mobile input contract:
 *  · the SVG host declares `touch-action: none`, so the browser never treats a
 *    pan/pinch on the drawing as a page gesture;
 *  · two fingers pinch-zoom around their midpoint through the SAME viewport
 *    controller the toolbar and Ctrl+wheel use, and one finger pans the
 *    scroll container;
 *  · a touch tap only selects (the drawing must not re-lay out under the
 *    finger); drilling needs an explicit gesture — double-tap or "Drill in";
 *  · a coarse pointer gets 44×44 hit areas and a narrow screen keeps one header
 *    row, moving the other entries into the bottom sheet;
 *  · on a coarse pointer the drawn NODES get the same 44px hit area, resolved
 *    to the nearest centre when dense boxes overlap;
 *  · the canvas owns the wheel (a plain wheel zooms around the cursor), and the
 *    zoom cluster floats on the drawing rather than in the toolbar.
 */

// The network hop is stubbed; the hook, the panel, the bridge and the real
// PlantUML/ELK renderer stay real, the same seam `architectureTab.test.tsx` uses.
const apiMock = vi.hoisted(() => ({ architectureGraph: vi.fn() }));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApiModule>();
  return {
    ...actual,
    api: { ...actual.api, architectureGraph: apiMock.architectureGraph },
  };
});

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['common'],
  defaultNS: 'common',
  resources: { en: { common: enCommon } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

// jsdom ships no ResizeObserver; the diagram observes its scroll container to
// re-fit. Recording the callbacks keeps the component's effect from throwing.
const resizeCallbacks = new Set<ResizeObserverCallback>();
class RecordingResizeObserver {
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(): void {
    resizeCallbacks.add(this.callback);
  }

  unobserve(): void {
    resizeCallbacks.delete(this.callback);
  }

  disconnect(): void {
    resizeCallbacks.delete(this.callback);
  }
}
globalThis.ResizeObserver = RecordingResizeObserver as unknown as typeof ResizeObserver;

/**
 * jsdom implements neither `PointerEvent` nor media queries. This minimal
 * PointerEvent extends MouseEvent (so `clientX`/`clientY` are real) and adds
 * the two fields the gesture layer reads; without it @testing-library falls
 * back to a plain Event and the coordinates are silently dropped.
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
(window as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent =
  TestPointerEvent as unknown as typeof PointerEvent;

const TOUCH_ONLY_QUERY = '(pointer: coarse) and (hover: none)';

const originalMatchMedia = window.matchMedia;
const originalInnerWidth = window.innerWidth;
const originalInnerHeight = window.innerHeight;

/** Report a fixed answer for every media query (the default is "desktop, no touch"). */
function stubMatchMedia(matches: (query: string) => boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: matches(query),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height });
}

/** A phone: coarse pointer, tall enough to miss the short-viewport tier. */
function usePhone(): void {
  setViewport(375, 812);
  stubMatchMedia((query) => query === '(pointer: coarse)' || query === TOUCH_ONLY_QUERY);
}

// Pay the one-off renderer compile in the hook budget, not the first case's 5s.
beforeAll(async () => {
  await import('@yalehwang/plantuml-js/elk');
});

const ENTITY_MMD = '@startuml\nX --> Y\n@enduml';
const FILE_MMD = '@startuml\nA --> B\n@enduml';

/**
 * Three files across two directories: the overview folds them into the
 * `src/modules/alpha` group (two files) and draws `src/modules/beta/b.ts` as
 * itself (a one-file directory is not a group), which is enough to exercise
 * selecting a group, drilling into it, and then drilling into an entity inside
 * it.
 */
const RESULT: ArchitectureGraphResult = {
  mmd: { file: FILE_MMD, entity: ENTITY_MMD },
  graph: {
    file: {
      nodes: [
        { id: 'src/modules/alpha/a.ts', label: 'src/modules/alpha/a.ts', distance: 0 },
        { id: 'src/modules/alpha/a2.ts', label: 'src/modules/alpha/a2.ts', distance: 1 },
        { id: 'src/modules/beta/b.ts', label: 'src/modules/beta/b.ts', distance: 2 },
      ],
      edges: [
        { from: 'src/modules/alpha/a2.ts', to: 'src/modules/alpha/a.ts', relationType: 'dependency' },
        { from: 'src/modules/beta/b.ts', to: 'src/modules/alpha/a2.ts', relationType: 'call' },
      ],
    },
    entity: {
      nodes: [
        { id: 'src/modules/alpha/A.ts.Alpha', label: 'Alpha', distance: 0 },
        { id: 'src/modules/alpha/A2.ts.Alpha2', label: 'Alpha2', distance: 1 },
        { id: 'src/modules/beta/B.ts.Beta', label: 'Beta', distance: 2 },
      ],
      edges: [
        { from: 'src/modules/alpha/A2.ts.Alpha2', to: 'src/modules/alpha/A.ts.Alpha', relationType: 'dependency' },
        { from: 'src/modules/beta/B.ts.Beta', to: 'src/modules/alpha/A2.ts.Alpha2', relationType: 'call' },
      ],
    },
  },
  stats: {
    entityNodes: 3,
    fileNodes: 3,
    entityEdges: 2,
    fileEdges: 2,
    truncated: false,
    entityTotal: 3,
    fileTotal: 3,
    seedFiles: 1,
    seedIdentifiers: 1,
    nodeCount: 6,
    edgeCount: 4,
    unresolved: { files: [], identifiers: [] },
  },
  provenance: {
    generatedAt: '2026-10-22T00:00:00.000Z',
    fingerprints: [],
    cacheHit: false,
  },
};

function jsonResponse(result: ArchitectureGraphResult): Response {
  return {
    ok: true,
    status: 200,
    json: async () => result,
  } as unknown as Response;
}

async function waitForDiagram(): Promise<HTMLElement> {
  const host = await screen.findByTestId('plantuml-host');
  await waitFor(() => assert.ok(host.querySelector('svg'), 'the renderer must draw an SVG'));
  return host;
}

function graphRoot(): HTMLElement {
  const root = document.querySelector('[data-architecture-plantuml-graph]');
  assert.ok(root instanceof HTMLElement);
  return root;
}

/**
 * The compact tier has ONE header row on the panel; the graph's own controls
 * (drill, back, readable mode) are portaled into the bottom sheet that the
 * `Adjust` button opens. Open it only when it is shut, so a sequence that
 * leaves it open does not close it.
 */
function openCompactMenu(): void {
  if (document.querySelector('[data-architecture-sheet]') === null) {
    fireEvent.click(screen.getByRole('button', { name: 'Adjust' }));
  }
  assert.ok(document.querySelector('[data-architecture-sheet]'), 'the bottom sheet must be open');
}

function drawnNodeIds(host: HTMLElement): string[] {
  return [...host.querySelectorAll('[data-entity-id]')]
    .map((node) => node.getAttribute('data-entity-id') ?? '')
    .sort();
}

/** One finger press, lifted and finished with the click a browser would send. */
function tap(target: Element): void {
  fireEvent.pointerDown(target, { pointerId: 1, pointerType: 'touch', clientX: 40, clientY: 40 });
  fireEvent.pointerUp(target, { pointerId: 1, pointerType: 'touch', clientX: 40, clientY: 40 });
  fireEvent.click(target);
}

/**
 * State the "show everything" filter explicitly.
 *
 * The panel's shipped default hides `call` edges and the nodes they leave
 * isolated; the fixture below is the UNFILTERED three-file chain (its comment
 * names `src/modules/beta/b.ts` as drawn), so the cases that read the drawn
 * node set opt out of the default instead of being narrowed by it.
 */
function rememberShowAllFilter(projectId = 'project-1'): void {
  window.localStorage.setItem(
    `architecture.filter.${projectId}`,
    JSON.stringify({
      kinds: ['class', 'interface', 'enum', 'abstract', 'function', 'other'],
      relations: 'call',
      hideIsolated: false,
    }),
  );
}

beforeEach(() => {
  apiMock.architectureGraph.mockReset();
  apiMock.architectureGraph.mockResolvedValue(jsonResponse(RESULT));
  window.localStorage.removeItem('architecture.filter.project-1');
  setViewport(1024, 768);
  stubMatchMedia(() => false);
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  setViewport(originalInnerWidth, originalInnerHeight);
});

test('the SVG host owns touch input and a pinch zooms around the two-finger midpoint', async () => {
  usePhone();
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await waitForDiagram();

  // touch-action: none is the declaration that stops the browser from turning
  // a pinch on the drawing into a page zoom. Read the declaration itself:
  // jsdom's computed style drops properties its cssstyle table does not know,
  // while the style React set on the element is exactly what a browser honours.
  assert.equal(
    host.style.touchAction,
    'none',
    'the drawing host must opt out of browser touch gestures',
  );

  const svg = host.querySelector('svg');
  assert.ok(svg !== null);
  // jsdom reports a zero rect; pin the drawn SVG's origin so the anchor math
  // has a real coordinate space (the same technique svgViewport.test uses).
  svg.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600,
    toJSON: () => ({}),
  }) as DOMRect;
  assert.equal(Number(graphRoot().getAttribute('data-architecture-zoom-scale')), 1, 'a fresh diagram is at 100%');

  // Fingers at 100/300 (span 200, midpoint 200), then spread symmetrically to
  // 50/350 (span 300, midpoint 200): the scale must follow the span ratio
  // (1.25 then 1.2 → 1.5 overall) and the midpoint must be the anchor the zoom
  // keeps fixed. Because the two finger moves are two frames, the container's
  // scroll is the sum of the per-frame anchoring:
  //   frame 1: 175·1.25 − 175 = 43.75, then the midpoint shifted left by 25 ⇒ 68.75
  //   frame 2: (200/1.25)·1.5 − 200 = 40, then the midpoint shifted right by 25 ⇒ 83.75
  fireEvent.pointerDown(host, { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 100 });
  fireEvent.pointerDown(host, { pointerId: 2, pointerType: 'touch', clientX: 300, clientY: 100 });

  const notCancelled = fireEvent.pointerMove(host, {
    pointerId: 1, pointerType: 'touch', clientX: 50, clientY: 100,
  });
  fireEvent.pointerMove(host, { pointerId: 2, pointerType: 'touch', clientX: 350, clientY: 100 });
  assert.equal(notCancelled, false, 'a pinch move must be cancelled so the page never zooms');

  await waitFor(() => {
    assert.ok(
      Math.abs(Number(graphRoot().getAttribute('data-architecture-zoom-scale')) - 1.5) < 1e-6,
      `the pinch must apply the span ratio; got ${graphRoot().getAttribute('data-architecture-zoom-scale')}`,
    );
  });
  assert.equal(graphRoot().getAttribute('data-architecture-zoom-mode'), 'custom');
  assert.ok(Math.abs(host.scrollLeft - 83.75) < 1e-6, `anchored zoom scroll; got ${host.scrollLeft}`);

  fireEvent.pointerUp(host, { pointerId: 1, pointerType: 'touch', clientX: 50, clientY: 100 });
  fireEvent.pointerUp(host, { pointerId: 2, pointerType: 'touch', clientX: 350, clientY: 100 });
});

test('one finger drags the drawing by panning the scroll container', async () => {
  usePhone();
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await waitForDiagram();

  fireEvent.pointerDown(host, { pointerId: 7, pointerType: 'touch', clientX: 300, clientY: 300 });
  fireEvent.pointerMove(host, { pointerId: 7, pointerType: 'touch', clientX: 250, clientY: 280 });

  assert.equal(host.scrollLeft, 50, 'the drawing follows the finger horizontally');
  assert.equal(host.scrollTop, 20, 'the drawing follows the finger vertically');

  // The browser emits a click after a drag too; panning must not select.
  fireEvent.click(host.querySelector('[data-entity-id="grp::src/modules/alpha"]') as Element);
  assert.equal(
    graphRoot().getAttribute('data-architecture-view'),
    'overview',
    'a pan must not drill or expand anything',
  );
  assert.equal(
    document.querySelector('[data-architecture-drill-in]'),
    null,
    'a pan must not leave a selection behind either',
  );

  fireEvent.pointerUp(host, { pointerId: 7, pointerType: 'touch', clientX: 250, clientY: 280 });
});

test('the canvas owns the wheel — a plain wheel zooms too — and Ctrl+wheel keeps working', async () => {
  // Deliberately the desktop setup from beforeEach (fine pointer, 1024px).
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await waitForDiagram();
  const before = Number(graphRoot().getAttribute('data-architecture-zoom-scale'));

  // The drawing is the wheel's only consumer now: a plain wheel zooms around
  // the cursor and is cancelled, so it never scrolls the page or the diagram.
  assert.equal(fireEvent.wheel(host, { deltaY: -120 }), false, 'the canvas must cancel its wheel');
  assert.ok(
    Number(graphRoot().getAttribute('data-architecture-zoom-scale')) > before,
    'a plain wheel must zoom in',
  );
  assert.equal(graphRoot().getAttribute('data-architecture-zoom-mode'), 'custom');

  // Ctrl+wheel — what a trackpad pinch produces — is the same gesture.
  const zoomedIn = Number(graphRoot().getAttribute('data-architecture-zoom-scale'));
  assert.equal(fireEvent.wheel(host, { deltaY: -120, ctrlKey: true }), false);
  assert.ok(
    Number(graphRoot().getAttribute('data-architecture-zoom-scale')) > zoomedIn,
    'Ctrl+wheel must keep zooming',
  );
});

test('the phone canvas refuses selection and the long-press callout', async () => {
  usePhone();
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await waitForDiagram();

  // A finger that lands on the drawing pans/zooms/drills; it must never start
  // a text selection, and a long press must not open the platform's select or
  // share bubble over the drawing. jsdom drops the vendor properties from
  // inline styles, so the rule the browser actually applies is read from the
  // injected stylesheet: it names the drawing host and declares the callout
  // suppression the touch tier needs.
  assert.equal(host.style.userSelect, 'none', 'the phone drawing host must refuse a selection');
  const policy = document.querySelector('[data-architecture-canvas-selection-style]');
  assert.ok(policy !== null, 'the canvas must inject its selection policy');
  const css = policy.textContent ?? '';
  assert.match(
    css,
    /\[data-architecture-plantuml\][^{]*\{[^}]*-webkit-touch-callout:\s*none/,
    'the drawing host must suppress the long-press callout on the touch tier',
  );
  assert.match(
    css,
    /\[data-architecture-plantuml\][^{]*\{[^}]*-webkit-user-select:\s*none/,
    'the drawing host must refuse a touch selection',
  );
});

test('a touch tap selects without re-laying out; drilling needs Drill in or a double-tap', async () => {
  usePhone();
  rememberShowAllFilter();
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await waitForDiagram();
  const drawing = host.querySelector('svg');
  assert.ok(drawing !== null);

  // First tap on the group node: selection only. The drawing must be the very
  // same SVG element — no re-layout, no new view.
  tap(host.querySelector('[data-entity-id="grp::src/modules/alpha"]') as Element);
  assert.equal(graphRoot().getAttribute('data-architecture-view'), 'overview', 'a tap must not navigate');
  assert.equal(host.querySelector('svg'), drawing, 'selecting must not replace the drawing');
  // The explicit drill action lives in the single compact toolbar's "…" menu
  // (there is no second graph toolbar row to hold it).
  openCompactMenu();
  const drillIn = document.querySelector('[data-architecture-drill-in]');
  assert.ok(drillIn instanceof HTMLButtonElement, 'a touch selection must offer the explicit drill action');

  // The explicit action is what expands the group.
  fireEvent.click(drillIn);
  await waitFor(() => {
    assert.equal(graphRoot().getAttribute('data-architecture-view'), 'group');
    assert.deepEqual(drawnNodeIds(host), ['src/modules/alpha/a.ts', 'src/modules/alpha/a2.ts']);
  });

  // Tapping an entity inside the group still only selects; the view stays put.
  const entity = await waitFor(() => {
    const node = host.querySelector('[data-entity-id="src/modules/alpha/a2.ts"]');
    assert.ok(node !== null);
    return node;
  });
  tap(entity);
  assert.equal(graphRoot().getAttribute('data-architecture-view'), 'group', 'tapping an entity must not drill');

  openCompactMenu();
  const drillEntity = document.querySelector('[data-architecture-drill-in]');
  assert.ok(drillEntity instanceof HTMLButtonElement);
  fireEvent.click(drillEntity);
  await waitFor(() => {
    assert.equal(graphRoot().getAttribute('data-architecture-view'), 'neighborhood');
    assert.equal(
      document.querySelector('[data-architecture-hops]')?.getAttribute('data-architecture-hops'),
      '1',
    );
    assert.deepEqual(drawnNodeIds(host), [
      'src/modules/alpha/a.ts',
      'src/modules/alpha/a2.ts',
      'src/modules/beta/b.ts',
    ]);
  });

  // A double-tap is the other explicit gesture: select, then tap the same node
  // again within the double-tap window. (On a phone the breadcrumb lives in
  // the overflow menu, together with the other toolbar actions; it names the
  // view it returns to, so the file graph reads "Back to Overview".)
  openCompactMenu();
  fireEvent.click(screen.getByRole('button', { name: 'Back to Overview' }));
  await waitFor(() => assert.equal(graphRoot().getAttribute('data-architecture-view'), 'overview'));
  const groupNode = await waitFor(() => {
    const node = host.querySelector('[data-entity-id="grp::src/modules/alpha"]');
    assert.ok(node !== null);
    return node;
  });
  tap(groupNode);
  tap(groupNode);
  await waitFor(() => assert.equal(graphRoot().getAttribute('data-architecture-view'), 'group'));
});

test('a coarse pointer gives every toolbar button a 44×44 hit area', async () => {
  usePhone();
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  await waitForDiagram();

  const toggle = screen.getByRole('button', { name: 'Adjust' });
  fireEvent.click(toggle);
  assert.ok(document.querySelector('[data-architecture-sheet]'), 'the bottom sheet must open');

  // Every control the compact tier can reach, INCLUDING the ones the renderer
  // portals into the sheet — the panel is where the whole chrome lives now.
  const panel = document.querySelector('[data-architecture-panel]');
  assert.ok(panel instanceof HTMLElement);
  const buttons = [...panel.querySelectorAll('button')];
  assert.ok(buttons.length >= 5, `the toolbar must expose its actions; got ${buttons.length}`);
  for (const button of buttons) {
    const style = getComputedStyle(button);
    assert.equal(style.minHeight, '44px', `a coarse-pointer target must be 44px tall: ${button.textContent ?? ''}`);
    assert.equal(style.minWidth, '44px', `a coarse-pointer target must be 44px wide: ${button.textContent ?? ''}`);
  }
});

test('a narrow screen keeps one header row and moves the other entries into the sheet', async () => {
  // Narrow but FINE pointer: this is a small desktop window, not a touch device.
  setViewport(375, 812);
  stubMatchMedia(() => false);
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  await waitForDiagram();

  // The zoom cluster is chrome of the DRAWING, not a toolbar entry: it stays on
  // the canvas at the bottom right, so it is not part of the single row.
  const cluster = document.querySelector('[data-architecture-zoom-cluster]');
  assert.ok(cluster instanceof HTMLElement, 'the zoom controls live on the canvas');
  assert.equal(cluster.closest('[data-architecture-toolbar]'), null, 'the zoom cluster is not a toolbar entry');
  assert.equal(
    document.querySelector('[data-architecture-toolbar] [data-architecture-zoom-in]'),
    null,
    'the toolbar must not spend its one row on zoom',
  );
  assert.equal(
    document.querySelector('[data-architecture-export]'),
    null,
    'the header export button moves into the sheet',
  );

  const toggle = screen.getByRole('button', { name: 'Adjust' });
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  fireEvent.click(toggle);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.ok(document.querySelector('[data-architecture-sheet]'), 'the sheet must open');
  assert.ok(document.querySelector('[data-architecture-export]'), 'export must be reachable from the sheet');

  const zoomIn = screen.getByRole('button', { name: 'Zoom in' });
  assert.ok(cluster.contains(zoomIn), 'the zoom control read by name is the cluster one');
  fireEvent.click(zoomIn);
  assert.equal(graphRoot().getAttribute('data-architecture-zoom-mode'), 'custom');
  assert.ok(Number(graphRoot().getAttribute('data-architecture-zoom-scale')) > 1);
});

test('the sheet closes and the legacy Mermaid item still writes the .mmd document', async () => {
  setViewport(375, 812);
  stubMatchMedia(() => false);
  const downloads: string[] = [];
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:architecture') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function capture(this: HTMLAnchorElement) {
    downloads.push(this.download);
  });

  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  await waitForDiagram();

  fireEvent.click(screen.getByRole('button', { name: 'Adjust' }));
  act(() => {
    fireEvent.click(document.querySelector('[data-architecture-export]') as Element);
  });
  act(() => {
    fireEvent.click(document.querySelector('[data-architecture-export-item="mmd"]') as Element);
  });

  assert.deepEqual(downloads, ['architecture-file.mmd'], 'the legacy item must write the same document the header used to');
  assert.equal(document.querySelector('[data-architecture-sheet]'), null, 'the sheet closes after exporting');
});

/** A DOMRect-shaped box for stubbing the layout jsdom never performs. */
function boxRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

/**
 * Give the root SVG an on-screen box before the diagram loads. Every OTHER SVG
 * element keeps jsdom's zero rect: the node hit targets only need the root's
 * box and the viewBox to derive the user-unit → CSS-pixel scale.
 */
function stubRootSvgBox(width: number, height: number): () => void {
  const original = SVGElement.prototype.getBoundingClientRect;
  SVGElement.prototype.getBoundingClientRect = function stub(this: SVGElement): DOMRect {
    if (this.tagName.toLowerCase() === 'svg') return boxRect(0, 0, width, height);
    return original.call(this);
  };
  return () => {
    SVGElement.prototype.getBoundingClientRect = original;
  };
}

/** The user-unit → client-pixel mapping `svgViewport` applies by rewriting width/height. */
function svgScreenScale(
  svg: SVGSVGElement,
): { left: number; top: number; scaleX: number; scaleY: number } | null {
  const rect = svg.getBoundingClientRect();
  const viewBox = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  if (viewBox.length !== 4 || !(viewBox[2] > 0) || !(viewBox[3] > 0)) return null;
  return {
    left: rect.left,
    top: rect.top,
    scaleX: rect.width / viewBox[2],
    scaleY: rect.height / viewBox[3],
  };
}

/** A drawn node's own rect, in the SVG's user units. */
function drawnNodeBox(host: HTMLElement, id: string): { x: number; y: number; width: number; height: number } | null {
  const node = host.querySelector(`.uml-node[data-entity-id="${id}"]`);
  const rect = node?.querySelector('rect');
  if (rect === null || rect === undefined) return null;
  const read = (name: string): number => Number(rect.getAttribute(name) ?? '0');
  return { x: read('x'), y: read('y'), width: read('width'), height: read('height') };
}

test('touch hit area: a coarse tap within 20px of a node centre selects the nearest node', async () => {
  usePhone();
  rememberShowAllFilter();
  // The entity graph draws all three fixture entities; the file overview folds
  // two of them into a group, and a group tap only pins the renderer's own
  // highlight (the panel paints no selected entity for it). The hit-area
  // geometry is graph-agnostic, so the entity reading is the honest fixture.
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="entity" />);
  const host = await waitForDiagram();
  const svg = host.querySelector('svg');
  assert.ok(svg instanceof SVGSVGElement, 'the renderer must draw an SVG');

  // The phone reads a FITTED drawing: the same SVG shown at a fraction of its
  // natural size. jsdom performs no layout, so the on-screen box is stubbed
  // from the viewBox — at 0.1× the visible node box is a few pixels tall.
  const viewBox = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  assert.equal(viewBox.length, 4);
  svg.getBoundingClientRect = () => boxRect(0, 0, viewBox[2] * 0.1, viewBox[3] * 0.1);
  const scale = svgScreenScale(svg);
  assert.ok(scale !== null);

  const drawn = [...host.querySelectorAll('.uml-node[data-entity-id]')]
    .map((node) => node.getAttribute('data-entity-id') ?? '')
    // Groups are scaffolding the panel does not paint as a selected entity (a
    // group tap only pins the renderer's own highlight), and stubs are not
    // entities at all: the assertion below needs a node the panel selects.
    .filter((id) => id !== '' && !id.startsWith('grp::') && !id.startsWith('stub::'));
  assert.ok(drawn.length >= 2, `the fixture must draw neighbours; got ${drawn.length}`);

  const centres = drawn.map((id) => {
    const box = drawnNodeBox(host, id);
    assert.ok(box !== null, `the drawn node ${id} must carry its own rect`);
    return {
      id,
      x: scale.left + (box.x + box.width / 2) * scale.scaleX,
      y: scale.top + (box.y + box.height / 2) * scale.scaleY,
      screenHeight: box.height * scale.scaleY,
    };
  });
  // The most isolated node: the tap point below must be nearer to it than to
  // any overlapping neighbour for the assertion to mean "nearest centre".
  let chosen = centres[0];
  let nearestOtherDistance = Number.POSITIVE_INFINITY;
  for (const candidate of centres) {
    const nearest = centres
      .filter((entry) => entry.id !== candidate.id)
      .reduce((distance, entry) => Math.min(
        distance,
        Math.hypot(entry.x - candidate.x, entry.y - candidate.y),
      ), Number.POSITIVE_INFINITY);
    if (!(nearest < nearestOtherDistance)) continue;
    chosen = candidate;
    nearestOtherDistance = nearest;
  }
  assert.ok(
    chosen.screenHeight < 20,
    `the visible box must be smaller than a finger; got ${chosen.screenHeight}px`,
  );

  // Aim just outside the visible shape but well inside the 44px target, in
  // the direction away from the closest other node, so the intended node is
  // unambiguously the nearest centre (10px ≤ 20px, and < d/3).
  const away = centres
    .filter((entry) => entry.id !== chosen.id)
    .reduce((best, entry) => {
      const distance = Math.hypot(entry.x - chosen.x, entry.y - chosen.y);
      return distance < best.distance ? { entry, distance } : best;
    }, { entry: centres[0], distance: Number.POSITIVE_INFINITY });
  const awayX = chosen.x - away.entry.x;
  const awayY = chosen.y - away.entry.y;
  const length = Math.hypot(awayX, awayY) || 1;
  const offset = Math.min(10, Math.max(1, away.distance / 3));
  const target = {
    x: chosen.x + (awayX / length) * offset,
    y: chosen.y + (awayY / length) * offset,
  };
  assert.ok(Math.hypot(target.x - chosen.x, target.y - chosen.y) <= 20, 'the tap must land within 20px of the centre');

  fireEvent.pointerDown(host, { pointerId: 1, pointerType: 'touch', clientX: target.x, clientY: target.y });
  fireEvent.pointerUp(host, { pointerId: 1, pointerType: 'touch', clientX: target.x, clientY: target.y });
  fireEvent.click(host, { clientX: target.x, clientY: target.y });

  await waitFor(() => {
    const selected = host.querySelector('.arch-selected[data-entity-id]');
    assert.equal(
      selected?.getAttribute('data-entity-id'),
      chosen.id,
      'the tap must select the node whose centre it was nearest',
    );
  });
});

test('touch hit area: every drawn node gets a coarse hit rectangle of at least 44px on screen', async () => {
  usePhone();
  rememberShowAllFilter();
  // The box is stubbed BEFORE the drawing mounts, because the hit rectangles
  // are laid down in the draw pass from the measured scale.
  const restore = stubRootSvgBox(60, 45);
  try {
    render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
    const host = await waitForDiagram();
    const hits = [...host.querySelectorAll('[data-architecture-node-hit]')];
    assert.ok(hits.length >= 1, 'the coarse tier must overlay a hit rectangle on every drawn node');
    for (const hit of hits) {
      const width = Number(hit.getAttribute('data-architecture-hit-screen-width'));
      const height = Number(hit.getAttribute('data-architecture-hit-screen-height'));
      assert.ok(width >= 44, `a node hit rectangle must reach 44px wide; got ${width}px`);
      assert.ok(height >= 44, `a node hit rectangle must reach 44px tall; got ${height}px`);
      assert.equal(hit.getAttribute('pointer-events'), 'all', 'the overlay must receive the tap');
    }

    // The reason the overlay exists: the visible file box is far below 44px.
    const svg = host.querySelector('svg');
    assert.ok(svg instanceof SVGSVGElement);
    const scale = svgScreenScale(svg);
    assert.ok(scale !== null);
    const box = drawnNodeBox(host, 'src/modules/beta/b.ts');
    assert.ok(box !== null, 'the fixture draws the single-file directory as itself');
    assert.ok(
      box.height * scale.scaleY < 20,
      `the visible box must stay below 20px on screen; got ${box.height * scale.scaleY}px`,
    );
  } finally {
    restore();
  }
});

test('touch hit area: overlapping coarse targets resolve to the nearest node centre', () => {
  const host = document.createElement('div');
  // Two nodes whose 44px boxes overlap: their centres are 25 screen px apart
  // (viewBox 1000×500 shown at 100×50 = 0.1×), so a topmost-rectangle hit test
  // would hand the second node's taps to the first.
  host.innerHTML = [
    '<svg viewBox="0 0 1000 500">',
    '<g class="uml-node" data-entity-id="a"><rect x="100" y="100" width="200" height="40"/></g>',
    '<g class="uml-node" data-entity-id="b"><rect x="350" y="100" width="200" height="40"/></g>',
    '<g class="uml-node" data-entity-id="stub::outside"><rect x="800" y="100" width="100" height="40"/></g>',
    '</svg>',
  ].join('');
  const svg = host.querySelector('svg');
  assert.ok(svg instanceof SVGSVGElement);
  svg.getBoundingClientRect = () => boxRect(0, 0, 100, 50);

  addNodeHitTargets(host, true);
  assert.equal(host.querySelectorAll('[data-architecture-node-hit]').length, 2, 'stub nodes get no target');
  // Node a's centre is (20, 12); node b's is (45, 12). At x = 30 the two boxes
  // both contain the point, but a's centre is nearer.
  assert.equal(nearestNodeHitId(host, 30, 12), 'a');
  assert.equal(nearestNodeHitId(host, 40, 12), 'b');
  assert.equal(nearestNodeHitId(host, 400, 400), null, 'a point outside every target hits nothing');
  assert.equal(nearestNodeHitId(host, 85, 12), null, 'a stub is not an entity target');

  addNodeHitTargets(host, false);
  assert.equal(host.querySelectorAll('[data-architecture-node-hit]').length, 0, 'a fine pointer keeps the visible shape');
});

test('touch hit area: a fine pointer click still selects and opens the inspector on the first click', async () => {
  // The beforeEach setup is the fine-pointer desktop tier.
  rememberShowAllFilter();
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await waitForDiagram();
  const node = host.querySelector('[data-entity-id="src/modules/beta/b.ts"]');
  assert.ok(node instanceof Element);
  fireEvent.click(node);

  await waitFor(() => {
    assert.equal(
      host.querySelector('.arch-selected[data-entity-id]')?.getAttribute('data-entity-id'),
      'src/modules/beta/b.ts',
      'the first click must select the node',
    );
  });
  const name = await waitFor(() => {
    const element = document.querySelector('[data-architecture-inspector-name]');
    assert.ok(element !== null, 'the first fine-pointer click opens the inspector');
    return element;
  });
  assert.ok((name.getAttribute('data-architecture-inspector-name') ?? '').length > 0);
  // The inspector names the file the clicked node lives in; for a project-
  // relative file id that path IS the id.
  assert.equal(
    document.querySelector('[data-architecture-inspector-path]')?.getAttribute('data-architecture-inspector-path'),
    'src/modules/beta/b.ts',
  );
  assert.equal(
    host.querySelector('[data-architecture-node-hit]'),
    null,
    'a fine pointer must not get the coarse overlay',
  );
});
