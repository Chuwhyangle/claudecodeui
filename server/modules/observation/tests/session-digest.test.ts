/**
 * The session-digest producer's criteria (AC1, AC2).
 *
 * AC1 — the deterministic reading, over the fixed transcript fixture:
 *   · edited files are deduplicated and keep first-touched order;
 *   · vitest / node --test / playwright summaries each yield pass/fail counts, and output none
 *     of them recognizes reads `unevaluated` with a reason;
 *   · a paragraph ending in a question, and one ending in numbered options, both read as
 *     「问你」; a statement does not;
 *   · the conclusion is the assistant's own final paragraph, truncated to ~280 characters and
 *     marked `tier: 'deterministic'`.
 *
 * AC2 — the write path:
 *   · one turn-end event writes exactly one revision, and the next event bumps it by one;
 *   · a session nobody watches that ends on a statement is not written at all;
 *   · an unreadable transcript writes `unevaluated` with a reason.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/observation/tests/session-digest.test.ts
 */
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  observationDb,
  sessionsDb,
} from '@/modules/database/index.js';

import { formatSessionUri } from '../observation-uri.js';
import { createObservationStore } from '../observation-store.js';
import {
  analyzeAsking,
  buildSessionDigest,
  parseTestOutput,
  SESSION_DIGEST_CONCLUSION_CHARS,
} from '../session-digest.js';
import { createSessionDigestProducer } from '../session-digest.producer.js';

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(TEST_DIRECTORY, 'fixtures', 'session-transcript.jsonl');
const USER_ID = 'digest-watcher';

let temporaryDirectory = '';
let previousDatabasePath: string | undefined;
let clock = 2_000_000;

const store = createObservationStore({ now: () => clock });
const producer = createSessionDigestProducer({ store, now: () => clock });

test.before(async () => {
  previousDatabasePath = process.env.DATABASE_PATH;
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'observation-session-digest-'));
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
  clock = 2_000_000;
});

/** Writes a transcript file into this criterion's own temp dir and returns its path. */
async function writeTranscript(name: string, rows: unknown[]): Promise<string> {
  const filePath = path.join(temporaryDirectory, name);
  await writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return filePath;
}

/** Records one app-owned session row pointing at `jsonlPath`. */
function createSessionRow(sessionId: string, jsonlPath: string | null): void {
  sessionsDb.createSession(sessionId, 'claude', temporaryDirectory, `Session ${sessionId}`, undefined, undefined, jsonlPath);
}

/** Pins a session, which is the observation layer's "someone is watching this" fact. */
function watch(sessionId: string): void {
  clock += 1;
  observationDb.writeWatchEntry(USER_ID, formatSessionUri(sessionId), clock);
}

/** One turn that ends on a statement, with no question and no failing test. */
const STATEMENT_ROWS = [
  {
    type: 'user',
    uuid: 's-u1',
    sessionId: 'statement-session',
    message: { role: 'user', content: [{ type: 'text', text: '跑一下测试' }] },
  },
  {
    type: 'assistant',
    uuid: 's-a1',
    sessionId: 'statement-session',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: '改动已经完成，测试全绿。' }],
    },
  },
];

// ---------------------------------------------------------------------------------------------
// AC1 — the deterministic reading
// ---------------------------------------------------------------------------------------------

test('AC1: the fixed fixture dedupes edited files and parses the vitest summary', async () => {
  const raw = await readFile(FIXTURE_PATH, 'utf8');
  const result = buildSessionDigest(raw);

  assert.equal(result.state, 'evaluated');
  if (result.state !== 'evaluated') return;
  const { digest } = result;

  // Edit /repo/src/login.tsx twice, Write /repo/src/login.test.ts once — two distinct files.
  assert.deepEqual(digest.changedFiles, ['/repo/src/login.tsx', '/repo/src/login.test.ts']);

  assert.deepEqual(digest.commands, ['Run login tests']);
  assert.deepEqual(digest.tests, {
    state: 'evaluated',
    runner: 'vitest',
    passed: 8,
    failed: 1,
  });

  // Two real user prompts, so the delta baseline is not hard-coded to one.
  assert.equal(digest.turnCount, 2);
});

test('AC1: vitest, node --test and playwright summaries each yield their own counts', () => {
  assert.deepEqual(parseTestOutput('      Tests  1 failed | 8 passed (9)\n'), {
    state: 'evaluated',
    runner: 'vitest',
    passed: 8,
    failed: 1,
  });

  assert.deepEqual(parseTestOutput('# tests 5\n# pass 4\n# fail 1\n'), {
    state: 'evaluated',
    runner: 'node-test',
    passed: 4,
    failed: 1,
  });

  assert.deepEqual(parseTestOutput('  1 failed\n  9 passed (5.2s)\n'), {
    state: 'evaluated',
    runner: 'playwright',
    passed: 9,
    failed: 1,
  });
});

test('AC1: the repo\'s own tsx --test invocation is read as a node --test run', () => {
  // Every server criterion in this repo runs node's test runner through the TS loader. The
  // command gate must recognise that shape, not only a literal `node --test`.
  const rows = [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'run the criterion' }] } },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 't-tsx',
            name: 'Bash',
            input: {
              command:
                'npx tsx --tsconfig server/tsconfig.json --test server/modules/observation/tests/session-digest.test.ts',
              description: 'Run the digest criterion',
            },
          },
        ],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't-tsx',
            content: [{ type: 'text', text: 'ℹ tests 9\nℹ pass 9\nℹ fail 0\n' }],
          },
        ],
      },
    },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'The criterion passes.' }] },
    },
  ];

  const result = buildSessionDigest(rows.map((row) => JSON.stringify(row)).join('\n'));

  assert.equal(result.state, 'evaluated');
  if (result.state !== 'evaluated') return;
  assert.deepEqual(result.digest.tests, { state: 'evaluated', runner: 'node-test', passed: 9, failed: 0 });
});

test('AC1: output no runner recognizes reads unevaluated with a reason', () => {
  const reading = parseTestOutput('all good, nothing to report\n');

  assert.equal(reading.state, 'unevaluated');
  if (reading.state !== 'unevaluated') return;
  assert.match(reading.reason, /未识别/);

  // A skipped run's `0 passed / 0 failed` is a readable summary but not a green reading.
  const vacuous = parseTestOutput('ℹ tests 1\nℹ pass 0\nℹ fail 0\nℹ skipped 1\n');
  assert.equal(vacuous.state, 'unevaluated');
  if (vacuous.state !== 'unevaluated') return;
  assert.match(vacuous.reason, /0 通过 0 失败/);
});

test('AC1: a question ending and a numbered-options ending both ask you, a statement does not', () => {
  assert.equal(analyzeAsking('要不要我现在就把旧断言改掉？').isAsking, true);
  assert.equal(analyzeAsking('要不要我现在就把旧断言改掉？').question, '要不要我现在就把旧断言改掉？');

  const options = analyzeAsking('你可以选一个：\n1. 继续改登录页\n2. 先补测试');
  assert.equal(options.isAsking, true);
  assert.deepEqual(options.options, ['继续改登录页', '先补测试']);

  const statement = analyzeAsking('改动已经完成，测试全绿。');
  assert.equal(statement.isAsking, false);
  assert.deepEqual(statement.options, []);
});

test('AC1: the conclusion is the final paragraph, truncated and marked deterministic', async () => {
  const raw = await readFile(FIXTURE_PATH, 'utf8');
  const result = buildSessionDigest(raw);

  assert.equal(result.state, 'evaluated');
  if (result.state !== 'evaluated') return;
  const { conclusion, askingYou } = result.digest;

  assert.equal(conclusion.tier, 'deterministic');
  assert.equal(conclusion.label, '原文摘录');
  assert.equal(conclusion.truncated, true);
  assert.equal(conclusion.text.length, SESSION_DIGEST_CONCLUSION_CHARS);
  // The tail is kept, so the question and its options survive the excerpt.
  assert.match(conclusion.text, /下一步你想怎么处理/);
  assert.match(conclusion.text, /2\. 先补一条新的回归测试/);
  assert.equal(askingYou.isAsking, true);
  assert.equal(askingYou.options.length, 2);
});

// ---------------------------------------------------------------------------------------------
// AC2 — the write path
// ---------------------------------------------------------------------------------------------

test('AC2: one turn-end event writes one revision and the next event bumps it by one', async () => {
  const sessionId = 'watched-asking-session';
  const transcript = await writeTranscript('watched.jsonl', [
    { type: 'user', uuid: 'w-u1', message: { role: 'user', content: [{ type: 'text', text: '怎么办？' }] } },
    {
      type: 'assistant',
      uuid: 'w-a1',
      message: { role: 'assistant', content: [{ type: 'text', text: '要我现在就动手吗？' }] },
    },
  ]);
  createSessionRow(sessionId, transcript);
  watch(sessionId);
  const uri = formatSessionUri(sessionId);

  const first = await producer.handleTurnEnd({
    appSessionId: sessionId,
    runId: 'run-1',
    status: 'completed',
    completedAt: clock,
    error: null,
  });

  assert.notEqual(first, null);
  assert.equal(first?.revision, 1);
  assert.equal(first?.status.state, 'attention');
  assert.equal(store.listRevisions(uri, 0).length, 1);

  clock += 1_000;
  const second = await producer.handleTurnEnd({
    appSessionId: sessionId,
    runId: 'run-2',
    status: 'completed',
    completedAt: clock,
    error: null,
  });

  assert.equal(second?.revision, 2);
  assert.equal(store.listRevisions(uri, 0).length, 2);
});

test('AC2: a session nobody watches that ends on a statement is not written', async () => {
  const sessionId = 'unwatched-idle-session';
  const transcript = await writeTranscript('statement.jsonl', STATEMENT_ROWS);
  createSessionRow(sessionId, transcript);

  const written = await producer.handleTurnEnd({
    appSessionId: sessionId,
    runId: 'run-3',
    status: 'completed',
    completedAt: clock,
    error: null,
  });

  assert.equal(written, null);
  // The control: the SAME transcript IS written once someone watches it, so the skip above is
  // the watch rule and not some unrelated early return.
  watch(sessionId);
  const watched = await producer.handleTurnEnd({
    appSessionId: sessionId,
    runId: 'run-4',
    status: 'completed',
    completedAt: clock,
    error: null,
  });
  assert.equal(watched?.status.state, 'ok');
});

test('AC2: a failed run reads red even when the transcript ends on a statement', async () => {
  const sessionId = 'watched-failing-session';
  const transcript = await writeTranscript('failing.jsonl', STATEMENT_ROWS);
  createSessionRow(sessionId, transcript);
  watch(sessionId);

  const written = await producer.handleTurnEnd({
    appSessionId: sessionId,
    runId: 'run-5',
    status: 'completed',
    completedAt: clock,
    error: 'provider exited with code 1',
  });

  assert.equal(written?.status.state, 'red');
  assert.equal(written?.status.reason, 'provider exited with code 1');
});

test('AC2: a missing transcript writes unevaluated with a reason', async () => {
  const sessionId = 'watched-missing-transcript';
  createSessionRow(sessionId, path.join(temporaryDirectory, 'does-not-exist.jsonl'));
  watch(sessionId);

  const written = await producer.handleTurnEnd({
    appSessionId: sessionId,
    runId: 'run-6',
    status: 'completed',
    completedAt: clock,
    error: null,
  });

  assert.equal(written?.status.state, 'unevaluated');
  assert.equal(typeof written?.status.reason, 'string');
  assert.notEqual(written?.status.reason, '');
  assert.match(String(written?.digest.unevaluatedReason), /transcript/);
});
