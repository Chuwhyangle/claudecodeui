
import type {
  QuayAdrCounts,
  QuayConfigIssueCounts,
  QuayDriverState,
  QuayDriverSummary,
  QuayGoalCounts,
  QuayListItem,
  QuayTaskCounts,
} from '@/shared/types.js';
import { readNullableNumber } from '@/shared/utils.js';

import type { QuayFleetTaskCounts } from './quay-snapshot-types.js';

/**
 * Pure projections from a CLI document (or a store array) onto the panel's compact rows.
 * Every function is total: a malformed value yields `null`/"no reading" rather than a throw,
 * so a torn payload can never take a whole snapshot down.
 *
 * Consumers: `service/` (both the Tier-2 snapshot and the fleet summary) and the task index.
 */

/** How many `recent` rows each detail list keeps; the cap the panel copy promises. */
export const QUAY_RECENT_LIST_LIMIT = 10;

export function parseJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }
  return JSON.parse(trimmed);
}

/**
 * Parses a command's stdout when it may legitimately be empty. The fleet summary reads
 * the driver status this way: an absent body is "no reading" (reported as `unavailable`
 * by the caller), never a parse error that would hide the project from the response.
 */
export function parseJsonOrNull(stdout: string): unknown {
  if (!stdout.trim()) {
    return null;
  }
  try {
    return parseJson(stdout);
  } catch {
    return null;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function readCount(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

/**
 * Projects a `task list --json` / `goal list --json` / `adr list --json` array
 * into the panel's detail rows: at most `QUAY_RECENT_LIST_LIMIT` entries, most
 * recently updated first (`updatedAt` descending, ties broken by id ascending so
 * the order is deterministic even when timestamps collide — and a row with no
 * timestamp is the *least* recent, so it sorts last rather than first).
 *
 * Each row keeps the ISO-8601 form of the very epoch it was ranked by, so the
 * order the reader sees is the order they can check. Records without a string id
 * are skipped rather than rendered as blank rows.
 */
function summarizeRecentItems(value: unknown): QuayListItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => asRecord(item))
    .filter((record): record is Record<string, unknown> => record !== null && typeof record.id === 'string')
    .map((record) => ({
      record,
      epochMs: readUpdatedAtEpochMs(record.updatedAt),
    }))
    .sort((a, b) => {
      // Descending by epoch; a missing timestamp has no instant to place, so it
      // goes after every dated row. `null`-vs-`null` falls through to the id
      // tie-break rather than comparing two absent numbers.
      if (a.epochMs !== b.epochMs) {
        if (a.epochMs === null) return 1;
        if (b.epochMs === null) return -1;
        return b.epochMs - a.epochMs;
      }
      return String(a.record.id).localeCompare(String(b.record.id));
    })
    .slice(0, QUAY_RECENT_LIST_LIMIT)
    .map(({ record, epochMs }) => ({
      id: String(record.id),
      title: typeof record.title === 'string' ? record.title : '',
      status: typeof record.status === 'string' ? record.status : 'unknown',
      // `readUpdatedAtEpochMs` has already refused anything a `Date` cannot hold,
      // so this conversion cannot throw.
      updatedAt: epochMs === null ? null : new Date(epochMs).toISOString(),
    }));
}

export function summarizeTasks(value: unknown): QuayTaskCounts | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const byStatus: Record<string, number> = {};
  for (const task of value) {
    const status = typeof asRecord(task)?.status === 'string' ? (asRecord(task)?.status as string) : 'unknown';
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }

  return {
    total: value.length,
    byStatus,
    ready: byStatus.ready ?? 0,
    needsHuman: byStatus['needs-human'] ?? 0,
    done: byStatus.done ?? 0,
    recent: summarizeRecentItems(value),
  };
}

/** The all-zero counts a fleet entry carries when its task read did not answer. */
export const EMPTY_FLEET_TASK_COUNTS: QuayFleetTaskCounts = {
  total: 0,
  todo: 0,
  ready: 0,
  needsHuman: 0,
  done: 0,
};

/**
 * Narrows a `task list --json --no-body` array to the five counts the fleet badge
 * renders. Any status the store reports that is not one of those four is still
 * counted in `total` (the badge's "all tasks" figure) but has no bucket of its own.
 * A non-array body is not a task list at all, so the caller gets `null` and keeps the
 * error it already recorded rather than a fabricated zero reading.
 */
export function summarizeFleetTaskCounts(value: unknown): QuayFleetTaskCounts | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const counts = { ...EMPTY_FLEET_TASK_COUNTS, total: value.length };
  for (const task of value) {
    const status = asRecord(task)?.status;
    if (status === 'todo') counts.todo += 1;
    else if (status === 'ready') counts.ready += 1;
    else if (status === 'needs-human') counts.needsHuman += 1;
    else if (status === 'done') counts.done += 1;
  }
  return counts;
}

export function summarizeGoals(value: unknown): QuayGoalCounts | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const byStatus: Record<string, number> = {};
  for (const goal of value) {
    const status = typeof asRecord(goal)?.status === 'string' ? (asRecord(goal)?.status as string) : 'unknown';
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }

  return {
    total: value.length,
    achieved: byStatus.achieved ?? 0,
    breakdown: { byStatus, recent: summarizeRecentItems(value) },
  };
}

export function summarizeAdrs(value: unknown): QuayAdrCounts | null {
  return Array.isArray(value) ? { total: value.length, recent: summarizeRecentItems(value) } : null;
}

/**
 * A detail row's `updatedAt` as epoch milliseconds, or `null` when the record
 * carries no usable timestamp.
 *
 * `null` covers every shape that is not a real instant: an absent field, an
 * explicit `null`, a non-numeric string, `NaN`/`Infinity` — and a finite number
 * outside the range a `Date` can represent (`1e20`), which would otherwise throw
 * on `toISOString()` and take the whole snapshot down with it. Reading the sort
 * key and the displayed value from this one function is what keeps the list's
 * order and the time printed beside each row the same reading.
 */
export function readUpdatedAtEpochMs(value: unknown): number | null {
  const epochMs = readNullableNumber(value);
  if (epochMs === null) {
    return null;
  }

  return Number.isNaN(new Date(epochMs).getTime()) ? null : epochMs;
}

export function summarizeConfigIssues(value: unknown): QuayConfigIssueCounts | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const errors = value.filter((issue) => asRecord(issue)?.severity === 'error').length;
  return { total: value.length, errors };
}

export function summarizeDriver(value: unknown): QuayDriverSummary | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  // `alive`/`running` arrive as numbers (0/1) from `--json`; a driver that is
  // configured but not alive reads `stale`, which is the state the badge paints
  // differently from a live-but-idle driver.
  const alive = Boolean(readCount(record.alive));
  const running = Boolean(readCount(record.running));
  const state: QuayDriverState = !alive ? 'stale' : running ? 'running' : 'idle';

  return {
    state,
    alive,
    running,
    lastRecordAt: typeof record.last_record_ts === 'string' ? record.last_record_ts : null,
  };
}
