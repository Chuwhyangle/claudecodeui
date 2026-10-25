import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import React from 'react';
import { describe, test, vi } from 'vitest';

import type {
  QuayBlockerSummary,
  QuayFanInAttemptSummary,
  QuayGanttLanes,
  QuayInFlightTask,
} from '@/shared/types';
import {
  LOOP_PULSE_PLOT_HEIGHT,
  PLOT_WIDTH,
  TIMELINE_PLOT_HEIGHT,
} from '@/modules/quay/chartGeometry';
import PulseStrip, {
  DEFAULT_PULSE_WINDOW_HOURS,
  PULSE_STRIP_HEIGHT_PX,
} from '@/modules/quay/PulseStrip';

/**
 * The fixture is ONE project at one instant, so every assertion below reads the same clock:
 * `generatedAt` is the strip's `now` and nothing calls `Date.now()`.
 *
 *   loop pulse  task-live (implementing) over the last hour of a 24 h window
 *   suite       round 1 green 10 s, round 2 red 30 s
 *   fan-in      landed, red, exited-not-landed — all inside the window
 *   blocked     one live signature (retained on the props, deliberately not drawn)
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

const TEST_ROUNDS = {
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
};

function renderStrip(overrides: Partial<React.ComponentProps<typeof PulseStrip>> = {}) {
  return render(
    <PulseStrip
      inFlight={IN_FLIGHT}
      gantt={GANTT}
      tests={TEST_ROUNDS}
      fanIn={{ recent: FAN_IN }}
      blockers={BLOCKERS}
      generatedAt={GENERATED_AT}
      {...overrides}
    />,
  );
}

/** The width declared by an SVG element's `viewBox` attribute. */
function viewBoxWidth(element: Element): number {
  const parts = (element.getAttribute('viewBox') ?? '').trim().split(/\s+/);
  return Number(parts[2]);
}

/** The alignment predicate: every chart must be drawn at the one shared plot width. */
function assertSharedPlotWidth(widths: number[], shared: number): void {
  for (const width of widths) {
    assert.equal(width, shared, 'every stacked chart must be drawn at the shared PLOT_WIDTH');
  }
}

/**
 * AC: the strip composes the three existing charts — they are vertical siblings of one parent,
 * expose the same window endpoints, and each viewBox is the shared width. The negative control is
 * the predicate itself: handed an independent width for one chart, it must throw.
 */
describe('composes the three existing charts, aligned', () => {
  test('the three charts are siblings of one parent over one window and one plot width', () => {
    const { getByTestId } = renderStrip();
    const strip = getByTestId('pulse-strip');

    const ganttRoot = getByTestId('quay-gantt');
    const ganttSvg = getByTestId('quay-gantt-svg');
    const testsSvg = getByTestId('pulse-strip-tests');
    const fanInSvg = getByTestId('pulse-strip-fanin');

    // (a) Vertical siblings of the SAME parent: the three rendered chart roots sit directly in
    // the strip container, in one column.
    for (const node of [ganttRoot, testsSvg, fanInSvg]) {
      assert.equal(node.parentElement, strip, `chart must be a direct child of the strip: ${node.getAttribute('data-testid')}`);
    }

    // (b) One window, read from the charts themselves rather than from the strip's own data.
    const start = ganttSvg.getAttribute('data-window-start');
    const end = ganttSvg.getAttribute('data-window-end');
    assert.ok(start !== null && end !== null, 'the gantt must expose its window endpoints');
    assert.equal(Number(end) - Number(start), DEFAULT_PULSE_WINDOW_HOURS * 3_600_000);
    for (const svg of [testsSvg, fanInSvg]) {
      assert.equal(svg.getAttribute('data-window-start'), start);
      assert.equal(svg.getAttribute('data-window-end'), end);
    }

    // (c) One plot width, from the shared geometry constant — not three coincidentally equal
    // literals.
    const widths = [ganttSvg, testsSvg, fanInSvg].map(viewBoxWidth);
    assert.deepEqual(widths, [PLOT_WIDTH, PLOT_WIDTH, PLOT_WIDTH]);
    assertSharedPlotWidth(widths, PLOT_WIDTH);

    // Negative control: if one chart were drawn at an independent width, the same predicate reds.
    assert.throws(() => assertSharedPlotWidth([PLOT_WIDTH, PLOT_WIDTH, PLOT_WIDTH + 1], PLOT_WIDTH));
  });

  test('the first chart renders the real Lane set bars and both bars render their records', () => {
    const { getByTestId, getAllByTestId } = renderStrip();

    assert.ok(getByTestId('quay-gantt-svg'), 'Loop pulse uses LoopPulseGantt, not an empty state');
    assert.equal(getAllByTestId('quay-gantt-bar').length, 1);
    assert.equal(getAllByTestId('pulse-strip-tests-rect').length, 2);
    assert.equal(getAllByTestId('pulse-strip-fanin-rect').length, FAN_IN.length);
  });
});

describe('no self-made encoding', () => {
  test('the strip draws no window control, axis, legend, glyph or blocker row of its own', () => {
    const { getByTestId, queryByTestId, queryByText } = renderStrip();
    const strip = getByTestId('pulse-strip');

    assert.equal(queryByTestId('pulse-strip-windows'), null, 'the strip owns no window selector');
    assert.equal(queryByTestId('quay-gantt-windows'), null, 'no selector without a host that can honour it');
    assert.equal(queryByTestId('pulse-strip-axis'), null, 'the strip owns no axis of its own');
    assert.equal(queryByTestId('pulse-strip-legend'), null, 'no legend of its own');
    assert.doesNotMatch(strip.textContent ?? '', /[✕⛔]/, 'no crossed/blocked glyph is drawn');

    // The blockers prop is retained (the caller still passes it) but deliberately unrendered:
    // none of the three existing charts has a blocker mark.
    assert.equal(queryByTestId('pulse-strip-blocker-segment'), null);
    assert.equal(queryByTestId('pulse-strip-blocker-impact'), null);
    assert.equal(queryByText(/AC 未全勾/, { exact: false }), null);
  });

  test('the existing charts’ marks are not clickable, so onFocusTask is never invoked', () => {
    const onFocusTask = vi.fn();
    const { getByTestId, getAllByTestId } = renderStrip({ onFocusTask });

    fireEvent.click(getByTestId('quay-gantt-bar'));
    fireEvent.click(getAllByTestId('pulse-strip-tests-rect')[0]);
    fireEvent.click(getAllByTestId('pulse-strip-fanin-rect')[0]);

    assert.equal(onFocusTask.mock.calls.length, 0, 'the interface is retained but not wired during the experiment');
  });

  test('a host that can re-read the lanes still gets the gantt’s existing selector', () => {
    const { getByTestId } = renderStrip({ onWindowChange: () => {} });
    assert.ok(getByTestId('quay-gantt-windows'));
  });
});

describe('windows and height', () => {
  test('the strip height is the sum of the three chart heights, exposed as a floor', () => {
    const { getByTestId } = renderStrip();
    const strip = getByTestId('pulse-strip');

    assert.equal(PULSE_STRIP_HEIGHT_PX, LOOP_PULSE_PLOT_HEIGHT + 2 * TIMELINE_PLOT_HEIGHT);
    assert.equal(strip.getAttribute('data-height-px'), String(PULSE_STRIP_HEIGHT_PX));
    assert.equal(strip.style.minHeight, `${PULSE_STRIP_HEIGHT_PX}px`);
  });

  test('without a lane reading the bars fall back to the requested window and the reading clock', () => {
    const { getByTestId } = renderStrip({
      gantt: null,
      tests: { current: null, recentRounds: [] },
      fanIn: { recent: [] },
      windowHours: 6,
    });
    const strip = getByTestId('pulse-strip');

    assert.equal(strip.getAttribute('data-window-hours'), '6');
    assert.equal(Number(strip.getAttribute('data-window-end')), NOW_MS);
    assert.equal(Number(strip.getAttribute('data-window-start')), NOW_MS - 6 * 3_600_000);

    // Each chart states its own empty/unavailable reading instead of the strip inventing one.
    assert.ok(getByTestId('quay-gantt-unavailable-reason'));
    assert.ok(getByTestId('pulse-strip-tests-empty'));
    assert.ok(getByTestId('pulse-strip-fanin-empty'));
  });
});
