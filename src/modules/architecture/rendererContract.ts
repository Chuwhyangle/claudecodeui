import type { ComponentType } from 'react';

/**
 * The architecture tab's renderer contract.
 *
 * The panel talks to whatever draws the graph THROUGH this file only: the
 * neighbourhood JSON, the optional local view budgets, and the hover/click
 * callbacks. `PlantUmlGraph` is the current implementation; adding a new
 * renderer means implementing {@link ArchitectureRendererProps} and passing it
 * to `ArchitecturePanel` as its `renderer` prop — no panel or backend change.
 *
 * The graph shapes mirror the server's neighbourhood JSON schema
 * (`server/modules/architecture/generator.ts`): a node is `id`/`label`/
 * `distance` plus a RESERVED optional `type`, an edge is `from`/`to`/
 * `relationType`. The wire payload satisfies these types structurally, so no
 * per-renderer mapping step is needed.
 */

/**
 * One graph node. `id` keys the node and its edges, `label` is what a renderer
 * draws, and `distance` is the server's hop count from the transcript's seeds
 * (a renderer may use it to lay out or filter without re-deriving the BFS).
 *
 * `type` is reserved for a future node-kind discriminator; the server does not
 * emit it yet, and it stays optional so a payload without it is valid.
 */
export type ArchitectureRendererNode = {
  readonly id: string;
  readonly label: string;
  readonly distance: number;
  readonly type?: string;
};

/** One directed graph edge, carrying ArchGuard's relation kind for styling. */
export type ArchitectureRendererEdge = {
  readonly from: string;
  readonly to: string;
  readonly relationType: string;
};

/**
 * A render-ready neighbourhood: both endpoints of every edge are present in
 * `nodes`, and `nodes` is ordered (distance, id) by the server so a local
 * prefix is deterministic.
 */
export type ArchitectureRendererGraph = {
  readonly nodes: readonly ArchitectureRendererNode[];
  readonly edges: readonly ArchitectureRendererEdge[];
};

/** What a renderer reports while the pointer is over a node. */
export type ArchitectureRendererHover = {
  /** The hovered node, as it was handed to the renderer. */
  readonly node: ArchitectureRendererNode;
  /** Relation kinds of the hovered node's VISIBLE edges, deduplicated and sorted. */
  readonly relations: readonly string[];
};

/**
 * The props every architecture graph renderer accepts. `graph` arrives whole —
 * the panel never re-fetches.
 *
 * `maxHops`/`maxNodes` are OPTIONAL local budgets over that one payload: a
 * renderer that truncates by them (the cytoscape renderer did) may read them,
 * while a renderer with its own view model (PlantUML's overview/group/
 * neighbourhood views) derives what is visible from the graph itself and
 * ignores them. Keeping them optional is what lets the panel drop the
 * truncation sliders without narrowing the contract.
 *
 * `onNodeHover` reports the hovered node and its visible relation kinds (null
 * when the pointer leaves); the panel renders the readout, so it looks the same
 * for every renderer. `onNodeClick` reports a clicked node to whichever consumer
 * needs selection; a renderer may additionally expand the clicked node's next
 * hop locally, which is why the click never re-enters the fetch.
 *
 * `onExport` is optional: a renderer that collects its controls into an
 * overflow menu on narrow screens (PlantUmlGraph does) can offer the panel's
 * export action there too, instead of leaving a second, tiny button in the
 * header. A renderer that does not render it simply ignores it.
 */
export type ArchitectureRendererProps = {
  readonly graph: ArchitectureRendererGraph;
  readonly maxHops?: number;
  readonly maxNodes?: number;
  readonly onNodeClick?: (node: ArchitectureRendererNode) => void;
  readonly onNodeHover?: (hover: ArchitectureRendererHover | null) => void;
  readonly onExport?: () => void;
};

/**
 * A renderer implementation component. Used by `ArchitecturePanel` (its
 * `renderer` prop, defaulting to `PlantUmlGraph`) and by its tests, which pass
 * a stand-in to prove the panel depends on this contract and not on any one
 * rendering library.
 */
export type ArchitectureGraphRenderer = ComponentType<ArchitectureRendererProps>;
