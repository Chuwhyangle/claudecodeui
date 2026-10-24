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
  shownRecord,
  type ReplySuggestionsUsageRecord,
} from '../reply-suggestions-usage-log.js';

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
    source: 'focus',
  });
  assert.deepEqual(Object.keys(sent), ['at', 'type', 'sessionId', 'draw', 'index', 'source']);
  assert.equal(sent.source, 'focus');
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
