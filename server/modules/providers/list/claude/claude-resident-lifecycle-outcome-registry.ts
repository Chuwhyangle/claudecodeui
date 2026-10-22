/**
 * The registration and dispatch seam for Claude's resident host lifecycle outcomes.
 *
 * The first extension point (`claude-resident-outcome-registry.ts`) moved the
 * driver's *readings* out of `ClaudeResidentHostDriver`. Every reading answers a
 * question about host state and changes nothing. This second seam is its
 * complement: the run/turn endings, the reconcile beat's reaction to a
 * divergence, the held-work reconciler, the title mirror and the `[ledger]`
 * lines are all *reactions* — they settle a round, report a lease, write a
 * frame, publish an identity. They used to be methods on the 6k-line class, so
 * adding one meant editing the centre.
 *
 * A lifecycle outcome is a handler with a name, a label, a source, and a
 * `handle(context, state, payload)` body. The shipped set lives in
 * `claude-resident-lifecycle-outcome-handlers.ts`, a sibling file; the driver
 * imports the factory and names no reaction body of its own.
 *
 * ## Why a `state` argument and a small context, rather than `this`
 *
 * The readings could be served by a read-only snapshot (two maps) because they
 * never write. Reactions must write the host state they are reacting to, so the
 * handler is handed that state explicitly. What it must NOT get is the driver:
 * the context below carries only the driver's injected seams — the clock, the
 * log sink, the notification port, the run registry, and the handful of
 * construction constants the old bodies closed over. A handler therefore cannot
 * reach a driver private it did not receive as data, which is the same
 * discipline the first registry states for readings.
 *
 * ## Dispatch when nothing is registered
 *
 * `dispatch` returns `null` rather than throwing, exactly as the reading
 * registry does. Every outcome is a reaction the driver performs while handling
 * a frame; "no handler" degrades to "nothing happened", the same conservative
 * answer an unregistered reading gives. That is also what makes the negative
 * control meaningful: unregister a handler, dispatch again, and its body must
 * not run.
 *
 * Consumers: `claude-host-driver.provider.ts` (the dispatch half),
 * `claude-resident-lifecycle-outcome-handlers.ts` (the registration half) and
 * `tests/claude-resident-lifecycle-outcome-registry.test.ts` (the criterion).
 */
import type { AnyRecord, LLMProvider } from '@/shared/types.js';

import type {
  ClaudeCliSessionRegistration,
  ClaudeResidentReconcileMode,
  ClaudeResidentReconcileReading,
  ClaudeResidentRunRegistryPort,
  ClaudeUnattendedWorkEvent,
  ResidentHostState,
} from './claude-host-driver.provider.js';

/** One run the driver's FIFO may drop — a projection of the host state's own list. */
export type ClaudeResidentLifecycleRound = ResidentHostState['rounds'][number];
/** One held `cron` lease, as the host state carries it. */
export type ClaudeResidentLifecycleCronLease = ResidentHostState['heldCrons'][number];
/** One held background-work lease, as the host state carries it. */
export type ClaudeResidentLifecycleBackgroundTaskLease =
  ResidentHostState['heldBackgroundTasks'][number];
/** Either held-work reason, so convergence stays inside the two kinds that carry an id. */
export type ClaudeResidentLifecycleHeldWorkLease =
  | ClaudeResidentLifecycleCronLease
  | ClaudeResidentLifecycleBackgroundTaskLease;

/**
 * The lifecycle outcome kinds the driver dispatches.
 *
 * One name per reaction that used to be an inlined method, grouped by the event
 * domain the plan names: run/turn endings (`dropRound` … `abandonUnattendedTurn`),
 * the reconcile beat (`reconcileTick`), held work (`settleCrons` … `inferHeldWork`)
 * and the title mirror (`startIdentityReadback` … `mirrorResidentTitle`), plus
 * the `[ledger]`/`[reconcile]` writers. The union is closed on purpose: a new
 * reaction is a new name here and a new handler beside it, which is the visible
 * diff this extension point exists to produce.
 */
export type ClaudeResidentLifecycleOutcomeName =
  | 'dropRound'
  | 'endWithdrawnRun'
  | 'settleCrons'
  | 'settleBackgroundTasks'
  | 'reconcileHeldWork'
  | 'observeHeldWorkEvent'
  | 'inferHeldWork'
  | 'reconcileTick'
  | 'emitLedgerLines'
  | 'writeLogLine'
  | 'writeReconcileLine'
  | 'startIdentityReadback'
  | 'publishIdentity'
  | 'refreshIdentityAfterRename'
  | 'stopTitleMirror'
  | 'scheduleTitleMirror'
  | 'mirrorResidentTitle'
  | 'finishUnattendedTurn'
  | 'abandonUnattendedTurn';

/**
 * The argument each kind's handler receives, alongside the host state.
 *
 * `undefined` means the kind takes no further input; every other kind names its
 * payload explicitly so the driver's delegation and the handler's body cannot
 * disagree about what an outcome is.
 */
export type ClaudeResidentLifecycleOutcomePayload = {
  dropRound: { round: ClaudeResidentLifecycleRound };
  endWithdrawnRun: { deliveryId: string };
  settleCrons: { desired: ClaudeResidentLifecycleCronLease[] };
  settleBackgroundTasks: { desired: ClaudeResidentLifecycleBackgroundTaskLease[] };
  reconcileHeldWork: { input: AnyRecord };
  observeHeldWorkEvent: { message: AnyRecord };
  inferHeldWork: { message: AnyRecord };
  reconcileTick: { appSessionId: string };
  emitLedgerLines: undefined;
  writeLogLine: { line: string };
  writeReconcileLine: { anomaly: string; detail: string };
  startIdentityReadback: { sessionId: string };
  publishIdentity: { value: string | null };
  refreshIdentityAfterRename: undefined;
  stopTitleMirror: undefined;
  scheduleTitleMirror: undefined;
  mirrorResidentTitle: { title: string };
  finishUnattendedTurn: { sessionId: string | null; result: AnyRecord };
  abandonUnattendedTurn: { exitCode: number };
};

/**
 * The driver seams a reaction is allowed to reach.
 *
 * Deliberately only the *injected* ports and construction constants the moved
 * bodies used: the clock, the log sink, the unattended-work notification, the
 * run registry, the reconcile arm and its walls, the cron window, the CLI
 * registry reader, and the identity/title-mirror poll windows. None of these is
 * driver state; the state a reaction mutates is passed as the second argument.
 *
 * `readCliSessionRegistration` is a function on this view rather than an import
 * from the driver on purpose: the handlers file is imported BY the driver, so a
 * runtime import back would close a module cycle. Handing the reader in keeps
 * the edge one-way while leaving a single implementation of the registry read.
 */
export type ClaudeResidentLifecycleOutcomeContext = {
  readonly provider: LLMProvider;
  readonly now: () => number;
  readonly logSink: (line: string) => void;
  readonly notifyUnattendedWork: (event: ClaudeUnattendedWorkEvent) => void;
  readonly reconcileMode: ClaudeResidentReconcileMode;
  readonly quiesceMs: number;
  readonly runRegistry: ClaudeResidentRunRegistryPort;
  readonly cronMaxAgeMs: number;
  readonly reconciledReason: string;
  readonly readCliSessionRegistration: (
    configDir: string,
    pid: number,
    providerSessionId?: string | null,
  ) => ClaudeCliSessionRegistration | null;
  readonly identityBudgetMs: number;
  readonly identityPollMs: number;
  readonly titleMirrorWindowMs: number;
  readonly titleMirrorPollMs: number;
};

/**
 * One registered lifecycle outcome.
 *
 * `label` is the registration's own name (distinct from the kind it answers, so
 * a probe can replace the shipped handler and still say who it is), and `source`
 * is the file the handler was defined in — the value the criterion compares
 * against the driver's own path to prove the handler came from outside it.
 */
export type ClaudeResidentLifecycleOutcomeHandler<TResult = unknown> = {
  readonly name: ClaudeResidentLifecycleOutcomeName;
  readonly label: string;
  readonly source: string;
  readonly handle: (
    context: ClaudeResidentLifecycleOutcomeContext,
    state: ResidentHostState,
    payload: any,
  ) => TResult;
};

/** What one dispatch answered, and which handler answered it. */
export type ClaudeResidentLifecycleOutcomeDispatch<TResult> = {
  readonly handler: ClaudeResidentLifecycleOutcomeHandler<TResult>;
  readonly value: TResult;
};

/** The outcome kind that answers with a reconcile reading (the beat's own result). */
export type ClaudeResidentLifecycleReconcileResult = ClaudeResidentReconcileReading;

/**
 * A registry of lifecycle-outcome handlers, keyed by the kind each answers.
 *
 * `register` replaces an existing handler for the same kind (that is how a
 * criterion installs a probe over the shipped one) and `unregister` removes it.
 * `dispatch` is the only execution path: without a registered handler it
 * returns `null` and never calls anything.
 */
export class ClaudeResidentLifecycleOutcomeRegistry {
  private readonly handlers = new Map<
    ClaudeResidentLifecycleOutcomeName,
    ClaudeResidentLifecycleOutcomeHandler
  >();

  /** Installs (or replaces) the handler for the kind it names; returns this registry. */
  register(handler: ClaudeResidentLifecycleOutcomeHandler): ClaudeResidentLifecycleOutcomeRegistry {
    this.handlers.set(handler.name, handler);
    return this;
  }

  /** Removes the handler for a kind. Returns whether one was registered. */
  unregister(name: ClaudeResidentLifecycleOutcomeName): boolean {
    return this.handlers.delete(name);
  }

  /** Whether a kind currently has a handler. */
  has(name: ClaudeResidentLifecycleOutcomeName): boolean {
    return this.handlers.has(name);
  }

  /** The handler for a kind, or `null` when none is registered. */
  handlerFor<TResult = unknown>(
    name: ClaudeResidentLifecycleOutcomeName,
  ): ClaudeResidentLifecycleOutcomeHandler<TResult> | null {
    return (
      (this.handlers.get(name) as ClaudeResidentLifecycleOutcomeHandler<TResult> | undefined) ?? null
    );
  }

  /** The kinds that currently have a handler, in registration order. */
  names(): ClaudeResidentLifecycleOutcomeName[] {
    return [...this.handlers.keys()];
  }

  /**
   * Runs the handler registered for `name` and reports what it answered.
   *
   * `null` means "nothing is registered for this kind" — the handler was never
   * registered or was unregistered — and in that case no handler body runs. The
   * driver treats that as "this reaction did not happen", which is the same
   * conservative answer the reading registry gives.
   */
  dispatch<TResult = unknown, TName extends ClaudeResidentLifecycleOutcomeName = ClaudeResidentLifecycleOutcomeName>(
    name: TName,
    context: ClaudeResidentLifecycleOutcomeContext,
    state: ResidentHostState,
    payload: ClaudeResidentLifecycleOutcomePayload[TName],
  ): ClaudeResidentLifecycleOutcomeDispatch<TResult> | null {
    const handler = this.handlerFor<TResult>(name);
    if (!handler) {
      return null;
    }
    return { handler, value: handler.handle(context, state, payload) as TResult };
  }
}
