import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type {
  QuayGanttLanes,
  QuayGanttUnavailableReason,
  QuayLanesReading,
  QuaySessionMentionsReading,
} from '@/shared/types';

/**
 * The title bar's Loop pulse readings.
 *
 * Three hooks live here, each with one owner in `src/modules/quay/`:
 *
 * - `useSessionPulseWindow` — the per-project window, persisted in localStorage;
 * - `useSessionPulse` — the 30 s lanes poll behind the mini gantt and the popover's chart;
 * - `useSessionMentions` — the one-shot session-mentions read the popover's list renders.
 *
 * They are separate so the popover can own its one-shot read without making the trigger's
 * poll (or its window) depend on whether the popover is open.
 */

/** The Loop pulse windows the card offers, mirroring the backend's closed set. */
export const PULSE_WINDOW_HOURS = [1, 3, 6, 12] as const;

/** The window a project with no persisted choice shows. */
export const DEFAULT_PULSE_WINDOW_HOURS = 3;

/** The lanes poll interval, aligned with the backend's lanes TTL (30 s). */
export const PULSE_POLL_INTERVAL_MS = 30_000;

/** localStorage key prefix for `quay-pulse-window:<projectId>` (one value per project). */
const PULSE_WINDOW_STORAGE_PREFIX = 'quay-pulse-window:';

/**
 * Coerces a persisted/requested window to one the card offers, falling back to the default.
 * The set is closed for the same reason the backend closes it: the window drives how far back
 * the read goes and the card has a button for exactly these four values.
 */
export function normalizePulseWindowHours(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    return DEFAULT_PULSE_WINDOW_HOURS;
  }
  return (PULSE_WINDOW_HOURS as readonly number[]).includes(parsed)
    ? parsed
    : DEFAULT_PULSE_WINDOW_HOURS;
}

/** The localStorage key one project's window lives under. */
export function pulseWindowStorageKey(projectId: string): string {
  return `${PULSE_WINDOW_STORAGE_PREFIX}${projectId}`;
}

/** Reads one project's persisted window; an absent, unreadable or illegal value reads as 3. */
export function readPulseWindowHours(projectId: string | null): number {
  if (projectId === null || typeof window === 'undefined') {
    return DEFAULT_PULSE_WINDOW_HOURS;
  }
  try {
    return normalizePulseWindowHours(window.localStorage.getItem(pulseWindowStorageKey(projectId)));
  } catch {
    // A browser that denies localStorage must not take the trigger down: the window simply
    // does not persist, and the default is still a valid reading.
    return DEFAULT_PULSE_WINDOW_HOURS;
  }
}

/** Persists one project's window. localStorage only — this never reaches the server. */
function persistPulseWindowHours(projectId: string | null, hours: number): void {
  if (projectId === null || typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(pulseWindowStorageKey(projectId), String(hours));
  } catch {
    // Same as the read path: persistence is a convenience, not a premise.
  }
}

/**
 * One project's selected Loop pulse window, persisted under `quay-pulse-window:<projectId>`.
 *
 * The trigger and the popover both read the value this hook returns, so a window change in the
 * popover immediately moves the mini gantt behind the trigger too. Switching projects re-reads
 * that project's own stored value instead of carrying the previous one across.
 */
export function useSessionPulseWindow(projectId: string | null): {
  windowHours: number;
  setWindowHours: (hours: number) => void;
} {
  // The selected window; it is the only data filter the trigger's poll and the popover's chart
  // share, and it must survive the popover being closed and reopened.
  const [windowHours, setWindowHoursState] = useState<number>(() => readPulseWindowHours(projectId));
  const projectIdRef = useRef(projectId);

  useEffect(() => {
    if (projectIdRef.current === projectId) {
      return;
    }
    projectIdRef.current = projectId;
    setWindowHoursState(readPulseWindowHours(projectId));
  }, [projectId]);

  const setWindowHours = useCallback(
    (hours: number) => {
      const normalized = normalizePulseWindowHours(hours);
      setWindowHoursState(normalized);
      persistPulseWindowHours(projectId, normalized);
    },
    [projectId],
  );

  return { windowHours, setWindowHours };
}

export type SessionPulseReading = {
  /** The packed lane set, or `null` when there is no reading (see `unavailable`). */
  gantt: QuayGanttLanes | null;
  /** Why `gantt` is missing, when it is. */
  unavailable: QuayGanttUnavailableReason | null;
  /** True until the first reading for the current project/window has settled. */
  loading: boolean;
  /** A read failure that is not a classified lanes-unavailable reason. */
  error: string | null;
};

/**
 * Polls the lanes-only reading behind the title bar's mini gantt.
 *
 * 30 seconds, matching the backend's lanes TTL. The poll pauses while the page is hidden and
 * catches up immediately when it becomes visible again; switching project or window re-reads at
 * once. Every response is tagged with a request id, so a slow reply for a project the user has
 * already left cannot overwrite the current one's view (the same discipline `useQuayStatus`
 * uses). The hook is mounted inside the memoized `SessionPulse`, so a poll re-renders that
 * component only — never `WorkspaceHeader`'s ancestors.
 */
export function useSessionPulse(
  projectId: string | null,
  hasQuayConfig: boolean,
  windowHours: number,
): SessionPulseReading {
  const [reading, setReading] = useState<SessionPulseReading>({
    gantt: null,
    unavailable: null,
    loading: true,
    error: null,
  });
  // Monotonic across effect runs: a project/window switch invalidates the reply that was in
  // flight under the previous reading before it can land.
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!projectId || !hasQuayConfig) {
      setReading({ gantt: null, unavailable: null, loading: false, error: null });
      return;
    }

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const load = async () => {
      const requestId = (requestIdRef.current += 1);
      try {
        const response = await api.quayLanes(projectId, windowHours);
        if (disposed || requestIdRef.current !== requestId) {
          return;
        }
        if (!response.ok) {
          setReading((previous) => ({
            ...previous,
            loading: false,
            error: `Failed to load the quay lanes (HTTP ${response.status})`,
          }));
          return;
        }
        const body = (await response.json()) as QuayLanesReading;
        if (disposed || requestIdRef.current !== requestId) {
          return;
        }
        setReading({
          gantt: body.gantt ?? null,
          unavailable: body.ganttUnavailable ?? null,
          loading: false,
          error: null,
        });
      } catch (error) {
        if (disposed || requestIdRef.current !== requestId) {
          return;
        }
        setReading((previous) => ({
          ...previous,
          loading: false,
          error: error instanceof Error ? error.message : 'Failed to load the quay lanes',
        }));
      }
    };

    const schedule = () => {
      timer = setTimeout(() => {
        // A hidden tab must not keep spawning quay CLI reads. The visibility listener below
        // performs the catch-up read instead, so no reading is simply skipped.
        if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
          void load();
        }
        schedule();
      }, PULSE_POLL_INTERVAL_MS);
    };

    // A project or window change is a NEW reading: clear the previous project's chart rather
    // than drawing it under the new project's header until the reply lands.
    setReading({ gantt: null, unavailable: null, loading: true, error: null });
    void load();
    schedule();

    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        void load();
        if (timer !== null) {
          clearTimeout(timer);
        }
        schedule();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    return () => {
      disposed = true;
      // Invalidate anything still in flight for this effect run.
      requestIdRef.current += 1;
      if (timer !== null) {
        clearTimeout(timer);
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
    };
  }, [projectId, hasQuayConfig, windowHours]);

  return reading;
}

export type SessionMentionsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; reading: QuaySessionMentionsReading };

/**
 * Reads the session's mention list ONCE per mount.
 *
 * The popover mounts only while it is open, so opening fetches, closing discards the reply and
 * reopening fetches again — there is deliberately no poll: the transcript behind this reading
 * only grows on the user's own turns, and a 30 s list poll would spawn a subprocess per tick.
 */
export function useSessionMentions(
  projectId: string | null,
  sessionId: string | null,
  enabled: boolean,
): SessionMentionsState {
  const [state, setState] = useState<SessionMentionsState>({ status: 'idle' });

  useEffect(() => {
    if (!enabled || !projectId || !sessionId) {
      setState({ status: 'idle' });
      return;
    }

    let disposed = false;
    setState({ status: 'loading' });

    void (async () => {
      try {
        const response = await api.quaySessionMentions(projectId, sessionId);
        if (disposed) {
          return;
        }
        if (!response.ok) {
          setState({ status: 'error', message: `Failed to load session mentions (HTTP ${response.status})` });
          return;
        }
        const reading = (await response.json()) as QuaySessionMentionsReading;
        if (disposed) {
          return;
        }
        setState({ status: 'loaded', reading });
      } catch (error) {
        if (disposed) {
          return;
        }
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Failed to load session mentions',
        });
      }
    })();

    return () => {
      disposed = true;
    };
  }, [projectId, sessionId, enabled]);

  return state;
}
