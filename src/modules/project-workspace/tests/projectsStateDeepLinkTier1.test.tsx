import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * Regression guard for the cold-start deep-link copy.
 *
 * A cold start on `/session/<id>` resolves the owning project from
 * `GET /api/providers/sessions/:id` while `/api/projects` is still in flight
 * (the session lookup returns an order of magnitude sooner). The hook
 * synthesizes a minimal `selectedProject` from that payload — and the Quay tab
 * gate reads `selectedProject.hasQuayConfig`, which the project listing is
 * otherwise the only source of. So the synthesized copy must carry the Tier-1
 * reading itself, and the later list must not undo it.
 */

const projectsResponse = vi.fn();
const sessionDetailsResponse = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    projects: () => projectsResponse(),
    projectTaskmaster: () => Promise.resolve({ ok: false }),
    sessionDetails: (sessionId: string) => sessionDetailsResponse(sessionId),
    projectSessions: () => Promise.resolve({ ok: false }),
  },
}));

const DEEP_LINK_SESSION_ID = 'deep-link-session-1';
const PROJECT_ID = 'project-1';

const buildProject = (overrides: Partial<Project> = {}): Project => ({
  projectId: PROJECT_ID,
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
  sessions: [],
  sessionMeta: { hasMore: false, total: 0 },
  ...overrides,
});

/**
 * The shape `GET /api/providers/sessions/:id` returns. `hasQuayConfig` is the
 * Tier-1 reading the server adds for the synthesized copy's benefit.
 */
const sessionDetailsPayload = (hasQuayConfig: boolean) => ({
  ok: true,
  json: async () => ({
    data: {
      sessionId: DEEP_LINK_SESSION_ID,
      provider: 'claude',
      summary: 'Deep link',
      project: {
        projectId: PROJECT_ID,
        path: '/repo',
        fullPath: '/repo',
        displayName: 'Repo',
        isStarred: false,
        hasQuayConfig,
      },
    },
  }),
});

type ServerEventListener = (event: { kind: string }) => void;

const listeners = new Set<ServerEventListener>();

const renderProjectsState = async () => {
  const { useProjectsState } = await import(
    '@/modules/project-workspace/hooks/useProjectsState'
  );

  return renderHook(() =>
    useProjectsState({
      sessionId: DEEP_LINK_SESSION_ID,
      navigate: vi.fn(),
      subscribe: (listener: ServerEventListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      isMobile: false,
      isSessionProcessing: () => false,
    }),
  );
};

/**
 * Holds `/api/projects` open until `release` is called, so the deep-link
 * session lookup (which resolves first in the real cold start) is the only
 * source of the selected copy's fields.
 */
const holdProjectsOpen = () => {
  let releaseProjects: (projects: Project[]) => void = () => {};
  const projectsInFlight = new Promise<Project[]>((resolve) => {
    releaseProjects = resolve;
  });
  projectsResponse.mockImplementation(async () => ({
    ok: true,
    json: async () => await projectsInFlight,
  }));
  return (projects: Project[]) => releaseProjects(projects);
};

beforeEach(() => {
  localStorage.clear();
  projectsResponse.mockReset();
  sessionDetailsResponse.mockReset();
  listeners.clear();
});

// Warms the module graph below, so its cold compile is charged to hookTimeout
// rather than to the first case's testTimeout.
beforeAll(async () => {
  await import('@/modules/project-workspace/hooks/useProjectsState');
});

afterEach(() => {
  vi.resetModules();
});

test('a cold-start deep link carries the Tier-1 reading before the project list lands', async () => {
  const releaseProjects = holdProjectsOpen();
  sessionDetailsResponse.mockResolvedValue(sessionDetailsPayload(true));

  const { result } = await renderProjectsState();

  // `/api/projects` is still in flight; only the synthesized copy exists.
  await waitFor(() => {
    assert.equal(result.current.selectedProject?.projectId, PROJECT_ID);
  });
  assert.equal(
    result.current.selectedProject?.hasQuayConfig,
    true,
    'the synthesized copy must carry the Tier-1 reading, not wait for the list',
  );

  // The list arrives later with the same reading; the copy must stay true, not
  // fall back to `undefined`/`false`.
  await act(async () => {
    releaseProjects([buildProject({ hasQuayConfig: true })]);
  });
  await waitFor(() => {
    assert.equal(result.current.projects.length, 1);
  });
  assert.equal(result.current.selectedProject?.hasQuayConfig, true);
});

test('a late project list can flip the synthesized reading to false', async () => {
  const releaseProjects = holdProjectsOpen();
  sessionDetailsResponse.mockResolvedValue(sessionDetailsPayload(true));

  const { result } = await renderProjectsState();
  await waitFor(() => {
    assert.equal(result.current.selectedProject?.hasQuayConfig, true);
  });

  // The project lost its `.quay/config.yml` between the two reads: an incoming
  // `false` must win over the stale `true` (`??` keeps a real boolean, it does
  // not fall through on `false`).
  await act(async () => {
    releaseProjects([buildProject({ hasQuayConfig: false })]);
  });
  await waitFor(() => {
    assert.equal(result.current.selectedProject?.hasQuayConfig, false);
  });
});
