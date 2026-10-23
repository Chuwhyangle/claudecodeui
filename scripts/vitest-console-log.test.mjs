#!/usr/bin/env node
/**
 * The controls for `scripts/vitest-console-log.mjs` — the sink that keeps a vitest gate red
 * attributable.
 *
 * WHY THESE CASES EXIST. The criterion this module serves is "a failed vitest run's gate reason
 * names the failing case". The gate reads the run's stderr; the fix is only real if the test
 * console's bytes actually leave the runner's stderr and land in the run's log. A case that only
 * compared a constructed string would pass for a sink that never runs, so the central case here
 * writes through a REAL sink and reads the file back, including the `false` return that is the
 * suppression contract.
 *
 * The path cases pin the two properties the config depends on: concurrent runs must not share a
 * log (pid in the default name), and a worker forked from the owning process must be handed the
 * owner's path through the environment rather than deriving its own.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CONSOLE_LOG_ENV,
  CONSOLE_LOG_PREFIX,
  consoleLogAnnouncement,
  createConsoleLogSink,
  createFailureVerdictReporter,
  resetConsoleLog,
  resolveConsoleLogPath,
} from './vitest-console-log.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vitest-console-log-test-'));
}

test('the declared path wins, so forked workers append to the owner\'s file', () => {
  const declared = '/data/run/quay-vitest-console-1.log';
  assert.equal(resolveConsoleLogPath({ env: { [CONSOLE_LOG_ENV]: declared }, pid: 999 }), declared);
});

test('without a declaration the path is per-process, inside tmpdir', () => {
  const a = resolveConsoleLogPath({ env: {}, tmpdir: '/data/tmp', pid: 111 });
  const b = resolveConsoleLogPath({ env: {}, tmpdir: '/data/tmp', pid: 222 });
  assert.equal(a, path.join('/data/tmp', `${CONSOLE_LOG_PREFIX}111.log`));
  assert.equal(b, path.join('/data/tmp', `${CONSOLE_LOG_PREFIX}222.log`));
  // The two runs are separate files: one run's bytes can never become another's attribution.
  assert.notEqual(a, b);
});

test('the sink appends test-console lines to the file and suppresses forwarding', () => {
  const dir = tempDir();
  const logPath = path.join(dir, 'console.log');
  resetConsoleLog(logPath);

  const sink = createConsoleLogSink(logPath);
  // `false` is the contract vitest reads to skip its own write to the runner's stderr/stdout.
  assert.equal(sink('session lapse recorded', 'stderr'), false);
  assert.equal(sink('[Auth] session lapse recorded', 'stderr'), false);
  assert.equal(sink('UPSTREAM_ERROR and MODEL_TEXT_REPLY', 'stderr'), false);
  assert.equal(sink('a plain stdout line', 'stdout'), false);

  const written = fs.readFileSync(logPath, 'utf8');
  assert.match(written, /^\[stderr\] session lapse recorded$/m);
  assert.match(written, /^\[stderr\] \[Auth\] session lapse recorded$/m);
  assert.match(written, /^\[stderr\] UPSTREAM_ERROR and MODEL_TEXT_REPLY$/m);
  assert.match(written, /^\[stdout\] a plain stdout line$/m);
});

test('reset truncates between runs instead of appending one run into another', () => {
  const dir = tempDir();
  const logPath = path.join(dir, 'console.log');
  resetConsoleLog(logPath);
  createConsoleLogSink(logPath)('first run', 'stderr');
  resetConsoleLog(logPath);
  createConsoleLogSink(logPath)('second run', 'stderr');

  assert.equal(fs.readFileSync(logPath, 'utf8'), '[stderr] second run\n');
});

test('an unwritable log never turns into a failing test run', () => {
  const dir = tempDir();
  // A directory where a file is expected: appendFileSync fails, and the sink still returns false.
  const logPath = path.join(dir, 'a-directory');
  fs.mkdirSync(logPath);
  assert.equal(createConsoleLogSink(logPath)('lost but harmless', 'stderr'), false);
});

test('the announcement names the path a reader can open', () => {
  assert.equal(
    consoleLogAnnouncement('/data/tmp/quay-vitest-console-7.log'),
    '[vitest] console-log=/data/tmp/quay-vitest-console-7.log',
  );
});

test('the verdict reporter writes `N failed` to stderr when a module fails', () => {
  /** @type {string[]} */
  const chunks = [];
  const reporter = createFailureVerdictReporter({ write: (text) => chunks.push(text) });
  reporter.onTestRunEnd(
    [{ state: () => 'passed' }, { state: () => 'failed' }, { state: () => 'passed' }],
    [],
  );
  assert.deepEqual(chunks, ['[vitest] 1 failed | 2 passed (3 files)\n']);
});

test('the verdict reporter stays silent on a green run', () => {
  /** @type {string[]} */
  const chunks = [];
  const reporter = createFailureVerdictReporter({ write: (text) => chunks.push(text) });
  reporter.onTestRunEnd([{ state: () => 'passed' }, { state: () => 'passed' }], []);
  // A green run's stderr must stay empty, so vitest's own failures are the first bytes of a red.
  assert.deepEqual(chunks, []);
});

test('the verdict reporter names a crash that failed no module', () => {
  /** @type {string[]} */
  const chunks = [];
  const reporter = createFailureVerdictReporter({ write: (text) => chunks.push(text) });
  reporter.onTestRunEnd([{ state: () => 'queued' }], [{ message: 'worker died' }]);
  assert.deepEqual(chunks, ['[vitest] 0 failed | 0 passed (1 files) | 1 unhandled error(s)\n']);
});
