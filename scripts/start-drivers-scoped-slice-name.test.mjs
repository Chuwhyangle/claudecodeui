// node --test — the slice-name resolution and the slice-creation path of
// scripts/start-drivers-scoped.sh.
//
// Two falsifiable properties, both reachable without a real driver start:
//
//   * the default slice name is DERIVED from the project root directory, not a shared literal.
//     Mutation that must red: put the literal `quay-fleet.slice` back as the default — the name
//     cases then read the literal for every root and fail.
//   * a missing slice is CREATED by the script itself, from a template it carries. Mutation that
//     must red: delete the `[ ! -e "$SLICE_UNIT_FILE" ]` block — the dry run stops reporting
//     `action=would-create` and the ensure-only run writes no file.
//
// The root directory name is what decides the default, so each case runs a COPY of the script
// under `<tmp>/<name>/scripts/`: ROOT_DIR is `dirname($0)/..`, so a directory named `cantus` is
// exactly a checkout whose root is named `cantus`. Nothing is written to the real
// `~/.config/systemd/user` — the creation cases point `QUAY_SLICE_UNIT_DIR` at a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
      assert.match(r.stdout, new RegExp(`^dry-run: slice=${name}\\.slice$`, 'm'), r.stdout);
      assert.ok(!r.stdout.includes('quay-fleet'), `resolved slice must not be the old shared literal:\n${r.stdout}`);
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
