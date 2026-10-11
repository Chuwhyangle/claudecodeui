import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import React from 'react';
import { test } from 'vitest';

import type { QuayTimelineWindow } from '@/shared/types';
import TimelineBar, { type TimelineBarRange } from '@/modules/quay/TimelineBar';

const RANGES: TimelineBarRange[] = [
  { startMs: 1000, endMs: 1500, state: 'green', label: 'first' },
  { startMs: 2000, endMs: 2600, state: 'red', label: 'second' },
  { startMs: 3000, endMs: 3100, state: 'green', label: 'third' },
];

/** The window RANGES (`1000…3100`) is drawn through; its right edge is the `now` instant. */
const WINDOW: QuayTimelineWindow = { startMs: 1000, endMs: 4000 };

const rectsOf = (container: HTMLElement): Element[] =>
  Array.from(container.querySelectorAll('[data-testid="bar-rect"]'));

const xsOf = (container: HTMLElement): number[] =>
  rectsOf(container).map((rect) => Number(rect.getAttribute('x')));

test('TimelineBar renders one rect per range', () => {
  const { container } = render(<TimelineBar ranges={RANGES} window={WINDOW} emptyText="none" testId="bar" />);

  assert.equal(rectsOf(container).length, 3);
});

test('TimelineBar positions rects monotonically in time over the explicit window', () => {
  const { container } = render(<TimelineBar ranges={RANGES} window={WINDOW} emptyText="none" testId="bar" />);

  const xs = xsOf(container);
  // The first range starts exactly at the window start, so it sits at the plot origin; the rest
  // march right with time.
  assert.ok(
    xs.every((x, index) => index === 0 || x > xs[index - 1]!),
    `expected strictly increasing x, got ${xs.join(', ')}`,
  );
  assert.ok(xs[0]! >= 0 && xs[xs.length - 1]! <= 600, `x must stay inside the plot, got ${xs.join(', ')}`);
});

test('TimelineBar exposes each range as a native title tooltip', () => {
  const { container } = render(<TimelineBar ranges={RANGES} window={WINDOW} emptyText="none" testId="bar" />);

  const titles = Array.from(container.querySelectorAll('[data-testid="bar-rect"] title')).map((title) => title.textContent);
  assert.deepEqual(titles, ['first', 'second', 'third']);
});

test('TimelineBar gives a zero-length range a visible minimum width', () => {
  const { container } = render(
    <TimelineBar
      ranges={[
        { startMs: 1000, endMs: 1000, state: 'landed', label: 'instant' },
        { startMs: 5000, endMs: 5000, state: 'landed', label: 'instant-2' },
      ]}
      window={{ startMs: 1000, endMs: 6000 }}
      emptyText="none"
      testId="bar"
    />,
  );

  const rects = rectsOf(container);
  assert.equal(rects.length, 2);
  assert.ok(rects.every((rect) => Number(rect.getAttribute('width')) > 0));
});

test('TimelineBar renders the empty state when there are no ranges', () => {
  const { getByTestId, container } = render(
    <TimelineBar ranges={[]} window={WINDOW} emptyText="nothing here" testId="bar" />,
  );

  assert.match(getByTestId('bar-empty').textContent ?? '', /nothing here/);
  assert.equal(container.querySelector('[data-testid="bar-rect"]'), null);
});

/*
 * AC1 (gap-quay-tab-three-timelines-share-no-time-axis): the bar must map through the EXPLICIT
 * window, not through the extent of its own `ranges`. The two cases below are the falsifier: a
 * self-adaptive implementation (`windowStart = min(startMs)`, `windowEnd = max(endMs)`) makes the
 * x coordinates depend only on `ranges`, so it produces identical x under both windows and draws
 * the out-of-window records — both assertions go red.
 */
test('TimelineBar x is a function of the explicit window, not of the ranges’ own extent', () => {
  const spread = (window: QuayTimelineWindow): number => {
    const { container } = render(<TimelineBar ranges={RANGES} window={window} emptyText="none" testId="bar" />);
    const xs = xsOf(container);
    return xs[xs.length - 1]! - xs[0]!;
  };

  const narrow = spread({ startMs: 1000, endMs: 4000 });
  const wide = spread({ startMs: 1000, endMs: 10000 });

  // The same records over a 9h window are compressed relative to a 3h window. Under the old
  // self-adaptive code both windows would be `min(ranges)…max(ranges)` and the spreads equal.
  assert.ok(narrow > wide, `a wider window must compress the same records: narrow=${narrow} wide=${wide}`);
});

test('TimelineBar drops ranges outside the window and clamps the ones that straddle an edge', () => {
  const ranges: TimelineBarRange[] = [
    { startMs: 0, endMs: 500, state: 'green', label: 'before-window' },
    { startMs: 9000, endMs: 9100, state: 'red', label: 'after-window' },
    { startMs: 1000, endMs: 1500, state: 'green', label: 'inside-a' },
    { startMs: 3000, endMs: 3100, state: 'red', label: 'inside-b' },
    { startMs: 500, endMs: 1200, state: 'green', label: 'straddles-start' },
    { startMs: 3900, endMs: 5000, state: 'red', label: 'straddles-end' },
  ];
  const { container } = render(<TimelineBar ranges={ranges} window={WINDOW} emptyText="none" testId="bar" />);

  const titles = Array.from(container.querySelectorAll('[data-testid="bar-rect"] title')).map((title) => title.textContent);
  // The two wholly-outside records are gone; the four that touch the window (two inside, two
  // straddling an edge) remain, in the order the caller passed them.
  assert.deepEqual(titles, ['inside-a', 'inside-b', 'straddles-start', 'straddles-end']);
});

test('TimelineBar renders the empty state when every range falls outside the window', () => {
  const { getByTestId, container } = render(
    <TimelineBar
      ranges={[{ startMs: 9000, endMs: 9100, state: 'green', label: 'far-future' }]}
      window={WINDOW}
      emptyText="nothing in this window"
      testId="bar"
    />,
  );

  assert.match(getByTestId('bar-empty').textContent ?? '', /nothing in this window/);
  assert.equal(container.querySelector('[data-testid="bar-rect"]'), null);
});

/*
 * AC3 (gap-quay-tab-three-timelines-share-no-time-axis): the bar carries a readable axis — a
 * start and an end clock label and a `now` vertical line at the window's right edge.
 */
test('TimelineBar renders start/end clock labels and a now marker for the explicit window', () => {
  const { getByTestId } = render(<TimelineBar ranges={RANGES} window={WINDOW} emptyText="none" testId="bar" />);

  const start = getByTestId('bar-axis-start');
  const end = getByTestId('bar-axis-end');
  const now = getByTestId('bar-now');

  // The labels are non-empty local clock readings (e.g. `09:00`), matching the Loop pulse gantt's
  // own `toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })` format.
  assert.match(start.textContent ?? '', /\d{1,2}:\d{2}/);
  assert.match(end.textContent ?? '', /\d{1,2}:\d{2}/);
  // The now marker is a vertical line at the window's right edge and carries its instant as a title.
  assert.equal(now.tagName.toLowerCase(), 'line');
  assert.match(now.textContent ?? '', /\d{1,2}:\d{2}/);
});

test('TimelineBar exposes the shared window on the plot for cross-chart comparison', () => {
  const { getByTestId } = render(<TimelineBar ranges={RANGES} window={WINDOW} emptyText="none" testId="bar" />);

  const svg = getByTestId('bar');
  assert.equal(svg.getAttribute('data-window-start'), String(WINDOW.startMs));
  assert.equal(svg.getAttribute('data-window-end'), String(WINDOW.endMs));
});
