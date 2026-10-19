import { useSyncExternalStore } from 'react';

import { api } from '@/shared/api';
import type { QuayFleetSummary, QuayFleetTaskCounts } from '@/shared/types';

/**
 * The 60-second refresh cadence while any project row is mounted. The backend caches each
 * project for two minutes, so this polls comfortably inside that window: a poll normally
 * costs no CLI spawn, and a task that flipped is still visible within a minute.
 */
const REFRESH_INTERVAL_MS = 60_000;

/** projectId → task counts; the identity changes only when a load publishes a reading. */
type FleetCountsByProject = ReadonlyMap<string, QuayFleetTaskCounts>;

const EMPTY_COUNTS: FleetCountsByProject = new Map();
let snapshot: FleetCountsByProject = EMPTY_COUNTS;
// One shared read for every row: a sidebar with twenty projects still issues one request.
let inFlight: Promise<void> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

const publish = (next: FleetCountsByProject): void => {
  snapshot = next;
  for (const listener of listeners) listener();
};

/**
 * Reads the fleet summary once and publishes its per-project counts. A failed response or
 * a thrown fetch leaves the previous reading in place: no badge is better than a badge that
 * claims zero tasks, and the next poll retries.
 */
const load = (): Promise<void> => {
  if (inFlight) {
    return inFlight;
  }

  inFlight = (async () => {
    try {
      const response = await api.quayFleetSummary();
      if (!response.ok) {
        return;
      }
      const summary = (await response.json()) as QuayFleetSummary;
      const next = new Map<string, QuayFleetTaskCounts>();
      for (const project of summary.projects ?? []) {
        next.set(project.projectId, project.tasks);
      }
      publish(next);
    } catch {
      // Network failure: keep the last successful reading; the interval retries.
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
};

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void load();
    refreshTimer = setInterval(() => {
      void load();
    }, REFRESH_INTERVAL_MS);
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && refreshTimer !== null) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  };
}

const getSnapshot = (): FleetCountsByProject => snapshot;

/**
 * One project's task counts from the shared fleet summary, or `null` until a reading has
 * landed (or when the backend does not list the project).
 *
 * Consumers: `SidebarProjectItem` renders these counts as its project-row task badge for
 * quay-configured projects. The reads are shared across every row — subscribing many rows
 * does not multiply requests — and every row unsubscribes when it unmounts.
 */
export function useFleetTaskCounts(projectId: string): QuayFleetTaskCounts | null {
  const countsByProject = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return countsByProject.get(projectId) ?? null;
}
