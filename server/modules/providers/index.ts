export { sessionSynchronizerService } from './services/session-synchronizer.service.js';
export { providerSkillsService } from './services/skills.service.js';
export { providerMcpService } from './services/mcp.service.js';
export { providerRuntimeService, createProviderRuntimeService } from './services/provider-runtime.service.js';
// ControlStopTaskOutcome: the answer the runtime gateway's stop-task verb gives
// (`requested` / `unsupported` / `timeout` / `error`). Exported so the websocket
// control handler types its pass-through against the one union rather than
// restating it, and so the criterion can name each arm's expected value.
export type { ControlStopTaskOutcome } from './services/provider-runtime.service.js';
// ControlBackgroundTaskOutcome: the answer the runtime gateway's background-task
// verb gives (`requested` / `no-foreground-match` / `unsupported` / `timeout` /
// `error`). Exported for the same reasons as its stop-task sibling: the websocket
// `chat.background-task` handler types its pass-through against this one union,
// and AC-197's criterion names each arm's expected value.
export type { ControlBackgroundTaskOutcome } from './services/provider-runtime.service.js';

// providerModelsService: used by Commands to list models and resolve the active session model.
export { providerModelsService } from './services/provider-models.service.js';

// sessionsService: used by the websocket module's chat gateway to resolve an
// edited message's resume point, which only the providers module can read.
export { sessionsService } from './services/sessions.service.js';
// sessionAwaitingReplyService: used by the websocket module's chat gateway to
// end a session's wait when its next turn starts, and by the providers routes
// to read and dismiss the sidebar's awaiting-reply list.
export { sessionAwaitingReplyService } from './services/session-awaiting-reply.service.js';
// uiLastOpenedSessionService: the browser's last-opened-session pointer. The
// routes in this module write it; `server/index.ts` binds its reader into the
// MCP gateway so `ui_last_opened_session` answers from the same one store.
export { uiLastOpenedSessionService } from './services/ui-last-opened-session.service.js';
// LifecycleModeSwitchResult: the answer `sessionsService.switchSessionLifecycleMode`
// gives — the stored mode plus what happened to the host that was serving the
// session — exported so a criterion can type what the lifecycle-mode route
// answered without restating the shape.
export type { LifecycleModeSwitchResult } from './services/sessions.service.js';
export { searchConversations } from './services/session-conversations-search.service.js';
// sessionConversationsSearchService: the conversation-search ENGINE as the MCP
// gateway's `session_search` tool consumes it — `server/index.ts` binds its
// `search` verb into the read tools' `sessionSearch` deps, so an MCP caller and
// the session-search route scan through one implementation rather than two.
// (`searchConversations` above is the same engine's plain-function face, kept
// for the route that already imports it.)
export { sessionConversationsSearchService } from './services/session-conversations-search.service.js';

// readSessionAiTitle: used by the commands module's `/cost` handler to show the
// title Claude generated for a session. Only the providers module knows a
// transcript's shape, and only it owns the row that points at one.
export { readSessionAiTitle } from './services/session-ai-title.service.js';

export { initializeSessionsWatcher } from './services/sessions-watcher.service.js';
export { closeSessionsWatcher } from './services/sessions-watcher.service.js';
// resolveProviderWatchPaths / ensureProviderWatchRoots: the observation set's own
// seam, driven by the debug-agent gate criterion (`debug-agent-gate.test.ts`), which
// reads the set on both sides of the gate and then confirms the fixture root was
// neither listed nor created. `providerRegistry` is exported for the same criterion:
// the registry face is about whether a key exists, which is only readable from here.
export {
  resolveProviderWatchPaths,
  ensureProviderWatchRoots,
} from './services/sessions-watcher.service.js';
export type { ProviderWatchPath } from './services/sessions-watcher.service.js';
// readActiveWatcherModes: consumed by the debug agent's external-write criterion
// (`debug-agent-external-write.test.ts`), whose arms must each prove the fixture
// root came up in the mechanism that arm pinned — an arm that asked for native
// events and silently got a polling clock would be reporting a different
// experiment than the one it names.
export { readActiveWatcherModes } from './services/sessions-watcher.service.js';
export type { WatcherMode } from './services/sessions-watcher.service.js';
// createClaudeTurnTracker: the Turn Tracker facade. Consumed by the turn-phase
// criterion (`claude-turn-phase.test.ts`), which feeds captured SDK frame
// sequences and asserts the phase each real signal produces; a future activity
// aggregator reads it to say what a session is doing without a local clock.
// TurnPhase / TurnState are the criterion's own vocabulary — it types its
// intermediate readings with them so an assertion cannot pass against a phase
// this module never produces.
export { createClaudeTurnTracker } from './services/claude-turn-phase.service.js';
export type { TurnPhase, TurnState } from './services/claude-turn-phase.service.js';
// createClaudeTaskReducer: the Task Reducer facade. Consumed by the task-reducer
// criterion (`claude-activity-task-reducer.test.ts`), which feeds captured SDK
// frame sequences and a Stop hook snapshot and asserts the task table each real
// signal produces; a future activity aggregator and the REST/WS task surface read
// it instead of the lease ledger's bare ids. ActivityTask / TaskKind / TaskState /
// TaskOrigin / BackgroundTaskSummary / ClaudeTaskReducer are the criterion's own
// vocabulary — it types its readings with them so an assertion cannot pass against
// a shape this module never produces. `mapUpdatedStatus` is exported so the
// criterion's false-form arm can build a `killed → failed` variant that delegates
// every other status to the real table rather than restating it.
// `earnsTaskTerminalRow` is the criterion that decides whether a terminal
// transition becomes a server-emitted transcript row (a real background task
// whose end nothing else expresses) or not (a foreground command, already on its
// own tool card; a kind the CLI notifies about itself). Exported so the
// task-reducer criterion reads the same function the forwarder calls instead of
// restating it. `CLI_NOTIFIED_TASK_KINDS` names the kinds it excludes.
export {
  CLI_NOTIFIED_TASK_KINDS,
  createClaudeTaskReducer,
  earnsTaskTerminalRow,
  mapUpdatedStatus,
} from './services/claude-activity-task-reducer.service.js';
export type {
  ActivityTask,
  BackgroundTaskSummary,
  ClaudeTaskReducer,
  ClaudeTaskTransition,
  TaskKind,
  TaskOrigin,
  TaskState,
} from './services/claude-activity-task-reducer.service.js';
// createClaudeScheduleTracker: the Schedule Tracker facade. Consumed by the
// schedule criterion (`claude-activity-schedules.test.ts`), which drives it with
// captured `CronCreate`/`ScheduleWakeup` tool results and Stop hook
// `session_crons` snapshots and asserts the plan table each real signal
// produces; a future activity aggregator and the REST/WS schedule surface read
// it instead of the host driver's keep-alive lease ledger. ActivitySchedule /
// ScheduleKind / ScheduleSource / SessionCronEntry / ClaudeScheduleTracker /
// ClaudeScheduleTrackerOptions are the criterion's own vocabulary — it types
// its readings with them so an assertion cannot pass against a shape this
// module never produces.
export { createClaudeScheduleTracker } from './services/claude-activity-schedules.service.js';
export type {
  ActivitySchedule,
  ClaudeScheduleTracker,
  ClaudeScheduleTrackerOptions,
  ScheduleKind,
  ScheduleSource,
  SessionCronEntry,
} from './services/claude-activity-schedules.service.js';
// deriveHeldWorkLeases: the Lease Deriver facade — projects the Task table
// (AC-191) and Schedule table (AC-192) into the resident path's held-work
// leases, beside the driver's own path rather than replacing it. Consumed by
// the lease-parity criterion (`claude-activity-lease-parity.test.ts`), which
// feeds one frame sequence into the live driver and into the two reducers and
// compares the two lease sets frame by frame; nothing in production reads it
// yet (convergence is a later task). HeldWorkLeaseInput / LeaseDeriverMutations
// are the criterion's own vocabulary — it types its readings with them so an
// assertion cannot pass against a shape this module never produces, and builds
// its false-form arms through the documented mutation seam.
export { deriveHeldWorkLeases } from './services/claude-activity-lease-deriver.service.js';
export type {
  HeldWorkLeaseInput,
  LeaseDeriverMutations,
} from './services/claude-activity-lease-deriver.service.js';
// readSessionTurn: the live phase of one session's turn, as the frame forwarder
// last reduced it. Consumed by the websocket module's activity heartbeat, which
// stamps it onto the activity frames a browser reads — the providers module owns
// the reduction, the websocket module owns the transport, and this is the one
// edge between them. It is keyed by the **app session id** (the id a client
// subscribes with), because that is the one id space the heartbeat has; the
// forwarder feeds the tracker under the same id (`turnSessionId`) so a running
// turn is not reported as `idle`.
export { readSessionTurn } from './list/claude/claude-runtime.provider.js';
// The Task and Schedule read models, as the run loop holds them (AC-194's
// wiring leg). `readSessionTasks` / `readSessionSchedules` are what the activity
// protocol's snapshot carries, `reconcileSessionHeldWork` is what the Stop hook
// feeds, and `setActivityChangeNotifier` is the tick the composition root
// installs so a task or schedule change pushes an `activity.upsert` frame.
export {
  readSessionSchedules,
  readSessionTasks,
  reconcileSessionHeldWork,
  setActivityChangeNotifier,
} from './list/claude/claude-runtime.provider.js';
// readSessionForegroundToolUseId: the `tool_use.id` of the session's currently
// pending foreground tool, or null. Companion to `readSessionTurn` over the same
// Turn Tracker, and the addressing seam AC-197's `chat.background-task` reads —
// the handler accepts a background request only when the requested toolUseId
// equals this, because a foreground tool is not yet a task in the task table.
// Consumed by the websocket module's chat handler and by AC-197's criterion.
export { readSessionForegroundToolUseId } from './list/claude/claude-runtime.provider.js';
export { providerRegistry } from './provider.registry.js';
// providerRoutes: the module's HTTP face. Mounted by `server/index.ts`, and by
// the lifecycle-mode criterion, which has to drive the real
// `PUT /:provider/sessions/:sessionId/lifecycle-mode` route (and read its
// refusals) rather than call the service directly — the route is where the
// transport-level `LIFECYCLE_MODE_UNKNOWN` refusal lives.
export { default as providerRoutes } from './provider.routes.js';
// providerCapabilitiesService: the capability matrix. Exported so the
// lifecycle-mode criterion can print the claude row's `residentFeatures` and
// prove a mode is refused because `lifecycleModes` does not list it, reading
// the same statement the route branches on instead of a copy of it.
export { providerCapabilitiesService } from './services/provider-capabilities.service.js';
// resolveModelLaunchSpec: consumed by the websocket module's shell pty to compile the
// spawn env for the selected custom model.
export { resolveModelLaunchSpec, resolveModelContextWindowRow } from './services/model-launch-spec.service.js';
// LaunchSpecGuards: the compile-path key-filter seam, consumed by the model compile tests.
export type { LaunchSpecGuards } from './services/model-launch-spec.service.js';
// mapCliOptionsToSDK: driven by the passthrough-parity test to prove the SDK env
// stays byte-identical when no configured model is selected.
export { mapCliOptionsToSDK } from './list/claude/claude-runtime.provider.js';
// Token-budget helpers: driven by the token-budget tests to prove the context
// window follows the resolved model entry.
export { extractCumulativeTokenBudget, extractTokenBudget } from './list/claude/claude-runtime.provider.js';
// forwardNormalizedFrames: the normalizer→writer seam, driven by the frame-forwarding
// test with a fake writer to prove every normalized frame (stream_delta included) is
// actually handed over — the half neither the normalizer's tests nor the broadcaster's
// tests can see.
export { forwardNormalizedFrames } from './list/claude/claude-runtime.provider.js';
// requestClientToolDecision: the claude runtime's own approval-request path.
// Consumed by the AC-287 criterion, which arms the real approval ledger through
// it (so `classifyMissingApproval` reads a genuinely held-then-abandoned id as
// `'expired'`) instead of stubbing the distinction it is meant to prove.
export { requestClientToolDecision } from './list/claude/claude-runtime.provider.js';
// describeApprovalPolicy / TOOL_APPROVAL_TIMEOUT_MS: the one derivation of "is
// this request interactive, and does it auto-deny" and the real deadline it
// names. Consumed by the MCP gateway's `approvals_list` / `session_get`
// projections (`mcp-approvals.ts`), which must state those two facts for the
// same request without re-deriving them, and by the pending-interaction
// criterion, which reads the constant to prove the value is injected rather
// than hard-coded.
export { describeApprovalPolicy, TOOL_APPROVAL_TIMEOUT_MS } from './list/claude/claude-runtime.provider.js';
export type { ApprovalPolicy } from './list/claude/claude-runtime.provider.js';
export { createProviderTokenUsageService, summarizeClaudeTokenUsage } from './services/provider-token-usage.service.js';
// ClaudeSessionsProvider: driven by the stream-event unwrap test, which needs the
// normalizer's own class to prove a partial SDK frame reaches the wire as a
// `stream_delta` without a live CLI in the loop.
export { ClaudeSessionsProvider } from './list/claude/claude-sessions.provider.js';
// ClaudeSessionSynchronizer: driven by the websocket module's session-upsert
// broadcast test, which needs the real indexer to put an ai-title on a row
// before asserting the delta that carries it.
export { ClaudeSessionSynchronizer } from './list/claude/claude-session-synchronizer.provider.js';
// readClaudeSessionOccupancy: which conversations a Claude Code background job
// is holding, read whole in one scan of the CLI's own registry. `server/index.ts`
// wires it into the host listing's occupancy seam — the host module cannot reach
// it itself, since providers already imports that one and the edge back would
// close a cycle — and the host-listing criterion points the same reader at a
// registry it owns to count the scans.
export { readClaudeSessionOccupancy } from './list/claude/claude-host-driver.provider.js';
export type { ClaudeSessionOccupancy } from './list/claude/claude-host-driver.provider.js';
// The delivery state channel's two read models (SPEC §7.1): the resident driver's
// ledger projected as the activity snapshot's `deliveries`, and the run identity
// of the turn in flight. `readSessionDeliveries` is the deliberate twin of
// `readSessionTasks` / `readSessionSchedules` — the activity protocol carries it
// exactly as it carries those, and this is the one edge that reads it. Consumed by
// `activity-protocol.service.ts` (through this barrel) and by the AC-383 criterion.
// `lookupResidentDeliveryById` is the same ledger's BY-ID face (SPEC §8.2):
// `run_get`'s delivery arm holds only an id and no session to look it up under, so
// it reads this rather than a per-session list. Consumed by `server/index.ts`'s
// `mcpRunGetDeps` and by the AC-386 criterion.
export {
  DEFAULT_DELIVERY_RETENTION_MS,
  DELIVERY_TERMINAL_LIMIT,
  lookupResidentDeliveryById,
  readSessionDeliveries,
  readSessionTurnRun,
} from './list/claude/claude-host-driver.provider.js';
// The ledger's `processing` predicate and the sessions it says are processing
// (SPEC §4.3, I6). The single writer: the run registry reads these instead of
// deciding from a run's `status`, and every other reader (the
// `/api/providers/sessions/running` route, the heartbeat, the MCP overview, the
// scheduled-message dispatcher) reads the registry. Consumed by
// `chat-run-registry.service.ts` through this barrel — the one edge, since the
// driver cannot import the registry back.
export {
  listProcessingSessions,
  readSessionProcessing,
} from './list/claude/claude-host-driver.provider.js';
export type { ClaudeResidentProcessingReading } from './list/claude/claude-host-driver.provider.js';
// The resident driver and the per-run runtime verbs, for AC-196's criterion
// (`server/modules/websocket/tests/chat-stop-task.test.ts`). That criterion
// lives in the websocket module — the control verb's home — and has to drive the
// real resident driver against a scripted query and the real per-run runtime
// against a scripted instance, so the shapes and verbs it needs are exported
// here rather than reached through a provider's internal path: the module
// boundary lint and the backend module standards both require cross-module
// access to go through this barrel.
export { ClaudeResidentHostDriver } from './list/claude/claude-host-driver.provider.js';
export type {
  ClaudeResidentProcess,
  ClaudeResidentProcessFactory,
  ClaudeResidentQuery,
} from './list/claude/claude-host-driver.provider.js';
export { CLAUDE_PREDEFINED_MODELS } from './list/claude/claude-models.provider.js';
export {
  abortClaudeSDKSession,
  backgroundClaudeSDKTask,
  claudeQueryFactory,
  getActiveClaudeSDKSessions,
  queryClaudeSDK,
  stopClaudeSDKTask,
} from './list/claude/claude-runtime.provider.js';

// Resident scoping: `mapCliOptionsToSDK` installs the spawn hook that puts every
// resident session in its own capped systemd scope inside the shared resident
// slice, and `server/index.ts` sweeps orphaned scopes at start-up and stops this
// server's scopes on shutdown. The session-scope test drives the hook, the
// lifecycle and the failure readings; the process-containment criterion drives
// the slice cap and lands an OOM kill as a host reading.
export {
  createResidentScopeSpawn,
  resolveResidentMemoryMax,
  resolveResidentSliceName,
  resolveResidentSliceMemoryMax,
  resolveResidentScopeSweepEnabled,
  applyResidentSliceMemoryMax,
  readResidentSliceMemoryMax,
  probeSystemdUserScope,
  resetResidentScopeProbeCache,
  buildResidentScopeUnitName,
  parseResidentScopeOwnerPid,
  listResidentScopeUnits,
  stopResidentScopes,
  sweepOrphanResidentScopes,
  detectResidentScopeOomKill,
  DEFAULT_RESIDENT_MEMORY_MAX,
  DEFAULT_RESIDENT_SLICE_NAME,
  DEFAULT_RESIDENT_SLICE_MEMORY_MAX,
} from './services/claude-session-scope.service.js';
export type {
  ResidentScopeSpawnDeps,
  ResidentScopeProcess,
  ResidentScopeSpawnImpl,
} from './services/claude-session-scope.service.js';
// The pre-promotion `claude*` names: still exported because the runtime's
// wiring, `server/index.ts` and the previous criterion import them, and because
// that criterion asserts the contract they name — the generated argv and the
// literal unit-name shape — so a rename that dropped them would be a silent
// break dressed as a refactor.
export {
  createClaudeSessionScopeSpawn,
  resolveClaudeSessionMemoryMax,
  resetClaudeSessionScopeProbeCache,
  buildClaudeSessionScopeUnitName,
  parseClaudeSessionScopeOwnerPid,
  listClaudeSessionScopeUnits,
  stopClaudeSessionScopes,
  sweepOrphanClaudeSessionScopes,
  DEFAULT_CLAUDE_SESSION_MEMORY_MAX,
} from './services/claude-session-scope.service.js';
export type {
  ClaudeSessionScopeSpawnDeps,
  SessionScopeProcess,
  SessionScopeSpawnImpl,
} from './services/claude-session-scope.service.js';
