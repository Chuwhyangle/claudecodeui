#!/usr/bin/env node
// vitest-worker-pool-effective-cpu-check.test.mjs — pins that the CPU side of the vitest worker-width
// budget is real: `os.availableParallelism()` reflects a cgroup v2 CPU bandwidth quota (measured on
// this host, Node v24.21.0: CPUQuota=200%/400%/800% -> 2/4/8), and scripts/effective-capacity.sh's
// `effective_cpu` agrees with it. A future Node/libuv change that silently stopped honoring cgroup
// quota would show up here (a 2-core environment oversubscribed) rather than as a mystery OOM.
//
// ⚠️ The vitest.config.ts side CHANGED (gap-vitest-worker-cap-from-real-scope-budget): the width is no
// longer `min(8, floor(availableParallelism() / 2))` — cores alone, which ignored memory. It is now
// `min(CLIENT_MAX_WORKERS, effective CPU, scope memory budget)`, derived in
// scripts/vitest-worker-budget.mjs and imported by vitest.config.ts. That module reads the effective
// capacity through this same probe, so the CPU facts pinned below are the CPU facts the budget uses.
// The config-level assertion at the bottom was updated to pin the NEW wiring (the module is the source;
// the old cores-only formula is gone) instead of the retired one.
//
// The comparison is against scripts/effective-capacity.sh's `effective_cpu` field (not a second,
// hand-rolled cpu.max reader in this file) specifically so this check is falsifiable: the negative
// control below injects an EFFECTIVE_CAPACITY_TEST_* seam that makes the probe disagree with the real
// os.availableParallelism() reading, and asserts the disagreement is detected — proving the positive
// case is a real comparison, not a tautology.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const PROBE = path.join(__dirname, 'effective-capacity.sh');

/** @param {Record<string,string>} [env] */
function probeEffectiveCpu(env = {}) {
  const out = execFileSync('bash', [PROBE], { env: { ...process.env, ...env }, encoding: 'utf8' });
  const m = /^effective_cpu=(\d+)$/m.exec(out);
  assert.ok(m, `probe output missing effective_cpu line: ${out}`);
  return Number(m[1]);
}

test('no cgroup CPU limit on the current process: availableParallelism() agrees with the probe', () => {
  const real = os.availableParallelism();
  const probed = probeEffectiveCpu();
  assert.equal(real, probed, 'availableParallelism() and scripts/effective-capacity.sh effective_cpu disagree with no seam applied');
});

test('negative control: an injected seam mismatch IS detected (the comparison is not vacuous)', () => {
  const real = os.availableParallelism();
  const forcedMismatch = real + 37; // arbitrary, just has to differ from the real reading
  const probedWithSeam = probeEffectiveCpu({ EFFECTIVE_CAPACITY_TEST_NPROC: String(forcedMismatch) });
  assert.notEqual(real, probedWithSeam, 'the seam failed to force a disagreement — this would make the positive-case assertion above vacuous');
});

/**
 * @param {string} quotaPercent
 * @param {number} expectedCores
 * @param {import('node:test').TestContext} t
 */
function checkUnderRealQuota(quotaPercent, expectedCores, t) {
  const probe = spawnSync(
    'systemd-run',
    ['--user', '--scope', '--quiet', '-p', `CPUQuota=${quotaPercent}`, '--', 'node', '-e', 'process.stdout.write(String(require("os").availableParallelism()))'],
    { encoding: 'utf8' },
  );
  if (probe.status !== 0 || probe.error) {
    t.skip('systemd-run --user --scope is not usable in this environment');
    return;
  }
  const real = Number(probe.stdout.trim());
  assert.equal(real, expectedCores, `availableParallelism() under CPUQuota=${quotaPercent} should read ${expectedCores}, got ${real}`);
}

test('real CPUQuota=200% -> availableParallelism()=2', (t) => checkUnderRealQuota('200%', 2, t));
test('real CPUQuota=400% -> availableParallelism()=4', (t) => checkUnderRealQuota('400%', 4, t));
test('real CPUQuota=800% -> availableParallelism()=8', (t) => checkUnderRealQuota('800%', 8, t));

test('vitest.config.ts derives maxWorkers from the scope-budget module, not from cores alone', () => {
  const configPath = path.join(REPO_ROOT, 'vitest.config.ts');
  const text = fs.readFileSync(configPath, 'utf8');
  // The new source of truth: the budget module (which intersects effective CPU with the own-scope
  // memory budget). A `.mjs` on purpose — scripts/tsconfig.json type-checks `scripts/**/*.mjs`
  // (checkJs, strict) and is .mjs-only, so this is the only shape that both loads under bare `node`
  // and lands under that type gate.
  assert.match(
    text,
    /from\s+['"]\.\/scripts\/vitest-worker-budget\.mjs['"]/,
    'vitest.config.ts must import the worker-width budget module — the width is no longer cores-only',
  );
  assert.match(text, /resolveWorkerWidth\(\)/, 'vitest.config.ts must call resolveWorkerWidth() for test.maxWorkers');
  // The retired cores-only formula must be GONE: its absence is what makes the budget the only source.
  assert.doesNotMatch(
    text,
    /availableParallelism\(\)\s*\/\s*2/,
    'vitest.config.ts must not fall back to the cores-only availableParallelism()/2 formula — that is the half-budget this task replaced',
  );
});
