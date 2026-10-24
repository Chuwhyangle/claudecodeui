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
export { quayFleetRegistry, quayInitiatives, quayRoutes, quayService } from './quay.module.js';
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
  createQuayService,
  isReadOnlyQuayCommand,
  QUAY_FLEET_SUMMARY_MAX_CONCURRENT_PROJECTS,
  QUAY_FLEET_SUMMARY_TTL_MS,
  QUAY_TASK_INDEX_MAX_CONCURRENT_LOADS,
  QUAY_TASK_INDEX_MAX_STDOUT_BYTES,
  QUAY_TASK_INDEX_MIN_INTERVAL_MS,
  QUAY_TASK_INDEX_TITLE_LIMIT,
  QUAY_TASK_INDEX_TTL_MS,
} from './quay.service.js';
export type {
  QuayCommandResult,
  QuayCommandRunner,
  QuayDriverState,
  QuayDriverSummary,
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
  /** Consumed by the MCP gateway's `changes` tool: one project's full-coverage status index, read without loading. */
  QuayTaskIndexReading,
  QuayTaskIndexState,
  QuayTaskStatusRow,
} from './quay.service.js';
