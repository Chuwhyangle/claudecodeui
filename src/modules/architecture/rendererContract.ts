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
  /**
   * How the transcript mentioned this node, on distance-0 nodes only.
   *
   * Optional by design: a payload written before tiers existed carries neither
   * this nor `mentionCount`, and such a node keeps the legacy "distance 0 is a
   * seed" reading. When present, ONLY `'direct'` is drawn as a session seed.
   */
  readonly mentionTier?: ArchitectureMentionTier;
  /** How many messages mentioned the seed this node was resolved from. */
  readonly mentionCount?: number;
};

/**
 * The three provenance tiers a seed can carry (mirrors the server's
 * `MentionTier`): direct mention, same-name candidate, file-only expansion.
 */
export type ArchitectureMentionTier = 'direct' | 'name' | 'file';

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

/**
 * The panel's detail-knob reading, handed to the renderer so the visible-summary
 * slot reports the two numbers the reader actually asked about: `shown` is how
 * many nodes the current detail tier retained, and `totalInScope` is how many
 * were in the graph BEFORE that tier cut it (the scope's total).
 *
 * Optional because a renderer rendered directly (tests, a future embed) has no
 * detail knob above it and must keep reporting its own drawn/total counts.
 */
export type ArchitectureDetailReading = {
  readonly shown: number;
  readonly totalInScope: number;
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
 * for every renderer. `onNodeClick` reports a SINGLE click on a node — the
 * selection gesture that opens the inspector. Drilling one hop deeper is a
 * separate gesture (a double click / double tap, or the renderer's own explicit
 * control) and stays inside the renderer that owns the view.
 *
 * `onEdgeClick` reports a clicked relation with the payload's own
 * from/to/relationType, so the panel can open the relation inspector without
 * knowing how the renderer draws or enlarges its hit area. `onSelectionClear`
 * is the background-click gesture — a renderer reports it when the reader
 * clicks the empty canvas, and the panel drops the selection with it.
 *
 * `selectedNodeId`/`selectedRelation` are the panel's selection, handed back to
 * the renderer for styling (the ring and the bold relation line). They are
 * optional so a stand-in renderer can ignore them.
 *
 * `onEscapeSelection` lets the canvas own Escape while a selection exists: the
 * panel closes the dock first, then clears the selection, and the key never
 * reaches the chat page's global abort. A renderer without a selection does not
 * intercept Escape at all.
 *
 * `relayoutLocked` freezes aspect-driven re-layout (a dock opening or a drag
 * resize changes the container by more than the ratio threshold). While locked
 * the renderer only re-fits; when the lock lifts it re-bases the comparison to
 * the current measurement WITHOUT a layout, so the dock toggle itself is never
 * counted as a shape change.
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
 *
 * `detailReading` is optional: when the panel has a detail knob above the
 * renderer it states the shown/in-scope numbers so the renderer's visible-summary
 * slot can report them instead of its own drawn/total reading. A renderer that
 * ignores it simply keeps the local reading.
 */
export type ArchitectureRendererProps = {
  readonly graph: ArchitectureRendererGraph;
  readonly idShape?: ArchitectureNodeIdShape;
  readonly maxHops?: number;
  readonly maxNodes?: number;
  readonly detailReading?: ArchitectureDetailReading;
  readonly onNodeClick?: (node: ArchitectureRendererNode) => void;
  readonly onEdgeClick?: (edge: ArchitectureRendererEdge) => void;
  readonly onSelectionClear?: () => void;
  readonly onNodeHover?: (hover: ArchitectureRendererHover | null) => void;
  readonly onEscapeSelection?: () => void;
  readonly selectedNodeId?: string | null;
  readonly selectedRelation?: {
    readonly from: string;
    readonly to: string;
    readonly relationType: string;
  } | null;
  readonly relayoutLocked?: boolean;
  readonly onExport?: () => void;
};

/**
 * A renderer implementation component. Used by `ArchitecturePanel` (its
 * `renderer` prop, defaulting to `PlantUmlGraph`) and by its tests, which pass
 * a stand-in to prove the panel depends on this contract and not on any one
 * rendering library.
 */
export type ArchitectureGraphRenderer = ComponentType<ArchitectureRendererProps>;
