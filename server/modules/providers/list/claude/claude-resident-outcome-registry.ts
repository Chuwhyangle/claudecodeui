/**
 * The registration and dispatch seam for Claude's resident host readings.
 *
 * `ClaudeResidentHostDriver` is the single file every resident behaviour used to
 * be added to. The readings it answers — what a live host holds, what the CLI's
 * queue says, what the ledger recorded — are all *reads of host state*, and they
 * were inlined in a 6k-line class, so adding one meant editing the centre. This
 * file is the escape hatch: a reading is a handler with a name, a source, and a
 * `handle(context, appSessionId)` body, registered from outside the driver.
 *
 * The driver keeps its public method signatures (`IProviderHostDriver` is
 * unchanged) and the bodies become one-line delegations to {@link
 * ClaudeResidentOutcomeRegistry.dispatch}. Nothing about the readings changes:
 * the shipped handlers are the previous bodies moved verbatim into
 * `claude-resident-outcome-handlers.ts`, and the criterion in
 * `tests/claude-resident-outcome-registry.test.ts` holds a spot reading of each
 * simple one to the old answer.
 *
 * ## Registration is outside the driver, deliberately
 *
 * {@link ClaudeResidentOutcomeRegistry} holds no default handlers of its own, and
 * this file imports nothing from the driver except types. The shipped set is
 * built by `createDefaultClaudeResidentOutcomeRegistry()` in the sibling handler
 * file — so "a reading exists" is answered by a file next to the driver rather
 * than by the driver itself, and a criterion can register a probe handler from a
 * third file and watch the driver dispatch to it (handler source ≠ driver path).
 *
 * ## Dispatch when nothing is registered
 *
 * `dispatch` returns `null` rather than throwing. Every reading the driver
 * exposes already answers `null` for "cannot say" (a session this driver is not
 * hosting), so an unregistered reading degrades to the same conservative answer
 * instead of turning a read into a crash. The negative-control arm of the
 * criterion is exactly this: unregister a handler, dispatch again, and the
 * handler must not run.
 *
 * Consumers: `claude-host-driver.provider.ts` (the dispatch half),
 * `claude-resident-outcome-handlers.ts` (the registration half) and
 * `tests/claude-resident-outcome-registry.test.ts` (the criterion).
 */
import type {
  ClaudeRemoteControlRefusal,
  ResidentHostState,
} from './claude-host-driver.provider.js';

/**
 * The reading kinds the driver dispatches.
 *
 * One name per public reading method, plus the two private state lookups
 * (`liveState`, `ledgerState`) that every other reading is built on. The union is
 * closed on purpose: a new reading is a new name here and a new handler beside
 * it, which is the visible diff this extension point exists to produce.
 */
export type ClaudeResidentOutcomeName =
  | 'unattendedReading'
  | 'busyInputReading'
  | 'ledgerReading'
  | 'queuedInputUuid'
  | 'pendingQueuedInputs'
  | 'startedQueuedCommands'
  | 'runInFlight'
  | 'lifecycleReading'
  | 'permissionReading'
  | 'remoteControlRefusal'
  | 'liveState'
  | 'ledgerState';

/**
 * The host state a reading is allowed to see.
 *
 * Deliberately two maps and nothing else: a handler reads host state through
 * this view, so moving a body out of the driver cannot quietly reach a driver
 * private it used to close over. `hosts` is the per-host state map keyed by host
 * id (iterated, exactly as the old `liveStateFor`/`ledgerStateFor` did), and
 * `refusals` is the Remote Control refusal log — the one reading whose subject
 * is a session with no host at all.
 */
export type ClaudeResidentOutcomeContext = {
  readonly hosts: ReadonlyMap<string, ResidentHostState>;
  readonly refusals: ReadonlyMap<string, ClaudeRemoteControlRefusal>;
};

/**
 * One registered reading.
 *
 * `label` is the registration's own name (distinct from the kind it answers, so
 * a probe can replace the shipped handler and still say who it is), and `source`
 * is the file the handler was defined in — the value the criterion compares
 * against the driver's own path to prove the handler came from outside it.
 */
export type ClaudeResidentOutcomeHandler<TResult = unknown> = {
  readonly name: ClaudeResidentOutcomeName;
  readonly label: string;
  readonly source: string;
  readonly handle: (context: ClaudeResidentOutcomeContext, appSessionId: string) => TResult;
};

/** What one dispatch answered, and which handler answered it. */
export type ClaudeResidentOutcomeDispatch<TResult> = {
  readonly handler: ClaudeResidentOutcomeHandler<TResult>;
  readonly value: TResult;
};

/**
 * A registry of reading handlers, keyed by the kind each answers.
 *
 * `register` replaces an existing handler for the same kind (that is how a
 * criterion installs a probe over the shipped one) and `unregister` removes it.
 * `dispatch` is the only execution path: without a registered handler it
 * returns `null` and never calls anything.
 */
export class ClaudeResidentOutcomeRegistry {
  private readonly handlers = new Map<ClaudeResidentOutcomeName, ClaudeResidentOutcomeHandler>();

  /** Installs (or replaces) the handler for the kind it names; returns this registry. */
  register(handler: ClaudeResidentOutcomeHandler): ClaudeResidentOutcomeRegistry {
    this.handlers.set(handler.name, handler);
    return this;
  }

  /** Removes the handler for a kind. Returns whether one was registered. */
  unregister(name: ClaudeResidentOutcomeName): boolean {
    return this.handlers.delete(name);
  }

  /** Whether a kind currently has a handler. */
  has(name: ClaudeResidentOutcomeName): boolean {
    return this.handlers.has(name);
  }

  /** The handler for a kind, or `null` when none is registered. */
  handlerFor<TResult = unknown>(name: ClaudeResidentOutcomeName): ClaudeResidentOutcomeHandler<TResult> | null {
    return (this.handlers.get(name) as ClaudeResidentOutcomeHandler<TResult> | undefined) ?? null;
  }

  /** The kinds that currently have a handler, in registration order. */
  names(): ClaudeResidentOutcomeName[] {
    return [...this.handlers.keys()];
  }

  /**
   * Runs the handler registered for `name` and reports what it answered.
   *
   * `null` means "nothing is registered for this kind" — the handler was never
   * registered or was unregistered — and in that case no handler body runs. The
   * driver turns that into its own conservative `null` reading.
   */
  dispatch<TResult = unknown>(
    name: ClaudeResidentOutcomeName,
    context: ClaudeResidentOutcomeContext,
    appSessionId: string,
  ): ClaudeResidentOutcomeDispatch<TResult> | null {
    const handler = this.handlerFor<TResult>(name);
    if (!handler) {
      return null;
    }
    return { handler, value: handler.handle(context, appSessionId) };
  }
}
