// quayRoutes: mounted by the server entrypoint behind auth (read-only display endpoints).
// quayService: consumed by the projects module to attach Tier-1 `.quay/config.yml` detection
// to its listing without starting a subprocess. Its `getCachedSnapshot(projectId)` is
// consumed by the MCP gateway's `overview` tool (AC-247): the read-only path that returns a
// TTL-cached snapshot or `null` WITHOUT loading, so `overview` over N projects spawns zero
// `quay` CLI processes. `getQuaySnapshot(projectId, { forceRefresh: true })` remains the
// load-on-demand path the `quay_snapshot` tool's explicit refresh uses.
// quayFleetRegistry: the fleet's per-project 「对人接口会话」 pin, read/written by the cockpit
// hub's target resolver (injected at the composition root, so the cockpit module itself stays
// a leaf). It maps a Cloudpit project id to the fleet registry id and answers failures as
// values rather than throwing.
// quayCapabilities / quayDispatchCarrier / quayTaskEvents: the event-driven refresh's three
// composed pieces. `quayCapabilities` answers whether a project's pinned quay has `task log`;
// `quayDispatchCarrier` is the read-only `.quay/worker-dispatch.json` reader; `quayTaskEvents`
// is the `fs.watch`-triggered incremental refresh (the TTL full read is unchanged).
export {
  quayCapabilities,
  quayDispatchCarrier,
  quayFleetProjectIds,
  quayFleetRegistry,
  quayInitiatives,
  quayRoutes,
  quayService,
  quayTaskEvents,
} from './quay.module.js';
// The fleet binary locator: the composition root (`server/index.ts`) injects this ONE lookup
// (QUAY_FLEET_BIN → PATH → ~/.quay-fleet/bin) into the liaison module rather than letting it
// grow a second order; the in-module consumers live in `cli/`, and every other subpackage
// reaches them through that subpackage's own files. Exported here because cross-module access
// goes through the module's index, never an internal file.
export { locateQuayFleetCli } from './cli/index.js';
// createQuayFleetRunner: the "resolve the binary → fixed miss reading → execute" seam. The
// cockpit's fleet card provider lives in a leaf module and cannot import this module, so the
// composition root (`server/cockpit-fleet-wiring.ts`) binds the real runner there.
export { createQuayFleetRunner } from './cli/index.js';
export type {
  QuayFleetCommandResult,
  QuayFleetRunner,
  QuayFleetRunnerOptions,
} from './cli/index.js';
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
} from './fleet/index.js';
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
} from './fleet/index.js';
export type {
  QuayFleetInterfaceSessionReading,
  QuayFleetInterfaceSessionWrite,
  QuayFleetRegistryService,
} from './fleet/index.js';
// createQuayService: the factory the composition root (`quay.module.ts`) calls,
// re-exported so a criterion can compose the REAL service with injected adapters
// rather than reimplementing its index, its budget or its rate limit.
export { createQuayService } from './service/index.js';
export {
  createQuayFleetLivenessReader,
  QUAY_FLEET_LIVENESS_DEFAULT_STALE_AFTER_SEC,
  QUAY_FLEET_LIVENESS_TIMEOUT_MS,
} from './fleet/index.js';
export {
  isReadOnlyQuayCommand,
  QUAY_FLEET_SUMMARY_MAX_CONCURRENT_PROJECTS,
  QUAY_FLEET_SUMMARY_TTL_MS,
  QUAY_TASK_INDEX_MAX_CONCURRENT_LOADS,
  QUAY_TASK_INDEX_MAX_STDOUT_BYTES,
  QUAY_TASK_INDEX_MIN_INTERVAL_MS,
  QUAY_TASK_INDEX_TITLE_LIMIT,
  QUAY_TASK_INDEX_TTL_MS,
} from './read/index.js';
// createSessionMentionsService: the session → mentions reader (the prose's task/goal ids,
// joined against the store). Re-exported so a criterion can drive it with stubs.
export {
  createSessionMentionsService,
  mentionTokens,
} from './session-mentions.service.js';
export type {
  SessionMentionGoalReading,
  SessionMentionsDependencies,
  SessionMentionsGoalRow,
  SessionMentionsReading,
  SessionMentionsService,
  SessionMentionsTaskRow,
  SessionMentionsTranscriptState,
  SessionMentionTaskReading,
} from './session-mentions.service.js';
export type {
  QuayAdrCounts,
  QuayBlockerSummary,
  QuayConfigIssueCounts,
  QuayDriverState,
  QuayDriverSummary,
  QuayFanInAttemptSummary,
  QuayFanInSummary,
  QuayGanttInterval,
  QuayGanttLanes,
  QuayGanttUnavailableReason,
  QuayGoalBreakdown,
  QuayGoalCounts,
  QuayInFlightPhase,
  QuayInFlightTask,
  QuayListItem,
  QuayLoopDrain,
  QuayLoopKernel,
  QuayLoopOrphan,
  QuayLoopPointer,
  QuayLoopStatus,
  QuayLoopVersionRelation,
  QuaySnapshot,
  QuaySuiteState,
  QuayTaskCounts,
  QuayTestRoundSummary,
  QuayTestsSummary,
} from '@/shared/types.js';
export type {
  QuayCommandFailureKind,
  QuayCommandResult,
  QuayCommandRunner,
  QuayContextEventsStatus,
  QuayFileReader,
  /** Consumed by the sidebar's project-row task badges: one quay project's fleet entry. */
  QuayFleetProjectSummary,
  /** Consumed by `GET /api/quay/fleet-summary`: the eager cross-project reading. */
  QuayFleetSummary,
  /** Consumed by the sidebar's project-row task badges: the five counts it renders. */
  QuayFleetTaskCounts,
  QuayLanesReading,
  QuayProjectStatus,
  QuayPulseSummary,
  QuayTaskIndexReading,
  QuayTaskIndexState,
  QuayTaskStatusRow,
} from './read/index.js';
export type {
  QuayFleetLivenessCommandResult,
  QuayFleetLivenessExec,
  QuayFleetLivenessReader,
  QuayFleetLivenessReaderOptions,
  QuayFleetLivenessReading,
  QuayFleetLivenessState,
  QuayFleetProjectLiveness,
} from './fleet/index.js';
