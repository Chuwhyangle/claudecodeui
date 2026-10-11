/**
 * Group B as an eot-bench BATCH adapter: Pipecat Smart Turn v3.2 (local ONNX, CPU), scored at every
 * grid cell through the SAME `score_point`/`predict_batch` contract as the other two batch groups.
 *
 * IT REUSES THE P0.6 SESSION, NOT A COPY OF IT. `createSmartTurnSession` and `predictEndpoint` come
 * from `../adapters/smart-turn-v3.mts` — the file whose mel front-end was diffed against an
 * independent numpy oracle in P0.6. Re-deriving the ONNX session here would produce a second
 * implementation of a thing that was already proved equal to the reference, and any future fix to the
 * front-end would land on only one of them.
 *
 * WHAT `predictEndpoint` SEES. The P0.6 primary reading asked at the ONSET (window ending on the
 * speaker's last syllable). eot-bench asks at each grid cell, so the window ends `d` into the
 * silence — which means, for the same reason P0.6 ran a `groupBSensitivity` pass, that a deep cell
 * measures the silence rather than the semantics: a window of synthetic silence scores 0.987 on this
 * build. That is not a flaw in this adapter; it is the eot-bench question, and the Pareto's latency
 * axis is exactly where a model that waits for silence pays off.
 *
 * The model is a genuine probability, so unlike the VAD group its threshold axis is NOT degenerate:
 * the sweep walks its real score curve.
 */

import { createSmartTurnSession, predictEndpoint, type SmartTurnSession } from '../adapters/smart-turn-v3.mts';

import type { BatchAdapter, BatchItem } from './protocol.mts';

export type SmartTurnBatchAdapter = BatchAdapter & {
  /** Per-cell end-to-end cost, so the report can keep B's latency honest. */
  timings: Array<{ id: string; featureMs: number; inferenceMs: number }>;
  close(): Promise<void>;
};

/**
 * Build the group-B batch adapter over one loaded ONNX session.
 *
 * The FIRST call is a warm-up (the session allocates its arenas lazily); it is made here, on a short
 * synthetic prefix, and its cost is recorded as `warmupMs` rather than polluting the per-cell
 * distribution — the same cold/warm split P0.6 applied to groups B and C.
 */
export async function createSmartTurnBatchAdapter(modelPath: string, cpuCount = 1): Promise<SmartTurnBatchAdapter> {
  const session: SmartTurnSession = await createSmartTurnSession(modelPath, cpuCount);
  const timings: Array<{ id: string; featureMs: number; inferenceMs: number }> = [];

  // Warm-up on 1 s of digital silence. Cost recorded, not scored.
  const warmup = new Float32Array(16_000);
  const warmStart = process.hrtime.bigint();
  await predictEndpoint(session, warmup, 16_000);
  const warmupMs = Number(process.hrtime.bigint() - warmStart) / 1e6;

  return {
    adapterId: 'smart-turn-v3.2-onnx-cpu-batch',
    scorePoint: 0.2,
    timings,
    async predictBatch(items: BatchItem[]): Promise<number[]> {
      const out: number[] = [];
      for (const item of items) {
        const r = await predictEndpoint(session, item.audio, item.sampleRate);
        timings.push({ id: item.id, featureMs: Number(r.featureMs.toFixed(3)), inferenceMs: Number(r.inferenceMs.toFixed(3)) });
        out.push(r.probability);
      }
      return out;
    },
    async close(): Promise<void> {
      // ONNX Runtime releases the session when the last reference drops; nothing explicit to do. The
      // method exists so the runner has one shape for every adapter.
      void session;
      void warmupMs;
    },
  };
}
