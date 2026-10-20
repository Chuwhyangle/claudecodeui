import { sessionsDb } from '@/modules/database/index.js';
import { readProviderRegistryPort } from '@/shared/ports/provider-registry.port.js';
import { providerCapabilitiesService } from '@/modules/providers/services/provider-capabilities.service.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { sessionHostManager as processWideSessionHostManager } from '@/modules/session-hosts/index.js';
import type { SessionHostManager } from '@/modules/session-hosts/index.js';
import type { IProvider } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  ApprovalDecisionRecord,
  ControlStopTaskOutcome,
  HostBindErrorCode,
  HostMode,
  HostPendingQueuedInputs,
  HostQueuedInputCancelResult,
  HostReconfigurePatch,
  HostResidentStartResult,
  HostTurnInput,
  LLMProvider,
  MissingApprovalReason,
  ProcessHost,
  ProviderPermissionDecision,
  ProviderRunFunction,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';
export type { ControlStopTaskOutcome };


/**
 * The refusal a resident driver recorded when it declined to launch a process.
 *
 * Structural, and declared here rather than in the shared vocabulary, on the
 * same reasoning as `ResidentTurnEntry` below: it is one provider's reading,
 * surfaced by the dispatch that reads it. Putting a provider-specific record in
 * `@/shared/types.js` would make every provider's type surface carry a refusal
 * only one of them can make, and the caller this pass-through exists for — the
 * one that has just watched a run end with no explanation — has no use for the
 * driver's class, only for the code and the sentence.
 *
 * The *code* is what a caller branches on, and it is a `HostBindErrorCode`
 * because a refusal to launch is a refusal to place a session: the two answers a
 * caller can give (`retry`, `tell the user to change a setting`) are decided by
 * whether the code is the one they know how to act on, not by reading prose.
 * `message` is the operator-facing sentence and is deliberately not the branch
 * key; `settingsPath` and `at` are there so the sentence can be made specific
 * ("close Remote Control in <that file>") and so a stale refusal can be told
 * from a fresh one.
 */
type RemoteControlRefusalReading = {
  code: HostBindErrorCode;
  message: string;
  settingsPath: string;
  at: number;
};



/**
 * The answer the background-task control plane's driver call gives.
 *
 * `requested` means the provider driver was called and its call settled `true` —
 * the foreground tool was really promoted to a background task, and nothing about
 * the task's *appearance in the task table* is claimed (that is the reducer's, and
 * it is driven by the frames the CLI emits afterwards). `no-foreground-match`
 * means the driver answered `false`: it held no matching foreground tool, which is
 * the honest answer for a race between the Turn Tracker and the live process.
 * `unsupported` means no driver could carry it (the capability is off, the session
 * is not resident and has no per-run runtime, or the live process exposes no
 * background verb). `timeout` means the driver call did not settle inside its
 * bound, and `error` means it threw. The failure values are deliberately distinct:
 * a caller that conflated "cannot" with "did not finish" would report a
 * process-less session as a slow one.
 */
export type ControlBackgroundTaskOutcome =
  | 'requested'
  | 'no-foreground-match'
  | 'unsupported'
  | 'timeout'
  | 'error';

/**
 * The answer the `reconfigure` verb gives about a live setting change.
 *
 * `live` and `next-turn` are the resident driver's own verdicts
 * (`IProviderHostDriver.reconfigure`): the change took effect on the running
 * process, or it will be picked up by the next turn's launch. `unsupported` is
 * this layer's answer to every question it cannot place — an unknown provider, a
 * session that is not resident, a driver without the verb, a host that is gone —
 * and it is deliberately distinct from `next-turn`: "there is no live process to
 * change" must never be reported as "the change is queued for the next one".
 *
 * Consumed by the MCP gateway's `session_reconfigure` adapter (AC-272), which
 * maps `live`/`next-turn`/`unsupported` onto its own `applied` reading.
 */
export type HostReconfigureOutcome = 'live' | 'next-turn' | 'unsupported';

/**
 * The per-run runtime's own background verb, read structurally.
 *
 * `IProviderRuntime` in `@/shared/interfaces.js` is the contract every provider
 * shares and is deliberately not widened for the control plane of one. A runtime
 * that implements it carries `backgroundTask` beside `stopTask`; a runtime that
 * does not is read as having no background verb, which is the `unsupported`
 * answer.
 */
type PerRunBackgroundTaskRuntime = {
  backgroundTask?(sessionId: string, toolUseId: string): Promise<boolean>;
};

/**
 * The per-run runtime's own stop verb, read structurally.
 *
 * `IProviderRuntime` in `@/shared/interfaces.js` is the contract every provider
 * shares and is deliberately not widened for the control plane of one. A runtime
 * that implements it carries `stopTask` beside `abort`; a runtime that does not
 * is read as having no stop verb, which is the `unsupported` answer.
 */
type PerRunStopTaskRuntime = {
  stopTask?(sessionId: string, taskId: string): Promise<boolean>;
};

type ProviderRuntimeServiceDependencies = {
  listProviders(): IProvider[];
  resolveProvider(provider: string): IProvider;
  resolveProviderSessionId(sessionId: string | null | undefined): string | null;
  resolveResumeModel(
    provider: LLMProvider,
    sessionId: string | undefined,
    requestedModel?: string | null,
  ): Promise<string | undefined>;
  getProviderModels: typeof providerModelsService.getProviderModels;
  /**
   * The lifecycle mode one session is stored under.
   *
   * A dependency rather than a direct read so the dispatch's routing decision is
   * testable without a database: the criterion that proves a resident turn skips
   * the per-run wrapper hands in its own answer, and the criterion that proves a
   * `per-run` session is untouched leaves the production default in place. The
   * default is the repository's own reader, which is also where an unknown stored
   * value is resolved (to `per-run`) rather than at each call site.
   */
  resolveSessionLifecycleMode(sessionId: string): HostMode;
  /**
   * The host view every dispatched turn registers in.
   *
   * Injectable so a criterion can drive a run through this service and then
   * read the very same manager from its own HTTP surface — the default wrapper
   * writes the host, the listing route reads it, and both have to be looking at
   * one table for "the listing comes from the host layer" to be a statement
   * about the production path. Production leaves it at the process-wide
   * singleton.
   */
  sessionHostManager: SessionHostManager;
  /**
   * The launch options a resident session's *next* turn would have carried.
   *
   * The load-bearing half of an on-demand start: a cold launch has no turn to
   * take its options from, and the process still has to come up in the session's
   * project directory and under the model/effort/permission mode the user last
   * sent — otherwise the button would open a process that answers the next turn
   * differently from the one the conversation has been running under. It belongs
   * to *this* layer and not to `session-hosts`, which is the module that asks:
   * the two sources (the session row's `project_path`, the values
   * `providerModelsService` recorded on every send) are this module's neighbours,
   * while the host module's boundary is to read no session store and import no
   * provider registry.
   *
   * A dependency rather than a direct call for the same reason
   * `resolveSessionLifecycleMode` is one: a criterion that drives the dispatch
   * against its own manager must not need a database to answer it.
   */
  resolveResidentLaunchOptions(provider: LLMProvider, sessionId: string): Promise<AnyRecord>;
  /**
   * Whether one provider's resident process can stop a named background task.
   *
   * Read from the capability matrix by default
   * (`residentFeatures.stopTask`); a dependency so a criterion can drive the
   * gate with the verb on, which the shipped matrix states as `false` until it
   * is measured. A provider that never declared the field — one outside the
   * union, or one whose declaration predates it — is read as `false`, the
   * conservative answer, never as a claim the verb exists.
   */
  residentStopTaskSupported(provider: string): boolean;
  /**
   * How long a driver's stop-task call is given before the gateway answers
   * `timeout`.
   *
   * A dependency rather than a constant so the criterion can drive the
   * never-resolving arm in milliseconds instead of seconds. Production's bound
   * is the same class of ceiling the control plane's own event wait uses, and it
   * exists because the SDK's answer is not guaranteed to arrive: a stop of an id
   * the process does not hold resolves, but a wedged transport can leave the
   * promise pending forever, and the control handler must not be the thing that
   * hangs on it.
   */
  stopTaskCallTimeoutMs: number;
  /**
   * Whether one provider's resident process can promote a foreground tool to a
   * background task.
   *
   * Read from the capability matrix by default
   * (`residentFeatures.backgroundTasks`); a dependency so a criterion can drive
   * the gate with the verb on, which the shipped matrix states as `false` until
   * it is measured. A provider whose declaration predates the field is read as
   * `false`, the conservative answer, never as a claim the verb exists.
   */
  residentBackgroundTaskSupported(provider: string): boolean;
  /**
   * How long a driver's background-task call is given before the gateway answers
   * `timeout`.
   *
   * A dependency rather than a constant for the same reason
   * `stopTaskCallTimeoutMs` is one: the criterion drives the never-resolving arm
   * in milliseconds instead of seconds. The SDK's answer is not guaranteed to
   * arrive — the process can be wedged — and the control handler must not be the
   * thing that hangs on it.
   */
  backgroundTaskCallTimeoutMs: number;
};

/** How long a driver's stop-task call is given by default. */
const DEFAULT_STOP_TASK_CALL_TIMEOUT_MS = 5_000;
const STOP_TASK_CALL_TIMEOUT_ENV = 'CLAUDE_STOP_TASK_CALL_TIMEOUT_MS';

/** How long a driver's background-task call is given by default. */
const DEFAULT_BACKGROUND_TASK_CALL_TIMEOUT_MS = 5_000;
const BACKGROUND_TASK_CALL_TIMEOUT_ENV = 'CLAUDE_BACKGROUND_TASK_CALL_TIMEOUT_MS';

const defaultDependencies: ProviderRuntimeServiceDependencies = {
  listProviders: () => readProviderRegistryPort().listProviders(),
  resolveProvider: (provider) => readProviderRegistryPort().resolveProvider(provider),
  resolveProviderSessionId: (sessionId) => sessionsService.resolveProviderSessionId(sessionId),
  resolveResumeModel: (provider, sessionId, requestedModel) =>
    providerModelsService.resolveResumeModel(provider, sessionId, requestedModel),
  getProviderModels: (provider) => providerModelsService.getProviderModels(provider),
  resolveSessionLifecycleMode: (sessionId) => sessionsDb.getSessionLifecycleMode(sessionId),
  sessionHostManager: processWideSessionHostManager,
  resolveResidentLaunchOptions: (provider, sessionId) => defaultResidentLaunchOptions(provider, sessionId),
  residentStopTaskSupported: (provider) => defaultResidentStopTaskSupported(provider),
  stopTaskCallTimeoutMs: readStopTaskCallTimeoutMs(),
  residentBackgroundTaskSupported: (provider) => defaultResidentBackgroundTaskSupported(provider),
  backgroundTaskCallTimeoutMs: readBackgroundTaskCallTimeoutMs(),
};

/** Reads the stop-task call bound, overridable for operators and criteria. */
function readStopTaskCallTimeoutMs(): number {
  const raw = Number.parseInt(process.env[STOP_TASK_CALL_TIMEOUT_ENV] ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STOP_TASK_CALL_TIMEOUT_MS;
}

/** Reads the background-task call bound, overridable for operators and criteria. */
function readBackgroundTaskCallTimeoutMs(): number {
  const raw = Number.parseInt(process.env[BACKGROUND_TASK_CALL_TIMEOUT_ENV] ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BACKGROUND_TASK_CALL_TIMEOUT_MS;
}

/**
 * Reads the stop-task capability off the union provider's capability row.
 *
 * Only the union table is read: `residentFeatures` is stated there through the
 * widened matrix the capability service owns, and a provider outside the union
 * has made no stop-task declaration at all — which reads as `false`, the
 * conservative answer this verb answers `unsupported` for. The read never
 * throws for an unknown id: a record lookup that misses is `undefined`, and the
 * `?.` chain turns it into `false` rather than an error.
 */
function defaultResidentStopTaskSupported(provider: string): boolean {
  const features = providerCapabilitiesService
    .getProviderCapabilities(provider as LLMProvider)
    ?.residentFeatures;
  return features?.stopTask === true;
}

/**
 * Reads the background-task capability off the union provider's capability row.
 *
 * The same read as `defaultResidentStopTaskSupported` over the sibling field:
 * only the union table is consulted, and a provider outside it — or one whose
 * declaration predates `backgroundTasks` — reads `false`, the conservative
 * answer this verb answers `unsupported` for. Absent is false, never a claim.
 */
function defaultResidentBackgroundTaskSupported(provider: string): boolean {
  const features = providerCapabilitiesService
    .getProviderCapabilities(provider as LLMProvider)
    ?.residentFeatures;
  return features?.backgroundTasks === true;
}

/**
 * The options a resident session's next turn would launch under, with no turn.
 *
 * Assembled from the same two sources the websocket dispatch reads when a person
 * sends a message, so a process opened by the [Start] control comes up the way
 * the next turn would have brought it up: `cwd`/`projectPath` off the session row
 * (the CLI is spawned in one and file tools resolve against the other, and
 * neither has a client to supply it here), and `model`/`effort`/`permissionMode`
 * from the values `providerModelsService` recorded on the last send.
 *
 * The provider-native session id is deliberately absent. It is not a client
 * option in the first place — every launch resolves it through the runtime
 * context — and the resident driver injects it itself, so stating it here would
 * be a second spelling of one fact rather than a missing one.
 *
 * A session whose row cannot be read still gets a launch: the project path is
 * simply omitted and the CLI runs where the server does, which is the answer for
 * a session that was never given one. Refusing to start over a display detail
 * would be the worse trade.
 */
async function defaultResidentLaunchOptions(
  provider: LLMProvider,
  sessionId: string,
): Promise<AnyRecord> {
  const projectPath = sessionsDb.getSessionById(sessionId)?.project_path ?? null;
  const selection = await providerModelsService.resolveSessionModel(provider, { sessionId });

  return {
    sessionId,
    ...(projectPath ? { cwd: projectPath, projectPath } : {}),
    model: selection.model,
    effort: selection.effort ?? undefined,
    permissionMode: selection.permissionMode ?? undefined,
  };
}

/**
 * The resident turn entry a host driver may carry, beyond `IProviderHostDriver`.
 *
 * `IProviderHostDriver.submit` is the interface's own turn verb and it takes no
 * writer, because for most providers a turn's client-facing frames belong to the
 * runtime the provider already registered. A provider whose resident mode is
 * real hands the run's writer to the process it holds instead, and that entry —
 * the driver's own `run(appSessionId, turn, writer, context)` — is what this file
 * calls for a session whose lifecycle mode is `resident`.
 *
 * Held as a structural type rather than added to `IProviderHostDriver` because
 * the interface is the seam every provider shares and this is a capability of
 * one; declared here, in the dispatch that reads it, because the dispatch is the
 * only consumer. `residentEntryFor` below is what keeps the shape check from
 * being an assumption.
 */
type ResidentTurnEntry = {
  /**
   * Runs one turn through the driver that owns the session's process.
   *
   * `unknown`, not `void`: the dispatch in this file hands the driver's value
   * straight back to whoever dispatched the turn, and a driver may have
   * something to say about the round it just ran — the debug agent's is the
   * reading its control plane checks against the artifact, and a `void` here
   * would type away the only path that value has to its reader. A driver with
   * nothing to report simply resolves to nothing, which is what every other
   * driver does.
   */
  run(
    appSessionId: string,
    turn: HostTurnInput,
    writer: ProviderRuntimeWriter,
    context: ProviderRuntimeContext,
  ): Promise<unknown>;
  /**
   * Withdraws a message the host wrote but has not started running.
   *
   * Optional for the same reason the whole entry is absent for most providers:
   * a driver that never writes into a busy process has no queue to withdraw
   * from, and a caller reaching this one must read the absence as "cannot",
   * never as "did".
   */
  cancelQueuedInput?(
    appSessionId: string,
    messageUuid: string,
  ): Promise<HostQueuedInputCancelResult>;
  /**
   * The uuid of a busy send's message, read off the resident process's own
   * queue — the id `cancelQueuedInput` withdraws it by.
   *
   * Optional for the same reason the whole entry is absent for most providers:
   * a driver that never writes into a busy process has no queue to name a
   * message in, and a caller reaching this one must read the absence as
   * "cannot", never as "no message is queued". Synchronous because the queue is
   * the driver's own memory: the message was written before the dispatch that
   * queued it resolved, so there is no I/O to await.
   */
  queuedInputUuid?(appSessionId: string): string | null;
  /**
   * How much of the person's text the resident process's own queue is still
   * holding — the count and byte readings a caller reconciles a local guess
   * against.
   *
   * @remarks
   * Optional for the same reason the rest of this structural type is: a driver
   * whose resident process has no readable queue has nothing to hand back, and a
   * caller reaching this one must read the absence as "cannot say", never as
   * "nothing is queued". Synchronous, like {@link queuedInputUuid}: the queue is
   * the driver's own memory, so there is no I/O to await, and the reading is
   * returned as a detached copy so no caller can reach into host state.
   */
  pendingQueuedInputs?(appSessionId: string): HostPendingQueuedInputs | null;
  /**
   * The `commandUuid`s the resident process has already dequeued into a turn.
   *
   * The other half of the same `command_lifecycle` record
   * {@link pendingQueuedInputs} reads: that one accounts for what is still
   * waiting, this one for what has left. It is the reading an interrupt fence
   * joins a heard sentence against (SPEC §18.3 R-4.3) — the dequeued set comes
   * from the process that did the dequeuing, never from message ids a proxy
   * inferred.
   *
   * Optional for the same reason the rest of this structural type is: a driver
   * whose resident process keeps no lifecycle record has nothing to hand back,
   * and a caller reaching this one must read the absence as "cannot say", never
   * as "nothing has started". Synchronous, like {@link pendingQueuedInputs}:
   * the list is the driver's own memory, so there is no I/O to await.
   */
  startedQueuedCommands?(appSessionId: string): readonly string[] | null;
  /**
   * Whether the resident process has a turn IN FLIGHT, or `null` when it cannot say.
   *
   * The authority the activity store's turn phase lacks: `state.rounds` is the resident process's own
   * FIFO of armed turns, so a non-empty list is the process's own account of "busy" — where the phase
   * is a reduction of stream traffic that leaves `idle` mid-turn (see
   * `claude-host-driver.provider.ts`'s `runInFlight`). Read by the composition root's
   * `hostRunActivity` (`server/index.ts`, through this gateway), which prefers it and keeps the phase
   * reading only for the sessions whose driver cannot answer.
   *
   * Optional for the same reason the rest of this structural type is: a driver with no turn model has
   * nothing to hand back, and a caller reaching this one must read the absence as "cannot say", never
   * as "idle". Synchronous, like {@link pendingQueuedInputs}: the rounds list is the driver's own
   * memory, so there is no I/O to await.
   */
  runInFlight?(appSessionId: string): boolean | null;
  /**
   * Stops one named background task the resident process is running, leaving
   * the turn and the process alone.
   *
   * Resolves `true` when a live process was really asked and `false` when there
   * was none to ask. Optional for the same reason the rest of the entry is: a
   * driver whose resident process exposes no stop verb has nothing to place, and
   * a caller must read the absence as "cannot", never as "did".
   */
  stopTask?(appSessionId: string, taskId: string): Promise<boolean>;
  /**
   * Promotes one named foreground tool the resident process is running to a
   * background task, leaving the turn and the process alone.
   *
   * Resolves the SDK's own boolean: `true` when a live process held a matching
   * foreground tool and backgrounded it, `false` when there was none to promote.
   * Optional for the same reason the rest of the entry is: a driver whose
   * resident process exposes no background verb has nothing to place, and a
   * caller must read the absence as "cannot", never as "did".
   */
  background?(appSessionId: string, toolUseId: string): Promise<boolean>;
  /**
   * The Remote Control refusal this driver last made for a session, or null.
   *
   * Necessary without a host, which is why it is a reading of its own rather
   * than a field on one: the gate refuses *before* any host is opened, so the
   * only trace a refusal leaves is the thrown error — and the application
   * dispatch catches that, logs it, and ends the turn with a terminal frame. A
   * caller that only sees the end of a run therefore has no way to learn *why*
   * unless the driver keeps the answer and something passes it through, which is
   * this entry.
   *
   * Optional for the same reason the rest of this structural type is: a driver
   * that runs no launch gate has nothing to report, and a caller reaching this
   * one must read the absence as "cannot say", never as "nothing refused".
   */
  remoteControlRefusal?(appSessionId: string): RemoteControlRefusalReading | null;
};

/**
 * Reads the application session id out of a run's options.
 *
 * `options.sessionId` is the stable app id every runtime already receives (and
 * the id `abort` is called with), which is what a host binding is keyed by.
 * Callers that pass none get no host, rather than a host keyed by a
 * provider-native id that changes every run.
 */
function resolveAppSessionId(options: AnyRecord): string | null {
  const sessionId = options?.sessionId;
  return typeof sessionId === 'string' && sessionId ? sessionId : null;
}

/**
 * Runs one stop-task driver call under a bound, mapping its settlement to the
 * control plane's answer.
 *
 * The call is wrapped before it is raced so a late rejection cannot escape as an
 * unhandled rejection once `timeout` has already won: the promise's own handler
 * turns a throw into `error`, and the race only decides between that settled
 * value and the timer. A driver that resolves `false` placed nothing — the same
 * answer as a driver with no verb — so `false` maps to `unsupported`, never to a
 * claim that the task stopped.
 */
async function boundStopTaskCall(
  call: () => Promise<boolean>,
  timeoutMs: number,
): Promise<ControlStopTaskOutcome> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const settled = Promise.resolve()
    .then(call)
    .then(
      (placed): ControlStopTaskOutcome => (placed === false ? 'unsupported' : 'requested'),
      (): ControlStopTaskOutcome => 'error',
    );
  const expired = new Promise<ControlStopTaskOutcome>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    // Never let the bound hold the server's event loop open on its own.
    (timer as { unref?: () => void }).unref?.();
  });

  try {
    return await Promise.race([settled, expired]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Runs one background-task driver call under a bound, mapping its settlement to
 * the control plane's answer.
 *
 * The mirror of `boundStopTaskCall` with one deliberate difference: a driver that
 * resolves `false` means the live process held *no matching foreground tool*
 * (`no-foreground-match`), not that the verb was missing. A missing verb is
 * answered `unsupported` by the caller before any call is wrapped, so `false`
 * here is unambiguously the SDK's own "not a foreground tool I hold". The call is
 * wrapped before it is raced so a late rejection cannot escape as an unhandled
 * rejection once `timeout` has already won.
 */
async function boundBackgroundTaskCall(
  call: () => Promise<boolean>,
  timeoutMs: number,
): Promise<ControlBackgroundTaskOutcome> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const settled = Promise.resolve()
    .then(call)
    .then(
      (matched): ControlBackgroundTaskOutcome =>
        matched === false ? 'no-foreground-match' : 'requested',
      (): ControlBackgroundTaskOutcome => 'error',
    );
  const expired = new Promise<ControlBackgroundTaskOutcome>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    // Never let the bound hold the server's event loop open on its own.
    (timer as { unref?: () => void }).unref?.();
  });

  try {
    return await Promise.race([settled, expired]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Resolves the resident turn entry for one run, or null when the run is not
 * resident.
 *
 * Three facts have to agree, and each is owned by a different layer, which is
 * the point of checking them separately:
 *
 *  1. **The session's own preference** — what the user asked for, read from the
 *     session row. A session that has never been set reads `per-run`.
 *  2. **The provider's declaration** — `lifecycleModes` in the capability
 *     matrix, which is what keeps a stored preference from turning into a
 *     promise the provider never made (a resident preference on a session whose
 *     provider only runs per-turn processes would otherwise route a turn into a
 *     driver that cannot serve it).
 *  3. **The driver's own shape** — the entry above must really be there. A
 *     provider whose capabilities and driver disagree is a bug, and the safe
 *     reading of a bug is the behavior every session had before resident mode
 *     existed: the turn runs per-run.
 *
 * A probe that throws answers "not resident" for the same reason — the mode is a
 * detail of *how* a turn runs, and it must not be able to stop a turn from
 * running at all.
 */
function residentEntryFor(provider: IProvider, appSessionId: string | null): ResidentTurnEntry | null {
  if (!appSessionId) {
    return null;
  }

  // The declaration is read from two stores because a provider states its
  // lifecycle modes in one of two places, depending on whether it is in the
  // `LLMProvider` union: a union provider's row lives in the static table, and a
  // provider outside the union — one whose id cannot be validated against the
  // union and therefore must not be added to it — states its modes through
  // `declareRuntimeProviderCapabilities`. Both are read here, because the
  // question this function asks is "did this provider declare `resident`", not
  // "which table did it use"; reading only the first would make every non-union
  // provider's declaration unreachable, which is the one place its declaration
  // could have been read.
  try {
    const modes = providerCapabilitiesService.getProviderCapabilities(provider.id)?.lifecycleModes
      ?? providerCapabilitiesService.getRuntimeProviderCapabilities(provider.id)?.lifecycleModes
      ?? [];
    if (!modes.includes('resident')) {
      return null;
    }
  } catch {
    return null;
  }

  const driver = provider.hostDriver as unknown as Partial<ResidentTurnEntry> | undefined;
  if (!driver || typeof driver.run !== 'function') {
    return null;
  }

  return driver as ResidentTurnEntry;
}

/**
 * Creates the application-facing provider runtime dispatcher.
 *
 * The provider registry owns each concrete runtime. This service supplies the
 * registry-backed model/session lookups at execution time so runtime adapters
 * never import services that resolve back through the registry.
 */
export function createProviderRuntimeService(
  dependencyOverrides: Partial<ProviderRuntimeServiceDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };

  const createRuntimeContext = (
    provider: IProvider,
  ): ProviderRuntimeContext => ({
    resolveProviderSessionId: dependencies.resolveProviderSessionId,
    resolveResumeModel: (sessionId, requestedModel) =>
      dependencies.resolveResumeModel(provider.id, sessionId, requestedModel),
    getProviderModels: async () => dependencies.getProviderModels(provider.id),
    normalizeMessage: (raw, sessionId) => provider.sessions.normalizeMessage(raw, sessionId),
    async isProviderInstalled() {
      try {
        return (await provider.auth.getStatus()).installed;
      } catch {
        // Preserve the runtime's original error when installation probing fails.
        return true;
      }
    },
  });

  /**
   * Resolves one run's resident entry, or null when the run takes the per-run
   * path.
   *
   * The mode is read last and defensively: it is the only one of the three facts
   * that comes from storage, and a session whose mode cannot be read is a session
   * whose turns must still run. The two facts that come from code — the
   * provider's declaration and the driver's shape — are read by
   * `residentEntryFor` and are what keep the mode from being the only thing
   * standing between a stored preference and a route that cannot serve it.
   */
  const resolveResidentEntry = (
    provider: IProvider,
    appSessionId: string | null,
  ): ResidentTurnEntry | null => {
    const entry = residentEntryFor(provider, appSessionId);
    if (!entry || !appSessionId) {
      return null;
    }

    try {
      return dependencies.resolveSessionLifecycleMode(appSessionId) === 'resident' ? entry : null;
    } catch {
      return null;
    }
  };

  /**
   * The resident driver serving a session *and* the process it is holding.
   *
   * Stricter than `resolveResidentEntry` in exactly one way: a live host is
   * required. The mode questions — is this session resident, does the provider
   * declare it, does the driver have the entry — are that function's, and are
   * asked through it so the two answers cannot drift. What is added here is the
   * process: writing into a busy session, or withdrawing something from it, is
   * meaningless without one, and a session whose host is not up is a session
   * whose next turn is a cold start rather than a busy write.
   */
  const resolveResidentDriver = (
    provider: IProvider,
    appSessionId: string | null,
  ): { entry: ResidentTurnEntry; host: ProcessHost } | null => {
    const entry = resolveResidentEntry(provider, appSessionId);
    if (!entry || !appSessionId) {
      return null;
    }

    const host = dependencies.sessionHostManager.liveHostForSession(appSessionId);
    if (!host) {
      return null;
    }

    return { entry, host };
  };

  const run = (
    providerName: LLMProvider,
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
  ): Promise<unknown> => {
    const provider = dependencies.resolveProvider(providerName);
    const appSessionId = resolveAppSessionId(options);
    const context = createRuntimeContext(provider);
    const resident = resolveResidentEntry(provider, appSessionId);

    if (resident && appSessionId) {
      // Resident dispatch: the provider's own driver owns the process across
      // turns, so the per-run wrapper is bypassed entirely — it would open a
      // process for this turn and close it at the turn's end, which is the
      // behavior resident mode exists to replace. The driver brings its process
      // up on the first turn and writes later turns into the process it is
      // already holding; `options` therefore reaches it as the *first* turn's
      // launch options when the session is cold, and as a later turn's options
      // (attachments, command) when it is not.
      return resident.run(appSessionId, { command, options }, writer, context);
    }

    // Every other dispatched turn becomes a per-run host. The manager only
    // observes — it wraps the writer so it can see the terminal frame and hands
    // the runtime's own promise straight back — so the runtimes below stay
    // byte-identical and this stays the single dispatch entry point.
    return dependencies.sessionHostManager.trackPerRunTurn({
      provider: providerName,
      appSessionId,
      writer,
      start: (observingWriter) => provider.runtime.run(command, options, observingWriter, context),
    });
  };

  return {
    run,

    hasRuntime(providerName: string): boolean {
      try {
        return Boolean(dependencies.resolveProvider(providerName).runtime);
      } catch {
        return false;
      }
    },

    getRunner(provider: LLMProvider): ProviderRunFunction {
      return (command, options, writer) => run(provider, command, options, writer);
    },

    /**
     * Whether a turn dispatched right now would be written into a live process.
     *
     * "Busy input" is not a session setting, it is a state: the same session is
     * accepting it in the middle of a turn and cold-starting between turns, and
     * the caller has to be told which before it decides what a second send
     * means. Everything that could make the answer stale — the mode, the
     * declaration, the driver's shape, the pid — is resolved in the same call,
     * so `true` means a write would land and not merely that it might.
     */
    acceptsBusyInput(providerName: LLMProvider, sessionId: string): boolean {
      try {
        return Boolean(resolveResidentDriver(dependencies.resolveProvider(providerName), sessionId));
      } catch {
        return false;
      }
    },

    /**
     * Withdraws a queued message from a live resident process.
     *
     * `unknown` is the answer to every question this service cannot answer —
     * an unknown provider, a session that is not resident, a driver without
     * the entry, a host that is gone — because the one thing this caller must
     * never be told is that a message was withdrawn when it was not. The
     * driver's own verdict passes through unchanged.
     */
    async cancelQueuedInput(
      providerName: LLMProvider,
      sessionId: string,
      messageUuid: string,
    ): Promise<HostQueuedInputCancelResult> {
      try {
        const resolved = resolveResidentDriver(dependencies.resolveProvider(providerName), sessionId);
        const cancel = resolved?.entry.cancelQueuedInput;
        if (!resolved || typeof cancel !== 'function') {
          return 'unknown';
        }
        return await cancel.call(resolved.entry, sessionId, messageUuid);
      } catch {
        return 'unknown';
      }
    },

    /**
     * The uuid the resident process stamped a just-queued message with.
     *
     * Resolved through the same `resolveResidentDriver` every resident control
     * verb uses — the session's stored mode, the provider's declaration, the
     * driver's shape and a live host all have to agree — and read off the
     * driver's own queue. `null` is the answer to everything this service cannot
     * answer: an unknown provider, a session that is not resident, a driver
     * without the verb, an empty queue, or any throw. The conservative direction
     * matters because the caller writes the returned id into a message it will
     * later offer to withdraw: a fabricated id would be unwithdrawable, and a
     * "queued with an empty uuid" would be a lie. Consumed by the websocket
     * control service's busy-send branch (`chat-control.service.ts`).
     */
    async queuedInputUuid(providerName: LLMProvider, sessionId: string): Promise<string | null> {
      try {
        const resolved = resolveResidentDriver(dependencies.resolveProvider(providerName), sessionId);
        const read = resolved?.entry.queuedInputUuid;
        if (!resolved || typeof read !== 'function') {
          return null;
        }
        const uuid = read.call(resolved.entry, sessionId);
        return typeof uuid === 'string' && uuid.length > 0 ? uuid : null;
      } catch {
        return null;
      }
    },

    /**
     * How much a session's live resident queue is still holding, read off the
     * driver that owns the process.
     *
     * A READ-ONLY sample a caller takes at the moments it reports a queue depth
     * (the voice relay reconciles its own count against it — SPEC §18.1 F-3).
     * Resolved through the same `resolveResidentDriver` every resident control
     * verb uses — the session's stored mode, the provider's declaration, the
     * driver's shape and a live host all have to agree — so a number here is a
     * number a live process really holds.
     *
     * `null` is the answer to every question this service cannot answer: an
     * unknown provider, a session that is not resident, a driver without the
     * verb, a host that is gone, or any throw. The caller must read it as
     * "unknown queue depth", never as "empty" — that distinction is the whole
     * reason the reading is a structural type rather than two numbers.
     */
    pendingQueuedInputs(
      providerName: LLMProvider,
      sessionId: string,
    ): HostPendingQueuedInputs | null {
      try {
        const resolved = resolveResidentDriver(dependencies.resolveProvider(providerName), sessionId);
        const read = resolved?.entry.pendingQueuedInputs;
        if (!resolved || typeof read !== 'function') {
          return null;
        }
        const reading = read.call(resolved.entry, sessionId);
        if (!reading) {
          return null;
        }
        return {
          items: Math.max(0, Math.trunc(reading.items)),
          bytes: Math.max(0, Math.trunc(reading.bytes)),
        };
      } catch {
        return null;
      }
    },

    /**
     * Which of a session's queued commands its live resident process has
     * already dequeued into a turn, read off the driver that owns the process.
     *
     * The SIBLING of {@link pendingQueuedInputs} over the same driver record,
     * answering the other half of the question: not "how much is still waiting"
     * but "what has left". Resolved through the same `resolveResidentDriver`
     * every resident control verb uses — the session's stored mode, the
     * provider's declaration, the driver's shape and a live host all have to
     * agree — so a uuid here is one a live process really took up (SPEC §18.3
     * R-4.3: the reading comes from the process's own `command_lifecycle`, never
     * from ids a caller inferred from the messages it sent).
     *
     * `null` is the answer to every question this service cannot answer: an
     * unknown provider, a session that is not resident, a driver without the
     * verb, a host that is gone, a driver that answered something that is not a
     * list, or any throw. An EMPTY LIST is not one of those answers — it is the
     * reading of a live process that has dequeued nothing — which is why this is
     * a `null`-able list rather than a list defaulting to empty. Consumed by the
     * composition root's `hostCommandLifecycle` seam (`server/index.ts`), which
     * the voice relay's interrupt fence samples (`voice-realtime-ws-proxy.service.ts`).
     */
    startedQueuedCommands(providerName: LLMProvider, sessionId: string): readonly string[] | null {
      try {
        const resolved = resolveResidentDriver(dependencies.resolveProvider(providerName), sessionId);
        const read = resolved?.entry.startedQueuedCommands;
        if (!resolved || typeof read !== 'function') {
          return null;
        }
        const started = read.call(resolved.entry, sessionId);
        if (!Array.isArray(started)) {
          return null;
        }
        // A detached copy, like every other reading here: a caller must not be
        // able to reach back into host state through the array it was handed.
        // Non-string entries are dropped rather than passed through, because the
        // one use this reading has is an exact-match join on uuids.
        return started.filter((uuid): uuid is string => typeof uuid === 'string' && uuid !== '');
      } catch {
        return null;
      }
    },

    /**
     * Whether a session's live resident process has a turn in flight, read off the driver that owns
     * the process.
     *
     * The AUTHORITY the turn-phase reading is not: resolved through the same `resolveResidentDriver`
     * every resident control verb uses — the session's stored mode, the provider's declaration, the
     * driver's shape and a live host all have to agree — so a `true` here is a turn a live process
     * really holds, taken from its own `rounds` FIFO rather than reduced from stream traffic (see
     * `claude-host-driver.provider.ts`'s `runInFlight`). Consumed by the composition root's
     * `hostRunActivity` seam (`server/index.ts`), which the voice relay samples to decide whether it
     * holds its ONE merged message.
     *
     * `null` is the answer to every question this service cannot answer: an unknown provider, a
     * session that is not resident, a driver without the verb, a host that is gone, a driver that
     * answered something that is not a boolean, or any throw. A caller must read it as "cannot say"
     * and keep the reading it had before — never as "idle".
     */
    runInFlight(providerName: LLMProvider, sessionId: string): boolean | null {
      try {
        const resolved = resolveResidentDriver(dependencies.resolveProvider(providerName), sessionId);
        const read = resolved?.entry.runInFlight;
        if (!resolved || typeof read !== 'function') {
          return null;
        }
        const reading = read.call(resolved.entry, sessionId);
        return typeof reading === 'boolean' ? reading : null;
      } catch {
        return null;
      }
    },

    /**
     * Applies a model / effort / permission-mode change to a session's live
     * resident process, or reports that it cannot be placed.
     *
     * This verb is a PASS-THROUGH and nothing else — it does not decide whether
     * the provider supports live reconfiguration. That question belongs to the
     * capability matrix (`residentFeatures.liveReconfigure`) and is read by the
     * caller (the MCP `session_reconfigure` adapter, AC-272) before it reaches
     * here; a second, competing judgement at this layer would be the one that
     * drifts. What this verb does decide is *placement*: it resolves the
     * session's resident driver and the process it is holding, and hands the
     * patch to the driver's own `IProviderHostDriver.reconfigure`, passing the
     * driver's verdict back unchanged.
     *
     * `unsupported` is the answer to every question this service cannot place —
     * an unknown provider, a session that is not resident, a driver that carries
     * no `reconfigure` verb, or (load-bearing) a session with no live host.
     * A change with nothing running to apply it to is answered `unsupported`,
     * never `next-turn`: the caller must be able to tell "the change is queued
     * for the next turn" from "there is no live process to change".
     *
     * Consumed by the MCP gateway's `session_reconfigure` handler, which is
     * wired to the process singleton (`server/index.ts`) and, in the criterion,
     * to a runtime built over the scripted resident driver.
     */
    async reconfigure(
      providerName: LLMProvider,
      sessionId: string,
      patch: HostReconfigurePatch,
    ): Promise<HostReconfigureOutcome> {
      let provider: IProvider;
      try {
        provider = dependencies.resolveProvider(providerName);
      } catch {
        return 'unsupported';
      }

      const resolved = resolveResidentDriver(provider, sessionId);
      if (!resolved) {
        return 'unsupported';
      }

      const driver = provider.hostDriver;
      if (!driver || typeof driver.reconfigure !== 'function') {
        return 'unsupported';
      }

      return driver.reconfigure(resolved.host, sessionId, patch);
    },

    /**
     * Stops one named background task, through whichever route serves the
     * session, under a bound on the driver call.
     *
     * The two routes are the same split every lifecycle verb in this file makes:
     * a resident session is asked through the driver that owns its held process,
     * and everything else through the per-run runtime the turn itself ran on.
     * The resident route is gated on the capability matrix first — the SDK verb
     * exists but has not been measured against a live resident process, so an
     * unmeasured `false` answers `unsupported` before any driver is touched.
     *
     * Nothing here waits for the task to stop or reads the task table; that is
     * the control handler's half, and keeping it out is what lets this verb
     * answer "the request landed" without owning "the task stopped".
     */
    async controlStopTask(
      providerName: LLMProvider,
      sessionId: string,
      taskId: string,
    ): Promise<ControlStopTaskOutcome> {
      let provider: IProvider;
      try {
        provider = dependencies.resolveProvider(providerName);
      } catch {
        return 'unsupported';
      }

      const resident = resolveResidentEntry(provider, sessionId);
      if (resident) {
        if (!dependencies.residentStopTaskSupported(provider.id)) {
          return 'unsupported';
        }
        const stop = resident.stopTask;
        if (typeof stop !== 'function') {
          return 'unsupported';
        }
        return boundStopTaskCall(
          () => stop.call(resident, sessionId, taskId),
          dependencies.stopTaskCallTimeoutMs,
        );
      }

      const runtime = provider.runtime as unknown as PerRunStopTaskRuntime;
      if (typeof runtime.stopTask !== 'function') {
        return 'unsupported';
      }
      return boundStopTaskCall(
        () => runtime.stopTask!(sessionId, taskId),
        dependencies.stopTaskCallTimeoutMs,
      );
    },

    /**
     * Promotes one named foreground tool to a background task, through whichever
     * route serves the session, under a bound on the driver call.
     *
     * The same route split every lifecycle verb in this file makes: a resident
     * session is asked through the driver that owns its held process, and
     * everything else through the per-run runtime the turn itself ran on. As with
     * `controlStopTask`, the resident route is gated on the capability matrix
     * first — the SDK verb exists but has not been measured against a live
     * resident process, so an unmeasured `false` answers `unsupported` before any
     * driver is touched. Unlike stop-task, a driver that settles `false` is not
     * `unsupported` but `no-foreground-match`: the verb was reached and simply
     * held no matching foreground tool.
     *
     * Nothing here reads the Turn Tracker or the task table — the handler has
     * already addressed the request against the tracker, and how the task later
     * appears is the reducer's business. Keeping both out is what lets this verb
     * answer "the request landed" without owning either.
     */
    async controlBackgroundTask(
      providerName: LLMProvider,
      sessionId: string,
      toolUseId: string,
    ): Promise<ControlBackgroundTaskOutcome> {
      let provider: IProvider;
      try {
        provider = dependencies.resolveProvider(providerName);
      } catch {
        return 'unsupported';
      }

      const resident = resolveResidentEntry(provider, sessionId);
      if (resident) {
        if (!dependencies.residentBackgroundTaskSupported(provider.id)) {
          return 'unsupported';
        }
        const background = resident.background;
        if (typeof background !== 'function') {
          return 'unsupported';
        }
        return boundBackgroundTaskCall(
          () => background.call(resident, sessionId, toolUseId),
          dependencies.backgroundTaskCallTimeoutMs,
        );
      }

      const runtime = provider.runtime as unknown as PerRunBackgroundTaskRuntime;
      if (typeof runtime.backgroundTask !== 'function') {
        return 'unsupported';
      }
      return boundBackgroundTaskCall(
        () => runtime.backgroundTask!(sessionId, toolUseId),
        dependencies.backgroundTaskCallTimeoutMs,
      );
    },

    /**
     * The Remote Control refusal the resident driver last made for a session.
     *
     * Read through `resolveResidentEntry` and *not* `resolveResidentDriver`, and
     * that difference is the whole reason this entry exists as its own reading:
     * the gate refuses before a process is opened, so the moment a refusal is the
     * answer is the one moment there is no live host to hang it off. Requiring a
     * host here would make the refusal unreadable exactly when it happened.
     *
     * `null` for every question this service cannot answer — an unknown provider,
     * a session that is not resident, a driver with no gate, a session whose last
     * launch passed — because the alternative reading, "nothing was refused", is
     * the one thing a caller must not be handed on the strength of a probe that
     * failed. A refusal that really happened is a value the driver keeps until
     * the next launch overwrites it, so this is a reading of *what the driver
     * last said*, not of whether a turn is currently being blocked.
     */
    remoteControlRefusal(
      providerName: LLMProvider,
      sessionId: string,
    ): RemoteControlRefusalReading | null {
      try {
        const entry = resolveResidentEntry(dependencies.resolveProvider(providerName), sessionId);
        const read = entry?.remoteControlRefusal;
        if (!entry || typeof read !== 'function') {
          return null;
        }
        return read.call(entry, sessionId) ?? null;
      } catch {
        return null;
      }
    },

    /**
     * Opens one session's own resident process, with no turn behind it.
     *
     * The dispatch the on-demand [Start] control reaches through the host
     * module's HTTP face, and the reason it lives here: the launch needs an
     * options bag assembled from this layer's own sources and a runtime context
     * built from the resolved provider, neither of which the caller has. What
     * this method does *not* decide is whether the session should be started —
     * the caller has already established that it is resident and that its
     * provider mounts a driver — nor whether the driver can be asked at all,
     * which is the caller's branch (the `startResidentSession` capability check
     * in `session-hosts.routes.ts`).
     *
     * It throws rather than answering a refusal value, because every reason it
     * can fail is the caller's to report and each carries a sentence the user
     * needs: a driver that vanished between the caller's check and this call, a
     * launch the driver's own gate refused (Remote Control), a process that came
     * up but was never adopted. The caller turns the throw into its named
     * `LIFECYCLE_MODE_HOST_UNAVAILABLE` refusal with the message kept verbatim —
     * the difference between "nothing was started" and "nothing was started
     * because <this>" is the whole value of the answer.
     */
    async startResidentSession(
      providerName: LLMProvider,
      sessionId: string,
    ): Promise<HostResidentStartResult> {
      const provider = dependencies.resolveProvider(providerName);
      const driver = provider.hostDriver;
      const start = driver?.startResidentSession;
      if (!driver || typeof start !== 'function') {
        throw new Error(
          `Provider "${providerName}" mounts no driver that can start a session's resident process on demand.`,
        );
      }

      return start.call(driver, sessionId, {
        options: await dependencies.resolveResidentLaunchOptions(providerName, sessionId),
        context: createRuntimeContext(provider),
      });
    },

    async abort(providerName: LLMProvider, sessionId: string): Promise<boolean> {
      const provider = dependencies.resolveProvider(providerName);
      const resident = resolveResidentEntry(provider, sessionId);

      if (resident) {
        // Resident abort stops the turn, not the process: the driver's interrupt
        // is the SDK's own, which leaves the CLI running so the next turn lands
        // on the same pid. `requestAbort` below is deliberately not reached for
        // this mode — it closes the host, and closing a resident host is exactly
        // killing the process the mode exists to hold. The turn's terminal
        // `complete` is the caller's (the websocket abort handler sends it on the
        // run's behalf), so a false here means no round was in flight to stop.
        const driver = provider.hostDriver;
        const host = dependencies.sessionHostManager.liveHostForSession(sessionId);
        if (!driver || !host) {
          return false;
        }
        return driver.interrupt(host, sessionId);
      }

      const aborted = Boolean(await provider.runtime.abort(sessionId));
      if (aborted) {
        // The runtime confirmed it stopped something, so the host bound to this
        // session is aborted rather than left busy. Reported after `abort` (not
        // before) so a failed stop never closes a host that is still running.
        dependencies.sessionHostManager.requestAbort(sessionId);
      }
      return aborted;
    },

    resolveToolApproval(
      requestId: string,
      decision: ProviderPermissionDecision,
      decidedBy: string | null = null,
    ): void {
      for (const provider of dependencies.listProviders()) {
        provider.runtime.permissions?.resolve(requestId, decision, decidedBy);
      }
    },

    getPendingApprovalsForSession(sessionId: string): unknown[] {
      return dependencies.listProviders().flatMap(
        (provider) => provider.runtime.permissions?.listPending(sessionId) ?? [],
      );
    },

    /**
     * Asks the providers whose permission facet can classify an absent
     * `requestId` why it is absent (`'expired'` vs `'never_issued'`).
     *
     * The id belongs to whichever provider minted it, and only that provider's
     * ledger knows whether it was ever here — so this asks EVERY provider with
     * the facet, not the first one. Asking only the first was invisible while
     * claude was the sole provider with a ledger, but a second ledger (the debug
     * agent's) would have every id it minted answered by claude's `never_issued`,
     * misreporting a genuinely held-then-dropped debug request. An id only one
     * ledger held reads from that ledger; `expired` is returned as soon as any
     * facet reports it (a stricter, non-conservative reading a second ledger
     * must not be able to hide).
     *
     * Returns `null` when no provider implements the facet — a runtime whose
     * registry cannot tell the two apart — so the caller applies its own
     * conservative default rather than reading a fabricated answer.
     *
     * Consumed by `chat-control.service.ts`'s `answerApproval` and, through it,
     * the MCP `approval_answer` envelope's `details.reason` (AC-287).
     */
    classifyMissingApproval(requestId: string): MissingApprovalReason | null {
      let sawFacet = false;
      for (const provider of dependencies.listProviders()) {
        const classify = provider.runtime.permissions?.classifyMissingApproval;
        if (typeof classify !== 'function') {
          continue;
        }
        sawFacet = true;
        if (classify(requestId) === 'expired') {
          return 'expired';
        }
      }
      return sawFacet ? 'never_issued' : null;
    },

    /**
     * Asks the providers whose permission facet keeps a decision ledger for the
     * decision recorded for `requestId`, or `null` if none has one.
     *
     * Asks every facet, not the first, for the reason `classifyMissingApproval`
     * above does: the id belongs to whichever provider armed it, and a second
     * ledger must be reachable rather than shadowed by claude's always-present
     * facet returning `null`. The first facet that has a record answers;
     * `null` means "no provider decided this" — either still pending or never
     * issued — and the caller falls back to its missing-approval classification.
     *
     * Consumed by `chat-control.service.ts`'s `answerApproval` to report a lost
     * race as `ALREADY_DECIDED` rather than `APPROVAL_EXPIRED_OR_NOT_FOUND`.
     */
    readApprovalDecision(requestId: string): ApprovalDecisionRecord | null {
      for (const provider of dependencies.listProviders()) {
        const read = provider.runtime.permissions?.readApprovalDecision;
        if (typeof read !== 'function') {
          continue;
        }
        const record = read(requestId);
        if (record) {
          return record;
        }
      }
      return null;
    },
  };
}

export const providerRuntimeService = createProviderRuntimeService();
