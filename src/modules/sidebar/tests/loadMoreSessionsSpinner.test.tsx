import assert from 'node:assert/strict';

import { act, render, waitFor } from '@testing-library/react';
import React, { useEffect } from 'react';
import { beforeEach, test, vi } from 'vitest';
import type { Mock } from 'vitest';

import WebSocketContext from '@/shared/context/WebSocketContext';
import { SessionProtectionProvider } from '@/shared/context/SessionProtectionContext';
import type { SidebarProjectListProps } from '@/shared/types';

/**
 * The project row's "Load more sessions" button, whose label and disabled state
 * read the controller's `loadingMoreProjects`.
 *
 * The in-flight guard used to be a `shouldLoad` flag written *inside* the
 * `setLoadingMoreProjects` updater and read immediately after. React may run an
 * updater during a later render instead of at the call site, and any pending
 * update on the component — the sidebar's five-second poll is enough — makes
 * that the deferred path. The click then returned before calling
 * `onLoadMoreSessions`, while the deferred updater still added the project to
 * the loading set: no request in flight, nothing to clear it, and the button
 * sat on "Loading sessions..." until a page reload.
 *
 * These cases drive the real controller: the deferred case is the regression,
 * the ordinary case and the double-click case pin what the guard is for.
 */

const apiMock = vi.hoisted(() => ({
  archivedProjects: vi.fn(),
  getArchivedSessions: vi.fn(),
  recentConversations: vi.fn(),
  migrateLegacyProjectStars: vi.fn(),
}));

vi.mock('@/shared/api', () => ({ api: apiMock }));

// The controller reaches the palette through its barrel, which drags the whole
// palette graph in behind it. None of it is under test here.
vi.mock('@/modules/command-palette', () => ({
  usePaletteOps: () => ({
    openFile: () => {},
    openFileInEditor: () => {},
    openDirectory: () => {},
    openSettings: () => {},
    refreshProjects: () => {},
  }),
}));

const { useSidebarController } = await import('@/modules/sidebar/hooks/useSidebarController');

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const t = ((key: string) => key) as unknown as SidebarProjectListProps['t'];
const PROJECT_ID = 'project-1';

/** The two providers the controller reads; the socket is where its events would arrive. */
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <WebSocketContext.Provider
    value={{ ws: null, sendMessage: () => {}, subscribe: () => () => {}, isConnected: true }}
  >
    <SessionProtectionProvider>{children}</SessionProtectionProvider>
  </WebSocketContext.Provider>
);

type Controller = ReturnType<typeof useSidebarController>;

/** The controller's latest value, published after each render. */
const published: { current: Controller | null } = { current: null };

/** The page request "load more" spends, replaced per case. */
let pageRequest: Mock<(projectId: string) => Promise<void>>;

/**
 * One stable argument object for every render. `projects: []` written inline
 * would be a new array each render, and the controller's mount effect resets
 * `initialSessionsLoaded` whenever that identity changes — a fresh empty array
 * per render is therefore an endless render loop.
 */
const CONTROLLER_ARGS = {
  projects: [],
  selectedProject: null,
  selectedSession: null,
  activeSessions: new Set<string>(),
  isLoading: false,
  isMobile: false,
  t,
  onRefresh: () => {},
  onProjectSelect: () => {},
  onSessionSelect: () => {},
  onLoadMoreSessions: (projectId: string) => pageRequest(projectId),
  setCurrentProject: () => {},
  setSidebarVisible: () => {},
  sidebarVisible: true,
};

function Harness() {
  const controller = useSidebarController(CONTROLLER_ARGS);

  useEffect(() => {
    published.current = controller;
  }, [controller]);

  return null;
}

const store = (): Controller => {
  assert.notEqual(published.current, null);
  return published.current as Controller;
};

const mount = async () => {
  render(<Harness />, { wrapper });
  await waitFor(() => assert.notEqual(published.current, null));
};

/** A promise the case settles by hand, so "in flight" is a state the test holds. */
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = () => settle();
  });
  return { promise, resolve };
};

beforeEach(() => {
  published.current = null;
  localStorage.clear();
  apiMock.archivedProjects.mockReset().mockResolvedValue(json({ success: true, data: { projects: [] } }));
  apiMock.getArchivedSessions.mockReset().mockResolvedValue(json({ success: true, data: { sessions: [] } }));
  apiMock.recentConversations.mockReset().mockResolvedValue(json({ success: true, data: { conversations: [] } }));
  apiMock.migrateLegacyProjectStars.mockReset().mockResolvedValue(json({ success: true }));
  pageRequest = vi.fn(async () => {});
});

test('a click that lands while another update is pending still spends its page request', async () => {
  const page = deferred();
  pageRequest = vi.fn(() => page.promise);
  await mount();

  await act(async () => {
    // Any unrelated state update on the same component puts lanes on its fiber,
    // which is what stops React from eagerly reducing the *next* hook update at
    // the call site. Expanding a project is the cheapest such update, and the
    // sidebar poll produces the same window in the running app.
    store().toggleProject(PROJECT_ID);
    void store().loadMoreSessionsForProject(PROJECT_ID);
  });

  assert.equal(pageRequest.mock.calls.length, 1, 'the click must reach the page request');
  assert.equal(store().loadingMoreProjects.has(PROJECT_ID), true);

  await act(async () => {
    page.resolve();
    await page.promise;
  });

  await waitFor(() => assert.equal(store().loadingMoreProjects.has(PROJECT_ID), false));
});

test('an ordinary click spends exactly one page request and clears the spinner when it settles', async () => {
  const page = deferred();
  pageRequest = vi.fn(() => page.promise);
  await mount();

  await act(async () => {
    void store().loadMoreSessionsForProject(PROJECT_ID);
  });

  assert.equal(pageRequest.mock.calls.length, 1);
  assert.equal(store().loadingMoreProjects.has(PROJECT_ID), true);

  await act(async () => {
    page.resolve();
    await page.promise;
  });

  await waitFor(() => assert.equal(store().loadingMoreProjects.has(PROJECT_ID), false));
});

test('a second click while the first page is in flight spends no second request', async () => {
  const page = deferred();
  pageRequest = vi.fn(() => page.promise);
  await mount();

  await act(async () => {
    void store().loadMoreSessionsForProject(PROJECT_ID);
  });
  await act(async () => {
    void store().loadMoreSessionsForProject(PROJECT_ID);
  });

  assert.equal(pageRequest.mock.calls.length, 1);
  assert.equal(store().loadingMoreProjects.has(PROJECT_ID), true);

  await act(async () => {
    page.resolve();
    await page.promise;
  });

  await waitFor(() => assert.equal(store().loadingMoreProjects.has(PROJECT_ID), false));
});
