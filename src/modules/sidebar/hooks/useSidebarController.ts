import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';

import { api } from '@/shared/api';
import { useBusySessionIdSet } from '@/shared/context/SessionProtectionContext';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import { subscribeToUserPreferences } from '@/shared/userSettings';
import { getSessionTitle } from '@/shared/utils';
import { usePaletteOps } from '@/modules/command-palette';
import type { ArchivedProjectListItem, ArchivedSessionListItem, ConversationProjectResult, ConversationSearchResults, LLMProvider, Project, ProjectSession, ProjectSortOrder, RecentConversationListItem, SearchProgress, ServerEvent, ActiveSidebarRename, PendingSidebarDeletion, SessionHiddenByProjectFilter, SessionTitleSearchResult, SessionWithProvider, SidebarSearchMode } from '@/shared/types';
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


type ArchivedSessionsApiPayload = {
  success?: boolean;
  data?: {
    sessions?: ArchivedSessionListItem[];
  };
};

type ArchivedProjectsApiPayload = {
  success?: boolean;
  data?: {
    projects?: ArchivedProjectListItem[];
  };
};

type RecentConversationsApiPayload = {
  success?: boolean;
  data?: {
    conversations?: RecentConversationListItem[];
    total?: number;
    hasMore?: boolean;
  };
};

/**
 * The `kind: session_upserted` delta as the Conversations list needs it: which
 * session changed and what row the server now reports for it.
 *
 * Built on the wire by
 * `server/modules/websocket/services/session-upsert-broadcast.service.ts`,
 * which emits nothing at all for an archived row.
 */
type SessionUpsertedEvent = ServerEvent & {
  sessionId?: string;
  provider?: LLMProvider;
  session?: ProjectSession;
  project?: { projectId: string; displayName: string } | null;
};

/**
 * The Conversations feed has to match what a reload of the same feed returns, and
 * `GET /api/providers/sessions/recent` applies the project's name rules with
 * neither of the Projects list's exemptions: no keepSessionIds, no browser-local
 * "show hidden". Judging with an empty set and `isShowingHidden = false` is what
 * keeps the live list from being the more permissive of the two — being more
 * permissive is exactly the reported bug.
 */
const NO_EXEMPT_SESSION_IDS: ReadonlySet<string> = new Set();

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
  const paletteOps = usePaletteOps();
  // The app-wide event stream, read here so a rename made anywhere reaches the
  // Conversations list. Same subscription the project-workspace module takes.
  const { subscribe } = useWebSocket();
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  // Running groups start expanded and remember manual collapses independently of Projects.
  const [collapsedRunningProjects, setCollapsedRunningProjects] = useState<Set<string>>(new Set());
  // The one rename the sidebar has open, as a single value so a project and a
  // session cannot both be mid-rename. See ActiveSidebarRename.
  const [activeRename, setActiveRename] = useState<ActiveSidebarRename | null>(null);
  const [showNewProject, setShowNewProject] = useState(false);
  const [initialSessionsLoaded, setInitialSessionsLoaded] = useState<Set<string>>(new Set());
  const [currentTime, setCurrentTime] = useState(new Date());
  const [projectSortOrder, setProjectSortOrder] = useState<ProjectSortOrder>('name');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [searchFilter, setSearchFilter] = useState('');
  const [deletingProjects, setDeletingProjects] = useState<Set<string>>(new Set());
  // The one delete confirmation the sidebar has open. One value because the
  // project and session dialogs are portalled at the same z-index and would
  // otherwise stack. See PendingSidebarDeletion.
  const [pendingDeletion, setPendingDeletion] = useState<PendingSidebarDeletion | null>(null);
  const [showVersionModal, setShowVersionModal] = useState(false);
  const [searchMode, setSearchMode] = useState<SidebarSearchMode>('projects');
  const [conversationResults, setConversationResults] = useState<ConversationSearchResults | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [searchProgress, setSearchProgress] = useState<SearchProgress | null>(null);
  const [archivedProjects, setArchivedProjects] = useState<ArchivedProjectListItem[]>([]);
  const [archivedSessions, setArchivedSessions] = useState<ArchivedSessionListItem[]>([]);
  const [isArchivedSessionsLoading, setIsArchivedSessionsLoading] = useState(false);
  const [recentConversations, setRecentConversations] = useState<RecentConversationListItem[]>([]);
  const [recentConversationsTotal, setRecentConversationsTotal] = useState(0);
  const [recentConversationsHasMore, setRecentConversationsHasMore] = useState(false);
  const [isRecentConversationsLoading, setIsRecentConversationsLoading] = useState(false);
  const [isLoadingMoreRecentConversations, setIsLoadingMoreRecentConversations] = useState(false);
  const [recentConversationsError, setRecentConversationsError] = useState(false);
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [optimisticStarByProjectId, setOptimisticStarByProjectId] = useState<Map<string, boolean>>(new Map());
  // Which projects have a "load more" request in flight, as the row reads it. Browser state,
  // not server state: it only exists so the button can say "Loading sessions..." and stay
  // disabled while its own page request is unanswered.
  const [loadingMoreProjects, setLoadingMoreProjects] = useState<Set<string>>(new Set());
  // The same in-flight set, readable synchronously by the next click. The state copy above is
  // only the rendering of it: React may defer a state updater past the handler that scheduled
  // it, so the guard for a second click must not be a write observed from inside that updater.
  const loadingMoreProjectsRef = useRef<Set<string>>(new Set());
  const searchSeqRef = useRef(0);
  const recentConversationsSeqRef = useRef(0);
  const eventSourceRef = useRef<EventSource | null>(null);
  const starToggleSequenceByProjectRef = useRef<Map<string, number>>(new Map());
  const migrationStartedRef = useRef(false);
  const onRefreshRef = useRef(onRefresh);

  const isSidebarCollapsed = !isMobile && !sidebarVisible;
  const activeSessionIds = activeSessions;
  // The badge counts the server-authoritative activity the whole page reads: the
  // same `SessionActivity` membership the activity dock draws its state from and
  // the Running view draws its first group from. It used to count the `turn`
  // leases in the one-second host listing, which is a *slower* answer to the same
  // question — a turn the server had already announced as over stayed counted for
  // up to a poll interval, and for that beat the badge contradicted the dock. One
  // reading, so a badge, a view and a dock cannot describe one turn differently.
  const busySessionIds = useBusySessionIdSet();
  const runningSessionsCount = useMemo(() => busySessionIds.size, [busySessionIds]);

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 60000);

    return () => clearInterval(timer);
  }, []);

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

    setExpandedProjects((prev) => {
      if (prev.has(selectedProjectId)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(selectedProjectId);
      return next;
    });
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

  const fetchArchivedSessions = useCallback(async () => {
    setIsArchivedSessionsLoading(true);

    try {
      const [archivedProjectsResponse, archivedSessionsResponse] = await Promise.all([
        api.archivedProjects(),
        api.getArchivedSessions(),
      ]);

      if (!archivedProjectsResponse.ok) {
        throw new Error(`Failed to load archived projects: ${archivedProjectsResponse.status}`);
      }

      if (!archivedSessionsResponse.ok) {
        throw new Error(`Failed to load archived sessions: ${archivedSessionsResponse.status}`);
      }

      const archivedProjectsPayload = (await archivedProjectsResponse.json()) as ArchivedProjectsApiPayload;
      const archivedSessionsPayload = (await archivedSessionsResponse.json()) as ArchivedSessionsApiPayload;
      const nextProjects = Array.isArray(archivedProjectsPayload.data?.projects) ? archivedProjectsPayload.data.projects : [];
      const archivedProjectIds = new Set(nextProjects.map((project) => project.projectId));
      const nextStandaloneSessions = Array.isArray(archivedSessionsPayload.data?.sessions)
        ? archivedSessionsPayload.data.sessions.filter((session) => !session.projectId || !archivedProjectIds.has(session.projectId))
        : [];

      setArchivedProjects(nextProjects);
      setArchivedSessions(nextStandaloneSessions);
    } catch (error) {
      console.error('[Sidebar] Failed to load archived sessions:', error);
    } finally {
      setIsArchivedSessionsLoading(false);
    }
  }, []);

  const fetchRecentConversationsPage = useCallback(async (offset: number, append: boolean) => {
    const requestSequence = ++recentConversationsSeqRef.current;
    if (append) {
      setIsLoadingMoreRecentConversations(true);
    } else {
      setIsRecentConversationsLoading(true);
    }
    setRecentConversationsError(false);

    try {
      const response = await api.recentConversations({ limit: 40, offset });
      if (!response.ok) {
        throw new Error(`Failed to load recent conversations: ${response.status}`);
      }

      const payload = (await response.json()) as RecentConversationsApiPayload;
      const conversations = Array.isArray(payload.data?.conversations)
        ? payload.data.conversations
        : [];

      if (requestSequence !== recentConversationsSeqRef.current) {
        return;
      }

      setRecentConversations((previous) => {
        if (!append) {
          return conversations;
        }

        const existingIds = new Set(previous.map((conversation) => conversation.sessionId));
        return [
          ...previous,
          ...conversations.filter((conversation) => !existingIds.has(conversation.sessionId)),
        ];
      });
      setRecentConversationsTotal(Number(payload.data?.total ?? conversations.length));
      setRecentConversationsHasMore(Boolean(payload.data?.hasMore));
    } catch (error) {
      if (requestSequence !== recentConversationsSeqRef.current) {
        return;
      }
      console.error('[Sidebar] Failed to load recent conversations:', error);
      setRecentConversationsError(true);
    } finally {
      if (requestSequence === recentConversationsSeqRef.current) {
        setIsRecentConversationsLoading(false);
        setIsLoadingMoreRecentConversations(false);
      }
    }
  }, []);

  const reloadRecentConversations = useCallback(() => {
    void fetchRecentConversationsPage(0, false);
  }, [fetchRecentConversationsPage]);

  const loadMoreRecentConversations = useCallback(() => {
    if (isLoadingMoreRecentConversations || !recentConversationsHasMore) {
      return;
    }
    void fetchRecentConversationsPage(recentConversations.length, true);
  }, [
    fetchRecentConversationsPage,
    isLoadingMoreRecentConversations,
    recentConversations.length,
    recentConversationsHasMore,
  ]);

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
    void fetchArchivedSessions();
  }, [fetchArchivedSessions]);

  // A session renamed or created anywhere — this client, another browser, the
  // CLI — arrives as a `session_upserted`. The Conversations list holds its own
  // copy of every row, so without this it kept showing the name a session had
  // when the page was last listed. Patching in place (rather than reloading the
  // feed) also preserves the pages loaded past the first.
  //
  // The project's name rules apply to this feed exactly as they do to a reload:
  // a session whose current name matches is neither inserted nor kept, so a
  // worker session created while the user sits on Conversations never appears.
  // The predicate and the project rows come from the parent (see
  // SessionHiddenByProjectFilter); judging is done by the delta's own summary,
  // which for a session row is the same coalesced name the reload filters on.
  //
  // Archived rows are deliberately not covered: the server's upsert builder
  // returns null for an archived row, so no event for one ever reaches a client.
  // A rename made here is patched locally by `updateSessionSummary` instead; a
  // rename made from another client is out of scope (see the task Evidence).
  useEffect(() => subscribe((event) => {
    if (event.kind !== 'session_upserted') {
      return;
    }

    const upsert = event as SessionUpsertedEvent;
    const sessionId = upsert.sessionId;
    if (!sessionId || !upsert.session) {
      return;
    }

    // The same authority the workspace header uses. The delta carries no
    // `__provider`, so stamp the event's provider on before asking it.
    const title = getSessionTitle({ ...upsert.session, __provider: upsert.provider });

    setRecentConversations((previous) => {
      const index = previous.findIndex(
        (conversation) => conversation.sessionId === sessionId,
      );
      const byRecency = (a: RecentConversationListItem, b: RecentConversationListItem) => {
        const left = Date.parse(a.lastActivity ?? '');
        const right = Date.parse(b.lastActivity ?? '');
        return (Number.isFinite(right) ? right : 0) - (Number.isFinite(left) ? left : 0);
      };

      // Which project's rules judge this row: the one the delta names, else the
      // one the row already belongs to. No project means no rules, and a row the
      // reload would not list either way; the rest of the handler decides.
      const claimedProjectId = upsert.project?.projectId
        ?? (index >= 0 ? previous[index].projectId : null);
      const judgedProject = claimedProjectId
        ? projects.find((candidate) => candidate.projectId === claimedProjectId)
        : undefined;
      // Unlike the Projects list there is no fall-back to a known earlier title: a
      // live-inserted row is titled by the session id when it has no name, and a
      // rule may legitimately match ids, so falling back would keep a row the
      // reload drops — the asymmetry this feed is being brought in line with.
      const summary = typeof upsert.session?.summary === 'string' ? upsert.session.summary : '';
      const isHidden = Boolean(
        judgedProject
        && isSessionHiddenByProjectFilter?.(
          judgedProject,
          { id: String(sessionId), summary },
          NO_EXEMPT_SESSION_IDS,
          false,
        ),
      );

      if (index < 0) {
        // Nothing to insert: the reload this feed must match would not list it.
        if (isHidden) {
          return previous;
        }
        // A session created while this list was already loaded (New Session →
        // first message) is in no page the list holds. The delta carries the
        // project, so insert the row and let recency place it. Without a project
        // identity the row cannot be opened, so it is left for the next reload.
        if (!upsert.project || !upsert.provider) {
          return previous;
        }

        const inserted = [
          ...previous,
          {
            sessionId,
            provider: upsert.provider,
            projectId: upsert.project.projectId,
            projectDisplayName: upsert.project.displayName,
            sessionTitle: title,
            lastActivity: upsert.session?.lastActivity ?? new Date().toISOString(),
            forkedFromSessionId: null,
          } satisfies RecentConversationListItem,
        ].sort(byRecency);

        // A full page whose newest-sorted slot is the tail means the row belongs
        // to a page not loaded yet; load-more will bring it in.
        if (previous.length >= 40 && inserted[inserted.length - 1].sessionId === sessionId) {
          return previous;
        }
        return inserted;
      }

      // A row that has since been named into a rule leaves the list. The header
      // count is left alone: it is re-derived from the server by the next reload,
      // and the membership is what has to match.
      if (isHidden) {
        return previous.filter((conversation) => conversation.sessionId !== sessionId);
      }

      // Input/output in a session bumps its `lastActivity` on the server; take
      // it only when it moves forward so a stale delta never rewinds a row.
      const incomingActivity = upsert.session?.lastActivity;
      const incomingTime = incomingActivity ? Date.parse(String(incomingActivity)) : Number.NaN;
      const currentTimeValue = Date.parse(previous[index].lastActivity ?? '');
      const activityAdvanced = Number.isFinite(incomingTime)
        && (!Number.isFinite(currentTimeValue) || incomingTime > currentTimeValue);

      // An unchanged title and activity must keep the previous array so an unrelated upsert does not re-render.
      if (previous[index].sessionTitle === title && !activityAdvanced) {
        return previous;
      }

      const next = [...previous];
      next[index] = {
        ...next[index],
        sessionTitle: title,
        ...(activityAdvanced ? { lastActivity: String(incomingActivity) } : {}),
      };

      if (!activityAdvanced) {
        return next;
      }

      // The list is ordered by recency, so a row that just moved forward goes
      // to its sorted place. Stable sort keeps rows with equal times in order.
      return next.sort(byRecency);
    });
    // `projects` is a dependency rather than a ref: the handler judges new deltas
    // against the rules it was last rendered with, and a rules edit re-subscribes
    // instead of leaving a window where a stale rule set decides.
  }), [subscribe, projects, isSessionHiddenByProjectFilter]);

  useEffect(() => {
    if (searchMode !== 'conversations' || debouncedSearchQuery.length >= 2) {
      return;
    }

    reloadRecentConversations();
  }, [debouncedSearchQuery, reloadRecentConversations, searchMode]);

  useEffect(() => {
    if (searchMode !== 'archived') {
      return;
    }

    // Refresh archive contents when the archived tab opens so restore actions
    // and background synchronizer updates are reflected without a full reload.
    void fetchArchivedSessions();
  }, [fetchArchivedSessions, searchMode]);

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

  // Debounced conversation search with SSE streaming
  useEffect(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    const query = debouncedSearchQuery;
    if (searchMode !== 'conversations' || query.length < 2) {
      searchSeqRef.current += 1;
      setConversationResults(null);
      setSearchProgress(null);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    setConversationResults(null);
    setSearchProgress(null);
    const seq = ++searchSeqRef.current;

    if (seq !== searchSeqRef.current) {
      return;
    }

    const url = api.searchConversationsUrl(query);
    const es = new EventSource(url);
    eventSourceRef.current = es;

    const accumulated: ConversationProjectResult[] = [];
    let titleResults: SessionTitleSearchResult[] = [];
    let totalMatches = 0;

    es.addEventListener('title-results', (evt) => {
      if (seq !== searchSeqRef.current) { es.close(); return; }
      try {
        const data = JSON.parse(evt.data) as { titleResults: SessionTitleSearchResult[] };
        titleResults = Array.isArray(data.titleResults) ? data.titleResults : [];
        setConversationResults({
          results: [...accumulated],
          titleResults: [...titleResults],
          totalMatches,
          query,
        });
      } catch {
        // Ignore malformed SSE data
      }
    });

    es.addEventListener('result', (evt) => {
      if (seq !== searchSeqRef.current) { es.close(); return; }
      try {
        const data = JSON.parse(evt.data) as {
          projectResult: ConversationProjectResult;
          totalMatches: number;
          scannedProjects: number;
          totalProjects: number;
        };
        accumulated.push(data.projectResult);
        totalMatches = data.totalMatches;
        setConversationResults({
          results: [...accumulated],
          titleResults: [...titleResults],
          totalMatches,
          query,
        });
        setSearchProgress({ scannedProjects: data.scannedProjects, totalProjects: data.totalProjects });
      } catch {
        // Ignore malformed SSE data
      }
    });

    es.addEventListener('progress', (evt) => {
      if (seq !== searchSeqRef.current) { es.close(); return; }
      try {
        const data = JSON.parse(evt.data) as { totalMatches: number; scannedProjects: number; totalProjects: number };
        totalMatches = data.totalMatches;
        setSearchProgress({ scannedProjects: data.scannedProjects, totalProjects: data.totalProjects });
      } catch {
        // Ignore malformed SSE data
      }
    });

    es.addEventListener('done', () => {
      if (seq !== searchSeqRef.current) { es.close(); return; }
      es.close();
      eventSourceRef.current = null;
      setIsSearching(false);
      setSearchProgress(null);
      setConversationResults({
        results: [...accumulated],
        titleResults: [...titleResults],
        totalMatches,
        query,
      });
    });

    es.addEventListener('error', () => {
      if (seq !== searchSeqRef.current) { es.close(); return; }
      es.close();
      eventSourceRef.current = null;
      setIsSearching(false);
      setSearchProgress(null);
      setConversationResults({
        results: [...accumulated],
        titleResults: [...titleResults],
        totalMatches,
        query,
      });
    });

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [debouncedSearchQuery, searchMode]);

  // All sidebar state keys (expanded, starred, loading, etc.) use the DB
  // `projectId` as their identifier after the migration.
  const toggleProject = useCallback(
    (projectId: string) => {
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

  const handleSessionClick = useCallback(
    (session: SessionWithProvider, projectId: string) => {
      // Tag the session with its owning projectId so downstream handlers
      // can correlate it with the selectedProject in the app state.
      onSessionSelect({ ...session, __projectId: projectId });
    },
    [onSessionSelect],
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

  const getProjectSessions = useCallback((project: Project) => getAllSessions(project), []);

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

  const filteredArchivedSessions = useMemo(() => {
    const normalizedSearch = debouncedSearchQuery.trim().toLowerCase();
    if (!normalizedSearch) {
      return archivedSessions;
    }

    return archivedSessions.filter((session) => {
      const searchableFields = [
        session.sessionTitle,
        session.projectDisplayName,
        session.projectPath ?? '',
        session.provider,
      ];

      return searchableFields.some((value) => value.toLowerCase().includes(normalizedSearch));
    });
  }, [archivedSessions, debouncedSearchQuery]);

  const filteredArchivedProjects = useMemo(() => {
    const normalizedSearch = debouncedSearchQuery.trim().toLowerCase();
    if (!normalizedSearch) {
      return archivedProjects;
    }

    return archivedProjects.filter((project) => {
      const projectMatches = [
        project.displayName,
        project.fullPath || '',
      ].some((value) => value.toLowerCase().includes(normalizedSearch));

      if (projectMatches) {
        return true;
      }

      return getAllSessions(project).some((session) => {
        const sessionSummary =
          typeof session.summary === 'string' && session.summary.trim().length > 0
            ? session.summary
            : typeof session.name === 'string'
              ? session.name
              : '';

        return [
          sessionSummary,
          session.__provider,
        ].some((value) => value.toLowerCase().includes(normalizedSearch));
      });
    });
  }, [archivedProjects, debouncedSearchQuery]);

  // Keyed by projectId so the rename survives display-name mutations that arrive
  // while the input is open.
  const startEditingProject = useCallback((project: Project) => {
    setActiveRename({ target: 'project', id: project.projectId, draft: project.displayName });
  }, []);

  const startEditingSession = useCallback(
    (projectId: string, sessionId: string, initialName: string) => {
      setActiveRename({ target: 'session', id: sessionId, projectId, draft: initialName });
    },
    [],
  );

  const updateRenameDraft = useCallback((draft: string) => {
    setActiveRename((previous) => (previous ? { ...previous, draft } : previous));
  }, []);

  const cancelRename = useCallback(() => {
    setActiveRename(null);
  }, []);

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
    [paletteOps],
  );

  const showDeleteSessionConfirmation = useCallback(
    (
      sessionId: string,
      sessionTitle: string,
      options: { isArchived?: boolean } = {},
    ) => {
      setPendingDeletion({
        kind: 'session',
        sessionId,
        sessionTitle,
        isArchived: Boolean(options.isArchived),
      });
    },
    [],
  );

  const confirmDeleteSession = useCallback(async (hardDelete = false) => {
    if (pendingDeletion?.kind !== 'session') {
      return;
    }

    const { sessionId } = pendingDeletion;
    setPendingDeletion(null);

    try {
      const response = await api.deleteSession(sessionId, hardDelete);

      if (response.ok) {
        onSessionDelete?.(sessionId);
        // Same gap as rename: nothing refetched the recents feed, so the row the
        // user just archived stayed in the list. Archiving keeps the session, so
        // only the non-archived total moves.
        setRecentConversations((previous) => {
          const remaining = previous.filter((conversation) => conversation.sessionId !== sessionId);
          if (remaining.length !== previous.length) {
            setRecentConversationsTotal((total) => Math.max(0, total - 1));
          }
          return remaining;
        });
        await fetchArchivedSessions();
      } else {
        const errorText = await response.text();
        console.error('[Sidebar] Failed to delete session:', {
          status: response.status,
          error: errorText,
        });
        alert(t('messages.deleteSessionFailed'));
      }
    } catch (error) {
      console.error('[Sidebar] Error deleting session:', error);
      alert(t('messages.deleteSessionError'));
    }
  }, [fetchArchivedSessions, onSessionDelete, pendingDeletion, t]);

  const requestProjectDelete = useCallback(
    (project: Project) => {
      setPendingDeletion({
        kind: 'project',
        project,
        sessionCount: getProjectSessions(project).length,
      });
    },
    [getProjectSessions],
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
  }, [pendingDeletion, onProjectDelete, t]);

  const handleProjectSelect = useCallback(
    (project: Project) => {
      onProjectSelect(project);
      setCurrentProject(project);
    },
    [onProjectSelect, setCurrentProject],
  );

  const openArchivedSession = useCallback((session: ArchivedSessionListItem) => {
    const activeProject = session.projectId
      ? projects.find((candidate) => candidate.projectId === session.projectId)
      : null;
    const archivedProject = session.projectId
      ? archivedProjects.find((candidate) => candidate.projectId === session.projectId)
      : null;
    const matchingProject = activeProject ?? archivedProject ?? null;
    const sessionPayload: ProjectSession = {
      id: session.sessionId,
      summary: session.sessionTitle,
      __provider: session.provider,
      __projectId: matchingProject?.projectId ?? session.projectId ?? undefined,
    };

    // Archived sessions still need a selected project context. Active projects
    // come from the normal sidebar list, while archived-project sessions resolve
    // through the archive payload loaded by this controller.
    if (matchingProject) {
      handleProjectSelect(matchingProject);
    }

    onSessionSelect(sessionPayload);
  }, [archivedProjects, handleProjectSelect, onSessionSelect, projects]);

  const restoreArchivedProject = useCallback(async (projectId: string) => {
    try {
      const response = await api.restoreProject(projectId);
      if (!response.ok) {
        const errorText = await response.text();
        console.error('[Sidebar] Failed to restore project:', {
          status: response.status,
          error: errorText,
        });
        alert(t('messages.restoreProjectFailed', 'Failed to restore project. Please try again.'));
        return;
      }

      await Promise.all([
        Promise.resolve(onRefresh()),
        fetchArchivedSessions(),
      ]);
    } catch (error) {
      console.error('[Sidebar] Error restoring project:', error);
      alert(t('messages.restoreProjectError', 'Error restoring project. Please try again.'));
    }
  }, [fetchArchivedSessions, onRefresh, t]);

  const restoreArchivedSession = useCallback(async (sessionId: string) => {
    try {
      const response = await api.restoreSession(sessionId);
      if (!response.ok) {
        const errorText = await response.text();
        console.error('[Sidebar] Failed to restore session:', {
          status: response.status,
          error: errorText,
        });
        alert(t('messages.restoreSessionFailed', 'Failed to restore session. Please try again.'));
        return;
      }

      await Promise.all([
        Promise.resolve(onRefresh()),
        fetchArchivedSessions(),
      ]);
    } catch (error) {
      console.error('[Sidebar] Error restoring session:', error);
      alert(t('messages.restoreSessionError', 'Error restoring session. Please try again.'));
    }
  }, [fetchArchivedSessions, onRefresh, t]);

  const refreshProjects = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([
        Promise.resolve(onRefresh()),
        fetchArchivedSessions(),
        searchMode === 'conversations'
          ? fetchRecentConversationsPage(0, false)
          : Promise.resolve(),
      ]);
    } finally {
      setIsRefreshing(false);
    }
  }, [fetchArchivedSessions, fetchRecentConversationsPage, onRefresh, searchMode]);

  const updateSessionSummary = useCallback(
    // `_projectId` and `_provider` are preserved for compatibility with
    // existing sidebar callback signatures; backend rename only needs sessionId.
    async (_projectId: string, sessionId: string, summary: string, _provider: LLMProvider) => {
      const trimmed = summary.trim();
      if (!trimmed) {
        setActiveRename(null);
        return;
      }
      try {
        const response = await api.renameSession(sessionId, trimmed);
        if (response.ok) {
          // onRefresh reloads projects, not the recents feed, so a row renamed
          // from the Conversations list kept its old title until the next fetch.
          // Patching in place also preserves the pages already loaded past the
          // first, which refetching page zero would discard.
          setRecentConversations((previous) => previous.map((conversation) => (
            conversation.sessionId === sessionId
              ? { ...conversation, sessionTitle: trimmed }
              : conversation
          )));
          // The archived list holds its own copy of the title too, and the
          // rename produced no event it could follow: the server's upsert
          // builder emits nothing for an archived row. Patch it here, or a
          // session renamed while archived keeps its old name in that list.
          setArchivedSessions((previous) => previous.map((session) => (
            session.sessionId === sessionId
              ? { ...session, sessionTitle: trimmed }
              : session
          )));
          await onRefresh();
        } else {
          console.error('[Sidebar] Failed to rename session:', response.status);
          alert(t('messages.renameSessionFailed'));
        }
      } catch (error) {
        console.error('[Sidebar] Error renaming session:', error);
        alert(t('messages.renameSessionError'));
      } finally {
        setActiveRename(null);
      }
    },
    [onRefresh, t],
  );

  /**
   * Branches a session and opens the copy.
   *
   * The new row arrives over the websocket as a `session_upserted`, so nothing
   * is refetched here — the sidebar already has it by the time this navigates.
   */
  const forkSession = useCallback(
    async (session: SessionWithProvider) => {
      try {
        const response = await api.forkSession(session.id);
        const payload = await response.json();
        const forkedSessionId = payload?.data?.sessionId;
        if (!response.ok || typeof forkedSessionId !== 'string') {
          throw new Error(payload?.message || `HTTP ${response.status}`);
        }

        onSessionSelect({
          id: forkedSessionId,
          summary: payload.data.sessionName,
          __provider: session.__provider,
          __projectId: session.__projectId,
        } as ProjectSession);
      } catch (error) {
        console.error('[Sidebar] Error forking session:', error);
        alert(t('messages.forkSessionError'));
      }
    },
    [onSessionSelect, t],
  );

  const collapseSidebar = useCallback(() => {
    setSidebarVisible(false);
  }, [setSidebarVisible]);

  const expandSidebar = useCallback(() => {
    setSidebarVisible(true);
  }, [setSidebarVisible]);

  return {
    isSidebarCollapsed,
    isProjectExpanded,
    activeRename,
    showNewProject,
    initialSessionsLoaded,
    currentTime,
    isRefreshing,
    searchFilter,
    deletingProjects,
    loadingMoreProjects,
    pendingDeletion,
    showVersionModal,
    filteredProjects,
    runningSessionsCount,
    archivedProjects: filteredArchivedProjects,
    archivedSessions: filteredArchivedSessions,
    archivedSessionsCount: archivedProjects.length + archivedSessions.length,
    isArchivedSessionsLoading,
    recentConversations,
    // A row inserted from a live event is not in the server total yet, so never read lower than the rows shown.
    recentConversationsTotal: Math.max(recentConversationsTotal, recentConversations.length),
    recentConversationsHasMore,
    isRecentConversationsLoading,
    isLoadingMoreRecentConversations,
    recentConversationsError,
    reloadRecentConversations,
    loadMoreRecentConversations,
    toggleProject,
    handleSessionClick,
    forkSession,
    toggleStarProject,
    isProjectStarred,
    getProjectSessions,
    loadMoreSessionsForProject,
    startEditingProject,
    startEditingSession,
    updateRenameDraft,
    cancelRename,
    saveProjectName,
    showDeleteSessionConfirmation,
    confirmDeleteSession,
    requestProjectDelete,
    confirmDeleteProject,
    handleProjectSelect,
    openArchivedSession,
    restoreArchivedProject,
    restoreArchivedSession,
    refreshProjects,
    updateSessionSummary,
    collapseSidebar,
    expandSidebar,
    setShowNewProject,
    searchMode,
    setSearchMode,
    conversationResults,
    isSearching,
    searchProgress,
    clearConversationResults: useCallback(() => {
      searchSeqRef.current += 1;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      setIsSearching(false);
      setSearchProgress(null);
      setConversationResults(null);
    }, []),
    setSearchFilter,
    setPendingDeletion,
    setShowVersionModal,
  };
}
