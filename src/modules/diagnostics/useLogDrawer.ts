import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { api } from '@/shared/api';

import {
  createLogDrawerController,
  type LogDrawerApi,
  type LogDrawerController,
  type LogDrawerSnapshot,
} from '@/modules/diagnostics/logDrawerController';

/**
 * The React binding over `createLogDrawerController`.
 *
 * Deliberately thin: one controller per mount, `useSyncExternalStore` for the
 * snapshot, disposal on unmount and the controller's own commands passed
 * through. Every rule (polling only while open, stale-answer guards, filters,
 * copy state) lives in the controller.
 *
 * `api` and `writeClipboard` are injectable so the drawer criterion can drive
 * the real components without a network or a browser clipboard.
 *
 * Consumers: `LogDrawerHost`.
 */

const defaultWriteClipboard = (text: string): Promise<void> => navigator.clipboard.writeText(text);

/** The production API: the endpoint map's diagnostics group. */
const defaultLogDrawerApi: LogDrawerApi = {
  logs: (filter) => api.diagnostics.logs(filter),
  logSources: () => api.diagnostics.logSources(),
  bundle: () => api.diagnostics.bundle(),
};

export type UseLogDrawerOptions = {
  api?: LogDrawerApi;
  writeClipboard?: (text: string) => Promise<void>;
  pollIntervalMs?: number;
};

/** The controller's commands plus its snapshot, as the host receives them. */
export type UseLogDrawerResult = {
  snapshot: LogDrawerSnapshot;
  controller: LogDrawerController;
};

export function useLogDrawer(options: UseLogDrawerOptions = {}): UseLogDrawerResult {
  const logApi = options.api ?? defaultLogDrawerApi;
  const writeClipboard = options.writeClipboard ?? defaultWriteClipboard;
  const pollIntervalMs = options.pollIntervalMs;

  const controller = useMemo(
    () => createLogDrawerController({
      api: logApi,
      writeClipboard,
      ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
    }),
    [logApi, writeClipboard, pollIntervalMs],
  );

  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  useEffect(() => () => controller.dispose(), [controller]);

  return { snapshot, controller };
}
