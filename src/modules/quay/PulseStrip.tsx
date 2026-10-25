import type {
  QuayBlockerSummary,
  QuayFanInSummary,
  QuayGanttLanes,
  QuayInFlightTask,
  QuayTestsSummary,
} from '@/shared/types';
import {
  LOOP_PULSE_PLOT_HEIGHT,
  TIMELINE_PLOT_HEIGHT,
} from '@/modules/quay/chartGeometry';
import LoopPulseGantt from '@/modules/quay/LoopPulseGantt';
import TimelineBar from '@/modules/quay/TimelineBar';
import { fanInTimelineRanges, resolveTimelineWindow, testsTimelineRanges } from '@/modules/quay/timelineMapping';

/**
 * The cockpit's per-project pulse strip: the Quay tab's three existing time charts, stacked.
 *
 * WHY IT EXISTS. The cockpit fleet view needs, per project, the same reading the Quay tab's
 * Loop pulse / Tests / Fan-in cards show, without opening each project. It used to draw its own
 * four-row miniature (its own bars, a failing-suite glyph, a blocked glyph, a label column, its
 * own axis) — a second visual language for facts that already had one. The user's ruling is that
 * it must instead COMPOSE the existing charts: `LoopPulseGantt` (the in-flight runs), and a
 * `TimelineBar` for the suite rounds and for the fan-in attempts, stacked in one column at the
 * same host width and over the same window. There is deliberately no new graphic encoding here.
 *
 * ALIGNMENT. All three plots read `chartGeometry.ts`, so their plot left/right edges and the x of
 * any instant are identical once the host width matches; `timelineMapping.ts` supplies the one
 * window (`gantt.windowHours` + `gantt.nowMs`, falling back to the requested window and the
 * reading's own `generatedAt`) and the two range sets, so the tab and the cockpit cannot disagree
 * about where a round or an attempt sits.
 *
 * WHAT IS NOT DRAWN, AND WHY.
 * - Blocked. None of the three existing charts has a "blocker" mark, so drawing one would be a new
 *   encoding. `blockers` stays on the props (callers still pass it) but is not rendered during this
 *   experiment.
 * - `inFlight` as a separate row. `LoopPulseGantt` plots the in-flight runs from the same lane
 *   reading; re-drawing them would be the duplication this task removes. The prop stays on the
 *   interface for its callers.
 * - Task focus. The existing charts' marks are display-only (`<title>` tooltips, no click
 *   handlers), so `onFocusTask` is kept on the interface but is never invoked while this
 *   experiment runs.
 *
 * The strip owns no data fetching and no clock (beyond the mapping's last-resort `Date.now()`);
 * it is handed one reading (`QuayPulseSummary`) and renders exactly it.
 */

/** The windows the Quay tab's Loop pulse card offers, re-exported for callers that select one. */
export const PULSE_WINDOW_HOURS = [6, 24, 72] as const;

/** The fallback window when the reading carries no lane reading and the host selects none. */
export const DEFAULT_PULSE_WINDOW_HOURS = 24;

/**
 * The height the stacked charts occupy on a fine pointer, in CSS pixels. It is the sum of the
 * three charts' viewBox heights; the Loop pulse slot renders a reason line (shorter) when there
 * is no lane reading, so this is a floor, not a measurement of every state.
 */
export const PULSE_STRIP_HEIGHT_PX = LOOP_PULSE_PLOT_HEIGHT + 2 * TIMELINE_PLOT_HEIGHT;

export type PulseStripProps = {
  /**
   * The in-flight reading. Retained on the interface for callers; the gantt lanes (below) are the
   * same reading and are what `LoopPulseGantt` plots, so this is not rendered separately.
   */
  inFlight: QuayInFlightTask[] | null;
  /** The lane reading the Loop pulse chart draws; `null` renders the chart's stated reason line. */
  gantt?: QuayGanttLanes | null;
  tests: QuayTestsSummary;
  fanIn: QuayFanInSummary;
  /**
   * Live blockers; `null` = unread store, `[]` = read and nothing blocked. Retained on the
   * interface, deliberately NOT rendered: the existing three charts have no blocker encoding,
   * and inventing one is out of scope (see the component comment).
   */
  blockers?: QuayBlockerSummary[] | null;
  /** The reading's own clock (ISO-8601); the strip never calls `Date.now()` for its window. */
  generatedAt: string;
  /**
   * The window to fall back to when the reading carries no lane window. Omitted ⇒
   * `DEFAULT_PULSE_WINDOW_HOURS`. With a lane reading, the gantt's own window always wins so the
   * three charts share one slice.
   */
  windowHours?: number;
  /**
   * Forwarded to `LoopPulseGantt`, which renders its window selector only when a host can honour
   * a change. The strip itself offers no window control of its own.
   */
  onWindowChange?: (hours: number) => void;
  /**
   * Retained for interface compatibility. Never invoked during this experiment: the three
   * composed charts' marks are display-only, so the strip has no clickable mark to report.
   */
  onFocusTask?: (taskId: string) => void;
  /** Prefix for the component's test ids. */
  testId?: string;
};

/**
 * Renders one project's stacked pulse charts. Display-only: it owns no state, and every window /
 * range decision is delegated to the shared mapping so the Quay tab renders the same picture.
 */
export default function PulseStrip({
  gantt = null,
  tests,
  fanIn,
  generatedAt,
  windowHours,
  onWindowChange,
  testId = 'pulse-strip',
}: PulseStripProps) {
  const requestedWindowHours = windowHours ?? DEFAULT_PULSE_WINDOW_HOURS;
  const timelineWindow = resolveTimelineWindow(gantt, requestedWindowHours, generatedAt);
  const hours = gantt?.windowHours ?? requestedWindowHours;

  return (
    <div
      className="flex w-full select-none flex-col"
      style={{ minHeight: PULSE_STRIP_HEIGHT_PX }}
      data-testid={testId}
      data-height-px={PULSE_STRIP_HEIGHT_PX}
      data-window-hours={hours}
      data-window-start={timelineWindow.startMs}
      data-window-end={timelineWindow.endMs}
    >
      {/*
        The three charts are siblings of this container, in this order. Only a host that can
        re-read the lanes gets the gantt's selector; the cockpit passes no handler, so no window
        control is drawn here.
      */}
      <LoopPulseGantt
        gantt={gantt}
        windowHours={gantt === null ? requestedWindowHours : undefined}
        onWindowChange={onWindowChange}
      />
      <TimelineBar
        ranges={testsTimelineRanges(tests)}
        window={timelineWindow}
        emptyText="No suite rounds recorded."
        testId={`${testId}-tests`}
      />
      <TimelineBar
        ranges={fanInTimelineRanges(fanIn)}
        window={timelineWindow}
        emptyText="No fan-in attempts recorded."
        testId={`${testId}-fanin`}
      />
    </div>
  );
}
