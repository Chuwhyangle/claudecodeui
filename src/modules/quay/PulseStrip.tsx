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
 * The pulse strip: one project's last N hours in four labelled rows — in flight, fan-in
 * outcomes, suite rounds and live blockers — under a time axis.
 *
 * WHY IT EXISTS. The Quay panel's Loop pulse card is a full chart with axis labels and a
 * 600×H coordinate space; it answers "what ran" when a person is already looking at one
 * project. The cockpit needs the opposite reading: every project, on one screen, continuously,
 * in a form that can be scanned without reading. The first version of this strip was dense to
 * the point of being illegible: the rows only had `aria-label`s, there was no time axis, and the
 * window selector was squeezed into a 44 px column that actually overflowed leftwards beneath
 * the in-flight row (its 6 h button could not be clicked). This version keeps the density of the
 * marks but spends vertical space on the three things a reader needs:
 *
 *   chrome (24 px)   — the 6 h / 24 h / 72 h segmented control, in its own region above the plot
 *                      (a coarse pointer gets 44 px buttons instead of 24 px ones).
 *   in flight (30 px) — up to three lanes of ≥8 px bars, one per running task. A bar is only a
 *                      few percent of the window wide for a freshly started task, so its id is
 *                      drawn inside the bar only when it fits; otherwise the id stays in the
 *                      tooltip / accessible name. Heartbeat older than the worker's round
 *                      interval ⇒ the bar ends in a HOLLOW DOT.
 *   fan-in    (10 px) — one thin vertical mark per mechanical attempt. Success rises from the
 *                      baseline, failure sinks below it; retry/ff is `serious`.
 *   suite     (10 px) — one vertical mark per round, height ∝ duration / median; a failing round
 *                      is `critical` and carries `✕`. The row label carries a `?` legend that
 *                      spells out both encodings (and is tappable, not hover-only).
 *   blocked   (10 px) — one horizontal segment per live failure signature, from its first
 *                      occurrence to now, ending in `⛔ N` (N = dependent tasks).
 *   axis      (12 px) — `-{window}h` … `-{window/2}h` … now, under the data column.
 *
 * Every row's visible label lives in a fixed 56 px column, so the label and the data track can
 * never overlap; and because the window selector sits in the chrome above the plot, it is not a
 * descendant of — and cannot be covered by — a row.
 *
 * COLOUR IS NEVER THE ONLY CHANNEL (dataviz rule): every state also carries a shape — the
 * in-flight bar's stale end (solid vs hollow), a fan-in mark's direction (up vs down), the
 * `✕` on a failing suite round, the `⛔` glyph on a blocked segment. The two palettes are
 * DISJOINT BY CONSTRUCTION: in-flight phases use categorical hues (blue/violet/cyan/indigo)
 * and only health uses the status hues (green/amber/orange/red), so 「紫的那条」 can never be
 * confused with 「红的那个」.
 *
 * The strip owns no data fetching and no clock: it is handed one reading (the Quay panel's
 * `QuaySnapshot` or a fleet entry's `QuayPulseSummary`) and draws exactly it.
 */

/** The chrome row's height: the window selector lives here, above the plot. */
export const PULSE_CHROME_HEIGHT_PX = 24;

/** The fixed width of each row's label column, in CSS pixels. */
export const PULSE_LABEL_COLUMN_PX = 56;

/** The time axis under the data column. */
export const PULSE_AXIS_HEIGHT_PX = 12;

/** The visible height of the segmented window control (a coarse pointer gets 44 px). */
export const PULSE_SELECTOR_HEIGHT_PX = 24;
/** The coarse-pointer hit target the selector must reach, in CSS pixels. */
export const PULSE_SELECTOR_TOUCH_TARGET_PX = 44;

/** The in-flight bar height. Exported because the readability criterion reads the real value. */
export const PULSE_IN_FLIGHT_BAR_HEIGHT_PX = 8;
/** One lane's vertical pitch inside the in-flight row. */
export const PULSE_IN_FLIGHT_LANE_HEIGHT_PX = 10;
/** How many lanes the in-flight row offers before tasks start sharing one. */
export const PULSE_IN_FLIGHT_LANE_COUNT = 3;
/** The in-flight row: three lanes of 10 px. */
export const PULSE_IN_FLIGHT_ROW_HEIGHT_PX = PULSE_IN_FLIGHT_LANE_COUNT * PULSE_IN_FLIGHT_LANE_HEIGHT_PX;

/**
 * A bar narrower than this percentage of the window draws no label (the id stays in the
 * tooltip / accessible name). A 1 h task in a 24 h window is 4.2 % wide: below the threshold,
 * which is correct — 4 % of a desktop track is not enough for a task id.
 */
export const PULSE_INFLIGHT_LABEL_MIN_PERCENT = 5;

const FAN_IN_ROW_HEIGHT = 10;
const SUITE_ROW_HEIGHT = 10;
const BLOCKER_ROW_HEIGHT = 10;
const PULSE_ROWS_HEIGHT_PX =
  PULSE_IN_FLIGHT_ROW_HEIGHT_PX + FAN_IN_ROW_HEIGHT + SUITE_ROW_HEIGHT + BLOCKER_ROW_HEIGHT;
const PULSE_PLOT_HEIGHT_PX = PULSE_ROWS_HEIGHT_PX + PULSE_AXIS_HEIGHT_PX;

/**
 * The height the strip promises on a fine pointer, in CSS pixels: chrome + rows + axis.
 * (On a coarse pointer the chrome grows to 44 px, so the strip grows with it.)
 */
export const PULSE_STRIP_HEIGHT_PX = PULSE_CHROME_HEIGHT_PX + PULSE_PLOT_HEIGHT_PX;

/**
 * The layout constants the disjointness criterion reads instead of jsdom geometry:
 * the chrome ends exactly where the plot begins, so no row can be under the selector.
 */
export const PULSE_STRIP_LAYOUT = {
  chromeTopPx: 0,
  chromeHeightPx: PULSE_CHROME_HEIGHT_PX,
  plotTopPx: PULSE_CHROME_HEIGHT_PX,
  plotHeightPx: PULSE_PLOT_HEIGHT_PX,
  labelColumnPx: PULSE_LABEL_COLUMN_PX,
  axisHeightPx: PULSE_AXIS_HEIGHT_PX,
  selectorHeightPx: PULSE_SELECTOR_HEIGHT_PX,
  selectorTouchTargetPx: PULSE_SELECTOR_TOUCH_TARGET_PX,
  inFlightBarHeightPx: PULSE_IN_FLIGHT_BAR_HEIGHT_PX,
} as const;

/** The windows the strip offers, in hours, with 24 h (one day) as its default reading. */
export const PULSE_WINDOW_HOURS = [6, 24, 72] as const;
export const DEFAULT_PULSE_WINDOW_HOURS = 24;

/**
 * How old an in-flight task's heartbeat may be before its bar ends in a hollow dot.
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
  /** Lane reading, used only to place each in-flight bar on the lane the gantt would draw it. */
  gantt?: QuayGanttLanes | null;
  tests: QuayTestsSummary;
  fanIn: QuayFanInSummary;
  /** Live blockers; `null` = unread store, `[]` = read and nothing blocked. */
  blockers?: QuayBlockerSummary[] | null;
  /** The reading's own clock (ISO-8601); the strip never calls `Date.now()` for its window. */
  generatedAt: string;
  /** Controlled window in hours. Omitted ⇒ the strip keeps its own (default 24). */
  windowHours?: number;
  /** Invoked when a window is picked; omitted ⇒ the selector still works internally. */
  onWindowChange?: (hours: number) => void;
  /** Invoked with the task id behind an activated in-flight bar / blocked segment. */
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
 * controls it), the hover tooltip and the suite legend, and reports activation upward through
 * `onFocusTask`.
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
  const [legendOpen, setLegendOpen] = useState(false);

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
    const laneIndex = (lane ?? index) % PULSE_IN_FLIGHT_LANE_COUNT;
    const heartbeatMs = toEpochMs(task.lastHeartbeat);
    const stale = heartbeatMs !== null && nowMs - heartbeatMs > PULSE_STALE_AFTER_MS;
    const phase = IN_FLIGHT_PHASES[task.phase];
    const left = toPercent(Math.max(startMs, windowStartMs));
    const width = Math.max(0.4, toPercent(nowMs) - left);
    const tooltip = `${task.taskId} · ${t(phase.labelKey)} · ${formatDuration(nowMs - Math.max(startMs, windowStartMs))}`
      + (stale ? ` · ${t('cockpit.pulseStaleInFlight')}` : '');
    // A bar too narrow for its id keeps the id in the tooltip / accessible name only.
    const showLabel = width >= PULSE_INFLIGHT_LABEL_MIN_PERCENT;
    return [{ task, phase, lane: laneIndex, left, width, stale, tooltip, showLabel }];
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
      {
        id: 'inflight',
        height: PULSE_IN_FLIGHT_ROW_HEIGHT_PX,
        unread: inFlight === null,
        labelKey: 'cockpit.pulseRowInFlight',
      },
      { id: 'fanin', height: FAN_IN_ROW_HEIGHT, unread: false, labelKey: 'cockpit.pulseRowFanIn' },
      { id: 'suite', height: SUITE_ROW_HEIGHT, unread: false, labelKey: 'cockpit.pulseRowSuite' },
      { id: 'blocked', height: BLOCKER_ROW_HEIGHT, unread: blockers === null, labelKey: 'cockpit.pulseRowBlocked' },
    ],
    [inFlight, blockers],
  );

  return (
    <div
      className="relative flex w-full select-none flex-col"
      style={{ minHeight: PULSE_STRIP_HEIGHT_PX }}
      data-testid={testId}
      data-height-px={PULSE_STRIP_HEIGHT_PX}
      data-window-hours={hours}
      data-empty={isEmpty ? 'true' : undefined}
    >
      {/*
        CHROME — the window selector's own region, above the plot. It is a normal-flow sibling of
        the plot (not an absolute child of a row), so the three buttons can never sit under the
        in-flight marks: the old `w-11` + `justify-end` column overflowed leftwards and ate the
        6 h button. `h-6` is the 24 px visible control; the coarse-pointer variant gives each
        button a 44 px hit target instead.
      */}
      <div
        className="flex h-6 shrink-0 items-center justify-end [@media(pointer:coarse)]:h-11"
        data-testid={`${testId}-chrome`}
        data-layout-region="chrome"
        data-layout-top-px={PULSE_STRIP_LAYOUT.chromeTopPx}
        data-layout-height-px={PULSE_STRIP_LAYOUT.chromeHeightPx}
      >
        <div
          role="group"
          aria-label={t('cockpit.pulseWindowGroup')}
          className="flex h-6 items-center gap-0.5 rounded-md border border-border bg-muted/40 [@media(pointer:coarse)]:h-11"
          data-testid={`${testId}-windows`}
          data-layout-region="chrome"
          data-control-height-px={PULSE_SELECTOR_HEIGHT_PX}
          data-touch-target-px={PULSE_SELECTOR_TOUCH_TARGET_PX}
        >
          {PULSE_WINDOW_HOURS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => selectWindow(option)}
              aria-pressed={option === hours}
              className={cn(
                'h-6 min-w-8 rounded px-1.5 text-[10px] leading-none tabular-nums transition-colors',
                '[@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-w-11',
                option === hours
                  ? 'bg-primary font-semibold text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
              data-testid={`${testId}-window-${option}`}
            >
              {option}h
            </button>
          ))}
        </div>
      </div>

      {/* PLOT — the labelled rows, then the time axis. */}
      <div
        className="relative flex min-h-0 flex-1 flex-col"
        data-testid={`${testId}-plot`}
        data-layout-region="plot"
        data-layout-top-px={PULSE_STRIP_LAYOUT.plotTopPx}
        data-layout-height-px={PULSE_STRIP_LAYOUT.plotHeightPx}
      >
        {rows.map((row) => (
          <div
            key={row.id}
            className="relative flex w-full items-center"
            style={{ height: row.height }}
            data-testid={`${testId}-row-${row.id}`}
            data-row-height={row.height}
            data-layout-region="row"
            data-unread={row.unread ? 'true' : undefined}
            aria-label={t(row.labelKey)}
          >
            {/* The fixed label column: visible text for every row, never overlapping the track. */}
            <span
              className="flex shrink-0 items-center gap-0.5 pr-1"
              style={{ width: PULSE_LABEL_COLUMN_PX }}
            >
              <span
                className="truncate text-[10px] font-medium text-muted-foreground"
                data-testid={`${testId}-row-${row.id}-label`}
              >
                {t(row.labelKey)}
              </span>
              {row.id === 'suite' && (
                <button
                  type="button"
                  aria-label={t('cockpit.pulseLegend')}
                  title={t('cockpit.pulseLegend')}
                  aria-expanded={legendOpen}
                  onClick={(event) => {
                    event.stopPropagation();
                    setLegendOpen((open) => !open);
                  }}
                  className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-border text-[8px] leading-none text-muted-foreground hover:text-foreground"
                  data-testid={`${testId}-legend`}
                >
                  ?
                </button>
              )}
            </span>

            <div
              className="relative h-full flex-1"
              data-testid={`${testId}-row-${row.id}-track`}
              data-layout-region="track"
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
                      'absolute flex items-center overflow-hidden rounded-[2px] text-[9px] font-medium leading-none',
                      'text-white dark:text-slate-950',
                      entry.phase.className,
                      onFocusTask !== undefined && 'cursor-pointer',
                    )}
                    style={{
                      left: `${entry.left}%`,
                      width: `${entry.width}%`,
                      top: entry.lane * PULSE_IN_FLIGHT_LANE_HEIGHT_PX,
                      height: PULSE_IN_FLIGHT_BAR_HEIGHT_PX,
                    }}
                    data-testid={`${testId}-inflight-line`}
                    data-phase={entry.task.phase}
                    data-lane={entry.lane}
                    data-bar-height-px={PULSE_IN_FLIGHT_BAR_HEIGHT_PX}
                    data-show-label={entry.showLabel ? 'true' : undefined}
                    data-shape="in-flight-bar"
                    data-stale={entry.stale ? 'true' : undefined}
                  >
                    {entry.showLabel && (
                      <span className="pointer-events-none truncate px-1">{entry.task.taskId}</span>
                    )}
                  </button>
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
                      style={{
                        left: `calc(${entry.left + entry.width}% - 3px)`,
                        top: entry.lane * PULSE_IN_FLIGHT_LANE_HEIGHT_PX
                          + (PULSE_IN_FLIGHT_BAR_HEIGHT_PX - 6) / 2,
                      }}
                      data-testid={`${testId}-inflight-stale-dot`}
                      data-shape="hollow-dot"
                    />
                  ))}

              {row.id === 'inflight' && inFlight !== null && inFlightRows.length === 0 && (
                <span
                  className="absolute left-1 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground"
                  data-testid={`${testId}-inflight-empty`}
                >
                  {t('cockpit.inFlightEmpty')}
                </span>
              )}

              {row.id === 'fanin' &&
                fanInMarks.map((mark, index) => (
                  <span
                    key={`${mark.attempt.task}-${mark.at}-${index}`}
                    onMouseEnter={() => showTooltip(mark.tooltip, mark.left)}
                    onMouseLeave={() => setHover(null)}
                    title={mark.tooltip}
                    aria-label={mark.tooltip}
                    className={cn(
                      // The visual is one thin line; the `before` box is an invisible 5 px hit
                      // target so a pointer can actually land on it (density must not make the
                      // reading unhoverable).
                      'absolute w-px before:absolute before:-inset-x-2 before:inset-y-0 before:content-[""]',
                      STATUS_STYLES[mark.severity].className,
                    )}
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
                    className={cn(
                      'absolute bottom-0 w-px before:absolute before:-inset-x-2 before:inset-y-0 before:content-[""]',
                      STATUS_STYLES[mark.severity].className,
                    )}
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
                        className={cn('pointer-events-none absolute -top-1 left-0 text-[7px] leading-none', STATUS_STYLES.critical.text)}
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
                        'pointer-events-none absolute -top-2 left-full whitespace-nowrap text-[8px] font-semibold leading-none',
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
          </div>
        ))}

        {/* TIME AXIS — aligned with the data column (the label column is its left inset). */}
        <div
          className="relative shrink-0"
          style={{ height: PULSE_AXIS_HEIGHT_PX, marginLeft: PULSE_LABEL_COLUMN_PX }}
          data-testid={`${testId}-axis`}
          data-layout-region="axis"
        >
          {[0, 25, 50, 75, 100].map((position) => (
            <span
              key={position}
              aria-hidden="true"
              className="absolute top-0 h-1 w-px bg-border"
              style={{ left: `${position}%` }}
            />
          ))}
          <div className="absolute inset-x-0 top-1 flex items-center justify-between text-[9px] leading-none text-muted-foreground tabular-nums">
            <span data-testid={`${testId}-axis-start`}>{`-${hours}h`}</span>
            <span data-testid={`${testId}-axis-mid`}>{`-${hours / 2}h`}</span>
            <span data-testid={`${testId}-axis-now`}>{t('cockpit.pulseNow')}</span>
          </div>
        </div>

        {isEmpty && (
          <p
            className="pointer-events-none absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground"
            data-testid={`${testId}-empty`}
          >
            {t('cockpit.pulseNoActivity', { hours })}
          </p>
        )}

        {legendOpen && (
          <div
            role="tooltip"
            className="absolute left-0 z-50 max-w-[260px] rounded bg-popover px-1.5 py-1 text-[10px] text-popover-foreground shadow"
            style={{ top: PULSE_IN_FLIGHT_ROW_HEIGHT_PX + FAN_IN_ROW_HEIGHT + 4 }}
            data-testid={`${testId}-legend-text`}
          >
            {t('cockpit.pulseLegend')}
          </div>
        )}
      </div>

      {/* The one baseline the strip keeps: a 1 px rule at the foot, above no axis text. */}
      <div className="absolute inset-x-0 bottom-0 h-px bg-border" data-testid={`${testId}-baseline`} />

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
