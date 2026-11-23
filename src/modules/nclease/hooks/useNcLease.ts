import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { api, readApiJson } from '@/shared/api';
import { usePageVisible } from '@/shared/hooks/usePageVisibility';
import type { NcLeaseInstance, NcLeaseStatus } from '@/shared/ncLeaseType';
import { createNcLeaseController } from '@/modules/nclease/utils/ncLeaseController';

/** The reading the sidebar row and its panel render. */
export type NcLeaseState = {
  /** The last successful ledger reading, or `null` before the first one. */
  status: NcLeaseStatus | null;
  /** The most recent failure, reported beside the last good reading. */
  error: string | null;
  /** True until the first reading has settled. */
  isLoading: boolean;
  /** Slot currently being released, so its button can show the pending state. */
  releasing: NcLeaseInstance['id'] | null;
  release: (slot: NcLeaseInstance['id']) => Promise<void>;
  reload: () => Promise<void>;
};

/**
 * Binds the sidebar's NC-lease controller to React.
 *
 * Every rule — the poll cadence, the dropped-superseded-reply guard, keeping the
 * last good reading across a failure, and pausing while the tab is hidden — lives
 * in `createNcLeaseController`; this hook only subscribes to its snapshot and
 * hands it the page-visibility reading.
 *
 * Used by `NcLeaseIndicator`.
 */
export function useNcLease(): NcLeaseState {
  const visible = usePageVisible();
  const controller = useMemo(
    () => createNcLeaseController({
      fetchStatus: () => api.nclease.status(),
      fetchRelease: (input) => api.nclease.release(input),
      readJson: readApiJson,
    }),
    [],
  );
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  useEffect(() => {
    // Visibility first: a hidden mount must not perform the first read, and the
    // controller's own default is "visible".
    controller.setVisible(visible);
    if (visible) controller.start();
    return () => controller.stop();
  }, [controller, visible]);

  return {
    status: snapshot.status,
    error: snapshot.error,
    isLoading: snapshot.isLoading,
    releasing: snapshot.releasing,
    release: controller.release,
    reload: controller.reload,
  };
}
