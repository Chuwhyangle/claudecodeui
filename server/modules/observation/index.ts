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
// consumer: server/modules/websocket/services/chat-run-registry.service.ts, which fires the
// producer once per terminal run event; the criterion can build its own instance over an
// injected clock and transcript reader. `sessionDigestProducer` is the COMPOSED producer: the
// deterministic write, then the bounded LLM tier, so the registry keeps calling one verb.
export { createSessionDigestProducer, SESSION_DIGEST_PRODUCER } from './session-digest.producer.js';
export type {
  SessionDigestProducer,
  SessionDigestProducerDeps,
  SessionTurnEndEvent,
} from './session-digest.producer.js';
// consumer: the run registry, which keeps calling ONE producer per terminal run event; the
// composed value there is the deterministic write plus the bounded LLM tier. The tier's
// factory, constants and settings helper stay out of the barrel: the tier criterion imports
// them from their own files, and nothing else may reach the tier's knobs.
export { sessionDigestProducer } from './session-digest-llm.js';
export type {
  SessionActivity,
  SessionDigest,
  SessionDigestResult,
  SessionTestReading,
  SessionTestRunner,
} from './session-digest.js';
// consumer: the composition root, which refreshes each fleet-registered project on the quay
// snapshot's TTL and on task-status transitions; and `observation-wall-ui`, which renders the
// five layers. The criterion builds its own producer over an injected clock and readers.
export {
  createProjectTruthProducer,
  createCheckDeployFreshnessReader,
  PROJECT_TRUTH_PRODUCER,
  PROJECT_TRUTH_REFRESH_MS,
} from './project-truth.producer.js';
export type {
  ProjectTruthDeployExec,
  ProjectTruthDeployExecResult,
  ProjectTruthProducer,
  ProjectTruthProducerDeps,
} from './project-truth.producer.js';
export {
  buildProjectTruth,
  PROJECT_TRUTH_NOT_APPLICABLE_REASON,
} from './project-truth.js';
export type {
  ProjectDeployLayer,
  ProjectInflightLayer,
  ProjectLandedLayer,
  ProjectLandedTask,
  ProjectLivenessLayer,
  ProjectTruthBoardReading,
  ProjectTruthDeployReading,
  ProjectTruthDeployTarget,
  ProjectTruthDigest,
  ProjectTruthGoalGateRow,
  ProjectTruthInFlightTask,
  ProjectTruthLayers,
  ProjectTruthProjectRef,
  ProjectTruthReading,
  ProjectTruthTaskRow,
  ProjectVerificationEntry,
  ProjectVerificationLayer,
} from './project-truth.js';
// consumer: the observation composition root (refreshes each registered project on a landing,
// throttled hourly by the producer itself) and `observation-wall-ui`, which renders the
// architecture tile's diff sentences. The criterion builds its own producer over an injected
// snapshot reader and clock.
export {
  createArchitectureDeltaProducer,
  ARCHITECTURE_DELTA_PRODUCER,
  ARCHITECTURE_DELTA_REFRESH_MS,
} from './architecture-delta.producer.js';
export type {
  ArchitectureDeltaProducer,
  ArchitectureDeltaProducerDeps,
  ArchitectureDeltaTarget,
} from './architecture-delta.producer.js';
export {
  ARCHITECTURE_GROWTH_TOP_N,
  ARCHITECTURE_SIZE_CALIBER,
  diffArchitectureStructures,
  readStructureSnapshot,
} from './architecture-delta.js';
export type {
  ArchitectureDiffPackageEdge,
  ArchitectureGrowthRow,
  ArchitectureStructuralDiff,
} from './architecture-delta.js';
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
