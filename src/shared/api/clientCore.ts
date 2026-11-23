/**
 * The first half of the endpoint map: auth through taskmaster.
 *
 * `apiCore` and `apiTail` are composed into the single `api` object in `client.ts`. The
 * split exists so no one file carries the whole map (the package's own size ratchet), while
 * the extraction still breaks the `voiceConfig.ts` <-> `index.ts` file-level value cycle.
 */
import { getStoredAuthToken, readAuthLapseReport } from '@/shared/authToken';
import type {
  ArchitectureRefreshStartResult,
  ArchitectureRefreshStatus,
  OAuthConsentDecisionRequest,
  SessionMessagesQuery,
} from '@/shared/types';
import {
  authenticatedFetch,
  del,
  fileContentPath,
  get,
  patch,
  post,
  put,
  query,
  readApiJson,
  sessionMessagesUrl,
} from '@/shared/api/requests';
import type { ApiRequestOptions, QueryValue } from '@/shared/api/requests';

export const apiCore = {
  // Auth endpoints (no token required)
  auth: {
    status: () => fetch('/api/auth/status'),
    // The one endpoint that carries no credential is also the one that can carry
    // the reason the last session ended: the diagnostic rides along with the
    // login so the server's `[AuthReq]` line can print it. The server reads only
    // username and password for the authentication decision; the report changes
    // nothing about it.
    login: (username: string, password: string) => fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, clientClock: readAuthLapseReport() }),
    }),
    register: (username: string, password: string) => fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
    refresh: () => post('/api/auth/refresh'),
    user: () => get('/api/auth/user'),
  },

  // The OAuth consent hand-off: the SPA served at `/oauth/consent` reads the request's
  // validated context and submits the user's decision here, both with the ordinary bearer
  // JWT. `search` is the browser's own query string with its leading `?`, passed through
  // unchanged so the server re-runs the same `(client_id, redirect_uri)` validation that
  // `/oauth/authorize` already accepted.
  oauthConsent: {
    context: (search: string) => get(`/api/oauth/authorize/context${search}`),
    decide: (decision: OAuthConsentDecisionRequest) =>
      post('/api/oauth/authorize/decision', decision),
  },

  // Protected endpoints
  // config endpoint removed - no longer needed (frontend uses window.location)
  // After the projectName → projectId migration the path/query identifier is
  // the DB-assigned `projectId`; parameter names reflect that for clarity.
  // `keepSessionIds` (running / attention / selected) stay visible even when they match a project's name filter.
  projects: ({ keepSessionIds }: { keepSessionIds?: string[] } = {}) =>
    get(`/api/projects${query({ keepSessionIds: keepSessionIds?.join(',') })}`),
  archivedProjects: () => get('/api/projects/archived'),
  /**
   * One session's host state: its row (stored lifecycle mode, whether a process
   * runs it, who occupies it) and the hosts holding it, in the listing's shape.
   *
   * The reason this exists as a client method at all: a session's stored mode is
   * not on the session object the workspace already holds, and this is the face
   * that publishes it. It is asked by id because the whole listing carries one row
   * per stored session — thousands — and a caller that wants one fact must not
   * receive them all. A session the server has no row for answers `sessions: []`,
   * which callers read as the column's own default (per-run).
   */
  sessionHostState: (sessionId: string) => get(`/api/session-hosts/${encodeURIComponent(sessionId)}`),
  projectSessions: (
    projectId: string,
    {
      limit = 20,
      offset = 0,
      includeHidden,
      keepSessionIds,
    }: { limit?: number; offset?: number; includeHidden?: boolean; keepSessionIds?: string[] } = {},
    options: ApiRequestOptions = {},
  ) =>
    get(
      `/api/projects/${encodeURIComponent(projectId)}/sessions${query({
        limit,
        offset,
        includeHidden,
        keepSessionIds: keepSessionIds?.join(','),
      })}`,
      options,
    ),
  // Project-level session-name filter: one regex per entry in `hide`; preview never persists.
  previewProjectSessionFilter: (projectId: string, hide: string[]) =>
    post(`/api/projects/${encodeURIComponent(projectId)}/session-filter/preview`, { hide }),
  saveProjectSessionFilter: (projectId: string, hide: string[]) =>
    put(`/api/projects/${encodeURIComponent(projectId)}/session-filter`, { hide }),
  projectTaskmaster: (projectId: string) =>
    get(`/api/projects/${encodeURIComponent(projectId)}/taskmaster`),
  // Quay display endpoints (read-only). `refresh` bypasses the backend's TTL cache.
  quayStatus: (projectId: string) =>
    get(`/api/quay/${encodeURIComponent(projectId)}/status`),
  /**
   * The cheap, cross-project task/goal counts the landing overview's third panel reads.
   *
   * The eager cross-project reading: driver state + task counts for every quay project,
   * served from the backend's per-project TTL (a poll inside the window spawns no CLI).
   * One request for every quay-configured project rather than one snapshot request
   * per project: the snapshot is the lazy tier (in-flight tasks and the gantt),
   * and the overview must not spawn a CLI per project just to draw a count.
   */
  quayFleetSummary: () => get('/api/quay/fleet-summary'),
  /**
   * The cockpit's initiative view: active initiatives (charter, member cells, dependency
   * edges) plus the `initiative-decision` queue and the liaison self-decisions the spot-check
   * group samples. An unavailable fleet is a `{ok:false, available:false, reason}` body, not
   * an HTTP failure — the queue survives a fleet CLI that cannot be spawned.
   */
  quayInitiatives: () => get('/api/quay/initiatives'),
  /** Records one human ruling through the fleet's own `initiative decide` (by=human, kind=fact). */
  quayInitiativeDecide: (slug: string, body: unknown) =>
    post(`/api/quay/initiatives/${encodeURIComponent(slug)}/decide`, body),
  /**
   * One pending ruling's 「反方」(counter-voice). The server looks the item up in its own queue
   * reading (never from this request), generates on the first ask, caches per item and answers
   * `{state:'unavailable', reason}` when the feature is off, over budget or the model failed —
   * the ruling itself never waits on it.
   */
  quayInitiativeCounterVoice: (attentionId: string) =>
    get(`/api/quay/initiatives/${encodeURIComponent(attentionId)}/counter-voice`),
  /**
   * The cockpit's card projection: one entry per OPEN card, in the providers' order, grouped
   * and ranked by them. The projection filters ended cards; the cockpit never re-orders and
   * never infers a default option.
   */
  cockpitCards: () => get('/api/cockpit/cards'),
  /**
   * One confirmation: exactly one of `optionId` / `replyText`, and the revision the card was
   * read at. A stale revision is a `REVISION_CONFLICT` (409), and the ledger makes a repeat of
   * an accepted `(card, revision)` `ALREADY_CONFIRMED` rather than a second execution.
   */
  cockpitConfirmCard: (request: {
    cardId: string;
    revision: number;
    optionId?: string;
    replyText?: string;
  }) => post('/api/cockpit/cards/confirm', request),
  /**
   * Re-sends ONLY the feedback for a card whose action already ran: the same `feedbackId` and
   * params, never a second action. Answers an explicit reason when the provider declares no
   * feedback executor.
   */
  cockpitResendFeedback: (cardId: string) =>
    post('/api/cockpit/cards/feedback/resend', { cardId }),
  /**
   * Discards a card without sending anything back to its conversation: the server asks the
   * provider's feedback executor for a `dismissed` receipt with `dismiss: true`, and the card
   * settles instead of returning to the queue. A stale revision is refused exactly like a
   * confirmation's.
   */
  cockpitDismissCard: (request: { cardId: string; revision: number }) =>
    post('/api/cockpit/cards/dismiss', request),
  /**
   * One card's brief: the BriefSpec document flattened beside its identity, status and spend.
   * A fallback is still HTTP 200 — `status` and `reason` say why no model brief was drawn, so
   * the drawer shows the reason instead of treating it as a transport failure.
   */
  cockpitCardBrief: (cardId: string) =>
    get(`/api/cockpit/cards/${encodeURIComponent(cardId)}/brief`),
  quaySnapshot: (
    projectId: string,
    { refresh = false, hours }: { refresh?: boolean; hours?: number } = {},
  ) =>
    get(
      `/api/quay/${encodeURIComponent(projectId)}/snapshot${query({
        // The Loop pulse window rides the snapshot request: one reading of one snapshot, so
        // the lanes and the rest of the panel can never disagree about which window they show.
        hours: hours ?? undefined,
        refresh: refresh ? '1' : undefined,
      })}`,
    ),
  /**
   * The lanes-only reading behind the title bar's mini gantt: one `quay lanes` read for one
   * window, sharing the backend's TTL and in-flight dedupe with the snapshot. Polled by
   * `useSessionPulse` every 30 seconds; it deliberately does not fetch the rest of the snapshot.
   */
  quayLanes: (projectId: string, hours?: number) =>
    get(`/api/quay/${encodeURIComponent(projectId)}/lanes${query({ hours })}`),
  /**
   * What this session's own message text names: the mentioned tasks (joined against the task
   * store) and goals. Read once when the title bar popover opens; never polled.
   */
  quaySessionMentions: (projectId: string, sessionId: string) =>
    get(
      `/api/quay/${encodeURIComponent(projectId)}/session-mentions${query({ sessionId })}`,
    ),
  /**
   * The tasks this session created or edited, with the stage each one has reached.
   *
   * Returned as the raw `Response` (like `quaySessionMentions`) because the caller must tell a
   * `503`/`404` — the endpoint or the project/session is not available — apart from any other
   * failure, and hide only that block instead of blanking the rest of the session panel.
   */
  quaySessionTaskChain: (projectId: string, sessionId: string) =>
    get(
      `/api/quay/${encodeURIComponent(projectId)}/session-task-chain${query({ sessionId })}`,
    ),
  /**
   * The project's pinned 「对人接口会话」, read from the fleet registry (`projects[].interfaceSessionId`).
   *
   * The cockpit's push-to-talk routes an unmatched phrase to this conversation. The answer is the
   * fleet CLI's own document (`{ok, project, interfaceSessionId}`, or `{ok:false, reason}`) so the
   * caller can state WHY a pin could not be read instead of treating every failure as "none".
   */
  quayInterfaceSession: (projectId: string) =>
    get(`/api/quay/${encodeURIComponent(projectId)}/interface-session`),
  /** Pins `sessionId` as the project's target conversation. Writes the fleet registry, not local state. */
  pinQuayInterfaceSession: (projectId: string, sessionId: string) =>
    put(`/api/quay/${encodeURIComponent(projectId)}/interface-session`, { sessionId }),
  /** Un-pins the project's target conversation (idempotent, as the fleet CLI's `clear` is). */
  clearQuayInterfaceSession: (projectId: string) =>
    del(`/api/quay/${encodeURIComponent(projectId)}/interface-session`),
  /**
   * The browser's last-opened session (`ui_last_opened_session`), or `{ sessionId: null }`.
   *
   * The cockpit's fallback target when a project has no pinned conversation. It carries no
   * project of its own; the caller pairs it with the session's own details before routing.
   */
  quayLastOpenedSession: () => get('/api/quay/last-opened-session'),
  /**
   * The on-demand architecture reading for one session (ADR-005 decision 2):
   * both Mermaid documents, the counters and the provenance, generated server-
   * side from the project's `.archguard` cache. The response body is the result
   * itself, not a `{ success, data }` envelope.
   *
   * `hops` is the server-side BFS depth and therefore a REQUEST parameter (it
   * changes the payload and its content-addressed cache key), unlike the local
   * `maxNodes` view filter: the panel's hops control re-enters this request.
   *
   * `filter` is the optional element/relation selection. It is a REQUEST
   * parameter for the same reason as `hops`: the server computes the BFS and
   * the node budget on the filtered graph. Both fields are optional and an
   * ABSENT field is "no filter" (the old reading), so an older client is
   * unaffected; the element axis is only sent for the entity graph.
   */
  architectureGraph: (
    projectId: string,
    sessionId: string,
    hops?: number,
    filter?: {
      readonly kinds?: readonly string[];
      /**
       * The element filter's per-kind "keep mentioned" switches. Same
       * vocabulary as `kinds`; omitted when empty, so a default request carries
       * no new field.
       */
      readonly keepMentionedKinds?: readonly string[];
      readonly relations?: readonly string[];
      /** Manual pins: entity ids the reader added as roots. */
      readonly extraSeeds?: readonly string[];
      /** Manual removals: entity ids dropped before traversal. */
      readonly excludeIds?: readonly string[];
    },
  ) =>
    post('/api/architecture/graph', {
      projectId,
      sessionId,
      ...(hops === undefined ? {} : { hops }),
      ...(filter?.kinds === undefined ? {} : { kinds: filter.kinds }),
      ...(filter?.keepMentionedKinds === undefined ? {} : { keepMentionedKinds: filter.keepMentionedKinds }),
      ...(filter?.relations === undefined ? {} : { relations: filter.relations }),
      ...(filter?.extraSeeds === undefined ? {} : { extraSeeds: filter.extraSeeds }),
      ...(filter?.excludeIds === undefined ? {} : { excludeIds: filter.excludeIds }),
    }),
  /**
   * Project-wide entity search and `(file, name)` re-anchoring for manual
   * curation (the architecture tab's "项目其它" result group).
   *
   * The response body is the result itself, not a `{ success, data }` envelope.
   * Exactly one of `query` / `resolve` is sent per request.
   */
  architectureSearch: (
    projectId: string,
    request:
      | {
          readonly query: string;
          readonly limit?: number;
          readonly kinds?: readonly string[];
        }
      | { readonly resolve: readonly { readonly name: string; readonly file: string }[] },
  ) =>
    post('/api/architecture/search', {
      projectId,
      ...request,
    }),
  /**
   * The on-demand mention provenance for one graph selection: where in the
   * session's transcript the selected entity — or the two entities of a
   * relation — were named. `includeToolResults` opts into the noisy tool-output
   * tier for THIS query only; the graph's own extraction is unchanged. The
   * response body is the result itself (`{ mentions, edge?, truncated }`), not a
   * `{ success, data }` envelope.
   */
  architectureMentions: (
    projectId: string,
    sessionId: string,
    target: {
      readonly entityIds?: readonly string[];
      readonly edge?: { readonly from: string; readonly to: string };
      readonly includeToolResults?: boolean;
      readonly limit?: number;
    },
  ) =>
    post('/api/architecture/mentions', {
      projectId,
      sessionId,
      ...(target.entityIds === undefined ? {} : { entityIds: target.entityIds }),
      ...(target.edge === undefined ? {} : { edge: target.edge }),
      ...(target.includeToolResults === undefined ? {} : { includeToolResults: target.includeToolResults }),
      ...(target.limit === undefined ? {} : { limit: target.limit }),
    }),
  /**
   * Starts the manual ArchGuard re-analysis for one project and answers the
   * started-or-joined job (`202`) with `{ jobId, coalesced, status }`.
   *
   * The body carries `projectId` ONLY: the server resolves the directory itself,
   * and a concurrent start for the same project root joins the running job
   * (`coalesced: true`) instead of spawning a second analysis. The body is
   * parsed here, so callers never touch a `Response`.
   */
  architectureRefresh: async (projectId: string): Promise<ArchitectureRefreshStartResult> =>
    readApiJson<ArchitectureRefreshStartResult>(
      await post('/api/architecture/refresh', { projectId }),
    ),
  /**
   * The project's current re-analysis status (`idle | running | succeeded |
   * failed`) — the tab's activation read and its running-state poll. Parsed here
   * for the same reason as the start verb.
   */
  architectureRefreshStatus: async (projectId: string): Promise<ArchitectureRefreshStatus> =>
    readApiJson<ArchitectureRefreshStatus>(
      await get(`/api/architecture/refresh/status${query({ projectId })}`),
    ),
  renameProject: (projectId: string, displayName: string) =>
    put(`/api/projects/${projectId}/rename`, { displayName }),
  restoreProject: (projectId: string) =>
    post(`/api/projects/${encodeURIComponent(projectId)}/restore`),
  // `hardDelete` => server `?force=true` (remove DB row + Claude *.jsonl + sessions rows for path).
  deleteProject: (projectId: string, hardDelete = false) =>
    del(`/api/projects/${projectId}${query({ force: hardDelete })}`),
  createProject: (projectData: unknown) => post('/api/projects/create-project', projectData),
  migrateLegacyProjectStars: (projectIds: string[]) =>
    post('/api/projects/migrate-legacy-stars', { projectIds }),
  toggleProjectStar: (projectId: string) =>
    post(`/api/projects/${encodeURIComponent(projectId)}/toggle-star`),
  // EventSource cannot send an Authorization header, so the token rides along as
  // a query parameter on the streaming endpoints below.
  cloneProjectProgressUrl: (params: Record<string, QueryValue>) =>
    `/api/projects/clone-progress${query({ ...params, token: getStoredAuthToken() })}`,
  searchConversationsUrl: (searchQuery: string, limit = 50) =>
    `/api/providers/search/sessions${query({
      q: searchQuery,
      limit,
      token: getStoredAuthToken(),
    })}`,

  // Session endpoints. Provider/project metadata are resolved by the backend
  // from the session id.
  // Session deletion mirrors project deletion:
  // - default: archive only (`isArchived = 1`)
  // - hardDelete: remove the row and, by default, its persisted transcript file
  deleteSession: (sessionId: string, hardDelete = false) =>
    del(`/api/providers/sessions/${sessionId}${query({ force: hardDelete })}`),
  getArchivedSessions: () => get('/api/providers/sessions/archived'),
  // Resolves one session (by app id or provider-native id) to its metadata and
  // owning project — used when a /session/<id> URL isn't in loaded payloads.
  sessionDetails: (sessionId: string) =>
    get(`/api/providers/sessions/${encodeURIComponent(sessionId)}`),
  runningSessions: () => get('/api/providers/sessions/running'),
  // Sessions that have stopped and are waiting on the user: a finished turn, a
  // failed turn, or an unanswered tool approval. Whole-list read because the
  // list spans projects and must be complete.
  awaitingReplySessions: () => get('/api/providers/sessions/awaiting-reply'),
  // Takes one session off that list without replying to it. The other two ways
  // off are automatic (replying, answering the approval).
  dismissAwaitingReply: (sessionId: string) =>
    del(`/api/providers/sessions/${encodeURIComponent(sessionId)}/awaiting-reply`),
  recentConversations: ({ limit = 40, offset = 0 }: { limit?: number; offset?: number } = {}) =>
    get(`/api/providers/sessions/recent${query({ limit, offset })}`),
  providerSessionId: (sessionId: string) =>
    get(`/api/providers/sessions/${encodeURIComponent(sessionId)}/provider-id`),
  restoreSession: (sessionId: string) => post(`/api/providers/sessions/${sessionId}/restore`),
  // Creates an independent session holding this one's conversation up to
  // `upToAnchorId` (all of it when omitted). The source is left untouched.
  forkSession: (sessionId: string, body: { upToAnchorId?: string; title?: string } = {}) =>
    post(`/api/providers/sessions/${encodeURIComponent(sessionId)}/fork`, body),
  renameSession: (sessionId: string, summary: string) =>
    put(`/api/providers/sessions/${sessionId}`, { summary }),
  // Stores the order a project's session rows were dragged into. The whole
  // list is sent because a single drop renumbers every row below it.
  reorderProjectSessions: (projectId: string, sessionIds: string[]) =>
    put(`/api/providers/projects/${encodeURIComponent(projectId)}/session-order`, { sessionIds }),

  // Scheduled messages: send a message to a session at a future time.
  scheduledMessages: {
    list: (sessionId?: string) =>
      get(`/api/scheduled-messages${sessionId ? query({ sessionId }) : ''}`),
    create: (body: { sessionId: string; content: string; scheduledFor: string; options?: unknown }) =>
      post('/api/scheduled-messages', body),
    cancel: (id: string) => del(`/api/scheduled-messages/${encodeURIComponent(id)}`),
  },

  // Workspace file tree
  readFile: (projectId: string, filePath: string) =>
    get(`/api/file-tree/projects/${projectId}/file${query({ filePath })}`),
  // Raw bytes for a workspace file. The endpoint requires the auth header, so
  // media call sites fetch a blob through here instead of using a bare `src`.
  readFileBlob: (projectId: string, filePath: string, options: ApiRequestOptions = {}) =>
    get(fileContentPath(projectId, filePath), options),
  saveFile: (projectId: string, filePath: string, content: string) =>
    put(`/api/file-tree/projects/${projectId}/file`, { filePath, content }),
  // One directory for the lazy Files-tab tree. `directoryPath` is absolute;
  // an empty string asks for the project root. The listing is disk truth: the
  // endpoint applies no gitignore filtering (see `getFileTreeSearchIndex`).
  getDirectory: (projectId: string, directoryPath: string, options: ApiRequestOptions = {}) =>
    get(
      `/api/file-tree/projects/${projectId}/files?path=${encodeURIComponent(directoryPath)}`,
      options,
    ),
  // Flat `{name, path}[]` index shared by every filename-reference surface. A git
  // project is served from `git ls-files`, everything else from a bounded walk.
  getFileIndex: (projectId: string, options: ApiRequestOptions = {}) =>
    get(`/api/file-tree/projects/${projectId}/files-index`, options),
  // Flat `{name, path}[]` index for the Files-tab search: an unfiltered walk of
  // disk truth (gitignored paths, `.git/`, `node_modules/` included). Separate
  // from `getFileIndex` so search never sees the git-aligned reference set.
  getFileTreeSearchIndex: (projectId: string, options: ApiRequestOptions = {}) =>
    get(`/api/file-tree/projects/${projectId}/files-search-index`, options),

  // File operations
  createFile: (
    projectId: string,
    { path, type, name }: { path: string; type: string; name: string },
  ) => post(`/api/file-tree/projects/${projectId}/files/create`, { path, type, name }),

  renameFile: (projectId: string, { oldPath, newName }: { oldPath: string; newName: string }) =>
    put(`/api/file-tree/projects/${projectId}/files/rename`, { oldPath, newName }),

  deleteFile: (projectId: string, { path, type }: { path: string; type: string }) =>
    del(`/api/file-tree/projects/${projectId}/files`, { path, type }),

  // Uploads with a progress bar go through XMLHttpRequest, which needs the URL.
  uploadFilesUrl: (projectId: string) =>
    `/api/file-tree/projects/${encodeURIComponent(projectId)}/files/upload`,

  // Browse filesystem for project suggestions
  browseFilesystem: (dirPath: string | null = null) =>
    get(`/api/file-tree/browse-filesystem${query({ path: dirPath })}`),

  createFolder: (folderPath: string) => post('/api/file-tree/create-folder', { path: folderPath }),

  // Git endpoints. The `project` param carries the DB projectId post-migration.
  git: {
    status: (projectId: string, options: ApiRequestOptions = {}) =>
      get(`/api/git/status${query({ project: projectId })}`, options),
    diff: (projectId: string, filePath: string, options: ApiRequestOptions = {}) =>
      get(`/api/git/diff${query({ project: projectId, file: filePath })}`, options),
    commitDiff: (projectId: string, commit: string) =>
      get(`/api/git/commit-diff${query({ project: projectId, commit })}`),
    fileWithDiff: (projectId: string, filePath: string) =>
      get(`/api/git/file-with-diff${query({ project: projectId, file: filePath })}`),
    branches: (projectId: string, options: ApiRequestOptions = {}) =>
      get(`/api/git/branches${query({ project: projectId })}`, options),
    remoteStatus: (projectId: string) =>
      get(`/api/git/remote-status${query({ project: projectId })}`),
    commits: (
      projectId: string,
      { limit }: { limit?: number } = {},
      options: ApiRequestOptions = {},
    ) => get(`/api/git/commits${query({ project: projectId, limit })}`, options),
    checkout: (projectId: string, branch: string) =>
      post('/api/git/checkout', { project: projectId, branch }),
    createBranch: (projectId: string, branch: string) =>
      post('/api/git/create-branch', { project: projectId, branch }),
    deleteBranch: (projectId: string, branch: string, force = false) =>
      post('/api/git/delete-branch', { project: projectId, branch, force }),
    fetch: (projectId: string) => post('/api/git/fetch', { project: projectId }),
    pull: (projectId: string) => post('/api/git/pull', { project: projectId }),
    push: (projectId: string) => post('/api/git/push', { project: projectId }),
    publish: (projectId: string, branch: string) =>
      post('/api/git/publish', { project: projectId, branch }),
    discard: (projectId: string, file: string) =>
      post('/api/git/discard', { project: projectId, file }),
    deleteUntracked: (projectId: string, file: string) =>
      post('/api/git/delete-untracked', { project: projectId, file }),
    stage: (projectId: string, files: string[]) =>
      post('/api/git/stage', { project: projectId, files }),
    unstage: (projectId: string, files: string[]) =>
      post('/api/git/unstage', { project: projectId, files }),
    commit: (projectId: string, message: string, files: string[]) =>
      post('/api/git/commit', { project: projectId, message, files }),
    initialCommit: (projectId: string) => post('/api/git/initial-commit', { project: projectId }),
    init: (projectId: string) => post('/api/git/init', { project: projectId }),
    revertLocalCommit: (projectId: string) =>
      post('/api/git/revert-local-commit', { project: projectId }),
    generateCommitMessage: (projectId: string, files: string[], provider: string) =>
      post('/api/git/generate-commit-message', { project: projectId, files, provider }),
  },

  worktrees: {
    list: (projectId: string) => get(`/api/worktrees${query({ project: projectId })}`),
    create: (
      projectId: string,
      { branch, baseBranch }: { branch: string; baseBranch: string | null },
    ) => post('/api/worktrees/create', { project: projectId, branch, baseBranch }),
    open: (projectId: string, worktreePath: string) =>
      post('/api/worktrees/open', { project: projectId, worktreePath }),
    merge: (
      projectId: string,
      worktreePath: string,
      options: { squash?: boolean; message?: string; removeAfterMerge?: boolean },
    ) => post('/api/worktrees/merge', { project: projectId, worktreePath, ...options }),
    remove: (
      projectId: string,
      worktreePath: string,
      options: { force?: boolean; deleteBranch?: boolean },
    ) => post('/api/worktrees/remove', { project: projectId, worktreePath, ...options }),
  },

  // The resident-process face: which processes exist, which sessions they hold,
  // and the two verbs that ask for one to start or stop existing. The listing is
  // the only place a client can learn a session's stored lifecycle mode, since
  // the session rows do not carry it.
  //
  // The two verbs unwrap their envelope through `readApiJson` instead of handing
  // the bare `Response` back, so a refusal *throws* with the server's own code
  // and sentence. That is the whole difference between a user seeing why the
  // process did not start and a user seeing nothing at all: a caller that has to
  // remember to check `response.ok` before reading the body is a caller that can
  // forget, and these two did. Both resolve to `void` because "it resolved" is
  // the entire contract a caller needs — the effect it asked for arrives through
  // the next `list`, not through this payload.
  sessionHosts: {
    // `scope=active` drops the rows that say what a missing row already says (a per-run
    // session with no live host and no occupant), which is nearly every stored session.
    list: () => get('/api/session-hosts?scope=active'),
    start: async (sessionId: string): Promise<void> => {
      await readApiJson(await post(`/api/session-hosts/${encodeURIComponent(sessionId)}/start`));
    },
    // `force` is the close route's lease-gate bypass, and it has to be a literal
    // `true` on the wire: the server reads the field as `body.force !== true`, so a
    // truthy-but-not-boolean value would not authorise the close. The option is
    // omitted — not sent as `false` — on the normal path, so the request body stays
    // empty and carries no `force` key at all.
    close: async (sessionId: string, options?: { force?: boolean }): Promise<void> => {
      await readApiJson(
        await post(
          `/api/session-hosts/${encodeURIComponent(sessionId)}/close`,
          options?.force === true ? { force: true } : undefined,
        ),
      );
    },
  },

  // Provider (coding agent) endpoints — models, capabilities, sessions, MCP, skills.
  providers: {
    capabilities: () => get('/api/providers/capabilities'),
    authStatus: (provider: string) =>
      get(`/api/providers/${encodeURIComponent(provider)}/auth/status`),

    models: (provider: string) => get(`/api/providers/${provider}/models`),
    createModel: (provider: string, input: unknown) =>
      post(`/api/providers/${provider}/models`, input),
    duplicateModel: (provider: string, recordId: string | number, input: unknown) =>
      post(`/api/providers/${provider}/models/${recordId}/duplicate`, input),
    updateModel: (provider: string, recordId: string | number, input: unknown) =>
      patch(`/api/providers/${provider}/models/${recordId}`, input),
    deleteModel: (provider: string, recordId: string | number) =>
      del(`/api/providers/${provider}/models/${recordId}`),

    // Booleans only: which of the named variables are set in the server process env.
    modelEnvStatus: (names: string[]) =>
      get(`/api/providers/model-env-status?names=${encodeURIComponent(names.join(','))}`),

    createSession: (payload: {
      provider: string;
      projectPath: string;
      initialMessage?: unknown;
      /**
       * The launch selection the session is created WITH — the same three values
       * the first `chat.send` carries in its options, stated here as well because
       * not every session's first turn is a composer send (Live Voice delivers
       * its first utterance through the relay, which carries no model). A session
       * created without a model runs whatever the provider CLI defaults to.
       */
      model?: string;
      /**
       * The upstream provider id the model runs under, when the picker stated
       * one (a built-in model's `(provider)` variant). Absent/`null` means the
       * model inherits the provider's own default.
       */
      modelProviderId?: string | null;
      effort?: string;
      permissionMode?: string;
      /**
       * The lifecycle mode a new session is created with, or absent to let the
       * server apply the provider's declared `defaultLifecycleMode`.
       *
       * Stated on the creation rather than written afterwards: the row and its
       * mode are one insert, so no first turn can run under a mode the page is
       * not showing. An explicit value the provider does not implement is
       * refused before the row exists.
       */
      lifecycleMode?: 'per-run' | 'resident';
    }) => post('/api/providers/sessions', payload),
    /**
     * Stores a session's lifecycle-mode preference AFTER it exists.
     *
     * A new session states its mode on `createSession` instead; this route is
     * for converting an open session from the session menu, which is a
     * deliberate later change rather than a creation choice. The server refuses
     * a mode the session's own provider has not declared, so the caller's
     * capability gate is a courtesy rather than the enforcement.
     */
    setSessionLifecycleMode: (provider: string, sessionId: string, mode: 'per-run' | 'resident') =>
      put(
        `/api/providers/${encodeURIComponent(provider)}/sessions/${encodeURIComponent(sessionId)}/lifecycle-mode`,
        { mode },
      ),
    sessionMessages: (
      sessionId: string,
      read: SessionMessagesQuery = {},
      options: ApiRequestOptions = {},
    ) => get(sessionMessagesUrl(sessionId, read), options),
    /**
     * Every user turn of a session, in transcript order — the navigation rail's
     * index of the conversation, including turns this client has never loaded.
     *
     * The response's `total` is the same count the paginated messages route
     * reports, and each turn's `index` is its absolute position in that full
     * history, so a rail tick can say where in the whole transcript it sits
     * rather than where in the loaded window.
     */
    sessionOutline: (sessionId: string, options: ApiRequestOptions = {}) =>
      get(`/api/providers/sessions/${encodeURIComponent(sessionId)}/outline`, options),
    sessionTokenUsage: (sessionId: string) =>
      get(`/api/providers/sessions/${encodeURIComponent(sessionId)}/token-usage`),
    sessionActiveModel: (provider: string, sessionId: string) =>
      get(`/api/providers/${provider}/sessions/${encodeURIComponent(sessionId)}/active-model`),
    /**
     * Records a model choice, optionally naming the upstream provider it runs
     * under. A built-in model is offered once bare and once per registered
     * provider, so those rows share `model` and the id is the only thing
     * telling them apart. A bare choice OMITS the field rather than sending
     * null: absent means "inherit the provider's default", and the two claims
     * must not collapse into one on the wire.
     */
    setSessionActiveModel: (
      provider: string,
      sessionId: string,
      model: string,
      modelProviderId?: string | null,
    ) =>
      post(`/api/providers/${provider}/sessions/${encodeURIComponent(sessionId)}/active-model`, {
        model,
        ...(modelProviderId ? { modelProviderId } : {}),
      }),
    setSessionActiveEffort: (provider: string, sessionId: string, effort: string) =>
      post(`/api/providers/${provider}/sessions/${encodeURIComponent(sessionId)}/active-effort`, {
        effort,
      }),

    mcpServers: (
      provider: string,
      { scope, workspacePath }: { scope: string; workspacePath?: string },
    ) => get(`/api/providers/${provider}/mcp/servers${query({ scope, workspacePath })}`),
    saveMcpServer: (provider: string, payload: unknown) =>
      post(`/api/providers/${provider}/mcp/servers`, payload),
    deleteMcpServer: (
      provider: string,
      serverName: string,
      { scope, workspacePath }: { scope: string; workspacePath?: string },
    ) =>
      del(
        `/api/providers/${provider}/mcp/servers/${encodeURIComponent(serverName)}${query({ scope, workspacePath })}`,
      ),
    saveGlobalMcpServer: (payload: unknown) => post('/api/providers/mcp/servers/global', payload),

    skills: (provider: string, { workspacePath }: { workspacePath?: string } = {}) =>
      get(`/api/providers/${encodeURIComponent(provider)}/skills${query({ workspacePath })}`),
    saveSkills: (provider: string, payload: unknown) =>
      post(`/api/providers/${provider}/skills`, payload),
  },

  // Slash commands
  commands: {
    // `projectPath` stays optional: a workspace without a resolved path omits
    // the field entirely, which is what the server expects.
    list: (projectPath: string | undefined) => post('/api/commands/list', { projectPath }),
    execute: (payload: unknown) => post('/api/commands/execute', payload),
  },

  // Chat attachments, stored globally under ~/.cloudcli/assets
  assets: {
    uploadFiles: (formData: FormData) =>
      authenticatedFetch('/api/assets/files', {
        method: 'POST',
        headers: {}, // Let browser set Content-Type for FormData
        body: formData,
      }),
    file: (storedName: string) => get(`/api/assets/files/${encodeURIComponent(storedName)}`),
    image: (filename: string, options: ApiRequestOptions = {}) =>
      get(`/api/assets/images/${encodeURIComponent(filename)}`, options),
  },

  // TaskMaster endpoints — all addressed by DB projectId post-migration.
  taskmaster: {
    // Update a task
    updateTask: (projectId: string, taskId: string | number, updates: unknown) =>
      put(`/api/taskmaster/update-task/${projectId}/${taskId}`, updates),

    tasks: (projectId: string) => get(`/api/taskmaster/tasks/${encodeURIComponent(projectId)}`),
    mcpStatus: () => get('/api/taskmaster/mcp-status'),
    installationStatus: () => get('/api/taskmaster/installation-status'),

    prdFiles: (projectId: string) => get(`/api/taskmaster/prd/${encodeURIComponent(projectId)}`),
    prdFile: (projectId: string, fileName: string) =>
      get(`/api/taskmaster/prd/${encodeURIComponent(projectId)}/${encodeURIComponent(fileName)}`),
    savePrd: (projectId: string, { fileName, content }: { fileName: string; content: string }) =>
      post(`/api/taskmaster/prd/${encodeURIComponent(projectId)}`, { fileName, content }),
  },

  // User endpoints
};
