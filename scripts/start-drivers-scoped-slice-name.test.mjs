// node --test — the slice-name resolution, the slice-creation path, the fail-closed check, and the
// systemd-run wiring shim of scripts/start-drivers-scoped.sh.
//
// Falsifiable properties, all reachable without a real driver start:
//
//   * the default slice name is DERIVED from the project root directory, not a shared literal.
//     Mutation that must red: put the previous shared literal back as the default — the name
//     cases then read that literal for every root and fail.
//   * a missing slice is CREATED by the script itself, from a template it carries. Mutation that
//     must red: delete the `[ ! -e "$SLICE_UNIT_FILE" ]` block — the dry run stops reporting
//     `action=would-create` and the ensure-only run writes no file.
//   * a slice with no MemoryMax is REFUSED rather than started uncapped. Mutation that must red:
//     drop the `case "$max" in ''|infinity)` arm — the no-MemoryMax case then exits 0.
//   * a slice name containing a dash is REFUSED rather than silently nested. Mutation that must
//     red: drop the dash guard — `a-b.slice` is then accepted and runs under `a.slice`, whose
//     ceiling is `infinity`.
//   * the wiring shim adds `--slice=<slice>` to a slice-less `systemd-run --user` call (the calls
//     the quay runtime actually makes) and leaves an explicit choice alone. Mutation that must red:
//     make the shim always inject — the "already names a slice" case then reads two slices.
//
// The root directory name is what decides the default, so each case runs a COPY of the script
// under `<tmp>/<name>/scripts/`: ROOT_DIR is `dirname($0)/..`, so a directory named `cantus` is
// exactly a checkout whose root is named `cantus`. Nothing is written to the real
// `~/.config/systemd/user` — the creation cases point `QUAY_SLICE_UNIT_DIR` at a temp dir, and the
// systemd-reading cases point `QUAY_SLICE_SYSTEMCTL` at a stub so no real systemd is consulted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'start-drivers-scoped.sh');

// Every knob the script reads is stripped before the per-case env is applied, so an ambient
// QUAY_MEMORY_SLICE (the driver exports one) cannot decide the answer these cases assert.
const CONTROLLED = [
  'QUAY_MEMORY_SLICE',
  'QUAY_SLICE_MEMORY_HIGH',
  'QUAY_SLICE_MEMORY_MAX',
  'QUAY_SLICE_UNIT_DIR',
  'QUAY_SLICE_SHIM_DIR',
  'QUAY_SLICE_SHIM_ONLY',
  'QUAY_SLICE_VALIDATE_ONLY',
  'QUAY_SLICE_SYSTEMCTL',
  'QUAY_ENSURE_SLICE_ONLY',
  'START_DRIVERS_SCOPED_DRY_RUN',
  'QUAY_TEST_SYSTEMD_RUN_LIMITS',
  'QUAY_PLUGIN_DIR',
];

function baseEnv() {
  const env = { ...process.env };
  for (const key of CONTROLLED) delete env[key];
  return env;
}

/**
 * @param {string} scriptPath
 * @param {Record<string, string>} [extraEnv]
 */
function runScript(scriptPath, extraEnv = {}) {
  const res = spawnSync('bash', [scriptPath], {
    env: { ...baseEnv(), ...extraEnv },
    encoding: 'utf8',
  });
  assert.equal(res.error, undefined, String(res.error));
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

// A checkout whose root directory is named `rootName`; only the script is copied in, because the
// dry-run and ensure-only seams return before anything else is read.
/**
 * @param {string} rootName
 */
function fixture(rootName) {
  const base = mkdtempSync(join(tmpdir(), 'sdsc-'));
  const scriptDir = join(base, rootName, 'scripts');
  mkdirSync(scriptDir, { recursive: true });
  const scriptPath = join(scriptDir, 'start-drivers-scoped.sh');
  copyFileSync(SCRIPT, scriptPath);
  return { base, scriptPath, unitDir: join(base, 'units') };
}

test('dry run derives the slice name from the project directory name', () => {
  for (const name of ['claudecodeui', 'cantus']) {
    const fx = fixture(name);
    try {
      const r = runScript(fx.scriptPath, { START_DRIVERS_SCOPED_DRY_RUN: '1' });
      assert.equal(r.status, 0, r.stderr);
      // The exact-match below is what proves the name is the project-derived one: for each root the
      // resolved slice must be `<root>.slice` byte for byte, so it can never be a foreign shared
      // literal — a separate negative assertion would only restate that, and would have to spell
      // the retired literal in this file.
      assert.match(r.stdout, new RegExp(`^dry-run: slice=${name}\\.slice$`, 'm'), r.stdout);
    } finally {
      rmSync(fx.base, { recursive: true, force: true });
    }
  }
});

test('an explicit QUAY_MEMORY_SLICE overrides the derived name verbatim', () => {
  const fx = fixture('claudecodeui');
  try {
    const r = runScript(fx.scriptPath, {
      START_DRIVERS_SCOPED_DRY_RUN: '1',
      QUAY_MEMORY_SLICE: 'custom.slice',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^dry-run: slice=custom\.slice$/m, r.stdout);
    assert.match(r.stdout, /^dry-run: unit-file=.*\/custom\.slice$/m, r.stdout);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test('dry run reports the unit it would write when the slice file is missing, and writes nothing', () => {
  const fx = fixture('claudecodeui');
  try {
    const r = runScript(fx.scriptPath, {
      START_DRIVERS_SCOPED_DRY_RUN: '1',
      QUAY_SLICE_UNIT_DIR: fx.unitDir,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^dry-run: action=would-create$/m, r.stdout);
    assert.match(r.stdout, /^MemoryHigh=48G$/m, r.stdout);
    assert.match(r.stdout, /^MemoryMax=64G$/m, r.stdout);
    assert.match(r.stdout, /^MemorySwapMax=0$/m, r.stdout);
    assert.ok(!existsSync(join(fx.unitDir, 'claudecodeui.slice')), 'a dry run must not write the unit file');
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test('the script creates the slice unit itself when it is missing', () => {
  const fx = fixture('claudecodeui');
  try {
    const r = runScript(fx.scriptPath, {
      QUAY_ENSURE_SLICE_ONLY: '1',
      QUAY_SLICE_UNIT_DIR: fx.unitDir,
    });
    assert.equal(r.status, 0, r.stderr);
    const file = join(fx.unitDir, 'claudecodeui.slice');
    assert.ok(existsSync(file), `expected ${file} to be created`);
    const text = readFileSync(file, 'utf8');
    assert.match(text, /^MemoryHigh=48G$/m, text);
    assert.match(text, /^MemoryMax=64G$/m, text);
    assert.match(text, /^MemorySwapMax=0$/m, text);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test('the template values are overridable per run', () => {
  const fx = fixture('claudecodeui');
  try {
    const r = runScript(fx.scriptPath, {
      QUAY_ENSURE_SLICE_ONLY: '1',
      QUAY_SLICE_UNIT_DIR: fx.unitDir,
      QUAY_SLICE_MEMORY_HIGH: '3G',
      QUAY_SLICE_MEMORY_MAX: '5G',
    });
    assert.equal(r.status, 0, r.stderr);
    const text = readFileSync(join(fx.unitDir, 'claudecodeui.slice'), 'utf8');
    assert.match(text, /^MemoryHigh=3G$/m, text);
    assert.match(text, /^MemoryMax=5G$/m, text);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test('an existing slice unit file is left untouched', () => {
  const fx = fixture('claudecodeui');
  try {
    mkdirSync(fx.unitDir, { recursive: true });
    const file = join(fx.unitDir, 'claudecodeui.slice');
    writeFileSync(file, '[Unit]\nDescription=hand-tuned\n\n[Slice]\nMemoryMax=7G\n');
    const r = runScript(fx.scriptPath, {
      QUAY_ENSURE_SLICE_ONLY: '1',
      QUAY_SLICE_UNIT_DIR: fx.unitDir,
      QUAY_SLICE_MEMORY_MAX: '5G',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(file, 'utf8'), /^MemoryMax=7G$/m, 'an existing unit must not be overwritten');
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

/** @param {string} path @param {string} text */
function writeExec(path, text) {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

// Stands in for `systemctl --user show … -p MemoryMax --value`: it ignores its arguments and echoes
// `QUAY_SLICE_STUB_MAX`, so the fail-closed arm (and the pass arm) can be driven with no systemd.
const STUB_SYSTEMCTL = `#!/usr/bin/env bash
printf '%s\\n' "\${QUAY_SLICE_STUB_MAX-infinity}"
`;

// Stands in for the real systemd-run behind the shim: it prints its argv, one argument per line, so
// the test can read exactly what the shim forwarded.
const STUB_REAL_SYSTEMD_RUN = `#!/usr/bin/env bash
printf '%s\\n' "$@"
`;

// A systemd-run that exists only so the shim-install path finds a real binary on PATH.
const STUB_SYSTEMD_RUN_ON_PATH = `#!/usr/bin/env bash
exit 0
`;

/**
 * Run the installed shim itself against a stub real systemd-run and return the argv it forwarded.
 * @param {string} shimPath
 * @param {string[]} argv
 * @param {Record<string, string>} extraEnv
 */
function runShim(shimPath, argv, extraEnv) {
  const res = spawnSync('bash', [shimPath, ...argv], {
    env: { ...baseEnv(), ...extraEnv },
    encoding: 'utf8',
  });
  assert.equal(res.error, undefined, String(res.error));
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.split('\n').filter(Boolean);
}

test('dry run reports the wiring shim it would install, and writes nothing', () => {
  const fx = fixture('claudecodeui');
  try {
    const shimDir = join(fx.base, 'shim');
    const r = runScript(fx.scriptPath, {
      START_DRIVERS_SCOPED_DRY_RUN: '1',
      QUAY_SLICE_UNIT_DIR: fx.unitDir,
      QUAY_SLICE_SHIM_DIR: shimDir,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^dry-run: shim-dir=${shimDir}$`, 'm'), r.stdout);
    assert.match(r.stdout, /^dry-run: real-systemd-run=/m, r.stdout);
    // The shim it will install is the thing that names the slice, so the dry run has to show it.
    assert.match(r.stdout, /--slice="\$slice"/, r.stdout);
    assert.ok(!existsSync(shimDir), 'a dry run must not install the shim');
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test('a slice name containing a dash is refused, not silently nested', () => {
  // (a) an explicit dashed name — systemd would read `my-proj.slice` as a child of `my.slice`.
  const explicit = fixture('claudecodeui');
  try {
    const r = runScript(explicit.scriptPath, {
      START_DRIVERS_SCOPED_DRY_RUN: '1',
      QUAY_MEMORY_SLICE: 'my-proj.slice',
    });
    assert.notEqual(r.status, 0, `a dashed slice name must be refused, got: ${r.stdout}`);
    assert.match(r.stderr, /contains '-'/);
    assert.ok(!existsSync(join(explicit.unitDir, 'my-proj.slice')), 'a refused name must not write a unit');
  } finally {
    rmSync(explicit.base, { recursive: true, force: true });
  }

  // (b) the same trap via the DERIVED default: a checkout whose root directory itself has a dash.
  const derived = fixture('cantus-two');
  try {
    const r = runScript(derived.scriptPath, { START_DRIVERS_SCOPED_DRY_RUN: '1' });
    assert.notEqual(r.status, 0, `derived dashed slice must be refused, got: ${r.stdout}`);
    assert.match(r.stderr, /cantus-two\.slice/);
  } finally {
    rmSync(derived.base, { recursive: true, force: true });
  }
});

test('a slice with no MemoryMax is refused instead of started uncapped', () => {
  for (const value of ['infinity', '']) {
    const fx = fixture('claudecodeui');
    try {
      const stub = join(fx.base, 'systemctl-stub');
      writeExec(stub, STUB_SYSTEMCTL);
      const r = runScript(fx.scriptPath, {
        QUAY_SLICE_VALIDATE_ONLY: '1',
        QUAY_SLICE_UNIT_DIR: fx.unitDir,
        QUAY_SLICE_SYSTEMCTL: stub,
        QUAY_SLICE_STUB_MAX: value,
      });
      assert.notEqual(r.status, 0, `MemoryMax='${value}' must be refused, got: ${r.stdout}`);
      assert.match(r.stderr, /no MemoryMax/);
    } finally {
      rmSync(fx.base, { recursive: true, force: true });
    }
  }
});

test('the validate-only seam reports a usable slice when MemoryMax is set', () => {
  const fx = fixture('claudecodeui');
  try {
    const stub = join(fx.base, 'systemctl-stub');
    writeExec(stub, STUB_SYSTEMCTL);
    const r = runScript(fx.scriptPath, {
      QUAY_SLICE_VALIDATE_ONLY: '1',
      QUAY_SLICE_UNIT_DIR: fx.unitDir,
      QUAY_SLICE_SYSTEMCTL: stub,
      QUAY_SLICE_STUB_MAX: '68719476736',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /claudecodeui\.slice usable \(MemoryMax=68719476736/, r.stdout);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test('the shim-only seam installs a systemd-run shim that names the slice', () => {
  const fx = fixture('claudecodeui');
  try {
    const bin = join(fx.base, 'fakebin');
    mkdirSync(bin, { recursive: true });
    writeExec(join(bin, 'systemd-run'), STUB_SYSTEMD_RUN_ON_PATH);
    const shimDir = join(fx.base, 'shim');

    const r = runScript(fx.scriptPath, {
      QUAY_SLICE_SHIM_ONLY: '1',
      QUAY_SLICE_SHIM_DIR: shimDir,
      PATH: `${bin}:${process.env.PATH}`,
    });
    assert.equal(r.status, 0, r.stderr);
    const shim = join(shimDir, 'systemd-run');
    assert.ok(existsSync(shim), `expected ${shim} to be created`);
    assert.ok(r.stdout.includes(`installed systemd-run shim at ${shim} `), r.stdout);

    // The shim exists; now prove what it does. `argv` mirrors the exact call the quay runtime makes
    // to create the driver anchor: `systemd-run --user --scope --collect --unit=… -p …`, no slice.
    const real = join(fx.base, 'real-systemd-run');
    writeExec(real, STUB_REAL_SYSTEMD_RUN);
    const argv = ['--user', '--scope', '--collect', '--unit=quay-anchor-x.scope', '-p', 'OOMPolicy=continue', 'node', 'driver-anchor.js'];
    const forwarded = runShim(shim, argv, {
      QUAY_REAL_SYSTEMD_RUN: real,
      QUAY_MEMORY_SLICE: 'claudecodeui.slice',
    });
    // Exactly one argument added, at the front; the caller's argv is untouched after it.
    assert.equal(forwarded[0], '--slice=claudecodeui.slice', forwarded.join(' '));
    assert.deepEqual(forwarded.slice(1), argv);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test('the shim leaves an explicit slice choice, and a non-user call, alone', () => {
  const fx = fixture('claudecodeui');
  try {
    const shimDir = join(fx.base, 'shim');
    const bin = join(fx.base, 'fakebin');
    mkdirSync(bin, { recursive: true });
    writeExec(join(bin, 'systemd-run'), STUB_SYSTEMD_RUN_ON_PATH);
    const installed = runScript(fx.scriptPath, {
      QUAY_SLICE_SHIM_ONLY: '1',
      QUAY_SLICE_SHIM_DIR: shimDir,
      PATH: `${bin}:${process.env.PATH}`,
    });
    assert.equal(installed.status, 0, installed.stderr);
    const shim = join(shimDir, 'systemd-run');

    const real = join(fx.base, 'real-systemd-run');
    writeExec(real, STUB_REAL_SYSTEMD_RUN);
    const env = { QUAY_REAL_SYSTEMD_RUN: real, QUAY_MEMORY_SLICE: 'claudecodeui.slice' };

    // Already names a slice (this is scripts/with-memory-cap.sh's call shape): untouched.
    const sliced = ['--user', '--scope', '--slice=other.slice', '--unit=t', 'node', 'x.js'];
    assert.deepEqual(runShim(shim, sliced, env), sliced);

    // --slice-inherit is also an explicit choice: untouched.
    const inherited = ['--user', '--scope', '--slice-inherit', 'node', 'x.js'];
    assert.deepEqual(runShim(shim, inherited, env), inherited);

    // Not a user-manager call: untouched (a system-manager systemd-run must not be rewritten).
    const system = ['--scope', '--unit=sys', 'node', 'x.js'];
    assert.deepEqual(runShim(shim, system, env), system);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});
