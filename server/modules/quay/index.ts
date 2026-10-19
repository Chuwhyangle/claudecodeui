// quayRoutes: mounted by the server entrypoint behind auth (read-only display endpoints).
// quayService: consumed by the projects module to attach Tier-1 `.quay/config.yml` detection
// to its listing without starting a subprocess. Its `getCachedSnapshot(projectId)` is
// consumed by the MCP gateway's `overview` tool (AC-247): the read-only path that returns a
// TTL-cached snapshot or `null` WITHOUT loading, so `overview` over N projects spawns zero
// `quay` CLI processes. `getQuaySnapshot(projectId, { forceRefresh: true })` remains the
// load-on-demand path the `quay_snapshot` tool's explicit refresh uses.
export { quayRoutes, quayService } from './quay.module.js';
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
