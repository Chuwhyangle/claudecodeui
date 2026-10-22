import { DEFAULT_NODE_ID_SHAPE, directoryPathOf } from '@/modules/architecture/adaptiveGrouping';
import {
  archguardToPlantUml,
  type ArchitectureDiagramView,
} from '@/modules/architecture/archguardToPlantUml';
import type {
  ArchitectureNodeIdShape,
  ArchitectureRendererGraph,
} from '@/modules/architecture/rendererContract';

/**
 * The text page's pure half: turn one scope of the drawing into the PlantUML
 * document the panel shows, copies and downloads, plus the readings the page
 * puts beside it (volume, preview, syntax state).
 *
 * The document is built by the SAME bridge the drawing uses
 * (`archguardToPlantUml`), so the text is the picture rather than a second
 * derivation of the payload. The one seam the task reserves is
 * {@link buildPlantUmlText}: when the upstream bridge gains
 * `toPlantUml(renderDetailed().model)`, only this function's body changes —
 * the page and its tests keep calling `buildPlantUmlText(graph, scope)`.
 *
 * Consumers: `ArchitectureTextPanel.tsx` (the page) and
 * `tests/plantUmlText.test.ts` (the scope/volume criteria).
 */

/**
 * The characters-per-token estimate the volume reading uses. Measured on the
 * real project: quay's whole entity diagram is 211,243 characters / 5,268
 * lines and the count lands at about 60,355 tokens, i.e. 3.5 chars/token. The
 * reading is always labelled "approx." because a tokenizer would disagree.
 */
export const TEXT_CHARS_PER_TOKEN = 3.5;

/** How many lines the page renders. Copy and download always use the whole text. */
export const TEXT_PREVIEW_LINE_LIMIT = 300;

/** From this many estimated tokens the page warns that the scope is large. */
export const TEXT_LARGE_TOKEN_THRESHOLD = 8000;

/** Above this many estimated tokens "copy as session context" asks first. */
export const TEXT_HUGE_TOKEN_THRESHOLD = 30000;

/** How long a pan/zoom gesture must settle before the viewport scope re-measures. */
export const VIEWPORT_RECOMPUTE_DELAY_MS = 400;

/** The overview/group drawing's scaffolding prefix (`grp::<directory prefix>`). */
const GROUP_ID_PREFIX = 'grp::';

/** One scope the text page can show. */
export type ArchitectureTextScope =
  /** The whole graph the drawing was handed (filters/detail/budget already applied). */
  | { readonly kind: 'full' }
  /**
   * The nodes whose drawn rectangles intersect the viewport. The page reads the
   * ids from the live SVG and passes them here; a `grp::<prefix>` id (the
   * overview's directory scaffolding) is expanded to that directory's nodes.
   */
  | { readonly kind: 'viewport'; readonly nodeIds: readonly string[] }
  /**
   * The selection and its one-hop neighbourhood: the anchor ids are the selected
   * entity, or both ends of the selected relation, and the scope adds every node
   * one edge away from them. An empty anchor list is the dedicated
   * {@link NoSelectionScopeError}, never an empty document.
   */
  | { readonly kind: 'selection'; readonly nodeIds: readonly string[] };

/** The bridge options the page forwards so the text matches the drawing on screen. */
export type ArchitecturePlantUmlTextOptions = {
  readonly view?: ArchitectureDiagramView;
  readonly grouping?: 'raw' | 'adaptive';
  readonly idShape?: ArchitectureNodeIdShape;
};

/**
 * The explicit "there is no selection" answer the `+1` scope throws instead of
 * emitting an empty `@startuml … @enduml`. The page disables the option while
 * nothing is selected, so the error is a guard against a caller that skipped
 * that check, not a normal interaction.
 */
export class NoSelectionScopeError extends Error {
  readonly code = 'no-selection';

  constructor() {
    super('no-selection');
    this.name = 'NoSelectionScopeError';
  }
}

/** A drawn node's box, in the same coordinate space as the viewport box. */
export type ArchitectureTextRect = {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
};

/** The ids whose boxes intersect `viewport`; order follows the input (drawn order). */
export function nodesIntersectingViewport(
  nodes: Iterable<readonly [string, ArchitectureTextRect]>,
  viewport: ArchitectureTextRect,
): string[] {
  const ids: string[] = [];
  for (const [id, rect] of nodes) {
    // Half-open comparison: a zero-area box (jsdom, a hidden canvas) intersects
    // nothing, so a missing measurement never reads as "everything is visible".
    if (
      rect.right > viewport.left
      && rect.left < viewport.right
      && rect.bottom > viewport.top
      && rect.top < viewport.bottom
    ) {
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Expand the drawn ids the page read from the SVG into graph node ids.
 *
 * A drawn id is normally a graph node id. The file overview draws directory
 * scaffolding instead (`grp::src/modules/alpha`), which stands for every node in
 * that directory or below it — the same directory-only rule the adaptive
 * grouping uses, read through `directoryPathOf` so the two cannot disagree.
 */
function expandScopeNodeIds(
  graph: ArchitectureRendererGraph,
  nodeIds: readonly string[],
  idShape: ArchitectureNodeIdShape,
): ReadonlySet<string> {
  const kept = new Set<string>();
  const prefixes: string[] = [];
  for (const id of nodeIds) {
    if (id.startsWith(GROUP_ID_PREFIX)) prefixes.push(id.slice(GROUP_ID_PREFIX.length));
    else kept.add(id);
  }
  if (prefixes.length === 0) return kept;
  for (const node of graph.nodes) {
    if (kept.has(node.id)) continue;
    const directory = directoryPathOf(node.id, idShape);
    if (prefixes.some((prefix) => directory === prefix || directory.startsWith(`${prefix}/`))) {
      kept.add(node.id);
    }
  }
  return kept;
}

/** The selection's one-hop neighbourhood: the anchors plus every adjacent node. */
function expandSelectionNeighbourhood(
  graph: ArchitectureRendererGraph,
  anchors: readonly string[],
): ReadonlySet<string> {
  // One hop from the ANCHOR set, not a transitive closure: reading `kept` while
  // growing it would follow a second edge whenever it happens to come later in
  // the payload, making the scope depend on edge order.
  const anchorSet = new Set(anchors);
  const kept = new Set(anchorSet);
  for (const edge of graph.edges) {
    if (anchorSet.has(edge.from)) kept.add(edge.to);
    if (anchorSet.has(edge.to)) kept.add(edge.from);
  }
  return kept;
}

/** The induced subgraph over `kept`: every kept node and the edges between them. */
function inducedSubgraph(
  graph: ArchitectureRendererGraph,
  kept: ReadonlySet<string>,
): ArchitectureRendererGraph {
  return {
    nodes: graph.nodes.filter((node) => kept.has(node.id)),
    edges: graph.edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to)),
  };
}

/**
 * The subgraph one scope names. `full` is the graph exactly as handed over;
 * the other two are induced subgraphs over their own node set, so an edge is
 * kept only when both ends are in the text (an edge to a node outside the
 * scope would be an unresolved reference in the document).
 */
export function scopeSubgraph(
  graph: ArchitectureRendererGraph,
  scope: ArchitectureTextScope,
  idShape: ArchitectureNodeIdShape = DEFAULT_NODE_ID_SHAPE,
): ArchitectureRendererGraph {
  switch (scope.kind) {
    case 'full':
      return graph;
    case 'viewport':
      return inducedSubgraph(graph, expandScopeNodeIds(graph, scope.nodeIds, idShape));
    default: {
      if (scope.nodeIds.length === 0) throw new NoSelectionScopeError();
      return inducedSubgraph(graph, expandSelectionNeighbourhood(graph, scope.nodeIds));
    }
  }
}

/**
 * The PlantUML document for one scope of the drawing.
 *
 * Deterministic for a given (graph, scope, options): the bridge keeps the
 * graph's node order and sorts the package tree, and this function only picks a
 * subset, never re-sorts. That is what lets the page memoise it and a test
 * compare two calls.
 *
 * The `+1` scope with no anchors throws {@link NoSelectionScopeError}; every
 * other empty scope is an ordinary `@startuml\n@enduml` document.
 */
export function buildPlantUmlText(
  graph: ArchitectureRendererGraph,
  scope: ArchitectureTextScope,
  options: ArchitecturePlantUmlTextOptions = {},
): string {
  const subgraph = scopeSubgraph(graph, scope, options.idShape);
  return archguardToPlantUml(subgraph, {
    view: options.view ?? { kind: 'overview' },
    grouping: options.grouping ?? 'raw',
    idShape: options.idShape,
  }).puml;
}

/** The three bands the volume reading can fall in. */
export type ArchitectureTextVolumeLevel = 'normal' | 'large' | 'huge';

/** One document's size, as the page states it and gates its copy action on. */
export type ArchitectureTextVolume = {
  readonly characters: number;
  readonly lines: number;
  /** Estimated at {@link TEXT_CHARS_PER_TOKEN}; always shown with "approx.". */
  readonly tokens: number;
  readonly level: ArchitectureTextVolumeLevel;
};

/**
 * Measure one document: characters, lines and the estimated token count.
 *
 * The bands are the task's: below 8k tokens is normal, 8k–30k inclusive warns
 * (the reading gets the amber treatment), and ABOVE 30k asks before "copy as
 * session context". The page always permits copying — the huge band only adds
 * the explanation dialog.
 */
export function measurePlantUmlText(text: string): ArchitectureTextVolume {
  const characters = text.length;
  const lines = text === '' ? 0 : text.split('\n').length;
  const tokens = Math.round(characters / TEXT_CHARS_PER_TOKEN);
  const level: ArchitectureTextVolumeLevel = tokens > TEXT_HUGE_TOKEN_THRESHOLD
    ? 'huge'
    : tokens >= TEXT_LARGE_TOKEN_THRESHOLD
      ? 'large'
      : 'normal';
  return { characters, lines, tokens, level };
}

/** The first {@link TEXT_PREVIEW_LINE_LIMIT} lines, plus the reading that says so. */
export type ArchitectureTextPreview = {
  readonly text: string;
  readonly shownLines: number;
  readonly totalLines: number;
  readonly truncated: boolean;
};

/**
 * The preview the page renders into `<pre>`. Only the head of the document is
 * ever put in the DOM — the whole text stays in memory for copy/download, so a
 * 211k-character document cannot slow the tab down.
 */
export function previewPlantUmlText(
  text: string,
  limit: number = TEXT_PREVIEW_LINE_LIMIT,
): ArchitectureTextPreview {
  const lines = text.split('\n');
  const totalLines = lines.length;
  const shown = lines.slice(0, Math.max(0, limit));
  return {
    text: shown.join('\n'),
    shownLines: shown.length,
    totalLines,
    truncated: totalLines > shown.length,
  };
}

/**
 * The "copy as session context" payload: the caller's translated header, a blank
 * line, then the document in a `plantuml` fence. The header is composed by the
 * page because it needs i18n; this function owns only the fence so the exact
 * shape the chat receives has one definition.
 */
export function wrapSessionContext(header: string, puml: string): string {
  return `${header}\n\n\`\`\`plantuml\n${puml}\n\`\`\``;
}
