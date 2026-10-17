import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { ChatRunSource } from '@/shared/types.js';

/**
 * Exhaustive fixture over `ChatRunSource`.
 *
 * A `Record<ChatRunSource, true>` is deliberately used instead of an array so
 * that adding a value to the union without updating this fixture is a `tsc`
 * error — the coverage of the test below is guaranteed by the compiler rather
 * than by whoever remembers to extend the list.
 */
const ALL_CHAT_RUN_SOURCES: Record<ChatRunSource, true> = {
  user: true,
  scheduled: true,
  unattended: true,
  mcp: true,
  voice: true,
};

/**
 * Minimal stand-in for a websocket connection: collects every JSON frame the
 * gateway writer forwards so assertions can inspect the outbound protocol.
 */
class FakeConnection {
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

/** A socket the chat gateway can drive: an EventEmitter with the `ws` surface. */
function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: Array<Record<string, unknown>>;
    send: (data: string) => void;
  };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  return socket;
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-run-registry-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
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

test('live events are remapped to the app session id and sequenced', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-1', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-1',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: 'user-1',
    });
    assert.ok(run);

    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'provider-id-9', content: 'hello' });
    run.writer.send({ kind: 'text', provider: 'claude', sessionId: 'provider-id-9', content: 'hello world' });

    assert.equal(connection.frames.length, 2);
    assert.equal(connection.frames[0]?.sessionId, 'app-run-1');
    assert.equal(connection.frames[0]?.seq, 1);
    assert.equal(connection.frames[1]?.sessionId, 'app-run-1');
    assert.equal(connection.frames[1]?.seq, 2);
  });
});

test('every ChatRunSource value round-trips through startRun', async () => {
  await withIsolatedDatabase(() => {
    const values = Object.keys(ALL_CHAT_RUN_SOURCES) as ChatRunSource[];
    // Guard the loop against silently covering nothing: the fixture is the
    // compiler-checked set, and this asserts its shape at runtime too.
    assert.deepEqual([...values].sort(), ['mcp', 'scheduled', 'unattended', 'user', 'voice']);

    for (const value of values) {
      const appSessionId = `app-source-${value}`;
      sessionsDb.createAppSession(appSessionId, 'claude', '/workspace/demo');
      const run = chatRunRegistry.startRun({
        appSessionId,
        provider: 'claude',
        providerSessionId: null,
        connection: new FakeConnection(),
        userId: null,
        source: value,
      });
      assert.ok(run, `startRun must register ${value}`);
      // Each value is read back as itself — a run that ignored the explicit
      // source and fell back to the connection default would red here for every
      // value except `user`.
      assert.equal(run.source, value);
    }
  });
});

test('session_created is swallowed and persisted as the provider-id mapping', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-run-2', 'cursor', '/workspace/demo');
    const connection = new FakeConnection();
    connectedClients.add(connection as never);
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-2',
      provider: 'cursor',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({
      kind: 'session_created',
      provider: 'cursor',
      sessionId: 'cursor-native-7',
      newSessionId: 'cursor-native-7',
    });

    // The upsert is broadcast without blocking the run: resolving the owning
    // project's display name is async, so let that settle before asserting.
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    // The provider-native event itself is never forwarded...
    const sessionUpserts = connection.frames.filter((frame) => frame.kind === 'session_upserted');
    assert.equal(sessionUpserts.length, 1);
    assert.equal(sessionUpserts[0]?.sessionId, 'app-run-2');
    assert.equal(sessionUpserts[0]?.providerSessionId, 'cursor-native-7');
    // ...but the canonical mapping is recorded and persisted in the database.
    assert.equal(run.providerSessionId, 'cursor-native-7');
    assert.equal(sessionsDb.getSessionById('app-run-2')?.provider_session_id, 'cursor-native-7');
  });
});

test('complete marks the run finished and duplicate completes are dropped', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-3', 'codex', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-3',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native-3', exitCode: 0 });
    // Late duplicate from a killed runtime's exit handler.
    run.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native-3', exitCode: 1 });

    const completes = connection.frames.filter((frame) => frame.kind === 'complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0]?.actualSessionId, 'app-run-3');
    assert.equal(chatRunRegistry.isProcessing('app-run-3'), false);

    // completeRun is also a no-op once the run already completed.
    chatRunRegistry.completeRun('app-run-3', { exitCode: 1 });
    assert.equal(connection.frames.filter((frame) => frame.kind === 'complete').length, 1);
  });
});

test('a finished run\'s safety net cannot complete the session\'s next run', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-9', 'codex', '/workspace/demo');
    const connection = new FakeConnection();

    const firstRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-9',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(firstRun);
    firstRun.writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native-9', exitCode: 0 });

    // A queued message starts the next run before the first run's runtime
    // promise settles (the chat handler's `finally` hasn't executed yet).
    const secondRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-9',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(secondRun);

    // First run's safety net fires late: it must not touch the new run.
    chatRunRegistry.completeRunIfCurrent(firstRun, { exitCode: 1 });
    assert.equal(chatRunRegistry.isProcessing('app-run-9'), true);
    assert.equal(connection.frames.filter((frame) => frame.kind === 'complete').length, 1);

    // The second run's own safety net still works while it is current.
    chatRunRegistry.completeRunIfCurrent(secondRun, { exitCode: 1 });
    assert.equal(chatRunRegistry.isProcessing('app-run-9'), false);
    assert.equal(connection.frames.filter((frame) => frame.kind === 'complete').length, 2);
  });
});

test('listRunningRuns returns only currently running app sessions', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-7', 'claude', '/workspace/demo');
    sessionsDb.createAppSession('app-run-8', 'codex', '/workspace/demo');
    const connection = new FakeConnection();

    const completedRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-7',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(completedRun);

    const runningRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-8',
      provider: 'codex',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(runningRun);

    chatRunRegistry.completeRun('app-run-7', { exitCode: 0 });

    const runningSessions = chatRunRegistry.listRunningRuns();
    assert.deepEqual(runningSessions.map((session) => session.sessionId), ['app-run-8']);
    assert.equal(runningSessions[0]?.provider, 'codex');
  });
});

test('replayEvents returns only events after the requested seq', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-4', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-4',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'a' });
    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'b' });
    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'x', content: 'c' });

    const replayed = chatRunRegistry.replayEvents('app-run-4', 1);
    assert.deepEqual(replayed.map((event) => event.content), ['b', 'c']);
    assert.deepEqual(replayed.map((event) => event.seq), [2, 3]);
  });
});

test('attachConnection adds a socket without cutting off the ones already watching', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-5', 'opencode', '/workspace/demo');
    const firstConnection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-5',
      provider: 'opencode',
      providerSessionId: null,
      connection: firstConnection,
      userId: null,
    });
    assert.ok(run);

    run.writer.send({ kind: 'stream_delta', provider: 'opencode', sessionId: 'o', content: 'before' });

    // A second tab on the same session subscribes mid-run.
    const secondConnection = new FakeConnection();
    assert.equal(chatRunRegistry.attachConnection('app-run-5', secondConnection), true);
    run.writer.send({ kind: 'stream_delta', provider: 'opencode', sessionId: 'o', content: 'after' });

    assert.deepEqual(firstConnection.frames.map((frame) => frame.content), ['before', 'after']);
    assert.deepEqual(secondConnection.frames.map((frame) => frame.content), ['after']);
  });
});

test('a refreshed tab stops receiving once its old socket is closed', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-5b', 'opencode', '/workspace/demo');
    const staleConnection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-5b',
      provider: 'opencode',
      providerSessionId: null,
      connection: staleConnection,
      userId: null,
    });
    assert.ok(run);

    // The page reloads: the original socket closes and the fresh one subscribes.
    staleConnection.readyState = 3;
    const reloadedConnection = new FakeConnection();
    assert.equal(chatRunRegistry.attachConnection('app-run-5b', reloadedConnection), true);

    run.writer.send({ kind: 'stream_delta', provider: 'opencode', sessionId: 'o', content: 'after' });
    run.writer.send({ kind: 'stream_delta', provider: 'opencode', sessionId: 'o', content: 'later' });

    assert.deepEqual(staleConnection.frames, []);
    assert.deepEqual(reloadedConnection.frames.map((frame) => frame.content), ['after', 'later']);
  });
});

test('startRun rejects a second concurrent run for the same session', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-6', 'opencode', '/workspace/demo');
    const connection = new FakeConnection();
    const first = chatRunRegistry.startRun({
      appSessionId: 'app-run-6',
      provider: 'opencode',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(first);

    const second = chatRunRegistry.startRun({
      appSessionId: 'app-run-6',
      provider: 'opencode',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.equal(second, null);

    // After the run finishes a new one is allowed again.
    chatRunRegistry.completeRun('app-run-6', { exitCode: 0 });
    const third = chatRunRegistry.startRun({
      appSessionId: 'app-run-6',
      provider: 'opencode',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(third);
  });
});

/**
 * Two turns of the same session, each with its own per-run `seq` space: run 1
 * streams five frames and completes, run 2 streams three. Returns both runs so
 * a case can replay against either one's identity.
 */
function seedTwoRuns(sessionId: string): {
  firstRun: NonNullable<ReturnType<typeof chatRunRegistry.startRun>>;
  secondRun: NonNullable<ReturnType<typeof chatRunRegistry.startRun>>;
} {
  const firstRun = chatRunRegistry.startRun({
    appSessionId: sessionId,
    provider: 'claude',
    providerSessionId: null,
    connection: null,
    userId: null,
  });
  assert.ok(firstRun);
  for (let i = 1; i <= 5; i += 1) {
    firstRun.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'native', content: `run1-${i}` });
  }
  firstRun.writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native', exitCode: 0 });

  const secondRun = chatRunRegistry.startRun({
    appSessionId: sessionId,
    provider: 'claude',
    providerSessionId: null,
    connection: null,
    userId: null,
  });
  assert.ok(secondRun);
  for (let i = 1; i <= 3; i += 1) {
    secondRun.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'native', content: `run2-${i}` });
  }

  return { firstRun, secondRun };
}

test('a cursor recorded against an earlier run replays the current run from its start', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-replay', 'claude', '/workspace/demo');
    const { firstRun, secondRun } = seedTwoRuns('app-run-replay');

    // The client's cursor is the high-water mark of run 1 (seq 5), which says
    // nothing about run 2 — whose own numbering started over at 1. Carrying it
    // over would suppress exactly the frames the client missed.
    const staleCursor = chatRunRegistry.replayEvents('app-run-replay', 5, firstRun.runId);
    assert.deepEqual(staleCursor.map((event) => event.seq), [1, 2, 3]);
    assert.deepEqual(staleCursor.map((event) => event.content), ['run2-1', 'run2-2', 'run2-3']);

    // A cursor recorded against the run actually in flight keeps the plain
    // `seq > lastSeq` rule.
    const currentCursor = chatRunRegistry.replayEvents('app-run-replay', 1, secondRun.runId);
    assert.deepEqual(currentCursor.map((event) => event.seq), [2, 3]);

    // No `runId` at all is an older client: behavior is unchanged, so a stale
    // seq of 5 replays nothing from run 2.
    assert.deepEqual(chatRunRegistry.replayEvents('app-run-replay', 5), []);
    assert.deepEqual(
      chatRunRegistry.replayEvents('app-run-replay', 0).map((event) => event.seq),
      [1, 2, 3],
    );
  });
});

test('every live frame of a run carries that run\'s id, complete included', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-run-identity', 'claude', '/workspace/demo');
    const connection = new FakeConnection();
    const run = chatRunRegistry.startRun({
      appSessionId: 'app-run-identity',
      provider: 'claude',
      providerSessionId: null,
      connection,
      userId: null,
    });
    assert.ok(run);
    assert.equal(typeof run.runId, 'string');
    assert.ok(run.runId.length > 0);

    run.writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'native', content: 'a' });
    run.writer.send({ kind: 'text', provider: 'claude', sessionId: 'native', content: 'b' });
    run.writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native', exitCode: 0 });

    assert.equal(connection.frames.length, 3);
    // The terminal `complete` is stamped like every other frame, which is what
    // lets a client reconcile its cursor at the end of a turn.
    assert.deepEqual(connection.frames.map((frame) => frame.kind), ['stream_delta', 'text', 'complete']);
    assert.deepEqual(
      connection.frames.map((frame) => frame.runId),
      [run.runId, run.runId, run.runId],
    );

    // The session's next turn is a different run, hence a different identity.
    const nextRun = chatRunRegistry.startRun({
      appSessionId: 'app-run-identity',
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId: null,
    });
    assert.ok(nextRun);
    assert.notEqual(nextRun.runId, run.runId);
  });
});

test('chat.subscribe names the current run in the ack and replays from a stale run\'s first frame', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-run-sub', 'claude', '/workspace/demo');
    const { firstRun, secondRun } = seedTwoRuns('app-run-sub');

    const socket = createFakeSocket();
    handleChatConnection(
      socket as never,
      { user: { id: 1 } } as never,
      {
        runtime: { getPendingApprovalsForSession: () => [] } as never,
        sessionHostManager: { attachViewer: () => {} } as never,
      },
    );
    const handleMessage = socket.listeners('message')[0] as (raw: string) => Promise<void>;
    const subscribe = async (target: Record<string, unknown>) => {
      socket.frames = [];
      await handleMessage(JSON.stringify({ type: 'chat.subscribe', sessions: [target] }));
    };

    // A cursor carried over from the run before this one: the ack names run 2,
    // and the replay starts at run 2's first frame rather than honoring seq 5.
    await subscribe({ sessionId: 'app-run-sub', lastSeq: 5, runId: firstRun.runId });
    const staleAck = socket.frames.find((frame) => frame.kind === 'chat_subscribed');
    assert.equal(staleAck?.runId, secondRun.runId);
    assert.deepEqual(
      socket.frames.filter((frame) => frame.kind === 'stream_delta').map((frame) => frame.seq),
      [1, 2, 3],
    );

    // The run the cursor belongs to: plain `seq > lastSeq`.
    await subscribe({ sessionId: 'app-run-sub', lastSeq: 1, runId: secondRun.runId });
    const currentAck = socket.frames.find((frame) => frame.kind === 'chat_subscribed');
    assert.equal(currentAck?.runId, secondRun.runId);
    assert.deepEqual(
      socket.frames.filter((frame) => frame.kind === 'stream_delta').map((frame) => frame.seq),
      [2, 3],
    );

    // An older client omits `runId`: unchanged behavior, so a stale seq of 5
    // still replays nothing.
    await subscribe({ sessionId: 'app-run-sub', lastSeq: 5 });
    assert.deepEqual(socket.frames.filter((frame) => frame.kind === 'stream_delta'), []);
  });
});

