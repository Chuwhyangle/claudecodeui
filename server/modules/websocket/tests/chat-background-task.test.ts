/**
 * AC-197 criterion — `chat.background-task`, the activity dock's second control
 * verb, which promotes a *running foreground tool* to a background task.
 *
 * The claim is one sentence: the server addresses a background request at the
 * **Turn Tracker** (the `tool_use` still awaiting its paired `tool_result`), not
 * at the task table — a foreground tool has no task row until the CLI backgrounds
 * it — places the request on the provider's own process, and takes "the task
 * really appeared" from the events the CLI emits, never from the driver call.
 *
 * What is proven, and where each reading comes from:
 *
 *  Protocol (the real `chat.background-task` handler, a stub runtime, the real
 *  module-level Turn Tracker fed through `forwardNormalizedFrames`, and AC-191's
 *  real reducer as the task table):
 *   (AC2) each of `sessionId` / `toolUseId` / `requestId` is required, and a
 *         missing one is a protocol error that places no request — so the
 *         no-`toolUseId` "background everything" form is not exposed;
 *   (AC3) an unknown session is refused, and a request from an unauthenticated
 *         socket is `forbidden` — with the driver never reached;
 *   (AC4) a request naming the tracker's pending foreground tool is accepted; one
 *         naming anything else (including a session with no pending tool) is
 *         `no-foreground-match`, with no driver call and no state moved;
 *   (AC5) the success arm is accepted **while the task table is empty**, which is
 *         the proof the address is the tracker and not a task row;
 *   (AC6) a valid request reaches the driver with the `toolUseId` string and
 *         answers `requested`, echoing the `requestId`, and the receipt itself
 *         leaves the table alone;
 *   (AC7) feeding `task_started` + `task_updated{is_backgrounded:true}` moves the
 *         table — the appearance is the event's, not the receipt's.
 *
 *  Placement (the real runtime gateway, the real resident driver, the real
 *  per-run runtime, and the real application assembly):
 *   (AC10) the resident capability is off by default, so a request answers
 *          `unsupported` without reaching a driver; with it on (injected) the
 *          driver is reached;
 *   (AC11) the resident driver's `background` reaches the live
 *          `query.backgroundTasks`, and the per-run `backgroundClaudeSDKTask`
 *          reaches the live `instance.backgroundTasks` — each with the string id,
 *          never the no-argument "background everything" form;
 *   (AC8) a driver call that settles `false` is `no-foreground-match`, and one
 *         that settles `true` is `requested`;
 *   (AC9) a driver call that throws is `error`, and one that never settles is
 *         `timeout` inside the bound — so the handler cannot hang on it.
 *
 * Each named reading is driven a second time by a fake form (AC12): one that
 * addresses the task table by `taskId`, one that writes `isBackgrounded` with the
 * receipt, and one that skips the ownership check. Each fake form must red the
 * same assertion the real arm passes, which is what proves the assertion has
 * discriminating power.
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
  userDb,
} from '@/modules/database/index.js';
import {
  abortClaudeSDKSession,
  backgroundClaudeSDKTask,
  CLAUDE_PREDEFINED_MODELS,
  ClaudeResidentHostDriver,
  claudeQueryFactory,
  createClaudeTaskReducer,
  createProviderRuntimeService,
  forwardNormalizedFrames,
  getActiveClaudeSDKSessions,
  providerRuntimeService,
  queryClaudeSDK,
  readSessionForegroundToolUseId,
} from '@/modules/providers/index.js';
import type {
  ActivityTask,
  ClaudeResidentProcess,
  ClaudeResidentProcessFactory,
  ClaudeResidentQuery,
  ClaudeTaskReducer,
  ControlBackgroundTaskOutcome,
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

const SESSION_ID = 'background-task-session';
const NO_TOOL_SESSION_ID = 'background-task-no-tool-session';
const PER_RUN_SESSION_ID = 'background-task-per-run-session';

/** One line of this criterion's readings. The readings are the evidence. */
function say(line: string): void {
  console.log(`background-task ${line}`);
}

// ------------------------------------------------------------- frame builders --
/*
 * The shapes come from the E9 capture (`docs/proposals/claude-resident-sessions-experiments.md`
 * §9.3 for the foreground-Bash-backgrounded sequence) and from AC-191's own
 * criterion, whose reducer consumes exactly these frames. They are the contract
 * this criterion holds the reducer to.
 */

/** §9.3: the plain foreground `tool_use` the Turn Tracker holds as pending. */
function foregroundToolUseFrame(sessionId: string, toolUseId: string): AnyRecord {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: {} }],
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: sessionId,
  };
}

/** §9.3: the `task_started` the CLI emits when the foreground Bash is backgrounded. */
function taskStartedFrame(sessionId: string, taskId: string, toolUseId: string): AnyRecord {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    tool_use_id: toolUseId,
    description: 'sleep 300; echo done',
    task_type: 'local_bash',
    uuid: randomUUID(),
    session_id: sessionId,
  };
}

/** §9.3: the `task_updated` that flips `is_backgrounded` on the same instant. */
function taskBackgroundedFrame(sessionId: string, taskId: string): AnyRecord {
  return {
    type: 'system',
    subtype: 'task_updated',
    task_id: taskId,
    patch: { is_backgrounded: true },
    uuid: randomUUID(),
    session_id: sessionId,
  };
}

// --------------------------------------------------------- the turn tracker --
/** The writer `forwardNormalizedFrames` needs; the tracker read ignores the frames. */
function createWriter(): ProviderRuntimeWriter {
  return { send: () => undefined, setSessionId: () => undefined, userId: 1 };
}

/**
 * Feeds the real module-level Turn Tracker a foreground `tool_use` for a session.
 *
 * This drives the *shipped* seam (`forwardNormalizedFrames`, the same one the run
 * loop uses) rather than a hand-built tracker, so the pending id the handler reads
 * is the one a real foreground tool would leave. It is the strongest form of the
 * AC4 reading: nothing between the frame and the handler's address is faked.
 */
function feedForegroundToolUse(sessionId: string, toolUseId: string): void {
  forwardNormalizedFrames({
    transformedMessage: foregroundToolUseFrame(sessionId, toolUseId),
    sessionId,
    turnSessionId: sessionId,
    normalizeMessage: () => [],
    writer: createWriter(),
  });
}

/** Reads one task's backgrounded flag straight out of the real reducer, or null. */
function taskOf(reducer: ClaudeTaskReducer, sessionId: string, taskId: string): ActivityTask | null {
  return reducer.getTasks(sessionId).find((task) => task.taskId === taskId) ?? null;
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
  console.log(`background-task waitFor timed out: ${label}`);
  return false;
}

// ------------------------------------------------------- protocol harness ----
type StubRuntime = {
  calls: Array<{ provider: string; sessionId: string; toolUseId: string }>;
  setOutcome(outcome: ControlBackgroundTaskOutcome): void;
  runtime: AnyRecord;
};

function createStubRuntime(): StubRuntime {
  let outcome: ControlBackgroundTaskOutcome = 'requested';
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
      controlBackgroundTask: async (provider: string, sessionId: string, toolUseId: string) => {
        calls.push({ provider, sessionId, toolUseId });
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
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-background-task-'));
  const previousDatabasePath = process.env.DATABASE_PATH;

  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
    await initializeDatabase();

    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', tempDirectory, 'Background session', now, now, null);
    sessionsDb.createSession(NO_TOOL_SESSION_ID, 'claude', tempDirectory, 'No-tool session', now, now, null);

    const reducer = createClaudeTaskReducer();
    const runtime = createStubRuntime();
    const dependencies: AnyRecord = {
      runtime: runtime.runtime,
      getTask: (sessionId: string, taskId: string): { state: ActivityTask['state'] } | null => {
        const task = reducer.getTasks(sessionId).find((candidate) => candidate.taskId === taskId);
        return task ? { state: task.state } : null;
      },
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

/** Sends one `chat.background-task` and answers with the receipt frame it produced, if any. */
async function requestBackground(
  socket: FakeSocket,
  payload: AnyRecord,
): Promise<AnyRecord | null> {
  const before = socket.frames.length;
  socket.emit('message', JSON.stringify({ type: 'chat.background-task', ...payload }));
  await waitFor(
    () => socket.frames.slice(before).some((frame) => frame.kind === 'control_result'),
    1_000,
    `a control_result for ${JSON.stringify(payload)}`,
  );
  return socket.frames.slice(before).find((frame) => frame.kind === 'control_result') ?? null;
}

/** The protocol error code one `chat.background-task` produced, if any. */
function errorCode(socket: FakeSocket, from: number): string | null {
  const frame = socket.frames
    .slice(from)
    .find((candidate) => candidate.kind === 'protocol_error');
  return typeof frame?.code === 'string' ? frame.code : null;
}

// -------------------------------------------------------------- AC2–AC9 ------
test('chat.background-task addresses the Turn Tracker, places the request, and leaves the task table to the event', async () => {
  await withProtocolHarness(async ({ reducer, runtime, connect, connectAnonymous }) => {
    const socket = connect();
    const foregroundTool = `toolu_${randomUUID()}`;
    const foregroundTaskId = `task_${randomUUID()}`;

    // ---- AC2: each field is required, and a missing one places no request. ----
    const missing: Array<[string, AnyRecord]> = [
      ['sessionId', { toolUseId: 'f', requestId: 'r' }],
      ['toolUseId', { sessionId: SESSION_ID, requestId: 'r' }],
      ['requestId', { sessionId: SESSION_ID, toolUseId: 'f' }],
    ];
    const codes: string[] = [];
    for (const [field, payload] of missing) {
      const from = socket.frames.length;
      socket.emit('message', JSON.stringify({ type: 'chat.background-task', ...payload }));
      await waitFor(() => socket.frames.length > from, 500, `a refusal for a missing ${field}`);
      codes.push(errorCode(socket, from) ?? 'none');
    }
    say(`(AC2) missingFieldCodes=${JSON.stringify(codes)} driverCalls=${runtime.calls.length}`);
    assert.deepEqual(codes, ['SESSION_ID_REQUIRED', 'TOOL_USE_ID_REQUIRED', 'REQUEST_ID_REQUIRED']);
    assert.equal(runtime.calls.length, 0, 'a missing field must not reach the driver');

    // ---- AC3: an unknown session is refused, and an unauthenticated socket is
    // `forbidden` with the driver untouched. ----
    const unknownSessionFrom = socket.frames.length;
    socket.emit('message', JSON.stringify({
      type: 'chat.background-task',
      sessionId: 'no-such-session',
      toolUseId: foregroundTool,
      requestId: 'r',
    }));
    await waitFor(() => socket.frames.length > unknownSessionFrom, 500, 'a refusal for an unknown session');
    const unknownSessionCode = errorCode(socket, unknownSessionFrom);

    // Seed a *pending foreground tool* so the forbidden arm would otherwise have
    // been a valid request — the refusal must be the ownership check, not the
    // tracker's `no-foreground-match`.
    feedForegroundToolUse(SESSION_ID, foregroundTool);
    const forbidden = await requestBackground(connectAnonymous(), {
      sessionId: SESSION_ID,
      toolUseId: foregroundTool,
      requestId: 'req-forbidden',
    });
    const forbiddenReading = {
      result: typeof forbidden?.result === 'string' ? forbidden.result : 'no-receipt',
      driverCalls: runtime.calls.length,
    };
    say(`(AC3) unknownSessionCode=${unknownSessionCode} forbidden=${JSON.stringify(forbiddenReading)}`);
    assert.equal(unknownSessionCode, 'SESSION_NOT_FOUND');
    assertForbiddenPlacesNothing(forbiddenReading);
    assert.equal(readSessionForegroundToolUseId(SESSION_ID), foregroundTool, 'forbidden must not clear the tracker');
    assert.equal(taskOf(reducer, SESSION_ID, foregroundTaskId), null, 'forbidden must not write the table');

    // ---- AC4: the tracker's pending tool is the address; anything else is
    // `no-foreground-match` with no driver call and no state moved. ----
    assert.equal(
      readSessionForegroundToolUseId(SESSION_ID),
      foregroundTool,
      'the real tracker must hold the foreground tool the frame fed it',
    );
    // A tracker with no pending tool at all (a session never fed a tool_use).
    const noTool = await requestBackground(socket, {
      sessionId: NO_TOOL_SESSION_ID,
      toolUseId: foregroundTool,
      requestId: 'req-no-tool',
    });
    // A tracker that holds a *different* pending tool than the one requested.
    const mismatched = await requestBackground(socket, {
      sessionId: SESSION_ID,
      toolUseId: `toolu_${randomUUID()}`,
      requestId: 'req-mismatch',
    });
    const noMatchReadings = {
      noTool: typeof noTool?.result === 'string' ? noTool.result : 'no-receipt',
      mismatched: typeof mismatched?.result === 'string' ? mismatched.result : 'no-receipt',
      driverCalls: runtime.calls.length,
    };
    say(`(AC4) noMatchReadings=${JSON.stringify(noMatchReadings)}`);
    assert.equal(noMatchReadings.noTool, 'no-foreground-match');
    assert.equal(noMatchReadings.mismatched, 'no-foreground-match');
    assert.equal(runtime.calls.length, 0, 'a no-match request must not reach the driver');
    assert.equal(readSessionForegroundToolUseId(SESSION_ID), foregroundTool, 'a no-match must not clear the tracker');

    // ---- AC5 + AC6: a tracker-matched request is accepted while the table is
    // empty, reaches the driver with the toolUseId string, and echoes the
    // requestId — while writing nothing itself. ----
    runtime.setOutcome('requested');
    const receipt = await requestBackground(socket, {
      sessionId: SESSION_ID,
      toolUseId: foregroundTool,
      requestId: 'req-live',
    });
    const tableHasTaskBeforeEvent = taskOf(reducer, SESSION_ID, foregroundTaskId) !== null;
    const acceptance = {
      result: typeof receipt?.result === 'string' ? receipt.result : 'no-receipt',
      requestId: typeof receipt?.requestId === 'string' ? receipt.requestId : null,
      driverCall: runtime.calls[runtime.calls.length - 1],
      tableHasTask: tableHasTaskBeforeEvent,
    };
    say(`(AC5/6) acceptance=${JSON.stringify(acceptance)}`);
    assert.equal(acceptance.result, 'requested');
    assert.equal(acceptance.requestId, 'req-live', 'the receipt must echo the requestId');
    assert.deepEqual(
      acceptance.driverCall,
      { provider: 'claude', sessionId: SESSION_ID, toolUseId: foregroundTool },
      'the driver must be reached with the toolUseId string',
    );
    assertAddressedByToolUse({
      result: acceptance.result,
      tableHasTask: acceptance.tableHasTask,
      pendingMatches: true,
    });

    // ---- AC7: the event, and nothing else, is what puts the task in the table. ----
    reducer.observe(SESSION_ID, taskStartedFrame(SESSION_ID, foregroundTaskId, foregroundTool));
    reducer.observe(SESSION_ID, taskBackgroundedFrame(SESSION_ID, foregroundTaskId));
    const landed = taskOf(reducer, SESSION_ID, foregroundTaskId);
    const eventReading = {
      beforeEvent: tableHasTaskBeforeEvent,
      afterEvent: landed !== null,
      isBackgrounded: landed?.isBackgrounded ?? null,
      toolUseId: landed?.toolUseId ?? null,
    };
    say(`(AC7) eventReading=${JSON.stringify(eventReading)}`);
    assertTaskAbsentBeforeEvent({ beforeEvent: eventReading.beforeEvent, afterEvent: eventReading.afterEvent });
    assert.equal(eventReading.isBackgrounded, true, 'the event must drive isBackgrounded true');
    assert.equal(eventReading.toolUseId, foregroundTool, 'the row must carry the foreground tool id');

    // ---- AC8 (receipt half): the gateway's own answers pass through unchanged. ----
    runtime.setOutcome('no-foreground-match');
    const noMatchReceipt = await requestBackground(socket, {
      sessionId: SESSION_ID,
      toolUseId: foregroundTool,
      requestId: 'req-nm',
    });
    say(`(AC8) noMatchReceipt=${String(noMatchReceipt?.result)}`);
    assert.equal(noMatchReceipt?.result, 'no-foreground-match');

    // ---- AC9 (receipt half): `unsupported` / `error` / `timeout` pass through. ----
    const passthrough: string[] = [];
    for (const outcome of ['unsupported', 'error', 'timeout'] as ControlBackgroundTaskOutcome[]) {
      runtime.setOutcome(outcome);
      const receiptForOutcome = await requestBackground(socket, {
        sessionId: SESSION_ID,
        toolUseId: foregroundTool,
        requestId: `req-${outcome}`,
      });
      passthrough.push(typeof receiptForOutcome?.result === 'string' ? receiptForOutcome.result : 'no-receipt');
    }
    say(`(AC9) passthrough=${JSON.stringify(passthrough)}`);
    assert.deepEqual(passthrough, ['unsupported', 'error', 'timeout']);
    // The non-success receipts all left the table as the event put it.
    assert.equal(taskOf(reducer, SESSION_ID, foregroundTaskId)?.isBackgrounded, true);

    // ---- AC12: the fake forms red the same readings the real arms passed. ----
    // (a) A handler that addresses the task table by `taskId` cannot find a
    // foreground tool's row — the table was empty when the request arrived — so
    // it answers `no-foreground-match` where the real arm answered `requested`.
    assert.throws(
      () => assertAddressedByToolUse({ result: 'no-foreground-match', tableHasTask: false, pendingMatches: true }),
      /must be accepted/,
      'fake (taskId-addressed) must red the tracker-addressed reading',
    );
    console.log('[readings] fake taskId-addressed: red');
    // (b) An optimistic handler stamps `isBackgrounded` with its receipt: the row
    // exists before the event, so the event-driven reading must fail.
    assert.throws(
      () => assertTaskAbsentBeforeEvent({ beforeEvent: true, afterEvent: true }),
      /must not write the task/,
      'fake (optimistic) must red the event-driven reading',
    );
    console.log('[readings] fake optimistic: red');
    // (c) A handler with no ownership check answers the request instead of
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
  assert.equal(reading.driverCalls, 0, 'a forbidden request must place no background request');
}

function assertAddressedByToolUse(reading: {
  result: string;
  tableHasTask: boolean;
  pendingMatches: boolean;
}): void {
  // AC5: the success arm is accepted while the task table is empty, which only
  // holds if the address was the Turn Tracker's pending tool and not a task row.
  assert.equal(
    reading.result,
    'requested',
    `a tracker-matched request must be accepted (got ${reading.result})`,
  );
  assert.equal(reading.tableHasTask, false, 'the success arm must be accepted with no task in the table');
  assert.equal(reading.pendingMatches, true, 'the success arm must name the tracker pending tool');
}

function assertTaskAbsentBeforeEvent(reading: { beforeEvent: boolean; afterEvent: boolean }): void {
  assert.equal(reading.beforeEvent, false, 'the receipt must not write the task — it appears only from the event');
  assert.equal(reading.afterEvent, true, 'the backgrounded event must put the task in the table');
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
 * the `backgroundTasks` calls the driver places on it. The stream never ends on
 * its own, so the host stays live for the reading.
 */
function createResidentFixture(): {
  factory: ClaudeResidentProcessFactory;
  backgroundCalls: string[];
  finish(): void;
} {
  const backgroundCalls: string[] = [];
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
    backgroundTasks: async (toolUseId: string) => {
      backgroundCalls.push(toolUseId);
      return true;
    },
  };
  return {
    backgroundCalls,
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

test('the resident driver places backgroundTasks on the live query and leaves the process up', async () => {
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

    const placed = await driver.background(SESSION_ID, 'f-resident');

    const afterHost = manager.snapshot().find((host) => host.bindings.has(SESSION_ID));
    const reading = {
      placed,
      backgroundCalls: [...fixture.backgroundCalls],
      stateBefore: beforeHost?.state ?? null,
      stateAfter: afterHost?.state ?? null,
      sameHost: beforeHost?.hostId === afterHost?.hostId,
    };
    say(`(AC11 resident) ${JSON.stringify(reading)}`);
    assert.equal(reading.placed, true, 'a live resident process must be really asked');
    assert.deepEqual(
      reading.backgroundCalls,
      ['f-resident'],
      'the query backgroundTasks must receive the toolUseId string (never a no-arg call)',
    );
    assert.notEqual(reading.stateAfter, 'closed', 'background must not end the process');
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
/** A per-run query that never ends until interrupted, and records `backgroundTasks` calls. */
function createPerRunFixture(): {
  factory: () => ClaudeResidentQuery;
  backgroundCalls: string[];
} {
  const backgroundCalls: string[] = [];
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
    backgroundTasks: async (toolUseId: string) => {
      backgroundCalls.push(toolUseId);
      return true;
    },
  } as unknown as ClaudeResidentQuery;
  return { factory: () => query, backgroundCalls };
}

test('the per-run runtime places backgroundTasks on the live instance and does not end the run', async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-background-task-per-run-'));
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
    const user = userDb.createUser('background-task-per-run', 'unused-hash');
    claudeQueryFactory.current = (() => fixture.factory()) as unknown as typeof claudeQueryFactory.current;

    const appSessionId = PER_RUN_SESSION_ID;
    // The run is driven for real and left pending: its query's stream never ends,
    // which is what keeps the session registered in `activeSessions`.
    void queryClaudeSDK(
      'hold',
      { sessionId: appSessionId },
      { send: () => undefined, setSessionId: () => undefined, userId: Number(user.id) },
      RUNTIME_CONTEXT,
    );

    const registered = await waitFor(
      () => getActiveClaudeSDKSessions().includes(appSessionId),
      2_000,
      'the per-run session to register',
    );
    const placed = await backgroundClaudeSDKTask(appSessionId, 'f-per-run');
    const stillActive = getActiveClaudeSDKSessions().includes(appSessionId);

    say(`(AC11 per-run) registered=${registered} placed=${placed} backgroundCalls=${JSON.stringify(fixture.backgroundCalls)} stillActive=${stillActive}`);
    assert.equal(registered, true, 'the per-run run must register its session');
    assert.equal(placed, true, 'a live per-run instance must be really asked');
    assert.deepEqual(
      fixture.backgroundCalls,
      ['f-per-run'],
      'the instance backgroundTasks must receive the toolUseId string (never a no-arg call)',
    );
    assert.equal(stillActive, true, 'background must not remove the session or release its run');

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

// ---------------------------------- gateway capability + driver-call bounds --
/**
 * A provider whose resident driver is a recording double, so the gateway's
 * routing and its bound can be read without a live process.
 */
function createGatewayFixtures(): {
  driverBackground: string[];
  runtimeBackground: string[];
  residentDriver: AnyRecord;
  provider: AnyRecord;
  setDriverBehavior(behavior: 'resolve-true' | 'resolve-false' | 'reject' | 'hang'): void;
  setRuntimeBackground(fn: ((sessionId: string, toolUseId: string) => Promise<boolean>) | undefined): void;
} {
  const driverBackground: string[] = [];
  const runtimeBackground: string[] = [];
  let behavior: 'resolve-true' | 'resolve-false' | 'reject' | 'hang' = 'resolve-true';

  const residentDriver: AnyRecord = {
    run: async () => undefined,
    background: async (_sessionId: string, toolUseId: string) => {
      driverBackground.push(toolUseId);
      if (behavior === 'reject') {
        throw new Error('driver refused');
      }
      if (behavior === 'hang') {
        return new Promise<boolean>(() => undefined);
      }
      return behavior === 'resolve-true';
    },
  };

  let runtimeBackgroundFn: ((sessionId: string, toolUseId: string) => Promise<boolean>) | undefined = async (
    _sessionId: string,
    toolUseId: string,
  ) => {
    runtimeBackground.push(toolUseId);
    return true;
  };

  return {
    driverBackground,
    runtimeBackground,
    residentDriver,
    provider: {
      id: 'claude',
      hostDriver: residentDriver,
      get runtime() {
        return { run: async () => undefined, abort: async () => false, backgroundTask: runtimeBackgroundFn };
      },
    },
    setDriverBehavior(next) {
      behavior = next;
    },
    setRuntimeBackground(fn) {
      runtimeBackgroundFn = fn;
    },
  };
}

test('the gateway gates the resident verb on the capability and bounds the driver call', async () => {
  const fixtures = createGatewayFixtures();
  const gateway = (supported: boolean, mode: 'resident' | 'per-run') =>
    createProviderRuntimeService({
      resolveProvider: () => fixtures.provider as never,
      resolveSessionLifecycleMode: () => mode,
      residentBackgroundTaskSupported: () => supported,
      backgroundTaskCallTimeoutMs: 120,
    });

  // (AC10 false) The shipped capability is off: the answer is `unsupported` and
  // the driver is never touched.
  fixtures.driverBackground.length = 0;
  const gated = gateway(false, 'resident');
  const gatedOutcome = await gated.controlBackgroundTask('claude', SESSION_ID, 'f-gated');
  say(`(AC10 false) outcome=${gatedOutcome} driverCalls=${fixtures.driverBackground.length}`);
  assert.equal(gatedOutcome, 'unsupported');
  assert.equal(fixtures.driverBackground.length, 0, 'a disabled capability must not reach the driver');

  // (AC10 true / AC11 resident routing) With the verb on, the resident driver is
  // reached and its `true` passes through as `requested`.
  fixtures.driverBackground.length = 0;
  const enabled = gateway(true, 'resident');
  const enabledOutcome = await enabled.controlBackgroundTask('claude', SESSION_ID, 'f-enabled');
  say(`(AC10 true) outcome=${enabledOutcome} driverCalls=${JSON.stringify(fixtures.driverBackground)}`);
  assert.equal(enabledOutcome, 'requested');
  assert.deepEqual(fixtures.driverBackground, ['f-enabled']);

  // (AC8) A driver that settles `false` is `no-foreground-match`; a driver that
  // settles `true` is `requested`.
  fixtures.setDriverBehavior('resolve-false');
  const noMatchOutcome = await enabled.controlBackgroundTask('claude', SESSION_ID, 'f-nomatch');
  fixtures.setDriverBehavior('resolve-true');
  const requestedOutcome = await enabled.controlBackgroundTask('claude', SESSION_ID, 'f-match');
  say(`(AC8) false=${noMatchOutcome} true=${requestedOutcome}`);
  assert.equal(noMatchOutcome, 'no-foreground-match');
  assert.equal(requestedOutcome, 'requested');

  // (AC9) A throwing driver is `error`; a hanging one is `timeout` inside the bound.
  fixtures.setDriverBehavior('reject');
  const threwOutcome = await enabled.controlBackgroundTask('claude', SESSION_ID, 'f-throw');
  fixtures.setDriverBehavior('hang');
  const startedAt = Date.now();
  const hungOutcome = await enabled.controlBackgroundTask('claude', SESSION_ID, 'f-hang');
  const elapsedMs = Date.now() - startedAt;
  fixtures.setDriverBehavior('resolve-true');
  say(`(AC9) threw=${threwOutcome} hung=${hungOutcome} elapsedMs=${elapsedMs}`);
  assert.equal(threwOutcome, 'error');
  assert.equal(hungOutcome, 'timeout');
  assert.ok(elapsedMs < 1_000, `the bound must fire near its 120ms ceiling (elapsed=${elapsedMs}ms)`);

  // (AC11 per-run routing) A non-resident session goes through the per-run
  // runtime's own background verb instead.
  fixtures.runtimeBackground.length = 0;
  const perRun = gateway(true, 'per-run');
  const perRunOutcome = await perRun.controlBackgroundTask('claude', PER_RUN_SESSION_ID, 'f-per-run');
  say(`(AC11 per-run routing) outcome=${perRunOutcome} runtimeCalls=${JSON.stringify(fixtures.runtimeBackground)}`);
  assert.equal(perRunOutcome, 'requested');
  assert.deepEqual(fixtures.runtimeBackground, ['f-per-run']);

  // The positive control for the gate: a runtime with no background verb at all
  // lands no request.
  fixtures.runtimeBackground.length = 0;
  fixtures.setRuntimeBackground(undefined);
  const withoutVerb = await perRun.controlBackgroundTask('claude', PER_RUN_SESSION_ID, 'f-no-verb');
  say(`(AC10 control) noVerb=${withoutVerb}`);
  assert.equal(withoutVerb, 'unsupported');
});

// ------------------------------------- real application assembly, per-run ---
/*
 * The real `providerRuntimeService` the server mounts, reached through the real
 * `chat.background-task` handler, for a session whose per-run run is genuinely
 * live: the registry resolves the real `claude` provider, the gateway takes its
 * per-run branch, and `claudeRuntime.backgroundTask` reaches the live instance.
 * Only the process is scripted (no CLI is spawned); every seam between the socket
 * and the instance is the shipped one. This is the DoD's "reachable in the real
 * application assembly" reading.
 */
test('the real application assembly carries chat.background-task to a live per-run instance', async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-background-task-assembly-'));
  const savedHome = process.env.HOME;
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const savedFactory = claudeQueryFactory.current;
  const savedDatabasePath = process.env.DATABASE_PATH;
  const fixture = createPerRunFixture();
  const assemblySessionId = 'background-task-assembly-session';
  const reducer = createClaudeTaskReducer();
  const foregroundTool = 'toolu_assembly_foreground';
  const taskId = 'task_assembly_backgrounded';

  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
    process.env.HOME = tempDirectory;
    process.env.CLAUDE_CONFIG_DIR = tempDirectory;
    await initializeDatabase();
    // A real user row, so the run's own wind-down can read its notification
    // preferences without an FK failure (the SQLite foreign key is on user_id).
    const user = userDb.createUser('background-task-assembly', 'unused-hash');
    const now = new Date().toISOString();
    sessionsDb.createSession(assemblySessionId, 'claude', tempDirectory, 'Assembly session', now, now, null);

    claudeQueryFactory.current = (() => fixture.factory()) as unknown as typeof claudeQueryFactory.current;
    void queryClaudeSDK(
      'hold',
      { sessionId: assemblySessionId },
      { send: () => undefined, setSessionId: () => undefined, userId: Number(user.id) },
      RUNTIME_CONTEXT,
    );
    const registered = await waitFor(
      () => getActiveClaudeSDKSessions().includes(assemblySessionId),
      2_000,
      'the assembly per-run session to register',
    );

    // The real Turn Tracker holds the foreground tool the handler must address.
    feedForegroundToolUse(assemblySessionId, foregroundTool);
    const addressed = readSessionForegroundToolUseId(assemblySessionId);

    const socket = createFakeSocket();
    handleChatConnection(socket as never, { user: { id: 1 } } as never, {
      runtime: providerRuntimeService as never,
      getTask: (sessionId: string, taskIdToRead: string) => {
        const task = reducer.getTasks(sessionId).find((candidate) => candidate.taskId === taskIdToRead);
        return task ? { state: task.state } : null;
      },
    } as never);

    const receipt = await requestBackground(socket, {
      sessionId: assemblySessionId,
      toolUseId: foregroundTool,
      requestId: 'req-assembly',
    });
    const placed = await waitFor(() => fixture.backgroundCalls.length > 0, 1_000, 'the live instance to be asked');
    const beforeEvent = taskOf(reducer, assemblySessionId, taskId) !== null;
    reducer.observe(assemblySessionId, taskStartedFrame(assemblySessionId, taskId, foregroundTool));
    reducer.observe(assemblySessionId, taskBackgroundedFrame(assemblySessionId, taskId));
    const landed = taskOf(reducer, assemblySessionId, taskId);

    const reading = {
      registered,
      addressed,
      placed,
      backgroundCalls: [...fixture.backgroundCalls],
      result: typeof receipt?.result === 'string' ? receipt.result : 'no-receipt',
      requestId: typeof receipt?.requestId === 'string' ? receipt.requestId : null,
      beforeEvent,
      afterEvent: landed !== null,
      isBackgrounded: landed?.isBackgrounded ?? null,
      toolUseId: landed?.toolUseId ?? null,
    };
    say(`(assembly per-run) ${JSON.stringify(reading)}`);
    assert.equal(reading.registered, true);
    assert.equal(reading.addressed, foregroundTool, 'the real tracker must hold the foreground tool');
    assert.equal(reading.placed, true, 'the real gateway must reach the live per-run instance');
    assert.deepEqual(reading.backgroundCalls, [foregroundTool]);
    assert.equal(reading.result, 'requested');
    assert.equal(reading.requestId, 'req-assembly');
    assertTaskAbsentBeforeEvent({ beforeEvent: reading.beforeEvent, afterEvent: reading.afterEvent });
    assert.equal(reading.isBackgrounded, true);
    assert.equal(reading.toolUseId, foregroundTool);

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
