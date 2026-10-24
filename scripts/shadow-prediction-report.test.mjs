/**
 * AC4 — the shadow-prediction report is a faithful reading of the stream.
 *
 * A fixture stream with hand-computable predictions/outcomes drives the SAME
 * exported functions the CLI uses. The expected numbers are written out in the
 * test, not derived from the implementation:
 *
 *   · task-authoring: 2 outcomes, 1 hit  → 50.0%
 *   · progress-check: 2 outcomes, 2 hits → 100.0%
 *   · release:        1 outcome,  0 hits → 0.0%
 *   · overall:        5 outcomes, 3 hits → 60.0%
 *   · calibration [0.0,0.2): conf 0.10, hit 0/1;  [0.4,0.6): 0.40, 1/1;
 *     [0.6,0.8): 0.60, 0/1;  [0.8,1.0]: mean of 0.80 and 0.95 = 0.875, 2/2.
 *   · one malformed line is skipped AND counted; one outcome naming a prediction
 *     that is not in the stream is counted as orphaned, never as a hit.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildReport,
  defaultEventsDir,
  formatReport,
  readEventFiles,
} from './shadow-prediction-report.mjs';

/**
 * One `shadow.prediction` line.
 * @param {string} id
 * @param {string} klass
 * @param {number} confidence
 */
function prediction(id, klass, confidence) {
  return JSON.stringify({
    v: 0,
    id,
    at: '2026-10-24T12:00:00.000Z',
    source: 'cloudcli',
    kind: 'shadow.prediction',
    session: 's-1',
    data: { predictionId: id, class: klass, confidence, method: 'transition-v0', basis: { from: 'x', samples: 1, counts: {} } },
  });
}

/**
 * One `shadow.prediction.outcome` line.
 * @param {string} predictionId
 * @param {string} actualClass
 * @param {boolean} hit
 */
function outcome(predictionId, actualClass, hit) {
  return JSON.stringify({
    v: 0,
    id: `out-${predictionId}`,
    at: '2026-10-24T12:00:01.000Z',
    source: 'cloudcli',
    kind: 'shadow.prediction.outcome',
    session: 's-1',
    data: { predictionId, actualClass, hit },
  });
}

/** A non-shadow line, which the report must ignore without calling it damage. */
const UTTERANCE = JSON.stringify({ v: 0, id: 'u1', kind: 'utterance', data: { text: 'hi', class: 'discussion' } });

test('AC4: per-class hit rates and calibration buckets match the hand calculation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'shadow-report-'));
  try {
    const lines = [
      prediction('p1', 'task-authoring', 0.8),
      outcome('p1', 'task-authoring', true),
      prediction('p2', 'task-authoring', 0.6),
      outcome('p2', 'diagnosis', false),
      prediction('p3', 'progress-check', 0.4),
      outcome('p3', 'progress-check', true),
      prediction('p4', 'progress-check', 0.95),
      outcome('p4', 'progress-check', true),
      prediction('p5', 'release', 0.1),
      outcome('p5', 'release', false),
      outcome('missing-prediction', 'release', true),
      UTTERANCE,
      '{ this is not json',
    ];
    await writeFile(path.join(dir, '2026-10-24.jsonl'), `${lines.join('\n')}\n`, 'utf8');

    const read = readEventFiles(dir);
    assert.equal(read.badLines, 1, 'the malformed line is skipped and counted');
    assert.equal(read.ignoredLines, 1, 'the utterance is ignored, not damage');

    const report = buildReport(read.events, { eventsDir: dir, ...read });

    assert.equal(report.orphanOutcomes, 1);
    assert.equal(report.outcomes, 6, 'all six outcome lines were read');

    const byClass = new Map(report.perClass.map((row) => [row.klass, row]));
    assert.deepEqual(
      [...byClass.entries()].map(([klass, row]) => [klass, row.samples, row.hits, row.hitRate]),
      [
        // Equal samples break ties by class name, so `progress-check` sorts first.
        ['progress-check', 2, 2, 1],
        ['task-authoring', 2, 1, 0.5],
        ['release', 1, 0, 0],
      ],
    );
    assert.equal(byClass.get('progress-check')?.level, 'system-suggests');
    assert.equal(byClass.get('task-authoring')?.level, 'you-do');

    assert.deepEqual(report.overall, { samples: 5, hits: 3, hitRate: 0.6 });

    const buckets = report.calibration;
    assert.equal(buckets.length, 5);
    assert.deepEqual(
      buckets.map((bucket) => [bucket.lower, bucket.samples, bucket.hits, bucket.hitRate]),
      [
        [0, 1, 0, 0],
        [0.2, 0, 0, 0],
        [0.4, 1, 1, 1],
        [0.6, 1, 0, 0],
        [0.8, 2, 2, 1],
      ],
    );
    assert.equal(buckets[4].meanConfidence, 0.875);

    const text = formatReport(report);
    assert.match(text, /bad_lines=1/);
    assert.match(text, /orphan_outcomes=1/);
    console.log(text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AC4: an absent stream directory is an empty reading, not an error', () => {
  const report = buildReport([], { eventsDir: path.join(os.tmpdir(), 'shadow-report-does-not-exist') });
  assert.deepEqual(report.overall, { samples: 0, hits: 0, hitRate: 0 });
  assert.equal(report.badLines, 0);
});

test('AC4: the default directory sits beside the events the writer produces', () => {
  assert.equal(defaultEventsDir('/home/example'), path.join('/home/example', '.quay-fleet', 'context', 'events'));
});
