// Unit tests for the replay pipeline. These inputs are hand-built unit fixtures exercising one rule
// each — they are NOT historical data; the 48h replay reads only real carriers (collect.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS, stage1, stage2, stage3, stage4, naiveNotifications, groundTruth, score, classifyExecutor } from './lib.mjs';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const at = (min) => new Date(T0 + min * 60_000).toISOString();
const hb = (min, attrs = {}) => ({ ts: at(min), project: 'p', source: 'worker-round', entity: 'driver:worker', kind: 'heartbeat', attrs: { needsHuman: [], halted: false, hasError: false, stopClass: 'pool-empty', ...attrs }, evidence: { line: min } });
const outcome = (min, task, finalState, fanIn = null) => ({ ts: at(min), project: 'p', source: 'worker-outcome', entity: `task:${task}`, kind: 'outcome', attrs: { finalState, fanIn }, evidence: { line: min } });
const status = (min, task, from, to, extra = {}) => ({ ts: at(min), project: 'p', source: 'git:tasks', entity: `task:${task}`, kind: 'status', attrs: { from, to, ...extra }, evidence: { sha: `s${min}` } });
const suite = (min, task, state) => ({ ts: at(min), project: 'p', source: 'verification-round', entity: `task:${task}`, kind: 'suite', attrs: { state, taskId: task }, evidence: { line: min } });
const ctx = (extra = {}) => ({ releaseTasks: new Set(), downstream: new Map(), statusAt: () => 'ready', ...extra });
const run = (events, nowMin, context = ctx()) => {
  const s1 = stage1(events);
  const s2 = stage2(s1.events, T0 + nowMin * 60_000);
  const s3 = stage3(s2.events);
  return { s1, s2, s3, graded: stage4(s3.events, T0 + nowMin * 60_000, context) };
};
const alerts = (graded) => graded.filter((e) => e.level === 'Notify' || e.level === 'Escalate');

test('stage1: identical heartbeats collapse; a one-round excursion is a flap, not a change', () => {
  const ev = [hb(0), hb(1), hb(2), hb(3, { stopClass: 'filtered-empty' }), hb(4), hb(5), hb(6)];
  const { stats, events } = stage1(ev);
  assert.equal(stats.flaps, 1);
  assert.equal(stats.heartbeatChanges, 0);
  assert.equal(events.filter((e) => e.kind === 'heartbeat-change').length, 0);
});

test('stage1: a settled halt (>=2 rounds and >=120s) passes as one change', () => {
  const ev = [hb(0), hb(1), hb(2, { halted: true }), hb(3, { halted: true }), hb(4, { halted: true })];
  const { stats } = stage1(ev);
  assert.equal(stats.heartbeatChanges, 1);
});

test('stage1: needs_human on a heartbeat becomes one signal per listed task; echoes die in stage3', () => {
  const ev = [hb(0, { needsHuman: ['a'] }), hb(1, { needsHuman: ['a'] }), hb(2)];
  const { graded } = run(ev, 10);
  assert.deepEqual(alerts(graded).map((a) => [a.entity, a.rule]), [['task:a', 'human-decision']]);
});

test('stage2: failures followed by a landing within 6h merge into one Record and no alert', () => {
  const ev = [outcome(0, 't', 'exited-not-landed', 'red'), outcome(30, 't', 'exited-not-landed', 'red'), outcome(60, 't', 'completed', 'landed')];
  const { s2, graded } = run(ev, 120);
  assert.equal(s2.stats.recovered, 1);
  assert.equal(s2.stats.mergedFailures, 2);
  assert.equal(alerts(graded).length, 0);
  assert.ok(graded.some((e) => e.level === 'Record' && e.rule === 'recovered'));
});

test('stage2: an unrecovered chain notifies at +6h; a third failure escalates', () => {
  const ev = [outcome(0, 't', 'failed'), outcome(10, 't', 'failed'), outcome(20, 't', 'killed')];
  const { graded } = run(ev, 8 * 60);
  const rules = alerts(graded).map((a) => [a.ts, a.level, a.rule]);
  assert.deepEqual(rules, [
    [at(20), 'Escalate', 'failure-streak'],
    [at(360), 'Notify', 'failure-unrecovered'],
  ]);
});

test('stage2: suite red then green is a single red-to-green Record', () => {
  const ev = [suite(0, 't', 'red'), suite(5, 't', 'red'), suite(9, 't', 'green')];
  const { graded } = run(ev, 60);
  assert.equal(alerts(graded).length, 0);
  const r2g = graded.filter((e) => e.rule === 'red-to-green');
  assert.equal(r2g.length, 1);
  assert.equal(r2g[0].attrs.reds, 2);
});

test('stage3: git echo of a heartbeat park is suppressed; exit from git closes it', () => {
  const ev = [hb(0, { needsHuman: ['a'] }), hb(1), status(2, 'a', 'ready', 'needs-human'), status(90, 'a', 'needs-human', 'todo')];
  const { graded } = run(ev, 100);
  assert.deepEqual(graded.filter((e) => e.entity === 'task:a' && e.level !== 'Ignore').map((e) => e.rule), ['human-decision', 'needs-human-exit']);
});

test('stage3: a heartbeat park arriving after the task is done is stale and dropped', () => {
  const ev = [status(0, 'a', 'ready', 'done'), hb(1, { needsHuman: ['a'] }), hb(2)];
  const { graded } = run(ev, 48 * 60);
  assert.equal(alerts(graded).length, 0);
});

test('stage3: landing done closes an open park implicitly (no false expiry)', () => {
  const ev = [hb(0, { needsHuman: ['a'] }), hb(1), status(30, 'a', 'ready', 'done')];
  const { graded } = run(ev, 48 * 60);
  assert.deepEqual(alerts(graded).map((a) => a.rule), ['human-decision']);
  assert.ok(graded.some((e) => e.kind === 'needs-human-exit' && e.attrs.implicit));
});

test('stage4: needs-human open past 24h escalates; a pre-window park merges into the backlog (rule ③)', () => {
  const pre = status(-3 * 24 * 60, 'old', null, 'needs-human', { seeded: true });
  const ev = [pre, status(60, 'a', 'ready', 'needs-human')];
  const { graded } = run(ev, 26 * 60, ctx({ windowStartMs: T0 }));
  const esc = alerts(graded).filter((a) => a.rule === 'needs-human-expired').map((a) => [a.entity, a.ts]);
  assert.deepEqual(esc, [['task:a', at(60 + 24 * 60)]]);
  assert.equal(graded.find((e) => e.entity === 'task:old' && e.kind === 'needs-human-enter').level, 'Record');
  const backlog = graded.find((e) => e.kind === 'needs-human-backlog');
  assert.deepEqual(
    [backlog.level, backlog.rule, backlog.attrs.count, backlog.attrs.tasks],
    ['Record', 'pre-window-backlog', 1, ['p|old']],
  );
});

test('classifyExecutor: the park commit subject carries the executor', () => {
  assert.equal(classifyExecutor('tasks: x ready→needs-human（归因不出机械停派）'), 'mechanical');
  assert.equal(classifyExecutor('tasks: x ready→needs-human（重试上限机械翻转）'), 'mechanical');
  assert.equal(classifyExecutor('tasks: x task_write by cli:123'), 'task_write');
  assert.equal(classifyExecutor(undefined), 'unknown');
});

test('stage4 (D2): a mechanically-stopped park is Record; an ABI task_write park stays Notify', () => {
  const mech = [status(0, 'm', 'todo', 'needs-human', { subject: 'tasks: m ready→needs-human（归因不出机械停派）' })];
  const gm = run(mech, 10).graded;
  assert.equal(alerts(gm).length, 0);
  assert.equal(gm.find((e) => e.kind === 'needs-human-enter').rule, 'mechanical-park');
  const written = [status(0, 'w', 'todo', 'needs-human', { subject: 'tasks: w task_write by cli:123' })];
  assert.deepEqual(alerts(run(written, 10).graded).map((a) => a.rule), ['human-decision']);
});

test('stage4: release-tagged park is graded as release dependency', () => {
  const ev = [status(0, 'rel', 'ready', 'needs-human')];
  const { graded } = run(ev, 10, ctx({ releaseTasks: new Set(['p|rel']) }));
  assert.equal(alerts(graded)[0].rule, 'release-dependency-parked');
});

test('stage4: upstream landing wakes an open downstream task in another project, once', () => {
  const ev = [outcome(0, 'up', 'completed', 'landed'), status(1, 'up', 'ready', 'done')];
  const context = ctx({ downstream: new Map([['p|up', [{ project: 'q', taskId: 'down' }]]]), statusAt: () => 'needs-human' });
  const { graded } = run(ev, 10, context);
  const wake = alerts(graded).filter((a) => a.rule === 'cross-project-upstream-landed');
  assert.equal(wake.length, 1);
  assert.equal(wake[0].project, 'q');
  assert.equal(wake[0].attrs.upstream, 'p/up');
});

test('stage4: no wake when the downstream task is already done', () => {
  const ev = [outcome(0, 'up', 'completed', 'landed')];
  const context = ctx({ downstream: new Map([['p|up', [{ project: 'q', taskId: 'down' }]]]), statusAt: () => 'done' });
  assert.equal(alerts(run(ev, 10, context).graded).length, 0);
});

test('scoring: under D1 a >=3-failure self-heal is a cost signal; with D1 off it is a false positive', () => {
  const ev = [outcome(0, 'heal', 'failed'), outcome(10, 'heal', 'failed'), outcome(20, 'heal', 'failed'), outcome(30, 'heal', 'completed', 'landed'), status(40, 'nh', 'ready', 'needs-human')];
  const now = T0 + 60 * 60_000;
  const labels = groundTruth(ev, now); // D1 on
  assert.equal(labels.get('p|heal').label, 'GT$');
  assert.equal(labels.get('p|nh').label, 'GT+');
  const { graded } = run(ev, 60, ctx({ costTasks: new Set(['p|heal']) }));
  assert.ok(alerts(graded).some((a) => a.rule === 'cost-signal'));
  const sc = score(alerts(graded), labels);
  assert.deepEqual(sc.cost, ['p|heal']); // surfaced on purpose, neither a hit nor a miss
  assert.deepEqual(sc.fp, []);
  assert.deepEqual(sc.tp, ['p|nh']);
  // The falsification the parent task's D1 asks for: turn D1 off and the same landing is a false positive again.
  const off = groundTruth(ev, now, { ...DEFAULTS, d1: false });
  assert.equal(off.get('p|heal').label, 'GT-');
  assert.deepEqual(score(alerts(run(ev, 60).graded), off).fp, ['p|heal']);
  assert.equal(naiveNotifications(ev).length, 4);
});

test('thresholds are the pre-registered ones', () => {
  assert.deepEqual(DEFAULTS, { debounceRounds: 2, debounceMs: 120000, dupWindowMs: 60000, recoverMs: 21600000, expireMs: 86400000, streakFailures: 3, haltEscalateMs: 1800000, d1: true, d2: true, backlogSummary: true });
});
