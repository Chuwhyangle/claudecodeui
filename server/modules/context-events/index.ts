/**
 * Context-events module — barrel.
 *
 * The one public surface of the host-level context ledger. `server/index.ts`
 * records through the process instance; `server/modules/quay/quay.module.ts`
 * reads its status for the fleet-summary response; the criteria compose a stream
 * with `createContextEvents`. Nothing else may deep-import this directory.
 */
// consumer: server/index.ts (records utterances/chips/cockpit events), quay.module.ts (status reading)
export {
  CHIP_SOURCE_WINDOW_MS,
  contextEvents,
  createContextEvents,
  readContextEventStatus,
} from './context-events.module.js';
export type {
  ContextEventRecord,
  ContextEvents,
  ContextEventsOptions,
  ReplySuggestionsUsageRecord,
} from './context-events.module.js';
// consumer: the shadow-prediction report and the wiring's producer table
export {
  CLOUDCLI_CONTEXT_EVENT_KINDS,
  CONTEXT_EVENT_MAX_LINE_BYTES,
  createContextEventWriter,
} from './context-event-writer.js';
export type {
  AppendContextEventResult,
  CloudCliContextEventKind,
  ContextEventDraft,
  ContextEventWriter,
  ContextEventWriterStatus,
} from './context-event-writer.js';
// consumer: shadow-prediction-report.mjs (through a JSON dump), and the classifier criterion
export { classifyUtterance, LADDER_BASELINE, UTTERANCE_CLASSES } from './utterance-classifier.js';
export type { LadderLevel, UtteranceClass } from './utterance-classifier.js';
// consumer: the report's transition backfill, and the predictor criterion
export { createShadowPredictor, SHADOW_PREDICTION_METHOD } from './shadow-predictor.js';
export type {
  ShadowFlow,
  ShadowPrediction,
  ShadowPredictionOutcome,
  ShadowPredictor,
  TransitionTable,
} from './shadow-predictor.js';
