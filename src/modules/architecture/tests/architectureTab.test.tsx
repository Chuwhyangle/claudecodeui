import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { Core as CytoscapeCore } from 'cytoscape';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { beforeEach, test, vi } from 'vitest';

import type { AppTab, Project } from '@/shared/types';
import type * as SharedApiModule from '@/shared/api';
import enCommon from '@/modules/i18n/locales/en/common.json';
import { WorkspaceHeader } from '@/modules/project-workspace';
import {
  ArchitecturePanel,
  isArchitectureTabVisible,
  useEnsureArchitectureTabVisible,
} from '@/modules/architecture';
import type { ArchitectureGraphResult } from '@/modules/architecture';
import type { ArchitectureRendererProps } from '@/modules/architecture/rendererContract';

/**
 * The architecture tab's wiring, end to end at the component seam:
 *  · the Tier-1 gate turns `hasArchguardCache` into the presence of
 *    `data-workspace-tab="architecture"`, placed right of Quay;
 *  · a project that loses the gate snaps an active architecture tab back to chat;
 *  · activating the panel POSTs the neighbourhood once and draws the returned
 *    JSON with cytoscape;
 *  · the maxHops/maxNodes sliders and the file/entity toggle slice that
 *    already-fetched payload locally — they must never re-request;
 *  · hovering a node reports its relation types and clicking a node reveals its
 *    next hop from the same payload;
 *  · the honesty bar carries generatedAt / unresolved / truncated, the `.mmd`
 *    export button writes the document the server returned, and an empty seed
 *    set renders the empty state instead of a graph.
 */

// The whole network hop is stubbed; everything below that line (the hook's
// request-id accounting, the panel's render branches, the local filtering) is real.
const apiMock = vi.hoisted(() => ({ architectureGraph: vi.fn() }));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApiModule>();
  return {
    ...actual,
    api: { ...actual.api, architectureGraph: apiMock.architectureGraph },
  };
});

/**
 * jsdom has no canvas, so the real cytoscape cannot draw. The mock keeps the
 * REAL engine — real elements, layouts and event emitter — and only forces
 * headless mode, which is what makes hover (`mouseover`) and click-expand
 * (`tap`) exercisable against the same handlers production registers.
 */
/** The real engine's core type; `export =` makes named type imports the stable source. */
const cyHarness = vi.hoisted(() => ({
  instances: [] as CytoscapeCore[],
}));

vi.mock('cytoscape', async (importOriginal) => {
  const actual = await importOriginal<{ default: (options: Record<string, unknown>) => unknown }>();
  const create = (options: Record<string, unknown>) => {
    const cy = actual.default({ ...options, headless: true, container: undefined });
    cyHarness.instances.push(cy as CytoscapeCore);
    return cy;
  };
  return { ...actual, default: create };
});

// WorkspaceHeader lists every plugin tab; this criterion is about the built-in
// architecture tab, so the plugin list is empty.
vi.mock('@/modules/plugins', () => ({
  usePlugins: () => ({ plugins: [], loading: false, pluginsError: null }),
  PluginIcon: () => null,
}));

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['common'],
  defaultNS: 'common',
  resources: { en: { common: enCommon } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

// jsdom ships no ResizeObserver; the desktop tab strip observes its own overflow.
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

const GENERATED_AT = '2026-10-20T15:52:34.427Z';
const FILE_MMD = 'flowchart LR\n  A --> B';
const ENTITY_MMD = 'flowchart LR\n  X --> Y';

/**
 * A three-node chain with distinct relation types, distances 0/1/2, and both
 * granularities: the file graph mirrors the entity graph with file keys.
 */
const RESULT: ArchitectureGraphResult = {
  mmd: { file: FILE_MMD, entity: ENTITY_MMD },
  graph: {
    file: {
      nodes: [
        { id: 'src/a.ts', label: 'src/a.ts', distance: 0 },
        { id: 'src/a2.ts', label: 'src/a2.ts', distance: 1 },
        { id: 'src/a3.ts', label: 'src/a3.ts', distance: 2 },
      ],
      edges: [
        { from: 'src/a2.ts', to: 'src/a.ts', relationType: 'dependency' },
        { from: 'src/a3.ts', to: 'src/a2.ts', relationType: 'call' },
      ],
    },
    entity: {
      nodes: [
        { id: 'scope-src/A.x', label: 'Alpha', distance: 0 },
        { id: 'scope-src/A.y', label: 'Beta', distance: 1 },
        { id: 'scope-src/A.z', label: 'Gamma', distance: 2 },
      ],
      edges: [
        { from: 'scope-src/A.y', to: 'scope-src/A.x', relationType: 'dependency' },
        { from: 'scope-src/A.z', to: 'scope-src/A.y', relationType: 'call' },
      ],
    },
  },
  stats: {
    entityNodes: 3,
    fileNodes: 3,
    entityEdges: 2,
    fileEdges: 2,
    truncated: true,
    seedFiles: 1,
    seedIdentifiers: 1,
    nodeCount: 6,
    edgeCount: 4,
    unresolved: { files: ['src/unknown.ts'], identifiers: ['NoSuchThing'] },
  },
  provenance: {
    generatedAt: GENERATED_AT,
    fingerprints: [{ scope: 'scope-src', archJsonHash: 'a'.repeat(64) }],
    cacheHit: false,
  },
};

const EMPTY_RESULT: ArchitectureGraphResult = {
  mmd: { file: 'flowchart LR\n', entity: 'flowchart LR\n' },
  graph: {
    file: { nodes: [], edges: [] },
    entity: { nodes: [], edges: [] },
  },
  stats: {
    entityNodes: 0,
    fileNodes: 0,
    entityEdges: 0,
    fileEdges: 0,
    truncated: false,
    seedFiles: 0,
    seedIdentifiers: 0,
    nodeCount: 0,
    edgeCount: 0,
    unresolved: { files: [], identifiers: [] },
  },
  provenance: { generatedAt: GENERATED_AT, fingerprints: [], cacheHit: false },
};

/** A Response stand-in: only `ok` and `json` are read by `readApiJson`. */
function jsonResponse(result: ArchitectureGraphResult): Response {
  return {
    ok: true,
    status: 200,
    json: async () => result,
  } as unknown as Response;
}

/** The renderer the component most recently created (one per visible element set). */
function latestGraph(): CytoscapeCore {
  const instance = cyHarness.instances.at(-1);
  if (instance === undefined) throw new Error('the panel never created a cytoscape renderer');
  return instance;
}

/** Visible node labels of the latest renderer, which is what the sliders change. */
function visibleLabels(): string[] {
  return latestGraph()
    .nodes()
    .map((node) => node.data('label') as string)
    .sort();
}

function visibleNodeCount(): number {
  return Number(document.querySelector('[data-architecture-cytoscape-graph]')?.getAttribute('data-architecture-visible-nodes'));
}

beforeEach(() => {
  apiMock.architectureGraph.mockReset();
  apiMock.architectureGraph.mockResolvedValue(jsonResponse(RESULT));
  cyHarness.instances.length = 0;
});

const projectWithArchguard = (hasArchguardCache: boolean): Project => ({
  projectId: 'project-1',
  displayName: 'probe',
  fullPath: '/tmp/probe',
  hasArchguardCache,
});

function renderHeader(project: Project, activeTab: AppTab = 'chat') {
  return render(
    <WorkspaceHeader
      activeTab={activeTab}
      setActiveTab={() => {}}
      selectedProject={project}
      selectedSession={null}
      shouldShowTasksTab={false}
      shouldShowQuayTab
      shouldShowArchitectureTab={isArchitectureTabVisible(project)}
      shouldShowBrowserTab={false}
      isMobile={false}
      onMenuClick={() => {}}
    />,
  );
}

test('hasArchguardCache=true renders the architecture tab right of Quay', () => {
  renderHeader(projectWithArchguard(true));

  const tabIds = screen.getAllByRole('tab').map((tab) => tab.getAttribute('data-workspace-tab'));
  const architectureIndex = tabIds.indexOf('architecture');
  const quayIndex = tabIds.indexOf('quay');

  assert.notEqual(
    architectureIndex,
    -1,
    `the architecture tab must be rendered; tab ids were ${JSON.stringify(tabIds)}`,
  );
  assert.ok(
    architectureIndex > quayIndex,
    `the architecture tab must sit right of Quay; tab ids were ${JSON.stringify(tabIds)}`,
  );
});

test('hasArchguardCache=false hides the architecture tab', () => {
  renderHeader(projectWithArchguard(false));

  assert.equal(
    document.querySelector('[data-workspace-tab="architecture"]'),
    null,
    'a project without .archguard/query/manifest.json must not offer the tab',
  );
});

test('a hidden architecture tab snaps the active view back to chat', () => {
  const setActiveTab = vi.fn();
  renderHook(() => useEnsureArchitectureTabVisible(false, 'architecture', setActiveTab));

  assert.equal(setActiveTab.mock.calls.length, 1);
  assert.equal(setActiveTab.mock.calls[0][0], 'chat');
});

test('a visible architecture tab is left untouched, and an unrelated tab never moves', () => {
  const visibleSetter = vi.fn();
  renderHook(() => useEnsureArchitectureTabVisible(true, 'architecture', visibleSetter));
  assert.equal(visibleSetter.mock.calls.length, 0);

  const otherTabSetter = vi.fn();
  renderHook(() => useEnsureArchitectureTabVisible(false, 'chat', otherTabSetter));
  assert.equal(otherTabSetter.mock.calls.length, 0);
});

test('activating the panel fetches once and the file/entity toggle never refetches', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);

  await screen.findByTestId('cytoscape-host');
  assert.deepEqual(
    apiMock.architectureGraph.mock.calls,
    [['project-1', 'session-1']],
    'activation must POST exactly once for the selected project/session',
  );
  assert.deepEqual(visibleLabels(), ['src/a.ts', 'src/a2.ts'], 'the 1-hop file graph is the initial view');

  fireEvent.click(screen.getByRole('button', { name: 'Entity graph' }));
  assert.deepEqual(visibleLabels(), ['Alpha', 'Beta'], 'the entity graph is drawn from the same payload');
  assert.equal(
    apiMock.architectureGraph.mock.calls.length,
    1,
    'the entity toggle selects a subgraph that is already in hand — it must not refetch',
  );

  fireEvent.click(screen.getByRole('button', { name: 'File graph' }));
  assert.deepEqual(visibleLabels(), ['src/a.ts', 'src/a2.ts']);
  assert.equal(apiMock.architectureGraph.mock.calls.length, 1);
});

test('the panel draws through the renderer contract, with no cytoscape dependency', async () => {
  // A stand-in implementation of the same contract: if the panel needed cytoscape
  // types or props, this render could not supply them, and the cytoscape host
  // would still appear.
  const seen: ArchitectureRendererProps[] = [];
  function StandInRenderer(props: ArchitectureRendererProps) {
    seen.push(props);
    return <div data-stand-in-renderer="true" data-stand-in-nodes={props.graph.nodes.length} />;
  }

  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" renderer={StandInRenderer} />);

  await waitFor(() => assert.ok(document.querySelector('[data-stand-in-renderer]')));
  assert.equal(
    document.querySelector('[data-architecture-cytoscape]'),
    null,
    'a substituted renderer must be the only thing drawing the graph',
  );

  const props = seen.at(-1);
  if (props === undefined) throw new Error('the stand-in renderer was never rendered');
  assert.equal(props.maxHops, 1, 'the contract carries the current hop budget');
  assert.equal(
    props.maxNodes,
    3,
    'the contract carries the current node budget, clamped to the payload the server sent',
  );
  assert.deepEqual(
    props.graph.nodes.map((node) => node.id),
    ['src/a.ts', 'src/a2.ts', 'src/a3.ts'],
    'the whole neighbourhood is handed over; the renderer applies the local budgets',
  );

  // The panel consumes the contract's hover callback, so the readout is the same
  // for every renderer implementation.
  act(() => props.onNodeHover?.({ node: props.graph.nodes[0], relations: ['dependency'] }));
  const hover = document.querySelector('[data-architecture-hover]');
  assert.equal(hover?.getAttribute('data-architecture-hover'), 'src/a.ts');
  assert.equal(hover?.getAttribute('data-architecture-hover-relations'), 'dependency');

  act(() => props.onNodeHover?.(null));
  assert.equal(document.querySelector('[data-architecture-hover]'), null);
});

test('the maxHops slider filters locally: the visible node set grows without a new request', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  await screen.findByTestId('cytoscape-host');

  assert.equal(visibleNodeCount(), 2, 'one hop shows the seed and its direct neighbour');
  assert.equal(document.querySelector('[data-architecture-max-hops-value]')?.textContent, '1');

  fireEvent.change(screen.getByLabelText('Hops'), { target: { value: '2' } });

  assert.equal(visibleNodeCount(), 3, 'widening maxHops must reveal the distance-2 node already in payload');
  assert.deepEqual(visibleLabels(), ['src/a.ts', 'src/a2.ts', 'src/a3.ts']);
  assert.equal(document.querySelector('[data-architecture-max-hops-value]')?.textContent, '2');
  assert.equal(
    apiMock.architectureGraph.mock.calls.length,
    1,
    'the hop slider is a local filter — it must not re-enter the fetch',
  );
});

test('the maxNodes slider slices the (distance, id) prefix locally', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  await screen.findByTestId('cytoscape-host');

  fireEvent.change(screen.getByLabelText('Max nodes'), { target: { value: '1' } });

  assert.equal(visibleNodeCount(), 1, 'a one-node budget keeps only the seed');
  assert.deepEqual(visibleLabels(), ['src/a.ts']);
  assert.equal(
    apiMock.architectureGraph.mock.calls.length,
    1,
    'the node slider is a local filter — it must not re-enter the fetch',
  );
});

test('hovering a cytoscape node reports the relation types of its visible edges', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  await screen.findByTestId('cytoscape-host');

  act(() => latestGraph().getElementById('src/a2.ts').emit('mouseover'));

  const hover = document.querySelector('[data-architecture-hover]');
  assert.equal(hover?.getAttribute('data-architecture-hover'), 'src/a2.ts');
  assert.equal(
    hover?.getAttribute('data-architecture-hover-relations'),
    'dependency',
    'at 1 hop only the a2→a dependency edge is visible; the call edge needs a3',
  );

  fireEvent.change(screen.getByLabelText('Hops'), { target: { value: '2' } });
  act(() => latestGraph().getElementById('src/a2.ts').emit('mouseover'));
  assert.equal(
    document.querySelector('[data-architecture-hover]')?.getAttribute('data-architecture-hover-relations'),
    'call,dependency',
    'hovering must read both relation types once the call edge is visible',
  );

  act(() => latestGraph().getElementById('src/a2.ts').emit('mouseout'));
  assert.equal(document.querySelector('[data-architecture-hover]'), null);
});

test('clicking a cytoscape node expands its next hop from the same payload', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  await screen.findByTestId('cytoscape-host');

  assert.equal(visibleNodeCount(), 2, 'the distance-2 node starts hidden at maxHops=1');

  act(() => latestGraph().getElementById('src/a2.ts').emit('tap'));

  assert.equal(visibleNodeCount(), 3, 'tapping a node must reveal its immediate neighbour');
  assert.deepEqual(visibleLabels(), ['src/a.ts', 'src/a2.ts', 'src/a3.ts']);
  assert.equal(
    apiMock.architectureGraph.mock.calls.length,
    1,
    'expanding a hop is local — the payload was fetched whole',
  );
});

test('the honesty bar shows generatedAt, unresolved seeds and the truncation notice', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  await screen.findByTestId('cytoscape-host');

  const generatedAt = document.querySelector('[data-architecture-generated-at]');
  assert.equal(generatedAt?.textContent, GENERATED_AT, 'the analysis time must be the manifest timestamp');

  const unresolved = document.querySelector('[data-architecture-unresolved]');
  assert.equal(
    unresolved?.textContent,
    '2 unresolved seed(s)',
    `both unresolved seeds (1 file + 1 identifier) must be counted; got ${unresolved?.textContent}`,
  );

  const truncated = document.querySelector('[data-architecture-truncated]');
  assert.ok(truncated, 'a truncated reading must say so');
  assert.match(truncated.textContent ?? '', /truncated/i);
});

test('the export button writes the server-returned .mmd document', async () => {
  const downloads: string[] = [];
  const createObjectUrl = vi.fn(() => 'blob:architecture');
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function capture(this: HTMLAnchorElement) {
    downloads.push(this.download);
  });

  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  await screen.findByTestId('cytoscape-host');

  fireEvent.click(screen.getByRole('button', { name: 'Export .mmd' }));

  assert.deepEqual(downloads, ['architecture-file.mmd'], 'the file-granularity document must be exported');
  assert.equal(createObjectUrl.mock.calls.length, 1);
  assert.equal(apiMock.architectureGraph.mock.calls.length, 1, 'export must not re-enter the fetch');
});

test('an empty seed set renders the empty state, not a blank graph', async () => {
  apiMock.architectureGraph.mockResolvedValue(jsonResponse(EMPTY_RESULT));

  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);

  await waitFor(() =>
    assert.ok(
      document.querySelector('[data-architecture-empty]'),
      'an empty seed set must render the empty state',
    ),
  );
  assert.equal(
    document.querySelector('[data-architecture-cytoscape]'),
    null,
    'no seeds means there is no graph to draw',
  );
  // The honesty bar still describes the (empty) reading rather than disappearing.
  assert.equal(document.querySelector('[data-architecture-generated-at]')?.textContent, GENERATED_AT);
  assert.equal(
    document.querySelector('[data-architecture-unresolved]')?.textContent,
    '0 unresolved seed(s)',
  );
});

test('the fetch effect tears down cleanly when the panel unmounts mid-request', async () => {
  // A reply that arrives after unmount must not touch React state; React would
  // warn, and the request id makes the late result a no-op by construction.
  let resolveResponse: (response: Response) => void = () => {};
  apiMock.architectureGraph.mockReturnValue(new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  }));

  const { unmount } = render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  unmount();
  resolveResponse(jsonResponse(RESULT));

  await waitFor(() => assert.equal(apiMock.architectureGraph.mock.calls.length, 1));
});
