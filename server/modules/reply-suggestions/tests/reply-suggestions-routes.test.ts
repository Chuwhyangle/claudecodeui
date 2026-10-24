/**
 * Reply-suggestions route and module-assembly criterion.
 *
 * Every leg mounts `createReplySuggestionsModule` on a real Express app and
 * drives it over HTTP, so the reading covers the module's composition root as
 * well as the route's parsing. The transcript reader and the upstream call are
 * the injected seams.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/reply-suggestions/tests/reply-suggestions-routes.test.ts
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

import {
  ReplySuggestionsClientError,
  type ReplySuggestionsCompletionRequest,
} from '../reply-suggestions-client.js';
import { createReplySuggestionsModule, type ReplySuggestionsModuleDeps } from '../reply-suggestions.module.js';

const API_KEY = 'sk-route-secret-value';

type HarnessOptions = {
  settings?: Record<string, unknown>;
  readerError?: AppError;
  messageText?: string | null;
  responder?: (request: ReplySuggestionsCompletionRequest) => string | Promise<string>;
  completeThrows?: Error;
  usageLogPath?: string;
};

type Harness = {
  baseUrl: string;
  settingsPath: string;
  calls: ReplySuggestionsCompletionRequest[];
};

async function start(
  t: { after(callback: () => void | Promise<void>): void },
  options: HarnessOptions = {},
): Promise<Harness> {
  const directory = mkdtempSync(path.join(tmpdir(), 'reply-routes-'));
  const keyFile = path.join(directory, 'key.txt');
  writeFileSync(keyFile, `${API_KEY}\n`, { mode: 0o600 });
  const settingsPath = path.join(directory, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({
    enabled: true,
    baseUrl: 'http://gateway.invalid',
    model: 'test-model',
    apiKeyFile: keyFile,
    usageLog: false,
    ...options.settings,
  }), { mode: 0o600 });

  const calls: ReplySuggestionsCompletionRequest[] = [];
  const deps: ReplySuggestionsModuleDeps = {
    settingsPath,
    readLastAssistantMessage: async () => {
      if (options.readerError !== undefined) throw options.readerError;
      if (options.messageText === null) return null;
      return { id: 'assistant-routes', text: options.messageText ?? '助手问：要继续吗？' };
    },
    complete: async (request) => {
      calls.push(request);
      if (options.completeThrows !== undefined) throw options.completeThrows;
      const text = await (options.responder ?? (() => '{"chips":["chip-a","chip-b","chip-c"]}'))(request);
      return { text, inputTokens: 3, outputTokens: 4 };
    },
    ...(options.usageLogPath === undefined ? {} : { usageLogPath: options.usageLogPath }),
  };

  const app = express();
  app.use(express.json());
  app.use('/api/reply-suggestions', createReplySuggestionsModule(deps));
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
  return { baseUrl: `http://127.0.0.1:${port}`, settingsPath, calls };
}

async function get(baseUrl: string, route: string): Promise<{ status: number; body: unknown; text: string }> {
  const response = await fetch(`${baseUrl}${route}`);
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : JSON.parse(text), text };
}

async function post(
  baseUrl: string,
  route: string,
  body: unknown,
): Promise<{ status: number; body: unknown; text: string }> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : JSON.parse(text), text };
}

test('GET /status is the four-field reading with no key and no path', async (t) => {
  const harness = await start(t);
  const response = await get(harness.baseUrl, '/api/reply-suggestions/status');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { enabled: true, expansion: 'off', maxChips: 3, maxChipChars: 120 });
  assert.ok(!response.text.includes(API_KEY), 'the status body must not carry the key');
  assert.ok(!response.text.includes(harness.settingsPath), 'the status body must not carry the settings path');
});

test('POST / answers 400 when sessionId is missing or the field types are wrong', async (t) => {
  const harness = await start(t);
  const missing = await post(harness.baseUrl, '/api/reply-suggestions', {});
  assert.equal(missing.status, 400);
  assert.equal((missing.body as { error: { code: string } }).error.code, 'INVALID_REQUEST');

  const wrongType = await post(harness.baseUrl, '/api/reply-suggestions', { sessionId: 's', redraw: 'yes' });
  assert.equal(wrongType.status, 400);

  const focusType = await post(harness.baseUrl, '/api/reply-suggestions', { sessionId: 's', focus: 42 });
  assert.equal(focusType.status, 400);
  assert.equal(harness.calls.length, 0, 'invalid requests never reach upstream');
});

test('POST / clips an over-long focus instead of rejecting it', async (t) => {
  const harness = await start(t, { settings: { maxFocusChars: 4 } });
  const response = await post(harness.baseUrl, '/api/reply-suggestions', {
    sessionId: 's-focus',
    focus: 'abcdefghij',
  });
  assert.equal(response.status, 200);
  assert.equal(harness.calls.length, 1);
  assert.ok(harness.calls[0].user.includes('abcd'), 'the focus tail is used');
  assert.ok(!harness.calls[0].user.includes('abcdefghij'), 'only maxFocusChars characters are used');
});

test('a 404 AppError from the injected reader passes through', async (t) => {
  const harness = await start(t, {
    readerError: new AppError('Session "missing" was not found.', { code: 'SESSION_NOT_FOUND', statusCode: 404 }),
  });
  const response = await post(harness.baseUrl, '/api/reply-suggestions', { sessionId: 'missing' });
  assert.equal(response.status, 404);
  assert.equal((response.body as { error: { code: string } }).error.code, 'SESSION_NOT_FOUND');
});

test('a disabled feature answers 503', async (t) => {
  const harness = await start(t, { settings: { enabled: false } });
  const response = await post(harness.baseUrl, '/api/reply-suggestions', { sessionId: 's' });
  assert.equal(response.status, 503);
  assert.equal((response.body as { error: { code: string } }).error.code, 'REPLY_SUGGESTIONS_DISABLED');
});

test('over the call cap answers 429', async (t) => {
  const harness = await start(t, { settings: { maxCallsPerMinute: 1 } });
  const first = await post(harness.baseUrl, '/api/reply-suggestions', { sessionId: 's-one' });
  assert.equal(first.status, 200);
  const second = await post(harness.baseUrl, '/api/reply-suggestions', { sessionId: 's-two' });
  assert.equal(second.status, 429);
  assert.equal((second.body as { error: { code: string } }).error.code, 'REPLY_SUGGESTIONS_RATE_LIMITED');
});

test('an upstream failure answers 502', async (t) => {
  const harness = await start(t, {
    completeThrows: new ReplySuggestionsClientError('http', 'upstream returned HTTP 500', 500),
  });
  const response = await post(harness.baseUrl, '/api/reply-suggestions', { sessionId: 's' });
  assert.equal(response.status, 502);
  assert.equal((response.body as { error: { code: string } }).error.code, 'REPLY_SUGGESTIONS_UPSTREAM_FAILED');
  assert.ok(!response.text.includes(API_KEY));
});

test('a successful draw answers { chips, draw }', async (t) => {
  const harness = await start(t);
  const response = await post(harness.baseUrl, '/api/reply-suggestions', { sessionId: 's-success' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { chips: ['chip-a', 'chip-b', 'chip-c'], draw: 1 });
});

test('POST /events answers 204 for a valid event and 400 for an invalid one', async (t) => {
  const harness = await start(t);
  const valid = await post(harness.baseUrl, '/api/reply-suggestions/events', {
    sessionId: 's-events',
    draw: 1,
    event: 'picked',
    index: 0,
  });
  assert.equal(valid.status, 204);

  const noDraw = await post(harness.baseUrl, '/api/reply-suggestions/events', { sessionId: 's-events', event: 'cleared' });
  assert.equal(noDraw.status, 400);

  const badEvent = await post(harness.baseUrl, '/api/reply-suggestions/events', { sessionId: 's-events', draw: 1, event: 'clicked' });
  assert.equal(badEvent.status, 400);

  const badIndex = await post(harness.baseUrl, '/api/reply-suggestions/events', {
    sessionId: 's-events',
    draw: 1,
    event: 'picked',
    index: -1,
  });
  assert.equal(badIndex.status, 400);
});

test('the module assembly mounts the router and serves a draw over a fake reader and upstream', async (t) => {
  const harness = await start(t, {
    messageText: '真实注入的助手消息',
    responder: () => '["first","second"]',
  });
  assert.ok(harness.baseUrl.includes('127.0.0.1'), 'the criterion uses a loopback port');
  const response = await post(harness.baseUrl, '/api/reply-suggestions', { sessionId: 's-assembly' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { chips: ['first', 'second'], draw: 1 });
  assert.ok(harness.calls[0].user.includes('真实注入的助手消息'));
});
