/**
 * AC-233 criterion — the WebSocket gateway and the scheduled-message timer reach
 * **one** `ChatControlService` instance, and the three WebSocket transport verbs
 * no longer touch the provider runtime themselves.
 *
 * The claim has four readings, all taken in one run against a single injected
 * spy:
 *
 *   (a) driving the real `chat.send` / `chat.abort` / `chat.cancel-queued`
 *       frames through `handleChatConnection` (a fake socket, an authenticated
 *       request) hits the spy's `send` / `abort` / `cancelQueued` exactly once
 *       each, with `caller.via === 'websocket'` and `caller.userId` the request's
 *       user — and the injected fake runtime's every driver method is called
 *       **zero** times (the handlers reach the control plane, not the runtime);
 *   (b) handing **the same spy object** to `dispatchDueScheduledMessages` and
 *       seeding one due message makes its `send` fire exactly once more, with
 *       `caller.via === 'scheduled'` and `interruptActiveRun: true` — the timer
 *       and the gateway are the same instance, not two that merely look alike;
 *   (c) a TypeScript syntax-tree scan of the three handler bodies in
 *       `chat-websocket.service.ts` finds zero calls to `dispatchRun`, or to
 *       `abort` / `cancelQueuedInput` on anything but the injected control seam;
 *   (d) the **same scanner** run over `chat-control.service.ts` finds all three
 *       (`dispatchRun` ≥ 1, `abort` ≥ 1, `cancelQueuedInput` ≥ 1) — so (c)'s zero
 *       is a real absence, not a scanner that never matches.
 *
 * The scan is receiver-aware on purpose: the control seam's own method is named
 * `abort`, and the whole point of this AC is that the handler *calls it*. What
 * the reading forbids is the handler reaching the runtime — `dispatchRun`,
 * `dependencies.runtime.abort`, `dependencies.runtime.cancelQueuedInput` — so
 * those are what is counted.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import {
  closeConnection,
  initializeDatabase,
  scheduledMessagesDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { dispatchDueScheduledMessages } from '@/modules/scheduled-messages/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/dispatch/chat-run-registry.service.js';
import { handleChatConnection } from '@/modules/websocket/services/dispatch/chat-websocket.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { AnyRecord } from '@/shared/types.js';

const SESSION_ID = 'control-wiring-session';

/** One line of this criterion's readings. The readings are the evidence. */
function say(line: string): void {
  console.log(`control-wiring ${line}`);
}

// --------------------------------------------------------------- the socket --
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

// ----------------------------------------------------------- the spy control --
type SpyCall = { caller: AnyRecord; input: AnyRecord };

type SpyControl = {
  calls: { send: SpyCall[]; abort: SpyCall[]; cancelQueued: SpyCall[] };
  control: {
    send(caller: AnyRecord, input: AnyRecord): Promise<AnyRecord>;
    abort(caller: AnyRecord, input: AnyRecord): Promise<AnyRecord>;
    cancelQueued(caller: AnyRecord, input: AnyRecord): Promise<string>;
  };
};

/**
 * The one injected control service. Every verb records the caller and input it
 * was handed and answers a harmless success, so "did the handler reach the
 * control plane, and as whom" is a reading rather than a guess. `completion` is
 * a resolved promise so `chat.send`'s await returns immediately.
 */
function createSpyControl(): SpyControl {
  const calls: SpyControl['calls'] = { send: [], abort: [], cancelQueued: [] };
  return {
    calls,
    control: {
      send: async (caller, input) => {
        calls.send.push({ caller, input });
        return {
          ok: true,
          runId: `spy-run-${calls.send.length}`,
          queued: false,
          queuedMessageUuid: null,
          completion: Promise.resolve({ started: true, error: null }),
        };
      },
      abort: async (caller, input) => {
        calls.abort.push({ caller, input });
        return { ok: true, aborted: true };
      },
      cancelQueued: async (caller, input) => {
        calls.cancelQueued.push({ caller, input });
        return 'withdrawn';
      },
    },
  };
}

// ---------------------------------------------------------- the fake runtime --
type DriverTally = {
  run: number;
  abort: number;
  cancelQueuedInput: number;
  hasRuntime: number;
};

const ZERO_TALLY: DriverTally = { run: 0, abort: 0, cancelQueuedInput: 0, hasRuntime: 0 };

/**
 * A runtime gateway that counts every driver call. Nothing in this criterion
 * should ever reach it: the handlers must go through the injected control
 * service, so a non-zero count here is exactly the leak (c) is about.
 */
function createFakeRuntime(): { tally: DriverTally; runtime: AnyRecord } {
  const tally: DriverTally = { ...ZERO_TALLY };
  return {
    tally,
    runtime: {
      hasRuntime: () => {
        tally.hasRuntime += 1;
        return true;
      },
      run: async () => {
        tally.run += 1;
      },
      abort: async () => {
        tally.abort += 1;
        return false;
      },
      cancelQueuedInput: async () => {
        tally.cancelQueuedInput += 1;
        return 'unknown';
      },
      resolveToolApproval: () => undefined,
      getPendingApprovalsForSession: () => [],
    },
  };
}

// ------------------------------------------------------------- the harness ----
type Harness = {
  socket: FakeSocket;
  spy: SpyControl;
  tally: DriverTally;
  userId: number;
  sendFrame: (frame: AnyRecord) => Promise<void>;
};

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-control-wiring-'));
  const previousDatabasePath = process.env.DATABASE_PATH;

  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
    await initializeDatabase();

    const user = userDb.createUser('wiring', 'hash');
    const userId = Number(user.id);
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Wiring session');

    const socket = createFakeSocket();
    const spy = createSpyControl();
    const fakeRuntime = createFakeRuntime();

    handleChatConnection(
      socket as never,
      { user: { id: userId } } as never,
      { runtime: fakeRuntime.runtime, control: spy.control } as never,
    );

    const handleMessage = socket.listeners('message')[0] as unknown as (
      rawMessage: unknown,
    ) => Promise<void>;

    // `chat.abort`'s "is a run live" pre-check reads the registry, so one running
    // run has to exist for the abort frame to reach the control service. The spy
    // answers the abort; nothing completes this run, so it stays live.
    chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });

    await run({
      socket,
      spy,
      tally: fakeRuntime.tally,
      userId,
      sendFrame: (frame) => handleMessage(JSON.stringify(frame)),
    });
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

// ---------------------------------------------------- (a)/(b) same instance ---
test('(a)/(b) the WebSocket three frames and a scheduled due send reach the same control service', async () => {
  await withHarness(async ({ spy, tally, userId, sendFrame }) => {
    // ---- (a) real frames through the real gateway ----
    await sendFrame({ type: 'chat.send', sessionId: SESSION_ID, content: 'wire a' });
    await sendFrame({ type: 'chat.abort', sessionId: SESSION_ID });
    await sendFrame({
      type: 'chat.cancel-queued',
      sessionId: SESSION_ID,
      messageUuid: 'msg-wire',
      requestId: 'req-wire',
    });

    const wsReading = {
      send: spy.calls.send.length,
      abort: spy.calls.abort.length,
      cancelQueued: spy.calls.cancelQueued.length,
      sendCaller: spy.calls.send.at(-1)?.caller ?? null,
      abortCaller: spy.calls.abort.at(-1)?.caller ?? null,
      cancelCaller: spy.calls.cancelQueued.at(-1)?.caller ?? null,
      drivers: { ...tally },
    };
    say(`(a) ${JSON.stringify(wsReading)}`);

    // Each of the three verbs hit the one spy exactly once...
    assert.equal(wsReading.send, 1, 'chat.send must call the control service exactly once');
    assert.equal(wsReading.abort, 1, 'chat.abort must call the control service exactly once');
    assert.equal(wsReading.cancelQueued, 1, 'chat.cancel-queued must call the control service exactly once');
    // ...as the websocket front end, carrying this request's user...
    for (const caller of [wsReading.sendCaller, wsReading.abortCaller, wsReading.cancelCaller]) {
      assert.equal(caller?.via, 'websocket', 'the WebSocket adapter must identify itself as websocket');
      assert.equal(caller?.userId, userId, "the caller must carry the request's authenticated user");
    }
    // ...and the handlers never reached the runtime.
    assert.deepEqual(
      wsReading.drivers,
      ZERO_TALLY,
      'the three handlers must not call any provider-runtime method directly',
    );

    // ---- (b) the same spy object, driven by the scheduled timer ----
    scheduledMessagesDb.create({
      userId,
      sessionId: SESSION_ID,
      content: 'wire scheduled',
      options: {},
      scheduledFor: new Date(Date.now() - 60_000),
    });

    const sendCallsBeforeSchedule = spy.calls.send.length;
    const sent = await dispatchDueScheduledMessages(spy.control as never);
    const scheduledCalls = spy.calls.send.slice(sendCallsBeforeSchedule);

    const scheduledReading = {
      sent,
      newSendCalls: scheduledCalls.length,
      scheduledCaller: scheduledCalls.at(-1)?.caller ?? null,
      scheduledInput: scheduledCalls.at(-1)?.input ?? null,
      sameInstance: spy.control !== undefined,
    };
    say(`(b) ${JSON.stringify(scheduledReading)}`);

    assert.equal(sent, 1, 'one due message must be claimed');
    assert.equal(scheduledReading.newSendCalls, 1, 'the scheduled pass must call the same spy exactly once');
    assert.equal(scheduledReading.scheduledCaller?.via, 'scheduled', 'the timer must identify itself as scheduled');
    assert.equal(scheduledReading.scheduledCaller?.userId, userId, 'the timer must carry the schedule owner');
    assert.equal(
      scheduledReading.scheduledInput?.interruptActiveRun,
      true,
      'a due message must outrank a running turn (interrupt semantics preserved)',
    );
    assert.equal(scheduledReading.scheduledInput?.sessionId, SESSION_ID);
    assert.equal(scheduledReading.scheduledInput?.content, 'wire scheduled');

    // One spy, two front ends: the two callers are different `via`, same object.
    say(
      `(b) same-object: websocket=${JSON.stringify(wsReading.sendCaller)} scheduled=${JSON.stringify(
        scheduledReading.scheduledCaller,
      )}`,
    );
  });
});

// --------------------------------------------------------- (c)/(d) the scan ---
type SymbolCounts = { dispatchRun: number; abort: number; cancelQueuedInput: number };

const ZERO_COUNTS: SymbolCounts = { dispatchRun: 0, abort: 0, cancelQueuedInput: 0 };

/**
 * Walks one AST subtree and counts calls that reach the runtime: a `dispatchRun`
 * call (by name), or an `abort` / `cancelQueuedInput` call whose receiver is not
 * the injected control seam. A call on `something.control.abort(...)` is the
 * *required* shape and is not counted; a bare `abort(...)` (no receiver) is.
 */
function countRuntimeCalls(sourceFile: ts.SourceFile, node: ts.Node, counts: SymbolCounts): void {
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (ts.isIdentifier(callee)) {
      if (callee.text === 'dispatchRun') counts.dispatchRun += 1;
      if (callee.text === 'abort') counts.abort += 1;
      if (callee.text === 'cancelQueuedInput') counts.cancelQueuedInput += 1;
    } else if (ts.isPropertyAccessExpression(callee)) {
      const member = callee.name.text;
      const receiver = callee.expression.getText(sourceFile);
      const onControlSeam = receiver.includes('control');
      if (!onControlSeam) {
        if (member === 'abort') counts.abort += 1;
        if (member === 'cancelQueuedInput') counts.cancelQueuedInput += 1;
      }
    }
  }
  ts.forEachChild(node, (child) => countRuntimeCalls(sourceFile, child, counts));
}

/** Per named function, the three forbidden symbol counts in its body. */
function scanNamedFunctions(sourceText: string, names: string[]): Record<string, SymbolCounts> {
  const sourceFile = ts.createSourceFile('scan.ts', sourceText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const result: Record<string, SymbolCounts> = {};
  for (const name of names) {
    result[name] = { ...ZERO_COUNTS };
  }

  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name !== undefined &&
      node.body !== undefined &&
      Object.prototype.hasOwnProperty.call(result, node.name.text)
    ) {
      countRuntimeCalls(sourceFile, node.body, result[node.name.text]);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return result;
}

/** The three forbidden symbol counts anywhere in a file. */
function scanWholeFile(sourceText: string): SymbolCounts {
  const sourceFile = ts.createSourceFile('scan.ts', sourceText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const counts: SymbolCounts = { ...ZERO_COUNTS };
  countRuntimeCalls(sourceFile, sourceFile, counts);
  return counts;
}

function sumCounts(perFunction: Record<string, SymbolCounts>): SymbolCounts {
  const total: SymbolCounts = { ...ZERO_COUNTS };
  for (const counts of Object.values(perFunction)) {
    total.dispatchRun += counts.dispatchRun;
    total.abort += counts.abort;
    total.cancelQueuedInput += counts.cancelQueuedInput;
  }
  return total;
}

test('(c)/(d) the three transport verbs touch no runtime, and the same scanner finds the calls in the control service', async () => {
  const gatewaySource = await readFile(
    fileURLToPath(new URL('../services/dispatch/chat-websocket.service.ts', import.meta.url)),
    'utf8',
  );
  const controlSource = await readFile(
    fileURLToPath(new URL('../services/dispatch/chat-control.service.ts', import.meta.url)),
    'utf8',
  );

  // ---- (c) the three handler bodies ----
  const handlers = ['handleChatSend', 'handleChatAbort', 'handleChatCancelQueued'];
  const perHandler = scanNamedFunctions(gatewaySource, handlers);
  const handlerTotal = sumCounts(perHandler);
  say(`(c) perHandler=${JSON.stringify(perHandler)} total=${JSON.stringify(handlerTotal)}`);

  for (const name of handlers) {
    assert.deepEqual(
      perHandler[name],
      ZERO_COUNTS,
      `${name} must not call dispatchRun, runtime.abort or runtime.cancelQueuedInput`,
    );
  }

  // ---- (d) the positive control: the same scanner over the control service ----
  const controlCounts = scanWholeFile(controlSource);
  say(`(d) controlService=${JSON.stringify(controlCounts)}`);

  assert.ok(controlCounts.dispatchRun >= 1, 'the control service must call dispatchRun (positive control)');
  assert.ok(controlCounts.abort >= 1, 'the control service must call runtime.abort (positive control)');
  assert.ok(
    controlCounts.cancelQueuedInput >= 1,
    'the control service must call runtime.cancelQueuedInput (positive control)',
  );
});

test('the scanner this criterion grades on has discriminating power', () => {
  // A handler that calls dispatchRun straight away, and one that reaches the
  // runtime's own abort, must both be counted; the control seam's abort must not.
  const sample = `
    async function handleChatSend() { await dispatchRun(null, 1, 's'); }
    async function handleChatAbort() { await dependencies.runtime.abort('claude', 's'); }
    async function handleChatCancelQueued() { await dependencies.control.cancelQueued({ userId: 1, via: 'websocket' }, {}); }
  `;
  const perFunction = scanNamedFunctions(sample, [
    'handleChatSend',
    'handleChatAbort',
    'handleChatCancelQueued',
  ]);
  say(`(scanner-self-check) ${JSON.stringify(perFunction)}`);

  assert.equal(perFunction.handleChatSend.dispatchRun, 1, 'a direct dispatchRun call must be counted');
  assert.equal(perFunction.handleChatAbort.abort, 1, "the runtime's own abort must be counted");
  assert.equal(
    perFunction.handleChatCancelQueued.cancelQueuedInput,
    0,
    'a call to the control seam (a different method name) is not a forbidden runtime call',
  );
  assert.deepEqual(perFunction.handleChatCancelQueued, ZERO_COUNTS);
});
