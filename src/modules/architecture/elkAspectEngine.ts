import type { LayoutEngine } from '@yalehwang/plantuml-js/elk';

/**
 * The container-aspect layout hint for the architecture diagram.
 *
 * ELK lays a graph out for its own default proportions, so a container's shape
 * never reached the layout: a tall narrow screen was handed the same wide
 * drawing a desktop got, and the client only scaled that drawing to fit. This
 * module is the layout-side half of the fix — it builds the renderer's
 * `LayoutEngine` and injects the container's width/height ratio into the ELK
 * layout call, so the drawing is laid out FOR the container instead of scaled
 * into it afterwards.
 *
 * The package's ELK engine (0.1.0) exposes no `layoutOptions` of its own, so
 * the hint is injected at the one seam that exists: the graph object each
 * engine hands to its elkjs client. `createLayoutEngine` is the SINGLE place
 * that seam is touched, which is also why switching to the upstream
 * `layoutOptions: { aspectRatio }` (plantuml-js `gap-layout-aspect-ratio-option`)
 * is a one-function change here and nowhere else: callers keep passing a ratio
 * and tests keep asserting the ratio reaches the layout.
 *
 * Consumers: `PlantUmlGraph.tsx` (the diagram) and
 * `tests/layoutAspect.test.tsx` (ratio plumbing, structure equivalence, the
 * re-layout threshold and its debounce).
 */

/** The layout contract this module returns; mirrors the package's `LayoutEngine`. */
export type ArchitectureLayoutEngine = LayoutEngine;

/**
 * The ratio the ELK engine applies when nothing measures the container. It is
 * the package's own built-in default (`elk.aspectRatio: '1.6'` in 0.1.0), so a
 * drawing made without a hint is compared against the ratio it actually used
 * rather than against a number invented here.
 */
export const DEFAULT_LAYOUT_ASPECT_RATIO = 1.6;

/**
 * The band a container ratio is clamped into. A phone in portrait is ~0.5 and a
 * wide desktop window ~2.5; beyond these extremes the ratio stops describing a
 * readable diagram (ELK would fold a graph into one-column strips), so the
 * clamp keeps the hint a hint.
 */
export const MIN_LAYOUT_ASPECT_RATIO = 0.4;
export const MAX_LAYOUT_ASPECT_RATIO = 3;

/**
 * How much the container ratio must change before the diagram is laid out
 * again. Resizing slightly (a scrollbar appearing, a panel nudging the split)
 * only re-fits the existing drawing; a layout is expensive and changes every
 * position, so it takes a real shape change to earn one.
 */
export const ASPECT_RELAYOUT_THRESHOLD = 0.15;

/**
 * How long the container ratio must hold still before that re-layout runs. A
 * window drag emits a continuous stream of sizes; without the wait the last
 * second of the drag would re-lay the graph out on every frame.
 */
export const ASPECT_RELAYOUT_DEBOUNCE_MS = 250;

/** The container ratio, clamped; a missing/unusable measurement falls back to the engine default. */
export function clampAspectRatio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return DEFAULT_LAYOUT_ASPECT_RATIO;
  return Math.min(MAX_LAYOUT_ASPECT_RATIO, Math.max(MIN_LAYOUT_ASPECT_RATIO, ratio));
}

/**
 * Whether a container measurement is far enough from the ratio the drawing on
 * screen was laid out with to earn a re-layout. `drawn` is `null` for a drawing
 * made before the container could be measured — it used the engine default, so
 * that is the ratio it is compared against.
 */
export function shouldRelayoutForAspect(drawn: number | null, measured: number | null): boolean {
  if (measured === null || !Number.isFinite(measured) || measured <= 0) return false;
  const base = drawn === null ? DEFAULT_LAYOUT_ASPECT_RATIO : clampAspectRatio(drawn);
  return Math.abs(clampAspectRatio(measured) - base) / base > ASPECT_RELAYOUT_THRESHOLD;
}

/** One graph node as the engine hands it to elkjs; only `layoutOptions` and `children` are read. */
type ElkGraph = {
  readonly layoutOptions?: Readonly<Record<string, string>>;
  readonly children?: readonly ElkGraph[];
};

/** The elkjs client the engine lays out through; its `layout` is the injection seam. */
type ElkClient = {
  layout(graph: ElkGraph, options?: unknown): Promise<unknown>;
};

/** The only part of the wrapped engine this module needs, and the part the package keeps private. */
type EngineWithElkClient = {
  elk: ElkClient;
};

/**
 * The client's ORIGINAL layout, remembered across wraps so wrapping the same
 * engine twice replaces the ratio instead of stacking two injections (the
 * second graph would otherwise be re-hinted on the way into the first).
 */
const BASE_ELK_LAYOUT = Symbol('architecture.elkAspect.baseLayout');
type ElkClientWithBase = ElkClient & { [BASE_ELK_LAYOUT]?: ElkClient['layout'] };

/**
 * `elk.layered.wrapping.strategy = MULTI_EDGE`. Measured while implementing
 * this module: `elk.aspectRatio` alone only steers how DISCONNECTED components
 * are packed, so a deep dependency chain stayed a 0.03-aspect strip whatever
 * ratio was asked for. Wrapping is what makes the layered algorithm fold a long
 * layer sequence into rows and therefore honour the requested ratio.
 */
const WRAPPING_LAYOUT_OPTIONS: Readonly<Record<string, string>> = {
  'elk.layered.wrapping.strategy': '2',
};

/**
 * The same graph with the container ratio (and the wrapping that makes it bite)
 * applied — at EVERY hierarchical level, not just the root.
 *
 * The architecture model is packaged: the root only arranges a handful of
 * package containers while the layered layout that decides the drawing's shape
 * runs inside each container. Measured: setting the option on the root alone
 * left a 26-package chain at aspect 0.06 whatever ratio was asked for, while
 * the same option on the containers moved it to 1.64 for a 1.33 container.
 */
function withAspectHint(graph: ElkGraph, ratio: number): ElkGraph {
  const layoutOptions = {
    ...graph.layoutOptions,
    ...WRAPPING_LAYOUT_OPTIONS,
    'elk.aspectRatio': String(ratio),
  };
  if (graph.children === undefined) return { ...graph, layoutOptions };
  return {
    ...graph,
    layoutOptions,
    children: graph.children.map((child) => withAspectHint(child, ratio)),
  };
}

/** What the factory needs: the ratio to apply (null = leave the engine alone) and the engine to steer. */
export type CreateLayoutEngineOptions = {
  /**
   * The container's width/height, or `null` when nothing measured it (a
   * container that has not been laid out yet). `null` returns the engine
   * untouched, so a caller without a measurement keeps the package's own
   * proportions instead of a guess.
   */
  readonly aspectRatio: number | null;
  /**
   * The engine to wrap. Injected rather than constructed here because the
   * package is loaded through a dynamic import (it must stay out of the
   * first-screen chunk) — the caller owns that import, this module owns what is
   * done with the instance.
   */
  readonly engine: ArchitectureLayoutEngine;
};

/**
 * Build the layout engine the renderer is given. THE single construction point
 * for the architecture diagram: `PlantUmlGraph` never touches an engine other
 * than through this function, so replacing the injection with the upstream
 * `createRenderer({ layout: 'elk', layoutOptions: { aspectRatio } })` is a
 * change to this body alone.
 */
export function createLayoutEngine({
  aspectRatio,
  engine,
}: CreateLayoutEngineOptions): ArchitectureLayoutEngine {
  if (aspectRatio === null) return engine;

  const ratio = clampAspectRatio(aspectRatio);
  const client = (engine as unknown as Partial<EngineWithElkClient>).elk;
  if (client === undefined || typeof client.layout !== 'function') {
    // Fail loudly rather than quietly drawing the default proportions: a hint
    // that never reaches the layout must not look like a hint that was applied.
    throw new Error(
      'createLayoutEngine: the layout engine exposes no elkjs client, so the container aspect ratio cannot be applied',
    );
  }

  const target = client as ElkClientWithBase;
  const layoutInElk = target[BASE_ELK_LAYOUT] ?? client.layout.bind(client);
  target[BASE_ELK_LAYOUT] = layoutInElk;
  client.layout = (graph: ElkGraph, options?: unknown): Promise<unknown> =>
    layoutInElk(withAspectHint(graph, ratio), options);
  return engine;
}
