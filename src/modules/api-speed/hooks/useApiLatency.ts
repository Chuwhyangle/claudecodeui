/**
 * The React binding for the API-speed view.
 *
 * This hook owns NO rules: it creates the controller once, subscribes to its
 * snapshot, and disposes it on unmount. Every decision (stale-answer guard,
 * error retention, auto-probe scheduling) lives in
 * `@/modules/api-speed/utils/apiSpeedController`, which is driven directly by a
 * criterion without React.
 *
 * The transport adapter is a module constant so the controller's identity is
 * stable across renders — a fresh closure per render would re-create the
 * controller and re-issue the first read on every state change.
 *
 * Used by `ApiSpeedPanel`.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { api, readApiJson } from '@/shared/api';
import type {
  ApiLatencyProbeRequest,
  ApiLatencyProbeResult,
  ApiLatencySeries,
} from '@/shared/apiLatencyType';
import {
  createApiSpeedController,
  type ApiSpeedClient,
  type ApiSpeedSnapshot,
} from '@/modules/api-speed/utils/apiSpeedController';

/** The parsed-data transport the controller expects; `readApiJson` owns the envelope. */
const API_SPEED_CLIENT: ApiSpeedClient = {
  series: async (limit) => readApiJson<ApiLatencySeries>(await api.apiLatency.series(limit)),
  probe: async (input) => readApiJson<ApiLatencyProbeResult>(await api.apiLatency.probe(input)),
};

/** The snapshot plus the controller's three commands. */
export type ApiLatencyState = ApiSpeedSnapshot & {
  setAutoProbe: (value: boolean) => void;
  /** Takes one measurement and refreshes the series; the result arrives through the snapshot. */
  probe: (input: ApiLatencyProbeRequest) => Promise<void>;
  reload: () => Promise<void>;
};

/**
 * Subscribes the panel to one controller instance for its mounted lifetime.
 *
 * Used by `ApiSpeedPanel`.
 */
export function useApiLatency(): ApiLatencyState {
  const controller = useMemo(
    () => createApiSpeedController({ client: API_SPEED_CLIENT }),
    [],
  );
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  useEffect(() => {
    controller.start();
    // `stop` cancels the auto-probe timer and drops any late answer, so closing
    // the tab stops billing the gateway.
    return () => controller.stop();
  }, [controller]);

  return {
    ...snapshot,
    setAutoProbe: controller.setAutoProbe,
    probe: controller.probe,
    reload: controller.reload,
  };
}
