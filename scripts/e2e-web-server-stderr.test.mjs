#!/usr/bin/env node
/**
 * The controls for `scripts/e2e-web-server-stderr.mjs` — the redirect that keeps a gate red
 * attributable.
 *
 * WHY THESE CASES EXIST. The criterion this module serves is "a failed e2e run's gate reason names
 * the failing case". The gate reads the run's stderr, and Playwright forwards every webServer's
 * stderr into it; the fix is only real if the redirect actually moves those bytes out of the
 * runner's stderr and into the run's data directory. A case that only compared the constructed
 * string would pass for a redirect that never runs (e.g. if Playwright stopped shell-running the
 * command), so the central case here starts a REAL child through a real shell and reads both streams
 * back.
 *
 * The string cases are not redundant with it: they pin the two properties the config depends on —
 * the command survives verbatim (the redirect must not reorder or re-quote a command that carries
 * its own pipes) and a path with spaces arrives as one shell word.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  SERVER_STDERR_LOG_NAME,
  VITE_STDERR_LOG_NAME,
  webServerStderrLogs,
  withStderrLog,
} from './e2e-web-server-stderr.mjs';

test('the redirect is appended after the command, which is kept verbatim', () => {
  const log = '/data/run/server.stderr.log';
  assert.equal(withStderrLog('node bundle.js', log), 'node bundle.js 2> "/data/run/server.stderr.log"');

  // A command that already carries its own shell syntax: nothing is parsed or reordered, and the
  // redirect is the LAST word — so it applies to the whole pipeline, exactly the scope the runner's
  // stderr had before.
  const piped = 'node x.js 2>&1 | tee "/data/run/raw.log"';
  assert.equal(withStderrLog(piped, log), `${piped} 2> "/data/run/server.stderr.log"`);
});

test('a log path containing spaces is quoted as one shell word', () => {
  const log = '/data/quay e2e/run 1/server.stderr.log';
  const command = withStderrLog('node bundle.js', log);
  assert.equal(command, 'node bundle.js 2> "/data/quay e2e/run 1/server.stderr.log"');
  // The reading the quoting exists for: the shell still sees ONE redirect target.
  const result = spawnSync('sh', ['-c', `${command}; echo "target=$?"`], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  // `sh` reports the redirect failure on its own stderr and exits non-zero for that command; the
  // path does not exist here, so the assertion is that the whole spaced path was treated as one
  // filename (no "No such file" split into extra words).
  assert.match(result.stderr, /quay e2e\/run 1\/server\.stderr\.log/);
});

test('the two logs sit inside the run data directory, named apart', () => {
  const dataDir = '/data/quay-e2e-Rxhh8s';
  const logs = webServerStderrLogs(dataDir);
  assert.equal(logs.server, path.join(dataDir, SERVER_STDERR_LOG_NAME));
  assert.equal(logs.vite, path.join(dataDir, VITE_STDERR_LOG_NAME));
  assert.equal(logs.server, '/data/quay-e2e-Rxhh8s/server.stderr.log');
  assert.equal(logs.vite, '/data/quay-e2e-Rxhh8s/vite.stderr.log');
  assert.notEqual(logs.server, logs.vite);
  // Absolute, because the webServer's `cwd` is not the checkout root.
  assert.equal(path.isAbsolute(logs.server), true);
  assert.equal(path.isAbsolute(logs.vite), true);
});

test('a real shell child has its stderr in the log and none of it on the runner', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac323-web-server-stderr-'));
  try {
    const log = path.join(dir, SERVER_STDERR_LOG_NAME);
    // No escapes: `2` on stdout and `4` on stderr are readable back byte-for-byte.
    const script = 'process.stdout.write(String(1 + 1)); process.stderr.write(String(2 + 2));';
    const command = withStderrLog(`${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`, log);
    const result = spawnSync('sh', ['-c', command], { encoding: 'utf8' });

    assert.equal(result.status, 0, `child exited ${result.status}: ${result.stderr}`);
    assert.equal(result.stdout, '2', 'the child stdout must still reach the runner');
    assert.equal(result.stderr, '', 'the child stderr leaked into the runner — this is the defect');
    assert.equal(fs.readFileSync(log, 'utf8'), '4', 'the child stderr did not reach its log');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the log exists even when the child writes nothing to stderr', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac323-web-server-stderr-'));
  try {
    const log = path.join(dir, VITE_STDERR_LOG_NAME);
    const result = spawnSync('sh', ['-c', withStderrLog(`${JSON.stringify(process.execPath)} -e 0`, log)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `child exited ${result.status}: ${result.stderr}`);
    // The shell creates (and truncates) the target before exec, so a quiet server still leaves the
    // artifact a reader looks for; "file absent" must mean "no run wrote here", not "nothing to say".
    assert.equal(fs.existsSync(log), true, 'the redirect target was not created');
    assert.equal(fs.statSync(log).size, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
