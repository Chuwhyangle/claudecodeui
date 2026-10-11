/**
 * P0.9 Stage 1 — offline multi-threshold replay of the SHIPPING `StreamingVad` on the P0.6/P0.7
 * REAL candidate points, plus the incumbent Qwen Realtime baseline it is compared against.
 *
 * WHAT THIS ANSWERS. The user's correction: do not spend money on the Realtime/Omni pilot before
 * knowing whether a pure local/zero-cost chain is good enough. This file is the zero-cost first
 * half — it reuses the P0.6/P0.7 corpus (44 samples / 73 candidate points, the real LibriSpeech /
 * THCHS-30 audio fetched by the committed script) and replays the SHIPPING detector at several
 * silence-wait thresholds, listing per candidate point what happens at each.
 *
 * IT IS THE SHIPPING RULE, NOT A REIMPLEMENTATION. `StreamingVad` / `thresholdsFor` / `FRAME_MS`
 * are imported from `src/shared/voiceEndpoint.ts` — the module the voice relay actually runs — and
 * the commit rule is the same forward-quiet-run scan the P0.7 eot-bench adapter uses
 * (`eot-bench-adapters/vad-batch-adapter.mts`), lifted here so the scan can be parameterised by the
 * sweep's own threshold. The scan is 12 lines and is the MEASUREMENT, not a data pipeline: the
 * CORPUS comes from `eot-bench-adapters/corpus.mts` (the single corpus loader) and the rates/CIs
 * come from `eot-bench-adapters/protocol.mts` (the single protocol), exactly as P0.7 used them.
 *
 * WHY THE READING IS TAKEN PER POINT AND NOT ONLY AS A RATE. The task requires 逐样本 listing —
 * WHICH within-turn pause is falsely cut at WHICH threshold — not only a summary percentage, and it
 * forbids drawing a "feasible / infeasible" conclusion from a small-denominator ratio. So every
 * rate here is written beside the k/n it was computed from.
 *
 * THE INCUMBENT BASELINE (口径纠正, AC1). The comparison target is "Qwen Realtime's current
 * observable quality". P0.7's raw streaming block has 11/24 sessions marked `timeout`; the class of
 * each is read off P0.7's OWN recorded evidence, not asserted:
 *   • `attribution.attributedStoppedRelMs === null` ∧ exactly one `speechStopsRelMs` → the endpoint
 *     DID fire, the harness's window could not attribute it → a MEASUREMENT false-negative
 *     (librispeech-000#0 @400/@800 — the stop arrived 25–91 ms early, P0.8's finding). KEPT clean.
 *   • otherwise (0 stops = never fired, or ≥2 stops = fragmented) → REAL upstream latency /
 *     instability. DROPPED. This derives exactly 2 FN / 9 real, with no hand-written id list.
 * A third, non-timeout anomaly is ANNOTATED rather than silently kept: `zh-d01-o85#0@400` is `ok`
 * but its onset→stop wait is 14012 ms, >10× every other ok session — the same session that is
 * polluted at @800. The clean baseline is reported both WITH it (15 sessions) and WITHOUT (14).
 *
 * ZERO PAID CALLS. This file reads local audio and a committed RESULT.json. It opens no socket.
 *
 * Run:  npx tsx experiments/voice-turn-detection-compare/staged-feasibility/offline-vad-sweep.mts
 * Writes: ./RESULT.json
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { StreamingVad, thresholdsFor, FRAME_MS } from '../../../src/shared/voiceEndpoint.ts';
import { loadCorpus, scorableSpans, DEFAULT_CLOSING_SILENCE_MS } from '../eot-bench-adapters/corpus.mts';
import type { Corpus, ReplaySpan } from '../eot-bench-adapters/corpus.mts';
import { causalGrid, wilson95 } from '../eot-bench-adapters/protocol.mts';
import type { GridPoint } from '../eot-bench-adapters/protocol.mts';
// The SAME sweep machinery P0.7 used for groups A/B/C — imported, not re-written, so the VAD
// thresholds below land on the identical (threshold × actionDelay × timeout) axes as Smart Turn and
// LiveKit and can be compared axis-for-axis.
import { sweepGroup, summarizeGroup } from '../eot-bench-adapters/run-replay.mts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const RESULT_PATH = path.join(DIR, 'RESULT.json');
const COMPARE_DIR = path.resolve(DIR, '..');
const P07_RESULT_PATH = path.join(COMPARE_DIR, 'RESULT.json');

/** The thresholds the sweep replays. 400 ms is the shipping default AND the incumbent's own
 *  default `silence_duration_ms`, so it is the reference column; the others bracket it. 1500 ms is
 *  the protocol grid's own horizon (`causalGrid` default `maxSilenceSeconds`). */
export const VAD_THRESHOLDS_MS = [300, 400, 500, 800, 1200, 1500] as const;

/** eot-bench's own cutoff budgets, in its own units (fractions). The gate's primary budget is the
 *  LOOSEST of these (`FRONTIER_MAX_CUTOFF = 0.10`) — the number the project already uses in P0.7;
 *  the tighter two are reported as a sensitivity band, never as the pass/fail line. */
export const CUTOFF_BUDGET_BAND = [0.02, 0.05, 0.1] as const;

/** The pre-registered Stage-1 sufficiency gate. G1/G3 use the project's existing 0.10 cutoff bound
 *  (P0.7 `FRONTIER_MAX_CUTOFF`), applied to both the false-cutoff and the missed-end rate. G2 uses
 *  the incumbent's OWN clean end-wait p90: "matching Qwen Realtime's observable quality" means the
 *  local detector is no slower than the endpoint the incumbent already shows, measured on the same
 *  sessions. Written before the sweep was read; not adjusted afterwards. */
export const STAGE1_GATE = {
  note: 'pre-registered before reading the sweep; budgets are fractions',
  cutoffBudget: 0.1,
  missedEndBudget: 0.1,
  endWaitP90MustNotExceedIncumbentCleanP90: true,
} as const;

// ── the commit scan (the measurement; mirrors eot-bench-adapters/vad-batch-adapter.mts) ──────────

function frameEnergies(samples: Float32Array, frame: number): number[] {
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
 * The frame at which the shipping detector declares the utterance over, scanning FORWARD from the
 * candidate point's own onset, at silence-wait `endpointMs`. Returns the frame one past the
 * confirmed quiet run, or `Infinity` when the prefix holds no run that long.
 */
export function vadCommitFrameAt(
  prefix: Float32Array,
  rate: number,
  onsetFrame: number,
  endpointMs: number,
): { commitFrame: number; endpointFrames: number; frame: number; quietStartFrame: number } {
  const frame = Math.max(1, Math.round((FRAME_MS / 1000) * rate));
  const energies = frameEnergies(prefix, frame);
  const vad = new StreamingVad({ sampleRate: rate });
  const quiet: boolean[] = [];
  for (let i = 0; i < energies.length; i++) {
    vad.pushFrameEnergy(energies[i]);
    quiet.push(energies[i] < thresholdsFor(vad.noiseFloor).enter);
  }
  const forward = new Int32Array(quiet.length + 1);
  for (let i = quiet.length - 1; i >= 0; i--) forward[i] = quiet[i] ? forward[i + 1] + 1 : 0;
  const endpointFrames = Math.max(1, Math.round(((endpointMs / 1000) * rate) / frame));
  const from = Math.min(quiet.length, Math.max(0, onsetFrame));
  for (let j = from; j < quiet.length; j++) {
    if (forward[j] >= endpointFrames) return { commitFrame: j + endpointFrames, endpointFrames, frame, quietStartFrame: j };
  }
  return { commitFrame: Number.POSITIVE_INFINITY, endpointFrames, frame, quietStartFrame: -1 };
}

function pctlOf(arr: number[], p: number): number | null {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
}

// ── Stage 1: replay every scorable span at every threshold ───────────────────────────────────────

type ScorableSpan = ReturnType<typeof scorableSpans>[number];

type SpanReading = {
  spanKey: string;
  sampleId: string;
  label: 'eot' | 'hold';
  truth: string;
  scenario: string;
  source: 'synthetic' | 'real';
  language: 'en' | 'zh';
  /** hold: the pause length. eot: the silence to the clip edge plus the appended tail. */
  silenceMs: number;
  byThreshold: Array<{
    endpointMs: number;
    /** Time from the span onset to the commit, ms; null when the detector never commits. */
    fireMs: number | null;
    /** hold: did the commit land INSIDE the pause (before the speaker resumed)? eot: did it commit? */
    falseCutoff: boolean | null;
    detected: boolean | null;
  }>;
};

function readSpan(span: ScorableSpan, endpointMs: number, rate: number): { fireMs: number | null } {
  const frame = Math.max(1, Math.round((FRAME_MS / 1000) * rate));
  const grid: GridPoint[] = causalGrid(span, {});
  if (grid.length === 0) return { fireMs: null };
  const dMax = grid[grid.length - 1].silenceDurMs;
  const cut = Math.min(span.audio.length, Math.round(((span.onsetMs + dMax) / 1000) * rate));
  const prefix = span.audio.subarray(0, cut);
  const onsetFrame = Math.floor(((span.onsetMs / 1000) * rate) / frame);
  const { commitFrame } = vadCommitFrameAt(prefix, rate, onsetFrame, endpointMs);
  if (!Number.isFinite(commitFrame)) return { fireMs: null };
  const commitMs = (commitFrame * frame * 1000) / rate;
  return { fireMs: Math.max(0, commitMs - span.onsetMs) };
}

export function runStage1(corpus: Corpus = loadCorpus()): {
  thresholds: number[];
  spanReadings: SpanReading[];
  aggregates: Array<Record<string, unknown>>;
  corpus: Record<string, unknown>;
} {
  const spans = scorableSpans(corpus.spans);
  const holds = spans.filter((s) => s.label === 'hold');
  const eots = spans.filter((s) => s.label === 'eot');

  const spanReadings: SpanReading[] = [];
  const perThreshold = VAD_THRESHOLDS_MS.map((endpointMs) => ({
    endpointMs,
    holds: [] as Array<{ span: ScorableSpan; fireMs: number | null }>,
    eots: [] as Array<{ span: ScorableSpan; fireMs: number | null }>,
  }));

  for (const span of spans) {
    const reading: SpanReading = {
      spanKey: `${span.sampleId}#${span.spanIndex}`,
      sampleId: span.sampleId,
      label: span.label,
      truth: span.truth,
      scenario: span.scenario,
      source: span.source,
      language: span.language,
      silenceMs: span.silenceMs,
      byThreshold: [],
    };
    for (let t = 0; t < VAD_THRESHOLDS_MS.length; t++) {
      const endpointMs = VAD_THRESHOLDS_MS[t];
      const { fireMs } = readSpan(span, endpointMs, span.sampleRate);
      if (span.label === 'hold') {
        const falseCutoff = fireMs !== null && fireMs < span.silenceMs;
        reading.byThreshold.push({ endpointMs, fireMs, falseCutoff, detected: null });
        perThreshold[t].holds.push({ span, fireMs });
      } else {
        reading.byThreshold.push({ endpointMs, fireMs, falseCutoff: null, detected: fireMs !== null });
        perThreshold[t].eots.push({ span, fireMs });
      }
    }
    spanReadings.push(reading);
  }

  const aggregates: Array<Record<string, unknown>> = perThreshold.map(({ endpointMs, holds: hs, eots: es }) => {
    const cut = hs.filter((h) => h.fireMs !== null && h.fireMs < h.span.silenceMs);
    const missed = es.filter((e) => e.fireMs === null);
    const fireTimes = es.filter((e) => e.fireMs !== null).map((e) => e.fireMs as number);
    const mean = fireTimes.length ? fireTimes.reduce((a, b) => a + b, 0) / fireTimes.length : null;
    return {
      endpointMs,
      falseCutoffRate: hs.length ? Number((cut.length / hs.length).toFixed(6)) : null,
      falseCutoffK: cut.length,
      falseCutoffN: hs.length,
      falseCutoffRate95Ci: wilson95(cut.length, hs.length),
      missedEndRate: es.length ? Number((missed.length / es.length).toFixed(6)) : null,
      missedEndK: missed.length,
      missedEndN: es.length,
      missedEndRate95Ci: wilson95(missed.length, es.length),
      endWaitMs: { p50: pctlOf(fireTimes, 0.5), p90: pctlOf(fireTimes, 0.9), mean: mean === null ? null : Number(mean.toFixed(1)), n: fireTimes.length },
      /** The spans falsely cut at this threshold — 逐样本 evidence, not just the rate. */
      falseCutoffSpans: cut.map((h) => ({ spanKey: `${h.span.sampleId}#${h.span.spanIndex}`, pauseMs: h.span.silenceMs, fireMs: h.fireMs, source: h.span.source })),
      missedEndSpans: missed.map((e) => ({ spanKey: `${e.span.sampleId}#${e.span.spanIndex}`, silenceMs: e.span.silenceMs, source: e.span.source, scenario: e.span.scenario })),
    };
  });

  const corpusStats = {
    sampleCount: corpus.sampleCount,
    spanCount: spans.length,
    holdCount: holds.length,
    eotCount: eots.length,
    correctionCount: corpus.correctionSpans.length,
    closingSilenceMs: DEFAULT_CLOSING_SILENCE_MS,
    holdPauseMs: { min: pctlOf(holds.map((h) => h.silenceMs), 0), p50: pctlOf(holds.map((h) => h.silenceMs), 0.5), p90: pctlOf(holds.map((h) => h.silenceMs), 0.9), max: pctlOf(holds.map((h) => h.silenceMs), 1) },
    realSpanCount: spans.filter((s) => s.source === 'real').length,
    syntheticSpanCount: spans.filter((s) => s.source === 'synthetic').length,
  };

  return { thresholds: [...VAD_THRESHOLDS_MS], spanReadings, aggregates, corpus: corpusStats };
}

// ── Stage 1b: the same sweep P0.7 ran for A/B/C, applied to the VAD at each threshold ────────────
//
// WHY THIS EXISTS. The direct reading above answers "does the commit land inside the pause" at
// actionDelay 0. But P0.7's groups A/B/C (the local detectors Stage 2 must be compared against) are
// reported through the eot-bench policy sweep, whose cutoff rate falls as `actionDelay` rises — so a
// direct ad-0 rate and a sweep rate are NOT the same number and must not be put side by side. This
// section closes that gap by driving the SAME `sweepGroup`/`summarizeGroup` (imported from the P0.7
// harness) over the VAD's own per-cell scores, so every row below is axis-for-axis comparable to
// `unifiedReplay.batch.groups.{A,B,C}`. VAD@400 here must reproduce group A exactly — the
// consistency check that the two sweeps are the same measurement.

/**
 * The shipping VAD's score table per span, built one commit scan per grid cell — byte-for-byte the
 * rule `eot-bench-adapters/vad-batch-adapter.mts` applies, so `VAD@400` equals P0.7's group A.
 */
function vadScoreTables(spans: ReplaySpan[], grids: Map<string, GridPoint[]>, endpointMs: number): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const span of spans) {
    const key = `${span.sampleId}#${span.spanIndex}`;
    const frame = Math.max(1, Math.round((FRAME_MS / 1000) * span.sampleRate));
    const onsetFrame = Math.floor(((span.onsetMs / 1000) * span.sampleRate) / frame);
    const table: number[] = [];
    for (const cell of grids.get(key) ?? []) {
      const cut = Math.min(span.audio.length, Math.round((cell.timestampMs / 1000) * span.sampleRate));
      const prefix = span.audio.subarray(0, cut);
      const { commitFrame } = vadCommitFrameAt(prefix, span.sampleRate, onsetFrame, endpointMs);
      const framesAvailable = Math.floor(prefix.length / frame);
      table.push(commitFrame !== Number.POSITIVE_INFINITY && commitFrame <= framesAvailable ? 1 : 0);
    }
    out.set(key, table);
  }
  return out;
}

export function runVadSweepSummaries(spans: ReplaySpan[]): Record<string, unknown> {
  const grids = new Map<string, GridPoint[]>();
  for (const span of spans) grids.set(`${span.sampleId}#${span.spanIndex}`, causalGrid(span, {}));
  const out: Record<string, unknown> = {};
  for (const endpointMs of VAD_THRESHOLDS_MS) {
    const rows = sweepGroup(spans, grids, vadScoreTables(spans, grids, endpointMs));
    out[`vad${endpointMs}`] = summarizeGroup(`VAD@${endpointMs}`, 'vnpt-vad-batch (this sweep)', rows, spans.length, { endpointMs, source: 'shipping src/shared/voiceEndpoint.ts' });
  }
  return out;
}

// ── AC1: the incumbent baseline, classified from P0.7's own evidence ─────────────────────────────

type QwenAttribution = {
  onsetWallMs: number;
  audioStartedAtMs: number;
  earliestPossibleMs: number;
  speechStartsRelMs?: number[];
  speechStopsRelMs?: number[];
  committedRelMs?: number[];
  attributedStoppedRelMs: number | null;
};
type QwenPrediction = {
  spanId: string;
  sampleId: string;
  spanIndex: number;
  silenceDurationMs: number;
  status: 'ok' | 'timeout' | 'error';
  predictionRows: Array<{ id: string; spanIndex: number; timestamp: number; silence_dur: number; p_eot: number; label: 'eot' | 'hold' }> | null;
  userWaitEndpointMs: number | null;
  modelOverheadMs: number | null;
  error: unknown;
  attribution?: QwenAttribution | null;
};

const labelOf = (p: QwenPrediction): 'eot' | 'hold' | null => p.predictionRows?.[0]?.label ?? null;
const horizonOf = (p: QwenPrediction): number => {
  const rows = p.predictionRows ?? [];
  return rows.length ? rows[rows.length - 1].silence_dur : 0;
};

/**
 * The class of one incumbent session, read off the recorded evidence (never a hand-written id list):
 *  - not a timeout → clean (the harness attributed a stop inside its window);
 *  - timeout ∧ exactly one recorded stop ∧ nothing attributed → the endpoint fired but the window
 *    missed it → MEASUREMENT false-negative (the P0.8 class);
 *  - timeout ∧ 0 stops (never fired) or ≥2 stops (fragmented) → REAL upstream latency/instability.
 */
export function classifyIncumbent(p: QwenPrediction): 'clean' | 'measurement-false-negative' | 'real-pollution' {
  if (p.status !== 'timeout') return 'clean';
  const stops = p.attribution?.speechStopsRelMs?.length ?? 0;
  const attributed = p.attribution?.attributedStoppedRelMs ?? null;
  if (attributed === null && stops === 1) return 'measurement-false-negative';
  return 'real-pollution';
}

/** A session's onset → stop wait, as the incumbent itself reports it. Null when unattributed. */
const incumbentWait = (p: QwenPrediction): number | null => p.userWaitEndpointMs;

function rollUp(entries: QwenPrediction[]): Record<string, unknown> {
  const holds = entries.filter((p) => labelOf(p) === 'hold');
  const eots = entries.filter((p) => labelOf(p) === 'eot');
  const cut = holds.filter((p) => {
    const f = incumbentWait(p);
    return f !== null && f < horizonOf(p);
  });
  const waits = eots.map(incumbentWait).filter((v): v is number => typeof v === 'number');
  // An eot is DETECTED when the incumbent reports a wait OR the session is a recovered
  // measurement-false-negative (it fired, the harness just could not time it).
  const missed = eots.filter((p) => incumbentWait(p) === null && classifyIncumbent(p) !== 'measurement-false-negative');
  return {
    sessions: entries.length,
    holds: holds.length,
    eots: eots.length,
    falseCutoffK: cut.length,
    falseCutoffN: holds.length,
    falseCutoffRate: holds.length ? Number((cut.length / holds.length).toFixed(6)) : null,
    falseCutoffRate95Ci: wilson95(cut.length, holds.length),
    falseCutoffSpans: cut.map((p) => ({ spanKey: p.spanId, pauseMs: horizonOf(p), fireMs: incumbentWait(p), status: p.status })),
    missedEndK: missed.length,
    missedEndN: eots.length,
    missedEndRate: eots.length ? Number((missed.length / eots.length).toFixed(6)) : null,
    endWaitMs: { p50: pctlOf(waits, 0.5), p90: pctlOf(waits, 0.9), n: waits.length, values: waits },
  };
}

export function incumbentBaseline(): Record<string, unknown> {
  if (!existsSync(P07_RESULT_PATH)) return { available: false, reason: `${path.relative(process.cwd(), P07_RESULT_PATH)} not found` };
  const p07 = JSON.parse(readFileSync(P07_RESULT_PATH, 'utf8')) as { unifiedReplay?: { qwenStreaming?: { predictions?: QwenPrediction[] } } };
  const all = p07.unifiedReplay?.qwenStreaming?.predictions;
  if (!all) return { available: false, reason: 'unifiedReplay.qwenStreaming.predictions absent' };

  const classified = all.map((p) => ({ p, cls: classifyIncumbent(p) }));
  const fn = classified.filter((c) => c.cls === 'measurement-false-negative').map((c) => `${c.p.spanId}@${c.p.silenceDurationMs}`);
  const polluted = classified.filter((c) => c.cls === 'real-pollution').map((c) => `${c.p.spanId}@${c.p.silenceDurationMs}`);
  // clean = everything not real-pollution (the FN sessions are KEPT — the endpoint did fire).
  const clean = classified.filter((c) => c.cls !== 'real-pollution').map((c) => c.p);

  // The annotated latency outlier: an `ok` session whose wait exceeds 3× the median ok wait.
  const okWaits = all.map(incumbentWait).filter((v): v is number => typeof v === 'number');
  const med = pctlOf(okWaits, 0.5) ?? 0;
  const outlierRuleMs = Number((3 * med).toFixed(1));
  const latencyOutliers = all.filter((p) => { const f = incumbentWait(p); return f !== null && f > outlierRuleMs; }).map((p) => `${p.spanId}@${p.silenceDurationMs}`);
  const cleanNoOutlier = clean.filter((p) => !latencyOutliers.includes(`${p.spanId}@${p.silenceDurationMs}`));

  const levels = [...new Set(all.map((p) => p.silenceDurationMs))].sort((a, b) => a - b);
  const byLevel: Record<string, unknown> = {};
  for (const lvl of levels) {
    byLevel[`level${lvl}`] = {
      before: rollUp(all.filter((p) => p.silenceDurationMs === lvl)),
      after: rollUp(clean.filter((p) => p.silenceDurationMs === lvl)),
    };
  }

  const cleanRoll = rollUp(clean);
  const cleanNoOutlierRoll = rollUp(cleanNoOutlier);
  const cleanEw = cleanRoll.endWaitMs as { p50: number | null; p90: number | null; n: number };

  return {
    available: true,
    source: 'experiments/voice-turn-detection-compare/RESULT.json → unifiedReplay.qwenStreaming.predictions',
    detector: 'qwen3.8-omni-flash-realtime upstream server_vad (silence_duration_ms 400/800)',
    classificationRule: 'status!=timeout → clean; timeout ∧ 1 stop ∧ unattributed → measurement-false-negative; otherwise → real-pollution',
    measurementFalseNegatives: fn,
    realPollution: polluted,
    latencyOutlierRule: `wait > 3× median ok wait (= ${outlierRuleMs} ms)`,
    latencyOutliers,
    denominatorBeforeAfter: {
      overall: { sessionsBefore: all.length, sessionsAfterClean: clean.length, realPollutionDropped: polluted.length, fnKept: fn.length },
      byLevel: Object.fromEntries(levels.map((lvl) => [`level${lvl}`, {
        before: all.filter((p) => p.silenceDurationMs === lvl).length,
        after: clean.filter((p) => p.silenceDurationMs === lvl).length,
      }])),
    },
    byLevel,
    /** Gate input — the incumbent's clean end-wait p90, pooled over both levels' clean eot sessions. */
    clean: {
      pooled: cleanRoll,
      pooledExcludingLatencyOutlier: cleanNoOutlierRoll,
      endWaitP90Ms: cleanEw.p90,
      endWaitP50Ms: cleanEw.p50,
      eotN: cleanEw.n,
    },
    note: 'the clean end-wait p90 is read off the incumbent\'s OWN observable latency (`userWaitEndpointMs`, onset → upstream speech_stopped), pooled across both levels\' clean eot sessions. Its n is printed; it is small and NOT a field estimate.',
  };
}

// ── gate evaluation (Stage 1) + budget sensitivity ───────────────────────────────────────────────

export function evaluateStage1Gate(stage1: ReturnType<typeof runStage1>, incumbent: Record<string, unknown>): Record<string, unknown> {
  const p90 = (incumbent.clean as { endWaitP90Ms: number | null } | undefined)?.endWaitP90Ms ?? null;
  const rows = stage1.aggregates.map((a) => {
    const r = a as Record<string, unknown>;
    const fc = r.falseCutoffRate as number | null;
    const me = r.missedEndRate as number | null;
    const ewP90 = (r.endWaitMs as { p90: number | null }).p90;
    const g1 = fc !== null && fc <= STAGE1_GATE.cutoffBudget;
    const g3 = me !== null && me <= STAGE1_GATE.missedEndBudget;
    const g2 = ewP90 !== null && p90 !== null && ewP90 <= p90;
    return { endpointMs: r.endpointMs, falseCutoffRate: fc, missedEndRate: me, endWaitP90Ms: ewP90, g1_falseCutoffUnderBudget: g1, g2_endWaitAtMostIncumbent: g2, g3_missedEndUnderBudget: g3, passes: g1 && g2 && g3 };
  });
  const passing = rows.filter((r) => r.passes).map((r) => r.endpointMs as number);
  // Sensitivity: which thresholds clear the two RATE budgets at each eot-bench budget (the latency
  // gate still applies). Reported so a reader can see how the verdict moves with the budget.
  const sensitivity = CUTOFF_BUDGET_BAND.map((budget) => {
    const ok = rows.filter((r) => {
      const fc = r.falseCutoffRate as number | null;
      const me = r.missedEndRate as number | null;
      return fc !== null && me !== null && fc <= budget && me <= budget && r.g2_endWaitAtMostIncumbent;
    }).map((r) => r.endpointMs as number);
    return { budget, thresholdsPassingWithLatencyGate: ok, anyPass: ok.length > 0 };
  });
  return {
    gate: STAGE1_GATE,
    incumbentCleanEndWaitP90Ms: p90,
    perThreshold: rows,
    sufficientThresholds: passing,
    verdict: passing.length > 0 ? 'stage1-sufficient' : 'stage1-insufficient',
    minSufficientThresholdMs: passing.length ? Math.min(...passing) : null,
    budgetSensitivity: sensitivity,
  };
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────

function main(): void {
  const corpus = loadCorpus();
  const spans = scorableSpans(corpus.spans);
  const stage1 = runStage1(corpus);
  const vadSweep = runVadSweepSummaries(spans);
  const incumbent = incumbentBaseline();
  const gate = evaluateStage1Gate(stage1, incumbent);

  // Consistency check: VAD@400 (this sweep) must reproduce P0.7's group A (both are the shipping
  // VAD at 400 ms through the same sweepGroup). If they diverge the comparison axes are wrong.
  const groupA = readP07GroupA();
  const consistency = {
    thisVad400BestAtBudget: (vadSweep.vad400 as { bestAtBudget?: unknown })?.bestAtBudget ?? null,
    p07GroupABestAtBudget: groupA?.bestAtBudget ?? null,
  };

  console.log('[stage1] thresholds', stage1.thresholds.join('/'), 'ms');
  for (const a of stage1.aggregates) {
    const r = a as Record<string, unknown>;
    const ew = r.endWaitMs as { p50: number | null; p90: number | null };
    console.log(`  E=${r.endpointMs}ms falseCutoff=${r.falseCutoffK}/${r.falseCutoffN} (${r.falseCutoffRate}) missedEnd=${r.missedEndK}/${r.missedEndN} (${r.missedEndRate}) endWaitP50=${ew.p50} P90=${ew.p90}`);
  }
  const inc = incumbent as { available?: boolean; clean?: { endWaitP90Ms: number | null; eotN: number }; realPollution?: string[]; measurementFalseNegatives?: string[]; latencyOutliers?: string[]; denominatorBeforeAfter?: unknown };
  console.log('[incumbent] available=', inc.available, 'realPollution=', (inc.realPollution ?? []).length, 'FN=', (inc.measurementFalseNegatives ?? []).length, 'latencyOutliers=', inc.latencyOutliers);
  console.log('[incumbent] before/after:', JSON.stringify(inc.denominatorBeforeAfter));
  console.log('[incumbent] clean end-wait p90 =', inc.clean?.endWaitP90Ms, 'n =', inc.clean?.eotN);
  console.log('[gate] verdict:', gate.verdict, 'minSufficient =', gate.minSufficientThresholdMs);
  console.log('[gate] sensitivity:', JSON.stringify(gate.budgetSensitivity));
  for (const E of VAD_THRESHOLDS_MS) {
    const s = vadSweep[`vad${E}`] as { bestAtBudget?: Record<string, { available?: boolean; cutoffRate?: number; missedEndpointRate?: number; meanLatencySeconds?: number }> };
    const b = s?.bestAtBudget?.budget0_1;
    console.log(`  [sweep] VAD@${E} budget0.10:`, b?.available ? `cutoff=${b.cutoffRate} missed=${b.missedEndpointRate} lat=${b.meanLatencySeconds}` : 'unavailable');
  }
  console.log('[consistency] vad400 vs p07 groupA:', JSON.stringify(consistency));

  const previous = existsSync(RESULT_PATH) ? (JSON.parse(readFileSync(RESULT_PATH, 'utf8')) as Record<string, unknown>) : {};
  const out = {
    schema: 'voice-turn-detection-compare/staged-feasibility@1',
    task: 'gap-voice-turn-detection-p0-9-staged-cheap-feasibility',
    generatedAt: new Date().toISOString(),
    zeroPaidCalls: { statement: 'this stage reads local audio + a committed RESULT.json only; it opens no socket and makes no DashScope / Qwen / Omni request', networkConnections: 0 },
    stage1: { thresholdsMs: stage1.thresholds, corpus: stage1.corpus, aggregates: stage1.aggregates, spanReadings: stage1.spanReadings },
    stage1Sweep: { rows: vadSweep, consistencyWithP07GroupA: consistency },
    incumbentCleanBaseline: incumbent,
    stage1Gate: gate,
    ...(previous.stage2 ? { stage2: previous.stage2 } : {}),
  };
  writeFileSync(RESULT_PATH, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`[stage1] wrote ${path.relative(process.cwd(), RESULT_PATH)}`);
}

/** P0.7's group A headline, read only for the consistency check above. */
function readP07GroupA(): { bestAtBudget?: unknown } | null {
  if (!existsSync(P07_RESULT_PATH)) return null;
  const p07 = JSON.parse(readFileSync(P07_RESULT_PATH, 'utf8')) as { unifiedReplay?: { batch?: { groups?: { A?: { bestAtBudget?: unknown } } } } };
  return p07.unifiedReplay?.batch?.groups?.A ?? null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
