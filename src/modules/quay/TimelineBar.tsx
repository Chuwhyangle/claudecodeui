import type { QuayTimelineWindow } from '@/shared/types';
import { cn } from '@/shared/utils';
import {
  MIN_BAR_WIDTH,
  PAD,
  PLOT_LEFT,
  PLOT_WIDTH,
  PLOT_WIDTH_INNER,
  TIMELINE_AXIS_Y,
  TIMELINE_BAR_HEIGHT,
  TIMELINE_BAR_TOP,
  TIMELINE_PLOT_HEIGHT,
} from '@/modules/quay/chartGeometry';

/** One interval drawn on a `TimelineBar`, in Unix epoch milliseconds. */
export type TimelineBarRange = {
  /** Interval start, Unix epoch milliseconds. */
  startMs: number;
  /** Interval end, Unix epoch milliseconds. */
  endMs: number;
  /** Status key selecting the bar's colour (`green`/`red`/`landed`/…). */
  state: string;
  /** Human-readable tooltip text shown by the native `<title>`. */
  label: string;
};

type TimelineBarProps = {
  /**
   * Intervals to draw, in any order. A range that lies entirely outside `window`
   * is dropped and one that straddles an edge is clamped to it, so the bar is
   * always a slice of exactly the shared window — never the ranges' own extent.
   */
  ranges: TimelineBarRange[];
  /**
   * The time window shared with the Loop pulse gantt, in Unix epoch milliseconds.
   * The bar maps every instant through these endpoints and marks `endMs` with a
   * `now` line; it never derives a window of its own from `ranges`.
   */
  window: QuayTimelineWindow;
  /** Text shown in place of the SVG when no range falls inside `window`. */
  emptyText: string;
  /** Prefix for the component's test ids: the container, each `<rect>`, the axis labels, the now line and the empty state. */
  testId: string;
};

// The bar is drawn in the shared `PLOT_WIDTH`-wide coordinate space (`chartGeometry`) and
// scaled to the host width uniformly by CSS (`w-full h-auto`). It deliberately does NOT
// stretch with `preserveAspectRatio="none"`: the axis labels are real text, and non-uniform
// scaling would distort them — the same reason the gantt scales uniformly. The shared
// `PLOT_LEFT`/`PLOT_WIDTH_INNER` are what let a moment line up between the charts.

/** Colour per status key; both test rounds (`green`/`red`) and fan-in outcomes (`landed`/`failed`) map onto the same palette. */
const STATE_TEXT_CLASSES: Record<string, string> = {
  green: 'text-green-500',
  landed: 'text-green-500',
  red: 'text-red-500',
  failed: 'text-red-500',
  'exited-not-landed': 'text-amber-500',
};
const DEFAULT_STATE_CLASS = 'text-gray-400';

/** `HH:MM` for an axis label, in the reader's own locale — the same format the Loop pulse gantt prints. */
function formatClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Whether a range overlaps `window` at all (both endpoints inclusive). */
function intersectsWindow(range: TimelineBarRange, window: QuayTimelineWindow): boolean {
  return range.endMs >= window.startMs && range.startMs <= window.endMs;
}

/**
 * Used by the Quay panel's Tests and Fan-in cards to draw a single-lane timeline of
 * recent records over an *explicit* window (the one `QuayPanel` derives from the Loop
 * pulse reading). It maps each interval's `[startMs, endMs]` onto that window
 * (`X(t) = (t - windowStart) / windowSpan`, the same coordinate maths the Loop pulse
 * gantt uses), so records share their relative positions with the gantt and the three
 * charts can be read against one another. Ranges outside the window are clipped away;
 * a start/end clock label and a `now` vertical line are drawn so the axis is readable
 * without a legend. `title` children give each rect a native tooltip; the component is
 * display-only and owns no state.
 */
export default function TimelineBar({ ranges, window, emptyText, testId }: TimelineBarProps) {
  const { startMs: windowStart, endMs: windowEnd } = window;
  // Guard a degenerate window (all endpoints equal) so the divisor is never 0.
  const windowSpan = Math.max(1, windowEnd - windowStart);
  const toX = (timeMs: number): number => PLOT_LEFT + ((timeMs - windowStart) / windowSpan) * PLOT_WIDTH_INNER;

  // Clip to the window before deciding whether the bar is empty: a card whose only
  // records fell outside the shared window has nothing to plot.
  const visibleRanges = ranges.filter((range) => intersectsWindow(range, window));

  if (visibleRanges.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid={`${testId}-empty`}>
        {emptyText}
      </p>
    );
  }

  const nowX = toX(windowEnd);

  return (
    <svg
      viewBox={`0 0 ${PLOT_WIDTH} ${TIMELINE_PLOT_HEIGHT}`}
      role="img"
      aria-label="timeline"
      className="h-auto w-full"
      data-testid={testId}
      // The shared window, exposed as machine-readable readings so a reader (and the test
      // that guards it) can compare the three charts' endpoints without parsing clock text.
      data-window-start={windowStart}
      data-window-end={windowEnd}
    >
      {visibleRanges.map((range, index) => {
        // Clamp to the window: a range that began before it starts at the left edge, and one
        // that runs past `now` ends at the right edge.
        const start = Math.max(range.startMs, windowStart);
        const end = Math.min(Math.max(range.endMs, range.startMs), windowEnd);
        const left = toX(start);
        return (
          <rect
            key={`${range.label}-${index}`}
            x={left}
            y={TIMELINE_BAR_TOP}
            width={Math.max(MIN_BAR_WIDTH, toX(Math.max(end, start + 1)) - left)}
            height={TIMELINE_BAR_HEIGHT}
            fill="currentColor"
            className={cn(STATE_TEXT_CLASSES[range.state] ?? DEFAULT_STATE_CLASS)}
            data-testid={`${testId}-rect`}
          >
            <title>{range.label}</title>
          </rect>
        );
      })}

      {/* The `now` instant (the window's right edge) as a vertical line, so the reader can
          see where "now" sits relative to the records — the gantt marks the same edge. */}
      <line
        x1={nowX}
        y1={TIMELINE_BAR_TOP}
        x2={nowX}
        y2={TIMELINE_AXIS_Y}
        stroke="currentColor"
        strokeWidth={1}
        className="text-amber-500"
        data-testid={`${testId}-now`}
      >
        <title>{`now ${formatClock(windowEnd)}`}</title>
      </line>

      <line x1={PLOT_LEFT} y1={TIMELINE_AXIS_Y} x2={PLOT_WIDTH - PAD} y2={TIMELINE_AXIS_Y} stroke="currentColor" className="text-border" />
      <text
        x={PLOT_LEFT}
        y={TIMELINE_PLOT_HEIGHT - 1}
        fontSize={9}
        fill="currentColor"
        className="text-muted-foreground"
        data-testid={`${testId}-axis-start`}
      >
        {formatClock(windowStart)}
      </text>
      <text
        x={PLOT_WIDTH - PAD}
        y={TIMELINE_PLOT_HEIGHT - 1}
        fontSize={9}
        textAnchor="end"
        fill="currentColor"
        className="text-muted-foreground"
        data-testid={`${testId}-axis-end`}
      >
        {formatClock(windowEnd)}
      </text>
    </svg>
  );
}
