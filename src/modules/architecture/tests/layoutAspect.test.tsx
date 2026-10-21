import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { beforeAll, beforeEach, test, vi } from 'vitest';

import type { ArchitectureGraphResult } from '@/modules/architecture';
import { ArchitecturePanel } from '@/modules/architecture';
import { archguardToPlantUml } from '@/modules/architecture/archguardToPlantUml';
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
} from '@/modules/architecture/elkAspectEngine';
import enCommon from '@/modules/i18n/locales/en/common.json';
import type * as SharedApiModule from '@/shared/api';

/**
 * The architecture tab's layout-aspect contract, end to end at the same
 * component seam `architectureTab.test.tsx` uses:
 *  · the container's width/height is a LAYOUT input — a 1200×900 container gets
 *    a drawing whose own proportions follow it, while the same graph laid out
 *    without a measurement keeps the engine's default (wide/deep) shape;
 *  · the aspect hint reaches the ELK layout call through exactly one factory,
 *    and the wrapped layout is structurally the same drawing (same nodes/edges);
 *  · a slight resize only re-fits, while a shape change past the threshold
 *    re-lays the diagram out once — after the debounce, not per frame.
 */

// The whole network hop is stubbed; the hook, the panel, the bridge and the
// real PlantUML/ELK renderer are real.
const apiMock = vi.hoisted(() => ({ architectureGraph: vi.fn() }));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApiModule>();
  return {
    ...actual,
    api: { ...actual.api, architectureGraph: apiMock.architectureGraph },
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
 * A 26-node dependency CHAIN, one file per directory. The shape matters: a
 * chain is the archetypal architecture graph (each module depends on the next),
 * and laid out by the engine's own default proportions it becomes a single
 * extremely deep strip — the mirror image of the wide strip this feature is
 * about. The container ratio is what turns it into a readable block.
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

/** The aspect ratio (width / height) of the coordinate space the renderer emitted. */
function canvasAspect(host: HTMLElement): number {
  const svg = host.querySelector('svg');
  assert.ok(svg !== null, 'the diagram must be drawn before reading its aspect');
  const parts = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  assert.equal(parts.length, 4, 'the renderer must emit a viewBox for the canvas to have an aspect');
  const width = parts[2];
  const height = parts[3];
  assert.ok(width > 0 && height > 0, `the viewBox must have a positive extent; got ${String(svg.getAttribute('viewBox'))}`);
  return width / height;
}

/** How far apart two aspect ratios are, as a multiplicative factor (never below 1). */
function aspectFactor(a: number, b: number): number {
  return a > b ? a / b : b / a;
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
});

test('the canvas follows the container ratio, and the same graph without a measurement does not', async () => {
  // Control arm first: no container box (jsdom's default), so the engine is
  // handed no ratio and lays the chain out for its own default proportions.
  pinContainerBox(0, 0);
  const control = render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  const controlHost = await waitForDiagram();
  const defaultAspect = canvasAspect(controlHost);
  control.unmount();
  assert.ok(
    defaultAspect < MIN_LAYOUT_ASPECT_RATIO,
    `the unmeasured chain must be far deeper than the clampable band, so this case can discriminate; got ${defaultAspect.toFixed(3)}`,
  );

  // The arm under test: a 1200×900 container (width / height = 1.33), pinned
  // before the renderer runs, so the FIRST layout already knows the shape.
  pinContainerBox(1200, 900);
  render(<ArchitecturePanel projectId="project-1" sessionId="session-1" />);
  const host = await waitForDiagram();
  await waitFor(() => {
    assert.ok(
      aspectFactor(canvasAspect(host), 1200 / 900) < 2.5,
      `the drawn canvas must follow the container's proportions; got ${canvasAspect(host).toFixed(3)} for a 1.333 container (default layout was ${defaultAspect.toFixed(3)})`,
    );
  });
  const fittedAspect = canvasAspect(host);
  assert.ok(
    fittedAspect > 0.5 && fittedAspect < 2,
    `the 1200×900 canvas must land in a readable band, not the 9–15 strip the default layout produces; got ${fittedAspect.toFixed(3)}`,
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
  await waitFor(() => {
    assert.ok(
      aspectFactor(canvasAspect(host), 400 / 900) < 2.5,
      `the re-laid canvas must follow the portrait container; got ${canvasAspect(host).toFixed(3)} for 0.444`,
    );
  });
});

test('the aspect hint is injected at the ELK layer call, and null keeps the engine untouched', async () => {
  /**
   * A stand-in engine shaped like the real one: it builds a graph carrying the
   * package's own default ratio and lays it out through its ELK client. The
   * wrapper can only be observed at that client call.
   */
  function fakeEngine(seen: Record<string, string>[]): ArchitectureLayoutEngine {
    const client = {
      layout: async (graph: { layoutOptions?: Record<string, string> }) => {
        seen.push(graph.layoutOptions ?? {});
        return { children: [] };
      },
    };
    return {
      elk: client,
      layout: async () => {
        await client.layout({ layoutOptions: { 'elk.aspectRatio': '1.6' } });
        return { nodes: [], edges: [], width: 0, height: 0 };
      },
    } as unknown as ArchitectureLayoutEngine;
  }

  const hintedSeen: Record<string, string>[] = [];
  await createLayoutEngine({ aspectRatio: 1200 / 900, engine: fakeEngine(hintedSeen) }).layout({} as never);
  assert.equal(hintedSeen.length, 1, 'the wrapped engine must still lay out through the ELK client');
  assert.equal(hintedSeen[0]['elk.aspectRatio'], String(1200 / 900), 'the container ratio is the injected ratio');
  assert.equal(
    hintedSeen[0]['elk.layered.wrapping.strategy'],
    '2',
    'wrapping is what makes the layered algorithm honour the ratio on deep graphs',
  );

  // Out-of-band ratios are clamped, not passed through as-is.
  const narrowSeen: Record<string, string>[] = [];
  await createLayoutEngine({ aspectRatio: 0.05, engine: fakeEngine(narrowSeen) }).layout({} as never);
  assert.equal(narrowSeen[0]['elk.aspectRatio'], String(MIN_LAYOUT_ASPECT_RATIO));
  const wideSeen: Record<string, string>[] = [];
  await createLayoutEngine({ aspectRatio: 40, engine: fakeEngine(wideSeen) }).layout({} as never);
  assert.equal(wideSeen[0]['elk.aspectRatio'], String(MAX_LAYOUT_ASPECT_RATIO));

  // Wrapping the same engine again replaces the hint instead of stacking two
  // injections (the second graph must not be re-hinted on its way in).
  const rewrappedSeen: Record<string, string>[] = [];
  const rewrapped = fakeEngine(rewrappedSeen);
  createLayoutEngine({ aspectRatio: 0.5, engine: rewrapped });
  await createLayoutEngine({ aspectRatio: 2, engine: rewrapped }).layout({} as never);
  assert.equal(rewrappedSeen[0]['elk.aspectRatio'], '2', 'the latest hint is the one that reaches ELK');

  // No measurement means no opinion: the factory hands back the engine itself.
  const untouchedSeen: Record<string, string>[] = [];
  const plain = fakeEngine(untouchedSeen);
  const untouched = createLayoutEngine({ aspectRatio: null, engine: plain });
  assert.equal(untouched, plain);
  await untouched.layout({} as never);
  assert.equal(untouchedSeen[0]['elk.aspectRatio'], '1.6', 'the unwrapped path keeps the engine default');
  assert.equal(untouchedSeen[0]['elk.layered.wrapping.strategy'], undefined, 'no wrapping without a hint');
});

test('the aspect-wrapped layout is the same drawing — same nodes and edges, different geometry', async () => {
  const { ElkLayoutEngine, parsePlantUml } = (await import('@yalehwang/plantuml-js/elk')) as unknown as {
    ElkLayoutEngine: new () => ArchitectureLayoutEngine;
    parsePlantUml: (puml: string) => unknown;
  };
  const { puml } = archguardToPlantUml(chainResult().graph.file);
  const model = parsePlantUml(puml);

  const defaultLayout = await createLayoutEngine({
    aspectRatio: null,
    engine: new ElkLayoutEngine(),
  }).layout(model as never);
  const aspectLayout = await createLayoutEngine({
    aspectRatio: 0.6,
    engine: new ElkLayoutEngine(),
  }).layout(model as never);

  const ids = (layout: { nodes: readonly { id: string }[] }): string[] =>
    layout.nodes.map((node) => node.id).sort();
  const edgeIds = (layout: { edges: readonly { id: string }[] }): string[] =>
    layout.edges.map((edge) => edge.id).sort();

  assert.deepEqual(ids(aspectLayout), ids(defaultLayout), 'the aspect hint must not add or drop nodes');
  assert.deepEqual(edgeIds(aspectLayout), edgeIds(defaultLayout), 'the aspect hint must not add or drop edges');

  const geometry = (layout: { nodes: readonly { id: string; x: number; y: number }[] }): string =>
    JSON.stringify(layout.nodes.map((node) => [node.id, node.x, node.y]));
  assert.notEqual(
    geometry(aspectLayout),
    geometry(defaultLayout),
    'a 0.6-aspect container must actually move nodes, not just re-label the drawing',
  );
  assert.ok(
    aspectFactor(aspectLayout.width / aspectLayout.height, 0.6)
      < aspectFactor(defaultLayout.width / defaultLayout.height, 0.6),
    `the hinted layout must be proportionally closer to 0.6 than the default; got ${(aspectLayout.width / aspectLayout.height).toFixed(3)} vs ${(defaultLayout.width / defaultLayout.height).toFixed(3)}`,
  );
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
});

test('the layout engine is constructed in exactly one factory, so the upstream option is a one-function switch', () => {
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

  // The ELK option names live in the factory body and nowhere else: a quoted
  // key (not the prose that explains it) must occur exactly once.
  const aspectOptionWrites = engineSource.match(/['"]elk\.aspectRatio['"]\s*:/g) ?? [];
  assert.equal(aspectOptionWrites.length, 1, 'exactly one place writes the aspect option');
  assert.ok(
    !graphSource.includes("'elk.aspectRatio'") && !graphSource.includes('"elk.aspectRatio"'),
    'the diagram must not inject ELK options itself — that is the factory’s job',
  );
  const packageLiterals = graphSource.match(/from ['"]@yalehwang\/plantuml-js\/elk['"]/g) ?? [];
  assert.equal(
    packageLiterals.length,
    0,
    'the package is still reached only through the dynamic import, never a static one',
  );
});
