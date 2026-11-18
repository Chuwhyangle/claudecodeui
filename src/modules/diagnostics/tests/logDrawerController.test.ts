import assert from 'node:assert/strict';

import { describe, it, vi } from 'vitest';

import type { Clock, LogLine, LogLineLevel, LogSource, LogsResponse, LogSourcesResponse } from '@/shared/types';

import {
  createLogDrawerController,
  LOG_DRAWER_MAX_LINES,
  LOG_DRAWER_PAGE_SIZE,
  type LogDrawerApi,
} from '@/modules/diagnostics/logDrawerController';

/**
 * The log-drawer controller criterion.
 *
 * Reads the rules without React: a read starts only when the drawer opens and
 * stops when it closes, filters reach the API, the search is client-side, the
 * poller is the only recurring request, "load earlier" widens the request up to
 * the server ceiling, a failure is visible and keeps the previous window, and
 * the copy action reports success/failure without throwing.
 */

const LINE: LogLine = {
  at: '2026-11-18T10:00:00.000Z',
  level: 'error',
  source: 'reply-suggestions',
  text: '[reply-suggestions] outcome=error:http requestId=req-1 httpStatus=502',
};

const SOURCE: LogSource = {
  id: 'reply-suggestions',
  label: 'Reply suggestions',
  count: 1,
  lastAt: LINE.at,
};

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** The filter shape the controller passes to `logs`; named so mock call arguments are typed. */
type LogsQuery = { source?: string; level?: LogLineLevel; since?: string; limit?: number };

/** A clock whose intervals are fired by the criterion, never by wall time. */
function fakeClock(): Clock & { fireIntervals: () => void; activeIntervals: () => number } {
  const intervals = new Map<number, () => void>();
  let nextHandle = 1;
  return {
    now: () => Date.parse('2026-11-18T10:00:05.000Z'),
    setTimeout: (callback) => { callback(); return 0; },
    clearTimeout: () => {},
    setInterval: (callback) => {
      const handle = nextHandle++;
      intervals.set(handle, callback);
      return handle;
    },
    clearInterval: (handle) => { intervals.delete(handle as number); },
    fireIntervals: () => { for (const callback of [...intervals.values()]) callback(); },
    activeIntervals: () => intervals.size,
  };
}

function api(overrides: Partial<LogDrawerApi> = {}): LogDrawerApi {
  return {
    logs: vi.fn(async (_filter: LogsQuery): Promise<LogsResponse> => ({
      lines: [LINE],
      truncated: false,
      window: { maxLines: 1000, maxBytes: 524288 },
    })),
    logSources: vi.fn(async (): Promise<LogSourcesResponse> => ({ sources: [SOURCE] })),
    bundle: vi.fn(async () => 'Cloudpit diagnostics bundle'),
    ...overrides,
  };
}

describe('log-drawer controller', () => {
  it('(a) opens with a filter, reads once, and polls only while open', async () => {
    const clock = fakeClock();
    const logs = vi.fn(async (_filter: LogsQuery): Promise<LogsResponse> => ({
      lines: [LINE], truncated: false, window: { maxLines: 1000, maxBytes: 524288 },
    }));
    const controller = createLogDrawerController({
      api: api({ logs }),
      writeClipboard: async () => {},
      clock,
      pollIntervalMs: 1000,
      pageSize: 100,
    });
    assert.equal(controller.getSnapshot().open, false);

    controller.open({ requestId: 'req-1', source: 'reply-suggestions' });
    assert.equal(controller.getSnapshot().open, true);
    assert.equal(controller.getSnapshot().search, 'req-1', 'the requestId pre-fills the search');
    await flush();

    const opened = controller.getSnapshot();
    assert.equal(opened.loading, false);
    assert.equal(opened.error, null);
    assert.equal(logs.mock.calls.length, 1);
    assert.deepEqual(logs.mock.calls[0]?.[0], { source: 'reply-suggestions', limit: LOG_DRAWER_PAGE_SIZE });
    assert.equal(clock.activeIntervals(), 1, 'an open drawer polls');

    clock.fireIntervals();
    await flush();
    assert.equal(logs.mock.calls.length, 2, 'the interval performs another read');

    controller.close();
    assert.equal(clock.activeIntervals(), 0, 'closing stops the poller');
    clock.fireIntervals();
    await flush();
    assert.equal(logs.mock.calls.length, 2, 'a closed drawer performs no request');
    controller.dispose();
  });

  it('(b) source and level become server filters; search stays client-side', async () => {
    const clock = fakeClock();
    const logs = vi.fn(async (_filter: LogsQuery): Promise<LogsResponse> => ({
      lines: [LINE],
      truncated: false,
      window: { maxLines: 1000, maxBytes: 524288 },
    }));
    const controller = createLogDrawerController({
      api: api({ logs }),
      writeClipboard: async () => {},
      clock,
    });
    controller.open({ source: 'reply-suggestions', since: '2026-11-18T09:59:00.000Z' });
    await flush();

    controller.setLevel('error');
    await flush();
    assert.deepEqual(logs.mock.calls[1]?.[0], {
      source: 'reply-suggestions',
      level: 'error',
      since: '2026-11-18T09:59:00.000Z',
      limit: LOG_DRAWER_PAGE_SIZE,
    });

    const requestsBefore = logs.mock.calls.length;
    controller.setSearch('no-such-request');
    assert.equal(logs.mock.calls.length, requestsBefore, 'the search does not hit the server');
    assert.deepEqual(controller.getSnapshot().visibleLines, []);
    controller.setSearch('req-1');
    assert.equal(controller.getSnapshot().visibleLines.length, 1);
    controller.dispose();
  });

  it('(c) follow can be paused and is not re-enabled by a poll', async () => {
    const clock = fakeClock();
    const controller = createLogDrawerController({ api: api(), writeClipboard: async () => {}, clock });
    controller.open();
    await flush();
    assert.equal(controller.getSnapshot().follow, true);

    controller.setFollow(false);
    clock.fireIntervals();
    await flush();
    assert.equal(controller.getSnapshot().follow, false);
    controller.dispose();
  });

  it('(d) load earlier widens the request up to the 500-line ceiling', async () => {
    const clock = fakeClock();
    const logs = vi.fn(async (_filter: LogsQuery): Promise<LogsResponse> => ({
      lines: [LINE], truncated: false, window: { maxLines: 1000, maxBytes: 524288 },
    }));
    const controller = createLogDrawerController({ api: api({ logs }), writeClipboard: async () => {}, clock });
    controller.open();
    await flush();

    assert.equal(controller.getSnapshot().canLoadEarlier, true);
    controller.loadEarlier();
    await flush();
    assert.equal(logs.mock.calls[1]?.[0]?.limit, LOG_DRAWER_PAGE_SIZE * 2);

    while (controller.getSnapshot().canLoadEarlier) controller.loadEarlier();
    await flush();
    assert.equal(controller.getSnapshot().limit, LOG_DRAWER_MAX_LINES);
    assert.equal(controller.getSnapshot().canLoadEarlier, false);
    const callsBefore = logs.mock.calls.length;
    controller.loadEarlier();
    await flush();
    assert.equal(logs.mock.calls.length, callsBefore, 'at the ceiling no further request is made');
    controller.dispose();
  });

  it('(e) a failed read is a visible error and keeps the previous window', async () => {
    const clock = fakeClock();
    let fail = false;
    const logs = vi.fn(async (_filter: LogsQuery): Promise<LogsResponse> => {
      if (fail) throw new Error('logs request failed with HTTP 500');
      return { lines: [LINE], truncated: false, window: { maxLines: 1000, maxBytes: 524288 } };
    });
    const controller = createLogDrawerController({ api: api({ logs }), writeClipboard: async () => {}, clock });
    controller.open();
    await flush();
    assert.equal(controller.getSnapshot().visibleLines.length, 1);

    fail = true;
    controller.refresh();
    await flush();
    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.error, 'logs request failed with HTTP 500');
    assert.equal(snapshot.loading, false);
    assert.equal(snapshot.visibleLines.length, 1, 'the previous diagnosis stays on screen');
    controller.dispose();
  });

  it('(f) copy writes the bundle plus the visible window and reports the outcome', async () => {
    const clock = fakeClock();
    const written: string[] = [];
    const controller = createLogDrawerController({
      api: api(),
      writeClipboard: async (text) => { written.push(text); },
      clock,
    });
    controller.open();
    await flush();

    controller.copyBundle();
    assert.equal(controller.getSnapshot().copyState, 'copying');
    await flush();
    assert.equal(controller.getSnapshot().copyState, 'copied');
    assert.equal(written.length, 1);
    assert.match(written[0] ?? '', /Cloudpit diagnostics bundle/);
    assert.match(written[0] ?? '', /requestId=req-1/);

    controller.resetCopyState();
    assert.equal(controller.getSnapshot().copyState, 'idle');

    const failing = createLogDrawerController({
      api: api({ bundle: async () => { throw new Error('bundle failed'); } }),
      writeClipboard: async () => {},
      clock,
    });
    failing.open();
    await flush();
    failing.copyBundle();
    await flush();
    assert.equal(failing.getSnapshot().copyState, 'failed', 'a failed copy is visible, not thrown');
    controller.dispose();
    failing.dispose();
  });
});
