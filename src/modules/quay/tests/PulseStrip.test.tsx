import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, test } from 'vitest';

import type { QuayBlockerSummary, QuayFanInAttemptSummary, QuayGanttLanes, QuayInFlightTask } from '@/shared/types';
import { i18n } from '@/modules/i18n';
import PulseStrip, {
  DEFAULT_PULSE_WINDOW_HOURS,
  IN_FLIGHT_PHASE_COLORS,
  PULSE_IN_FLIGHT_BAR_HEIGHT_PX,
  PULSE_SELECTOR_HEIGHT_PX,
  PULSE_SELECTOR_TOUCH_TARGET_PX,
  PULSE_STRIP_HEIGHT_PX,
  PULSE_STRIP_LAYOUT,
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
    // Older than the worker's five-minute round interval: the bar must end in a hollow dot.
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
  test('draws one row per reading at the declared strip height', () => {
    const { getByTestId, queryByTestId } = renderStrip();

    for (const row of ['inflight', 'fanin', 'suite', 'blocked']) {
      assert.ok(getByTestId(`pulse-strip-row-${row}`), `the ${row} row must exist`);
    }

    const strip = getByTestId('pulse-strip');
    assert.equal(strip.getAttribute('data-height-px'), String(PULSE_STRIP_HEIGHT_PX));
    // The inline height is the promise for a fine pointer; the chrome grows on coarse pointers.
    assert.equal(strip.style.minHeight, `${PULSE_STRIP_HEIGHT_PX}px`);
    assert.equal(
      PULSE_STRIP_HEIGHT_PX,
      PULSE_STRIP_LAYOUT.chromeHeightPx + PULSE_STRIP_LAYOUT.plotHeightPx,
    );
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

  test('the stale in-flight bar ends in a hollow dot, not a solid end', () => {
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

describe('readable window control, labels and axis', () => {
  test('the window selector lives outside every row and all three windows are clickable', () => {
    const { getByTestId } = renderStrip();
    const windows = getByTestId('pulse-strip-windows');

    // (a) The selector is not a descendant of any row container …
    for (const row of ['inflight', 'fanin', 'suite', 'blocked']) {
      const rowElement = getByTestId(`pulse-strip-row-${row}`);
      assert.equal(rowElement.contains(windows), false, `the ${row} row must not contain the selector`);
      assert.equal(windows.closest(`[data-testid="pulse-strip-row-${row}"]`), null);
    }

    // … and the two regions cannot intersect: the chrome (top 0, height H) ends exactly where
    // the plot (top H) begins. Read from the exported constants, not from jsdom geometry.
    const chrome = getByTestId('pulse-strip-chrome');
    const plot = getByTestId('pulse-strip-plot');
    const chromeTop = Number(chrome.getAttribute('data-layout-top-px'));
    const chromeHeight = Number(chrome.getAttribute('data-layout-height-px'));
    const plotTop = Number(plot.getAttribute('data-layout-top-px'));
    assert.equal(chromeTop, PULSE_STRIP_LAYOUT.chromeTopPx);
    assert.equal(chromeHeight, PULSE_STRIP_LAYOUT.chromeHeightPx);
    assert.equal(plotTop, PULSE_STRIP_LAYOUT.plotTopPx);
    assert.ok(chromeTop + chromeHeight <= plotTop, 'the chrome must end before the plot begins');
    assert.equal(windows.closest('[data-layout-region="plot"]'), null);
    assert.equal(windows.getAttribute('data-layout-region'), 'chrome');

    // A normal-sized control (≥24 px) that reaches a ≥44 px hit target on a coarse pointer.
    assert.ok(PULSE_SELECTOR_HEIGHT_PX >= 24);
    assert.ok(PULSE_SELECTOR_TOUCH_TARGET_PX >= 44);
    assert.equal(Number(windows.getAttribute('data-control-height-px')), PULSE_SELECTOR_HEIGHT_PX);
    assert.equal(Number(windows.getAttribute('data-touch-target-px')), PULSE_SELECTOR_TOUCH_TARGET_PX);
    assert.match(windows.className, /pointer:coarse/);
    assert.match(windows.className, /h-11/);
    for (const option of [6, 24, 72]) {
      assert.match(getByTestId(`pulse-strip-window-${option}`).className, /\[@media\(pointer:coarse\)\]:h-11/);
    }

    // Each click re-selects the window and leaves exactly one pressed button.
    for (const option of [6, 24, 72]) {
      fireEvent.click(getByTestId(`pulse-strip-window-${option}`));
      assert.equal(getByTestId('pulse-strip').getAttribute('data-window-hours'), String(option));
      assert.equal(getByTestId(`pulse-strip-window-${option}`).getAttribute('aria-pressed'), 'true');
    }
  });

  test('every row carries a visible text label from the cockpit.pulseRow* keys', () => {
    const { getByTestId, getByText } = renderStrip();
    const expected: Array<[string, string]> = [
      ['inflight', 'cockpit.pulseRowInFlight'],
      ['fanin', 'cockpit.pulseRowFanIn'],
      ['suite', 'cockpit.pulseRowSuite'],
      ['blocked', 'cockpit.pulseRowBlocked'],
    ];

    for (const [row, key] of expected) {
      const text = i18n.t(key);
      const label = getByTestId(`pulse-strip-row-${row}-label`);
      assert.equal(label.textContent, text, `the ${row} row label is visible copy, not an attribute`);
      // getByText proves the string is rendered as text, not only as an aria-label.
      assert.ok(getByText(text, { selector: `[data-testid="pulse-strip-row-${row}-label"]` }));
    }
  });

  test('the strip draws a time axis whose origin follows the window', () => {
    const { getByTestId } = renderStrip();

    assert.equal(getByTestId('pulse-strip-axis-start').textContent, '-24h');
    assert.equal(getByTestId('pulse-strip-axis-mid').textContent, '-12h');
    assert.match(getByTestId('pulse-strip-axis-now').textContent ?? '', /现在|now/);

    fireEvent.click(getByTestId('pulse-strip-window-6'));
    assert.equal(getByTestId('pulse-strip-axis-start').textContent, '-6h');
    assert.equal(getByTestId('pulse-strip-axis-mid').textContent, '-3h');

    fireEvent.click(getByTestId('pulse-strip-window-72'));
    assert.equal(getByTestId('pulse-strip-axis-start').textContent, '-72h');
    assert.equal(getByTestId('pulse-strip-axis-mid').textContent, '-36h');
  });

  test('an in-flight task is an ≥8 px bar with its id; an empty row says so', () => {
    const wide = renderStrip({
      inFlight: [
        {
          taskId: 'task-wide',
          phase: 'implementing',
          startedAt: '2026-10-24T06:00:00.000Z',
          lastHeartbeat: '2026-10-24T11:59:00.000Z',
          workerPid: 7,
        },
      ],
      gantt: null,
    });
    const bar = wide.getByTestId('pulse-strip-inflight-line');
    assert.equal(bar.getAttribute('data-bar-height-px'), String(PULSE_IN_FLIGHT_BAR_HEIGHT_PX));
    assert.ok(PULSE_IN_FLIGHT_BAR_HEIGHT_PX >= 8, 'a bar must be at least 8 px tall');
    // Six hours of a 24 h window is wide enough to carry the id inside the bar…
    assert.match(bar.textContent ?? '', /task-wide/);
    // …and the accessible name always carries it.
    assert.match(bar.getAttribute('aria-label') ?? '', /task-wide/);
    wide.unmount();

    const narrow = renderStrip({
      inFlight: [
        {
          taskId: 'task-narrow',
          phase: 'implementing',
          startedAt: '2026-10-24T11:45:00.000Z',
          lastHeartbeat: '2026-10-24T11:59:00.000Z',
          workerPid: 8,
        },
      ],
      gantt: null,
    });
    const narrowBar = narrow.getByTestId('pulse-strip-inflight-line');
    assert.equal(narrowBar.textContent, '', 'a too-narrow bar draws no id');
    assert.match(narrowBar.getAttribute('aria-label') ?? '', /task-narrow/);
    narrow.unmount();

    const empty = renderStrip({ inFlight: [], gantt: null });
    assert.match(
      empty.getByTestId('pulse-strip-inflight-empty').textContent ?? '',
      /没有声明在途任务/,
    );
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
    assert.equal(getByTestId('pulse-strip').style.minHeight, `${PULSE_STRIP_HEIGHT_PX}px`);
    assert.equal(rowHeightSignature(), initialRows);
    // The 8:00 blocker predates the 6 h window ([06:00, 12:00] contains it, but the fan-in
    // attempts at 11:00/11:30 stay; the window changed the DATA, not the geometry).
    const sixHourMarks = getAllByTestId('pulse-strip-fanin-mark').length;
    assert.ok(sixHourMarks <= dayMarks, 'a narrower window cannot add records');

    fireEvent.click(getByTestId('pulse-strip-window-72'));
    assert.equal(getByTestId('pulse-strip').getAttribute('data-window-hours'), '72');
    assert.equal(getByTestId('pulse-strip').style.minHeight, `${PULSE_STRIP_HEIGHT_PX}px`);
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
    // expose a shape (the bar), so a reader who cannot see the hue can tell the rows apart.
    for (const line of getAllByTestId('pulse-strip-inflight-line')) {
      assert.equal(line.getAttribute('data-shape'), 'in-flight-bar');
      assert.match(line.className, /bg-(blue|violet|cyan|indigo)-600/);
    }
  });
});
