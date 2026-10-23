import assert from 'node:assert/strict';

import type { ReactElement } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, test, vi } from 'vitest';

import enCommon from '@/modules/i18n/locales/en/common.json';
import type * as SharedApiModule from '@/shared/api';
import { ArchitecturePanel } from '@/modules/architecture';
import type { ArchitectureGraphResult } from '@/modules/architecture';
import type { ArchitectureRendererProps } from '@/modules/architecture/rendererContract';

/**
 * The architecture page's fullscreen criterion.
 *
 * The overlay is the SAME panel element restyled in place (`fixed; inset: 0`),
 * which is the only shape in which the drawing renderer keeps its zoom: a
 * portal or a second mount would restart every piece of renderer state. These
 * cases therefore read the panel's own node, not a new one:
 *
 *  · the toolbar button opens the overlay and the shell behind it becomes
 *    `inert`, while scope/filter/selection survive the toggle;
 *  · `F` toggles from the canvas and nowhere else;
 *  · a missing or rejecting `requestFullscreen` still opens the overlay;
 *  · Escape exits WITHOUT reaching a document-level listener (the chat page
 *    owns that key for aborting a run);
 *  · a native fullscreen exit from outside closes the overlay;
 *  · focus enters on the canvas and returns to the button;
 *  · a session switch and unmount both leave fullscreen.
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

const ENTITY_MMD = '@startuml\nX --> Y\n@enduml';
const FILE_MMD = '@startuml\nA --> B\n@enduml';

/** A small class neighbourhood: enough for a filter, a selection and a dock. */
const RESULT: ArchitectureGraphResult = {
  mmd: { file: FILE_MMD, entity: ENTITY_MMD },
  graph: {
    file: {
      nodes: [
        { id: 'src/a.ts', label: 'src/a.ts', distance: 0 },
        { id: 'src/b.ts', label: 'src/b.ts', distance: 1 },
      ],
      edges: [{ from: 'src/b.ts', to: 'src/a.ts', relationType: 'dependency' }],
    },
    entity: {
      nodes: [
        { id: 'src/a.ts.Alpha', label: 'Alpha', distance: 0 },
        { id: 'src/b.ts.Beta', label: 'Beta', distance: 1 },
      ],
      edges: [{ from: 'src/b.ts.Beta', to: 'src/a.ts.Alpha', relationType: 'dependency' }],
    },
  },
  stats: {
    entityNodes: 2,
    fileNodes: 2,
    entityEdges: 1,
    fileEdges: 1,
    truncated: false,
    entityTotal: 2,
    fileTotal: 2,
    seedFiles: 1,
    seedIdentifiers: 1,
    nodeCount: 4,
    edgeCount: 2,
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

/**
 * A substitute renderer that exposes the contract's selection door as a real
 * button. The fullscreen criterion is about the panel's state surviving the
 * toggle, not about ELK, so this keeps the cases about the overlay.
 */
function makeStandIn(): {
  StandIn: (props: ArchitectureRendererProps) => ReactElement;
  calls: ArchitectureRendererProps[];
} {
  const calls: ArchitectureRendererProps[] = [];
  function StandIn(props: ArchitectureRendererProps): ReactElement {
    calls.push(props);
    return (
      <div data-stand-in-renderer="true" data-stand-in-nodes={props.graph.nodes.length}>
        <button
          type="button"
          data-stand-in-select-first="true"
          onClick={() => props.onNodeClick?.(props.graph.nodes[0])}
        >
          select first
        </button>
      </div>
    );
  }
  return { StandIn, calls };
}

/** The harness's shell: the overlay must make these siblings inert. */
function renderPanel(overrides: { sessionId?: string; renderer?: (props: ArchitectureRendererProps) => ReactElement } = {}) {
  const standIn = makeStandIn();
  const result = render(
    <div data-app-shell="true">
      <aside data-testid="shell-sidebar" />
      <div>
        <ArchitecturePanel
          projectId="project-1"
          sessionId={overrides.sessionId ?? 'session-1'}
          initialGranularity="entity"
          renderer={overrides.renderer ?? standIn.StandIn}
        />
      </div>
      <header data-testid="shell-header" />
    </div>,
  );
  return { ...result, standIn };
}

function panelRoot(): HTMLElement {
  const panel = document.querySelector('[data-architecture-panel]');
  assert.ok(panel instanceof HTMLElement);
  return panel;
}

function canvasRegion(): HTMLElement {
  const region = document.querySelector('[data-architecture-canvas-region]');
  assert.ok(region instanceof HTMLElement);
  return region;
}

function fullscreenButton(): HTMLButtonElement {
  const button = document.querySelector('[data-architecture-fullscreen-toggle]');
  assert.ok(button instanceof HTMLButtonElement);
  return button;
}

function isFullscreen(): boolean {
  return panelRoot().getAttribute('data-architecture-fullscreen') === 'true';
}

async function waitForPanel(): Promise<void> {
  await waitFor(() => assert.ok(document.querySelector('[data-stand-in-renderer]')));
}

async function enterFullscreen(): Promise<void> {
  fireEvent.click(fullscreenButton());
  await waitFor(() => assert.equal(isFullscreen(), true));
}

beforeEach(() => {
  apiMock.architectureGraph.mockReset();
  apiMock.architectureGraph.mockResolvedValue(jsonResponse(RESULT));
  window.localStorage.removeItem('architecture.scope.project-1');
  window.localStorage.removeItem('architecture.detail.project-1');
  window.localStorage.removeItem('architecture.filter.project-1');
  // jsdom ships neither API; the cases that care install their own.
  delete (HTMLElement.prototype as unknown as { requestFullscreen?: unknown }).requestFullscreen;
  delete (document as unknown as { exitFullscreen?: unknown }).exitFullscreen;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as unknown as { requestFullscreen?: unknown }).requestFullscreen;
  delete (document as unknown as { exitFullscreen?: unknown }).exitFullscreen;
  delete (document as unknown as { fullscreenElement?: unknown }).fullscreenElement;
});

test('the toolbar button opens an in-place overlay and every panel reading survives', async () => {
  const { StandIn } = makeStandIn();
  renderPanel({ renderer: StandIn });
  await waitForPanel();

  // A scope move, a filter decision and a selected entity, all before entering.
  fireEvent.click(document.querySelector('[data-architecture-scope-increase]') as HTMLElement);
  await waitFor(() => assert.equal(
    document.querySelector('[data-architecture-scope-value]')?.getAttribute('data-architecture-scope-value'),
    '3',
  ));
  fireEvent.click(document.querySelector('[data-architecture-filter-toggle]') as HTMLElement);
  const callPreset = document.querySelector('[data-architecture-filter-relation="call"]');
  assert.ok(callPreset instanceof HTMLElement);
  fireEvent.click(callPreset);
  assert.equal(callPreset.getAttribute('aria-checked'), 'true');
  fireEvent.click(document.querySelector('[data-stand-in-select-first]') as HTMLElement);
  await waitFor(() => assert.ok(document.querySelector('[data-architecture-tray-pill]')));

  await enterFullscreen();

  // In place: the SAME panel element, now a viewport overlay.
  const panel = panelRoot();
  assert.equal(panel.style.position, 'fixed');
  // jsdom versions differ on whether `inset` survives as a longhand; the
  // serialized declaration is the stable reading.
  assert.match(panel.getAttribute('style') ?? '', /inset:\s*0/);
  assert.equal(panel.style.zIndex, '60');
  // The covered shell is inert, so focus cannot leave the overlay.
  assert.equal(screen.getByTestId('shell-sidebar').hasAttribute('inert'), true);
  assert.equal(screen.getByTestId('shell-header').hasAttribute('inert'), true);

  // Everything the reader set is still set — the toggle rebuilt nothing.
  assert.ok(within(panel).getByRole('button', { name: 'Exit fullscreen' }));
  assert.equal(
    document.querySelector('[data-architecture-scope-value]')?.getAttribute('data-architecture-scope-value'),
    '3',
  );
  assert.equal(
    document.querySelector('[data-architecture-filter-relation="call"]')?.getAttribute('aria-checked'),
    'true',
  );
  assert.ok(document.querySelector('[data-architecture-tray-pill]'));
  assert.ok(document.querySelector('[data-stand-in-renderer]'));

  // Focus is on the drawing, ready for the canvas shortcuts.
  assert.equal(document.activeElement, canvasRegion());
});

test('F toggles from the canvas, and typing f elsewhere does not', async () => {
  renderPanel();
  await waitForPanel();

  fireEvent.keyDown(canvasRegion(), { key: 'f' });
  await waitFor(() => assert.equal(isFullscreen(), true));
  fireEvent.keyDown(canvasRegion(), { key: 'f' });
  await waitFor(() => assert.equal(isFullscreen(), false));

  // The search box is chrome, not the canvas: `f` is just a letter there.
  const search = document.querySelector('[data-architecture-search] input, input[data-architecture-search]');
  assert.ok(search instanceof HTMLInputElement);
  search.focus();
  fireEvent.keyDown(search, { key: 'f' });
  assert.equal(isFullscreen(), false);
});

test('a missing or rejecting requestFullscreen still opens the overlay, silently', async () => {
  // jsdom has no API at all: the overlay alone is the fallback.
  renderPanel();
  await waitForPanel();
  await enterFullscreen();
  assert.equal(isFullscreen(), true);
  fireEvent.click(fullscreenButton());
  await waitFor(() => assert.equal(isFullscreen(), false));

  // A rejecting promise (the iOS Safari shape) is the same fallback.
  const request = vi.fn(() => Promise.reject(new Error('denied')));
  Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
    configurable: true,
    writable: true,
    value: request,
  });
  await enterFullscreen();
  assert.equal(isFullscreen(), true);
  assert.equal(request.mock.calls.length, 1, 'the desktop tier asks the browser once');

  // A synchronous throw (older engines) is handled the same way.
  fireEvent.click(fullscreenButton());
  await waitFor(() => assert.equal(isFullscreen(), false));
  Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
    configurable: true,
    writable: true,
    value: vi.fn(() => {
      throw new Error('not allowed');
    }),
  });
  await enterFullscreen();
  assert.equal(isFullscreen(), true);
});

test('Escape exits the overlay and never reaches a document listener', async () => {
  renderPanel();
  await waitForPanel();
  await enterFullscreen();

  const onDocument = vi.fn();
  document.addEventListener('keydown', onDocument);
  fireEvent.keyDown(canvasRegion(), { key: 'Escape' });
  await waitFor(() => assert.equal(isFullscreen(), false));
  document.removeEventListener('keydown', onDocument);

  assert.equal(onDocument.mock.calls.length, 0, 'Escape must not bubble past the overlay');
  // Focus returns to the control that opened it.
  assert.equal(document.activeElement, fullscreenButton());
});

test('a native fullscreen exit from outside closes the overlay too', async () => {
  let fullscreenElement: Element | null = null;
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => fullscreenElement,
  });
  const request = vi.fn(() => {
    fullscreenElement = document.querySelector('[data-architecture-panel]');
    return Promise.resolve();
  });
  Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
    configurable: true,
    writable: true,
    value: request,
  });
  Object.defineProperty(document, 'exitFullscreen', {
    configurable: true,
    writable: true,
    value: vi.fn(() => Promise.resolve()),
  });

  renderPanel();
  await waitForPanel();
  await enterFullscreen();
  // Let the request's promise mark the native session as live.
  await act(async () => {
    await Promise.resolve();
  });

  // The reader leaves through the browser's own affordance.
  fullscreenElement = null;
  act(() => {
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  await waitFor(() => assert.equal(isFullscreen(), false));
});

test('a session switch and an unmount both leave fullscreen', async () => {
  const { StandIn } = makeStandIn();
  const exitFullscreen = vi.fn(() => Promise.resolve());
  Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
    configurable: true,
    writable: true,
    value: vi.fn(() => Promise.resolve()),
  });
  Object.defineProperty(document, 'exitFullscreen', {
    configurable: true,
    writable: true,
    value: exitFullscreen,
  });
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => document.body,
  });

  const { rerender } = render(
    <div data-app-shell="true">
      <div>
        <ArchitecturePanel
          projectId="project-1"
          sessionId="session-1"
          initialGranularity="entity"
          renderer={StandIn}
        />
      </div>
    </div>,
  );
  await waitForPanel();

  await enterFullscreen();
  rerender(
    <div data-app-shell="true">
      <div>
        <ArchitecturePanel
          projectId="project-1"
          sessionId="session-2"
          initialGranularity="entity"
          renderer={StandIn}
        />
      </div>
    </div>,
  );
  await waitFor(() => assert.equal(isFullscreen(), false));

  await enterFullscreen();
  rerender(<div data-app-shell="true" />);
  assert.equal(document.querySelector('[data-architecture-panel]'), null);
  await waitFor(() => assert.ok(exitFullscreen.mock.calls.length >= 1));
});
