/**
 * Liaison module — the M3 delivery mechanism's one door.
 *
 * `createLiaisonModule` is the composition entry `server/index.ts` builds once and mounts at
 * `/api/liaison`; `createFileLiaisonStore` is the disk-backed initiative inbox + delivery log
 * the same composition root hands it; the service and store factories are exported so the
 * criterion can drive the REAL code over stubbed seams rather than a reimplementation.
 *
 * The module imports node builtins, `server/shared/**` and itself only — no sibling feature
 * module — which is why `modules/liaison` is a registered leaf in AC-394's directory manifest
 * (`server/shared/tests/server-import-cycle-budget.baseline.json`).
 */
// consumer: server/index.ts (builds the module, mounts its router, forwards recoveries)
export { createLiaisonModule, createQuayFleetRunner } from './liaison.module.js';
export type { LiaisonModule, LiaisonModuleDeps } from './liaison.module.js';
// consumer: server/index.ts (the disk-backed initiative inbox and delivery log)
export { createFileLiaisonStore } from './liaison-store.js';
// consumer: tests/liaison-deliver.test.ts (the real service + store over its own stubs)
export {
  createLiaisonDeliveryService,
  createMemoryLiaisonStore,
  initiativeUri,
  liaisonMessageContent,
  liaisonPrefix,
  resolveLiaisonSession,
} from './liaison-deliver.service.js';
export type {
  LiaisonAddress,
  LiaisonDeliverDeps,
  LiaisonDeliverInput,
  LiaisonDeliveryMark,
  LiaisonDeliveryOutcome,
  LiaisonDeliveryRecord,
  LiaisonDeliveryService,
  LiaisonFleetResult,
  LiaisonFleetRun,
  LiaisonInboxCause,
  LiaisonInboxEntry,
  LiaisonRecoveryOutcome,
  LiaisonRegistryReading,
  LiaisonSendInput,
  LiaisonSendMessage,
  LiaisonSendResult,
  LiaisonStore,
} from './liaison-deliver.service.js';
