/**
 * Observation module — barrel.
 *
 * The unified model every producer writes and the cockpit reads: `ObservedObject`, the
 * append-only revision log behind the delta API, the per-user seen cursor and watch list, the
 * producer-liveness reading that keeps a quiet wall honest, and the local UI view-event log
 * (`POST /api/observation/view-events` → `~/.cloudcli/ui-view-events.jsonl`).
 *
 * `server/index.ts` mounts `createObservationModule` under `/api/observation`; the producer
 * tasks (session digest, project truth, architecture delta) import `createObservationStore`
 * through this same door. Nothing outside deep-imports an internal file.
 */
// consumer: server/index.ts (mounts the router under /api/observation)
export { createObservationModule } from './observation.module.js';
export type { ObservationModuleDeps } from './observation.module.js';
// consumer: the producer tasks (session-digest / project-truth / architecture-delta), which
// write revisions through the store rather than re-implementing the model
export { createObservationStore, DEFAULT_OBSERVATION_WALL_LIMIT } from './observation-store.js';
export type {
  ObservationStatusState,
  ObservationStore,
  ObservationStoreDeps,
  ObservationUpdateFrame,
  ObservationWall,
  ObservationWallEntry,
  ObservationWallSelf,
  ObservedObject,
  ObservedProvenance,
  ObservedRevision,
  ObservedStatus,
  SeenCursor,
  WatchEntry,
  WriteObservationInput,
} from './observation-store.js';
// consumer: server/modules/observation/observation.routes.ts and the producer tasks, which
// spell an object's address with the same formatter they parse it with
export {
  formatArchitectureUri,
  formatObservationUri,
  formatProjectUri,
  formatSessionUri,
  parseObservationUri,
} from './observation-uri.js';
export type { ObservationKind, ObservationUri } from './observation-uri.js';
// consumer: server/modules/observation/observation-store.ts (the wall's producers[]) and the
// producer-liveness criterion
export {
  evaluateProducer,
  PRODUCER_STALE_MULTIPLIER,
} from './producer-liveness.js';
export type {
  ProducerHeartbeat,
  ProducerLivenessState,
  ProducerReading,
} from './producer-liveness.js';
// consumer: server/modules/settings/server-settings.ts, which fills the shipped
// `observation.viewEvents` block and must not re-spell the default path or switch
export {
  DEFAULT_VIEW_EVENTS_ENABLED,
  defaultViewEventsPath,
} from './view-events.service.js';
export type { ViewEventsSettings } from './view-events.service.js';
