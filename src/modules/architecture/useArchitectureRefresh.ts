/**
 * The architecture tab's manual re-analysis hook: the status reading, the
 * whole-project start, and the two transitions the panel acts on.
 *
 * WHY A HOOK. The tab opens onto a project that any other tab or session may be
 * re-analysing at that moment, so the running state is shared server-side rather
 * than owned by the click that started it. This hook therefore loads
 * `GET /api/architecture/refresh/status` on mount (a tab opened mid-run shows the
 * run and offers no second start), polls while the job runs, and calls
 * `POST /api/architecture/refresh` for the manual start — which the server
 * coalesces with any concurrent caller.
 *
 * THE SUCCESS DELIVERY IS ONCE PER JOB, and only for a job this tab watched
 * running (or started itself). A tab that mounts after the job finished must not
 * treat the stale `succeeded` reading as "a refresh just landed": that would
 * refetch the graph and re-fit the drawing on every ordinary activation.
 *
 * Consumers: `ArchitecturePanel.tsx` (the footer entry, the confirmation dialog
 * and the post-success reload/fit) and `tests/useArchitectureRefresh.test.tsx`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';

/** The four states the server reports. Mirrors `ArchitectureRefreshState`. */
export type ArchitectureRefreshState = 'idle' | 'running' | 'succeeded' | 'failed';

/** Where the job is inside its lifetime. Mirrors the server's stage vocabulary. */
export type ArchitectureRefreshStage =
  | 'idle'
  | 'preparing'
  | 'analyzing'
  | 'installing'
  | 'succeeded'
  | 'failed';

/**
 * The status document both refresh verbs carry. Mirrors the server's
 * `ArchitectureRefreshStatus`; `stderrTail` is bounded server-side.
 */
export type ArchitectureRefreshStatus = {
  readonly state: ArchitectureRefreshState;
  readonly jobId: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly stage: ArchitectureRefreshStage;
  readonly elapsedMs: number;
  readonly exitCode: number | null;
  readonly stderrTail: readonly string[];
  readonly error: string | null;
};

/** What `POST /api/architecture/refresh` answers. */
export type ArchitectureRefreshStartResult = {
  readonly jobId: string;
  readonly coalesced: boolean;
  readonly status: ArchitectureRefreshStatus;
};

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

type UseArchitectureRefreshOptions = {
  /**
   * Called once when a job this hook watched running reaches `succeeded`. The
   * panel resets its unresolved-name reconciliation, refetches the graph and
   * fits the drawing from here.
   */
  readonly onSucceeded?: (status: ArchitectureRefreshStatus) => void;
  /** Poll cadence for a running job; a test may shorten it. */
  readonly pollIntervalMs?: number;
};

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

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : fallback;
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
  // The job's current status. State (not a ref) because the footer, the dialog
  // and the auto-Fit effect all render from it.
  const [status, setStatus] = useState<ArchitectureRefreshStatus>(IDLE_ARCHITECTURE_REFRESH_STATUS);
  // True while the POST is in flight; it is separate from the job's own state so
  // the first confirmation press cannot send a second request before the 202 lands.
  const [starting, setStarting] = useState(false);
  // The last transport error, shown in the dialog without turning the job's own
  // failure reading into a transport one.
  const [requestError, setRequestError] = useState<string | null>(null);
  // Ticks once a second while a job runs, so the elapsed reading advances without
  // the server being polled for a number the client can compute.
  const [tick, setTick] = useState(0);

  const onSucceeded = options.onSucceeded;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  // The callback is read through a ref so a parent that rebuilds it on every
  // render cannot re-run the activation GET below.
  const onSucceededRef = useRef(onSucceeded);
  useEffect(() => {
    onSucceededRef.current = onSucceeded;
  }, [onSucceeded]);
  // Guards the POST against a double press landing before React re-renders with
  // `starting: true`.
  const startingRef = useRef(false);
  // The jobs whose `succeeded` reading was already delivered to `onSucceeded`.
  const deliveredJobs = useRef(new Set<string>());
  // The jobs this tab observed in `running`; only those may be delivered.
  const observedRunning = useRef(new Set<string>());
  // Guards a status reply for a project that is no longer the selected one.
  const identityRef = useRef<string | null>(projectId);
  identityRef.current = projectId;

  const applyStatus = useCallback((next: ArchitectureRefreshStatus): void => {
    if (next.state === 'running' && next.jobId !== null) observedRunning.current.add(next.jobId);
    if (
      next.state === 'succeeded'
      && next.jobId !== null
      && observedRunning.current.has(next.jobId)
      && !deliveredJobs.current.has(next.jobId)
    ) {
      deliveredJobs.current.add(next.jobId);
      onSucceededRef.current?.(next);
    }
    setStatus(next);
  }, []);

  // The activation read: a tab opened while another session's job is running
  // shows that run instead of offering a second one.
  useEffect(() => {
    if (projectId === null) {
      deliveredJobs.current.clear();
      observedRunning.current.clear();
      setStatus(IDLE_ARCHITECTURE_REFRESH_STATUS);
      setRequestError(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const body = await readApiJson<ArchitectureRefreshStatus>(
          await api.architectureRefreshStatus(projectId),
        );
        if (cancelled || identityRef.current !== projectId) return;
        applyStatus(body);
      } catch (error) {
        if (cancelled || identityRef.current !== projectId) return;
        setRequestError(messageOf(error, 'The refresh status could not be read.'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, applyStatus]);

  // Polling: re-read while the job runs, and stop as soon as it is terminal.
  useEffect(() => {
    if (projectId === null || status.state !== 'running') return;
    let cancelled = false;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const body = await readApiJson<ArchitectureRefreshStatus>(
            await api.architectureRefreshStatus(projectId),
          );
          if (cancelled || identityRef.current !== projectId) return;
          setRequestError(null);
          applyStatus(body);
        } catch (error) {
          if (cancelled || identityRef.current !== projectId) return;
          setRequestError(messageOf(error, 'The refresh status could not be read.'));
        }
      })();
    }, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectId, status.state, pollIntervalMs, applyStatus]);

  // The elapsed ticker. Keyed on the run, so it cannot keep the process awake
  // after the job ends.
  useEffect(() => {
    if (status.state !== 'running') return;
    const timer = setInterval(() => setTick((value) => value + 1), 1_000);
    return () => clearInterval(timer);
  }, [status.state]);

  const start = useCallback((): void => {
    if (projectId === null || startingRef.current || status.state === 'running') return;
    startingRef.current = true;
    setStarting(true);
    setRequestError(null);
    void (async () => {
      try {
        const body = await readApiJson<ArchitectureRefreshStartResult>(
          await api.architectureRefresh(projectId),
        );
        if (identityRef.current !== projectId) return;
        applyStatus(body.status);
      } catch (error) {
        if (identityRef.current !== projectId) return;
        setRequestError(messageOf(error, 'The analysis could not be started.'));
      } finally {
        startingRef.current = false;
        if (identityRef.current === projectId) setStarting(false);
      }
    })();
  }, [projectId, status.state, applyStatus]);

  // The tick is read only so this hook re-renders once a second; the elapsed
  // number itself is always derived from the server's start instant.
  void tick;
  const elapsedMs = status.state === 'running' && status.startedAt !== null
    ? Math.max(status.elapsedMs, Date.now() - Date.parse(status.startedAt))
    : status.elapsedMs;

  return { status, elapsedMs, starting, requestError, start };
}
