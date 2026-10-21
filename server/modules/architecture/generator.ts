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
};

/**
 * The caller's seed lists, already split by scope and stripped of prefixes.
 *
 * `files` entries are looked up in `fileToIds` verbatim; `identifiers` entries
 * are looked up in `nameToIds` with an EXACT, case-sensitive match (no substring
 * or fuzzy matching). Duplicates are collapsed; a seed that resolves to nothing
 * is reported in {@link UnresolvedSeeds} instead of being silently dropped.
 */
export type GraphSeeds = {
  readonly files: readonly string[];
  readonly identifiers: readonly string[];
};

/**
 * Generation knobs. There is deliberately no shipped default for `maxNodes`:
 * the caller passes the budget (AC-418 derives it from the request), so this
 * module never bakes a product constant into the graph shape.
 *
 * `hops` defaults to 1 — the seed's neighbours in BOTH directions.
 */
export type GenerateGraphParams = {
  readonly hops?: number;
  readonly maxNodes: number;
};

/** Counts of what the two emitted graphs actually contain, for the route's stats readout. */
export type GraphStats = {
  readonly entityNodes: number;
  readonly fileNodes: number;
  readonly entityEdges: number;
  readonly fileEdges: number;
  /** True when the candidate set exceeded `maxNodes` and was cut deterministically. */
  readonly truncated: boolean;
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
 */
export type NeighborhoodNode = {
  readonly id: string;
  readonly label: string;
  readonly distance: number;
};

/** One directed edge of the neighbourhood JSON, typed by ArchGuard's relation kind. */
export type NeighborhoodEdge = {
  readonly from: string;
  readonly to: string;
  readonly relationType: RelationType;
};

/**
 * A render-ready subgraph: the cytoscape input the architecture panel consumes.
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

/**
 * Resolve the two seed lists against a single index.
 *
 * Returns the resolved entity ids alongside the unmatched seeds, each list in
 * first-occurrence order. An identifier is matched by exact key presence in
 * `nameToIds`; a file by exact key presence in `fileToIds`. Never falls back to
 * substring, case-insensitive or fuzzy matching — a near-miss is an unresolved
 * seed the caller can surface, not a silent substitution.
 */
function resolveSeeds(
  index: ArchIndex,
  seeds: GraphSeeds,
): { resolved: Set<string>; unresolved: UnresolvedSeeds } {
  const resolved = new Set<string>();
  const unresolvedFiles: string[] = [];
  const unresolvedIdentifiers: string[] = [];
  const seenFiles = new Set<string>();
  const seenIdentifiers = new Set<string>();

  const admit = (ids: readonly string[] | undefined): boolean => {
    if (ids === undefined || ids.length === 0) return false;
    let admitted = false;
    for (const id of ids) {
      if (!Object.hasOwn(index.idToFile, id)) continue;
      resolved.add(id);
      admitted = true;
    }
    return admitted;
  };

  for (const file of seeds.files) {
    if (seenFiles.has(file)) continue;
    seenFiles.add(file);
    if (!admit(Object.hasOwn(index.fileToIds, file) ? index.fileToIds[file] : undefined)) {
      unresolvedFiles.push(file);
    }
  }
  for (const identifier of seeds.identifiers) {
    if (seenIdentifiers.has(identifier)) continue;
    seenIdentifiers.add(identifier);
    if (!admit(Object.hasOwn(index.nameToIds, identifier) ? index.nameToIds[identifier] : undefined)) {
      unresolvedIdentifiers.push(identifier);
    }
  }

  return {
    resolved,
    unresolved: { files: unresolvedFiles, identifiers: unresolvedIdentifiers },
  };
}

/**
 * Keep the budgeted prefix of the candidate set.
 *
 * The order is "hop distance from the seeds ascending, then entity id
 * lexicographically ascending" — both halves are deterministic, so the same
 * index and seeds always truncate to the same nodes on every machine.
 */
function applyBudget(distance: ReadonlyMap<string, number>, maxNodes: number): { retained: string[]; truncated: boolean } {
  const candidates = [...distance.keys()].sort((a, b) => {
    const byDistance = (distance.get(a) ?? 0) - (distance.get(b) ?? 0);
    return byDistance !== 0 ? byDistance : compareIds(a, b);
  });
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
  if (!Number.isInteger(hops) || hops < 0) {
    throw new RangeError(`generateGraph: hops must be a non-negative integer, received ${String(hops)}`);
  }
  if (!Number.isInteger(params.maxNodes) || params.maxNodes < 0) {
    throw new RangeError(`generateGraph: maxNodes must be a non-negative integer, received ${String(params.maxNodes)}`);
  }

  const { resolved, unresolved } = resolveSeeds(index, seeds);
  const distance = expandSeeds(index, resolved, hops);
  const { retained, truncated } = applyBudget(distance, params.maxNodes);
  const entityEdges = collectEntityEdges(index, retained);
  const fileEdges = collectFileEdges(index, entityEdges);
  const fileNodes = [...new Set(retained.map((id) => index.idToFile[id]))].sort(compareIds);

  const entityMmd = emitMermaid(
    retained.map((id) => ({ rawId: id, label: entityLabel(index, id) })),
    entityEdges,
  );
  const fileMmd = emitMermaid(
    fileNodes.map((file) => ({ rawId: file, label: file })),
    fileEdges,
  );

  // The JSON node list carries each node's true hop distance; `retained` is
  // already sorted (distance, id), so retaining that order here is what makes a
  // client-side `maxNodes` prefix meaningful rather than arbitrary.
  const entityNodes: NeighborhoodNode[] = retained.map((id) => ({
    id,
    label: entityLabel(index, id),
    distance: distance.get(id) ?? 0,
  }));

  // A file node aggregates several entities; its distance is the closest of
  // them, which is the hop at which the file first enters the neighbourhood.
  const fileDistance = new Map<string, number>();
  for (const id of retained) {
    const file = index.idToFile[id];
    if (file === undefined) continue;
    const hop = distance.get(id) ?? 0;
    const current = fileDistance.get(file);
    if (current === undefined || hop < current) fileDistance.set(file, hop);
  }
  const fileNodeList: NeighborhoodNode[] = fileNodes.map((file) => ({
    id: file,
    label: file,
    distance: fileDistance.get(file) ?? 0,
  }));
  fileNodeList.sort((a, b) => a.distance - b.distance || compareIds(a.id, b.id));

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
      truncated,
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
