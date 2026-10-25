/**
 * The one geometry the Quay module's three time charts are drawn in.
 *
 * `LoopPulseGantt` (Loop pulse), `TimelineBar` (Tests and Fan-in) and `PulseStrip` (the cockpit's
 * stacked composition of all three) all read these constants. The plots are drawn in a fixed
 * `PLOT_WIDTH`-wide viewBox and scaled uniformly to the host width (`w-full h-auto`), so a given
 * instant maps to the same fraction of the track in every chart; sharing `PLOT_LEFT` and
 * `PLOT_WIDTH_INNER` is what makes their visible plot edges line up instead of merely happening
 * to be equal by coincidence. A chart that wants another width must change this declaration, and
 * the alignment criterion in `tests/PulseStrip.test.tsx` then fails for the other two.
 *
 * This is module-private: it is consumed only inside `src/modules/quay/` and is deliberately not
 * re-exported from the module barrel.
 */

/** The fixed chart width every time chart's viewBox is declared with. */
export const PLOT_WIDTH = 600;
/** The inset between the viewBox edge and the plot's first/last pixel column. */
export const PAD = 4;
/** The x coordinate where the plotted time span begins (and where the axis origin sits). */
export const PLOT_LEFT = PAD;
/** The width of the time span itself; a moment's x is `PLOT_LEFT + fraction * PLOT_WIDTH_INNER`. */
export const PLOT_WIDTH_INNER = PLOT_WIDTH - 2 * PAD;
/** A zero-length interval would be invisible, so every rect keeps at least this width. */
export const MIN_BAR_WIDTH = 1.5;

// --------------------------- LOOP PULSE GANTT ---------------------------

/** How many lane rows the Loop pulse gantt always draws, occupied or not. */
export const LOOP_PULSE_LANES = 5;
/** Vertical pitch of one lane in the gantt's viewBox. */
export const LOOP_PULSE_LANE_HEIGHT = 16;
/** Height of one interval bar in the gantt's viewBox. */
export const LOOP_PULSE_BAR_HEIGHT = 10;
/** Top inset before the first lane. */
export const LOOP_PULSE_TOP = 8;
/** The y coordinate of the gantt's axis rule. */
export const LOOP_PULSE_AXIS_Y = LOOP_PULSE_TOP + LOOP_PULSE_LANES * LOOP_PULSE_LANE_HEIGHT + 6;
/** The gantt's full viewBox height (plot + axis labels). */
export const LOOP_PULSE_PLOT_HEIGHT = LOOP_PULSE_AXIS_Y + 12;

// --------------------------- TIMELINE BAR ---------------------------

/** Top inset before a TimelineBar's single row of marks. */
export const TIMELINE_BAR_TOP = 4;
/** Height of one range rect in a TimelineBar's viewBox. */
export const TIMELINE_BAR_HEIGHT = 12;
/** The y coordinate of a TimelineBar's axis rule. */
export const TIMELINE_AXIS_Y = TIMELINE_BAR_TOP + TIMELINE_BAR_HEIGHT + 4;
/** A TimelineBar's full viewBox height (plot + axis labels). */
export const TIMELINE_PLOT_HEIGHT = TIMELINE_AXIS_Y + 14;
