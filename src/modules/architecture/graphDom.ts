// Every DOM read/write the renderer performs on the drawn SVG: id restoration,
// highlight and selection painting, annotations, the semantic rewrite, hit
// bands and marquee candidates. Pure geometry lives in `svgViewport.ts` /
// `semanticZoomPlan.ts`; this file is the layer that touches the document.
import { DEFAULT_NODE_ID_SHAPE } from '@/modules/architecture/adaptiveGrouping';
import {
  isSessionSeedNode,
  nodeFileOf,
  seedMarkerMode,
  type ArchitectureDiagramView,
  type ArchitecturePlantUml,
} from '@/modules/architecture/archguardToPlantUml';
import {
  type ReadableZoomHint,
  type ReadableZoomMode,
} from '@/modules/architecture/readableZoom';
import { clampAspectRatio, type ArchitectureLayoutEngine } from '@/modules/architecture/elkAspectEngine';
import {
  ENTITY_SELECTED_EVENT,
  GROUP_PREFIX,
  STUB_PREFIX,
  type EntitySelection,
} from '@/modules/architecture/graphConstants';
import {
  SEMANTIC_MONO,
  SEMANTIC_NODE_STYLE,
  SEMANTIC_PACKAGE_FILLS,
  SEMANTIC_SANS,
  SEMANTIC_SEED_COLOR,
} from '@/modules/architecture/graphStyles';
import type {
  ArchitectureDrawnPlantUml,
  ArchitectureNodeIdShape,
  ArchitectureRendererGraph,
} from '@/modules/architecture/rendererContract';
import {
  readSemanticDrawingGeometry,
  type SemanticEntityKind,
} from '@/modules/architecture/semanticZoomRead';
import {
  semanticCompartmentRules,
  type SemanticDrawingGeometry,
  type SemanticZoomLayout,
} from '@/modules/architecture/semanticZoomLayout';
import {
  PACKAGE_TAB_INSET_PX,
  placeStickyLabels,
  planHintPlacement,
  planRectsIntersect,
  planStickyLabels,
  type PlanPoint,
  type PlanRect,
} from '@/modules/architecture/semanticZoomPlan';
import type {
  ArchitectureBoxCandidate,
  ArchitectureSelectionRect,
} from '@/modules/architecture/selectionModel';
import {
  centerElementInContainer,
  readSvgNaturalSize,
  type SvgViewportSize,
} from '@/modules/architecture/svgViewport';

/**
 * The renderer options this component drives. Structural subsets of the
 * package's `RendererOptions` / `ViewSpec`, so the lazily imported module is
 * typed without importing its types into the first-screen chunk.
 */
export type PlantUmlView = { kind: 'neighborhood'; entity: string; hops: number };

/** The drawn model's type, without importing the package into this module's graph. */
export type PlantUmlDrawnModel = ArchitectureDrawnPlantUml['model'];

/**
 * `renderDetailed` returns the model that was actually laid out and drawn,
 * alongside the SVG — `model` is what the text page serializes, and `layout` is
 * the geometry the renderer used. `layout` takes the engine instance, not the
 * `'elk'` keyword: the engine is built by `createLayoutEngine` so the
 * container's aspect ratio reaches the layout (see `elkAspectEngine.ts`).
 */
export type PlantUmlRenderDetailed = (
  puml: string,
  options: { layout: ArchitectureLayoutEngine; view?: PlantUmlView },
) => Promise<{
  model: PlantUmlDrawnModel;
  layout: unknown;
  svg: string;
}>;

/** The upstream serializer and viewer, carried to the text page with the model. */
export type PlantUmlToPlantUml = (model: PlantUmlDrawnModel) => string;
export type PlantUmlApplyView = (
  model: PlantUmlDrawnModel,
  view: PlantUmlView,
) => PlantUmlDrawnModel;

export function reverseAliases(aliasOf: ReadonlyMap<string, string>): Map<string, string> {
  const idOf = new Map<string, string>();
  for (const [id, alias] of aliasOf) idOf.set(alias, id);
  return idOf;
}

/**
 * Rewrite the renderer's `data-*` ids from PlantUML aliases back to the
 * ArchGuard ids. The SVG is the renderer's own output and every attribute is
 * already XML-escaped there; here we only swap equal, escaped values, so the
 * decoded attribute values can be exchanged safely through the DOM.
 */
export function restoreEntityIds(host: HTMLElement, aliasOf: ReadonlyMap<string, string>): void {
  const idOf = reverseAliases(aliasOf);
  const rename = (element: Element, attribute: string): void => {
    const value = element.getAttribute(attribute);
    if (value === null) return;
    const id = idOf.get(value);
    if (id !== undefined) element.setAttribute(attribute, id);
  };
  for (const node of host.querySelectorAll('[data-entity-id]')) rename(node, 'data-entity-id');
  for (const edge of host.querySelectorAll('[data-edge-source]')) rename(edge, 'data-edge-source');
  for (const edge of host.querySelectorAll('[data-edge-target]')) rename(edge, 'data-edge-target');
}

/**
 * Whether the graph on screen is the ENTITY (class) graph.
 *
 * The panel hands the entity subgraph over with `scope-prefixed` ids and the
 * file subgraph with `project-relative` ones (see `ArchitectureNodeIdShape`),
 * so the shape is the discriminator at the renderer boundary. A renderer given
 * no `idShape` defaults to the entity scheme, which matches the bridge's raw
 * contract.
 */
export function isEntityGraph(idShape: ArchitectureNodeIdShape): boolean {
  return idShape === DEFAULT_NODE_ID_SHAPE;
}

/**
 * The view a drawing opens at. The class view opens on the hierarchy, i.e. the
 * entities themselves inside their package frames: folding them into
 * `grp::` directory boxes is the FILE overview's job, and doing it to a class
 * diagram replaced every class the reader asked for with a directory count.
 * The file view keeps the directory-grouped overview.
 */
export function defaultViewOf(idShape: ArchitectureNodeIdShape): ArchitectureDiagramView {
  return isEntityGraph(idShape) ? { kind: 'hierarchy' } : { kind: 'overview' };
}

/**
 * The renderer options for one view. The file overview and group views are
 * already collapsed by the bridge (directory-only adaptive grouping), so only
 * the neighbourhood view asks the renderer to slice the model.
 */
export function rendererOptionsFor(
  view: ArchitectureDiagramView,
  diagram: ArchitecturePlantUml,
  layout: ArchitectureLayoutEngine,
): { layout: ArchitectureLayoutEngine; view?: PlantUmlView } {
  if (view.kind === 'neighborhood' && diagram.rendererEntity !== null) {
    return {
      layout,
      view: { kind: 'neighborhood', entity: diagram.rendererEntity, hops: view.hops },
    };
  }
  return { layout };
}

/**
 * The container's width/height, clamped by `clampAspectRatio`, or `null` when
 * it has no box yet (jsdom, or a first paint before layout). Measured from the
 * scroll container itself — the element the drawing is actually fitted into.
 */
export function measureLayoutAspect(host: HTMLElement): number | null {
  const width = host.clientWidth;
  const height = host.clientHeight;
  if (!(width > 0) || !(height > 0)) return null;
  return clampAspectRatio(width / height);
}

/** A drawing's identity: the view (with its parameters) that produced it. */
export function drawingKeyOf(view: ArchitectureDiagramView): string {
  switch (view.kind) {
    case 'overview':
      return 'overview';
    case 'group':
      return `group:${view.prefix}`;
    case 'neighborhood':
      return `neighborhood:${view.entityId}:${view.hops}`;
    case 'hierarchy':
      return 'hierarchy';
  }
}

/** The readable default currently applied: mode, focus target and overview hint. */
export type ReadableView = {
  readonly mode: ReadableZoomMode;
  readonly focusPackageId: string | null;
  readonly hint: ReadableZoomHint | null;
};

/** Normalise a drawn package id the way the hierarchy index does, for comparison. */
export function normalizeDrawnPackageId(raw: string | null): string {
  if (raw === null) return '';
  return raw.trim().split('/').filter(Boolean).join('/');
}

/**
 * The element a focus jump should centre. Package frames are the first choice
 * (explosion/neighbourhood views draw them); the grouped overview instead draws
 * `grp::<prefix>` nodes, so the deepest drawn prefix that contains the package
 * is the group the reader should see. `null` when the drawing shows neither.
 */
export function focusElementFor(host: HTMLElement, packageId: string): Element | null {
  const wanted = normalizeDrawnPackageId(packageId);
  if (wanted === '') return null;
  for (const frame of host.querySelectorAll('.uml-package[data-package-id]')) {
    if (normalizeDrawnPackageId(frame.getAttribute('data-package-id')) === wanted) return frame;
  }
  let best: Element | null = null;
  let bestLength = -1;
  for (const node of host.querySelectorAll('[data-entity-id^="grp::"]')) {
    const prefix = normalizeDrawnPackageId(
      (node.getAttribute('data-entity-id') ?? '').slice(GROUP_PREFIX.length),
    );
    if (prefix === '' || (wanted !== prefix && !wanted.startsWith(`${prefix}/`))) continue;
    if (prefix.length > bestLength) {
      best = node;
      bestLength = prefix.length;
    }
  }
  return best;
}

/** Centre the package focus mode selected, through the shared viewport entry. */
export function centerOnPackage(host: HTMLElement, packageId: string): void {
  const target = focusElementFor(host, packageId);
  if (target !== null) centerElementInContainer(host, target);
}

/**
 * Hide every edge relation label the renderer drew. The label is still in the
 * DOM (the SVG structure is the renderer's contract); only its visibility is
 * toggled, which is why a hover never re-lays the drawing out.
 */
export function hideEdgeLabels(host: HTMLElement): void {
  for (const label of host.querySelectorAll('.uml-edge text')) {
    label.setAttribute('display', 'none');
  }
}

/** Reveal the labels of the edges the highlight marked (and only those). */
export function showHighlightedEdgeLabels(host: HTMLElement): void {
  for (const edge of host.querySelectorAll('.arch-hl-in, .arch-hl-out')) {
    for (const label of edge.querySelectorAll('text')) label.removeAttribute('display');
  }
}

/** Remove every highlight class the hover interaction may have added. */
export function clearHighlight(host: HTMLElement): void {
  for (const element of host.querySelectorAll('.arch-dim, .arch-hl-in, .arch-hl-out')) {
    element.classList.remove('arch-dim', 'arch-hl-in', 'arch-hl-out');
  }
  hideEdgeLabels(host);
}

/**
 * Dim everything except the hovered node and its one-hop neighbourhood, and
 * mark its outgoing (`arch-hl-out`) and incoming (`arch-hl-in`) edges. The
 * marked edges are also the only ones whose relation label becomes visible.
 */
export function highlightRelations(host: HTMLElement, id: string): void {
  clearHighlight(host);
  const neighbours = new Set<string>([id]);
  const highlighted: Element[] = [];
  const dimmed: Element[] = [];
  for (const edge of host.querySelectorAll('.uml-edge')) {
    const from = edge.getAttribute('data-edge-source');
    const to = edge.getAttribute('data-edge-target');
    if (from === id) {
      edge.classList.add('arch-hl-out');
      highlighted.push(edge);
      if (to !== null) neighbours.add(to);
    } else if (to === id) {
      edge.classList.add('arch-hl-in');
      highlighted.push(edge);
      if (from !== null) neighbours.add(from);
    } else {
      dimmed.push(edge);
    }
  }
  // A node whose relations were all filtered away (e.g. a function whose call
  // edges are hidden) has NOTHING to highlight. Dimming the rest of the drawing
  // in that state painted the whole graph translucent with no reading to
  // compensate — so the dim is only applied alongside at least one highlighted
  // relation.
  if (highlighted.length === 0) return;
  for (const edge of dimmed) edge.classList.add('arch-dim');
  for (const node of host.querySelectorAll('.uml-node')) {
    const nodeId = node.getAttribute('data-entity-id');
    if (nodeId !== null && !neighbours.has(nodeId)) node.classList.add('arch-dim');
  }
  showHighlightedEdgeLabels(host);
}

/**
 * Pin a SELECTED relation: dim everything except the two endpoints and that
 * one edge, and reveal the edge's own type label. Used by the click handler
 * (immediate feedback) and restored after a redraw by the selection effect.
 */
export function highlightEdge(host: HTMLElement, edge: Element | null): void {
  clearHighlight(host);
  if (edge === null) return;
  const from = edge.getAttribute('data-edge-source');
  const to = edge.getAttribute('data-edge-target');
  const keep = new Set<string>([from, to].filter((id): id is string => id !== null));
  for (const other of host.querySelectorAll('.uml-edge')) {
    if (other === edge) other.classList.add('arch-hl-out');
    else other.classList.add('arch-dim');
  }
  for (const node of host.querySelectorAll('.uml-node')) {
    const id = node.getAttribute('data-entity-id');
    if (id !== null && !keep.has(id)) node.classList.add('arch-dim');
  }
  for (const label of edge.querySelectorAll('text')) label.removeAttribute('display');
}

/** A drawn node rect's own coordinates, as the renderer emits them. */
export type MarkerRect = {
  readonly x: number;
  readonly y: number;
};

/**
 * The SVG point `dx`/`dy` inside a node's own rect.
 *
 * The renderer draws each node's `rect` in ABSOLUTE SVG coordinates — the
 * enclosing `<g class="uml-node">` carries no `translate` — so a marker written
 * at a fixed `(4,4)` lands on the canvas origin for every node instead of on the
 * node it annotates. Anchoring the marker to the rect keeps each marker on its
 * own box and keeps the drawing's bounding box unchanged. Used by the seed dot
 * and the pin badge in {@link annotateNodes}; exported so the geometry can be
 * tested without a layout pass.
 */
export function markerAnchor(
  rect: MarkerRect | null | undefined,
  dx: number,
  dy: number,
): { readonly x: number; readonly y: number } {
  const x = rect === null || rect === undefined ? 0 : rect.x;
  const y = rect === null || rect === undefined ? 0 : rect.y;
  return {
    x: (Number.isFinite(x) ? x : 0) + dx,
    y: (Number.isFinite(y) ? y : 0) + dy,
  };
}

/**
 * The first `rect` a node group draws, read as the node's own geometry.
 *
 * `applySelectionStyles` already reads the same rect for its check badge, so
 * every node-anchored decoration agrees on which rectangle is the box.
 */
export function nodeRectOf(element: Element): MarkerRect | null {
  const rect = element.querySelector('rect');
  if (rect === null) return null;
  return {
    x: Number(rect.getAttribute('x') ?? '0'),
    y: Number(rect.getAttribute('y') ?? '0'),
  };
}

/**
 * Annotate the freshly drawn SVG with the two readings the node boxes no longer
 * carry themselves:
 *  · the hover `<title>` names the FILE the entity lives in — the box label is
 *    the bare entity name, so the path has to live somewhere the pointer can
 *    reveal it;
 *  · a DIRECT session mention gets the seed marker attribute + class, which the
 *    stylesheet turns into a thicker frame (see HIGHLIGHT_STYLE) — or the light
 *    frame + dot when seeds are the majority of the drawn entities.
 * View scaffolding (group and stub nodes) is not an entity and is skipped.
 */
export function annotateNodes(
  host: HTMLElement,
  graph: ArchitectureRendererGraph,
  idShape: ArchitectureNodeIdShape,
): void {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  // One reading for the whole drawing: a marker that covered most of the boxes
  // would stop distinguishing anything, so it degrades to its light form (thin
  // frame + dot) once seeds are at least half the drawn entities.
  const seedMode = seedMarkerMode(graph.nodes);
  for (const element of host.querySelectorAll('.uml-node[data-entity-id]')) {
    const id = element.getAttribute('data-entity-id');
    if (id === null) continue;
    const node = byId.get(id);
    if (node === undefined) continue;
    const file = nodeFileOf(node, idShape);
    if (file !== '') {
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = file;
      element.insertBefore(title, element.firstChild);
    }
    // The seed reading itself is the shared predicate (`isSessionSeedNode`), so
    // old payloads keep `distance === 0` and only a direct mention is a seed.
    if (isSessionSeedNode(node)) {
      if (seedMode === 'light') {
        // A DOM-shape reading, not colour alone: a small dot beside the label
        // plus the thin frame from the stylesheet. The dot is anchored to THIS
        // node's rect (see `markerAnchor`) — a fixed (4,4) is the SVG origin.
        element.setAttribute('data-architecture-seed', 'light');
        element.classList.add('arch-seed-light');
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('class', 'arch-seed-dot');
        dot.setAttribute('data-architecture-seed-dot', 'true');
        const dotAnchor = markerAnchor(nodeRectOf(element), 4, 4);
        dot.setAttribute('cx', String(dotAnchor.x));
        dot.setAttribute('cy', String(dotAnchor.y));
        dot.setAttribute('r', '2.5');
        element.insertBefore(dot, element.firstChild);
      } else {
        element.setAttribute('data-architecture-seed', 'true');
        element.classList.add('arch-seed');
      }
    }
    // A manual pin is not a session seed: it gets its own marker and a literal
    // pin glyph, so the reading never depends on colour alone.
    if (node.mentionTier === 'pinned') {
      element.setAttribute('data-architecture-pinned', 'true');
      element.classList.add('arch-pinned');
      const badge = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      badge.setAttribute('class', 'arch-pinned-badge');
      badge.setAttribute('data-architecture-pinned-badge', 'true');
      // Same absolute-coordinate rule as the seed dot: a fixed (4,12) would
      // paint every pin glyph at the canvas origin.
      const badgeAnchor = markerAnchor(nodeRectOf(element), 4, 12);
      badge.setAttribute('x', String(badgeAnchor.x));
      badge.setAttribute('y', String(badgeAnchor.y));
      badge.setAttribute('font-size', '11');
      badge.textContent = '📌';
      element.insertBefore(badge, element.firstChild);
    }
  }
}

/**
 * The entity's dependency direction, read from the neighbourhood JSON already in
 * hand rather than from the drawn SVG: the SVG is only the visible slice, while
 * the payload is what a sibling panel is told about.
 */
export function selectionOf(graph: ArchitectureRendererGraph, id: string): EntitySelection {
  const incoming: string[] = [];
  const outgoing: string[] = [];
  for (const edge of graph.edges) {
    if (edge.to === id) incoming.push(edge.from);
    if (edge.from === id) outgoing.push(edge.to);
  }
  return { id, incoming, outgoing };
}

/**
 * Announce a click to sibling panels. Guarded because the renderer is mounted
 * in jsdom tests too, where `window` is present, and in a future non-browser
 * render there would simply be no listener to notify.
 */
export function announceSelection(graph: ArchitectureRendererGraph, id: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<EntitySelection>(ENTITY_SELECTED_EVENT, {
    detail: selectionOf(graph, id),
  }));
}

/**
 * Re-apply the selected entity's highlight after a render, and clear it when the
 * selection is not part of the view that was just drawn (a group view can hide
 * the entity a previous neighbourhood selection named).
 */
export function highlightSelection(host: HTMLElement, id: string | null): void {
  if (id === null || nodeElement(host, id) === null) {
    clearHighlight(host);
    return;
  }
  highlightRelations(host, id);
}

/** The relation kinds on the hovered node's VISIBLE edges, read from what was actually drawn. */
export function relationsOf(host: HTMLElement, id: string): string[] {
  const relations = new Set<string>();
  for (const edge of host.querySelectorAll('.uml-edge')) {
    if (edge.getAttribute('data-edge-source') !== id && edge.getAttribute('data-edge-target') !== id) continue;
    const type = edge.getAttribute('data-edge-type');
    if (type !== null) relations.add(type);
  }
  return [...relations].sort();
}

/** The drawn node carrying `id`, without relying on `CSS.escape` (absent in jsdom). */
export function nodeElement(host: HTMLElement, id: string): Element | null {
  for (const node of host.querySelectorAll('.uml-node')) {
    if (node.getAttribute('data-entity-id') === id) return node;
  }
  return null;
}

/**
 * Enlarge every relation's clickable band WITHOUT touching the renderer's
 * `data-edge-*` contract: each drawn edge gets one extra transparent stroke
 * path with the same geometry, 12 CSS px wide on a fine pointer and 44 on a
 * coarse one. The clone carries `data-architecture-edge-*` names instead of the
 * `data-edge-*` ones, so every existing reading (drawn-edge counts, hover
 * highlights) keeps seeing exactly one element per relation.
 */
export function addEdgeHitTargets(host: HTMLElement, coarsePointer: boolean): void {
  const width = coarsePointer ? 44 : 12;
  for (const edge of host.querySelectorAll('.uml-edge')) {
    const source = edge.getAttribute('data-edge-source');
    const target = edge.getAttribute('data-edge-target');
    if (source === null || target === null) continue;
    // The renderer draws the line as the edge's first path; the arrow is a
    // separate polygon and needs no hit band of its own.
    const line = edge.querySelector('path');
    if (line === null) continue;
    const hit = line.cloneNode(false) as SVGPathElement;
    hit.removeAttribute('class');
    hit.setAttribute('class', 'arch-edge-hit');
    hit.setAttribute('data-architecture-edge-hit', 'true');
    hit.setAttribute('data-architecture-edge-source', source);
    hit.setAttribute('data-architecture-edge-target', target);
    hit.setAttribute('data-architecture-edge-type', edge.getAttribute('data-edge-type') ?? '');
    hit.setAttribute('fill', 'none');
    hit.setAttribute('stroke', 'transparent');
    hit.setAttribute('stroke-width', String(width));
    hit.setAttribute('vector-effect', 'non-scaling-stroke');
    hit.setAttribute('pointer-events', 'stroke');
    edge.appendChild(hit);
  }
}

/**
 * Mark the freshly injected drawing unselectable, inline.
 *
 * The injected {@link CANVAS_UNSELECTABLE_STYLE} rule already covers the host,
 * the `svg` and every label, but two things need the inline declaration too: a
 * browser that only honours `user-select` on HTML (not on SVG text) would still
 * start a drag-selection on a node label, and the component tests read the
 * inline value because jsdom's computed style drops properties it does not
 * know. Called after EVERY DOM addition on the drawing (labels, badges, hit
 * bands), so no node the renderer appends later is left selectable.
 */
export function markDrawingUnselectable(host: HTMLElement): void {
  host.style.userSelect = 'none';
  const drawing = host.querySelector('svg');
  if (drawing === null) return;
  drawing.style.userSelect = 'none';
  for (const label of drawing.querySelectorAll('text, tspan')) {
    if (label instanceof SVGElement) label.style.userSelect = 'none';
  }
}

/**
 * One drawing captured for semantic zoom.
 *
 * `inner` is the annotated SVG BEFORE any semantic rewrite (labels hidden,
 * entity ids restored, seed markers added, edge hit bands present). Every
 * application restores it first, so rewriting is idempotent and the ≥ 90 %
 * view is the renderer's own drawing times the scale. `geometry` holds the
 * same rectangles read in user units; the engine never reads a rewritten DOM.
 */
export type SemanticCapture = {
  readonly svg: SVGSVGElement;
  readonly inner: string;
  readonly geometry: SemanticDrawingGeometry;
  readonly baseSize: SvgViewportSize;
  readonly titles: ReadonlyMap<string, string | null>;
};

/** Capture the drawing that was just injected. */
export function captureSemanticDrawing(
  host: HTMLElement,
  graph: ArchitectureRendererGraph,
): SemanticCapture | null {
  const svg = host.querySelector('svg');
  if (!(svg instanceof SVGSVGElement)) return null;
  // 0.4.0 publishes compartments but not the entity KIND (function vs class)
  // and its member parser calls a field whose type contains `(` a method, so
  // the payload's authoritative kinds are handed to the read layer as hints.
  const kindById = new Map<string, SemanticEntityKind>(graph.nodes.map((node) => {
    const kind = node.kind;
    const mapped: SemanticEntityKind = kind === 'interface' || kind === 'enum' || kind === 'function'
      ? kind
      : 'class';
    return [node.id, mapped];
  }));
  const memberKindsById = new Map<string, readonly ('field' | 'method')[]>(
    graph.nodes
      .filter((node) => (node.members?.length ?? 0) > 0)
      .map((node) => [
        node.id,
        (node.members ?? []).map((member) => (member.kind === 'method' ? 'method' : 'field')),
      ]),
  );
  const geometry = readSemanticDrawingGeometry(svg, { kindById, memberKindsById });
  const titles = new Map<string, string | null>();
  for (const node of svg.querySelectorAll('.uml-node[data-entity-id]')) {
    const id = node.getAttribute('data-entity-id');
    if (id === null) continue;
    const title = [...node.children].find((child) => child.tagName.toLowerCase() === 'title');
    titles.set(id, title?.textContent ?? null);
  }
  const baseSize = readSvgNaturalSize(svg) ?? { width: geometry.width, height: geometry.height };
  return { svg, inner: svg.innerHTML, geometry, baseSize, titles };
}

/** Create an SVG element with presentation attributes. */
export function svgElement<K extends keyof SVGElementTagNameMap>(
  name: K,
  attributes: Record<string, string | number>,
  parent: Element,
): SVGElementTagNameMap[K] {
  const element = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  parent.appendChild(element);
  return element;
}

/** Rewrite a path's coordinate pairs through `map`, pinning its two ends. */
export function rewritePathData(
  d: string,
  map: (x: number, y: number) => PlanPoint,
  ends: { readonly first: PlanPoint | null; readonly last: PlanPoint | null },
): string {
  const pairs = [...d.matchAll(/(-?\d*\.?\d+(?:e[-+]?\d+)?)[\s,]+(-?\d*\.?\d+(?:e[-+]?\d+)?)/gi)];
  let index = 0;
  return d.replace(
    /(-?\d*\.?\d+(?:e[-+]?\d+)?)[\s,]+(-?\d*\.?\d+(?:e[-+]?\d+)?)/gi,
    (_match, x: string, y: string) => {
      let point = map(Number(x), Number(y));
      if (index === 0 && ends.first !== null) point = ends.first;
      else if (index === pairs.length - 1 && ends.last !== null) point = ends.last;
      index += 1;
      return `${point.x.toFixed(1)},${point.y.toFixed(1)}`;
    },
  );
}


/**
 * Draw one semantic layout over the captured drawing.
 *
 * Every element the renderer emitted is rewritten in place and keeps its
 * contract attributes (`data-entity-id`, `data-package-id`, `data-edge-source`,
 * `data-edge-target`); only the geometry and the text plan change. The SVG is
 * then sized 1:1 for the mapped layout, which is what lets the minimum font
 * size be a real screen reading instead of a CSS-scaled one.
 */
export function drawSemanticLayout(
  host: HTMLElement,
  capture: SemanticCapture,
  layout: SemanticZoomLayout,
  fontPx: number,
): void {
  const svg = capture.svg;
  // Restoring the annotated drawing first makes every application independent
  // of the previous one (and keeps the ≥ 90 % view byte-identical to the
  // renderer's own output).
  svg.innerHTML = capture.inner;
  const offsetX = -layout.content.x;
  const offsetY = -layout.content.y;
  const width = Math.max(1, Math.ceil(layout.content.width));
  const height = Math.max(1, Math.ceil(layout.content.height));
  const mapPoint = (x: number, y: number): PlanPoint => ({
    x: layout.x.map(x) + offsetX,
    y: layout.y.map(y) + offsetY,
  });

  // The canvas background follows the mapped extent.
  const canvas = svg.querySelector('.uml-canvas');
  if (canvas !== null) {
    canvas.setAttribute('width', String(width));
    canvas.setAttribute('height', String(height));
  }

  // ---- edges (mapped first; the class boxes are drawn on top of them)
  for (const group of svg.querySelectorAll('.uml-edge[data-edge-source]')) {
    if (layout.tier === 'C') {
      // Tier C draws packages only: the entity relations are hidden, not left
      // mapped at their old coordinates.
      (group as SVGGElement).style.display = 'none';
      continue;
    }
    (group as SVGGElement).style.display = '';
    const edge = layout.edges.find(
      (candidate) => candidate.source === group.getAttribute('data-edge-source')
        && candidate.target === group.getAttribute('data-edge-target'),
    );
    const ends = edge === undefined
      ? { first: null, last: null }
      : {
          // The engine works in absolute mapped units; the drawing is
          // translated so its content starts at the origin. The endpoints must
          // get that same translation as every other mapped point.
          first: edge.points[0] === undefined
            ? null
            : { x: edge.points[0].x + offsetX, y: edge.points[0].y + offsetY },
          last: edge.points[edge.points.length - 1] === undefined
            ? null
            : {
                x: edge.points[edge.points.length - 1].x + offsetX,
                y: edge.points[edge.points.length - 1].y + offsetY,
              },
        };
    for (const path of group.querySelectorAll('path')) {
      const d = path.getAttribute('d');
      if (d !== null) path.setAttribute('d', rewritePathData(d, mapPoint, ends));
    }
    for (const polygon of group.querySelectorAll('polygon')) {
      const points = (polygon.getAttribute('points') ?? '')
        .trim()
        .split(/\s+/)
        .map((pair) => pair.split(',').map(Number))
        .filter((pair) => pair.length === 2 && Number.isFinite(pair[0]) && Number.isFinite(pair[1]));
      if (points.length === 0) continue;
      // The marker keeps its drawn SIZE and is translated so its vertex nearest
      // the line's end lands exactly on that end (which the engine snapped onto
      // the frame). This is what keeps the arrowhead attached to the line at
      // every tier, including a compacted one.
      const centroid = {
        x: points.reduce((total, point) => total + point[0], 0) / points.length,
        y: points.reduce((total, point) => total + point[1], 0) / points.length,
      };
      const mappedCentroid = mapPoint(centroid.x, centroid.y);
      const toTarget = ends.last !== null
        && (Math.hypot(mappedCentroid.x - ends.last.x, mappedCentroid.y - ends.last.y)
          <= Math.hypot(
            mappedCentroid.x - (ends.first?.x ?? mappedCentroid.x),
            mappedCentroid.y - (ends.first?.y ?? mappedCentroid.y),
          ));
      const reference = toTarget ? ends.last : ends.first;
      let dx = 0;
      let dy = 0;
      if (reference !== null) {
        let nearest = mapPoint(points[0][0], points[0][1]);
        let best = Math.hypot(nearest.x - reference.x, nearest.y - reference.y);
        for (const point of points) {
          const mapped = mapPoint(point[0], point[1]);
          const distance = Math.hypot(mapped.x - reference.x, mapped.y - reference.y);
          if (distance < best) {
            best = distance;
            nearest = mapped;
          }
        }
        dx = reference.x - nearest.x;
        dy = reference.y - nearest.y;
      }
      polygon.setAttribute('points', points
        .map((point) => {
          const mapped = mapPoint(point[0], point[1]);
          return `${(mapped.x + dx).toFixed(1)},${(mapped.y + dy).toFixed(1)}`;
        })
        .join(' '));
    }
    for (const text of group.querySelectorAll('text')) {
      const x = Number(text.getAttribute('x'));
      const y = Number(text.getAttribute('y'));
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const mapped = mapPoint(x, y);
      text.setAttribute('x', mapped.x.toFixed(1));
      text.setAttribute('y', mapped.y.toFixed(1));
    }
    if (edge !== undefined) {
      (group as SVGGElement).style.opacity = String(edge.opacity);
    }
  }

  // ---- package frames + tabs
  for (const packageLayout of layout.packages) {
    const group = [...svg.querySelectorAll('.uml-package[data-package-id]')].find(
      (candidate) => candidate.getAttribute('data-package-id') === packageLayout.id,
    );
    if (group === undefined) continue;
    while (group.firstChild !== null) group.removeChild(group.firstChild);
    const frame = packageLayout.frame;
    const x = frame.x + offsetX;
    const y = frame.y + offsetY;
    const w = Math.max(0, frame.width);
    const h = Math.max(0, frame.height);
    svgElement('rect', {
      x,
      y,
      width: w,
      height: h,
      rx: 3,
      fill: SEMANTIC_PACKAGE_FILLS[Math.min(packageLayout.depth, SEMANTIC_PACKAGE_FILLS.length - 1)],
      stroke: '#94a3b8',
      'stroke-width': 1,
    }, group);
    if (packageLayout.tabRect === null) continue;
    const tabX = x + PACKAGE_TAB_INSET_PX - 1;
    const tabTop = y;
    const tabWidth = packageLayout.tab.width;
    const tabHeight = packageLayout.tab.height;
    // The tab is a complete little rectangle closed on its right side: top
    // edge, right cap and underline. It is what makes a package frame read as
    // UML rather than as a plain box.
    svgElement('path', {
      d: `M${tabX.toFixed(1)},${tabTop.toFixed(1)} H${(tabX + tabWidth).toFixed(1)}`
        + ` V${(tabTop + tabHeight).toFixed(1)} H${tabX.toFixed(1)}`,
      fill: 'none',
      stroke: '#94a3b8',
      'stroke-width': 1,
    }, group);
    const label = svgElement('text', {
      x: tabX + 3,
      y: tabTop + tabHeight / 2 + fontPx * 0.36,
      'font-family': SEMANTIC_SANS,
      'font-size': fontPx,
      'font-weight': 600,
      fill: '#334155',
    }, group);
    label.textContent = packageLayout.tab.text;
    if (packageLayout.tab.badge !== '') {
      const badge = svgElement('tspan', { fill: SEMANTIC_SEED_COLOR }, label);
      badge.textContent = packageLayout.tab.badge;
    }
  }

  // ---- class boxes
  const lineHeight = fontPx * 1.25;
  const drawnNodeIds = new Set(layout.nodes.map((node) => node.id));
  // Tier C draws no class box at all: the entity groups must be hidden, not
  // merely left out of the draw loop.
  for (const group of svg.querySelectorAll('.uml-node[data-entity-id]')) {
    const id = group.getAttribute('data-entity-id') ?? '';
    if (!drawnNodeIds.has(id)) (group as SVGGElement).style.display = 'none';
  }
  for (const nodeLayout of layout.nodes) {
    const group = [...svg.querySelectorAll('.uml-node[data-entity-id]')].find(
      (candidate) => candidate.getAttribute('data-entity-id') === nodeLayout.id,
    );
    if (group === undefined) continue;
    if (nodeLayout.hidden) {
      (group as SVGGElement).style.display = 'none';
      continue;
    }
    (group as SVGGElement).style.display = '';
    while (group.firstChild !== null) group.removeChild(group.firstChild);
    const drawn = nodeLayout.drawn;
    const x = drawn.x + offsetX;
    const y = drawn.y + offsetY;
    const w = Math.max(0, drawn.width);
    const h = Math.max(0, drawn.height);
    const style = SEMANTIC_NODE_STYLE[nodeLayout.plan.kind] ?? SEMANTIC_NODE_STYLE.class;
    const title = capture.titles.get(nodeLayout.id);
    if (title !== null && title !== undefined) {
      const titleElement = svgElement('title', {}, group);
      titleElement.textContent = title;
    }
    const seed = capture.geometry.nodes.find((node) => node.id === nodeLayout.id)?.seed === true;
    svgElement('rect', {
      x,
      y,
      width: w,
      height: h,
      rx: 2,
      fill: seed ? '#fff7ed' : style[0],
      stroke: seed ? SEMANTIC_SEED_COLOR : style[1],
      'stroke-width': seed ? 2 : 1,
    }, group);
    // UML form never degrades: the compartment rules are drawn even when the
    // member text is hidden, and an operations-only interface keeps one.
    for (const rule of semanticCompartmentRules(nodeLayout)) {
      svgElement('line', {
        x1: x,
        x2: x + w,
        y1: y + rule,
        y2: y + rule,
        stroke: seed ? SEMANTIC_SEED_COLOR : style[1],
        'stroke-width': 1,
      }, group);
    }
    if (nodeLayout.showName) {
      const lines = nodeLayout.plan.name.lines;
      const centreX = x + w / 2;
      const stereotypeHeight = nodeLayout.plan.stereotype === null ? 0 : fontPx;
      if (nodeLayout.plan.stereotype !== null) {
        // The stereotype is drawn at the SAME floor font as every other visible
        // label: the old 0.8× drew 8px on the PC tier, under the 10px floor.
        // The plan already grew the title compartment by a full line for it.
        const stereotype = svgElement('text', {
          x: centreX,
          y: y + fontPx * 0.85,
          'text-anchor': 'middle',
          'font-family': SEMANTIC_SANS,
          'font-size': fontPx,
          'font-style': 'italic',
          'data-architecture-node-stereotype': 'true',
          fill: '#475569',
        }, group);
        stereotype.textContent = `<<${nodeLayout.plan.stereotype}>>`;
      }
      const baseY = y + nodeLayout.drawnTitleHeight / 2 - (lines.length * lineHeight) / 2
        + fontPx * 0.9 + stereotypeHeight / 2;
      lines.forEach((line, index) => {
        const text = svgElement('text', {
          x: centreX,
          y: baseY + index * lineHeight,
          'text-anchor': 'middle',
          'font-family': SEMANTIC_MONO,
          'font-size': fontPx,
          'font-weight': 700,
          'font-style': nodeLayout.plan.kind === 'interface' ? 'italic' : 'normal',
          'data-architecture-node-name': 'true',
          // The full label, so a reading can tell a wrapped/ellipsized name
          // from one that lost its title to a decoration.
          'data-architecture-label': nodeLayout.plan.name.label,
          fill: nodeLayout.plan.kind === 'interface' ? '#075985' : '#1e293b',
        }, group);
        text.textContent = line;
      });
    }
    if (nodeLayout.showMembers && nodeLayout.memberRows !== null) {
      const rows = nodeLayout.memberRows;
      // The operations block starts BELOW the member-positioned rule, so the
      // rule can never cut through a row (the proportional rule did).
      const split = semanticCompartmentRules(nodeLayout);
      const splitY = split.length > 1 ? split[1] : null;
      let attrIndex = 0;
      let opIndex = 0;
      rows.rows.forEach((row, index) => {
        const inAttributes = index < rows.attrCount;
        const baseline = y + (inAttributes
          ? nodeLayout.drawnTitleHeight + (attrIndex + 1) * lineHeight - 2
          : (splitY ?? nodeLayout.drawnTitleHeight) + (opIndex + 1) * lineHeight - 2);
        const text = svgElement('text', {
          x: x + 5,
          y: baseline,
          'font-family': SEMANTIC_MONO,
          'font-size': fontPx,
          'data-architecture-node-member': 'true',
          'data-architecture-member-compartment': inAttributes ? 'attr' : 'op',
          fill: '#475569',
        }, group);
        text.textContent = row;
        if (inAttributes) attrIndex += 1;
        else opIndex += 1;
      });
      if (rows.moreLabel !== null) {
        const inAttributes = rows.moreCompartment === 'attr';
        const baseline = y + (inAttributes
          ? nodeLayout.drawnTitleHeight + (rows.attrCount + 1) * lineHeight - 2
          : (splitY ?? nodeLayout.drawnTitleHeight) + (opIndex + 1) * lineHeight - 2);
        const text = svgElement('text', {
          x: x + 5,
          y: baseline,
          'font-family': SEMANTIC_MONO,
          'font-size': fontPx,
          'font-style': 'italic',
          'data-architecture-node-more': 'true',
          fill: '#64748b',
        }, group);
        text.textContent = rows.moreLabel;
      }
    }
    if (capture.geometry.nodes.find((node) => node.id === nodeLayout.id)?.mentionTier === 'pinned') {
      const badge = svgElement('text', {
        x: x + 4,
        y: y + 12,
        'font-size': 11,
        class: 'arch-pinned-badge',
        'data-architecture-pinned-badge': 'true',
      }, group);
      badge.textContent = '📌';
    } else if (group.classList.contains('arch-seed-light')) {
      // The light seed marker is a DOT beside the label (a shape reading, not
      // colour alone); it is re-drawn because wiping the group's children also
      // removed the one annotateNodes inserted.
      svgElement('circle', {
        cx: x + 4,
        cy: y + 4,
        r: 2.5,
        class: 'arch-seed-dot',
        'data-architecture-seed-dot': 'true',
        fill: SEMANTIC_SEED_COLOR,
        'pointer-events': 'none',
      }, group);
    }
  }

  // ---- sticky package names
  // Drawn by `drawStickyLabels` AFTER the caller has applied the scroll offset:
  // a sticky label's position is a reading of where the viewport is, and the
  // offset this draw computes is only written back afterwards.

  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  // The reading tests (and the E2E guard) can tell a semantically rewritten
  // drawing from a CSS-scaled one: in this mode width/height are the mapped
  // layout at 1:1 and the scale is carried by the geometry itself.
  svg.setAttribute('data-architecture-semantic', layout.tier);
  svg.setAttribute('data-architecture-semantic-scale', String(layout.scale));
}

/** A CSS length read out of a computed style, in px (0 when absent). */
export function stylePx(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The reader's visible content box, in the drawing SVG's own user units.
 *
 * Semantic mode shows the SVG 1:1 (its width/height attributes equal its
 * viewBox), so a screen-pixel offset relative to the SVG's own box IS a user
 * unit. The host's padding is excluded: that band is not where the drawing is
 * visible, and a sticky label placed into it would sit under the border.
 */
export function visibleViewportInSvg(host: HTMLElement, svg: SVGSVGElement): PlanRect | null {
  const hostRect = host.getBoundingClientRect();
  const svgRect = svg.getBoundingClientRect();
  let paddingLeft = 0;
  let paddingTop = 0;
  let paddingX = 0;
  let paddingY = 0;
  if (typeof getComputedStyle === 'function') {
    const style = getComputedStyle(host);
    paddingLeft = stylePx(style.paddingLeft);
    paddingTop = stylePx(style.paddingTop);
    paddingX = paddingLeft + stylePx(style.paddingRight);
    paddingY = paddingTop + stylePx(style.paddingBottom);
  }
  const width = host.clientWidth - paddingX;
  const height = host.clientHeight - paddingY;
  if (!(width > 0) || !(height > 0)) return null;
  return {
    x: hostRect.left + paddingLeft - svgRect.left,
    y: hostRect.top + paddingTop - svgRect.top,
    w: width,
    h: height,
  };
}

/** One element's painted rectangle in the SVG's user units, or null when it has none. */
export function rectInSvg(element: Element, svgRect: DOMRect): PlanRect | null {
  const rect = element.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  return { x: rect.left - svgRect.left, y: rect.top - svgRect.top, w: rect.width, h: rect.height };
}

/**
 * Draw the sticky package names at the viewport's top edge, after the caller
 * has applied the scroll offset this layout was solved for.
 *
 * A sticky label appears ONLY for a package whose own tab has scrolled out of
 * view (a visible tab is already the label), never over a visible class name or
 * another package's tab, and always fully inside the viewport. The rules are in
 * `planStickyLabels` / `placeStickyLabels`; this function only converts the
 * live DOM to their coordinate space and draws the result.
 *
 * Consumers: the semantic application paths and the host's scroll listener.
 */
export function drawStickyLabels(host: HTMLElement, layout: SemanticZoomLayout, fontPx: number): void {
  const svg = host.querySelector('svg');
  if (!(svg instanceof SVGSVGElement)) return;
  // Every pass rebuilds the ghosts; a previous pass's labels would otherwise
  // survive a scroll and be read at the old viewport position.
  for (const stale of [...svg.querySelectorAll('[data-architecture-sticky-package]')]) stale.remove();
  const viewport = visibleViewportInSvg(host, svg);
  if (viewport === null) return;
  const svgRect = svg.getBoundingClientRect();
  const offsetX = -layout.content.x;
  const offsetY = -layout.content.y;

  // Prefer the PAINTED tab rect over the planned one: the plan is a user-unit
  // rectangle, while the reading that decides "is my own tab on screen" uses
  // the path the browser actually painted (a 1px difference at the viewport
  // edge would otherwise show a ghost beside a visible tab).
  const paintedTabs = new Map<string, PlanRect>();
  for (const group of svg.querySelectorAll('.uml-package[data-package-id]')) {
    const path = [...group.children].find((child) => child.tagName.toLowerCase() === 'path');
    const rect = path === undefined ? null : rectInSvg(path, svgRect);
    if (rect !== null) paintedTabs.set(group.getAttribute('data-package-id') ?? '', rect);
  }

  const candidates = layout.packages
    .filter((entry) => entry.tabRect !== null)
    .map((entry) => {
      const tab = entry.tabRect;
      const planned = tab === null
        ? null
        : { x: tab.x + offsetX, y: tab.y + offsetY, w: tab.w, h: tab.h };
      const painted = paintedTabs.get(entry.id) ?? planned;
      return {
        id: entry.id,
        depth: entry.depth,
        top: entry.frame.y + offsetY,
        bottom: entry.frame.y + offsetY + entry.frame.height,
        tab: painted,
        anchorX: painted?.x ?? 0,
        width: painted?.w ?? entry.tab.width,
        height: painted?.h ?? entry.tab.height,
      };
    });
  const stickyFrames = planStickyLabels(candidates, viewport.y, viewport);
  if (stickyFrames.length === 0) return;

  // A ghost may cover neither a visible class name (rule 3) nor a real tab
  // (rule 2), so both are obstacles in the same user-unit space.
  const obstacles: PlanRect[] = [];
  for (const text of svg.querySelectorAll('[data-architecture-node-name]')) {
    const rect = rectInSvg(text, svgRect);
    if (rect !== null) obstacles.push(rect);
  }
  for (const tab of svg.querySelectorAll('.uml-package[data-package-id] > path')) {
    const rect = rectInSvg(tab, svgRect);
    if (rect !== null) obstacles.push(rect);
  }
  const hint = host.parentElement?.querySelector('[data-architecture-readable-hint]');
  if (hint !== undefined && hint !== null) {
    const rect = rectInSvg(hint, svgRect);
    if (rect !== null) obstacles.push(rect);
  }

  const placements = placeStickyLabels({
    candidates: stickyFrames.map((frame) => ({
      id: frame.id,
      anchorX: frame.anchorX,
      width: frame.width,
      height: frame.height,
    })),
    viewport,
    obstacles,
  });
  for (const placement of placements) {
    const entry = layout.packages.find((candidate) => candidate.id === placement.id);
    if (entry === undefined) continue;
    const group = svgElement('g', {
      'data-architecture-sticky-package': placement.id,
    }, svg);
    svgElement('rect', {
      x: placement.rect.x,
      y: placement.rect.y,
      width: placement.rect.w,
      height: placement.rect.h,
      rx: 3,
      fill: 'rgba(248,250,252,.92)',
    }, group);
    const text = svgElement('text', {
      x: placement.rect.x + 3,
      y: placement.rect.y + placement.rect.h / 2 + fontPx * 0.36,
      'font-family': SEMANTIC_SANS,
      'font-size': fontPx,
      fill: '#334155',
    }, group);
    text.textContent = entry.tab.text;
    if (entry.tab.badge !== '') {
      const badge = svgElement('tspan', { fill: SEMANTIC_SEED_COLOR }, text);
      badge.textContent = entry.tab.badge;
    }
  }
}

/**
 * Place the overview hint pill where it cannot cover a package tab.
 *
 * The pill is an HTML overlay in the canvas's own coordinate space; the tab
 * rects are converted from screen to canvas-local coordinates. When the layout
 * has not been measured (jsdom) the declared top-left position is left alone.
 */
export function positionOverviewHint(host: HTMLElement): void {
  const canvas = host.closest('[data-architecture-canvas]');
  if (!(canvas instanceof HTMLElement)) return;
  const hint = canvas.querySelector('[data-architecture-readable-hint]');
  if (!(hint instanceof HTMLElement)) return;
  const canvasRect = canvas.getBoundingClientRect();
  const hintRect = hint.getBoundingClientRect();
  const viewport: PlanRect = { x: 0, y: 0, w: canvas.clientWidth, h: canvas.clientHeight };
  if (!(viewport.w > 0) || !(viewport.h > 0)) return;
  if (!(hintRect.width > 0) || !(hintRect.height > 0)) return;
  const obstacles: PlanRect[] = [];
  for (const tab of host.querySelectorAll('.uml-package[data-package-id] > path')) {
    const rect = tab.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) continue;
    const local: PlanRect = {
      x: rect.left - canvasRect.left,
      y: rect.top - canvasRect.top,
      w: rect.width,
      h: rect.height,
    };
    if (planRectsIntersect(local, viewport)) obstacles.push(local);
  }
  const placement = planHintPlacement({
    width: hintRect.width,
    height: hintRect.height,
    viewport,
    obstacles,
  });
  hint.style.left = `${Math.round(placement.x)}px`;
  hint.style.top = `${Math.round(placement.y)}px`;
}

/**
 * The on-screen frame rect of a drawn package, in drawing user units. Read from
 * the SVG that is on screen NOW (after the semantic pass rewrote it), so a
 * "tap a package" zoom centres the frame the reader is looking at.
 */
export function drawnPackageFrame(
  host: ParentNode,
  packageId: string,
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null {
  const frame = [...host.querySelectorAll('.uml-package[data-package-id]')]
    .find((candidate) => candidate.getAttribute('data-package-id') === packageId);
  const rect = frame?.querySelector('rect');
  if (rect === undefined || rect === null) return null;
  const read = (name: string): number => {
    const value = Number(rect.getAttribute(name));
    return Number.isFinite(value) ? value : 0;
  };
  return { x: read('x'), y: read('y'), width: read('width'), height: read('height') };
}

/** The drawn edge group between `from` and `to`, if this view draws one. */
export function edgeElement(host: HTMLElement, from: string, to: string): Element | null {  for (const edge of host.querySelectorAll('.uml-edge')) {
    if (edge.getAttribute('data-edge-source') === from && edge.getAttribute('data-edge-target') === to) {
      return edge;
    }
  }
  return null;
}

/**
 * Draw the panel's selection set on the freshly rendered (or re-rendered) SVG:
 * a heavier frame plus a check badge on every selected node, and a bolder line
 * with its visible type label on every selected relation. Cleared first, so a
 * selection that is no longer drawn leaves no residue. Single-selection callers
 * pass one-element arrays and get exactly the old drawing.
 */
export function applySelectionStyles(
  host: HTMLElement,
  nodeIds: readonly string[],
  relations: readonly { readonly from: string; readonly to: string }[],
): void {
  for (const element of host.querySelectorAll('.arch-selected, .arch-edge-selected')) {
    element.classList.remove('arch-selected', 'arch-edge-selected');
  }
  for (const badge of host.querySelectorAll('.arch-selected-check')) badge.remove();

  for (const nodeId of nodeIds) {
    const node = nodeElement(host, nodeId);
    if (node === null) continue;
    node.classList.add('arch-selected');
    const rect = node.querySelector('rect');
    if (rect !== null) {
      const badge = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      const x = Number(rect.getAttribute('x') ?? '0') + Number(rect.getAttribute('width') ?? '0') - 4;
      const y = Number(rect.getAttribute('y') ?? '0') + 11;
      badge.setAttribute('x', String(x));
      badge.setAttribute('y', String(y));
      badge.setAttribute('text-anchor', 'end');
      badge.setAttribute('font-size', '11');
      badge.setAttribute('class', 'arch-selected-check');
      badge.setAttribute('data-architecture-selected-check', nodeId);
      badge.textContent = '✓';
      node.appendChild(badge);
    }
  }

  for (const relation of relations) {
    const edge = edgeElement(host, relation.from, relation.to);
    if (edge === null) continue;
    edge.classList.add('arch-edge-selected');
    for (const label of edge.querySelectorAll('text')) label.removeAttribute('display');
  }
}

/** The drawn rectangles a marquee hit test compares against, in client pixels. */
export function rectOf(element: Element): ArchitectureSelectionRect {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

/**
 * Every drawn entity and relation, paired with the rectangle it occupies. Group
 * and stub nodes are view scaffolding rather than entities, so a marquee never
 * selects them. A zero-area box (jsdom, a hidden tab) is dropped by the same
 * half-open rule the pure hit test applies.
 */
export function boxCandidates(host: HTMLElement): ArchitectureBoxCandidate[] {
  const candidates: ArchitectureBoxCandidate[] = [];
  for (const element of host.querySelectorAll('[data-entity-id]')) {
    const id = element.getAttribute('data-entity-id') ?? '';
    if (id === '' || id.startsWith(GROUP_PREFIX) || id.startsWith(STUB_PREFIX)) continue;
    candidates.push({ selection: { kind: 'entity', nodeId: id }, rect: rectOf(element) });
  }
  for (const element of host.querySelectorAll('[data-architecture-edge-hit]')) {
    const from = element.getAttribute('data-architecture-edge-source');
    const to = element.getAttribute('data-architecture-edge-target');
    if (from === null || to === null) continue;
    const relationType = element.getAttribute('data-architecture-edge-type') ?? '';
    candidates.push({
      selection: { kind: 'relation', from, to, relationType },
      rect: rectOf(element),
    });
  }
  return candidates;
}
