/**
 * The live reading, judged against HAND-COMPUTED arithmetic.
 *
 * The module has no clock, no DOM and no network, so its whole product is arithmetic on the metrics
 * the path hands it. That makes the measurement exact: every expected number below is written out
 * longhand from the same constructed metrics, not read back off the implementation, so a change to
 * the formula (a ratio inverted, a factor dropped, the baseline's request count "fixed") moves the
 * reading and these cases go red rather than agreeing with the new one.
 *
 * The last block is the falsification half: the two mistakes this reading exists to catch — the
 * saved-ratio measured the wrong way round, and a baseline that quietly claims more than one
 * request — are computed here and asserted NOT to satisfy the criterion they would have to.
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { AUDIO_TOKENS_PER_SEC, buildVoiceLiveReading } from '@/modules/chat/utils/voice/voiceLiveReading';
import type { VoiceLiveMetrics } from '@/modules/chat/utils/voice/voiceLiveReading';

/** Recorded 200 s, cut into three: 10 s + 20 s + 30 s on the wire, one of them forced. */
const METRICS: VoiceLiveMetrics = {
  recordedSec: 200,
  segments: [
    { sentSec: 10, requests: 1, latencyMs: 400, waitSec: 32, forced: false },
    { sentSec: 20, requests: 2, latencyMs: 750, waitSec: 5, forced: true },
    { sentSec: 30, requests: 1, latencyMs: 900, waitSec: 8, forced: false },
  ],
  firstTextLatencyMs: 1_200,
  usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
};

test('every field is the hand-computed value for the constructed metrics', () => {
  const reading = buildVoiceLiveReading(METRICS);

  // sentSec = 10 + 20 + 30; requests = 1 + 2 + 1; one forced; longest 30; longest wait 32.
  assert.equal(reading.sentSec, 60);
  assert.equal(reading.requests, 4);
  assert.equal(reading.segments, 3);
  assert.equal(reading.forcedCuts, 1);
  assert.equal(reading.longestSegmentSec, 30);
  assert.equal(reading.longestWaitSec, 32);
  assert.deepEqual(reading.latencyMs, [400, 750, 900]);

  // savedRatio = 1 - 60/200 = 0.7.
  assert.ok(Math.abs(reading.savedRatio - 0.7) < 1e-12, `savedRatio=${reading.savedRatio}`);

  // estAudioTokens = sentSec × 7 = 420.
  assert.equal(reading.estAudioTokens, 60 * AUDIO_TOKENS_PER_SEC);
  assert.equal(reading.estAudioTokens, 420);

  // The counterfactual: the whole 200 s recording, one request, 200 × 7 tokens.
  assert.deepEqual(reading.baseline, { sec: 200, requests: 1, estAudioTokens: 1_400 });

  assert.equal(reading.recordedSec, 200);
  assert.equal(reading.firstTextLatencyMs, 1_200);
  assert.deepEqual(reading.usage, { promptTokens: 100, completionTokens: 10, totalTokens: 110 });
});

test('the reading carries the counterfactual for a recording the VAD left alone', () => {
  // No cut at all: one segment the length of the recording. savedRatio is 0 (nothing saved), not 1.
  const reading = buildVoiceLiveReading({
    recordedSec: 25,
    segments: [{ sentSec: 25, requests: 1, latencyMs: 300, waitSec: 0, forced: false }],
    firstTextLatencyMs: 320,
  });

  assert.equal(reading.savedRatio, 0);
  assert.equal(reading.segments, 1);
  assert.equal(reading.requests, 1);
  assert.equal(reading.forcedCuts, 0);
  assert.equal(reading.estAudioTokens, reading.baseline.estAudioTokens);
  assert.equal(reading.usage, null);
});

test('an input with no segments reads as a zeroed reading, not a division by zero', () => {
  const reading = buildVoiceLiveReading({ recordedSec: 0, segments: [], firstTextLatencyMs: null });

  assert.equal(reading.sentSec, 0);
  assert.equal(reading.savedRatio, 0);
  assert.equal(reading.segments, 0);
  assert.equal(reading.requests, 0);
  assert.equal(reading.forcedCuts, 0);
  assert.equal(reading.longestSegmentSec, 0);
  assert.equal(reading.longestWaitSec, 0);
  assert.equal(reading.estAudioTokens, 0);
  assert.deepEqual(reading.latencyMs, []);
  assert.equal(reading.baseline.requests, 1);
});

/**
 * The falsification half: the mistakes this reading has to be able to catch.
 *
 * `savedRatio` is a fraction SAVED; `sentSec / recordedSec` is the fraction SENT, and the two are
 * complementary. A reader who swapped them would still get a plausible-looking number for an input
 * the VAD barely touched, so the inverted formula is computed here and asserted to fall outside the
 * `>= 0.5` the criterion requires — on these metrics 0.3, against the real 0.7.
 *
 * The baseline is the other half of the A/B and the one thing that must NOT move with the VAD: a
 * path with no VAD sends exactly one request. A baseline whose request count tracked the real
 * segment count would make the counterfactual describe the very thing it is the opposite of.
 */
test('the inverted ratio and a counted baseline both fail the reading they claim to satisfy', () => {
  const reading = buildVoiceLiveReading(METRICS);

  const inverted = reading.sentSec / reading.recordedSec;
  assert.ok(Math.abs(inverted - 0.3) < 1e-12, `inverted=${inverted}`);
  assert.ok(!(inverted >= 0.5), 'the inverted ratio passed the >= 0.5 the reading must clear');
  assert.ok(reading.savedRatio >= 0.5, 'the real ratio failed the >= 0.5 it must clear');

  const countedBaseline = { ...reading.baseline, requests: reading.segments };
  assert.notEqual(countedBaseline.requests, 1);
  assert.equal(reading.baseline.requests, 1);
});
