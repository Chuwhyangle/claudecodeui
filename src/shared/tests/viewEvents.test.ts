/**
 * AC1 — the frontend view-event tracker (`observation-p0-view-instrumentation-and-weekly-report`).
 *
 * The criterion drives the tracker directly over an injected clock and send function, so each
 * reading is deterministic:
 *   ① entering then leaving a session emits exactly ONE episode carrying its `dwellMs`;
 *   ② `visibilitychange` settles the episode and pauses the clock, and returning to the page
 *      resumes a new episode for the same target (hidden time is not dwell);
 *   ③ the batch threshold sends once at the threshold, and the interval flush sends what is left;
 *   ④ a disabled tracker never sends, even after the queue passes the threshold.
 *
 * Run directly:
 *   npx vitest run src/shared/tests/viewEvents.test.ts
 */
import { afterEach, describe, expect, test, vi } from 'vitest';

import { createViewEventTracker, type ViewEvent } from '@/shared/viewEvents';

/** A tracker over a manual clock and a recording sender. */
function makeTracker(overrides: Parameters<typeof createViewEventTracker>[0] = {}) {
  let clock = 1_000;
  const batches: ViewEvent[][] = [];
  const tracker = createViewEventTracker({
    enabled: true,
    batchSize: 50,
    flushIntervalMs: 30_000,
    now: () => clock,
    deviceId: () => 'device-test',
    send: async (events: ViewEvent[]) => {
      batches.push(events);
      return true;
    },
    ...overrides,
  });
  return {
    tracker,
    batches,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('view event tracking', () => {
  test('entering and leaving a session emits one episode with dwellMs and its source', async () => {
    const { tracker, batches, advance } = makeTracker();

    tracker.view('session', 'session-a');
    advance(1_500);
    tracker.view('tab', 'quay');
    await tracker.flush();

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(batches[0][0]).toEqual({
      at: 2_500,
      kind: 'session',
      target: 'session-a',
      fromTarget: null,
      dwellMs: 1_500,
      deviceId: 'device-test',
    });
    // The episode now being viewed (the Quay tab) is not emitted until it is left.
    expect(tracker.queued()).toBe(0);
  });

  test('repeating the same target does not split the episode', async () => {
    const { tracker, batches, advance } = makeTracker();

    tracker.view('session', 'session-a');
    advance(700);
    tracker.view('session', 'session-a');
    advance(300);
    tracker.view('tab', 'architecture');
    await tracker.flush();

    expect(batches[0]).toHaveLength(1);
    expect(batches[0][0]).toMatchObject({ target: 'session-a', dwellMs: 1_000 });
  });

  test('visibilitychange settles the episode, pauses the clock, and resumes on return', async () => {
    vi.useFakeTimers();
    let hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    const { tracker, batches, advance } = makeTracker();
    const detach = tracker.attach();

    tracker.view('session', 'session-a');
    advance(1_000);
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    await tracker.flush();

    expect(batches.flat()).toHaveLength(1);
    expect(batches.flat()[0]).toMatchObject({ target: 'session-a', dwellMs: 1_000 });

    // Ten minutes behind a hidden page is not observation time.
    advance(600_000);
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    advance(2_000);
    tracker.view('tab', 'quay');
    advance(500);
    tracker.view('tab', 'architecture');
    await tracker.flush();

    expect(batches.flat().map((event) => [event.target, event.dwellMs])).toEqual([
      ['session-a', 1_000],
      ['session-a', 2_000],
      ['quay', 500],
    ]);
    detach();
  });

  test('the batch threshold sends once, and the flush interval sends the remainder', async () => {
    vi.useFakeTimers();
    const { tracker, batches, advance } = makeTracker({ batchSize: 3 });
    const detach = tracker.attach();

    // Four transitions: the first three are settled into the queue, so the third one crosses
    // the threshold and sends exactly one batch of three.
    for (const target of ['t0', 't1', 't2', 't3']) {
      tracker.view('tab', target);
      advance(100);
    }
    await tracker.flush();
    expect(batches).toHaveLength(1);
    expect(batches[0].map((event) => event.target)).toEqual(['t0', 't1', 't2']);

    // The fourth episode is still open; settle it, then let the 30 s timer carry it out.
    tracker.view('tab', 't4');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(batches).toHaveLength(2);
    expect(batches[1].map((event) => event.target)).toEqual(['t3']);
    detach();
  });

  test('a disabled tracker never reports, even past the batch threshold', async () => {
    const { tracker, batches, advance } = makeTracker({ enabled: false, batchSize: 2 });

    tracker.view('session', 'session-a');
    advance(100);
    tracker.view('tab', 'quay');
    advance(100);
    tracker.view('tab', 'architecture');
    advance(100);
    tracker.hide();
    await tracker.flush();

    expect(batches).toHaveLength(0);
  });

  test('a failed send is requeued rather than dropped', async () => {
    let attempts = 0;
    const delivered: ViewEvent[][] = [];
    const tracker = createViewEventTracker({
      enabled: true,
      batchSize: 1,
      now: () => 5_000,
      deviceId: () => 'device-test',
      send: async (events) => {
        attempts += 1;
        if (attempts === 1) return false;
        delivered.push(events);
        return true;
      },
    });

    tracker.view('session', 'session-a');
    tracker.view('tab', 'quay');
    await tracker.flush();
    expect(attempts).toBe(1);
    expect(delivered).toHaveLength(0);

    await tracker.flush();
    expect(attempts).toBe(2);
    expect(delivered[0].map((event) => event.target)).toEqual(['session-a']);
  });
});
