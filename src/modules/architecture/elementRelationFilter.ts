import type {
  ArchitectureEntityKind,
  ArchitectureRendererEdge,
  ArchitectureRendererGraph,
  ArchitectureRendererNode,
} from '@/modules/architecture/rendererContract';

/**
 * The architecture tab's element/relation filter: the pure core of the two
 * independent axes the toolbar offers, plus the request vocabulary the panel
 * sends the server.
 *
 * Why both sides filter. A UML class diagram is not a sequence diagram: the
 * functions and the `call` edges between them are the largest noise class in a
 * real ArchGuard neighbourhood (on the 2026-10-22 snapshot, 957 of 1007 typed
 * entities were functions and 2093 of 3186 edges were calls). The SERVER
 * therefore computes the BFS and the node budget on the filtered graph — hiding
 * a held-back kind must free budget, not merely hide the finished drawing — and
 * the CLIENT applies this same function when the reader NARROWS the filter, so
 * a narrower selection costs no round-trip. Widening has to ask the server,
 * because the payload no longer contains what was cut.
 *
 * The three relation presets are nested:
 *   · `structural` — inheritance, implementation, composition, aggregation;
 *   · `dependency` — structural + dependency (the shipped default);
 *   · `call`       — everything, including call and any unknown relation type.
 * An unknown type is treated as `dependency`-tier (the documented rule): a
 * relation this client cannot name is at least as weak as a dependency, so it
 * survives `dependency`/`call` and disappears from `structural`.
 *
 * Only a `direct` mention is exempt from hiding, and only on distance-0 nodes.
 * `distance === 0` is NOT the same fact as "the transcript mentioned it": a
 * common name can resolve to hundreds of entities, so exempting every
 * distance-0 node would let same-name candidates hollow out the default
 * function-hiding. A payload with no `mentionTier` at all is the legacy
 * reading, where distance 0 WAS the seed, and is therefore treated as direct.
 */

/** The element axis' vocabulary, in the order the popover lists it. */
export const ARCHITECTURE_ELEMENT_KINDS: readonly ArchitectureEntityKind[] = [
  'class',
  'interface',
  'enum',
  'abstract',
  'function',
  'other',
];

/** The shipped default: structural UML kinds on, functions/others off. */
export const ARCHITECTURE_DEFAULT_ELEMENT_KINDS: readonly ArchitectureEntityKind[] = [
  'class',
  'interface',
  'enum',
  'abstract',
];

/** The relation axis' three presets, weakest first. */
export const ARCHITECTURE_RELATION_PRESETS = ['structural', 'dependency', 'call'] as const;

export type ArchitectureRelationPreset = (typeof ARCHITECTURE_RELATION_PRESETS)[number];

/** One project's remembered filter selection. */
export type ArchitectureElementRelationFilter = {
  /** The entity kinds to SHOW (the element axis). */
  readonly kinds: readonly ArchitectureEntityKind[];
  /** The relation preset (the relation axis). */
  readonly relations: ArchitectureRelationPreset;
  /** Whether nodes with no incident edge are removed. */
  readonly hideIsolated: boolean;
};

/**
 * The shipped default filter: hide functions/others and `call` edges, and hide
 * nodes the relation cut leaves isolated. Turning the relation preset to
 * `call` is what makes the isolated toggle default OFF again — with every edge
 * shown, an isolated node is a real fact about the analysis, not a side effect
 * of the filter.
 */
export const ARCHITECTURE_DEFAULT_FILTER: ArchitectureElementRelationFilter = {
  kinds: ARCHITECTURE_DEFAULT_ELEMENT_KINDS,
  relations: 'dependency',
  hideIsolated: true,
};

/**
 * The structural relation types, as the CLIENT reads them.
 *
 * `aggregation` is here even though `server/modules/architecture/generator.ts`
 * has no such `RelationType`: ArchGuard's `arch.json` does emit it, and a file
 * graph (or a future server) can carry the string through the renderer
 * contract. The server-side filter list necessarily omits it.
 */
const STRUCTURAL_RELATION_TYPES: readonly string[] = [
  'inheritance',
  'implementation',
  'composition',
  'aggregation',
];

const PRESET_RANK: Readonly<Record<ArchitectureRelationPreset, number>> = {
  structural: 0,
  dependency: 1,
  call: 2,
};

/**
 * The relation types to SEND to the server for a preset.
 *
 * This list must stay inside the server's `RelationType` vocabulary (the route
 * answers 400 for anything else), so `aggregation` is deliberately absent here
 * while {@link isRelationAllowed} still honours it on an arrived payload.
 */
export function relationsForPreset(preset: ArchitectureRelationPreset): readonly string[] {
  switch (preset) {
    case 'structural':
      return ['inheritance', 'implementation', 'composition'];
    case 'dependency':
      return ['inheritance', 'implementation', 'composition', 'dependency'];
    default:
      return ['inheritance', 'implementation', 'composition', 'dependency', 'call'];
  }
}

/**
 * Whether one arrived edge's relation type survives a preset.
 *
 * Known structural types need `structural` or better; `dependency` needs
 * `dependency` or better; `call` needs `call`; anything the vocabulary does not
 * know is treated as the `dependency` tier, per the task's documented rule.
 */
export function isRelationAllowed(preset: ArchitectureRelationPreset, relationType: string): boolean {
  if (STRUCTURAL_RELATION_TYPES.includes(relationType)) return true;
  if (preset === 'structural') return false;
  if (relationType === 'dependency') return true;
  if (relationType === 'call') return preset === 'call';
  // Unknown relation kind: as weak as a dependency.
  return true;
}

/** What a filter removed, reported by axis and by vocabulary value. */
export type ArchitectureFilterHidden = {
  readonly byKind: Partial<Record<ArchitectureEntityKind, number>>;
  readonly byRelation: Record<string, number>;
  readonly isolated: number;
};

/** The pure filter's answer: the surviving subgraph and the removals it made. */
export type ArchitectureFilterResult = {
  readonly nodes: readonly ArchitectureRendererNode[];
  readonly edges: readonly ArchitectureRendererEdge[];
  readonly hidden: ArchitectureFilterHidden;
};

/**
 * Whether a node is a DIRECT seed, the one exemption every axis honours.
 *
 * An explicit `directSeedIds` membership wins; otherwise the payload's own
 * provenance decides. A distance-0 node with NO `mentionTier` is the legacy
 * payload, whose distance 0 was exactly "the transcript named this", so it is
 * direct. A `name`/`file` tier node is an ordinary node — which is the point:
 * distance 0 alone must not exempt it.
 */
function isDirectSeedNode(
  node: ArchitectureRendererNode,
  directSeedIds: ReadonlySet<string>,
): boolean {
  if (directSeedIds.has(node.id)) return true;
  return node.distance === 0 && (node.mentionTier === undefined || node.mentionTier === 'direct');
}

/**
 * Apply the element/relation filter to one arrived subgraph.
 *
 * Order matters and is the task's: element axis → relation axis → isolated
 * toggle. Edges pointing at a removed node are dropped with it (they are a
 * consequence of the element cut, not a relation-hidden edge, so they do not
 * inflate `byRelation`). Nothing here re-sorts: the server's `(distance, id)`
 * order is the contract a caller may prefix, so the surviving nodes keep it.
 *
 * A node with no `kind` is never removed by the element axis: "no detail" is
 * not "other" (the same distinction the server's `kindCounts` documents).
 * File-graph nodes carry no kind at all, which is what makes this function safe
 * for the file view's relation-only filtering.
 *
 * Empty and fully-hidden inputs are ordinary answers, not errors.
 */
export function applyFilter(
  graph: ArchitectureRendererGraph,
  filter: ArchitectureElementRelationFilter,
  directSeedIds: ReadonlySet<string> = new Set<string>(),
): ArchitectureFilterResult {
  const byKind: Partial<Record<ArchitectureEntityKind, number>> = {};
  const keptNodes = graph.nodes.filter((node) => {
    if (isDirectSeedNode(node, directSeedIds)) return true;
    if (node.kind === undefined || filter.kinds.includes(node.kind)) return true;
    byKind[node.kind] = (byKind[node.kind] ?? 0) + 1;
    return false;
  });

  const keptIds = new Set(keptNodes.map((node) => node.id));
  const byRelation: Record<string, number> = {};
  const relKeptEdges = graph.edges.filter((edge) => {
    if (!keptIds.has(edge.from) || !keptIds.has(edge.to)) return false;
    if (isRelationAllowed(filter.relations, edge.relationType)) return true;
    byRelation[edge.relationType] = (byRelation[edge.relationType] ?? 0) + 1;
    return false;
  });

  if (!filter.hideIsolated) {
    return { nodes: keptNodes, edges: relKeptEdges, hidden: { byKind, byRelation, isolated: 0 } };
  }

  const degree = new Map<string, number>();
  for (const edge of relKeptEdges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }

  let isolated = 0;
  const finalNodes = keptNodes.filter((node) => {
    if ((degree.get(node.id) ?? 0) > 0 || isDirectSeedNode(node, directSeedIds)) return true;
    isolated += 1;
    return false;
  });
  const finalIds = new Set(finalNodes.map((node) => node.id));
  const finalEdges = relKeptEdges.filter((edge) => finalIds.has(edge.from) && finalIds.has(edge.to));

  return { nodes: finalNodes, edges: finalEdges, hidden: { byKind, byRelation, isolated } };
}

/**
 * Whether `next` is a NARROWING of `previous`, the condition that lets the
 * panel filter the arrived payload instead of asking the server again.
 *
 * Narrower means every axis keeps a subset: the kind list shrinks (set
 * inclusion, not size), the relation preset moves down or stays, and the
 * isolated toggle is at least as aggressive. Equality counts as narrower (it is
 * the no-op case a caller should skip before rendering work).
 */
export function isFilterNarrower(
  next: ArchitectureElementRelationFilter,
  previous: ArchitectureElementRelationFilter,
): boolean {
  const kindsSubset = next.kinds.every((kind) => previous.kinds.includes(kind));
  const relationsNarrower = PRESET_RANK[next.relations] <= PRESET_RANK[previous.relations];
  const isolatedNarrower = next.hideIsolated || !previous.hideIsolated;
  return kindsSubset && relationsNarrower && isolatedNarrower;
}

/** True when the two selections describe the same shown set. */
export function filtersEqual(
  left: ArchitectureElementRelationFilter,
  right: ArchitectureElementRelationFilter,
): boolean {
  const sameKinds =
    left.kinds.length === right.kinds.length && left.kinds.every((kind) => right.kinds.includes(kind));
  return sameKinds && left.relations === right.relations && left.hideIsolated === right.hideIsolated;
}

/**
 * How many filter decisions are non-default, the number the toolbar badge
 * states. It counts the hidden kinds plus each non-`call` relation preset plus
 * the isolated toggle, so "已启用 N 项" answers "how much is this tab doing to
 * the graph" rather than "how many checkboxes exist".
 */
export function activeFilterCount(filter: ArchitectureElementRelationFilter): number {
  const hiddenKinds = ARCHITECTURE_ELEMENT_KINDS.filter((kind) => !filter.kinds.includes(kind)).length;
  return hiddenKinds + (filter.relations === 'call' ? 0 : 1) + (filter.hideIsolated ? 1 : 0);
}

/**
 * The "show everything" selection behind the readout's one-click reset: every
 * kind, every relation, and no isolated-node removal.
 */
export const ARCHITECTURE_SHOW_ALL_FILTER: ArchitectureElementRelationFilter = {
  kinds: ARCHITECTURE_ELEMENT_KINDS,
  relations: 'call',
  hideIsolated: false,
};

/** The total number of items a `hidden` reading says were removed. */
export function hiddenTotal(hidden: ArchitectureFilterHidden): number {
  const kinds = Object.values(hidden.byKind).reduce((sum, count) => sum + (count ?? 0), 0);
  const relations = Object.values(hidden.byRelation).reduce((sum, count) => sum + count, 0);
  return kinds + relations + hidden.isolated;
}
