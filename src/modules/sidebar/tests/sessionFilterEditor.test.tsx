import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { beforeAll, beforeEach, test, vi } from 'vitest';

import zhSidebar from '@/modules/i18n/locales/zh-CN/sidebar.json';
import type { ConversationSearchResults, Project } from '@/shared/types';

/**
 * The rules editor (debounced live preview, per-line errors, save), plus the
 * frontend contract around it: keepSessionIds on every session request,
 * incremental pushes that match a rule, and the "filtered" mark in search.
 */

const previewMock = vi.fn();
const saveMock = vi.fn();
const projectsMock = vi.fn();
const projectSessionsMock = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    previewProjectSessionFilter: (...args: unknown[]) => previewMock(...args),
    saveProjectSessionFilter: (...args: unknown[]) => saveMock(...args),
    projects: (...args: unknown[]) => projectsMock(...args),
    projectSessions: (...args: unknown[]) => projectSessionsMock(...args),
    projectTaskmaster: () => Promise.resolve({ ok: false }),
    sessionDetails: () => Promise.resolve({ ok: false }),
  },
}));

vi.mock('@/modules/sidebar/SidebarHeader', () => ({ default: () => null }));
vi.mock('@/modules/sidebar/SidebarFooter', () => ({ default: () => null }));
vi.mock('@/modules/sidebar/SidebarProjectList', () => ({ default: () => null }));
vi.mock('@/modules/sidebar/SidebarRecentConversations', () => ({ default: () => null }));

const { default: SessionFilterEditor } = await import('@/modules/sidebar/SessionFilterEditor');
const { default: SidebarContent } = await import('@/modules/sidebar/SidebarContent');

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'zh-CN',
  defaultNS: 'sidebar',
  resources: { 'zh-CN': { sidebar: zhSidebar } },
  interpolation: { escapeValue: false },
});
const t = i18n.t.bind(i18n) as unknown as React.ComponentProps<typeof SessionFilterEditor>['t'];

const PROJECT = {
  projectId: 'project-1',
  displayName: 'Repo',
  fullPath: '/repo',
  sessionFilter: null,
  sessions: [],
  sessionMeta: { total: 0, hasMore: false, hiddenCount: 0 },
} as unknown as Project;

const okJson = (body: unknown) => Promise.resolve({ ok: true, json: async () => body });
const failJson = (message: string, line: number | null) => Promise.resolve({
  ok: false,
  json: async () => ({ error: { message, details: { line } } }),
});

const PREVIEW = {
  matchedCount: 114,
  unmatchedCount: 14,
  matchedSessionNames: ['run-a-task-worker', 'run-b-selector'],
  unmatchedSessionNames: ['my real session'],
};

beforeEach(() => {
  localStorage.clear();
  previewMock.mockReset();
  saveMock.mockReset();
  projectsMock.mockReset();
  projectSessionsMock.mockReset();
  previewMock.mockImplementation(() => okJson({ data: { preview: PREVIEW } }));
});

// Warms the module graph that `renderProjectsState` imports below, so its cold compile is
// charged to hookTimeout rather than to the first case that reaches it.
//
// The dynamic `import()` is *in the case body* (the helper runs inside the case), and Vite
// caches the compiled output for the whole file — so whichever case imports it first pays the
// entire `@/modules/project-workspace` graph's compile: measured 2.0s in a full-suite run
// (2.6–2.9s run file-by-file) against a 5000ms case budget, while every other case in this
// file runs in 10–370ms. That is the same shape as the `resetModules` files, minus one half:
// this file never resets the registry, which only decides whether the compile is re-paid *per
// case* — it is still the *first* case that pays it. Under CPU contention the case overshoots
// and dies at 5003ms (`Test timed out in 5000ms`), which is how AC-103's condition ① went red.
// Warming here moves the compile out of every case's budget without changing what any case
// checks.
beforeAll(async () => {
  await import('@/modules/project-workspace');
});

const renderEditor = () => {
  const onClose = vi.fn();
  const onSaved = vi.fn(async () => {});
  const view = render(React.createElement(SessionFilterEditor, { project: PROJECT, onClose, onSaved, t }));
  const textarea = () => view.getByRole('textbox') as HTMLTextAreaElement;
  return { ...view, onClose, onSaved, textarea };
};

test('typing rules calls preview once after the debounce and renders counts and names', async () => {
  const view = renderEditor();

  fireEvent.change(view.textarea(), { target: { value: '-(task' } });
  fireEvent.change(view.textarea(), { target: { value: '-(task-worker|selector)$' } });

  await waitFor(() => assert.ok(view.getByTestId('session-filter-preview')));
  assert.equal(previewMock.mock.calls.filter(([, hide]) => hide.length > 0).length, 1);
  assert.deepEqual(previewMock.mock.calls.at(-1), ['project-1', ['-(task-worker|selector)$']]);
  const text = view.getByTestId('session-filter-preview').textContent ?? '';
  assert.ok(text.includes('命中 114 个'));
  assert.ok(text.includes('未命中 14 个'));
  assert.ok(text.includes('run-a-task-worker'));
  assert.ok(text.includes('my real session'));
});

test('a server-reported invalid line is marked on that textarea line', async () => {
  previewMock.mockImplementation((_id: string, hide: string[]) => (
    hide.includes('(broken') ? failJson('Line 2: Unterminated group', 2) : okJson({ data: { preview: PREVIEW } })
  ));
  const view = renderEditor();

  fireEvent.change(view.textarea(), { target: { value: 'fine\n(broken' } });

  await waitFor(() => assert.equal(view.getByTestId('session-filter-line-2').getAttribute('data-invalid'), 'true'));
  assert.equal(view.getByTestId('session-filter-line-1').getAttribute('data-invalid'), null);
});

test('a rejected save keeps the panel open and shows the server error', async () => {
  saveMock.mockImplementation(() => failJson('Line 1: Invalid regular expression', 1));
  const view = renderEditor();

  fireEvent.change(view.textarea(), { target: { value: '(' } });
  fireEvent.click(view.getByText('保存'));

  await waitFor(() => assert.ok(view.getByRole('alert').textContent?.includes('Invalid regular expression')));
  assert.equal(view.onClose.mock.calls.length, 0);
  assert.equal(view.onSaved.mock.calls.length, 0);
  assert.ok(view.textarea());
});

test('a successful save reloads the project sessions and closes the panel', async () => {
  saveMock.mockImplementation(() => okJson({ data: { sessionFilter: { hide: ['-task-worker$'] } } }));
  const view = renderEditor();

  fireEvent.change(view.textarea(), { target: { value: '-task-worker$\n\n' } });
  fireEvent.click(view.getByText('保存'));

  await waitFor(() => assert.equal(view.onClose.mock.calls.length, 1));
  assert.deepEqual(saveMock.mock.calls[0], ['project-1', ['-task-worker$']]);
  assert.deepEqual(view.onSaved.mock.calls[0], ['project-1', ['-task-worker$']]);
});

// ---------------------------------------------------------------------------

type ServerEventListener = (event: Record<string, unknown>) => void;

const listeners = new Set<ServerEventListener>();

const FILTERED_PROJECT = {
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
  sessionFilter: { hide: ['-task-worker$'] },
  sessions: [{ id: 'sel-1', summary: 'kept selected', lastActivity: '2026-01-01T00:00:00.000Z' }],
  sessionMeta: { total: 30, hasMore: true, hiddenCount: 3 },
};

const upsert = (sessionId: string, summary: string) => ({
  kind: 'session_upserted',
  sessionId,
  provider: 'claude',
  session: { id: sessionId, summary, messageCount: 0, lastActivity: '2026-01-02T00:00:00.000Z' },
  project: { projectId: 'project-1', path: '/repo', fullPath: '/repo', displayName: 'Repo', isStarred: false },
  timestamp: '2026-01-02T00:00:00.000Z',
});

const renderProjectsState = async () => {
  const { useProjectsState } = await import('@/modules/project-workspace');
  return renderHook(() => useProjectsState({
    sessionId: undefined,
    navigate: vi.fn(),
    subscribe: (listener: ServerEventListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isMobile: false,
    isSessionProcessing: () => false,
    runningSessionIds: new Set(['run-1']),
  }));
};

const dispatch = (event: Record<string, unknown>) => act(() => {
  for (const listener of listeners) listener(event);
});

test('session requests carry running, attention and selected ids as keepSessionIds', async () => {
  listeners.clear();
  projectsMock.mockImplementation(() => okJson([FILTERED_PROJECT]));
  projectSessionsMock.mockImplementation(() => okJson({ sessions: [], sessionMeta: { total: 30, hasMore: false, hiddenCount: 3 } }));
  const { result } = await renderProjectsState();
  await waitFor(() => assert.equal(result.current.projects.length, 1));

  // The initial project fetch already protects running sessions.
  assert.ok((projectsMock.mock.calls[0][0].keepSessionIds as string[]).includes('run-1'));

  // An unrelated session pushes a delta: it now needs attention. Another one is selected.
  dispatch(upsert('att-1', 'needs a look'));
  act(() => result.current.handleSessionSelect({ id: 'sel-1', summary: 'kept selected' } as never));

  await act(async () => {
    await result.current.loadMoreProjectSessions('project-1');
  });
  const options = projectSessionsMock.mock.calls.at(-1)?.[1] as { keepSessionIds: string[]; includeHidden: boolean };
  assert.equal(options.includeHidden, false);
  for (const id of ['run-1', 'att-1', 'sel-1']) {
    assert.ok(options.keepSessionIds.includes(id), `keepSessionIds must include ${id}`);
  }
});

test('a pushed session whose name matches the rules is not listed and only raises hiddenCount', async () => {
  listeners.clear();
  projectsMock.mockImplementation(() => okJson([FILTERED_PROJECT]));
  const { result } = await renderProjectsState();
  await waitFor(() => assert.equal(result.current.projects.length, 1));

  dispatch(upsert('auto-1', 'nightly RUN-TASK-WORKER'));
  dispatch(upsert('auto-1', 'nightly RUN-TASK-WORKER'));

  const project = result.current.projects[0];
  assert.deepEqual((project.sessions ?? []).map((session) => session.id), ['sel-1']);
  assert.equal(project.sessionMeta?.hiddenCount, 4);
  assert.equal(project.sessionMeta?.total, 30);

  dispatch(upsert('human-1', 'my own session'));
  const after = result.current.projects[0];
  assert.deepEqual((after.sessions ?? []).map((session) => session.id), ['human-1', 'sel-1']);
  assert.equal(after.sessionMeta?.hiddenCount, 4);
});

test('title-search results flagged filtered carry the 已过滤 mark', () => {
  const results: ConversationSearchResults = {
    titleResults: [
      { sessionId: 'a', provider: 'claude', projectId: 'project-1', projectDisplayName: 'Repo', sessionTitle: 'hidden-task-worker', lastActivity: null, filtered: true },
      { sessionId: 'b', provider: 'claude', projectId: 'project-1', projectDisplayName: 'Repo', sessionTitle: 'plain session', lastActivity: null, filtered: false },
    ],
    results: [],
    totalMatches: 0,
  } as unknown as ConversationSearchResults;

  const noop = () => {};
  const view = render(React.createElement(SidebarContent, {
    isPWA: false,
    isMobile: false,
    isLoading: false,
    projects: [],
    runningSessionsCount: 0,
    awaitingReply: {
      sessions: [],
      count: 0,
      isLoading: false,
      error: null,
      dismiss: async () => {},
      reload: async () => {},
    },
    archivedProjects: [],
    archivedSessions: [],
    archivedSessionsCount: 0,
    isArchivedSessionsLoading: false,
    recentConversations: [],
    recentConversationsTotal: 0,
    recentConversationsHasMore: false,
    isRecentConversationsLoading: false,
    isLoadingMoreRecentConversations: false,
    recentConversationsError: false,
    searchFilter: 'task',
    onSearchFilterChange: noop,
    onClearSearchFilter: noop,
    searchMode: 'conversations',
    onSearchModeChange: noop,
    conversationResults: results,
    isSearching: false,
    searchProgress: null,
    onRestoreArchivedProject: noop,
    onLoadMoreRecentConversations: noop,
    onRetryRecentConversations: noop,
    onArchivedSessionClick: noop,
    onRestoreArchivedSession: noop,
    onDeleteArchivedSession: noop,
    onConversationResultClick: noop,
    onRefresh: noop,
    isRefreshing: false,
    onCreateProject: noop,
    onCollapseSidebar: noop,
    onGoHome: noop,
    updateAvailable: false,
    restartRequired: false,
    releaseInfo: null,
    latestVersion: null,
    currentVersion: '1.0.0',
    onShowVersionModal: noop,
    onShowSettings: noop,
    projectListProps: { currentTime: new Date(), activeRename: null } as never,
    t,
  }));

  const rows = view.getAllByRole('button');
  const hiddenRow = rows.find((row) => row.textContent?.includes('hidden-task-worker'));
  const plainRow = rows.find((row) => row.textContent?.includes('plain session'));
  assert.ok(hiddenRow?.textContent?.includes('已过滤'));
  assert.ok(plainRow && !plainRow.textContent?.includes('已过滤'));
});
