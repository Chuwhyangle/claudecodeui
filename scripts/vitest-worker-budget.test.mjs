#!/usr/bin/env node
// vitest-worker-budget.test.mjs — unit tests for the vitest worker-width budget derivation.
//
// Why this exists (gap-vitest-worker-cap-from-real-scope-budget): vitest.config.ts's worker width used
// to come from CORES ONLY (`min(8, floor(availableParallelism() / 2))`), so a memory-limited scope
// still asked for a pool whose heap ceiling exceeded its own cap. The width now comes from
// `min(CLIENT_MAX_WORKERS, effective CPU, scope memory budget)` (scripts/vitest-worker-budget.ts).
// This pins that derivation against the four shapes the task names — 16 GiB scope, 8 GiB scope, no
// cgroup, cpuset=2 — plus the override clamp, using BOTH the pure function and the real probe
// (through the probe's own EFFECTIVE_CAPACITY_TEST_* seams, not a second hand-rolled reader).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CLIENT_MAX_WORKERS,
  PER_WORKER_BUDGET_MB,
  deriveWorkerWidth,
  readScopeBudget,
  resolveWorkerWidth,
} from './vitest-worker-budget.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.join(__dirname, 'vitest-worker-budget.mjs');

const GiB = 1024; // MB in one GiB

// ── the pure derivation: the four shapes the AC names ────────────────────────────────────────────
test('16 GiB scope, wide CPU: budget keeps the full width', () => {
  const w = deriveWorkerWidth({ effectiveCpu: 128, scopeMemMaxMb: 16 * GiB, source: 'cgroup' });
  assert.equal(w, CLIENT_MAX_WORKERS, `16 GiB / ${PER_WORKER_BUDGET_MB} MB supports the full ${CLIENT_MAX_WORKERS}-worker width`);
});

test('8 GiB scope, wide CPU: the memory budget halves the width', () => {
  const w = deriveWorkerWidth({ effectiveCpu: 128, scopeMemMaxMb: 8 * GiB, source: 'cgroup' });
  assert.equal(w, 4, '8 GiB / 2048 MB = 4 workers — the memory side binds, not the cores');
});

test('no cgroup (scopeMemMaxMb = Infinity): memory does not bind, the cap does', () => {
  const w = deriveWorkerWidth({ effectiveCpu: 128, scopeMemMaxMb: Infinity, source: 'fallback' });
  assert.equal(w, CLIENT_MAX_WORKERS, 'an unlimited scope contributes CLIENT_MAX_WORKERS, then the cap holds');
});

test('cpuset=2: the CPU side binds below the memory budget', () => {
  const w = deriveWorkerWidth({ effectiveCpu: 2, scopeMemMaxMb: 16 * GiB, source: 'cgroup' });
  assert.equal(w, 2, '2 effective cores must stay 2 even though 16 GiB would allow 8');
});

test('the two sides are an INTERSECTION, not either-or', () => {
  // CPU-limited and memory-limited each alone would give more/less; the minimum wins both ways.
  assert.equal(deriveWorkerWidth({ effectiveCpu: 3, scopeMemMaxMb: 64 * GiB, source: 'cgroup' }), 3);
  assert.equal(deriveWorkerWidth({ effectiveCpu: 64, scopeMemMaxMb: 3 * PER_WORKER_BUDGET_MB, source: 'cgroup' }), 3);
});

test('a budget below any floor yields a width below it — never 0, never a floor above the budget', () => {
  // 3 GiB / 2048 MB = 1; 1 GiB / 2048 MB floors at 1 (vitest cannot run 0 workers). There is no floor
  // of 4 anywhere: the width is bounded by the budget, not raised to a minimum.
  assert.equal(deriveWorkerWidth({ effectiveCpu: 128, scopeMemMaxMb: 3 * GiB, source: 'cgroup' }), 1);
  assert.equal(deriveWorkerWidth({ effectiveCpu: 128, scopeMemMaxMb: 1 * GiB, source: 'cgroup' }), 1);
  assert.ok(deriveWorkerWidth({ effectiveCpu: 128, scopeMemMaxMb: 1 * GiB, source: 'cgroup' }) >= 1);
});

// ── the override: honored within budget, clamped into it, unusable reported ──────────────────────
// JSDoc return types are load-bearing: checkJs (scripts/tsconfig.json) would otherwise infer
// `source: string` and reject these as `readBudget` seams.
/** @returns {import('./vitest-worker-budget.mjs').ScopeBudget} */
const budget16 = () => ({ effectiveCpu: 128, scopeMemMaxMb: 16 * GiB, source: 'cgroup' });
/** @returns {import('./vitest-worker-budget.mjs').ScopeBudget} */
const budget8 = () => ({ effectiveCpu: 128, scopeMemMaxMb: 8 * GiB, source: 'cgroup' });

test('no override -> the budget-derived width', () => {
  assert.equal(resolveWorkerWidth({ env: {}, readBudget: budget16 }), 8);
  assert.equal(resolveWorkerWidth({ env: {}, readBudget: budget8 }), 4);
});

test('an override BELOW the budget is honored', () => {
  assert.equal(resolveWorkerWidth({ env: { QUAY_VITEST_MAX_WORKERS: '4' }, readBudget: budget16 }), 4);
  assert.equal(resolveWorkerWidth({ env: { QUAY_VITEST_MAX_WORKERS: '2' }, readBudget: budget16 }), 2);
});

test('an override ABOVE the budget is clamped back into it (cannot escape the budget)', () => {
  // The whole point of AC2: the override may not re-open the oversubscription the budget closes.
  assert.equal(resolveWorkerWidth({ env: { QUAY_VITEST_MAX_WORKERS: '100' }, readBudget: budget8 }), 4);
  assert.equal(resolveWorkerWidth({ env: { QUAY_VITEST_MAX_WORKERS: '16' }, readBudget: budget16 }), 8);
});

test('an unusable override is ignored (with a warning), not treated as "no budget"', () => {
  assert.equal(resolveWorkerWidth({ env: { QUAY_VITEST_MAX_WORKERS: 'nope' }, readBudget: budget16 }), 8);
  assert.equal(resolveWorkerWidth({ env: { QUAY_VITEST_MAX_WORKERS: '0' }, readBudget: budget16 }), 8);
  assert.equal(resolveWorkerWidth({ env: { QUAY_VITEST_MAX_WORKERS: '-3' }, readBudget: budget16 }), 8);
});

// ── the real probe: the same shape, driven through effective-capacity.sh's own seams ──────────────
// These do NOT re-implement cpu.max/memory.max parsing — they assert readScopeBudget() consumes the
// probe's documented fields, so the reading has ONE source.
test('readScopeBudget reads 16 GiB from a real (seamed) 16G scope', () => {
  const env = {
    ...process.env,
    EFFECTIVE_CAPACITY_TEST_MEMORY_MAX: String(16 * 1024 * 1024 * 1024), // own memory.max in bytes
    EFFECTIVE_CAPACITY_TEST_NPROC: '128',
  };
  const budget = readScopeBudget(env);
  assert.equal(budget.scopeMemMaxMb, 16 * GiB);
  assert.equal(budget.source, 'cgroup');
  assert.equal(deriveWorkerWidth(budget), 8);
});

test('readScopeBudget reads 8 GiB from a real (seamed) 8G scope -> width 4', () => {
  const env = {
    ...process.env,
    EFFECTIVE_CAPACITY_TEST_MEMORY_MAX: String(8 * 1024 * 1024 * 1024),
    EFFECTIVE_CAPACITY_TEST_NPROC: '128',
  };
  const budget = readScopeBudget(env);
  assert.equal(budget.scopeMemMaxMb, 8 * GiB);
  assert.equal(deriveWorkerWidth(budget), 4);
});

test('readScopeBudget honors cpuset=2 even inside a 16 GiB scope -> width 2', () => {
  const env = {
    ...process.env,
    EFFECTIVE_CAPACITY_TEST_MEMORY_MAX: String(16 * 1024 * 1024 * 1024),
    EFFECTIVE_CAPACITY_TEST_CPUSET_COUNT: '2',
    EFFECTIVE_CAPACITY_TEST_NPROC: '128',
  };
  const budget = readScopeBudget(env);
  assert.equal(budget.effectiveCpu, 2);
  assert.equal(deriveWorkerWidth(budget), 2);
});

test('readScopeBudget fails OPEN when the probe cannot be run', () => {
  // A nonexistent probe path would throw in execFileSync; readScopeBudget must still return a usable
  // budget (host parallelism, no memory limit) rather than propagating — the config must always load.
  const budget = readScopeBudget({ PATH: '/nonexistent', EFFECTIVE_CAPACITY_TEST_MEMORY_MAX: 'x' });
  assert.ok(Number.isFinite(budget.effectiveCpu) && budget.effectiveCpu >= 1);
});

// ── the CLI (what an operator/evidence-reader runs) ───────────────────────────────────────────────
test('CLI --json reports the width and its inputs through the seams', () => {
  const env = {
    ...process.env,
    EFFECTIVE_CAPACITY_TEST_MEMORY_MAX: String(16 * 1024 * 1024 * 1024),
    EFFECTIVE_CAPACITY_TEST_NPROC: '128',
  };
  const out = execFileSync(process.execPath, [MODULE, '--json'], { env, encoding: 'utf8' });
  const j = JSON.parse(out);
  assert.equal(j.workers, 8);
  assert.equal(j.scope_mem_max_mb, 16 * GiB);
  assert.equal(j.per_worker_budget_mb, PER_WORKER_BUDGET_MB);
  assert.equal(j.client_max_workers, CLIENT_MAX_WORKERS);
});

test('CLI bare line is just the width', () => {
  const env = {
    ...process.env,
    EFFECTIVE_CAPACITY_TEST_MEMORY_MAX: String(8 * 1024 * 1024 * 1024),
    EFFECTIVE_CAPACITY_TEST_NPROC: '128',
  };
  const out = execFileSync(process.execPath, [MODULE], { env, encoding: 'utf8' }).trim();
  assert.equal(out, '4');
});
