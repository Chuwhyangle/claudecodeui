import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, test, vi } from 'vitest';

import enSidebar from '@/modules/i18n/locales/en/sidebar.json';
import AwaitingReplyView from '@/modules/sidebar/AwaitingReplyView';
import { useAwaitingReplySessions } from '@/modules/sidebar/hooks/useAwaitingReplySessions';
import type { AwaitingReplyListItem } from '@/shared/types';

/**
 * The sidebar's awaiting-reply list: the view's row contract and the hook's four
 * sources of change.
 *
 * The hook is judged on what the caller can see through its returned object —
 * `sessions`, `count`, `isLoading`, `error` — across the three ways the list
 * moves: the first read, a pushed whole-list snapshot, and a local dismissal
 * that the server later refuses. The view is judged on the data attributes a
 * criterion addresses (`data-awaiting-reply-view`, `-empty`, `-session`,
 * `-reason`, `-dismiss`) and on the words it draws from the sidebar namespace.
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

/**
 * The in-memory socket and the two REST calls, held in a hoisted bag because
 * `vi.mock`'s factory is evaluated before module-level constants exist.
 */
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

// The hook reads the app-wide event stream; there is no provider in a unit test,
// and the listener set is exactly what these cases need to push through.
vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: harness.subscribe }),
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
    searchQuery=""
    onDismiss={() => {}}
    t={t}
    {...overrides}
  />,
);

beforeEach(() => {
  harness.listCalls = 0;
  harness.readList = async () => listResponse([]);
  harness.dismiss = async () => ({ ok: true, status: 200, json: async () => ({ success: true }) });
});

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

test('the first read fills the list and clears the loading flag', async () => {
  harness.readList = async () => listResponse([row(SESSION_A, { reason: 'permission' })]);
  const { result } = renderHookWithI18n();

  assert.equal(result.current.isLoading, true, 'nothing has landed yet');
  // Length rather than `deepEqual(..., [])`: node:assert's `deepEqual` is a
  // type guard, and passing `[]` narrows `sessions` to the empty-tuple type for
  // the rest of the test — which makes every later `sessions[0]` a `never`.
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

  // SESSION_A is gone, not kept alongside B: the frame is the whole list, and a
  // merge would leave a row removed in another browser on screen here.
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

test('a failed read surfaces a message without wiping the last list', async () => {
  harness.readList = async () => listResponse([row(SESSION_A)]);
  const { result } = renderHookWithI18n();
  await waitFor(() => assert.equal(result.current.sessions.length, 1));

  harness.readList = async () => ({ ok: false, status: 500, json: async () => ({ success: false }) });
  await act(async () => {
    await result.current.reload();
  });

  assert.equal(result.current.error, enSidebar.awaitingReply.loadError);
  assert.deepEqual(result.current.sessions.map((session) => session.sessionId), [SESSION_A]);
});

test('dismiss removes the row before the server answers, and leaves it gone on success', async () => {
  harness.readList = async () => listResponse([row(SESSION_A), row(SESSION_B)]);
  const { result } = renderHookWithI18n();
  await waitFor(() => assert.equal(result.current.sessions.length, 2));

  const answer = deferred<unknown>();
  harness.dismiss = () => answer.promise;

  let dismissal: Promise<void> | null = null;
  act(() => {
    dismissal = result.current.dismiss(SESSION_A);
  });

  // The optimistic half: the row is already gone while the DELETE is in flight.
  assert.deepEqual(result.current.sessions.map((session) => session.sessionId), [SESSION_B]);

  await act(async () => {
    answer.resolve({ ok: true, status: 200, json: async () => ({ success: true }) });
    await dismissal;
  });

  assert.deepEqual(result.current.sessions.map((session) => session.sessionId), [SESSION_B]);
  assert.equal(result.current.error, null);
});

test('a refused dismissal puts the row back where it was and reports why', async () => {
  harness.readList = async () => listResponse([row(SESSION_A), row(SESSION_B), row(SESSION_C)]);
  const { result } = renderHookWithI18n();
  await waitFor(() => assert.equal(result.current.sessions.length, 3));

  harness.dismiss = async () => ({ ok: false, status: 500, json: async () => ({ success: false }) });
  await act(async () => {
    await result.current.dismiss(SESSION_B);
  });

  // Restored in place, not appended: the list is ordered by how long the wait
  // has run, and B still sits between A and C.
  assert.deepEqual(
    result.current.sessions.map((session) => session.sessionId),
    [SESSION_A, SESSION_B, SESSION_C],
  );
  assert.match(result.current.error ?? '', /Failed to remove/);
});

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

test('a row carries its session, reason and dismissal contract', () => {
  const { container } = renderView({
    sessions: [row(SESSION_A, { reason: 'permission', sessionTitle: 'Waiting session' })],
  });

  assert.ok(container.querySelector('[data-awaiting-reply-view="true"]'), 'the view container is addressable');
  const element = container.querySelector<HTMLElement>(`[data-awaiting-reply-session="${SESSION_A}"]`);
  assert.ok(element, 'expected a row for the session');
  assert.equal(element.getAttribute('data-awaiting-reply-reason'), 'permission');
  assert.equal(
    element.querySelector('a')?.getAttribute('href'),
    `/session/${SESSION_A}`,
    'the row is one click from its session',
  );
  assert.match(element.textContent ?? '', /Waiting session/);
  assert.match(element.textContent ?? '', /Project One/);
  assert.match(element.textContent ?? '', /Waiting for approval/);
  // `waitingSince` is 2026-01-01, so the compact age reads in days.
  assert.match(element.textContent ?? '', /waiting \d+d/);
  assert.ok(element.querySelector('[data-awaiting-reply-dismiss="true"]'));
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

test('a failed read is stated above the rows', () => {
  const { container } = renderView({
    sessions: [row(SESSION_A)],
    error: enSidebar.awaitingReply.loadError,
  });

  const error = container.querySelector<HTMLElement>('[data-awaiting-reply-error="true"]');
  assert.ok(error);
  assert.equal(error.textContent, enSidebar.awaitingReply.loadError);
});
