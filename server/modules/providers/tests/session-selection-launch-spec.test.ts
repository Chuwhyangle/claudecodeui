import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, providerModelsDb, userDb } from '@/modules/database/index.js';
import { createProviderRuntimeService, sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry, connectedClients, handleChatConnection } from '@/modules/websocket/index.js';
import type { ProviderModelEnvRow } from '@/shared/types.js';

/**
 * The selection a session is created with is the selection its FIRST turn launches with,
 * even when that first turn carries no model of its own.
 *
 * THE CLAIM. `createAppSession` records what the gateway call stated; the runtime's
 * fresh-start path resolves the launch spec from that recorded selection. Here the model
 * is a CUSTOM entry, so "the selection was honoured" is readable as the request landing on
 * the entry's own endpoint with the entry's own credential — not as a string comparison.
 *
 * WHY THIS READING. On 2026-10-15 a Live-Voice-allocated session ran with `--model default`
 * and an env with no ANTHROPIC_* at all: it reached the host account instead of the custom
 * model's gateway, and died on the account's session limit. A criterion that only compared
 * `sdkOptions.model` would have missed the half that spends the wrong quota, so the
 * assertion below is about WHICH ENDPOINT the turn reached and WHOSE credential it carried.
 *
 * WHY IT IS RED BEFORE THE FIX. The host endpoint is a dead local port, so a run that
 * ignores the recorded selection can never reach the mock. The session row comes from the
 * real gateway call (`sessionsService.createAppSession`), and the turn is a plain
 * `chat.send` with no model in its options — the shape Live Voice's relayed `session_send`
 * produces server-side.
 */

const SESSION_MODEL = 'selection-launch-model';
const MODEL_SECRET = 'selection-model-secret-token';
const HOST_SENTINEL = 'sk-host-sentinel-must-not-leak';

type Received = { url: string; authorization: string | undefined; apiKey: string | undefined };

function sse(events: Array<[string, unknown]>): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/** Minimal valid streaming `/v1/messages` reply. */
function messageStream(): string {
  return sse([
    ['message_start', {
      type: 'message_start',
      message: {
        id: 'msg_mock', type: 'assistant', role: 'assistant', model: 'mock-model', content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      },
    }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', {
      type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 },
    }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

async function startMockAnthropic(): Promise<{ received: Received[]; baseUrl: string; close: () => Promise<void> }> {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      received.push({
        url: req.url ?? '',
        authorization: req.headers.authorization,
        apiKey: req.headers['x-api-key'] as string | undefined,
      });
      if ((req.url ?? '').startsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(messageStream());
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      }
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  return {
    received,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

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

/** Creates the session through the real gateway, then drives one options-less turn into it. */
async function runOptionsLessFirstTurn(baseUrl: string, waitMs: number): Promise<Array<Record<string, unknown>>> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-selection-launch-'));
  const saved = new Map<string, string | undefined>(
    ['DATABASE_PATH', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']
      .map((name) => [name, process.env[name]]),
  );

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  process.env.CLAUDE_CONFIG_DIR = path.join(tempDirectory, 'claude-config');
  // The host default endpoint is a dead local port: a run that ignores the recorded
  // selection can never reach the mock.
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1';
  process.env.ANTHROPIC_API_KEY = HOST_SENTINEL;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  await initializeDatabase();
  const user = userDb.createUser('session-selection-launch', 'unused-hash');

  const rows: ProviderModelEnvRow[] = [
    { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: baseUrl },
    { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', value: MODEL_SECRET },
    { key: 'ANTHROPIC_API_KEY', kind: 'unset' },
  ];
  providerModelsDb.createCustomProviderModel('claude', {
    id: SESSION_MODEL,
    model: SESSION_MODEL,
    config: { env: rows },
  });

  const runtime = createProviderRuntimeService();
  const socket = createFakeSocket();
  let sessionId = '';
  try {
    const created = sessionsService.createAppSession('claude', tempDirectory, '', { model: SESSION_MODEL });
    sessionId = created.sessionId;

    handleChatConnection(
      socket as never,
      { user: { id: Number(user.id) } } as never,
      { runtime: runtime as never },
    );

    socket.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: created.sessionId,
      content: 'the first thing said into this session',
      // Deliberately NO model: the session's recorded selection is the only source.
      options: { cwd: tempDirectory, permissionMode: 'default' },
    }));

    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && !socket.frames.some((frame) => frame.kind === 'complete' || frame.kind === 'error')) {
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
  } finally {
    if (sessionId) {
      await runtime.abort('claude', sessionId).catch(() => false);
    }
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(tempDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
  return socket.frames;
}

test('an options-less first turn launches with the model the session was created with', { timeout: 180_000 }, async () => {
  const mock = await startMockAnthropic();
  try {
    const frames = await runOptionsLessFirstTurn(mock.baseUrl, 60_000);
    const requests = mock.received.filter((request) => request.url.startsWith('/v1/messages'));

    // The falsifying assertion, first: before the fix the row carried no model, the
    // runtime fell back to `--model default`, and the child kept the host endpoint
    // (a dead port) — so nothing ever reached this mock.
    assert.ok(
      requests.length >= 1,
      `a first turn into a session created with a custom model must reach THAT model's endpoint; mock saw ${JSON.stringify(mock.received)}; frames=${JSON.stringify(frames).slice(0, 600)}`,
    );
    for (const request of requests) {
      assert.strictEqual(
        request.authorization,
        `Bearer ${MODEL_SECRET}`,
        'the credential comes from the model entry the session was created with',
      );
      assert.ok(
        request.apiKey === undefined,
        'the entry unsets the host key, so no x-api-key may reach the gateway',
      );
    }
  } finally {
    await mock.close();
  }
});
