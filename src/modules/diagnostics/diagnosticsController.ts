import type { DiagnosticsFailure, DiagnosticsFeature } from '@/shared/types';
import { createExternalStore, defaultClock } from '@/shared/utils';

/**
 * The Settings diagnostics controller: the React-free owner of the page's two
 * reads and its copy action.
 *
 * WHAT IT OWNS. The feature-health and recent-failure readings, their
 * loading/error state, and the clipboard-copy status. The component renders the
 * snapshot and forwards events; it decides nothing.
 *
 * THE RULES.
 *  - The two reads run in PARALLEL and settle as one load. A failure shows an
 *    error and keeps the previous data on screen (a transient failure must not
 *    erase a diagnosis the operator was already reading) — and never throws
 *    into Settings.
 *  - A newer load supersedes an older one: the sequence token makes a late
 *    answer from the request that was left unable to overwrite the current one.
 *  - The copy is a three-state reading (`copying` -> `copied` | `failed`) that
 *    stays visible until the next copy or an explicit reset. The clipboard
 *    writer is injected, so the browser API is only wired in the hook.
 *
 * Consumers: `useDiagnostics` (the React binding) and the controller criterion.
 */

/** Most failures the page asks for; the server clamps the value again. */
export const DIAGNOSTICS_RECENT_FAILURES_LIMIT = 50;

/** The two reads and the bundle fetch the controller depends on. */
export type DiagnosticsApi = {
  features: () => Promise<{ features: DiagnosticsFeature[] }>;
  recentFailures: (limit: number) => Promise<{ failures: DiagnosticsFailure[] }>;
  bundle: () => Promise<string>;
};

/** The copy action's visible state. */
export type DiagnosticsCopyState = 'idle' | 'copying' | 'copied' | 'failed';

/** Everything the Settings tab reads through `useSyncExternalStore`. */
export type DiagnosticsSnapshot = {
  /** A load is in flight; the refresh control shows its progress state. */
  loading: boolean;
  /** The last load's failure message, or null. Previous readings are kept. */
  error: string | null;
  features: DiagnosticsFeature[];
  failures: DiagnosticsFailure[];
  copyState: DiagnosticsCopyState;
  /** When the current readings were received, ISO-8601; null before the first load. */
  lastLoadedAt: string | null;
};

/** The commands and subscription surface the hook drives. */
export type DiagnosticsController = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => DiagnosticsSnapshot;
  /** Fetches both readings; never rejects. */
  load: () => void;
  /** Fetches the bundle and copies it; never rejects. */
  copyBundle: () => void;
  /** Returns the copy status to `idle` (the banner's dismiss path). */
  resetCopyState: () => void;
  /** Stops accepting results; a controller is not reusable afterwards. */
  dispose: () => void;
};

/** The injected collaborators: the API, the clipboard writer and the clock. */
export type DiagnosticsControllerDeps = {
  api: DiagnosticsApi;
  writeClipboard: (text: string) => Promise<void>;
  recentFailuresLimit?: number;
  clock?: { now: () => number };
};

/**
 * Build one controller.
 *
 * Consumers: `useDiagnostics` (per mount) and the controller criterion.
 */
export function createDiagnosticsController(deps: DiagnosticsControllerDeps): DiagnosticsController {
  const clock = deps.clock ?? defaultClock;
  const failuresLimit = deps.recentFailuresLimit ?? DIAGNOSTICS_RECENT_FAILURES_LIMIT;

  let features: DiagnosticsFeature[] = [];
  let failures: DiagnosticsFailure[] = [];
  let loading = false;
  let error: string | null = null;
  let copyState: DiagnosticsCopyState = 'idle';
  let lastLoadedAt: string | null = null;

  // Tokens: a session-scoped load/copy is identified by its number, so a late
  // answer from a superseded request cannot overwrite the current reading.
  let loadSeq = 0;
  let copySeq = 0;
  let disposed = false;

  const buildSnapshot = (): DiagnosticsSnapshot => ({
    loading,
    error,
    features,
    failures,
    copyState,
    lastLoadedAt,
  });

  const store = createExternalStore<DiagnosticsSnapshot>(buildSnapshot());

  const publish = (): void => {
    if (disposed) return;
    store.set(buildSnapshot());
  };

  const load = (): void => {
    if (disposed) return;
    const requestId = ++loadSeq;
    loading = true;
    error = null;
    publish();
    void (async () => {
      try {
        const [featureReading, failureReading] = await Promise.all([
          deps.api.features(),
          deps.api.recentFailures(failuresLimit),
        ]);
        if (disposed || requestId !== loadSeq) return;
        features = featureReading.features;
        failures = failureReading.failures;
        lastLoadedAt = new Date(clock.now()).toISOString();
        loading = false;
        publish();
      } catch (reason) {
        if (disposed || requestId !== loadSeq) return;
        loading = false;
        error = reason instanceof Error ? reason.message : String(reason);
        publish();
      }
    })();
  };

  const copyBundle = (): void => {
    if (disposed || copyState === 'copying') return;
    const requestId = ++copySeq;
    copyState = 'copying';
    publish();
    void (async () => {
      try {
        const bundle = await deps.api.bundle();
        await deps.writeClipboard(bundle);
        if (disposed || requestId !== copySeq) return;
        copyState = 'copied';
      } catch {
        if (disposed || requestId !== copySeq) return;
        copyState = 'failed';
      }
      publish();
    })();
  };

  return {
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,
    load,
    copyBundle,
    resetCopyState: () => {
      if (copyState === 'idle') return;
      copySeq += 1;
      copyState = 'idle';
      publish();
    },
    dispose: () => {
      disposed = true;
      loadSeq += 1;
      copySeq += 1;
    },
  };
}
