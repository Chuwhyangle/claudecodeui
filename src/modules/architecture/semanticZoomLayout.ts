/**
 * The semantic-zoom layout engine for the architecture canvas.
 *
 * The diagram is laid out once by plantuml-js and then never re-laid out by the
 * README's design: zooming instead applies two monotone piecewise-linear maps
 * (one per axis) to the geometry that is already in the SVG, making room at the
 * constraints that would otherwise drop text below its minimum size. Because
 * each axis gets ONE non-decreasing map, left/right and top/bottom order,
 * alignment, containment and the orthogonality of the polyline edges all
 * survive — this is the property the prototype proved and the E2E guard reads.
 *
 * The engine is pure: geometry in, layout out. The DOM read lives in
 * `semanticZoomRead.ts`; this module imports its types only.
 *
 * Consumers: `PlantUmlGraph.tsx` (captures geometry once per drawing, then
 * rewrites the SVG on each settled zoom) and
 * `tests/semanticZoomLayout.test.ts` (monotonicity, identity at ≥ 90 %, min
 * sizes, compression alpha, the tier budget, determinism and the anchor).
 */

import { tierWithinDeadzone } from '@/modules/architecture/explosionLod';
export type {
  SemanticDrawingGeometry,
  SemanticEdgeGeometry,
  SemanticMember,
  SemanticNodeGeometry,
  SemanticPackageGeometry,
  SemanticRect,
} from '@/modules/architecture/semanticZoomRead';
import type {
  SemanticDrawingGeometry,
  SemanticEdgeGeometry,
  SemanticNodeGeometry,
  SemanticPackageGeometry,
  SemanticRect,
} from '@/modules/architecture/semanticZoomRead';
import {
  followCompactedFrame,
  planCompartmentRules,
  planEdgeOpacity,
  planEntityContent,
  planEntityNameForWidth,
  planMemberRows,
  planPackageTab,
  planStickyLabels,
  PACKAGE_TAB_CLEARANCE_PX,
  PACKAGE_TAB_INSET_PX,
  CLASS_HIDDEN_HEIGHT_PX,
  CLASS_HIDDEN_WIDTH_PX,
  SEMANTIC_MIN_FONT_PX,
  SEMANTIC_STRETCH_LIMIT,
  SEMANTIC_TIER_DEADZONE_RATIO,
  type PlannedEntityContent,
  type PlannedMemberRows,
  type PlannedPackageTab,
  type PlanPoint,
  type PlanRect,
  type StickyLabelCandidate,
} from '@/modules/architecture/semanticZoomPlan';

/** The four content tiers, from richest to sparsest. */
export type SemanticTier = 'A' | 'B' | 'C' | 'D';

/**
 * The fixed outer margin the semantic canvas reserves around its content.
 *
 * The content boundary includes the package and class frames, every edge
 * polyline point and the arrowhead polygons; this margin then covers the line
 * stroke width and any marker geometry the reading does not enumerate. Without
 * it the SVG's `overflow: hidden` clips relations that ELK routes along the
 * outside of the outermost frames — the renderer's own viewBox keeps a margin
 * there, and the semantic canvas must not be tighter than the drawing it
 * replaces.
 */
export const SEMANTIC_CONTENT_MARGIN_PX = 12;

/**
 * The tier order the budget walks: names/members → frames → packages.
 *
 * Tier `D` (folded packages) is deliberately NOT in this list: it is not a step
 * of the stretch budget but the answer to a different question — "the
 * package-only drawing still does not fit the canvas" — so `solveSemanticZoom`
 * reaches it only after `C` was chosen and measured (see
 * {@link chooseFoldedPlan}).
 */
export const SEMANTIC_TIERS: readonly SemanticTier[] = ['A', 'B', 'C'];

/** The legacy depth the panel/graph attribute reports for each tier. */
export function lodDepthForTier(tier: SemanticTier): 0 | 1 | 2 {
  return tier === 'A' ? 2 : tier === 'B' ? 1 : 0;
}

/**
 * How far past the canvas the package-only tier (`C`) may reach before the
 * folded tier (`D`) takes over. "Still does not fit" is stated as a multiple of
 * the canvas rather than as a single pixel over it, because a C view that is
 * 1.05 canvases wide is a fit the reader can still read at the floor scale;
 * 2× is a drawing they would have to scroll through four screens of.
 */
export const SEMANTIC_FOLD_TRIGGER_RATIO = 2;

/**
 * The size ceiling a folded drawing must stay inside, as a multiple of the
 * canvas — the rule that decides how many levels `D` keeps. A drawing at 1.0×
 * to 1.2× costs at most a fifth of a screen of scroll (and usually none, since
 * the packer below is asked for the canvas' own width).
 */
export const SEMANTIC_FOLD_FIT_LIMIT = 1.2;

/** The gap between two packed package boxes in the folded tier. */
export const SEMANTIC_FOLD_GAP_PX = 8;

/** The body a folded package frame keeps below its tab (it contains nothing else). */
export const SEMANTIC_FOLD_FRAME_BODY_PX = 6;

/** A package's place in the containment tree, derived from the rects. */
export type SemanticPackageTree = {
  readonly geometry: SemanticPackageGeometry;
  readonly depth: number;
  readonly parentId: string | null;
  readonly childPackageIds: readonly string[];
  readonly nodeIds: readonly string[];
};

/** Whether `outer` (strictly) contains `inner`. */
function containsRect(outer: SemanticRect, inner: SemanticRect): boolean {
  const eps = 0.5;
  if (inner.width * inner.height >= outer.width * outer.height) return false;
  return outer.x <= inner.x + eps
    && outer.y <= inner.y + eps
    && outer.x + outer.width >= inner.x + inner.width - eps
    && outer.y + outer.height >= inner.y + inner.height - eps;
}

/** Build the package containment tree (parent = innermost containing frame). */
export function buildSemanticPackageTree(
  geometry: SemanticDrawingGeometry,
): readonly SemanticPackageTree[] {
  const packages = geometry.packages;
  const depthOf = new Map<string, number>();
  for (const pkg of packages) {
    depthOf.set(pkg.id, packages.filter((other) => other !== pkg && containsRect(other.rect, pkg.rect)).length);
  }
  const parentOf = (rect: SemanticRect, selfId: string | null): string | null => {
    let best: SemanticPackageGeometry | null = null;
    for (const pkg of packages) {
      if (pkg.id === selfId || !containsRect(pkg.rect, rect)) continue;
      if (best === null || (depthOf.get(pkg.id) ?? 0) > (depthOf.get(best.id) ?? 0)) best = pkg;
    }
    return best?.id ?? null;
  };
  return packages.map((pkg) => ({
    geometry: pkg,
    depth: depthOf.get(pkg.id) ?? 0,
    parentId: parentOf(pkg.rect, pkg.id),
    childPackageIds: packages
      .filter((other) => other.id !== pkg.id && containsRect(pkg.rect, other.rect))
      .filter((other) => parentOf(other.rect, other.id) === pkg.id)
      .map((other) => other.id),
    nodeIds: geometry.nodes
      .filter((node) => containsRect(pkg.rect, node.rect))
      .filter((node) => parentOf(node.rect, null) === pkg.id)
      .map((node) => node.id),
  }));
}

/** One axis's solved map: breakpoints, mapped positions, and the ratio it cost. */
export type SemanticAxisSolution = {
  readonly axis: 'x' | 'y';
  readonly breakpoints: readonly number[];
  readonly mapped: readonly number[];
  /** Which breakpoint gaps were widened by a constraint (rather than by `scale`). */
  readonly constrained: readonly boolean[];
  /** Which breakpoint gaps were compressed by the text-hidden rule. */
  readonly compressed: readonly boolean[];
  readonly map: (value: number) => number;
  /** The solved extent of the source range, in layout units. */
  readonly size: number;
  /** Solved extent ÷ (scale × source extent); 1 when nothing had to stretch. */
  readonly ratio: number;
};

/** One class box's layout. */
export type SemanticNodeLayout = {
  readonly id: string;
  readonly plan: PlannedEntityContent;
  /** The layout cell (the mapped original rect); the solver makes it big enough. */
  readonly cell: SemanticRect;
  /** The drawn frame: the cell, or a compact frame anchored at its top-left. */
  readonly drawn: SemanticRect;
  /** The height of the title compartment in the DRAWN frame (rules are placed from it). */
  readonly drawnTitleHeight: number;
  /** Member text is visible (tier A and the cell has room). */
  readonly showMembers: boolean;
  /**
   * The member rows actually drawn, grouped attrs → ops. `null` when the
   * member text is hidden (the compact frame keeps the proportional rule).
   */
  readonly memberRows: PlannedMemberRows | null;
  /** The name is visible (tier A). */
  readonly showName: boolean;
  /** The frame is too small to draw at all (rule 1). */
  readonly hidden: boolean;
};

/** One package frame's layout, with its tab plan. */
export type SemanticPackageLayout = {
  readonly id: string;
  readonly depth: number;
  readonly frame: SemanticRect;
  readonly tab: PlannedPackageTab;
  /** The tab's rectangle, or null when the frame is too small to carry it. */
  readonly tabRect: PlanRect | null;
  readonly mentionedCount: number;
};

/** One edge's layout: its mapped points (then endpoint-adjusted) and opacity. */
export type SemanticEdgeLayout = {
  readonly source: string;
  readonly target: string;
  readonly points: readonly PlanPoint[];
  readonly opacity: number;
};

/** The whole drawing's layout for one scale. */
export type SemanticZoomLayout = {
  readonly tier: SemanticTier;
  readonly scale: number;
  readonly alpha: number;
  readonly x: SemanticAxisSolution;
  readonly y: SemanticAxisSolution;
  readonly ratio: number;
  readonly nodes: readonly SemanticNodeLayout[];
  readonly packages: readonly SemanticPackageLayout[];
  readonly edges: readonly SemanticEdgeLayout[];
  /** The mapped content rectangle, in layout units, before translation to origin. */
  readonly content: SemanticRect;
  /**
   * How many package levels the folded tier (`'D'`) kept, or `null` for every
   * other tier. At `1` only the outermost packages are drawn and everything
   * inside them is summed into their tabs; the value is what the canvas states
   * as "Collapsed to N levels".
   */
  readonly foldDepth: number | null;
  /** The content-sized drawing's origin offset (layout units already start at 0). */
  readonly anchor: PlanPoint;
  /** How many edges are visible (drives the opacity band). */
  readonly visibleEdges: number;
  /** Package names that must stick to the viewport's top (at most two). */
  readonly stickies: readonly StickyLabelCandidate[];
};

/** Options for one solve. */
export type SemanticZoomOptions = {
  readonly scale: number;
  readonly minFontPx?: number;
  readonly viewport?: { readonly width: number; readonly height: number } | null;
  readonly limit?: number;
  /** The tier already on screen; it is kept inside the dead band. */
  readonly previousTier?: SemanticTier | null;
  /** A forced tier (control arms / tests). */
  readonly forceTier?: SemanticTier | null;
  readonly deadzone?: number;
};

/** The fraction of the compaction the current scale earns (0 at ≥ 90 %, 1 at ≤ 50 %). */
export function semanticCompactionAlpha(scale: number): number {
  if (!Number.isFinite(scale)) return 0;
  return Math.min(1, Math.max(0, (0.9 - scale) / 0.4));
}

/** A breakpoint key that survives float noise (thousandths of a user unit). */
function breakpointKey(value: number): number {
  return Math.round(value * 1000);
}

/** One element's contribution to an axis solve. */
type AxisElement = {
  readonly start: number;
  readonly length: number;
  readonly minLength: number;
  /** This element's own cell is compacted, so gaps it covers may compress. */
  readonly compact: boolean;
};

/** One "at least m between these two breakpoints" constraint. */
type AxisConstraint = { readonly from: number; readonly min: number };

/** Solve one axis: forward sweep with constraints, as the prototype proved. */
function solveAxis(
  elements: readonly AxisElement[],
  scale: number,
  alpha: number,
  axis: 'x' | 'y',
  protectedBands: readonly { readonly start: number; readonly end: number }[] = [],
): SemanticAxisSolution {
  const points = new Set<number>();
  for (const element of elements) {
    points.add(breakpointKey(element.start));
    points.add(breakpointKey(element.start + element.length));
  }
  const breakpoints = [...points].sort((a, b) => a - b).map((key) => key / 1000);
  const indexOf = new Map(breakpoints.map((value, index) => [breakpointKey(value), index]));
  const constraints: AxisConstraint[][] = breakpoints.map(() => []);

  for (const element of elements) {
    const to = indexOf.get(breakpointKey(element.start + element.length));
    const from = indexOf.get(breakpointKey(element.start));
    if (from === undefined || to === undefined || from >= to) continue;
    constraints[to].push({ from, min: element.minLength });
  }

  const mapped: number[] = [0];
  const constrained: boolean[] = [false];
  const compressed: boolean[] = [false];
  // At 90 % and above the design's baseline wins: the map IS the original
  // layout times the scale, with no constraint stretch. The renderer's own
  // fonts are 12 px, so at 0.9 they still clear the 10 px floor; this is what
  // makes "≥ 90 % fully restored" an exact statement rather than an
  // approximation that the package-tab padding could spoil.
  const identity = scale >= 0.9;
  for (let index = 1; index < breakpoints.length; index += 1) {
    let compressible = false;
    if (!identity && axis === 'y' && alpha > 0) {
      const low = breakpoints[index - 1];
      const high = breakpoints[index];
      const covering = elements.filter(
        (element) => element.start <= low + 1e-6 && element.start + element.length >= high - 1e-6,
      );
      // A package tab band is RESERVED space: it may never be compressed away,
      // or the tab would paint over the first class box the frame contains.
      const reserved = protectedBands.some(
        (band) => low < band.end - 1e-6 && high > band.start + 1e-6,
      );
      compressible = !reserved && covering.length > 0 && covering.every((element) => element.compact);
    }
    compressed[index] = compressible;
    mapped[index] = mapped[index - 1]
      + scale * (breakpoints[index] - breakpoints[index - 1]) * (compressible ? 1 - alpha : 1);
    constrained[index] = false;
    if (identity) continue;
    for (const constraint of constraints[index]) {
      const required = mapped[constraint.from] + constraint.min;
      if (required > mapped[index] + 1e-9) {
        mapped[index] = required;
        constrained[index] = true;
      }
    }
  }

  const map = (value: number): number => {
    if (breakpoints.length === 0) return value * scale;
    if (value <= breakpoints[0]) return mapped[0] + (value - breakpoints[0]) * scale;
    const last = breakpoints.length - 1;
    if (value >= breakpoints[last]) return mapped[last] + (value - breakpoints[last]) * scale;
    let low = 0;
    let high = last;
    while (high - low > 1) {
      const mid = (low + high) >> 1;
      if (breakpoints[mid] <= value) low = mid;
      else high = mid;
    }
    const span = breakpoints[high] - breakpoints[low];
    const t = span === 0 ? 0 : (value - breakpoints[low]) / span;
    return mapped[low] + t * (mapped[high] - mapped[low]);
  };

  const span = breakpoints.length > 1 ? breakpoints[breakpoints.length - 1] - breakpoints[0] : 0;
  const size = breakpoints.length > 0 ? mapped[mapped.length - 1] : 0;
  return {
    axis,
    breakpoints,
    mapped,
    constrained,
    compressed,
    map,
    size,
    ratio: span > 0 ? size / (scale * span) : 1,
  };
}

/** Everything one tier evaluation produces before the winner is chosen. */
export type TierEvaluation = {
  readonly tier: SemanticTier;
  readonly x: SemanticAxisSolution;
  readonly y: SemanticAxisSolution;
  readonly ratio: number;
  readonly nodes: readonly SemanticNodeLayout[];
  readonly packages: readonly SemanticPackageLayout[];
  readonly layoutsById: ReadonlyMap<string, SemanticNodeLayout>;
};

/** Internal per-node state while a tier is evaluated. */
type WorkingNode = {
  readonly geometry: SemanticNodeGeometry;
  readonly plan: PlannedEntityContent;
  readonly showMembers: boolean;
};

/** Evaluate one tier at one scale. */
function evaluateTier(
  geometry: SemanticDrawingGeometry,
  tree: readonly SemanticPackageTree[],
  scale: number,
  alpha: number,
  fontPx: number,
  tier: SemanticTier,
): TierEvaluation {
  const visibleNodes = tier === 'C' ? [] : geometry.nodes;
  const working: WorkingNode[] = visibleNodes.map((node) => {
    const plan = planEntityContent(
      {
        label: node.label,
        kind: node.kind,
        stereotype: node.stereotype,
        hasAttributes: node.members.some((member) => member.compartment === 'attr'),
        hasOperations: node.members.some((member) => member.compartment === 'op'),
        seed: node.seed,
      },
      fontPx,
    );
    // Members are shown at tier A whenever the frame has room for at least two
    // rows at the floor font; a compacted frame (alpha > 0) drops them.
    const rows = planMemberRows({
      members: node.members.map((member) => member.text),
      compartments: node.members.map((member) => member.compartment),
      totalMembers: node.memberTotal,
      height: node.rect.height * scale,
      titleHeight: plan.titleHeight,
      fontPx,
      maxWidth: Math.max(0, node.rect.width * scale - 10),
      moreLine: null,
    });
    const showMembers = tier === 'A' && rows.rows.length >= 2;
    return { geometry: node, plan, showMembers };
  });
  const workingById = new Map(working.map((entry) => [entry.geometry.id, entry]));

  const packagesById = new Map(tree.map((entry) => [entry.geometry.id, entry]));
  const tabOf = (packageId: string, entityCount: number, mentionedCount: number): PlannedPackageTab => {
    const entry = packagesById.get(packageId);
    return planPackageTab({
      raw: entry?.geometry.rawLabel ?? packageId,
      entityCount,
      mentionedCount,
      tier,
      fontPx,
    });
  };
  const mentionedIn = (childNodeIds: readonly string[]): number =>
    childNodeIds.filter((id) => geometry.nodes.find((node) => node.id === id)?.seed === true).length;

  // ---- x axis
  const xElements: AxisElement[] = [];
  for (const entry of tree) {
    const tab = tabOf(entry.geometry.id, entry.nodeIds.length, mentionedIn(entry.nodeIds));
    const visibleKids = [
      ...entry.childPackageIds.filter((id) => tree.some((child) => child.geometry.id === id)),
      ...entry.nodeIds.filter((id) => workingById.has(id)),
    ];
    const childRects = visibleKids
      .map((id) => tree.find((child) => child.geometry.id === id)?.geometry.rect
        ?? geometry.nodes.find((node) => node.id === id)?.rect)
      .filter((rect): rect is SemanticRect => rect !== undefined);
    if (childRects.length === 0) {
      xElements.push({
        start: entry.geometry.rect.x,
        length: entry.geometry.rect.width,
        minLength: tab.width + PACKAGE_TAB_CLEARANCE_PX + 1,
        compact: false,
      });
    } else {
      const left = Math.min(...childRects.map((rect) => rect.x));
      const right = Math.max(...childRects.map((rect) => rect.x + rect.width));
      xElements.push({
        start: entry.geometry.rect.x,
        length: left - entry.geometry.rect.x,
        minLength: 3,
        compact: false,
      });
      xElements.push({
        start: right,
        length: entry.geometry.rect.x + entry.geometry.rect.width - right,
        minLength: 3,
        compact: false,
      });
      xElements.push({
        start: entry.geometry.rect.x,
        length: entry.geometry.rect.width,
        minLength: tab.width + PACKAGE_TAB_CLEARANCE_PX,
        compact: false,
      });
    }
  }
  for (const entry of working) {
    xElements.push({
      start: entry.geometry.rect.x,
      length: entry.geometry.rect.width,
      minLength: entry.showMembers ? 0 : tier === 'B' ? 24 : entry.plan.minWidth,
      compact: !entry.showMembers,
    });
  }
  const x = solveAxis(xElements, scale, alpha, 'x');

  // ---- y axis
  const yElements: AxisElement[] = [];
  for (const entry of tree) {
    const tab = tabOf(entry.geometry.id, entry.nodeIds.length, mentionedIn(entry.nodeIds));
    const visibleKids = [
      ...entry.childPackageIds.filter((id) => tree.some((child) => child.geometry.id === id)),
      ...entry.nodeIds.filter((id) => workingById.has(id)),
    ];
    const childRects = visibleKids
      .map((id) => tree.find((child) => child.geometry.id === id)?.geometry.rect
        ?? geometry.nodes.find((node) => node.id === id)?.rect)
      .filter((rect): rect is SemanticRect => rect !== undefined);
    if (childRects.length === 0) {
      yElements.push({
        start: entry.geometry.rect.y,
        length: entry.geometry.rect.height,
        minLength: tab.height + 5,
        compact: false,
      });
    } else {
      const top = Math.min(...childRects.map((rect) => rect.y));
      const bottom = Math.max(...childRects.map((rect) => rect.y + rect.height));
      yElements.push({
        start: entry.geometry.rect.y,
        length: top - entry.geometry.rect.y,
        // One extra px of slack: a tab's painted box and a class frame that
        // sits exactly on the reserved edge can round toward each other by a
        // fraction of a pixel, which a reader sees as a touch. The design's
        // band is the font plus 6px; the slack is not part of the band.
        minLength: tab.height + 1,
        compact: false,
      });
      yElements.push({
        start: bottom,
        length: entry.geometry.rect.y + entry.geometry.rect.height - bottom,
        minLength: 3,
        compact: false,
      });
    }
  }
  for (const entry of working) {
    yElements.push({
      start: entry.geometry.rect.y,
      length: entry.geometry.rect.height,
      minLength: entry.showMembers ? 0 : tier === 'B' ? 16 : entry.plan.minHeight,
      compact: !entry.showMembers,
    });
  }
  // Package tab bands (raw geometry, the same band the y constraints reserve)
  // are protected from the text-hidden compression.
  const protectedBands = tree.map((entry) => {
    const tab = tabOf(entry.geometry.id, entry.nodeIds.length, mentionedIn(entry.nodeIds));
    return { start: entry.geometry.rect.y, end: entry.geometry.rect.y + tab.height };
  });
  const y = solveAxis(yElements, scale, alpha, 'y', protectedBands);

  // ---- materialise the node layouts
  const nodes: SemanticNodeLayout[] = working.map((entry) => {
    const rect = entry.geometry.rect;
    const cell: SemanticRect = {
      x: x.map(rect.x),
      y: y.map(rect.y),
      width: x.map(rect.x + rect.width) - x.map(rect.x),
      height: y.map(rect.y + rect.height) - y.map(rect.y),
    };
    const hidden = cell.width < CLASS_HIDDEN_WIDTH_PX || cell.height < CLASS_HIDDEN_HEIGHT_PX;
    // The planning pass had to pick a name fallback before the solver knew the
    // mapped box. Now it does: re-plan for the REAL width so a wide box draws
    // the name on one line (and its title band grows/shrinks to that choice).
    const name = tier === 'A' && !hidden
      ? planEntityNameForWidth(entry.plan.name.label, cell.width, fontPx, entry.geometry.seed)
      : entry.plan.name;
    const plan: PlannedEntityContent = name === entry.plan.name
      ? entry.plan
      : {
          ...entry.plan,
          name,
          titleHeight: name.titleHeight + (entry.plan.stereotype === null ? 0 : fontPx * 1.25),
        };
    if (entry.showMembers) {
      const memberRows = planMemberRows({
        members: entry.geometry.members.map((member) => member.text),
        compartments: entry.geometry.members.map((member) => member.compartment),
        totalMembers: entry.geometry.memberTotal,
        height: cell.height,
        titleHeight: plan.titleHeight,
        fontPx,
        maxWidth: Math.max(0, cell.width - 10),
        moreLine: null,
      });
      // The tier-A threshold is re-checked against the FINAL cell: the title may
      // have grown by the width-based re-plan, and a frame that no longer has
      // room for two rows must compact instead of drawing one lonely row.
      if (memberRows.rows.length >= 2) {
        return {
          id: entry.geometry.id,
          plan,
          cell,
          drawn: cell,
          drawnTitleHeight: plan.titleHeight,
          showMembers: true,
          memberRows,
          showName: true,
          hidden,
        };
      }
    }
    // A text-hidden frame may be drawn shorter than its cell. The cell stays the
    // layout unit (packages contain it, edges leave it), which is what keeps the
    // containment relation intact while the blank space disappears.
    const titleHeight = tier === 'A' ? plan.titleHeight : 7;
    const body = plan.kind === 'interface' && !plan.hasAttributes ? 7 : 13;
    const originalRuleOffset = entry.geometry.titleRuleY === null
      ? null
      : y.map(entry.geometry.titleRuleY) - cell.y;
    const baselineTitle = originalRuleOffset === null || alpha > 0
      ? titleHeight
      : Math.max(titleHeight, originalRuleOffset);
    const compactHeight = baselineTitle + body;
    const height = cell.height > compactHeight + 2
      ? cell.height - alpha * (cell.height - compactHeight)
      : cell.height;
    return {
      id: entry.geometry.id,
      plan,
      cell,
      drawn: { ...cell, height },
      drawnTitleHeight: baselineTitle,
      showMembers: false,
      memberRows: null,
      showName: tier === 'A',
      hidden,
    };
  });

  // ---- packages
  const packages: SemanticPackageLayout[] = tree.map((entry) => {
    const mentionedCount = mentionedIn(entry.nodeIds);
    const tab = tabOf(entry.geometry.id, entry.nodeIds.length, mentionedCount);
    const rect = entry.geometry.rect;
    const frame: SemanticRect = {
      x: x.map(rect.x),
      y: y.map(rect.y),
      width: x.map(rect.x + rect.width) - x.map(rect.x),
      height: y.map(rect.y + rect.height) - y.map(rect.y),
    };
    const fits = frame.width >= tab.width + 4 && frame.height >= tab.height + 4;
    return {
      id: entry.geometry.id,
      depth: entry.depth,
      frame,
      tab,
      tabRect: fits ? { x: frame.x + 5, y: frame.y, w: tab.width, h: tab.height } : null,
      mentionedCount,
    };
  });

  return {
    tier,
    x,
    y,
    ratio: Math.max(x.ratio, y.ratio),
    nodes,
    packages,
    layoutsById: new Map(nodes.map((node) => [node.id, node])),
  };
}

//-------------------------------- the folded tier (D) ----------------------------------------

/** What one fold depth's packed drawing is: its boxes, its size, and the level it kept. */
type FoldedPlan = {
  /** How many package levels the drawing keeps, counting the outermost as 1. */
  readonly depth: number;
  readonly packages: readonly SemanticPackageLayout[];
  /** The packed extent, margin included — what the canvas draws at 1:1. */
  readonly content: SemanticRect;
};

/**
 * Pack the kept package frames into a canvas-wide grid, deterministically.
 *
 * The folded tier is a NEW drawing, not a mapping of the old one: the original
 * positions of a package span everything below it, so mapping them leaves the
 * drawing exactly as wide as before (that is why `C` could not shrink past
 * 4415 px on the reported project). Each kept package therefore becomes its own
 * tab-sized box — the tab that names it, its `(N)` count and its `★N` badge —
 * and the boxes flow left to right into rows at most one canvas wide. Order is
 * the packages' own ids, so the same geometry always packs the same way.
 *
 * The `(N)` and `★N` of a kept frame sum its WHOLE subtree, not only its own
 * entities: the frames below it are gone from the drawing, and information the
 * fold removes must be summed upward, never dropped. See
 * {@link SemanticPackageTree} for the containment the sum walks.
 */
function packFoldedPackages(
  geometry: SemanticDrawingGeometry,
  tree: readonly SemanticPackageTree[],
  depth: number,
  fontPx: number,
  viewport: { readonly width: number; readonly height: number },
): FoldedPlan | null {
  const seedIds = new Set(geometry.nodes.filter((node) => node.seed).map((node) => node.id));
  const byId = new Map(tree.map((entry) => [entry.geometry.id, entry]));
  const entityTotalOf = (id: string, seen: Set<string> = new Set()): number => {
    const entry = byId.get(id);
    if (entry === undefined || seen.has(id)) return 0;
    seen.add(id);
    return entry.nodeIds.length + entry.childPackageIds
      .reduce((sum, childId) => sum + entityTotalOf(childId, seen), 0);
  };
  const mentionedTotalOf = (id: string, seen: Set<string> = new Set()): number => {
    const entry = byId.get(id);
    if (entry === undefined || seen.has(id)) return 0;
    seen.add(id);
    const own = entry.nodeIds.filter((nodeId) => seedIds.has(nodeId)).length;
    return own + entry.childPackageIds
      .reduce((sum, childId) => sum + mentionedTotalOf(childId, seen), 0);
  };
  const boxes = [...tree]
    .filter((entry) => entry.depth < depth)
    .sort((left, right) => left.geometry.id.localeCompare(right.geometry.id))
    .map((entry) => {
      const id = entry.geometry.id;
      const tab = planPackageTab({
        raw: entry.geometry.rawLabel,
        entityCount: entityTotalOf(id),
        mentionedCount: mentionedTotalOf(id),
        tier: 'D',
        fontPx,
      });
      return {
        entry,
        tab,
        width: tab.width + 2 * PACKAGE_TAB_INSET_PX,
        height: tab.height + SEMANTIC_FOLD_FRAME_BODY_PX,
      };
    });
  if (boxes.length === 0) return null;

  const maxWidth = Math.max(1, viewport.width);
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  const placed = boxes.map((box) => {
    if (cursorX > 0 && cursorX + box.width > maxWidth) {
      cursorX = 0;
      cursorY += rowHeight + SEMANTIC_FOLD_GAP_PX;
      rowHeight = 0;
    }
    const position = { x: cursorX, y: cursorY };
    cursorX += box.width + SEMANTIC_FOLD_GAP_PX;
    rowHeight = Math.max(rowHeight, box.height);
    return { ...box, ...position };
  });

  const packages: SemanticPackageLayout[] = placed.map((box) => ({
    id: box.entry.geometry.id,
    depth: box.entry.depth,
    frame: { x: box.x, y: box.y, width: box.width, height: box.height },
    tab: box.tab,
    tabRect: {
      x: box.x + PACKAGE_TAB_INSET_PX - 1,
      y: box.y,
      w: box.tab.width,
      h: box.tab.height,
    },
    mentionedCount: mentionedTotalOf(box.entry.geometry.id),
  }));
  return {
    depth,
    packages,
    content: packageTierContent(packages),
  };
}

/**
 * The folded plan to draw: the LARGEST level count whose packed drawing stays
 * inside {@link SEMANTIC_FOLD_FIT_LIMIT} canvases, and at least level 1.
 *
 * Deeper levels only add frames, so the packed size grows with the level and
 * the first level that misses the ceiling closes the search. When even level 1
 * misses it (a project with dozens of enormous top-level package names), level
 * 1 is still the answer: the folded drawing is the smallest one this engine can
 * make, and the canvas then shows it at the fit factor `PlantUmlGraph` derives
 * from the REAL drawing size instead of a made-up scale.
 */
function chooseFoldedPlan(
  geometry: SemanticDrawingGeometry,
  tree: readonly SemanticPackageTree[],
  fontPx: number,
  viewport: { readonly width: number; readonly height: number },
): FoldedPlan | null {
  const maxDepth = tree.reduce((deepest, entry) => Math.max(deepest, entry.depth), 0) + 1;
  let best: FoldedPlan | null = null;
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const plan = packFoldedPackages(geometry, tree, depth, fontPx, viewport);
    if (plan === null) break;
    const fits = plan.content.width <= viewport.width * SEMANTIC_FOLD_FIT_LIMIT + 0.5
      && plan.content.height <= viewport.height * SEMANTIC_FOLD_FIT_LIMIT + 0.5;
    if (!fits) break;
    best = plan;
  }
  return best ?? packFoldedPackages(geometry, tree, 1, fontPx, viewport);
}

/** The content rectangle a package-only tier occupies (it draws no edges or boxes). */
function packageTierContent(packages: readonly SemanticPackageLayout[]): SemanticRect {
  return contentBoundaryOf(packages.map((entry) => entry.frame), []);
}

/** An axis solution that maps nothing: the folded tier's frames are already final units. */
function identityAxis(axis: 'x' | 'y'): SemanticAxisSolution {
  return {
    axis,
    breakpoints: [],
    mapped: [],
    constrained: [],
    compressed: [],
    map: (value: number) => value,
    size: 0,
    ratio: 1,
  };
}

/** Choose the tier: first within the budget, with the previous tier kept in a dead band. */
export function selectSemanticTier(
  evaluations: readonly TierEvaluation[],
  options: { readonly limit: number; readonly previousTier?: SemanticTier | null; readonly deadzone?: number },
): TierEvaluation {
  if (options.previousTier != null) {
    const previous = evaluations.find((entry) => entry.tier === options.previousTier);
    const deadzone = options.deadzone ?? SEMANTIC_TIER_DEADZONE_RATIO;
    // The dead band only KEEPS a tier that is a hair OVER the budget. A tier
    // that fits is not sticky: the rule is "the first tier inside the budget",
    // so zooming back in restores the richer tier instead of staying where the
    // last zoom-out left it.
    if (
      previous !== undefined
      && previous.ratio > options.limit
      && tierWithinDeadzone(previous.ratio, options.limit, deadzone)
    ) {
      return previous;
    }
  }
  return evaluations.find((entry) => entry.ratio <= options.limit)
    ?? evaluations[evaluations.length - 1];
}

/** Clamp `value` to [low, high]. */
function clampBetween(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Move an endpoint that is just outside a drawn frame onto the frame's
 * boundary. The renderer routes an edge to a point a marker-size away from the
 * box; the design's reading is that the drawn end sits ON the frame, so the
 * semantic pass puts it there (the arrow follows in the renderer).
 */
function snapEndpointToFrame(point: PlanPoint, rect: PlanRect, tolerance = 24): PlanPoint {
  const withinX = point.x >= rect.x - tolerance && point.x <= rect.x + rect.w + tolerance;
  const withinY = point.y >= rect.y - tolerance && point.y <= rect.y + rect.h + tolerance;
  if (!withinX || !withinY) return point;
  const dx = Math.min(Math.abs(point.x - rect.x), Math.abs(point.x - (rect.x + rect.w)));
  const dy = Math.min(Math.abs(point.y - rect.y), Math.abs(point.y - (rect.y + rect.h)));
  if (Math.min(dx, dy) > tolerance) return point;
  if (dx <= dy) {
    return {
      x: point.x < rect.x + rect.w / 2 ? rect.x : rect.x + rect.w,
      y: clampBetween(point.y, rect.y, rect.y + rect.h),
    };
  }
  return {
    x: clampBetween(point.x, rect.x, rect.x + rect.w),
    y: point.y < rect.y + rect.h / 2 ? rect.y : rect.y + rect.h,
  };
}

/** Map one edge's points and follow any compacted class frame it attaches to. */
function mapEdge(
  geometry: SemanticEdgeGeometry,
  x: SemanticAxisSolution,
  y: SemanticAxisSolution,
  layouts: ReadonlyMap<string, SemanticNodeLayout>,
): PlanPoint[] {
  const mapped = geometry.points.map((point) => ({ x: x.map(point.x), y: y.map(point.y) }));
  if (mapped.length < 2) return mapped;
  const attach = (nodeId: string, endpoint: PlanPoint, neighbour: { x: number; y: number }): PlanPoint => {
    const layout = layouts.get(nodeId);
    if (layout === undefined) return endpoint;
    const cell: PlanRect = { x: layout.cell.x, y: layout.cell.y, w: layout.cell.width, h: layout.cell.height };
    const drawn: PlanRect = { x: layout.drawn.x, y: layout.drawn.y, w: layout.drawn.width, h: layout.drawn.height };
    const followed = followCompactedFrame({ point: endpoint, cell, drawn });
    if (followed.y !== endpoint.y) neighbour.y += followed.y - endpoint.y;
    return snapEndpointToFrame(followed, drawn);
  };
  mapped[mapped.length - 1] = attach(geometry.target, mapped[mapped.length - 1], mapped[mapped.length - 2]);
  mapped[0] = attach(geometry.source, mapped[0], mapped[1]);
  return mapped;
}

/** The medoid of the densest window of element centres (never blank space). */
export function densestWindowAnchor(
  centres: readonly PlanPoint[],
  viewport: { readonly width: number; readonly height: number } | null,
  fallback: PlanPoint,
): PlanPoint {
  if (centres.length === 0 || viewport === null || viewport.width <= 0 || viewport.height <= 0) return fallback;
  const windowX = viewport.width / 2;
  const windowY = viewport.height / 2;
  let best: { members: readonly PlanPoint[]; anchor: PlanPoint; score: number } | null = null;
  for (const centre of centres) {
    const members = centres.filter(
      (other) => Math.abs(other.x - centre.x) <= windowX && Math.abs(other.y - centre.y) <= windowY,
    );
    // The medoid — a REAL element's centre — is the anchor, so a sparse graph
    // never centres on the gap between two distant clusters.
    const medoid = members.reduce((closest, candidate) => {
      const distance = Math.hypot(candidate.x - centre.x, candidate.y - centre.y);
      const bestDistance = Math.hypot(closest.x - centre.x, closest.y - centre.y);
      return distance < bestDistance ? candidate : closest;
    }, centre);
    const score = members.length;
    if (best === null || score > best.score) best = { members, anchor: medoid, score };
  }
  return best?.anchor ?? fallback;
}

/** The union of every drawn extent, before the outer margin is applied. */
type ContentExtent = {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
};

/** Grow an extent by one point. */
function extendExtent(extent: ContentExtent | null, x: number, y: number): ContentExtent {
  return extent === null
    ? { minX: x, minY: y, maxX: x, maxY: y }
    : {
        minX: Math.min(extent.minX, x),
        minY: Math.min(extent.minY, y),
        maxX: Math.max(extent.maxX, x),
        maxY: Math.max(extent.maxY, y),
      };
}

/**
 * The drawing's content boundary: frames, node cells, edge polyline points and
 * arrowhead polygons, expanded by {@link SEMANTIC_CONTENT_MARGIN_PX}.
 *
 * ONE function decides the boundary so the canvas fill, the SVG `viewBox`, the
 * minimap's drawing box and the fit reading cannot each derive their own. An
 * empty drawing answers a zero rect (no phantom margin to scroll through).
 */
function contentBoundaryOf(
  rects: Iterable<SemanticRect>,
  edgePoints: Iterable<PlanPoint>,
): SemanticRect {
  let extent: ContentExtent | null = null;
  for (const rect of rects) {
    extent = extendExtent(extent, rect.x, rect.y);
    extent = extendExtent(extent, rect.x + rect.width, rect.y + rect.height);
  }
  for (const point of edgePoints) extent = extendExtent(extent, point.x, point.y);
  if (extent === null) return { x: 0, y: 0, width: 0, height: 0 };
  return {
    x: extent.minX - SEMANTIC_CONTENT_MARGIN_PX,
    y: extent.minY - SEMANTIC_CONTENT_MARGIN_PX,
    width: extent.maxX - extent.minX + 2 * SEMANTIC_CONTENT_MARGIN_PX,
    height: extent.maxY - extent.minY + 2 * SEMANTIC_CONTENT_MARGIN_PX,
  };
}

/**
 * The drawing's content boundary at identity (scale 1), in the renderer's own
 * user units.
 *
 * Consumers: `PlantUmlGraph.tsx` hands this to the viewport controller as the
 * semantic base size, so a fit/minimap reading measures the SAME boundary the
 * canvas draws — not the renderer's pre-semantic viewBox, which is a different
 * rectangle.
 */
export function semanticContentBounds(geometry: SemanticDrawingGeometry): SemanticRect {
  const rects = [
    ...geometry.packages.map((pkg) => pkg.rect),
    ...geometry.nodes.map((node) => node.rect),
  ];
  const edgePoints = [
    ...geometry.edges.flatMap((edge) => edge.points),
    ...geometry.edges.flatMap((edge) => edge.arrowPoints ?? []),
  ];
  return contentBoundaryOf(rects, edgePoints);
}

/** Evaluate every tier (or the forced one) at one scale, in A → B → C order.
 * Exported so the tier-budget criterion can read the ratios the engine actually
 * used instead of re-deriving them, and so the caller can keep the previous
 * tier inside the dead band.
 */
export function evaluateSemanticTiers(
  geometry: SemanticDrawingGeometry,
  options: SemanticZoomOptions,
): readonly TierEvaluation[] {
  const scale = Number.isFinite(options.scale) && options.scale > 0 ? options.scale : 1;
  const fontPx = options.minFontPx ?? SEMANTIC_MIN_FONT_PX;
  const alpha = semanticCompactionAlpha(scale);
  const tree = buildSemanticPackageTree(geometry);
  // `D` is not a stretch-budget step: it needs a fold depth, which only
  // `solveSemanticZoom` can choose. A caller that asks for it here gets the
  // package-only evaluation the fold would have started from.
  const tiers = options.forceTier === 'D'
    ? (['C'] as const)
    : options.forceTier !== null && options.forceTier !== undefined
      ? [options.forceTier]
      : SEMANTIC_TIERS;
  return tiers.map((tier) => evaluateTier(geometry, tree, scale, alpha, fontPx, tier));
}

/**
 * The folded plan for a package-only drawing that still does not fit, or
 * `null` when the sparse tier fits (or there is nothing to measure against).
 *
 * The trigger is measured on the tier that was actually CHOSEN: a drawing the
 * budget already kept inside 1.8× its scale needs no fold, however wide it is.
 */
function foldForSparseTier(
  geometry: SemanticDrawingGeometry,
  tree: readonly SemanticPackageTree[],
  chosen: TierEvaluation,
  fontPx: number,
  viewport: { readonly width: number; readonly height: number } | null | undefined,
): FoldedPlan | null {
  if (chosen.tier !== 'C' || viewport === null || viewport === undefined) return null;
  const sparse = packageTierContent(chosen.packages);
  const tooWide = sparse.width > viewport.width * SEMANTIC_FOLD_TRIGGER_RATIO;
  const tooTall = sparse.height > viewport.height * SEMANTIC_FOLD_TRIGGER_RATIO;
  return tooWide || tooTall ? chooseFoldedPlan(geometry, tree, fontPx, viewport) : null;
}

/** Solve the whole drawing for one scale. Deterministic: same input → same output. */
export function solveSemanticZoom(
  geometry: SemanticDrawingGeometry,
  options: SemanticZoomOptions,
): SemanticZoomLayout {
  const scale = Number.isFinite(options.scale) && options.scale > 0 ? options.scale : 1;
  const limit = options.limit ?? SEMANTIC_STRETCH_LIMIT;
  const alpha = semanticCompactionAlpha(scale);
  const fontPx = options.minFontPx ?? SEMANTIC_MIN_FONT_PX;
  const tree = buildSemanticPackageTree(geometry);
  const evaluations = evaluateSemanticTiers(geometry, options);
  const forced = options.forceTier !== null && options.forceTier !== undefined;
  const chosen = forced
    ? evaluations[0]
    : selectSemanticTier(evaluations, {
        limit,
        previousTier: options.previousTier ?? null,
        deadzone: options.deadzone,
      });

  // ---- the folded tier: chosen only when the package-only drawing still
  // cannot fit the canvas. `C` is a MAPPED drawing, so its width is the
  // original one times the scale plus the tab minimums; once that is more than
  // twice the canvas the reader would be scrolling through several screens with
  // "whole graph" on the canvas. `D` re-packs the kept packages instead, which
  // is the only way to leave the original extent behind.
  const folded = forced ? null : foldForSparseTier(geometry, tree, chosen, fontPx, options.viewport);

  const layoutsById = folded === null ? chosen.layoutsById : new Map<string, SemanticNodeLayout>();
  const drawnEdges = folded !== null || chosen.tier === 'C'
    ? []
    : geometry.edges.filter((edge) => layoutsById.has(edge.source) && layoutsById.has(edge.target));
  const edges = drawnEdges.map((edge) => ({
    source: edge.source,
    target: edge.target,
    points: mapEdge(edge, chosen.x, chosen.y, layoutsById),
    opacity: 0,
  }));
  const opacity = planEdgeOpacity(edges.length);

  // Content bounds: the class boxes, every package frame, ALL edge polyline
  // points and the arrowhead polygons — the drawing's whole painted extent. A
  // relation ELK routes along the outside of the outermost frame is part of the
  // drawing; leaving it out makes the clipped viewBox cut it in half.
  const mappedArrowPoints = drawnEdges.flatMap((edge) => (edge.arrowPoints ?? [])
    .map((point) => ({ x: chosen.x.map(point.x), y: chosen.y.map(point.y) })));
  const content = folded !== null
    ? folded.content
    : contentBoundaryOf(
        [
          ...chosen.packages.map((entry) => entry.frame),
          ...chosen.nodes.map((entry) => entry.cell),
        ],
        [...edges.flatMap((edge) => edge.points), ...mappedArrowPoints],
      );
  const drawnPackages = folded === null ? chosen.packages : folded.packages;
  const drawnNodes = folded === null ? chosen.nodes : [];
  const x = folded === null ? chosen.x : identityAxis('x');
  const y = folded === null ? chosen.y : identityAxis('y');
  // The translation puts the content boundary's own origin at 0, margin included.
  const minX = content.x;
  const minY = content.y;

  const centres: PlanPoint[] = (folded === null && chosen.tier !== 'C' ? chosen.nodes.filter((node) => !node.hidden) : [])
    .map((node) => ({ x: node.cell.x - minX + node.cell.width / 2, y: node.cell.y - minY + node.cell.height / 2 }));
  const leafPackages = drawnPackages.filter((entry) => entry.depth >= 0);
  const packageCentres: PlanPoint[] = leafPackages.map((entry) => ({
    x: entry.frame.x - minX + entry.frame.width / 2,
    y: entry.frame.y - minY + entry.frame.height / 2,
  }));
  const anchor = densestWindowAnchor(
    centres.length > 0 ? centres : packageCentres,
    options.viewport ?? null,
    { x: content.width / 2, y: content.height / 2 },
  );

  // The folded drawing is a static map of tabs: it never scrolls its package
  // names to the viewport's top, so it has no sticky candidates at all.
  const stickies = folded !== null ? [] : planStickyLabels(
    chosen.packages.map((entry) => ({
      id: entry.id,
      depth: entry.depth,
      top: entry.frame.y - minY,
      bottom: entry.frame.y - minY + entry.frame.height,
      // The tab plan is in the same content space the viewport starts at (0,0);
      // a package whose tab is still in view is not a sticky candidate.
      tab: entry.tabRect === null
        ? null
        : {
            x: entry.tabRect.x - minX,
            y: entry.tabRect.y - minY,
            w: entry.tabRect.w,
            h: entry.tabRect.h,
          },
    })),
    // Without a laid-out viewport the sticky rule has no scroll to read; an
    // empty candidate set keeps the caller's draw path simple.
    options.viewport === null || options.viewport === undefined ? Number.NEGATIVE_INFINITY : 0,
    options.viewport === null || options.viewport === undefined
      ? null
      : { x: 0, y: 0, w: options.viewport.width, h: options.viewport.height },
  );

  return {
    tier: folded === null ? chosen.tier : 'D',
    foldDepth: folded === null ? null : folded.depth,
    scale,
    alpha,
    x,
    y,
    ratio: folded === null ? chosen.ratio : 1,
    nodes: drawnNodes,
    packages: drawnPackages,
    edges: edges.map((edge) => ({ ...edge, opacity })),
    content,
    anchor,
    visibleEdges: edges.length,
    stickies,
  };
}

/** The compartments (and their rule offsets) a drawn frame carries. */
export function semanticCompartmentRules(layout: SemanticNodeLayout): readonly number[] {
  return planCompartmentRules({
    height: layout.drawn.height,
    titleHeight: layout.drawnTitleHeight,
    hasAttributes: layout.plan.hasAttributes,
    hasOperations: layout.plan.hasOperations,
    kind: layout.plan.kind,
    // Visibly drawn member rows position the rule themselves. `showMembers`
    // nodes carry the grouped plan; a null plan means the compact proportional
    // rule (the pre-existing behaviour) applies.
    memberLines: layout.showMembers && layout.memberRows !== null
      ? {
          linesBeforeRule: layout.memberRows.linesBeforeRule,
          lineHeight: layout.memberRows.lineHeight,
        }
      : null,
  });
}
