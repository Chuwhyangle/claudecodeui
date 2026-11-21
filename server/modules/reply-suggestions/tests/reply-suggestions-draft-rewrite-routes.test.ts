/**
 * Draft rewrite route parsing criterion.
 *
 * The route is the transport boundary: it accepts `{ text, retry? }` and nothing else. These
 * legs drive the composed module over real HTTP so the reading covers the parser AND the
 * composition root: a malformed body is a 400 before the service, an unknown field is dropped
 * rather than forwarded, and the only success shape is `{ rewrittenText }`.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/reply-suggestions/tests/reply-suggestions-draft-rewrite-routes.test.ts
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, {
  type NextFunction,
  type Request as ExpressRequest,
  type Response as ExpressResponse,
} from 'express';

import { AppError } from '@/shared/utils.js';

import type { ReplySuggestionsCompletionRequest } from '../reply-suggestions-client.js';
import type { ReplySuggestionsDebugAttempt, ReplySuggestionsDebugLog } from '../reply-suggestions-debug-log.js';
import { createReplySuggestionsModule } from '../reply-suggestions.module.js';

const API_KEY = 'sk-draft-route-secret';
const DRAFT = '把这段话润色一下，明天十点见';
const REWRITTEN = '请把这段话润色一下，明天十点见。';

type StartOptions = {
  /** Record debug-ledger attempts into the returned `attempts` array. */
  recordAttempts?: boolean;
  /** Also require `Authorization: Bearer test-token` in front of the router (401 leg). */
  guardAuth?: boolean;
};

async function start(
  t: { after(callback: () => void | Promise<void>): void },
  options: StartOptions = {},
) {
  const directory = mkdtempSync(path.join(tmpdir(), 'draft-rewrite-routes-'));
  const keyFile = path.join(directory, 'key.txt');
  writeFileSync(keyFile, API_KEY, { mode: 0o600 });
  const settingsPath = path.join(directory, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({
    enabled: true,
    baseUrl: 'http://gateway.invalid',
    model: 'route-model',
    apiKeyFile: keyFile,
    usageLog: false,
    ...(options.recordAttempts === true ? { debugLog: true } : {}),
  }), { mode: 0o600 });

  const calls: ReplySuggestionsCompletionRequest[] = [];
  const attempts: ReplySuggestionsDebugAttempt[] = [];
  const debugLog: ReplySuggestionsDebugLog | undefined = options.recordAttempts === true
    ? { path: path.join(directory, 'debug.jsonl'), record: (attempt) => attempts.push(attempt) }
    : undefined;

  const app = express();
  app.use(express.json());
  if (options.guardAuth === true) {
    // The production mount puts `authenticateToken` in front of this router; this stand-in
    // reproduces exactly the fact these legs need — a request with no token never reaches it.
    app.use('/api/reply-suggestions', (request, response, next) => {
      if (request.header('authorization') !== 'Bearer test-token') {
        response.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
        return;
      }
      next();
    });
  }
  app.use('/api/reply-suggestions', createReplySuggestionsModule({
    settingsPath,
    ...(debugLog === undefined ? {} : { debugLog }),
    readLastAssistantMessage: async () => null,
    complete: async (request) => {
      calls.push(request);
      return { text: REWRITTEN, inputTokens: 1, outputTokens: 1, stopReason: 'end_turn', truncated: false };
    },
  }));
  app.use((error: unknown, _request: ExpressRequest, response: ExpressResponse, _next: NextFunction) => {
    if (error instanceof AppError) {
      response.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message } });
      return;
    }
    response.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { baseUrl: `http://127.0.0.1:${port}`, calls, attempts };
}

/** Shared request helper: one JSON body to an arbitrary path, keeping the status and body. */
async function send(
  baseUrl: string,
  route: string,
  method: 'POST' | 'PUT' | 'GET',
  body?: unknown,
  token?: string,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : JSON.parse(text) };
}

async function post(baseUrl: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}/api/reply-suggestions/draft-rewrite`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : JSON.parse(text) };
}

test('the success shape is exactly { rewrittenText }', async (t) => {
  const harness = await start(t);
  const response = await post(harness.baseUrl, { text: DRAFT });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { rewrittenText: REWRITTEN });
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].user, DRAFT);
});

test('an array body is a 400', async (t) => {
  const harness = await start(t);
  // Only JSON arrays reach the route parser: express's strict JSON parser already refuses a
  // scalar document before this router sees it, so the route's own object guard is what the
  // array exercises.
  const response = await post(harness.baseUrl, []);
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'INVALID_REQUEST');
  assert.equal(harness.calls.length, 0);
});

test('a missing or non-string text is a 400 and no completion is made', async (t) => {
  const harness = await start(t);
  for (const body of [{}, { text: 5 }, { text: true }, { text: null }]) {
    const response = await post(harness.baseUrl, body);
    assert.equal(response.status, 400, `body=${JSON.stringify(body)}`);
    assert.equal(response.body.error.code, 'INVALID_REQUEST');
  }
  assert.equal(harness.calls.length, 0);
});

test('a non-boolean retry is a 400, not coerced', async (t) => {
  const harness = await start(t);
  const response = await post(harness.baseUrl, { text: DRAFT, retry: 'yes' });
  assert.equal(response.status, 400);
  assert.equal(harness.calls.length, 0);
});

test('unknown fields (model, provider, prompt, history) are dropped and cannot reach upstream', async (t) => {
  const harness = await start(t);
  const response = await post(harness.baseUrl, {
    text: DRAFT,
    model: 'other',
    provider: 'openai',
    prompt: 'client prompt',
    history: [{ role: 'assistant', content: 'secret' }],
  });
  assert.equal(response.status, 200);
  const request = harness.calls[0];
  assert.equal(request.config.model, 'route-model');
  assert.equal(request.config.protocol, 'anthropic');
  const wire = JSON.stringify(request);
  assert.ok(!wire.includes('client prompt'));
  assert.ok(!wire.includes('secret'));
  assert.ok(!wire.includes('other'));
});

test('no response body carries the key', async (t) => {
  const harness = await start(t);
  const response = await fetch(`${harness.baseUrl}/api/reply-suggestions/draft-rewrite`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: DRAFT }),
  });
  assert.ok(!(await response.text()).includes(API_KEY));
});

//---------------------------------------------------------------------------------------------
// The opt-in debug-ledger switch route and the log-only sessionId field
//---------------------------------------------------------------------------------------------

test('PUT /debug-log persists and GET /status follows', async (t) => {
  const harness = await start(t);

  const before = await send(harness.baseUrl, '/api/reply-suggestions/status', 'GET');
  assert.equal(before.status, 200);
  assert.equal(before.body.debugLog, false, 'the shipped default is off');

  const enabled = await send(harness.baseUrl, '/api/reply-suggestions/debug-log', 'PUT', { enabled: true });
  assert.equal(enabled.status, 200);
  assert.deepEqual(enabled.body, { debugLog: true });
  assert.equal((await send(harness.baseUrl, '/api/reply-suggestions/status', 'GET')).body.debugLog, true);

  const disabled = await send(harness.baseUrl, '/api/reply-suggestions/debug-log', 'PUT', { enabled: false });
  assert.equal(disabled.status, 200);
  assert.deepEqual(disabled.body, { debugLog: false });
  assert.equal((await send(harness.baseUrl, '/api/reply-suggestions/status', 'GET')).body.debugLog, false);
});

test('PUT /debug-log rejects a non-boolean or missing enabled with 400', async (t) => {
  const harness = await start(t);
  for (const body of [{}, { enabled: 'true' }, { enabled: 1 }, { enabled: null }]) {
    const response = await send(harness.baseUrl, '/api/reply-suggestions/debug-log', 'PUT', body);
    assert.equal(response.status, 400, `body=${JSON.stringify(body)}`);
    assert.equal(response.body.error.code, 'INVALID_REQUEST');
  }
});

test('PUT /debug-log without a token is a 401 and never reaches the router', async (t) => {
  const harness = await start(t, { guardAuth: true });
  const anonymous = await send(harness.baseUrl, '/api/reply-suggestions/debug-log', 'PUT', { enabled: true });
  assert.equal(anonymous.status, 401);

  const authorized = await send(
    harness.baseUrl, '/api/reply-suggestions/debug-log', 'PUT', { enabled: true }, 'test-token',
  );
  assert.equal(authorized.status, 200);
  assert.deepEqual(authorized.body, { debugLog: true });
});

test('sessionId is passed to the attempt record but never to the upstream request', async (t) => {
  const harness = await start(t, { recordAttempts: true });
  const response = await post(harness.baseUrl, { text: DRAFT, sessionId: 'route-session-1' });
  assert.equal(response.status, 200);
  assert.equal(harness.attempts.length, 1);
  assert.equal(harness.attempts[0].sessionId, 'route-session-1');
  assert.ok(!JSON.stringify(harness.calls[0]).includes('route-session-1'), 'sessionId stays local');
});

test('an omitted sessionId is absent from the attempt record', async (t) => {
  const harness = await start(t, { recordAttempts: true });
  await post(harness.baseUrl, { text: DRAFT });
  assert.equal(harness.attempts.length, 1);
  assert.equal(harness.attempts[0].sessionId, null);
});

test('a sessionId longer than 128 characters or not a string is a 400 before any completion', async (t) => {
  const harness = await start(t);
  for (const body of [
    { text: DRAFT, sessionId: 's'.repeat(129) },
    { text: DRAFT, sessionId: 42 },
    { text: DRAFT, sessionId: { id: 'x' } },
  ]) {
    const response = await post(harness.baseUrl, body);
    assert.equal(response.status, 400, `body=${JSON.stringify(body)}`);
    assert.equal(response.body.error.code, 'INVALID_REQUEST');
  }
  assert.equal(harness.calls.length, 0);
});
