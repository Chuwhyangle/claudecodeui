import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  archguardToPlantUml,
  DEFAULT_NEIGHBORHOOD_HOPS,
  OVERVIEW_DEPTH,
  type ArchitectureDiagramView,
  type ArchitecturePlantUml,
} from '@/modules/architecture/archguardToPlantUml';
import type {
  ArchitectureRendererNode,
  ArchitectureRendererProps,
} from '@/modules/architecture/rendererContract';

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

type PlantUmlRendererFactory = (options: { layout: 'elk'; view?: PlantUmlView }) => PlantUmlRenderer;

/** The alias marker the renderer prefixes on overview group nodes (`grp::<path prefix>`). */
const GROUP_PREFIX = 'grp::';
/** Stub nodes in a view (external neighbours) are not real entities; clicks ignore them. */
const STUB_PREFIX = 'stub::';

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
): { layout: 'elk'; view?: PlantUmlView } {
  if (view.kind === 'overview') return { layout: 'elk', view: { kind: 'overview', depth: OVERVIEW_DEPTH } };
  if (view.kind === 'neighborhood' && diagram.rendererEntity !== null) {
    return {
      layout: 'elk',
      view: { kind: 'neighborhood', entity: diagram.rendererEntity, hops: view.hops },
    };
  }
  return { layout: 'elk' };
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
 * Hovering a node highlights its in/out edges and dims the rest. Every view is
 * local: nothing here re-enters the fetch. The renderer package is imported
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
  useEffect(() => {
    viewRef.current = view;
    graphRef.current = graph;
    hoverCallbackRef.current = onNodeHover;
    clickCallbackRef.current = onNodeClick;
  }, [view, graph, onNodeHover, onNodeClick]);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    let cancelled = false;
    setFailure(null);
    hoverCallbackRef.current?.(null);

    void (async () => {
      try {
        // The only plantuml-js/elkjs import in the module graph: Vite emits it
        // as its own async chunk, so the first-screen bundle stays untouched.
        const { createRenderer } = (await import('@yalehwang/plantuml-js/elk')) as unknown as {
          createRenderer: PlantUmlRendererFactory;
        };
        if (cancelled) return;

        const diagram = archguardToPlantUml(graph, { view });
        const renderer = createRenderer(rendererOptionsFor(view, diagram));
        const { svg } = await renderer.render(diagram.puml);
        if (cancelled) return;

        host.innerHTML = svg;
        restoreEntityIds(host, diagram.aliasOf);
        if (view.kind === 'neighborhood') {
          const center = diagram.rendererEntity;
          if (center !== null) {
            const id = reverseAliases(diagram.aliasOf).get(center);
            if (id !== undefined) nodeElement(host, id)?.classList.add('arch-center');
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
        setFailure(error instanceof Error ? error.message : 'unknown render error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [graph, view]);

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
      clearHighlight(host);
      hoverCallbackRef.current?.(null);
    };

    const onClick = (event: MouseEvent): void => {
      const node = nodeFrom(event.target);
      const id = node?.getAttribute('data-entity-id') ?? null;
      if (id === null || id.startsWith(STUB_PREFIX)) return;
      if (id.startsWith(GROUP_PREFIX)) {
        setView({ kind: 'group', prefix: id.slice(GROUP_PREFIX.length) });
        return;
      }
      const clickedNode = graphRef.current.nodes.find((candidate) => candidate.id === id);
      if (clickedNode !== undefined) clickCallbackRef.current?.(clickedNode);
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

  const viewLabel = view.kind === 'overview'
    ? t('architecture.plantuml.overview', { defaultValue: 'Overview' })
    : view.kind === 'group'
      ? t('architecture.plantuml.group', { defaultValue: 'Group: {{group}}', group: view.prefix })
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
          <span data-architecture-view-label>{viewLabel}</span>
          {/* The hover READOUT is the panel's renderer-neutral bar; this is the
              view's own gesture hint, so it never repeats that reading. */}
          <span>
            {t('architecture.plantuml.hint', {
              defaultValue: 'Hover a node to highlight its relations; click a group to expand it, or a node to drill into its neighbourhood.',
            })}
          </span>
        </span>
        <span data-architecture-visible-summary>
          {t('architecture.visibleNodes', {
            defaultValue: '{{visible}} of {{total}} nodes',
            visible: drawn?.view === view ? drawn.nodes : 0,
            total: graph.nodes.length,
          })}
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
