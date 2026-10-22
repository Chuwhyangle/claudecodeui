import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { checkSyntax } from '@yalehwang/plantuml-js';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { beforeAll, beforeEach, test, vi } from 'vitest';

import type * as SharedApiModule from '@/shared/api';
import { ArchitecturePanel } from '@/modules/architecture';
import type { ArchitectureGraphResult } from '@/modules/architecture';
import {
  archguardToPlantUml,
  type ArchitectureDiagramView,
} from '@/modules/architecture/archguardToPlantUml';
import {
  architectureExportFilename,
  EXPORT_PNG_MAX_EDGE,
  exportTimestamp,
  pngTargetSize,
  sanitizeFilenameSegment,
} from '@/modules/architecture/exportArtifacts';
import type * as ExportArtifactsModule from '@/modules/architecture/exportArtifacts';
import { rankArchitectureDetail } from '@/modules/architecture/detailRanking';
import type { ArchitectureRendererGraph } from '@/modules/architecture/rendererContract';
import enCommon from '@/modules/i18n/locales/en/common.json';

/**
 * The export menu's behaviour, at the panel seam:
 *  · the `Export ▾` disclosure offers five formats, PlantUML first and the
 *    legacy Mermaid pair last;
 *  · the `.puml` download is the bridge's document for the view ON SCREEN
 *    (class/file, drilled group, drilled neighbourhood), and it follows the
 *    scope and detail knobs;
 *  · the produced PlantUML passes plantuml-js's own `checkSyntax`;
 *  · the SVG export drops the runtime highlight classes and the inline zoom
 *    size, while the PNG raster is bounded to 8192 px on its longest side;
 *  · Copy PlantUML writes the clipboard (with an aria-live reading) and falls
 *    back to a selected-text dialog when the clipboard is unavailable;
 *  · the legacy `.mmd` export is byte-for-byte the pre-menu download.
 *
 * The network hop is stubbed; the real hook, bridge and PlantUML/ELK renderer
 * run, so a drilled view reaches the menu the same way it does in a browser.
 */
const apiMock = vi.hoisted(() => ({ architectureGraph: vi.fn() }));
const artifactMock = vi.hoisted(() => ({ rasterizeSvgToPng: vi.fn() }));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApiModule>();
  return {
    ...actual,
    api: { ...actual.api, architectureGraph: apiMock.architectureGraph },
  };
});

// The rasteriser needs a real canvas, which jsdom does not implement. Its unit
// bounds are covered below; the panel path only needs to know what it was
// asked to draw and that the notice follows the returned target.
vi.mock('@/modules/architecture/exportArtifacts', async (importOriginal) => {
  const actual = await importOriginal<typeof ExportArtifactsModule>();
  return { ...actual, rasterizeSvgToPng: artifactMock.rasterizeSvgToPng };
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

beforeAll(async () => {
  // Compile the lazily imported renderer once, outside the per-case budget.
  await import('@yalehwang/plantuml-js/elk');
});

const GENERATED_AT = '2026-10-20T15:52:34.427Z';
const FILE_MMD = '@startuml\nA --> B\n@enduml';
const ENTITY_MMD = '@startuml\nX --> Y\n@enduml';

/**
 * The same four-node chain the tab tests use: two files share `alpha`, while
 * `beta` and `gamma` hold one each, so the collapsed overview has one real
 * directory group to drill into.
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
    truncated: false,
    entityTruncated: false,
    fileTruncated: false,
    entityTotal: 4,
    fileTotal: 4,
    seedFiles: 1,
    seedIdentifiers: 1,
    nodeCount: 8,
    edgeCount: 6,
    unresolved: { files: [], identifiers: [] },
  },
  provenance: { generatedAt: GENERATED_AT, fingerprints: [], cacheHit: false },
};

/** The same reading one hop narrower: the `+1` scope export must be smaller. */
const SCOPE_ONE_RESULT: ArchitectureGraphResult = {
  ...RESULT,
  graph: {
    ...RESULT.graph,
    file: {
      nodes: RESULT.graph.file.nodes.slice(0, 2),
      edges: RESULT.graph.file.edges.slice(0, 1),
    },
  },
  stats: { ...RESULT.stats, fileNodes: 2, fileEdges: 1 },
};

function jsonResponse(result: ArchitectureGraphResult): Response {
  return { ok: true, status: 200, json: async () => result } as unknown as Response;
}

async function waitForDiagram(): Promise<HTMLElement> {
  const host = await screen.findByTestId('plantuml-host');
  await waitFor(() => assert.ok(host.querySelector('svg'), 'the renderer must draw an SVG'));
  return host;
}

/** One captured download: the filename the anchor carried and its Blob. */
type CapturedDownload = { readonly filename: string; readonly blob: Blob };

let downloads: CapturedDownload[] = [];
let lastBlob: Blob | null = null;

function installDownloadCapture(): void {
  let sequence = 0;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn((blob: Blob) => {
      lastBlob = blob;
      sequence += 1;
      return `blob:architecture-export-${String(sequence)}`;
    }),
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function capture(this: HTMLAnchorElement) {
    if (lastBlob !== null) downloads.push({ filename: this.download, blob: lastBlob });
  });
}

function openExportMenu(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: 'Export ▾' }));
  const menu = document.querySelector('[data-architecture-export-menu]');
  assert.ok(menu instanceof HTMLElement, 'the disclosure must expand into a menu');
  return menu;
}

function clickExportItem(id: string): void {
  fireEvent.click(document.querySelector(`[data-architecture-export-item="${id}"]`) as Element);
}

/** jsdom's Blob has no `text()`; FileReader is the platform-neutral read. */
function readBlobText(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('blob-read-failed'));
    reader.readAsText(blob);
  });
}

async function readLastDownload(): Promise<string> {
  assert.ok(downloads.length > 0, 'the action must download one file');
  return readBlobText(downloads[downloads.length - 1].blob);
}

/**
 * State the "show everything" filter explicitly.
 *
 * The panel's shipped default hides `call` edges (and the class view's
 * functions). These export cases assert the document for the graph as it
 * ARRIVED, so they opt out of the default instead of deriving a filtered
 * expectation; the default itself is covered by `elementRelationFilter.test.ts`
 * and the filter criteria in `architectureTab.test.tsx`.
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

/** The exact document the bridge builds for one view of one graph. */
function expectedPuml(
  graph: ArchitectureRendererGraph,
  view: ArchitectureDiagramView,
  idShape: 'project-relative' | 'scope-prefixed',
): string {
  return archguardToPlantUml(graph, { view, grouping: 'adaptive', idShape }).puml;
}

/** No `error`-severity diagnostic, using the package's own checker. */
function assertSyntaxOk(puml: string): void {
  const checked = checkSyntax(puml);
  assert.deepEqual(checked.errors, [], `PlantUML must parse without errors:\n${puml}`);
}

beforeEach(() => {
  vi.restoreAllMocks();
  apiMock.architectureGraph.mockReset();
  apiMock.architectureGraph.mockResolvedValue(jsonResponse(RESULT));
  artifactMock.rasterizeSvgToPng.mockReset();
  artifactMock.rasterizeSvgToPng.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
  downloads = [];
  lastBlob = null;
  installDownloadCapture();
  for (const projectId of ['project-1', 'project-2']) {
    window.localStorage.removeItem(`architecture.scope.${projectId}`);
    window.localStorage.removeItem(`architecture.detail.${projectId}`);
    window.localStorage.removeItem(`architecture.filter.${projectId}`);
  }
  rememberShowAllFilter();
  // jsdom has no canvas; the minimap's documented "cannot draw" path answers
  // null instead of logging one "Not implemented" error per paint.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

test('the menu offers five formats, PlantUML first and Mermaid (.mmd) marked legacy last', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  await waitForDiagram();

  const menu = openExportMenu();
  const items = [...menu.querySelectorAll('[role="menuitem"]')];
  assert.equal(items.length, 5, 'the menu must offer exactly the five formats');
  assert.deepEqual(
    items.map((item) => item.getAttribute('data-architecture-export-item')),
    ['puml', 'copy', 'svg', 'png', 'mmd'],
    'PlantUML leads; the legacy Mermaid pair is last',
  );
  assert.equal(items[0].textContent, 'PlantUML (.puml)');
  assert.equal(items[1].textContent, 'Copy PlantUML');
  assert.equal(items[2].textContent, 'SVG');
  assert.equal(items[3].textContent, 'PNG');
  assert.match(items[4].textContent ?? '', /legacy/i, 'the Mermaid entry must be marked as the old format');
  assert.equal(items[4].getAttribute('data-architecture-export-legacy'), 'true');

  const trigger = screen.getByRole('button', { name: 'Export ▾' });
  assert.equal(trigger.getAttribute('aria-haspopup'), 'menu');
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
});

test('the file graph export is the bridge document for the overview on screen, and checkSyntax accepts it', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  await waitForDiagram();

  openExportMenu();
  clickExportItem('puml');
  await waitFor(() => assert.equal(downloads.length, 1));

  const puml = await readLastDownload();
  assert.equal(puml, expectedPuml(RESULT.graph.file, { kind: 'overview' }, 'project-relative'));
  assert.match(downloads[0].filename, /^architecture-file-project-1-\d{8}-\d{4}\.puml$/);
  assertSyntaxOk(puml);
});

test('the class diagram export is the bridge document for the entity subgraph', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  await waitForDiagram();

  openExportMenu();
  clickExportItem('puml');
  await waitFor(() => assert.equal(downloads.length, 1));

  const puml = await readLastDownload();
  assert.equal(puml, expectedPuml(RESULT.graph.entity, { kind: 'overview' }, 'scope-prefixed'));
  assert.match(downloads[0].filename, /^architecture-class-project-1-\d{8}-\d{4}\.puml$/);
  assertSyntaxOk(puml);
});

test('drilled group and neighbourhood views export their own document, not the overview', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await waitForDiagram();

  // A click on the directory group is the reader opening that group view.
  const groupNode = host.querySelector('[data-entity-id="grp::src/modules/alpha"]');
  assert.ok(groupNode !== null, 'the overview must draw the alpha directory as a group');
  fireEvent.click(groupNode);
  await waitFor(() => assert.equal(document.querySelector('[data-architecture-view]')?.getAttribute('data-architecture-view'), 'group'));

  openExportMenu();
  clickExportItem('puml');
  await waitFor(() => assert.equal(downloads.length, 1));
  const groupPuml = await readLastDownload();
  const expectedGroup = expectedPuml(
    RESULT.graph.file,
    { kind: 'group', prefix: 'src/modules/alpha' },
    'project-relative',
  );
  assert.equal(groupPuml, expectedGroup, 'the export must be the group view the reader drilled into');
  assert.notEqual(groupPuml, expectedPuml(RESULT.graph.file, { kind: 'overview' }, 'project-relative'));
  assertSyntaxOk(groupPuml);

  // A click on an entity opens its neighbourhood; the export follows it. The
  // group's entities arrive through the lazily built drawing, so wait for the
  // node itself rather than only the view attribute.
  await waitFor(() => assert.ok(host.querySelector('[data-entity-id="src/modules/alpha/a2.ts"]')));
  const entityNode = host.querySelector('[data-entity-id="src/modules/alpha/a2.ts"]');
  assert.ok(entityNode !== null, 'the group view must draw a2.ts');
  fireEvent.click(entityNode);
  await waitFor(() =>
    assert.equal(document.querySelector('[data-architecture-view]')?.getAttribute('data-architecture-view'), 'neighborhood'),
  );

  openExportMenu();
  clickExportItem('puml');
  await waitFor(() => assert.equal(downloads.length, 2));
  const neighbourhoodPuml = await readLastDownload();
  assert.equal(
    neighbourhoodPuml,
    expectedPuml(
      RESULT.graph.file,
      { kind: 'neighborhood', entityId: 'src/modules/alpha/a2.ts', hops: 1 },
      'project-relative',
    ),
    'the export must be the neighbourhood view the reader drilled into',
  );
  assertSyntaxOk(neighbourhoodPuml);
});

test('the export follows the scope and detail knobs', async () => {
  apiMock.architectureGraph.mockImplementation(async (_projectId: string, _sessionId: string, scope: number) =>
    jsonResponse(scope === 1 ? SCOPE_ONE_RESULT : RESULT),
  );

  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  await waitForDiagram();

  openExportMenu();
  clickExportItem('puml');
  await waitFor(() => assert.equal(downloads.length, 1));
  const widePuml = await readLastDownload();

  // The detail knob cuts the arrived payload locally; the file must follow.
  const coreGraph = rankArchitectureDetail(RESULT.graph.file.nodes, RESULT.graph.file.edges, 'core').graph;
  fireEvent.click(document.querySelector('[data-architecture-detail-option="core"]') as Element);
  await waitFor(() =>
    assert.equal(document.querySelector('[data-architecture-detail-option="core"]')?.getAttribute('aria-checked'), 'true'),
  );
  openExportMenu();
  clickExportItem('puml');
  await waitFor(() => assert.equal(downloads.length, 2));
  const corePuml = await readLastDownload();

  assert.notEqual(corePuml, widePuml, 'folding detail must change what is exported');
  assert.equal(corePuml, expectedPuml(coreGraph, { kind: 'overview' }, 'project-relative'));
  assertSyntaxOk(corePuml);

  // Back to the full drawing, then range +2 → +1 re-requests; wait until the
  // smaller graph is the one drawn and export it.
  fireEvent.click(document.querySelector('[data-architecture-detail-option="all"]') as Element);
  fireEvent.click(document.querySelector('[data-architecture-scope-decrease]') as Element);
  await waitFor(() => assert.equal(apiMock.architectureGraph.mock.calls.at(-1)?.[2], 1));
  await waitFor(() => assert.ok(document.querySelector('[data-architecture-plantuml] svg')));
  openExportMenu();
  clickExportItem('puml');
  await waitFor(() => assert.equal(downloads.length, 3));
  const narrowPuml = await readLastDownload();

  assert.notEqual(narrowPuml, widePuml, 'a smaller scope must produce a smaller document');
  assert.equal(narrowPuml, expectedPuml(SCOPE_ONE_RESULT.graph.file, { kind: 'overview' }, 'project-relative'));
});

test('Copy PlantUML writes the current document and announces success', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  await waitForDiagram();

  openExportMenu();
  clickExportItem('copy');
  await waitFor(() =>
    assert.equal(
      document.querySelector('[data-architecture-export-status]')?.textContent,
      'PlantUML copied to the clipboard',
    ),
  );

  const clipboard = navigator.clipboard.writeText as unknown as ReturnType<typeof vi.fn>;
  assert.equal(clipboard.mock.calls.length, 1);
  assert.equal(clipboard.mock.calls[0][0], expectedPuml(RESULT.graph.file, { kind: 'overview' }, 'project-relative'));
  const status = document.querySelector('[data-architecture-export-status]');
  assert.equal(status?.getAttribute('role'), 'status');
  assert.equal(status?.getAttribute('aria-live'), 'polite');
});

test('a refusing clipboard falls back to a dialog with the text selected', async () => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
  });

  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  await waitForDiagram();

  openExportMenu();
  clickExportItem('copy');
  await waitFor(() => assert.ok(document.querySelector('[data-architecture-export-fallback]')));

  const dialog = document.querySelector('[data-architecture-export-fallback]');
  assert.equal(dialog?.getAttribute('role'), 'dialog');
  const textarea = document.querySelector('[data-architecture-export-fallback-text]') as HTMLTextAreaElement;
  assert.equal(textarea.value, expectedPuml(RESULT.graph.file, { kind: 'overview' }, 'project-relative'));

  fireEvent.click(document.querySelector('[data-architecture-export-fallback-close]') as Element);
  assert.equal(document.querySelector('[data-architecture-export-fallback]'), null);
});

test('SVG export drops the runtime highlight classes and inline size, keeping the viewBox', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await waitForDiagram();

  // Hover paints the arch-dim / arch-hl-* classes onto the LIVE drawing; the
  // file must not carry that reading. `gamma` is at the end of the chain, so
  // hovering it leaves the beta → alpha edge unrelated and dimmed.
  const hovered = host.querySelector('[data-entity-id="src/modules/gamma/c.ts"]');
  assert.ok(hovered !== null);
  fireEvent.mouseOver(hovered);
  assert.ok(host.querySelector('.arch-dim') !== null, 'the live drawing carries the highlight classes');

  openExportMenu();
  clickExportItem('svg');
  await waitFor(() => assert.equal(downloads.length, 1));
  const svg = await readLastDownload();

  assert.doesNotMatch(svg, /arch-dim/, 'the export must not carry the dim class');
  assert.doesNotMatch(svg, /arch-hl-/, 'the export must not carry the highlight classes');
  assert.match(svg, /viewBox="[^"]+"/, 'the viewBox survives so the file scales');
  assert.doesNotMatch(svg, /<svg[^>]*\swidth=/, 'the inline fit width must be removed');
  assert.doesNotMatch(svg, /<svg[^>]*\sheight=/, 'the inline fit height must be removed');
  assert.match(downloads[0].filename, /^architecture-file-project-1-\d{8}-\d{4}\.svg$/);
});

test('PNG is rasterised at 2×, capped at 8192px, and says so when it was capped', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  const host = await waitForDiagram();

  // A 2× bitmap of this drawing would exceed the cap on its longest side.
  const svg = host.querySelector('svg');
  assert.ok(svg !== null);
  svg.setAttribute('viewBox', '0 0 5000 3000');

  openExportMenu();
  clickExportItem('png');
  await waitFor(() => assert.equal(artifactMock.rasterizeSvgToPng.mock.calls.length, 1));

  const target = artifactMock.rasterizeSvgToPng.mock.calls[0][1] as { width: number; height: number };
  assert.ok(Math.max(target.width, target.height) <= EXPORT_PNG_MAX_EDGE, 'the long edge must be capped');
  await waitFor(() => assert.equal(downloads.length, 1));
  assert.match(downloads[0].filename, /^architecture-file-project-1-\d{8}-\d{4}\.png$/);
  await waitFor(() =>
    assert.match(
      document.querySelector('[data-architecture-export-status]')?.textContent ?? '',
      new RegExp(String(EXPORT_PNG_MAX_EDGE)),
      'the reader must be told the image was scaled down',
    ),
  );

  // The pure size rule: 2× when it fits, proportional shrink when it does not.
  assert.deepEqual(pngTargetSize({ width: 100, height: 50 }), {
    width: 200,
    height: 100,
    downscaled: false,
    scale: 2,
  });
  const capped = pngTargetSize({ width: 5000, height: 3000 });
  assert.equal(capped.downscaled, true);
  assert.equal(Math.max(capped.width, capped.height), EXPORT_PNG_MAX_EDGE);
});

test('the legacy Mermaid item keeps the pre-menu filename and document byte-for-byte', async () => {
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" initialGranularity="file" />);
  await waitForDiagram();

  openExportMenu();
  clickExportItem('mmd');
  await waitFor(() => assert.equal(downloads.length, 1));

  assert.equal(downloads[0].filename, 'architecture-file.mmd', 'the old filename is unchanged');
  assert.equal(await readLastDownload(), FILE_MMD, 'the old document is unchanged');
});

test('filename pieces are safe and stamped with the export minute', () => {
  assert.equal(sanitizeFilenameSegment('my project/one:two'), 'my-project-one-two');
  assert.equal(sanitizeFilenameSegment('   '), 'project');
  const at = new Date(2026, 9, 22, 18, 21, 30);
  assert.equal(exportTimestamp(at), '20261022-1821');
  assert.equal(
    architectureExportFilename('entity', 'my project/one', at, 'puml'),
    'architecture-class-my-project-one-20261022-1821.puml',
  );
  assert.equal(
    architectureExportFilename('file', 'project-1', at, 'svg'),
    'architecture-file-project-1-20261022-1821.svg',
  );
});
