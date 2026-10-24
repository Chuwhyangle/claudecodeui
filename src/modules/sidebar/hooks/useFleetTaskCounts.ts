import { useSyncExternalStore } from 'react';

import { api } from '@/shared/api';
import type { QuayFleetCliState, QuayFleetSummary, QuayFleetTaskCounts } from '@/shared/types';

/**
 * The 60-second refresh cadence while any project row is mounted. The backend caches each
 * project for two minutes, so this polls comfortably inside that window: a poll normally
 * costs no CLI spawn, and a task that flipped is still visible within a minute.
 */
const REFRESH_INTERVAL_MS = 60_000;

/**
 * Everything the sidebar reads from one `GET /api/quay/fleet-summary`: per-project task
 * counts, the fleet registry id each project can be addressed by, and the fleet-wide
 * attention total / locator state the mode switch's badge shows.
 *
 * One snapshot rather than one request per consumer: the project row (counts + deep link) and
 * the mode switch (badge + deep link target) all subscribe to these values, and a sidebar with
 * twenty projects must still cost one request per poll.
 */
export type FleetSummarySnapshot = {
  /** `loading` only before the first answer; a later failure keeps the last reading and says `error`. */
  status: 'loading' | 'loaded' | 'error';
  /** projectId → task counts; the identity changes only when a load publishes a reading. */
  countsByProject: ReadonlyMap<string, QuayFleetTaskCounts>;
  /** projectId → quay-fleet registry id, only for projects the fleet actually registered. */
  fleetProjectIdByProject: ReadonlyMap<string, string>;
  /** The sum of `needsHuman` over every registered project, for the mode switch's badge. */
  needsHumanTotal: number;
  /** The CLI locator's state; `null` when the server did not report one (an older server). */
  fleetState: QuayFleetCliState | null;
  /** The locator's stated reason; `null` exactly when the state is `ok` or absent. */
  fleetReason: string | null;
};

const EMPTY_SNAPSHOT: FleetSummarySnapshot = {
  status: 'loading',
  countsByProject: new Map(),
  fleetProjectIdByProject: new Map(),
  needsHumanTotal: 0,
  fleetState: null,
  fleetReason: null,
};

let snapshot: FleetSummarySnapshot = EMPTY_SNAPSHOT;
// One shared read for every row: a sidebar with twenty projects still issues one request.
let inFlight: Promise<void> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

const publish = (next: FleetSummarySnapshot): void => {
  snapshot = next;
  for (const listener of listeners) listener();
};

/** True while the tab is in the background; polling is suspended so a hidden tab is free. */
const pageIsHidden = (): boolean =>
  typeof document !== 'undefined' && document.hidden === true;

/**
 * Reads the fleet summary once and publishes its per-project readings.
 *
 * A failed response or a thrown fetch leaves the previous reading in place: no badge is better
 * than a badge that claims zero tasks, and the next poll retries. The first failure is still
 * reported as `status: 'error'` so a consumer can tell "not read yet" from "read failed".
 */
const load = (): Promise<void> => {
  if (inFlight) {
    return inFlight;
  }

  inFlight = (async () => {
    try {
      const response = await api.quayFleetSummary();
      if (!response.ok) {
        publish({ ...snapshot, status: 'error' });
        return;
      }
      const summary = (await response.json()) as QuayFleetSummary;
      const countsByProject = new Map<string, QuayFleetTaskCounts>();
      const fleetProjectIdByProject = new Map<string, string>();
      let needsHumanTotal = 0;
      for (const project of summary.projects ?? []) {
        countsByProject.set(project.projectId, project.tasks);
        const fleetProjectId = project.fleetProjectId ?? null;
        if (fleetProjectId !== null) {
          // Only REGISTERED projects count towards the cockpit badge: an unregistered project
          // has no board the cockpit can open, so its needs-human tasks are not reachable there.
          needsHumanTotal += project.tasks.needsHuman ?? 0;
          fleetProjectIdByProject.set(project.projectId, fleetProjectId);
        }
      }
      publish({
        status: 'loaded',
        countsByProject,
        fleetProjectIdByProject,
        needsHumanTotal,
        // An older server omits `fleet`; that is not the same as "the CLI is missing", so the
        // state stays `null` and the badge draws no warning dot it cannot justify.
        fleetState: summary.fleet?.state ?? null,
        fleetReason: summary.fleet?.reason ?? null,
      });
    } catch {
      // Network failure: keep the last successful reading; the interval retries.
      publish({ ...snapshot, status: 'error' });
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
};

function startPolling(): void {
  if (refreshTimer !== null) return;
  refreshTimer = setInterval(() => {
    // Even with the timer alive, a hidden tab issues nothing: the visibility listener also
    // stops the timer, this is the second guard for browsers that do not deliver the event.
    if (!pageIsHidden()) void load();
  }, REFRESH_INTERVAL_MS);
}

function stopPolling(): void {
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/** A background tab costs nothing; returning to it reads once immediately, then resumes the cadence. */
function handleVisibilityChange(): void {
  if (pageIsHidden()) {
    stopPolling();
    return;
  }
  void load();
  startPolling();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    if (!pageIsHidden()) void load();
    startPolling();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopPolling();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
    }
  };
}

const getSnapshot = (): FleetSummarySnapshot => snapshot;

/**
 * The whole fleet-summary reading. Used by `useFleetAttention` (the sidebar mode switch's
 * badge) and by `useFleetTaskCounts` below, so both consumers share one request and one poll.
 */
export function useFleetSummaryReading(): FleetSummarySnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * One project's task counts from the shared fleet summary, or `null` until a reading has
 * landed (or when the backend does not list the project).
 *
 * Consumers: `SidebarProjectItem` renders these counts as its project-row task badge for
 * quay-configured projects. The reads are shared across every row — subscribing many rows
 * does not multiply requests — and every row unsubscribes when it unmounts.
 */
export function useFleetTaskCounts(projectId: string): QuayFleetTaskCounts | null {
  const reading = useFleetSummaryReading();
  return reading.countsByProject.get(projectId) ?? null;
}
