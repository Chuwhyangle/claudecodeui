#!/usr/bin/env node
// with-memory-cap-command-resolution.test.mjs — guards the repo-local command fallback added to
// scripts/with-memory-cap.sh (gap-with-memory-cap-resolve-repo-local-command).
//
// Why: the wrapper used to `exec "$@"` verbatim, so a bare `tsx`/`vitest` failed outright whenever
// the caller's PATH had no repo node_modules/.bin — exactly the acceptance environment's driver
// PATH. A real criterion (AC-400) was red for that reason while the module under test was fine.
// The wrapper now resolves a bare name against <repo>/node_modules/.bin ONLY when PATH cannot
// resolve it. These tests pin both halves: the fallback fires when needed, and PATH still wins when
// the name is present (an unconditional PATH prepend would silently shadow system tools).
//
// Every case runs with QUAY_MEMORY_MAX=off so the wrapper takes its direct-exec branch and no real
// cgroup scope is created; the resolution step runs before ALL exec paths, so this exercises the
// same code the capped path uses. One extra case leaves QUAY_MEMORY_MAX unset to prove the
// resolution is not accidentally tied to the bypass branch.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, 'with-memory-cap.sh');

// The driver-shaped PATH from AC-400: the node binary's own directory plus the system directories,
// deliberately WITHOUT the repo's node_modules/.bin.
const BARE_PATH = [
  path.dirname(process.execPath),
  '/usr/local/bin',
  '/usr/local/sbin',
  '/usr/bin',
  '/usr/sbin',
  '/bin',
  '/sbin',
].join(':');

/** @param {string[]} args @param {{path?: string, env?: Record<string,string>}} [opts] */
function run(args, opts = {}) {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, QUAY_MEMORY_MAX: 'off', PATH: opts.path ?? BARE_PATH, ...opts.env },
  });
}

// A vacuous pass is the failure mode this guard must not have: if the host happened to ship a
// system `tsx`, the fallback cases below would pass without ever reaching the fallback. Fail loudly
// on that premise instead of silently testing nothing.
test('premise: the bare PATH has no tsx (otherwise the fallback cases are vacuous)', () => {
  const r = spawnSync('sh', ['-c', 'command -v tsx'], { encoding: 'utf8', env: { ...process.env, PATH: BARE_PATH } });
  assert.notEqual(r.status, 0, `a system tsx exists on the bare PATH (${r.stdout.trim()}) — the fallback test premise is broken`);
});

test('bare PATH: resolves the repo-local tsx through the node_modules/.bin fallback', () => {
  const r = run(['tsx', '--version']);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);
  assert.match(r.stdout.split('\n')[0], /^tsx v/, `expected a tsx version line, got: ${JSON.stringify(r.stdout)}`);
});

test('PATH wins: a same-named command earlier on PATH is used instead of the repo-local fallback', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memcap-path-wins-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const fake = path.join(tmp, 'tsx');
  fs.writeFileSync(fake, '#!/bin/sh\necho PATH-WINS\n', { mode: 0o755 });

  const r = run(['tsx', '--version'], { path: `${tmp}:${BARE_PATH}` });
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);
  assert.equal(r.stdout.trim(), 'PATH-WINS', 'the repo-local tsx must NOT shadow a command already on PATH');
});

test('negative control: a command absent from both PATH and node_modules/.bin still fails, un-masked', () => {
  const r = run(['definitely-not-a-command-xyz']);
  assert.notEqual(r.status, 0, 'a missing command must not be turned into a success by the fallback');
});

test('arguments, stdout/stderr and the exit code are forwarded unchanged', () => {
  const r = run(['bash', '-c', 'printf OUT; printf ERR >&2; exit 7']);
  assert.equal(r.status, 7, `expected the child's exit code 7, got ${r.status}`);
  assert.equal(r.stdout, 'OUT');
  assert.equal(r.stderr, 'ERR');
});

test('the fallback also applies when the cap is in effect (QUAY_MEMORY_MAX unset)', () => {
  // The key must be ABSENT (not empty) so the wrapper derives its own cap. An object spread drops
  // ProcessEnv's string index signature, so type the copy explicitly before deleting the key.
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env, PATH: BARE_PATH };
  delete env.QUAY_MEMORY_MAX;
  const r = spawnSync('bash', [SCRIPT, 'tsx', '--version'], { encoding: 'utf8', env });
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);
  assert.match(r.stdout.split('\n')[0], /^tsx v/, `expected a tsx version line, got: ${JSON.stringify(r.stdout)}`);
});
