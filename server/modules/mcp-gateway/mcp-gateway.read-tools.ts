/**
 * The MCP gateway's stage-3 read tools (AC-245).
 *
 * This module owns the one statement of "which read tools exist at stage 3":
 * {@link MCP_STAGE3_READ_TOOLS} names each tool with the scope it requires, and
 * {@link registerMcpReadTools} installs exactly those names through the audited
 * registration seam AC-244 landed. A later task that fills in `overview`,
 * `run_get` or `quay_snapshot` replaces a handler here, and must NOT rename a
 * tool, because the name set is a contract the criteria compare against
 * `tools/list` byte for byte. The set has grown exactly once on purpose —
 * `ui_last_opened_session` (gap-mcp-ui-last-opened-session) — and the criteria
 * that pinned the old size (the stage-3 count and the error-probe table) were
 * updated with it; a further addition must do the same rather than slip in.
 *
 * Every tool in this module is READ-ONLY. The four implemented ones answer from
 * the services the composition root injects (projects, providers' sessions,
 * session hosts, the chat run registry) and never write anything. `overview` and
 * `quay_snapshot` are AC-247's: when the deps carry the quay runner and activity
 * store, `registerMcpReadTools` routes them to `mcp-overview-tools.js`'s real
 * handlers; when those are absent, they keep their body-table refusal with a
 * named `MCP_TOOL_NOT_IMPLEMENTED` code. `run_get` is AC-248's and is routed the
 * same way to `mcp-run-get.js` when the deps carry its bag; until then it keeps
 * the same refusal.
 *
 * `ui_last_opened_session` (gap-mcp-ui-last-opened-session) is one of the tools
 * this table GAINED after AC-245 rather than having a handler replaced: it is
 * routed to `mcp-ui-tools.js` when the deps carry the browser pointer reader,
 * and keeps the same named refusal otherwise. Its summary is `session_get`'s own
 * reading ({@link buildSessionDetail}), so the two can never drift apart.
 *
 * `ui_visible_context` (gap-mcp-ui-visible-context) and `ui_clients_list`
 * (gap-mcp-ui-clients-list) are the other two: the observer and the discoverer
 * of the connected browsers, routed to `mcp-ui-visible-context.js` and
 * `mcp-ui-clients-list.js` when the deps carry the round trip, and keeping the
 * same named refusal otherwise. `session_search` (gap-mcp-session-search) is the
 * third GAINED after AC-245 and the first read tool that spans every project at
 * once: routed to `mcp-session-search.js` when the deps carry the conversation
 * search engine, and keeping the same named refusal otherwise. This module
 * GAINING a tool is deliberate and
 * costs three edits in tandem (this table, `mcp-tool-annotations.ts`, and
 * `mcp-tool-error-codes.ts`, whose records are total over the name union), plus
 * the size pins the criteria hold — never a silent addition. `ui_selected_text`
 * (gap-ui-visible-context-extended-fields) is the fourth GAINED after AC-245: the
 * one content-bearing read tool, the user's transcript selection, which routes to
 * the same `mcp-ui-visible-context.js` round trip but gates the text behind the
 * `cloudcli:selection` scope. It is also the reason the read seam's handler now
 * receives the caller's `{ principal }` (see {@link McpReadToolContext}), which it
 * did not before.
 *
 * Two text-shaping helpers are exported because the criterion drives them
 * directly as well as through a tool: {@link paginateMcpText} (the 4000-character
 * cursor protocol) and {@link formatMcpTime} (the relative + ISO pair every time
 * field carries).
 *
 * Cross-module access goes through the barrels (`@/modules/projects/index.js`
 * and friends) — except for the shared vocabulary in `@/shared/types.js`, which
 * is not a module and is imported directly everywhere in this codebase.
 */

import { z } from 'zod';

import type { HostMode, HostState, LLMProvider, NormalizedMessage, ProcessHost } from '@/shared/types.js';

import type { McpToolInputSchema } from './mcp-gateway.audit.js';
import type { McpPrincipal } from './mcp-gateway.auth.js';
import { MCP_CORRELATION_ID_INPUT_FIELD, readCorrelationId } from './mcp-correlation-id.js';
import { MCP_ERROR_CODES, McpToolError } from './mcp-error-envelope.js';
import {
  DRAFT_GET_DESCRIPTION,
  DRAFT_GET_INPUT_SCHEMA,
  DRAFT_GET_OUTPUT_SCHEMA,
  DRAFT_GET_TOOL_NAME,
  registerMcpDraftGetTool,
} from './mcp-draft.js';
import type { McpDraftDeps } from './mcp-draft.js';
import { isOverviewWired, overviewOutputSchema, registerMcpOverviewTools } from './mcp-overview-tools.js';
import type { McpActivityReader, McpOverviewDeps, McpOverviewRegistration, McpQuayRunner } from './mcp-overview-tools.js';
import { isRunGetWired, registerMcpRunGetTool } from './mcp-run-get.js';
import type { McpRunGetDeps, McpRunGetRegistration } from './mcp-run-get.js';
import { isSessionSearchWired, registerMcpSessionSearchTool } from './mcp-session-search.js';
import type { McpSessionSearchDeps, McpSessionSearchRegistration } from './mcp-session-search.js';
import { isUiClientsListWired, registerMcpUiClientsListTool } from './mcp-ui-clients-list.js';
import type { McpUiClientsListDeps } from './mcp-ui-clients-list.js';
import {
  isUiVisibleContextWired,
  registerMcpUiSelectedTextTool,
  registerMcpUiVisibleContextTool,
} from './mcp-ui-visible-context.js';
import type { McpUiVisibleContextDeps } from './mcp-ui-visible-context.js';
import { isUiLastOpenedWired, registerMcpUiTools } from './mcp-ui-tools.js';
import type { McpUiLastOpenedDeps, McpUiLastOpenedStore } from './mcp-ui-tools.js';
import {
  MCP_USAGE_STATS_DESCRIPTION,
  MCP_USAGE_STATS_INPUT_SCHEMA,
  MCP_USAGE_STATS_OUTPUT_SCHEMA,
  MCP_USAGE_STATS_TOOL_NAME,
  runMcpUsageStats,
} from './mcp-usage-stats.js';
import { toPendingInteraction } from './mcp-approvals.js';
import type { McpApprovalPending } from './mcp-approvals.js';
import {
  MCP_CHANGES_INPUT_SCHEMA,
  MCP_CHANGES_OUTPUT_SCHEMA,
  isChangesWired,
  registerMcpChangesTool,
} from './mcp-changes.js';
import type { McpChangesDeps } from './mcp-changes.js';

// --------------------------- the stage-3 tool table ---------------------------

/** The scope every stage-3 read tool requires. */
const READ_SCOPE = 'cloudcli:read';

/**
 * Every read tool this stage ships, with the scope a caller's token must carry.
 * The single source of truth for (a) "exactly this set": the criterion compares
 * the SDK's `tools/list` names against this array, and
 * {@link registerMcpReadTools} reads each registration's `requiredScope` from
 * here rather than restating the literal.
 */
export const MCP_STAGE3_READ_TOOLS = [
  {
    name: 'overview',
    requiredScope: READ_SCOPE,
    description: 'Project overview: stage, open work and recent activity as one reading.',
  },
  {
    name: 'projects_list',
    requiredScope: READ_SCOPE,
    description: 'List every project with its session count and last activity.',
  },
  {
    name: 'sessions_list',
    requiredScope: READ_SCOPE,
    description:
      'List sessions, optionally filtered by project and by state (running / idle / resident). `correlationId` narrows the list to sessions whose live run carries that opaque label; `limit` caps how many sessions are returned, from 1 to 200; `total` still reports the full filtered count, so a caller can tell the list was truncated.',
  },
  {
    name: 'session_get',
    requiredScope: READ_SCOPE,
    description: 'Read one session: its metadata, its host (state, pid, leases, peer name) and its current run.',
  },
  {
    name: 'session_read',
    requiredScope: READ_SCOPE,
    description: 'Read one session transcript: latest messages, the user-turn outline, or a window around a message.',
  },
  {
    name: 'run_get',
    requiredScope: READ_SCOPE,
    description:
      'Read one run by id — or one delivery by id — waiting a bounded time for it to settle. Name only one of runId and deliveryId.',
  },
  {
    name: 'quay_snapshot',
    requiredScope: READ_SCOPE,
    description: 'Refresh and read the quay snapshot for a project.',
  },
  {
    name: 'ui_last_opened_session',
    requiredScope: READ_SCOPE,
    description:
      'Read the session the user last opened in the browser UI: its summary, host and current run, plus when it was opened.',
  },
  {
    name: 'ui_visible_context',
    requiredScope: READ_SCOPE,
    description:
      'Ask the connected browsers what they are showing right now: per device and tab, the open project and session, the visible message id range, the panel, and the pending approval and queued message counts. Identifiers and ranges only — read message text with session_read.',
  },
  {
    name: 'ui_clients_list',
    requiredScope: READ_SCOPE,
    description:
      'List the browsers connected right now: the identity of each device, its tabs, its navigation policy, and its current visibility and focus. Identity and status only — pick a device here, then read what it is showing with ui_visible_context.',
  },
  {
    name: 'session_search',
    requiredScope: READ_SCOPE,
    description:
      'Search every project\'s stored session transcripts and titles for literal text. FULL-TEXT, NOT SEMANTIC: the query is matched case-insensitively against the exact characters a transcript contains, so synonyms and reworded phrases do not match — pass several separate keyword sets (one query per call) rather than one long question. Returns one entry per matched session (sessionId, project, title, last activity, and a sort key called score that is a deterministic ranking, NOT a relevance probability) with the matched messages inside it: a message\'s messageId can be passed to session_read with mode "around" to expand that hit into its surrounding window (null for providers that hand out no per-message id, and messageId is not accepted by other modes), and each match carries turnIndex — the user-turn number session_read with mode "outline" prints as #index, or null when the match has no per-row id or names no user turn. Pass `since` and/or `until` (ISO 8601) to search only sessions whose last activity falls in that inclusive window; an out-of-window session is never scanned. One call scans at most 200 transcript files or 3000 ms, whichever comes first, so a large corpus is paged: when a scan stops short `hasMore` is true and `nextCursor` continues it, and `scannedThrough` reports the oldest activity the call actually read. `limit` caps how many SESSIONS a page returns, from 1 to 50; `totalMatches` counts matches across every session the filters kept; `moreAvailable` is the same reading as `hasMore`, and the `cursor` that pages to the next page is best-effort — a session whose matches changed between calls can shift the window.',
  },
  {
    name: 'ui_selected_text',
    requiredScope: READ_SCOPE,
    description:
      'Read the text the user has selected inside the transcript, per device and tab. This returns the user\'s SELECTED CONTENT — the one content-bearing read tool, and more sensitive than an id — so it requires the cloudcli:selection scope: a token without that scope reads "withheld" for a tab that HAS a selection (never the text, and never a false "nothing selected"), and null for a tab with none. Clipped to 500 characters with a `truncated` flag; region is always "transcript".',
  },
  {
    // gap-mcp-usage-stats (AC-334): a pure SQL aggregation, so its
    // implementation lives in `mcp-usage-stats.js` and only its name, scope and
    // description are owned by this table — the same one statement every other
    // stage-3 tool is registered from. It takes no injected deps (only the
    // request principal), so it is always real, never a body-table refusal.
    name: MCP_USAGE_STATS_TOOL_NAME,
    requiredScope: READ_SCOPE,
    description: MCP_USAGE_STATS_DESCRIPTION,
  },
  {
    // AC-335 (gap-mcp-changes-on-demand-event-stream), Quay half revised by AC-348
    // (gap-mcp-changes-quay-status-index-async-bootstrap) and the cursor made BOUNDED
    // by AC-349 (gap-mcp-changes-cursor-bounded-rebase): the on-demand incremental
    // change stream. It answers "what moved since this cursor" from the watcher's
    // database, the in-memory run/approval state, and a per-project Quay status
    // index — never a full session synchronisation, and never a Quay CLI spawn it
    // waits on: a project whose index is missing or stale gets a deduplicated,
    // rate-limited `requestTaskIndexLoad` fired into the background, and this call
    // answers from whatever the index holds (reporting the state in `sources`).
    // Its handler lives in `mcp-changes.js`; only its name, scope and description
    // are owned here.
    name: 'changes',
    requiredScope: READ_SCOPE,
    description:
      'Read what changed since a cursor: sessions, runs, pending approvals and Quay task status transitions as one incremental stream. Pass back the returned `cursor` to continue; each event carries its `kind`, project, `signal` (liveness / progress / blocked), a body-free `summary` and a `source` with `observedAt` and `ageMs`, so the watcher lag is visible. `complete` is false when something cannot be seen (a restart hid in-memory run/approval changes, a page was truncated, or a project\'s Quay index is not ready yet) and `gaps` says why. Reads the watcher database, in-memory run/approval state and a per-project Quay status index; it never triggers a full synchronisation, and it never blocks on a Quay CLI run — `sources` says where each project\'s index stands (cold / warming / bootstrap / ready / stale / rebase / error) and an index is refilled by a deduplicated, rate-limited background load. The cursor is BOUNDED: it carries one compact `{baselineId, digest}` reference per Quay project instead of that project\'s task table, the baselines live server-side in a bounded store (capacity 256 baselines, at most 10000 tasks each), and the encoded cursor never exceeds 8192 bytes. A baseline the store evicted, one whose digest no longer matches, one lost to a service restart, and a reference dropped to keep the cursor within its budget all report `state: "rebase"` with `complete: false` and NO events, meaning changes in that window may not be reported; the next call re-establishes a baseline and is ready again. `limit` is 1 to 200, default 50.',
  },
] as const;

/** One stage-3 read tool's name, derived from the table so the two cannot drift. */
export type McpStage3ReadToolName = (typeof MCP_STAGE3_READ_TOOLS)[number]['name'];

// --------------------------- injected services ---------------------------

/** A project as `projects_list` reports it. */
export type McpProjectReading = {
  id: string;
  name: string;
  path: string;
  sessionCount: number;
  lastActivity: McpTime | null;
  isArchived: boolean;
};

/** One session as `sessions_list` reports it. */
export type McpSessionReading = {
  id: string;
  title: string;
  provider: string;
  projectId: string | null;
  lifecycleMode: string;
  hostState: HostState | null;
  running: boolean;
  /**
   * True when the session has a pending tool approval waiting on a person — the
   * reading `HOST_STATES` cannot express (a session parked on an approval is
   * `host.state: 'busy'`, indistinguishable from one that is simply working).
   * Derived from the same pending set `approvals_list` reports, so the two
   * cannot disagree.
   */
  awaitingUser: boolean;
  lastActivity: McpTime | null;
};

/**
 * The pending-approval reader `session_get` / `sessions_list` draw their
 * pending-interaction reading from.
 *
 * Structurally a single-session view of the runtime's own
 * `getPendingApprovalsForSession` — the read tools must not know whether the
 * runtime or the shared control service sits behind it, only that it answers
 * the same entries `approvals_list` does. Optional: a mount that predates this
 * reading (or a criterion exercising only the other tools) simply reports no
 * pending interaction, because this is one more injected capability rather than
 * a condition for serving the tools.
 */
export type McpApprovalReader = {
  pendingForSession(sessionId: string): McpApprovalPending[];
};

/**
 * The services the read tools answer from, all injected.
 *
 * Production passes the process singletons (`server/index.ts`); the criterion
 * passes the same real objects over a temp database and a host manager it drove
 * itself. Only the members a tool actually reads are declared, so a caller
 * cannot be asked for a capability nothing uses.
 */
export type McpReadToolDeps = {
  projects: {
    getProjectsWithSessions(options?: {
      skipSynchronization?: boolean;
      sessionsLimit?: number;
      sessionsOffset?: number;
      includeHidden?: boolean;
    }): Promise<ReadonlyArray<McpProjectPage>>;
    getArchivedProjectsWithSessions(options?: {
      skipSynchronization?: boolean;
    }): Promise<ReadonlyArray<McpProjectPage>>;
    getProjectSessionsPage(
      projectId: string,
      options?: { limit?: number; offset?: number; includeHidden?: boolean },
    ): Promise<McpProjectSessionsPage>;
    /**
     * The id of the project stored at one filesystem path, or null when no
     * project is registered there (gap-mcp-session-get-past-recents-page-and-
     * small-envelope-defects). It resolves the `projectId` of a session read by
     * id — the one field whose value `listRecentSessions` takes from a lookup
     * rather than from the session row itself.
     *
     * REQUIRED, not optional: a mount that wires the by-id reader
     * (`sessions.readSessionById`) cannot project that field without it, and an
     * optional member let the production assembly replace the `projects` bag
     * without it and read `projectId: null` for every by-id `session_get`
     * (gap-mcp-session-get-projectid-null-under-production-gateway-assembly).
     * Both `server/index.ts` and `createMcpGatewayModule` bind it to the project
     * repository's `getProjectPath(...).project_id` — the same lookup
     * `sessionsService.listRecentSessions` uses.
     */
    getProjectIdByPath(projectPath: string): string | null;
  };
  sessions: {
    listRecentSessions(limit: number, offset: number): McpRecentSessionsPage;
    /**
     * One session's recents row read straight by id, or null when the id names
     * no visible session (gap-mcp-session-get-past-recents-page-and-small-
     * envelope-defects).
     *
     * `listRecentSessions` is a bounded PAGE of the recents feed, so a session
     * older than that page is simply not in it — and `session_get` used to
     * answer SESSION_NOT_FOUND for exactly such a session. This reader resolves
     * one id directly, so it has no page to fall outside of. Optional so a mount
     * that predates this task — the run-get/overview criteria, and
     * `mcp-production-session-wiring.test.ts`, which pass the service bundle
     * itself — stays a valid `McpReadToolDeps`; when absent, `buildSessionDetail`
     * falls back to the recents page it has always read. `server/index.ts` binds
     * it to the session repository's own by-id lookup; the row is projected by
     * the gateway (`toSessionRow`), so a session read by id and the same session
     * read in the recents list cannot disagree.
     */
    readSessionById?(sessionId: string): McpSessionLookupRow | null;
    readSessionLifecycle(sessionId: string): McpSessionLifecycle | null;
    fetchHistory(sessionId: string, options?: { limit?: number | null; offset?: number }): Promise<McpHistoryPage>;
    fetchOutline(sessionId: string): Promise<McpOutline>;
    fetchWindowAround(
      sessionId: string,
      options: { aroundId: string; before: number; after: number },
    ): Promise<McpMessageWindow>;
  };
  hosts: {
    snapshot(): ProcessHost[];
    liveHostForSession(appSessionId: string): ProcessHost | null;
  };
  runs: {
    listRunningRuns(): McpRunningRun[];
    /**
     * Every run the registry still holds (running plus terminal inside the
     * retention window), as summaries. Consumed by `overview` (AC-247) to read
     * the aborted runs; structurally satisfied by `chatRunRegistry.listRecentRuns`.
     * Optional so a mount that never wires the overview tools (AC-240/244/245's
     * criteria) stays a valid `McpReadToolDeps`; `isOverviewWired` requires it
     * before the overview handlers are installed.
     */
    listRecentRuns?(): McpRunSummary[];
  };
  /**
   * The quay command runner (AC-247). Optional so a mount that predates AC-247 —
   * or a criterion that exercises only the five non-overview read tools — is
   * still a valid `McpReadToolDeps`. When absent, `overview` and `quay_snapshot`
   * keep their named `MCP_TOOL_NOT_IMPLEMENTED` refusal; when present they answer
   * for real. `registerMcpReadTools` branches on this.
   */
  quay?: McpQuayRunner;
  /** The activity store's turn-phase reader (AC-247). Optional; see `quay`. */
  activity?: McpActivityReader;
  /**
   * The services `run_get` answers from (AC-248): the run registry, the activity
   * store, the sessions history reader, and the clock/sleeper the bounded wait
   * moves through. Optional so a mount that predates AC-248 — or a criterion
   * that exercises the other six read tools — is still a valid
   * `McpReadToolDeps`; when absent `run_get` keeps its named
   * `MCP_TOOL_NOT_IMPLEMENTED` refusal, when present `registerMcpReadTools`
   * routes the `run_get` name to {@link registerMcpRunGetTool}. `server/index.ts`
   * assembles it from the process singletons.
   */
  runGet?: McpRunGetDeps;
  /**
   * The browser's last-opened-session pointer (gap-mcp-ui-last-opened-session):
   * a read-only reader over the one row the provider's session-read routes write.
   * Optional so a mount that predates this task — or a criterion that exercises
   * the other read tools — is still a valid `McpReadToolDeps`; when absent
   * `ui_last_opened_session` keeps its named `MCP_TOOL_NOT_IMPLEMENTED` refusal,
   * when present `registerMcpReadTools` routes the name to
   * {@link registerMcpUiTools}. `server/index.ts` binds it to
   * `uiLastOpenedSessionService.readLastOpened`.
   */
  uiLastOpened?: McpUiLastOpenedStore;
  /**
   * The UI-visible-context reader (gap-mcp-ui-visible-context): the connected
   * devices a `client` reference resolves against, and the round trip that asks
   * them what they are showing. Optional so a mount that predates this task —
   * or a criterion that exercises the other read tools — is still a valid
   * `McpReadToolDeps`; when absent `ui_visible_context` keeps its named
   * `MCP_TOOL_NOT_IMPLEMENTED` refusal, when present `registerMcpReadTools`
   * routes the name to {@link registerMcpUiVisibleContextTool}. `server/index.ts`
   * binds both members to the websocket module's own process-wide services.
   */
  uiVisibleContext?: McpUiVisibleContextDeps;
  /**
   * The connected-device listing (gap-mcp-ui-clients-list): the roster a
   * `ui_clients_list` call enumerates, and the same round trip
   * `ui_visible_context` uses for the status it reads from each device. Optional
   * so a mount that predates this task — or a criterion that exercises the other
   * read tools — is still a valid `McpReadToolDeps`; when absent `ui_clients_list`
   * keeps its named `MCP_TOOL_NOT_IMPLEMENTED` refusal, when present
   * `registerMcpReadTools` routes the name to
   * {@link registerMcpUiClientsListTool}. `server/index.ts` binds both members to
   * the same process-wide services `uiVisibleContext` binds above.
   */
  uiClientsList?: McpUiClientsListDeps;
  /**
   * The conversation-search engine (gap-mcp-session-search): the same scanner
   * the session-search route calls. Optional so a mount that predates this task
   * — or a criterion that exercises the other read tools — is still a valid
   * `McpReadToolDeps`; when absent `session_search` keeps its named
   * `MCP_TOOL_NOT_IMPLEMENTED` refusal, when present `registerMcpReadTools`
   * routes the name to {@link registerMcpSessionSearchTool}. `server/index.ts`
   * binds `search` to `sessionConversationsSearchService.search`.
   */
  sessionSearch?: McpSessionSearchDeps;
  /**
   * The per-session composer draft store (gap-mcp-draft-get-set-submit): the
   * existing `session_drafts` repository the browser's `/api/user/drafts` routes
   * write. Optional so a mount that predates this task — or a criterion that
   * exercises the 12-tool stage-3 set — is still a valid `McpReadToolDeps`; when
   * absent `draft_get` is simply NOT registered (the resident-tools precedent,
   * not the body-table refusal: `draft_get` is not one of the stage-3 table's
   * names and must not enlarge `tools/list` on a mount that cannot serve it),
   * when present `registerMcpReadTools` registers it through
   * {@link registerMcpDraftGetTool}. `server/index.ts` binds it to
   * `sessionDraftsDb`.
   */
  draft?: McpDraftDeps;
  /**
   * The pending-approval reader `session_get` / `sessions_list` report a
   * session's pending interaction and `awaitingUser` from
   * (gap-mcp-pending-interaction-visibility-and-idempotent-answer). Optional:
   * absent, a session reads `pendingInteraction: null` /
   * `awaitingUser: false`, which is exactly the reading for a mount that has no
   * approval source to consult. `server/index.ts` binds it to the runtime
   * service's own pending lookup.
   */
  approvals?: McpApprovalReader;
  /**
   * The services `changes` answers from (AC-335): the incremental session reader,
   * the run registry, the pending-approval set, the Quay CACHE reader, the
   * project list, and the clock/process identity. Optional so a mount that
   * predates AC-335 — or a criterion that exercises the other read tools — is
   * still a valid `McpReadToolDeps`; when absent `changes` keeps its named
   * `MCP_TOOL_NOT_IMPLEMENTED` refusal, when present `registerMcpReadTools`
   * routes the name to {@link registerMcpChangesTool}. `server/index.ts`
   * assembles it from the process singletons.
   */
  changes?: McpChangesDeps;
  /** Clock seam, so every relative time is reproducible in a criterion. */
  now: () => number;
};

/** The slice of a project row the tools read (structurally satisfied by `ProjectListItem`). */
type McpProjectPage = {
  projectId: string;
  path: string;
  displayName: string;
  sessionMeta: { total: number };
  sessions: ReadonlyArray<{ lastActivity?: string | null }>;
  /** Present only on the archived listing; absent on the active one. */
  isArchived?: boolean;
};

/** The slice of one project-page session the tools read (structurally satisfied by `SessionSummary`). */
type McpProjectSession = {
  id: string;
  provider: string;
  summary: string;
  lastActivity?: string | null;
};

/** The slice of one recents-list row the tools read (structurally satisfied by `RecentSessionListItem`). */
type McpRecentSession = {
  sessionId: string;
  provider: string;
  projectId: string | null;
  sessionTitle: string;
  lastActivity: string | null;
};

/** One outline turn as the provider service returns it. */
type McpOutlineTurn = { id: string; index: number; timestamp: string; preview: string };

/** The project-sessions page the tools read (structurally satisfied by `ProjectSessionsPageApiView`). */
type McpProjectSessionsPage = { projectId: string; sessions: ReadonlyArray<McpProjectSession> };

/** The recents page the tools read (structurally satisfied by `RecentSessionsPage`). */
type McpRecentSessionsPage = { conversations: ReadonlyArray<McpRecentSession>; total: number };

/** One session's stored lifecycle preference (structurally satisfied by `SessionLifecycleReading`). */
type McpSessionLifecycle = { provider: LLMProvider; mode: HostMode };

/** A history page (structurally satisfied by `FetchHistoryResult`). */
type McpHistoryPage = { messages: ReadonlyArray<NormalizedMessage>; total: number };

/** A turn outline (structurally satisfied by `SessionTurnOutline`). */
type McpOutline = { total: number; turns: ReadonlyArray<McpOutlineTurn> };

/** A window around one message (structurally satisfied by `SessionMessageWindow`). */
type McpMessageWindow = { messages: ReadonlyArray<NormalizedMessage>; startIndex: number; total: number };

/** One live run (structurally satisfied by the chat run registry's reading). */
export type McpRunningRun = {
  sessionId: string;
  provider: LLMProvider;
  startedAt: number;
  lastSeq: number;
  /**
   * AC-337: the opaque label the caller that opened this run attached, or null.
   * OPTIONAL on this structural dep type (the registry's own reading always
   * carries it) so a mount that predates AC-337 — every criterion that fakes a
   * registry — stays a valid `McpReadToolDeps`; an absent reading is `undefined`,
   * which matches no label and therefore widens nothing. Consumed by
   * `sessions_list`'s optional `correlationId` filter.
   */
  correlationId?: string | null;
};

/** One tracked run's read-only summary (structurally satisfied by `ChatRunSummary`). */
export type McpRunSummary = {
  runId: string;
  sessionId: string;
  status: 'running' | 'completed' | 'aborted';
  startedAt: number;
  completedAt: number | null;
};

// --------------------------- time ---------------------------

/** A time as every read tool reports it: both readings of the same instant. */
export type McpTime = { relative: string; iso: string };

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Renders one instant as a relative phrase beside its ISO timestamp.
 *
 * Both readings come from the SAME instant, which is the point: a client that
 * only draws "3 minutes ago" cannot tell a stale reading from a fresh one, and a
 * client that only draws the ISO forces a human to subtract. `now` is injected
 * so the relative half is exactly predictable rather than merely plausible.
 *
 * Consumers: every read tool's time field, and the criterion, which pins a
 * clock and asserts both halves verbatim.
 */
export function formatMcpTime(ms: number, now: () => number): McpTime {
  const elapsed = Math.max(0, now() - ms);
  let relative: string;
  if (elapsed < MINUTE_MS) {
    relative = 'just now';
  } else if (elapsed < HOUR_MS) {
    relative = `${Math.floor(elapsed / MINUTE_MS)} minutes ago`;
  } else if (elapsed < DAY_MS) {
    relative = `${Math.floor(elapsed / HOUR_MS)} hours ago`;
  } else {
    relative = `${Math.floor(elapsed / DAY_MS)} days ago`;
  }

  return { relative, iso: new Date(ms).toISOString() };
}

/**
 * The time field for a stored timestamp, or null when the row carries none.
 *
 * The stored value is whatever a session row holds — canonical ISO for rows the
 * session repository normalized, and possibly a SQLite `YYYY-MM-DD HH:MM:SS`
 * form for one it did not. An unparseable value reads as null rather than as
 * "now", because a time field that quietly means "I do not know" is worse than
 * an absent one.
 *
 * Exported so the sibling read-tool modules render a stored stamp the SAME way:
 * `mcp-session-search.js` reads a matched message's `timestamp` and a hit's
 * `lastActivity` through this one function rather than restating the parse.
 * Consumers: every read tool's time field, and `mcp-session-search.js`.
 */
export function readTimeField(value: string | null | undefined, now: () => number): McpTime | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : formatMcpTime(parsed, now);
}

// --------------------------- text pagination ---------------------------

/** How many characters one `content` chunk carries. Characters, not bytes. */
export const MCP_TEXT_CHUNK_CHARS = 4000;

/** The opaque continuation token: the character offset of the next chunk. */
function encodeMcpCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64');
}

/** Decodes a cursor; anything unreadable restarts at the beginning. */
function decodeMcpCursor(cursor: string | undefined): number {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    return 0;
  }
  const decoded = Number.parseInt(Buffer.from(cursor, 'base64').toString('utf8'), 10);
  return Number.isFinite(decoded) && decoded > 0 ? decoded : 0;
}

/**
 * Slices one piece of text for transport, returning the rest as a cursor.
 *
 * The protocol is stateless and lossless: a chunk is at most
 * {@link MCP_TEXT_CHUNK_CHARS} characters, a cursor names the character offset
 * of the next chunk (base64, opaque), and calling again with that cursor — and
 * the SAME selection arguments — yields the next chunk. Concatenating every
 * chunk's `content` in order reproduces the input byte for byte, whitespace and
 * newlines included.
 *
 * A text that fits returns no `cursor` at all. That is a deliberate reading:
 * "there is more" must be a field's presence, so a client that loops until the
 * cursor disappears cannot loop forever on a chunk that was already the last
 * one.
 *
 * Consumers: `session_read`'s output, and the criterion, which drives both the
 * multi-chunk reassembly and the single-chunk negative control.
 */
export function paginateMcpText(text: string, cursor?: string): { content: string; cursor?: string } {
  const offset = decodeMcpCursor(cursor);
  const content = text.slice(offset, offset + MCP_TEXT_CHUNK_CHARS);
  const next = offset + content.length;
  return next < text.length ? { content, cursor: encodeMcpCursor(next) } : { content };
}

// --------------------------- transcript rendering ---------------------------

/** Cap on one inlined argument/result summary, so a tool call stays one line. */
const INLINE_SUMMARY_CHARS = 200;

/** One value's text on a single line: every run of whitespace becomes one space. */
function collapseToOneLine(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * One value as a single line.
 *
 * Tool calls carry structures (an argument bag, a result body that may hold
 * newlines); a transcript line that leaked those would turn one tool call into
 * many drawn rows, which is exactly what folding exists to prevent. The cap
 * belongs to these summaries and not to a message's own text: a long message is
 * what the cursor protocol exists for, and truncating it here would make that
 * protocol unreachable.
 */
function inline(value: unknown): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value ?? null) ?? 'null';
  const collapsed = collapseToOneLine(raw);
  return collapsed.length > INLINE_SUMMARY_CHARS ? `${collapsed.slice(0, INLINE_SUMMARY_CHARS)}…` : collapsed;
}

/**
 * One normalized message as one line.
 *
 * A `tool_use` and the result that belongs to it are ONE line — the call, then
 * its outcome — because the provider's history reader folds the result onto the
 * call and a reader that drew them separately would show a tool call twice. The
 * fold is observable: the line names the tool, its arguments and its result.
 */
function renderMessageLine(message: NormalizedMessage): string {
  const stamp = message.timestamp ?? '';
  if (message.kind === 'tool_use') {
    const name = message.toolName ?? 'tool';
    const errorFlag = message.toolResult?.isError ? ' [error]' : '';
    const result = message.toolResult === undefined ? '(no result)' : inline(message.toolResult.content);
    return `[${stamp}] tool ${name}(${inline(message.toolInput)})${errorFlag} -> ${result}`;
  }
  if (message.kind === 'tool_result') {
    return `[${stamp}] tool_result ${inline(message.content)}`;
  }
  return `[${stamp}] ${message.role ?? message.kind}: ${collapseToOneLine(String(message.content ?? message.text ?? ''))}`;
}

// --------------------------- argument reading ---------------------------

/** The JSON-RPC code a tool returns when it is registered but owned by a later task. */
export const MCP_TOOL_NOT_IMPLEMENTED_CODE = 'MCP_TOOL_NOT_IMPLEMENTED';

function requireStringArgument(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new McpToolError(
      MCP_ERROR_CODES.INVALID_ARGUMENT,
      `"${key}" is required and must be a non-empty string.`,
    );
  }
  return value;
}

function optionalPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

// --------------------------- shared session reads ---------------------------

/** How many recent sessions one `sessions_list` page reads. */
const SESSION_LIST_PAGE_SIZE = 200;

/**
 * The largest `limit` `sessions_list` accepts. It IS {@link SESSION_LIST_PAGE_SIZE}:
 * the reads already cap a page there, so a caller cannot ask for more rows than
 * the page can hold — a larger `limit` would promise sessions the read never saw.
 * Declared on the tool's input schema so the bound is advertised and enforced
 * (an out-of-range value is an `INVALID_ARGUMENT`, never a silent truncation).
 */
const MCP_SESSION_LIST_MAX_LIMIT = SESSION_LIST_PAGE_SIZE;

/** `session_read` returns this many messages when the caller names no limit. */
const DEFAULT_LATEST_LIMIT = 5;

type SessionRow = {
  id: string;
  title: string;
  provider: string;
  projectId: string | null;
  lastActivity: string | null;
};

/**
 * Every session the recents read sees, as the flat rows the tools project.
 *
 * One page is enough for this stage's fixture and for any workspace a caller
 * reads interactively; a workspace with more sessions than one page simply
 * reads the first page, which is the same bound every other recents consumer
 * takes.
 */
function readRecentSessionRows(deps: McpReadToolDeps): SessionRow[] {
  const page = deps.sessions.listRecentSessions(SESSION_LIST_PAGE_SIZE, 0);
  return page.conversations.map((row) => ({
    id: row.sessionId,
    title: row.sessionTitle,
    provider: row.provider,
    projectId: row.projectId,
    lastActivity: row.lastActivity,
  }));
}

/** The sessions of one project, as the same flat rows. */
async function readProjectSessionRows(deps: McpReadToolDeps, projectId: string): Promise<SessionRow[]> {
  const page = await deps.projects.getProjectSessionsPage(projectId, {
    limit: SESSION_LIST_PAGE_SIZE,
    offset: 0,
    includeHidden: true,
  });
  return page.sessions.map((row) => ({
    id: row.id,
    title: row.summary,
    provider: row.provider,
    projectId,
    lastActivity: row.lastActivity ?? null,
  }));
}

/**
 * The slice of one stored session row the by-id reader returns (structurally
 * satisfied by the session repository's own `SessionRow`).
 */
type McpSessionLookupRow = {
  session_id: string;
  provider: string;
  project_path: string | null;
  custom_name: string | null;
  created_at: string | null;
  updated_at: string | null;
  isArchived: number;
};

/**
 * Projects one stored session row into the same flat `SessionRow` the recents
 * page produces, so a session read by id and the same session read in the
 * listing cannot disagree (gap-mcp-session-get-past-recents-page-and-small-
 * envelope-defects).
 *
 * The three projections mirror `sessionsService.listRecentSessions` field for
 * field: the title is the row's display name (its id when it has none), the
 * project id comes through the required project-path lookup, and `lastActivity`
 * is the row's own `updated_at` falling back to `created_at`.
 */
function toSessionRow(stored: McpSessionLookupRow, deps: McpReadToolDeps): SessionRow {
  const projectPath = stored.project_path?.trim() ? stored.project_path : null;
  return {
    id: stored.session_id,
    title: stored.custom_name?.trim() || stored.session_id,
    provider: stored.provider,
    projectId: projectPath === null ? null : deps.projects.getProjectIdByPath(projectPath),
    lastActivity: stored.updated_at ?? stored.created_at ?? null,
  };
}

/**
 * Projects one session row into its listing reading.
 *
 * The three state predicates are defined in exactly one place each:
 * `running` is membership in the run registry's live set, `resident` is the
 * session's own stored lifecycle mode, and `idle` is the complement of both —
 * which is what makes the three sets disjoint by construction rather than by
 * the fixture happening to avoid an overlap.
 */
function toSessionReading(row: SessionRow, deps: McpReadToolDeps, running: ReadonlySet<string>): McpSessionReading {
  return {
    id: row.id,
    title: row.title,
    provider: row.provider,
    projectId: row.projectId,
    lifecycleMode: deps.sessions.readSessionLifecycle(row.id)?.mode ?? 'per-run',
    hostState: deps.hosts.liveHostForSession(row.id)?.state ?? null,
    running: running.has(row.id),
    // "Waiting on a person" is read from the pending set itself, not inferred
    // from `hostState`: a parked session and a hard-working one are both
    // `'busy'`, which is the whole reason this field exists.
    awaitingUser: (deps.approvals?.pendingForSession(row.id).length ?? 0) > 0,
    lastActivity: readTimeField(row.lastActivity, deps.now),
  };
}

function isResident(reading: McpSessionReading): boolean {
  return reading.lifecycleMode === 'resident';
}

/**
 * The one reading behind `session_get` and `ui_last_opened_session`: one
 * session's listing row, its live host (or a stated absence) and its current run.
 *
 * `ui_last_opened_session` reuses this rather than re-projecting the same three
 * fields, so "the same shape as `session_get`" is a structural fact — a field
 * added here appears on both tools at once — instead of a promise two copied
 * bodies would have to keep by hand. Consumers: `session_get`'s body table, and
 * `mcp-ui-tools.js`'s `buildUiLastOpened`.
 */
export function buildSessionDetail(deps: McpReadToolDeps, sessionId: string) {
  // By id when the mount wires the direct reader — one row looked up, with no
  // page it could fall outside of — else the recents-page scan this tool has
  // always used for a mount that predates the reader. An archived row reads as
  // absent either way, because the recents page the listing reads excludes it.
  let row: SessionRow | null;
  if (deps.sessions.readSessionById) {
    const stored = deps.sessions.readSessionById(sessionId);
    row = stored !== null && stored.isArchived === 0 ? toSessionRow(stored, deps) : null;
  } else {
    row = readRecentSessionRows(deps).find((candidate) => candidate.id === sessionId) ?? null;
  }
  if (row === null) {
    throw new McpToolError(MCP_ERROR_CODES.SESSION_NOT_FOUND, `No session has id "${sessionId}".`);
  }

  const running = new Set(deps.runs.listRunningRuns().map((run) => run.sessionId));
  const session = toSessionReading(row, deps, running);
  const live = deps.hosts.liveHostForSession(sessionId);
  const binding = live?.bindings.get(sessionId) ?? null;
  const run = deps.runs.listRunningRuns().find((candidate) => candidate.sessionId === sessionId) ?? null;

  return {
    session,
    // The same projection `approvals_list` reports a request with (minus the
    // session id this tool already named), so a client reading `session_get`
    // sees the identical request id, tool, questions and wait — and needs only
    // this one call to learn a session is parked on a question.
    pendingInteraction: toPendingInteraction(
      deps.approvals?.pendingForSession(sessionId) ?? [],
      deps.now(),
    ),
    host: live === null || binding === null
      ? null
      : {
          hostId: live.hostId,
          mode: live.mode,
          state: live.state,
          pid: live.pid,
          startedAt: formatMcpTime(live.startedAt, deps.now),
          idleForMs: Math.max(0, deps.now() - binding.lastActivityAt),
          peerName: binding.peerName,
          // Verbatim, never summarized: a lease IS the reason a process is
          // still alive, and a client that has to guess it cannot tell a
          // held host from a stuck one.
          leases: binding.leases.map((lease) => ({ ...lease })),
        },
    // A cold session says so in words rather than by an absent key: "there
    // is no host" is a reading, and a missing field is not.
    hostNote:
      live === null || binding === null
        ? 'No host: this session currently has no host process (per-invocation process mode and not running).'
        : null,
    run:
      run === null
        ? null
        : {
            sessionId: run.sessionId,
            provider: run.provider,
            startedAt: formatMcpTime(run.startedAt, deps.now),
            lastSeq: run.lastSeq,
          },
  };
}

// --------------------------- tool bodies ---------------------------

/** The registered body of one tool: everything except the table-owned scope. */
type McpReadToolBody = {
  // AC-288: a raw shape, or a built schema carrying a constraint a raw shape
  // cannot express (`session_read`'s bounded `limit` and its `aroundId` /
  // `cursor` exclusivity). The wrapper advertises and enforces whichever it gets.
  inputSchema: McpToolInputSchema;
  outputSchema: z.ZodRawShape;
  // `ctx` is the caller identity the seam threads in (the transport's principal,
  // or null). Most bodies ignore it; the caller-scoped ones — `ui_selected_text`
  // and `mcp_usage_stats` — read `ctx.principal` off it. It is optional so a body
  // that predates it keeps its two-argument signature.
  handle: (
    args: Record<string, unknown>,
    deps: McpReadToolDeps,
    ctx?: McpReadToolContext,
  ) => unknown | Promise<unknown>;
};

const timeSchema = z.object({ relative: z.string(), iso: z.string() });
const nullableTimeSchema = timeSchema.nullable();

const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  sessionCount: z.number(),
  lastActivity: nullableTimeSchema,
  isArchived: z.boolean(),
});

const sessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  provider: z.string(),
  projectId: z.string().nullable(),
  lifecycleMode: z.string(),
  hostState: z.string().nullable(),
  running: z.boolean(),
  awaitingUser: z.boolean(),
  lastActivity: nullableTimeSchema,
});

/**
 * The advertised shape of one pending interaction: the same fields
 * `approvals_list` reports for a request (minus `session`, which the tool
 * carrying this reading already names), as returned by
 * `mcp-approvals.js`'s `toPendingInteraction`.
 */
const pendingInteractionSchema = z.object({
  requestId: z.string(),
  toolName: z.string(),
  inputSummary: z.string(),
  interactive: z.boolean(),
  autoTimeoutMs: z.number().nullable(),
  waitedMs: z.number(),
  questions: z
    .array(
      z.object({
        question: z.string(),
        header: z.string().optional(),
        options: z.array(
          z.object({
            label: z.string(),
            description: z.string().optional(),
            multiSelect: z.boolean().optional(),
          }),
        ),
      }),
    )
    .optional(),
});

const hostSchema = z.object({
  hostId: z.string(),
  mode: z.string(),
  state: z.string(),
  pid: z.number().nullable(),
  startedAt: timeSchema,
  idleForMs: z.number(),
  peerName: z.string().nullable(),
  leases: z.array(z.unknown()),
});

const runSchema = z.object({
  sessionId: z.string(),
  provider: z.string(),
  startedAt: timeSchema,
  lastSeq: z.number(),
});

/**
 * The output shape of one session's detail reading — `session_get`'s four fields
 * and the base `ui_last_opened_session` extends with `openedAt`. One statement,
 * two tools: a field added here is advertised by both at once.
 */
const sessionDetailOutputSchema = {
  session: sessionSchema,
  pendingInteraction: pendingInteractionSchema.nullable(),
  host: hostSchema.nullable(),
  hostNote: z.string().nullable(),
  run: runSchema.nullable(),
} satisfies z.ZodRawShape;

/**
 * The refusal a registered-but-unwired tool answers with: `overview` /
 * `quay_snapshot` when the deps carry no quay runner (AC-247), and `run_get`
 * when the deps carry no run-get bag (AC-248). AC-247's real handlers live in
 * `mcp-overview-tools.js` and AC-248's in `mcp-run-get.js`; this fallback is
 * what an AC-240/244/245 mount — which wires neither — still reads, so those
 * criteria keep the exact tool behaviour they had.
 */
function notImplemented(name: McpStage3ReadToolName, owner: string): never {
  throw new McpToolError(
    MCP_TOOL_NOT_IMPLEMENTED_CODE,
    `${name} is registered by AC-245 but its behaviour is delivered by ${owner}.`,
    false,
    { tool: name, owner },
  );
}

/** The largest page `session_read` will take. A caller asking for more is refused. */
const MCP_SESSION_READ_MAX_LIMIT = 200;

/** How many SESSIONS one `session_search` page returns when the caller names no `limit`. */
export const MCP_SESSION_SEARCH_DEFAULT_LIMIT = 10;

/**
 * The largest `limit` `session_search` accepts, in SESSIONS. It lives here — with
 * the other two read-tool bounds — because the tool's declared input schema is
 * built in this module's body table, and a schema is read at module-evaluation
 * time. `mcp-session-search.js` imports it for its own defaulting; the direction
 * that would be unsafe (this module reading a constant out of its sibling) is the
 * one this placement avoids.
 */
export const MCP_SESSION_SEARCH_MAX_LIMIT = 50;

/**
 * The declared shape of a `project` argument that accepts ONE project reference or
 * SEVERAL (gap-mcp-cross-project-session-aggregation). The array form is what
 * makes "aggregate sessions across these projects" a first-class reading rather
 * than a per-project loop a caller has to drive. The target gate resolves every
 * element before the handler runs, so a name is accepted in either form; an
 * element that is ambiguous or names nothing refuses the whole call.
 *
 * The `describe` is the ONE place the project reference's RESOLUTION is stated to a
 * caller (AC-333): a name resolves most-specific-first — an exact id, then a
 * project's absolute path, then an exact title (case-sensitive before
 * case-insensitive), then a case-insensitive title substring — and a reference
 * that matches several entries or none is refused rather than guessed. A WRITE
 * tool additionally requires an exact target (id, path or exact title); a
 * fragment only discovers.
 */
const projectScopeSchema = z
  .union([z.string(), z.array(z.string())])
  .describe(
    'A project reference: an exact id, an absolute directory path, or a name. A name resolves ' +
      'most-specific-first (exact id, then full path, then an exact title, then a case-insensitive ' +
      'title substring); an ambiguous or unknown reference is refused, never guessed. Write tools ' +
      'accept only an exact id, path or title.',
  )
  .optional();

/**
 * `session_search`'s declared input: a raw shape, because every constraint here
 * is per-field (a required non-empty `query`, two closed enums, a bounded
 * `limit`), so no cross-field rule needs a `superRefine`. The bounds are
 * ADVERTISED on `tools/list` and ENFORCED by the audited wrapper, so an
 * out-of-range `limit` is one `INVALID_ARGUMENT` naming `limit` rather than a
 * silently clamped page. The one reserved field, `mode`, admits only `'fulltext'`
 * today — the scan is literal, never semantic.
 */
const sessionSearchInputSchema = {
  query: z.string().min(1).describe('Literal text to find in stored session transcripts and titles. Not semantic.'),
  project: projectScopeSchema.describe('Restrict to one project reference, or several to aggregate across.'),
  provider: z.enum(['claude', 'codex']).optional().describe('Restrict to one provider.'),
  speaker: z.enum(['user', 'assistant', 'any']).optional().describe('Restrict matches to one speaker.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MCP_SESSION_SEARCH_MAX_LIMIT)
    .optional()
    .describe(`How many sessions to return, 1..${MCP_SESSION_SEARCH_MAX_LIMIT}.`),
  cursor: z.string().optional().describe('Continuation token from a previous call. Not stable across calls.'),
  since: z
    .string()
    .optional()
    .describe('Inclusive lower bound on a session last activity (ISO 8601). Out-of-window sessions are never scanned.'),
  until: z
    .string()
    .optional()
    .describe('Inclusive upper bound on a session last activity (ISO 8601). See `since`.'),
  mode: z.enum(['fulltext']).optional().describe("Reserved; the only accepted value is 'fulltext'."),
};

/**
 * `session_search`'s declared output shape, so `tools/list` advertises exactly
 * what a hit carries — including the two nullable ids (`messageId` absent for a
 * provider that hands out no per-row id, `projectId` for a session no project
 * claims) and the optional `cursor`. `byProject` is the aggregation across the
 * FILTERED result set (gap-mcp-cross-project-session-aggregation): its counts
 * sum to `totalResults`, so a caller reading several projects at once sees the
 * per-project split without re-tallying the rows. `hasMore` / `nextCursor` are
 * the capped-scan names for the same two facts `moreAvailable` / `cursor` carry
 * (gap-mcp-session-search-time-pruning-and-stable-cursor), and `scannedThrough`
 * reports how far back the scan actually read.
 */
const sessionSearchOutputSchema = {
  query: z.string(),
  totalMatches: z.number(),
  totalResults: z.number(),
  moreAvailable: z.boolean(),
  hasMore: z.boolean(),
  scannedThrough: nullableTimeSchema,
  byProject: z.array(
    z.object({
      projectId: z.string().nullable(),
      projectDisplayName: z.string(),
      count: z.number(),
    }),
  ),
  results: z.array(
    z.object({
      sessionId: z.string(),
      provider: z.string(),
      projectId: z.string().nullable(),
      projectDisplayName: z.string(),
      sessionTitle: z.string(),
      lastActivity: nullableTimeSchema,
      score: z.number(),
      matches: z.array(
        z.object({
          messageId: z.string().nullable(),
          role: z.string(),
          timestamp: nullableTimeSchema,
          snippet: z.string(),
          highlights: z.array(z.object({ start: z.number(), end: z.number() })),
          turnIndex: z.number().nullable(),
        }),
      ),
    }),
  ),
  cursor: z.string().optional(),
  nextCursor: z.string().optional(),
};

/**
 * `session_read`'s declared input (AC-288): the shape of its arguments PLUS two
 * constraints a raw shape cannot state — `limit` is bounded to
 * `[1, MCP_SESSION_READ_MAX_LIMIT]`, and `aroundId` and `cursor` are mutually
 * exclusive (`aroundId` selects a window; `cursor` pages a whole transcript, so
 * naming both is a contradiction, not a refinement).
 *
 * One schema, two duties: it is handed to the SDK so `tools/list` advertises the
 * bounds and the exclusivity note, and it is parsed by the audited wrapper so a
 * violating call becomes one `INVALID_ARGUMENT` envelope with a per-field
 * `problem` rather than a silently clamped page.
 */
const sessionReadInputSchema = z
  .object({
    session: z.string(),
    mode: z.enum(['latest', 'outline', 'around']).optional(),
    limit: z.number().int().min(1).max(MCP_SESSION_READ_MAX_LIMIT).optional(),
    aroundId: z.string().optional(),
    before: z.number().optional(),
    after: z.number().optional(),
    cursor: z.string().optional(),
  })
  .superRefine((value, context) => {
    if (value.aroundId !== undefined && value.cursor !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['aroundId'],
        message: 'aroundId and cursor cannot be combined; name only one.',
      });
    }
  });

/**
 * The expanded-diff reading (gap-ui-visible-context-extended-fields): which Git
 * sub-view is active and which files/commits are EXPANDED. Ids only — never a
 * diff body, so `ui_visible_context` stays identifiers-and-ranges.
 */
const uiCurrentDiffSchema = z
  .object({ view: z.string(), files: z.array(z.string()), commits: z.array(z.string()) })
  .nullable();

/** The focused-task reading: the TaskMaster task whose detail modal is open, or null. */
const uiCurrentTaskSchema = z
  .object({ source: z.literal('taskmaster'), id: z.string(), title: z.string().nullable() })
  .nullable();

/** One tab's selection as `ui_selected_text` reports it: the reading, `'withheld'`, or none. */
const uiSelectedTextSchema = z.union([
  z.object({ text: z.string(), truncated: z.boolean(), region: z.literal('transcript') }),
  z.literal('withheld'),
  z.null(),
]);

const TOOL_BODIES = {
  overview: {
    // gap-mcp-cross-project-session-aggregation: `project` accepts one id or an
    // array, so a caller can read several projects' overview as one aggregate.
    // `quay_snapshot`'s `project` stays a single string — it refreshes exactly
    // one project.
    inputSchema: { project: projectScopeSchema },
    // The REAL reading shape (gap-mcp-outputschema-drift-overview-and-error-
    // envelope): AC-247 left a placeholder here, and a warm MCP client validated
    // the real payload against it and got `-32602`. It lives with the payload
    // type it describes (`mcp-overview-tools.js`) so the two cannot drift.
    outputSchema: overviewOutputSchema,
    handle: () => notImplemented('overview', 'AC-247'),
  },
  projects_list: {
    inputSchema: { includeArchived: z.boolean().optional() },
    outputSchema: { projects: z.array(projectSchema) },
    async handle(args, deps) {
      const includeArchived = args.includeArchived === true;
      const read = (options: { skipSynchronization?: boolean; includeHidden?: boolean }) =>
        deps.projects.getProjectsWithSessions(options);
      const active = await read({ skipSynchronization: true, includeHidden: true });
      const archived = includeArchived
        ? await deps.projects.getArchivedProjectsWithSessions({ skipSynchronization: true })
        : [];

      // Newest activity first, so the reading is ordered by the same fact the
      // recents list orders by rather than by the database's insertion order.
      const projects: McpProjectReading[] = [...active, ...archived]
        .map((project) => ({
          id: project.projectId,
          name: project.displayName,
          path: project.path,
          sessionCount: project.sessionMeta.total,
          lastActivity: readTimeField(project.sessions[0]?.lastActivity, deps.now),
          isArchived: project.isArchived === true,
        }))
        .sort((left, right) => (right.lastActivity?.iso ?? '').localeCompare(left.lastActivity?.iso ?? ''));

      return { projects };
    },
  },
  sessions_list: {
    inputSchema: {
      project: z.string().optional(),
      state: z.enum(['running', 'idle', 'resident', 'any']).optional(),
      // AC-337: narrow to the sessions whose live run carries this opaque label.
      // A FILTER, never a label for this call's own audit row — the write/read
      // split in the audit wrapper keys off this tool's `readOnlyHint` annotation,
      // so a read tool's argument of this name is stored nowhere on its own row.
      // Declared here (not clamped in the handler), so an over-long or illegal
      // value is an `INVALID_ARGUMENT` naming `correlationId`.
      correlationId: MCP_CORRELATION_ID_INPUT_FIELD.optional(),
      // Bounded HERE, not clamped by the handler: 0, a negative, a fraction or
      // a value past the cap is an `INVALID_ARGUMENT` naming `limit`, so a typo
      // is loud instead of silently answered with a page of the wrong size. The
      // SAME schema is advertised on `tools/list` (AC-288 (f)).
      limit: z.number().int().min(1).max(MCP_SESSION_LIST_MAX_LIMIT).optional(),
    },
    outputSchema: { sessions: z.array(sessionSchema), total: z.number() },
    async handle(args, deps) {
      const project = typeof args.project === 'string' && args.project.length > 0 ? args.project : null;
      const state = typeof args.state === 'string' ? (args.state as 'running' | 'idle' | 'resident' | 'any') : 'any';
      const correlationId = readCorrelationId(args.correlationId);
      const rows = project === null ? readRecentSessionRows(deps) : await readProjectSessionRows(deps, project);
      const liveRuns = deps.runs.listRunningRuns();
      const running = new Set(liveRuns.map((run) => run.sessionId));
      // The label filter is answered from the RUN REGISTRY's live reading — no
      // table and no join, so it sees exactly what a caller that just opened a
      // run stamped there. `null` (absent filter) matches every session, which
      // is why it is `null` and not an empty set: an empty set would filter
      // everything OUT. A session with no live run carries no label and so is
      // not a match.
      const labelled =
        correlationId === null
          ? null
          : new Set(liveRuns.filter((run) => run.correlationId === correlationId).map((run) => run.sessionId));

      const filtered = rows
        .map((row) => toSessionReading(row, deps, running))
        .filter((session) => {
          if (labelled !== null && !labelled.has(session.id)) return false;
          // An empty result is a legitimate answer, not a failure: "no session
          // of this project is running" is exactly what a caller asking for
          // `state: 'running'` wanted to hear.
          if (state === 'running') return session.running;
          if (state === 'resident') return isResident(session);
          if (state === 'idle') return !session.running && !isResident(session);
          return true;
        });

      // Filter FIRST, then cut the page: `limit` bounds the returned list, while
      // `total` reports the filtered count BEFORE the cut, which is how a caller
      // learns the answer was truncated rather than complete. An absent `limit`
      // falls back to the filtered length — the whole page, so the no-limit
      // reading is byte-for-byte what it was before `limit` was declared.
      const limit = optionalPositiveInteger(args.limit, filtered.length);
      return { sessions: filtered.slice(0, limit), total: filtered.length };
    },
  },
  session_get: {
    inputSchema: { session: z.string() },
    outputSchema: { ...sessionDetailOutputSchema },
    handle: (args, deps) => buildSessionDetail(deps, requireStringArgument(args, 'session')),
  },
  ui_last_opened_session: {
    inputSchema: {},
    // `session_get`'s reading plus `openedAt` — the same four fields, then when
    // the browser opened it.
    outputSchema: { ...sessionDetailOutputSchema, openedAt: timeSchema },
    // The real handler lives in `mcp-ui-tools.js` and is installed by
    // `registerMcpReadTools` when the deps carry the pointer reader. A mount
    // without it reads this named refusal, exactly like the overview/run_get
    // placeholders before their tasks landed.
    handle: () => notImplemented('ui_last_opened_session', 'gap-mcp-ui-last-opened-session'),
  },
  ui_visible_context: {
    // `navigationId` narrows the `navigations[]` reading to one record
    // (gap-mcp-ui-open-session); `client` narrows which browsers are asked.
    inputSchema: { client: z.string().optional(), navigationId: z.string().optional() },
    // The reading, one entry per addressed device. Every field is nullable
    // because a tab that did not answer reports none of them — the shape has to
    // admit "asked, asleep" as readily as it admits a full reading.
    outputSchema: {
      devices: z.array(
        z.object({
          deviceId: z.string(),
          deviceName: z.string(),
          lastFocusedAt: z.number().nullable(),
          tabs: z.array(
            z.object({
              tabId: z.string(),
              deviceName: z.string(),
              unresponsive: z.boolean(),
              navigationPolicy: z.string().nullable(),
              visibility: z.enum(['visible', 'hidden']).nullable(),
              hasFocus: z.boolean().nullable(),
              lastFocusedAt: z.number().nullable(),
              panel: z.string().nullable(),
              selectedProject: z.string().nullable(),
              selectedSession: z.string().nullable(),
              visibleMessages: z
                .object({ first: z.string().nullable(), last: z.string().nullable() })
                .nullable(),
              pendingApprovals: z.number().nullable(),
              queuedMessages: z.number().nullable(),
              currentDiff: uiCurrentDiffSchema,
              currentTask: uiCurrentTaskSchema,
            }),
          ),
        }),
      ),
      // The `ui_open_session` navigation log (gap-mcp-ui-open-session), newest
      // first: what was asked for, in which browser, and the last status known
      // (`pending_user` while an ask-policy prompt is up, then the final verdict
      // a later `ui.navigate_result` reports). Empty when nothing was asked or no
      // navigation service is wired — never omitted.
      navigations: z.array(
        z.object({
          navigationId: z.string(),
          deviceId: z.string(),
          deviceName: z.string(),
          tabId: z.string().nullable(),
          sessionId: z.string(),
          at: z.union([
            z.object({ latest: z.literal(true) }),
            z.object({ messageId: z.string() }),
            // gap-mcp-ui-focus-turn-show-diff-open-task widened the target: a
            // turn inside the session, a file's diff, or a task's detail.
            z.object({ turnId: z.string() }),
            z.object({ diffFile: z.string() }),
            z.object({ taskId: z.string() }),
          ]),
          requestedBy: z.string().nullable(),
          requestedAt: z.number(),
          updatedAt: z.number(),
          status: z.enum(['applied', 'declined', 'pending_user', 'ignored', 'superseded', 'expired']),
        }),
      ),
    },
    // The real handler lives in `mcp-ui-visible-context.js` and is installed by
    // `registerMcpReadTools` when the deps carry the round trip. A mount without
    // it reads this named refusal, exactly like the overview/run_get placeholders
    // before their tasks landed.
    handle: () => notImplemented('ui_visible_context', 'gap-mcp-ui-visible-context'),
  },
  ui_clients_list: {
    inputSchema: {},
    // The listing: one entry per connected device, identity and status only. The
    // status fields are nullable because a device none of whose tabs answered
    // reports none of them — the shape admits "asked, asleep" as readily as a
    // full reading.
    outputSchema: {
      devices: z.array(
        z.object({
          deviceId: z.string(),
          deviceName: z.string(),
          lastFocusedAt: z.number().nullable(),
          visibility: z.enum(['visible', 'hidden']).nullable(),
          hasFocus: z.boolean().nullable(),
          navigationPolicy: z.string().nullable(),
          unresponsive: z.boolean(),
          tabs: z.array(z.object({ tabId: z.string(), connectedAt: z.number() })),
        }),
      ),
    },
    // The real handler lives in `mcp-ui-clients-list.js` and is installed by
    // `registerMcpReadTools` when the deps carry the round trip. A mount without
    // it reads this named refusal, exactly like the overview/run_get placeholders
    // before their tasks landed.
    handle: () => notImplemented('ui_clients_list', 'gap-mcp-ui-clients-list'),
  },
  ui_selected_text: {
    // The same optional device reference `ui_visible_context` takes.
    inputSchema: { client: z.string().optional() },
    // Per addressed device and tab, the selection reading: the object, the
    // `'withheld'` marker (a selection exists but the token lacks
    // `cloudcli:selection`), or null (nothing selected). The one content-bearing
    // read tool, so its shape carries text where `ui_visible_context` does not.
    outputSchema: {
      devices: z.array(
        z.object({
          deviceId: z.string(),
          deviceName: z.string(),
          lastFocusedAt: z.number().nullable(),
          tabs: z.array(
            z.object({
              tabId: z.string(),
              deviceName: z.string(),
              unresponsive: z.boolean(),
              selectedText: uiSelectedTextSchema,
            }),
          ),
        }),
      ),
    },
    // The real handler lives in `mcp-ui-visible-context.js` and is installed by
    // `registerMcpReadTools` when the deps carry the round trip. A mount without
    // it reads this named refusal, exactly like the overview/run_get placeholders
    // before their tasks landed.
    handle: () => notImplemented('ui_selected_text', 'gap-ui-visible-context-extended-fields'),
  },
  session_search: {
    inputSchema: sessionSearchInputSchema,
    outputSchema: sessionSearchOutputSchema,
    // The real handler lives in `mcp-session-search.js` and is installed by
    // `registerMcpReadTools` when the deps carry the search engine. A mount
    // without it reads this named refusal, exactly like the overview/run_get
    // placeholders before their tasks landed — and `{ query: 'anything' }` is
    // the shallowest call that reaches it, since `query` is declared required.
    handle: () => notImplemented('session_search', 'gap-mcp-session-search'),
  },
  session_read: {
    inputSchema: sessionReadInputSchema,
    outputSchema: {
      session: z.string(),
      mode: z.string(),
      content: z.string(),
      cursor: z.string().optional(),
    },
    async handle(args, deps) {
      const sessionId = requireStringArgument(args, 'session');
      const mode = typeof args.mode === 'string' ? (args.mode as 'latest' | 'outline' | 'around') : 'latest';
      let text: string;

      if (mode === 'outline') {
        const outline = await deps.sessions.fetchOutline(sessionId);
        text = outline.turns
          .map((turn) => `[${turn.timestamp}] #${turn.index} ${turn.id}: ${inline(turn.preview)}`)
          .join('\n');
      } else if (mode === 'around') {
        const window = await deps.sessions.fetchWindowAround(sessionId, {
          aroundId: requireStringArgument(args, 'aroundId'),
          before: optionalPositiveInteger(args.before, 0),
          after: optionalPositiveInteger(args.after, 0),
        });
        text = window.messages.map(renderMessageLine).join('\n');
      } else {
        const history = await deps.sessions.fetchHistory(sessionId, {
          limit: optionalPositiveInteger(args.limit, DEFAULT_LATEST_LIMIT),
          offset: 0,
        });
        text = history.messages.map(renderMessageLine).join('\n');
      }

      const cursor = typeof args.cursor === 'string' && args.cursor.length > 0 ? args.cursor : undefined;
      const page = paginateMcpText(text, cursor);
      return {
        session: sessionId,
        mode,
        content: page.content,
        ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
      };
    },
  },
  run_get: {
    // AC-386: `{ runId } | { deliveryId } | { session }`, with the two ids
    // mutually exclusive (they address disjoint uuid spaces).
    //
    // ⛔ Deliberately a RAW SHAPE, not AC-288's built schema (`session_read`'s
    // shape), although a raw shape cannot state the xor. `run_get` is one of the
    // six tools MIRRORED by `server/modules/voice-realtime/voice-realtime-tools.ts`,
    // and that mirror's AC-2 invariant (`tests/voice-realtime-bridge.test.ts`)
    // compares this declaration to the mirror field for field as a `z.ZodRawShape`
    // — its `zodSignature` walker reads `.def.type` off each FIELD. A built schema
    // is one schema OBJECT, so the walker descends into its instance properties
    // and dies on `undefined.def`, reddening a criterion this task does not own.
    // The constraint therefore lives in the handler (`readRunGetInput`), which is
    // the seam AC-386's criterion drives: naming both ids is one `INVALID_ARGUMENT`
    // from there, not a wire-schema rejection.
    //
    // `run` and `wait` stay accepted-but-ignored: AC-245's placeholder declared
    // them, and its criterion still calls `run_get` with those keys to read the
    // named `MCP_TOOL_NOT_IMPLEMENTED` refusal.
    inputSchema: {
      runId: z.string().optional(),
      deliveryId: z.string().optional(),
      waitSeconds: z.number().optional(),
      session: z.string().optional(),
      run: z.string().optional(),
      wait: z.boolean().optional(),
    },
    outputSchema: { run: z.unknown().optional() },
    handle: () => notImplemented('run_get', 'AC-248'),
  },
  quay_snapshot: {
    inputSchema: { project: z.string().optional(), refresh: z.boolean().optional() },
    outputSchema: { snapshot: z.unknown().optional() },
    handle: () => notImplemented('quay_snapshot', 'AC-247'),
  },
  mcp_usage_stats: {
    inputSchema: MCP_USAGE_STATS_INPUT_SCHEMA,
    outputSchema: MCP_USAGE_STATS_OUTPUT_SCHEMA,
    // The one tool whose body reaches the caller's identity: the aggregation is
    // scoped to the token OWNER's rows, so it reads `ctx.principal`. The wrapper
    // denies a null principal first, so `principal` is non-null in production;
    // `runMcpUsageStats` still guards the null case as a typed envelope.
    handle: (args, _deps, ctx) => runMcpUsageStats(args, ctx?.principal ?? null),
  },
  changes: {
    // Read through ACCESSORS, unlike the plain reads above: the shapes live with
    // the payload they describe (`mcp-changes.js`), and unlike the other sibling
    // modules this one is not a runtime leaf — it imports `formatMcpTime` from
    // HERE. The edge back would therefore form a genuine cycle, and a direct
    // value read while this module evaluates would leave `mcp-changes.js`
    // half-initialized (a TDZ) for any entry point that loads it first. An
    // accessor moves the read to the moment a tool is REGISTERED, by which time
    // every module has evaluated; the cycle then carries only hoisted functions
    // in both directions, which is safe in either order.
    get inputSchema(): McpToolInputSchema {
      return MCP_CHANGES_INPUT_SCHEMA;
    },
    get outputSchema(): z.ZodRawShape {
      return MCP_CHANGES_OUTPUT_SCHEMA;
    },
    // The real handler is installed by `registerMcpChangesTool` when the deps
    // carry a `changes` bag; this is the refusal an unwired mount (AC-240/244/245's
    // criteria, and the read-tools criterion's own mount) reads instead.
    handle: () => notImplemented('changes', 'AC-335'),
  },
} satisfies Record<McpStage3ReadToolName, McpReadToolBody>;

// --------------------------- registration ---------------------------

/** The caller identity a read handler may be handed: the transport's principal, or null. */
export type McpReadToolContext = { principal: McpPrincipal | null };

/** One read tool as it is handed to the registration seam. */
export type McpReadToolRegistration = {
  name: string;
  description: string;
  requiredScope: string;
  /** AC-288: a raw shape, or a built schema carrying a constraint a raw shape cannot express. */
  inputSchema: McpToolInputSchema;
  outputSchema: z.ZodRawShape;
  /**
   * The behaviour. `ctx` carries the caller's principal when the transport
   * supplies one; a tool that does not gate on caller identity simply ignores it.
   * The read seam historically handed a handler only `args`
   * (`(args) => unknown`), which is why `ctx` is optional: it was widened to
   * thread `{ principal }` for the one content-bearing read tool
   * (`ui_selected_text`), whose handler must read the caller's scopes.
   */
  handler: (args: Record<string, unknown>, ctx?: McpReadToolContext) => unknown | Promise<unknown>;
};

/**
 * The seam `registerMcpReadTools` installs through.
 *
 * The transport supplies one backed by AC-244's `withMcpAudit` — so every read
 * tool inherits the single audit row and the scope refusal without restating
 * either. The criterion supplies a recording seam instead, which is how it
 * reads back the names, descriptions and required scopes a registration
 * actually declared.
 */
export type McpReadToolSeam = (registration: McpReadToolRegistration) => void;

/**
 * Registers every stage-3 read tool exactly once.
 *
 * The scope comes from {@link MCP_STAGE3_READ_TOOLS} — the table is the one
 * place the pair (name, scope) is written down, and the body table is keyed by
 * the same names under a `satisfies`, so a tool added to one and not the other
 * is a type error rather than a silently missing registration.
 *
 * `overview` and `quay_snapshot` are AC-247's. When the injected deps are wired
 * with the quay runner and the activity store, those two names are registered by
 * {@link registerMcpOverviewTools} — the real handlers, with their metadata
 * passed down from this same table so the tool set stays one statement. When the
 * deps are NOT wired (AC-240/244/245's mounts), the two keep their body-table
 * refusal, so those criteria read exactly what they read before this task.
 * Either way the registered NAME SET is unchanged — this replaces handlers, it
 * does not add or rename a tool.
 *
 * `run_get` is AC-248's and follows the same routing: when `deps.runGet` is
 * supplied it is registered by `mcp-run-get.js`'s real handler, otherwise it
 * keeps the body-table refusal. `ui_last_opened_session` follows it too: when
 * `deps.uiLastOpened` is supplied it is registered by `mcp-ui-tools.js`, and
 * otherwise it keeps the body-table refusal. `ui_visible_context` follows the
 * same routing through `mcp-ui-visible-context.js` and `deps.uiVisibleContext`,
 * and `ui_clients_list` through `mcp-ui-clients-list.js` and
 * `deps.uiClientsList`. `session_search` (gap-mcp-session-search) follows the
 * same routing through `mcp-session-search.js` and `deps.sessionSearch`. The
 * registered NAME SET is the table either way.
 *
 * `changes` (gap-mcp-changes-on-demand-event-stream) follows the same routing
 * through `mcp-changes.js` and `deps.changes`.
 */
export function registerMcpReadTools(seam: McpReadToolSeam, deps: McpReadToolDeps): void {
  const overviewDeps: McpOverviewDeps | null = isOverviewWired(deps) ? deps : null;
  const runGetDeps: McpRunGetDeps | null = isRunGetWired(deps) ? deps.runGet : null;
  const uiDeps: McpUiLastOpenedDeps | null = isUiLastOpenedWired(deps) ? deps : null;
  const visibleContextDeps: McpUiVisibleContextDeps | null = isUiVisibleContextWired(deps)
    ? deps.uiVisibleContext
    : null;
  const clientsListDeps: McpUiClientsListDeps | null = isUiClientsListWired(deps) ? deps.uiClientsList : null;
  // The session-search deps: the engine verb the caller injected, plus the
  // outline reader derived from the SAME `sessions.fetchOutline` the
  // `session_read` outline mode prints — so a hit's `turnIndex` and that outline
  // agree by construction rather than by a second numbering. An injected
  // `outlineFor` (a criterion's own seam) wins; absent it, the derivation is used.
  const sessionSearchDeps: McpSessionSearchDeps | null = isSessionSearchWired(deps)
    ? {
        ...deps.sessionSearch,
        outlineFor:
          deps.sessionSearch.outlineFor ??
          (async (sessionId: string) => (await deps.sessions.fetchOutline(sessionId)).turns),
      }
    : null;
  const draftDeps: McpDraftDeps | null = deps.draft ?? null;
  const changesDeps: McpChangesDeps | null = isChangesWired(deps) ? deps.changes : null;
  const table = new Map<string, (typeof MCP_STAGE3_READ_TOOLS)[number]>(
    MCP_STAGE3_READ_TOOLS.map((tool) => [tool.name, tool]),
  );

  /** A tool's metadata, read from the one table so a name cannot drift from its scope. */
  const registration = (name: McpStage3ReadToolName): McpOverviewRegistration => {
    const tool = table.get(name);
    const body = TOOL_BODIES[name];
    if (tool === undefined) {
      throw new Error(`the stage-3 read table is missing "${name}"`);
    }
    return {
      name: tool.name,
      description: tool.description,
      requiredScope: tool.requiredScope,
      inputSchema: body.inputSchema,
      outputSchema: body.outputSchema,
    };
  };

  for (const tool of MCP_STAGE3_READ_TOOLS) {
    if (overviewDeps !== null && (tool.name === 'overview' || tool.name === 'quay_snapshot')) {
      continue;
    }
    if (runGetDeps !== null && tool.name === 'run_get') {
      continue;
    }
    if (uiDeps !== null && tool.name === 'ui_last_opened_session') {
      continue;
    }
    if (visibleContextDeps !== null && tool.name === 'ui_visible_context') {
      continue;
    }
    if (visibleContextDeps !== null && tool.name === 'ui_selected_text') {
      continue;
    }
    if (clientsListDeps !== null && tool.name === 'ui_clients_list') {
      continue;
    }
    if (sessionSearchDeps !== null && tool.name === 'session_search') {
      continue;
    }
    if (changesDeps !== null && tool.name === 'changes') {
      continue;
    }
    const body = TOOL_BODIES[tool.name];
    seam({
      name: tool.name,
      description: tool.description,
      requiredScope: tool.requiredScope,
      inputSchema: body.inputSchema,
      outputSchema: body.outputSchema,
      // `ctx` is threaded through so a caller-scoped body (mcp_usage_stats) can
      // read the principal; a body that ignores it is unaffected.
      handler: (args, ctx) => body.handle(args, deps, ctx),
    });
  }

  if (overviewDeps !== null) {
    registerMcpOverviewTools(seam, overviewDeps, {
      overview: registration('overview'),
      quaySnapshot: registration('quay_snapshot'),
    });
  }

  if (runGetDeps !== null) {
    const runGet: McpRunGetRegistration = registration('run_get');
    registerMcpRunGetTool(seam, runGetDeps, runGet);
  }

  if (uiDeps !== null) {
    registerMcpUiTools(seam, uiDeps, registration('ui_last_opened_session'));
  }

  if (visibleContextDeps !== null) {
    registerMcpUiVisibleContextTool(seam, visibleContextDeps, registration('ui_visible_context'));
    // The content-bearing companion: same round trip and device address, its own
    // name and its own scope gate. Registered together so a mount that can ask
    // the browsers exposes both readings.
    registerMcpUiSelectedTextTool(seam, visibleContextDeps, registration('ui_selected_text'));
  }

  if (clientsListDeps !== null) {
    registerMcpUiClientsListTool(seam, clientsListDeps, registration('ui_clients_list'));
  }

  if (sessionSearchDeps !== null) {
    const sessionSearch: McpSessionSearchRegistration = registration('session_search');
    registerMcpSessionSearchTool(seam, sessionSearchDeps, sessionSearch);
  }

  if (changesDeps !== null) {
    registerMcpChangesTool(seam, changesDeps, registration('changes'));
  }

  // gap-mcp-draft-get-set-submit: a read tool registered ALONGSIDE the stage-3
  // table rather than in it. `draft_get` reads the caller's own unsent composer
  // text; its write halves (`draft_set` / `draft_submit`) live with the write
  // tools, because a single tool cannot carry a read scope for one verb and a
  // send scope for the others (the seam takes one scope per registration). The
  // table's own size pin is untouched, which is why the name is NOT added to
  // `MCP_STAGE3_READ_TOOLS`.
  if (draftDeps !== null) {
    registerMcpDraftGetTool(seam, draftDeps, {
      name: DRAFT_GET_TOOL_NAME,
      description: DRAFT_GET_DESCRIPTION,
      requiredScope: READ_SCOPE,
      inputSchema: DRAFT_GET_INPUT_SCHEMA,
      outputSchema: DRAFT_GET_OUTPUT_SCHEMA,
    });
  }
}
