/**
 * Criterion — the resident host driver's lifecycle-outcome extension point.
 *
 * The first extension point (`claude-resident-outcome-registry.test.ts`) holds
 * the driver's *readings* to a registry. This criterion holds its complement:
 * the run/turn endings, reconcile reaction, held-work reconciler, `[ledger]`
 * writers and title mirror used to be method bodies in
 * `claude-host-driver.provider.ts`, so adding one meant editing the centre file.
 * This criterion holds three things about the replacement (a registry + a
 * sibling handler file):
 *
 * (a) A handler registered from a file that is NOT the driver is what the
 *     driver dispatches on a run/turn outcome. The probe below is registered
 *     from THIS file, the driver is built over that registry, and the driver's
 *     `finishUnattendedTurn` delegation answers the probe. The printed reading
 *     names the handler, its source path and the driver's path, and the two
 *     paths must differ.
 *
 * (b) NEGATIVE CONTROL — an unregistered handler is not invoked. The same
 *     assertion function (`assertUnregisteredHandlerNotInvoked`) is driven by
 *     the real registry (green: unregister, delegate, probe body never runs)
 *     and by an in-memory injection form — a dispatcher with the registration
 *     check removed, which calls the probe anyway. The injection form must make
 *     that same function throw, so the assertion is proven to have teeth rather
 *     than passing because nothing was watching. The red reading is printed,
 *     then the shipped handler is restored and the arm is green again.
 *
 * (c) BEHAVIOUR IS UNCHANGED — the shipped handlers are the old method bodies
 *     moved verbatim, and the spot assertions below compare their effects with
 *     the effects the old bodies produced (a round dropped, leases converged,
 *     held work observed/inferred, identity deduped, the `[ledger]` line
 *     forwarded, a phantom run named, the unattended terminal + report).
 *
 * Every reading is printed before it is asserted, so a red lands on the reading
 * that is wrong.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createResidentLedger } from '@/modules/resident-ledger/index.js';
import {
  CLAUDE_RESIDENT_HOST_DRIVER_SOURCE,
  ClaudeResidentHostDriver,
  type ClaudeResidentHostDriverOptions,
  type ClaudeResidentReconcileReading,
  type ResidentHostState,
} from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import {
  CLAUDE_RESIDENT_LIFECYCLE_OUTCOME_HANDLERS,
  createDefaultClaudeResidentLifecycleOutcomeRegistry,
} from '@/modules/providers/list/claude/claude-resident-lifecycle-outcome-handlers.js';
import {
  ClaudeResidentLifecycleOutcomeRegistry,
  type ClaudeResidentLifecycleCronLease,
  type ClaudeResidentLifecycleOutcomeContext,
  type ClaudeResidentLifecycleOutcomeHandler,
  type ClaudeResidentLifecycleRound,
} from '@/modules/providers/list/claude/claude-resident-lifecycle-outcome-registry.js';
import type { AnyRecord, ProviderRuntimeWriter } from '@/shared/types.js';

/** The file this criterion — the "non-driver file" of the positive arm — is. */
const TEST_SOURCE = fileURLToPath(import.meta.url);

/** The handlers file, for the "every shipped handler is registered from there" reading. */
const HANDLERS_REL = 'server/modules/providers/list/claude/claude-resident-lifecycle-outcome-handlers.ts';

const CRON_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The seams a shipped handler is allowed to reach, all inert by default. */
function makeContext(overrides: Partial<ClaudeResidentLifecycleOutcomeContext> = {}): ClaudeResidentLifecycleOutcomeContext {
  return {
    provider: 'claude',
    now: () => 1_000,
    logSink: () => undefined,
    notifyUnattendedWork: () => undefined,
    reconcileMode: 'log',
    quiesceMs: 1_000,
    runRegistry: { runningRuns: () => [], closeRun: () => undefined },
    cronMaxAgeMs: CRON_MAX_AGE_MS,
    reconciledReason: 'reconciled',
    readCliSessionRegistration: () => null,
    identityBudgetMs: 1,
    identityPollMs: 1,
    titleMirrorWindowMs: 1,
    titleMirrorPollMs: 1,
    ...overrides,
  };
}

/** Builds a driver over a lifecycle registry with inert notification seams. */
function makeDriver(lifecycleOutcomes: ClaudeResidentLifecycleOutcomeRegistry): ClaudeResidentHostDriver {
  return new ClaudeResidentHostDriver({
    host: {} as ClaudeResidentHostDriverOptions['host'],
    notifyBackgroundWork: () => undefined,
    notifyUnattendedWork: () => undefined,
    notifyRunStopped: () => undefined,
    lifecycleOutcomes,
  });
}

/**
 * THE NEGATIVE-CONTROL ASSERTION, used by both arms.
 *
 * Runs `dispatch` and asserts the handler body was not invoked. `invocations`
 * is read around the call rather than trusted from the handler's own closure so
 * this function is the one place the "not triggered" rule lives — the real arm
 * and the injected arm both go through it, which is what makes the injected red
 * evidence that this function can fail.
 */
function assertUnregisteredHandlerNotInvoked(
  dispatch: () => void,
  invocations: () => number,
  label: string,
): void {
  const before = invocations();
  dispatch();
  const after = invocations();
  assert.equal(after, before, `unregistered handler ${label} was invoked (${before} -> ${after})`);
}

/**
 * THE IN-MEMORY INJECTION FORM.
 *
 * A dispatcher of the same call shape with the registration check removed: it
 * calls the handler it was handed whether or not it is registered. It is not the
 * registry — it is the mutant the negative-control assertion exists to catch.
 */
function injectedLeakyDispatch(
  handler: ClaudeResidentLifecycleOutcomeHandler,
  state: ResidentHostState,
): () => void {
  return () => {
    handler.handle(makeContext(), state, { sessionId: 'probe-session', result: {} });
  };
}

/** The shipped handler for a kind, so an arm can restore what it unregistered. */
function shippedHandler(name: ClaudeResidentLifecycleOutcomeHandler['name']): ClaudeResidentLifecycleOutcomeHandler {
  const handler = CLAUDE_RESIDENT_LIFECYCLE_OUTCOME_HANDLERS.find((candidate) => candidate.name === name);
  assert.ok(handler, `the shipped set must register ${name}`);
  return handler;
}

// ---------------------------------------------------------------------------
// Fixtures — one host state, one writer, and the private driver entry
// ---------------------------------------------------------------------------

type SinkCalls = {
  leasesAdded: Array<{ sessionId: string; lease: unknown }>;
  leasesRemoved: Array<{ sessionId: string; kind: string }>;
  identities: Array<{ sessionId: string; value: string | null }>;
};

function makeSink(): SinkCalls & {
  leaseAdded(sessionId: string, lease: unknown): void;
  leaseRemoved(sessionId: string, kind: string): void;
  identity(sessionId: string, value: string | null): void;
} {
  const calls: SinkCalls = { leasesAdded: [], leasesRemoved: [], identities: [] };
  return {
    ...calls,
    leaseAdded(sessionId, lease) {
      this.leasesAdded.push({ sessionId, lease });
    },
    leaseRemoved(sessionId, kind) {
      this.leasesRemoved.push({ sessionId, kind });
    },
    identity(sessionId, value) {
      this.identities.push({ sessionId, value });
    },
  };
}

function makeWriter(): { writer: ProviderRuntimeWriter; sent: AnyRecord[] } {
  const sent: AnyRecord[] = [];
  return {
    sent,
    writer: {
      send: (frame: AnyRecord) => {
        sent.push(frame);
      },
    } as unknown as ProviderRuntimeWriter,
  };
}

/**
 * One synthetic host state, populated only with the fields the spot readings
 * read. A cast because `ResidentHostState` is the driver's own record and this
 * criterion is not allowed to build a process; every field below that is read
 * is set, and a missing one would surface as a TypeScript error on the cast's
 * object literal rather than silently.
 */
function fakeHost(overrides: Partial<ResidentHostState> = {}): ResidentHostState {
  return {
    hostId: 'host-1',
    appSessionId: 'session-1',
    closed: false,
    turnLedger: createResidentLedger(),
    runtimes: new Map(),
    rounds: [],
    heldCrons: [],
    heldBackgroundTasks: [],
    cronsAuthoritative: false,
    tasksAuthoritative: false,
    unhandledSystemSubtypes: [],
    lastUserId: null,
    lastSessionName: null,
    sink: makeSink() as unknown as ResidentHostState['sink'],
    process: { pid: 4242 },
    providerSessionId: null,
    pid: null,
    configDir: '/tmp/criterion',
    projectPath: null,
    titleMirror: { lastSeen: null, mirrored: null, timer: null, open: false, openedForTurn: false },
    identityReadbackStarted: false,
    reportedIdentity: null,
    launchedTitle: null,
    unattended: null,
    lastUnattendedCommandUuid: null,
    queuedInputs: [],
    lifecycle: [],
    controlFrames: [],
    controlResponses: [],
    resultTimes: [],
    sessionStateChanged: 0,
    loggedDeliveryStates: new Map(),
    loggedOpenTurnId: null,
    reportedPhantomRuns: new Set(),
    ledgerChangedAt: 0,
    ...overrides,
  } as unknown as ResidentHostState;
}

/**
 * The driver's own `finishUnattendedTurn` entry — a run/turn ending and the
 * subject of the positive/negative arms.
 *
 * It is private, and this cast is deliberate: the criterion is proving that the
 * *driver's* method delegates to a handler registered from outside it. Driving
 * `registry.dispatch` directly would prove the registry works; only the driver
 * entry proves the driver goes through it. The private shape is asserted above
 * by the TypeScript compiler (the cast names the method and its arguments).
 */
function delegateFinishUnattendedTurn(
  driver: ClaudeResidentHostDriver,
  state: ResidentHostState,
  sessionId: string | null = 'cli-session',
): void {
  const entry = driver as unknown as {
    finishUnattendedTurn(state: ResidentHostState, sessionId: string | null, result: AnyRecord): void;
  };
  entry.finishUnattendedTurn(state, sessionId, {});
}

/** A probe handler defined in THIS file — the "registered from a non-driver file" subject. */
function makeProbe(invocations: { count: number; states: ResidentHostState[] }) {
  const probe: ClaudeResidentLifecycleOutcomeHandler = {
    name: 'finishUnattendedTurn',
    label: 'criterion.probe.finish-unattended-turn',
    source: TEST_SOURCE,
    handle: (_context, state) => {
      invocations.count += 1;
      invocations.states.push(state);
    },
  };
  return probe;
}

// ---------------------------------------------------------------------------
// (b) the positive arm — a handler from outside the driver is what gets called
// ---------------------------------------------------------------------------

test('positive arm: the driver dispatches a run/turn ending to a handler registered from a non-driver file', () => {
  const registry = createDefaultClaudeResidentLifecycleOutcomeRegistry();
  const invocations = { count: 0, states: [] as ResidentHostState[] };
  const probe = makeProbe(invocations);
  registry.register(probe);
  const driver = makeDriver(registry);

  const { writer } = makeWriter();
  const state = fakeHost({ unattended: { commandUuid: 'cli-opened', trigger: 'session-cron', writer } });

  delegateFinishUnattendedTurn(driver, state);

  console.log(
    `(b) positive-arm: handler=${probe.label} source=${probe.source} driverSource=${CLAUDE_RESIDENT_HOST_DRIVER_SOURCE}`,
  );
  console.log(
    `(b) positive-arm: outcome=finishUnattendedTurn triggered=${invocations.count} ` +
      `session=${invocations.states[0]?.appSessionId ?? '<none>'} unattendedStillOpen=${state.unattended !== null}`,
  );

  assert.equal(invocations.count, 1, 'the registered probe must be called exactly once');
  assert.equal(invocations.states[0], state, 'the driver must pass the host state it is reacting to');
  assert.notEqual(probe.source, CLAUDE_RESIDENT_HOST_DRIVER_SOURCE, 'the handler source must not be the driver file');
  assert.ok(
    probe.source.endsWith('claude-resident-lifecycle-outcome-registry.test.ts'),
    `the probe source must be this criterion file, got ${probe.source}`,
  );
});

test('the shipped handler set is all registered from the sibling handlers file, not the driver', () => {
  const registry = createDefaultClaudeResidentLifecycleOutcomeRegistry();
  const readings = CLAUDE_RESIDENT_LIFECYCLE_OUTCOME_HANDLERS.map(
    (handler) => `${handler.name}<-${handler.label}@${handler.source}`,
  );
  console.log(`(b) shipped-handlers: count=${registry.names().length}`);
  for (const line of readings) {
    console.log(`(b) shipped-handler: ${line}`);
  }

  assert.equal(
    CLAUDE_RESIDENT_LIFECYCLE_OUTCOME_HANDLERS.length,
    19,
    'the shipped set must cover every lifecycle outcome kind',
  );
  assert.deepEqual(
    registry.names().sort(),
    CLAUDE_RESIDENT_LIFECYCLE_OUTCOME_HANDLERS.map((handler) => handler.name).sort(),
  );
  for (const handler of CLAUDE_RESIDENT_LIFECYCLE_OUTCOME_HANDLERS) {
    assert.notEqual(handler.source, CLAUDE_RESIDENT_HOST_DRIVER_SOURCE, `${handler.name} must not be defined in the driver`);
    assert.ok(
      handler.source.endsWith('claude-resident-lifecycle-outcome-handlers.ts'),
      `${handler.name} must be defined in ${HANDLERS_REL}, got ${handler.source}`,
    );
  }
});

// ---------------------------------------------------------------------------
// (c) the negative control — unregistered means not invoked, on the SAME assertion
// ---------------------------------------------------------------------------

test('negative control: unregistered not invoked; an injected leaky dispatch reds the same assertion', () => {
  const registry = createDefaultClaudeResidentLifecycleOutcomeRegistry();
  const invocations = { count: 0, states: [] as ResidentHostState[] };
  const probe = makeProbe(invocations);
  registry.register(probe);
  const driver = makeDriver(registry);

  const { writer } = makeWriter();
  const state = fakeHost({ unattended: { commandUuid: 'cli-opened', trigger: 'session-cron', writer } });

  // The real arm: the probe is unregistered, the driver still runs the ending,
  // and the probe body must not run.
  registry.unregister('finishUnattendedTurn');
  assertUnregisteredHandlerNotInvoked(
    () => {
      delegateFinishUnattendedTurn(driver, state);
    },
    () => invocations.count,
    probe.label,
  );
  console.log(
    `(c) negative-arm(registry): triggered=${invocations.count} handlerRegistered=${registry.has('finishUnattendedTurn')} ` +
      `unattendedStillOpen=${state.unattended !== null}`,
  );
  assert.equal(invocations.count, 0, 'the unregistered probe must not run');
  assert.notEqual(state.unattended, null, 'an unregistered ending must leave the turn open rather than half-end it');

  // The injection form: the same assertion function, driven by a dispatcher that
  // ignores registration. It must throw — that red is the proof the assertion has
  // teeth, and it is printed before being asserted.
  let injectedRed: Error | null = null;
  try {
    assertUnregisteredHandlerNotInvoked(
      injectedLeakyDispatch(probe, state),
      () => invocations.count,
      probe.label,
    );
  } catch (error) {
    injectedRed = error as Error;
  }
  console.log(
    `(c) negative-arm(injected): red=${injectedRed ? 'yes' : 'no'} triggered=${invocations.count} ` +
      `message=${injectedRed?.message ?? '<none>'}`,
  );
  assert.ok(injectedRed, 'the in-memory injection form must red the negative-control assertion');
  assert.match(injectedRed.message, /unregistered handler criterion\.probe\.finish-unattended-turn was invoked/);

  // Restore the shipped handler and take the green reading again: the probe is
  // STILL unregistered, so the restored arm must not call it either.
  registry.register(shippedHandler('finishUnattendedTurn'));
  assertUnregisteredHandlerNotInvoked(
    () => {
      delegateFinishUnattendedTurn(driver, fakeHost({ unattended: { commandUuid: 'cli-opened', trigger: 'session-cron', writer } }));
    },
    () => invocations.count,
    probe.label,
  );
  console.log(
    `(c) negative-arm(restored): triggered=${invocations.count} handlerRegistered=${registry.has('finishUnattendedTurn')}`,
  );
  assert.equal(invocations.count, 1, 'the only invocation must be the injected red, none from either real arm');
});

// ---------------------------------------------------------------------------
// (d) behaviour is unchanged — spot readings against the moved bodies
// ---------------------------------------------------------------------------

test('behaviour preserved: the shipped handlers answer the old outcomes', () => {
  const registry = createDefaultClaudeResidentLifecycleOutcomeRegistry();
  const sink = makeSink();
  const state = fakeHost({
    sink: sink as unknown as ResidentHostState['sink'],
    reportedIdentity: 'previous-name',
  });

  // dropRound: the named round leaves the FIFO, its sibling stays.
  const roundA = { appSessionId: 'session-1' } as unknown as ClaudeResidentLifecycleRound;
  const roundB = { appSessionId: 'session-1' } as unknown as ClaudeResidentLifecycleRound;
  state.rounds = [roundA, roundB];
  registry.dispatch('dropRound', makeContext(), state, { round: roundA });
  console.log(`(d) dropRound: remaining=${state.rounds.length} keptSecond=${state.rounds[0] === roundB}`);

  // settleCrons: remove-then-add on a change, and an unchanged list is silent.
  const cron: ClaudeResidentLifecycleCronLease = { kind: 'cron', id: 'cron-1', recurring: true, expiresAt: 5 };
  registry.dispatch('settleCrons', makeContext(), state, { desired: [cron] });
  const afterFirst = { added: sink.leasesAdded.length, removed: sink.leasesRemoved.length };
  registry.dispatch('settleCrons', makeContext(), state, { desired: [cron] });
  const afterRepeat = { added: sink.leasesAdded.length, removed: sink.leasesRemoved.length };
  console.log(
    `(d) settleCrons: first=${JSON.stringify(afterFirst)} afterRepeat=${JSON.stringify(afterRepeat)}`,
  );

  // observeHeldWorkEvent: task_started adds a background-task lease.
  registry.dispatch('observeHeldWorkEvent', makeContext(), state, {
    message: { subtype: 'task_started', task_id: 'task-1' },
  });
  console.log(`(d) observeHeldWorkEvent: held=${JSON.stringify(state.heldBackgroundTasks)}`);

  // inferHeldWork: a CronCreate tool_use becomes an inferred lease dated from now + window.
  registry.dispatch('inferHeldWork', makeContext({ now: () => 2_000 }), state, {
    message: { message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'CronCreate', input: {} }] } },
  });
  const inferred = state.heldCrons.find((lease) => lease.id === 'tool-1');
  console.log(
    `(d) inferHeldWork: inferred=${JSON.stringify(inferred)} expectedExpiresAt=${2_000 + CRON_MAX_AGE_MS}`,
  );

  // publishIdentity: a move is published once; the same value again is not news.
  registry.dispatch('publishIdentity', makeContext(), state, { value: 'new-name' });
  registry.dispatch('publishIdentity', makeContext(), state, { value: 'new-name' });
  console.log(`(d) publishIdentity: identities=${JSON.stringify(sink.identities)}`);

  // writeLogLine: the sink is the channel.
  const logged: string[] = [];
  registry.dispatch('writeLogLine', makeContext({ logSink: (line) => logged.push(line) }), state, {
    line: '[ledger] session=session-1 delivery=abc',
  });
  console.log(`(d) writeLogLine: logged=${JSON.stringify(logged)}`);

  // reconcileTick: a run the registry still holds with a quiet ledger is phantom.
  const reconcileState = fakeHost({
    ledgerChangedAt: 0,
    turnLedger: createResidentLedger(),
  });
  const reading = registry.dispatch<ClaudeResidentReconcileReading>('reconcileTick', makeContext({
    now: () => 5_000,
    quiesceMs: 1_000,
    runRegistry: { runningRuns: () => [{ sessionId: 'session-1', runId: 'run-1' }], closeRun: () => undefined },
  }), reconcileState, { appSessionId: 'session-1' })?.value;
  console.log(`(d) reconcileTick: reading=${JSON.stringify(reading)}`);

  // stopTitleMirror: the open latch is cancelled.
  const mirrorState = fakeHost({
    titleMirror: { lastSeen: null, mirrored: null, timer: null, open: true, openedForTurn: true },
  });
  registry.dispatch('stopTitleMirror', makeContext(), mirrorState, undefined);
  console.log(`(d) stopTitleMirror: open=${mirrorState.titleMirror.open}`);

  // finishUnattendedTurn: terminal first, then the report naming the stated origin.
  const { writer, sent } = makeWriter();
  const reports: Array<{ trigger: string; appSessionId: string }> = [];
  const unattendedState = fakeHost({
    lastUserId: 'user-1',
    lastSessionName: 'Session One',
    unattended: { commandUuid: 'cli-opened', trigger: 'session-cron', writer },
  });
  registry.dispatch(
    'finishUnattendedTurn',
    makeContext({
      notifyUnattendedWork: (event) => reports.push({ trigger: event.trigger, appSessionId: event.appSessionId }),
    }),
    unattendedState,
    { sessionId: 'cli-session', result: { origin: { kind: 'peer' } } },
  );
  console.log(
    `(d) finishUnattendedTurn: sent=${JSON.stringify(sent)} reports=${JSON.stringify(reports)} ` +
      `unattended=${unattendedState.unattended === null ? 'null' : 'open'}`,
  );

  // abandonUnattendedTurn: a terminal with the stated exit code, no report.
  const abandoned = makeWriter();
  const abandonedState = fakeHost({
    providerSessionId: 'cli-session',
    unattended: { commandUuid: 'cli-opened', trigger: 'session-cron', writer: abandoned.writer },
  });
  registry.dispatch('abandonUnattendedTurn', makeContext(), abandonedState, { exitCode: 1 });
  console.log(`(d) abandonUnattendedTurn: sent=${JSON.stringify(abandoned.sent)}`);

  // ---- assertions ----
  assert.deepEqual(state.rounds, [roundB], 'dropRound must remove exactly the named round');
  assert.deepEqual(afterFirst, { added: 1, removed: 1 }, 'the first settle must remove then add');
  assert.deepEqual(afterRepeat, afterFirst, 'an unchanged list must not be reported again');
  assert.deepEqual(state.heldBackgroundTasks, [{ kind: 'background-task', id: 'task-1' }]);
  assert.ok(inferred, 'inferHeldWork must add the inferred lease');
  assert.equal(inferred.expiresAt, 2_000 + CRON_MAX_AGE_MS, 'the inferred lease is dated now + the CLI window');
  assert.equal(inferred.inferred, true);
  assert.deepEqual(sink.identities, [{ sessionId: 'session-1', value: 'new-name' }], 'identity dedup must publish once');
  assert.deepEqual(logged, ['[ledger] session=session-1 delivery=abc']);
  assert.equal(reading?.anomaly, 'phantom-run');
  assert.equal(reading?.quiescentMs, 5_000);
  assert.equal(reading?.turnOpen, false);
  assert.deepEqual(reading?.closedRuns, [], 'the log arm names the anomaly and closes nothing');
  assert.equal(mirrorState.titleMirror.open, false);
  assert.equal(sent.length, 1, 'the unattended turn must send exactly its terminal');
  assert.deepEqual(reports, [{ trigger: 'cross-session-message', appSessionId: 'session-1' }]);
  assert.equal(unattendedState.unattended, null, 'the ending clears the open unattended record');
  assert.equal(abandoned.sent.length, 1);
  assert.equal(abandonedState.unattended, null);
});
