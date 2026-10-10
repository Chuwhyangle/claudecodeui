#!/usr/bin/env node
/**
 * The reconciliation checker's own criterion — AC-322.
 *
 * WHAT THIS FILE IS FOR. `voice-realtime-reconcile.mjs --self-test` proves the checker separates a
 * good record from four bad ones; this file pins the parts of that separation that a self-test line
 * does not: WHICH check fired, the parser's reading of the two tables, the tolerance boundary, and
 * that the pending-bill path reports "not reconciled" rather than a pass.
 *
 * The document fixture is built here (not read from `docs/operations/`), so a change to the record
 * file cannot silently change what this criterion asserts. The record itself is checked by running
 * the script against it, which is what the task's AC does.
 *
 *     node --test scripts/voice-realtime-reconcile.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { checkRecord, parseRecord, priceOf, selfTest } from './voice-realtime-reconcile.mjs';

/** One per-response row of the SPEC's default pack: 1,450 text in, 21 audio in, 18 out. */
const ROW = { textInput: '1450', audioInput: '21', textOutput: '18', logEstimateCny: '0.002382', usageSumCny: '0.002382' };

/**
 * A consistent record: two responses of the fixture row, two segments, a pending bill.
 *
 * @param {{ reading?: Record<string, string>, row?: Record<string, string> }} [overrides]
 * @returns {string}
 */
function record(overrides = {}) {
  const readings = {
    segments: '2',
    audioSecondsUpstream: '6.0',
    textInputTokens: '2900',
    audioInputTokens: '42',
    textOutputTokens: '36',
    logEstimateCny: '0.004764',
    usageSumCny: '0.004764',
    bill: 'pending-external',
    ...overrides.reading,
  };
  /** @type {Record<string, string>} */
  const row = { ...ROW, ...overrides.row };
  const keys = ['textInput', 'audioInput', 'textOutput', 'logEstimateCny', 'usageSumCny'];
  return [
    '## 读数',
    '',
    '| 指标 | 值 |',
    '| --- | --- |',
    ...Object.entries(readings).map(([key, value]) => `| ${key} | ${value} |`),
    '',
    '## 逐响应',
    '',
    `| ${keys.join(' | ')} |`,
    `| ${keys.map(() => '---').join(' | ')} |`,
    `| ${keys.map((key) => row[key]).join(' | ')} |`,
    `| ${keys.map((key) => row[key]).join(' | ')} |`,
    '',
    '## 逐段',
    '',
    '| seq | audioSeconds |',
    '| --- | --- |',
    '| 0 | 3.0 |',
    '| 1 | 3.0 |',
    '',
  ].join('\n');
}

test('a consistent record with a pending bill passes and is reported as NOT yet reconciled', () => {
  const verdict = checkRecord(record());
  assert.equal(verdict.ok, true, verdict.problems.join('; '));
  const pending = verdict.notes.find((note) => note.includes('pending-external'));
  assert.ok(pending, 'the pending bill must be reported, not swallowed');
  assert.match(pending, /未/, 'the note must say the bill has not been reconciled yet');
});

test('the parser reads the two tables into readings, per-response rows and per-segment rows', () => {
  const parsed = parseRecord(record());
  assert.equal(parsed.readings['bill'], 'pending-external');
  assert.equal(parsed.readings['segments'], '2');
  assert.equal(parsed.responses.length, 2);
  assert.deepEqual(parsed.responses[0], {
    textInput: 1450,
    audioInput: 21,
    textOutput: 18,
    logEstimateCny: 0.002382,
    usageSumCny: 0.002382,
  });
  assert.deepEqual(parsed.segments, [
    { seq: 0, audioSeconds: 3.0 },
    { seq: 1, audioSeconds: 3.0 },
  ]);
});

test('an estimate that does not come from the row’s own tokens is a failure', () => {
  const verdict = checkRecord(
    record({ row: { logEstimateCny: '0.010000', usageSumCny: '0.010000' }, reading: { logEstimateCny: '0.020000', usageSumCny: '0.020000' } }),
  );
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((problem) => problem.startsWith('estimate-vs-price:')), verdict.problems.join('; '));
});

test('a log estimate that disagrees with the sum of response.done.usage is a failure', () => {
  const verdict = checkRecord(record({ row: { usageSumCny: '0.003500' }, reading: { usageSumCny: '0.007000' } }));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((problem) => problem.startsWith('log-vs-usage:')), verdict.problems.join('; '));
});

test('an EMPTY bill column is never a pass — the false form AC-322 names', () => {
  const verdict = checkRecord(record({ reading: { bill: '' } }));
  assert.equal(verdict.ok, false, 'a missing bill must fail the check');
  assert.ok(verdict.problems.some((problem) => problem.startsWith('bill-missing:')), verdict.problems.join('; '));
});

test('a summary that does not equal the detail rows is a failure', () => {
  const verdict = checkRecord(record({ reading: { textInputTokens: '9999' } }));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((problem) => problem.startsWith('summary-vs-detail:')), verdict.problems.join('; '));
});

test('a numeric bill agreeing within 1% passes; the same bill off by more than 1% fails', () => {
  const agree = checkRecord(record({ reading: { bill: '0.004764' } }));
  assert.equal(agree.ok, true, agree.problems.join('; '));
  // 0.004764 × 1.02 is past the 1% tolerance.
  const disagree = checkRecord(record({ reading: { bill: '0.004859' } }));
  assert.equal(disagree.ok, false);
  assert.ok(disagree.problems.some((problem) => problem.startsWith('bill-vs-estimate:')), disagree.problems.join('; '));
});

test('a segment count that does not match the per-segment rows is a failure', () => {
  const verdict = checkRecord(record({ reading: { segments: '3' } }));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((problem) => problem.startsWith('segments-vs-rows:')), verdict.problems.join('; '));
});

test('the prices are the October 2026 bill, applied to the row’s own three token classes', () => {
  assert.equal(priceOf({ textInput: 1000, audioInput: 0, textOutput: 0, logEstimateCny: 0, usageSumCny: 0 }), 0.0015);
  assert.equal(priceOf({ textInput: 0, audioInput: 1000, textOutput: 0, logEstimateCny: 0, usageSumCny: 0 }), 0.006);
  assert.equal(priceOf({ textInput: 0, audioInput: 0, textOutput: 1000, logEstimateCny: 0, usageSumCny: 0 }), 0.0045);
  // The fixture row is the SPEC's price for one response of the default pack.
  assert.equal(Number(priceOf({ ...ROW, textInput: 1450, audioInput: 21, textOutput: 18, logEstimateCny: 0, usageSumCny: 0 }).toFixed(6)), 0.002382);
});

test('--self-test separates the good record from every deliberate corruption, and ends with PASS', () => {
  const lines = selfTest();
  assert.equal(lines.at(-1), 'SELF-TEST PASS');
  assert.ok(!lines.some((line) => line.startsWith('FAIL')), lines.join('\n'));
  // The four false forms the criterion names are all present, and all ran.
  assert.ok(lines.some((line) => line.includes('空账单')));
  assert.ok(lines.some((line) => line.includes('单价×token')));
  assert.ok(lines.some((line) => line.includes('response.done.usage')));
});
