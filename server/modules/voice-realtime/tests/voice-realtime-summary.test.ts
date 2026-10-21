/**
 * The run-end summary's SIDE TEXT MODEL leaf — one `chat/completions` ask, and every failure shape
 * named as "say nothing".
 *
 * WHAT THIS FILE PINS, one block per reading:
 *
 *   · a 200 answer is TRIMMED and returned, and the request is the `voice` ask: model
 *     `qwen-flash`, `modalities: ['text']`, `stream: false`, the output inside `<输出>`, and a
 *     prompt that asks for terseness WITHOUT a hard character bound;
 *   · the leaf's default model is `qwen-flash` (the 2026-10-20 latency swap);
 *   · empty/whitespace content resolves to `null` (the narrator speaks nothing);
 *   · a non-2xx answer resolves to `null`;
 *   · a blank apiKey resolves to `null` WITHOUT dialling — the injected fetch is never called;
 *   · a network error or an unreadable body resolves to `null`, never a rejection.
 *
 * The HTTP call is injected through the leaf's `fetch` option, so this file never reaches DashScope.
 *
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/voice-realtime/tests/voice-realtime-summary.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_VOICE_REALTIME_SUMMARY_MODEL,
  createVoiceRealtimeRunEndSummarizer,
} from '../voice-realtime-summary.js';

/** One captured request, as the leaf issued it. */
type CapturedRequest = { url: string; init: RequestInit };

/** A `fetch` that answers with the same JSON document and records every request. */
function jsonFetch(status: number, document: unknown, requests: CapturedRequest[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(document), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

/** The body the leaf serialized, typed at the seam both the AC and the proxy read. */
type SummaryRequest = {
  model: string;
  modalities: string[];
  stream: boolean;
  messages: Array<{ role: string; content: Array<{ type: string; text: string }> }>;
};

/** The run output a run-end ask carries. */
const CONTEXT = '用户：把登录页改一下。\n助手：已修改 Login.tsx 和 auth.ts，测试 12/12 通过。';

test('a 200 answer is trimmed, and the request is the B-1 voice ask', async () => {
  const requests: CapturedRequest[] = [];
  const summarizer = createVoiceRealtimeRunEndSummarizer({
    apiKey: 'sk-live-voice',
    fetch: jsonFetch(
      200,
      { choices: [{ message: { content: '  已完成登录页改版，测试全部通过。 \n' } }] },
      requests,
    ),
  });

  const summary = await summarizer.summarize({ output: CONTEXT, runId: 'run-1' });

  assert.equal(summary, '已完成登录页改版，测试全部通过。', 'the content is trimmed before it is returned');
  assert.equal(requests.length, 1, 'exactly one request per run end');

  const request = requests[0]!;
  assert.equal(request.url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
  assert.equal(request.init.method, 'POST');
  const headers = request.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer sk-live-voice', 'the deployment key is the bearer');
  assert.equal(headers['Content-Type'], 'application/json');

  const body = JSON.parse(String(request.init.body)) as SummaryRequest;
  assert.equal(body.model, 'qwen-flash', 'the fast side model (2026-10-20 latency swap)');
  assert.deepEqual(body.modalities, ['text'], 'a text-only ask: no audio modality');
  assert.equal(body.stream, false, 'the run end waits for one complete sentence');
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0]!.role, 'user');
  const prompt = body.messages[0]!.content[0]!.text;
  assert.equal(body.messages[0]!.content[0]!.type, 'text');
  assert.ok(!prompt.includes('不超过 40 字'), 'the hard character bound is gone, not mirrored in the prompt');
  assert.ok(prompt.includes('不设硬性字数'), 'the prompt asks for terseness instead of a count');
  assert.ok(prompt.includes('讲结果不讲过程'), 'and names what "terse" means for a spoken summary');
  assert.ok(prompt.includes(CONTEXT), 'the run output is what the side model summarizes');
  assert.ok(prompt.includes('<输出>') && prompt.includes('</输出>'), 'the pack is fenced as in B-1');
});

test('the default model is qwen-flash when the caller names none', async () => {
  const requests: CapturedRequest[] = [];
  const summarizer = createVoiceRealtimeRunEndSummarizer({
    apiKey: 'sk-live-voice',
    fetch: jsonFetch(200, { choices: [{ message: { content: '完成了。' } }] }, requests),
  });

  assert.equal(DEFAULT_VOICE_REALTIME_SUMMARY_MODEL, 'qwen-flash');
  await summarizer.summarize({ output: CONTEXT, runId: 'run-default' });

  const body = JSON.parse(String(requests[0]!.init.body)) as SummaryRequest;
  assert.equal(body.model, DEFAULT_VOICE_REALTIME_SUMMARY_MODEL, 'the leaf default is the model on the wire');
});

test('empty or whitespace content resolves to null', async () => {
  for (const content of ['', '   \n']) {
    const requests: CapturedRequest[] = [];
    const summarizer = createVoiceRealtimeRunEndSummarizer({
      apiKey: 'sk-live-voice',
      fetch: jsonFetch(200, { choices: [{ message: { content } }] }, requests),
    });
    assert.equal(await summarizer.summarize({ output: CONTEXT, runId: null }), null, JSON.stringify(content));
    assert.equal(requests.length, 1, 'the request was made; the ANSWER was empty');
  }
});

test('a non-2xx answer resolves to null', async () => {
  const requests: CapturedRequest[] = [];
  const summarizer = createVoiceRealtimeRunEndSummarizer({
    apiKey: 'sk-live-voice',
    fetch: jsonFetch(500, { error: { message: 'upstream is unwell' } }, requests),
  });

  assert.equal(await summarizer.summarize({ output: CONTEXT, runId: 'run-2' }), null);
  assert.equal(requests.length, 1);
});

test('a blank apiKey resolves to null without dialling', async () => {
  const requests: CapturedRequest[] = [];
  const summarizer = createVoiceRealtimeRunEndSummarizer({
    apiKey: '   ',
    fetch: jsonFetch(200, { choices: [{ message: { content: '不该出现' } }] }, requests),
  });

  assert.equal(await summarizer.summarize({ output: CONTEXT, runId: 'run-3' }), null);
  assert.equal(requests.length, 0, 'no credential means no request at all');
});

test('a network error or an unreadable body resolves to null instead of rejecting', async () => {
  const throwing = (async () => {
    throw new Error('socket hang up');
  }) as unknown as typeof fetch;
  const network = createVoiceRealtimeRunEndSummarizer({ apiKey: 'sk-live-voice', fetch: throwing });
  assert.equal(await network.summarize({ output: CONTEXT, runId: 'run-4' }), null);

  const requests: CapturedRequest[] = [];
  const unreadable = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    return new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const broken = createVoiceRealtimeRunEndSummarizer({ apiKey: 'sk-live-voice', fetch: unreadable });
  assert.equal(await broken.summarize({ output: CONTEXT, runId: 'run-5' }), null);
  assert.equal(requests.length, 1);
});
