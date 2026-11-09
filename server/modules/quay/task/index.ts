// The quay module's TASK-VERB concern: the `--help` capability probe, the `task log` carriers
// (pure readers, the persisted cursor store) and the fs.watch-driven incremental refresh. The
// subpackage's only outward imports are `read/` (the command-port and index vocabulary it types
// itself against) and `cli/` transitively, so it never points back at the package root.
//
// Consumers: `quay.module.ts` (capability probe + event service), `service/quay.service.ts`
// via the module wiring (the index primitives the event service drives), and the module barrel
// (`quayTaskEvents`).
export { createQuayCapabilities } from './quay-capabilities.js';
export type {
  QuayCapabilities,
  QuayCapabilityDependencies,
  QuayCapabilityReader,
  QuayEntrypointIdentity,
  QuayVerbCapability,
} from './quay-capabilities.js';
export { createQuayTaskEvents } from './quay-task-events.service.js';
export type { QuayTaskEventsService } from './quay-task-events.service.js';
export {
  readTaskLogCursor,
  readTaskLogPage,
  transitionOrder,
} from './quay-task-log-parse.js';
export type {
  QuayDirWatcher,
  QuayTaskEventsDependencies,
  QuayTaskEventsTimers,
  QuayTaskLogCursor,
  QuayTaskLogPage,
  QuayTaskStatusTransition,
} from './quay-task-log-parse.js';
export { createTaskLogCursorStore } from './quay-task-log-cursor-store.js';
export type {
  QuayTaskEventsMonitor,
  QuayTaskEventsMonitorState,
  QuayTaskLogCursorSeed,
  QuayTaskLogCursorStore,
  QuayTaskLogCursorStoreDependencies,
  QuayTaskLogPollOutcome,
} from './quay-task-log-cursor-store.js';
