import { useEffect, useState } from 'react';

import { api } from '@/shared/api';

/**
 * The task counts one quay project reports for the landing overview.
 *
 * The same five buckets the per-project snapshot calls `QuayTaskCounts`, reduced
 * to the numbers this panel draws. They are counts over the whole store, not a
 * delta: "what changed" is the event backbone's job (P4), while this panel is the
 * eager, cross-project reading SPEC §6.1 defines.
 */
export type FleetTaskCounts = {
  readonly total: number;
  readonly todo: number;
  readonly ready: number;
  readonly needsHuman: number;
  readonly done: number;
};

/** The goal counts one quay project reports; `active` is the in-progress reading. */
export type FleetGoalCounts = {
  readonly total: number;
  readonly active: number;
  readonly achieved: number;
};

/** One quay project, as the fleet summary describes it. */
export type FleetProjectSummary = {
  readonly projectId: string;
  readonly projectPath: string | null;
  readonly driverState: string | null;
  readonly driverAlive: boolean | null;
  readonly tasks: FleetTaskCounts;
  readonly goals: FleetGoalCounts;
};

/**
 * The three readings the panel draws. A discriminated union rather than a
 * `loading` boolean beside a `projects` array: the panel must never show a count
 * and "unavailable" at once.
 *
 * `unavailable` covers both "the endpoint answered with a failure" and "the
 * endpoint does not exist yet" — this panel is the consumer of P2's `fleet-summary`
 * contract, and until that route ships every answer is a 404. Collapsing the two
 * into one state keeps the panel from claiming a cause it cannot see; the panel's
 * copy says the reading is unavailable, not why.
 */
export type FleetSummaryView =
  | { readonly status: 'loading' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'loaded'; readonly projects: readonly FleetProjectSummary[] };

/** Re-read interval: the backend caches for two minutes, so a faster poll would ask the same TTL. */
const REFRESH_INTERVAL_MS = 120_000;

/** A finite count, or zero. A malformed field must not turn into `NaN` in the UI. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Reads one project row, or null when the payload does not name one. */
function readProject(value: unknown): FleetProjectSummary | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const row = value as Record<string, unknown>;
  const projectId = typeof row.projectId === 'string' ? row.projectId : '';
  if (!projectId) {
    return null;
  }

  const tasks = row.tasks && typeof row.tasks === 'object'
    ? (row.tasks as Record<string, unknown>)
    : {};
  const goals = row.goals && typeof row.goals === 'object'
    ? (row.goals as Record<string, unknown>)
    : {};
  const driver = row.driver && typeof row.driver === 'object'
    ? (row.driver as Record<string, unknown>)
    : null;

  return {
    projectId,
    projectPath: typeof row.projectPath === 'string' ? row.projectPath : null,
    driverState: driver !== null && typeof driver.state === 'string' ? driver.state : null,
    driverAlive: driver !== null && typeof driver.alive === 'boolean' ? driver.alive : null,
    tasks: {
      total: count(tasks.total),
      todo: count(tasks.todo),
      ready: count(tasks.ready),
      needsHuman: count(tasks.needsHuman),
      done: count(tasks.done),
    },
    goals: {
      total: count(goals.total),
      active: count(goals.active),
      achieved: count(goals.achieved),
    },
  };
}

/**
 * The cross-project task/goal counts the landing overview draws.
 *
 * `GET /api/quay/fleet-summary` is the eager tier (SPEC §6.1): one cheap read of
 * every quay project's counts, deliberately separate from the lazy per-project
 * snapshot. The landing polls it on the backend's own cache interval, so a panel
 * left open on a second monitor follows the store without spawning anything.
 */
export function useFleetSummary(): FleetSummaryView {
  const [view, setView] = useState<FleetSummaryView>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    const read = async (): Promise<void> => {
      try {
        const response = await api.quayFleetSummary();
        if (cancelled) {
          return;
        }
        if (!response.ok) {
          setView({ status: 'unavailable' });
          return;
        }

        const payload = (await response.json()) as { projects?: unknown };
        const rows = Array.isArray(payload?.projects) ? payload.projects : [];
        const projects = rows
          .map(readProject)
          .filter((project): project is FleetProjectSummary => project !== null);
        if (!cancelled) {
          setView({ status: 'loaded', projects });
        }
      } catch {
        if (!cancelled) {
          setView({ status: 'unavailable' });
        }
      }
    };

    void read();
    const timer = window.setInterval(() => {
      void read();
    }, REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return view;
}
