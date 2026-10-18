import { useMemo, useState, type ReactNode } from 'react';
import { Activity, Moon, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import { classifyRunningSessions, useSessionHosts } from '@/shared/hooks/useSessionHosts';
import { useBusySessionIdSet, useProcessingSessions } from '@/shared/context/SessionProtectionContext';
import { useTickingNow } from '@/modules/sidebar/hooks/useTickingNow';
import { presentSessionActivity } from '@/modules/sidebar/utils/sessionActivityPresentation';
import type { Project, SessionActivity } from '@/shared/types';

/**
 * The Running view: the sessions with a turn in flight, above the resident
 * sessions a process is being held open for.
 *
 * Two groups rather than one flat list because the two are different answers to
 * "is anything happening": a turn in flight is work the user is waiting on, and
 * a resident host between turns is a process that will still be there in an
 * hour. A list that mixed them would make the count at its top ambiguous, which
 * is exactly the reading the sidebar badge exists to give — and the badge counts
 * only the first group, so a view that drew them as one list would contradict
 * the number a reader just saw.
 *
 * The two groups come from the two sources each of them is actually about. Which
 * sessions are *running* is the server-authoritative activity the rest of the
 * page reads — the activity dock's own `SessionActivity` membership and the
 * composer's stop entry are the same set — so the view can never lag the dock by
 * a poll interval and say "running" about a turn the dock has already seen end.
 * Which resident sessions are merely *held open* comes from the
 * `GET /api/session-hosts` listing, which is the only face that knows a process
 * exists between turns; that listing is not consulted for busy/idle at all.
 *
 * The rows are the view's own and not `SidebarProjectList`'s, because the second
 * group's rows carry a control — closing the held process — that a project row
 * has no place for. They are plain links otherwise, so a session found here is
 * still one click from being opened.
 */
type RunningViewProps = {
  /** Every project's sessions, for the row titles; the view never groups by project. */
  projects: Project[];
  /** The search box's text. Applied to the row titles, so the box is not inert here. */
  searchQuery: string;
  t: TFunction;
};

/** A session's display name, falling back to its id so a row is never blank. */
function sessionLabel(projectIndex: Map<string, string>, sessionId: string, t: TFunction): string {
  return projectIndex.get(sessionId) ?? t('sessions.unnamed', 'Unnamed');
}

/**
 * Which group's header a set of rows is drawn under.
 *
 * The `data-running-group` values are the contract a reader outside this
 * component addresses each group by; they are ASCII and stable, while the
 * headings above them are translated.
 */
const RUNNING_GROUP = 'running';
const RESIDENT_IDLE_GROUP = 'resident-idle';

export default function RunningView({ projects, searchQuery, t }: RunningViewProps) {
  const { snapshot, close } = useSessionHosts();
  // The phase words and the elapsed wording are the chat dock's own keys, so
  // this surface reads them from the chat namespace rather than growing a
  // second vocabulary the dock would not recognise.
  const { t: tChat } = useTranslation('chat');
  const [closeError, setCloseError] = useState<string | null>(null);

  // The busy side is the page's one activity reading — the same `SessionActivity`
  // membership the activity dock and the composer's stop entry draw from — and the
  // listing below it only names the resident processes held open between turns.
  // Reading busy/idle off the one-second host poll here is what let the view and
  // the dock disagree for a beat after a turn ended; see `classifyRunningSessions`.
  const busySessionIds = useBusySessionIdSet();
  // The view draws every running session, so the whole map is the right
  // reading here: each row takes its own entry from it below.
  const activities = useProcessingSessions();
  const { running: runningIds, residentIdle: residentIdleIds } = useMemo(
    () => classifyRunningSessions(busySessionIds, snapshot),
    [busySessionIds, snapshot],
  );
  // Only a running group draws elapsed time, so the one-second tick exists
  // only while there is one.
  const now = useTickingNow(runningIds.length > 0);

  // `sessionId -> display name`, built once per project list. The host listing
  // names sessions by id only — it is the host layer's view, not the sessions' —
  // so the titles have to come from the rows the sidebar already holds.
  const titles = useMemo(() => {
    const index = new Map<string, string>();
    for (const project of projects) {
      for (const session of project.sessions ?? []) {
        const label =
          (typeof session.summary === 'string' && session.summary) ||
          (typeof session.name === 'string' && session.name) ||
          (typeof session.title === 'string' && session.title) ||
          '';
        if (label) {
          index.set(String(session.id), label);
        }
      }
    }
    return index;
  }, [projects]);

  const query = searchQuery.trim().toLowerCase();
  const matches = (sessionId: string): boolean =>
    query.length === 0 || sessionLabel(titles, sessionId, t).toLowerCase().includes(query);

  const running = runningIds.filter(matches);
  const residentIdle = residentIdleIds.filter(matches);

  const closeHost = (sessionId: string): void => {
    setCloseError(null);
    void close(sessionId).catch((error: unknown) => {
      // The server's refusal is the useful part — "this session is not resident"
      // and "no live host is serving it" are different answers — so it is shown
      // rather than swallowed. A row that silently did nothing would leave the
      // user clicking a button that appears broken.
      setCloseError(error instanceof Error ? error.message : String(error));
    });
  };

  if (runningIds.length === 0 && residentIdleIds.length === 0) {
    return (
      <div className="px-4 py-12 text-center md:py-8" data-running-view="true" data-running-empty="true">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg border border-border/70 bg-muted/50 md:mb-3">
          <Activity className="h-6 w-6 text-muted-foreground" />
        </div>
        <h3 className="mb-2 text-base font-medium text-foreground md:mb-1">
          {t('running.emptyTitle', 'No sessions running')}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t('running.emptyDescription', 'Active work will appear here while a provider is processing.')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-running-view="true">
      <RunningGroup
        group={RUNNING_GROUP}
        icon={<Activity className="h-3.5 w-3.5" />}
        title={t('running.groupRunning', 'Running')}
        idleHint={t('running.noMatchingSessions', 'No sessions match this search.')}
        sessionIds={running}
        titles={titles}
        activities={activities}
        now={now}
        t={t}
        tChat={tChat}
      />
      <RunningGroup
        group={RESIDENT_IDLE_GROUP}
        icon={<Moon className="h-3.5 w-3.5" />}
        title={t('running.groupResidentIdle', 'Resident (idle)')}
        idleHint={t('running.noMatchingSessions', 'No sessions match this search.')}
        sessionIds={residentIdle}
        titles={titles}
        activities={activities}
        now={now}
        t={t}
        tChat={tChat}
        onClose={closeHost}
      />
      {closeError ? (
        <p data-running-close-error="true" className="px-2 text-[11px] text-red-600 dark:text-red-400">
          {closeError}
        </p>
      ) : null}
    </div>
  );
}

/**
 * One group: a header carrying the count, then a row per session.
 *
 * `count` is published as a data attribute as well as drawn, because the two are
 * not the same reading: the text is what a reader sees, and the attribute is
 * what a reader outside the component can compare against the listing without
 * parsing a translated sentence.
 */
function RunningGroup({
  group,
  icon,
  title,
  idleHint,
  sessionIds,
  titles,
  activities,
  now,
  t,
  tChat,
  onClose,
}: {
  group: string;
  icon: ReactNode;
  title: string;
  idleHint: string;
  sessionIds: string[];
  titles: Map<string, string>;
  activities: ReadonlyMap<string, SessionActivity>;
  now: number;
  t: TFunction;
  tChat: TFunction;
  onClose?: (sessionId: string) => void;
}) {
  // The resident group is the group with no turn: its rows say `idle` and
  // publish no phase, which is the reading that tells a reader the session is
  // held open between turns rather than working.
  const isResidentIdleGroup = group === RESIDENT_IDLE_GROUP;

  return (
    <section data-running-group={group} data-running-group-count={sessionIds.length} className="space-y-1">
      <div className="mx-2 flex items-center justify-between rounded-lg border border-border/60 bg-card/50 px-3 py-2 shadow-sm">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
            {icon}
          </span>
          <span className="truncate text-xs font-normal text-foreground">{title}</span>
        </div>
        <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-normal text-emerald-700 dark:text-emerald-300">
          {sessionIds.length}
        </span>
      </div>

      {sessionIds.length === 0 ? (
        <p className="px-4 py-2 text-[11px] text-muted-foreground">{idleHint}</p>
      ) : (
        sessionIds.map((sessionId) => {
          const activity = isResidentIdleGroup ? undefined : activities.get(sessionId);
          const presented = presentSessionActivity(activity, now, tChat);

          return (
            <div
              key={sessionId}
              data-running-session={sessionId}
              // The phase attributes are the row's contract with a reader
              // outside the component: only a session with a turn publishes
              // them, so a resident-idle row cannot be mistaken for a working
              // one by the attribute a criterion looks for.
              data-activity-phase={presented.phase ?? undefined}
              {...(presented.phase === 'tool' ? { 'data-activity-tool': presented.toolName ?? '' } : {})}
              data-activity-elapsed={presented.elapsedMs ?? undefined}
              className="mx-2 flex items-center gap-1 rounded-lg border border-border/50 bg-card/30 px-2 py-1.5"
            >
              <a
                href={`/session/${sessionId}`}
                title={sessionLabel(titles, sessionId, t)}
                className="min-w-0 flex-1 truncate text-xs text-foreground hover:underline"
              >
                {sessionLabel(titles, sessionId, t)}
              </a>
              {isResidentIdleGroup ? (
                <span data-running-idle="true" className="flex-shrink-0 text-[10px] text-muted-foreground">
                  {t('running.idle', 'Idle')}
                </span>
              ) : (
                <span data-activity-label="true" className="flex flex-shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
                  {presented.phaseLabel ? <span className="truncate">{presented.phaseLabel}</span> : null}
                  {presented.elapsedLabel ? (
                    <span data-activity-elapsed-label="true" className="tabular-nums">
                      {presented.elapsedLabel}
                    </span>
                  ) : null}
                </span>
              )}
              {onClose ? (
                <button
                  type="button"
                  data-running-close="true"
                  // The visible word alone ("Close") is not a name a screen reader
                  // can attribute to a row, so the accessible name states which
                  // session the button belongs to. Both are shipped strings: the
                  // label is not assembled from the title in code.
                  aria-label={t('running.closeLabel', {
                    title: sessionLabel(titles, sessionId, t),
                    defaultValue: 'Close resident session {{title}}',
                  })}
                  onClick={() => onClose(sessionId)}
                  className="flex h-5 flex-shrink-0 items-center gap-0.5 rounded-md px-1 text-[10px] text-muted-foreground hover:bg-accent/80 hover:text-foreground"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                  {t('running.close', 'Close')}
                </button>
              ) : null}
            </div>
          );
        })
      )}
    </section>
  );
}
