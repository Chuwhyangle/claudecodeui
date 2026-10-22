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
 * A `direct` mention is NOT exempt from the element axis any more. The shipped
 * rule (2026-10-23) is opt-in PER KIND: a kind listed in
 * {@link ArchitectureElementRelationFilter.keepMentionedKinds} keeps the
 * entities the session mentioned, every other kind hides them like any other
 * node. `distance === 0` is NOT the same fact as "the transcript mentioned it":
 * a common name can resolve to hundreds of entities, so the mention check reads
 * the payload's `mentionTier`, and a payload with no `mentionTier` at all is the
 * legacy reading where distance 0 WAS the seed. A `pinned` entity stays exempt
 * from every axis, whatever the switches say.
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
  /**
   * The kinds whose session-mentioned entities stay visible even when the kind
   * itself is hidden (the filter popover's per-kind "keep mentioned" switches).
   * Empty by default: a mentioned entity of a hidden kind is hidden like any
   * other, and no kind is exempt from the isolated-node cut just for having been
   * mentioned. A `pinned` entity is exempt regardless of this list.
   */
  readonly keepMentionedKinds: readonly ArchitectureEntityKind[];
};

/**
 * The shipped default filter: hide functions/others and `call` edges, and hide
 * nodes the relation cut leaves isolated. Turning the relation preset to
 * `call` is what makes the isolated toggle default OFF again — with every edge
 * shown, an isolated node is a real fact about the analysis, not a side effect
 * of the filter. No kind keeps its mentioned entities by default.
 */
export const ARCHITECTURE_DEFAULT_FILTER: ArchitectureElementRelationFilter = {
  kinds: ARCHITECTURE_DEFAULT_ELEMENT_KINDS,
  relations: 'dependency',
  hideIsolated: true,
  keepMentionedKinds: [],
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
  /**
   * Of the nodes the element axis removed, how many were DIRECTLY mentioned by
   * the session, per kind. It is a SUBSET of `byKind`, not an addition to it:
   * it answers "how many of the hidden functions did this session name".
   * Absent when no mentioned entity was hidden, so a pre-switch payload keeps
   * its exact old shape.
   */
  readonly mentionedByKind?: Partial<Record<ArchitectureEntityKind, number>>;
  /**
   * Per emitted node, the relations of its own the relation axis hid, by type.
   * The client-side filter also fills this when it drops an edge, so a locally
   * narrowed reading explains the same zero an unfiltered server payload does.
   * Absent when nothing was hidden on this axis.
   */
  readonly byNodeRelations?: Readonly<Record<string, Readonly<Record<string, number>>>>;
};

/** The pure filter's answer: the surviving subgraph and the removals it made. */
export type ArchitectureFilterResult = {
  readonly nodes: readonly ArchitectureRendererNode[];
  readonly edges: readonly ArchitectureRendererEdge[];
  readonly hidden: ArchitectureFilterHidden;
};

/**
 * Whether a node was DIRECTLY mentioned by the session.
 *
 * An explicit `directSeedIds` membership wins; otherwise the payload's own
 * provenance decides. A distance-0 node with NO `mentionTier` is the legacy
 * payload, whose distance 0 was exactly "the transcript named this", so it is
 * direct. A `name`/`file` tier node is an ordinary node — which is the point:
 * distance 0 alone must not exempt it. A `pinned` node is not a session
 * mention; it has its own exemption (see {@link isPinnedNode}).
 */
function isDirectSeedNode(
  node: ArchitectureRendererNode,
  directSeedIds: ReadonlySet<string>,
): boolean {
  if (node.mentionTier === 'pinned') return false;
  if (directSeedIds.has(node.id)) return true;
  return node.distance === 0 && (node.mentionTier === undefined || node.mentionTier === 'direct');
}

/** Whether the reader pinned this node by hand: exempt from every axis, always. */
function isPinnedNode(node: ArchitectureRendererNode): boolean {
  return node.mentionTier === 'pinned';
}

/**
 * Whether a mentioned entity of a HIDDEN kind survives because its kind's
 * "keep mentioned" switch is on.
 *
 * A node with no known kind has no switch to open, and the element axis never
 * removes it anyway (see {@link applyFilter}), so it is not this exemption's
 * business.
 */
function keepsMentionedKind(
  node: ArchitectureRendererNode,
  filter: ArchitectureElementRelationFilter,
  directSeedIds: ReadonlySet<string>,
): boolean {
  if (node.kind === undefined) return false;
  if (!filter.keepMentionedKinds.includes(node.kind)) return false;
  return isDirectSeedNode(node, directSeedIds);
}

/**
 * Whether a node survives the element axis.
 *
 * A pin always does. A node whose kind is shown does. A node with no known kind
 * does ("no detail" is not `other`). Otherwise only a directly-mentioned entity
 * of a kind whose switch is on survives; every other node of a hidden kind is
 * removed, mentioned or not.
 */
function passesElementAxis(
  node: ArchitectureRendererNode,
  filter: ArchitectureElementRelationFilter,
  directSeedIds: ReadonlySet<string>,
): boolean {
  if (isPinnedNode(node)) return true;
  if (node.kind === undefined || filter.kinds.includes(node.kind)) return true;
  return keepsMentionedKind(node, filter, directSeedIds);
}

/**
 * Whether a node is exempt from the isolated-node cut.
 *
 * A pin always is. A directly-mentioned entity is exempt only for a kind whose
 * switch is on — with the switch off it is an ordinary node and the removal
 * applies to it like to any other. A node with no known kind has no switch, so
 * it keeps the legacy "the seed is never an isolated casualty" reading.
 */
function exemptFromIsolation(
  node: ArchitectureRendererNode,
  filter: ArchitectureElementRelationFilter,
  directSeedIds: ReadonlySet<string>,
): boolean {
  if (isPinnedNode(node)) return true;
  if (!isDirectSeedNode(node, directSeedIds)) return false;
  return node.kind === undefined || filter.keepMentionedKinds.includes(node.kind);
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
 * The removals are counted twice: `byKind` is every node the element axis took,
 * and `mentionedByKind` is the subset of those the session mentioned directly.
 * The second reading is what lets the readout say "451 functions hidden (35 of
 * them mentioned in this session)" without a second pass.
 *
 * Empty and fully-hidden inputs are ordinary answers, not errors.
 */
export function applyFilter(
  graph: ArchitectureRendererGraph,
  filter: ArchitectureElementRelationFilter,
  directSeedIds: ReadonlySet<string> = new Set<string>(),
): ArchitectureFilterResult {
  const byKind: Partial<Record<ArchitectureEntityKind, number>> = {};
  const mentionedByKind: Partial<Record<ArchitectureEntityKind, number>> = {};
  const keptNodes = graph.nodes.filter((node) => {
    if (passesElementAxis(node, filter, directSeedIds)) return true;
    const kind = node.kind as ArchitectureEntityKind;
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    if (isDirectSeedNode(node, directSeedIds)) {
      mentionedByKind[kind] = (mentionedByKind[kind] ?? 0) + 1;
    }
    return false;
  });
  const hasMentionedHidden = Object.keys(mentionedByKind).length > 0;

  const keptIds = new Set(keptNodes.map((node) => node.id));
  const byRelation: Record<string, number> = {};
  // The same removals, attributed to the boxes that stay: the inspector can
  // then say a function's "0 in · 0 out" is the relation axis, not a fact.
  const byNodeRelations: Record<string, Record<string, number>> = {};
  const relKeptEdges = graph.edges.filter((edge) => {
    if (!keptIds.has(edge.from) || !keptIds.has(edge.to)) return false;
    if (isRelationAllowed(filter.relations, edge.relationType)) return true;
    byRelation[edge.relationType] = (byRelation[edge.relationType] ?? 0) + 1;
    for (const id of [edge.from, edge.to]) {
      const counts = byNodeRelations[id] ?? {};
      counts[edge.relationType] = (counts[edge.relationType] ?? 0) + 1;
      byNodeRelations[id] = counts;
    }
    return false;
  });

  const hiddenOf = (isolated: number): ArchitectureFilterHidden => ({
    byKind,
    byRelation,
    isolated,
    ...(hasMentionedHidden ? { mentionedByKind } : {}),
    ...(Object.keys(byNodeRelations).length === 0 ? {} : { byNodeRelations }),
  });

  if (!filter.hideIsolated) {
    return { nodes: keptNodes, edges: relKeptEdges, hidden: hiddenOf(0) };
  }

  const degree = new Map<string, number>();
  for (const edge of relKeptEdges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }

  let isolated = 0;
  const finalNodes = keptNodes.filter((node) => {
    if ((degree.get(node.id) ?? 0) > 0 || exemptFromIsolation(node, filter, directSeedIds)) return true;
    isolated += 1;
    return false;
  });
  const finalIds = new Set(finalNodes.map((node) => node.id));
  const finalEdges = relKeptEdges.filter((edge) => finalIds.has(edge.from) && finalIds.has(edge.to));

  return { nodes: finalNodes, edges: finalEdges, hidden: hiddenOf(isolated) };
}

/**
 * Whether `next` is a NARROWING of `previous`, the condition that lets the
 * panel filter the arrived payload instead of asking the server again.
 *
 * Narrower means every axis keeps a subset: the kind list shrinks (set
 * inclusion, not size), the relation preset moves down or stays, the isolated
 * toggle is at least as aggressive, and the "keep mentioned" list shrinks — a
 * kind whose switch is turned OFF hides more than before, while turning one ON
 * can only bring back entities an arrived payload may no longer carry.
 * Equality counts as narrower (it is the no-op case a caller should skip before
 * rendering work).
 */
export function isFilterNarrower(
  next: ArchitectureElementRelationFilter,
  previous: ArchitectureElementRelationFilter,
): boolean {
  const kindsSubset = next.kinds.every((kind) => previous.kinds.includes(kind));
  const relationsNarrower = PRESET_RANK[next.relations] <= PRESET_RANK[previous.relations];
  const isolatedNarrower = next.hideIsolated || !previous.hideIsolated;
  const mentionedSubset = next.keepMentionedKinds.every((kind) => previous.keepMentionedKinds.includes(kind));
  return kindsSubset && relationsNarrower && isolatedNarrower && mentionedSubset;
}

/** True when the two selections describe the same shown set. */
export function filtersEqual(
  left: ArchitectureElementRelationFilter,
  right: ArchitectureElementRelationFilter,
): boolean {
  const sameKinds =
    left.kinds.length === right.kinds.length && left.kinds.every((kind) => right.kinds.includes(kind));
  const sameMentioned =
    left.keepMentionedKinds.length === right.keepMentionedKinds.length
    && left.keepMentionedKinds.every((kind) => right.keepMentionedKinds.includes(kind));
  return sameKinds && left.relations === right.relations && left.hideIsolated === right.hideIsolated
    && sameMentioned;
}

/**
 * How many filter decisions are HIDING something, the number the toolbar badge
 * states. It counts the hidden kinds, each non-`call` relation preset, and the
 * isolated toggle — every option whose effect is to take content away.
 *
 * The per-kind "keep mentioned" switches are deliberately NOT counted: opening
 * one shows MORE (a mentioned entity of a hidden kind comes back), so adding it
 * here made the "Hiding N" badge go UP while the graph showed more. The kept
 * count is its own reading ({@link keptMentionedCount}) and the badge states it
 * separately.
 */
export function activeFilterCount(filter: ArchitectureElementRelationFilter): number {
  const hiddenKinds = ARCHITECTURE_ELEMENT_KINDS.filter((kind) => !filter.kinds.includes(kind)).length;
  return hiddenKinds
    + (filter.relations === 'call' ? 0 : 1)
    + (filter.hideIsolated ? 1 : 0);
}

/**
 * How many kinds the reader is keeping visible through their "keep mentioned"
 * switches. This is the opposite direction from {@link activeFilterCount} — the
 * badge states it as "keeping N", never as part of the hidden count.
 */
export function keptMentionedCount(filter: ArchitectureElementRelationFilter): number {
  return filter.keepMentionedKinds.length;
}

/**
 * The "show everything" selection behind the readout's one-click reset: every
 * kind, every relation, and no isolated-node removal. The "keep mentioned"
 * switches are irrelevant here (nothing is hidden), so they reset to empty.
 */
export const ARCHITECTURE_SHOW_ALL_FILTER: ArchitectureElementRelationFilter = {
  kinds: ARCHITECTURE_ELEMENT_KINDS,
  relations: 'call',
  hideIsolated: false,
  keepMentionedKinds: [],
};

/** The total number of items a `hidden` reading says were removed. */
export function hiddenTotal(hidden: ArchitectureFilterHidden): number {
  const kinds = Object.values(hidden.byKind).reduce((sum, count) => sum + (count ?? 0), 0);
  const relations = Object.values(hidden.byRelation).reduce((sum, count) => sum + count, 0);
  return kinds + relations + hidden.isolated;
}
