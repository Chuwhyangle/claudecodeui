/**
 * Diagnostics module — barrel.
 *
 * The Settings → Diagnostics & Logs surface's read-only backend: feature health,
 * the recent failure list and the redacted plain-text bundle. The module is a
 * leaf (it imports only `server/shared/**` and itself); `server/index.ts` builds
 * one provider per feature and injects them, so this module never imports a
 * sibling feature module.
 *
 * Consumer: `server/index.ts`, which mounts `createDiagnosticsModule` under
 * `/api/diagnostics` behind `authenticateToken`. Nothing else may deep-import
 * this directory.
 */
// consumer: server/index.ts (mounts the returned router under /api/diagnostics)
export { createDiagnosticsModule } from './diagnostics.module.js';
export type { DiagnosticsModuleDeps } from './diagnostics.module.js';
// consumer: server/index.ts (types the provider adapters it builds) and the
// diagnostics service criterion, which drives the aggregation over literals.
export {
  clampRecentFailuresLimit,
  createDiagnosticsService,
  DEFAULT_RECENT_FAILURES_LIMIT,
  MAX_RECENT_FAILURES_LIMIT,
  redactDiagnosticsText,
  resolveDiagnosticsFeatureState,
} from './diagnostics.service.js';
export type {
  DiagnosticsBundleInput,
  DiagnosticsFailure,
  DiagnosticsFailureRecord,
  DiagnosticsFeature,
  DiagnosticsFeatureProvider,
  DiagnosticsFeatureReading,
  DiagnosticsFeatureState,
  DiagnosticsMeta,
  DiagnosticsService,
  DiagnosticsServiceDeps,
} from './diagnostics.service.js';
// consumer: the route criterion, which pins `?limit=` clamping without HTTP.
export { readRecentFailuresLimit } from './diagnostics.routes.js';
