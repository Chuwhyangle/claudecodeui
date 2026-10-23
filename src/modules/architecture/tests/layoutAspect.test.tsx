import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { beforeAll, beforeEach, test, vi } from 'vitest';

import type { ArchitectureGraphResult } from '@/modules/architecture';
import { ArchitecturePanel } from '@/modules/architecture';
import {
  archguardToPlantUml,
  MEMBER_MAX_ROWS,
  memberDisplayLimits,
  memberOverflowLabel,
} from '@/modules/architecture/archguardToPlantUml';
import {
  NODE_SIZE_ENTITIES,
  nodeSizeEntityGraph,
  nodeSizeMemberSignature,
} from '@/../e2e/support/architectureFixture';
import {
  ASPECT_RELAYOUT_DEBOUNCE_MS,
  ASPECT_RELAYOUT_THRESHOLD,
  clampAspectRatio,
  createLayoutEngine,
  DEFAULT_LAYOUT_ASPECT_RATIO,
  MAX_LAYOUT_ASPECT_RATIO,
  MIN_LAYOUT_ASPECT_RATIO,
  shouldRelayoutForAspect,
  type ArchitectureLayoutEngine,
  type ArchitectureLayoutEngineClass,
  type ArchitectureLayoutEngineOptions,
} from '@/modules/architecture/elkAspectEngine';
import {
  EIGHTEEN_GROUP_OVERVIEW,
  TWENTY_SIX_PACKAGE_HIERARCHY,
  viewBoxAspect,
  viewBoxOf,
} from '@/modules/architecture/tests/layoutFixtures';
import enCommon from '@/modules/i18n/locales/en/common.json';
import type * as SharedApiModule from '@/shared/api';

/**
 * The architecture tab's layout-aspect contract, end to end at the same
 * component seam `architectureTab.test.tsx` uses:
 *  · the container's width/height is a LAYOUT input — it reaches the package's
 *    public `ElkLayoutEngine` constructor option (`aspectRatio`), not a private
 *    elkjs client, which is the seam plantuml-js 0.3.0 replaced;
 *  · real-shape fixtures (18-group flat overview, 26-package hierarchy) are
 *    laid out by the real engine and their drawn proportions are read back;
 *  · a slight resize only re-fits, while a shape change past the threshold
 *    re-lays the diagram out once — after the debounce, not per frame.
 */

// The whole network hop is stubbed; the hook, the panel, the bridge and the
// real PlantUML/ELK renderer are real.
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

// WorkspaceHeader is not under test here; the plugin list only needs to exist.
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

// jsdom ships no ResizeObserver and performs no layout. Recording the callbacks
// lets a case deliver the resize the observer would see, and pinning
// clientWidth/clientHeight stands in for the box the browser would measure.
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

/** Deliver one resize notification to every mounted observer, inside act(). */
function triggerResize(): void {
  act(() => {
    for (const callback of [...resizeCallbacks]) callback([], {} as ResizeObserver);
  });
}

// Pay the one-off module compile outside the first case's budget, the same
// discipline the sibling suite uses for cold module graphs.
beforeAll(async () => {
  await import('@yalehwang/plantuml-js/elk');
});

const GENERATED_AT = '2026-10-21T09:00:00.000Z';

/**
 * A 26-node dependency CHAIN, one file per directory. Its role here is only to
 * make the panel render a real drawing so the resize/debounce path can be
 * counted; the DRAWN proportions are measured on the shape fixtures above.
 */
function chainResult(): ArchitectureGraphResult {
  const nodes = Array.from({ length: 26 }, (_, index) => ({
    id: `src/modules/m${String(index).padStart(2, '0')}/f${index}.ts`,
    label: `src/modules/m${String(index).padStart(2, '0')}/f${index}.ts`,
    distance: index,
  }));
  const edges = nodes.slice(0, -1).map((node, index) => ({
    from: nodes[index + 1].id,
    to: node.id,
    relationType: 'dependency',
  }));
  return {
    mmd: { file: '@startuml\nA --> B\n@enduml', entity: '@startuml\nX --> Y\n@enduml' },
    graph: {
      file: { nodes, edges },
      entity: { nodes, edges },
    },
    stats: {
      entityNodes: nodes.length,
      fileNodes: nodes.length,
      entityEdges: edges.length,
      fileEdges: edges.length,
      truncated: false,
      nodeCount: nodes.length * 2,
      edgeCount: edges.length * 2,
      // The panel only draws a graph the analysis could seed; without a seed
      // count it shows its empty state and never mounts the renderer.
      seedFiles: 1,
      seedIdentifiers: 1,
      unresolved: { files: [], identifiers: [] },
    },
    provenance: { generatedAt: GENERATED_AT, fingerprints: [], cacheHit: false },
  };
}

/** An engine class that records the constructor options it was built with. */
function recordingEngineClass(): {
  readonly Engine: ArchitectureLayoutEngineClass;
  readonly received: (ArchitectureLayoutEngineOptions | undefined)[];
} {
  const received: (ArchitectureLayoutEngineOptions | undefined)[] = [];
  class RecordingEngine {
    constructor(options?: ArchitectureLayoutEngineOptions) {
      received.push(options);
    }

    async layout(): Promise<unknown> {
      return { nodes: [], edges: [], width: 0, height: 0 };
    }
  }
  return { Engine: RecordingEngine as unknown as ArchitectureLayoutEngineClass, received };
}

type ElkModule = {
  ElkLayoutEngine: ArchitectureLayoutEngineClass;
  createRenderer: (options: { layout: ArchitectureLayoutEngine }) => {
    render: (puml: string) => Promise<{ svg: string }>;
  };
  parsePlantUml: (puml: string) => unknown;
};

/** Render one fixture through the same factory the diagram uses, and read its canvas. */
async function drawFixture(puml: string, aspectRatio: number | null): Promise<{
  readonly svg: string;
  readonly viewBox: string | null;
  readonly aspect: number | null;
}> {
  const { ElkLayoutEngine, createRenderer } = (await import('@yalehwang/plantuml-js/elk')) as unknown as ElkModule;
  const engine = createLayoutEngine({ aspectRatio, Engine: ElkLayoutEngine });
  const { svg } = await createRenderer({ layout: engine }).render(puml);
  const viewBox = viewBoxOf(svg);
  return { svg, viewBox, aspect: viewBoxAspect(viewBox) };
}

/** How far apart two aspect ratios are, as a multiplicative factor (never below 1). */
function aspectFactor(a: number, b: number): number {
  return a > b ? a / b : b / a;
}

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

/**
 * The box every diagram host reports, at the prototype level. Pinning it here
 * (rather than on one element after it appears) is what makes the FIRST layout
 * see the container a laid-out browser would report: the host is measured
 * inside the render effect, before a test could reach the element, so an
 * element-level pin would arrive too late and the drawing would silently use
 * the engine default instead.
 */
const hostBox = { width: 0, height: 0 };
{
  const proto = HTMLElement.prototype;
  const baseWidth = Object.getOwnPropertyDescriptor(proto, 'clientWidth')?.get;
  const baseHeight = Object.getOwnPropertyDescriptor(proto, 'clientHeight')?.get;
  Object.defineProperty(proto, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute('data-testid') === 'plantuml-host' ? hostBox.width : (baseWidth?.call(this) ?? 0);
    },
  });
  Object.defineProperty(proto, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute('data-testid') === 'plantuml-host' ? hostBox.height : (baseHeight?.call(this) ?? 0);
    },
  });
}

/** Pin the diagram container's content box for the next layout / resize reading. */
function pinContainerBox(width: number, height: number): void {
  hostBox.width = width;
  hostBox.height = height;
}

/** Count the drawings this host has shown: every layout replaces its children. */
function countDrawings(host: HTMLElement): () => number {
  let drawings = 0;
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === 1 && (node as Element).tagName.toLowerCase() === 'svg') drawings += 1;
      }
    }
  });
  observer.observe(host, { childList: true });
  return () => drawings;
}

/** Let the debounce and the layout that follows it run. */
async function settleAspectRelayout(): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ASPECT_RELAYOUT_DEBOUNCE_MS + 120));
}

beforeEach(() => {
  apiMock.architectureGraph.mockReset();
  apiMock.architectureGraph.mockResolvedValue(jsonResponse(chainResult()));
  apiMock.architectureMentions.mockReset();
  apiMock.architectureMentions.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ mentions: [], truncated: false }),
  } as unknown as Response);
  window.localStorage.removeItem('architecture.dock.open');
});

test('the container ratio reaches the engine CONSTRUCTOR, and only the ratio', () => {
  const hinted = recordingEngineClass();
  const engine = createLayoutEngine({ aspectRatio: 1200 / 900, Engine: hinted.Engine });
  assert.ok(engine instanceof hinted.Engine, 'the factory returns the class it was handed');
  assert.equal(hinted.received.length, 1, 'one engine is constructed per layout');
  assert.deepEqual(hinted.received[0], { aspectRatio: 1200 / 900 }, 'the container ratio is the constructor option');
  assert.deepEqual(
    Object.keys(hinted.received[0] ?? {}),
    ['aspectRatio'],
    'no raw elk options and no second knob: 0.3.0 folds on aspectRatio alone',
  );

  // Out-of-band ratios are clamped, not passed through as-is.
  const narrow = recordingEngineClass();
  createLayoutEngine({ aspectRatio: 0.05, Engine: narrow.Engine });
  assert.deepEqual(narrow.received[0], { aspectRatio: MIN_LAYOUT_ASPECT_RATIO });
  const wide = recordingEngineClass();
  createLayoutEngine({ aspectRatio: 40, Engine: wide.Engine });
  assert.deepEqual(wide.received[0], { aspectRatio: MAX_LAYOUT_ASPECT_RATIO });

  // No measurement means no opinion: the engine is constructed with NO options,
  // so the package's own 1.6 default is what applies.
  const untouched = recordingEngineClass();
  createLayoutEngine({ aspectRatio: null, Engine: untouched.Engine });
  assert.equal(untouched.received.length, 1);
  assert.equal(untouched.received[0], undefined, 'an unmeasured container must not guess a ratio');
});

test('a real 18-group overview folds to a portrait canvas at a portrait ratio, and stays wide without one', async () => {
  // Control arm: no measurement leaves the overview its natural wide shape
  // (measured 1128×536, aspect 2.10 on plantuml-js 0.3.0).
  const fallback = await drawFixture(EIGHTEEN_GROUP_OVERVIEW, null);
  assert.ok(fallback.aspect !== null, 'the fixture must draw a viewBox');
  assert.ok(
    fallback.aspect > 1.5,
    `the unmeasured overview must be the wide drawing this case discriminates against; got ${fallback.aspect.toFixed(3)}`,
  );

  // The arm under test: a phone-portrait container (~0.53) folds the same graph.
  const portrait = await drawFixture(EIGHTEEN_GROUP_OVERVIEW, 0.53);
  assert.ok(portrait.aspect !== null, 'the portrait arm must draw a viewBox');
  assert.ok(
    portrait.aspect < 1,
    `aspectRatio 0.53 must fold the flat overview into a portrait canvas; got ${portrait.aspect.toFixed(3)} (${String(portrait.viewBox)})`,
  );
  assert.ok(
    aspectFactor(portrait.aspect, 0.53) < aspectFactor(fallback.aspect, 0.53),
    'the hinted canvas must be closer to the container than the default one',
  );
});

test('a real 26-package hierarchy lays out in a readable default aspect and still answers the container', async () => {
  // The shape 0.2.x drew as a 16:1 band; 0.3.0 fixes it upstream. Measured on
  // this fixture: 3829.67×2416.8 (aspect 1.59) with no container hint.
  const fallback = await drawFixture(TWENTY_SIX_PACKAGE_HIERARCHY, null);
  assert.ok(fallback.aspect !== null, 'the hierarchy fixture must draw a viewBox');
  assert.ok(
    fallback.aspect < 3,
    `a 26-package hierarchy must not be the 16:1 band any more; got ${fallback.aspect.toFixed(3)}`,
  );

  const portrait = await drawFixture(TWENTY_SIX_PACKAGE_HIERARCHY, 0.53);
  assert.ok(portrait.aspect !== null, 'the portrait arm must draw a viewBox');
  assert.ok(
    aspectFactor(portrait.aspect, 0.53) < aspectFactor(fallback.aspect, 0.53),
    `the hinted hierarchy must move toward the container; got ${portrait.aspect.toFixed(3)} vs ${fallback.aspect.toFixed(3)}`,
  );
});

test('the aspect hint changes geometry, never the drawing’s nodes or edges', async () => {
  const { ElkLayoutEngine, parsePlantUml } = (await import('@yalehwang/plantuml-js/elk')) as unknown as ElkModule;
  const model = parsePlantUml(EIGHTEEN_GROUP_OVERVIEW);

  const defaultLayout = await createLayoutEngine({ aspectRatio: null, Engine: ElkLayoutEngine })
    .layout(model as never) as unknown as {
      readonly nodes: readonly { id: string; x: number; y: number }[];
      readonly edges: readonly { id: string }[];
      readonly width: number;
      readonly height: number;
    };
  const aspectLayout = await createLayoutEngine({ aspectRatio: 0.53, Engine: ElkLayoutEngine })
    .layout(model as never) as unknown as typeof defaultLayout;

  const ids = (layout: typeof defaultLayout): string[] => layout.nodes.map((node) => node.id).sort();
  const edgeIds = (layout: typeof defaultLayout): string[] => layout.edges.map((edge) => edge.id).sort();

  assert.deepEqual(ids(aspectLayout), ids(defaultLayout), 'the aspect hint must not add or drop nodes');
  assert.deepEqual(edgeIds(aspectLayout), edgeIds(defaultLayout), 'the aspect hint must not add or drop edges');

  const geometry = (layout: typeof defaultLayout): string =>
    JSON.stringify(layout.nodes.map((node) => [node.id, node.x, node.y]));
  assert.notEqual(
    geometry(aspectLayout),
    geometry(defaultLayout),
    'a portrait container must actually move nodes, not just re-label the drawing',
  );
});

test('a resize below the threshold re-fits, a shape change past it re-lays out once, debounced', async () => {
  pinContainerBox(1200, 900);
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  const host = await waitForDiagram();
  const drawings = countDrawings(host);

  // +5% width: the ratio moves 1.333 → 1.400. A fit, not a layout.
  pinContainerBox(1260, 900);
  triggerResize();
  await settleAspectRelayout();
  assert.equal(drawings(), 0, 'a resize inside the threshold must not re-lay the diagram out');

  // Landscape → portrait in three steps inside one debounce window: the drawing
  // must be replaced exactly once, for the LAST ratio.
  pinContainerBox(450, 900);
  triggerResize();
  pinContainerBox(430, 900);
  triggerResize();
  pinContainerBox(400, 900);
  triggerResize();

  await new Promise((resolveEarly) => setTimeout(resolveEarly, ASPECT_RELAYOUT_DEBOUNCE_MS / 2));
  assert.equal(drawings(), 0, 'the re-layout must wait for the container to settle, not run per resize event');

  await waitFor(() => assert.equal(drawings(), 1, 'the settled shape change must produce exactly one new drawing'), {
    timeout: 4000,
  });
});

test('the ratio policy is a pure reading: threshold, null handling, and the clamp band', () => {
  const threshold = 1.3333;
  assert.equal(ASPECT_RELAYOUT_THRESHOLD, 0.15);

  // Just inside / just outside the documented 15%.
  assert.equal(shouldRelayoutForAspect(threshold, threshold * 1.14), false, 'a 14% change only re-fits');
  assert.equal(shouldRelayoutForAspect(threshold, threshold * 1.16), true, 'a 16% change earns a layout');
  assert.equal(shouldRelayoutForAspect(threshold, threshold * 0.84), true, 'the rule is symmetric on shrink');

  // A drawing made before the container could be measured used the engine
  // default, so that is what a measurement is compared against.
  assert.equal(shouldRelayoutForAspect(null, DEFAULT_LAYOUT_ASPECT_RATIO * 1.1), false);
  assert.equal(shouldRelayoutForAspect(null, 0.5), true);
  // An unusable measurement never triggers work.
  assert.equal(shouldRelayoutForAspect(threshold, null), false);
  assert.equal(shouldRelayoutForAspect(threshold, 0), false);

  assert.equal(clampAspectRatio(0.1), MIN_LAYOUT_ASPECT_RATIO);
  assert.equal(clampAspectRatio(10), MAX_LAYOUT_ASPECT_RATIO);
  assert.equal(clampAspectRatio(Number.NaN), DEFAULT_LAYOUT_ASPECT_RATIO);

  // The relayout LOCK is a pure argument: while a dock open/close (or a live
  // split drag) is in progress, even a ratio far past the threshold re-fits
  // only. Lifting the lock re-enables the ordinary rule.
  assert.equal(
    shouldRelayoutForAspect(threshold, threshold * 0.5, { locked: true }),
    false,
    'a locked reading never earns a re-layout',
  );
  assert.equal(
    shouldRelayoutForAspect(threshold, threshold * 0.5, { locked: false }),
    true,
    'the same shape change earns a layout once the lock lifts',
  );
  assert.equal(shouldRelayoutForAspect(threshold, threshold, { locked: true }), false);
});

test('the dock opening freezes aspect re-layout, and the toggle itself is not a shape change', async () => {
  pinContainerBox(1200, 900); // ratio 1.333
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  const host = await waitForDiagram();
  const drawings = countDrawings(host);

  // Selecting a node opens the dock. That is the gesture whose 160ms transition
  // freezes aspect-driven re-layout.
  const node = host.querySelector('[data-entity-id]');
  assert.ok(node !== null, 'the class view must draw an entity to select');
  fireEvent.click(node);
  assert.ok(document.querySelector('[data-architecture-dock]'), 'the dock must open on a selection');

  // The dock narrows the canvas from 1200 to 880: ratio 1.333 → 0.978, far past
  // the 15% threshold. While the lock holds, this must only re-fit.
  pinContainerBox(880, 900);
  triggerResize();
  await settleAspectRelayout();
  assert.equal(drawings(), 0, 'a locked (dock-transition) shape change must not re-lay out the graph');

  // The lock has lifted (its 200ms window is shorter than the debounce wait).
  // The SAME ratio must still not re-lay out: the dock toggle was never a shape
  // change, so it must not be counted as one after the fact either.
  triggerResize();
  await settleAspectRelayout();
  assert.equal(drawings(), 0, 'the dock toggle must not become a shape change once the lock lifts');

  // A genuine later shape change still earns exactly one layout.
  pinContainerBox(600, 900);
  triggerResize();
  await waitFor(() => assert.equal(drawings(), 1, 'a real resize after the dock settles re-lays out once'), {
    timeout: 4000,
  });
});

test('the layout engine is constructed in exactly one factory, through the public option', () => {
  const graphSource = readFileSync(
    resolve(process.cwd(), 'src', 'modules', 'architecture', 'PlantUmlGraph.tsx'),
    'utf8',
  );
  const engineSource = readFileSync(
    resolve(process.cwd(), 'src', 'modules', 'architecture', 'elkAspectEngine.ts'),
    'utf8',
  );

  assert.match(
    engineSource,
    /export function createLayoutEngine\(/,
    'the factory is the single construction point for the layout engine',
  );
  assert.match(graphSource, /createLayoutEngine\(\{/, 'the diagram must build its engine through that factory');

  // The engine is built with the package's public constructor option. Exactly
  // two branches construct it: the unmeasured one and the hinted one.
  const constructions = engineSource.match(/new Engine\(/g) ?? [];
  assert.equal(constructions.length, 2, 'exactly two branches construct an engine');
  assert.match(
    engineSource,
    /new Engine\(\{ aspectRatio:/,
    'the container ratio is passed as the public ElkLayoutOptions.aspectRatio',
  );

  // The 0.2.x seam — reaching into the engine's private elkjs client and
  // wrapping `client.layout` — is gone.
  assert.ok(
    !/\.elk\b/.test(engineSource),
    'the factory must not read the engine’s private elk client any more',
  );
  assert.ok(
    !engineSource.includes('layout.bind'),
    'no layout call is wrapped: the ratio is a constructor option now',
  );

  // ... and the diagram does not construct an engine itself.
  assert.ok(
    !graphSource.includes('new ElkLayoutEngine('),
    'the diagram must not construct an engine outside the factory',
  );
  assert.match(graphSource, /Engine: ElkLayoutEngine/, 'the diagram hands the factory the engine CLASS');
  const packageLiterals = graphSource.match(/from ['"]@yalehwang\/plantuml-js\/elk['"]/g) ?? [];
  assert.equal(
    packageLiterals.length,
    0,
    'the package is still reached only through the dynamic import, never a static one',
  );
});

/* ── a class box is as wide as the text the drawing shows ─────────────────── */

/** The 105-character declaration the two-entity fixture carries. */
const LONG_SIGNATURE = nodeSizeMemberSignature(NODE_SIZE_ENTITIES[0].members[4]);

/**
 * The width the renderer's own text table gives one line, read through it.
 *
 * `measureTextWidth` is internal, but a box whose TITLE is the line is sized
 * by exactly `snapUp(max(60, width(line) + 2 × paddingX))` — the same formula
 * `estimateEntitySize` applies to a member row. `paddingX = 10` and the snap
 * grid is 8, so subtracting 28 is a guaranteed LOWER bound on the line's real
 * width: a check against that bound is stricter than the criterion, never
 * looser.
 */
async function drawnLineWidth(line: string): Promise<number> {
  const { renderDetailed, ElkLayoutEngine } = (await import('@yalehwang/plantuml-js/elk')) as unknown as {
    renderDetailed: (input: string, options?: unknown) => Promise<{ layout: { nodes: { width: number }[] } }>;
    ElkLayoutEngine: new () => unknown;
  };
  const puml = `@startuml\nclass "${line.replace(/"/g, "'")}" as p0\n@enduml`;
  const detailed = await renderDetailed(puml, { layout: new ElkLayoutEngine() });
  return detailed.layout.nodes[0].width - 28;
}

test('a long-signature class is sized by the member text the drawing shows', async () => {
  const { renderDetailed, ElkLayoutEngine, toPlantUml } = (await import('@yalehwang/plantuml-js/elk')) as unknown as {
    renderDetailed: (
      input: string,
      options?: unknown,
    ) => Promise<{
      svg: string;
      model: { entities: { id: string; members: { raw: string; display?: string }[] }[] };
      layout: { nodes: { id: string; width: number }[] };
    }>;
    toPlantUml: (model: unknown) => string;
    ElkLayoutEngine: new () => unknown;
  };
  const diagram = archguardToPlantUml(nodeSizeEntityGraph() as never);
  const detailed = await renderDetailed(diagram.puml, {
    layout: createLayoutEngine({
      aspectRatio: null,
      Engine: ElkLayoutEngine as unknown as ArchitectureLayoutEngineClass,
    }),
    ...memberDisplayLimits(),
  });
  const alias = diagram.aliasOf.get(NODE_SIZE_ENTITIES[0].id) as string;
  const node = detailed.layout.nodes.find((candidate) => candidate.id === alias);
  assert.ok(node !== undefined);
  // The criterion reads `data-w`, so read the attribute the SVG actually carries.
  const svgWidth = Number(
    detailed.svg.match(new RegExp(`data-entity-id="${alias}"[^>]*data-w="([\\d.]+)"`))?.[1] ?? 'NaN',
  );
  assert.equal(svgWidth, node.width, 'the data-w the canvas reads is the layout width');

  const entity = detailed.model.entities.find((candidate) => candidate.id === alias);
  assert.ok(entity !== undefined);
  // "可见文字" is the class name plus the rows the DRAWING paints: the model
  // keeps every member, but the canvas shows at most `MEMBER_MAX_ROWS` of them
  // and folds the tail into the app's own `… +N more (M members)` row.
  const drawnRows = entity.members
    .slice(0, MEMBER_MAX_ROWS)
    .map((member) => member.display ?? member.raw);
  if (entity.members.length > MEMBER_MAX_ROWS) {
    drawnRows.push(memberOverflowLabel(entity.members.length - MEMBER_MAX_ROWS, entity.members.length));
  }
  const visible = [NODE_SIZE_ENTITIES[0].name, ...drawnRows];
  let longest = 0;
  for (const line of visible) longest = Math.max(longest, await drawnLineWidth(line));
  assert.ok(longest > 0, 'the fixture has text to measure');
  assert.ok(
    svgWidth <= 1.35 * longest + 24,
    `data-w ${svgWidth} must stay within 1.35 × the longest visible line (${longest}) + 24`,
  );

  // The discriminating half: the box the 105-character RAW declaration would
  // have sized is far wider, and the drawing does not carry it.
  const rawWidth = await drawnLineWidth(`+ ${LONG_SIGNATURE}`);
  assert.ok(
    rawWidth > svgWidth * 1.5,
    `the capped box (${svgWidth}) must be well under the uncapped one (${rawWidth})`,
  );
  assert.ok(!toPlantUml(detailed.model).includes('data-w'), 'the copied document is text, not geometry');
  assert.ok(toPlantUml(detailed.model).includes(LONG_SIGNATURE), 'and it keeps the full declaration');
});
