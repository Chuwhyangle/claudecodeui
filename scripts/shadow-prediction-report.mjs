#!/usr/bin/env node
/**
 * Shadow-prediction hit-rate report — the delegation ladder's first evidence.
 *
 * Reads the host-level context event stream (`~/.quay-fleet/context/events/*.jsonl`
 * by default, or `--dir <path>`), pairs every `shadow.prediction` with the
 * `shadow.prediction.outcome` that names it, and prints:
 *
 *   · per-category sample count / hits / hit rate, with the baseline ladder level;
 *   · confidence calibration: for each confidence bucket, the mean stated
 *     confidence and the actual hit rate (a well-calibrated predictor has the two
 *     columns close together);
 *   · the number of lines skipped as malformed and outcomes whose prediction is
 *     absent, so a damage line cannot quietly look like a hit.
 *
 * `--json` prints the same reading as one JSON document. The report is READ-ONLY:
 * it never writes the stream (the fleet owns retention and CloudCLI never deletes
 * an event).
 *
 * Consumers: `scripts/shadow-prediction-report.test.mjs` (AC4, which drives the
 * exported functions over a fixture stream), and the DoD run that compares the
 * table with the delegation probe's single-step reading.
 */
import { readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The baseline levels; mirrors `LADDER_BASELINE` in the TS classifier (scripts cannot import TS). */
const LADDER_BASELINE = /** @type {const} */ ({
  'task-authoring': 'you-do',
  'build-restart': 'you-do',
  'landing-verification': 'system-suggests',
  'progress-check': 'system-suggests',
  'browser-verification': 'you-do',
  release: 'you-do',
  approval: 'system-suggests',
  'session-collaboration': 'you-do',
  diagnosis: 'you-do',
  discussion: 'system-suggests',
});

/** The calibration bucket boundaries: every 20 points of confidence. */
const BUCKET_EDGES = [0, 0.2, 0.4, 0.6, 0.8, 1];

/**
 * @typedef {{ id?: unknown, kind?: unknown, at?: unknown, session?: unknown, data?: unknown }} StreamEvent
 * @typedef {{ predictionId: string, klass: string, confidence: number }} PredictionRow
 * @typedef {{ predictionId: string, actualClass: string, hit: boolean }} OutcomeRow
 * @typedef {{ klass: string, samples: number, hits: number, hitRate: number, level: string }} ClassRow
 * @typedef {{ lower: number, upper: number, samples: number, hits: number, meanConfidence: number, hitRate: number }} CalibrationRow
 * @typedef {{
 *   eventsDir: string,
 *   files: string[],
 *   lines: number,
 *   badLines: number,
 *   ignoredLines: number,
 *   predictions: number,
 *   outcomes: number,
 *   orphanOutcomes: number,
 *   overall: { samples: number, hits: number, hitRate: number },
 *   perClass: ClassRow[],
 *   calibration: CalibrationRow[],
 * }} Report
 */

/** The default events directory, the same one the writer uses. */
export function defaultEventsDir(/** @type {string} */ homeDir = os.homedir()) {
  return path.join(homeDir, '.quay-fleet', 'context', 'events');
}

/**
 * Reads every `*.jsonl` file in `eventsDir` in name order.
 *
 * A line that is not a JSON object is counted in `badLines` and skipped; a
 * well-formed event of another kind is counted as `ignoredLines` (the stream
 * deliberately holds non-shadow events, and they are not damage).
 *
 * @param {string} eventsDir
 * @returns {{ events: StreamEvent[], files: string[], lines: number, badLines: number, ignoredLines: number }}
 */
export function readEventFiles(eventsDir) {
  let files;
  try {
    files = readdirSync(eventsDir)
      .filter((name) => name.endsWith('.jsonl'))
      .sort()
      .map((name) => path.join(eventsDir, name));
  } catch {
    return { events: [], files: [], lines: 0, badLines: 0, ignoredLines: 0 };
  }

  const events = [];
  let lines = 0;
  let badLines = 0;
  let ignoredLines = 0;
  for (const file of files) {
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      if (raw.trim() === '') continue;
      lines += 1;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        badLines += 1;
        continue;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        badLines += 1;
        continue;
      }
      const event = /** @type {StreamEvent} */ (parsed);
      if (event.kind !== 'shadow.prediction' && event.kind !== 'shadow.prediction.outcome') {
        ignoredLines += 1;
        continue;
      }
      events.push(event);
    }
  }
  return { events, files, lines, badLines, ignoredLines };
}

/**
 * @param {StreamEvent} event
 * @returns {PredictionRow | null}
 */
function asPrediction(event) {
  if (event.kind !== 'shadow.prediction') return null;
  const data = event.data;
  if (data === null || typeof data !== 'object') return null;
  const record = /** @type {Record<string, unknown>} */ (data);
  const predictionId = record.predictionId ?? event.id;
  const klass = record.class;
  const confidence = record.confidence;
  if (typeof predictionId !== 'string' || typeof klass !== 'string' || typeof confidence !== 'number') return null;
  if (!Number.isFinite(confidence)) return null;
  return { predictionId, klass, confidence };
}

/**
 * @param {StreamEvent} event
 * @returns {OutcomeRow | null}
 */
function asOutcome(event) {
  if (event.kind !== 'shadow.prediction.outcome') return null;
  const data = event.data;
  if (data === null || typeof data !== 'object') return null;
  const record = /** @type {Record<string, unknown>} */ (data);
  const predictionId = record.predictionId;
  const actualClass = record.actualClass;
  const hit = record.hit;
  if (typeof predictionId !== 'string' || typeof actualClass !== 'string' || typeof hit !== 'boolean') return null;
  return { predictionId, actualClass, hit };
}

/**
 * Builds the report from parsed events. Pure: no filesystem, no clock.
 *
 * @param {StreamEvent[]} events
 * @param {{ eventsDir?: string, files?: string[], lines?: number, badLines?: number, ignoredLines?: number }} [meta]
 * @returns {Report}
 */
export function buildReport(events, meta = {}) {
  /** @type {Map<string, PredictionRow>} */
  const predictions = new Map();
  /** @type {OutcomeRow[]} */
  const outcomes = [];
  for (const event of events) {
    const prediction = asPrediction(event);
    if (prediction !== null) {
      // The prediction event's id IS the prediction id; a data field is accepted
      // as an alias so an older producer keeps pairing.
      predictions.set(prediction.predictionId, prediction);
      if (typeof event.id === 'string') predictions.set(event.id, prediction);
      continue;
    }
    const outcome = asOutcome(event);
    if (outcome !== null) outcomes.push(outcome);
  }

  /** @type {Map<string, { samples: number, hits: number }>} */
  const byClass = new Map();
  /** @type {Array<{ samples: number, hits: number, confidenceSum: number }>} */
  const buckets = BUCKET_EDGES.slice(0, -1).map(() => ({ samples: 0, hits: 0, confidenceSum: 0 }));
  let samples = 0;
  let hits = 0;
  let orphanOutcomes = 0;

  for (const outcome of outcomes) {
    const prediction = predictions.get(outcome.predictionId);
    if (prediction === undefined) {
      orphanOutcomes += 1;
      continue;
    }
    samples += 1;
    if (outcome.hit) hits += 1;

    const row = byClass.get(prediction.klass) ?? { samples: 0, hits: 0 };
    row.samples += 1;
    if (outcome.hit) row.hits += 1;
    byClass.set(prediction.klass, row);

    const index = bucketIndex(prediction.confidence);
    const bucket = buckets[index];
    bucket.samples += 1;
    bucket.confidenceSum += prediction.confidence;
    if (outcome.hit) bucket.hits += 1;
  }

  const perClass = [...byClass.entries()]
    .map(([klass, row]) => ({
      klass,
      samples: row.samples,
      hits: row.hits,
      hitRate: row.samples === 0 ? 0 : row.hits / row.samples,
      level: LADDER_BASELINE[/** @type {keyof typeof LADDER_BASELINE} */ (klass)] ?? 'unknown',
    }))
    .sort((left, right) => right.samples - left.samples || (left.klass < right.klass ? -1 : left.klass > right.klass ? 1 : 0));

  const calibration = buckets.map((bucket, index) => ({
    lower: BUCKET_EDGES[index],
    upper: BUCKET_EDGES[index + 1],
    samples: bucket.samples,
    hits: bucket.hits,
    meanConfidence: bucket.samples === 0 ? 0 : bucket.confidenceSum / bucket.samples,
    hitRate: bucket.samples === 0 ? 0 : bucket.hits / bucket.samples,
  }));

  return {
    eventsDir: meta.eventsDir ?? '',
    files: meta.files ?? [],
    lines: meta.lines ?? events.length,
    badLines: meta.badLines ?? 0,
    ignoredLines: meta.ignoredLines ?? 0,
    predictions: new Set([...predictions.values()].map((prediction) => prediction.predictionId)).size,
    outcomes: outcomes.length,
    orphanOutcomes,
    overall: { samples, hits, hitRate: samples === 0 ? 0 : hits / samples },
    perClass,
    calibration,
  };
}

/**
 * The bucket a confidence falls in: `[0,0.2) … [0.8,1.0]`, with 1.0 in the top
 * bucket and anything outside `[0,1]` clamped rather than dropped.
 *
 * @param {number} confidence
 * @returns {number}
 */
function bucketIndex(confidence) {
  const clamped = Math.min(1, Math.max(0, confidence));
  // Compare against the edges rather than dividing: 0.6 / 0.2 is
  // 2.9999999999999996 in binary floating point, which would file a 0.60
  // prediction under the 0.4–0.6 bucket.
  let index = 0;
  for (let edge = 0; edge < BUCKET_EDGES.length - 1; edge += 1) {
    if (clamped >= BUCKET_EDGES[edge]) index = edge;
  }
  return index;
}

/** Percent formatting with one decimal, for the text table. */
function percent(/** @type {number} */ value) {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Renders the report as the table a person reads.
 * @param {Report} report
 * @returns {string}
 */
export function formatReport(report) {
  const lines = [];
  lines.push(`shadow-prediction report — ${report.eventsDir}`);
  lines.push(`files=${report.files.length} lines=${report.lines} bad_lines=${report.badLines} ignored=${report.ignoredLines}`);
  lines.push(`predictions=${report.predictions} outcomes=${report.outcomes} orphan_outcomes=${report.orphanOutcomes}`);
  lines.push(`overall samples=${report.overall.samples} hits=${report.overall.hits} hit_rate=${percent(report.overall.hitRate)}`);
  lines.push('');
  lines.push('class                 samples  hits  hit_rate  ladder');
  for (const row of report.perClass) {
    lines.push(
      `${row.klass.padEnd(20)} ${String(row.samples).padStart(7)} ${String(row.hits).padStart(5)}  ${percent(row.hitRate).padStart(8)}  ${row.level}`,
    );
  }
  lines.push('');
  lines.push('confidence bucket      samples  mean_conf  hit_rate');
  for (const row of report.calibration) {
    lines.push(
      `[${row.lower.toFixed(1)}, ${row.upper.toFixed(1)}${row.upper === 1 ? ']' : ')'}          ${String(row.samples).padStart(7)}  ${percent(row.meanConfidence).padStart(9)}  ${percent(row.hitRate).padStart(8)}`,
    );
  }
  return lines.join('\n');
}

/**
 * CLI entry. `--json` prints the report document; `--dir` names the stream.
 * @param {string[]} argv
 */
export function main(argv) {
  const json = argv.includes('--json');
  const dirIndex = argv.indexOf('--dir');
  const eventsDir = dirIndex >= 0 && argv[dirIndex + 1] !== undefined ? argv[dirIndex + 1] : defaultEventsDir();
  const read = readEventFiles(eventsDir);
  const report = buildReport(read.events, {
    eventsDir,
    files: read.files,
    lines: read.lines,
    badLines: read.badLines,
    ignoredLines: read.ignoredLines,
  });
  process.stdout.write(`${json ? JSON.stringify(report, null, 2) : formatReport(report)}\n`);
  return report;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main(process.argv.slice(2));
