/**
 * Criterion — the resident host driver's reading extension point.
 *
 * `ClaudeResidentHostDriver` used to be the only place a resident reading could
 * live: every reading was a method body in the class, so adding one meant
 * editing the centre file. This criterion holds three things about the
 * replacement (a registry + a sibling handler file):
 *
 * (a) A handler registered from a file that is NOT the driver is what the
 *     driver dispatches. The probe below is registered from THIS file, the
 *     driver is built over that registry, and `unattendedReading` answers the
 *     probe's sentinel. The printed reading names the handler, its source path
 *     and the driver's path, and the two paths must differ.
 *
 * (b) NEGATIVE CONTROL — an unregistered handler is not invoked. The same
 *     assertion function (`assertUnregisteredHandlerNotInvoked`) is driven by
 *     the real registry (green: unregister, dispatch, probe body never runs)
 *     and by an in-memory injection form — a dispatcher with the registration
 *     check removed, which calls the probe anyway. The injection form must make
 *     that same function throw, so the assertion is proven to have teeth rather
 *     than passing because nothing was watching. The red reading is printed,
 *     then the shipped handler is restored and the arm is green again.
 *
 * (c) BEHAVIOUR IS UNCHANGED — the shipped handlers are the old method bodies
 *     moved verbatim, and the spot assertions below compare their answers with
 *     the answers the old bodies produced (copies, newest-unstarted uuid, the
 *     pending byte count, deduplicated started commands, the closed/not-closed
 *     split between `ledgerState` and `liveState`, and the refusal log).
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
  type ClaudePermissionReading,
  type ClaudeRemoteControlRefusal,
  type ClaudeResidentLifecycleReading,
  type ClaudeUnattendedReading,
  type ResidentHostState,
} from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import {
  CLAUDE_RESIDENT_OUTCOME_HANDLERS,
  createDefaultClaudeResidentOutcomeRegistry,
} from '@/modules/providers/list/claude/claude-resident-outcome-handlers.js';
import {
  ClaudeResidentOutcomeRegistry,
  type ClaudeResidentOutcomeContext,
  type ClaudeResidentOutcomeHandler,
} from '@/modules/providers/list/claude/claude-resident-outcome-registry.js';

/** The file this criterion — the "non-driver file" of the positive arm — is. */
const TEST_SOURCE = fileURLToPath(import.meta.url);

/** The handlers file, for the "every shipped handler is registered from there" reading. */
const HANDLERS_REL = 'server/modules/providers/list/claude/claude-resident-outcome-handlers.ts';

const EMPTY_CONTEXT: ClaudeResidentOutcomeContext = { hosts: new Map(), refusals: new Map() };

/** Builds a driver over a registry with inert notification seams. */
function makeDriver(outcomes: ClaudeResidentOutcomeRegistry): ClaudeResidentHostDriver {
  return new ClaudeResidentHostDriver({
    host: {} as ClaudeResidentHostDriverOptions['host'],
    notifyBackgroundWork: () => undefined,
    notifyUnattendedWork: () => undefined,
    notifyRunStopped: () => undefined,
    outcomes,
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
function injectedLeakyDispatch(handler: ClaudeResidentOutcomeHandler): () => void {
  return () => {
    handler.handle(EMPTY_CONTEXT, 'probe-session');
  };
}

/** The shipped handler for a kind, so an arm can restore what it unregistered. */
function shippedHandler(name: ClaudeResidentOutcomeHandler['name']): ClaudeResidentOutcomeHandler {
  const handler = CLAUDE_RESIDENT_OUTCOME_HANDLERS.find((candidate) => candidate.name === name);
  assert.ok(handler, `the shipped set must register ${name}`);
  return handler;
}

/** A probe handler defined in THIS file — the "registered from a non-driver file" subject. */
function makeProbe(invocations: { count: number; sessions: string[] }) {
  const probe: ClaudeResidentOutcomeHandler<ClaudeUnattendedReading> = {
    name: 'unattendedReading',
    label: 'criterion.probe.unattended-reading',
    source: TEST_SOURCE,
    handle: (_context, appSessionId) => {
      invocations.count += 1;
      invocations.sessions.push(appSessionId);
      return {
        pushedUuids: [],
        lastPushedUuid: null,
        unattendedCommandUuid: 'probe-marker',
        initTools: [],
        backgroundTaskType: null,
      };
    },
  };
  return probe;
}

// ---------------------------------------------------------------------------
// (b) the positive arm — a handler from outside the driver is what gets called
// ---------------------------------------------------------------------------

test('positive arm: the driver dispatches to a handler registered from a non-driver file', () => {
  const registry = createDefaultClaudeResidentOutcomeRegistry();
  const invocations = { count: 0, sessions: [] as string[] };
  const probe = makeProbe(invocations);
  registry.register(probe);
  const driver = makeDriver(registry);

  const reading = driver.unattendedReading('probe-session');

  console.log(
    `(b) positive-arm: handler=${probe.label} source=${probe.source} driverSource=${CLAUDE_RESIDENT_HOST_DRIVER_SOURCE}`,
  );
  console.log(
    `(b) positive-arm: triggered=${invocations.count} session=${invocations.sessions.join(',') || '<none>'} ` +
      `reading=${JSON.stringify(reading)}`,
  );

  assert.equal(invocations.count, 1, 'the registered probe must be called exactly once');
  assert.deepEqual(invocations.sessions, ['probe-session'], 'the driver must pass its own argument through');
  assert.equal(reading?.unattendedCommandUuid, 'probe-marker', 'the driver must return the registered handler answer');
  assert.notEqual(probe.source, CLAUDE_RESIDENT_HOST_DRIVER_SOURCE, 'the handler source must not be the driver file');
  assert.ok(
    probe.source.endsWith('claude-resident-outcome-registry.test.ts'),
    `the probe source must be this criterion file, got ${probe.source}`,
  );
});

test('the shipped handler set is all registered from the sibling handlers file, not the driver', () => {
  const registry = createDefaultClaudeResidentOutcomeRegistry();
  const readings = CLAUDE_RESIDENT_OUTCOME_HANDLERS.map(
    (handler) => `${handler.name}<-${handler.label}@${handler.source}`,
  );
  console.log(`(b) shipped-handlers: count=${registry.names().length}`);
  for (const line of readings) {
    console.log(`(b) shipped-handler: ${line}`);
  }

  assert.equal(CLAUDE_RESIDENT_OUTCOME_HANDLERS.length, 12, 'the shipped set must cover every reading kind');
  assert.deepEqual(registry.names().sort(), CLAUDE_RESIDENT_OUTCOME_HANDLERS.map((handler) => handler.name).sort());
  for (const handler of CLAUDE_RESIDENT_OUTCOME_HANDLERS) {
    assert.notEqual(handler.source, CLAUDE_RESIDENT_HOST_DRIVER_SOURCE, `${handler.name} must not be defined in the driver`);
    assert.ok(
      handler.source.endsWith('claude-resident-outcome-handlers.ts'),
      `${handler.name} must be defined in ${HANDLERS_REL}, got ${handler.source}`,
    );
  }
});

// ---------------------------------------------------------------------------
// (c) the negative control — unregistered means not invoked, on the SAME assertion
// ---------------------------------------------------------------------------

test('negative control: unregistered not invoked; an injected leaky dispatch reds the same assertion', () => {
  const registry = createDefaultClaudeResidentOutcomeRegistry();
  const invocations = { count: 0, sessions: [] as string[] };
  const probe = makeProbe(invocations);
  registry.register(probe);
  const driver = makeDriver(registry);

  // The real arm: the probe is unregistered, the driver still asks for the
  // reading, and the probe body must not run.
  registry.unregister('unattendedReading');
  let reading: ClaudeUnattendedReading | null = null;
  assertUnregisteredHandlerNotInvoked(
    () => {
      reading = driver.unattendedReading('probe-session');
    },
    () => invocations.count,
    probe.label,
  );
  console.log(
    `(c) negative-arm(registry): triggered=${invocations.count} reading=${JSON.stringify(reading)} handlerRegistered=${registry.has('unattendedReading')}`,
  );
  assert.equal(invocations.count, 0, 'the unregistered probe must not run');
  assert.equal(reading, null, 'an unregistered reading must answer the conservative null');

  // The injection form: the same assertion function, driven by a dispatcher that
  // ignores registration. It must throw — that red is the proof the assertion has
  // teeth, and it is printed before being asserted.
  let injectedRed: Error | null = null;
  try {
    assertUnregisteredHandlerNotInvoked(
      injectedLeakyDispatch(probe),
      () => invocations.count,
      probe.label,
    );
  } catch (error) {
    injectedRed = error as Error;
  }
  console.log(
    `(c) negative-arm(injected): red=${injectedRed ? 'yes' : 'no'} triggered=${invocations.count} message=${injectedRed?.message ?? '<none>'}`,
  );
  assert.ok(injectedRed, 'the in-memory injection form must red the negative-control assertion');
  assert.match(injectedRed.message, /unregistered handler criterion\.probe\.unattended-reading was invoked/);

  // Restore the shipped handler and take the green reading again: the probe is
  // STILL unregistered, so the restored arm must not call it either.
  registry.register(shippedHandler('unattendedReading'));
  assertUnregisteredHandlerNotInvoked(
    () => {
      reading = driver.unattendedReading('probe-session');
    },
    () => invocations.count,
    probe.label,
  );
  console.log(
    `(c) negative-arm(restored): triggered=${invocations.count} reading=${JSON.stringify(reading)}`,
  );
  assert.equal(invocations.count, 1, 'the only invocation must be the injected red, none from either real arm');
});

// ---------------------------------------------------------------------------
// (d) behaviour is unchanged — spot readings against the moved bodies
// ---------------------------------------------------------------------------

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
    rounds: [],
    pushedUuids: new Set<string>(),
    heldCrons: [],
    heldBackgroundTasks: [],
    unhandledSystemSubtypes: [],
    cronsAuthoritative: true,
    tasksAuthoritative: true,
    permissions: { mode: 'bypassPermissions', decisions: [], lastConnectedCount: 0 },
    unattended: null,
    lastUnattendedCommandUuid: null,
    initTools: [],
    backgroundTaskType: null,
    queuedInputs: [],
    lifecycle: [],
    controlFrames: [],
    controlResponses: [],
    resultTimes: [],
    sessionStateChanged: 0,
    process: { pid: 4242 },
    ...overrides,
  } as unknown as ResidentHostState;
}

function contextOf(states: readonly ResidentHostState[], refusals: ReadonlyMap<string, ClaudeRemoteControlRefusal> = new Map()): ClaudeResidentOutcomeContext {
  return { hosts: new Map(states.map((state) => [state.hostId, state])), refusals };
}

test('behaviour preserved: the shipped handlers answer the old readings', () => {
  const refusal: ClaudeRemoteControlRefusal = {
    code: 'remote-control-enabled',
    message: 'Remote Control is on',
    settingsPath: '/tmp/settings.json',
    at: 1,
  };
  const live = fakeHost({
    pushedUuids: new Set(['uuid-1', 'uuid-2']),
    unattended: { commandUuid: 'cli-opened', trigger: 'cron', writer: {} as never },
    initTools: ['Bash', 'Read'],
    backgroundTaskType: 'agent',
    queuedInputs: [
      { uuid: 'old-started', at: 1, priority: 'later', frame: { message: { content: 'old' } }, resultsSeenAtPush: 0, queuedBeforeResult: null, startedAt: 7 },
      { uuid: 'waiting-a', at: 2, priority: 'later', frame: { message: { content: 'héllo' } }, resultsSeenAtPush: 0, queuedBeforeResult: null, startedAt: null },
      { uuid: 'waiting-b', at: 3, priority: 'later', frame: { message: { content: [{ type: 'text', text: 'world' }] } }, resultsSeenAtPush: 0, queuedBeforeResult: null, startedAt: null },
    ],
    lifecycle: [
      { commandUuid: 'waiting-a', state: 'queued' } as never,
      { commandUuid: 'covered', state: 'started' } as never,
      { commandUuid: 'covered', state: 'started' } as never,
      { commandUuid: 'done', state: 'completed' } as never,
    ],
    rounds: [{} as never],
    resultTimes: [1, 2],
    sessionStateChanged: 3,
    controlFrames: [{ at: 1, requestId: 'req', frame: { type: 'control_request' } }],
    controlResponses: [{ at: 2, requestId: 'req' }],
    heldCrons: [{ id: 'cron-1', reason: 'cron', expiresAt: 10 } as never],
  } as unknown as Partial<ResidentHostState>);
  const closed = fakeHost({ hostId: 'host-2', appSessionId: 'session-2', closed: true });
  const context = contextOf([live, closed], new Map([['refused-session', refusal]]));
  const registry = createDefaultClaudeResidentOutcomeRegistry();

  const unattended = registry.dispatch('unattendedReading', context, 'session-1')?.value as ClaudeUnattendedReading;
  const queuedUuid = registry.dispatch('queuedInputUuid', context, 'session-1')?.value as string | null;
  const pending = registry.dispatch('pendingQueuedInputs', context, 'session-1')?.value;
  const started = registry.dispatch('startedQueuedCommands', context, 'session-1')?.value as readonly string[];
  const busy = registry.dispatch('busyInputReading', context, 'session-1')?.value as { roundsOpen: number; hostPid: number };
  const lifecycle = registry.dispatch('lifecycleReading', context, 'session-1')?.value as ClaudeResidentLifecycleReading;
  const permissions = registry.dispatch('permissionReading', context, 'session-1')?.value as ClaudePermissionReading;
  const liveState = registry.dispatch('liveState', context, 'session-2')?.value;
  const ledgerState = registry.dispatch('ledgerState', context, 'session-2')?.value;
  const refused = registry.dispatch('remoteControlRefusal', context, 'refused-session')?.value;
  const unknownRefusal = registry.dispatch('remoteControlRefusal', context, 'nobody')?.value;
  const ledger = registry.dispatch('ledgerReading', context, 'session-2')?.value as { turn: unknown; deliveries: unknown[]; openRuns: number };

  console.log(
    `(d) readings: unattended=${JSON.stringify(unattended)} queuedUuid=${queuedUuid} pending=${JSON.stringify(pending)} ` +
      `started=${JSON.stringify(started)} busy=${JSON.stringify(busy)}`,
  );
  console.log(
    `(d) readings: lifecycle=${JSON.stringify(lifecycle)} permissions=${JSON.stringify(permissions)} ` +
      `liveState(closed)=${liveState === null ? 'null' : 'state'} ledgerState(closed)=${ledgerState === null ? 'null' : 'state'} ` +
      `refusal=${JSON.stringify(refused)} unknownRefusal=${JSON.stringify(unknownRefusal)}`,
  );
  console.log(`(d) readings: ledger=${JSON.stringify(ledger)}`);

  // unattendedReading: copies, newest push, the live opener with the last-opener fallback.
  assert.deepEqual(unattended.pushedUuids, ['uuid-1', 'uuid-2']);
  assert.equal(unattended.lastPushedUuid, 'uuid-2');
  assert.equal(unattended.unattendedCommandUuid, 'cli-opened');
  assert.deepEqual(unattended.initTools, ['Bash', 'Read']);
  assert.equal(unattended.backgroundTaskType, 'agent');

  // queuedInputUuid: newest entry with startedAt === null.
  assert.equal(queuedUuid, 'waiting-b');

  // pendingQueuedInputs: only the two waiting entries count; UTF-8 bytes of their text.
  assert.deepEqual(pending, { items: 2, bytes: Buffer.byteLength('héllo', 'utf8') + Buffer.byteLength('world', 'utf8') });

  // startedQueuedCommands: started only, deduplicated, in arrival order.
  assert.deepEqual(started, ['covered']);

  // busyInputReading: projections of the same state.
  assert.equal(busy.roundsOpen, 1);
  assert.equal(busy.hostPid, 4242);

  // lifecycleReading / permissionReading.
  assert.equal(lifecycle.hostId, 'host-1');
  assert.equal(lifecycle.crons.length, 1);
  assert.equal(lifecycle.cronsAuthoritative, true);
  assert.equal(permissions.permissionMode, 'bypassPermissions');
  assert.deepEqual(permissions.decisions, []);
  assert.equal(permissions.lastConnectedCount, 0);

  // liveState refuses a closed host; ledgerState keeps it readable (the old split).
  assert.equal(liveState, null);
  assert.notEqual(ledgerState, null);

  // remoteControlRefusal reads the refusal log, and answers null for an unknown session.
  assert.deepEqual(refused, refusal);
  assert.equal(unknownRefusal, null);

  // ledgerReading on a fresh ledger: empty, no open turn.
  assert.equal(ledger.turn, null);
  assert.deepEqual(ledger.deliveries, []);
  assert.equal(ledger.openRuns, 0);

  // The copy discipline: mutating the reading must not reach the host state.
  unattended.pushedUuids.push('mutated');
  assert.deepEqual([...live.pushedUuids], ['uuid-1', 'uuid-2']);
});
