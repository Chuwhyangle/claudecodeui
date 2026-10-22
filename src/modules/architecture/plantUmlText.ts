import type { PlantUmlModel } from '@yalehwang/plantuml-js/elk';

import { DEFAULT_NODE_ID_SHAPE, directoryPathOf } from '@/modules/architecture/adaptiveGrouping';
import {
  archguardToPlantUml,
  type ArchitectureDiagramView,
} from '@/modules/architecture/archguardToPlantUml';
import type {
  ArchitectureDrawnPlantUml,
  ArchitectureNodeIdShape,
  ArchitectureRendererGraph,
} from '@/modules/architecture/rendererContract';

/**
 * The text page's pure half: turn one scope of the drawing into the PlantUML
 * document the panel shows, copies and downloads, plus the readings the page
 * puts beside it (volume, preview, syntax state).
 *
 * The document is the DRAWING when the renderer reports one:
 * {@link ArchitectureDrawnPlantUml} carries `renderDetailed(...).model` (the
 * model that was laid out and drawn, after view/transform/detail) plus the
 * upstream `toPlantUml`/`applyView`. The full scope serializes that model
 * verbatim; the viewport scope filters it to the nodes on screen; the `+1`
 * scope applies the upstream neighbourhood view. So aggregated edges and hub
 * folding — which only exist after the renderer's transforms — are in the text.
 *
 * Without a drawn model (a stand-in renderer, a page rendered in isolation) or
 * when the upstream functions are missing/throw, {@link buildPlantUmlDocument}
 * falls back to the local bridge (`archguardToPlantUml`) and says so, so the
 * page never goes blank.
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
   * Exactly the selected anchors: the entities the reader picked, or both ends
   * of every selected relation, with only the edges whose ends both survive.
   * The architecture selection tray's "selected only" scope.
   */
  | { readonly kind: 'selected'; readonly nodeIds: readonly string[] }
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
  /**
   * The model the renderer actually drew, when it reported one. Its presence
   * switches the document to the upstream serialization; its absence (or a
   * runtime failure) keeps the local bridge text and marks it as a fallback.
   */
  readonly drawn?: ArchitectureDrawnPlantUml | null;
};

/** One built document and where it came from. */
export type ArchitecturePlantUmlDocument = {
  readonly text: string;
  /**
   * True when the text is the local bridge's output rather than the drawn
   * model: the page then annotates it instead of pretending it is the drawing.
   */
  readonly fallback: boolean;
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
    case 'selected': {
      if (scope.nodeIds.length === 0) throw new NoSelectionScopeError();
      return inducedSubgraph(graph, new Set(scope.nodeIds));
    }
    default: {
      if (scope.nodeIds.length === 0) throw new NoSelectionScopeError();
      return inducedSubgraph(graph, expandSelectionNeighbourhood(graph, scope.nodeIds));
    }
  }
}

/**
 * The entity ids of the drawn model that belong in a viewport scope.
 *
 * The page reads drawn ids from the live SVG, so most of them ARE graph node
 * ids (the renderer swaps the bridge aliases back). An overview group id
 * (`grp::<directory>`) is drawn as one stub, so it resolves through the same
 * map directly; only an id with no drawn entity of its own is expanded to the
 * graph nodes under that directory (the pre-model behaviour).
 */
function drawnEntityIdsForViewport(
  graph: ArchitectureRendererGraph,
  drawn: ArchitectureDrawnPlantUml,
  nodeIds: readonly string[],
  idShape: ArchitectureNodeIdShape,
): ReadonlySet<string> {
  const drawnIds = new Set(drawn.model.entities.map((entity) => entity.id));
  const kept = new Set<string>();
  const unresolved: string[] = [];
  for (const id of nodeIds) {
    const entityId = drawn.entityIdOf.get(id);
    if (entityId !== undefined && drawnIds.has(entityId)) kept.add(entityId);
    else unresolved.push(id);
  }
  if (unresolved.length > 0) {
    for (const graphId of expandScopeNodeIds(graph, unresolved, idShape)) {
      const entityId = drawn.entityIdOf.get(graphId);
      if (entityId !== undefined && drawnIds.has(entityId)) kept.add(entityId);
    }
  }
  return kept;
}

/**
 * A drawn-model submodel over `entityIds`: the entities, the relations whose
 * both ends survive, and every declared package that still owns (or contains)
 * a surviving entity. The serializer emits every package it is handed, even an
 * empty one, so pruning here is what keeps a scoped document free of frames
 * the scope no longer covers.
 */
function filterDrawnModel(model: PlantUmlModel, entityIds: ReadonlySet<string>): PlantUmlModel {
  const entities = model.entities.filter((entity) => entityIds.has(entity.id));
  const packagesById = new Map(model.packages.map((pkg) => [pkg.id, pkg]));
  const packageIds = new Set<string>();
  for (const entity of entities) {
    let packageId = entity.packageId;
    while (packageId !== undefined && !packageIds.has(packageId)) {
      packageIds.add(packageId);
      packageId = packagesById.get(packageId)?.parentId;
    }
  }
  return {
    ...model,
    entities,
    relations: model.relations.filter(
      (relation) => entityIds.has(relation.source) && entityIds.has(relation.target),
    ),
    packages: model.packages.filter((pkg) => packageIds.has(pkg.id)),
  };
}

/** The drawn model one scope names. Throws when the scope cannot be expressed. */
function drawnModelForScope(
  graph: ArchitectureRendererGraph,
  scope: ArchitectureTextScope,
  drawn: ArchitectureDrawnPlantUml,
  idShape: ArchitectureNodeIdShape,
): PlantUmlModel {
  switch (scope.kind) {
    case 'full':
      return drawn.model;
    case 'viewport':
      return filterDrawnModel(
        drawn.model,
        drawnEntityIdsForViewport(graph, drawn, scope.nodeIds, idShape),
      );
    case 'selected': {
      if (scope.nodeIds.length === 0) throw new NoSelectionScopeError();
      const drawnIds = new Set(drawn.model.entities.map((entity) => entity.id));
      const entityIds = new Set<string>();
      for (const id of scope.nodeIds) {
        const entityId = drawn.entityIdOf.get(id);
        if (entityId !== undefined && drawnIds.has(entityId)) entityIds.add(entityId);
      }
      // No anchor is drawn (the current view folded every one into a stub): the
      // caller falls back to the bridge, which can still express the scope.
      if (entityIds.size === 0) throw new DrawnScopeUnavailableError();
      return filterDrawnModel(drawn.model, entityIds);
    }
    default: {
      if (scope.nodeIds.length === 0) throw new NoSelectionScopeError();
      const drawnIds = new Set(drawn.model.entities.map((entity) => entity.id));
      const anchors = scope.nodeIds
        .map((id) => drawn.entityIdOf.get(id))
        .filter((id): id is string => id !== undefined && drawnIds.has(id));
      // Every anchor is outside the drawn model (a graph node the current view
      // folded into a stub): the drawn model cannot express this scope, so the
      // caller falls back to the bridge for it.
      if (anchors.length === 0) throw new DrawnScopeUnavailableError();
      if (anchors.length === 1) {
        return drawn.applyView(drawn.model, { kind: 'neighborhood', entity: anchors[0], hops: 1 });
      }
      // Several selected items: the union of their one-hop neighbourhoods.
      const entityIds = new Set<string>();
      for (const anchor of anchors) {
        const neighbourhood = drawn.applyView(drawn.model, {
          kind: 'neighborhood',
          entity: anchor,
          hops: 1,
        });
        for (const entity of neighbourhood.entities) entityIds.add(entity.id);
      }
      return filterDrawnModel(drawn.model, entityIds);
    }
  }
}

/**
 * The drawn model cannot express this scope (none of its anchors is drawn).
 * Internal: {@link buildPlantUmlDocument} turns it into the bridge fallback.
 */
class DrawnScopeUnavailableError extends Error {
  constructor() {
    super('drawn-scope-unavailable');
    this.name = 'DrawnScopeUnavailableError';
  }
}

/** The local bridge's document for one scope; the fallback and the `graph` API. */
function bridgePlantUmlText(
  graph: ArchitectureRendererGraph,
  scope: ArchitectureTextScope,
  options: ArchitecturePlantUmlTextOptions,
): string {
  const subgraph = scopeSubgraph(graph, scope, options.idShape);
  return archguardToPlantUml(subgraph, {
    view: options.view ?? { kind: 'overview' },
    grouping: options.grouping ?? 'raw',
    idShape: options.idShape,
  }).puml;
}

/**
 * The PlantUML document for one scope of the drawing, plus whether it is the
 * drawn model or the bridge fallback.
 *
 * When a drawn model is supplied it is the source of truth: `toPlantUml` over
 * that model (full), over the viewport-filtered model, or over the upstream
 * neighbourhood view (`+1`). If the upstream serializer is missing at runtime
 * or throws, this falls back to {@link bridgePlantUmlText} and reports
 * `fallback: true` — the page annotates it rather than showing nothing.
 *
 * Deterministic for a given input: the upstream serializer is pure and the
 * bridge keeps the graph's order, so a test can compare two calls.
 *
 * The `+1` scope with no anchors throws {@link NoSelectionScopeError}; every
 * other empty scope is an ordinary `@startuml\n@enduml` document.
 */
export function buildPlantUmlDocument(
  graph: ArchitectureRendererGraph,
  scope: ArchitectureTextScope,
  options: ArchitecturePlantUmlTextOptions = {},
): ArchitecturePlantUmlDocument {
  if (options.drawn !== undefined && options.drawn !== null) {
    try {
      const model = drawnModelForScope(
        graph,
        scope,
        options.drawn,
        options.idShape ?? DEFAULT_NODE_ID_SHAPE,
      );
      const text = options.drawn.toPlantUml(model);
      // A missing/broken upstream serializer is a fallback, not a blank page.
      if (typeof text !== 'string') throw new Error('upstream-serializer-not-a-string');
      return { text, fallback: false };
    } catch (error) {
      if (error instanceof NoSelectionScopeError) throw error;
      // Any other failure (the function is absent at runtime, or threw) keeps
      // the page populated with the bridge text, marked as a fallback below.
    }
  }
  return {
    text: bridgePlantUmlText(graph, scope, options),
    fallback: true,
  };
}

/**
 * The PlantUML document for one scope of the drawing.
 *
 * The short form of {@link buildPlantUmlDocument} for callers that only need
 * the text (tests, and any page that does not annotate provenance). When
 * `options.drawn` is supplied the text is the drawn model's, exactly as
 * `toPlantUml(renderDetailed(...).model)` would serialize it.
 *
 * The `+1` scope with no anchors throws {@link NoSelectionScopeError}; every
 * other empty scope is an ordinary `@startuml\n@enduml` document.
 */
export function buildPlantUmlText(
  graph: ArchitectureRendererGraph,
  scope: ArchitectureTextScope,
  options: ArchitecturePlantUmlTextOptions = {},
): string {
  return buildPlantUmlDocument(graph, scope, options).text;
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
