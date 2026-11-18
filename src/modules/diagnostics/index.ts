/**
 * Diagnostics module — barrel.
 *
 * The Settings → Diagnostics & Logs feature's frontend: the React-free
 * controller, its hook, the health cards and the recent-failures table.
 *
 * CONSUMER: `src/modules/settings/tabs/DiagnosticsSettingsTab.tsx` (and the
 * Settings-tab criterion). The dependency direction is one-way — settings may
 * import diagnostics; diagnostics must not import settings.
 */
export { default as DiagnosticsHealthList } from '@/modules/diagnostics/DiagnosticsHealthList';
export { default as RecentFailuresTable } from '@/modules/diagnostics/RecentFailuresTable';
export { useDiagnostics } from '@/modules/diagnostics/useDiagnostics';
export type { UseDiagnosticsOptions, UseDiagnosticsResult } from '@/modules/diagnostics/useDiagnostics';
export {
  createDiagnosticsController,
  DIAGNOSTICS_RECENT_FAILURES_LIMIT,
} from '@/modules/diagnostics/diagnosticsController';
export type {
  DiagnosticsApi,
  DiagnosticsController,
  DiagnosticsControllerDeps,
  DiagnosticsCopyState,
  DiagnosticsSnapshot,
} from '@/modules/diagnostics/diagnosticsController';
