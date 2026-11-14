/**
 * The architecture tab's manual re-analysis hook: the React binding for
 * {@link createArchitectureRefreshController}.
 *
 * Every rule — the activation read, the coalesced start, the observed-running
 * and once-per-job success delivery, the poll cadence and the elapsed ticker —
 * lives in the controller. This hook subscribes to its snapshot with
 * `useSyncExternalStore` and forwards the parent's success callback.
 *
 * The subscription IS the lifecycle: the controller arms its activation read and
 * timers on the first subscriber and stops them when the last one leaves, which
 * is also why React 18's StrictMode teardown-and-reset leaves the tab working.
 *
 * Consumers: `ArchitecturePanel.tsx` (the footer entry, the confirmation dialog
 * and the post-success reload/fit), `ArchitectureRefreshDialog.tsx` (the elapsed
 * formatter) and `tests/useArchitectureRefresh.test.tsx`.
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import { api } from '@/shared/api';
import {
  createArchitectureRefreshController,
} from '@/modules/architecture/render/viewport/architectureRefreshController';
import type { ArchitectureRefreshStatus } from '@/shared/types';

export type {
  ArchitectureRefreshStage,
  ArchitectureRefreshStartResult,
  ArchitectureRefreshState,
  ArchitectureRefreshStatus,
} from '@/shared/types';

/** How to run the controller's success delivery and poll cadence. */
type UseArchitectureRefreshOptions = {
  /**
   * Called once when a job this tab watched running reaches `succeeded`. The
   * panel resets its unresolved-name reconciliation, refetches the graph and
   * fits the drawing from here.
   */
  readonly onSucceeded?: (status: ArchitectureRefreshStatus) => void;
  /** Poll cadence for a running job; a test may shorten it. */
  readonly pollIntervalMs?: number;
};

/** The reading and the one command the panel drives. */
type UseArchitectureRefreshResult = {
  readonly status: ArchitectureRefreshStatus;
  /** Live elapsed time for a running job (ticks once a second), else the server's reading. */
  readonly elapsedMs: number;
  /** True while the POST itself is in flight (the dialog keeps its button disabled). */
  readonly starting: boolean;
  /** A transport/refusal error from the start POST or the status GET, if any. */
  readonly requestError: string | null;
  /** Starts the whole-project re-analysis; inert while one is already running. */
  readonly start: () => void;
};

/** `m:ss` (or `h:mm:ss` past an hour), used by the footer and the dialog. */
export function formatRefreshElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3_600);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return hours > 0 ? `${String(hours)}:${pad(minutes)}:${pad(seconds)}` : `${String(minutes)}:${pad(seconds)}`;
}

/**
 * Loads, polls and starts the project's manual re-analysis.
 *
 * Consumers: `ArchitecturePanel.tsx` and `tests/useArchitectureRefresh.test.tsx`.
 */
export function useArchitectureRefresh(
  projectId: string | null,
  options: UseArchitectureRefreshOptions = {},
): UseArchitectureRefreshResult {
  // The success callback is read through a ref (updated in an effect) so a
  // parent that rebuilds it every render cannot recreate the controller and
  // re-run the activation read.
  const onSucceededRef = useRef(options.onSucceeded);
  useEffect(() => {
    onSucceededRef.current = options.onSucceeded;
  }, [options.onSucceeded]);
  const deliverSucceeded = useCallback((status: ArchitectureRefreshStatus): void => {
    onSucceededRef.current?.(status);
  }, []);

  const { pollIntervalMs } = options;
  // One controller per selected project: a project change is a new reading, and
  // `useSyncExternalStore` unsubscribes the previous one's timers.
  const controller = useMemo(
    () => createArchitectureRefreshController({
      api: {
        status: api.architectureRefreshStatus,
        start: api.architectureRefresh,
      },
      projectId,
      ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
      onSucceeded: deliverSucceeded,
    }),
    [projectId, pollIntervalMs, deliverSucceeded],
  );

  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  return {
    status: snapshot.status,
    elapsedMs: snapshot.elapsedMs,
    starting: snapshot.starting,
    requestError: snapshot.requestError,
    start: controller.refresh,
  };
}
