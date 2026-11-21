/**
 * AC-198 criterion — the single ownership entry three control verbs share, and
 * `chat.cancel-queued`'s rework onto it.
 *
 * The claim has two halves.
 *
 *  1. `chat.cancel-queued` now carries request correlation and ownership, the
 *     same discipline its two control siblings already had: `requestId` is a
 *     required field, the receipt echoes it, and a request that does not belong
 *     to the session is answered `forbidden` **without the provider's queue ever
 *     being asked**. The receipt kind stays `queued_input_cancel_result` — the
 *     frontend drops that kind as a control frame, and changing it would make
 *     the client append the refusal as an ordinary message.
 *
 *  2. All three verbs (`chat.stop-task`, `chat.background-task`,
 *     `chat.cancel-queued`) go through **one** access entry, injected through
 *     `ChatWebSocketDependencies.assertSessionAccess`. A counting spy proves
 *     each verb hits exactly that entry exactly once; a real mismatch arm — a
 *     socket with no authenticated user, checked by the production entry —
 *     proves all three refuse and reach no driver.
 *
 * What is proven, and on which reading:
 *   (AC2) a withdrawal with no `requestId` is a protocol error that places
 *         nothing;
 *   (AC3) an authenticated withdrawal reaches the queue, and the receipt echoes
 *         the `requestId` that was sent;
 *   (AC4) a withdrawal from an unauthenticated socket — read by the production
 *         entry, with no injected override — is `forbidden`, and
 *         `cancelQueuedInput` is never called;
 *   (AC5) driving the three verbs through one injected counting spy shows each
 *         hitting that one entry exactly once, and the same three verbs from an
 *         unauthenticated socket all answer `forbidden` with every driver at
 *         zero calls.
 *
 * The readings run on the real `handleChatConnection` gateway with a fake socket
 * and an injected runtime stub — the harness `chat-edit-send.test.ts` uses —
 * never on a pure function of the entry. Each named reading is also driven by a
 * fake form, to show the assertion has discriminating power rather than passing
 * on any shape.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
// Imported from the service file rather than the module barrel: `assertSessionAccess`
// is the shared entry and lives on the service.
import {
  assertSessionAccess,
  handleChatConnection,
} from '@/modules/websocket/services/dispatch/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/dispatch/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { AnyRecord } from '@/shared/types.js';

const SESSION_ID = 'control-ownership-session';

/** One line of this criterion's readings. The readings are the evidence. */
function say(line: string): void {
  console.log(`control-ownership ${line}`);
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
  console.log(`control-ownership waitFor timed out: ${label}`);
  return false;
}

// --------------------------------------------------------- the runtime stub --
type StubRuntime = {
  calls: {
    cancel: Array<{ provider: string; sessionId: string; messageUuid: string }>;
    stop: Array<{ provider: string; sessionId: string; taskId: string }>;
    background: Array<{ provider: string; sessionId: string; toolUseId: string }>;
  };
  runtime: AnyRecord;
};

/**
 * A runtime gateway that records every driver call and answers `withdrawn` /
 * `requested`, so "was the driver reached?" is a count and never a guess.
 */
function createStubRuntime(): StubRuntime {
  const calls: StubRuntime['calls'] = { cancel: [], stop: [], background: [] };
  return {
    calls,
    runtime: {
      hasRuntime: () => true,
      run: async () => undefined,
      abort: async () => false,
      cancelQueuedInput: async (provider: string, sessionId: string, messageUuid: string) => {
        calls.cancel.push({ provider, sessionId, messageUuid });
        return 'withdrawn';
      },
      controlStopTask: async (provider: string, sessionId: string, taskId: string) => {
        calls.stop.push({ provider, sessionId, taskId });
        return 'requested';
      },
      controlBackgroundTask: async (provider: string, sessionId: string, toolUseId: string) => {
        calls.background.push({ provider, sessionId, toolUseId });
        return 'requested';
      },
      resolveToolApproval: () => undefined,
      getPendingApprovalsForSession: () => [],
    },
  };
}

type Harness = {
  runtime: StubRuntime;
  /** A socket with an authenticated user, sharing the harness deps. */
  connect(): FakeSocket;
  /** A socket with no authenticated user, for the ownership readings. */
  connectAnonymous(): FakeSocket;
};

/**
 * Boots the real chat gateway against an isolated database with one session row
 * and the stub runtime. `options.assertSessionAccess`, when given, is injected
 * as the deps' access seam — otherwise the production default runs.
 */
async function withHarness(
  options: { assertSessionAccess?: (userId: unknown, session: unknown) => boolean },
  run: (harness: Harness) => Promise<void>,
): Promise<void> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-control-ownership-'));
  const previousDatabasePath = process.env.DATABASE_PATH;

  try {
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
    await initializeDatabase();

    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', tempDirectory, 'Control session', now, now, null);

    const runtime = createStubRuntime();
    const dependencies: AnyRecord = { runtime: runtime.runtime };
    if (options.assertSessionAccess) {
      dependencies.assertSessionAccess = options.assertSessionAccess;
    }

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
      runtime,
      connect: () => connect({ id: 1 }),
      connectAnonymous: () => connect(null),
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

// ------------------------------------------------------------ frame helpers --
/** Sends one `chat.cancel-queued` and returns the `queued_input_cancel_result` it produced. */
async function requestCancel(socket: FakeSocket, payload: AnyRecord): Promise<AnyRecord | null> {
  const before = socket.frames.length;
  socket.emit('message', JSON.stringify({ type: 'chat.cancel-queued', ...payload }));
  await waitFor(
    () => socket.frames.slice(before).some((frame) => frame.kind === 'queued_input_cancel_result'),
    1_000,
    `a queued_input_cancel_result for ${JSON.stringify(payload)}`,
  );
  return socket.frames.slice(before).find((frame) => frame.kind === 'queued_input_cancel_result') ?? null;
}

/** Sends one of the two `control_result` verbs and returns the receipt it produced. */
async function requestControl(
  socket: FakeSocket,
  type: 'chat.stop-task' | 'chat.background-task',
  payload: AnyRecord,
): Promise<AnyRecord | null> {
  const before = socket.frames.length;
  socket.emit('message', JSON.stringify({ type, ...payload }));
  await waitFor(
    () => socket.frames.slice(before).some((frame) => frame.kind === 'control_result'),
    1_000,
    `a control_result for ${type}`,
  );
  return socket.frames.slice(before).find((frame) => frame.kind === 'control_result') ?? null;
}

/** The protocol error code one frame produced, if any. */
function errorCode(socket: FakeSocket, from: number): string | null {
  const frame = socket.frames.slice(from).find((candidate) => candidate.kind === 'protocol_error');
  return typeof frame?.code === 'string' ? frame.code : null;
}

// -------------------------------------------------------- AC2/AC3/AC4 --------
test('chat.cancel-queued echoes the requestId and refuses a non-owner without touching the queue', async () => {
  await withHarness({}, async ({ runtime, connect, connectAnonymous }) => {
    // ---- AC3: an authenticated withdrawal reaches the queue and the receipt
    // echoes the requestId the caller sent. ----
    const owner = connect();
    const ownerRequestId = randomUUID();
    const granted = await requestCancel(owner, {
      sessionId: SESSION_ID,
      messageUuid: 'msg-owned',
      requestId: ownerRequestId,
    });
    say(`(AC3) granted=${JSON.stringify({
      kind: granted?.kind,
      requestId: granted?.requestId,
      messageUuid: granted?.messageUuid,
      result: granted?.result,
      driverCalls: runtime.calls.cancel.length,
    })}`);
    assertReceiptEchoesRequestId({ sent: ownerRequestId, echoed: granted?.requestId });
    assert.equal(granted?.kind, 'queued_input_cancel_result', 'the receipt kind the client drops must stay');
    assert.equal(granted?.messageUuid, 'msg-owned');
    assert.equal(granted?.result, 'withdrawn');
    assert.deepEqual(runtime.calls.cancel, [
      { provider: 'claude', sessionId: SESSION_ID, messageUuid: 'msg-owned' },
    ]);

    // ---- AC4: a request from a socket with no authenticated user is `forbidden`
    // through the PRODUCTION entry (this harness injected no override), and the
    // queue is never asked. This is a real mismatch, not a stub returning false. ----
    const anon = connectAnonymous();
    const anonRequestId = randomUUID();
    const beforeDenied = runtime.calls.cancel.length;
    const denied = await requestCancel(anon, {
      sessionId: SESSION_ID,
      messageUuid: 'msg-not-owned',
      requestId: anonRequestId,
    });
    const deniedReading = {
      result: typeof denied?.result === 'string' ? denied.result : 'no-receipt',
      requestId: typeof denied?.requestId === 'string' ? denied.requestId : null,
      driverCalls: runtime.calls.cancel.length - beforeDenied,
    };
    say(`(AC4) denied=${JSON.stringify(deniedReading)}`);
    assertForbiddenPlacesNothing(deniedReading);
    assert.equal(denied?.requestId, anonRequestId, 'the refusal must echo the requestId too');

    // ---- AC2: a missing requestId is a protocol error and places nothing. ----
    const afterForbidden = runtime.calls.cancel.length;
    const missingFrom = owner.frames.length;
    owner.emit('message', JSON.stringify({
      type: 'chat.cancel-queued',
      sessionId: SESSION_ID,
      messageUuid: 'msg-no-request-id',
    }));
    await waitFor(() => owner.frames.length > missingFrom, 500, 'a refusal for a missing requestId');
    const missingCode = errorCode(owner, missingFrom);
    say(`(AC2) missingRequestIdCode=${missingCode} driverCalls=${runtime.calls.cancel.length}`);
    assert.equal(missingCode, 'REQUEST_ID_REQUIRED');
    assert.equal(runtime.calls.cancel.length, afterForbidden, 'a missing field must not reach the driver');
    // The two earlier errors keep their own codes.
    const sessionMissingFrom = owner.frames.length;
    owner.emit('message', JSON.stringify({ type: 'chat.cancel-queued', messageUuid: 'm', requestId: 'r' }));
    await waitFor(() => owner.frames.length > sessionMissingFrom, 500, 'a refusal for a missing sessionId');
    assert.equal(errorCode(owner, sessionMissingFrom), 'SESSION_ID_REQUIRED');

    // ---- AC7 (fake form): a handler that skips the ownership check answers the
    // withdrawal and reaches the queue. The forbidden reading above must red on it. ----
    assert.throws(
      () => assertForbiddenPlacesNothing({ result: 'withdrawn', requestId: anonRequestId, driverCalls: 1 }),
      /must answer forbidden/,
      'fake (no-ownership) must red the forbidden reading',
    );
    console.log('[readings] fake no-ownership: red');
  });
});

// --------------------------------------------------------------- AC5 ---------
test('chat.stop-task, chat.background-task and chat.cancel-queued share one ownership entry', async () => {
  // The counting spy: delegates to the production entry (so its verdict is the
  // real one) and records every call, so the three verbs can be shown to hit the
  // SAME function exactly once each.
  const entryCalls: Array<{ userId: unknown; sessionId: unknown }> = [];
  await withHarness(
    {
      assertSessionAccess: (userId, session) => {
        entryCalls.push({
          userId,
          sessionId: (session as AnyRecord | null)?.session_id ?? null,
        });
        return assertSessionAccess(userId as never, session as never);
      },
    },
    async ({ runtime, connect }) => {
      const socket = connect();

      const stop = await requestControl(socket, 'chat.stop-task', {
        sessionId: SESSION_ID,
        taskId: 't-shared',
        requestId: randomUUID(),
      });
      const afterStop = entryCalls.length;

      const background = await requestControl(socket, 'chat.background-task', {
        sessionId: SESSION_ID,
        toolUseId: 'toolu-shared',
        requestId: randomUUID(),
      });
      const afterBackground = entryCalls.length;

      const cancel = await requestCancel(socket, {
        sessionId: SESSION_ID,
        messageUuid: 'msg-shared',
        requestId: randomUUID(),
      });
      const afterCancel = entryCalls.length;

      const reading = {
        stopCalls: afterStop,
        backgroundCalls: afterBackground - afterStop,
        cancelCalls: afterCancel - afterBackground,
        total: afterCancel,
        sessionIds: entryCalls.map((call) => call.sessionId),
        results: {
          stop: stop?.result ?? null,
          background: background?.result ?? null,
          cancel: cancel?.result ?? null,
        },
      };
      say(`(AC5) ${JSON.stringify(reading)}`);

      // Each verb reached the one entry exactly once...
      assert.equal(reading.stopCalls, 1, 'chat.stop-task must go through the shared entry exactly once');
      assert.equal(reading.backgroundCalls, 1, 'chat.background-task must go through the shared entry exactly once');
      assert.equal(reading.cancelCalls, 1, 'chat.cancel-queued must go through the shared entry exactly once');
      assert.equal(reading.total, 3, 'exactly three checks — one per verb');
      // ...carrying this session (so the three calls are the verbs' own checks)...
      assert.deepEqual(reading.sessionIds, [SESSION_ID, SESSION_ID, SESSION_ID]);
      // ...and the authenticated sockets then proceeded past the check (each to
      // its own next stage), which is what makes the check the entry rather than
      // a blanket refusal.
      assert.deepEqual(reading.results, {
        stop: 'unknown-task',
        background: 'no-foreground-match',
        cancel: 'withdrawn',
      });
    },
  );
});

test('all three verbs refuse a non-owner through the one entry, reaching no driver', async () => {
  const entryCalls: unknown[] = [];
  await withHarness(
    {
      // Delegates to production: the refusal below is the real ownership answer
      // (no authenticated user), not a hardcoded `false`.
      assertSessionAccess: (userId, session) => {
        entryCalls.push(userId);
        return assertSessionAccess(userId as never, session as never);
      },
    },
    async ({ runtime, connectAnonymous }) => {
      const anon = connectAnonymous();

      const stop = await requestControl(anon, 'chat.stop-task', {
        sessionId: SESSION_ID,
        taskId: 't-foreign',
        requestId: randomUUID(),
      });
      const background = await requestControl(anon, 'chat.background-task', {
        sessionId: SESSION_ID,
        toolUseId: 'toolu-foreign',
        requestId: randomUUID(),
      });
      const cancel = await requestCancel(anon, {
        sessionId: SESSION_ID,
        messageUuid: 'msg-foreign',
        requestId: randomUUID(),
      });

      const reading = {
        results: {
          stop: stop?.result ?? null,
          background: background?.result ?? null,
          cancel: cancel?.result ?? null,
        },
        entryCalls: entryCalls.length,
        drivers: {
          stop: runtime.calls.stop.length,
          background: runtime.calls.background.length,
          cancel: runtime.calls.cancel.length,
        },
      };
      say(`(AC5) forbidden=${JSON.stringify(reading)}`);

      assert.deepEqual(reading.results, {
        stop: 'forbidden',
        background: 'forbidden',
        cancel: 'forbidden',
      });
      assert.equal(reading.entryCalls, 3, 'all three verbs must pass through the one entry');
      assert.deepEqual(
        reading.drivers,
        { stop: 0, background: 0, cancel: 0 },
        'a forbidden request must reach no driver',
      );
    },
  );
});

// ------------------------------------------------------- named readings ------
/*
 * Each is the assertion its AC is graded on, written once so a fake form can
 * drive the SAME function the real arm drove — a fake form that passed would be
 * a hole in the reading, not a valid mutant.
 */
function assertForbiddenPlacesNothing(reading: {
  result: string;
  requestId: string | null;
  driverCalls: number;
}): void {
  assert.equal(reading.result, 'forbidden', `an unauthorized request must answer forbidden (got ${reading.result})`);
  assert.equal(reading.driverCalls, 0, 'a forbidden request must place no withdrawal');
}

function assertReceiptEchoesRequestId(reading: { sent: string; echoed: unknown }): void {
  assert.equal(reading.echoed, reading.sent, 'the receipt must echo the requestId that was sent');
}

test('the named readings have discriminating power', () => {
  // A receipt that dropped the requestId must red the echo reading.
  assert.throws(
    () => assertReceiptEchoesRequestId({ sent: 'req-sent', echoed: null }),
    /must echo the requestId/,
    'a receipt without the requestId must red the echo reading',
  );
  // A forbidden receipt that still placed the withdrawal must red the reading.
  assert.throws(
    () => assertForbiddenPlacesNothing({ result: 'forbidden', requestId: 'r', driverCalls: 1 }),
    /place no withdrawal/,
    'a forbidden request that reached the driver must red the reading',
  );
  console.log('[readings] requestId echo + forbidden placement: discriminating');
});
