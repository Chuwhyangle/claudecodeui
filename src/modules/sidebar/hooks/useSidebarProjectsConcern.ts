import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';

import { api } from '@/shared/api';
import { usePaletteOps } from '@/modules/command-palette';
import { subscribeToUserPreferences } from '@/shared/settings/userSettings';
import type {
  ActiveSidebarRename,
  PendingSidebarDeletion,
  Project,
  ProjectSortOrder,
  SessionWithProvider,
  SidebarSearchMode,
} from '@/shared/types';
import {
  filterProjects,
  getAllSessions,
  sortProjects,
} from '@/modules/sidebar/utils/sidebarProjectFormatting';
import {
  clearLegacyStarredProjectIds,
  readLegacyStarredProjectIds,
  readProjectSortOrder,
} from '@/modules/sidebar/utils/sidebarStoredPreferences';

type UseSidebarProjectsConcernArgs = {
  projects: Project[];
  selectedProject: Project | null;
  activeSessions: ReadonlySet<string>;
  isLoading: boolean;
  searchMode: SidebarSearchMode;
  debouncedSearchQuery: string;
  t: TFunction;
  onRefresh: () => Promise<void> | void;
  onProjectSelect: (project: Project) => void;
  setCurrentProject: (project: Project) => void;
  onProjectDelete?: (projectId: string) => void;
  onLoadMoreSessions?: (projectId: string) => Promise<void> | void;
  pendingDeletion: PendingSidebarDeletion | null;
  setPendingDeletion: (value: PendingSidebarDeletion | null) => void;
  setActiveRename: (value: ActiveSidebarRename | null) => void;
};

/**
 * Everything the sidebar renders about projects: expansion, ordering, the
 * optimistic star map, per-row session paging, and project rename/delete
 * commands. Consumed by `useSidebarController`, which composes it with the
 * session and dialog concerns into one public surface.
 */
export function useSidebarProjectsConcern({
  projects,
  selectedProject,
  activeSessions,
  isLoading,
  searchMode,
  debouncedSearchQuery,
  t,
  onRefresh,
  onProjectSelect,
  setCurrentProject,
  onProjectDelete,
  onLoadMoreSessions,
  pendingDeletion,
  setPendingDeletion,
  setActiveRename,
}: UseSidebarProjectsConcernArgs) {
  const paletteOps = usePaletteOps();
  // Which projects are expanded in the Projects tab.
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  // Project whose selection was changed by the row click that also toggled it. The auto-expand
  // effect fires AFTER that click's state commits, so without this marker the effect re-opens
  // the project the click just collapsed. Consumed by the next effect run for that project.
  const selectionToggleProjectRef = useRef<string | null>(null);
  // Running groups start expanded and remember manual collapses independently of Projects.
  const [collapsedRunningProjects, setCollapsedRunningProjects] = useState<Set<string>>(new Set());
  // The user's preferred project ordering, read from the preference store.
  const [projectSortOrder, setProjectSortOrder] = useState<ProjectSortOrder>('name');
  // Projects whose initial session page has loaded, so a row can tell "no
  // sessions" from "not loaded yet".
  const [initialSessionsLoaded, setInitialSessionsLoaded] = useState<Set<string>>(new Set());
  // Star values the user just toggled, held above the server listing until it catches up.
  const [optimisticStarByProjectId, setOptimisticStarByProjectId] = useState<Map<string, boolean>>(new Map());
  // Orders that a drag has produced and the server has not confirmed yet, per
  // project and session. The rows must land where they were dropped the moment
  // the drop happens, while the refresh that follows carries the stored order.
  const [optimisticOrderByProjectId, setOptimisticOrderByProjectId] = useState<Map<string, Map<string, number>>>(new Map());
  // Bumped on every overlay write, so the composed list below knows its cached
  // array predates the map. Without it the WeakMap would keep handing back the
  // pre-drop order for the same project object.
  const orderOverlayVersionRef = useRef(0);
  // Projects with a reorder request on the wire, so a second drop cannot race
  // the first one's answer. A ref, not state: nothing renders.
  const reorderInFlightRef = useRef<Set<string>>(new Set());
  // Which projects have a "load more" request in flight, as the row reads it.
  // Browser state, not server state: it only exists so the button can say
  // "Loading sessions..." and stay disabled while its own page request is unanswered.
  const [loadingMoreProjects, setLoadingMoreProjects] = useState<Set<string>>(new Set());
  // Projects with a delete request in flight, so their row actions can be disabled.
  const [deletingProjects, setDeletingProjects] = useState<Set<string>>(new Set());
  // The same in-flight set, readable synchronously by the next click. The state copy above is
  // only the rendering of it: React may defer a state updater past the handler that scheduled
  // it, so the guard for a second click must not be a write observed from inside that updater.
  const loadingMoreProjectsRef = useRef<Set<string>>(new Set());
  // Monotonic per-project star-toggle id; only the latest response may write the star value.
  const starToggleSequenceByProjectRef = useRef<Map<string, number>>(new Map());
  // Guards the one-time legacy local-storage star migration.
  const migrationStartedRef = useRef(false);
  // The refresh callback as the latest render sees it, for the migration started on mount.
  const onRefreshRef = useRef(onRefresh);

  const activeSessionIds = activeSessions;

  useEffect(() => {
    setInitialSessionsLoaded(new Set());
  }, [projects]);

  useEffect(() => {
    // Auto-expand only when the selected project identity changes.
    // Depending on the full `selectedProject` object (or `selectedSession`) causes
    // websocket-driven list refreshes to re-open projects users manually collapsed.
    const selectedProjectId = selectedProject?.projectId;
    if (!selectedProjectId) {
      return;
    }

    // A row click that both selects and toggles has already decided the expansion. Skip the
    // one run its own selection change causes, or the effect would undo the collapse. A
    // marker for a different project (another selection won the same batch) is dropped here
    // so it can never suppress a later, unrelated selection.
    const suppressedProjectId = selectionToggleProjectRef.current;
    selectionToggleProjectRef.current = null;
    if (suppressedProjectId === selectedProjectId) {
      return;
    }

    // Selection arrived from outside the Projects row (a session route, the Conversations
    // feed, a restore): open that project and close the others, the same single-open shape
    // `toggleProject` writes. Adding without removing left several rows expanded.
    setExpandedProjects(() => new Set([selectedProjectId]));
  }, [selectedProject?.projectId]);

  useEffect(() => {
    if (projects.length > 0 && !isLoading) {
      const loadedProjects = new Set<string>();
      projects.forEach((project) => {
        if (project.sessions && project.sessions.length >= 0) {
          loadedProjects.add(project.projectId);
        }
      });
      setInitialSessionsLoaded(loadedProjects);
    }
  }, [projects, isLoading]);

  // The sort order used to be polled once a second (plus a `storage` listener
  // for other tabs) because nothing announced a change. The preference store
  // notifies on every write and on every hydrate, so both are unnecessary.
  useEffect(() => {
    const loadSortOrder = () => {
      setProjectSortOrder(readProjectSortOrder());
    };

    loadSortOrder();
    return subscribeToUserPreferences(loadSortOrder);
  }, []);

  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  useEffect(() => {
    if (migrationStartedRef.current) {
      return;
    }

    const legacyStarredProjectIds = readLegacyStarredProjectIds();
    if (legacyStarredProjectIds.length === 0) {
      return;
    }

    migrationStartedRef.current = true;

    const migrateLegacyStars = async () => {
      try {
        await api.migrateLegacyProjectStars(legacyStarredProjectIds);
        await onRefreshRef.current();
      } catch (error) {
        console.error('[Sidebar] Failed to migrate legacy starred projects:', error);
      } finally {
        clearLegacyStarredProjectIds();
      }
    };

    void migrateLegacyStars();
  }, [onRefresh]);

  useEffect(() => {
    setOptimisticStarByProjectId((previous) => {
      if (previous.size === 0) {
        return previous;
      }

      const next = new Map(previous);
      let changed = false;

      for (const [projectId, optimisticValue] of previous.entries()) {
        const project = projects.find((candidate) => candidate.projectId === projectId);
        if (!project) {
          next.delete(projectId);
          changed = true;
          continue;
        }

        if (Boolean(project.isStarred) === optimisticValue) {
          next.delete(projectId);
          changed = true;
        }
      }

      return changed ? next : previous;
    });
  }, [projects]);

  // All sidebar state keys (expanded, starred, loading, etc.) use the DB
  // `projectId` as their identifier after the migration.
  const toggleProject = useCallback(
    (projectId: string, selectionWillChange = false) => {
      if (searchMode === 'running') {
        setCollapsedRunningProjects((prev) => {
          const next = new Set(prev);
          if (!next.delete(projectId)) {
            next.add(projectId);
          }
          return next;
        });
        return;
      }

      // Record the gesture BEFORE the toggle's state update: the auto-expand effect runs after
      // this click's commit and must skip exactly this selection change.
      if (selectionWillChange) {
        selectionToggleProjectRef.current = projectId;
      }

      setExpandedProjects((prev) => {
        const next = new Set<string>();
        if (!prev.has(projectId)) {
          next.add(projectId);
        }
        return next;
      });
    },
    [searchMode],
  );

  const isProjectExpanded = useCallback(
    (projectId: string) =>
      searchMode === 'running'
        ? !collapsedRunningProjects.has(projectId)
        : expandedProjects.has(projectId),
    [collapsedRunningProjects, expandedProjects, searchMode],
  );

  const resolveProjectStarState = useCallback(
    (projectId: string): boolean => {
      if (optimisticStarByProjectId.has(projectId)) {
        return Boolean(optimisticStarByProjectId.get(projectId));
      }

      return projects.some((project) => project.projectId === projectId && Boolean(project.isStarred));
    },
    [optimisticStarByProjectId, projects],
  );

  const toggleStarProject = useCallback((projectId: string) => {
    const previousStarState = resolveProjectStarState(projectId);
    const optimisticStarState = !previousStarState;
    const latestSequence = (starToggleSequenceByProjectRef.current.get(projectId) ?? 0) + 1;
    starToggleSequenceByProjectRef.current.set(projectId, latestSequence);

    setOptimisticStarByProjectId((previous) => {
      const next = new Map(previous);
      next.set(projectId, optimisticStarState);
      return next;
    });

    const updateStar = async () => {
      try {
        const response = await api.toggleProjectStar(projectId);
        if (!response.ok) {
          const payload = (await response.json()) as { error?: string | { message?: string } };
          const errorPayload = payload.error;
          const message =
            typeof errorPayload === 'string'
              ? errorPayload
              : errorPayload && typeof errorPayload === 'object' && errorPayload.message
                ? errorPayload.message
                : t('messages.updateProjectError');
          throw new Error(message);
        }

        const payload = (await response.json()) as { isStarred?: boolean };
        const isLatestSequence = starToggleSequenceByProjectRef.current.get(projectId) === latestSequence;
        if (!isLatestSequence) {
          return;
        }

        setOptimisticStarByProjectId((previous) => {
          const next = new Map(previous);
          next.set(projectId, Boolean(payload.isStarred));
          return next;
        });
      } catch (error) {
        const isLatestSequence = starToggleSequenceByProjectRef.current.get(projectId) === latestSequence;
        if (!isLatestSequence) {
          return;
        }

        setOptimisticStarByProjectId((previous) => {
          const next = new Map(previous);
          next.set(projectId, previousStarState);
          return next;
        });
        console.error('[Sidebar] Failed to toggle project star:', error);
        alert(t('messages.updateProjectError'));
      }
    };

    void updateStar();
  }, [resolveProjectStarState, t]);

  const isProjectStarred = useCallback(
    (projectId: string) => resolveProjectStarState(projectId),
    [resolveProjectStarState],
  );

  // Composed lists for the short window a drop is in flight, keyed by the
  // project object the caller passed. `getAllSessions` already caches per
  // project; this is the same contract over the overlay's temporary copy, so a
  // row's props stay referentially stable across renders while an order
  // settles.
  const orderOverlayCacheRef = useRef(new WeakMap<Project, { version: number; sessions: SessionWithProvider[] }>());

  const getProjectSessions = useCallback((project: Project) => {
    const orderOverlay = optimisticOrderByProjectId.get(project.projectId);
    if (!orderOverlay) {
      return getAllSessions(project);
    }

    const cached = orderOverlayCacheRef.current.get(project);
    if (cached && cached.version === orderOverlayVersionRef.current) {
      return cached.sessions;
    }

    const overlaid: Project = {
      ...project,
      sessions: (project.sessions ?? []).map((session) => {
        const order = orderOverlay.get(String(session.id));
        return order === undefined ? session : { ...session, sessionOrder: order };
      }),
    };
    const sessions = getAllSessions(overlaid);
    orderOverlayCacheRef.current.set(project, {
      version: orderOverlayVersionRef.current,
      sessions,
    });
    return sessions;
  }, [optimisticOrderByProjectId]);

  const loadMoreSessionsForProject = useCallback(async (projectId: string) => {
    if (!onLoadMoreSessions) {
      return;
    }

    // The guard is read from the ref, never from a write made inside the state updater: React
    // runs an updater during a later render, so a click that arrives while any other update is
    // pending would otherwise see `shouldLoad` still false, return early *after* the updater
    // had already scheduled the spinner, and leave the row on "Loading sessions..." forever
    // with no request in flight (the sidebar's 5s poll is enough to produce that window).
    if (loadingMoreProjectsRef.current.has(projectId)) {
      return;
    }
    loadingMoreProjectsRef.current.add(projectId);

    setLoadingMoreProjects((previous) => {
      if (previous.has(projectId)) {
        return previous;
      }

      const next = new Set(previous);
      next.add(projectId);
      return next;
    });

    try {
      await onLoadMoreSessions(projectId);
    } catch (error) {
      console.error('[Sidebar] Failed to load more sessions:', error);
      alert(t('messages.refreshError'));
    } finally {
      loadingMoreProjectsRef.current.delete(projectId);
      setLoadingMoreProjects((previous) => {
        const next = new Set(previous);
        next.delete(projectId);
        return next;
      });
    }
  }, [onLoadMoreSessions, t]);

  const projectsWithResolvedStarState = useMemo(() => {
    if (optimisticStarByProjectId.size === 0) {
      return projects;
    }

    return projects.map((project) => {
      const optimisticStarState = optimisticStarByProjectId.get(project.projectId);
      if (optimisticStarState === undefined) {
        return project;
      }

      const currentStarState = Boolean(project.isStarred);
      if (currentStarState === optimisticStarState) {
        return project;
      }

      return {
        ...project,
        isStarred: optimisticStarState,
      };
    });
  }, [optimisticStarByProjectId, projects]);

  const sortedProjects = useMemo(
    () => sortProjects(projectsWithResolvedStarState, projectSortOrder),
    [projectSortOrder, projectsWithResolvedStarState],
  );

  const runningProjects = useMemo(() => {
    if (activeSessionIds.size === 0) {
      return [];
    }

    return sortedProjects.reduce<Project[]>((acc, project) => {
      const sessions = (project.sessions ?? []).filter((session) => activeSessionIds.has(String(session.id)));
      const runningCount = sessions.length;

      if (runningCount === 0) {
        return acc;
      }

      acc.push({
        ...project,
        sessions,
        sessionMeta: {
          ...project.sessionMeta,
          total: runningCount,
          hasMore: false,
        },
      });
      return acc;
    }, []);
  }, [activeSessionIds, sortedProjects]);

  const filteredProjects = useMemo(
    () => filterProjects(searchMode === 'running' ? runningProjects : sortedProjects, debouncedSearchQuery),
    [debouncedSearchQuery, runningProjects, searchMode, sortedProjects],
  );

  // Keyed by projectId so the rename survives display-name mutations that arrive
  // while the input is open.
  const startEditingProject = useCallback((project: Project) => {
    setActiveRename({ target: 'project', id: project.projectId, draft: project.displayName });
  }, [setActiveRename]);

  const saveProjectName = useCallback(
    // `projectId` is the DB primary key; the rename API resolves the path
    // through the `projects` table before writing the new display name.
    async (projectId: string, nextName: string) => {
      try {
        const response = await api.renameProject(projectId, nextName);
        if (response.ok) {
          await paletteOps.refreshProjects();
        } else {
          console.error('Failed to rename project');
        }
      } catch (error) {
        console.error('Error renaming project:', error);
      } finally {
        setActiveRename(null);
      }
    },
    [paletteOps, setActiveRename],
  );

  /**
   * Stores the order a project's session rows were dropped into.
   *
   * The overlay applies the new positions immediately — the rows must not wait
   * for a round trip to land where they were dropped — and the refreshed
   * project list, which carries the stored order, takes over afterwards. A
   * failed write drops the overlay so the rows return to the truth, and says
   * so; leaving them optimised would show an order the next page load
   * contradicts.
   */
  const reorderSessions = useCallback(
    async (projectId: string, sessionIds: string[]) => {
      if (reorderInFlightRef.current.has(projectId)) {
        return;
      }
      reorderInFlightRef.current.add(projectId);

      const nextOrder = new Map(sessionIds.map((sessionId, index) => [sessionId, index]));
      orderOverlayVersionRef.current += 1;
      setOptimisticOrderByProjectId((previous) => {
        const next = new Map(previous);
        next.set(projectId, nextOrder);
        return next;
      });

      try {
        const response = await api.reorderProjectSessions(projectId, sessionIds);
        if (!response.ok) {
          throw new Error(`Failed to store the session order (${response.status})`);
        }
        // The refresh writes the same order from the server. Clearing before it
        // lands would flash the old arrangement back for a frame.
        await onRefresh();
        orderOverlayVersionRef.current += 1;
        setOptimisticOrderByProjectId((previous) => {
          if (!previous.has(projectId)) {
            return previous;
          }
          const next = new Map(previous);
          next.delete(projectId);
          return next;
        });
      } catch (error) {
        console.error('[Sidebar] Error storing the session order:', error);
        orderOverlayVersionRef.current += 1;
        setOptimisticOrderByProjectId((previous) => {
          if (!previous.has(projectId)) {
            return previous;
          }
          const next = new Map(previous);
          next.delete(projectId);
          return next;
        });
        alert(t('messages.reorderSessionsError'));
      } finally {
        reorderInFlightRef.current.delete(projectId);
      }
    },
    [onRefresh, t],
  );

  const requestProjectDelete = useCallback(
    (project: Project) => {
      setPendingDeletion({
        kind: 'project',
        project,
        sessionCount: getProjectSessions(project).length,
      });
    },
    [getProjectSessions, setPendingDeletion],
  );

  const confirmDeleteProject = useCallback(async (deleteData = false) => {
    if (pendingDeletion?.kind !== 'project') {
      return;
    }

    const { project } = pendingDeletion;

    setPendingDeletion(null);
    // Track in-flight deletes by projectId so the UI can disable actions
    // even if the project object is rebuilt while the request is flying.
    setDeletingProjects((prev) => new Set([...prev, project.projectId]));

    try {
      const response = await api.deleteProject(project.projectId, deleteData);

      if (response.ok) {
        onProjectDelete?.(project.projectId);
      } else {
        const data = (await response.json()) as { error?: string | { message?: string } };
        const err = data.error;
        const message =
          typeof err === 'string' ? err : err && typeof err === 'object' && err.message ? err.message : t('messages.deleteProjectFailed');
        alert(message);
      }
    } catch (error) {
      console.error('Error deleting project:', error);
      alert(t('messages.deleteProjectError'));
    } finally {
      setDeletingProjects((prev) => {
        const next = new Set(prev);
        next.delete(project.projectId);
        return next;
      });
    }
  }, [pendingDeletion, onProjectDelete, setPendingDeletion, t]);

  const handleProjectSelect = useCallback(
    (project: Project) => {
      onProjectSelect(project);
      setCurrentProject(project);
    },
    [onProjectSelect, setCurrentProject],
  );

  return {
    isProjectExpanded,
    initialSessionsLoaded,
    deletingProjects,
    loadingMoreProjects,
    filteredProjects,
    toggleProject,
    toggleStarProject,
    isProjectStarred,
    getProjectSessions,
    reorderSessions,
    loadMoreSessionsForProject,
    startEditingProject,
    saveProjectName,
    requestProjectDelete,
    confirmDeleteProject,
    handleProjectSelect,
  };
}
