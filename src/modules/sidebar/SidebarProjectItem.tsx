import { memo, useEffect, useRef } from 'react';
import type { MouseEvent } from 'react';
import { Check, ChevronDown, ChevronRight, Edit3, LayoutDashboard, ListFilter, Star, Trash2, X } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useHref, useInRouterContext } from 'react-router-dom';

import { Button } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { LLMProvider, MCPServerStatus, Project, ProjectSession, QuayFleetTaskCounts, SessionWithProvider } from '@/shared/types';
import { WatchPinToggle, cockpitViewPath, formatProjectUri } from '@/modules/cockpit';
import { getQuayIndicatorStatus, getTaskIndicatorStatus } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import TaskIndicator from '@/modules/sidebar/TaskIndicator';
import QuayIndicator from '@/modules/sidebar/QuayIndicator';
import SidebarProjectSessions from '@/modules/sidebar/SidebarProjectSessions';
import { useCompactSidebar } from '@/modules/sidebar/hooks/useCompactSidebar';
import { useFleetAttention } from '@/modules/sidebar/hooks/useFleetAttention';
import { useFleetTaskCounts } from '@/modules/sidebar/hooks/useFleetTaskCounts';

/**
 * Props for one project row. Exported for the module's tests, which render the real row
 * (rather than a stub) to assert the task-count badge in both sidebar layouts.
 */
export type SidebarProjectItemProps = {
  project: Project;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isExpanded: boolean;
  isDeleting: boolean;
  isStarred: boolean;
  /** Resolved for this row: only the project being renamed re-renders on a keystroke. */
  isEditing: boolean;
  renameDraft: string;
  sessions: SessionWithProvider[];
  initialSessionsLoaded: boolean;
  isLoadingMoreSessions: boolean;
  currentTime: Date;
  /** The session being renamed, when it belongs to this project. */
  sessionRenameId: string | null;
  sessionRenameDraft: string;
  tasksEnabled: boolean;
  mcpServerStatus: MCPServerStatus;
  onRenameDraftChange: (name: string) => void;
  onToggleProject: (projectId: string) => void;
  onProjectSelect: (project: Project) => void;
  onToggleStarProject: (projectId: string) => void;
  onStartEditingProject: (project: Project) => void;
  onCancelEditingProject: () => void;
  onSaveProjectName: (projectId: string, nextName: string) => void;
  onDeleteProject: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (sessionId: string, sessionTitle: string) => void;
  onForkSession?: (session: SessionWithProvider) => void;
  onLoadMoreSessions: (projectId: string) => void;
  activeSessions: ReadonlySet<string>;
  attentionSessionIds: ReadonlySet<string>;
  onNewSession: (project: Project) => void;
  /** Resolved for this row so toggling one project's flag leaves other rows' memo boundary intact. */
  isShowingHiddenSessions: boolean;
  onToggleShowHidden?: (projectId: string) => void;
  onEditSessionFilter?: (project: Project, seedSessionName?: string) => void;
  onStartEditingSession: (projectId: string, sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  t: TFunction;
};

const getSessionCountDisplay = (project: Project, sessions: SessionWithProvider[]): string => {
  const total = Number(project.sessionMeta?.total ?? sessions.length);
  return String(total);
};

type CockpitProjectLinkProps = {
  /** The project's quay-fleet registry id — the project segment this board link addresses. */
  fleetProjectId: string;
  /** Compact-card sizing (`h-8 w-8`) versus the desktop row's `h-6 w-6`. */
  compact: boolean;
  label: string;
  onNavigate: (event: MouseEvent<HTMLAnchorElement>) => void;
  /** Layout-only additions; the desktop row reveals its action group on hover. */
  className?: string;
};

/** The anchor itself, shared by the routed and plain branches so the two cannot drift. */
function CockpitProjectAnchor({
  href,
  fleetProjectId,
  compact,
  label,
  onNavigate,
  className,
}: CockpitProjectLinkProps & { href: string }) {
  return (
    <a
      href={href}
      onClick={onNavigate}
      title={label}
      aria-label={label}
      data-testid="cockpit-project-link"
      data-cockpit-project={fleetProjectId}
      className={cn(
        'flex items-center justify-center rounded border border-border bg-muted/30 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
        compact ? 'h-8 w-8 rounded-lg' : 'h-6 w-6',
        className,
      )}
    >
      <LayoutDashboard className={compact ? 'h-4 w-4' : 'h-3 w-3'} aria-hidden />
    </a>
  );
}

function RoutedCockpitProjectLink(props: CockpitProjectLinkProps) {
  const href = useHref(
    cockpitViewPath({ type: 'board', project: props.fleetProjectId }),
  );
  return <CockpitProjectAnchor {...props} href={href} />;
}

/**
 * 「在驾驶舱中查看」 for one row: a real link to the project's board, shown only when
 * quay-fleet registers the project (an unregistered project has no addressable board).
 * Split from the row because `useHref` needs a router, and the row is also rendered in unit
 * tests that mount no router.
 */
function CockpitProjectLink(props: CockpitProjectLinkProps) {
  const inRouter = useInRouterContext();
  return inRouter ? (
    <RoutedCockpitProjectLink {...props} />
  ) : (
    <CockpitProjectAnchor
      {...props}
      href={cockpitViewPath({ type: 'board', project: props.fleetProjectId })}
    />
  );
}

/**
 * A project row's task badge: the todo / ready / needs-human counts from the shared
 * fleet summary. Defined here because `SidebarProjectItem` is its only consumer. The
 * `data-*` attributes carry exactly the numbers the chips show, so a test can compare
 * the rendered row with the endpoint's reading instead of parsing styled text.
 */
function ProjectTaskCountsBadge({ counts, className }: { counts: QuayFleetTaskCounts; className?: string }) {
  const label = `${counts.todo} todo, ${counts.ready} ready, ${counts.needsHuman} needs-human`;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1 py-0.5 text-[10px] leading-none tabular-nums text-muted-foreground',
        className,
      )}
      data-project-task-counts=""
      data-task-todo={counts.todo}
      data-task-ready={counts.ready}
      data-task-needs-human={counts.needsHuman}
      aria-label={label}
      title={label}
    >
      <span className="inline-flex items-center gap-0.5">
        <span className="h-1.5 w-1.5 rounded-full bg-gray-400 dark:bg-gray-500" aria-hidden />
        {counts.todo}
      </span>
      <span className="inline-flex items-center gap-0.5">
        <span className="h-1.5 w-1.5 rounded-full bg-blue-500 dark:bg-blue-400" aria-hidden />
        {counts.ready}
      </span>
      <span className="inline-flex items-center gap-0.5">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500 dark:bg-amber-400" aria-hidden />
        {counts.needsHuman}
      </span>
    </span>
  );
}

/** Rendered by SidebarProjectList for one project row, including its expand, rename, star and delete controls. */
function SidebarProjectItem({
  project,
  selectedProject,
  selectedSession,
  isExpanded,
  isDeleting,
  isStarred,
  isEditing,
  renameDraft,
  sessions,
  initialSessionsLoaded,
  isLoadingMoreSessions,
  currentTime,
  sessionRenameId,
  sessionRenameDraft,
  tasksEnabled,
  mcpServerStatus,
  onRenameDraftChange,
  onToggleProject,
  onProjectSelect,
  onToggleStarProject,
  onStartEditingProject,
  onCancelEditingProject,
  onSaveProjectName,
  onDeleteProject,
  onSessionSelect,
  onDeleteSession,
  onForkSession,
  onLoadMoreSessions,
  activeSessions,
  attentionSessionIds,
  onNewSession,
  isShowingHiddenSessions,
  onToggleShowHidden,
  onEditSessionFilter,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  t,
}: SidebarProjectItemProps) {
  // Project identity is tracked by the DB-assigned `projectId` everywhere
  // after the projectName → projectId migration.
  const isSelected = selectedProject?.projectId === project.projectId;
  const totalSessionCount = Number(project.sessionMeta?.total ?? sessions.length);
  const sessionCountDisplay = getSessionCountDisplay(project, sessions);
  const sessionCountLabel = `${sessionCountDisplay} session${totalSessionCount === 1 ? '' : 's'}`;
  const taskStatus = getTaskIndicatorStatus(project, mcpServerStatus);
  const quayStatus = getQuayIndicatorStatus(project, null);
  // Task counts come from the shared fleet summary. Non-quay projects never render the
  // badge, so their row is unchanged even though the shared read covers the whole fleet.
  const fleetTaskCounts = useFleetTaskCounts(project.projectId);
  const showTaskCounts = Boolean(project.hasQuayConfig) && fleetTaskCounts !== null;
  // The fleet registry id is the ONLY handle a cockpit board link can be built from; an
  // unregistered project has none, so the action is absent rather than pointing nowhere.
  const attention = useFleetAttention();
  const fleetProjectId = attention.fleetProjectIdByProject.get(project.projectId) ?? null;
  const cockpitLinkLabel = t('common:cockpit.openProject', 'View in cockpit');
  const mobileRenameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isEditing || !mobileRenameInputRef.current) {
      return;
    }

    let animationFrame = 0;
    const revealInput = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        mobileRenameInputRef.current?.scrollIntoView({ block: 'center', inline: 'nearest' });
      });
    };

    revealInput();
    window.visualViewport?.addEventListener('resize', revealInput);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.visualViewport?.removeEventListener('resize', revealInput);
    };
  }, [isEditing]);

  const isCompact = useCompactSidebar();

  const toggleProject = () => onToggleProject(project.projectId);
  const toggleStarProject = () => onToggleStarProject(project.projectId);

  const saveProjectName = () => {
    onSaveProjectName(project.projectId, renameDraft);
  };

  const selectAndToggleProject = () => {
    if (selectedProject?.projectId !== project.projectId) {
      onProjectSelect(project);
    }

    toggleProject();
  };

  return (
    <div className={cn('md:space-y-1', isDeleting && 'opacity-50 pointer-events-none')}>
      <div className="sticky top-0 z-10 md:group group">
        {isCompact && (
        <div className="bg-background">
          <div
            className={cn(
              'p-3 mx-3 my-1 rounded-lg bg-card border border-border/50 active:scale-[0.98] transition-all duration-150',
              isSelected && 'bg-primary/5 border-primary/20',
              isStarred &&
                !isSelected &&
                'bg-yellow-50/50 dark:bg-yellow-900/5 border-yellow-200/30 dark:border-yellow-800/30',
            )}
            onClick={toggleProject}
          >
            <div className="flex items-center justify-between">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <button
                  className={cn(
                    'w-8 h-8 rounded-lg flex items-center justify-center active:scale-90 transition-all duration-150 border',
                    isStarred
                      ? 'bg-yellow-500/10 dark:bg-yellow-900/30 border-yellow-200 dark:border-yellow-800'
                      : 'bg-gray-500/10 dark:bg-gray-900/30 border-gray-200 dark:border-gray-800',
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleStarProject();
                  }}
                  title={isStarred ? t('tooltips.removeFromFavorites') : t('tooltips.addToFavorites')}
                >
                  <Star
                    className={cn(
                      'w-4 h-4 transition-colors',
                      isStarred
                        ? 'text-yellow-600 dark:text-yellow-400 fill-current'
                        : 'text-gray-600 dark:text-gray-400',
                    )}
                  />
                </button>

                <div className="min-w-0 flex-1">
                  {isEditing ? (
                    <input
                      ref={mobileRenameInputRef}
                      type="text"
                      value={renameDraft}
                      onChange={(event) => onRenameDraftChange(event.target.value)}
                      className="w-full rounded-lg border-2 border-primary/40 bg-background px-3 py-2 text-sm text-foreground shadow-sm transition-all duration-200 focus:border-primary focus:shadow-md focus:outline-none"
                      placeholder={t('projects.projectNamePlaceholder')}
                      autoFocus
                      autoComplete="off"
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          saveProjectName();
                        }

                        if (event.key === 'Escape') {
                          onCancelEditingProject();
                        }
                      }}
                      style={{
                        fontSize: '16px',
                        WebkitAppearance: 'none',
                        borderRadius: '8px',
                      }}
                    />
                  ) : (
                    <>
                      <div className="flex min-w-0 flex-1 items-center justify-between">
                        <h3 className="truncate text-sm font-normal text-foreground">{project.displayName}</h3>
                        <div className="ml-2 flex flex-shrink-0 items-center gap-1">
                          {showTaskCounts && fleetTaskCounts && (
                            <ProjectTaskCountsBadge counts={fleetTaskCounts} />
                          )}
                          <QuayIndicator
                            hasQuayConfig={Boolean(project.hasQuayConfig)}
                            status={quayStatus}
                            size="xs"
                          />
                          {tasksEnabled && (
                            <TaskIndicator
                              status={taskStatus}
                              size="xs"
                              className="hidden md:inline-flex"
                            />
                          )}
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">{sessionCountLabel}</p>
                    </>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-1">
                {isEditing ? (
                  <>
                    <button
                      className="flex h-8 w-8 items-center justify-center rounded-lg bg-green-500 shadow-sm transition-all duration-150 active:scale-90 active:shadow-none dark:bg-green-600"
                      onClick={(event) => {
                        event.stopPropagation();
                        saveProjectName();
                      }}
                    >
                      <Check className="h-4 w-4 text-white" />
                    </button>
                    <button
                      className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-500 shadow-sm transition-all duration-150 active:scale-90 active:shadow-none dark:bg-gray-600"
                      onClick={(event) => {
                        event.stopPropagation();
                        onCancelEditingProject();
                      }}
                    >
                      <X className="h-4 w-4 text-white" />
                    </button>
                  </>
                ) : (
                  <>
                    {fleetProjectId !== null && (
                      <WatchPinToggle
                        uri={formatProjectUri(fleetProjectId)}
                        testId="cockpit-project-watch-toggle"
                      />
                    )}
                    {fleetProjectId !== null && (
                      <CockpitProjectLink
                        compact
                        fleetProjectId={fleetProjectId}
                        label={cockpitLinkLabel}
                        onNavigate={(event) => event.stopPropagation()}
                      />
                    )}
                    <button
                      className="flex h-8 w-8 items-center justify-center rounded-lg border border-red-200 bg-red-500/10 active:scale-90 dark:border-red-800 dark:bg-red-900/30"
                      onClick={(event) => {
                        event.stopPropagation();
                        onDeleteProject(project);
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-red-600 dark:text-red-400" />
                    </button>

                    {onEditSessionFilter && (
                      <button
                        className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-muted/30 active:scale-90"
                        onClick={(event) => {
                          event.stopPropagation();
                          onEditSessionFilter(project);
                        }}
                        title={t('sessionFilter.menuItem')}
                      >
                        <ListFilter className="h-4 w-4 text-muted-foreground" />
                      </button>
                    )}

                    <button
                      className="flex h-8 w-8 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 active:scale-90 dark:border-primary/30 dark:bg-primary/20"
                      onClick={(event) => {
                        event.stopPropagation();
                        onStartEditingProject(project);
                      }}
                    >
                      <Edit3 className="h-4 w-4 text-primary" />
                    </button>

                    <div className="flex h-6 w-6 items-center justify-center rounded-md bg-muted/30">
                      {isExpanded ? (
                        <ChevronDown className="h-3 w-3 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-3 w-3 text-muted-foreground" />
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
        )}

        {!isCompact && (
        <Button
          variant="ghost"
          className={cn(
            'sticky top-0 z-10 flex w-full justify-between p-2 h-auto font-normal hover:bg-accent/50',
            isSelected
              ? 'bg-accent text-accent-foreground'
              : isStarred
                ? 'bg-background hover:bg-accent/50'
                : 'bg-background',
            isStarred &&
              !isSelected &&
              'bg-yellow-50/50 dark:bg-yellow-900/10 hover:bg-yellow-100/50 dark:hover:bg-yellow-900/20',
          )}
          onClick={selectAndToggleProject}
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div
              className={cn(
                'w-6 h-6 flex items-center justify-center rounded cursor-pointer transition-all duration-200',
                isStarred
                  ? 'hover:bg-yellow-50 dark:hover:bg-yellow-900/20'
                  : 'opacity-40 hover:opacity-100 hover:bg-accent',
              )}
              onClick={(event) => {
                event.stopPropagation();
                toggleStarProject();
              }}
              title={isStarred ? t('tooltips.removeFromFavorites') : t('tooltips.addToFavorites')}
            >
              <Star
                className={cn(
                  'w-3 h-3 transition-colors',
                  isStarred
                    ? 'text-yellow-600 dark:text-yellow-400 fill-current'
                    : 'text-muted-foreground',
                )}
              />
            </div>
            <div className="min-w-0 flex-1 text-left">
              {isEditing ? (
                <div className="space-y-1">
                  <input
                    type="text"
                    value={renameDraft}
                    onChange={(event) => onRenameDraftChange(event.target.value)}
                    className="w-full rounded border border-border bg-background px-2 py-1 text-sm text-foreground focus:ring-2 focus:ring-primary/20"
                    placeholder={t('projects.projectNamePlaceholder')}
                    autoFocus
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        saveProjectName();
                      }
                      if (event.key === 'Escape') {
                        onCancelEditingProject();
                      }
                    }}
                  />
                  <div className="truncate text-xs text-muted-foreground" title={project.fullPath}>
                    {project.fullPath}
                  </div>
                </div>
              ) : (
                <div>
                  <div className="flex min-w-0 items-center gap-1">
                    <span className="truncate text-sm font-normal text-foreground" title={project.displayName}>
                      {project.displayName}
                    </span>
                    <QuayIndicator
                      hasQuayConfig={Boolean(project.hasQuayConfig)}
                      status={quayStatus}
                      size="xs"
                      className="flex-shrink-0"
                    />
                    {showTaskCounts && fleetTaskCounts && (
                      <ProjectTaskCountsBadge counts={fleetTaskCounts} className="flex-shrink-0" />
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {sessionCountDisplay}
                    {project.fullPath !== project.displayName && (
                      <span className="ml-1 opacity-60" title={project.fullPath}>
                        {' - '}
                        {project.fullPath.length > 25 ? `...${project.fullPath.slice(-22)}` : project.fullPath}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-shrink-0 items-center gap-1">
            {isEditing ? (
              <>
                <div
                  className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-green-600 transition-colors hover:bg-green-50 hover:text-green-700 dark:hover:bg-green-900/20"
                  onClick={(event) => {
                    event.stopPropagation();
                    saveProjectName();
                  }}
                >
                  <Check className="h-3 w-3" />
                </div>
                <div
                  className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-700 dark:hover:bg-gray-800"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCancelEditingProject();
                  }}
                >
                  <X className="h-3 w-3" />
                </div>
              </>
            ) : (
              <>
                {onEditSessionFilter && (
                  <div
                    className="touch:opacity-100 flex h-6 w-6 cursor-pointer items-center justify-center rounded opacity-0 transition-all duration-200 hover:bg-accent group-hover:opacity-100"
                    onClick={(event) => {
                      event.stopPropagation();
                      onEditSessionFilter(project);
                    }}
                    title={t('sessionFilter.menuItem')}
                  >
                    <ListFilter className="h-3 w-3" />
                  </div>
                )}
                <div
                  className="touch:opacity-100 flex h-6 w-6 cursor-pointer items-center justify-center rounded opacity-0 transition-all duration-200 hover:bg-accent group-hover:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation();
                    onStartEditingProject(project);
                  }}
                  title={t('tooltips.renameProject')}
                >
                  <Edit3 className="h-3 w-3" />
                </div>
                {fleetProjectId !== null && (
                  <WatchPinToggle
                    uri={formatProjectUri(fleetProjectId)}
                    testId="cockpit-project-watch-toggle"
                    className="touch:opacity-100 opacity-0 transition-opacity group-hover:opacity-100"
                  />
                )}
                {fleetProjectId !== null && (
                  <CockpitProjectLink
                    compact={false}
                    fleetProjectId={fleetProjectId}
                    label={cockpitLinkLabel}
                    onNavigate={(event) => event.stopPropagation()}
                    className="touch:opacity-100 opacity-0 transition-opacity group-hover:opacity-100"
                  />
                )}
                <div
                  className="touch:opacity-100 flex h-6 w-6 cursor-pointer items-center justify-center rounded opacity-0 transition-all duration-200 hover:bg-red-50 group-hover:opacity-100 dark:hover:bg-red-900/20"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDeleteProject(project);
                  }}
                  title={t('tooltips.deleteProject')}
                >
                  <Trash2 className="h-3 w-3 text-red-600 dark:text-red-400" />
                </div>
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
                )}
              </>
            )}
          </div>
        </Button>
        )}
      </div>

      <SidebarProjectSessions
        project={project}
        isExpanded={isExpanded}
        sessions={sessions}
        selectedSession={selectedSession}
        initialSessionsLoaded={initialSessionsLoaded}
        hasMoreSessions={Boolean(project.sessionMeta?.hasMore)}
        isLoadingMoreSessions={isLoadingMoreSessions}
        activeSessions={activeSessions}
        attentionSessionIds={attentionSessionIds}
        currentTime={currentTime}
        sessionRenameId={sessionRenameId}
        sessionRenameDraft={sessionRenameDraft}
        onRenameDraftChange={onRenameDraftChange}
        onStartEditingSession={onStartEditingSession}
        onCancelEditingSession={onCancelEditingSession}
        onSaveEditingSession={onSaveEditingSession}
        onProjectSelect={onProjectSelect}
        onSessionSelect={onSessionSelect}
        onDeleteSession={onDeleteSession}
        onForkSession={onForkSession}
        onLoadMoreSessions={onLoadMoreSessions}
        onNewSession={onNewSession}
        isShowingHiddenSessions={isShowingHiddenSessions}
        onToggleShowHidden={onToggleShowHidden}
        onEditSessionFilter={onEditSessionFilter}
        t={t}
      />
    </div>
  );
}

/**
 * Memoized: a websocket session delta re-renders the sidebar roughly every
 * 0.5-2s during a run, and a rename keystroke re-renders it per character.
 *
 * Both renames are resolved to scalars by SidebarProjectList and the sorted
 * session array is cached per project, so a keystroke changes props on exactly
 * one row and every other row's compare succeeds. See sidebarRowProps.test.tsx.
 */
export default memo(SidebarProjectItem);
