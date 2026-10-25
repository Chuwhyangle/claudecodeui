import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import type {
  QuayGanttLanes,
  QuayGanttUnavailableReason,
  QuayInFlightPhase,
  QuaySessionMentionTask,
  QuaySessionMentionsReading,
} from '@/shared/types';
import {
  QUAY_DEFAULT_TASK_STATUS_BADGE_CLASS,
  QUAY_GOAL_STATUS_PERCENT,
  QUAY_IN_FLIGHT_PHASE_META,
  QUAY_TASK_BADGE_BASE_CLASS,
  QUAY_TASK_STATUS_BADGE_CLASSES,
} from '@/shared/constants';
import { cn } from '@/shared/utils';
import LoopPulseGantt from '@/modules/quay/LoopPulseGantt';
import { useSessionMentions } from '@/modules/quay/hooks/useSessionPulse';

/**
 * The title bar's Loop pulse popover: the big gantt plus the tasks and goals this session's own
 * prose names.
 *
 * Rendered by `SessionPulse` only while the trigger's popover is open. It owns two things:
 * fetching the session's mentions ONCE for that opening (never polling), and the list's local
 * presentation state (the folded Done group, the bottom fade). Everything about quay itself is
 * handed in — the window value and the lanes are the trigger's own reading, so the mini chart
 * and this chart can never disagree.
 */

/** 54.25rem — the transcript column's max width, which the popover aligns with on desktop. */
const DESKTOP_MAX_WIDTH_PX = 868;
/** Gap between the popover and the viewport edge / the header's bottom. */
const VIEWPORT_MARGIN_PX = 8;
const HEADER_GAP_PX = 4;
const DESKTOP_MAX_HEIGHT_PX = 760;

type PopoverGeometry = {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
};

/**
 * Computes the dialog's fixed position from the header's live rect.
 *
 * Desktop: as wide as the transcript column (or the header minus its 8 px side margins), centred
 * under the header. Mobile: the viewport minus the same margins, so the panel never touches an
 * edge. Height is capped below the header and the bottom of the viewport.
 */
function computeGeometry(anchor: HTMLElement | null, isMobile: boolean): PopoverGeometry {
  const viewportWidth = typeof window === 'undefined' ? 0 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight;
  const header = anchor?.closest('header[data-app-header]') as HTMLElement | null;
  const headerRect = header?.getBoundingClientRect() ?? null;
  const headerWidth = headerRect?.width ?? viewportWidth;

  const width = isMobile
    ? Math.max(0, viewportWidth - 2 * VIEWPORT_MARGIN_PX)
    : Math.max(0, Math.min(DESKTOP_MAX_WIDTH_PX, headerWidth - 2 * VIEWPORT_MARGIN_PX));
  const left = isMobile
    ? VIEWPORT_MARGIN_PX
    : (headerRect?.left ?? 0) + (headerWidth - width) / 2;
  const top = (headerRect?.bottom ?? 0) + HEADER_GAP_PX;
  const maxHeight = isMobile
    ? Math.max(0, viewportHeight - top - VIEWPORT_MARGIN_PX)
    : Math.min(viewportHeight * 0.85, DESKTOP_MAX_HEIGHT_PX);

  return { left, top, width, maxHeight };
}

/** The task row's sort bucket: in-flight first, then work that needs a person, then the rest. */
function taskRank(task: QuaySessionMentionTask, lanesUnavailable: boolean): number {
  if (!lanesUnavailable && task.phase !== null) {
    return 0;
  }
  if (task.status === 'needs-human') {
    return 1;
  }
  if (task.status === 'ready') {
    return 2;
  }
  return 3;
}

/** Whether a stored status is folded into the Done group. */
function isFoldedStatus(status: string): boolean {
  return status === 'done' || status === 'superseded';
}

/** "Mentioned N min ago", or `null` when the reading carries no mention instant. */
function mentionedMinutesAgo(iso: string | null): number | null {
  if (iso === null) {
    return null;
  }
  const at = Date.parse(iso);
  if (Number.isNaN(at)) {
    return null;
  }
  return Math.max(1, Math.floor((Date.now() - at) / 60_000));
}

type SessionPulsePopoverProps = {
  projectId: string;
  sessionId: string | null;
  gantt: QuayGanttLanes | null;
  ganttUnavailable: QuayGanttUnavailableReason | null;
  /**
   * True when the lanes read has settled without a lane set. The list still renders — the
   * mention reading is independent — but its rows claim no phase, and the amber note states why.
   */
  lanesUnavailable: boolean;
  windowHours: number;
  onWindowChange: (hours: number) => void;
  refreshing: boolean;
  isMobile: boolean;
  /** The trigger, used for geometry, outside-click exclusion and focus return. */
  anchorRef: RefObject<HTMLElement>;
  onClose: () => void;
  onOpenQuayPanel: () => void;
};

/**
 * One task row. Kept separate so the active and folded groups draw the same row — the only
 * difference between them is which list they sit in.
 */
function TaskRow({
  task,
  lanesUnavailable,
  onOpen,
}: {
  task: QuaySessionMentionTask;
  lanesUnavailable: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  // The lane reading is authoritative for "in flight"; when it is unreadable the row falls back
  // to the task store's own status and claims no phase (a stale phase would be a guess).
  const phaseMeta = !lanesUnavailable && task.phase !== null
    && Object.prototype.hasOwnProperty.call(QUAY_IN_FLIGHT_PHASE_META, task.phase)
    ? QUAY_IN_FLIGHT_PHASE_META[task.phase as QuayInFlightPhase]
    : null;
  // Same base + colour composition as the Quay tab's in-flight card, so the two badges for one
  // phase are byte-identical.
  const badgeClass = cn(
    QUAY_TASK_BADGE_BASE_CLASS,
    phaseMeta?.className
      ?? QUAY_TASK_STATUS_BADGE_CLASSES[task.status]
      ?? QUAY_DEFAULT_TASK_STATUS_BADGE_CLASS,
  );
  const minutes = mentionedMinutesAgo(task.lastMentionAt);

  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="quay-pulse-task-row"
      data-task-id={task.taskId}
      className="flex w-full flex-col gap-0.5 rounded border border-border/40 px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
    >
      <span className="flex items-start justify-between gap-2">
        {/* Ids may be long and are the row's identity: wrap them rather than truncating. */}
        <span className="min-w-0 whitespace-normal break-words font-mono text-[11px] text-foreground">
          {task.taskId}
        </span>
        <span className={badgeClass} data-testid="quay-pulse-task-badge">
          {phaseMeta?.label ?? task.status}
        </span>
      </span>
      <span className="line-clamp-2 text-[11px] text-muted-foreground">{task.title}</span>
      {(task.goalId !== null || minutes !== null) && (
        <span className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
          {task.goalId !== null && <span className="font-mono">{task.goalId}</span>}
          {minutes !== null && (
            <span data-testid="quay-pulse-mentioned-ago">
              {t('quayPulse.mentionedAgo', { minutes })}
            </span>
          )}
        </span>
      )}
    </button>
  );
}

/** The title-bar popover. Used by `SessionPulse`; not exported from the module barrel. */
export default function SessionPulsePopover({
  projectId,
  sessionId,
  gantt,
  ganttUnavailable,
  lanesUnavailable,
  windowHours,
  onWindowChange,
  refreshing,
  isMobile,
  anchorRef,
  onClose,
  onOpenQuayPanel,
}: SessionPulsePopoverProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const upperRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  // The dialog's fixed rect; derived from the live header, so it is state rather than a render
  // computation (a resize must move the panel without a re-open).
  const [geometry, setGeometry] = useState<PopoverGeometry>(() => computeGeometry(anchorRef.current, isMobile));
  // Whether the list still has content below the fold, which is the only state in which the
  // bottom fade is shown (no top fade: nothing scrolls above the first heading).
  const [showBottomFade, setShowBottomFade] = useState(false);
  // Whether the folded Done group is expanded. Default collapsed, as the task asks.
  const [doneExpanded, setDoneExpanded] = useState(false);
  // The panel's rendered height: the content's natural height, capped at the geometry's max.
  // `max-height` alone cannot make the list scroll — a flex child with no definite container
  // height grows to its content and the panel clips it — so the height is measured and set.
  const [panelHeight, setPanelHeight] = useState<number | null>(null);
  const mentions = useSessionMentions(projectId, sessionId, true);

  useEffect(() => {
    const update = () => setGeometry(computeGeometry(anchorRef.current, isMobile));
    update();

    if (typeof window !== 'undefined') {
      window.addEventListener('resize', update);
    }
    const header = anchorRef.current?.closest('header[data-app-header]') ?? null;
    const observer = header !== null && typeof ResizeObserver === 'function'
      ? new ResizeObserver(update)
      : null;
    observer?.observe(header as Element);

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('resize', update);
      }
      observer?.disconnect();
    };
  }, [anchorRef, isMobile]);

  /*
   * Size the panel to its content, up to the geometry's cap. The natural height is the sum of
   * the fixed block, the list's OWN scrollHeight (its full content, whether or not it is
   * currently clipped) and the fixed footer; once the height is set, that sum is unchanged, so
   * this settles after one pass and re-runs only when the content changes.
   */
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null) {
      return;
    }
    const natural = (upperRef.current?.offsetHeight ?? 0)
      + list.scrollHeight
      + (footerRef.current?.offsetHeight ?? 0);
    const next = Math.min(geometry.maxHeight, Math.max(0, natural));
    setPanelHeight((previous) => (previous === next ? previous : next));
  }, [geometry.maxHeight, mentions, doneExpanded]);

  // Escape closes the popover. The chat's global abort guard runs on the document's capture
  // phase and declines the key while a `[role="dialog"]` is open, so this handler owns it.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        onClose();
      }
    };
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target === null) {
        return;
      }
      if (rootRef.current?.contains(target) || anchorRef.current?.contains(target)) {
        return;
      }
      onClose();
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [anchorRef, onClose]);

  const updateBottomFade = useCallback(() => {
    const element = listRef.current;
    if (element === null) {
      setShowBottomFade(false);
      return;
    }
    setShowBottomFade(element.scrollHeight - element.scrollTop - element.clientHeight > 1);
  }, []);

  // Re-measure whenever the list's content or the panel height changes (fetch settles, Done
  // group expands, the measured height is applied).
  useEffect(() => {
    updateBottomFade();
  }, [updateBottomFade, mentions, doneExpanded, panelHeight]);

  const hasSession = sessionId !== null;
  const goals = mentions.status === 'loaded' ? mentions.reading.goals : [];
  const tasks = mentions.status === 'loaded' ? mentions.reading.tasks : [];
  const activeTasks = tasks
    .filter((task) => !isFoldedStatus(task.status))
    .map((task) => task)
    .sort((left, right) => taskRank(left, lanesUnavailable) - taskRank(right, lanesUnavailable));
  const foldedTasks = tasks.filter((task) => isFoldedStatus(task.status));

  const renderGoalRow = (goal: QuaySessionMentionsReading['goals'][number]) => (
    <li key={goal.goalId}>
      <button
        type="button"
        onClick={onOpenQuayPanel}
        data-testid="quay-pulse-goal-row"
        data-goal-id={goal.goalId}
        className="flex w-full flex-col gap-0.5 rounded border border-border/40 px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
      >
        <span className="flex items-center justify-between gap-2 text-xs">
          <span className="shrink-0 font-mono text-[11px] text-foreground">{goal.goalId}</span>
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">{goal.status}</span>
        </span>
        <span className="line-clamp-2 text-[11px] text-muted-foreground md:line-clamp-1" title={goal.title}>
          {goal.title}
        </span>
        {/* An achieved goal has nothing left to complete, so its bar would be a full-width wall
            of colour saying the same thing in every row. The status text stays authoritative. */}
        {goal.status !== 'achieved' && (
          <span className="mt-1 block h-1.5 w-full overflow-hidden rounded bg-muted" data-testid="quay-pulse-goal-bar">
            <span
              className="block h-full rounded bg-primary"
              style={{ width: `${QUAY_GOAL_STATUS_PERCENT[goal.status] ?? 0}%` }}
            />
          </span>
        )}
        <span className="text-[10px] text-muted-foreground">
          {goal.viaTaskCount > 0
            ? t('quayPulse.viaTasks', { count: goal.viaTaskCount })
            : t('quayPulse.mentionedInMessage')}
        </span>
      </button>
    </li>
  );

  const renderListBody = () => {
    // A workspace without a conversation has nothing to mention; say so rather than rendering a
    // perpetual spinner for a request that will never be sent.
    if (!hasSession) {
      return (
        <p className="px-3 py-2 text-xs text-muted-foreground" data-testid="quay-pulse-empty">
          {t('quayPulse.empty')}
        </p>
      );
    }

    if (mentions.status === 'idle' || mentions.status === 'loading') {
      return (
        <p className="px-3 py-2 text-xs text-muted-foreground" data-testid="quay-pulse-loading">
          {t('quayPulse.loading')}
        </p>
      );
    }

    if (mentions.status === 'error') {
      // The gantt above is unaffected: the lanes reading and the mention list fail
      // independently, and one failed read must not blank the other.
      return (
        <p className="px-3 py-2 text-xs text-amber-700 dark:text-amber-300" data-testid="quay-pulse-list-error">
          {t('quayPulse.listError')}
        </p>
      );
    }

    if (tasks.length === 0 && goals.length === 0) {
      return (
        <p className="px-3 py-2 text-xs text-muted-foreground" data-testid="quay-pulse-empty">
          {t('quayPulse.empty')}
        </p>
      );
    }

    return (
      <>
        {goals.length > 0 && (
          <section className="px-3 pb-2" data-testid="quay-pulse-goals">
            <h3 className="sticky top-0 z-10 bg-popover py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t('quayPulse.goalsHeading', { count: goals.length })}
            </h3>
            <ul className="space-y-1.5">{goals.map(renderGoalRow)}</ul>
          </section>
        )}

        {tasks.length > 0 && (
          <section className="px-3 pb-2" data-testid="quay-pulse-tasks">
            <h3 className="sticky top-0 z-10 bg-popover py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t('quayPulse.tasksHeading', { count: tasks.length })}
            </h3>
            <ul className="space-y-1.5">
              {activeTasks.map((task) => (
                <li key={task.taskId}>
                  <TaskRow task={task} lanesUnavailable={lanesUnavailable} onOpen={onOpenQuayPanel} />
                </li>
              ))}
            </ul>

            {foldedTasks.length > 0 && (
              <div className="mt-1.5">
                <button
                  type="button"
                  onClick={() => setDoneExpanded((expanded) => !expanded)}
                  aria-expanded={doneExpanded}
                  data-testid="quay-pulse-done-toggle"
                  className="w-full rounded px-1 py-1 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
                >
                  {t('quayPulse.done', { count: foldedTasks.length })}
                </button>
                {doneExpanded && (
                  <ul className="space-y-1.5">
                    {foldedTasks.map((task) => (
                      <li key={task.taskId}>
                        <TaskRow task={task} lanesUnavailable={lanesUnavailable} onOpen={onOpenQuayPanel} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>
        )}
      </>
    );
  };

  /*
   * Rendered into `document.body`, not inside the header. The workspace's main region carries a
   * transform (its sidebar slide), and a `position: fixed` box inside a transformed ancestor is
   * positioned against THAT ancestor rather than the viewport — which shifted this dialog by the
   * sidebar's width. A portal puts it back in the viewport coordinate space the geometry above
   * computes in, and leaves the header's own flex layout untouched.
   */
  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-label={t('quayPulse.title')}
      data-testid="quay-pulse-popover"
      style={{
        left: geometry.left,
        top: geometry.top,
        width: geometry.width,
        maxHeight: geometry.maxHeight,
        height: panelHeight ?? undefined,
      }}
      className="fixed z-[70] flex flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl"
    >
      <div ref={upperRef} className="shrink-0 px-3 pb-1 pt-2">
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t('quayPulse.title')}
        </p>
        <LoopPulseGantt
          gantt={gantt}
          windowHours={windowHours}
          onWindowChange={onWindowChange}
          refreshing={refreshing}
          unavailableReason={ganttUnavailable}
        />
      </div>

      <div className="relative min-h-0 flex-1">
        {lanesUnavailable && (
          <p className="px-3 pb-1 text-[11px] text-amber-700 dark:text-amber-300" data-testid="quay-pulse-lanes-note">
            {t('quayPulse.lanesNote')}
          </p>
        )}
        {/*
          No padding on the scroller itself: padding here would show above the first sticky
          heading as a gap. Each section carries its own horizontal padding instead.
        */}
        <div
          ref={listRef}
          onScroll={updateBottomFade}
          className="h-full overflow-y-auto overscroll-contain"
          data-testid="quay-pulse-list"
        >
          {renderListBody()}
        </div>
        {showBottomFade && (
          <div
            aria-hidden="true"
            data-testid="quay-pulse-bottom-fade"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-[hsl(var(--popover))] to-transparent"
          />
        )}
      </div>

      <div ref={footerRef} className="shrink-0 border-t border-border/60 p-2">
        <button
          type="button"
          onClick={onOpenQuayPanel}
          data-testid="quay-pulse-open-panel"
          className="w-full rounded-lg bg-muted px-3 py-1.5 text-xs font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          {t('quayPulse.openQuayPanel')}
        </button>
      </div>
    </div>,
    document.body,
  );
}
