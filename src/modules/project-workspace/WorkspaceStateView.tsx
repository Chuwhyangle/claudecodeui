import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Activity, Folder, History, ListChecks } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import MobileMenuButton from '@/modules/project-workspace/MobileMenuButton';
import {
  useRecentSessionEndings,
  type RecentSessionEnding,
  type RecentTerminalState,
} from '@/modules/project-workspace/hooks/useRecentSessionEndings';
import { useFleetSummary, type FleetProjectSummary, type FleetSummaryView } from '@/modules/project-workspace/hooks/useFleetSummary';
import { presentSessionActivity, useTickingNow } from '@/modules/sidebar';
import { useProcessingSessions } from '@/shared/context/SessionProtectionContext';
import type { Project, SessionActivity } from '@/shared/types';

/**
 * The landing overview: what the app shows when no project is selected.
 *
 * Before this view existed the whole main region was one "Choose Your Project"
 * card, so the largest surface on the page said nothing about the work in
 * flight. The overview keeps the sidebar as the way in and puts the three
 * readings a person actually leaves a session to check side by side (SPEC §7,
 * §9 P3):
 *
 *  1. **Running** — every running session across every project, with the same
 *     `phase`/`tool`/`elapsed` reading the sidebar rows draw (P1's reduction,
 *     imported rather than re-implemented so the two surfaces cannot drift).
 *  2. **Recently ended** — turns that just ended, carrying the terminal taxonomy
 *     the server's `resident-ledger/terminal-state.ts` defines, folded from the
 *     delivery projection the activity frames already carry.
 *  3. **Task · goal** — the eager cross-project quay counts (`fleet-summary`).
 *
 * Desktop draws the three panels side by side. Mobile draws the same three
 * panels as snap-scrolled pages under a pulse bar that names them and counts
 * what each holds; the reading and the markup of a panel are identical in both,
 * so a viewport changes the layout and nothing else.
 */
type WorkspaceStateViewProps = {
  mode: 'loading' | 'empty';
  isMobile: boolean;
  onMenuClick: () => void;
  /** The whole sidebar listing, so the overview can name a session's project. */
  projects: Project[];
};

/** Where one session sits in the project listing, for the overview's headings. */
type SessionRef = {
  projectId: string;
  projectName: string;
  title: string;
};

/** The three pages/panels, in the order both layouts draw them. */
const PAGES = [
  { key: 'running', icon: Activity },
  { key: 'ended', icon: History },
  { key: 'tasks', icon: ListChecks },
] as const;

type LandingPageKey = (typeof PAGES)[number]['key'];

/** The bucket an activity entry with no project row is grouped under. */
const UNKNOWN_PROJECT = '__unknown-project__';

/** How many ended entries the panel draws; the hook keeps a slightly longer list. */
const ENDED_VISIBLE = 8;

/** The colour treatment of each terminal state, kept here so the badge and its dot agree. */
const TERMINAL_BADGE: Record<RecentTerminalState, string> = {
  success: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  error: 'bg-red-500/10 text-red-600 dark:text-red-400',
  'needs-human': 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  interrupted: 'bg-orange-500/10 text-orange-600 dark:text-orange-400',
  timeout: 'bg-slate-500/10 text-slate-600 dark:text-slate-400',
};

/**
 * The label for one terminal state.
 *
 * The keys are new to this surface; the English words are stated as defaults so
 * a locale that has not translated them still reads truthfully rather than
 * falling back to a key name.
 */
function terminalLabel(state: RecentTerminalState, t: TFunction): string {
  switch (state) {
    case 'success':
      return t('landing.terminal.success', 'Success');
    case 'error':
      return t('landing.terminal.error', 'Error');
    case 'needs-human':
      return t('landing.terminal.needsHuman', 'Needs human');
    case 'interrupted':
      return t('landing.terminal.interrupted', 'Interrupted');
    case 'timeout':
      return t('landing.terminal.timeout', 'Timed out');
  }
}

/** Elapsed wording for a just-ended turn, from the ledger's own `endedAt`. */
function formatEndedAgo(endedAt: number, now: number, t: TFunction): string {
  const seconds = Math.max(0, Math.floor((now - endedAt) / 1000));
  if (seconds < 60) {
    return t('landing.ended.justNow', 'just now');
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return t('landing.ended.minutesAgo', { count: minutes, defaultValue: '{{count}}m ago' });
  }
  const hours = Math.floor(minutes / 60);
  return t('landing.ended.hoursAgo', { count: hours, defaultValue: '{{count}}h ago' });
}

/** The session's own name, or its id when the listing has no title yet. */
function sessionTitle(session: { summary?: string; title?: string; name?: string; id: string }): string {
  const named = session.summary?.trim() || session.title?.trim() || session.name?.trim();
  return named || session.id;
}

/** A project's name from the listing, or a stable fallback for a row the listing does not name. */
function projectNameFor(projects: Project[], projectId: string, t: TFunction): string {
  const named = projects.find((project) => project.projectId === projectId)?.displayName?.trim();
  return named || t('landing.unknownProject', 'Unknown project');
}

/** One panel's frame; both layouts draw the same section, only the container differs. */
function Panel({
  panel,
  title,
  icon,
  count,
  children,
}: {
  panel: LandingPageKey;
  title: string;
  icon: ReactNode;
  count: number;
  children: ReactNode;
}) {
  return (
    <section
      data-landing-panel={panel}
      data-landing-panel-count={count}
      className="flex h-full min-h-0 flex-col rounded-xl border border-border/60 bg-card/40 shadow-sm"
    >
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-border/50 px-3 py-2.5">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10 text-primary">{icon}</span>
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{title}</h2>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">{count}</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">{children}</div>
    </section>
  );
}

/** The hint a panel shows instead of rows when it has nothing to draw. */
function PanelEmpty({ children }: { children: ReactNode }) {
  return <p className="px-2 py-3 text-xs text-muted-foreground">{children}</p>;
}

/** One running session, drawn with P1's phase/tool/elapsed reduction. */
function RunningRow({
  sessionId,
  activity,
  sessionRef,
  now,
  tChat,
}: {
  sessionId: string;
  activity: SessionActivity;
  sessionRef: SessionRef | undefined;
  now: number;
  tChat: TFunction;
}) {
  const presented = presentSessionActivity(activity, now, tChat);

  return (
    <div
      data-landing-running-entry={sessionId}
      // The same three attributes a sidebar row publishes (P1), so a reader
      // outside the component can compare the two surfaces by the values rather
      // than by the words each chose to draw.
      data-activity-phase={presented.phase ?? undefined}
      {...(presented.phase === 'tool' ? { 'data-activity-tool': presented.toolName ?? '' } : {})}
      data-activity-elapsed={presented.elapsedMs ?? undefined}
      className="mb-1 rounded-lg border border-border/40 bg-background/40 px-2 py-1.5"
    >
      <div className="flex items-center gap-2">
        <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary" aria-hidden="true" />
        <p className="min-w-0 flex-1 truncate text-xs text-foreground">{sessionRef?.title ?? sessionId}</p>
      </div>
      <div className="mt-0.5 flex items-center gap-2 pl-3.5 text-[11px] text-muted-foreground">
        <span className="truncate">{presented.phaseLabel ?? tChat('claudeStatus.working', 'Working')}</span>
        {presented.elapsedLabel ? (
          <span data-activity-elapsed-label="true" className="flex-shrink-0 tabular-nums">{presented.elapsedLabel}</span>
        ) : null}
      </div>
    </div>
  );
}

/** One recently ended turn. */
function EndedRow({
  ending,
  sessionRef,
  now,
  t,
}: {
  ending: RecentSessionEnding;
  sessionRef: SessionRef | undefined;
  now: number;
  t: TFunction;
}) {
  return (
    <div
      data-landing-ended-entry={ending.sessionId}
      data-landing-ended-delivery={ending.deliveryId}
      data-terminal-state={ending.state}
      className="mb-1 rounded-lg border border-border/40 bg-background/40 px-2 py-1.5"
    >
      <div className="flex items-start gap-2">
        <span
          data-terminal-badge={ending.state}
          className={`mt-0.5 flex-shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${TERMINAL_BADGE[ending.state]}`}
        >
          {terminalLabel(ending.state, t)}
        </span>
        <p className="min-w-0 flex-1 truncate text-xs text-foreground">{sessionRef?.title ?? ending.sessionId}</p>
      </div>
      <div className="mt-0.5 flex items-center gap-2 pl-0.5 text-[11px] text-muted-foreground">
        <span className="truncate">{sessionRef?.projectName ?? t('landing.unknownProject', 'Unknown project')}</span>
        <span className="flex-shrink-0 tabular-nums">{formatEndedAgo(ending.endedAt, now, t)}</span>
      </div>
    </div>
  );
}

/** One quay project's task/goal counts. */
function FleetRow({
  project,
  projectName,
  t,
}: {
  project: FleetProjectSummary;
  projectName: string;
  t: TFunction;
}) {
  const badges = [
    { key: 'todo', label: t('landing.tasks.todo', 'Todo'), value: project.tasks.todo, className: 'bg-slate-500/10 text-slate-600 dark:text-slate-400' },
    { key: 'ready', label: t('landing.tasks.ready', 'Ready'), value: project.tasks.ready, className: 'bg-blue-500/10 text-blue-600 dark:text-blue-400' },
    { key: 'needsHuman', label: t('landing.tasks.needsHuman', 'Needs human'), value: project.tasks.needsHuman, className: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' },
    { key: 'done', label: t('landing.tasks.done', 'Done'), value: project.tasks.done, className: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
  ];

  return (
    <div
      data-fleet-project={project.projectId}
      data-task-total={project.tasks.total}
      data-task-todo={project.tasks.todo}
      data-task-ready={project.tasks.ready}
      data-task-needs-human={project.tasks.needsHuman}
      data-task-done={project.tasks.done}
      data-goal-total={project.goals.total}
      data-goal-active={project.goals.active}
      data-goal-achieved={project.goals.achieved}
      className="mb-1 rounded-lg border border-border/40 bg-background/40 px-2 py-1.5"
    >
      <div className="flex items-center gap-2">
        <Folder className="h-3 w-3 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
        <p className="min-w-0 flex-1 truncate text-xs text-foreground">{projectName}</p>
        {project.driverState ? (
          <span className="flex-shrink-0 text-[10px] text-muted-foreground">{project.driverState}</span>
        ) : null}
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {badges.map((badge) => (
          <span
            key={badge.key}
            data-task-badge={badge.key}
            className={`rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${badge.className}`}
          >
            {badge.label} {badge.value}
          </span>
        ))}
        <span
          data-goal-badge="active"
          className="rounded-full bg-violet-500/10 px-1.5 py-0.5 text-[10px] tabular-nums text-violet-600 dark:text-violet-400"
        >
          {t('landing.tasks.goalsActive', 'Goals')} {project.goals.active}/{project.goals.total}
        </span>
        <span
          data-goal-badge="achieved"
          className="rounded-full bg-teal-500/10 px-1.5 py-0.5 text-[10px] tabular-nums text-teal-600 dark:text-teal-400"
        >
          {t('landing.tasks.goalsAchieved', 'Achieved')} {project.goals.achieved}
        </span>
      </div>
    </div>
  );
}

/** The three readings, built once and handed to whichever layout is drawing them. */
type OverviewPanels = {
  runningCount: number;
  endedCount: number;
  tasksCount: number;
  running: ReactNode;
  ended: ReactNode;
  tasks: ReactNode;
};

/** Rendered by WorkspaceMain instead of the workspace while projects load or when none is selected. */
export default function WorkspaceStateView({ mode, isMobile, onMenuClick, projects }: WorkspaceStateViewProps) {
  const { t } = useTranslation();
  const { t: tChat } = useTranslation('chat');

  // The running side is the page's one activity reading (P1): the same map the
  // sidebar and the dock draw, so a session cannot be running in one place and
  // absent here.
  const activities = useProcessingSessions();
  // The ended side is folded from the same activity frames' delivery projection.
  const endings = useRecentSessionEndings();
  // The clock ticks while either panel has something time-shaped to draw.
  const now = useTickingNow(activities.size > 0 || endings.length > 0);
  const fleet = useFleetSummary();

  const sessionIndex = useMemo(() => {
    const index = new Map<string, SessionRef>();
    for (const project of projects) {
      for (const session of project.sessions ?? []) {
        index.set(String(session.id), {
          projectId: project.projectId,
          projectName: project.displayName,
          title: sessionTitle(session as { summary?: string; title?: string; name?: string; id: string }),
        });
      }
    }
    return index;
  }, [projects]);

  const runningGroups = useMemo(() => {
    type Group = { projectId: string; entries: Array<{ sessionId: string; activity: SessionActivity }> };
    const groups = new Map<string, Group>();
    const add = (projectId: string, sessionId: string, activity: SessionActivity) => {
      const existing = groups.get(projectId);
      if (existing) {
        existing.entries.push({ sessionId, activity });
      } else {
        groups.set(projectId, { projectId, entries: [{ sessionId, activity }] });
      }
    };

    // Project order first, so the headings follow the sidebar; a running session
    // whose project row is not loaded yet is grouped under the unknown bucket
    // rather than dropped.
    for (const project of projects) {
      for (const session of project.sessions ?? []) {
        const sessionId = String(session.id);
        const activity = activities.get(sessionId);
        if (activity) {
          add(project.projectId, sessionId, activity);
        }
      }
    }
    for (const [sessionId, activity] of activities) {
      if (!sessionIndex.has(sessionId)) {
        add(UNKNOWN_PROJECT, sessionId, activity);
      }
    }

    for (const group of groups.values()) {
      group.entries.sort((left, right) => right.activity.startedAt - left.activity.startedAt);
    }
    return [...groups.values()];
  }, [activities, projects, sessionIndex]);

  const endedEntries = useMemo(
    () => endings.slice(0, ENDED_VISIBLE).map((ending) => ({
      ending,
      sessionRef: sessionIndex.get(ending.sessionId),
    })),
    [endings, sessionIndex],
  );

  const panels = useMemo<OverviewPanels>(() => {
    const runningCount = activities.size;

    const running = (
      <>
        {runningGroups.length === 0 ? (
          <PanelEmpty>{t('landing.running.empty', 'Nothing is running right now.')}</PanelEmpty>
        ) : (
          runningGroups.map((group) => (
            <div key={group.projectId} data-landing-running-project={group.projectId} className="mb-2">
              <p className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {group.projectId === UNKNOWN_PROJECT
                  ? t('landing.unknownProject', 'Unknown project')
                  : projectNameFor(projects, group.projectId, t)}
              </p>
              {group.entries.map(({ sessionId, activity }) => (
                <RunningRow
                  key={sessionId}
                  sessionId={sessionId}
                  activity={activity}
                  sessionRef={sessionIndex.get(sessionId)}
                  now={now}
                  tChat={tChat}
                />
              ))}
            </div>
          ))
        )}
      </>
    );

    const ended = (
      <>
        {endedEntries.length === 0 ? (
          <PanelEmpty>{t('landing.ended.empty', 'No session has ended since this page opened.')}</PanelEmpty>
        ) : (
          endedEntries.map(({ ending, sessionRef }) => (
            <EndedRow key={ending.key} ending={ending} sessionRef={sessionRef} now={now} t={t} />
          ))
        )}
      </>
    );

    const tasks = <TasksPanelContent fleet={fleet} projects={projects} t={t} />;

    return {
      runningCount,
      endedCount: endings.length,
      tasksCount: fleet.status === 'loaded' ? fleet.projects.length : 0,
      running,
      ended,
      tasks,
    };
  }, [activities.size, endedEntries, endings.length, fleet, now, projects, runningGroups, sessionIndex, t, tChat]);

  const isLoading = mode === 'loading';

  if (isLoading) {
    return (
      <div className="flex h-full flex-col">
        {isMobile && (
          <div className="pwa-header-safe flex-shrink-0 border-b border-border/50 bg-background/80 p-2 backdrop-blur-sm sm:p-3">
            <MobileMenuButton onMenuClick={onMenuClick} compact />
          </div>
        )}
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center text-muted-foreground">
            <div className="mx-auto mb-4 h-10 w-10">
              <div
                className="h-full w-full rounded-full border-[3px] border-muted border-t-primary"
                style={{
                  animation: 'spin 1s linear infinite',
                  WebkitAnimation: 'spin 1s linear infinite',
                  MozAnimation: 'spin 1s linear infinite',
                }}
              />
            </div>
            <h2 className="mb-1 text-lg font-semibold text-foreground">{t('mainContent.loading')}</h2>
            <p className="text-sm">{t('mainContent.settingUpWorkspace')}</p>
          </div>
        </div>
      </div>
    );
  }

  return isMobile
    ? <MobileOverview panels={panels} onMenuClick={onMenuClick} />
    : <DesktopOverview panels={panels} />;
}

/** The desktop arm: three panels side by side. */
function DesktopOverview({ panels }: { panels: OverviewPanels }) {
  const { t } = useTranslation();

  return (
    <div data-landing-overview="desktop" className="flex h-full flex-col">
      <header className="flex flex-shrink-0 items-end justify-between gap-4 border-b border-border/50 px-6 py-4">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-foreground">{t('landing.title', 'Fleet overview')}</h1>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {t('landing.subtitle', 'Everything in flight across your projects, without opening one.')}
          </p>
        </div>
        <p className="flex-shrink-0 text-xs text-muted-foreground">
          {t('landing.selectHint', 'Select a project from the sidebar to open a session.')}
        </p>
      </header>
      <div data-landing-panels="desktop" className="grid min-h-0 flex-1 grid-cols-3 gap-4 overflow-hidden p-6">
        <Panel panel="running" title={t('landing.panel.running', 'Running')} icon={<Activity className="h-3.5 w-3.5" aria-hidden="true" />} count={panels.runningCount}>
          {panels.running}
        </Panel>
        <Panel panel="ended" title={t('landing.panel.ended', 'Recently ended')} icon={<History className="h-3.5 w-3.5" aria-hidden="true" />} count={panels.endedCount}>
          {panels.ended}
        </Panel>
        <Panel panel="tasks" title={t('landing.panel.tasks', 'Task · goal')} icon={<ListChecks className="h-3.5 w-3.5" aria-hidden="true" />} count={panels.tasksCount}>
          {panels.tasks}
        </Panel>
      </div>
    </div>
  );
}

/**
 * The mobile arm: the pulse bar plus three snap-scrolled pages.
 *
 * The bar is both the reading and the control: each tab states what its page
 * holds (the same totals the panels report), and pressing one scrolls that page
 * into view. Swiping updates the active tab from the scroll position, so the two
 * ways of changing page never disagree about which one is on screen.
 */
function MobileOverview({ panels, onMenuClick }: { panels: OverviewPanels; onMenuClick: () => void }) {
  const { t } = useTranslation();
  const [activePage, setActivePage] = useState<LandingPageKey>('running');
  const pagesRef = useRef<HTMLDivElement | null>(null);

  const counts: Record<LandingPageKey, number> = {
    running: panels.runningCount,
    ended: panels.endedCount,
    tasks: panels.tasksCount,
  };
  const titles: Record<LandingPageKey, string> = {
    running: t('landing.panel.running', 'Running'),
    ended: t('landing.panel.ended', 'Recently ended'),
    tasks: t('landing.panel.tasks', 'Task · goal'),
  };

  const goToPage = (page: LandingPageKey, index: number) => {
    setActivePage(page);
    const element = pagesRef.current;
    if (element && typeof element.scrollTo === 'function') {
      element.scrollTo({ left: index * element.clientWidth, behavior: 'smooth' });
    }
  };

  // `clientWidth` is zero under jsdom and before layout; the guard keeps a
  // divide-by-zero from choosing a page nobody swiped to.
  const handleScroll = () => {
    const element = pagesRef.current;
    if (!element || element.clientWidth === 0) {
      return;
    }
    const index = Math.min(PAGES.length - 1, Math.max(0, Math.round(element.scrollLeft / element.clientWidth)));
    setActivePage(PAGES[index].key);
  };

  return (
    <div data-landing-overview="mobile" className="flex h-full flex-col">
      <div className="pwa-header-safe flex flex-shrink-0 items-center gap-2 border-b border-border/50 bg-background/80 px-2 py-2 backdrop-blur-sm">
        <MobileMenuButton onMenuClick={onMenuClick} compact />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold text-foreground">{t('landing.title', 'Fleet overview')}</h1>
        </div>
      </div>

      <div data-landing-pulse className="flex flex-shrink-0 gap-1 border-b border-border/50 px-2 py-1.5">
        {PAGES.map((page, index) => {
          const Icon = page.icon;
          const selected = activePage === page.key;
          return (
            <button
              key={page.key}
              type="button"
              data-landing-tab={page.key}
              data-landing-pulse-count={counts[page.key]}
              aria-selected={selected}
              onClick={() => goToPage(page.key, index)}
              className={`flex min-w-0 flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-[11px] transition-colors ${
                selected ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent/60'
              }`}
            >
              <Icon className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
              <span className="truncate">{titles[page.key]}</span>
              {counts[page.key] > 0 ? (
                <span className="flex-shrink-0 rounded-full bg-muted px-1.5 text-[10px] tabular-nums">{counts[page.key]}</span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div
        ref={pagesRef}
        data-landing-pages
        data-active-page={activePage}
        onScroll={handleScroll}
        className="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden"
      >
        <div data-landing-page="running" className="h-full w-full flex-shrink-0 snap-center p-2">
          <Panel panel="running" title={titles.running} icon={<Activity className="h-3.5 w-3.5" aria-hidden="true" />} count={panels.runningCount}>
            {panels.running}
          </Panel>
        </div>
        <div data-landing-page="ended" className="h-full w-full flex-shrink-0 snap-center p-2">
          <Panel panel="ended" title={titles.ended} icon={<History className="h-3.5 w-3.5" aria-hidden="true" />} count={panels.endedCount}>
            {panels.ended}
          </Panel>
        </div>
        <div data-landing-page="tasks" className="h-full w-full flex-shrink-0 snap-center p-2">
          <Panel panel="tasks" title={titles.tasks} icon={<ListChecks className="h-3.5 w-3.5" aria-hidden="true" />} count={panels.tasksCount}>
            {panels.tasks}
          </Panel>
        </div>
      </div>
    </div>
  );
}

/** The task·goal panel body: one row per quay project, or the state of the reading. */
function TasksPanelContent({
  fleet,
  projects,
  t,
}: {
  fleet: FleetSummaryView;
  projects: Project[];
  t: TFunction;
}) {
  if (fleet.status === 'loading') {
    return <PanelEmpty>{t('landing.tasks.loading', 'Reading task and goal counts…')}</PanelEmpty>;
  }

  if (fleet.status === 'unavailable') {
    return (
      <PanelEmpty>
        {t('landing.tasks.unavailable', 'Task and goal counts are unavailable right now.')}
      </PanelEmpty>
    );
  }

  if (fleet.projects.length === 0) {
    return <PanelEmpty>{t('landing.tasks.empty', 'No quay-configured project was reported.')}</PanelEmpty>;
  }

  return (
    <>
      {fleet.projects.map((project) => (
        <FleetRow
          key={project.projectId}
          project={project}
          projectName={
            projects.find((candidate) => candidate.projectId === project.projectId)?.displayName
              ?? project.projectPath?.split('/').filter(Boolean).at(-1)
              ?? project.projectId
          }
          t={t}
        />
      ))}
    </>
  );
}
