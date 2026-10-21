import { ARCHGUARD_RELATION_ARROWS } from '@yalehwang/plantuml-js/archguard';

import type {
  ArchitectureNeighborhood,
  ArchitectureNeighborhoodEdge,
  ArchitectureNeighborhoodNode,
} from '@/modules/architecture/useArchitectureGraph';

/**
 * ArchGuard neighbourhood JSON → PlantUML class-diagram source.
 *
 * The relation table comes from `@yalehwang/plantuml-js/archguard`, the
 * package's zero-dependency entry (it imports nothing, so it never drags the
 * ELK renderer or the Graphviz WASM into the first-screen chunk). The document
 * assembly and the display-name truncation are local on purpose: the 0.1.0
 * bridge's `displayName(id, maxDirSegments)` splits at the LAST dot and rejoins
 * with `/`, which turns `relpath.File.ts.Entity` into `…/File.ts/Entity` —
 * breaking this task's "keep relpath.EntityName, truncate the FRONT" rule.
 *
 * Every id is given a stable `n<i>` alias (node order, i.e. the server's
 * `(distance, id)` order) because a PlantUML identifier cannot contain `/`,
 * `.` or spaces. Aliases survive filtering, so a group's subgraph keeps the
 * ids the full diagram used.
 *
 * Classes are emitted inside nested `package "path" { … }` blocks taken from
 * each node's directory path (scope prefix stripped). The structure is what
 * lets the diagram carry hierarchy into the SVG: the renderer stamps each
 * entity with its innermost package id, and `hierarchyIndex.ts` turns that
 * into the entity → package → ancestor tree the zoom levels use. Aliasing is
 * independent of the grouping, so the same graph yields the same `aliasOf`.
 */

/**
 * The relation mapping decided for the architecture tab (archguard alignment),
 * imported from the package so the tab cannot drift from the reference table:
 *   · `dependency` / `call` → dashed open arrow `..>`, told apart by the
 *     `<<uses>>` / `<<call>>` stereotype — a call is a use, not a structural
 *     association;
 *   · `composition` / `aggregation` → hollow diamond at the source `o--` —
 *     archguard's "field holds a reference" is aggregation; it is deliberately
 *     NOT UML composition (`*--`), whose filled diamond asserts a lifecycle
 *     the index does not know;
 *   · `inheritance` → hollow triangle, solid line `--|>`;
 *   · `implementation` → hollow triangle, dashed line `..|>`.
 */
const RELATION_ARROWS = ARCHGUARD_RELATION_ARROWS;

/** Arrow for a relation kind the map does not know: a plain dashed use. */
const FALLBACK_ARROW = '..>';

/**
 * How many directory segments a display name keeps before the file/entity
 * tail. Truncation drops the FRONT of the path (the leading directories), so
 * the tail — the file name plus the entity name — always stays readable.
 */
export const MAX_DISPLAY_DIR_SEGMENTS = 3;

/** Path levels the overview view collapses to (`groupByPathPrefix` depth). */
export const OVERVIEW_DEPTH = 2;

/** Hops a first click into an entity opens; a second click on the same entity adds one. */
export const DEFAULT_NEIGHBORHOOD_HOPS = 1;

/**
 * Which slice of the already-fetched neighbourhood is on screen.
 *  · `overview` folds the whole graph into path groups;
 *  · `group` expands one path group into its own entities;
 *  · `neighborhood` shows one entity plus everything within `hops` of it.
 */
export type ArchitectureDiagramView =
  | { kind: 'overview' }
  | { kind: 'group'; prefix: string }
  | { kind: 'neighborhood'; entityId: string; hops: number };

/** What `archguardToPlantUml` produces for one view. */
export type ArchitecturePlantUml = {
  /** The `@startuml … @enduml` document handed to the renderer. */
  readonly puml: string;
  /** Original node id → its stable PlantUML alias (`n<i>`), built over the whole graph. */
  readonly aliasOf: ReadonlyMap<string, string>;
  /** Node ids drawn by this document (a group view is a filtered subset). */
  readonly nodeIds: readonly string[];
  /** Neighborhood view only: the alias the renderer centers the layout on. */
  readonly rendererEntity: string | null;
};

type ArchguardBridgeOptions = {
  /** Which slice to draw. Defaults to the overview. */
  readonly view?: ArchitectureDiagramView;
  /** Reuse an alias map built over the full graph (required when filtering). */
  readonly aliasOf?: ReadonlyMap<string, string>;
};

/**
 * Strip the leading `<scopeKey>/` from an ArchGuard id, keeping the
 * project-relative path (`src/modules/a.ts.Entity` → `modules/a.ts.Entity`).
 */
export function pathName(id: string): string {
  const slash = id.indexOf('/');
  return slash === -1 ? id : id.slice(slash + 1);
}

/**
 * Display name `relpath.EntityName`, front-truncated to the last
 * `maxDirSegments` directory segments. The tail after the last `/` (the file
 * name and, for entity nodes, the `.EntityName` suffix) is never shortened —
 * that tail is what tells two same-named files apart.
 */
export function displayName(id: string, maxDirSegments: number = MAX_DISPLAY_DIR_SEGMENTS): string {
  const rel = pathName(id);
  const lastSlash = rel.lastIndexOf('/');
  if (lastSlash === -1) return rel;
  const directories = rel.slice(0, lastSlash).split('/').filter(Boolean);
  const tail = rel.slice(lastSlash + 1);
  const kept = maxDirSegments > 0 ? directories.slice(-maxDirSegments) : directories;
  return [...kept, tail].join('/');
}

/** Deterministic alias map over the whole graph: node at index `i` → `n<i>`. */
export function archguardAliasMap(nodes: readonly ArchitectureNeighborhoodNode[]): Map<string, string> {
  const aliasOf = new Map<string, string>();
  nodes.forEach((node, index) => aliasOf.set(node.id, `n${String(index)}`));
  return aliasOf;
}

/** Escape a display name into a PlantUML `"quoted"` identifier. */
function sanitizeName(name: string): string {
  return name.replace(/["\r\n\t\\]/g, "'").replace(/\s+/g, ' ').trim();
}

/**
 * The package path (directory chain) of a node, from the scope-stripped path:
 * `scope/src/modules/chat/hooks/useX.ts.useX` → `src/modules/chat/hooks`.
 * An id with no directory (a top-level file) has no package (`''`).
 *
 * The full path is used, not the front-truncated display name: the hierarchy
 * index's ancestor chain must reach the root, and two files whose truncated
 * labels collide must still land in different packages.
 */
function packagePathOf(id: string): string {
  const rel = pathName(id);
  const lastSlash = rel.lastIndexOf('/');
  return lastSlash === -1 ? '' : rel.slice(0, lastSlash);
}

/** One node of the package tree the bridge emits, plus the class lines it owns. */
type PackageTreeNode = {
  /** Full package path, which is also the quoted `package` name. */
  readonly id: string;
  readonly children: Map<string, PackageTreeNode>;
  readonly entityLines: string[];
};

/**
 * Insert an entity's class line into the nested package tree, creating every
 * ancestor package it needs (`a`, `a/b`, `a/b/c` for `a/b/c`). A path-less
 * entity stays on the root node and is emitted unwrapped.
 */
function insertIntoPackageTree(
  root: PackageTreeNode,
  packagePath: string,
  line: string,
): void {
  let node = root;
  const segments = packagePath.split('/').filter(Boolean);
  let prefix = '';
  for (const segment of segments) {
    prefix = prefix === '' ? segment : `${prefix}/${segment}`;
    let child = node.children.get(prefix);
    if (child === undefined) {
      child = { id: prefix, children: new Map(), entityLines: [] };
      node.children.set(prefix, child);
    }
    node = child;
  }
  node.entityLines.push(line);
}

/**
 * Emit the package tree as nested `package "full/path" { … }` blocks. Child
 * packages are sorted so the document is deterministic for a given node set;
 * classes keep the neighbourhood's own order within their package.
 */
function emitPackageTree(node: PackageTreeNode, depth: number, lines: string[]): void {
  const indent = '  '.repeat(depth);
  for (const line of node.entityLines) lines.push(`${indent}${line}`);
  for (const childId of [...node.children.keys()].sort()) {
    const child = node.children.get(childId);
    if (child === undefined) continue;
    lines.push(`${indent}package "${sanitizeName(child.id)}" {`);
    emitPackageTree(child, depth + 1, lines);
    lines.push(`${indent}}`);
  }
}

/** True when the node's display name sits in the path group `prefix`. */
function inGroup(node: ArchitectureNeighborhoodNode, prefix: string): boolean {
  const name = displayName(node.id);
  return name === prefix || name.startsWith(`${prefix}/`);
}

/** Keep only the nodes in a group and the edges whose endpoints both stay. */
function groupSubgraph(
  graph: ArchitectureNeighborhood,
  prefix: string,
): { nodes: readonly ArchitectureNeighborhoodNode[]; edges: readonly ArchitectureNeighborhoodEdge[] } {
  const nodes = graph.nodes.filter((node) => inGroup(node, prefix));
  const kept = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to));
  return { nodes, edges };
}

/**
 * Build the PlantUML document for one architecture view.
 *
 * Consumers: `PlantUmlGraph.tsx` (the panel's renderer) and
 * `tests/architectureTab.test.tsx` (the mapping and truncation criteria).
 */
export function archguardToPlantUml(
  graph: ArchitectureNeighborhood,
  options: ArchguardBridgeOptions = {},
): ArchitecturePlantUml {
  const view = options.view ?? { kind: 'overview' };
  const aliasOf = options.aliasOf ?? archguardAliasMap(graph.nodes);
  const drawn = view.kind === 'group' ? groupSubgraph(graph, view.prefix) : graph;

  // The class lines are grouped into the nested package tree by directory path:
  // the renderer parses the blocks into package frames and stamps every entity
  // with its innermost package (`data-package-id`), which is what the frontend
  // hierarchy index reads instead of inferring containment from geometry.
  const packageRoot: PackageTreeNode = { id: '', children: new Map(), entityLines: [] };
  for (const node of drawn.nodes) {
    const alias = aliasOf.get(node.id);
    if (alias === undefined) continue;
    insertIntoPackageTree(
      packageRoot,
      packagePathOf(node.id),
      `class "${sanitizeName(displayName(node.id))}" as ${alias}`,
    );
  }

  const lines = ['@startuml'];
  emitPackageTree(packageRoot, 0, lines);
  for (const edge of drawn.edges) {
    const source = aliasOf.get(edge.from);
    const target = aliasOf.get(edge.to);
    if (source === undefined || target === undefined) continue;
    const mapping = RELATION_ARROWS[edge.relationType] ?? { arrow: FALLBACK_ARROW };
    const suffix = mapping.label === undefined ? '' : ` : ${mapping.label}`;
    lines.push(`${source} ${mapping.arrow} ${target}${suffix}`);
  }
  lines.push('@enduml');

  return {
    puml: lines.join('\n'),
    aliasOf,
    nodeIds: drawn.nodes.map((node) => node.id),
    rendererEntity:
      view.kind === 'neighborhood' ? (aliasOf.get(view.entityId) ?? null) : null,
  };
}
