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
import { createReplySuggestionsModule } from '../reply-suggestions.module.js';

const API_KEY = 'sk-draft-route-secret';
const DRAFT = '把这段话润色一下，明天十点见';
const REWRITTEN = '请把这段话润色一下，明天十点见。';

async function start(t: { after(callback: () => void | Promise<void>): void }) {
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
  }), { mode: 0o600 });

  const calls: ReplySuggestionsCompletionRequest[] = [];
  const app = express();
  app.use(express.json());
  app.use('/api/reply-suggestions', createReplySuggestionsModule({
    settingsPath,
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
  return { baseUrl: `http://127.0.0.1:${port}`, calls };
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
