/**
 * Where a vitest run's test-console output goes, so a gate red stays attributable.
 *
 * WHY THIS MODULE EXISTS. The goal gate records a failed criterion's reason from the run's
 * STDERR (plugin `goal-driver`'s `withFailureOutput`: `errText ? boundedExcerpt(errText,
 * 'stderr', budget, true) : outText ? …`, head of stderr, budget ~500 chars). Vitest writes the
 * test bodies' `console.error` calls to the RUNNER's stderr — jsdom's virtual console
 * (`Not implemented`), `[Auth] session lapse recorded`, `UPSTREAM_ERROR` — on EVERY run, green or
 * red. AC-323's second command is `npx vitest run …`, and a green run of it measured thousands of
 * such bytes (2026-10-23: the 20:24 gate red's visible reason was two ordinary console lines and
 * `[truncated, 10911 chars of stderr omitted]`). The failing case's name is written to STDOUT by
 * the reporter, so a red could not be attributed: eight "fixes" along AC-323 were each a guess.
 *
 * WHAT THIS DOES. `test.onConsoleLog` in `vitest.config.ts` hands every test-console line here.
 * The line is APPENDED to a log file and `false` is returned, which suppresses vitest's own
 * forwarding to stdout/stderr. Nothing is discarded: the file is named on stdout at run start
 * (`[vitest] console-log=<path>`), next to the run's other artifacts. With the test console
 * silent, a red run's stderr carries only vitest's OWN failures (a dead worker, `Timeout calling
 * "fetch"`), so the gate's stderr head is informative again; when stderr is empty the gate falls
 * back to the stdout TAIL, where the reporter writes the failing file/test name and `1 failed`.
 *
 * The path is per-run, not a fixed name: a concurrent vitest run must not interleave its lines
 * into this run's attribution. The owning process picks `quay-vitest-console-<pid>.log` and
 * exports it through `QUAY_VITEST_CONSOLE_LOG`, so workers forked from that process write to the
 * SAME file; the owner truncates it once, before any worker can append.
 *
 * @module scripts/vitest-console-log
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Environment variable that carries the run's console-log path to forked workers. */
export const CONSOLE_LOG_ENV = 'QUAY_VITEST_CONSOLE_LOG';

/** Basename prefix of a run's console log. */
export const CONSOLE_LOG_PREFIX = 'quay-vitest-console-';

/**
 * The console-log path for this run.
 *
 * An explicit `QUAY_VITEST_CONSOLE_LOG` wins: it is what the owning process exports so every
 * forked worker appends to the same file. Otherwise the path is derived from `pid` — the owning
 * process is the one that evaluates the config first, and its pid separates concurrent runs.
 *
 * @param {{ env?: NodeJS.ProcessEnv, tmpdir?: string, pid?: number }} [options]
 * @returns {string} absolute log path
 */
export function resolveConsoleLogPath({ env = process.env, tmpdir = os.tmpdir(), pid = process.pid } = {}) {
  const declared = env[CONSOLE_LOG_ENV];
  if (declared) return declared;
  return path.join(tmpdir, `${CONSOLE_LOG_PREFIX}${pid}.log`);
}

/**
 * Create/truncate the run's log so one run's bytes never append to another's.
 *
 * Only the OWNING process calls this (see `vitest.config.ts`): a worker that truncated on config
 * evaluation would wipe every line an earlier worker had already written.
 * @param {string} logPath absolute path
 * @returns {void}
 */
export function resetConsoleLog(logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, '');
}

/**
 * A `test.onConsoleLog` handler that appends to `logPath` and suppresses the default forwarding.
 *
 * Returning `false` is the contract vitest reads to skip its own write to the runner's streams.
 * A logging failure must never fail a test run — the mechanism exists to make failures
 * readable, so it degrades to "test output is lost" rather than to "the suite is red".
 * @param {string} logPath absolute path
 * @returns {(log: string, type: 'stdout' | 'stderr') => false}
 */
export function createConsoleLogSink(logPath) {
  return (log, type) => {
    try {
      fs.appendFileSync(logPath, `[${type}] ${log}\n`);
    } catch {
      // Deliberately swallowed; see the doc comment above.
    }
    return false;
  };
}

/**
 * The one stdout line that names the log, so a reader (human or gate) can find the moved bytes.
 * @param {string} logPath absolute path
 * @returns {string}
 */
export function consoleLogAnnouncement(logPath) {
  return `[vitest] console-log=${logPath}`;
}

/**
 * A reporter that writes the run VERDICT to stderr when the run reds, and stays silent on green.
 *
 * WHY IT EXISTS. The gate's excerpt is either the STDERR HEAD or, when stderr is empty, the
 * STDOUT TAIL (see `boundedExcerpt`/`withFailureOutput` in the plugin's `driver-runtime`). Vitest
 * writes the failing module/test names — the part that makes a red nameable — to stderr, but the
 * run verdict (`1 failed`) only to stdout's summary. With the stderr head holding the failure
 * block, the excerpt names the red but not its verdict; a reader cannot tell "one case failed"
 * from "the whole file failed to collect" without it. This one line is written FIRST (the
 * reporter is listed before `default`, and `report()` calls reporters in array order), so the
 * verdict sits at the top of the stderr head, ahead of the failure block.
 *
 * Green runs write nothing: AC1's requirement that a green CMD2 leaves stderr empty is what lets
 * vitest's own failures be the first thing a red excerpt shows.
 * @param {{ write?: (text: string) => void }} [options]
 * @returns {{ onTestRunEnd: (testModules: ReadonlyArray<{ state(): string }>, unhandledErrors: ReadonlyArray<unknown>) => void }}
 */
export function createFailureVerdictReporter({ write = (text) => process.stderr.write(text) } = {}) {
  return {
    onTestRunEnd(testModules, unhandledErrors) {
      const failed = testModules.filter((module) => module.state() === 'failed').length;
      if (failed === 0 && unhandledErrors.length === 0) return;
      const passed = testModules.filter((module) => module.state() === 'passed').length;
      const crash = unhandledErrors.length ? ` | ${unhandledErrors.length} unhandled error(s)` : '';
      write(`[vitest] ${failed} failed | ${passed} passed (${testModules.length} files)${crash}\n`);
    },
  };
}

