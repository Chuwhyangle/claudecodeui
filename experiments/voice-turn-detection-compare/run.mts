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
 *   C  LiveKit Turn Detector v1-mini — local CPU, but its weights are under the LiveKit Model
 *      License (not an OSI licence) and its exact input tensor is undocumented. This harness
 *      records what P0 could establish and, if it could not establish enough, a `blocked-…` /
 *      `deferred-…` status rather than a guessed number (adapter `adapters/livekit-v1-mini.mts`).
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
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { StreamingVad, thresholdsFor, FRAME_MS } from '../../src/shared/voiceEndpoint.ts';
import {
  createSmartTurnSession,
  decodeWav,
  predictEndpoint,
  type SmartTurnSession,
} from './adapters/smart-turn-v3.mts';
import { evaluateLiveKit } from './adapters/livekit-v1-mini.mts';

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

type Truth = 'END' | 'CONTINUE';
type Candidate = {
  /** The interrogation point: the first quiet frame after speech, in ms from the clip start. */
  onsetMs: number;
  onsetSample: number;
  /** Length of the silence that follows the onset; `null` at a turn end, where it runs to the clip edge. */
  pauseMs: number | null;
  truth: Truth;
  kind: 'within-turn-pause' | 'turn-end';
  note: string;
};
type Excluded = { atMs: number; durationMs: number; reason: string };
type Sample = {
  id: string;
  fixture: string;
  sha256: string;
  language: 'en' | 'zh';
  reference: string;
  durationSeconds: number;
  synthetic: boolean;
  candidatePoints: Candidate[];
  excludedPauses: Excluded[];
};

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

/** Build one labelled sample from a fixture, by the policy in the header. */
export function buildSample(fixture: string): Sample {
  const full = path.join(FIXTURES_DIR, fixture);
  const { sampleRate, samples } = decodeWav(full);
  const energies = frameEnergies(samples, sampleRate);
  const quiet = energies.map((e) => e < SILENCE_RMS);
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
    candidates.push({
      onsetMs: toMs(onsetSample),
      onsetSample,
      pauseMs: Math.round(durMs),
      truth: 'CONTINUE',
      kind: 'within-turn-pause',
      note: `${Math.round(durMs)} ms pause with speech after it in the same instruction ⇒ within-turn`,
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
    note: 'instruction completed (authored reference is one instruction) ⇒ turn end',
  });
  candidates.sort((a, b) => a.onsetSample - b.onsetSample);

  const transcripts = JSON.parse(readFileSync(TRANSCRIPTS_PATH, 'utf8'));
  const entry = transcripts.entries.find((e: { clip: string }) => e.clip === fixture);
  return {
    id: fixture.replace(/\.wav$/, ''),
    fixture,
    sha256: sha256File(full),
    language: fixture.startsWith('en') ? 'en' : 'zh',
    reference: entry?.reference ?? '',
    durationSeconds: Number((samples.length / sampleRate).toFixed(3)),
    synthetic: true, // the whole corpus is TTS-rendered (see transcripts.json provenance)
    candidatePoints: candidates,
    excludedPauses: excluded,
  };
}

export function buildManifest(): Record<string, unknown> {
  const samples = FIXTURE_ORDER.map(buildSample);
  return {
    schema: 'voice-turn-detection-compare/manifest@1',
    generatedAt: new Date().toISOString(),
    task: 'gap-voice-turn-detection-pluggable-comparison-p0',
    spec: 'docs/proposals/voice-turn-detection-pluggable-comparison-SPEC.md',
    provenance: {
      source: 'experiments/voice-trim/fixtures/ (8 clips, reused — the SPEC names this set)',
      nature:
        'TTS-rendered dictation corpus, occupancy-tiered (en-e01-o45/o65, zh-d*-o85/o65/o45). The ' +
        'authored reference is the text the TTS was given (transcripts.json), so the ground truth ' +
        'is by construction, not model-labelled. synthetic:true records the TTS provenance.',
      scenarioCoverage: {
        'code-term mixed zh/en': ['en-e01-o45', 'en-e01-o65', 'zh-d01-o85', 'zh-d02-o65'],
        'self-correction (嗯不对)': ['zh-d02-o65'],
        'mid-sentence filler pauses (嗯…那个…)': ['zh-d06-o65', 'zh-d13-o45'],
      },
    },
    annotationPolicy: {
      unit: 'candidate point = the ONSET of a silence run inside one instruction, where every detector is asked END/CONTINUE',
      onset: 'the first frame whose RMS < SILENCE_RMS after a speech frame; the interrogation point for every group',
      withinTurnPause: `a silence run of ${MIN_PAUSE_MS}–${MAX_NATURAL_PAUSE_MS} ms with speech after it ⇒ CONTINUE (the authored reference is a single instruction)`,
      turnEnd: 'the onset of the trailing silence (the frame after the last speech frame) ⇒ END',
      excluded: `silence runs > ${MAX_NATURAL_PAUSE_MS} ms are recorded under excludedPauses and NOT scored — occupancy-injected gaps are ambiguous ground truth`,
      detector: `silence = frame RMS < ${SILENCE_RMS}; 20 ms frames`,
      vadEndpointMs: VAD_ENDPOINT_MS,
      asymmetry:
        'the interrogation point is common but the reaction is not: StreamingVad can only answer after its own ' +
        `${VAD_ENDPOINT_MS} ms of silence (so a pause ≥ ${VAD_ENDPOINT_MS} ms is a commit to END before the speaker resumes), ` +
        'while Smart Turn answers at the onset from the content of the preceding 8 s',
    },
    sampleCount: samples.length,
    candidatePointCount: samples.reduce((n, s) => n + s.candidatePoints.length, 0),
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
  latencyP50Ms: number | null;
  latencyP90Ms: number | null;
  cpuMsPerDecision: number | null;
  ramDeltaMb: number | null;
  extraModelCostCny: number;
  readings: PointReading[];
};

export function metricsFor(group: string, detector: string, status: string, readings: PointReading[], cpu?: { cpuMs: number; ramMb: number }): GroupMetrics {
  let contTotal = 0;
  let falseCutoff = 0;
  let endTotal = 0;
  let missed = 0;
  const latencies: number[] = [];
  for (const r of readings) {
    if (r.truth === 'CONTINUE') {
      contTotal += 1;
      if (r.predicted === 'END') falseCutoff += 1;
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
    latencyP50Ms: latencies.length ? Number(percentile(latencies, 0.5).toFixed(2)) : null,
    latencyP90Ms: latencies.length ? Number(percentile(latencies, 0.9).toFixed(2)) : null,
    cpuMsPerDecision: cpu && decisions ? Number((cpu.cpuMs / decisions).toFixed(3)) : null,
    ramDeltaMb: cpu ? Number(cpu.ramMb.toFixed(1)) : null,
    extraModelCostCny: 0,
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
    const { sampleRate, samples: s } = decodeWav(path.join(FIXTURES_DIR, sample.fixture));
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
      candidatePoints: sample.candidatePoints.length,
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

  const livekit = evaluateLiveKit();

  const sampleCount = samples.length;
  const candidatePointCount = groupA.length;
  const sampleSizeCaveat = sampleCount < 20;
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
    sampleSize: {
      threshold: '≥ 20 labelled samples',
      measured: sampleCount,
      verdict: sampleSizeCaveat ? 'CAVEAT — preliminary/directional only' : 'PASS',
    },
  };

  return {
    schema: 'voice-turn-detection-compare/result@1',
    task: 'gap-voice-turn-detection-pluggable-comparison-p0',
    spec: 'docs/proposals/voice-turn-detection-pluggable-comparison-SPEC.md',
    ranAt: new Date().toISOString(),
    sampleSize: sampleCount,
    candidatePointCount,
    sampleSizeCaveat,
    sampleSizeCaveatReason: sampleSizeCaveat
      ? `${sampleCount} labelled samples (< 20): the 8 reused voice-trim fixtures are TTS clips covering the SPEC's inline scenarios (code-term mixing, self-correction, filler pauses) but there are not 20 independent human recordings. Conclusions are PRELIMINARY/DIRECTIONAL, not a final go/no-go. Real self-correction/code-term human recordings were not recorded in P0 (no TTS/human-voice authorization obtained here), so none were fabricated.`
      : null,
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
    latencyBreakdown,
    groupBSensitivity: {
      why:
        'the interrogation point is common but the reaction is not: A can only answer after its own ' +
        `${VAD_ENDPOINT_MS} ms of silence, B answers at the onset. Re-running B with the window ending at A's ` +
        'horizon separates "B wins because it was asked earlier" from "B wins because it read the content".',
      metrics: metricsBSens,
    },
    groupC: livekit,
    groupD: readGroupD(),
    perSample,
    goNoGo,
    methodology: [
      'candidate point = the ONSET of a silence run inside one instruction; every group answers the same points',
      'group A reuses the shipping StreamingVad at its 400 ms endpoint, floor read off the module; it commits 400 ms after the onset',
      'group B is asked AT the onset, from the 8 s window ending there (latency = one inference + preprocessing)',
      'group B runs the real smart-turn-v3.2-cpu ONNX with the upstream Whisper log-mel recipe, locally',
      'group C records the licence/input-spec evidence and a blocked/deferred status rather than a guessed number',
      'group D cites the sibling task reading; nothing was re-run or re-billed',
      'latency = wall-clock of one decision; CPU = process cpuUsage delta over the group-B loop; RAM = RSS delta',
    ],
    caveats: [
      'group A latency is its configured endpointMs by construction (400 ms), not a distribution: the VAD fires exactly that long after the onset, and never if the speaker resumes first — that constant is the incumbent’s whole cost model',
      'group B latency includes the harness’s JS log-mel preprocessing, not only the ONNX kernel — it is an end-to-end local decision cost, which is the number that matters for the realtime budget',
      'a Smart Turn window of synthetic silence scores 0.987 (measured on this build), so B is a strong END predictor once silence fills its window; that is WHY the primary interrogation point is the onset — asking B deeper into a pause measures the silence, not the semantics (the groupBSensitivity pass quantifies exactly that)',
      'the corpus is occupancy-tiered TTS; pauses > 1500 ms are excluded from scoring (see manifest.annotationPolicy)',
      'CPU increment is reported as batch CPU time per decision; the resident single-core share (≤10%) is not separable in a batch process',
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
  // ...and the Go/No-Go row that probe MEASURED. It is the probe's reading, not this harness's:
  // re-running the offline measurement must not blank the one row that cost money to obtain.
  if (previous.goNoGo?.nonRealtimeQwenFeasibility?.verdict) {
    (result.goNoGo as Record<string, unknown>).nonRealtimeQwenFeasibility = previous.goNoGo.nonRealtimeQwenFeasibility;
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
