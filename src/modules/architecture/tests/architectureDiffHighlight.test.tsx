/**
 * The architecture tab's structural-diff highlight (AC2).
 *
 * The observation wall's architecture tile opens this tab with the structural difference it
 * found. The cases render the REAL panel + PlantUML/ELK renderer with only the network stubbed:
 *
 *   · a diff set passed as a prop marks exactly the nodes inside the named packages and the
 *     relations crossing the named package edges — each with the `data-architecture-diff`
 *     attribute and the diff class, and the readout states how many targets were marked;
 *   · the standalone deep link (`?diffPkg=…`) carries the same set, so the cockpit preview can
 *     open the page without a caller-side prop;
 *   · with no diff set the drawing carries no marker at all and no readout chip — the rendering
 *     is unchanged from before this feature.
 *
 * Run directly:
 *   npx vitest run src/modules/architecture/tests/architectureDiffHighlight.test.tsx
 */
import assert from 'node:assert/strict';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, test, vi } from 'vitest';

import { ArchitecturePanel } from '@/modules/architecture';
import type { ArchitectureGraphResult } from '@/modules/architecture';
import enCommon from '@/modules/i18n/locales/en/common.json';
import type * as SharedApiModule from '@/shared/api';

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

beforeAll(async () => {
  await import('@yalehwang/plantuml-js/elk');
});

const originalMatchMedia = window.matchMedia;
const originalInnerWidth = window.innerWidth;
const originalInnerHeight = window.innerHeight;

const ALPHA = 's1/src/modules/alpha/A.ts.Alpha';
const BETA = 's1/src/modules/alpha/B.ts.Beta';
const GAMMA = 's1/src/modules/beta/C.ts.Gamma';

const RESULT: ArchitectureGraphResult = {
  mmd: { file: '@startuml\nA --> B\n@enduml', entity: '@startuml\nX --> Y\n@enduml' },
  graph: {
    file: {
      nodes: [
        { id: 'src/modules/alpha/A.ts', label: 'A.ts', distance: 0 },
        { id: 'src/modules/alpha/B.ts', label: 'B.ts', distance: 1 },
        { id: 'src/modules/beta/C.ts', label: 'C.ts', distance: 2 },
      ],
      edges: [{ from: 'src/modules/beta/C.ts', to: 'src/modules/alpha/A.ts', relationType: 'dependency' }],
    },
    entity: {
      nodes: [
        { id: ALPHA, label: 'Alpha', distance: 0, kind: 'class' },
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
    fileNodes: 3,
    entityEdges: 2,
    fileEdges: 1,
    truncated: false,
    entityTotal: 3,
    fileTotal: 3,
    seedFiles: 1,
    seedIdentifiers: 1,
    nodeCount: 6,
    edgeCount: 3,
    unresolved: { files: [], identifiers: [] },
  },
  provenance: { generatedAt: '2026-10-22T00:00:00.000Z', fingerprints: [], cacheHit: false },
};

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

async function waitForDiagram(): Promise<HTMLElement> {
  const host = await screen.findByTestId('plantuml-host');
  await waitFor(() => assert.ok(host.querySelector('svg'), 'the renderer must draw an SVG'));
  return host;
}

function node(host: HTMLElement, id: string): Element {
  const element = host.querySelector(`.uml-node[data-entity-id="${id}"]`);
  assert.ok(element !== null, `node ${id} must be drawn`);
  return element;
}

function edge(host: HTMLElement, from: string, to: string): Element {
  const element = host.querySelector(
    `.uml-edge[data-edge-source="${from}"][data-edge-target="${to}"]`,
  );
  assert.ok(element !== null, `edge ${from} -> ${to} must be drawn`);
  return element;
}

beforeEach(() => {
  apiMock.architectureGraph.mockReset();
  apiMock.architectureGraph.mockResolvedValue(jsonResponse(RESULT));
  apiMock.architectureMentions.mockReset();
  apiMock.architectureMentions.mockResolvedValue(jsonResponse({ mentions: [], truncated: false }));
  window.localStorage.clear();
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
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 900 });
});

afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: originalInnerWidth });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: originalInnerHeight });
});

test('AC2: exact node ids and edge pairs are marked, and the readout counts them', async () => {
  render(
    <ArchitecturePanel
      projectId="p1"
      sessionId="s1"
      diffHighlight={{
        nodeIds: [ALPHA],
        edges: [{ from: BETA, to: ALPHA }],
      }}
    />,
  );
  const host = await waitForDiagram();

  await waitFor(() => {
    assert.equal(node(host, ALPHA).getAttribute('data-architecture-diff'), 'node');
  });
  assert.ok(node(host, ALPHA).classList.contains('arch-diff-node'));
  assert.equal(
    node(host, BETA).getAttribute('data-architecture-diff'),
    null,
    'a node the set did not name must not be marked',
  );

  await waitFor(() => {
    assert.equal(
      edge(host, BETA, ALPHA).getAttribute('data-architecture-diff'),
      'edge',
      'the named relation is marked',
    );
  });
  assert.ok(edge(host, BETA, ALPHA).classList.contains('arch-diff-edge'));

  const chip = document.querySelector('[data-testid="architecture-diff-highlight"]');
  assert.ok(chip !== null, 'the readout must state how many targets are highlighted');
  assert.equal(chip.getAttribute('data-architecture-diff-nodes'), '1');
  assert.equal(chip.getAttribute('data-architecture-diff-edges'), '1');
});

test('AC2: a package id marks every drawn node inside it', async () => {
  render(
    <ArchitecturePanel
      projectId="p1"
      sessionId="s1"
      diffHighlight={{ packageIds: ['src/modules/alpha'] }}
    />,
  );
  const host = await waitForDiagram();

  await waitFor(() => {
    assert.equal(node(host, ALPHA).getAttribute('data-architecture-diff'), 'node');
  });
  assert.equal(
    node(host, BETA).getAttribute('data-architecture-diff'),
    'node',
    'every node in the named package is marked',
  );
  // The focused drawing may collapse another package into a stub; whichever nodes it DOES draw
  // from this package are all marked, and no node outside it carries a marker.
  assert.equal(
    host.querySelectorAll('.uml-node[data-entity-id].arch-diff-node').length,
    host.querySelectorAll('.uml-node[data-entity-id]').length,
    'every entity node the drawing shows from the named package is marked',
  );
});

test('AC2: the same set travels in the standalone deep link', async () => {
  const parameter = (name: string, value: string): string =>
    `${name}=${encodeURIComponent(value)}`;
  render(
    <ArchitecturePanel
      projectId="p1"
      sessionId="s1"
      standalone
      deepLinkSearch={`?${[
        parameter('diffNode', ALPHA),
        parameter('diffEdge', `${BETA}->${ALPHA}`),
        parameter('diffPkg', 'src/modules/alpha'),
      ].join('&')}`}
    />,
  );
  const host = await waitForDiagram();

  await waitFor(() => {
    assert.equal(node(host, ALPHA).getAttribute('data-architecture-diff'), 'node');
  });
  assert.equal(
    node(host, BETA).getAttribute('data-architecture-diff'),
    'node',
    'the linked package marks its members',
  );
  await waitFor(() => {
    assert.equal(edge(host, BETA, ALPHA).getAttribute('data-architecture-diff'), 'edge');
  });
});

test('AC2: without a diff set the drawing carries no marker and no chip', async () => {
  render(<ArchitecturePanel projectId="p1" sessionId="s1" />);
  const host = await waitForDiagram();

  assert.equal(document.querySelectorAll('[data-architecture-diff]').length, 0);
  assert.equal(document.querySelectorAll('.arch-diff-node, .arch-diff-edge').length, 0);
  assert.equal(document.querySelector('[data-testid="architecture-diff-highlight"]'), null);
  // The drawing itself is untouched: the same nodes and relations are drawn as before.
  assert.equal(host.querySelectorAll('.uml-node[data-entity-id]').length, 2);
  assert.equal(host.querySelectorAll('.uml-edge[data-edge-source]').length, 1);
});
