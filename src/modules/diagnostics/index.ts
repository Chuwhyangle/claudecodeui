/**
 * Diagnostics module — barrel.
 *
 * The Settings → Diagnostics & Logs feature's frontend: the React-free
 * controllers (page + log drawer), their hooks, the health cards, the
 * recent-failures table and the global log-drawer host.
 *
 * CONSUMER: `src/modules/settings/tabs/DiagnosticsSettingsTab.tsx` (and the
 * Settings-tab criterion). The dependency direction is one-way — settings may
 * import diagnostics; diagnostics must not import settings.
 */
export { default as DiagnosticsHealthList } from '@/modules/diagnostics/DiagnosticsHealthList';
export { default as RecentFailuresTable } from '@/modules/diagnostics/RecentFailuresTable';
export { default as LogDrawerHost } from '@/modules/diagnostics/LogDrawerHost';
export { useDiagnostics } from '@/modules/diagnostics/useDiagnostics';
export type { UseDiagnosticsOptions, UseDiagnosticsResult } from '@/modules/diagnostics/useDiagnostics';
export { useLogDrawer } from '@/modules/diagnostics/useLogDrawer';
export type { UseLogDrawerOptions, UseLogDrawerResult } from '@/modules/diagnostics/useLogDrawer';
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
export {
  createLogDrawerController,
  LOG_DRAWER_MAX_LINES,
  LOG_DRAWER_PAGE_SIZE,
  LOG_DRAWER_POLL_MS,
} from '@/modules/diagnostics/logDrawerController';
export type {
  LogDrawerApi,
  LogDrawerController,
  LogDrawerControllerDeps,
  LogDrawerCopyState,
  LogDrawerSnapshot,
} from '@/modules/diagnostics/logDrawerController';
