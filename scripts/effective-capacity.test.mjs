#!/usr/bin/env node
// effective-capacity.test.mjs — guard for scripts/effective-capacity.sh.
//
// This is a read-only cgroup-v2 probe (gap-effective-capacity-probe-cgroup-cpu-mem-quota): it must
// never change behavior for any existing consumer (none yet — this script has no consumers in this
// repo until the follow-on tasks land), so the only thing worth pinning down is that its OWN output
// contract (field names, fail-open semantics, tie-break priority, test seams) is correct and does not
// silently regress. The output contract's field names and the five `EFFECTIVE_CAPACITY_TEST_*` seam
// names were frozen by a 2026-10-09 cross-project alignment with quay's own
// plugin/scripts/effective-capacity-probe.ts port — this test does not re-verify that alignment (that
// needs both sides' real output, done separately), only that THIS script's own contract holds.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, 'effective-capacity.sh');

/** @param {Record<string,string>} [env] @param {string[]} [args] */
function run(env = {}, args = []) {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** @param {string} report */
function parseReport(report) {
  /** @type {Record<string,string>} */
  const out = {};
  for (const line of report.trim().split('\n')) {
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

const FIELD_ORDER = ['effective_cpu', 'cpu_source', 'effective_mem_mb', 'mem_source', 'nproc', 'cgroup_v2'];

test('report mode: all six fields present, in the frozen order, exit 0', () => {
  const { status, stdout } = run();
  assert.equal(status, 0);
  const lines = stdout.trim().split('\n');
  assert.equal(lines.length, 6, `expected exactly 6 lines, got: ${stdout}`);
  for (let i = 0; i < FIELD_ORDER.length; i++) {
    assert.ok(lines[i].startsWith(`${FIELD_ORDER[i]}=`), `line ${i} should start with "${FIELD_ORDER[i]}=", got: ${lines[i]}`);
  }
});

test('--json mode: same six keys, same values as report mode', () => {
  const report = parseReport(run().stdout);
  const { status, stdout } = run({}, ['--json']);
  assert.equal(status, 0);
  const json = JSON.parse(stdout);
  for (const key of FIELD_ORDER) {
    assert.ok(key in json, `--json output missing key ${key}`);
    assert.equal(String(json[key]), report[key], `--json/${key} disagrees with report mode`);
  }
});

test('--help exits 0 and does not run the probe', () => {
  const { status, stdout } = run({}, ['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /effective-capacity\.sh/);
});

test('-h is accepted the same as --help', () => {
  const { status } = run({}, ['-h']);
  assert.equal(status, 0);
});

test('an unknown flag exits 2 and names the flag (not a vacuous pass)', () => {
  const { status, stderr } = run({}, ['--not-a-real-flag']);
  assert.equal(status, 2);
  assert.match(stderr, /--not-a-real-flag/);
});

// ── fail-open via test seams (AC2: never depends on actually finding a host without cgroup v2) ─────

test('CPU seam "max" falls back to the injected nproc reading, source=nproc-fallback', () => {
  const out = parseReport(
    run({ EFFECTIVE_CAPACITY_TEST_CPU_MAX: 'max', EFFECTIVE_CAPACITY_TEST_NPROC: '4' }).stdout,
  );
  assert.equal(out.effective_cpu, '4');
  assert.equal(out.cpu_source, 'nproc-fallback');
  assert.equal(out.cgroup_v2, 'true', 'a seam being set at all asserts a cgroup was read');
});

test('memory seam "max" falls back to the injected mem-avail reading, source=free-fallback', () => {
  const out = parseReport(
    run({ EFFECTIVE_CAPACITY_TEST_MEMORY_MAX: 'max', EFFECTIVE_CAPACITY_TEST_MEM_AVAIL_MB: '2048' }).stdout,
  );
  assert.equal(out.effective_mem_mb, '2048');
  assert.equal(out.mem_source, 'free-fallback');
});

test('exit code is 0 even when every seam asserts "no limit" (fail-open, not fail-closed)', () => {
  const { status } = run({
    EFFECTIVE_CAPACITY_TEST_CPU_MAX: 'max',
    EFFECTIVE_CAPACITY_TEST_MEMORY_MAX: 'max',
    EFFECTIVE_CAPACITY_TEST_NPROC: '1',
    EFFECTIVE_CAPACITY_TEST_MEM_AVAIL_MB: '1',
  });
  assert.equal(status, 0);
});

// ── bandwidth-quota math (core contract: floor(quota/period), clamped to >= 1) ───────────────────────

test('cpu.max quota/period derives floor(quota/period) cores, source=cgroup-cpu-max', () => {
  const out = parseReport(run({ EFFECTIVE_CAPACITY_TEST_CPU_MAX: '200000 100000' }).stdout);
  assert.equal(out.effective_cpu, '2');
  assert.equal(out.cpu_source, 'cgroup-cpu-max');
  assert.equal(out.cgroup_v2, 'true');
});

test('a sub-one-core quota clamps to 1, not 0 (0 would read as a real zero-core limit)', () => {
  const out = parseReport(run({ EFFECTIVE_CAPACITY_TEST_CPU_MAX: '10000 100000' }).stdout);
  assert.equal(out.effective_cpu, '1');
  assert.equal(out.cpu_source, 'cgroup-cpu-max');
});

test('cpuset count participates as its own candidate, source=cpuset', () => {
  const out = parseReport(
    run({ EFFECTIVE_CAPACITY_TEST_CPU_MAX: 'max', EFFECTIVE_CAPACITY_TEST_CPUSET_COUNT: '3', EFFECTIVE_CAPACITY_TEST_NPROC: '128' })
      .stdout,
  );
  assert.equal(out.effective_cpu, '3');
  assert.equal(out.cpu_source, 'cpuset');
});

// ── tie-break priority: cgroup-cpu-max > cpuset > nproc-fallback (NEGATIVE CONTROL: a naive
//    "overwrite on <=" or "last writer wins" implementation would get this wrong on exact ties) ────

test('tie-break: cgroup-cpu-max beats an EQUAL-valued cpuset candidate', () => {
  const out = parseReport(
    run({ EFFECTIVE_CAPACITY_TEST_CPU_MAX: '300000 100000', EFFECTIVE_CAPACITY_TEST_CPUSET_COUNT: '3' }).stdout,
  );
  assert.equal(out.effective_cpu, '3');
  assert.equal(out.cpu_source, 'cgroup-cpu-max', 'a cgroup bandwidth constraint equal to cpuset must still report as the cgroup constraint');
});

test('tie-break: cpuset beats an EQUAL-valued nproc-fallback candidate', () => {
  const out = parseReport(
    run({ EFFECTIVE_CAPACITY_TEST_CPUSET_COUNT: '5', EFFECTIVE_CAPACITY_TEST_NPROC: '5' }).stdout,
  );
  assert.equal(out.effective_cpu, '5');
  assert.equal(out.cpu_source, 'cpuset', 'a cpuset constraint equal to the nproc fallback must still report as the cpuset constraint');
});

test('the smaller of two DIFFERING candidates wins regardless of priority order', () => {
  const out = parseReport(
    run({ EFFECTIVE_CAPACITY_TEST_CPU_MAX: '800000 100000', EFFECTIVE_CAPACITY_TEST_CPUSET_COUNT: '3' }).stdout,
  );
  assert.equal(out.effective_cpu, '3');
  assert.equal(out.cpu_source, 'cpuset', 'cpuset(3) < cgroup-cpu-max(8) must win even though cgroup-cpu-max has higher tie-break priority');
});

// ── memory derivation ────────────────────────────────────────────────────────────────────────────

test('memory.max bytes derives floor(bytes/MB), source=cgroup-memory-max', () => {
  const twoGiB = 2 * 1024 * 1024 * 1024;
  const out = parseReport(run({ EFFECTIVE_CAPACITY_TEST_MEMORY_MAX: String(twoGiB) }).stdout);
  assert.equal(out.effective_mem_mb, '2048');
  assert.equal(out.mem_source, 'cgroup-memory-max');
});

// ── real cgroup v2 environment (no seams — this host's own /sys/fs/cgroup) ──────────────────────────

test('on this host (real cgroup v2 unified hierarchy mounted), cgroup_v2 reads true with no seams', () => {
  const out = parseReport(run().stdout);
  assert.equal(out.cgroup_v2, 'true', 'this host is expected to have cgroup v2 mounted; if this fails on a different host, that is a real environment difference worth recording, not a bug in the probe');
});

// ── a real CPUQuota-constrained scope (not a seam) — skipped when systemd-run is unavailable ────────

test('a real systemd-run --scope -p CPUQuota=200% reports effective_cpu=2 via cgroup-cpu-max', (t) => {
  const probe = spawnSync('systemd-run', ['--user', '--scope', '--quiet', '-p', 'CPUQuota=200%', '--', 'bash', SCRIPT], {
    encoding: 'utf8',
  });
  if (probe.status !== 0 || probe.error) {
    t.skip('systemd-run --user --scope is not usable in this environment');
    return;
  }
  const out = parseReport(probe.stdout);
  assert.equal(out.effective_cpu, '2');
  assert.equal(out.cpu_source, 'cgroup-cpu-max');
  assert.equal(out.cgroup_v2, 'true');
});
