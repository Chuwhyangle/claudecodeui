// quayRoutes: mounted by the server entrypoint behind auth (read-only display endpoints).
// quayService: consumed by the projects module to attach Tier-1 `.quay/config.yml` detection
// to its listing without starting a subprocess. Its `getCachedSnapshot(projectId)` is
// consumed by the MCP gateway's `overview` tool (AC-247): the read-only path that returns a
// TTL-cached snapshot or `null` WITHOUT loading, so `overview` over N projects spawns zero
// `quay` CLI processes. `getQuaySnapshot(projectId, { forceRefresh: true })` remains the
// load-on-demand path the `quay_snapshot` tool's explicit refresh uses.
// quayFleetRegistry: the fleet's per-project 「对人接口会话」 pin, read/written by the cockpit
// hub's target resolver (injected at the composition root, so the cockpit module itself stays
// a leaf). It maps a CloudCLI project id to the fleet registry id and answers failures as
// values rather than throwing.
// quayCapabilities / quayDispatchCarrier / quayTaskEvents: the event-driven refresh's three
// composed pieces. `quayCapabilities` answers whether a project's pinned quay has `task log`;
// `quayDispatchCarrier` is the read-only `.quay/worker-dispatch.json` reader; `quayTaskEvents`
// is the `fs.watch`-triggered incremental refresh (the TTL full read is unchanged).
export {
  quayCapabilities,
  quayDispatchCarrier,
  quayFleetRegistry,
  quayInitiatives,
  quayRoutes,
  quayService,
  quayTaskEvents,
} from './quay.module.js';
// createQuayInitiatives: the composition seam the initiative/decision-queue criterion drives
// with an injected exec, and the factory a test uses to read a temp fleet home without a CLI.
export {
  createQuayInitiatives,
  DEFAULT_INITIATIVE_AUDIT_RATIO,
  FLEET_INITIATIVE_URI_PREFIX,
  INITIATIVE_DECISION_CATEGORY,
  initiativeSlugFromEntity,
  initiativeUri,
  questionFromAttention,
  resolveFleetHome,
} from './quay-initiatives.js';
export type {
  InitiativeAuditDecision,
  InitiativeCharterReading,
  InitiativeDecisionInput,
  InitiativeDecisionOption,
  InitiativeDecisionResult,
  InitiativeEdgeKind,
  InitiativeEdgeReading,
  InitiativeMemberReading,
  InitiativeQueueItem,
  InitiativeReading,
  InitiativeReadingAnswer,
  InitiativeReadingDocument,
  InitiativeReadingUnavailable,
  QuayInitiativesService,
} from './quay-initiatives.js';
export type {
  QuayFleetInterfaceSessionReading,
  QuayFleetInterfaceSessionWrite,
  QuayFleetRegistryService,
} from './quay-fleet-registry.js';
// createQuayService: the factory the composition root (`quay.module.ts`) calls,
// re-exported so a criterion can compose the REAL service with injected adapters
// rather than reimplementing its index, its budget or its rate limit.
export {
  createQuayFleetLivenessReader,
  createQuayService,
  isReadOnlyQuayCommand,
  QUAY_FLEET_LIVENESS_DEFAULT_STALE_AFTER_SEC,
  QUAY_FLEET_LIVENESS_TIMEOUT_MS,
  QUAY_FLEET_SUMMARY_MAX_CONCURRENT_PROJECTS,
  QUAY_FLEET_SUMMARY_TTL_MS,
  QUAY_TASK_INDEX_MAX_CONCURRENT_LOADS,
  QUAY_TASK_INDEX_MAX_STDOUT_BYTES,
  QUAY_TASK_INDEX_MIN_INTERVAL_MS,
  QUAY_TASK_INDEX_TITLE_LIMIT,
  QUAY_TASK_INDEX_TTL_MS,
} from './quay.service.js';
// createSessionMentionsService: the session → mentions reader (the prose's task/goal ids,
// joined against the store). Re-exported so a criterion can drive it with stubs.
export {
  createSessionMentionsService,
  mentionTokens,
  readMessageText,
} from './session-mentions.service.js';
export type {
  SessionMentionGoalReading,
  SessionMentionsDependencies,
  SessionMentionsGoalRow,
  SessionMentionsReading,
  SessionMentionsService,
  SessionMentionsTaskRow,
  SessionMentionTaskReading,
  SessionMessageText,
} from './session-mentions.service.js';
export type {
  QuayCommandResult,
  QuayCommandRunner,
  QuayDriverState,
  QuayDriverSummary,
  // Consumed by `server/modules/observation/project-truth.ts`: the project tile's 活性 layer
  // reads the fleet's per-project driver state through this one normalized contract.
  QuayFleetLivenessCommandResult,
  QuayFleetLivenessExec,
  QuayFleetLivenessReader,
  QuayFleetLivenessReaderOptions,
  QuayFleetLivenessReading,
  QuayFleetLivenessState,
  QuayFleetProjectLiveness,
  /** Consumed by the sidebar's project-row task badges: one quay project's fleet entry. */
  QuayFleetProjectSummary,
  /** Consumed by `GET /api/quay/fleet-summary`: the eager cross-project reading. */
  QuayFleetSummary,
  /** Consumed by the sidebar's project-row task badges: the five counts it renders. */
  QuayFleetTaskCounts,
  /** Consumed by the MCP gateway's `quay_snapshot` tool: one task the worker driver reports in flight. */
  QuayInFlightTask,
  QuayProjectStatus,
  QuaySnapshot,
  /** Consumed by the title bar's always-on mini gantt: the lanes-only reading. */
  QuayLanesReading,
  /** Consumed by the MCP gateway's `changes` tool: one project's full-coverage status index, read without loading. */
  QuayTaskIndexReading,
  QuayTaskIndexState,
  QuayTaskStatusRow,
} from './quay.service.js';
