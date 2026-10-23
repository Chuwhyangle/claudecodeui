import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { applyView, renderDetailed, toPlantUml } from '@yalehwang/plantuml-js';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, test, vi } from 'vitest';

import { ArchitecturePanel } from '@/modules/architecture';
import type { ArchitectureGraphResult } from '@/modules/architecture';
import { ArchitectureSelectionTray } from '@/modules/architecture/ArchitectureSelectionTray';
import {
  archguardToPlantUml,
  parserSafePlantUml,
} from '@/modules/architecture/archguardToPlantUml';
import { renderWithMemberDetail } from '@/modules/architecture/PlantUmlGraph';
import {
  buildPlantUmlText,
  measurePlantUmlText,
  standardiseDrawnStereotypes,
} from '@/modules/architecture/plantUmlText';
import type { ArchitectureDrawnPlantUml } from '@/modules/architecture/rendererContract';
import { selectionKey, resolveDraftScope, type ArchitectureSelection } from '@/modules/architecture/selectionModel';
import enCommon from '@/modules/i18n/locales/en/common.json';
import type * as SharedApiModule from '@/shared/api';
import { readDraftText, resetChatDrafts, writeDraftText } from '@/shared/chatDrafts';

/**
 * The multi-select canvas and its selection tray.
 *
 * The cases render the REAL panel with the real PlantUML/ELK renderer and stub
 * only the network, the same seam the other architecture suites use. They pin:
 *  · Shift/Ctrl clicks and the Shift+drag marquee build a SET (a plain click
 *    still replaces it, and a plain drag still pans);
 *  · a touch long-press enters the multi-select mode;
 *  · the tray's tags, the 20-tag fold and the 300-entity attachment guard;
 *  · Escape collapses the tray before clearing the selection and never reaches
 *    the chat page's global abort;
 *  · the primary action APPENDS the fixed-format text to the session's chat
 *    draft, switches to Chat, focuses the composer, and toasts the right
 *    wording — it never sends.
 */

const apiMock = vi.hoisted(() => ({
  architectureGraph: vi.fn(),
  architectureMentions: vi.fn(),
  architectureSearch: vi.fn(),
}));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApiModule>();
  return {
    ...actual,
    api: {
      ...actual.api,
      architectureGraph: apiMock.architectureGraph,
      architectureMentions: apiMock.architectureMentions,
      architectureSearch: apiMock.architectureSearch,
    },
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

class RecordingResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = RecordingResizeObserver as unknown as typeof ResizeObserver;

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

const originalMatchMedia = window.matchMedia;
const originalInnerWidth = window.innerWidth;
const originalInnerHeight = window.innerHeight;

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
  setViewport(390, 844);
  stubMatchMedia((query) => query === '(pointer: coarse)' || query === '(pointer: coarse) and (hover: none)');
}

beforeAll(async () => {
  await import('@yalehwang/plantuml-js/elk');
});

const ALPHA = 's1/src/modules/alpha/A.ts.Alpha';
const BETA = 's1/src/modules/alpha/B.ts.Beta';
const GAMMA = 's1/src/modules/beta/C.ts.Gamma';
const EDGE_BETA_TO_ALPHA = { from: BETA, to: ALPHA, relationType: 'dependency' } as const;

const RESULT: ArchitectureGraphResult = {
  mmd: { file: '@startuml\nA --> B\n@enduml', entity: '@startuml\nX --> Y\n@enduml' },
  graph: {
    file: {
      nodes: [
        { id: 'src/modules/alpha/A.ts', label: 'A.ts', distance: 0 },
        { id: 'src/modules/alpha/B.ts', label: 'B.ts', distance: 1 },
      ],
      edges: [{ from: 'src/modules/alpha/B.ts', to: 'src/modules/alpha/A.ts', relationType: 'dependency' }],
    },
    entity: {
      nodes: [
        { id: ALPHA, label: 'Alpha', distance: 0, kind: 'class' },
        { id: BETA, label: 'Beta', distance: 1, kind: 'interface' },
        { id: GAMMA, label: 'Gamma', distance: 2, kind: 'class' },
      ],
      edges: [EDGE_BETA_TO_ALPHA, { from: GAMMA, to: BETA, relationType: 'call' }],
    },
  },
  stats: {
    entityNodes: 3,
    fileNodes: 2,
    entityEdges: 2,
    fileEdges: 1,
    truncated: false,
    entityTotal: 3,
    fileTotal: 2,
    seedFiles: 1,
    seedIdentifiers: 1,
    nodeCount: 5,
    edgeCount: 3,
    unresolved: { files: [], identifiers: [] },
  },
  provenance: { generatedAt: '2026-10-22T00:00:00.000Z', fingerprints: [], cacheHit: false },
};

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

/**
 * State the "show everything" filter explicitly. The shipped default hides
 * `call` edges and the nodes they leave isolated, so the fixture's Gamma (a
 * call-only leaf) would not be drawn; these cases are about selecting what IS
 * drawn, including every node of the fixture.
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

async function waitForDiagram(): Promise<HTMLElement> {
  const host = await screen.findByTestId('plantuml-host');
  await waitFor(() => assert.ok(host.querySelector('svg'), 'the renderer must draw an SVG'));
  return host;
}

function node(host: HTMLElement, id: string): Element {
  const element = host.querySelector(`[data-entity-id="${id}"]`);
  assert.ok(element !== null, `node ${id} must be drawn`);
  return element;
}

/** One finger press, lifted and finished with the click a browser would send. */
function tap(target: Element, clientX = 40, clientY = 40): void {
  fireEvent.pointerDown(target, { pointerId: 1, pointerType: 'touch', clientX, clientY });
  fireEvent.pointerUp(target, { pointerId: 1, pointerType: 'touch', clientX, clientY });
  fireEvent.click(target);
}

function trayItems(): Element[] {
  return [...document.querySelectorAll('[data-architecture-tray-item]')];
}

/** The number of selected things, readable while the tray is still a pill. */
function selectedCount(): number {
  const root = document.querySelector('[data-architecture-tray-root]');
  return Number(root?.getAttribute('data-architecture-tray-selected') ?? 0);
}

/** The tags in the EXPANDED tray (zero while it is collapsed). */
function expandTray(): void {
  fireEvent.click(document.querySelector('[data-architecture-tray-pill]') as Element);
}

beforeEach(() => {
  apiMock.architectureGraph.mockReset();
  apiMock.architectureGraph.mockResolvedValue(jsonResponse(RESULT));
  apiMock.architectureMentions.mockReset();
  apiMock.architectureMentions.mockResolvedValue(jsonResponse({ mentions: [], truncated: false }));
  apiMock.architectureSearch.mockReset();
  apiMock.architectureSearch.mockResolvedValue(jsonResponse({ resolved: [] }));
  for (const projectId of ['project-1', 'project-2']) {
    window.localStorage.removeItem(`architecture.scope.${projectId}`);
    window.localStorage.removeItem(`architecture.detail.${projectId}`);
    window.localStorage.removeItem(`architecture.filter.${projectId}`);
    window.localStorage.removeItem(`architecture.dock.open`);
  }
  localStorage.clear();
  resetChatDrafts();
  rememberShowAllFilter();
  setViewport(1024, 768);
  stubMatchMedia(() => false);
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  setViewport(originalInnerWidth, originalInnerHeight);
  vi.useRealTimers();
});

test('Shift/Ctrl clicks build a set, a plain click replaces it, and the live region announces the count', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  const host = await waitForDiagram();

  fireEvent.click(node(host, ALPHA), { shiftKey: true });
  fireEvent.click(node(host, BETA), { ctrlKey: true });
  const edgeHit = host.querySelector(
    `[data-architecture-edge-hit][data-architecture-edge-source="${BETA}"][data-architecture-edge-target="${ALPHA}"]`,
  );
  assert.ok(edgeHit !== null, 'the relation carries an enlarged hit band');
  fireEvent.click(edgeHit, { shiftKey: true });

  await waitFor(() => assert.equal(selectedCount(), 3, 'two entities and one relation are selected'));
  expandTray();
  assert.deepEqual(
    trayItems().map((item) => item.getAttribute('data-architecture-tray-item-kind')),
    ['entity', 'entity', 'relation'],
  );
  const live = document.querySelector('[data-architecture-tray-live]');
  assert.match(live?.textContent ?? '', /3 elements selected/, 'count changes are announced politely');

  // Ctrl+click on an already selected member removes it.
  fireEvent.click(node(host, BETA), { ctrlKey: true });
  await waitFor(() => assert.equal(selectedCount(), 2));

  // A plain click keeps the single-selection contract: it replaces the set.
  fireEvent.click(node(host, GAMMA));
  await waitFor(() => assert.equal(selectedCount(), 1, 'a plain click replaces the selection'));
  assert.equal(trayItems()[0]?.getAttribute('data-architecture-tray-item-kind'), 'entity');
});

test('a tag × removes exactly that member', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  const host = await waitForDiagram();

  fireEvent.click(node(host, ALPHA), { shiftKey: true });
  fireEvent.click(node(host, BETA), { shiftKey: true });
  await waitFor(() => assert.equal(selectedCount(), 2));

  fireEvent.click(document.querySelector('[data-architecture-tray-pill]') as Element);
  const remove = document.querySelector(`[data-architecture-tray-remove="${selectionKey({ kind: 'entity', nodeId: ALPHA })}"]`);
  assert.ok(remove !== null, 'each tag carries its own deselect control');
  fireEvent.click(remove);
  await waitFor(() => assert.equal(selectedCount(), 1));
  assert.equal(
    trayItems()[0]?.getAttribute('data-architecture-tray-item'),
    selectionKey({ kind: 'entity', nodeId: BETA }),
  );
});

/** Pin a deterministic client rectangle on a drawn element (jsdom has no layout). */
function stubRect(
  element: Element,
  rect: { left: number; top: number; right: number; bottom: number },
): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      ...rect,
      x: rect.left,
      y: rect.top,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
      toJSON: () => ({}),
    }),
  });
}

function stubDrawnRects(host: HTMLElement): void {
  stubRect(node(host, ALPHA), { left: 10, top: 10, right: 80, bottom: 60 });
  stubRect(node(host, BETA), { left: 100, top: 10, right: 170, bottom: 60 });
  stubRect(node(host, GAMMA), { left: 400, top: 400, right: 470, bottom: 450 });
  const edgeHit = host.querySelector('[data-architecture-edge-hit]');
  assert.ok(edgeHit !== null);
  stubRect(edgeHit, { left: 60, top: 100, right: 120, bottom: 104 });
}

test('Shift+drag is a marquee: it selects the drawn nodes and relations it intersects', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  const host = await waitForDiagram();
  stubDrawnRects(host);

  fireEvent.pointerDown(host, {
    pointerId: 5, pointerType: 'mouse', button: 0, shiftKey: true, clientX: 0, clientY: 0,
  });
  fireEvent.pointerMove(window, { pointerId: 5, clientX: 200, clientY: 200 });
  assert.ok(document.querySelector('[data-architecture-marquee]') !== null, 'the marquee is drawn while dragging');
  fireEvent.pointerUp(window, { pointerId: 5, clientX: 200, clientY: 200 });

  await waitFor(() => assert.equal(selectedCount(), 3, 'both nodes and the edge inside the rectangle are selected'));
  expandTray();
  assert.deepEqual(
    trayItems().map((item) => item.getAttribute('data-architecture-tray-item-kind')),
    ['entity', 'entity', 'relation'],
  );
  assert.equal(document.querySelector('[data-architecture-marquee]'), null, 'the marquee leaves with the gesture');
});

test('a plain drag still pans and never fires the marquee', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  const host = await waitForDiagram();
  stubDrawnRects(host);

  fireEvent.pointerDown(host, { pointerId: 6, pointerType: 'mouse', button: 0, clientX: 300, clientY: 300 });
  fireEvent.pointerMove(window, { pointerId: 6, clientX: 250, clientY: 280 });

  assert.equal(host.scrollLeft, 50, 'the drawing follows the pointer horizontally');
  assert.equal(host.scrollTop, 20, 'the drawing follows the pointer vertically');
  assert.equal(document.querySelector('[data-architecture-marquee]'), null, 'a plain drag is a pan, not a marquee');
  assert.equal(selectedCount(), 0, 'panning must not select anything');
  fireEvent.pointerUp(window, { pointerId: 6, clientX: 250, clientY: 280 });
});

test('a 500ms touch press enters multi-select, and the following taps toggle', async () => {
  usePhone();
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  const host = await waitForDiagram();

  vi.useFakeTimers();
  fireEvent.pointerDown(node(host, ALPHA), { pointerId: 1, pointerType: 'touch', clientX: 40, clientY: 40 });
  act(() => {
    vi.advanceTimersByTime(500);
  });
  vi.useRealTimers();
  fireEvent.pointerUp(node(host, ALPHA), { pointerId: 1, pointerType: 'touch', clientX: 40, clientY: 40 });
  // The browser's trailing click after a long press must not undo the toggle.
  fireEvent.click(node(host, ALPHA));

  await waitFor(() => assert.ok(document.querySelector('[data-architecture-multiselect-bar]') !== null, 'the multi-select bar appears'));
  assert.equal(selectedCount(), 1, 'the long-pressed node is the first member');
  assert.match(
    document.querySelector('[data-architecture-multiselect-bar]')?.textContent ?? '',
    /Multi-select · 1 selected/,
  );

  // Now a plain tap toggles (does not replace), and tapping the same node again
  // removes it.
  tap(node(host, BETA));
  await waitFor(() => assert.equal(selectedCount(), 2));
  tap(node(host, ALPHA));
  await waitFor(() => assert.equal(selectedCount(), 1));

  fireEvent.click(document.querySelector('[data-architecture-multiselect-done]') as Element);
  assert.equal(document.querySelector('[data-architecture-multiselect-bar]'), null, 'Done leaves the mode');
  assert.equal(selectedCount(), 1, 'Done keeps the selection');
});

test('Escape collapses the expanded tray first, then clears the selection, and never reaches the global abort', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  const host = await waitForDiagram();
  fireEvent.click(node(host, ALPHA), { shiftKey: true });
  fireEvent.click(node(host, BETA), { shiftKey: true });
  await waitFor(() => assert.equal(selectedCount(), 2));
  fireEvent.click(document.querySelector('[data-architecture-tray-pill]') as Element);
  assert.ok(document.querySelector('[data-architecture-tray-expanded-panel]') !== null);

  const globalKeys = vi.fn();
  document.addEventListener('keydown', globalKeys);
  try {
    // The rewritten contract (was: "the selection survives the dock closing"):
    // closing the dock also clears the selection, so the dimming and highlight
    // cannot outlive the inspector that explained them. Escape's order stays
    // tray-expanded → dock, and it never reaches the page abort.
    fireEvent.keyDown(host, { key: 'Escape' });
    await waitFor(() => assert.equal(
      document.querySelector('[data-architecture-tray-expanded-panel]'),
      null,
      'the first Escape collapses the tray',
    ));
    assert.equal(selectedCount(), 2, 'the selection survives the collapse');

    fireEvent.keyDown(host, { key: 'Escape' });
    await waitFor(() => assert.equal(
      document.querySelector('[data-architecture-dock]'),
      null,
      'the next Escape closes the dock',
    ));
    await waitFor(() => assert.equal(selectedCount(), 0, 'and closing the dock clears the selection with it'));
    assert.equal(
      document.querySelector('[data-architecture-tray-pill]'),
      null,
      'so no selection tray is left behind',
    );
    assert.equal(globalKeys.mock.calls.length, 0, `Escape must not reach the chat abort (calls: ${String(globalKeys.mock.calls.length)})`);
  } finally {
    document.removeEventListener('keydown', globalKeys);
  }
});

async function selectAlphaAndBeta(host: HTMLElement): Promise<void> {
  fireEvent.click(node(host, ALPHA), { shiftKey: true });
  fireEvent.click(node(host, BETA), { shiftKey: true });
  await waitFor(() => assert.equal(selectedCount(), 2));
  fireEvent.click(document.querySelector('[data-architecture-tray-pill]') as Element);
  assert.ok(document.querySelector('[data-architecture-tray-expanded-panel]') !== null);
}

test('the primary action appends the fixed-format text to the session draft, opens chat and focuses the input', async () => {
  const onOpenChat = vi.fn();
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" onOpenChat={onOpenChat} />);
  const host = await waitForDiagram();
  await selectAlphaAndBeta(host);
  // Include one relation so the fixed format's relation line is exercised.
  const edgeHit = host.querySelector(
    `[data-architecture-edge-hit][data-architecture-edge-source="${BETA}"][data-architecture-edge-target="${ALPHA}"]`,
  );
  assert.ok(edgeHit !== null);
  fireEvent.click(edgeHit, { shiftKey: true });
  await waitFor(() => assert.equal(selectedCount(), 3));

  // The composer's own textarea, addressed through the documented slot.
  const composer = document.createElement('textarea');
  composer.setAttribute('data-slot', 'prompt-input-textarea');
  document.body.appendChild(composer);

  const textarea = document.querySelector('[data-architecture-tray-input]') as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: '请解释这两个类的关系' } });
  fireEvent.click(document.querySelector('[data-architecture-tray-compose]') as Element);

  await waitFor(() => assert.ok(readDraftText('session-1').startsWith('About these elements in the architecture diagram')));
  const draft = readDraftText('session-1');
  assert.equal(readDraftText('project:project-1'), '', 'the session scope is the one the composer reads');
  assert.match(draft, /\(project project-1, analyzed /, 'the header names the project and the analysis time');
  assert.match(draft, /- class `Alpha` \(src\/modules\/alpha\/A\.ts\)/, 'entities are a kind, a name and a file');
  assert.match(draft, /- interface `Beta` \(src\/modules\/alpha\/B\.ts\)/);
  assert.match(
    draft,
    /- Relation: `Beta` \.\.> `Alpha` \(dependency\)/,
    'a relation line uses the bridge’s own arrow and its translated kind',
  );
  assert.match(draft, /\n请解释这两个类的关系$/, 'the reader’s own text follows the bullets');
  assert.ok(!draft.includes('```plantuml'), 'no fence unless the attachment is checked');
  assert.equal(onOpenChat.mock.calls.length, 1, 'the workspace switches to Chat');

  await waitFor(() => assert.equal(document.activeElement, composer, 'the composer receives focus'));
  const toast = document.querySelector('[data-architecture-curation-toast-message]');
  assert.equal(toast?.textContent, 'Put in the input box', 'an empty draft reads as "put in"');
  composer.remove();
});

/** The header line of the composed message, without relying on the rest of it. */
function messageHeader(draft: string): string {
  return draft.split('\n')[0] ?? '';
}

test('the message header names the project display name, never its UUID', async () => {
  // The id the panel is keyed by is opaque; the header must read the way the
  // workspace labels the project, exactly as the text page's header does.
  const projectUuid = 'b0a96771-c926-468a-bf18-09a5b3708039';
  render(
    <ArchitecturePanel
      projectId={projectUuid}
      sessionId="session-1"
      projectName="claudecodeui"
    />,
  );
  const host = await waitForDiagram();
  await selectAlphaAndBeta(host);
  fireEvent.click(document.querySelector('[data-architecture-tray-compose]') as Element);

  await waitFor(() => assert.ok(readDraftText('session-1') !== ''));
  const draft = readDraftText('session-1');
  assert.match(messageHeader(draft), /project claudecodeui/, 'the header names the display name');
  assert.doesNotMatch(draft, /[0-9a-f]{8}-[0-9a-f]{4}-/, 'no UUID-shaped id appears anywhere in the message');
  assert.match(messageHeader(draft), /analyzed /, 'the analysis time stays');
});

test('each selected entity lists its relations to the other selected entities', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" projectName="claudecodeui" />);
  const host = await waitForDiagram();

  // Alpha and Beta are joined by a dependency edge (Beta → Alpha).
  await selectAlphaAndBeta(host);
  fireEvent.click(document.querySelector('[data-architecture-tray-compose]') as Element);
  await waitFor(() => assert.ok(readDraftText('session-1') !== ''));
  const related = readDraftText('session-1');
  assert.match(related, /^\s+- Alpha ← Beta \(dependency\)$/m, 'the target states its incoming relation');
  assert.match(related, /^\s+- Beta → Alpha \(dependency\)$/m, 'the source states its outgoing relation');

  // Alpha and Gamma have NO drawn edge between them (Gamma only calls Beta),
  // so neither entity carries a relation line.
  resetChatDrafts();
  fireEvent.click(document.querySelector(`[data-architecture-tray-remove="${selectionKey({ kind: 'entity', nodeId: BETA })}"]`) as Element);
  await waitFor(() => assert.equal(selectedCount(), 1));
  fireEvent.click(node(host, GAMMA), { shiftKey: true });
  await waitFor(() => assert.equal(selectedCount(), 2));
  fireEvent.click(document.querySelector('[data-architecture-tray-compose]') as Element);
  await waitFor(() => assert.ok(readDraftText('session-1') !== ''));
  assert.doesNotMatch(
    readDraftText('session-1'),
    /Alpha (←|→) Gamma|Gamma (←|→) Alpha/,
    'unrelated selected entities carry no relation line',
  );
});

test('the collapsed pill names the action, not only the count', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  const host = await waitForDiagram();
  fireEvent.click(node(host, ALPHA), { shiftKey: true });
  fireEvent.click(node(host, BETA), { shiftKey: true });
  await waitFor(() => assert.equal(selectedCount(), 2));

  const pill = document.querySelector('[data-architecture-tray-pill]');
  assert.ok(pill !== null);
  assert.match(pill.textContent ?? '', /2 selected · Send to chat ▴/, 'the pill states the action');
});

test('a non-empty draft is appended after a blank line and gets the appended wording', async () => {
  writeDraftText('session-1', 'already half-typed');
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  const host = await waitForDiagram();
  await selectAlphaAndBeta(host);

  fireEvent.click(document.querySelector('[data-architecture-tray-compose]') as Element);

  await waitFor(() => assert.ok(readDraftText('session-1').startsWith('already half-typed\n\nAbout these elements')));
  const toast = document.querySelector('[data-architecture-curation-toast-message]');
  assert.equal(toast?.textContent, 'Appended to the input box');
  assert.equal(
    readDraftText('session-1').split('already half-typed').length,
    2,
    'the original text is kept exactly once, at the front',
  );
});

test('checking the attachment appends the selected subgraph as a PlantUML fence with a volume reading', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  const host = await waitForDiagram();
  await selectAlphaAndBeta(host);

  fireEvent.click(document.querySelector('[data-architecture-tray-attach]') as Element);
  const volume = await waitFor(() => {
    const reading = document.querySelector('[data-architecture-tray-volume]');
    assert.ok(reading !== null, 'the volume reading appears with the attachment');
    return reading;
  });
  assert.ok(Number(volume.getAttribute('data-architecture-tray-volume')) > 0);
  assert.equal(document.querySelectorAll('[data-architecture-tray-scope] option').length, 2);

  fireEvent.click(document.querySelector('[data-architecture-tray-compose]') as Element);
  await waitFor(() => assert.match(readDraftText('session-1'), /```plantuml[\s\S]*@startuml[\s\S]*@enduml/));
});

function trayGraphWith(count: number) {
  return {
    nodes: Array.from({ length: count }, (_unused, index) => ({
      id: `s1/src/e/E${index}.ts.E${index}`,
      label: `E${index}`,
      distance: index,
      kind: 'class' as const,
    })),
    edges: [],
  };
}

function entitySelections(count: number): ArchitectureSelection[] {
  return Array.from({ length: count }, (_unused, index) => ({
    kind: 'entity' as const,
    nodeId: `s1/src/e/E${index}.ts.E${index}`,
  }));
}

test('more than 20 tags fold into "…and N more"; more than 300 entities disable the attachment with the reason', async () => {
  const selections = entitySelections(301);
  render(
    <ArchitectureSelectionTray
      selections={selections}
      graph={trayGraphWith(301)}
      idShape="scope-prefixed"
      view={{ kind: 'overview' }}
      grouping="raw"
      drawn={null}
      projectId="project-1"
      analyzedAt="2026-10-22T00:00:00.000Z"
      canCompose
      canRemove
      multiSelect={false}
      expanded
      compact={false}
      onExpandedChange={() => undefined}
      onExitMultiSelect={() => undefined}
      onToggleItem={() => undefined}
      onClear={() => undefined}
      onCompose={() => undefined}
      onRemoveSelected={() => undefined}
    />,
  );

  assert.equal(document.querySelectorAll('[data-architecture-tray-item]').length, 20, 'only the first 20 tags are drawn');
  assert.equal(
    document.querySelector('[data-architecture-tray-more]')?.textContent,
    '…and 281 more',
  );
  const attach = document.querySelector('[data-architecture-tray-attach]') as HTMLInputElement;
  assert.equal(attach.disabled, true, 'the attachment is disabled above the entity limit');
  assert.match(
    document.querySelector('[data-architecture-tray-attach-disabled="too-many"]')?.textContent ?? '',
    /301 entities are selected \(limit 300\)/,
  );
});

test('the draft scope follows the composer: the session, or the project for a new chat', () => {
  assert.equal(resolveDraftScope('project-1', 'session-1'), 'session-1');
  assert.equal(
    resolveDraftScope('project-1', null),
    'project:project-1',
    'a chat with no session yet is stored under its project, the same key the composer uses',
  );
});

test('without a session the compose action is disabled and says why', () => {
  render(
    <ArchitectureSelectionTray
      selections={entitySelections(1)}
      graph={trayGraphWith(1)}
      idShape="scope-prefixed"
      view={{ kind: 'overview' }}
      grouping="raw"
      drawn={null}
      projectId="project-1"
      analyzedAt={null}
      canCompose={false}
      canRemove={false}
      multiSelect={false}
      expanded
      compact={false}
      onExpandedChange={() => undefined}
      onExitMultiSelect={() => undefined}
      onToggleItem={() => undefined}
      onClear={() => undefined}
      onCompose={() => undefined}
      onRemoveSelected={() => undefined}
    />,
  );

  const compose = document.querySelector('[data-architecture-tray-compose]') as HTMLButtonElement;
  assert.equal(compose.disabled, true);
  assert.match(
    document.querySelector('[data-architecture-tray-no-session]')?.textContent ?? '',
    /Select a session to put text in the input box/,
  );
});

/**
 * The attachment's volume band is computed from the COMPLETE text.
 *
 * The renderer used to truncate any diagram past 40 entities at `compact`,
 * which replaced the member tail with a synthetic overflow row before the text
 * page ever saw it. The drawing is now rendered with `detail: 'full'`, so the
 * tray's attachment (the same builder the Text page uses) carries every member
 * and its band is the band of that complete document — not of a compact one.
 */
test('the attached subgraph carries every member and its volume band is the complete document', async () => {
  const entity = (name: string, members: number) => ({
    id: `s1/src/e/${name}.ts.${name}`,
    label: name,
    distance: 0,
    kind: 'class' as const,
    members: Array.from({ length: members }, (_unused, index) => ({
      name: `member${String(index)}`,
      kind: 'field' as const,
      visibility: 'private',
      signature: 'number',
    })),
  });
  const graph = { nodes: [entity('Alpha', 25), entity('Beta', 8)], edges: [] };
  const options = { view: { kind: 'hierarchy' } as const, grouping: 'raw' as const, idShape: 'scope-prefixed' as const };
  const bridge = archguardToPlantUml(graph, options);
  const detailed = await renderWithMemberDetail(renderDetailed, parserSafePlantUml(bridge.puml), {});
  const drawn: ArchitectureDrawnPlantUml = {
    model: detailed.model,
    entityIdOf: bridge.aliasOf,
    toPlantUml: (model) => standardiseDrawnStereotypes(toPlantUml(model)),
    applyView,
  };
  const expected = buildPlantUmlText(
    graph,
    { kind: 'selected', nodeIds: graph.nodes.map((node) => node.id) },
    { ...options, drawn },
  );
  assert.doesNotMatch(expected, /…\s*\+\d+\s+more|\(\d+\s+members\)/);

  const composed: string[] = [];
  render(
    <ArchitectureSelectionTray
      selections={[
        { kind: 'entity' as const, nodeId: graph.nodes[0].id },
        { kind: 'entity' as const, nodeId: graph.nodes[1].id },
      ]}
      graph={graph}
      idShape="scope-prefixed"
      view={{ kind: 'hierarchy' }}
      grouping="raw"
      drawn={drawn}
      projectId="project-1"
      analyzedAt="2026-10-22T00:00:00.000Z"
      canCompose
      canRemove
      multiSelect={false}
      expanded
      compact={false}
      onExpandedChange={() => undefined}
      onExitMultiSelect={() => undefined}
      onToggleItem={() => undefined}
      onClear={() => undefined}
      onCompose={(text) => composed.push(text)}
      onRemoveSelected={() => undefined}
    />,
  );

  fireEvent.click(document.querySelector('[data-architecture-tray-attach]') as Element);
  const reading = await waitFor(() => {
    const element = document.querySelector('[data-architecture-tray-volume]');
    assert.ok(element !== null, 'the volume reading appears with the attachment');
    return element;
  });
  assert.equal(Number(reading.getAttribute('data-architecture-tray-volume')), measurePlantUmlText(expected).tokens);
  assert.equal(reading.getAttribute('data-architecture-tray-volume-level'), measurePlantUmlText(expected).level);

  fireEvent.click(document.querySelector('[data-architecture-tray-compose]') as Element);
  assert.equal(composed.length, 1);
  assert.doesNotMatch(composed[0], /…\s*\+\d+\s+more|\(\d+\s+members\)/);
  assert.equal(
    (composed[0].match(/^[ \t]*- member\d+: number$/gm) ?? []).length,
    33,
    'the attachment carries all 25 + 8 member rows',
  );
});
