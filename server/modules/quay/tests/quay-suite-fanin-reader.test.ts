import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  isoInstantToEpochSeconds,
  QUAY_FAN_IN_READ_COMMAND,
  QUAY_SUITE_READ_COMMAND,
  readQuaySuiteAndFanIn,
  type QuaySuiteFanInReading,
  type QuayVerbResult,
} from '../read/quay-suite-fanin-reader.js';

/**
 * The fixtures are the REAL output of quay 0.24.0's two read verbs, captured on this
 * workspace on 2026-10-28:
 *
 *   quay suite --json --limit 3
 *   quay driver log --kind worker --json --limit 5
 *
 * They are kept verbatim (no hand-pruning) so the adapter is tested against the documents the
 * CLI actually prints — including the ISO `finishedAt`, the nested `mechanical_fan_in` block and
 * the carrier/status vocabulary — not against a shape invented here.
 */
const FIXTURES = path.join(import.meta.dirname, 'fixtures');

function readFixture(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as Record<string, unknown>;
}

function answer(document: unknown, overrides: Partial<QuayVerbResult> = {}): QuayVerbResult {
  return { ok: true, code: 0, stdout: JSON.stringify(document), stderr: '', ...overrides };
}

/** A runner answering the two read verbs with the given results; anything else is a bug. */
function runnerAnswering(suite: QuayVerbResult, fanIn: QuayVerbResult) {
  const suiteKey = QUAY_SUITE_READ_COMMAND.join(' ');
  const fanInKey = QUAY_FAN_IN_READ_COMMAND.join(' ');
  return async (_cwd: string, args: readonly string[]): Promise<QuayVerbResult> => {
    const key = args.join(' ');
    if (key === suiteKey) {
      return suite;
    }
    if (key === fanInKey) {
      return fanIn;
    }
    throw new Error(`unexpected command: ${key}`);
  };
}

test('adapts the real 0.24.0 verb documents to the existing Tests and Fan-in shapes', async () => {
  const suiteFixture = readFixture('suite-verb-0.24.0.json');
  const driverFixture = readFixture('driver-log-worker-0.24.0.json');

  // The real log, plus one attempt that never reached fan-in. It must not become a row.
  const attempts = [
    ...(driverFixture.attempts as unknown[]),
    { ts: '2026-10-27T17:30:00.000Z', task: 'never-reached-fan-in', outcome: 'landed', step: null },
  ];

  const reading = await readQuaySuiteAndFanIn(
    runnerAnswering(
      answer(suiteFixture),
      answer({ ...driverFixture, attempts }),
    ),
    '/workspace/project-1',
  );

  // `current`: the verb's ISO `finishedAt` is converted BACK to the epoch SECONDS the
  // `QuaySuiteState` contract has always carried, and every other field is relayed as-is.
  assert.deepEqual(reading.tests.current, {
    state: 'green',
    runner: 'inner',
    scope: 'worktree',
    startedAt: '2026-10-27T17:17:12.815Z',
    finishedAt: 1_793_121_773,
    durationMs: 340_283,
    laneCount: 128,
    commit: 'cf84fd9276f6862cf56a3ca313c4a402c4ddf908',
    taskId: 'gap-cockpit-ask-digest-refresh-yesno-options-and-left-marker',
    runId: 'mfi-gap-cockpit-ask-digest-refresh-yesno-options-and-left-marker-1793121417523-a48dcb',
  });

  // `rounds`: newest-first, exactly the existing `QuayTestRoundSummary` shape. The verb's
  // document has no `tests` count, so that field is `null` rather than a fabricated 0.
  assert.deepEqual(reading.tests.recentRounds, [
    { round: 1684, startedAt: '2026-10-27T17:17:16.615Z', durationMs: 332_682, pass: 811, fail: 0, tests: null, state: 'green' },
    { round: 1683, startedAt: '2026-10-27T17:02:23.932Z', durationMs: 331_046, pass: 811, fail: 0, tests: null, state: 'green' },
    { round: 1682, startedAt: '2026-10-27T16:26:57.772Z', durationMs: 342_148, pass: 811, fail: 0, tests: null, state: 'green' },
  ]);

  // `attempts[i].mechanical_fan_in` is the only place the lock readings exist; the top-level
  // attempt fields must not be used for them, and the block-less attempt is dropped.
  assert.deepEqual(reading.fanIn.recent, [
    { task: 'cockpit-card-anatomy-matches-mockups', outcome: 'landed', lockAcquireEpoch: 1_793_116_665, lockReleaseEpoch: 1_793_117_034 },
    { task: 'gap-ac161-criterion-load-flake-stabilize', outcome: 'landed', lockAcquireEpoch: 1_793_117_728, lockReleaseEpoch: 1_793_118_115 },
    { task: 'cockpit-shell-filters-mobile-page-and-details-bar', outcome: 'landed', lockAcquireEpoch: 1_793_118_413, lockReleaseEpoch: 1_793_118_764 },
    { task: 'gap-phone-pulse-thumbnail-opens-popover-not-quay-tab', outcome: 'landed', lockAcquireEpoch: 1_793_120_540, lockReleaseEpoch: 1_793_120_879 },
    { task: 'gap-cockpit-ask-digest-refresh-yesno-options-and-left-marker', outcome: 'landed', lockAcquireEpoch: 1_793_121_417, lockReleaseEpoch: 1_793_121_775 },
  ]);
  assert.equal(
    reading.fanIn.recent.some((attempt) => attempt.task === 'never-reached-fan-in'),
    false,
    'an attempt without a mechanical_fan_in block never reached fan-in and is not a row',
  );

  assert.deepEqual(reading.carrierReadings, {
    suite: { state: 'ok', reason: null },
    fanIn: { state: 'ok', reason: null },
  });
});

test('finishedAt is epoch seconds for an ISO instant, and null — never 0 or NaN — otherwise', async () => {
  // The exact unit conversion this adapter exists for: the verb normalises the carrier's
  // epoch-seconds integer to ISO, and `QuaySuiteState.finishedAt` is epoch seconds.
  assert.equal(isoInstantToEpochSeconds('2026-10-27T17:22:53.000Z'), 1_793_121_773);
  assert.equal(isoInstantToEpochSeconds('1970-01-01T00:00:00.000Z'), 0);
  assert.equal(isoInstantToEpochSeconds(undefined), null);
  assert.equal(isoInstantToEpochSeconds(null), null);
  assert.equal(isoInstantToEpochSeconds(''), null);
  assert.equal(isoInstantToEpochSeconds('not-a-date'), null);
  // A numeric value is not the verb's documented form; reading it as an instant would be a
  // guess about its unit (seconds vs milliseconds), so it is "not parseable" here.
  assert.equal(isoInstantToEpochSeconds(1_793_121_773), null);

  const readFinishedAt = async (finishedAt: unknown): Promise<number | null> => {
    const reading: QuaySuiteFanInReading = await readQuaySuiteAndFanIn(
      runnerAnswering(
        answer({ current: { state: 'green', finishedAt }, rounds: [], carrier: { state: 'ok', reason: null } }),
        answer({ attempts: [], status: 'ok', reason: null }),
      ),
      '/workspace/project-1',
    );
    return reading.tests.current?.finishedAt ?? null;
  };

  assert.equal(await readFinishedAt('2026-10-27T17:22:53.000Z'), 1_793_121_773);
  assert.equal(await readFinishedAt(undefined), null);
  assert.equal(await readFinishedAt('not-a-date'), null);
});

test('a missing or unreadable verb is reported, never drawn as an empty history', async () => {
  // The real 0.19.0 CLI answers an unknown command with a multi-line usage block. The panel
  // renders the reason on one line, so the adapter keeps the first line and nothing else.
  const noOutput: QuayVerbResult = {
    ok: false,
    code: 1,
    stdout: '',
    stderr: 'error: unknown command: suite\nusage: quay <adr|goal|meta|...> ...\nRun `quay --help` for full usage.',
  };
  const nonJson: QuayVerbResult = { ok: true, code: 0, stdout: '{ not json', stderr: '' };
  const emptySuite = answer({ current: null }); // no `rounds` key
  const emptyDriverLog = answer({ status: 'ok' }); // no `attempts` key

  const cases: Array<{
    name: string;
    suite: QuayVerbResult;
    fanIn: QuayVerbResult;
    suiteState: string;
    fanInState: string;
  }> = [
    // An older pinned CLI does not have the verb at all: it exits non-zero and prints usage.
    { name: 'verb missing', suite: noOutput, fanIn: noOutput, suiteState: 'verb-unavailable', fanInState: 'verb-unavailable' },
    { name: 'non-JSON body', suite: nonJson, fanIn: nonJson, suiteState: 'failed', fanInState: 'failed' },
    { name: 'missing keys', suite: emptySuite, fanIn: emptyDriverLog, suiteState: 'failed', fanInState: 'failed' },
  ];

  for (const testCase of cases) {
    const reading = await readQuaySuiteAndFanIn(
      runnerAnswering(testCase.suite, testCase.fanIn),
      '/workspace/project-1',
    );

    assert.equal(reading.carrierReadings.suite.state, testCase.suiteState, testCase.name);
    assert.equal(reading.carrierReadings.fanIn.state, testCase.fanInState, testCase.name);
    assert.ok(reading.carrierReadings.suite.reason, `${testCase.name}: the suite reading must say why`);
    assert.ok(reading.carrierReadings.fanIn.reason, `${testCase.name}: the fan-in reading must say why`);
    assert.equal(
      reading.carrierReadings.suite.reason?.includes('\n'),
      false,
      `${testCase.name}: the reason is one line, so the card can render it`,
    );

    // No fabricated records: a failed read is an unread section, not an empty history.
    assert.equal(reading.tests.current, null, testCase.name);
    assert.deepEqual(reading.tests.recentRounds, [], testCase.name);
    assert.deepEqual(reading.fanIn.recent, [], testCase.name);
  }
});

test('the four carrier states quay publishes are passed through untouched', async () => {
  for (const state of ['ok', 'absent', 'unreadable', 'empty-writer-zero-records']) {
    const reading = await readQuaySuiteAndFanIn(
      runnerAnswering(
        answer({ current: null, rounds: [], carrier: { state, reason: `suite is ${state}` } }),
        answer({ attempts: [], status: state, reason: `driver log is ${state}` }),
      ),
      '/workspace/project-1',
    );

    assert.deepEqual(reading.carrierReadings.suite, { state, reason: `suite is ${state}` });
    assert.deepEqual(reading.carrierReadings.fanIn, { state, reason: `driver log is ${state}` });
  }
});
