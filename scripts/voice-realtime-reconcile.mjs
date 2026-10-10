#!/usr/bin/env node
/**
 * The Live Voice segmented-relay cost reconciliation.
 *
 * WHAT IT IS FOR. `docs/operations/voice-realtime-reconcile.md` records one real run: how many
 * segments the browser cut, how much audio actually reached the upstream, the three token classes the
 * endpoint billed, and the connection's own running cost estimate. A number written down once is a
 * claim about the past, not a reading — so this script RE-DERIVES the record's arithmetic from the
 * record's own columns and fails when the two disagree. It is the `--check` half of AC-322's
 * reconciliation, and the thing the bill line is eventually compared against.
 *
 * WHAT IT COMPUTES, from the document alone:
 *
 *   1. **estimate = price × tokens** — every per-response row's `logEstimateCny` is recomputed from
 *      its own three token columns at the October 2026 prices (`estimateRealtimeCostCny`'s table:
 *      text in ¥0.0015, audio in ¥0.006, text out ¥0.0045 per 1,000). A row whose estimate does not
 *      come from its tokens is a fabricated number, and this is where it is caught.
 *   2. **log estimate = Σ `response.done.usage`** — the connection's running `cost~CNY` (the server
 *      log line) against the sum of what the endpoint's own `response.done` frames carried. The two
 *      are computed by the same shipping estimator over the same frames, so anything but agreement
 *      means the record is not describing one run.
 *   3. **the summary equals the detail** — the `## 读数` block's tokens, segments and audio seconds
 *      against the sum of the per-response and per-segment rows. A record whose totals were typed
 *      rather than totalled fails here.
 *   4. **the bill** — `pending-external` is reported as OUTSTANDING (and passes, because it is the
 *      honest state until a human provides the Aliyun line); a numeric bill must agree with the
 *      estimate to within 1%; an EMPTY bill is a failure, never a pass. That last one is the whole
 *      point: "缺账单" and "账单对上了" must not look the same to a script.
 *
 * THE FALSE FORMS ARE RUN, NOT ASSERTED. `--self-test` feeds the checker documents built to be right
 * and documents built to be wrong in each of the four ways above, and requires the verdicts to
 * separate them. A script that answered `ok` to everything would fail its own self-test — most
 * directly on the empty-bill case, which exists so "对账脚本把空账单当成功" is a red.
 *
 *     node scripts/voice-realtime-reconcile.mjs --check docs/operations/voice-realtime-reconcile.md
 *     node scripts/voice-realtime-reconcile.mjs --self-test
 *     node scripts/voice-realtime-reconcile.mjs --check <file> --json
 *
 * Exit code 0 only when the document is internally consistent AND its bill column is not empty.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Prices per 1,000 tokens, the October 2026 bill `estimateRealtimeCostCny` is built on. */
const PRICE_CNY_PER_1K = { textInput: 0.0015, audioInput: 0.006, textOutput: 0.0045 };

/** How far a recomputed figure may sit from the recorded one before it is a disagreement. */
const TOLERANCE = 0.01;

/** The list price of one bill line that a human still has to supply, spelled in the record as this. */
const PENDING_BILL = 'pending-external';

/** The summary keys the record must carry, and what each is read against. */
const REQUIRED_READINGS = [
  'segments',
  'audioSecondsUpstream',
  'textInputTokens',
  'audioInputTokens',
  'textOutputTokens',
  'logEstimateCny',
  'usageSumCny',
  'bill',
];

/** @typedef {{ textInput: number, audioInput: number, textOutput: number, logEstimateCny: number, usageSumCny: number }} ResponseRow */
/** @typedef {{ seq: number, audioSeconds: number }} SegmentRow */
/** @typedef {{ readings: Record<string, string>, responses: ResponseRow[], segments: SegmentRow[] }} Record_ */
/** @typedef {{ ok: boolean, problems: string[], notes: string[], readings: Record<string, string> }} Verdict */

/** @param {unknown} value @returns {string | null} */
function str(value) {
  return typeof value === 'string' ? value : null;
}

/** @param {string} cell @returns {number | null} */
function cellNum(cell) {
  const trimmed = cell.trim().replace(/[¥,]/g, '');
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** @param {number} a @param {number} b @returns {number} */
function relDiff(a, b) {
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale === 0 ? 0 : Math.abs(a - b) / scale;
}

/** @param {string} line @returns {string[] | null} */
function tableCells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  // A markdown table's separator row (`|---|---|`) is not data.
  if (/^\|[\s:|-]+\|$/.test(trimmed)) return null;
  return trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim().replace(/^`|`$/g, ''));
}

/**
 * Splits a markdown document into `## `-headed sections, each as its list of lines.
 *
 * @param {string} markdown
 * @returns {Map<string, string[]>}
 */
function parseSections(markdown) {
  /** @type {Map<string, string[]>} */
  const sections = new Map();
  let current = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading) {
      current = heading[1].trim();
      sections.set(current, []);
      continue;
    }
    if (current !== null) sections.get(current)?.push(line);
  }
  return sections;
}

/**
 * Reads the first markdown table under a heading, as a list of `{ <header>: <cell> }` rows.
 *
 * @param {string[] | undefined} lines
 * @returns {Array<Record<string, string>>}
 */
function rowsOf(lines) {
  if (lines === undefined) return [];
  /** @type {string[] | null} */
  let header = null;
  /** @type {Array<Record<string, string>>} */
  const rows = [];
  for (const line of lines) {
    const cells = tableCells(line);
    if (cells === null) {
      // A blank line before the table is fine; a blank line after it ends the table.
      if (header !== null && line.trim() === '') break;
      continue;
    }
    if (header === null) {
      header = cells;
      continue;
    }
    /** @type {Record<string, string>} */
    const row = {};
    header.forEach((name, index) => {
      row[name] = cells[index] ?? '';
    });
    rows.push(row);
  }
  return rows;
}

/**
 * Reads one record document into its readings, its per-response rows and its per-segment rows.
 *
 * @param {string} markdown
 * @returns {Record_}
 */
export function parseRecord(markdown) {
  const sections = parseSections(markdown);
  /** @type {Record<string, string>} */
  const readings = {};
  for (const row of rowsOf(sections.get('读数'))) {
    const key = row['指标'] ?? '';
    if (key !== '') readings[key] = row['值'] ?? '';
  }
  /** @type {ResponseRow[]} */
  const responses = [];
  for (const row of rowsOf(sections.get('逐响应'))) {
    responses.push({
      textInput: cellNum(row['textInput'] ?? '') ?? Number.NaN,
      audioInput: cellNum(row['audioInput'] ?? '') ?? Number.NaN,
      textOutput: cellNum(row['textOutput'] ?? '') ?? Number.NaN,
      logEstimateCny: cellNum(row['logEstimateCny'] ?? '') ?? Number.NaN,
      usageSumCny: cellNum(row['usageSumCny'] ?? '') ?? Number.NaN,
    });
  }
  /** @type {SegmentRow[]} */
  const segments = [];
  for (const row of rowsOf(sections.get('逐段'))) {
    segments.push({
      seq: cellNum(row['seq'] ?? '') ?? Number.NaN,
      audioSeconds: cellNum(row['audioSeconds'] ?? '') ?? Number.NaN,
    });
  }
  return { readings, responses, segments };
}

/**
 * The prices applied to one per-response row's three token classes.
 *
 * @param {ResponseRow} row
 * @returns {number}
 */
export function priceOf(row) {
  return (
    (row.textInput * PRICE_CNY_PER_1K.textInput +
      row.audioInput * PRICE_CNY_PER_1K.audioInput +
      row.textOutput * PRICE_CNY_PER_1K.textOutput) /
    1000
  );
}

/**
 * Checks one record document. Pure: the whole verdict comes from the text handed in.
 *
 * @param {string} markdown
 * @returns {Verdict}
 */
export function checkRecord(markdown) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const notes = [];
  const { readings, responses, segments } = parseRecord(markdown);

  // (0) Every reading the record is required to carry, non-empty.
  for (const key of REQUIRED_READINGS) {
    if (readings[key] === undefined || readings[key].trim() === '') {
      problems.push(`reading-missing: 读数表缺少非空的「${key}」`);
    }
  }

  /** @param {string} key @returns {number | null} */
  const readingNum = (key) => cellNum(readings[key] ?? '');

  // (1) estimate = price × tokens, per response row.
  if (responses.length === 0) {
    problems.push('responses-missing: 逐响应表为空，无从核对逐响应 usage');
  }
  responses.forEach((row, index) => {
    const label = `response #${index + 1}`;
    for (const field of /** @type {const} */ (['textInput', 'audioInput', 'textOutput', 'logEstimateCny', 'usageSumCny'])) {
      if (!Number.isFinite(row[field])) problems.push(`row-malformed: ${label} 的 ${field} 不是数字`);
    }
    const priced = priceOf(row);
    if (Number.isFinite(row.logEstimateCny) && relDiff(priced, row.logEstimateCny) > TOLERANCE) {
      problems.push(
        `estimate-vs-price: ${label} 单价×token=¥${priced.toFixed(6)} 与记录的 logEstimateCny=¥${row.logEstimateCny.toFixed(6)} 偏差 > ${TOLERANCE * 100}%`,
      );
    }
    if (Number.isFinite(row.usageSumCny) && Number.isFinite(row.logEstimateCny) && relDiff(row.logEstimateCny, row.usageSumCny) > TOLERANCE) {
      problems.push(
        `log-vs-usage: ${label} 日志估算=¥${row.logEstimateCny.toFixed(6)} 与 response.done.usage 之和=¥${row.usageSumCny.toFixed(6)} 偏差 > ${TOLERANCE * 100}%`,
      );
    }
  });

  // (2) The summary totals equal the detail rows' sums.
  /** @param {(row: ResponseRow) => number} pick */
  const sumResponses = (pick) => responses.reduce((total, row) => total + (Number.isFinite(pick(row)) ? pick(row) : 0), 0);
  /** @type {Array<[string, number, number]>} */
  const totals = [
    ['textInputTokens', readingNum('textInputTokens') ?? Number.NaN, sumResponses((row) => row.textInput)],
    ['audioInputTokens', readingNum('audioInputTokens') ?? Number.NaN, sumResponses((row) => row.audioInput)],
    ['textOutputTokens', readingNum('textOutputTokens') ?? Number.NaN, sumResponses((row) => row.textOutput)],
    ['logEstimateCny', readingNum('logEstimateCny') ?? Number.NaN, sumResponses((row) => row.logEstimateCny)],
    ['usageSumCny', readingNum('usageSumCny') ?? Number.NaN, sumResponses((row) => row.usageSumCny)],
  ];
  for (const [key, stated, summed] of totals) {
    if (!Number.isFinite(stated)) {
      problems.push(`reading-malformed: 读数「${key}」不是数字`);
      continue;
    }
    if (relDiff(stated, summed) > TOLERANCE) {
      problems.push(`summary-vs-detail: 读数「${key}」=${stated} 与逐响应合计=${summed} 偏差 > ${TOLERANCE * 100}%`);
    }
  }

  // (3) The segment readings cover the same run as the totals.
  const statedSegments = readingNum('segments');
  if (statedSegments !== null && statedSegments !== segments.length) {
    problems.push(`segments-vs-rows: 读数 segments=${statedSegments} 与逐段表 ${segments.length} 行不符`);
  }
  const statedAudio = readingNum('audioSecondsUpstream');
  const summedAudio = segments.reduce((total, row) => total + (Number.isFinite(row.audioSeconds) ? row.audioSeconds : 0), 0);
  if (statedAudio !== null && segments.length > 0 && relDiff(statedAudio, summedAudio) > TOLERANCE) {
    problems.push(`audio-vs-segments: 读数 audioSecondsUpstream=${statedAudio} 与逐段合计=${summedAudio} 偏差 > ${TOLERANCE * 100}%`);
  }

  // (4) The bill column: outstanding, agreeing, or a failure. NEVER silently a pass.
  const bill = (readings['bill'] ?? '').trim();
  const estimate = readingNum('logEstimateCny');
  if (bill === '') {
    // The false form this script exists to catch: an empty bill is not a reconciliation.
    problems.push('bill-missing: 账单列为空 —— 缺账单不等于对账成功');
  } else if (bill === PENDING_BILL) {
    notes.push(
      `账单：${PENDING_BILL} —— 本地估算 ¥${estimate === null ? '?' : estimate.toFixed(4)} 尚**未**与阿里云账单核对（待外部提供账单行）`,
    );
  } else {
    const billed = cellNum(bill);
    if (billed === null) {
      problems.push(`bill-unrecognized: 账单列「${bill}」既不是 ${PENDING_BILL} 也不是一个金额`);
    } else if (estimate === null) {
      problems.push('bill-vs-estimate: 账单为金额但本地估算缺失，无法核对');
    } else if (relDiff(billed, estimate) > TOLERANCE) {
      problems.push(`bill-vs-estimate: 账单 ¥${billed.toFixed(4)} 与本地估算 ¥${estimate.toFixed(4)} 偏差 > ${TOLERANCE * 100}%`);
    } else {
      notes.push(`账单：¥${billed.toFixed(4)} 与本地估算一致（≤ ${TOLERANCE * 100}%）`);
    }
  }

  return { ok: problems.length === 0, problems, notes, readings };
}

/**
 * The well-formed and each-of-four-ways-wrong documents `--self-test` runs the checker against.
 *
 * A document is built from a template so a case differs from the good one in exactly one respect —
 * which is what makes the verdict separation a statement about THAT check and not about the fixture.
 *
 * @param {Partial<{ reading: Record<string, string>, row: Record<string, string> }>} overrides
 * @returns {string}
 */
function documentFor(overrides = {}) {
  const readings = {
    segments: '2',
    audioSecondsUpstream: '6.0',
    textInputTokens: '2900',
    audioInputTokens: '42',
    textOutputTokens: '36',
    logEstimateCny: '0.004764',
    usageSumCny: '0.004764',
    bill: PENDING_BILL,
    ...overrides.reading,
  };
  // One response of the SPEC's default pack: text 1,450 in, audio 21 in (3 s × 7), 18 out. Two of
  // these are one sentence, so the pair costs the SPEC's own ¥0.004764.
  const goodRow = {
    textInput: '1450',
    audioInput: '21',
    textOutput: '18',
    logEstimateCny: '0.002382',
    usageSumCny: '0.002382',
    ...overrides.row,
  };
  const cell = (/** @type {Record<string, string>} */ row, /** @type {string[]} */ keys) =>
    keys.map((key) => `${row[key] ?? ''}`).join(' | ');
  const responseKeys = ['textInput', 'audioInput', 'textOutput', 'logEstimateCny', 'usageSumCny'];
  return [
    '# self-test record',
    '',
    '## 读数',
    '',
    '| 指标 | 值 |',
    '| --- | --- |',
    ...Object.entries(readings).map(([key, value]) => `| ${key} | ${value} |`),
    '',
    '## 逐响应',
    '',
    `| ${responseKeys.join(' | ')} |`,
    `| ${responseKeys.map(() => '---').join(' | ')} |`,
    `| ${cell(goodRow, responseKeys)} |`,
    `| ${cell(goodRow, responseKeys)} |`,
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

/**
 * Runs the checker against a good document and four deliberately broken ones.
 *
 * @returns {string[]} one line per case, `ok`/`FAIL` prefixed; the caller decides the exit code.
 */
export function selfTest() {
  /** @type {string[]} */
  const lines = [];
  /** @param {string} name @param {string} markdown @param {boolean} wantOk */
  const expect = (name, markdown, wantOk) => {
    const verdict = checkRecord(markdown);
    const pass = verdict.ok === wantOk;
    lines.push(
      `${pass ? 'ok  ' : 'FAIL'} ${name}: ok=${verdict.ok}（期望 ${wantOk}）${
        verdict.problems.length > 0 ? ` — ${verdict.problems[0]}` : ''
      }`,
    );
    return pass;
  };

  const results = [
    expect('well-formed，账单 pending-external ⇒ 通过（并如实报告未对账）', documentFor(), true),
    expect(
      '日志估算 ≠ response.done.usage 之和 ⇒ 红',
      documentFor({ row: { usageSumCny: '0.003500' }, reading: { usageSumCny: '0.007000' } }),
      false,
    ),
    expect(
      '估算 ≠ 单价×token ⇒ 红',
      documentFor({ row: { logEstimateCny: '0.010000', usageSumCny: '0.010000' }, reading: { logEstimateCny: '0.020000', usageSumCny: '0.020000' } }),
      false,
    ),
    // The false form AC-322 names: an empty bill must NOT read as success.
    expect('账单列为空 ⇒ 红（空账单不当成功）', documentFor({ reading: { bill: '' } }), false),
    expect('逐响应合计 ≠ 读数合计 ⇒ 红', documentFor({ reading: { textInputTokens: '9999' } }), false),
  ];

  // The pending-bill case must also SAY it is pending, not merely pass.
  const pendingVerdict = checkRecord(documentFor());
  const pendingSaid = pendingVerdict.notes.some((note) => note.includes(PENDING_BILL) && note.includes('未'));
  lines.push(`${pendingSaid ? 'ok  ' : 'FAIL'} pending 账单被如实报告为未对账`);
  results.push(pendingSaid);

  return [...lines, results.every(Boolean) ? 'SELF-TEST PASS' : 'SELF-TEST FAIL'];
}

/** The `--check`/`--self-test` entry point. */
function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');

  if (argv.includes('--self-test')) {
    const lines = selfTest();
    console.log(lines.join('\n'));
    process.exitCode = lines.at(-1) === 'SELF-TEST PASS' ? 0 : 1;
    return;
  }

  const checkAt = argv.indexOf('--check');
  if (checkAt === -1) {
    console.error('usage: voice-realtime-reconcile.mjs --check <record.md> [--json] | --self-test');
    process.exitCode = 2;
    return;
  }
  const file = argv[checkAt + 1];
  if (file === undefined || file.startsWith('--')) {
    console.error('usage: voice-realtime-reconcile.mjs --check <record.md> [--json]');
    process.exitCode = 2;
    return;
  }

  let markdown;
  try {
    markdown = readFileSync(file, 'utf8');
  } catch (error) {
    console.error(`could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
    return;
  }

  const verdict = checkRecord(markdown);
  if (json) {
    console.log(JSON.stringify({ file, ...verdict }, null, 2));
  } else {
    console.log(`record: ${file}`);
    for (const [key, value] of Object.entries(verdict.readings)) console.log(`  ${key} = ${value}`);
    for (const note of verdict.notes) console.log(`  · ${note}`);
    for (const problem of verdict.problems) console.log(`  ✗ ${problem}`);
    console.log(verdict.ok ? 'RECONCILE OK（本地一致）' : `RECONCILE FAILED（${verdict.problems.length} 处）`);
  }
  process.exitCode = verdict.ok ? 0 : 1;
}

// Importable for the self-test harness, runnable as a CLI.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
