/**
 * The omission-fill planner (rule v2) — the table-driven rule cases and the Python-parity corpus.
 *
 * WHAT THIS FILE PINS. `voice-realtime-omission-fill.ts` is a port of
 * `experiments/voice-relay-qb/replay_rule.py`'s `_plan_R2`, so it has two ways to be wrong: it can get
 * a rule branch wrong on its own, and it can DRIFT from the reference implementation the rule was
 * measured with. The file therefore has two groups, and each exists for one of those failures:
 *
 *  - TABLE CASES (below) state the rule in its own terms: eligibility (`w=6/7`), the hallucination
 *    guard, the silence branch, cross-script incomparability, the coverage boundary (`0.24/0.25`), the
 *    `t+H` boundary, and the input contract that a call inside a CANCELLED response is not `executed`.
 *  - PARITY CASES replay `experiments/voice-relay-qb/fixtures/omission-fill-cases.json`, which the
 *    Python reference generates from 47 FROZEN real connections plus 16 branch-targeted synthetic
 *    cases. Each case carries the reference's own fill indices, due times, coverage and skip reasons;
 *    disagreement on any of them is a red. Regenerate with
 *    `python3 -I experiments/voice-relay-qb/replay_rule.py --emit-fixture`.
 *
 * WHY THE FIXTURE'S PARAMS ARE CHECKED AGAINST THE LOCKED FILE. The parameters are locked in
 * `omission-fill-params.json`; a fixture generated before a parameter change would silently pin the
 * OLD rule. The first parity test maps `chosen` and requires the fixture to carry exactly it, so a
 * change to either the file or the fixture without regenerating the other is red.
 *
 * Consumers: the quay worker's AC state for `gap-omission-fill-pure-module-and-parity`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  planOmissionFills,
  type OmissionFillExecuted,
  type OmissionFillFinal,
  type OmissionFillParams,
  type OmissionFillSkipReason,
} from '../index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../..');
const PARAMS_FILE = path.join(REPO_ROOT, 'experiments', 'voice-relay-qb', 'omission-fill-params.json');
const FIXTURE_FILE = path.join(REPO_ROOT, 'experiments', 'voice-relay-qb', 'fixtures', 'omission-fill-cases.json');

// ── the locked parameters (no second copy: these are read from task 1's file) ──────────────────────
const CHOSEN = JSON.parse(readFileSync(PARAMS_FILE, 'utf8')) as {
  chosen: {
    h_ms: number; g_ms: number; score_t: number; w_min: number; w_hallu: number;
    dom_n: number; lookback_ms: number; silence_ms: number | null; numeral_mode: string;
  };
};

const LOCKED: OmissionFillParams = {
  hMs: CHOSEN.chosen.h_ms,
  gMs: CHOSEN.chosen.g_ms,
  scoreT: CHOSEN.chosen.score_t,
  wMin: CHOSEN.chosen.w_min,
  wHallu: CHOSEN.chosen.w_hallu,
  domN: CHOSEN.chosen.dom_n,
  lookbackMs: CHOSEN.chosen.lookback_ms,
  silenceMs: CHOSEN.chosen.silence_ms,
  numeralMode: CHOSEN.chosen.numeral_mode as OmissionFillParams['numeralMode'],
};

// ── table cases ────────────────────────────────────────────────────────────────────────────────────
const B = 1_760_000_000_000; // a fixed clock: expectations below are absolute and reproducible

type TableCase = {
  readonly name: string;
  readonly finals: readonly OmissionFillFinal[];
  readonly executed: readonly OmissionFillExecuted[];
  readonly speechStarts?: readonly number[];
  readonly params?: Partial<OmissionFillParams>;
  readonly expect: {
    readonly fills: readonly number[];
    readonly dueAt?: Readonly<Record<number, number>>;
    readonly coverage?: Readonly<Record<number, number>>;
    readonly reasons?: Readonly<Record<number, OmissionFillSkipReason>>;
  };
};

const TABLE_CASES: readonly TableCase[] = [
  {
    name: 'pure Chinese, model silent and user quiet → fill confirmed at t+S',
    finals: [{ t: B, text: '服务器一直连接不上' }],
    executed: [],
    expect: { fills: [0], dueAt: { 0: B + 3000 }, coverage: { 0: 0 } },
  },
  {
    name: 'pure English, same shape → fill confirmed at t+S',
    finals: [{ t: B, text: 'the connection keeps dropping' }],
    executed: [],
    expect: { fills: [0], dueAt: { 0: B + 3000 }, coverage: { 0: 0 } },
  },
  {
    name: 'mixed Chinese + English, the model message carries it → covered',
    finals: [{ t: B, text: '我们check the logs之后再说吧' }],
    executed: [{ t: B + 500, text: '我们check the logs之后再说' }],
    expect: { fills: [], reasons: { 0: 'covered' } },
  },
  {
    name: 'runs2 numerals: the 十八 run is stripped on both sides → covered',
    finals: [{ t: B, text: '我们下午三点十八分见吧' }],
    executed: [{ t: B + 500, text: '我们下午三点十八分见吧' }],
    expect: { fills: [], reasons: { 0: 'covered' } },
  },
  {
    name: 'the model translated the speech into another script → incomparable, never fill',
    finals: [{ t: B, text: '服务器一直连接不上' }],
    executed: [{ t: B + 500, text: 'the server cannot connect at all' }],
    expect: { fills: [], reasons: { 0: 'incomparable' } },
  },
  {
    name: 'short line in another script than the recent past → wrong-script hallucination',
    finals: [
      { t: B, text: '我们今天讨论一下这个问题' },
      { t: B + 5000, text: 'hello there my friend' },
    ],
    executed: [],
    expect: { fills: [0], reasons: { 1: 'wrong-script' } },
  },
  {
    name: 'a call from a CANCELLED response is not executed → the item still fills',
    finals: [{ t: B, text: '服务器一直连接不上' }],
    executed: [],
    expect: { fills: [0] },
  },
  {
    name: 'the SAME text as an executed message carries it → covered (the false-form contrast)',
    finals: [{ t: B, text: '服务器一直连接不上' }],
    executed: [{ t: B + 500, text: '服务器一直连接不上 servers are down' }],
    expect: { fills: [], reasons: { 0: 'covered' } },
  },
  {
    name: 'the only model message predates the look-back window → empty window, fill',
    finals: [{ t: B, text: '服务器一直连接不上' }],
    executed: [{ t: B - 5000, text: '服务器一直连接不上' }],
    expect: { fills: [0], dueAt: { 0: B + 3000 }, coverage: { 0: 0 } },
  },
  {
    name: 'weight boundary: w=7 qualifies, w=6 does not',
    finals: [
      { t: B, text: '今天天气不错呀' },
      { t: B + 5000, text: '今天天气不错' },
    ],
    executed: [],
    expect: { fills: [0], reasons: { 1: 'weight' } },
  },
  {
    name: 'coverage boundary: exactly SCORE_T=0.25 is covered (`>=`, not `>`)',
    finals: [{ t: B, text: '甲乙丙丁戊己庚辛壬' }],
    executed: [{ t: B + 500, text: '甲乙丙' }],
    expect: { fills: [], reasons: { 0: 'covered' } },
  },
  {
    name: 'coverage just below the boundary: 6/25 = 0.24 → fill',
    finals: [{ t: B, text: '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥天地玄黄' }],
    executed: [{ t: B + 500, text: '甲乙丙丁戊己庚' }],
    expect: { fills: [0], coverage: { 0: 0.24 } },
  },
  {
    name: 'first executed message exactly at t+H is in reach → T_i stays at the cap',
    finals: [{ t: B, text: '服务器一直连接不上' }],
    executed: [{ t: B + 12000, text: '今天天气不错呀' }],
    expect: { fills: [0], dueAt: { 0: B + 12000 }, coverage: { 0: 0 } },
  },
  {
    name: 'first executed message one millisecond after t+H → silence branch owns T_i',
    finals: [{ t: B, text: '服务器一直连接不上' }],
    executed: [{ t: B + 12001, text: '今天天气不错呀' }],
    expect: { fills: [0], dueAt: { 0: B + 3000 }, coverage: { 0: 0 } },
  },
  {
    name: 'the user started speaking again inside S → wait the full H',
    finals: [{ t: B, text: '服务器一直连接不上' }],
    executed: [],
    speechStarts: [B + 1000],
    expect: { fills: [0], dueAt: { 0: B + 12000 }, coverage: { 0: 0 } },
  },
  {
    name: 'silence branch switched off (silenceMs=null) → wait the full H',
    finals: [{ t: B, text: '服务器一直连接不上' }],
    executed: [],
    params: { silenceMs: null },
    expect: { fills: [0], dueAt: { 0: B + 12000 }, coverage: { 0: 0 } },
  },
  {
    name: 'no comparable units → empty-grams (only reachable with a zero weight floor)',
    finals: [{ t: B, text: '好' }],
    executed: [],
    params: { wMin: 0 },
    expect: { fills: [], reasons: { 0: 'empty-grams' } },
  },
];

for (const tableCase of TABLE_CASES) {
  test(`table: ${tableCase.name}`, () => {
    const params: OmissionFillParams = { ...LOCKED, ...tableCase.params };
    const plan = planOmissionFills(tableCase.finals, tableCase.executed, params, tableCase.speechStarts ?? []);

    assert.deepEqual(
      plan.fills.map((fill) => fill.index),
      tableCase.expect.fills,
      `${tableCase.name}: fill indices`,
    );
    for (const [index, dueAt] of Object.entries(tableCase.expect.dueAt ?? {})) {
      assert.equal(plan.fills.find((fill) => fill.index === Number(index))?.dueAt, dueAt, `${tableCase.name}: dueAt ${index}`);
    }
    for (const [index, coverage] of Object.entries(tableCase.expect.coverage ?? {})) {
      assert.equal(
        plan.fills.find((fill) => fill.index === Number(index))?.coverage,
        coverage,
        `${tableCase.name}: coverage ${index}`,
      );
    }
    for (const [index, reason] of Object.entries(tableCase.expect.reasons ?? {})) {
      assert.equal(
        plan.skipped.find((skip) => skip.index === Number(index))?.reason,
        reason,
        `${tableCase.name}: skip reason ${index}`,
      );
    }
    // fills and skipped partition the input: a planner that silently drops an item would pass the
    // index comparison above, so the partition itself is asserted.
    assert.equal(plan.fills.length + plan.skipped.length, tableCase.finals.length, `${tableCase.name}: partition`);
  });
}

// ── parity with the Python reference ──────────────────────────────────────────────────────────────
const FIXTURE = JSON.parse(readFileSync(FIXTURE_FILE, 'utf8')) as {
  caseCount: number;
  cases: Array<{
    name: string;
    source: 'frozen-connection' | 'synthetic';
    connection?: string;
    finals: OmissionFillFinal[];
    executed: OmissionFillExecuted[];
    speechStarts: number[];
    params: OmissionFillParams;
    expected: {
      fills: Array<{ index: number; dueAt: number; coverage: number }>;
      skipped: Array<{ index: number; reason: OmissionFillSkipReason }>;
    };
  }>;
};

test('parity corpus is large enough and carries the locked parameters', () => {
  assert.ok(FIXTURE.cases.length >= 40, `expected >= 40 parity cases, got ${FIXTURE.cases.length}`);
  assert.equal(FIXTURE.caseCount, FIXTURE.cases.length);
  for (const fixtureCase of FIXTURE.cases) {
    assert.deepEqual(fixtureCase.params, LOCKED, `${fixtureCase.name}: fixture params are not the locked params`);
  }
});

test('parity corpus covers the branch vocabulary', () => {
  const reasons = new Set(FIXTURE.cases.flatMap((c) => c.expected.skipped.map((skip) => skip.reason)));
  for (const reason of ['weight', 'wrong-script', 'incomparable', 'covered'] as const) {
    assert.ok(reasons.has(reason), `fixture has no '${reason}' skip case`);
  }
  const names = new Set(FIXTURE.cases.map((c) => c.name));
  // The synthetic set is what covers branches the Chinese-heavy journals do not: pure English, a
  // second script, and the cancelled-response input contract.
  for (const name of [
    'synthetic-pure-english-omission',
    'synthetic-pure-cyrillic-covered',
    'synthetic-greek-covered',
    'synthetic-cancelled-response-call',
    'synthetic-coverage-boundary-025',
  ]) {
    assert.ok(names.has(name), `fixture is missing ${name}`);
  }
  assert.ok(
    FIXTURE.cases.some((c) => c.source === 'frozen-connection'),
    'fixture must contain the frozen real connections',
  );
});

for (const fixtureCase of FIXTURE.cases) {
  test(`parity: ${fixtureCase.name}`, () => {
    const plan = planOmissionFills(
      fixtureCase.finals,
      fixtureCase.executed,
      fixtureCase.params,
      fixtureCase.speechStarts,
    );
    assert.deepEqual(
      plan.fills.map((fill) => fill.index),
      fixtureCase.expected.fills.map((fill) => fill.index),
      `${fixtureCase.name}: fill indices disagree with the Python reference`,
    );
    assert.deepEqual(
      plan.fills.map((fill) => fill.dueAt),
      fixtureCase.expected.fills.map((fill) => fill.dueAt),
      `${fixtureCase.name}: fill due times disagree with the Python reference`,
    );
    assert.deepEqual(
      plan.fills.map((fill) => fill.coverage),
      fixtureCase.expected.fills.map((fill) => fill.coverage),
      `${fixtureCase.name}: coverage disagrees with the Python reference`,
    );
    assert.deepEqual(
      plan.skipped,
      fixtureCase.expected.skipped,
      `${fixtureCase.name}: skip reasons disagree with the Python reference`,
    );
    assert.equal(
      plan.fills.length + plan.skipped.length,
      fixtureCase.finals.length,
      `${fixtureCase.name}: planner did not partition the input`,
    );
  });
}
