import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Square } from 'lucide-react';

import { useActivityFreshness } from '@/modules/chat/hooks/useActivityFreshness';
import { selectActiveTasks, useSessionActivity } from '@/modules/chat/hooks/useSessionActivity';
import { deriveActivityDockView } from '@/modules/chat/utils/activityDockView';
import ActivityDockPanel from '@/modules/chat/transcript/ActivityDockPanel';
import type { ForegroundTool } from '@/modules/chat/hooks/useActivityControls';
import { Shimmer } from '@/shared/ui';
import type { ActivityConnection, SessionActivity } from '@/shared/types';

type ActivityIndicatorProps = {
  activity: SessionActivity | null;
  /** The session whose liveness this dock reports; frames for other sessions are ignored. */
  sessionId?: string | null;
  /**
   * Test seam: an in-memory liveness channel. Production omits it and the dock
   * reads the app's own socket through `WebSocketContext`.
   */
  connection?: ActivityConnection | null;
  /**
   * True when the last send was never taken. The dock then reports the failure
   * instead of drawing nothing — the state that replaced the old silent drop.
   */
  sendFailed?: boolean;
  /**
   * The running foreground tool, read off the loaded transcript by the caller
   * (the pane already holds the messages). Absent draws no foreground row in the
   * expanded panel, which is what a session with no pending `tool_use` has.
   */
  foregroundTool?: ForegroundTool | null;
  /**
   * Stops the running turn. The status line draws its own Stop from this — the row belongs to the
   * turn, not to whichever composer is on screen, so it is the one stop that is present in Live
   * Voice too, where the ordinary composer (and its submit-button Stop) is not mounted.
   *
   * Absent draws no Stop: a standalone render, or a caller that does not own the abort path, does
   * not offer a control it cannot honour.
   */
  onStop?: () => void;
  /**
   * Whether a Stop would be honoured right now — the caller's own abort gate (`canAbortSession`).
   * The button is drawn only when this is true, so the row never shows a stop that would do nothing.
   */
  canStop?: boolean;
};

/**
 * The English fallback for each phase label key — the value used only when a
 * locale file is missing the key. Kept beside the keys so a key added above
 * without a fallback is visible in one place.
 */
const PHASE_LABEL_FALLBACKS: Record<string, string> = {
  'claudeStatus.phases.thinking': 'Thinking',
  'claudeStatus.phases.writing': 'Writing',
  'claudeStatus.phases.tool': 'Running {{tool}}',
  'claudeStatus.phases.toolGeneric': 'Running a tool',
  'claudeStatus.phases.compacting': 'Compacting',
  'claudeStatus.phases.awaitingPermission': 'Waiting for approval',
};
/** The word for a running turn whose phase the server has not reported. */
const WORKING_FALLBACK_KEY = 'claudeStatus.actions.working';
const WORKING_FALLBACK_WORD = 'Working';
/**
 * The honest label for a running turn the server has named no phase for, long
 * enough that `Working…` would be the dock's claim rather than the server's
 * reading. Deliberately NOT under `claudeStatus.actions.*`: that group is the
 * rotating-word set a healthy turn draws from, and the unreachable criterion
 * pins that none of those words survives a lost connection.
 */
const AWAITING_SERVER_KEY = 'claudeStatus.awaitingServer.title';
const AWAITING_SERVER_FALLBACK = 'Waiting for the server';
const EXIT_ANIMATION_MS = 220;

/**
 * The activity dock: one honest reading of what a session is doing.
 *
 * It is the surface that replaced the rotating `Thinking…` label, and — since
 * the consolidation — the *only* one. The desktop tab-shaped strip and the
 * transcript's compact line used to be two renderings of one component behind a
 * `variant` switch, each with a marker of its own; they are now a single surface
 * with a single `[data-activity-dock]` root, mounted once per viewport, so a
 * reader that counts docks counts one and a reader that looks for the old
 * markers finds none.
 *
 * Every viewport draws it the same way now: an in-flow status line at the end of
 * the message list, with the running turn's own Stop on it. The tab that hung off
 * the composer's top edge from `md` up used to carry a Stop of its own; that is
 * gone, and the Stop lives here instead — on the row, so it belongs to the TURN
 * rather than to the composer, and is present in Live Voice too, where the
 * composer (and its submit-button Stop) is replaced by the voice bar. The
 * composer's submit button remains the same command as a shortcut in text mode.
 *
 * Two things decide what it says — the client's local "this session is
 * processing" table, and the freshness of the server's own frames (via
 * `useActivityFreshness`). When the server stops proving it is there, the dock
 * stops speaking for it: the state becomes `unreachable`, the elapsed reading
 * freezes at the server's last `asOf`, and the label says the connection is
 * lost. The six rotating action words never appear in that state, in any locale.
 *
 * The same honesty applies while the server *is* there: a running turn whose
 * phase it has never named, past `UNCONFIRMED_TURN_LABEL_MS`, reads the
 * "waiting for the server" wording instead of `Working…` — the local table still
 * holds the turn, but the server is describing no work for it. The state stays
 * `in-turn` and the turn's own Stop stays drawn; only the claim about what the
 * turn is *doing* changes.
 *
 * The dock answers one question — what is this session doing — and nothing else.
 * A resident session's own facts (the address of the process, its pid, and the
 * controls that start, restart and close it) used to live in an expanded panel
 * here, behind an arrow, which meant the dock had to stay on screen between turns
 * to carry the arrow, and that a panel opened in the message flow pushed the
 * transcript instead of floating over it. They are the resident pill's now, in
 * the header (`ResidentSessionBadge`); the dock is absent between turns for every
 * session, resident or not.
 *
 * Records `data-activity-dock` / `data-activity-state` / `data-activity-phase`
 * (and the server-derived `data-activity-elapsed-ms`) for the browser criterion.
 * The phase and the running label are the same reading: both come from the phase
 * the server reduced, so a reader that checks either one is checking that source
 * rather than two independent claims.
 */
export default function ActivityIndicator({
  activity,
  sessionId,
  connection,
  sendFailed = false,
  foregroundTool = null,
  onStop,
  canStop = false,
}: ActivityIndicatorProps) {
  const { t } = useTranslation('chat');
  const freshness = useActivityFreshness(sessionId, connection);
  const { tasks, schedules } = useSessionActivity(sessionId);
  // The dock reports *current* activity: a finished task is not part of what the
  // session is doing now, so it leaves the count (and, with the last one gone,
  // the dock itself) even though the task table keeps its row for the transcript
  // card that joins it. One filter, shared with the panel's list.
  const activeTaskCount = selectActiveTasks(tasks).length;
  const [renderedActivity, setRenderedActivity] = useState<SessionActivity | null>(activity);
  const [isExiting, setIsExiting] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);

  useEffect(() => {
    if (activity) {
      setRenderedActivity(activity);
      setIsExiting(false);
      return;
    }

    if (!renderedActivity) return;

    setIsExiting(true);
    const timer = setTimeout(() => {
      setRenderedActivity(null);
      setIsExiting(false);
    }, EXIT_ANIMATION_MS);

    return () => clearTimeout(timer);
  }, [activity, renderedActivity]);

  // A failed send must be reportable the moment it is known. While the turn is
  // real (`activity` present) the exit animation's last frame is the better
  // reading; with no turn at all there is nothing to animate out of, so the
  // failed-send state takes the live prop rather than the exiting render.
  const dockActivity = sendFailed ? activity : renderedActivity;
  // Whether this surface can interrupt at all. Read as a capability (a Stop is offered here)
  // rather than as a state, so it can feed the view machine below; whether the Stop is DRAWN
  // additionally requires the turn to be running, which is read off the bar's own state after.
  const canInterrupt = canStop && typeof onStop === 'function';
  // The row owns its turn's Stop. The composer's submit button is the same command at a
  // different surface, but it is NOT mounted while Live Voice is (the bar replaces the
  // composer), so a stop that lived only there would leave a running turn unstoppable from
  // inside the live mode. The stop belongs to the running turn, which is exactly what this
  // surface reports, so it is drawn here and reaches every composer and every viewport.
  const dock = deriveActivityDockView({
    activity: dockActivity,
    liveness: freshness.liveness,
    elapsedMs: freshness.elapsedMs,
    hasTurnAnchor: freshness.hasTurnAnchor,
    wired: freshness.wired,
    // The dock now owns an interrupt, so the flag is derived rather than fixed false: the
    // unreachable branch reads it as "an interrupt existed here", which is true whenever a
    // stop is offered on this surface.
    hasAbort: canInterrupt,
    sendFailed,
    phase: freshness.phase,
    toolName: freshness.toolName,
    taskCount: activeTaskCount,
    scheduleCount: schedules.length,
  });

  // `hidden` — nothing to say — draws nothing at all, for every session. A resident
  // session used to keep a collapsed `idle` dock between turns, and the only reason
  // was that the dock carried the arrow that opened the process's facts. Those facts
  // are the resident pill's now, in the header, so between turns this dock has
  // nothing to report and is absent like any other session's.
  const state = dock.state;

  // The Stop is drawn on the running turn alone: `background` holds work but no turn to
  // interrupt, and the failed-send / unreachable states cannot honour an interrupt at all.
  const showStop = state === 'in-turn' && canInterrupt;

  if (state === 'hidden') return null;

  const dockAttributes = {
    'data-activity-dock': '',
    'data-activity-state': state,
    // The phase the server reported, published verbatim so a reader can tell
    // *what* the turn is doing from the same source the label is drawn from.
    'data-activity-phase': dock.phase,
    ...(dock.elapsedMs === null ? {} : { 'data-activity-elapsed-ms': String(dock.elapsedMs) }),
  } as const;

  const elapsedSeconds = dock.elapsedSeconds;
  const minutes = elapsedSeconds === null ? 0 : Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds === null ? 0 : elapsedSeconds % 60;
  const elapsedLabel = elapsedSeconds === null
    ? null
    : minutes < 1
      ? t('claudeStatus.elapsed.seconds', { count: seconds, defaultValue: '{{count}}s' })
      : t('claudeStatus.elapsed.minutesSeconds', { minutes, seconds, defaultValue: '{{minutes}}m {{seconds}}s' });

  const isUnreachable = state === 'unreachable';
  const isSendFailed = state === 'send-failed';
  const isBackground = state === 'background';
  // A fresh turn the server has not described with a phase for too long. The
  // dock keeps the turn (and its Stop) but stops claiming work the server is not
  // reporting — the wording below says it is waiting on the server instead.
  const awaitingServer = dock.awaitingServer;
  const showCounts = dock.taskCount > 0 || dock.scheduleCount > 0;
  // The running label comes from the *phase the server reported*, not from
  // elapsed time: a turn on an unknown phase falls back to a fixed word (or the
  // provider's own status line), and the same phase always says the same thing
  // for as long as it lasts. The fixed word itself is honest: a turn the server
  // has described reads its phase word, a provider status line is the provider's
  // own words, and a turn whose phase the server has still not named after the
  // threshold says that — it is waiting on the server, not quietly working.
  const phaseLabel = dock.phaseLabelKey === null
    ? null
    : t(dock.phaseLabelKey, {
        tool: dock.toolName ?? '',
        defaultValue: PHASE_LABEL_FALLBACKS[dock.phaseLabelKey] ?? dock.phase,
      });
  const label = isSendFailed
    ? t('claudeStatus.sendFailed.title', { defaultValue: 'Send failed · server not responding' })
    : isUnreachable
      ? t('claudeStatus.unreachable.title', { defaultValue: 'Connection lost · reconnecting…' })
      : isBackground
        // No turn to speak about, but the session is holding work: the dock says
        // so from the snapshot's counts, and the panel lists them.
        ? t('claudeStatus.background.title', { defaultValue: 'Background work' })
        : (phaseLabel
          ?? renderedActivity?.statusText
          ?? (awaitingServer
            ? t(AWAITING_SERVER_KEY, { defaultValue: AWAITING_SERVER_FALLBACK })
            : t(WORKING_FALLBACK_KEY, { defaultValue: WORKING_FALLBACK_WORD }))).replace(/\.+$/, '');
  const sendFailedReason = t('claudeStatus.sendFailed.reason', {
    defaultValue: 'The message was not sent. Your draft is still in the box — try again.',
  });

  const animationClassName = isExiting ? 'chat-activity-exit' : 'chat-activity-enter';

  /**
   * The label's own pixels: a shimmered word while a turn runs, a plain
   * sentence when it cannot. The failed send is its own sentence with the way
   * out beside it — the draft the user still has, and the button that sends it.
   */
  const labelNode = (
    <span data-activity-label="true">
      {isSendFailed ? (
        <span className="font-medium">
          {label}
          <span className="text-muted-foreground/70"> · {sendFailedReason}</span>
        </span>
      ) : isUnreachable || isBackground ? (
        <span className="font-medium">{label}</span>
      ) : (
        <Shimmer className="font-medium">{`${label}…`}</Shimmer>
      )}
    </span>
  );

  const surfaceClassName =
    'chat-activity-dock-surface inline-flex h-8 items-center gap-2 rounded-lg border border-border/50 bg-card px-3 text-xs shadow-[0_-1px_1px_hsl(var(--foreground)/0.04),1px_0_1px_hsl(var(--foreground)/0.03),-1px_0_1px_hsl(var(--foreground)/0.03)] transition-all duration-200';

  return (
    <div className={`pointer-events-none bg-transparent ${animationClassName}`} {...dockAttributes}>
      <div className="relative inline-flex flex-col items-start">
        {/* The expanded background panel floats above the dock, so opening it
            never pushes the transcript. It is a pure reader of the session's
            activity snapshot — see `ActivityDockPanel`. */}
        {panelOpen && (
          <div className="absolute bottom-full left-0 z-20 mb-1">
            {/* The panel's controls go by the same liveness reading this dock
                renders from — one machine, so the buttons can never disagree
                with the state the row is drawn under. */}
            <ActivityDockPanel
              sessionId={sessionId}
              liveness={freshness.liveness}
              foregroundTool={foregroundTool}
            />
          </div>
        )}
        {/*
          The status line. It says what the turn is doing, and — while a turn is running and
          the caller can interrupt it — carries that turn's own Stop. The Stop is drawn here
          rather than only on the composer because the composer is not mounted in Live Voice;
          it is the same `canAbortSession` command either way.
        */}
        <div className={surfaceClassName} data-activity-dock-surface="true">
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden />
          {labelNode}
          {elapsedLabel !== null && (
            <span className="tabular-nums text-muted-foreground/60">{elapsedLabel}</span>
          )}
          {showStop && (
            <button
              type="button"
              data-testid="running-turn-stop"
              onClick={onStop}
              aria-label={t('input.stop', { defaultValue: 'Stop' })}
              title={t('input.stop', { defaultValue: 'Stop' })}
              className="pointer-events-auto -mr-1 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
            >
              <Square className="h-3 w-3 fill-current" aria-hidden />
            </button>
          )}
          {/*
            The background counts, read straight off the snapshot: how many live
            tasks and how many plans the session holds. A finished task is not in
            this count — the dock answers "what is running now", not "what has
            ever run". The whole summary is the toggle that opens the panel that
            lists them; nothing here is a control over the work itself.
          */}
          {showCounts && (
            <button
              type="button"
              data-activity-dock-toggle="true"
              aria-expanded={panelOpen}
              onClick={() => setPanelOpen((open) => !open)}
              className="pointer-events-auto flex flex-shrink-0 items-center gap-2 rounded px-1 tabular-nums text-muted-foreground/80 transition-colors hover:bg-foreground/5 hover:text-foreground"
            >
              <span data-activity-task-count={dock.taskCount} title={t('claudeStatus.background.tasks', { defaultValue: 'Background tasks' })}>
                {dock.taskCount} {dock.taskCount === 1 ? 'task' : 'tasks'}
              </span>
              <span data-activity-schedule-count={dock.scheduleCount} title={t('claudeStatus.background.plans', { defaultValue: 'Plans' })}>
                {dock.scheduleCount} {dock.scheduleCount === 1 ? 'plan' : 'plans'}
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
