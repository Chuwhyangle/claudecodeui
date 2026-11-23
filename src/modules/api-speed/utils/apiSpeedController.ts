/**
 * The API-speed view's rules, React-free.
 *
 * WHAT LIVES HERE, AND WHY NOT IN THE HOOK. Four decisions are easy to get wrong
 * and impossible to test through React: which answer wins when two reads overlap
 * (`requestSeq`), what a failed refresh does to the chart already on screen (it
 * keeps it and shows a banner), how the auto-probe schedules its next sample
 * (only after the previous one finished, so a slow probe cannot pile up), and
 * what a probe adds to the series (the result, then a full re-read, because the
 * store — not this tab — is the authority once two tabs probe at once).
 *
 * THE CLIENT IS INJECTED as parsed data functions rather than as `Response`s, so
 * a criterion drives every rule above without a fetch, a timer or a render.
 *
 * Consumers: `hooks/useApiLatency.ts`, which binds this to React, and the
 * controller criterion in `tests/apiSpeedController.test.ts`.
 */
import { createExternalStore, errorMessage } from '@/shared/utils';
import type {
  ApiLatencyProbeRequest,
  ApiLatencyProbeResult,
  ApiLatencySeries,
} from '@/shared/apiLatencyType';

/** How many samples a page asks for; the store's own cap is the server's business. */
const SERIES_LIMIT = 120;

/** How often the auto-probe takes a sample while it is switched on. */
const AUTO_PROBE_MS = 30_000;

/** What the panel renders. One object per commit, so a re-render is a value change. */
export type ApiSpeedSnapshot = {
  /** The last successful reading; kept across a failed refresh. */
  series: ApiLatencySeries | null;
  /** The most recent REQUEST failure, or `null`. A probe that succeeded but measured a failure is not this. */
  error: string | null;
  isLoading: boolean;
  isProbing: boolean;
  autoProbe: boolean;
};

/** The transport the controller needs; parsed data in, typed data out. */
export type ApiSpeedClient = {
  series: (limit?: number) => Promise<ApiLatencySeries>;
  probe: (input: ApiLatencyProbeRequest) => Promise<ApiLatencyProbeResult>;
};

/** The controller's injected seams; timers are injected so a criterion never sleeps. */
export type ApiSpeedControllerDeps = {
  client: ApiSpeedClient;
  autoProbeMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

/** The rules owner. Every command is the only writer of the state it names. */
export type ApiSpeedController = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => ApiSpeedSnapshot;
  /** Runs the first read and arms the auto-probe if it was already switched on. */
  start: () => void;
  /** Cancels a pending auto-probe; in-flight requests finish but their answers are dropped. */
  stop: () => void;
  reload: () => Promise<void>;
  probe: (input: ApiLatencyProbeRequest) => Promise<void>;
  setAutoProbe: (value: boolean) => void;
};

/**
 * Build the controller.
 *
 * `start`/`stop` are the lifecycle: `stop` clears the timer and bumps the request
 * sequence so a late answer cannot write to a disposed controller's snapshot.
 *
 * Consumers: the hook (one instance per mounted page) and the criterion.
 */
export function createApiSpeedController(deps: ApiSpeedControllerDeps): ApiSpeedController {
  const autoProbeMs = deps.autoProbeMs ?? AUTO_PROBE_MS;
  const setTimer = deps.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  const store = createExternalStore<ApiSpeedSnapshot>({
    series: null,
    error: null,
    isLoading: true,
    isProbing: false,
    autoProbe: false,
  });

  // The stale-answer guard: only the newest issued request may write its answer.
  let requestSeq = 0;
  let autoProbe = false;
  let timer: unknown = null;
  let disposed = false;

  const commit = (patch: Partial<ApiSpeedSnapshot>): void => {
    store.update((current) => ({ ...current, ...patch }));
  };

  const cancelTimer = (): void => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  const reload = async (): Promise<void> => {
    const id = ++requestSeq;
    try {
      const series = await deps.client.series(SERIES_LIMIT);
      if (id !== requestSeq) return;
      store.update((current) => ({ ...current, series, error: null, isLoading: false }));
    } catch (cause) {
      if (id !== requestSeq) return;
      // The previous reading stands: blanking the chart on one failed refresh
      // would hide the trend exactly when the link is misbehaving.
      commit({ error: errorMessage(cause), isLoading: false });
    }
  };

  const probe = async (input: ApiLatencyProbeRequest): Promise<void> => {
    commit({ isProbing: true });
    try {
      const result = await deps.client.probe(input);
      store.update((current) => {
        const currentProbes = current.series?.probes ?? [];
        const withResult = [...currentProbes, result];
        return {
          ...current,
          // The optimistic append keeps the chart moving during the re-read; the
          // re-read below is what makes the store, not this tab, the authority.
          series: current.series === null
            ? current.series
            : { ...current.series, probes: withResult.slice(-SERIES_LIMIT) },
          error: null,
        };
      });
      await reload();
    } catch (cause) {
      commit({ error: errorMessage(cause) });
    } finally {
      commit({ isProbing: false });
    }
  };

  // The next sample is scheduled only after the previous one finished, so a slow
  // probe stretches the interval instead of stacking requests behind it.
  const scheduleAutoProbe = (): void => {
    timer = setTimer(() => {
      timer = null;
      void (async () => {
        if (!autoProbe || disposed) return;
        await probe({ mode: 'ping', stream: true });
        if (autoProbe && !disposed) scheduleAutoProbe();
      })();
    }, autoProbeMs);
  };

  const setAutoProbe = (value: boolean): void => {
    if (autoProbe === value) return;
    autoProbe = value;
    commit({ autoProbe: value });
    cancelTimer();
    if (!value) return;
    // Each sample is a real (billed) request to the gateway, so switching this on
    // means "take one now", not "wait 30 s for the first one".
    void (async () => {
      await probe({ mode: 'ping', stream: true });
      if (autoProbe && !disposed) scheduleAutoProbe();
    })();
  };

  return {
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,
    start: () => {
      disposed = false;
      void reload();
      if (autoProbe) scheduleAutoProbe();
    },
    stop: () => {
      disposed = true;
      // A late answer must not write to a controller nobody reads any more.
      requestSeq += 1;
      cancelTimer();
    },
    reload,
    probe,
    setAutoProbe,
  };
}
