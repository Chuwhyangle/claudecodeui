import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  archguardToPlantUml,
  DEFAULT_NEIGHBORHOOD_HOPS,
  OVERVIEW_DEPTH,
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
} from '@/modules/architecture/elkAspectEngine';
import type { ArchitectureHierarchyIndex } from '@/modules/architecture/hierarchyIndex';
import type {
  ArchitectureRendererGraph,
  ArchitectureRendererProps,
} from '@/modules/architecture/rendererContract';
import {
  createSvgViewport,
  ZOOM_STEP,
  type SvgViewportController,
} from '@/modules/architecture/svgViewport';

/**
 * The renderer options this component drives. Structural subsets of the
 * package's `RendererOptions` / `ViewSpec`, so the lazily imported module is
 * typed without importing its types into the first-screen chunk.
 */
type PlantUmlView =
  | { kind: 'overview'; depth: number }
  | { kind: 'neighborhood'; entity: string; hops: number };

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
  [data-architecture-plantuml] svg { display: block; margin: 0 auto; }
`;

/**
 * The renderer-local budget hints are accepted (the contract carries them) but
 * deliberately unused: the overview/group/neighbourhood views below derive what
 * is visible from the graph itself, which is this renderer's replacement for
 * the old maxHops/maxNodes truncation.
 */
type PlantUmlGraphProps = ArchitectureRendererProps;

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

/** The renderer options for one view; a group view renders its filtered subgraph whole. */
function rendererOptionsFor(
  view: ArchitectureDiagramView,
  diagram: ArchitecturePlantUml,
  layout: ArchitectureLayoutEngine,
): { layout: ArchitectureLayoutEngine; view?: PlantUmlView } {
  if (view.kind === 'overview') {
    return { layout, view: { kind: 'overview', depth: OVERVIEW_DEPTH } };
  }
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

/** Remove every highlight class the hover interaction may have added. */
function clearHighlight(host: HTMLElement): void {
  for (const element of host.querySelectorAll('.arch-dim, .arch-hl-in, .arch-hl-out')) {
    element.classList.remove('arch-dim', 'arch-hl-in', 'arch-hl-out');
  }
}

/**
 * Dim everything except the hovered node and its one-hop neighbourhood, and
 * mark its outgoing (`arch-hl-out`) and incoming (`arch-hl-in`) edges.
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
export function PlantUmlGraph({ graph, onNodeClick, onNodeHover }: PlantUmlGraphProps) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Which slice of the payload is drawn. Local by construction: the payload is
  // fetched whole, so switching views must never re-request it.
  const [view, setView] = useState<ArchitectureDiagramView>({ kind: 'overview' });
  // What the last render actually drew; drives the visible-count readout and
  // lets a test tell a stale SVG from the new view's SVG.
  const [drawn, setDrawn] = useState<{ view: ArchitectureDiagramView; nodes: number; edges: number } | null>(null);
  // A failed render is shown instead of the previous (now stale) diagram.
  const [failure, setFailure] = useState<string | null>(null);
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
    // A reloaded graph may not contain the previously selected entity.
    if (selectedRef.current !== null && !graph.nodes.some((node) => node.id === selectedRef.current)) {
      selectedRef.current = null;
    }

    void (async () => {
      try {
        // The only plantuml-js/elkjs import in the module graph: Vite emits it
        // as its own async chunk, so the first-screen bundle stays untouched.
        const { createRenderer, ElkLayoutEngine } = (await import('@yalehwang/plantuml-js/elk')) as unknown as {
          createRenderer: PlantUmlRendererFactory;
          ElkLayoutEngine: new () => ArchitectureLayoutEngine;
        };
        if (cancelled) return;

        // The container's shape is a LAYOUT input, not a post-render scale: the
        // engine is built with it so ELK draws for this container instead of
        // for its own default proportions.
        const drawnAspect = layoutAspect ?? measureLayoutAspect(host);
        const engine = createLayoutEngine({
          aspectRatio: drawnAspect,
          engine: new ElkLayoutEngine(),
        });
        const diagram = archguardToPlantUml(graph, { view });
        const renderer = createRenderer(rendererOptionsFor(view, diagram, engine));
        const { svg } = await renderer.render(diagram.puml);
        if (cancelled) return;

        host.innerHTML = svg;
        drawnAspectRef.current = drawnAspect;
        restoreEntityIds(host, diagram.aliasOf);
        // Every view has its own natural size, so the scale is re-derived here
        // rather than carried over; the fit/custom MODE survives so the resize
        // observer keeps following the container only for a fit user.
        const drawing = host.querySelector('svg');
        const viewport = viewportRef.current;
        let drawnScale = zoomRef.current.scale;
        if (drawing !== null && viewport !== null) {
          viewport.attach(drawing);
          drawnScale = viewport.fit();
          applyZoom({ scale: drawnScale, mode: zoomRef.current.mode });
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
        // at the wrong detail before the debouncer fires. The overview has no
        // entities or package frames to collapse, so it stays out of the LOD.
        //
        // A re-layout of the SAME view (the container's shape changed) is not a
        // new drawing in the user's eyes: keep the level they were reading and
        // re-centre the package they were focused on. Any other drawing derives
        // both from the fresh fit scale.
        const drawingKey = drawingKeyOf(view);
        const carriedDepth = drawingKey === drawnKeyRef.current ? lodDepthRef.current : null;
        drawnKeyRef.current = drawingKey;
        if (view.kind === 'overview') {
          lodRef.current = null;
          lodDepthRef.current = null;
          setLodDepth(null);
        } else {
          const hierarchy = buildExplosionHierarchy(host, graph);
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
        setDrawn({
          view,
          nodes: host.querySelectorAll('[data-entity-id]').length,
          edges: host.querySelectorAll('[data-edge-source]').length,
        });
      } catch (error) {
        if (cancelled) return;
        host.innerHTML = '';
        setDrawn(null);
        setFailure(error instanceof Error ? error.message : 'unknown render error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [applyZoom, graph, layoutAspect, view]);

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

    const onClick = (event: MouseEvent): void => {
      const node = nodeFrom(event.target);
      const id = node?.getAttribute('data-entity-id') ?? null;
      if (id === null) {
        // Clicking the background is the "clear the pinned selection" gesture.
        selectedRef.current = null;
        clearHighlight(host);
        hoverCallbackRef.current?.(null);
        return;
      }
      if (id.startsWith(STUB_PREFIX)) return;
      if (id.startsWith(GROUP_PREFIX)) {
        // Expanding a group is navigation, not entity selection.
        selectedRef.current = null;
        clearHighlight(host);
        setView({ kind: 'group', prefix: id.slice(GROUP_PREFIX.length) });
        return;
      }
      const clickedNode = graphRef.current.nodes.find((candidate) => candidate.id === id);
      if (clickedNode !== undefined) {
        selectedRef.current = id;
        highlightRelations(host, id);
        // The JSON lookup is what sibling panels receive, independent of the
        // hops this click expands.
        announceSelection(graphRef.current, id);
        clickCallbackRef.current?.(clickedNode);
      }
      const current = viewRef.current;
      const hops = current.kind === 'neighborhood' && current.entityId === id
        ? current.hops + 1
        : DEFAULT_NEIGHBORHOOD_HOPS;
      setView({ kind: 'neighborhood', entityId: id, hops });
    };

    host.addEventListener('mouseover', onMouseOver);
    host.addEventListener('mouseout', onMouseOut);
    host.addEventListener('click', onClick);
    return () => {
      host.removeEventListener('mouseover', onMouseOver);
      host.removeEventListener('mouseout', onMouseOut);
      host.removeEventListener('click', onClick);
    };
  }, []);

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

  // Ctrl/Cmd + wheel zooms around the pointer; a plain wheel is left to the
  // container so the diagram still scrolls normally (no preventDefault).
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      const viewport = viewportRef.current;
      if (viewport === null) return;
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
      const scale = viewport.fit();
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

  const fitDiagram = (): void => {
    const viewport = viewportRef.current;
    applyZoom({ scale: viewport?.fit() ?? 1, mode: 'fit' });
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
    >
      <style>{HIGHLIGHT_STYLE}</style>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 px-4 py-1 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-2">
          {view.kind !== 'overview' && (
            <button
              type="button"
              onClick={() => setView({ kind: 'overview' })}
              data-architecture-back="true"
              className="rounded border border-border px-1.5 py-0.5 text-[11px] font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              {t('architecture.plantuml.back', { defaultValue: 'Back to overview' })}
            </button>
          )}
          {view.kind !== 'hierarchy' && (
            // The explosion view draws the whole graph as one nested hierarchy;
            // zooming it then switches visibility levels instead of re-laying it.
            <button
              type="button"
              onClick={() => setView({ kind: 'hierarchy' })}
              data-architecture-explosion="true"
              className="rounded border border-border px-1.5 py-0.5 text-[11px] font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              {t('architecture.plantuml.explosion', { defaultValue: 'Explosion view' })}
            </button>
          )}
          <span data-architecture-view-label>{viewLabel}</span>
          {/* The semantic-zoom level currently shown. It is the diagram's own
              reading of the scale, so it changes only after the debounce. */}
          {lodDepth !== null && (
            <span data-architecture-lod-label className="tabular-nums">
              {lodDepth === 0
                ? t('architecture.plantuml.lod.packages', { defaultValue: 'Packages' })
                : lodDepth === 1
                  ? t('architecture.plantuml.lod.subpackages', { defaultValue: 'Subpackages' })
                  : t('architecture.plantuml.lod.entities', { defaultValue: 'Entities' })}
            </span>
          )}
          {/* The hover READOUT is the panel's renderer-neutral bar; this is the
              view's own gesture hint, so it never repeats that reading. */}
          <span>
            {t('architecture.plantuml.hint', {
              defaultValue: 'Hover a node to highlight its relations; click a group to expand it, or a node to drill into its neighbourhood.',
            })}
          </span>
        </span>
        <span className="flex items-center gap-2">
          <span
            role="group"
            aria-label={t('architecture.plantuml.zoomGroup', { defaultValue: 'Diagram zoom' })}
            className="flex items-center gap-1"
          >
            <button
              type="button"
              onClick={() => zoomByStep(1 / ZOOM_STEP)}
              aria-label={t('architecture.plantuml.zoomOut', { defaultValue: 'Zoom out' })}
              data-architecture-zoom-out="true"
              className="rounded border border-border px-1.5 py-0.5 text-[11px] font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              −
            </button>
            {/* The readout is the single place the actual scale is stated, so a
                fit scale (e.g. 42%) and an explicit 100% are distinguishable. */}
            <span data-architecture-zoom-level className="min-w-9 text-center tabular-nums">
              {Math.round(zoom.scale * 100)}%
            </span>
            <button
              type="button"
              onClick={() => zoomByStep(ZOOM_STEP)}
              aria-label={t('architecture.plantuml.zoomIn', { defaultValue: 'Zoom in' })}
              data-architecture-zoom-in="true"
              className="rounded border border-border px-1.5 py-0.5 text-[11px] font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              +
            </button>
            <button
              type="button"
              onClick={fitDiagram}
              aria-pressed={zoom.mode === 'fit'}
              data-architecture-zoom-fit="true"
              className="rounded border border-border px-1.5 py-0.5 text-[11px] font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              {t('architecture.plantuml.zoomFit', { defaultValue: 'Fit to view' })}
            </button>
            <button
              type="button"
              onClick={() => zoomToScale(1)}
              aria-pressed={zoom.mode === 'custom' && Math.abs(zoom.scale - 1) < 1e-6}
              data-architecture-zoom-actual="true"
              className="rounded border border-border px-1.5 py-0.5 text-[11px] font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              {t('architecture.plantuml.zoomActual', { defaultValue: 'Actual size (100%)' })}
            </button>
          </span>
          <span data-architecture-visible-summary>
            {t('architecture.visibleNodes', {
              defaultValue: '{{visible}} of {{total}} nodes',
              visible: drawn?.view === view ? drawn.nodes : 0,
              total: graph.nodes.length,
            })}
          </span>
        </span>
      </div>
      <div
        ref={hostRef}
        role="img"
        aria-label={t('architecture.graphAria', { defaultValue: 'Architecture neighbourhood graph' })}
        className="min-h-0 flex-1 overflow-auto p-3"
        data-testid="plantuml-host"
        data-architecture-plantuml="true"
      />
      {failure !== null && (
        <p data-architecture-plantuml-error="true" role="alert" className="px-4 pb-2 text-xs text-destructive">
          {t('architecture.plantuml.error', { defaultValue: 'The diagram could not be rendered: {{message}}', message: failure })}
        </p>
      )}
    </div>
  );
}
