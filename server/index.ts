#!/usr/bin/env node
// Load environment variables before other imports execute.
import './load-env.js';
import fs, { promises as fsPromises } from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { randomUUID } from 'crypto';

import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { WebSocket as WebSocketClient, type WebSocket } from 'ws';

import { AppError, findApplicationRoot, getModuleDirectory, IS_PLATFORM, terminalTextStyles } from '@/shared/utils.js';
import type { AuthenticatedWebSocketRequest, HostMode, LLMProvider, ProviderRuntimeWriter } from '@/shared/types.js';
import {
    closeSessionsWatcher,
    initializeSessionsWatcher,
    providerCapabilitiesService,
    providerModelsService,
    providerRegistry,
    providerRuntimeService,
    readClaudeSessionOccupancy,
    resolveResidentScopeSweepEnabled,
    sessionConversationsSearchService,
    sessionsService,
    setActivityChangeNotifier,
    stopClaudeSessionScopes,
    sweepOrphanClaudeSessionScopes,
    uiLastOpenedSessionService,
} from '@/modules/providers/index.js';
import { activityStore, BOOT_ID, broadcastHostsChanged, chatRunRegistry, createActivityRouter, createChatControlService, createUiNavigationService, createWebSocketServer, listUiClients, uiClientRegistry, uiStateRequestService } from '@/modules/websocket/index.js';
import { createSessionHostsRouter, sessionHostManager } from '@/modules/session-hosts/index.js';

import { getConnectableHost } from '../shared/networkHosts.js';
import { OAUTH_CONSENT_SPA_PATH } from '../shared/oauthConsent.js';

import { createGitModule } from './modules/git/index.js';
import {
    authenticateToken,
    authenticateWebSocket,
    authRoutes,
    createAuthRequestLogger,
    credentialVerifier,
    validateApiKey,
} from './modules/auth/index.js';
import { taskmasterRoutes } from './modules/taskmaster/index.js';
import { quayRoutes, quayService } from './modules/quay/index.js';
import { commandsRoutes } from './modules/commands/index.js';
import { settingsRoutes } from './modules/settings/index.js';
import {
    createAccessTokensService,
    createOAuthClientsRouter,
    createOAuthConsentDocumentHeadersMiddleware,
    createOAuthRequestLogger,
    createOAuthProvider,
    createOAuthSettingsRouter,
    createOAuthSettingsService,
    createOAuthStore,
    createTokenInfoRouter,
    mountOAuthRegister,
    mountOAuthServer,
    readMcpAllowedRedirectHosts,
} from './modules/oauth/index.js';
import { createSystemModule, readBuildInfo } from './modules/system/index.js';
import projectModuleRoutes from './modules/projects/projects.routes.js';
import notificationRoutes from './modules/notifications/notifications.routes.js';
import { userRoutes } from './modules/user/index.js';
import {
    getPluginPort,
    pluginsRoutes,
    startEnabledPluginServers,
    stopAllPlugins,
} from './modules/plugins/index.js';
import providerRoutes from './modules/providers/provider.routes.js';
import { voiceClientAssetRoutes, voiceRoutes } from './modules/voice/index.js';
import {
    closeScheduledMessageDispatcher,
    initializeScheduledMessageDispatcher,
    scheduledMessagesRoutes,
} from './modules/scheduled-messages/index.js';
import browserUseRoutes from './modules/browser-use/browser-use.routes.js';
import { assetsRoutes } from './modules/assets/index.js';
import { fileTreeRoutes } from './modules/file-tree/index.js';
import { worktreesRoutes } from './modules/worktrees/index.js';
import browserUseMcpRoutes from './modules/browser-use/browser-use-mcp.routes.js';
import { apiNoStoreMiddleware, createStaticAssetsMiddleware } from './modules/static-assets/index.js';
import {
    DEBUG_AGENT_CONTROL_PLANE_PATH,
    DEBUG_AGENT_PROVIDER_ID,
    getDebugAgentGateReason,
    mountDebugAgentControlPlane,
    registerDebugAgentControlPlaneRoutes,
    setDebugAgentOpenRun,
} from './modules/debug-agent/index.js';
import {
    MCP_GATEWAY_PATH,
    buildRunGet,
    buildSessionCreateDeps,
    buildSessionInterruptDeps,
    createMcpGatewayModule,
    createMcpWriteNotification,
    createUiOpenSessionRateLimiter,
    createSessionHostControl,
    mountMcpGateway,
    mountOAuthMetadata,
    readMcpDcrMode,
    readOAuthMetadataGate,
    resolveClientName,
    startMcpAuditRetention,
} from './modules/mcp-gateway/index.js';
import type {
    McpApprovalsDeps,
    McpOauthSeam,
    McpReadToolDeps,
    McpRunGetDeps,
    McpSessionBackgroundDeps,
    McpSessionSendDeps,
    McpUiVisibleContextDeps,
    UiNavigationToolDeps,
} from './modules/mcp-gateway/index.js';
// The MCP read tools' project readers. The gateway fills these itself from the
// same barrel when it is handed a partial bag; index.ts states them because the
// voice executor (AC-312) needs the full `McpReadToolDeps` — see `mcpReadToolDeps`.
import {
    getArchivedProjectsWithSessions,
    getProjectSessionsPage,
    getProjectsWithSessions,
} from './modules/projects/index.js';
// Includes the relay's on-disk journal (its own store, its own directory): resolved and built once,
// here, at the composition root — the pure resolvers take the environment readings as arguments, so
// this file is the only place `VOICE_REALTIME_LOG_DIR` / `VOICE_REALTIME_LOG_MAX_BYTES` are read.
import { DEFAULT_DASHSCOPE_REALTIME_VOICE, DEFAULT_SESSION_DEFAULTS, VOICE_REALTIME_CAPTURE_DIR_ENV, VOICE_REALTIME_CAPTURE_ENV, VOICE_REALTIME_CAPTURE_MAX_BYTES_ENV, VOICE_REALTIME_IDLE_ROTATE_MS_ENV, VOICE_REALTIME_LOG_DIR_ENV, VOICE_REALTIME_LOG_MAX_BYTES_ENV, VOICE_REALTIME_TRANSPORT_PARAM, applyVoiceRealtimeTransport, clearVoiceRealtimeCaptureDir, composeHostRunActivityReading, createDashscopeTransport, createUplinkVadArmPoint, createVoiceRealtimeCaptureRecorder, createVoiceRealtimeCaptureStore, createVoiceRealtimeLiveExecutor, createVoiceRealtimeLogStore, createVoiceRealtimeRecorder, createVoiceRealtimeRouter, handleVoiceRealtimeConnection, parseVoiceRealtimeTransport, runVoiceRealtimeDiagnosis, describeTurnDetection, describeUplinkVad, describeVoiceRealtimeMode, resolveTurnDetection, resolveSpendWindowLimit, describeSpendWindowLimit, resolveSilenceTail, describeSilenceTail, resolveUplinkVad, resolveVoiceRealtimeCaptureDir, resolveVoiceRealtimeCaptureMaxBytes, resolveVoiceRealtimeCaptureMode, resolveVoiceRealtimeLogDir, resolveVoiceRealtimeLogMaxBytes, resolveVoiceRealtimeMode, voiceRealtimeCaptureStartupLine, voiceRealtimeLogDirStartupLine, VOICE_REALTIME_CALLER_SCOPES, VOICE_REALTIME_INSTRUCTIONS, type DashscopeSocket, type DashscopeWireObserver, type TurnDetectionOverride, type VoiceRealtimeAudioCapture, type VoiceRealtimeProxySeams } from './modules/voice-realtime/index.js';
import type { OAuthProvider } from './modules/oauth/index.js';
import { browserUseService } from './modules/browser-use/browser-use.service.js';
import { initializeDatabase, oauthClientsDb, oauthGrantsDb, projectsDb, sessionDraftsDb, sessionsDb } from './modules/database/index.js';
import { configureWebPush } from './modules/notifications/index.js';

const __dirname = getModuleDirectory(import.meta.url);
// The server source runs from /server, while the compiled output runs from /dist-server/server.
// Resolving the app root once keeps every repo-level lookup below aligned across both layouts.
const APP_ROOT = findApplicationRoot(__dirname);
const installMode = fs.existsSync(path.join(APP_ROOT, '.git')) ? 'git' : 'npm';
// Version of the code that is actually running, captured once at process
// startup. This intentionally does NOT re-read package.json per request: after
// an update replaces the files on disk, package.json reflects the NEW version
// while this long-lived process still runs the OLD code. The frontend bundle is
// rebuilt on update, so a mismatch between this value and the frontend's
// build-time version means the server was updated but not restarted.
const RUNNING_VERSION = (() => {
    try {
        return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version || null;
    } catch {
        return null;
    }
})();
// Which commit this process was built from, read once at startup for the same reason
// RUNNING_VERSION is: a deployment replaces dist-server on disk while this process keeps running
// the OLD code, so re-reading per request would report the NEW build's identity for a process
// still executing the old one. null means the instance was not built here (a tsx dev server) or
// was built before scripts/write-build-info.mjs existed. See scripts/check-deploy-freshness.mjs.
const BUILD_INFO = readBuildInfo(APP_ROOT);
const systemRoutes = createSystemModule({
    appRoot: APP_ROOT,
    installMode,
    isPlatform: IS_PLATFORM,
});
console.log('SERVER_PORT from env:', process.env.SERVER_PORT);

const app = express();
const server = http.createServer(app);
const queryClaude = providerRuntimeService.getRunner('claude');
const queryCursor = providerRuntimeService.getRunner('cursor');
const gitRoutes = createGitModule({
    queryClaude,
    queryCursor,
});

// The single chat control service every front end shares. Built here — the one
// composition root — before the WebSocket server exists, so the *same* instance
// is handed to the gateway's chat verbs and to the scheduled-message timer.
// Neither consumer constructs one of its own; a second instance would give each
// a separate control plane behind one protocol.
const chatControl = createChatControlService({
    runtime: providerRuntimeService,
    // With no session named, `approvals_list` / `answerApproval` must scan the
    // SAME sessions `overview`'s `awaitingPermission` list can report, or one
    // tool would call a workspace idle while the other names a parked session.
    // `overview` reads the activity store's held sessions, which includes a
    // parked RESIDENT session the run registry never enrolled — so the union,
    // not `listRunningRuns()` alone, is the aligned candidate set.
    listApprovalSessionIds: () => [
        ...new Set([
            ...chatRunRegistry.listRunningRuns().map((run) => run.sessionId),
            ...activityStore.sessionIds(),
        ]),
    ],
});

// gap-mcp-ui-open-session: the ONE navigation service for this process, built
// HERE rather than taken from the websocket module's default instance — because
// its `recordApplied` seam is the last-opened writer and that writer lives in
// this composition root. The pointer moves only when a BROWSER reports it
// APPLIED the navigation (the user pressed 跳转, or the device's policy
// auto-navigates); a declined, ignored or unanswered navigation never records
// one. The same instance is handed to the WebSocket gateway (which routes the
// `ui.navigate_ack` / `ui.navigate_result` frames into it), to the MCP
// `ui_open_session` tool (which writes through it) and to `ui_visible_context`
// (which reads its log back), so one instruction and its later verdict are
// looked up in the same table.
const uiNavigations = createUiNavigationService({
    listTargets: (deviceId) => uiClientRegistry.listUiClientTargets(deviceId),
    recordApplied: (sessionId, at) => uiLastOpenedSessionService.recordOpenedSession(sessionId, at),
});

// gap-mcp-ui-open-session: the per-token throttle for `ui_open_session`. Built
// ONCE here because the MCP server is constructed per request — a limiter owned
// by that construction would start empty on every call and throttle nothing.
const uiOpenSessionRateLimiter = createUiOpenSessionRateLimiter();

// gap-mcp-ui-open-session / gap-mcp-ui-focus-turn-show-diff-open-task: the deps
// bag every `ui_*` navigation tool answers from. ONE object, spread into all four
// tools below, so `ui_open_session`, `ui_focus_turn`, `ui_show_diff` and
// `ui_open_task` cannot drift into different device rosters, throttles or
// requester names. `listUiClients` is the same roster `ui_clients_list` publishes;
// `uiNavigations.navigate` is the same table the ack/result frames are routed
// into; `resolveClientName` is the gateway's ONE principal-name resolution (the
// one the write notifications name their caller with), so the confirmation bar
// tells the user WHO asked instead of blanking on a personal access token.
const uiNavigationToolDeps: UiNavigationToolDeps = {
    listUiClients,
    navigate: (request) => uiNavigations.navigate(request),
    rateLimiter: uiOpenSessionRateLimiter,
    resolveClientName,
};

// The services `run_get` (AC-248) and the bounded-wait half of `session_send`
// (AC-249) answer from: the process run registry, the activity store, the
// providers' sessions history reader, and the wall clock plus a real sleeper.
// Bound to one object because both tools read the identical services, and a
// second copy would be two things to keep in step.
//
// It carries the run registry explicitly because the VOICE control plane
// (AC-312) reaches this object through `createVoiceRealtimeLiveExecutor`, which
// takes the FULL deps — not `createMcpGatewayModule`'s input, which fills
// `runs` from the websocket barrel. The gateway is handed the same object and
// overlays the identical `chatRunRegistry`, so both callers read one registry.
//
// Defined HERE, above the WebSocket server rather than beside the gateway mount
// below, because the voice handler is constructed before the gateway mount. One
// object, two callers.
const mcpRunGetDeps: McpRunGetDeps = {
    runs: chatRunRegistry,
    activity: activityStore,
    sessions: sessionsService,
    now: () => Date.now(),
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    bootId: () => BOOT_ID,
};

// The MCP deps bags the VOICE control plane (GOAL-031 / AC-312) and the MCP
// gateway both need. They live here, above the WebSocket server, because the
// `/voice-realtime` handler below is constructed before the gateway mount, and
// because the whole point of AC-312 is that voice reaches the SAME services a
// direct MCP call does: one control plane, one registry, one approval table.
// Each bag is a named const rather than an inline literal so the two call sites
// cannot drift into two rosters of the same process-wide services.

// gap-mcp-ui-visible-context / gap-mcp-ui-open-session: the connected browsers,
// the round trip that asks them what they are showing, and the navigation table
// the ack/result frames are routed into.
const mcpUiVisibleContextDeps: McpUiVisibleContextDeps = {
    listUiClients,
    requestUiState: (options) => uiStateRequestService.requestUiState(options),
    listNavigations: (navigationId) => uiNavigations.listNavigations(navigationId),
};

// The read tools' deps (AC-248 and siblings): every reader `registerMcpReadTools`
// installs is rebuilt from these. The voice executor exposes the same six tools
// to the model, so it is handed the same bag rather than a second one — which is
// why `projects` and `runs` are stated here rather than left to
// `createMcpGatewayModule`'s fill: the executor takes the full deps, and the
// gateway overlays these two with the identical values.
const mcpReadToolDeps: McpReadToolDeps = {
    // gap-mcp-session-get-past-recents-page-and-small-envelope-defects: the
    // gateway projects a session read by id through `toSessionRow`; it needs the
    // project id for that one field, and it takes it from the SAME lookup
    // `sessionsService.listRecentSessions` uses.
    projects: {
        getProjectsWithSessions,
        getArchivedProjectsWithSessions,
        getProjectSessionsPage,
        getProjectIdByPath: (projectPath: string) => projectsDb.getProjectPath(projectPath)?.project_id ?? null,
    },
    runs: chatRunRegistry,
    // The session service plus a direct by-id lookup, so `session_get` (and
    // `ui_last_opened_session`) resolves a session older than the recents page
    // instead of scanning the one page the listing reads. The by-id read is a
    // per-call lookup with no `this` in the service, so spreading is safe.
    sessions: {
        ...sessionsService,
        readSessionById: (sessionId: string) => sessionsDb.getSessionById(sessionId),
    },
    hosts: sessionHostManager,
    activity: activityStore,
    quay: {
        hasQuayConfig: (projectId: string) => quayService.getQuayStatus(projectId)?.hasQuayConfig ?? false,
        readCached: (projectId: string) => quayService.getCachedSnapshot(projectId),
        refresh: (projectId: string) => quayService.getQuaySnapshot(projectId, { forceRefresh: true }),
    },
    runGet: mcpRunGetDeps,
    // gap-mcp-ui-last-opened-session: the browser's last-opened pointer.
    // READ-ONLY here on purpose — the providers module's session-read
    // routes are the only writers, so an MCP token can never move it.
    uiLastOpened: { read: () => uiLastOpenedSessionService.readLastOpened() },
    uiVisibleContext: mcpUiVisibleContextDeps,
    // gap-mcp-ui-clients-list: the discovery half of the same pair. It binds the
    // SAME two process-wide services `uiVisibleContext` binds above.
    uiClientsList: {
        listUiClients,
        requestUiState: (options) => uiStateRequestService.requestUiState(options),
    },
    // gap-mcp-session-search: the conversation-search engine, bound to the SAME
    // service the session-search route calls.
    sessionSearch: {
        search: (input) => sessionConversationsSearchService.search(input),
        now: () => Date.now(),
    },
    // gap-mcp-draft-get-set-submit: the composer-draft store, bound to the SAME
    // `session_drafts` repository the browser's `/api/user/drafts` routes write
    // through (the user module's `drafts` service).
    draft: { drafts: sessionDraftsDb },
    // gap-mcp-pending-interaction-visibility-and-idempotent-answer:
    // `session_get` / `sessions_list` read a session's pending interaction from
    // the SAME pending set `approvals_list` reports — the runtime service's own
    // lookup, flattened across providers exactly as the control service's
    // `pendingApprovals` does — so the two tools can never disagree about which
    // request is waiting.
    approvals: {
        pendingForSession: (sessionId: string) =>
            providerRuntimeService.getPendingApprovalsForSession(sessionId) as Array<{
                requestId: string;
                sessionId: string;
                toolName: string;
                input: unknown;
                receivedAt: Date;
            }>,
    },
    // gap-mcp-changes-on-demand-event-stream (AC-335): the on-demand change
    // stream. Every source is the SAME reader a sibling read tool already uses —
    // `sessionsDb.getSessionsUpdatedSinceKeyset` (the watcher's own table, read as
    // an ascending `(updatedAt, sessionId)` keyset page with the project filter in
    // the SQL, so a truncated page never loses the rows past the LIMIT — AC-347),
    // the run registry, the runtime's pending approvals, and the Quay CACHE. This
    // bag deliberately binds `quayService.getCachedSnapshot` and NOT
    // `getQuaySnapshot`: a cold cache is reported to the caller as a gap, and an
    // MCP read must never spawn the CLI to fill it (the tool's deps have no
    // `refresh` member at all, so it could not even if it tried).
    changes: {
        sessions: {
            listChangedSince: (
                after: { atMs: number; sessionId: string | null },
                projectIds: string[] | null,
                limit: number,
            ) => {
                const projectPaths =
                    projectIds === null
                        ? null
                        : projectIds
                              .map((projectId) => projectsDb.getProjectPathById(projectId))
                              .filter((projectPath): projectPath is string => projectPath !== null);
                const { rows, hasMore } = sessionsDb.getSessionsUpdatedSinceKeyset(
                    { atIso: new Date(after.atMs).toISOString(), sessionId: after.sessionId },
                    projectPaths,
                    limit,
                );
                return {
                    hasMore,
                    rows: rows.map((row) => ({
                        sessionId: row.session_id,
                        projectId: row.project_path
                            ? projectsDb.getProjectPath(row.project_path)?.project_id ?? null
                            : null,
                        title: row.custom_name ?? row.session_id,
                        updatedAtMs: Date.parse(row.updated_at),
                    })),
                };
            },
            projectForSession: (sessionId: string) => {
                const row = sessionsDb.getSessionById(sessionId);
                return row?.project_path
                    ? projectsDb.getProjectPath(row.project_path)?.project_id ?? null
                    : null;
            },
        },
        runs: { listRecentRuns: () => chatRunRegistry.listRecentRuns() },
        // Flattened across the runs in flight, exactly as the control service's
        // `pendingApprovals` fallback does: the runtime lookup is per-session, so
        // the session ids come from the registry and the approvals from the
        // runtime that issued them.
        approvals: {
            listPending: () =>
                chatRunRegistry.listRunningRuns().flatMap((run) =>
                    (
                        providerRuntimeService.getPendingApprovalsForSession(run.sessionId) as Array<{
                            requestId: string;
                            sessionId: string;
                            toolName: string;
                            receivedAt: Date;
                        }>
                    ).map((approval) => ({
                        requestId: approval.requestId,
                        sessionId: approval.sessionId,
                        toolName: approval.toolName,
                        receivedAtMs: approval.receivedAt.getTime(),
                    })),
                ),
        },
        // The `changes` Quay source (AC-348): the project's FULL-coverage task
        // status index, read without loading, plus the non-blocking request that
        // refreshes it in the background. Deliberately NOT `getCachedSnapshot`
        // with its `tasks.recent`: that page is ten rows, so a transition past the
        // tenth was invisible while the reading still said `complete`.
        quay: {
            hasQuayConfig: (projectId: string) => quayService.getQuayStatus(projectId)?.hasQuayConfig ?? false,
            readTaskIndex: (projectId: string) => quayService.readTaskIndex(projectId),
            requestTaskIndexLoad: (projectId: string) => quayService.requestTaskIndexLoad(projectId),
        },
        projects: {
            list: () =>
                projectsDb.getProjectPaths().map((project) => ({
                    id: project.project_id,
                    title: project.custom_project_name ?? path.basename(project.project_path),
                })),
        },
        now: () => Date.now(),
        bootId: () => BOOT_ID,
    },
    now: () => Date.now(),
};

// AC-273's `session_background` deps: the session reader, the session-hosts
// manager's `liveHostForSession` snapshot and the one control service.
const mcpSessionBackgroundDeps: McpSessionBackgroundDeps = {
    sessions: { getSessionById: (sessionId: string) => sessionsDb.getSessionById(sessionId) },
    hosts: sessionHostManager,
    control: chatControl,
};

// AC-274's `approvals_list` / `approval_answer` deps: the one control service
// over a real clock.
const mcpApprovalsDeps: McpApprovalsDeps = {
    control: chatControl,
    now: () => Date.now(),
};

// AC-249's `session_send` deps, shared by the gateway's write tools and by the
// voice executor, so an MCP call and a spoken instruction open their runs
// through the identical send path. `control` is visibly the one `chatControl`
// instance; `runGet` reuses AC-248's deps so a `waitSeconds` send and a
// `run_get` wait move through one clock; `selection` (AC-272) reads the
// session's recorded model/effort/permissionMode from the same singletons the
// WebSocket send path records to.
const mcpSessionSendDeps: McpSessionSendDeps = {
    control: chatControl,
    // AC-337: the WHOLE process registry, not a `{ getRun }` projection. A send
    // now stamps its optional `correlationId` onto the run it opened through
    // this seam, and a projected object silently drops that call — the gateway
    // mount had the identical narrowing, and on the real service both left
    // `sessions_list`'s filter empty while the fixtures, which wire the registry
    // itself, stayed green. This bag also feeds the voice executor's
    // `session_send`, so handing over the registry keeps a spoken send's label
    // landing in the same place as a direct MCP one.
    runs: chatRunRegistry,
    runGet: { deps: mcpRunGetDeps, build: buildRunGet },
    selection: {
        sessions: { getSessionById: (sessionId: string) => sessionsDb.getSessionById(sessionId) },
        models: {
            resolveSessionModel: (provider, options) => providerModelsService.resolveSessionModel(provider, options),
        },
    },
};

// The `/voice-realtime` handler (GOAL-031 / AC-312). The browser opens this path
// with the session it is looking at; the handler dials the real DashScope
// transport (credentials stay here, never in the browser) and hands the
// connection the same MCP services a direct call would use. `boundSessionId` is
// the ONLY session a voice `session_send` can reach — the executor refuses a
// call naming any other, so "the currently open session" is structural rather
// than a policy the UI has to enforce.
/**
 * Builds the proxy seams for ONE voice connection. Shared by the browser's
 * `/voice-realtime` socket and the HTTP diagnosis route, so a diagnosis exercises the
 * very construction the microphone path uses — the same transport options, voice,
 * executor and instructions — and differs only in `observe` (where upstream traffic is
 * reported) and `dryRun` (whether a spoken `session_send` is delivered or recorded).
 */
/** Quiet time after the last relayed piece before the joined message is delivered. */
const VOICE_REALTIME_COALESCE_MS = 1_000;

// THE LIVE RELAY'S OWN RECORD, assembled once here. The two variables are read at THIS point — the
// composition root — and the pure resolvers (`resolveVoiceRealtimeLogDir` /
// `resolveVoiceRealtimeLogMaxBytes`) turn them into a directory and a ceiling, the same split
// `voice.module.ts` makes for the recordings store. The directory defaults beside the database, so a
// deployment that moved its database moves its journal with it.
//
// The start-up line names where it landed: the one thing an operator needs to find a connection's
// record without reading this file.
const voiceRealtimeLogDirectory = resolveVoiceRealtimeLogDir(
    process.env[VOICE_REALTIME_LOG_DIR_ENV],
    process.env.DATABASE_PATH,
);
const voiceRealtimeLogStore = createVoiceRealtimeLogStore({
    directory: voiceRealtimeLogDirectory,
    maxBytes: resolveVoiceRealtimeLogMaxBytes(process.env[VOICE_REALTIME_LOG_MAX_BYTES_ENV]),
});
console.log(voiceRealtimeLogDirStartupLine(voiceRealtimeLogDirectory));

// THE UPLINK AUDIO CAPTURE, assembled here beside the journal it shadows. OFF unless the deployment
// says otherwise: `VOICE_REALTIME_CAPTURE` unset, `off`, or unrecognised reads as disabled and — this
// is the load-bearing half — an unrecognised value is REPORTED, so a typo cannot quietly read as "off".
//
// The directory resolver is called unconditionally, so the start-up line can name where a capture
// WOULD land. Nothing on disk is created by resolving a path: the store makes its directory on the
// first frame, and an OFF recorder never reaches the store at all (see the capture module), so a
// deployment that leaves the switch off gets no directory from this block.
const voiceRealtimeCaptureDirectory = resolveVoiceRealtimeCaptureDir(
    process.env[VOICE_REALTIME_CAPTURE_DIR_ENV],
    process.env.DATABASE_PATH,
);
const voiceRealtimeCaptureMode = resolveVoiceRealtimeCaptureMode(process.env[VOICE_REALTIME_CAPTURE_ENV]);
const voiceRealtimeCaptureMaxBytes = resolveVoiceRealtimeCaptureMaxBytes(process.env[VOICE_REALTIME_CAPTURE_MAX_BYTES_ENV]);
if (voiceRealtimeCaptureMode.warning !== null) {
    console.warn(voiceRealtimeCaptureMode.warning);
}
console.log(voiceRealtimeCaptureStartupLine(voiceRealtimeCaptureDirectory, voiceRealtimeCaptureMode.enabled));

const buildVoiceRealtimeSeams = (input: {
    userId: number;
    observe: DashscopeWireObserver;
    dryRun: boolean;
    log?: (line: string) => void;
    /**
     * THIS connection's uplink capture, or absent. The handler builds it from the SAME connection id
     * the journal recorder got, so the two on-disk records name one connection; the HTTP diagnosis
     * route passes none, because a diagnosis is a scripted clip, not a microphone.
     */
    audioCapture?: VoiceRealtimeAudioCapture;
    /** Overrides the per-window spend limit (CNY). The browser path uses the configured default. */
    spendWindowLimitCny?: number;
    /**
     * The HTTP diagnosis route's per-run turn-detector override, if any. The BROWSER path passes none,
     * so a browser connection always gets the deployment's own resolution.
     */
    turnDetection?: TurnDetectionOverride;
    /**
     * THIS connection's transport choice, as the browser spelled it on the connection URL, or absent.
     *
     * The browser path reads it from {@link VOICE_REALTIME_TRANSPORT_PARAM}; the HTTP diagnosis route
     * passes none, so a diagnosis follows the deployment's own `VOICE_REALTIME_MODE`. A choice here
     * OVERRIDES that environment for this connection alone (see {@link applyVoiceRealtimeTransport}).
     */
    transport?: string | null;
}): VoiceRealtimeProxySeams => {
    // The endpoint override exists for ONE caller: a criterion run, whose config
    // points this server at a stand-in it hosts itself instead of the network.
    // It is the switch as well as the address, because only that selection sets
    // it — so its presence is what says "no real endpoint, no credential".
    const upstreamEndpoint = process.env.VOICE_REALTIME_ENDPOINT;
    const idleRotateMs = resolveIdleRotateMs();
    // The P4 rollout switch (GOAL-034 / AC-322), resolved HERE because this is the assembly point both
    // the browser socket and the HTTP diagnosis route share. Segmented is the default; the escape
    // hatch is a deployment's `VOICE_REALTIME_MODE=continuous`. An unknown value resolves to the
    // default and is logged, so a typo cannot pass for a working rollback.
    //
    // The per-connection opt-in layers ON TOP of that resolution: a browser that named a transport on
    // the connection URL gets it for THIS connection while every other connection keeps the
    // deployment's answer. The environment is still resolved first and its note still logged, so a
    // typo'd `VOICE_REALTIME_MODE` is reported even for a connection that overrode it.
    const envRelayMode = resolveVoiceRealtimeMode(process.env);
    const transportChoice = parseVoiceRealtimeTransport(input.transport);
    const relayMode = applyVoiceRealtimeTransport(envRelayMode, transportChoice);
    const relayModeNote = describeVoiceRealtimeMode(envRelayMode);
    if (relayModeNote !== null) {
        input.log?.(relayModeNote);
    }
    // Silence Tail Suppression (GOAL-044 / AC-364, decision doc §10) — DEPRECATED AND DISCONNECTED.
    // The 2026-10-14 ruling 「STS 已证实无效，取消生产调用」 retires this from the production path: the
    // assembly point NEVER hands a silence-tail seam to the proxy, on any path, for any environment, so
    // `createSilenceTailGate` (in `voice-realtime-ws-proxy.service.ts`) is unreachable from production
    // and the continuous wire forwards every captured frame exactly as it did before STS existed
    // (§10.4 S-6). The switch is still READ here, so a deployment that spelled
    // `VOICE_REALTIME_SILENCE_TAIL=1` is TOLD it changed nothing rather than being silently swallowed;
    // unset (or any value that does not spell the switch on), nothing is logged — silence means
    // "unconfigured", unchanged from before. The module, its tests and its probe docs are kept as
    // evidence that the state machine itself was correct; only the production call site is gone.
    const silenceTail = resolveSilenceTail(process.env);
    const silenceTailNote = describeSilenceTail(silenceTail);
    if (silenceTail.enabled) {
        input.log?.(
            'silence-tail: DEPRECATED and IGNORED — VOICE_REALTIME_SILENCE_TAIL no longer turns on silence ' +
                'tail suppression; the continuous wire forwards every captured frame unchanged' +
                (silenceTailNote === null ? '' : ` (${silenceTailNote})`),
        );
    }
    // The upstream turn detector (GOAL-037 / AC-325), resolved ONCE at the assembly point both the
    // browser socket and the HTTP diagnosis route share — so a browser run and a diagnosis run
    // configuration-read the SAME value, and a per-run diagnosis override is validated by the SAME
    // resolver the environment is. A deployment that sets nothing gets the shipped default
    // (`server_vad`/0.5/800 ms — moved from 400 by the fragment-hold measurement, see
    // `voice-realtime-turn-detection.ts`); a refused value (out of range, or an "off" spelling) falls
    // back to that default AND is logged, so a typo cannot pass for a working rollback.
    const turnDetection = resolveTurnDetection(process.env, input.turnDetection);
    const turnDetectionNote = describeTurnDetection(turnDetection);
    if (turnDetectionNote !== null) {
        input.log?.(turnDetectionNote);
    }
    // The per-window spend cap, resolved at the SAME assembly point. Production names no cap: the
    // window branch exists only when this deployment (or this run's override) explicitly asks for
    // one, so a normal tool-heavy conversation can no longer be ended by a threshold nobody chose.
    // Runaway cost is covered by `TOOL_LOOP_GUARD` (the bridge refuses a 7th tool call inside one
    // utterance), which is the guard the 2026-10-10 incident actually needed — 89 calls is far past
    // 6. A refused value (a typo, a zero, a negative) resolves to NO cap AND is logged, so a
    // silently-disarmed guard cannot pass for a working configuration.
    const spendWindowLimit = resolveSpendWindowLimit(process.env, input.spendWindowLimitCny);
    const spendWindowLimitNote = describeSpendWindowLimit(spendWindowLimit);
    if (spendWindowLimitNote !== null) {
        input.log?.(spendWindowLimitNote);
    }
    // THE UPLINK VAD'S PRODUCTION ARM POINT (scheme §5). Resolved at this same assembly point and built
    // ONCE PER CONNECTION, because the state machine it carries is per connection: the backend classifier
    // owns a model session that must not outlive its connection (`UplinkVadSeam`'s contract). A
    // deployment that configured nothing gets `uplinkVad === undefined` — the proxy's `=== null` fast
    // path, byte-for-byte the relay it was before this feature existed (AC1) — and no line at all, so the
    // shipped default is silent. A typo is REPORTED through `describeUplinkVad` (the shape
    // `resolveVoiceRealtimeMode` established), so an unrecognised spelling cannot pass for a working
    // switch (AC6). No `weightsPath` guessing: Silero/TEN report `unavailable` without one, and the
    // WebRTC backend needs none. The arm point is handed over as the SEAM'S CLASSIFIER — the proxy reads
    // its `state` per frame and flips it to `failed` on a backend throw (AC3).
    const uplinkVadResolution = resolveUplinkVad(process.env);
    const uplinkVadNote = describeUplinkVad(uplinkVadResolution);
    if (uplinkVadNote !== null) {
        input.log?.(uplinkVadNote);
    }
    const uplinkVadArmPoint =
        uplinkVadResolution.enabled && uplinkVadResolution.backend !== null
            ? createUplinkVadArmPoint({
                  backend: uplinkVadResolution.backend,
                  weightsPath: uplinkVadResolution.weightsPath,
                  log: input.log,
              })
            : null;

    // The provenance cell behind `session_status` (SPEC §6.3/§8.2): the LAST aggregator reading the
    // S-A status line was rendered from, captured as the proxy publishes it. A `session_status` call
    // answers from THIS reading, so the tool's `statusSeq` is provably the injected line's own — one
    // source, not a second computation of the same thing. Declared per call here, so each connection
    // closes over its own cell and two sessions can never read each other's plane.
    let latestExecStatus: Parameters<NonNullable<VoiceRealtimeProxySeams['onExecStatus']>>[0] | null = null;

    return {
        // Whether this connection answers the browser's `hello` with `ready{protocol:'segmented-v1'}`.
        // Declared by default; `continuous` restores the pre-P4 wire without a browser release.
        segmentedRelay: relayMode.mode === 'segmented',
        // Carried through so the handshake branch can tell the two silences apart in the log: this
        // connection asked for continuous, vs. the deployment turned the relay off. Absent for a
        // connection that asked for nothing, which is byte-identical to before this seam existed.
        ...(transportChoice === null ? {} : { transport: transportChoice }),
        createTransport: (reportError) =>
            createDashscopeTransport({
                endpoint: upstreamEndpoint,
                onError: reportError,
                observer: input.observe,
                // The SAME sink the journal writes to, so the outbound audio heartbeat lands on one
                // clock with the browser-side `from-browser audio frames=` line. Without it nothing
                // on disk says WHEN audio crossed the server→upstream wire, which is what left a
                // 118 s upstream silence unattributable on 2026-10-12.
                log: input.log,
                // THE DETECTOR'S PARAMETERS TRAVEL AS SESSION DEFAULTS, not as a new transport option:
                // the transport spreads these into every `session.update`, so the resolved value lands
                // on the wire through the ONE path that already carried the hard-coded literal. Only
                // `turn_detection` is replaced — the formats, modalities and voice stay the transport's
                // own defaults, so this cannot drift from them.
                sessionDefaults: { ...DEFAULT_SESSION_DEFAULTS, turn_detection: turnDetection.turnDetection },
                // A connection is ended when it spends more than the resolved cap in 30 s — and that
                // cap is ABSENT unless this deployment named one (see `resolveSpendWindowLimit`
                // above). It is a RATE limit, not a cost line: a runaway tool-call loop crosses a
                // deliberate cap within seconds, and a long ordinary conversation never does. There
                // is deliberately NO default cap on a connection's total or length either — using
                // Live Voice for an hour is normal use. `VOICE_REALTIME_MAX_CNY_PER_CONNECTION` can
                // still impose a total, and it is the only thing that puts `maxCnyTotal` here.
                spendGuard: {
                    windowMs: 30_000,
                    ...(spendWindowLimit.maxCnyPerWindow === undefined
                        ? {}
                        : { maxCnyPerWindow: spendWindowLimit.maxCnyPerWindow }),
                    ...(process.env.VOICE_REALTIME_MAX_CNY_PER_CONNECTION
                        ? { maxCnyTotal: Number(process.env.VOICE_REALTIME_MAX_CNY_PER_CONNECTION) }
                        : {}),
                },
                // NOT `respondToToolOutputs: false`. Tried to save the model's one-line remark per
                // delivery (about half of all responses) and reverted the same day: without that
                // closing turn the model, in the NEXT utterances, answered "No response requested."
                // in text instead of calling session_send — 3 of 5 spoken instructions were heard,
                // transcribed, and never relayed. The remark is cheap now (one tool, ~0.6k context).
                apiKey: process.env.DASHSCOPE_API_KEY,
                // THE ADOPTED MODEL REQUIRES AN EXPLICIT VOICE. Left unset, the
                // endpoint falls back to its own default (`Chelsie`) and rejects
                // the session the moment a response is created:
                //   <400> InternalError.Algo.InvalidParameter: Voice 'Chelsie' is not supported.
                // Omitting this is silent at `session.update` time — the session is
                // accepted, the user's audio is even transcribed — and only fails
                // when the model tries to answer, which reads as "it hears me but
                // never replies" until the socket drops.
                voice: DEFAULT_DASHSCOPE_REALTIME_VOICE,
                // The transport refuses to dial the REAL endpoint without a
                // credential, and that guard is load-bearing. A stand-in holds
                // no credential, so the criterion supplies the socket factory
                // the guard stands in for — the seam the transport exposes for
                // exactly this — and every shipped path supplies none.
                ...(upstreamEndpoint === undefined
                    ? {}
                    : {
                          socketFactory: (target: string, headers: Record<string, string>) =>
                              new WebSocketClient(target, {
                                  headers,
                              }) as unknown as DashscopeSocket,
                      }),
            }),
        createExecutor: ({ boundSessionId: bound }) => {
            const executor = createVoiceRealtimeLiveExecutor({
                boundSessionId: bound,
                caller: { userId: input.userId, scopes: VOICE_REALTIME_CALLER_SCOPES },
                visibleContext: mcpUiVisibleContextDeps,
                readTools: mcpReadToolDeps,
                runGet: mcpRunGetDeps,
                approvals: mcpApprovalsDeps,
                sessionBackground: mcpSessionBackgroundDeps,
                sessionSend: mcpSessionSendDeps,
                // The SAME abort verb the MCP gateway's own `session_interrupt` reaches
                // (built just below from the one `chatControl`), so a spoken stop and a
                // browser stop button are one path, not two.
                sessionInterrupt: buildSessionInterruptDeps({ control: chatControl }),
                // `session_status`'s window onto the execution plane: the SAME aggregator reading the
                // injected status line came from (captured above by `onExecStatus`), never a live
                // re-read — SPEC §6.3's "同一份状态" and §8.2's single-source rule. `reading()` is
                // `null` until the proxy has injected a line, which the tool reports as the idle plane.
                sessionStatus: { reading: () => latestExecStatus },
                onSessionRefusal: (refusal) => {
                    // A refusal is not a crash: the model named another session
                    // and the executor held the line. Logged so the operator can
                    // see the attempt rather than only its absence.
                    console.log('[voice-realtime] refused a send for another session', JSON.stringify(refusal));
                },
            });
            if (!input.dryRun) {
                return executor;
            }
            // A diagnosis must not inject a message into a real conversation: the
            // spoken send is recorded and answered with a stand-in result, every
            // other tool stays real (they only read).
            return {
                ...executor,
                session_send: async (args: Record<string, unknown>) => ({
                    runId: 'dry-run',
                    queued: false,
                    queuedMessageUuid: null,
                    source: 'dry-run',
                    blockedBy: null,
                    dryRun: true,
                    wouldSend: args,
                }),
                // Neither may a diagnosis abort a real run — a stop word in a
                // scripted clip is recorded, not carried out.
                session_interrupt: async (args: Record<string, unknown>) => ({
                    aborted: false,
                    dryRun: true,
                    wouldInterrupt: args,
                }),
            };
        },
        instructions: VOICE_REALTIME_INSTRUCTIONS,
        log: input.log,
        // Publish each injected status line's aggregator reading into the per-connection cell the
        // `session_status` tool reads (SPEC §6.3/§8.2). This is the ONLY writer of `latestExecStatus`,
        // so the tool and the line can never disagree: they are one reading, handed out twice.
        onExecStatus: (reading) => {
            latestExecStatus = reading;
        },
        // The bound session's OWN queue, read from the host that holds it (SPEC §18.1 F-3). The relay
        // cannot count this itself — the CLI drains at a turn boundary nothing tells the relay about —
        // so every depth it reports is reconciled against this reading. Resolved through the same
        // runtime gateway every resident control verb uses; `null` (a per-run session, a host that is
        // gone, an unknown provider) is the honest "unknown depth" the line degrades to, never a zero.
        hostQueueReading: (sessionId) => {
            const provider = sessionsDb.getSessionById(sessionId)?.provider;
            if (typeof provider !== 'string' || provider === '') {
                return null;
            }
            return providerRuntimeService.pendingQueuedInputs(provider as LLMProvider, sessionId);
        },
        // WHICH OF THE BOUND SESSION'S SENTENCES THE RUN HAS ALREADY TAKEN UP (SPEC §18.3 R-4.3 /
        // §18.4 G2, GOAL-041 AC-343). The interrupt fence joins the host's own `command_lifecycle`
        // `started` reading back to the utterance each delivered command carried, so a stop the model
        // asks for a sentence the current run already contains is answered `covered` instead of
        // aborting the very turn answering it — the repeated-interrupt churn §0.3 D-7 forbids.
        //
        // The SIBLING of `hostQueueReading` above, resolved the same way and for the same reason: the
        // dequeued set is the resident process's own account of itself (a per-run session has no
        // `command_lifecycle` to read), never ids the proxy inferred from the messages it sent.
        // `null` — a per-run session, a host that is gone, an unknown provider, a driver with no
        // lifecycle record — degrades the fence to its idempotent half, which is honest; an empty
        // list stays a real reading (`started: []`) and is NOT collapsed into the same `null`.
        hostCommandLifecycle: (sessionId) => {
            const provider = sessionsDb.getSessionById(sessionId)?.provider;
            if (typeof provider !== 'string' || provider === '') {
                return null;
            }
            const started = providerRuntimeService.startedQueuedCommands(provider as LLMProvider, sessionId);
            return started === null ? null : { started };
        },
        // WHICH TOOL THE RUN IS EXECUTING, for the stop's aftermath (SPEC §0.3 D-8 / §18.5,
        // GOAL-041 AC-344). The proxy's own state knows the messages it sent, never the `tool_use`
        // the CLI took up, so the reading comes from the process-wide activity store's turn — the
        // same record the chat UI's activity protocol serves and the same one `run_get` reads its
        // `phase`/`toolName` from. `phase: 'tool'` is the ONLY state in which a tool is in flight;
        // every other phase answers `inFlightTool: null`, and so does a session the store holds no
        // snapshot for. `null` is the honest "cannot read it" the note's tool-free form covers —
        // never a guess, and never a stale tool name carried over from some earlier reading.
        hostRunActivity: (sessionId) => {
            const snapshot = activityStore.snapshot(sessionId);
            // THE HOST'S OWN ROUNDS DECIDE "BUSY" WHEN THEY CAN (2026-10-14 evening reading). The
            // activity store's turn phase is a REDUCTION of stream traffic — no "turn began" signal, so
            // it leaves `idle` only on the first `thinking_tokens`/text/`tool_use` and returns there
            // after a `tool_result` — which let the relay release its ONE held message mid-turn four
            // times, dropping the words into the CLI's own queue (the defect this seam's `busy` half
            // exists to close). The resident driver's `rounds` FIFO is the same process's own account
            // of an armed turn, so it is asked FIRST; the phase reduction is kept only for the sessions
            // no resident driver hosts (`null` — debug-agent, a per-run session), which leaves those
            // paths byte-identical to before. `inFlightTool` is unchanged: it is always the activity
            // store's half.
            const provider = sessionsDb.getSessionById(sessionId)?.provider;
            const roundsBusy =
                typeof provider === 'string' && provider !== ''
                    ? providerRuntimeService.runInFlight(provider as LLMProvider, sessionId)
                    : null;
            return composeHostRunActivityReading({
                roundsBusy,
                turn: snapshot === null ? null : { phase: snapshot.turn.phase, toolName: snapshot.turn.toolName },
            });
        },
        // One spoken thought is one message: relayed pieces within this quiet window are joined.
        coalesceMs: VOICE_REALTIME_COALESCE_MS,
        // SPEC §C3: the connection runs over one active session plus a pre-warmed standby,
        // and switches to the standby after this much idle. The switch costs the user nothing
        // because the standby is already open — P0a-S2 measured the session open at
        // p50=259ms p90=736ms, which is exactly the latency a warm standby hides.
        //
        // `VOICE_REALTIME_IDLE_ROTATE_MS` is the switch, read here because the seams are the
        // ONE construction both the browser socket and the HTTP diagnosis route share, and
        // neither of their inputs carries a pool threshold. Unset means no pool.
        ...(idleRotateMs === null ? {} : { upstreamPool: { idleRotateMs } }),
        // The uplink capture is per connection and built by the caller; the seams only carry it through.
        // Absent (the diagnosis route, a capture that is off) leaves `seams.audioCapture` undefined, and
        // the proxy's every capture call is `?.`-guarded — the branch is byte-identical to before.
        ...(input.audioCapture === undefined ? {} : { audioCapture: input.audioCapture }),
        // The uplink VAD's per-frame speech gate, or absent. ABSENT is the shipped state and the one that
        // matters: `uplinkVad === undefined` leaves the proxy's continuous branch on its pre-feature
        // `=== null` fast path, so a deployment that named no backend forwards every captured frame
        // exactly as it did before this feature existed. Present only when the environment asked for a
        // backend (see `resolveUplinkVad` above), and then the arm point IS the classifier the proxy's
        // gate consults.
        ...(uplinkVadArmPoint === null ? {} : { uplinkVad: { classifier: uplinkVadArmPoint } }),
    };
};

/**
 * The pool's idle threshold for this deployment, from {@link VOICE_REALTIME_IDLE_ROTATE_MS_ENV} —
 * or `null` for "no pool at all", which is what a deployment that says nothing gets.
 *
 * WHY OFF UNTIL ASKED FOR, when the SPEC's default threshold is 90 s anyway. Because a standby
 * is a SECOND upstream connection, and a second connection is observable: the e2e specs host
 * their own stand-in upstream and assert exact connection counts — `voice-realtime-composer-embedded.spec.ts`
 * requires that "a retry dials the upstream exactly once". Turning a pool on under them would
 * add one connection per pool and red those specs for a behaviour no deployment asked for yet.
 * So the capability lands switchable, and turning it on is a deployment's explicit choice:
 * `VOICE_REALTIME_IDLE_ROTATE_MS=<ms>` gives the pool that threshold, and the SPEC's 90 000 is
 * what a deployment names to adopt it as written.
 */
function resolveIdleRotateMs(): number | null {
    const raw = process.env[VOICE_REALTIME_IDLE_ROTATE_MS_ENV];
    if (raw === undefined || raw.trim() === '') {
        return null;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || Math.trunc(parsed) <= 0) {
        // `0` (or nonsense) is the escape hatch: exactly one session, the pre-C3 behaviour.
        return null;
    }
    return Math.trunc(parsed);
}

// The `/voice-realtime` handler (GOAL-031 / AC-312). The browser opens this path
// with the session it is looking at; the handler dials the real DashScope
// transport (credentials stay here, never in the browser) and hands the
// connection the same MCP services a direct call would use. `boundSessionId` is
// the ONLY session a voice `session_send` can reach — the executor refuses a
// call naming any other, so "the currently open session" is structural rather
// than a policy the UI has to enforce.
const voiceRealtime = (ws: WebSocket, request: AuthenticatedWebSocketRequest): void => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const boundSessionId = url.searchParams.get('session');
    if (!boundSessionId) {
        ws.close();
        return;
    }
    // THIS connection's transport opt-in, as the browser named it (`?transport=continuous`). Read here,
    // once, so the same choice decides the seams AND the journal's own mode cell — a connection whose
    // recorder said `segmented` while the relay ran continuous would be the kind of stale reading this
    // journal exists to prevent.
    const transportChoice = parseVoiceRealtimeTransport(url.searchParams.get(VOICE_REALTIME_TRANSPORT_PARAM));

    // The browser already authenticated the upgrade with its own JWT, so the
    // connection acts with the user's own authority. The scopes are the full
    // first-party vocabulary the gateway's tools check against.
    const userId = Number(request.user?.userId ?? request.user?.id ?? 0);

    // Always-on upstream log: what the endpoint said, one line each, audio and interim
    // deltas left out. "It heard me but nothing happened" used to leave no server-side
    // trace at all; this is that trace.
    //
    // AS OF the relay journal it is also the on-disk trace: the recorder tees every line the proxy
    // emits — and every frame the transport observes — into this connection's journal, so the
    // readings that used to require grepping the launcher's stdout redirect (per-response tokens with
    // the text/audio split, each segment, each `session_send`'s latency) are a file an operator can
    // open. The `log`/`observe` seams are the proxy's OWN, unchanged: what changed is who receives
    // them.
    //
    // The recorder also owns the running totals and prints the SAME usage line this handler used to
    // print itself — one accumulator, so the journal's `usage` entry and the stdout line cannot
    // disagree.
    const tag = boundSessionId.slice(0, 8);
    // ONE id per connection, minted once here: the journal's file name AND the capture's file name
    // derive from this same value, so a connection's two on-disk records name one connection by
    // construction rather than by two files happening to agree.
    const connectionId = randomUUID();
    const recorder = createVoiceRealtimeRecorder({
        store: voiceRealtimeLogStore,
        connectionId,
        sessionId: boundSessionId,
        tag,
        mode: applyVoiceRealtimeTransport(resolveVoiceRealtimeMode(process.env), transportChoice).mode,
    });
    // THIS connection's uplink capture, over the directory and ceiling resolved at the assembly point.
    // Built unconditionally; whether a byte is written is the recorder's `enabled`, resolved once from
    // the environment — an OFF recorder is a no-op that never reaches the store, so no directory and no
    // file can appear for a deployment that left the switch off.
    const captureRecorder = createVoiceRealtimeCaptureRecorder({
        store: createVoiceRealtimeCaptureStore({
            directory: voiceRealtimeCaptureDirectory,
            connectionId,
            maxBytes: voiceRealtimeCaptureMaxBytes,
        }),
        connectionId,
        enabled: voiceRealtimeCaptureMode.enabled,
    });
    handleVoiceRealtimeConnection(
        ws,
        boundSessionId,
        buildVoiceRealtimeSeams({
            userId,
            dryRun: false,
            log: recorder.log,
            transport: transportChoice,
            // BOTH recorders observe the SAME wire: the journal's tee is unchanged, and the capture reads
            // the endpoint's judgement events (`speech_started` / `.speech_stopped` / `.committed`) off
            // the identical stream. One clock, one id, so the audio's offsets and the journal's lines are
            // measured against the same origin.
            observe: (observation) => {
                recorder.observe(observation);
                captureRecorder.observe(observation);
            },
            audioCapture: captureRecorder,
        }),
    );
};

// Single WebSocket server that handles chat, shell, and plugin proxy paths.
createWebSocketServer(server, {
    verifyClient: {
        isPlatform: IS_PLATFORM,
        authenticateWebSocket,
    },
    chat: {
        runtime: providerRuntimeService,
        control: chatControl,
        uiNavigations,
    },
    shell: {
        resolveProviderSessionId: (sessionId, provider) => {
            const dbSession = sessionsDb.getSessionById(sessionId);
            if (dbSession) {
                return dbSession.provider_session_id ?? null;
            }

            return null;
        },
    },
    voiceRealtime,
    getPluginPort,
});

// The unattended-run seam, wired here because it is the only place both halves
// are in scope.
//
// A resident process can open a turn of its own — a background task finishing
// with nothing queued behind it — and that turn needs a run so its frames are
// seq-numbered, buffered for replay and readable as history. Opening one means
// writing to the run registry, which belongs to the websocket module, which
// imports the providers module, which owns the host drivers: a seam injected
// from either side would close that cycle. `provider.registry.ts` states the
// gap rather than papering over it, so the wiring lives at the composition
// root — the same reason the session-hosts router's reader seams are resolved
// here. Without this, an unattended turn is still carried (its frames go to the
// last writer, as before the seam existed); it is simply not a run.
sessionHostManager.setUnattendedRunOpener((input) => chatRunRegistry.openUnattendedRun(input));

// The host listing's push wire. The manager owns the revision and announces
// every change to it; this is the one subscriber, and it turns each revision
// into a `hosts_changed` invalidation frame on the shared connection registry.
// It lives here for the same reason the opener above does: the manager is
// imported by the websocket module, so it cannot import the broadcast back — the
// composition root, where both are in scope, is the only place the edge can be
// drawn without a cycle. Consumers of the frame (the browser's session-hosts
// store) re-read `GET /api/session-hosts` rather than receiving a second copy of
// the listing.
sessionHostManager.onChange((rev) => broadcastHostsChanged(rev));

// The debug agent's half of the same seam, and deliberately the *same* route: a
// scenario's unattended turn opens a run by asking the session-host manager,
// which asks the opener installed just above. Nothing here knows what a run is —
// it hands over the four facts the manager's opener takes and returns the writer
// it answered with, so a debug turn is a run by exactly the path a real resident
// process's turn is.
//
// The provider id is cast for the reason ADR-003 decision 2 gives: the runtime
// id is deliberately not in `LLMProvider`, and the run record carries the union
// because every other caller's provider is in it. The cast is the seam's, not a
// claim that the union has a new member.
setDebugAgentOpenRun((input) =>
    sessionHostManager.openUnattendedRun({
        provider: DEBUG_AGENT_PROVIDER_ID as LLMProvider,
        appSessionId: input.appSessionId,
        // The provider-native id is the id the fixture transcript was indexed
        // under, and for an armed scenario it equals the app session id — the
        // rows carry the same value the session row does.
        providerSessionId: input.appSessionId,
        // A turn nobody asked for has no user to report to; the frames are
        // buffered for replay and readable as history whoever opens them.
        userId: null,
        // Nor is there a conversation title to carry: the session is already
        // named by the fixture, and a run that invented one would be reporting a
        // name no listing ever showed.
        sessionName: null,
    })?.writer ?? null,
);

// The activity-change tick: the run loop's Task and Schedule reducers change
// under frames, and a change has to advance the activity store's revision so a
// subscribed browser is pushed a whole-snapshot `activity.upsert`. The store
// belongs to the websocket module and the reducers to the providers module, so
// the tick is installed here, where both are in scope — the same one-way
// injection the run-opener seams above use, and the reason the providers module
// exposes a setter rather than importing the store back.
setActivityChangeNotifier((sessionId) => activityStore.recordChange(sessionId));

app.use(cors({ exposedHeaders: ['X-Refreshed-Token', 'X-Auth-Error'] }));
app.use(express.json({
    limit: '50mb',
    type: (req) => {
        // Skip multipart/form-data requests (for file uploads like images)
        const contentType = req.headers['content-type'] || '';
        if (contentType.includes('multipart/form-data')) {
            return false;
        }
        return contentType.includes('json');
    }
}));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Public health check endpoint (no authentication required)
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        installMode,
        version: RUNNING_VERSION,
        buildSha: BUILD_INFO.gitSha,
        builtAt: BUILD_INFO.builtAt
    });
});

// A browser that stores an `/api` response also stores the terminal
// `X-Refreshed-Token` it carries, and replays both on the next load; the replayed
// token then rolls the session backwards until every refresh signs the user out.
// Mounted ahead of the guard so a refusal is uncacheable too, and before the auth
// router so its `/api/auth/*` responses cannot be replayed either. The middleware
// only writes headers, so the streaming endpoints (SSE, TTS audio) mounted below
// are untouched and never buffered by it. The client's monotonic accept is the
// independent second guard — neither layer relies on the other.
app.use('/api', apiNoStoreMiddleware);

// Optional API key validation (if configured)
app.use('/api', validateApiKey);

// One secret-free line per `/api/auth/*` request. Mounted before the auth router
// so the lines also cover requests the middleware refuses (its 401s), which the
// router never sees.
app.use('/api/auth', createAuthRequestLogger());

// Authentication routes (public)
app.use('/api/auth', authRoutes);

// File Tree API Routes (protected)
app.use('/api/file-tree', authenticateToken, fileTreeRoutes);

// Projects API Routes (protected)
app.use('/api/projects', authenticateToken, projectModuleRoutes);

// Chat attachment upload/serving (global ~/.cloudcli/assets store, protected)
app.use('/api/assets', authenticateToken, assetsRoutes);

// Git API Routes (protected)
app.use('/api/git', authenticateToken, gitRoutes);

// Git worktree management (protected)
app.use('/api/worktrees', authenticateToken, worktreesRoutes);

// TaskMaster API Routes (protected)
app.use('/api/taskmaster', authenticateToken, taskmasterRoutes);

// Quay display API Routes (protected, read-only)
app.use('/api/quay', authenticateToken, quayRoutes);

// Commands API Routes (protected)
app.use('/api/commands', authenticateToken, commandsRoutes);

// Settings API Routes (protected)
app.use('/api/settings', authenticateToken, settingsRoutes);

// Personal-access-token self-check. The token itself is the credential — a
// `ccp_` value presented as `Authorization: Bearer <token>` and verified per
// request by the OAuth token service, so revocation and expiry take effect with
// no cache. Mounted on its own router, which handles exactly one path, so no
// other `/api` route gains a token-authenticated surface.
//
// ONE service instance backs BOTH this route and the `/mcp` gateway's auth
// middleware below (AC-241): a second `createAccessTokensService` here would be a
// second, independently-wrong verification path. The const is therefore named and
// threaded into `mountMcpGateway`'s `authorize` seam.
const accessTokensService = createAccessTokensService({ now: () => new Date() });
app.use('/api/oauth', createTokenInfoRouter(accessTokensService));

// The OAuth store (AC-258), built ONCE and shared by both client paths below:
// dynamic registration (`/oauth/register`) and manual creation
// (`POST /api/oauth/clients`). A second store would be a second view of the same
// file, so there is exactly one.
const oauthStore = createOAuthStore();

// Manual OAuth client creation (AC-264). Authenticated like every neighbouring
// settings route: only a logged-in human may mint a client, and the response is
// the plaintext secret's one and only appearance.
app.use('/api/oauth/clients', authenticateToken, createOAuthClientsRouter({ store: oauthStore }));

// The OAuth settings surface (AC-265): the caller's own consent grants (list /
// revoke) and the client list (list / disable) that the settings page drives.
// Mounted under `/api/settings` alongside the PAT routes and behind the same
// `authenticateToken`. It shares the ONE `oauthStore` above, so a revocation here
// stamps the same row the `/mcp` auth path reads on the next request — no second
// store, no cache.
app.use(
    '/api/settings',
    authenticateToken,
    createOAuthSettingsRouter(
        createOAuthSettingsService({
            store: oauthStore,
            grantsDb: oauthGrantsDb,
            clientsDb: oauthClientsDb,
        })
    )
);

app.use('/api/system', authenticateToken, systemRoutes);

app.use('/api/notifications', authenticateToken, notificationRoutes);

// User API Routes (protected)
app.use('/api/user', authenticateToken, userRoutes);

// Plugins API Routes (protected)
app.use('/api/plugins', authenticateToken, pluginsRoutes);

// Browser MCP bridge API (local token protected)
app.use('/api/browser-use-mcp', browserUseMcpRoutes);

// Browser API Routes (protected)
app.use('/api/browser-use', authenticateToken, browserUseRoutes);

// Unified provider MCP routes (protected)
app.use('/api/providers', authenticateToken, providerRoutes);
app.use('/api/scheduled-messages', authenticateToken, scheduledMessagesRoutes);

// Session host listing (protected). Mounted unconditionally — unlike the debug
// agent's control plane below, reading which processes are running is not a
// gated surface — and over the process-wide manager, which is the same table
// `providerRuntimeService` registers every dispatched turn in.
//
// The two reader seams are wired here rather than inside the host module
// because both facts live in this module's neighbours: a session's provider and
// stored mode belong to `sessionsService`, and the host driver a provider
// mounts belongs to `providerRegistry`. The host module cannot import either
// (the providers module already imports it, so the edge back would close a
// cycle), which makes this the composition root the wiring belongs to.
//
// The start seam is here for the same reason and is the one that carries work:
// opening a resident process needs a launch options bag assembled from the
// session row and the model settings the providers layer recorded, so the route
// reaches it through `providerRuntimeService` instead of assembling one itself.
app.use('/api/session-hosts', authenticateToken, createSessionHostsRouter({
    sessionHostManager,
    readSession: (sessionId) => sessionsService.readSessionLifecycle(sessionId),
    resolveHostDriver: (provider) => providerRegistry.resolveProvider(provider).hostDriver ?? null,
    startResidentSession: (provider, sessionId) =>
      providerRuntimeService.startResidentSession(provider, sessionId),
    // The listing's second half: every visible session, so a resident one whose
    // process a restart dropped still appears — with `running: false` and the
    // derived reason — instead of vanishing with its host. The mode is read off
    // the row rather than through `readSessionLifecycle` because this is the
    // bulk path: one query for the whole list, and the column is never NULL on
    // a stored row (`DEFAULT 'per-run'`), so the fallback here matches the
    // single-row reader's normalization rather than inventing a second rule.
    listSessions: () =>
      sessionsDb.getAllSessions().map((session) => ({
        appSessionId: session.session_id,
        provider: session.provider as LLMProvider,
        mode: (session.lifecycle_mode ?? 'per-run') as HostMode,
        // The provider's own id, which is the only key the CLI's registry knows
        // this conversation by — a background job is filed under it, never under
        // the app's session id. `null` for a session the provider has not named
        // yet, which simply has no occupancy to look up.
        providerSessionId: session.provider_session_id ?? null,
      })),
    // The single-row twin of the list above, for `GET /api/session-hosts/:id`:
    // one indexed lookup instead of the whole table. An archived row is absent
    // here for the reason it is absent from the list — the two reads must report
    // the same set of sessions, or a client would see a mode the list denies.
    readSessionState: (sessionId) => {
      const session = sessionsDb.getSessionById(sessionId);
      if (!session || session.isArchived) {
        return null;
      }
      return {
        appSessionId: session.session_id,
        provider: session.provider as LLMProvider,
        mode: (session.lifecycle_mode ?? 'per-run') as HostMode,
        providerSessionId: session.provider_session_id ?? null,
      };
    },
    // The listing's third fact, and the one this server does not own: which of
    // these conversations a Claude Code background job is holding. Read whole,
    // once, per request — `readClaudeSessionOccupancy` scans the CLI's registry
    // directory a single time however many sessions the list above holds.
    readSessionOccupancy: () => readClaudeSessionOccupancy(),
}));

// The activity protocol's REST read port (protected). A late-joining client asks
// for a session's current activity snapshot here before it starts hearing socket
// frames; the snapshot shares its boot id and revision with the heartbeat frames
// on the same session, because both read the one process-wide `activityStore`.
app.use('/api/sessions', authenticateToken, createActivityRouter({ activityStore }));

app.use('/api/voice', authenticateToken, voiceRoutes);

// HTTP-layer Live Voice diagnosis: an audio file in, the upstream's transcription and the
// model's action out — the same proxy path the microphone uses, minus the browser.
app.use(
    '/api/voice-realtime',
    authenticateToken,
    createVoiceRealtimeRouter({
        diagnose: (diagnosisInput, options) => {
            return runVoiceRealtimeDiagnosis(diagnosisInput, {
                // The run's per-request turn-detector override rides through UNRESOLVED: the assembly
                // point below owns the one resolver, so an out-of-range or "off" value is refused
                // there with the same rules the environment is, never applied.
                buildSeams: (observe, turnDetection) =>
                    buildVoiceRealtimeSeams({ userId: options.userId, observe, dryRun: options.dryRun, spendWindowLimitCny: 0.05, turnDetection }),
            });
        },
        // The journal's one maintenance action (see `voice-realtime-log.ts`): the same store the
        // connection handler writes through, cleared whole, answering how many connection records went.
        clearLog: () => voiceRealtimeLogStore.clear(),
        // The capture's own maintenance action, over the SAME directory the recorders write to. A
        // whole-directory clear (see the capture module): the counting is the store's, since only it
        // knows how many connection captures were on disk. Answers `{ deleted: 0 }` when the capture
        // was never on — the address a clear with nothing to do reports, not an error.
        clearCapture: () => clearVoiceRealtimeCaptureDir(voiceRealtimeCaptureDirectory),
    }),
);

// The browser recogniser's runtime and model files, served same-origin. UNPROTECTED on purpose (the
// artifacts are public and carry no user data) and mounted BEFORE the static/SPA layer below, so
// `/voice-client/…` reaches real files instead of the SPA catch-all's HTML. The router whitelists
// every name it will serve; see `voice.routes.ts`.
app.use('/voice-client', voiceClientAssetRoutes);

/**
 * A writer that hands every frame to both sinks.
 *
 * The control plane's per-run dispatch has two readers of the same walk: the
 * clock's own writer, whose collected frames are what its answer reports, and the
 * run's writer, which is what makes the turn a run and whose terminal frame ends
 * it. A writer cannot be two things, so it is two things here rather than one of
 * the two silently losing the frames.
 */
const teeWriter = (
    first: ProviderRuntimeWriter,
    second: ProviderRuntimeWriter,
): ProviderRuntimeWriter => ({
    send(data: unknown): void {
        first.send(data);
        second.send(data);
    },
    setSessionId(sessionId: string): void {
        first.setSessionId?.(sessionId);
        second.setSessionId?.(sessionId);
    },
});

// The debug agent's dev-only control plane (ADR-003 decision 3, face 3). The
// gate decides *at mount time*: while it is closed nothing is attached at this
// path, so there is no layer for a request to reach — a handler answering "403"
// would still be a layer, and would still be reachable by every logged-in user.
// With nothing attached the path falls through to the SPA catch-all below and
// answers `200 text/html`, which is why the face's criterion is not a status
// code (see `debug-agent.gate.ts` for the reading behind that).
if (mountDebugAgentControlPlane(app, authenticateToken)) {
    // The endpoints are registered in the SAME branch that attached them, so a
    // closed gate registers nothing as well as mounting nothing. The seams are
    // built here — and resolved lazily, inside a request — because this is the
    // only module that imports both sides of the cycle the debug agent's routes
    // module would otherwise close (see `debug-agent.routes.ts`).
    registerDebugAgentControlPlaneRoutes({
        driveScenario: ({ sessionId, cwd, projectPath, writer }) => {
            const provider = providerRegistry.resolveProvider(DEBUG_AGENT_PROVIDER_ID);

            // A turn the clock dispatches for a `per-run` session is a run, by the
            // same route a real per-run chat turn is: the transport that dispatches
            // the turn opens it (`chat-websocket.service.ts` calls
            // `chatRunRegistry.startRun` and then `runtime.run` with the run's own
            // writer). The control plane stands in for that transport, so without
            // this the turn exists only as a host lease — visible to the host
            // listing, and to nothing that answers "who is being worked on right
            // now" from the run registry. Every reader the dock consolidation left
            // asks the registry that question: the activity dock, the sidebar's
            // Running view and its badge.
            //
            // Only for `per-run`. A resident session's turn opens its own run from
            // inside the walk — the `unattended-turn` step reaches the same opener
            // through the host layer — and opening one here would take that step's
            // run away from it.
            const lifecycleMode = sessionsDb.getSessionLifecycleMode(sessionId);
            const run = lifecycleMode === 'resident'
                ? null
                : chatRunRegistry.openUnattendedRun({
                    provider: DEBUG_AGENT_PROVIDER_ID as LLMProvider,
                    appSessionId: sessionId,
                    // For an armed scenario the fixture rows carry the app session
                    // id as their own, so the provider-native id is the app id —
                    // passed rather than left null so the run's id mapping is
                    // written exactly as a real turn's would be.
                    providerSessionId: sessionId,
                    // A turn nobody's socket asked for has no user to report to and
                    // no conversation title to carry: the session is already named
                    // by the fixture.
                    userId: null,
                    sessionName: null,
                });

            return providerRuntimeService.run(
                provider.id,
                'debug agent control plane',
                { sessionId, cwd, projectPath },
                run ? teeWriter(writer, run.writer) : writer,
            );
        },
        resolveProvider: () => providerRegistry.resolveProvider(DEBUG_AGENT_PROVIDER_ID),
        // Read off the run registry rather than off the host layer: "a run was
        // opened" is the registry's fact, and the debug agent's unattended turn
        // opens one through the very seam above. A session with no run answers
        // null, which is what the control plane already has to handle.
        readRunSource: (sessionId) => chatRunRegistry.getRun(sessionId)?.source ?? null,
        // The one write this face makes outside the transcript: a scenario's
        // seed names the lifetime its session is stored under, and the row is
        // only there once the arming step has indexed it — which is why this is
        // called from inside `armDebugAgentScenario` rather than before it.
        // Written straight through the repository rather than through
        // `switchSessionLifecycleMode`, because that service refuses a mode the
        // session's provider has not declared and this provider is deliberately
        // not in `LLMProvider`: the declaration it would be checked against is
        // the driver's own (`lifecycleModes`), which is what makes the seeded
        // mode honourable rather than aspirational.
        setSessionLifecycleMode: ({ appSessionId, mode }) => {
            sessionsDb.setSessionLifecycleMode(appSessionId, mode);
        },
    });
    console.log(
        `[DEBUG-AGENT] control plane mounted at ${DEBUG_AGENT_CONTROL_PLANE_PATH} (${getDebugAgentGateReason()})`,
    );
}

// The MCP gateway (AC-240): one stateless Streamable HTTP endpoint at `/mcp`,
// mounted BEFORE the static layer. Order is load-bearing — behind the SPA
// catch-all below, `/mcp` would answer `200 text/html` and no MCP client would
// reach the transport. The gate decides at mount time; while `MCP_ENABLED` is
// off nothing is attached here and the path stays absent.
//
// AC-241/AC-263 replace the fail-closed default `authorize` with real token auth:
// the mount builds the middleware over the SAME `accessTokensService` the
// token-info route uses, so `/mcp` admits valid `ccp_` tokens and invalid ones
// share the token-info 401 body. Once the OAuth switch is on, the same
// middleware also admits valid `cca_` OAuth access tokens whose audience is this
// gateway and answers a discovery challenge otherwise.
//
// The OAuth verification seam is built ONLY when OAuth is on, from the SAME
// validated base URL the discovery documents advertise (read through AC-262's
// gate, so an invalid `PUBLIC_BASE_URL` still aborts startup). While it is off no
// provider is constructed and `/mcp` stays PAT-only, guarded by the loopback
// check (AC-242).
//
// AC-245 supplies `readTools`: the process singletons every stage-3 read tool
// answers from (projects, providers' sessions, session hosts, the chat run
// registry) plus the wall clock. They are injected rather than imported so the
// gateway module owns no database handle and a criterion can drive the same
// tools over its own fixture.
//
// AC-247 adds `activity` (the process activity store, the one source of a
// session's turn phase) and `quay`: an `McpQuayRunner` adapter over the quay
// service. `readCached` binds to `quayService.getCachedSnapshot` (cache-only, no
// subprocess) and `hasQuayConfig` to its Tier-1 path check, so `overview` over N
// projects spawns zero quay CLI processes; `refresh` — the one load-on-demand
// verb, reachable only from `quay_snapshot({ refresh: true })` — binds to
// `getQuaySnapshot(projectId, { forceRefresh: true })`.
//
// AC-248 adds `runGet`: the services `run_get` answers from — the same run
// registry and activity store, the providers' sessions history reader, and the
// wall clock plus a real sleeper for the bounded wait. `bootId` binds to the
// process `BOOT_ID`, the same identity the activity snapshots and every run this
// registry opens carry, so `run_get` can report "服务已重启" when a run belongs to
// a previous process boot.
// One secret-free log line per request to the OAuth and MCP surfaces, including
// the SPA consent API under `/api/oauth/authorize` (whose `state`/`code`/
// `code_challenge` values the logger redacts). Mounted before any of them so the
// lines also cover requests an inner router refuses. Without it a client that
// registered but never exchanged its code is indistinguishable from one whose
// request never arrived.
app.use(
    [
        '/oauth',
        '/api/oauth/authorize',
        '/mcp',
        '/.well-known/oauth-authorization-server',
        '/.well-known/oauth-protected-resource',
    ],
    createOAuthRequestLogger(),
);
const oauthMetadataGate = readOAuthMetadataGate();
// ONE provider instance backs BOTH `/mcp`'s token verification (below) and the
// authorization-server HTTP surface (AC-268, mounted after the metadata). A
// second provider would be a second, independently-wrong view of the same store.
const oauthProvider: OAuthProvider | undefined = oauthMetadataGate.enabled
    ? createOAuthProvider({ store: oauthStore, publicBaseUrl: oauthMetadataGate.baseUrl })
    : undefined;
const mcpOauth: McpOauthSeam | undefined =
    oauthProvider === undefined || !oauthMetadataGate.enabled
        ? undefined
        : {
            publicBaseUrl: oauthMetadataGate.baseUrl,
            verifyAccessToken: (token: string, options: { resource: string }) =>
                oauthProvider.verifyAccessToken(token, options),
        };

// The gateway's composition entry (AC-253). `mountMcpGateway` keeps its name and
// semantics (AC-240's criterion scans for that call), and `createMcpGatewayModule`
// is the assembly: it takes the ONE `chatControl` instance built above — the same
// identifier `createWebSocketServer` and `initializeScheduledMessageDispatcher`
// receive — and fills the projects readers and run registry from the owning
// modules' barrels, so the composition root cannot hand the gateway a second
// control plane.
const mcpGateway = mountMcpGateway(
    app,
    createMcpGatewayModule({
        tokens: accessTokensService,
        oauth: mcpOauth,
        control: chatControl,
        // AC-246's target gate, WIRED in production here
        // (gap-mcp-resolve-deps-production-wiring). Supplying `resolveDeps` turns
        // the gateway's resolution gate on for every tool the mount registers, so
        // a `project` / `session` argument may name its target: an exact id still
        // wins verbatim, a unique title substring resolves, and an ambiguous or
        // unknown reference is refused with the candidate list instead of being
        // acted on. Before this it was never supplied, so `resolveInputTargets`
        // short-circuited to the raw handler and `sessions_list({ project: "…" })`
        // / `quay_snapshot({ project: "…" })` passed a name straight into the
        // strict id lookup, which answered `PROJECT_NOT_FOUND`.
        //
        // Both lists carry ACTIVE entries only, read synchronously so the gate is
        // one indexed SELECT per call. `getProjectPaths()` is the non-archived
        // project listing; `getAllSessions()` is EVERY stored non-archived session
        // (not a recents page), so a valid session id that sits past the first
        // page is still resolved by its exact id rather than refused. The project
        // TITLE is the same string `projects_list` reports as `name`: the row's
        // custom display name, else the directory basename. Each project also
        // carries its stored directory PATH (AC-333), so a caller holding the path
        // resolves by the path layer even when the title alone would be ambiguous;
        // sessions carry none — they have no path to address.
        resolveDeps: {
            listProjects: () =>
                projectsDb.getProjectPaths().map((row) => ({
                    id: row.project_id,
                    title: row.custom_project_name?.trim() || path.basename(row.project_path),
                    path: row.project_path,
                })),
            listSessions: () =>
                sessionsDb.getAllSessions().map((row) => ({
                    id: row.session_id,
                    title: row.custom_name?.trim() || row.session_id,
                })),
        },
        // The read tools' deps — one named bag built above, shared with the
        // voice control plane so both reach the same process-wide services.
        // Every key develop's inline literal carried is in that bag.
        readTools: mcpReadToolDeps,
        // The stage-4 write tools (AC-249). The control service is handed in at
        // the top level (`control: chatControl`) so it is visibly the same
        // instance the WebSocket gateway and the scheduled-message timer share;
        // `runGet` reuses AC-248's deps so a `waitSeconds` send and a `run_get`
        // wait move through one clock.
        writeTools: {
            // AC-249/AC-272's send deps, shared with the voice control plane so a
            // spoken instruction and an MCP call open their runs through one path.
            runGet: mcpSessionSendDeps.runGet,
            // gap-mcp-session-send-reports-pending-interaction-it-queued-behind:
            // a `queued: true` `session_send` names the pending request it was
            // queued behind, read from the SAME pending set the read tools report
            // (the runtime service's own lookup, flattened across providers
            // exactly as `readTools.approvals` above does) and projected through
            // the SAME `toPendingInteraction` — so all three tools name one
            // request at one instant. `now` is the process clock the `waitedMs`
            // projection reads.
            approvals: {
                pendingForSession: (sessionId: string) =>
                    providerRuntimeService.getPendingApprovalsForSession(sessionId) as Array<{
                        requestId: string;
                        sessionId: string;
                        toolName: string;
                        input: unknown;
                        receivedAt: Date;
                    }>,
                now: () => Date.now(),
            },
            // AC-272: an options-less `session_send` reads the session's recorded
            // model/effort/permissionMode and puts them on the run, so a
            // `session_reconfigure` (or an ordinary UI send) is what the next run
            // actually carries.
            selection: mcpSessionSendDeps.selection,
            // AC-278: the three optional session-write deps AC-249's
            // `registerMcpWriteTools` refuses to install without, so that
            // `session_create` / `session_interrupt` / `session_start` /
            // `session_close` answer their real handlers instead of the AC-249
            // placeholder. Each is assembled through the SAME exported
            // constructor the AC-278 criterion drives — `buildSessionCreateDeps`
            // / `buildSessionInterruptDeps` project the process singletons here
            // (the active project repository, the real `sessionsService`, the
            // one shared `chatControl`), and `createSessionHostControl` (AC-251)
            // is handed the identical four session-hosts seams the router above
            // is built with, so the MCP tools and the HTTP route cannot drift
            // onto two different host services.
            sessionCreate: buildSessionCreateDeps({
                projects: projectsDb,
                sessions: sessionsService,
                control: chatControl,
                // The same capability matrix and session-row writer AC-272's
                // `session_reconfigure` is wired with, so a `session_create` that
                // names a `permissionMode` checks it against the ONE matrix and
                // records it on the row through the ONE writer.
                capabilities: providerCapabilitiesService,
                models: providerModelsService,
            }),
            sessionInterrupt: buildSessionInterruptDeps({ control: chatControl }),
            sessionHostControl: createSessionHostControl({
                sessionHostManager,
                readSession: (sessionId: string) => sessionsService.readSessionLifecycle(sessionId),
                resolveHostDriver: (provider) => providerRegistry.resolveProvider(provider).hostDriver ?? null,
                startResidentSession: (provider, sessionId) =>
                    providerRuntimeService.startResidentSession(provider, sessionId),
            }),
            // gap-mcp-ui-open-session: `ui_open_session` — the first tool that
            // changes what the user's screen shows. Bound to the process-wide
            // navigation service built above (so its record and the frames routed
            // into it are the same table) and to the process-wide per-token
            // throttle, which must outlive a request because the MCP server is
            // built per request. `resolveClientName` is the gateway's ONE
            // principal-name resolution (the same one the write notifications
            // name their caller with), so the confirmation bar tells the user
            // WHO asked instead of showing a blank for a personal access token.
            //
            // gap-mcp-ui-focus-turn-show-diff-open-task: the three sibling
            // navigation tools share that SAME bag — one roster, one navigation
            // table, one throttle (so a token's screen control is budgeted as a
            // whole) and one requester resolution.
            uiOpenSession: uiNavigationToolDeps,
            uiFocusTurn: uiNavigationToolDeps,
            uiShowDiff: uiNavigationToolDeps,
            uiOpenTask: uiNavigationToolDeps,
            // gap-mcp-draft-get-set-submit: the write halves of the composer-draft
            // pair over the process-wide draft store. `draft_submit` is handed the
            // SAME `control` / `runs` seams `session_send` uses (the gateway fills
            // both from this bag), so an MCP-submitted draft opens its run through
            // one send path.
            draft: { drafts: sessionDraftsDb },
        },
        // AC-271's `session_cancel_queued` over the same one control service, plus
        // AC-272's `session_reconfigure`: the provider runtime's `reconfigure`
        // passthrough over the SAME `providerRuntimeService` singleton the WebSocket
        // dispatch uses, with the session/model/capability readers it needs — and
        // AC-273's `session_background`: the session reader, the session-hosts
        // manager's `liveHostForSession` snapshot (the same seam AC-245's
        // `session_get` reads) and that same one control service, read through its
        // `stopTask` verb. AC-274's `approvals_list` / `approval_answer` answer from
        // that same control service's approval verbs over a real clock.
        residentTools: {
            control: chatControl,
            reconfigure: {
                sessions: { getSessionById: (sessionId: string) => sessionsDb.getSessionById(sessionId) },
                runtime: providerRuntimeService,
                models: providerModelsService,
                capabilities: providerCapabilitiesService,
            },
            background: mcpSessionBackgroundDeps,
            approvals: mcpApprovalsDeps,
        },
        // AC-303: a SUCCESSFUL external write call pushes the token's owner a
        // notification through the EXISTING notification path (no new setting or
        // channel). The production assembly reads the OAuth client / session rows
        // for its labels and merges a caller's burst into one summary, so an
        // unattended client driving the gateway is audible without being noisy.
        writeNotifications: createMcpWriteNotification(),
    }),
);
console.log(`[MCP] gateway ${mcpGateway.mounted ? 'mounted' : 'not mounted'} at ${MCP_GATEWAY_PATH} (${mcpGateway.reason})`);

// The OAuth discovery documents (AC-262). Mounted HERE — after `/mcp`, and BEFORE
// the static layer below — because the SPA catch-all answers any unmatched GET
// with `200 text/html`: behind it, `/.well-known/oauth-authorization-server` and
// `/.well-known/oauth-protected-resource/mcp` would serve the shell and no MCP
// client could discover the issuer. The gate decides at mount time; an invalid
// base URL throws out of `mountOAuthMetadata` and aborts startup on purpose.
const oauthMetadata = mountOAuthMetadata(app);
console.log(
    `[MCP] oauth metadata ${oauthMetadata.mounted ? 'mounted' : 'not mounted'} (${oauthMetadata.reason})`,
);

// The DCR registration endpoint (AC-264), mounted only when OAuth itself is on
// (the metadata mount's own reading — NOT a second reader of the OAuth switch).
// It still attaches BEFORE the static layer for the same reason as above: behind
// the SPA catch-all, `/oauth/register` would answer `200 text/html`. The DCR
// mode and the redirect allowlist come from their single readers; when the mode
// is `off` nothing is attached and the path stays absent.
if (oauthMetadata.mounted) {
    const oauthRegister = mountOAuthRegister(app, {
        store: oauthStore,
        dcrMode: readMcpDcrMode(),
        allowedHosts: readMcpAllowedRedirectHosts(),
    });
    console.log(
        `[MCP] oauth register ${oauthRegister.mounted ? 'mounted' : 'not mounted'} at /oauth/register (${oauthRegister.reason})`,
    );
}

// The authorization-server HTTP surface (AC-268; SPA consent,
// gap-oauth-consent-spa-backend-contract): `/oauth/authorize` (the validating
// redirect router), the JWT-guarded `/api/oauth/authorize` consent API,
// `/oauth/token` and `/oauth/revoke`, over the ONE provider that also backs
// `/mcp`'s verification seam. `authenticateToken` is the application's own bearer
// middleware, so the consent API is session-bound and a form POST from another
// origin carries no cookie authority. Gated on OAuth being on — the metadata
// mount's own reading, not a second read of the switch — and attached BEFORE the
// static layer for the same reason as the mounts above: behind the SPA catch-all
// every one of these paths would answer `200 text/html` and no OAuth client could
// complete a flow.
if (oauthMetadata.mounted && oauthProvider !== undefined) {
    const oauthServer = mountOAuthServer(app, {
        provider: oauthProvider,
        store: oauthStore,
        clients: oauthClientsDb,
        authenticateToken,
        // AC-261: the consent `allow` decision re-confirms the signed-in user's
        // password through the SAME `authService.login` every other login uses,
        // behind a per-source rate limiter. The verifier is the auth barrel's
        // assembled instance — there is no second credential implementation.
        credentialVerifier,
    });
    console.log(
        `[MCP] oauth server ${oauthServer.mounted ? 'mounted' : 'not mounted'} at /oauth/authorize|api/oauth/authorize|token|revoke (${oauthServer.reason})`,
    );
}

// The anti-framing / no-store posture on the SPA consent DOCUMENT. Mounted at the
// exact consent route, ahead of the static layer, because that layer's SPA
// catch-all sets its own `Cache-Control` for `index.html` and would otherwise win
// on the one document the headers are for; the middleware re-asserts them at
// `writeHead` so they land whether the static layer serves `dist/index.html` or
// the dev branch redirects to the Vite server.
app.use(OAUTH_CONSENT_SPA_PATH, createOAuthConsentDocumentHeadersMiddleware());

// Static assets and the SPA entry, mounted after every API route so response
// compression only ever applies to the bundle and HTML above (see the module
// for why mounting it earlier would capture streaming API responses).
//
// API Routes (protected)
// /api/config endpoint removed - no longer needed
// Frontend now uses window.location for WebSocket URLs

// Chat uploads live under /api/assets (server/modules/assets), which stores
// images and general files in the global ~/.cloudcli/assets folder.
app.use(createStaticAssetsMiddleware({
    distDir: path.join(APP_ROOT, 'dist'),
    publicDir: path.join(APP_ROOT, 'public'),
    onMissingIndex: (req, res) => {
        // In development, redirect to Vite dev server only if dist doesn't exist
        const redirectHost = getConnectableHost(req.hostname);
        res.redirect(`${req.protocol}://${redirectHost}:${VITE_PORT}`);
    },
}));

// global error middleware must be last
app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
  }

  console.error(err);

  return res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    },
  });
});

const SERVER_PORT = Number.parseInt(process.env.SERVER_PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DISPLAY_HOST = getConnectableHost(HOST);
const VITE_PORT = process.env.VITE_PORT || 5173;
const LOCAL_SERVER_MARKER_PATH = path.join(os.homedir(), '.cloudcli', 'local-server.json');
// How long shutdown waits for session host processes to confirm they are gone.
// A host is a child process this server spawned, so leaving one behind outlives
// the server that could still talk to it; the grace period is short because a
// driver that has not answered by now is not going to, and `shutdown()` records
// whatever it had to close itself (see `ShutdownSummary.forced`).
const SESSION_HOST_SHUTDOWN_TIMEOUT_MS = 5_000;

function getErrorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) {
        return undefined;
    }
    return String(error.code);
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function writeLocalServerMarker() {
    const marker = {
        pid: process.pid,
        host: HOST,
        port: Number.parseInt(String(SERVER_PORT), 10),
        url: `http://${DISPLAY_HOST}:${SERVER_PORT}`,
        installMode,
        appRoot: APP_ROOT,
        updatedAt: new Date().toISOString(),
    };

    await fsPromises.mkdir(path.dirname(LOCAL_SERVER_MARKER_PATH), { recursive: true });
    await fsPromises.writeFile(LOCAL_SERVER_MARKER_PATH, JSON.stringify(marker, null, 2), 'utf8');
}

async function removeLocalServerMarker() {
    try {
        const raw = await fsPromises.readFile(LOCAL_SERVER_MARKER_PATH, 'utf8');
        const marker = JSON.parse(raw);
        if (marker.pid && marker.pid !== process.pid) return;
    } catch (error) {
        if (getErrorCode(error) === 'ENOENT') return;
    }

    try {
        await fsPromises.unlink(LOCAL_SERVER_MARKER_PATH);
    } catch (error) {
        if (getErrorCode(error) !== 'ENOENT') {
            console.warn('[WARN] Could not remove local server marker:', getErrorMessage(error));
        }
    }
}

// Initialize database and start server
async function startServer() {
    try {
        // Initialize authentication database
        await initializeDatabase();

        // AC-244: the audit-log retention sweep, one pass at startup then daily.
        // Started HERE — after the database is initialized — because the startup
        // pass immediately deletes from `mcp_audit_log`, so running before
        // `initializeDatabase()` would query a table the migration has not yet
        // created and crash the whole boot. Mounting the gateway (above) still
        // arms no timer and needs no database; only this startup point does.
        startMcpAuditRetention();

        // Configure Web Push (VAPID keys)
        configureWebPush();

        // Check if running in production mode (dist folder exists)
        const distIndexPath = path.join(APP_ROOT, 'dist', 'index.html');
        const isProduction = fs.existsSync(distIndexPath);

        // Log Claude implementation mode
        console.log(`${terminalTextStyles.info('[INFO]')} Using Claude Agents SDK for Claude integration`);
        console.log('');

        if (isProduction) {
            console.log(`${terminalTextStyles.info('[INFO]')} To run in production mode, go to http://${DISPLAY_HOST}:${SERVER_PORT}`);
        }

        console.log(`${terminalTextStyles.info('[INFO]')} To run in development mode with hot-module replacement, go to http://${DISPLAY_HOST}:${VITE_PORT}`);

        // Claude sessions now run in their own systemd scopes (see
        // claude-session-scope.service.ts), which puts them outside this unit's cgroup: the
        // kernel can no longer reap them along with the server, but it also means nothing
        // collects them when the server is SIGKILLed and the shutdown path never runs. Clear
        // those orphans before this server starts adding scopes of its own; scopes whose owning
        // server is still alive are left untouched. The sweep is host-wide, so a throwaway server a
        // test, an e2e run or a soak boots turns it off (`CLAUDE_SESSION_SCOPE_SWEEP=off`) rather
        // than reap scopes it did not create.
        const sweptSessionScopes = resolveResidentScopeSweepEnabled()
            ? sweepOrphanClaudeSessionScopes()
            : [];
        if (sweptSessionScopes.length > 0) {
            console.log(`${terminalTextStyles.info('[INFO]')} Swept ${sweptSessionScopes.length} orphaned Claude session scope(s): ${sweptSessionScopes.join(', ')}`);
        }

        server.listen(SERVER_PORT, HOST, async () => {
            const appInstallPath = APP_ROOT;
            await writeLocalServerMarker().catch((error) => {
                console.warn('[WARN] Could not write local server marker:', error.message);
            });

            console.log('');
            console.log(terminalTextStyles.dim('═'.repeat(63)));
            console.log(`  ${terminalTextStyles.bright('CloudCLI Server - Ready')}`);
            console.log(terminalTextStyles.dim('═'.repeat(63)));
            console.log('');
            console.log(`${terminalTextStyles.info('[INFO]')} Server URL:  ${terminalTextStyles.bright('http://' + DISPLAY_HOST + ':' + SERVER_PORT)}`);
            console.log(`${terminalTextStyles.info('[INFO]')} Installed at: ${terminalTextStyles.dim(appInstallPath)}`);
            console.log(`${terminalTextStyles.tip('[TIP]')}  Run "cloudcli status" for full configuration details`);
            console.log('');

            // Start watching the projects folder for changes
            await initializeSessionsWatcher();
            // Sends anything that came due while the server was not running,
            // then keeps polling. Handed the same control service the WebSocket
            // gateway uses, so a scheduled turn is a run the UI can watch.
            initializeScheduledMessageDispatcher(chatControl);

            // Start server-side plugin processes for enabled plugins
            startEnabledPluginServers().catch(err => {
                console.error('[Plugins] Error during startup:', err.message);
            });
        });

        await closeSessionsWatcher();
        closeScheduledMessageDispatcher();
        // Clean up plugin processes on shutdown
        const shutdownRuntimeServices = async () => {
            // Hosts first, scopes second, and the order is load-bearing rather
            // than tidy.
            //
            // A host records the first reason it is given and ignores every
            // later one (`closeHost` returns early on a closed host), because the
            // reason is meant to name the *cause*. Stopping the scopes first
            // kills the session processes, so the driver sees its process end
            // and reports `exited` — a true statement about the process, but not
            // about who ended it, and by the time this function reaches the
            // shutdown call the record is closed and `server-shutdown` can no
            // longer be written. Closing the hosts first makes the server's own
            // decision the recorded cause, and that close *is* the graceful path:
            // for a resident host it ends the input queue, which is stdin EOF,
            // which is how the CLI is meant to leave.
            //
            // The scope stop below then does what it was written for — collecting
            // anything the EOF did not end — with the record already carrying the
            // reason that explains why it was asked to leave.
            try {
                const hosts = await sessionHostManager.shutdown({ timeoutMs: SESSION_HOST_SHUTDOWN_TIMEOUT_MS });
                if (hosts.closed.length > 0) {
                    const forced = hosts.forced.length > 0 ? `, ${hosts.forced.length} forced` : '';
                    console.log(`[Sessions] Closed ${hosts.closed.length} session host(s)${forced}`);
                }
                // One line per closed host, with the reason and the pid it had.
                // The host record lives in this process's memory and dies with
                // it, so a resident session's close reason is unrecoverable
                // after exit unless it is written down here — and it is the one
                // fact the next boot cannot reconstruct, because by then the
                // process is gone and the row only remembers the mode. Read
                // from the snapshot rather than from the shutdown summary: the
                // summary answers with ids, and the pid and reason are what a
                // reader needs to tie the line to a process.
                for (const host of sessionHostManager.snapshot()) {
                    if (!host.closeReason) continue;
                    console.log(`[Sessions] shutdown-close host=${host.hostId} provider=${host.provider} mode=${host.mode} pid=${host.pid ?? 'none'} closeReason=${host.closeReason}`);
                }
            } catch (err) {
                console.error('[Sessions] Error closing session hosts during shutdown:', getErrorMessage(err));
            }
            // Sessions are spawned into their own scopes, so they are no longer part of this
            // unit's cgroup and nothing else here would stop them. Stop this server's own
            // scopes before exiting; without this a stopped or restarted server leaves every
            // session it was hosting running, where the cgroup teardown used to collect them.
            try {
                const stoppedSessionScopes = stopClaudeSessionScopes();
                if (stoppedSessionScopes.length > 0) {
                    console.log(`[Sessions] Stopped ${stoppedSessionScopes.length} Claude session scope(s)`);
                }
            } catch (err) {
                console.error('[Sessions] Error stopping session scopes during shutdown:', getErrorMessage(err));
            }
            try {
                await browserUseService.stopAllSessions();
            } catch (err) {
                console.error('[Browser] Error stopping sessions during shutdown:', getErrorMessage(err));
            }
            try {
                await stopAllPlugins();
            } catch (err) {
                console.error('[Plugins] Error stopping plugins during shutdown:', getErrorMessage(err));
            }
            try {
                await removeLocalServerMarker();
            } catch (err) {
                console.error('[Local Server] Error removing server marker during shutdown:', getErrorMessage(err));
            }
            process.exit(0);
        };
        process.on('SIGTERM', () => void shutdownRuntimeServices());
        process.on('SIGINT', () => void shutdownRuntimeServices());
    } catch (error) {
        console.error('[ERROR] Failed to start server:', error);
        process.exit(1);
    }
}

startServer();
