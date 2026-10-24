/**
 * Reply-suggestions upstream-client criterion.
 *
 * Every leg points the real client at a loopback HTTP server, so the request
 * path, headers, body, timeout and error categories are read off the wire
 * rather than asserted against a mock.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/reply-suggestions/tests/reply-suggestions-client.test.ts
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import {
  completeReplySuggestions,
  ReplySuggestionsClientError,
  replySuggestionsEndpoint,
  type ReplySuggestionsClientConfig,
} from '../reply-suggestions-client.js';
import { ApiCredential } from '../reply-suggestions-settings.js';

const API_KEY = 'sk-client-secret-value';

type CapturedRequest = {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
};

type Loopback = {
  baseUrl: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
};

async function listen(
  t: { after(callback: () => void | Promise<void>): void },
  responder: (request: CapturedRequest, response: import('node:http').ServerResponse) => void,
): Promise<Loopback> {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const captured: CapturedRequest = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>),
      };
      requests.push(captured);
      responder(captured, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  t.after(close);
  return { baseUrl: `http://127.0.0.1:${port}`, requests, close };
}

function replyJson(response: import('node:http').ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function config(overrides: Partial<ReplySuggestionsClientConfig> = {}): ReplySuggestionsClientConfig {
  return {
    protocol: 'anthropic',
    baseUrl: 'http://127.0.0.1:1',
    model: 'test-model',
    authScheme: '',
    credential: new ApiCredential(API_KEY),
    disableThinking: true,
    timeoutMs: 2000,
    ...overrides,
  };
}

function anthropicAnswer(text = '好的；我来处理'): unknown {
  return {
    content: [
      { type: 'thinking', thinking: 'internal reasoning' },
      { type: 'text', text },
    ],
    usage: { input_tokens: 11, output_tokens: 22 },
  };
}

function openAiAnswer(text = '好的；我来处理'): unknown {
  return {
    choices: [{ message: { role: 'assistant', content: text, reasoning_content: 'internal reasoning' } }],
    usage: { prompt_tokens: 33, completion_tokens: 44 },
  };
}

function request(overrides: Partial<ReplySuggestionsClientConfig> = {}) {
  return {
    config: config(overrides),
    system: 'system instructions',
    user: 'the assistant message tail',
    temperature: 0.3,
    maxOutputTokens: 400,
  };
}

test('(a) anthropic: path, anthropic-version, default x-api-key and body; thinking iff disableThinking', async (t) => {
  const loopback = await listen(t, (_request, response) => replyJson(response, 200, anthropicAnswer()));
  const baseUrl = loopback.baseUrl;

  const first = await completeReplySuggestions(request({ baseUrl, disableThinking: true }));
  assert.equal(first.text, '好的；我来处理');
  assert.equal(first.inputTokens, 11);
  assert.equal(first.outputTokens, 22);

  const captured = loopback.requests[0];
  assert.equal(captured.method, 'POST');
  assert.equal(captured.url, '/v1/messages');
  assert.equal(captured.headers['anthropic-version'], '2023-06-01');
  assert.equal(captured.headers['x-api-key'], API_KEY);
  assert.equal(captured.body.model, 'test-model');
  assert.equal(captured.body.max_tokens, 400);
  assert.equal(captured.body.system, 'system instructions');
  assert.deepEqual(captured.body.messages, [{ role: 'user', content: 'the assistant message tail' }]);
  assert.equal(captured.body.temperature, 0.3);
  assert.deepEqual(captured.body.thinking, { type: 'disabled' });

  await completeReplySuggestions(request({ baseUrl, disableThinking: false }));
  assert.equal(loopback.requests[1].body.thinking, undefined, 'thinking is absent when disabled');
});

test('(b) anthropic with authScheme "bearer" sends an authorization header', async (t) => {
  const loopback = await listen(t, (_request, response) => replyJson(response, 200, anthropicAnswer()));
  await completeReplySuggestions(request({ baseUrl: loopback.baseUrl, authScheme: 'bearer' }));
  const captured = loopback.requests[0];
  assert.equal(captured.headers.authorization, `Bearer ${API_KEY}`);
  assert.equal(captured.headers['x-api-key'], undefined);
});

test('(c) openai: path, default bearer, system+user messages; thinking iff disableThinking', async (t) => {
  const loopback = await listen(t, (_request, response) => replyJson(response, 200, openAiAnswer()));
  const baseUrl = loopback.baseUrl;

  const first = await completeReplySuggestions(request({ baseUrl, protocol: 'openai', disableThinking: true }));
  assert.equal(first.text, '好的；我来处理');
  assert.equal(first.inputTokens, 33);
  assert.equal(first.outputTokens, 44);

  const captured = loopback.requests[0];
  assert.equal(captured.url, '/v1/chat/completions');
  assert.equal(captured.headers.authorization, `Bearer ${API_KEY}`);
  assert.deepEqual(captured.body.messages, [
    { role: 'system', content: 'system instructions' },
    { role: 'user', content: 'the assistant message tail' },
  ]);
  assert.deepEqual(captured.body.thinking, { type: 'disabled' });

  await completeReplySuggestions(request({ baseUrl, protocol: 'openai', disableThinking: false }));
  assert.equal(loopback.requests[1].body.thinking, undefined);
});

test('(d) a baseUrl already ending in /v1 (with or without a slash) is not versioned twice', () => {
  assert.equal(replySuggestionsEndpoint('http://gateway/v1', 'anthropic'), 'http://gateway/v1/messages');
  assert.equal(replySuggestionsEndpoint('http://gateway/v1/', 'anthropic'), 'http://gateway/v1/messages');
  assert.equal(replySuggestionsEndpoint('http://gateway/', 'openai'), 'http://gateway/v1/chat/completions');
  assert.equal(replySuggestionsEndpoint('http://gateway/v1//', 'openai'), 'http://gateway/v1/chat/completions');
});

test('(e) an anthropic response with thinking and text blocks yields only the text block', async (t) => {
  const loopback = await listen(t, (_request, response) => replyJson(response, 200, {
    content: [
      { type: 'thinking', thinking: 'do not return me' },
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ],
  }));
  const completion = await completeReplySuggestions(request({ baseUrl: loopback.baseUrl }));
  assert.equal(completion.text, 'first\nsecond');
});

test('(f) an openai response carrying reasoning_content yields only content', async (t) => {
  const loopback = await listen(t, (_request, response) => replyJson(response, 200, {
    choices: [{ message: { content: 'only the answer', reasoning_content: 'do not return me' } }],
  }));
  const completion = await completeReplySuggestions(request({ baseUrl: loopback.baseUrl, protocol: 'openai' }));
  assert.equal(completion.text, 'only the answer');
});

test('(g) HTTP 500, 429, non-JSON and a wrong-shape body each fail with their category and no key', async (t) => {
  const cases: Array<{ name: string; status: number; body: string; category: string; httpStatus?: number }> = [
    { name: '500', status: 500, body: JSON.stringify({ error: 'boom' }), category: 'http', httpStatus: 500 },
    { name: '429', status: 429, body: JSON.stringify({ error: 'slow down' }), category: 'http', httpStatus: 429 },
    { name: 'non-JSON', status: 200, body: 'not json at all', category: 'parse' },
    { name: 'wrong shape', status: 200, body: JSON.stringify({ unexpected: true }), category: 'shape' },
  ];

  for (const testCase of cases) {
    const loopback = await listen(t, (_request, response) => {
      response.writeHead(testCase.status, { 'content-type': 'application/json' });
      response.end(testCase.body);
    });
    for (const protocol of ['anthropic', 'openai'] as const) {
      await assert.rejects(
        () => completeReplySuggestions(request({ baseUrl: loopback.baseUrl, protocol })),
        (failure: unknown) => {
          assert.ok(failure instanceof ReplySuggestionsClientError, `${testCase.name}/${protocol}: typed error`);
          assert.equal(failure.category, testCase.category, `${testCase.name}/${protocol}: category`);
          if (testCase.httpStatus !== undefined) assert.equal(failure.httpStatus, testCase.httpStatus);
          assert.ok(!failure.message.includes(API_KEY), `${testCase.name}/${protocol}: the message carries no key`);
          return true;
        },
      );
    }
    await loopback.close();
  }
});

test('(h) a slow upstream fails as a timeout within the configured bound', async (t) => {
  const loopback = await listen(t, (_request, response) => {
    setTimeout(() => replyJson(response, 200, anthropicAnswer()), 400);
  });
  const started = Date.now();
  await assert.rejects(
    () => completeReplySuggestions(request({ baseUrl: loopback.baseUrl, timeoutMs: 80 })),
    (failure: unknown) => {
      assert.ok(failure instanceof ReplySuggestionsClientError);
      assert.equal(failure.category, 'timeout');
      assert.ok(!failure.message.includes(API_KEY));
      return true;
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 70, `the timeout fired, not an instant failure (${elapsed} ms)`);
  assert.ok(elapsed < 400, `it failed before the slow response arrived (${elapsed} ms)`);
});
