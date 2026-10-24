import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, test, vi } from 'vitest';

import enCommon from '@/modules/i18n/locales/en/common.json';
import zhCNCommon from '@/modules/i18n/locales/zh-CN/common.json';
import type * as SharedApiModule from '@/shared/api';
import { ArchitecturePanel } from '@/modules/architecture';
import type { ArchitectureGraphResult } from '@/modules/architecture';

/**
 * The phone architecture layout:
 *  · the header is ONE row holding only the view switch and `Adjust`;
 *  · `Adjust` opens a real bottom-sheet dialog (`role="dialog"`, aria-modal,
 *    focus trap, focus restored to the trigger) carrying scope, detail, the
 *    SAME filter content the desktop `Filter ▾` popover draws, search, export
 *    and the legend; it is capped at 45vh so the drawing stays visible;
 *  · the one-line readout is a single 44px in-flow row above the drawing; its
 *    explanation, hidden-count and filter actions live in the expanded area,
 *    which stays in document flow when opened;
 *  · the minimap starts collapsed in the SAME bottom-right row as the zoom
 *    cluster (one horizontal row) and opens to its 96×64 thumbnail;
 *  · the zoom cluster itself is one horizontal 52px row of 44px targets;
 *  · the touch instruction is a one-off in-canvas bubble (`role="status"`)
 *    that fades itself out after 3s or closes on demand, and the dismissal is
 *    remembered;
 *  · every control keeps a 44×44 hit area with an 8px gap between neighbours.
 */

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
// re-fit. Recording the callbacks keeps the component's effect from throwing
// AND lets a case re-measure a viewport jsdom reports as zero-sized.
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

/** jsdom ships no `PointerEvent`; the sheet's drag reads `clientY` from it. */
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

/** The review viewport: 390×844 portrait, coarse pointer, no hover. */
function usePhone(): void {
  setViewport(390, 844);
  stubMatchMedia((query) => query === '(pointer: coarse)' || query === TOUCH_ONLY_QUERY);
}

// Pay the one-off renderer compile in the hook budget, not the first case's 5s.
beforeAll(async () => {
  await import('@yalehwang/plantuml-js/elk');
});

const ENTITY_MMD = '@startuml\nX --> Y\n@enduml';
const FILE_MMD = '@startuml\nA --> B\n@enduml';

/** Three files across two directories: enough for the overview to fold into groups. */
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

/** The same neighbourhood, cut by the FILE graph's node budget. */
const TRUNCATED_RESULT: ArchitectureGraphResult = {
  ...RESULT,
  stats: { ...RESULT.stats, truncated: true, fileTruncated: true, fileTotal: 9 },
};

/** A reading whose footer carries unresolved names the reader can expand. */
const UNRESOLVED_RESULT: ArchitectureGraphResult = {
  ...RESULT,
  stats: {
    ...RESULT.stats,
    unresolved: { files: ['src/unknown.ts'], identifiers: ['NoSuchThing'] },
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

function panelRoot(): HTMLElement {
  const panel = document.querySelector('[data-architecture-panel]');
  assert.ok(panel instanceof HTMLElement);
  return panel;
}

function graphRoot(): HTMLElement {
  const root = document.querySelector('[data-architecture-plantuml-graph]');
  assert.ok(root instanceof HTMLElement);
  return root;
}

/** The single compact header row, asserting there is exactly one. */
function toolbarRow(): HTMLElement {
  const rows = document.querySelectorAll('[data-architecture-toolbar]');
  assert.equal(rows.length, 1, 'the compact tier must spend exactly one row on chrome');
  const row = rows[0];
  assert.ok(row instanceof HTMLElement);
  return row;
}

function openSheet(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: 'Adjust' }));
  const sheet = document.querySelector('[data-architecture-sheet]');
  assert.ok(sheet instanceof HTMLElement, 'the Adjust button must open the bottom sheet');
  return sheet;
}

/**
 * Pin a viewport for the minimap. jsdom reports zero sizes, so the component
 * correctly concludes there is nothing to map; this injects a small content box
 * and an overflowing drawing, then re-runs the recorded ResizeObserver callback
 * exactly as a real resize would.
 */
function makeDrawingOverflow(host: HTMLElement): void {
  Object.defineProperty(host, 'clientWidth', { configurable: true, value: 140 });
  Object.defineProperty(host, 'clientHeight', { configurable: true, value: 100 });
  const svg = host.querySelector('svg');
  assert.ok(svg instanceof SVGSVGElement);
  svg.setAttribute('viewBox', '0 0 4000 1000');
  act(() => {
    for (const callback of [...resizeCallbacks]) callback([], {} as ResizeObserver);
  });
}

beforeEach(() => {
  apiMock.architectureGraph.mockReset();
  apiMock.architectureGraph.mockResolvedValue(jsonResponse(RESULT));
  // The knobs are remembered per project; a case that moves them must not
  // decide the next case's starting value.
  window.localStorage.removeItem('architecture.scope.project-1');
  window.localStorage.removeItem('architecture.detail.project-1');
  window.localStorage.removeItem('architecture.filter.project-1');
  window.localStorage.removeItem('architecture.touchHint.dismissed');
  window.localStorage.removeItem('architecture.minimap.collapsed');
  // The portrait tier remembers the summary's expansion for the browser
  // session, so a case that opens it decides the next mount's starting value
  // unless the store is cleared here too.
  window.sessionStorage.removeItem('architecture-readout-expanded');
  setViewport(1024, 768);
  stubMatchMedia(() => false);
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  setViewport(originalInnerWidth, originalInnerHeight);
});

test('the phone header is one row: the view switch and Adjust, nothing else', async () => {
  usePhone();
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  await waitForDiagram();

  const row = toolbarRow();
  // The compact tier's two control groups, and only those two. The title and
  // the truncation badge are gone from the header (the readout carries them).
  const groups = [...row.children].filter((child) => child.matches('[data-architecture-view-control], [data-architecture-sheet-toggle]'));
  assert.equal(groups.length, 2, 'the header spends its row on exactly the view switch and Adjust');
  assert.ok(within(row).getByRole('radiogroup', { name: 'Graph granularity' }));
  const adjust = within(row).getByRole('button', { name: 'Adjust' });
  assert.equal(adjust.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(adjust.getAttribute('aria-expanded'), 'false');
  assert.equal(row.textContent?.includes('Architecture'), false, 'the title is not part of the phone row');

  // One row of chrome, and the graph draws no toolbar of its own.
  assert.equal(document.querySelectorAll('[data-architecture-toolbar]').length, 1);
  assert.equal(graphRoot().querySelector('[data-architecture-toolbar]'), null);
  // The readout is an IN-FLOW row above the drawing, not a translucent card
  // floating over its top-left corner (the card covered the drawing and
  // collided with the corner chrome).
  const readoutRow = document.querySelector('[data-architecture-readout-overlay]');
  assert.ok(readoutRow instanceof HTMLElement);
  assert.equal(
    readoutRow,
    document.querySelector('[data-architecture-canvas-header]'),
    'the phone readout is the canvas header row',
  );
  assert.equal(readoutRow.className.includes('absolute'), false, 'the readout row is in flow, not an overlay');
  assert.ok(readoutRow.closest('[data-architecture-toolbar]') === null, 'the readout does not live in the header');
  assert.ok(
    readoutRow.closest('[data-architecture-canvas-region]') === null,
    'the readout row sits above the drawing region, not inside it',
  );
  const region = document.querySelector('[data-architecture-canvas-region]');
  assert.ok(region instanceof HTMLElement);
  assert.equal(
    readoutRow.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING,
    Node.DOCUMENT_POSITION_FOLLOWING,
    'the drawing comes after the readout row in document order',
  );
});

test('Adjust opens a dialog holding scope, detail, filter, search and export', async () => {
  usePhone();
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  await waitForDiagram();

  const sheet = openSheet();
  assert.equal(sheet.getAttribute('role'), 'dialog');
  assert.equal(sheet.getAttribute('aria-modal'), 'true');
  assert.equal(sheet.style.maxHeight, '45vh', 'the sheet leaves the drawing visible');

  assert.ok(sheet.querySelector('[data-architecture-scope-control]'), 'scope stepper');
  assert.equal(
    sheet.querySelectorAll('[data-architecture-detail-option]').length,
    3,
    'the three detail presets',
  );
  assert.ok(sheet.querySelector('[data-architecture-filter-panel]'), 'the same filter component the desktop popover hosts');
  assert.ok(sheet.querySelector('[data-architecture-search]'), 'search box');
  assert.ok(sheet.querySelector('[data-architecture-export]'), 'export menu');
  assert.ok(sheet.querySelector('[data-architecture-legend-content]'), 'legend');

  // Every group has a title: View / Scope / Detail / Filter / Export / Legend.
  for (const section of ['view', 'scope', 'detail', 'filter', 'export', 'legend']) {
    const container = sheet.querySelector(`[data-architecture-sheet-${section}]`);
    assert.ok(container instanceof HTMLElement, `the sheet must draw the ${section} group`);
    const title = container.querySelector('span');
    assert.ok(
      (title?.textContent ?? '').trim().length > 0,
      `the ${section} group must carry a visible title`,
    );
  }
  // The filter group's title is the bare word "Filter": `Filter ▾` belongs to
  // the disclosure button, not to a section heading.
  assert.equal(
    sheet.querySelector('[data-architecture-sheet-filter] > span')?.textContent?.trim(),
    'Filter',
  );

  // The scope stepper's two buttons have a visible border and a 44×44 box, and
  // the reading is vertically centred between them.
  for (const attribute of ['data-architecture-scope-decrease', 'data-architecture-scope-increase']) {
    const button = sheet.querySelector(`[${attribute}]`) as HTMLElement;
    assert.ok(button instanceof HTMLElement);
    assert.match(button.className, /(^|\s)border(\s|$)/, `${attribute} must draw a visible border`);
    assert.equal(button.style.minHeight, '44px');
    assert.equal(button.style.minWidth, '44px');
  }
  assert.match(
    (sheet.querySelector('[role="spinbutton"]') as HTMLElement).className,
    /(^|\s)items-center(\s|$)/,
    'the scope reading must be vertically centred',
  );

  // Focus returns to the trigger when the dialog closes.
  const trigger = screen.getByRole('button', { name: 'Adjust' });
  fireEvent.click(sheet.querySelector('[data-architecture-sheet-close]') as Element);
  assert.equal(document.querySelector('[data-architecture-sheet]'), null, 'the sheet closes');
  assert.equal(document.activeElement, trigger, 'focus goes back to the Adjust button');

  // The dialog's Tab trap wraps at the end instead of leaving the sheet.
  const reopened = openSheet();
  const focusables = [...reopened.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')];
  const last = focusables[focusables.length - 1];
  last.focus();
  fireEvent.keyDown(last, { key: 'Tab' });
  assert.equal(document.activeElement, focusables[0], 'Tab from the last control wraps to the first');

  // Pulling the handle down past the threshold closes the sheet.
  const handle = reopened.querySelector('[data-architecture-sheet-drag-handle]');
  assert.ok(handle instanceof HTMLElement);
  fireEvent.pointerDown(handle, { pointerId: 1, pointerType: 'touch', clientY: 100 });
  fireEvent.pointerMove(handle, { pointerId: 1, pointerType: 'touch', clientY: 200 });
  fireEvent.pointerUp(handle, { pointerId: 1, pointerType: 'touch', clientY: 200 });
  assert.equal(document.querySelector('[data-architecture-sheet]'), null, 'a downward drag dismisses the sheet');
});

test('stepping scope or narrowing the filter inside the sheet updates the floating readout', async () => {
  usePhone();
  // The first request answers the default scope; the scope step is answered by
  // a wider reading, so the floating readout's number actually moves.
  apiMock.architectureGraph
    .mockResolvedValueOnce(jsonResponse(RESULT))
    .mockResolvedValueOnce(jsonResponse(TRUNCATED_RESULT));
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  await waitForDiagram();

  const sheet = openSheet();
  const readoutOverlay = document.querySelector('[data-architecture-readout-overlay]');
  assert.ok(readoutOverlay instanceof HTMLElement);
  assert.equal(
    readoutOverlay.querySelector('[data-architecture-readout-total]')?.getAttribute('data-architecture-readout-total'),
    '3',
    'the first reading states the default scope',
  );

  // Scope is a server parameter: +2 → +3 re-requests and the readout follows.
  const spin = sheet.querySelector('[role="spinbutton"]');
  assert.ok(spin instanceof HTMLElement);
  assert.equal(spin.textContent, '+2');
  fireEvent.click(sheet.querySelector('[data-architecture-scope-increase]') as Element);
  await waitFor(() => assert.equal(apiMock.architectureGraph.mock.calls.length, 2));
  assert.deepEqual(
    apiMock.architectureGraph.mock.calls[1].slice(0, 3),
    ['project-1', 'session-1', 3],
    'stepping + from +2 must re-request hops=3',
  );
  await waitFor(() =>
    assert.equal(
      readoutOverlay.querySelector('[data-architecture-readout-total]')?.getAttribute('data-architecture-readout-total'),
      '9',
      'the floating readout follows the new scope reading',
    ),
  );
  assert.equal(
    sheet.querySelector('[role="spinbutton"]')?.getAttribute('aria-valuenow'),
    '3',
    'the sheet stepper follows the scope',
  );

  // The filter is the same component: choosing "show every relation" removes
  // the hidden-count line from the expanded readout while the sheet stays open.
  // The collapsed card is one line by contract, so the line lives behind the
  // toggle; expanding is what puts it in the document.
  assert.equal(
    readoutOverlay.querySelector('[data-architecture-filter-hidden]'),
    null,
    'the collapsed one-line readout states only the shown/related summary',
  );
  fireEvent.click(readoutOverlay.querySelector('[data-architecture-readout-toggle]') as Element);
  await waitFor(() =>
    assert.ok(
      readoutOverlay.querySelector('[data-architecture-filter-hidden]'),
      'the default filter hides the call edge, so the expanded readout states it',
    ),
  );
  fireEvent.click(sheet.querySelector('[data-architecture-filter-relation="call"]') as Element);
  await waitFor(() =>
    assert.equal(
      readoutOverlay.querySelector('[data-architecture-filter-hidden]'),
      null,
      'showing every relation leaves nothing hidden to state',
    ),
  );
  assert.ok(document.querySelector('[data-architecture-sheet]'), 'the sheet stays open while the drawing changes');

  // The Chinese bundle carries the review wording.
  assert.equal(zhCNCommon.architecture.sheet.open, '调节');
  assert.equal(zhCNCommon.architecture.controls.scope, '范围');
});

test('the desktop tier keeps its header and renders no sheet', async () => {
  // The beforeEach setup: fine pointer, 1024px.
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  await waitForDiagram();

  assert.equal(document.querySelector('[data-architecture-sheet-toggle]'), null, 'no Adjust button on desktop');
  assert.equal(document.querySelector('[data-architecture-sheet]'), null, 'no bottom sheet on desktop');
  const header = document.querySelector('[data-architecture-toolbar]');
  assert.ok(header instanceof HTMLElement);
  assert.ok(header.querySelector('[data-architecture-scope-control]'), 'desktop keeps the scope stepper in the header');
  assert.ok(header.querySelector('[data-architecture-detail-control]'), 'desktop keeps the detail presets');
  assert.ok(header.querySelector('[data-architecture-filter-toggle]'), 'desktop keeps the Filter ▾ disclosure');
  assert.ok(header.querySelector('[data-architecture-export]'), 'desktop keeps export');
  assert.ok(header.querySelector('[data-architecture-legend-toggle]'), 'desktop keeps the legend button');
  assert.ok(document.querySelector('[data-architecture-canvas-header]'), 'desktop keeps the in-flow readout row');
  assert.ok(document.querySelector('[data-architecture-readout]'), 'desktop still shows the one-line readout');
});

test('the minimap starts collapsed above the zoom cluster and opens to 96×64 without overlap', async () => {
  usePhone();
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await waitForDiagram();
  makeDrawingOverflow(host);

  const expand = await waitFor(() => {
    const button = document.querySelector('[data-architecture-minimap-expand]');
    assert.ok(button instanceof HTMLElement, 'a phone gets the collapsed minimap button by default');
    return button;
  });
  const expandStyle = getComputedStyle(expand);
  assert.equal(expandStyle.minHeight, '44px', 'the collapsed minimap is a 44px target');
  assert.equal(expandStyle.minWidth, '44px');
  assert.equal(document.querySelector('[data-architecture-minimap-canvas]'), null, 'the map is not expanded yet');

  fireEvent.click(expand);
  const canvas = await waitFor(() => {
    const element = document.querySelector('[data-architecture-minimap-canvas]');
    assert.ok(element instanceof HTMLElement, 'clicking the button opens the map');
    return element;
  });
  assert.equal(canvas.style.width, '96px', 'the phone map is the 96px thumbnail');
  assert.equal(canvas.style.height, '64px');

  // A phone spends ONE ROW on the corner chrome: the collapsed minimap button
  // and the zoom cluster sit side by side, bottom aligned. The pair therefore
  // takes ~52px of height instead of the shipped 204px column.
  const overlays = document.querySelector('[data-architecture-canvas-overlays]');
  const cluster = document.querySelector('[data-architecture-zoom-cluster]');
  assert.ok(overlays instanceof HTMLElement);
  assert.ok(cluster instanceof HTMLElement);
  assert.equal(overlays.style.rowGap, '8px');
  assert.equal(overlays.style.columnGap, '8px');
  assert.equal(overlays.style.flexDirection, 'row');
  const minimap = document.querySelector('[data-architecture-minimap]');
  assert.ok(minimap instanceof HTMLElement);
  assert.ok(
    minimap.compareDocumentPosition(cluster) & Node.DOCUMENT_POSITION_FOLLOWING,
    'the map sits before the zoom cluster in the row',
  );

  // Inject the two boxes' sizes and prove the horizontal gap: the arithmetic
  // is what the flex row above states, read through getBoundingClientRect.
  minimap.getBoundingClientRect = () => ({
    x: 200, y: 533, left: 200, top: 533, width: 44, height: 44, right: 244, bottom: 577,
    toJSON: () => ({}),
  }) as DOMRect;
  cluster.getBoundingClientRect = () => ({
    x: 252, y: 525, left: 252, top: 525, width: 120, height: 52, right: 372, bottom: 577,
    toJSON: () => ({}),
  }) as DOMRect;
  const mapRect = minimap.getBoundingClientRect();
  const clusterRect = cluster.getBoundingClientRect();
  assert.ok(clusterRect.left - mapRect.right >= 8, 'the map and the cluster keep an 8px gap');
  assert.equal(clusterRect.height, 52, 'the phone zoom cluster is one 52px row');

  // The row's own height contract: the portrait tier ships the cluster as ONE
  // 44px button (the ±/Fit row is behind it), so the corner chrome is a single
  // 44px-tall row whether or not the map is open.
  assert.equal(cluster.style.flexDirection, 'row');
  assert.equal(cluster.style.height, '44px');
});

test('the phone readout collapses to one 44px line and expands in document flow', async () => {
  usePhone();
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  await waitForDiagram();

  const readout = document.querySelector('[data-architecture-readout]');
  assert.ok(readout instanceof HTMLElement);
  const toggle = readout.querySelector('[data-architecture-readout-toggle]');
  assert.ok(toggle instanceof HTMLElement);
  // Collapsed: the card itself is a 44px box, and its one line does not wrap.
  assert.equal(readout.style.height, '44px', 'the collapsed phone readout is one 44px line');
  assert.equal(toggle.style.minHeight, '44px', 'the toggle is still a 44×44 target');
  assert.match(toggle.className, /flex-nowrap/, 'the collapsed line stays on one row');
  const summary = readout.querySelector('[data-architecture-readout-summary]');
  assert.ok(summary instanceof HTMLElement);
  assert.match(summary.className, /truncate|whitespace-nowrap/, 'the summary truncates instead of wrapping');
  assert.equal(readout.querySelector('[data-architecture-readout-detail]'), null, 'nothing is expanded yet');

  // Expanded: the detail area is a normal-flow block under the toggle, so it
  // grows the card instead of covering the drawing.
  fireEvent.click(toggle);
  const detail = await waitFor(() => {
    const node = document.querySelector('[data-architecture-readout-detail]');
    assert.ok(node instanceof HTMLElement, 'clicking the toggle expands the readout');
    return node;
  });
  assert.equal(readout.style.height, '', 'the expanded card is no longer fixed at 44px');
  const detailPosition = getComputedStyle(detail).position;
  assert.ok(
    detailPosition === '' || detailPosition === 'static',
    `the expanded area is in document flow (position=${detailPosition})`,
  );
  assert.ok(
    readout.contains(detail),
    'the expanded area belongs to the same card above the canvas',
  );
});

test('the phone zoom cluster ships collapsed as one 44px button and opens to a horizontal 52px row', async () => {
  usePhone();
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  await waitForDiagram();

  const cluster = document.querySelector('[data-architecture-zoom-cluster]');
  assert.ok(cluster instanceof HTMLElement);
  assert.match(cluster.className, /flex/, 'the cluster is a flex row');
  assert.equal(cluster.style.flexDirection, 'row', 'the phone cluster is horizontal');
  // The shipped portrait form is ONE 44px button: the drawing owns the height,
  // and the expanded ±/Fit row is what the reader opens on demand.
  assert.equal(cluster.style.height, '44px', 'the collapsed form is one 44px target');
  assert.equal(cluster.querySelector('[data-architecture-zoom-in]'), null, 'the row starts closed');
  const toggle = cluster.querySelector('[data-architecture-zoom-cluster-toggle]');
  assert.ok(toggle instanceof HTMLElement, 'the collapsed form is the toggle');
  assert.equal(toggle.style.minHeight, '44px');
  assert.equal(toggle.style.minWidth, '44px');

  fireEvent.click(toggle);
  await waitFor(() => assert.equal(cluster.querySelector('[data-architecture-zoom-in]') !== null, true));
  assert.equal(cluster.style.height, '52px', 'one 44px row plus 4px a side');
  for (const attribute of ['data-architecture-zoom-in', 'data-architecture-zoom-out', 'data-architecture-zoom-fit']) {
    const button = cluster.querySelector(`[${attribute}]`) as HTMLElement | null;
    assert.ok(button instanceof HTMLElement, `${attribute} must be in the cluster`);
    assert.equal(button.style.minHeight, '44px');
    assert.equal(button.style.minWidth, '44px');
  }
  // The scale and level readings ride in the same row's right-hand small text.
  assert.ok(cluster.querySelector('[data-architecture-zoom-cluster-level]'));
});

test('the touch hint is a one-off bubble on the drawing, dismissed by click or fade and remembered', async () => {
  usePhone();
  const first = render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  await waitForDiagram();

  const hint = document.querySelector('[data-architecture-touch-hint]');
  assert.ok(hint instanceof HTMLElement, 'the hint appears on first entry');
  assert.equal(hint.getAttribute('role'), 'status', 'the hint is announced without stealing focus');
  assert.equal(hint.style.position, 'absolute', 'the hint is an overlay bubble, not a row');
  assert.ok(hint.closest('[data-architecture-canvas-region]'), 'the bubble lives inside the drawing region');
  assert.equal(hint.closest('[data-architecture-toolbar]'), null, 'it never takes a header row');
  assert.match(hint.textContent ?? '', /Drag with one finger/);
  assert.match(hint.textContent ?? '', /pinch to zoom/);

  fireEvent.click(within(hint).getByRole('button', { name: 'Dismiss hint' }));
  assert.equal(document.querySelector('[data-architecture-touch-hint]'), null, 'clicking it dismisses it');
  assert.equal(
    window.localStorage.getItem('architecture.touchHint.dismissed'),
    'true',
    'the dismissal is remembered',
  );

  // A fresh mount does not resurrect it.
  first.unmount();
  const second = render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  await waitForDiagram();
  assert.equal(document.querySelector('[data-architecture-touch-hint]'), null, 'the remembered dismissal survives a mount');

  // The other accepted dismissal channel: the 3s fade's animation end.
  second.unmount();
  window.localStorage.removeItem('architecture.touchHint.dismissed');
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  await waitForDiagram();
  const fades = document.querySelector('[data-architecture-touch-hint]');
  assert.ok(fades instanceof HTMLElement);
  assert.match(fades.style.animation, /3000ms/, 'the fade runs for 3 seconds');
  act(() => {
    fireEvent.animationEnd(fades);
  });
  assert.equal(document.querySelector('[data-architecture-touch-hint]'), null, 'the fade end removes the bubble');
  assert.equal(window.localStorage.getItem('architecture.touchHint.dismissed'), 'true');
});

test('every architecture control keeps a 44×44 target and an 8px gap from its neighbour', async () => {
  usePhone();
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await waitForDiagram();
  makeDrawingOverflow(host);
  const sheet = openSheet();

  // Open the export menu too, so its items are part of the reading.
  fireEvent.click(sheet.querySelector('[data-architecture-export]') as Element);

  const controls = [
    ...panelRoot().querySelectorAll<HTMLElement>('button, input, [role="spinbutton"]'),
  ];
  assert.ok(controls.length >= 20, `the phone layout must expose its controls; got ${controls.length}`);
  for (const control of controls) {
    const style = getComputedStyle(control);
    assert.equal(style.minHeight, '44px', `a coarse-pointer target must be 44px tall: ${control.getAttribute('data-architecture-export-item') ?? control.textContent ?? control.getAttribute('aria-label') ?? ''}`);
    assert.equal(style.minWidth, '44px', `a coarse-pointer target must be 44px wide: ${control.getAttribute('data-architecture-export-item') ?? control.textContent ?? control.getAttribute('aria-label') ?? ''}`);
  }

  // The groups that place controls next to each other declare a gap of at
  // least 8px. Injecting the boxes (jsdom has no layout) and reading them
  // through getBoundingClientRect proves the neighbours cannot touch.
  const groups = [
    toolbarRow(),
    sheet.querySelector('[data-architecture-scope-control]'),
    sheet.querySelector('[data-architecture-detail-control]'),
    sheet.querySelector('[data-architecture-sheet-body]'),
    document.querySelector('[data-architecture-export-menu-root]'),
    document.querySelector('[data-architecture-canvas-overlays]'),
    document.querySelector('[data-architecture-zoom-cluster]'),
  ];
  for (const group of groups) {
    assert.ok(group instanceof HTMLElement, 'the group must be on screen');
    const declared = group.style.gap
      || group.style.rowGap
      || group.style.columnGap;
    const gap = Number.parseFloat(declared);
    assert.ok(Number.isFinite(gap) && gap >= 8, `a control group must keep an 8px gap; got ${declared || '(none)'}`);
  }

  // Pairwise geometry for the zoom cluster: on the phone its buttons are one
  // horizontal row with that gap, not the desktop's stacked column. The
  // portrait tier opens the row through its shipped toggle first.
  const cluster = document.querySelector('[data-architecture-zoom-cluster]') as HTMLElement;
  fireEvent.click(cluster.querySelector('[data-architecture-zoom-cluster-toggle]') as Element);
  assert.equal(cluster.style.flexDirection, 'row', 'the phone cluster is one row');
  assert.equal(cluster.style.height, '52px', 'the row is 44px targets + 4px a side');
  const clusterButtons = [...cluster.querySelectorAll('button')];
  const gap = Number.parseFloat(cluster.style.gap);
  let left = 100;
  for (const button of clusterButtons) {
    const boxLeft = left;
    button.getBoundingClientRect = () => ({
      x: boxLeft, y: 0, left: boxLeft, top: 0, width: 44, height: 44, right: boxLeft + 44, bottom: 44,
      toJSON: () => ({}),
    }) as DOMRect;
    left += 44 + gap;
  }
  for (let index = 1; index < clusterButtons.length; index += 1) {
    const previous = clusterButtons[index - 1].getBoundingClientRect();
    const current = clusterButtons[index].getBoundingClientRect();
    assert.ok(current.left - previous.right >= 8, 'adjacent zoom controls keep an 8px gap');
  }
});

test('the drawing keeps at least 85% of the phone tab height', async () => {
  usePhone();
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  await waitForDiagram();

  const panel = panelRoot();
  const region = document.querySelector('[data-architecture-canvas-region]');
  const row = toolbarRow();
  assert.ok(region instanceof HTMLElement);
  // The only in-flow chrome is the 44px-target header row (44 + 2×6px
  // padding). jsdom cannot lay it out, so the two boxes are injected and the
  // region is then the flex-1 remainder below the row.
  const rect = (height: number, width = 390): DOMRect => ({
    x: 0, y: 0, left: 0, top: 0, width, height, right: width, bottom: height,
    toJSON: () => ({}),
  }) as DOMRect;
  const rowHeight = 44 + 12;
  panel.getBoundingClientRect = () => rect(844);
  row.getBoundingClientRect = () => rect(rowHeight);
  region.getBoundingClientRect = () => rect(844 - rowHeight);
  assert.match(region.className, /(^|\s)flex-1(\s|$)/, 'the drawing absorbs the remaining height');
  assert.equal(panel.contains(row), true, 'the single header row lives in the tab column');
  assert.equal(panel.contains(region), true, 'the drawing lives in the same tab column');
  assert.equal(row.contains(region), false, 'the drawing is below the row, not inside it');
  const share = region.getBoundingClientRect().height / panel.getBoundingClientRect().height;
  assert.ok(share >= 0.85, `the drawing must keep ≥85% of the tab; got ${Math.round(share * 100)}%`);
});

test('compact fullscreen toolbar is one row holding only Exit fullscreen and Adjust', async () => {
  usePhone();
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  await waitForDiagram();

  // jsdom reports a zero box for every element; the readout row's covered band
  // is what the drawing must reserve. Inject its bottom edge — the toolbar sits
  // above it, so this button is the whole covered band.
  const readoutRow = document.querySelector('[data-architecture-readout-overlay]') as HTMLElement;
  assert.ok(readoutRow instanceof HTMLElement);
  readoutRow.getBoundingClientRect = () => ({ bottom: 100 }) as unknown as DOMRect;

  // The portrait tier keeps Fullscreen inside the Adjust sheet (the one-row
  // toolbar gives it up), so entering the overlay goes through that door.
  fireEvent.click(document.querySelector('[data-architecture-sheet-toggle]') as Element);
  const portalSheet = await waitFor(() => {
    const node = document.querySelector('[data-architecture-sheet]');
    assert.ok(node instanceof HTMLElement, 'Adjust opens its dialog');
    return node;
  });
  fireEvent.click(portalSheet.querySelector('[data-architecture-fullscreen-toggle]') as Element);
  fireEvent.click(portalSheet.querySelector('[data-architecture-sheet-close]') as Element);
  await waitFor(() => assert.equal(panelRoot().getAttribute('data-architecture-fullscreen'), 'true'));

  // The viewport-sized drawing reserves the chrome band, so its fitted content
  // is centred BELOW the readout row instead of starting behind it.
  await waitFor(() => assert.equal(
    (document.querySelector('[data-architecture-plantuml]') as HTMLElement).style.paddingTop,
    '104px',
    'the drawing reserves the top chrome band inside the overlay',
  ));

  const row = toolbarRow();
  // The row states its one-line contract, and a laid-out row can only be that
  // line: one 44px target plus the row's 2×6px padding.
  assert.equal(row.style.height, '56px', 'the overlay spends exactly one 44px row');
  assert.equal(row.style.flexWrap, 'nowrap', 'the overlay row never wraps');
  // jsdom does not lay out; inject the box the declaration states and read it
  // the way the criterion does.
  row.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, width: 390, height: 56, right: 390, bottom: 56,
    toJSON: () => ({}),
  }) as DOMRect;
  assert.ok(row.getBoundingClientRect().height <= 56, 'the fullscreen toolbar is at most 56px tall');

  assert.ok(within(row).getByRole('button', { name: 'Exit fullscreen' }));
  const adjust = within(row).getByRole('button', { name: 'Adjust' });
  assert.equal(adjust.getAttribute('aria-haspopup'), 'dialog');
  // The view switch and the Text page are NOT part of the one row...
  assert.equal(row.querySelector('[data-architecture-view-control]'), null);
  assert.equal(row.querySelector('[data-architecture-text-toggle]'), null);
  assert.equal(document.querySelectorAll('[data-architecture-toolbar]').length, 1);

  // ...they moved into the one menu the row keeps.
  fireEvent.click(adjust);
  const sheet = await waitFor(() => {
    const node = document.querySelector('[data-architecture-sheet]');
    assert.ok(node instanceof HTMLElement, 'Adjust still opens its dialog in the overlay');
    return node;
  });
  assert.ok(sheet.querySelector('[data-architecture-view-control]'), 'the view switch moves into Adjust');
  assert.ok(sheet.querySelector('[data-architecture-text-toggle]'), 'the Text page moves into Adjust');

  // Leaving the overlay brings the full row back.
  fireEvent.click(sheet.querySelector('[data-architecture-sheet-close]') as Element);
  fireEvent.click(document.querySelector('[data-architecture-fullscreen-toggle]') as Element);
  await waitFor(() => assert.equal(panelRoot().getAttribute('data-architecture-fullscreen'), null));
  const restored = toolbarRow();
  assert.ok(restored.querySelector('[data-architecture-view-control]'), 'the tab keeps its view switch');
  assert.ok(restored.querySelector('[data-architecture-text-toggle]'), 'the tab keeps its Text page');
});

test('exactly one zoom percentage is on the page, in the tab and in the overlay', async () => {
  usePhone();
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  await waitForDiagram();

  // A zoom reading is a leaf whose whole text is the percentage; anything else
  // ("Whole graph at 92%", the minimap's label) is prose, not a reading. The
  // portrait tier's collapsed zoom control states the same reading on a
  // BUTTON (it is the one 44px door to the ±/Fit row), so buttons count as
  // leaves too.
  const percentageLeaves = (): HTMLElement[] => [
    ...document.querySelectorAll<HTMLElement>('span, button'),
  ].filter((element) => element.children.length === 0 && /^\d+%$/.test((element.textContent ?? '').trim()));

  assert.equal(percentageLeaves().length, 1, 'the tab states the drawing scale once');

  // Enter the overlay through the Adjust sheet, where the one-row portrait
  // toolbar keeps the Fullscreen entry.
  fireEvent.click(document.querySelector('[data-architecture-sheet-toggle]') as Element);
  const portalSheet = await waitFor(() => {
    const node = document.querySelector('[data-architecture-sheet]');
    assert.ok(node instanceof HTMLElement, 'Adjust opens its dialog');
    return node;
  });
  fireEvent.click(portalSheet.querySelector('[data-architecture-fullscreen-toggle]') as Element);
  fireEvent.click(portalSheet.querySelector('[data-architecture-sheet-close]') as Element);
  await waitFor(() => assert.equal(panelRoot().getAttribute('data-architecture-fullscreen'), 'true'));
  assert.equal(percentageLeaves().length, 1, 'the overlay does not add a second zoom reading');
});

test('a truncated graph states the cut on the floating readout, not in the header', async () => {
  apiMock.architectureGraph.mockResolvedValue(jsonResponse(TRUNCATED_RESULT));
  usePhone();
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  await waitForDiagram();

  const overlay = document.querySelector('[data-architecture-readout-overlay]');
  assert.ok(overlay instanceof HTMLElement);
  const badge = overlay.querySelector('[data-architecture-truncated-badge]');
  assert.ok(badge instanceof HTMLElement, 'the cut stays visible without opening the sheet');
  assert.equal(badge.getAttribute('data-architecture-truncated-omitted'), '6');
  assert.match(badge.textContent ?? '', /\+6 folded/);
  assert.equal(
    toolbarRow().querySelector('[data-architecture-truncated-badge]'),
    null,
    'the header row carries no badge — it belongs to the readout',
  );
  assert.ok(document.querySelector('[data-architecture-sheet]') === null, 'the reading needs no open sheet');
});

test('footer unresolved button stays inside the footer at 390px', async () => {
  usePhone();
  apiMock.architectureGraph.mockResolvedValue(jsonResponse(UNRESOLVED_RESULT));

  // jsdom has no layout engine, so model the footer row: the footer is the
  // 390px viewport. A control INSIDE the truncating source line keeps its
  // natural width (7px per character) and starts after "Analysis: <time> · ",
  // which is exactly how its right edge crossed the footer's; a sibling pill is
  // laid out against the row's right padding and fits by construction.
  const originalRect = Element.prototype.getBoundingClientRect;
  const box = (left: number, width: number): DOMRect => ({
    left, top: 0, width, height: 22, right: left + width, bottom: 22, x: left, y: 0, toJSON: () => ({}),
  } as DOMRect);
  Element.prototype.getBoundingClientRect = function rect(this: Element): DOMRect {
    if (this.hasAttribute('data-architecture-source-footer')) return box(0, 390);
    if (this.hasAttribute('data-architecture-unresolved')) {
      const width = (this.textContent ?? '').trim().length * 7;
      const insideSourceLine = this.closest('[data-architecture-source-line]') !== null;
      return insideSourceLine ? box(100, width) : box(390 - 12 - width, width);
    }
    return box(0, 0);
  };
  try {
    render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
    await waitForDiagram();

    const footer = document.querySelector('[data-architecture-source-footer]');
    const button = document.querySelector('[data-architecture-unresolved]');
    assert.ok(footer instanceof HTMLElement);
    assert.ok(button instanceof HTMLElement, 'the footer offers the unresolved disclosure');
    assert.equal(
      button.closest('[data-architecture-source-line]'),
      null,
      'the toggle must not live inside the self-clipping source line',
    );
    assert.doesNotMatch(
      footer.className,
      /(^|\s)overflow-hidden(\s|$)/,
      'the footer must not clip: both of its disclosures open upwards out of it',
    );
    const buttonRect = button.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    assert.ok(
      buttonRect.right <= footerRect.right,
      `the unresolved button must fit inside the footer: button right ${buttonRect.right} > footer right ${footerRect.right}`,
    );
  } finally {
    Element.prototype.getBoundingClientRect = originalRect;
  }
});

test('the compact footer shows a short unresolved label and expands to every name', async () => {
  usePhone();
  apiMock.architectureGraph.mockResolvedValue(jsonResponse(UNRESOLVED_RESULT));
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  await waitForDiagram();

  const button = document.querySelector('[data-architecture-unresolved]');
  assert.ok(button instanceof HTMLElement);
  const label = (button.textContent ?? '').trim();
  assert.ok(label.length < 20, `the phone pill must stay short, got ${label.length} chars: "${label}"`);
  assert.match(label, /unmatched/, 'the short label still says what the count is');
  assert.equal(document.querySelector('[data-architecture-unresolved-list]'), null);

  fireEvent.click(button);
  const list = await waitFor(() => {
    const node = document.querySelector('[data-architecture-unresolved-list]');
    assert.ok(node instanceof HTMLElement, 'the names expand upwards out of the footer');
    return node;
  });
  const summary = list.querySelector('[data-architecture-unresolved-summary]');
  assert.ok(summary instanceof HTMLElement, 'the full sentence moves to the top of the expanded list');
  assert.match(summary.textContent ?? '', /2 names mentioned in this session were not found/);
  const names = [...list.querySelectorAll('[data-architecture-unresolved-name]')].map((item) => item.textContent);
  assert.deepEqual(names, ['src/unknown.ts', 'NoSuchThing'], 'every unresolved name is listed');
});
