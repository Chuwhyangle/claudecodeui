/**
 * B2 — offline shortened replay: what does shortening the end-of-turn silence wait DO to the
 * segmentation, per example, on the SAME recorded audio the earlier phases used? Zero paid calls.
 *
 * WHAT IS REPLAYED. The SHIPPING detector (`StreamingVad` + `thresholdsFor` + `FRAME_MS` from
 * `src/shared/voiceEndpoint.ts`, the module the relay runs) over the P0.6/P0.7 corpus — the same
 * audio, loaded by the same single corpus loader (`eot-bench-adapters/corpus.mts`), with the same
 * forward-quiet-run commit scan the P0.7 eot-bench VAD adapter and P0.9 Stage 1 used. The scan is
 * 12 lines and IS the measurement; it is re-stated here (not imported from P0.9, whose module writes
 * its own RESULT.json on import) and cross-checked against P0.9's committed readings below.
 *
 * WHAT IT ANSWERS. The end-of-turn wait is a knob: a SHORTER wait fires EARLIER (fewer missed turn
 * ends, but more within-turn pauses falsely cut); a LONGER wait fires later (fewer false cuts, more
 * missed ends). P0.9 measured this as RATES. This phase measures it PER EXAMPLE and, crucially, adds
 * the SEMANTIC LOSS of a wrong cut — a false cut is not one failure, it is a different injury
 * depending on WHERE the turn was cut:
 *
 *   • on a `self-correction` pause → the cut lands before the correction, so a naive pipeline commits
 *     the SUPERSEDED instruction (retraction-split — the injury the whole B3 gate exists to undo);
 *   • inside a `code-mix` English identifier → the target name is fragmented (identifier-split);
 *   • mid-clause → the instruction is broken in two (clause-split);
 *   • on an ordinary intra-utterance pause → a pause is mistaken for an end (durational-split).
 *
 * The baseline "longer wait" is the LONGEST wait in the set (1500 ms): every shorter wait is compared
 * against it, and the DELTA is the segmentation deviation that shortening introduces.
 *
 * Run:  npx tsx --tsconfig server/tsconfig.json \
 *         experiments/voice-turn-detection-compare/closing-safety-b0-b4/offline-shortened-replay.mts
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { StreamingVad, thresholdsFor, FRAME_MS } from '../../../src/shared/voiceEndpoint.ts';
import { loadCorpus, scorableSpans } from '../eot-bench-adapters/corpus.mts';
import type { Corpus, ReplaySpan } from '../eot-bench-adapters/corpus.mts';
import { causalGrid } from '../eot-bench-adapters/protocol.mts';
import type { GridPoint } from '../eot-bench-adapters/protocol.mts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const COMPARE_DIR = path.resolve(DIR, '..');
const OUT = path.join(DIR, 'RESULT.json');
const P09_RESULT = path.join(COMPARE_DIR, 'staged-feasibility', 'RESULT.json');

/** Shortened → baseline. 1500 is the in-set "longer-wait baseline"; 700 is P0.8 chain B's declared
 *  silence-wait, 500/1000 bracket it. Fixed before reading any reading. */
export const WAITS_MS = [1500, 1000, 700, 500] as const;
export const BASELINE_WAIT_MS: number = 1500;

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

/** The frame at which the shipping detector declares the utterance over, from the span's own onset,
 *  at silence-wait `endpointMs`. `Infinity` when the prefix holds no quiet run that long. */
function vadCommitFrameAt(
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

/** Time from the span onset to the commit (ms), or null when the detector never commits in-prefix. */
function readSpan(span: ReplaySpan, endpointMs: number): number | null {
  const rate = span.sampleRate;
  const frame = Math.max(1, Math.round((FRAME_MS / 1000) * rate));
  const grid: GridPoint[] = causalGrid(span, {});
  if (grid.length === 0) return null;
  const dMax = grid[grid.length - 1].silenceDurMs;
  const cut = Math.min(span.audio.length, Math.round(((span.onsetMs + dMax) / 1000) * rate));
  const prefix = span.audio.subarray(0, cut);
  const onsetFrame = Math.floor(((span.onsetMs / 1000) * rate) / frame);
  const { commitFrame } = vadCommitFrameAt(prefix, rate, onsetFrame, endpointMs);
  if (!Number.isFinite(commitFrame)) return null;
  const commitMs = (commitFrame * frame * 1000) / rate;
  return Math.max(0, commitMs - span.onsetMs);
}

// ── semantic-loss classification ─────────────────────────────────────────────────────────────────

type LossClass = 'none' | 'retraction-split' | 'identifier-split' | 'clause-split' | 'durational-split' | 'turn-not-closed';
/** 3 = superseded instruction reaches the agent; 2 = instruction/target fragmented; 1 = timing cost. */
const LOSS_SEVERITY: Record<LossClass, number> = {
  none: 0,
  'retraction-split': 3,
  'identifier-split': 3,
  'clause-split': 2,
  'durational-split': 1,
  'turn-not-closed': 1,
};

/** Scenario keys the corpus uses, mapped to the injury a false cut inflicts. Unknown → clause-split. */
function holdLoss(scenario: string): LossClass {
  const s = scenario.toLowerCase();
  if (s.includes('self-correction') || s.includes('correction')) return 'retraction-split';
  if (s.includes('code-mix') || s.includes('code_mix') || s.includes('mixed')) return 'identifier-split';
  if (s.includes('mid-sentence') || s.includes('mid_sentence')) return 'clause-split';
  if (s.includes('plain-pause') || s.includes('plain')) return 'durational-split';
  return 'clause-split';
}

type WaitReading = {
  waitMs: number;
  fireMs: number | null;
  /** hold: did the commit land INSIDE the pause (the speaker had not resumed)? eot: did it commit? */
  falseCutoff: boolean;
  detected: boolean;
  lossClass: LossClass;
  lossSeverity: number;
  /** relative to the longest-wait baseline: a false cut the BASELINE did not make. */
  newVsBaseline: boolean;
};

type SpanReading = {
  spanKey: string;
  sampleId: string;
  spanIndex: number;
  label: 'eot' | 'hold';
  truth: string;
  scenario: string;
  source: 'synthetic' | 'real';
  language: 'en' | 'zh';
  silenceMs: number;
  byWait: WaitReading[];
};

function readWaits(span: ReplaySpan): WaitReading[] {
  const fires = WAITS_MS.map((w) => ({ w, fireMs: readSpan(span, w) }));
  const baseline = fires.find((f) => f.w === BASELINE_WAIT_MS) ?? fires[0];
  const baseCut = span.label === 'hold' && baseline.fireMs !== null && baseline.fireMs < span.silenceMs;
  return fires.map(({ w, fireMs }) => {
    if (span.label === 'hold') {
      const falseCutoff = fireMs !== null && fireMs < span.silenceMs;
      const lossClass: LossClass = falseCutoff ? holdLoss(span.scenario) : 'none';
      return { waitMs: w, fireMs, falseCutoff, detected: falseCutoff, lossClass, lossSeverity: LOSS_SEVERITY[lossClass], newVsBaseline: falseCutoff && !baseCut };
    }
    const detected = fireMs !== null;
    const lossClass: LossClass = detected ? 'none' : 'turn-not-closed';
    return { waitMs: w, fireMs, falseCutoff: false, detected, lossClass, lossSeverity: LOSS_SEVERITY[lossClass], newVsBaseline: false };
  });
}

// ── P0.9 cross-check: our scan must reproduce P0.9's committed per-point reading ─────────────────

function crossCheck(spanReadings: SpanReading[]): Record<string, unknown> {
  if (!existsSync(P09_RESULT)) return { available: false, reason: 'P0.9 RESULT.json absent' };
  const p09 = JSON.parse(readFileSync(P09_RESULT, 'utf8')) as { stage1?: { spanReadings?: Array<{ spanKey: string; byThreshold: Array<{ endpointMs: number; fireMs: number | null; falseCutoff: boolean | null; detected: boolean | null }> }> } };
  const rows = p09.stage1?.spanReadings ?? [];
  const byKey = new Map(rows.map((r) => [r.spanKey, r]));
  const overlaps = [500, 1500];
  const compared: Array<{ spanKey: string; waitMs: number; ours: number | null; p09: number | null; agree: boolean }> = [];
  for (const sr of spanReadings) {
    const p = byKey.get(sr.spanKey);
    if (!p) continue;
    for (const w of overlaps) {
      const ours = sr.byWait.find((x) => x.waitMs === w)?.fireMs ?? null;
      const theirs = p.byThreshold.find((x) => x.endpointMs === w)?.fireMs ?? null;
      compared.push({ spanKey: sr.spanKey, waitMs: w, ours, p09: theirs, agree: ours === theirs });
    }
  }
  const agree = compared.filter((c) => c.agree).length;
  return {
    available: true,
    source: path.relative(COMPARE_DIR, P09_RESULT),
    overlappingWaitsMs: overlaps,
    comparedCount: compared.length,
    agreeCount: agree,
    allAgree: compared.length > 0 && agree === compared.length,
    note: 'our forward-quiet-run scan vs P0.9 Stage 1 (the same VAD, the same commit rule) on the sample keys present in both corpora, at the two shared waits',
    disagreements: compared.filter((c) => !c.agree).slice(0, 10),
  };
}

// ── run ──────────────────────────────────────────────────────────────────────────────────────────

function main(): void {
  const corpus: Corpus = loadCorpus();
  const spans = scorableSpans(corpus.spans);
  const spanReadings: SpanReading[] = spans.map((span) => ({
    spanKey: `${span.sampleId}#${span.spanIndex}`,
    sampleId: span.sampleId,
    spanIndex: span.spanIndex,
    label: span.label,
    truth: span.truth,
    scenario: span.scenario,
    source: span.source,
    language: span.language,
    silenceMs: span.silenceMs,
    byWait: readWaits(span),
  }));

  // The CORRECTION span is the single most semantic point in the corpus; scorableSpans drops it from
  // the END/CONTINUE sweep, so it is read into its own section rather than silently lost.
  const correctionReadings = corpus.correctionSpans.map((span) => ({
    spanKey: `${span.sampleId}#${span.spanIndex}`,
    sampleId: span.sampleId,
    scenario: span.scenario,
    silenceMs: span.silenceMs,
    byWait: readWaits({ ...span, label: 'hold' as const }),
  }));

  const perWait = WAITS_MS.map((w) => {
    const holds = spanReadings.filter((s) => s.label === 'hold');
    const eots = spanReadings.filter((s) => s.label === 'eot');
    const cut = holds.filter((s) => s.byWait.find((x) => x.waitMs === w)?.falseCutoff);
    const missed = eots.filter((s) => !s.byWait.find((x) => x.waitMs === w)?.detected);
    const lossMass = spanReadings.reduce((a, s) => a + (s.byWait.find((x) => x.waitMs === w)?.lossSeverity ?? 0), 0);
    const newCuts = spanReadings.filter((s) => s.byWait.find((x) => x.waitMs === w)?.newVsBaseline);
    return {
      waitMs: w,
      isBaseline: w === BASELINE_WAIT_MS,
      falseCutoffK: cut.length,
      falseCutoffN: holds.length,
      falseCutoffRate: holds.length ? Number((cut.length / holds.length).toFixed(6)) : null,
      missedEndK: missed.length,
      missedEndN: eots.length,
      missedEndRate: eots.length ? Number((missed.length / eots.length).toFixed(6)) : null,
      semanticLossMass: lossMass,
      lossByClass: spanReadings.reduce<Record<string, number>>((a, s) => {
        const c = s.byWait.find((x) => x.waitMs === w)?.lossClass ?? 'none';
        if (c !== 'none') a[c] = (a[c] ?? 0) + 1;
        return a;
      }, {}),
      newFalseCutoffsVsBaselineK: newCuts.length,
    };
  });

  const section = {
    schema: 'voice-turn-detection-closing-safety/b2-offline-shortened-replay@1',
    task: 'gap-voice-turn-detection-p0-10-closing-safety-b0-b4',
    kind: 'B2 — offline shortened replay (zero paid upstream calls)',
    method: {
      detector: 'SHIPPING StreamingVad + thresholdsFor (src/shared/voiceEndpoint.ts), the relay’s own module',
      corpus: 'eot-bench-adapters/corpus.mts → run.mts buildAllSamples() (the same P0.6/P0.7 audio; real LibriSpeech/THCHS-30 fetched by the committed script, authored fixtures committed)',
      commitRule: 'forward-quiet-run scan at the wait (mirrors eot-bench-adapters/vad-batch-adapter.mts and P0.9 Stage 1)',
      waitsMs: WAITS_MS,
      baselineWaitMs: BASELINE_WAIT_MS,
      isRealReplay: 'real re-decode of the recorded PCM through the shipping detector at each wait — not interpolation and not a rate-only summary',
      semanticLoss: 'a false cut is classified by WHERE the turn was cut (scenario-derived); severity 3 = superseded instruction reaches the agent, 2 = instruction/target fragmented, 1 = timing cost',
    },
    corpus: {
      sampleCount: corpus.sampleCount,
      spanCount: corpus.spans.length,
      scorableSpanCount: spans.length,
      holdCount: spanReadings.filter((s) => s.label === 'hold').length,
      eotCount: spanReadings.filter((s) => s.label === 'eot').length,
      correctionSpanCount: corpus.correctionSpans.length,
      bySource: spanReadings.reduce<Record<string, number>>((a, s) => ((a[s.source] = (a[s.source] ?? 0) + 1), a), {}),
      byScenario: spanReadings.reduce<Record<string, number>>((a, s) => ((a[s.scenario] = (a[s.scenario] ?? 0) + 1), a), {}),
    },
    perWait,
    correctionSpans: correctionReadings,
    perSpan: spanReadings,
    crossCheckP09: crossCheck(spanReadings),
    budget: { newUpstreamCalls: 0, spendCny: 0, note: 'B2 makes no paid upstream call; it re-decodes local audio' },
  };

  const existing = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, 'utf8')) as Record<string, unknown>) : {};
  existing.schema = existing.schema ?? 'voice-turn-detection-closing-safety/result@1';
  existing.task = 'gap-voice-turn-detection-p0-10-closing-safety-b0-b4';
  existing.b2 = section;
  writeFileSync(OUT, JSON.stringify(existing, null, 2) + '\n');

  console.log('B2 offline shortened replay complete');
  console.log(`  corpus: ${corpus.sampleCount} samples, ${spans.length} scorable spans (${section.corpus.holdCount} hold / ${section.corpus.eotCount} eot), ${corpus.correctionSpans.length} correction`);
  for (const w of perWait) {
    console.log(`  wait ${String(w.waitMs).padStart(4)}ms: false-cut ${w.falseCutoffK}/${w.falseCutoffN} (${w.falseCutoffRate}), missed-end ${w.missedEndK}/${w.missedEndN} (${w.missedEndRate}), lossMass ${w.semanticLossMass}, new-cuts-vs-baseline ${w.newFalseCutoffsVsBaselineK}`);
  }
  console.log('  P0.9 cross-check:', JSON.stringify((section.crossCheckP09 as Record<string, unknown>).allAgree), `(${(section.crossCheckP09 as Record<string, unknown>).agreeCount}/${(section.crossCheckP09 as Record<string, unknown>).comparedCount} agree)`);
}

main();
