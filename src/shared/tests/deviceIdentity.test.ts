import assert from 'node:assert/strict';

import { act, cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { WebSocketProvider } from '@/shared/context/WebSocketContext';
import { getDeviceId, getTabId } from '@/shared/utils/deviceIdentity';
import { MCP_DEVICE_NAME_STORAGE_KEY } from '@/shared/userSettings';
import type { UiHelloFrame } from '@/shared/types';

/**
 * The device identity's two halves, and the one moment it is published.
 *
 * The utility half is about lifetimes: `deviceId` must outlive a reload and die
 * with the site's storage, `tabId` must outlive a reload of its own tab and be
 * distinct in another. The provider half is the wire contract: a `ui.hello`
 * frame goes out exactly once per connection — a reconnect is a new connection
 * and so announces itself again — carrying all three fields.
 */

/**
 * The session the provider is handed. The provider is deliberately auth-agnostic
 * (it receives this port from the application assembly point rather than reading
 * `useAuth`), so the test supplies the authenticated state directly. Nothing here
 * is about auth.
 */
const AUTH = { isLoading: false, token: 'test-token', user: { id: 1 } };

// The name is read from the shipped shared reader when the socket announces
// itself; pinning it in localStorage makes "the frame carries the device's name"
// an equality rather than a substring guess.
const DEVICE_NAME = 'Chrome · Linux';

/** A WebSocket stand-in that records what was sent and lets a test drive the handshake. */
class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  /** Test helper: the server accepts the handshake. */
  acceptHandshake(): void {
    this.onopen?.();
  }

  /** Test helper: the server drops the connection. */
  dropConnection(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  /** Every `ui.hello` this socket sent, parsed. */
  hellos(): UiHelloFrame[] {
    return this.sent
      .map((frame) => JSON.parse(frame) as { type?: string })
      .filter((frame) => frame.type === 'ui.hello') as UiHelloFrame[];
  }
}

/** An in-memory Storage, so a test can hand the code a second, different area. */
function createMemoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => {
      entries.delete(key);
    },
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
  } as Storage;
}

const latestSocket = (): FakeWebSocket => {
  const socket = FakeWebSocket.instances.at(-1);
  assert.ok(socket, 'the provider must have opened a socket');
  return socket;
};

beforeEach(() => {
  // Only the reconnect delay is faked: React's own scheduling (microtasks,
  // Date) must stay real or `render` cannot flush its effects.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('WebSocket', FakeWebSocket);
  FakeWebSocket.instances = [];
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(MCP_DEVICE_NAME_STORAGE_KEY, DEVICE_NAME);
});

afterEach(() => {
  // Unmount before the fake timers go away, so the provider's cleanup timer is
  // cleared on the clock that created it rather than a real one that happens to
  // share its numeric id.
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ------------------------------------------------------- the stored identity --

test('getDeviceId is stable while the storage survives and changes once it is cleared', () => {
  const first = getDeviceId();

  assert.equal(typeof first, 'string');
  assert.ok(first.length > 0);
  assert.equal(getDeviceId(), first, 'a second read in the same storage must return the same id');

  localStorage.clear();
  const afterClear = getDeviceId();

  assert.notEqual(afterClear, first, 'clearing site data must produce a new device id');
  assert.equal(getDeviceId(), afterClear, 'the replacement id is stable in turn');
});

test('getTabId is stable in one sessionStorage and differs in another', () => {
  const first = getTabId();

  assert.ok(first.length > 0);
  assert.equal(getTabId(), first, 'a second read in the same tab storage must return the same id');

  // A second tab of the same browser: its sessionStorage starts empty.
  vi.stubGlobal('sessionStorage', createMemoryStorage());
  const secondTab = getTabId();

  assert.notEqual(secondTab, first, 'another tab must not inherit the first tab’s id');
  assert.equal(getTabId(), secondTab, 'the second tab’s id is stable in turn');
});

test('an identifier is still produced, without throwing, when the storage area is unreachable', () => {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
  Object.defineProperty(window, 'sessionStorage', {
    configurable: true,
    get() {
      throw new Error('storage is blocked');
    },
  });

  try {
    const first = getTabId();
    assert.ok(first.length > 0);

    // The in-memory fallback is what keeps it stable while storage is out of reach.
    assert.equal(getTabId(), first);
  } finally {
    if (descriptor) {
      Object.defineProperty(window, 'sessionStorage', descriptor);
    }
  }
});

// --------------------------------------------------------- the hello frame --

test('each websocket connection announces the device exactly once, with both ids and the name', () => {
  render(React.createElement(WebSocketProvider, { auth: AUTH }));

  const first = latestSocket();
  assert.equal(first.hellos().length, 0, 'nothing is announced before the handshake completes');

  act(() => {
    first.acceptHandshake();
  });

  const announced = first.hellos();
  assert.equal(announced.length, 1, 'exactly one ui.hello per connection');
  assert.deepEqual(announced[0], {
    type: 'ui.hello',
    deviceId: getDeviceId(),
    tabId: getTabId(),
    deviceName: DEVICE_NAME,
  });
});

test('a reconnect announces the new connection once as well', () => {
  render(React.createElement(WebSocketProvider, { auth: AUTH }));

  const first = latestSocket();
  act(() => {
    first.acceptHandshake();
  });
  assert.equal(first.hellos().length, 1);

  // The server drops the socket; the provider waits out its reconnect delay and
  // opens a fresh one, which has to identify itself again — the server forgot
  // the identity with the connection.
  act(() => {
    first.dropConnection();
    vi.advanceTimersByTime(3000);
  });

  const second = latestSocket();
  assert.notEqual(second, first, 'the reconnect must be a new connection');

  act(() => {
    second.acceptHandshake();
  });

  assert.equal(second.hellos().length, 1, 'exactly one ui.hello on the reconnected socket');
  assert.equal(first.hellos().length, 1, 'the first socket is not re-announced');
  assert.equal(second.hellos()[0].deviceId, first.hellos()[0].deviceId, 'the device survives the reconnect');
});
