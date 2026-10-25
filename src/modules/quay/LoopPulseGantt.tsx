import type { QuayGanttInterval, QuayGanttLanes, QuayGanttUnavailableReason } from '@/shared/types';
import { cn } from '@/shared/utils';
import {
  LOOP_PULSE_AXIS_Y,
  LOOP_PULSE_BAR_HEIGHT,
  LOOP_PULSE_LANE_HEIGHT,
  LOOP_PULSE_LANES,
  LOOP_PULSE_PLOT_HEIGHT,
  LOOP_PULSE_TOP,
  MIN_BAR_WIDTH,
  PAD,
  PLOT_LEFT,
  PLOT_WIDTH,
  PLOT_WIDTH_INNER,
} from '@/modules/quay/chartGeometry';

/**
 * How many lane guide lines to draw. Fixed at quay's own `FIXED_GANTT_LANES`, and
 * deliberately NOT derived from `lanes.length`: the guide lines are the card's visual
 * contract ("this board has five lanes"), so a quiet board must still show five empty
 * lanes rather than collapsing to however many happen to be occupied.
 */
export const GANTT_LANES = LOOP_PULSE_LANES;

// The bar is drawn in the shared `PLOT_WIDTH`-wide coordinate space (`chartGeometry`) and
// scaled uniformly by CSS (`w-full h-auto`), matching quay's own renderer. Unlike `TimelineBar`
// the SVG is NOT stretched with `preserveAspectRatio="none"`: this card carries axis labels and
// an overflow badge as real text, and non-uniform scaling would distort them.

/**
 * The windows the dashboard offers, in hours. The default mirrors quay's own
 * `DEFAULT_TIMELINE_HOURS`; a switch is a *data* window change (the interval set is
 * re-filtered upstream), not a visual zoom of the same intervals.
 */
export const GANTT_WINDOW_HOURS = [1, 3, 6, 12] as const;

const HOUR_MS = 3_600_000;

/**
 * Colour per state, on the same palette `TimelineBar` and the panel's status dots use.
 *
 * Every state carries its own class: quay publishes *which* states exist but never what
 * colour they are, so the mapping is ours — and two states sharing a colour would make
 * the gantt silently unreadable (a `failed` run indistinguishable from a `timed-out` one).
 */
const STATE_TEXT_CLASSES: Record<string, string> = {
  implementing: 'text-blue-500',
  'fan-in': 'text-violet-500',
  'awaiting-land': 'text-amber-500',
  landed: 'text-green-500',
  completed: 'text-emerald-600',
  failed: 'text-red-600',
  killed: 'text-rose-400',
  'timed-out': 'text-orange-600',
  'exited-not-landed': 'text-yellow-600',
};
const DEFAULT_STATE_CLASS = 'text-gray-400';
const UNKNOWN_STATE = 'unknown';

/** The state key an interval is coloured by: the in-flight phase, else the terminal state. */
function intervalState(interval: QuayGanttInterval): string {
  return interval.phase ?? interval.finalState ?? UNKNOWN_STATE;
}

function stateClass(state: string): string {
  return STATE_TEXT_CLASSES[state] ?? DEFAULT_STATE_CLASS;
}

/** Human-readable elapsed time for one interval's tooltip. */
function formatDuration(startMs: number, endMs: number): string {
  const seconds = Math.max(0, Math.round((endMs - startMs) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** `HH:MM` for an axis label, in the reader's own locale. */
function formatClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

type LoopPulseGanttProps = {
  /**
   * quay's packed lane set, or `null` when there is no reading (the installed plugin predates
   * the `lanes` verb, or the verb failed). A `null` reading still renders the card — including
   * its window selector, disabled, and a stated reason — because an unavailable chart must not
   * take the control that owns its window down with it.
   */
  gantt: QuayGanttLanes | null;
  /**
   * The window the host requested, in hours. Only consulted when `gantt` is null: a lane set
   * carries its own reading window, but an unavailable one carries nothing to mark the active
   * button with, so the requested window is shown instead.
   */
  windowHours?: number;
  /**
   * Reports a requested window change. Omitted when the host cannot honour one yet — in
   * that case the selector is not rendered at all, rather than rendered inert: a control
   * that visibly does nothing is worse than no control.
   */
  onWindowChange?: (hours: number) => void;
  /** True while the host is re-reading the lanes for a newly requested window. */
  refreshing?: boolean;
  /**
   * Why there is no lane reading, when there is none. Two distinct reasons are rendered
   * differently: an un-upgraded plugin (no `lanes` verb) is a normal state, while a failed
   * read is a fault — the reader acts differently on each. Absent/unknown renders a neutral
   * fallback rather than claiming a specific cause.
   */
  unavailableReason?: QuayGanttUnavailableReason | null;
};

/**
 * The windows the card offers, in hours, with quay's own default. A window is a *data* filter
 * (the interval set is re-selected upstream), never a visual zoom of the same intervals.
 */
const DEFAULT_GANTT_WINDOW_HOURS = 3;

/**
 * The reason shown when the card has no lane reading to plot, keyed by WHY the reading is
 * missing. The two sentences must differ: "the plugin is old" and "the read failed" are
 * different facts, and collapsing them into one generic line would tell the reader nothing
 * about whether to upgrade or to retry. Each is about the *reading*, not the window: the
 * window is still selectable, so blaming it would be false.
 */
const GANTT_UNAVAILABLE_REASONS: Record<QuayGanttUnavailableReason, string> = {
  'plugin-lacks-lanes-verb': 'the installed quay plugin has no `lanes` verb (it predates the Loop pulse reading).',
  'lanes-read-failed': 'the `lanes` read failed — quay did not return a usable lane document.',
};
/** Used when the host reported a missing reading without a classified reason. */
const GANTT_UNAVAILABLE_FALLBACK = 'quay did not report a packed lane set.';

/**
 * The Loop pulse card: quay's own packed gantt lanes over one time window.
 *
 * This component only *renders* — the interval merge, the time-window filter and the
 * five-lane bin-packing all happen upstream inside quay's `lanes` verb (over quay's own
 * `dashboard-kernel`), and arrive here already packed. Re-deriving lanes here would be a
 * second implementation of the same algorithm, which is exactly what relaying that verb
 * exists to avoid.
 *
 * The window selector is owned by this card but lives OUTSIDE the availability branch: a
 * window change only re-reads these lanes, so the selector must survive the readings it
 * triggers — including the reading that fails.
 */
export default function LoopPulseGantt({
  gantt,
  windowHours,
  onWindowChange,
  refreshing = false,
  unavailableReason = null,
}: LoopPulseGanttProps) {
  const activeWindow = windowHours ?? gantt?.windowHours ?? DEFAULT_GANTT_WINDOW_HOURS;
  const unavailable = gantt === null;
  const reasonText = unavailableReason
    ? GANTT_UNAVAILABLE_REASONS[unavailableReason]
    : GANTT_UNAVAILABLE_FALLBACK;

  return (
    <div data-testid="quay-gantt">
      {onWindowChange && (
        <div className="mb-1 flex flex-wrap items-center gap-1" data-testid="quay-gantt-windows">
          {GANTT_WINDOW_HOURS.map((hours) => (
            <button
              key={hours}
              type="button"
              onClick={() => onWindowChange(hours)}
              // An unreadable lane set leaves the selector visible but inert: the reader still
              // sees which windows exist and which one is selected, and the disabled state
              // points at the reason below rather than hiding the whole control.
              disabled={unavailable}
              aria-pressed={hours === activeWindow}
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px] font-medium disabled:cursor-not-allowed disabled:opacity-50',
                hours === activeWindow
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-accent',
              )}
              data-testid={`quay-gantt-window-${hours}`}
            >
              {hours}h
            </button>
          ))}
          {refreshing && (
            <span className="text-[10px] text-muted-foreground" data-testid="quay-gantt-refreshing">
              refreshing…
            </span>
          )}
        </div>
      )}

      {unavailable ? (
        <p className="text-xs text-muted-foreground" data-testid="quay-gantt-unavailable-reason">
          Loop pulse unavailable — {reasonText}
        </p>
      ) : (
        <GanttPlot gantt={gantt} />
      )}
    </div>
  );
}

/**
 * The plotted chart for a present lane set: five fixed lanes, one bar per interval, the
 * overflow count and the axis labels. Split out so `LoopPulseGantt`'s selector can render
 * without a lane set (and without the geometry work that assumes one).
 *
 * `overflow` is rendered, never ignored: `packLanes` drops the intervals that had no
 * free lane, so `lanes` alone does not account for the whole window whenever it is
 * non-zero. A renderer that showed only the lanes would lose those runs silently.
 */
function GanttPlot({ gantt }: { gantt: QuayGanttLanes }) {
  const { lanes, overflow, windowHours, nowMs } = gantt;
  const windowStartMs = nowMs - windowHours * HOUR_MS;
  const spanMs = windowHours * HOUR_MS;
  const toX = (timeMs: number): number => PLOT_LEFT + ((timeMs - windowStartMs) / spanMs) * PLOT_WIDTH_INNER;

  const bars = lanes.flatMap((lane, laneIndex) =>
    lane.map((interval, index) => {
      // Clamp to the window: an in-flight run that started before it still begins at the
      // left edge, and nothing is drawn past `now`.
      const left = toX(Math.max(interval.startMs, windowStartMs));
      const right = toX(Math.min(interval.endMs, nowMs));
      const state = intervalState(interval);
      const top = LOOP_PULSE_TOP + laneIndex * LOOP_PULSE_LANE_HEIGHT;
      return (
        <rect
          key={`${interval.taskId}-${interval.startMs}-${index}`}
          x={left}
          y={top}
          width={Math.max(MIN_BAR_WIDTH, right - left)}
          height={LOOP_PULSE_BAR_HEIGHT}
          rx={2}
          fill="currentColor"
          className={stateClass(state)}
          data-testid="quay-gantt-bar"
          data-state={state}
          data-lane={laneIndex}
        >
          <title>
            {`${interval.taskId} · ${state} · ${formatDuration(interval.startMs, interval.endMs)} · `
              + `${new Date(interval.startMs).toISOString()} → ${new Date(interval.endMs).toISOString()}`}
          </title>
        </rect>
      );
    }),
  );

  // "Nothing ran" and "every run was crowded out of the lanes" are different readings, and
  // only the first may render the empty line. `packLanes` reports the intervals it could not
  // place in `overflow`, so a gate on `bars` alone would drop that count on the floor whenever
  // no interval found a free lane — the reader would be told nothing ran while `overflow` said
  // otherwise. The badge lives inside the SVG, so the chart must still render for it to show.
  const isEmpty = bars.length === 0 && overflow === 0;

  return isEmpty ? (
    <p className="text-xs text-muted-foreground" data-testid="quay-gantt-empty">
      No runs in the last {windowHours}h.
    </p>
  ) : (
    <svg
      viewBox={`0 0 ${PLOT_WIDTH} ${LOOP_PULSE_PLOT_HEIGHT}`}
      role="img"
      aria-label={`Loop pulse gantt chart (${GANTT_LANES} fixed lanes)`}
      className="h-auto w-full"
      data-testid="quay-gantt-svg"
      // The reading's window, exposed as machine-readable endpoints so the alignment criterion
      // (and the cockpit) can compare the gantt with the two `TimelineBar`s without parsing
      // clock text. `TimelineBar` publishes the same two attributes.
      data-window-start={windowStartMs}
      data-window-end={nowMs}
    >
      {Array.from({ length: GANTT_LANES }, (_unused, index) => (
        <line
          key={index}
          x1={PLOT_LEFT}
          y1={LOOP_PULSE_TOP + index * LOOP_PULSE_LANE_HEIGHT + LOOP_PULSE_LANE_HEIGHT - 4}
          x2={PLOT_WIDTH - PAD}
          y2={LOOP_PULSE_TOP + index * LOOP_PULSE_LANE_HEIGHT + LOOP_PULSE_LANE_HEIGHT - 4}
          stroke="currentColor"
          className="text-border"
          strokeDasharray="2 2"
          data-testid="quay-gantt-lane"
        />
      ))}

      {bars}

      {overflow > 0 && (
        <text
          x={PLOT_WIDTH - PAD}
          y={LOOP_PULSE_TOP}
          fontSize={9}
          fontWeight={700}
          textAnchor="end"
          fill="currentColor"
          className="text-amber-600"
          data-testid="quay-gantt-overflow"
        >
          {`+${overflow} more`}
        </text>
      )}

      <line x1={PLOT_LEFT} y1={LOOP_PULSE_AXIS_Y} x2={PLOT_WIDTH - PAD} y2={LOOP_PULSE_AXIS_Y} stroke="currentColor" className="text-border" />
      <text x={PLOT_LEFT} y={LOOP_PULSE_PLOT_HEIGHT - 1} fontSize={9} fill="currentColor" className="text-muted-foreground">
        {formatClock(windowStartMs)}
      </text>
      <text
        x={PLOT_WIDTH - PAD}
        y={LOOP_PULSE_PLOT_HEIGHT - 1}
        fontSize={9}
        textAnchor="end"
        fill="currentColor"
        className="text-muted-foreground"
      >
        {formatClock(nowMs)}
      </text>
    </svg>
  );
}
