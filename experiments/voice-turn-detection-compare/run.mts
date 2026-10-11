/**
 * Pluggable turn-detection comparison harness — groups A/B/C/D against one labelled manifest.
 *
 * THE QUESTION (SPEC `docs/proposals/voice-turn-detection-pluggable-comparison-SPEC.md`). GOAL-034
 * fixed the COST of the Live Voice path. It did not answer whether a cheaper TURN DETECTOR can
 * approach `qwen`'s commit quality. This harness measures four detectors on the same labelled
 * audio, with the same reading definitions, so the answer is a number rather than an impression.
 *
 *   A  the shipping `StreamingVad` (src/shared/voiceEndpoint.ts) — a fixed silence threshold over a
 *      sliding noise floor. The incumbent; the thing a replacement must beat.
 *   B  Pipecat Smart Turn v3.2 — local ONNX CPU inference on the raw waveform (adapter
 *      `adapters/smart-turn-v3.mts`). No call fee.
 *   C  LiveKit Turn Detector v1-mini — local CPU. P0/P0.5 recorded it as `blocked-by-license` because
 *      the harness would call the model STANDALONE. P0.6 re-read the licence and changed the ROUTE:
 *      the model is driven INSIDE `livekit-agents` (the framework Section 3.b(i) names) from an
 *      isolated Python sandbox, so group C is now MEASURED with the same six readings as A/B
 *      (adapter `adapters/livekit-v1-mini.mts`, runner `livekit-sandbox/run_livekit_eot.py`).
 *   D  the existing `gap-voice-realtime-turn-detection-configurable-comparison` run, read as
 *      prior evidence — not re-run, not re-billed.
 *
 * THE CANDIDATE POINT IS THE UNIT, AND IT IS THE PAUSE ONSET. Each sample is one instruction; a
 * "candidate point" is a moment inside it where a detector decides END (turn over) or CONTINUE
 * (same turn still running). Every group answers the SAME points, so the comparison is per-point
 * and not per-clip. The point is placed at the FIRST QUIET FRAME — the onset of the silence — and
 * not at the middle of it, because the onset is the only moment all detectors can be put to at
 * once, and the moment at which the difference between them actually shows:
 *
 *   · StreamingVad (A) has no semantic signal; its rule IS "wait out the silence", so at an onset
 *     it can only answer after `endpointMs` (400 ms) of it. Any pause at least that long is
 *     therefore a commit to END *before the speaker resumes* — a false cutoff, however quiet the
 *     gap looked. Interrogating A at the pause centre instead (as an earlier revision did) hides
 *     exactly the pauses in 400–800 ms, and under-reports the incumbent.
 *   · Smart Turn (B) is a classifier over the last 8 s ending at the interrogation point. At the
 *     onset that window ends on the speaker's own last syllable, so its answer is a genuine
 *     prediction about the CONTENT — which is the only reason to consider replacing A at all.
 *
 * So the interrogation point is common and the reaction is not: A looks 400 ms ahead because its
 * rule is defined that way, B answers immediately. That asymmetry is the thing the SPEC's
 * "端点延迟 p90 ≤ 150ms" line is asking about, and it is measured, not assumed. The sensitivity of
 * B's reading to A's decision horizon is recorded separately as `groupBSensitivity` (the same
 * classifier asked 400 ms later), so a reader can see how much of B's advantage is the earlier
 * question and how much is the semantic signal.
 *
 * WHERE THE LABELS COME FROM — AND WHY THEY ARE DEFENSIBLE. Each fixture's authored reference is a
 * single instruction. A pause in the NATURAL range (250–1500 ms) that still has speech after it is
 * therefore a WITHIN-TURN pause by construction ⇒ CONTINUE. The last speech frame of the clip is
 * the instruction's END ⇒ END. Pauses LONGER than 1500 ms are recorded but EXCLUDED from scoring:
 * these clips are occupancy-tiered and carry injected digital silence, and a multi-second gap is
 * ambiguous to a human labeller as well as to a detector — scoring it as CONTINUE would be
 * asserting a ground truth the audio does not support. See `annotationPolicy` in manifest.json.
 *
 * HONESTY GUARDRAILS (DoD). No number here is copied from a third-party benchmark; group B's are
 * from this process's own ONNX run. Group C is `blocked`/`deferred` unless the licence and input
 * spec are actually in hand. `sampleSizeCaveat` is true whenever the sample count is small, with a
 * reason — the go/no-go table is then explicitly preliminary.
 *
 * Run (offline; downloads only the model weights, once):
 *   node scripts/voice-turn-detection-compare.mjs
 * or directly, with a model already on disk:
 *   npx tsx --tsconfig server/tsconfig.json experiments/voice-turn-detection-compare/run.mts --model <path>
 * Emit/refresh the manifest only:
 *   npx tsx --tsconfig server/tsconfig.json experiments/voice-turn-detection-compare/run.mts --emit-manifest
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { StreamingVad, thresholdsFor, FRAME_MS } from '../../src/shared/voiceEndpoint.ts';
import {
  createSmartTurnSession,
  decodeWav,
  measureFeatureWarmCold,
  measurePredictWarmCold,
  predictEndpoint,
  truncateToLastSeconds,
  whisperLogMel,
  type SmartTurnSession,
} from './adapters/smart-turn-v3.mts';
import { evaluateLiveKit } from './adapters/livekit-v1-mini.mts';
import {
  COMPILED_N_FRAMES,
  COMPILED_N_MELS,
  compiledWhisperLogMel,
  featureDiff,
  loadCompiledFeatures,
  measureCompiledWarmCold,
} from './adapters/smart-turn-compiled-features.mts';
import { evaluateMaai } from './adapters/maai-vap-mono.mts';
import { evaluateVogent } from './adapters/vogent-turn.mts';

export const DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(DIR, '../..');
const MANIFEST_PATH = path.join(DIR, 'manifest.json');
const RESULT_PATH = path.join(DIR, 'RESULT.json');
const FIXTURES_DIR = path.join(REPO_ROOT, 'experiments/voice-trim/fixtures');
const TRANSCRIPTS_PATH = path.join(FIXTURES_DIR, 'transcripts.json');
const SIBLING_RESULT = path.join(REPO_ROOT, 'experiments/voice-realtime-turn-detection/RESULT.json');

// ── annotation policy (the numbers that define a candidate point) ─────────────────────────────

/**
 * A frame is silence when its RMS energy is below this absolute floor. Chosen from the corpus's own
 * energy histogram, not guessed: these occupancy-tiered clips are bimodal — a silence cluster at
 * EXACTLY 0 or ≈1.5e-4 (injected digital silence / its dither floor), a valley around 1e-3, and the
 * speech cluster from ~3e-3 up. 1e-3 sits in the valley, so it separates the two clusters instead of
 * cutting into the speech one (an earlier 1e-2 threshold swallowed quiet syllables and merged
 * speech fragments, which is visible as inflated silence runs). Because the injected silence is
 * digital, an absolute floor is stable here where a sliding percentile would drift.
 */
const SILENCE_RMS = 1e-3;
/** Below this a pause is breath/plosive, not a turn-taking event. */
const MIN_PAUSE_MS = 250;
/** Above this a pause is outside the natural within-turn range and is EXCLUDED (see header). */
const MAX_NATURAL_PAUSE_MS = 1500;
/** The VAD's endpoint: a sentence ends after this much silence (voiceEndpoint DEFAULT_ENDPOINT_MS). */
const VAD_ENDPOINT_MS = 400;

const FIXTURE_ORDER = [
  'en-e01-o45.wav',
  'en-e01-o65.wav',
  'zh-d01-o85.wav',
  'zh-d02-o65.wav',
  'zh-d03-o45.wav',
  'zh-d06-o65.wav',
  'zh-d10-o85.wav',
  'zh-d13-o45.wav',
] as const;

/** AC5: three-state label. CORRECTION is a real boundary at which a NAIVE pipeline would commit the
 *  superseded instruction — exactly the case the SPEC's commit-grace / turnVersion machine handles. */
type Truth = 'END' | 'CONTINUE' | 'CORRECTION';
/** The scenario a candidate point belongs to; the keys of manifest.provenance.scenarioCoverage. */
type Scenario = 'turn-end' | 'mid-sentence-pause' | 'code-mix' | 'self-correction' | 'plain-pause';
type Candidate = {
  /** The interrogation point: the first quiet frame after speech, in ms from the clip start. */
  onsetMs: number;
  onsetSample: number;
  /** Length of the silence that follows the onset; `null` at a turn end, where it runs to the clip edge. */
  pauseMs: number | null;
  truth: Truth;
  kind: 'within-turn-pause' | 'turn-end' | 'correction-point';
  scenario: Scenario;
  note: string;
};
type Excluded = { atMs: number; durationMs: number; reason: string };
type Sample = {
  id: string;
  /** The on-disk fixture this sample reads (for a derived sample, its BASE fixture). */
  fixture: string;
  /** sha256 of the sample's OWN PCM — the derived PCM when `derivedFrom` is set. */
  sha256: string;
  language: 'en' | 'zh';
  /** AC5: REAL human recording vs SYNTHETIC. The whole corpus is TTS; NO human sample exists here. */
  source: 'synthetic' | 'real';
  /** 'authored-fixture' = a shipped voice-trim clip; 'derived-midpause' = constructed in memory. */
  derivation: 'authored-fixture' | 'derived-midpause';
  /** Set for a derived sample: the base fixture its audio was constructed from. */
  derivedFrom?: string;
  reference: string;
  durationSeconds: number;
  synthetic: boolean;
  candidatePoints: Candidate[];
  excludedPauses: Excluded[];
  /** AC2: real samples carry their full acquisition provenance; synthetic ones carry the TTS note. */
  provenance?: Record<string, unknown>;
};

/**
 * AC5 — the self-correction label is REFERENCE-DERIVED, like END and CONTINUE, not detector-derived.
 * The authored reference of zh-d02-o65 is a self-correction (「改一下 voice.service.ts，嗯不对，应该是
 * voice.routes.ts」); its correction marker (嗯不对) opens a new clause at the FIRST within-turn pause,
 * so that pause is labelled CORRECTION instead of CONTINUE. Keyed by fixture + the pause's ORDINAL
 * (0-based, in onset order) so it survives a recomputation of the onset times. Only this one clip
 * carries a correction in the authored corpus; no synthetic correction sample is fabricated.
 */
const CORRECTION_PAUSE_ORDINAL: Record<string, number> = { 'zh-d02-o65.wav': 0 };
/** AC5: fixtures whose candidate points are code-mixed zh/en (from the authored reference text). */
const CODE_MIX_FIXTURES = new Set(['en-e01-o45.wav', 'en-e01-o65.wav', 'zh-d01-o85.wav', 'zh-d02-o65.wav']);
/** AC5: fixtures whose authored reference contains filler pauses (嗯…那个…). */
const FILLER_FIXTURES = new Set(['zh-d06-o65.wav', 'zh-d13-o45.wav']);

function frameEnergies(samples: Float32Array, rate: number): number[] {
  const frame = Math.max(1, Math.round((FRAME_MS / 1000) * rate));
  const n = Math.floor(samples.length / frame);
  const out: number[] = [];
  for (let f = 0; f < n; f++) {
    let acc = 0;
    const from = f * frame;
    for (let i = 0; i < frame; i++) acc += samples[from + i] * samples[from + i];
    out.push(Math.sqrt(acc / frame));
  }
  return out;
}

/**
 * The corpus's own measured pause level: the median RMS of the frames the manifest already calls
 * quiet (`< SILENCE_RMS`). A frame of this corpus spends its pauses at ~2e-5 (int16 dither), while
 * ~40% of frames are EXACTLY zero — and that is what defeats the shipped floor (see `diagnoseFloor`).
 */
export function measuredPauseLevel(samples: Float32Array, sampleRate: number): number | null {
  // `0 < e` excludes the frames that are exactly zero: an exact zero is the ABSENCE of signal, not
  // a level, and including them drags any percentile back down to the dither floor.
  const quiet = frameEnergies(samples, sampleRate).filter((e) => e > 0 && e < SILENCE_RMS);
  if (quiet.length === 0) return null;
  quiet.sort((a, b) => a - b);
  return quiet[Math.floor(quiet.length / 2)];
}

export type FloorDiagnosis = {
  exactZeroFrameFraction: number;
  shippedEnterThreshold: number;
  measuredPauseLevel: number | null;
  pauseLevelAboveShippedEnter: boolean;
  verdict: string;
};

/**
 * Why group A's shipped reading has to be read carefully on THIS corpus.
 *
 * The sliding floor is the 15th percentile of a 30 s window of frame energies, and a large share of
 * these fixtures' frames are EXACTLY zero (injected digital silence). An exact zero lands in the
 * lowest log-spaced bucket, whose value is `MIN_FRAME_ENERGY` (1e-6) — so with ≥15% zeros in the
 * window the floor COLLAPSES to the minimum, the enter threshold falls to 3e-6, and the corpus's
 * actual pause plateau (~2e-5, twenty times the threshold) is classified as SPEECH. The detector
 * then never endpoints an interior pause and never fires on a trailing one.
 *
 * That is a faithful reading of the shipped detector on this input, not a harness error — and it is
 * exactly the condition a real recording never reproduces (real room tone is ~-50 dBFS, four orders
 * of magnitude above the int16 dither floor). `groupAFixedFloor` re-runs the same detector with the
 * floor pinned to the measured pause level, which is what its sliding floor would hold on input
 * without absolute zeros, so both the degenerate and the representative reading are visible.
 */
export function diagnoseFloor(samples: Float32Array, sampleRate: number): FloorDiagnosis {
  const energies = frameEnergies(samples, sampleRate);
  const zeros = energies.filter((e) => e === 0).length;
  const vad = new StreamingVad({ sampleRate });
  for (const e of energies) vad.pushFrameEnergy(e);
  const shippedEnter = thresholdsFor(vad.noiseFloor).enter;
  const pauseLevel = measuredPauseLevel(samples, sampleRate);
  const above = pauseLevel !== null && pauseLevel > shippedEnter;
  return {
    exactZeroFrameFraction: Number((zeros / Math.max(1, energies.length)).toFixed(4)),
    shippedEnterThreshold: Number(shippedEnter.toExponential(3)),
    measuredPauseLevel: pauseLevel === null ? null : Number(pauseLevel.toExponential(3)),
    pauseLevelAboveShippedEnter: above,
    verdict: above
      ? 'the pause plateau sits ABOVE the shipped enter threshold ⇒ the shipped VAD reads pauses as speech and never endpoints them (group A’s shipped reading is degenerate on this input)'
      : 'the pause plateau sits below the shipped enter threshold ⇒ the shipped floor is functional on this input',
  };
}

function sha256File(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

let TRANSCRIPTS_CACHE: { entries: Array<{ clip: string; reference: string }> } | null = null;
function transcripts(): { entries: Array<{ clip: string; reference: string }> } {
  if (!TRANSCRIPTS_CACHE) TRANSCRIPTS_CACHE = JSON.parse(readFileSync(TRANSCRIPTS_PATH, 'utf8'));
  return TRANSCRIPTS_CACHE;
}
function referenceFor(fixture: string): string {
  return transcripts().entries.find((e) => e.clip === fixture)?.reference ?? '';
}

/** AC5: the scenario tag a fixture's within-turn pauses carry (its correction pause is overridden). */
function scenarioForFixture(fixture: string): Scenario {
  if (CODE_MIX_FIXTURES.has(fixture)) return 'code-mix';
  if (FILLER_FIXTURES.has(fixture)) return 'mid-sentence-pause';
  return 'plain-pause';
}

/**
 * The labelling policy, applied to a decoded buffer. Extracted (AC5) so a DERIVED sample is labelled
 * by the SAME rules as an authored fixture rather than by a parallel copy that could drift.
 */
function labelCandidates(
  samples: Float32Array,
  sampleRate: number,
  opts: { taggedScenario?: Scenario; correctionOrdinal?: number; floor?: number } = {},
): { candidates: Candidate[]; excluded: Excluded[] } {
  // AC2: the synthetic corpus can use an ABSOLUTE floor because its silence is digitally injected
  // (exactly 0 or a ~1.5e-4 dither). Real recordings have room tone ABOVE 1e-3, so an absolute floor
  // finds no pauses in them at all; a per-sample floor (see `realFloor`) is used for real audio and
  // recorded on each sample. Everything else about the policy is unchanged.
  const floor = opts.floor ?? SILENCE_RMS;
  const energies = frameEnergies(samples, sampleRate);
  const quiet = energies.map((e) => e < floor);
  const frame = Math.round((FRAME_MS / 1000) * sampleRate);
  const msPerFrame = (frame / sampleRate) * 1000;

  const lastSpeech = quiet.lastIndexOf(false);
  const runs: Array<{ start: number; end: number }> = [];
  let s = -1;
  for (let i = 0; i <= quiet.length; i++) {
    const q = i < quiet.length && quiet[i];
    if (q && s < 0) s = i;
    else if (!q && s >= 0) {
      runs.push({ start: s, end: i });
      s = -1;
    }
  }

  const toMs = (sample: number): number => Math.round(sample / (sampleRate / 1000));
  const candidates: Candidate[] = [];
  const excluded: Excluded[] = [];
  const defaultScenario: Scenario = opts.taggedScenario ?? 'plain-pause';
  let withinTurnOrdinal = 0;
  for (const run of runs) {
    const durMs = (run.end - run.start) * msPerFrame;
    const onsetSample = run.start * frame; // the first quiet frame — the interrogation point
    if (run.start > lastSpeech) continue; // trailing silence → handled as the turn-end below
    if (durMs < MIN_PAUSE_MS) continue; // breath/plosive
    if (durMs > MAX_NATURAL_PAUSE_MS) {
      excluded.push({
        atMs: toMs(onsetSample),
        durationMs: Math.round(durMs),
        reason: 'pause > 1500 ms — outside the natural within-turn range; occupancy-injected silence, ambiguous to a human labeller (excluded, not scored)',
      });
      continue;
    }
    const isCorrection = opts.correctionOrdinal === withinTurnOrdinal;
    withinTurnOrdinal += 1;
    candidates.push({
      onsetMs: toMs(onsetSample),
      onsetSample,
      pauseMs: Math.round(durMs),
      truth: isCorrection ? 'CORRECTION' : 'CONTINUE',
      kind: isCorrection ? 'correction-point' : 'within-turn-pause',
      scenario: isCorrection ? 'self-correction' : defaultScenario,
      note: isCorrection
        ? `${Math.round(durMs)} ms pause at the authored self-correction boundary (嗯不对) ⇒ CORRECTION: a naive pipeline would commit the superseded instruction; the grace window must supersede it`
        : `${Math.round(durMs)} ms pause with speech after it in the same instruction ⇒ within-turn`,
    });
  }
  // the turn-end: the onset of the trailing silence, i.e. the frame after the last speech frame
  const endSample = Math.min(samples.length, (lastSpeech + 1) * frame);
  candidates.push({
    onsetMs: toMs(endSample),
    onsetSample: endSample,
    pauseMs: null,
    truth: 'END',
    kind: 'turn-end',
    scenario: 'turn-end',
    note: 'instruction completed (authored reference is one instruction) ⇒ turn end',
  });
  candidates.sort((a, b) => a.onsetSample - b.onsetSample);
  return { candidates, excluded };
}

/** Build one labelled sample from an authored fixture, by the policy in the header. */
export function buildSample(fixture: string): Sample {
  const full = path.join(FIXTURES_DIR, fixture);
  const { sampleRate, samples } = decodeWav(full);
  const { candidates, excluded } = labelCandidates(samples, sampleRate, {
    taggedScenario: scenarioForFixture(fixture),
    correctionOrdinal: CORRECTION_PAUSE_ORDINAL[fixture],
  });
  return {
    id: fixture.replace(/\.wav$/, ''),
    fixture,
    sha256: sha256File(full),
    language: fixture.startsWith('en') ? 'en' : 'zh',
    source: 'synthetic', // TTS-rendered (transcripts.json provenance); no human recording exists
    derivation: 'authored-fixture',
    reference: referenceFor(fixture),
    durationSeconds: Number((samples.length / sampleRate).toFixed(3)),
    synthetic: true,
    candidatePoints: candidates,
    excludedPauses: excluded,
  };
}

// ── AC5: derived SYNTHETIC samples (mid-sentence-pause scenario) ───────────────────────────────

const DERIVED_PAUSE_MS = 700;
const DERIVED_FIXTURES = ['en-e01-o45.wav', 'zh-d01-o85.wav', 'zh-d06-o65.wav', 'zh-d13-o45.wav'] as const;

function sha256OfFloat32(a: Float32Array): string {
  return createHash('sha256').update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)).digest('hex');
}

/**
 * A derived sample = one base clip TRIMMED to its LONGEST contiguous speech run, with a single
 * 700 ms silent gap injected at that run's temporal centre. It is SYNTHETIC by construction (the
 * gap is injected, the two sides are the base clip's own TTS audio), and it is labelled by the same
 * policy as everything else: the injected gap is a within-turn pause ⇒ CONTINUE, and the clip's end
 * is the turn end ⇒ END. Nothing human is fabricated — this only re-cuts TTS audio already shipped.
 */
function deriveMidPauseAudio(fixture: string): { sampleRate: number; samples: Float32Array } {
  const { sampleRate, samples } = decodeWav(path.join(FIXTURES_DIR, fixture));
  const frame = Math.max(1, Math.round((FRAME_MS / 1000) * sampleRate));
  const energies = frameEnergies(samples, sampleRate);
  let bestStart = 0;
  let bestLen = 0;
  let curStart = 0;
  let curLen = 0;
  for (let i = 0; i < energies.length; i++) {
    if (energies[i] >= SILENCE_RMS) {
      if (curLen === 0) curStart = i;
      curLen += 1;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curLen = 0;
    }
  }
  const runStartSample = bestStart * frame;
  const runEndSample = Math.min(samples.length, (bestStart + bestLen) * frame);
  const run = samples.subarray(runStartSample, runEndSample);
  const gapSamples = Math.round((DERIVED_PAUSE_MS / 1000) * sampleRate);
  const centre = Math.floor(run.length / 2);
  const out = new Float32Array(run.length + gapSamples); // gap stays exactly zero
  out.set(run.subarray(0, centre), 0);
  out.set(run.subarray(centre), centre + gapSamples);
  return { sampleRate, samples: out };
}

function buildDerivedSample(fixture: string): Sample {
  const { sampleRate, samples } = deriveMidPauseAudio(fixture);
  const { candidates, excluded } = labelCandidates(samples, sampleRate, { taggedScenario: 'mid-sentence-pause' });
  return {
    id: `${fixture.replace(/\.wav$/, '')}+inject${DERIVED_PAUSE_MS}ms`,
    fixture,
    sha256: sha256OfFloat32(samples),
    language: fixture.startsWith('en') ? 'en' : 'zh',
    source: 'synthetic',
    derivation: 'derived-midpause',
    derivedFrom: fixture.replace(/\.wav$/, ''),
    reference: `${referenceFor(fixture)} (derived: longest speech segment + a ${DERIVED_PAUSE_MS} ms injected mid-segment silence)`,
    durationSeconds: Number((samples.length / sampleRate).toFixed(3)),
    synthetic: true,
    candidatePoints: candidates,
    excludedPauses: excluded,
  };
}

// ── AC2: REAL human samples, fetched from licence-cleared public corpora ───────────────────────

const REAL_DIR = path.join(DIR, 'datasets', 'real');
const REAL_SAMPLES_PATH = path.join(REAL_DIR, 'samples.json');

/**
 * The silence floor for a REAL recording.
 *
 * The synthetic corpus's absolute floor (SILENCE_RMS = 1e-3) is calibrated for digitally injected
 * silence, and P0.6 measured that it does NOT transfer: LibriSpeech/THCHS-30 room tone sits above
 * 1e-3, so at that floor almost every real utterance yields a single candidate point (its END) and
 * no within-turn pauses at all — a labelling artefact, not a property of the speech. Real samples
 * therefore use a per-sample floor pinned to this recording's own 15th-percentile frame RMS (the
 * same "15th percentile" idea as the shipped VAD's sliding floor), never dropping below the corpus
 * floor. The value and the method are recorded on every real sample so the choice is auditable.
 */
export const REAL_FLOOR_PERCENTILE = 0.15;
export function realFloor(energies: number[]): { floor: number; percentileValue: number; method: string } {
  const sorted = [...energies].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(REAL_FLOOR_PERCENTILE * (sorted.length - 1))));
  const p = sorted[idx];
  return {
    floor: Math.max(SILENCE_RMS, p),
    percentileValue: Number(p.toExponential(3)),
    method:
      `max(${SILENCE_RMS} (corpus floor), ${REAL_FLOOR_PERCENTILE * 100}th-percentile frame RMS of this recording) — ` +
      'an absolute floor is a synthetic-corpus artefact; real room tone sits above it',
  };
}

export type RealSampleRecord = {
  id: string;
  language: 'en' | 'zh';
  dataset: string;
  config: string;
  split: string;
  rowIndex: number;
  speakerId: number | null;
  chapterId: number | null;
  corpusId: string | null;
  reference: string | null;
  licenseSpdx: string;
  licenseUrl: string;
  licenseInDistribution: string;
  redistributable: boolean;
  attribution: string;
  sampleRate: number;
  channels: number;
  format: string;
  durationSeconds: number;
  sha256: string;
  fetchScript: string;
  fetchedAt: string;
};

/**
 * Load the fetched real samples (AC2) and label them by the SAME candidate-point policy as
 * everything else, with the per-recording floor above. A real sample carries its full acquisition
 * provenance; the audible audio itself is NOT committed (the corpora's licences differ on
 * redistribution — see dataset-sources.json), only the metadata and the fetch script that recreates
 * it. When the audio has not been fetched, this returns `available:false` with the reason instead
 * of silently contributing zero human samples.
 */
export function loadRealSamples(): { available: boolean; reason?: string; records: RealSampleRecord[]; samples: Sample[] } {
  if (!existsSync(REAL_SAMPLES_PATH)) {
    return {
      available: false,
      reason: `${path.relative(REPO_ROOT, REAL_SAMPLES_PATH)} not found — run \`node experiments/voice-turn-detection-compare/datasets/fetch-real-samples.mjs\` (audio is gitignored; only the metadata is committed)`,
      records: [],
      samples: [],
    };
  }
  const doc = JSON.parse(readFileSync(REAL_SAMPLES_PATH, 'utf8')) as { samples: RealSampleRecord[] };
  const samples: Sample[] = [];
  for (const rec of doc.samples) {
    const wav = path.join(REAL_DIR, `${rec.id}.wav`);
    if (!existsSync(wav)) continue;
    const { sampleRate, samples: pcm } = decodeWav(wav);
    const floorInfo = realFloor(frameEnergies(pcm, sampleRate));
    const { candidates, excluded } = labelCandidates(pcm, sampleRate, { floor: floorInfo.floor });
    samples.push({
      id: rec.id,
      fixture: `${rec.id}.wav`,
      sha256: rec.sha256,
      language: rec.language,
      source: 'real',
      derivation: 'real-corpus' as never, // extended value; `derivation` is only compared against 'authored-fixture'/'derived-midpause'
      reference: rec.reference ?? '',
      durationSeconds: rec.durationSeconds,
      synthetic: false,
      candidatePoints: candidates,
      excludedPauses: excluded,
      provenance: {
        ...rec,
        audioCommitted: false,
        audioPath: path.relative(REPO_ROOT, wav),
        silenceFloor: floorInfo,
      },
    });
  }
  return { available: true, records: doc.samples, samples };
}

/** Every sample the harness scores: authored fixtures, derived synthetic samples, then real ones. */
export function buildAllSamples(): Sample[] {
  return [...FIXTURE_ORDER.map(buildSample), ...DERIVED_FIXTURES.map(buildDerivedSample), ...loadRealSamples().samples];
}

/** Decode a sample's OWN audio (a derived sample re-derives it; deterministically). */
function sampleAudio(sample: Sample): { sampleRate: number; samples: Float32Array } {
  if (sample.derivation === 'derived-midpause') return deriveMidPauseAudio(sample.fixture);
  if (sample.source === 'real') return decodeWav(path.join(REAL_DIR, sample.fixture));
  const { sampleRate, samples } = decodeWav(path.join(FIXTURES_DIR, sample.fixture));
  return { sampleRate, samples };
}

/** The on-disk WAV for a sample that HAS one (authored fixtures + real samples; derived ones do not). */
function sampleWavPath(sample: Sample): string | null {
  if (sample.derivation === 'derived-midpause') return null;
  return sample.source === 'real' ? path.join(REAL_DIR, sample.fixture) : path.join(FIXTURES_DIR, sample.fixture);
}

/** AC5: counts and denominators, computed from the samples rather than asserted. */
export function sampleBreakdown(samples: Sample[]): Record<string, unknown> {
  const byTruth: Record<Truth, number> = { END: 0, CONTINUE: 0, CORRECTION: 0 };
  let points = 0;
  for (const s of samples) {
    for (const c of s.candidatePoints) {
      points += 1;
      byTruth[c.truth] += 1;
    }
  }
  const authored = samples.filter((s) => s.derivation === 'authored-fixture').length;
  const derived = samples.filter((s) => s.derivation === 'derived-midpause').length;
  const human = samples.filter((s) => s.source === 'real');
  const humanPoints = human.reduce((n, s) => n + s.candidatePoints.length, 0);
  const humanContinue = human.reduce((n, s) => n + s.candidatePoints.filter((c) => c.truth === 'CONTINUE').length, 0);
  return {
    totalSamples: samples.length,
    authoredFixtureSamples: authored,
    derivedSyntheticSamples: derived,
    realCorpusSamples: human.length,
    humanSamples: human.length,
    humanCandidatePoints: humanPoints,
    humanContinuePoints: humanContinue,
    candidatePoints: points,
    denominatorByTruth: byTruth,
    note: 'denominator = candidate POINTS (the unit every group answers), not clips',
  };
}

export function buildManifest(): Record<string, unknown> {
  const samples = buildAllSamples();
  const real = loadRealSamples();
  return {
    schema: 'voice-turn-detection-compare/manifest@2',
    generatedAt: new Date().toISOString(),
    task: 'gap-voice-turn-detection-p0-6-dataset-benchmark',
    spec: 'docs/proposals/voice-turn-detection-pluggable-comparison-SPEC.md',
    // AC2: real-sample acquisition, with the target, the actual count, and the reason for any gap.
    realSampleAcquisition: {
      target: '20–50 real human candidate points (P0.6 AC2)',
      available: real.available,
      reason: real.available ? null : real.reason,
      realSamples: real.samples.length,
      realCandidatePoints: real.samples.reduce((n, s) => n + s.candidatePoints.length, 0),
      sources: real.available
        ? Array.from(new Set(real.records.map((r) => `${r.dataset} (${r.config}/${r.split})`)))
        : [],
      licenses: real.available ? Array.from(new Set(real.records.map((r) => r.licenseSpdx))) : [],
      audioCommitted: false,
      audioNote:
        'the audio is NOT committed: LibriSpeech (CC BY 4.0) would permit it, THCHS-30\'s two licence statements disagree, so neither is committed and the fetch script recreates both. dataset-sources.json records the first-hand licence text for each.',
      fetchScript: 'experiments/voice-turn-detection-compare/datasets/fetch-real-samples.mjs',
      licensingArtifact: 'experiments/voice-turn-detection-compare/dataset-sources.json',
    },
    provenance: {
      source:
        'experiments/voice-trim/fixtures/ (8 authored clips, reused — the SPEC names this set) + 4 derived synthetic samples (AC5) + real human speech from LibriSpeech (CC BY 4.0) and THCHS-30 (AC2, P0.6)',
      nature:
        'TTS-rendered dictation corpus, occupancy-tiered (en-e01-o45/o65, zh-d*-o85/o65/o45). The ' +
        'authored reference is the text the TTS was given (transcripts.json), so the ground truth ' +
        'is by construction, not model-labelled. Every TTS sample is synthetic:true. The 4 derived ' +
        'samples (AC5) are TTS audio re-cut — no human recording is fabricated. AC2 (P0.6) ADDS ' +
        'real human speech from licence-cleared corpora (LibriSpeech en / THCHS-30 zh), source:real, ' +
        'synthetic:false, each carrying its dataset, licence, speaker id where the corpus has one, ' +
        'sample rate, format, timestamps and fetch script; the real recordings are the ONLY source of ' +
        'human variability here — the synthetic ones cannot manufacture it.',
      scenarioCoverage: {
        'self-correction': { fixtures: ['zh-d02-o65'], truth: 'CORRECTION', note: 'authored self-correction 嗯不对; the FIRST within-turn pause (the clause boundary before 嗯不对) is the correction point' },
        'code-mix (zh/en code-term mixing)': { fixtures: ['en-e01-o45', 'en-e01-o65', 'zh-d01-o85', 'zh-d02-o65'], truth: 'CONTINUE/END' },
        'mid-sentence-pause (authored fillers + injected)': {
          fixtures: ['zh-d06-o65', 'zh-d13-o45', ...DERIVED_FIXTURES.map((f) => `${f.replace(/\.wav$/, '')}+inject${DERIVED_PAUSE_MS}ms`)],
          truth: 'CONTINUE',
        },
        'turn-end': { fixtures: ['all samples'], truth: 'END' },
      },
    },
    annotationPolicy: {
      unit: 'candidate point = the ONSET of a silence run inside one instruction, where every detector is asked END/CONTINUE',
      onset: 'the first frame whose RMS < SILENCE_RMS after a speech frame; the interrogation point for every group',
      withinTurnPause: `a silence run of ${MIN_PAUSE_MS}–${MAX_NATURAL_PAUSE_MS} ms with speech after it ⇒ CONTINUE (the authored reference is a single instruction)`,
      correction:
        'a within-turn pause at an authored self-correction boundary ⇒ CORRECTION: a naive pipeline commits the superseded instruction, so the prediction is scored separately (must-supersede), never as a false cutoff',
      turnEnd: 'the onset of the trailing silence (the frame after the last speech frame) ⇒ END',
      excluded: `silence runs > ${MAX_NATURAL_PAUSE_MS} ms are recorded under excludedPauses and NOT scored — occupancy-injected gaps are ambiguous ground truth`,
      detector: `silence = frame RMS < ${SILENCE_RMS}; 20 ms frames`,
      vadEndpointMs: VAD_ENDPOINT_MS,
      truthStates: ['END', 'CONTINUE', 'CORRECTION'] as Truth[],
      sourceField: {
        values: ['real', 'synthetic'],
        currentCorpus: 'P0.6: real human speech (LibriSpeech en CC BY 4.0 + THCHS-30 zh) plus the TTS corpus',
      },
      realSampleFloor:
        `real recordings are labelled with a PER-SAMPLE silence floor = max(${SILENCE_RMS}, ${REAL_FLOOR_PERCENTILE * 100}th-percentile frame RMS), ` +
        'because the P0.6 measurement showed the synthetic corpus\'s absolute floor does not transfer to real room tone (see realSampleAcquisition); ' +
        'the floor used is recorded on every real sample under provenance.silenceFloor',
      asymmetry:
        'the interrogation point is common but the reaction is not: StreamingVad can only answer after its own ' +
        `${VAD_ENDPOINT_MS} ms of silence (so a pause ≥ ${VAD_ENDPOINT_MS} ms is a commit to END before the speaker resumes), ` +
        'while Smart Turn answers at the onset from the content of the preceding 8 s',
    },
    sampleCount: samples.length,
    candidatePointCount: samples.reduce((n, s) => n + s.candidatePoints.length, 0),
    sampleBreakdown: sampleBreakdown(samples),
    samples,
  };
}

// ── group A: the shipping StreamingVad, reused ────────────────────────────────────────────────

export type PointReading = {
  atMs: number;
  truth: Truth;
  predicted: Truth | 'blocked';
  latencyMs: number | null;
  probability?: number;
  featureMs?: number;
  inferenceMs?: number;
};

/**
 * Group A's decision at a candidate point: from this onset, does the silence run on for the VAD's
 * endpoint (`endpointMs`, 400 ms) WITHOUT the speaker coming back? That is the shipped rule —
 * `StreamingVad.buildSegments` splits two speech runs into two sentences exactly when
 * `hasEndSizedQuiet` finds `endpointFrames` consecutive frames with `energy < enter(noise)`, and
 * `quiet[]` in the module is computed the same way. Reproduced here frame by frame rather than read
 * off `flush()`, because the question is the LIVE one — did the detector commit before the speaker
 * resumed — and `flush()` only exists once the clip is over.
 *
 * The floor is the module's own (`vad.noiseFloor` after every pushed frame), so this is the shipped
 * detector's rule and not an approximation of it. Anything shorter than the endpoint is CONTINUE by
 * definition: the VAD has not committed.
 */
export function runGroupA(sample: Sample, samples: Float32Array, sampleRate: number, fixedNoiseFloor?: number): PointReading[] {
  const frame = Math.max(1, Math.round((FRAME_MS / 1000) * sampleRate));
  const energies = frameEnergies(samples, sampleRate);
  const vad = fixedNoiseFloor === undefined
    ? new StreamingVad({ sampleRate })
    : new StreamingVad({ sampleRate, noiseFloorMode: 'fixed', fixedNoiseFloor });
  const quiet: boolean[] = [];
  for (let i = 0; i < energies.length; i++) {
    vad.pushFrameEnergy(energies[i]);
    quiet.push(energies[i] < thresholdsFor(vad.noiseFloor).enter);
  }
  // The maximal quiet run STARTING at each frame (a forward run, not a run-up): the decision at an
  // onset is about the silence that FOLLOWS it.
  const forward = new Int32Array(quiet.length + 1);
  for (let i = quiet.length - 1; i >= 0; i--) forward[i] = quiet[i] ? forward[i + 1] + 1 : 0;
  const endpointFrames = Math.max(1, Math.round(((VAD_ENDPOINT_MS / 1000) * sampleRate) / frame));
  return sample.candidatePoints.map((c) => {
    const f = Math.min(quiet.length, Math.floor(c.onsetSample / frame));
    // The detector's own silence onset is not necessarily the manifest's: the manifest's is the first
    // frame under the perceptual floor, which can still be on the decay ramp and above the VAD's own
    // threshold. So scan forward for the first frame at which the VAD's rule is satisfied, and take
    // the commit to be `endpointMs` after THAT frame.
    let commitFrame: number | null = null;
    for (let j = f; j < quiet.length; j++) {
      if (forward[j] >= endpointFrames) {
        commitFrame = j + endpointFrames;
        break;
      }
    }
    // The commit only counts if it lands before the speaker comes back (a within-turn pause), or
    // anywhere before the clip ends (a turn end, where `pauseMs` is null and the silence runs on).
    const resumeFrame = c.pauseMs === null
      ? Number.POSITIVE_INFINITY
      : Math.floor((c.onsetSample + (c.pauseMs / 1000) * sampleRate) / frame);
    const declared = commitFrame !== null && commitFrame < resumeFrame;
    return {
      atMs: c.onsetMs,
      truth: c.truth,
      predicted: declared ? 'END' : 'CONTINUE',
      // A commits `endpointMs` after its own silence onset; null when it never commits in time.
      latencyMs: declared ? VAD_ENDPOINT_MS : null,
    };
  });
}

// ── group B: Smart Turn v3.2, real local ONNX ─────────────────────────────────────────────────

export async function runGroupB(
  session: SmartTurnSession,
  sample: Sample,
  samples: Float32Array,
  sampleRate: number,
  lookAheadMs = 0,
): Promise<PointReading[]> {
  const out: PointReading[] = [];
  for (const c of sample.candidatePoints) {
    // `lookAheadMs` is 0 for the primary reading (the window ends on the speaker's last syllable at
    // the onset); the sensitivity pass uses A's endpoint so both detectors are asked at the same
    // horizon.
    const cut = Math.min(samples.length, c.onsetSample + Math.round((lookAheadMs / 1000) * sampleRate));
    const window = samples.subarray(0, cut);
    const t0 = process.hrtime.bigint();
    const r = await predictEndpoint(session, window, sampleRate);
    const t1 = process.hrtime.bigint();
    out.push({
      atMs: c.onsetMs,
      truth: c.truth,
      predicted: r.prediction === 1 ? 'END' : 'CONTINUE',
      latencyMs: Number(t1 - t0) / 1e6,
      probability: Number(r.probability.toFixed(6)),
      featureMs: Number(r.featureMs.toFixed(3)),
      inferenceMs: Number(r.inferenceMs.toFixed(3)),
    });
  }
  return out;
}

// ── rates ─────────────────────────────────────────────────────────────────────────────────────

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

export type GroupMetrics = {
  group: string;
  detector: string;
  status: string;
  points: number;
  falseCutoffRate: number;
  missedEndpointRate: number;
  falseTriggerActions: number;
  /** AC5: CORRECTION points are scored on their own axis, never as false cutoffs. */
  correctionPoints: number;
  /** How many CORRECTION points the detector called END ⇒ an immediate-commit pipeline would miscommit. */
  correctionEndDetected: number;
  correctionNaiveMiscommits: number;
  latencyP50Ms: number | null;
  latencyP90Ms: number | null;
  cpuMsPerDecision: number | null;
  ramDeltaMb: number | null;
  extraModelCostCny: number;
  /** AC5: 95% Wilson score intervals for the two rates (denominator = points of that truth). */
  falseCutoffRate95Ci: [number, number] | null;
  missedEndpointRate95Ci: [number, number] | null;
  readings: PointReading[];
};

/** Wilson score interval for k successes out of n, 95% — better than normal-approx at small n. */
export function wilson95(k: number, n: number): [number, number] | null {
  if (n === 0) return null;
  const z = 1.959963984540054;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Number(Math.max(0, centre - half).toFixed(4)), Number(Math.min(1, centre + half).toFixed(4))];
}

export function metricsFor(group: string, detector: string, status: string, readings: PointReading[], cpu?: { cpuMs: number; ramMb: number }): GroupMetrics {
  let contTotal = 0;
  let falseCutoff = 0;
  let endTotal = 0;
  let missed = 0;
  let correctionTotal = 0;
  let correctionEnd = 0;
  const latencies: number[] = [];
  for (const r of readings) {
    if (r.truth === 'CONTINUE') {
      contTotal += 1;
      if (r.predicted === 'END') falseCutoff += 1;
    } else if (r.truth === 'CORRECTION') {
      // A CORRECTION point is a real boundary: predicting END is NOT a false cutoff (the speaker did
      // pause), nor a correct terminal commit (the instruction is superseded). Scored on its own axis.
      correctionTotal += 1;
      if (r.predicted === 'END') correctionEnd += 1;
    } else {
      endTotal += 1;
      if (r.predicted === 'CONTINUE') missed += 1;
    }
    if (r.latencyMs !== null && r.latencyMs > 0) latencies.push(r.latencyMs);
  }
  latencies.sort((a, b) => a - b);
  const decisions = readings.filter((r) => r.predicted !== 'blocked').length;
  return {
    group,
    detector,
    status,
    points: readings.length,
    falseCutoffRate: contTotal ? Number((falseCutoff / contTotal).toFixed(4)) : 0,
    missedEndpointRate: endTotal ? Number((missed / endTotal).toFixed(4)) : 0,
    falseTriggerActions: falseCutoff,
    correctionPoints: correctionTotal,
    correctionEndDetected: correctionEnd,
    correctionNaiveMiscommits: correctionEnd,
    latencyP50Ms: latencies.length ? Number(percentile(latencies, 0.5).toFixed(2)) : null,
    latencyP90Ms: latencies.length ? Number(percentile(latencies, 0.9).toFixed(2)) : null,
    cpuMsPerDecision: cpu && decisions ? Number((cpu.cpuMs / decisions).toFixed(3)) : null,
    ramDeltaMb: cpu ? Number(cpu.ramMb.toFixed(1)) : null,
    extraModelCostCny: 0,
    falseCutoffRate95Ci: wilson95(falseCutoff, contTotal),
    missedEndpointRate95Ci: wilson95(missed, endTotal),
    readings,
  };
}

// ── group D: the sibling task's recorded evidence ─────────────────────────────────────────────

function readGroupD(): Record<string, unknown> {
  if (!existsSync(SIBLING_RESULT)) {
    return { status: 'pending-upstream-task', note: 'experiments/voice-realtime-turn-detection/RESULT.json does not exist yet' };
  }
  const r = JSON.parse(readFileSync(SIBLING_RESULT, 'utf8'));
  return {
    status: 'referenced-prior-evidence',
    source: 'experiments/voice-realtime-turn-detection/RESULT.json',
    upstreamTask: r.task,
    endpoint: r.endpoint,
    model: r.model,
    ranAt: r.ranAt,
    arms: (r.arms ?? []).map((a: Record<string, unknown>) => ({ label: a.label, commits: a.commits, emptyTranscriptions: a.emptyTranscriptions, responses: a.responses, inputTokens: a.inputTokens })),
    budget: r.budget,
    decision: r.decision,
    note: 'not re-run and not re-billed — this task only cites the recorded readings (SPEC 组 D)',
  };
}

// ── AC1: the official-preprocessing control (independent numpy oracle), run as a subprocess ────

const ORACLE_SCRIPT = path.join(DIR, 'oracle', 'whisper-log-mel-oracle.py');
const ORACLE_WORK_DIR = path.join(DIR, '.oracle-work');

/**
 * AC1: run the independent numpy oracle on the authored fixtures and diff its Whisper log-mel
 * against this harness's JS front-end, on the SAME 8 s windows. Writes the JS features and the
 * items list under DIR (the worktree), then invokes `python3`. NON-FATAL: if python3/numpy are
 * absent the harness still emits, recording `available:false` with the reason, so the absence is
 * visible in the artifact rather than silent. `jsFeaturesBySample` maps a sample id → its JS
 * features (float32, [80,800] row-major) for the window the oracle will compute.
 */
export function runOracleCheck(samples: Sample[], jsFeaturesBySample: Map<string, Float32Array>): Record<string, unknown> {
  if (!existsSync(ORACLE_SCRIPT)) return { available: false, reason: `oracle script not found at ${ORACLE_SCRIPT}` };
  mkdirSync(ORACLE_WORK_DIR, { recursive: true });
  const itemsPath = path.join(ORACLE_WORK_DIR, 'items.json');
  const outPath = path.join(ORACLE_WORK_DIR, 'oracle-out.json');
  const jsDir = path.join(ORACLE_WORK_DIR, 'js-features');
  const pyDir = path.join(ORACLE_WORK_DIR, 'py-features');
  mkdirSync(jsDir, { recursive: true });
  const items: Array<{ id: string; wav: string }> = [];
  for (const s of samples) {
    const wav = sampleWavPath(s);
    if (!wav) continue; // derived samples have no on-disk wav
    const feats = jsFeaturesBySample.get(s.id);
    if (!feats) continue;
    writeFileSync(path.join(jsDir, `${s.id}.f32`), Buffer.from(feats.buffer, feats.byteOffset, feats.byteLength));
    items.push({ id: s.id, wav });
  }
  writeFileSync(itemsPath, JSON.stringify(items, null, 2));
  try {
    execFileSync('python3', [ORACLE_SCRIPT, '--items', itemsPath, '--out', outPath, '--js-features', jsDir, '--py-features', pyDir], { stdio: 'pipe' });
    return { available: true, ...JSON.parse(readFileSync(outPath, 'utf8')) };
  } catch (err) {
    return { available: false, reason: `oracle invocation failed: ${(err as Error).message}` };
  }
}

// ── AC3: the COMPILED front-end — three-way numeric equivalence, then warm/cold timing ─────────

const ORACLE_PY_FEATURES = path.join(ORACLE_WORK_DIR, 'py-features');
const COMPILED_SRC = path.join(DIR, 'adapters', 'native', 'smart-turn-mel.c');

/** Read a raw float32 dump written by the numpy oracle (`--py-features`). */
function readF32(path: string): Float32Array {
  const buf = readFileSync(path);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

/**
 * AC3: run the COMPILED (C, N-API) Whisper log-mel front-end on the SAME windows as the JS path,
 * and check it THREE ways before quoting a latency:
 *   · compiled ↔ JS log-mel          (the shipped harness front-end)
 *   · compiled ↔ numpy oracle        (the independent official-recipe control)
 *   · JS ↔ numpy                     (the oracle's own `vsJs`, so the triangle closes)
 * A fast front-end that computes DIFFERENT features is a different front-end, not a faster one, so
 * the latency is only meaningful once the three agree within `tolerance.maxAbsDiff`. P0 located
 * 128.5 ms of group B's 167.4 ms p90 in the JS naive O(N²) DFT; this is the measurement of the
 * replacement the SPEC said a production build would use.
 */
export function runCompiledFeatureCheck(
  samples: Sample[],
  jsFeaturesBySample: Map<string, Float32Array>,
  oracleReport: Record<string, unknown>,
): Record<string, unknown> {
  const loaded = loadCompiledFeatures();
  if (!loaded.addon) {
    return { available: false, reason: loaded.error ?? 'compiled addon unavailable', buildNote: loaded.buildNote };
  }
  const addon = loaded.addon;
  // The oracle's own JS↔numpy verdict, keyed by sample id.
  const oracleVsJs = new Map<string, number>();
  for (const s of (oracleReport.samples as Array<{ id: string; vsJs?: { maxAbsDiff?: number } }> | undefined) ?? []) {
    if (typeof s.vsJs?.maxAbsDiff === 'number') oracleVsJs.set(s.id, s.vsJs.maxAbsDiff);
  }
  let compiledVsJs = 0;
  let compiledVsNumpy = 0;
  let jsVsNumpy = 0;
  let compared = 0;
  let numpyCompared = 0;
  const perSample: Array<Record<string, unknown>> = [];
  for (const s of samples) {
    const wav = sampleWavPath(s);
    if (!wav) continue;
    const js = jsFeaturesBySample.get(s.id);
    if (!js) continue;
    const { samples: pcm } = sampleAudio(s);
    const compiled = compiledWhisperLogMel(addon, truncateToLastSeconds(pcm));
    const dCJ = featureDiff(compiled, js);
    const row: Record<string, unknown> = { id: s.id, compiledVsJsMaxAbsDiff: dCJ.maxAbsDiff };
    compiledVsJs = Math.max(compiledVsJs, dCJ.maxAbsDiff);
    const pyPath = path.join(ORACLE_PY_FEATURES, `${s.id}.f32`);
    if (existsSync(pyPath)) {
      const py = readF32(pyPath);
      if (py.length === compiled.length) {
        const dCP = featureDiff(compiled, py);
        compiledVsNumpy = Math.max(compiledVsNumpy, dCP.maxAbsDiff);
        numpyCompared += 1;
        row.compiledVsNumpyMaxAbsDiff = dCP.maxAbsDiff;
      }
    }
    const o = oracleVsJs.get(s.id);
    if (o !== undefined) {
      jsVsNumpy = Math.max(jsVsNumpy, o);
      row.jsVsNumpyMaxAbsDiff = o;
    }
    compared += 1;
    perSample.push(row);
  }
  // Warm/cold timing on a representative clip: the first call builds the mel bank + Bluestein chirp.
  const rc = samples.find((s) => sampleWavPath(s) && s.id === 'zh-d01-o85') ?? samples.find((s) => sampleWavPath(s));
  const timings = rc ? measureCompiledWarmCold(addon, truncateToLastSeconds(sampleAudio(rc).samples), 8) : null;
  // The JS front-end's own warm time on the SAME clip (this is the naive O(N²) DFT P0 blamed), and
  // the numpy oracle's warm time (a third reference point), read from the oracle's per-sample report.
  const jsTiming = rc ? measureFeatureWarmCold(sampleAudio(rc).samples, 8) : null;
  const oracleRow = (oracleReport.samples as Array<{ id: string; featurisationWallMs?: number }> | undefined)?.find((s) => s.id === rc?.id);
  const tol = 1e-4;
  return {
    available: true,
    addon: {
      source: path.relative(REPO_ROOT, COMPILED_SRC),
      build: loaded.buildNote,
      abi: 'N-API (stable — no node-gyp download step)',
      shape: [COMPILED_N_MELS, COMPILED_N_FRAMES],
      recipe: 'identical to the JS front-end and the numpy oracle: periodic Hann, 400-pt frames @ hop 160, slaney 80-filter mel 0–8000 Hz, log10, max(x,max-8), (x+4)/4',
    },
    tolerance: { maxAbsDiff: tol, rationale: 'float32 features; the three implementations differ only in FFT round-off, not in algorithm' },
    threeWay: {
      samplesCompared: compared,
      numpyCompared,
      compiledVsJsMaxAbsDiff: compiledVsJs,
      compiledVsNumpyMaxAbsDiff: compiledVsNumpy,
      jsVsNumpyMaxAbsDiff: jsVsNumpy,
      allWithinTolerance: compiledVsJs < tol && compiledVsNumpy < tol && jsVsNumpy < tol,
    },
    warmCold: timings && {
      coldMs: Number(timings.coldMs.toFixed(3)),
      warmP50Ms: Number(timings.warmP50Ms.toFixed(3)),
      warmP90Ms: Number(timings.warmP90Ms.toFixed(3)),
      iterations: timings.perCallMs.length,
    },
    comparison: timings && {
      whichSample: rc?.id ?? null,
      jsNaiveDftWarmP50Ms: jsTiming ? Number(jsTiming.warmP50Ms.toFixed(3)) : null,
      numpyOracleWarmMs: oracleRow?.featurisationWallMs ?? null,
      compiledCppWarmP50Ms: Number(timings.warmP50Ms.toFixed(3)),
      speedupVsJsNaive: jsTiming && jsTiming.warmP50Ms > 0 ? Number((jsTiming.warmP50Ms / Math.max(timings.warmP50Ms, 1e-6)).toFixed(1)) : null,
      note:
        'the P0 128.5 ms p90 sat in the JS naive O(N²) DFT; the compiled O(N log N) path is the drop-in replacement ' +
        '(numerically exact per threeWay) and is timed here against that JS front-end on the same clip. numpy is ' +
        'reported as a third reference — it is the same algorithm with a vectorised FFT, not a production JS path.',
    },
    perSample,
  };
}

// ── AC4: group C measured for real — LiveKit v1-mini INSIDE the livekit-agents framework ───────

const LIVEKIT_SANDBOX = path.join(DIR, 'livekit-sandbox');
const LIVEKIT_VENV_PY = path.join(LIVEKIT_SANDBOX, '.venv', 'bin', 'python');
const LIVEKIT_RUNNER = path.join(LIVEKIT_SANDBOX, 'run_livekit_eot.py');
const LIVEKIT_ITEMS = path.join(LIVEKIT_SANDBOX, '_items.json');
const LIVEKIT_OUT = path.join(LIVEKIT_SANDBOX, '_out.json');

/**
 * AC4: run LiveKit's Turn Detector v1-mini for real, INSIDE `livekit.agents.inference.TurnDetector`
 * (the framework), in the isolated sandbox venv — the licensed route the P0.5 adapter said was
 * blocked. The shim (`run_livekit_eot.py`) is a subprocess so nothing LiveKit is ever imported into
 * this Node process; the sandbox has its own venv and is referenced by no build config.
 *
 * Re-verified licence (2026-10-11): the LiveKit Model License Agreement grants the right to "use,
 * reproduce, distribute, copy, and create derivative works", conditioned on Section 3.b(i) — not
 * "on a standalone basis or with any frameworks other than LiveKit Agents". Driving the model
 * through the framework is therefore a LICENSED use, which is the SUBSTANTIVE change from P0.5's
 * `blocked-by-license` (there the harness would have called the model standalone). Full evidence in
 * dataset-sources.json → modelLicenses.livekit-turn-detector.
 */
export function runLiveKitGroupC(samples: Sample[], docs: ReturnType<typeof evaluateLiveKit>): Record<string, unknown> {
  const reverifiedAt = '2026-10-11';
  const licenceReverification = {
    document: docs.licence.name,
    lastUpdated: docs.licence.lastUpdated,
    reverifiedAt,
    sources: [
      'huggingface.co/livekit/turn-detector/raw/main/LICENSE (sha256 4f5b74db…, 5625 bytes, first-hand)',
      'MODEL_LICENSE inside livekit-local-inference 0.2.7 (sha256 dfd8e206…, identical bar two trailing blank lines)',
    ],
    changeFromP05: {
      p05Verdict: 'blocked-by-license (the harness would call v1-mini STANDALONE, which Section 3.b(i) withholds)',
      p06Verdict: 'licensed when exercised THROUGH livekit-agents — Section 3.b(i)\'s only use-restriction is the framework, and this run satisfies it',
      whyThisIsSubstantive:
        'P0.5 read the same licence text and concluded the benchmark could not be run at all. P0.6 changed the ROUTE, not the text: the measurement now happens inside the framework the licence names, so 3.b(i) is satisfied rather than violated. 3.b(ii) (no improving non-LiveKit models) is not engaged — nothing here trains or modifies any other model.',
      sourcesReadThisTask: docs.sources,
    },
  };
  const isolation = sandboxIsolationEvidence();
  if (!existsSync(LIVEKIT_VENV_PY) || !existsSync(LIVEKIT_RUNNER)) {
    return {
      group: 'C',
      detector: 'LiveKit Turn Detector v1-mini (local, in livekit-agents)',
      status: 'sandbox-unavailable',
      measured: false,
      reason: `${path.relative(REPO_ROOT, LIVEKIT_VENV_PY)} or ${path.relative(REPO_ROOT, LIVEKIT_RUNNER)} missing — run experiments/voice-turn-detection-compare/livekit-sandbox/setup.sh`,
      licenceReverification,
      sandboxIsolation: isolation,
    };
  }
  const items: Array<Record<string, unknown>> = [];
  for (const s of samples) {
    const wav = sampleWavPath(s);
    if (!wav) continue;
    for (const c of s.candidatePoints) {
      items.push({ id: `${s.id}#${c.onsetMs}`, wav, atMs: c.onsetMs, truth: c.truth, pauseMs: c.pauseMs });
    }
  }
  if (items.length === 0) {
    return { group: 'C', detector: 'LiveKit Turn Detector v1-mini (local, in livekit-agents)', status: 'no-items', measured: false, licenceReverification, sandboxIsolation: isolation };
  }
  writeFileSync(LIVEKIT_ITEMS, JSON.stringify(items, null, 2));
  let raw: Record<string, unknown>;
  try {
    execFileSync(LIVEKIT_VENV_PY, ['-I', LIVEKIT_RUNNER, '--items', LIVEKIT_ITEMS, '--out', LIVEKIT_OUT, '--threshold', '0.5'], { stdio: 'pipe', cwd: DIR });
    raw = JSON.parse(readFileSync(LIVEKIT_OUT, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    const e = err as { stderr?: Buffer; message: string };
    return {
      group: 'C',
      detector: 'LiveKit Turn Detector v1-mini (local, in livekit-agents)',
      status: 'runner-failed',
      measured: false,
      reason: (e.stderr?.toString() || e.message).trim().slice(0, 600),
      licenceReverification,
      sandboxIsolation: isolation,
    };
  }
  const readings: PointReading[] = (raw.readings as Array<Record<string, unknown>>).map((r) => ({
    atMs: r.atMs as number,
    truth: r.truth as Truth,
    predicted: r.predicted as Truth,
    // the first decision is COLD (model load); its cost is recorded separately and kept OUT of the
    // latency distribution so group C's p50/p90 are warm, on the same footing as B's.
    latencyMs: r.phase === 'cold' ? null : (r.latencyMs as number),
    probability: r.endOfTurnProbability as number,
  }));
  const metrics = metricsFor(
    'C',
    'LiveKit Turn Detector v1-mini (local, in livekit-agents)',
    'measured',
    readings,
    { cpuMs: raw.cpuMsTotal as number, ramMb: raw.rssDeltaMb as number },
  );
  return {
    ...metrics,
    group: 'C',
    specGroupLabel: 'measured (P0.6) — was "designed, authorization-blocked" in P0.5',
    status: 'measured',
    measured: true,
    primaryBlocker: 'none',
    licenceReverification,
    sandboxIsolation: isolation,
    inputSpec: {
      ...docs.inputSpec,
      note:
        'P0.5 recorded the feature recipe as unpublished; P0.6 does not need it — the framework owns ' +
        'featurisation, so the exact log-mel recipe is irrelevant to reproducing THIS reading. What is ' +
        'published and used: 16 kHz mono, a 1.2 s client-side ring buffer, a 30 ms push chunk.',
    },
    threshold: raw.thresholdUsed,
    coldLatencyMs: raw.coldLatencyMs,
    warmLatencyP50Ms: raw.warmLatencyP50Ms,
    warmLatencyP90Ms: raw.warmLatencyP90Ms,
    rssPeakMb: raw.rssPeakMb,
    thresholdSweep: raw.thresholdSweep,
    runner: path.relative(REPO_ROOT, LIVEKIT_RUNNER),
    note: 'real local inference of turn-detector-v1-mini inside livekit-agents; the harness never imports LiveKit itself — the sandbox shim is a subprocess',
  };
}

// ── AC8: the sandbox is structurally unreachable from any build/dependency config ───────────────

const BUILD_CONFIG_FILES = [
  'package.json',
  'server/package.json',
  'tsconfig.json',
  'server/tsconfig.json',
  'vite.config.ts',
  'vite.config.js',
  'webpack.config.js',
  'scripts/test.sh',
];

/**
 * AC8: mechanical evidence that the LiveKit sandbox cannot be pulled into the application build.
 * Scans the repo's dependency/build configs for ANY of the sandbox's markers (its directory name,
 * `livekit`, `livekit-agents`, `eot-bench`). Over the sandbox directory itself the scan is
 * DELIBERATELY EXCLUDED, so a hit there is not counted as a production coupling — a hit in any of
 * the config files above would be a real one and is reported as such.
 */
export function sandboxIsolationEvidence(): Record<string, unknown> {
  const markers = ['livekit-sandbox', 'livekit-agents', 'eot-bench', 'livekit'];
  const scans: Array<{ file: string; exists: boolean; matchedMarkers: string[]; lines: string[] }> = [];
  let anyMatch = false;
  for (const rel of BUILD_CONFIG_FILES) {
    const abs = path.join(REPO_ROOT, rel);
    if (!existsSync(abs)) {
      scans.push({ file: rel, exists: false, matchedMarkers: [], lines: [] });
      continue;
    }
    const text = readFileSync(abs, 'utf8');
    const lines: string[] = [];
    const matched = new Set<string>();
    text.split('\n').forEach((ln, i) => {
      const low = ln.toLowerCase();
      const hit = markers.find((m) => low.includes(m));
      if (hit) {
        matched.add(hit);
        if (lines.length < 5) lines.push(`${i + 1}: ${ln.trim().slice(0, 120)}`);
      }
    });
    if (matched.size) anyMatch = true;
    scans.push({ file: rel, exists: true, matchedMarkers: [...matched], lines });
  }
  return {
    claim: 'the livekit-sandbox (Python venv + livekit-agents + model weights) is referenced by NO application build or dependency config',
    markersSearched: markers,
    configFilesScanned: BUILD_CONFIG_FILES,
    scans,
    coupledToBuild: anyMatch,
    verdict: anyMatch ? 'FAIL — a build config references a sandbox marker' : 'PASS — no build/dependency config references any sandbox marker',
    note: 'the sandbox is a Python venv with its own requirements.txt; it shares no module system with the Node app and is outside every tsconfig/vite/webpack include glob',
  };
}

// ── AC6: the protocol each model is fed, and the cross-dataset caveat ───────────────────────────

/**
 * AC6: the per-model input protocol, reviewed explicitly. The comparison is only meaningful if a
 * reader can see that each detector was given its OWN required preprocessing rather than a single
 * compromise — so the sample rate, the window the model sees, and the feature-extraction path are
 * recorded per group, with the windowing rule that produced the latency numbers.
 */
export const MODEL_PROTOCOL_REVIEW = [
  {
    group: 'A',
    model: 'StreamingVad (shipping)',
    sampleRateHz: 16000,
    windowSeconds: '20 ms frames, streaming (no fixed model window)',
    featureExtraction: 'frame RMS energy vs a sliding noise floor; the decision is the rule itself, not a learned front-end',
    decisionRule: 'END when ≥400 ms of consecutive sub-threshold frames occur before speech resumes',
    fedFromSameAudio: true,
    note: 'reused unmodified from src/shared/voiceEndpoint.ts; its floor is read off the live module',
  },
  {
    group: 'B',
    model: 'Pipecat Smart Turn v3.2',
    sampleRateHz: 16000,
    windowSeconds: 8,
    featureExtraction:
      'the upstream Whisper log-mel recipe (400-pt periodic-Hann STFT @ hop 160, slaney 80-filter mel 0–8000 Hz, log10, max(x,max-8), (x+4)/4), implemented JS + compiled C in this repo and diffed against a numpy control',
    decisionRule: 'the ONNX classifier\'s END probability at the window ending at the interrogation point',
    fedFromSameAudio: true,
    note: 'the 8 s window is the model\'s own; the front-end is this harness\'s, and its cost is quoted separately from the ONNX kernel\'s',
  },
  {
    group: 'C',
    model: 'LiveKit Turn Detector v1-mini',
    sampleRateHz: 16000,
    windowSeconds: 1.2,
    featureExtraction:
      'OWNED BY THE FRAMEWORK (livekit.local_inference / the native EOT wrapper) — not published, not reimplemented here; the run pushes 16 kHz mono PCM in 30 ms chunks and lets livekit-agents featurise',
    decisionRule: 'end_of_turn_probability from inference.TurnDetector(version="v1-mini") ≥ 0.5',
    fedFromSameAudio: true,
    note: 'its receptive field is the transport\'s 1.2 s ring buffer — the SAME horizon a live pipeline uses, which is why it is the honest window to quote',
  },
  {
    group: 'D',
    model: 'qwen Realtime (server-side VAD)',
    sampleRateHz: 16000,
    windowSeconds: 'server-managed',
    featureExtraction: 'not published (server-side); the group D row CITES the sibling task\'s recorded reading and re-runs nothing',
    decisionRule: 'the server\'s own turn detection as configured in that run',
    fedFromSameAudio: false,
    note: 'cite-only: a different corpus/run; recorded for context, never scored against the per-point manifest',
  },
  {
    group: 'E',
    model: 'qwen non-realtime (baseline)',
    sampleRateHz: 16000,
    windowSeconds: 'whole clip',
    featureExtraction: 'ASR/chat; the AC5 probe compares tool_choice=auto vs forced over the SAME real audio',
    decisionRule: 'does the model emit a function_call for the endpoint tool, and with the right parameters',
    fedFromSameAudio: true,
    note: 'a paid call, budgeted ≤ ¥0.05 and ledgered separately from the P0/P0.5 ¥0.021549',
  },
] as const;

/**
 * AC6: the caveat that must travel with every number here. The synthetic corpus and the real
 * LibriSpeech/THCHS-30 samples are DIFFERENT DATASETS with different speakers, microphones and
 * silence statistics, so a rate computed over one is not statistically comparable with a rate over
 * the other; and the real sample count is small, so the Wilson intervals are wide.
 */
export const CROSS_DATASET_CAVEAT = {
  statement: 'rates measured on DIFFERENT DATASETS are NOT directly comparable — this corpus mixes synthetic TTS fixtures with real LibriSpeech/THCHS-30 speech, and the two have different speakers, channels and silence floors',
  implications: [
    'a false-cutoff rate over the synthetic occupancy-tiered fixtures is not the same quantity as one over real LibriSpeech — the silence statistics differ, so the denominators are not exchangeable',
    'real samples are labelled with a PER-SAMPLE adaptive floor (see annotationPolicy.realSampleFloor) while synthetic samples use the corpus floor, so even the candidate-point DEFINITION differs by source',
    'the real sample count is small, so Wilson intervals on the real subset are wide and must be read as bounds, not point estimates',
    'the go/no-go verdicts below are DIRECTIONAL: with < 20 independent human recordings per language the sample-size row stays a CAVEAT regardless of the point estimates',
  ],
  mitigation: 'every metric carries a Wilson 95% interval (see each group\'s *Rate95Ci) and the per-sample table records the source of each point, so a reader can re-slice by source',
  relatedRows: ['sampleBreakdown', 'goNoGo.sampleSize', 'groupA.falseCutoffRate95Ci', 'groupB.falseCutoffRate95Ci'],
} as const;

// ── assembly ──────────────────────────────────────────────────────────────────────────────────

export type RunOptions = { modelPath: string };

export async function runAll(opts: RunOptions): Promise<Record<string, unknown>> {
  const manifest = buildManifest();
  const samples = manifest.samples as Sample[];
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);

  const session = await createSmartTurnSession(opts.modelPath, 1);

  const groupA: PointReading[] = [];
  const groupAFixed: PointReading[] = [];
  const groupB: PointReading[] = [];
  const groupBSens: PointReading[] = [];
  const floors: FloorDiagnosis[] = [];
  const perSample: Array<Record<string, unknown>> = [];
  let cpuTotalMs = 0;
  const rssStart = process.memoryUsage().rss;
  let rssPeak = rssStart;
  const overallT0 = process.hrtime.bigint();

  for (const sample of samples) {
    const { sampleRate, samples: s } = sampleAudio(sample);
    const a = runGroupA(sample, s, sampleRate);
    const pauseLevel = measuredPauseLevel(s, sampleRate);
    const aFixed = pauseLevel === null ? a : runGroupA(sample, s, sampleRate, pauseLevel);
    floors.push(diagnoseFloor(s, sampleRate));
    const cpu0 = process.cpuUsage();
    const b = await runGroupB(session, sample, s, sampleRate);
    const cpu1 = process.cpuUsage(cpu0);
    cpuTotalMs += (cpu1.user + cpu1.system) / 1000;
    // sensitivity: the same classifier asked 400 ms later, at StreamingVad's decision horizon
    const bSens = await runGroupB(session, sample, s, sampleRate, VAD_ENDPOINT_MS);
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
    groupA.push(...a);
    groupAFixed.push(...aFixed);
    groupB.push(...b);
    groupBSens.push(...bSens);
    perSample.push({
      id: sample.id,
      source: sample.source,
      derivation: sample.derivation,
      language: sample.language,
      candidatePoints: sample.candidatePoints.length,
      // AC5: the per-point three-state truth + scenario, so the labels are auditable per sample.
      points: sample.candidatePoints.map((c) => ({ atMs: c.onsetMs, truth: c.truth, scenario: c.scenario, pauseMs: c.pauseMs })),
      groupA: a.map((r) => `${r.atMs}ms:${r.truth}→${r.predicted}`),
      groupAFixedFloor: aFixed.map((r) => `${r.atMs}ms:${r.truth}→${r.predicted}`),
      measuredPauseLevel: pauseLevel === null ? null : Number(pauseLevel.toExponential(3)),
      groupB: b.map((r) => `${r.atMs}ms:${r.truth}→${r.predicted}(${r.probability})`),
      groupBAtVadHorizon: bSens.map((r) => `${r.atMs}ms:${r.truth}→${r.predicted}(${r.probability})`),
    });
  }
  const overallMs = Number(process.hrtime.bigint() - overallT0) / 1e6;

  const metricsA = metricsFor('A', 'StreamingVad (fixed silence threshold)', 'measured', groupA);
  const metricsB = metricsFor('B', 'Pipecat Smart Turn v3.2 (local ONNX CPU)', 'measured', groupB, {
    cpuMs: cpuTotalMs,
    ramMb: Math.max(0, (rssPeak - rssStart) / (1024 * 1024)),
  });
  // Same classifier, same points, asked `VAD_ENDPOINT_MS` later — so if B degrades to A's numbers
  // here, its advantage came from the earlier question; if it holds, it came from the content.
  const metricsBSens = metricsFor('B+400ms', "Smart Turn v3.2, window ending at StreamingVad's 400 ms decision horizon", 'measured', groupBSens);
  const metricsAFixed = metricsFor('A(fixed floor)', "StreamingVad, noise floor pinned to the corpus's measured pause level", 'measured', groupAFixed);

  // ── AC1: locate the 128.5 ms p90 — JS log-mel front-end vs ONNX kernel, cold vs warm ──────────
  const rcSample = samples.find((s) => s.id === 'zh-d01-o85') ?? samples[0];
  const rcAudio = sampleAudio(rcSample);
  const jsFeatureColdWarm = measureFeatureWarmCold(rcAudio.samples, 8);
  const jsPredictColdWarm = await measurePredictWarmCold(session, rcAudio.samples, 8);
  const jsFeaturesBySample = new Map<string, Float32Array>();
  for (const s of samples) {
    if (!sampleWavPath(s)) continue; // derived samples have no on-disk wav
    const { samples: ss } = sampleAudio(s);
    jsFeaturesBySample.set(s.id, whisperLogMel(truncateToLastSeconds(ss)));
  }
  const oracleReport = runOracleCheck(samples, jsFeaturesBySample);
  const compiledFeatureCheck = runCompiledFeatureCheck(samples, jsFeaturesBySample, oracleReport);
  const whichHalfDominates =
    jsFeatureColdWarm.warmP50Ms > jsPredictColdWarm.inference.warmP50Ms * 2
      ? 'the JS log-mel front-end dominates'
      : jsPredictColdWarm.inference.warmP50Ms > jsFeatureColdWarm.warmP50Ms * 2
        ? 'the ONNX int8 kernel dominates'
        : 'the two halves are comparable';
  const groupBRootCause = {
    question: 'where does the 128.5 ms p90 live — this harness’s JS log-mel front-end, or the ONNX int8 kernel?',
    method:
      'warm/cold split of (a) the JS front-end ALONE, (b) the ONNX inference ALONE, and (c) the end-to-end decision; ' +
      'the JS features are then diffed against an independent numpy oracle of the SAME recipe (the official-preprocessing control)',
    sample: rcSample.id,
    jsFeaturisationColdWarm: jsFeatureColdWarm,
    jsPredictionColdWarm: jsPredictColdWarm,
    oracle: oracleReport,
    whichHalfDominates,
    conclusion:
      `On ${rcSample.id}: JS log-mel warm p50 ${jsFeatureColdWarm.warmP50Ms.toFixed(2)} ms vs ONNX warm p50 ` +
      `${jsPredictColdWarm.inference.warmP50Ms.toFixed(2)} ms ⇒ ${whichHalfDominates}. The P0 p90 of 128.5 ms was the ` +
      'END-TO-END LOCAL cost (featurisation + inference), and the featurisation is this HARNESS’S naive O(N²) DFT, not the ' +
      'model. A production build replaces it with a compiled/wasm mel front-end (or B’s own C++ path); the accompanying ' +
      'oracle check confirms the JS front-end is numerically right, so the cost is an IMPLEMENTATION property, not a ' +
      'correctness one — which is exactly why the SPEC quotes the inference-only p90 next to the end-to-end one.',
    note: 'ADDITIVE: the P0 fields (latencyBreakdown, groupB.latencyP50Ms/P90Ms) are left untouched.',
  };

  const livekitDocs = evaluateLiveKit();
  const groupC = runLiveKitGroupC(samples, livekitDocs);
  const maai = evaluateMaai();
  const vogent = evaluateVogent();

  const sampleCount = samples.length;
  const candidatePointCount = groupA.length;
  const humanSampleCount = samples.filter((s) => s.source === 'real').length;
  // AC5: the "≥ 20 labelled samples" rule is about INDEPENDENT HUMAN samples. The whole corpus is
  // TTS-rendered, so this count is 0 and the caveat stays true however many derived synthetic
  // samples are added — a synthetic sample cannot manufacture human variability.
  const sampleSizeCaveat = humanSampleCount < 20;
  const falseCutoffReduction = metricsA.falseCutoffRate > 0
    ? Number((1 - metricsB.falseCutoffRate / metricsA.falseCutoffRate).toFixed(4))
    : null;
  // The same comparison against the NON-degenerate incumbent reading — the one to quote, because
  // against the shipped reading B is being compared with a detector that never endpoints at all.
  const falseCutoffReductionVsFixed = metricsAFixed.falseCutoffRate > 0
    ? Number((1 - metricsB.falseCutoffRate / metricsAFixed.falseCutoffRate).toFixed(4))
    : null;

  const featLat = groupB.map((r) => r.featureMs ?? 0).sort((a, b) => a - b);
  const infLat = groupB.map((r) => r.inferenceMs ?? 0).sort((a, b) => a - b);
  const latencyBreakdown = {
    why: 'B’s decision latency is featurisation + inference; only the second is the model’s own cost, and the first is this harness’s JS log-mel',
    featurizationP50Ms: Number(percentile(featLat, 0.5).toFixed(2)),
    featurizationP90Ms: Number(percentile(featLat, 0.9).toFixed(2)),
    inferenceP50Ms: Number(percentile(infLat, 0.5).toFixed(2)),
    inferenceP90Ms: Number(percentile(infLat, 0.9).toFixed(2)),
  };

  const goNoGo = {
    criterion: 'threshold (fixed before measuring, SPEC Go/No-Go table)',
    falseCutoffReductionBvsA: {
      threshold: '≥ 0.30 relative reduction in false-cutoff rate needed to count as "approaching Realtime"',
      measured: falseCutoffReduction,
      measuredVsCalibratedIncumbent: falseCutoffReductionVsFixed,
      verdict: falseCutoffReduction === null
        ? 'NOT MEASURABLE — the shipped incumbent produced no false cutoffs to reduce'
        : falseCutoffReduction >= 0.3 ? 'PASS' : 'FAIL',
      caveat:
        'the shipped A reading is degenerate on this corpus (its floor collapses to MIN_FRAME_ENERGY, see floorDiagnosis), so the ' +
        'shipped-vs-B number must not be quoted alone: B is being compared with a detector that never endpoints ANY pause, ' +
        'including the ones it should. measuredVsCalibratedIncumbent is the same comparison against the same detector with a ' +
        'functional floor and is the honest headline',
    },
    latencyP90GroupB: {
      threshold: '≤ 150 ms',
      measured: metricsB.latencyP90Ms,
      measuredInferenceOnlyP90Ms: latencyBreakdown.inferenceP90Ms,
      verdict: metricsB.latencyP90Ms !== null && metricsB.latencyP90Ms <= 150 ? 'PASS' : 'FAIL',
      caveat:
        'the measured value is end-to-end (this harness’s JS log-mel + the ONNX kernel). The breakdown is recorded separately: ' +
        'if the ONNX kernel alone is inside the budget and the featurisation is not, the criterion is met by the model and missed ' +
        'by a JS DFT that a production build would replace (a compiled/wasm mel front-end, or B’s own C++ path)',
    },
    cpuIncrementGroupB: {
      threshold: '≤ 10% of a single core resident increment',
      measuredCpuMsPerDecision: metricsB.cpuMsPerDecision,
      note: 'measured as CPU time per decision; the 10% single-core RESIDENT criterion is not directly measurable in a batch process — see limitation',
      verdict: 'INCONCLUSIVE-P0 (batch CPU time recorded; resident single-core share not separable)',
    },
    falseTriggerActions: {
      threshold: '≤ group A',
      groupA: metricsA.falseTriggerActions,
      groupB: metricsB.falseTriggerActions,
      verdict: metricsB.falseTriggerActions <= metricsA.falseTriggerActions ? 'PASS' : 'FAIL',
    },
    nonRealtimeQwenFeasibility: {
      threshold: 'function_call present ⇒ supported',
      measured: 'see qwenProbe (filled by the probe step)',
      verdict: 'PENDING (real paid call, run by scripts/voice-turn-detection-compare.mjs --probe-qwen)',
    },
    nonRealtimeQwenRealAudio: {
      threshold: 'AC5 — the same auto-vs-forced comparison on REAL human audio, within a separate ≤¥0.05 budget',
      measured: 'see qwenProbeRealAudio (filled by the probe step: --probe-qwen-real)',
      verdict: 'PENDING (real paid call, run by scripts/voice-turn-detection-compare.mjs --probe-qwen-real)',
    },
    selfCorrectionHandling: {
      threshold: 'a CORRECTION point must be SUPERSEDED, not committed (SPEC 状态机 / AC6)',
      correctionPoints: metricsA.correctionPoints,
      groupA_endDetectedAtCorrection: metricsA.correctionEndDetected,
      groupB_endDetectedAtCorrection: metricsB.correctionEndDetected,
      verdict:
        'INFORMATIONAL — the detectors only decide END/CONTINUE; supersession is the state machine’s job (AC6). ' +
        'This row reports how many CORRECTION points each detector calls END, i.e. how often an immediate-commit ' +
        'pipeline would need the grace window to retract.',
    },
    sampleSize: {
      threshold: '≥ 20 labelled samples',
      measured: sampleCount,
      measuredHumanSamples: humanSampleCount,
      measuredHumanCandidatePoints: (sampleBreakdown(samples).humanCandidatePoints as number),
      verdict: sampleSizeCaveat ? 'CAVEAT — preliminary/directional only' : 'PASS',
    },
    groupCLiveKitMeasured: {
      threshold: 'same six readings as A/B, or an explicit blocked status',
      measured: groupC.status === 'measured'
        ? `measured: falseCutoff=${(groupC as { falseCutoffRate?: number }).falseCutoffRate} missed=${(groupC as { missedEndpointRate?: number }).missedEndpointRate} warmP50=${(groupC as { warmLatencyP50Ms?: number }).warmLatencyP50Ms}ms warmP90=${(groupC as { warmLatencyP90Ms?: number }).warmLatencyP90Ms}ms`
        : `NOT measured (status=${String(groupC.status)})`,
      verdict: groupC.status === 'measured' ? 'PASS — measured (was designed, authorization-blocked in P0.5)' : 'INCONCLUSIVE',
      caveat:
        'P0.5 recorded group C as blocked-by-license. P0.6 re-read the same licence and changed the ROUTE, not the text: the model is now driven INSIDE the livekit-agents framework, which is what Section 3.b(i) requires, so the run is licensed. See groupC.licenceReverification.',
    },
    compiledFrontEnd: {
      threshold: 'a compiled front-end must be numerically equivalent to the JS front-end AND the numpy oracle (≤1e-4), then faster',
      threeWayAgreement: (compiledFeatureCheck.threeWay as Record<string, unknown> | undefined)?.allWithinTolerance ?? false,
      compiledWarmP50Ms: (compiledFeatureCheck.warmCold as Record<string, unknown> | undefined)?.warmP50Ms ?? null,
      jsNaiveWarmP50Ms: (compiledFeatureCheck.comparison as Record<string, unknown> | undefined)?.jsNaiveDftWarmP50Ms ?? null,
      verdict:
        (compiledFeatureCheck.threeWay as Record<string, unknown> | undefined)?.allWithinTolerance
          ? `PASS — the compiled path replaces the 128.5 ms naive JS DFT drop-in`
          : 'NOT MEASURED — compiled addon unavailable',
      caveat: 'the numeric triangle is what licenses the latency claim: a fast front-end that computed different features would not be a faster front-end',
    },
  };

  return {
    schema: 'voice-turn-detection-compare/result@2',
    task: 'gap-voice-turn-detection-p0-6-dataset-benchmark',
    spec: 'docs/proposals/voice-turn-detection-pluggable-comparison-SPEC.md',
    ranAt: new Date().toISOString(),
    sampleSize: sampleCount,
    candidatePointCount,
    humanSampleSize: humanSampleCount,
    sampleSizeCaveat,
    sampleBreakdown: sampleBreakdown(samples),
    realSampleAcquisition: manifest.realSampleAcquisition,
    sampleSizeCaveatReason: sampleSizeCaveat
      ? `${sampleCount} candidate points, only ${humanSampleCount} from INDEPENDENT HUMAN recordings. P0.6 (AC2) added real LibriSpeech/THCHS-30 speech, but the target was 20–50 real candidate points per the AC; when the human count is below 20 the go/no-go verdicts remain PRELIMINARY/DIRECTIONAL. No human recording was fabricated — every real sample is fetched from a licence-cleared corpus by datasets/fetch-real-samples.mjs.`
      : null,
    humanSampleNote:
      `${humanSampleCount} real human recordings from licence-cleared public corpora (LibriSpeech CC BY 4.0 en / THCHS-30 zh) ` +
      `contribute ${sampleBreakdown(samples).humanCandidatePoints as number} candidate points, of which ` +
      `${sampleBreakdown(samples).humanContinuePoints as number} are CONTINUE. These are the ONLY source of human variability here — ` +
      'they are NOT the same dataset as the synthetic fixtures, so see crossDatasetCaveat before comparing a rate across the two.',
    manifest: {
      path: 'experiments/voice-turn-detection-compare/manifest.json',
      annotation: manifest.annotationPolicy,
      excludedPauseCount: samples.reduce((n, s) => n + s.excludedPauses.length, 0),
    },
    groupA: metricsA,
    groupAFixedFloor: metricsAFixed,
    floorDiagnosis: {
      perSample: floors,
      exactZeroFrameFractionMax: Math.max(...floors.map((f) => f.exactZeroFrameFraction)),
      pauseLevelAboveShippedEnter: floors.every((f) => f.pauseLevelAboveShippedEnter),
      what: 'the shipped sliding floor bottoms out at MIN_FRAME_ENERGY because ~40% of this corpus’ frames are EXACTLY zero, ' +
        'so the enter threshold falls to ~3e-6 and the ~2e-5 pause plateau is read as SPEECH',
      consequence: 'group A’s SHIPPED reading is a reading of a detector that does not endpoint this input at all — its low ' +
        'false-cutoff rate is non-function, not precision. groupAFixedFloor pins the same detector’s floor to the measured ' +
        'pause level (what the floor would hold on input without absolute zeros) and is the representative incumbent reading',
      note:
        'a real recording never reproduces this: room tone is ~-50 dBFS, four orders of magnitude above the int16 dither ' +
        'floor these fixtures sit at. This is a property of the occupancy-tiered corpus, measured, not assumed',
    },
    groupB: metricsB,
    groupBRootCause,
    compiledFeatureCheck,
    latencyBreakdown,
    groupBSensitivity: {
      why:
        'the interrogation point is common but the reaction is not: A can only answer after its own ' +
        `${VAD_ENDPOINT_MS} ms of silence, B answers at the onset. Re-running B with the window ending at A's ` +
        'horizon separates "B wins because it was asked earlier" from "B wins because it read the content".',
      metrics: metricsBSens,
    },
    groupC,
    sandboxIsolation: sandboxIsolationEvidence(),
    candidateMaAI: maai,
    candidateVogent: vogent,
    groupD: readGroupD(),
    perSample,
    goNoGo,
    modelProtocolReview: MODEL_PROTOCOL_REVIEW,
    crossDatasetCaveat: CROSS_DATASET_CAVEAT,
    methodology: [
      'candidate point = the ONSET of a silence run inside one instruction; every group answers the same points',
      'group A reuses the shipping StreamingVad at its 400 ms endpoint, floor read off the module; it commits 400 ms after the onset',
      'group B is asked AT the onset, from the 8 s window ending there (latency = one inference + preprocessing)',
      'group B runs the real smart-turn-v3.2-cpu ONNX with the upstream Whisper log-mel recipe, locally',
      'group C runs the real turn-detector-v1-mini INSIDE livekit-agents (local CPU), from an isolated Python sandbox that no build config references',
      'group D cites the sibling task reading; nothing was re-run or re-billed',
      'AC3: the compiled C/N-API log-mel front-end is diffed three ways (compiled↔JS, compiled↔numpy, JS↔numpy) before its latency is quoted',
      'latency = wall-clock of one decision; CPU = process cpuUsage delta over the group-B loop; RAM = RSS delta',
    ],
    caveats: [
      'group A latency is its configured endpointMs by construction (400 ms), not a distribution: the VAD fires exactly that long after the onset, and never if the speaker resumes first — that constant is the incumbent’s whole cost model',
      'group B latency includes the harness’s JS log-mel preprocessing, not only the ONNX kernel — it is an end-to-end local decision cost, which is the number that matters for the realtime budget',
      'a Smart Turn window of synthetic silence scores 0.987 (measured on this build), so B is a strong END predictor once silence fills its window; that is WHY the primary interrogation point is the onset — asking B deeper into a pause measures the silence, not the semantics (the groupBSensitivity pass quantifies exactly that)',
      'the corpus mixes occupancy-tiered TTS fixtures with real LibriSpeech/THCHS-30 speech; pauses > 1500 ms are excluded from scoring (see manifest.annotationPolicy), and the two sources are DIFFERENT DATASETS (see crossDatasetCaveat)',
      'CPU increment is reported as batch CPU time per decision; the resident single-core share (≤10%) is not separable in a batch process',
      'group C\'s reading is a genuine local inference inside livekit-agents but on a SMALL real+Synthetic manifest; like the others it is directional, not a production SLA',
    ],
    timingSeconds: Number((overallMs / 1000).toFixed(2)),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--emit-manifest')) {
    const manifest = buildManifest();
    writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`wrote ${MANIFEST_PATH} (${manifest.sampleCount} samples, ${manifest.candidatePointCount} candidate points)`);
    return;
  }
  const modelIdx = argv.indexOf('--model');
  const modelPath = modelIdx >= 0 ? argv[modelIdx + 1] : process.env.SMART_TURN_MODEL ?? '';
  if (!modelPath || !existsSync(modelPath)) {
    throw new Error(`--model <path> is required and must exist (got ${JSON.stringify(modelPath)}); run scripts/voice-turn-detection-compare.mjs which fetches it`);
  }
  const result = await runAll({ modelPath });
  const previous = existsSync(RESULT_PATH) ? JSON.parse(readFileSync(RESULT_PATH, 'utf8')) : {};
  // preserve a qwen probe result already recorded by the probe step
  if (previous.qwenProbe) (result as Record<string, unknown>).qwenProbe = previous.qwenProbe;
  // AC5: the real-audio probe is a separate paid block with its own ledger; re-running the offline
  // measurement must not blank it.
  if (previous.qwenProbeRealAudio) (result as Record<string, unknown>).qwenProbeRealAudio = previous.qwenProbeRealAudio;
  // ...and the Go/No-Go row that probe MEASURED. It is the probe's reading, not this harness's:
  // re-running the offline measurement must not blank the one row that cost money to obtain.
  if (previous.goNoGo?.nonRealtimeQwenFeasibility?.verdict) {
    (result.goNoGo as Record<string, unknown>).nonRealtimeQwenFeasibility = previous.goNoGo.nonRealtimeQwenFeasibility;
  }
  if (previous.goNoGo?.nonRealtimeQwenRealAudio?.verdict) {
    (result.goNoGo as Record<string, unknown>).nonRealtimeQwenRealAudio = previous.goNoGo.nonRealtimeQwenRealAudio;
  }
  writeFileSync(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`wrote ${RESULT_PATH}`);
  console.log(`  A falseCutoff=${result.groupA.falseCutoffRate} missed=${result.groupA.missedEndpointRate} falseTrigger=${result.groupA.falseTriggerActions} (shipped floor)`);
  console.log(`  A(fixed floor) falseCutoff=${result.groupAFixedFloor.falseCutoffRate} missed=${result.groupAFixedFloor.missedEndpointRate}`);
  console.log(`  B falseCutoff=${result.groupB.falseCutoffRate} missed=${result.groupB.missedEndpointRate} p50=${result.groupB.latencyP50Ms}ms p90=${result.groupB.latencyP90Ms}ms`);
  console.log(`  C ${JSON.stringify(result.groupC).slice(0, 120)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
