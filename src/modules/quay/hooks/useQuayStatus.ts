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
  /** The Loop pulse time window currently selected, in hours. */
  windowHours: number;
  /**
   * Requests a different Loop pulse window. The window is a *data* filter, so this re-reads
   * rather than rescaling what is already on screen: the interval set for 12h genuinely
   * contains runs a 1h window never read. The re-read happens IN PLACE — the view stays
   * `loaded` and the gantt card keeps its selector — so a window switch never blanks the
   * panel or drops the very control that triggered it.
   */
  setWindowHours: (hours: number) => void;
  /** True while a window change is being re-read; the panel stays loaded and its card shows it. */
  ganttRefreshing: boolean;
};

/** The Loop pulse windows the card offers, mirroring the backend's closed set. */
const WINDOW_HOURS = [1, 3, 6, 12] as const;
const DEFAULT_WINDOW_HOURS = 3;

/** The URL query key the selected window is persisted under, so a reload restores it. */
const WINDOW_QUERY_KEY = 'quayWindow';

/**
 * Coerces a requested window to one the card offers, falling back to the default. The set is
 * closed for the same reason the backend closes it: the window drives how far back the read
 * goes, and the card has a button for exactly these four values — anything else (a `5` in a
 * hand-edited URL, a stray query param) reads as "not a window I offer".
 */
function normalizeWindowHours(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    return DEFAULT_WINDOW_HOURS;
  }
  return (WINDOW_HOURS as readonly number[]).includes(parsed) ? parsed : DEFAULT_WINDOW_HOURS;
}

/** Reads the persisted window from the URL, falling back to the default when absent/invalid. */
function readPersistedWindowHours(): number {
  if (typeof window === 'undefined') {
    return DEFAULT_WINDOW_HOURS;
  }
  return normalizeWindowHours(new URLSearchParams(window.location.search).get(WINDOW_QUERY_KEY));
}

/**
 * Writes the selected window to the URL so a page reload restores it (before this the window
 * lived only in component state and every reload snapped back to 3h). `replaceState` rather
 * than a push, so switching windows does not flood the history stack with filter states.
 */
function persistWindowHours(hours: number): void {
  if (typeof window === 'undefined') {
    return;
  }
  const url = new URL(window.location.href);
  if (hours === DEFAULT_WINDOW_HOURS) {
    url.searchParams.delete(WINDOW_QUERY_KEY);
  } else {
    url.searchParams.set(WINDOW_QUERY_KEY, String(hours));
  }
  window.history.replaceState(window.history.state, '', url.toString());
}

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
  const [windowHours, setWindowHoursState] = useState<number>(readPersistedWindowHours);
  // The window lives in a ref as well as state so the mount effect can read the persisted
  // value WITHOUT taking `windowHours` as a dependency: a dependency there would re-enter the
  // loading path on every window change, which is exactly the unmounting this hook fixes.
  const [ganttRefreshing, setGanttRefreshing] = useState(false);
  const windowHoursRef = useRef(windowHours);
  windowHoursRef.current = windowHours;
  const requestIdRef = useRef(0);

  /**
   * Loads the snapshot at `hours`. `keepLoaded` is the whole distinction between the two
   * callers: a project switch or a manual refresh may show the loading branch, while a window
   * change must keep the loaded panel (and the gantt card's selector) mounted and only mark
   * the card busy — the window is one card's data filter, not a reason to blank the panel.
   */
  const load = useCallback(async (refresh: boolean, hours: number, keepLoaded: boolean) => {
    if (!projectId) {
      return;
    }

    const requestId = (requestIdRef.current += 1);
    if (keepLoaded) {
      setGanttRefreshing(true);
    } else {
      setFetchedView({ status: 'loading' });
    }

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
    } finally {
      // Only the newest request clears the busy marker; a superseded one must not hide the
      // marker the request that replaced it is still showing.
      if (keepLoaded && requestIdRef.current === requestId) {
        setGanttRefreshing(false);
      }
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !hasQuayConfig || !isActive) {
      return;
    }

    void load(false, windowHoursRef.current, false);
  }, [projectId, hasQuayConfig, isActive, load]);

  const refresh = useCallback(() => {
    void load(true, windowHoursRef.current, false);
  }, [load]);

  const setWindowHours = useCallback((hours: number) => {
    const normalized = normalizeWindowHours(hours);
    setWindowHoursState(normalized);
    windowHoursRef.current = normalized;
    persistWindowHours(normalized);
    void load(false, normalized, true);
  }, [load]);

  // The not-configured reading is derived during render rather than pushed into
  // state, so a project without quay never even transiently shows a stale snapshot.
  const view: QuayPanelView = (!projectId || !hasQuayConfig)
    ? { status: 'not-configured' }
    : fetchedView;

  return { view, refresh, windowHours, setWindowHours, ganttRefreshing };
}
