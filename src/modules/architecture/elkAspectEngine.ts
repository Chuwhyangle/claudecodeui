import type { LayoutEngine } from '@yalehwang/plantuml-js/elk';

/**
 * The container-aspect layout hint for the architecture diagram.
 *
 * ELK lays a graph out for its own default proportions, so a container's shape
 * never reached the layout: a tall narrow screen was handed the same wide
 * drawing a desktop got, and the client only scaled that drawing to fit. This
 * module is the layout-side half of the fix — it CONSTRUCTS the renderer's
 * `LayoutEngine` with the container's width/height ratio as the engine's
 * `aspectRatio` option, so the drawing is laid out FOR the container instead of
 * scaled into it afterwards.
 *
 * This is the upstream seam `elkAspectEngine`'s predecessor announced: through
 * plantuml-js 0.2.x the package exposed no layout options, so the ratio was
 * injected by wrapping the engine's private elkjs client. 0.3.0 makes
 * `aspectRatio` a public constructor option (and injects it into the root and
 * every package container), so the wrap is gone: `createLayoutEngine` is the
 * SINGLE place an engine is constructed, and it passes exactly one option.
 *
 * Consumers: `PlantUmlGraph.tsx` (the diagram) and
 * `tests/layoutAspect.test.tsx` (ratio plumbing, the re-layout threshold and
 * its debounce, and the drawn proportions of real-shape fixtures).
 */

/** The layout contract this module returns; mirrors the package's `LayoutEngine`. */
export type ArchitectureLayoutEngine = LayoutEngine;

/**
 * The public constructor options this module uses. Kept as a structural subset
 * of the package's `ElkLayoutOptions` so no package type has to be imported at
 * runtime (the package is loaded through a dynamic import by the caller).
 */
export type ArchitectureLayoutEngineOptions = {
  /** Target canvas width/height ratio (`elk.aspectRatio`), e.g. 16/9 for a desktop panel. */
  readonly aspectRatio?: number;
};

/**
 * The engine constructor the factory builds. Injected rather than imported:
 * the package is loaded through a dynamic import (it must stay out of the
 * first-screen chunk), so the caller owns that import and this module owns the
 * options the instance is built with.
 */
export type ArchitectureLayoutEngineClass = new (
  options?: ArchitectureLayoutEngineOptions,
) => ArchitectureLayoutEngine;

/**
 * The ratio the ELK engine applies when nothing measures the container. It is
 * the package's own built-in default (`elk.aspectRatio: 1.6`), so a drawing
 * made without a hint is compared against the ratio it actually used rather
 * than against a number invented here.
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

/** What the factory needs: the ratio to apply (null = no hint) and the engine class to build. */
export type CreateLayoutEngineOptions = {
  /**
   * The container's width/height, or `null` when nothing measured it (a
   * container that has not been laid out yet). `null` constructs the engine
   * with no options, so a caller without a measurement keeps the package's own
   * proportions instead of a guess.
   */
  readonly aspectRatio: number | null;
  /** The engine class to construct; see {@link ArchitectureLayoutEngineClass}. */
  readonly Engine: ArchitectureLayoutEngineClass;
};

/**
 * Build the layout engine the renderer is given. THE single construction point
 * for the architecture diagram: `PlantUmlGraph` never constructs an engine
 * itself, so the ratio is passed through this one function.
 *
 * Only `aspectRatio` is set. The local 0.2.x patches — the `wrapping.strategy`
 * raw option and the leaf-layer `COFFMAN_GRAHAM` bound — were measured on
 * 0.3.0 and removed: `aspectRatio` now folds flat overviews and nested
 * hierarchies on its own, and neither patch changed a single reading (see the
 * task's implementation record).
 */
export function createLayoutEngine({
  aspectRatio,
  Engine,
}: CreateLayoutEngineOptions): ArchitectureLayoutEngine {
  if (aspectRatio === null) return new Engine();
  return new Engine({ aspectRatio: clampAspectRatio(aspectRatio) });
}
