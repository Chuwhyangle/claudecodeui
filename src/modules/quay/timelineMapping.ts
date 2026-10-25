import type {
  QuayFanInSummary,
  QuayGanttLanes,
  QuayTestsSummary,
  QuayTimelineWindow,
} from '@/shared/types';
import type { TimelineBarRange } from '@/modules/quay/TimelineBar';

/**
 * The one mapping from a Quay reading to the time charts the Quay tab and the cockpit both draw.
 *
 * `QuayPanel` (the tab's Loop pulse / Tests / Fan-in cards) and `PulseStrip` (the cockpit's
 * stacked copy of the same three charts) import these functions instead of each deriving a
 * window or a range set of their own. That is what keeps the two surfaces showing the same
 * picture: if one of them grew a private mapping, the tab and the cockpit could disagree about
 * where a suite round or a fan-in attempt sits on the shared axis.
 *
 * Module-private: consumed only inside `src/modules/quay/`.
 */

const HOUR_MS = 3_600_000;

/** Used when the reading carries neither a lane window nor a host-requested one. */
const DEFAULT_TIMELINE_WINDOW_HOURS = 3;

/** Parses an ISO timestamp to epoch milliseconds, or `null` when absent/unparseable. */
function toEpochMs(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The one window the three charts share (see `QuayTimelineWindow`).
 *
 * It always comes from the Loop pulse reading — `gantt.windowHours` + `gantt.nowMs` — so the
 * Tests and Fan-in bars are cut to exactly the gantt's slice instead of adapting a window to
 * whatever records they happen to hold. When there is no lane reading (an un-upgraded plugin, or
 * a failed read) the window falls back to the host's requested `windowHours` and the reading's own
 * `generatedAt` as `now`, so the bars still render over a stated window rather than guessing one.
 */
export function resolveTimelineWindow(
  gantt: QuayGanttLanes | null,
  requestedWindowHours: number | undefined,
  generatedAt: string,
): QuayTimelineWindow {
  // `generatedAt` is always present on a loaded reading; `Date.now()` is only a last resort so a
  // bar is never handed a windowless boundary.
  const nowMs = gantt?.nowMs ?? toEpochMs(generatedAt) ?? Date.now();
  const windowHours = gantt?.windowHours ?? requestedWindowHours ?? DEFAULT_TIMELINE_WINDOW_HOURS;
  return { startMs: nowMs - windowHours * HOUR_MS, endMs: nowMs };
}

/**
 * The Tests card's ranges: one rect per suite round, from its start for its measured duration.
 * A round with no parseable start has no place on the axis and is dropped rather than pinned
 * to an invented instant.
 */
export function testsTimelineRanges(tests: QuayTestsSummary): TimelineBarRange[] {
  // Chronological: the reader returns the most recent N in file order, so the
  // timeline's x-axis runs oldest → newest left to right.
  return tests.recentRounds.flatMap((round) => {
    const startMs = toEpochMs(round.startedAt);
    if (startMs === null) {
      return [];
    }

    return [
      {
        startMs,
        endMs: startMs + (round.durationMs ?? 0),
        state: round.state,
        label: `Round ${round.round}: ${round.state} (${round.pass ?? '?'} pass / ${round.fail ?? '?'} fail)`,
      },
    ];
  });
}

/**
 * The Fan-in card's ranges: one rect per mechanical attempt over its lock window. The carrier
 * stores the lock epochs in Unix seconds; the timeline works in ms.
 */
export function fanInTimelineRanges(fanIn: QuayFanInSummary): TimelineBarRange[] {
  return fanIn.recent.flatMap((attempt) => {
    if (attempt.lockAcquireEpoch === null) {
      return [];
    }

    const startMs = attempt.lockAcquireEpoch * 1000;
    const endMs = attempt.lockReleaseEpoch === null ? startMs : attempt.lockReleaseEpoch * 1000;
    return [
      {
        startMs,
        endMs: Math.max(endMs, startMs),
        state: attempt.outcome,
        label: `${attempt.task}: ${attempt.outcome}`,
      },
    ];
  });
}
