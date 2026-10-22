import {
  ARCHITECTURE_DETAIL_TIERS,
  orderArchitectureNodesByImportance,
  rankArchitectureDetail,
  type ArchitectureDetailTier,
} from '@/modules/architecture/detailRanking';
import type {
  ArchitectureRendererEdge,
  ArchitectureRendererGraph,
  ArchitectureRendererNode,
} from '@/modules/architecture/rendererContract';

/**
 * The node budget between the detail knob and the layout engine.
 *
 * ELK runs on the main thread (there is no Worker), and plantuml-js 0.3.0's
 * layout time grows super-linearly with the node count: on the quay client's
 * own entity graphs the measured readings are 500 nodes → 1.3 s, 800 nodes →
 * 6.8 s and 2000 nodes → 282 s. A default Entity graph has reached 1045 nodes,
 * so without a bound a large session freezes the architecture tab for minutes
 * and the freeze cannot be interrupted.
 *
 * `600` is the starting point between the 500-node and 800-node readings, so a
 * large default graph stays in the seconds range rather than the minutes
 * range. A graph that exceeds it is cut here, AFTER the detail ranking and
 * BEFORE the layout, so the detail knob's semantics (and the server's own
 * 2000-node budget) are untouched — this is a layout-surface budget only.
 */
export const LAYOUT_NODE_BUDGET = 600;

/**
 * What the budget fit kept, and the reading the panel reports.
 *
 * `tier` is the detail tier actually applied (a graph over budget falls back to
 * the highest tier that fits, so it can be lower than the requested one);
 * `limited` says the budget changed the drawing at all; `droppedCount` counts
 * the nodes that reached the detail tier but not the layout.
 */
export type ArchitectureLayoutBudgetFit = {
  readonly graph: ArchitectureRendererGraph;
  readonly tier: ArchitectureDetailTier;
  readonly limited: boolean;
  readonly droppedCount: number;
};

/** A node the truncation must never cut while any of its peers survive. */
function isPriorityNode(node: ArchitectureRendererNode, pinnedIds: ReadonlySet<string>): boolean {
  return node.distance === 0 || node.mentionTier === 'direct' || pinnedIds.has(node.id);
}

/**
 * The highest detail tier BELOW `requested` whose graph fits the budget. The
 * requested tier itself is already known not to fit, so the search starts one
 * step lower; `null` means even the lowest tier is over budget.
 */
function fittingTierBelow(
  nodes: readonly ArchitectureRendererNode[],
  edges: readonly ArchitectureRendererEdge[],
  requested: ArchitectureDetailTier,
  limit: number,
): ArchitectureDetailTier | null {
  const requestedIndex = ARCHITECTURE_DETAIL_TIERS.indexOf(requested);
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = ARCHITECTURE_DETAIL_TIERS[index];
    if (rankArchitectureDetail(nodes, edges, candidate).graph.nodes.length <= limit) return candidate;
  }
  return null;
}

/**
 * Fit a graph into the layout budget.
 *
 * 1. The requested detail tier is applied first. When its cut already fits the
 *    budget, that graph is returned unchanged (`limited: false`) — for the
 *    identity tier `all` those are the caller's own arrays, so an untroubled
 *    drawing is byte-for-byte the graph the panel handed over.
 * 2. Over budget at the requested tier: the highest LOWER tier that fits is
 *    applied instead (the reader's `all` becomes `common` or `core` before
 *    anything is truncated).
 * 3. Still over budget at the lowest tier: the important nodes are kept — the
 *    seeds, direct mentions and `pinnedIds` first, then the rest in the
 *    documented importance order (distance, in-degree, id) — up to the budget.
 *
 * Edges are re-filtered to the retained set at every cut, so a dropped node
 * never leaves a dangling edge while an edge between two survivors stays.
 *
 * `pinnedIds` is optional because the wire payload has no pinned field: the
 * panel passes the node it is currently focusing, and a renderer embedded
 * without a panel simply has nothing pinned. A non-finite or negative budget
 * falls back to {@link LAYOUT_NODE_BUDGET} rather than emptying the drawing.
 */
export function fitToLayoutBudget(
  nodes: readonly ArchitectureRendererNode[],
  edges: readonly ArchitectureRendererEdge[],
  tier: ArchitectureDetailTier,
  budget: number = LAYOUT_NODE_BUDGET,
  pinnedIds: Iterable<string> = [],
): ArchitectureLayoutBudgetFit {
  const limit = Number.isFinite(budget) && budget >= 0 ? Math.floor(budget) : LAYOUT_NODE_BUDGET;
  const requested = rankArchitectureDetail(nodes, edges, tier);
  if (requested.graph.nodes.length <= limit) {
    return { graph: requested.graph, tier, limited: false, droppedCount: 0 };
  }

  const fittedTier = fittingTierBelow(nodes, edges, tier, limit);
  if (fittedTier !== null) {
    const ranking = rankArchitectureDetail(nodes, edges, fittedTier);
    return {
      graph: ranking.graph,
      tier: fittedTier,
      limited: true,
      droppedCount: nodes.length - ranking.graph.nodes.length,
    };
  }

  // Even the lowest tier is over budget: cut by importance. Priority nodes are
  // hoisted above the importance order, so a low-importance seed/direct/pinned
  // node is never traded for a near one.
  const pinned = new Set(pinnedIds);
  const ordered = orderArchitectureNodesByImportance(nodes, edges);
  const priority = ordered.filter((node) => isPriorityNode(node, pinned));
  const remainder = ordered.filter((node) => !isPriorityNode(node, pinned));
  const retainedIds = new Set([...priority, ...remainder].slice(0, limit).map((node) => node.id));
  const retainedNodes = nodes.filter((node) => retainedIds.has(node.id));
  const retainedEdges = edges.filter(
    (edge) => retainedIds.has(edge.from) && retainedIds.has(edge.to),
  );

  return {
    graph: { nodes: retainedNodes, edges: retainedEdges },
    tier: ARCHITECTURE_DETAIL_TIERS[0],
    limited: true,
    droppedCount: nodes.length - retainedNodes.length,
  };
}
