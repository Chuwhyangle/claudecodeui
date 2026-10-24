import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  QuayBlockerSummary,
  QuayFanInAttemptSummary,
  QuayGanttLanes,
  QuayInFlightPhase,
  QuayInFlightTask,
  QuayTestsSummary,
  QuayFanInSummary,
} from '@/shared/types';
import { cn } from '@/shared/utils';

/**
 * The pulse strip: one project's last N hours in four thin rows — in flight, fan-in
 * outcomes, suite rounds and live blockers.
 *
 * WHY IT EXISTS. The Quay panel's Loop pulse card is a full chart with axis labels and a
 * 600×H coordinate space; it answers "what ran" when a person is already looking at one
 * project. The cockpit needs the opposite reading: every project, on one screen, continuously,
 * in a form that costs ~48 px and can be scanned without reading. So this component is
 * deliberately dense:
 *
 *   1. in flight  (16 px) — one 2 px line per running task, length = elapsed, colour = phase;
 *                           a task whose heartbeat is older than the worker's round interval
 *                           ends in a HOLLOW DOT instead of a solid line end.
 *   2. fan-in     (10 px) — one thin vertical mark per mechanical attempt. Success rises from
 *                           the baseline, failure sinks below it; retry/ff is `serious`.
 *   3. suite      (10 px) — one vertical mark per round, height ∝ duration / median;
 *                           a failing round is `critical`.
 *   4. blocked    (10 px) — one horizontal segment per live failure signature, from its first
 *                           occurrence to now, ending in `⛔ N` (N = dependent tasks).
 *
 * COLOUR IS NEVER THE ONLY CHANNEL (dataviz rule): every state also carries a shape — the
 * in-flight line's end (solid vs hollow), a fan-in mark's direction (up vs down), the
 * `✕` on a failing suite round, the `⛔` glyph on a blocked segment. The two palettes are
 * DISJOINT BY CONSTRUCTION: in-flight phases use categorical hues (blue/violet/cyan/indigo)
 * and only health uses the status hues (green/amber/orange/red), so 「紫的那条」 can never be
 * confused with 「红的那个」.
 *
 * The strip owns no data fetching and no clock: it is handed one reading (the Quay panel's
 * `QuaySnapshot` or a fleet entry's `QuayPulseSummary`) and draws exactly it.
 */

/** The height the strip promises, in CSS pixels. Rows: 16 + 10 + 10 + 10 + 2 baseline padding. */
export const PULSE_STRIP_HEIGHT_PX = 48;

/** The windows the strip offers, in hours, with 24 h (one day) as its default reading. */
export const PULSE_WINDOW_HOURS = [6, 24, 72] as const;
export const DEFAULT_PULSE_WINDOW_HOURS = 24;

/** Row heights, in CSS pixels. Their sum (+ 2 px of breathing room) is the strip's height. */
const IN_FLIGHT_ROW_HEIGHT = 16;
const FAN_IN_ROW_HEIGHT = 10;
const SUITE_ROW_HEIGHT = 10;
const BLOCKER_ROW_HEIGHT = 10;
const STRIP_PADDING = 2;

/**
 * How old an in-flight task's heartbeat may be before its line ends in a hollow dot.
 *
 * The worker-driver's own round interval (five minutes): a driver that missed a whole round
 * without touching its carrier has stopped heartbeating, which is a different fact from a task
 * that is simply still running.
 */
export const PULSE_STALE_AFTER_MS = 300_000;

const HOUR_MS = 3_600_000;

/**
 * The categorical palette for in-flight phases. Deliberately disjoint from `STATUS_COLORS`
 * below: a phase is an identity ("which stage is this task in"), never a health judgement.
 * Each entry carries a light and a dark class so the same token is legible in both themes.
 */
const IN_FLIGHT_PHASES: Record<
  QuayInFlightPhase,
  { color: string; className: string; labelKey: string }
> = {
  implementing: { color: 'blue', className: 'bg-blue-600 dark:bg-blue-400', labelKey: 'cockpit.pulsePhaseImplementing' },
  'fan-in': { color: 'violet', className: 'bg-violet-600 dark:bg-violet-400', labelKey: 'cockpit.pulsePhaseFanIn' },
  'awaiting-land': { color: 'cyan', className: 'bg-cyan-600 dark:bg-cyan-400', labelKey: 'cockpit.pulsePhaseAwaitingLand' },
  landed: { color: 'indigo', className: 'bg-indigo-600 dark:bg-indigo-400', labelKey: 'cockpit.pulsePhaseLanded' },
};

/** The in-flight colour tokens, exported so the disjointness criterion reads the real set. */
export const IN_FLIGHT_PHASE_COLORS: readonly string[] = Object.values(IN_FLIGHT_PHASES).map(
  (phase) => phase.color,
);

/**
 * The health palette. ONLY these four hues mean "how healthy is this", and every one of them
 * is drawn with a shape as well — never as a bare colour.
 */
const STATUS_STYLES = {
  good: { color: 'green', className: 'bg-green-600 dark:bg-green-400', text: 'text-green-700 dark:text-green-300', symbol: '●' },
  warning: { color: 'amber', className: 'bg-amber-600 dark:bg-amber-400', text: 'text-amber-700 dark:text-amber-300', symbol: '▲' },
  serious: { color: 'orange', className: 'bg-orange-600 dark:bg-orange-400', text: 'text-orange-700 dark:text-orange-300', symbol: '◆' },
  critical: { color: 'red', className: 'bg-red-600 dark:bg-red-400', text: 'text-red-700 dark:text-red-300', symbol: '✕' },
} as const;

export type PulseStatus = keyof typeof STATUS_STYLES;

/** The status colour tokens, exported so the disjointness criterion reads the real set. */
export const STATUS_COLORS: readonly string[] = Object.values(STATUS_STYLES).map(
  (status) => status.color,
);

export type PulseStripProps = {
  /**
   * The in-flight reading. `null` is "no lane reading" (not "nothing running"): the row then
   * carries `data-unread`, and if every row is unread/empty the strip says so once.
   */
  inFlight: QuayInFlightTask[] | null;
  /** Lane reading, used only to place each in-flight line on the lane the gantt would draw it. */
  gantt?: QuayGanttLanes | null;
  tests: QuayTestsSummary;
  fanIn: QuayFanInSummary;
  /** Live blockers; `null` = unread store, `[]` = read and nothing blocked. */
  blockers?: QuayBlockerSummary[] | null;
  /** The reading's own clock (ISO-8601); the strip never calls `Date.now()` for its window. */
  generatedAt: string;
  /** Controlled window in hours. Omitted ⇒ the strip keeps its own (default 24). */
  windowHours?: number;
  /** Invoked when a window is picked; omitted ⇒ the selector is not rendered. */
  onWindowChange?: (hours: number) => void;
  /** Invoked with the task id behind an activated in-flight line / blocked segment. */
  onFocusTask?: (taskId: string) => void;
  /** Prefix for the component's test ids. */
  testId?: string;
};

type HoverReading = { text: string; leftPercent: number };

/** Milliseconds since epoch, or `null` when the value is missing/unparseable. */
function toEpochMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/** A short duration for tooltips: "45s", "12m", "3h 5m". */
function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The median of a numeric list (`null` when empty). */
function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/** Whether a fan-in outcome landed. Anything else is a failure direction. */
function isFanInSuccess(outcome: string): boolean {
  return outcome === 'landed' || outcome === 'completed' || outcome === 'green';
}

/** Retries, races and partial landings are `serious`: worse than success, not a hard red. */
function isFanInSerious(outcome: string): boolean {
  return /ff|retry|race|exited-not-landed|timed-out/i.test(outcome);
}

/** The instant an attempt ended (falling back to when it acquired the lock), in ms. */
function attemptEpochMs(attempt: QuayFanInAttemptSummary): number | null {
  const seconds = attempt.lockReleaseEpoch ?? attempt.lockAcquireEpoch;
  return seconds === null ? null : seconds * 1000;
}

/** The lane a task's live gantt interval occupies, or `null` when the gantt did not place it. */
function laneOfTask(gantt: QuayGanttLanes | null | undefined, taskId: string): number | null {
  if (!gantt) {
    return null;
  }
  for (let lane = 0; lane < gantt.lanes.length; lane += 1) {
    if (gantt.lanes[lane].some((interval) => interval.taskId === taskId && interval.phase !== null)) {
      return lane;
    }
  }
  return null;
}

/** The start of a task's live gantt interval, or `null` when the gantt did not place it. */
function ganttStartMs(gantt: QuayGanttLanes | null | undefined, taskId: string): number | null {
  if (!gantt) {
    return null;
  }
  for (const lane of gantt.lanes) {
    for (const interval of lane) {
      if (interval.taskId === taskId && interval.phase !== null) {
        return interval.startMs;
      }
    }
  }
  return null;
}

/** The earliest start the readings carry, used only when `generatedAt` is unparseable. */
function fallbackNow(
  generatedAt: string,
  inFlight: QuayInFlightTask[] | null,
  tests: QuayTestsSummary,
): number {
  const fromGenerated = toEpochMs(generatedAt);
  if (fromGenerated !== null) {
    return fromGenerated;
  }
  const starts = [
    ...(inFlight ?? []).map((task) => toEpochMs(task.startedAt)),
    ...(tests.recentRounds ?? []).map((round) => toEpochMs(round.startedAt)),
  ].filter((value): value is number => value !== null);
  return starts.length > 0 ? Math.max(...starts) : Date.now();
}

/**
 * Renders one project's pulse strip. Display-only: it owns the selected window (unless the host
 * controls it) and the hover tooltip, and reports activation upward through `onFocusTask`.
 */
export default function PulseStrip({
  inFlight,
  gantt = null,
  tests,
  fanIn,
  blockers = null,
  generatedAt,
  windowHours,
  onWindowChange,
  onFocusTask,
  testId = 'pulse-strip',
}: PulseStripProps) {
  const { t } = useTranslation();
  const [internalWindow, setInternalWindow] = useState<number>(DEFAULT_PULSE_WINDOW_HOURS);
  const [hover, setHover] = useState<HoverReading | null>(null);

  const hours = windowHours ?? internalWindow;
  const nowMs = fallbackNow(generatedAt, inFlight, tests);
  const windowStartMs = nowMs - hours * HOUR_MS;
  const spanMs = Math.max(1, nowMs - windowStartMs);
  const toPercent = (timeMs: number): number => clampPercent(((timeMs - windowStartMs) / spanMs) * 100);
  const inWindow = (timeMs: number | null): timeMs is number =>
    timeMs !== null && timeMs >= windowStartMs && timeMs <= nowMs;

  const selectWindow = (next: number): void => {
    if (windowHours === undefined) {
      setInternalWindow(next);
    }
    onWindowChange?.(next);
  };

  // ── Row 1: in flight ────────────────────────────────────────────────────────────────────
  const inFlightRows = (inFlight ?? []).flatMap((task, index) => {
    const lane = laneOfTask(gantt, task.taskId);
    const startMs = toEpochMs(task.startedAt) ?? ganttStartMs(gantt, task.taskId);
    if (startMs === null) {
      return [];
    }
    const laneIndex = lane ?? index % 4;
    const heartbeatMs = toEpochMs(task.lastHeartbeat);
    const stale = heartbeatMs !== null && nowMs - heartbeatMs > PULSE_STALE_AFTER_MS;
    const phase = IN_FLIGHT_PHASES[task.phase];
    const left = toPercent(Math.max(startMs, windowStartMs));
    const width = Math.max(0.4, toPercent(nowMs) - left);
    const tooltip = `${task.taskId} · ${t(phase.labelKey)} · ${formatDuration(nowMs - Math.max(startMs, windowStartMs))}`
      + (stale ? ` · ${t('cockpit.pulseStaleInFlight')}` : '');
    return [{ task, phase, lane: laneIndex, left, width, stale, tooltip }];
  });

  // ── Row 2: fan-in ───────────────────────────────────────────────────────────────────────
  const fanInMarks = (fanIn?.recent ?? []).flatMap((attempt) => {
    const at = attemptEpochMs(attempt);
    if (!inWindow(at)) {
      return [];
    }
    const success = isFanInSuccess(attempt.outcome);
    const severity: PulseStatus = isFanInSerious(attempt.outcome)
      ? 'serious'
      : success
        ? 'good'
        : 'critical';
    return [{
      attempt,
      at,
      left: toPercent(at),
      success,
      severity,
      tooltip: `${attempt.task}: ${attempt.outcome}`,
    }];
  });

  // ── Row 3: suite ────────────────────────────────────────────────────────────────────────
  const rounds = (tests?.recentRounds ?? []).flatMap((round) => {
    const at = toEpochMs(round.startedAt);
    if (!inWindow(at)) {
      return [];
    }
    return [{ round, at }];
  });
  const roundDurations = rounds
    .map((entry) => entry.round.durationMs)
    .filter((value): value is number => value !== null && value > 0);
  const medianDuration = median(roundDurations);
  const suiteMarks = rounds.map(({ round, at }) => {
    const failed = round.state === 'red' || (round.fail ?? 0) > 0;
    const ratio = medianDuration !== null && round.durationMs !== null
      ? round.durationMs / medianDuration
      : null;
    // Height is a READING (duration relative to this project's median), not a constant: a
    // slow round must stand taller than a fast one, while staying inside the 10 px row.
    const height = ratio === null ? 4 : Math.max(2, Math.min(8, 8 * ratio));
    return {
      round,
      at,
      left: toPercent(at),
      height,
      failed,
      severity: (failed ? 'critical' : 'good') as PulseStatus,
      tooltip: t('cockpit.pulseRoundTooltip', {
        round: round.round,
        state: round.state,
        pass: round.pass ?? 0,
        fail: round.fail ?? 0,
      }),
    };
  });

  // ── Row 4: blockers ─────────────────────────────────────────────────────────────────────
  const blockerSegments = (blockers ?? []).flatMap((blocker) => {
    const since = toEpochMs(blocker.since);
    if (since === null || since > nowMs) {
      return [];
    }
    const start = Math.max(since, windowStartMs);
    const left = toPercent(start);
    const width = Math.max(0.6, toPercent(nowMs) - left);
    const dependents = blocker.dependents.length;
    const tooltip = `${blocker.taskId} · ${blocker.signature} · ${t('cockpit.pulseOccurrences', { n: blocker.occurrences })}`
      + (dependents > 0 ? ` · ${t('cockpit.pulseDependents', { n: dependents })}` : '');
    return [{ blocker, left, width, dependents, tooltip }];
  });

  const anyInFlight = inFlightRows.length > 0;
  const anyFanIn = fanInMarks.length > 0;
  const anySuite = suiteMarks.length > 0;
  const anyBlocked = blockerSegments.length > 0;
  const isEmpty = !anyInFlight && !anyFanIn && !anySuite && !anyBlocked;

  const showTooltip = (text: string, leftPercent: number) => setHover({ text, leftPercent });

  const rows = useMemo(
    () => [
      { id: 'inflight', height: IN_FLIGHT_ROW_HEIGHT, unread: inFlight === null },
      { id: 'fanin', height: FAN_IN_ROW_HEIGHT, unread: false },
      { id: 'suite', height: SUITE_ROW_HEIGHT, unread: false },
      { id: 'blocked', height: BLOCKER_ROW_HEIGHT, unread: blockers === null },
    ],
    [inFlight, blockers],
  );

  return (
    <div
      className="relative w-full select-none"
      style={{ height: PULSE_STRIP_HEIGHT_PX }}
      data-testid={testId}
      data-height-px={PULSE_STRIP_HEIGHT_PX}
      data-window-hours={hours}
      data-empty={isEmpty ? 'true' : undefined}
    >
      {/* The one baseline the strip keeps: a 1 px rule at the foot, no axis text. */}
      <div className="absolute inset-x-0 bottom-0 h-px bg-border" data-testid={`${testId}-baseline`} />

      {/* Window selector: three tiny labels in a reserved 44 px column at the right end, where
          the 「24h」 label would be. Selecting a window re-selects the records; the strip's
          height never changes (the rows are laid out in the plot column beside it). */}
      <div
        className="absolute right-0 top-1 flex w-11 flex-row items-center justify-end gap-0.5"
        data-testid={`${testId}-windows`}
      >
        {PULSE_WINDOW_HOURS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => selectWindow(option)}
            aria-pressed={option === hours}
            className={cn(
              'rounded px-1 text-[9px] leading-3 tabular-nums',
              option === hours
                ? 'bg-muted font-semibold text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
            data-testid={`${testId}-window-${option}`}
          >
            {option}h
          </button>
        ))}
      </div>

      <div className="absolute inset-y-0 left-0 right-11 flex flex-col" style={{ paddingBottom: STRIP_PADDING }}>
        {rows.map((row) => (
          <div
            key={row.id}
            className="relative w-full"
            style={{ height: row.height }}
            data-testid={`${testId}-row-${row.id}`}
            data-row-height={row.height}
            data-unread={row.unread ? 'true' : undefined}
            aria-label={t(`cockpit.pulseRow${row.id === 'inflight' ? 'InFlight' : row.id === 'fanin' ? 'FanIn' : row.id === 'suite' ? 'Suite' : 'Blocked'}`)}
          >
            {row.id === 'inflight' &&
              inFlightRows.map((entry) => (
                <button
                  key={entry.task.taskId}
                  type="button"
                  onClick={(event) => {
                    // The strip is embedded inside the fleet tile, whose own click opens the
                    // board. Activating a mark must focus the TASK, not also trigger that.
                    event.stopPropagation();
                    onFocusTask?.(entry.task.taskId);
                  }}
                  onMouseEnter={() => showTooltip(entry.tooltip, entry.left)}
                  onMouseLeave={() => setHover(null)}
                  aria-label={entry.tooltip}
                  title={entry.tooltip}
                  className={cn(
                    'absolute rounded-full',
                    entry.phase.className,
                    onFocusTask !== undefined && 'cursor-pointer',
                  )}
                  style={{ left: `${entry.left}%`, width: `${entry.width}%`, top: entry.lane * 4 + 1, height: 2 }}
                  data-testid={`${testId}-inflight-line`}
                  data-phase={entry.task.phase}
                  data-lane={entry.lane}
                  data-shape="in-flight-line"
                  data-stale={entry.stale ? 'true' : undefined}
                />
              ))}

            {row.id === 'inflight' &&
              inFlightRows
                .filter((entry) => entry.stale)
                .map((entry) => (
                  <span
                    key={`stale-${entry.task.taskId}`}
                    aria-label={t('cockpit.pulseStaleInFlight')}
                    title={t('cockpit.pulseStaleInFlight')}
                    className={cn(
                      'absolute h-1.5 w-1.5 rounded-full border bg-transparent',
                      'border-red-600 dark:border-red-400',
                    )}
                    style={{ left: `calc(${entry.left + entry.width}% - 3px)`, top: entry.lane * 4, }}
                    data-testid={`${testId}-inflight-stale-dot`}
                    data-shape="hollow-dot"
                  />
                ))}

            {row.id === 'fanin' &&
              fanInMarks.map((mark, index) => (
                <span
                  key={`${mark.attempt.task}-${mark.at}-${index}`}
                  onMouseEnter={() => showTooltip(mark.tooltip, mark.left)}
                  onMouseLeave={() => setHover(null)}
                  title={mark.tooltip}
                  aria-label={mark.tooltip}
                  className={cn('absolute w-px', STATUS_STYLES[mark.severity].className)}
                  style={{
                    left: `${mark.left}%`,
                    // Success rises from the baseline (row middle) and failure sinks below it.
                    ...(mark.success ? { bottom: '50%', height: 4 } : { top: '50%', height: 4 }),
                  }}
                  data-testid={`${testId}-fanin-mark`}
                  data-outcome={mark.attempt.outcome}
                  data-direction={mark.success ? 'up' : 'down'}
                  data-severity={mark.severity}
                  data-shape={mark.success ? 'fan-in-up' : 'fan-in-down'}
                />
              ))}

            {row.id === 'suite' &&
              suiteMarks.map((mark, index) => (
                <span
                  key={`${mark.round.round}-${mark.at}-${index}`}
                  onMouseEnter={() => showTooltip(mark.tooltip, mark.left)}
                  onMouseLeave={() => setHover(null)}
                  title={mark.tooltip}
                  aria-label={mark.tooltip}
                  className={cn('absolute bottom-0 w-px', STATUS_STYLES[mark.severity].className)}
                  style={{ left: `${mark.left}%`, height: mark.height }}
                  data-testid={`${testId}-suite-mark`}
                  data-state={mark.round.state}
                  data-severity={mark.severity}
                  data-duration-ms={mark.round.durationMs ?? undefined}
                  // The failing round carries an explicit glyph, not just the red hue.
                  data-shape={mark.failed ? 'suite-fail' : 'suite-pass'}
                >
                  {mark.failed && (
                    <span
                      className={cn('absolute -top-1 left-0 text-[7px] leading-none', STATUS_STYLES.critical.text)}
                      data-testid={`${testId}-suite-fail-glyph`}
                    >
                      ✕
                    </span>
                  )}
                </span>
              ))}

            {row.id === 'blocked' &&
              blockerSegments.map((segment, index) => (
                <button
                  key={`${segment.blocker.taskId}-${index}`}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onFocusTask?.(segment.blocker.taskId);
                  }}
                  onMouseEnter={() => showTooltip(segment.tooltip, segment.left)}
                  onMouseLeave={() => setHover(null)}
                  aria-label={segment.tooltip}
                  title={segment.tooltip}
                  className={cn(
                    'absolute h-0.5 rounded-full',
                    STATUS_STYLES.critical.className,
                    onFocusTask !== undefined && 'cursor-pointer',
                  )}
                  style={{ left: `${segment.left}%`, width: `${segment.width}%`, top: 4 }}
                  data-testid={`${testId}-blocker-segment`}
                  data-signature={segment.blocker.signature}
                  data-occurrences={segment.blocker.occurrences}
                  data-dependents={segment.dependents}
                  data-shape="blocked"
                >
                  <span
                    className={cn(
                      'absolute -top-2 left-full whitespace-nowrap text-[8px] font-semibold leading-none',
                      STATUS_STYLES.critical.text,
                    )}
                    data-testid={`${testId}-blocker-impact`}
                  >
                    {`⛔ ${segment.dependents}`}
                    {segment.blocker.occurrences > 1 ? ` ×${segment.blocker.occurrences}` : ''}
                  </span>
                </button>
              ))}
          </div>
        ))}
      </div>

      {isEmpty && (
        <p
          className="absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-[10px] text-muted-foreground"
          data-testid={`${testId}-empty`}
        >
          {t('cockpit.pulseNoActivity', { hours })}
        </p>
      )}

      {hover !== null && (
        <div
          role="tooltip"
          className="pointer-events-none absolute -top-7 z-50 max-w-[240px] -translate-x-1/2 whitespace-nowrap rounded bg-popover px-1.5 py-0.5 text-[10px] text-popover-foreground shadow"
          style={{ left: `${clampPercent(hover.leftPercent)}%` }}
          data-testid={`${testId}-tooltip`}
        >
          {hover.text}
        </div>
      )}
    </div>
  );
}
