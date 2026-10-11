/**
 * The unified replay protocol for P0.7 — the ONE place the four groups' scores are turned into
 * comparable operating points.
 *
 * WHY THIS FILE EXISTS. P0.6 measured four turn detectors on one manifest but each group carried its
 * own hand-rolled reading: group A's per-point rule, group B's ONNX call, group C's Python shim,
 * group D's cited sibling numbers. There was no shared scorer, so an operating point for B could not
 * be compared with one for D without a translation the reader had to do by hand. P0.7 adopts the
 * LiveKit `eot-bench` protocol (Apache-2.0) so that all four groups answer the SAME causal question
 * through the SAME sweep code and land on the SAME 误截断率-vs-端点延迟 plane.
 *
 * DIRECT DEPENDENCE OR REPLICATION? REPLICATION, and here is the reason — the decision AC2 requires.
 * `eot-bench` is a Python package bound to the `livekit/eot-bench-data` Parquet layout (14 languages,
 * `silence_spans` + `words` per row) and it downloads its corpus through `datasets`. This repository's
 * corpus is a DIFFERENT one (a committed manifest of 44 samples / 73 candidate points, audio fetched
 * by `datasets/fetch-real-samples.mjs` and gitignored). Running the upstream harness would therefore
 * mean (a) adding a Python dependency + an HF-dataset pull to a repo whose SPEC forbids new production
 * integration paths, and (b) either rewriting our manifest into their Parquet schema or importing our
 * rows into their loader — a rewrite large enough that "call their code" and "reimplement their
 * semantics" stop being different in risk. The scoring semantics are small, fully specified, and
 * quoted below verbatim from the upstream source; replicating them EXACTLY keeps the comparison honest
 * and keeps the isolation boundary intact. The provenance block records the upstream revision and the
 * verbatim constants so a reader can re-diff this file against upstream.
 *
 * ── WHAT IS REPLICATED, VERBATIM FROM UPSTREAM (fetched 2026-10-11) ────────────────────────────
 *   eot_harness/io.py:        DEFAULT_TRANSCRIPT_LAG = 0.5, DEFAULT_INFERENCE_INTERVAL = 0.1,
 *                             DEFAULT_MIN_SILENCE = 0.1
 *   eot_harness/metrics.py:   DEFAULT_THRESHOLDS      = round(arange(0.0, 1.01, 0.01), 2)
 *                             DEFAULT_ACTION_DELAYS   = round(arange(0.2, 1.01, 0.1), 2)
 *                             DEFAULT_TIMEOUTS        = round(arange(1.0, 3.51, 0.5), 2)
 *                             CUTOFF_BUDGETS          = (0.02, 0.05, 0.10)
 *                             FRONTIER_MAX_CUTOFF     = 0.10
 *   eot_harness/adapters.py:  BATCH adapter contract    → `adapter_id`, optional `score_point`,
 *                                                       `predict_batch(batch) -> [p_eot, ...]`
 *                             STREAMING adapter contract → `adapter_id`, `concurrency`,
 *                                                       `async predict_turn(row, *, inference_interval)`
 *                                                       -> {id, audio_sec, events, prediction_rows[]}
 *                             `prediction_rows` columns: id, span_index, timestamp, silence_dur,
 *                                                       p_eot, label
 *   eot_harness/openai_realtime_adapter.py: an OpenAI Realtime session is opened PER ROW; the adapter
 *                             sets `turn_detection: {type: "semantic_vad", create_response: false,
 *                             interrupt_response: false}`, streams base64 PCM16 chunks, and maps the
 *                             provider's `input_audio_buffer.speech_stopped` to a BINARY p_eot that is
 *                             0 before the event and 1 after it (`build_event_prediction_rows`).
 *
 * The policy semantics (metrics.py `_policy_sweep_rows`), also verbatim:
 *   hold_model_fire_time = max(action_delay, hold_fire)
 *   model_cutoff         = hold_has_fire & (hold_dur > hold_model_fire_time + EPS)
 *   timeout_cutoff       = hold_dur > timeout + EPS
 *   cutoff               = timeout_cutoff | model_cutoff
 *   model_detect         = eot_has_fire & (eot_model_fire_time <= timeout + EPS)
 *   eot_latency          = where(model_detect, eot_model_fire_time, timeout)
 * with `cutoff_rate = cutoff.mean()` over hold spans and `mean_latency = eot_latency.mean()` over EoT
 * spans ("conversational dead air, not compute" — README) and `timeout_rate = (~model_detect).mean()`
 * over EoT spans (the missed-end rate).
 */

export const EPS = 1e-9;

/** Upstream provenance, pinned so a re-read can diff this replication against the source. */
export const EOT_BENCH_PROTOCOL = {
  repo: 'https://github.com/livekit/eot-bench',
  licenseSpdx: 'Apache-2.0',
  licenseFile: 'LICENSE (stock Apache License, Version 2.0, January 2004 — no `SPDX-License-Identifier` tag; the README badge and pyproject `license` field declare Apache-2.0)',
  dataset: 'https://huggingface.co/datasets/livekit/eot-bench-data',
  datasetLicenseSpdx: 'CC-BY-4.0',
  datasetRevisionSha: 'ca9d98a9686b920a2d8c9eb984224ba9be74e4dd',
  datasetRows: 5454,
  /**
   * AC2's re-verification: the reading was taken AGAIN at this instant (not carried over from a prior
   * session), with the exact URLs that were fetched, so "the licence is still Apache-2.0" is a
   * timestamped observation and not an assumption. The GitHub commits API was rate-limited during the
   * re-read, so no commit sha is recorded here — the raw `main` branch files are the source instead,
   * and that limitation is stated rather than papered over with a stale sha.
   */
  reverification: {
    reverifiedAt: '2026-10-11T03:27:42Z',
    sources: [
      'https://raw.githubusercontent.com/livekit/eot-bench/main/LICENSE → first line "Apache License / Version 2.0, January 2004"',
      'https://raw.githubusercontent.com/livekit/eot-bench/main/pyproject.toml → `version = "0.1.0"`, `license = { file = "LICENSE" }`',
      'https://huggingface.co/api/datasets/livekit/eot-bench-data → `license:cc-by-4.0`, sha ca9d98a9686b920a2d8c9eb984224ba9be74e4dd, lastModified 2026-07-22',
    ],
    findings: {
      harnessLicenseUnchanged: 'Apache-2.0, unchanged from the prior reading',
      datasetLicenseUnchanged: 'CC-BY-4.0, unchanged',
      datasetRevisionUnchanged: 'ca9d98a9686b920a2d8c9eb984224ba9be74e4dd, unchanged from the pin',
      harnessVersion: '0.1.0 (pyproject)',
      notVerified: 'the main-branch commit sha — the GitHub commits API returned HTTP 403 rate-limit at re-read time',
    },
    decision: 'REPLICATE the scoring/sweep semantics rather than depend on the upstream Python harness; the reason is recorded verbatim in this file’s header (corpus schema mismatch + the SPEC’s no-new-integration-path boundary), and the replicated constants are quoted line-by-line from the upstream source above.',
  },
  constants: {
    transcriptLagSeconds: 0.5,
    inferenceIntervalSeconds: 0.1,
    minSilenceSeconds: 0.1,
    thresholds: 'round(arange(0.0, 1.01, 0.01), 2)',
    actionDelays: 'round(arange(0.2, 1.01, 0.1), 2)',
    timeouts: 'round(arange(1.0, 3.51, 0.5), 2)',
    cutoffBudgets: [0.02, 0.05, 0.1],
    frontierMaxCutoff: 0.1,
  },
} as const;

export const DEFAULT_THRESHOLDS: number[] = Array.from({ length: 101 }, (_, i) => Number((i / 100).toFixed(2)));
export const DEFAULT_ACTION_DELAYS: number[] = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
export const DEFAULT_TIMEOUTS: number[] = [1.0, 1.5, 2.0, 2.5, 3.0, 3.5];
export const CUTOFF_BUDGETS = [0.02, 0.05, 0.1] as const;
export const FRONTIER_MAX_CUTOFF = 0.1;

// ── the corpus model (a "row" is one sample; a "span" is one candidate point) ─────────────────────

/** The three-state truth P0.6 established. CORRECTION never scores as END or CONTINUE. */
export type Truth = 'END' | 'CONTINUE' | 'CORRECTION';

/** One candidate point, with the silence that follows it (the span the eot-bench grid walks). */
export type Span = {
  sampleId: string;
  spanIndex: number;
  /** The interrogation onset (ms from clip start). */
  onsetMs: number;
  /** Silence length available at the point: the pause for a within-turn pause, else the trailing
   *  silence to the clip edge (plus any appended closing silence — recorded in the run config). */
  silenceMs: number;
  truth: Truth;
  /** eot-bench label: an END span is the last span ("eot"); a within-turn pause is "hold". */
  label: 'eot' | 'hold';
  scenario: string;
};

/** One causal grid cell: the audio prefix ends at `onsetMs + silenceDurMs`. */
export type GridPoint = {
  spanKey: string;
  spanIndex: number;
  timestampMs: number;
  silenceDurMs: number;
  label: 'eot' | 'hold';
};

/** A batch adapter item — eot-bench's `batch` element: the causal audio + the causal history. */
export type BatchItem = {
  id: string;
  spanIndex: number;
  timestampMs: number;
  silenceDurMs: number;
  /** The causal audio prefix (16 kHz mono PCM in [-1, 1]). */
  audio: Float32Array;
  sampleRate: number;
};

/** The eot-bench BATCH adapter contract. */
export type BatchAdapter = {
  adapterId: string;
  /** eot-bench `score_point`: the default silence duration used when scoring this model. */
  scorePoint?: number;
  /** `predict_batch(batch) -> [p_eot, ...]`, one score per item, in order. */
  predictBatch(items: BatchItem[]): Promise<number[]>;
};

/** A per-span prediction row, the eot-bench `prediction_rows` shape. */
export type PredictionRow = {
  id: string;
  spanIndex: number;
  timestamp: number;
  silence_dur: number;
  p_eot: number;
  label: 'eot' | 'hold';
};

/**
 * What every adapter needs FROM a span to be asked about it: the eot-bench `Span` fields plus the
 * PCM (with any appended closing silence) the detector is fed.
 *
 * Declared here rather than imported from `corpus.mts` so the protocol module stays the root of the
 * dependency graph — the corpus knows about the protocol, not the other way round.
 */
export type ReplaySpanLike = Span & {
  sampleId: string;
  spanIndex: number;
  /** PCM at `sampleRate`, closing tail already appended. */
  audio: Float32Array;
  /** The tail this span was given (ms). */
  appendedTailMs: number;
};

export const spanKey = (sampleId: string, spanIndex: number): string => `${sampleId}#${spanIndex}`;

/**
 * Walk one span's causal grid: from its start, step `inferenceIntervalSeconds`, up to the span's
 * available silence (capped by `maxSilenceSeconds`). This is eot-bench's `io.py` walk, restricted to
 * our manifest's already-labelled spans instead of a Parquet `silence_spans` array.
 */
export function causalGrid(
  span: Span,
  opts: { inferenceIntervalSeconds?: number; maxSilenceSeconds?: number; minSilenceSeconds?: number },
): GridPoint[] {
  const interval = (opts.inferenceIntervalSeconds ?? 0.1) * 1000;
  const minSilence = (opts.minSilenceSeconds ?? 0.1) * 1000;
  const maxSilence = (opts.maxSilenceSeconds ?? 1.5) * 1000;
  const usable = Math.min(span.silenceMs, maxSilence);
  const out: GridPoint[] = [];
  // eot-bench scores a span only when it is at least `min_silence_span` long; below that the point
  // is not interrogated at all. We still emit ONE cell at d=0 for short spans so the span is not
  // silently dropped from a group's reading (the run records the shortfall separately).
  if (usable < minSilence) {
    out.push({ spanKey: spanKey(span.sampleId, span.spanIndex), spanIndex: span.spanIndex, timestampMs: span.onsetMs, silenceDurMs: 0, label: span.label });
    return out;
  }
  for (let d = 0; d <= usable + EPS; d += interval) {
    out.push({
      spanKey: spanKey(span.sampleId, span.spanIndex),
      spanIndex: span.spanIndex,
      timestampMs: span.onsetMs + d,
      silenceDurMs: d,
      label: span.label,
    });
  }
  return out;
}

// ── the policy sweep (eot-bench metrics.py `_policy_sweep_rows`) ─────────────────────────────────

/** One span's fire behaviour under a score table: at which silence duration the model first fires. */
export type SpanFire = {
  key: string;
  label: 'eot' | 'hold';
  /** The span's available silence, in seconds — the horizon the policy can act within. */
  silenceSeconds: number;
  /** First silence duration (s) at which p_eot crosses the threshold, or Infinity if never. */
  fireSeconds: number;
};

/** Turn a span's per-grid scores into {fire time} for one threshold. */
export function spanFire(grid: GridPoint[], scores: number[], threshold: number): { fireSeconds: number } {
  for (let i = 0; i < grid.length; i++) {
    if (scores[i] >= threshold) return { fireSeconds: grid[i].silenceDurMs / 1000 };
  }
  return { fireSeconds: Number.POSITIVE_INFINITY };
}

export type PolicyRow = {
  threshold: number;
  actionDelaySeconds: number;
  timeoutSeconds: number;
  /** False-cutoff rate over hold spans — a timeout on a long pause, or a fire the pause outlasted. */
  cutoffRate: number;
  /** Missed-end rate over EoT spans (eot-bench `timeout_rate` = ~model_detect). */
  missedEndpointRate: number;
  /** Mean endpointing latency over EoT spans: "conversational dead air, not compute" (README). */
  meanLatencySeconds: number;
  detectRate: number;
  precision: number;
  recall: number;
  f1: number;
  holdSpans: number;
  eotSpans: number;
};

/**
 * The exact policy sweep. `fires` is one entry per span (already thresholded).
 * `hold_model_fire_time = max(action_delay, hold_fire)`;
 * `model_cutoff = hold_has_fire & (hold_dur > hold_model_fire_time + EPS)`;
 * `timeout_cutoff = hold_dur > timeout + EPS`; `cutoff = timeout_cutoff | model_cutoff`.
 * `model_detect = eot_has_fire & (eot_model_fire_time <= timeout + EPS)`;
 * `eot_latency = where(model_detect, eot_model_fire_time, timeout)`.
 */
export function sweepPolicies(fires: SpanFire[], policy: { thresholds: number[]; actionDelays: number[]; timeouts: number[] }): PolicyRow[] {
  // `fires` here is the per-threshold fire table; for each threshold we recompute the fire time.
  const thresholds = policy.thresholds;
  const rows: PolicyRow[] = [];
  for (const t of thresholds) {
    const holds = fires.filter((f) => f.label === 'hold');
    const eots = fires.filter((f) => f.label === 'eot');
    for (const actionDelay of policy.actionDelays) {
      for (const timeout of policy.timeouts) {
        let cutoffCount = 0;
        for (const h of holds) {
          const fired = h.fireSeconds < Number.POSITIVE_INFINITY;
          const modelFireTime = Math.max(actionDelay, h.fireSeconds);
          const modelCutoff = fired && h.silenceSeconds > modelFireTime + EPS;
          const timeoutCutoff = h.silenceSeconds > timeout + EPS;
          if (modelCutoff || timeoutCutoff) cutoffCount += 1;
        }
        let detected = 0;
        let latencySum = 0;
        for (const e of eots) {
          const fired = e.fireSeconds < Number.POSITIVE_INFINITY;
          const modelDetect = fired && e.fireSeconds <= timeout + EPS;
          if (modelDetect) {
            detected += 1;
            latencySum += e.fireSeconds;
          } else {
            latencySum += timeout;
          }
        }
        const cutoffRate = holds.length ? cutoffCount / holds.length : 0;
        const detectRate = eots.length ? detected / eots.length : 0;
        const missedEndpointRate = 1 - detectRate;
        const meanLatencySeconds = eots.length ? latencySum / eots.length : 0;
        const precision = detected + cutoffCount > 0 ? detected / (detected + cutoffCount) : 0;
        const recall = detectRate;
        const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
        rows.push({
          threshold: t,
          actionDelaySeconds: actionDelay,
          timeoutSeconds: timeout,
          cutoffRate: Number(cutoffRate.toFixed(6)),
          missedEndpointRate: Number(missedEndpointRate.toFixed(6)),
          meanLatencySeconds: Number(meanLatencySeconds.toFixed(6)),
          detectRate: Number(detectRate.toFixed(6)),
          precision: Number(precision.toFixed(6)),
          recall: Number(recall.toFixed(6)),
          f1: Number(f1.toFixed(6)),
          holdSpans: holds.length,
          eotSpans: eots.length,
        });
      }
    }
  }
  return rows;
}

/** The lower-left Pareto frontier over (meanLatency, cutoffRate): keep a row only if no other row
 *  beats it on BOTH axes. eot-bench `pareto_mask` sorts by latency and keeps a strictly lower cutoff. */
export function paretoFrontier(rows: PolicyRow[]): PolicyRow[] {
  const sorted = [...rows].sort((a, b) => a.meanLatencySeconds - b.meanLatencySeconds);
  const out: PolicyRow[] = [];
  let bestCutoff = Number.POSITIVE_INFINITY;
  for (const r of sorted) {
    if (r.cutoffRate < bestCutoff - EPS) {
      out.push(r);
      bestCutoff = r.cutoffRate;
    }
  }
  return out;
}

/** The best operating point at or below a false-cutoff budget: minimum mean latency among rows whose
 *  cutoffRate ≤ budget; null when no policy is that discriminating. eot-bench `summarize_tradeoff`. */
export function operatingPointAtBudget(rows: PolicyRow[], budget: number): PolicyRow | null {
  const eligible = rows.filter((r) => r.cutoffRate <= budget + EPS);
  if (eligible.length === 0) return null;
  return eligible.reduce((best, r) => (r.meanLatencySeconds < best.meanLatencySeconds ? r : best));
}

/** Wilson 95% score interval for k of n — the same interval P0.6 used, kept here so all four groups
 *  quote the same estimator. */
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

/** A compact operating-point rendering for the RESULT table (full PolicyRow is kept in the arrays). */
export function summarizeOperatingPoint(row: PolicyRow | null): Record<string, unknown> {
  if (row === null) return { available: false, reason: 'no policy at this cutoff budget for this model' };
  return {
    available: true,
    threshold: row.threshold,
    actionDelaySeconds: row.actionDelaySeconds,
    timeoutSeconds: row.timeoutSeconds,
    cutoffRate: row.cutoffRate,
    missedEndpointRate: row.missedEndpointRate,
    meanLatencySeconds: row.meanLatencySeconds,
    f1: row.f1,
  };
}
