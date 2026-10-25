import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { resetSessionActivityStore, useSessionActivity } from '@/modules/chat/hooks/useSessionActivity';
import { fetchSessionActivity } from '@/shared/api';
import type * as SharedApi from '@/shared/api';
import WebSocketContext from '@/shared/context/WebSocketContext';
import type { ServerEvent } from '@/shared/types';

/**
 * The activity join read is a fallback, not a mount-time guarantee.
 *
 * The server births a session in its activity store on `activity.subscribe` and answers the
 * REST snapshot route with 404 for every session it has not been told about. The hook used to
 * fire that read on mount, before the socket had subscribed — a guaranteed 404 on every cold
 * page (any server restart), logged by the browser as a failed resource and discarded by the
 * client. These cases pin the replacement ordering:
 *
 *   (1) a connected socket is the anchor: the join read is never issued;
 *   (2) a socket that never connects falls back to the read only after the grace window;
 *   (3) a socket that connects inside that window cancels the fallback — the case that keeps
 *       the common path free of the request.
 */

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApi>();
  return { ...actual, fetchSessionActivity: vi.fn(async () => null) };
});

const SESSION_ID = 'session-join-read';

/** The grace window the hook waits out before falling back; kept in sync with its constant. */
const GRACE_MS = 2_000;

/** One stand-in for the socket context the hook reads; `isConnected` is mutable per case. */
type Connection = {
  ws: null;
  sendMessage: (message: unknown) => void;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  isConnected: boolean;
};

function makeConnection(isConnected: boolean): Connection {
  return {
    ws: null,
    sendMessage: vi.fn(),
    subscribe: () => () => {},
    isConnected,
  };
}

/**
 * A wrapper component whose identity is stable for one case, so re-rendering the hook does not
 * remount it. Mutating `connection.isConnected` and re-rendering is how the hook observes a
 * socket that comes up mid-window.
 */
function makeWrapper(connection: Connection) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(WebSocketContext.Provider, { value: connection }, children);
  };
}

const joinReadCalls = (): number => vi.mocked(fetchSessionActivity).mock.calls.length;

beforeEach(() => {
  resetSessionActivityStore();
  vi.mocked(fetchSessionActivity).mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test('a connected socket is the anchor: the join read is never issued', async () => {
  const connection = makeConnection(true);

  renderHook(() => useSessionActivity(SESSION_ID), { wrapper: makeWrapper(connection) });

  await act(async () => {
    await vi.advanceTimersByTimeAsync(GRACE_MS * 3);
  });

  assert.equal(
    joinReadCalls(),
    0,
    'a subscribed socket hands over the snapshot itself; the REST read must not be sent after it',
  );
});

test('a socket that never connects falls back to the join read after the grace window', async () => {
  const connection = makeConnection(false);

  renderHook(() => useSessionActivity(SESSION_ID), { wrapper: makeWrapper(connection) });

  await act(async () => {
    await vi.advanceTimersByTimeAsync(GRACE_MS - 100);
  });
  assert.equal(joinReadCalls(), 0, 'the read must wait for the socket instead of asking on mount');

  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  assert.equal(joinReadCalls(), 1, 'a socket that stayed down leaves the REST snapshot as the only anchor');
});

test('a socket that connects inside the window cancels the fallback read', async () => {
  const connection = makeConnection(false);

  const { rerender } = renderHook(() => useSessionActivity(SESSION_ID), {
    wrapper: makeWrapper(connection),
  });

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });

  connection.isConnected = true;
  rerender();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
  });

  assert.equal(
    joinReadCalls(),
    0,
    'a socket that comes up inside the grace window must cancel the pending read, not race it',
  );
});
