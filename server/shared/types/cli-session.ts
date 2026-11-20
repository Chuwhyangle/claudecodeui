import type { ProviderRuntimeContext } from './provider-launch.js';
import type { LLMProvider } from './provider-message.js';
import type { ChatRunSource, HostMode } from './primitives.js';
import type { AnyRecord } from './ui.js';

// ---------------------------
//----------------- CLI MODULE CONTRACTS ------------
/**
 * Output boundary used by the CLI and Sandbox services.
 *
 * Production wiring delegates to the real console. Unit tests collect these
 * calls in arrays, which keeps command assertions deterministic and avoids
 * monkey-patching the global console singleton.
 */
export type CliOutput = {
  log(message?: string): void;
  error(message?: string): void;
};

/**
 * Minimal synchronous filesystem surface shared by CLI status reporting and
 * sandbox workspace validation.
 *
 * The production composition root adapts Node's filesystem module. Tests supply
 * path-keyed fakes, so service tests never inspect or modify the real machine.
 */
export type CliFileSystem = {
  pathExists(filePath: string): boolean;
  getFileStats(filePath: string): { size: number; modifiedAt: Date };
};

/**
 * Mutable environment view owned by the CLI application.
 *
 * CLI options update this object before the server starts. Production passes
 * `process.env`; tests pass a plain record to verify option precedence without
 * changing process-wide environment state.
 */
export type CliEnvironment = Record<string, string | undefined>;

/**
 * Package metadata displayed by CLI help, status, version, and update commands.
 *
 * The composition root reads this once from the application package file and
 * injects only the fields the service needs.
 */
export type CliPackageMetadata = {
  version: string;
  homepage?: string;
  bugsUrl?: string;
};

/**
 * Executable CLI application returned by the CLI composition root.
 *
 * The thin executable entrypoint passes `process.argv` arguments to `run` and
 * copies the returned code to `process.exitCode`. Tests invoke the same method
 * directly with isolated dependencies.
 */
export type CliApplication = {
  run(argumentsList: string[]): Promise<number>;
};

/**
 * Sandbox command service consumed by the top-level CLI command dispatcher.
 *
 * Keeping this behind one required dependency lets CLI tests use a tiny fake,
 * while focused Sandbox tests exercise subprocess and filesystem behavior with
 * their own handwritten adapters.
 */
export type SandboxCommandService = {
  execute(argumentsList: string[]): Promise<number>;
};

// ---------------------------
//----------------- LAUNCH SPEC ------------

/**
 * Compiled launch configuration returned by the model-launch-spec compiler.
 *
 * Consumed by the Claude SDK runtime and the shell websocket service, which
 * merge `env` over the host environment when spawning a provider process.
 * With no configured model selected (passthrough) `env` is `{}` and `argv` is
 * `[]`, so callers' env assembly stays byte-identical to the pre-model-library
 * behavior. `env` must only hold overrides, never a copy of `process.env`.
 * `unsetEnv` lists keys that must be REMOVED from the final spawn environment
 * (a model-library `unset` row); callers must apply it with
 * `applyLaunchSpecEnv` so the removal lands on the object handed to the
 * spawn, not merely on the spec. Absent for passthrough specs.
 */
export type ResolvedLaunchSpec = {
  env: Record<string, string>;
  unsetEnv?: string[];
  argv: string[];
  contextWindow: number;
  warnings: string[];
};

// ---------------------------
//----------------- SESSION HOST LIFECYCLE TYPES ------------
/**
 * State of one `ProcessHost`.
 *
 * `busy` and `lingering` are the two states the default per-run wrapper can
 * reach on its own: `busy` while the turn's `turn` lease is held, and
 * `lingering` once that lease is gone but the run's promise has still not
 * settled (Claude's held-stdin window, made observable for the first time).
 * `starting`, `idle` and `closing` are reached only by a provider that owns its
 * process lifetime through a host driver, so no default-wrapped provider ever
 * reports them.
 */
export type HostState = 'starting' | 'idle' | 'busy' | 'lingering' | 'closing' | 'closed';

/**
 * Why a host process or one of its session bindings ended.
 *
 * One enum covers both `ProcessHost.closeReason` and
 * `SessionBinding.detachReason` so a client renders a single vocabulary instead
 * of two provider-shaped ones. Only `turn-complete`, `aborted` and `released`
 * are produced by the default per-run wrapper; the remaining members are named
 * here because the state machine they document is shared with the resident mode
 * and with providers that implement a host driver.
 */
export type HostCloseReason =
  /** The turn ended and nothing else kept the host alive. */
  | 'turn-complete'
  /** A held host was let go — the background work reported back or the hold hit its ceiling. */
  | 'released'
  /** A newer turn replaced the host a previous turn was still holding. */
  | 'superseded'
  /** The user stopped the turn; for a per-run host that means the process dies. */
  | 'aborted'
  /** The user closed the host, or deleted/archived the session it served. */
  | 'user'
  /** A resident host hit its inactivity ceiling. */
  | 'idle'
  /** The session changed between per-run and resident. */
  | 'mode-change'
  /** An edited message forced the conversation to restart from a truncation point. */
  | 'rewind'
  /** The process exited on its own or crashed. */
  | 'exited'
  /** The server shut down normally. */
  | 'server-shutdown';

/**
 * Every member of `HostCloseReason`, as a runtime value.
 *
 * The union above is the contract; this array is the same list in a form a
 * program can iterate, so "which reasons exist" is one fact rather than two
 * lists that can drift apart. It is a shared definition because it has two
 * consumers that must agree: the session-host manager derives its close
 * decisions from reasons named here, and the lifecycle criterion asserts that
 * every value in this array was actually produced by some case — an enumeration
 * test that read its own literal list could pass while the union changed under
 * it. Keep the two in the same order, and add a member to both at once.
 */
export const HOST_CLOSE_REASONS = [
  'turn-complete',
  'released',
  'superseded',
  'aborted',
  'user',
  'idle',
  'mode-change',
  'rewind',
  'exited',
  'server-shutdown',
] as const satisfies readonly HostCloseReason[];

/**
 * The extra fact some close reasons carry.
 *
 * `ProcessHost.closeReason` says why a host ended; for two reasons that answer
 * is incomplete and this names the rest. `exited` distinguishes a process the
 * kernel killed for memory from one that died on a signal or failed on its own
 * — the three the runtime can report. `forced` is not a driver report at all:
 * it records that the server shut down while the driver had still not settled
 * its `closeHost`, so the host was closed out from under it. A null
 * `closeDetail` means the reason needs no detail (`turn-complete`, `user`, …).
 */
export type HostCloseDetail = 'oom' | 'signal' | 'error' | 'forced';

/**
 * The two knobs that decide when a host is closed, one set per lifecycle mode.
 *
 * Read by the session-host manager each time it recomputes state, so a policy is
 * data rather than a branch on `mode`: `per-run` and `resident` differ only in
 * the values below, which is what makes either mode testable by injecting a
 * policy instead of a provider. The values themselves mirror
 * `docs/proposals/claude-resident-sessions.md` §3.
 */
export type LifecyclePolicy = {
  /** A new turn on the same bound session closes the host the previous turn held. */
  supersedeOnNewTurn: boolean;
  /** Close the host as soon as the union of its bindings' leases is empty. */
  closeWhenLeasesEmpty: boolean;
  /**
   * How long a host with no `turn` lease — `lingering` under `per-run`, `idle`
   * under `resident` — may sit before the quiet ceiling closes it. The window is
   * counted from the binding's `lastActivityAt`, not from the last frame.
   */
  quietCeilingMs: number;
};

/**
 * One reason a bound session still needs its host process.
 *
 * The host is kept alive while the union of its bindings' leases is non-empty,
 * so leases — not the process — are what the close decision is computed from. A
 * `turn` lease is held for the duration of one run; the others record work that
 * outlives the turn that started it, which is what makes a host `lingering`
 * rather than `closed`.
 *
 * `inferred` marks the two held-work reasons whose *identity* a driver may have
 * had to guess. A cron and a background task are normally named twice: by the
 * `Stop` hook's own lists, which are the CLI's authoritative account of what it
 * holds, and by the events the same work emits on the stream. When the first is
 * unavailable — an older CLI, a hook that never fired — a driver can still read
 * the second and hold the host for it, but the entry it names is its own reading
 * rather than the CLI's; that is what this flag says, and its absence is the
 * authoritative case (an omitted flag means "the CLI named this"). It is
 * deliberately optional so a lease written before this distinction existed still
 * satisfies the type, and it is confined to the two kinds a stream can describe,
 * because `turn` and `resident-policy` are never inferred from anything.
 *
 * `since` is when the manager recorded the lease — the instant the hold began,
 * which is the only fact a reader needs to report how long the work has been
 * outstanding. It is written by `addLease`, not by the driver that reports the
 * lease: a driver states *that* it is holding work for an id and has no reason
 * to know when the manager started counting, while the manager is the one place
 * every lease passes through. Optional here so a driver's own request type keeps
 * compiling; the listing projection fills it for both members, so a client
 * always reads a number. `cron` carries its own schedule (`expiresAt`) and is
 * deliberately not given one.
 */
export type HostLease =
  | { kind: 'turn'; runId: string }
  | { kind: 'background-task' | 'monitor'; id: string; since?: number; inferred?: boolean }
  | { kind: 'cron'; id: string; recurring: boolean; expiresAt: number; inferred?: boolean }
  | { kind: 'resident-policy' };

/**
 * One application session running inside one host process.
 *
 * Hosts are 1:N with sessions: a per-run host always carries exactly one
 * binding, while a multiplexing process (Codex `app-server`, `opencode serve`)
 * carries one per conversation. `providerSessionId` is filled in from the
 * runtime's own session-id announcement when the provider reports one, so a
 * binding is the join point between the app id and the provider-native id.
 */
export type SessionBinding = {
  appSessionId: string;
  providerSessionId: string | null;
  state: 'idle' | 'busy';
  leases: HostLease[];
  lastActivityAt: number;
  /**
   * The SendMessage address this binding's process answers to, when it has one.
   *
   * Reported by the driver once the process has registered the name with its own
   * tooling and the driver has read that registration back — never computed and
   * assumed here, because the name a process answers to is a fact about the
   * process's own peer registry rather than about the string some caller chose.
   * `null` means "not addressable": the mode has no stable address at all, the
   * process never registered one, or what it registered is not what the naming
   * rule asked for. Fixed for the process's lifetime — a title change does not
   * move it — and belongs to the binding rather than to the host because it is
   * per-conversation, like every other fact on this record.
   */
  peerName: string | null;
  /** Set when the binding was detached; mirrors the host's `closeReason` for that binding. */
  detachReason: HostCloseReason | null;
};

/**
 * Why a bind request was refused.
 *
 * Three refusals, and they are different failures: `session-already-bound` says
 * the session is already somewhere (the request may have named a second host,
 * but the session is not free), while `host-not-multiplexed` says the session is
 * free and the *process* is what cannot take it — a host whose driver did not
 * declare `multiplexedHost` carries one conversation and no more. Named here
 * rather than thrown as a message because the manager's caller has to branch on
 * which refusal it got, and a branch on prose is a branch that breaks silently.
 *
 * `remote-control-enabled` is a refusal about a *launch* rather than about a
 * placement, and it is named in this same vocabulary on purpose: what the caller
 * has to branch on is identical — "you did not get a host, and here is the kind
 * of no it was" — and a second vocabulary for the same branch would be two lists
 * to keep in step. The one it names is the Remote Control gate: the user's own
 * settings have Remote Control on, so a resident process launched under
 * `bypassPermissions` would be reachable from another machine's peer sessions and
 * the trust boundary would leave the Unix user. The gate refuses instead of
 * launching (see the Claude resident driver's Remote Control section).
 */
export type HostBindErrorCode = 'session-already-bound' | 'host-not-multiplexed' | 'remote-control-enabled';

/**
 * Every member of `HostBindErrorCode`, as a runtime value.
 *
 * Same contract as `HOST_CLOSE_REASONS`: the union is the definition and this
 * array is the same list in a form a program can iterate, so a criterion that
 * wants to prove each refusal is reachable reads the list the manager is typed
 * against instead of a literal typed a second time. Keep the two in the same
 * order, and add a member to both at once.
 */
export const HOST_BIND_ERROR_CODES = [
  'session-already-bound',
  'host-not-multiplexed',
  'remote-control-enabled',
] as const satisfies readonly HostBindErrorCode[];

/**
 * Why a lifecycle-mode read or write was refused.
 *
 * One vocabulary for two surfaces that answer about the same two facts — which
 * mode a session is stored under, and whether a process is running for it — so
 * a client can tell the refusals apart without reading prose. The members are
 * deliberately all distinct: "you asked for a mode this provider's driver does
 * not implement" (`LIFECYCLE_MODE_NOT_SUPPORTED`) and "you asked for a mode that
 * does not exist" (`LIFECYCLE_MODE_UNKNOWN`) are different mistakes with
 * different fixes, and a client that had to branch on a message would conflate
 * them the first time one was reworded.
 *
 * `SESSION_NOT_FOUND` and `SESSION_HOST_NOT_FOUND` are the two ways "there is
 * nothing to act on" splits: the first says no session row exists, the second
 * says the session exists and no live process is serving it. The close route
 * needs both because they lead a client to different repair — create/refresh the
 * session versus start the host — and `LIFECYCLE_MODE_NOT_RESIDENT` sits beside
 * them as the third answer, which is that there *is* something there and the
 * action is not allowed on it.
 */
export type LifecycleModeErrorCode =
  /** The requested mode is not one the application knows. */
  | 'LIFECYCLE_MODE_UNKNOWN'
  /** The provider's capability matrix does not list the requested mode. */
  | 'LIFECYCLE_MODE_NOT_SUPPORTED'
  /** The verb is only available to a resident session, and this one is not. */
  | 'LIFECYCLE_MODE_NOT_RESIDENT'
  /** The session is resident but its provider mounts no host driver to start. */
  | 'LIFECYCLE_MODE_HOST_UNAVAILABLE'
  /** The host serving the session is mid-turn, so the mode cannot change under it. */
  | 'LIFECYCLE_MODE_HOST_BUSY'
  /** No session row exists under the given id. */
  | 'SESSION_NOT_FOUND'
  /** The session exists but no live host is serving it. */
  | 'SESSION_HOST_NOT_FOUND';

/**
 * Every member of `LifecycleModeErrorCode`, as a runtime value.
 *
 * Same contract as `HOST_CLOSE_REASONS` and `HOST_BIND_ERROR_CODES`: the union
 * is the definition and this array is the same list in a form a program can
 * iterate. The criterion that has to show three refusals are mutually
 * distinguishable reads this list rather than a literal typed a second time, so
 * a reader can see that "distinct" is a property of the vocabulary and not of
 * the three values the case happened to produce. Keep the two in the same order,
 * and add a member to both at once.
 */
export const LIFECYCLE_MODE_ERROR_CODES = [
  'LIFECYCLE_MODE_UNKNOWN',
  'LIFECYCLE_MODE_NOT_SUPPORTED',
  'LIFECYCLE_MODE_NOT_RESIDENT',
  'LIFECYCLE_MODE_HOST_UNAVAILABLE',
  'LIFECYCLE_MODE_HOST_BUSY',
  'SESSION_NOT_FOUND',
  'SESSION_HOST_NOT_FOUND',
] as const satisfies readonly LifecycleModeErrorCode[];

/**
 * The outcome of one `bindSession` request.
 *
 * A discriminated union rather than a thrown error because a refusal is an
 * ordinary answer to a race — two turns arriving for one session is normal
 * traffic, not a fault — and because the caller needs the refusal's identity,
 * not just its message.
 *
 * `existingHostId` is the load-bearing half of a refusal: for
 * `session-already-bound` it names the host that already holds the session
 * (which is *not* necessarily the host the request was aimed at, and naming the
 * aimed-at host instead would hide the conflict); for `host-not-multiplexed` it
 * names the live host that could not take a second binding. Null only when a
 * refusal has no host to point at.
 */
export type HostBindResult =
  | { ok: true; hostId: string }
  | { ok: false; code: HostBindErrorCode; existingHostId: string | null };

/**
 * What one host has to say about the Remote Control gate it launched under.
 *
 * The three halves are three different facts and are deliberately not one
 * object's fields: `requested` is what *this* build asked the SDK for,
 * `detected` is what the user's own settings file said when the gate read it,
 * and `launched` is the `settings` object the SDK query was really handed.
 *
 * `detected` is the reading the refusal is decided on, and it is a *reading of a
 * file*, not an effective value: `null` means the key was absent (or the file
 * was not there, or was not parseable) and is distinct from `false`. There is
 * deliberately no member here that claims to say whether Remote Control is off
 * on the running process — the experiment that would have measured it (E9 §9.7)
 * got no `get_settings` answer at all, so a field named for an "effective" value
 * would be asserting something this build cannot read. A criterion therefore
 * reads these fields against the file it wrote, never against a claim about what
 * the CLI did with the flag.
 *
 * `launched` is `null` for a host whose process factory does not report one (a
 * substituted factory in a criterion), and its two members are `boolean |
 * undefined` for the same reason `detected`'s are `boolean | null`: a launch
 * that did not state a key is not a launch that stated `false`.
 */
export type RemoteControlIsolation = {
  /** What this host asked the SDK's `settings` to carry, verbatim. */
  requested: { remoteControlAtStartup: boolean; isolatePeerMachines: boolean };
  /** What the user-level settings file said, key by key; `null` = not stated. */
  detected: { remoteControlAtStartup: boolean | null; isolatePeerMachines: boolean | null };
  /** The settings file the reading above came from, verbatim. */
  settingsPath: string;
  /** The `settings` object the SDK query was handed, as it was handed over. */
  launched: { remoteControlAtStartup?: boolean; isolatePeerMachines?: boolean } | null;
};

/**
 * One process the session-host layer knows about, in any lifecycle mode.
 *
 * `pid` is deliberately nullable: a runtime driven through the default per-run
 * wrapper never reports its child's pid, and the layer records the truth
 * (`null`) rather than inventing one. Filling it in is the job of a provider
 * that owns its process through a host driver.
 */
export type ProcessHost = {
  hostId: string;
  provider: LLMProvider;
  mode: HostMode;
  state: HostState;
  pid: number | null;
  startedAt: number;
  /** Keyed by application session id; see `SessionBinding`. */
  bindings: Map<string, SessionBinding>;
  closeReason: HostCloseReason | null;
  /**
   * The extra fact `closeReason` carries, or null when it carries none.
   *
   * Set together with `closeReason` and never before it: a host that is still
   * open has null here, and `'forced'` appears only on a host the server closed
   * during shutdown while its driver was still settling. Optional so a reader
   * written against the reason alone keeps type-checking.
   */
  closeDetail?: HostCloseDetail | null;
  /**
   * When the quiet ceiling is due to close this host, on the manager's clock.
   *
   * Exposed because the deadline is the only evidence that a host with no
   * `turn` lease is being *held* rather than merely not yet collected — the
   * lifecycle criterion prints it instead of waiting for it. Null while none is
   * armed (a `turn` lease is held, or the host is closed).
   */
  quietDeadlineAt?: number | null;
  /**
   * The instant `quietDeadlineAt` was counted from: `lastActivityAt`, or — after
   * a re-time — the `expiresAt` of the cron lease that pushed the deadline out.
   */
  quietWindowStartAt?: number | null;
  /**
   * What the launch of this host stated and read about Remote Control, when its
   * driver has anything to say about it.
   *
   * Optional and null-for-silent because only a driver that runs a launch gate
   * can answer — every other host (a per-run turn, a provider whose driver never
   * read the user's settings) has nothing here rather than a record of zeroes.
   * Written by the resident driver while `openHost` is still opening the host and
   * deep-copied by the snapshot, so a reader of `snapshot()` sees the same object
   * a reader of the live record does (see `RemoteControlIsolation`).
   */
  remoteControl?: RemoteControlIsolation | null;
};

/**
 * One turn handed to a host driver.
 *
 * Mirrors the command plus run options the application already passes to
 * `IProviderRuntime.run`, so a driver receives the same inputs the default
 * wrapper forwards to the runtime it replaces.
 */
export type HostTurnInput = {
  command: string;
  options: AnyRecord;
};

/**
 * What a driver needs to open one session's own process with no turn behind it.
 *
 * A cold start on demand has no turn to carry these, and they cannot be derived
 * by the session-host layer: the launch options are the ones the session's *next*
 * turn would have carried (`cwd`/`projectPath` off the session row, the stored
 * model/effort/permissionMode), and the context is the provider-scoped lookup bag
 * a runtime is normally handed for one run. Both are assembled by the caller that
 * owns those sources — the providers layer — and passed in whole, because the
 * host layer's boundary is to read no session row of its own and to import no
 * provider registry (see the `HostDriverResolver` reasoning in
 * `session-hosts.routes.ts`).
 *
 * Separate from {@link HostTurnInput} deliberately rather than reusing it with an
 * empty `command`: a turn's options describe work the client asked for, these
 * describe the process that work will land in, and a driver that read one as the
 * other would write a turn nobody sent.
 */
export type HostResidentLaunch = {
  /** The options the session's next turn would launch under; assembled by the caller. */
  options: AnyRecord;
  /** The provider-scoped lookups (session-id mapping, model catalogue) the launch needs. */
  context: ProviderRuntimeContext;
};

/**
 * What a driver answers when asked to open a session's own resident process.
 *
 * `pid` is nullable for the same reason {@link ProcessHost.pid} is: a driver that
 * cannot read its child's pid records the truth rather than a stand-in. `hostId`
 * is the manager's record id, which is what a client addresses the process by —
 * it is answered rather than assumed because the manager, not the driver, decides
 * it, and a driver that already had a live host for the session returns *that*
 * host's id rather than opening a second process.
 */
export type HostResidentStartResult = {
  hostId: string;
  pid: number | null;
};

/**
 * One live setting change for a host that is already running.
 *
 * Only the three settings a resident provider can change without restarting its
 * process are modelled; anything else is a new turn's option. Applied through
 * `IProviderHostDriver.reconfigure`, which reports whether the change took
 * effect immediately or was deferred to the next turn.
 */
export type HostReconfigurePatch = {
  model?: string;
  effort?: string;
  permissionMode?: string;
};

// ---------------------------
//----------------- CHAT RUN ORIGIN + NON-UNION CAPABILITIES ------------
/**
 * What made a provider CLI open a turn nobody pushed.
 *
 * A resident process whose own background work finishes starts a turn of its
 * own, and that turn is not evidence of a user: the process was already running
 * and the host pushed nothing. The reason it exists is not in the request — the
 * CLI sends none — so it has to be reconciled from what the turn left behind,
 * which for this build is the `Stop` hook's own task list.
 *
 * `background-task` is a background task reporting back, `session-cron` is a
 * scheduled prompt firing, and `non-user` is the path where no list is readable
 * at all: the honest reading there is that the turn is unexplained, not that it
 * has a reason this code could not name.
 *
 * `cross-session-message` is the fourth reason and the one the task list cannot
 * explain: a peer session addressed this process and the message itself is what
 * opened the turn, so the process was holding nothing of its own at the time.
 * The CLI states that fact on the turn's own `result` (the message's origin),
 * which is why the trigger for this reason is read at the turn's end rather than
 * at its opener — see `finishUnattendedTurn` in the resident driver.
 */
export type BackgroundWorkTrigger = 'background-task' | 'session-cron' | 'non-user' | 'cross-session-message';

/**
 * What a provider's resident process can do, beyond merely being long-lived.
 *
 * One field per fact the frontend would otherwise have to branch on the provider
 * id to learn — the same reason `permissionModes` and `supportsImages` live in
 * the capability matrix. Every entry is an observation about the provider's CLI
 * rather than a design intention, so a field whose experiment has not been run
 * states `false` (or an empty list) rather than the value the author expects:
 * `authoritativeLeases` is still "nothing verified", and a matrix that guessed
 * would make the frontend promise a feature no driver implements.
 *
 * Only meaningful for a provider whose `lifecycleModes` includes `resident`, and
 * absent for one that has no resident mode at all — the same conditional shape
 * as `IProvider.hostDriver`.
 */
export type ResidentFeatures = {
  /** Stopping the current turn leaves the process running (so the next turn is warm). */
  interruptKeepsProcess: boolean;
  /** Settings that can be changed on a running process without restarting it, verified live. */
  liveReconfigure: Array<'model' | 'effort' | 'permissionMode'>;
  /** Turns the provider can run with no client attached (cron, wakeup, cross-session message). */
  unattendedTurns: boolean;
  /** The process has a stable address another session can send a message to. */
  addressable: boolean;
  /** Input sent while a turn is in flight reaches the process rather than being refused. */
  inputWhileBusy: boolean;
  /** Input that has not yet been dequeued can be withdrawn. */
  cancelQueuedInput: boolean;
  /**
   * A running *foreground* tool can be promoted to a background task without
   * ending the turn or the process (the SDK's `Query.backgroundTasks`).
   *
   * Unmeasured against a live resident process, so it states `false` — the same
   * conservative default `authoritativeLeases` takes. The
   * value is what the background-task control plane reads before it reaches any
   * driver: a `false` is answered `unsupported` rather than risking a verb the
   * resident control channel has not been shown to carry.
   */
  backgroundTasks: boolean;
  /** The reasons keeping the process alive come from the CLI's own events, not from inference. */
  authoritativeLeases: boolean;
  /** Reserved: reachability through the provider's own remote-control bridge. */
  remoteControl: boolean;
};

/**
 * Lifecycle facts a provider states about itself at runtime.
 *
 * Deliberately keyed by a plain provider id string rather than by
 * `LLMProvider`: the providers this describes include ones intentionally kept
 * outside that union (the debug agent), and widening the union to hold them
 * would make every exhaustive `Record<LLMProvider, …>` in the codebase claim
 * support for a provider that has no CLI, no SDK and no user-facing entry.
 * Declared through `providerCapabilitiesService.declareRuntimeProviderCapabilities`
 * and read through `getRuntimeProviderCapabilities`.
 */
export type RuntimeProviderCapabilities = {
  provider: string;
  /** Lifecycle modes this provider's host driver implements. */
  lifecycleModes: HostMode[];
  /**
   * The lifecycle mode a new session of this provider is created with when the
   * caller states none.
   *
   * A separate fact from `lifecycleModes` on purpose: supporting a mode is not
   * the same as defaulting to it. Optional so a declaration written before this
   * field existed stays valid, and "absent" reads as the conservative `per-run`
   * — a provider that never stated a default keeps the row's own DB default.
   */
  defaultLifecycleMode?: HostMode;
  /**
   * Whether one process of this provider may serve several sessions at once —
   * `IProviderHostDriver.multiplexedHost` stated as a standalone fact, so it
   * can be read without an instance of the driver.
   */
  multiplexedHost: boolean;
  /**
   * What the provider's resident process can do, when it has one.
   *
   * Optional so a declaration written before this field existed stays valid —
   * the debug agent's declaration states only the two lifecycle facts above, and
   * "no declaration" is the honest reading of a provider that never claimed any
   * of these capabilities.
   */
  residentFeatures?: ResidentFeatures;
};

