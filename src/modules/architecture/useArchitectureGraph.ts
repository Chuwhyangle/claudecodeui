import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';

/** One `.archguard` scope fingerprint the reading was generated from. */
export type ArchitectureProvenanceFingerprint = {
  readonly scope: string;
  readonly archJsonHash: string;
};

/**
 * Honesty payload (ADR-005 decision 7): when the ArchGuard analysis behind this
 * reading was produced, which scope fingerprints it used, and whether the
 * server answered from its content-addressed result cache. The panel shows all
 * three so a user can tell "last analysis" from "live working tree".
 */
export type ArchitectureProvenance = {
  /** `manifest.generatedAt` — the analysis time, not the request time. */
  readonly generatedAt: string | null;
  readonly fingerprints: readonly ArchitectureProvenanceFingerprint[];
  readonly cacheHit: boolean;
};

/** How many seeds the session transcript yielded, before any were resolved. */
export type ArchitectureSeedStats = {
  readonly seedFiles: number;
  readonly seedIdentifiers: number;
};

/**
 * The reading's counters, mirroring `POST /api/architecture/graph`: the
 * generator's per-granularity node/edge counts, the seed counts, the seeds that
 * matched nothing, and the totals. `truncated` reports that the node budget cut
 * the neighbourhood short.
 */
export type ArchitectureGraphStats = {
  readonly entityNodes: number;
  readonly fileNodes: number;
  readonly entityEdges: number;
  readonly fileEdges: number;
  readonly truncated: boolean;
  readonly seedFiles: number;
  readonly seedIdentifiers: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly unresolved: {
    readonly files: readonly string[];
    readonly identifiers: readonly string[];
  };
};

/** Both Mermaid documents, generated together so the local toggle never refetches. */
export type ArchitectureGraphResult = {
  readonly mmd: { readonly file: string; readonly entity: string };
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
 */
export function useArchitectureGraph(
  projectId: string | null,
  sessionId: string | null,
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
        const response = await api.architectureGraph(projectId, sessionId);
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
  }, [projectId, sessionId, reloadToken]);

  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  return { view, reload };
}
