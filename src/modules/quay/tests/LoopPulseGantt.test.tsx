import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import React from 'react';
import { test } from 'vitest';

import type { QuayGanttInterval, QuayGanttLanes } from '@/shared/types';
import LoopPulseGantt, { GANTT_LANES } from '@/modules/quay/LoopPulseGantt';

/**
 * The gantt card renders quay's *packed* lanes; it does not pack anything itself. These
 * cases therefore drive it with hand-built lane arrays that already look like
 * `packLanes` output, and assert what the card owes a reader: five lanes are always
 * drawn, the overflow count is visible rather than swallowed, every distinct state gets a
 * distinct colour, and each bar states its own run in a tooltip.
 *
 * The packing/merging semantics (greedy lane reuse, window filtering, cross-source dedup)
 * live in quay and are NOT re-tested here — reimplementing them to test them would be the
 * second implementation this card exists to avoid.
 */

const NOW_MS = Date.UTC(2026, 9, 20, 12, 0, 0);
const HOUR_MS = 3_600_000;

/** An interval `hoursAgo` long, ending `hoursAgo` before `now`. */
function interval(
  taskId: string,
  startsHoursAgo: number,
  lastsHours: number,
  state: { phase?: string | null; finalState?: string | null; fanInOutcome?: string | null } = {},
): QuayGanttInterval {
  const startMs = NOW_MS - startsHoursAgo * HOUR_MS;
  return {
    taskId,
    runId: `worker-${taskId}`,
    startMs,
    endMs: startMs + lastsHours * HOUR_MS,
    phase: state.phase ?? null,
    finalState: state.finalState ?? null,
    fanInOutcome: state.fanInOutcome ?? null,
  };
}

const gantt = (lanes: QuayGanttInterval[][], overflow = 0, windowHours = 3): QuayGanttLanes => ({
  windowHours,
  nowMs: NOW_MS,
  lanes,
  overflow,
});

const barsOf = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[data-testid="quay-gantt-bar"]'));

/* ── the fixed five-lane contract ─────────────────────────────────────────────── */

test('every state of the gantt draws the full five-lane guide set, even when the board is quiet', () => {
  const { container } = render(<LoopPulseGantt gantt={gantt([[interval('a', 2, 1, { phase: 'implementing' })]])} />);

  // Five guide lines regardless of how many lanes are occupied: the fixed lane count is the
  // card's visual contract, so a one-run window must not collapse to a one-lane chart.
  assert.equal(container.querySelectorAll('[data-testid="quay-gantt-lane"]').length, GANTT_LANES);
  assert.equal(GANTT_LANES, 5);
});

test('a bar carries its lane index, so a lane assignment is a readable fact and not just a y coordinate', () => {
  const { container } = render(
    <LoopPulseGantt
      gantt={gantt([
        [interval('lane-0-task', 2, 1, { phase: 'implementing' })],
        [interval('lane-1-task', 2, 1, { phase: 'fan-in' })],
      ])}
    />,
  );

  const lanes = barsOf(container).map((bar) => bar.getAttribute('data-lane'));
  assert.deepEqual(lanes, ['0', '1']);
});

/* ── overflow is data, not decoration ─────────────────────────────────────────── */

test('overflow is rendered as a visible count instead of being swallowed by the lane cap', () => {
  const { container, getByTestId } = render(<LoopPulseGantt gantt={gantt([[interval('a', 2, 1, { phase: 'implementing' })]], 7)} />);

  // packLanes drops the intervals that had no free lane, so `lanes` alone does not account
  // for the window whenever this is non-zero. Losing that count would silently lose runs.
  assert.equal(getByTestId('quay-gantt-overflow').textContent, '+7 more');
  assert.equal(barsOf(container).length, 1);
});

test('no overflow badge is drawn when nothing overflowed', () => {
  const { queryByTestId } = render(<LoopPulseGantt gantt={gantt([[interval('a', 2, 1, { phase: 'implementing' })]], 0)} />);

  assert.equal(queryByTestId('quay-gantt-overflow'), null);
});

test('a lane set emptied while its overflow survives still reports the dropped runs, never "nothing ran"', () => {
  // The falsifying payload for the whole read: `lanes` says the board is quiet, `overflow`
  // says runs were dropped for want of a free lane. Trusting `lanes` alone renders the empty
  // line — a claim that nothing ran, contradicted by the very same document. The overflow
  // count must win, because it is the only field that still accounts for those runs.
  const { getByTestId, queryByTestId } = render(<LoopPulseGantt gantt={gantt([], 3, 6)} />);

  assert.equal(getByTestId('quay-gantt-overflow').textContent, '+3 more');
  assert.equal(queryByTestId('quay-gantt-empty'), null);
});

/* ── state colouring ──────────────────────────────────────────────────────────── */

test('every distinct state renders a distinct colour class', () => {
  const states: Array<{ phase?: string; finalState?: string }> = [
    { phase: 'implementing' },
    { phase: 'fan-in' },
    { phase: 'awaiting-land' },
    { phase: 'landed' },
    { finalState: 'completed' },
    { finalState: 'failed' },
    { finalState: 'killed' },
    { finalState: 'timed-out' },
    { finalState: 'exited-not-landed' },
  ];

  const { container } = render(
    <LoopPulseGantt
      gantt={gantt([states.map((state, index) => interval(`task-${index}`, 2 - index * 0.1, 0.05, state))])}
    />,
  );

  const rendered = barsOf(container).map((bar) => ({ state: bar.getAttribute('data-state'), cls: bar.getAttribute('class') }));
  assert.equal(rendered.length, states.length);

  // The state vocabulary arrived intact, and no two states collapsed onto one colour —
  // a shared colour would make a failed run indistinguishable from a timed-out one.
  const classes = rendered.map((entry) => entry.cls);
  assert.equal(new Set(classes).size, classes.length, `two states share a colour class: ${JSON.stringify(rendered)}`);
  for (const entry of rendered) {
    assert.ok(entry.cls && entry.cls.length > 0, `state ${entry.state} rendered with no colour class`);
  }
});

test('an interval with neither phase nor final state still renders, under an explicit unknown state', () => {
  // The kernel type allows both sides null. Dropping such an interval would hide a real run.
  const { container } = render(<LoopPulseGantt gantt={gantt([[interval('mystery', 2, 1)]])} />);

  const bar = barsOf(container)[0];
  assert.ok(bar, 'the interval must render');
  assert.equal(bar.getAttribute('data-state'), 'unknown');
});

/* ── tooltips state the run ───────────────────────────────────────────────────── */

test('each bar states its own run in a tooltip: task, state, duration and both endpoints', () => {
  const { container } = render(<LoopPulseGantt gantt={gantt([[interval('gap-some-task', 2, 1, { phase: 'implementing' })]])} />);

  const title = barsOf(container)[0]?.querySelector('title')?.textContent ?? '';
  const startMs = NOW_MS - 2 * HOUR_MS;
  assert.ok(title.includes('gap-some-task'), `tooltip must name the task: ${title}`);
  assert.ok(title.includes('implementing'), `tooltip must state the state: ${title}`);
  assert.ok(title.includes('1h 0m'), `tooltip must state the duration: ${title}`);
  assert.ok(title.includes(new Date(startMs).toISOString()), `tooltip must state the start: ${title}`);
  assert.ok(title.includes(new Date(startMs + HOUR_MS).toISOString()), `tooltip must state the end: ${title}`);
});

/* ── the time window ──────────────────────────────────────────────────────────── */

test('the window selector reports the requested window and marks the active one', () => {
  const requested: number[] = [];
  const { getByTestId } = render(
    <LoopPulseGantt
      gantt={gantt([[interval('a', 2, 1, { phase: 'implementing' })]], 0, 3)}
      onWindowChange={(hours) => requested.push(hours)}
    />,
  );

  assert.equal(getByTestId('quay-gantt-window-3').getAttribute('aria-pressed'), 'true');
  assert.equal(getByTestId('quay-gantt-window-1').getAttribute('aria-pressed'), 'false');

  getByTestId('quay-gantt-window-12').click();
  assert.deepEqual(requested, [12]);
});

test('no window selector is rendered when the host cannot honour a window change', () => {
  // A control that visibly does nothing is worse than no control: the card only offers the
  // selector once a caller can actually re-filter the intervals behind it.
  const { queryByTestId } = render(<LoopPulseGantt gantt={gantt([[interval('a', 2, 1, { phase: 'implementing' })]])} />);

  assert.equal(queryByTestId('quay-gantt-windows'), null);
});

test('with no lane reading the selector stays mounted but inert, under a stated reason', () => {
  // The selector owns the window whose re-read produced (or failed to produce) this reading,
  // so it must survive that reading — even the unreadable one. Rendering it inert keeps the
  // offered windows and the selected one visible; hiding it would drop the control along with
  // the chart. The reason is stated, and it is NOT the empty line: "nothing ran" is a reading
  // this card does not have.
  const requested: number[] = [];
  const { getByTestId, queryByTestId } = render(
    <LoopPulseGantt gantt={null} windowHours={6} onWindowChange={(hours) => requested.push(hours)} />,
  );

  assert.ok(getByTestId('quay-gantt-windows'), 'an unreadable lane set must not take the selector down');

  // Inert: every button is disabled, and a click is not honoured.
  for (const hours of [1, 3, 6, 12]) {
    const button = getByTestId(`quay-gantt-window-${hours}`) as HTMLButtonElement;
    assert.equal(button.disabled, true, `${hours}h must be disabled while there is no reading`);
  }
  (getByTestId('quay-gantt-window-12') as HTMLButtonElement).click();
  assert.deepEqual(requested, [], 'a disabled selector must not report a window change');

  // With no reading to mark the active window, the requested one is shown as selected.
  assert.equal(getByTestId('quay-gantt-window-6').getAttribute('aria-pressed'), 'true');

  assert.match(getByTestId('quay-gantt-unavailable-reason').textContent ?? '', /unavailable/i);
  assert.equal(queryByTestId('quay-gantt-empty'), null);
  assert.equal(queryByTestId('quay-gantt-svg'), null);
});

test('the two ways a lane reading can go missing render two different, non-empty reasons', () => {
  // "The installed plugin has no `lanes` verb" and "the verb ran but its document was
  // unreadable" are different facts — the first calls for an upgrade, the second for a retry.
  // Collapsing them into one sentence would tell the reader nothing about which applies.
  // Each render is queried through its own container: two `render`s in one case share the
  // document, so the shared `document`-scoped queries would find both cards.
  const reasonText = (container: HTMLElement) =>
    container.querySelector('[data-testid="quay-gantt-unavailable-reason"]')?.textContent ?? '';

  const { container: verbContainer } = render(
    <LoopPulseGantt gantt={null} onWindowChange={() => {}} unavailableReason="plugin-lacks-lanes-verb" />,
  );
  const { container: readContainer } = render(
    <LoopPulseGantt gantt={null} onWindowChange={() => {}} unavailableReason="lanes-read-failed" />,
  );

  const upgrade = reasonText(verbContainer);
  const retry = reasonText(readContainer);
  assert.ok(upgrade.length > 0 && retry.length > 0, 'each reason must say something');
  assert.notEqual(upgrade, retry, 'a missing verb and a failed read must not share one sentence');

  // An empty lane set is a NORMAL reading of an idle window, not an unavailability: it must
  // render the window-scoped empty line and must NOT render the unavailable reason.
  const { container: emptyContainer } = render(
    <LoopPulseGantt gantt={gantt([], 0, 3)} onWindowChange={() => {}} unavailableReason="lanes-read-failed" />,
  );
  assert.match(emptyContainer.querySelector('[data-testid="quay-gantt-empty"]')?.textContent ?? '', /No runs/);
  assert.equal(emptyContainer.querySelector('[data-testid="quay-gantt-unavailable-reason"]'), null);
});

/* ── empty vs. unread ─────────────────────────────────────────────────────────── */

test('an empty lane set renders a window-scoped empty line, not a blank chart', () => {
  const { getByTestId, queryByTestId } = render(<LoopPulseGantt gantt={gantt([], 0, 6)} />);

  assert.match(getByTestId('quay-gantt-empty').textContent ?? '', /last 6h/);
  assert.equal(queryByTestId('quay-gantt-svg'), null);
});

/* ── window clamping ──────────────────────────────────────────────────────────── */

test('an interval reaching outside the window is clamped to it rather than drawn off-canvas', () => {
  // A run that started three hours before a 1h window still begins at the left edge; an
  // unclamped x would place the bar outside the viewBox and hide the run entirely.
  const long = interval('long-runner', 10, 10, { phase: 'implementing' });
  const { container } = render(<LoopPulseGantt gantt={gantt([[long]], 0, 1)} />);

  const bar = barsOf(container)[0];
  assert.ok(bar, 'the clamped interval must still render');
  const x = Number(bar.getAttribute('x'));
  assert.ok(x >= 0 && x <= 600, `bar x must stay inside the plot, read ${x}`);
});
