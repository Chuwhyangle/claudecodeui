/**
 * Reply-suggestions usage-ledger criterion.
 *
 * The builders are asserted field-for-field against the JSONL contract the
 * offline benchmark reads, the writer is driven against a temp file for naming
 * and rotation, and `experiments/reply-suggestions-bench/bench.py` is spawned for
 * the two cross-checks its own `selftest --only replay` and `replay` provide.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/reply-suggestions/tests/reply-suggestions-usage-log.test.ts
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createReplySuggestionsUsageLog,
  eventRecord,
  failedRecord,
  shownRecord,
  type ReplySuggestionsUsageRecord,
} from '../reply-suggestions-usage-log.js';
import { createReplySuggestionsService } from '../reply-suggestions.service.js';
import { ApiCredential, type ReplySuggestionsSettings } from '../reply-suggestions-settings.js';
import { ReplySuggestionsClientError } from '../reply-suggestions-client.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const BENCH = path.join(REPO_ROOT, 'experiments/reply-suggestions-bench/bench.py');

function temporaryDirectory(t: { after(callback: () => void): void }, prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function parseLedger(filePath: string): Array<Record<string, unknown>> {
  return readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('(a) a shown record carries exactly the pre-existing field names, including served', () => {
  const row = shownRecord({
    at: '2026-10-24T00:00:00.000Z',
    sessionId: 'session-a',
    draw: 2,
    model: 'gateway-model',
    protocol: 'openai',
    version: 'v7',
    served: 'upstream',
    chips: ['chip-a', 'chip-b'],
  });
  assert.deepEqual(Object.keys(row), [
    'at', 'type', 'sessionId', 'draw', 'model', 'protocol', 'version', 'served', 'chips',
  ]);
  assert.equal(row.type, 'shown');
  assert.equal(row.at, '2026-10-24T00:00:00.000Z');
  assert.equal(row.sessionId, 'session-a');
  assert.equal(row.draw, 2);
  assert.equal(row.model, 'gateway-model');
  assert.equal(row.protocol, 'openai');
  assert.equal(row.version, 'v7');
  assert.equal(row.served, 'upstream');
  assert.deepEqual(row.chips, ['chip-a', 'chip-b']);

  // `expansion` is present only when the draw was an expansion, and it names the
  // anchor, never the seed/focus text.
  const expansion = shownRecord({
    at: '2026-10-24T00:00:01.000Z',
    sessionId: 'session-a',
    draw: 3,
    model: 'gateway-model',
    protocol: 'anthropic',
    version: 'v7',
    served: 'cache',
    expansion: 'seed',
    chips: [],
  });
  assert.equal(expansion.expansion, 'seed');
  assert.equal(expansion.served, 'cache');
  assert.equal('seed' in expansion, false);
});

test('(b) the four event records carry exactly the pre-existing field names', () => {
  const picked = eventRecord({
    at: '2026-10-24T00:00:02.000Z',
    sessionId: 'session-a',
    draw: 2,
    event: 'picked',
    index: 1,
  });
  assert.deepEqual(Object.keys(picked), ['at', 'type', 'sessionId', 'draw', 'index']);
  assert.equal(picked.type, 'picked');
  assert.equal(picked.index, 1);

  const cleared = eventRecord({ at: '2026-10-24T00:00:03.000Z', sessionId: 'session-a', draw: 2, event: 'cleared' });
  assert.deepEqual(Object.keys(cleared), ['at', 'type', 'sessionId', 'draw']);

  const redrawn = eventRecord({ at: '2026-10-24T00:00:04.000Z', sessionId: 'session-a', draw: 3, event: 'redrawn' });
  assert.equal(redrawn.type, 'redrawn');

  const sent = eventRecord({
    at: '2026-10-24T00:00:05.000Z',
    sessionId: 'session-a',
    draw: 3,
    event: 'sent',
    index: 0,
    source: 'seed',
  });
  assert.deepEqual(Object.keys(sent), ['at', 'type', 'sessionId', 'draw', 'index', 'source']);
  assert.equal(sent.source, 'seed');
});

test('(c) the writer appends JSONL and rotates once past the size cap', (t) => {
  const directory = temporaryDirectory(t, 'reply-usage-log-');
  const filePath = path.join(directory, 'usage.jsonl');
  const log = createReplySuggestionsUsageLog({ filePath });
  assert.equal(log.path, filePath);

  log.write(shownRecord({
    at: '2026-10-24T00:00:00.000Z',
    sessionId: 'session-a',
    draw: 1,
    model: 'm',
    protocol: 'anthropic',
    version: 'v1',
    served: 'upstream',
    chips: ['a'],
  }));
  const rows = parseLedger(filePath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'shown');

  // A tiny cap makes the second record rotate the first file to `.1`; there is
  // never a growing `.2`.
  const rotatedPath = path.join(directory, 'rotated.jsonl');
  const small = createReplySuggestionsUsageLog({ filePath: rotatedPath, maxBytes: 20 });
  small.write(eventRecord({ at: '2026-10-24T00:00:00.000Z', sessionId: 's', draw: 1, event: 'picked', index: 0 }));
  assert.equal(existsSync(`${rotatedPath}.1`), false, 'the first write did not rotate');
  small.write(eventRecord({ at: '2026-10-24T00:00:01.000Z', sessionId: 's', draw: 1, event: 'cleared' }));
  assert.ok(existsSync(`${rotatedPath}.1`), 'the previous ledger was rotated');
  assert.equal(existsSync(`${rotatedPath}.2`), false, 'there is never a growing .2');
  assert.equal(parseLedger(rotatedPath).length, 1, 'the active ledger holds only the new row');
});

test('(e) a failed record carries the failure reading and the service writes it only when usageLog is on', async (t) => {
  const failed = failedRecord({
    at: '2026-10-24T00:00:06.000Z',
    sessionId: 'session-a',
    requestId: 'a1b2c3d4',
    category: 'http',
    httpStatus: 502,
    durationMs: 41,
    model: 'gateway-model',
    protocol: 'anthropic',
  });
  assert.deepEqual(Object.keys(failed), [
    'at', 'type', 'sessionId', 'requestId', 'category', 'httpStatus', 'durationMs', 'model', 'protocol',
  ]);
  assert.equal(failed.type, 'failed');
  assert.equal(failed.requestId, 'a1b2c3d4');
  assert.equal(failed.httpStatus, 502);
  assert.equal(failed.category, 'http');

  const settings = (usageLog: boolean, filePath: string): ReplySuggestionsSettings => ({
    version: 'v1',
    enabled: true,
    upstream: {
      protocol: 'anthropic',
      baseUrl: 'http://gateway.invalid',
      model: 'gateway-model',
      authScheme: '',
      credential: new ApiCredential('sk-usage-secret'),
      disableThinking: true,
      timeoutMs: 5000,
    },
    generation: {
      temperature: 0.3,
      redrawTemperature: 1.0,
      maxOutputTokens: 400,
      maxChips: 3,
      maxChipChars: 120,
      maxTailChars: 1500,
      maxFocusChars: 600,
      systemPrompt: '',
      expansion: 'off',
    },
    limits: { maxCallsPerMinute: 30, maxCallsPerDay: 3000 },
    usageLog,
    debugLog: false,
    diagnostics: {
      source: 'file', path: filePath, problems: [], configuredEnabled: true, apiKeyFile: '', apiKeyVar: '',
    },
  });

  const directory = temporaryDirectory(t, 'reply-usage-failed-');
  const ledger = path.join(directory, 'usage.jsonl');

  // usageLog: false — the failed draw leaves no row at all.
  const offPath = path.join(directory, 'off.jsonl');
  const offSettings = settings(false, offPath);
  const off = createReplySuggestionsService({
    readSettings: () => offSettings,
    readLastAssistantMessage: async () => ({ id: 'assistant-1', text: '问题？' }),
    complete: async () => {
      throw new ReplySuggestionsClientError('http', 'upstream returned HTTP 502', 502);
    },
    usageLog: createReplySuggestionsUsageLog({ filePath: offPath }),
  });
  await assert.rejects(() => off.suggest({ sessionId: 's-off' }));
  assert.equal(existsSync(offPath), false, 'usageLog:false writes no failed row');

  // usageLog: true — exactly one failed row with the correlation facts.
  const onSettings = settings(true, ledger);
  const on = createReplySuggestionsService({
    readSettings: () => onSettings,
    readLastAssistantMessage: async () => ({ id: 'assistant-1', text: '问题？' }),
    complete: async () => {
      throw new ReplySuggestionsClientError('http', 'upstream returned HTTP 502', 502);
    },
    usageLog: createReplySuggestionsUsageLog({ filePath: ledger }),
  });
  await assert.rejects(() => on.suggest({ sessionId: 's-on' }));

  const rows = parseLedger(ledger);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'failed');
  assert.equal(rows[0].sessionId, 's-on');
  assert.equal(rows[0].httpStatus, 502);
  assert.equal(rows[0].category, 'http');
  assert.equal(typeof rows[0].requestId, 'string');
  assert.ok((rows[0].requestId as string).length >= 6);
  assert.equal(typeof rows[0].durationMs, 'number');
  assert.ok((rows[0].durationMs as number) >= 0);
  assert.equal(rows[0].model, 'gateway-model');
  assert.equal(rows[0].protocol, 'anthropic');
  assert.ok(!readFileSync(ledger, 'utf8').includes('sk-usage-secret'), 'the ledger never carries the key');

  // Rotation still keeps exactly one `.1` and never a growing `.2`.
  const rotating = createReplySuggestionsUsageLog({ filePath: path.join(directory, 'rot.jsonl'), maxBytes: 20 });
  rotating.write(failed);
  rotating.write(failed);
  assert.ok(existsSync(path.join(directory, 'rot.jsonl.1')), 'the older ledger was rotated');
  assert.equal(existsSync(path.join(directory, 'rot.jsonl.2')), false, 'there is never a growing .2');
});

test('(d) builder output written to a ledger is readable by the offline benchmark', (t) => {
  const directory = temporaryDirectory(t, 'reply-usage-replay-');
  const filePath = path.join(directory, 'usage.jsonl');
  const transcripts = path.join(directory, 'transcripts');
  // `replay` only reads transcripts for a picked-then-sent row; this leg leaves
  // those out, so an empty directory is enough for the replay's contract.
  rmSync(transcripts, { recursive: true, force: true });
  const log = createReplySuggestionsUsageLog({ filePath });
  const records: ReplySuggestionsUsageRecord[] = [
    shownRecord({
      at: '2026-10-24T00:00:00.000Z',
      sessionId: 'session-replay',
      draw: 1,
      model: 'gateway-model',
      protocol: 'anthropic',
      version: 'v1',
      served: 'upstream',
      chips: ['好，按计划继续', '先别改，我看下'],
    }),
    eventRecord({ at: '2026-10-24T00:00:01.000Z', sessionId: 'session-replay', draw: 1, event: 'picked', index: 0 }),
    shownRecord({
      at: '2026-10-24T00:00:02.000Z',
      sessionId: 'session-replay',
      draw: 2,
      model: 'gateway-model',
      protocol: 'anthropic',
      version: 'v1',
      served: 'upstream',
      chips: ['测吧'],
    }),
    eventRecord({ at: '2026-10-24T00:00:03.000Z', sessionId: 'session-replay', draw: 2, event: 'sent' }),
  ];
  for (const record of records) log.write(record);

  const selftest = spawnSync('python3', ['-I', BENCH, 'selftest', '--only', 'replay'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(selftest.status, 0, `bench selftest --only replay failed: ${selftest.stderr}`);
  assert.match(selftest.stdout, /\[selftest\] replay:/);

  const replay = spawnSync('python3', ['-I', BENCH, 'replay', '--ledger', filePath, '--transcripts', transcripts], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(replay.status, 0, `bench replay failed: ${replay.stderr}`);
  assert.match(replay.stdout, /upstream_calls\)=2/);
});
