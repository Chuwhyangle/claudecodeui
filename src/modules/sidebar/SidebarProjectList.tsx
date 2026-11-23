import { useEffect, useState } from 'react';

import type { SidebarProjectListProps } from '@/shared/types';
import { getPageTitle } from '@/shared/utils';
import SidebarProjectItem from '@/modules/sidebar/SidebarProjectItem';
import SidebarProjectsState from '@/modules/sidebar/SidebarProjectsState';


/** Last path segment, for the "display name is not the folder name" disambiguation test. */
const lastPathSegment = (fullPath: string): string => {
  const segments = fullPath.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? fullPath;
};

/**
 * How many project rows mount by default. A workspace can hold hundreds of projects
 * (587 was measured live); every one of them was a DOM subtree, a memo comparison and a
 * `currentTime` update per minute. The window keeps that bounded without hiding the two
 * rows that carry state — selection and expansion are pinned below.
 */
export const PROJECT_LIST_RENDER_BUDGET = 50;

/** Rendered by SidebarContent to list the filtered projects, delegating each row to SidebarProjectItem. */
export default function SidebarProjectList({
  projects,
  filteredProjects,
  selectedProject,
  selectedSession,
  isLoading,
  loadingProgress,
  isProjectExpanded,
  activeRename,
  initialSessionsLoaded,
  currentTime,

  deletingProjects,
  tasksEnabled,
  mcpServerStatus,
  getProjectSessions,
  onLoadMoreSessions,
  loadingMoreProjects,
  activeSessions,
  attentionSessionIds,
  isProjectStarred,
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
  onReorderSessions,
  onForkSession,
  onNewSession,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  showHiddenProjectIds,
  onToggleShowHidden,
  onEditSessionFilter,
  t,
}: SidebarProjectListProps) {
  const pageTitle = getPageTitle(selectedProject, selectedSession);
  const state = (
    <SidebarProjectsState
      isLoading={isLoading}
      loadingProgress={loadingProgress}
      projectsCount={projects.length}
      filteredProjectsCount={filteredProjects.length}
      t={t}
    />
  );

  useEffect(() => {
    document.title = pageTitle;
  }, [pageTitle]);

  const showProjects = !isLoading && projects.length > 0 && filteredProjects.length > 0;

  // Cleared on every mount only; the expanded state of the list lives above, so a
  // filter or a refresh never has to reset this by hand.
  const [showAllProjects, setShowAllProjects] = useState(false);

  // A name filter is the user asking for exactly that set, so it must not be truncated:
  // a match that sorts past the ceiling would otherwise silently disappear. The length
  // comparison is the signal the list already has — `filteredProjects` is the filtered
  // projection of `projects`, so they only differ while a filter is narrowing the set.
  const isFilteringProjects = filteredProjects.length !== projects.length;

  // Selection and expansion carry state the user is looking at, so they are pinned even
  // when they sort past the window. Pinned rows claim their slots first; the rest of the
  // window is filled from the top, and the original order is preserved by filtering the
  // full list rather than concatenating two lists.
  const pinnedProjectIds = new Set<string>();
  if (selectedProject) {
    pinnedProjectIds.add(selectedProject.projectId);
  }
  for (const project of filteredProjects) {
    if (isProjectExpanded(project.projectId)) {
      pinnedProjectIds.add(project.projectId);
    }
  }

  const hasRenderBudget = !showAllProjects
    && !isFilteringProjects
    && filteredProjects.length > PROJECT_LIST_RENDER_BUDGET;

  let visibleProjects = filteredProjects;
  if (hasRenderBudget) {
    const keep = new Set<string>();
    for (const project of filteredProjects) {
      if (keep.size >= PROJECT_LIST_RENDER_BUDGET) {
        break;
      }
      if (pinnedProjectIds.has(project.projectId)) {
        keep.add(project.projectId);
      }
    }
    for (const project of filteredProjects) {
      if (keep.size >= PROJECT_LIST_RENDER_BUDGET) {
        break;
      }
      keep.add(project.projectId);
    }
    visibleProjects = filteredProjects.filter((project) => keep.has(project.projectId));
  }

  // The path is only worth a slot on the name line when it disambiguates: another rendered
  // project shares this display name, or the display name is not the path's last segment (a
  // renamed project). Computed once over the rendered set — the row never scans its siblings.
  // Only booleans are passed down, so re-rendering the list does not break a row's memo.
  const renderCountByName = new Map<string, number>();
  for (const project of visibleProjects) {
    renderCountByName.set(project.displayName, (renderCountByName.get(project.displayName) ?? 0) + 1);
  }
  const needsPathOnName = (project: (typeof filteredProjects)[number]): boolean =>
    (renderCountByName.get(project.displayName) ?? 0) > 1
    || lastPathSegment(project.fullPath) !== project.displayName;

  return (
      <div className="pb-safe-area-inset-bottom md:space-y-1">
        {!showProjects
          ? state
          : visibleProjects.map((project) => {
              // Both renames are resolved here rather than inside the row, so
              // every other row is handed the same scalars on each keystroke and
              // its memo boundary holds.
              const renamingProject =
                activeRename?.target === 'project' && activeRename.id === project.projectId
                  ? activeRename
                  : null;
              const renamingSession =
                activeRename?.target === 'session' && activeRename.projectId === project.projectId
                  ? activeRename
                  : null;

              // React key + per-project state lookups all use the DB `projectId`
              // so they remain stable across renames and session changes.
              return (
              <SidebarProjectItem
                key={project.projectId}
                project={project}
                selectedProject={selectedProject}
                selectedSession={selectedSession}
                isExpanded={isProjectExpanded(project.projectId)}
                isDeleting={deletingProjects.has(project.projectId)}
                isStarred={isProjectStarred(project.projectId)}
                isEditing={renamingProject !== null}
                renameDraft={renamingProject?.draft ?? ''}
                sessions={getProjectSessions(project)}
                initialSessionsLoaded={initialSessionsLoaded.has(project.projectId)}
                isLoadingMoreSessions={loadingMoreProjects.has(project.projectId)}
                currentTime={currentTime}
                sessionRenameId={renamingSession?.id ?? null}
                sessionRenameDraft={renamingSession?.draft ?? ''}
                tasksEnabled={tasksEnabled}
                mcpServerStatus={mcpServerStatus}
                onRenameDraftChange={onRenameDraftChange}
                onToggleProject={onToggleProject}
                onProjectSelect={onProjectSelect}
                onToggleStarProject={onToggleStarProject}
                onStartEditingProject={onStartEditingProject}
                onCancelEditingProject={onCancelEditingProject}
                onSaveProjectName={onSaveProjectName}
                onDeleteProject={onDeleteProject}
                onSessionSelect={onSessionSelect}
                onDeleteSession={onDeleteSession}
                onReorderSessions={onReorderSessions}
                onForkSession={onForkSession}
                onLoadMoreSessions={onLoadMoreSessions}
                activeSessions={activeSessions}
                attentionSessionIds={attentionSessionIds}
                onNewSession={onNewSession}
                isShowingHiddenSessions={showHiddenProjectIds?.has(project.projectId) ?? false}
                showPathOnName={needsPathOnName(project)}
                onToggleShowHidden={onToggleShowHidden}
                onEditSessionFilter={onEditSessionFilter}
                onStartEditingSession={onStartEditingSession}
                onCancelEditingSession={onCancelEditingSession}
                onSaveEditingSession={onSaveEditingSession}
                t={t}
              />
            );
          })}
        {hasRenderBudget && (
          <button
            type="button"
            data-testid="sidebar-project-show-all"
            onClick={() => setShowAllProjects(true)}
            className="mx-3 my-1 block w-[calc(100%-1.5rem)] rounded-lg border border-border/50 px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            {t('projects.showAllProjects', 'Show all projects')}
          </button>
        )}
    </div>
  );
}
