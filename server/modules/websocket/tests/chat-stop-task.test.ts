/**
 * AC-196 criterion — `chat.stop-task`, the first control verb of the activity
 * dock.
 *
 * The claim is one sentence: the server validates a stop request itself
 * (session exists + ownership + the task is in the task table and not already
 * finished), places the request on the provider's own process, and takes "the
 * task really stopped" from the task table's own event — never from the driver
 * call, which answers an unknown id silently and even a known one without
 * stating the task's state.
 *
 * What is proven, and on which of the two axes it is read:
 *
 *  Protocol (the real `chat.stop-task` handler, a stub runtime, and AC-191's
 *  real reducer as the task table):
 *   (AC2) each of `sessionId` / `taskId` / `requestId` is required, and a
 *         missing one is a protocol error that places no stop;
 *   (AC3) an unknown session is refused, and a request from an unauthenticated
 *         socket is `forbidden` — with the driver never reached;
 *   (AC4) a task the table does not hold, or one already terminal, is
 *         `unknown-task`, with no stop placed;
 *   (AC5) a valid request places the stop and answers `requested`, echoing the
 *         `requestId`, and the receipt itself leaves the table's state alone;
 *   (AC6) feeding `task_notification{status:'stopped'}` moves the table to
 *         `stopped` — the confirmation is the event's, not the receipt's;
 *   (AC7) a request whose task never stops answers `timeout`, the table
 *         unchanged from before the call.
 *
 *  Placement (the real runtime gateway, the real resident driver, and the real
 *  per-run runtime):
 *   (AC9) the resident capability is off by default, so a stop answers
 *         `unsupported` without reaching a driver; with it on (injected) the
 *         driver is reached;
 *   (AC10) the resident driver's `stopTask` reaches the live `query.stopTask`,
 *         and the per-run `stopClaudeSDKTask` reaches the live
 *         `instance.stopTask`;
 *   (AC8) a driver call that throws is `error`, and one that never settles is
 *         `timeout` inside the bound — so the handler cannot hang on it.
 *
 * Each named reading is driven a second time by a fake form (AC11): an
 * optimistic handler that writes `stopped` with the receipt, and one that skips
 * the ownership check. The fake form must red the same assertion the real arm
 * passes, which is what proves the assertion has discriminating power.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import {
  abortClaudeSDKSession,
  CLAUDE_PREDEFINED_MODELS,
  ClaudeResidentHostDriver,
  claudeQueryFactory,
  createClaudeTaskReducer,
  createProviderRuntimeService,
  getActiveClaudeSDKSessions,
  providerRuntimeService,
  queryClaudeSDK,
  stopClaudeSDKTask,
} from '@/modules/providers/index.js';
import type {
  ActivityTask,
  ClaudeResidentProcess,
  ClaudeResidentProcessFactory,
  ClaudeResidentQuery,
  ClaudeTaskReducer,
  ControlStopTaskOutcome,
} from '@/modules/providers/index.js';
import type { SessionHostManager } from '@/modules/session-hosts/index.js';
import { createSessionHostManager } from '@/modules/session-hosts/index.js';
// Imported from the service rather than the module barrel: `assertSessionAccess`
// is the sibling control verbs' shared entry and lives on the service, and the
// service is this module's own file, so no extra barrel surface is added for one
// criterion.
import {
  assertSessionAccess,
  handleChatConnection,
} from '@/modules/websocket/services/dispatch/chat-websocket.service.js';
import type {
  AnyRecord,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

const SESSION_ID = 'stop-task-session';
const PER_RUN_SESSION_ID = 'stop-task-per-run-session';

/** One line of this criterion's readings. The readings are the evidence. */
function say(line: string): void {
  console.log(`stop-task ${line}`);
}

// ------------------------------------------------------------- frame builders --
/*
 * The shapes come from the E9 capture (`docs/proposals/claude-resident-sessions-experiments.md`
 * §9.3–9.5) and from AC-191's own criterion, whose reducers consume exactly
 * these frames. They are the contract this criterion holds the reducer to.
 */
function taskStartedFrame(taskId: string, overrides: AnyRecord = {}): AnyRecord {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    tool_use_id: `toolu_${taskId}`,
    description: 'sleep 300; echo done',
    is_backgrounded: true,
    task_type: 'local_bash',
    uuid: randomUUID(),
    session_id: SESSION_ID,
    ...overrides,
  };
}

function taskUpdatedFrame(taskId: string, status: string): AnyRecord {
  return {
    type: 'system',
    subtype: 'task_updated',
    task_id: taskId,
    uuid: randomUUID(),
    session_id: SESSION_ID,
    status,
  };
}

function taskNotificationFrame(taskId: string, status = 'stopped'): AnyRecord {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    tool_use_id: `toolu_${taskId}`,
    status,
    summary: 'ended',
    uuid: randomUUID(),
    session_id: SESSION_ID,
  };
}

/** A frame that keeps a task running: it can never settle the confirmation wait. */
function taskProgressFrame(taskId: string): AnyRecord {
  return {
    type: 'system',
    subtype: 'task_progress',
    task_id: taskId,
    description: 'still working',
    uuid: randomUUID(),
    session_id: SESSION_ID,
  };
}

/** Reads one task's state straight out of the real reducer. */
function stateOf(reducer: ClaudeTaskReducer, sessionId: string, taskId: string): ActivityTask['state'] | null {
  return reducer.getTasks(sessionId).find((task) => task.taskId === taskId)?.state ?? null;
}

// ---------------------------------------------------------------- the socket --
type FakeSocket = EventEmitter & {
  readyState: number;
  frames: AnyRecord[];
  send(data: string): void;
};

function createFakeSocket(): FakeSocket {
  const socket = new EventEmitter() as FakeSocket;
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => {
    socket.frames.push(JSON.parse(data) as AnyRecord);
  };
  return socket;
}

/** Polls a predicate without failing the case, so a red lands on the reading. */
async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  console.log(`stop-task waitFor timed out: ${label}`);
  return false;
}

// ------------------------------------------------------- protocol harness ----
type StubRuntime = {
  calls: Array<{ provider: string; sessionId: string; taskId: string }>;
  setOutcome(outcome: ControlStopTaskOutcome): void;
  runtime: AnyRecord;
};

function createStubRuntime(): StubRuntime {
  let outcome: ControlStopTaskOutcome = 'requested';
  const calls: StubRuntime['calls'] = [];
  return {
    calls,
    setOutcome(next) {
      outcome = next;
    },
    runtime: {
      hasRuntime: () => true,
      run: async () => undefined,
      abort: async () => false,
      controlStopTask: async (provider: string, sessionId: string, taskId: string) => {
        calls.push({ provider, sessionId, taskId });
        return outcome;
      },
      resolveToolApproval: () => undefined,
      getPendingApprovalsForSession: () => [],
    },
  };
}

type ProtocolHarness = {
  reducer: ClaudeTaskReducer;
  runtime: StubRuntime;
  /** A socket with an authenticated user, sharing the harness deps. */
  connect(): FakeSocket;
  /** A socket with no authenticated user, for the ownership reading. */
  connectAnonymous(): FakeSocket;
};

async function withProtocolHarness(run: (harness: ProtocolHarness) => Promise<void>): Promise<void> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-stop-task-'));
  const previousDatabasePath = process.env.DATABASE_PATH;

  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
    await initializeDatabase();

    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', tempDirectory, 'Stop-task session', now, now, null);
    sessionsDb.createSession(PER_RUN_SESSION_ID, 'claude', tempDirectory, 'Per-run session', now, now, null);

    const reducer = createClaudeTaskReducer();
    const runtime = createStubRuntime();
    const dependencies: AnyRecord = {
      runtime: runtime.runtime,
      getTask: (sessionId: string, taskId: string): { state: ActivityTask['state'] } | null => {
        const task = reducer.getTasks(sessionId).find((candidate) => candidate.taskId === taskId);
        return task ? { state: task.state } : null;
      },
      // Short bounds: the never-stopped arm must reach `timeout` in milliseconds.
      stopTaskConfirmTimeoutMs: 150,
      stopTaskConfirmPollMs: 10,
    };

    const connect = (user: AnyRecord | null): FakeSocket => {
      const socket = createFakeSocket();
      handleChatConnection(
        socket as never,
        (user ? { user } : {}) as never,
        dependencies as never,
      );
      return socket;
    };

    await run({
      reducer,
      runtime,
      connect: () => connect({ id: 1 }),
      connectAnonymous: () => connect(null),
    });
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** Sends one `chat.stop-task` and answers with the receipt frame it produced, if any. */
async function requestStop(
  socket: FakeSocket,
  payload: AnyRecord,
): Promise<AnyRecord | null> {
  const before = socket.frames.length;
  socket.emit('message', JSON.stringify({ type: 'chat.stop-task', ...payload }));
  await waitFor(
    () => socket.frames.slice(before).some((frame) => frame.kind === 'control_result'),
    1_000,
    `a control_result for ${JSON.stringify(payload)}`,
  );
  return socket.frames.slice(before).find((frame) => frame.kind === 'control_result') ?? null;
}

/** The protocol error code one `chat.stop-task` produced, if any. */
function errorCode(socket: FakeSocket, from: number): string | null {
  const frame = socket.frames
    .slice(from)
    .find((candidate) => candidate.kind === 'protocol_error');
  return typeof frame?.code === 'string' ? frame.code : null;
}

// -------------------------------------------------------------- AC2–AC7 ------
test('chat.stop-task validates, places, and takes its confirmation from the task event', async () => {
  await withProtocolHarness(async ({ reducer, runtime, connect, connectAnonymous }) => {
    const socket = connect();

    // ---- AC2: each field is required, and a missing one places no stop. ----
    const missing: Array<[string, AnyRecord]> = [
      ['sessionId', { taskId: 't', requestId: 'r' }],
      ['taskId', { sessionId: SESSION_ID, requestId: 'r' }],
      ['requestId', { sessionId: SESSION_ID, taskId: 't' }],
    ];
    const codes: string[] = [];
    for (const [field, payload] of missing) {
      const from = socket.frames.length;
      socket.emit('message', JSON.stringify({ type: 'chat.stop-task', ...payload }));
      await waitFor(() => socket.frames.length > from, 500, `a refusal for a missing ${field}`);
      codes.push(errorCode(socket, from) ?? 'none');
    }
    say(`(AC2) missingFieldCodes=${JSON.stringify(codes)} driverCalls=${runtime.calls.length}`);
    assert.deepEqual(codes, ['SESSION_ID_REQUIRED', 'TASK_ID_REQUIRED', 'REQUEST_ID_REQUIRED']);
    assert.equal(runtime.calls.length, 0, 'a missing field must not reach the driver');

    // ---- AC3: an unknown session is refused, and an unauthenticated socket is
    // `forbidden` with the driver untouched. ----
    const unknownSessionFrom = socket.frames.length;
    socket.emit('message', JSON.stringify({
      type: 'chat.stop-task',
      sessionId: 'no-such-session',
      taskId: 't',
      requestId: 'r',
    }));
    await waitFor(() => socket.frames.length > unknownSessionFrom, 500, 'a refusal for an unknown session');
    const unknownSessionCode = errorCode(socket, unknownSessionFrom);

    // Seed a running task so the forbidden arm would otherwise have been a valid
    // stop — the refusal must be the ownership check, not the task check.
    reducer.observe(SESSION_ID, taskStartedFrame('b-forbidden'));
    const forbidden = await requestStop(connectAnonymous(), {
      sessionId: SESSION_ID,
      taskId: 'b-forbidden',
      requestId: 'req-forbidden',
    });
    const forbiddenReading = {
      result: typeof forbidden?.result === 'string' ? forbidden.result : 'no-receipt',
      driverCalls: runtime.calls.length,
    };
    say(`(AC3) unknownSessionCode=${unknownSessionCode} forbidden=${JSON.stringify(forbiddenReading)}`);
    assert.equal(unknownSessionCode, 'SESSION_NOT_FOUND');
    assertForbiddenPlacesNothing(forbiddenReading);
    assert.equal(stateOf(reducer, SESSION_ID, 'b-forbidden'), 'running', 'forbidden must not move the task');

    // ---- AC4: a task the table does not hold, and one already terminal. ----
    const absent = await requestStop(socket, {
      sessionId: SESSION_ID,
      taskId: 'never-started',
      requestId: 'req-absent',
    });
    // A terminal task: it is in the table, but no longer in flight.
    reducer.observe(SESSION_ID, taskStartedFrame('b-completed'));
    reducer.observe(SESSION_ID, taskUpdatedFrame('b-completed', 'completed'));
    const completed = await requestStop(socket, {
      sessionId: SESSION_ID,
      taskId: 'b-completed',
      requestId: 'req-completed',
    });
    const unknownTaskReadings = {
      absent: typeof absent?.result === 'string' ? absent.result : 'no-receipt',
      terminal: typeof completed?.result === 'string' ? completed.result : 'no-receipt',
      driverCalls: runtime.calls.length,
    };
    say(`(AC4) unknownTaskReadings=${JSON.stringify(unknownTaskReadings)}`);
    assert.equal(unknownTaskReadings.absent, 'unknown-task');
    assert.equal(unknownTaskReadings.terminal, 'unknown-task');
    assert.equal(runtime.calls.length, 0, 'an unknown/terminal task must not reach the driver');

    // ---- AC5 + AC6: a valid request places the stop, answers `requested`, and
    // the table only moves when the event arrives. ----
    reducer.observe(SESSION_ID, taskStartedFrame('b-live'));
    runtime.setOutcome('requested');
    const beforeValid = runtime.calls.length;
    const receiptPromise = requestStop(socket, {
      sessionId: SESSION_ID,
      taskId: 'b-live',
      requestId: 'req-live',
    });
    const placed = await waitFor(() => runtime.calls.length > beforeValid, 1_000, 'the stop to be placed');
    const stateBeforeEvent = stateOf(reducer, SESSION_ID, 'b-live');
    // The event, and nothing else, is what settles the task.
    reducer.observe(SESSION_ID, taskNotificationFrame('b-live'));
    const receipt = await receiptPromise;
    const stateAfterEvent = stateOf(reducer, SESSION_ID, 'b-live');
    const acceptance = {
      placed,
      driverCall: runtime.calls[runtime.calls.length - 1],
      result: typeof receipt?.result === 'string' ? receipt.result : 'no-receipt',
      requestId: typeof receipt?.requestId === 'string' ? receipt.requestId : null,
      stateBeforeEvent,
      stateAfterEvent,
    };
    say(`(AC5/6) acceptance=${JSON.stringify(acceptance)}`);
    assert.equal(acceptance.placed, true, 'a valid request must reach the driver');
    assert.deepEqual(acceptance.driverCall, { provider: 'claude', sessionId: SESSION_ID, taskId: 'b-live' });
    assert.equal(acceptance.result, 'requested');
    assert.equal(acceptance.requestId, 'req-live', 'the receipt must echo the requestId');
    assertStoppedIsEventDriven({ stateBeforeEvent, stateAfterEvent });

    // ---- AC7: a task that never stops answers `timeout`, table unchanged. ----
    reducer.observe(SESSION_ID, taskStartedFrame('b-never'));
    const beforeNever = stateOf(reducer, SESSION_ID, 'b-never');
    const timedOut = await requestStop(socket, {
      sessionId: SESSION_ID,
      taskId: 'b-never',
      requestId: 'req-never',
    });
    // Frame the task as still running after the request, to prove the wait was
    // real and not satisfied by a table that quietly settled.
    reducer.observe(SESSION_ID, taskProgressFrame('b-never'));
    const timeoutReading = {
      result: typeof timedOut?.result === 'string' ? timedOut.result : 'no-receipt',
      stateBefore: beforeNever,
      stateAfter: stateOf(reducer, SESSION_ID, 'b-never'),
    };
    say(`(AC7) timeoutReading=${JSON.stringify(timeoutReading)}`);
    assertTimedOutLeavesStateAlone(timeoutReading);

    // ---- AC9 (receipt half): an unsupported placement passes through as-is. ----
    reducer.observe(SESSION_ID, taskStartedFrame('b-unsupported'));
    runtime.setOutcome('unsupported');
    const unsupported = await requestStop(socket, {
      sessionId: SESSION_ID,
      taskId: 'b-unsupported',
      requestId: 'req-unsupported',
    });
    say(`(AC9) unsupportedReceipt=${String(unsupported?.result)}`);
    assert.equal(unsupported?.result, 'unsupported');

    // ---- AC8 (receipt halves): error and timeout pass through. ----
    reducer.observe(SESSION_ID, taskStartedFrame('b-error'));
    runtime.setOutcome('error');
    const error = await requestStop(socket, {
      sessionId: SESSION_ID,
      taskId: 'b-error',
      requestId: 'req-error',
    });
    reducer.observe(SESSION_ID, taskStartedFrame('b-timeout'));
    runtime.setOutcome('timeout');
    const gatewayTimeout = await requestStop(socket, {
      sessionId: SESSION_ID,
      taskId: 'b-timeout',
      requestId: 'req-timeout',
    });
    say(`(AC8) errorReceipt=${String(error?.result)} timeoutReceipt=${String(gatewayTimeout?.result)}`);
    assert.equal(error?.result, 'error');
    assert.equal(gatewayTimeout?.result, 'timeout');

    // ---- AC11: the fake forms red the same readings the real arms passed. ----
    // (a) An optimistic handler stamps `stopped` with its receipt: the task is
    // already settled before the event, so the event-driven reading must fail.
    assert.throws(
      () => assertStoppedIsEventDriven({ stateBeforeEvent: 'stopped', stateAfterEvent: 'stopped' }),
      /must still be running before the event/,
      'fake (optimistic) must red the event-driven reading',
    );
    // The same handler would also satisfy the confirmation wait without an
    // event, turning AC7's `timeout` into `requested`.
    assert.throws(
      () => assertTimedOutLeavesStateAlone({ result: 'requested', stateBefore: 'running', stateAfter: 'stopped' }),
      /must answer timeout/,
      'fake (optimistic) must red the timeout reading',
    );
    console.log('[readings] fake optimistic: red');
    // (b) A handler with no ownership check answers the stop instead of
    // refusing it, and reaches the driver. The forbidden reading must fail.
    assert.throws(
      () => assertForbiddenPlacesNothing({ result: 'requested', driverCalls: 1 }),
      /must answer forbidden/,
      'fake (no-ownership) must red the forbidden reading',
    );
    console.log('[readings] fake no-ownership: red');
  });
});

// ------------------------------------------------------ named readings ------
/*
 * Each is the assertion its AC is graded on, written once so the fake form can
 * drive the SAME function the real arm drove — a fake form that passed would be
 * a hole in the reading, not a valid mutant.
 */
function assertForbiddenPlacesNothing(reading: { result: string; driverCalls: number }): void {
  assert.equal(reading.result, 'forbidden', `an unauthorized request must answer forbidden (got ${reading.result})`);
  assert.equal(reading.driverCalls, 0, 'a forbidden request must place no stop');
}

function assertStoppedIsEventDriven(reading: { stateBeforeEvent: string | null; stateAfterEvent: string | null }): void {
  assert.notEqual(reading.stateBeforeEvent, 'stopped', 'the task must still be running before the event');
  assert.equal(reading.stateAfterEvent, 'stopped', 'the event must drive the task to stopped');
}

function assertTimedOutLeavesStateAlone(reading: { result: string; stateBefore: string | null; stateAfter: string | null }): void {
  assert.equal(reading.result, 'timeout', `a task that never stops must answer timeout (got ${reading.result})`);
  assert.equal(reading.stateAfter, reading.stateBefore, 'a timeout must leave the table as it was');
}

// ------------------------------------------------ the access entry tests -----
test('assertSessionAccess grants an authenticated request and refuses an anonymous one', () => {
  const session = { session_id: SESSION_ID } as unknown as ReturnType<typeof sessionsDb.getSessionById>;
  const granted = assertSessionAccess(1, session);
  const anonymous = assertSessionAccess(null, session);
  say(`(AC3) assertSessionAccess granted=${granted} anonymous=${anonymous}`);
  assert.equal(granted, true);
  assert.equal(anonymous, false);
});

// --------------------------------------------- resident driver placement -----
/**
 * A resident process whose stream the criterion owns, and whose query records
 * the `stopTask` calls the driver places on it. The stream never ends on its
 * own, so the host stays live for the reading.
 */
function createResidentFixture(): {
  factory: ClaudeResidentProcessFactory;
  stopCalls: string[];
  finish(): void;
} {
  const stopCalls: string[] = [];
  let finish: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const iterator: AsyncIterator<AnyRecord> = {
    next: () => ended.then(() => ({ done: true as const, value: undefined })),
    return: () => {
      finish();
      return Promise.resolve({ done: true as const, value: undefined });
    },
  };
  const query: ClaudeResidentQuery = {
    [Symbol.asyncIterator]: () => iterator,
    interrupt: async () => undefined,
    close: () => undefined,
    stopTask: async (taskId: string) => {
      stopCalls.push(taskId);
    },
  };
  return {
    stopCalls,
    factory: () => ({ query, pid: 4242 } satisfies ClaudeResidentProcess),
    finish,
  };
}

const RUNTIME_CONTEXT: ProviderRuntimeContext = {
  resolveProviderSessionId: () => null,
  resolveResumeModel: async () => undefined,
  getProviderModels: async () => CLAUDE_PREDEFINED_MODELS,
  normalizeMessage: () => [],
  isProviderInstalled: async () => true,
};

function createWriter(): ProviderRuntimeWriter {
  return { send: () => undefined, setSessionId: () => undefined, userId: 1 };
}

/** Drives one round through the real resident driver and waits for its turn lease. */
async function beginResidentRound(
  driver: ClaudeResidentHostDriver,
  manager: SessionHostManager,
  sessionId: string,
): Promise<void> {
  void driver.run(sessionId, { command: 'hold', options: {} }, createWriter(), RUNTIME_CONTEXT);
  for (let hop = 0; hop < 2_000; hop += 1) {
    const leased = manager
      .snapshot()
      .some((host) => host.bindings.get(sessionId)?.leases.some((lease) => lease.kind === 'turn'));
    if (leased) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error('the resident host never armed a turn lease');
}

test('the resident driver places stopTask on the live query and leaves the process up', async () => {
  const fixture = createResidentFixture();
  const manager = createSessionHostManager();
  const driver = new ClaudeResidentHostDriver({
    host: manager,
    notifyBackgroundWork: () => undefined,
    notifyUnattendedWork: () => undefined,
    notifyRunStopped: () => undefined,
    createProcess: fixture.factory,
    now: () => Date.now(),
  });

  try {
    await beginResidentRound(driver, manager, SESSION_ID);
    const beforeHost = manager.snapshot().find((host) => host.bindings.has(SESSION_ID));

    const placed = await driver.stopTask(SESSION_ID, 'b-resident');

    const afterHost = manager.snapshot().find((host) => host.bindings.has(SESSION_ID));
    const reading = {
      placed,
      stopCalls: [...fixture.stopCalls],
      stateBefore: beforeHost?.state ?? null,
      stateAfter: afterHost?.state ?? null,
      sameHost: beforeHost?.hostId === afterHost?.hostId,
    };
    say(`(AC10 resident) ${JSON.stringify(reading)}`);
    assert.equal(reading.placed, true, 'a live resident process must be really asked');
    assert.deepEqual(reading.stopCalls, ['b-resident'], 'the query stopTask must receive the task id');
    assert.notEqual(reading.stateAfter, 'closed', 'stopTask must not end the process');
    assert.equal(reading.sameHost, true, 'the same host must still be serving the session');
  } finally {
    fixture.finish();
    for (const host of manager.snapshot()) {
      if (host.state !== 'closed') {
        manager.closeHost(host.hostId, 'server-shutdown');
      }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
});

// ---------------------------------------------- per-run runtime placement ----
/** A per-run query that never ends until interrupted, and records stopTask calls. */
function createPerRunFixture(): {
  factory: () => ClaudeResidentQuery;
  stopCalls: string[];
} {
  const stopCalls: string[] = [];
  let finish: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const iterator: AsyncIterator<AnyRecord> = {
    next: () => ended.then(() => ({ done: true as const, value: undefined })),
    return: () => {
      finish();
      return Promise.resolve({ done: true as const, value: undefined });
    },
  };
  const query = {
    [Symbol.asyncIterator]: () => iterator,
    interrupt: async () => {
      finish();
    },
    stopTask: async (taskId: string) => {
      stopCalls.push(taskId);
    },
  } as unknown as ClaudeResidentQuery;
  return { factory: () => query, stopCalls };
}

test('the per-run runtime places stopTask on the live instance and does not end the run', async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-stop-task-per-run-'));
  const savedHome = process.env.HOME;
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const savedDatabasePath = process.env.DATABASE_PATH;
  const savedFactory = claudeQueryFactory.current;
  const fixture = createPerRunFixture();

  try {
    // The run's wind-down reads its session row through the notifications path,
    // so this leg needs a migrated database of its own: the ambient one may
    // predate the latest added column, and a run must not depend on that.
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
    process.env.HOME = tempDirectory;
    process.env.CLAUDE_CONFIG_DIR = tempDirectory;
    await initializeDatabase();
    // A real user row, so the run's own wind-down can read its notification
    // preferences without an FK failure (the SQLite foreign key is on user_id).
    const user = userDb.createUser('stop-task-per-run', 'unused-hash');
    claudeQueryFactory.current = (() => fixture.factory()) as unknown as typeof claudeQueryFactory.current;

    const appSessionId = PER_RUN_SESSION_ID;
    // The run is driven for real and left pending: its query's stream never ends,
    // which is what keeps the session registered in `activeSessions`.
    void queryClaudeSDK(
      'hold',
      { sessionId: appSessionId },
      { send: () => undefined, setSessionId: () => undefined, userId: Number(user.id) },
      {
        resolveProviderSessionId: () => null,
        resolveResumeModel: async () => undefined,
        getProviderModels: async () => CLAUDE_PREDEFINED_MODELS,
        normalizeMessage: () => [],
        isProviderInstalled: async () => true,
      },
    );

    const registered = await waitFor(
      () => getActiveClaudeSDKSessions().includes(appSessionId),
      2_000,
      'the per-run session to register',
    );
    const placed = await stopClaudeSDKTask(appSessionId, 'b-per-run');
    const stillActive = getActiveClaudeSDKSessions().includes(appSessionId);

    say(`(AC10 per-run) registered=${registered} placed=${placed} stopCalls=${JSON.stringify(fixture.stopCalls)} stillActive=${stillActive}`);
    assert.equal(registered, true, 'the per-run run must register its session');
    assert.equal(placed, true, 'a live per-run instance must be really asked');
    assert.deepEqual(fixture.stopCalls, ['b-per-run'], 'the instance stopTask must receive the task id');
    assert.equal(stillActive, true, 'stopTask must not remove the session or release its run');

    await abortClaudeSDKSession(appSessionId);
  } finally {
    claudeQueryFactory.current = savedFactory;
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
    if (savedConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    }
    if (getActiveClaudeSDKSessions().includes(PER_RUN_SESSION_ID)) {
      await abortClaudeSDKSession(PER_RUN_SESSION_ID);
    }
    if (savedDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = savedDatabasePath;
    }
    closeConnection();
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

// ------------------------------------- real application assembly, per-run ---
/*
 * The real `providerRuntimeService` the server mounts, reached through the real
 * `chat.stop-task` handler, for a session whose per-run run is genuinely live:
 * the registry resolves the real `claude` provider, the gateway takes its
 * per-run branch, and `claudeRuntime.stopTask` reaches the live instance. Only
 * the process is scripted (no CLI is spawned); every seam between the socket and
 * the instance is the shipped one.
 */
test('the real application assembly carries chat.stop-task to a live per-run instance', async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-stop-task-assembly-'));
  const savedHome = process.env.HOME;
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const savedFactory = claudeQueryFactory.current;
  const savedDatabasePath = process.env.DATABASE_PATH;
  const fixture = createPerRunFixture();
  const assemblySessionId = 'stop-task-assembly-session';
  const reducer = createClaudeTaskReducer();

  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
    process.env.HOME = tempDirectory;
    process.env.CLAUDE_CONFIG_DIR = tempDirectory;
    await initializeDatabase();
    // A real user row, so the run's own wind-down can read its notification
    // preferences without an FK failure (the SQLite foreign key is on user_id).
    const user = userDb.createUser('stop-task-assembly', 'unused-hash');
    const now = new Date().toISOString();
    sessionsDb.createSession(assemblySessionId, 'claude', tempDirectory, 'Assembly session', now, now, null);

    claudeQueryFactory.current = (() => fixture.factory()) as unknown as typeof claudeQueryFactory.current;
    void queryClaudeSDK(
      'hold',
      { sessionId: assemblySessionId },
      { send: () => undefined, setSessionId: () => undefined, userId: Number(user.id) },
      {
        resolveProviderSessionId: () => null,
        resolveResumeModel: async () => undefined,
        getProviderModels: async () => CLAUDE_PREDEFINED_MODELS,
        normalizeMessage: () => [],
        isProviderInstalled: async () => true,
      },
    );
    const registered = await waitFor(
      () => getActiveClaudeSDKSessions().includes(assemblySessionId),
      2_000,
      'the assembly per-run session to register',
    );

    reducer.observe(assemblySessionId, taskStartedFrame('b-assembly', { session_id: assemblySessionId }));

    const socket = createFakeSocket();
    handleChatConnection(socket as never, { user: { id: 1 } } as never, {
      runtime: providerRuntimeService as never,
      getTask: (sessionId: string, taskId: string) => {
        const task = reducer.getTasks(sessionId).find((candidate) => candidate.taskId === taskId);
        return task ? { state: task.state } : null;
      },
      stopTaskConfirmTimeoutMs: 1_000,
      stopTaskConfirmPollMs: 10,
    } as never);

    const receiptPromise = requestStop(socket, {
      sessionId: assemblySessionId,
      taskId: 'b-assembly',
      requestId: 'req-assembly',
    });
    const placed = await waitFor(() => fixture.stopCalls.length > 0, 1_000, 'the live instance to be asked');
    const stateBeforeEvent = stateOf(reducer, assemblySessionId, 'b-assembly');
    reducer.observe(assemblySessionId, taskNotificationFrame('b-assembly', 'stopped'));
    const receipt = await receiptPromise;

    const reading = {
      registered,
      placed,
      stopCalls: [...fixture.stopCalls],
      result: typeof receipt?.result === 'string' ? receipt.result : 'no-receipt',
      requestId: typeof receipt?.requestId === 'string' ? receipt.requestId : null,
      stateBeforeEvent,
      stateAfterEvent: stateOf(reducer, assemblySessionId, 'b-assembly'),
    };
    say(`(assembly per-run) ${JSON.stringify(reading)}`);
    assert.equal(reading.registered, true);
    assert.equal(reading.placed, true, 'the real gateway must reach the live per-run instance');
    assert.deepEqual(reading.stopCalls, ['b-assembly']);
    assert.equal(reading.result, 'requested');
    assert.equal(reading.requestId, 'req-assembly');
    assertStoppedIsEventDriven({ stateBeforeEvent: reading.stateBeforeEvent, stateAfterEvent: reading.stateAfterEvent });

    await abortClaudeSDKSession(assemblySessionId);
  } finally {
    claudeQueryFactory.current = savedFactory;
    for (const [name, value] of [
      ['HOME', savedHome],
      ['CLAUDE_CONFIG_DIR', savedConfigDir],
      ['DATABASE_PATH', savedDatabasePath],
    ] as Array<[string, string | undefined]>) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    closeConnection();
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

// ---------------------------------- gateway capability + driver-call bounds --
/**
 * A provider whose resident driver is a recording double, so the gateway's
 * routing and its bound can be read without a live process.
 */
function createGatewayFixtures(): {
  driverStopTask: string[];
  runtimeStopTask: string[];
  residentDriver: AnyRecord;
  provider: AnyRecord;
  setDriverBehavior(behavior: 'resolve' | 'reject' | 'hang'): void;
  setRuntimeStopTask(fn: ((sessionId: string, taskId: string) => Promise<boolean>) | undefined): void;
} {
  const driverStopTask: string[] = [];
  const runtimeStopTask: string[] = [];
  let behavior: 'resolve' | 'reject' | 'hang' = 'resolve';

  const residentDriver: AnyRecord = {
    run: async () => undefined,
    stopTask: async (_sessionId: string, taskId: string) => {
      driverStopTask.push(taskId);
      if (behavior === 'reject') {
        throw new Error('driver refused');
      }
      if (behavior === 'hang') {
        return new Promise<boolean>(() => undefined);
      }
      return true;
    },
  };

  let runtimeStop: ((sessionId: string, taskId: string) => Promise<boolean>) | undefined = async (
    _sessionId: string,
    taskId: string,
  ) => {
    runtimeStopTask.push(taskId);
    return true;
  };

  return {
    driverStopTask,
    runtimeStopTask,
    residentDriver,
    provider: {
      id: 'claude',
      hostDriver: residentDriver,
      get runtime() {
        return { run: async () => undefined, abort: async () => false, stopTask: runtimeStop };
      },
    },
    setDriverBehavior(next) {
      behavior = next;
    },
    setRuntimeStopTask(fn) {
      runtimeStop = fn;
    },
  };
}

test('the gateway gates the resident verb on the capability and bounds the driver call', async () => {
  const fixtures = createGatewayFixtures();
  const residentGateway = (supported: boolean, mode: 'resident' | 'per-run') =>
    createProviderRuntimeService({
      resolveProvider: () => fixtures.provider as never,
      resolveSessionLifecycleMode: () => mode,
      residentStopTaskSupported: () => supported,
      stopTaskCallTimeoutMs: 120,
    });

  // (AC9 false) The shipped capability is off: the answer is `unsupported` and
  // the driver is never touched.
  fixtures.driverStopTask.length = 0;
  const gated = residentGateway(false, 'resident');
  const gatedOutcome = await gated.controlStopTask('claude', SESSION_ID, 'b-gated');
  say(`(AC9 false) outcome=${gatedOutcome} driverCalls=${fixtures.driverStopTask.length}`);
  assert.equal(gatedOutcome, 'unsupported');
  assert.equal(fixtures.driverStopTask.length, 0, 'a disabled capability must not reach the driver');

  // (AC9 true / AC10 resident routing) With the verb on, the resident driver is
  // reached and its `requested` passes through.
  fixtures.driverStopTask.length = 0;
  const enabled = residentGateway(true, 'resident');
  const enabledOutcome = await enabled.controlStopTask('claude', SESSION_ID, 'b-enabled');
  say(`(AC9 true) outcome=${enabledOutcome} driverCalls=${JSON.stringify(fixtures.driverStopTask)}`);
  assert.equal(enabledOutcome, 'requested');
  assert.deepEqual(fixtures.driverStopTask, ['b-enabled']);

  // (AC8) A throwing driver is `error`; a hanging one is `timeout` inside the bound.
  fixtures.setDriverBehavior('reject');
  const threwOutcome = await enabled.controlStopTask('claude', SESSION_ID, 'b-throw');
  fixtures.setDriverBehavior('hang');
  const startedAt = Date.now();
  const hungOutcome = await enabled.controlStopTask('claude', SESSION_ID, 'b-hang');
  const elapsedMs = Date.now() - startedAt;
  fixtures.setDriverBehavior('resolve');
  say(`(AC8) threw=${threwOutcome} hung=${hungOutcome} elapsedMs=${elapsedMs}`);
  assert.equal(threwOutcome, 'error');
  assert.equal(hungOutcome, 'timeout');
  assert.ok(elapsedMs < 1_000, `the bound must fire near its 120ms ceiling (elapsed=${elapsedMs}ms)`);

  // (AC10 per-run routing) A non-resident session goes through the per-run
  // runtime's own stop verb instead.
  fixtures.runtimeStopTask.length = 0;
  const perRun = residentGateway(true, 'per-run');
  const perRunOutcome = await perRun.controlStopTask('claude', PER_RUN_SESSION_ID, 'b-per-run');
  say(`(AC10 per-run routing) outcome=${perRunOutcome} runtimeCalls=${JSON.stringify(fixtures.runtimeStopTask)}`);
  assert.equal(perRunOutcome, 'requested');
  assert.deepEqual(fixtures.runtimeStopTask, ['b-per-run']);

  // The positive control for the gate: an unknown id lands no stop at all.
  fixtures.runtimeStopTask.length = 0;
  fixtures.setRuntimeStopTask(undefined);
  const withoutVerb = await perRun.controlStopTask('claude', PER_RUN_SESSION_ID, 'b-no-verb');
  say(`(AC9 control) noVerb=${withoutVerb}`);
  assert.equal(withoutVerb, 'unsupported');
});
