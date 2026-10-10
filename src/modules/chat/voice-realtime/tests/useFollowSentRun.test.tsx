import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { useFollowSentRun } from '@/modules/chat/voice-realtime/useFollowSentRun';

/**
 * A delivered voice instruction opens a run no socket of this page is bound to, so the
 * pane has to keep re-reading the transcript until that run ends. These pin when it
 * reads, and — as importantly — when it stops.
 */

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const setup = (initial: { sessionId: string | null; isWorking: boolean }) => {
  const refresh = vi.fn();
  const hook = renderHook((props: { sessionId: string | null; isWorking: boolean }) => useFollowSentRun({ ...props, refresh }), {
    initialProps: initial,
  });
  return { refresh, ...hook };
};

describe('useFollowSentRun', () => {
  test('reads at once on delivery, then keeps reading while the session works', () => {
    const { result, refresh, rerender } = setup({ sessionId: 's', isWorking: false });
    act(() => result.current.follow());
    expect(refresh).toHaveBeenCalledTimes(1);
    rerender({ sessionId: 's', isWorking: true });
    act(() => vi.advanceTimersByTime(1_500 * 4));
    expect(refresh).toHaveBeenCalledTimes(5);
  });

  test('stops after the run ends, with one last read of the finished tail', () => {
    const { result, refresh, rerender } = setup({ sessionId: 's', isWorking: true });
    act(() => result.current.follow());
    act(() => vi.advanceTimersByTime(1_500));
    rerender({ sessionId: 's', isWorking: false });
    act(() => vi.advanceTimersByTime(1_500));
    const readsAtEnd = refresh.mock.calls.length;
    act(() => vi.advanceTimersByTime(30_000));
    expect(refresh.mock.calls.length).toBe(readsAtEnd);
    // The read that ended it was issued AFTER the run stopped, so it saw the final tail.
    expect(readsAtEnd).toBe(3);
  });

  test('gives up if the session never starts working (an instruction that opened no run)', () => {
    const { result, refresh } = setup({ sessionId: 's', isWorking: false });
    act(() => result.current.follow());
    act(() => vi.advanceTimersByTime(60_000));
    const reads = refresh.mock.calls.length;
    expect(reads).toBeGreaterThan(1);
    expect(reads).toBeLessThan(20);
    act(() => vi.advanceTimersByTime(60_000));
    expect(refresh.mock.calls.length).toBe(reads);
  });

  test('moving the pane to another session stops the reading', () => {
    const { result, refresh, rerender } = setup({ sessionId: 's', isWorking: true });
    act(() => result.current.follow());
    rerender({ sessionId: 'other', isWorking: true });
    const before = refresh.mock.calls.length;
    act(() => vi.advanceTimersByTime(10_000));
    expect(refresh.mock.calls.length).toBe(before);
  });

  test('unmounting leaves no poller behind', () => {
    const { result, refresh, unmount } = setup({ sessionId: 's', isWorking: true });
    act(() => result.current.follow());
    unmount();
    const before = refresh.mock.calls.length;
    act(() => vi.advanceTimersByTime(10_000));
    expect(refresh.mock.calls.length).toBe(before);
  });

  test('a second delivery while following restarts one loop rather than stacking two', () => {
    const { result, refresh, rerender } = setup({ sessionId: 's', isWorking: true });
    act(() => result.current.follow());
    act(() => vi.advanceTimersByTime(1_500));
    act(() => result.current.follow());
    rerender({ sessionId: 's', isWorking: true });
    const before = refresh.mock.calls.length;
    act(() => vi.advanceTimersByTime(1_500 * 3));
    expect(refresh.mock.calls.length - before).toBe(3);
  });

  test('with no session there is nothing to read', () => {
    const { result, refresh } = setup({ sessionId: null, isWorking: false });
    act(() => result.current.follow());
    act(() => vi.advanceTimersByTime(10_000));
    expect(refresh).not.toHaveBeenCalled();
  });
});
