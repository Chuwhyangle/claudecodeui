#!/usr/bin/env node
/**
 * The record checker's own tests.
 *
 * WHY THE FALSE FORMS MATTER MORE THAN THE HAPPY PATH. `voice-realtime-p0-record-check.mjs` exists
 * to make a claim about a live run falsifiable. A checker that only ever agrees with the record it
 * is handed proves nothing — so every case here takes ONE valid tree, breaks exactly one thing, and
 * requires the checker to exit non-zero AND to say which thing it saw. The assertion is on the
 * checker's own words, not just on the exit code, because a red for the wrong reason is not a
 * passing test (a tree that fails for an unrelated reason would satisfy a bare exit-code check).
 *
 * The trees are synthetic on purpose: the checker must be exercisable without spending money on the
 * live endpoint, and a fixture whose bytes are known is the only way to doctor one field at a time.
 *
 * The last case is not synthetic — it drives the budget guard against a FAKE upstream
 * (`experiments/voice-realtime-segmented/p0/guard-case.mts`) and reads the `guardTriggered` flag off
 * the record that case writes. That is AC6's unit case, run from the same command as AC1's.
 *
 *     node --test scripts/voice-realtime-p0-record-check.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER = path.join(REPO_ROOT, 'scripts', 'voice-realtime-p0-record-check.mjs');
const GUARD_CASE = 'experiments/voice-realtime-segmented/p0/guard-case.mts';

/** The stage timestamps the fixture trees use. Distinct, and in S1 → S2 → S3 order. */
const RAN_AT = {
  S1: '2026-10-10T01:00:00.000Z',
  S2: '2026-10-10T01:10:00.000Z',
  S3: '2026-10-10T01:20:00.000Z',
};

/**
 * One frame in the shape the probes' transport observer writes it.
 *
 * @param {'sent' | 'received'} direction @param {number} atMs @param {Record<string, unknown>} wire
 * @returns {Record<string, unknown>}
 */
function frame(direction, atMs, wire) {
  return { direction, atMs, sinceOpenMs: atMs, wire };
}

/**
 * A received `session_send` delivery — the dialect the live endpoint actually uses.
 *
 * @param {number} atMs @param {string} message @returns {Record<string, unknown>}
 */
function sendCall(atMs, message) {
  return frame('received', atMs, {
    type: 'response.function_call_arguments.done',
    call_id: `call_${atMs}`,
    name: 'session_send',
    arguments: JSON.stringify({ message }),
  });
}

/**
 * The SAME call as `sendCall`, re-delivered as a `function_call` output item — which is what the live
 * endpoint does. One call, two frames, one `call_id`: a reader that added the dialects together would
 * call this two forwards, so the baseline fixture carries the duplicate and counts it once.
 *
 * @param {number} atMs @param {string} message @returns {Record<string, unknown>}
 */
function sendCallItem(atMs, message) {
  return frame('received', atMs + 1, {
    type: 'response.output_item.done',
    item: { type: 'function_call', call_id: `call_${atMs}`, name: 'session_send', arguments: JSON.stringify({ message }) },
  });
}

/**
 * A received `response.done` carrying usage, which is where spend and `usage.input_tokens` come from.
 *
 * @param {number} atMs @param {string} id @returns {Record<string, unknown>}
 */
function responseDone(atMs, id) {
  return frame('received', atMs, {
    type: 'response.done',
    response: { id, status: 'completed', usage: { input_tokens: 1500, output_tokens: 120 } },
  });
}

/**
 * A synthetic S1 trace: manual commit accepted, one forward, no errors. Every reading the checker
 * re-derives is present in the frames AND in `evidence`, so the two readings agree — as they must
 * for a real run to pass.
 *
 * @returns {Record<string, unknown>}
 */
function s1Trace() {
  const events = [
    frame('sent', 10, { type: 'session.update', session: { turn_detection: null, voice: 'Tina' } }),
    frame('sent', 20, { type: 'input_audio_buffer.append', audio: '<elided>' }),
    frame('sent', 30, { type: 'input_audio_buffer.commit' }),
    frame('sent', 40, { type: 'response.create' }),
    responseDone(900, 'resp_s1'),
    sendCall(950, '把 server 里的超时改成三十秒。'),
    sendCallItem(950, '把 server 里的超时改成三十秒。'),
  ];
  return {
    schema: 'voice-realtime-p0-trace/1',
    stage: 'S1',
    ranAt: RAN_AT.S1,
    attempts: [{ label: 'single-commit', segments: 1, events, errors: [] }],
    evidence: {
      manualSessionBodySent: true,
      commitsSent: 1,
      responseCreatesSent: 1,
      responsesCompleted: 1,
      sessionSendCalls: 1,
      errorFrames: 0,
    },
    verdict: 'supported',
    spendCny: 0.004,
    budgetCny: 0.01,
    guardTriggered: false,
    notes: 'synthetic S1',
  };
}

/**
 * A synthetic S2 trace: six timed establishments, an active session that completed, and a standby
 * that was warm before it did and answered the first segment.
 *
 * @returns {Record<string, unknown>}
 */
function s2Trace() {
  const timings = [1, 2, 3, 4, 5, 6].map((index) => ({
    label: `timer-${index}`,
    sessionId: `session_${index}`,
    openToCreatedMs: 100 + index,
    openToUpdatedMs: 300 + index * 50,
    closed: true,
  }));
  return {
    schema: 'voice-realtime-p0-trace/1',
    stage: 'S2',
    ranAt: RAN_AT.S2,
    establishment: { n: timings.length, updatedMs: { p50: 450, p90: 600 }, timings },
    handover: {
      active: { label: 'active-A', responseDoneAtMs: 2000, events: [responseDone(2000, 'resp_a')] },
      standby: { label: 'standby-B', warmAtMs: 1900, errors: [], events: [responseDone(2500, 'resp_b')] },
      outcome: 'ok',
      error: null,
    },
    evidence: {
      timedEstablishments: 6,
      establishmentsWithUpdated: 6,
      activeResponseDone: 1,
      standbyWarmedBeforeActiveDone: true,
      standbyTookFirstSegment: true,
      standbyErrorFrames: 0,
    },
    verdict: 'supported',
    spendCny: 0.0015,
    budgetCny: 0.005,
    guardTriggered: false,
    notes: 'synthetic S2',
  };
}

/**
 * A synthetic S3 trace: six utterances twice, every one of them forwarded. `identifierHit` is null
 * on the identifier-free utterances, so the key is present without being a claim.
 *
 * @returns {Record<string, unknown>}
 */
function s3Trace() {
  const utterances = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'];
  /** @type {Array<Record<string, unknown>>} */
  const responses = [];
  for (const utteranceId of utterances) {
    for (const repeat of [1, 2]) {
      const atMs = 1000 + responses.length * 10;
      const message = `转述：${utteranceId}`;
      responses.push({
        utteranceId,
        repeat,
        label: `${utteranceId}-r${repeat}`,
        responseId: `resp_${utteranceId}_${repeat}`,
        forwarded: true,
        forwardedMessage: message,
        forwardedAtMs: atMs,
        editDistance: 0.2,
        identifierHit: null,
        usage: { input_tokens: 1500, output_tokens: 120 },
        timedOut: false,
        errors: [],
        events: [responseDone(atMs - 5, `resp_${utteranceId}_${repeat}`), sendCall(atMs, message), sendCallItem(atMs, message)],
      });
    }
  }
  return {
    schema: 'voice-realtime-p0-trace/1',
    stage: 'S3',
    ranAt: RAN_AT.S3,
    context: { fixture: 'fixtures/context-sample.json', chars: 1926 },
    responses,
    evidence: {
      plannedResponses: 12,
      responsesRecorded: 12,
      responsesCompleted: 12,
      forwarded: 12,
      identifierBearingResponses: 0,
      identifierHits: 0,
      errorFrames: 0,
      timedOut: 0,
    },
    verdict: 'supported',
    spendCny: 0.02,
    budgetCny: 0.025,
    guardTriggered: false,
    notes: 'synthetic S3',
  };
}

/**
 * Writes one fixture tree: `RESULT.json` beside `traces/`, because the checker resolves the traces
 * relative to the result file. Exactly one thing is broken per call.
 *
 * @param {{
 *   skipS2?: boolean,
 *   totalBudgetCny?: number,
 *   secretInS1?: boolean,
 *   s3RanAt?: string,
 *   s3FirstForwarded?: boolean,
 * }} [options]
 * @returns {string} the tree's directory
 */
function makeTree(options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'p0-record-check-'));
  mkdirSync(path.join(dir, 'traces'), { recursive: true });

  const s1 = s1Trace();
  const s2 = s2Trace();
  const s3 = s3Trace();
  if (options.secretInS1 === true) s1.notes = 'leaked sk-abcdefghijklmnopqrstuvwx in a note';
  if (typeof options.s3RanAt === 'string') s3.ranAt = options.s3RanAt;
  if (options.s3FirstForwarded === false) {
    const first = /** @type {Array<Record<string, unknown>>} */ (s3.responses)[0];
    first.forwarded = false;
  }

  /**
   * @param {string} stage @param {Record<string, unknown>} trace @param {string} evidence
   * @returns {Record<string, unknown>}
   */
  const stageEntry = (stage, trace, evidence) => ({
    stage,
    verdict: trace.verdict,
    evidence,
    spendCny: trace.spendCny,
    budgetCny: trace.budgetCny,
    guardTriggered: trace.guardTriggered,
    ranAt: trace.ranAt,
    notes: trace.notes,
  });

  const result = {
    schema: 'voice-realtime-p0-result/1',
    generatedBy: 'scripts/voice-realtime-p0-record-check.test.mjs',
    totalBudgetCny: options.totalBudgetCny ?? 0.04,
    totalSpendCny: 0.0255,
    stages: [
      stageEntry('S1', s1, 'traces/s1-manual-commit.json'),
      stageEntry('S2', s2, 'traces/s2-session-rotation.json'),
      stageEntry('S3', s3, 'traces/s3-context-injection.json'),
    ],
  };

  writeFileSync(path.join(dir, 'RESULT.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  writeFileSync(path.join(dir, 'traces', 's1-manual-commit.json'), `${JSON.stringify(s1, null, 2)}\n`, 'utf8');
  if (options.skipS2 !== true) {
    writeFileSync(path.join(dir, 'traces', 's2-session-rotation.json'), `${JSON.stringify(s2, null, 2)}\n`, 'utf8');
  }
  writeFileSync(path.join(dir, 'traces', 's3-context-injection.json'), `${JSON.stringify(s3, null, 2)}\n`, 'utf8');
  return dir;
}

/**
 * Runs the checker over one tree and returns what it said.
 *
 * @param {string} dir @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function runChecker(dir) {
  const run = spawnSync(process.execPath, [CHECKER, path.join(dir, 'RESULT.json'), '--stage', 'a'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
}

test('the synthetic baseline passes — the false forms below are the only difference', () => {
  const dir = makeTree();
  try {
    const { status, stdout } = runChecker(dir);
    assert.equal(status, 0, `baseline tree must pass, said:\n${stdout}`);
    assert.match(stdout, /record check passed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing evidence file is red', () => {
  const dir = makeTree({ skipS2: true });
  try {
    const { status, stderr } = runChecker(dir);
    assert.equal(status, 1);
    assert.match(stderr, /S2: evidence file `traces\/s2-session-rotation\.json` does not exist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Σ spendCny over the declared budget is red', () => {
  const dir = makeTree({ totalBudgetCny: 0.001 });
  try {
    const { status, stderr } = runChecker(dir);
    assert.equal(status, 1);
    assert.match(stderr, /Σ spendCny 0\.0255 exceeds the total budget 0\.001/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an `sk-…`-shaped string in a trace is red', () => {
  const dir = makeTree({ secretInS1: true });
  try {
    const { status, stderr } = runChecker(dir);
    assert.equal(status, 1);
    assert.match(stderr, /traces\/s1-manual-commit\.json: carries an `sk-…`-shaped string/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S3's ranAt earlier than S1's is red", () => {
  const dir = makeTree({ s3RanAt: '2026-10-10T00:30:00.000Z' });
  try {
    const { status, stderr } = runChecker(dir);
    assert.equal(status, 1);
    // The checker reports the ADJACENT pair it broke, so S3-before-S1 surfaces as S3-before-S2.
    assert.match(stderr, /S3 ranAt 2026-10-10T00:30:00\.000Z is earlier than S2 ranAt 2026-10-10T01:10:00\.000Z/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a hand-written `forwarded` the frames do not carry is red', () => {
  const dir = makeTree({ s3FirstForwarded: false });
  try {
    const { status, stderr } = runChecker(dir);
    assert.equal(status, 1);
    assert.match(stderr, /S3 responses\[0\] \(u1-r1\) forwarded: recorded false, frames say true/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the budget guard trips against a fake upstream and records guardTriggered', () => {
  // The nested runner refuses to start while it still believes it is a child of THIS one
  // ("run() is being called recursively within a test file. skipping running files."), so the two
  // variables the runner sets for its children are dropped rather than inherited.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  const run = spawnSync(
    path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx'),
    ['--tsconfig', 'server/tsconfig.json', '--test', GUARD_CASE],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 180_000, env },
  );
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  assert.equal(run.status, 0, `the guard case must pass, said:\n${output}`);
  const line = output.split('\n').find((candidate) => candidate.startsWith('record='));
  assert.ok(line !== undefined, `the guard case must print its record line, said:\n${output}`);
  const recordPath = /** @type {string} */ (line.split(' ')[0].split('=')[1]);
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  assert.equal(record.guardTriggered, true);
  assert.equal(record.closedSockets, 1);
  assert.ok(record.spendCny > record.budgetCny, 'the trip has to be a crossing, not a coincidence');
});
