#!/usr/bin/env node
/**
 * The controls for `scripts/e2e-run-ceilings.mjs` — the two origins the e2e run watchdog measures from,
 * and the control arm that produced the defect behind `gap-ac323-boot-ceiling-counts-config-evaluation`.
 *
 * WHY THESE CASES EXIST. The defect is a *pointer*, not a magnitude: `BOOT_CEILING_MS = 40_000` was
 * correct as a bound on "the unbounded pre-spawn probe", and the run that died at 56826ms was killed by
 * it because the deadline was counted from `runStartedAt` — so config evaluation itself (a synchronous
 * seed + client-root copy + server bundle, 56.8s under the load of gate event
 * `9d08ccd0-c886-4e58-b750-ea2f2eeb7ede`) consumed it before Playwright spawned a webServer. A test that
 * only asserted "the boot deadline is 40s after something" would pass against that old code, so each case
 * below pins the *origin*:
 *
 *   · the boot deadline moves with `configEvalCompletedAt` — config evaluation time is NOT charged to it;
 *   · the run deadline stays pinned to `runStartedAt` — the whole invocation IS charged to it;
 *   · the control-arm knob reads 0 by default and clamps at 120000 in both directions, because a knob
 *     that only clamped above would let a negative value park the thread for an unbounded time.
 *
 * The stall itself is not waited on here: `stallConfigEvaluation` blocks the calling thread, so a case
 * that exercised it would sleep the suite. Its arithmetic is what the clamp cases read, and it is
 * exercised end-to-end by the task's AC1/AC2/AC3 runs against the real runner.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BOOT_CEILING_RUN_MARGIN_MS,
  CONFIG_EVAL_STALL_ENV,
  CONFIG_EVAL_STALL_MAX_MS,
  DEFAULT_BOOT_CEILING_MS,
  MAX_BOOT_CEILING_MS,
  SINGLE_SPEC_CEILING_MS,
  bootCeilingFor,
  bootDeadlineFrom,
  readConfigEvalStallMs,
  runDeadlineFrom,
  stallConfigEvaluation,
  timerDelay,
  webServerTimeoutFor,
} from './e2e-run-ceilings.mjs';

test('the boot deadline is anchored at the end of config evaluation, not at the run start', () => {
  const runStartedAt = 1_000;
  const configEvalCompletedAt = 57_826;
  const bootCeilingMs = 40_000;

  // The recorded failure: config evaluation alone (56.8s) already crossed a 40s ceiling measured from
  // `runStartedAt`. Anchored at the end of evaluation it has a full window left to boot in.
  assert.equal(bootDeadlineFrom(configEvalCompletedAt, bootCeilingMs), 97_826);
  assert.ok(
    bootDeadlineFrom(configEvalCompletedAt, bootCeilingMs) - configEvalCompletedAt === bootCeilingMs,
    'the boot window must be exactly BOOT_CEILING_MS long from the end of config evaluation',
  );
  assert.ok(
    bootDeadlineFrom(configEvalCompletedAt, bootCeilingMs) > runStartedAt + bootCeilingMs,
    'a slow config evaluation must not consume the boot window — the old origin did',
  );
});

test('the run ceiling is still anchored at the run start', () => {
  const runStartedAt = 1_000;
  const runCeilingMs = 240_000;

  assert.equal(runDeadlineFrom(runStartedAt, runCeilingMs), 241_000);
  // The two origins are independent: a boot deadline computed from config evaluation must not move the
  // run deadline, which bounds the whole invocation including config evaluation.
  assert.notEqual(runDeadlineFrom(runStartedAt, runCeilingMs), bootDeadlineFrom(57_826, runCeilingMs));
  assert.equal(runDeadlineFrom(57_826, runCeilingMs) - 57_826, runCeilingMs);
});

test('timerDelay converts a deadline to a non-negative wait', () => {
  assert.equal(timerDelay(1_500, 1_000), 500);
  assert.equal(timerDelay(1_000, 1_000), 0);
  // A deadline already in the past fires immediately rather than waiting a negative time.
  assert.equal(timerDelay(1_000, 5_000), 0);
});

test('the control-arm stall knob reads 0 by default', () => {
  assert.equal(readConfigEvalStallMs({}), 0);
  assert.equal(readConfigEvalStallMs({ [CONFIG_EVAL_STALL_ENV]: '' }), 0);
  assert.equal(readConfigEvalStallMs({ [CONFIG_EVAL_STALL_ENV]: '   ' }), 0);
  // A malformed knob must not throw inside config evaluation, where a throw is a red run for a reason
  // none of its own assertions can name.
  assert.equal(readConfigEvalStallMs({ [CONFIG_EVAL_STALL_ENV]: 'not-a-number' }), 0);
  assert.equal(readConfigEvalStallMs({ [CONFIG_EVAL_STALL_ENV]: 'NaN' }), 0);
  // Default argument is the process environment, which carries no stall unless a control arm set it.
  const saved = process.env[CONFIG_EVAL_STALL_ENV];
  delete process.env[CONFIG_EVAL_STALL_ENV];
  try {
    assert.equal(readConfigEvalStallMs(), 0);
  } finally {
    if (saved !== undefined) process.env[CONFIG_EVAL_STALL_ENV] = saved;
  }
});

test('the control-arm stall knob clamps to [0, 120000]', () => {
  assert.equal(readConfigEvalStallMs({ [CONFIG_EVAL_STALL_ENV]: '45000' }), 45_000);
  assert.equal(readConfigEvalStallMs({ [CONFIG_EVAL_STALL_ENV]: ' 45000 ' }), 45_000);
  assert.equal(readConfigEvalStallMs({ [CONFIG_EVAL_STALL_ENV]: '45000.9' }), 45_000);
  assert.equal(readConfigEvalStallMs({ [CONFIG_EVAL_STALL_ENV]: '-1' }), 0);
  assert.equal(readConfigEvalStallMs({ [CONFIG_EVAL_STALL_ENV]: String(CONFIG_EVAL_STALL_MAX_MS) }), 120_000);
  assert.equal(readConfigEvalStallMs({ [CONFIG_EVAL_STALL_ENV]: '999999' }), 120_000);
  assert.equal(CONFIG_EVAL_STALL_MAX_MS, 120_000);
  // `stallConfigEvaluation(0)` is the shipped path: it must not park the thread at all.
  assert.equal(stallConfigEvaluation(0), 0);
  assert.equal(stallConfigEvaluation(-10), 0);
});

test('the boot ceiling is fixed at 40s for the default selection', () => {
  // The shipped single-file ceiling and anything below it: the value the one-file gate invocation gets stays
  // byte-for-byte what it was, so this task cannot move a spec it did not touch.
  assert.equal(bootCeilingFor(SINGLE_SPEC_CEILING_MS), 40_000);
  assert.equal(bootCeilingFor(0), 40_000);
  assert.equal(bootCeilingFor(SINGLE_SPEC_CEILING_MS - 1), 40_000);
  assert.equal(bootCeilingFor(Number.NaN), 40_000);
  assert.equal(DEFAULT_BOOT_CEILING_MS, 40_000);
});

test('the boot ceiling grows with a declared run budget', () => {
  // `resident-shell-tab.spec.ts` declares 240_000 (AC-174): the window must clear the 40s default and stay a
  // real window rather than collapsing to the floor.
  const declared = bootCeilingFor(240_000);
  assert.ok(declared > DEFAULT_BOOT_CEILING_MS, `240_000ms must raise the boot window above ${DEFAULT_BOOT_CEILING_MS}ms`);
  assert.equal(declared, 120_000);
});

test('the boot ceiling caps at 120s for the largest declared budget', () => {
  // 1_200_000 is the largest entry in the config's table. One more second of budget must not move the cap.
  assert.equal(bootCeilingFor(1_200_000), 120_000);
  assert.equal(bootCeilingFor(1_200_001), MAX_BOOT_CEILING_MS);
  assert.equal(MAX_BOOT_CEILING_MS, 120_000);
});

test('every boot ceiling stays 5s inside its run ceiling', () => {
  // The reading that keeps a crossing legible: the watchdog must be able to write its line and
  // `watchdog-state.json` before the gate's SIGKILL lands. Every arm AC-174 names, plus the boundaries.
  for (const runCeilingMs of [55_000, 55_001, 60_000, 240_000, 480_000, 600_000, 1_200_000]) {
    const ceiling = bootCeilingFor(runCeilingMs);
    assert.ok(
      ceiling < runCeilingMs - BOOT_CEILING_RUN_MARGIN_MS,
      `boot ceiling ${ceiling}ms must stay ${BOOT_CEILING_RUN_MARGIN_MS}ms inside the ${runCeilingMs}ms run ceiling`,
    );
  }
  assert.equal(BOOT_CEILING_RUN_MARGIN_MS, 5_000);
});

test('the webServer wait keeps the shipped 35s for the default selection', () => {
  // The one-file gate invocation must not move: 40s boot ceiling minus the original 5s gap is 35s,
  // byte-for-byte. This is the first wall a gate run hits, so a silent change here reds a criterion
  // before any case rather than in one.
  assert.equal(webServerTimeoutFor(SINGLE_SPEC_CEILING_MS), 35_000);
  assert.equal(webServerTimeoutFor(55_000), 35_000);
});

test('the webServer wait scales with a declared run budget', () => {
  // The defect this exists to control: a 240s / 535s / 1_200_000 selection kept a 35s wait while its
  // boot ceiling had already grown to 120s. The wait now follows the ceiling at the same 5s margin.
  assert.equal(webServerTimeoutFor(240_000), 115_000);
  assert.equal(webServerTimeoutFor(535_000), 115_000);
  assert.equal(webServerTimeoutFor(1_200_000), 115_000);
});

test('every webServer wait is the boot ceiling minus the run margin', () => {
  // One invariant rather than four numbers: the wait can never overtake the boot ceiling (which would let
  // Playwright's own line disappear behind the watchdog) and never falls below the shipped 35s.
  for (const runCeilingMs of [55_000, 240_000, 535_000, 1_200_000]) {
    const wait = webServerTimeoutFor(runCeilingMs);
    const ceiling = bootCeilingFor(runCeilingMs);
    assert.equal(wait, ceiling - BOOT_CEILING_RUN_MARGIN_MS);
    assert.ok(wait < ceiling, `webServer wait ${wait}ms must stay inside the ${ceiling}ms boot ceiling`);
    assert.ok(wait >= 35_000, `webServer wait ${wait}ms must never shrink below the shipped 35_000ms`);
  }
});
