import { directoryPathOf } from '@/modules/architecture/adaptiveGrouping';
import {
  buildHierarchyIndex,
  ROOT_PACKAGE_ID,
  type ArchitectureHierarchyIndex,
} from '@/modules/architecture/hierarchyIndex';
import type { ArchitectureRendererGraph } from '@/modules/architecture/rendererContract';
import type { SvgViewportSize } from '@/modules/architecture/svgViewport';

/**
 * The readable-zoom policy for the architecture diagram's default view.
 *
 * Fitting a whole graph into a panel is not the same as making it legible: a
 * 32880×9860 drawing fitted into 1151px needs ~3.5%, at which the renderer's
 * 13px labels draw under half a pixel tall. This module decides between two
 * honest readings of the same drawing:
 *
 *  · focus — stop trying to show everything; render at the scale where a label
 *    is at least readable and centre the package carrying the densest share of
 *    the transcript's seeds;
 *  · overview — keep the whole graph in view, but say plainly that it is too
 *    small to read and name the package worth zooming into.
 *
 * It also flags a drawing whose natural width/height is far wider than the
 * container: such a canvas becomes a thin band, so the caller collapses it to
 * the directory-grouped overview instead.
 *
 * Everything here is pure arithmetic over the graph payload and the two sizes,
 * so the policy can be pinned without a laid-out browser. Consumers:
 * `PlantUmlGraph.tsx` (the default scale and the focus target) and
 * `tests/readableZoom.test.tsx`.
 */

/** The renderer's node-label font size, in SVG user units at 100% zoom. */
export const RENDERED_LABEL_FONT_PX = 13;

/** The smallest on-screen label that still reads as text rather than a smear. */
export const MIN_READABLE_FONT_PX = 9;

/**
 * The scale at which a rendered 13px label occupies 9 CSS pixels. Below this a
 * fitted diagram is technically complete but practically unreadable, which is
 * exactly the state this policy replaces with a focus view.
 */
export const READABLE_ZOOM_SCALE = MIN_READABLE_FONT_PX / RENDERED_LABEL_FONT_PX;

/**
 * How much wider than its container a drawing may be before it is a band rather
 * than a diagram. Expressed as the quotient of the two aspect ratios, so it is
 * independent of whether the container is landscape or portrait: a 17:1 drawing
 * in a 1.6:1 panel is ~10.8 and collapses; a 2:1 drawing in the same panel is
 * ~1.25 and is left alone.
 */
export const WIDE_CANVAS_ASPECT_RATIO = 6;

/** The two readings the toolbar offers. */
export type ReadableZoomMode = 'focus' | 'overview';

/** A package ranked by how much of its subtree the transcript seeded. */
export type SeedPackageCandidate = {
  /** The path-form package id (`modules/chat/hooks`). */
  readonly packageId: string;
  /** The last path segment, for a compact readout. */
  readonly name: string;
  /** Seeds in the package's whole subtree. */
  readonly seedCount: number;
  /** Entities in the package's whole subtree. */
  readonly entityCount: number;
  /** `seedCount / entityCount`; the primary ranking key. */
  readonly density: number;
};

/** The values the overview hint needs; the component supplies the wording. */
export type ReadableZoomHint = {
  /** The package the reader should zoom into first. */
  readonly packageId: string;
  /** How many OTHER seeded packages share the drawing. */
  readonly packageCount: number;
  /** The scale actually applied, as a whole percentage. */
  readonly zoomPercent: number;
};

/** What the default view should do with one drawing. */
export type ReadableZoomDecision = {
  /** The mode to apply: the user's choice when given, else the default. */
  readonly mode: ReadableZoomMode;
  /** The mode this drawing would choose on its own. */
  readonly defaultMode: ReadableZoomMode;
  /** The uniform scale for `mode`: readable in focus, geometric in overview. */
  readonly scale: number;
  /** The package focus mode centres; `null` when the graph has no package. */
  readonly focusPackageId: string | null;
  /** True when the drawing is a band in this container and should collapse. */
  readonly collapsedForAspect: boolean;
  /** The overview-mode hint, `null` while focused (or with no seed packages). */
  readonly overviewHint: ReadableZoomHint | null;
};

/** Everything one decision reads. */
export type ReadableZoomInput = {
  /**
   * The geometric fit scale (the drawing's natural size fitted into the
   * viewport, clamped by the viewport's own floor). Pass the fit-ALL value, not
   * one already lifted to the readable floor, or the default can never choose
   * focus.
   */
  readonly fitScale: number;
  /** The drawing's natural size, for the aspect-band test. */
  readonly natural: SvgViewportSize;
  /** The measured content box, or `null` before layout. */
  readonly viewport: SvgViewportSize | null;
  /** The drawing's package tree; `null` when no hierarchy was built. */
  readonly hierarchy: ArchitectureHierarchyIndex | null;
  /** Selected/centre entity ids, preferred over the density winner. */
  readonly selectedEntityIds?: readonly (string | null | undefined)[];
  /** The user's explicit toolbar choice; omitted means "use the default". */
  readonly mode?: ReadableZoomMode;
};

/**
 * Build the package hierarchy straight from the neighbourhood JSON, marking
 * every distance-0 node as a seed. This is the payload's own tree, so a
 * decision made BEFORE the SVG is measured and one made from the drawn SVG
 * agree; no geometry is consulted. Consumers: `PlantUmlGraph.tsx` and the
 * readable-zoom tests.
 */
export function buildSeedHierarchy(graph: ArchitectureRendererGraph): ArchitectureHierarchyIndex {
  return buildHierarchyIndex(
    graph.nodes.map((node) => ({
      id: node.id,
      packageId: directoryPathOf(node.id),
      seed: node.distance === 0,
    })),
  );
}

/**
 * How many non-root packages hold at least one seed DIRECTLY. Ancestor-only
 * packages are not counted twice: the hint says how many distinct packages the
 * reader would have to visit, not how many levels of the tree contain a seed.
 */
export function seedPackageCount(hierarchy: ArchitectureHierarchyIndex): number {
  let count = 0;
  for (const packageNode of hierarchy.packages.values()) {
    if (packageNode.id !== ROOT_PACKAGE_ID && packageNode.directSeedCount > 0) count += 1;
  }
  return count;
}

/**
 * Whether `candidate` should outrank `best`: higher seed density first, then
 * more seeds, then the deeper (more specific) package, then id order so the
 * choice is deterministic across map iteration.
 */
function outranks(candidate: SeedPackageCandidate, candidateDepth: number, best: SeedPackageCandidate, bestDepth: number): boolean {
  if (candidate.density !== best.density) return candidate.density > best.density;
  if (candidate.seedCount !== best.seedCount) return candidate.seedCount > best.seedCount;
  if (candidateDepth !== bestDepth) return candidateDepth > bestDepth;
  return candidate.packageId < best.packageId;
}

/**
 * The package with the densest concentration of seeds (seeds ÷ subtree
 * entities), ignoring the root (it has no frame to centre). `null` when the
 * graph carries no seeded package.
 */
export function densestSeedPackage(hierarchy: ArchitectureHierarchyIndex): SeedPackageCandidate | null {
  let best: SeedPackageCandidate | null = null;
  let bestDepth = 0;
  for (const packageNode of hierarchy.packages.values()) {
    if (packageNode.id === ROOT_PACKAGE_ID) continue;
    if (packageNode.descendantSeedCount === 0 || packageNode.descendantEntityCount === 0) continue;
    const candidate: SeedPackageCandidate = {
      packageId: packageNode.id,
      name: packageNode.name,
      seedCount: packageNode.descendantSeedCount,
      entityCount: packageNode.descendantEntityCount,
      density: packageNode.descendantSeedCount / packageNode.descendantEntityCount,
    };
    const depth = packageNode.ancestors.length + 1;
    if (best === null || outranks(candidate, depth, best, bestDepth)) {
      best = candidate;
      bestDepth = depth;
    }
  }
  return best;
}

/**
 * The package focus mode should centre: the first selected/centre entity's own
 * package, else the densest seeded package. Mirrors the explosion LOD's
 * selection-first rule so the two never disagree about the focus.
 */
export function readableFocusPackage(
  hierarchy: ArchitectureHierarchyIndex,
  selectedEntityIds: readonly (string | null | undefined)[],
): string | null {
  for (const id of selectedEntityIds) {
    if (id === null || id === undefined) continue;
    const packageId = hierarchy.entityPackage.get(id);
    if (packageId !== undefined && packageId !== ROOT_PACKAGE_ID) return packageId;
  }
  return densestSeedPackage(hierarchy)?.packageId ?? null;
}

/**
 * Whether a drawing is a band in this container: its natural aspect ratio is
 * more than `threshold` times the container's. An unmeasured container or a
 * degenerate size is `false` — a missing measurement is not evidence of a band.
 */
export function canvasIsTooWide(
  natural: SvgViewportSize,
  viewport: SvgViewportSize,
  threshold: number = WIDE_CANVAS_ASPECT_RATIO,
): boolean {
  if (!(natural.width > 0) || !(natural.height > 0)) return false;
  if (!(viewport.width > 0) || !(viewport.height > 0)) return false;
  const naturalAspect = natural.width / natural.height;
  const containerAspect = viewport.width / viewport.height;
  return naturalAspect / containerAspect > threshold;
}

/**
 * Decide the default view for one drawing.
 *
 * The default is focus exactly when the geometric fit falls under the readable
 * scale. An explicit `mode` overrides that choice but never changes the scale
 * it maps to: focus always renders at or above the readable floor, overview
 * always shows the whole drawing. The overview hint only exists in overview
 * mode, where the reader is looking at an unreadable whole.
 */
export function decideReadableZoom(input: ReadableZoomInput): ReadableZoomDecision {
  const { fitScale, natural, viewport, hierarchy } = input;
  const measuredFit = Number.isFinite(fitScale) && fitScale > 0 ? Math.min(fitScale, 1) : 1;
  const defaultMode: ReadableZoomMode = measuredFit < READABLE_ZOOM_SCALE ? 'focus' : 'overview';
  const mode = input.mode ?? defaultMode;
  const scale = mode === 'focus' ? Math.max(measuredFit, READABLE_ZOOM_SCALE) : measuredFit;

  const focusPackageId = hierarchy === null
    ? null
    : readableFocusPackage(hierarchy, input.selectedEntityIds ?? []);
  const collapsedForAspect = viewport !== null && canvasIsTooWide(natural, viewport);

  const densest = hierarchy === null ? null : densestSeedPackage(hierarchy);
  const seededPackages = hierarchy === null ? 0 : seedPackageCount(hierarchy);
  const overviewHint = mode === 'overview' && densest !== null && seededPackages > 0
    ? {
        packageId: densest.packageId,
        packageCount: Math.max(0, seededPackages - 1),
        zoomPercent: Math.round(scale * 100),
      }
    : null;

  return {
    mode,
    defaultMode,
    scale,
    focusPackageId,
    collapsedForAspect,
    overviewHint,
  };
}
