import { ARCHGUARD_RELATION_ARROWS } from '@yalehwang/plantuml-js/archguard';

import {
  computeAdaptiveGrouping,
  DEFAULT_NODE_ID_SHAPE,
  directoryPathOf,
  OVERVIEW_GROUP_LIMIT,
  scopeRelativePath,
  type AdaptiveGrouping,
} from '@/modules/architecture/adaptiveGrouping';
import type {
  ArchitectureEntityMember,
  ArchitectureNodeIdShape,
} from '@/modules/architecture/rendererContract';
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

/** Hops a first click into an entity opens; a second click on the same entity adds one. */
export const DEFAULT_NEIGHBORHOOD_HOPS = 1;

/**
 * How much of a member row the DRAWING shows, in characters.
 *
 * The renderer sizes an entity box from the text it will actually paint, so a
 * signature like `process(inputs: Float32Array<ArrayBufferLike>[][], …)` (105
 * characters) used to widen the box to 856 units while the screen only ever
 * showed a fraction of it — on a phone the whole drawing then fitted at ~38 %.
 * Capping the drawn line here makes the box proportional to what the reader
 * sees; `PlantUmlMember.raw` keeps the full declaration, so the Text page, the
 * copied document and the Inspector never lose a character.
 */
export const MEMBER_MAX_CHARS = 48;

/**
 * Member rows an entity box DRAWS before the tail folds into the app's own
 * `… +N more (M members)` row. Six rows fit a phone frame without stretching
 * it; anything beyond is read in the Inspector.
 *
 * The row cap is the drawing layer's rule, NOT a renderer option: the
 * renderer's `memberMaxRows` writes the folded row into
 * `model.entities[].members` as a member, which would make the Text page and a
 * copied document state a member the source never declared. So the renderer is
 * only asked to CUT each drawn line (`memberMaxChars`); the row cap is applied
 * to the drawing after layout, where it cannot touch the model.
 *
 * This is the deliberate trade the task writes down: semantic zoom is an
 * identity map at ≥ 90 %, so at and above that scale an entity shows at most
 * six rows plus the fold marker, and the full member list lives in the
 * Inspector (whose `Show all N` expands it).
 */
export const MEMBER_MAX_ROWS = 6;

/**
 * The options the drawing hands the renderer, in the shape `RendererOptions`
 * expects. One definition for the drawing and for the tests that read what it
 * drew, so the two can never state different numbers.
 *
 * `detail: 'full'` is passed explicitly: the default detail is chosen from the
 * entity count, and a `compact` drawing would fold members on its own (for the
 * wrong reason). The row cap is ours, so the renderer draws every row and only
 * shortens the LINES here.
 */
export function memberDisplayLimits(): {
  detail: 'full';
  memberMaxChars: number;
} {
  return { detail: 'full', memberMaxChars: MEMBER_MAX_CHARS };
}

/**
 * The fold row the drawing paints when members are hidden, e.g.
 * `… +1 more (7 members)` for a seven-member class drawn with six rows.
 * `hidden` is how many rows the cap dropped; `total` is the entity's real
 * member count. Both appear so a reader can tell what is missing and how much.
 */
export function memberOverflowLabel(hidden: number, total: number): string {
  return `… +${hidden} more (${total} members)`;
}

/**
 * Which slice of the already-fetched neighbourhood is on screen.
 *  · `overview` folds the whole graph into path groups;
 *  · `group` expands one path group into its own entities;
 *  · `hierarchy` lays the WHOLE graph out once as nested packages, so the
 *    explosion zoom can reveal package → subpackage → entity levels by
 *    toggling visibility instead of re-laying the drawing;
 *  · `neighborhood` shows one entity plus everything within `hops` of it.
 */
export type ArchitectureDiagramView =
  | { kind: 'overview' }
  | { kind: 'group'; prefix: string }
  | { kind: 'hierarchy' }
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
  /**
   * True when the document's nodes are directory groups (`grp::<prefix>`
   * scaffolding) rather than entities. Such a drawing has no package frames or
   * entity package assignments, so it stays out of the explosion LOD.
   */
  readonly grouped: boolean;
};

type ArchguardBridgeOptions = {
  /** Which slice to draw. Defaults to the overview. */
  readonly view?: ArchitectureDiagramView;
  /**
   * The reading's member lists were cut at the server's per-entity cap
   * (`stats.membersTruncated`). The flag is reading-level, so which node was cut
   * is not attributable here: every entity box that HAS members ends with the
   * documented `… +N` marker line instead of an invented per-node count.
   * Absent/false leaves the boxes untouched.
   */
  readonly membersTruncated?: boolean;
  /** Reuse an alias map built over the full graph (required when filtering). */
  readonly aliasOf?: ReadonlyMap<string, string>;
  /**
   * `'adaptive'` collapses the overview and group views into directory groups
   * computed here (see `adaptiveGrouping.ts`), because the renderer's
   * `groupByPathPrefix` counts the FILE name as a path layer. `'raw'` (the
   * default) emits the entities as given and leaves grouping to the renderer,
   * which is what the bridge's own mapping criteria pin.
   */
  readonly grouping?: 'raw' | 'adaptive';
  /**
   * How the graph's node ids are shaped (see `ArchitectureNodeIdShape`).
   * Defaults to `scope-prefixed`, the entity scheme. A file graph must pass
   * `'project-relative'`: its first segment is a real directory, so peeling it
   * would drop `src/`, `scripts/`, … from every group label and every
   * ungrouped node's display name.
   */
  readonly idShape?: ArchitectureNodeIdShape;
};

/**
 * The path a display name is built from: the id minus its scope key when the
 * graph is `scope-prefixed`, unchanged when it is already project-relative.
 */
export function pathName(id: string, idShape: ArchitectureNodeIdShape = DEFAULT_NODE_ID_SHAPE): string {
  return scopeRelativePath(id, idShape);
}

/**
 * Display name `relpath.EntityName`, front-truncated to the last
 * `maxDirSegments` directory segments. The tail after the last `/` (the file
 * name and, for entity nodes, the `.EntityName` suffix) is never shortened —
 * that tail is what tells two same-named files apart. `idShape` decides whether
 * a leading scope key exists to strip at all.
 */
export function displayName(
  id: string,
  maxDirSegments: number = MAX_DISPLAY_DIR_SEGMENTS,
  idShape: ArchitectureNodeIdShape = DEFAULT_NODE_ID_SHAPE,
): string {
  const rel = pathName(id, idShape);
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
 * The entity name a kind-bearing node is labelled with.
 *
 * The server's `label` for an entity node is its bare identifier
 * (`haltVerdict`), which is exactly what a UML class box shows; the file it
 * lives in moves into the package frame and the hover `<title>`. A payload
 * whose label is missing or still the raw id falls back to the id's own last
 * `.`-segment, so the box never reverts to `file.ts.Name` by accident.
 */
function entityNameOf(node: ArchitectureNeighborhoodNode, idShape: ArchitectureNodeIdShape): string {
  const label = node.label.trim();
  if (label !== '' && label !== node.id) return label;
  const rel = pathName(node.id, idShape);
  const tail = rel.slice(rel.lastIndexOf('/') + 1);
  const dot = tail.lastIndexOf('.');
  return dot === -1 ? tail : tail.slice(dot + 1);
}

/**
 * The file a node lives in, project-relative (`modules/chat/Chat.ts`): the
 * node's path minus the entity suffix its id carries. A file-graph node IS its
 * file, so nothing is stripped.
 *
 * Consumers: `PlantUmlGraph.tsx` (the hover `<title>` that carries the file the
 * node box no longer spells out) and the label-collision fallback below.
 */
export function nodeFileOf(
  node: Pick<ArchitectureNeighborhoodNode, 'id' | 'label'>,
  idShape: ArchitectureNodeIdShape = DEFAULT_NODE_ID_SHAPE,
): string {
  const rel = pathName(node.id, idShape);
  const lastSlash = rel.lastIndexOf('/');
  const tail = rel.slice(lastSlash + 1);
  const label = node.label.trim();
  if (label !== '' && label !== node.id && tail.endsWith(`.${label}`)) {
    return rel.slice(0, rel.length - label.length - 1);
  }
  return rel;
}

/**
 * Whether a node is a session seed: a DIRECT transcript mention.
 *
 * Old payloads carry no `mentionTier`; falling back to `distance === 0` is what
 * keeps them visually unchanged. With tiers, only a direct mention is a seed —
 * same-name candidates (`name`) and file-expanded entities (`file`) stay in the
 * graph but never earn the marker, and a manual pin (`pinned`) is its own tier.
 */
export function isSessionSeedNode(
  node: Pick<ArchitectureNeighborhoodNode, 'distance' | 'mentionTier'>,
): boolean {
  return node.mentionTier === undefined ? node.distance === 0 : node.mentionTier === 'direct';
}

/**
 * The share of DRAWN entities that are session seeds at which the seed marker
 * stops discriminating and degrades to its lighter form.
 *
 * A marker that paints most of the drawing the same colour says nothing: with
 * seeds at half the entities or more, the thick amber frame no longer tells a
 * reader which boxes the transcript named. The marker then becomes a thin frame
 * plus a small dot, which keeps the reading without shouting over the drawing.
 */
export const LIGHT_SEED_SHARE_THRESHOLD = 0.5;

/**
 * How the seed marker should be drawn for this graph: `'heavy'` while seeds are
 * the minority (the marker still discriminates), `'light'` once they are half
 * the drawn entities or more. An empty graph has nothing to mark, so it reads
 * as `'heavy'` — the mode is inert there.
 *
 * Consumers: `PlantUmlGraph.tsx` (annotates the drawn boxes) and
 * `ArchitecturePanel.tsx` (the legend states the light form when it is in use).
 */
export function seedMarkerMode(
  nodes: readonly ArchitectureNeighborhoodNode[],
): 'heavy' | 'light' {
  if (nodes.length === 0) return 'heavy';
  const seedCount = nodes.filter(isSessionSeedNode).length;
  return seedCount / nodes.length >= LIGHT_SEED_SHARE_THRESHOLD ? 'light' : 'heavy';
}

/**
 * The visibility symbol a UML member row starts with. ArchGuard writes the
 * keyword (`public`/`private`/`protected`); a payload without one is a
 * TypeScript member with the language's default visibility, which is public.
 * The parser requires a leading symbol for a body line, so there is no
 * "unspecified" case to emit.
 */
function visibilitySymbol(visibility: string | undefined): string {
  switch (visibility) {
    case 'private':
    case '-':
      return '-';
    case 'protected':
    case '#':
      return '#';
    case 'package':
    case 'package-private':
    case 'internal':
    case '~':
      return '~';
    default:
      return '+';
  }
}

/** One member row: visibility symbol plus the server's display-ready one-liner. */
function memberRow(member: ArchitectureEntityMember): string {
  const text = member.kind === 'field'
    ? (member.signature === undefined ? member.name : `${member.name}: ${member.signature}`)
    : (member.signature === undefined ? `${member.name}()` : member.signature);
  return `${visibilitySymbol(member.visibility)} ${sanitizeName(text)}`;
}

/**
 * The body compartments of an entity box, fields first then methods (the
 * renderer draws one compartment for both, so the order is what keeps them
 * apart). A function is a single-compartment box: it never gets a body, even
 * if the payload somehow carries members for it.
 *
 * `membersTruncated` appends the reading's `… +N` marker after the last row.
 */
function entityBodyOf(
  node: ArchitectureNeighborhoodNode,
  membersTruncated: boolean,
): readonly string[] {
  if (node.kind === 'function') return [];
  const members = node.members ?? [];
  const rows = [
    ...members.filter((member) => member.kind === 'field').map(memberRow),
    ...members.filter((member) => member.kind === 'method').map(memberRow),
  ];
  if (membersTruncated && rows.length > 0) rows.push(`${visibilitySymbol(undefined)} … +N`);
  return rows;
}

/**
 * The declaration head for a kind-bearing node.
 *
 * The stereotype is written as a REAL PlantUML stereotype (`class "Name" as n0
 * <<function>>`) instead of being glued into the quoted display name. Copying
 * the document is the point: an external PlantUML tool must render the same
 * «function» / «interface» badge the tab draws, and a `<<…>>` inside a quoted
 * name is just text to it. `alias` is part of the head because the standard
 * spelling puts the stereotype AFTER the alias.
 *
 * Consumers that DRAW this document (the renderer's parser predates real
 * stereotype support) normalise it back with {@link parserSafePlantUml}; the
 * text the reader copies and exports is this standard spelling.
 */
function entityHead(
  kind: NonNullable<ArchitectureNeighborhoodNode['kind']>,
  label: string,
  alias: string,
): string {
  switch (kind) {
    case 'interface':
      return `interface "${label}" as ${alias} <<interface>>`;
    case 'enum':
      return `enum "${label}" as ${alias}`;
    case 'abstract':
      return `abstract class "${label}" as ${alias}`;
    case 'function':
      return `class "${label}" as ${alias} <<function>>`;
    default:
      return `class "${label}" as ${alias}`;
  }
}

/**
 * The same document in the spelling the bundled renderer's parser understands.
 *
 * `@yalehwang/plantuml-js` 0.3.1 recognises `class "Name" <<stereotype>> as n0`
 * (stereotype BEFORE the alias) but not the standard `as n0 <<stereotype>>`
 * order, and it never preserves a stereotype as data. The drawing therefore
 * receives this parser-safe form, which keeps the alias and the display name
 * intact, and then re-states the stereotype in the DOM (`annotateNodes`). The
 * DOCUMENT the reader copies stays in the standard form above.
 */
export function parserSafePlantUml(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const match = /^(\s*)((?:abstract\s+)?(?:class|interface|enum))\s+"([^"]*)"\s+as\s+([A-Za-z_][A-Za-z0-9_]*)\s+<<([^>]+)>>(\s*\{?)\s*$/.exec(line);
      if (match === null) return line;
      const [, indent, keyword, name, alias, stereotype, brace] = match;
      return `${indent}${keyword} "<<${stereotype}>> ${name}" as ${alias}${brace}`;
    })
    .join('\n');
}

/**
 * The full declaration (head plus optional body) of one entity, as lines that
 * the package emitter indents. A legacy node (no `kind`) keeps the pre-detail
 * rendering byte-for-byte: the front-truncated `file.ts.Name` class line.
 */
function entityDeclarationLines(
  node: ArchitectureNeighborhoodNode,
  alias: string,
  label: string | null,
  idShape: ArchitectureNodeIdShape,
  membersTruncated: boolean,
): readonly string[] {
  if (node.kind === undefined || label === null) {
    return [`class "${sanitizeName(displayName(node.id, MAX_DISPLAY_DIR_SEGMENTS, idShape))}" as ${alias}`];
  }
  const head = entityHead(node.kind, sanitizeName(label), alias);
  const body = entityBodyOf(node, membersTruncated);
  if (body.length === 0) return [head];
  return [`${head} {`, ...body.map((row) => `  ${row}`), '}'];
}

/**
 * The label each kind-bearing node draws, with the collision fallback: two
 * entities with the same name inside one package are told apart by the file
 * they live in (`Reader.ts.Reader` vs `Ports.ts.Reader`). Legacy nodes are
 * absent from the map — they never enter this naming scheme.
 */
function entityLabels(
  nodes: readonly ArchitectureNeighborhoodNode[],
  idShape: ArchitectureNodeIdShape,
): Map<string, string> {
  const names = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const node of nodes) {
    if (node.kind === undefined) continue;
    const label = entityNameOf(node, idShape);
    names.set(node.id, label);
    const key = `${directoryPathOf(node.id, idShape)}\u0000${label}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const node of nodes) {
    const label = names.get(node.id);
    if (label === undefined) continue;
    const key = `${directoryPathOf(node.id, idShape)}\u0000${label}`;
    labels.set(
      node.id,
      (seen.get(key) ?? 0) > 1
        ? `${fileNameOf(node, idShape, label)}.${label}`
        : label,
    );
  }
  return labels;
}

/** The file part of a node's path, without its directories or entity suffix. */
function fileNameOf(
  node: ArchitectureNeighborhoodNode,
  idShape: ArchitectureNodeIdShape,
  entityName: string,
): string {
  const file = nodeFileOf(node, idShape);
  const tail = file.slice(file.lastIndexOf('/') + 1);
  return tail !== '' ? tail : entityName;
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
function packagePathOf(id: string, idShape: ArchitectureNodeIdShape): string {
  return directoryPathOf(id, idShape);
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
  lines: readonly string[],
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
  node.entityLines.push(...lines);
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

/** True when the node's DIRECTORY is `prefix` or a descendant of it. */
function inDirectoryGroup(id: string, prefix: string, idShape: ArchitectureNodeIdShape): boolean {
  const directory = directoryPathOf(id, idShape);
  return directory === prefix || directory.startsWith(`${prefix}/`);
}

/** Keep only the nodes in a directory group and the edges whose endpoints both stay. */
function groupSubgraph(
  graph: ArchitectureNeighborhood,
  prefix: string,
  idShape: ArchitectureNodeIdShape,
): { nodes: readonly ArchitectureNeighborhoodNode[]; edges: readonly ArchitectureNeighborhoodEdge[] } {
  const nodes = graph.nodes.filter((node) => inDirectoryGroup(node.id, prefix, idShape));
  const kept = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to));
  return { nodes, edges };
}

/** The PlantUML class line for one entity, wrapped into its package tree. */
function emitEntityDocument(
  drawn: { readonly nodes: readonly ArchitectureNeighborhoodNode[]; readonly edges: readonly ArchitectureNeighborhoodEdge[] },
  aliasOf: ReadonlyMap<string, string>,
  idShape: ArchitectureNodeIdShape,
  membersTruncated: boolean,
): { puml: string; nodeIds: readonly string[] } {
  // The class lines are grouped into the nested package tree by directory path:
  // the renderer parses the blocks into package frames and stamps every entity
  // with its innermost package (`data-package-id`), which is what the frontend
  // hierarchy index reads instead of inferring containment from geometry.
  const packageRoot: PackageTreeNode = { id: '', children: new Map(), entityLines: [] };
  const labels = entityLabels(drawn.nodes, idShape);
  for (const node of drawn.nodes) {
    const alias = aliasOf.get(node.id);
    if (alias === undefined) continue;
    insertIntoPackageTree(
      packageRoot,
      packagePathOf(node.id, idShape),
      entityDeclarationLines(node, alias, labels.get(node.id) ?? null, idShape, membersTruncated),
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

  return { puml: lines.join('\n'), nodeIds: drawn.nodes.map((node) => node.id) };
}

/** The group label: its directory path plus the number of entities it stands for. */
function groupLabel(prefix: string, count: number): string {
  return prefix === '' ? `(root) (${count})` : `${prefix} (${count})`;
}

/**
 * Emit an adaptive-grouped document: one class per directory group (labelled
 * with its count) plus the entities the grouping left outside a group
 * (scope-root files, and the sole member of every single-member directory),
 * with the graph's edges aggregated onto the drawn nodes.
 *
 * Aggregation keys on the drawn pair only and keeps the first relation kind,
 * mirroring the renderer's own overview aggregation — a group edge is a
 * summary, not a promise that every underlying relation had that kind. A node
 * outside a group aggregates as itself, so folding a `(1)` group never loses
 * its edges.
 */
function emitGroupedDocument(
  drawn: { readonly nodes: readonly ArchitectureNeighborhoodNode[]; readonly edges: readonly ArchitectureNeighborhoodEdge[] },
  grouping: AdaptiveGrouping,
  aliasOf: ReadonlyMap<string, string>,
  idShape: ArchitectureNodeIdShape,
  membersTruncated: boolean,
): ArchitecturePlantUml {
  const lines = ['@startuml'];
  const mergedAliases = new Map(aliasOf);
  const groupAliasOf = new Map<string, string>();
  const groupOf = new Map<string, string>();

  grouping.groups.forEach((group, index) => {
    const alias = `g${String(index)}`;
    // `grp::<prefix>` is the renderer's documented overview node id; the panel
    // prefixes a click on such a node into `{ kind: 'group', prefix }`.
    const id = `grp::${group.prefix}`;
    groupAliasOf.set(group.prefix, alias);
    mergedAliases.set(id, alias);
    for (const nodeId of group.nodeIds) groupOf.set(nodeId, group.prefix);
    lines.push(`class "${sanitizeName(groupLabel(group.prefix, group.count))}" as ${alias}`);
  });

  // Ungrouped nodes are entities the fold drew as themselves, so they take the
  // same UML shape (kind, members, pure name label) the entity drawing uses.
  // They sit at the top level: a group document has no package frames.
  const labels = entityLabels(drawn.nodes, idShape);
  const nodeOf = new Map(drawn.nodes.map((node) => [node.id, node]));
  for (const id of grouping.ungroupedNodeIds) {
    const alias = aliasOf.get(id);
    const node = nodeOf.get(id);
    if (alias === undefined || node === undefined) continue;
    lines.push(...entityDeclarationLines(node, alias, labels.get(id) ?? null, idShape, membersTruncated));
  }

  const aliasFor = (id: string): string | undefined => {
    const prefix = groupOf.get(id);
    if (prefix !== undefined) return groupAliasOf.get(prefix);
    return aliasOf.get(id);
  };
  const seen = new Set<string>();
  for (const edge of drawn.edges) {
    const source = aliasFor(edge.from);
    const target = aliasFor(edge.to);
    if (source === undefined || target === undefined || source === target) continue;
    const key = `${source}\u0000${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const mapping = RELATION_ARROWS[edge.relationType] ?? { arrow: FALLBACK_ARROW };
    const suffix = mapping.label === undefined ? '' : ` : ${mapping.label}`;
    lines.push(`${source} ${mapping.arrow} ${target}${suffix}`);
  }
  lines.push('@enduml');

  const drawnIds = [
    ...grouping.groups.map((group) => `grp::${group.prefix}`),
    ...grouping.ungroupedNodeIds,
  ];
  return {
    puml: lines.join('\n'),
    aliasOf: mergedAliases,
    nodeIds: drawnIds,
    rendererEntity: null,
    grouped: true,
  };
}

/**
 * The overview's collapsed document: directory groups only. Scope-root files
 * (no directory) stay individual entities, matching the renderer's old
 * behaviour; when the graph has no directories at all the document is the raw
 * entity drawing.
 */
function adaptiveOverviewDocument(
  graph: ArchitectureNeighborhood,
  aliasOf: ReadonlyMap<string, string>,
  idShape: ArchitectureNodeIdShape,
  membersTruncated: boolean,
): ArchitecturePlantUml {
  const grouping = computeAdaptiveGrouping(graph.nodes.map((node) => node.id), {
    maxGroups: OVERVIEW_GROUP_LIMIT,
    idShape,
  });
  if (grouping.groups.length === 0) {
    const raw = emitEntityDocument(graph, aliasOf, idShape, membersTruncated);
    return { ...raw, aliasOf, rendererEntity: null, grouped: false };
  }
  return emitGroupedDocument(graph, grouping, aliasOf, idShape, membersTruncated);
}

/**
 * The group view's document. Expanding a directory re-applies the same
 * directory-only rule to its subtree: a directory that still has subdirectories
 * shows them as groups instead of flattening every file.
 *
 * The one group that can never stay a box is the one whose prefix IS the view
 * prefix: clicking it addresses `{ kind: 'group', prefix }` again, so the view
 * would not change. Its members are always drawn flat — the entity path — and
 * the `OVERVIEW_GROUP_LIMIT` that guards the overview does not apply to them,
 * because an expansion is the user explicitly asking to see inside. The
 * server-side node budget (`maxNodes` / its "Node budget reached" notice) is
 * what bounds a huge leaf directory; no group box is invented to hide it.
 *
 * With the prefix group flattened, the remaining subdirectory groups still get
 * their boxes. Edge aggregation keeps the "folding must not drop an edge" rule:
 * the flattened members lose only their group alias and fall back to their own
 * entity aliases, so a former group→group edge becomes entity→group (or
 * entity→entity) on the same pair of endpoints.
 */
function adaptiveGroupViewDocument(
  graph: ArchitectureNeighborhood,
  prefix: string,
  aliasOf: ReadonlyMap<string, string>,
  idShape: ArchitectureNodeIdShape,
  membersTruncated: boolean,
): ArchitecturePlantUml {
  const drawn = groupSubgraph(graph, prefix, idShape);
  const grouping = computeAdaptiveGrouping(drawn.nodes.map((node) => node.id), {
    prefix,
    groupDirectNodes: true,
    maxGroups: OVERVIEW_GROUP_LIMIT,
    idShape,
  });

  const flatGroup = grouping.groups.find((group) => group.prefix === prefix);
  const groups = grouping.groups.filter((group) => group.prefix !== prefix);
  // No subdirectory group left: the whole subtree is entities (a leaf directory
  // of any size). Reuse the caller's alias map and the entity drawing.
  if (groups.length === 0) {
    const raw = emitEntityDocument(drawn, aliasOf, idShape, membersTruncated);
    return { ...raw, aliasOf, rendererEntity: null, grouped: false };
  }

  // Flat members join the ungrouped set in the neighbourhood's own order, so
  // the document stays deterministic in the server's `(distance, id)` order.
  const flatIds = new Set(flatGroup?.nodeIds ?? []);
  const ungroupedIds = new Set(grouping.ungroupedNodeIds);
  const ungroupedNodeIds = drawn.nodes
    .map((node) => node.id)
    .filter((id) => flatIds.has(id) || ungroupedIds.has(id));

  return emitGroupedDocument(
    drawn,
    { depth: grouping.depth, groups, ungroupedNodeIds },
    aliasOf,
    idShape,
    membersTruncated,
  );
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
  const idShape = options.idShape ?? DEFAULT_NODE_ID_SHAPE;
  const membersTruncated = options.membersTruncated === true;

  // The adaptive path is the panel's; the raw path is the bridge's own mapping
  // contract (and the default), which emits exactly the entities it is given.
  if (options.grouping === 'adaptive') {
    if (view.kind === 'overview') return adaptiveOverviewDocument(graph, aliasOf, idShape, membersTruncated);
    if (view.kind === 'group') return adaptiveGroupViewDocument(graph, view.prefix, aliasOf, idShape, membersTruncated);
  }

  const drawn = view.kind === 'group' ? groupSubgraph(graph, view.prefix, idShape) : graph;
  const raw = emitEntityDocument(drawn, aliasOf, idShape, membersTruncated);
  return {
    ...raw,
    aliasOf,
    rendererEntity:
      view.kind === 'neighborhood' ? (aliasOf.get(view.entityId) ?? null) : null,
    grouped: false,
  };
}
