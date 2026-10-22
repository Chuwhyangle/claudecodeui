import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  ArchitectureEntityKind,
  ArchitectureMentionTier,
  ArchitectureRendererEdge,
  ArchitectureRendererGraph,
  ArchitectureRendererNode,
} from '@/modules/architecture/rendererContract';
import { api, readApiJson } from '@/shared/api';

/**
 * The neighbourhood's domain names for the renderer contract's graph shapes.
 *
 * The PlantUML bridge and renderer read a "neighbourhood" (nodes with a hop
 * distance, edges with an archguard relation kind); they are the SAME types the
 * contract hands every renderer, aliased here rather than restated so a second
 * definition cannot drift from the interface the panel passes props through.
 */
export type ArchitectureNeighborhoodNode = ArchitectureRendererNode;
export type ArchitectureNeighborhoodEdge = ArchitectureRendererEdge;
export type ArchitectureNeighborhood = ArchitectureRendererGraph;

/** One `.archguard` scope fingerprint the reading was generated from. */
export type ArchitectureProvenanceFingerprint = {
  readonly scope: string;
  readonly archJsonHash: string;
};

/** Why a scope contributed no entity kinds/members (mirrors the server). */
export type ArchitectureDiagnosticCode =
  | 'ARCH_JSON_MISSING'
  | 'ARCH_JSON_UNREADABLE'
  | 'ARCH_JSON_INVALID';

/**
 * One visible reading of a degraded entity-detail source: the scope whose
 * `arch.json` could not be used, why, and a human-readable message. Absent from
 * the provenance entirely when every source was intact.
 */
export type ArchitectureDiagnostic = {
  readonly scope: string;
  readonly code: ArchitectureDiagnosticCode;
  readonly message: string;
};

/** A scope ignored because it does not index this project at all. */
export type ArchitectureDroppedOutsideRootScope = {
  readonly scope: string;
  readonly label: string;
  readonly sources: readonly string[];
};

/** A scope that lost overlapping entities to an outer scope indexing the same file. */
export type ArchitectureSubsumedScope = {
  readonly scope: string;
  readonly label: string;
  readonly intoScope: string;
  readonly droppedEntities: number;
};

/**
 * What the server's scope merge cleaned up: absolute-path ids normalised,
 * overlapping scopes collapsed, and scopes outside the project ignored.
 * Mirrors the server's `ScopeHygiene`; absent from the provenance entirely when
 * the merge changed nothing, so a healthy reading draws no cleanup row.
 */
export type ArchitectureScopeHygiene = {
  readonly total: number;
  readonly kept: number;
  readonly droppedOutsideRoot: readonly ArchitectureDroppedOutsideRootScope[];
  readonly subsumed: readonly ArchitectureSubsumedScope[];
  readonly normalizedAbsoluteIds: number;
};

/**
 * Honesty payload (ADR-005 decision 7): when the ArchGuard analysis behind this
 * reading was produced, which scope fingerprints it used, whether the server
 * answered from its content-addressed result cache, and — optional — any
 * degraded detail source. The panel shows the first three so a user can tell
 * "last analysis" from "live working tree".
 */
export type ArchitectureProvenance = {
  /** `manifest.generatedAt` — the analysis time, not the request time. */
  readonly generatedAt: string | null;
  readonly fingerprints: readonly ArchitectureProvenanceFingerprint[];
  readonly cacheHit: boolean;
  /** Present only when some scope's `arch.json` was missing or unusable. */
  readonly diagnostics?: readonly ArchitectureDiagnostic[];
  /** Present only when the scope merge actually dropped or rewrote something. */
  readonly scopeHygiene?: ArchitectureScopeHygiene;
};

/** How many seeds the session transcript yielded, before any were resolved. */
export type ArchitectureSeedStats = {
  readonly seedFiles: number;
  readonly seedIdentifiers: number;
};

/**
 * The filter a request carries, mirroring the route's optional `kinds`/
 * `relations` body fields.
 *
 * Both are OPTIONAL and absent means "no filter" — the server's old, unfiltered
 * reading. The panel sends `kinds` only for the class (entity) view, because
 * the file graph has no element kind; it sends `relations` for both views,
 * because a file edge carries a relation type too.
 */
export type ArchitectureGraphQuery = {
  readonly kinds?: readonly ArchitectureEntityKind[];
  /**
   * The element filter's per-kind "keep mentioned" switches: kinds whose
   * session-mentioned entities stay drawn even though the kind is hidden.
   * Only meaningful alongside `kinds`, and omitted when empty so a default
   * request stays byte-identical to the pre-switch one.
   */
  readonly keepMentionedKinds?: readonly ArchitectureEntityKind[];
  readonly relations?: readonly string[];
  /** Manual pins: entity ids the reader added as roots (server `extraSeeds`). */
  readonly extraSeeds?: readonly string[];
  /** Manual removals: entity ids dropped before traversal (server `excludeIds`). */
  readonly excludeIds?: readonly string[];
};

/**
 * What a filter removed, mirroring the server's `stats.hidden`. The readout's
 * second line is this reading (plus whatever a narrower client-side selection
 * removes on top of the arrived payload).
 */
export type ArchitectureFilterHiddenStats = {
  readonly byKind: Readonly<Partial<Record<ArchitectureEntityKind, number>>>;
  readonly byRelation: Readonly<Record<string, number>>;
  readonly isolated: number;
  /**
   * The subset of `byKind` the session mentioned directly, per kind. Absent
   * when no mentioned entity was hidden (an older server never sends it), so
   * the readout's "N of them mentioned" clause only appears when it is true.
   */
  readonly mentionedByKind?: Readonly<Partial<Record<ArchitectureEntityKind, number>>>;
  /**
   * Per emitted node, the relations of its own the relation axis hid, by type.
   * The inspector uses it to explain "0 in · 0 out" instead of printing a bare
   * zero; absent when nothing was hidden, so an unfiltered payload is unchanged.
   */
  readonly byNodeRelations?: Readonly<Record<string, Readonly<Record<string, number>>>>;
};

/**
 * The reading's counters, mirroring `POST /api/architecture/graph`: the
 * generator's per-granularity node/edge counts, the seed counts, the seeds that
 * matched nothing, and the totals. `truncated` reports that a node budget cut
 * the neighbourhood short; the optional per-granularity flags say WHICH graph
 * was cut, and the matching `…Total` fields are the pre-budget denominators the
 * panel turns into a "showing X of Y" readout. They stay optional so a payload
 * written before they existed still satisfies this type.
 */
export type ArchitectureGraphStats = {
  readonly entityNodes: number;
  readonly fileNodes: number;
  readonly entityEdges: number;
  readonly fileEdges: number;
  readonly truncated: boolean;
  /** True when the entity set exceeded its budget; absent on older payloads. */
  readonly entityTruncated?: boolean;
  /** True when the file set exceeded its own (independent) budget. */
  readonly fileTruncated?: boolean;
  /** Reachable entity nodes before the entity budget. */
  readonly entityTotal?: number;
  /** Distinct file nodes before the file budget. */
  readonly fileTotal?: number;
  /**
   * PRE-BUDGET reachable entities per normalized kind (server-owned analysis
   * readout). Absent when the server had no `arch.json` detail at all; a kind
   * that is absent from the map has a count of zero.
   */
  readonly kindCounts?: Readonly<Partial<Record<ArchitectureEntityKind, number>>>;
  /**
   * UNFILTERED counts of the entities the session mentioned directly, per kind
   * — the "keep mentioned" section's numbers. Absent when the request carried
   * no element filter (and on payloads written before the switches existed).
   */
  readonly mentionedByKind?: Readonly<Partial<Record<ArchitectureEntityKind, number>>>;
  /** The per-entity member cap the server applied to `node.members`. */
  readonly membersPerEntity?: number;
  /** True when at least one node's member list was cut at `membersPerEntity`. */
  readonly membersTruncated?: boolean;
  /**
   * Counts of the distance-0 entity nodes per mention tier. Absent on a payload
   * emitted before tiers existed; the panel does not need it, but mirroring the
   * server's stats keeps the payload contract honest for consumers that do.
   */
  readonly seedTiers?: Readonly<Partial<Record<ArchitectureMentionTier, number>>>;
  /**
   * Unfiltered counts by relation type over the current scope. Present only
   * when the request carried a filter; the relation filter's readout names the
   * relations it hid against this denominator.
   */
  readonly relationCounts?: Readonly<Record<string, number>>;
  /** What the requested filter removed. Present only when it carried a filter. */
  readonly hidden?: ArchitectureFilterHiddenStats;
  /** How many manual pins/removals were in effect; absent without curation. */
  readonly curation?: {
    readonly pinned: number;
    readonly excluded: number;
  };
  readonly seedFiles: number;
  readonly seedIdentifiers: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly unresolved: {
    readonly files: readonly string[];
    readonly identifiers: readonly string[];
    /** Manual pin ids that named no entity; absent without `extraSeeds`. */
    readonly ids?: readonly string[];
  };
};

/**
 * The endpoint's full reading: both render-ready subgraphs, both Mermaid
 * documents (the `.mmd` export path), the counters, and provenance. The panel
 * switches subgraphs locally and the renderer slices its view out of one
 * subgraph, so `graph` has to arrive whole.
 *
 * Each subgraph is typed as the renderer contract's graph shape: the server's
 * neighbourhood JSON IS the renderer input (node `id`/`label`/`distance` with a
 * reserved optional `type`, edge `from`/`to`/`relationType`), so a renderer
 * consumes the payload directly.
 */
export type ArchitectureGraphResult = {
  readonly mmd: { readonly file: string; readonly entity: string };
  readonly graph: { readonly file: ArchitectureRendererGraph; readonly entity: ArchitectureRendererGraph };
  readonly stats: ArchitectureGraphStats;
  readonly provenance: ArchitectureProvenance;
};

/**
 * The four states `ArchitecturePanel` renders. A discriminated union, so the
 * panel can never show a graph beside an error or a stale result.
 */
export type ArchitectureView =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; result: ArchitectureGraphResult };

type UseArchitectureGraphResult = {
  view: ArchitectureView;
  /**
   * True while a request is in flight OVER an already-loaded reading. The panel
   * keeps the old graph on screen (dimmed, `aria-busy`) instead of flashing the
   * loading placeholder: widening a filter or switching the view must not blank
   * the drawing the reader is looking at.
   */
  refreshing: boolean;
  /** Re-runs the request; the panel's error branch offers it as a retry. */
  reload: () => void;
};

/**
 * Loads one session's architecture graph from the server.
 *
 * The fetch is the tab activation itself (ADR-005 decision 2): the panel is
 * only mounted while the architecture tab is active, so mounting this hook is
 * what POSTs `/api/architecture/graph`. The granularity (file/entity) toggle is
 * NOT a fetch trigger by itself — both documents arrive in one response — but
 * the ELEMENT filter only applies to the entity graph, so the caller's `query`
 * differs per view and a view switch may move it.
 *
 * `hops` IS part of the request: it is the server-side BFS depth and therefore
 * a generation knob (it participates in the result cache's content key), so a
 * depth change re-enters the fetch rather than filtering an arrived payload.
 * The element/relation filter is a generation knob for the same reason: the
 * server runs the BFS and the node budget on the filtered graph, so hiding a
 * kind frees budget instead of merely hiding finished nodes.
 *
 * A refetch over an already-loaded reading keeps that reading visible
 * (`refreshing: true`) rather than returning to `status: 'loading'`.
 */
export function useArchitectureGraph(
  projectId: string | null,
  sessionId: string | null,
  hops: number,
  query?: ArchitectureGraphQuery,
): UseArchitectureGraphResult {
  const [view, setView] = useState<ArchitectureView>({ status: 'idle' });
  const [refreshing, setRefreshing] = useState(false);
  // Bumped by `reload`; it is the only way to re-enter the fetch effect without
  // also changing the selection, which is what a failed read needs.
  const [reloadToken, setReloadToken] = useState(0);
  // Tags each request so a reply for a previously selected project/session can
  // never overwrite the current selection's view.
  const requestIdRef = useRef(0);
  // The last reading that arrived, with the project/session it belongs to. It is
  // what makes a refetch "refresh the drawing" instead of "blank the drawing".
  const previousRef = useRef<{ identity: string; result: ArchitectureGraphResult } | null>(null);

  // The query object is rebuilt on every panel render; the request must re-enter
  // only when its CONTENT changes, so the effect depends on this digest. Parsing
  // the digest (rather than memoising the caller's object) gives the async body a
  // stable value without an object identity that changes on every render.
  const queryKey = JSON.stringify(query ?? null);
  const stableQuery = useMemo<ArchitectureGraphQuery | undefined>(() => {
    const parsed = JSON.parse(queryKey) as ArchitectureGraphQuery | null;
    return parsed === null ? undefined : parsed;
  }, [queryKey]);

  useEffect(() => {
    if (!projectId || !sessionId) {
      setView({ status: 'idle' });
      setRefreshing(false);
      previousRef.current = null;
      return;
    }

    const requestId = (requestIdRef.current += 1);
    const identity = `${projectId}\u0000${sessionId}`;
    const previous = previousRef.current;
    if (previous !== null && previous.identity === identity) {
      // Keep the drawing on screen while the new reading is computed.
      setView({ status: 'loaded', result: previous.result });
      setRefreshing(true);
    } else {
      setView({ status: 'loading' });
      setRefreshing(false);
    }

    void (async () => {
      try {
        const response = await api.architectureGraph(projectId, sessionId, hops, stableQuery);
        const result = await readApiJson<ArchitectureGraphResult>(response);
        if (requestIdRef.current !== requestId) return;
        previousRef.current = { identity, result };
        setView({ status: 'loaded', result });
        setRefreshing(false);
      } catch (error) {
        if (requestIdRef.current !== requestId) return;
        setRefreshing(false);
        setView({
          status: 'error',
          message: error instanceof Error
            ? error.message
            : 'The architecture graph could not be read.',
        });
      }
    })();
  }, [projectId, sessionId, hops, queryKey, stableQuery, reloadToken]);

  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  return { view, refreshing, reload };
}
