import cytoscape from 'cytoscape';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  ArchitectureNeighborhood,
  ArchitectureNeighborhoodNode,
} from '@/modules/architecture/useArchitectureGraph';

/**
 * Cytoscape's own option/instance types. The package declares itself with
 * `export =` and overloads its call signature, so `Parameters`/`ReturnType`
 * would read the LAST overload; the namespace-qualified names are the stable
 * place to read them from.
 */
type CytoscapeOptions = cytoscape.CytoscapeOptions;
type CytoscapeCore = cytoscape.Core;

/** Builds the renderer; injectable so a jsdom test can run the real engine headless. */
type CytoscapeRendererFactory = (options: CytoscapeOptions) => CytoscapeCore;

type CytoscapeGraphProps = {
  /** The server's neighbourhood JSON for the selected granularity, already fetched whole. */
  graph: ArchitectureNeighborhood;
  /**
   * Local node budget (the `maxNodes` slider). Applied as a deterministic
   * (distance, id) prefix here — it never re-enters the network.
   */
  maxNodes: number;
  /**
   * Local hop budget (the `maxHops` slider). Nodes farther than this are hidden
   * until the user clicks a node to expand its next hop.
   */
  maxHops: number;
  /** Test seam: architectureTab.test.tsx substitutes a headless renderer of the same engine. */
  createRenderer?: CytoscapeRendererFactory;
};

/** The stylesheet: a force-layout look plus one arrow colour per relation kind. */
const GRAPH_STYLE: NonNullable<CytoscapeOptions['style']> = [
  {
    selector: 'node',
    style: {
      'background-color': '#64748b',
      label: 'data(label)',
      color: '#e2e8f0',
      'font-size': 10,
      'text-valign': 'bottom',
      'text-margin-y': 4,
      'text-outline-width': 2,
      'text-outline-color': '#0f172a',
      width: 18,
      height: 18,
    },
  },
  {
    selector: 'node:selected',
    style: { 'background-color': '#38bdf8', 'border-width': 2, 'border-color': '#0ea5e9' },
  },
  {
    selector: 'edge',
    style: {
      width: 1.5,
      'line-color': '#64748b',
      'target-arrow-color': '#64748b',
      'target-arrow-shape': 'triangle',
      'curve-style': 'bezier',
      'arrow-scale': 0.8,
    },
  },
  { selector: 'edge[relationType = "call"]', style: { 'line-color': '#3b82f6', 'target-arrow-color': '#3b82f6' } },
  {
    selector: 'edge[relationType = "composition"]',
    style: { 'line-color': '#f59e0b', 'target-arrow-color': '#f59e0b' },
  },
  {
    selector: 'edge[relationType = "inheritance"]',
    style: { 'line-color': '#a855f7', 'target-arrow-color': '#a855f7' },
  },
  {
    selector: 'edge[relationType = "implementation"]',
    style: { 'line-color': '#10b981', 'target-arrow-color': '#10b981' },
  },
];

/** Production renderer: the real cytoscape instance in the supplied container. */
function createCytoscape(options: CytoscapeOptions): CytoscapeCore {
  return cytoscape(options);
}

/** Deterministic (distance, id) ordering; `localeCompare` would vary by machine. */
function compareNodes(a: ArchitectureNeighborhoodNode, b: ArchitectureNeighborhoodNode): number {
  if (a.distance !== b.distance) return a.distance - b.distance;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * Renders one architecture neighbourhood as a force-directed cytoscape graph.
 *
 * Used by ArchitecturePanel. All filtering is local: `maxHops` keeps nodes
 * within that many hops of the seeds, `maxNodes` takes a deterministic
 * (distance, id) prefix, and clicking a visible node reveals its immediate
 * neighbours from the SAME payload — none of these re-enter the fetch. Hovering
 * a node reports the relation types of its visible edges; the graph keeps
 * cytoscape's built-in drag, pan and wheel-zoom interactions.
 */
export function CytoscapeGraph({
  graph,
  maxNodes,
  maxHops,
  createRenderer = createCytoscape,
}: CytoscapeGraphProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  // The node under the cursor and the relation kinds on its visible edges. Kept
  // apart from the graph itself so hovering never re-creates the renderer.
  const [hovered, setHovered] = useState<{ nodeId: string; relations: string[] } | null>(null);
  // Nodes the user clicked. Each click reveals that node's immediate neighbours
  // from the already-fetched payload; expansion is per-node and additive. The
  // panel keys this component by session+granularity, so a new payload remounts
  // and cannot inherit expansions that name nodes of the previous one.
  const [expanded, setExpanded] = useState<readonly string[]>([]);

  const visible = useMemo(() => {
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    const neighbours = new Map<string, string[]>();
    const addNeighbour = (from: string, to: string): void => {
      const list = neighbours.get(from);
      if (list === undefined) neighbours.set(from, [to]);
      else list.push(to);
    };
    for (const edge of graph.edges) {
      addNeighbour(edge.from, edge.to);
      addNeighbour(edge.to, edge.from);
    }

    const candidateIds = new Set<string>();
    for (const node of graph.nodes) {
      if (node.distance <= maxHops) candidateIds.add(node.id);
    }
    for (const id of expanded) {
      for (const neighbour of neighbours.get(id) ?? []) candidateIds.add(neighbour);
    }

    const nodes = [...candidateIds]
      .map((id) => nodeById.get(id))
      .filter((node): node is ArchitectureNeighborhoodNode => node !== undefined)
      .sort(compareNodes)
      .slice(0, Math.max(0, maxNodes));
    const visibleIds = new Set(nodes.map((node) => node.id));
    const edges = graph.edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to));
    return { nodes, edges };
  }, [graph, maxHops, maxNodes, expanded]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const elements: NonNullable<CytoscapeOptions['elements']> = [
      ...visible.nodes.map((node) => ({
        data: { id: node.id, label: node.label, distance: node.distance },
      })),
      ...visible.edges.map((edge, index) => ({
        data: {
          id: `edge-${String(index)}`,
          source: edge.from,
          target: edge.to,
          relationType: edge.relationType,
        },
      })),
    ];

    const cy = createRenderer({
      container,
      elements,
      style: GRAPH_STYLE,
      layout: { name: 'cose', animate: false, fit: true, padding: 30 },
      userZoomingEnabled: true,
      userPanningEnabled: true,
      boxSelectionEnabled: false,
    });

    const relationsOf = (nodeId: string): string[] => {
      const relations = new Set<string>();
      for (const edge of visible.edges) {
        if (edge.from === nodeId || edge.to === nodeId) relations.add(edge.relationType);
      }
      return [...relations].sort();
    };

    cy.on('mouseover', 'node', (event) => {
      const nodeId = String(event.target.id());
      setHovered({ nodeId, relations: relationsOf(nodeId) });
    });
    cy.on('mouseout', 'node', () => setHovered(null));
    cy.on('tap', 'node', (event) => {
      const nodeId = String(event.target.id());
      setExpanded((previous) => (previous.includes(nodeId) ? previous : [...previous, nodeId]));
    });

    return () => {
      cy.destroy();
    };
  }, [visible, createRenderer]);

  const relationsText = hovered === null || hovered.relations.length === 0
    ? t('architecture.hover.none', { defaultValue: 'no outgoing/incoming relation' })
    : hovered.relations.join(', ');

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-architecture-cytoscape-graph="true"
      data-architecture-visible-nodes={visible.nodes.length}
      data-architecture-visible-edges={visible.edges.length}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 px-4 py-1 text-[11px] text-muted-foreground">
        <span data-architecture-hover={hovered?.nodeId} data-architecture-hover-relations={hovered?.relations.join(',')}>
          {hovered === null
            ? t('architecture.expandHint', {
                defaultValue: 'Hover a node for its relation types; click a node to expand its next hop.',
              })
            : t('architecture.hover.relations', {
                defaultValue: '{{node}} — relations: {{relations}}',
                node: hovered.nodeId,
                relations: relationsText,
              })}
        </span>
        <span data-architecture-visible-summary>
          {t('architecture.visibleNodes', {
            defaultValue: '{{visible}} of {{total}} nodes',
            visible: visible.nodes.length,
            total: graph.nodes.length,
          })}
        </span>
      </div>
      <div
        ref={containerRef}
        role="img"
        aria-label={t('architecture.graphAria', { defaultValue: 'Architecture neighbourhood graph' })}
        className="min-h-0 flex-1"
        data-testid="cytoscape-host"
        data-architecture-cytoscape="true"
      />
    </div>
  );
}
