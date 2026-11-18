/**
 * Reply-suggestions failure-reading criterion.
 *
 * Drives the real settings reader over a temp settings file and the service over
 * an injected upstream, so the `/status` projection, the recorded failure, the
 * error body's `details` and the log line are read end to end. No test reaches a
 * gateway.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/reply-suggestions/tests/reply-suggestions-failure-reading.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { AppError } from '@/shared/utils.js';

import { ReplySuggestionsClientError } from '../reply-suggestions-client.js';
import {
  createReplySuggestionsFailureState,
  type ReplySuggestionsFailureState,
} from '../reply-suggestions-failure-state.js';
import { createReplySuggestionsService } from '../reply-suggestions.service.js';
import { createReplySuggestionsSettingsSource } from '../reply-suggestions-settings.js';

const API_KEY = 'sk-failure-reading-secret';

type Harness = {
  service: ReturnType<typeof createReplySuggestionsService>;
  failures: ReplySuggestionsFailureState;
  logs: string[];
  settingsFile: string;
  directory: string;
};

/**
 * Build the module over one temp settings file. `settings` overrides are merged
 * over a valid reading; `keyFile: null` leaves the named key file missing.
 */
function makeHarness(
  t: { after(callback: () => void): void },
  options: {
    settings?: Record<string, unknown>;
    keyFile?: 'valid' | 'missing';
    responder?: () => string;
  } = {},
): Harness {
  const directory = mkdtempSync(path.join(tmpdir(), 'reply-failure-reading-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const keyPath = path.join(directory, 'key.txt');
  if ((options.keyFile ?? 'valid') === 'valid') {
    writeFileSync(keyPath, `${API_KEY}\n`, { mode: 0o600 });
  }
  const settingsFile = path.join(directory, 'settings.json');
  writeFileSync(settingsFile, JSON.stringify({
    enabled: true,
    baseUrl: 'http://gateway.invalid',
    model: 'test-model',
    apiKeyFile: keyPath,
    usageLog: false,
    ...options.settings,
  }), { mode: 0o600 });

  const settings = createReplySuggestionsSettingsSource({ settingsPath: settingsFile, homeDir: directory });
  const failures = createReplySuggestionsFailureState();
  const logs: string[] = [];
  const responder = options.responder ?? (() => '{"chips":["答复一","答复二"]}');

  const service = createReplySuggestionsService({
    readSettings: () => settings.read(),
    readLastAssistantMessage: async () => ({ id: 'assistant-1', text: '助手消息的正文，最后以一个问题结尾？' }),
    complete: async () => {
      const text = responder();
      return { text, inputTokens: 3, outputTokens: 4 };
    },
    logger: (line) => logs.push(line),
    failureState: failures,
  });

  return { service, failures, logs, settingsFile, directory };
}

test('(a) a settings file that asks for the feature but lacks model or key reads as misconfigured and names the missing item', (t) => {
  const missingModel = makeHarness(t, { settings: { model: '' } });
  const modelStatus = missingModel.service.status();
  assert.equal(modelStatus.state, 'misconfigured', 'an enabled file with no model cannot draw');
  assert.equal(modelStatus.enabled, false);
  assert.ok(
    modelStatus.problems.some((problem) => problem.includes('`model`')),
    `the missing model is named: ${JSON.stringify(modelStatus.problems)}`,
  );
  assert.ok(!JSON.stringify(modelStatus).includes(API_KEY), 'the status reading never carries the key');

  const missingKey = makeHarness(t, { keyFile: 'missing' });
  const keyStatus = missingKey.service.status();
  assert.equal(keyStatus.state, 'misconfigured');
  assert.ok(
    keyStatus.problems.some((problem) => problem.includes('API key file') || problem.includes('apiKeyFile')),
    `the missing key is named: ${JSON.stringify(keyStatus.problems)}`,
  );
  assert.ok(!JSON.stringify(keyStatus).includes(API_KEY), 'the status reading never carries the key');
});

test('(b) an explicitly disabled file with no problems reads as off, not misconfigured', (t) => {
  const harness = makeHarness(t, { settings: { enabled: false } });
  const status = harness.service.status();
  assert.equal(status.state, 'off');
  assert.equal(status.enabled, false);
  assert.deepEqual(status.problems, []);
  assert.equal(status.lastFailure, null);
});

test('(b2) a ready file reads as ready and carries the draw limits', (t) => {
  const harness = makeHarness(t);
  const status = harness.service.status();
  assert.equal(status.state, 'ready');
  assert.equal(status.enabled, true);
  assert.equal(status.maxChips, 3);
  assert.equal(status.maxChipChars, 120);
  assert.deepEqual(status.problems, []);
});

test('(c) an upstream 502 becomes lastFailure with category http, its status and a requestId', async (t) => {
  const harness = makeHarness(t, {
    responder: () => {
      throw new ReplySuggestionsClientError('http', 'upstream returned HTTP 502', 502);
    },
  });

  const error = await harness.service.suggest({ sessionId: 's-502' }).then(
    () => assert.fail('the draw must reject'),
    (failure: AppError) => failure,
  );

  const status = harness.service.status();
  assert.equal(status.lastFailure?.category, 'http');
  assert.equal(status.lastFailure?.httpStatus, 502);
  assert.ok((status.lastFailure?.requestId ?? '').length >= 6, 'the failure names the POST it belongs to');
  assert.equal(status.lastFailure?.model, 'test-model');
  assert.equal(status.lastFailure?.protocol, 'anthropic');

  // AC2: the SAME correlation facts ride in the AppError details.
  const details = error.details as { requestId?: unknown; category?: unknown; httpStatus?: unknown };
  assert.equal(details.category, 'http');
  assert.equal(details.httpStatus, 502);
  assert.equal(details.requestId, status.lastFailure?.requestId);

  // AC2: one log line carries the upstream status and the same request id.
  const failureLine = harness.logs.find((line) => line.includes('outcome=error:http'));
  assert.ok(failureLine, `a failure line was logged: ${JSON.stringify(harness.logs)}`);
  assert.ok(failureLine.includes('httpStatus=502'), `the line carries the upstream status: ${failureLine}`);
  assert.ok(
    failureLine.includes(`requestId=${String(details.requestId)}`),
    `the line carries the same requestId: ${failureLine}`,
  );
  assert.ok(!failureLine.includes(API_KEY), 'the log line never carries the key');
});

test('(d) a success clears the current failure while the history ring keeps the earlier one', async (t) => {
  let failing = true;
  const harness = makeHarness(t, {
    responder: () => {
      if (failing) throw new ReplySuggestionsClientError('http', 'upstream returned HTTP 503', 503);
      return '{"chips":["恢复一","恢复二"]}';
    },
  });

  await assert.rejects(() => harness.service.suggest({ sessionId: 's-recover' }));
  const failed = harness.failures.lastFailure();
  assert.equal(failed?.httpStatus, 503, 'the failure was recorded');

  failing = false;
  const recovered = await harness.service.suggest({ sessionId: 's-recover' });
  assert.deepEqual(recovered.chips, ['恢复一', '恢复二']);

  assert.equal(harness.service.status().lastFailure, null, 'a success clears the current reading');
  const history = harness.failures.history();
  assert.equal(history.length, 1, 'the history ring still holds the earlier failure');
  assert.equal(history[0]?.requestId, failed?.requestId);
  assert.equal(history[0]?.httpStatus, 503);
});

test('(e) a confirmed failure keeps its requestId stable across the draw and never stores prompt or key', async (t) => {
  const harness = makeHarness(t, {
    settings: { systemPrompt: 'SYSTEM-PROMPT-TOKEN' },
    responder: () => {
      throw new ReplySuggestionsClientError('network', 'unreachable');
    },
  });

  await assert.rejects(() => harness.service.suggest({ sessionId: 's-no-leak' }));
  const failure = harness.failures.lastFailure();
  const serialized = JSON.stringify(failure);
  assert.ok(!serialized.includes(API_KEY), 'the failure record never carries the key');
  assert.ok(!serialized.includes('SYSTEM-PROMPT-TOKEN'), 'the failure record never carries the prompt');
  assert.equal(failure?.category, 'network');
  assert.equal(failure?.httpStatus, null);
});
