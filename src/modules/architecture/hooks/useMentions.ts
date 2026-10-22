import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';

/**
 * One transcript hit behind a graph selection: the message id the chat can
 * locate, who said it, and a whitespace-collapsed excerpt around the name.
 * Mirrors the server's `SeedMentionHit` wire shape.
 */
export type ArchitectureMentionHit = {
  /** `NormalizedMessage.id` — the same id the transcript UI and the API use. */
  readonly messageId: string;
  readonly role?: 'user' | 'assistant';
  readonly kind: 'text' | 'tool_use' | 'tool_result';
  readonly excerpt: string;
  readonly at: string;
};

/**
 * One selected entity's provenance reading. `candidateCount` is how many
 * entities carry this name; `ambiguous` is what lets the inspector warn that a
 * hit may point at any same-named entity. Mirrors `ArchitectureMentionEntity`.
 */
export type ArchitectureMentionEntity = {
  readonly entityId: string;
  readonly candidateCount: number;
  readonly ambiguous: boolean;
  readonly hits: readonly ArchitectureMentionHit[];
};

/** The `/mentions` response: per-entity hits plus the optional relation co-mentions. */
export type ArchitectureMentionsResult = {
  readonly mentions: readonly ArchitectureMentionEntity[];
  readonly edge?: { readonly coMentions: readonly ArchitectureMentionHit[] };
  /** True when a hit list (or the transcript scan itself) was cut. */
  readonly truncated: boolean;
};

/**
 * The four renderable states of a provenance request. A discriminated union,
 * so the inspector can never draw hits beside an error or a stale result.
 */
export type ArchitectureMentionsView =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'loaded'; readonly result: ArchitectureMentionsResult };

/**
 * How many hits one entity (or one relation's co-mentions) may return. The
 * server's own default; stated explicitly on the request so the "showing the
 * first N" reading names the number that actually applied.
 */
export const MENTION_HIT_LIMIT = 20;

type UseMentionsOptions = {
  readonly projectId: string | null;
  readonly sessionId: string | null;
  /** The entity (or entities) to search for. Absent when only `edge` is set. */
  readonly entityIds?: readonly string[];
  /** The relation's two endpoints; the server answers `edge.coMentions`. */
  readonly edge?: { readonly from: string; readonly to: string };
  /**
   * Whether tool output is searched too. The shipped default is false — the
   * extractor's noise tier is opt-in per query, and the inspector surfaces the
   * switch as "include tool output".
   */
  readonly includeToolResults: boolean;
  /** False keeps the hook idle (no selection, no session, or the tab is hidden). */
  readonly enabled: boolean;
};

type UseMentionsResult = {
  readonly view: ArchitectureMentionsView;
  /** Re-runs the request; the inspector's error state offers it as a retry. */
  readonly reload: () => void;
};

/**
 * Loads the on-demand mention provenance for the current selection.
 *
 * The request is keyed by the selection's content (entity ids or the relation's
 * endpoints), not by object identity, so a re-render does not refetch. A reply
 * for a previous selection is discarded by the request counter — switching
 * entities while one request is in flight must not show the previous entity's
 * messages under the new name.
 *
 * Consumers: `ArchitectureInspector.tsx` only, for both of its pages (the
 * overview tab shows the hit COUNT, the sessions tab shows the hits).
 */
export function useMentions({
  projectId,
  sessionId,
  entityIds,
  edge,
  includeToolResults,
  enabled,
}: UseMentionsOptions): UseMentionsResult {
  const [view, setView] = useState<ArchitectureMentionsView>({ status: 'idle' });
  const [reloadToken, setReloadToken] = useState(0);
  const requestIdRef = useRef(0);

  // Content digests: rebuilt objects on every render must not re-enter the fetch.
  const entityKey = JSON.stringify(entityIds ?? null);
  const edgeKey = JSON.stringify(edge ?? null);
  const stableEntityIds = useMemo<readonly string[] | undefined>(() => {
    const parsed = JSON.parse(entityKey) as string[] | null;
    return parsed === null ? undefined : parsed;
  }, [entityKey]);
  const stableEdge = useMemo<{ from: string; to: string } | undefined>(() => (
    JSON.parse(edgeKey) as { from: string; to: string } | null ?? undefined
  ), [edgeKey]);

  const hasTarget = (stableEntityIds !== undefined && stableEntityIds.length > 0)
    || stableEdge !== undefined;

  useEffect(() => {
    if (!enabled || !projectId || !sessionId || !hasTarget) {
      setView({ status: 'idle' });
      return;
    }

    const requestId = (requestIdRef.current += 1);
    setView({ status: 'loading' });

    void (async () => {
      try {
        const response = await api.architectureMentions(projectId, sessionId, {
          ...(stableEntityIds === undefined ? {} : { entityIds: stableEntityIds }),
          ...(stableEdge === undefined ? {} : { edge: stableEdge }),
          includeToolResults,
          limit: MENTION_HIT_LIMIT,
        });
        const result = await readApiJson<ArchitectureMentionsResult>(response);
        if (requestIdRef.current !== requestId) return;
        setView({ status: 'loaded', result });
      } catch (error) {
        if (requestIdRef.current !== requestId) return;
        setView({
          status: 'error',
          message: error instanceof Error ? error.message : 'The mentions could not be loaded.',
        });
      }
    })();
  }, [enabled, projectId, sessionId, hasTarget, stableEntityIds, stableEdge, includeToolResults, reloadToken]);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  return { view, reload };
}
