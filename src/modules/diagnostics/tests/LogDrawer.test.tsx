/**
 * The log-drawer presentation criterion.
 *
 * The drawer is presentational: these cases prove it renders a given snapshot,
 * forwards the user's events and owns the two visual properties the design
 * requires — a non-modal right panel on a wide screen, a full-screen sheet on a
 * phone — plus the Escape close and the "scroll to top pauses follow" rule.
 * The last case mounts `LogDrawerHost` and opens it through the shared port, so
 * the composer/settings entry points have a working end-to-end path without
 * importing the diagnostics module.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import enCommon from '@/modules/i18n/locales/en/common.json';
import { installLogDrawerPort, isLogDrawerAvailable, openLogDrawer } from '@/shared/ports/log-drawer.port';
import type { LogLine, LogSource } from '@/shared/types';
import LogDrawer, { type LogDrawerActions } from '@/modules/diagnostics/LogDrawer';
import LogDrawerHost from '@/modules/diagnostics/LogDrawerHost';
import type { LogDrawerApi, LogDrawerSnapshot } from '@/modules/diagnostics/logDrawerController';

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['common'],
  defaultNS: 'common',
  resources: { en: { common: enCommon } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

const LINE: LogLine = {
  at: '2026-11-18T10:00:00.000Z',
  level: 'error',
  source: 'reply-suggestions',
  text: '[reply-suggestions] outcome=error:http requestId=req-1 httpStatus=502',
};

const SOURCE: LogSource = { id: 'reply-suggestions', label: 'Reply suggestions', count: 1, lastAt: LINE.at };

function snapshot(overrides: Partial<LogDrawerSnapshot> = {}): LogDrawerSnapshot {
  return {
    open: true,
    filter: {},
    source: null,
    level: null,
    search: '',
    visibleLines: [LINE],
    retainedCount: 1,
    sources: [SOURCE],
    loading: false,
    error: null,
    truncated: false,
    window: { maxLines: 1000, maxBytes: 524288 },
    follow: true,
    limit: 100,
    canLoadEarlier: true,
    copyState: 'idle',
    lastLoadedAt: null,
    ...overrides,
  };
}

function actions(): LogDrawerActions {
  return {
    onClose: vi.fn(),
    onSource: vi.fn(),
    onLevel: vi.fn(),
    onSearch: vi.fn(),
    onFollow: vi.fn(),
    onLoadEarlier: vi.fn(),
    onCopy: vi.fn(),
    onRefresh: vi.fn(),
  };
}

afterEach(() => {
  // Host cases install the real port; make sure a failed case cannot leak it.
  const dispose = installLogDrawerPort(() => false);
  dispose();
});

describe('LogDrawer', () => {
  it('(a) renders the title, source tabs, level filter, retention note and lines', () => {
    const handlers = actions();
    const { container } = render(<LogDrawer snapshot={snapshot()} actions={handlers} />);

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Logs')).toBeTruthy();
    expect(screen.getByText(/Logs are kept only in the current process/)).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Reply suggestions' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'All' })).toBeTruthy();
    expect(screen.getByText(/requestId=req-1/)).toBeTruthy();
    expect(container.querySelector('[data-slot="log-level-filter"]')).toBeTruthy();
    expect(screen.queryByText('No logs in the last 15 minutes')).toBeNull();
  });

  it('(b) shows the empty state, the truncated note, the error and copy statuses', () => {
    const handlers = actions();
    const { rerender } = render(
      <LogDrawer snapshot={snapshot({ visibleLines: [], retainedCount: 0 })} actions={handlers} />,
    );
    expect(screen.getByText('No logs in the last 15 minutes')).toBeTruthy();

    rerender(
      <LogDrawer
        snapshot={snapshot({ truncated: true, error: 'logs request failed', copyState: 'copied' })}
        actions={handlers}
      />,
    );
    expect(screen.getByText(/Older lines were dropped/)).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('Copied')).toBeTruthy();
  });

  it('(c) the close button and Escape both forward onClose', () => {
    const handlers = actions();
    render(<LogDrawer snapshot={snapshot()} actions={handlers} />);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(handlers.onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(handlers.onClose).toHaveBeenCalledTimes(2);
  });

  it('(d) the follow toggle forwards the inverted value', () => {
    const handlers = actions();
    const { rerender } = render(<LogDrawer snapshot={snapshot()} actions={handlers} />);
    const button = screen.getByRole('button', { name: 'Follow' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button);
    expect(handlers.onFollow).toHaveBeenCalledWith(false);

    rerender(<LogDrawer snapshot={snapshot({ follow: false })} actions={actions()} />);
    expect(screen.getByRole('button', { name: 'Follow paused' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('(e) scrolling the list to the top pauses follow', () => {
    const handlers = actions();
    const { container } = render(<LogDrawer snapshot={snapshot()} actions={handlers} />);
    const list = container.querySelector('[data-slot="log-lines"]') as HTMLElement;
    expect(list).toBeTruthy();
    Object.defineProperty(list, 'scrollTop', { value: 0, writable: true, configurable: true });
    fireEvent.scroll(list);
    expect(handlers.onFollow).toHaveBeenCalledWith(false);
  });

  it('(f) "load earlier" is disabled at the ceiling and forwards while available', () => {
    const handlers = actions();
    const { rerender } = render(<LogDrawer snapshot={snapshot()} actions={handlers} />);
    const enabled = screen.getByRole('button', { name: 'Load earlier' }) as HTMLButtonElement;
    expect(enabled.disabled).toBe(false);
    fireEvent.click(enabled);
    expect(handlers.onLoadEarlier).toHaveBeenCalledTimes(1);

    rerender(<LogDrawer snapshot={snapshot({ limit: 500, canLoadEarlier: false })} actions={actions()} />);
    expect((screen.getByRole('button', { name: 'Load earlier' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('(g) the phone layout is a full-screen sheet and copy forwards onCopy', () => {
    const handlers = actions();
    const { container } = render(<LogDrawer snapshot={snapshot()} actions={handlers} />);
    const drawer = container.querySelector('[data-slot="log-drawer"]') as HTMLElement;
    expect(drawer.className).toContain('max-[480px]:inset-0');
    expect(drawer.className).toContain('pointer-coarse:inset-0');
    expect(drawer.className).toContain('max-w-md');

    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics bundle' }));
    expect(handlers.onCopy).toHaveBeenCalledTimes(1);
  });

  it('(h) the host installs the port and opens the drawer pre-filtered through it', async () => {
    const logApi: LogDrawerApi = {
      logs: vi.fn(async () => ({
        lines: [LINE], truncated: false, window: { maxLines: 1000, maxBytes: 524288 },
      })),
      logSources: vi.fn(async () => ({ sources: [SOURCE] })),
      bundle: vi.fn(async () => 'bundle'),
    };
    const { unmount } = render(
      <LogDrawerHost
        api={logApi}
        writeClipboard={async () => {}}
        pollIntervalMs={60_000}
      />,
    );

    await waitFor(() => expect(isLogDrawerAvailable()).toBe(true));
    expect(screen.queryByRole('dialog')).toBeNull();

    act(() => {
      expect(openLogDrawer({ requestId: 'req-1', source: 'reply-suggestions' })).toBe(true);
    });
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/requestId=req-1/)).toBeTruthy());

    unmount();
    await waitFor(() => expect(isLogDrawerAvailable()).toBe(false));
  });
});
