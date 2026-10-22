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
 * `distance` plus a RESERVED optional `type` and the optional entity detail
 * (`kind`/`members`), an edge is `from`/`to`/`relationType`. The wire payload
 * satisfies these types structurally, so no per-renderer mapping step is
 * needed.
 */

/**
 * One graph node. `id` keys the node and its edges, `label` is what a renderer
 * draws, and `distance` is the server's hop count from the transcript's seeds
 * (a renderer may use it to lay out or filter without re-deriving the BFS).
 *
 * `type` is reserved for a future node-kind discriminator; the server does not
 * emit it yet, and it stays optional so a payload without it is valid.
 *
 * `kind`/`members` are the server's entity detail (see the backend generator's
 * `EntityKind`/`EntityMember`): the normalised UML kind and the class/interface
 * body. They are OPTIONAL on purpose — the file graph never carries them, an
 * entity whose `arch.json` was unusable carries neither, and a payload written
 * before they existed stays valid. This contract only forwards them; no
 * renderer change is implied by their presence.
 */
export type ArchitectureRendererNode = {
  readonly id: string;
  readonly label: string;
  readonly distance: number;
  readonly type?: string;
  readonly kind?: ArchitectureEntityKind;
  readonly members?: readonly ArchitectureEntityMember[];
};

/**
 * The normalised kind of an entity node, mirroring the server's vocabulary.
 * `abstract` is a class flagged abstract upstream, and `other` is a real entity
 * whose ArchGuard kind this client does not recognise (never a missing one).
 */
export type ArchitectureEntityKind = 'class' | 'interface' | 'enum' | 'abstract' | 'function' | 'other';

/** Whether a member is drawn in the attribute or the operation compartment. */
export type ArchitectureEntityMemberKind = 'field' | 'method';

/**
 * One member of an entity box. `signature` is the server's display-ready
 * one-liner (a method's parameters/return type, or a field's declared type) and
 * is absent when upstream recorded none; it is never parsed back.
 */
export type ArchitectureEntityMember = {
  readonly name: string;
  readonly kind: ArchitectureEntityMemberKind;
  readonly visibility?: string;
  readonly signature?: string;
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

/**
 * How the server shapes a graph's node ids. The panel reads BOTH subgraphs from
 * one payload and knows which one it is handing over; the two are produced by
 * different id schemes, so a renderer that derives labels or package paths from
 * ids has to be told which one it got:
 *  · `project-relative` (file graph): the id IS the project-relative file path
 *    (`scripts/stamp-version.ts`, `packages/quay/src/cli/action.ts`), so its
 *    first segment is a REAL directory;
 *  · `scope-prefixed` (entity graph): the id is
 *    `<scopeKey>/<scope-relative path>.<Entity>` (`26b300e9/cli/action.ts.run`),
 *    where the opaque ArchGuard scope key is not part of the path and is the
 *    only segment safe to strip.
 * Consumers: `ArchitecturePanel.tsx` (the producer of this fact) and
 * `PlantUmlGraph.tsx` (the consumer).
 */
export type ArchitectureNodeIdShape = 'project-relative' | 'scope-prefixed';

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
 *
 * `idShape` is optional and defaults to `scope-prefixed` (the entity scheme,
 * which the bridge's raw contract was written against): a renderer that reads
 * paths out of ids must apply it, while one that draws ids verbatim ignores it.
 * The panel always supplies it, so a file graph is never misread as
 * scope-prefixed.
 */
export type ArchitectureRendererProps = {
  readonly graph: ArchitectureRendererGraph;
  readonly idShape?: ArchitectureNodeIdShape;
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
