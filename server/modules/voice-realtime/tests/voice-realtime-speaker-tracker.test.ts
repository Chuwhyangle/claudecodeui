/**
 * THE SPEAKER TRACKER'S CRITERION (Phase 1, shadow).
 *
 * WHAT THIS FILE PINS, and why each half is where it is:
 *
 *  - AC1–AC4 are the PURE logic: the session attractor's normalization / cosine / angle ceiling / EMA
 *    direction / refusals; the long-term bank's match / new / promote / merge / evict / cap / core
 *    protection; the selector's quality gate, 3–3.5 s sample and dual-key decision; and the environment
 *    arm point's four resolution states. Every one is arithmetic over plain arrays, so it is driven
 *    directly rather than through a socket.
 *  - The SEAM legs (AC6/AC7) drive the real proxy over a fake browser socket and fake upstream, because
 *    the property that matters is structural: with NO seam the relay is the relay it was, and with one
 *    the observer sees completed 2 s windows while every frame still crosses unchanged and nothing new
 *    is sent to the browser.
 *  - The MODEL leg (AC5's leaf) drives the loader with an injected dependency, so a load failure is a
 *    line and a null embedder — never a throw — without touching the native addon.
 *
 * The vectors are 2-D: the logic is dimension-agnostic, and a 2-D basis makes an angle readable in the
 * assertion rather than buried in 192 numbers. The proxy legs use 640-byte PCM16 frames (20 ms at
 * 16 kHz), exactly the browser's cadence.
 *
 * DoD drives this file alone with `npx tsx ... --test <this file>`; the suite's collection pin in
 * `server/shared/tests/quay-test-script.test.ts` counts it (AC8).
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket as WS } from 'ws';

import {
  clampSpeakerStep,
  createSessionAttractor,
  normalizeSpeakerVector,
  rejectSpeakerEmbedding,
  speakerAngleDegrees,
  speakerCosine,
} from '../voice-speaker-attractor.js';
import {
  addSpeakerCandidate,
  createSpeakerBank,
  evictSpeakerClusters,
  matchSpeakerCluster,
  mergeSpeakerClusters,
  observeSpeakerBank,
  promoteSpeakerCandidate,
} from '../voice-speaker-bank.js';
import {
  decideSpeakerTracking,
  selectSpeakerSample,
  speakerWindowPassesQuality,
  type SpeakerWindowReading,
} from '../voice-speaker-selector.js';
import {
  SPEAKER_TRACKING_THRESHOLDS,
  describeSpeakerTracking,
  resolveSpeakerTracking,
} from '../voice-speaker-tracking-arm.js';
import {
  createSpeakerTrackerModel,
  createSpeakerTrackerSeam,
  createSpeakerWindowAccumulator,
  describeSpeakerShadowObservation,
  describeSpeakerShadowSummary,
  type SpeakerShadowObservation,
  type SpeakerWindow,
  type VoiceSpeakerTrackerSeam,
} from '../voice-realtime-speaker-seam.js';
import {
  handleVoiceRealtimeConnection,
  type VoiceRealtimeInboundFrame,
  type VoiceRealtimeOutboundFrame,
  type VoiceRealtimeProxySeams,
} from '../voice-realtime-ws-proxy.service.js';

import { createFakeTransport, waitFor, type FakeTransport } from './realtime-bridge-harness.js';

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

/** A unit vector at `degrees` from the x-axis. */
function unit(degrees: number): Float32Array {
  const radians = (degrees * Math.PI) / 180;
  return Float32Array.from([Math.cos(radians), Math.sin(radians)]);
}

/** Float equality at the calibration's own resolution. */
function near(actual: number, expected: number, tolerance = 1e-6): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${expected} ± ${tolerance}, got ${actual}`,
  );
}

/** One 20 ms PCM16 frame at 16 kHz with a unique first sample, base64 as the wire carries it. */
function pcmFrame(marker: number): string {
  const samples = 320;
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    pcm.writeInt16LE(index === 0 ? marker : index % 2 === 0 ? 1200 : -1200, index * 2);
  }
  return pcm.toString('base64');
}

/** A completed 2 s window whose first sample is a marker the scripted embedder keys on. */
function windowWithMarker(marker: number, startMs: number): SpeakerWindow {
  const samples = new Int16Array(32000);
  samples[0] = marker;
  return { samples, startMs, durationMs: 2000, speechRatio: 0.9 };
}

function windowReading(
  startMs: number,
  scoreCore: number,
  scoreSession: number,
  speechRatio = 0.9,
): SpeakerWindowReading {
  return { startMs, durationMs: 2000, speechRatio, scoreCore, scoreSession };
}

// ── AC1: the session attractor ───────────────────────────────────────────────────────────────────

test('AC1: normalization, cosine and the refusal cases are exact', () => {
  const threeFour = normalizeSpeakerVector([3, 4]);
  assert.ok(threeFour !== null);
  near(threeFour[0], 0.6);
  near(threeFour[1], 0.8);

  assert.equal(normalizeSpeakerVector([]), null, 'an empty embedding has no direction');
  assert.equal(normalizeSpeakerVector([1]), null, 'a one-dimensional vector is not an embedding');
  assert.equal(normalizeSpeakerVector([0, 0]), null, 'a zero vector has no direction to normalize into');
  assert.equal(normalizeSpeakerVector([Number.NaN, 1]), null, 'a non-finite embedding is refused');
  assert.equal(normalizeSpeakerVector([Number.POSITIVE_INFINITY, 1]), null);

  assert.equal(rejectSpeakerEmbedding([]), 'empty-embedding');
  assert.equal(rejectSpeakerEmbedding([1]), 'short-embedding');
  assert.equal(rejectSpeakerEmbedding([Number.NaN, 1]), 'non-finite-embedding');
  assert.equal(rejectSpeakerEmbedding([0, 0]), 'zero-embedding');
  assert.equal(rejectSpeakerEmbedding([1, 0]), null);

  near(speakerCosine([1, 0], [1, 0]), 1);
  near(speakerCosine([1, 0], [0, 1]), 0);
  near(speakerCosine([1, 0], [-1, 0]), -1);
  near(speakerCosine([3, 4], [6, 8]), 1, 1e-9);
  assert.equal(speakerCosine([1, 0], [1, 0, 0]), 0, 'mismatched dimensions have no opinion');
  assert.equal(speakerCosine([], [1, 0]), 0);
});

test('AC1: a single turn may rotate the attractor by at most maxStepDegrees', () => {
  const attractor = createSessionAttractor({ emaAlpha: 1, maxStepDegrees: 15, trackThreshold: 0.3 });
  attractor.observe([1, 0]);
  const reading = attractor.observe(unit(60));
  assert.equal(reading.accepted, true, 'cos 60° = 0.5 clears TRACK, so the turn is accepted');
  near(speakerAngleDegrees(attractor.first ?? [1, 0], attractor.centroid ?? [1, 0]), 15, 1e-4);
  near(attractor.driftDegrees, 15, 1e-4);
});

test('AC1: clampSpeakerStep leaves a small step untouched and caps a large one', () => {
  const small = clampSpeakerStep([1, 0], unit(5), 15);
  assert.ok(small !== null);
  near(speakerAngleDegrees([1, 0], small), 5, 1e-4);

  const large = clampSpeakerStep([1, 0], unit(90), 15);
  assert.ok(large !== null);
  near(speakerAngleDegrees([1, 0], large), 15, 1e-4);
});

test('AC1: the EMA update moves TOWARD the accepted turn by the alpha share', () => {
  const attractor = createSessionAttractor({ emaAlpha: 0.5, maxStepDegrees: 15, trackThreshold: 0.3 });
  attractor.observe([1, 0]);
  attractor.observe(unit(10));
  // Equal-weight blend of two unit vectors bisects them: 5°, well inside the ceiling.
  near(speakerAngleDegrees(attractor.first ?? [1, 0], attractor.centroid ?? [1, 0]), 5, 1e-4);
  near(attractor.driftDegrees, 5, 1e-4);
});

test('AC1: empty/short turns are refused without moving the attractor or the counts', () => {
  const attractor = createSessionAttractor();
  const empty = attractor.observe([]);
  assert.equal(empty.accepted, false);
  assert.equal(empty.rejection, 'empty-embedding');
  const short = attractor.observe([0.5]);
  assert.equal(short.rejection, 'short-embedding');
  assert.equal(attractor.turns, 0);
  assert.equal(attractor.acceptedCount, 0);
  assert.equal(attractor.centroid, null);
});

test('AC1: the reading carries first/core scores, acceptance and provisional state', () => {
  const attractor = createSessionAttractor({ core: [1, 0], matchFastThreshold: 0.35 });
  const first = attractor.observe([0.9, 0.1]);
  assert.equal(first.turns, 1);
  near(first.score, 1);
  near(first.firstScore, 1);
  assert.ok(first.coreScore !== null);
  near(first.coreScore, speakerCosine([0.9, 0.1], [1, 0]));
  assert.equal(first.acceptedByCore, true);
  assert.equal(first.provisional, false, 'a core-confirmed turn leaves the provisional state');

  const noCore = createSessionAttractor().observe([1, 0]);
  assert.equal(noCore.coreScore, null, 'a connection with no core reports no core score');
  assert.equal(noCore.provisional, true);
});

test('AC1: a below-TRACK turn is observed but never learned', () => {
  const attractor = createSessionAttractor({ emaAlpha: 1, maxStepDegrees: 15, trackThreshold: 0.3 });
  attractor.observe([1, 0]);
  const bystander = attractor.observe([0, 1]); // cos = 0, below TRACK
  assert.equal(bystander.accepted, false);
  near(speakerAngleDegrees(attractor.centroid ?? [1, 0], [1, 0]), 0, 1e-9);
  assert.equal(attractor.driftDegrees, 0);
});

// ── AC2: the long-term bank ──────────────────────────────────────────────────────────────────────

test('AC2: a core is matched, an orthogonal embedding becomes a candidate', () => {
  const bank = createSpeakerBank({ cores: [[1, 0]], k: 4 });
  const core = matchSpeakerCluster(bank, [1, 0]);
  assert.ok(core !== null);
  assert.equal(core.cluster.kind, 'core');
  near(core.score, 1);

  const observed = observeSpeakerBank(bank, [0, 1], 'session-a');
  assert.equal(observed.action, 'new-candidate');
  assert.equal(observed.cluster?.kind, 'candidate');
  assert.equal(observed.cluster?.sessions.length, 1);
});

test('AC2: a candidate is promoted only after TWO distinct sessions', () => {
  const bank = createSpeakerBank({ k: 4 });
  const first = observeSpeakerBank(bank, [0, 1], 'session-a');
  assert.equal(first.action, 'new-candidate');
  // The same session repeating is NOT a second session.
  const again = observeSpeakerBank(first.bank, [0, 1], 'session-a');
  assert.equal(again.action, 'matched-candidate');
  assert.equal(again.cluster?.kind, 'candidate');
  assert.equal(promoteSpeakerCandidate(again.bank, again.cluster?.id ?? '').promoted, false);

  const second = observeSpeakerBank(again.bank, [0, 1], 'session-b');
  assert.equal(second.action, 'promoted');
  assert.equal(second.cluster?.kind, 'satellite');
  assert.deepEqual(second.cluster?.sessions, ['session-a', 'session-b']);
});

test('AC2: two agreeing candidates merge and union their sessions', () => {
  let bank = createSpeakerBank({ k: 4 });
  const left = addSpeakerCandidate(bank, [1, 0], 'session-a');
  bank = left.bank;
  const right = addSpeakerCandidate(bank, unit(20), 'session-b');
  bank = right.bank;
  const merged = mergeSpeakerClusters(bank, left.cluster?.id ?? '', right.cluster?.id ?? '');
  assert.equal(merged.merged, true);
  assert.equal(merged.bank.clusters.length, 1);
  assert.deepEqual(merged.bank.clusters[0].sessions, ['session-a', 'session-b']);
  assert.equal(merged.bank.clusters[0].kind, 'candidate');
});

test('AC2: a merge below consistencyMin, or involving a core, is refused', () => {
  let bank = createSpeakerBank({ cores: [[1, 0]], k: 4 });
  const a = addSpeakerCandidate(bank, [0, 1], 's');
  bank = a.bank;
  const b = addSpeakerCandidate(bank, [0, -1], 's'); // cos 0 with [0, 1]
  bank = b.bank;
  assert.equal(mergeSpeakerClusters(bank, a.cluster?.id ?? '', b.cluster?.id ?? '').merged, false);
  assert.equal(mergeSpeakerClusters(bank, 'core-1', a.cluster?.id ?? '').merged, false);
});

test('AC2: the learned part is capped at k while every core survives eviction', () => {
  let bank = createSpeakerBank({ cores: [[1, 0]], k: 2 }); // one core + one learned slot
  const kept = addSpeakerCandidate(bank, [0, 1], 'session-a');
  bank = kept.bank;
  const dropped = addSpeakerCandidate(bank, [0, -1], 'session-b');
  bank = dropped.bank;

  assert.equal(bank.clusters.length, 2, 'the cap counts learned clusters, not cores');
  assert.ok(bank.clusters.some((cluster) => cluster.kind === 'core'), 'a core is never evicted');
  assert.ok(!bank.clusters.some((cluster) => cluster.id === kept.cluster?.id), 'the oldest candidate goes first');
  assert.ok(bank.clusters.some((cluster) => cluster.id === dropped.cluster?.id));

  // A core alone above the cap keeps every core and leaves no learned slot.
  const coresOnly = createSpeakerBank({ cores: [[1, 0], [0, 1]], k: 1 });
  const attempted = addSpeakerCandidate(coresOnly, [0, -1], 'session-a');
  assert.equal(attempted.bank.clusters.length, 2);
  assert.ok(attempted.bank.clusters.every((cluster) => cluster.kind === 'core'));
});

test('AC2: evictSpeakerClusters reports exactly what it removed', () => {
  const cluster = (id: string, lastTurn: number) => ({
    id,
    kind: 'candidate' as const,
    centroid: Float32Array.from([1, 0]),
    sessions: ['s'],
    turns: 1,
    lastTurn,
  });
  const overfull = {
    ...createSpeakerBank({ k: 2 }),
    clusters: [cluster('cluster-a', 1), cluster('cluster-b', 2), cluster('cluster-c', 3)],
    turn: 3,
  };
  const evicted = evictSpeakerClusters(overfull);
  assert.deepEqual(evicted.evicted, ['cluster-a'], 'the least recently seen candidate goes first');
  assert.deepEqual(
    evicted.bank.clusters.map((entry) => entry.id),
    ['cluster-b', 'cluster-c'],
  );
});

// ── AC3: the selector and the dual key ──────────────────────────────────────────────────────────

test('AC3: dual key — a bystander-first cluster tracks but is NOT authorized', () => {
  const bystander = decideSpeakerTracking({ sessionScore: 0.6, coreScore: 0.1, clusterConfirmedByCore: false });
  assert.equal(bystander.acceptTracking, true, 'the session attractor formed on the bystander');
  assert.equal(bystander.authorizeTse, false, 'the core does not recognize them');
  assert.equal(bystander.decision, 'track');
});

test('AC3: dual key — a core-confirmed target turn is authorized', () => {
  const target = decideSpeakerTracking({ sessionScore: 0.5, coreScore: 0.6, clusterConfirmedByCore: true });
  assert.equal(target.acceptTracking, true);
  assert.equal(target.authorizeTse, true);
  assert.equal(target.decision, 'authorize');
});

test('AC3: gray zones do nothing or track only', () => {
  const below = decideSpeakerTracking({ sessionScore: 0.2, coreScore: 0.1 });
  assert.deepEqual(
    [below.acceptTracking, below.authorizeTse, below.decision],
    [false, false, 'none'],
    'below TRACK nothing acts',
  );
  const band = decideSpeakerTracking({ sessionScore: 0.32, coreScore: 0.2 });
  assert.deepEqual([band.acceptTracking, band.authorizeTse, band.decision], [true, false, 'track']);
  const inconsistent = decideSpeakerTracking({ sessionScore: 0.5, coreScore: 0.2, clusterConfirmedByCore: true });
  assert.equal(inconsistent.authorizeTse, false, 'a confirmed cluster with a low core score is refused');
  assert.equal(inconsistent.reason, 'core-confirmation-inconsistent');
});

test('AC3: the selector picks the target window, never the bystander or a quiet one', () => {
  const windows = [
    windowReading(0, 0.1, 0.6), // bystander: session-consistent, core says no
    windowReading(2000, 0.12, 0.55), // bystander continues
    windowReading(4000, 0.6, 0.55), // target: core-confirmed
    windowReading(6000, 0.9, 0.9, 0.1), // loud score, mostly silence — fails the quality gate
  ];
  const selected = selectSpeakerSample(windows);
  assert.ok(selected !== null);
  assert.equal(selected.startMs, 4000);
  assert.equal(selected.windowStartMs, 4000);
  assert.equal(selected.durationMs, 3500, '2 s window extended to the 3.5 s sample inside the observed audio');
});

test('AC3: no core-confirmed window means no sample at all', () => {
  assert.equal(selectSpeakerSample([windowReading(0, 0.1, 0.6), windowReading(2000, 0.2, 0.6)]), null);
});

test('AC3: the quality gate needs both a full window and enough speech', () => {
  assert.equal(speakerWindowPassesQuality(windowReading(0, 0.6, 0.6)), true);
  assert.equal(speakerWindowPassesQuality(windowReading(0, 0.6, 0.6, 0.59)), false);
  assert.equal(
    speakerWindowPassesQuality({ startMs: 0, durationMs: 1500, speechRatio: 0.9, scoreCore: 0.6, scoreSession: 0.6 }),
    false,
    'a short window cannot be a 2 s analysis window',
  );
});

// ── AC4: the environment arm point ──────────────────────────────────────────────────────────────

test('AC4: unset, empty and off all resolve to off, each with one attributable line', () => {
  for (const env of [{}, { VOICE_SPEAKER_TRACKING: '' }, { VOICE_SPEAKER_TRACKING: 'off' }]) {
    const lines: string[] = [];
    const resolution = resolveSpeakerTracking(env, (line) => lines.push(line));
    assert.equal(resolution.mode, 'off');
    assert.equal(resolution.invalid, null);
    assert.equal(resolution.degraded, null);
    assert.equal(lines.length, 1, 'the unset/off states still say so');
    assert.match(lines[0], /^speaker_tracking: off/);
  }
});

test('AC4: an unknown value is reported and does not enable anything', () => {
  const lines: string[] = [];
  const resolution = resolveSpeakerTracking({ VOICE_SPEAKER_TRACKING: 'gate' }, (line) => lines.push(line));
  assert.equal(resolution.mode, 'off');
  assert.equal(resolution.invalid, 'gate');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /not one of off\/shadow/);
  assert.equal(describeSpeakerTracking(resolution), lines[0]);
});

test('AC4: shadow without a model path degrades to off, out loud', () => {
  const lines: string[] = [];
  const resolution = resolveSpeakerTracking({ VOICE_SPEAKER_TRACKING: 'shadow' }, (line) => lines.push(line));
  assert.equal(resolution.mode, 'off');
  assert.equal(resolution.degraded, 'model-path-missing');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /VOICE_SPEAKER_MODEL_PATH/);
});

test('AC4: shadow with a model path resolves the mode, the path and the frozen thresholds', () => {
  const lines: string[] = [];
  const resolution = resolveSpeakerTracking(
    { VOICE_SPEAKER_TRACKING: ' SHADOW ', VOICE_SPEAKER_MODEL_PATH: ' /models/campplus.onnx ' },
    (line) => lines.push(line),
  );
  assert.equal(resolution.mode, 'shadow');
  assert.equal(resolution.modelPath, '/models/campplus.onnx');
  assert.equal(resolution.thresholds.track, 0.3);
  assert.equal(resolution.thresholds.matchFast, 0.35);
  assert.equal(resolution.thresholds.promote, 0.4);
  assert.equal(resolution.thresholds.consistencyMin, 0.6);
  assert.equal(resolution.thresholds.maxStepSessionDeg, 15);
  assert.equal(resolution.thresholds.maxStepBankDeg, 8);
  assert.equal(resolution.thresholds.bankSize, 4);
  assert.equal(resolution.thresholds.windowSeconds, 2);
  assert.equal(resolution.thresholds.sampleSeconds, 3.5);
  assert.equal(resolution.thresholds.speechRatioMin, 0.6);
  assert.equal(SPEAKER_TRACKING_THRESHOLDS.bankSize, 4);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /shadow requested/);
  assert.match(lines[0], /read-only/);
});

// ── the model leaf (AC5's failure posture, driven without the native addon) ─────────────────────

test('the model loader reports a failure as ONE line and a null embedder, never a throw', async () => {
  const lines: string[] = [];
  const model = createSpeakerTrackerModel({
    modelPath: '/missing/campplus.onnx',
    log: (line) => lines.push(line),
    loadDependency: async () => {
      throw new Error('addon unavailable');
    },
  });
  await waitFor(() => model.status !== 'loading');
  assert.equal(model.status, 'failed');
  assert.equal(model.embedder(), null);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /FAILED to load/);
  assert.match(lines[0], /voice is unaffected/);
});

test('the model loader loads once and exposes the embedder on success', async () => {
  const lines: string[] = [];
  let loads = 0;
  class FakeExtractor {
    readonly dim = 192;
    createStream(): { acceptWaveform: () => void; inputFinished: () => void } {
      return { acceptWaveform: () => undefined, inputFinished: () => undefined };
    }
    isReady(): boolean {
      return true;
    }
    compute(): Float32Array {
      return new Float32Array(192).fill(0.5);
    }
  }
  const model = createSpeakerTrackerModel({
    modelPath: '/models/campplus.onnx',
    log: (line) => lines.push(line),
    loadDependency: async () => {
      loads += 1;
      return { SpeakerEmbeddingExtractor: FakeExtractor };
    },
  });
  await waitFor(() => model.status !== 'loading');
  assert.equal(loads, 1, 'the model is loaded exactly once');
  assert.equal(model.status, 'ready');
  assert.equal(model.embedder()?.dim, 192);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /loaded/);
  // One embed through the extractor-shaped fake: PCM16 → Float32 → 192-d vector.
  const embedding = model.embedder()?.embed(Int16Array.from([0, 1000, -1000]));
  assert.equal(embedding?.length, 192);
});

// ── the window accumulator and the seam (AC6/AC7's runtime half) ───────────────────────────────

test('the accumulator emits one 2 s window per 100 sixteen-kHz frames and skips other rates', () => {
  const accumulator = createSpeakerWindowAccumulator();
  const frames: SpeakerWindow[] = [];
  for (let index = 0; index < 99; index += 1) {
    frames.push(...accumulator.push(Buffer.from(pcmFrame(index), 'base64'), { sourceRate: 16_000, atMs: index * 20 }));
  }
  assert.equal(frames.length, 0);
  assert.equal(accumulator.pendingSamples, 99 * 320);
  frames.push(
    ...accumulator.push(Buffer.from(pcmFrame(99), 'base64'), { sourceRate: 16_000, atMs: 100 * 20 }),
  );
  assert.equal(frames.length, 1);
  assert.equal(frames[0].samples.length, 32_000);
  assert.equal(frames[0].durationMs, 2000);
  assert.equal(frames[0].speechRatio, 1, 'every 20 ms subframe clears the RMS floor');
  assert.equal(accumulator.windows, 1);

  assert.equal(accumulator.push(Buffer.from(pcmFrame(100), 'base64'), { sourceRate: 48_000, atMs: 3000 }).length, 0);
  assert.equal(accumulator.skippedFrames, 1);
  // An undeclared rate is the browser's conventional 16 kHz, not a refusal.
  assert.equal(accumulator.push(Buffer.from(pcmFrame(101), 'base64'), { atMs: 3020 }).length, 0);
  assert.equal(accumulator.skippedFrames, 1);
});

test('the seam tracks a bystander first and re-anchors (and authorizes) when the core confirms', () => {
  const embeddings = new Map<number, Float32Array>([
    [1, Float32Array.from([0, 1])], // bystander
    [2, Float32Array.from([1, 0])], // the enrolled user
  ]);
  const seam = createSpeakerTrackerSeam({
    embed: (samples) => embeddings.get(samples[0]) ?? null,
    core: [[1, 0]],
  });

  const bystander = seam.observe(windowWithMarker(1, 0), 2000);
  assert.equal(bystander.track, true, 'the session attractor forms on the first speaker');
  assert.equal(bystander.authorizeTse, false, 'the core does not recognize the bystander');
  assert.equal(bystander.provisional, true);
  assert.equal(bystander.firstVsCore, 0, 'first-vs-core reads the first embedding against enrollment');
  assert.equal(bystander.embedded, true);

  const target = seam.observe(windowWithMarker(2, 2000), 4000);
  assert.equal(target.reanchored, true, 'a core-confirmed turn re-anchors a foreign session cluster');
  assert.equal(target.track, true);
  assert.equal(target.authorizeTse, true);
  assert.equal(target.provisional, false);

  const summary = seam.summary();
  assert.equal(summary.windows, 2);
  assert.equal(summary.accepted, 2);
  near(summary.coverage, 1);
  assert.equal(summary.reanchors, 1);
  assert.equal(summary.provisional, 1);
  near(summary.firstVsCore ?? Number.NaN, 0);
});

test('an embedding failure is a reading, not a throw, and does not move the attractor', () => {
  const seam = createSpeakerTrackerSeam({
    embed: () => {
      throw new Error('model exploded');
    },
  });
  const reading = seam.observe(windowWithMarker(1, 0), 2000);
  assert.equal(reading.embedded, false);
  assert.equal(reading.track, false);
  assert.equal(reading.authorizeTse, false);
  assert.equal(seam.summary().accepted, 0);
});

test('the two shadow lines carry the readings AC6/AC7 name and never audio', () => {
  const window: SpeakerShadowObservation = {
    window: 3,
    atMs: 6000,
    embedded: true,
    score: 0.512,
    coreScore: 0.601,
    decision: 'authorize',
    track: true,
    authorizeTse: true,
    accepted: 2,
    firstVsCore: 0.09,
    provisional: false,
    reanchored: true,
    sampleStartMs: 4000,
    sampleMs: 3500,
  };
  const line = describeSpeakerShadowObservation(window);
  for (const key of ['window=3', 'score=0.512', 'core=0.601', 'decision=authorize', 'accepted=2', 'first_vs_core=+0.090', 'provisional=false', 'reanchor=true', 'sample=4000ms/3500ms']) {
    assert.ok(line.includes(key), `the per-window line must carry ${key}: ${line}`);
  }
  const summary = describeSpeakerShadowSummary({
    windows: 3,
    accepted: 2,
    coverage: 2 / 3,
    firstVsCore: 0.09,
    reanchors: 1,
    provisional: 1,
  });
  for (const key of ['windows=3', 'accepted=2', 'coverage=0.667', 'first_vs_core=+0.090', 'reanchors=1', 'provisional=1']) {
    assert.ok(summary.includes(key), `the summary line must carry ${key}: ${summary}`);
  }
  assert.ok(!/base64|samples|PCM/i.test(line + summary), 'no audio-shaped field may appear in a shadow line');
});

// ── the proxy seam: undefined is unchanged, shadow only observes ───────────────────────────────

/** The slice of the browser socket the proxy touches — the same shape the sibling suites use. */
class FakeBrowserSocket extends EventEmitter {
  readyState: number = WS.OPEN;
  readonly OPEN = WS.OPEN;
  readonly CLOSED = WS.CLOSED;
  readonly outbound: VoiceRealtimeOutboundFrame[] = [];

  send(data: string): void {
    this.outbound.push(JSON.parse(data) as VoiceRealtimeOutboundFrame);
  }

  close(): void {
    if (this.readyState === WS.CLOSED) {
      return;
    }
    this.readyState = WS.CLOSED;
    this.emit('close');
  }

  receive(frame: VoiceRealtimeInboundFrame): void {
    this.emit('message', Buffer.from(JSON.stringify(frame), 'utf8'));
  }
}

type Wired = {
  socket: FakeBrowserSocket;
  transports: FakeTransport[];
  logs: string[];
};

/**
 * One continuous-mode proxy connection over a fake socket and fake upstream.
 *
 * `speakerTracker` is passed only by the shadow arms: its ABSENCE is the shipped state, exactly as
 * `server/index.ts` leaves it when the switch is off (or the model is not ready).
 */
function wire(options: { speakerTracker?: VoiceSpeakerTrackerSeam } = {}): Wired {
  const socket = new FakeBrowserSocket();
  const transports: FakeTransport[] = [];
  const logs: string[] = [];
  const seams: VoiceRealtimeProxySeams = {
    createTransport: () => {
      const transport = createFakeTransport();
      transports.push(transport);
      return transport;
    },
    createExecutor: () => ({ session_send: async () => ({ runId: 'run-1', queued: false }) }),
    instructions: 'speaker tracker instructions',
    segmentedRelay: false,
    browserKeepaliveMs: 0,
    log: (line) => logs.push(line),
    ...(options.speakerTracker === undefined ? {} : { speakerTracker: options.speakerTracker }),
  };
  handleVoiceRealtimeConnection(
    socket as unknown as Parameters<typeof handleVoiceRealtimeConnection>[0],
    'session-under-test',
    seams,
  );
  return { socket, transports, logs };
}

/** Every audio payload the active upstream was handed, in order. */
const appends = (wired: Wired): string[] =>
  (wired.transports[0]?.sent ?? [])
    .filter((message) => message.type === 'input_audio_buffer.append')
    .map((message) => (message as { audio: string }).audio);

/** The outbound frame-type sequence, which is what "no new client frames" is read against. */
const outboundTypes = (wired: Wired): string[] => wired.socket.outbound.map((frame) => frame.type);

const settle = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function feed(wired: Wired, payloads: readonly string[]): Promise<void> {
  await waitFor(() => wired.socket.outbound.some((frame) => frame.type === 'state' && frame.state === 'open'));
  for (const audio of payloads) {
    wired.socket.receive({ type: 'audio', audio, sourceRate: 16_000 });
  }
  await settle();
}

test('AC6: with no speakerTracker seam the relay forwards byte-for-byte the same frames', async () => {
  const payloads = Array.from({ length: 100 }, (_, index) => pcmFrame(index));
  const baseline = wire();
  await feed(baseline, payloads);
  assert.deepEqual(appends(baseline), payloads);
  assert.ok(!baseline.logs.some((line) => line.startsWith('speaker_shadow')));
  baseline.socket.close();
});

test('AC6: shadow observes completed 2 s windows while every frame still crosses unchanged', async () => {
  const payloads = Array.from({ length: 100 }, (_, index) => pcmFrame(index));
  const baseline = wire();
  await feed(baseline, payloads);
  const baselineAppends = appends(baseline);
  const baselineTypes = outboundTypes(baseline);
  baseline.socket.close();

  const observed: SpeakerWindow[] = [];
  const seam: VoiceSpeakerTrackerSeam = {
    observe(window: SpeakerWindow, atMs: number): SpeakerShadowObservation {
      observed.push(window);
      return {
        window: observed.length,
        atMs,
        embedded: true,
        score: 0.5,
        coreScore: 0.4,
        decision: 'track',
        track: true,
        authorizeTse: false,
        accepted: observed.length,
        firstVsCore: 0.1,
        provisional: true,
        reanchored: false,
        sampleStartMs: null,
        sampleMs: null,
      };
    },
    summary: () => ({
      windows: observed.length,
      accepted: observed.length,
      coverage: observed.length === 0 ? 0 : 1,
      firstVsCore: 0.1,
      reanchors: 0,
      provisional: observed.length,
    }),
  };
  const shadow = wire({ speakerTracker: seam });
  await feed(shadow, payloads);

  assert.equal(observed.length, 1, 'exactly one 2 s window from 100 × 20 ms frames');
  assert.equal(observed[0].samples.length, 32_000);
  assert.deepEqual(appends(shadow), baselineAppends, 'shadow forwards the same audio, in the same order');
  assert.deepEqual(outboundTypes(shadow), baselineTypes, 'shadow sends no new client frame');

  const lines = shadow.logs.filter((line) => line.startsWith('speaker_shadow'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /score=0\.500/);
  assert.match(lines[0], /decision=track/);
  assert.match(lines[0], /accepted=1/);
  assert.match(lines[0], /first_vs_core=\+0\.100/);
  assert.match(lines[0], /provisional=true/);

  shadow.socket.close();
  const summaryLines = shadow.logs.filter((line) => line.startsWith('speaker_shadow summary:'));
  assert.equal(summaryLines.length, 1, 'exactly one connection-end summary line');
  assert.match(summaryLines[0], /windows=1/);
  assert.match(summaryLines[0], /accepted=1/);
  assert.match(summaryLines[0], /coverage=1\.000/);
  assert.match(summaryLines[0], /first_vs_core=\+0\.100/);
  assert.match(summaryLines[0], /reanchors=0/);
  assert.match(summaryLines[0], /provisional=1/);
});

test('AC6: an odd-sized tail stays a partial window and the summary says so', async () => {
  const seam: VoiceSpeakerTrackerSeam = {
    observe: () => {
      throw new Error('should not be reached');
    },
    summary: () => ({ windows: 0, accepted: 0, coverage: 0, firstVsCore: null, reanchors: 0, provisional: 0 }),
  };
  const shadow = wire({ speakerTracker: seam });
  await feed(shadow, [pcmFrame(1), pcmFrame(2)]);
  assert.equal(shadow.logs.filter((line) => line.startsWith('speaker_shadow window=')).length, 0);
  shadow.socket.close();
  const summary = shadow.logs.find((line) => line.startsWith('speaker_shadow summary:'));
  assert.ok(summary !== undefined);
  assert.match(summary, /windows=0/);
  assert.match(summary, /partialWindowSamples=640\/32000/);
});
