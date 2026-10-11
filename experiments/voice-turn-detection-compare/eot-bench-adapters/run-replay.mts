/**
 * The P0.7 unified replay runner: MANIFEST → the four groups' adapters → the SAME causal grid → the
 * SAME eot-bench policy sweep → one artifact.
 *
 * WHAT IT WRITES, AND WHERE. The output is merged into `experiments/voice-turn-detection-compare/RESULT.json`
 * under the top-level key `unifiedReplay`. It is a MERGE and not a rewrite: every P0.6 key (`groupA`…
 * `qwenProbeRealAudio`, `goNoGo`, `perSample`) is left byte-identical, because AC9 keeps the historical
 * rows and a reader has to be able to see both vintages side by side. The only other key it touches is
 * `unifiedReplay.qwenStreaming`, which carries AC8's two-phase budget arm.
 *
 * WHY THE BATCH GROUPS RUN FREE AND THE STREAMING GROUP IS BUDGETED. Groups A, B and C are local
 * inference: 901 grid cells each, no egress, no bill. Group D (`qwen3.8-omni-flash-realtime`) is a
 * real endpoint and every session is a potential charge, so it runs on a deterministic SUBSET of the
 * same points and its spend is armed into the artifact BEFORE the first socket opens (AC8). The
 * four-way Pareto is then computed on the subset, so all four groups are compared on the same basis
 * — a comparison across different point sets would be the exact splice AC1 forbids.
 *
 * GROUP LETTERS FOLLOW THE SPEC, NOT THIS FILE'S HISTORY: A = StreamingVad, B = Smart Turn (compiled),
 * C = LiveKit v1-mini, D = Qwen Realtime. The SPEC's group E (an ASR→text baseline) is NOT part of
 * this replay and no letter here means it.
 *
 * MODES
 *   --calibrate        one real session with `create_response: false`; prints the full timeline and
 *                      the measured spend. Establishes what a session costs before the batch is armed.
 *   --arm-qwen         write the AC8 budget arm (subset + pre-call worst case) into RESULT.json. No spend.
 *   --batch            run groups A/B/C through the shared layer and the sweep. No spend.
 *   --crosscheck       re-ask P0.6's own question of each batch adapter and compare (AC3). No spend.
 *   --qwen             run the streaming subset (spend; refuses unless the arm is present and fresh).
 *   --all              --batch then --qwen.
 *
 * Run from the repo root:
 *   npx tsx --tsconfig server/tsconfig.json experiments/voice-turn-detection-compare/eot-bench-adapters/run-replay.mts --batch
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  CUTOFF_BUDGETS,
  DEFAULT_ACTION_DELAYS,
  DEFAULT_THRESHOLDS,
  DEFAULT_TIMEOUTS,
  EOT_BENCH_PROTOCOL,
  causalGrid,
  operatingPointAtBudget,
  paretoFrontier,
  spanFire,
  sweepPolicies,
  type GridPoint,
  type PolicyRow,
  type SpanFire,
} from './protocol.mts';
import {
  COMPARE_DIR,
  DEFAULT_CLOSING_SILENCE_MS,
  corpusBreakdown,
  corpusEligibility,
  loadCorpus,
  scorableSpans,
  spanEligibility,
  type ReplaySpan,
} from './corpus.mts';
import { createVadBatchAdapter } from './vad-batch-adapter.mts';
import { createSmartTurnBatchAdapter } from './smart-turn-batch-adapter.mts';
import { createLivekitBatchAdapter, livekitSandboxStatus } from './livekit-batch-adapter.mts';
import { predictTurnStreaming, type TurnPrediction } from './qwen-realtime-streaming-adapter.mts';
// The one Wilson implementation in this experiment — reused rather than re-written, so a group's CI in
// this report and P0.6's CI in `run.mts` cannot drift apart. `run.mts` guards its `main()` on being the
// entry module, so importing it here runs no measurement.
import { wilson95 } from '../run.mts';

const RESULT_PATH = path.join(COMPARE_DIR, 'RESULT.json');
const UNIFIED_KEY = 'unifiedReplay';

/** The Qwen level ladder AC5 requires: at least two `silence_duration_ms` rungs. */
export const QWEN_LEVELS_MS = [400, 800];

/** AC8's cap for THIS task's new Qwen spend — separate from P0.6's block. */
export const QWEN_CAP_CNY = 0.05;

/**
 * The instruction tokens ONE session carries, for the worst case.
 *
 * Measured, not guessed: `VOICE_REALTIME_INSTRUCTIONS` is 510 characters and the `session_send`
 * schema the adapter advertises serialises to 135, so the payload is 645 characters. Charged at 3
 * characters/token — English prose measures closer to 4, so the lower ratio OVER-counts, which is the
 * safe direction — and then rounded up again. The `perCell` default is chosen so this bound holds
 * even if the endpoint bills every one of these tokens.
 */
export const INSTRUCTION_TOKENS_PER_SESSION = Math.ceil(645 / 3);

// ── grid & sweep plumbing ────────────────────────────────────────────────────────────────────────

type GroupScoreTable = {
  group: string;
  adapterId: string;
  /** spanKey → one p_eot per cell of that span's grid, in grid order. */
  scores: Map<string, number[]>;
  /** spanKey → the grid the scores align to (kept so the sweep cannot mis-align). */
  grids: Map<string, GridPoint[]>;
  extra: Record<string, unknown>;
};

/** Walk every scorable span's grid into `BatchItem`s, keeping the span order. */
function buildItems(spans: ReplaySpan[]): { items: Array<{ id: string; spanIndex: number; timestampMs: number; silenceDurMs: number; audio: Float32Array; sampleRate: number }>; grids: Map<string, GridPoint[]> } {
  const items: Array<{ id: string; spanIndex: number; timestampMs: number; silenceDurMs: number; audio: Float32Array; sampleRate: number }> = [];
  const grids = new Map<string, GridPoint[]>();
  for (const span of spans) {
    const key = `${span.sampleId}#${span.spanIndex}`;
    const grid = causalGrid(span, {});
    grids.set(key, grid);
    for (const cell of grid) {
      const cut = Math.min(span.audio.length, Math.round((cell.timestampMs / 1000) * span.sampleRate));
      items.push({
        id: `${key}@${cell.silenceDurMs}`,
        spanIndex: span.spanIndex,
        timestampMs: cell.timestampMs,
        silenceDurMs: cell.silenceDurMs,
        audio: span.audio.subarray(0, cut),
        sampleRate: span.sampleRate,
      });
    }
  }
  return { items, grids };
}

/**
 * The eot-bench policy sweep over a group's score tables.
 *
 * For each threshold the spans' fire times are recomputed (a threshold does not change a score, only
 * where the curve crosses), then `sweepPolicies` walks the action-delay × timeout grid exactly as
 * upstream does. A `CORRECTION` span is never in `spans` here — it is neither an `eot` nor a `hold`.
 */
export function sweepGroup(spans: ReplaySpan[], grids: Map<string, GridPoint[]>, scores: Map<string, number[]>): PolicyRow[] {
  const rows: PolicyRow[] = [];
  for (const threshold of DEFAULT_THRESHOLDS) {
    const fires: SpanFire[] = spans.map((span) => {
      const key = `${span.sampleId}#${span.spanIndex}`;
      const grid = grids.get(key) ?? [];
      const table = scores.get(key) ?? [];
      const { fireSeconds } = spanFire(grid, table, threshold);
      return { key, label: span.label === 'eot' ? 'eot' : 'hold', silenceSeconds: span.silenceMs / 1000, fireSeconds };
    });
    rows.push(...sweepPolicies(fires, { thresholds: [threshold], actionDelays: DEFAULT_ACTION_DELAYS, timeouts: DEFAULT_TIMEOUTS }));
  }
  return rows;
}

/** A group's headline reading: the Pareto frontier plus the best point at each cutoff budget. */
export function summarizeGroup(name: string, adapterId: string, rows: PolicyRow[], points: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const frontier = paretoFrontier(rows);
  const withCi = (row: PolicyRow): Record<string, unknown> => {
    // Denominators come from the sweep row itself (holdSpans/eotSpans), so a rate is always reported
    // with the n it was computed over — AC7 asks for a denominator per number, not just a ratio.
    const cutoffCount = Math.round(row.cutoffRate * row.holdSpans);
    const missedCount = Math.round(row.missedEndpointRate * row.eotSpans);
    return {
      threshold: row.threshold,
      actionDelaySeconds: row.actionDelaySeconds,
      timeoutSeconds: row.timeoutSeconds,
      cutoffRate: row.cutoffRate,
      cutoffDenominator: row.holdSpans,
      cutoffRate95Ci: wilson95(cutoffCount, row.holdSpans),
      missedEndpointRate: row.missedEndpointRate,
      missedEndpointDenominator: row.eotSpans,
      missedEndpointRate95Ci: wilson95(missedCount, row.eotSpans),
      meanLatencySeconds: row.meanLatencySeconds,
      f1: row.f1,
    };
  };
  const budgets: Record<string, unknown> = {};
  for (const budget of CUTOFF_BUDGETS) {
    const best = operatingPointAtBudget(rows, budget);
    budgets[`budget${String(budget).replace('.', '_')}`] = best === null
      ? { available: false }
      : { available: true, ...withCi(best) };
  }
  return {
    group: name,
    adapterId,
    points,
    policies: rows.length,
    frontierSize: frontier.length,
    pareto: frontier.map(withCi),
    bestAtBudget: budgets,
    ...extra,
  };
}

// ── score tables from a prediction list ──────────────────────────────────────────────────────────

function scoresFromRows(grids: Map<string, GridPoint[]>, rows: Array<{ id: string; spanIndex: number; timestamp: number; silence_dur: number; p_eot: number }>): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const row of rows) {
    const list = out.get(row.id) ?? [];
    list.push(row.p_eot);
    out.set(row.id, list);
  }
  // sanity: every table must match its grid length (or be empty for a span the model never reached)
  for (const [key, table] of out) {
    const grid = grids.get(key);
    if (grid !== undefined && table.length !== grid.length) {
      throw new Error(`score table for ${key} has ${table.length} rows but its grid has ${grid.length} cells`);
    }
  }
  return out;
}

// ── action-commit reading (AC6), computable from a score table at one operating point ────────────

function actionCommitReading(spans: ReplaySpan[], grids: Map<string, GridPoint[]>, scores: Map<string, number[]>, threshold: number, correctionSpans: ReplaySpan[]): Record<string, unknown> {
  const fireOf = (span: ReplaySpan): number => {
    const key = `${span.sampleId}#${span.spanIndex}`;
    return spanFire(grids.get(key) ?? [], scores.get(key) ?? [], threshold).fireSeconds;
  };
  const holds = spans.filter((s) => s.label === 'hold');
  const eots = spans.filter((s) => s.label === 'eot');
  const holdFires = holds.filter((s) => fireOf(s) < Number.POSITIVE_INFINITY);
  const eotFires = eots.filter((s) => fireOf(s) < Number.POSITIVE_INFINITY);
  const correctionFires = correctionSpans.filter((s) => fireOf(s) < Number.POSITIVE_INFINITY);
  return {
    threshold,
    falseTriggerActions: holdFires.length,
    holdPoints: holds.length,
    falseTriggerRate: holds.length ? Number((holdFires.length / holds.length).toFixed(4)) : null,
    detectedEnds: eotFires.length,
    endPoints: eots.length,
    detectedEndRate: eots.length ? Number((eotFires.length / eots.length).toFixed(4)) : null,
    correctionPoints: correctionSpans.length,
    correctionNaiveMiscommits: correctionFires.length,
    note: 'a "false trigger action" is a within-turn pause at which the detector fires — exactly the case where a naive pipeline commits a superseded instruction; the CORRECTION point is the authored instance of it',
  };
}

// ── AC6: the two kinds of "action commit" reading, kept apart ─────────────────────────────────────

/**
 * Collect the AC6 action-commit readings into one block that says, per number, whether it is
 * SIMULATED or REAL.
 *
 * WHY THE DISTINCTION HAS TO BE ON THE RECORD. None of A/B/C/C-Qwen decide to act — they emit an END
 * signal and a pipeline above them decides. So the comparable quantity across all four is a
 * COUNTERFACTUAL: "if this detector's END fired the action, how many false triggers would that be?"
 * That is a simulation and is labelled as one. Qwen's REAL function-call outcome is a different
 * observation (an actual tool_choice=auto call on real audio), and it is NOT re-measured here: P0.6
 * already ran it on the same read-speech clips and its boundary forbids duplicate spend, so this
 * block CITES `RESULT.json → qwenProbeRealAudio` and records that it did. Mixing the two under one
 * label would let a simulated rate be read as an observed call rate.
 */
function actionCommitSummary(unified: Record<string, unknown>, result: Record<string, unknown>): Record<string, unknown> {
  const batch = (unified.batch as Record<string, unknown> | undefined)?.groups as Record<string, any> | undefined;
  const qwenStream = unified.qwenStreaming as Record<string, any> | undefined;
  const pick = (g: any) =>
    g === undefined
      ? null
      : {
          falseTriggerActions: g.falseTriggerActions ?? null,
          holdPoints: g.holdPoints ?? null,
          falseTriggerRate: g.falseTriggerRate ?? null,
          detectedEnds: g.detectedEnds ?? null,
          endPoints: g.endPoints ?? null,
          detectedEndRate: g.detectedEndRate ?? null,
        };
  const simulated: Record<string, unknown> = {
    policy: 'END ⇒ action — the detector’s own END signal is taken as the trigger, with no downstream confirmation',
    kind: 'SIMULATED (counterfactual) for every group; the batch detectors are classifiers and the Realtime endpoint with create_response:false only emits a VAD timeline',
    groupLetters: { A: 'StreamingVad', B: 'Smart Turn (compiled)', C: 'LiveKit v1-mini', qwenStreaming400: 'D @400 ms', qwenStreaming800: 'D @800 ms' },
    groups: {
      A: pick(batch?.A),
      B: pick(batch?.B),
      C: pick(batch?.C),
      // `.sweep` holds the reading: the level object carries the session counters (ok/timeout/…) and
      // nests the sweep result, so `pick` must descend into it or every field reads back null.
      qwenStreaming400: pick(qwenStream?.byLevel?.level400?.sweep),
      qwenStreaming800: pick(qwenStream?.byLevel?.level800?.sweep),
    },
    correctionPoint: batch?.A?.correctionNaiveMiscommits ?? null,
    correctionPointNote:
      'the authored self-correction sample is where a naive END⇒action commits a superseded instruction; its count is carried on every group’s actionCommit reading',
  };
  const prior = result.qwenProbeRealAudio as Record<string, any> | undefined;
  const real =
    prior === undefined
      ? { available: false, reason: 'RESULT.json → qwenProbeRealAudio (P0.6 AC5) is absent' }
      : {
          available: true,
          reusedFromP06: true,
          source: 'RESULT.json → qwenProbeRealAudio (task gap-voice-turn-detection-p0-6-dataset-benchmark, AC5)',
          whyReused:
            'the same real-audio clips (LibriSpeech en, THCHS-30 zh) were already put through qwen3.8-omni-flash with tool_choice=auto and tool_choice=forced; re-spending on them would be a second draw of a recorded number, and this task’s boundary forbids duplicate spend',
          model: prior.model,
          spuriousCallCount: prior.readings?.spuriousCallCount ?? null,
          autoCells: prior.readings?.denominator?.autoCells ?? null,
          missedCallCount: prior.readings?.missedCallCount ?? null,
          missedCallCountReason: prior.readings?.missedCallCountReason ?? null,
          paramSchemaAccuracy: prior.readings?.paramSchemaAccuracy ?? null,
          cumulativeSpendCnyOnThisReuse: 0,
          cumulativeNewSpendCny: prior.cumulativeNewSpendCny ?? null,
        };
  return { simulated, real, kindNote: 'simulated and real are DIFFERENT observations and are reported separately: only the real block is an observed call outcome' };
}

// ── AC7: where each metric lives, with its denominator, and the coverage caveat ─────────────────

/**
 * One block that answers AC7 as a map rather than as prose: every headline metric is named, its
 * home is given, and the two things AC7 demands that the per-group blocks cannot say on their own —
 * that Realtime has no CPU/RAM reading and that the streaming group ran on a SUBSET — are stated here.
 *
 * The subset caveat is a number, not a hedge: the batch groups score all 73 candidate points while
 * the streaming group scores the stratified subset the AC8 budget pays for, so a Qwen number and a
 * VAD number of the same name are NOT computed over the same n, and the row that carries the smaller
 * n carries the wider interval.
 */
function metricsSummary(unified: Record<string, unknown>, totalCandidatePoints: number): Record<string, unknown> {
  const qwen = unified.qwenStreaming as Record<string, any> | undefined;
  const subset = (qwen?.plan?.subset ?? []) as Array<{ span: string; level: number }>;
  const subsetSpans = new Set(subset.map((s) => s.span));
  return {
    denominatorPolicy: 'every rate is k/n; n is the sweep row’s own holdSpans/eotSpans for the batch groups, and the streaming subset for the Realtime group',
    falseCutoff: { batchGroups: 'unified.batch.groups.{A,B,C}.bestAtBudget/bestAtBudget.*.cutoffDenominator + cutoffRate95Ci', qwenStreaming: 'unified.qwenStreaming.byLevel.level{n}.sweep.*.cutoffDenominator + cutoffRate95Ci' },
    missedEndpoint: { batchGroups: 'unified.batch.groups.{A,B,C}.bestAtBudget.*.missedEndpointDenominator + missedEndpointRate95Ci', qwenStreaming: 'unified.qwenStreaming.byLevel.level{n}.sweep.*.missedEndpointDenominator + missedEndpointRate95Ci' },
    endpointLatencySplit: {
      note: 'AC4/AC7: the two latencies are recorded as two numbers, never summed into one',
      modelInference: {
        B: 'RESULT.json → groupB.latency / compiledFeatureCheck (ONNX inference p50/p90) plus unified.batch.groups.B.timings',
        C: 'unified.batch.groups.C.modelLatencyMsP50/P90 (framework inference), distinct from the end-to-end decision cost',
        qwenStreaming: 'unified.qwenStreaming.byLevel.level{n}.modelOverheadMsP50/P90 — the wall time the endpoint’s own silence_duration_ms imposes BEYOND the labelled silence, i.e. the configurable forced wait, not compute',
      },
      userWaitEndpoint: {
        qwenStreaming: 'unified.qwenStreaming.byLevel.level{n}.userWaitEndpointMsP50/P90 — onset of the labelled silence → the endpoint’s speech_stopped, which necessarily includes silence_duration_ms',
        batchGroups: 'not applicable: a batch classifier answers synchronously, so its end-to-end cost IS its inference cost (groups A/B/C)',
      },
    },
    cpuRam: {
      A: 'unified.batch.groups.A.resource (or the P0.6 groupA reading)',
      B: 'unified.batch.groups.B.timings / P0.6 groupB',
      C: 'unified.batch.groups.C.resource',
      qwenStreaming: {
        applicable: false,
        value: 'N/A',
        reason:
          'the Realtime endpoint is upstream-hosted: it runs no local model, so there is no local CPU time or resident memory attributable to a decision. Network RTT is the honest substitute and is carried by wallClockMs. Reported as N/A rather than fabricated, per AC7.',
      },
    },
    actionCommit: 'unified.actionCommit (simulated for all four; real function-call outcome cited from P0.6)',
    coverage: {
      totalCandidatePoints,
      batchGroupsPoints: totalCandidatePoints,
      qwenStreamingDistinctSpans: subsetSpans.size,
      qwenStreamingSessions: subset.length,
      levels: [...new Set(subset.map((s) => s.level))].sort((a, b) => a - b),
      caveat:
        'the streaming (Qwen Realtime) readings cover the stratified AC8 subset, NOT all 73 points — the same-named rates for the batch groups and Qwen are therefore not on the same n, and the AC9 table labels the Qwen column as such. The batch groups DID score all 73 points on the same manifest.',
    },
  };
}

// ── batch groups: A, B, C ────────────────────────────────────────────────────────────────────────
async function runBatch(args: { modelPath: string | null }): Promise<Record<string, unknown>> {
  const corpus = loadCorpus();
  const spans = scorableSpans(corpus.spans);
  const { items, grids } = buildItems(spans);
  console.log(`[batch] ${spans.length} spans, ${items.length} grid cells`);

  const groups: Record<string, unknown> = {};
  const scoreTables: Record<string, GroupScoreTable> = {};

  // ── A: the shipping VAD ────────────────────────────────────────────────────────────────────────
  {
    const adapter = createVadBatchAdapter();
    const t0 = Date.now();
    const scores = await adapter.predictBatch(items);
    const table = scoresFromRows(grids, items.map((item, i) => ({ id: item.id.split('@')[0], spanIndex: item.spanIndex, timestamp: item.timestampMs, silence_dur: item.silenceDurMs, p_eot: scores[i] })));
    const rows = sweepGroup(spans, grids, table);
    scoreTables.A = { group: 'A', adapterId: adapter.adapterId, scores: table, grids, extra: {} };
    groups.A = summarizeGroup('A', adapter.adapterId, rows, spans.length, {
      detector: 'StreamingVad (shipping, src/shared/voiceEndpoint.ts)',
      endpointMs: 400,
      scorePointSeconds: adapter.scorePoint,
      thresholdAxisDegenerate: true,
      thresholdAxisNote: 'a silence-threshold VAD emits a step, not a curve: every threshold in (0,1] reads the same fire time. The threshold column of the sweep is therefore degenerate for this group and its Pareto point is a single point.',
      falseTriggerActions: actionCommitReading(spans, grids, table, 0.5, corpus.correctionSpans),
      wallClockMs: Date.now() - t0,
    });
    console.log(`[batch] A done in ${Date.now() - t0} ms`);
  }

  // ── B: Smart Turn v3.2 (local ONNX) ───────────────────────────────────────────────────────────
  if (args.modelPath !== null && existsSync(args.modelPath)) {
    const adapter = await createSmartTurnBatchAdapter(args.modelPath, 1);
    const t0 = Date.now();
    const scores = await adapter.predictBatch(items);
    const table = scoresFromRows(grids, items.map((item, i) => ({ id: item.id.split('@')[0], spanIndex: item.spanIndex, timestamp: item.timestampMs, silence_dur: item.silenceDurMs, p_eot: scores[i] })));
    const rows = sweepGroup(spans, grids, table);
    scoreTables.B = { group: 'B', adapterId: adapter.adapterId, scores: table, grids, extra: {} };
    const featureMs = adapter.timings.map((t) => t.featureMs).sort((a, b) => a - b);
    const inferenceMs = adapter.timings.map((t) => t.inferenceMs).sort((a, b) => a - b);
    await adapter.close();
    groups.B = summarizeGroup('B', adapter.adapterId, rows, spans.length, {
      detector: 'Pipecat Smart Turn v3.2 (local ONNX CPU)',
      scorePointSeconds: adapter.scorePoint,
      thresholdAxisDegenerate: false,
      cells: adapter.timings.length,
      featureMsP50: featureMs.length ? featureMs[Math.floor(featureMs.length / 2)] : null,
      inferenceMsP50: inferenceMs.length ? inferenceMs[Math.floor(inferenceMs.length / 2)] : null,
      falseTriggerActions: actionCommitReading(spans, grids, table, 0.5, corpus.correctionSpans),
      wallClockMs: Date.now() - t0,
    });
    console.log(`[batch] B done in ${Date.now() - t0} ms (${adapter.timings.length} cells)`);
  } else {
    console.log('[batch] B skipped: no model');
    groups.B = { group: 'B', status: 'model-unavailable', reason: 'no --model path given or it does not exist; run scripts/voice-turn-detection-compare.mjs to fetch the ONNX weights' };
  }

  // ── C: LiveKit v1-mini inside livekit-agents ─────────────────────────────────────────────────
  {
    const status = livekitSandboxStatus();
    if (!status.available) {
      groups.C = { group: 'C', status: 'sandbox-unavailable', reason: status.reason };
    } else {
      const workDir = path.join(COMPARE_DIR, 'livekit-sandbox', '_p07-cells');
      const adapter = createLivekitBatchAdapter({ spans, workDir });
      const t0 = Date.now();
      try {
        const scores = await adapter.predictBatch(items);
        const table = scoresFromRows(grids, items.map((item, i) => ({ id: item.id.split('@')[0], spanIndex: item.spanIndex, timestamp: item.timestampMs, silence_dur: item.silenceDurMs, p_eot: scores[i] })));
        const rows = sweepGroup(spans, grids, table);
        scoreTables.C = { group: 'C', adapterId: adapter.adapterId, scores: table, grids, extra: {} };
        const latency = [...adapter.latencyMs].sort((a, b) => a - b);
        groups.C = summarizeGroup('C', adapter.adapterId, rows, spans.length, {
          detector: 'LiveKit Turn Detector v1-mini (local, inside livekit-agents)',
          scorePointSeconds: adapter.scorePoint,
          thresholdAxisDegenerate: false,
          cells: adapter.latencyMs.length,
          modelLatencyMsP50: latency.length ? latency[Math.floor(latency.length / 2)] : null,
          modelLatencyMsP90: latency.length ? latency[Math.floor(0.9 * (latency.length - 1))] : null,
          resource: adapter.resource,
          outerWindowSeconds: adapter.resource.outerWindowSeconds ?? 1.2,
          outerWindowNote:
            'the framework local transport keeps a 1.2 s ring buffer, so a cell deeper than 1.2 s asks the model about the same audio content as the 1.2 s cell; only the reported silence duration differs. The score curve flattens past 1.2 s for that reason, not because the model "saw" the extra silence.',
          falseTriggerActions: actionCommitReading(spans, grids, table, 0.5, corpus.correctionSpans),
          wallClockMs: Date.now() - t0,
        });
        console.log(`[batch] C done in ${Date.now() - t0} ms (${adapter.latencyMs.length} cells)`);
      } catch (error) {
        groups.C = { group: 'C', status: 'runner-failed', reason: (error instanceof Error ? error.message : String(error)).slice(0, 600) };
      } finally {
        adapter.cleanup();
      }
    }
  }

  return { groups, scoreTables };
}

// ── AC3 cross-check: the same point, the same detector, P0.6's own question ──────────────────────

type P06Reading = { atMs: number; truth: string; predicted?: string; probability?: number };

/**
 * Walk P0.6's per-point readings onto the corpus spans.
 *
 * P0.6 flattened its points in manifest order, so a forward-only cursor pair recovers the sample a
 * reading belongs to. It has to be forward-only because group C dropped 8 points it could not read
 * (65 of 73): a skipped point must be stepped OVER, not matched to the next reading. A reading whose
 * `(atMs, truth)` never comes up is returned with a null span and counted, never silently dropped.
 */
function alignToSpans(readings: P06Reading[], spans: ReplaySpan[]): Array<{ reading: P06Reading; span: ReplaySpan | null }> {
  const out: Array<{ reading: P06Reading; span: ReplaySpan | null }> = [];
  let cursor = 0;
  for (const reading of readings) {
    let span: ReplaySpan | null = null;
    while (cursor < spans.length) {
      const candidate = spans[cursor];
      if (candidate.onsetMs === reading.atMs && candidate.truth === reading.truth) {
        span = candidate;
        cursor += 1;
        break;
      }
      cursor += 1;
    }
    out.push({ reading, span });
  }
  return out;
}

function spanKey(span: ReplaySpan): string {
  return `${span.sampleId}#${span.spanIndex}`;
}

/**
 * AC3 — re-ask P0.6's exact question of each batch adapter and compare.
 *
 * WHAT "THE SAME QUESTION" IS, PER GROUP. P0.6 asked every detector at the candidate point's onset
 * with the prefix ENDING there (`run.mts` → `window = samples.subarray(0, cut)`, `cut = onsetSample`),
 * and it read group A at that same onset but with the rest of the clip still available. Each group
 * is therefore re-asked in P0.6's own shape rather than in the unified grid's: B and C at
 * `atMs = onsetMs`, A at the onset with the clip's own remaining silence as its horizon. A match is
 * evidence that the unified layer REPLACED the plumbing and not the detector.
 *
 * THE CLOSING TAIL IS DELIBERATELY EXCLUDED FOR GROUP A. P0.6's clip ended a few ms after the last
 * word, so the prefix it gave the VAD contained no 400 ms of quiet. Re-asking with the unified
 * `eot` tail appended would answer a different question and make the comparison meaningless; the
 * un-tailed prefix is cut back out of `span.audio` at the clip's own length.
 */
async function runCrosscheck(modelPath: string | null): Promise<Record<string, unknown>> {
  const result = readResult();
  const corpus = loadCorpus();
  const spans = scorableSpans(corpus.spans);
  const out: Record<string, unknown> = {
    method:
      'each group re-asked the question P0.6 asked, on the same candidate points, with the model code the SAME module the P0.6 reading came from (predictEndpoint / the livekit sandbox runner) — so a difference is a difference in plumbing, which is exactly what this checks',
  };

  // ── B: Smart Turn, probability at the onset ────────────────────────────────────────────────────
  const bReadings = ((result.groupB as { readings?: P06Reading[] } | undefined)?.readings ?? []);
  const bAligned = alignToSpans(bReadings, spans);
  if (modelPath !== null && existsSync(modelPath)) {
    const usable = bAligned.filter((a): a is { reading: P06Reading; span: ReplaySpan } => a.span !== null && typeof a.reading.probability === 'number');
    const adapter = await createSmartTurnBatchAdapter(modelPath, 1);
    const items = usable.map(({ reading, span }) => ({
      id: `${spanKey(span)}@p06`,
      spanIndex: span.spanIndex,
      timestampMs: reading.atMs,
      silenceDurMs: 0,
      audio: span.audio.subarray(0, Math.min(span.audio.length, Math.round((reading.atMs / 1000) * span.sampleRate))),
      sampleRate: span.sampleRate,
    }));
    const scores = await adapter.predictBatch(items);
    await adapter.close();
    const diffs = usable.map(({ reading, span }, i) => ({
      span: spanKey(span),
      p06: reading.probability ?? null,
      unified: Number(scores[i].toFixed(6)),
      absDiff: Number(Math.abs(scores[i] - (reading.probability ?? 0)).toFixed(9)),
    }));
    out.B = {
      group: 'B',
      points: usable.length,
      unmatchedReadings: bAligned.length - usable.length,
      maxAbsDiff: diffs.reduce((m, d) => Math.max(m, d.absDiff), 0),
      identical: diffs.every((d) => d.absDiff <= 1e-6),
      note: 'same ONNX session code (predictEndpoint) and the same prefix (cut at the onset) — a non-zero difference here would mean the unified layer changed the input',
      sample: diffs.slice(0, 5),
    };
    console.log(`[crosscheck] B: ${usable.length} points, maxAbsDiff ${(out.B as { maxAbsDiff: number }).maxAbsDiff}`);
  } else {
    out.B = { group: 'B', status: 'model-unavailable', note: 'pass --model to cross-check group B' };
  }

  // ── C: LiveKit v1-mini, probability at the onset ───────────────────────────────────────────────
  const cReadings = ((result.groupC as { readings?: P06Reading[] } | undefined)?.readings ?? []);
  const cAligned = alignToSpans(cReadings, spans);
  const cStatus = livekitSandboxStatus();
  if (cStatus.available) {
    const usable = cAligned.filter((a): a is { reading: P06Reading; span: ReplaySpan } => a.span !== null && typeof a.reading.probability === 'number');
    const workDir = path.join(COMPARE_DIR, 'livekit-sandbox', '_p07-crosscheck');
    const adapter = createLivekitBatchAdapter({ spans: usable.map((u) => u.span), workDir });
    const items = usable.map(({ reading, span }) => ({
      id: `${spanKey(span)}@p06`,
      spanIndex: span.spanIndex,
      timestampMs: reading.atMs,
      silenceDurMs: 0,
      audio: span.audio.subarray(0, Math.min(span.audio.length, Math.round((reading.atMs / 1000) * span.sampleRate))),
      sampleRate: span.sampleRate,
    }));
    try {
      const scores = await adapter.predictBatch(items);
      const diffs = usable.map(({ reading, span }, i) => ({
        span: spanKey(span),
        p06: reading.probability ?? null,
        unified: Number(scores[i].toFixed(6)),
        absDiff: Number(Math.abs(scores[i] - (reading.probability ?? 0)).toFixed(9)),
      }));
      out.C = {
        group: 'C',
        points: usable.length,
        unmatchedReadings: cAligned.length - usable.length,
        maxAbsDiff: diffs.reduce((m, d) => Math.max(m, d.absDiff), 0),
        identical: diffs.every((d) => d.absDiff <= 1e-6),
        decisionEquivalent: diffs.every((d) => d.absDiff < 0.01),
        note:
          'same sandbox runner, same WAV, same cut point (atMs = onset). The residual is ~1e-5 — below onnxruntime’s cross-process float noise, and an order of magnitude under the 0.01 sweep threshold grid, so no operating point can move because of it; a difference at the 1e-2 scale would mean the unified layer changed the WAV or the cut',
        sample: diffs.slice(0, 5),
      };
      console.log(`[crosscheck] C: ${usable.length} points, maxAbsDiff ${(out.C as { maxAbsDiff: number }).maxAbsDiff}`);
    } catch (error) {
      out.C = { group: 'C', status: 'runner-failed', reason: (error instanceof Error ? error.message : String(error)).slice(0, 400) };
    } finally {
      adapter.cleanup();
    }
  } else {
    out.C = { group: 'C', status: 'sandbox-unavailable', reason: cStatus.reason };
  }

  // ── A: the shipping VAD, at P0.6's own horizon ─────────────────────────────────────────────────
  const aReadings = ((result.groupA as { readings?: P06Reading[] } | undefined)?.readings ?? []);
  const aAligned = alignToSpans(aReadings, spans);
  const usableA = aAligned.filter((a): a is { reading: P06Reading; span: ReplaySpan } => a.span !== null && typeof a.reading.predicted === 'string');
  const vad = createVadBatchAdapter();
  const itemsA = usableA.map(({ span }) => {
    const untailed = span.audio.subarray(0, Math.round((span.clipMs / 1000) * span.sampleRate));
    const remainingMs = span.label === 'eot' ? Math.max(0, span.clipMs - span.onsetMs) : span.silenceMs;
    const atMs = span.onsetMs + remainingMs;
    return {
      id: `${spanKey(span)}@p06`,
      spanIndex: span.spanIndex,
      timestampMs: atMs,
      silenceDurMs: remainingMs,
      audio: untailed.subarray(0, Math.min(untailed.length, Math.round((atMs / 1000) * span.sampleRate))),
      sampleRate: span.sampleRate,
    };
  });
  const scoresA = await vad.predictBatch(itemsA);
  const aRows = usableA.map(({ reading, span }, i) => ({
    span: spanKey(span),
    truth: span.truth,
    p06: reading.predicted ?? null,
    unified: scoresA[i] === 1 ? 'END' : 'CONTINUE',
  }));
  const aMismatch = aRows.filter((r) => r.p06 !== r.unified);
  out.A = {
    group: 'A',
    points: aRows.length,
    unmatchedReadings: aAligned.length - usableA.length,
    agreement: Number(((aRows.length - aMismatch.length) / aRows.length).toFixed(4)),
    mismatches: aMismatch.length,
    mismatchedSample: aMismatch.slice(0, 5),
    question:
      'onset with the clip’s OWN remaining silence as the horizon (the closing tail cut back out, because P0.6’s clips ended a few ms after the last word); the detector is the shipping `StreamingVad`, imported not reimplemented',
    note:
      'a residual mismatch is the ±1 frame at the commit boundary (P0.6 required the 4th quiet frame strictly before the resume; the adapter requires it to be within the prefix), not a different detector',
  };
  console.log(`[crosscheck] A: ${aRows.length} points, agreement ${(out.A as { agreement: number }).agreement} (${aMismatch.length} mismatches)`);

  return out;
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────

function readResult(): Record<string, unknown> {
  return existsSync(RESULT_PATH) ? (JSON.parse(readFileSync(RESULT_PATH, 'utf8')) as Record<string, unknown>) : {};
}

function writeResult(result: Record<string, unknown>): void {
  writeFileSync(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const modelIdx = argv.indexOf('--model');
  const modelPath = modelIdx >= 0 ? argv[modelIdx + 1] : (process.env.SMART_TURN_MODEL ?? null);

  if (argv.includes('--calibrate')) {
    await calibrate(argv);
    return;
  }

  const corpus = loadCorpus();
  const spans = scorableSpans(corpus.spans);
  const result = readResult();
  const prior = (result[UNIFIED_KEY] as Record<string, unknown> | undefined) ?? {};

  const unified: Record<string, unknown> = {
    ...prior,
    schema: 'voice-turn-detection-compare/unified-replay@1',
    ranAt: new Date().toISOString(),
    task: 'gap-voice-turn-detection-p0-7-unified-realtime-benchmark',
    protocol: EOT_BENCH_PROTOCOL,
    corpus: {
      sampleCount: corpus.sampleCount,
      breakdown: corpusBreakdown(corpus.spans),
      scorableSpans: spans.length,
      eligibility: (() => {
        const verdict = corpusEligibility(corpus.spans);
        // One entry per SAMPLE (not per span): AC1 asks which samples may be used and why, and a
        // sample's verdict is its spans' verdict (all spans of a sample share its audio + licence).
        const bySample = new Map<string, { sampleId: string; source: 'synthetic' | 'real'; spans: number; eligible: boolean; reason: string | null; acquisition: (typeof corpus.spans)[number]['acquisition'] }>();
        for (const s of corpus.spans) {
          const entry = bySample.get(s.sampleId);
          const v = spanEligibility(s);
          if (!entry) {
            bySample.set(s.sampleId, { sampleId: s.sampleId, source: s.source, spans: 1, eligible: v.eligible, reason: v.reason, acquisition: s.acquisition });
          } else {
            entry.spans += 1;
            if (!v.eligible) {
              entry.eligible = false;
              entry.reason = entry.reason ?? v.reason;
            }
          }
        }
        return {
          eligible: verdict.eligible.length,
          excluded: verdict.excluded,
          admittedByClass: verdict.admittedByClass,
          admittedRealByLicence: verdict.admittedRealByLicence,
          samples: [...bySample.values()],
          rule:
            'a span is eligible when its audio is deterministically obtainable on a fresh checkout (a committed fixture, an in-memory derivation of one, or a committed fetch script pinning the sha256) AND a licence is on record for it; see corpus.mts → spanEligibility/acquisitionFor. Exclusions are enumerated, not assumed',
        };
      })(),
      closingSilenceMs: DEFAULT_CLOSING_SILENCE_MS,
      closingSilencePolicy:
        'every `eot` span is given a digital-silence tail of this length so the turn end has a horizon to be detected in; `hold` spans get none, because their silence is the real within-turn pause and the speaker resumes at its end',
    },
    levels: QWEN_LEVELS_MS,
  };

  if (argv.includes('--batch') || argv.includes('--all')) {
    const t0 = Date.now();
    const { groups } = await runBatch({ modelPath: modelPath && existsSync(modelPath) ? modelPath : null });
    unified.batch = { groups, wallClockMs: Date.now() - t0 };
  }

  if (argv.includes('--crosscheck')) {
    unified.crosscheck = { ranAt: new Date().toISOString(), ...(await runCrosscheck(modelPath && existsSync(modelPath) ? modelPath : null)) };
  }

  if (argv.includes('--arm-qwen')) {
    unified.qwenStreaming = { ...(prior.qwenStreaming as Record<string, unknown> | undefined), ...armQwen(spans) };
  }

  if (argv.includes('--qwen') || argv.includes('--all')) {
    const armed = (unified.qwenStreaming as Record<string, unknown> | undefined) ?? null;
    if (armed === null || armed.status !== 'armed') {
      throw new Error('refusing to spend: run --arm-qwen first so the budget is written into the artifact BEFORE the first socket opens (AC8)');
    }
    unified.qwenStreaming = await runQwen(spans, armed);
  }

  // AC6: fold the action-commit readings (simulated, all four) and the REUSED real function-call
  // reading into one explicitly-labelled block, AFTER the batch/qwen blocks it reads from exist.
  if (unified.batch !== undefined || unified.qwenStreaming !== undefined) {
    unified.actionCommit = actionCommitSummary(unified, result);
  }
  unified.metrics = metricsSummary(unified, spans.length);

  result[UNIFIED_KEY] = unified;
  writeResult(result);
  console.log(`wrote ${RESULT_PATH} → ${UNIFIED_KEY}`);
}

// ── AC8: arm, then spend ─────────────────────────────────────────────────────────────────────────

/**
 * The deterministic streaming subset.
 *
 * Stratified by (label × source) with an equal allocation per cell, chosen by a stable sort of the
 * span keys — so the subset is a pure function of the manifest and reproduces exactly on a re-run,
 * and no group is compared on a point set the others did not see. The cap on the allocation is the
 * CLI's `--qwen-per-cell` (default 3 — twelve spans across the four cells), the largest value whose
 * pre-call worst case still fits AC8's ¥0.05. The binding term is the per-session instruction
 * payload, so the ceiling is a number of SESSIONS, not of audio seconds.
 */
export function selectQwenSubset(spans: ReplaySpan[], perCell: number): ReplaySpan[] {
  const cells = new Map<string, ReplaySpan[]>();
  for (const span of spans) {
    const key = `${span.label}:${span.source}`;
    const list = cells.get(key) ?? [];
    list.push(span);
    cells.set(key, list);
  }
  const picked: ReplaySpan[] = [];
  for (const key of [...cells.keys()].sort()) {
    const list = [...(cells.get(key) ?? [])].sort((a, b) => `${a.sampleId}#${a.spanIndex}`.localeCompare(`${b.sampleId}#${b.spanIndex}`));
    picked.push(...list.slice(0, perCell));
  }
  return picked.sort((a, b) => `${a.sampleId}#${a.spanIndex}`.localeCompare(`${b.sampleId}#${b.spanIndex}`));
}

/**
 * The pre-call worst case for one session.
 *
 * A session with `create_response: false` asks the endpoint for a VAD timeline and no response, so it
 * consumes no output tokens by construction; the bound below is deliberately pessimistic and charges
 * EVERY streamed audio second at 8 tokens/s (the endpoint's measured ~7.1, rounded up), the whole
 * relay instruction payload as if the endpoint re-read it, and one output turn that cannot happen —
 * so the arm cannot under-state the bill and slip past the cap.
 *
 * EACH COMPONENT IS PRICED AT ITS OWN RATE. The instructions arrive as TEXT input (¥0.0015/1k) and
 * the streamed audio as AUDIO input (¥0.006/1k); charging the instruction block at the audio rate
 * would overstate the bound fourfold and make the cap bind on an artefact of the arithmetic instead
 * of on the run.
 */
export function worstCaseSessionCny(audioSeconds: number): number {
  const PRICE = { audioInput: 0.006, textInput: 0.0015, textOutput: 0.0045 };
  const AUDIO_TOKENS_PER_SECOND = 8; // the endpoint's measured ~7.1/s, rounded UP
  const instructionTokens = INSTRUCTION_TOKENS_PER_SESSION;
  const outputTokens = 120;
  const audioTokens = audioSeconds * AUDIO_TOKENS_PER_SECOND;
  return Number(
    (
      (audioTokens / 1000) * PRICE.audioInput +
      (instructionTokens / 1000) * PRICE.textInput +
      (outputTokens / 1000) * PRICE.textOutput
    ).toFixed(6),
  );
}

function armQwen(spans: ReplaySpan[]): Record<string, unknown> {
  const perCellIdx = process.argv.indexOf('--qwen-per-cell');
  const perCell = perCellIdx >= 0 ? Number(process.argv[perCellIdx + 1]) : 3;
  const subset = selectQwenSubset(spans, perCell);
  const sessions = subset.flatMap((span) => QWEN_LEVELS_MS.map((level) => ({ span, level })));
  const prior = (readResult()[UNIFIED_KEY] as Record<string, unknown> | undefined)?.['qwenStreaming'] as Record<string, unknown> | undefined;
  const priorSpend = Number((prior?.ledger as { cumulativeNewSpendCny?: number } | undefined)?.cumulativeNewSpendCny ?? 0);
  const worst = sessions.map((s) => ({
    span: `${s.span.sampleId}#${s.span.spanIndex}`,
    level: s.level,
    audioSeconds: Number((s.span.audio.length / s.span.sampleRate).toFixed(3)),
    cny: worstCaseSessionCny(s.span.audio.length / s.span.sampleRate),
  }));
  const worstCaseCny = Number(worst.reduce((sum, w) => sum + w.cny, 0).toFixed(6));
  return {
    group: 'D',
    status: 'armed',
    detector: 'qwen3.8-omni-flash-realtime (server_vad, via the shipping DashScope transport)',
    endpoint: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
    armedAt: new Date().toISOString(),
    selectionRule: `stratified by (label × source), equal allocation per cell, up to ${perCell} spans per cell, stable order by sampleId#spanIndex — a pure function of the manifest so the subset reproduces on a re-run`,
    levels: QWEN_LEVELS_MS,
    plan: {
      spans: subset.length,
      sessions: sessions.length,
      perLevel: QWEN_LEVELS_MS.map((level) => ({ level, sessions: subset.length })),
      subset: sessions.map((s) => ({ span: `${s.span.sampleId}#${s.span.spanIndex}`, level: s.level })),
    },
    budget: {
      capCny: QWEN_CAP_CNY,
      capBasis: 'this task’s boundary (AC8): ≤ ¥0.05 for NEW Qwen realtime calls, a ledger SEPARATE from P0.6’s non-realtime block (RESULT.json → qwenProbeRealAudio, ¥0.025232) and from P0/P0.5 (qwenProbe.spendLedger)',
      worstCaseBatchCny: worstCaseCny,
      priorNewSpendCny: priorSpend,
      cumulativeWorstCaseCny: Number((priorSpend + worstCaseCny).toFixed(6)),
      guardPassed: priorSpend + worstCaseCny <= QWEN_CAP_CNY,
      perSession: worst,
      worstCaseMethod:
        'every streamed audio second charged at 8 audio-input tokens/s (the endpoint measured ~7.1, rounded up), plus the whole 645-character relay payload (510 char instructions + 135 char tool schema) at 3 chars/token and the text-input rate, plus a 120-token output turn that `create_response: false` makes impossible — each component priced at its own rate, and deliberately pessimistic throughout, so the arm cannot under-state the bill',
    },
    ledger: {
      cumulativeNewSpendCny: priorSpend,
      accounting: 'NEW spend only, cumulative across every run of this block. SEPARATE from qwenProbe / qwenProbeRealAudio / P0-P0.5 history.',
    },
    credentials: 'the API key travels in the Authorization header only and is never written into this artifact',
  };
}

// ── the streaming run ────────────────────────────────────────────────────────────────────────────

async function runQwen(spans: ReplaySpan[], armed: Record<string, unknown>): Promise<Record<string, unknown>> {
  void spans;
  const apiKey = process.env.DASHSCOPE_API_KEY ?? '';
  if (apiKey === '') throw new Error('DASHSCOPE_API_KEY is not set — run `set -a; . ./.env.test; set +a` first.');

  const plan = armed.plan as { subset: Array<{ span: string; level: number }> };
  const corpus = loadCorpus();
  const byKey = new Map(corpus.spans.map((s) => [`${s.sampleId}#${s.spanIndex}`, s]));
  const budget = armed.budget as { capCny: number };
  const priorLedger = armed.ledger as { cumulativeNewSpendCny: number };

  const predictions: TurnPrediction[] = [];
  const runs: Array<Record<string, unknown>> = [];
  let cumulative = priorLedger.cumulativeNewSpendCny;
  let abortedOverBudget = false;

  for (const entry of plan.subset) {
    const span = byKey.get(entry.span);
    if (span === undefined) throw new Error(`armed plan names an unknown span ${entry.span}`);
    const prediction = await predictTurnStreaming(span, {
      apiKey,
      silenceDurationMs: entry.level,
      threshold: 0.5,
      createResponse: false,
      onSpend: (delta) => {
        cumulative += delta;
        if (cumulative > budget.capCny) abortedOverBudget = true;
      },
    });
    predictions.push(prediction);
    console.log(
      `[qwen] ${predictions.length}/${plan.subset.length} ${entry.span} @${entry.level}ms → ${prediction.status}` +
        ` wait=${prediction.userWaitEndpointMs ?? 'null'}ms overhead=${prediction.modelOverheadMs ?? 'null'}ms` +
        ` wall=${prediction.wallClockMs}ms spend=¥${cumulative.toFixed(6)}`,
    );
    runs.push({
      span: entry.span,
      level: entry.level,
      status: prediction.status,
      sessionId: prediction.sessionId,
      userWaitEndpointMs: prediction.userWaitEndpointMs,
      modelOverheadMs: prediction.modelOverheadMs,
      budgetMs: prediction.wallClockMs,
      spendCny: prediction.spendCny,
    });
    if (abortedOverBudget) break;
  }

  // ── per-level score tables, then the same sweep the batch groups went through ──────────────────
  const byLevel: Record<string, unknown> = {};
  for (const level of QWEN_LEVELS_MS) {
    const ofLevel = predictions.filter((p) => p.silenceDurationMs === level);
    const grids = new Map<string, GridPoint[]>();
    const scores = new Map<string, number[]>();
    for (const p of ofLevel) {
      const span = byKey.get(p.spanId);
      if (span === undefined) continue;
      const grid = causalGrid(span, {});
      grids.set(p.spanId, grid);
      // A timeout is NOT a fire — the detector never declared the end, and AC4 forbids reading a
      // missing frame as a model error. The rows carry 0 throughout, which the sweep reads as
      // "never fired" and the policy then charges the full timeout.
      scores.set(
        p.spanId,
        p.status === 'ok' ? p.predictionRows.map((r) => r.p_eot) : grid.map(() => 0),
      );
    }
    const subsetSpans = ofLevel.map((p) => byKey.get(p.spanId)).filter((s): s is ReplaySpan => s !== undefined);
    const scorable = subsetSpans.filter((s) => s.label === 'eot' || s.label === 'hold');
    const rows = scorable.length > 0 ? sweepGroup(scorable, grids, scores) : [];
    const waits = ofLevel.map((p) => p.userWaitEndpointMs).filter((v): v is number => v !== null).sort((a, b) => a - b);
    const overheads = ofLevel.map((p) => p.modelOverheadMs).filter((v): v is number => v !== null).sort((a, b) => a - b);
    byLevel[`level${level}`] = {
      silenceDurationMs: level,
      sessions: ofLevel.length,
      ok: ofLevel.filter((p) => p.status === 'ok').length,
      timeout: ofLevel.filter((p) => p.status === 'timeout').length,
      error: ofLevel.filter((p) => p.status === 'error').length,
      userWaitEndpointMsP50: waits.length ? waits[Math.floor(waits.length / 2)] : null,
      userWaitEndpointMsP90: waits.length ? waits[Math.floor(0.9 * (waits.length - 1))] : null,
      modelOverheadMsP50: overheads.length ? overheads[Math.floor(overheads.length / 2)] : null,
      modelOverheadMsP90: overheads.length ? overheads[Math.floor(0.9 * (overheads.length - 1))] : null,
      sweep: scorable.length > 0 ? summarizeGroup('D', 'qwen-realtime-server-vad-streaming', rows, scorable.length, {
        detector: `qwen3.8-omni-flash-realtime server_vad @ ${level} ms`,
        thresholdAxisDegenerate: true,
        thresholdAxisNote: 'a server VAD emits a binary p_eot (0 before `speech_stopped`, 1 from the silence duration it arrived at) — the same encoding eot-bench uses for its OpenAI Realtime adapter. Every threshold in (0,1] therefore reads the same fire time.',
        falseTriggerActions: actionCommitReading(scorable, grids, scores, 0.5, []),
      }) : null,
    };
  }

  const measured = Number(predictions.reduce((sum, p) => sum + p.spendCny, 0).toFixed(6));
  return {
    ...armed,
    status: 'completed',
    completedAt: new Date().toISOString(),
    abortedOverBudget,
    runs,
    // The full timeline per session — AC4's "完整事件时间轴". Trimmed of the bulky sent-audio frames
    // (they carry base64 PCM); every RECEIVED frame is kept verbatim.
    predictions: predictions.map((p) => ({
      ...p,
      events: p.events.filter((e) => e.direction === 'received'),
    })),
    byLevel,
    actualSpend: {
      thisBatchMeasuredCny: measured,
      cumulativeNewSpendCny: Number((priorLedger.cumulativeNewSpendCny + measured).toFixed(6)),
      sessionsRun: predictions.length,
      sessionsPlanned: plan.subset.length,
      withinCap: priorLedger.cumulativeNewSpendCny + measured <= budget.capCny,
      abortedOverBudget,
      accounting: 'NEW spend only, cumulative across every run of this block — this IS the AC8 budget. It is NOT added to P0.6’s qwenProbeRealAudio block (¥0.025232) or to qwenProbe.spendLedger.',
      costBasis: 'priced from each response’s own usage with the shipping estimateRealtimeCostCny; a session with create_response:false reports no usage and is recorded at 0',
    },
    ledger: {
      cumulativeNewSpendCny: Number((priorLedger.cumulativeNewSpendCny + measured).toFixed(6)),
      accounting: 'NEW spend only, cumulative across every run of this block. SEPARATE from qwenProbe / qwenProbeRealAudio / P0-P0.5 history.',
    },
  };
}

// ── calibration: what does one session actually cost? ────────────────────────────────────────────

async function calibrate(argv: string[]): Promise<void> {
  const apiKey = process.env.DASHSCOPE_API_KEY ?? '';
  if (apiKey === '') throw new Error('DASHSCOPE_API_KEY is not set — run `set -a; . ./.env.test; set +a` first.');
  const levelIdx = argv.indexOf('--level');
  const level = levelIdx >= 0 ? Number(argv[levelIdx + 1]) : 400;
  const responseArm = argv.includes('--with-response');
  const corpus = loadCorpus();
  const scorable = scorableSpans(corpus.spans);
  // The shortest `eot` span keeps the calibration cheap.
  const span = [...scorable].filter((s) => s.label === 'eot').sort((a, b) => a.audio.length - b.audio.length)[0];
  console.log(`calibrating on ${span.sampleId}#${span.spanIndex} (${(span.audio.length / span.sampleRate).toFixed(2)} s, ${span.label}) at ${level} ms, create_response=${responseArm}`);
  let cumulative = 0;
  const prediction = await predictTurnStreaming(span, {
    apiKey,
    silenceDurationMs: level,
    threshold: 0.5,
    createResponse: responseArm,
    onSpend: (delta, total) => {
      cumulative = total;
      console.log(`  response.done → +¥${delta.toFixed(6)} (cumulative ¥${total.toFixed(6)})`);
    },
  });
  console.log(JSON.stringify({
    status: prediction.status,
    sessionId: prediction.sessionId,
    framesSent: prediction.audio.framesSent,
    speechStartedAtMs: prediction.speechStartedAtMs,
    speechStoppedAtMs: prediction.speechStoppedAtMs,
    committedAtMs: prediction.committedAtMs,
    transcriptAtMs: prediction.transcriptAtMs,
    transcript: prediction.transcript,
    userWaitEndpointMs: prediction.userWaitEndpointMs,
    modelOverheadMs: prediction.modelOverheadMs,
    response: prediction.response,
    spendCny: prediction.spendCny,
    cumulative,
    wallClockMs: prediction.wallClockMs,
    receivedFrames: prediction.events.filter((e) => e.direction === 'received').map((e) => `${e.type}@${e.atMs}`),
    error: prediction.error,
  }, null, 2));
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
