// The MCP gateway's public surface (AC-240).
//
// Importing this module is inert: the gate is read inside `mountMcpGateway`, not
// at import time, so a consumer pays nothing until it mounts. Cross-module
// consumers must come through here (backend module standards /
// `boundaries/dependencies`):
//
//  - `server/index.ts` — mounts the stateless `/mcp` endpoint before the static
//    assets middleware, logs the gate's decision, and supplies the process's
//    single `AccessTokensService` plus the OAuth verification seam so the mount
//    builds the shared `createMcpAuthMiddleware` that verifies `ccp_` tokens
//    (AC-241) and, once OAuth is on, `cca_` tokens against their audience
//    (AC-263).
//
// The criterion is the module's own test, which reaches the barrel by relative
// path and the gate through `mountMcpGateway`'s injectable seams.
export { MCP_GATEWAY_PATH, readMcpGatewayGate } from './mcp-gateway.gate.js';
export type { McpGatewayGateReading } from './mcp-gateway.gate.js';

export { mountMcpGateway } from './mcp-gateway.transport.js';
export type { McpGatewayDeps, McpGatewayReading } from './mcp-gateway.transport.js';
// createMcpGatewayModule (AC-253): the gateway's composition entry. Consumed by
// `server/index.ts`, which hands it the ONE chat control service shared with the
// WebSocket gateway and the scheduled-message timer and passes the assembled
// deps to `mountMcpGateway`; the criterion
// (`server/modules/mcp-gateway/tests/mcp-gateway-wiring.test.ts`) reads this
// name off `server/index.ts` and drives the assembled deps through a real mount.
export { createMcpGatewayModule } from './mcp-gateway.transport.js';
export type { McpGatewayModuleDeps } from './mcp-gateway.transport.js';

export { createMcpAuthMiddleware, readMcpPrincipal } from './mcp-gateway.auth.js';
export type {
  McpAuthMiddlewareOptions,
  McpOauthSeam,
  McpOauthVerification,
  McpPrincipal,
} from './mcp-gateway.auth.js';

// The audit surface (AC-244): `withMcpAudit` wraps a tool so every call writes
// exactly one `mcp_audit_log` row; `summarizeToolArgs` reduces arguments to a
// digest; `recordMcpToolCall` is the single writer those paths funnel through;
// `startMcpAuditRetention` runs the 90-day sweep at startup and daily. The
// transport registers AC-245+'s tools through `withMcpAudit`; this module's
// criterion drives each export directly.
// AC-288 adds two more: `McpToolInputSchema` is what a registration may declare
// (a raw shape, or a built schema carrying a bound or an object-level refine),
// and `installMcpCallDispatcher` replaces the SDK's `tools/call` handler with the
// audited one so validation failures and unknown names reach the one envelope
// instead of the SDK's text-only protocol error. The transport calls the
// dispatcher once per mount; `tests/mcp-invalid-argument.test.ts` reads its two
// branches and `McpToolInputSchema` is the type the read-tool seam widens to.
export {
  installMcpCallDispatcher,
  recordMcpToolCall,
  startMcpAuditRetention,
  summarizeToolArgs,
  withMcpAudit,
} from './mcp-gateway.audit.js';
export type {
  McpAuditOutcome,
  McpAuditRetentionOptions,
  McpToolCallReading,
  McpToolHandler,
  McpToolInputSchema,
  McpToolRegistrar,
  McpToolRegistration,
} from './mcp-gateway.audit.js';

// The single failure envelope (AC-284): `MCP_ERROR_CODES` is the canonical code
// vocabulary the gateway decides for itself; `mcpErrorResult` builds the
// `{ isError: true, structuredContent: { code, message, retryable, details? } }`
// result every failure path returns; `toMcpErrorResult` normalizes a thrown
// `McpToolError` / JSON-bodied `Error` / bare `Error` onto that shape;
// `McpToolError` is what a tool handler throws to reach it directly. The audited
// wrapper (AC-244) and every tool module's refusal path consume these;
// `tests/mcp-error-envelope.test.ts` reads the vocabulary as the expected code
// per probe class. Consumers import from HERE, never from the file directly.
//
// AC-288 adds the two readings that branch is missing: `invalidArgumentFields`
// renders a `ZodError` as the `INVALID_ARGUMENT` envelope's `{ path, problem }`
// list, and `unknownToolResult` is the envelope an unregistered tool name gets.
// The audited wrapper (through `installMcpCallDispatcher`) is their consumer;
// `tests/mcp-invalid-argument.test.ts` reads both off the wire.
//
// AC-286 adds the scope-denial seam: `insufficientScopeResult` renders the
// `INSUFFICIENT_SCOPE` envelope with the MISSING scopes named (the audited
// wrapper's generic scope branch is its consumer), and `McpScopeDeniedError` is
// the throw a handler that owns its own scope check raises — `mcp-session-
// background.ts`'s stop branch raises it and the audited wrapper's catch branch
// discriminates it to record `denied` with the missing scopes. The criterion
// `tests/mcp-insufficient-scope.test.ts` reads both off the wire.
export {
  insufficientScopeResult,
  invalidArgumentFields,
  isMcpErrorCode,
  MCP_ERROR_CODES,
  // The error envelope as a Zod raw shape (gap-mcp-outputschema-drift-overview-
  // and-error-envelope): spliced into every declared output schema by
  // `withMcpAudit` so an `isError` result validates, and read by the criterion
  // that proves it.
  MCP_ERROR_ENVELOPE_SHAPE,
  mcpErrorResult,
  McpScopeDeniedError,
  McpToolError,
  toMcpErrorResult,
  unknownToolResult,
} from './mcp-error-envelope.js';
export type {
  McpErrorCode,
  McpErrorDescriptor,
  McpErrorDetails,
  McpErrorEnvelope,
  McpInvalidField,
} from './mcp-error-envelope.js';

export { createMcpLoopbackGuard, isLoopbackRemoteAddress, readMcpOauthEnabled } from './mcp-gateway.loopback.js';

// The OAuth discovery documents (AC-262): `readOAuthMetadataGate` / `readMcpDcrMode`
// decide, `mountOAuthMetadata` attaches. `server/index.ts` mounts it (and logs the
// decision) before the static layer; the AC-262 criterion reads the gate and the
// mounted endpoints directly. `readMcpDcrMode` is also the reader AC-264 will reuse
// rather than redefining.
export { readMcpDcrMode, readOAuthMetadataGate } from './oauth-metadata.gate.js';
// buildAuthorizationServerMetadata: the pure metadata builder. Consumers: this
// module's `mountOAuthMetadata`, and the AC-264 DCR criterion, which reads the
// `registration_endpoint` it advertises per DCR mode.
export { buildAuthorizationServerMetadata } from './oauth-metadata.gate.js';
export type { AuthorizationServerMetadata, OAuthMetadataGateReading } from './oauth-metadata.gate.js';

export { mountOAuthMetadata } from './oauth-metadata.mount.js';
export type { OAuthMetadataMountReading } from './oauth-metadata.mount.js';

// The stage-3 read tools (AC-245). `MCP_STAGE3_READ_TOOLS` is the one statement
// of which read tools exist and the scope each requires — the transport's
// registration and the criterion's `tools/list` comparison both read it, so the
// name set is a contract rather than a coincidence. `registerMcpReadTools`
// installs them through the audited seam; `paginateMcpText` and
// `formatMcpTime` are the two text-shaping helpers the criterion drives
// directly (the 4000-character cursor protocol, and the relative+ISO time
// pair); `MCP_TEXT_CHUNK_CHARS` and `MCP_TOOL_NOT_IMPLEMENTED_CODE` are the
// values it asserts against instead of restating. `buildSessionDetail` is the
// one reading behind `session_get` (and `ui_last_opened_session`), added to the
// barrel for the voice plane's live executor (gap-voice-realtime-live-session-
// send-wiring), which routes a Realtime `session_get` function call to the SAME
// reading the gateway's registered handler calls rather than a second copy.
export {
  buildSessionDetail,
  formatMcpTime,
  MCP_SESSION_SEARCH_MAX_LIMIT,
  MCP_STAGE3_READ_TOOLS,
  MCP_TEXT_CHUNK_CHARS,
  MCP_TOOL_NOT_IMPLEMENTED_CODE,
  paginateMcpText,
  registerMcpReadTools,
} from './mcp-gateway.read-tools.js';
export type {
  McpReadToolDeps,
  McpReadToolRegistration,
  McpReadToolSeam,
  McpTime,
} from './mcp-gateway.read-tools.js';

// The overview tools (AC-247). `buildOverview` answers the whole-workspace
// reading (running / awaiting-permission / aborted sessions, resident hosts, and
// per-project quay state read from the snapshot cache ONLY); `buildQuaySnapshot`
// reads one project, refreshing it exactly once when asked. `McpQuayRunner` is
// the injected runner seam (`server/index.ts` binds it to `quayService`);
// `McpOverviewDeps` is the deps bag those two read; `registerMcpOverviewTools`
// installs the two names through the audited seam (consumed by
// `registerMcpReadTools` when the deps are wired, and driven directly by this
// module's criterion). `isOverviewWired` is the branch `registerMcpReadTools`
// takes between the real handlers and the named refusal.
export {
  buildOverview,
  buildQuaySnapshot,
  isOverviewWired,
  NO_QUAY_NOTE,
  // The `overview` tool's real output shape (gap-mcp-outputschema-drift-overview-
  // and-error-envelope): the reading `buildOverview` returns, carried in the
  // stage-3 body table and read by the criterion that validates a real reading.
  overviewOutputSchema,
  registerMcpOverviewTools,
  UNKNOWN_QUAY_NOTE,
} from './mcp-overview-tools.js';
export type {
  McpActivityReader,
  McpOverviewAwaiting,
  McpOverviewAborted,
  McpOverviewDeps,
  McpOverviewHost,
  McpOverviewQuayEntry,
  McpOverviewReadDeps,
  McpOverviewRegistration,
  McpOverviewRunning,
  McpQuayRunner,
  McpQuaySnapshotInput,
  McpQuaySnapshotPayload,
  McpQuaySnapshotReading,
  OverviewPayload,
} from './mcp-overview-tools.js';

// The run-by-id tool (AC-248). `buildRunGet` reads one run by id and waits a
// BOUNDED time for it to settle (terminal / `awaitingPermission` / timeout),
// reading the run registry, the activity store and the sessions history through
// injected seams so the wait moves only on the injected clock and sleeper.
// `MCP_RUN_GET_MAX_WAIT_SECONDS` is the one literal for the cap — AC-248's
// criterion imports it instead of re-typing 25, and a later `session_send`
// reuses it rather than writing a second copy. `registerMcpRunGetTool` installs
// the one `run_get` handler through the audited seam (consumed by
// `registerMcpReadTools` when the deps are wired); `isRunGetWired` is the branch
// it takes between the real handler and the named refusal.
export {
  buildRunGet,
  isRunGetWired,
  MCP_RUN_GET_MAX_WAIT_SECONDS,
  registerMcpRunGetTool,
} from './mcp-run-get.js';
export type {
  McpRunGetDeps,
  McpRunGetFallback,
  McpRunGetHit,
  McpRunGetInput,
  McpRunGetMiss,
  McpRunGetMissReason,
  McpRunGetOutcome,
  McpRunGetRegistration,
  RunGetPayload,
} from './mcp-run-get.js';

// The browser last-opened-session tool (gap-mcp-ui-last-opened-session).
// `buildUiLastOpened` answers the session the UI last opened — `session_get`'s
// reading plus `openedAt` — and throws the existing NOT_FOUND-class code when
// nothing is open (never `lastActivity`). `McpUiLastOpenedStore` is the read-only
// pointer seam `server/index.ts` binds to `uiLastOpenedSessionService.readLastOpened`;
// `isUiLastOpenedWired` is the branch `registerMcpReadTools` takes between the
// real handler and the named refusal.
export { buildUiLastOpened, isUiLastOpenedWired, registerMcpUiTools } from './mcp-ui-tools.js';
export type { McpUiLastOpenedDeps, McpUiLastOpenedReading, McpUiLastOpenedStore } from './mcp-ui-tools.js';

// The visible-context tool (gap-mcp-ui-visible-context). `buildUiVisibleContext`
// asks the connected browsers what they are showing — over the websocket
// module's round trip — and returns the per-device, per-tab identifiers and
// ranges, resolving its optional `client` reference with AC-246's rules. It also
// reports the `ui_open_session` navigation log as `navigations[]`
// (gap-mcp-ui-open-session), narrowed by an optional `navigationId`.
// `McpUiVisibleContextDeps` is the injected services `server/index.ts` binds to
// the websocket barrel's `listUiClients` and `uiStateRequestService.requestUiState`,
// plus `listUiNavigations`; `isUiVisibleContextWired` is the branch
// `registerMcpReadTools` takes between the real handler and the named refusal.
export {
  buildUiVisibleContext,
  isUiVisibleContextWired,
  registerMcpUiVisibleContextTool,
} from './mcp-ui-visible-context.js';
export type {
  McpUiVisibleContextDeps,
  McpUiVisibleContextInput,
  McpUiVisibleContextRegistration,
  UiVisibleContextPayload,
} from './mcp-ui-visible-context.js';

// The connected-clients listing tool (gap-mcp-ui-clients-list). `buildUiClientsList`
// enumerates the connected browsers with each device's tabs, navigation policy and
// current visibility/focus, disambiguating duplicate names with a stable short
// suffix, and marks a device whose tabs all stayed silent `unresponsive`.
// `McpUiClientsListDeps` is the injected pair `server/index.ts` binds to the
// websocket barrel's `listUiClients` and `uiStateRequestService.requestUiState` — the
// SAME two services `ui_visible_context` binds, so discovery and observation read
// one registry and one round trip; `isUiClientsListWired` is the branch
// `registerMcpReadTools` takes between the real handler and the named refusal.
export {
  buildUiClientsList,
  isUiClientsListWired,
  registerMcpUiClientsListTool,
} from './mcp-ui-clients-list.js';
export type {
  McpUiClientsListDeps,
  McpUiClientsListRegistration,
  UiClientsListDevice,
  UiClientsListPayload,
  UiClientsListTab,
} from './mcp-ui-clients-list.js';

// The conversation-search tool (gap-mcp-session-search). `buildSessionSearch`
// answers "which sessions mention this phrase" across every project: it runs the
// providers module's conversation-search engine, merges the engine's title and
// match channels by session id, and returns the matched sessions with their
// matched messages — the sort key `sessionMatchScore` ranks them and each hit's
// `messageId` feeds `session_read({ mode: 'around' })`. `McpSessionSearchDeps` is
// the injected engine `server/index.ts` binds to
// `sessionConversationsSearchService.search`; `isSessionSearchWired` is the
// branch `registerMcpReadTools` takes between the real handler and the named
// refusal.
export {
  buildSessionSearch,
  isSessionSearchWired,
  registerMcpSessionSearchTool,
  sessionMatchScore,
} from './mcp-session-search.js';
export type {
  McpSessionSearchDeps,
  McpSessionSearchHit,
  McpSessionSearchInput,
  McpSessionSearchMatchReading,
  McpSessionSearchPayload,
  McpSessionSearchRegistration,
} from './mcp-session-search.js';

// The open-session tool (gap-mcp-ui-open-session). `buildUiOpenSession` resolves
// ONE connected browser (an exact `deviceId`, or a unique id/name substring; a
// single device may be auto-selected), writes a `ui.navigate` to it, and returns
// the DELIVERY reading without waiting for the user. `McpUiOpenSessionDeps` is the
// injected triple `server/index.ts` binds to the websocket barrel's
// `listUiClients` + `uiNavigationService.navigate` plus the process-wide
// `createUiOpenSessionRateLimiter()`; `MCP_UI_OPEN_SESSION_RATE_LIMIT_PER_MINUTE`
// is the fixed per-token throttle the criterion reads rather than re-typing.
export {
  buildUiOpenSession,
  createUiOpenSessionRateLimiter,
  isUiOpenSessionWired,
  MCP_UI_OPEN_SESSION_RATE_LIMIT_PER_MINUTE,
  readUiOpenSessionInput,
  registerMcpUiOpenSessionTool,
  resolveUiOpenSessionDevice,
  UI_OPEN_SESSION_AT_SCHEMA,
  UI_OPEN_SESSION_INPUT_SCHEMA,
  UI_OPEN_SESSION_OUTPUT_SCHEMA,
  UI_OPEN_SESSION_RATE_WINDOW_MS,
} from './mcp-ui-open-session.js';
export type {
  McpUiOpenSessionDeps,
  McpUiOpenSessionInput,
  McpUiOpenSessionRegistration,
  UiOpenSessionPayload,
  UiOpenSessionRateLimiter,
  UiOpenSessionRateLimiterOptions,
} from './mcp-ui-open-session.js';

// The shared navigation core (gap-mcp-ui-focus-turn-show-diff-open-task): the ONE
// body every `ui_*` tool runs (throttle → device resolution → `ui.navigate` →
// delivery reading), plus the shared device resolution and output schema. Exported
// so the criterion can drive any of the four tools' bodies directly.
export {
  buildUiNavigation,
  createUiNavigationRateLimiter,
  hasUiNavigationDeps,
  MCP_UI_NAVIGATION_RATE_LIMIT_PER_MINUTE,
  readStringArg,
  registerMcpUiNavigationTool,
  resolveUiNavigationDevice,
  UI_NAVIGATION_OUTPUT_SCHEMA,
  UI_NAVIGATION_RATE_WINDOW_MS,
} from './mcp-ui-navigation.js';
export type {
  McpUiNavigationRegistration,
  UiNavigationRateLimiter,
  UiNavigationRateLimiterOptions,
  UiNavigationToolDeps,
  UiNavigationToolInput,
  UiNavigationToolOptions,
  UiNavigationToolPayload,
} from './mcp-ui-navigation.js';

// The three sibling navigation tools (gap-mcp-ui-focus-turn-show-diff-open-task):
// `ui_focus_turn` (focus one turn), `ui_show_diff` (reveal a file's diff) and
// `ui_open_task` (open a task's detail). Each is a thin face over the shared core
// above; same scope, throttle, device policy and requester attribution as
// `ui_open_session`.
export {
  buildUiFocusTurn,
  createUiFocusTurnRateLimiter,
  isUiFocusTurnWired,
  MCP_UI_FOCUS_TURN_RATE_LIMIT_PER_MINUTE,
  readUiFocusTurnInput,
  registerMcpUiFocusTurnTool,
  UI_FOCUS_TURN_INPUT_SCHEMA,
  UI_FOCUS_TURN_OUTPUT_SCHEMA,
  UI_FOCUS_TURN_RATE_WINDOW_MS,
} from './mcp-ui-focus-turn.js';
export type {
  McpUiFocusTurnDeps,
  McpUiFocusTurnInput,
  McpUiFocusTurnRegistration,
  UiFocusTurnPayload,
  UiFocusTurnRateLimiter,
  UiFocusTurnRateLimiterOptions,
} from './mcp-ui-focus-turn.js';
export {
  buildUiShowDiff,
  createUiShowDiffRateLimiter,
  isUiShowDiffWired,
  MCP_UI_SHOW_DIFF_RATE_LIMIT_PER_MINUTE,
  readUiShowDiffInput,
  registerMcpUiShowDiffTool,
  UI_SHOW_DIFF_INPUT_SCHEMA,
  UI_SHOW_DIFF_OUTPUT_SCHEMA,
  UI_SHOW_DIFF_RATE_WINDOW_MS,
} from './mcp-ui-show-diff.js';
export type {
  McpUiShowDiffDeps,
  McpUiShowDiffInput,
  McpUiShowDiffRegistration,
  UiShowDiffPayload,
  UiShowDiffRateLimiter,
  UiShowDiffRateLimiterOptions,
} from './mcp-ui-show-diff.js';
export {
  buildUiOpenTask,
  createUiOpenTaskRateLimiter,
  isUiOpenTaskWired,
  MCP_UI_OPEN_TASK_RATE_LIMIT_PER_MINUTE,
  readUiOpenTaskInput,
  registerMcpUiOpenTaskTool,
  UI_OPEN_TASK_INPUT_SCHEMA,
  UI_OPEN_TASK_OUTPUT_SCHEMA,
  UI_OPEN_TASK_RATE_WINDOW_MS,
} from './mcp-ui-open-task.js';
export type {
  McpUiOpenTaskDeps,
  McpUiOpenTaskInput,
  McpUiOpenTaskRegistration,
  UiOpenTaskPayload,
  UiOpenTaskRateLimiter,
  UiOpenTaskRateLimiterOptions,
} from './mcp-ui-open-task.js';

// The stage-4 write tools (AC-249). `MCP_STAGE4_WRITE_TOOLS` is the one
// statement of which write tools exist and the scope each requires — the
// self-referential guard (AC-252) reads the names from it rather than writing a
// second copy, and the criterion compares `tools/list` against it.
// `registerMcpWriteTools` installs the five names through the same audited seam
// AC-245's read tools use (consumed by `mcp-gateway.transport.ts` when the mount
// carries a write-tools deps bag). `buildSessionSend` is `session_send`'s
// adapter — tool input to a `ControlCaller` + `SendInput`, then the control
// service's result to the JSON-bodied payload the audit wrapper renders; the
// criterion drives it through the real mount, and `server/index.ts` supplies the
// deps it reads. `SESSION_SEND_INPUT_SCHEMA` / `readSessionSendInput` are the
// one argument shape, shared by registration and validation.
export {
  MCP_STAGE4_WRITE_TOOLS,
  registerMcpWriteTools,
  UI_FOCUS_TURN_DESCRIPTION,
  UI_FOCUS_TURN_TOOL_NAME,
  UI_OPEN_SESSION_DESCRIPTION,
  UI_OPEN_SESSION_TOOL_NAME,
  UI_OPEN_TASK_DESCRIPTION,
  UI_OPEN_TASK_TOOL_NAME,
  UI_SHOW_DIFF_DESCRIPTION,
  UI_SHOW_DIFF_TOOL_NAME,
} from './mcp-gateway.write-tools.js';
export type {
  McpStage4WriteToolName,
  McpWriteToolDeps,
  McpWriteToolRegistration,
  McpWriteToolSeam,
} from './mcp-gateway.write-tools.js';

export { buildSessionSend, readSessionSendInput, SESSION_SEND_INPUT_SCHEMA } from './mcp-session-send.js';
export type {
  McpControlCaller,
  McpControlRefusalCode,
  McpControlSeam,
  McpControlSendResult,
  McpRunReader,
  McpSessionRunGetSeam,
  McpSessionRunRecord,
  McpSessionSendDeps,
  McpSessionSendInput,
  SessionSendPayload,
} from './mcp-session-send.js';

// The composer-draft tools (gap-mcp-draft-get-set-submit): the read/get half is
// registered by `registerMcpReadTools`, the write halves by
// `registerMcpWriteTools`, and both take their names, schemas and handlers from
// here — one statement of the three verbs.
export {
  buildDraftGet,
  buildDraftSet,
  buildDraftSubmit,
  DRAFT_GET_DESCRIPTION,
  DRAFT_GET_INPUT_SCHEMA,
  DRAFT_GET_OUTPUT_SCHEMA,
  DRAFT_GET_TOOL_NAME,
  DRAFT_SET_DESCRIPTION,
  DRAFT_SET_INPUT_SCHEMA,
  DRAFT_SET_OUTPUT_SCHEMA,
  DRAFT_SET_TOOL_NAME,
  DRAFT_SUBMIT_DESCRIPTION,
  DRAFT_SUBMIT_INPUT_SCHEMA,
  DRAFT_SUBMIT_OUTPUT_SCHEMA,
  DRAFT_SUBMIT_TOOL_NAME,
  readDraftGetInput,
  readDraftSetInput,
  readDraftSubmitInput,
  registerMcpDraftGetTool,
  registerMcpDraftSetTool,
  registerMcpDraftSubmitTool,
} from './mcp-draft.js';
export type {
  McpDraftDeps,
  McpDraftGetInput,
  McpDraftRecord,
  McpDraftRegistration,
  McpDraftSetInput,
  McpDraftStore,
  McpDraftSubmitDeps,
  McpDraftSubmitInput,
} from './mcp-draft.js';

// The session lifecycle write tools (AC-250). `buildSessionCreate` creates a
// session through the real `sessionsService.createAppSession` and, only for a
// non-empty message, opens its first run through the same `ChatControlService`
// a UI send uses — returning the run id alongside the session id, and starting
// nothing when no message was given. `buildSessionInterrupt` stops the run a
// session currently has through the control service's `abort` and leaves the
// resident host untouched; an idle session is reported as `aborted: false` with
// a message saying there was no run to abort. `registerMcpWriteTools` installs
// both when `McpWriteToolDeps.sessionCreate` / `.sessionInterrupt` are supplied;
// `server/index.ts` (via AC-253) supplies them, and this module's criterion
// drives both through the real mount. The two input schemas / readers are the
// one argument shape, shared by registration and validation.
export {
  buildSessionCreate,
  buildSessionInterrupt,
  readSessionCreateInput,
  readSessionInterruptInput,
  SESSION_CREATE_INPUT_SCHEMA,
  SESSION_INTERRUPT_INPUT_SCHEMA,
} from './mcp-session-lifecycle.js';
export type {
  McpControlAbortResult,
  McpControlAbortSeam,
  McpProjectEntry,
  McpSessionCreateDeps,
  McpSessionCreateInput,
  McpSessionInterruptDeps,
  McpSessionInterruptInput,
  SessionCreatePayload,
  SessionInterruptPayload,
} from './mcp-session-lifecycle.js';

// The resident host control write tools (AC-251). `buildSessionStart` starts a
// session's resident host by delegating to the session-hosts module's
// `startResidentHost` — so an already-running session answers with the SAME host
// and pid rather than a second process — and `buildSessionClose` delegates to
// `closeResidentHost`, refusing first (with `SESSION_HAS_ACTIVE_LEASES`) while
// the session holds a `cron` / `background-task` lease and no `force: true` was
// given. `createSessionHostControl` is the production wiring over the
// session-hosts barrel (consumed by `server/index.ts` via AC-253 and by this
// module's criterion); `McpSessionHostDeps` is the injected seam those two
// handlers read; the two input schemas / readers are the one argument shape,
// shared by registration and validation. `registerMcpWriteTools` installs both
// handlers when `McpWriteToolDeps.sessionHostControl` is supplied.
//
// `blockingLeases` / `leasesBlockingMessage` are re-exported for the second
// caller of the same judgement: the session-hosts REST close route. They are the
// one definition of "which leases block a close" and of the refusal sentence, so
// the REST face carries the MCP face's words verbatim instead of a second copy.
export {
  blockingLeases,
  buildSessionClose,
  buildSessionStart,
  createSessionHostControl,
  leasesBlockingMessage,
  readLiveHost,
  readSessionCloseInput,
  readSessionStartInput,
  SESSION_CLOSE_INPUT_SCHEMA,
  SESSION_HAS_ACTIVE_LEASES_CODE,
  SESSION_START_INPUT_SCHEMA,
} from './mcp-session-host-control.js';
export type {
  McpSessionCloseInput,
  McpSessionHostControl,
  McpSessionHostDeps,
  McpSessionStartInput,
  SessionClosePayload,
  SessionStartPayload,
} from './mcp-session-host-control.js';

// The production assemblies for the three optional session-write deps (AC-278).
// `buildSessionCreateDeps` / `buildSessionInterruptDeps` turn the composition
// root's process singletons (the project repository, `sessionsService`, and the
// one shared control service) into the bags `session_create` / `session_interrupt`
// dispatch on; `sessionHostControl`'s assembly is AC-251's `createSessionHostControl`
// above. `server/index.ts` hands all three to `createMcpGatewayModule`, and the
// AC-278 criterion drives the SAME builders so it reads the production assembly
// path rather than a second, test-only one.
export { buildSessionCreateDeps, buildSessionInterruptDeps } from './mcp-session-write-deps.js';
export type { McpSessionCreateWiring, McpSessionInterruptWiring } from './mcp-session-write-deps.js';

// The target-resolution surface (AC-246). `resolveMcpTarget` turns a caller's
// project/session reference into one id (or into an explicit refusal listing the
// candidates), and `resolveInputTargets` is the gate that applies it to a tool's
// `project`/`session` argument before its handler runs. Consumers: the transport
// (which wires the gate onto every tool it registers, from `resolveDeps`), and
// AC-245's read tools / AC-249–AC-251's write tools / AC-250's `session_create`,
// which take ids and names through the same two functions instead of writing a
// resolution rule of their own. This module's criterion drives both directly.
export { resolveInputTargets, resolveMcpTarget } from './mcp-resolve-target.js';
export type {
  McpResolveCandidate,
  McpResolveDeps,
  McpResolveEntry,
  McpResolveResult,
  McpTargetKind,
} from './mcp-resolve-target.js';

// The stage-6 resident tools (AC-271, extended by AC-272). `MCP_STAGE6_RESIDENT_TOOLS`
// is the one statement of the table-listed stage-6 tools and the scope each
// requires — AC-272 adds `session_reconfigure` alongside it rather than growing
// the table, because AC-271's criterion pins the table's observable contents;
// AC-252's self-referential guard reads the gateway tool names from these
// tables. `registerMcpResidentTools` installs them through the same audited
// seam the read/write tools use; the transport calls it when the mount carries
// a resident-tools deps bag. `buildSessionCancelQueued` is `session_cancel_queued`'s
// adapter — it translates the control service's `withdrawn` into AC-271's
// `cancelled`, and never reads a non-withdrawn verdict as `cancelled` — driven
// by the criterion through the real mount; `server/index.ts` supplies the deps.
export { MCP_STAGE6_RESIDENT_TOOLS, registerMcpResidentTools } from './mcp-gateway.resident-tools.js';
export type { McpResidentToolDeps, McpResidentToolSeam, McpStage6ResidentToolName } from './mcp-gateway.resident-tools.js';

export { buildSessionCancelQueued, readSessionCancelQueuedInput, SESSION_CANCEL_QUEUED_INPUT_SCHEMA } from './mcp-session-cancel-queued.js';
export type {
  McpSessionCancelQueuedDeps,
  McpSessionCancelQueuedInput,
  McpSessionCancelQueuedRegistration,
  McpSessionCancelQueuedSeam,
  SessionCancelQueuedOutcome,
  SessionCancelQueuedPayload,
} from './mcp-session-cancel-queued.js';

// `session_reconfigure` (AC-272). `buildSessionReconfigure` records a session's
// model/effort/permissionMode and, when the provider declares the setting live,
// asks the running resident process to move; an unsupported permission mode is
// REFUSED with the supported list (the deliberate opposite of the WebSocket
// path's silent ignore). `registerMcpSessionReconfigureTool` installs it through
// the audited seam under `cloudcli:session:control`; the transport registers it
// via `registerMcpResidentTools` and `server/index.ts` supplies the deps.
export {
  buildSessionReconfigure,
  readSessionReconfigureInput,
  registerMcpSessionReconfigureTool,
  SESSION_RECONFIGURE_FIELDS,
  SESSION_RECONFIGURE_INPUT_SCHEMA,
} from './mcp-session-reconfigure.js';
export type {
  McpSessionReconfigureDeps,
  McpSessionReconfigureInput,
  McpSessionReconfigureRegistration,
  McpSessionReconfigureSeam,
  SessionReconfigureField,
  SessionReconfigurePayload,
} from './mcp-session-reconfigure.js';

// The self-referential guard (AC-252). `buildSelfTargetGuard` is the decision the
// write-tool dispatch point (`registerMcpWriteTools`) applies before each write
// handler: a target session whose live turn is executing a gateway write tool
// (`phase === 'tool'` and an `mcp__<any alias>__<write tool name>` `toolName`)
// is refused with `SELF_TARGET_CODE`, so the control and host services are never
// reached. `isSelfTargetTurn` is the pure rule over one turn and the injected
// write-tool name set; `MCP_SELF_TARGET_WRITE_OPS` is the one statement of which
// operations are protected. `SelfTargetDeps` is the injectable seam (turn
// reader + write-tool names) the transport threads from
// `McpGatewayDeps.selfTarget`; `SelfTargetDecision` is the answer shape. This
// module's criterion drives both functions directly (including the
// `session_cancel_queued` operation) and through the real `/mcp` mount.
export {
  buildSelfTargetGuard,
  isSelfTargetTurn,
  MCP_SELF_TARGET_WRITE_OPS,
  SELF_TARGET_CODE,
} from './mcp-self-target.js';
export type { SelfTargetDecision, SelfTargetDeps } from './mcp-self-target.js';

// `session_background` (AC-273). `buildSessionBackground` lists a session's
// `background-task` / `cron` leases from the LIVE HOST SNAPSHOT (read-only
// enough for `cloudcli:read`) and, with a `stopTaskId`, stops one through the
// shared control service's `stopTask` under its own `cloudcli:session:control`
// check placed BEFORE any control call; an id the snapshot does not hold is
// `TASK_NOT_FOUND` and is never reported stopped. `registerMcpSessionBackgroundTool`
// installs it through the audited seam under the read scope; the transport
// registers it via `registerMcpResidentTools` and `server/index.ts` supplies the
// deps (the session reader, AC-245's host read seam, and the one control service).
export {
  buildSessionBackground,
  registerMcpSessionBackgroundTool,
} from './mcp-session-background.js';
export type {
  McpSessionBackgroundDeps,
  McpSessionBackgroundInput,
  SessionBackgroundPayload,
  SessionBackgroundTask,
} from './mcp-session-background.js';

// The approval tools (AC-274). `buildApprovalsList` lists the pending approvals
// for a session (or every running session), expanding an `AskUserQuestion` into
// its questions and options; `buildApprovalAnswer` decides one through the shared
// control service, forwarding `message` / `answers` (the latter as the runtime's
// `updatedInput`). A request that is no longer pending is an ERROR since AC-287 —
// an `isError` envelope `APPROVAL_NOT_FOUND` whose `details.reason` distinguishes
// an expired request from one this process never minted — raised without calling
// the runtime.
// `registerMcpApprovalTools` installs `approvals_list` (`cloudcli:read`) and
// `approval_answer` (`cloudcli:approve`) through the audited seam; the transport
// registers them via `registerMcpResidentTools` when `McpResidentToolDeps.approvals`
// is supplied, and `server/index.ts` supplies the one control service + a clock.
// The two input schemas / readers are the one argument shape, shared by
// registration and validation.
export { buildApprovalAnswer, buildApprovalsList, registerMcpApprovalTools } from './mcp-approvals.js';
export type {
  ApprovalAnswerPayload,
  ApprovalsListPayload,
  McpApprovalAnswerInput,
  McpApprovalListItem,
  McpApprovalOption,
  McpApprovalPending,
  McpApprovalQuestion,
  McpApprovalsDeps,
  McpApprovalsListInput,
} from './mcp-approvals.js';

// The tool annotations (AC1–AC7). `MCP_TOOL_ANNOTATIONS` is the ONE table a
// `tools/list` hint is written down in — every name the gateway can register,
// with the `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`
// it declares, so a tool's declaration is a reviewable row rather than an
// omission that falls back to the write-leaning spec defaults.
// `readMcpToolAnnotations` is the reader the transport's one `audited` seam calls
// per registration (and throws on a name the table does not own, so a tool
// cannot ship unlabelled); `McpGatewayToolName` is the key union, derived from the
// three tool tables so a name added to any of them without a row here fails to
// compile. Consumers: `mcp-gateway.transport.ts` and this module's annotation
// criterion, which mounts the gateway and compares `tools/list` against the table.
export { MCP_TOOL_ANNOTATIONS, readMcpToolAnnotations } from './mcp-tool-annotations.js';
export type { McpGatewayToolName } from './mcp-tool-annotations.js';

// The per-tool error-code declaration (AC-285). `MCP_TOOL_ERROR_CODES` maps every
// gateway tool name to the subset of `MCP_ERROR_CODES` that tool can leave on the
// wire — the tool-side half of the single-vocabulary requirement, total over
// `McpGatewayToolName` so a tool cannot ship without a row.
// `readMcpToolErrorCodes` is the reader the transport's one `audited` seam calls
// per registration (and throws on a name the table does not own); the transport
// attaches the row to `tools/list` as `_meta['cloudcli/errorCodes']`. Consumers:
// `mcp-gateway.transport.ts` and this module's `tests/mcp-error-vocabulary.test.ts`,
// which reads the declaration back off a real `tools/list`.
export { MCP_TOOL_ERROR_CODES, readMcpToolErrorCodes } from './mcp-tool-error-codes.js';

// The audit READBACK (AC-304): the read side of the AC-244 log. `createMcpAuditReader`
// projects one user's recent `mcp_audit_log` rows into the settings page's shape —
// reusing each row's stored digest as `summary`, resolving the user through its
// token ids, and (unless `includeReads` is set) filtering the annotated read-only
// tools in SQL so the limit counts write rows. `readMcpAuditLimit` normalizes and
// clamps the requested page size, and the three LIMIT constants are the one
// statement of the bounds. Consumers: `server/modules/settings/settings.module.ts`
// (the production assembly) and this module's criterion.
export { createMcpAuditReader, readMcpAuditLimit } from './mcp-audit-route.js';
export {
  MCP_AUDIT_ROUTE_DEFAULT_LIMIT,
  MCP_AUDIT_ROUTE_MAX_LIMIT,
  MCP_AUDIT_ROUTE_MIN_LIMIT,
} from './mcp-audit-route.js';
export type { McpAuditReadDeps, McpAuditRouteEntry } from './mcp-audit-route.js';

// The write-call notifications (AC-303). `createMcpWriteNotifier` is the core —
// the read-only early-return (classified by the one annotations table), the
// per-caller merge window, and the payload construction, over injected seams;
// `createMcpWriteNotification` is the production assembly whose default sink
// rides the EXISTING notification path (`notifyUserIfEnabled`) with no new
// setting. The transport threads the seam from `McpGatewayDeps.writeNotifications`
// into the audit wrapper's `ok` branch; `server/index.ts` supplies the
// production assembly; this module's criterion drives every export directly.
// `resolveClientName` is the module's ONE principal-name resolution: the write
// notification names its caller with it, and `server/index.ts` binds it into the
// `ui_open_session` deps so the confirmation bar names the SAME client.
export { createMcpWriteNotification, createMcpWriteNotifier, resolveClientName } from './mcp-write-notification.js';
export type {
  McpWriteNotification,
  McpWriteNotificationDeps,
  McpWriteNotificationInput,
  McpWriteNotificationPayload,
  McpWriteNotifier,
  McpWriteNotifierDeps,
} from './mcp-write-notification.js';
