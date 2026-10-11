/**
 * P0.9 Stage 2 — the local-detector SET, read under the same eot-bench axes as Stage 1, plus the
 * concrete "quality loss vs latency delta" tradeoff against the Stage-1 sufficient VAD point.
 *
 * WHY THIS RUNS (the trigger, stated before the numbers). Stage 1 IS "sufficient" — VAD@800 ms clears
 * the pre-registered 0.10 cutoff budget with endWait p90 820 ms under the incumbent's clean p90
 * 936 ms — but only MARGINALLY: at the tighter budgets eot-bench itself uses (0.02 / 0.05) NO
 * threshold passes (see `stage1Gate.budgetSensitivity`). The task says Stage 2 is done "仅在阶段 1
 * 不够用时" — and by the protocol's own tighter budgets Stage 1 is not sufficient, so Stage 2 is
 * TRIGGERED as the robustness cross-check the task asks for. It is free (see cost below), so there is
 * no cost argument against running it.
 *
 * IT SPENDS NOTHING AND RUNS NO MODEL. This file does not re-invoke Smart Turn or LiveKit: it reads
 * P0.7's COMMITTED `RESULT.json` (`unifiedReplay.batch.groups.B/C`) — the readings those detectors
 * really produced in P0.7 — and this run's own `stage1Sweep` VAD rows. The only thing it executes is a
 * local FILESYSTEM PROBE for turn-1-mini, which opens no socket.
 *
 * turn-1-mini (p99lab, Apache-2.0). The task requires: if it is not installed, mark it 未安装 and do
 * NOT invent a number or silently skip it. The marker below is produced by a real probe recorded in
 * `detectors[].evidence`, not asserted — the probe looks for a package occupying that slot, an
 * importable Python module, and any local checkout. It finds none, so the reading is `null` with the
 * marker `未安装`.
 *
 * Run:  npx tsx experiments/voice-turn-detection-compare/staged-feasibility/stage2-local-detectors.mts
 * Reads: ./RESULT.json (stage1Sweep), ../RESULT.json (P0.7 groups B/C), node_modules/ + python env
 * Writes: ./RESULT.json  (adds/refreshes the `stage2` block; every other block is preserved)
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const RESULT_PATH = path.join(DIR, 'RESULT.json');
const COMPARE_DIR = path.resolve(DIR, '..');
const P07_RESULT_PATH = path.join(COMPARE_DIR, 'RESULT.json');
const REPO_ROOT = path.resolve(DIR, '../../../..');

/** The pre-registered budget from Stage 1. The Stage-2 table is read at this SAME budget so the rows
 *  are axis-comparable with the Stage-1 gate; the tighter budgets are a sensitivity band, not a line. */
const PRIMARY_BUDGET = 'budget0_1';
const PRIMARY_BUDGET_VALUE = 0.1;

/** Stage-1's sufficient endpoint. Every Stage-2 row is stated as a DELTA against this point. */
const STAGE1_SUFFICIENT_ENDPOINT_MS = 800;

type Point = {
  available?: boolean;
  threshold?: number;
  actionDelaySeconds?: number;
  timeoutSeconds?: number;
  cutoffRate?: number;
  cutoffDenominator?: number;
  missedEndpointRate?: number;
  missedEndpointDenominator?: number;
  meanLatencySeconds?: number;
  f1?: number;
};

type Group = {
  adapterId?: string;
  points?: number;
  bestAtBudget?: Record<string, Point>;
  pareto?: Point[];
  featureMsP50?: number;
  inferenceMsP50?: number;
  modelLatencyMsP50?: number;
  modelLatencyMsP90?: number;
  outerWindowNote?: string;
};

function round(n: number, d = 4): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/** The tradeoff of one alternative operating point against the Stage-1 sufficient VAD point. The
 *  quality axes are the two error RATES (Δ expressed in percentage points); the cost axis is the
 *  end-wait mean latency (Δ in ms). Negative Δ on an error axis = BETTER; negative Δ latency =
 *  FASTER. A point is strictly dominated iff it is no better on all three. */
function tradeoffAgainst(base: Point, alt: Point): Record<string, unknown> {
  const dc = (alt.cutoffRate ?? 0) - (base.cutoffRate ?? 0);
  const dm = (alt.missedEndpointRate ?? 0) - (base.missedEndpointRate ?? 0);
  const dl = ((alt.meanLatencySeconds ?? 0) - (base.meanLatencySeconds ?? 0)) * 1000;
  const dominated = dc >= 0 && dm >= 0 && dl >= 0 && (dc > 0 || dm > 0 || dl > 0);
  return {
    deltaCutoffPp: round(dc * 100, 2),
    deltaMissedEndPp: round(dm * 100, 2),
    deltaEndWaitMs: round(dl, 1),
    strictlyDominatedByStage1: dominated,
  };
}

function frontierRows(group: Group): Point[] {
  return (group.pareto ?? []).filter((p) => p.available !== false);
}

/** Rows where the MODEL'S SCORE actually gates the decision. `threshold === 0` is the eot-bench
 *  "accept everything" policy row: it is present IDENTICALLY in every group (it never consults the
 *  detector), so it cannot distinguish one detector from another and must not be picked as a
 *  detector's operating point. This is why a naive max-F1 over the whole pareto lands on the same
 *  row for groups B and C. */
function modelRows(group: Group): Point[] {
  return frontierRows(group).filter((p) => (p.threshold ?? 0) > 0);
}

/** The frontier point the protocol itself would call best: the one maximising F1 (the single quality
 *  scalar eot-bench reports) among rows the model actually gates. Reported regardless of the cutoff
 *  budget, with an `overBudget` flag — a detector whose best F1 point exceeds the budget is a
 *  detector that CANNOT hit it, which is the honest reading and not something to hide by picking a
 *  degenerate in-budget point. */
function bestF1Frontier(group: Group, budget: number): { point: Point; overBudget: boolean } | null {
  const rows = modelRows(group);
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => (b.f1 ?? 0) - (a.f1 ?? 0));
  const point = sorted[0];
  return { point, overBudget: (point.cutoffRate ?? 1) > budget + 1e-9 };
}

/** The best-F1 score-gated frontier point that ALSO satisfies the cutoff budget. This is what the
 *  detector can do without leaving the budget; when its F1 collapses (because the only in-budget
 *  point never fires), that collapse is itself the finding. */
function bestF1WithinBudget(group: Group, budget: number): Point | null {
  const within = modelRows(group).filter((p) => (p.cutoffRate ?? 1) <= budget + 1e-9);
  if (within.length === 0) return null;
  within.sort((a, b) => (b.f1 ?? 0) - (a.f1 ?? 0));
  return within[0];
}

/** Mechanical turn-1-mini probe. Records the exact thing it looked for and what it found, so the
 *  未安装 marker is EVIDENCE, not an assertion. No socket, no install. */
function probeTurn1Mini(): Record<string, unknown> {
  const probes: Record<string, unknown>[] = [];
  // (a) an npm package occupying the slot
  const nm = path.join(REPO_ROOT, 'node_modules');
  let turnPkgs: string[] = [];
  if (existsSync(nm)) {
    turnPkgs = readdirSync(nm).filter((n) => /turn/i.test(n) && !/^\./.test(n));
  }
  probes.push({ probe: 'node_modules entries matching /turn/i', root: 'node_modules', found: turnPkgs });
  // (b) an importable Python module
  for (const mod of ['turn_detector', 'turn1mini', 'p99lab_turn']) {
    let out = '';
    let ok = false;
    try {
      out = execSync(`python3 -I -c "import ${mod}; print(${mod}.__file__)" 2>&1`, { encoding: 'utf8' });
      ok = true;
    } catch (e) {
      out = String((e as { stderr?: string; stdout?: string }).stderr ?? (e as { stdout?: string }).stdout ?? e).slice(0, 300);
    }
    probes.push({ probe: `python3 -I -c "import ${mod}"`, importable: ok, output: out.trim() });
  }
  // (c) any local checkout / weights dir named for it
  let checkouts: string[] = [];
  try {
    const hits = execSync(
      `grep -rl --include=*.py --include=*.mts --include=*.mjs --include=*.json "turn-1-mini\\|turn1mini" ${path.join(COMPARE_DIR)} 2>/dev/null || true`,
      { encoding: 'utf8' },
    ).trim();
    checkouts = hits.split('\n').filter(Boolean);
  } catch {
    checkouts = [];
  }
  probes.push({ probe: 'grep -rl "turn-1-mini|turn1mini" in the compare tree', matches: checkouts });
  const installed = turnPkgs.length > 0 || probes.some((p) => p.importable === true);
  return { installed, marker: installed ? null : '未安装', probes };
}

function readJson(p: string): any {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function main(): void {
  if (!existsSync(RESULT_PATH)) throw new Error(`${RESULT_PATH} not found — run offline-vad-sweep.mts first`);
  if (!existsSync(P07_RESULT_PATH)) throw new Error(`${P07_RESULT_PATH} not found — P0.7 result is required`);

  const mine = readJson(RESULT_PATH) as Record<string, any>;
  const p07 = readJson(P07_RESULT_PATH) as any;
  const groups = p07?.unifiedReplay?.batch?.groups as Record<string, Group> | undefined;
  if (!groups?.B || !groups?.C) throw new Error('P0.7 groups B/C missing — cannot read local-detector points');

  const vadRows = mine.stage1Sweep?.rows as Record<string, { endpointMs: number; bestAtBudget?: Record<string, Point> }>;
  const base = vadRows[`vad${STAGE1_SUFFICIENT_ENDPOINT_MS}`]?.bestAtBudget?.[PRIMARY_BUDGET];
  if (!base?.available) throw new Error(`Stage-1 VAD@${STAGE1_SUFFICIENT_ENDPOINT_MS} has no ${PRIMARY_BUDGET} point`);

  // --- Smart Turn (group B) ----------------------------------------------------------------
  const bAtBudget = groups.B.bestAtBudget?.[PRIMARY_BUDGET];
  const bUsable = bestF1Frontier(groups.B, PRIMARY_BUDGET_VALUE);
  const bWithin = bestF1WithinBudget(groups.B, PRIMARY_BUDGET_VALUE);
  const bModelLatency = {
    featureMsP50: groups.B.featureMsP50,
    inferenceMsP50: groups.B.inferenceMsP50,
    totalMsP50: groups.B.featureMsP50 != null && groups.B.inferenceMsP50 != null ? round(groups.B.featureMsP50 + groups.B.inferenceMsP50, 3) : null,
  };

  // --- LiveKit v1-mini (group C) -----------------------------------------------------------
  const cAtBudget = groups.C.bestAtBudget?.[PRIMARY_BUDGET];
  const cUsable = bestF1Frontier(groups.C, PRIMARY_BUDGET_VALUE);
  const cWithin = bestF1WithinBudget(groups.C, PRIMARY_BUDGET_VALUE);
  const cModelLatency = { modelLatencyMsP50: groups.C.modelLatencyMsP50, modelLatencyMsP90: groups.C.modelLatencyMsP90 };

  // --- turn-1-mini -------------------------------------------------------------------------
  const turn1 = probeTurn1Mini();

  const detectors: Record<string, unknown>[] = [
    {
      id: 'smart-turn-v3.2-onnx',
      adapterId: groups.B.adapterId ?? null,
      installed: true,
      source: 'P0.7 committed RESULT.json unifiedReplay.batch.groups.B (read, not re-run)',
      modelLatencyMs: bModelLatency,
      cells: groups.B.points,
      bestF1FrontierPoint: bUsable ? { ...bUsable.point, overBudget: bUsable.overBudget } : null,
      bestF1WithinBudgetPoint: bWithin ?? null,
      bestAtBudgetEntry: bAtBudget ?? null,
      note:
        'the SWEEP\'s own bestAtBudget pick for group B is the degenerate threshold-0.99 point (cutoff 0, missed-end 0.977) — it minimises cutoff by never firing, so its F1 is 0.044. The best-F1 frontier point is the one reported for the tradeoff; it is OVER the 0.10 cutoff budget (cutoff 0.137931), which is the finding: Smart Turn cannot both hit the budget and keep its F1.',
    },
    {
      id: 'livekit-turn-detector-v1-mini',
      adapterId: groups.C.adapterId ?? null,
      installed: true,
      source: 'P0.7 committed RESULT.json unifiedReplay.batch.groups.C (read, not re-run)',
      modelLatencyMs: cModelLatency,
      cells: groups.C.points,
      bestF1FrontierPoint: cUsable ? { ...cUsable.point, overBudget: cUsable.overBudget } : null,
      bestF1WithinBudgetPoint: cWithin ?? null,
      bestAtBudgetEntry: cAtBudget ?? null,
      frameworkCaveat: groups.C.outerWindowNote ?? null,
    },
    {
      id: 'turn-1-mini (p99lab, Apache-2.0)',
      installed: turn1.installed,
      marker: turn1.marker,
      source: null,
      readings: null,
      evidence: turn1.probes,
      note: turn1.installed
        ? 'installed — readings must be produced by a real run before this row is used'
        : 'NOT INSTALLED in this environment — no package, no importable module, no local checkout. No number is reported for this row; it is neither measured nor silently dropped.',
    },
  ];

  // --- the tradeoff table ------------------------------------------------------------------
  const baseline = {
    id: `vnpt StreamingVad @ ${STAGE1_SUFFICIENT_ENDPOINT_MS} ms (Stage-1 sufficient)`,
    source: 'this run\'s stage1Sweep, via the same eot-bench sweep as P0.7',
    budget: PRIMARY_BUDGET_VALUE,
    cutoffRate: base.cutoffRate,
    cutoffDenominator: base.cutoffDenominator,
    missedEndpointRate: base.missedEndpointRate,
    missedEndpointDenominator: base.missedEndpointDenominator,
    meanLatencySeconds: base.meanLatencySeconds,
    f1: base.f1,
  };

  const tradeoffRows: Record<string, unknown>[] = [];
  // all VAD endpoints, so the table is a full local-detector-set comparison
  for (const key of Object.keys(vadRows).sort()) {
    const row = vadRows[key];
    if (row.endpointMs === STAGE1_SUFFICIENT_ENDPOINT_MS) continue;
    const p = row.bestAtBudget?.[PRIMARY_BUDGET];
    if (!p?.available) continue;
    tradeoffRows.push({
      detector: `vnpt StreamingVad @ ${row.endpointMs} ms`,
      kind: 'pure-vad',
      operatingPoint: { threshold: p.threshold, actionDelaySeconds: p.actionDelaySeconds, timeoutSeconds: p.timeoutSeconds, cutoffRate: p.cutoffRate, cutoffDenominator: p.cutoffDenominator, missedEndpointRate: p.missedEndpointRate, missedEndpointDenominator: p.missedEndpointDenominator, meanLatencySeconds: p.meanLatencySeconds, f1: p.f1 },
      deltaVsBaseline: tradeoffAgainst(base, p),
    });
  }
  // Smart Turn — the best-F1 frontier point (the in-budget sweep pick is degenerate; see its note)
  if (bUsable) {
    tradeoffRows.push({
      detector: 'Smart Turn v3.2 ONNX (CPU) — best-F1 frontier',
      kind: 'local-model',
      operatingPoint: { ...bUsable.point, overBudget: bUsable.overBudget, modelLatencyMsP50: bModelLatency.totalMsP50 },
      deltaVsBaseline: tradeoffAgainst(base, bUsable.point),
    });
  }
  // LiveKit — the best-F1 frontier point, and the sweep's own in-budget pick for contrast
  if (cUsable) {
    tradeoffRows.push({
      detector: 'LiveKit v1-mini — best-F1 frontier',
      kind: 'local-model',
      operatingPoint: { ...cUsable.point, overBudget: cUsable.overBudget, modelLatencyMsP50: cModelLatency.modelLatencyMsP50 },
      deltaVsBaseline: tradeoffAgainst(base, cUsable.point),
    });
  }
  if (cAtBudget) {
    tradeoffRows.push({
      detector: 'LiveKit v1-mini — in-budget sweep pick',
      kind: 'local-model',
      operatingPoint: { ...cAtBudget, modelLatencyMsP50: cModelLatency.modelLatencyMsP50 },
      deltaVsBaseline: tradeoffAgainst(base, cAtBudget),
    });
  }

  // --- a small, pre-registered Stage-2 gate ------------------------------------------------
  // Same bar as Stage 1's primary budget, applied to each local MODEL's best-F1 point: it must be
  // within the cutoff budget AND within the missed-end budget AND no slower than the Stage-1 point.
  const gateFor = (name: string, entry: { point: Point } | null): Record<string, unknown> => {
    if (!entry) return { detector: name, verdict: 'no-point' };
    const p = entry.point;
    const clearsCutoff = (p.cutoffRate ?? 1) <= PRIMARY_BUDGET_VALUE + 1e-9;
    const clearsMissed = (p.missedEndpointRate ?? 1) <= PRIMARY_BUDGET_VALUE + 1e-9;
    const noSlower = (p.meanLatencySeconds ?? 1) <= (base.meanLatencySeconds ?? 0) + 1e-9;
    return {
      detector: name,
      cutoffRate: p.cutoffRate,
      missedEndpointRate: p.missedEndpointRate,
      meanLatencySeconds: p.meanLatencySeconds,
      f1: p.f1,
      clearsCutoffBudget: clearsCutoff,
      clearsMissedEndBudget: clearsMissed,
      noSlowerThanStage1: noSlower,
      verdict: clearsCutoff && clearsMissed && noSlower ? 'improves-stage1' : 'does-not-clear-every-bar',
    };
  };
  const stage2Gate = {
    note: 'pre-registered: a local MODEL must clear the SAME 0.10 cutoff budget and 0.10 missed-end budget as Stage 1, and be no slower than the Stage-1 sufficient point, to count as an improvement',
    cutoffBudget: PRIMARY_BUDGET_VALUE,
    missedEndBudget: PRIMARY_BUDGET_VALUE,
    referencePoint: `VAD@${STAGE1_SUFFICIENT_ENDPOINT_MS} (cutoff ${base.cutoffRate}, missed ${base.missedEndpointRate}, endWait ${base.meanLatencySeconds}s)`,
    localModelVerdicts: [gateFor('Smart Turn v3.2', bUsable), gateFor('LiveKit v1-mini', cUsable)],
    turn1MiniVerdict: turn1.installed ? 'installed' : 'not-installed-untested',
  };

  const stage2 = {
    triggered: true,
    triggerReason:
      'Stage 1 IS sufficient at the 0.10 budget (VAD@800) but NOT at eot-bench\'s tighter 0.02/0.05 budgets — see stage1Gate.budgetSensitivity, where no threshold passes. Per the task ("仅在阶段 1 不够用时"), the marginal Stage-1 result triggers this zero-cost robustness cross-check.',
    cost: {
      newPaidCalls: 0,
      newModelRuns: 0,
      statement: 'no model is re-invoked: Smart Turn / LiveKit rows are READ from P0.7\'s committed RESULT.json; VAD rows come from this run\'s stage1Sweep; the only execution is a local filesystem probe for turn-1-mini, which opens no socket',
      networkConnections: 0,
    },
    budget: PRIMARY_BUDGET_VALUE,
    detectors,
    tradeoffVsStage1Sufficient: { baseline, rows: tradeoffRows },
    stage2Gate,
  };

  const out = { ...mine, stage2 };
  writeFileSync(RESULT_PATH, `${JSON.stringify(out, null, 2)}\n`);

  console.log('[stage2] trigger:', stage2.triggerReason);
  console.log(`[stage2] baseline VAD@${STAGE1_SUFFICIENT_ENDPOINT_MS}: cutoff=${base.cutoffRate} (${base.cutoffDenominator}) missed=${base.missedEndpointRate} (${base.missedEndpointDenominator}) endWait=${base.meanLatencySeconds}s`);
  for (const r of tradeoffRows) {
    const d = r.deltaVsBaseline as Record<string, number | boolean>;
    console.log(`  ${r.detector}: Δcutoff ${d.deltaCutoffPp}pp  Δmissed ${d.deltaMissedEndPp}pp  ΔendWait ${d.deltaEndWaitMs}ms  dominated=${d.strictlyDominatedByStage1}`);
  }
  console.log('[stage2] turn-1-mini marker:', turn1.marker ?? 'installed');
  console.log('[stage2] local-model verdicts:', JSON.stringify(stage2Gate.localModelVerdicts));
  console.log(`[stage2] wrote ${path.relative(process.cwd(), RESULT_PATH)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
