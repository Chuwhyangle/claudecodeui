import type {
  ArchitectureRendererEdge,
  ArchitectureRendererGraph,
  ArchitectureRendererNode,
} from '@/modules/architecture/rendererContract';

/**
 * The architecture tab's detail knob: how much of the current scope to keep.
 *
 * `core` and `common` take an importance-ordered PREFIX of the non-seed nodes
 * (the transcript's seeds are always kept); `all` keeps everything, which makes
 * it the identity tier every earlier reading falls back to.
 */
export type ArchitectureDetailTier = 'core' | 'common' | 'all';

/** The detail tiers in the order the radiogroup offers them. */
export const ARCHITECTURE_DETAIL_TIERS: readonly ArchitectureDetailTier[] = ['core', 'common', 'all'];

/**
 * The share of NON-SEED nodes the bounded tiers keep after importance order.
 *
 * These are the starting ratios named by the task (about 15% and 50%). They are
 * a deliberate knob, not a claim about any one graph: the ordering — hop
 * distance first, then in-degree — is what makes a small prefix the useful part,
 * and the ratio only decides where the cut lands. `all` has no ratio because it
 * never cuts.
 */
const DETAIL_TIER_KEEP_RATIO: Readonly<Record<Exclude<ArchitectureDetailTier, 'all'>, number>> = {
  core: 0.15,
  common: 0.5,
};

/** The scope stepper's inclusive bounds: how many association hops to expand. */
export const ARCHITECTURE_SCOPE_MIN = 0;
export const ARCHITECTURE_SCOPE_MAX = 3;

/** The scope a project starts at when it has no remembered choice. */
export const DEFAULT_ARCHITECTURE_SCOPE = 2;

/**
 * What one detail tier keeps: the retained node ids, how many nodes it folded
 * away, and the graph those two facts describe (retained nodes plus only the
 * edges whose BOTH endpoints survived).
 */
export type ArchitectureDetailRanking = {
  readonly retainedNodeIds: ReadonlySet<string>;
  readonly foldedCount: number;
  readonly graph: ArchitectureRendererGraph;
};

/**
 * Clamp a requested scope into the stepper's range.
 *
 * The stepper's own buttons never leave 0..3, but a remembered value can be
 * stale (an older build, a hand-edited localStorage entry), so every read of
 * one passes through here. `NaN` falls back to the minimum; infinities clamp to
 * the matching end instead of leaking into the request body.
 */
export function clampArchitectureScope(value: number): number {
  if (Number.isNaN(value)) return ARCHITECTURE_SCOPE_MIN;
  return Math.min(ARCHITECTURE_SCOPE_MAX, Math.max(ARCHITECTURE_SCOPE_MIN, Math.trunc(value)));
}

/**
 * In-degree over the supplied edges: how many relations point at each node.
 *
 * Computed over the graph the caller handed over, so the count is the one a
 * reader would compute from what is on screen — not a global analysis reading.
 */
function inDegreeOf(edges: readonly ArchitectureRendererEdge[]): Map<string, number> {
  const inDegree = new Map<string, number>();
  for (const edge of edges) {
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }
  return inDegree;
}

/**
 * The documented importance order, exposed so the layout budget's truncation
 * cuts in exactly the same order the detail tiers do.
 *
 * Ordering: hop distance from the seeds ascending (nearer is more important),
 * then in-degree descending (a class more of the graph depends on is more
 * important than one nothing points at), then id ascending only as a
 * deterministic tie-break, so the same payload always yields the same order.
 */
export function orderArchitectureNodesByImportance(
  nodes: readonly ArchitectureRendererNode[],
  edges: readonly ArchitectureRendererEdge[],
): ArchitectureRendererNode[] {
  const inDegree = inDegreeOf(edges);
  return [...nodes].sort((left, right) => {
    if (left.distance !== right.distance) return left.distance - right.distance;
    const degreeDelta = (inDegree.get(right.id) ?? 0) - (inDegree.get(left.id) ?? 0);
    if (degreeDelta !== 0) return degreeDelta;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

/**
 * Order the non-seed nodes by importance and keep the tier's prefix.
 *
 * Seeds (`distance === 0`, the entities the transcript mentioned) are NEVER
 * folded, even when their distance would otherwise make them compete for the
 * prefix. The remaining nodes follow {@link orderArchitectureNodesByImportance}.
 * Edges are kept only when both endpoints are retained: an edge that lost one
 * end has nothing to connect and would otherwise draw a dangling line.
 *
 * `all` is the identity: the input arrays are returned as-is, so a reading
 * taken in that tier is exactly the pre-existing graph.
 */
export function rankArchitectureDetail(
  nodes: readonly ArchitectureRendererNode[],
  edges: readonly ArchitectureRendererEdge[],
  tier: ArchitectureDetailTier,
): ArchitectureDetailRanking {
  if (tier === 'all') {
    const retainedNodeIds = new Set(nodes.map((node) => node.id));
    return {
      retainedNodeIds,
      foldedCount: 0,
      graph: { nodes, edges },
    };
  }

  const retainedNodeIds = new Set<string>();
  const candidates: ArchitectureRendererNode[] = [];
  for (const node of nodes) {
    if (node.distance === 0) {
      retainedNodeIds.add(node.id);
    } else {
      candidates.push(node);
    }
  }

  const keepCount = Math.ceil(candidates.length * DETAIL_TIER_KEEP_RATIO[tier]);
  for (const node of orderArchitectureNodesByImportance(candidates, edges).slice(0, keepCount)) {
    retainedNodeIds.add(node.id);
  }

  const retainedNodes = nodes.filter((node) => retainedNodeIds.has(node.id));
  const retainedEdges = edges.filter(
    (edge) => retainedNodeIds.has(edge.from) && retainedNodeIds.has(edge.to),
  );

  return {
    retainedNodeIds,
    foldedCount: nodes.length - retainedNodes.length,
    graph: { nodes: retainedNodes, edges: retainedEdges },
  };
}
