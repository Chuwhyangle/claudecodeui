/**
 * Reply-suggestions service criterion.
 *
 * The service is driven over fake seams (transcript reader, upstream `complete`,
 * clock, logger, usage-log path), so each reading is deterministic and no test
 * reaches a gateway.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/reply-suggestions/tests/reply-suggestions-service.test.ts
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ReplySuggestionsClientError,
  type ReplySuggestionsCompletion,
  type ReplySuggestionsCompletionRequest,
} from '../reply-suggestions-client.js';
import {
  characterSetOverlap,
  createReplySuggestionsService,
  parseSuggestionChips,
  REPLY_SUGGESTIONS_CIRCUIT_COOLDOWN_MS,
  type ReplySuggestionsService,
} from '../reply-suggestions.service.js';
import type { ReplySuggestionsSettings } from '../reply-suggestions-settings.js';

const API_KEY = 'sk-service-secret-value';

function baseSettings(overrides: Partial<ReplySuggestionsSettings> = {}): ReplySuggestionsSettings {
  return {
    version: 'test-1',
    enabled: true,
    configuredEnabled: true,
    protocol: 'anthropic',
    baseUrl: 'http://gateway.invalid',
    model: 'test-model',
    authScheme: '',
    apiKeyFile: '',
    apiKeyVar: '',
    disableThinking: true,
    temperature: 0.3,
    redrawTemperature: 1.0,
    maxOutputTokens: 400,
    timeoutMs: 5000,
    maxChips: 3,
    maxChipChars: 120,
    maxTailChars: 1500,
    maxFocusChars: 600,
    maxCallsPerMinute: 30,
    maxCallsPerDay: 3000,
    expansion: 'off',
    usageLog: false,
    systemPrompt: '',
    apiKey: API_KEY,
    source: 'file',
    path: '/tmp/reply-suggestions-settings.json',
    problems: [],
    ...overrides,
  };
}

type Responder = (
  request: ReplySuggestionsCompletionRequest,
  callIndex: number,
) => string | ReplySuggestionsCompletion | Promise<string | ReplySuggestionsCompletion>;

type Harness = {
  service: ReplySuggestionsService;
  calls: Array<{ system: string; user: string; temperature: number; maxOutputTokens: number }>;
  logs: string[];
  settings: ReplySuggestionsSettings;
  advance(ms: number): void;
  setNow(value: number): void;
  usageLogPath: string;
};

function makeHarness(
  t: { after(callback: () => void): void },
  options: {
    settings?: Partial<ReplySuggestionsSettings>;
    messageText?: string | null;
    messageId?: string;
    responder?: Responder;
    usageLog?: { path: string; maxBytes?: number };
  } = {},
): Harness {
  const calls: Harness['calls'] = [];
  const logs: string[] = [];
  let clock = 1_800_000_000_000;
  const settings = baseSettings(options.settings);
  const messageText = options.messageText === undefined ? '助手消息的正文，最后以一个问题结尾？' : options.messageText;
  const responder: Responder = options.responder ?? (() => '{"chips":["alpha-1","beta-2","gamma-3"]}');
  const usageLogPath = options.usageLog?.path ?? path.join(mkdtempSync(path.join(tmpdir(), 'reply-svc-')), 'usage.jsonl');

  const service = createReplySuggestionsService({
    readSettings: () => settings,
    readLastAssistantMessage: async () => (messageText === null ? null : { id: options.messageId ?? 'assistant-1', text: messageText }),
    complete: async (request) => {
      calls.push({
        system: request.system,
        user: request.user,
        temperature: request.temperature,
        maxOutputTokens: request.maxOutputTokens,
      });
      const value = await responder(request, calls.length);
      return typeof value === 'string' ? { text: value, inputTokens: 5, outputTokens: 7 } : value;
    },
    now: () => clock,
    logger: (line) => logs.push(line),
    ...(options.usageLog === undefined
      ? {}
      : {
          usageLogPath: options.usageLog.path,
          ...(options.usageLog.maxBytes === undefined ? {} : { usageLogMaxBytes: options.usageLog.maxBytes }),
        }),
  });

  t.after(() => {
    if (options.usageLog === undefined) rmSync(path.dirname(usageLogPath), { recursive: true, force: true });
  });

  return {
    service,
    calls,
    logs,
    settings,
    advance: (ms: number) => {
      clock += ms;
    },
    setNow: (value: number) => {
      clock = value;
    },
    usageLogPath,
  };
}

/** A responder that answers each call with a fixed chip list. */
function chips(...values: string[]): string {
  return JSON.stringify({ chips: values });
}

test('(a) parsing accepts the three answer shapes and enforces the chip rules', async (t) => {
  const objectForm = makeHarness(t, { responder: () => chips('a', 'b', 'c') });
  assert.deepEqual((await objectForm.service.suggest({ sessionId: 's-object' })).chips, ['a', 'b', 'c']);

  const bareForm = makeHarness(t, { responder: () => '["a","b"]' });
  assert.deepEqual((await bareForm.service.suggest({ sessionId: 's-bare' })).chips, ['a', 'b']);

  const fenced = makeHarness(t, { responder: () => '```json\n{"chips":["a","b"]}\n```' });
  assert.deepEqual((await fenced.service.suggest({ sessionId: 's-fenced' })).chips, ['a', 'b']);

  const truncated = makeHarness(t, {
    settings: { maxChipChars: 3 },
    responder: () => chips('abcdef', 'xy'),
  });
  assert.deepEqual((await truncated.service.suggest({ sessionId: 's-clip' })).chips, ['abc', 'xy']);

  const cleaned = makeHarness(t, { responder: () => chips(' a ', 'a', '', 'b') });
  assert.deepEqual((await cleaned.service.suggest({ sessionId: 's-clean' })).chips, ['a', 'b']);

  const capped = makeHarness(t, {
    settings: { maxChips: 2 },
    responder: () => chips('a', 'b', 'c'),
  });
  assert.deepEqual((await capped.service.suggest({ sessionId: 's-cap' })).chips, ['a', 'b']);

  const nonString = makeHarness(t, { responder: () => '{"chips":["a",5]}' });
  await assert.rejects(() => nonString.service.suggest({ sessionId: 's-nonstring' }), /upstream request failed/);

  const unparseable = makeHarness(t, { responder: () => 'definitely not json' });
  await assert.rejects(() => unparseable.service.suggest({ sessionId: 's-unparseable' }), /upstream request failed/);
});

test('(b) the prompt tail and the focus are clipped to their configured maxima', async (t) => {
  const message = '0123456789ABCDEFGHIJ';
  const harness = makeHarness(t, {
    settings: { maxTailChars: 10, maxFocusChars: 5 },
    messageText: message,
    responder: () => chips('a', 'b', 'c'),
  });
  await harness.service.suggest({ sessionId: 's-clip-prompt', focus: 'FOCUS-TOO-LONG' });
  const prompt = harness.calls[0].user;
  assert.ok(prompt.includes('ABCDEFGHIJ'), 'the tail keeps the LAST maxTailChars characters');
  assert.ok(!prompt.includes('0123456789'), 'the earlier tail is dropped');
  assert.ok(prompt.includes('FOCUS'), 'the focus is present');
  assert.ok(!prompt.includes('FOCUS-TOO-LONG'), 'the focus is clipped to maxFocusChars');
});

test('(c) a first draw uses temperature; a redraw uses redrawTemperature and lists the shown chips', async (t) => {
  const first = ['first-a', 'first-b', 'first-c'];
  const second = ['second-a', 'second-b', 'second-c'];
  const harness = makeHarness(t, {
    settings: { temperature: 0.3, redrawTemperature: 1.4 },
    responder: (_request, index) => chips(...(index === 1 ? first : second)),
  });

  const firstDraw = await harness.service.suggest({ sessionId: 's-temp' });
  assert.deepEqual(firstDraw.chips, first);
  assert.equal(harness.calls[0].temperature, 0.3);

  const redraw = await harness.service.suggest({ sessionId: 's-temp', redraw: true });
  assert.equal(harness.calls[1].temperature, 1.4);
  for (const chip of first) {
    assert.ok(harness.calls[1].user.includes(chip), `the redraw prompt lists the shown chip ${chip}`);
  }
  assert.equal(redraw.draw, 2);
});

test('(d) a near-duplicate of a shown chip is filtered, and fewer than two survivors supplements exactly once', async (t) => {
  // Character sets: A/B are shared, C is extra, so overlap = |{A,B}| / |{A,B,C}| = 0.667 < 0.7.
  assert.ok(characterSetOverlap('AAAAABBBBB', 'AAAAABBBBC') < 0.7);
  assert.ok(characterSetOverlap('AAAAABBBBB', 'AAAAABBBB') >= 0.7);

  const harness = makeHarness(t, {
    responder: (_request, index) => {
      if (index === 1) return chips('AAAAABBBBB', 'CCCCCDDDDD', 'EEEEEFFFFF');
      if (index === 2) return chips('AAAAABBBB', 'GGGGGHHHHH'); // one near-duplicate, one new
      return chips('IIIIIJJJJJ', 'KKKKKLLLLL');
    },
  });

  const firstDraw = await harness.service.suggest({ sessionId: 's-near' });
  assert.equal(firstDraw.chips.length, 3);

  const secondDraw = await harness.service.suggest({ sessionId: 's-near', redraw: true });
  assert.equal(harness.calls.length, 3, 'the supplement ran exactly once');
  assert.ok(!secondDraw.chips.includes('AAAAABBBB'), 'the near-duplicate of a shown chip is dropped');
  assert.equal(secondDraw.chips[0], 'GGGGGHHHHH');
  assert.equal(secondDraw.chips.length, 3, 'the supplement filled the draw up to maxChips');
});

test('(e) only new chips are returned and the draw counter increments', async (t) => {
  const batch = ['AAAAABBBBB', 'CCCCCDDDDD', 'EEEEEFFFFF'];
  const harness = makeHarness(t, { responder: () => chips(...batch) });

  const firstDraw = await harness.service.suggest({ sessionId: 's-new' });
  assert.deepEqual(firstDraw, { chips: batch, draw: 1 });

  // The same answer on a redraw is entirely already shown, so nothing is new.
  // (< 2 survivors triggers one supplement, which also repeats -> still empty.)
  const secondDraw = await harness.service.suggest({ sessionId: 's-new', redraw: true });
  assert.deepEqual(secondDraw, { chips: [], draw: 2 });
  assert.equal(harness.calls.length, 3, 'one call for the first draw, two (draw + supplement) for the second');
});

test('(f) no assistant message returns an empty draw without calling upstream', async (t) => {
  const harness = makeHarness(t, { messageText: null });
  const result = await harness.service.suggest({ sessionId: 's-empty' });
  assert.deepEqual(result, { chips: [], draw: 0 });
  assert.equal(harness.calls.length, 0);
});

test('(g) identical concurrent requests share one upstream call', async (t) => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const harness = makeHarness(t, {
    responder: async () => {
      await gate;
      return chips('a', 'b', 'c');
    },
  });

  const first = harness.service.suggest({ sessionId: 's-concurrent' });
  const second = harness.service.suggest({ sessionId: 's-concurrent' });
  await new Promise((resolve) => setImmediate(resolve));
  release?.();
  const [left, right] = await Promise.all([first, second]);

  assert.deepEqual(left, right);
  assert.equal(harness.calls.length, 1);
});

test('(h1) the per-minute cap answers a rate-limit error', async (t) => {
  const harness = makeHarness(t, {
    settings: { maxCallsPerMinute: 2, maxCallsPerDay: 3000 },
    responder: () => chips('a', 'b', 'c'),
  });
  await harness.service.suggest({ sessionId: 's-minute-1' });
  await harness.service.suggest({ sessionId: 's-minute-2' });
  await assert.rejects(
    () => harness.service.suggest({ sessionId: 's-minute-3' }),
    (failure: { statusCode?: number; code?: string }) => {
      assert.equal(failure.statusCode, 429);
      assert.equal(failure.code, 'REPLY_SUGGESTIONS_RATE_LIMITED');
      return true;
    },
  );
  assert.equal(harness.calls.length, 2, 'the rejected request never reached upstream');
});

test('(h2) the per-day cap answers a rate-limit error', async (t) => {
  const harness = makeHarness(t, {
    settings: { maxCallsPerMinute: 100, maxCallsPerDay: 2 },
    responder: () => chips('a', 'b', 'c'),
  });
  await harness.service.suggest({ sessionId: 's-day-1' });
  await harness.service.suggest({ sessionId: 's-day-2' });
  await assert.rejects(
    () => harness.service.suggest({ sessionId: 's-day-3' }),
    (failure: { statusCode?: number }) => failure.statusCode === 429,
  );
  assert.equal(harness.calls.length, 2);
});

test('(i) five consecutive failures open the circuit; the cooldown restores it (injected clock)', async (t) => {
  let failuresLeft = 5;
  const harness = makeHarness(t, {
    responder: () => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new ReplySuggestionsClientError('http', 'upstream returned HTTP 500', 500);
      }
      return chips('a', 'b', 'c');
    },
  });

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await assert.rejects(() => harness.service.suggest({ sessionId: `s-circuit-${attempt}` }), /upstream request failed/);
  }
  assert.equal(harness.calls.length, 5);

  // Open: the next request fails without a sixth upstream call.
  await assert.rejects(() => harness.service.suggest({ sessionId: 's-circuit-open' }), /upstream request failed/);
  assert.equal(harness.calls.length, 5, 'the open circuit does not call upstream');

  harness.advance(REPLY_SUGGESTIONS_CIRCUIT_COOLDOWN_MS + 1);
  const recovered = await harness.service.suggest({ sessionId: 's-circuit-recovered' });
  assert.equal(recovered.chips.length, 3);
  assert.equal(harness.calls.length, 6, 'the cooldown lets one trial call through');
});

test('(j) log lines carry model/protocol/version/duration/tokens but no conversation, chip or key', async (t) => {
  const tail = 'CONVERSATION-TAIL-TOKEN';
  const chipText = 'CHIP-TEXT-TOKEN';
  const harness = makeHarness(t, {
    messageText: `question before the end ${tail}?`,
    responder: () => chips(chipText, 'another-chip', 'third-chip'),
  });
  await harness.service.suggest({ sessionId: 's-log' });

  assert.ok(harness.logs.length >= 1);
  const line = harness.logs[0];
  for (const fragment of ['protocol=', 'model=test-model', 'version=test-1', 'durationMs=', 'outcome=ok', 'outputTokens=7']) {
    assert.ok(line.includes(fragment), `the log line carries ${fragment}: ${line}`);
  }
  for (const forbidden of [tail, chipText, API_KEY]) {
    assert.ok(!line.includes(forbidden), `the log line must not carry ${forbidden}`);
  }
});

test('(k) the usage ledger writes shown plus every event, and rotates past its cap', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'reply-usage-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ledger = path.join(directory, 'usage.jsonl');

  const harness = makeHarness(t, {
    settings: { usageLog: true },
    responder: () => chips('chip-one', 'chip-two', 'chip-three'),
    usageLog: { path: ledger, maxBytes: 5 * 1024 * 1024 },
  });

  await harness.service.suggest({ sessionId: 's-ledger' });
  harness.service.recordEvent({ sessionId: 's-ledger', draw: 1, event: 'picked', index: 0 });
  harness.service.recordEvent({ sessionId: 's-ledger', draw: 1, event: 'cleared' });
  harness.service.recordEvent({ sessionId: 's-ledger', draw: 2, event: 'redrawn' });
  harness.service.recordEvent({ sessionId: 's-ledger', draw: 2, event: 'sent', index: 1 });

  const lines = readFileSync(ledger, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(lines.length, 5);
  assert.equal(lines[0].type, 'shown');
  for (const key of ['at', 'sessionId', 'draw', 'model', 'protocol', 'version', 'chips']) {
    assert.ok(key in lines[0], `the shown row carries ${key}`);
  }
  assert.deepEqual(lines.slice(1).map((row) => row.type), ['picked', 'cleared', 'redrawn', 'sent']);
  assert.equal(lines[1].index, 0);
  assert.equal(lines[4].index, 1);

  // Rotation: with a tiny cap the second record must move the first file aside.
  const rotated = path.join(directory, 'rotated.jsonl');
  const small = makeHarness(t, {
    settings: { usageLog: true },
    usageLog: { path: rotated, maxBytes: 20 },
  });
  small.service.recordEvent({ sessionId: 's-rotate', draw: 1, event: 'picked', index: 0 });
  small.service.recordEvent({ sessionId: 's-rotate', draw: 1, event: 'cleared' });
  assert.ok(existsSync(`${rotated}.1`), 'the previous ledger was rotated to .1');
  assert.equal(readFileSync(rotated, 'utf8').trim().split('\n').length, 1, 'the active ledger is a fresh file');
});

test('parseSuggestionChips is exported for the acceptance criterion', () => {
  assert.deepEqual(parseSuggestionChips('["x","y"]'), ['x', 'y']);
});

test('(l) expansion off refuses expand:true with 400 and never calls upstream', async (t) => {
  const harness = makeHarness(t, { responder: () => chips('a', 'b', 'c') });
  assert.equal(harness.settings.expansion, 'off');
  await assert.rejects(
    () => harness.service.suggest({ sessionId: 's-expand-off', expand: true, seed: 'picked reply' }),
    (failure: { statusCode?: number; code?: string }) => {
      assert.equal(failure.statusCode, 400);
      assert.equal(failure.code, 'REPLY_SUGGESTIONS_EXPANSION_DISABLED');
      return true;
    },
  );
  await assert.rejects(
    () => harness.service.suggest({ sessionId: 's-expand-off-focus', expand: true, focus: 'quoted passage' }),
    (failure: { statusCode?: number }) => failure.statusCode === 400,
  );
  assert.equal(harness.calls.length, 0, 'a refused expansion never reaches upstream');
});

test('(m) a vary seed draw prompts with the seed and 变体, clips the seed, filters its near-duplicates, and marks the ledger', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'reply-expand-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ledger = path.join(directory, 'usage.jsonl');
  const seed = 'AAAAABBBBB-VERY-LONG-SEED';
  const harness = makeHarness(t, {
    settings: { expansion: 'vary', maxChipChars: 10, usageLog: true },
    responder: () => chips('AAAAABBBB', 'CCCCCDDDDD', 'EEEEEFFFFF'),
    usageLog: { path: ledger },
  });

  const draw = await harness.service.suggest({
    sessionId: 's-expand-seed',
    expand: true,
    seed,
  });

  const prompt = harness.calls[0].user;
  assert.ok(prompt.includes('变体'), 'the seed prompt asks for 变体');
  assert.ok(prompt.includes('AAAAABBBB'), 'the seed is present, clipped to maxChipChars');
  assert.ok(!prompt.includes('VERY-LONG-SEED'), 'the seed is clipped, not sent whole');
  assert.equal(harness.calls.length, 1, 'two surviving chips need no supplement');

  // The exact seed's near-duplicate is filtered; the two new texts survive.
  assert.deepEqual(draw.chips, ['CCCCCDDDDD', 'EEEEEFFFFF']);

  const rows = readFileSync(ledger, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  const shown = rows.find((row) => row.type === 'shown');
  assert.ok(shown !== undefined);
  assert.equal(shown.expansion, 'seed', 'the shown row names the expansion source');
  assert.equal('seed' in shown, false, 'the marker never copies the seed text into the ledger');
});

test('(n) a vary draw with an empty seed and a focus prompts for 回应 to that passage', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'reply-expand-focus-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ledger = path.join(directory, 'usage.jsonl');
  const harness = makeHarness(t, {
    settings: { expansion: 'vary', usageLog: true },
    responder: () => chips('回应一', '回应二'),
    usageLog: { path: ledger },
  });

  await harness.service.suggest({
    sessionId: 's-expand-focus',
    expand: true,
    seed: '',
    focus: 'QUOTED-PASSAGE',
  });

  const prompt = harness.calls[0].user;
  assert.ok(prompt.includes('QUOTED-PASSAGE'), 'the quoted passage is the focus');
  assert.ok(prompt.includes('回应'), 'the focus prompt asks for 回应');
  assert.equal(harness.calls.length, 1);

  const rows = readFileSync(ledger, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(rows[0].expansion, 'focus');
});

test('(o) a normal redraw with focus still works while expansion is off, and a seed without expand is refused', async (t) => {
  const harness = makeHarness(t, {
    settings: { expansion: 'off' },
    responder: () => chips('一', '二', '三'),
  });

  const redraw = await harness.service.suggest({ sessionId: 's-normal-focus', redraw: true, focus: 'FOCUS-TEXT' });
  assert.equal(redraw.chips.length, 3);
  assert.ok(harness.calls[0].user.includes('FOCUS-TEXT'));

  await assert.rejects(
    () => harness.service.suggest({ sessionId: 's-seed-no-expand', seed: 'not-an-expansion' }),
    (failure: { statusCode?: number }) => failure.statusCode === 400,
  );
  assert.equal(harness.calls.length, 1, 'the refused shape made no second upstream call');
});
