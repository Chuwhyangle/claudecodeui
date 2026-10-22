import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, test, vi } from 'vitest';

import enCommon from '@/modules/i18n/locales/en/common.json';
import zhCNCommon from '@/modules/i18n/locales/zh-CN/common.json';
import type * as SharedApiModule from '@/shared/api';
import { ArchitecturePanel } from '@/modules/architecture';
import type { ArchitectureGraphResult } from '@/modules/architecture';

/**
 * The compact (phone) architecture toolbar:
 *  · the whole chrome is ONE row — title, granularity switch, "…" — including
 *    the graph's own controls, which are portaled into that row's menu instead
 *    of taking a second diagram toolbar row;
 *  · that menu holds the hops switch, the honesty readings, export, and every
 *    zoom action;
 *  · a coarse pointer has no hover, so the hover readout is not rendered at
 *    all and the touch instruction is a dismissible one-off;
 *  · the hops options name themselves in words ("Hops 1" / 「跳数 1」) and carry
 *    the same words as their accessible name;
 *  · a real truncation still shows as a compact badge in the row while the menu
 *    is shut.
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

/** The single compact toolbar row, asserting there is exactly one. */
function toolbarRow(): HTMLElement {
  const rows = document.querySelectorAll('[data-architecture-toolbar]');
  assert.equal(rows.length, 1, 'the compact tier must spend exactly one row on chrome');
  const row = rows[0];
  assert.ok(row instanceof HTMLElement);
  return row;
}

/** The panel's own toolbar row (the desktop tier also has a graph toolbar row). */
function panelToolbar(): HTMLElement {
  const row = panelRoot().querySelector('[data-architecture-toolbar]');
  assert.ok(row instanceof HTMLElement);
  return row;
}

function openMenu(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  const menu = document.querySelector('[data-architecture-overflow-menu]');
  assert.ok(menu instanceof HTMLElement, 'the compact menu must open');
  return menu;
}

beforeEach(() => {
  apiMock.architectureGraph.mockReset();
  apiMock.architectureGraph.mockResolvedValue(jsonResponse(RESULT));
  setViewport(1024, 768);
  stubMatchMedia(() => false);
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  setViewport(originalInnerWidth, originalInnerHeight);
});

test('the compact tier spends its only toolbar row on the title, granularity and "…"', async () => {
  usePhone();
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  await waitForDiagram();

  const row = toolbarRow();
  assert.match(row.textContent ?? '', /Architecture/, 'the row carries the title');
  assert.ok(
    within(row).getByRole('group', { name: 'Graph granularity' }),
    'the granularity switch stays on the row',
  );
  assert.ok(within(row).getByRole('button', { name: 'More actions' }), 'the "…" toggle is the row\'s last entry');

  // The graph must not draw a second toolbar row of its own on this tier.
  assert.equal(
    graphRoot().querySelector('[data-architecture-overflow-toggle]'),
    null,
    'the graph must not repeat the toolbar row',
  );
  assert.equal(
    graphRoot().querySelector('[data-architecture-toolbar]'),
    null,
    'the graph renders no toolbar of its own in compact mode',
  );
  assert.equal(screen.queryByRole('button', { name: 'Zoom in' }), null, 'zoom waits inside the menu');
});

test('the "…" menu holds hops, the honesty readings, export and every zoom control', async () => {
  usePhone();
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  await waitForDiagram();

  const menu = openMenu();

  assert.ok(menu.querySelector('[data-architecture-honesty]'), 'the honesty readings live in the menu');
  const hops = menu.querySelector('[data-architecture-hops-control]');
  assert.ok(hops instanceof HTMLElement, 'the hops switch lives in the menu');
  assert.equal(hops.querySelectorAll('[data-architecture-hops-option]').length, 3);
  assert.ok(menu.querySelector('[data-architecture-overflow-export]'), 'export is reachable from the menu');

  for (const control of ['zoom-out', 'zoom-in', 'zoom-fit', 'zoom-actual']) {
    assert.ok(
      menu.querySelector(`[data-architecture-${control}]`),
      `the ${control} control must be in the menu`,
    );
  }

  // The portaled controls are the graph's real ones, not a copy: zooming from
  // the menu moves the same viewport scale the desktop toolbar drives.
  const before = Number(graphRoot().getAttribute('data-architecture-zoom-scale'));
  fireEvent.click(menu.querySelector('[data-architecture-zoom-in]') as Element);
  await waitFor(() => {
    assert.ok(
      Number(graphRoot().getAttribute('data-architecture-zoom-scale')) > before,
      'the menu zoom must reach the drawing',
    );
  });
  assert.equal(graphRoot().getAttribute('data-architecture-zoom-mode'), 'custom');
});

test('the menu hops switch names its options and re-requests the selected depth', async () => {
  usePhone();
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  await waitForDiagram();

  const menu = openMenu();
  const options = [...menu.querySelectorAll('[data-architecture-hops-option]')];
  assert.deepEqual(
    options.map((option) => option.getAttribute('data-architecture-hops-option')),
    ['1', '2', '3'],
  );
  for (const option of options) {
    const depth = option.getAttribute('data-architecture-hops-option');
    assert.equal(option.textContent, `Hops ${depth}`, 'the option must say what it counts');
    assert.equal(option.getAttribute('aria-label'), `Hops ${depth}`, 'the accessible name repeats it');
  }

  // The Chinese bundle is the wording the mobile review asked for.
  assert.equal(zhCNCommon.architecture.controls.hopOption, '跳数 {{count}}');

  fireEvent.click(options[2]);
  await waitFor(() => assert.equal(apiMock.architectureGraph.mock.calls.length, 2));
  assert.deepEqual(
    apiMock.architectureGraph.mock.calls[1],
    ['project-1', 'session-1', 3],
    'choosing "Hops 3" from the menu must re-request hops=3',
  );
});

test('a coarse pointer renders no hover hint, and the touch hint is dismissible', async () => {
  usePhone();
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  await waitForDiagram();

  assert.equal(
    document.querySelector('[data-architecture-hover]'),
    null,
    'a finger cannot hover, so the hover readout must not exist',
  );
  assert.equal(
    screen.queryByText(/Hover a node for its relation types/),
    null,
    'the contradictory hover instruction must not be rendered on a coarse pointer',
  );

  const hint = document.querySelector('[data-architecture-touch-hint]');
  assert.ok(hint instanceof HTMLElement, 'the touch instruction is shown once');
  const close = within(hint).getByRole('button', { name: 'Dismiss hint' });
  fireEvent.click(close);
  assert.equal(document.querySelector('[data-architecture-touch-hint]'), null, 'the hint is dismissible');
});

test('the touch hint is a row above the drawing, never an overlay on its top nodes', async () => {
  usePhone();
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  await waitForDiagram();

  const hint = document.querySelector('[data-architecture-touch-hint]');
  assert.ok(hint instanceof HTMLElement, 'the touch hint is on screen on first entry');

  // jsdom performs no layout, so overlap is read structurally: the hint must be
  // OUTSIDE the drawing surface, before it in document order, and in normal
  // flow. Any of those failing would put it back over the top node row.
  assert.equal(
    hint.closest('[data-architecture-plantuml]'),
    null,
    'the hint must not be rendered inside the drawing surface',
  );
  const drawing = graphRoot();
  const drawingRegion = drawing.parentElement;
  assert.ok(drawingRegion instanceof HTMLElement);
  assert.equal(
    hint.parentElement,
    drawingRegion.parentElement,
    'the hint and the drawing region are siblings in the panel column',
  );
  assert.ok(
    hint.compareDocumentPosition(drawingRegion) & Node.DOCUMENT_POSITION_FOLLOWING,
    'the hint comes before the drawing, so it cannot cover its top edge',
  );
  assert.doesNotMatch(
    hint.className,
    /(^|\s)(absolute|fixed|sticky)(\s|$)/,
    'the hint must stay in normal flow, not be positioned over the drawing',
  );
  assert.match(
    drawingRegion.className,
    /(^|\s)flex-1(\s|$)/,
    'the drawing still absorbs the remaining height of the panel',
  );

  // Its close target is a full 44×44 on a coarse pointer.
  const close = within(hint).getByRole('button', { name: 'Dismiss hint' });
  const style = getComputedStyle(close);
  assert.equal(style.minHeight, '44px', 'the dismiss target must be 44px tall');
  assert.equal(style.minWidth, '44px', 'the dismiss target must be 44px wide');
});

test('a truncated graph keeps a compact badge in the row while the menu is shut', async () => {  apiMock.architectureGraph.mockResolvedValue(jsonResponse(TRUNCATED_RESULT));
  usePhone();
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  await waitForDiagram();

  const row = toolbarRow();
  const badge = row.querySelector('[data-architecture-truncated-badge]');
  assert.ok(badge instanceof HTMLElement, 'a real cut must stay visible without opening the menu');
  assert.match(badge.textContent ?? '', /3\s*\/\s*9/, 'the badge states the retained and total counts');
  assert.equal(
    document.querySelector('[data-architecture-overflow-menu]'),
    null,
    'the badge is what makes the cut visible while the menu is shut',
  );

  // The full honesty reading (with the numbers) is in the menu as well.
  const menu = openMenu();
  const truncated = menu.querySelector('[data-architecture-truncated]');
  assert.ok(truncated instanceof HTMLElement);
  assert.equal(truncated.getAttribute('data-architecture-truncated-shown'), '3');
  assert.equal(truncated.getAttribute('data-architecture-truncated-total'), '9');
});

test('desktop keeps the hover readout and its multi-control header', async () => {
  // Deliberately the desktop setup from beforeEach (fine pointer, 1024px).
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  await waitForDiagram();

  const row = panelToolbar();
  assert.ok(row.querySelector('[data-architecture-hops-control]'), 'desktop keeps hops in the header');
  assert.ok(row.querySelector('[data-architecture-export]'), 'desktop keeps the export button in the header');
  assert.ok(document.querySelector('[data-architecture-honesty]'), 'desktop keeps the honesty bar');
  assert.equal(document.querySelector('[data-architecture-overflow-menu]'), null, 'desktop has no compact menu');
  assert.equal(document.querySelector('[data-architecture-touch-hint]'), null, 'desktop gets the hover wording');

  // The desktop graph toolbar is its own row (the pre-compact layout) and still
  // renders the zoom controls inline.
  const graphToolbar = graphRoot().querySelector('[data-architecture-toolbar]');
  assert.ok(graphToolbar instanceof HTMLElement);
  assert.ok(graphToolbar.querySelector('[data-architecture-zoom-in]'));
});
