import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

import { resolveWorkerWidth } from './scripts/vitest-worker-budget.mjs';
import {
  CONSOLE_LOG_ENV,
  consoleLogAnnouncement,
  createConsoleLogSink,
  createFailureVerdictReporter,
  resetConsoleLog,
  resolveConsoleLogPath,
} from './scripts/vitest-console-log.mjs';

// Vitest sizes its client worker pool from `os.availableParallelism()` when the
// config pins nothing — 128 workers on this box. A single suite survives that,
// but quay never runs a single suite: every task worker runs scripts/test.sh as
// one of its own judging criteria, and fan-in runs it again, so several ~128-way
// pools overlap. They oversubscribe Vite's module server and workers die
// mid-run, surfacing as `STACK_TRACE_ERROR` and `Timeout calling "fetch"` — at
// the reporter layer those are indistinguishable from real test failures, and a
// different subset of files goes red each run.
//
// So bound the pool — and bound it by the REAL budget, not by cores alone. The width is
// `min(CLIENT_MAX_WORKERS, effective CPU, scope memory budget)` (scripts/vitest-worker-budget.mjs):
// the effective CPU count (cgroup quota / cpuset / nproc, from scripts/effective-capacity.sh) AND the
// CALLER'S OWN SCOPE `memory.max`, divided by a measured per-worker reservation. Cores alone is half a
// budget — a pool of N workers each allowed a 4352 MB heap (below) has a theoretical ceiling of
// N × 4352 MB, and a scope-limited run must not ask for a pool whose ceiling exceeds its own cap.
//
// ⛔ The heap ceiling is NOT a reservation. 8 × 4352 MB = 34.8 GiB is what V8 is *allowed* to grow to
// per worker — a theoretical upper bound, never a measured peak. The measured peak of a run is that
// run's cgroup `memory.peak`, and the budget is sized against THAT (see the module header). Do not
// re-derive the width from 34.8.
//
// ⛔ Invariant (enforced in scripts/vitest-worker-budget.mjs, not restated as a loose knob here): a
// "minimum width" may never push the pool past the budget. If the budget works out below any floor,
// the width goes below the floor too — the only lower bound is 1.
//
// QUAY_VITEST_MAX_WORKERS lowers (or raises, within budget) the width; it is clamped back into the
// budget and can never exceed it. `node scripts/vitest-worker-budget.mjs --json` prints the readings.
const maxWorkers = resolveWorkerWidth();

// Per-worker V8 heap ceiling (gap-vitest-worker-heap-limit). The cgroup cap in
// scripts/with-memory-cap.sh is LAYERED ON TOP of this, not replaced by it: the two bound
// different channels. `--max-old-space-size` bounds only the JS heap, so a runaway that
// retains objects dies in seconds inside its worker; a runaway that grows Buffer/external/
// native memory instead is invisible to it and still needs the cgroup.
//
// Why this exists at all: the cgroup cap only covers the two entry points that opt into the
// wrapper (`npm run test:client`, scripts/test.sh). A bare `npx vitest run` — which is what
// the 2026-09-25 incident actually was — bypasses it entirely, and a config-layer ceiling
// applies to every entry point instead: npx, npm run, test.sh, editor integrations.
//
// 4352 MB is MEASURED, not guessed: `npx vitest run --logHeapUsage` over the whole client
// suite (103 files, 725 cases) reads a per-file maximum of 1401 MB
// (src/shared/asr/tests/asrContractInvariants.test.ts); the next file is 561 MB. 4352 is
// 3.11x that maximum — above the 3x floor this ceiling was specified with, and the tightest
// value above it, so the ceiling stays as close to real usage as the criterion allows.
// Re-derive it after a suite change by reading the same measurement back:
//   npx vitest run --logHeapUsage 2>&1 | grep -oE '[0-9]+ MB heap used' | sort -n | tail -5
// The value belongs above 3x the new maximum — 4352 is the tightest one above 3.11x. This
// number is a policy choice that a human has to make, so it is written down here rather
// than recomputed at runtime: deriving it live would put a full suite run inside every
// `vitest run`.
//
// Note what this is NOT: it is not a cap on the machine's memory use, and it is barely below
// Node's own default `heap_size_limit` here (4288 MB on this 246 GB box). Its job is to make
// the failure FAST and ATTRIBUTABLE, not to make it small.
//
// QUAY_VITEST_HEAP_MB overrides it; `off` (or `0`) adds no argument at all, which is the
// unguarded control the falsification mode of the check script needs.
const DEFAULT_WORKER_HEAP_MB = 4352;
const WORKER_HEAP_MB: number | null = (() => {
  const raw = process.env.QUAY_VITEST_HEAP_MB;
  if (raw === undefined || raw === '') return DEFAULT_WORKER_HEAP_MB;
  if (raw === 'off' || raw === '0') return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  // An unusable override must not silently become "no ceiling": that is the exact failure
  // this whole config change exists to prevent. Say so, then fall back to the ceiling.
  console.warn(
    `vitest.config.ts: QUAY_VITEST_HEAP_MB=${raw} is not a positive number or "off" — using ${DEFAULT_WORKER_HEAP_MB} MB`,
  );
  return DEFAULT_WORKER_HEAP_MB;
})();

// Test-console attribution (gap-ac323-vitest-stderr-masks-load-flake).
//
// The goal gate records a failed criterion's reason from the run's STDERR head. This suite calls
// `console.error` in ordinary green cases (jsdom's `Not implemented`, `[Auth] session lapse
// recorded`, `UPSTREAM_ERROR`), so on AC-323's `npx vitest run …` leg the gate's 500-character
// window held only that noise and `[truncated, N chars omitted]` — the failing case's name, which
// the reporter writes to STDOUT, could never be read, and every red along AC-323 was a guess.
//
// `onConsoleLog` now appends those lines to a per-run file (scripts/vitest-console-log.mjs) and
// returns `false` to stop vitest forwarding them to the runner's streams. Nothing is discarded:
// the file path is printed on stdout below. Vitest's OWN failures (a dead worker, `Timeout calling
// "fetch"`) still reach stderr, so it is informative again; when stderr is empty the gate falls
// back to the stdout tail, where the reporter writes the failing file/test and `1 failed`.
//
// Only the OWNING process truncates and announces. Forked workers re-evaluate this file with
// `QUAY_VITEST_CONSOLE_LOG` already exported by the owner: they must append to that same file
// (truncating there would wipe the lines an earlier worker already wrote).
const consoleLogPath = resolveConsoleLogPath();
if (!process.env[CONSOLE_LOG_ENV]) {
  process.env[CONSOLE_LOG_ENV] = consoleLogPath;
  resetConsoleLog(consoleLogPath);
  console.log(consoleLogAnnouncement(consoleLogPath));
}

// The client test suite runs under jsdom because the hook and component tests
// added alongside the state refactor rely on real effects, DOM events and
// localStorage — none of which run under react-dom/server.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // The repository-root shared tree (ADR-004 decision 2). Registered here because this
      // file's `resolve.alias` is its own — vitest prefers vitest.config.ts over
      // vite.config.js, so it inherits nothing from that one, and a frontend module importing
      // `@shared/...` fails to transform with "Failed to resolve import". Four registrations
      // are needed in total and none of them covers another: tsconfig.json (typecheck),
      // vite.config.js (the bundle), this file (the unit-test transform) and .oxlintrc.json
      // (the lint resolver + boundaries).
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify('0.0.0-test'),
  },
  test: {
    environment: 'jsdom',
    // Pinned so the suite does not silently change shape with a developer's
    // local .env — this workspace has VITE_IS_PLATFORM=true, CI has no .env at
    // all, and the flag decides whether the app authenticates with a bearer
    // token. The tests that care stub it per case and assert both modes.
    env: {
      VITE_IS_PLATFORM: 'false',
    },
    setupFiles: ['./vitest.setup.ts'],
    // Test-console noise leaves the runner's streams and lands in the run's own log; see the
    // block above. `false` is vitest's "do not forward" contract.
    onConsoleLog: createConsoleLogSink(consoleLogPath),
    // The verdict line is written before `default` so it is the FIRST bytes of a red run's
    // stderr — the gate's excerpt is the stderr head. Green runs write nothing.
    reporters: [createFailureVerdictReporter(), 'default'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    restoreMocks: true,
    // Both budgets are declared here rather than left to vitest's defaults (5000 /
    // 10000). `vi.resetModules()` plus an in-case dynamic `import()` makes one case
    // pay a whole module graph's cold compile (measured 2.7–3.0s for the
    // useProjectsState graph) — in a case budget, 60% of it gone before the test
    // does anything, which is how AC-103's condition ① went red 1–2 times in 15
    // runs while its signature counters stayed at 0. The family now warms that
    // graph in `beforeAll` (charged to hookTimeout) and
    // scripts/test-timeout-margin-check.sh reads testTimeout back to assert every
    // file keeps T_max <= testTimeout / K.
    //
    // testTimeout stays at the default: the fix does not need a bigger case budget,
    // and widening it would blunt the hang detection a case budget exists for.
    // hookTimeout is the budget that now carries the compile, so it is sized from
    // the measurement instead: 2.8s quiet, and ~5.3s under the exact contention
    // shape AC-103 exercises (2 client pools ‖ 2 server phases: file wall time
    // 6037ms minus ~700ms of cases). 20000 leaves ~3.8× over that contended
    // reading, against the 1.9× the 10000 default would have left — and 1.9× is
    // precisely the margin that already failed in the case budget.
    testTimeout: 5000,
    hookTimeout: 20000,
    maxWorkers,
    // Pinned rather than left to the default: `poolOptions.forks.execArgv` below is only
    // reachable if the pool is `forks`, and vitest 3.2.7's default happens to be exactly that.
    // Pinning it makes the ceiling fail loudly (wrong pool ⇒ no execArgv) instead of quietly
    // becoming a no-op on a future default change.
    pool: 'forks',
    poolOptions: {
      forks: {
        // The ceiling itself. See WORKER_HEAP_MB above for the value's derivation and for
        // what this does and does not bound.
        execArgv: WORKER_HEAP_MB === null ? [] : [`--max-old-space-size=${WORKER_HEAP_MB}`],
      },
    },
  },
});
