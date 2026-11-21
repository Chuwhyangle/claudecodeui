import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { providerModelsService, sessionsService } from '@/modules/providers/index.js';
import { handleChatConnection } from '@/modules/websocket/services/dispatch/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/dispatch/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

const SESSION_ID = 'permission-mode-session';

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

type RunCall = { provider: string; command: string; options: Record<string, unknown> };

/**
 * Boots the chat gateway against an isolated database with one session row.
 *
 * The runtime is stubbed: what is under test is what the gateway records and
 * what it hands the runtime, not what a provider does with it.
 */
async function withGateway(
  provider: string,
  runTest: (context: {
    socket: ReturnType<typeof createFakeSocket>;
    runs: RunCall[];
    projectPath: string;
  }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-permission-mode-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const runs: RunCall[] = [];
  const socket = createFakeSocket();

  try {
    const now = new Date().toISOString();
    sessionsDb.createSession(
      SESSION_ID,
      provider,
      tempDirectory,
      'Permission mode session',
      now,
      now,
      path.join(tempDirectory, `${SESSION_ID}.jsonl`),
    );

    handleChatConnection(
      socket as never,
      { user: { id: 1 } } as never,
      {
        runtime: {
          hasRuntime: () => true,
          run: async (runProvider: string, command: string, options: Record<string, unknown>) => {
            runs.push({ provider: runProvider, command, options });
          },
        } as never,
      },
    );

    await runTest({ socket, runs, projectPath: tempDirectory });
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

/** The handler is async and the socket listener does not await it. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

test('发送时落库：合法模式随消息写入会话行', async () => {
  await withGateway('claude', async ({ socket, runs }) => {
    socket.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: SESSION_ID,
      content: 'run with plan mode',
      options: { permissionMode: 'plan' },
    }));
    await settle();

    // The turn really went out with the mode, and the row remembers it: that
    // row is the only place another device can read the choice from.
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.options.permissionMode, 'plan');
    assert.equal(sessionsDb.getSessionById(SESSION_ID)?.permission_mode, 'plan');
  });
});

test('非法模式不写入也不报错：不在 provider 能力表内的值被忽略', async () => {
  await withGateway('claude', async ({ socket, runs }) => {
    // One value no provider declares, one real value this provider does not
    // offer (codex has no `plan`).
    socket.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: SESSION_ID,
      content: 'unknown mode',
      options: { permissionMode: 'yolo' },
    }));
    await settle();

    assert.equal(runs.length, 1, 'the message itself still goes out');
    assert.equal(sessionsDb.getSessionById(SESSION_ID)?.permission_mode, null);
    assert.equal(
      socket.frames.some((frame) => typeof frame.code === 'string'),
      false,
      'an unsupported mode is not an error the client hears about',
    );
  });
});

test('非法模式不写入也不报错：provider 不支持的真实模式同样被忽略', async () => {
  await withGateway('codex', async ({ socket, runs }) => {
    socket.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: SESSION_ID,
      content: 'plan on a provider without it',
      options: { permissionMode: 'plan' },
    }));
    await settle();

    assert.equal(runs.length, 1);
    assert.equal(sessionsDb.getSessionById(SESSION_ID)?.permission_mode, null);
  });
});

test('未带 permissionMode 的消息不改动已记录的值', async () => {
  await withGateway('claude', async ({ socket }) => {
    socket.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: SESSION_ID,
      content: 'first, with a mode',
      options: { permissionMode: 'acceptEdits' },
    }));
    await settle();
    assert.equal(sessionsDb.getSessionById(SESSION_ID)?.permission_mode, 'acceptEdits');

    // Switching the mode in the composer is not a write; only a send is. A
    // send that carries no mode (an older client, or a turn sent from a device
    // that never touched the composer) must therefore leave the recorded value
    // exactly as it was rather than clearing it back to the default.
    socket.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: SESSION_ID,
      content: 'second, with no mode',
    }));
    await settle();

    assert.equal(sessionsDb.getSessionById(SESSION_ID)?.permission_mode, 'acceptEdits');
  });
});

test('全新会话首条消息即带模式，会话行先于消息建立，读回值等于所发模式', async () => {
  await withGateway('claude', async ({ socket, runs, projectPath }) => {
    // A brand-new chat: the session gateway mints the id and writes the row,
    // and it is that call — not the client — that decides the id, so the row
    // exists before the client can name it. The first message is the one that
    // has to carry the composer's mode, and the recorded value has to survive
    // into the row the session was established with.
    const created = sessionsService.createAppSession('claude', projectPath, 'brand-new first message');
    const newSessionId = created.sessionId;
    assert.notEqual(newSessionId, SESSION_ID, 'the gateway really minted a different session');

    socket.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: newSessionId,
      content: 'brand-new first message',
      options: { permissionMode: 'bypassPermissions' },
    }));
    await settle();

    assert.equal(runs.length, 1);
    assert.equal(sessionsDb.getSessionById(newSessionId)?.permission_mode, 'bypassPermissions');

    // Read back the way the client does it: through the active-model answer
    // that fills the composer when the session is reopened.
    const resolved = await providerModelsService.resolveSessionModel('claude', { sessionId: newSessionId });
    assert.equal(resolved.permissionMode, 'bypassPermissions');
  });
});

test('首发竞态的前提不成立：会话行先于客户端可知的 id 存在', async () => {
  await withGateway('claude', async ({ socket, projectPath }) => {
    // The race this guards against is "the first message carries a mode before
    // the session row exists". It cannot happen: the row and the id are
    // produced by the same call, and the client only learns the id from its
    // answer, so a mode-carrying send always names a session that is already
    // on disk. Proven here rather than assumed — the row is there the moment
    // the id is, and a frame naming a session that is not gets refused before
    // it can reach the write point.
    const created = sessionsService.createAppSession('claude', projectPath, 'order proof');
    assert.ok(
      sessionsDb.getSessionById(created.sessionId),
      'the id is only handed out together with its row',
    );

    socket.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: 'a-session-that-was-never-created',
      content: 'sent before the row exists',
      options: { permissionMode: 'plan' },
    }));
    await settle();

    assert.equal(socket.frames.at(-1)?.code, 'SESSION_NOT_FOUND');
    assert.equal(sessionsDb.getSessionById('a-session-that-was-never-created'), null);
  });
});
