/**
 * AC1 — the decision queue's counter-voice, driven through the REAL service with a stub
 * completion and a memory usage ledger.
 *
 * What this file proves:
 *   ① a first read generates and caches: a second read of the same item answers from the cache
 *      and makes no second call;
 *   ② the model input is ONLY the question, its options and the evidence references — no
 *      transcript, no session, no conversation history (a subject smuggling one contributes
 *      nothing, because the input shape has no field for it);
 *   ③ the sliding-hour budget answers 「未生成：限额」 without paying for another call;
 *   ④ a failed call answers the reason and writes a failed usage record;
 *   ⑤ every call — success or failure — writes exactly one usage record;
 *   ⑥ a successful reading is marked `kind: llm` and carries 「仅作建议」.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/quay/tests/counter-voice.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createReplySuggestionsSettingsSource } from '@/modules/reply-suggestions/index.js';
import type { ReplySuggestionsCompletionRequest } from '@/modules/reply-suggestions/index.js';

import {
  COUNTER_VOICE_ADVISORY,
  COUNTER_VOICE_DISABLED_REASON,
  COUNTER_VOICE_LIMIT_REASON,
  createCounterVoice,
  type CounterVoiceSubject,
} from '../counter-voice.js';
import {
  createCounterVoiceSettingsSource,
  type CounterVoiceSettings,
} from '../counter-voice-settings.js';

/** The shipped-shape reading the service consumes, with only the fields this criterion cares about. */
function settings(overrides: Partial<CounterVoiceSettings> = {}): CounterVoiceSettings {
  return {
    enabled: true,
    configuredEnabled: true,
    model: 'cheap-model',
    maxPerHour: 10,
    apiKeyFile: '',
    protocol: 'openai',
    baseUrl: 'http://gateway.invalid/v1',
    authScheme: 'bearer',
    disableThinking: true,
    timeoutMs: 5000,
    maxOutputTokens: 400,
    temperature: 0.3,
    apiKey: 'test-key',
    source: 'file',
    path: '/tmp/counter-voice.settings.json',
    problems: [],
    ...overrides,
  };
}

/** One queue item's subject; `initiative` is deliberately absent from the model input. */
function subject(overrides: Partial<CounterVoiceSubject> = {}): CounterVoiceSubject {
  return {
    attentionId: 'att_queue_one',
    initiative: 'initiative-hidden-from-the-prompt',
    question: 'Should the initiative view own the queue, or link to the fleet UI?',
    options: [
      { id: 'own-it', label: 'Draw the queue in the cockpit' },
      { id: 'link-out', label: 'Link to the fleet UI' },
    ],
    evidence: ['decisions.jsonl@dec_1 — the fleet keeps the ledger', 'events.jsonl@evt_9'],
    ...overrides,
  };
}

/** The model's declared answer; the fence and prose exercise the parser's tolerance. */
const ANSWER = JSON.stringify({
  ignored: ['The cost of a second queue surface is not in the evidence.', 'Who owns mobile layout?'],
  strongestCounter: 'Two queues drift, and the person then rules on the stale one.',
  falsifier: 'A week of rulings where the fleet UI is the only surface opened.',
});

/** A completion stub that records every request and answers one fixed reading. */
function recordingCompletion(answer: string = ANSWER): {
  complete: (request: ReplySuggestionsCompletionRequest) => Promise<{
    text: string;
    inputTokens: number | null;
    outputTokens: number | null;
  }>;
  requests: ReplySuggestionsCompletionRequest[];
} {
  const requests: ReplySuggestionsCompletionRequest[] = [];
  return {
    requests,
    complete: async (request) => {
      requests.push(request);
      return { text: `\`\`\`json\n${answer}\n\`\`\``, inputTokens: 11, outputTokens: 22 };
    },
  };
}

/** A memory ledger: every row the service writes, in order. */
function memoryUsageLog(): {
  log: { path: string; write(record: Record<string, unknown>): void };
  records: Record<string, unknown>[];
} {
  const records: Record<string, unknown>[] = [];
  return { records, log: { path: '(memory)', write: (record) => void records.push(record) } };
}

test('a first read generates and caches; the second read calls nothing', async () => {
  const { complete, requests } = recordingCompletion();
  const { log, records } = memoryUsageLog();
  const service = createCounterVoice({
    readSettings: () => settings(),
    complete,
    usageLog: log,
    now: () => 1_000,
  });

  const first = await service.read(subject());
  assert.equal(first.state, 'ready');
  assert.equal(first.kind, 'llm');
  if (first.state !== 'ready') throw new Error('unreachable');
  assert.deepEqual(first.ignored, [
    'The cost of a second queue surface is not in the evidence.',
    'Who owns mobile layout?',
  ]);
  assert.equal(first.strongestCounter, 'Two queues drift, and the person then rules on the stale one.');
  assert.equal(first.falsifier, 'A week of rulings where the fleet UI is the only surface opened.');
  assert.equal(first.advisory, COUNTER_VOICE_ADVISORY);

  const second = await service.read(subject());
  assert.deepEqual(second, first);
  // 「同一条目不重复生成」: the cache absorbed the second read.
  assert.equal(requests.length, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.type, 'cockpit.counter-voice');
  assert.equal(records[0]!.state, 'ok');
  assert.equal(records[0]!.attentionId, 'att_queue_one');
  assert.equal(records[0]!.model, 'cheap-model');
  assert.equal(records[0]!.inputTokens, 11);
  assert.equal(records[0]!.outputTokens, 22);
});

test('the model input is only the question, options and evidence references', async () => {
  const { complete, requests } = recordingCompletion();
  const service = createCounterVoice({
    readSettings: () => settings(),
    complete,
    usageLog: memoryUsageLog().log,
    now: () => 2_000,
  });

  // A subject that ALSO carries a transcript/session at runtime: the input shape has no field
  // for them, so they must not reach the request.
  const smuggled = {
    ...subject({ attentionId: 'att_smuggled', initiative: 'initiative-secret-slug' }),
    transcript: 'TRANSCRIPT-SHOULD-NOT-LEAK',
    sessionId: 'SESSION-SHOULD-NOT-LEAK',
    history: [{ role: 'user', content: 'HISTORY-SHOULD-NOT-LEAK' }],
  } as unknown as CounterVoiceSubject;

  const reading = await service.read(smuggled);
  assert.equal(reading.state, 'ready');
  assert.equal(requests.length, 1);
  const request = requests[0]!;

  // The request carries exactly the completion contract — no transcript-shaped field.
  assert.deepEqual(Object.keys(request).sort(), [
    'config',
    'maxOutputTokens',
    'system',
    'temperature',
    'user',
  ]);
  const serialised = JSON.stringify(request);
  for (const marker of [
    'TRANSCRIPT-SHOULD-NOT-LEAK',
    'SESSION-SHOULD-NOT-LEAK',
    'HISTORY-SHOULD-NOT-LEAK',
    'initiative-secret-slug',
  ]) {
    assert.equal(serialised.includes(marker), false, `the request leaked ${marker}`);
  }
  assert.equal(/transcript|conversation|sessionId|history/i.test(serialised), false);

  // …and the three allowed inputs are what the prompt actually holds.
  assert.equal(request.user.includes(subject().question), true);
  assert.equal(request.user.includes('Draw the queue in the cockpit'), true);
  assert.equal(request.user.includes('own-it'), true);
  assert.equal(request.user.includes('decisions.jsonl@dec_1'), true);
});

test('over maxPerHour answers 「未生成：限额」 without another call', async () => {
  const { complete, requests } = recordingCompletion();
  const { log, records } = memoryUsageLog();
  const service = createCounterVoice({
    readSettings: () => settings({ maxPerHour: 1 }),
    complete,
    usageLog: log,
    now: () => 3_000,
  });

  const first = await service.read(subject({ attentionId: 'att_one' }));
  assert.equal(first.state, 'ready');
  assert.equal(requests.length, 1);

  const second = await service.read(subject({ attentionId: 'att_two' }));
  assert.equal(second.state, 'unavailable');
  assert.equal(second.kind, 'none');
  if (second.state !== 'unavailable') throw new Error('unreachable');
  assert.equal(second.reason, COUNTER_VOICE_LIMIT_REASON);
  assert.equal(second.reason, '未生成：限额');

  // The budget gate runs BEFORE the call: one request, and one ledger row for it.
  assert.equal(requests.length, 1);
  assert.equal(records.length, 1);

  // The skip is not cached: once the hour frees a slot, the same item can be generated.
  const later = createCounterVoice({
    readSettings: () => settings({ maxPerHour: 1 }),
    complete,
    usageLog: log,
    now: () => 3_000 + 60 * 60 * 1000,
  });
  const third = await later.read(subject({ attentionId: 'att_two' }));
  assert.equal(third.state, 'ready');
  assert.equal(requests.length, 2);
});

test('a failed call answers the reason and writes one failed usage record', async () => {
  const { log, records } = memoryUsageLog();
  let calls = 0;
  const service = createCounterVoice({
    readSettings: () => settings(),
    complete: async () => {
      calls += 1;
      throw new Error('gateway unreachable');
    },
    usageLog: log,
    now: () => 4_000,
  });

  const reading = await service.read(subject());
  assert.equal(reading.state, 'unavailable');
  if (reading.state !== 'unavailable') throw new Error('unreachable');
  assert.equal(reading.reason.includes('未生成：模型调用失败'), true);
  assert.equal(reading.reason.includes('gateway unreachable'), true);

  assert.equal(records.length, 1);
  assert.equal(records[0]!.state, 'failed');
  assert.equal(records[0]!.reason, 'gateway unreachable');
  assert.equal(records[0]!.attentionId, 'att_queue_one');

  // A failure is transient: it is NOT cached, so a later read may try again.
  await service.read(subject());
  assert.equal(calls, 2);
});

test('a disabled feature answers 「未生成：未启用」 and makes no call', async () => {
  const { complete, requests } = recordingCompletion();
  const { log, records } = memoryUsageLog();
  const service = createCounterVoice({
    readSettings: () => settings({ enabled: false }),
    complete,
    usageLog: log,
    now: () => 5_000,
  });

  const reading = await service.read(subject());
  assert.equal(reading.state, 'unavailable');
  if (reading.state !== 'unavailable') throw new Error('unreachable');
  assert.equal(reading.reason, COUNTER_VOICE_DISABLED_REASON);
  assert.equal(requests.length, 0);
  assert.equal(records.length, 0);
});

test('the settings reader merges cockpit.counterVoice over the reply-suggestions gateway', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'counter-voice-settings-'));
  try {
    const keyFile = path.join(home, 'gateway.key');
    await writeFile(keyFile, 'sk-test-key\n');
    const replyPath = path.join(home, 'reply.settings.json');
    await writeFile(
      replyPath,
      JSON.stringify({
        enabled: true,
        protocol: 'openai',
        baseUrl: 'http://gateway.example/v1',
        model: 'reply-model',
        apiKeyFile: keyFile,
        maxOutputTokens: 321,
        temperature: 0.4,
      }),
    );
    const serverPath = path.join(home, 'server.settings.json');
    await writeFile(
      serverPath,
      JSON.stringify({
        cockpit: { counterVoice: { enabled: true, model: 'cheap-counter', maxPerHour: 3 } },
      }),
    );

    const source = createCounterVoiceSettingsSource({
      settingsPath: serverPath,
      homeDir: home,
      replySource: createReplySuggestionsSettingsSource({ settingsPath: replyPath, homeDir: home }),
    });
    const reading = source.read();

    assert.equal(reading.enabled, true);
    assert.equal(reading.model, 'cheap-counter');
    assert.equal(reading.maxPerHour, 3);
    assert.equal(reading.baseUrl, 'http://gateway.example/v1');
    assert.equal(reading.maxOutputTokens, 321);
    assert.equal(reading.temperature, 0.4);
    assert.equal(reading.apiKey, 'sk-test-key');
    assert.deepEqual(reading.problems, []);

    // An empty block model falls back to the reply-suggestions model, and an empty key path to
    // the reply-suggestions key — the block adds knobs, it does not duplicate the gateway. A
    // second path (not an in-place rewrite) keeps this off the reader's mtime cache.
    const fallbackPath = path.join(home, 'server.settings.fallback.json');
    await writeFile(fallbackPath, JSON.stringify({ cockpit: { counterVoice: { enabled: true } } }));
    const fallback = createCounterVoiceSettingsSource({
      settingsPath: fallbackPath,
      homeDir: home,
      replySource: createReplySuggestionsSettingsSource({ settingsPath: replyPath, homeDir: home }),
    }).read();
    assert.equal(fallback.model, 'reply-model');
    assert.equal(fallback.apiKey, 'sk-test-key');
    assert.equal(fallback.maxPerHour, 12);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
