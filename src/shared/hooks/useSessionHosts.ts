import { useCallback, useSyncExternalStore } from 'react';

import { api, readApiJson } from '@/shared/api';
import type {
  ResidentProcessState,
  SessionHostBindingView,
  SessionHostLeaseKind,
  SessionHostStateView,
  SessionHostView,
  SessionHostsSnapshot,
  SessionOccupiedBy,
} from '@/shared/types';

/**
 * The resident-process snapshot, shared by every reader on the page.
 *
 * Consumed by the sidebar (the mark beside a session's provider logo), by the
 * chat transcript (the status bar and its popover) and by the composer (which
 * needs the session's stored lifecycle mode to know what its stop button means).
 * They all read one store rather than polling for themselves: three components
 * each holding their own copy would let the sidebar and the status bar disagree
 * about the same host for as long as their intervals were out of step, and the
 * readings that matter here are exactly the comparisons between them.
 *
 * The server now announces that the listing changed instead of the page asking
 * again and again: `GET /api/session-hosts` is still the one face that *builds*
 * the snapshot, but a `hosts_changed` frame is what says when to re-read it.
 * The store therefore has two inputs — {@link invalidateSessionHosts}, called
 * from the websocket bridge with the frame's revision, and a slow fallback
 * interval that only exists to cover the gap while the socket is down. The
 * revision is what makes the push safe against a slow read: a frame that names
 * a revision at or below the last one applied is dropped, so a re-delivered or
 * out-of-order frame cannot start a second read, and the frames a burst of
 * transitions produce are coalesced into one.
 *
 * The fallback interval is deliberately long while the socket is up ({@link
 * CONNECTED_REFRESH_INTERVAL_MS}) — the frames are the signal then — and short
 * only while it is down ({@link DISCONNECTED_REFRESH_INTERVAL_MS}), which is the
 * one case where nothing else would report a change at all. Either way it is
 * suspended while the tab is hidden, since nothing is looking at the result.
 */

/** How often the snapshot is re-read while the socket is up and the tab visible. */
const CONNECTED_REFRESH_INTERVAL_MS = 30_000;

/** How often it is re-read while the socket is down — the only signal then. */
const DISCONNECTED_REFRESH_INTERVAL_MS = 2_000;

/**
 * How long a burst of `hosts_changed` frames is folded together.
 *
 * A turn ending can announce itself through more than one path (the lease
 * dropping, the host lingering, a session write), and each announcement reaches
 * the browser as its own frame. Waiting a short beat before reading means one
 * request covers the whole burst, and no reader ever sees the intermediate
 * listing the burst passed through.
 */
const INVALIDATE_COALESCE_MS = 250;

type SessionHostsStoreState = {
  /** The last snapshot read, or null before the first answer. */
  snapshot: SessionHostsSnapshot | null;
  /** The message from the last failed read, or null when the last read succeeded. */
  error: string | null;
  /** True while a read is in flight and no snapshot has ever been read. */
  loading: boolean;
};

/**
 * Owns the page's one resident-process snapshot and the polling lifecycle that
 * keeps it current.
 *
 * These six fields used to be module-level `let`s operated on by module-level
 * functions: a global mutable singleton with no owner, no lifecycle, and no way
 * to instantiate or inject it. They are a class now, so the state has one
 * explicit owner — the store — and an explicit lifetime: {@link start} begins
 * the fallback poller, {@link stop} ends it, and {@link subscribe} drives both
 * from the number of readers. The module exports one instance
 * ({@link sessionHostsStore}); the exported functions below are thin entry
 * points onto it for callers that cannot hold a reference (the websocket
 * bridge).
 *
 * Used by `useSessionHosts`, which subscribes through {@link sessionHostsStore},
 * and by the websocket bridge through {@link invalidateSessionHosts} and
 * {@link setSessionHostsConnection}.
 */
export class SessionHostsStore {
  /**
   * The reading every subscriber renders. Replaced wholesale on every change so
   * `useSyncExternalStore` sees a new reference; the snapshot is kept across a
   * failed read while `error` names the failure.
   */
  private state: SessionHostsStoreState = { snapshot: null, error: null, loading: false };

  /** The components subscribed through `useSyncExternalStore`. */
  private readonly listeners = new Set<() => void>();

  /** The one fallback poller, running between {@link start} and {@link stop}. */
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  /** The in-flight read, so overlapping refreshes collapse into one request. */
  private inFlight: Promise<void> | null = null;

  /** The pending coalesced read, or null when none is scheduled. */
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The highest `hosts_changed` revision already applied, or null when none has
   * been — the cursor that makes the push idempotent.
   *
   * It is reset whenever a connection is (re)established: a revision is only
   * meaningful against one server run, and a reconnected socket may be talking to
   * a process whose listing started counting again from one. Keeping the old
   * cursor across a reconnect would then drop every frame the new server sent,
   * which is the exact failure the reconnect pull is there to prevent.
   */
  private appliedRev: number | null = null;

  /** Whether the websocket is currently up; picks the fallback interval. */
  private connected = false;

  /**
   * Begins the store's lifetime: reads the listing once, then keeps the
   * fallback poller running. The first subscriber calls this.
   */
  start(): void {
    void this.refresh();
    this.startFallbackPoll();
  }

  /**
   * Ends the store's lifetime: stops the fallback poller and drops any read a
   * burst of frames had scheduled. The last unsubscribe calls this.
   */
  stop(): void {
    this.stopFallbackPoll();
    this.clearCoalescedRefresh();
  }

  /**
   * Subscribes one reader and returns its unsubscribe. The first subscriber
   * starts the store; the last one stops it, so nothing polls while the page
   * has no listener.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);

    if (this.listeners.size === 1) {
      this.start();
    }

    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.stop();
      }
    };
  }

  /** The current reading, in the shape `useSyncExternalStore` reads. */
  readState(): SessionHostsStoreState {
    return this.state;
  }

  /**
   * Re-reads the snapshot. Concurrent callers share one request.
   *
   * Any coalesced read still waiting is dropped first: this read answers the same
   * question the burst of frames asked, so letting the timer fire afterwards would
   * be a second request for a listing that was just read. That is what keeps a
   * reconnect — which arrives as both a connection edge and a frame — to one read.
   */
  refresh(): Promise<void> {
    this.clearCoalescedRefresh();

    if (!this.inFlight) {
      this.inFlight = this.readSnapshot().finally(() => {
        this.inFlight = null;
      });
    }

    return this.inFlight;
  }

  /**
   * Announces that the listing changed, and re-reads it.
   *
   * `rev` is the frame's revision when the frame carries one; a caller with no
   * revision (the synthetic reconnect event) passes none and the read is
   * scheduled unconditionally. When a revision is given, one at or below {@link
   * appliedRev} is dropped: the server hands revisions out in order and never
   * reuses one, so seeing an old revision again means the frame was re-delivered
   * or overtaken, and reading again would report the same listing a second time.
   *
   * Nothing is done before the store has its first subscriber: the frames arrive
   * for the page as a whole, but a read with no reader is a request nobody asked
   * for. The first subscriber reads the listing itself, so no change is missed.
   */
  invalidate(rev?: number): void {
    if (this.listeners.size === 0) {
      return;
    }

    if (typeof rev === 'number') {
      if (this.appliedRev !== null && rev <= this.appliedRev) {
        return;
      }
      this.appliedRev = rev;
    }

    this.scheduleCoalescedRefresh();
  }

  /**
   * Tells the store whether the websocket is up, which selects the fallback
   * interval — and, on (re)connecting, re-reads at once.
   *
   * The immediate read is the point of the connect edge: everything that happened
   * while the socket was down produced frames that were never delivered, and a
   * client that waited for the next fallback tick would show a stale listing for
   * up to the connected interval after coming back. The revision cursor is reset
   * on the same edge, for the reason given on {@link appliedRev}.
   */
  setConnection(isConnected: boolean): void {
    if (this.connected === isConnected) {
      return;
    }
    this.connected = isConnected;

    if (this.connected) {
      this.appliedRev = null;
    }

    if (this.listeners.size === 0) {
      return;
    }

    this.startFallbackPoll();
    if (this.connected) {
      void this.refresh();
    }
  }

  private emit(next: SessionHostsStoreState): void {
    this.state = next;
    for (const listener of this.listeners) {
      listener();
    }
  }

  private async readSnapshot(): Promise<void> {
    try {
      const response = await api.sessionHosts.list();
      const body = await readApiJson<{ data?: SessionHostsSnapshot }>(response);
      this.emit({ snapshot: body.data ?? { hosts: [], sessions: [] }, error: null, loading: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The previous snapshot is kept *as data* — a single failed poll is not
      // evidence that every process went away, and throwing the listing out would
      // make the next successful read rebuild it from nothing. It is not kept as
      // the *reading*, though: the `error` on this state is what
      // `readResidentProcessState` folds into `unknown`, so a consumer sees "not
      // known" rather than the stale word the kept snapshot would otherwise
      // repeat. Re-emitting the same message would re-render every subscriber for
      // nothing, so it is not.
      if (message !== this.state.error) {
        this.emit({ ...this.state, error: message, loading: false });
      }
    }
  }

  private stopFallbackPoll(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** (Re)starts the fallback poller on the interval the connection state selects. */
  private startFallbackPoll(): void {
    this.stopFallbackPoll();
    this.pollTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) {
        return;
      }
      void this.refresh();
    }, this.connected ? CONNECTED_REFRESH_INTERVAL_MS : DISCONNECTED_REFRESH_INTERVAL_MS);
  }

  /** Schedules the one read a burst of frames is folded into. */
  private scheduleCoalescedRefresh(): void {
    if (this.coalesceTimer !== null) {
      return;
    }
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null;
      void this.refresh();
    }, INVALIDATE_COALESCE_MS);
  }

  private clearCoalescedRefresh(): void {
    if (this.coalesceTimer !== null) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = null;
    }
  }
}

/**
 * The page's single `SessionHostsStore` instance — the one place the shared
 * snapshot lives, and the store `useSessionHosts` subscribes to.
 *
 * Used by `useSessionHosts` and, through the two entry points below, by the
 * websocket bridge.
 */
export const sessionHostsStore = new SessionHostsStore();

/** Entry point for the websocket bridge's `hosts_changed` frames. */
export function invalidateSessionHosts(rev?: number): void {
  sessionHostsStore.invalidate(rev);
}

/** Entry point for the websocket bridge's connect/disconnect edges. */
export function setSessionHostsConnection(isConnected: boolean): void {
  sessionHostsStore.setConnection(isConnected);
}

function refreshSessionHosts(): Promise<void> {
  return sessionHostsStore.refresh();
}

function subscribe(listener: () => void): () => void {
  return sessionHostsStore.subscribe(listener);
}

function readState(): SessionHostsStoreState {
  return sessionHostsStore.readState();
}

/**
 * Finds the live host holding one session, or null.
 *
 * A closed host is skipped rather than returned: its record stays in the
 * listing for a retention window, and a reader treating it as a live process
 * would answer the opposite of what the process's own existence says.
 */
export function findLiveHost(
  snapshot: SessionHostsSnapshot | null,
  appSessionId: string,
): SessionHostView | null {
  if (!snapshot) {
    return null;
  }

  for (const host of snapshot.hosts) {
    if (host.state === 'closed') {
      continue;
    }
    if (host.bindings.some((binding) => binding.appSessionId === appSessionId)) {
      return host;
    }
  }

  return null;
}

/**
 * The host that most recently served one session, closed or not.
 *
 * Unlike {@link findLiveHost} this keeps a closed record, because the two
 * questions a reader asks about a resident session need opposite answers from
 * the same listing: "is it running" must not count a host that has already
 * closed, while "what happened to it" can only be answered by the record that
 * closed — its `closeReason` and `closeDetail` are the whole content of the
 * exited state. The last match wins, so a session that was restarted reads as
 * its newest host rather than its oldest.
 */
export function findSessionHost(
  snapshot: SessionHostsSnapshot | null,
  appSessionId: string,
): SessionHostView | null {
  if (!snapshot) {
    return null;
  }

  let found: SessionHostView | null = null;
  for (const host of snapshot.hosts) {
    if (host.bindings.some((binding) => binding.appSessionId === appSessionId)) {
      found = host;
    }
  }

  return found;
}

/** Every `(host, binding)` pair a live host is serving, in listing order. */
function liveBindings(
  snapshot: SessionHostsSnapshot | null,
): Array<{ host: SessionHostView; binding: SessionHostBindingView }> {
  const pairs: Array<{ host: SessionHostView; binding: SessionHostBindingView }> = [];
  for (const host of snapshot?.hosts ?? []) {
    if (host.state === 'closed') {
      continue;
    }
    for (const binding of host.bindings) {
      pairs.push({ host, binding });
    }
  }
  return pairs;
}

/**
 * The busy/idle classification the whole page reads: which sessions are being
 * worked on, and which resident ones are merely held open.
 *
 * **The busy side is the server's own activity, not this poll.** It used to be
 * derived here, from the `turn` lease in the one-second `/api/session-hosts`
 * listing — which made the sidebar a second, slower answer to a question the
 * activity dock already answers from the server's pushed frames. Two answers is
 * how a page comes to say "idle" in the dock and "busy" in the sidebar for as
 * long as the poll lags, and the lag is real: a turn that ends is announced to
 * the page at once and observed by the listing up to a beat later. So the busy
 * set is the caller's — the same `SessionActivity` membership the dock and the
 * composer's stop entry read (`useBusySessionIdSet`) — and this function's job is
 * to place it against the listing that still owns the *other* group.
 *
 * The listing keeps exactly one job here: naming the resident sessions that are
 * held open with nothing to do. That is a fact about a process, not about
 * activity, and no activity source can report it — which is why the poll stays,
 * and why its reading is not allowed to decide busy/idle.
 *
 * Every lifecycle mode counts as running. A per-run session's process lives
 * exactly as long as its turn does, so a per-run session with a turn in flight
 * *is* one being worked on; narrowing this to resident sessions would silently
 * drop the turns the view was built to show.
 */
export function classifyRunningSessions(
  busySessionIds: ReadonlySet<string>,
  snapshot: SessionHostsSnapshot | null,
): { running: string[]; residentIdle: string[] } {
  const running = [...busySessionIds].sort();
  const runningSet = new Set(running);

  // Per binding: a resident host running a turn for one of the sessions it holds
  // is holding every other one of them idle, and those are exactly the rows this
  // group exists to list — a rule that skipped a busy host's bindings wholesale
  // would hide the one row a reader most wants to close while something else is
  // running. Membership in the busy set is what decides, never the host's own
  // lease list: that list is the reading this classification just stopped using.
  const residentIdle = liveBindings(snapshot)
    .filter(({ host, binding }) => host.mode === 'resident' && !runningSet.has(binding.appSessionId))
    .map(({ binding }) => binding.appSessionId);

  return { running, residentIdle };
}

/** The binding one session has on a host, or null when no live host holds it. */
export function findBinding(
  snapshot: SessionHostsSnapshot | null,
  appSessionId: string,
): SessionHostBindingView | null {
  const host = findLiveHost(snapshot, appSessionId);
  return host?.bindings.find((binding) => binding.appSessionId === appSessionId) ?? null;
}

/** How many leases of one kind a binding holds. */
export function countLeases(binding: SessionHostBindingView | null, kind: SessionHostLeaseKind): number {
  return binding ? binding.leases.filter((lease) => lease.kind === kind).length : 0;
}

/**
 * The stored state of one session: its lifecycle mode, whether a live host is
 * holding it, and — for a resident session with no host — why not.
 *
 * This is the reading that survives a restart, which is why the sidebar's mark
 * for a resident session nobody has started comes from here and not from the
 * (absent) host: "should be running and isn't" is a different fact from "is
 * running", and only this half reports it.
 */
export function findSessionHostState(
  snapshot: SessionHostsSnapshot | null,
  appSessionId: string,
): SessionHostStateView | null {
  return snapshot?.sessions.find((session) => session.appSessionId === appSessionId) ?? null;
}

/**
 * The background job holding one conversation, or null when it is free.
 *
 * The single reading behind every read-only affordance on the page — the
 * composer's disabled input and its notice, the status bar's missing Start
 * button, the send path's refusal — so those three cannot disagree about which
 * sessions are held. It is `null` for a snapshot that has not arrived yet, which
 * is the fail-open direction on purpose: nothing has said the session is
 * occupied, and a composer that disabled itself while the first poll was in
 * flight would be unusable on every page load.
 *
 * Read through `findSessionHostState` rather than off the array, so a session
 * the listing does not mention at all (a brand-new one, before its row reaches
 * the listing) answers null instead of throwing.
 */
export function findSessionOccupancy(
  snapshot: SessionHostsSnapshot | null,
  appSessionId: string | null,
): SessionOccupiedBy | null {
  if (!appSessionId) {
    return null;
  }
  return findSessionHostState(snapshot, appSessionId)?.occupiedBy ?? null;
}

/** The shape drawn for each process state — the marks §15.1 of the proposal pins. */
export const RESIDENT_MARK_SHAPES: Record<ResidentProcessState, string> = {
  unstarted: 'hollow',
  idle: 'solid',
  busy: 'solid+spinner',
  exited: 'exited',
  // Neither a spinner nor a solid dot: a busy-looking mark for a state nothing
  // has confirmed is the exact "pretending to think" this vocabulary exists to
  // stop. It is drawn as an outline of its own so it cannot be read as `idle`'s
  // solid dot or `unstarted`'s plain hollow either.
  unknown: 'unknown',
};

/**
 * The UI's word for the state a host is in, or `unstarted` when there is no host.
 *
 * The host's own state machine has six members and the UI has five, so the two
 * have to be reconciled somewhere; this is the only place that happens, and
 * every reader of a process state goes through it. A closed host is kept out of
 * "is it running" but not out of "what happened to it": its `closeReason` is the
 * difference between a session the user closed — which is back to not running —
 * and one whose process died on its own, which keeps the exited state until
 * something restarts it.
 *
 * `lastReadFailed` is the poll's *own* result, not the host's, and it is folded
 * in here rather than checked by each consumer so the mark and the bar cannot
 * disagree about it. When the last read threw, the snapshot on hand is the one
 * from before it — a host that was `busy` a moment ago — and reporting that word
 * as if it were current is a claim nothing is backing: the endpoint that would
 * have said the turn ended is exactly the one that failed. So every host state
 * reads as `unknown` until a read succeeds, at which point the real word returns
 * on the next render. The parameter is optional and defaults to false, so the
 * many existing callers and fakes that pass only a host keep their reading.
 *
 * Total by construction: `idle`, `lingering` and `closing` all land on `idle`,
 * because in none of them is a turn in flight. A lease held open by background
 * work is exactly the case that must not read as busy.
 */
export function readResidentProcessState(
  host: SessionHostView | null,
  lastReadFailed = false,
): ResidentProcessState {
  if (lastReadFailed) {
    return 'unknown';
  }

  if (!host) {
    return 'unstarted';
  }

  if (host.state === 'closed') {
    return host.closeReason === 'exited' ? 'exited' : 'unstarted';
  }

  if (host.state === 'busy' || host.state === 'starting') {
    return 'busy';
  }

  return 'idle';
}

export type UseSessionHostsResult = {
  snapshot: SessionHostsSnapshot | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
  /** Asks the server to start the session's resident process. */
  start: (appSessionId: string) => Promise<void>;
  /** Asks the server to close it. Destructive: the process ends. */
  close: (appSessionId: string) => Promise<void>;
  /**
   * Asks the server to close it even while it holds background work.
   *
   * A separate verb rather than a flag on {@link close} because the two are
   * different operations, not one operation with a modifier: the plain close is
   * refused (409, `SESSION_HAS_ACTIVE_LEASES`) while a cron or background-task
   * lease is held, and this one carries `force: true` past that refusal. The
   * caller chooses which one it means; the hook does not decide for it.
   */
  forceClose: (appSessionId: string) => Promise<void>;
};

/**
 * Subscribes to the shared snapshot and returns it with the two lifecycle verbs.
 *
 * The verbs re-read the snapshot on success so a caller's next render already
 * sees the state its own request produced; on failure they re-throw the server's
 * refusal (a session that is not resident, a session that does not exist) so a
 * caller can show it rather than silently doing nothing. Nothing is checked here
 * — `readApiJson` inside `api.sessionHosts` is what turns a refusal into a throw,
 * and the re-read below it simply does not run when one was thrown.
 */
export function useSessionHosts(): UseSessionHostsResult {
  const store = useSyncExternalStore(subscribe, readState, readState);

  const start = useCallback(async (appSessionId: string): Promise<void> => {
    await api.sessionHosts.start(appSessionId);
    await refreshSessionHosts();
  }, []);

  const close = useCallback(async (appSessionId: string): Promise<void> => {
    await api.sessionHosts.close(appSessionId);
    await refreshSessionHosts();
  }, []);

  const forceClose = useCallback(async (appSessionId: string): Promise<void> => {
    await api.sessionHosts.close(appSessionId, { force: true });
    await refreshSessionHosts();
  }, []);

  return {
    snapshot: store.snapshot,
    error: store.error,
    loading: store.loading,
    refresh: refreshSessionHosts,
    start,
    close,
    forceClose,
  };
}
