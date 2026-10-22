import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ArchitectureEntityKind } from '@/modules/architecture/rendererContract';
import { api, readApiJson } from '@/shared/api';

/** One project-wide search hit: everything a pin needs to be stored. */
export type ProjectSearchHit = {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  readonly kind?: ArchitectureEntityKind;
};

/** The search box's five states; the toolbar renders one per state. */
export type ProjectSearchState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | {
      readonly status: 'ready';
      readonly results: readonly ProjectSearchHit[];
      /** True when more entities matched than the bounded (20) result list. */
      readonly truncated: boolean;
    };

export type ProjectSearchResult = {
  readonly search: ProjectSearchState;
  /** Re-runs the current query after an error. */
  readonly retry: () => void;
};

/** The task's input debounce. */
export const PROJECT_SEARCH_DEBOUNCE_MS = 200;

/** The shortest query the endpoint accepts; a shorter one never leaves the client. */
export const PROJECT_SEARCH_MIN_QUERY_LENGTH = 2;

/**
 * Search the whole project index from the architecture toolbar.
 *
 * The query is debounced by {@link PROJECT_SEARCH_DEBOUNCE_MS} so typing does
 * not fan out one request per keystroke, and each request is tagged so a reply
 * for an older query can never overwrite the current one. Below two characters
 * (or with no project / search disabled) the hook stays `idle`: the endpoint
 * would answer 400 and there is nothing useful to rank yet.
 */
export function useProjectSearch(
  projectId: string | null,
  query: string,
  options: {
    /** False disables the whole feature (e.g. no session, so no shared key). */
    readonly enabled?: boolean;
    readonly kinds?: readonly ArchitectureEntityKind[];
    readonly debounceMs?: number;
  } = {},
): ProjectSearchResult {
  const { enabled = true, kinds, debounceMs = PROJECT_SEARCH_DEBOUNCE_MS } = options;
  const [state, setState] = useState<ProjectSearchState>({ status: 'idle' });
  const [retryToken, setRetryToken] = useState(0);
  const requestIdRef = useRef(0);

  const trimmed = query.trim();
  const active = enabled && projectId !== null && trimmed.length >= PROJECT_SEARCH_MIN_QUERY_LENGTH;
  // The kinds list is rebuilt on every render; the request must depend on its
  // CONTENT, not its identity.
  const kindsKey = useMemo(() => JSON.stringify(kinds ?? null), [kinds]);
  const stableKinds = useMemo<readonly ArchitectureEntityKind[] | undefined>(
    () => JSON.parse(kindsKey) as readonly ArchitectureEntityKind[] | null ?? undefined,
    [kindsKey],
  );

  useEffect(() => {
    if (!active || projectId === null) {
      requestIdRef.current += 1;
      setState({ status: 'idle' });
      return;
    }

    const requestId = (requestIdRef.current += 1);
    const timer = setTimeout(() => {
      setState({ status: 'loading' });
      void (async () => {
        try {
          const response = await api.architectureSearch(projectId, {
            query: trimmed,
            ...(stableKinds === undefined ? {} : { kinds: stableKinds }),
          });
          const body = await readApiJson<{
            results: readonly ProjectSearchHit[];
            truncated: boolean;
          }>(response);
          if (requestIdRef.current !== requestId) return;
          setState({ status: 'ready', results: body.results, truncated: body.truncated });
        } catch (error) {
          if (requestIdRef.current !== requestId) return;
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : 'The project search failed.',
          });
        }
      })();
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [active, projectId, trimmed, stableKinds, debounceMs, retryToken]);

  const retry = useCallback(() => setRetryToken((token) => token + 1), []);

  return { search: state, retry };
}

/**
 * Re-anchor saved curation items onto the CURRENT ids after a re-analysis.
 *
 * Returns the resolve entries in request order; a `null` id means the analysis
 * no longer contains that `(file, name)` and the caller marks the item stale.
 * A failed request answers `null` (the caller keeps its saved ids) rather than
 * marking everything stale — an unreachable server is not a re-analysis.
 */
export async function resolveCurationItems(
  projectId: string,
  items: readonly { readonly name: string; readonly file: string }[],
): Promise<readonly { readonly name: string; readonly file: string; readonly id: string | null }[] | null> {
  if (items.length === 0) return [];
  try {
    const response = await api.architectureSearch(projectId, {
      resolve: items.map((entry) => ({ name: entry.name, file: entry.file })),
    });
    const body = await readApiJson<{
      resolved: readonly ({ id: string; name: string; file: string } | null)[];
    }>(response);
    return body.resolved.map((hit, index) => ({
      name: items[index]?.name ?? '',
      file: items[index]?.file ?? '',
      id: hit?.id ?? null,
    }));
  } catch {
    return null;
  }
}
