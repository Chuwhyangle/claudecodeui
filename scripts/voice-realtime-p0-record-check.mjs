#!/usr/bin/env node
/**
 * The P0 record checker.
 *
 * WHAT IT IS FOR. `experiments/voice-realtime-segmented/p0/` runs three probes against the LIVE
 * DashScope endpoint and leaves three raw traces plus a `RESULT.json`. A `verdict` field in a file
 * somebody ran once is a claim about the past, not a reading — so this script re-derives every
 * verdict from the RAW FRAMES in the traces, and fails when the record disagrees with the frames.
 *
 * THE DERIVATION IS THE POINT. For each stage the probes write both the frames and an `evidence`
 * block summarising them. This script recomputes that summary FROM THE FRAMES and requires the two
 * to be equal; the verdict is then computed from its OWN reading. Two independent readings of one
 * frame log agreeing is falsifiable; a verdict copied from the summary it is checking is not.
 *
 * WHAT IT READS, exactly:
 *
 *   S1  sent `session.update` whose `session.turn_detection` is null, sent `input_audio_buffer.commit`
 *       and `response.create` counts, received `response.done` count, received `session_send` CALLS
 *       (either dialect — `response.function_call_arguments.done`, or a `function_call` output item —
 *       de-duplicated on `call_id`, because the endpoint delivers one call in both), and error frames
 *       (received `error` frames plus the transport's own recorded errors).
 *   S2  the timing sample (`establishment.timings`), the active session's `response.done` count, and
 *       whether the PREWARMED standby answered the first segment after that — re-derived from the
 *       standby session's own frames, never from the `outcome` field.
 *   S3  per response record: `forwarded` and `forwardedMessage` recomputed from that record's frames
 *       and compared with the recorded values; then the counts, the 12-record requirement, and the
 *       per-record keys AC5 names.
 *
 * WHAT IT REFUSES. A missing trace, an `sk-…`-shaped string anywhere in the traces, a stage whose
 * derived verdict differs from the recorded one, Σ `spendCny` over the 0.04 total, a `ranAt` order
 * that does not run S1 → S2 → S3, and (with `--spec`) a SPEC "P0 结论" section that does not state
 * the same verdict / evidence file / key numbers / spend.
 *
 *     node scripts/voice-realtime-p0-record-check.mjs experiments/voice-realtime-segmented/p0/RESULT.json --stage a
 *     node scripts/voice-realtime-p0-record-check.mjs experiments/voice-realtime-segmented/p0/RESULT.json --spec
 *     node scripts/voice-realtime-p0-record-check.mjs experiments/voice-realtime-segmented/p0/RESULT.json --write-result
 *
 * `--write-result` is how `RESULT.json` is produced in the first place: the stage entries are copied
 * out of the traces this script just derived them from, which is what makes "derived, not written by
 * hand" true of the record and not just of this file. Paths inside `RESULT.json` are resolved
 * relative to `RESULT.json` itself, so a fixture tree can be validated on its own.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The task's declared ceiling for all three stages together, in CNY. */
const TOTAL_BUDGET_CNY = 0.04;

/** The canonical trace for each stage, relative to the result file. */
/** @type {Record<string, string>} */
const STAGE_TRACES = {
  S1: 'traces/s1-manual-commit.json',
  S2: 'traces/s2-session-rotation.json',
  S3: 'traces/s3-context-injection.json',
};

/** `--stage a` covers exactly these. A later P0b may append stages; this checker does not police them. */
const STAGE_A = ['S1', 'S2', 'S3'];

/** A credential-shaped token. Nothing this script reads may contain one. */
const SECRET_SHAPE = /sk-[A-Za-z0-9]{16,}/;

/** The SPEC that `--spec` cross-checks. */
const SPEC_FILE = 'docs/proposals/voice-realtime-segmented-relay-SPEC.md';

/** @typedef {Record<string, unknown>} Obj */
/** @typedef {{ evidence: Obj, readings: Obj, verdict: string, handoverOutcome?: string }} Derived */

/** @param {unknown} value @returns {value is Obj} */
function isObj(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {Obj[]} */
function objList(value) {
  return Array.isArray(value) ? value.filter(isObj) : [];
}

/** @param {unknown} value @returns {string | null} */
function str(value) {
  return typeof value === 'string' ? value : null;
}

/** @param {unknown} value @returns {number | null} */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** @param {unknown} value @returns {boolean | null} */
function bool(value) {
  return typeof value === 'boolean' ? value : null;
}

// ── frame readers ───────────────────────────────────────────────────────────────────────────────

/** @param {Obj} event @returns {Obj} */
function wireOf(event) {
  return isObj(event.wire) ? event.wire : {};
}

/** @param {unknown} events @returns {Obj[]} */
function frames(events) {
  return objList(events).filter((event) => isObj(event.wire));
}

/** @param {unknown} events @returns {Obj[]} */
function sentFrames(events) {
  return frames(events).filter((event) => event.direction === 'sent');
}

/** @param {unknown} events @returns {Obj[]} */
function receivedFrames(events) {
  return frames(events).filter((event) => event.direction === 'received');
}

/** @param {Obj} event @returns {boolean} */
function isErrorFrame(event) {
  const type = wireOf(event).type;
  return type === 'error' || type === 'transport.error';
}

/**
 * The endpoint's or the transport's own words for an error, or `null` for a frame that is not one.
 * A `transport.error` carries a `code` where the endpoint's `error` carries `error.message`.
 *
 * @param {Obj} event @returns {string | null}
 */
function errorText(event) {
  const wire = wireOf(event);
  if (wire.type === 'error') {
    const error = isObj(wire.error) ? wire.error : {};
    return str(error.message) ?? str(error.code);
  }
  if (wire.type === 'transport.error') return str(wire.message) ?? str(wire.code) ?? str(wire.reason);
  return null;
}

/**
 * Every error a session recorded: the `error` frames the observer saw, plus the transport's own
 * `transport.error` entries, which reach `errors` without ever being a frame. The probes count the
 * same two parts, so the two readings can be compared exactly.
 *
 * @param {unknown} events @param {unknown} recordedErrors @returns {number}
 */
function errorCount(events, recordedErrors) {
  const fromFrames = receivedFrames(events).filter(isErrorFrame).length;
  const fromTransport = objList(recordedErrors).filter((entry) => wireOf(entry).type === 'transport.error').length;
  return fromFrames + fromTransport;
}

/** @param {unknown} events @param {unknown} recordedErrors @returns {string[]} */
function errorTexts(events, recordedErrors) {
  const texts = receivedFrames(events)
    .filter(isErrorFrame)
    .map(errorText)
    .filter((text) => text !== null);
  const transport = objList(recordedErrors)
    .map(errorText)
    .filter((text) => text !== null);
  return [...texts, ...transport];
}

/**
 * True for any inbound delivery of a function call named `name`, in EITHER dialect the shipping
 * transport normalises (`response.function_call_arguments.done`, and a `function_call` output item
 * inside `response.output_item.done`). Both are counted, because a probe that only understood one
 * would report "did not forward" for a call that was in fact delivered.
 *
 * @param {Obj} event @param {string} name @returns {boolean}
 */
function isFunctionCall(event, name) {
  const wire = wireOf(event);
  if (wire.type === 'response.function_call_arguments.done') return wire.name === name;
  if (wire.type === 'response.output_item.done') {
    const item = isObj(wire.item) ? wire.item : {};
    return item.type === 'function_call' && item.name === name;
  }
  return false;
}

/** @param {Obj} event @returns {string | null} */
function functionCallArguments(event) {
  const wire = wireOf(event);
  if (wire.type === 'response.function_call_arguments.done') return str(wire.arguments);
  if (wire.type === 'response.output_item.done') {
    const item = isObj(wire.item) ? wire.item : {};
    return item.type === 'function_call' ? str(item.arguments) : null;
  }
  return null;
}

/**
 * The message a forwarded `session_send` call asked to send, or `null`. The arguments travel as a
 * JSON string in the frame, so a call whose arguments are not JSON is a forwarding that happened but
 * cannot be compared — which must not be read as "did not forward".
 *
 * @param {Obj} event @returns {{ message: string | null, callId: string | null } | null}
 */
function sessionSend(event) {
  if (!isFunctionCall(event, 'session_send')) return null;
  const wire = wireOf(event);
  const item = isObj(wire.item) ? wire.item : {};
  const callId = str(wire.call_id) ?? str(item.call_id);
  const raw = functionCallArguments(event);
  if (raw === null) return { message: null, callId };
  try {
    const parsed = JSON.parse(raw);
    return { message: isObj(parsed) ? str(parsed.message) : null, callId };
  } catch {
    return { message: null, callId };
  }
}

/**
 * The `session_send` CALLS the frames carry, in arrival order — one entry per call, not per delivery.
 *
 * The live endpoint delivers one call in BOTH dialects under one `call_id`, so a reader that simply
 * concatenated them would report two forwards per forward. The call_id is the identity and the first
 * delivery of it wins, which is the same rule `sessionSendFrames` in `probe-lib.mts` applies to the
 * probe's side of the same frames.
 *
 * @param {unknown} events @returns {Array<{ message: string | null, callId: string | null }>}
 */
function sessionSends(events) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Array<{ message: string | null, callId: string | null }>} */
  const calls = [];
  for (const event of receivedFrames(events)) {
    const call = sessionSend(event);
    if (call === null) continue;
    if (call.callId !== null) {
      if (seen.has(call.callId)) continue;
      seen.add(call.callId);
    }
    calls.push(call);
  }
  return calls;
}

// ── the report ──────────────────────────────────────────────────────────────────────────────────

class Report {
  constructor() {
    /** @type {string[]} */
    this.problems = [];
    /** @type {string[]} */
    this.notes = [];
  }

  /** @param {string} message */
  fail(message) {
    this.problems.push(message);
  }

  /** @param {string} message */
  note(message) {
    this.notes.push(message);
  }

  /**
   * Fails unless `actual` equals `expected` exactly — the comparison the whole script rests on.
   * @param {string} what @param {unknown} actual @param {unknown} expected
   */
  equal(what, actual, expected) {
    if (actual !== expected) {
      this.fail(`${what}: recorded ${JSON.stringify(expected)}, frames say ${JSON.stringify(actual)}`);
      return false;
    }
    return true;
  }
}

// ── S1 ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * @param {Obj} trace @param {Report} report @returns {Derived}
 */
function deriveS1(trace, report) {
  const attempts = objList(trace.attempts);
  const events = attempts.flatMap((attempt) => objList(attempt.events));
  const sent = sentFrames(events);
  const received = receivedFrames(events);
  const recordedErrors = attempts.flatMap((attempt) => objList(attempt.errors));
  const texts = errorTexts(events, recordedErrors);

  const readings = {
    manualSessionBodySent: sent.some((event) => {
      const wire = wireOf(event);
      return wire.type === 'session.update' && isObj(wire.session) && wire.session.turn_detection === null;
    }),
    commitsSent: sent.filter((event) => wireOf(event).type === 'input_audio_buffer.commit').length,
    responseCreatesSent: sent.filter((event) => wireOf(event).type === 'response.create').length,
    responsesCompleted: received.filter((event) => wireOf(event).type === 'response.done').length,
    sessionSendCalls: sessionSends(events).length,
    errorFrames: errorCount(events, recordedErrors),
  };

  const recorded = isObj(trace.evidence) ? trace.evidence : {};
  const table = /** @type {Record<string, unknown>} */ (readings);
  for (const key of Object.keys(readings)) report.equal(`S1 evidence.${key}`, table[key], recorded[key]);

  // AC3's shape requirements, read off the frames rather than off the summary.
  if (readings.manualSessionBodySent !== true) {
    report.fail('S1: no SENT `session.update` with `session.turn_detection: null` appears in the frames');
  }
  if (readings.commitsSent < 1) {
    report.fail('S1: no SENT `input_audio_buffer.commit` appears in the frames');
  }
  if (readings.sessionSendCalls < 1 && texts.length === 0) {
    report.fail('S1: neither a `session_send` call nor an error carrying its text appears in the frames');
  }
  if (texts.length > 0) report.note(`S1 errors: ${texts.map((text) => text.slice(0, 120)).join(' | ')}`);

  const verdict =
    readings.errorFrames > 0 && readings.sessionSendCalls === 0
      ? 'unsupported'
      : readings.sessionSendCalls > 0 && readings.manualSessionBodySent && readings.commitsSent > 0
        ? 'supported'
        : 'inconclusive';

  return { evidence: readings, readings, verdict };
}

// ── S2 ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * @param {Obj} trace @param {Report} report @returns {Derived}
 */
function deriveS2(trace, report) {
  const establishment = isObj(trace.establishment) ? trace.establishment : {};
  const timings = objList(establishment.timings);
  const handover = isObj(trace.handover) ? trace.handover : {};
  const active = isObj(handover.active) ? handover.active : {};
  const standby = isObj(handover.standby) ? handover.standby : {};

  // The standby's answer is read from ITS OWN frames, never from `handover.outcome`.
  const standbyAnswered = receivedFrames(standby.events).some((event) => wireOf(event).type === 'response.done');
  const standbyErrors = errorCount(standby.events, standby.errors);
  const handoverOutcome = standbyAnswered ? 'ok' : standbyErrors > 0 ? 'error' : 'timeout';

  const warmAtMs = num(standby.warmAtMs);
  const activeDoneAtMs = num(active.responseDoneAtMs);
  const readings = {
    timedEstablishments: timings.length,
    establishmentsWithUpdated: timings.filter((timing) => num(timing.openToUpdatedMs) !== null).length,
    activeResponseDone: receivedFrames(active.events).filter((event) => wireOf(event).type === 'response.done').length,
    standbyWarmedBeforeActiveDone: warmAtMs !== null && activeDoneAtMs !== null && warmAtMs <= activeDoneAtMs,
    standbyTookFirstSegment: standbyAnswered,
    standbyErrorFrames: standbyErrors,
  };

  const recorded = isObj(trace.evidence) ? trace.evidence : {};
  const table = /** @type {Record<string, unknown>} */ (readings);
  for (const key of Object.keys(readings)) report.equal(`S2 evidence.${key}`, table[key], recorded[key]);
  if (handoverOutcome !== str(handover.outcome)) {
    report.fail(`S2 handover.outcome: recorded ${JSON.stringify(handover.outcome)}, frames say ${handoverOutcome}`);
  }

  // AC4: the distribution has to be a distribution, and the handover has to be a handover.
  if (readings.timedEstablishments < 5) {
    report.fail(`S2: ${readings.timedEstablishments} timed establishments, fewer than the 5 the criterion requires`);
  }
  const spread = isObj(establishment.updatedMs) ? establishment.updatedMs : {};
  if (num(spread.p50) === null || num(spread.p90) === null) {
    report.fail('S2: the establishment timing sample carries no p50/p90');
  }
  if (readings.activeResponseDone < 1) {
    report.fail('S2: the active session never completed a `response.done`, so there was nothing to hand over FROM');
  }
  if (handoverOutcome === 'timeout') {
    report.fail('S2: the standby answered with neither a response nor an error after the handover');
  }

  const verdict = handoverOutcome === 'ok' ? 'supported' : handoverOutcome === 'error' ? 'unsupported' : 'inconclusive';
  return { evidence: readings, readings, verdict, handoverOutcome };
}

// ── S3 ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * @param {Obj} trace @param {Report} report @returns {Derived}
 */
function deriveS3(trace, report) {
  const records = objList(trace.responses);
  /** @type {boolean[]} */
  const forwardedFlags = [];
  /** @type {number[]} */
  const distances = [];
  /** @type {number[]} */
  const tokens = [];
  let identifierBearing = 0;
  let identifierHits = 0;
  let timedOut = 0;
  let errorFrames = 0;

  records.forEach((record, index) => {
    const label = `S3 responses[${index}] (${str(record.label) ?? '?'})`;
    const events = objList(record.events);
    const calls = sessionSends(events);
    const forwarded = calls.length > 0;
    // The recorded flags are checked against the frames, one record at a time: a `forwarded: true`
    // written by hand would survive every aggregate check and die here.
    if (!('forwarded' in record)) report.fail(`${label}: no \`forwarded\` key`);
    else report.equal(`${label} forwarded`, forwarded, record.forwarded);
    if (!('editDistance' in record)) report.fail(`${label}: no \`editDistance\` key`);
    if (!('identifierHit' in record)) report.fail(`${label}: no \`identifierHit\` key`);
    if (!isObj(record.usage) || num(record.usage.input_tokens) === null) {
      report.fail(`${label}: no \`usage.input_tokens\``);
    }
    const distance = num(record.editDistance);
    if (distance !== null && (distance < 0 || distance > 1)) {
      report.fail(`${label}: editDistance ${distance} is outside 0–1`);
    }
    // A forwarded message has to be the one the FRAMES carried, not one the probe remembered.
    const message = calls.length === 0 ? null : calls[calls.length - 1].message;
    report.equal(`${label} forwardedMessage`, message, record.forwardedMessage === undefined ? null : record.forwardedMessage);

    forwardedFlags.push(forwarded);
    if (distance !== null) distances.push(distance);
    const tokenCount = isObj(record.usage) ? num(record.usage.input_tokens) : null;
    if (tokenCount !== null) tokens.push(tokenCount);
    if (record.identifierHit === true || record.identifierHit === false) {
      identifierBearing += 1;
      if (record.identifierHit === true) identifierHits += 1;
    }
    if (record.timedOut === true) timedOut += 1;
    errorFrames += errorCount(events, record.errors);
  });

  const completed = records.filter((record) => str(record.responseId) !== null).length;
  const forwarded = forwardedFlags.filter(Boolean).length;
  const readings = {
    plannedResponses: records.length,
    responsesRecorded: records.length,
    responsesCompleted: completed,
    forwarded,
    identifierBearingResponses: identifierBearing,
    identifierHits,
    errorFrames,
    timedOut,
  };

  const recorded = isObj(trace.evidence) ? trace.evidence : {};
  const table = /** @type {Record<string, unknown>} */ (readings);
  for (const key of Object.keys(readings)) report.equal(`S3 evidence.${key}`, table[key], recorded[key]);

  // AC5: twelve records, six utterances twice — each of them carrying its four readings.
  if (records.length !== 12) report.fail(`S3: ${records.length} response records, the criterion requires 12 (6 × 2)`);
  const utterances = new Set(records.map((record) => str(record.utteranceId)));
  const repeats = new Set(records.map((record) => num(record.repeat)));
  if (utterances.size !== 6 || repeats.size !== 2) {
    report.fail(`S3: ${utterances.size} distinct utterances × ${repeats.size} repeats, the criterion requires 6 × 2`);
  }

  const verdict = completed === 0 ? 'inconclusive' : forwarded === completed ? 'supported' : 'unsupported';
  const evidence = { ...readings, inputTokens: { n: tokens.length }, editDistance: { n: distances.length } };
  return { evidence, readings, verdict };
}

// ── the stage table ─────────────────────────────────────────────────────────────────────────────

/** @type {Record<string, (trace: Obj, report: Report) => Derived>} */
const DERIVERS = { S1: deriveS1, S2: deriveS2, S3: deriveS3 };

/**
 * The `key=value` tokens each stage's SPEC line must carry, so "关键数字" is a requirement the
 * checker enforces rather than a wish. Documented in the README next to the SPEC section.
 *
 * @param {string} stage @param {Obj} readings @param {string} handoverOutcome @returns {string[]}
 */
function specMetricTokens(stage, readings, handoverOutcome) {
  if (stage === 'S1') return [`commits=${readings.commitsSent}`, `session_send=${readings.sessionSendCalls}`];
  if (stage === 'S2') return [`n=${readings.timedEstablishments}`, `handover=${handoverOutcome}`];
  return [`forwarded=${readings.forwarded}/${readings.responsesCompleted}`];
}

// ── the SPEC cross-check ────────────────────────────────────────────────────────────────────────

/**
 * The body of the SPEC's "P0 结论" section, heading excluded. `null` when the section is absent —
 * which is a failure, not an empty section.
 *
 * @param {string} markdown @returns {string[] | null}
 */
function conclusionSection(markdown) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => /^#{1,6}\s*P0\s*结论/.test(line.trim()));
  if (start === -1) return null;
  const level = ((lines[start].trim().match(/^#+/) ?? ['#'])[0] ?? '#').length;
  const body = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const heading = lines[index].trim().match(/^(#+)\s/);
    if (heading !== null && heading[1].length <= level) break;
    body.push(lines[index]);
  }
  return body;
}

/**
 * One stage's line in the SPEC's conclusion: the derived verdict, the evidence file, the spend, and
 * the stage's key numbers all have to be stated, or the prose is not a record of the run.
 *
 * @param {string} stage @param {string} body @param {Derived} derived @param {number} spendCny
 * @param {string} evidenceBasename @param {Report} report
 */
function checkSpecLine(stage, body, derived, spendCny, evidenceBasename, report) {
  const matching = body
    .split('\n')
    .filter((line) => new RegExp(`^\\s*[-*]\\s*${stage}\\b`).test(line));
  if (matching.length !== 1) {
    report.fail(`SPEC P0 结论: ${matching.length} lines start with ${stage}, exactly one is required`);
    return;
  }
  const line = matching[0];
  if (!line.includes(derived.verdict)) {
    report.fail(`SPEC P0 结论 ${stage}: does not state the derived verdict \`${derived.verdict}\``);
  }
  if (!line.includes(evidenceBasename)) {
    report.fail(`SPEC P0 结论 ${stage}: does not name the evidence file \`${evidenceBasename}\``);
  }
  const money = `¥${spendCny.toFixed(6)}`;
  if (!line.includes(money)) report.fail(`SPEC P0 结论 ${stage}: does not state the spend \`${money}\``);
  for (const token of specMetricTokens(stage, derived.readings, derived.handoverOutcome ?? '')) {
    if (!line.includes(token)) report.fail(`SPEC P0 结论 ${stage}: does not state the key number \`${token}\``);
  }
}

// ── the run ─────────────────────────────────────────────────────────────────────────────────────

/** @param {string} file @returns {string | null} */
function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** @param {string} file @returns {Obj | null} */
function readJson(file) {
  const text = readText(file);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    return isObj(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** @param {string} text @param {string} where @param {Report} report */
function scanForSecrets(text, where, report) {
  const match = text.match(SECRET_SHAPE);
  if (match !== null) report.fail(`${where}: carries an \`sk-…\`-shaped string`);
}

function main() {
  const argv = process.argv.slice(2);
  const resultArg = argv.find((arg) => !arg.startsWith('--'));
  if (resultArg === undefined) {
    console.error('usage: node scripts/voice-realtime-p0-record-check.mjs <RESULT.json> [--stage a|--spec|--write-result]');
    process.exitCode = 2;
    return;
  }
  const stageA = argv.some((arg) => arg === '--stage' || arg === '--stage=a' || arg.startsWith('--stage='));
  const spec = argv.includes('--spec');
  const writeResult = argv.includes('--write-result');

  const resultPath = path.resolve(process.cwd(), resultArg);
  const resultDir = path.dirname(resultPath);
  const report = new Report();

  const result = writeResult ? null : readJson(resultPath);
  if (!writeResult && result === null) {
    console.error(`record check FAILED: cannot read ${resultArg} as a JSON object`);
    process.exitCode = 1;
    return;
  }
  if (result !== null) {
    const resultText = readText(resultPath) ?? '';
    scanForSecrets(resultText, resultArg, report);
    if (num(result.totalBudgetCny) === null) report.fail('RESULT.json: no numeric `totalBudgetCny`');
  }

  const recordedStages = result === null ? [] : objList(result.stages);
  /** @type {Obj[]} */
  const stageEntries = [];
  /** @type {Map<string, Derived>} */
  const derivedByStage = new Map();

  for (const stage of STAGE_A) {
    const recorded = recordedStages.find((entry) => entry.stage === stage);
    if (recorded === undefined && !writeResult) {
      report.fail(`${stage}: no stage entry in ${path.basename(resultPath)}`);
      continue;
    }
    const relative = recorded === undefined ? STAGE_TRACES[stage] : str(recorded.evidence);
    if (relative === null) {
      report.fail(`${stage}: the stage entry names no evidence file`);
      continue;
    }
    if (path.basename(relative) !== path.basename(STAGE_TRACES[stage])) {
      report.fail(`${stage}: evidence \`${relative}\` is not the canonical \`${STAGE_TRACES[stage]}\``);
      continue;
    }
    const text = readText(path.resolve(resultDir, relative));
    if (text === null) {
      report.fail(`${stage}: evidence file \`${relative}\` does not exist`);
      continue;
    }
    scanForSecrets(text, relative, report);
    const trace = readJson(path.resolve(resultDir, relative));
    if (trace === null) {
      report.fail(`${stage}: evidence file \`${relative}\` is not a JSON object`);
      continue;
    }
    if (str(trace.stage) !== stage) {
      report.fail(`${stage}: the trace says its stage is ${JSON.stringify(trace.stage)}`);
    }

    const derived = DERIVERS[stage](trace, report);
    const spendCny = num(trace.spendCny);
    const budgetCny = num(trace.budgetCny);
    const guardTriggered = bool(trace.guardTriggered);
    const ranAt = str(trace.ranAt);
    const notes = str(trace.notes) ?? '';

    if (spendCny === null) report.fail(`${stage}: the trace carries no numeric \`spendCny\``);
    else if (spendCny <= 0) report.fail(`${stage}: spendCny ${spendCny} — a live run that spent nothing is not a live run`);
    if (budgetCny === null) report.fail(`${stage}: the trace carries no numeric \`budgetCny\``);
    if (guardTriggered === null) report.fail(`${stage}: the trace carries no boolean \`guardTriggered\``);
    if (ranAt === null) report.fail(`${stage}: the trace carries no \`ranAt\``);
    if (guardTriggered === true) report.fail(`${stage}: the budget guard tripped — the run was cut short by design`);
    if (recorded !== undefined) {
      // The record is a summary of the trace, so it must agree with it — verdict included.
      report.equal(`${stage} RESULT.verdict`, derived.verdict, recorded.verdict);
      report.equal(`${stage} RESULT.spendCny`, spendCny, recorded.spendCny);
      report.equal(`${stage} RESULT.budgetCny`, budgetCny, recorded.budgetCny);
      report.equal(`${stage} RESULT.guardTriggered`, guardTriggered, recorded.guardTriggered);
      report.equal(`${stage} RESULT.ranAt`, ranAt, recorded.ranAt);
      const recordedSpend = num(recorded.spendCny);
      if (recordedSpend !== null && budgetCny !== null && recordedSpend > budgetCny) {
        report.fail(`${stage}: spend ${String(recorded.spendCny)} exceeds the stage budget ${budgetCny}`);
      }
    }

    report.note(`${stage} ${derived.verdict} — ${notes}`);
    derivedByStage.set(stage, derived);
    stageEntries.push({
      stage,
      verdict: derived.verdict,
      evidence: STAGE_TRACES[stage],
      spendCny: spendCny ?? 0,
      budgetCny,
      guardTriggered,
      ranAt,
      notes,
    });
  }

  // The stages ran in sequence, so their timestamps must not say otherwise.
  const timed = stageEntries.filter((entry) => str(entry.ranAt) !== null);
  for (let index = 1; index < timed.length; index += 1) {
    const previous = /** @type {string} */ (timed[index - 1].ranAt);
    const current = /** @type {string} */ (timed[index].ranAt);
    if (Date.parse(current) < Date.parse(previous)) {
      report.fail(`${timed[index].stage} ranAt ${current} is earlier than ${timed[index - 1].stage} ranAt ${previous}`);
    }
  }

  const totalSpendCny = Number(stageEntries.reduce((sum, entry) => sum + (num(entry.spendCny) ?? 0), 0).toFixed(6));
  const declaredTotal = result === null ? TOTAL_BUDGET_CNY : num(result.totalBudgetCny) ?? TOTAL_BUDGET_CNY;
  if (totalSpendCny > declaredTotal) {
    report.fail(`Σ spendCny ${totalSpendCny} exceeds the total budget ${declaredTotal}`);
  }
  report.note(`Σ spendCny ${totalSpendCny} / ${declaredTotal}`);

  if (writeResult) {
    if (report.problems.length > 0) {
      console.error('record check FAILED — refusing to write RESULT.json:');
      for (const problem of report.problems) console.error(`  · ${problem}`);
      process.exitCode = 1;
      return;
    }
    const payload = {
      schema: 'voice-realtime-p0-result/1',
      generatedBy: 'scripts/voice-realtime-p0-record-check.mjs --write-result',
      totalBudgetCny: TOTAL_BUDGET_CNY,
      totalSpendCny,
      stages: stageEntries,
    };
    writeFileSync(resultPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`wrote ${resultArg} (${stageEntries.length} stages, Σ ¥${totalSpendCny.toFixed(6)})`);
  }

  if (spec) {
    const markdown = readText(path.join(REPO_ROOT, SPEC_FILE));
    if (markdown === null) {
      report.fail(`SPEC cross-check: cannot read ${SPEC_FILE}`);
    } else {
      scanForSecrets(markdown, SPEC_FILE, report);
      const body = conclusionSection(markdown);
      if (body === null) {
        report.fail('SPEC cross-check: the document has no "P0 结论" section');
      } else {
        for (const entry of stageEntries) {
          const derived = derivedByStage.get(/** @type {string} */ (entry.stage));
          if (derived === undefined) continue;
          checkSpecLine(
            /** @type {string} */ (entry.stage),
            body.join('\n'),
            derived,
            /** @type {number} */ (entry.spendCny),
            path.basename(/** @type {string} */ (entry.evidence)),
            report,
          );
        }
      }
    }
  }

  for (const line of report.notes) console.log(`  ${line}`);
  if (report.problems.length > 0) {
    console.error(`record check FAILED (${report.problems.length} problem${report.problems.length === 1 ? '' : 's'}):`);
    for (const problem of report.problems) console.error(`  · ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`record check passed (${spec ? 'spec' : stageA ? 'stage a' : 'stages'})`);
  process.exitCode = 0;
}

main();
