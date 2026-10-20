import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import type { MutableRefObject, RefObject } from 'react';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';

import { TERMINAL_INIT_DELAY_MS } from '@/shared/constants';
import type { Project } from '@/shared/types';
import { useShellTerminal } from '@/modules/shell/hooks/useShellTerminal';

/**
 * The terminal fits itself and reports its dimensions on two paths: once when
 * the terminal finishes opening, and again — debounced — whenever the container
 * is resized. Both paths now go through one `fitAndSendResize` helper, so this
 * file watches what the helper actually does (`fit()` plus a `resize` message)
 * and asserts each path drives it exactly once.
 *
 * A regression that inlines the ResizeObserver path again still fits and sends
 * once per path, so this file alone cannot tell the two shapes apart; the
 * duplicate-call-site criterion (`grep -c 'fitAddon.fit()'` = 1) owns that
 * reading. What this file owns is that neither path is lost while the call
 * sites are being merged.
 */

// The hook debounces ResizeObserver callbacks by this much (private to the
// hook), and waits TERMINAL_INIT_DELAY_MS before its first fit.
const RESIZE_DEBOUNCE_MS = 50;

const harness = vi.hoisted(() => {
  const fit = vi.fn();
  const sendSocketMessage = vi.fn();
  const resizeObservers: Array<{ callback: ResizeObserverCallback }> = [];

  class FakeTerminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    loadAddon() {}
    open() {}
    refresh() {}
    onData() {
      return { dispose() {} };
    }
    attachCustomKeyEventHandler() {
      return true;
    }
    getSelection() {
      return '';
    }
    hasSelection() {
      return false;
    }
    dispose() {}
    clear() {}
    write() {}
  }

  class FakeFitAddon {
    fit = fit;
  }

  class FakeResizeObserver {
    callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      resizeObservers.push(this);
    }

    observe() {}
    unobserve() {}
    disconnect() {}
  }

  return { fit, sendSocketMessage, resizeObservers, FakeTerminal, FakeFitAddon, FakeResizeObserver };
});

vi.mock('@xterm/xterm', () => ({ Terminal: harness.FakeTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: harness.FakeFitAddon }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {} }));
vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: class {} }));
vi.mock('@/modules/shell/utils/socket', () => ({
  sendSocketMessage: harness.sendSocketMessage,
}));
vi.mock('@/modules/shell/utils/mobileTerminalSelection', () => ({
  installMobileTerminalSelection: () => ({ dispose() {} }),
}));
vi.mock('@/modules/shell/utils/terminalStyles', () => ({
  ensureXtermFocusStyles: () => {},
}));

const resizeMessageCount = () =>
  harness.sendSocketMessage.mock.calls.filter(([, message]) => message.type === 'resize').length;

const mountTerminal = () => {
  const container = document.createElement('div');
  document.body.appendChild(container);

  const terminalContainerRef: RefObject<HTMLDivElement> = { current: container };
  const terminalRef: MutableRefObject<Terminal | null> = { current: null };
  const fitAddonRef: MutableRefObject<FitAddon | null> = { current: null };
  const wsRef: MutableRefObject<WebSocket | null> = { current: null };
  // Stable identity: an inline callback would make the hook's effect tear down
  // and rebuild the terminal on every render (e.g. when `isInitialized` flips).
  const closeSocket = () => {};

  const view = renderHook(() =>
    useShellTerminal({
      terminalContainerRef,
      terminalRef,
      fitAddonRef,
      wsRef,
      selectedProject: {
        projectId: 'project-a',
        displayName: 'project-a',
        fullPath: '/tmp/project-a',
      } satisfies Project,
      minimal: true,
      isRestarting: false,
      closeSocket,
    }),
  );

  return { ...view, container };
};

describe('useShellTerminal resize paths', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    harness.fit.mockClear();
    harness.sendSocketMessage.mockClear();
    harness.resizeObservers.length = 0;
    vi.stubGlobal('ResizeObserver', harness.FakeResizeObserver);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('the startup path and the ResizeObserver path each fit and send resize once', () => {
    const { container, unmount } = mountTerminal();

    assert.equal(harness.resizeObservers.length, 1);
    const observer = harness.resizeObservers[0];

    act(() => {
      vi.advanceTimersByTime(TERMINAL_INIT_DELAY_MS);
    });

    const startupFitCalls = harness.fit.mock.calls.length;
    const startupResizeMessages = resizeMessageCount();
    console.log(
      `[useShellTerminalResize] startup path: fit calls=${startupFitCalls}, resize messages=${startupResizeMessages}`,
    );
    assert.equal(startupFitCalls, 1, 'startup path must fit exactly once');
    assert.equal(startupResizeMessages, 1, 'startup path must send exactly one resize');

    act(() => {
      observer.callback([], observer as unknown as ResizeObserver);
      vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS);
    });

    const resizeFitCalls = harness.fit.mock.calls.length - startupFitCalls;
    const resizeResizeMessages = resizeMessageCount() - startupResizeMessages;
    console.log(
      `[useShellTerminalResize] ResizeObserver path: fit calls=${resizeFitCalls}, resize messages=${resizeResizeMessages}`,
    );
    assert.equal(resizeFitCalls, 1, 'ResizeObserver path must fit exactly once');
    assert.equal(resizeResizeMessages, 1, 'ResizeObserver path must send exactly one resize');
    assert.equal(harness.fit.mock.calls.length, 2);

    unmount();
    container.remove();
  });
});
