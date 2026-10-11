/**
 * P0.13 — English head-to-head: Pipecat **Smart Turn v3.2** (group B) vs p99lab **turn-1-mini**
 * (group C) on the SAME English audio, through the SAME eot-bench causal sweep.
 *
 * WHAT IS COMPARED, AND ON WHAT. Two English corpora are kept SEPARATE and reported separately first:
 *   · `librispeech-en-real` — corpus A, the P0.6 real English recordings (LibriSpeech, CC-BY-4.0),
 *     the same recordings P0.6/P0.7 already scored (re-fetched from the pinned sha256);
 *   · `eot-bench-en` — corpus B, the livekit/eot-bench English validation split (CC-BY-4.0), fetched
 *     at a pinned revision by `fetch-eot-bench-english.py`. This is the corpus turn-1-mini's own model
 *     card says it was NEVER trained or tuned on, so it is the clean, like-for-like held-out set.
 * A `merged` row is reported last, as the task asks, but the per-corpus rows are the ones that carry
 * the verdict — a merged number hides which corpus drives it.
 *
 * SMART TURN is scored here, at both causal grids, on the P0.6-validated COMPILED mel front-end
 * (`../adapters/smart-turn-compiled-features.mts`), shown numerically identical to the JS front-end
 * (maxAbsDiff 0 on both features and probability) at ~2.5× the speed. TURN-1-MINI is NOT scored here:
 * `run-turn1mini.py` runs the official ONNX streaming graph once per clip and writes one P(end of
 * turn) per 20 ms frame; this file SLICES those frames onto the same cells, so both models answer the
 * SAME (span, silence-offset) cells from a single streaming pass each.
 *
 * THE SWEEP is `protocol.mts`'s replicated eot-bench policy semantics. Note one honest usage fact: its
 * `sweepPolicies` takes ONE thresholded `fires` table and labels every row in `policy.thresholds` with
 * the threshold it was handed, so a multi-threshold call would stamp the same numbers onto every
 * threshold. Every sweep here recomputes the fire table per threshold and then calls `sweepPolicies`
 * with a single-element threshold list — the function's correct usage, and the same per-threshold
 * pattern P0.11's `sweepPolicyGrid` uses.
 *
 * Run (from anywhere; paths resolve from this file):
 *   node_modules/.bin/tsx --tsconfig server/tsconfig.json \
 *     experiments/voice-turn-detection-compare/english-smart-turn-vs-turn1mini/run-benchmark.mts
 * Flags: --limit-eot N (whole turns of corpus B) · --no-python · --no-dense · --no-cache ·
 *        --intervals 0.1,0.02
 *
 * Writes `RESULT.json` beside this file. Nothing here touches production, and no paid endpoint is called.
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
import { loadCorpus, scorableSpans } from '../eot-bench-adapters/corpus.mts';
import { compiledWhisperLogMel, loadCompiledFeatures } from '../adapters/smart-turn-compiled-features.mts';
import { createSmartTurnSession, decodeWav, truncateToLastSeconds, type SmartTurnSession } from '../adapters/smart-turn-v3.mts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const COMPARE_DIR = path.resolve(DIR, '..');
const REPO_ROOT = path.resolve(COMPARE_DIR, '..', '..');
const REAL_DIR = path.join(COMPARE_DIR, 'datasets', 'real');
const REAL_SAMPLES_PATH = path.join(REAL_DIR, 'samples.json');
const SPANS_PATH = path.join(DIR, 'data', 'spans.json');
const T1M_SCORES_PATH = path.join(DIR, 'data', 'turn1mini-scores.json');
const EOT_MANIFEST_PATH = path.join(DIR, 'data', 'eot-bench-en-manifest.json');
const CACHE_DIR = path.join(DIR, '_cache');
const RESULT_PATH = path.join(DIR, 'RESULT.json');
const VENV_PYTHON = path.join(DIR, '.venv', 'bin', 'python');
const MODEL_SR = 16000;

const SMART_TURN_MODEL =
  process.env.SMART_TURN_MODEL ?? path.join(os.homedir(), '.cache', 'voice-turn-detection-compare', 'smart-turn-v3.2-cpu.onnx');

// ── grids & policies ─────────────────────────────────────────────────────────────────────────────

/** The eot-bench default interrogation interval (0.1 s) — the primary grid. */
const PRIMARY_INTERVAL = 0.1;
/** The refined interrogation interval (0.02 s), parity with P0.11's densified sweep — the secondary grid. */
const REFINED_INTERVAL = 0.02;

const linspace = (start: number, stop: number, step: number, decimals: number): number[] => {
  const n = Math.round((stop - start) / step);
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(Number((start + i * step).toFixed(decimals)));
  return out;
};

type PolicyGrid = { thresholds: number[]; actionDelays: number[]; timeouts: number[] };

/** P0.7's coarse grid, verbatim from `protocol.mts` — the like-for-like baseline with published numbers. */
const COARSE_POLICY: PolicyGrid = { thresholds: DEFAULT_THRESHOLDS, actionDelays: DEFAULT_ACTION_DELAYS, timeouts: DEFAULT_TIMEOUTS };
/** P0.11's dense grid: same ranges, finer steps (threshold 0.005, actionDelay 0.02, timeout 0.05). */
const DENSE_POLICY: PolicyGrid = {
  thresholds: linspace(0, 1, 0.005, 3),
  actionDelays: linspace(0.2, 1.0, 0.02, 2),
  timeouts: linspace(1.0, 3.5, 0.05, 2),
};

/** AC5: threshold 0 is degenerate — `p_eot >= 0` is true for every cell, so EVERY span fires at d=0 and
 *  the policy carries no information. It is dropped from the DECISION set (still swept, so the drop is
 *  visible as a count) exactly as P0.11 did. */
const DEGENERATE_THRESHOLDS = new Set([0]);

/** The two budgets the task pre-registers (AC7). */
const BUDGETS = { falseCutoff: 0.1, missedEnd: 0.1 } as const;

/** eot-bench's hold-denominator window (`metrics.py` DEFAULT_MIN/MAX_HOLD_SPAN_DURATION). */
const HOLD_MIN_S = 0.2;
const HOLD_MAX_S = 5.0;

// ── AC1 provenance — pinned sources, verified hashes, first-hand licence reads ────────────────────
// Every value below was verified in THIS task's session against the actual bytes, not copied from a
// model card: the two licence files were fetched over HTTP and hashed (see `licenceRetrievedAt`), and
// the Smart Turn ONNX on disk was hashed and compared to the pinned HF LFS blob. The runtime re-hashes
// the ONNX at run time and asserts it still matches (`matchesPinnedSource`), so a swapped weight file
// cannot silently pass. turn-1-mini's row is cross-checked the same way by `run-turn1mini.py`, which
// refuses to run unless the ONNX sha256 equals this pin.
const PROVENANCE = {
  licenceRetrievedAt: '2026-10-11T09:14:38Z',
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
    licenceBytes: 1301,
    licenceSha256: '0d66364067f678c08586ebb60a16a2aed4fa081ec11057df35585759ce0e774f',
  },
  turn1Mini: {
    repo: 'p99lab/turn-1-mini',
    revision: '076c86d1744a231d3a4cce31f3bbbd1211b4c281',
    onnxFile: 'turn-1-mini.step.onnx',
    onnxSha256: 'e747b182d685c7db489a3ea2e12bdcd65bac506fcddec00ed3cd0bf9f209fd11',
    safetensorsSha256: 'd03ccff872eb0ae2ed0366b1ea94d860328daa0122bf9003fb32b7a34b14acb9',
    p99turnVersion: '1.2.3',
    p99turnWheelSha256: '4cb4802e04ae8b013f14499d858024a59ec40cc9d36db8b8c49155d623b7e273',
    licence: 'Apache-2.0',
    licenceUrl:
      'https://huggingface.co/p99lab/turn-1-mini/raw/076c86d1744a231d3a4cce31f3bbbd1211b4c281/LICENSE',
    licenceBytes: 11357,
    licenceSha256: 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
  },
} as const;

/** sha256 of a file's bytes on disk. */
function sha256File(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

// ── flag parsing ─────────────────────────────────────────────────────────────────────────────────

const argv = process.argv;
const flagValue = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? '') : null;
};
const LIMIT_EOT = Math.max(0, Number(flagValue('--limit-eot') ?? 0));
const NO_PYTHON = argv.includes('--no-python');
const NO_DENSE = argv.includes('--no-dense');
const NO_CACHE = argv.includes('--no-cache');
const INTERVALS = (flagValue('--intervals') ?? `${PRIMARY_INTERVAL},${REFINED_INTERVAL}`)
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

// ── the unified span record ──────────────────────────────────────────────────────────────────────

type CorpusId = 'librispeech-en-real' | 'eot-bench-en';

type P13Span = {
  key: string;
  corpus: CorpusId;
  group: string;
  id: string;
  spanIndex: number;
  label: 'eot' | 'hold';
  onsetMs: number;
  silenceMs: number;
  sampleRate: number;
  appendTailMs: number;
  clipMs: number;
  wav: string;
  audio: Float32Array;
};

const keyOf = (corpus: CorpusId, id: string, spanIndex: number): string => `${corpus}|${id}#${spanIndex}`;

/** speakerId + task-dir-relative WAV path per real sample, read once from the committed metadata. */
let SAMPLE_META: Map<string, { group: string; wavRel: string }> | null = null;
function sampleMeta(): Map<string, { group: string; wavRel: string }> {
  if (SAMPLE_META) return SAMPLE_META;
  const meta = new Map<string, { group: string; wavRel: string }>();
  if (existsSync(REAL_SAMPLES_PATH)) {
    const doc = JSON.parse(readFileSync(REAL_SAMPLES_PATH, 'utf8')) as {
      samples: Array<{ id: string; speakerId: number | null; language: string }>;
    };
    for (const rec of doc.samples) {
      const abs = path.join(REAL_DIR, `${rec.id}.wav`);
      meta.set(rec.id, { group: `speaker:${rec.speakerId ?? 'unknown'}`, wavRel: path.relative(DIR, abs) });
    }
  }
  SAMPLE_META = meta;
  return meta;
}

/** Corpus A — the P0.6 English real samples, relabelled into the eot-bench span view by `corpus.mts`.
 *  Group key = LibriSpeech `speakerId`, so the AC4 group check asks whether one voice drives the error. */
function buildCorpusA(): P13Span[] {
  const meta = sampleMeta();
  const out: P13Span[] = [];
  for (const span of scorableSpans(loadCorpus().spans)) {
    if (span.language !== 'en' || span.source !== 'real') continue;
    if (span.sampleRate !== MODEL_SR) throw new Error(`corpus A span ${span.sampleId} is ${span.sampleRate} Hz, expected ${MODEL_SR}`);
    out.push({
      key: keyOf('librispeech-en-real', span.sampleId, span.spanIndex),
      corpus: 'librispeech-en-real',
      group: meta.get(span.sampleId)?.group ?? 'speaker:unknown',
      id: span.sampleId,
      spanIndex: span.spanIndex,
      label: span.label,
      onsetMs: span.onsetMs,
      silenceMs: span.silenceMs,
      sampleRate: span.sampleRate,
      appendTailMs: span.appendedTailMs,
      clipMs: span.clipMs,
      wav: meta.get(span.sampleId)?.wavRel ?? '',
      audio: span.audio,
    });
  }
  return out;
}

/** Corpus B — the fetched eot-bench English manifest (bounded, replayable, pinned). A `--limit-eot N`
 *  keeps the first N whole turns, so a smoke run never truncates a turn's span set mid-way. */
function buildCorpusB(limit: number): P13Span[] {
  if (!existsSync(EOT_MANIFEST_PATH)) {
    throw new Error(`corpus B manifest missing: ${EOT_MANIFEST_PATH} — run fetch-eot-bench-english.py`);
  }
  const doc = JSON.parse(readFileSync(EOT_MANIFEST_PATH, 'utf8')) as {
    spans: Array<{ id: string; spanIndex: number; group: string; label: 'eot' | 'hold'; startMs: number; silenceMs: number; wav: string; sampleRate: number; clipMs: number }>;
  };
  const chosen: typeof doc.spans = [];
  if (limit > 0) {
    const turns = new Set<string>();
    for (const s of doc.spans) {
      if (!turns.has(s.id)) {
        if (turns.size >= limit) break;
        turns.add(s.id);
      }
      chosen.push(s);
    }
  } else {
    chosen.push(...doc.spans);
  }
  return chosen.map((s) => {
    const abs = path.join(DIR, s.wav);
    const { sampleRate, samples } = decodeWav(abs);
    if (sampleRate !== MODEL_SR) throw new Error(`corpus B turn ${s.id} is ${sampleRate} Hz, expected ${MODEL_SR}`);
    return {
      key: keyOf('eot-bench-en', s.id, s.spanIndex),
      corpus: 'eot-bench-en' as CorpusId,
      group: s.group,
      id: s.id,
      spanIndex: s.spanIndex,
      label: s.label,
      onsetMs: s.startMs,
      silenceMs: s.silenceMs,
      sampleRate: s.sampleRate,
      appendTailMs: 0,
      clipMs: s.clipMs,
      wav: s.wav,
      audio: samples,
    };
  });
}

/** Write `data/spans.json` — the contract `run-turn1mini.py` reads. */
function writeSpansJson(spans: P13Span[], corpora: unknown[]): void {
  mkdirSync(path.dirname(SPANS_PATH), { recursive: true });
  writeFileSync(
    SPANS_PATH,
    JSON.stringify({
      corpora,
      rule: 'cell prefix ends at sample E=floor(tsMs*sr/1000); turn-1-mini frame index j=floor(E/320)-1',
      spans: spans.map((s) => ({
        key: s.key,
        corpus: s.corpus,
        group: s.group,
        id: s.id,
        spanIndex: s.spanIndex,
        label: s.label,
        onsetMs: s.onsetMs,
        silenceMs: s.silenceMs,
        wav: s.wav,
        sampleRate: s.sampleRate,
        appendTailMs: s.appendTailMs,
        clipMs: s.clipMs,
      })),
    }),
  );
}

// ── cell geometry (shared by both models) ────────────────────────────────────────────────────────

/** eot-bench's causal read: a cell's prefix ends at sample `floor((start + d) * sr)`. `timestampMs` and
 *  `sampleRate` are integers, so `tsMs * sr / 1000` is exact in float64 (the true quotient is an
 *  integer well under 2^53) — no rounding drift, and the same sample index the reference cut uses. */
const prefixSamples = (timestampMs: number, sampleRate: number): number => Math.floor((timestampMs * sampleRate) / 1000);

/** Turn-1-mini's output frame j ends at sample (j+1)*320, so a cell whose prefix ends at E reads frame
 *  `floor(E/320) - 1` (0 before the first frame completes). */
const t1mFrameIndex = (E: number): number => Math.floor(E / 320) - 1;

function spanGrid(span: P13Span, interval: number): GridPoint[] {
  return causalGrid(
    { sampleId: span.id, spanIndex: span.spanIndex, onsetMs: span.onsetMs, silenceMs: span.silenceMs, truth: span.label === 'eot' ? 'END' : 'CONTINUE', label: span.label, scenario: '' },
    { inferenceIntervalSeconds: interval, maxSilenceSeconds: Number.POSITIVE_INFINITY },
  );
}

// ── Smart Turn scoring (compiled mel + local ONNX) ───────────────────────────────────────────────

type CellTable = { grid: GridPoint[]; scores: number[] };
type ScoreTables = Map<string, CellTable>;
/** The loaded compiled mel addon, taken off the loader's own return type so the two cannot drift. */
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
  // Exactly `predictEndpoint`'s window rule: keep the last 8 s, front-pad with zeros if shorter.
  const windowed = truncateToLastSeconds(prefix, 8, MODEL_SR);
  const tf0 = process.hrtime.bigint();
  const feats = compiledWhisperLogMel(addon, windowed);
  const tf1 = process.hrtime.bigint();
  const out = await session.run({ input_features: new ort.Tensor('float32', feats, [1, 80, 800]) });
  const ti1 = process.hrtime.bigint();
  const raw = (Object.values(out)[0] as { data: Float32Array }).data;
  return { probability: raw[0], featureMs: Number(tf1 - tf0) / 1e6, inferenceMs: Number(ti1 - tf1) / 1e6 };
}

/** Score every span's causal grid with Smart Turn. One audio pass per CELL (the model is stateless per
 *  query — a fresh 8 s window is exactly what `_predict_endpoint` does), which is why this is the
 *  expensive half and why the table is cached on disk, keyed by the exact cell count. */
async function scoreSmartTurn(
  spans: P13Span[],
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
      items.push({ key: s.key, prefix: s.audio.subarray(0, prefixSamples(cell.timestampMs, s.sampleRate)) });
      cells += 1;
    }
  }
  const file = cacheFile(`smart-turn-${interval}-${LIMIT_EOT ? `limit${LIMIT_EOT}` : 'full'}`);
  const cached = readCache(file, cells);
  const assemble = (byKey: Map<string, number[]>): ScoreTables => {
    const tables: ScoreTables = new Map();
    for (const [key, grid] of grids) tables.set(key, { grid, scores: byKey.get(key) ?? [] });
    return tables;
  };
  if (cached !== null) return { tables: assemble(cached), cells, featureMs: [], inferenceMs: [], fromCache: true };
  if (items.length === 0) return { tables: new Map(), cells: 0, featureMs: [], inferenceMs: [], fromCache: false };

  // Warm the session once (ORT kernel selection / JIT) so the first real cell is not a cold outlier.
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

/** Slice the Python frame probabilities onto a span's causal cells (shared geometry, above). */
function sliceTurn1Mini(span: P13Span, grid: GridPoint[], frameProbs: number[]): number[] {
  return grid.map((cell) => {
    const j = t1mFrameIndex(prefixSamples(cell.timestampMs, span.sampleRate));
    return j >= 0 && j < frameProbs.length ? frameProbs[j] : 0;
  });
}

// ── the sweep (per-threshold fires, then protocol's single-threshold policy sweep) ───────────────

function firesFor(spans: P13Span[], tables: ScoreTables, threshold: number): SpanFire[] {
  return spans.map((span) => {
    const t = tables.get(span.key);
    const { fireSeconds } = spanFire(t?.grid ?? [], t?.scores ?? [], threshold);
    return { key: span.key, label: span.label, silenceSeconds: span.silenceMs / 1000, fireSeconds };
  });
}

function sweepPolicyGrid(spans: P13Span[], tables: ScoreTables, policy: PolicyGrid): PolicyRow[] {
  const rows: PolicyRow[] = [];
  for (const threshold of policy.thresholds) {
    rows.push(...sweepPolicies(firesFor(spans, tables, threshold), { thresholds: [threshold], actionDelays: policy.actionDelays, timeouts: policy.timeouts }));
  }
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

/** AC6: the full metric block at ONE operating point, including the EOT-wait distribution the task
 *  asks for (a mean alone hides the tail), plus the two error counts with Wilson 95% intervals. */
function metricsAt(row: PolicyRow, spans: P13Span[], tables: ScoreTables): Record<string, unknown> {
  const fires = firesFor(spans, tables, row.threshold);
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

/** The operating point the AC7 verdict is taken at: the row satisfying BOTH budgets (lowest latency),
 *  or, when none does, the row closest to both — with the closest-factor reported so "how far" is a number. */
function gateRow(rows: PolicyRow[]): { row: PolicyRow | null; satisfiesBoth: boolean; closestFactor: number | null; satisfyingCount: number } {
  let both: PolicyRow | null = null;
  let closest: PolicyRow | null = null;
  let closestScore = Number.POSITIVE_INFINITY;
  let satisfyingCount = 0;
  for (const r of rows) {
    if (DEGENERATE_THRESHOLDS.has(r.threshold)) continue;
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

/** AC4/AC6: is the residual error driven by a few speakers/sessions, or spread across the corpus? */
function groupDistribution(row: PolicyRow, spans: P13Span[], tables: ScoreTables): Record<string, unknown> {
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
  for (const f of firesFor(spans, tables, row.threshold)) {
    const v = bump(spanByKey.get(f.key)?.group ?? '?');
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
    totalCutoffs: totalCutoff,
    totalMissed,
    worstGroupCutoffShare: totalCutoff ? Number(((sortedByCutoff[0]?.cutoffs ?? 0) / totalCutoff).toFixed(4)) : null,
    topDecileCutoffShare: totalCutoff ? Number((topDecileCutoff / totalCutoff).toFixed(4)) : null,
    topDecileMissedShare: totalMissed ? Number((topDecileMissed / totalMissed).toFixed(4)) : null,
    note: 'worstGroupCutoffShare = the single speaker/session with the most false cutoffs, as a fraction of all of them; topDecileCutoffShare = the top 10% of groups. A share near 1.0 means one recording dominates the error.',
    perGroup: sortedByCutoff,
  };
}

// ── honesty / isolation evidence ─────────────────────────────────────────────────────────────────

function isolationEvidence(): Record<string, unknown> {
  // The repo's ACTUAL build/typecheck/test config set — only those that exist are scanned. (An earlier
  // draft listed `vite.config.ts`, which does not exist here; the real config is `vite.config.js`, so
  // that draft silently left the Vite config unscanned. The list now covers both spellings plus
  // `scripts/tsconfig.json`.)
  const buildFiles = ['package.json', 'server/package.json', 'tsconfig.json', 'server/tsconfig.json', 'scripts/tsconfig.json', 'client/tsconfig.json', 'vite.config.js', 'vite.config.ts', 'vite.config.mts', 'scripts/test.sh'];
  // P0.13-specific markers. `onnxruntime` is deliberately NOT a marker: `onnxruntime-web` is a
  // PRE-EXISTING JS dependency of the earlier Smart Turn work (identical line on develop), unrelated to
  // this task's Python venv — including it would report a false hit. The Python `onnxruntime` is pinned
  // only in this directory's requirements.txt, which no build config reads.
  const markers = ['smart-turn-vs-turn1mini', 'turn-1-mini', 'p99turn', 'eot-bench-english', 'P0.13', 'p0-13'];
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
    claim: 'the P0.13 environment and harness are reachable from NO build/typecheck/test config',
    buildFilesScanned: scanned,
    markersSearched: markers,
    onnxruntimeNote:
      '`onnxruntime` is not a marker on purpose: `onnxruntime-web` in package.json is a pre-existing JS dependency (identical on develop), not this task\'s Python venv',
    hits,
    clean: hits.length === 0,
  };
}

function paidCallEvidence(): Record<string, unknown> {
  const files = [path.join(DIR, 'run-benchmark.mts'), path.join(DIR, 'run-turn1mini.py'), path.join(DIR, 'fetch-eot-bench-english.py')].filter(existsSync);
  // Egress markers assembled from fragments so this scanner never matches its own source.
  const markers = [['dash', 'scope'], ['aliyun', 'cs'], ['https', '://'], ['wss', '://'], ['fetch', '('], ['axi', 'os'], ['open', 'ai'], ['http', '.request'], ['net', '.connect']].map((p) => p.join(''));
  const scans = files.map((f) => {
    const text = readFileSync(f, 'utf8');
    const lines = text.split('\n');
    const found: Array<{ marker: string; line: number; snippet: string; inComment: boolean }> = [];
    for (const m of markers) for (let i = 0; i < lines.length; i++) if (lines[i].toLowerCase().includes(m.toLowerCase())) found.push({ marker: m, line: i + 1, snippet: lines[i].trim().slice(0, 110), inComment: /^\s*(\/\/|\*|\/\*|#|""")/.test(lines[i]) });
    // `https://huggingface.co` is a public model/dataset pull by design (pinned weights + corpus),
    // never a paid endpoint; every URL host seen is reported so the reader can judge.
    const urlHosts = [...new Set(Array.from(text.matchAll(/https?:\/\/([^/'"\s]+)/g)).map((m) => m[1]))];
    return { file: path.relative(REPO_ROOT, f), markers: found, urlHosts };
  });
  const p07Path = path.join(COMPARE_DIR, 'RESULT.json');
  const p07 = existsSync(p07Path) ? (JSON.parse(readFileSync(p07Path, 'utf8')) as Record<string, any>) : {};
  const keyName = ['DASH', 'SCOPE', '_API_KEY'].join('');
  return {
    claim: 'zero paid realtime / Omni API calls; the only network egress is the pinned public HF pull of the model weights and the eot-bench parquet',
    filesScanned: scans,
    paidCredentialEnvVarPresent: process.env[keyName] !== undefined,
    p07PaidLedgerUntouched: {
      // Read straight from P0.7's ledger: these two are P0.7's OWN cumulative spends, NOT this task's.
      // They are named `p07…` so a reader cannot mistake them for P0.13 spend.
      p07RealtimeCumulativeSpendCny: p07?.unifiedReplay?.qwenStreaming?.actualSpend?.cumulativeNewSpendCny ?? null,
      p07NonRealtimeCumulativeSpendCny: p07?.qwenProbeRealAudio?.cumulativeNewSpendCny ?? null,
      thisTaskNewSpendCny: 0,
      note: "this task never writes P0.7 RESULT.json and makes no paid call, so P0.7's paid totals are byte-identical to before and this task itself adds 0 CNY",
    },
  };
}

function productionDiffEvidence(): Record<string, unknown> {
  const paths = ['server/modules/voice-realtime/', 'src/modules/chat/voice-realtime/'];
  const git = (args: string[]): string => {
    try {
      return execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' }).trim();
    } catch (err) {
      return `<<git failed: ${(err as Error).message}>>`;
    }
  };
  // AC8's question is "did THIS branch touch a production Live Voice path?". `git diff develop` does NOT
  // answer it while the branch is behind develop: it ALSO reports develop's OWN advance as a change. The
  // own-delta diff (vs the merge-base of HEAD and develop) does answer it, and is the field read as the
  // AC8 evidence. (Recorded after an earlier draft used the develop tip and so mis-signalled develop's
  // own commits as this task's — see `vsDevelopTip` below, which is kept only as that documented
  // diagnostic because AC8 names the `git diff develop` command explicitly.)
  const mergeBase = git(['merge-base', 'HEAD', 'develop']);
  const own = git(['diff', '--name-only', mergeBase, '--', ...paths]);
  const tip = git(['diff', '--name-only', 'develop', '--', ...paths]);
  const behind = Number(git(['rev-list', '--count', 'HEAD..develop']));
  return {
    claim: "this branch's OWN delta touches no production Live Voice path (AC8)",
    command: `git diff --name-only $(git merge-base HEAD develop) -- ${paths.join(' ')}`,
    mergeBase,
    changedPaths: own === '' ? [] : own.split('\n'),
    empty: own === '',
    vsDevelopTip: {
      command: `git diff --name-only develop -- ${paths.join(' ')}`,
      changedPaths: tip === '' ? [] : tip.split('\n'),
      empty: tip === '',
      note:
        tip === ''
          ? 'empty: develop has not advanced on these paths beyond the merge-base, so the raw `git diff develop` command is empty too.'
          : `non-empty here ONLY because this branch is ${Number.isFinite(behind) ? behind : '?'} commit(s) behind develop: every path is develop's own advance, not an edit made in this task (the own-delta diff above is empty). It becomes empty once develop is merged in.`,
    },
    behindDevelopCommits: Number.isFinite(behind) ? behind : null,
    scope: 'the production Live Voice paths the task forbids touching; empty own-delta = AC8 evidence',
  };
}

// ── the run ──────────────────────────────────────────────────────────────────────────────────────

type View = { id: string; label: string; spans: P13Span[] };

/** The eot-bench denominator rule, applied to a view: eot spans always; holds only inside the window. */
function denominator(spans: P13Span[]): { kept: P13Span[]; droppedHolds: number } {
  const kept = spans.filter((s) => s.label === 'eot' || (s.silenceMs / 1000 >= HOLD_MIN_S - EPS && s.silenceMs / 1000 <= HOLD_MAX_S + EPS));
  return { kept, droppedHolds: spans.length - kept.length };
}

const quantile = (a: number[], p: number): number | null =>
  a.length ? Number([...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.ceil(p * a.length) - 1)].toFixed(4)) : null;

async function main(): Promise<void> {
  const t0 = Date.now();
  // `--evidence-only`: recompute ONLY the derived honesty/isolation fields of an existing RESULT.json
  // from the CURRENT git tree, without re-running either model. Exists so evidence can be corrected
  // after a source change (e.g. the merge-base fix to `productionDiffEvidence`) without paying the
  // ~78-minute model re-run; the model/analysis fields are carried over byte-for-byte.
  if (process.argv.includes('--evidence-only')) {
    const cur = JSON.parse(readFileSync(RESULT_PATH, 'utf8')) as Record<string, unknown>;
    const patched = {
      ...cur,
      isolationEvidence: isolationEvidence(),
      paidCallEvidence: paidCallEvidence(),
      productionDiffEvidence: productionDiffEvidence(),
      evidenceRefreshedAt: new Date().toISOString(),
    };
    writeFileSync(RESULT_PATH, `${JSON.stringify(patched, null, 2)}\n`);
    console.log(`refreshed evidence in ${RESULT_PATH}`);
    return;
  }
  mkdirSync(path.join(DIR, 'data'), { recursive: true });

  const corpusA = buildCorpusA();
  const corpusB = buildCorpusB(LIMIT_EOT);
  const all = [...corpusA, ...corpusB];
  writeSpansJson(all, [
    { id: 'librispeech-en-real', label: 'LibriSpeech (English, real)', groupKey: 'speakerId', licence: 'CC-BY-4.0', note: 'P0.6 real samples; audio re-fetched from the pinned sha256' },
    { id: 'eot-bench-en', label: 'eot-bench English validation', groupKey: 'speaker_session', licence: 'CC-BY-4.0', note: 'livekit/eot-bench-data, pinned revision ca9d98a9…' },
  ]);
  console.log(`corpus A spans=${corpusA.length}  corpus B spans=${corpusB.length}  total=${all.length}  intervals=[${INTERVALS.join(', ')}]${LIMIT_EOT ? `  limitEot=${LIMIT_EOT}` : ''}`);

  // ── turn-1-mini (Python, official ONNX streaming) ─────────────────────────────────────────────
  let t1mReport: Record<string, any> | null = null;
  const t1mFrames = new Map<string, number[]>();
  if (!NO_PYTHON) {
    console.log('running turn-1-mini (official ONNX streaming) …');
    const selfcheckWav = corpusA[0] ? path.join(DIR, corpusA[0].wav) : '';
    execFileSync(VENV_PYTHON, ['-I', path.join(DIR, 'run-turn1mini.py'), '--spans', SPANS_PATH, '--out', T1M_SCORES_PATH, '--selfcheck-wav', selfcheckWav], {
      stdio: 'inherit',
      cwd: REPO_ROOT,
      env: { ...process.env, HF_HOME: path.join(DIR, 'data', 'hf') },
    });
    if (!existsSync(T1M_SCORES_PATH)) throw new Error(`run-turn1mini.py exited without writing ${T1M_SCORES_PATH}`);
    t1mReport = JSON.parse(readFileSync(T1M_SCORES_PATH, 'utf8'));
    // AC2: never let a STALE scores file from a previous run supply readings. The file is keyed by span,
    // so a mismatch against the current span set means it was produced for a different corpus/limit —
    // fail loudly rather than score a model on numbers that do not belong to these spans.
    const gotKeys = new Set((t1mReport!.spans as Array<{ key: string }>).map((s) => s.key));
    const missing = all.filter((s) => !gotKeys.has(s.key)).map((s) => s.key);
    if (missing.length > 0) {
      throw new Error(
        `turn-1-mini scores are stale: ${missing.length}/${all.length} current span keys absent (first: ${missing[0]}). Delete ${T1M_SCORES_PATH} and re-run.`,
      );
    }
    for (const s of t1mReport!.spans as Array<{ key: string; frameProbs: number[] }>) t1mFrames.set(s.key, s.frameProbs);
  }

  // ── Smart Turn (local ONNX, compiled mel) ─────────────────────────────────────────────────────
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

  // ── metrics ───────────────────────────────────────────────────────────────────────────────────
  const modelNames = ['smart-turn-v3.2', 'turn-1-mini'] as const;
  type ModelName = (typeof modelNames)[number];
  const tablesFor = (model: ModelName, iv: number): ScoreTables => {
    if (model === 'smart-turn-v3.2') return st[String(iv)].tables;
    const out: ScoreTables = new Map();
    for (const s of all) {
      const grid = st[String(iv)].tables.get(s.key)?.grid ?? [];
      out.set(s.key, { grid, scores: sliceTurn1Mini(s, grid, t1mFrames.get(s.key) ?? []) });
    }
    return out;
  };

  const views: View[] = [
    { id: 'eot-bench-en', label: 'eot-bench English validation (held out for turn-1-mini)', spans: all.filter((s) => s.corpus === 'eot-bench-en') },
    { id: 'librispeech-en-real', label: 'LibriSpeech English real (in-distribution for turn-1-mini)', spans: all.filter((s) => s.corpus === 'librispeech-en-real') },
    { id: 'merged', label: 'both corpora merged', spans: all },
  ];

  const analysis: Record<string, unknown> = {};
  for (const model of modelNames) {
    const perInterval: Record<string, unknown> = {};
    for (const iv of INTERVALS) {
      const tables = tablesFor(model, iv);
      const perView: Record<string, unknown> = {};
      for (const view of views) {
        const { kept, droppedHolds } = denominator(view.spans);
        if (kept.filter((s) => s.label === 'eot').length === 0) continue;
        const coarseRows = sweepPolicyGrid(kept, tables, COARSE_POLICY);
        const gate = gateRow(coarseRows);
        // AC5: the frontier is taken over NON-degenerate policies only — threshold 0 fires on every cell
        // and would otherwise lead the frontier with an uninformative (0 cutoff, 0 missed) corner.
        const frontier = paretoFrontier(coarseRows.filter((r) => !DEGENERATE_THRESHOLDS.has(r.threshold))).map(compact);
        const entry: Record<string, unknown> = {
          denominator: { spans: kept.length, holds: kept.filter((s) => s.label === 'hold').length, eots: kept.filter((s) => s.label === 'eot').length, droppedHolds },
          gate: { budgets: BUDGETS, satisfiesBoth: gate.satisfiesBoth, satisfyingRows: gate.satisfyingCount, closestFactor: gate.closestFactor, point: gate.row ? metricsAt(gate.row, kept, tables) : null },
          frontier: frontier.slice(0, 40),
          frontierSize: frontier.length,
          frontierNote: 'Pareto frontier over NON-degenerate policies (threshold>0) only — AC5; the swept set still includes threshold 0 so the drop is visible as policiesSwept - policiesDecision',
          groupDistribution: gate.row ? groupDistribution(gate.row, kept, tables) : null,
          degenerateThresholdsExcluded: DEGENERATE_THRESHOLDS.size,
          policiesSwept: coarseRows.length,
          policiesDecision: coarseRows.filter((r) => !DEGENERATE_THRESHOLDS.has(r.threshold)).length,
        };
        if (!NO_DENSE && iv === PRIMARY_INTERVAL) {
          const denseRows = sweepPolicyGrid(kept, tables, DENSE_POLICY);
          const denseGate = gateRow(denseRows);
          entry.dense = {
            policies: denseRows.length,
            gate: { satisfiesBoth: denseGate.satisfiesBoth, satisfyingRows: denseGate.satisfyingCount, closestFactor: denseGate.closestFactor, point: denseGate.row ? metricsAt(denseGate.row, kept, tables) : null },
            frontierSize: paretoFrontier(denseRows.filter((r) => !DEGENERATE_THRESHOLDS.has(r.threshold))).length,
            note: 'P0.11 dense grid (threshold 0.005, actionDelay 0.02, timeout 0.05) on the 0.1 s causal grid',
          };
        }
        perView[view.id] = entry;
      }
      const feat = st[String(iv)].featureMs;
      const inf = st[String(iv)].inferenceMs;
      perInterval[`interval${String(iv).replace('.', '_')}`] = {
        intervalSeconds: iv,
        smartTurnInferenceCpuMs: {
          cells: st[String(iv)].cells,
          featureP50: quantile(feat, 0.5),
          featureP90: quantile(feat, 0.9),
          inferenceP50: quantile(inf, 0.5),
          inferenceP90: quantile(inf, 0.9),
          note: 'compiled mel + ONNX int8 CPU; feature and inference reported separately because they have different fixes',
        },
        views: perView,
      };
    }
    analysis[model] = perInterval;
  }

  // AC1: re-hash the Smart Turn ONNX at run time and compare to the pinned source blob, so a swapped
  // weight file cannot pass unnoticed. turn-1-mini is pinned the same way inside run-turn1mini.py.
  const stOnnxSha = existsSync(SMART_TURN_MODEL) ? sha256File(SMART_TURN_MODEL) : null;
  if (stOnnxSha && stOnnxSha !== PROVENANCE.smartTurn.sourceBlobSha256) {
    console.warn(`WARNING: Smart Turn ONNX sha256 ${stOnnxSha} != pinned ${PROVENANCE.smartTurn.sourceBlobSha256}`);
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
    onnxruntime: (t1mReport?.model as { runtime?: string } | undefined)?.runtime ?? null,
  };

  const result: Record<string, unknown> = {
    schema: 'voice-turn-detection-compare/english-smart-turn-vs-turn1mini@1',
    generatedBy: 'run-benchmark.mts',
    generatedAt: new Date().toISOString(),
    task: 'gap-voice-turn-detection-p0-13-english-smart-turn-vs-turn1mini',
    question: 'On English audio, does Pipecat Smart Turn v3.2 or p99lab turn-1-mini hold a pre-registered operating point (false cutoff <= 10% AND missed END <= 10%), and at what endpointing wait?',
    protocol: {
      source: 'livekit/eot-bench (Apache-2.0), replicated in eot-bench-adapters/protocol.mts',
      policySemantics: 'hold_model_fire = max(actionDelay, holdFire); cutoff = (fired & holdDur > max(actionDelay,fire)) | holdDur > timeout; detect = eotFired & eotFire <= timeout; eotLatency = detect ? fire : timeout',
      fireTest: 'p_eot >= threshold (protocol.mts spanFire); eot-bench uses strict `>` — the >= choice is inherited from the shared P0.7/P0.11 scorer and recorded here as a deliberate, uniform deviation',
      holdDenominator: `eot spans always; holds only in [${HOLD_MIN_S}, ${HOLD_MAX_S}] s (eot-bench metrics.py)`,
      causalGridMaxSilence: 'unbounded (eot-bench walks the whole span; protocol.mts defaults to 1.5 s, overridden here)',
      degenerateThreshold: 'threshold 0 is dropped from the DECISION set (p_eot >= 0 fires at every cell) — AC5',
      turn1miniSlice: 'frame j ends at sample (j+1)*320; a cell whose prefix ends at E reads frame floor(E/320)-1',
      cellCut: 'E = floor(timestampMs * sampleRate / 1000) — exact in float64, matching eot-bench floor((start+d)*sr); the manifest start carries ms rounding (<0.5 ms, sub-frame)',
      smartTurnWindow: 'predictEndpoint rule: last 8 s, front-padded with zeros when the prefix is shorter',
    },
    corpora: {
      librispeechEnReal: { id: 'librispeech-en-real', licence: 'CC-BY-4.0', groupKey: 'speakerId', spans: corpusA.length, note: 'P0.6 real English; audio re-fetched from the pinned sha256' },
      eotBenchEn: { id: 'eot-bench-en', licence: 'CC-BY-4.0', groupKey: 'speaker_session', revision: 'ca9d98a9686b920a2d8c9eb984224ba9be74e4dd', spans: corpusB.length, manifestAllSpans: 1250, note: 'livekit/eot-bench-data English validation; held out for turn-1-mini' },
      caveat: 'turn-1-mini was trained in part on LibriSpeech (per its NOTICE), so corpus A is NOT held out for it; eot-bench IS clean. The per-corpus rows are reported separately for exactly this reason (AC4) and the merged row is read last.',
    },
    provenance: PROVENANCE,
    environment,
    models: {
      'smart-turn-v3.2': {
        licence: 'BSD-2-Clause (Pipecat/Daily) — local ONNX int8 CPU build, no network at inference',
        status: stOnnxSha ? 'loaded' : 'load-failed',
        source: PROVENANCE.smartTurn.sourceRepo,
        sourceRevision: PROVENANCE.smartTurn.sourceRevision,
        sourceFile: PROVENANCE.smartTurn.sourceFile,
        onnxSha256: stOnnxSha,
        matchesPinnedSource: stOnnxSha === PROVENANCE.smartTurn.sourceBlobSha256,
        licenceUrl: PROVENANCE.smartTurn.licenceUrl,
        licenceSha256: PROVENANCE.smartTurn.licenceSha256,
        modelPath: path.relative(REPO_ROOT, SMART_TURN_MODEL),
        modelBytes: existsSync(SMART_TURN_MODEL) ? statSync(SMART_TURN_MODEL).size : null,
        frontend: `compiled native mel addon (${buildNote}) — numerically identical to the JS front-end (maxAbsDiff 0)`,
      },
      'turn-1-mini': {
        licence: 'Apache-2.0 (p99lab/turn-1-mini)',
        status: t1mReport ? 'loaded' : NO_PYTHON ? 'not-run (--no-python)' : 'load-failed',
        source: PROVENANCE.turn1Mini.repo,
        sourceRevision: PROVENANCE.turn1Mini.revision,
        licenceUrl: PROVENANCE.turn1Mini.licenceUrl,
        licenceSha256: PROVENANCE.turn1Mini.licenceSha256,
        runtime: t1mReport?.model ?? null,
        selfCheck: t1mReport?.selfCheck ?? null,
        inferenceCpuMs: t1mReport?.timing ?? null,
      },
    },
    analysis,
    isolationEvidence: isolationEvidence(),
    paidCallEvidence: paidCallEvidence(),
    productionDiffEvidence: productionDiffEvidence(),
    runtimeSeconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
  };

  writeFileSync(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`wrote ${RESULT_PATH} (${(JSON.stringify(result).length / 1024).toFixed(1)} KiB) in ${result.runtimeSeconds}s`);
}

await main();
