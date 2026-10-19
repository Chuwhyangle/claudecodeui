import assert from 'node:assert/strict';

import { render, waitFor } from '@testing-library/react';
import type { TFunction } from 'i18next';
import React from 'react';
import { beforeEach, test, vi } from 'vitest';

import type { Project } from '@/shared/types';
import type { SidebarProjectItemProps } from '@/modules/sidebar/SidebarProjectItem';

/**
 * The project-row task badge: both sidebar layouts (desktop button and compact card)
 * render the counts the fleet-summary endpoint returns, and a non-quay project's row
 * is unchanged. The API module is mocked at its seam so the REAL `useFleetTaskCounts`
 * hook and the real component run; only the transport is replaced.
 */

const apiMock = vi.hoisted(() => ({
  quayFleetSummary: vi.fn(),
}));

const compactState = vi.hoisted(() => ({ compact: false }));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    api: { ...(actual.api as Record<string, unknown>), quayFleetSummary: apiMock.quayFleetSummary },
  };
});

vi.mock('@/modules/sidebar/hooks/useCompactSidebar', () => ({
  useCompactSidebar: () => compactState.compact,
}));

/** The endpoint reading the badge must reproduce, field for field. */
const FLEET_SUMMARY = {
  projects: [
    {
      projectId: 'quay-a',
      projectPath: '/tmp/quay-a',
      driver: { state: 'idle' },
      tasks: { total: 7, todo: 2, ready: 3, needsHuman: 1, done: 1 },
      cached: false,
      error: null,
    },
  ],
  generatedAt: '2026-10-19T00:00:00.000Z',
  ttlPerProjectMs: 120_000,
  cached: false,
};

const noop = () => {};
const t = ((key: string) => key) as unknown as TFunction;

function makeProject(projectId: string, hasQuayConfig: boolean): Project {
  return {
    projectId,
    name: projectId,
    displayName: projectId,
    fullPath: `/tmp/${projectId}`,
    hasQuayConfig,
    sessions: [],
  } as unknown as Project;
}

const rowProps = (project: Project) => ({
  project,
  selectedProject: null,
  selectedSession: null,
  isExpanded: false,
  isDeleting: false,
  isStarred: false,
  isEditing: false,
  renameDraft: '',
  sessions: [],
  initialSessionsLoaded: true,
  isLoadingMoreSessions: false,
  currentTime: new Date('2026-10-19T00:00:00.000Z'),
  sessionRenameId: null,
  sessionRenameDraft: '',
  tasksEnabled: false,
  mcpServerStatus: null,
  onRenameDraftChange: noop,
  onToggleProject: noop,
  onProjectSelect: noop,
  onToggleStarProject: noop,
  onStartEditingProject: noop,
  onCancelEditingProject: noop,
  onSaveProjectName: noop,
  onDeleteProject: noop,
  onSessionSelect: noop,
  onDeleteSession: noop,
  onLoadMoreSessions: noop,
  activeSessions: new Set<string>(),
  attentionSessionIds: new Set<string>(),
  onNewSession: noop,
  isShowingHiddenSessions: false,
  onStartEditingSession: noop,
  onCancelEditingSession: noop,
  onSaveEditingSession: noop,
  t,
});

/** Reads the badge's data attributes, failing loudly when no badge was rendered. */
function readBadge(container: HTMLElement): { todo: string | null; ready: string | null; needsHuman: string | null } {
  const badge = container.querySelector('[data-project-task-counts]');
  assert.notEqual(badge, null, 'the quay project row must render a task badge');
  return {
    todo: badge!.getAttribute('data-task-todo'),
    ready: badge!.getAttribute('data-task-ready'),
    needsHuman: badge!.getAttribute('data-task-needs-human'),
  };
}

beforeEach(() => {
  compactState.compact = false;
  apiMock.quayFleetSummary.mockReset();
  apiMock.quayFleetSummary.mockImplementation(async () => new Response(JSON.stringify(FLEET_SUMMARY), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
  // The hook keeps one module-level reading; resetting the registry gives each test a cold one.
  vi.resetModules();
});

test('desktop (non-compact) row renders the fleet-summary task counts', async () => {
  const { default: SidebarProjectItem } = await import('@/modules/sidebar/SidebarProjectItem');
  compactState.compact = false;

  const { container } = render(
    <SidebarProjectItem {...(rowProps(makeProject('quay-a', true)) as unknown as SidebarProjectItemProps)} />,
  );

  await waitFor(() => assert.notEqual(container.querySelector('[data-project-task-counts]'), null));

  const badge = readBadge(container);
  assert.deepEqual(badge, { todo: '2', ready: '3', needsHuman: '1' });
  // Exactly one shared read for the whole sidebar, not one per row.
  assert.equal(apiMock.quayFleetSummary.mock.calls.length, 1);
});

test('compact (mobile) row renders the same fleet-summary task counts', async () => {
  const { default: SidebarProjectItem } = await import('@/modules/sidebar/SidebarProjectItem');
  compactState.compact = true;

  const { container } = render(
    <SidebarProjectItem {...(rowProps(makeProject('quay-a', true)) as unknown as SidebarProjectItemProps)} />,
  );

  await waitFor(() => assert.notEqual(container.querySelector('[data-project-task-counts]'), null));

  const badge = readBadge(container);
  assert.deepEqual(badge, { todo: '2', ready: '3', needsHuman: '1' });
});

test('a project without quay config renders no task badge and keeps its row unchanged', async () => {
  const { default: SidebarProjectItem } = await import('@/modules/sidebar/SidebarProjectItem');
  compactState.compact = false;

  const { container } = render(
    <SidebarProjectItem {...(rowProps(makeProject('plain', false)) as unknown as SidebarProjectItemProps)} />,
  );

  // The shared read still happens (it covers the whole fleet), but this row never shows it.
  await waitFor(() => assert.equal(apiMock.quayFleetSummary.mock.calls.length, 1));
  assert.equal(container.querySelector('[data-project-task-counts]'), null);
});
