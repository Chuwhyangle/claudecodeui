/**
 * The direct-HTTP LLM gateway's client criterion.
 *
 * Every leg points the REAL client at a loopback HTTP server, so the path, headers,
 * body, timeout and error categories are read off the wire rather than asserted
 * against a mock. The two protocol strategies are exercised side by side: the
 * Anthropic Messages dialect and the OpenAI Chat Completions dialect.
 *
 * WHAT THIS FILE PINS, one block per reading:
 *   · anthropic: `/v1/messages`, `anthropic-version`, default `x-api-key`, the
 *     system/user body, `thinking` iff `disableThinking`, and a response that keeps
 *     only the `text` blocks (never `thinking`) plus its usage;
 *   · openai: `/v1/chat/completions`, default bearer, the system+user messages,
 *     `thinking` iff `disableThinking`, and a response that keeps only `content`
 *     (never `reasoning_content`) plus its usage;
 *   · the endpoint rule: a `/v1` base is not versioned twice, and an already-full
 *     dialect endpoint is used as-is;
 *   · the wire hints the voice summary leaf needs: no system turn, a text-block user
 *     message, and extra top-level body fields;
 *   · HTTP 500/429, non-JSON, and a wrong-shape body each fail with their category,
 *     and no failure message carries the key;
 *   · a slow upstream fails as a timeout within the configured bound.
 *
 *   npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs \
 *     --test server/modules/llm-gateway/tests/llm-client.test.ts
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import {
  anthropicProtocol,
  completeLlm,
  LlmClientError,
  openaiProtocol,
  selectProtocol,
} from '../llm-client.js';
import { ApiCredential, credentialFromKey } from '../llm-credential.js';
import type { LlmClientConfig, LlmCompletionRequest } from '../llm-protocols.js';

const API_KEY = 'sk-gateway-secret-value';

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

function config(overrides: Partial<LlmClientConfig> = {}): LlmClientConfig {
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

function request(overrides: Partial<LlmClientConfig> = {}): LlmCompletionRequest {
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

  const first = await completeLlm(request({ baseUrl, disableThinking: true }));
  assert.equal(first.text, '好的；我来处理');
  assert.equal(first.inputTokens, 11);
  assert.equal(first.outputTokens, 22);

  const captured = loopback.requests[0]!;
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

  await completeLlm(request({ baseUrl, disableThinking: false }));
  assert.equal(loopback.requests[1]!.body.thinking, undefined, 'thinking is absent when disabled');
});

test('(b) anthropic with authScheme "bearer" sends an authorization header', async (t) => {
  const loopback = await listen(t, (_request, response) => replyJson(response, 200, anthropicAnswer()));
  await completeLlm(request({ baseUrl: loopback.baseUrl, authScheme: 'bearer' }));
  const captured = loopback.requests[0]!;
  assert.equal(captured.headers.authorization, `Bearer ${API_KEY}`);
  assert.equal(captured.headers['x-api-key'], undefined);
});

test('(c) openai: path, default bearer, system+user messages; thinking iff disableThinking', async (t) => {
  const loopback = await listen(t, (_request, response) => replyJson(response, 200, openAiAnswer()));
  const baseUrl = loopback.baseUrl;

  const first = await completeLlm(request({ baseUrl, protocol: 'openai', disableThinking: true }));
  assert.equal(first.text, '好的；我来处理');
  assert.equal(first.inputTokens, 33);
  assert.equal(first.outputTokens, 44);

  const captured = loopback.requests[0]!;
  assert.equal(captured.url, '/v1/chat/completions');
  assert.equal(captured.headers.authorization, `Bearer ${API_KEY}`);
  assert.deepEqual(captured.body.messages, [
    { role: 'system', content: 'system instructions' },
    { role: 'user', content: 'the assistant message tail' },
  ]);
  assert.deepEqual(captured.body.thinking, { type: 'disabled' });

  await completeLlm(request({ baseUrl, protocol: 'openai', disableThinking: false }));
  assert.equal(loopback.requests[1]!.body.thinking, undefined);
});

test('(d) a baseUrl already ending in /v1 is not versioned twice, and a full dialect endpoint is used as-is', () => {
  assert.equal(selectProtocol('anthropic').endpoint('http://gateway/v1'), 'http://gateway/v1/messages');
  assert.equal(selectProtocol('openai').endpoint('http://gateway/v1/'), 'http://gateway/v1/chat/completions');
  assert.equal(selectProtocol('openai').endpoint('http://gateway/'), 'http://gateway/v1/chat/completions');
  assert.equal(selectProtocol('openai').endpoint('http://gateway/v1//'), 'http://gateway/v1/chat/completions');
  assert.equal(
    selectProtocol('openai').endpoint('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'),
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    'the full endpoint the voice summary leaf composes is not given a second version/path',
  );
  assert.equal(anthropicProtocol.name, 'anthropic');
  assert.equal(openaiProtocol.name, 'openai');
});

test('(e) an anthropic response with thinking and text blocks yields only the text blocks', async (t) => {
  const loopback = await listen(t, (_request, response) => replyJson(response, 200, {
    content: [
      { type: 'thinking', thinking: 'do not return me' },
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ],
  }));
  const completion = await completeLlm(request({ baseUrl: loopback.baseUrl }));
  assert.equal(completion.text, 'first\nsecond');
});

test('(f) an openai response carrying reasoning_content yields only content', async (t) => {
  const loopback = await listen(t, (_request, response) => replyJson(response, 200, {
    choices: [{ message: { content: 'only the answer', reasoning_content: 'do not return me' } }],
  }));
  const completion = await completeLlm(request({ baseUrl: loopback.baseUrl, protocol: 'openai' }));
  assert.equal(completion.text, 'only the answer');
});

test('(g) the wire hints send no system turn, a text-block user message and extra body fields', async (t) => {
  const loopback = await listen(t, (_request, response) => replyJson(response, 200, openAiAnswer('已完成。')));
  await completeLlm({
    config: config({
      protocol: 'openai',
      baseUrl: loopback.baseUrl,
      authScheme: 'bearer',
      credential: credentialFromKey('sk-live-voice'),
      disableThinking: false,
    }),
    system: '',
    user: '语音播报：已完成。',
    temperature: 0,
    maxOutputTokens: 200,
    wire: {
      userContentAsTextBlock: true,
      extraBodyFields: { modalities: ['text'], stream: false },
    },
  });
  const captured = loopback.requests[0]!;
  assert.deepEqual(captured.body.messages, [
    { role: 'user', content: [{ type: 'text', text: '语音播报：已完成。' }] },
  ], 'an empty system prompt sends no system turn and the user turn is a text block array');
  assert.deepEqual(captured.body.modalities, ['text']);
  assert.equal(captured.body.stream, false);
  assert.equal(captured.body.temperature, 0);
  assert.equal(captured.body.max_tokens, 200);
  assert.equal(captured.headers.authorization, 'Bearer sk-live-voice');
});

test('(h) HTTP 500, 429, non-JSON and a wrong-shape body each fail with their category and no key', async (t) => {
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
        () => completeLlm(request({ baseUrl: loopback.baseUrl, protocol })),
        (failure: unknown) => {
          assert.ok(failure instanceof LlmClientError, `${testCase.name}/${protocol}: typed error`);
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

test('(i) a slow upstream fails as a timeout within the configured bound', async (t) => {
  const loopback = await listen(t, (_request, response) => {
    setTimeout(() => replyJson(response, 200, anthropicAnswer()), 400);
  });
  const started = Date.now();
  await assert.rejects(
    () => completeLlm(request({ baseUrl: loopback.baseUrl, timeoutMs: 80 })),
    (failure: unknown) => {
      assert.ok(failure instanceof LlmClientError);
      assert.equal(failure.category, 'timeout');
      assert.ok(!failure.message.includes(API_KEY));
      return true;
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 70, `the timeout fired, not an instant failure (${elapsed} ms)`);
  assert.ok(elapsed < 400, `it failed before the slow response arrived (${elapsed} ms)`);
});

test('(j) both dialects read the completion stop/finish reason and flag truncation', async (t) => {
  // Anthropic: `stop_reason` is top-level. A finished answer is `end_turn`; the output-token
  // ceiling is `max_tokens` and MUST read as truncated so a caller cannot apply a cut answer.
  let anthropicStop = 'end_turn';
  const anthropic = await listen(t, (_request, response) => replyJson(response, 200, {
    content: [{ type: 'text', text: '好的。' }],
    stop_reason: anthropicStop,
    usage: { input_tokens: 3, output_tokens: 2 },
  }));
  const finished = await completeLlm(request({ baseUrl: anthropic.baseUrl }));
  assert.equal(finished.stopReason, 'end_turn');
  assert.equal(finished.truncated, false);
  anthropicStop = 'max_tokens';
  const cut = await completeLlm(request({ baseUrl: anthropic.baseUrl }));
  assert.equal(cut.stopReason, 'max_tokens');
  assert.equal(cut.truncated, true);

  // OpenAI: `finish_reason` is on the first choice. `stop` is finished, `length` is truncated.
  let finish = 'stop';
  const openai = await listen(t, (_request, response) => replyJson(response, 200, {
    choices: [{ message: { content: 'Done.' }, finish_reason: finish }],
    usage: { prompt_tokens: 3, completion_tokens: 2 },
  }));
  const openAiFinished = await completeLlm(request({ baseUrl: openai.baseUrl, protocol: 'openai' }));
  assert.equal(openAiFinished.stopReason, 'stop');
  assert.equal(openAiFinished.truncated, false);
  finish = 'length';
  const openAiCut = await completeLlm(request({ baseUrl: openai.baseUrl, protocol: 'openai' }));
  assert.equal(openAiCut.stopReason, 'length');
  assert.equal(openAiCut.truncated, true);

  // A response that names no stop reason is finished, not truncated: absence is not a cut.
  const silent = await listen(t, (_request, response) => replyJson(response, 200, {
    content: [{ type: 'text', text: '好的。' }],
    usage: { input_tokens: 3, output_tokens: 2 },
  }));
  const unnamed = await completeLlm(request({ baseUrl: silent.baseUrl }));
  assert.equal(unnamed.stopReason, null);
  assert.equal(unnamed.truncated, false);
});

test('(k) the credential cannot be printed, serialised or inspected', () => {  const credential = new ApiCredential(API_KEY);
  assert.equal(credential.reveal(), API_KEY);
  assert.equal(credential.toString(), '[redacted]');
  assert.equal(JSON.stringify(credential), JSON.stringify('[redacted]'));
  assert.ok(!String(credential).includes(API_KEY));
  assert.ok(!JSON.stringify({ credential }).includes(API_KEY));
  assert.equal(credentialFromKey(API_KEY).reveal(), API_KEY);
});
