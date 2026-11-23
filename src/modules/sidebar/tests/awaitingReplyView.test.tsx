import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, test, vi } from 'vitest';

import type * as SharedUtilsModule from '@/shared/utils';
import { syncAwaitingReplyTitleIndicator } from '@/shared/utils';
import type { Clock } from '@/shared/types';
import enSidebar from '@/modules/i18n/locales/en/sidebar.json';
import AwaitingReplyView from '@/modules/sidebar/AwaitingReplyView';
import { useAwaitingReplySessions } from '@/modules/sidebar/hooks/useAwaitingReplySessions';
import { createAwaitingReplyController } from '@/modules/sidebar/utils/awaitingReplyController';
import type { AwaitingReplyListItem } from '@/shared/awaitingReplyType';

/**
 * The sidebar's awaiting-reply inbox: the controller's rules, the hook's four
 * sources of change, and the view's row contract.
 *
 * The four sources are judged where they actually matter:
 *  - the first read (the load a page opens with), through the hook;
 *  - a pushed whole-list snapshot, through the hook;
 *  - a manual dismissal (optimistic, and the in-place restore of a refused one),
 *    through the hook;
 *  - opening a row, which takes the row off the list, through the view's
 *    `onOpen` hand-off (the sidebar is what navigates, and its own test covers
 *    the pairing).
 *
 * The rules that must not re-render to be true — the chime throttle and the
 * hidden-tab silence — are driven straight at the controller with an injected
 * clock, the way the frontend standards ask controllers to be tested.
 */

const SESSION_A = 'session-a';
const SESSION_B = 'session-b';
const SESSION_C = 'session-c';

const row = (
  sessionId: string,
  overrides: Partial<AwaitingReplyListItem> = {},
): AwaitingReplyListItem => ({
  sessionId,
  provider: 'claude',
  projectId: 'project-1',
  projectPath: '/tmp/project-1',
  projectDisplayName: 'Project One',
  sessionTitle: `Title ${sessionId}`,
  awaitingSince: '2026-01-01T00:00:00.000Z',
  reason: 'completed',
  ...overrides,
});

/** The chime the controller plays; hoisted because the module mock runs before module constants exist. */
const notifySound = vi.hoisted(() => vi.fn());

vi.mock('@/shared/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedUtilsModule>();
  return { ...actual, playNotificationSound: notifySound };
});

/** The in-memory socket and the two REST calls, hoisted for the same reason. */
const harness = vi.hoisted(() => {
  const listeners = new Set<(event: Record<string, unknown>) => void>();
  return {
    subscribe: (listener: (event: Record<string, unknown>) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit: (event: Record<string, unknown>) => {
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
    listCalls: 0,
    readList: async (): Promise<unknown> => ({ ok: true, status: 200, json: async () => ({ success: true, data: { sessions: [] } }) }),
    dismiss: async (_sessionId: string): Promise<unknown> => ({ ok: true, status: 200, json: async () => ({ success: true, data: { removed: true } }) }),
  };
});

vi.mock('@/shared/api', () => ({
  api: {
    awaitingReplySessions: () => {
      harness.listCalls += 1;
      return harness.readList();
    },
    dismissAwaitingReply: (sessionId: string) => harness.dismiss(sessionId),
  },
}));

vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: harness.subscribe, isConnected: true }),
}));

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'en',
  defaultNS: 'sidebar',
  resources: { en: { sidebar: enSidebar } },
  interpolation: { escapeValue: false },
});
const t = i18n.t.bind(i18n) as unknown as React.ComponentProps<typeof AwaitingReplyView>['t'];

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
);

const renderHookWithI18n = () => renderHook(() => useAwaitingReplySessions(), { wrapper });

const listResponse = (sessions: AwaitingReplyListItem[]) => ({
  ok: true,
  status: 200,
  json: async () => ({ success: true, data: { sessions } }),
});

/** A deferred answer, so a case can read the row between the click and the reply. */
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const renderView = (overrides: Partial<React.ComponentProps<typeof AwaitingReplyView>> = {}) => render(
  <AwaitingReplyView
    sessions={[]}
    isLoading={false}
    error={null}
    isConnected
    searchQuery=""
    onOpen={() => {}}
    onDismiss={() => {}}
    onRetry={() => {}}
    t={t}
    {...overrides}
  />,
);

/** A clock the test drives, so the throttle rule is judged without sleeping. */
const createFakeClock = (): Clock & { advance: (milliseconds: number) => void } => {
  let current = 0;
  return {
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    now: () => current,
    advance: (milliseconds: number) => {
      current += milliseconds;
    },
  };
};

beforeEach(() => {
  harness.listCalls = 0;
  harness.readList = async () => listResponse([]);
  harness.dismiss = async () => ({ ok: true, status: 200, json: async () => ({ success: true }) });
  notifySound.mockClear();
  // The title helpers prepend to whatever is already there, so each case starts
  // from the same baseline a fresh tab has.
  document.title = 'Cloudpit';
});

// ---------------------------------------------------------------------------
// The controller (React-free rules)
// ---------------------------------------------------------------------------

const buildController = (
  overrides: Partial<Parameters<typeof createAwaitingReplyController>[0]> = {},
) => {
  const chime = vi.fn();
  const clock = createFakeClock();
  const controller = createAwaitingReplyController({
    listSessions: async () => [],
    dismissSession: async () => {},
    playChime: chime,
    // The real title helper, so the marker assertions below read the shipped
    // three-state rule rather than a mock that proves nothing about it.
    syncTitle: syncAwaitingReplyTitleIndicator,
    loadErrorMessage: () => 'Could not load the list.',
    reportError: () => {},
    clock,
    ...overrides,
  });
  return { controller, chime, clock };
};

test('the list a page opens with is history: it sets the title and never chimes', async () => {
  const { controller, chime } = buildController({ listSessions: async () => [row(SESSION_A)] });
  await controller.reload();

  assert.equal(chime.mock.calls.length, 0, 'a wait that predates the page must not chime');
  assert.equal(document.title, '[待回复 1] Cloudpit');
  controller.dispose();
});

test('the controller chimes once per throttle window for genuinely new waits', async () => {
  const { controller, chime, clock } = buildController();
  await controller.reload();

  // Past the window, a new wait rings.
  clock.advance(3000);
  controller.acceptSnapshot([row(SESSION_A)]);
  assert.equal(chime.mock.calls.length, 1);

  // A second new wait on its heels still moves the count, but stays silent:
  // two chimes back to back read as a fault rather than a second event.
  controller.acceptSnapshot([row(SESSION_A), row(SESSION_B)]);
  assert.equal(chime.mock.calls.length, 1);
  assert.equal(document.title, '[待回复 2] Cloudpit');

  // Past the window again, the next one rings.
  clock.advance(3000);
  controller.acceptSnapshot([row(SESSION_A), row(SESSION_B), row(SESSION_C)]);
  assert.equal(chime.mock.calls.length, 2);

  // Answering everything takes the marker away with the list.
  controller.acceptSnapshot([]);
  assert.equal(document.title, 'Cloudpit');
  controller.dispose();
});

test('a hidden tab is silent even for a genuinely new wait', async () => {
  const { controller, chime, clock } = buildController({ isPageHidden: () => true });
  await controller.reload();

  clock.advance(5000);
  controller.acceptSnapshot([row(SESSION_A)]);

  assert.equal(chime.mock.calls.length, 0, 'a tab nobody is looking at does not ring');
  controller.dispose();
});

test('a refused dismissal puts the row back where it was and reports why', async () => {
  const { controller } = buildController({
    listSessions: async () => [row(SESSION_A), row(SESSION_B), row(SESSION_C)],
    dismissSession: async () => {
      throw new Error('Failed to remove the session from awaiting reply: 500');
    },
  });
  await controller.reload();

  await controller.dismiss(SESSION_B);

  assert.deepEqual(
    controller.getSnapshot().sessions.map((session) => session.sessionId),
    [SESSION_A, SESSION_B, SESSION_C],
    'restored in place, not appended',
  );
  assert.match(controller.getSnapshot().error ?? '', /Failed to remove/);
  controller.dispose();
});

test('a failed read is reported without wiping the last list', async () => {
  let fail = false;
  const { controller } = buildController({
    listSessions: async () => {
      if (fail) {
        throw new Error('boom');
      }
      return [row(SESSION_A)];
    },
  });
  await controller.reload();
  assert.equal(controller.getSnapshot().sessions.length, 1);

  fail = true;
  await controller.reload();

  assert.equal(controller.getSnapshot().error, 'Could not load the list.');
  assert.equal(controller.getSnapshot().sessions.length, 1);
  controller.dispose();
});

// ---------------------------------------------------------------------------
// The hook (the four sources of change)
// ---------------------------------------------------------------------------

test('the first read fills the list and clears the loading flag', async () => {
  harness.readList = async () => listResponse([row(SESSION_A, { reason: 'permission' })]);
  const { result } = renderHookWithI18n();

  assert.equal(result.current.isLoading, true, 'nothing has landed yet');
  assert.equal(result.current.sessions.length, 0);

  await waitFor(() => assert.equal(result.current.sessions.length, 1));
  assert.equal(result.current.sessions[0].sessionId, SESSION_A);
  assert.equal(result.current.count, 1);
  assert.equal(result.current.isLoading, false);
  assert.equal(result.current.error, null);
});

test('a pushed snapshot replaces the list instead of being merged, and reads nothing', async () => {
  harness.readList = async () => listResponse([row(SESSION_A)]);
  const { result } = renderHookWithI18n();
  await waitFor(() => assert.equal(result.current.sessions.length, 1));
  assert.equal(harness.listCalls, 1);

  act(() => {
    harness.emit({ kind: 'awaiting_reply_changed', sessions: [row(SESSION_B)], timestamp: '2026-01-01T00:00:00.000Z' });
  });

  assert.deepEqual(result.current.sessions.map((session) => session.sessionId), [SESSION_B]);
  assert.equal(result.current.count, 1);
  assert.equal(harness.listCalls, 1, 'the snapshot is authoritative; no follow-up request');
});

test('coming back to the window re-reads the list', async () => {
  harness.readList = async () => listResponse([row(SESSION_A)]);
  const { result } = renderHookWithI18n();
  await waitFor(() => assert.equal(result.current.sessions.length, 1));

  harness.readList = async () => listResponse([row(SESSION_A), row(SESSION_B)]);
  act(() => {
    window.dispatchEvent(new Event('focus'));
  });

  await waitFor(() => assert.equal(result.current.sessions.length, 2));
  assert.equal(harness.listCalls, 2);
});

test('a manual dismissal removes the row before the server answers', async () => {
  harness.readList = async () => listResponse([row(SESSION_A), row(SESSION_B)]);
  const { result } = renderHookWithI18n();
  await waitFor(() => assert.equal(result.current.sessions.length, 2));

  const answer = deferred<unknown>();
  harness.dismiss = () => answer.promise;

  let dismissal: Promise<void> | null = null;
  act(() => {
    dismissal = result.current.dismiss(SESSION_A);
  });

  assert.deepEqual(result.current.sessions.map((session) => session.sessionId), [SESSION_B]);

  await act(async () => {
    answer.resolve({ ok: true, status: 200, json: async () => ({ success: true }) });
    await dismissal;
  });

  assert.deepEqual(result.current.sessions.map((session) => session.sessionId), [SESSION_B]);
  assert.equal(result.current.error, null);
});

test('the tab title carries the count from the very first list', async () => {
  harness.readList = async () => listResponse([row(SESSION_A), row(SESSION_B)]);
  const { result } = renderHookWithI18n();
  await waitFor(() => assert.equal(result.current.sessions.length, 2));

  assert.equal(notifySound.mock.calls.length, 0, 'opening a page must not chime for waits that predate it');
  assert.equal(document.title, '[待回复 2] Cloudpit');
});

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

test('rows are grouped by project and carry their reason contract', () => {
  const { container } = renderView({
    sessions: [
      row(SESSION_A, { reason: 'permission', sessionTitle: 'Waiting session' }),
      row(SESSION_B, { projectId: 'project-2', projectDisplayName: 'Project Two', sessionTitle: 'Other project' }),
    ],
  });

  assert.ok(container.querySelector('[data-awaiting-reply-view="true"]'), 'the view container is addressable');
  const groups = container.querySelectorAll('[data-awaiting-reply-group="true"]');
  assert.equal(groups.length, 2, 'two projects make two groups');

  const first = container.querySelector<HTMLElement>(`[data-awaiting-reply-session="${SESSION_A}"]`);
  assert.ok(first, 'expected a row for the session');
  assert.equal(first.getAttribute('data-awaiting-reply-reason'), 'permission');
  assert.equal(first.querySelector('a')?.getAttribute('href'), `/session/${SESSION_A}`);
  assert.match(first.textContent ?? '', /Waiting session/);
  assert.match(first.textContent ?? '', /Waiting for approval/);
  // `awaitingSince` is 2026-01-01, so the compact age reads in days.
  assert.match(first.textContent ?? '', /waiting \d+d/);
  assert.ok(first.querySelector('[data-awaiting-reply-dismiss="true"]'));
});

test('the three reasons draw distinct labels', () => {
  const { container } = renderView({
    sessions: [
      row(SESSION_A, { reason: 'completed' }),
      row(SESSION_B, { reason: 'failed' }),
      row(SESSION_C, { reason: 'permission' }),
    ],
  });

  const labelFor = (sessionId: string): string =>
    container.querySelector<HTMLElement>(`[data-awaiting-reply-session="${sessionId}"] [data-awaiting-reply-reason-label="true"]`)?.textContent ?? '';

  assert.equal(labelFor(SESSION_A), 'Finished');
  assert.equal(labelFor(SESSION_B), 'Failed');
  assert.equal(labelFor(SESSION_C), 'Waiting for approval');
});

test('opening a row hands the whole item to the caller and suppresses the bare navigation', () => {
  const opened: AwaitingReplyListItem[] = [];
  const { container } = renderView({
    sessions: [row(SESSION_A, { sessionTitle: 'Open me' })],
    onOpen: (session) => opened.push(session),
  });

  const link = container.querySelector<HTMLAnchorElement>(`[data-awaiting-reply-session="${SESSION_A}"] a`);
  assert.ok(link);

  // A real, cancelable click event: `fireEvent.click` through `act` returns a
  // thenable in React 19, so the cancellation flag is read off the event itself.
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  act(() => {
    link.dispatchEvent(event);
  });

  assert.deepEqual(opened.map((session) => session.sessionId), [SESSION_A]);
  assert.equal(event.defaultPrevented, true, 'the view must preventDefault so onOpen owns the navigation');
});

test('clicking remove hands the session id to the caller', () => {
  const dismissed: string[] = [];
  const { container } = renderView({
    sessions: [row(SESSION_A)],
    onDismiss: (sessionId) => dismissed.push(sessionId),
  });

  const button = container.querySelector<HTMLElement>('[data-awaiting-reply-dismiss="true"]');
  assert.ok(button);
  assert.match(button.getAttribute('aria-label') ?? '', new RegExp(`Title ${SESSION_A}`));

  act(() => {
    fireEvent.click(button);
  });

  assert.deepEqual(dismissed, [SESSION_A]);
});

test('an empty list draws the empty state', () => {
  const { container } = renderView({ sessions: [] });

  assert.ok(container.querySelector('[data-awaiting-reply-empty="true"]'));
  assert.match(container.textContent ?? '', /Nothing awaiting your reply/);
});

test('the search box filters by session and project name, and says when nothing matches', () => {
  const sessions = [
    row(SESSION_A, { sessionTitle: 'Fix the parser', projectDisplayName: 'Alpha' }),
    row(SESSION_B, { sessionTitle: 'Review the docs', projectDisplayName: 'Beta' }),
  ];

  const byTitle = renderView({ sessions, searchQuery: 'parser' });
  assert.equal(byTitle.container.querySelectorAll('[data-awaiting-reply-session]').length, 1);
  assert.ok(byTitle.container.querySelector(`[data-awaiting-reply-session="${SESSION_A}"]`));
  byTitle.unmount();

  const byProject = renderView({ sessions, searchQuery: 'beta' });
  assert.ok(byProject.container.querySelector(`[data-awaiting-reply-session="${SESSION_B}"]`));
  assert.equal(byProject.container.querySelectorAll('[data-awaiting-reply-session]').length, 1);
  byProject.unmount();

  const noMatch = renderView({ sessions, searchQuery: 'nothing here' });
  assert.equal(noMatch.container.querySelectorAll('[data-awaiting-reply-session]').length, 0);
  assert.ok(noMatch.container.querySelector('[data-awaiting-reply-no-match="true"]'));
  assert.match(noMatch.container.textContent ?? '', /No sessions match this search\./);
  // The list is not empty — it is filtered — so the empty state must not claim it is.
  assert.equal(noMatch.container.querySelector('[data-awaiting-reply-empty="true"]'), null);
});

test('a read still outstanding draws a skeleton rather than an empty answer', () => {
  const { container } = renderView({ sessions: [], isLoading: true });

  assert.ok(container.querySelector('[data-awaiting-reply-loading="true"]'));
  assert.equal(container.querySelector('[data-awaiting-reply-empty="true"]'), null);
});

test('a dropped socket is stated, with the retry beside it, rather than drawn as a fresh list', () => {
  const retries: number[] = [];
  const { container } = renderView({
    sessions: [row(SESSION_A)],
    isConnected: false,
    onRetry: () => retries.push(1),
  });

  const offline = container.querySelector<HTMLElement>('[data-awaiting-reply-offline="true"]');
  assert.ok(offline, 'a list that stopped receiving frames must say so');
  assert.match(offline.textContent ?? '', /Live updates are offline/);

  // The rows stay drawn: the socket is down, not the data.
  assert.ok(container.querySelector(`[data-awaiting-reply-session="${SESSION_A}"]`));

  const retry = offline.querySelector<HTMLElement>('[data-awaiting-reply-retry="true"]');
  assert.ok(retry, 'the offline note offers its own way to re-read');
  act(() => {
    fireEvent.click(retry);
  });
  assert.equal(retries.length, 1);
});

test('a failed read is stated above the rows with a retry that re-reads', () => {  const retries: number[] = [];
  const { container } = renderView({
    sessions: [row(SESSION_A)],
    error: enSidebar.awaitingReply.loadError,
    onRetry: () => retries.push(1),
  });

  const error = container.querySelector<HTMLElement>('[data-awaiting-reply-error="true"]');
  assert.ok(error);
  assert.match(error.textContent ?? '', new RegExp(enSidebar.awaitingReply.loadError.replace('.', '\\.')));

  const retry = container.querySelector<HTMLElement>('[data-awaiting-reply-retry="true"]');
  assert.ok(retry, 'a stale list without a retry is a dead end');
  act(() => {
    fireEvent.click(retry);
  });
  assert.equal(retries.length, 1);
});
