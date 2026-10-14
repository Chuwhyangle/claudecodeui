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
//
// 2026-10-14 addition (gap-effective-capacity-scope-own-budget-and-actual-concurrency-display): the
// probe now walks the cgroup ANCESTOR chain and reports two extra fields AFTER the frozen six, so the
// first six field names/positions are unchanged for every existing consumer. Those two additions, and
// the two new ancestor seams that exercise them, are covered by the "hierarchical readings" section at
// the bottom of this file. The frozen six are still asserted as a PREFIX, not merely as a set.
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

// The first six are the 2026-10-09 frozen contract (names AND positions); the two `scope_mem_*` keys
// are the 2026-10-14 addition appended after them, so a positional reader of the prefix is unaffected.
const FIELD_ORDER = ['effective_cpu', 'cpu_source', 'effective_mem_mb', 'mem_source', 'nproc', 'cgroup_v2'];
const EXTRA_FIELDS = ['scope_mem_max_mb', 'scope_mem_source'];
const ALL_FIELDS = [...FIELD_ORDER, ...EXTRA_FIELDS];

test('report mode: frozen six fields first and in order, then the two additions, exit 0', () => {
  const { status, stdout } = run();
  assert.equal(status, 0);
  const lines = stdout.trim().split('\n');
  assert.equal(lines.length, 8, `expected exactly 8 lines, got: ${stdout}`);
  for (let i = 0; i < FIELD_ORDER.length; i++) {
    assert.ok(lines[i].startsWith(`${FIELD_ORDER[i]}=`), `line ${i} should start with "${FIELD_ORDER[i]}=", got: ${lines[i]}`);
  }
  for (let i = 0; i < EXTRA_FIELDS.length; i++) {
    assert.ok(lines[FIELD_ORDER.length + i].startsWith(`${EXTRA_FIELDS[i]}=`), `line ${FIELD_ORDER.length + i} should start with "${EXTRA_FIELDS[i]}=", got: ${lines[FIELD_ORDER.length + i]}`);
  }
});

test('--json mode: same eight keys, same values as report mode', () => {
  const report = parseReport(run().stdout);
  const { status, stdout } = run({}, ['--json']);
  assert.equal(status, 0);
  const json = JSON.parse(stdout);
  for (const key of ALL_FIELDS) {
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

// ── hierarchical readings: the caller's OWN cgroup is not the whole story (2026-10-14) ──────────────
// (gap-effective-capacity-scope-own-budget-and-actual-concurrency-display)
//
// Measured live 2026-10-14 on this host: a systemd --user scope whose slice carries CPUQuota=200% has
// NO `cpu.max` of its own — the controller lives on the slice ABOVE it — so an own-directory-only
// probe reported `cpu_source=nproc-fallback` with effective_cpu=128 while the true quota was 2 cores.
// The CPU readings are now the MINIMUM over the whole ancestor chain, so a quota that lives only
// above is found. `cpuset.cpus.effective` deliberately stays an OWN-cgroup reading: an unrelated
// ancestor merely mirrors the host CPU set (measured: `user.slice` reports 0-127 on a 128-core host),
// so walking it would report a "constraint" that constrains nothing.
//
// Memory gets a SECOND, SEPARATE number rather than a redefinition: `scope_mem_max_mb` = what THIS
// scope may use (own memory.max; nearest ancestor only when the own cgroup imposes none), while
// `effective_mem_mb` stays the chain minimum an outer cgroup actually enforces. Neither overwrites
// the other, and `scope_mem_source` names which level supplied the scope value.
//
// The ancestor levels are exercised through the two ancestor SEAMS rather than by creating real
// nested slices: a test that mutated the shared systemd user manager would leak a unit on any failure
// (and race a concurrent run). The seam overrides the ancestor-chain READING, which is the same input
// the real walk produces, so the composition logic below is the real code path.

const NO_QUOTA = {
  EFFECTIVE_CAPACITY_TEST_CPU_MAX: 'max',
  EFFECTIVE_CAPACITY_TEST_ANCESTOR_CPU_MAX: 'max',
  EFFECTIVE_CAPACITY_TEST_MEMORY_MAX: 'max',
  EFFECTIVE_CAPACITY_TEST_ANCESTOR_MEMORY_MAX: 'max',
  EFFECTIVE_CAPACITY_TEST_NPROC: '128',
};

// AC1 (with quota): a quota that lives only on an ANCESTOR is found and labels itself cgroup-cpu-max.
test('AC1 (with quota): an ancestor-only bandwidth quota is found, source=cgroup-cpu-max', () => {
  const out = parseReport(run({ ...NO_QUOTA, EFFECTIVE_CAPACITY_TEST_ANCESTOR_CPU_MAX: '200000 100000' }).stdout);
  assert.equal(out.effective_cpu, '2', 'an ancestor-only quota must not be missed (the live 2026-10-14 defect)');
  assert.equal(out.cpu_source, 'cgroup-cpu-max');
});

// cgroup v2 composes CPU bandwidth hierarchically, so the TIGHTER of own and ancestor wins in BOTH
// directions. A naive "own first, ancestor only when own is unset" implementation passes one of these
// two and fails the other — hence both arms rather than one.
test('AC1 (with quota): the tighter bandwidth wins — ancestor tighter than own', () => {
  const out = parseReport(run({ ...NO_QUOTA, EFFECTIVE_CAPACITY_TEST_CPU_MAX: '800000 100000', EFFECTIVE_CAPACITY_TEST_ANCESTOR_CPU_MAX: '200000 100000' }).stdout);
  assert.equal(out.effective_cpu, '2');
});

test('AC1 (with quota): the tighter bandwidth wins — own tighter than ancestor', () => {
  const out = parseReport(run({ ...NO_QUOTA, EFFECTIVE_CAPACITY_TEST_CPU_MAX: '200000 100000', EFFECTIVE_CAPACITY_TEST_ANCESTOR_CPU_MAX: '800000 100000' }).stdout);
  assert.equal(out.effective_cpu, '2');
});

test('AC1 (with quota): an ancestor quota equal to a cpuset candidate keeps the cgroup-cpu-max tie-break', () => {
  const out = parseReport(run({ ...NO_QUOTA, EFFECTIVE_CAPACITY_TEST_ANCESTOR_CPU_MAX: '300000 100000', EFFECTIVE_CAPACITY_TEST_CPUSET_COUNT: '3' }).stdout);
  assert.equal(out.effective_cpu, '3');
  assert.equal(out.cpu_source, 'cgroup-cpu-max');
});

// AC1 (no quota, fail-closed): when NEITHER the own cgroup NOR any ancestor imposes a quota, the
// source must READ `nproc-fallback` — the explicit "there is no quota here" semantic — rather than a
// silent fallback that looks like a measurement.
test('AC1 (no quota): no own and no ancestor quota reports nproc-fallback, not a silent measurement', () => {
  const out = parseReport(run({ ...NO_QUOTA }).stdout);
  assert.equal(out.effective_cpu, '128');
  assert.equal(out.cpu_source, 'nproc-fallback');
});

// A chain level whose cpu.max could not be read ("" here) contributes NO candidate — fail-open for
// that level, identical to the file being absent, not a crash and not a bogus zero-core reading.
test('AC1 (no quota): an unreadable ancestor cpu.max contributes no candidate (same as absent)', () => {
  const out = parseReport(run({ ...NO_QUOTA, EFFECTIVE_CAPACITY_TEST_ANCESTOR_CPU_MAX: '' }).stdout);
  assert.equal(out.cpu_source, 'nproc-fallback');
});

// AC2: own and ancestor-chain memory are two separate keys that are ALLOWED to differ.
test('AC2: own memory.max and the ancestor-chain minimum are reported as two separate keys', () => {
  const out = parseReport(run({ EFFECTIVE_CAPACITY_TEST_MEMORY_MAX: String(8 * 1024 * 1024 * 1024), EFFECTIVE_CAPACITY_TEST_ANCESTOR_MEMORY_MAX: String(2 * 1024 * 1024 * 1024) }).stdout);
  assert.equal(out.scope_mem_max_mb, '8192', 'scope_mem_max_mb is the OWN cgroup budget');
  assert.equal(out.effective_mem_mb, '2048', 'effective_mem_mb stays the chain minimum');
  assert.equal(out.scope_mem_source, 'cgroup-memory-max');
  assert.equal(out.mem_source, 'cgroup-memory-max');
});

// AC3 — the reason this task exists: a 16 GiB suite scope nested inside an 8 GiB session cap must read
// its OWN 16384, not the outer session's 8192, or the consumer starves the suite to a budget that is
// not its own.
test('AC3: a 16 GiB own scope nested in an 8 GiB ancestor reads scope_mem_max_mb=16384, NOT 8192', () => {
  const out = parseReport(run({ EFFECTIVE_CAPACITY_TEST_MEMORY_MAX: String(16 * 1024 * 1024 * 1024), EFFECTIVE_CAPACITY_TEST_ANCESTOR_MEMORY_MAX: String(8 * 1024 * 1024 * 1024) }).stdout);
  assert.equal(out.scope_mem_max_mb, '16384');
  assert.notEqual(out.scope_mem_max_mb, '8192');
  assert.equal(out.effective_mem_mb, '8192', 'the conservative chain minimum is still available for consumers that want it');
});

// AC2: when the OWN cgroup imposes no limit of its own, the NEAREST ancestor supplies the scope value
// and the source field says which level it was — the two readings can never be confused.
test('AC2: own memory.max=max -> nearest ancestor supplies scope_mem_max_mb, source names the ancestor', () => {
  const out = parseReport(run({ EFFECTIVE_CAPACITY_TEST_MEMORY_MAX: 'max', EFFECTIVE_CAPACITY_TEST_ANCESTOR_MEMORY_MAX: String(4 * 1024 * 1024 * 1024) }).stdout);
  assert.equal(out.scope_mem_max_mb, '4096');
  assert.equal(out.scope_mem_source, 'ancestor-cgroup-memory-max');
});

test('AC2: no limit anywhere -> BOTH memory keys fall back honestly, scope source names the fallback', () => {
  const out = parseReport(run({ EFFECTIVE_CAPACITY_TEST_MEMORY_MAX: 'max', EFFECTIVE_CAPACITY_TEST_ANCESTOR_MEMORY_MAX: 'max', EFFECTIVE_CAPACITY_TEST_MEM_AVAIL_MB: '4096' }).stdout);
  assert.equal(out.effective_mem_mb, '4096');
  assert.equal(out.mem_source, 'free-fallback');
  assert.equal(out.scope_mem_max_mb, '4096');
  assert.equal(out.scope_mem_source, 'free-fallback');
});

// An ancestor seam ALONE (no own-level seam for that controller) still participates, and the result is
// fully host-independent: the CPU/memory seam groups are hermetic, so naming only the ancestor level
// suppresses the real own-directory read too and the seamed ancestor is the sole candidate. This is the
// observable form of that rule — if a live real read leaked in, the value could only ever be SMALLER
// than the seam here (the seam is tighter than any real budget this host has), never larger.
test('AC1/AC3: an ancestor-only seam participates, and the real own level is suppressed (hermetic)', () => {
  const cpu = parseReport(run({ EFFECTIVE_CAPACITY_TEST_ANCESTOR_CPU_MAX: '200000 100000' }).stdout);
  assert.equal(cpu.effective_cpu, '2');
  assert.equal(cpu.cpu_source, 'cgroup-cpu-max');

  const mem = parseReport(run({ EFFECTIVE_CAPACITY_TEST_ANCESTOR_MEMORY_MAX: String(1024 * 1024 * 1024) }).stdout);
  assert.equal(mem.effective_mem_mb, '1024');
});

// ── a real MemoryMax-constrained scope (not a seam): the live AC2 reading ───────────────────────────
test('a real systemd-run --scope -p MemoryMax=16G reports scope_mem_max_mb=16384 from its OWN cgroup', (t) => {
  const probe = spawnSync('systemd-run', ['--user', '--scope', '--quiet', '-p', 'MemoryMax=16G', '--', 'bash', SCRIPT], {
    encoding: 'utf8',
  });
  if (probe.status !== 0 || probe.error) {
    t.skip('systemd-run --user --scope is not usable in this environment');
    return;
  }
  const out = parseReport(probe.stdout);
  assert.equal(out.scope_mem_max_mb, '16384', 'the scope must read its OWN budget, not the enclosing session cap');
  assert.equal(out.scope_mem_source, 'cgroup-memory-max');
});
