import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, test } from 'vitest';

import type { QuayBlockerSummary, QuayFanInAttemptSummary, QuayGanttLanes, QuayInFlightTask } from '@/shared/types';
import { i18n } from '@/modules/i18n';
import PulseStrip, {
  DEFAULT_PULSE_WINDOW_HOURS,
  IN_FLIGHT_PHASE_COLORS,
  PULSE_STRIP_HEIGHT_PX,
  STATUS_COLORS,
} from '@/modules/quay/PulseStrip';

/**
 * The fixture is ONE project at one instant, so every assertion below reads the same clock:
 * `generatedAt` is the strip's `now` and nothing calls `Date.now()`.
 *
 *   in flight  task-live  (implementing, healthy)      task-stale (fan-in, heartbeat 20 min old)
 *   fan-in     landed     (up / good)                   red (down / critical)   exited-not-landed (serious)
 *   suite      round 1 green 10 s                       round 2 red 30 s
 *   blocked    one signature, 2 occurrences, 2 dependents
 */
const GENERATED_AT = '2026-10-24T12:00:00.000Z';
const NOW_MS = Date.parse(GENERATED_AT);
const NOW_SEC = NOW_MS / 1000;

const IN_FLIGHT: QuayInFlightTask[] = [
  {
    taskId: 'task-live',
    phase: 'implementing',
    startedAt: '2026-10-24T11:00:00.000Z',
    lastHeartbeat: '2026-10-24T11:59:00.000Z',
    workerPid: 41,
  },
  {
    taskId: 'task-stale',
    phase: 'fan-in',
    startedAt: '2026-10-24T10:00:00.000Z',
    // Older than the worker's five-minute round interval: the line must end in a hollow dot.
    lastHeartbeat: '2026-10-24T11:40:00.000Z',
    workerPid: null,
  },
];

const GANTT: QuayGanttLanes = {
  windowHours: DEFAULT_PULSE_WINDOW_HOURS,
  nowMs: NOW_MS,
  lanes: [
    [
      {
        taskId: 'task-live',
        runId: 'worker-task-live',
        startMs: Date.parse('2026-10-24T11:00:00.000Z'),
        endMs: NOW_MS,
        phase: 'implementing',
        finalState: null,
        fanInOutcome: null,
      },
    ],
    [
      {
        taskId: 'task-stale',
        runId: 'worker-task-stale',
        startMs: Date.parse('2026-10-24T10:00:00.000Z'),
        endMs: NOW_MS,
        phase: 'fan-in',
        finalState: null,
        fanInOutcome: null,
      },
    ],
  ],
  overflow: 0,
};

const FAN_IN: QuayFanInAttemptSummary[] = [
  { task: 'task-ok', outcome: 'landed', lockAcquireEpoch: NOW_SEC - 3600, lockReleaseEpoch: NOW_SEC - 3500 },
  { task: 'task-red', outcome: 'red', lockAcquireEpoch: NOW_SEC - 1800, lockReleaseEpoch: NOW_SEC - 1700 },
  {
    task: 'task-serious',
    outcome: 'exited-not-landed',
    lockAcquireEpoch: NOW_SEC - 900,
    lockReleaseEpoch: NOW_SEC - 800,
  },
];

const BLOCKERS: QuayBlockerSummary[] = [
  {
    taskId: 'task-a',
    since: '2026-10-24T08:00:00.000Z',
    signature: 'AC 未全勾 :: checked #/#',
    occurrences: 2,
    dependents: ['task-e', 'task-f'],
  },
];

beforeEach(async () => {
  // The empty-state criterion quotes the shipped sentence, so it is read in a shipped locale
  // rather than in a fallback: zh-CN is the project's primary language.
  await i18n.changeLanguage('zh-CN');
});

function renderStrip(overrides: Partial<React.ComponentProps<typeof PulseStrip>> = {}) {
  return render(
    <PulseStrip
      inFlight={IN_FLIGHT}
      gantt={GANTT}
      tests={{
        current: null,
        recentRounds: [
          {
            round: 1,
            startedAt: '2026-10-24T09:00:00.000Z',
            durationMs: 10_000,
            pass: 10,
            fail: 0,
            tests: 10,
            state: 'green',
          },
          {
            round: 2,
            startedAt: '2026-10-24T10:00:00.000Z',
            durationMs: 30_000,
            pass: 9,
            fail: 1,
            tests: 10,
            state: 'red',
          },
        ],
      }}
      fanIn={{ recent: FAN_IN }}
      blockers={BLOCKERS}
      generatedAt={GENERATED_AT}
      {...overrides}
    />,
  );
}

describe('the four rows', () => {
  test('draws one row per reading and stays within 48 px', () => {
    const { getByTestId, queryByTestId } = renderStrip();

    for (const row of ['inflight', 'fanin', 'suite', 'blocked']) {
      assert.ok(getByTestId(`pulse-strip-row-${row}`), `the ${row} row must exist`);
    }

    const strip = getByTestId('pulse-strip');
    assert.equal(strip.getAttribute('data-height-px'), String(PULSE_STRIP_HEIGHT_PX));
    const declaredHeight = Number.parseInt(strip.style.height, 10);
    assert.ok(declaredHeight <= 48, `the strip must be at most 48 px, got ${declaredHeight}`);
    assert.equal(queryByTestId('pulse-strip-empty'), null, 'a populated strip has no empty line');
  });

  test('fan-in success rises and failure sinks, each with a shape and a severity', () => {
    const { getAllByTestId } = renderStrip();
    const marks = getAllByTestId('pulse-strip-fanin-mark');

    const success = marks.find((mark) => mark.getAttribute('data-outcome') === 'landed');
    assert.ok(success !== undefined);
    assert.equal(success.getAttribute('data-direction'), 'up');
    assert.equal(success.getAttribute('data-shape'), 'fan-in-up');

    const failure = marks.find((mark) => mark.getAttribute('data-outcome') === 'red');
    assert.ok(failure !== undefined);
    assert.equal(failure.getAttribute('data-direction'), 'down');
    assert.equal(failure.getAttribute('data-severity'), 'critical');
    assert.match(failure.className, /bg-red-600/);

    // A retry / partial landing is serious, and still carries a direction shape.
    const serious = marks.find((mark) => mark.getAttribute('data-outcome') === 'exited-not-landed');
    assert.ok(serious !== undefined);
    assert.equal(serious.getAttribute('data-severity'), 'serious');
    assert.match(serious.className, /bg-orange-600/);
  });

  test('a failing suite round is critical and carries an explicit glyph', () => {
    const { getAllByTestId } = renderStrip();
    const marks = getAllByTestId('pulse-strip-suite-mark');

    const failing = marks.find((mark) => mark.getAttribute('data-state') === 'red');
    assert.ok(failing !== undefined);
    assert.equal(failing.getAttribute('data-severity'), 'critical');
    assert.equal(failing.getAttribute('data-shape'), 'suite-fail');

    const passing = marks.find((mark) => mark.getAttribute('data-state') === 'green');
    assert.ok(passing !== undefined);
    assert.equal(passing.getAttribute('data-severity'), 'good');
    assert.equal(passing.getAttribute('data-shape'), 'suite-pass');
  });

  test('a blocked segment ends with the number of waiting tasks', () => {
    const { getByTestId } = renderStrip();
    const impact = getByTestId('pulse-strip-blocker-impact');
    assert.match(impact.textContent ?? '', /⛔ 2/);

    const segment = getByTestId('pulse-strip-blocker-segment');
    assert.equal(segment.getAttribute('data-dependents'), '2');
    assert.equal(segment.getAttribute('data-occurrences'), '2');
    assert.equal(segment.getAttribute('data-shape'), 'blocked');
  });

  test('the stale in-flight line ends in a hollow dot, not a solid end', () => {
    const { getByTestId, getAllByTestId } = renderStrip();
    const dot = getByTestId('pulse-strip-inflight-stale-dot');
    assert.equal(dot.getAttribute('data-shape'), 'hollow-dot');
    // Only the stale task carries one.
    assert.equal(getAllByTestId('pulse-strip-inflight-stale-dot').length, 1);
    const staleLine = getAllByTestId('pulse-strip-inflight-line')
      .find((line) => line.getAttribute('data-stale') === 'true');
    assert.ok(staleLine !== undefined);
  });

  test('hovering a mark opens a tooltip with the reading', () => {
    const { getAllByTestId, queryByTestId, getByTestId } = renderStrip();
    assert.equal(queryByTestId('pulse-strip-tooltip'), null);

    const failure = getAllByTestId('pulse-strip-fanin-mark')
      .find((mark) => mark.getAttribute('data-outcome') === 'red');
    assert.ok(failure !== undefined);
    fireEvent.mouseEnter(failure);

    const tooltip = getByTestId('pulse-strip-tooltip');
    assert.match(tooltip.textContent ?? '', /task-red: red/);

    fireEvent.mouseLeave(failure);
    assert.equal(queryByTestId('pulse-strip-tooltip'), null);
  });

  test('no data at all still draws the baseline and says so', () => {
    const { getByTestId } = renderStrip({
      inFlight: [],
      gantt: null,
      tests: { current: null, recentRounds: [] },
      fanIn: { recent: [] },
      blockers: [],
    });

    assert.ok(getByTestId('pulse-strip-baseline'));
    assert.equal(getByTestId('pulse-strip').getAttribute('data-empty'), 'true');
    assert.match(getByTestId('pulse-strip-empty').textContent ?? '', /最近 24h 无活动/);
  });
});

describe('windows', () => {
  test('6h / 24h / 72h re-select the data without changing the strip height', () => {
    const { getByTestId, getAllByTestId } = renderStrip();
    const strip = getByTestId('pulse-strip');
    const rowHeightSignature = () =>
      ['inflight', 'fanin', 'suite', 'blocked']
        .map((row) => getByTestId(`pulse-strip-row-${row}`).getAttribute('data-row-height'))
        .join(',');

    const initialRows = rowHeightSignature();
    assert.equal(strip.getAttribute('data-window-hours'), '24');
    const dayMarks = getAllByTestId('pulse-strip-fanin-mark').length;

    fireEvent.click(getByTestId('pulse-strip-window-6'));
    assert.equal(getByTestId('pulse-strip').getAttribute('data-window-hours'), '6');
    assert.equal(getByTestId('pulse-strip').style.height, `${PULSE_STRIP_HEIGHT_PX}px`);
    assert.equal(rowHeightSignature(), initialRows);
    // The 8:00 blocker predates the 6 h window ([06:00, 12:00] contains it, but the fan-in
    // attempts at 11:00/11:30 stay; the window changed the DATA, not the geometry).
    const sixHourMarks = getAllByTestId('pulse-strip-fanin-mark').length;
    assert.ok(sixHourMarks <= dayMarks, 'a narrower window cannot add records');

    fireEvent.click(getByTestId('pulse-strip-window-72'));
    assert.equal(getByTestId('pulse-strip').getAttribute('data-window-hours'), '72');
    assert.equal(getByTestId('pulse-strip').style.height, `${PULSE_STRIP_HEIGHT_PX}px`);
    assert.equal(rowHeightSignature(), initialRows);
  });
});

describe('colour and shape are independent channels', () => {
  test('the in-flight palette is disjoint from the status palette', () => {
    const overlap = IN_FLIGHT_PHASE_COLORS.filter((color) => STATUS_COLORS.includes(color));
    assert.deepEqual(overlap, [], 'a phase hue must never also mean a health state');
  });

  test('every health mark carries a shape attribute as well as a colour class', () => {
    const { getAllByTestId, getByTestId } = renderStrip();

    const statusMarks = [
      ...getAllByTestId('pulse-strip-fanin-mark'),
      ...getAllByTestId('pulse-strip-suite-mark'),
      getByTestId('pulse-strip-blocker-segment'),
    ];
    assert.ok(statusMarks.length > 0);
    for (const mark of statusMarks) {
      assert.ok(
        (mark.getAttribute('data-shape') ?? '').length > 0,
        `a status mark without a shape is colour-only: ${mark.getAttribute('data-testid')}`,
      );
      assert.match(mark.className, /bg-(green|amber|orange|red)-600/);
    }

    // In-flight phases are identities, not health: they carry the categorical hues and still
    // expose a shape (the line), so a reader who cannot see the hue can tell the rows apart.
    for (const line of getAllByTestId('pulse-strip-inflight-line')) {
      assert.equal(line.getAttribute('data-shape'), 'in-flight-line');
      assert.match(line.className, /bg-(blue|violet|cyan|indigo)-600/);
    }
  });
});
