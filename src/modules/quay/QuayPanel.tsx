import { Activity, AlertTriangle, ExternalLink, Info, Loader2, RefreshCw } from 'lucide-react';
import { useEffect } from 'react';
import type { ReactNode } from 'react';

import type {
  QuayDriverState,
  QuayFleetCliState,
  QuayInFlightTask,
  QuayListItem,
  QuaySnapshot,
  QuayTimelineWindow,
  QuayViewContract,
} from '@/shared/types';
import { cn } from '@/shared/utils';
import type { QuayPanelView } from '@/modules/quay/hooks/useQuayStatus';
import LoopPulseGantt from '@/modules/quay/LoopPulseGantt';
import PulseStrip from '@/modules/quay/PulseStrip';
import { formatQuayUri } from '@/modules/quay/quayUri';
import TimelineBar from '@/modules/quay/TimelineBar';

type QuayPanelProps = {
  projectId: string;
  view: QuayPanelView;
  /** Re-reads the snapshot, bypassing the backend's TTL cache. */
  onRefresh: () => void;
  /**
   * Link to quay's own `quay serve` dashboard for this project, when the host
   * knows one. The panel is a read-only mirror; the dashboard is where the full
   * task board lives, so the panel links out rather than reimplementing it.
   */
  dashboardUrl?: string | null;
  /**
   * The Loop pulse time window currently selected, and the handler that requests a different
   * one. The window only reaches the card when the host can actually re-read the snapshot —
   * `LoopPulseGantt` renders its selector on the presence of the handler, so a window that
   * could not be honoured is never offered. The card still renders (selector disabled, with a
   * stated reason) when there is no lane reading at all.
   */
  windowHours?: number;
  onWindowChange?: (hours: number) => void;
  /**
   * True while a window change is being re-read. The panel stays on its loaded branch for the
   * whole read — this only tells the Loop pulse card to show a local busy marker, so a window
   * switch never blanks the panel or takes the selector down with it.
   */
  ganttRefreshing?: boolean;
  /**
   * Focuses the task behind a pulse-strip mark, addressed as `quay://<fleetProjectId>/task/<id>`.
   * Omitted on a surface with no focus model (the session page's Quay tab), where the strip is
   * then display-only. The address is minted from the snapshot's fleet registry id, never from
   * the CloudCLI project id (the fleet could not dereference that).
   */
  onFocusTask?: (uri: string) => void;
};

const DRIVER_LABELS: Record<QuayDriverState, string> = {
  running: 'Driver running',
  idle: 'Driver idle',
  stale: 'Driver stale',
  'not-configured': 'Not configured',
  unavailable: 'Driver status unavailable',
};

const DRIVER_CLASSES: Record<QuayDriverState, string> = {
  running: 'bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300',
  idle: 'bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  stale: 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  'not-configured': 'bg-gray-100 text-gray-600 dark:bg-gray-900 dark:text-gray-400',
  // Grey, like `not-configured`: both are "no reading", as opposed to `stale`,
  // which is a reading that says something is wrong. The badge text tells them
  // apart, and the alarm for a failed read is the warnings banner below.
  unavailable: 'bg-gray-100 text-gray-600 dark:bg-gray-900 dark:text-gray-400',
};

/** Colour dot per suite/fan-in state, matching the timeline palette in `TimelineBar`. */
const STATE_DOT_CLASSES: Record<string, string> = {
  green: 'bg-green-500',
  landed: 'bg-green-500',
  red: 'bg-red-500',
  failed: 'bg-red-500',
  'exited-not-landed': 'bg-amber-500',
};
const DEFAULT_DOT_CLASS = 'bg-gray-400';

/**
 * Coarse goal completion percentage for the Stage goals progress bar. `quay goal
 * list --json` carries no completion ratio, so the bar is a status-derived
 * visual aid only — the status text next to it is authoritative.
 */
const GOAL_STATUS_PERCENT: Record<string, number> = {
  achieved: 100,
  superseded: 100,
  active: 50,
};

/**
 * Visible label, colour class and SPOKEN colour per in-flight `phase`, covering every phase
 * quay publishes (`QuayInFlightPhase`). The phases must render as *different* markers (text,
 * colour and `data-testid`), so a reader — and the test that guards it — can never mistake a
 * task parked in fan-in for one still being implemented. `color` is the same bucket the view
 * contract publishes as a display attribute, kept in this record so 「红的那个」 and the
 * drawn marker cannot drift apart.
 */
const IN_FLIGHT_PHASE_META: Record<
  QuayInFlightTask['phase'],
  { label: string; className: string; color: string }
> = {
  implementing: {
    label: 'implementing',
    className: 'bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
    color: 'blue',
  },
  'fan-in': {
    label: 'fan-in',
    className: 'bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
    color: 'violet',
  },
  'awaiting-land': {
    label: 'awaiting land',
    className: 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
    color: 'amber',
  },
  landed: {
    label: 'landed',
    className: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
    color: 'green',
  },
};

/**
 * How old an in-flight row's `lastHeartbeat` may read, relative to the snapshot's own
 * `generatedAt`, before the row is flagged stale — in milliseconds.
 *
 * This is the worker-driver's own round interval
 * (`DEFAULT_ROUND_INTERVAL_MS` = 300000, five minutes): a driver that has missed a whole
 * round without touching its carrier is not merely slow between rounds, it has stopped
 * heartbeating. It is a named constant, not an inline literal, so the test on both sides of
 * the boundary pins the same value the card reads.
 */
export const IN_FLIGHT_STALE_AFTER_MS = 300000;

/**
 * How old a CACHED snapshot may be before the panel calls it stale, in milliseconds.
 *
 * The backend caches a project's quay reading for a short TTL; a cached reading older than this
 * means the refresh path is not producing fresh data. Five minutes is the worker-driver's own
 * round interval — the same bound the in-flight rows use — so 「cached」 and 「stale」 mean the
 * same thing wherever the panel says them.
 */
export const CACHED_STALE_AFTER_MS = 300000;

/** A short, readable age for a cached reading ("just now", "3m ago", "2h ago", "4d ago"). */
function formatCachedAge(ageMs: number): string {
  const minutes = Math.floor(Math.max(0, ageMs) / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return 'never';
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/**
 * Formats a detail row's last-updated reading for display. `null` — the
 * projection's value when quay reported no usable timestamp for the row — renders
 * the same em-dash placeholder as `formatDuration`; it must not read as `never`
 * (a real "nothing recorded yet" reading) or as `Invalid Date`. The machine-
 * readable copy of the same value lives in the row's `data-updated-at` attribute.
 */
function formatUpdatedAt(value: string | null): string {
  if (!value) {
    return '—';
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** Formats a millisecond duration for the Tests card, tolerating a missing value. */
function formatDuration(durationMs: number | null): string {
  if (durationMs === null) {
    return '—';
  }
  if (durationMs < 1000) {
    return `${durationMs} ms`;
  }

  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }

  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Parses an ISO timestamp to epoch milliseconds, or `null` when absent/unparseable. */
function toEpochMs(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

const HOUR_MS = 3_600_000;

/** Mirrors `LoopPulseGantt`'s default (`DEFAULT_GANTT_WINDOW_HOURS`): used only when the snapshot carries no lane reading *and* the host has not selected a window. */
const DEFAULT_TIMELINE_WINDOW_HOURS = 3;

/**
 * The one window the Quay tab's three charts share (see `QuayTimelineWindow`).
 *
 * It always comes from the Loop pulse reading — `snapshot.gantt.windowHours` + `nowMs` — so the
 * Tests and Fan-in bars are cut to exactly the gantt's slice instead of adapting a window to
 * whatever records they happen to hold. When there is no lane reading (an un-upgraded plugin, or
 * a failed read) the window falls back to the host's selected `windowHours` and the snapshot's own
 * `generatedAt` as `now`, so the two bars still render over a stated window rather than guessing one.
 */
function resolveTimelineWindow(
  gantt: QuaySnapshot['gantt'],
  requestedWindowHours: number | undefined,
  generatedAt: string,
): QuayTimelineWindow {
  // `generatedAt` is always present on a loaded snapshot; `Date.now()` is only a last resort so a
  // bar is never handed a windowless boundary.
  const nowMs = gantt?.nowMs ?? toEpochMs(generatedAt) ?? Date.now();
  const windowHours = gantt?.windowHours ?? requestedWindowHours ?? DEFAULT_TIMELINE_WINDOW_HOURS;
  return { startMs: nowMs - windowHours * HOUR_MS, endMs: nowMs };
}

/**
 * Milliseconds from an ISO instant to the snapshot's own `generatedAt` instant,
 * or `null` when either is absent/unparseable. Measured against the snapshot's
 * timestamp rather than the wall clock so the reading is a property of the
 * snapshot: it does not creep forward while the panel sits open unrefreshed.
 */
function elapsedSince(startAt: string | null, nowIso: string): number | null {
  const start = toEpochMs(startAt);
  const now = toEpochMs(nowIso);
  if (start === null || now === null) {
    return null;
  }

  return Math.max(0, now - start);
}

/**
 * The reading for a section whose backing quay command did not answer. Such a
 * section is *unknown*, and an unknown count must never be rendered as `0`: the
 * panel used to show "0 tasks · 0 ready · 0 needs human · 0 done" for a failed
 * `task list --json` (the payload had outgrown the adapter's output cap), which
 * reads exactly like a genuinely empty board. Used by the Task ledger, Stage
 * goals and ADRs cards; the warning banner at the foot of the panel names the
 * command that failed.
 */
function UnavailableReading({ label, testId }: { label: string; testId: string }) {
  return (
    <p className="text-xs text-amber-700 dark:text-amber-300" data-testid={testId}>
      {label} unavailable — quay did not answer. See the warnings below.
    </p>
  );
}

/** One read-only detail list (tasks, goals or ADRs): a header, then either rows of
 * id/title/last-updated/status or an explicit empty-state line. Rows are
 * display-only — quay has no per-entity page to link to, so there is nothing to
 * click. Each row states the last-updated value the list is ranked by, both as
 * visible text and verbatim in `data-updated-at`.
 */
function DetailList({
  title,
  items,
  emptyText,
  testId,
}: {
  title: string;
  /** `null` when the command behind the list did not answer; `[]` when it answered with nothing. */
  items: QuayListItem[] | null;
  emptyText: string;
  testId: string;
}) {
  let body: ReactNode;
  if (items === null) {
    body = <UnavailableReading label={title} testId={`${testId}-unavailable`} />;
  } else if (items.length === 0) {
    body = (
      <p className="text-xs text-muted-foreground" data-testid={`${testId}-empty`}>
        {emptyText}
      </p>
    );
  } else {
    body = (
      <ul className="space-y-1" data-testid={testId}>
        {items.map((item) => (
          <li
            key={item.id}
            className="flex items-center gap-2 rounded border border-border/40 px-2 py-1 text-xs"
            data-testid={`${testId}-row`}
            // The row's own ISO reading, verbatim. Absent — not empty — when the
            // projection has no timestamp, so a reader can tell "no value" from a value.
            data-updated-at={item.updatedAt ?? undefined}
          >
            <span className="min-w-0 max-w-[45%] shrink truncate font-mono text-[11px] text-foreground" title={item.id}>
              {item.id}
            </span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground" title={item.title}>
              {item.title}
            </span>
            <span
              className="shrink-0 text-[10px] text-muted-foreground"
              data-testid={`${testId}-updated-at`}
            >
              {formatUpdatedAt(item.updatedAt)}
            </span>
            <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">{item.status}</span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {body}
    </section>
  );
}

// ── The wall view contract ───────────────────────────────────────────────────────────────────
// The panel's tiles are addressable objects, not just prose: each focusable child carries a
// quay:// reference, a short spoken label (①②③) and the display attributes a spoken referent
// resolves against. These helpers are the tile's declaration side; the voice input pack
// (`buildVoiceReferencePack`) carries the same triples as references.

/** Circled ordinals ①…⑳ — the short spoken label a focusable object carries. */
const CIRCLED_ORDINALS = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';

/**
 * Builds the In-flight tile's view contract: one focusable object per task the worker has in
 * flight, in the order the tile draws them.
 *
 * THE ORDINAL IS THE SPATIAL ORDER, not the task's rank in any store — the same number the
 * row's visible label shows (①, ②, …), so 「第二个」 and the second row are the same object
 * by construction. The list lays its rows out in one column, hence `pos.column` is always 1
 * and `pos` counts down from the top-left. `status` is the task's in-flight phase (the only
 * status this reading carries) and `color` is the same bucket the phase marker draws, so the
 * spoken attribute and the visible marker cannot drift.
 *
 * THE PROJECT SEGMENT IS THE FLEET REGISTRY ID. `null` means the project's root is not
 * registered with quay-fleet: no address can be minted for these tasks (the fleet would read a
 * CloudCLI id as `unknown-project`), so the tile declares NO focusable set at all rather than
 * declaring objects nobody can dereference. An unread tile (`inFlight === null`) likewise has
 * no focusable set: `null` is "no lane reading", not "nothing is running", and the renderer
 * publishes the contract attribute only for an actual, addressable reading.
 */
export function buildQuayInFlightContract(
  fleetProjectId: string | null,
  inFlight: QuaySnapshot['inFlight'],
): QuayViewContract | null {
  if (fleetProjectId === null || inFlight === null) {
    return null;
  }
  return {
    focusables: inFlight.map((task, index) => ({
      uri: formatQuayUri({ type: 'task', project: fleetProjectId, id: task.taskId, ac: null }),
      label: CIRCLED_ORDINALS[index] ?? `(${index + 1})`,
      display: {
        status: task.phase,
        color: IN_FLIGHT_PHASE_META[task.phase].color,
        ordinal: index + 1,
        pos: { row: index + 1, column: 1 },
      },
    })),
  };
}

/** Task ledger card: task counts, the status breakdown and the recent-tasks list in one card. */
function TaskLedger({ tasks }: { tasks: QuaySnapshot['tasks'] }) {
  const statuses = Object.entries(tasks?.byStatus ?? {}).sort((a, b) => b[1] - a[1]);
  const recent = tasks?.recent ?? [];

  return (
    <section data-testid="quay-panel-task-ledger">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Task ledger</h3>
      {tasks === null ? (
        // No counts at all: every one of them would be a fabricated zero.
        <UnavailableReading label="Task ledger" testId="quay-panel-task-ledger-unavailable" />
      ) : (
        <>
          <p className="mb-2 text-[11px] text-muted-foreground" data-testid="quay-panel-task-ledger-counts">
            {tasks.total} tasks · {tasks.ready} ready · {tasks.needsHuman} needs human · {tasks.done} done
          </p>
          {statuses.length === 0 ? (
            <p className="text-xs text-muted-foreground">No tasks reported.</p>
          ) : (
            <ul className="space-y-1" data-testid="quay-panel-tasks-by-status">
              {statuses.map(([status, count]) => (
                <li key={status} className="flex items-center justify-between rounded border border-border/40 px-2 py-1 text-xs">
                  <span className="text-foreground">{status}</span>
                  <span className="font-medium text-muted-foreground">{count}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3">
            <DetailList title="Recent tasks" items={recent} emptyText="No tasks reported." testId="quay-panel-recent-tasks" />
          </div>
        </>
      )}
    </section>
  );
}

/** Stage goals card: a status breakdown plus one row per recent goal, each with a flat progress bar. */
function StageGoals({ goals }: { goals: QuaySnapshot['goals'] }) {
  const statuses = Object.entries(goals?.breakdown.byStatus ?? {}).sort((a, b) => b[1] - a[1]);
  const recent = goals?.breakdown.recent ?? [];
  // DRAFTS BEFORE ACHIEVED. `recent` is ranked by `updatedAt`, so a store with hundreds of
  // achieved goals fills the card with full bars and buries the handful that still need work.
  // A stable sort keeps each group's own recency order.
  const ordered = [...recent].sort(
    (left, right) => Number(left.status === 'achieved') - Number(right.status === 'achieved'),
  );

  return (
    <section data-testid="quay-panel-stage-goals">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Stage goals</h3>
      {goals === null ? (
        <UnavailableReading label="Stage goals" testId="quay-panel-stage-goals-unavailable" />
      ) : (
        <>
          {statuses.length > 0 && (
            <p className="mb-2 text-[11px] text-muted-foreground" data-testid="quay-panel-stage-goals-counts">
              {statuses.map(([status, count]) => `${count} ${status}`).join(' · ')}
            </p>
          )}
          {recent.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="quay-panel-stage-goals-empty">
              No goals reported.
            </p>
          ) : (
            <ul className="space-y-2" data-testid="quay-panel-stage-goals-list">
              {ordered.map((goal) => (
                <li
                  key={goal.id}
                  className="rounded border border-border/40 px-2 py-1.5"
                  data-testid="quay-panel-stage-goals-row"
                  // Same machine-readable reading as the detail-list rows: this list
                  // is ranked by the goal's `updatedAt` too.
                  data-updated-at={goal.updatedAt ?? undefined}
                >
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="shrink-0 font-mono text-[11px] text-foreground">{goal.id}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="text-[10px] text-muted-foreground" data-testid="quay-panel-stage-goals-updated-at">
                        {formatUpdatedAt(goal.updatedAt)}
                      </span>
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{goal.status}</span>
                    </span>
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={goal.title}>
                    {goal.title}
                  </div>
                  {/*
                    An achieved goal has nothing left to complete: a full-width 100% bar is a
                    wall of colour that says the same thing in every row. Only unfinished
                    statuses draw a progress bar; the status text still says 「achieved」.
                  */}
                  {goal.status !== 'achieved' && (
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-muted" data-testid="quay-panel-stage-goals-bar">
                      <div className="h-full rounded bg-primary" style={{ width: `${GOAL_STATUS_PERCENT[goal.status] ?? 0}%` }} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/** Tests card: the current suite reading plus a timeline of the recent history rounds over the panel's shared window. */
function TestsCard({ tests, window }: { tests: QuaySnapshot['tests']; window: QuayTimelineWindow }) {
  const current = tests?.current ?? null;
  const rounds = tests?.recentRounds ?? [];
  // Chronological: the reader returns the most recent N in file order, so the
  // timeline's x-axis runs oldest → newest left to right.
  const ranges = rounds.flatMap((round) => {
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

  return (
    <section data-testid="quay-panel-tests">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Tests</h3>
      {current ? (
        <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="quay-panel-tests-current">
          <span className={cn('h-2 w-2 shrink-0 rounded-full', STATE_DOT_CLASSES[current.state] ?? DEFAULT_DOT_CLASS)} />
          <span className="font-medium text-foreground">{current.state}</span>
          {current.runner && <span className="text-muted-foreground">· {current.runner}</span>}
          {current.scope && <span className="text-muted-foreground">· {current.scope}</span>}
          {current.laneCount !== null && <span className="text-muted-foreground">· {current.laneCount} lanes</span>}
          {current.durationMs !== null && <span className="text-muted-foreground">· {formatDuration(current.durationMs)}</span>}
          {current.commit && (
            <span className="font-mono text-[11px] text-muted-foreground" data-testid="quay-panel-tests-current-commit">
              {current.commit.slice(0, 7)}
            </span>
          )}
          {current.taskId && (
            <span className="flex min-w-0 items-center gap-1 text-[11px]" data-testid="quay-panel-tests-current-task">
              {/* The suite reading is a *historical* record of the last run, not a live
                  task pointer — it can name a task that finished long ago. The label
                  says so, so the bare id cannot be read as "what is running now". */}
              <span
                className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground"
                data-testid="quay-panel-tests-current-task-label"
              >
                last suite
              </span>
              <span className="min-w-0 truncate font-mono text-muted-foreground" title={current.taskId}>
                {current.taskId}
              </span>
            </span>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="quay-panel-tests-current-empty">
          No suite running
        </p>
      )}
      <div className="mt-2">
        <TimelineBar
          ranges={ranges}
          window={window}
          emptyText="No suite rounds recorded."
          testId="quay-panel-tests-timeline"
        />
      </div>
    </section>
  );
}

/** Fan-in card: a timeline of recent lock windows over the panel's shared window, plus the last five task/outcome rows. */
function FanInCard({ fanIn, window }: { fanIn: QuaySnapshot['fanIn']; window: QuayTimelineWindow }) {
  const attempts = fanIn?.recent ?? [];
  // The carrier stores the lock epochs in Unix seconds; the timeline works in ms.
  const ranges = attempts.flatMap((attempt) => {
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
  // Newest first for the text list, even though the timeline reads left to right.
  const recentAttempts = attempts.slice(-5).reverse();

  return (
    <section data-testid="quay-panel-fanin">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Fan-in</h3>
      <TimelineBar
        ranges={ranges}
        window={window}
        emptyText="No fan-in attempts recorded."
        testId="quay-panel-fanin-timeline"
      />
      {recentAttempts.length > 0 && (
        <ul className="mt-2 space-y-1" data-testid="quay-panel-fanin-list">
          {recentAttempts.map((attempt, index) => (
            <li
              key={`${attempt.task}-${index}`}
              className="flex items-center gap-2 rounded border border-border/40 px-2 py-1 text-xs"
              data-testid="quay-panel-fanin-row"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground" title={attempt.task}>
                {attempt.task}
              </span>
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">{attempt.outcome}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * In-flight card: the tasks the worker has in flight *right now*, each with its phase, its
 * last heartbeat and its elapsed run time, from `snapshot.inFlight`.
 *
 * The task set is the same one the Loop pulse gantt is plotted from, so the card and the
 * gantt can never disagree about which tasks are running (and a landed task never appears
 * here). `null` means there was no lane reading at all, `[]` means the reading was taken and
 * nothing is running — the two render *different* messages, so an unread reading is never
 * shown as "nothing is running". A row whose heartbeat is older than
 * `IN_FLIGHT_STALE_AFTER_MS` gets an explicit stale marker, so a wedged worker reads as
 * stale rather than as a task that is simply still running.
 *
 * THIS TILE IS THE WALL'S FIRST VIEW CONTRACT. Each row is a focusable object addressed
 * `quay://<project>/task/<id>` and carries a VISIBLE circled ordinal (①②③) plus the
 * status/colour/ordinal/pos display attributes; the same declaration is published once as
 * JSON on the tile (`data-quay-focusables`) for the voice input pack to consume. The ordinal
 * is the row's spatial position, so saying 「第二个」 and clicking the second row name the
 * same object.
 */
function InFlightCard({
  fleetProjectId,
  fleetState,
  inFlight,
  generatedAt,
}: {
  /** The project's quay-fleet registry id, or `null` when it is not registered. */
  fleetProjectId: string | null;
  /**
   * The host's CLI reading. When the binary is missing (or speaks an incompatible contract)
   * the card does NOT blame this project: the one-line notice above the grid already named the
   * single cause, and repeating it here is the per-card noise this reading removes.
   */
  fleetState: QuayFleetCliState | null;
  inFlight: QuaySnapshot['inFlight'];
  generatedAt: string;
}) {
  const contract = buildQuayInFlightContract(fleetProjectId, inFlight);
  const focusables = contract?.focusables ?? [];
  const focusablesJson = JSON.stringify(focusables);

  // PUBLISH THE SAME DECLARATION THE TILE DRAWS. The dev-only scenario surface reads focusables
  // from a view-contract registry rather than from the DOM, so a scenario and the renderer resolve
  // 「②」 to one object — the tile is not re-declared for tests. `import.meta.env.DEV` is a
  // build-time constant: in a production bundle this branch is compiled out and the dynamic import
  // with it, so the surface's symbol never reaches `dist/`. The module itself no-ops unless the
  // operator opened the runtime lock (`?ui-scenario=1` / `localStorage['ui-scenario']='on'`).
  // An unregistered project publishes nothing: its view has no addressable URI.
  useEffect(() => {
    if (import.meta.env.DEV && fleetProjectId !== null && contract !== null) {
      const viewUri = formatQuayUri({ type: 'board', project: fleetProjectId });
      void import('@/modules/ui-scenario').then(({ publishScenarioViewContract }) => {
        publishScenarioViewContract(viewUri, contract);
      });
    }
    // `focusablesJson` is the contract's identity: `contract` is rebuilt every render, and
    // re-publishing on every render would make the registry's "most recent" clock meaningless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusablesJson, fleetProjectId]);

  return (
    <section
      data-testid="quay-panel-inflight"
      // The tile's focusable children, in spatial order. Absent — not "[]" — when the lane
      // reading failed OR the project is not registered with quay-fleet: in both cases there
      // is no address this side may mint.
      data-quay-focusables={contract === null ? undefined : JSON.stringify(focusables)}
    >
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">In flight</h3>
      {fleetProjectId === null && fleetState !== 'missing' && fleetState !== 'incompatible' ? (
        // The reference's project segment must be a fleet registry id. CloudCLI's own project
        // id is NOT an honest fallback — the fleet would reject it — so the tile says the
        // project is unregistered and declares no focusable objects. When the CLI itself is
        // missing/incompatible the notice above states that ONE cause instead, so this card
        // does not blame the project for a host-level failure.
        <p className="mb-2 text-xs text-amber-700 dark:text-amber-300" data-testid="quay-panel-inflight-unregistered">
          Not registered in quay-fleet (未登记到 quay-fleet) — these tasks cannot be referenced.
        </p>
      ) : null}
      {inFlight === null ? (
        <p className="text-xs text-amber-700 dark:text-amber-300" data-testid="quay-panel-inflight-unavailable">
          In-flight tasks unavailable — no lane reading (quay's `lanes` verb could not be read).
        </p>
      ) : inFlight.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="quay-panel-inflight-empty">
          No tasks currently in flight.
        </p>
      ) : (
        <ul className="space-y-1" data-testid="quay-panel-inflight-list">
          {inFlight.map((task, index) => {
            const phase = IN_FLIGHT_PHASE_META[task.phase];
            const heartbeatAgeMs = elapsedSince(task.lastHeartbeat, generatedAt);
            const stale = heartbeatAgeMs !== null && heartbeatAgeMs > IN_FLIGHT_STALE_AFTER_MS;
            const focusable = focusables[index];
            return (
              <li
                key={task.taskId}
                className="flex items-center gap-2 rounded border border-border/40 px-2 py-1 text-xs"
                data-testid="quay-panel-inflight-row"
                // The wall declaration for this row, verbatim: the reference the voice pack
                // carries instead of the task's content.
                data-quay-uri={focusable?.uri}
                data-quay-label={focusable?.label}
                data-quay-display={focusable === undefined ? undefined : JSON.stringify(focusable.display)}
              >
                <span
                  className="shrink-0 text-[11px] text-muted-foreground"
                  data-testid="quay-panel-inflight-label"
                  title="spoken label for this object"
                >
                  {focusable?.label}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground" title={task.taskId}>
                  {task.taskId}
                </span>
                <span
                  className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium', phase.className)}
                  data-testid={`quay-panel-inflight-phase-${task.phase}`}
                >
                  {phase.label}
                </span>
                <span
                  className="shrink-0 text-[10px] text-muted-foreground"
                  data-testid="quay-panel-inflight-heartbeat"
                  data-heartbeat={task.lastHeartbeat}
                  title="last heartbeat"
                >
                  {formatTimestamp(task.lastHeartbeat)}
                </span>
                {stale ? (
                  <span
                    className="shrink-0 rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-950 dark:text-red-300"
                    data-testid="quay-panel-inflight-stale"
                    title="heartbeat is older than the worker's own round interval — the worker may be wedged"
                  >
                    stale
                  </span>
                ) : null}
                <span className="shrink-0 text-[10px] text-muted-foreground" data-testid="quay-panel-inflight-elapsed">
                  {formatDuration(elapsedSince(task.startedAt, generatedAt))}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * Loop pulse card: quay's own packed gantt lanes for this project's recent worker runs.
 *
 * The lanes are computed upstream (by quay's `lanes` verb, over its `dashboard-kernel`), not
 * here — see `LoopPulseGantt`. A `null` reading never renders as an empty chart: an unreported
 * lane set and a genuinely idle window are different readings, and only one of them means
 * "nothing ran". When the host can change the window, the card still renders (selector included)
 * and states the reason in place of the plot; otherwise the reading is a plain unavailable line.
 */
function LoopPulseCard({
  gantt,
  ganttUnavailable,
  windowHours,
  onWindowChange,
  refreshing,
}: {
  gantt: QuaySnapshot['gantt'];
  ganttUnavailable?: QuaySnapshot['ganttUnavailable'];
  windowHours?: number;
  onWindowChange?: (hours: number) => void;
  refreshing?: boolean;
}) {
  const lanes = gantt ?? null;

  return (
    <section data-testid="quay-panel-loop-pulse">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Loop pulse</h3>
      {lanes || onWindowChange ? (
        // With a host that can honour a window change, the card renders even with no lane set:
        // its selector is the window's own control, and the reason line replaces the chart
        // rather than the whole card. Without such a host, an absent reading stays the plain
        // unavailable line (there is no window to offer).
        <LoopPulseGantt
          gantt={lanes}
          windowHours={windowHours}
          onWindowChange={onWindowChange}
          refreshing={refreshing}
          unavailableReason={ganttUnavailable ?? null}
        />
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="quay-panel-loop-pulse-unavailable">
          Loop pulse unavailable — no packed lane set was reported.
        </p>
      )}
    </section>
  );
}

/**
 * Rendered by WorkspaceMain as the Quay tab. Shows a read-only snapshot of the
 * selected project's quay state: the task ledger, stage goals, the current test
 * suite plus its recent rounds, recent fan-in attempts, the driver reading and
 * the ADR list — with a manual refresh and a link out to quay's own dashboard.
 * It never mutates quay state.
 */
export default function QuayPanel({
  projectId,
  view,
  onRefresh,
  dashboardUrl = null,
  windowHours,
  onWindowChange,
  ganttRefreshing = false,
  onFocusTask,
}: QuayPanelProps) {
  if (view.status === 'not-configured') {
    return (
      <div className="flex h-full items-center justify-center p-6" data-testid="quay-panel-not-configured">
        <div className="max-w-sm text-center text-sm text-muted-foreground">
          <Info className="mx-auto mb-2 h-5 w-5" />
          quay is not configured for this project. Add a <code>.quay/config.yml</code> to enable it.
        </div>
      </div>
    );
  }

  if (view.status === 'loading') {
    return (
      <div className="flex h-full items-center justify-center gap-2 p-6 text-sm text-muted-foreground" data-testid="quay-panel-loading">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading quay status…
      </div>
    );
  }

  if (view.status === 'error') {
    return (
      <div className="flex h-full items-center justify-center p-6" data-testid="quay-panel-error">
        <div className="max-w-sm text-center text-sm text-muted-foreground">
          <AlertTriangle className="mx-auto mb-2 h-5 w-5 text-amber-500" />
          <p className="mb-3">{view.message}</p>
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <LoadedQuayPanel
      projectId={projectId}
      snapshot={view.snapshot}
      onRefresh={onRefresh}
      dashboardUrl={dashboardUrl}
      windowHours={windowHours}
      onWindowChange={onWindowChange}
      ganttRefreshing={ganttRefreshing}
      onFocusTask={onFocusTask}
    />
  );
}

/** The `loaded` branch of `QuayPanel`; split out so the summary layout stays readable. */
function LoadedQuayPanel({
  projectId,
  snapshot,
  onRefresh,
  dashboardUrl,
  windowHours,
  onWindowChange,
  ganttRefreshing,
  onFocusTask,
}: {
  projectId: string;
  snapshot: QuaySnapshot;
  onRefresh: () => void;
  dashboardUrl: string | null;
  windowHours?: number;
  onWindowChange?: (hours: number) => void;
  ganttRefreshing: boolean;
  onFocusTask?: (uri: string) => void;
}) {
  // This panel only renders for a project that has a `.quay/config.yml`, so a null
  // driver means `driver status --json` did not answer — never "not configured",
  // which would contradict the very tab the badge sits in.
  const driverState: QuayDriverState = snapshot.driver === null ? 'unavailable' : snapshot.driver.state;

  // The server's CLI reading, when it sent one. Absent is "not reported" (an older backend),
  // not "the CLI is missing", so it must not produce a notice.
  const fleetState: QuayFleetCliState | null = snapshot.fleet?.state ?? null;

  // One window for the whole tab: the Loop pulse reading's own window, handed to the Tests and
  // Fan-in bars so all three charts are cut to the same slice (see `resolveTimelineWindow`).
  const timelineWindow = resolveTimelineWindow(snapshot.gantt ?? null, windowHours, snapshot.generatedAt);

  // THE CACHED READING'S AGE, as a first-class reading. 「(cached)」 alone is easy to miss; a
  // snapshot served from cache is only useful if the person can see how old it is, and an OLD
  // cached snapshot must look different from a fresh one. `generatedAt` is the server's own
  // read time, so the age is a property of the snapshot, not of when this component mounted.
  const generatedMs = toEpochMs(snapshot.generatedAt);
  const cachedAgeMs = snapshot.cached && generatedMs !== null ? Math.max(0, Date.now() - generatedMs) : null;
  const cachedStale = cachedAgeMs !== null && cachedAgeMs > CACHED_STALE_AFTER_MS;

  // The strip's focus action addresses the TASK, and the only project segment a `quay://`
  // reference may carry is the fleet registry id. An unregistered project has no address to
  // mint, so the strip stays display-only there rather than emitting an undereferenceable URI.
  const fleetProjectId = snapshot.fleetProjectId ?? null;
  const focusPulseTask =
    onFocusTask === undefined || fleetProjectId === null
      ? undefined
      : (taskId: string) =>
          onFocusTask(formatQuayUri({ type: 'task', project: fleetProjectId, id: taskId, ac: null }));

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4" data-testid="quay-panel-loaded">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold text-foreground">quay status</span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            read-only
          </span>
          <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', DRIVER_CLASSES[driverState])}>
            {DRIVER_LABELS[driverState]}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground" data-testid="quay-panel-synced-at">
            Last synced {formatTimestamp(snapshot.generatedAt)}
            {snapshot.cached && (
              <span
                className={cn(
                  'ml-1 rounded px-1',
                  cachedStale && 'bg-amber-50 font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300',
                )}
                data-testid="quay-panel-cached-age"
                data-stale={cachedStale ? 'true' : 'false'}
                title={cachedStale ? 'the cached reading is older than the refresh interval' : 'served from the backend cache'}
              >
                · cached{cachedAgeMs === null ? '' : ` ${formatCachedAge(cachedAgeMs)}`}
                {cachedStale ? ' · stale' : ''}
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
          {dashboardUrl && (
            <a
              href={dashboardUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              Dashboard
            </a>
          )}
        </div>
      </div>

      {/*
        THE PULSE STRIP SITS AT THE TOP OF THE PANEL. The four dense rows are the always-visible
        reading (the panel's equivalent of the cockpit tile's strip); the full Loop pulse card
        below stays the expanded view. One window switch lives on the strip (6/24/72 h) and is
        independent of the gantt card's own data window.
      */}
      <div className="mb-3" data-testid="quay-panel-pulse">
        <PulseStrip
          inFlight={snapshot.inFlight}
          gantt={snapshot.gantt ?? null}
          tests={snapshot.tests}
          fanIn={snapshot.fanIn}
          blockers={snapshot.blockers ?? null}
          generatedAt={snapshot.generatedAt}
          onFocusTask={focusPulseTask}
          testId="quay-panel-pulse-strip"
        />
      </div>

      {/*
        ONE line for the whole host. Without this, a missing/incompatible/compat-only fleet
        reads as 「未登记到 quay-fleet」 on every project — the same sentence, one cause.
      */}
      {fleetState !== null && fleetState !== 'ok' && (
        <p
          className={fleetState === 'no-handshake'
            ? 'mb-3 rounded border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground'
            : 'mb-3 rounded border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200'}
          data-testid="quay-panel-fleet-state"
          data-fleet-state={fleetState}
        >
          {fleetState === 'missing'
            ? `quay-fleet was not found on this server — ${snapshot.fleet?.reason ?? 'no reason reported'}`
            : fleetState === 'incompatible'
              ? `quay-fleet speaks an incompatible contract — ${snapshot.fleet?.reason ?? 'no reason reported'}`
              : `quay-fleet did not complete the version handshake${snapshot.fleet?.binPath === null || snapshot.fleet?.binPath === undefined ? '' : ` (${snapshot.fleet.binPath})`} — continuing as compatible`}
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <TaskLedger tasks={snapshot.tasks} />
        <StageGoals goals={snapshot.goals} />
        <LoopPulseCard
          gantt={snapshot.gantt ?? null}
          ganttUnavailable={snapshot.ganttUnavailable ?? null}
          windowHours={windowHours}
          onWindowChange={onWindowChange}
          refreshing={ganttRefreshing}
        />
        <TestsCard tests={snapshot.tests} window={timelineWindow} />
        <InFlightCard
          fleetProjectId={snapshot.fleetProjectId ?? null}
          fleetState={fleetState}
          inFlight={snapshot.inFlight}
          generatedAt={snapshot.generatedAt}
        />
        <FanInCard fanIn={snapshot.fanIn} window={timelineWindow} />

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Driver</h3>
          <dl className="space-y-1 text-xs">
            <div className="flex justify-between rounded border border-border/40 px-2 py-1">
              <dt className="text-muted-foreground">State</dt>
              <dd className="text-foreground">{DRIVER_LABELS[driverState]}</dd>
            </div>
            <div className="flex justify-between rounded border border-border/40 px-2 py-1">
              <dt className="text-muted-foreground">Last record</dt>
              <dd className="text-foreground" data-testid="quay-panel-driver-last-record">
                {/* `never` is a real reading (the driver has no record yet); a failed
                    read is not, and saying `never` for it invents one. */}
                {snapshot.driver === null ? 'unavailable' : formatTimestamp(snapshot.driver.lastRecordAt)}
              </dd>
            </div>
            <div className="flex justify-between rounded border border-border/40 px-2 py-1">
              <dt className="text-muted-foreground">Config issues</dt>
              <dd className="text-foreground" data-testid="quay-panel-config-issues">
                {snapshot.configIssues === null ? 'unavailable' : snapshot.configIssues.total}
              </dd>
            </div>
          </dl>
        </section>

        <DetailList
          title={snapshot.adrs === null ? 'ADRs' : `ADRs (${snapshot.adrs.total})`}
          items={snapshot.adrs === null ? null : snapshot.adrs.recent}
          emptyText="No ADRs reported."
          testId="quay-panel-recent-adrs"
        />
      </div>

      {snapshot.warnings.length > 0 && (
        <div className="mt-4 rounded border border-amber-200 bg-amber-50/60 p-2 text-[11px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300" data-testid="quay-panel-warnings">
          <p className="mb-1 font-medium">Some quay commands did not answer:</p>
          <ul className="list-inside list-disc space-y-0.5">
            {snapshot.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      <p
        className="mt-4 text-[11px] text-muted-foreground"
        data-testid="quay-panel-project"
        data-fleet-project-id={snapshot.fleetProjectId ?? undefined}
      >
        Project {snapshot.fleetProjectId ?? projectId}
      </p>
    </div>
  );
}
