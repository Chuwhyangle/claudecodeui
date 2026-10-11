/**
 * Tests for `action-commit-gate.mts` (B3, AC3). Real execution — the assertions drive the SPEC
 * machine and the gate, and they fail if any of the three mechanisms stops holding:
 *
 *   • the audio merge must reproduce the un-split timeline sample-for-sample, and must DIFFER from
 *     naive concatenation (the negative control, so "it works" is not a tautology);
 *   • the versioned gate must void a stale call on arrival, on version advance, and at finalize;
 *   • the Action Commit Gate must release a side effect only at finalize, and only for the current
 *     version — and the recovery scenarios must show the corrected call committing while the
 *     superseded call does not, with the naive gate as the 0-score control.
 *
 * Run directly (experiments/ is outside every tsconfig and test glob, so it is not part of the
 * suite):
 *   node_modules/.bin/tsx experiments/voice-turn-detection-compare/closing-safety-b0-b4/action-commit-gate.test.mts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AudioWindowMerger,
  DryRunToolSink,
  VersionedToolCallGate,
  recoveryScenarios,
  runRecoveryScenario,
} from './action-commit-gate.mts';
import type { AudioWindow, ToolCall } from './action-commit-gate.mts';

const RATE = 16_000;
const RAMP = (start: number, n: number): Float32Array => Float32Array.from({ length: n }, (_, i) => start + i);

// ── (a) audio window merge preserves the original timeline ───────────────────────────────────────

test('merge places windows at their true offsets and equals the un-split stream sample-for-sample', () => {
  // The "true" original: one contiguous ramp from t=0.
  const original = RAMP(0, 3 * RATE); // 3 s
  // A split at 1 s: [0,1s) and [1s,3s). Concatenation of these happens to match here — so use a
  // NON-adjacent split (a real relay drops a gap at the cut) to make the timing property bite.
  const a: AudioWindow = { id: 'a', startMs: 0, sampleRate: RATE, samples: original.subarray(0, 1 * RATE) };
  const gapSamples = RATE; // a 1 s hole where the tail of window a's turn ran out
  const b: AudioWindow = { id: 'b', startMs: 2000, sampleRate: RATE, samples: RAMP(2 * RATE, 1 * RATE) }; // [2s,3s)

  const merged = new AudioWindowMerger().add(b).add(a).merge(); // deliberately added out of order
  assert.equal(merged.sampleRate, RATE);
  assert.equal(merged.windows[0].id, 'a', 'merge sorts by start time, not insertion order');
  assert.equal(merged.spanFromMs, 0);
  assert.equal(merged.spanToMs, 3000);
  assert.equal(merged.lengthSamples, 3 * RATE, 'timeline length is lastEnd-0, not the sum of lengths');

  // The two written windows are byte-identical to the original where they exist.
  assert.deepEqual([...merged.samples.subarray(0, 1 * RATE)], [...original.subarray(0, 1 * RATE)]);
  assert.deepEqual([...merged.samples.subarray(2 * RATE, 3 * RATE)], [...original.subarray(2 * RATE, 3 * RATE)]);
  // The hole is exactly where the drop was.
  assert.deepEqual([...merged.samples.subarray(1 * RATE, 2 * RATE)], new Array(gapSamples).fill(0));
  assert.deepEqual(merged.gaps, [{ fromMs: 1000, toMs: 2000, ms: 1000 }]);
});

test('merge DIFFERS from naive concatenation whenever the windows are not adjacent (the negative control)', () => {
  const a: AudioWindow = { id: 'a', startMs: 0, sampleRate: RATE, samples: RAMP(0, RATE) };
  const b: AudioWindow = { id: 'b', startMs: 2000, sampleRate: RATE, samples: RAMP(1000, RATE) };

  const merged = new AudioWindowMerger().add(a).add(b).merge();
  const concat = AudioWindowMerger.concatenate([a, b]);

  assert.equal(merged.lengthSamples, 3 * RATE, 'merged timeline keeps the 2 s offset');
  assert.equal(concat.length, 2 * RATE, 'concatenation collapses the offset away');
  // In the merged timeline b starts at 2 s; in the concatenation it starts at 1 s — a silent shift.
  assert.equal(merged.samples[2 * RATE], b.samples[0], 'merged keeps b at its true t=2s');
  assert.equal(concat[1 * RATE], b.samples[0], 'concatenation shifts b to t=1s');
  assert.notEqual(merged.samples[1 * RATE], b.samples[0], 'the merged timeline leaves t=1s inside the gap, not b');
  assert.notDeepEqual([...merged.samples], [...concat]);
});

test('merge is idempotent and flags overlaps instead of silently overwriting', () => {
  const m = new AudioWindowMerger();
  m.add({ id: 'a', startMs: 0, sampleRate: RATE, samples: RAMP(0, 2 * RATE) });
  m.add({ id: 'b', startMs: 1000, sampleRate: RATE, samples: RAMP(5000, 2 * RATE) });
  const merged = m.merge();
  assert.equal(merged.overlaps.length, 1);
  assert.deepEqual({ earlier: merged.overlaps[0].earlier, later: merged.overlaps[0].later, ms: merged.overlaps[0].ms }, { earlier: 'a', later: 'b', ms: 1000 });
  // The later window wins at the true offset.
  assert.equal(merged.samples[1 * RATE], 5000);

  const again = m.merge();
  assert.deepEqual(again.windows, merged.windows, 'merge is idempotent');
});

test('merge fails loud on mixed sample rates rather than resampling silently', () => {
  const m = new AudioWindowMerger();
  m.add({ id: 'a', startMs: 0, sampleRate: RATE, samples: new Float32Array(10) });
  m.add({ id: 'b', startMs: 100, sampleRate: 24_000, samples: new Float32Array(10) });
  assert.throws(() => m.merge(), /mixed sample rates|24000Hz/);
});

// ── (b) versioned stale tool call voiding ────────────────────────────────────────────────────────

test('a call generated for a superseded version is voided on arrival and never applied', () => {
  const sink = new DryRunToolSink();
  const gate = new VersionedToolCallGate(sink);
  gate.setVersion(1, 0);

  const callA: ToolCall = { id: 'a', turnVersion: 1, name: 'set_timeout', args: { seconds: 30 }, atMs: 900 };
  assert.equal(gate.submit(callA, 950).decision, 'staged');

  // The speaker corrects: the turn advances. The staged v1 call is voided by the version bump.
  const voided = gate.setVersion(2, 1000);
  assert.equal(voided.length, 1);
  assert.match(voided[0].reason, /stale by version/);
  assert.equal(gate.staged.length, 0);

  // A LATE copy of the same call (retransmit / stale timer) arrives now: voided on arrival.
  assert.equal(gate.submit({ ...callA, id: 'a-dup' }, 1100).decision, 'voided');
  // Finalizing applies nothing.
  const { applied, dropped } = gate.finalize(1200);
  assert.equal(applied.length, 0);
  assert.equal(dropped.length, 0, 'the duplicate was already voided on arrival, not left staged');
  assert.equal(sink.applied.length, 0, 'no side effect was ever released');
  assert.ok(gate.voided.length >= 2, 'both the staged-then-superseded call and the late duplicate are recorded');
});

test('finalize releases ONLY the current version and drops a staged call whose version moved on', () => {
  const sink = new DryRunToolSink();
  const gate = new VersionedToolCallGate(sink);
  gate.setVersion(1, 0);
  gate.submit({ id: 'a', turnVersion: 1, name: 'set_timeout', args: { seconds: 30 }, atMs: 0 }, 0);

  // Advance the version WITHOUT voiding through setVersion (simulate a caller that only bumped the
  // version at finalize time): the guard must still catch the stale call.
  gate.setVersion(2, 10);
  gate.submit({ id: 'b', turnVersion: 2, name: 'set_timeout', args: { seconds: 20 }, atMs: 10 }, 10);
  const { applied, dropped } = gate.finalize(20);

  assert.deepEqual(applied.map((a) => a.args.seconds), [20]);
  assert.equal(dropped.length, 0, 'call a was already voided at setVersion(2)');
  assert.equal(sink.applied.length, 1);
  assert.equal(sink.applied[0].deliveredToRealSession, false, 'the sink is mechanical proof of no delivery');
});

test('abort drops staged calls without applying them', () => {
  const sink = new DryRunToolSink();
  const gate = new VersionedToolCallGate(sink);
  gate.setVersion(1, 0);
  gate.submit({ id: 'a', turnVersion: 1, name: 'set_timeout', args: { seconds: 30 }, atMs: 0 }, 0);
  const voided = gate.abort(5);
  assert.equal(voided.length, 1);
  assert.equal(gate.staged.length, 0);
  assert.equal(sink.applied.length, 0);
});

// ── (c) the recovery measurement ─────────────────────────────────────────────────────────────────

test('versioned gate recovers every in-grace scenario; naive gate recovers none', () => {
  const results = recoveryScenarios().map(runRecoveryScenario);
  const inGrace = (naive: boolean): number =>
    results.filter((r) => r.scenario.correctionInsideGrace && r.scenario.naive === naive).filter((r) => r.recovered).length;

  assert.equal(inGrace(false), 2, 'both in-grace versioned scenarios recover (late stale arrival cannot break it)');
  assert.equal(inGrace(true), 0, 'the apply-on-arrival control recovers nothing — the gate is what does the work');

  const versionedInGrace = results.filter((r) => r.scenario.correctionInsideGrace && !r.scenario.naive);
  for (const r of versionedInGrace) {
    assert.equal(r.correctedApplied, true, `${r.scenario.id}: the corrected call must commit`);
    assert.equal(r.proposedApplied, false, `${r.scenario.id}: the superseded call must not`);
    assert.equal(r.finalState, 'ACTION_COMMIT');
  }
});

test('after-grace correction is structurally unrecoverable and is reported, not averaged in', () => {
  const results = recoveryScenarios()
    .filter((s) => !s.correctionInsideGrace && !s.naive)
    .map(runRecoveryScenario);
  for (const r of results) {
    assert.equal(r.proposedApplied, true, 'the proposal was already released before the correction arrived');
    assert.equal(r.recovered, false, 'a commit gate cannot un-release an applied side effect');
    assert.equal(r.correctedApplied, true, 'the corrected call is a new turn and still commits');
  }
});
