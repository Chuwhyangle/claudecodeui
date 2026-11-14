/**
 * The architecture tab's manual re-analysis controller: every rule behind the
 * footer's refresh entry, kept in one object that does not depend on React.
 *
 * WHY A CONTROLLER. The running state is shared server-side rather than owned
 * by the click that started it, so the tab loads the project's status on mount,
 * polls while the job runs, and starts the manual re-analysis — a start the
 * server coalesces with any concurrent caller. Those rules used to live in the
 * hook's state and mirrored refs; here there is one mutable reading plus one
 * cached snapshot, and the hook only subscribes.
 *
 * The rules, unchanged from the hook this replaced:
 *
 * - The activation read. A tab opened while another session's job is running
 *   shows that run and offers no second start.
 * - Coalescing. A start is inert while a job is already running, so a second
 *   press (or a second tab sharing the same reading) never sends a second POST.
 *   A `coalesced: true` answer still adopts the returned job as this tab's own
 *   watched run.
 * - Observed running. Only a job this tab watched `running` (or started itself)
 *   may be delivered, so a tab that mounts onto a stale `succeeded` reading does
 *   not refetch the graph and re-fit on every ordinary activation.
 * - Once per job. `onSucceeded` fires at most once for a job id, even though the
 *   status endpoint keeps answering `succeeded` afterwards.
 * - The elapsed reading. A running job re-renders once a second off the server's
 *   start instant; a poll still owns the authoritative status.
 *
 * Consumers: `useArchitectureRefresh` (which subscribes and forwards the
 * snapshot) and `tests/architectureRefreshController.test.ts`.
 */
import type {
  ArchitectureRefreshStartResult,
  ArchitectureRefreshStatus,
  Clock,
} from '@/shared/types';
import { createExternalStore, defaultClock, errorMessage } from '@/shared/utils';

/** The shipped "nothing has run in this server process" reading. */
export const IDLE_ARCHITECTURE_REFRESH_STATUS: ArchitectureRefreshStatus = {
  state: 'idle',
  jobId: null,
  startedAt: null,
  finishedAt: null,
  stage: 'idle',
  elapsedMs: 0,
  exitCode: null,
  stderrTail: [],
  error: null,
};

/** How often a running job is re-read while the tab is open. */
const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** How often the elapsed reading advances while a job runs. */
const ELAPSED_TICK_MS = 1_000;

/**
 * The two endpoint calls the controller makes. Both answer their parsed document;
 * the controller never touches a `Response`.
 */
export type ArchitectureRefreshApi = {
  status: (projectId: string) => Promise<ArchitectureRefreshStatus>;
  start: (projectId: string) => Promise<ArchitectureRefreshStartResult>;
};

/** Schedules the poll and the elapsed ticker; injectable so tests need no wall clock. */
export type ArchitectureRefreshClock = Clock;

/** Everything the hook reads through `useSyncExternalStore`. */
export type ArchitectureRefreshSnapshot = {
  /** The job's current reading, as the footer, the dialog and the auto-fit effect see it. */
  readonly status: ArchitectureRefreshStatus;
  /** Live elapsed time for a running job, else the server's reading. */
  readonly elapsedMs: number;
  /** True while the start POST is in flight (the dialog keeps its button disabled). */
  readonly starting: boolean;
  /** A transport/refusal error from the start POST or the status GET, if any. */
  readonly requestError: string | null;
};

/** The commands and subscription surface the hook drives. */
export type ArchitectureRefreshController = {
  /** Registers a listener; the returned function unsubscribes it. */
  readonly subscribe: (listener: () => void) => () => void;
  /** The stable snapshot; the identity changes only when the reading changed. */
  readonly getSnapshot: () => ArchitectureRefreshSnapshot;
  /** Starts the whole-project re-analysis; inert while one is already running. */
  readonly refresh: () => void;
  /** Stops the timers and subscribers; a controller is not reusable afterwards. */
  readonly dispose: () => void;
};

/** Build one controller for one project (null means nothing is selected yet). */
export function createArchitectureRefreshController(options: {
  api: ArchitectureRefreshApi;
  projectId: string | null;
  clock?: ArchitectureRefreshClock;
  /** Called once when a job this controller watched running reaches `succeeded`. */
  onSucceeded?: (status: ArchitectureRefreshStatus) => void;
  /** Poll cadence for a running job; a test may shorten it. */
  pollIntervalMs?: number;
}): ArchitectureRefreshController {
  const { api, projectId } = options;
  const clock = options.clock ?? defaultClock;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  let disposed = false;
  // True while at least one subscriber is attached. The activation read and the
  // timers belong to that window, not to the object's lifetime: React 18's
  // StrictMode tears every subscription down once before its real setup, and a
  // controller that treated that first teardown as its own death would never
  // publish the reading the tab needs.
  let active = false;

  // The job's current reading and the two transport facts beside it. The start
  // flag is separate from the job's own state so the first confirmation press
  // cannot send a second request before the 202 lands.
  let status: ArchitectureRefreshStatus = IDLE_ARCHITECTURE_REFRESH_STATUS;
  let starting = false;
  let requestError: string | null = null;

  // The jobs whose `succeeded` reading was already delivered to `onSucceeded`,
  // and the jobs this tab observed in `running`; only those may be delivered.
  const deliveredJobs = new Set<string>();
  const observedRunning = new Set<string>();

  let pollTimer: unknown = null;
  let tickTimer: unknown = null;

  const elapsedMs = (): number => status.state === 'running' && status.startedAt !== null
    ? Math.max(status.elapsedMs, clock.now() - Date.parse(status.startedAt))
    : status.elapsedMs;

  const buildSnapshot = (): ArchitectureRefreshSnapshot => ({
    status,
    elapsedMs: elapsedMs(),
    starting,
    requestError,
  });

  /**
   * The one reading the hook renders. The activation read and the timers run
   * only between the first subscriber and the last.
   */
  const store = createExternalStore<ArchitectureRefreshSnapshot>(buildSnapshot(), {
    onFirstSubscriber: () => activate(),
    onLastUnsubscriber: () => deactivate(),
  });

  /** Rebuilds the snapshot and notifies only when a published field changed. */
  const publish = (): void => {
    if (disposed) return;
    const next = buildSnapshot();
    const previous = store.getSnapshot();
    if (
      previous.status === next.status
      && previous.elapsedMs === next.elapsedMs
      && previous.starting === next.starting
      && previous.requestError === next.requestError
    ) {
      return;
    }
    store.set(next);
  };

  const stopPolling = (): void => {
    if (pollTimer === null) return;
    clock.clearTimeout(pollTimer);
    pollTimer = null;
  };

  /** One re-read of a running job, then the next one; a terminal reading stops it. */
  const schedulePoll = (): void => {
    if (!active || disposed || projectId === null || status.state !== 'running' || pollTimer !== null) return;
    pollTimer = clock.setTimeout(() => {
      pollTimer = null;
      void (async () => {
        try {
          const body = await api.status(projectId);
          if (!active || disposed) return;
          requestError = null;
          applyStatus(body);
        } catch (error) {
          if (!active || disposed) return;
          requestError = errorMessage(error, 'The refresh status could not be read.');
          publish();
          // A failed poll is not a terminal job: keep reading while it runs.
          schedulePoll();
        }
      })();
    }, pollIntervalMs);
  };

  /** Keeps the once-a-second elapsed ticker alive exactly while a job runs. */
  const syncTicker = (): void => {
    if (active && status.state === 'running') {
      if (tickTimer === null) {
        tickTimer = clock.setInterval(() => publish(), ELAPSED_TICK_MS);
      }
      return;
    }
    if (tickTimer !== null) {
      clock.clearInterval(tickTimer);
      tickTimer = null;
    }
  };

  /**
   * Takes one status reading. A job seen `running` is remembered; its later
   * `succeeded` reading is delivered once, and only to a tab that saw it run.
   */
  const applyStatus = (next: ArchitectureRefreshStatus): void => {
    if (next.state === 'running' && next.jobId !== null) {
      observedRunning.add(next.jobId);
    }
    if (
      next.state === 'succeeded'
      && next.jobId !== null
      && observedRunning.has(next.jobId)
      && !deliveredJobs.has(next.jobId)
    ) {
      deliveredJobs.add(next.jobId);
      options.onSucceeded?.(next);
    }
    status = next;
    stopPolling();
    syncTicker();
    publish();
    schedulePoll();
  };

  /** The activation read: a tab opened mid-run shows that run instead of offering a second one. */
  const loadStatus = (): void => {
    if (projectId === null) return;
    void (async () => {
      try {
        const body = await api.status(projectId);
        if (!active || disposed) return;
        applyStatus(body);
      } catch (error) {
        if (!active || disposed) return;
        requestError = errorMessage(error, 'The refresh status could not be read.');
        publish();
      }
    })();
  };

  /** Arms the activation read and the timers for the first subscriber. */
  const activate = (): void => {
    if (active || disposed) return;
    active = true;
    syncTicker();
    schedulePoll();
    loadStatus();
  };

  /** Stops the timers when the last subscriber leaves; a later subscriber starts over. */
  const deactivate = (): void => {
    active = false;
    stopPolling();
    syncTicker();
  };

  const refresh = (): void => {
    // Coalescing: a job is already running, so this press joins it rather than
    // asking the server to start a second one.
    if (disposed || projectId === null || starting || status.state === 'running') return;
    starting = true;
    requestError = null;
    publish();
    void (async () => {
      try {
        const body = await api.start(projectId);
        if (disposed) return;
        // A `coalesced: true` answer is the job another caller started; adopting
        // it here is what lets this tab deliver its success too.
        applyStatus(body.status);
      } catch (error) {
        if (disposed) return;
        requestError = errorMessage(error, 'The analysis could not be started.');
      } finally {
        if (!disposed) {
          starting = false;
          publish();
        }
      }
    })();
  };

  return {
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,
    refresh,
    dispose: () => {
      disposed = true;
      deactivate();
    },
  };
}
