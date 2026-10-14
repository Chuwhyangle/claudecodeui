// scripts/vitest-worker-budget.ts — derive vitest's client worker width from the REAL scope budget.
//
// Why this exists (gap-vitest-worker-cap-from-real-scope-budget):
//
// vitest.config.ts used to size the client pool from `os.availableParallelism()` alone —
// `min(CLIENT_MAX_WORKERS, floor(availableParallelism() / 2))` — i.e. from CORES ONLY. That is half
// a budget: it ignores memory entirely. A pool of N workers, each allowed a 4352 MB V8 heap
// (`poolOptions.forks.execArgv --max-old-space-size`), means the config's *theoretical* heap ceiling
// is N × 4352 MB — 8 × 4352 = 34.8 GiB at the current width — while the scope the suite actually
// runs in is capped well below that (measured `.quay/suite-cgroup-evidence.txt`: memoryMax=16G).
// Nothing stopped a scope-limited run from asking for a pool whose ceiling exceeded its own cap.
//
// ⛔ 4352 MB is a CEILING, NOT A RESERVATION. V8 is *allowed* to grow each worker's old space to that
// limit; it does not pre-allocate it. 34.8 GiB is therefore a theoretical upper bound and MUST NOT be
// treated as a measured peak. The only measured number is the cgroup's own `memory.peak` for a real
// run (recorded per round in the task's Evidence). Measured here: the client suite peaks ≈ 4.06 GiB
// in a 16 GiB scope at 8 workers — an order of magnitude under the theoretical 34.8 GiB. Sizing the
// width from the theoretical ceiling would starve the pool to satisfy a number nothing ever hits;
// sizing it from the budget below keeps the pool honest about what the scope can hold.
//
// The budget is the INTERSECTION (minimum) of three quantities:
//   · effective CPU cores  — cgroup `cpu.max` / cpuset / nproc, via scripts/effective-capacity.sh
//     (that probe walks the ANCESTOR chain too, so a quota that lives on the slice above is found);
//   · the ancestor constraints the probe already folds into `effective_cpu`;
//   · the CALLER'S OWN scope `memory.max` — scripts/effective-capacity.sh's `scope_mem_max_mb`, which
//     reads the own cgroup's limit (not the outer session cap). ⛔ A 16 GiB suite scope nested inside
//     an 8 GiB session cap must budget from 16384, never from the outer 8192.
//
// ⛔ THE FLOOR IS BOUNDED BY THE BUDGET (invariant). A "floor" of some minimum width must never let
// the derived width exceed what the budget allows: if the budget works out below that floor, the
// width goes below it too. There is deliberately NO `Math.max(4, …)` anywhere below — the returned
// width is `min(budget, …)`, and the only lower bound is 1 (vitest cannot run with 0 workers).
//
// PER_WORKER_BUDGET_MB is the per-worker memory reservation the memory side of the budget divides by.
// It is a MEASURED-derived policy number, not the heap ceiling: the suite's maximum single-file heap
// reading is 1401 MB (`--logHeapUsage`, recorded in vitest.config.ts), and 2048 MB is the tightest
// power-of-two at or above 1.3 × 1401 MB. It stays FAR below the 4352 MB heap ceiling on purpose —
// the ceiling bounds one worker's worst case, the budget bounds the POOL's total.
//
// Overridable, but never escapable: QUAY_VITEST_MAX_WORKERS raises or lowers the width WITHIN the
// budget only. An override above the budget is clamped back into it (`min(override, budget)`), so the
// escape hatch cannot re-open the oversubscription this module exists to close.
import { execFileSync } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Hard cap on the client pool (the pool is never wider than this, whatever the budget says). */
export const CLIENT_MAX_WORKERS = 8;

/** Per-worker memory reservation (MB) the memory side of the budget divides the scope limit by. */
export const PER_WORKER_BUDGET_MB = 2048;

/** The override env var, read by both this module and (transitively) vitest.config.ts. */
export const MAX_WORKERS_ENV = 'QUAY_VITEST_MAX_WORKERS';

export interface ScopeBudget {
  /** Effective CPU cores (cgroup bandwidth / cpuset / nproc), as reported by the probe. */
  effectiveCpu: number;
  /** The caller's OWN scope memory.max, in MB. `Infinity` when no limit could be read. */
  scopeMemMaxMb: number;
  /** Where the readings came from: the cgroup probe, or the host fallback. */
  source: 'cgroup' | 'fallback';
}

const PROBE_PATH = fileURLToPath(new URL('./effective-capacity.sh', import.meta.url));

/**
 * Derive the worker width from a budget reading. Pure — the unit tests drive it directly with the
 * four shapes that matter (16 GiB scope, 8 GiB scope, no cgroup, cpuset=2).
 *
 * The result is `min(CLIENT_MAX_WORKERS, cpuWorkers, memWorkers)` and is ALWAYS ≥ 1: cpuWorkers and
 * memWorkers are each floored at 1, and a scope with no memory limit contributes CLIENT_MAX_WORKERS
 * (memory does not bind). There is no floor that can exceed the budget — see the module header.
 */
export function deriveWorkerWidth(budget: ScopeBudget): number {
  const cpuWorkers =
    Number.isFinite(budget.effectiveCpu) && budget.effectiveCpu >= 1
      ? Math.max(1, Math.floor(budget.effectiveCpu))
      : CLIENT_MAX_WORKERS;

  let memWorkers: number;
  if (Number.isFinite(budget.scopeMemMaxMb) && budget.scopeMemMaxMb > 0) {
    memWorkers = Math.max(1, Math.floor(budget.scopeMemMaxMb / PER_WORKER_BUDGET_MB));
  } else {
    // No readable scope limit: memory imposes no bound. The CPU side (and CLIENT_MAX_WORKERS) still do.
    memWorkers = CLIENT_MAX_WORKERS;
  }

  return Math.max(1, Math.min(CLIENT_MAX_WORKERS, cpuWorkers, memWorkers));
}

/**
 * Read the real scope budget. Fail-open: any failure to run or parse the probe falls back to the
 * host's available parallelism and "no scope memory limit" — a config that refuses to load because
 * a probe hiccuped would be strictly worse than the pre-existing behaviour it replaces.
 */
export function readScopeBudget(env: NodeJS.ProcessEnv = process.env): ScopeBudget {
  try {
    const out = execFileSync('bash', [PROBE_PATH, '--json'], {
      env,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(out) as { effective_cpu?: unknown; scope_mem_max_mb?: unknown; cgroup_v2?: unknown };
    const cpu = Number(parsed.effective_cpu);
    const mem = Number(parsed.scope_mem_max_mb);
    if (Number.isFinite(cpu) && cpu >= 1 && Number.isFinite(mem) && mem >= 1) {
      return { effectiveCpu: cpu, scopeMemMaxMb: mem, source: parsed.cgroup_v2 === true ? 'cgroup' : 'fallback' };
    }
  } catch {
    // fall through to the host fallback below
  }
  return { effectiveCpu: availableParallelism(), scopeMemMaxMb: Infinity, source: 'fallback' };
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  /** Injection seam for the unit tests; production reads the probe. */
  readBudget?: (env: NodeJS.ProcessEnv) => ScopeBudget;
}

/**
 * The width vitest.config.ts should use: the budget-derived width, optionally lowered by
 * QUAY_VITEST_MAX_WORKERS but never raised above it. An unusable override is reported and ignored
 * (exactly like the heap ceiling's QUAY_VITEST_HEAP_MB), rather than silently becoming "no budget".
 */
export function resolveWorkerWidth(opts: ResolveOptions = {}): number {
  const env = opts.env ?? process.env;
  const budget = (opts.readBudget ?? readScopeBudget)(env);
  const derived = deriveWorkerWidth(budget);

  const raw = env[MAX_WORKERS_ENV];
  if (raw === undefined || raw === '') return derived;

  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    console.warn(
      `vitest-worker-budget: ${MAX_WORKERS_ENV}=${raw} is not a positive number — using the budget-derived width ${derived}`,
    );
    return derived;
  }
  // The override may LOWER the width freely, but never exceed the budget: min(override, budget).
  return Math.min(Math.floor(n), derived);
}

function main(): void {
  const asJson = process.argv.includes('--json');
  const env = process.env;
  const budget = readScopeBudget(env);
  const derived = deriveWorkerWidth(budget);
  const resolved = resolveWorkerWidth({ env, readBudget: () => budget });
  if (asJson) {
    process.stdout.write(
      `${JSON.stringify({
        workers: resolved,
        budget_derived_workers: derived,
        effective_cpu: budget.effectiveCpu,
        scope_mem_max_mb: budget.scopeMemMaxMb,
        per_worker_budget_mb: PER_WORKER_BUDGET_MB,
        client_max_workers: CLIENT_MAX_WORKERS,
        source: budget.source,
        override: env[MAX_WORKERS_ENV] ?? null,
      })}\n`,
    );
    return;
  }
  process.stdout.write(`${resolved}\n`);
}

// Run as a CLI only when invoked directly (`node scripts/vitest-worker-budget.ts`), never when
// imported by vitest.config.ts or a test. `process.argv[1]` is absent under `node -e`, so the guard
// is also false there — which is what keeps the config import side-effect free.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
