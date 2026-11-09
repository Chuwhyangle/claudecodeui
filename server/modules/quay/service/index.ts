// The quay module's COMPOSITION concern: the public `createQuayService` factory and the three
// stateful factories it builds (snapshot read, compact task index, fleet summary). Every cache,
// in-flight promise map and rate limiter lives inside one of those factory closures — the
// returned object is the lifecycle owner — so no module-scope mutable binding exists here.
// Edges run `service -> {read, fleet, task, cli}`; nothing imports the package root back.
//
// Consumers: `quay.module.ts` (the one process-wide instance), `quay.routes.ts` (the router's
// service parameter type) and the module barrel.
export { createQuayService } from './quay.service.js';
export type { QuayServiceDependencies, QuaySnapshotOptions } from './quay.service.js';
export { createQuayFleetSummaryReader } from './quay-fleet-summary.service.js';
export type {
  QuayFleetSummaryDependencies,
  QuayFleetSummaryReader,
} from './quay-fleet-summary.service.js';
export {
  createGanttCollector,
  createQuaySnapshotReader,
  createSuiteFanInCache,
} from './quay-snapshot-read.service.js';
export type {
  GanttCollector,
  QuaySnapshotReader,
  QuaySnapshotReaderOptions,
  RunQuayCommand,
  SuiteFanInReader,
} from './quay-snapshot-read.service.js';
export { createQuayTaskIndex } from './quay-task-index.service.js';
export type { QuayTaskIndex, QuayTaskIndexDependencies } from './quay-task-index.service.js';
