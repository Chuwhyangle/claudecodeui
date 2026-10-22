import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { DEFAULT_NODE_ID_SHAPE } from '@/modules/architecture/adaptiveGrouping';
import { ArchitectureMinimap } from '@/modules/architecture/ArchitectureMinimap';
import {
  archguardToPlantUml,
  DEFAULT_NEIGHBORHOOD_HOPS,
  nodeFileOf,
  type ArchitectureDiagramView,
  type ArchitecturePlantUml,
} from '@/modules/architecture/archguardToPlantUml';
import {
  applyExplosionLod,
  buildExplosionHierarchy,
  createExplosionLodScheduler,
  focusPackageOf,
  resolveLodDepth,
  type ExplosionLodDepth,
  type ExplosionLodScheduler,
} from '@/modules/architecture/explosionLod';
import {
  ASPECT_RELAYOUT_DEBOUNCE_MS,
  clampAspectRatio,
  createLayoutEngine,
  shouldRelayoutForAspect,
  type ArchitectureLayoutEngine,
  type ArchitectureLayoutEngineClass,
} from '@/modules/architecture/elkAspectEngine';
import type { ArchitectureHierarchyIndex } from '@/modules/architecture/hierarchyIndex';
import {
  TOUCH_TARGET_STYLE,
  useCompactToolbarSlot,
  useTouchLayout,
  ZOOM_CLUSTER_TARGET_STYLE,
} from '@/modules/architecture/hooks/useTouchLayout';
import {
  buildSeedHierarchy,
  decideReadableZoom,
  fitControlReading,
  type ReadableZoomDecision,
  type ReadableZoomHint,
  type ReadableZoomMode,
} from '@/modules/architecture/readableZoom';
import type {
  ArchitectureNodeIdShape,
  ArchitectureRendererGraph,
  ArchitectureRendererProps,
} from '@/modules/architecture/rendererContract';
import {
  centerElementInContainer,
  createSvgDragPan,
  createSvgTouchGestures,
  createSvgViewport,
  fitZoomScale,
  measureViewportSize,
  MIN_ZOOM_SCALE,
  readSvgNaturalSize,
  ZOOM_STEP,
  type SvgViewportController,
} from '@/modules/architecture/svgViewport';

/**
 * The renderer options this component drives. Structural subsets of the
 * package's `RendererOptions` / `ViewSpec`, so the lazily imported module is
 * typed without importing its types into the first-screen chunk.
 */
type PlantUmlView = { kind: 'neighborhood'; entity: string; hops: number };

type PlantUmlRenderer = {
  render: (puml: string) => Promise<{ svg: string }>;
};

/**
 * `layout` takes the engine instance, not the `'elk'` keyword: the engine is
 * built by `createLayoutEngine` so the container's aspect ratio reaches the
 * layout (see `elkAspectEngine.ts`).
 */
type PlantUmlRendererFactory = (options: {
  layout: ArchitectureLayoutEngine;
  view?: PlantUmlView;
}) => PlantUmlRenderer;

/** The alias marker the renderer prefixes on overview group nodes (`grp::<path prefix>`). */
const GROUP_PREFIX = 'grp::';
/** Stub nodes in a view (external neighbours) are not real entities; clicks ignore them. */
const STUB_PREFIX = 'stub::';

/**
 * How close two taps on the same node must be to count as the explicit drill
 * gesture. A touch tap cannot double as both "select" and "drill", so the
 * second tap is the user saying "yes, open this one".
 */
const DOUBLE_TAP_MS = 350;

/** The shared look of the diagram toolbar's buttons. */
const TOOLBAR_BUTTON_CLASS =
  'rounded border border-border px-1.5 py-0.5 text-[11px] font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60';

/** How far one arrow-key press pans a focused canvas, in CSS pixels. */
const KEYBOARD_PAN_STEP = 40;

/**
 * The cross-panel linkage channel. The SVG is the shared surface: a click on an
 * entity announces it on `window` together with the in/out neighbours read from
 * the neighbourhood JSON, and a sibling panel (the chat, when a file is
 * referenced) can select an entity by its stable `data-entity-id` through the
 * second event. Both names are part of the renderer's documented contract, so a
 * consumer listens for the literal names rather than importing this module.
 */
const ENTITY_SELECTED_EVENT = 'architecture:entity-selected';
const ENTITY_HIGHLIGHT_EVENT = 'architecture:highlight-entity';

/** The selection announced to sibling panels: one entity and its JSON neighbours. */
type EntitySelection = {
  readonly id: string;
  readonly incoming: readonly string[];
  readonly outgoing: readonly string[];
};

/** Diagram chrome: dim everything not on the hovered node's edges. */
const HIGHLIGHT_STYLE = `
  [data-architecture-plantuml] .arch-dim { opacity: 0.15; }
  [data-architecture-plantuml] .arch-hl-in rect,
  [data-architecture-plantuml] .arch-hl-out rect { stroke: #2563eb; stroke-width: 2.5; }
  [data-architecture-plantuml] .arch-hl-in polyline,
  [data-architecture-plantuml] .arch-hl-out polyline { stroke: #2563eb; }
  [data-architecture-plantuml] .arch-hl-in .uml-arrow,
  [data-architecture-plantuml] .arch-hl-out .uml-arrow { fill: #2563eb; stroke: #2563eb; }
  [data-architecture-plantuml] .arch-center rect { fill: #dbeafe; stroke: #1d4ed8; }
  /* A session seed (distance 0) is marked by WEIGHT, not only colour: the frame
     is drawn twice as thick, which survives a greyscale print and colour-blind
     reading. */
  [data-architecture-plantuml] .arch-seed > rect { stroke: #b45309; stroke-width: 3; }
  /* Edge relation labels are hidden by default (a dense drawing turns the
     relation stereotypes into a wall of overlapping text); hovering or
     selecting a node reveals the labels of its own edges. The DOM helpers
     hideEdgeLabels/showHighlightedEdgeLabels toggle the SVG display
     presentation attribute on the labels the renderer already drew, so this is
     a visibility toggle, never a re-layout. */
  /* Directory groups are scaffolding, not entities: same dashed, grey frame the
     renderer's own overview stubs use, so a collapsed overview reads as a map. */
  [data-architecture-plantuml] [data-entity-id^="grp::"] rect { fill: #f6f8fa; stroke-dasharray: 5,3; }
  [data-architecture-plantuml] svg { display: block; margin: 0 auto; }
`;

/**
 * The renderer-local budget hints are accepted (the contract carries them) but
 * deliberately unused: the overview/group/neighbourhood views below derive what
 * is visible from the graph itself, which is this renderer's replacement for
 * the old maxHops/maxNodes truncation.
 */
type PlantUmlGraphProps = ArchitectureRendererProps & {
  /**
   * A node the panel asked this renderer to reveal (a search hit, or a match
   * that was outside the current detail range). The renderer opens that node's
   * neighbourhood and centres the drawn box on it.
   */
  readonly focusNodeId?: string | null;
  /** Bumped on every request, so asking for the same node twice re-centres it. */
  readonly focusToken?: number;
};

/**
 * The diagram's presentation scale and why it has that value: `fit` follows the
 * container whenever it resizes, while `custom` is a scale the user chose with
 * the toolbar or the wheel. A view switch re-derives the scale (a new diagram
 * has a new natural size) but keeps this mode, so a fit user stays fitted and a
 * manual user is not silently moved into fit-on-resize.
 */
type DiagramZoom = {
  readonly scale: number;
  readonly mode: 'fit' | 'custom';
};

/** The alias → original id direction of the bridge's map. */
function reverseAliases(aliasOf: ReadonlyMap<string, string>): Map<string, string> {
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
function restoreEntityIds(host: HTMLElement, aliasOf: ReadonlyMap<string, string>): void {
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
 * The renderer options for one view. The overview and group views are already
 * collapsed by the bridge (directory-only adaptive grouping), so only the
 * neighbourhood view asks the renderer to slice the model.
 */
function rendererOptionsFor(
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
function measureLayoutAspect(host: HTMLElement): number | null {
  const width = host.clientWidth;
  const height = host.clientHeight;
  if (!(width > 0) || !(height > 0)) return null;
  return clampAspectRatio(width / height);
}

/** A drawing's identity: the view (with its parameters) that produced it. */
function drawingKeyOf(view: ArchitectureDiagramView): string {
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
type ReadableView = {
  readonly mode: ReadableZoomMode;
  readonly focusPackageId: string | null;
  readonly hint: ReadableZoomHint | null;
};

/** Normalise a drawn package id the way the hierarchy index does, for comparison. */
function normalizeDrawnPackageId(raw: string | null): string {
  if (raw === null) return '';
  return raw.trim().split('/').filter(Boolean).join('/');
}

/**
 * The element a focus jump should centre. Package frames are the first choice
 * (explosion/neighbourhood views draw them); the grouped overview instead draws
 * `grp::<prefix>` nodes, so the deepest drawn prefix that contains the package
 * is the group the reader should see. `null` when the drawing shows neither.
 */
function focusElementFor(host: HTMLElement, packageId: string): Element | null {
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
function centerOnPackage(host: HTMLElement, packageId: string): void {
  const target = focusElementFor(host, packageId);
  if (target !== null) centerElementInContainer(host, target);
}

/**
 * Hide every edge relation label the renderer drew. The label is still in the
 * DOM (the SVG structure is the renderer's contract); only its visibility is
 * toggled, which is why a hover never re-lays the drawing out.
 */
function hideEdgeLabels(host: HTMLElement): void {
  for (const label of host.querySelectorAll('.uml-edge text')) {
    label.setAttribute('display', 'none');
  }
}

/** Reveal the labels of the edges the highlight marked (and only those). */
function showHighlightedEdgeLabels(host: HTMLElement): void {
  for (const edge of host.querySelectorAll('.arch-hl-in, .arch-hl-out')) {
    for (const label of edge.querySelectorAll('text')) label.removeAttribute('display');
  }
}

/** Remove every highlight class the hover interaction may have added. */
function clearHighlight(host: HTMLElement): void {
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
function highlightRelations(host: HTMLElement, id: string): void {
  clearHighlight(host);
  const neighbours = new Set<string>([id]);
  for (const edge of host.querySelectorAll('.uml-edge')) {
    const from = edge.getAttribute('data-edge-source');
    const to = edge.getAttribute('data-edge-target');
    if (from === id) {
      edge.classList.add('arch-hl-out');
      if (to !== null) neighbours.add(to);
    } else if (to === id) {
      edge.classList.add('arch-hl-in');
      if (from !== null) neighbours.add(from);
    } else {
      edge.classList.add('arch-dim');
    }
  }
  for (const node of host.querySelectorAll('.uml-node')) {
    const nodeId = node.getAttribute('data-entity-id');
    if (nodeId !== null && !neighbours.has(nodeId)) node.classList.add('arch-dim');
  }
  showHighlightedEdgeLabels(host);
}

/**
 * Annotate the freshly drawn SVG with the two readings the node boxes no longer
 * carry themselves:
 *  · the hover `<title>` names the FILE the entity lives in — the box label is
 *    the bare entity name, so the path has to live somewhere the pointer can
 *    reveal it;
 *  · a DIRECT session mention gets the seed marker attribute + class, which the
 *    stylesheet turns into the thicker frame (see HIGHLIGHT_STYLE).
 * View scaffolding (group and stub nodes) is not an entity and is skipped.
 */
function annotateNodes(
  host: HTMLElement,
  graph: ArchitectureRendererGraph,
  idShape: ArchitectureNodeIdShape,
): void {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
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
    // Old payloads carry no tier: falling back to `distance === 0` is what
    // keeps them visually unchanged. With tiers, only a direct mention is a
    // seed — same-name candidates (`name`) and file-expanded entities (`file`)
    // stay in the graph but lose the marker.
    const isSeed = node.mentionTier === undefined ? node.distance === 0 : node.mentionTier === 'direct';
    if (isSeed) {
      element.setAttribute('data-architecture-seed', 'true');
      element.classList.add('arch-seed');
    }
  }
}

/**
 * The entity's dependency direction, read from the neighbourhood JSON already in
 * hand rather than from the drawn SVG: the SVG is only the visible slice, while
 * the payload is what a sibling panel is told about.
 */
function selectionOf(graph: ArchitectureRendererGraph, id: string): EntitySelection {
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
function announceSelection(graph: ArchitectureRendererGraph, id: string): void {
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
function highlightSelection(host: HTMLElement, id: string | null): void {
  if (id === null || nodeElement(host, id) === null) {
    clearHighlight(host);
    return;
  }
  highlightRelations(host, id);
}

/** The relation kinds on the hovered node's VISIBLE edges, read from what was actually drawn. */
function relationsOf(host: HTMLElement, id: string): string[] {
  const relations = new Set<string>();
  for (const edge of host.querySelectorAll('.uml-edge')) {
    if (edge.getAttribute('data-edge-source') !== id && edge.getAttribute('data-edge-target') !== id) continue;
    const type = edge.getAttribute('data-edge-type');
    if (type !== null) relations.add(type);
  }
  return [...relations].sort();
}

/** The drawn node carrying `id`, without relying on `CSS.escape` (absent in jsdom). */
function nodeElement(host: HTMLElement, id: string): Element | null {
  for (const node of host.querySelectorAll('.uml-node')) {
    if (node.getAttribute('data-entity-id') === id) return node;
  }
  return null;
}

/**
 * Renders one architecture neighbourhood as a lazily loaded PlantUML/ELK
 * layered diagram.
 *
 * Used by ArchitecturePanel. THREE views replace the old maxHops/maxNodes
 * truncation, and all of them slice the payload already in hand:
 *  · overview — the whole graph folded into path groups (`groupByPathPrefix`);
 *  · group — clicking an overview group expands just that group;
 *  · neighbourhood — clicking an entity drills into it, and clicking the
 *    centred entity again adds one hop.
 * Hovering a node highlights its in/out edges and dims the rest; clicking an
 * entity pins that highlight and announces the entity with its JSON in/out
 * neighbours on `architecture:entity-selected`, while a sibling panel can ask
 * for one by id through `architecture:highlight-entity`. Every view is local:
 * nothing here re-enters the fetch. The renderer package is imported
 * dynamically, so elkjs never enters the first-screen bundle.
 */
export function PlantUmlGraph({
  graph,
  idShape = DEFAULT_NODE_ID_SHAPE,
  detailReading,
  onNodeClick,
  onNodeHover,
  onExport,
  focusNodeId = null,
  focusToken,
}: PlantUmlGraphProps) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);
  // The pointer/size tier: coarse pointers get 44px hit areas, narrow screens
  // collect the toolbar into one overflow menu (see `useTouchLayout`).
  const { touchUi, compactToolbar } = useTouchLayout();
  // On the compact tier the panel owns the single toolbar row and lends its
  // overflow menu as the slot these controls are drawn into; `null` (menu shut)
  // means this renderer has no chrome on screen at all.
  const compactToolbarSlot = useCompactToolbarSlot();
  const touchTargetStyle = touchUi ? TOUCH_TARGET_STYLE : undefined;
  // Which slice of the payload is drawn. Local by construction: the payload is
  // fetched whole, so switching views must never re-request it.
  const [view, setView] = useState<ArchitectureDiagramView>({ kind: 'overview' });
  // What the last render actually drew; drives the visible-count readout and
  // lets a test tell a stale SVG from the new view's SVG.
  const [drawn, setDrawn] = useState<{ view: ArchitectureDiagramView; nodes: number; edges: number } | null>(null);
  // A failed render is shown instead of the previous (now stale) diagram.
  const [failure, setFailure] = useState<string | null>(null);
  // How long the drawing on screen took to lay out and render, in ms. Exposed
  // as `data-architecture-layout-ms` for the DoD's readings; deliberately not
  // shown as UI text (a number the reader cannot act on is noise).
  const [layoutMs, setLayoutMs] = useState<number | null>(null);
  // Read inside the delegated DOM listeners without re-registering them: the
  // listeners are registered once per mount, while these values change as the
  // parent re-renders (hover key, graph swap).
  const viewRef = useRef(view);
  const graphRef = useRef(graph);
  const hoverCallbackRef = useRef(onNodeHover);
  const clickCallbackRef = useRef(onNodeClick);
  // The entity the user clicked (or a sibling panel asked for). Unlike the
  // hover reading it survives leaving the node and being re-rendered, so the
  // dependency/reverse-dependency highlight stays pinned until the selection is
  // replaced or cleared.
  const selectedRef = useRef<string | null>(null);
  // A state copy of the selection, used only to render the explicit "Drill in"
  // action. It deliberately does not feed the drawing effect: selecting must
  // never re-lay the diagram out.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Whether the selection came from a touch tap. A desktop click already
  // navigated, so only a touch selection needs a separate drill command.
  const [selectedByTouch, setSelectedByTouch] = useState(false);
  // The pointer type of the last press on the graph. A click that follows a
  // touch press keeps the touch semantics (select only); a mouse click keeps
  // the original click-to-drill behaviour.
  const lastPointerTypeRef = useRef<string | null>(null);
  // The previous tap, for the touch double-tap drill gesture.
  const lastTapRef = useRef<{ id: string; at: number } | null>(null);
  useEffect(() => {
    viewRef.current = view;
    graphRef.current = graph;
    hoverCallbackRef.current = onNodeHover;
    clickCallbackRef.current = onNodeClick;
  }, [view, graph, onNodeHover, onNodeClick]);

  // The viewed scale and its mode (see DiagramZoom). Rendering reads it for the
  // toolbar readout and the next attach; the SVG itself is resized imperatively
  // through `viewportRef`, so scaling never re-enters the drawing path.
  const [zoom, setZoom] = useState<DiagramZoom>({ scale: 1, mode: 'fit' });
  // Mirror of `zoom` for the async render / wheel / resize handlers, which run
  // outside the render that last committed the state.
  const zoomRef = useRef(zoom);
  const viewportRef = useRef<SvgViewportController | null>(null);
  const applyZoom = useCallback((next: DiagramZoom): void => {
    zoomRef.current = next;
    setZoom(next);
  }, []);

  // The readable default applied to the drawing on screen: focus or overview,
  // the package focus centres, and the overview hint (if any). Rendering reads
  // it for the toolbar toggle and the two notice lines; the SCALE itself lives
  // in `zoom`, because it is the same value the +/- controls manipulate.
  const [readableView, setReadableView] = useState<ReadableView | null>(null);
  // The user's explicit toolbar choice; `null` means "let the drawing decide"
  // (focus when the geometric fit is below the readable floor). A new drawing
  // clears it so each view opens at its own honest default.
  const [readableMode, setReadableMode] = useState<ReadableZoomMode | null>(null);
  const readableModeRef = useRef<ReadableZoomMode | null>(null);
  // The seed hierarchy of the payload on screen, so a resize or a mode switch
  // can re-decide the focus without rebuilding the tree.
  const seedHierarchyRef = useRef<ArchitectureHierarchyIndex | null>(null);
  // Set when a drawing was too wide for its container and was collapsed to the
  // directory overview; the notice stays until the user asks for the explosion
  // view again.
  const [collapsedNotice, setCollapsedNotice] = useState(false);

  /**
   * The navigation command, kept separate from the gesture that triggers it:
   * a desktop click runs it immediately, while a touch tap selects first and
   * reaches it through a double-tap or the "Drill in" button.
   */
  const drillInto = useCallback((id: string): void => {
    if (id.startsWith(STUB_PREFIX)) return;
    if (id.startsWith(GROUP_PREFIX)) {
      setView({ kind: 'group', prefix: id.slice(GROUP_PREFIX.length) });
      return;
    }
    const current = viewRef.current;
    const hops = current.kind === 'neighborhood' && current.entityId === id
      ? current.hops + 1
      : DEFAULT_NEIGHBORHOOD_HOPS;
    setView({ kind: 'neighborhood', entityId: id, hops });
  }, []);

  const drillSelected = useCallback((): void => {
    const id = selectedRef.current;
    if (id !== null) drillInto(id);
  }, [drillInto]);

  /**
   * A panel-level focus request (search hit / out-of-range jump) navigates the
   * drawing to the named node's neighbourhood. This is a deliberate exception
   * to "selection never re-lays out": the node may not be in the current view
   * at all, so the only honest way to show it is to open its own view. The
   * request is keyed by `focusToken` so choosing the same node again works.
   */
  useEffect(() => {
    if (focusNodeId === null) return;
    selectedRef.current = focusNodeId;
    setSelectedId(focusNodeId);
    setSelectedByTouch(false);
    setView({ kind: 'neighborhood', entityId: focusNodeId, hops: DEFAULT_NEIGHBORHOOD_HOPS });
  }, [focusNodeId, focusToken]);

  // The hierarchy of the drawing on screen (entities → packages) and the zoom
  // level currently displayed. The level is applied imperatively (display
  // toggles, label rewrites, edge overlay) so crossing it never replaces the
  // SVG; the state copy exists only for the toolbar readout.
  const lodRef = useRef<{
    hierarchy: ArchitectureHierarchyIndex;
    edges: ArchitectureRendererGraph['edges'];
  } | null>(null);
  const lodDepthRef = useRef<ExplosionLodDepth | null>(null);
  const lodSchedulerRef = useRef<ExplosionLodScheduler | null>(null);
  // The neighbourhood centre, kept outside the render so a level cross can
  // recentre the package it belongs to even when nothing is clicked.
  const centerEntityRef = useRef<string | null>(null);
  const [lodDepth, setLodDepth] = useState<ExplosionLodDepth | null>(null);

  // Re-evaluate the level after the zoom settles; the focus package is scrolled
  // back only when the level actually changes, not on every wheel tick.
  const applyLod = useCallback((scale: number): void => {
    const host = hostRef.current;
    const drawing = lodRef.current;
    if (host === null || drawing === null) return;
    const depth = resolveLodDepth(scale, lodDepthRef.current);
    const crossed = depth !== lodDepthRef.current;
    lodDepthRef.current = depth;
    applyExplosionLod({
      host,
      hierarchy: drawing.hierarchy,
      edges: drawing.edges,
      depth,
      focusPackageId: focusPackageOf(drawing.hierarchy, [selectedRef.current, centerEntityRef.current]),
      centerFocus: crossed,
    });
    setLodDepth(depth);
  }, []);

  // One controller per mount: it survives the renderer replacing the SVG (each
  // render re-attaches), so the mode and scale outlive a single drawing.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    viewportRef.current = createSvgViewport(host);
    return () => {
      viewportRef.current = null;
    };
  }, []);

  // Touch gestures ride on the SAME controller the toolbar and Ctrl+wheel use,
  // so pinch never introduces a second zoom model. The host's `touch-action:
  // none` (below) is what suppresses the browser's own page pan/zoom; that is
  // also why the single-finger drag has to pan the container here.
  useEffect(() => {
    const host = hostRef.current;
    const viewport = viewportRef.current;
    if (host === null || viewport === null) return;
    const gestures = createSvgTouchGestures(host, viewport, {
      onZoom: (scale) => applyZoom({ scale, mode: 'custom' }),
    });
    return () => gestures.destroy();
  }, [applyZoom]);

  // Mouse/pen panning rides on the same scroll container the touch gestures
  // pan: left-drag from the blank canvas and middle-drag from anywhere scroll
  // it. Presses on a node are refused so they stay selection/drill gestures,
  // and fingers are left to `createSvgTouchGestures` — one pan, two input
  // families, never two competing drag states.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const pan = createSvgDragPan(host, {
      canPanFrom: (target) => !(target instanceof Element && target.closest('[data-entity-id]') !== null),
    });
    return () => pan.destroy();
  }, []);

  // The LOD debouncer lives for the mount; a drawing change cancels its pending
  // application through the render effect below.
  useEffect(() => {
    const scheduler = createExplosionLodScheduler();
    lodSchedulerRef.current = scheduler;
    return () => {
      scheduler.cancel();
      lodSchedulerRef.current = null;
    };
  }, []);

  // The container ratio the NEXT drawing is laid out for. A resize does not
  // re-render on its own (the SVG is resized imperatively), so a shape change
  // that is worth a new layout needs a state write to re-enter the render
  // effect; it stays `null` until the first such change, letting the first draw
  // measure the container directly (see `measureLayoutAspect`).
  const [layoutAspect, setLayoutAspect] = useState<number | null>(null);
  // The ratio the drawing on screen was laid out with (`null` = the engine's own
  // default). Read by the resize observer to decide whether the container has
  // moved far enough to earn a re-layout.
  const drawnAspectRef = useRef<number | null>(null);
  // The drawing the LOD level belongs to, so an aspect re-layout of the SAME
  // view carries the current level and focus over instead of re-deriving them.
  const drawnKeyRef = useRef<string | null>(null);
  // Pending debounced re-layout (one timer: the latest reading wins).
  const aspectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleAspectRelayout = useCallback((aspect: number): void => {
    if (aspectTimerRef.current !== null) clearTimeout(aspectTimerRef.current);
    aspectTimerRef.current = setTimeout(() => {
      aspectTimerRef.current = null;
      setLayoutAspect(aspect);
    }, ASPECT_RELAYOUT_DEBOUNCE_MS);
  }, []);
  useEffect(() => () => {
    if (aspectTimerRef.current !== null) clearTimeout(aspectTimerRef.current);
    aspectTimerRef.current = null;
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    let cancelled = false;
    // A pending application belongs to the drawing being replaced; the new one
    // is applied synchronously below.
    lodSchedulerRef.current?.cancel();
    setFailure(null);
    hoverCallbackRef.current?.(null);
    // A NEW view gets its own readable default; a re-layout of the same view
    // (container aspect change) keeps whatever the user chose.
    if (drawingKeyOf(view) !== drawnKeyRef.current) {
      readableModeRef.current = null;
      setReadableMode(null);
    }
    // A reloaded graph may not contain the previously selected entity.
    if (selectedRef.current !== null && !graph.nodes.some((node) => node.id === selectedRef.current)) {
      selectedRef.current = null;
      setSelectedId(null);
      setSelectedByTouch(false);
    }

    void (async () => {
      try {
        // The only plantuml-js/elkjs import in the module graph: Vite emits it
        // as its own async chunk, so the first-screen bundle stays untouched.
        const { createRenderer, ElkLayoutEngine } = (await import('@yalehwang/plantuml-js/elk')) as unknown as {
          createRenderer: PlantUmlRendererFactory;
          ElkLayoutEngine: ArchitectureLayoutEngineClass;
        };
        if (cancelled) return;

        // The container's shape is a LAYOUT input, not a post-render scale: the
        // engine is CONSTRUCTED with it so ELK draws for this container instead
        // of for its own default proportions.
        const drawnAspect = layoutAspect ?? measureLayoutAspect(host);
        const engine = createLayoutEngine({ aspectRatio: drawnAspect, Engine: ElkLayoutEngine });
        // The panel is the adaptive consumer: the bridge collapses directory
        // layers itself (the renderer's `groupByPathPrefix` would count a file
        // name as a layer, which is the bug this view exists to avoid). The
        // panel also states how this subgraph's ids are shaped, so a file graph
        // keeps its top directory in every group prefix and label.
        const diagram = archguardToPlantUml(graph, { view, grouping: 'adaptive', idShape });
        const renderer = createRenderer(rendererOptionsFor(view, diagram, engine));
        // Layout + render is the expensive, blocking part (ELK runs on the main
        // thread); its duration is the DoD's per-view reading.
        const renderStartedAt = performance.now();
        const { svg } = await renderer.render(diagram.puml);
        const elapsedMs = Math.round(performance.now() - renderStartedAt);
        if (cancelled) return;

        host.innerHTML = svg;
        setLayoutMs(elapsedMs);
        drawnAspectRef.current = drawnAspect;
        restoreEntityIds(host, diagram.aliasOf);
        // Labels are off until a node is hovered/selected, and every entity
        // box carries its source file + seed marker (see `annotateNodes`).
        hideEdgeLabels(host);
        annotateNodes(host, graph, idShape);
        // Every view has its own natural size, so the scale is re-derived here
        // rather than carried over; the fit/custom MODE survives so the resize
        // observer keeps following the container only for a fit user.
        //
        // The default is not "fit everything" any more: a fit below the
        // readable floor would draw sub-pixel labels, so the readable policy
        // focuses the densest seeded package at a legible scale instead. The
        // overview toggle still offers the explicit whole-graph fit.
        const drawing = host.querySelector('svg');
        const viewport = viewportRef.current;
        let drawnScale = zoomRef.current.scale;
        let readout: ReadableView | null = null;
        let matchReading: ReadableZoomDecision | null = null;
        if (drawing !== null && viewport !== null) {
          viewport.attach(drawing);
          const seedHierarchy = buildSeedHierarchy(graph, idShape);
          seedHierarchyRef.current = seedHierarchy;
          const natural = readSvgNaturalSize(drawing);
          const box = measureViewportSize(host);
          const fitScale = natural !== null && box !== null
            ? fitZoomScale(natural, box, MIN_ZOOM_SCALE)
            : 1;
          const decision = decideReadableZoom({
            fitScale,
            natural: natural ?? { width: 0, height: 0 },
            viewport: box,
            hierarchy: seedHierarchy,
            selectedEntityIds: [
              selectedRef.current,
              view.kind === 'neighborhood' ? view.entityId : null,
            ],
            mode: readableModeRef.current ?? undefined,
          });
          // A canvas several times wider than its container is a band, not a
          // diagram: collapse it to the directory overview and say so. Only the
          // explosion view can reach this — the overview IS the fallback.
          if (view.kind === 'hierarchy' && decision.collapsedForAspect) {
            setCollapsedNotice(true);
            setView({ kind: 'overview' });
          } else if (view.kind === 'hierarchy') {
            setCollapsedNotice(false);
          }
          drawnScale = viewport.zoomTo(decision.scale);
          applyZoom({ scale: drawnScale, mode: zoomRef.current.mode });
          readout = {
            mode: decision.mode,
            focusPackageId: decision.focusPackageId,
            hint: decision.overviewHint,
          };
          setReadableView(readout);
          matchReading = decision;
        }
        // A fresh SVG has no highlight classes; re-pin the current selection.
        highlightSelection(host, selectedRef.current);
        centerEntityRef.current = null;
        if (view.kind === 'neighborhood') {
          const center = diagram.rendererEntity;
          if (center !== null) {
            const id = reverseAliases(diagram.aliasOf).get(center);
            if (id !== undefined) {
              centerEntityRef.current = id;
              nodeElement(host, id)?.classList.add('arch-center');
            }
          }
        }
        // A new drawing gets its LOD applied synchronously, so it never flashes
        // at the wrong detail before the debouncer fires. The overview — and a
        // group view that still shows directory groups — has no entities or
        // package frames to collapse, so it stays out of the LOD.
        //
        // A re-layout of the SAME view (the container's shape changed) is not a
        // new drawing in the user's eyes: keep the level they were reading and
        // re-centre the package they were focused on. Any other drawing derives
        // both from the fresh fit scale.
        const drawingKey = drawingKeyOf(view);
        const carriedDepth = drawingKey === drawnKeyRef.current ? lodDepthRef.current : null;
        drawnKeyRef.current = drawingKey;
        if (view.kind === 'overview' || diagram.grouped) {
          lodRef.current = null;
          lodDepthRef.current = null;
          setLodDepth(null);
        } else {
          const hierarchy = buildExplosionHierarchy(host, graph, idShape);
          lodRef.current = { hierarchy, edges: graph.edges };
          const depth = carriedDepth ?? resolveLodDepth(drawnScale, null);
          lodDepthRef.current = depth;
          applyExplosionLod({
            host,
            hierarchy,
            edges: graph.edges,
            depth,
            focusPackageId: focusPackageOf(hierarchy, [selectedRef.current, centerEntityRef.current]),
            // A fresh drawing was just fitted; scrolling it would fight the
            // fit rather than preserve a focus across a level cross. A carried
            // level is exactly the case where the focus should be restored.
            centerFocus: carriedDepth !== null,
          });
          setLodDepth(depth);
        }
        // The readable default's focus jump runs AFTER the LOD application:
        // the LOD only recentres on a level cross, so this is the one scroll
        // that places a freshly focused package after a new drawing.
        if (matchReading !== null && matchReading.mode === 'focus' && readout !== null && readout.focusPackageId !== null) {
          centerOnPackage(host, readout.focusPackageId);
        }
        // A focus request (search hit) is centred LAST, after the readable
        // default's package jump: the reader asked for THIS node, so it wins.
        // The marker is what tests and sibling panels read; the scroll is the
        // actual "jump to it".
        if (focusNodeId !== null) {
          const focused = nodeElement(host, focusNodeId);
          if (focused !== null) {
            focused.classList.add('arch-focus');
            focused.setAttribute('data-architecture-focus-target', focusNodeId);
            centerElementInContainer(host, focused);
          }
        }
        setDrawn({
          view,
          nodes: host.querySelectorAll('[data-entity-id]').length,
          edges: host.querySelectorAll('[data-edge-source]').length,
        });
      } catch (error) {
        if (cancelled) return;
        host.innerHTML = '';
        setDrawn(null);
        setLayoutMs(null);
        setFailure(error instanceof Error ? error.message : 'unknown render error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [applyZoom, focusNodeId, graph, idShape, layoutAspect, view]);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const nodeFrom = (target: EventTarget | null): Element | null =>
      target instanceof Element ? target.closest('[data-entity-id]') : null;

    const onMouseOver = (event: MouseEvent): void => {
      const node = nodeFrom(event.target);
      const id = node?.getAttribute('data-entity-id') ?? null;
      if (id === null) return;
      highlightRelations(host, id);
      // The contract's hovered node is the one the panel handed over. Group and
      // stub nodes are view scaffolding, not entities, so they have none and
      // report no hover (their highlight still works).
      const hoveredNode = graphRef.current.nodes.find((candidate) => candidate.id === id);
      if (hoveredNode !== undefined) {
        hoverCallbackRef.current?.({ node: hoveredNode, relations: relationsOf(host, id) });
      }
    };

    const onMouseOut = (event: MouseEvent): void => {
      const node = nodeFrom(event.target);
      if (node === null) return;
      const next = event.relatedTarget;
      if (next instanceof Node && node.contains(next)) return;
      // Hover is transient; a pinned selection is restored when the pointer leaves.
      highlightSelection(host, selectedRef.current);
      hoverCallbackRef.current?.(null);
    };

    // Record how the press that produces the next click was made. Mouse clicks
    // keep the original single-click navigation; a touch tap only selects.
    const onPointerDown = (event: PointerEvent): void => {
      lastPointerTypeRef.current = event.pointerType ?? null;
    };

    /** Pin an entity's highlight and announce it to sibling panels. */
    const selectEntity = (id: string): void => {
      selectedRef.current = id;
      highlightRelations(host, id);
      const clickedNode = graphRef.current.nodes.find((candidate) => candidate.id === id);
      if (clickedNode === undefined) return;
      // The JSON lookup is what sibling panels receive, independent of the
      // hops the drill gesture expands.
      announceSelection(graphRef.current, id);
      clickCallbackRef.current?.(clickedNode);
    };

    const onClick = (event: MouseEvent): void => {
      const isTouchTap = lastPointerTypeRef.current === 'touch';
      lastPointerTypeRef.current = null;
      const id = nodeFrom(event.target)?.getAttribute('data-entity-id') ?? null;
      if (id === null) {
        // Clicking the background is the "clear the pinned selection" gesture.
        selectedRef.current = null;
        setSelectedId(null);
        setSelectedByTouch(false);
        clearHighlight(host);
        hoverCallbackRef.current?.(null);
        return;
      }
      if (id.startsWith(STUB_PREFIX)) return;

      if (id.startsWith(GROUP_PREFIX)) {
        // A group is view scaffolding: selecting it marks the node but does not
        // announce an entity to sibling panels.
        selectedRef.current = id;
        highlightRelations(host, id);
      } else {
        if (!graphRef.current.nodes.some((candidate) => candidate.id === id)) return;
        selectEntity(id);
      }
      setSelectedId(id);
      setSelectedByTouch(isTouchTap);

      if (!isTouchTap) {
        // Desktop: one click is both the selection and the navigation.
        drillInto(id);
        return;
      }
      // Touch: the first tap only selects — the drawing must not re-lay out
      // under the finger. A second tap on the same node inside the double-tap
      // window is the explicit drill command.
      const last = lastTapRef.current;
      lastTapRef.current = { id, at: event.timeStamp };
      if (last !== null && last.id === id && event.timeStamp - last.at <= DOUBLE_TAP_MS) {
        lastTapRef.current = null;
        drillInto(id);
      }
    };

    host.addEventListener('pointerdown', onPointerDown);
    host.addEventListener('mouseover', onMouseOver);
    host.addEventListener('mouseout', onMouseOut);
    host.addEventListener('click', onClick);
    return () => {
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('mouseover', onMouseOver);
      host.removeEventListener('mouseout', onMouseOut);
      host.removeEventListener('click', onClick);
    };
  }, [drillInto]);

  // The other direction of the cross-panel linkage: a sibling panel selects an
  // entity by its stable id (e.g. a file referenced in chat). The graph pins the
  // selection and drills into that entity's neighbourhood, all from the payload
  // already in hand — no request.
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const onExternalHighlight = (event: Event): void => {
      const id = (event as CustomEvent<{ id?: unknown }>).detail?.id;
      if (typeof id !== 'string' || id.length === 0) return;
      const node = graphRef.current.nodes.find((candidate) => candidate.id === id);
      if (node === undefined) return;
      selectedRef.current = id;
      setSelectedId(id);
      setSelectedByTouch(false);
      const host = hostRef.current;
      if (host !== null) highlightSelection(host, id);
      const current = viewRef.current;
      const hops = current.kind === 'neighborhood' && current.entityId === id
        ? current.hops + 1
        : DEFAULT_NEIGHBORHOOD_HOPS;
      setView({ kind: 'neighborhood', entityId: id, hops });
    };

    window.addEventListener(ENTITY_HIGHLIGHT_EVENT, onExternalHighlight);
    return () => window.removeEventListener(ENTITY_HIGHLIGHT_EVENT, onExternalHighlight);
  }, []);

  // The canvas is the wheel's ONLY consumer: a wheel turn zooms around the
  // pointer, whether or not Ctrl/Cmd is held (a trackpad pinch arrives as a
  // ctrlKey wheel, so that form keeps working unchanged). A wheel outside the
  // canvas — the toolbar, the chat behind it — never reaches this listener, so
  // scrolling the page elsewhere is untouched.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const onWheel = (event: WheelEvent): void => {
      const viewport = viewportRef.current;
      if (viewport === null) return;
      // The drawing never scrolls under the wheel any more; the zoom below is
      // the whole response, so the browser's own scroll/page zoom must not run.
      event.preventDefault();
      // deltaMode 1 is lines and 2 is pages; normalise so a mouse wheel and a
      // trackpad zoom at comparable rates.
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      const factor = Math.exp(-event.deltaY * unit * 0.0015);
      applyZoom({
        scale: viewport.zoomBy(factor, { clientX: event.clientX, clientY: event.clientY }),
        mode: 'custom',
      });
    };

    // `passive: false` is needed because a passive wheel listener may not call
    // preventDefault — without it the browser's own page zoom would also fire.
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, [applyZoom]);

  // A fit diagram follows the container; a manually zoomed one keeps the size
  // the user chose. The scale is compared before writing state so a burst of
  // observer callbacks cannot re-render in a loop.
  //
  // The same observer is where a SHAPE change is noticed: a resize that only
  // re-fits is cheap, but one that turns the container landscape/portrait makes
  // the drawing's proportions wrong, which only a new layout fixes. That path is
  // behind `shouldRelayoutForAspect`'s threshold and a debounce, so a drag pays
  // for one layout, not one per frame.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => {
      const measured = measureLayoutAspect(host);
      if (shouldRelayoutForAspect(drawnAspectRef.current, measured) && measured !== null) {
        scheduleAspectRelayout(measured);
      }
      if (zoomRef.current.mode !== 'fit') return;
      const viewport = viewportRef.current;
      if (viewport === null) return;
      const drawing = host.querySelector('svg');
      const natural = drawing === null ? null : readSvgNaturalSize(drawing);
      const box = measureViewportSize(host);
      if (natural === null || box === null) return;
      const currentView = viewRef.current;
      const decision = decideReadableZoom({
        fitScale: fitZoomScale(natural, box, MIN_ZOOM_SCALE),
        natural,
        viewport: box,
        hierarchy: seedHierarchyRef.current,
        selectedEntityIds: [
          selectedRef.current,
          currentView.kind === 'neighborhood' ? currentView.entityId : null,
        ],
        mode: readableModeRef.current ?? undefined,
      });
      // A container that shrinks can cross the readable floor, which must move
      // the drawing from overview to focus (and back on growth), so the mode is
      // re-decided here rather than frozen at the drawing's first fit.
      setReadableView((current) => (
        current !== null
          && current.mode === decision.mode
          && current.focusPackageId === decision.focusPackageId
          && current.hint?.packageId === decision.overviewHint?.packageId
          && current.hint?.packageCount === decision.overviewHint?.packageCount
          && current.hint?.zoomPercent === decision.overviewHint?.zoomPercent
          ? current
          : { mode: decision.mode, focusPackageId: decision.focusPackageId, hint: decision.overviewHint }
      ));
      const scale = viewport.zoomTo(decision.scale);
      if (Math.abs(scale - zoomRef.current.scale) < 1e-6) return;
      applyZoom({ scale, mode: 'fit' });
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [applyZoom, scheduleAspectRelayout]);

  // The zoom is read through `zoomRef` when the debounced application runs, so
  // a burst of wheel/resize updates coalesces into one visibility toggle rather
  // than walking every intermediate level.
  useEffect(() => {
    const scheduler = lodSchedulerRef.current;
    if (scheduler === null) return;
    scheduler.request(() => applyLod(zoomRef.current.scale));
  }, [applyLod, zoom.scale]);

  const zoomToScale = (scale: number): void => {
    const viewport = viewportRef.current;
    applyZoom({ scale: viewport?.zoomTo(scale) ?? scale, mode: 'custom' });
  };

  const zoomByStep = (factor: number): void => {
    const viewport = viewportRef.current;
    applyZoom({ scale: viewport?.zoomBy(factor) ?? 1, mode: 'custom' });
  };

  /** Re-apply the readable mode's scale to the drawing already on screen. */
  const applyReadableMode = useCallback((mode: ReadableZoomMode): void => {
    readableModeRef.current = mode;
    setReadableMode(mode);
    const host = hostRef.current;
    const viewport = viewportRef.current;
    if (host === null || viewport === null) return;
    const drawing = host.querySelector('svg');
    const natural = drawing === null ? null : readSvgNaturalSize(drawing);
    const box = measureViewportSize(host);
    if (natural === null || box === null) return;
    const currentView = viewRef.current;
    const decision = decideReadableZoom({
      fitScale: fitZoomScale(natural, box, MIN_ZOOM_SCALE),
      natural,
      viewport: box,
      hierarchy: seedHierarchyRef.current,
      selectedEntityIds: [
        selectedRef.current,
        currentView.kind === 'neighborhood' ? currentView.entityId : null,
      ],
      mode,
    });
    applyZoom({ scale: viewport.zoomTo(decision.scale), mode: 'fit' });
    setReadableView({
      mode: decision.mode,
      focusPackageId: decision.focusPackageId,
      hint: decision.overviewHint,
    });
    if (decision.mode === 'focus' && decision.focusPackageId !== null) {
      centerOnPackage(host, decision.focusPackageId);
    }
  }, [applyZoom]);

  const fitDiagram = (): void => {
    const host = hostRef.current;
    const viewport = viewportRef.current;
    if (host === null || viewport === null) {
      applyZoom({ scale: 1, mode: 'fit' });
      return;
    }
    // "Fit to view" follows the readable mode in force: the whole-graph fit in
    // overview, the readable fit (plus its focus) in focus mode.
    const drawing = host.querySelector('svg');
    const natural = drawing === null ? null : readSvgNaturalSize(drawing);
    const box = measureViewportSize(host);
    if (natural === null || box === null) {
      applyZoom({ scale: viewport.fit(), mode: 'fit' });
      return;
    }
    const currentView = viewRef.current;
    const decision = decideReadableZoom({
      fitScale: fitZoomScale(natural, box, MIN_ZOOM_SCALE),
      natural,
      viewport: box,
      hierarchy: seedHierarchyRef.current,
      selectedEntityIds: [
        selectedRef.current,
        currentView.kind === 'neighborhood' ? currentView.entityId : null,
      ],
      mode: readableModeRef.current ?? undefined,
    });
    applyZoom({ scale: viewport.zoomTo(decision.scale), mode: 'fit' });
    setReadableView({
      mode: decision.mode,
      focusPackageId: decision.focusPackageId,
      hint: decision.overviewHint,
    });
    if (decision.mode === 'focus' && decision.focusPackageId !== null) {
      centerOnPackage(host, decision.focusPackageId);
    }
  };

  /**
   * Keyboard navigation once the canvas has focus: arrows pan, `+`/`-` zoom,
   * `0` fits and `1` returns to natural size. Escape is deliberately NOT bound
   * — the chat page uses it globally to abort a running turn, and a focused
   * diagram must not take it away. Modified presses are left to the browser and
   * the app's shortcuts (Ctrl/Cmd/Alt + key), so nothing global is shadowed.
   */
  const onCanvasKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const host = hostRef.current;
    if (host === null || event.ctrlKey || event.metaKey || event.altKey) return;
    switch (event.key) {
      case 'ArrowLeft':
        host.scrollLeft -= KEYBOARD_PAN_STEP;
        break;
      case 'ArrowRight':
        host.scrollLeft += KEYBOARD_PAN_STEP;
        break;
      case 'ArrowUp':
        host.scrollTop -= KEYBOARD_PAN_STEP;
        break;
      case 'ArrowDown':
        host.scrollTop += KEYBOARD_PAN_STEP;
        break;
      case '+':
      case '=':
        zoomByStep(ZOOM_STEP);
        break;
      case '-':
      case '_':
        zoomByStep(1 / ZOOM_STEP);
        break;
      case '0':
        fitDiagram();
        break;
      case '1':
        zoomToScale(1);
        break;
      default:
        // Anything else (Escape included) keeps its default behaviour.
        return;
    }
    event.preventDefault();
  };

  const viewLabel = view.kind === 'overview'
    ? t('architecture.plantuml.overview', { defaultValue: 'Overview' })
    : view.kind === 'group'
      ? t('architecture.plantuml.group', { defaultValue: 'Group: {{group}}', group: view.prefix })
      : view.kind === 'hierarchy'
        ? t('architecture.plantuml.explosion', { defaultValue: 'Explosion view' })
        : t('architecture.plantuml.neighborhood', {
            defaultValue: '{{entity}} · {{hops}} hop(s)',
            entity: view.entityId,
            hops: view.hops,
          });

  // The explicit drill command is offered only for a touch selection that has
  // not already opened its own view: a desktop click navigated on its own, and
  // a selection whose neighbourhood is on screen has nothing left to drill.
  const selectedPrefix = selectedId !== null && selectedId.startsWith(GROUP_PREFIX)
    ? selectedId.slice(GROUP_PREFIX.length)
    : null;
  const selectionAlreadyOpen = selectedId === null
    || (selectedPrefix !== null
      ? view.kind === 'group' && view.prefix === selectedPrefix
      : view.kind === 'neighborhood' && view.entityId === selectedId);
  const canDrill = selectedByTouch && selectedId !== null && !selectionAlreadyOpen;

  const zoomGroupLabel = t('architecture.plantuml.zoomGroup', { defaultValue: 'Diagram zoom' });
  // The toggle's pressed state follows the user's last explicit choice; before
  // any choice the drawing's own default (readableView) is what is on screen.
  const activeReadableMode: ReadableZoomMode = readableMode ?? readableView?.mode ?? 'focus';
  // What the fit control really does right now. The readable floor raises a
  // geometric fit that would smear the labels, and in that state the control
  // must not claim the whole drawing is on screen (see `fitControlReading`).
  const fitReading = fitControlReading(readableView, zoom.mode);

  /** The 聚焦 / 全貌 switch: focus at the readable floor, or the whole drawing. */
  const readableModeGroup = (
    <span
      role="group"
      aria-label={t('architecture.plantuml.readable.group', { defaultValue: 'Readable zoom mode' })}
      className="flex items-center gap-1 rounded border border-border/60 p-0.5"
    >
      <button
        type="button"
        aria-pressed={activeReadableMode === 'focus'}
        onClick={() => applyReadableMode('focus')}
        data-architecture-readable-focus-mode="true"
        style={touchTargetStyle}
        className={TOOLBAR_BUTTON_CLASS}
      >
        {t('architecture.plantuml.readable.focus', { defaultValue: 'Focus' })}
      </button>
      <button
        type="button"
        aria-pressed={activeReadableMode === 'overview'}
        onClick={() => applyReadableMode('overview')}
        data-architecture-readable-overview-mode="true"
        style={touchTargetStyle}
        className={TOOLBAR_BUTTON_CLASS}
      >
        {t('architecture.plantuml.readable.overview', { defaultValue: 'Overview' })}
      </button>
    </span>
  );

  /**
   * The honest reading of the DEFAULT view: either the aspect fallback notice,
   * the overview's "this is N% — zoom into <package>" hint, or the package the
   * readable default focused. Only one line is shown at a time.
   */
  const readableNotice = collapsedNotice ? (
    <span data-architecture-readable-collapsed="true" className="text-amber-600 dark:text-amber-400">
      {t('architecture.plantuml.readable.collapsed', {
        defaultValue: 'The graph is too wide, so it was collapsed to the directory overview.',
      })}
    </span>
  ) : readableView?.mode === 'overview' && readableView.hint !== null ? (
    <span data-architecture-readable-hint="true">
      {t('architecture.plantuml.readable.overviewHint', {
        defaultValue: 'Zoom {{zoom}}% · zoom in on {{package}} and {{count}} other package(s)',
        zoom: readableView.hint.zoomPercent,
        package: readableView.hint.packageId,
        count: readableView.hint.packageCount,
      })}
    </span>
  ) : readableView?.mode === 'focus' && readableView.focusPackageId !== null ? (
    <span data-architecture-readable-focus="true">
      {t('architecture.plantuml.readable.focusHint', {
        defaultValue: 'Focused on {{package}}',
        package: readableView.focusPackageId,
      })}
    </span>
  ) : null;

  /**
   * The readable focus is not the whole drawing, and the fit control no longer
   * says otherwise — so say where the whole drawing is. It sits beside the
   * focus reading rather than replacing it: the package and the escape are two
   * different facts.
   */
  const fitFocusNotice = fitReading.focusNotice ? (
    <span data-architecture-readable-fit-notice="true">
      {t('architecture.plantuml.readable.focusedFitHint', {
        defaultValue: 'Readable zoom is on, so this is a focus view — choose Overview to see the whole graph.',
      })}
    </span>
  ) : null;

  /**
   * The ONE place the drawing's zoom tier is stated and changed. The review
   * found "Explosion view", "Overview" and "Focus" each expressing the same
   * thing in a different row; they are now a single on-canvas group whose
   * leading label is the current tier. Nothing outside this group names a tier.
   */
  const zoomTierLabel = view.kind === 'hierarchy'
    ? t('architecture.plantuml.explosion', { defaultValue: 'Explosion view' })
    : activeReadableMode === 'overview'
      ? t('architecture.plantuml.readable.overview', { defaultValue: 'Overview' })
      : t('architecture.plantuml.readable.focus', { defaultValue: 'Focus' });

  /** The single place the actual scale is stated, so fit (e.g. 42%) and 100% are distinguishable. */
  const zoomReadout = (
    <span data-architecture-zoom-level className="min-w-9 text-center tabular-nums">
      {Math.round(zoom.scale * 100)}%
    </span>
  );

  const backButton = view.kind === 'overview'
    ? null
    : (
      <button
        type="button"
        onClick={() => setView({ kind: 'overview' })}
        data-architecture-back="true"
        style={touchTargetStyle}
        className={`${TOOLBAR_BUTTON_CLASS} text-left`}
      >
        {t('architecture.plantuml.back', { defaultValue: 'Back to overview' })}
      </button>
    );

  // The explosion view draws the whole graph as one nested hierarchy; zooming it
  // then switches visibility levels instead of re-laying it.
  const explosionButton = view.kind === 'hierarchy'
    ? null
    : (
      <button
        type="button"
        onClick={() => {
          // Asking for the explosion view again re-evaluates the aspect guard;
          // the notice returns only if the canvas is still a band.
          setCollapsedNotice(false);
          setView({ kind: 'hierarchy' });
        }}
        data-architecture-explosion="true"
        style={touchTargetStyle}
        className={`${TOOLBAR_BUTTON_CLASS} text-left`}
      >
        {t('architecture.plantuml.explosion', { defaultValue: 'Explosion view' })}
      </button>
    );

  // The zoom controls live in the on-canvas cluster (bottom right of the
  // drawing), not in the toolbar: they act on the drawing, so they belong on
  // it. 32px targets on a fine pointer, 44px on a coarse one.
  const clusterTargetStyle = touchUi ? TOUCH_TARGET_STYLE : ZOOM_CLUSTER_TARGET_STYLE;

  const zoomOutButton = (
    <button
      type="button"
      onClick={() => zoomByStep(1 / ZOOM_STEP)}
      aria-label={t('architecture.plantuml.zoomOut', { defaultValue: 'Zoom out' })}
      data-architecture-zoom-out="true"
      style={clusterTargetStyle}
      className={TOOLBAR_BUTTON_CLASS}
    >
      −
    </button>
  );

  const zoomInButton = (
    <button
      type="button"
      onClick={() => zoomByStep(ZOOM_STEP)}
      aria-label={t('architecture.plantuml.zoomIn', { defaultValue: 'Zoom in' })}
      data-architecture-zoom-in="true"
      style={clusterTargetStyle}
      className={TOOLBAR_BUTTON_CLASS}
    >
      +
    </button>
  );

  const fitButton = (
    <button
      type="button"
      onClick={fitDiagram}
      aria-pressed={fitReading.pressed}
      data-architecture-zoom-fit="true"
      // The honest reading of what this control applies. `zoom-mode` above keeps
      // its existing fit/custom vocabulary; this is the view the fit lands on.
      data-architecture-zoom-fit-mode={fitReading.mode}
      style={clusterTargetStyle}
      className={TOOLBAR_BUTTON_CLASS}
    >
      {/* The scale action is named "Fit", not after the tier it lands on: the
          tier is stated once, by the zoom-tier group above. */}
      {t('architecture.plantuml.zoomFit', { defaultValue: 'Fit to view' })}
    </button>
  );

  const drillButton = canDrill
    ? (
      <button
        type="button"
        onClick={drillSelected}
        data-architecture-drill-in="true"
        style={touchTargetStyle}
        className={TOOLBAR_BUTTON_CLASS}
      >
        {t('architecture.plantuml.drillIn', { defaultValue: 'Drill in' })}
      </button>
    )
    : null;

  // The single zoom-tier group: the current tier label plus every control that
  // changes it, in ONE place on the drawing.
  const zoomTierGroup = (
    <div
      data-architecture-zoom-tier="true"
      role="group"
      aria-label={t('architecture.plantuml.zoomTier', { defaultValue: 'Zoom level' })}
      className="pointer-events-auto flex flex-wrap items-center gap-1 rounded-lg border border-border/60 bg-background/90 p-1 text-[11px] text-muted-foreground shadow-sm"
    >
      <span data-architecture-zoom-tier-label="true" className="px-1 font-medium text-foreground">
        {zoomTierLabel}
      </span>
      {backButton}
      {explosionButton}
      {readableModeGroup}
      {drillButton}
      {readableNotice}
      {fitFocusNotice}
    </div>
  );

  const exportButton = onExport === undefined
    ? null
    : (
      <button
        type="button"
        // The panel owns the menu this button is drawn into, so closing it is
        // the panel's job too (its `onExport` closes the menu after writing).
        onClick={() => onExport()}
        data-architecture-overflow-export="true"
        style={touchTargetStyle}
        className={`${TOOLBAR_BUTTON_CLASS} text-left`}
      >
        {t('architecture.exportMmd', { defaultValue: 'Export .mmd' })}
      </button>
    );

  // When the panel has a detail knob above this renderer it hands over the two
  // numbers the reader asked about (retained vs. in-scope). Without one — this
  // component rendered directly — the summary stays the local drawn/total
  // reading it always was.
  const visibleSummary = detailReading === undefined ? (
    t('architecture.visibleNodes', {
      defaultValue: '{{visible}} of {{total}} nodes',
      visible: drawn?.view === view ? drawn.nodes : 0,
      total: graph.nodes.length,
    })
  ) : (
    t('architecture.controls.detailReading', {
      defaultValue: 'Showing {{shown}} of {{total}} related nodes',
      shown: detailReading.shown,
      total: detailReading.totalInScope,
    })
  );

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-architecture-plantuml-graph="true"
      data-architecture-view={view.kind}
      data-architecture-hops={view.kind === 'neighborhood' ? view.hops : undefined}
      data-architecture-visible-nodes={drawn?.view === view ? drawn.nodes : 0}
      data-architecture-visible-edges={drawn?.view === view ? drawn.edges : 0}
      data-architecture-zoom-mode={zoom.mode}
      data-architecture-zoom-scale={zoom.scale}
      data-architecture-lod-depth={lodDepth ?? undefined}
      data-architecture-layout-ms={layoutMs ?? undefined}
      data-architecture-readable-mode={readableView?.mode}
      data-architecture-readable-package={readableView?.focusPackageId ?? undefined}
    >
      <style>{HIGHLIGHT_STYLE}</style>
      {compactToolbar ? (
        // On the compact tier the panel already spends the one row it has on
        // the title, granularity and "…"; everything this renderer owns is
        // drawn inside that menu, at the same 44px targets. With the menu shut
        // there is no slot, and drawing no chrome is the point.
        compactToolbarSlot !== null && createPortal(
          <span data-architecture-compact-controls="true" className="flex flex-col gap-1">
            <span className="flex flex-wrap items-center gap-2">
              <span data-architecture-view-label>{viewLabel}</span>
              {zoomTierGroup}
            </span>
            {exportButton}
            <span
              data-architecture-visible-summary
              data-architecture-detail-shown={detailReading?.shown}
              data-architecture-detail-total={detailReading?.totalInScope}
            >
              {visibleSummary}
            </span>
          </span>,
          compactToolbarSlot,
        )
      ) : null}
      <div className="relative min-h-0 flex-1" data-architecture-canvas="true">
        <div
          ref={hostRef}
          role="img"
          aria-label={t('architecture.graphAria', { defaultValue: 'Architecture neighbourhood graph' })}
          // The canvas is its own keyboard target: arrows pan, +/- zoom, 0 fits
          // and 1 is natural size (see `onCanvasKeyDown`). The ring is only drawn
          // for keyboard focus, so a mouse press does not flash a box.
          tabIndex={0}
          className="h-full w-full overflow-auto p-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60"
          // The gestures own every touch on the drawing: without this the browser
          // would pan/zoom the page and the pinch would never reach the controller.
          style={{ touchAction: 'none' }}
          onKeyDown={onCanvasKeyDown}
          data-testid="plantuml-host"
          data-architecture-plantuml="true"
        />
        {/* The drawing's zoom tier, ON the canvas (top-right). One group states
            and changes Focus/Overview/Explosion; no other row repeats it. */}
        {!compactToolbar && (
          <div
            data-architecture-canvas-view-controls="true"
            style={{
              position: 'absolute',
              top: 12,
              right: 12,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-end',
              rowGap: 4,
              maxWidth: '70%',
            }}
            className="z-20 pointer-events-none"
          >
            {zoomTierGroup}
          </div>
        )}
        <div
          data-architecture-canvas-overlays="true"
          // The arrangement is stated inline rather than in utility classes:
          // "one absolute column, positive gap, map before cluster" is what
          // makes the two boxes unable to intersect, and a test can read it
          // without a laid-out browser (the same reason the zoom targets carry
          // inline sizes).
          style={{
            position: 'absolute',
            bottom: 12,
            right: 12,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            rowGap: 8,
          }}
          className="z-20 pointer-events-none"
        >
          <ArchitectureMinimap
            hostRef={hostRef}
            // A new drawing is a new set of node rectangles; the same drawing
            // re-fitted or re-zoomed only moves the range frame.
            revision={drawn}
            scale={zoom.scale}
          />
          {/* The zoom cluster floats at the bottom right OF the drawing: the three
              controls act on it, so they stay next to it instead of in the
              toolbar. The semantic-zoom level is the one place that reading is
              stated, right beside the scale it explains. */}
          <div
            role="group"
            aria-label={zoomGroupLabel}
            data-architecture-zoom-cluster="true"
            className="pointer-events-auto flex flex-col items-center gap-1 rounded-lg border border-border/60 bg-background/90 p-1 shadow-sm"
          >
            {zoomInButton}
            {zoomOutButton}
            {fitButton}
            {zoomReadout}
            {lodDepth !== null && (
              <span data-architecture-lod-label className="whitespace-nowrap text-[10px] tabular-nums text-muted-foreground">
                {lodDepth === 0
                  ? t('architecture.plantuml.lod.packages', { defaultValue: 'Packages' })
                  : lodDepth === 1
                    ? t('architecture.plantuml.lod.subpackages', { defaultValue: 'Subpackages' })
                    : t('architecture.plantuml.lod.entities', { defaultValue: 'Entities' })}
              </span>
            )}
          </div>
        </div>
      </div>
      {failure !== null && (
        <p data-architecture-plantuml-error="true" role="alert" className="px-4 pb-2 text-xs text-destructive">
          {t('architecture.plantuml.error', { defaultValue: 'The diagram could not be rendered: {{message}}', message: failure })}
        </p>
      )}
    </div>
  );
}
