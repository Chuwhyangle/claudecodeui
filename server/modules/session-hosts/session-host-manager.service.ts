import { randomUUID } from 'node:crypto';

import type { IProviderHostDriver, IProviderHostDriverSink } from '@/shared/interfaces.js';
import type {
  HostBindResult,
  HostCloseDetail,
  HostCloseReason,
  HostLease,
  HostMode,
  LifecyclePolicy,
  LLMProvider,
  ProcessHost,
  ProviderRuntimeWriter,
  SessionBinding,
} from '@/shared/types.js';

/**
 * One turn the default per-run wrapper is tracking.
 *
 * The host record is what callers read; this record is the private bookkeeping
 * the close decision is computed from. `turnEnded` is set by the terminal frame
 * the runtime writes, `settled` by the run's own promise — and the gap between
 * the two is exactly the held-stdin window that used to be invisible.
 */
type PerRunTurn = {
  appSessionId: string;
  runId: string;
  turnEnded: boolean;
  settled: boolean;
  aborted: boolean;
  /** True once the gap above outlived the macrotask it was observed in. */
  lingering: boolean;
  settleGate: NodeJS.Immediate | null;
};

/**
 * How long a `per-run` host may sit with no `turn` lease before the quiet
 * ceiling closes it.
 *
 * 30 minutes — the same value the Claude runtime holds a run's input for
 * (`BG_WAIT_CEILING_MS` in that runtime's provider file). Same number,
 * deliberately not the same symbol: the runtime's constant is a provider
 * implementation detail and this manager is provider-agnostic, so the default
 * wrapper must not import a runtime module to learn its own policy. Consumed by
 * `DEFAULT_PER_RUN_POLICY` and printed by the lifecycle criterion.
 */
export const PER_RUN_QUIET_CEILING_MS = 30 * 60 * 1000;

/**
 * How long a `resident` host waits for real work before it closes itself.
 *
 * 24 hours, and named because the value is the whole character of the resident
 * mode: the mode exists so that a user can come back to a warm process later in
 * the day, so the ceiling is measured in hours rather than in minutes and
 * cannot be reached by a criterion that waits on a real clock. Consumed by
 * `DEFAULT_RESIDENT_POLICY`, by `server/index.ts`'s shutdown wiring (which
 * bounds how long it waits for hosts to close), and by the lifecycle criterion,
 * which needs to place its deadline without restating the number. This is the
 * *default*: a deployment may raise or lower it through
 * `RESIDENT_IDLE_TIMEOUT_ENV`, and a malformed value there falls back here.
 */
export const RESIDENT_IDLE_TIMEOUT = 24 * 60 * 60 * 1000;

/**
 * The environment variable that overrides the resident idle ceiling.
 *
 * Milliseconds, the unit `RESIDENT_IDLE_TIMEOUT` carries. Named here rather than
 * spelled at the read site so the entry has one address in the code that a
 * reader can grep for; it is deliberately not exported through the module
 * barrel, because its only in-repo consumer is this module's own criterion,
 * which pins the public name independently.
 *
 * Environment rather than the settings store: the process-wide manager is built
 * at module load (`sessionHostManager` below), before a per-user, database-backed
 * setting could be read, and every other process-level timeout in this server
 * (`VOICE_TIMEOUT_MS`, `CLOUDCLI_BROWSER_USE_SESSION_TTL_MS`) is configured the
 * same way.
 */
const RESIDENT_IDLE_TIMEOUT_ENV = 'SESSION_HOST_RESIDENT_IDLE_TIMEOUT_MS';

/**
 * Reads the resident idle ceiling from the environment, falling back to the
 * shipped 24 hours.
 *
 * The single read point for the entry: `createSessionHostManager` calls this
 * once, to build the resident policy's default `quietCeilingMs`, so a manager's
 * ceiling is fixed at construction and every host it opens — the ones already
 * live and the ones to come — is measured against the same number. Malformed
 * values (an empty string, a negative number, zero, a non-numeric string) are
 * the default rather than an error, because a typo in a deployment's environment
 * must not be able to leave a session process unable to come up.
 */
function readResidentIdleTimeoutMs(): number {
  const raw = process.env[RESIDENT_IDLE_TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === '') {
    return RESIDENT_IDLE_TIMEOUT;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : RESIDENT_IDLE_TIMEOUT;
}

/**
 * The policy a provider runs under when nothing binds it to one process.
 *
 * `supersedeOnNewTurn` because a per-run host exists for exactly one turn, so a
 * second turn on the same session cannot be served by the first host;
 * `closeWhenLeasesEmpty` because no reason to keep the process outlives the
 * turn; and a quiet ceiling equal to the Claude runtime's own held-run window.
 * Consumed by `createSessionHostManager` as its `perRunPolicy` default and
 * printed by the lifecycle criterion.
 */
export const DEFAULT_PER_RUN_POLICY: LifecyclePolicy = {
  supersedeOnNewTurn: true,
  closeWhenLeasesEmpty: true,
  quietCeilingMs: PER_RUN_QUIET_CEILING_MS,
};

/**
 * The policy one process serves many turns under.
 *
 * `supersedeOnNewTurn` is false — replacing a resident process defeats the
 * point of the mode — and `closeWhenLeasesEmpty` is false because the
 * `resident-policy` lease is permanent, so "empty" would mean "idle". Consumed
 * by `createSessionHostManager` as its `residentPolicy` default and printed by
 * the lifecycle criterion.
 *
 * The ceiling here is the *shipped* default. `createSessionHostManager` replaces
 * `quietCeilingMs` with the value `readResidentIdleTimeoutMs` reads, so a
 * deployment that configures the entry gets a manager whose ceiling differs from
 * this constant while the constant itself stays the 24-hour default a caller can
 * name.
 */
export const DEFAULT_RESIDENT_POLICY: LifecyclePolicy = {
  supersedeOnNewTurn: false,
  closeWhenLeasesEmpty: false,
  quietCeilingMs: RESIDENT_IDLE_TIMEOUT,
};

/**
 * How long a closed host stays readable in `snapshot()` after it closed.
 *
 * A close reason is only useful while the run that produced it is still recent
 * — "why did that process go away" is a question about a moment, not about a
 * history — so the read port stops answering for a closed host once this window
 * has passed. Five minutes is long enough for a browser that reconnects after a
 * dropped socket to still see how the turn ended, and short enough that the
 * listing does not fill up with a morning's worth of finished processes.
 *
 * Enforced at *read* time rather than by a timer: `snapshot()` compares
 * `closedAt` against the manager's clock, so the window is reachable in a
 * criterion that injects a clock and never waits, and a manager that nobody
 * reads pays nothing for it. Overridable per instance through
 * `SessionHostManagerOptions.closedHostRetentionMs`; the value here is what the
 * process-wide manager uses.
 */
export const CLOSED_HOST_RETENTION_MS = 5 * 60 * 1000;

/**
 * Where the manager puts its pending decisions, so they can be driven by a test
 * clock instead of by the wall clock.
 *
 * The manager never calls `setTimeout` itself; it asks this for a deadline. That
 * is what makes both of its time-dependent rules — the quiet ceiling and the
 * shutdown grace period — reachable in a criterion that must not wait 24 hours,
 * and it is why the seam takes an absolute instant rather than a delay: a
 * scheduler backed by a test clock can order several pending closes by deadline
 * regardless of the order they were scheduled in.
 */
export type HostScheduler = {
  /**
   * Runs `run` once, no earlier than the instant `at`.
   *
   * Returns the cancel handle. Calling it after `run` has already fired must be
   * a no-op, because the manager cancels unconditionally when it closes a host
   * and cannot know whether the deadline just fired.
   */
  schedule(at: number, run: () => void): () => void;
};

/** The real scheduler: one timer per deadline, kept out of the event loop's way. */
const defaultScheduler: HostScheduler = {
  schedule(at, run) {
    const handle = setTimeout(run, Math.max(0, at - Date.now()));
    handle.unref?.();
    return () => clearTimeout(handle);
  },
};

/**
 * One turn a resident process opened by itself, handed to the opener.
 *
 * Carries no command: there is none. A process that starts a turn on its own
 * was not asked to, so what is left to say is *which* conversation the turn
 * belongs to and who should hear about it — which is what the run record needs
 * and all it can be given.
 */
export type UnattendedRunInput = {
  provider: LLMProvider;
  /** The conversation the process is holding; the run is keyed by it. */
  appSessionId: string;
  /** The provider-native id, once the process has announced one. */
  providerSessionId: string | null;
  /** Who to report to; the last turn's own user, since this turn carries none. */
  userId: string | number | null;
  /** What to call the session in a report; likewise carried over. */
  sessionName: string | null;
};

/**
 * What an opener hands back: where the turn's frames go.
 *
 * Deliberately not a run record. The registry that owns runs lives in another
 * module and the frames are the only part of it a driver may touch, so the
 * handle is one field wide — a writer whose `complete` frame is what ends the
 * run on the registry's side.
 */
export type UnattendedRunHandle = {
  writer: ProviderRuntimeWriter;
};

/**
 * How a run gets opened for a turn nobody dispatched.
 *
 * A *seam*, not an implementation: opening a run means writing to the run
 * registry, which belongs to the websocket module — and this module is imported
 * by the providers module, so reaching back would close a cycle. The
 * composition root supplies the opener (see `server/index.ts`), which is where
 * the run registry and this manager are both already in scope.
 *
 * `null` from an opener means no run could be opened — no seam is installed, or
 * the session already has a run in flight — and the caller keeps the mode's old
 * behaviour rather than failing the turn.
 */
export type UnattendedRunOpener = (input: UnattendedRunInput) => UnattendedRunHandle | null;

/**
 * One TURN handed to the opener, whether or not anybody sent it (SPEC §6.1).
 *
 * The generalization of {@link UnattendedRunInput}: both callers are asking the
 * same question — "which run does the turn the CLI just announced belong to" —
 * and they differ only in what they can state about it. A delivered turn names
 * the deliveries the ledger has bound to it; a turn the process opened by itself
 * has none, and says so with `kind: 'unattended'`.
 *
 * The handle is two fields wide rather than one (see {@link UnattendedRunHandle})
 * because a driver on this path has to know the run's id as well as its writer:
 * the id is what the S2 criteria read the turn's identity back by, and a driver
 * that only held the writer could not report which run a folded delivery was
 * bound to.
 */
export type TurnOpenInput = {
  provider: LLMProvider;
  appSessionId: string;
  providerSessionId: string | null;
  userId: string | number | null;
  sessionName?: string | null;
  /** A turn somebody sent (`delivered`) or one the CLI began by itself (`unattended`). */
  kind: 'delivered' | 'unattended';
  /** The deliveries this turn is executing; empty for an unattended turn. */
  deliveryIds?: string[];
};

export type TurnHandle = {
  runId: string;
  writer: ProviderRuntimeWriter;
};

/**
 * How the run of one turn is opened or adopted.
 *
 * The same seam shape as {@link UnattendedRunOpener}, for the same reason: the
 * opener is the run registry, which lives on the far side of an import edge this
 * module may not cross, so the composition root installs it. `null` means no run
 * could be opened — no seam, or an unattended turn arriving while a run is
 * already in flight — and the caller carries on as the mode did before the seam.
 */
export type TurnOpener = (input: TurnOpenInput) => TurnHandle | null;

export type SessionHostManagerOptions = {
  /** Clock seam, so the lifecycle readings are reproducible in tests. */
  now?: () => number;
  /** The unattended-run seam; production supplies it from the composition root. */
  unattendedRunOpener?: UnattendedRunOpener;
  /** The turn-run seam (run=turn); likewise supplied from the composition root. */
  turnOpener?: TurnOpener;
  /** Deadline seam, so the quiet ceiling and the shutdown grace period are reachable in tests. */
  scheduler?: HostScheduler;
  /** Overrides for `DEFAULT_PER_RUN_POLICY`, merged over it. */
  perRunPolicy?: Partial<LifecyclePolicy>;
  /** Overrides for `DEFAULT_RESIDENT_POLICY`, merged over it. */
  residentPolicy?: Partial<LifecyclePolicy>;
  /**
   * How long a closed host stays readable in `snapshot()`.
   *
   * Defaults to `CLOSED_HOST_RETENTION_MS`. A criterion that wants to read both
   * sides of the window injects a clock as well, so it never waits the window
   * out.
   */
  closedHostRetentionMs?: number;
  createHostId?: () => string;
  createRunId?: () => string;
};

/**
 * One turn handed to the manager by the application-facing dispatcher.
 *
 * `start` receives the observing writer the manager builds around `writer`: the
 * caller's own dispatch runs inside it, so the manager sees each frame on its
 * way to the client without being able to alter it.
 */
export type PerRunTurnInput = {
  provider: LLMProvider;
  /** Stable application session id, or null for a caller that has none (then no host is tracked). */
  appSessionId: string | null;
  writer: ProviderRuntimeWriter;
  start(writer: ProviderRuntimeWriter): Promise<unknown>;
};

/**
 * One host a provider is asking the manager to track.
 *
 * `driver` owns the process; the manager owns the record and the close
 * decision. See `openHost` for the order the two are used in.
 */
export type OpenHostInput = {
  provider: LLMProvider;
  mode: HostMode;
  appSessionId: string;
  driver: IProviderHostDriver;
  /** The child pid, when the driver knows it; the default wrapper never does. */
  pid?: number | null;
};

/**
 * One session a provider is asking the manager to place on a process.
 *
 * The difference from `OpenHostInput` is the whole point of `bindSession`: this
 * input names a *session*, not a process. The manager decides which process —
 * reusing a live one when the driver says it can multiplex, opening a fresh one
 * otherwise — and answers with a `HostBindResult` rather than with a host, so a
 * refusal is a value the caller branches on instead of an exception.
 *
 * `mode` defaults to `resident`, which is the shape multiplexing belongs to: a
 * process that outlives one conversation. A caller that wants the per-run
 * wrapper's policy (one host per turn, superseded on the next) names it, and
 * that is also the mode under which the supersede-before-start ordering below
 * becomes reachable.
 */
export type BindSessionInput = {
  provider: LLMProvider;
  appSessionId: string;
  driver: IProviderHostDriver;
  mode?: HostMode;
  /** The child pid, when the driver knows it; the default wrapper never does. */
  pid?: number | null;
};

/**
 * What one `shutdown()` closed, and how.
 *
 * `forced` is the interesting half: a host the driver had still not settled when
 * the grace period expired, closed out from under it and recorded with
 * `closeDetail: 'forced'` so the gap is visible rather than silent.
 */
export type ShutdownSummary = {
  /** Hosts this call closed, in the order they were found. */
  closed: string[];
  /** Hosts whose driver did not settle in time and were closed anyway. */
  forced: string[];
};

/**
 * Owns the process-host view of every provider, in every lifecycle mode.
 *
 * Consumed by the providers module's `provider-runtime.service` (which routes
 * every dispatched run through `trackPerRunTurn`) and by this module's
 * criterion tests, which read `snapshot()`. The manager never touches frames: it
 * wraps the caller's writer with an observing proxy and forwards each frame
 * unchanged.
 *
 * Two indices back it — `hostId → host` for reads and `appSessionId → hostId`
 * to enforce the single-writer invariant (a new turn supersedes the host a
 * previous turn was still holding). Closed hosts stay readable so a close reason
 * survives the run that produced it, and they leave the read port —
 * `snapshot()`, which is what the host-listing route reads — once
 * `CLOSED_HOST_RETENTION_MS` has passed since they closed. Nothing is ever
 * collected from the underlying index; only the read port expires.
 *
 * State is derived from leases, never from an event: `deriveState` recomputes
 * `host.state` from the union of the binding's leases every time one is added or
 * removed, so a close decision can only be wrong if a *lease* is wrong. There
 * are two ways leases arrive. A provider that owns its process through a host
 * driver reports them through the sink `openHost` hands over — the driver is the
 * only party that knows a background task or a cron job is still running. The
 * default per-run wrapper has no driver and instead infers the single `turn`
 * lease from what it observes on the wire (the terminal frame) and on the run's
 * promise, which is what `endTurn`/`settleTurn` below do.
 */
export function createSessionHostManager(options: SessionHostManagerOptions = {}) {
  const now = options.now ?? (() => Date.now());
  const scheduler = options.scheduler ?? defaultScheduler;
  const createHostId = options.createHostId ?? (() => `host-${randomUUID()}`);
  const createRunId = options.createRunId ?? (() => `run-${randomUUID()}`);
  const perRunPolicy: LifecyclePolicy = { ...DEFAULT_PER_RUN_POLICY, ...options.perRunPolicy };
  // The idle ceiling is the one policy field a deployment configures: the entry
  // is read here, once, and an explicit `residentPolicy` override still wins over
  // it. The shipped per-run ceiling is untouched — the entry is about how long a
  // resident process stays warm, not about how long a finished turn is held.
  const residentPolicy: LifecyclePolicy = {
    ...DEFAULT_RESIDENT_POLICY,
    quietCeilingMs: readResidentIdleTimeoutMs(),
    ...options.residentPolicy,
  };
  const closedHostRetentionMs = options.closedHostRetentionMs ?? CLOSED_HOST_RETENTION_MS;
  /**
   * The unattended-run seam, held mutably because it is wired after this
   * manager is built.
   *
   * The opener lives in the websocket module, which imports this one, so the
   * composition root — the one place both are in scope — installs it through
   * `setUnattendedRunOpener` right after construction. It stays optional: a
   * manager with no opener is a manager in a process that has no run registry,
   * which is a supported shape (every criterion test that constructs one
   * directly), and there an unattended turn keeps the mode's old behaviour.
   */
  let unattendedRunOpener: UnattendedRunOpener | null = options.unattendedRunOpener ?? null;
  /**
   * The turn-run seam, held mutably for the same reason and wired the same way.
   *
   * The run=turn path (`RESIDENT_RUN_IS_TURN`) needs the run registry at a turn
   * boundary the older opener cannot express — the run belongs to the turn, and
   * the driver has to be told its id, not just its writer — so it is a second
   * late-bound seam rather than a widening of the first. A manager with no turn
   * opener is the shape every criterion that builds one directly already has, and
   * on that manager a resident turn keeps the flag-off behaviour.
   */
  let turnOpener: TurnOpener | null = options.turnOpener ?? null;

  const hosts = new Map<string, ProcessHost>();
  /**
   * When each host closed, so `snapshot()` can expire it.
   *
   * A side index rather than a field on `ProcessHost` because the instant is
   * the manager's own bookkeeping: nothing that reads a host has a question
   * whose answer is "when did this close" that `closeReason` does not already
   * answer better, and the record type is shared with the client.
   */
  const closedAtByHostId = new Map<string, number>();
  const hostIdByAppSession = new Map<string, string>();
  const perRunTurns = new Map<string, PerRunTurn>();
  const driverByHostId = new Map<string, IProviderHostDriver>();
  /** Cancel handles for the armed quiet ceiling, one per host at most. */
  const quietHandles = new Map<string, () => void>();
  /** How each close is settling, so `shutdown()` can await the whole set. */
  const pendingCloseByHost = new Map<string, Promise<void>>();

  /**
   * Subscribers told whenever the host listing changes, and the revision that
   * numbers each change.
   *
   * The listing used to have no event at all — a client could only re-read
   * `GET /api/session-hosts` on a timer — which is why the browser polled it once
   * a second. The revision is what lets a client tell a frame it has already
   * acted on from a fresh one (frames can arrive out of order across a
   * reconnect), so it is bumped by the announcement rather than derived from the
   * host records: two changes that leave the records identical are still two
   * changes a reader has to observe.
   */
  const changeListeners = new Set<(rev: number) => void>();
  let listingRev = 0;

  /**
   * Announces one change to the host listing.
   *
   * Called once from the end of every write that can move what a reader of
   * `snapshot()` sees. The internal callers are the state machine's own
   * transitions (`deriveState`, `closeHost`, and the binding writes that do not
   * go through them); the external one is the providers module's session
   * create/rename paths, which change the listing's `sessions[]` half without
   * touching a host. A listener that throws is isolated rather than allowed to
   * unwind a caller's state transition — the announcement is a notification, not
   * a step the state machine depends on.
   *
   * Public because it is the composition root's wire between this manager and
   * the websocket broadcast, and because the providers module reaches it through
   * this module's barrel.
   */
  function notifyHostsChanged(): void {
    listingRev += 1;
    for (const listener of changeListeners) {
      try {
        listener(listingRev);
      } catch (error) {
        console.error('[session-hosts] a host-listing listener threw', error);
      }
    }
  }

  /**
   * Subscribes to host-listing changes. Returns the unsubscribe function.
   *
   * Consumed by the composition root, which forwards each revision to the
   * websocket broadcast. The listener receives the new revision so the frame it
   * produces can be de-duplicated by a client that has already applied it.
   */
  function onChange(listener: (rev: number) => void): () => void {
    changeListeners.add(listener);
    return () => {
      changeListeners.delete(listener);
    };
  }

  function policyFor(mode: HostMode): LifecyclePolicy {
    return mode === 'resident' ? residentPolicy : perRunPolicy;
  }

  function findBinding(appSessionId: string): { host: ProcessHost; binding: SessionBinding } | null {
    const hostId = hostIdByAppSession.get(appSessionId);
    if (!hostId) {
      return null;
    }
    const host = hosts.get(hostId);
    const binding = host?.bindings.get(appSessionId);
    return host && binding ? { host, binding } : null;
  }

  /**
   * Stamps the instant the manager starts counting a held-work lease.
   *
   * Only `background-task` and `monitor` carry `since`: `turn` is held for the
   * length of one run, which the run registry already times, and `cron` has its
   * own `expiresAt`. A driver-supplied instant wins, then a still-present lease
   * for the same key keeps its original one — {@link addLease} replaces rather
   * than appends, so a driver that reports the same hold twice does not restart
   * the clock — and a genuinely new hold is stamped with the manager's own
   * clock, which is what makes the reading reproducible in tests.
   */
  function withLeaseSince(lease: HostLease, at: number, previous?: HostLease): HostLease {
    if (lease.kind !== 'background-task' && lease.kind !== 'monitor') {
      return lease;
    }
    const carried =
      typeof lease.since === 'number'
        ? lease.since
        : previous && (previous.kind === 'background-task' || previous.kind === 'monitor')
          ? previous.since
          : undefined;
    return { ...lease, since: carried ?? at };
  }

  /** Identifies a lease for replacement: a binding holds at most one per (kind, id). */
  function leaseKey(lease: HostLease): string {
    switch (lease.kind) {
      case 'turn':
        return `turn:${lease.runId}`;
      case 'cron':
        return `cron:${lease.id}`;
      case 'resident-policy':
        return 'resident-policy';
      default:
        return `${lease.kind}:${lease.id}`;
    }
  }

  function cancelQuietClose(hostId: string): void {
    const cancel = quietHandles.get(hostId);
    quietHandles.delete(hostId);
    cancel?.();
  }

  /**
   * Arms (or re-arms) the quiet ceiling for a host that is not serving a turn.
   *
   * The window is counted from `lastActivityAt`, so this is called after every
   * activity as well as after every lease change — re-arming rather than
   * leaving the old deadline in place is what makes "any real activity resets
   * it" true.
   */
  function armQuietClose(host: ProcessHost, binding: SessionBinding): void {
    cancelQuietClose(host.hostId);
    const startsAt = binding.lastActivityAt;
    host.quietWindowStartAt = startsAt;
    host.quietDeadlineAt = startsAt + policyFor(host.mode).quietCeilingMs;
    quietHandles.set(
      host.hostId,
      scheduler.schedule(host.quietDeadlineAt, () => onQuietDeadline(host.hostId)),
    );
  }

  /** A host serving a turn is never on the quiet clock; it is not quiet. */
  function clearQuietClose(host: ProcessHost): void {
    cancelQuietClose(host.hostId);
    host.quietWindowStartAt = null;
    host.quietDeadlineAt = null;
  }

  /**
   * The quiet ceiling came due.
   *
   * An unexpired cron lease means the host is still held for a reason that has
   * not run out, so the deadline is re-counted from that lease's `expiresAt`
   * rather than from the activity that started the first window — the recurring
   * job keeps its host until its own expiry, then the host gets a fresh quiet
   * window on top of that.
   */
  function onQuietDeadline(hostId: string): void {
    quietHandles.delete(hostId);
    const host = hosts.get(hostId);
    if (!host || host.state === 'closed') {
      return;
    }
    const binding = firstBinding(host);
    if (!binding) {
      return;
    }

    const unexpired = binding.leases.filter(
      (lease): lease is Extract<HostLease, { kind: 'cron' }> =>
        lease.kind === 'cron' && lease.expiresAt > now(),
    );
    if (unexpired.length > 0) {
      const expiresAt = Math.max(...unexpired.map((lease) => lease.expiresAt));
      host.quietWindowStartAt = expiresAt;
      host.quietDeadlineAt = expiresAt + policyFor(host.mode).quietCeilingMs;
      quietHandles.set(
        hostId,
        scheduler.schedule(host.quietDeadlineAt, () => onQuietDeadline(hostId)),
      );
      return;
    }

    // Which reason the close is recorded under is the *mode's* answer, not the
    // state's: a resident host that went quiet ended because it was idle, and a
    // per-run host that went quiet released a process it no longer needed.
    closeHost(hostId, host.mode === 'resident' ? 'idle' : 'released');
  }

  function firstBinding(host: ProcessHost): SessionBinding | null {
    for (const binding of host.bindings.values()) {
      return binding;
    }
    return null;
  }

  /**
   * Recomputes a host's state from the union of its binding's leases.
   *
   * The single place `host.state` is decided outside a close. `releasedKind` is
   * the lease that just went away, and is used only to name the close when the
   * removal emptied the set: a turn ending is `turn-complete`, anything else
   * releasing its last claim is `released`.
   *
   * Returns whether the recomputation closed the host. A close announces itself
   * through `closeHost`, so the caller uses this to avoid announcing the same
   * transition a second time.
   */
  function applyDerivedState(
    host: ProcessHost,
    binding: SessionBinding,
    releasedKind: HostLease['kind'] | null,
  ): boolean {
    if (host.state === 'closed') {
      return false;
    }

    if (binding.leases.some((lease) => lease.kind === 'turn')) {
      host.state = 'busy';
      binding.state = 'busy';
      clearQuietClose(host);
      return false;
    }

    binding.state = 'idle';
    const held = binding.leases.find((lease) => lease.kind !== 'resident-policy');
    if (held) {
      host.state = 'lingering';
      armQuietClose(host, binding);
      return false;
    }

    if (binding.leases.length > 0) {
      // Resident mode: the only lease left is `resident-policy`, which is the
      // mode's statement that this process is meant to sit here between turns.
      host.state = 'idle';
      armQuietClose(host, binding);
      return false;
    }

    if (host.state === 'starting') {
      // A host that has never held a lease is waiting for its first, not idle.
      // Both production callers grant one in the same tick they open the host —
      // the default wrapper a `turn` lease, resident mode a `resident-policy` —
      // so this state is not reachable through the application; it exists so
      // that opening a host and arming its clock are not the same act.
      armQuietClose(host, binding);
      return false;
    }

    if (policyFor(host.mode).closeWhenLeasesEmpty) {
      closeHost(host.hostId, releasedKind === 'turn' ? 'turn-complete' : 'released');
      return true;
    }

    host.state = 'idle';
    armQuietClose(host, binding);
    return false;
  }

  /**
   * Recomputes a host's state and announces the change exactly once.
   *
   * A recomputation that closes the host announces through `closeHost`; every
   * other recomputation is one change to the listing — the state word, the lease
   * set and `lastActivityAt` are all things `snapshot()` publishes — so it is
   * announced here once. Callers guard against a closed host before calling, so
   * the early return below is a safety net rather than a path.
   */
  function deriveState(
    host: ProcessHost,
    binding: SessionBinding,
    releasedKind: HostLease['kind'] | null,
  ): void {
    if (host.state === 'closed') {
      return;
    }
    if (!applyDerivedState(host, binding, releasedKind)) {
      notifyHostsChanged();
    }
  }

  /**
   * Closes a host and records why.
   *
   * The driver is told, never asked: `closeHost` on the driver is the manager
   * relaying a decision it has already made, and its promise is collected
   * rather than awaited so that a driver that takes its time cannot block the
   * state machine. `shutdown()` is the one caller that awaits it.
   */
  function closeHost(
    hostId: string,
    reason: HostCloseReason,
    detail: HostCloseDetail | null = null,
  ): void {
    const host = hosts.get(hostId);
    if (!host || host.state === 'closed') {
      return;
    }

    host.state = 'closed';
    host.closeReason = reason;
    host.closeDetail = detail;
    // Stamped here rather than read off `host`, so the retention window is
    // anchored at the moment the close happened and not at the moment someone
    // asks about it.
    closedAtByHostId.set(hostId, now());
    clearQuietClose(host);

    for (const [appSessionId, binding] of host.bindings) {
      binding.leases = [];
      binding.state = 'idle';
      binding.detachReason = reason;
      binding.lastActivityAt = now();
      if (hostIdByAppSession.get(appSessionId) === hostId) {
        hostIdByAppSession.delete(appSessionId);
      }
    }

    const turn = perRunTurns.get(hostId);
    if (turn?.settleGate) {
      clearImmediate(turn.settleGate);
      turn.settleGate = null;
    }

    const driver = driverByHostId.get(hostId);
    driverByHostId.delete(hostId);
    if (!driver) {
      pendingCloseByHost.set(hostId, Promise.resolve());
    } else {
      try {
        // A driver that rejects is not a shutdown failure: the host is gone
        // either way, and the reason it was closed is already recorded.
        pendingCloseByHost.set(
          hostId,
          Promise.resolve(driver.closeHost(host, reason)).then(
            () => undefined,
            () => undefined,
          ),
        );
      } catch {
        pendingCloseByHost.set(hostId, Promise.resolve());
      }
    }

    // One announcement per close, after the record is fully torn down: a
    // listener that re-reads the snapshot must see the closed host whole, not a
    // record with its state flipped and its bindings still attached.
    notifyHostsChanged();
  }

  /**
   * Closes a host and answers with the driver's own settling.
   *
   * `closeHost` deliberately does not await the driver — a driver that takes its
   * time must not be able to stall the state machine — but one caller genuinely
   * needs the wait: `bindSession`'s supersede path, which may not start the
   * replacement process until the old one's driver has acknowledged the close.
   * The promise awaited is the same one `shutdown()` collects, so "closed" means
   * the same thing on both paths.
   *
   * A host that was already closed has no pending close, and awaiting a resolved
   * promise is the right answer there: nothing is outstanding.
   */
  async function closeHostAndWait(hostId: string, reason: HostCloseReason): Promise<void> {
    closeHost(hostId, reason);
    await (pendingCloseByHost.get(hostId) ?? Promise.resolve());
  }

  /**
   * Reports that the process is gone, without asking the driver to kill it.
   *
   * The sink's `exited` and a driver that threw while starting both land here.
   * Calling `closeHost` on the driver would be asking it to terminate something
   * that is already gone.
   */
  function reportExited(hostId: string, detail: HostCloseDetail): void {
    driverByHostId.delete(hostId);
    closeHost(hostId, 'exited', detail);
  }

  /**
   * Adds one reason for the host to keep running and re-derives its state.
   *
   * Consumed by the driver sink (`leaseAdded`) and, for the single `turn` lease,
   * by `openHost`'s own callers. Returns whether a live binding accepted it.
   */
  function addLease(appSessionId: string, lease: HostLease): boolean {
    const found = findBinding(appSessionId);
    if (!found || found.host.state === 'closed') {
      return false;
    }

    const { host, binding } = found;
    const key = leaseKey(lease);
    const previous = binding.leases.find((existing) => leaseKey(existing) === key);
    binding.leases = [
      ...binding.leases.filter((existing) => leaseKey(existing) !== key),
      withLeaseSince(lease, now(), previous),
    ];
    binding.lastActivityAt = now();
    deriveState(host, binding, null);
    return true;
  }

  /**
   * Drops every lease of one kind and re-derives the host's state.
   *
   * By kind rather than by lease because that is the granularity a driver
   * reports at: "the background task finished" is a statement about the reason,
   * and a host holds at most one claim per reason per binding.
   */
  function removeLease(appSessionId: string, kind: HostLease['kind']): boolean {
    const found = findBinding(appSessionId);
    if (!found || found.host.state === 'closed') {
      return false;
    }

    const { host, binding } = found;
    const remaining = binding.leases.filter((lease) => lease.kind !== kind);
    if (remaining.length === binding.leases.length) {
      return false;
    }

    binding.leases = remaining;
    binding.lastActivityAt = now();
    deriveState(host, binding, kind);
    return true;
  }

  /**
   * Records a browser attaching to the session — and deliberately nothing else.
   *
   * The proposal's rule (`claude-resident-sessions.md` §323) is that a browser
   * opening or sitting on a session is *not* activity: if attaching counted, a
   * resident process would be kept warm by a tab nobody is typing into, which
   * is the opposite of what the idle ceiling is for. This entry point exists so
   * that rule has a production address to be tested against rather than being
   * an absence a criterion can only assume; `noteActivity` is its
   * counterpart. Returns whether a live binding was found.
   */
  function attachViewer(appSessionId: string): boolean {
    const found = findBinding(appSessionId);
    return found !== null && found.host.state !== 'closed';
  }

  /**
   * Records real work on the session and pushes the quiet deadline out.
   *
   * Consumed by the driver sink (`activity`) and by callers that know a frame
   * moved. This is the only thing besides a lease change that moves
   * `lastActivityAt`.
   */
  function noteActivity(appSessionId: string): boolean {
    const found = findBinding(appSessionId);
    if (!found || found.host.state === 'closed') {
      return false;
    }

    found.binding.lastActivityAt = now();
    // Re-derived so the quiet window is re-counted from the new activity, but
    // deliberately *not* announced: this runs on every message a process emits
    // (a streamed frame, a tool call), and the only listing field it moves is
    // `lastActivityAt`, which no client reads. Announcing here would put a
    // `hosts_changed` frame on the wire per streamed frame — the one-second poll
    // this change removes, restated as a push. `applyDerivedState` is the
    // announcement-free half of `deriveState`.
    applyDerivedState(found.host, found.binding, null);
    return true;
  }

  /**
   * Records the address the binding's own process answers to.
   *
   * Deliberately not `noteActivity`: the process stating its name is not work,
   * and counting it as work would let a process keep its own quiet deadline
   * pushed out by nothing but coming up. This is the one write that changes
   * what a caller can *do* with the binding — `peerName` is what the REST view
   * publishes so another session has somewhere to send — so a stale value
   * would be worse than a missing one; hence the refusal to invent one when no
   * live binding is found, and the driver's rule of reporting only names it
   * read back from the process itself.
   *
   * The driver may report it more than once over a host's life: the startup read,
   * then a re-read once a title-adoption frame moves the process's registered
   * name. This verb overwrites, so the projection follows the process's own
   * registry rather than freezing the first reading it was handed — a name the
   * process no longer answers to is exactly the stale address this write exists
   * to prevent.
   */
  function recordIdentity(appSessionId: string, peerName: string | null): boolean {
    const found = findBinding(appSessionId);
    if (!found || found.host.state === 'closed') {
      return false;
    }

    found.binding.peerName = peerName;
    // `peerName` is published by the listing, so a rebind of the address is a
    // change a reader has to observe even though no state word moved.
    notifyHostsChanged();
    return true;
  }

  /** Closes the host bound to this session, if one is live. */
  function closeSessionHost(appSessionId: string, reason: HostCloseReason): boolean {
    const hostId = hostIdByAppSession.get(appSessionId);
    if (!hostId) {
      return false;
    }
    closeHost(hostId, reason);
    return true;
  }

  /**
   * The sink every driver receives from `openHost`.
   *
   * One object rather than one per host, because every verb is already
   * addressed — three by session id, `exited` by host id — so there is no
   * per-host state for a closure to hold.
   */
  const driverSink: IProviderHostDriverSink = {
    leaseAdded: addLease,
    leaseRemoved: removeLease,
    activity: noteActivity,
    identity: recordIdentity,
    exited: (event) => reportExited(event.hostId, event.detail),
  };

  /** A detached copy, so a reader cannot mutate the manager's state through it. */
  function copyHost(host: ProcessHost): ProcessHost {
    return {
      ...host,
      bindings: new Map(
        [...host.bindings].map(([appSessionId, binding]) => [
          appSessionId,
          { ...binding, leases: binding.leases.map((lease) => ({ ...lease })) },
        ]),
      ),
      // The nested halves are copied too, not shared with the live record. Every
      // other sub-object here is rebuilt for the same reason: a copy that a
      // reader could reach into and find moving under it is not a copy, and this
      // one is written by a driver while the host is being opened.
      remoteControl: host.remoteControl
        ? {
            ...host.remoteControl,
            requested: { ...host.remoteControl.requested },
            detected: { ...host.remoteControl.detected },
            launched: host.remoteControl.launched ? { ...host.remoteControl.launched } : null,
          }
        : (host.remoteControl ?? null),
    };
  }

  /**
   * Opens a host for a provider that owns its process through a driver.
   *
   * The order matters and is the whole contract with a driver: the record is
   * registered first (so `startHost` sees a host the manager already tracks),
   * then the driver is asked to start it and bind its first session. A driver
   * that throws while starting leaves no live host behind — the record is closed
   * as `exited`/`error`, which is the truth about a process that never came up.
   *
   * The host's opening lease is the mode's, not the caller's: resident mode is
   * opened holding `resident-policy` (which is what makes it `idle` rather than
   * closable), while a per-run host is opened holding nothing and stays
   * `starting` until its driver reports the turn. Consumed by providers that
   * implement `IProviderHostDriver`.
   */
  async function openHost(input: OpenHostInput): Promise<ProcessHost> {
    const { provider, mode, appSessionId, driver } = input;

    if (policyFor(mode).supersedeOnNewTurn) {
      const superseded = hostIdByAppSession.get(appSessionId);
      if (superseded) {
        closeHost(superseded, 'superseded');
      }
    }

    const binding = createBinding(appSessionId, mode);
    const host: ProcessHost = {
      hostId: createHostId(),
      provider,
      mode,
      state: 'starting',
      pid: input.pid ?? null,
      startedAt: now(),
      bindings: new Map([[appSessionId, binding]]),
      closeReason: null,
      closeDetail: null,
      quietDeadlineAt: null,
      quietWindowStartAt: null,
    };

    hosts.set(host.hostId, host);
    hostIdByAppSession.set(appSessionId, host.hostId);
    driverByHostId.set(host.hostId, driver);

    deriveState(host, binding, null);

    try {
      await driver.startHost(host, driverSink);
      await driver.bind(host, binding);
    } catch (error) {
      reportExited(host.hostId, 'error');
      throw error;
    }

    return copyHost(host);
  }

  /**
   * Places one session on a process, or refuses and says why.
   *
   * The production entry point for a provider that owns its process: a caller
   * names the session, and the manager answers which host it landed on. The
   * three rules it enforces, in the order it enforces them, are the whole of
   * the host/session cardinality contract:
   *
   *  1. **Supersede before start.** A policy with `supersedeOnNewTurn` lets a new
   *     turn on a session replace the host a previous turn left `lingering` —
   *     but the old host's driver is *awaited* before the replacement is opened.
   *     The order is not stylistic: the old binding must be gone before the new
   *     one is written, or the new bind would collide with the single-writer
   *     index it is about to replace. Closing first is what makes the new bind
   *     legal rather than an exception to rule 2.
   *  2. **One binding per session.** A session that is already bound is refused
   *     with `session-already-bound` and the id of the host that holds it —
   *     whichever host the request was aimed at, because the conflict is with
   *     the session, not with the target.
   *  3. **One conversation per process, unless the driver says otherwise.** A
   *     live host for the same provider and mode is reused only when its driver
   *     declares `multiplexedHost === true`; otherwise the second binding is
   *     refused with `host-not-multiplexed`. Refusing rather than silently
   *     starting a second process keeps the driver's declaration load-bearing in
   *     both directions, and keeps a misplaced `bindSession` from looking like a
   *     successful multiplex when the process is in fact single-conversation.
   *
   * A refusal writes nothing: no host is opened, no binding is added, so a
   * failed bind never leaves the target host holding a session the caller was
   * told it did not get.
   */
  async function bindSession(input: BindSessionInput): Promise<HostBindResult> {
    const { provider, appSessionId, driver } = input;
    const mode = input.mode ?? 'resident';

    const existingHostId = hostIdByAppSession.get(appSessionId);
    if (existingHostId) {
      const existing = hosts.get(existingHostId);
      const supersedes =
        existing !== undefined && existing.state === 'lingering' && policyFor(mode).supersedeOnNewTurn;
      if (!supersedes) {
        return { ok: false, code: 'session-already-bound', existingHostId };
      }
      await closeHostAndWait(existingHostId, 'superseded');
    }

    const reuse = findReusableHost(provider, mode);
    if (!reuse) {
      const host = await openHost({ provider, mode, appSessionId, driver, pid: input.pid });
      return { ok: true, hostId: host.hostId };
    }
    if (driver.multiplexedHost !== true) {
      return { ok: false, code: 'host-not-multiplexed', existingHostId: reuse.hostId };
    }

    const binding = createBinding(appSessionId, mode);
    reuse.bindings.set(appSessionId, binding);
    hostIdByAppSession.set(appSessionId, reuse.hostId);
    deriveState(reuse, binding, null);
    await driver.bind(reuse, binding);

    return { ok: true, hostId: reuse.hostId };
  }

  /**
   * Detaches one session and closes the host only when it was the last one.
   *
   * The driver is told about the detach even when it is the final binding — the
   * detach and the process kill are different acts, and a driver that has to
   * release a conversation before its process dies is entitled to hear about it
   * — and then the manager decides the host's fate from what is left:
   *
   *  - Bindings remain: the host stays open, and the remaining bindings are
   *    deliberately *not* re-derived. Nothing about them changed, so recomputing
   *    their state could only introduce a difference; leaving them byte-identical
   *    is the invariant a multiplexed process depends on.
   *  - Nothing remains: the host is closed under the *caller's* reason, so a host
   *    let go because the user closed a tab records `user` rather than a generic
   *    release. The close is awaited, which makes the return value a statement
   *    about a settled process.
   *
   * Idempotent: a second detach for the same session finds no binding (the
   * single-writer index was cleared with the first) and touches no driver, so
   * "closed exactly once" is reachable as a reading rather than assumed.
   * Returns whether a live binding was found and detached.
   */
  async function unbindSession(appSessionId: string, reason: HostCloseReason): Promise<boolean> {
    const hostId = hostIdByAppSession.get(appSessionId);
    const host = hostId ? hosts.get(hostId) : undefined;
    const binding = host?.bindings.get(appSessionId);
    if (!host || !binding) {
      return false;
    }

    const driver = driverByHostId.get(host.hostId);
    if (driver) {
      await driver.unbind(host, appSessionId, reason);
    }

    host.bindings.delete(appSessionId);
    if (hostIdByAppSession.get(appSessionId) === host.hostId) {
      hostIdByAppSession.delete(appSessionId);
    }

    if (host.bindings.size > 0) {
      // The host survived the detach, so nothing goes through `closeHost`: the
      // listing changed here (a binding left it) and is announced here.
      notifyHostsChanged();
      return true;
    }

    await closeHostAndWait(host.hostId, reason);
    return true;
  }

  /**
   * The live host a new binding would land on, or null when none exists.
   *
   * Scoped to one provider and one mode, because a binding is a conversation
   * inside a process and neither a foreign provider's process nor a process
   * opened under the other mode's policy can host it. The newest matching host
   * wins, and the choice is deterministic rather than a judgement: hosts are
   * iterated in insertion order, so "newest" is a property of the record, not of
   * a clock reading two hosts could share. The newest is chosen because it is
   * the process most recently brought up — the one whose warm state is freshest
   * — and because packing onto it leaves the older hosts on their own paths to
   * the quiet ceiling instead of making them immortal.
   */
  function findReusableHost(provider: LLMProvider, mode: HostMode): ProcessHost | null {
    let reuse: ProcessHost | null = null;
    for (const host of hosts.values()) {
      if (host.state === 'closed' || host.provider !== provider || host.mode !== mode) {
        continue;
      }
      reuse = host;
    }
    return reuse;
  }

  /**
   * One session's record inside a host, with the mode's opening reason.
   *
   * Resident mode is opened holding `resident-policy` — the mode's statement
   * that the process is meant to sit between turns — and per-run mode holds
   * nothing until a turn arrives. Shared by `openHost` and `bindSession` so a
   * reused binding is opened by the same rule as the first one; two copies of
   * this literal is how a multiplexed host would end up with bindings that are
   * not equivalent.
   */
  function createBinding(appSessionId: string, mode: HostMode): SessionBinding {
    return {
      appSessionId,
      providerSessionId: null,
      state: 'idle',
      leases: mode === 'resident' ? [{ kind: 'resident-policy' }] : [],
      lastActivityAt: now(),
      peerName: null,
      detachReason: null,
    };
  }

  /**
   * Wraps the caller's writer so each frame is observed on its way through.
   *
   * A proxy rather than a copy: the runtimes read capability flags off the
   * writer (`isWebSocketWriter`, `isSSEStreamWriter`) and the SSE writer keeps
   * its own request state on `this`, so the manager must hand over the very same
   * object with only `send` (and the provider-session-id announcement) observed.
   */
  function createObservingWriter(
    writer: ProviderRuntimeWriter,
    host: ProcessHost,
    turn: PerRunTurn,
  ): ProviderRuntimeWriter {
    const observingSend = (data: unknown): void => {
      if ((data as { kind?: unknown } | null | undefined)?.kind === 'complete') {
        endTurn(host.hostId);
      }
      writer.send(data);
    };

    const observingSetSessionId =
      typeof writer.setSessionId === 'function'
        ? (sessionId: string): void => {
            const binding = host.bindings.get(turn.appSessionId);
            if (binding && sessionId) {
              binding.providerSessionId = sessionId;
            }
            writer.setSessionId?.(sessionId);
          }
        : undefined;

    return new Proxy(writer, {
      get(target, property, receiver) {
        if (property === 'send') {
          return observingSend;
        }
        if (property === 'setSessionId' && observingSetSessionId) {
          return observingSetSessionId;
        }
        return Reflect.get(target, property, receiver);
      },
    });
  }

  /** Drops the `turn` lease and decides whether the host is done or held open. */
  function endTurn(hostId: string): void {
    const host = hosts.get(hostId);
    const turn = perRunTurns.get(hostId);
    if (!host || !turn || host.state === 'closed' || turn.turnEnded) {
      return;
    }

    turn.turnEnded = true;
    const binding = host.bindings.get(turn.appSessionId);
    if (binding) {
      binding.leases = binding.leases.filter((lease) => lease.kind !== 'turn');
      binding.state = 'idle';
      binding.lastActivityAt = now();
    }

    if (turn.settled) {
      closeHost(hostId, 'turn-complete');
      return;
    }

    // The terminal frame has arrived while the run's promise is still pending.
    // That is the shape of Claude's held-stdin window — but it is also the shape
    // of a run whose complete frame is written a tick before it resolves, so the
    // host only becomes `lingering` if the gap outlives the macrotask it was
    // opened in. Every provider that ends its turn by exiting (its complete frame
    // comes from the process-exit handler) settles first and stays `turn-complete`.
    turn.settleGate = setImmediate(() => {
      turn.settleGate = null;
      if (!turn.settled && host.state !== 'closed') {
        turn.lingering = true;
        host.state = 'lingering';
        // The held-stdin window outlived its macrotask: the host moved from
        // `busy` to `lingering`, which is the change announced here. A run that
        // settles inside that macrotask closes instead, and `closeHost`
        // announces that one — so a turn end is exactly one announcement
        // whichever shape it takes.
        notifyHostsChanged();
      }
    });
    turn.settleGate.unref?.();
  }

  /** Records that the run's promise is done and closes the host under it. */
  function settleTurn(hostId: string): void {
    const host = hosts.get(hostId);
    const turn = perRunTurns.get(hostId);
    if (!host || !turn || turn.settled) {
      return;
    }

    turn.settled = true;
    if (turn.settleGate) {
      clearImmediate(turn.settleGate);
      turn.settleGate = null;
    }
    if (host.state === 'closed') {
      return;
    }
    if (turn.aborted) {
      closeHost(hostId, 'aborted');
      return;
    }
    if (!turn.turnEnded) {
      // The run ended without ever writing a terminal frame: the process went
      // away on its own rather than finishing a turn.
      closeHost(hostId, 'exited', 'error');
      return;
    }

    closeHost(hostId, turn.lingering ? 'released' : 'turn-complete');
  }

  /**
   * Registers one application session against the run about to be dispatched.
   *
   * Consumed by the providers module's `provider-runtime.service.run`, which
   * calls this instead of the runtime directly, so every turn dispatched through
   * the application has a host.
   */
  function trackPerRunTurn(input: PerRunTurnInput): Promise<unknown> {
    const { provider, appSessionId, writer, start } = input;

    // A caller with no application session id has nothing to bind a host to;
    // dispatch it unchanged so such callers keep the behavior they had.
    if (!appSessionId) {
      return start(writer);
    }

    const supersededHostId = hostIdByAppSession.get(appSessionId);
    if (supersededHostId) {
      closeHost(supersededHostId, 'superseded');
    }

    const runId = createRunId();
    const binding: SessionBinding = {
      appSessionId,
      providerSessionId: null,
      state: 'busy',
      leases: [{ kind: 'turn', runId } satisfies HostLease],
      lastActivityAt: now(),
      // A per-run host has no address: its process lives for one turn, so a name
      // handed to it would be gone before a peer could use it.
      peerName: null,
      detachReason: null,
    };
    const host: ProcessHost = {
      hostId: createHostId(),
      provider,
      mode: 'per-run',
      state: 'busy',
      pid: null,
      startedAt: now(),
      bindings: new Map([[appSessionId, binding]]),
      closeReason: null,
      closeDetail: null,
      quietDeadlineAt: null,
      quietWindowStartAt: null,
    };
    const turn: PerRunTurn = {
      appSessionId,
      runId,
      turnEnded: false,
      settled: false,
      aborted: false,
      lingering: false,
      settleGate: null,
    };

    hosts.set(host.hostId, host);
    hostIdByAppSession.set(appSessionId, host.hostId);
    perRunTurns.set(host.hostId, turn);
    // A new host is in the listing before its first frame is observed; the
    // announcement is what lets a client see the turn start without a poll.
    notifyHostsChanged();

    let runPromise: Promise<unknown>;
    try {
      runPromise = Promise.resolve(start(createObservingWriter(writer, host, turn)));
    } catch (error) {
      // Preserve the synchronous throw the runtime would have produced, and do
      // not leave a host behind for a run that never started.
      closeHost(host.hostId, 'exited', 'error');
      throw error;
    }

    // Observe the promise without replacing it: `Promise.resolve` returns the
    // runtime's own promise unchanged, so the caller still receives exactly what
    // it would have received without the manager in the path.
    runPromise.then(
      () => settleTurn(host.hostId),
      () => settleTurn(host.hostId),
    );

    return runPromise;
  }

  /**
   * Marks the host bound to this application session as aborted and closes it.
   *
   * Consumed by the providers module's `provider-runtime.service.abort` after the
   * runtime confirms it stopped something. For a per-run host, stopping the turn
   * *is* killing the process, so the host closes here rather than waiting for the
   * run's promise. Returns whether a live host was found.
   */
  function requestAbort(appSessionId: string): boolean {
    const hostId = hostIdByAppSession.get(appSessionId);
    if (!hostId) {
      return false;
    }

    const turn = perRunTurns.get(hostId);
    if (turn) {
      turn.aborted = true;
    }
    closeHost(hostId, 'aborted');
    return true;
  }

  /**
   * Stops the turn in flight through the host's driver, then closes the host.
   *
   * The driver-backed sibling of `requestAbort`: `requestAbort` is the default
   * wrapper's path (stopping a per-run turn *is* killing the process, so the
   * runtime's own `abort` is the whole of it), while this asks a driver that owns
   * a longer-lived process to stop just the turn. Returns whether the driver
   * confirmed it stopped something.
   */
  async function interrupt(appSessionId: string): Promise<boolean> {
    const found = findBinding(appSessionId);
    if (!found || found.host.state === 'closed') {
      return false;
    }

    const driver = driverByHostId.get(found.host.hostId);
    const stopped = driver ? await driver.interrupt(found.host, appSessionId) : false;
    if (stopped) {
      closeHost(found.host.hostId, 'aborted');
    }
    return stopped;
  }

  /**
   * Closes the host serving this session because the session changed lifecycle
   * mode (`per-run` ↔ `resident`).
   *
   * A live process cannot change which mode it is: the two modes differ in who
   * owns the process, so the honest transition is to end the old host and let
   * the new mode open its own. Consumed by the mode-switch path (AC-158), which
   * calls this before it opens the replacement.
   */
  function changeMode(appSessionId: string): boolean {
    return closeSessionHost(appSessionId, 'mode-change');
  }

  /**
   * Closes the host serving this session because an edited message forced the
   * conversation to restart from a truncation point.
   *
   * The process cannot be reused across a rewind: the provider's own session it
   * was serving no longer holds the conversation. Consumed by the edit-send
   * rebuild path (AC-159).
   */
  function rewind(appSessionId: string): boolean {
    return closeSessionHost(appSessionId, 'rewind');
  }

  /**
   * Rewinds, and answers only once the driver has settled the close.
   *
   * The `rewind` above states the decision synchronously; the edit-send rebuild
   * path cannot act on that decision alone, because it starts the replacement
   * process next and may not do so while the old one is still being torn down.
   * Same two facts as `closeHostAndWait`, asked through the same pending-close
   * promise, so "closed" here means exactly what it means on the shutdown path.
   *
   * Returns whether a live host was found, mirroring `rewind`: a resident
   * session whose host is already gone is a rebuild with nothing to rewind, not
   * a failure.
   */
  async function rewindAndWait(appSessionId: string): Promise<boolean> {
    const hostId = hostIdByAppSession.get(appSessionId);
    if (!hostId) {
      return false;
    }
    await closeHostAndWait(hostId, 'rewind');
    return true;
  }

  /**
   * Stops every host and waits for the drivers to settle.
   *
   * Consumed by `shutdownRuntimeServices` in `server/index.ts`, which runs it
   * after the session-scope stop and before `process.exit(0)`. The grace period
   * is scheduled on the same clock as the quiet ceiling, so it is testable
   * without waiting it out; a host whose driver has still not settled when it
   * expires is closed anyway and recorded in `forced` with
   * `closeDetail: 'forced'`. The returned promise does not settle until every
   * host this call found is `closed`, so a caller that awaits it can exit
   * knowing no host was left mid-close.
   */
  async function shutdown(input: { timeoutMs: number }): Promise<ShutdownSummary> {
    const targets = [...hosts.values()].filter((host) => host.state !== 'closed');
    // Which drivers actually reported back. `host.state` cannot answer this: the
    // manager records its decision to close synchronously, so by the time the
    // grace period expires every record already reads `closed` — what is still
    // outstanding is the process, not the record.
    const settledHostIds = new Set<string>();
    const settling: Promise<void>[] = [];

    for (const host of targets) {
      // Routing through the same close path keeps the reason vocabulary and the
      // binding teardown identical to every other close; only the awaiting differs.
      closeHost(host.hostId, 'server-shutdown');
      const closing = pendingCloseByHost.get(host.hostId) ?? Promise.resolve();
      settling.push(
        closing.then(() => {
          settledHostIds.add(host.hostId);
        }),
      );
    }

    // The grace period is a scheduler deadline like any other, so a caller that
    // injected a clock can reach it without waiting it out. The promise exists
    // only to give the deadline something to settle when it wins the race.
    let expireGracePeriod!: () => void;
    const gracePeriod = new Promise<void>((resolve) => {
      expireGracePeriod = resolve;
    });
    const cancelGracePeriod = scheduler.schedule(now() + input.timeoutMs, expireGracePeriod);

    if (settling.length > 0) {
      await Promise.race([Promise.all(settling).then(() => undefined), gracePeriod]);
    }
    cancelGracePeriod();

    const forced: string[] = [];
    for (const host of targets) {
      if (settledHostIds.has(host.hostId)) {
        continue;
      }
      // The driver never reported back, so nothing else is coming. The record is
      // already closed — the manager decided that before it asked — and the one
      // fact left to keep is that it had to be, so the gap is visible rather
      // than silent.
      host.closeDetail = 'forced';
      forced.push(host.hostId);
    }

    return { closed: targets.map((host) => host.hostId), forced };
  }

  /**
   * Installs the unattended-run seam, once, from the composition root.
   *
   * A setter rather than a constructor option because the opener is built from
   * the run registry, and the registry lives on the far side of an import edge
   * this module may not cross — so the two cannot be constructed in the order a
   * constructor option would require. Late binding is the point: what the
   * manager owns is the *call*, not who answers it.
   */
  function setUnattendedRunOpener(opener: UnattendedRunOpener | null): void {
    unattendedRunOpener = opener;
  }

  /**
   * Opens a run for a turn nobody dispatched, through the installed opener.
   *
   * Returns `null` when there is no opener (a process with no run registry) or
   * when the opener declines — the registry answering "this session already has
   * a run" is the ordinary decline, not an error. A host driver treats `null`
   * as "carry on as this mode always did": the frames stay with the last writer
   * and no run is opened, which is exactly the pre-seam behaviour.
   *
   * The manager adds nothing here. It holds no run state and must not: a run's
   * lifetime is the registry's, and a second copy of "is a run in flight" on
   * this side could only disagree with it.
   */
  function openUnattendedRun(input: UnattendedRunInput): UnattendedRunHandle | null {
    return unattendedRunOpener ? unattendedRunOpener(input) : null;
  }

  /**
   * Installs the turn-run seam, once, from the composition root.
   *
   * The sibling of {@link setUnattendedRunOpener} and installed from the same
   * place for the same reason; kept a separate setter so a workspace that only
   * wants the older, writer-shaped seam can leave this one absent.
   */
  function setTurnOpener(opener: TurnOpener | null): void {
    turnOpener = opener;
  }

  /**
   * Opens or adopts the run of one turn, through the installed opener.
   *
   * The manager adds nothing: it holds no run state (see
   * {@link openUnattendedRun}) and this verb exists only because the opener lives
   * across an import edge the manager may not cross. `null` is the same
   * carry-on-as-before answer the unattended opener's has always given.
   */
  function openTurn(input: TurnOpenInput): TurnHandle | null {
    return turnOpener ? turnOpener(input) : null;
  }

  /**
   * Read port for the whole host view: every live host, plus the closed ones
   * that are still inside the retention window.
   *
   * Consumed by this module's tests and by the host-listing route
   * (`session-hosts.routes.ts`), which is what makes the window's far edge
   * observable. The filter is applied here, at read time, so a closed host
   * disappears from the listing without anything having to run at its deadline
   * — and the instant compared against is a single reading of the manager's
   * clock, so two hosts that closed together expire together.
   *
   * Each call returns detached copies, so a reader cannot mutate the manager's
   * state by holding on to a snapshot.
   */
  function snapshot(): ProcessHost[] {
    const at = now();
    return [...hosts.values()]
      .filter((host) => withinRetention(host, at))
      .map(copyHost);
  }

  /**
   * The live host serving one session, or null when the session has none.
   *
   * The question every caller has to ask before it addresses a driver by
   * session: which process is serving this conversation *right now*. It lives
   * here because the manager is the only layer that owns the binding table —
   * an answer assembled anywhere else would be a second copy of "who is bound
   * to what", and the two could disagree exactly when it matters (a host that
   * closed between the read and the write).
   *
   * Detached like `snapshot`, and for the same reason: the caller holds the
   * record across an await while it addresses the driver, so what it holds must
   * be a reading rather than a handle on the manager's own object.
   */
  function liveHostForSession(appSessionId: string): ProcessHost | null {
    for (const host of hosts.values()) {
      if (host.state !== 'closed' && host.bindings.has(appSessionId)) {
        return copyHost(host);
      }
    }
    return null;
  }

  /**
   * Whether a closed host is still readable at `at`.
   *
   * A host that is not closed is always readable; a closed one is readable
   * while `closedAt + retention` is still ahead. The comparison is strict, so
   * the window is half-open: at exactly `closedAt + retention` the host is
   * gone, which is the reading a criterion can place a deadline on without
   * guessing whether the boundary belongs to the window or to the gap after it.
   */
  function withinRetention(host: ProcessHost, at: number): boolean {
    if (host.state !== 'closed') {
      return true;
    }
    const closedAt = closedAtByHostId.get(host.hostId);
    // A closed host with no stamp cannot be expired honestly, so it is kept
    // rather than dropped: the only closes are `closeHost`'s and it always
    // stamps, which makes this branch unreachable rather than a policy.
    return closedAt === undefined || closedAt + closedHostRetentionMs > at;
  }

  return {
    onChange,
    notifyHostsChanged,
    openHost,
    bindSession,
    unbindSession,
    trackPerRunTurn,
    addLease,
    removeLease,
    attachViewer,
    noteActivity,
    recordIdentity,
    interrupt,
    changeMode,
    rewind,
    rewindAndWait,
    requestAbort,
    closeHost,
    shutdown,
    snapshot,
    liveHostForSession,
    setUnattendedRunOpener,
    openUnattendedRun,
    setTurnOpener,
    openTurn,
  };
}

export type SessionHostManager = ReturnType<typeof createSessionHostManager>;

/**
 * Process-wide host view.
 *
 * A singleton rather than a per-caller instance because a host is a process the
 * whole server shares: the dispatcher that opens one and the code that later
 * lists or closes it must be looking at the same record.
 */
export const sessionHostManager = createSessionHostManager();
