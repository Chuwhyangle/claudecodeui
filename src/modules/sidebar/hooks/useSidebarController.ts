import { useMemo } from 'react';
import type { TFunction } from 'i18next';

import { useBusySessionIdSet } from '@/shared/context/SessionProtectionContext';
import type {
  Project,
  ProjectSession,
  SessionHiddenByProjectFilter,
} from '@/shared/types';
import { useSidebarConversationSearch } from '@/modules/sidebar/hooks/useSidebarConversationSearch';
import { useSidebarDialogs } from '@/modules/sidebar/hooks/useSidebarDialogs';
import { useAwaitingReplySessions } from '@/modules/sidebar/hooks/useAwaitingReplySessions';
import { useSidebarProjectsConcern } from '@/modules/sidebar/hooks/useSidebarProjectsConcern';
import { useSidebarSessionsConcern } from '@/modules/sidebar/hooks/useSidebarSessionsConcern';

type UseSidebarControllerArgs = {
  projects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  activeSessions: ReadonlySet<string>;
  isLoading: boolean;
  isMobile: boolean;
  t: TFunction;
  onRefresh: () => Promise<void> | void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: ProjectSession) => void;
  onSessionDelete?: (sessionId: string) => void;
  onLoadMoreSessions?: (projectId: string) => Promise<void> | void;
  // `projectId` is the DB-assigned identifier; callbacks use that post-migration.
  onProjectDelete?: (projectId: string) => void;
  /**
   * The project rows' session-name rules as a predicate, supplied by the module
   * that owns the rule runtime. Absent means "no rules anywhere" and leaves the
   * live feed exactly as it was before the filter existed.
   */
  isSessionHiddenByProjectFilter?: SessionHiddenByProjectFilter;
  setCurrentProject: (project: Project) => void;
  setSidebarVisible: (visible: boolean) => void;
  sidebarVisible: boolean;
};

/**
 * The sidebar's composed controller. Three concern hooks own their own state —
 * projects (`useSidebarProjectsConcern`), sessions (`useSidebarSessionsConcern`)
 * and dialogs / search input (`useSidebarDialogs`) — and the Conversations
 * server search lives in `useSidebarConversationSearch`. This facade only
 * wires them together and returns the single surface `Sidebar` and the module's
 * tests consume, so every consumer keeps reading one object.
 */
export function useSidebarController({
  projects,
  selectedProject,
  selectedSession: _selectedSession,
  activeSessions,
  isLoading,
  isMobile,
  t,
  onRefresh,
  onProjectSelect,
  onSessionSelect,
  onSessionDelete,
  onLoadMoreSessions,
  onProjectDelete,
  isSessionHiddenByProjectFilter,
  setCurrentProject,
  setSidebarVisible,
  sidebarVisible,
}: UseSidebarControllerArgs) {
  const dialogs = useSidebarDialogs({ isMobile, sidebarVisible, setSidebarVisible });

  const projectsConcern = useSidebarProjectsConcern({
    projects,
    selectedProject,
    activeSessions,
    isLoading,
    searchMode: dialogs.searchMode,
    debouncedSearchQuery: dialogs.debouncedSearchQuery,
    t,
    onRefresh,
    onProjectSelect,
    setCurrentProject,
    onProjectDelete,
    onLoadMoreSessions,
    pendingDeletion: dialogs.pendingDeletion,
    setPendingDeletion: dialogs.setPendingDeletion,
    setActiveRename: dialogs.setActiveRename,
  });

  const sessionsConcern = useSidebarSessionsConcern({
    projects,
    t,
    onRefresh,
    onSessionSelect,
    onSessionDelete,
    isSessionHiddenByProjectFilter,
    searchMode: dialogs.searchMode,
    debouncedSearchQuery: dialogs.debouncedSearchQuery,
    pendingDeletion: dialogs.pendingDeletion,
    setPendingDeletion: dialogs.setPendingDeletion,
    setActiveRename: dialogs.setActiveRename,
    setIsRefreshing: dialogs.setIsRefreshing,
    handleProjectSelect: projectsConcern.handleProjectSelect,
  });

  const conversationSearch = useSidebarConversationSearch({
    searchMode: dialogs.searchMode,
    debouncedSearchQuery: dialogs.debouncedSearchQuery,
  });

  // The badge counts the server-authoritative activity the whole page reads: the
  // same `SessionActivity` membership the activity dock draws its state from and
  // the Running view draws its first group from. It used to count the `turn`
  // leases in the one-second host listing, which is a *slower* answer to the same
  // question — a turn the server had already announced as over stayed counted for
  // up to a poll interval, and for that beat the badge contradicted the dock. One
  // reading, so a badge, a view and a dock cannot describe one turn differently.
  const busySessionIds = useBusySessionIdSet();
  const runningSessionsCount = useMemo(() => busySessionIds.size, [busySessionIds]);

  // The sessions waiting on the user, read once here and handed to both the
  // header badge and the inbox view: one instance, so the badge and the rows
  // cannot describe two different lists.
  const awaitingReply = useAwaitingReplySessions();

  return {
    isSidebarCollapsed: dialogs.isSidebarCollapsed,
    isProjectExpanded: projectsConcern.isProjectExpanded,
    activeRename: dialogs.activeRename,
    showNewProject: dialogs.showNewProject,
    initialSessionsLoaded: projectsConcern.initialSessionsLoaded,
    currentTime: dialogs.currentTime,
    isRefreshing: dialogs.isRefreshing,
    searchFilter: dialogs.searchFilter,
    deletingProjects: projectsConcern.deletingProjects,
    loadingMoreProjects: projectsConcern.loadingMoreProjects,
    pendingDeletion: dialogs.pendingDeletion,
    showVersionModal: dialogs.showVersionModal,
    filteredProjects: projectsConcern.filteredProjects,
    runningSessionsCount,
    awaitingReply,
    archivedProjects: sessionsConcern.filteredArchivedProjects,
    archivedSessions: sessionsConcern.filteredArchivedSessions,
    archivedSessionsCount: sessionsConcern.archivedProjects.length + sessionsConcern.archivedSessions.length,
    isArchivedSessionsLoading: sessionsConcern.isArchivedSessionsLoading,
    recentConversations: sessionsConcern.recentConversations,
    // A row inserted from a live event is not in the server total yet, so never read lower than the rows shown.
    recentConversationsTotal: Math.max(
      sessionsConcern.recentConversationsTotal,
      sessionsConcern.recentConversations.length,
    ),
    recentConversationsHasMore: sessionsConcern.recentConversationsHasMore,
    isRecentConversationsLoading: sessionsConcern.isRecentConversationsLoading,
    isLoadingMoreRecentConversations: sessionsConcern.isLoadingMoreRecentConversations,
    recentConversationsError: sessionsConcern.recentConversationsError,
    reloadRecentConversations: sessionsConcern.reloadRecentConversations,
    loadMoreRecentConversations: sessionsConcern.loadMoreRecentConversations,
    toggleProject: projectsConcern.toggleProject,
    handleSessionClick: sessionsConcern.handleSessionClick,
    forkSession: sessionsConcern.forkSession,
    toggleStarProject: projectsConcern.toggleStarProject,
    isProjectStarred: projectsConcern.isProjectStarred,
    getProjectSessions: projectsConcern.getProjectSessions,
    reorderSessions: projectsConcern.reorderSessions,
    loadMoreSessionsForProject: projectsConcern.loadMoreSessionsForProject,
    startEditingProject: projectsConcern.startEditingProject,
    startEditingSession: sessionsConcern.startEditingSession,
    updateRenameDraft: dialogs.updateRenameDraft,
    cancelRename: dialogs.cancelRename,
    saveProjectName: projectsConcern.saveProjectName,
    showDeleteSessionConfirmation: sessionsConcern.showDeleteSessionConfirmation,
    confirmDeleteSession: sessionsConcern.confirmDeleteSession,
    requestProjectDelete: projectsConcern.requestProjectDelete,
    confirmDeleteProject: projectsConcern.confirmDeleteProject,
    handleProjectSelect: projectsConcern.handleProjectSelect,
    openArchivedSession: sessionsConcern.openArchivedSession,
    restoreArchivedProject: sessionsConcern.restoreArchivedProject,
    restoreArchivedSession: sessionsConcern.restoreArchivedSession,
    refreshProjects: sessionsConcern.refreshProjects,
    updateSessionSummary: sessionsConcern.updateSessionSummary,
    collapseSidebar: dialogs.collapseSidebar,
    expandSidebar: dialogs.expandSidebar,
    setShowNewProject: dialogs.setShowNewProject,
    searchMode: dialogs.searchMode,
    setSearchMode: dialogs.setSearchMode,
    conversationResults: conversationSearch.conversationResults,
    isSearching: conversationSearch.isSearching,
    searchProgress: conversationSearch.searchProgress,
    clearConversationResults: conversationSearch.clearConversationResults,
    setSearchFilter: dialogs.setSearchFilter,
    setPendingDeletion: dialogs.setPendingDeletion,
    setShowVersionModal: dialogs.setShowVersionModal,
  };
}
