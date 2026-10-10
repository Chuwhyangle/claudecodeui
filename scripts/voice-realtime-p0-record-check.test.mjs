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

/** The stage timestamps the fixture trees use. Distinct, and in S1 → … → S6 order. */
const RAN_AT = {
  S1: '2026-10-10T01:00:00.000Z',
  S2: '2026-10-10T01:10:00.000Z',
  S3: '2026-10-10T01:20:00.000Z',
  S4: '2026-10-10T02:00:00.000Z',
  S5: '2026-10-10T02:10:00.000Z',
  S6: '2026-10-10T02:20:00.000Z',
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
 * A `response.done` with a chosen usage — for the stages whose reading IS the token counts (S5's
 * before/after, S6's per-turn objects).
 *
 * @param {number} atMs @param {string} id @param {Record<string, unknown>} usage
 * @returns {Record<string, unknown>}
 */
function responseDoneUsage(atMs, id, usage) {
  return frame('received', atMs, { type: 'response.done', response: { id, status: 'completed', usage } });
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
 * A synthetic S4 trace: the semantic endpoint echoed BOTH the requested value and the bogus control,
 * and neither prompt-wait run held — so the two readings agree and the derived verdict is
 * `unsupported`, which is one of the live run's possible shapes with every field present.
 *
 * @returns {Record<string, unknown>}
 */
function s4Trace() {
  /**
   * One control session: the SENT `session.update` that asks for `type`, and the `session.updated`
   * that echoes it — the pair the checker re-reads its `semanticAccepted`/`bogusAccepted` from.
   *
   * @param {string} type @returns {Array<Record<string, unknown>>}
   */
  const controlEvents = (type) => [
    frame('sent', 10, { type: 'session.update', session: { turn_detection: { type }, voice: 'Tina' } }),
    frame('received', 200, { type: 'session.created', session: { id: `sess_${type}` } }),
    frame('received', 250, { type: 'session.updated', session: { id: `sess_${type}`, turn_detection: { type, threshold: 0.5 } } }),
  ];
  /**
   * One prompt-wait run that did NOT hold: a single `response.create`, then the forward — so the
   * checker's split at the (absent) second `response.create` puts the call inside the first window.
   *
   * @param {string} label @returns {Record<string, unknown>}
   */
  const wait = (label) => ({
    label: `s4-wait-${label}`,
    callsAfterFragment1: 1,
    held: false,
    continuationSent: false,
    callsAfterContinuation: null,
    forwardedOnceAfterContinuation: null,
    events: [
      frame('sent', 10, { type: 'session.update', session: { turn_detection: null, voice: 'Tina' } }),
      frame('received', 200, { type: 'session.updated', session: { id: `sess_${label}` } }),
      frame('sent', 300, { type: 'input_audio_buffer.append', audio: '<elided>' }),
      frame('sent', 400, { type: 'input_audio_buffer.commit' }),
      frame('sent', 500, { type: 'response.create' }),
      sendCall(900, '把 server 里的超时改成三十秒。'),
      sendCallItem(900, '把 server 里的超时改成三十秒。'),
      responseDone(1000, `resp_${label}`),
    ],
  });
  return {
    schema: 'voice-realtime-p0-trace/1',
    stage: 'S4',
    ranAt: RAN_AT.S4,
    control: {
      semantic: { label: 's4-vad-semantic', type: 'semantic_vad', errors: [], events: controlEvents('semantic_vad') },
      bogus: { label: 's4-vad-bogus', type: 'bogus_vad_type', errors: [], events: controlEvents('bogus_vad_type') },
    },
    waits: [wait('r1'), wait('r2')],
    evidence: {
      semanticAccepted: true,
      bogusAccepted: true,
      echoDiscriminates: false,
      promptWaitRepetitions: 2,
      promptWaitHeld: 0,
      promptWaitForwardedImmediately: 2,
      promptWaitForwardedOnceAfterContinuation: 0,
      responsesTotal: 2,
      errorFrames: 0,
    },
    verdict: 'unsupported',
    spendCny: 0.0022,
    budgetCny: 0.0045,
    guardTriggered: false,
    notes: 'synthetic S4',
  };
}

/**
 * A synthetic S5 trace: the settled history created (and its id named by the delete), an assistant
 * `OK` item inserted, the next segment forwarded once, the delete accepted, and `input_tokens`
 * falling 643 → 481 across it.
 *
 * @returns {Record<string, unknown>}
 */
function s5Trace() {
  const historyId = 'item_history';
  return {
    schema: 'voice-realtime-p0-trace/1',
    stage: 'S5',
    ranAt: RAN_AT.S5,
    errors: [],
    events: [
      frame('sent', 10, { type: 'session.update', session: { turn_detection: null, voice: 'Tina' } }),
      frame('received', 200, { type: 'session.updated', session: { id: 'sess_s5' } }),
      frame('sent', 300, {
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<settled history>' }] },
      }),
      frame('received', 400, { type: 'conversation.item.created', item: { id: historyId, type: 'message', role: 'user' } }),
      frame('sent', 500, {
        type: 'conversation.item.create',
        item: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'OK' }] },
      }),
      frame('received', 550, { type: 'conversation.item.created', item: { id: 'item_ok', type: 'message', role: 'assistant' } }),
      frame('sent', 600, {
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '现在把超时改回六十秒。' }] },
      }),
      frame('sent', 700, { type: 'response.create' }),
      responseDoneUsage(1500, 'resp_before', { input_tokens: 643, output_tokens: 38 }),
      sendCall(1600, '现在把超时改回六十秒。'),
      sendCallItem(1600, '现在把超时改回六十秒。'),
      frame('sent', 2000, { type: 'conversation.item.delete', item_id: historyId }),
      frame('received', 2100, { type: 'conversation.item.deleted', item_id: historyId }),
      frame('sent', 2200, { type: 'response.create' }),
      responseDoneUsage(3000, 'resp_after', { input_tokens: 481, output_tokens: 16 }),
    ],
    evidence: {
      historyItemCreated: true,
      assistantItemAccepted: true,
      nextSegmentForwarded: true,
      nextSegmentCallCount: 1,
      deleteAccepted: true,
      deleteDroppedTokens: true,
      inputTokensBefore: 643,
      inputTokensAfter: 481,
      errorFrames: 0,
    },
    verdict: 'supported',
    spendCny: 0.002,
    budgetCny: 0.004,
    guardTriggered: false,
    notes: 'synthetic S5',
  };
}

/**
 * A synthetic S6 trace: two responses on one long prefix, neither `usage` carrying a cache-shaped key
 * at any depth. The `turns` mirror the frames' usages exactly, so the checker's per-turn comparison
 * is exercised rather than bypassed.
 *
 * @returns {Record<string, unknown>}
 */
function s6Trace() {
  const usage1 = {
    total_tokens: 1484,
    input_tokens: 1451,
    output_tokens: 33,
    input_tokens_details: { text_tokens: 1451 },
  };
  const usage2 = {
    total_tokens: 1563,
    input_tokens: 1529,
    output_tokens: 34,
    input_tokens_details: { text_tokens: 1529 },
  };
  return {
    schema: 'voice-realtime-p0-trace/1',
    stage: 'S6',
    ranAt: RAN_AT.S6,
    errors: [],
    turns: [
      { label: 'turn1', usage: usage1 },
      { label: 'turn2', usage: usage2 },
    ],
    events: [
      frame('sent', 10, { type: 'session.update', session: { turn_detection: null, voice: 'Tina' } }),
      frame('received', 200, { type: 'session.updated', session: { id: 'sess_s6' } }),
      frame('sent', 300, {
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<prefix>' }] },
      }),
      frame('sent', 400, { type: 'response.create' }),
      frame('received', 900, { type: 'response.done', response: { id: 'resp_t1', status: 'completed', usage: usage1 } }),
      frame('sent', 1000, { type: 'response.create' }),
      frame('received', 1500, { type: 'response.done', response: { id: 'resp_t2', status: 'completed', usage: usage2 } }),
    ],
    evidence: {
      responsesSeen: 2,
      cacheFieldPresent: false,
      discountObserved: false,
      cacheKeys: [],
      inputTokens: [1451, 1529],
      outputTokens: [33, 34],
      errorFrames: 0,
    },
    verdict: 'unsupported',
    spendCny: 0.0048,
    budgetCny: 0.006,
    guardTriggered: false,
    notes: 'synthetic S6',
  };
}

/**
 * Writes one fixture tree: `RESULT.json` beside `traces/`, because the checker resolves the traces
 * relative to the result file. Exactly one thing is broken per call.
 *
 * @param {{
 *   skipS2?: boolean,
 *   skipS4?: boolean,
 *   skipS5?: boolean,
 *   skipS6?: boolean,
 *   totalBudgetCny?: number,
 *   secretInS1?: boolean,
 *   s3RanAt?: string,
 *   s3FirstForwarded?: boolean,
 *   s4RanAt?: string,
 * }} [options]
 * @returns {string} the tree's directory
 */
function makeTree(options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'p0-record-check-'));
  mkdirSync(path.join(dir, 'traces'), { recursive: true });

  const s1 = s1Trace();
  const s2 = s2Trace();
  const s3 = s3Trace();
  const s4 = s4Trace();
  const s5 = s5Trace();
  const s6 = s6Trace();
  if (options.secretInS1 === true) s1.notes = 'leaked sk-abcdefghijklmnopqrstuvwx in a note';
  if (typeof options.s3RanAt === 'string') s3.ranAt = options.s3RanAt;
  if (typeof options.s4RanAt === 'string') s4.ranAt = options.s4RanAt;
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
    totalBudgetCny: options.totalBudgetCny ?? 0.05,
    totalSpendCny: 0.0345,
    stages: [
      stageEntry('S1', s1, 'traces/s1-manual-commit.json'),
      stageEntry('S2', s2, 'traces/s2-session-rotation.json'),
      stageEntry('S3', s3, 'traces/s3-context-injection.json'),
      stageEntry('S4', s4, 'traces/s4-semantic-endpoint.json'),
      stageEntry('S5', s5, 'traces/s5-history-control.json'),
      stageEntry('S6', s6, 'traces/s6-cache-fields.json'),
    ],
  };

  /** @type {Array<[string, Record<string, unknown>, boolean]>} */
  const traces = [
    ['s1-manual-commit.json', s1, true],
    ['s2-session-rotation.json', s2, options.skipS2 !== true],
    ['s3-context-injection.json', s3, true],
    ['s4-semantic-endpoint.json', s4, options.skipS4 !== true],
    ['s5-history-control.json', s5, options.skipS5 !== true],
    ['s6-cache-fields.json', s6, options.skipS6 !== true],
  ];
  writeFileSync(path.join(dir, 'RESULT.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  for (const [name, trace, write] of traces) {
    if (write) writeFileSync(path.join(dir, 'traces', name), `${JSON.stringify(trace, null, 2)}\n`, 'utf8');
  }
  return dir;
}

/**
 * Runs the checker over one tree and returns what it said. The default is the P0a selection the
 * original cases use; `null` runs EVERY stage, which is the mode the P0b cases need.
 *
 * @param {string} dir @param {string | null} [stage] @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function runChecker(dir, stage = 'a') {
  const args = [CHECKER, path.join(dir, 'RESULT.json')];
  if (stage !== null) args.push('--stage', stage);
  const run = spawnSync(process.execPath, args, { cwd: REPO_ROOT, encoding: 'utf8' });
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
}

test('the synthetic baseline passes every stage — the false forms below are the only difference', () => {
  const dir = makeTree();
  try {
    // No `--stage`: the default selection is the whole canonical set, S1 … S6.
    const { status, stdout } = runChecker(dir, null);
    assert.equal(status, 0, `baseline tree must pass, said:\n${stdout}`);
    assert.match(stdout, /record check passed \(stages\)/);
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

test('a missing S4/S5/S6 evidence file is red without `--stage`', () => {
  // The P0b stages are policed by the DEFAULT selection: one probe whose trace never landed has to
  // red the whole run, not silently drop out of it.
  const cases = /** @type {Array<[Record<string, boolean>, RegExp]>} */ ([
    [{ skipS4: true }, /S4: evidence file `traces\/s4-semantic-endpoint\.json` does not exist/],
    [{ skipS5: true }, /S5: evidence file `traces\/s5-history-control\.json` does not exist/],
    [{ skipS6: true }, /S6: evidence file `traces\/s6-cache-fields\.json` does not exist/],
  ]);
  for (const [options, expected] of cases) {
    const dir = makeTree(options);
    try {
      const { status, stderr } = runChecker(dir, null);
      assert.equal(status, 1);
      assert.match(stderr, expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("S4's ranAt earlier than S3's is red", () => {
  const dir = makeTree({ s4RanAt: '2026-10-10T01:15:00.000Z' });
  try {
    const { status, stderr } = runChecker(dir, null);
    assert.equal(status, 1);
    assert.match(stderr, /S4 ranAt 2026-10-10T01:15:00\.000Z is earlier than S3 ranAt 2026-10-10T01:20:00\.000Z/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a hand-written S5 `deleteAccepted` the frames do not carry is red', () => {
  // The delete's own response is dropped, so the frames say "not accepted" while the record still
  // claims it was — the disagreement has to surface on the derived reading, not pass unnoticed.
  const dir = makeTree();
  try {
    const tracePath = path.join(dir, 'traces', 's5-history-control.json');
    const trace = JSON.parse(readFileSync(tracePath, 'utf8'));
    trace.events = trace.events.filter(
      (/** @type {Record<string, unknown>} */ event) =>
        !(event.direction === 'received' && /** @type {Record<string, unknown>} */ (event.wire).type === 'conversation.item.deleted'),
    );
    writeFileSync(tracePath, `${JSON.stringify(trace, null, 2)}\n`, 'utf8');
    const { status, stderr } = runChecker(dir, null);
    assert.equal(status, 1);
    assert.match(stderr, /S5 evidence\.deleteAccepted: recorded true, frames say false/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a hand-written S6 usage the frames do not carry is red', () => {
  // S6's cache reading is about the endpoint's own `usage` bytes, so a turn whose recorded usage is
  // not the frame's must die against the frame rather than be re-walked as if it were.
  const dir = makeTree();
  try {
    const tracePath = path.join(dir, 'traces', 's6-cache-fields.json');
    const trace = JSON.parse(readFileSync(tracePath, 'utf8'));
    trace.turns[1].usage = { ...trace.turns[1].usage, input_tokens: 9999 };
    writeFileSync(tracePath, `${JSON.stringify(trace, null, 2)}\n`, 'utf8');
    const { status, stderr } = runChecker(dir, null);
    assert.equal(status, 1);
    assert.match(stderr, /S6 turns\[1\] \(turn2\): recorded usage does not match `response\.done` usage #2 in the frames/);
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
