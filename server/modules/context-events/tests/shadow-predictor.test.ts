/**
 * AC3 — the shadow predictor predicts, scores, and stays invisible.
 *
 *   (a) given a transition table, it predicts the highest-count class with the
 *       winner's share as confidence;
 *   (b) the next utterance produces EXACTLY ONE outcome for the prior
 *       prediction, and `hit` is decided correctly on both branches;
 *   (c) two sessions with different histories never steer each other;
 *   (d) it is invisible to the UI layer: the module imports no socket/websocket
 *       module, and a composed stream's ONLY sink is the context writer.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createContextEvents,
  createShadowPredictor,
  type ContextEventWriter,
} from '@/modules/context-events/index.js';

const MODULE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A predictor with deterministic prediction ids. */
function predictorWithIds(): { predictor: ReturnType<typeof createShadowPredictor>; ids: string[] } {
  const ids: string[] = [];
  const predictor = createShadowPredictor({
    newId: () => {
      const id = `pred-${ids.length + 1}`;
      ids.push(id);
      return id;
    },
  });
  return { predictor, ids };
}

test('AC3 (a): the argmax class is predicted with its observed share as confidence', () => {
  const { predictor } = predictorWithIds();
  predictor.seedTransitions('s-1', {
    'progress-check': { 'task-authoring': 3, approval: 1 },
  });

  const flow = predictor.flow('s-1', 'progress-check');
  assert.equal(flow.outcome, null, 'nothing to score before a prediction exists');
  assert.ok(flow.prediction);
  assert.equal(flow.prediction.class, 'task-authoring');
  assert.equal(flow.prediction.confidence, 0.75);
  assert.equal(flow.prediction.method, 'transition-v0');
  assert.deepEqual(flow.prediction.basis, {
    from: 'progress-check',
    samples: 4,
    counts: { 'task-authoring': 3, approval: 1 },
  });
  console.log(`AC3(a) predicted=${flow.prediction.class} confidence=${flow.prediction.confidence}`);
});

test('AC3 (b): the next utterance yields exactly one outcome, with the hit decided both ways', () => {
  const { predictor } = predictorWithIds();
  predictor.seedTransitions('s-1', { 'progress-check': { 'task-authoring': 2 } });

  const first = predictor.flow('s-1', 'progress-check');
  assert.ok(first.prediction);
  assert.equal(first.outcome, null);

  const second = predictor.flow('s-1', 'task-authoring');
  assert.ok(second.outcome);
  assert.equal(second.outcome.predictionId, first.prediction.id);
  assert.equal(second.outcome.actualClass, 'task-authoring');
  assert.equal(second.outcome.hit, true);

  // And the miss branch: the new prediction (from task-authoring, now that the
  // first transition exists? no — the table seeded only progress-check) is null,
  // so seed one and drive a deliberate miss.
  predictor.seedTransitions('s-1', { 'task-authoring': { release: 2 } });
  const third = predictor.flow('s-1', 'task-authoring');
  assert.ok(third.prediction);
  assert.equal(third.prediction.class, 'release');
  const fourth = predictor.flow('s-1', 'diagnosis');
  assert.ok(fourth.outcome);
  assert.equal(fourth.outcome.predictionId, third.prediction.id);
  assert.equal(fourth.outcome.hit, false);

  console.log(`AC3(b) hit=${second.outcome.hit} miss=${fourth.outcome.hit}`);
});

test('AC3 (b): no utterance produces more than one outcome, and none without a prediction', () => {
  const { predictor } = predictorWithIds();
  predictor.seedTransitions('s-1', { discussion: { discussion: 1 } });

  const outcomes = [];
  for (const observed of ['discussion', 'discussion', 'discussion'] as const) {
    outcomes.push(predictor.flow('s-1', observed).outcome);
  }
  assert.equal(outcomes[0], null, 'the first observation has no prior prediction');
  assert.ok(outcomes[1] !== null);
  assert.ok(outcomes[2] !== null);
  // Exactly one outcome object per scored utterance — never a batch.
  assert.equal(outcomes.filter((outcome) => outcome !== null).length, 2);
  console.log(`AC3(b2) outcomes=${outcomes.filter((outcome) => outcome !== null).length}`);
});

test('AC3 (c): two sessions with different histories never cross-talk', () => {
  const { predictor } = predictorWithIds();
  predictor.seedTransitions('s-a', { 'progress-check': { 'task-authoring': 5 } });
  predictor.seedTransitions('s-b', { 'progress-check': { release: 5 } });

  const a = predictor.flow('s-a', 'progress-check');
  const b = predictor.flow('s-b', 'progress-check');
  assert.equal(a.prediction?.class, 'task-authoring');
  assert.equal(b.prediction?.class, 'release');

  // The outcome of s-a's prediction can only be produced by an s-a utterance.
  const unrelated = predictor.flow('s-b', 'task-authoring');
  assert.equal(unrelated.outcome?.predictionId, b.prediction?.id, 's-b scored s-b, not s-a');
  assert.equal(unrelated.outcome?.hit, false);
  assert.equal(predictor.pendingFor('s-a')?.id, a.prediction?.id);

  predictor.forget('s-a');
  assert.equal(predictor.pendingFor('s-a'), null);
  console.log(`AC3(c) a=${a.prediction?.class} b=${b.prediction?.class} isolated=true`);
});

test('AC3 (d): the predictor imports no socket layer, and a composed stream writes only to the context writer', async () => {
  // Source reading (import lines only, so the module's own prose does not count).
  for (const file of ['shadow-predictor.ts', 'context-events.module.ts', 'context-event-writer.ts']) {
    const source = readFileSync(path.join(MODULE_DIR, file), 'utf8');
    const imports = source
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line) || /^\s*export\b.*\bfrom\b/.test(line))
      .join('\n');
    assert.doesNotMatch(imports, /modules\/websocket|\bfrom ['"]ws['"]|RealtimeClientConnection/, `${file} must not import a socket layer`);
  }

  // Runtime reading: the composed stream's only sink is the writer it was given.
  const written: Array<{ kind: string; session?: string; data: Record<string, unknown> }> = [];
  const writer: ContextEventWriter = {
    eventsDir: '/tmp/never',
    schemaPath: '/tmp/never/schema.json',
    async append(draft) {
      written.push({
        kind: draft.kind,
        ...(draft.session === undefined || draft.session === null ? {} : { session: draft.session }),
        data: draft.data ?? {},
      });
      return { ok: true, id: `e-${written.length}`, path: '/tmp/never/events.jsonl' };
    },
    status: () => ({ state: 'ok', reason: null, schemaPath: '/tmp/never/schema.json', eventsDir: '/tmp/never', writes: written.length, rejected: 0 }),
  };
  const { predictor } = predictorWithIds();
  const stream = createContextEvents({ writer, predictor, now: () => Date.parse('2026-10-24T12:00:00.000Z') });

  // Three utterances are the shortest sequence that produces the whole pair
  // grammar: the first has no history, the second produces a prediction, the
  // third produces that prediction's outcome (and the next prediction).
  await stream.record({ kind: 'utterance', session: 's-1', data: { text: '检查进展。' } });
  await stream.record({ kind: 'utterance', session: 's-1', data: { text: '检查进展。' } });
  await stream.record({ kind: 'utterance', session: 's-1', data: { text: '检查进展。' } });

  const kinds = written.map((draft) => draft.kind);
  assert.deepEqual(kinds.slice(0, 1), ['utterance']);
  assert.ok(kinds.includes('shadow.prediction.outcome'));
  assert.ok(kinds.includes('shadow.prediction'));
  assert.ok(
    kinds.every((kind) => kind === 'utterance' || kind === 'shadow.prediction' || kind === 'shadow.prediction.outcome'),
    `the stream wrote an unexpected channel: ${kinds.join(',')}`,
  );
  console.log(`AC3(d) writer_kinds=${JSON.stringify(kinds)} socket_imports=0`);
});
