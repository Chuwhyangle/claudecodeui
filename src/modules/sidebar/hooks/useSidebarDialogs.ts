import { useCallback, useEffect, useState } from 'react';

import { usePageVisible } from '@/shared/hooks/usePageVisibility';
import type { ActiveSidebarRename, PendingSidebarDeletion, SidebarSearchMode } from '@/shared/types';

type UseSidebarDialogsArgs = {
  isMobile: boolean;
  sidebarVisible: boolean;
  setSidebarVisible: (visible: boolean) => void;
};

/**
 * The sidebar's dialog, search-input and view state: which rename / delete /
 * modal is open, the search box and its debounced value, the once-a-minute
 * clock, and the collapse commands. Consumed by `useSidebarController`, which
 * composes it with the project and session concerns into one public surface.
 */
export function useSidebarDialogs({
  isMobile,
  sidebarVisible,
  setSidebarVisible,
}: UseSidebarDialogsArgs) {
  // The one rename the sidebar has open, as a single value so a project and a
  // session cannot both be mid-rename. See ActiveSidebarRename.
  const [activeRename, setActiveRename] = useState<ActiveSidebarRename | null>(null);
  // The one delete confirmation the sidebar has open. One value because the
  // project and session dialogs are portalled at the same z-index and would
  // otherwise stack. See PendingSidebarDeletion.
  const [pendingDeletion, setPendingDeletion] = useState<PendingSidebarDeletion | null>(null);
  // Whether the new-project dialog is open; the modal itself renders in SidebarModals.
  const [showNewProject, setShowNewProject] = useState(false);
  // Whether the version-information modal is open.
  const [showVersionModal, setShowVersionModal] = useState(false);
  // The sidebar's relative-time reading, refreshed once a minute for project rows.
  const [currentTime, setCurrentTime] = useState(new Date());
  // Whether the sidebar refresh action is in flight, so the control can stay disabled.
  const [isRefreshing, setIsRefreshing] = useState(false);
  // The raw search box text; the debounced copy below is what filters read.
  const [searchFilter, setSearchFilter] = useState('');
  // Which sidebar tab is active: projects, running, conversations or archived.
  const [searchMode, setSearchMode] = useState<SidebarSearchMode>('projects');
  // The trimmed search text after the debounce; filtering and conversation search read this.
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');

  const isSidebarCollapsed = !isMobile && !sidebarVisible;

  // The minute clock is a local `Date` reading, but a hidden tab has no one to show it to: the
  // interval runs only while visible, and the first visible tick (within a minute) catches up.
  const visible = usePageVisible();
  useEffect(() => {
    if (!visible) {
      return undefined;
    }
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 60000);

    return () => clearInterval(timer);
  }, [visible]);

  // Debounce search text updates so both project filtering and conversation
  // SSE requests avoid running on every keypress.
  useEffect(() => {
    const timeout = setTimeout(() => {
      setDebouncedSearchQuery(searchFilter.trim());
    }, 300);

    return () => {
      clearTimeout(timeout);
    };
  }, [searchFilter]);

  const updateRenameDraft = useCallback((draft: string) => {
    setActiveRename((previous) => (previous ? { ...previous, draft } : previous));
  }, []);

  const cancelRename = useCallback(() => {
    setActiveRename(null);
  }, []);

  const collapseSidebar = useCallback(() => {
    setSidebarVisible(false);
  }, [setSidebarVisible]);

  const expandSidebar = useCallback(() => {
    setSidebarVisible(true);
  }, [setSidebarVisible]);

  return {
    isSidebarCollapsed,
    activeRename,
    pendingDeletion,
    showNewProject,
    showVersionModal,
    currentTime,
    isRefreshing,
    setIsRefreshing,
    searchFilter,
    setSearchFilter,
    searchMode,
    setSearchMode,
    debouncedSearchQuery,
    setActiveRename,
    setPendingDeletion,
    setShowNewProject,
    setShowVersionModal,
    updateRenameDraft,
    cancelRename,
    collapseSidebar,
    expandSidebar,
  };
}
