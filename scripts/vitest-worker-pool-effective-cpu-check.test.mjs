#!/usr/bin/env node
// vitest-worker-pool-effective-cpu-check.test.mjs — locks the fact vitest.config.ts's
// `maxWorkers = min(CLIENT_MAX_WORKERS, floor(availableParallelism() / 2))` formula depends on:
// that `os.availableParallelism()` already reflects a cgroup v2 CPU bandwidth quota, so the formula
// does not oversubscribe a 2/4/8-effective-core environment even though it was never rewritten to
// read `scripts/effective-capacity.sh` directly.
//
// Why this exists instead of changing vitest.config.ts (gap-vitest-worker-pool-adapts-to-effective-cpu,
// AC0/AC-verify-only): the task's premise was "vitest.config.ts might need to read effective CPU from
// a quota-aware source instead of availableParallelism()". Measured on this host (Node v24.21.0, same
// binary quay independently measured on 2026-10-09): availableParallelism() under
// `systemd-run --scope -p CPUQuota=200%/400%/800%` reports 2/4/8 — it IS quota-aware. Rewriting
// vitest.config.ts to shell out to scripts/effective-capacity.sh would be a behavior change solving a
// problem that measurement shows does not exist. What's missing instead is a test that PINS this fact,
// so a future Node upgrade or libuv change that silently stops honoring cgroup quota gets caught here
// rather than as a mystery OOM/oversubscription report from a 2-core environment.
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

test('vitest.config.ts maxWorkers formula still reads directly from availableParallelism() (unchanged by design)', () => {
  const configPath = path.join(REPO_ROOT, 'vitest.config.ts');
  const text = fs.readFileSync(configPath, 'utf8');
  assert.match(text, /availableParallelism\(\)\s*\/\s*2/, 'vitest.config.ts should still derive maxWorkers from availableParallelism()/2 — this task intentionally does not replace it');
  assert.doesNotMatch(text, /effective-capacity\.sh/, 'vitest.config.ts must not shell out to the probe — AC0 found no reason to, and a config-time subprocess would be a needless new failure mode');
});
