/**
 * Counterexample tests for `turn-state-machine.mts` (SPEC P0.5, AC6).
 *
 * The scenario is the SPEC's own: 「改成三十秒……不对，二十秒」 — the speaker proposes "change it to thirty
 * seconds", pauses long enough that a detector calls END, then resumes inside the commit-grace window
 * to correct it to "twenty seconds". A naive implementation commits the FIRST instruction. These
 * tests fail unless the machine (a) advances `turnVersion` on the correction, (b) VOIDS the stale
 * answer rather than acting on it, and (c) commits the corrected payload, not the superseded one.
 *
 * Run directly (experiments/ is outside every tsconfig and test glob, so it is not part of the
 * suite):
 *   node_modules/.bin/tsx experiments/voice-turn-detection-compare/state-machine/turn-state-machine.test.mts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { TurnStateMachine } from './turn-state-machine.mts';

test('self-correction: the stale version is voided and the corrected payload is the one committed', () => {
  const sm = new TurnStateMachine({ graceMs: 900 });

  // The speaker opens with a proposal.
  sm.onSpeechStart(0);
  sm.onSpeech(0, '改成三十秒');
  assert.equal(sm.state, 'IDLE', 'speech alone does not enter TURN_PENDING — only a candidate silence onset does');

  // A VAD candidate silence onset → the detector is asked, for version 1.
  const req1 = sm.onCandidatePoint(900);
  assert.equal(sm.state, 'TURN_PENDING');
  assert.equal(sm.turnVersion, 1);
  assert.equal(req1.turnVersion, 1);

  // The detector calls END. This does NOT commit — it opens the grace window.
  sm.onDetectorResult(req1, 'END', 950);
  assert.equal(sm.state, 'COMMIT_GRACE');
  assert.equal(sm.committed.length, 0, 'END must not commit immediately; the grace window is the whole point');

  // Speculative inference may be warmed inside the window (and only then).
  assert.equal(sm.startSpeculative('propose: 改成三十秒'), true);
  assert.deepEqual(sm.speculativeInference, { turnVersion: 1, label: 'propose: 改成三十秒' });

  // The speaker resumes INSIDE the window — the correction. This is the SPEC's version+1 edge.
  sm.onSpeechStart(1000);
  sm.onSpeech(1000, '不对，二十秒');

  assert.equal(sm.state, 'TURN_PENDING');
  assert.equal(sm.turnVersion, 2, 'the correction advances turnVersion');
  assert.equal(sm.speculativeInference, null, 'speculative work for the dead version must be cancelled, not sent');
  assert.deepEqual([...sm.supersededTexts], ['改成三十秒'], 'the pre-correction proposal is retracted, not committed');
  assert.equal(sm.pendingText, '不对，二十秒', 'the pending payload is the corrected text');
  assert.equal(sm.committed.length, 0, 'version 1 must never reach ACTION_COMMIT');

  // The corrected utterance is itself followed by a pause the detector calls END.
  const req2 = sm.onCandidatePoint(2000);
  assert.equal(sm.turnVersion, 3, 'a new candidate point advances turnVersion again (monotonic)');

  // The answer for the FIRST candidate arrives late, after the turn has moved on. It is voided.
  sm.onDetectorResult(req1, 'END', 2100);
  assert.equal(sm.state, 'TURN_PENDING', 'a stale END must not open a grace window');
  assert.equal(sm.committed.length, 0, 'a stale END must not commit');
  assert.equal(sm.voided.length, 1, 'the stale answer is recorded as voided');
  assert.equal(sm.voided[0].requestId, req1.id);
  assert.equal(sm.voided[0].issuedVersion, 1);
  assert.equal(sm.voided[0].currentVersion, 3);

  // The live answer is accepted; the window expires without further speech → commit.
  sm.onDetectorResult(req2, 'END', 2200);
  assert.equal(sm.state, 'COMMIT_GRACE');
  sm.onTick(3099);
  assert.equal(sm.committed.length, 0, 'the window has not expired yet');
  sm.onTick(3100);
  assert.equal(sm.committed.length, 1, 'exactly one action is committed');

  const commit = sm.committed[0];
  assert.equal(commit.turnVersion, 3, 'the commit carries the surviving version');
  assert.equal(commit.text, '不对，二十秒', 'the committed content is the CORRECTED version, not the first one spoken');
  assert.equal(commit.atMs, 3100);
});

test('within-turn CONTINUE keeps the turn open and commits nothing', () => {
  const sm = new TurnStateMachine();
  sm.onSpeechStart(0);
  sm.onSpeech(0, '把超时改成');
  const req = sm.onCandidatePoint(500);
  sm.onDetectorResult(req, 'CONTINUE', 520);
  assert.equal(sm.state, 'IDLE', 'CONTINUE returns to IDLE, still listening');
  assert.equal(sm.committed.length, 0);
  assert.equal(sm.voided.length, 0);
  assert.equal(sm.pendingText, '把超时改成', 'the payload survives a within-turn pause');
});

test('a grace-abort whose answer then arrives for the OLD version is voided, never applied', () => {
  const sm = new TurnStateMachine({ graceMs: 300 });
  sm.onSpeechStart(0);
  sm.onSpeech(0, '三十秒');
  const req1 = sm.onCandidatePoint(100);
  sm.onDetectorResult(req1, 'END', 110);
  assert.equal(sm.state, 'COMMIT_GRACE');
  // Speaker resumes inside the window before the (already-answered) version is acted on.
  sm.onSpeechStart(120);
  sm.onSpeech(120, '二十秒');
  assert.equal(sm.turnVersion, 2);
  // A duplicate late answer for req1 must not resurrect the old grace window.
  sm.onDetectorResult(req1, 'END', 130);
  assert.equal(sm.state, 'TURN_PENDING');
  assert.equal(sm.voided.length, 1);
  sm.onTick(1000);
  assert.equal(sm.committed.length, 0, 'no version was ever accepted, so nothing commits');
});

test('after ACTION_COMMIT, resumed speech opens a new round without touching the committed action', () => {
  const sm = new TurnStateMachine({ graceMs: 100 });
  sm.onSpeechStart(0);
  sm.onSpeech(0, 'first turn');
  const req = sm.onCandidatePoint(50);
  sm.onDetectorResult(req, 'END', 60);
  sm.onTick(160);
  assert.equal(sm.committed.length, 1);
  assert.equal(sm.state, 'ACTION_COMMIT');

  const versionAtCommit = sm.committed[0].turnVersion;
  sm.onSpeechStart(200);
  assert.equal(sm.state, 'IDLE');
  assert.equal(sm.turnVersion, versionAtCommit + 1);
  assert.equal(sm.committed.length, 1, 'the committed action is immutable');
  assert.equal(sm.committed[0].text, 'first turn');
});
