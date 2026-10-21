import cytoscape from 'cytoscape';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  ArchitectureRendererNode,
  ArchitectureRendererProps,
} from '@/modules/architecture/rendererContract';

/**
 * Cytoscape's own option/instance types. The package declares itself with
 * `export =` and overloads its call signature, so `Parameters`/`ReturnType`
 * would read the LAST overload; the namespace-qualified names are the stable
 * place to read them from.
 */
type CytoscapeOptions = cytoscape.CytoscapeOptions;
type CytoscapeCore = cytoscape.Core;

/**
 * UML stereotype shown on an edge's label, keyed by archguard relation type.
 *
 * `inheritance`/`implementation` are absent: their hollow-triangle arrowhead is
 * itself the UML marker, so a label would only repeat it. `dependency`/`call`
 * share the same dashed open arrow (`..>`) and are told apart by these
 * stereotypes; `composition`/`aggregation` share the hollow diamond (`o--`) and
 * are told apart the same way.
 */
const RELATION_STEREOTYPE: Readonly<Record<string, string>> = {
  dependency: '<<uses>>',
  call: '<<call>>',
  composition: '<<field>>',
  aggregation: '<<inject>>',
};

/**
 * The stylesheet: UML class-diagram semantics on a force layout.
 *
 * Node = a class box (round-rectangle, name inside). Edge arrows follow UML:
 *   · dependency / call → dashed open arrow (`..>`) + stereotype;
 *   · composition / aggregation → hollow diamond at the SOURCE, solid line
 *     (`o--`): archguard's "field holds a reference" is aggregation, never UML
 *     composition (`*--`), per the archguard alignment;
 *   · inheritance → hollow triangle, solid line (`--|>`);
 *   · implementation → hollow triangle, dashed line (`..|>`).
 */
const GRAPH_STYLE: NonNullable<CytoscapeOptions['style']> = [
  {
    selector: 'node',
    style: {
      shape: 'roundrectangle',
      width: 'label',
      height: 'label',
      padding: '6px',
      label: 'data(label)',
      color: '#e2e8f0',
      'font-size': 10,
      'text-valign': 'center',
      'text-halign': 'center',
      'text-outline-width': 1,
      'text-outline-color': '#0f172a',
      'background-color': '#334155',
      'border-width': 1,
      'border-color': '#64748b',
    },
  },
  {
    selector: 'node:selected',
    style: { 'background-color': '#0c4a6e', 'border-width': 2, 'border-color': '#38bdf8' },
  },
  {
    // Dependency (`..>`): the default relation — dashed open arrow.
    selector: 'edge',
    style: {
      width: 1.5,
      'line-color': '#64748b',
      'target-arrow-color': '#64748b',
      'target-arrow-shape': 'triangle',
      'target-arrow-fill': 'filled',
      'line-style': 'dashed',
      'curve-style': 'bezier',
      'arrow-scale': 0.9,
      label: 'data(stereotype)',
      'font-size': 8,
      'text-rotation': 'autorotate',
      'text-background-color': '#0f172a',
      'text-background-opacity': 0.8,
      'text-background-padding': '2px',
    },
  },
  { selector: 'edge[relationType = "call"]', style: { 'line-color': '#3b82f6', 'target-arrow-color': '#3b82f6' } },
  {
    // Aggregation (`o--`): hollow diamond at the source; solid line. archguard's
    // "composition" is field-holding, so it shares this arm with `aggregation`.
    selector: 'edge[relationType = "composition"], edge[relationType = "aggregation"]',
    style: {
      'line-style': 'solid',
      'line-color': '#f59e0b',
      'target-arrow-shape': 'none',
      'source-arrow-shape': 'diamond',
      'source-arrow-fill': 'hollow',
      'source-arrow-color': '#f59e0b',
    },
  },
  {
    // Generalization (`--|>`): hollow triangle, solid line.
    selector: 'edge[relationType = "inheritance"]',
    style: {
      'line-style': 'solid',
      'line-color': '#a855f7',
      'target-arrow-color': '#a855f7',
      'target-arrow-shape': 'triangle',
      'target-arrow-fill': 'hollow',
    },
  },
  {
    // Realization (`..|>`): hollow triangle, dashed line.
    selector: 'edge[relationType = "implementation"]',
    style: {
      'line-style': 'dashed',
      'line-color': '#10b981',
      'target-arrow-color': '#10b981',
      'target-arrow-shape': 'triangle',
      'target-arrow-fill': 'hollow',
    },
  },
];

/** Production renderer: the real cytoscape instance in the supplied container. */
function createCytoscape(options: CytoscapeOptions): CytoscapeCore {
  return cytoscape(options);
}

/** Deterministic (distance, id) ordering; `localeCompare` would vary by machine. */
function compareNodes(a: ArchitectureRendererNode, b: ArchitectureRendererNode): number {
  if (a.distance !== b.distance) return a.distance - b.distance;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * Renders one architecture neighbourhood as a force-directed cytoscape graph.
 *
 * Used by ArchitecturePanel as one implementation of the renderer contract
 * (`rendererContract.ts`). All filtering is local: `maxHops` keeps nodes within
 * that many hops of the seeds, `maxNodes` takes a deterministic (distance, id)
 * prefix, and clicking a visible node reveals its immediate neighbours from the
 * SAME payload — none of these re-enter the fetch. Hovering a node reports its
 * visible relation kinds through `onNodeHover`; the panel owns the readout so
 * every renderer shows it. The graph keeps cytoscape's built-in drag, pan and
 * wheel-zoom interactions.
 */
export function CytoscapeGraph({
  graph,
  maxNodes,
  maxHops,
  onNodeClick,
  onNodeHover,
}: ArchitectureRendererProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
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
      .filter((node): node is ArchitectureRendererNode => node !== undefined)
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
          stereotype: RELATION_STEREOTYPE[edge.relationType] ?? '',
        },
      })),
    ];

    const cy = createCytoscape({
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
    const nodeOf = (nodeId: string): ArchitectureRendererNode | undefined =>
      visible.nodes.find((node) => node.id === nodeId);

    cy.on('mouseover', 'node', (event) => {
      const nodeId = String(event.target.id());
      const node = nodeOf(nodeId);
      if (node === undefined) return;
      onNodeHover?.({ node, relations: relationsOf(nodeId) });
    });
    cy.on('mouseout', 'node', () => onNodeHover?.(null));
    cy.on('tap', 'node', (event) => {
      const nodeId = String(event.target.id());
      setExpanded((previous) => (previous.includes(nodeId) ? previous : [...previous, nodeId]));
      const node = nodeOf(nodeId);
      if (node !== undefined) onNodeClick?.(node);
    });

    return () => {
      cy.destroy();
    };
  }, [visible, onNodeClick, onNodeHover]);

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-architecture-cytoscape-graph="true"
      data-architecture-visible-nodes={visible.nodes.length}
      data-architecture-visible-edges={visible.edges.length}
    >
      <div className="flex flex-wrap items-center justify-end gap-2 border-b border-border/40 px-4 py-1 text-[11px] text-muted-foreground">
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
