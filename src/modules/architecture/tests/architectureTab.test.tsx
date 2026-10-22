import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { ARCHGUARD_RELATION_ARROWS } from '@yalehwang/plantuml-js/archguard';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { beforeAll, beforeEach, test, vi } from 'vitest';

import type { AppTab, Project } from '@/shared/types';
import type * as SharedApiModule from '@/shared/api';
import enCommon from '@/modules/i18n/locales/en/common.json';
import deCommon from '@/modules/i18n/locales/de/common.json';
import esCommon from '@/modules/i18n/locales/es/common.json';
import frCommon from '@/modules/i18n/locales/fr/common.json';
import idCommon from '@/modules/i18n/locales/id/common.json';
import itCommon from '@/modules/i18n/locales/it/common.json';
import jaCommon from '@/modules/i18n/locales/ja/common.json';
import koCommon from '@/modules/i18n/locales/ko/common.json';
import ruCommon from '@/modules/i18n/locales/ru/common.json';
import trCommon from '@/modules/i18n/locales/tr/common.json';
import zhCNCommon from '@/modules/i18n/locales/zh-CN/common.json';
import zhTWCommon from '@/modules/i18n/locales/zh-TW/common.json';
import { WorkspaceHeader } from '@/modules/project-workspace';
import {
  ArchitecturePanel,
  isArchitectureTabVisible,
  useEnsureArchitectureTabVisible,
} from '@/modules/architecture';
import type { ArchitectureGraphResult } from '@/modules/architecture';
import type { ArchitectureRendererProps } from '@/modules/architecture/rendererContract';
import type { ArchitectureNeighborhood } from '@/modules/architecture/useArchitectureGraph';
import {
  archguardToPlantUml,
  displayName,
  MAX_DISPLAY_DIR_SEGMENTS,
} from '@/modules/architecture/archguardToPlantUml';
import {
  ENTITY_MIN_SCALE,
  SUBPACKAGE_MIN_SCALE,
} from '@/modules/architecture/explosionLod';
import { MIN_READABLE_ZOOM_SCALE } from '@/modules/architecture/svgViewport';

/**
 * The architecture tab's wiring, end to end at the component seam:
 *  · the Tier-1 gate turns `hasArchguardCache` into the presence of
 *    `data-workspace-tab="architecture"`, placed right of Quay;
 *  · a project that loses the gate snaps an active architecture tab back to chat;
 *  · activating the panel POSTs the neighbourhood once and draws the returned
 *    JSON with the lazily loaded PlantUML/ELK renderer;
 *  · the file/entity toggle picks between subgraphs already in hand — it must
 *    never re-request;
 *  · the bridge maps ArchGuard relation kinds onto UML arrows and front-truncates
 *    long display names;
 *  · overview folds the graph into path groups, clicking a group expands it,
 *    clicking an entity drills into its neighbourhood (and clicking the centred
 *    entity again adds a hop) — all from the same payload;
 *  · hovering a node highlights its in/out edges and dims the rest, while a
 *    click pins that highlight, announces the entity's JSON in/out neighbours
 *    to sibling panels, and a sibling panel can select an entity by its stable
 *    id through the same window-level contract;
 *  · the honesty bar carries generatedAt / unresolved / truncated, the `.mmd`
 *    export button writes the document the server returned, and an empty seed
 *    set renders the empty state instead of a graph.
 */

// The whole network hop is stubbed; everything below that line (the hook's
// request-id accounting, the panel's render branches, the bridge, the real
// PlantUML/ELK renderer) is real.
const apiMock = vi.hoisted(() => ({ architectureGraph: vi.fn() }));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApiModule>();
  return {
    ...actual,
    api: { ...actual.api, architectureGraph: apiMock.architectureGraph },
  };
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
  // zh-CN is loaded for the one case that reads the layout-budget sentence in
  // the reviewed Chinese wording; the rest of the suite runs in English.
  resources: { en: { common: enCommon }, 'zh-CN': { common: zhCNCommon } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

// jsdom ships no ResizeObserver. The desktop tab strip observes its own overflow
// and the diagram observes its scroll container to re-fit; recording the
// callbacks lets a case deliver a resize the way a laid-out browser would.
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
 * jsdom implements neither `PointerEvent` nor pointer capture. This minimal
 * PointerEvent extends MouseEvent (so `clientX`/`clientY`/`button` are real)
 * and adds the two fields the pan reads: `pointerId` for following one gesture
 * and `pointerType` for the mouse/finger split.
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

/** Deliver one resize notification to every mounted observer, inside act(). */
function triggerResize(): void {
  act(() => {
    for (const callback of [...resizeCallbacks]) callback([], {} as ResizeObserver);
  });
}

// Pay the one-off module compile in the hook budget (20s), not inside the first
// case's 5s, the same discipline the client suite uses for cold module graphs.
beforeAll(async () => {
  await import('@yalehwang/plantuml-js/elk');
});

const GENERATED_AT = '2026-10-20T15:52:34.427Z';
const FILE_MMD = '@startuml\nA --> B\n@enduml';
const ENTITY_MMD = '@startuml\nX --> Y\n@enduml';

/**
 * A four-node chain split across three directories: the file graph mirrors the
 * entity graph. The directory split is what gives the overview a real group
 * node (`src/modules/alpha`), and the chain gives the neighbourhood view a node
 * that only appears at hop 2. The two directories holding a single file are
 * drawn as those files, not as `(1)` groups.
 */
const RESULT: ArchitectureGraphResult = {
  mmd: { file: FILE_MMD, entity: ENTITY_MMD },
  graph: {
    file: {
      nodes: [
        { id: 'src/modules/alpha/a.ts', label: 'src/modules/alpha/a.ts', distance: 0 },
        { id: 'src/modules/alpha/a2.ts', label: 'src/modules/alpha/a2.ts', distance: 1 },
        { id: 'src/modules/beta/b.ts', label: 'src/modules/beta/b.ts', distance: 2 },
        { id: 'src/modules/gamma/c.ts', label: 'src/modules/gamma/c.ts', distance: 3 },
      ],
      edges: [
        { from: 'src/modules/alpha/a2.ts', to: 'src/modules/alpha/a.ts', relationType: 'dependency' },
        { from: 'src/modules/beta/b.ts', to: 'src/modules/alpha/a2.ts', relationType: 'call' },
        { from: 'src/modules/gamma/c.ts', to: 'src/modules/beta/b.ts', relationType: 'inheritance' },
      ],
    },
    entity: {
      nodes: [
        { id: 'src/modules/alpha/A.ts.Alpha', label: 'Alpha', distance: 0 },
        { id: 'src/modules/alpha/A2.ts.Alpha2', label: 'Alpha2', distance: 1 },
        { id: 'src/modules/beta/B.ts.Beta', label: 'Beta', distance: 2 },
        { id: 'src/modules/gamma/C.ts.Gamma', label: 'Gamma', distance: 3 },
      ],
      edges: [
        { from: 'src/modules/alpha/A2.ts.Alpha2', to: 'src/modules/alpha/A.ts.Alpha', relationType: 'dependency' },
        { from: 'src/modules/beta/B.ts.Beta', to: 'src/modules/alpha/A2.ts.Alpha2', relationType: 'call' },
        { from: 'src/modules/gamma/C.ts.Gamma', to: 'src/modules/beta/B.ts.Beta', relationType: 'inheritance' },
      ],
    },
  },
  stats: {
    entityNodes: 4,
    fileNodes: 4,
    entityEdges: 3,
    fileEdges: 3,
    // The entity set was cut (9 reachable, 4 kept) while the file graph is
    // whole. The per-granularity flags are what the panel's notice reads.
    truncated: true,
    entityTruncated: true,
    fileTruncated: false,
    entityTotal: 9,
    fileTotal: 4,
    seedFiles: 1,
    seedIdentifiers: 1,
    nodeCount: 8,
    edgeCount: 6,
    unresolved: { files: ['src/unknown.ts'], identifiers: ['NoSuchThing'] },
  },
  provenance: {
    generatedAt: GENERATED_AT,
    fingerprints: [{ scope: 'scope-src', archJsonHash: 'a'.repeat(64) }],
    cacheHit: false,
  },
};

/**
 * An ENTITY subgraph carrying the server's `kind`/`members` detail, all inside
 * one directory so the group view flattens every entity into the drawing. The
 * hops are distinct (0..3) and give the seed marker exactly one node to find.
 */
const CLASS_DIAGRAM_RESULT: ArchitectureGraphResult = {
  mmd: { file: FILE_MMD, entity: ENTITY_MMD },
  graph: {
    file: RESULT.graph.file,
    entity: {
      nodes: [
        {
          id: 'src/modules/alpha/halt.ts.haltVerdict',
          label: 'haltVerdict',
          distance: 0,
          kind: 'function',
        },
        {
          id: 'src/modules/alpha/reader.ts.Reader',
          label: 'Reader',
          distance: 1,
          kind: 'interface',
          members: [
            { name: 'read', kind: 'method', visibility: 'public', signature: 'read(): number' },
          ],
        },
        {
          id: 'src/modules/alpha/store.ts.Store',
          label: 'Store',
          distance: 2,
          kind: 'class',
          members: [
            { name: 'threshold', kind: 'field', visibility: 'private', signature: 'number' },
            { name: 'put', kind: 'method', visibility: 'public', signature: 'put(value: number): void' },
          ],
        },
        {
          id: 'src/modules/alpha/clock.ts.Clock',
          label: 'Clock',
          distance: 3,
          kind: 'abstract',
        },
      ],
      edges: [
        { from: 'src/modules/alpha/reader.ts.Reader', to: 'src/modules/alpha/halt.ts.haltVerdict', relationType: 'call' },
        { from: 'src/modules/alpha/store.ts.Store', to: 'src/modules/alpha/reader.ts.Reader', relationType: 'dependency' },
        { from: 'src/modules/alpha/clock.ts.Clock', to: 'src/modules/alpha/halt.ts.haltVerdict', relationType: 'dependency' },
      ],
    },
  },
  stats: {
    ...RESULT.stats,
    entityNodes: 4,
    entityEdges: 3,
    entityTotal: 4,
    entityTruncated: false,
  },
  provenance: RESULT.provenance,
};

/**
 * The three mention tiers plus one legacy node. All four are distance 0 and
 * live in one directory so a single group expansion draws them. The legacy node
 * deliberately omits `mentionTier`: an old payload must keep the pre-tier
 * "distance 0 is a seed" reading.
 */
const MENTION_TIER_RESULT: ArchitectureGraphResult = {
  mmd: { file: FILE_MMD, entity: ENTITY_MMD },
  graph: {
    file: RESULT.graph.file,
    entity: {
      nodes: [
        {
          id: 'src/modules/tiers/Direct.ts.Direct',
          label: 'Direct',
          distance: 0,
          mentionTier: 'direct',
          mentionCount: 4,
        },
        {
          id: 'src/modules/tiers/Name.ts.Name',
          label: 'Name',
          distance: 0,
          mentionTier: 'name',
          mentionCount: 2,
        },
        {
          id: 'src/modules/tiers/File.ts.File',
          label: 'File',
          distance: 0,
          mentionTier: 'file',
          mentionCount: 1,
        },
        {
          id: 'src/modules/tiers/Legacy.ts.Legacy',
          label: 'Legacy',
          distance: 0,
        },
      ],
      edges: [],
    },
  },
  stats: {
    ...RESULT.stats,
    entityNodes: 4,
    entityEdges: 0,
    entityTotal: 4,
    entityTruncated: false,
    seedTiers: { direct: 1, name: 1, file: 1 },
  },
  provenance: RESULT.provenance,
};

/**
 * A tree deeper than the overview can show: 12 packages × 4 units × 5 files.
 * Depth 3 would be 48 groups (over the bound), so the overview stops at the
 * package layer. Expanding one package therefore still contains 20 files that
 * the group view must re-group into its four unit directories — the fixed-depth
 * view used to flatten them into 20 `grp::…/file-N.ts` groups instead.
 */
const DEEP_TREE_RESULT: ArchitectureGraphResult = {
  mmd: { file: FILE_MMD, entity: ENTITY_MMD },
  graph: {
    file: {
      nodes: Array.from({ length: 12 }, (_unused, moduleIndex) => moduleIndex).flatMap((moduleIndex) =>
        Array.from({ length: 4 }, (_unused, unitIndex) => unitIndex).flatMap((unitIndex) =>
          Array.from({ length: 5 }, (_unused, fileIndex) => ({
            id: `src/packages/mod-${String(moduleIndex)}/unit-${String(unitIndex)}/file-${String(fileIndex)}.ts`,
            label: `file-${String(fileIndex)}.ts`,
            distance: fileIndex,
          })),
        ),
      ),
      edges: [
        {
          from: 'src/packages/mod-0/unit-0/file-0.ts',
          to: 'src/packages/mod-0/unit-1/file-1.ts',
          relationType: 'dependency',
        },
        {
          from: 'src/packages/mod-1/unit-0/file-0.ts',
          to: 'src/packages/mod-0/unit-0/file-0.ts',
          relationType: 'call',
        },
      ],
    },
    entity: { nodes: [], edges: [] },
  },
  stats: {
    ...RESULT.stats,
    entityNodes: 0,
    entityEdges: 0,
    fileNodes: 240,
    fileEdges: 2,
    nodeCount: 240,
    edgeCount: 2,
  },
  provenance: RESULT.provenance,
};

/**
 * A file graph larger than `LAYOUT_NODE_BUDGET` (600): 650 files in one flat
 * directory. The identity tier (`all`) retains every one, so the layout budget
 * must fall back to the highest tier that fits — `common`, 325 nodes — before
 * the renderer is ever handed the graph.
 */
const OVER_BUDGET_RESULT: ArchitectureGraphResult = {
  mmd: { file: FILE_MMD, entity: ENTITY_MMD },
  graph: {
    file: {
      nodes: Array.from({ length: 650 }, (_unused, index) => ({
        id: `src/wide/file-${String(index)}.ts`,
        label: `file-${String(index)}.ts`,
        distance: 1,
      })),
      edges: [
        { from: 'src/wide/file-0.ts', to: 'src/wide/file-1.ts', relationType: 'dependency' },
      ],
    },
    entity: { nodes: [], edges: [] },
  },
  stats: {
    ...RESULT.stats,
    entityNodes: 0,
    entityEdges: 0,
    entityTotal: 0,
    entityTruncated: false,
    fileNodes: 650,
    fileEdges: 1,
    fileTotal: 650,
    fileTruncated: false,
    truncated: false,
    nodeCount: 650,
    edgeCount: 1,
  },
  provenance: RESULT.provenance,
};

/**
 * A FILE graph in the shape the server really emits: project-relative ids whose
 * first segment is a directory (`scripts/`, `plugin/`, `packages/`). Two of
 * these directories hold one file each — the `(1)` boxes the report named —
 * and two files share the name `stamp-version.ts` in different directories.
 */
const ISOLATED_FILE_RESULT: ArchitectureGraphResult = {
  mmd: { file: FILE_MMD, entity: ENTITY_MMD },
  graph: {
    file: {
      nodes: [
        { id: 'plugin/scripts/anti-drift-touches-check.ts', label: 'plugin/scripts/anti-drift-touches-check.ts', distance: 0 },
        { id: 'plugin/scripts/quay-test-script.ts', label: 'plugin/scripts/quay-test-script.ts', distance: 1 },
        { id: 'scripts/stamp-version.ts', label: 'scripts/stamp-version.ts', distance: 0 },
        { id: 'orchestration/manager-visual-check.py', label: 'orchestration/manager-visual-check.py', distance: 1 },
        { id: 'packages/quay/scripts/stamp-version.ts', label: 'packages/quay/scripts/stamp-version.ts', distance: 2 },
      ],
      edges: [
        { from: 'scripts/stamp-version.ts', to: 'plugin/scripts/quay-test-script.ts', relationType: 'call' },
      ],
    },
    entity: { nodes: [], edges: [] },
  },
  stats: {
    entityNodes: 0,
    fileNodes: 5,
    entityEdges: 0,
    fileEdges: 1,
    truncated: false,
    seedFiles: 1,
    seedIdentifiers: 0,
    nodeCount: 5,
    edgeCount: 1,
    unresolved: { files: [], identifiers: [] },
  },
  provenance: RESULT.provenance,
};

const EMPTY_RESULT: ArchitectureGraphResult = {
  mmd: { file: '@startuml\n@enduml', entity: '@startuml\n@enduml' },
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

/** The rendered diagram host, after the real renderer has injected an SVG. */
async function waitForDiagram(): Promise<HTMLElement> {
  const host = await screen.findByTestId('plantuml-host');
  await waitFor(() => {
    assert.ok(host.querySelector('svg'), 'the PlantUML renderer must draw an SVG');
  });
  return host;
}

/** The graph root — the element carrying the zoom readout and mode. */
function graphRoot(): HTMLElement {
  const root = document.querySelector('[data-architecture-plantuml-graph]');
  assert.ok(root instanceof HTMLElement);
  return root;
}

/** The canvas container the drawing and its floating zoom cluster live in. */
function canvasOf(host: HTMLElement): HTMLElement {
  const canvas = host.closest('[data-architecture-canvas]');
  assert.ok(canvas instanceof HTMLElement, 'the drawing host must sit in the canvas container');
  return canvas;
}

/** The on-canvas zoom cluster. */
function zoomCluster(): HTMLElement {
  const cluster = document.querySelector('[data-architecture-zoom-cluster]');
  assert.ok(cluster instanceof HTMLElement, 'the zoom controls must be drawn on the canvas');
  return cluster;
}

/** jsdom performs no layout, so the scroll container's content box is pinned by hand. */
function sizeHost(host: HTMLElement, width: number, height: number): void {
  Object.defineProperty(host, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(host, 'clientHeight', { configurable: true, value: height });
}

/** The natural coordinate space the renderer emitted. */
function svgViewBoxSize(svg: Element): { width: number; height: number } {
  const parts = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  assert.equal(parts.length, 4, 'the renderer must emit a viewBox for the viewport to scale');
  return { width: parts[2], height: parts[3] };
}

/**
 * The width `fit` should write for this host, derived here without calling the
 * module. The default fit stops at the readable floor: a geometric scale below
 * it would render the 13px labels under 9px, which the panel replaces with the
 * readable focus scale instead.
 */
function fittedWidthIn(host: HTMLElement, svg: Element): number {
  const natural = svgViewBoxSize(svg);
  const geometric = Math.min(host.clientWidth / natural.width, host.clientHeight / natural.height, 1);
  const scale = Math.max(geometric, MIN_READABLE_ZOOM_SCALE);
  return Math.round(natural.width * scale * 100) / 100;
}

/** The SVG's presentation width, as the scroll container sees it. */
function svgWidth(host: HTMLElement): number {
  const svg = host.querySelector('svg');
  assert.ok(svg !== null, 'the diagram must be drawn before reading its width');
  return Number(svg.getAttribute('width'));
}

/** Wait until the drawn SVG matches the fit size for the host we pinned. */
async function waitForFit(host: HTMLElement): Promise<number> {
  await waitFor(() => {
    const svg = host.querySelector('svg');
    assert.ok(svg !== null);
    assert.equal(Number(svg.getAttribute('width')), fittedWidthIn(host, svg));
  });
  return svgWidth(host);
}

/** Node ids present in the host's SVG, sorted. */
function drawnNodeIds(host: HTMLElement): string[] {
  return [...host.querySelectorAll('[data-entity-id]')]
    .map((node) => node.getAttribute('data-entity-id') ?? '')
    .sort();
}

/** The edge group whose endpoints are `from → to`, if drawn. */
function drawnEdge(host: HTMLElement, from: string, to: string): Element {
  for (const edge of host.querySelectorAll('.uml-edge')) {
    if (edge.getAttribute('data-edge-source') === from && edge.getAttribute('data-edge-target') === to) {
      return edge;
    }
  }
  throw new Error(`no drawn edge ${from} → ${to}`);
}

beforeEach(() => {
  apiMock.architectureGraph.mockReset();
  apiMock.architectureGraph.mockResolvedValue(jsonResponse(RESULT));
  // The two display knobs are remembered per project in localStorage; a case
  // that moves them must not decide the next case's starting value.
  for (const projectId of ['project-1', 'project-2']) {
    window.localStorage.removeItem(`architecture.scope.${projectId}`);
    window.localStorage.removeItem(`architecture.detail.${projectId}`);
  }
  // jsdom has no canvas: an un-stubbed `getContext('2d')` answers null AND logs
  // a "Not implemented" error on every paint. The minimap paints on a frame, so
  // answer null directly — it is the component's documented "cannot draw" path.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
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

test('the panel draws through the renderer contract, with no library dependency', async () => {
  // A stand-in implementation of the same contract: if the panel needed
  // PlantUML/ELK types or props, this render could not supply them, and the
  // PlantUML host would still appear.
  const seen: ArchitectureRendererProps[] = [];
  function StandInRenderer(props: ArchitectureRendererProps) {
    seen.push(props);
    return <div data-stand-in-renderer="true" data-stand-in-nodes={props.graph.nodes.length} />;
  }

  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" renderer={StandInRenderer} />);

  await waitFor(() => assert.ok(document.querySelector('[data-stand-in-renderer]')));
  assert.equal(
    document.querySelector('[data-architecture-plantuml-graph]'),
    null,
    'a substituted renderer must be the only thing drawing the graph',
  );

  const props = seen.at(-1);
  if (props === undefined) throw new Error('the stand-in renderer was never rendered');
  assert.deepEqual(
    props.graph.nodes.map((node) => node.id),
    [
      'src/modules/alpha/a.ts',
      'src/modules/alpha/a2.ts',
      'src/modules/beta/b.ts',
      'src/modules/gamma/c.ts',
    ],
    'the whole neighbourhood is handed over; the renderer slices its own view from it',
  );

  // The panel consumes the contract's hover callback, so the readout is the same
  // for every renderer implementation.
  act(() => props.onNodeHover?.({ node: props.graph.nodes[0], relations: ['dependency'] }));
  const hover = document.querySelector('[data-architecture-hover]');
  assert.equal(hover?.getAttribute('data-architecture-hover'), 'src/modules/alpha/a.ts');
  assert.equal(hover?.getAttribute('data-architecture-hover-relations'), 'dependency');

  act(() => props.onNodeHover?.(null));
  assert.equal(document.querySelector('[data-architecture-hover]'), null);
});

test('the entity detail fields pass through the renderer contract unchanged', async () => {
  // The contract only GROWS optional data: a payload with kinds/members and the
  // extra stats/provenance readings must reach the renderer exactly as sent, so
  // a later renderer can use it without any panel-side mapping.
  const detailed: ArchitectureGraphResult = {
    ...RESULT,
    graph: {
      file: RESULT.graph.file,
      entity: {
        nodes: [
          {
            id: 'src/modules/alpha/A.ts.Alpha',
            label: 'Alpha',
            distance: 0,
            kind: 'class',
            members: [
              { name: 'count', kind: 'field', visibility: 'private', signature: 'number' },
              { name: 'run', kind: 'method', visibility: 'public', signature: 'run(): Promise<void>' },
            ],
          },
          { id: 'src/modules/alpha/A2.ts.Alpha2', label: 'Alpha2', distance: 1, kind: 'interface', members: [] },
          { id: 'src/modules/beta/B.ts.Beta', label: 'Beta', distance: 2, kind: 'function' },
          { id: 'src/modules/gamma/C.ts.Gamma', label: 'Gamma', distance: 3, kind: 'abstract' },
        ],
        edges: RESULT.graph.entity.edges,
      },
    },
    stats: {
      ...RESULT.stats,
      kindCounts: { class: 1, interface: 1, function: 1, abstract: 1 },
      membersPerEntity: 20,
      membersTruncated: true,
    },
    provenance: {
      ...RESULT.provenance,
      diagnostics: [{ scope: 'scope-src', code: 'ARCH_JSON_MISSING', message: 'scope has no arch.json' }],
    },
  };
  apiMock.architectureGraph.mockResolvedValue(jsonResponse(detailed));

  const seen: ArchitectureRendererProps[] = [];
  function StandInRenderer(props: ArchitectureRendererProps) {
    seen.push(props);
    return <div data-stand-in-renderer="true" />;
  }

  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" renderer={StandInRenderer} />);
  await waitFor(() => assert.ok(seen.length > 0));
  fireEvent.click(screen.getByRole('radio', { name: 'Class diagram' }));

  await waitFor(() => {
    const nodes = seen.at(-1)?.graph.nodes ?? [];
    assert.ok(nodes.some((node) => node.kind === 'class'), 'the entity subgraph with kinds must reach the renderer');
  });

  const nodes = seen.at(-1)?.graph.nodes ?? [];
  const alpha = nodes.find((node) => node.id === 'src/modules/alpha/A.ts.Alpha');
  assert.equal(alpha?.kind, 'class');
  assert.deepEqual(alpha?.members, [
    { name: 'count', kind: 'field', visibility: 'private', signature: 'number' },
    { name: 'run', kind: 'method', visibility: 'public', signature: 'run(): Promise<void>' },
  ]);
  const alpha2 = nodes.find((node) => node.id === 'src/modules/alpha/A2.ts.Alpha2');
  assert.equal(alpha2?.kind, 'interface');
  assert.deepEqual(alpha2?.members, [], 'an empty member list is preserved rather than dropped');
  const beta = nodes.find((node) => node.id === 'src/modules/beta/B.ts.Beta');
  assert.equal(beta?.kind, 'function');
  assert.equal('members' in (beta ?? {}), false, 'a node without members stays without the key');
});

test('the bridge maps every ArchGuard relation kind onto its UML arrow and stereotype', () => {
  const graph: ArchitectureNeighborhood = {
    nodes: [
      { id: 'src/a/One.ts.A', label: 'A', distance: 0 },
      { id: 'src/a/One.ts.B', label: 'B', distance: 1 },
      { id: 'src/a/One.ts.C', label: 'C', distance: 2 },
      { id: 'src/a/One.ts.D', label: 'D', distance: 3 },
      { id: 'src/a/One.ts.E', label: 'E', distance: 4 },
      { id: 'src/a/One.ts.F', label: 'F', distance: 5 },
      { id: 'src/a/One.ts.G', label: 'G', distance: 6 },
    ],
    edges: [
      { from: 'src/a/One.ts.B', to: 'src/a/One.ts.A', relationType: 'dependency' },
      { from: 'src/a/One.ts.C', to: 'src/a/One.ts.B', relationType: 'call' },
      { from: 'src/a/One.ts.D', to: 'src/a/One.ts.C', relationType: 'composition' },
      { from: 'src/a/One.ts.E', to: 'src/a/One.ts.D', relationType: 'aggregation' },
      { from: 'src/a/One.ts.F', to: 'src/a/One.ts.E', relationType: 'inheritance' },
      { from: 'src/a/One.ts.G', to: 'src/a/One.ts.F', relationType: 'implementation' },
    ],
  };

  const { puml } = archguardToPlantUml(graph);

  assert.match(puml, /^@startuml\n[\s\S]*\n@enduml$/, 'the bridge must emit a complete PlantUML document');
  assert.match(puml, /n1 \.\.> n0 : <<uses>>/, 'dependency → dashed use with its stereotype');
  assert.match(puml, /n2 \.\.> n1 : <<call>>/, 'call → dashed use, never a solid association');
  assert.doesNotMatch(puml, /n2\s+-->\s+n1/, 'a call must not be drawn as a solid association');
  assert.match(puml, /n3 o-- n2/, 'composition → hollow diamond at the source');
  assert.doesNotMatch(puml, /\*--/, 'archguard composition is field-holding, never UML *-- composition');
  assert.match(puml, /n4 o-- n3/, 'aggregation → hollow diamond');
  assert.match(puml, /n5 --\|> n4/, 'inheritance → hollow triangle, solid line');
  assert.match(puml, /n6 \.\.\|> n5/, 'implementation → hollow triangle, dashed line');
  assert.equal(ARCHGUARD_RELATION_ARROWS.composition?.arrow, 'o--');
  assert.equal(ARCHGUARD_RELATION_ARROWS.call?.arrow, '..>');
});

test('the display name keeps relpath.EntityName and truncates the FRONT, not the tail', () => {
  const id = 'src/a/b/c/d/File.ts.Entity';
  const name = displayName(id);

  assert.equal(name, 'b/c/d/File.ts.Entity', 'the leading directories are dropped, the file+entity tail stays');
  assert.ok(name.endsWith('File.ts.Entity'), 'truncation must never cut the entity tail');
  assert.ok(!name.includes('a/b/c'), 'the front of the path is what gets truncated');
  assert.equal(displayName(id, 0), 'a/b/c/d/File.ts.Entity', 'zero keeps every directory segment');

  const { puml } = archguardToPlantUml({
    nodes: [{ id, label: 'Entity', distance: 0 }],
    edges: [],
  });
  assert.match(puml, /class "b\/c\/d\/File\.ts\.Entity" as n0/);
  assert.equal(MAX_DISPLAY_DIR_SEGMENTS, 3);
});

test('the renderer draws the neighbourhood as an SVG (PlantUML/ELK, not a fake)', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await waitForDiagram();

  assert.ok(host.querySelector('svg'), 'an SVG element must be injected into the host');
  assert.ok(host.querySelectorAll('.uml-node').length >= 3, 'the overview folds the graph into path groups');
  assert.ok(host.querySelectorAll('.uml-edge').length >= 2, 'group→group edges must be drawn');
  // The file graph's ids are project-relative, so the group prefix keeps `src/`:
  // peeling it would name the group after a scope key the id does not carry.
  assert.match(
    host.innerHTML,
    /data-entity-id="grp::src\/modules\/alpha"/,
    'the overview group node carries its path prefix',
  );
});

test('the diagram opens fitted, and the canvas cluster plus Ctrl+wheel resize the SVG', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await screen.findByTestId('plantuml-host');
  // Pin the content box a laid-out browser would report, then deliver the resize
  // notification the way the observer would on a real container change.
  // Smaller than the drawn diagram, which is what makes fit mean "shrink".
  sizeHost(host, 160, 120);
  await waitFor(() => assert.ok(host.querySelector('svg')));
  triggerResize();

  const root = graphRoot();
  assert.equal(root.getAttribute('data-architecture-zoom-mode'), 'fit', 'a fresh diagram opens in fit mode');
  const fitted = await waitForFit(host);
  const natural = svgViewBoxSize(host.querySelector('svg') as Element);
  assert.ok(fitted < natural.width, 'fit shrinks a diagram larger than its container');
  assert.ok(
    Math.abs(Number(root.getAttribute('data-architecture-zoom-scale')) - fitted / natural.width) < 1e-3,
    'the readout states the applied scale',
  );
  // The geometric fit of this host is far below the readable floor, so the
  // default is the focused, legible reading of the densest seeded package.
  assert.equal(
    root.getAttribute('data-architecture-readable-mode'),
    'focus',
    'a fit below the readable floor must open focused, not as a grey smear',
  );
  assert.equal(root.getAttribute('data-architecture-readable-package'), 'src/modules/alpha');

  // + / − step by the documented factor and switch to the user's own scale.
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
  assert.equal(root.getAttribute('data-architecture-zoom-mode'), 'custom');
  assert.ok(Math.abs(svgWidth(host) - fitted * 1.25) < 0.05, 'zoom in applies one 1.25× step');
  fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
  assert.ok(Math.abs(svgWidth(host) - fitted) < 0.05, 'zoom out takes the same step back');

  // 100% is natural size, i.e. the viewBox extent — not the fit size. It is a
  // keyboard command on the focused canvas ('1'), not a toolbar button.
  host.focus();
  fireEvent.keyDown(host, { key: '1' });
  assert.equal(svgWidth(host), natural.width);
  assert.equal(Number(host.querySelector('svg')?.getAttribute('height')), natural.height);

  // Fit returns to the container-derived size. In this host the fit is a
  // readable focus, so the control is named "Focus" (see the dedicated case
  // below); read it by its data attribute so this check stays about the scale.
  fireEvent.click(root.querySelector('[data-architecture-zoom-fit]') as Element);
  assert.equal(root.getAttribute('data-architecture-zoom-mode'), 'fit');
  assert.equal(await waitForFit(host), fitted);

  // Ctrl+wheel (the form a trackpad pinch produces) still zooms around the pointer.
  const before = svgWidth(host);
  assert.equal(fireEvent.wheel(host, { deltaY: -120, clientX: 40, clientY: 40, ctrlKey: true }), false);
  assert.ok(svgWidth(host) > before, 'Ctrl+wheel zooms in');
  assert.equal(root.getAttribute('data-architecture-zoom-mode'), 'custom');
});

test('a plain wheel zooms around the cursor and never reaches the page', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await waitForDiagram();
  const root = graphRoot();
  const svg = host.querySelector('svg');
  assert.ok(svg !== null);
  const natural = svgViewBoxSize(svg);

  host.scrollLeft = 0;
  host.scrollTop = 0;
  // A scroll-aware box: the SVG's client origin moves with the container's
  // scroll, which is how a laid-out browser reports it. Without it the
  // "point under the cursor" reading would be a constant.
  svg.getBoundingClientRect = () => {
    const width = Number(svg.getAttribute('width'));
    const height = Number(svg.getAttribute('height'));
    return {
      x: -host.scrollLeft,
      y: -host.scrollTop,
      left: -host.scrollLeft,
      top: -host.scrollTop,
      width,
      height,
      right: width - host.scrollLeft,
      bottom: height - host.scrollTop,
      toJSON: () => ({}),
    } as DOMRect;
  };
  /** The viewBox coordinate under a client point, read from the SVG's real box. */
  const userUnder = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = svg.getBoundingClientRect();
    const scaleNow = rect.width > 0 ? rect.width / natural.width : 1;
    return { x: (clientX - rect.left) / scaleNow, y: (clientY - rect.top) / scaleNow };
  };

  const anchorBefore = userUnder(180, 120);
  const scaleBefore = Number(root.getAttribute('data-architecture-zoom-scale'));
  assert.equal(
    fireEvent.wheel(host, { deltaY: -120, clientX: 180, clientY: 120 }),
    false,
    'the canvas must preventDefault its wheel — it is the wheel\'s only consumer',
  );
  await waitFor(() => {
    assert.ok(
      Number(root.getAttribute('data-architecture-zoom-scale')) > scaleBefore,
      'wheel up (negative deltaY) zooms in',
    );
  });
  assert.equal(root.getAttribute('data-architecture-zoom-mode'), 'custom');
  const anchorAfter = userUnder(180, 120);
  // The SVG's width/height are written rounded to hundredths, so the scale read
  // back from the attribute differs from the controller's by <1e-4; sub-hundredth
  // user units is still "the point did not move".
  assert.ok(
    Math.abs(anchorAfter.x - anchorBefore.x) < 1e-2 && Math.abs(anchorAfter.y - anchorBefore.y) < 1e-2,
    `the viewBox point under the cursor must not move: ${JSON.stringify(anchorBefore)} → ${JSON.stringify(anchorAfter)}`,
  );

  // Wheel down is the opposite direction.
  const zoomedIn = Number(root.getAttribute('data-architecture-zoom-scale'));
  fireEvent.wheel(host, { deltaY: 120, clientX: 180, clientY: 120 });
  await waitFor(() => assert.ok(Number(root.getAttribute('data-architecture-zoom-scale')) < zoomedIn));

  // A wheel that is not on the canvas is not the canvas's to consume: the
  // toolbar keeps the browser's default and nothing zooms.
  const toolbar = document.querySelector('[data-architecture-toolbar]');
  assert.ok(toolbar instanceof HTMLElement);
  const outsideScale = Number(root.getAttribute('data-architecture-zoom-scale'));
  assert.equal(
    fireEvent.wheel(toolbar, { deltaY: -120 }),
    true,
    'a wheel outside the canvas must not be intercepted',
  );
  assert.equal(Number(root.getAttribute('data-architecture-zoom-scale')), outsideScale);
});

test('a left drag on the blank canvas pans, while a press on a node never does', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await waitForDiagram();
  const root = graphRoot();
  const groupNode = host.querySelector('[data-entity-id="grp::src/modules/alpha"]');
  assert.ok(groupNode !== null, 'the overview group stands in for a drawn node');

  // Blank canvas (the scroll container itself): a drag pans it.
  fireEvent.pointerDown(host, { pointerId: 21, pointerType: 'mouse', button: 0, clientX: 300, clientY: 300 });
  fireEvent.pointerMove(host, { pointerId: 21, pointerType: 'mouse', clientX: 250, clientY: 280 });
  assert.equal(host.scrollLeft, 50, 'the drawing follows the drag horizontally');
  assert.equal(host.scrollTop, 20, 'and vertically');
  assert.equal(host.style.cursor, 'grabbing', 'the cursor says the canvas is being dragged');

  // Release over a node: the pan must not turn into a selection or a drill.
  fireEvent.pointerUp(groupNode, { pointerId: 21, pointerType: 'mouse', clientX: 250, clientY: 280 });
  fireEvent.click(groupNode);
  assert.equal(
    root.getAttribute('data-architecture-view'),
    'overview',
    'a pan must not act on the node it was released over',
  );
  assert.equal(host.style.cursor, 'grab', 'the drag state ends with the release');

  // A press ON a node is a click, not the start of a pan — and it still drills.
  const scrolledLeft = host.scrollLeft;
  fireEvent.pointerDown(groupNode, { pointerId: 22, pointerType: 'mouse', button: 0, clientX: 250, clientY: 280 });
  fireEvent.pointerMove(groupNode, { pointerId: 22, pointerType: 'mouse', clientX: 180, clientY: 200 });
  assert.equal(host.scrollLeft, scrolledLeft, 'a press on a node stays a click');
  fireEvent.pointerUp(groupNode, { pointerId: 22, pointerType: 'mouse', clientX: 180, clientY: 200 });
  fireEvent.click(groupNode);
  await waitFor(() => assert.equal(root.getAttribute('data-architecture-view'), 'group'));
});

test('a middle-button drag pans too, and a sub-4px press is still a click', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await waitForDiagram();
  const root = graphRoot();

  // Middle button (button === 1) pans from the blank canvas.
  fireEvent.pointerDown(host, { pointerId: 23, pointerType: 'mouse', button: 1, clientX: 300, clientY: 300 });
  fireEvent.pointerMove(host, { pointerId: 23, pointerType: 'mouse', clientX: 240, clientY: 300 });
  assert.equal(host.scrollLeft, 60, 'the middle-button drag pans the drawing');
  fireEvent.pointerUp(host, { pointerId: 23, pointerType: 'mouse', clientX: 240, clientY: 300 });

  host.scrollLeft = 0;
  host.scrollTop = 0;
  // A 3px wobble is below the 4px threshold: it is a click, so the release
  // click still reaches the drawing.
  fireEvent.pointerDown(host, { pointerId: 24, pointerType: 'mouse', button: 0, clientX: 300, clientY: 300 });
  fireEvent.pointerMove(host, { pointerId: 24, pointerType: 'mouse', clientX: 303, clientY: 300 });
  assert.equal(host.scrollLeft, 0, 'less than 4px is not a drag');
  fireEvent.pointerUp(host, { pointerId: 24, pointerType: 'mouse', clientX: 303, clientY: 300 });

  const groupNode = host.querySelector('[data-entity-id="grp::src/modules/alpha"]');
  assert.ok(groupNode !== null);
  fireEvent.click(groupNode);
  await waitFor(
    () => assert.equal(root.getAttribute('data-architecture-view'), 'group'),
    { timeout: 2000 },
  );
});

test('a cancelled drag leaves no drag state behind', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await waitForDiagram();
  const root = graphRoot();

  fireEvent.pointerDown(host, { pointerId: 25, pointerType: 'mouse', button: 0, clientX: 300, clientY: 300 });
  fireEvent.pointerMove(host, { pointerId: 25, pointerType: 'mouse', clientX: 200, clientY: 300 });
  assert.equal(host.scrollLeft, 100);

  fireEvent.pointerCancel(host, { pointerId: 25, pointerType: 'mouse', clientX: 200, clientY: 300 });
  assert.equal(host.style.cursor, 'grab', 'cancel ends the pan');
  fireEvent.pointerMove(host, { pointerId: 25, pointerType: 'mouse', clientX: 100, clientY: 100 });
  assert.equal(host.scrollLeft, 100, 'a cancelled pointer must not keep panning');

  // The next click is a click again: a released selection gesture drills.
  const groupNode = host.querySelector('[data-entity-id="grp::src/modules/alpha"]');
  assert.ok(groupNode !== null);
  fireEvent.click(groupNode);
  await waitFor(() => assert.equal(root.getAttribute('data-architecture-view'), 'group'));
});

test('a focused canvas pans and zooms from the keyboard, and leaves Escape alone', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await waitForDiagram();
  const root = graphRoot();

  host.focus();
  assert.equal(document.activeElement, host, 'the canvas must be a keyboard focus target');

  const left = host.scrollLeft;
  const top = host.scrollTop;
  assert.equal(fireEvent.keyDown(host, { key: 'ArrowRight' }), false, 'the canvas consumes its pan keys');
  assert.equal(host.scrollLeft, left + 40, 'ArrowRight pans by one step');
  fireEvent.keyDown(host, { key: 'ArrowDown' });
  assert.equal(host.scrollTop, top + 40, 'ArrowDown pans by one step');
  fireEvent.keyDown(host, { key: 'ArrowLeft' });
  assert.equal(host.scrollLeft, left);
  fireEvent.keyDown(host, { key: 'ArrowUp' });
  assert.equal(host.scrollTop, top);

  const scaleBefore = Number(root.getAttribute('data-architecture-zoom-scale'));
  assert.equal(fireEvent.keyDown(host, { key: '+' }), false);
  assert.ok(Number(root.getAttribute('data-architecture-zoom-scale')) > scaleBefore, "'+' zooms in");
  assert.equal(root.getAttribute('data-architecture-zoom-mode'), 'custom');
  fireEvent.keyDown(host, { key: '-' });
  assert.ok(Math.abs(Number(root.getAttribute('data-architecture-zoom-scale')) - scaleBefore) < 1e-9, "'-' zooms out");

  assert.equal(fireEvent.keyDown(host, { key: '0' }), false);
  assert.equal(root.getAttribute('data-architecture-zoom-mode'), 'fit', "'0' fits");
  assert.equal(fireEvent.keyDown(host, { key: '1' }), false);
  assert.equal(Number(root.getAttribute('data-architecture-zoom-scale')), 1, "'1' is actual size");
  assert.equal(root.getAttribute('data-architecture-zoom-mode'), 'custom');

  // Escape is not bound here: it must stay available to the global handler
  // (the chat page aborts a running turn on it).
  assert.equal(fireEvent.keyDown(host, { key: 'Escape' }), true, 'Escape must not be consumed by the canvas');
});

test('the zoom cluster lives on the canvas, not in the toolbar, with 32px targets', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await waitForDiagram();

  const canvas = canvasOf(host);
  const cluster = zoomCluster();
  assert.ok(canvas.contains(cluster), 'the cluster must be inside the canvas container');
  assert.equal(cluster.getAttribute('role'), 'group');
  assert.equal(cluster.getAttribute('aria-label'), 'Diagram zoom', 'the cluster carries an accessible name');
  // The scale reading moved UP into the in-flow row above the canvas (it used
  // to sit inside this floating cluster, which put it over the drawing).
  const header = document.querySelector('[data-architecture-canvas-header]');
  assert.ok(header instanceof HTMLElement, 'the readout/tier row must sit above the canvas');
  assert.ok(header.querySelector('[data-architecture-zoom-level]'), 'the scale reading belongs to the row above the canvas');
  assert.equal(
    cluster.querySelector('[data-architecture-zoom-level]'),
    null,
    'the floating cluster carries buttons only; the reading is not drawn over the graph',
  );
  for (const control of ['zoom-in', 'zoom-out', 'zoom-fit']) {
    assert.ok(cluster.querySelector(`[data-architecture-${control}]`), `${control} must be in the cluster`);
  }

  // A fine pointer gets 32px targets (the WCAG 2.5.8 minimum is 24px; 32 stays
  // comfortably clickable without hiding the drawing).
  const buttons = [...cluster.querySelectorAll('button')];
  assert.ok(buttons.length >= 3, `zoom in, zoom out and fit; got ${buttons.length}`);
  for (const button of buttons) {
    const style = getComputedStyle(button);
    assert.ok(
      Number.parseFloat(style.minHeight) >= 32,
      `a cluster target must be at least 32px tall; got ${style.minHeight}`,
    );
    assert.ok(
      Number.parseFloat(style.minWidth) >= 32,
      `a cluster target must be at least 32px wide; got ${style.minWidth}`,
    );
  }

  // The toolbar no longer owns any zoom control.
  const toolbar = document.querySelector('[data-architecture-toolbar]');
  assert.ok(toolbar instanceof HTMLElement);
  for (const control of ['zoom-in', 'zoom-out', 'zoom-fit']) {
    assert.equal(
      toolbar.querySelector(`[data-architecture-${control}]`),
      null,
      `the toolbar must not keep the ${control} control`,
    );
  }
});

/**
 * jsdom performs no layout, so every `getBoundingClientRect` is a zero-area box
 * at the origin and a literal intersection test would be vacuously green. This
 * lays the canvas's two chrome boxes out the way the CSS column does — anchored
 * at the bottom-right, stacked with the declared row gap, sized by their own
 * declared boxes — so the intersection assertion has real numbers behind it.
 */
function chromeBoxes(overlays: HTMLElement, map: HTMLElement, cluster: HTMLElement) {
  const gap = Number.parseFloat(getComputedStyle(overlays).rowGap);
  const mapCanvas = map.querySelector('canvas');
  assert.ok(mapCanvas instanceof HTMLCanvasElement);
  const width = Number.parseFloat(mapCanvas.style.width);
  const mapHeight = Number.parseFloat(mapCanvas.style.height);
  const clusterHeight = [...cluster.querySelectorAll('button')].reduce(
    (total, button) => total + Number.parseFloat(button.style.minHeight || '0'),
    0,
  );
  const right = 1000;
  const bottom = 800;
  return {
    map: { left: right - width, top: bottom - clusterHeight - gap - mapHeight, right, bottom: bottom - clusterHeight - gap },
    cluster: { left: right - width, top: bottom - clusterHeight, right, bottom },
  };
}

test('the minimap sits in the canvas beside the zoom cluster and remembers being collapsed', async () => {
  window.localStorage.removeItem('architecture.minimap.collapsed');
  const { unmount } = render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await screen.findByTestId('plantuml-host');
  sizeHost(host, 160, 120);
  await waitFor(() => assert.ok(host.querySelector('svg')));
  triggerResize();

  const canvas = canvasOf(host);
  const minimap = await waitFor(() => {
    const node = document.querySelector('[data-architecture-minimap]');
    assert.ok(node instanceof HTMLElement, 'a drawing bigger than the canvas gets a minimap');
    return node;
  });
  const cluster = zoomCluster();

  // Containment: the map is chrome OF the canvas, so it lives inside it.
  assert.ok(canvas.contains(minimap), 'the minimap belongs to the canvas container');
  const overlays = minimap.closest('[data-architecture-canvas-overlays]');
  assert.ok(overlays instanceof HTMLElement, 'the map is drawn in the canvas overlay column');
  assert.equal(
    cluster.closest('[data-architecture-canvas-overlays]'),
    overlays,
    'the map and the zoom cluster share ONE column, so neither can cover the other',
  );
  assert.equal(overlays.parentElement, canvas, 'the column is anchored in the canvas, not the toolbar');

  // The arrangement that makes the boxes disjoint: an absolutely positioned
  // column, a positive gap, and the map BEFORE the cluster.
  const overlayStyle = getComputedStyle(overlays);
  assert.equal(overlayStyle.position, 'absolute');
  assert.equal(overlayStyle.flexDirection, 'column');
  assert.ok(Number.parseFloat(overlayStyle.rowGap) > 0, 'the two chrome boxes are separated by a gap');
  assert.ok(
    (minimap.compareDocumentPosition(cluster) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    'the column stacks the map above the cluster',
  );
  const boxes = chromeBoxes(overlays, minimap, cluster);
  assert.ok(
    boxes.map.bottom <= boxes.cluster.top,
    `the minimap and the zoom cluster must not intersect: ${JSON.stringify(boxes)}`,
  );

  // Collapsing leaves only the 44px button, and the choice is remembered.
  fireEvent.click(document.querySelector('[data-architecture-minimap-collapse]') as Element);
  assert.equal(document.querySelector('[data-architecture-minimap-canvas]'), null, 'the map collapses');
  unmount();

  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const reopenedHost = await screen.findByTestId('plantuml-host');
  sizeHost(reopenedHost, 160, 120);
  await waitFor(() => assert.ok(reopenedHost.querySelector('svg')));
  triggerResize();
  const expand = await waitFor(() => {
    const button = document.querySelector('[data-architecture-minimap-expand]');
    assert.ok(button instanceof HTMLElement, 'a new mount reads the remembered choice');
    return button;
  });
  assert.equal(document.querySelector('[data-architecture-minimap-canvas]'), null, 'still collapsed after remount');
  assert.equal(getComputedStyle(expand).minHeight, '44px', 'the collapsed form keeps a 44px target');

  fireEvent.click(expand);
  await waitFor(() =>
    assert.ok(document.querySelector('[data-architecture-minimap-canvas]'), 'expanding restores the map'),
  );
  assert.equal(
    window.localStorage.getItem('architecture.minimap.collapsed'),
    'expanded',
    'the expanded choice is remembered too',
  );
});

test('the zoom cluster grows to 44px targets on a coarse pointer', async () => {
  const originalMatchMedia = window.matchMedia;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query === '(pointer: coarse)',
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
  try {
    render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
    await waitForDiagram();
    const cluster = zoomCluster();
    for (const button of cluster.querySelectorAll('button')) {
      const style = getComputedStyle(button);
      assert.equal(style.minHeight, '44px', 'a coarse pointer gets the 44px target');
      assert.equal(style.minWidth, '44px', 'a coarse pointer gets the 44px target');
    }
  } finally {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
  }
});

test('the readable toggle switches between the focused default and the whole-graph overview', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await screen.findByTestId('plantuml-host');
  sizeHost(host, 160, 120);
  await waitFor(() => assert.ok(host.querySelector('svg')));
  triggerResize();

  const root = graphRoot();
  await waitFor(() => assert.equal(root.getAttribute('data-architecture-readable-mode'), 'focus'));
  const focusedScale = Number(root.getAttribute('data-architecture-zoom-scale'));
  assert.equal(root.getAttribute('data-architecture-readable-package'), 'src/modules/alpha');

  // 全貌: the whole drawing at the geometric fit, plus an honest "zoom into …"
  // hint naming the package and how many others share the drawing.
  fireEvent.click(screen.getByRole('button', { name: 'Overview' }));
  assert.equal(root.getAttribute('data-architecture-readable-mode'), 'overview');
  const overviewScale = Number(root.getAttribute('data-architecture-zoom-scale'));
  assert.ok(overviewScale < focusedScale, 'overview shrinks the drawing to show the whole graph');
  const hint = document.querySelector('[data-architecture-readable-hint]');
  assert.ok(hint !== null, 'overview mode must say what the reader is looking at');
  assert.match(hint.textContent ?? '', /modules\/alpha/, 'the hint names the densest seeded package');
  assert.match(hint.textContent ?? '', /0 other package/, 'the hint carries the other-package count');
  // The strip shows only the last two path segments; the full id is the title.
  assert.equal(
    hint.getAttribute('title'),
    'src/modules/alpha',
    'the full package id stays available as the title',
  );
  assert.doesNotMatch(
    hint.textContent ?? '',
    /src\/modules\/alpha/,
    'the strip must not print the whole path',
  );
  assert.equal(
    screen.getByRole('button', { name: 'Overview' }).getAttribute('aria-pressed'),
    'true',
    'the overview mode is the pressed toggle',
  );

  // 聚焦: back to the readable floor around the same package. The group is read
  // explicitly because the zoom fit control now also carries the "Focus" label
  // while the readable floor is what a fit applies.
  const readableGroup = screen.getByRole('group', { name: 'Readable zoom mode' });
  fireEvent.click(within(readableGroup).getByRole('button', { name: 'Focus' }));
  assert.equal(root.getAttribute('data-architecture-readable-mode'), 'focus');
  assert.equal(Number(root.getAttribute('data-architecture-zoom-scale')), focusedScale);
  assert.equal(document.querySelector('[data-architecture-readable-hint]'), null);
});

test('a band-shaped explosion drawing collapses to the overview with a notice', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await waitForDiagram();

  // A canvas 30px wide but 600px tall: any real drawing's natural aspect ratio
  // is many times this container's, so the band guard must fire.
  sizeHost(host, 30, 600);
  fireEvent.click(screen.getByRole('button', { name: 'Explosion view' }));

  await waitFor(() => {
    assert.equal(
      graphRoot().getAttribute('data-architecture-view'),
      'overview',
      'a band-shaped canvas must fall back to the directory overview',
    );
  });
  const notice = document.querySelector('[data-architecture-readable-collapsed]');
  assert.ok(notice !== null, 'the fallback must tell the reader the graph was collapsed');
  assert.match(notice.textContent ?? '', /too wide/i);
});

test('redrawing a view re-derives the scale from the new drawing and keeps the fit mode', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await screen.findByTestId('plantuml-host');
  sizeHost(host, 160, 120);
  await waitFor(() => assert.ok(host.querySelector('svg')));
  triggerResize();
  await waitForFit(host);

  // Expand a group; the new drawing has a new natural size, so the scale is
  // re-derived. Fit mode is preserved.
  fireEvent.click(host.querySelector('[data-entity-id="grp::src/modules/alpha"]') as Element);
  await waitFor(() => {
    assert.deepEqual(drawnNodeIds(host), ['src/modules/alpha/a.ts', 'src/modules/alpha/a2.ts']);
  });
  assert.equal(graphRoot().getAttribute('data-architecture-zoom-mode'), 'fit');
  await waitForFit(host);
});

test('semantic zoom toggles the drawn hierarchy without re-laying it out', async () => {
  // AC: the far level shows package frames with (N) counts and aggregated
  // package edges; the near level shows the entity UML edges again. Both come
  // from ONE layout — the SVG element the renderer emitted must never be
  // replaced while zooming across levels.
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await waitForDiagram();

  // Drill to a neighbourhood that spans two packages, so it has a real
  // package-level edge once the entities collapse.
  fireEvent.click(host.querySelector('[data-entity-id="grp::src/modules/alpha"]') as Element);
  await waitFor(() => assert.ok(host.querySelector('[data-entity-id="src/modules/alpha/a2.ts"]')));
  fireEvent.click(host.querySelector('[data-entity-id="src/modules/alpha/a2.ts"]') as Element);
  await waitFor(() => {
    assert.equal(document.querySelector('[data-architecture-hops]')?.getAttribute('data-architecture-hops'), '1');
    assert.deepEqual(drawnNodeIds(host), [
      'src/modules/alpha/a.ts',
      'src/modules/alpha/a2.ts',
      'src/modules/beta/b.ts',
    ]);
  });

  // The near level is the initial fit: entities and their UML edges are shown.
  await waitFor(() => {
    assert.equal(graphRoot().getAttribute('data-architecture-lod-depth'), '2');
  });
  const svg = host.querySelector('svg');
  assert.ok(svg !== null);
  svg.setAttribute('data-lod-sentinel', 'kept');
  const entityEdges = [...host.querySelectorAll('.uml-edge')];
  assert.ok(entityEdges.length >= 2);
  for (const edge of entityEdges) {
    assert.equal((edge as HTMLElement).style.display, '', 'entity edges are drawn at the near level');
  }

  // Zoom out until the package level is crossed; the readout follows the
  // debounced level, not every wheel tick.
  for (let step = 0; step < 8; step += 1) {
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
  }
  const scale = Number(graphRoot().getAttribute('data-architecture-zoom-scale'));
  assert.ok(scale < SUBPACKAGE_MIN_SCALE, `the scale must reach the far band; got ${scale}`);
  await waitFor(() => {
    assert.equal(graphRoot().getAttribute('data-architecture-lod-depth'), '0');
  });

  for (const node of host.querySelectorAll('.uml-node')) {
    assert.equal((node as HTMLElement).style.display, 'none', 'entities collapse at the package level');
  }
  for (const edge of host.querySelectorAll('.uml-edge')) {
    assert.equal((edge as HTMLElement).style.display, 'none', 'entity UML edges are hidden at the package level');
  }
  const alphaLabel = [...host.querySelectorAll('.uml-package[data-package-id="src/modules/alpha"] text')]
    .map((label) => label.textContent)
    .join('');
  assert.match(alphaLabel, /\(2\)$/, 'a collapsed package frame states its entity count');
  const overlayEdges = [...host.querySelectorAll('[data-architecture-lod-edges] line')];
  assert.equal(overlayEdges.length, 1, 'the beta → alpha entity edge aggregates into one package edge');
  assert.equal(overlayEdges[0].getAttribute('data-lod-edge-source'), 'src/modules/beta');
  assert.equal(overlayEdges[0].getAttribute('data-lod-edge-target'), 'src/modules/alpha');
  assert.equal(
    host.querySelector('svg'),
    svg,
    'crossing the level must only toggle display — never re-render the drawing',
  );
  assert.equal(svg.getAttribute('data-lod-sentinel'), 'kept');

  // Zoom back in past the dead band: the same SVG expands back to entities.
  for (let step = 0; step < 8; step += 1) {
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
  }
  assert.ok(Number(graphRoot().getAttribute('data-architecture-zoom-scale')) >= ENTITY_MIN_SCALE);
  await waitFor(() => {
    assert.equal(graphRoot().getAttribute('data-architecture-lod-depth'), '2');
  });
  assert.equal(host.querySelector('[data-architecture-lod-edges]'), null, 'the package overlay is removed');
  for (const node of host.querySelectorAll('.uml-node')) {
    assert.equal((node as HTMLElement).style.display, '', 'entities are visible again');
  }
  for (const edge of host.querySelectorAll('.uml-edge')) {
    assert.equal((edge as HTMLElement).style.display, '', 'entity UML edges are visible again');
  }
  assert.equal(
    [...host.querySelectorAll('.uml-package[data-package-id="src/modules/alpha"] text')]
      .map((label) => label.textContent)
      .join(''),
    'src/modules/alpha',
    'the collapsed count is restored',
  );
  assert.equal(host.querySelector('svg'), svg, 'still the same drawing after the round trip');
  assert.equal(apiMock.architectureGraph.mock.calls.length, 1, 'zooming never refetches');
});

test('the explosion view lays the whole hierarchy out once and zoom reveals its levels', async () => {
  // The DoD gesture: one full-graph layout, then zoom alone moves from the
  // package level to subpackages and entities — no re-layout in between.
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await waitForDiagram();

  fireEvent.click(screen.getByRole('button', { name: 'Explosion view' }));
  await waitFor(() => {
    assert.equal(graphRoot().getAttribute('data-architecture-view'), 'hierarchy');
    assert.deepEqual(drawnNodeIds(host), [
      'src/modules/alpha/a.ts',
      'src/modules/alpha/a2.ts',
      'src/modules/beta/b.ts',
      'src/modules/gamma/c.ts',
    ], 'the explosion view draws the whole graph, not one group');
  });

  // The initial fit is the near level: entities and their UML edges are drawn,
  // inside the package frames the same layout emitted.
  await waitFor(() => assert.equal(graphRoot().getAttribute('data-architecture-lod-depth'), '2'));
  for (const packageId of ['src/modules/alpha', 'src/modules/beta', 'src/modules/gamma']) {
    assert.ok(host.querySelector(`.uml-package[data-package-id="${packageId}"]`), `frame ${packageId} is drawn`);
  }
  const svg = host.querySelector('svg');
  assert.ok(svg !== null);
  svg.setAttribute('data-lod-sentinel', 'kept');

  for (let step = 0; step < 8; step += 1) {
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
  }
  await waitFor(() => assert.equal(graphRoot().getAttribute('data-architecture-lod-depth'), '0'));

  // The three packages now show their counts and the two cross-package edges;
  // the intra-alpha edge is not a package boundary.
  const labels = [...host.querySelectorAll('.uml-package[data-package-id="src/modules/alpha"] text')]
    .map((label) => label.textContent)
    .join('');
  assert.match(labels, /\(2\)$/, 'the alpha frame states its two entities');
  const packageEdges = [...host.querySelectorAll('[data-architecture-lod-edges] line')]
    .map((line) => `${line.getAttribute('data-lod-edge-source')}->${line.getAttribute('data-lod-edge-target')}`)
    .sort();
  assert.deepEqual(packageEdges, ['src/modules/beta->src/modules/alpha', 'src/modules/gamma->src/modules/beta']);
  assert.equal(host.querySelector('svg'), svg, 'the explosion layout survives the level change');
  assert.equal(svg.getAttribute('data-lod-sentinel'), 'kept');

  for (let step = 0; step < 8; step += 1) {
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
  }
  await waitFor(() => assert.equal(graphRoot().getAttribute('data-architecture-lod-depth'), '2'));
  assert.equal(host.querySelector('[data-architecture-lod-edges]'), null);
  assert.deepEqual(drawnNodeIds(host), [
    'src/modules/alpha/a.ts',
    'src/modules/alpha/a2.ts',
    'src/modules/beta/b.ts',
    'src/modules/gamma/c.ts',
  ]);
  assert.equal(host.querySelector('svg'), svg, 'zooming back in still uses the same drawing');
  assert.equal(apiMock.architectureGraph.mock.calls.length, 1, 'the explosion view never refetches');
});

test('overview folds the graph into path groups; clicking a group expands it locally', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await waitForDiagram();

  assert.equal(document.querySelector('[data-architecture-view]')?.getAttribute('data-architecture-view'), 'overview');
  assert.deepEqual(
    drawnNodeIds(host),
    ['grp::src/modules/alpha', 'src/modules/beta/b.ts', 'src/modules/gamma/c.ts'],
    'the overview groups by directory layer, never by file name; a one-file directory keeps its file as a node',
  );

  fireEvent.click(host.querySelector('[data-entity-id="grp::src/modules/alpha"]') as Element);

  await waitFor(() => {
    assert.equal(
      document.querySelector('[data-architecture-view]')?.getAttribute('data-architecture-view'),
      'group',
    );
    assert.deepEqual(
      drawnNodeIds(host),
      ['src/modules/alpha/a.ts', 'src/modules/alpha/a2.ts'],
      'expanding a group reveals exactly its entities, addressed by their original ids',
    );
  });
  assert.equal(apiMock.architectureGraph.mock.calls.length, 1, 'expanding a group is local — it must not refetch');
});

test('expanding a deep group re-groups its subtree by directory instead of flattening its files', async () => {
  apiMock.architectureGraph.mockResolvedValue(jsonResponse(DEEP_TREE_RESULT));
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await waitForDiagram();

  // Overview: the group bound stops the fold at the package layer (12 groups,
  // depth 4 would be 48). No group is named after a file.
  assert.equal(drawnNodeIds(host).length, 12, 'the overview stops at the package layer');
  assert.ok(drawnNodeIds(host).every((id) => /^grp::src\/packages\/mod-\d+$/.test(id)));
  assert.match(host.innerHTML, /src\/packages\/mod-0 \(20\)/, 'each group label carries its entity count');

  // Expanding one package must apply the SAME directory rule to its subtree:
  // four unit groups, not the 20 file nodes inside it.
  fireEvent.click(host.querySelector('[data-entity-id="grp::src/packages/mod-0"]') as Element);
  await waitFor(() => {
    assert.equal(
      document.querySelector('[data-architecture-view]')?.getAttribute('data-architecture-view'),
      'group',
    );
    assert.deepEqual(drawnNodeIds(host), [
      'grp::src/packages/mod-0/unit-0',
      'grp::src/packages/mod-0/unit-1',
      'grp::src/packages/mod-0/unit-2',
      'grp::src/packages/mod-0/unit-3',
    ], 'the group view groups the subtree by directory instead of listing every file');
  });
  assert.ok(
    !drawnNodeIds(host).some((id) => id.endsWith('.ts')),
    'no file of the expanded directory is drawn as its own node',
  );
  assert.match(host.innerHTML, /src\/packages\/mod-0\/unit-0 \(5\)/, 'unit groups carry their own counts');
  assert.equal(apiMock.architectureGraph.mock.calls.length, 1, 're-grouping is local — never a refetch');
});

test('expanding a flat directory larger than the group limit draws its files, not the same box again', async () => {
  // File-graph ids: project-relative, so `scripts/` is a real directory. 45
  // files is over `OVERVIEW_GROUP_LIMIT`, which used to keep the expansion a
  // single `scripts (45)` box — clicking it navigated to itself forever.
  const nodes = Array.from({ length: 45 }, (_unused, index) => {
    const name = `tool-${String(index).padStart(2, '0')}.ts`;
    return { id: `scripts/${name}`, label: name, distance: index % 5 };
  });
  const result: ArchitectureGraphResult = {
    mmd: { file: FILE_MMD, entity: ENTITY_MMD },
    graph: {
      file: { nodes, edges: [] },
      entity: { nodes: [], edges: [] },
    },
    stats: {
      ...RESULT.stats,
      entityNodes: 0,
      entityEdges: 0,
      fileNodes: 45,
      fileEdges: 0,
      truncated: false,
      entityTruncated: false,
      nodeCount: 45,
      edgeCount: 0,
      unresolved: { files: [], identifiers: [] },
    },
    provenance: RESULT.provenance,
  };
  apiMock.architectureGraph.mockResolvedValue(jsonResponse(result));
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await waitForDiagram();

  // The overview folds the directory into one counted box.
  assert.deepEqual(drawnNodeIds(host), ['grp::scripts']);
  assert.match(host.textContent ?? '', /scripts \(45\)/);

  fireEvent.click(host.querySelector('[data-entity-id="grp::scripts"]') as Element);

  await waitFor(() => {
    assert.equal(
      document.querySelector('[data-architecture-view]')?.getAttribute('data-architecture-view'),
      'group',
    );
    assert.equal(drawnNodeIds(host).length, 45, 'the expansion draws every file in the directory');
  });
  // The drawing is no longer the source box: more than one class, and none of
  // them is labelled with the group that was clicked.
  const labels = [...host.querySelectorAll('.uml-node text')].map((label) => label.textContent ?? '');
  assert.ok(labels.length > 1, `the group view is a real expansion; labels: ${labels.join(' | ')}`);
  assert.ok(
    !labels.some((label) => label.trim() === 'scripts (45)'),
    'the source group label must not survive the expansion',
  );
  assert.equal(apiMock.architectureGraph.mock.calls.length, 1, 'expanding a group is local — it must not refetch');
});

test('the overview never draws a (1) group and names an isolated file by its directory', async () => {
  apiMock.architectureGraph.mockResolvedValue(jsonResponse(ISOLATED_FILE_RESULT));
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await waitForDiagram();

  // Only the two-file directory stays a group. Each one-file directory is drawn
  // as the file itself — no `(1)` box survives, in either order of the fold.
  assert.deepEqual(drawnNodeIds(host), [
    'grp::plugin/scripts',
    'orchestration/manager-visual-check.py',
    'packages/quay/scripts/stamp-version.ts',
    'scripts/stamp-version.ts',
  ]);
  assert.doesNotMatch(host.textContent ?? '', /\(1\)/, 'a one-member group is noise, never a label');

  // The isolated node's label is a PATH, not a bare file name: that is what the
  // file graph's `scripts/stamp-version.ts` used to lose when its first
  // directory was peeled as if it were a scope key.
  const labels = [...host.querySelectorAll('.uml-node text')].map((label) => label.textContent ?? '');
  assert.ok(labels.includes('scripts/stamp-version.ts'), `the isolated file keeps its directory; labels: ${labels.join(' | ')}`);
  // Two files with the same name in different directories stay distinguishable.
  assert.ok(labels.includes('packages/quay/scripts/stamp-version.ts'));

  // The counted group keeps its project-relative prefix and its count.
  assert.match(host.textContent ?? '', /plugin\/scripts \(2\)/);
});

test('the bridge labels an isolated file graph node like a group label, with its directory', () => {
  const graph = ISOLATED_FILE_RESULT.graph.file;
  const { puml, nodeIds } = archguardToPlantUml(graph, { grouping: 'adaptive', idShape: 'project-relative' });

  assert.deepEqual(nodeIds, [
    'grp::plugin/scripts',
    'scripts/stamp-version.ts',
    'orchestration/manager-visual-check.py',
    'packages/quay/scripts/stamp-version.ts',
  ]);
  assert.match(puml, /class "scripts\/stamp-version\.ts" as n2/, 'the isolated node is named by its path');
  assert.match(puml, /class "orchestration\/manager-visual-check\.py" as n3/);
  assert.doesNotMatch(puml, /class "stamp-version\.ts"/, 'a bare file name is the bug this pins');
  assert.doesNotMatch(puml, /\(1\)/, 'no group label may carry a count of one');
  // Folding a singleton does not drop its edges: the node keeps its own alias,
  // and the edge is aggregated onto the alias of whatever it points at (here
  // the counted group `g0`).
  assert.match(puml, /n2 \.\.> g0 : <<call>>/);
});

test('the display name keeps a file graph\'s first directory and strips only an entity graph\'s scope key', () => {
  // The same string read both ways: the file graph must keep `scripts/`; the
  // entity graph (`scripts` is its opaque scope key there) must drop it.
  assert.equal(displayName('scripts/stamp-version.ts', MAX_DISPLAY_DIR_SEGMENTS, 'project-relative'), 'scripts/stamp-version.ts');
  assert.equal(displayName('scripts/stamp-version.ts', MAX_DISPLAY_DIR_SEGMENTS, 'scope-prefixed'), 'stamp-version.ts');
});

test('clicking an entity drills into its neighbourhood, and the centre click adds a hop', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await waitForDiagram();

  fireEvent.click(host.querySelector('[data-entity-id="grp::src/modules/alpha"]') as Element);
  await waitFor(() => {
    assert.ok(host.querySelector('[data-entity-id="src/modules/alpha/a2.ts"]'));
  });

  fireEvent.click(host.querySelector('[data-entity-id="src/modules/alpha/a2.ts"]') as Element);

  await waitFor(() => {
    assert.equal(
      document.querySelector('[data-architecture-hops]')?.getAttribute('data-architecture-hops'),
      '1',
    );
    assert.deepEqual(
      drawnNodeIds(host),
      ['src/modules/alpha/a.ts', 'src/modules/alpha/a2.ts', 'src/modules/beta/b.ts'],
      'one hop from a2 is a2, its dependency a, and its caller b',
    );
  });
  assert.equal(
    host.querySelector('[data-entity-id="src/modules/alpha/a2.ts"]')?.classList.contains('arch-center'),
    true,
    'the drilled entity is marked as the neighbourhood centre',
  );

  // Clicking the centred entity again is the "drill one hop deeper" gesture.
  fireEvent.click(host.querySelector('[data-entity-id="src/modules/alpha/a2.ts"]') as Element);

  await waitFor(() => {
    assert.equal(
      document.querySelector('[data-architecture-hops]')?.getAttribute('data-architecture-hops'),
      '2',
      'clicking the centre again must add exactly one hop',
    );
    assert.deepEqual(
      drawnNodeIds(host),
      [
        'src/modules/alpha/a.ts',
        'src/modules/alpha/a2.ts',
        'src/modules/beta/b.ts',
        'src/modules/gamma/c.ts',
      ],
      'hop 2 reaches gamma/c through beta/b',
    );
  });
  assert.equal(apiMock.architectureGraph.mock.calls.length, 1, 'drilling is local — the payload arrived whole');
});

/** Edge-label `<text>` elements that are actually rendered (not `display="none"`). */
function visibleEdgeLabels(host: HTMLElement): Element[] {
  return [...host.querySelectorAll('.uml-edge text')]
    .filter((label) => label.getAttribute('display') !== 'none');
}

test('edge relation labels stay hidden until a node is hovered, then leave with the pointer', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await waitForDiagram();

  // The renderer still draws the `<<uses>>`/`<<call>>` labels — the drawing is
  // the same document — but none of them is visible while nothing is hovered.
  assert.ok(host.querySelectorAll('.uml-edge text').length > 0, 'the renderer drew the relation labels');
  assert.deepEqual(visibleEdgeLabels(host), [], 'a default drawing shows no edge label text');

  // Two edges meet at beta/b: its `call` onto the alpha group, and the
  // `inheritance` coming from gamma/c. Only the call carries a label — the
  // inheritance arrow SHAPE is its semantics (the relation table gives it no
  // text) — so hovering reveals exactly one label.
  const hovered = host.querySelector('[data-entity-id="src/modules/beta/b.ts"]') as Element;
  const outEdge = drawnEdge(host, 'src/modules/beta/b.ts', 'grp::src/modules/alpha');
  const inEdge = drawnEdge(host, 'src/modules/gamma/c.ts', 'src/modules/beta/b.ts');
  fireEvent.mouseOver(hovered);

  const visible = visibleEdgeLabels(host);
  assert.equal(visible.length, 1, 'only the hovered node’s own labelled edge shows its relation text');
  assert.equal(visible[0]?.textContent, '<<call>>', 'the revealed text is the relation kind');
  assert.ok(outEdge.contains(visible[0] ?? null), 'and it belongs to the call edge');
  assert.equal(inEdge.querySelectorAll('text').length, 0, 'the inheritance edge is drawn by its arrow, not a label');

  fireEvent.mouseOut(hovered);
  assert.deepEqual(visibleEdgeLabels(host), [], 'leaving the node hides every edge label again');
});

test('entity boxes are UML class shapes, and a session seed carries the seed marker', async () => {
  apiMock.architectureGraph.mockResolvedValue(jsonResponse(CLASS_DIAGRAM_RESULT));
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  await waitForDiagram();

  fireEvent.click(screen.getByRole('radio', { name: 'Class diagram' }));
  const host = await waitForDiagram();
  await waitFor(() => assert.ok(host.querySelector('[data-entity-id="grp::modules/alpha"]')));
  fireEvent.click(host.querySelector('[data-entity-id="grp::modules/alpha"]') as Element);
  await waitFor(() => assert.ok(host.querySelector('[data-entity-id="src/modules/alpha/halt.ts.haltVerdict"]')));

  const nodeOf = (id: string): Element => {
    const node = host.querySelector(`[data-entity-id="${id}"]`);
    assert.ok(node !== null, `${id} must be drawn`);
    return node;
  };

  // The function is a single-compartment box with its stereotype.
  const functionNode = nodeOf('src/modules/alpha/halt.ts.haltVerdict');
  assert.match(functionNode.textContent ?? '', /<<function>>/, 'a function box carries the <<function>> stereotype');

  // The interface carries its own stereotype; the class draws its compartments.
  assert.match(nodeOf('src/modules/alpha/reader.ts.Reader').textContent ?? '', /<<interface>>/);
  const classNode = nodeOf('src/modules/alpha/store.ts.Store');
  assert.match(classNode.textContent ?? '', /- threshold: number/, 'a private field row keeps its symbol');
  assert.match(classNode.textContent ?? '', /\+ put\(value: number\): void/, 'a method row keeps its signature');

  // The label is the bare entity name; the file it lives in is in the tooltip.
  assert.equal(
    classNode.querySelector('title')?.textContent,
    'modules/alpha/store.ts',
    'the hover title carries the file the box no longer spells out',
  );

  // The transcript seed (distance 0) is marked by an attribute the stylesheet
  // turns into the thicker frame — a non-colour reading.
  assert.equal(functionNode.getAttribute('data-architecture-seed'), 'true', 'a seed node carries the seed marker');
  assert.equal(classNode.getAttribute('data-architecture-seed'), null, 'a non-seed node does not');
});

test('only a direct mention carries the seed marker; name/file tiers and old payloads are read correctly', async () => {
  apiMock.architectureGraph.mockResolvedValue(jsonResponse(MENTION_TIER_RESULT));
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  await waitForDiagram();

  fireEvent.click(screen.getByRole('radio', { name: 'Class diagram' }));
  const host = await waitForDiagram();
  await waitFor(() => assert.ok(host.querySelector('[data-entity-id="grp::modules/tiers"]')));
  fireEvent.click(host.querySelector('[data-entity-id="grp::modules/tiers"]') as Element);
  await waitFor(() => assert.ok(host.querySelector('[data-entity-id="src/modules/tiers/Direct.ts.Direct"]')));

  const marker = (id: string): string | null => {
    const node = host.querySelector(`[data-entity-id="${id}"]`);
    assert.ok(node !== null, `${id} must be drawn`);
    return node.getAttribute('data-architecture-seed');
  };

  // `direct` is the only tier the UI draws as a session seed.
  assert.equal(marker('src/modules/tiers/Direct.ts.Direct'), 'true', 'a direct mention is a seed');
  // `name` and `file` are still distance 0, but they are NOT seeds.
  assert.equal(marker('src/modules/tiers/Name.ts.Name'), null, 'a same-name candidate is not a seed');
  assert.equal(marker('src/modules/tiers/File.ts.File'), null, 'a file-only expansion is not a seed');
  // A payload written before mentionTier existed keeps the legacy reading.
  assert.equal(marker('src/modules/tiers/Legacy.ts.Legacy'), 'true', 'an old payload still marks distance-0 nodes');
});

test('hovering a node highlights its in/out edges and dims the rest', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await waitForDiagram();

  fireEvent.click(host.querySelector('[data-entity-id="grp::src/modules/alpha"]') as Element);
  await waitFor(() => assert.ok(host.querySelector('[data-entity-id="src/modules/alpha/a2.ts"]')));
  fireEvent.click(host.querySelector('[data-entity-id="src/modules/alpha/a2.ts"]') as Element);
  await waitFor(() => {
    assert.equal(document.querySelector('[data-architecture-hops]')?.getAttribute('data-architecture-hops'), '1');
    assert.deepEqual(drawnNodeIds(host), [
      'src/modules/alpha/a.ts',
      'src/modules/alpha/a2.ts',
      'src/modules/beta/b.ts',
    ]);
  });
  fireEvent.click(host.querySelector('[data-entity-id="src/modules/alpha/a2.ts"]') as Element);
  await waitFor(() => {
    assert.equal(document.querySelector('[data-architecture-hops]')?.getAttribute('data-architecture-hops'), '2');
    assert.deepEqual(drawnNodeIds(host), [
      'src/modules/alpha/a.ts',
      'src/modules/alpha/a2.ts',
      'src/modules/beta/b.ts',
      'src/modules/gamma/c.ts',
    ]);
  });

  const hovered = host.querySelector('[data-entity-id="src/modules/beta/b.ts"]') as Element;
  fireEvent.mouseOver(hovered);

  const outEdge = drawnEdge(host, 'src/modules/beta/b.ts', 'src/modules/alpha/a2.ts');
  const inEdge = drawnEdge(host, 'src/modules/gamma/c.ts', 'src/modules/beta/b.ts');
  const unrelated = drawnEdge(host, 'src/modules/alpha/a2.ts', 'src/modules/alpha/a.ts');

  assert.equal(outEdge.classList.contains('arch-hl-out'), true, 'the hovered node outgoing edge is highlighted');
  assert.equal(inEdge.classList.contains('arch-hl-in'), true, 'the hovered node incoming edge is highlighted');
  assert.equal(unrelated.classList.contains('arch-dim'), true, 'unrelated edges are dimmed');
  assert.equal(
    document.querySelector('[data-architecture-hover]')?.getAttribute('data-architecture-hover'),
    'src/modules/beta/b.ts',
  );

  fireEvent.mouseOut(hovered);
  assert.equal(outEdge.classList.contains('arch-hl-out'), false, 'leaving the node clears the highlight');
  assert.equal(unrelated.classList.contains('arch-dim'), false, 'leaving the node restores the dimmed edges');
  assert.equal(document.querySelector('[data-architecture-hover]'), null);
});

test('the drawn SVG carries the stable ids sibling panels query', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await waitForDiagram();

  fireEvent.click(host.querySelector('[data-entity-id="grp::src/modules/alpha"]') as Element);
  await waitFor(() => assert.ok(host.querySelector('[data-entity-id="src/modules/alpha/a2.ts"]')));
  fireEvent.click(host.querySelector('[data-entity-id="src/modules/alpha/a2.ts"]') as Element);
  await waitFor(() => {
    assert.equal(document.querySelector('[data-architecture-hops]')?.getAttribute('data-architecture-hops'), '1');
    // Wait for the neighbourhood SVG itself, not just the view attribute React
    // commits synchronously: the renderer replaces the SVG asynchronously.
    assert.deepEqual(drawnNodeIds(host), [
      'src/modules/alpha/a.ts',
      'src/modules/alpha/a2.ts',
      'src/modules/beta/b.ts',
    ]);
  });

  // Nodes are addressable by their ArchGuard id, not the PlantUML alias the
  // renderer was given, and every edge carries its relation kind.
  assert.ok(host.querySelector('[data-entity-id="src/modules/alpha/a2.ts"]'), 'nodes expose data-entity-id');
  const outEdge = drawnEdge(host, 'src/modules/alpha/a2.ts', 'src/modules/alpha/a.ts');
  assert.equal(outEdge.getAttribute('data-edge-source'), 'src/modules/alpha/a2.ts');
  assert.equal(outEdge.getAttribute('data-edge-target'), 'src/modules/alpha/a.ts');
  assert.equal(outEdge.getAttribute('data-edge-type'), 'dependency', 'edges expose the ArchGuard relation kind');
});

test('clicking an entity pins its in/out highlight and announces it to sibling panels', async () => {
  const selections: Array<{ id: string; incoming: string[]; outgoing: string[] }> = [];
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<{ id: string; incoming: string[]; outgoing: string[] }>).detail;
    selections.push({ id: detail.id, incoming: [...detail.incoming], outgoing: [...detail.outgoing] });
  };
  window.addEventListener('architecture:entity-selected', listener);
  try {
    render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
    const host = await waitForDiagram();

    fireEvent.click(host.querySelector('[data-entity-id="grp::src/modules/alpha"]') as Element);
    await waitFor(() => assert.ok(host.querySelector('[data-entity-id="src/modules/alpha/a2.ts"]')));
    fireEvent.click(host.querySelector('[data-entity-id="src/modules/alpha/a2.ts"]') as Element);
    await waitFor(() => {
      assert.equal(document.querySelector('[data-architecture-hops]')?.getAttribute('data-architecture-hops'), '1');
      assert.deepEqual(drawnNodeIds(host), [
        'src/modules/alpha/a.ts',
        'src/modules/alpha/a2.ts',
        'src/modules/beta/b.ts',
      ]);
    });
    // A second click on the centre deepens the neighbourhood; the gamma edge is
    // then drawn and must be the one left dimmed.
    fireEvent.click(host.querySelector('[data-entity-id="src/modules/alpha/a2.ts"]') as Element);
    await waitFor(() => {
      assert.equal(document.querySelector('[data-architecture-hops]')?.getAttribute('data-architecture-hops'), '2');
      assert.deepEqual(drawnNodeIds(host), [
        'src/modules/alpha/a.ts',
        'src/modules/alpha/a2.ts',
        'src/modules/beta/b.ts',
        'src/modules/gamma/c.ts',
      ]);
    });

    const outEdge = drawnEdge(host, 'src/modules/alpha/a2.ts', 'src/modules/alpha/a.ts');
    const inEdge = drawnEdge(host, 'src/modules/beta/b.ts', 'src/modules/alpha/a2.ts');
    const unrelated = drawnEdge(host, 'src/modules/gamma/c.ts', 'src/modules/beta/b.ts');
    assert.equal(outEdge.classList.contains('arch-hl-out'), true, 'the clicked entity outgoing edge is highlighted');
    assert.equal(inEdge.classList.contains('arch-hl-in'), true, 'the clicked entity incoming edge is highlighted');
    assert.equal(unrelated.classList.contains('arch-dim'), true, 'edges outside the dependency/reverse-dependency set are dimmed');

    // Unlike a hover reading, the click selection survives leaving the node.
    fireEvent.mouseOut(host.querySelector('[data-entity-id="src/modules/alpha/a2.ts"]') as Element);
    assert.equal(outEdge.classList.contains('arch-hl-out'), true, 'leaving the node keeps the pinned selection');

    assert.deepEqual(
      selections.at(-1),
      {
        id: 'src/modules/alpha/a2.ts',
        incoming: ['src/modules/beta/b.ts'],
        outgoing: ['src/modules/alpha/a.ts'],
      },
      'the announced in/out neighbours come from the neighbourhood JSON, not the visible slice',
    );
    assert.equal(apiMock.architectureGraph.mock.calls.length, 1, 'selection and drilling are local — never a refetch');
  } finally {
    window.removeEventListener('architecture:entity-selected', listener);
  }
});

test('a sibling panel selects an entity by its stable id and the graph drills to it', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await waitForDiagram();

  // The documented cross-panel contract: any module that knows an ArchGuard
  // entity id (e.g. a file referenced in chat) asks the graph for it.
  act(() => {
    window.dispatchEvent(new CustomEvent('architecture:highlight-entity', {
      detail: { id: 'src/modules/beta/b.ts' },
    }));
  });

  await waitFor(() => {
    assert.equal(
      document.querySelector('[data-architecture-view]')?.getAttribute('data-architecture-view'),
      'neighborhood',
      'an external selection is brought into view',
    );
    assert.deepEqual(
      drawnNodeIds(host),
      ['src/modules/alpha/a2.ts', 'src/modules/beta/b.ts', 'src/modules/gamma/c.ts'],
      'the selected entity is drawn with its in/out neighbours',
    );
  });

  const outEdge = drawnEdge(host, 'src/modules/beta/b.ts', 'src/modules/alpha/a2.ts');
  const inEdge = drawnEdge(host, 'src/modules/gamma/c.ts', 'src/modules/beta/b.ts');
  assert.equal(outEdge.classList.contains('arch-hl-out'), true, 'the selected entity outgoing edge is highlighted');
  assert.equal(inEdge.classList.contains('arch-hl-in'), true, 'the selected entity incoming edge is highlighted');
  assert.equal(apiMock.architectureGraph.mock.calls.length, 1, 'an external selection never re-enters the fetch');
});

test('activating the panel fetches once and the file/entity toggle never refetches', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await waitForDiagram();

  assert.deepEqual(
    apiMock.architectureGraph.mock.calls,
    [['project-1', 'session-1', 2]],
    'activation must POST exactly once for the selected project/session at the default depth',
  );
  // The two subgraphs are read with DIFFERENT id shapes from the same payload:
  // the entity ids carry the opaque scope key (`src` here) as their first
  // segment, while the file ids are already project-relative, so `src/` IS a
  // directory there and stays in the group prefix.
  assert.ok(host.querySelector('[data-entity-id="grp::src/modules/alpha"]'), 'the file graph is drawn first');

  fireEvent.click(screen.getByRole('radio', { name: 'Class diagram' }));
  // Changing granularity remounts the graph (the panel keys it by session+granularity),
  // so re-acquire the host rather than reusing the file graph's detached element.
  const entityHost = await waitForDiagram();
  await waitFor(() => {
    assert.ok(entityHost.querySelector('[data-entity-id="grp::modules/alpha"]'), 'the entity graph opens at the overview');
  });
  // Expanding a group proves the entity payload is the one being drawn: its
  // entity ids are `<scope>/<relpath>.<EntityName>`, unlike the file keys.
  fireEvent.click(entityHost.querySelector('[data-entity-id="grp::modules/alpha"]') as Element);
  await waitFor(() => {
    assert.ok(
      entityHost.querySelector('[data-entity-id="src/modules/alpha/A.ts.Alpha"]'),
      'the entity graph is drawn from the same payload',
    );
  });
  assert.equal(
    apiMock.architectureGraph.mock.calls.length,
    1,
    'the entity toggle selects a subgraph that is already in hand — it must not refetch',
  );

  fireEvent.click(screen.getByRole('radio', { name: 'File graph' }));
  const fileHost = await waitForDiagram();
  await waitFor(() => assert.ok(fileHost.querySelector('[data-entity-id="grp::src/modules/alpha"]')));
  assert.equal(apiMock.architectureGraph.mock.calls.length, 1);
});

test('the renderer is reached through a dynamic import, never the first-screen chunk', () => {
  const graphSource = readFileSync(
    resolve(process.cwd(), 'src', 'modules', 'architecture', 'PlantUmlGraph.tsx'),
    'utf8',
  );
  const bridgeSource = readFileSync(
    resolve(process.cwd(), 'src', 'modules', 'architecture', 'archguardToPlantUml.ts'),
    'utf8',
  );

  assert.match(
    graphSource,
    /await import\(['"]@yalehwang\/plantuml-js\/elk['"]\)/,
    'the ELK renderer must be loaded with a dynamic import',
  );
  assert.ok(
    !graphSource.includes("from '@yalehwang/plantuml-js/elk'")
      && !graphSource.includes("from '@yalehwang/plantuml-js'"),
    'a static renderer import would pull elkjs into the first-screen chunk',
  );
  // The bridge may only touch the package's zero-dependency archguard entry;
  // the bare package and the ELK entry both carry the renderer.
  assert.match(
    bridgeSource,
    /from ['"]@yalehwang\/plantuml-js\/archguard['"]/,
    'the relation table comes from the package bridge entry',
  );
  assert.ok(
    !bridgeSource.includes("from '@yalehwang/plantuml-js/elk'")
      && !bridgeSource.includes("from '@yalehwang/plantuml-js'"),
    'the bridge must not import the package entry that carries the renderer',
  );
});

test('the truncation reading follows the current granularity and appends the omitted count', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  await waitForDiagram();

  // The source line states a RELATIVE age and keeps the exact local instant in
  // `title` — the raw UTC ISO string is no longer the visible reading.
  const generatedAt = document.querySelector('[data-architecture-generated-at]');
  assert.ok(generatedAt instanceof HTMLTimeElement);
  assert.match(generatedAt.textContent ?? '', /ago|now/i, 'the analysis time is a relative reading');
  assert.notEqual(generatedAt.textContent, GENERATED_AT, 'the raw UTC ISO string must not be shown');
  assert.equal(generatedAt.getAttribute('dateTime'), GENERATED_AT, 'the machine-readable instant is kept');
  assert.ok(
    (generatedAt.getAttribute('title') ?? '').length > 0
      && generatedAt.getAttribute('title') !== GENERATED_AT,
    'the title carries the precise LOCAL time, not the UTC ISO string',
  );

  const unresolved = document.querySelector('[data-architecture-unresolved]');
  assert.equal(unresolved?.getAttribute('data-architecture-unresolved'), '2');
  assert.match(
    unresolved?.textContent ?? '',
    /^2 names mentioned in this session were not found in the analysis cache/,
    `both unresolved seeds (1 file + 1 identifier) must be counted; got ${unresolved?.textContent}`,
  );

  // The default view is the file graph, which has its own budget and was NOT
  // truncated: the entity cut must not leak a notice onto it.
  assert.equal(
    document.querySelector('[data-architecture-truncated]'),
    null,
    'a complete file graph must not claim to be truncated',
  );

  fireEvent.click(screen.getByRole('radio', { name: 'Class diagram' }));
  await waitForDiagram();
  const truncated = document.querySelector('[data-architecture-truncated]');
  assert.ok(truncated, 'the truncated entity reading must say so');
  assert.equal(truncated.getAttribute('data-architecture-truncated-granularity'), 'entity');
  assert.equal(truncated.getAttribute('data-architecture-truncated-shown'), '4');
  assert.equal(truncated.getAttribute('data-architecture-truncated-total'), '9');
  assert.equal(truncated.getAttribute('data-architecture-truncated-omitted'), '5');
  // The truncation is appended to the one-line readout, in the same sentence
  // shape as the "showing N of M" reading — not a separate amber row.
  assert.match(truncated.textContent ?? '', /5 more left out by the node budget/);
  assert.equal(document.querySelector('[data-architecture-hops-advice]'), null);
  // The server's node budget never appears as a number in the UI.
  assert.doesNotMatch(document.body.textContent ?? '', /\b\d+ of \d+ (files|entities)\b/);
  assert.doesNotMatch(document.body.textContent ?? '', /node budget \d+/i);
});


test('the scope stepper re-requests the selected depth and clamps to 0..3', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  await waitForDiagram();

  assert.deepEqual(
    apiMock.architectureGraph.mock.calls,
    [['project-1', 'session-1', 2]],
    'the first request asks for the remembered default depth',
  );

  const readout = (): HTMLElement | null => document.querySelector('[role="spinbutton"]');
  assert.ok(readout() instanceof HTMLElement, 'the scope control is a spinbutton, not three pressed buttons');
  // The old three-button vocabulary is gone in every form it could survive in.
  assert.equal(document.querySelector('[data-architecture-hops-option]'), null);
  assert.equal(document.querySelector('[data-architecture-hops-control]'), null);
  assert.equal(screen.queryByRole('button', { name: /Hops/ }), null, 'no control may still be called Hops');
  assert.equal(readout()?.getAttribute('aria-valuenow'), '2');
  assert.equal(readout()?.getAttribute('aria-valuemin'), '0');
  assert.equal(readout()?.getAttribute('aria-valuemax'), '3');
  assert.equal(readout()?.textContent, '+2', 'the displayed value is the +N form the reader asked for');
  assert.equal(readout()?.getAttribute('aria-valuetext'), '+2');

  fireEvent.click(document.querySelector('[data-architecture-scope-decrease]') as Element);
  await waitFor(() => assert.equal(apiMock.architectureGraph.mock.calls.length, 2));
  assert.deepEqual(
    apiMock.architectureGraph.mock.calls[1],
    ['project-1', 'session-1', 1],
    'lowering the scope must refetch with hops=1',
  );
  assert.equal(readout()?.getAttribute('aria-valuenow'), '1', 'aria-valuenow follows the displayed value');
  assert.equal(readout()?.textContent, '+1');

  // Walk down to the floor; the − control is disabled and a click cannot go
  // below it (the clamp also holds if a stale stored value or key event tries).
  fireEvent.click(document.querySelector('[data-architecture-scope-decrease]') as Element);
  await waitFor(() => assert.equal(apiMock.architectureGraph.mock.calls.length, 3));
  assert.deepEqual(apiMock.architectureGraph.mock.calls[2], ['project-1', 'session-1', 0]);
  const decrease = document.querySelector('[data-architecture-scope-decrease]');
  assert.ok(decrease instanceof HTMLButtonElement);
  assert.equal(decrease.disabled, true, 'the stepper disables − at scope 0');
  fireEvent.click(decrease);
  await waitForDiagram();
  assert.equal(apiMock.architectureGraph.mock.calls.length, 3, 'scope 0 is the floor — no further request');
  assert.equal(readout()?.getAttribute('aria-valuenow'), '0');

  // Walk up to the ceiling; + is then disabled too.
  for (let step = 0; step < 3; step += 1) {
    fireEvent.click(document.querySelector('[data-architecture-scope-increase]') as Element);
    await waitFor(() => assert.equal(apiMock.architectureGraph.mock.calls.length, 4 + step));
  }
  assert.deepEqual(
    apiMock.architectureGraph.mock.calls.map((call) => call[2]),
    [2, 1, 0, 1, 2, 3],
    'each step asks the server for exactly its depth',
  );
  const increase = document.querySelector('[data-architecture-scope-increase]');
  assert.ok(increase instanceof HTMLButtonElement);
  assert.equal(increase.disabled, true, 'the stepper disables + at scope 3');
  fireEvent.click(increase);
  await waitForDiagram();
  assert.equal(apiMock.architectureGraph.mock.calls.length, 6, 'scope 3 is the ceiling — no further request');
});

test('the detail presets cut the arrived graph without re-requesting it', async () => {
  const seen: ArchitectureRendererProps[] = [];
  function StandInRenderer(props: ArchitectureRendererProps) {
    seen.push(props);
    return <div data-stand-in-renderer="true" data-stand-in-nodes={props.graph.nodes.length} />;
  }

  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" renderer={StandInRenderer} />);
  await waitFor(() => assert.ok(seen.length > 0));
  assert.equal(apiMock.architectureGraph.mock.calls.length, 1);

  const latest = (): ArchitectureRendererProps => {
    const props = seen.at(-1);
    if (props === undefined) throw new Error('the stand-in renderer was never rendered');
    return props;
  };

  // `all` is the default and the identity: the whole four-node fixture arrives.
  assert.equal(document.querySelector('[data-architecture-detail-option="all"]')?.getAttribute('aria-checked'), 'true');
  assert.equal(latest().graph.nodes.length, 4);
  assert.deepEqual(latest().detailReading, { shown: 4, totalInScope: 4 });

  // `core` keeps the distance-0 seed plus ceil(3 * 0.15) = 1 non-seed node.
  fireEvent.click(document.querySelector('[data-architecture-detail-option="core"]') as Element);
  await waitFor(() => assert.equal(latest().detailReading?.shown, 2));
  assert.equal(apiMock.architectureGraph.mock.calls.length, 1, 'detail is a local cut — never a refetch');
  assert.deepEqual(latest().detailReading, { shown: 2, totalInScope: 4 });
  assert.ok(
    latest().graph.nodes.some((node) => node.distance === 0),
    'the transcript seed survives the core tier',
  );
  assert.deepEqual(
    latest().graph.nodes.map((node) => node.id),
    ['src/modules/alpha/a.ts', 'src/modules/alpha/a2.ts'],
    'the nearest non-seed node is the one core keeps',
  );

  // `common` keeps ceil(3 * 0.5) = 2 non-seed nodes, so the tiers nest.
  fireEvent.click(document.querySelector('[data-architecture-detail-option="common"]') as Element);
  await waitFor(() => assert.equal(latest().detailReading?.shown, 3));
  assert.equal(apiMock.architectureGraph.mock.calls.length, 1);
  assert.deepEqual(latest().detailReading, { shown: 3, totalInScope: 4 });
});

test('the one-line readout reports the shown and in-scope numbers from the detail knob', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  await waitForDiagram();

  // The on-canvas readout is the single place the two numbers are stated.
  const summary = (): Element | null => document.querySelector('[data-architecture-readout-summary]');
  assert.ok(summary() instanceof HTMLElement);
  assert.equal(summary()?.getAttribute('data-architecture-readout-summary'), '4');
  assert.equal(summary()?.getAttribute('data-architecture-readout-total'), '4');
  assert.match(summary()?.textContent ?? '', /Showing 4 files · 4 related/);
  assert.equal(
    document.querySelector('[data-architecture-layout-budget]'),
    null,
    'a graph within the layout budget adds no sentence to the readout',
  );

  fireEvent.click(document.querySelector('[data-architecture-detail-option="core"]') as Element);
  await waitFor(() => {
    assert.equal(summary()?.getAttribute('data-architecture-readout-summary'), '2');
    assert.equal(summary()?.getAttribute('data-architecture-readout-total'), '4');
    assert.match(summary()?.textContent ?? '', /Showing 2 files · 4 related/);
  });
  assert.equal(document.querySelector('[data-architecture-folded-badge]')?.getAttribute('data-architecture-folded-badge'), '2');
  assert.equal(apiMock.architectureGraph.mock.calls.length, 1, 'no step of the detail knob may refetch');
});

test('an over-budget graph is capped before layout, and the readout says so with no render-all escape', async () => {
  apiMock.architectureGraph.mockResolvedValue(jsonResponse(OVER_BUDGET_RESULT));
  const seen: ArchitectureRendererProps[] = [];
  function StandInRenderer(props: ArchitectureRendererProps) {
    seen.push(props);
    return null;
  }

  // The reviewed Chinese wording is the one this task promises the reader.
  await i18next.changeLanguage('zh-CN');
  try {
    render(
      <ArchitecturePanel
        projectId="project-1"
        sessionId="session-1"
        initialGranularity="file"
        renderer={StandInRenderer}
      />,
    );

    const budget = await waitFor(() => {
      const element = document.querySelector('[data-architecture-layout-budget]');
      assert.ok(element instanceof HTMLElement, 'the readout must state the layout budget');
      return element;
    });
    // 650 nodes at the identity tier do not fit 600, so the budget falls back
    // to `common`, the highest detail tier that does (ceil(650 × 0.5)).
    assert.equal(budget.getAttribute('data-architecture-layout-budget'), '325');
    assert.equal(budget.getAttribute('data-architecture-layout-budget-tier'), 'common');
    assert.equal(budget.getAttribute('data-architecture-layout-budget-dropped'), '325');
    assert.match(budget.textContent ?? '', /已按布局预算显示 325 个/);
    assert.match(budget.textContent ?? '', /调高详情会更慢/);

    // The renderer receives the capped graph, never the payload's full 650.
    assert.equal(seen.at(-1)?.graph.nodes.length, 325, 'the budget is applied BEFORE the layout');

    // A freeze cannot be interrupted on the main thread, so there is no
    // "render it all anyway" escape to offer.
    assert.equal(document.querySelector('[data-architecture-layout-budget-all]'), null);
    assert.doesNotMatch(
      document.querySelector('[data-architecture-readout]')?.textContent ?? '',
      /仍然全部渲染|render (it )?all/i,
    );
  } finally {
    await i18next.changeLanguage('en');
  }
});

test('both knobs are remembered per project across sessions and remounts', async () => {
  const first = render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  await waitForDiagram();

  fireEvent.click(document.querySelector('[data-architecture-scope-decrease]') as Element);
  await waitFor(() => assert.equal(apiMock.architectureGraph.mock.calls.at(-1)?.[2], 1));
  fireEvent.click(document.querySelector('[data-architecture-detail-option="core"]') as Element);
  await waitFor(() =>
    assert.equal(document.querySelector('[data-architecture-detail-option="core"]')?.getAttribute('aria-checked'), 'true'),
  );
  first.unmount();

  // The same project, a different session: the pair comes back from storage.
  const second = render(<ArchitecturePanel projectId="project-1" sessionId="session-2" initialGranularity="file" />);
  await waitForDiagram();
  assert.equal(document.querySelector('[role="spinbutton"]')?.getAttribute('aria-valuenow'), '1');
  assert.equal(document.querySelector('[data-architecture-detail-option="core"]')?.getAttribute('aria-checked'), 'true');
  assert.deepEqual(
    apiMock.architectureGraph.mock.calls.at(-1),
    ['project-1', 'session-2', 1],
    'the remembered scope must drive the request for a sibling session too',
  );
  second.unmount();

  // Another project is isolated: it starts from the defaults, not project-1's pair.
  render(<ArchitecturePanel projectId="project-2" sessionId="session-3" initialGranularity="file" />);
  await waitForDiagram();
  assert.equal(document.querySelector('[role="spinbutton"]')?.getAttribute('aria-valuenow'), '2');
  assert.equal(document.querySelector('[data-architecture-detail-option="all"]')?.getAttribute('aria-checked'), 'true');
  assert.deepEqual(apiMock.architectureGraph.mock.calls.at(-1), ['project-2', 'session-3', 2]);
});

test('the export menu writes the server-returned .mmd document; there is no standalone Export .mmd button', async () => {
  const downloads: string[] = [];
  const createObjectUrl = vi.fn(() => 'blob:architecture');
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function capture(this: HTMLAnchorElement) {
    downloads.push(this.download);
  });

  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  await waitForDiagram();

  // The old one-click `Export .mmd` control is gone: the header offers the
  // disclosure and the legacy format is one item inside it.
  assert.equal(screen.queryByRole('button', { name: 'Export .mmd' }), null);
  assert.equal(document.querySelector('[data-architecture-overflow-export]'), null);

  fireEvent.click(screen.getByRole('button', { name: 'Export ▾' }));
  fireEvent.click(document.querySelector('[data-architecture-export-item="mmd"]') as Element);

  assert.deepEqual(downloads, ['architecture-file.mmd'], 'the file-granularity document must be exported');
  assert.equal(createObjectUrl.mock.calls.length, 1);
  assert.equal(apiMock.architectureGraph.mock.calls.length, 1, 'export must not re-enter the fetch');
});

test('Escape closes only the export menu and does not reach the page abort handler', async () => {
  // The chat page aborts a running turn from a document-level Escape listener.
  // The open menu must stop that key at itself (role="menu" + stopPropagation),
  // so this recording listener stands in for the page's abort call.
  const aborts: string[] = [];
  const recordEscape = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') aborts.push('chat.abort');
  };
  document.addEventListener('keydown', recordEscape);

  try {
    render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
    await waitForDiagram();

    fireEvent.click(screen.getByRole('button', { name: 'Export ▾' }));
    const menu = document.querySelector('[data-architecture-export-menu]');
    assert.ok(menu instanceof HTMLElement, 'the menu must be open before Escape');

    fireEvent.keyDown(menu, { key: 'Escape' });

    assert.equal(document.querySelector('[data-architecture-export-menu]'), null, 'Escape closes the menu');
    assert.equal(
      document.querySelector('[data-architecture-panel]')?.contains(document.activeElement),
      true,
      'focus returns to the disclosure',
    );
    assert.equal(aborts.length, 0, `Escape inside the menu must not abort the turn (chat.abort calls: ${String(aborts.length)})`);
  } finally {
    document.removeEventListener('keydown', recordEscape);
  }
});

test('an empty seed set renders the empty state, not a blank graph', async () => {
  apiMock.architectureGraph.mockResolvedValue(jsonResponse(EMPTY_RESULT));

  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);

  await waitFor(() =>
    assert.ok(
      document.querySelector('[data-architecture-empty]'),
      'an empty seed set must render the empty state',
    ),
  );
  assert.equal(
    document.querySelector('[data-architecture-plantuml]'),
    null,
    'no seeds means there is no graph to draw',
  );
  // The source line still describes the (empty) reading rather than disappearing.
  assert.ok(document.querySelector('[data-architecture-generated-at]') instanceof HTMLElement);
  assert.match(
    document.querySelector('[data-architecture-unresolved]')?.textContent ?? '',
    /^0 names mentioned in this session were not found in the analysis cache/,
  );
});

test('the fetch effect tears down cleanly when the panel unmounts mid-request', async () => {
  // A reply that arrives after unmount must not touch React state; React would
  // warn, and the request id makes the late result a no-op by construction.
  let resolveResponse: (response: Response) => void = () => {};
  apiMock.architectureGraph.mockReturnValue(new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  }));

  const { unmount } = render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  unmount();
  resolveResponse(jsonResponse(RESULT));

  await waitFor(() => assert.equal(apiMock.architectureGraph.mock.calls.length, 1));
});

test('a readable-floor fit is named after the action, while the zoom tier states Focus', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await screen.findByTestId('plantuml-host');
  sizeHost(host, 160, 120);
  await waitFor(() => assert.ok(host.querySelector('svg')));
  triggerResize();

  const root = graphRoot();
  await waitFor(() => assert.equal(root.getAttribute('data-architecture-readable-mode'), 'focus'));

  // The zoom tier is stated ONCE, by the on-canvas tier group. The fit button
  // names what it DOES ("Fit to view"), not the tier it happens to land on.
  const tier = document.querySelector('[data-architecture-zoom-tier]');
  assert.ok(tier instanceof HTMLElement, 'the zoom tier lives on the canvas');
  assert.equal(
    tier.querySelector('[data-architecture-zoom-tier-label]')?.textContent,
    'Focus',
    'the tier label is the one place the Focus state is stated',
  );
  const fit = root.querySelector('[data-architecture-zoom-fit]');
  assert.ok(fit instanceof HTMLElement);
  assert.equal(fit.getAttribute('data-architecture-zoom-fit-mode'), 'focus', 'the fit lands on a focus view');
  assert.equal(fit.textContent, 'Fit to view', 'the control is named after what it applies');
  assert.equal(fit.getAttribute('aria-pressed'), 'true', 'the zoom on screen is still the fit');
  // `data-architecture-zoom-mode` keeps its existing fit/custom vocabulary.
  assert.equal(root.getAttribute('data-architecture-zoom-mode'), 'fit');

  const notice = document.querySelector('[data-architecture-readable-fit-notice]');
  assert.ok(notice instanceof HTMLElement, 'a focused fit must say the whole graph is one choice away');
  assert.match(notice.textContent ?? '', /Overview/, 'the notice names the control that shows everything');
  assert.match(notice.textContent ?? '', /whole graph/i);

  // Choosing Overview really fits the whole drawing; the fit control goes back
  // to saying so, and the notice has nothing left to explain.
  const readableGroup = screen.getByRole('group', { name: 'Readable zoom mode' });
  fireEvent.click(within(readableGroup).getByRole('button', { name: 'Overview' }));
  await waitFor(() => assert.equal(root.getAttribute('data-architecture-readable-mode'), 'overview'));
  const wholeFit = root.querySelector('[data-architecture-zoom-fit]');
  assert.ok(wholeFit instanceof HTMLElement);
  assert.equal(wholeFit.getAttribute('data-architecture-zoom-fit-mode'), 'overview');
  assert.equal(wholeFit.textContent, 'Fit to view');
  assert.equal(wholeFit.getAttribute('aria-pressed'), 'true');
  assert.equal(document.querySelector('[data-architecture-readable-fit-notice]'), null);
});

/**
 * The reworked header: ONE row, the class diagram first, no standing hint
 * sentence, and a one-line readout whose two numbers follow the detail knob.
 */
test('the toolbar is one non-wrapping row, the class diagram is the default, and the readout tracks the filter', async () => {
  apiMock.architectureGraph.mockResolvedValue(jsonResponse(CLASS_DIAGRAM_RESULT));
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  await waitForDiagram();

  // Exactly one toolbar row on the page; the renderer no longer draws its own.
  const toolbars = [...document.querySelectorAll('[data-architecture-toolbar]')];
  assert.equal(toolbars.length, 1, 'the header must be a single row');
  const toolbar = toolbars[0];
  // jsdom does no layout, so "one line" is stated structurally: neither the row
  // nor any container inside it may wrap.
  assert.doesNotMatch(toolbar.className, /(^|\s)flex-wrap(\s|$)/);
  for (const node of toolbar.querySelectorAll('*')) {
    assert.doesNotMatch(
      node.getAttribute('class') ?? '',
      /(^|\s)flex-wrap(\s|$)/,
      'no container inside the toolbar may wrap onto a second line',
    );
  }

  // Every control the task names lives on that one row.
  assert.ok(toolbar.querySelector('[data-architecture-view-control]'));
  assert.ok(toolbar.querySelector('[data-architecture-scope-control]'));
  assert.ok(toolbar.querySelector('[data-architecture-detail-control]'));
  assert.ok(toolbar.querySelector('[data-architecture-search]'));
  assert.ok(toolbar.querySelector('[data-architecture-export]'));
  assert.ok(toolbar.querySelector('[data-architecture-legend-toggle]'));

  // The class diagram is the shipped default.
  assert.equal(
    toolbar.querySelector('[data-architecture-view-option="entity"]')?.getAttribute('aria-checked'),
    'true',
    'the class (entity) diagram must open first',
  );
  assert.equal(
    toolbar.querySelector('[data-architecture-view-option="file"]')?.getAttribute('aria-checked'),
    'false',
  );

  // The two duplicated standing hover instructions are gone; hovering still
  // produces a transient reading, but the page carries no permanent hint.
  const bodyText = document.body.textContent ?? '';
  assert.doesNotMatch(bodyText, /Hover a node for its relation types/);
  assert.doesNotMatch(bodyText, /Hover a node to highlight its relations/);
  assert.equal(document.querySelector('[data-architecture-hover]'), null);

  // The one-line readout: shown vs. every related entity in the current scope.
  const summary = (): Element | null => document.querySelector('[data-architecture-readout-summary]');
  assert.ok(summary() instanceof HTMLElement);
  assert.match(summary()?.textContent ?? '', /Showing 4 classes · 4 related/);
  assert.equal(summary()?.getAttribute('data-architecture-readout-summary'), '4');
  assert.equal(summary()?.getAttribute('data-architecture-readout-total'), '4');
  const readout = document.querySelector('[data-architecture-readout]');
  assert.equal(readout?.getAttribute('aria-live'), 'polite', 'readout changes must be announced');

  // Core keeps the transcript seed plus one nearest non-seed node.
  fireEvent.click(document.querySelector('[data-architecture-detail-option="core"]') as Element);
  await waitFor(() => {
    assert.equal(summary()?.getAttribute('data-architecture-readout-summary'), '2');
    assert.equal(summary()?.getAttribute('data-architecture-readout-total'), '4');
    assert.match(summary()?.textContent ?? '', /Showing 2 classes · 4 related/);
  });
  assert.equal(apiMock.architectureGraph.mock.calls.length, 1, 'the detail knob never refetches');
});

test('a truncated reading appends the omitted count to the same readout and prints no budget number', async () => {
  // RESULT's ENTITY subgraph is cut: 4 shown, 9 reachable (5 omitted).
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  await waitForDiagram();

  const truncated = document.querySelector('[data-architecture-readout] [data-architecture-truncated]');
  assert.ok(truncated instanceof HTMLElement, 'the readout must carry the cut');
  assert.equal(truncated.getAttribute('data-architecture-truncated-granularity'), 'entity');
  assert.equal(truncated.getAttribute('data-architecture-truncated-omitted'), '5');
  assert.match(truncated.textContent ?? '', /5 more left out by the node budget/);
  const bodyText = document.body.textContent ?? '';
  assert.doesNotMatch(bodyText, /\b2000 of\b/i);
  assert.doesNotMatch(bodyText, /\b\d+ of \d+ (files|entities)\b/);
});

test('the expanded readout lists kind totals only when the payload carries them', async () => {
  const withKinds: ArchitectureGraphResult = {
    ...CLASS_DIAGRAM_RESULT,
    stats: {
      ...CLASS_DIAGRAM_RESULT.stats,
      kindCounts: { function: 805, interface: 300, class: 5 },
    },
  };
  apiMock.architectureGraph.mockResolvedValue(jsonResponse(withKinds));
  const first = render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  await waitForDiagram();
  fireEvent.click(document.querySelector('[data-architecture-readout-toggle]') as Element);
  const kinds = await waitFor(() => {
    const node = document.querySelector('[data-architecture-kind-counts]');
    assert.ok(node instanceof HTMLElement, 'an expanded readout shows the kind tally');
    return node;
  });
  assert.equal(kinds.textContent, '805 functions · 300 interfaces · 5 classes');
  first.unmount();

  // A payload without `kindCounts` must not fabricate the line.
  apiMock.architectureGraph.mockResolvedValue(jsonResponse(CLASS_DIAGRAM_RESULT));
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  await waitForDiagram();
  fireEvent.click(document.querySelector('[data-architecture-readout-toggle]') as Element);
  await waitFor(() => assert.ok(document.querySelector('[data-architecture-readout-detail]')));
  assert.equal(document.querySelector('[data-architecture-kind-counts]'), null);
});

test('unresolved names expand into a list, and the analysis time is relative with a local title', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  await waitForDiagram();

  const time = document.querySelector('[data-architecture-generated-at]');
  assert.ok(time instanceof HTMLTimeElement);
  assert.match(time.textContent ?? '', /ago|now/i);
  assert.ok((time.getAttribute('title') ?? '').length > 0);
  assert.notEqual(time.getAttribute('title'), GENERATED_AT, 'the title is local, not the UTC ISO string');

  const unresolved = document.querySelector('[data-architecture-unresolved]');
  assert.ok(unresolved instanceof HTMLElement);
  assert.equal(document.querySelector('[data-architecture-unresolved-list]'), null);
  fireEvent.click(unresolved);
  const list = await waitFor(() => {
    const node = document.querySelector('[data-architecture-unresolved-list]');
    assert.ok(node instanceof HTMLElement, 'the names expand into a list');
    return node;
  });
  const names = [...list.querySelectorAll('li')].map((item) => item.textContent);
  assert.deepEqual(names, ['src/unknown.ts', 'NoSuchThing']);
});

test('searching the class diagram reveals and centres the node; a folded hit reports the range', async () => {
  apiMock.architectureGraph.mockResolvedValue(jsonResponse(CLASS_DIAGRAM_RESULT));
  const originalRect = Element.prototype.getBoundingClientRect;
  // A laid-out box for the searched node, so the centring scroll has real
  // numbers behind it (jsdom itself would report a zero-area rect at the origin).
  Element.prototype.getBoundingClientRect = function rect(this: Element): DOMRect {
    if (this.getAttribute('data-entity-id') === 'src/modules/alpha/reader.ts.Reader') {
      return {
        left: 500, top: 400, width: 100, height: 60,
        right: 600, bottom: 460, x: 500, y: 400, toJSON: () => ({}),
      } as DOMRect;
    }
    return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  try {
    render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
    const host = await waitForDiagram();
    sizeHost(host, 400, 300);
    host.scrollLeft = 0;
    host.scrollTop = 0;

    const search = document.querySelector('[data-architecture-search]') as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'Reader' } });
    const hit = await waitFor(() => {
      const node = document.querySelector('[data-architecture-search-result="src/modules/alpha/reader.ts.Reader"]');
      assert.ok(node instanceof HTMLElement, 'the search lists the matching entity');
      return node;
    });
    assert.equal(hit.getAttribute('data-architecture-search-in-range'), 'true');
    fireEvent.click(hit);

    await waitFor(() => assert.equal(graphRoot().getAttribute('data-architecture-view'), 'neighborhood'));
    await waitFor(() =>
      assert.ok(drawnNodeIds(screen.getByTestId('plantuml-host')).includes('src/modules/alpha/reader.ts.Reader')),
    );
    const focused = await waitFor(() => {
      const node = document.querySelector('[data-architecture-focus-target="src/modules/alpha/reader.ts.Reader"]');
      assert.ok(node instanceof Element, 'the chosen node is revealed and marked');
      return node;
    });
    assert.ok(focused.classList.contains('arch-focus'));
    assert.ok(host.scrollLeft > 0, `the node must be centred; got scrollLeft=${host.scrollLeft}`);
    assert.equal(apiMock.architectureGraph.mock.calls.length, 1, 'search works on the payload in hand');

    // A node the detail tier folded away is labelled out of range; choosing it
    // raises the detail tier and reveals it.
    fireEvent.click(document.querySelector('[data-architecture-detail-option="core"]') as Element);
    fireEvent.change(search, { target: { value: 'Store' } });
    const outOfRange = await waitFor(() => {
      const node = document.querySelector('[data-architecture-search-result="src/modules/alpha/store.ts.Store"]');
      assert.ok(node instanceof HTMLElement);
      return node;
    });
    assert.equal(outOfRange.getAttribute('data-architecture-search-in-range'), 'false');
    assert.match(outOfRange.textContent ?? '', /Not in current range/);
    fireEvent.click(outOfRange);
    await waitFor(() =>
      assert.equal(
        document.querySelector('[data-architecture-detail-option="all"]')?.getAttribute('aria-checked'),
        'true',
        'choosing an out-of-range match raises the detail tier',
      ),
    );
    await waitFor(() =>
      assert.ok(
        document.querySelector('[data-architecture-focus-target="src/modules/alpha/store.ts.Store"]'),
        'and focuses the requested node',
      ),
    );
  } finally {
    Element.prototype.getBoundingClientRect = originalRect;
  }
});

test('every reviewed locale carries both fit labels and the focused-fit escape', () => {
  const bundles: Record<string, unknown> = {
    en: enCommon,
    de: deCommon,
    es: esCommon,
    fr: frCommon,
    id: idCommon,
    it: itCommon,
    ja: jaCommon,
    ko: koCommon,
    ru: ruCommon,
    tr: trCommon,
    'zh-CN': zhCNCommon,
    'zh-TW': zhTWCommon,
  };
  const plantumlOf = (bundle: unknown) => (bundle as {
    architecture: {
      plantuml: { zoomFit?: string; zoomFocus?: string; readable?: { focusedFitHint?: string } };
    };
  }).architecture.plantuml;

  assert.equal(Object.keys(bundles).length, 12, 'the reviewed locale set');
  for (const [locale, bundle] of Object.entries(bundles)) {
    const plantuml = plantumlOf(bundle);
    assert.ok((plantuml.zoomFit ?? '').length > 0, `${locale} must name the whole-graph fit`);
    assert.ok((plantuml.zoomFocus ?? '').length > 0, `${locale} must name the readable focus`);
    assert.ok(
      (plantuml.readable?.focusedFitHint ?? '').length > 0,
      `${locale} must explain a focused fit and name the overview escape`,
    );
  }
});
