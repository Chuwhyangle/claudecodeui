import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  installLogDrawerPort,
  isLogDrawerAvailable,
  openLogDrawer,
  type LogDrawerOpenFilter,
} from '@/shared/ports/log-drawer.port';

/**
 * The log-drawer port criterion.
 *
 * `chat-composer` and `settings` must be able to hide their "view logs" entry
 * when no drawer is mounted, and the host must be able to replace itself. This
 * is the install/open/uninstall contract, with no React.
 */
describe('log-drawer port', () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    while (disposers.length > 0) disposers.pop()?.();
    expect(isLogDrawerAvailable()).toBe(false);
  });

  it('(a) fails closed before any installation', () => {
    expect(isLogDrawerAvailable()).toBe(false);
    expect(openLogDrawer({ source: 'server' })).toBe(false);
  });

  it('(b) installs an opener, receives the filter, and opens', () => {
    const open = vi.fn(() => true);
    disposers.push(installLogDrawerPort(open));
    expect(isLogDrawerAvailable()).toBe(true);

    const filter: LogDrawerOpenFilter = {
      requestId: 'req-1234',
      source: 'reply-suggestions',
      since: '2026-11-18T09:59:00.000Z',
      feature: 'reply-suggestions',
    };
    expect(openLogDrawer(filter)).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(filter);
  });

  it('(c) a replacement wins, and disposing the old installer does not clear it', () => {
    const first = vi.fn(() => true);
    const second = vi.fn(() => false);
    const disposeFirst = installLogDrawerPort(first);
    const disposeSecond = installLogDrawerPort(second);

    expect(openLogDrawer({})).toBe(false);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();

    disposeFirst();
    expect(isLogDrawerAvailable()).toBe(true);

    disposers.push(disposeSecond);
    disposeSecond();
    expect(isLogDrawerAvailable()).toBe(false);
    expect(openLogDrawer({})).toBe(false);
  });

  it('(d) disposal restores the fail-closed answer', () => {
    const dispose = installLogDrawerPort(() => true);
    expect(isLogDrawerAvailable()).toBe(true);
    dispose();
    expect(isLogDrawerAvailable()).toBe(false);
    expect(openLogDrawer({})).toBe(false);
  });
});
