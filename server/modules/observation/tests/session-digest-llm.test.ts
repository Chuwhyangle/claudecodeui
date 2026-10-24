/**
 * The session digest's second (LLM) tier — the tier criterion.
 *
 * WHAT IT PROVES, case by case:
 *   · a turn is sent to the model only when the session is on somebody's watch list AND its
 *     readable conclusion reaches `minTurnChars`;
 *   · past `maxPerHour` the tier does not call again; the object says 「本轮未生成（限额）」;
 *   · a failing call keeps the deterministic digest and records the reason;
 *   · a successful call writes `tier: llm`, a one-sentence conclusion, the reply options and a
 *     drift note that carries 「仅作建议」;
 *   · EVERY call — success or failure — appends exactly one usage record (time, session, model,
 *     tokens, duration);
 *   · the settings reader merges `observation.sessionDigest` over the reply-suggestions gateway
 *     and never reports the key.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/observation/tests/session-digest-llm.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  observationDb,
  sessionsDb,
} from '@/modules/database/index.js';
import {
  createReplySuggestionsSettingsSource,
  type ReplySuggestionsCompletion,
  type ReplySuggestionsCompletionRequest,
  type ReplySuggestionsUsageLog,
} from '@/modules/reply-suggestions/index.js';

import { formatSessionUri } from '../observation-uri.js';
import { createObservationStore } from '../observation-store.js';
import { createSessionDigestProducer, type SessionTurnEndEvent } from '../session-digest.producer.js';
import {
  createSessionDigestLlmTier,
  SESSION_DIGEST_LLM_ADVISORY,
  SESSION_DIGEST_LLM_LIMIT_REASON,
  type SessionDigestLlmTier,
} from '../session-digest-llm.js';
import {
  createSessionDigestLlmSettingsSource,
  type SessionDigestLlmSettings,
} from '../session-digest-llm-settings.js';

const USER_ID = 'llm-tier-watcher';
const SESSION_TITLE = '修复登录刷新';

let temporaryDirectory = '';
let previousDatabasePath: string | undefined;
let clock = 3_000_000;

test.before(async () => {
  previousDatabasePath = process.env.DATABASE_PATH;
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'observation-session-digest-llm-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(temporaryDirectory, 'auth.db');
  await initializeDatabase();
});

test.after(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) {
    delete process.env.DATABASE_PATH;
  } else {
    process.env.DATABASE_PATH = previousDatabasePath;
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test.beforeEach(() => {
  const db = getConnection();
  db.exec('DELETE FROM observed_revisions');
  db.exec('DELETE FROM observed_objects');
  db.exec('DELETE FROM observation_seen_cursors');
  db.exec('DELETE FROM observation_watch_entries');
  clock = 3_000_000;
});

// ── the injected world ──────────────────────────────────────────────────────

/** A settings reading with the tier ON and every gateway field resolved. */
function settings(overrides: Partial<SessionDigestLlmSettings> = {}): SessionDigestLlmSettings {
  return {
    enabled: true,
    configuredEnabled: true,
    model: 'cheap-digest-model',
    maxPerHour: 6,
    minTurnChars: 5,
    apiKeyFile: '',
    protocol: 'anthropic',
    baseUrl: 'http://gateway.invalid',
    authScheme: '',
    disableThinking: true,
    timeoutMs: 5000,
    maxOutputTokens: 400,
    temperature: 0.2,
    apiKey: 'test-key',
    source: 'default',
    path: null,
    problems: [],
    ...overrides,
  };
}

/** The JSON answer the stub model returns, as the client's completion shape. */
function completion(answer: Record<string, unknown>): ReplySuggestionsCompletion {
  return { text: JSON.stringify(answer), inputTokens: 11, outputTokens: 7 };
}

type Harness = {
  tier: SessionDigestLlmTier;
  store: ReturnType<typeof createObservationStore>;
  calls: ReplySuggestionsCompletionRequest[];
  usage: Array<Record<string, unknown>>;
};

/**
 * Builds the tier over the real DB-backed store and a stub completion. The deterministic
 * producer and the tier share ONE store instance, exactly as production does.
 */
function buildHarness(options: {
  readSettings?: () => SessionDigestLlmSettings;
  answer?: (request: ReplySuggestionsCompletionRequest) => Promise<ReplySuggestionsCompletion>;
}): Harness {
  const store = createObservationStore({ now: () => clock });
  const calls: ReplySuggestionsCompletionRequest[] = [];
  const usage: Array<Record<string, unknown>> = [];
  const usageLog: ReplySuggestionsUsageLog = {
    path: 'memory',
    write(record) {
      usage.push(record);
    },
  };
  const tier = createSessionDigestLlmTier({
    deterministic: createSessionDigestProducer({ store, now: () => clock }),
    store,
    readSettings: options.readSettings ?? (() => settings()),
    complete: async (request) => {
      calls.push(request);
      if (options.answer !== undefined) return options.answer(request);
      return completion({
        conclusion: '登录刷新循环已修复。',
        options: ['继续跑全量测试', '先补一条回归'],
        driftNote: '与本会话目标略有偏离',
      });
    },
    usageLog,
    now: () => clock,
  });
  return { tier, store, calls, usage };
}

/** Writes a transcript file into this criterion's own temp dir and returns its path. */
async function writeTranscript(name: string, rows: unknown[]): Promise<string> {
  const filePath = path.join(temporaryDirectory, name);
  await writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return filePath;
}

/** Records one app-owned session row pointing at `jsonlPath`. */
function createSessionRow(sessionId: string, jsonlPath: string): void {
  sessionsDb.createSession(sessionId, 'claude', temporaryDirectory, SESSION_TITLE, undefined, undefined, jsonlPath);
}

/** Pins a session, which is the observation layer's "someone is watching this" fact. */
function watch(sessionId: string): void {
  clock += 1;
  observationDb.writeWatchEntry(USER_ID, formatSessionUri(sessionId), clock);
}

/** One finished turn: a user prompt and the assistant's final paragraph. */
function turnRows(sessionId: string, prompt: string, reply: string): unknown[] {
  return [
    { type: 'user', uuid: `${sessionId}-u`, sessionId, message: { role: 'user', content: [{ type: 'text', text: prompt }] } },
    { type: 'assistant', uuid: `${sessionId}-a`, sessionId, message: { role: 'assistant', content: [{ type: 'text', text: reply }] } },
  ];
}

function turnEnd(sessionId: string): SessionTurnEndEvent {
  clock += 1;
  return { appSessionId: sessionId, runId: `run-${clock}`, status: 'completed', completedAt: clock, error: null };
}

// ---------------------------------------------------------------------------------------------
// AC1 — the gating and the write paths
// ---------------------------------------------------------------------------------------------

test('AC1: a watched, long-enough turn writes tier=llm with options and an advisory drift note', async () => {
  const sessionId = 'llm-success';
  createSessionRow(sessionId, await writeTranscript('success.jsonl', turnRows(sessionId, '修一下登录刷新', '已修复刷新循环，登录不再反复刷新。')));
  watch(sessionId);
  const harness = buildHarness({});

  const object = await harness.tier.handleTurnEnd(turnEnd(sessionId));
  assert.ok(object !== null);

  assert.equal(object.provenance.tier, 'llm');
  assert.equal(object.provenance.producer, 'session-digest-llm');
  const llm = object.digest.llm as Record<string, unknown>;
  assert.equal(llm.state, 'evaluated');
  assert.equal(llm.conclusion, '登录刷新循环已修复。');
  assert.deepEqual(llm.options, ['继续跑全量测试', '先补一条回归']);
  assert.match(String(llm.driftNote), /仅作建议/);
  assert.equal(llm.advisory, SESSION_DIGEST_LLM_ADVISORY);

  // The deterministic document is preserved underneath the second tier.
  const deterministic = object.digest.conclusion as Record<string, unknown>;
  assert.equal(deterministic.text, '已修复刷新循环，登录不再反复刷新。');
  assert.equal(deterministic.tier, 'deterministic');

  // One call, one usage record; the record names the session, the model, the tokens and the time.
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0]?.config.model, 'cheap-digest-model');
  assert.equal(harness.usage.length, 1);
  const record = harness.usage[0] ?? {};
  assert.equal(record.type, 'observation.session-digest-llm');
  assert.equal(record.sessionId, sessionId);
  assert.equal(record.uri, formatSessionUri(sessionId));
  assert.equal(record.state, 'ok');
  assert.equal(record.inputTokens, 11);
  assert.equal(record.outputTokens, 7);
  assert.equal(typeof record.durationMs, 'number');
  assert.equal(typeof record.at, 'number');
});

test('AC1: a session outside the watch list is never sent to the model', async () => {
  const sessionId = 'llm-unwatched';
  // Ends with a question, so the deterministic producer still writes an attention object.
  createSessionRow(sessionId, await writeTranscript('unwatched.jsonl', turnRows(sessionId, '下一步做什么？', '要我先跑测试，还是先改文档？')));
  const harness = buildHarness({});

  const object = await harness.tier.handleTurnEnd(turnEnd(sessionId));
  assert.ok(object !== null);
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.usage.length, 0);
  assert.equal(object.provenance.tier, 'deterministic');
  assert.equal(object.digest.llm, undefined);
});

test('AC1: a turn below minTurnChars is never sent to the model', async () => {
  const sessionId = 'llm-short';
  createSessionRow(sessionId, await writeTranscript('short.jsonl', turnRows(sessionId, 'ok?', '好。')));
  watch(sessionId);
  const harness = buildHarness({ readSettings: () => settings({ minTurnChars: 1000 }) });

  const object = await harness.tier.handleTurnEnd(turnEnd(sessionId));
  assert.ok(object !== null);
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.usage.length, 0);
  assert.equal(object.digest.llm, undefined);
});

test('AC1: past maxPerHour the tier skips and marks the object with the limit reason', async () => {
  const sessionId = 'llm-limit';
  createSessionRow(sessionId, await writeTranscript('limit.jsonl', turnRows(sessionId, '修一下登录刷新', '已修复刷新循环，登录不再反复刷新。')));
  watch(sessionId);
  const harness = buildHarness({ readSettings: () => settings({ maxPerHour: 1 }) });

  const first = await harness.tier.handleTurnEnd(turnEnd(sessionId));
  assert.ok(first !== null);
  assert.equal((first.digest.llm as Record<string, unknown>).state, 'evaluated');

  const second = await harness.tier.handleTurnEnd(turnEnd(sessionId));
  assert.ok(second !== null);
  const llm = second.digest.llm as Record<string, unknown>;
  assert.equal(llm.state, 'skipped');
  assert.equal(llm.reason, SESSION_DIGEST_LLM_LIMIT_REASON);
  assert.match(String(llm.reason), /限额/);
  assert.equal(harness.calls.length, 1, 'the second turn must not reach the model');
  assert.equal(harness.usage.length, 1, 'a skipped turn is not a call');
  // The deterministic reading is still there.
  assert.equal((second.digest.conclusion as Record<string, unknown>).tier, 'deterministic');
});

test('AC1: a failing call keeps the deterministic digest and records the reason and usage', async () => {
  const sessionId = 'llm-failure';
  createSessionRow(sessionId, await writeTranscript('failure.jsonl', turnRows(sessionId, '修一下登录刷新', '已修复刷新循环，登录不再反复刷新。')));
  watch(sessionId);
  const harness = buildHarness({
    answer: async () => {
      throw new Error('gateway is down');
    },
  });

  const object = await harness.tier.handleTurnEnd(turnEnd(sessionId));
  assert.ok(object !== null);
  const llm = object.digest.llm as Record<string, unknown>;
  assert.equal(llm.state, 'unevaluated');
  assert.match(String(llm.reason), /模型调用失败/);
  assert.match(String(llm.reason), /gateway is down/);
  assert.equal(object.provenance.tier, 'deterministic', 'a failed model call is not an LLM reading');

  // The deterministic reading it was layered on survives untouched.
  assert.equal(
    (object.digest.conclusion as Record<string, unknown>).text,
    '已修复刷新循环，登录不再反复刷新。',
  );
  assert.equal(harness.usage.length, 1);
  assert.equal(harness.usage[0]?.state, 'failed');
  assert.match(String(harness.usage[0]?.reason), /gateway is down/);
});

test('AC1: a malformed model answer is a failure with a stated reason, not a throw', async () => {
  const sessionId = 'llm-malformed';
  createSessionRow(sessionId, await writeTranscript('malformed.jsonl', turnRows(sessionId, '修一下登录刷新', '已修复刷新循环，登录不再反复刷新。')));
  watch(sessionId);
  const harness = buildHarness({ answer: async () => ({ text: 'not json at all', inputTokens: 3, outputTokens: 1 }) });

  const object = await harness.tier.handleTurnEnd(turnEnd(sessionId));
  assert.ok(object !== null);
  const llm = object.digest.llm as Record<string, unknown>;
  assert.equal(llm.state, 'unevaluated');
  assert.match(String(llm.reason), /模型输出不可用/);
  assert.equal(harness.usage.length, 1);
  assert.equal(harness.usage[0]?.inputTokens, 3);
  assert.equal(harness.usage[0]?.state, 'failed');
});

// ---------------------------------------------------------------------------------------------
// AC1 — the settings reader the tier calls through
// ---------------------------------------------------------------------------------------------

test('AC1: the settings reader merges observation.sessionDigest over the reply-suggestions gateway', async () => {
  const keyPath = path.join(temporaryDirectory, 'llm-key.txt');
  await writeFile(keyPath, 'sk-test-secret\n', { encoding: 'utf8', mode: 0o600 });
  const replyPath = path.join(temporaryDirectory, 'reply-suggestions.settings.json');
  await writeFile(
    replyPath,
    JSON.stringify({ enabled: true, protocol: 'openai', baseUrl: 'http://gw.local/v1', model: 'reply-model', apiKeyFile: keyPath }),
    'utf8',
  );
  const serverPath = path.join(temporaryDirectory, 'server.settings.json');
  await writeFile(
    serverPath,
    JSON.stringify({
      observation: {
        wallLimit: 12,
        sessionDigest: { enabled: true, model: 'digest-model', maxPerHour: 3, minTurnChars: 50 },
      },
    }),
    'utf8',
  );

  const source = createSessionDigestLlmSettingsSource({
    settingsPath: serverPath,
    homeDir: temporaryDirectory,
    replySource: createReplySuggestionsSettingsSource({ settingsPath: replyPath, homeDir: temporaryDirectory }),
  });
  const reading = source.read();

  assert.equal(reading.enabled, true);
  assert.equal(reading.model, 'digest-model');
  assert.equal(reading.maxPerHour, 3);
  assert.equal(reading.minTurnChars, 50);
  assert.equal(reading.protocol, 'openai');
  assert.equal(reading.baseUrl, 'http://gw.local/v1');
  assert.equal(reading.apiKey, 'sk-test-secret');
  // The key itself never appears in a reported problem.
  assert.equal(reading.problems.some((problem) => problem.includes('sk-test-secret')), false);
});

test('AC1: a malformed block falls back field by field and names the problem', async () => {
  const replyPath = path.join(temporaryDirectory, 'reply-suggestions.second.json');
  await writeFile(
    replyPath,
    JSON.stringify({ enabled: true, baseUrl: 'http://gw.local', model: 'reply-model', apiKeyFile: '' }),
    'utf8',
  );
  const serverPath = path.join(temporaryDirectory, 'server.second.json');
  await writeFile(
    serverPath,
    JSON.stringify({ observation: { sessionDigest: { enabled: true, maxPerHour: 'many', minTurnChars: -1 } } }),
    'utf8',
  );

  const source = createSessionDigestLlmSettingsSource({
    settingsPath: serverPath,
    homeDir: temporaryDirectory,
    replySource: createReplySuggestionsSettingsSource({ settingsPath: replyPath, homeDir: temporaryDirectory }),
  });
  const reading = source.read();

  assert.equal(reading.maxPerHour, 6, 'the shipped default replaces the malformed value');
  assert.equal(reading.minTurnChars, 200);
  assert.equal(reading.problems.some((problem) => problem.includes('maxPerHour')), true);
  assert.equal(reading.problems.some((problem) => problem.includes('minTurnChars')), true);
  // No key resolved (the reply-suggestions file names none), so the effective switch is off.
  assert.equal(reading.enabled, false);
  assert.equal(reading.problems.some((problem) => problem.includes('API key')), true);
});

test('AC1: with no settings file the tier is off and reports nothing', () => {
  const source = createSessionDigestLlmSettingsSource({
    settingsPath: null,
    homeDir: temporaryDirectory,
    replySource: { read: () => ({
      version: 'test',
      enabled: false,
      configuredEnabled: false,
      protocol: 'anthropic',
      baseUrl: '',
      model: '',
      authScheme: '',
      apiKeyFile: '',
      apiKeyVar: '',
      disableThinking: true,
      temperature: 0.3,
      redrawTemperature: 1,
      maxOutputTokens: 400,
      timeoutMs: 5000,
      maxChips: 3,
      maxChipChars: 120,
      maxTailChars: 1500,
      maxFocusChars: 600,
      maxCallsPerMinute: 30,
      maxCallsPerDay: 3000,
      expansion: 'off',
      usageLog: true,
      systemPrompt: '',
      apiKey: '',
      source: 'default',
      path: null,
      problems: [],
    }) },
  });
  const reading = source.read();
  assert.equal(reading.enabled, false);
  assert.equal(reading.maxPerHour, 6);
  assert.equal(reading.minTurnChars, 200);
  assert.deepEqual(reading.problems, []);
});
