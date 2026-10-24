/**
 * Local view-event instrumentation for the observation wall (`observation-p0-view-instrumentation`).
 *
 * The workload analysis could only see *typed* input. The largest observation load — opening a
 * session to read its output, or switching to the Quay board or the architecture drawing to read
 * state — produced no record at all. This module records those viewing episodes locally:
 *
 *   - one event per episode the reader LEAVES, carrying `dwellMs` and `fromTarget`;
 *   - a transition (a new target) settles the previous episode immediately;
 *   - `visibilitychange` settles the episode and pauses the clock while the page is hidden;
 *   - events are batched (every 30 s or 50 events) and POSTed to
 *     `/api/observation/view-events`, where the server appends them to a local-only JSONL file.
 *
 * Nothing here renders, and nothing here knows what a tab is: callers report `(kind, target)`.
 * The default singleton is inert for uploads until {@link installViewEvents} runs, so mounting a
 * component in a unit test cannot produce network traffic; episodes reported before installation
 * are buffered (bounded) and flushed by the install.
 *
 * Consumers: `src/App.tsx` (installs it and reports the cockpit route) and
 * `src/modules/project-workspace/hooks/useProjectsState.ts` (reports the active session/tab).
 */
import { authenticatedFetch } from '@/shared/api';
import { getDeviceId } from '@/shared/utils/deviceIdentity';

/** What the reader was looking at. `tab` names a workspace tab (`quay`, `architecture`, …). */
export type ViewEventKind = 'session' | 'tab' | 'cockpit-tile' | 'cockpit-preview';

/**
 * One completed viewing episode — written at the moment the reader leaves `target`.
 *
 * `at` is the leave timestamp (ms since epoch), `dwellMs` how long the episode was actually
 * visible (hidden time excluded), and `fromTarget` the target the reader came from when the
 * episode started (null for the first one). `deviceId` is the browser's stable identity, the
 * same one the MCP client registry publishes.
 */
export type ViewEvent = {
  at: number;
  kind: ViewEventKind;
  target: string;
  fromTarget: string | null;
  dwellMs: number;
  deviceId: string;
};

/** Delivers one batch. Returning false (or throwing) requeues it for the next attempt. */
export type ViewEventSender = (events: ViewEvent[]) => Promise<boolean> | boolean;

/** Injection points for the tracker; production uses the defaults. */
export type ViewEventTrackerOptions = {
  /** Whether batches may be sent at all. Episodes are still recorded while false. */
  enabled?: boolean;
  /** Queue length that triggers an immediate batch. */
  batchSize?: number;
  /** How often a non-empty queue is flushed even below the batch size. */
  flushIntervalMs?: number;
  now?: () => number;
  deviceId?: () => string;
  send?: ViewEventSender;
};

/** A tracker as used by the app and by its criterion. */
export type ViewEventTracker = {
  /** Records the target being viewed now, settling the previous episode. */
  view: (kind: ViewEventKind, target: string) => void;
  /** Settles the current episode and pauses the clock (called on page hide). */
  hide: () => void;
  /** Resumes timing for the target that was on screen when the page was hidden. */
  show: () => void;
  /** Sends the queued batches now. Never throws. */
  flush: () => Promise<void>;
  /** Binds visibility listeners and the flush interval; returns the unbind function. */
  attach: () => () => void;
  /** Flips upload permission without discarding the queue. */
  setEnabled: (enabled: boolean) => void;
  /** Number of events waiting to be sent (read by tests). */
  queued: () => number;
};

/** The shipped batch size: 50 events, or the 30 s interval, whichever comes first. */
const DEFAULT_BATCH_SIZE = 50;

/** The shipped flush interval. */
const DEFAULT_FLUSH_INTERVAL_MS = 30_000;

/**
 * Upper bound on the in-memory queue. A server that stays unreachable (or an uninstalled
 * tracker) must not grow the page's memory without limit; the oldest events are dropped first.
 */
const MAX_QUEUED_EVENTS = 500;

const KIND_SET: ReadonlySet<string> = new Set<ViewEventKind>([
  'session',
  'tab',
  'cockpit-tile',
  'cockpit-preview',
]);

/** The production transport: one authenticated POST, 204 on success. */
const postViewEvents: ViewEventSender = async (events) => {
  try {
    const response = await authenticatedFetch('/api/observation/view-events', {
      method: 'POST',
      body: JSON.stringify({ events }),
    });
    return response.ok;
  } catch {
    return false;
  }
};

/**
 * Creates an independent tracker.
 *
 * One tracker owns exactly one "current episode". `view()` on the same target is a no-op, so a
 * re-render that reports the same reading does not split the dwell.
 */
export function createViewEventTracker(options: ViewEventTrackerOptions = {}): ViewEventTracker {
  let enabled = options.enabled ?? true;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());
  const deviceId = options.deviceId ?? getDeviceId;
  const send = options.send ?? postViewEvents;

  type Episode = { kind: ViewEventKind; target: string; startedAt: number; fromTarget: string | null };

  let episode: Episode | null = null;
  let pausedEpisode: { kind: ViewEventKind; target: string } | null = null;
  let queue: ViewEvent[] = [];
  let inFlight: Promise<void> | null = null;

  const settle = (at: number): ViewEvent | null => {
    if (episode === null) return null;
    const event: ViewEvent = {
      at,
      kind: episode.kind,
      target: episode.target,
      fromTarget: episode.fromTarget,
      dwellMs: Math.max(0, at - episode.startedAt),
      deviceId: deviceId(),
    };
    episode = null;
    return event;
  };

  const enqueue = (event: ViewEvent): void => {
    queue.push(event);
    if (queue.length > MAX_QUEUED_EVENTS) queue = queue.slice(queue.length - MAX_QUEUED_EVENTS);
  };

  const flush = async (): Promise<void> => {
    // A concurrent caller joins the batch already leaving instead of opening a second one, so
    // `await flush()` is a real "the queue reached the server" reading for tests and stop paths.
    if (inFlight !== null) {
      await inFlight;
      return;
    }
    if (!enabled || queue.length === 0) return;
    const batch = queue.slice(0, batchSize);
    queue = queue.slice(batch.length);
    const attempt = (async (): Promise<boolean> => {
      let delivered = false;
      try {
        delivered = await send(batch);
      } catch {
        delivered = false;
      }
      if (!delivered) {
        // Keep the failed batch ahead of anything recorded meanwhile, still bounded.
        queue = [...batch, ...queue].slice(0, MAX_QUEUED_EVENTS);
      }
      return delivered;
    })();
    inFlight = attempt.then(() => undefined);
    const tracked = inFlight;
    let delivered = false;
    try {
      delivered = await attempt;
    } finally {
      if (inFlight === tracked) inFlight = null;
    }
    // A burst can leave a second full batch behind; drain it without waiting for the interval.
    // Only on success — a failed batch is already back at the head of the queue.
    if (delivered && queue.length >= batchSize) void flush();
  };

  const view = (kind: ViewEventKind, target: string): void => {
    if (!KIND_SET.has(kind) || typeof target !== 'string' || target === '') return;
    const at = now();
    if (episode !== null && episode.kind === kind && episode.target === target) return;
    const ended = settle(at);
    if (ended !== null) {
      enqueue(ended);
      if (queue.length >= batchSize) void flush();
    }
    episode = { kind, target, startedAt: at, fromTarget: ended?.target ?? null };
    // Viewing explicitly brings the reader back from a hidden page.
    pausedEpisode = null;
  };

  const hide = (): void => {
    const ended = settle(now());
    if (ended !== null) {
      enqueue(ended);
      // Remember the target so `show()` resumes timing for it rather than starting a new one.
      pausedEpisode = { kind: ended.kind, target: ended.target };
    }
    void flush();
  };

  const show = (): void => {
    const paused = pausedEpisode;
    pausedEpisode = null;
    if (paused === null || episode !== null) return;
    episode = { kind: paused.kind, target: paused.target, startedAt: now(), fromTarget: paused.target };
  };

  const attach = (): (() => void) => {
    const cleanups: Array<() => void> = [];
    if (typeof document !== 'undefined') {
      const onVisibilityChange = (): void => {
        if (document.hidden) hide();
        else show();
      };
      document.addEventListener('visibilitychange', onVisibilityChange);
      cleanups.push(() => document.removeEventListener('visibilitychange', onVisibilityChange));
    }
    const interval = setInterval(() => {
      void flush();
    }, flushIntervalMs);
    cleanups.push(() => clearInterval(interval));
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  };

  return {
    view,
    hide,
    show,
    flush,
    attach,
    setEnabled: (next: boolean) => {
      enabled = next;
    },
    queued: () => queue.length,
  };
}

/**
 * The application's tracker. Uploads stay off until {@link installViewEvents}; episodes reported
 * before then are buffered so the first view of a page load is not lost to effect ordering.
 */
const defaultTracker = createViewEventTracker({ enabled: false });

let detachDefaultTracker: (() => void) | null = null;

/**
 * Starts the application instrumentation: enables uploads, binds page-visibility handling and
 * the 30 s flush timer, and returns the uninstall function. Idempotent.
 *
 * Consumers: `src/App.tsx`.
 */
export function installViewEvents(): () => void {
  if (detachDefaultTracker !== null) return detachDefaultTracker;
  defaultTracker.setEnabled(true);
  const detach = defaultTracker.attach();
  detachDefaultTracker = () => {
    detach();
    defaultTracker.setEnabled(false);
    detachDefaultTracker = null;
  };
  void defaultTracker.flush();
  return detachDefaultTracker;
}

/**
 * Reports what the reader is looking at now. Safe to call before installation and from tests —
 * it records into the bounded queue but sends nothing until {@link installViewEvents}.
 *
 * Consumers: `src/App.tsx` and `src/modules/project-workspace/hooks/useProjectsState.ts`.
 */
export function reportView(kind: ViewEventKind, target: string): void {
  defaultTracker.view(kind, target);
}

/** Sends the application tracker's queue now (used by tests and by page-hide handling). */
export function flushViewEvents(): Promise<void> {
  return defaultTracker.flush();
}
