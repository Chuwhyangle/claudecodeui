import {
  acceptRefreshedAuthToken,
  expireAuthSession,
  getStoredAuthToken,
  readAuthLapseReport,
  recordAuthLapse,
} from '@/shared/authToken';
import type { SessionMessagesQuery } from '@/shared/types';
import type { ActivitySnapshotFrame } from '@/shared/types';
import type { OAuthConsentDecisionRequest } from '@/shared/types';
import type { VoiceProviderRow } from '@/shared/types';
import { IS_PLATFORM } from '@/shared/utils';
import type { VoiceConfig } from '@/shared/voiceConfig';
import { readVoiceConfig, readVoiceFallbackPreference, voiceConfigHeaders, whenVoiceConfigReady } from '@/shared/voiceConfig';
import type { VoiceEditLabel } from '@/shared/voiceEditLabels';
// The direct path's request construction lives in the repository-root shared tree, the same
// module the server and the CLI compile — see shared/asr/transcriptionWire.ts.
import {
  createTranscriptionRequest,
  parseTranscriptionResponse as readTranscriptionResponse,
} from '@shared/asr/transcriptionWire';
// The provider address book, the same table the server's health reading republishes. The
// browser asks it whether an id exists rather than keeping its own list of the ids it knows.
import type { AsrCapabilities, AsrErrorCode, PauseCuesDeclaration } from '@shared/asr/asrRegistry';
import {
  baseMimeType,
  classifyUpstreamFailure,
  declaredAcceptsMime,
  extractUpstreamCode,
  pauseCuesDeclarationFor,
  tryResolve,
} from '@shared/asr/asrRegistry';

// Headers are a plain record rather than the full `HeadersInit` union so the
// defaults below can be merged with a caller's headers by spreading.
export type ApiRequestOptions = Omit<RequestInit, 'headers'> & {
  headers?: Record<string, string>;
};

// Utility function for authenticated API calls
export const authenticatedFetch = (
  url: string,
  options: ApiRequestOptions = {},
): Promise<Response> => {
  const token = getStoredAuthToken();

  const defaultHeaders: Record<string, string> = {};

  // Only set Content-Type for non-FormData requests
  if (!(options.body instanceof FormData)) {
    defaultHeaders['Content-Type'] = 'application/json';
  }

  if (!IS_PLATFORM && token) {
    defaultHeaders['Authorization'] = `Bearer ${token}`;
  }

  // A request is about to leave holding no credential. That is itself the fact
  // worth recording: it is the shape the server sees as a bare `invalid-token`
  // 401 and cannot explain — a session that never existed, storage another tab
  // emptied, and (before this change) a token the client's own clock discarded
  // all look identical from there. First write wins, so a real lapse already on
  // record is not relabelled by the traffic that follows it.
  if (!IS_PLATFORM && !token) {
    recordAuthLapse('storage-empty');
  }

  return fetch(url, {
    ...options,
    headers: {
      ...defaultHeaders,
      ...options.headers,
    },
  }).then((response) => {
    const refreshedToken = response.headers.get('X-Refreshed-Token');
    if (refreshedToken) {
      // A renewal only moves the session FORWARD. A response the browser replayed
      // from its cache carries the token that was current when it was stored, so
      // accepting it blindly would downgrade the session on every reload — this is
      // the "every refresh logs you out" defect. Older, same-instant and
      // unparseable values are dropped; the decision is the one `storeAuthToken`
      // would make for a login, plus the monotonicity that only a renewal needs.
      acceptRefreshedAuthToken(refreshedToken);
    }
    const authError = response.headers.get('X-Auth-Error');
    if (authError) {
      // The server decided. Name its answer in the breadcrumb: `session-expired`
      // is the token's own `exp` having passed; anything else is a refused
      // credential whose reason the client does not get to guess.
      expireAuthSession(authError === 'session-expired' ? 'server-expired' : 'server-401');
    }
    return response;
  });
};

// ─── Request helpers ────────────────────────────────────────────────────────
// Every endpoint below goes through these so verb, JSON encoding and query
// serialization stay consistent across the whole frontend.

type QueryValue = string | number | boolean | null | undefined;

// Serializes a query object into `?a=1&b=2` (or an empty string). Empty and
// `false` values are dropped so optional flags can be passed unconditionally.
const query = (params: Record<string, QueryValue>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '' || value === false) {
      continue;
    }
    search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized ? `?${serialized}` : '';
};

/**
 * Reads a `{ success, error, details }` envelope response, throwing the server's
 * message when the request failed.
 *
 * Endpoints return a bare Response, so call sites unwrap it themselves. Most do
 * so in ways that differ deliberately (bare casts where the caller inspects the
 * payload, abort-aware reads in the git panel); this is the shared form for
 * callers that want a failed request to throw.
 */
export class ApiRequestError extends Error {
  readonly code?: string;
  readonly details?: unknown;
  readonly status: number;

  constructor(message: string, options: { code?: string; details?: unknown; status: number }) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = options.code;
    this.details = options.details;
    this.status = options.status;
  }
}

/**
 * Reads a `{ success, error, details }` envelope response, throwing an
 * ApiRequestError carrying the server's machine-readable error code when one
 * is present. Accepts both legacy string envelopes (`error: 'message'`) and
 * the structured AppError envelope (`error: { code, message, details }`).
 */
export async function readApiJson<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok || data.success === false) {
    const raw = data.error ?? data.details;
    const payload = raw && typeof raw === 'object' ? raw : {};
    const message = (typeof raw === 'string' ? raw : payload?.message) || data.details || `Request failed (${response.status})`;
    throw new ApiRequestError(message, {
      code: typeof payload?.code === 'string' ? payload.code : undefined,
      details: payload?.details ?? data.details,
      status: response.status,
    });
  }
  return data as T;
}
const get = (url: string, options: ApiRequestOptions = {}) => authenticatedFetch(url, options);

/**
 * Reads a session's activity snapshot over REST (`GET /:sessionId/activity`).
 *
 * This is the join path for a client that arrives after a change: the socket
 * hands a whole snapshot on `activity.snapshot` when it subscribes, and this
 * route answers the same object shape for a reader that wants it before the
 * socket is up (or wants to prove the snapshot exists). The response body IS the
 * snapshot — not an envelope — so it is returned as-is; a 404 (no snapshot for
 * the session) reads as `null` rather than throwing, because "this session has no
 * activity yet" is a normal state, not a failure.
 */
export async function fetchSessionActivity(
  sessionId: string,
): Promise<ActivitySnapshotFrame | null> {
  const response = await authenticatedFetch(`/api/sessions/${encodeURIComponent(sessionId)}/activity`);
  if (!response.ok) {
    return null;
  }
  const body = (await response.json().catch(() => null)) as unknown;
  return body && typeof body === 'object' ? (body as ActivitySnapshotFrame) : null;
}

const withBody =
  (method: string) =>
    (url: string, body?: unknown, options: ApiRequestOptions = {}) =>
      authenticatedFetch(url, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...options,
      });

const post = withBody('POST');
const put = withBody('PUT');
const patch = withBody('PATCH');
const del = withBody('DELETE');

// ─── URL builders ───────────────────────────────────────────────────────────
// Exported for the consumers that cannot go through `authenticatedFetch`:
// `EventSource` and `XMLHttpRequest` need a bare URL.

/**
 * Persisted messages for one session, in either of the route's two shapes.
 *
 * Omitting `limit` requests the whole transcript; passing one always pairs it with
 * an explicit offset so automatic refreshes can never accidentally become an
 * unbounded transcript request. When `around` is set the URL is the id-anchored
 * window read instead (`?around=<id>&before=B&after=A`) and `limit`/`offset` are
 * dropped, matching the server's own precedence.
 */
export const sessionMessagesUrl = (
  sessionId: string,
  { limit = null, offset = 0, around, before, after }: SessionMessagesQuery = {},
): string => {
  const base = `/api/providers/sessions/${encodeURIComponent(sessionId)}/messages`;
  if (around !== undefined) {
    return `${base}${query({ around, before, after })}`;
  }
  return limit === null || limit === undefined
    ? base
    : `${base}${query({ limit, offset: offset ?? 0 })}`;
};

/**
 * The `/voice-realtime` socket URL for the open session (GOAL-031 / AC-312).
 *
 * A browser WebSocket handshake cannot carry an `Authorization` header, so the
 * JWT rides in the query — the same shape the chat socket uses. `session` names
 * the ONE session a voice `session_send` may reach; the server holds a model
 * that tries to name another to it (`createVoiceRealtimeLiveExecutor`), so the
 * "currently open session" binding is decided here and enforced there.
 */
export const voiceRealtimeSocketUrl = (token: string, sessionId: string): string => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/voice-realtime${query({ token, session: sessionId })}`;
};

const fileContentPath = (projectId: string, filePath: string) =>
  `/api/file-tree/projects/${projectId}/files/content${query({ path: filePath })}`;

const pluginAssetPath = (pluginName: string, assetFile: string) =>
  `/api/plugins/${encodeURIComponent(pluginName)}/assets/${encodeURIComponent(assetFile)}`;

// ─── API endpoints ──────────────────────────────────────────────────────────
// Every `/api/...` path the frontend talks to is declared here; components
// import a named method instead of assembling URLs of their own.

export const api = {
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
    filter?: { readonly kinds?: readonly string[]; readonly relations?: readonly string[] },
  ) =>
    post('/api/architecture/graph', {
      projectId,
      sessionId,
      ...(hops === undefined ? {} : { hops }),
      ...(filter?.kinds === undefined ? {} : { kinds: filter.kinds }),
      ...(filter?.relations === undefined ? {} : { relations: filter.relations }),
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
      effort?: string;
      permissionMode?: string;
    }) => post('/api/providers/sessions', payload),
    /**
     * Stores a session's lifecycle-mode preference.
     *
     * A separate call from `createSession` because the create payload carries no
     * mode: the session gateway allocates the row and the mode is a statement
     * about who owns the session's process, written through its own route. The
     * server refuses a mode the session's own provider has not declared, so the
     * caller's capability gate is a courtesy rather than the enforcement.
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
    setSessionActiveModel: (provider: string, sessionId: string, model: string) =>
      post(`/api/providers/${provider}/sessions/${encodeURIComponent(sessionId)}/active-model`, {
        model,
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
  user: {
    gitConfig: () => get('/api/user/git-config'),
    updateGitConfig: (gitName: string, gitEmail: string) =>
      post('/api/user/git-config', { gitName, gitEmail }),
    onboardingStatus: () => get('/api/user/onboarding-status'),
    completeOnboarding: () => post('/api/user/complete-onboarding'),

    // Preferences and chat drafts live server-side so they follow the user
    // from one device to another. `savePreferences` is a merge-patch: only the
    // keys it is given are written.
    preferences: () => get('/api/user/preferences'),
    savePreferences: (updates: Record<string, unknown>) =>
      patch('/api/user/preferences', updates),
    drafts: () => get('/api/user/drafts'),
    saveDraft: (scope: string, draft: { text: string; queuedMessage?: unknown }) =>
      put('/api/user/drafts', { scope, ...draft }),
    deleteDraft: (scope: string) => del('/api/user/drafts', { scope }),
  },

  // Server-side settings: personal access tokens, stored credentials, notifications, web push
  settings: {
    accessTokens: () => get('/api/settings/access-tokens'),
    // The advanced, read-only OAuth-token list beside the PAT list. GET only: there
    // is no create/revoke here on purpose (OAuth tokens are revoked via grants).
    oauthTokens: () => get('/api/settings/oauth-tokens'),
    createAccessToken: (payload: { name: string; expiresInDays: number; scopes: string[] }) =>
      post('/api/settings/access-tokens', payload),
    revokeAccessToken: (tokenId: number) => del(`/api/settings/access-tokens/${tokenId}`),
    mcpGatewayStatus: () => get('/api/settings/mcp-gateway'),

    // The OAuth surface the "connected apps" and "OAuth clients (advanced)" sections manage:
    // the signed-in user's own consent grants (list/revoke) and the registered clients
    // (list/disable), plus the manual-client creation whose secret is returned exactly once.
    oauthGrants: () => get('/api/settings/oauth-grants'),
    revokeOAuthGrant: (grantId: number) => del(`/api/settings/oauth-grants/${grantId}`),
    oauthClients: () => get('/api/settings/oauth-clients'),
    disableOAuthClient: (clientId: string) => patch(`/api/settings/oauth-clients/${clientId}/disable`),
    createOAuthClient: (payload: { clientName: string; redirectUris: string[] }) =>
      post('/api/oauth/clients', { client_name: payload.clientName, redirect_uris: payload.redirectUris }),

    credentials: (type: string) => get(`/api/settings/credentials${query({ type })}`),
    createCredential: (payload: {
      credentialName: string;
      credentialType: string;
      credentialValue: string;
      description?: string;
    }) => post('/api/settings/credentials', payload),
    deleteCredential: (credentialId: string) => del(`/api/settings/credentials/${credentialId}`),
    toggleCredential: (credentialId: string, isActive: boolean) =>
      patch(`/api/settings/credentials/${credentialId}/toggle`, { isActive }),

    notificationPreferences: () => get('/api/settings/notification-preferences'),
    saveNotificationPreferences: (preferences: unknown) =>
      put('/api/settings/notification-preferences', preferences),

    push: {
      vapidPublicKey: () => get('/api/settings/push/vapid-public-key'),
      subscribe: (subscription: { endpoint?: string; keys?: unknown }) =>
        post('/api/settings/push/subscribe', subscription),
      unsubscribe: (endpoint: string) => post('/api/settings/push/unsubscribe', { endpoint }),
    },
  },

  plugins: {
    list: () => get('/api/plugins'),
    install: (url: string) => post('/api/plugins/install', { url }),
    uninstall: (name: string) => del(`/api/plugins/${encodeURIComponent(name)}`),
    update: (name: string) => post(`/api/plugins/${encodeURIComponent(name)}/update`),
    toggle: (name: string, enabled: boolean) =>
      put(`/api/plugins/${encodeURIComponent(name)}/enable`, { enabled }),
    // Plugin bundles/icons are fetched with auth headers and handed to the
    // browser as blobs, so a bare asset URL is never requested unauthenticated.
    asset: (pluginName: string, assetFile: string) => get(pluginAssetPath(pluginName, assetFile)),
    // Exposed so the icon cache can key on the resolved asset path.
    assetUrl: pluginAssetPath,
    rpc: (pluginName: string, method: string, path: string, body?: unknown) =>
      authenticatedFetch(
        `/api/plugins/${encodeURIComponent(pluginName)}/rpc/${String(path).replace(/^\//, '')}`,
        {
          method: method || 'GET',
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        },
      ),
  },

  browserUse: {
    status: () => get('/api/browser-use/status'),
    settings: () => get('/api/browser-use/settings'),
    saveSettings: (settings: unknown) => put('/api/browser-use/settings', settings),
    sessions: () => get('/api/browser-use/sessions'),
    stopSession: (sessionId: string) => post(`/api/browser-use/sessions/${sessionId}/stop`),
    deleteSession: (sessionId: string) => del(`/api/browser-use/sessions/${sessionId}`),
    installRuntime: () => post('/api/browser-use/runtime/install'),
  },

  // Live Voice's speaker tracker (Phase 1, shadow). The model is a runtime artifact the SERVER
  // installs from one fixed source: the client reads the resolved path/state and asks for the
  // download by its own verb. Neither call carries a URL, a directory or a file name — the server's
  // settings file owns those, and a request field that named one would be a client choosing what
  // the server writes to disk.
  voiceRealtime: {
    // The reading the settings page renders: state, resolved path, pinned digest, source, licence,
    // and — while a download runs — received/total/rate.
    speakerModelStatus: () => get('/api/voice-realtime/speaker-model'),
    // Start the download, or join the one already in flight for the same resolved path. `202` and
    // `200` both answer with the current reading.
    speakerModelDownload: () => post('/api/voice-realtime/speaker-model/download', {}),
  },

  voice: {
    health: () => get('/api/voice/health'),
    // The server's reading of the browser recogniser's own deployment: whether a model directory is
    // configured and whether it holds the two files. Read before the client path downloads anything,
    // so a deployment that is not provisioned answers `ENGINE_UNAVAILABLE` with an actionable reason
    // instead of spending a 239 MB download to discover the same thing.
    clientAssets: () => get('/api/voice/client-assets'),
    transcribe: (formData: FormData, headers: Record<string, string> = {}) =>
      authenticatedFetch('/api/voice/transcribe', {
        method: 'POST',
        headers,
        body: formData,
      }),
    // The raw (pre-VAD) corpus upload, its own endpoint and its own transport method: the bytes it
    // carries are not sent on to any recogniser, so it is not a second call of `transcribe`.
    captureRaw: (formData: FormData, headers: Record<string, string> = {}) =>
      authenticatedFetch('/api/voice/capture/raw', {
        method: 'POST',
        headers,
        body: formData,
      }),
    // The deployment's own raw-capture switch, read once per session (see `voiceConfig.ts`). Its own
    // endpoint rather than a field on `health`, which is a per-user provider reading.
    capture: () => get('/api/voice/capture'),
    // THE USER'S OWN KEPT RECORDINGS: the one action the settings page's clear button sends. Its own
    // DELETE rather than a settings write, because what it removes is not a setting — it is every
    // record the store holds — and the response's `deleted` count is how many there were.
    clearData: () => del('/api/voice/data'),
    // THE CORRECTION GOES BACK. A transcription answers with a `recordId`; when the user then edits
    // the box and sends, this writes the text they sent and the `heard → final` pairs their edit
    // produced onto that same record. Its own `PATCH` of the resource `clearData` removes, because
    // the audio half of the record is not being replaced — only the two keys the correction owns.
    //
    // A `404` is a NORMAL answer here (the ceiling may have evicted the record, or the user may have
    // cleared it, since the listen), so the caller is expected to let it go rather than surface it:
    // the correction was not kept, and the message the user asked to send was sent regardless. See
    // `writeSentLabels` in `useVoiceInput`.
    writeLabels: (recordId: string, body: { finalText: string; labels: VoiceEditLabel[] }) =>
      patch(`/api/voice/data/${encodeURIComponent(recordId)}`, body),
    tts: (text: string, options: ApiRequestOptions = {}) => post('/api/voice/tts', { text }, options),
    // The user's own backend settings, stored per user so they follow the
    // account rather than the browser profile they were typed in.
    config: () => get('/api/voice/config'),
    saveConfig: (settings: VoiceConfig) => put('/api/voice/config', settings),
  },

  system: {
    update: () => post('/api/system/update'),
  },
};

// ---------------------------

//----------------- VOICE TRANSCRIPTION AND SPEECH ------------

/**
 * Builds a URL against the user's own OpenAI-compatible voice endpoint. Private to the
 * voice helpers below, which bypass the CloudCLI proxy when a base URL is configured.
 */
function voiceDirectUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

/**
 * Serializes the active voice configuration so callers can detect a settings change and
 * drop cached synthesized audio.
 */
export function voiceConfigSignature(): string {
  return JSON.stringify(readVoiceConfig());
}

/**
 * Transcribes recorded audio, posting directly to the user's configured OpenAI-compatible
 * endpoint when one is set and otherwise going through the CloudCLI voice proxy.
 */
/**
 * The provider the last health reading named, held here because this is where the direct path
 * decides which endpoint a recording takes.
 *
 * It is a mirror of what `GET /api/voice/health` answered, never an independent opinion: the
 * capabilities in it are the registry's own declaration as the server republished them, so the
 * client has no second table to fall out of step with. The module keeps no copy of that
 * declaration of its own, which is what makes the health reading the only source.
 */
let voiceProviderProfile: { id: string; capabilities: AsrCapabilities } | null = null;

/**
 * Publishes the provider the health reading named. Called by the chat module's
 * `useVoiceAvailable` hook, which is the one place the payload is already parsed; nothing else
 * writes it.
 */
export function setVoiceProviderProfile(profile: { id: string; capabilities: AsrCapabilities } | null): void {
  voiceProviderProfile = profile;
}

/**
 * Every recogniser the last health reading published, in the deployment's own order.
 *
 * WHY A SECOND SLOT BESIDE `voiceProviderProfile`. The profile above answers "what did the deployment
 * say about the recogniser in use"; this one answers "which recognisers exist here at all, and what
 * does each declare" — the question a FALLBACK asks, because the recogniser that gave up is by
 * definition not the one to read a declaration off. Both come from one payload and one writer, so the
 * two cannot disagree about a row they both saw.
 */
let voiceProviderRows: VoiceProviderRow[] = [];

/** Publishes the health reading's provider rows. Called by `useVoiceAvailable`, like the profile. */
export function setVoiceProviderRows(rows: VoiceProviderRow[]): void {
  voiceProviderRows = rows;
}

/** The published rows, for a caller that has to reason about more than the effective provider. */
export function readVoiceProviderRows(): VoiceProviderRow[] {
  return voiceProviderRows;
}

/**
 * The recogniser a clip the CLIENT gave up on is uploaded to, or `null` when this deployment has none.
 *
 * WHY THIS IS A DECISION AND NOT A DEFAULT. When the on-device recogniser cannot take a clip the
 * user's audio has to go somewhere, and every candidate is a disclosure the user did not ask for —
 * so the choice is made from what the deployment PUBLISHED rather than from a guess, and the answer
 * "nowhere" is a real one: a deployment that offers nothing but the browser recogniser has no
 * fallback, and telling the user so is better than uploading to a service nobody selected.
 *
 * THE RULE, in order:
 *   · the user's own stored preference, when it names a row that is eligible — a choice they made is
 *     the most specific statement available, and this is the only field the panel lets them make it in;
 *   · otherwise the first recogniser that runs on the SERVER's own host (`locality: 'local-server'`).
 *     Falling back to a local-server recogniser keeps the clip on the machine the audio was already
 *     going to be transcribed on, which is the smallest step away from "it never left this device";
 *     a remote service is only ever used when the user named one;
 *   · otherwise `null`.
 *
 * ELIGIBILITY IS THE SERVER'S OWN READING. `local-client` is excluded because such a row cannot serve
 * an upload at all — it is the recogniser that just gave up, and the server refuses a request that
 * names one (see `voice.service.ts`). `runtime.available === false` is excluded because that row's own
 * engine has said it cannot run; a row with no runtime reading is a remote recogniser, whose
 * readiness is a property of the user's settings and not of this machine.
 */
export function resolveVoiceFallbackProvider(): string | null {
  const eligible = voiceProviderRows.filter((row) =>
    row.capabilities !== null
    && row.capabilities.locality !== 'local-client'
    && (row.runtime === null || row.runtime.available),
  );

  const preferred = readVoiceFallbackPreference();
  if (preferred !== null) {
    const chosen = eligible.find((row) => row.id === preferred.trim());
    if (chosen !== undefined) {
      return chosen.id;
    }
  }

  return eligible.find((row) => row.capabilities?.locality === 'local-server')?.id ?? null;
}

/**
 * The pause-cue declaration of the provider a recording will actually be transcribed by, or
 * `null` when this build cannot name one.
 *
 * THE PROVIDER ID COMES FROM THE SAME READING THE UPLOAD ROUTES ON: the health payload's
 * effective provider, which the server derives from the user's stored configuration over the
 * server's own environment — the same id `transcribeVoice` below refuses an upload for. That is
 * deliberate. A trim gate that named its own provider would be answering about a recogniser the
 * request is not being sent to, which is exactly what the removed `OPENAI_COMPATIBLE_PROVIDER`
 * literal did: it named an id nothing is registered under, so the answer it produced said nothing
 * about the service on the other end.
 *
 * `null` RATHER THAN A DEFAULT DECLARATION, and the caller treats it as "leave the audio alone":
 * the value is only knowable once the health reading has published a profile, and an id the
 * registry does not claim has no declaration to read. Inventing one would recreate the second
 * source of truth this accessor exists to remove — and the action it would authorise is the
 * destructive one.
 */
export function effectivePauseCuesDeclaration(): PauseCuesDeclaration | null {
  const profile = voiceProviderProfile;
  if (!profile) {
    return null;
  }

  return pauseCuesDeclarationFor(profile.id);
}

/**
 * The refusal the direct path owes an id this build does not register, or `null` when there is
 * nothing to refuse.
 *
 * Checked before the settings are awaited, because the answer does not depend on them: no
 * stored backend can make an unregistered id serveable. Falling through instead would send the
 * recording to an endpoint chosen for a provider the user is not using — the silent fallback
 * whose worst case is a user who believes the new service answered.
 */
function unregisteredProviderRefusal(): Response | null {
  const profile = voiceProviderProfile;
  if (!profile || tryResolve(profile.id) !== null) {
    return null;
  }

  return new Response(
    JSON.stringify({
      error: `Unknown voice provider id '${profile.id}': no ASR adapter is registered for it.`,
    }),
    { status: 400, headers: { 'Content-Type': 'application/json' } },
  );
}

/**
 * The refusal the direct path owes a recording whose container the effective provider does not
 * declare, or `null` when there is nothing to refuse.
 *
 * The whitelist is the health reading's own declaration — the registry's `AsrCapabilities` as the
 * server republished it — so the browser holds no second table of accepted containers that could
 * disagree with the server's. Matched on the base type, because the recorder's preferred type is
 * `audio/webm;codecs=opus`: an exact comparison against the published base types would refuse the
 * recording this app just made.
 *
 * Checked before the settings are awaited, like the unregistered-id refusal above and for the same
 * reason: the answer does not depend on the settings. The code is `UNSUPPORTED_MIME`, the same one
 * the proxy path returns, so a caller gets one answer about one recording rather than a different
 * one depending on which of the two endpoints it took.
 *
 * A profile that was never published — a health reading that has not happened yet, or a server too
 * old to send one — leaves this gate silent. It has no declaration to read, and inventing a
 * whitelist here would be exactly the second source of truth this function exists to not be; the
 * server's own gate is still ahead of the recogniser on the proxy path.
 */
function unsupportedContainerRefusal(mimeType: string): Response | null {
  const profile = voiceProviderProfile;
  if (!profile || declaredAcceptsMime(profile.capabilities, mimeType)) {
    return null;
  }

  const base = baseMimeType(mimeType);
  return new Response(
    JSON.stringify({
      error:
        `provider '${profile.id}' does not accept ${base}; ` +
        `it accepts ${profile.capabilities.acceptsMime.join(', ')}`,
      code: 'UNSUPPORTED_MIME',
    }),
    { status: 415, headers: { 'Content-Type': 'application/json' } },
  );
}

/**
 * The failure envelope the direct path answers with, shaped exactly like the one the server's
 * proxy route builds (`server/modules/voice/voice.routes.ts`).
 *
 * WHY IT IS THE SAME SHAPE AND NOT A SHAPE OF ITS OWN. Both paths land at the SAME reader —
 * `refusalCode` in `src/modules/chat/hooks/useVoiceInput.ts` reads `body.code` and nothing else —
 * so a second envelope here would be a second contract for one field, and the branch that read the
 * proxy's spelling would go blind on the direct path's. `upstreamCode` rides beside `code` when the
 * upstream named one, and is dropped rather than defaulted when it did not: a placeholder would
 * read as a classification, which is the same discipline the route's `sendFailure` follows.
 */
function voiceFailureEnvelope(
  code: AsrErrorCode,
  status: number,
  message: string,
  upstreamCode?: string,
): Response {
  return new Response(
    JSON.stringify({
      error: message,
      code,
      ...(upstreamCode === undefined ? {} : { upstreamCode }),
    }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

/**
 * The answer's body, read WITHOUT consuming the response the caller still uses.
 *
 * A clone is taken whenever the response offers one, which is what keeps this reading from being a
 * change of behaviour rather than a reading: `useVoiceInput` reads the same answer afterwards on
 * the success path. The fallback exists for the stand-in transports the suite drives this seam
 * with, which implement the five members the app reads (`ok`, `status`, `json`, `text`, `headers`)
 * and nothing else; there, and only there, the body is read from the response itself — and on those
 * rows the response is a failure the caller is handed a replacement for, so nothing is left spent.
 * An unreadable body is the empty string, which is the same thing the adapters' `readTextQuietly`
 * answers with, and it means the status fallback decides.
 */
async function readAnswerBody(response: Response): Promise<string> {
  try {
    const copy = typeof response.clone === 'function' ? response.clone() : response;
    return await copy.text();
  } catch {
    return '';
  }
}

/**
 * The text a `2xx` answer carries, or `null` when the body is not this family's envelope at all.
 *
 * The parse is the SHIPPED wire's (`readTranscriptionResponse`, `strict`), over a response built
 * from the body copy: `200` is read the same way here as it is by every other reader of this
 * protocol, so a recognised transcript is never re-described by a second parse. A body that is not
 * JSON at all answers `null` rather than throwing — that answer is not this seam's to reclassify,
 * and the caller's own parse already has an opinion about it.
 */
async function transcriptIn(body: string): Promise<string | null> {
  if (body === '') {
    return null;
  }
  try {
    return await readTranscriptionResponse(
      new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }),
      'strict',
    );
  } catch {
    return null;
  }
}

/**
 * The refusal the direct path owes an upstream answer, or `null` when the answer is a transcription
 * the caller can use as it stands.
 *
 * THIS IS THE DIRECT PATH'S CLASSIFICATION, AND IT HAS NO TABLE OF ITS OWN. The code comes from
 * `classifyUpstreamFailure` in `shared/asr/asrRegistry.ts` — the same call the three adapters make
 * — so an upstream failure means one thing on the browser's path and on the server's proxy path.
 * A client that decided this locally would be the second implementation this seam exists to not be,
 * and the two paths would be free to disagree about the same `403`.
 *
 * THE BODY DECIDES AND THE STATUS IS THE FALLBACK, which is the whole reason the upstream's own
 * code string is read out of the answer at all: `429 AllocationQuota.FreeTierOnly` and
 * `429 Throttling.RateQuota` are one number and two facts (a quota that is gone, a caller who is
 * going too fast), and the sentence a user needs is different for each.
 *
 * A `2xx` IS NOT A FAILURE, and this returns `null` for one that carries text. It reads the body
 * for the one case the status cannot answer — a well-formed answer that names neither `instruction`
 * nor `transcript` is `NO_SPEECH_DETECTED`, not a success with empty text. The proxy path already
 * answers that way (`server/modules/voice/voice.service.ts` maps the adapter's code to `422`), so
 * leaving it out here would be the two paths disagreeing about a silent recording, which is the one
 * failure a user is most likely to meet.
 */
async function voiceAnswerRefusal(response: Response): Promise<Response | null> {
  const body = await readAnswerBody(response);

  if (!response.ok) {
    return voiceFailureEnvelope(
      classifyUpstreamFailure(response.status, body),
      response.status,
      `the voice backend answered ${response.status}`,
      extractUpstreamCode(body),
    );
  }

  const text = await transcriptIn(body);
  if (text === null || text.trim() !== '') {
    return null;
  }

  return voiceFailureEnvelope('NO_SPEECH_DETECTED', 422, 'the voice backend returned no speech');
}

/**
 * The provider a recording is routed for: the stored Recognition service first, the published
 * health reading only when nothing is stored, or `null` when neither names one (the pre-provider
 * default, which keeps meaning "the shared backend").
 *
 * A stored id this build does not register is reported as such rather than resolved to something
 * else: falling through would send the recording to whatever the shared backend points at.
 */
function routedProvider(
  storedProviderId: string,
): { id: string; capabilities: AsrCapabilities } | { unregistered: string } | null {
  const id = storedProviderId.trim() || voiceProviderProfile?.id || '';
  if (!id) {
    return null;
  }

  const adapter = tryResolve(id);
  if (adapter !== null) {
    return { id, capabilities: adapter.capabilities };
  }

  return { unregistered: id };
}

/**
 * Whether the shared backend settings may be used for a recogniser with these capabilities: only a
 * remote recogniser the browser can address itself. A recogniser that runs on the server's own
 * machine has no address to be given one, and a proxy-only one is called by CloudCLI with its own
 * stored credentials.
 */
function sharedBackendApplies(capabilities: AsrCapabilities): boolean {
  return capabilities.transport === 'direct' && capabilities.locality === 'remote';
}

function unregisteredIdRefusal(providerId: string): Response {
  return new Response(
    JSON.stringify({
      error: `Unknown voice provider id '${providerId}': no ASR adapter is registered for it.`,
    }),
    { status: 400, headers: { 'Content-Type': 'application/json' } },
  );
}

/**
 * Where an upload takes the recogniser it is addressed to from.
 *
 * `stored` IS THE ORDINARY CASE and the default: the recogniser the user saved is the one they asked
 * to have their recordings transcribed by, so the id travels in the usual settings header.
 *
 * `client-fallback` IS THE ON-DEVICE RECOGNISER'S HAND-OFF. The clip was going to be recognised in
 * this browser and the engine gave up, so the stored choice is exactly the id that cannot serve an
 * upload — it names a provider that runs in the caller's own browser. The address is therefore
 * RESOLVED here (`resolveVoiceFallbackProvider`) rather than passed in as a bare id, because the
 * resolution needs the deployment's published rows and this module is the one that holds them; a
 * caller that resolved it itself would be a second copy of the eligibility rule, and the two copies
 * would be a second answer to "may this audio leave the device".
 */
export type VoiceUploadAddress =
  | { kind: 'stored' }
  | { kind: 'client-fallback'; giveUpMessage: string };

/**
 * Uploads one recording, and answers with the recogniser's own response.
 *
 * `address` NAMES THE RECOGNISER FOR THIS REQUEST ALONE. The server reads the id off the same
 * `x-voice-provider` header the stored choice travels in, and applies the request override above the
 * stored document (see `effectiveProviderId`), so the two spellings are one mechanism rather than two.
 *
 * THE RESOLVED ID CANNOT RESURRECT THE SHARED BACKEND. It is resolved exactly like the stored id —
 * through `routedProvider`, and therefore through the same unregistered-id refusal — so an id this
 * build does not register is refused before a byte is sent, and a recogniser that is not a remote one
 * reached directly still takes the proxy branch rather than a base URL the user never set.
 *
 * A FALLBACK WITH NOWHERE TO GO UPLOADS NOTHING AND SAYS SO. The answer is a refusal response rather
 * than a throw, so the caller's existing refusal handling reports the reason without a request being
 * made: an upload addressed to a recogniser nobody published would reach the server's default
 * provider — a service the user did not select — which is precisely the disclosure this addressing
 * exists to avoid.
 *
 * `context` IS A HINT, NOT A ROUTING DECISION. The caller builds the conversation pack; this
 * function appends it to the multipart body only when the selected recogniser DECLARES
 * `honors.context`. A provider that does not acknowledge context must not receive it, and the
 * direct-backend branch has no wire field for it at all, so the field is simply absent there.
 */
export async function transcribeVoice(
  blob: Blob,
  filename: string,
  listenId?: string,
  address: VoiceUploadAddress = { kind: 'stored' },
  context?: string,
): Promise<Response> {
  const refusal = unregisteredProviderRefusal() ?? unsupportedContainerRefusal(blob.type);
  if (refusal) {
    return refusal;
  }

  // The settings are fetched from the server now, so the first call of a session
  // has to wait for them. Reading an un-hydrated copy would look exactly like
  // "no backend configured" and route the recording through the proxy instead of
  // the endpoint the user set up.
  await whenVoiceConfigReady();
  const config = readVoiceConfig();

  // THE ROUTE IS THE DECLARATION'S, NOT THE SETTINGS'. This is read BEFORE the direct branch
  // below, and that order is the whole deliverable: a provider declaring `transport: 'proxy-only'`
  // is one a browser cannot address itself — its service answers no CORS preflight for this origin
  // — so the base URL the user stored must be stepped over rather than called. An unresolved or
  // unpublished profile keeps the behaviour below unchanged, the same discipline
  // `unregisteredProviderRefusal` and `unsupportedContainerRefusal` follow: no readable declaration
  // means no change of route. Note what this is NOT: it is not a test of whether a base URL is set,
  // and it is not a fallback taken after the direct call failed — the request never goes out.
  //
  // THE RECOGNITION SERVICE THE USER SAVED DECIDES THE ROUTE, AND THE SHARED BACKEND IS THE LOWEST
  // PRIORITY. The shared fields (`baseUrl`, `apiKey`, `sttModel`) belong to the recognisers reached
  // through them; they are one flat set that outlives a change of provider, so a user who moved from
  // such a service to one that has its own settings (or none) still carries the old address and key.
  // `routedProvider` therefore reads the stored choice, not the health reading — which is only as
  // fresh as the last time the settings page was open — and `sharedBackendApplies` is false for any
  // recogniser that is not a remote one reached directly.
  // THE ADDRESS IS RESOLVED BEFORE ANY ROUTE IS TAKEN, because one of its two outcomes is "there is
  // no route": a clip the on-device recogniser gave up on is addressed to the fallback recogniser
  // this deployment publishes, and a deployment that publishes none gets a refusal with no request
  // behind it. Falls through to the stored id for every other upload, which is the shipped behaviour.
  let providerId = config.providerId;
  if (address.kind === 'client-fallback') {
    const target = resolveVoiceFallbackProvider();
    if (target === null) {
      return voiceFailureEnvelope(
        'ENGINE_UNAVAILABLE',
        503,
        `the on-device recogniser gave up on this clip (${address.giveUpMessage}) and this deployment `
        + 'publishes no recogniser to fall back to, so it was not uploaded',
      );
    }
    providerId = target;
  }

  const routed = routedProvider(providerId);
  if (routed !== null && 'unregistered' in routed) {
    return unregisteredIdRefusal(routed.unregistered);
  }
  const profile = routed;
  if (profile !== null && !sharedBackendApplies(profile.capabilities)) {
    // The proxy hop is a different protocol from the one below: this is the client talking to
    // CloudCLI (field `audio`, model and key in headers), not to the recogniser's endpoint. The
    // routing header is assembled HERE rather than inside `voiceConfigHeaders()`, which returns an
    // empty map when there is no window: a routing header that vanished there would hand the
    // recording to whatever provider the server defaults to, which is the very thing this branch
    // exists to prevent — silently, on the one path that cannot show it.
    const body = new FormData();
    body.append('audio', blob, filename);
    // The pairing id rides only on the two proxy branches: it is the SERVER's capture row that pairs
    // this upload with the listen's raw corpus row, and the direct branch below never reaches that
    // server — so appending it there would send a field no one reads.
    if (listenId !== undefined) body.append('listenId', listenId);
    // The context is the recogniser's call: a provider whose declaration says it acknowledges a
    // context receives it, and one that says otherwise never has it put on the wire.
    if (context !== undefined && profile.capabilities.honors.context) body.append('context', context);
    return api.voice.transcribe(body, { ...voiceConfigHeaders(), 'x-voice-provider': profile.id });
  }

  if (config.baseUrl.trim()) {
    // The outbound request is built by the one module that owns this protocol. What stays
    // here is what is genuinely local to the browser: which of the two endpoints this
    // recording takes, and the settings it takes its credentials and model from.
    const request = createTranscriptionRequest(
      {
        baseUrl: config.baseUrl.trim(),
        apiKey: config.apiKey,
        model: config.sttModel || 'whisper-1',
      },
      { audio: blob, fileName: filename },
    );

    let response: Response;
    try {
      response = await fetch(request.url, request.init);
    } catch {
      // A transport that never connected and a request the caller's own deadline ended are ONE
      // code on this side of the seam, exactly as they are inside every adapter: the remedy is
      // the same for both, and the proxy route answers both with the same member. There is no
      // status to carry — the request never reached one — so the envelope uses the code the
      // route uses for an unreachable upstream rather than inventing a number.
      return voiceFailureEnvelope(
        'UPSTREAM_UNAVAILABLE',
        502,
        'the voice backend could not be reached',
      );
    }

    // The answer is classified HERE, on the one path that has it, rather than handed back raw
    // for the caller to guess at: see `voiceAnswerRefusal`. A `2xx` that carries a transcript
    // comes back untouched, so the caller reads it exactly as it always has.
    return (await voiceAnswerRefusal(response)) ?? response;
  }

  // The proxy hop is a different protocol from the one above: this is the client talking to
  // CloudCLI (field `audio`, model and key in headers), not to the recogniser's endpoint.
  const body = new FormData();
  body.append('audio', blob, filename);
  if (listenId !== undefined) body.append('listenId', listenId);
  // The generic proxy branch keeps the server's own default. A context is appended only when the
  // resolved profile is one this client knows ACKNOWLEDGES it; with no profile there is no
  // declaration to read, and the safe reading is to send none.
  if (context !== undefined && profile !== null && profile.capabilities.honors.context) {
    body.append('context', context);
  }
  return api.voice.transcribe(body, voiceConfigHeaders());
}

/**
 * Uploads one listen's RAW (pre-VAD) audio into the deployment's passive corpus, paired by `listenId`.
 *
 * IT GOES THROUGH THE PROXY ONLY, and that is the whole routing decision: raw capture is the
 * DEPLOYMENT's corpus — kept by the server that owns the capture directory — so unlike a
 * transcription there is no user's own backend to send it to. A direct-backend deployment with raw
 * capture on still uploads raw here, to the CloudCLI it is already authenticated against.
 *
 * NOTHING IS READ FROM THE ANSWER. The server writes a row and (when the switch is on for it) a file;
 * the bytes of the response carry nothing the recording path acts on. The promise still rejects when
 * the transport fails, so the caller can decide not to care — see `useVoiceInput`, which never awaits
 * it and swallows the rejection, because a corpus upload must not become a dictation failure.
 */
export async function captureRawVoice(
  listenId: string,
  blob: Blob,
  filename: string,
): Promise<Response> {
  const body = new FormData();
  body.append('audio', blob, filename);
  body.append('listenId', listenId);
  return api.voice.captureRaw(body, voiceConfigHeaders());
}

/**
 * Reads the recogniser's answer out of a transcription response.
 *
 * Named and exported rather than left inline where the direct path is called: the
 * tolerance of this parse is half of what the voice chain promises, and the other
 * half lives on the server, so a reader has to be able to drive *this* parse on
 * the same response shapes the server-side one is driven on. An inline expression
 * could only be measured by a second implementation of it, which would be a
 * reading of the reader rather than of the app. `scripts/asr-extraction-parity-check.mjs`
 * drives this symbol; the proxy path reads its (tolerant) counterpart in
 * `server/modules/voice/voice.service.ts`.
 *
 * Behaviour is deliberately the direct path's strict one: a body that is not JSON
 * is an error, not text. The proxy's tolerance is applied where the proxy applies
 * it, not here.
 *
 * The parse itself is not written here. It is one of the two branches of the one
 * implementation of this wire protocol (`shared/asr/transcriptionWire.ts`), named at this call
 * site rather than restated: this symbol is the frontend's address for it, kept because the
 * reader above drives it by name, and delegating because a copy here is the second
 * implementation that module exists to prevent.
 */
export async function parseTranscriptionResponse(response: Response): Promise<string> {
  return readTranscriptionResponse(response, 'strict');
}

/**
 * Synthesizes speech for the given text, using the user's configured OpenAI-compatible
 * endpoint when one is set and otherwise the CloudCLI voice proxy.
 */
export async function synthesizeVoice(text: string, signal: AbortSignal): Promise<Response> {
  // Same reason as transcribeVoice: choose the direct endpoint only from a copy
  // that has actually been loaded.
  await whenVoiceConfigReady();
  const config = readVoiceConfig();

  if (config.baseUrl.trim()) {
    return fetch(voiceDirectUrl(config.baseUrl.trim(), '/audio/speech'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.ttsModel || 'tts-1',
        voice: config.ttsVoice || 'alloy',
        input: text,
        ...(config.ttsFormat.trim() ? { response_format: config.ttsFormat.trim() } : {}),
      }),
      signal,
    });
  }

  return api.voice.tts(text, { headers: voiceConfigHeaders(), signal });
}
