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
  resources: { en: { common: enCommon } },
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

  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" renderer={StandInRenderer} />);

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
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
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
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
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
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
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
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
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
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
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
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
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
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
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
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  const host = await waitForDiagram();

  const canvas = canvasOf(host);
  const cluster = zoomCluster();
  assert.ok(canvas.contains(cluster), 'the cluster must be inside the canvas container');
  assert.equal(cluster.getAttribute('role'), 'group');
  assert.equal(cluster.getAttribute('aria-label'), 'Diagram zoom', 'the cluster carries an accessible name');
  assert.ok(cluster.querySelector('[data-architecture-zoom-level]'), 'the percentage readout belongs to the cluster');
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
    render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
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
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
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
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
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
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
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
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
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
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
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
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
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
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
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
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
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
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
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
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
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

test('hovering a node highlights its in/out edges and dims the rest', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
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
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
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
    render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
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
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
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
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
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

  fireEvent.click(screen.getByRole('button', { name: 'Entity graph' }));
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

  fireEvent.click(screen.getByRole('button', { name: 'File graph' }));
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

test('the truncation notice follows the current granularity and carries the shown/total numbers', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  await waitForDiagram();

  const generatedAt = document.querySelector('[data-architecture-generated-at]');
  assert.equal(generatedAt?.textContent, GENERATED_AT, 'the analysis time must be the manifest timestamp');

  const unresolved = document.querySelector('[data-architecture-unresolved]');
  assert.equal(
    unresolved?.textContent,
    '2 unresolved seed(s)',
    `both unresolved seeds (1 file + 1 identifier) must be counted; got ${unresolved?.textContent}`,
  );

  // The default view is the file graph, which has its own budget and was NOT
  // truncated: the entity cut must not leak a notice onto it.
  assert.equal(
    document.querySelector('[data-architecture-truncated]'),
    null,
    'a complete file graph must not claim to be truncated',
  );

  fireEvent.click(screen.getByRole('button', { name: 'Entity graph' }));
  await waitForDiagram();
  const truncated = document.querySelector('[data-architecture-truncated]');
  assert.ok(truncated, 'the truncated entity reading must say so');
  assert.equal(truncated.getAttribute('data-architecture-truncated-granularity'), 'entity');
  assert.equal(truncated.getAttribute('data-architecture-truncated-shown'), '4');
  assert.equal(truncated.getAttribute('data-architecture-truncated-total'), '9');
  assert.match(truncated.textContent ?? '', /truncated/i);
  assert.match(
    truncated.textContent ?? '',
    /4 of 9/,
    `the notice must state the actual and total counts; got ${truncated.textContent}`,
  );
  // At the default 2 hops the notice also says how to recover the full view.
  assert.ok(
    document.querySelector('[data-architecture-hops-advice]'),
    'a truncation caused by the depth must point at the hops control',
  );
});

test('the hops control re-requests the graph with the selected server-side depth', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  await waitForDiagram();

  assert.deepEqual(
    apiMock.architectureGraph.mock.calls,
    [['project-1', 'session-1', 2]],
    'the first request asks for the default depth',
  );

  const oneHop = document.querySelector('[data-architecture-hops-option="1"]');
  assert.ok(oneHop instanceof HTMLButtonElement, 'the hops control must offer one hop');
  assert.equal(oneHop.getAttribute('aria-pressed'), 'false');
  fireEvent.click(oneHop);
  await waitForDiagram();
  await waitFor(() => assert.equal(apiMock.architectureGraph.mock.calls.length, 2));
  assert.deepEqual(
    apiMock.architectureGraph.mock.calls[1],
    ['project-1', 'session-1', 1],
    'lowering the depth must refetch with hops=1',
  );
  assert.equal(
    document.querySelector('[data-architecture-hops-option="1"]')?.getAttribute('aria-pressed'),
    'true',
    'the selected depth is the pressed option',
  );

  const threeHops = document.querySelector('[data-architecture-hops-option="3"]');
  assert.ok(threeHops instanceof HTMLButtonElement, 'the hops control must offer three hops');
  fireEvent.click(threeHops);
  await waitForDiagram();
  await waitFor(() => assert.equal(apiMock.architectureGraph.mock.calls.length, 3));
  assert.deepEqual(
    apiMock.architectureGraph.mock.calls[2],
    ['project-1', 'session-1', 3],
    'raising the depth must refetch with hops=3',
  );
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
  await waitForDiagram();

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
    document.querySelector('[data-architecture-plantuml]'),
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

test('a readable-floor fit is called "Focus" and names Overview as the whole-graph escape', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  const host = await screen.findByTestId('plantuml-host');
  sizeHost(host, 160, 120);
  await waitFor(() => assert.ok(host.querySelector('svg')));
  triggerResize();

  const root = graphRoot();
  await waitFor(() => assert.equal(root.getAttribute('data-architecture-readable-mode'), 'focus'));

  // The geometric fit here is far below the readable floor, so pressing fit
  // lands on the focus view. The control must say that, not "Fit to view".
  const fit = root.querySelector('[data-architecture-zoom-fit]');
  assert.ok(fit instanceof HTMLElement);
  assert.equal(fit.getAttribute('data-architecture-zoom-fit-mode'), 'focus', 'the fit lands on a focus view');
  assert.equal(fit.textContent, 'Focus', 'the control is named after what it applies');
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
