import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, test, vi } from 'vitest';

import { ArchitecturePanel } from '@/modules/architecture';
import type { ArchitectureGraphResult } from '@/modules/architecture';
import enCommon from '@/modules/i18n/locales/en/common.json';
import {
  consumePendingLocateRequest,
  subscribeToLocateRequests,
  type ChatMessageLocateRequest,
} from '@/shared/chatMessageLocator';
import type * as SharedApiModule from '@/shared/api';

/**
 * The right-hand dock and its inspector: the selection model's UI half.
 *
 * The cases render the REAL panel with the real PlantUML/ELK renderer and stub
 * only the network (graph + mentions). They pin the interactions the design
 * review fixed: a single click selects and opens the dock, a double click
 * drills, Escape closes the dock before clearing the selection without reaching
 * the chat's global abort, and the inspector's overview/sessions/relation
 * readings each report honest states.
 */

const apiMock = vi.hoisted(() => ({
  architectureGraph: vi.fn(),
  architectureMentions: vi.fn(),
}));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApiModule>();
  return {
    ...actual,
    api: {
      ...actual.api,
      architectureGraph: apiMock.architectureGraph,
      architectureMentions: apiMock.architectureMentions,
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

// jsdom ships no ResizeObserver; the diagram observes its container to re-fit.
class RecordingResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = RecordingResizeObserver as unknown as typeof ResizeObserver;

// jsdom has no PointerEvent with a pointerType; the touch gesture reads it.
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

function usePhone(): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 844 });
  stubMatchMedia((query) => query === '(pointer: coarse)' || query === '(pointer: coarse) and (hover: none)');
}

beforeAll(async () => {
  await import('@yalehwang/plantuml-js/elk');
});

const ALPHA = 's1/src/modules/alpha/A.ts.Alpha';
const BETA = 's1/src/modules/alpha/B.ts.Beta';
const GAMMA = 's1/src/modules/beta/C.ts.Gamma';

const HIT = {
  messageId: 'message-42',
  role: 'user' as const,
  kind: 'text' as const,
  excerpt: 'please look at Alpha before you change it',
  at: '2026-10-22T09:00:00.000Z',
};

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
        {
          id: ALPHA,
          label: 'Alpha',
          distance: 0,
          kind: 'class',
          mentionTier: 'direct',
          // Ten members: the overview shows eight, then offers "show all".
          members: Array.from({ length: 10 }, (_unused, index) => ({
            name: `member${index}`,
            kind: 'method' as const,
            signature: '(): void',
          })),
        },
        { id: BETA, label: 'Beta', distance: 1, kind: 'interface' },
        { id: GAMMA, label: 'Gamma', distance: 2, kind: 'class' },
      ],
      edges: [
        { from: BETA, to: ALPHA, relationType: 'dependency' },
        { from: GAMMA, to: BETA, relationType: 'call' },
      ],
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

function mentionsFor(hits: readonly unknown[], extra: Record<string, unknown> = {}): Response {
  return jsonResponse({
    mentions: [{ entityId: ALPHA, candidateCount: 1, ambiguous: false, hits }],
    truncated: false,
    ...extra,
  });
}

async function waitForDiagram(): Promise<HTMLElement> {
  const host = await screen.findByTestId('plantuml-host');
  await waitFor(() => assert.ok(host.querySelector('svg'), 'the renderer must draw an SVG'));
  return host;
}

function dock(): Element | null {
  return document.querySelector('[data-architecture-dock]');
}

function inspector(): Element | null {
  return document.querySelector('[data-architecture-inspector]');
}

async function openInspectorFor(host: HTMLElement, nodeId: string): Promise<Element> {
  fireEvent.click(host.querySelector(`[data-entity-id="${nodeId}"]`) as Element);
  await waitFor(() => assert.ok(inspector() !== null, 'the dock inspector must open on a selection'));
  return inspector() as Element;
}

/** One finger press, lifted and finished with the click a browser would send. */
function tap(target: Element): void {
  fireEvent.pointerDown(target, { pointerId: 1, pointerType: 'touch', clientX: 40, clientY: 40 });
  fireEvent.pointerUp(target, { pointerId: 1, pointerType: 'touch', clientX: 40, clientY: 40 });
  fireEvent.click(target);
}

beforeEach(() => {
  apiMock.architectureGraph.mockReset();
  apiMock.architectureGraph.mockResolvedValue(jsonResponse(RESULT));
  apiMock.architectureMentions.mockReset();
  apiMock.architectureMentions.mockResolvedValue(mentionsFor([]));
  // Layer + dock storage decide the starting chrome; a stale value would make a
  // "default is closed" case vacuous.
  window.localStorage.clear();
  consumePendingLocateRequest();
  stubMatchMedia(() => false);
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 900 });
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: originalInnerWidth });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: originalInnerHeight });
});

test('the dock is closed by default; a single click opens it with the entity name, kind and path', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  const host = await waitForDiagram();
  assert.equal(dock(), null, 'the dock ships closed');

  fireEvent.click(host.querySelector(`[data-entity-id="${ALPHA}"]`) as Element);
  await waitFor(() => assert.ok(dock() !== null, 'a single click must open the dock'));

  const panel = inspector();
  assert.ok(panel !== null);
  assert.equal(panel.getAttribute('data-architecture-inspector-kind'), 'entity');
  assert.equal(
    panel.querySelector('[data-architecture-inspector-name]')?.getAttribute('data-architecture-inspector-name'),
    'Alpha',
  );
  assert.equal(
    panel.querySelector('[data-architecture-inspector-kind-label]')?.getAttribute('data-architecture-inspector-kind-label'),
    'class',
  );
  assert.equal(
    panel.querySelector('[data-architecture-inspector-path]')?.getAttribute('data-architecture-inspector-path'),
    'src/modules/alpha/A.ts',
    'the path is project-relative with the entity suffix stripped',
  );
  // The single click must NOT drill: the drawing is still the hierarchy.
  assert.equal(document.querySelector('[data-architecture-view]')?.getAttribute('data-architecture-view'), 'hierarchy');
});

test('a double click drills into the neighbourhood while the single click only selects', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  const host = await waitForDiagram();

  fireEvent.click(host.querySelector(`[data-entity-id="${ALPHA}"]`) as Element);
  await waitFor(() => assert.ok(inspector() !== null));
  assert.equal(document.querySelector('[data-architecture-view]')?.getAttribute('data-architecture-view'), 'hierarchy');

  fireEvent.doubleClick(host.querySelector(`[data-entity-id="${ALPHA}"]`) as Element);
  await waitFor(() => {
    assert.equal(document.querySelector('[data-architecture-view]')?.getAttribute('data-architecture-view'), 'neighborhood');
    assert.equal(document.querySelector('[data-architecture-hops]')?.getAttribute('data-architecture-hops'), '1');
  });
});

test('the overview lists the first eight members, both degrees and grouped relations that select and centre', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  const host = await waitForDiagram();
  const panel = await openInspectorFor(host, ALPHA);

  assert.equal(panel.querySelectorAll('[data-architecture-inspector-members] li').length, 8, 'only the first 8 members are listed');
  assert.ok(panel.querySelector('[data-architecture-inspector-members-toggle]'), 'the rest are behind a disclosure');
  fireEvent.click(panel.querySelector('[data-architecture-inspector-members-toggle]') as Element);
  await waitFor(() =>
    assert.equal(panel.querySelectorAll('[data-architecture-inspector-members] li').length, 10, 'show all expands the list'));

  assert.equal(
    panel.querySelector('[data-architecture-inspector-in-degree]')?.getAttribute('data-architecture-inspector-in-degree'),
    '1',
  );
  assert.equal(
    panel.querySelector('[data-architecture-inspector-out-degree]')?.getAttribute('data-architecture-inspector-out-degree'),
    '0',
  );

  const related = panel.querySelector(`[data-architecture-inspector-related-node="${BETA}"]`);
  assert.ok(related !== null, 'the related list groups by relation type');
  fireEvent.click(related);
  await waitFor(() => {
    assert.equal(
      document.querySelector('[data-architecture-inspector-name]')?.getAttribute('data-architecture-inspector-name'),
      'Beta',
      'clicking a related node selects it in the inspector',
    );
    assert.ok(
      host.querySelector(`[data-entity-id="${BETA}"]`)?.getAttribute('data-architecture-focus-target') === BETA,
      'and the drawing centres it',
    );
  });
});

test('the sessions page has the loading, empty, error, truncated and ambiguous states', async () => {
  // 1. Loading: the request never resolves, so the skeleton stays up.
  apiMock.architectureMentions.mockReturnValue(new Promise(() => undefined));
  const first = render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  const firstHost = await waitForDiagram();
  let panel = await openInspectorFor(firstHost, BETA);
  fireEvent.click(panel.querySelector('[data-architecture-inspector-tab="sessions"]') as Element);
  await waitFor(() => {
    assert.ok(panel.querySelector('[data-architecture-mentions-loading]')?.getAttribute('aria-busy') === 'true');
    assert.equal(panel.querySelectorAll('[data-architecture-mentions-skeleton]').length, 3, 'three skeleton rows');
  });
  first.unmount();

  // 2. Empty: no hits, and the sentence names the node's distance.
  apiMock.architectureMentions.mockResolvedValue(jsonResponse({
    mentions: [{ entityId: BETA, candidateCount: 1, ambiguous: false, hits: [] }],
    truncated: false,
  }));
  const second = render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  const secondHost = await waitForDiagram();
  panel = await openInspectorFor(secondHost, BETA);
  fireEvent.click(panel.querySelector('[data-architecture-inspector-tab="sessions"]') as Element);
  await waitFor(() => {
    const empty = panel.querySelector('[data-architecture-mentions-empty]');
    assert.ok(empty !== null, 'an empty reading must say so');
    assert.match(empty.textContent ?? '', /1 hop/, 'the distance comes from the node');
  });
  second.unmount();

  // 3. Error + retry.
  apiMock.architectureMentions.mockRejectedValue(new Error('mentions down'));
  const third = render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  const thirdHost = await waitForDiagram();
  panel = await openInspectorFor(thirdHost, ALPHA);
  fireEvent.click(panel.querySelector('[data-architecture-inspector-tab="sessions"]') as Element);
  await waitFor(() => assert.ok(panel.querySelector('[data-architecture-mentions-error] [role="alert"]')));
  assert.ok(panel.querySelector('[data-architecture-mentions-retry]'), 'the error state offers a retry');
  third.unmount();

  // 4. Truncated.
  apiMock.architectureMentions.mockResolvedValue(jsonResponse({
    mentions: [{ entityId: ALPHA, candidateCount: 1, ambiguous: false, hits: [HIT] }],
    truncated: true,
  }));
  const fourth = render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  const fourthHost = await waitForDiagram();
  panel = await openInspectorFor(fourthHost, ALPHA);
  fireEvent.click(panel.querySelector('[data-architecture-inspector-tab="sessions"]') as Element);
  await waitFor(() => assert.ok(panel.querySelector('[data-architecture-mentions-truncated]')));
  fourth.unmount();

  // 5. Ambiguous: same-named entities get a role="note" warning.
  apiMock.architectureMentions.mockResolvedValue(jsonResponse({
    mentions: [{ entityId: ALPHA, candidateCount: 3, ambiguous: true, hits: [HIT] }],
    truncated: false,
  }));
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  const fifthHost = await waitForDiagram();
  panel = await openInspectorFor(fifthHost, ALPHA);
  fireEvent.click(panel.querySelector('[data-architecture-inspector-tab="sessions"]') as Element);
  await waitFor(() => {
    const note = panel.querySelector('[role="note"]');
    assert.ok(note !== null, 'an ambiguous name must be announced');
    assert.equal(note.getAttribute('data-architecture-mentions-ambiguous'), '3');
  });
});

test('tool output is off by default, and toggling it re-requests with includeToolResults', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  const host = await waitForDiagram();
  const panel = await openInspectorFor(host, ALPHA);
  fireEvent.click(panel.querySelector('[data-architecture-inspector-tab="sessions"]') as Element);

  const toggle = await waitFor(() => {
    const input = panel.querySelector('[data-architecture-include-tool-results]');
    assert.ok(input instanceof HTMLInputElement);
    return input;
  });
  assert.equal(toggle.checked, false, 'the noisy tier is opt-in');
  assert.equal(
    apiMock.architectureMentions.mock.calls[0][2].includeToolResults,
    false,
    'the first request does not ask for tool output',
  );

  fireEvent.click(toggle);
  await waitFor(() => {
    const calls = apiMock.architectureMentions.mock.calls;
    assert.equal(calls.at(-1)?.[2].includeToolResults, true, 'toggling sends includeToolResults: true');
  });
});

test('a mention hit asks the shared locator for its message and opens the chat tab', async () => {
  apiMock.architectureMentions.mockResolvedValue(mentionsFor([HIT]));
  const requests: ChatMessageLocateRequest[] = [];
  const unsubscribe = subscribeToLocateRequests((request) => requests.push(request));
  const openChat = vi.fn();

  render(
    <ArchitecturePanel
      projectId="project-1"
      sessionId="session-1"
      onOpenChat={openChat}
    />,
  );
  const host = await waitForDiagram();
  const panel = await openInspectorFor(host, ALPHA);
  fireEvent.click(panel.querySelector('[data-architecture-inspector-tab="sessions"]') as Element);

  const hit = await waitFor(() => {
    const row = panel.querySelector(`[data-architecture-mention="${HIT.messageId}"]`);
    assert.ok(row !== null);
    return row;
  });
  // The name is highlighted inside the excerpt, not merely printed.
  assert.ok(panel.querySelector('[data-architecture-mention-mark]') !== null);

  fireEvent.click(hit);
  assert.deepEqual(requests, [{ messageId: HIT.messageId }], 'the locator seam receives the message id');
  assert.equal(openChat.mock.calls.length, 1, 'and the workspace is asked to show Chat');
  unsubscribe();
  consumePendingLocateRequest();
});

test('Escape closes the dock first, then clears the selection, and never reaches the global handler', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  const host = await waitForDiagram();
  fireEvent.click(host.querySelector(`[data-entity-id="${ALPHA}"]`) as Element);
  await waitFor(() => assert.ok(dock() !== null));

  // A document-level listener stands in for the chat page's global abort.
  const globalKeys = vi.fn();
  document.addEventListener('keydown', globalKeys);

  fireEvent.keyDown(host, { key: 'Escape' });
  await waitFor(() => assert.equal(dock(), null, 'the first Escape closes the dock'));
  assert.ok(
    host.querySelector(`[data-entity-id="${ALPHA}"]`)?.classList.contains('arch-selected'),
    'the selection survives the dock closing',
  );

  fireEvent.keyDown(host, { key: 'Escape' });
  await waitFor(() =>
    assert.equal(
      host.querySelector(`[data-entity-id="${ALPHA}"]`)?.classList.contains('arch-selected'),
      false,
      'the second Escape clears the selection',
    ));

  assert.equal(globalKeys.mock.calls.length, 0, 'the canvas-owned Escape must be stopped before the document');
  document.removeEventListener('keydown', globalKeys);
});

test('a relation click opens the relation inspector with both ends, type and co-mentions', async () => {
  apiMock.architectureMentions.mockResolvedValue(jsonResponse({
    mentions: [],
    edge: { coMentions: [HIT] },
    truncated: false,
  }));
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  const host = await waitForDiagram();

  const hitBand = host.querySelector(
    `[data-architecture-edge-hit][data-architecture-edge-source="${BETA}"][data-architecture-edge-target="${ALPHA}"]`,
  );
  assert.ok(hitBand !== null, 'every relation carries an enlarged hit band');
  fireEvent.click(hitBand);

  await waitFor(() => assert.ok(inspector() !== null));
  const panel = inspector() as Element;
  assert.equal(panel.getAttribute('data-architecture-inspector-kind'), 'relation');
  assert.equal(
    panel.querySelector('[data-architecture-inspector-relation-ends]')?.getAttribute('data-architecture-inspector-relation-ends'),
    `${BETA} -> ${ALPHA}`,
  );
  assert.equal(
    panel.querySelector('[data-architecture-inspector-relation-type]')?.getAttribute('data-architecture-inspector-relation-type'),
    'dependency',
  );
  // The co-mention list is the relation's own reading.
  await waitFor(() => assert.ok(panel.querySelector(`[data-architecture-mention="${HIT.messageId}"]`)));
  assert.deepEqual(
    apiMock.architectureMentions.mock.calls.at(-1)?.[2].edge,
    { from: BETA, to: ALPHA },
    'the request names the relation, not an entity list',
  );});

test('the touch tier draws the same inspector in a bottom drawer with three snap heights', async () => {
  usePhone();
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  const host = await waitForDiagram();

  tap(host.querySelector(`[data-entity-id="${ALPHA}"]`) as Element);
  const drawer = await waitFor(() => {
    const element = document.querySelector('[data-architecture-dock-touch]');
    assert.ok(element instanceof HTMLElement, 'a coarse pointer gets the bottom drawer');
    return element;
  });
  assert.ok(drawer.querySelector('[data-architecture-inspector]'), 'the same inspector content is drawn in the drawer');
  assert.equal(drawer.getAttribute('data-architecture-dock-height'), 'half');

  const snaps = [...drawer.querySelectorAll('[data-architecture-dock-snap]')];
  assert.deepEqual(
    snaps.map((snap) => snap.getAttribute('data-architecture-dock-snap')),
    ['collapsed', 'half', 'full'],
    'the drawer has the three designed snap heights',
  );
  fireEvent.click(drawer.querySelector('[data-architecture-dock-snap="collapsed"]') as Element);
  await waitFor(() => assert.equal(drawer.getAttribute('data-architecture-dock-height'), 'collapsed'));
  assert.equal((drawer as HTMLElement).style.height, '96px', 'collapsed is the 96px name/kind row');
  fireEvent.click(drawer.querySelector('[data-architecture-dock-snap="full"]') as Element);
  await waitFor(() => assert.equal(drawer.getAttribute('data-architecture-dock-height'), 'full'));
  assert.equal((drawer as HTMLElement).style.height, '92vh');

  // The touch drill gesture is a double tap; a single tap must not navigate.
  assert.equal(document.querySelector('[data-architecture-view]')?.getAttribute('data-architecture-view'), 'hierarchy');
  tap(host.querySelector(`[data-entity-id="${ALPHA}"]`) as Element);
  tap(host.querySelector(`[data-entity-id="${ALPHA}"]`) as Element);
  await waitFor(() => {
    assert.equal(document.querySelector('[data-architecture-view]')?.getAttribute('data-architecture-view'), 'neighborhood');
  });
});

/**
 * First-open behaviour (2026-10-22 sessions): a fresh entry must never open the
 * empty inspector on its own, a session switch must not carry an open dock into
 * a reading with no selection, and the toolbar's Text door is the one explicit
 * open that works with nothing selected.
 */
test('a remembered open state never opens the dock on a fresh entry', async () => {
  // The reported cause: the previous browser remembered the dock open, so a
  // new session entered with a 320px column holding only "Select a node …".
  window.localStorage.setItem('architecture.dock.open', 'true');
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  await waitForDiagram();

  assert.equal(dock(), null, 'no selection and no explicit open: the dock must not take a column');
  assert.equal(inspector(), null, 'and the empty inspector page is not rendered off screen');
});

test('a session switch carries no open dock into a reading with no selection', async () => {
  const { rerender } = render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  const host = await waitForDiagram();
  await openInspectorFor(host, ALPHA);
  assert.ok(dock() !== null, 'the selection opened the dock');

  rerender(<ArchitecturePanel projectId="project-1" sessionId="session-2" />);
  await waitFor(() => assert.equal(
    dock(),
    null,
    'the new session has no selection, so the dock must not stay open as an empty column',
  ));
});

test('after the reader closes the dock, a new session does not reopen it', async () => {
  const { rerender } = render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  const host = await waitForDiagram();
  await openInspectorFor(host, ALPHA);
  fireEvent.click(document.querySelector('[data-architecture-dock-close]') as Element);
  await waitFor(() => assert.equal(dock(), null, 'the explicit close lands'));

  rerender(<ArchitecturePanel projectId="project-1" sessionId="session-2" />);
  await waitForDiagram();
  assert.equal(dock(), null, 'an explicit close is not undone by entering another session');
});

test('the Text door opens the dock with nothing selected', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  await waitForDiagram();
  assert.equal(dock(), null, 'nothing is open before the reader asks');

  fireEvent.click(document.querySelector('[data-architecture-text-toggle]') as Element);
  await waitFor(() => assert.ok(dock() !== null, 'an explicit Text press opens the dock with no selection'));
  assert.ok(document.querySelector('[data-architecture-text-panel]'), 'and it shows the text page the reader asked for');
});
