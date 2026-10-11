/**
 * P0.11 — fine-grained Pareto densification for **LiveKit Turn Detector v1-mini** (group C of the P0.7
 * replay).
 *
 * The sibling of `smart-turn-densify.mts`; both share ONE sweep core (imported below) so a difference
 * between the two frontiers is a difference in the models, never in the scorer. Read that file's header
 * for why "finer" means a finer INTERROGATION grid (0.02 s) and not just a finer policy grid, and for
 * the task's framing (yale's question about trading a slightly higher missed-end rate for a lower
 * false-cutoff rate).
 *
 * WHY v1-mini IS THE HARDER CASE. In P0.7's coarse frontier NO v1-mini point satisfied both 10%
 * budgets — the nearest scanned point still missed 27% of endpoints — so this is not "optimise a known
 * point" but "is there ANY both-budget point at all, including one the coarse grid stepped over". The
 * search therefore runs over every dense row, not just the frontier.
 *
 * The model runs, as always, INSIDE the isolated sandbox venv (LiveKit Model License §3.b(i): the model
 * may only be used together with the livekit-agents framework, never standalone), through the
 * `run_livekit_eot.py` runner the P0.7 adapter already speaks to. No new integration path, no socket to
 * a paid endpoint.
 *
 * Run:
 *   node_modules/.bin/tsx --tsconfig server/tsconfig.json experiments/voice-turn-detection-compare/finegrained-sweep/livekit-densify.mts
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { type GridPoint } from '../eot-bench-adapters/protocol.mts';
import { COMPARE_DIR, loadCorpus, scorableSpans } from '../eot-bench-adapters/corpus.mts';
import { createLivekitBatchAdapter, livekitSandboxStatus } from '../eot-bench-adapters/livekit-batch-adapter.mts';
import {
  BUDGETS,
  COARSE_INTERVAL_SECONDS,
  COARSE_POLICY,
  DENSE_POLICY,
  FINE_DIR,
  FOCUS_BANDS,
  REFINED_INTERVAL_SECONDS,
  analyze,
  bandEvidence,
  buildItemsAndGrids,
  cacheFile,
  readCache,
  readResult,
  scoresFromItems,
  sweepPolicyGrid,
  verdictFor,
  writeCache,
  writeResult,
} from './smart-turn-densify.mts';

const linspace = (start: number, stop: number, step: number, decimals: number): number[] => {
  // Indexed, not accumulated (see smart-turn-densify.mts) so the endpoint rung is never dropped.
  const n = Math.round((stop - start) / step);
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(Number((start + i * step).toFixed(decimals)));
  return out;
};

async function runLivekit(): Promise<Record<string, unknown>> {
  const status = livekitSandboxStatus();
  if (!status.available) return { model: 'LiveKit Turn Detector v1-mini', status: 'sandbox-unavailable', reason: status.reason };

  const spans = scorableSpans(loadCorpus().spans);
  const timings: Record<string, number> = {};

  const runAt = async (intervalSeconds: number, tag: string): Promise<{ grids: Map<string, GridPoint[]>; scores: Map<string, number[]>; cells: number; ms: number; resource: Record<string, unknown>; fromCache: boolean }> => {
    const { items, grids } = buildItemsAndGrids(spans, intervalSeconds);
    const file = cacheFile('livekit', intervalSeconds);
    const cached = readCache(file, items.length);
    if (cached !== null) return { grids, scores: cached, cells: items.length, ms: 0, resource: {}, fromCache: true };
    const adapter = createLivekitBatchAdapter({ spans, workDir: path.join(FINE_DIR, `_cells-${tag}`) });
    const t0 = Date.now();
    try {
      const raw = await adapter.predictBatch(items);
      const ms = Date.now() - t0;
      const scores = scoresFromItems(items, raw, grids);
      writeCache(file, items.length, ms, scores);
      return { grids, scores, cells: items.length, ms, resource: adapter.resource, fromCache: false };
    } finally {
      adapter.cleanup();
    }
  };

  const coarse = await runAt(COARSE_INTERVAL_SECONDS, 'coarse');
  timings.coarseMs = coarse.ms;
  const refined = await runAt(REFINED_INTERVAL_SECONDS, 'refined');
  timings.refinedMs = refined.ms;

  const coarseGridCoarsePolicy = analyze(sweepPolicyGrid(spans, coarse.grids, coarse.scores, COARSE_POLICY), BUDGETS);
  const refinedGridCoarsePolicy = analyze(sweepPolicyGrid(spans, refined.grids, refined.scores, COARSE_POLICY), BUDGETS);
  const denseRows = sweepPolicyGrid(spans, refined.grids, refined.scores, DENSE_POLICY);
  const refinedGridDensePolicy = analyze(denseRows, BUDGETS);

  const band = FOCUS_BANDS.C;
  const bandEvidenceBlock = bandEvidence(denseRows, band, linspace(band[0], band[1], 0.01, 2));

  const p07 = JSON.parse(readFileSync(path.join(COMPARE_DIR, 'RESULT.json'), 'utf8')) as Record<string, any>;
  const p07C = p07?.unifiedReplay?.batch?.groups?.C ?? null;

  return {
    model: 'LiveKit Turn Detector v1-mini (local, inside livekit-agents)',
    status: 'ok',
    spans: spans.length,
    cells: { coarse: coarse.cells, refined: refined.cells },
    timingsMs: timings,
    resource: refined.resource,
    outerWindowSeconds: refined.resource.outerWindowSeconds ?? 1.2,
    outerWindowNote:
      'the framework local transport keeps a 1.2 s ring buffer, so a cell deeper than 1.2 s asks the model about the same audio content as the 1.2 s cell; the score curve flattens past 1.2 s for that reason, not because the model saw the extra silence',
    originalCoarseP07: p07C === null ? { available: false } : { frontier: p07C.pareto ?? [], bestAtBudget: p07C.bestAtBudget ?? {}, frontierSize: p07C.frontierSize ?? null },
    ablations: {
      coarseGrid_coarsePolicy: coarseGridCoarsePolicy,
      refinedGrid_coarsePolicy: refinedGridCoarsePolicy,
      refinedGrid_densePolicy: refinedGridDensePolicy,
    },
    focusBand: bandEvidenceBlock,
    verdict: verdictFor('LiveKit v1-mini', refinedGridDensePolicy, FOCUS_BANDS.C),
  };
}

async function main(): Promise<void> {
  const livekit = await runLivekit();
  // Re-read AFTER the long sweep so the sibling's key (written while this ran) is merged, not clobbered.
  const result = readResult();
  result.livekit = livekit;
  writeResult(result);
  const st = livekit as Record<string, any>;
  console.log(`[livekit] status=${st.status} cells=${JSON.stringify(st.cells)} bothBudgetFound=${st.verdict?.bothBudgetPointFound} wrote finegrained-sweep/RESULT.json`);
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
