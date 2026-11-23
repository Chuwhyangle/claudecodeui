import { createExternalStore, defaultClock } from '@/shared/utils';
import type { Clock } from '@/shared/types';
import type { NcLeaseInstance, NcLeaseStatus, NcReleaseRequest } from '@/shared/ncLeaseType';

/**
 * The sidebar NC-lease row's reading of the `ncres` ledger.
 *
 * THE RULES. One poll at a time; a reply for a request that has been superseded
 * (a manual reload racing the poll) is dropped rather than painted; a FAILED
 * refresh keeps the previous reading on screen and reports the error beside it,
 * so a transient `ncres` failure cannot blank the panel; a degraded reading is
 * passed through untouched, because the panel must draw a banner instead of
 * three green "free" rows.
 *
 * THE VISIBILITY RULE. A hidden tab is not on screen, so it must not keep
 * spawning `ncres` reads — no reading is worth a subprocess per five seconds for
 * a row nobody can see. `setVisible(false)` stops the cadence entirely and
 * `setVisible(true)` performs the catch-up read and restarts it, so returning to
 * the tab never shows a stale reading for longer than one request.
 *
 * Why a React-free controller: the poll timer, the in-flight request id and the
 * release guard are state with a lifecycle and more than one writer. Used by
 * `useNcLease` (and, through it, `NcLeaseIndicator`).
 */

/** The poll cadence of the row; the panel is a reading, not a live feed. */
export const NC_LEASE_POLL_MS = 5_000;

/** The render-facing reading. */
export type NcLeaseSnapshot = {
  /** The last successful reading, or `null` before the first one lands. */
  status: NcLeaseStatus | null;
  /** The most recent failure, kept beside (never instead of) the last good reading. */
  error: string | null;
  /** True until the first reading has settled. */
  isLoading: boolean;
  /** The slot currently being released, so its button can show a pending state. */
  releasing: NcLeaseInstance['id'] | null;
};

/** The injected collaborators: the two endpoints, a JSON reader, and a clock. */
export type NcLeaseControllerDeps = {
  /** `GET /api/nclease/status` — the raw response, so a non-200 can be classified. */
  fetchStatus: () => Promise<Response>;
  /** `POST /api/nclease/release` — the raw response, so its error body can be read. */
  fetchRelease: (input: NcReleaseRequest) => Promise<Response>;
  /** `readApiJson` in production; a test passes a literal reader. */
  readJson: <T>(response: Response) => Promise<T>;
  /** Injected so a timer test advances time instead of sleeping. */
  clock?: Clock;
  /** The poll cadence; production uses `NC_LEASE_POLL_MS`. */
  pollMs?: number;
};

/** The commands the React binding calls. */
export type NcLeaseController = {
  subscribe(listener: () => void): () => void;
  getSnapshot(): NcLeaseSnapshot;
  /** Begins the cadence; the first read happens only while the page is visible. */
  start(): void;
  /** Stops the cadence and invalidates anything in flight. */
  stop(): void;
  /** Pauses the cadence while hidden; resumes with an immediate catch-up read. */
  setVisible(visible: boolean): void;
  /** One read now (the panel's refresh button). */
  reload(): Promise<void>;
  /** Releases one slot, then re-reads the ledger. */
  release(slot: NcLeaseInstance['id']): Promise<void>;
};

export function createNcLeaseController(deps: NcLeaseControllerDeps): NcLeaseController {
  const clock = deps.clock ?? defaultClock;
  const pollMs = deps.pollMs ?? NC_LEASE_POLL_MS;
  const store = createExternalStore<NcLeaseSnapshot>({
    status: null,
    error: null,
    isLoading: true,
    releasing: null,
  });

  // Monotonic across the controller's life: every new read invalidates the reply
  // of the one it superseded, so a slow poll cannot overwrite a fresh manual read.
  let requestId = 0;
  let timer: unknown = null;
  let started = false;
  let visible = true;

  const clearTimer = (): void => {
    if (timer !== null) {
      clock.clearTimeout(timer);
      timer = null;
    }
  };

  const messageOf = (cause: unknown): string => (
    cause instanceof Error ? cause.message : String(cause)
  );

  const reload = async (): Promise<void> => {
    const id = (requestId += 1);
    try {
      const next = await deps.readJson<NcLeaseStatus>(await deps.fetchStatus());
      if (id !== requestId) return;
      store.update((snapshot) => ({ ...snapshot, status: next, error: null }));
    } catch (cause) {
      if (id !== requestId) return;
      store.update((snapshot) => ({ ...snapshot, error: messageOf(cause) }));
    } finally {
      if (id === requestId) {
        store.update((snapshot) => (snapshot.isLoading ? { ...snapshot, isLoading: false } : snapshot));
      }
    }
  };

  const schedule = (): void => {
    clearTimer();
    if (!started || !visible) return;
    timer = clock.setTimeout(() => {
      timer = null;
      // A hidden tab performs no read; `setVisible(true)` does the catch-up one.
      if (visible) void reload();
      schedule();
    }, pollMs);
  };

  const release = async (slot: NcLeaseInstance['id']): Promise<void> => {
    store.update((snapshot) => ({ ...snapshot, releasing: slot }));
    try {
      const response = await deps.fetchRelease({ slot, outcome: 'ok' });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error || `release failed (${response.status})`);
      }
      await reload();
    } catch (cause) {
      store.update((snapshot) => ({ ...snapshot, error: messageOf(cause) }));
    } finally {
      store.update((snapshot) => ({ ...snapshot, releasing: null }));
    }
  };

  return {
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,
    start(): void {
      if (started) return;
      started = true;
      if (visible) void reload();
      schedule();
    },
    stop(): void {
      started = false;
      clearTimer();
      // Invalidate anything still in flight so a reply cannot land after teardown.
      requestId += 1;
    },
    setVisible(next: boolean): void {
      if (visible === next) return;
      visible = next;
      if (!started) return;
      if (visible) {
        void reload();
        schedule();
      } else {
        clearTimer();
      }
    },
    reload,
    release,
  };
}
