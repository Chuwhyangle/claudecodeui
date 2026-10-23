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
 * The engine is pure: geometry in, layout out. `readSemanticDrawingGeometry`
 * is the only function that touches the DOM, and it only READS.
 *
 * Consumers: `PlantUmlGraph.tsx` (captures geometry once per drawing, then
 * rewrites the SVG on each settled zoom) and
 * `tests/semanticZoomLayout.test.ts` (monotonicity, identity at ≥ 90 %, min
 * sizes, compression alpha, the tier budget, determinism and the anchor).
 */

import { tierWithinDeadzone } from '@/modules/architecture/explosionLod';
import {
  followCompactedFrame,
  planCompartmentRules,
  planEdgeOpacity,
  planEntityContent,
  planMemberRows,
  planPackageTab,
  planStickyLabels,
  PACKAGE_TAB_CLEARANCE_PX,
  CLASS_HIDDEN_HEIGHT_PX,
  CLASS_HIDDEN_WIDTH_PX,
  SEMANTIC_MIN_FONT_PX,
  SEMANTIC_STRETCH_LIMIT,
  SEMANTIC_TIER_DEADZONE_RATIO,
  type PlannedEntityContent,
  type PlannedPackageTab,
  type PlanPoint,
  type PlanRect,
  type StickyLabelCandidate,
} from '@/modules/architecture/semanticZoomPlan';

/** The three content tiers, from richest to sparsest. */
export type SemanticTier = 'A' | 'B' | 'C';

/** The tier order the budget walks: names/members → frames → packages. */
export const SEMANTIC_TIERS: readonly SemanticTier[] = ['A', 'B', 'C'];

/** The legacy depth the panel/graph attribute reports for each tier. */
export function lodDepthForTier(tier: SemanticTier): 0 | 1 | 2 {
  return tier === 'A' ? 2 : tier === 'B' ? 1 : 0;
}

/** A rect in drawing user units. */
export type SemanticRect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/** One entity as the renderer drew it. */
export type SemanticNodeGeometry = {
  readonly id: string;
  readonly rect: SemanticRect;
  readonly label: string;
  readonly kind: string;
  /** The `<<kind>>` token the renderer drew (if any), kept for the stereotype line. */
  readonly stereotype: string | null;
  readonly members: readonly string[];
  readonly seed: boolean;
  readonly mentionTier: string | null;
  /** The renderer's title-rule y, used to keep the ≥ 90 % view identical. */
  readonly titleRuleY: number | null;
};

/** One package frame as the renderer drew it. */
export type SemanticPackageGeometry = {
  readonly id: string;
  readonly rect: SemanticRect;
  readonly rawLabel: string;
};

/** One edge as the renderer drew it: its polyline in drawing user units. */
export type SemanticEdgeGeometry = {
  readonly source: string;
  readonly target: string;
  readonly points: readonly PlanPoint[];
};

/** Everything the engine reads from one rendered drawing. */
export type SemanticDrawingGeometry = {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly SemanticNodeGeometry[];
  readonly packages: readonly SemanticPackageGeometry[];
  readonly edges: readonly SemanticEdgeGeometry[];
};

/** A package's place in the containment tree, derived from the rects. */
export type SemanticPackageTree = {
  readonly geometry: SemanticPackageGeometry;
  readonly depth: number;
  readonly parentId: string | null;
  readonly childPackageIds: readonly string[];
  readonly nodeIds: readonly string[];
};

/** The drawing's rectangle in user units. */
function rectOf(element: Element): SemanticRect | null {
  const rect = element.querySelector('rect');
  if (rect === null) return null;
  const number = (name: string): number => {
    const value = Number(rect.getAttribute(name));
    return Number.isFinite(value) ? value : 0;
  };
  return { x: number('x'), y: number('y'), width: number('width'), height: number('height') };
}

/** Direct-child elements of one tag, without descending into nested groups. */
function directChildren(element: Element, tag: string): Element[] {
  return [...element.children].filter((child) => child.tagName.toLowerCase() === tag);
}

/**
 * The entity's drawn label and kind.
 *
 * `plantuml-js` prints the bare name (the stereotype lives in the PlantUML
 * document, not the canvas), and marks interfaces/abstracts with an italic
 * title. The stereotype prefix is still parsed when a future renderer emits
 * `<<kind>>` in the text, so this reading does not depend on one spelling.
 */
function entityLabelOf(group: Element): { label: string; kind: string; stereotype: string | null } {
  const first = directChildren(group, 'text')[0];
  const text = first?.textContent ?? group.getAttribute('data-entity-id') ?? '';
  const match = /^(?:<<\s*([\w]+)\s*>>|«\s*([\w]+)\s*»)\s*/.exec(text);
  const stereotype = match?.[1] ?? match?.[2] ?? null;
  const italic = /italic/.test(first?.getAttribute('font-style') ?? '');
  return {
    kind: stereotype ?? (italic ? 'interface' : 'class'),
    label: text.replace(/^(?:<<\s*[\w]+\s*>>|«\s*[\w]+\s*»)\s*/, ''),
    stereotype,
  };
}

/** Whether a drawn node carries the session-seed marker. */
function nodeIsSeed(group: Element): boolean {
  const marker = group.getAttribute('data-architecture-seed');
  return marker === 'true' || marker === 'light'
    || group.classList.contains('arch-seed')
    || group.classList.contains('arch-seed-light');
}

/** The points of a path's `d` attribute, in order (curves keep their control points). */
export function pathPointsOf(d: string | null): PlanPoint[] {
  if (d === null) return [];
  const numbers = [...d.matchAll(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)].map((match) => Number(match[0]));
  const points: PlanPoint[] = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    points.push({ x: numbers[index], y: numbers[index + 1] });
  }
  return points;
}

/** Read the geometry of one rendered drawing. Read-only; never mutates the SVG. */
export function readSemanticDrawingGeometry(svg: Element): SemanticDrawingGeometry {
  const viewBox = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const width = Number(svg.getAttribute('width'));
  const height = Number(svg.getAttribute('height'));
  const boxWidth = Number.isFinite(viewBox[2]) && viewBox[2] > 0
    ? viewBox[2]
    : Number.isFinite(width) && width > 0 ? width : 0;
  const boxHeight = Number.isFinite(viewBox[3]) && viewBox[3] > 0
    ? viewBox[3]
    : Number.isFinite(height) && height > 0 ? height : 0;

  const packages: SemanticPackageGeometry[] = [];
  for (const group of svg.querySelectorAll('.uml-package[data-package-id]')) {
    const rect = rectOf(group);
    if (rect === null) continue;
    packages.push({
      id: group.getAttribute('data-package-id') ?? '',
      rect,
      rawLabel: directChildren(group, 'text')[0]?.textContent ?? group.getAttribute('data-package-id') ?? '',
    });
  }

  const nodes: SemanticNodeGeometry[] = [];
  for (const group of svg.querySelectorAll('.uml-node[data-entity-id]')) {
    const rect = rectOf(group);
    if (rect === null) continue;
    const texts = directChildren(group, 'text');
    const labelled = entityLabelOf(group);
    const line = directChildren(group, 'line')[0];
    const ruleY = line === undefined ? NaN : Number(line.getAttribute('y1'));
    nodes.push({
      id: group.getAttribute('data-entity-id') ?? '',
      rect,
      label: labelled.label,
      kind: labelled.kind,
      stereotype: labelled.stereotype,
      members: texts.slice(1).map((text) => text.textContent ?? ''),
      seed: nodeIsSeed(group),
      mentionTier: group.getAttribute('data-architecture-pinned') === 'true' ? 'pinned' : null,
      titleRuleY: Number.isFinite(ruleY) ? ruleY : null,
    });
  }

  const edges: SemanticEdgeGeometry[] = [];
  for (const group of svg.querySelectorAll('.uml-edge[data-edge-source][data-edge-target]')) {
    const path = directChildren(group, 'path')[0];
    const points = pathPointsOf(path?.getAttribute('d') ?? null);
    if (points.length < 2) continue;
    edges.push({
      source: group.getAttribute('data-edge-source') ?? '',
      target: group.getAttribute('data-edge-target') ?? '',
      points,
    });
  }

  return { width: boxWidth, height: boxHeight, nodes, packages, edges };
}

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
        members: node.members,
        seed: node.seed,
      },
      fontPx,
    );
    // Members are shown at tier A whenever the frame has room for at least two
    // rows at the floor font; a compacted frame (alpha > 0) drops them.
    const rows = planMemberRows({
      members: node.members,
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
    if (entry.showMembers) {
      return {
        id: entry.geometry.id,
        plan: entry.plan,
        cell,
        drawn: cell,
        drawnTitleHeight: entry.plan.titleHeight,
        showMembers: true,
        showName: true,
        hidden,
      };
    }
    // A text-hidden frame may be drawn shorter than its cell. The cell stays the
    // layout unit (packages contain it, edges leave it), which is what keeps the
    // containment relation intact while the blank space disappears.
    const titleHeight = tier === 'A' ? entry.plan.titleHeight : 7;
    const body = entry.plan.kind === 'interface' && !entry.plan.hasAttributes ? 7 : 13;
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
      plan: entry.plan,
      cell,
      drawn: { ...cell, height },
      drawnTitleHeight: baselineTitle,
      showMembers: false,
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

/**
 * Evaluate every tier (or the forced one) at one scale, in A → B → C order.
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
  const tiers = options.forceTier !== null && options.forceTier !== undefined
    ? [options.forceTier]
    : SEMANTIC_TIERS;
  return tiers.map((tier) => evaluateTier(geometry, tree, scale, alpha, fontPx, tier));
}

/** Solve the whole drawing for one scale. Deterministic: same input → same output. */
export function solveSemanticZoom(
  geometry: SemanticDrawingGeometry,
  options: SemanticZoomOptions,
): SemanticZoomLayout {
  const scale = Number.isFinite(options.scale) && options.scale > 0 ? options.scale : 1;
  const limit = options.limit ?? SEMANTIC_STRETCH_LIMIT;
  const alpha = semanticCompactionAlpha(scale);
  const evaluations = evaluateSemanticTiers(geometry, options);
  const forced = options.forceTier !== null && options.forceTier !== undefined;
  const chosen = forced
    ? evaluations[0]
    : selectSemanticTier(evaluations, {
        limit,
        previousTier: options.previousTier ?? null,
        deadzone: options.deadzone,
      });

  const layoutsById = chosen.layoutsById;
  const edges = chosen.tier === 'C'
    ? []
    : geometry.edges
      .filter((edge) => layoutsById.has(edge.source) && layoutsById.has(edge.target))
      .map((edge) => ({
        source: edge.source,
        target: edge.target,
        points: mapEdge(edge, chosen.x, chosen.y, layoutsById),
        opacity: 0,
      }));
  const opacity = planEdgeOpacity(edges.length);

  // Content bounds: every package frame (the drawing's outermost objects) plus
  // any node the renderer drew outside them.
  const rects = [
    ...chosen.packages.map((entry) => entry.frame),
    ...chosen.nodes.map((entry) => entry.cell),
  ];
  const minX = rects.length === 0 ? 0 : Math.min(...rects.map((rect) => rect.x));
  const minY = rects.length === 0 ? 0 : Math.min(...rects.map((rect) => rect.y));
  const maxX = rects.length === 0 ? 0 : Math.max(...rects.map((rect) => rect.x + rect.width));
  const maxY = rects.length === 0 ? 0 : Math.max(...rects.map((rect) => rect.y + rect.height));

  const centres: PlanPoint[] = (chosen.tier === 'C' ? [] : chosen.nodes.filter((node) => !node.hidden))
    .map((node) => ({ x: node.cell.x - minX + node.cell.width / 2, y: node.cell.y - minY + node.cell.height / 2 }));
  const leafPackages = chosen.packages.filter((entry) => entry.depth >= 0);
  const packageCentres: PlanPoint[] = leafPackages.map((entry) => ({
    x: entry.frame.x - minX + entry.frame.width / 2,
    y: entry.frame.y - minY + entry.frame.height / 2,
  }));
  const anchor = densestWindowAnchor(
    centres.length > 0 ? centres : packageCentres,
    options.viewport ?? null,
    { x: (maxX - minX) / 2, y: (maxY - minY) / 2 },
  );

  const stickies = planStickyLabels(
    chosen.packages.map((entry) => ({
      id: entry.id,
      depth: entry.depth,
      top: entry.frame.y - minY,
      bottom: entry.frame.y - minY + entry.frame.height,
    })),
    // Without a laid-out viewport the sticky rule has no scroll to read; an
    // empty candidate set keeps the caller's draw path simple.
    options.viewport === null || options.viewport === undefined ? Number.NEGATIVE_INFINITY : 0,
  );

  return {
    tier: chosen.tier,
    scale,
    alpha,
    x: chosen.x,
    y: chosen.y,
    ratio: chosen.ratio,
    nodes: chosen.nodes,
    packages: chosen.packages,
    edges: edges.map((edge) => ({ ...edge, opacity })),
    content: {
      x: minX,
      y: minY,
      width: Math.max(0, maxX - minX),
      height: Math.max(0, maxY - minY),
    },
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
  });
}
