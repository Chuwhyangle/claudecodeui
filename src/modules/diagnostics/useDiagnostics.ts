import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import { api } from '@/shared/api';

import {
  createDiagnosticsController,
  type DiagnosticsApi,
  type DiagnosticsSnapshot,
} from '@/modules/diagnostics/diagnosticsController';

/**
 * The React binding over `createDiagnosticsController`.
 *
 * The hook is deliberately thin: it creates one controller per mounted tab,
 * subscribes to its snapshot, starts the first load and disposes it on unmount.
 * Every rule (parallel reads, stale-answer guards, copy state) lives in the
 * controller, so this file holds no business logic.
 *
 * `api` and `writeClipboard` are injectable so the Settings-tab criterion can
 * drive the real component without a network or a browser clipboard. Production
 * passes neither and gets the shared API client and `navigator.clipboard`.
 *
 * Consumers: `DiagnosticsSettingsTab` and the diagnostics Settings-tab criterion.
 */

/** The browser clipboard writer; stable so the controller is created once per mount. */
const defaultWriteClipboard = (text: string): Promise<void> => navigator.clipboard.writeText(text);

/** The production API: the endpoint map's diagnostics group. */
const defaultDiagnosticsApi: DiagnosticsApi = {
  features: () => api.diagnostics.features(),
  recentFailures: (limit) => api.diagnostics.recentFailures(limit),
  bundle: () => api.diagnostics.bundle(),
};

export type UseDiagnosticsOptions = {
  api?: DiagnosticsApi;
  writeClipboard?: (text: string) => Promise<void>;
  recentFailuresLimit?: number;
};

/** The controller's commands plus its snapshot, as the tab receives them. */
export type UseDiagnosticsResult = {
  snapshot: DiagnosticsSnapshot;
  refresh: () => void;
  copyBundle: () => void;
  resetCopyState: () => void;
};

export function useDiagnostics(options: UseDiagnosticsOptions = {}): UseDiagnosticsResult {
  const diagnosticsApi = options.api ?? defaultDiagnosticsApi;
  const writeClipboard = options.writeClipboard ?? defaultWriteClipboard;
  const limit = options.recentFailuresLimit;

  const controller = useMemo(
    () => createDiagnosticsController({
      api: diagnosticsApi,
      writeClipboard,
      ...(limit === undefined ? {} : { recentFailuresLimit: limit }),
    }),
    [diagnosticsApi, writeClipboard, limit],
  );

  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  useEffect(() => {
    controller.load();
    return () => controller.dispose();
  }, [controller]);

  // The commands are stable for the controller's lifetime; binding them here
  // keeps the returned object identity stable across renders.
  const refresh = useCallback(() => controller.load(), [controller]);
  const copyBundle = useCallback(() => controller.copyBundle(), [controller]);
  const resetCopyState = useCallback(() => controller.resetCopyState(), [controller]);

  return {
    snapshot,
    refresh,
    copyBundle,
    resetCopyState,
  };
}
