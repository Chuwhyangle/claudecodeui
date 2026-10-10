#!/usr/bin/env node
// with-memory-cap-effective-default.test.mjs — guards the default-QUAY_MEMORY_MAX derivation added
// to scripts/with-memory-cap.sh (gap-with-memory-cap-default-adapts-to-effective-memory).
//
// Why: the cap used to be a bare 24G literal regardless of what the environment could actually hold.
// It is now derived from scripts/effective-capacity.sh's effective_mem_mb at a fixed safety fraction,
// clamped to [512, 24576] MB, but ONLY when QUAY_MEMORY_MAX is unset — every existing explicit-value
// caller (scripts/vitest-heap-limit-check.sh's "never touch this" contract included) must see byte-
// for-byte unchanged behavior. This test reads the REAL resulting cgroup limit from inside the scope
// (`cat /sys/fs/cgroup/memory.max`), not an intermediate shell variable, so it is checking what the
// kernel actually enforces, not what the script merely computed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, 'with-memory-cap.sh');
const MB = 1024 * 1024;

const SYSTEMD_RUN_AVAILABLE = (() => {
  const r = spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--', 'true'], { encoding: 'utf8' });
  return r.status === 0 && !r.error;
})();

// The scope's OWN memory.max lives at /sys/fs/cgroup<rel-path-of-this-cgroup>/memory.max, not at
// the cgroup ROOT — resolve it the same way scripts/effective-capacity.sh does (from inside the
// child, via its own /proc/self/cgroup "0::" line), not via a path guessed from the outside.
const READ_OWN_MEMORY_MAX = 'cat "/sys/fs/cgroup$(sed -n \'s/^0:://p\' /proc/self/cgroup)/memory.max"';

/** @param {Record<string,string>} env */
function realMemoryMaxBytes(env) {
  const r = spawnSync('bash', [SCRIPT, 'sh', '-c', READ_OWN_MEMORY_MAX], { env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.equal(r.status, 0, `with-memory-cap.sh exited ${r.status}, stderr: ${r.stderr}`);
  const n = Number(r.stdout.trim());
  assert.ok(Number.isFinite(n) && n > 0, `expected a positive byte count, got: ${JSON.stringify(r.stdout)}`);
  return n;
}

test('default (no QUAY_MEMORY_MAX): derives 75% of a seamed effective_mem_mb', { skip: !SYSTEMD_RUN_AVAILABLE && 'systemd-run --user --scope is not usable in this environment' }, () => {
  const bytes = realMemoryMaxBytes({ QUAY_MEMORY_MAX: '', EFFECTIVE_CAPACITY_TEST_MEMORY_MAX: 'max', EFFECTIVE_CAPACITY_TEST_MEM_AVAIL_MB: '2048' });
  assert.equal(Math.round(bytes / MB), 1536, '2048MB effective at 75% should derive a 1536M cap');
});

test('default: floors at 512 MB for a seamed tiny effective_mem_mb', { skip: !SYSTEMD_RUN_AVAILABLE && 'systemd-run --user --scope is not usable in this environment' }, () => {
  const bytes = realMemoryMaxBytes({ QUAY_MEMORY_MAX: '', EFFECTIVE_CAPACITY_TEST_MEMORY_MAX: 'max', EFFECTIVE_CAPACITY_TEST_MEM_AVAIL_MB: '400' });
  assert.equal(Math.round(bytes / MB), 512, '400MB effective at 75% (300MB) should floor to 512M, not derive below it');
});

test('default: ceilings at 24576 MB (24G, the pre-existing literal) for a seamed huge effective_mem_mb', { skip: !SYSTEMD_RUN_AVAILABLE && 'systemd-run --user --scope is not usable in this environment' }, () => {
  const bytes = realMemoryMaxBytes({ QUAY_MEMORY_MAX: '', EFFECTIVE_CAPACITY_TEST_MEMORY_MAX: 'max', EFFECTIVE_CAPACITY_TEST_MEM_AVAIL_MB: '1048576' });
  assert.equal(Math.round(bytes / MB), 24576, 'a host with no tighter cgroup limit must see the unchanged pre-existing 24G ceiling');
});

test('explicit QUAY_MEMORY_MAX is used verbatim, unaffected by the seams', { skip: !SYSTEMD_RUN_AVAILABLE && 'systemd-run --user --scope is not usable in this environment' }, () => {
  const bytes = realMemoryMaxBytes({ QUAY_MEMORY_MAX: '777M', EFFECTIVE_CAPACITY_TEST_MEMORY_MAX: 'max', EFFECTIVE_CAPACITY_TEST_MEM_AVAIL_MB: '2048' });
  assert.equal(Math.round(bytes / MB), 777, 'an explicit QUAY_MEMORY_MAX must not be touched by the default-derivation logic');
});

test('QUAY_MEMORY_MAX=off still bypasses the scope entirely (unaffected by this task)', () => {
  const direct = spawnSync('node', ['-e', 'process.stdout.write("x")'], { encoding: 'utf8' });
  const wrapped = spawnSync('bash', [SCRIPT, 'node', '-e', 'process.stdout.write("x")'], {
    env: { ...process.env, QUAY_MEMORY_MAX: 'off' },
    encoding: 'utf8',
  });
  assert.equal(wrapped.status, direct.status);
  assert.equal(wrapped.stdout, direct.stdout);
});

test('QUAY_MEMORY_MAX=0 still bypasses the scope entirely (unaffected by this task)', () => {
  const wrapped = spawnSync('bash', [SCRIPT, 'node', '-e', 'process.stdout.write("x")'], {
    env: { ...process.env, QUAY_MEMORY_MAX: '0' },
    encoding: 'utf8',
  });
  assert.equal(wrapped.status, 0);
  assert.equal(wrapped.stdout, 'x');
});
