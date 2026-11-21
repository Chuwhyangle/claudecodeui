/**
 * Criterion: the dock's stop control against the **real provider capability
 * face** — the shipped matrix as the thing that decides, rather than a
 * substitute driver that accepts everything.
 *
 * Why this file exists. AC-196's criterion proves the control plane walks its
 * timing correctly, and AC-199's proves the browser draws the events — but both
 * drive a *substitute* host driver that accepts every stop (the debug agent's
 * `stopTask` returns `true` unconditionally, and AC-196's scripted query is
 * handed to the driver directly). Neither ever asks the question this task is
 * about: what does the product do when the provider's own capability matrix says
 * the verb is not there? On the tree this file was written against, the answer
 * was "the button looks live, takes the click, and nothing happens" — the
 * matrix said `stopTask: false`, the runtime therefore answered `unsupported`,
 * and no dock code had ever read the matrix at all.
 *
 * What is read here, and on which of the two axes:
 *
 *  The capability face (the shipped matrix itself):
 *   (AC1/AC3) `claude`'s resident `stopTask` declaration — the value the whole
 *        chain routes on, read from the same service the server reads it from;
 *   (AC2) that value being `false` is what produces `unsupported`, and the
 *        reading function below is what says so: fed the false-form data it
 *        throws, so a green main arm is evidence and not a coincidence.
 *
 *  The chain (the real `providerRuntimeService`, the real
 *  `ClaudeResidentHostDriver`, the real `chat.stop-task` handler, one temp
 *  database and one scripted SDK process):
 *   (AC1) a resident session's stop reaches the live query with the right task
 *        id, and the task leaves `running` only on the `task_notification`
 *        frame — never on the call, never on the receipt;
 *   (AC2) when the provider declares no such verb, the handler answers
 *        `unsupported` **before** it addresses the table, so even a task the
 *        table does not hold gets the verb-level refusal, and the driver is
 *        never reached;
 *   (AC3) the two readings of the same assertion: the pre-fix capability
 *        (the value the matrix carried before this change, injected through the
 *        same seam the matrix feeds) is RED under the AC1 reading, the shipped
 *        one is GREEN.
 *
 * The one substitute is the SDK process — the shape AC-196 already draws its
 * boundary at. The real-SDK hop was measured out of band and is recorded in the
 * completion record: a real `query()` against the real CLI, asked for a
 * background task and then stopped through `Query.stopTask`, answered
 * `task_updated{patch:{status:'killed'}}` + `task_notification{status:'stopped'}`
 * ~1.0s later, with the task's own process alive immediately before the call and
 * gone immediately after it.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  sessionsDb,
} from '@/modules/database/index.js';
import {
  CLAUDE_PREDEFINED_MODELS,
  ClaudeResidentHostDriver,
  createClaudeTaskReducer,
  createProviderRuntimeService,
  providerCapabilitiesService,
} from '@/modules/providers/index.js';
import type {
  ActivityTask,
  ClaudeResidentProcess,
  ClaudeResidentProcessFactory,
  ClaudeResidentQuery,
  ClaudeTaskReducer,
  ControlStopTaskOutcome,
} from '@/modules/providers/index.js';
import { createSessionHostManager } from '@/modules/session-hosts/index.js';
import type { SessionHostManager } from '@/modules/session-hosts/index.js';
// Imported from the service rather than the module barrel, for the same reason
// AC-196's criterion does: the handler is this module's own file and no extra
// barrel surface should be added for one criterion.
import { handleChatConnection } from '@/modules/websocket/services/dispatch/chat-websocket.service.js';
import type {
  AnyRecord,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

const SESSION_ID = 'stop-task-capability-resident';

/** One line of this criterion's readings. The readings are the evidence. */
function say(line: string): void {
  console.log(`stop-task-capability ${line}`);
}

// ------------------------------------------------------------- frame builders --
/*
 * The shapes are the ones the real SDK was measured emitting on 2026-10-04: the
 * `task_updated` patch carries the status under `patch`, and the terminal
 * notification carries `status: 'stopped'`. Both are what the reducer is held to.
 */
function taskStartedFrame(taskId: string): AnyRecord {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    tool_use_id: `toolu_${taskId}`,
    description: 'sleep 300',
    is_backgrounded: true,
    task_type: 'local_bash',
    uuid: randomUUID(),
    session_id: SESSION_ID,
  };
}

/** The stop the SDK was measured emitting: a status patch, `killed`. */
function taskUpdatedKilledFrame(taskId: string): AnyRecord {
  return {
    type: 'system',
    subtype: 'task_updated',
    task_id: taskId,
    patch: { status: 'killed', end_time: Date.now() },
    uuid: randomUUID(),
    session_id: SESSION_ID,
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

function stateOf(
  reducer: ClaudeTaskReducer,
  sessionId: string,
  taskId: string,
): ActivityTask['state'] | null {
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
  console.log(`stop-task-capability waitFor timed out: ${label}`);
  return false;
}

// ------------------------------------------------- the real resident driver --
/**
 * A resident process whose stream the criterion owns and whose query records the
 * `stopTask` calls the driver places on it. The stream never ends on its own, so
 * the host stays live for the reading.
 *
 * The driver above it is the *real* `ClaudeResidentHostDriver` — not a recording
 * double — so what this criterion reaches through the real gateway is the shipped
 * `stopTask` implementation, not a second copy of it.
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

/** Arms the resident host's turn lease, which is what makes its process live. */
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

// ---------------------------------------------------------------- harness ----
/** What a criterion arm may override; each is the seam the matrix itself feeds. */
type ConnectOptions = {
  /** Overrides the handler's own verb-level reader (the chat-websocket seam). */
  residentControlVerbSupported?: (provider: string, sessionId: string, verb: string) => boolean;
  /** Overrides the runtime gateway's resident gate (the provider-runtime seam). */
  residentStopTaskSupported?: () => boolean;
  /** How long the handler waits for the table to settle. */
  confirmTimeoutMs?: number;
};

type Harness = {
  reducer: ClaudeTaskReducer;
  fixture: ReturnType<typeof createResidentFixture>;
  /** The socket, wired to a gateway whose capability reader is what was asked for. */
  connect(options?: ConnectOptions): FakeSocket;
};

/**
 * One temp database, one real resident host, one real gateway, one real handler.
 *
 * The gateway is built with `createProviderRuntimeService` and **no** capability
 * override for the main arm, so the shipped matrix is what answers — that is the
 * whole point of the file. The two seams exist for the false-form arms, and each
 * is the same seam the matrix feeds in production.
 */
async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'stop-task-capability-'));
  const previousDatabasePath = process.env.DATABASE_PATH;
  const manager = createSessionHostManager();
  const fixture = createResidentFixture();
  const driver = new ClaudeResidentHostDriver({
    host: manager,
    notifyBackgroundWork: () => undefined,
    notifyUnattendedWork: () => undefined,
    notifyRunStopped: () => undefined,
    createProcess: fixture.factory,
    now: () => Date.now(),
  });

  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
    await initializeDatabase();

    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', tempDirectory, 'Resident stop session', now, now, null);
    const markedResident = sessionsDb.setSessionLifecycleMode(SESSION_ID, 'resident');

    await beginResidentRound(driver, manager, SESSION_ID);

    const reducer = createClaudeTaskReducer();
    const provider = {
      id: 'claude',
      hostDriver: driver,
      get runtime() {
        return { run: async () => undefined, abort: async () => false };
      },
    };

    const connect = (options: ConnectOptions = {}): FakeSocket => {
      const gateway = createProviderRuntimeService({
        resolveProvider: () => provider as never,
        resolveSessionLifecycleMode: () => 'resident',
        // Deliberately absent for the main arm: the shipped matrix answers.
        ...(options.residentStopTaskSupported
          ? { residentStopTaskSupported: options.residentStopTaskSupported }
          : {}),
        stopTaskCallTimeoutMs: 500,
      });

      const socket = createFakeSocket();
      handleChatConnection(socket as never, { user: { id: 1 } } as never, {
        runtime: gateway as never,
        getTask: (sessionId: string, taskId: string) => {
          const task = reducer.getTasks(sessionId).find((candidate) => candidate.taskId === taskId);
          return task ? { state: task.state } : null;
        },
        ...(options.residentControlVerbSupported
          ? { residentControlVerbSupported: options.residentControlVerbSupported }
          : {}),
        stopTaskConfirmTimeoutMs: options.confirmTimeoutMs ?? 1_000,
        stopTaskConfirmPollMs: 10,
      } as never);
      return socket;
    };

    say(`harness resident=${markedResident}`);
    await run({ reducer, fixture, connect });
  } finally {
    fixture.finish();
    for (const host of manager.snapshot()) {
      if (host.state !== 'closed') {
        manager.closeHost(host.hostId, 'server-shutdown');
      }
    }
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** Sends one `chat.stop-task` and answers with the receipt frame it produced. */
async function requestStop(socket: FakeSocket, taskId: string, requestId: string): Promise<AnyRecord | null> {
  const before = socket.frames.length;
  socket.emit('message', JSON.stringify({ type: 'chat.stop-task', sessionId: SESSION_ID, taskId, requestId }));
  await waitFor(
    () => socket.frames.slice(before).some((frame) => frame.kind === 'control_result'),
    2_000,
    `a control_result for ${taskId}`,
  );
  return socket.frames.slice(before).find((frame) => frame.kind === 'control_result') ?? null;
}

const STOP_TARGET = 'b-resident-live';

// ------------------------------------------------------- the AC1/AC3 reading --
/**
 * The reading AC1's claim is graded on: a stop placed on a resident session
 * reaches the live query with the right task id, the row is still `running`
 * before the event, and it is `stopped` after it.
 *
 * Written once so the false-form arm drives the SAME function the main arm drove.
 * The pre-fix capability produces `driverCalls: []` and a row that never moved,
 * and must come back red — which is what makes the main arm's green evidence
 * about the gate rather than about the harness.
 */
function assertStopReachesTheLiveQuery(reading: {
  result: string;
  driverCalls: string[];
  stateBeforeEvent: string | null;
  stateAfterEvent: string | null;
}): void {
  assert.deepEqual(
    reading.driverCalls,
    [STOP_TARGET],
    `the live query must receive exactly the addressed task id (got ${JSON.stringify(reading.driverCalls)})`,
  );
  assert.equal(reading.result, 'requested', `a placed stop must answer requested (got ${reading.result})`);
  assert.notEqual(reading.stateBeforeEvent, 'stopped', 'the task must still be running before the event');
  assert.equal(reading.stateAfterEvent, 'stopped', 'the event must drive the task to stopped');
}

// ------------------------------------------------------- the AC2 reading ------
/**
 * The reading AC2's claim is graded on: a provider that declares no stop verb
 * must not have a stop treated as placed — `unsupported`, the driver untouched,
 * the addressed row exactly where it was.
 */
function assertUnsupportedPlacesNothing(reading: {
  result: string;
  driverCalls: string[];
  stateBefore: string | null;
  stateAfter: string | null;
}): void {
  assert.equal(
    reading.result,
    'unsupported',
    `a provider without the verb must answer unsupported (got ${reading.result})`,
  );
  assert.deepEqual(reading.driverCalls, [], 'a provider without the verb must not reach the driver');
  assert.equal(reading.stateAfter, reading.stateBefore, 'an unsupported stop must leave the row as it was');
}


// ---------------------------------------------------------------- the tests ---

test('the shipped matrix declares the resident stop verb, and the real assembly reaches the live query', async () => {
  await withHarness(async ({ reducer, fixture, connect }) => {
    // ---- AC3 (capability face): the value the whole chain routes on, read from
    // the same service the server reads it from. Before this change this read
    // `false`, which is exactly why the dock's stop was inert on a real resident
    // session: the runtime answered `unsupported` before any driver.
    const shipped = providerCapabilitiesService.getProviderCapabilities('claude').residentFeatures;
    say(`(capability) shipped.residentFeatures.stopTask=${String(shipped?.stopTask)}`);

    // ---- AC1: place a stop on a resident session and read the three things the
    // claim is made of: the live query was really asked, the row was still
    // `running` before the event, and the event — not the call — settled it.
    reducer.observe(SESSION_ID, taskStartedFrame(STOP_TARGET));
    const socket = connect();
    const receiptPromise = requestStop(socket, STOP_TARGET, 'req-live');
    const placed = await waitFor(() => fixture.stopCalls.length > 0, 2_000, 'the live query to be asked');
    const stateBeforeEvent = stateOf(reducer, SESSION_ID, STOP_TARGET);
    // The real SDK's own frames, verbatim: a `killed` patch and the terminal
    // notification. Both are what the shipped reducer consumes.
    reducer.observe(SESSION_ID, taskUpdatedKilledFrame(STOP_TARGET));
    reducer.observe(SESSION_ID, taskNotificationFrame(STOP_TARGET, 'stopped'));
    const receipt = await receiptPromise;

    const liveReading = {
      result: typeof receipt?.result === 'string' ? receipt.result : 'no-receipt',
      driverCalls: [...fixture.stopCalls],
      stateBeforeEvent,
      stateAfterEvent: stateOf(reducer, SESSION_ID, STOP_TARGET),
    };
    say(`(AC1) placed=${placed} liveReading=${JSON.stringify(liveReading)}`);

    assert.equal(shipped?.stopTask, true, 'the shipped matrix must declare the resident stop verb this path needs');
    assertStopReachesTheLiveQuery(liveReading);

    // ---- AC3 (false form): the pre-fix capability is the same chain with the
    // gate reading `false` — the value the matrix carried before this change.
    // The AC1 reading must come back red on it, so the green above is the gate's
    // doing and not the harness's. The call log is cleared first: what makes the
    // pre-fix arm red is that *this* request placed nothing, not a call the
    // previous arm left behind.
    fixture.stopCalls.length = 0;
    reducer.observe(SESSION_ID, taskStartedFrame('b-prefix'));
    const prefixSocket = connect({
      residentControlVerbSupported: () => false,
      residentStopTaskSupported: () => false,
    });
    const prefixReceipt = await requestStop(prefixSocket, 'b-prefix', 'req-prefix');
    const prefixReading = {
      result: typeof prefixReceipt?.result === 'string' ? prefixReceipt.result : 'no-receipt',
      driverCalls: [...fixture.stopCalls],
      stateBeforeEvent: stateOf(reducer, SESSION_ID, 'b-prefix'),
      stateAfterEvent: stateOf(reducer, SESSION_ID, 'b-prefix'),
    };
    say(`(AC3 unfixed) reading=${JSON.stringify(prefixReading)}`);
    assert.throws(
      () => assertStopReachesTheLiveQuery(prefixReading),
      /must receive exactly the addressed task id/,
      'the pre-fix capability must red the AC1 reading',
    );
    console.log('[readings] pre-fix capability: red');
  });
});

test('a provider that declares no stop verb answers unsupported before the table and never reaches the driver', async () => {
  await withHarness(async ({ reducer, fixture, connect }) => {
    // A socket whose provider declares no stop verb — the pre-fix matrix value,
    // injected through the very seam the matrix feeds.
    const socket = connect({ residentControlVerbSupported: () => false });

    // ---- AC2 (addressed): a running task the table holds gets the verb-level
    // refusal, the driver is untouched, and the row does not move.
    reducer.observe(SESSION_ID, taskStartedFrame('b-gated'));
    const before = stateOf(reducer, SESSION_ID, 'b-gated');
    const gated = await requestStop(socket, 'b-gated', 'req-gated');
    const gatedReading = {
      result: typeof gated?.result === 'string' ? gated.result : 'no-receipt',
      driverCalls: [...fixture.stopCalls],
      stateBefore: before,
      stateAfter: stateOf(reducer, SESSION_ID, 'b-gated'),
    };
    say(`(AC2 addressed) ${JSON.stringify(gatedReading)}`);
    assertUnsupportedPlacesNothing(gatedReading);

    // ---- AC2 (table-independent): the refusal is about the *verb*, not about
    // which task was named. A task the table never held is `unsupported` here,
    // not `unknown-task` — the property that makes the answer the same question
    // the dock's disabled control is asking.
    const absent = await requestStop(socket, 'never-started', 'req-absent');
    const absentReading = {
      result: typeof absent?.result === 'string' ? absent.result : 'no-receipt',
      driverCalls: [...fixture.stopCalls],
      stateBefore: null,
      stateAfter: stateOf(reducer, SESSION_ID, 'never-started'),
    };
    say(`(AC2 table-independent) ${JSON.stringify(absentReading)}`);
    assertUnsupportedPlacesNothing(absentReading);

    // ---- AC2 (false form): the reading must red the moment the gate stops
    // being consulted — "unconditionally allowed" is exactly `requested` with a
    // driver call, which is what the pre-fix product did *not* do and what a
    // gate-free build would.
    assert.throws(
      () =>
        assertUnsupportedPlacesNothing({
          result: 'requested',
          driverCalls: ['b-gated'],
          stateBefore: 'running',
          stateAfter: 'stopped',
        }),
      /must answer unsupported/,
      'the gate removed (unconditionally allowed) must red the AC2 reading',
    );
    console.log('[readings] gate removed: red');

    // ---- and the positive control that the gate is what moved it: the shipped
    // capability, same harness, same request, reaches the driver *and* walks the
    // confirmation — the reading the gated arm above could not produce.
    reducer.observe(SESSION_ID, taskStartedFrame('b-open'));
    const openSocket = connect();
    const openReceiptPromise = requestStop(openSocket, 'b-open', 'req-open');
    const openPlaced = await waitFor(() => fixture.stopCalls.includes('b-open'), 2_000, 'the open gate to place');
    reducer.observe(SESSION_ID, taskNotificationFrame('b-open', 'stopped'));
    const openReceipt = await openReceiptPromise;
    const openResult = typeof openReceipt?.result === 'string' ? openReceipt.result : 'no-receipt';
    say(
      `(AC2 control) openResult=${openResult} placed=${openPlaced} driverCalls=${JSON.stringify(fixture.stopCalls)}`,
    );
    assert.equal(openPlaced, true, 'with the verb declared, the same request must reach the driver');
    assert.equal(openResult, 'requested', 'with the verb declared, the placement must walk the confirmation');
  });
});
