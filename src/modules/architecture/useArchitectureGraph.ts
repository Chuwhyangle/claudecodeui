import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  ArchitectureEntityKind,
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
};

/** How many seeds the session transcript yielded, before any were resolved. */
export type ArchitectureSeedStats = {
  readonly seedFiles: number;
  readonly seedIdentifiers: number;
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
  /** The per-entity member cap the server applied to `node.members`. */
  readonly membersPerEntity?: number;
  /** True when at least one node's member list was cut at `membersPerEntity`. */
  readonly membersTruncated?: boolean;
  readonly seedFiles: number;
  readonly seedIdentifiers: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly unresolved: {
    readonly files: readonly string[];
    readonly identifiers: readonly string[];
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
  /** Re-runs the request; the panel's error branch offers it as a retry. */
  reload: () => void;
};

/**
 * Loads one session's architecture graph from the server.
 *
 * The fetch is the tab activation itself (ADR-005 decision 2): the panel is
 * only mounted while the architecture tab is active, so mounting this hook is
 * what POSTs `/api/architecture/graph`. Nothing here depends on which
 * granularity (file/entity) is on screen — the server returns both documents in
 * one response, and the panel's toggle is local by construction.
 *
 * `hops` IS part of the request: it is the server-side BFS depth and therefore
 * a generation knob (it participates in the result cache's content key), so a
 * depth change re-enters the fetch rather than filtering an arrived payload.
 */
export function useArchitectureGraph(
  projectId: string | null,
  sessionId: string | null,
  hops: number,
): UseArchitectureGraphResult {
  const [view, setView] = useState<ArchitectureView>({ status: 'idle' });
  // Bumped by `reload`; it is the only way to re-enter the fetch effect without
  // also changing the selection, which is what a failed read needs.
  const [reloadToken, setReloadToken] = useState(0);
  // Tags each request so a reply for a previously selected project/session can
  // never overwrite the current selection's view.
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!projectId || !sessionId) {
      setView({ status: 'idle' });
      return;
    }

    const requestId = (requestIdRef.current += 1);
    setView({ status: 'loading' });

    void (async () => {
      try {
        const response = await api.architectureGraph(projectId, sessionId, hops);
        const result = await readApiJson<ArchitectureGraphResult>(response);
        if (requestIdRef.current !== requestId) return;
        setView({ status: 'loaded', result });
      } catch (error) {
        if (requestIdRef.current !== requestId) return;
        setView({
          status: 'error',
          message: error instanceof Error
            ? error.message
            : 'The architecture graph could not be read.',
        });
      }
    })();
  }, [projectId, sessionId, hops, reloadToken]);

  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  return { view, reload };
}
