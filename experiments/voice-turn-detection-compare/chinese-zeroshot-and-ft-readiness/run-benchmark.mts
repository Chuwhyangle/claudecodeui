/**
 * P0.14 — CHINESE zero-shot head-to-head: Pipecat Smart Turn v3.2 vs p99lab turn-1-mini, PLUS two
 * non-model baselines (the shipping VAD rule, and a pure fixed-wait timer), on the SAME Chinese
 * spans through the SAME eot-bench causal sweep P0.7/P0.11/P0.13 use.
 *
 * WHAT THIS ANSWERS. Two questions, both zero-training / zero-paid:
 *   1. Do the ORIGINAL (un-fine-tuned) Smart Turn v3.2 and turn-1-mini hold a pre-registered
 *      operating point on REAL Chinese speech (false cutoff <= 10% AND missed END <= 10%)?
 *   2. Does the model beat a model-free baseline — i.e. is there discriminative power beyond
 *      "the silence has lasted a while"?
 *
 * THE HARNESS IS REUSED, THE CORPUS IS NOT. The scoring/sweep semantics come from
 * `../eot-bench-adapters/protocol.mts` (the same module P0.7/P0.11/P0.13 use), the Smart Turn
 * front-end + ONNX session from `../adapters/smart-turn-v3.mts` +
 * `../adapters/smart-turn-compiled-features.mts`, and turn-1-mini runs through P0.13's OWN
 * `run-turn1mini.py` UNMODIFIED (it is driven with absolute WAV paths so its `os.path.join(here,
 * wav)` resolves them; nothing in P0.13's directory is written).
 *
 * WHAT IS DELIBERATELY DIFFERENT FROM P0.13 (each is an AC on this task):
 *   · AC3 degenerate rows: threshold <= 0.02 is dropped (P0.13 dropped only threshold == 0).
 *   · AC3 baselines: the two model-free rows above are swept through the same policy axis and
 *     reported as their own frontiers.
 *   · AC3 cross-model: the two models' `threshold` axes are NEVER compared numerically — each
 *     model's frontier is its OWN probability space; the comparison is between frontiers only.
 *   · AC4 held-out: a per-model operating point is SELECTED on one clip-disjoint half and the
 *     reported rates are measured on the OTHER (report) half — selection set != reporting set.
 *     The full-corpus numbers are shown too, but the verdict is read off the held-out half.
 *
 * Run (from anywhere; paths resolve from this file):
 *   node_modules/.bin/tsx --tsconfig server/tsconfig.json \
 *     experiments/voice-turn-detection-compare/chinese-zeroshot-and-ft-readiness/run-benchmark.mts
 * Flags: --no-python · --no-dense · --no-cache · --limit N (first N clips) · --evidence-only
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as ort from 'onnxruntime-web';

import {
  DEFAULT_ACTION_DELAYS,
  DEFAULT_THRESHOLDS,
  DEFAULT_TIMEOUTS,
  EPS,
  causalGrid,
  paretoFrontier,
  spanFire,
  sweepPolicies,
  wilson95,
  type GridPoint,
  type PolicyRow,
  type SpanFire,
} from '../eot-bench-adapters/protocol.mts';
import { compiledWhisperLogMel, loadCompiledFeatures } from '../adapters/smart-turn-compiled-features.mts';
import { createSmartTurnSession, decodeWav, truncateToLastSeconds, type SmartTurnSession } from '../adapters/smart-turn-v3.mts';
import { StreamingVad, thresholdsFor, FRAME_MS } from '../../../src/shared/voiceEndpoint.ts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const COMPARE_DIR = path.resolve(DIR, '..');
const REPO_ROOT = path.resolve(COMPARE_DIR, '..', '..');
const CORPUS_PATH = path.join(DIR, 'data', 'corpus.json');
const SPANS_T1M_PATH = path.join(DIR, 'data', 'spans-for-turn1mini.json');
const T1M_SCORES_PATH = path.join(DIR, 'data', 'turn1mini-scores.json');
const CACHE_DIR = path.join(DIR, '_cache');
const RESULT_PATH = path.join(DIR, 'RESULT.json');
const VENV_PYTHON = path.join(DIR, '.venv', 'bin', 'python');
const T1M_SCRIPT = path.join(COMPARE_DIR, 'english-smart-turn-vs-turn1mini', 'run-turn1mini.py');
const MODEL_SR = 16000;

const SMART_TURN_MODEL =
  process.env.SMART_TURN_MODEL ?? path.join(os.homedir(), '.cache', 'voice-turn-detection-compare', 'smart-turn-v3.2-cpu.onnx');

// ── grids, policies, budgets ─────────────────────────────────────────────────────────────────────
const PRIMARY_INTERVAL = 0.1;
const REFINED_INTERVAL = 0.02;

const linspace = (start: number, stop: number, step: number, decimals: number): number[] => {
  const n = Math.round((stop - start) / step);
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(Number((start + i * step).toFixed(decimals)));
  return out;
};

type PolicyGrid = { thresholds: number[]; actionDelays: number[]; timeouts: number[] };
const COARSE_POLICY: PolicyGrid = { thresholds: DEFAULT_THRESHOLDS, actionDelays: DEFAULT_ACTION_DELAYS, timeouts: DEFAULT_TIMEOUTS };
const DENSE_POLICY: PolicyGrid = {
  thresholds: linspace(0, 1, 0.01, 2),
  actionDelays: linspace(0.2, 1.0, 0.05, 2),
  timeouts: linspace(1.0, 3.5, 0.1, 2),
};

/** AC3: P0.13 dropped only threshold == 0; this task drops every threshold <= 0.02, so the near-
 *  degenerate corner (which fires on almost any cell) cannot lead the frontier either. */
const DEGENERATE_THRESHOLD_MAX = 0.02;
const isDegenerateThreshold = (t: number): boolean => t <= DEGENERATE_THRESHOLD_MAX + EPS;

const BUDGETS = { falseCutoff: 0.1, missedEnd: 0.1 } as const;
const HOLD_MIN_S = 0.2;
const HOLD_MAX_S = 5.0;

// ── provenance (pinned to P0.13 VERBATIM — the same checkpoints, not re-selected) ─────────────────
const PROVENANCE = {
  reuseNote:
    'checkpoint revisions, ONNX sha256, and the turn-1-mini preprocessing path are copied VERBATIM from P0.13 (english-smart-turn-vs-turn1mini) — no version was re-selected and nothing there was modified',
  smartTurn: {
    sourceRepo: 'pipecat-ai/smart-turn-v3',
    sourceRevision: 'f766f81d3cfdf7737ac64aad813d91bbfd56bf93',
    sourceFile: 'smart-turn-v3.2-cpu.onnx',
    sourceUrl:
      'https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/f766f81d3cfdf7737ac64aad813d91bbfd56bf93/smart-turn-v3.2-cpu.onnx',
    sourceBlobSha256: '2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f',
    sourceBlobBytes: 8679182,
    licence: 'BSD-2-Clause',
    licenceUrl: 'https://raw.githubusercontent.com/pipecat-ai/smart-turn/main/LICENSE',
  },
  turn1Mini: {
    repo: 'p99lab/turn-1-mini',
    revision: '076c86d1744a231d3a4cce31f3bbbd1211b4c281',
    onnxFile: 'turn-1-mini.step.onnx',
    onnxSha256: 'e747b182d685c7db489a3ea2e12bdcd65bac506fcddec00ed3cd0bf9f209fd11',
    safetensorsSha256: 'd03ccff872eb0ae2ed0366b1ea94d860328daa0122bf9003fb32b7a34b14acb9',
    p99turnVersion: '1.2.3',
    licence: 'Apache-2.0',
    licenceUrl: 'https://huggingface.co/p99lab/turn-1-mini/raw/076c86d1744a231d3a4cce31f3bbbd1211b4c281/LICENSE',
  },
} as const;

function sha256File(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

// ── flags ────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv;
const flagValue = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? '') : null;
};
const LIMIT = Math.max(0, Number(flagValue('--limit') ?? 0));
const NO_PYTHON = argv.includes('--no-python');
const NO_DENSE = argv.includes('--no-dense');
const NO_CACHE = argv.includes('--no-cache');
const EVIDENCE_ONLY = argv.includes('--evidence-only');
const INTERVALS = (flagValue('--intervals') ?? `${PRIMARY_INTERVAL},${REFINED_INTERVAL}`)
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

// ── the span model ───────────────────────────────────────────────────────────────────────────────
type CorpusId = string;
type P14Span = {
  key: string;
  corpus: CorpusId;
  group: string;
  /** Per-clip language tag where the corpus exposes one (ASCEND: zh | mixed); null otherwise. */
  language: string | null;
  id: string;
  spanIndex: number;
  label: 'eot' | 'hold';
  onsetMs: number;
  silenceMs: number;
  sampleRate: number;
  appendTailMs: number;
  clipMs: number;
  wav: string;
  audio: Float32Array; // clip PCM WITH the appended closing tail (for eot spans)
};

type CorpusDoc = {
  corpora: Array<{ id: string; nature: string; language: string; dataset?: string; groupKey?: string; licenceSpdx?: string; licenceUrl?: string }>;
  clips: Array<{ id: string; corpus: string; group: string; wav: string; sampleRate: number; transcript: string; nature: string; review?: unknown }>;
  spans: Array<{
    key: string;
    corpus: string;
    group: string;
    id: string;
    spanIndex: number;
    label: 'eot' | 'hold';
    onsetMs: number;
    silenceMs: number;
    wav: string;
    sampleRate: number;
    appendTailMs: number;
    clipMs: number;
  }>;
};

let CORPUS: CorpusDoc | null = null;
function corpusDoc(): CorpusDoc {
  if (CORPUS) return CORPUS;
  if (!existsSync(CORPUS_PATH)) throw new Error(`corpus missing: ${CORPUS_PATH} — run fetch-chinese-corpus.mjs`);
  CORPUS = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as CorpusDoc;
  return CORPUS;
}

let AUDIO_CACHE: Map<string, Float32Array> | null = null;
function clipAudio(wavRel: string, sampleRate: number): Float32Array {
  if (!AUDIO_CACHE) AUDIO_CACHE = new Map();
  const abs = path.isAbsolute(wavRel) ? wavRel : path.join(DIR, wavRel);
  let a = AUDIO_CACHE.get(abs);
  if (!a) {
    const d = decodeWav(abs);
    if (d.sampleRate !== sampleRate) throw new Error(`${abs}: ${d.sampleRate} Hz, expected ${sampleRate}`);
    a = d.samples;
    AUDIO_CACHE.set(abs, a);
  }
  return a;
}

function buildSpans(): P14Span[] {
  const doc = corpusDoc();
  const chosen = LIMIT > 0 ? new Set(doc.clips.slice(0, LIMIT).map((c) => c.id)) : null;
  // AC4 stratification: carry the per-clip language tag (ASCEND rows are labelled zh | en | mixed)
  // onto the span so the report can break error down by language stratum, not just by group.
  const clipLanguage = new Map(
    doc.clips.map((c) => [c.id, ((c.review as { language?: string } | undefined)?.language ?? null) as string | null]),
  );
  const out: P14Span[] = [];
  for (const s of doc.spans) {
    if (chosen && !chosen.has(s.id)) continue;
    const clip = clipAudio(s.wav, s.sampleRate);
    const tail = s.appendTailMs > 0 ? Math.round((s.appendTailMs / 1000) * s.sampleRate) : 0;
    const audio = tail > 0 ? new Float32Array([...clip, ...new Float32Array(tail)]) : clip;
    out.push({
      key: s.key,
      corpus: s.corpus,
      group: s.group,
      language: clipLanguage.get(s.id) ?? null,
      id: s.id,
      spanIndex: s.spanIndex,
      label: s.label,
      onsetMs: s.onsetMs,
      silenceMs: s.silenceMs,
      sampleRate: s.sampleRate,
      appendTailMs: s.appendTailMs,
      clipMs: s.clipMs,
      wav: s.wav,
      audio,
    });
  }
  return out;
}

// ── cell geometry (shared) ───────────────────────────────────────────────────────────────────────
const prefixSamples = (timestampMs: number, sampleRate: number): number => Math.floor((timestampMs * sampleRate) / 1000);
const t1mFrameIndex = (E: number): number => Math.floor(E / 320) - 1;

function spanGrid(span: P14Span, interval: number): GridPoint[] {
  return causalGrid(
    { sampleId: span.id, spanIndex: span.spanIndex, onsetMs: span.onsetMs, silenceMs: span.silenceMs, truth: span.label === 'eot' ? 'END' : 'CONTINUE', label: span.label, scenario: '' },
    { inferenceIntervalSeconds: interval, maxSilenceSeconds: Number.POSITIVE_INFINITY },
  );
}

// ── ScoreTables: per-span causal scores over the grid ────────────────────────────────────────────
type CellTable = { grid: GridPoint[]; scores: number[] };
type ScoreTables = Map<string, CellTable>;
type CompiledAddon = NonNullable<ReturnType<typeof loadCompiledFeatures>['addon']>;

const cacheFile = (tag: string): string => path.join(CACHE_DIR, `scores-${tag.replace(/[^\w.-]+/g, '_')}.json`);
function readCache(file: string, expectedCells: number): Map<string, number[]> | null {
  if (!existsSync(file) || NO_CACHE) return null;
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { cells: number; scores: Record<string, number[]> };
  if (raw.cells !== expectedCells) return null;
  return new Map(Object.entries(raw.scores));
}
function writeCache(file: string, cells: number, scores: Map<string, number[]>): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify({ cells, scores: Object.fromEntries(scores) }));
}

async function runSmartTurnCell(
  session: SmartTurnSession,
  addon: CompiledAddon,
  prefix: Float32Array,
): Promise<{ probability: number; featureMs: number; inferenceMs: number }> {
  const windowed = truncateToLastSeconds(prefix, 8, MODEL_SR);
  const tf0 = process.hrtime.bigint();
  const feats = compiledWhisperLogMel(addon, windowed);
  const tf1 = process.hrtime.bigint();
  const out = await session.run({ input_features: new ort.Tensor('float32', feats, [1, 80, 800]) });
  const ti1 = process.hrtime.bigint();
  const raw = (Object.values(out)[0] as { data: Float32Array }).data;
  return { probability: raw[0], featureMs: Number(tf1 - tf0) / 1e6, inferenceMs: Number(ti1 - tf1) / 1e6 };
}

async function scoreSmartTurn(
  spans: P14Span[],
  interval: number,
  session: SmartTurnSession,
  addon: CompiledAddon,
): Promise<{ tables: ScoreTables; cells: number; featureMs: number[]; inferenceMs: number[]; fromCache: boolean }> {
  const grids = new Map<string, GridPoint[]>();
  const items: Array<{ key: string; prefix: Float32Array }> = [];
  let cells = 0;
  for (const s of spans) {
    const grid = spanGrid(s, interval);
    grids.set(s.key, grid);
    for (const cell of grid) {
      items.push({ key: s.key, prefix: s.audio.subarray(0, Math.min(s.audio.length, prefixSamples(cell.timestampMs, s.sampleRate))) });
      cells += 1;
    }
  }
  const file = cacheFile(`smart-turn-${interval}${LIMIT ? `-limit${LIMIT}` : ''}`);
  const cached = readCache(file, cells);
  const assemble = (byKey: Map<string, number[]>): ScoreTables => {
    const tables: ScoreTables = new Map();
    for (const [key, grid] of grids) tables.set(key, { grid, scores: byKey.get(key) ?? [] });
    return tables;
  };
  if (cached !== null) return { tables: assemble(cached), cells, featureMs: [], inferenceMs: [], fromCache: true };
  if (items.length === 0) return { tables: new Map(), cells: 0, featureMs: [], inferenceMs: [], fromCache: false };
  await runSmartTurnCell(session, addon, items[0].prefix);
  const byKey = new Map<string, number[]>();
  const featureMs: number[] = [];
  const inferenceMs: number[] = [];
  for (const item of items) {
    const r = await runSmartTurnCell(session, addon, item.prefix);
    const acc = byKey.get(item.key);
    if (acc) acc.push(r.probability);
    else byKey.set(item.key, [r.probability]);
    featureMs.push(r.featureMs);
    inferenceMs.push(r.inferenceMs);
  }
  writeCache(file, cells, byKey);
  return { tables: assemble(byKey), cells, featureMs, inferenceMs, fromCache: false };
}

function sliceTurn1Mini(span: P14Span, grid: GridPoint[], frameProbs: number[]): number[] {
  return grid.map((cell) => {
    const j = t1mFrameIndex(prefixSamples(cell.timestampMs, span.sampleRate));
    return j >= 0 && j < frameProbs.length ? frameProbs[j] : 0;
  });
}

// ── model-free baselines (AC3) ───────────────────────────────────────────────────────────────────
//
// Both are expressed as a per-span FIRE TIME (seconds of silence at which the rule commits), so they
// run through the SAME `sweepPolicies` the models do — the comparison is apples to apples.
//
//  · fixed-wait: a pure timer. It commits at exactly W seconds of silence, no audio used at all.
//  · vad: the SHIPPING rule. `StreamingVad` + `thresholdsFor` from `src/shared/voiceEndpoint.ts`
//    are driven over the span's own causal prefix; the commit is the first frame whose run of
//    below-threshold frames reaches the endpoint. This is the incumbent the models must beat.

function fixedWaitFires(spans: P14Span[], W: number): SpanFire[] {
  return spans.map((s) => ({
    key: s.key,
    label: s.label,
    silenceSeconds: s.silenceMs / 1000,
    fireSeconds: s.silenceMs / 1000 + EPS >= W ? W : Number.POSITIVE_INFINITY,
  }));
}

/** Frame RMS energy of a prefix (20 ms frames), matching the corpus frame grid. */
function frameEnergies(samples: Float32Array, rate: number, frame: number): number[] {
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
 * The shipping VAD's commit as a FIRE TIME (seconds of silence after the span's onset), for one span
 * and one endpoint setting. The scan is `vad-batch-adapter.mts`'s `vadCommitFrame` verbatim except
 * that `endpointMs` is a parameter instead of the adapter's fixed 400 ms — so the baseline can be
 * swept over its own single knob (its "threshold axis" is a DURATION, not a p_eot level).
 *
 * Scanning from the span's own onset is not an optimisation: a prefix for a `hold` span contains
 * every EARLIER pause of the same clip, and the first quiet run in it belongs to whichever pause
 * came first. Committing before this span's onset is therefore not this span's fire.
 */
function vadFireSeconds(span: P14Span, endpointMs: number): number {
  const rate = span.sampleRate;
  const frame = Math.max(1, Math.round((FRAME_MS / 1000) * rate));
  const onsetFrame = Math.floor(((span.onsetMs / 1000) * rate) / frame);
  const energies = frameEnergies(span.audio, rate, frame);
  const vad = new StreamingVad({ sampleRate: rate });
  const quiet: boolean[] = [];
  for (let i = 0; i < energies.length; i++) {
    vad.pushFrameEnergy(energies[i]);
    quiet.push(energies[i] < thresholdsFor(vad.noiseFloor).enter);
  }
  const forward = new Int32Array(quiet.length + 1);
  for (let i = quiet.length - 1; i >= 0; i--) forward[i] = quiet[i] ? forward[i + 1] + 1 : 0;
  const endpointFrames = Math.max(1, Math.round(((endpointMs / 1000) * rate) / frame));
  const framesAvailable = Math.floor(span.audio.length / frame);
  const from = Math.min(quiet.length, Math.max(0, onsetFrame));
  for (let j = from; j < quiet.length; j++) {
    if (forward[j] >= endpointFrames) {
      const commitFrame = j + endpointFrames;
      if (commitFrame <= framesAvailable) return ((commitFrame - onsetFrame) * FRAME_MS) / 1000;
      return Number.POSITIVE_INFINITY;
    }
  }
  return Number.POSITIVE_INFINITY;
}

function vadFires(spans: P14Span[], endpointMs: number): SpanFire[] {
  return spans.map((s) => ({
    key: s.key,
    label: s.label,
    silenceSeconds: s.silenceMs / 1000,
    fireSeconds: vadFireSeconds(s, endpointMs),
  }));
}

// ── sweep helpers ────────────────────────────────────────────────────────────────────────────────
function firesFromScores(spans: P14Span[], tables: ScoreTables, threshold: number): SpanFire[] {
  return spans.map((span) => {
    const t = tables.get(span.key);
    const { fireSeconds } = spanFire(t?.grid ?? [], t?.scores ?? [], threshold);
    return { key: span.key, label: span.label, silenceSeconds: span.silenceMs / 1000, fireSeconds };
  });
}

/** Sweep a model's score tables over threshold × actionDelay × timeout. */
function sweepModelGrid(spans: P14Span[], tables: ScoreTables, policy: PolicyGrid): PolicyRow[] {
  const rows: PolicyRow[] = [];
  for (const threshold of policy.thresholds) {
    rows.push(...sweepPolicies(firesFromScores(spans, tables, threshold), { thresholds: [threshold], actionDelays: policy.actionDelays, timeouts: policy.timeouts }));
  }
  return rows;
}

/** Sweep a baseline's fire table over its own knob × actionDelay × timeout. `knob` becomes the row's
 *  `threshold` LABEL only — for a baseline that value is a duration in seconds, never a p_eot
 *  threshold, and the report keeps the label honest by naming it `knob` in the baseline block. */
function sweepBaselineGrid(spans: P14Span[], firesFor: (w: number) => SpanFire[], knobs: number[], actionDelays: number[], timeouts: number[]): PolicyRow[] {
  const rows: PolicyRow[] = [];
  for (const w of knobs) rows.push(...sweepPolicies(firesFor(w), { thresholds: [w], actionDelays, timeouts }));
  return rows;
}

function compact(row: PolicyRow): Record<string, unknown> {
  const cutoffCount = Math.round(row.cutoffRate * row.holdSpans);
  const missedCount = Math.round(row.missedEndpointRate * row.eotSpans);
  return {
    threshold: row.threshold,
    actionDelaySeconds: row.actionDelaySeconds,
    timeoutSeconds: row.timeoutSeconds,
    falseCutoff: { k: cutoffCount, n: row.holdSpans, rate: row.cutoffRate, ci95: wilson95(cutoffCount, row.holdSpans) },
    missedEnd: { k: missedCount, n: row.eotSpans, rate: row.missedEndpointRate, ci95: wilson95(missedCount, row.eotSpans) },
    meanLatencySeconds: row.meanLatencySeconds,
    f1: row.f1,
  };
}

function metricsAt(row: PolicyRow, spans: P14Span[], fireFn: (s: P14Span) => SpanFire): Record<string, unknown> {
  const fires = spans.map(fireFn);
  const waits: number[] = [];
  let cutoff = 0;
  let holds = 0;
  let missed = 0;
  let eots = 0;
  for (const f of fires) {
    if (f.label === 'hold') {
      holds += 1;
      const fired = f.fireSeconds < Number.POSITIVE_INFINITY;
      const modelCutoff = fired && f.silenceSeconds > Math.max(row.actionDelaySeconds, f.fireSeconds) + EPS;
      if (modelCutoff || f.silenceSeconds > row.timeoutSeconds + EPS) cutoff += 1;
    } else {
      eots += 1;
      const detected = f.fireSeconds < Number.POSITIVE_INFINITY && f.fireSeconds <= row.timeoutSeconds + EPS;
      if (detected) waits.push(f.fireSeconds);
      else {
        missed += 1;
        waits.push(row.timeoutSeconds);
      }
    }
  }
  waits.sort((a, b) => a - b);
  const qp = (p: number): number | null =>
    waits.length === 0 ? null : Number(waits[Math.min(waits.length - 1, Math.max(0, Math.ceil(p * waits.length) - 1))].toFixed(4));
  return {
    threshold: row.threshold,
    actionDelaySeconds: row.actionDelaySeconds,
    timeoutSeconds: row.timeoutSeconds,
    falseCutoff: { k: cutoff, n: holds, rate: holds ? Number((cutoff / holds).toFixed(6)) : 0, ci95: wilson95(cutoff, holds) },
    missedEnd: { k: missed, n: eots, rate: eots ? Number((missed / eots).toFixed(6)) : 0, ci95: wilson95(missed, eots) },
    eotWaitSeconds: {
      p50: qp(0.5),
      p90: qp(0.9),
      max: waits.length ? Number(waits[waits.length - 1].toFixed(4)) : null,
      mean: waits.length ? Number((waits.reduce((a, b) => a + b, 0) / waits.length).toFixed(4)) : null,
    },
  };
}

/** The operating point the verdict is read at: within BOTH budgets, lowest mean latency; else the
 *  closest. Degenerate (<= 0.02) rows are skipped for the MODELS (AC3); `skipDegenerate` is false
 *  for the baselines, whose knob is a duration, not a p_eot threshold. */
function gateRow(rows: PolicyRow[], skipDegenerate: boolean): { row: PolicyRow | null; satisfiesBoth: boolean; closestFactor: number | null; satisfyingCount: number } {
  let both: PolicyRow | null = null;
  let closest: PolicyRow | null = null;
  let closestScore = Number.POSITIVE_INFINITY;
  let satisfyingCount = 0;
  for (const r of rows) {
    if (skipDegenerate && isDegenerateThreshold(r.threshold)) continue;
    if (r.cutoffRate <= BUDGETS.falseCutoff + EPS && r.missedEndpointRate <= BUDGETS.missedEnd + EPS) {
      satisfyingCount += 1;
      if (both === null || r.meanLatencySeconds < both.meanLatencySeconds) both = r;
    }
    const s = Math.max(r.cutoffRate / BUDGETS.falseCutoff, r.missedEndpointRate / BUDGETS.missedEnd);
    if (s < closestScore) {
      closestScore = s;
      closest = r;
    }
  }
  if (both) return { row: both, satisfiesBoth: true, closestFactor: 1, satisfyingCount };
  return { row: closest, satisfiesBoth: false, closestFactor: closest ? Number(closestScore.toFixed(3)) : null, satisfyingCount };
}

/** Break a policy's error down by an arbitrary stratum. `keyOf` selects the stratum key; the caller
 *  supplies the note because "one group" means a session for ASCEND and a clip for THCHS-30 — the
 *  earlier hard-coded note wrongly claimed "group = clip" in every view. */
function groupDistribution(
  row: PolicyRow,
  spans: P14Span[],
  fireFn: (s: P14Span) => SpanFire,
  keyOf: (s: P14Span) => string = (s) => s.group,
  note = '',
): Record<string, unknown> {
  const spanByKey = new Map(spans.map((s) => [s.key, s]));
  const perGroup = new Map<string, { holds: number; cutoffs: number; eots: number; missed: number }>();
  const bump = (g: string): { holds: number; cutoffs: number; eots: number; missed: number } => {
    let v = perGroup.get(g);
    if (!v) {
      v = { holds: 0, cutoffs: 0, eots: 0, missed: 0 };
      perGroup.set(g, v);
    }
    return v;
  };
  for (const f of spans.map(fireFn)) {
    const span = spanByKey.get(f.key);
    const v = bump(span ? keyOf(span) : '?');
    if (f.label === 'hold') {
      v.holds += 1;
      const fired = f.fireSeconds < Number.POSITIVE_INFINITY;
      const modelCutoff = fired && f.silenceSeconds > Math.max(row.actionDelaySeconds, f.fireSeconds) + EPS;
      if (modelCutoff || f.silenceSeconds > row.timeoutSeconds + EPS) v.cutoffs += 1;
    } else {
      v.eots += 1;
      const detected = f.fireSeconds < Number.POSITIVE_INFINITY && f.fireSeconds <= row.timeoutSeconds + EPS;
      if (!detected) v.missed += 1;
    }
  }
  const groups = [...perGroup.entries()].map(([group, v]) => ({ group, ...v }));
  const totalCutoff = groups.reduce((a, g) => a + g.cutoffs, 0);
  const totalMissed = groups.reduce((a, g) => a + g.missed, 0);
  const sortedByCutoff = [...groups].sort((a, b) => b.cutoffs - a.cutoffs || b.missed - a.missed);
  const decile = Math.max(1, Math.ceil(groups.length / 10));
  const topDecileCutoff = sortedByCutoff.slice(0, decile).reduce((a, g) => a + g.cutoffs, 0);
  const topDecileMissed = [...groups].sort((a, b) => b.missed - a.missed).slice(0, decile).reduce((a, g) => a + g.missed, 0);
  return {
    groups: groups.length,
    groupsWithHoldErrors: groups.filter((g) => g.cutoffs > 0).length,
    groupsWithMissedEnd: groups.filter((g) => g.missed > 0).length,
    worstGroupCutoffShare: totalCutoff ? Number(((sortedByCutoff[0]?.cutoffs ?? 0) / totalCutoff).toFixed(4)) : null,
    topDecileCutoffShare: totalCutoff ? Number((topDecileCutoff / totalCutoff).toFixed(4)) : null,
    topDecileMissedShare: totalMissed ? Number((topDecileMissed / totalMissed).toFixed(4)) : null,
    note,
  };
}

/** Stratum = the per-clip language tag (ASCEND: zh | mixed). Null when no span in the view carries
 *  one (the scripted corpus has no language field), so a null here means "not applicable", not
 *  "measured and empty". */
function languageDistribution(
  row: PolicyRow,
  spans: P14Span[],
  fireFn: (s: P14Span) => SpanFire,
): Record<string, unknown> | null {
  if (!spans.some((s) => s.language)) return null;
  return groupDistribution(
    row,
    spans,
    fireFn,
    (s) => s.language ?? 'unlabelled',
    'one stratum = one language tag as labelled by the corpus (ASCEND rows are zh | mixed; "mixed" means the clip CODE-SWITCHES, so it still contains Mandarin)',
  );
}

function denominator(spans: P14Span[]): { kept: P14Span[]; droppedHolds: number } {
  const kept = spans.filter((s) => s.label === 'eot' || (s.silenceMs / 1000 >= HOLD_MIN_S - EPS && s.silenceMs / 1000 <= HOLD_MAX_S + EPS));
  return { kept, droppedHolds: spans.length - kept.length };
}

// ── evidence blocks (AC1/AC6) ───────────────────────────────────────────────────────────────────
function isolationEvidence(): Record<string, unknown> {
  const buildFiles = ['package.json', 'server/package.json', 'tsconfig.json', 'server/tsconfig.json', 'scripts/tsconfig.json', 'client/tsconfig.json', 'vite.config.js', 'vite.config.ts', 'vite.config.mts', 'scripts/test.sh'];
  const markers = ['chinese-zeroshot-and-ft-readiness', 'P0.14', 'p0-14'];
  const hits: Array<{ file: string; marker: string; line: number }> = [];
  const scanned: string[] = [];
  for (const rel of buildFiles) {
    const abs = path.join(REPO_ROOT, rel);
    if (!existsSync(abs)) continue;
    scanned.push(rel);
    const lines = readFileSync(abs, 'utf8').split('\n');
    for (const m of markers) for (let i = 0; i < lines.length; i++) if (lines[i].includes(m)) hits.push({ file: rel, marker: m, line: i + 1 });
  }
  return {
    claim: 'the P0.14 environment and harness are reachable from NO build/typecheck/test config',
    buildFilesScanned: scanned,
    markersSearched: markers,
    hits,
    clean: hits.length === 0,
  };
}

function paidCallEvidence(): Record<string, unknown> {
  const files = ['run-benchmark.mts', 'fetch-chinese-corpus.mjs'].map((f) => path.join(DIR, f)).filter(existsSync);
  const markers = [['dash', 'scope'], ['aliyun', 'cs'], ['open', 'ai'], ['wss', '://'], ['axi', 'os']].map((p) => p.join(''));
  const scans = files.map((f) => {
    const text = readFileSync(f, 'utf8');
    const lines = text.split('\n');
    const found: Array<{ marker: string; line: number; snippet: string; inComment: boolean }> = [];
    for (const m of markers) for (let i = 0; i < lines.length; i++) if (lines[i].toLowerCase().includes(m.toLowerCase())) found.push({ marker: m, line: i + 1, snippet: lines[i].trim().slice(0, 110), inComment: /^\s*(\/\/|\*|\/\*|#)/.test(lines[i]) });
    const urlHosts = [...new Set(Array.from(text.matchAll(/https?:\/\/([^/'"\s]+)/g)).map((m) => m[1]))];
    return { file: path.relative(REPO_ROOT, f), markers: found, urlHosts };
  });
  return {
    claim: 'zero paid / realtime / Omni API calls; the only network egress is the public HF eot-bench/model pull',
    filesScanned: scans,
    thisTaskNewSpendCny: 0,
  };
}

function productionDiffEvidence(): Record<string, unknown> {
  const paths = ['server/modules/voice-realtime/', 'src/modules/chat/voice-realtime/'];
  const git = (a: string[]): string => {
    try {
      return execFileSync('git', ['-C', REPO_ROOT, ...a], { encoding: 'utf8' }).trim();
    } catch (err) {
      return `<<git failed: ${(err as Error).message}>>`;
    }
  };
  const mergeBase = git(['merge-base', 'HEAD', 'develop']);
  const own = git(['diff', '--name-only', mergeBase, '--', ...paths]);
  const tip = git(['diff', '--name-only', 'develop', '--', ...paths]);
  const behind = Number(git(['rev-list', '--count', 'HEAD..develop']));
  return {
    claim: "this branch's OWN delta touches no production Live Voice path (AC6)",
    command: `git diff --name-only $(git merge-base HEAD develop) -- ${paths.join(' ')}`,
    mergeBase,
    changedPaths: own === '' ? [] : own.split('\n'),
    empty: own === '',
    vsDevelopTip: {
      command: `git diff --name-only develop -- ${paths.join(' ')}`,
      changedPaths: tip === '' ? [] : tip.split('\n'),
      empty: tip === '',
      note: tip === '' ? 'empty' : `non-empty only because this branch is ${Number.isFinite(behind) ? behind : '?'} commit(s) behind develop: develop's own advance, not this task's edit`,
    },
    behindDevelopCommits: Number.isFinite(behind) ? behind : null,
  };
}

/** AC2/AC6: prove the P0.13 delivered artifacts were NOT modified by this branch. */
function p013UntouchedEvidence(): Record<string, unknown> {
  const p013 = 'experiments/voice-turn-detection-compare/english-smart-turn-vs-turn1mini';
  const git = (a: string[]): string => {
    try {
      return execFileSync('git', ['-C', REPO_ROOT, ...a], { encoding: 'utf8' }).trim();
    } catch (err) {
      return `<<git failed: ${(err as Error).message}>>`;
    }
  };
  const mergeBase = git(['merge-base', 'HEAD', 'develop']);
  const changed = git(['diff', '--name-only', mergeBase, '--', p013]);
  return {
    claim: 'P0.13 delivered artifacts are untouched by this branch',
    path: p013,
    command: `git diff --name-only $(git merge-base HEAD develop) -- ${p013}`,
    changedPaths: changed === '' ? [] : changed.split('\n'),
    empty: changed === '',
  };
}

// ── run ──────────────────────────────────────────────────────────────────────────────────────────
type View = { id: string; label: string; spans: P14Span[] };
type ModelSpec =
  | { id: string; kind: 'ml'; skipDegenerate: boolean; rows: (spans: P14Span[], iv: number) => PolicyRow[] }
  | { id: string; kind: 'baseline'; skipDegenerate: boolean; rows: (spans: P14Span[], iv: number) => PolicyRow[] };

const quantile = (a: number[], p: number): number | null =>
  a.length ? Number([...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.ceil(p * a.length) - 1)].toFixed(4)) : null;

/** Split clips into a SELECTION half and a REPORT half, disjoint by clip (group) so no clip leaks
 *  across the split. Deterministic: a stable hash of the clip id decides the side. */
function splitSpans(spans: P14Span[]): { selection: P14Span[]; report: P14Span[] } {
  const side = (id: string): 'selection' | 'report' => {
    const h = createHash('sha256').update(id).digest();
    return h[0] % 2 === 0 ? 'selection' : 'report';
  };
  return {
    selection: spans.filter((s) => side(s.id) === 'selection'),
    report: spans.filter((s) => side(s.id) === 'report'),
  };
}

async function main(): Promise<void> {
  const t0 = Date.now();
  if (EVIDENCE_ONLY) {
    const cur = JSON.parse(readFileSync(RESULT_PATH, 'utf8')) as Record<string, unknown>;
    const patched = {
      ...cur,
      isolationEvidence: isolationEvidence(),
      paidCallEvidence: paidCallEvidence(),
      productionDiffEvidence: productionDiffEvidence(),
      p013UntouchedEvidence: p013UntouchedEvidence(),
      evidenceRefreshedAt: new Date().toISOString(),
    };
    writeFileSync(RESULT_PATH, `${JSON.stringify(patched, null, 2)}\n`);
    console.log(`refreshed evidence in ${RESULT_PATH}`);
    return;
  }
  mkdirSync(path.join(DIR, 'data'), { recursive: true });

  const doc = corpusDoc();
  const all = buildSpans();
  console.log(`spans=${all.length} clips=${new Set(all.map((s) => s.id)).size} intervals=[${INTERVALS.join(', ')}]${LIMIT ? ` limit=${LIMIT}` : ''}`);

  // ── turn-1-mini (P0.13's OWN script, unmodified, driven with absolute paths) ─────────────────────
  let t1mReport: Record<string, unknown> | null = null;
  const t1mFrames = new Map<string, number[]>();
  const t1mSha = existsSync(SMART_TURN_MODEL) ? sha256File(SMART_TURN_MODEL) : null;
  if (!NO_PYTHON) {
    if (!existsSync(T1M_SCRIPT)) throw new Error(`turn-1-mini script missing: ${T1M_SCRIPT}`);
    if (!existsSync(VENV_PYTHON)) throw new Error(`venv python missing: ${VENV_PYTHON} — run setup-venv.sh`);
    writeFileSync(
      SPANS_T1M_PATH,
      JSON.stringify({
        corpora: doc.corpora,
        rule: 'cell prefix ends at sample E=floor(tsMs*sr/1000); turn-1-mini frame index j=floor(E/320)-1',
        spans: all.map((s) => ({
          key: s.key,
          corpus: s.corpus,
          group: s.group,
          id: s.id,
          spanIndex: s.spanIndex,
          label: s.label,
          onsetMs: s.onsetMs,
          silenceMs: s.silenceMs,
          wav: path.isAbsolute(s.wav) ? s.wav : path.join(DIR, s.wav),
          sampleRate: s.sampleRate,
          appendTailMs: s.appendTailMs,
          clipMs: s.clipMs,
        })),
      }),
    );
    const selfcheckWav = path.join(DIR, all[0]?.wav ?? '');
    console.log('running turn-1-mini (P0.13 run-turn1mini.py, official ONNX streaming) …');
    execFileSync(VENV_PYTHON, ['-I', T1M_SCRIPT, '--spans', SPANS_T1M_PATH, '--out', T1M_SCORES_PATH, '--selfcheck-wav', selfcheckWav], {
      stdio: 'inherit',
      cwd: REPO_ROOT,
      env: { ...process.env, HF_HOME: path.join(DIR, 'data', 'hf') },
    });
    if (!existsSync(T1M_SCORES_PATH)) throw new Error(`run-turn1mini.py exited without writing ${T1M_SCORES_PATH}`);
    t1mReport = JSON.parse(readFileSync(T1M_SCORES_PATH, 'utf8')) as Record<string, unknown>;
    const gotKeys = new Set((t1mReport.spans as Array<{ key: string }>).map((s) => s.key));
    const missing = all.filter((s) => !gotKeys.has(s.key)).map((s) => s.key);
    if (missing.length > 0) throw new Error(`turn-1-mini scores stale: ${missing.length}/${all.length} keys absent (first ${missing[0]})`);
    for (const s of t1mReport.spans as Array<{ key: string; frameProbs: number[] }>) t1mFrames.set(s.key, s.frameProbs);
  }

  // ── Smart Turn (local ONNX, compiled mel) ────────────────────────────────────────────────────────
  if (!existsSync(SMART_TURN_MODEL)) throw new Error(`Smart Turn model missing at ${SMART_TURN_MODEL} (set SMART_TURN_MODEL)`);
  const { addon, buildNote, error } = loadCompiledFeatures();
  if (!addon) throw new Error(`compiled mel front-end unavailable: ${buildNote} ${error ?? ''}`);
  const session = await createSmartTurnSession(SMART_TURN_MODEL, 1);

  const st: Record<string, { tables: ScoreTables; cells: number; featureMs: number[]; inferenceMs: number[]; fromCache: boolean }> = {};
  for (const iv of INTERVALS) {
    console.log(`Smart Turn @ ${iv}s …`);
    st[String(iv)] = await scoreSmartTurn(all, iv, session, addon);
    console.log(`  cells=${st[String(iv)].cells} cached=${st[String(iv)].fromCache}`);
  }

  const t1mTablesFor = (iv: number): ScoreTables => {
    const out: ScoreTables = new Map();
    for (const s of all) {
      const grid = st[String(iv)].tables.get(s.key)?.grid ?? [];
      out.set(s.key, { grid, scores: sliceTurn1Mini(s, grid, t1mFrames.get(s.key) ?? []) });
    }
    return out;
  };

  const models: ModelSpec[] = [
    { id: 'smart-turn-v3.2', kind: 'ml', skipDegenerate: true, rows: (spans, iv) => sweepModelGrid(spans, st[String(iv)].tables, COARSE_POLICY) },
    { id: 'turn-1-mini', kind: 'ml', skipDegenerate: true, rows: (spans, iv) => sweepModelGrid(spans, t1mTablesFor(iv), COARSE_POLICY) },
    { id: 'vad-shipping-rule', kind: 'baseline', skipDegenerate: false, rows: (spans) => sweepBaselineGrid(spans, (w) => vadFires(spans, w), VAD_ENDPOINTS_MS, DEFAULT_ACTION_DELAYS, DEFAULT_TIMEOUTS) },
    { id: 'fixed-wait-timer', kind: 'baseline', skipDegenerate: false, rows: (spans) => sweepBaselineGrid(spans, (w) => fixedWaitFires(spans, w), FIXED_WAITS_S, DEFAULT_ACTION_DELAYS, DEFAULT_TIMEOUTS) },
  ];

  const views: View[] = [];
  for (const c of doc.corpora) views.push({ id: c.id, label: `${c.id} (${c.nature})`, spans: all.filter((s) => s.corpus === c.id) });
  if (doc.corpora.length > 1) views.push({ id: 'merged', label: 'all Chinese corpora merged', spans: all });

  const analysis: Record<string, unknown> = {};
  for (const model of models) {
    const perInterval: Record<string, unknown> = {};
    for (const iv of INTERVALS) {
      const perView: Record<string, unknown> = {};
      for (const view of views) {
        const { kept, droppedHolds } = denominator(view.spans);
        if (kept.filter((s) => s.label === 'eot').length === 0) continue;
        const fireFnAt = (row: PolicyRow): ((s: P14Span) => SpanFire) => {
          if (model.id === 'smart-turn-v3.2') return (s) => firesFromScores([s], st[String(iv)].tables, row.threshold)[0];
          if (model.id === 'turn-1-mini') return (s) => firesFromScores([s], t1mTablesFor(iv), row.threshold)[0];
          if (model.id === 'vad-shipping-rule') return (s) => vadFires([s], row.threshold)[0];
          return (s) => fixedWaitFires([s], row.threshold)[0];
        };
        const rows = model.rows(kept, iv);
        const { selection, report } = splitSpans(kept);
        // AC4: SELECT on the selection split, REPORT on the disjoint report split.
        const selRows = model.rows(selection, iv);
        const gateSel = gateRow(selRows, model.skipDegenerate);
        const heldOut =
          gateSel.row === null
            ? { selectedOn: 'selection', reportAvailable: false }
            : {
                selectedOn: 'selection',
                selectedPoint: { threshold: gateSel.row.threshold, actionDelaySeconds: gateSel.row.actionDelaySeconds, timeoutSeconds: gateSel.row.timeoutSeconds },
                reportMetrics: metricsAt(gateSel.row, report, fireFnAt(gateSel.row)),
                reportDenominator: { spans: report.length, holds: report.filter((s) => s.label === 'hold').length, eots: report.filter((s) => s.label === 'eot').length },
              };
        const gateFull = gateRow(rows, model.skipDegenerate);
        const frontier = paretoFrontier(rows.filter((r) => (model.skipDegenerate ? !isDegenerateThreshold(r.threshold) : true))).map(compact);
        perView[view.id] = {
          denominator: { spans: kept.length, holds: kept.filter((s) => s.label === 'hold').length, eots: kept.filter((s) => s.label === 'eot').length, droppedHolds },
          splitSizes: { selectionSpans: selection.length, reportSpans: report.length },
          heldOutVerdict: heldOut,
          fullCorpus: {
            budgets: BUDGETS,
            satisfiesBoth: gateFull.satisfiesBoth,
            satisfyingRows: gateFull.satisfyingCount,
            closestFactor: gateFull.closestFactor,
            point: gateFull.row ? metricsAt(gateFull.row, kept, fireFnAt(gateFull.row)) : null,
          },
          frontier: frontier.slice(0, 40),
          frontierSize: frontier.length,
          policiesSwept: rows.length,
          policiesDecision: rows.filter((r) => (model.skipDegenerate ? !isDegenerateThreshold(r.threshold) : true)).length,
          degenerateRule: model.skipDegenerate ? `threshold <= ${DEGENERATE_THRESHOLD_MAX} excluded from decisions` : 'baseline: knob is a duration, no p_eot threshold to exclude',
          groupDistribution: gateFull.row
            ? groupDistribution(
                gateFull.row,
                kept,
                fireFnAt(gateFull.row),
                (s) => s.group,
                'one group = one SESSION where the corpus exposes one (ASCEND: session-1..4), else one clip (THCHS-30 exposes no speaker id in the mirror used); a share near 1.0 means one session/recording drives the error',
              )
            : null,
          // AC4 language stratification — only meaningful for the corpus that carries a language tag.
          languageDistribution: gateFull.row ? languageDistribution(gateFull.row, kept, fireFnAt(gateFull.row)) : null,
        };
        if (!NO_DENSE && iv === PRIMARY_INTERVAL && model.kind === 'ml') {
          const dense = model.id === 'smart-turn-v3.2' ? sweepModelGrid(kept, st[String(iv)].tables, DENSE_POLICY) : sweepModelGrid(kept, t1mTablesFor(iv), DENSE_POLICY);
          const dg = gateRow(dense, model.skipDegenerate);
          (perView[view.id] as Record<string, unknown>).dense = {
            policies: dense.length,
            satisfiesBoth: dg.satisfiesBoth,
            satisfyingRows: dg.satisfyingCount,
            closestFactor: dg.closestFactor,
            point: dg.row ? metricsAt(dg.row, kept, fireFnAt(dg.row)) : null,
          };
        }
      }
      perInterval[`interval${String(iv).replace('.', '_')}`] = {
        intervalSeconds: iv,
        smartTurnInferenceCpuMs: {
          cells: st[String(iv)].cells,
          featureP50: quantile(st[String(iv)].featureMs, 0.5),
          featureP90: quantile(st[String(iv)].featureMs, 0.9),
          inferenceP50: quantile(st[String(iv)].inferenceMs, 0.5),
          inferenceP90: quantile(st[String(iv)].inferenceMs, 0.9),
          note: 'compiled mel + ONNX int8 CPU; reported separately from endpointing wait',
        },
        turn1MiniTiming: (t1mReport?.timing as Record<string, unknown> | undefined) ?? null,
        views: perView,
      };
    }
    analysis[model.id] = perInterval;
  }

  const environment = {
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    platform: process.platform,
    node: process.version,
    python: ((): string | null => {
      try {
        return execFileSync(VENV_PYTHON, ['--version'], { encoding: 'utf8' }).trim();
      } catch {
        return null;
      }
    })(),
    onnxruntime: ((t1mReport?.model as { runtime?: string } | undefined)?.runtime) ?? null,
  };

  const result: Record<string, unknown> = {
    schema: 'voice-turn-detection-compare/chinese-zeroshot-and-ft-readiness@1',
    generatedBy: 'run-benchmark.mts',
    generatedAt: new Date().toISOString(),
    task: 'gap-voice-turn-detection-p0-14-chinese-zeroshot-and-ft-readiness',
    question:
      'On REAL Chinese speech, do the ORIGINAL (un-fine-tuned) Smart Turn v3.2 and turn-1-mini hold a pre-registered operating point (false cutoff <= 10% AND missed END <= 10%), and do they beat a model-free baseline?',
    protocol: {
      source: 'livekit/eot-bench (Apache-2.0), replicated in eot-bench-adapters/protocol.mts',
      reuse: 'the SAME sweep core P0.7/P0.11/P0.13 use; the two models share one scorer so a frontier difference is the model, not the scorer',
      policySemantics: 'hold_model_fire = max(actionDelay, holdFire); cutoff = (fired & holdDur > max(actionDelay,fire)) | holdDur > timeout; detect = eotFired & eotFire <= timeout',
      fireTest: 'p_eot >= threshold (protocol.mts spanFire) — the shared, deliberate deviation from eot-bench `>`',
      degenerateThreshold: `threshold <= ${DEGENERATE_THRESHOLD_MAX} dropped from DECISION sets (AC3) — p_eot >= 0.02 fires on almost any cell`,
      crossModelThreshold: 'Smart Turn and turn-1-mini thresholds are SEPARATE probability spaces; the report never compares the two threshold NUMBERS, only their frontiers (AC3)',
      heldOut: 'per-model operating point SELECTED on a clip-disjoint half, REPORTED on the other half (AC4); selection set != reporting set',
      cellCut: 'E = floor(timestampMs * sampleRate / 1000)',
      smartTurnWindow: 'predictEndpoint rule: last 8 s, front-padded with zeros when the prefix is shorter',
      turn1miniSlice: 'frame j ends at sample (j+1)*320; a cell whose prefix ends at E reads frame floor(E/320)-1',
      baselines: {
        fixedWait: 'fires at exactly W seconds of silence — uses NO audio; knob W in seconds',
        vad: 'the SHIPPING rule: StreamingVad + thresholdsFor from src/shared/voiceEndpoint.ts driven over the span prefix; knob = endpoint ms',
      },
    },
    provenance: PROVENANCE,
    environment,
    corpora: {
      order: doc.corpora.map((c) => c.id),
      detail: doc.corpora,
      clips: doc.clips.length,
      spans: all.length,
      holds: all.filter((s) => s.label === 'hold').length,
      eots: all.filter((s) => s.label === 'eot').length,
      review: doc.clips.map((c) => ({ id: c.id, nature: c.nature, review: c.review })),
      naturalDialogueNote:
        'both corpora are REAL Chinese speech and are reported SEPARATELY (AC2). thchs30-zh-scripted is scripted single-utterance reads, so its END is a scripted sentence-final boundary, NOT a conversational turn end. ascend-zh-natural-dialogue is spontaneous conversation, but (a) it is code-switched (rows kept are zh|mixed, so most clips contain English too) and (b) the ADMITTED set is small and clusters into a few sessions/speakers, so its per-rate Wilson intervals are WIDE and the clips are not independent samples — the confidence statement in CONCLUSION.md is bounded accordingly and the natural-corpus sample size is stated explicitly rather than omitted',
    },
    models: {
      'smart-turn-v3.2': {
        licence: PROVENANCE.smartTurn.licence,
        status: t1mSha ? 'loaded' : 'unknown',
        sourceRevision: PROVENANCE.smartTurn.sourceRevision,
        onnxSha256: stSha(t1mSha),
        matchesPinnedSource: t1mSha === PROVENANCE.smartTurn.sourceBlobSha256,
        frontend: `compiled native mel addon (${buildNote})`,
      },
      'turn-1-mini': {
        licence: PROVENANCE.turn1Mini.licence,
        status: t1mReport ? 'loaded' : NO_PYTHON ? 'not-run (--no-python)' : 'load-failed',
        sourceRevision: PROVENANCE.turn1Mini.revision,
        runtime: (t1mReport?.model as Record<string, unknown> | undefined) ?? null,
        selfCheck: t1mReport?.selfCheck ?? null,
        preprocessing: 'driven through P0.13 run-turn1mini.py UNMODIFIED (official p99turn ONNX streaming + 4 kHz low-pass)',
      },
      'vad-shipping-rule': { kind: 'baseline', source: 'src/shared/voiceEndpoint.ts StreamingVad (the production rule)' },
      'fixed-wait-timer': { kind: 'baseline', source: 'no model — a constant silence timer' },
    },
    analysis,
    isolationEvidence: isolationEvidence(),
    paidCallEvidence: paidCallEvidence(),
    productionDiffEvidence: productionDiffEvidence(),
    p013UntouchedEvidence: p013UntouchedEvidence(),
    runtimeSeconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
  };
  writeFileSync(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`wrote ${RESULT_PATH} (${(JSON.stringify(result).length / 1024).toFixed(1)} KiB) in ${result.runtimeSeconds}s`);
}

const VAD_ENDPOINTS_MS = [200, 300, 400, 500, 600, 700, 800, 1000, 1200];
const FIXED_WAITS_S = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.5];

function stSha(v: string | null): string | null {
  return v;
}

await main();
