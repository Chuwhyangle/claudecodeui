import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import type { QuayGanttInterval, QuayGanttLanes } from '@/shared/types';
import {
  QUAY_DEFAULT_STATE_TEXT_CLASS,
  QUAY_STATE_TEXT_CLASSES,
  QUAY_UNKNOWN_STATE,
} from '@/shared/constants';
import { cn } from '@/shared/utils';
import {
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
import SessionPulsePopover from '@/modules/quay/SessionPulsePopover';
import { useSessionPulse, useSessionPulseWindow } from '@/modules/quay/hooks/useSessionPulse';

/**
 * The title bar's Loop pulse entry: a mini gantt (desktop) or pulse strip (narrow) that opens
 * the session's task/goal popover.
 *
 * Used by `WorkspaceHeader` only, and only for a project whose listing carries `hasQuayConfig`.
 * The trigger's reading comes from the lanes-only endpoint, polled here inside the memoized
 * component: a 30 s refresh re-renders this subtree, never `WorkspaceHeader`'s ancestors.
 */

/** Header width at which the trigger becomes the 110 px mini gantt rather than the pulse strip. */
export const PULSE_TRIGGER_WIDE_MIN_HEADER_WIDTH_PX = 960;
/** Width of the desktop mini gantt, in CSS pixels. */
export const PULSE_TRIGGER_WIDE_WIDTH_PX = 110;
/** Width of the narrow pulse strip, in CSS pixels. */
export const PULSE_TRIGGER_NARROW_WIDTH_PX = 43;
/** The trigger's height at every width, matching the header's other controls. */
export const PULSE_TRIGGER_HEIGHT_PX = 32;

const HOUR_MS = 3_600_000;

/** The state key a bar is coloured by: the in-flight phase, else the terminal state. */
function intervalState(interval: QuayGanttInterval): string {
  return interval.phase ?? interval.finalState ?? QUAY_UNKNOWN_STATE;
}

/**
 * The trigger's drawing, in the SAME coordinate space as `LoopPulseGantt` (`chartGeometry`):
 * five lane guides and one bar per interval, both stretched non-uniformly to the trigger's
 * fixed box. Unlike the card it carries no axis labels or overflow badge — at 43 px wide those
 * would be illegible — but every mark the card draws from the lane set is drawn here too.
 *
 * `degraded` is "there is no lane reading", and it draws only the guides plus the amber dot: a
 * blank bar area would read as "nothing ran", which is a different, false, statement.
 */
function PulseMiniGantt({ gantt, degraded }: { gantt: QuayGanttLanes | null; degraded: boolean }) {
  const bars = gantt === null
    ? []
    : gantt.lanes.flatMap((lane, laneIndex) =>
        lane.map((interval, index) => {
          const windowStartMs = gantt.nowMs - gantt.windowHours * HOUR_MS;
          const spanMs = gantt.windowHours * HOUR_MS;
          const toX = (timeMs: number) => PLOT_LEFT + ((timeMs - windowStartMs) / spanMs) * PLOT_WIDTH_INNER;
          const left = toX(Math.max(interval.startMs, windowStartMs));
          const right = toX(Math.min(interval.endMs, gantt.nowMs));
          const state = intervalState(interval);
          return (
            <rect
              key={`${interval.taskId}-${interval.startMs}-${index}`}
              x={left}
              y={LOOP_PULSE_TOP + laneIndex * LOOP_PULSE_LANE_HEIGHT}
              width={Math.max(MIN_BAR_WIDTH, right - left)}
              height={LOOP_PULSE_BAR_HEIGHT}
              rx={2}
              fill="currentColor"
              className={QUAY_STATE_TEXT_CLASSES[state] ?? QUAY_DEFAULT_STATE_TEXT_CLASS}
              data-testid="quay-pulse-bar"
              data-state={state}
            />
          );
        }),
      );

  return (
    <>
      <svg
        viewBox={`0 0 ${PLOT_WIDTH} ${LOOP_PULSE_PLOT_HEIGHT}`}
        // The trigger is a fixed-size box, not a text-bearing card, so the plot is stretched to
        // fill it; the card keeps its own uniform scaling because its axis labels are real text.
        preserveAspectRatio="none"
        aria-hidden="true"
        className="h-full w-full"
        data-testid="quay-pulse-mini-gantt"
      >
        {Array.from({ length: LOOP_PULSE_LANES }, (_unused, index) => (
          <line
            key={index}
            x1={PLOT_LEFT}
            y1={LOOP_PULSE_TOP + index * LOOP_PULSE_LANE_HEIGHT + LOOP_PULSE_LANE_HEIGHT - 4}
            x2={PLOT_WIDTH - PAD}
            y2={LOOP_PULSE_TOP + index * LOOP_PULSE_LANE_HEIGHT + LOOP_PULSE_LANE_HEIGHT - 4}
            stroke="currentColor"
            className="text-border"
            strokeDasharray="2 2"
            data-testid="quay-pulse-lane"
          />
        ))}
        {bars}
      </svg>
      {degraded && (
        <span
          className="pointer-events-none absolute right-0.5 top-0.5 text-[8px] leading-none text-amber-500"
          data-testid="quay-pulse-degraded"
          aria-hidden="true"
        >
          ●
        </span>
      )}
    </>
  );
}

type SessionPulseProps = {
  /** The selected project's id; its lanes are polled while the project offers quay. */
  projectId: string;
  /** The selected conversation, whose mentioned tasks and goals the popover lists. */
  sessionId: string | null;
  /** True below 768 px: the trigger is always the pulse strip and the popover is full width. */
  isMobile: boolean;
  /** Switches the workspace to the Quay tab. Passed in because quay must not import project-workspace. */
  onOpenQuayPanel: () => void;
};

type PulseTriggerVariant = 'wide' | 'narrow';

/**
 * Reads the width of the header this trigger lives in and resolves the trigger's shape.
 *
 * The breakpoint is the HEADER's own width, not the viewport's: with the sidebar open the header
 * is narrower than the window, and the mini gantt must yield to the pulse strip exactly when the
 * header itself gets tight.
 */
function usePulseTriggerVariant(isMobile: boolean): {
  rootRef: RefObject<HTMLButtonElement>;
  variant: PulseTriggerVariant;
} {
  const rootRef = useRef<HTMLButtonElement>(null);
  // The measured header width; 0 until the first ResizeObserver callback, which resolves to the
  // narrow shape — the safe default, since the wide chart is what needs the room.
  const [headerWidth, setHeaderWidth] = useState(0);

  useEffect(() => {
    const header = rootRef.current?.closest('header[data-app-header]') ?? null;
    if (header === null) {
      return;
    }

    setHeaderWidth(header.getBoundingClientRect().width);
    if (typeof ResizeObserver !== 'function') {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      setHeaderWidth(entry?.contentRect.width ?? header.getBoundingClientRect().width);
    });
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  const variant: PulseTriggerVariant = !isMobile && headerWidth >= PULSE_TRIGGER_WIDE_MIN_HEADER_WIDTH_PX
    ? 'wide'
    : 'narrow';
  return { rootRef, variant };
}

/**
 * The title bar's quay entry point. Rendered by `WorkspaceHeader` for a `hasQuayConfig` project;
 * the trigger polls the lanes reading and opens `SessionPulsePopover`.
 */
function SessionPulse({ projectId, sessionId, isMobile, onOpenQuayPanel }: SessionPulseProps) {
  const { t } = useTranslation();
  const { rootRef, variant } = usePulseTriggerVariant(isMobile);
  const { windowHours, setWindowHours } = useSessionPulseWindow(projectId);
  const reading = useSessionPulse(projectId, true, windowHours);
  // Whether the popover is open. Essential state: the trigger owns `aria-expanded`, the popover's
  // position is computed from the live header rect on open, and focus has to return on close.
  const [isOpen, setIsOpen] = useState(false);

  const close = useCallback(() => {
    setIsOpen(false);
    // Focus returns to the control that opened the layer, so a keyboard reader is not dropped at
    // the top of the document when the popover closes.
    rootRef.current?.focus();
  }, [rootRef]);

  const openQuayPanel = useCallback(() => {
    setIsOpen(false);
    onOpenQuayPanel();
  }, [onOpenQuayPanel]);

  const lanesUnavailable = reading.gantt === null && !reading.loading;

  return (
    <>
      <button
        ref={rootRef}
        type="button"
        data-testid="quay-pulse-trigger"
        data-variant={variant}
        // The window the trigger's poll and the popover's chart share, exposed as a reading so
        // a test can see the trigger follow a selection made in the popover.
        data-window-hours={windowHours}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-label={t('quayPulse.triggerLabel')}
        onClick={() => setIsOpen((open) => !open)}
        style={{
          width: variant === 'wide' ? PULSE_TRIGGER_WIDE_WIDTH_PX : PULSE_TRIGGER_NARROW_WIDTH_PX,
          height: PULSE_TRIGGER_HEIGHT_PX,
        }}
        className={cn(
          'relative flex shrink-0 items-center justify-center overflow-hidden rounded-md outline-none transition-colors',
          // No border and no resting fill: the control sits inside the title bar rather than on
          // top of it. The open state is the same accent the header's other toggles use.
          isOpen
            ? 'bg-accent text-foreground'
            : 'bg-transparent text-foreground hover:bg-accent hover:text-foreground',
          'focus-visible:ring-2 focus-visible:ring-primary/60',
        )}
      >
        <PulseMiniGantt gantt={reading.gantt} degraded={lanesUnavailable} />
      </button>

      {isOpen && (
        <SessionPulsePopover
          projectId={projectId}
          sessionId={sessionId}
          gantt={reading.gantt}
          ganttUnavailable={reading.unavailable}
          lanesUnavailable={lanesUnavailable}
          windowHours={windowHours}
          onWindowChange={setWindowHours}
          refreshing={reading.loading}
          isMobile={isMobile}
          anchorRef={rootRef}
          onClose={close}
          onOpenQuayPanel={openQuayPanel}
        />
      )}
    </>
  );
}

// Memoized deliberately: the lanes poll updates state inside this component, and wrapping it
// means those updates can never reach `WorkspaceHeader` — let alone `WorkspaceMain` or the chat.
export default memo(SessionPulse);
