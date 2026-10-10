import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { QuaySnapshot } from '@/shared/types';

/**
 * The four states `QuayPanel` renders. Kept as a discriminated union so the
 * panel can never show a snapshot and an error at once.
 */
export type QuayPanelView =
  | { status: 'not-configured' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; snapshot: QuaySnapshot };

type UseQuayStatusResult = {
  view: QuayPanelView;
  /** Re-fetches the snapshot, bypassing the backend's TTL cache. */
  refresh: () => void;
  /** The Loop pulse time window the current snapshot was read at, in hours. */
  windowHours: number;
  /**
   * Requests a different Loop pulse window. The window is a *data* filter, so this re-fetches
   * rather than rescaling what is already on screen: the interval set for 12h genuinely
   * contains runs a 1h window never read.
   */
  setWindowHours: (hours: number) => void;
};

/** The Loop pulse windows the card offers, mirroring the backend's closed set. */
const WINDOW_HOURS = [1, 3, 6, 12] as const;
const DEFAULT_WINDOW_HOURS = 3;

/**
 * Loads one project's Tier-2 quay snapshot for `QuayPanel`.
 *
 * The fetch only runs while the Quay tab is active and the project actually has
 * a `.quay/config.yml`; both conditions are the caller's gate against spawning
 * the quay CLI for a project that never opted in. Responses are tagged with a
 * request id so a slow reply for a previously selected project cannot overwrite
 * the current one's view.
 */
export function useQuayStatus(
  projectId: string | null,
  hasQuayConfig: boolean,
  isActive: boolean,
): UseQuayStatusResult {
  const [fetchedView, setFetchedView] = useState<QuayPanelView>({ status: 'loading' });
  const [windowHours, setWindowHoursState] = useState<number>(DEFAULT_WINDOW_HOURS);
  const requestIdRef = useRef(0);

  const load = useCallback(async (refresh: boolean, hours: number) => {
    if (!projectId) {
      return;
    }

    const requestId = (requestIdRef.current += 1);
    setFetchedView({ status: 'loading' });

    try {
      const response = await api.quaySnapshot(projectId, { refresh, hours });
      if (requestIdRef.current !== requestId) {
        return;
      }

      if (!response.ok) {
        setFetchedView({ status: 'error', message: `Failed to load quay status (HTTP ${response.status})` });
        return;
      }

      const snapshot = (await response.json()) as QuaySnapshot;
      if (requestIdRef.current !== requestId) {
        return;
      }

      setFetchedView({ status: 'loaded', snapshot });
    } catch (error) {
      if (requestIdRef.current !== requestId) {
        return;
      }
      setFetchedView({ status: 'error', message: error instanceof Error ? error.message : 'Failed to load quay status' });
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !hasQuayConfig || !isActive) {
      return;
    }

    void load(false, windowHours);
  }, [projectId, hasQuayConfig, isActive, windowHours, load]);

  const refresh = useCallback(() => {
    void load(true, windowHours);
  }, [load, windowHours]);

  const setWindowHours = useCallback((hours: number) => {
    setWindowHoursState((WINDOW_HOURS as readonly number[]).includes(hours) ? hours : DEFAULT_WINDOW_HOURS);
  }, []);

  // The not-configured reading is derived during render rather than pushed into
  // state, so a project without quay never even transiently shows a stale snapshot.
  const view: QuayPanelView = (!projectId || !hasQuayConfig)
    ? { status: 'not-configured' }
    : fetchedView;

  return { view, refresh, windowHours, setWindowHours };
}
