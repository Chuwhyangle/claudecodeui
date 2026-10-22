/**
 * Architecture graph generator — the pure "index + seeds → two subgraphs" step of
 * ADR-005 decisions 4 and 5 (AC-415).
 *
 * Input is ONE `.archguard/query/<scope>/arch-index.json` shape (`fileToIds`,
 * `nameToIds`, `dependencies`, `dependents`, `idToFile`, `idToName`) plus the
 * caller's seed lists. The caller (AC-418) owns scope-prefix splitting, the merge
 * of several scopes' indexes, the cache (AC-417) and the route: this module reads
 * no filesystem, holds no state, and never touches `.archguard/`. Its only job is
 * the deterministic transform
 *
 *   seeds → resolve → `hops`-deep bidirectional expansion → node budget →
 *   entity/file aggregation → two Mermaid flowcharts (the export path) and the
 *   same two subgraphs as render-ready JSON with hop distances and typed edges.
 *
 * The two budgets are INDEPENDENT. The entity graph is the budgeted prefix of
 * the reachable entity set; the file graph is projected from the FULL reachable
 * set and then bounded by its own `maxFiles`, so cutting entities can never
 * shorten the file view (a file graph is roughly a tenth the size of its entity
 * graph, so the same loose bound leaves it whole). Each granularity reports its
 * own truncation flag alongside the retained and pre-budget totals.
 *
 * Keeping it pure is what makes the output reproducible for a fixed
 * (index, seeds, params) triple, which is the property the content-addressed
 * cache keys on.
 *
 * Consumers: `server/modules/architecture/index.ts` (this module's barrel) →
 * the AC-418 route wiring; `server/modules/architecture/tests/generator.test.ts`
 * (the AC-415 criterion).
 */

/**
 * The subset of an `arch-index.json` the generator reads.
 *
 * Every record is scope-relative: `fileToIds` keys are files (the scope's own key
 * form), `nameToIds` keys are bare identifier names, and `idToFile`/`idToName`
 * map an entity id to its file / name. The generator never rewrites these keys —
 * scope-prefix handling belongs to the caller.
 *
 * The adjacency maps are the two directions of the same edge set:
 * `dependencies[from]` lists what `from` imports, `dependents[to]` lists who
 * imports `to`. An id mentioned only as an edge target and absent from
 * `idToFile` is not a node this index can place, so it is dropped rather than
 * emitted with a made-up file.
 */
/**
 * The node-kind discriminator an entity-graph node carries, normalised from the
 * `type` ArchGuard writes on each `arch.json` entity.
 *
 * `abstract` is not an ArchGuard `type`: it is a `class` whose `isAbstract` flag
 * is set, so the frontend can style it apart from a concrete class without a
 * second boolean on the wire. Everything this module does not recognise (a
 * namespace, a type alias, a future ArchGuard kind) normalises to `other`
 * rather than being dropped — a node with an unknown kind is still a node.
 */
export type EntityKind = 'class' | 'interface' | 'enum' | 'abstract' | 'function' | 'other';

/** The two member kinds a class/interface body distinguishes. */
export type EntityMemberKind = 'field' | 'method';

/**
 * One member of an entity, as the entity graph carries it.
 *
 * `kind` collapses ArchGuard's finer `type` vocabulary (`field`/`property` →
 * `field`; `method`/`constructor`/`getter`/`setter` → `method`) so a renderer
 * has exactly two cases. `visibility` is passed through verbatim when present.
 * `signature` is a display-ready one-liner: for a method its parameter list
 * and return type (`checkCredentials(): Promise<...>`), for a field its
 * declared type when ArchGuard recorded one.
 */
export type EntityMember = {
  readonly name: string;
  readonly kind: EntityMemberKind;
  readonly visibility?: string;
  readonly signature?: string;
};

/**
 * What the sibling `arch.json` knows about one entity beyond its index entry.
 *
 * This is the payload of the `kind`/`members` node fields. It is OPTIONAL on
 * every entity: a scope whose `arch.json` is absent or unreadable contributes
 * no details, and its nodes keep the legacy `id`/`label`/`distance` shape.
 */
export type EntityDetail = {
  readonly kind: EntityKind;
  readonly members: readonly EntityMember[];
};

/** The relation types ArchGuard records for a scope. */
export type RelationType = 'dependency' | 'call' | 'composition' | 'inheritance' | 'implementation';

/** Type guard for a string key read from a scope index's `relationsByType`. */
export function isRelationType(value: string): value is RelationType {
  return value === 'dependency' || value === 'call' || value === 'composition'
    || value === 'inheritance' || value === 'implementation';
}

export type ArchIndex = {
  readonly fileToIds: Readonly<Record<string, readonly string[]>>;
  readonly nameToIds: Readonly<Record<string, readonly string[]>>;
  readonly dependencies: Readonly<Record<string, readonly string[]>>;
  readonly dependents: Readonly<Record<string, readonly string[]>>;
  readonly idToFile: Readonly<Record<string, string>>;
  readonly idToName: Readonly<Record<string, string>>;
  /**
   * Typed internal edges as `[from, to]` pairs, keyed by relation type.
   *
   * ArchGuard keeps here only edges whose BOTH endpoints resolve to project
   * entities — an inheritance edge to an external base class (e.g.
   * `ProcessorBase`) is dropped — so the key set is NOT the full type set of
   * `arch.json`, and `inheritance`/`implementation` are often absent. Optional:
   * a scope index may omit the field entirely.
   */
  readonly relationsByType?: Readonly<Partial<Record<RelationType, readonly (readonly [string, string])[]>>>;
  /**
   * Per-entity kind and members, read from the scope's sibling `arch.json`
   * (they are NOT in `arch-index.json`). Keyed by the same raw entity id as
   * `idToFile`/`idToName`, so the caller's scope-prefix merge applies here too.
   *
   * Optional, and absent as a whole when no scope contributed details: that is
   * what keeps a legacy payload (or a project whose `arch.json` is missing)
   * byte-identical to the pre-detail shape.
   */
  readonly entityDetails?: Readonly<Record<string, EntityDetail>>;
};

/**
 * How a distance-0 entity earned its place in the graph.
 *
 *  · `direct` — the transcript named it and the name is unambiguous (few
 *    candidates) or the same message also spelled its file path;
 *  · `name`   — the transcript named it, but the name resolves to more
 *    entities than {@link DIRECT_MAX_CANDIDATES} and nothing disambiguated it
 *    (a same-named candidate);
 *  · `file`   — it was pulled in because its FILE was named (a pasted path or
 *    a file tool's `file_path`).
 *
 * Only `direct` is what the UI draws as a session seed; `name`/`file` entities
 * stay in the graph (the neighbourhood is unchanged) but are not highlighted.
 */
export type MentionTier = 'direct' | 'name' | 'file';

/**
 * Adjacent-seed provenance the tiering needs, supplied by the extractor
 * alongside the seed lists.
 *
 * Every map is optional-by-presence at the outer level: `GraphSeeds.mentions`
 * being absent is the legacy reading, where no node carries a tier.
 *
 *  · `identifierFiles` — identifier → project-relative files that occurred in
 *    a message that also named the identifier (path co-occurrence);
 *  · `identifierCounts` — identifier → number of provenance mentions;
 *  · `fileCounts` — file seed → number of provenance mentions.
 */
export type SeedMentionProvenance = {
  readonly identifierFiles: Readonly<Record<string, readonly string[]>>;
  readonly identifierCounts: Readonly<Record<string, number>>;
  readonly fileCounts: Readonly<Record<string, number>>;
};

/**
 * The caller's seed lists, already split by scope and stripped of prefixes.
 *
 * `files` entries are looked up in `fileToIds` verbatim; `identifiers` entries
 * are looked up in `nameToIds` with an EXACT, case-sensitive match (no substring
 * or fuzzy matching). Duplicates are collapsed; a seed that resolves to nothing
 * is reported in {@link UnresolvedSeeds} instead of being silently dropped.
 *
 * `mentions` is OPTIONAL provenance: absent means the caller ran no mention
 * extraction, and the payload keeps its exact pre-tier shape (no
 * `mentionTier`/`mentionCount` on nodes, no `stats.seedTiers`).
 */
export type GraphSeeds = {
  readonly files: readonly string[];
  readonly identifiers: readonly string[];
  readonly mentions?: SeedMentionProvenance;
};

/**
 * A name resolving to at most this many entities is treated as a DIRECT
 * mention; anything larger is a same-name candidate (`name` tier) unless the
 * message also spells the entity's file path.
 *
 * Calibrated on the live `.archguard` index (2026-10-22): across the three
 * scopes the merged `nameToIds` held 1,750 names for 2,009 resolutions — 1,493
 * unique names, 255 names with two entities, 2 with three, and no name with
 * more. A threshold of 3 therefore keeps every unambiguous name direct while
 * still separating a genuinely shared name (the task's `main` fixture, which
 * maps to five entities) from a unique one. The number is a starting point, not
 * a law: it is part of this module's contract, and the implementation record's
 * reading is what justifies it.
 */
export const DIRECT_MAX_CANDIDATES = 3;

/**
 * Generation knobs. There is deliberately no shipped default for `maxNodes`:
 * the caller passes the budget (AC-418 derives it from the request), so this
 * module never bakes a product constant into the graph shape.
 *
 * The entity and file graphs are budgeted independently: `maxNodes` bounds the
 * entity set, while `maxFiles` bounds the file set projected from the FULL
 * reachable entities (not from the entity-budget prefix). When `maxFiles` is
 * omitted the two budgets are equal, which preserves the pre-independent-budget
 * contract for callers that only know about `maxNodes`.
 *
 * `hops` defaults to 1 — the seed's neighbours in BOTH directions.
 */
export type GenerateGraphParams = {
  readonly hops?: number;
  readonly maxNodes: number;
  /** Independent file-node budget. Defaults to `maxNodes` when omitted. */
  readonly maxFiles?: number;
  /**
   * Cap on the members emitted per entity node. Omitted means "no cap": a
   * caller that has no product opinion gets the full member list, and a
   * payload produced without the field is byte-identical to the pre-detail
   * shape. The route-side caller passes the shipped default.
   */
  readonly maxMembers?: number;
};

/**
 * Counts of what the two emitted graphs actually contain, for the route's stats readout.
 *
 * `truncated` is the OR of the two granularities, kept for consumers written
 * before the per-granularity flags existed. New consumers read
 * `entityTruncated`/`fileTruncated` and can therefore tell WHICH graph was cut;
 * `entityTotal`/`fileTotal` are the pre-budget denominators so a UI can say
 * "showing 2000 of 6169" instead of only "truncated".
 */
export type GraphStats = {
  readonly entityNodes: number;
  readonly fileNodes: number;
  readonly entityEdges: number;
  readonly fileEdges: number;
  /** True when EITHER graph was cut; see `entityTruncated`/`fileTruncated` for which. */
  readonly truncated: boolean;
  /** True when the reachable entity set exceeded `maxNodes`. Optional on older payloads. */
  readonly entityTruncated?: boolean;
  /** True when the projected file set exceeded `maxFiles`. Optional on older payloads. */
  readonly fileTruncated?: boolean;
  /** Reachable entity nodes before the entity budget. Optional on older payloads. */
  readonly entityTotal?: number;
  /** Distinct file nodes before the file budget. Optional on older payloads. */
  readonly fileTotal?: number;
  /**
   * Count of the PRE-BUDGET reachable entities per {@link EntityKind}. This is
   * a property of the analysis, not of the node budget: a `maxNodes` cut never
   * changes it. Only entities whose `arch.json` detail was readable are
   * counted (an entity with no detail has no known kind, and is NOT silently
   * counted as `other`).
   *
   * Optional and absent when the index carries no `entityDetails` at all, so a
   * legacy reading keeps its exact old stats shape.
   */
  readonly kindCounts?: Readonly<Partial<Record<EntityKind, number>>>;
  /** The per-entity member cap this reading was generated with. */
  readonly membersPerEntity?: number;
  /** True when at least one retained node's member list was cut at `membersPerEntity`. */
  readonly membersTruncated?: boolean;
  /**
   * Counts of the EMITTED distance-0 nodes by {@link MentionTier}. Present only
   * when the caller supplied provenance, so a legacy reading has no such key;
   * the three counts always sum to the number of tiered nodes in `graph`.
   */
  readonly seedTiers?: Readonly<Record<MentionTier, number>>;
};

/** Seeds that matched nothing in this index, in first-occurrence order (deduplicated). */
export type UnresolvedSeeds = {
  readonly files: string[];
  readonly identifiers: string[];
};

/**
 * One node of the render-ready neighbourhood JSON.
 *
 * `id` is the raw merged entity id (or the project-relative file key), `label`
 * the display name, and `distance` the shortest hop count from the seeds over
 * BOTH adjacency directions (seeds are distance 0). The frontend slices this
 * list locally by `distance`, so the distance has to be the true BFS reading,
 * not an emission-order artefact.
 *
 * `type` is RESERVED for a future node-kind discriminator (the kind of thing a
 * renderer would style differently, e.g. a class or a package). The generator
 * never emits it today, and it is optional, so a payload written before it
 * existed — or read by a client that knows nothing about it — still satisfies
 * this contract unchanged.
 */
export type NeighborhoodNode = {
  readonly id: string;
  readonly label: string;
  readonly distance: number;
  readonly type?: string;
  /**
   * The entity's normalised kind, when its scope's `arch.json` was readable.
   * Omitted on the file graph always (a file is not a class), and on the
   * entity graph for a scope whose archive is missing or unparseable — so an
   * old payload and a detail-less reading stay indistinguishable in shape.
   */
  readonly kind?: EntityKind;
  /**
   * The entity's members (capped at the caller's `maxMembers`). Omitted when
   * no detail is available OR the entity has no members; `membersTruncated`
   * in the stats says whether any node's list was cut.
   */
  readonly members?: readonly EntityMember[];
  /**
   * Tier of this node's seed mention. Present ONLY on `distance === 0` nodes,
   * and only when the caller supplied {@link SeedMentionProvenance}; the file
   * graph never carries it. An old payload therefore has neither field, and a
   * client reading an absent `mentionTier` keeps its pre-tier behaviour.
   */
  readonly mentionTier?: MentionTier;
  /** How many messages mentioned the seed(s) this node was resolved from. */
  readonly mentionCount?: number;
};

/** One directed edge of the neighbourhood JSON, typed by ArchGuard's relation kind. */
export type NeighborhoodEdge = {
  readonly from: string;
  readonly to: string;
  readonly relationType: RelationType;
};

/**
 * A render-ready subgraph: the renderer-agnostic input of the architecture tab.
 *
 * This is the JSON schema the frontend renderer contract is written against —
 * it names no rendering library, so a new renderer is a new implementation of
 * the frontend contract, not a generator change.
 *
 * Every edge endpoint is guaranteed present in `nodes` (truncation can only
 * remove whole edges, never leave a dangling endpoint), and the node order is
 * (distance ascending, id ascending) so a client-side `maxNodes` slice is
 * deterministic.
 */
export type NeighborhoodGraph = {
  readonly nodes: readonly NeighborhoodNode[];
  readonly edges: readonly NeighborhoodEdge[];
};

/**
 * The generator's complete output: the two Mermaid documents (export path), the
 * same two subgraphs as JSON (the default render path), their counts, and the
 * unmatched seeds.
 */
export type GenerateGraphResult = {
  readonly mmd: { readonly file: string; readonly entity: string };
  readonly graph: { readonly file: NeighborhoodGraph; readonly entity: NeighborhoodGraph };
  readonly stats: GraphStats;
  readonly unresolved: UnresolvedSeeds;
};

/** Mermaid init directive, always the first line of both documents. */
const INIT_DIRECTIVE = '%%{init: {"theme": "default", "flowchart": {"htmlLabels": false}}}%%';

/** Graph direction shared by both documents. */
const FLOWCHART_DECLARATION = 'flowchart LR';

/** A node id may only contain these characters; everything else is replaced by `_`. */
const INVALID_ID_CHARS = /[^A-Za-z0-9_]/g;

/** An id that would start with a digit is prefixed so Mermaid never reads it as a number. */
const DIGIT_LEADING_ID = /^[0-9]/;

/** The shape {@link validateMermaid} requires of an emitted node id. */
const VALID_NODE_ID = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Deterministic id ordering. `localeCompare` is locale-dependent and would make
 * truncation and emission order differ between machines; raw code-unit order is
 * the stable "dictionary order" the budget rule calls for.
 */
function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** A directed, relation-typed edge between two raw (uncleaned) entity or file ids. */
type RenderEdge = {
  from: string;
  to: string;
  type: RelationType;
};

/**
 * Clean one raw entity/file identifier into a Mermaid node id.
 *
 * Rules, applied in this order so the result is stable for a given input order:
 *  1. every character outside `[A-Za-z0-9_]` becomes `_`;
 *  2. an empty result becomes `node`, and a digit-leading result gets the `n_`
 *     prefix (Mermaid reads a bare number as a literal, not an id);
 *  3. a collision with an already-assigned id gets a numeric suffix, counting up
 *     from 2 in assignment order.
 *
 * `used` is mutated: callers pass one set per document and walk raw ids in a
 * deterministic order.
 */
function cleanNodeId(raw: string, used: Set<string>): string {
  let base = raw.replace(INVALID_ID_CHARS, '_');
  if (base.length === 0) base = 'node';
  if (DIGIT_LEADING_ID.test(base)) base = `n_${base}`;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

/**
 * Render a label as a double-quoted Mermaid string.
 *
 * A raw `"` would terminate the quoted label, so it is escaped to Mermaid's
 * `#quot;` entity. Line breaks are folded to spaces: the emitter writes one node
 * per line and Mermaid labels may not span lines.
 */
function mermaidLabel(text: string): string {
  const flattened = text.replace(/\r\n?|\n/g, ' ');
  return `"${flattened.replace(/"/g, '#quot;')}"`;
}

/**
 * The Mermaid arrow for a relation type.
 *
 * `dependency` is the default solid arrow; `call` is dashed, `composition` is
 * thick. `inheritance`/`implementation` fall back to the solid arrow for now —
 * flowchart has no UML-generalisation arrow, and these two types do not reach
 * `relationsByType` until ArchGuard exposes external targets.
 */
function edgeArrow(type: RelationType): string {
  if (type === 'call') return '-.->';
  if (type === 'composition') return '==>';
  return '-->';
}

/**
 * Emit one Mermaid flowchart document.
 *
 * `nodes` and `edges` are already budgeted and filtered by the caller; this
 * function only assigns cleaned ids and writes the document. Node ids are
 * assigned in the given (sorted) order so collisions resolve deterministically.
 * Every edge's endpoints are guaranteed to be defined because the caller passes
 * only edges whose two ends survived the budget.
 */
function emitMermaid(nodes: readonly { rawId: string; label: string }[], edges: readonly RenderEdge[]): string {
  const used = new Set<string>();
  const idByRaw = new Map<string, string>();
  const lines: string[] = [INIT_DIRECTIVE, FLOWCHART_DECLARATION];

  for (const node of nodes) {
    const id = cleanNodeId(node.rawId, used);
    idByRaw.set(node.rawId, id);
    lines.push(`  ${id}[${mermaidLabel(node.label)}]`);
  }
  for (const edge of edges) {
    const from = idByRaw.get(edge.from);
    const to = idByRaw.get(edge.to);
    // The caller filters edges to retained nodes; this is a defensive no-op.
    if (from === undefined || to === undefined) continue;
    lines.push(`  ${from} ${edgeArrow(edge.type)} ${to}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Expand the seed set by `hops` levels over BOTH adjacency directions.
 *
 * Returns every reachable entity id with its shortest hop distance from the
 * seeds (seeds are distance 0). A neighbour absent from `idToFile` cannot be
 * placed in a file graph and is not a node this index knows, so it is skipped.
 */
function expandSeeds(
  index: ArchIndex,
  resolved: ReadonlySet<string>,
  hops: number,
): Map<string, number> {
  const distance = new Map<string, number>();
  for (const id of resolved) distance.set(id, 0);

  let frontier = [...resolved];
  for (let hop = 1; hop <= hops && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of [...(index.dependencies[id] ?? []), ...(index.dependents[id] ?? [])]) {
        if (distance.has(neighbor) || !Object.hasOwn(index.idToFile, neighbor)) continue;
        distance.set(neighbor, hop);
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  return distance;
}

/** Strength order used when one entity is reachable from several seeds. */
const TIER_STRENGTH: Readonly<Record<MentionTier, number>> = { direct: 3, name: 2, file: 1 };

/**
 * Resolve the two seed lists against a single index.
 *
 * Returns the resolved entity ids alongside the unmatched seeds, each list in
 * first-occurrence order. An identifier is matched by exact key presence in
 * `nameToIds`; a file by exact key presence in `fileToIds`. Never falls back to
 * substring, case-insensitive or fuzzy matching — a near-miss is an unresolved
 * seed the caller can surface, not a silent substitution.
 *
 * When `seeds.mentions` is present, each resolved id also gets a
 * {@link MentionTier} (the STRONGEST tier across every seed that resolved it)
 * and its mention count (the sum over those seeds). Resolution and the
 * `distance` semantics are unchanged; the tier map is additional provenance,
 * never a filter.
 */
function resolveSeeds(
  index: ArchIndex,
  seeds: GraphSeeds,
): {
  resolved: Set<string>;
  unresolved: UnresolvedSeeds;
  tiers: Map<string, MentionTier> | undefined;
  mentionCounts: Map<string, number> | undefined;
} {
  const resolved = new Set<string>();
  const unresolvedFiles: string[] = [];
  const unresolvedIdentifiers: string[] = [];
  const seenFiles = new Set<string>();
  const seenIdentifiers = new Set<string>();
  const tiers = seeds.mentions === undefined ? undefined : new Map<string, MentionTier>();
  const mentionCounts = seeds.mentions === undefined ? undefined : new Map<string, number>();

  const admit = (ids: readonly string[] | undefined, tier: MentionTier, mentionCount: number): boolean => {
    if (ids === undefined || ids.length === 0) return false;
    let admitted = false;
    for (const id of ids) {
      if (!Object.hasOwn(index.idToFile, id)) continue;
      resolved.add(id);
      admitted = true;
      if (tiers !== undefined) {
        const current = tiers.get(id);
        if (current === undefined || TIER_STRENGTH[tier] > TIER_STRENGTH[current]) tiers.set(id, tier);
      }
      if (mentionCounts !== undefined) mentionCounts.set(id, (mentionCounts.get(id) ?? 0) + mentionCount);
    }
    return admitted;
  };

  for (const file of seeds.files) {
    if (seenFiles.has(file)) continue;
    seenFiles.add(file);
    const count = seeds.mentions?.fileCounts[file] ?? 0;
    if (!admit(Object.hasOwn(index.fileToIds, file) ? index.fileToIds[file] : undefined, 'file', count)) {
      unresolvedFiles.push(file);
    }
  }
  for (const identifier of seeds.identifiers) {
    if (seenIdentifiers.has(identifier)) continue;
    seenIdentifiers.add(identifier);
    const ids = Object.hasOwn(index.nameToIds, identifier) ? index.nameToIds[identifier] : undefined;
    const candidateCount = ids?.length ?? 0;
    const coMentionedFiles = seeds.mentions?.identifierFiles[identifier] ?? [];
    const count = seeds.mentions?.identifierCounts[identifier] ?? 0;
    // A name is DIRECT when it is unambiguous by candidate count, or when the
    // transcript itself disambiguated it by spelling the entity's file path in
    // the same message. Otherwise it is a same-name candidate.
    const tierFor = (id: string): MentionTier => {
      if (candidateCount <= DIRECT_MAX_CANDIDATES) return 'direct';
      const file = index.idToFile[id];
      return file !== undefined && coMentionedFiles.includes(file) ? 'direct' : 'name';
    };
    let admitted = false;
    for (const id of ids ?? []) {
      if (!Object.hasOwn(index.idToFile, id)) continue;
      // `admit` applies one tier to the whole list; identifiers need a
      // per-entity reading, so the resolution is repeated here and the shared
      // bookkeeping is the same two maps.
      resolved.add(id);
      admitted = true;
      const tier = tierFor(id);
      if (tiers !== undefined) {
        const current = tiers.get(id);
        if (current === undefined || TIER_STRENGTH[tier] > TIER_STRENGTH[current]) tiers.set(id, tier);
      }
      if (mentionCounts !== undefined) mentionCounts.set(id, (mentionCounts.get(id) ?? 0) + count);
    }
    if (!admitted) unresolvedIdentifiers.push(identifier);
  }

  return {
    resolved,
    unresolved: { files: unresolvedFiles, identifiers: unresolvedIdentifiers },
    tiers,
    mentionCounts,
  };
}

/**
 * Order a distance map's keys: hop distance from the seeds ascending, then id
 * lexicographically ascending. Both halves are deterministic, so the same index
 * and seeds always truncate to the same nodes on every machine.
 */
function candidatesByDistance(distance: ReadonlyMap<string, number>): string[] {
  return [...distance.keys()].sort((a, b) => {
    const byDistance = (distance.get(a) ?? 0) - (distance.get(b) ?? 0);
    return byDistance !== 0 ? byDistance : compareIds(a, b);
  });
}

/**
 * Keep the budgeted prefix of the candidate set. The candidates are ordered by
 * {@link candidatesByDistance}, so the retained prefix is stable across runs.
 */
function applyBudget(distance: ReadonlyMap<string, number>, maxNodes: number): { retained: string[]; truncated: boolean } {
  const candidates = candidatesByDistance(distance);
  return {
    retained: candidates.slice(0, maxNodes),
    truncated: candidates.length > maxNodes,
  };
}

/**
 * Deduplicate and sort the entity edges induced by the retained node set.
 *
 * An edge survives only when BOTH endpoints were retained, which is what lets
 * the same node set produce a self-contained Mermaid document after truncation.
 */
function collectEntityEdges(index: ArchIndex, retained: readonly string[]): RenderEdge[] {
  const nodeSet = new Set(retained);
  const seen = new Set<string>();
  const edges: RenderEdge[] = [];

  if (index.relationsByType === undefined || Object.keys(index.relationsByType).length === 0) {
    // A scope index that predates `relationsByType` (or carries no typed
    // edges): derive the edge set from the merged adjacency and type every
    // edge `dependency` (the old behaviour).
    for (const from of retained) {
      for (const to of index.dependencies[from] ?? []) {
        if (!nodeSet.has(to) || from === to) continue;
        const key = `${from}\u0000${to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ from, to, type: 'dependency' });
      }
    }
  } else {
    for (const [rawType, pairs] of Object.entries(index.relationsByType)) {
      if (!isRelationType(rawType)) continue;
      for (const [from, to] of pairs) {
        if (!nodeSet.has(from) || !nodeSet.has(to)) continue;
        // A self-loop is an intra-entity method call, not a graph edge worth a
        // class-level arrow; it would only add noise (most `call` edges are
        // `X -> X`).
        if (from === to) continue;
        const key = `${from}\u0000${to}\u0000${rawType}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ from, to, type: rawType });
      }
    }
  }

  return edges.sort((a, b) => compareIds(a.from, b.from) || compareIds(a.to, b.to) || compareIds(a.type, b.type));
}

/**
 * Collapse entity edges to file edges.
 *
 * Each entity edge maps through `idToFile`; two entities in the same file
 * produce a self-loop the file graph drops, and several entity edges between the
 * same pair of files collapse to one file edge.
 */
function collectFileEdges(index: ArchIndex, entityEdges: readonly RenderEdge[]): RenderEdge[] {
  const seen = new Set<string>();
  const edges: RenderEdge[] = [];
  for (const edge of entityEdges) {
    const from = index.idToFile[edge.from];
    const to = index.idToFile[edge.to];
    if (from === undefined || to === undefined || from === to) continue;
    // Keyed by (from, to, type): one file pair may be linked by more than one
    // relation type, and each deserves its own arrow.
    const key = `${from}\u0000${to}\u0000${edge.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from, to, type: edge.type });
  }
  return edges.sort((a, b) => compareIds(a.from, b.from) || compareIds(a.to, b.to) || compareIds(a.type, b.type));
}

/** Render an entity label: the identifier it indexes, falling back to the raw id. */
function entityLabel(index: ArchIndex, id: string): string {
  return index.idToName[id] ?? id;
}

/**
 * Count the PRE-BUDGET reachable entities by kind.
 *
 * `ids` is the full reachable set, not the retained prefix — `kindCounts`
 * describes the analysis the reading was cut from, which is what lets a UI say
 * "412 functions in this neighbourhood" while drawing a 50-node preview.
 *
 * Returns `undefined` when the index carries no details at all (the legacy
 * shape), so a reading without `arch.json` keeps its exact old stats object.
 * An entity that has no detail entry is skipped rather than counted as `other`:
 * `other` means "an ArchGuard kind this module does not know", while a missing
 * entry means "no information", and conflating the two would invent data.
 */
function countEntityKinds(
  index: ArchIndex,
  ids: readonly string[],
): Partial<Record<EntityKind, number>> | undefined {
  const details = index.entityDetails;
  if (details === undefined) return undefined;
  const counts: Partial<Record<EntityKind, number>> = {};
  for (const id of ids) {
    const detail = details[id];
    if (detail === undefined) continue;
    counts[detail.kind] = (counts[detail.kind] ?? 0) + 1;
  }
  return counts;
}

/**
 * Build one entity node, enriching it with `kind`/`members` when the index has
 * a detail entry for it.
 *
 * The cap is applied here rather than in the caller so the emitted member list
 * and the `membersTruncated` flag are computed from the same comparison — a
 * node can never be cut without the stats saying so, or vice versa.
 */
function entityNode(
  index: ArchIndex,
  id: string,
  distance: number,
  maxMembers: number | undefined,
  truncated: { value: boolean },
  mention?: { readonly tier: MentionTier; readonly count: number },
): NeighborhoodNode {
  const base: NeighborhoodNode = {
    id,
    label: entityLabel(index, id),
    distance,
    // A tier is only ever emitted for a seed (distance 0) and only when the
    // caller supplied provenance; every other node keeps the legacy shape.
    ...(mention === undefined ? {} : { mentionTier: mention.tier, mentionCount: mention.count }),
  };
  const detail = index.entityDetails?.[id];
  if (detail === undefined) return base;

  const cap = maxMembers ?? detail.members.length;
  const members = detail.members.length > cap ? detail.members.slice(0, cap) : detail.members;
  if (members.length < detail.members.length) truncated.value = true;
  return members.length === 0 ? { ...base, kind: detail.kind } : { ...base, kind: detail.kind, members };
}

/**
 * Map the generator's internal edges onto the JSON wire shape.
 *
 * The JSON keeps one entry per (from, to, relationType) triple — the same
 * de-duplication the Mermaid emitter applies — so the client renders exactly
 * the edges the export document contains, no more and no less.
 */
function toNeighborhoodEdges(edges: readonly RenderEdge[]): NeighborhoodEdge[] {
  return edges.map((edge) => ({ from: edge.from, to: edge.to, relationType: edge.type }));
}

/**
 * Build the seeded, budgeted subgraph for one index and return both Mermaid
 * documents plus the counts they were built from.
 *
 * Deterministic by construction: seed order does not affect the result, node
 * order is (distance, id) and edge order is (from, to), and every emitted id is
 * cleaned in that same order. Unresolved seeds are returned, never dropped —
 * an empty graph is still a valid reading, but the caller can tell it apart
 * from "the seeds matched" by `unresolved`.
 *
 * Consumers: `server/modules/architecture/index.ts` (barrel) → AC-418 route;
 * `tests/generator.test.ts` (AC-415).
 */
export function generateGraph(
  index: ArchIndex,
  seeds: GraphSeeds,
  params: GenerateGraphParams,
): GenerateGraphResult {
  const hops = params.hops ?? 1;
  const maxFiles = params.maxFiles ?? params.maxNodes;
  const maxMembers = params.maxMembers;
  if (!Number.isInteger(hops) || hops < 0) {
    throw new RangeError(`generateGraph: hops must be a non-negative integer, received ${String(hops)}`);
  }
  if (!Number.isInteger(params.maxNodes) || params.maxNodes < 0) {
    throw new RangeError(`generateGraph: maxNodes must be a non-negative integer, received ${String(params.maxNodes)}`);
  }
  if (!Number.isInteger(maxFiles) || maxFiles < 0) {
    throw new RangeError(`generateGraph: maxFiles must be a non-negative integer, received ${String(maxFiles)}`);
  }
  if (maxMembers !== undefined && (!Number.isInteger(maxMembers) || maxMembers < 0)) {
    throw new RangeError(
      `generateGraph: maxMembers must be a non-negative integer when supplied, received ${String(maxMembers)}`,
    );
  }

  const { resolved, unresolved, tiers, mentionCounts } = resolveSeeds(index, seeds);
  const distance = expandSeeds(index, resolved, hops);

  // The entity graph is the budgeted prefix. The file graph is projected from
  // the FULL reachable set below, so its completeness does not depend on how
  // many entities this budget kept.
  const allEntityIds = candidatesByDistance(distance);
  const { retained, truncated: entityTruncated } = applyBudget(distance, params.maxNodes);
  const entityEdges = collectEntityEdges(index, retained);

  // Project every reachable entity onto its file before budgeting the file
  // graph. A file inherits the closest hop of the entities it contains, which
  // is the hop at which the file first enters the neighbourhood.
  const fileDistance = new Map<string, number>();
  for (const id of allEntityIds) {
    const file = index.idToFile[id];
    if (file === undefined) continue;
    const hop = distance.get(id) ?? 0;
    const current = fileDistance.get(file);
    if (current === undefined || hop < current) fileDistance.set(file, hop);
  }
  const { retained: fileNodes, truncated: fileTruncated } = applyBudget(fileDistance, maxFiles);

  // The file edges come from the FULL entity edge set, filtered to the file
  // nodes the file budget kept. Using the full set (rather than the retained
  // entity prefix) is what keeps the file view whole when entities were cut.
  const allEntityEdges = collectEntityEdges(index, allEntityIds);
  const fileNodeSet = new Set(fileNodes);
  const fileEdges = collectFileEdges(index, allEntityEdges)
    .filter((edge) => fileNodeSet.has(edge.from) && fileNodeSet.has(edge.to));

  // Mermaid node ids are assigned in lexicographic order so collisions resolve
  // the same way regardless of hop distance; the JSON below keeps the
  // (distance, id) order a client-side prefix can slice.
  const fileNodesForMmd = [...fileNodes].sort(compareIds);

  const entityMmd = emitMermaid(
    retained.map((id) => ({ rawId: id, label: entityLabel(index, id) })),
    entityEdges,
  );
  const fileMmd = emitMermaid(
    fileNodesForMmd.map((file) => ({ rawId: file, label: file })),
    fileEdges,
  );

  // The JSON node list carries each node's true hop distance; `retained` is
  // already sorted (distance, id), so retaining that order here is what makes a
  // client-side `maxNodes` prefix meaningful rather than arbitrary. Detail
  // enrichment happens per retained node only: the file graph is a projection
  // of PATHS, which carry no members, and stays exactly as it was.
  const membersTruncated = { value: false };
  const entityNodes: NeighborhoodNode[] = retained.map((id) => {
    const hop = distance.get(id) ?? 0;
    const tier = hop === 0 ? tiers?.get(id) : undefined;
    const mention = tier === undefined
      ? undefined
      : { tier, count: mentionCounts?.get(id) ?? 0 };
    return entityNode(index, id, hop, maxMembers, membersTruncated, mention);
  });

  // Seed tiers are a reading of the EMITTED nodes, not of the resolved set: a
  // node budget can cut a seed, and the counts must stay consistent with what
  // the payload actually carries.
  const seedTiers: Record<MentionTier, number> | undefined =
    tiers === undefined ? undefined : { direct: 0, name: 0, file: 0 };
  if (seedTiers !== undefined) {
    for (const node of entityNodes) {
      if (node.mentionTier !== undefined) seedTiers[node.mentionTier] += 1;
    }
  }

  const fileNodeList: NeighborhoodNode[] = fileNodes.map((file) => ({
    id: file,
    label: file,
    distance: fileDistance.get(file) ?? 0,
  }));
  fileNodeList.sort((a, b) => a.distance - b.distance || compareIds(a.id, b.id));

  // Kind counts describe the FULL reachable set (`allEntityIds`), i.e. before
  // the node budget — deliberately not `retained`, so cutting the preview never
  // rewrites the analysis readout.
  const kindCounts = countEntityKinds(index, allEntityIds);

  return {
    mmd: { file: fileMmd, entity: entityMmd },
    graph: {
      file: { nodes: fileNodeList, edges: toNeighborhoodEdges(fileEdges) },
      entity: { nodes: entityNodes, edges: toNeighborhoodEdges(entityEdges) },
    },
    stats: {
      entityNodes: retained.length,
      fileNodes: fileNodes.length,
      entityEdges: entityEdges.length,
      fileEdges: fileEdges.length,
      truncated: entityTruncated || fileTruncated,
      entityTruncated,
      fileTruncated,
      entityTotal: allEntityIds.length,
      fileTotal: fileDistance.size,
      ...(kindCounts !== undefined ? { kindCounts } : {}),
      // Both member readouts are emitted together or not at all: a payload with
      // no cap has nothing to report, and `membersTruncated: false` alone would
      // be a reading of a decision that was never made.
      ...(maxMembers !== undefined
        ? { membersPerEntity: maxMembers, membersTruncated: membersTruncated.value }
        : {}),
      ...(seedTiers !== undefined ? { seedTiers } : {}),
    },
    unresolved,
  };
}

/** A parsed edge in a document being validated. */
type ParsedEdge = {
  from: string;
  to: string;
  line: number;
};

/**
 * Check a Mermaid document against the four properties the generator promises.
 *
 * This is the same reading the AC-415 tests use, exported so the route and the
 * cache can reject a corrupted document rather than shipping it: the first line
 * must be an `%%{init: ...}%%` directive, the document must declare a flowchart,
 * every node id must be `[A-Za-z_][A-Za-z0-9_]*`, every label must be
 * double-quoted (a raw inner `"` is a problem; `#quot;` is the escape), and
 * every edge endpoint must be defined in the same document.
 *
 * Returns the list of problems; a valid document yields `[]`.
 *
 * Consumers: `server/modules/architecture/index.ts` (barrel) → AC-418 route and
 * AC-417 cache; `tests/generator.test.ts` (AC-415).
 */
export function validateMermaid(mmd: string): string[] {
  const problems: string[] = [];
  const lines = mmd.split('\n');
  const trimmed = lines.map((line) => line.trim());

  if (!/^%%\{init: .+\}%%$/.test(trimmed[0] ?? '')) {
    problems.push('first line must be a %%{init: ...}%% directive');
  }

  const nodeIds = new Set<string>();
  const edges: ParsedEdge[] = [];
  let sawFlowchart = false;

  for (let index = 1; index < trimmed.length; index += 1) {
    const line = trimmed[index];
    if (line.length === 0) continue;
    if (/^flowchart\s+(TB|TD|BT|RL|LR)$/.test(line)) {
      if (sawFlowchart) problems.push(`line ${index + 1}: duplicate flowchart declaration`);
      sawFlowchart = true;
      continue;
    }

    const node = /^([A-Za-z0-9_]+)\s*\[\s*"(.*)"\s*\]$/.exec(line);
    if (node !== null) {
      const [, id, label] = node;
      if (!VALID_NODE_ID.test(id)) {
        problems.push(`line ${index + 1}: invalid node id "${id}" (expected [A-Za-z_][A-Za-z0-9_]*)`);
      }
      if (label.includes('"')) {
        problems.push(`line ${index + 1}: label of "${id}" must escape inner quotes as #quot;`);
      }
      if (nodeIds.has(id)) problems.push(`line ${index + 1}: duplicate node id "${id}"`);
      nodeIds.add(id);
      continue;
    }

    const edge = /^([A-Za-z0-9_]+)\s*(?:-->|-\.->|==>)\s*([A-Za-z0-9_]+)$/.exec(line);
    if (edge !== null) {
      edges.push({ from: edge[1], to: edge[2], line: index + 1 });
      continue;
    }

    problems.push(`line ${index + 1}: unrecognized line "${line}"`);
  }

  if (!sawFlowchart) problems.push('document must declare a flowchart');

  for (const edge of edges) {
    if (!nodeIds.has(edge.from)) {
      problems.push(`line ${edge.line}: edge endpoint "${edge.from}" is not defined as a node`);
    }
    if (!nodeIds.has(edge.to)) {
      problems.push(`line ${edge.line}: edge endpoint "${edge.to}" is not defined as a node`);
    }
  }

  return problems;
}
