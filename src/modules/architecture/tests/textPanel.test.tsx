import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, test, vi } from 'vitest';

import { ArchitecturePanel } from '@/modules/architecture';
import type { ArchitectureGraphResult } from '@/modules/architecture';
import {
  ArchitectureTextPanel,
  ArchitectureTextSyntaxBadge,
} from '@/modules/architecture/ArchitectureTextPanel';
import { buildPlantUmlText } from '@/modules/architecture/plantUmlText';
import type { ArchitectureDiagramView } from '@/modules/architecture/archguardToPlantUml';
import type {
  ArchitectureNodeIdShape,
  ArchitectureRendererGraph,
} from '@/modules/architecture/rendererContract';
import type { ArchitectureSelection } from '@/modules/architecture/selectionModel';
import enCommon from '@/modules/i18n/locales/en/common.json';
import type * as SharedApiModule from '@/shared/api';

/**
 * The dock's text page:
 *  · the dock gains a second tab, and the toolbar's `Text` entry opens it;
 *  · the three scopes change the document and its reading (whole graph,
 *    viewport intersection, selection +1);
 *  · only 300 lines reach the DOM while copy receives the whole document;
 *  · the 8k–30k band warns and the >30k band asks before "copy as session
 *    context";
 *  · the copied context carries project/session/time/scope/view/filter and a
 *    `plantuml` fence; a refusing clipboard falls back to a selected dialog;
 *  · an empty graph disables the actions; the syntax badge reports a pass or
 *    the first error's line.
 *
 * Most cases render the page directly (it is the component under test); the
 * dock-tab case renders the real panel + renderer so the registration itself is
 * pinned.
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

// jsdom ships no ResizeObserver; the renderer observes its scroll container.
class RecordingResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = RecordingResizeObserver as unknown as typeof ResizeObserver;

const originalMatchMedia = window.matchMedia;

function stubMatchMedia(): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
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

beforeAll(async () => {
  // Pay the one-off compiles outside the per-case budget: the renderer's ELK
  // engine for the dock-tab case, and the syntax checker's package entry.
  await import('@yalehwang/plantuml-js/elk');
  await import('@yalehwang/plantuml-js');
});

const ALPHA = 's1/src/modules/alpha/a.ts.Alpha';
const BETA = 's1/src/modules/alpha/b.ts.Beta';
const GAMMA = 's1/src/modules/beta/c.ts.Gamma';
const DELTA = 's1/src/modules/beta/d.ts.Delta';
const GENERATED_AT = '2026-10-22T00:00:00.000Z';

/** The unit fixture's chain: beta + one hop is alpha, beta and gamma. */
const BASE_GRAPH: ArchitectureRendererGraph = {
  nodes: [
    { id: ALPHA, label: 'Alpha', distance: 0, kind: 'class' },
    { id: BETA, label: 'Beta', distance: 1, kind: 'class' },
    { id: GAMMA, label: 'Gamma', distance: 2, kind: 'interface' },
    { id: DELTA, label: 'Delta', distance: 3, kind: 'enum' },
  ],
  edges: [
    { from: ALPHA, to: BETA, relationType: 'dependency' },
    { from: BETA, to: GAMMA, relationType: 'call' },
    { from: GAMMA, to: DELTA, relationType: 'inheritance' },
    { from: ALPHA, to: DELTA, relationType: 'composition' },
  ],
};

const ENTITY_OPTIONS = {
  view: { kind: 'hierarchy' } as const,
  grouping: 'raw' as const,
  idShape: 'scope-prefixed' as const,
};

function fullText(graph: ArchitectureRendererGraph = BASE_GRAPH): string {
  return buildPlantUmlText(graph, { kind: 'full' }, ENTITY_OPTIONS);
}

type PanelOverrides = {
  readonly graph?: ArchitectureRendererGraph;
  readonly selection?: ArchitectureSelection | null;
  readonly canvas?: HTMLElement;
  readonly idShape?: ArchitectureNodeIdShape;
  readonly view?: ArchitectureDiagramView;
  readonly granularity?: 'file' | 'entity';
};

/** Render the page directly, with a detached-but-queryable canvas reference. */
function renderTextPanel(overrides: PanelOverrides = {}) {
  const canvas = overrides.canvas ?? document.createElement('div');
  canvas.setAttribute('data-test-canvas', 'true');
  if (!canvas.isConnected) document.body.appendChild(canvas);
  const canvasRef = { current: canvas };
  const result = render(
    <ArchitectureTextPanel
      graph={overrides.graph ?? BASE_GRAPH}
      idShape={overrides.idShape ?? 'scope-prefixed'}
      granularity={overrides.granularity ?? 'entity'}
      view={overrides.view ?? { kind: 'hierarchy' }}
      grouping="raw"
      selection={overrides.selection ?? null}
      projectId="project-1"
      sessionId="session-1"
      analyzedAt={GENERATED_AT}
      viewLabel="Class diagram"
      filterSummary="7 functions hidden; relations: structural"
      canvasRef={canvasRef}
    />,
  );
  return { ...result, canvas };
}

function preview(): HTMLElement {
  const element = document.querySelector('[data-architecture-text-preview]');
  assert.ok(element instanceof HTMLElement, 'the preview must be on screen');
  return element;
}

function volumeCharacters(): number {
  const element = document.querySelector('[data-architecture-text-volume]');
  assert.ok(element instanceof HTMLElement, 'the volume reading must be on screen');
  return Number(element.getAttribute('data-architecture-text-characters'));
}

function installClipboard(writeText: (text: string) => Promise<void>): ReturnType<typeof vi.fn> {
  const mock = vi.fn(writeText);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: mock },
  });
  return mock;
}

const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;

beforeEach(() => {
  apiMock.architectureGraph.mockReset();
  stubMatchMedia();
  installClipboard(() => Promise.resolve());
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  for (const canvas of document.querySelectorAll('[data-test-canvas]')) canvas.remove();
});

/** A one-line label long enough to push the document into a token band. */
function longLabel(index: number, length: number): string {
  return `E${String(index)}-${'x'.repeat(length)}`;
}

function graphWithLongLabels(count: number, labelLength: number): ArchitectureRendererGraph {
  return {
    nodes: Array.from({ length: count }, (_unused, index) => ({
      id: `s1/src/modules/pkg/e${String(index)}.ts.${longLabel(index, labelLength)}`,
      label: longLabel(index, labelLength),
      distance: index,
      kind: 'class' as const,
    })),
    edges: [],
  };
}

test('the whole filtered graph is the default scope and its reading matches the document', async () => {
  renderTextPanel();
  // The first render builds synchronously, so the page never opens blank.
  assert.match(preview().textContent ?? '', /Alpha/);
  assert.match(preview().textContent ?? '', /Delta/);
  const expected = fullText();
  const characters = document.querySelector('[data-architecture-text-characters]');
  assert.equal(Number(characters?.getAttribute('data-architecture-text-characters')), expected.length);
  assert.equal(preview().textContent, expected);

  // plantuml-js's own checker agrees the generated document parses.
  await waitFor(() =>
    assert.equal(document.querySelector('[data-architecture-text-syntax]')?.getAttribute('data-architecture-text-syntax'), 'ok'),
  );
});

test('switching to the selection +1 scope shrinks the document and the reading', async () => {
  renderTextPanel({ selection: { kind: 'entity', nodeId: BETA } });
  const wideCharacters = volumeCharacters();
  assert.match(preview().textContent ?? '', /Delta/);

  fireEvent.click(document.querySelector('[data-architecture-text-scope-option="selection"]') as Element);

  await waitFor(() =>
    assert.ok(
      volumeCharacters() < wideCharacters,
      'the +1 document must be smaller than the whole graph',
    ),
  );
  assert.doesNotMatch(preview().textContent ?? '', /Delta/, 'delta is two hops from beta');
  assert.match(preview().textContent ?? '', /Alpha/);
  assert.match(preview().textContent ?? '', /Gamma/);
  assert.equal(
    document.querySelector('[data-architecture-text-scope-option="selection"]')?.getAttribute('aria-checked'),
    'true',
  );
  // A rebuild announces itself briefly beside the reading.
  await waitFor(() => assert.ok(document.querySelector('[data-architecture-text-updated]')));
});

test('the +1 scope is disabled with a stated reason while nothing is selected', () => {
  renderTextPanel();
  const option = document.querySelector('[data-architecture-text-scope-option="selection"]') as HTMLButtonElement;
  assert.equal(option.disabled, true);
  assert.ok(document.querySelector('[data-architecture-text-selection-disabled]'));
});

test('the viewport scope keeps only the nodes whose boxes intersect the canvas', async () => {
  const canvas = document.createElement('div');
  canvas.setAttribute('data-test-canvas', 'true');
  document.body.appendChild(canvas);
  const host = document.createElement('div');
  host.setAttribute('data-architecture-plantuml', 'true');
  for (const id of [ALPHA, BETA, GAMMA, DELTA]) {
    const node = document.createElement('span');
    node.className = 'uml-node';
    node.setAttribute('data-entity-id', id);
    host.appendChild(node);
  }
  canvas.appendChild(host);

  // jsdom lays nothing out, so state the boxes: alpha and beta are inside the
  // canvas, gamma and delta are far to the right.
  Element.prototype.getBoundingClientRect = function measured(this: Element): DOMRect {
    const box = (left: number, top: number): DOMRect => ({
      left,
      top,
      right: left + 10,
      bottom: top + 10,
      width: 10,
      height: 10,
      x: left,
      y: top,
      toJSON: () => ({}),
    } as DOMRect);
    if (this === host) return { ...box(0, 0), right: 100, bottom: 100, width: 100, height: 100 } as DOMRect;
    const id = this.getAttribute('data-entity-id');
    if (id === ALPHA) return box(5, 5);
    if (id === BETA) return box(20, 20);
    return box(500, 500);
  };

  renderTextPanel({ canvas });
  fireEvent.click(document.querySelector('[data-architecture-text-scope-option="viewport"]') as Element);

  await waitFor(
    () => {
      assert.match(preview().textContent ?? '', /Alpha/);
      assert.doesNotMatch(preview().textContent ?? '', /Gamma/);
    },
    { timeout: 3000 },
  );
  assert.match(preview().textContent ?? '', /Beta/);
  assert.doesNotMatch(preview().textContent ?? '', /Delta/);
});

test('more than 300 lines renders only the head, while copy receives the whole document', async () => {
  const graph: ArchitectureRendererGraph = {
    nodes: Array.from({ length: 400 }, (_unused, index) => ({
      id: `s1/src/modules/pkg${String(index)}/e.ts.E${String(index)}`,
      label: `E${String(index)}`,
      distance: index,
      kind: 'class' as const,
    })),
    edges: [],
  };
  const clipboard = installClipboard(() => Promise.resolve());
  renderTextPanel({ graph });

  const note = document.querySelector('[data-architecture-text-preview-note]');
  assert.ok(note !== null, 'a truncated preview must say so');
  assert.match(note.textContent ?? '', /Showing 300 of [\d,]+ lines/);
  assert.equal((preview().textContent ?? '').split('\n').length, 300);
  assert.doesNotMatch(preview().textContent ?? '', /E399/);
  assert.doesNotMatch(preview().textContent ?? '', /@enduml/);

  fireEvent.click(document.querySelector('[data-architecture-text-copy="all"]') as Element);
  await waitFor(() => assert.equal(clipboard.mock.calls.length, 1));
  const copied = String(clipboard.mock.calls[0][0]);
  assert.equal(copied, fullText(graph), 'copy must carry the full document, not the preview');
  assert.ok(copied.split('\n').length > 300);
  assert.match(copied, /E399/);
});

test('the 8k–30k band warns, and above 30k "copy as session context" asks first', async () => {
  // ~40 × (900-char label + class syntax) ≈ 10.5k tokens: the warning band.
  const large = graphWithLongLabels(40, 900);
  const { unmount } = renderTextPanel({ graph: large });
  await waitFor(() =>
    assert.equal(
      document.querySelector('[data-architecture-text-volume]')?.getAttribute('data-architecture-text-volume'),
      'large',
    ),
  );
  assert.ok(document.querySelector('[data-architecture-text-large-hint="large"]'));
  unmount();

  // ~200 × 900 chars ≈ 52k tokens: above the confirmation threshold.
  const huge = graphWithLongLabels(200, 900);
  const clipboard = installClipboard(() => Promise.resolve());
  renderTextPanel({ graph: huge });
  await waitFor(() =>
    assert.equal(
      document.querySelector('[data-architecture-text-volume]')?.getAttribute('data-architecture-text-volume'),
      'huge',
    ),
  );
  assert.ok(document.querySelector('[data-architecture-text-large-hint="huge"]'));

  fireEvent.click(document.querySelector('[data-architecture-text-copy="context"]') as Element);
  await waitFor(() => assert.ok(document.querySelector('[data-architecture-text-confirm]')));
  assert.equal(clipboard.mock.calls.length, 0, 'the clipboard is untouched until the reader confirms');

  fireEvent.click(document.querySelector('[data-architecture-text-confirm-copy]') as Element);
  await waitFor(() => assert.equal(clipboard.mock.calls.length, 1));
  assert.match(String(clipboard.mock.calls[0][0]), /^About the architecture diagram/);
});

test('copy as session context carries the header facts and a plantuml fence', async () => {
  const clipboard = installClipboard(() => Promise.resolve());
  renderTextPanel();
  fireEvent.click(document.querySelector('[data-architecture-text-copy="context"]') as Element);
  await waitFor(() => assert.equal(clipboard.mock.calls.length, 1));

  const copied = String(clipboard.mock.calls[0][0]);
  assert.match(copied, /^About the architecture diagram \(project project-1, session session-1, analysed at /);
  assert.match(copied, /; scope: Whole filtered graph; view: Class diagram; filter: 7 functions hidden; relations: structural\):/);
  assert.match(copied, /\n\n```plantuml\n@startuml\n/);
  assert.ok(copied.endsWith('@enduml\n```'), 'the document must be closed inside the fence');
  assert.ok(copied.includes(fullText()), 'the fenced body is the whole document');
});

test('a refusing clipboard falls back to a dialog with the text selected', async () => {
  installClipboard(() => Promise.reject(new Error('denied')));
  renderTextPanel();
  fireEvent.click(document.querySelector('[data-architecture-text-copy="all"]') as Element);

  await waitFor(() => assert.ok(document.querySelector('[data-architecture-text-fallback]')));
  const textarea = document.querySelector('[data-architecture-text-fallback-text]') as HTMLTextAreaElement;
  assert.equal(textarea.value, fullText());
  assert.equal(document.activeElement, textarea, 'the fallback opens with the text selected');

  fireEvent.click(document.querySelector('[data-architecture-text-fallback-close]') as Element);
  await waitFor(() => assert.equal(document.querySelector('[data-architecture-text-fallback]'), null));
});

test('an empty graph states so and disables every action', () => {
  renderTextPanel({ graph: { nodes: [], edges: [] } });
  assert.ok(document.querySelector('[data-architecture-text-empty]'));
  for (const selector of [
    '[data-architecture-text-copy="all"]',
    '[data-architecture-text-copy="context"]',
    '[data-architecture-text-download]',
  ]) {
    const button = document.querySelector(selector) as HTMLButtonElement;
    assert.equal(button.disabled, true, `${selector} must be disabled on an empty graph`);
  }
});

test('the syntax badge shows a pass, or the first error line and message', async () => {
  const valid = render(<ArchitectureTextSyntaxBadge text={'@startuml\nclass "A" as n0\n@enduml'} />);
  await waitFor(() =>
    assert.equal(document.querySelector('[data-architecture-text-syntax]')?.getAttribute('data-architecture-text-syntax'), 'ok'),
  );
  assert.match(document.querySelector('[data-architecture-text-syntax]')?.textContent ?? '', /Syntax OK/);
  valid.unmount();

  render(<ArchitectureTextSyntaxBadge text={'hello\nworld'} />);
  await waitFor(() =>
    assert.equal(document.querySelector('[data-architecture-text-syntax]')?.getAttribute('data-architecture-text-syntax'), 'error'),
  );
  const badge = document.querySelector('[data-architecture-text-syntax]');
  assert.equal(badge?.getAttribute('data-architecture-text-syntax-line'), '1');
  assert.match(badge?.textContent ?? '', /Line 1: content outside a @startuml\/@enduml block/);
});

/**
 * A minimal file-graph payload for the dock-tab case: one directory group, so
 * the real renderer draws quickly and `hasSeeds` is true (the dock exists).
 */
const FILE_RESULT: ArchitectureGraphResult = {
  mmd: { file: '@startuml\nA --> B\n@enduml', entity: '@startuml\nX --> Y\n@enduml' },
  graph: {
    file: {
      nodes: [
        { id: 'src/modules/alpha/a.ts', label: 'src/modules/alpha/a.ts', distance: 0 },
        { id: 'src/modules/alpha/a2.ts', label: 'src/modules/alpha/a2.ts', distance: 1 },
      ],
      edges: [{ from: 'src/modules/alpha/a2.ts', to: 'src/modules/alpha/a.ts', relationType: 'dependency' }],
    },
    entity: {
      nodes: [{ id: 's1/src/modules/alpha/A.ts.Alpha', label: 'Alpha', distance: 0, kind: 'class' }],
      edges: [],
    },
  },
  stats: {
    entityNodes: 1,
    fileNodes: 2,
    entityEdges: 0,
    fileEdges: 1,
    truncated: false,
    entityTruncated: false,
    fileTruncated: false,
    entityTotal: 1,
    fileTotal: 2,
    seedFiles: 1,
    seedIdentifiers: 1,
    nodeCount: 3,
    edgeCount: 1,
    unresolved: { files: [], identifiers: [] },
  },
  provenance: { generatedAt: GENERATED_AT, fingerprints: [], cacheHit: false },
};

test('the dock gains a second "Text" tab and the toolbar entry opens it', async () => {
  apiMock.architectureGraph.mockResolvedValue({ ok: true, status: 200, json: async () => FILE_RESULT } as unknown as Response);
  window.localStorage.clear();
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await screen.findByTestId('plantuml-host');
  await waitFor(() => assert.ok(host.querySelector('svg'), 'the renderer must draw an SVG'));
  assert.equal(document.querySelector('[data-architecture-dock]'), null, 'the dock starts closed');

  fireEvent.click(document.querySelector('[data-architecture-text-toggle]') as Element);
  await waitFor(() => assert.ok(document.querySelector('[data-architecture-dock]')));

  const tabs = [...document.querySelectorAll('[data-architecture-dock-tab]')];
  assert.deepEqual(
    tabs.map((tab) => tab.getAttribute('data-architecture-dock-tab')),
    ['inspector', 'text'],
    'the text page registers on the existing dock shell as its second tab',
  );
  assert.equal(tabs[1].textContent, 'Text');
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
  await waitFor(() => assert.ok(document.querySelector('[data-architecture-text-panel]')));

  // The inspector tab is still reachable and swaps the page back.
  fireEvent.click(tabs[0]);
  await waitFor(() => assert.equal(document.querySelector('[data-architecture-text-panel]'), null));
  assert.ok(document.querySelector('[data-architecture-dock-empty]'));
});
