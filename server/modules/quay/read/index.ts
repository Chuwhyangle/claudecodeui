// The quay module's READ concern: the injected read boundaries, the exact-match read-only
// command whitelist, the gantt/lanes parser, the summarizers, the local `.quay/` carrier
// readers, the Loop status projection, the dashboard-link carrier readers, and the
// suite/fan-in + entrypoint + wall-URI readers. Edges run `read -> cli`; the subpackage never
// imports the package root or `fleet`/`service`, so the directory graph stays acyclic.
//
// Consumers: `service/` (the snapshot and fleet-summary factories), the module barrel (the
// vocabulary AC-247/AC-348/AC-394 criteria type themselves against), and `quay.module.ts` via
// the read primitives it binds.
export type {
  QuayCommandFailureKind,
  QuayCommandResult,
  QuayCommandRunner,
  QuayFileReader,
} from './quay-command-port.js';
export {
  DEFAULT_QUAY_GANTT_WINDOW_HOURS,
  QUAY_GANTT_WINDOW_HOURS,
  QUAY_LANES_PREFIX,
  QUAY_READ_ONLY_COMMANDS,
  isReadOnlyQuayCommand,
  normalizeGanttWindowHours,
  readGanttLanes,
} from './quay-read-verbs.js';
export {
  QUAY_FLEET_SUMMARY_MAX_CONCURRENT_PROJECTS,
  QUAY_FLEET_SUMMARY_TTL_MS,
  QUAY_TASK_INDEX_MAX_CONCURRENT_LOADS,
  QUAY_TASK_INDEX_MAX_STDOUT_BYTES,
  QUAY_TASK_INDEX_MIN_INTERVAL_MS,
  QUAY_TASK_INDEX_TITLE_LIMIT,
  QUAY_TASK_INDEX_TTL_MS,
} from './quay-snapshot-types.js';
export type {
  QuayContextEventsStatus,
  QuayFleetProjectSummary,
  QuayFleetSummary,
  QuayFleetTaskCounts,
  QuayLanesReading,
  QuayProjectStatus,
  QuayPulseSummary,
  QuayTaskIndexReading,
  QuayTaskIndexState,
  QuayTaskStatusRow,
} from './quay-snapshot-types.js';
export { summarizeBlockers } from './quay-blockers-summary.js';
export type { QuayBlockerSummary } from './quay-blockers-summary.js';
export { createQuayEntrypointResolver } from './quay-entrypoint-resolver.js';
export type {
  QuayEntrypointFileStat,
  QuayEntrypointFileSystem,
  QuayEntrypointResolution,
  QuayEntrypointResolver,
  QuayEntrypointResolverDependencies,
} from './quay-entrypoint-resolver.js';
export { QUAY_FAN_IN_READ_COMMAND, QUAY_SUITE_READ_COMMAND, readQuaySuiteAndFanIn } from './quay-suite-fanin-reader.js';
export type { QuaySuiteFanInReading, QuayVerbResult, QuayVerbRunner } from './quay-suite-fanin-reader.js';
export {
  QUAY_FLEET_BIN_ENV,
  QUAY_OBJECT_TYPES,
  createQuayFleetCliWallReader,
  createQuayUriResolver,
} from './quay-uri-resolve.js';
export type {
  QuayFleetL1,
  QuayFleetL2,
  QuayFleetSummaryReading,
  QuayFleetSummaryRefusal,
  QuayFleetWallReader,
  QuayObjectType,
  QuayUriAddress,
  QuayUriErrorCode,
  QuayUriFailure,
  QuayUriFallbackReason,
  QuayUriFleetProject,
  QuayUriRejection,
  QuayUriResolveDependencies,
  QuayUriResolveResult,
  QuayUriResolveSuccess,
  QuayUriResolver,
  QuayUriSnapshotTask,
  QuayUriSnapshotTasks,
  QuayUriSource,
  QuayUriSummaryResult,
  QuayUriSummarySuccess,
} from './quay-uri-resolve.js';
