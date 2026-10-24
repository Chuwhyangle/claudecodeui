import assert from 'node:assert/strict';

import { render, waitFor } from '@testing-library/react';
import type { TFunction } from 'i18next';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, test, vi } from 'vitest';

import type { Project } from '@/shared/types';
import type { SidebarProjectItemProps } from '@/modules/sidebar/SidebarProjectItem';

/**
 * AC4: the project row's 「在驾驶舱中查看」 link.
 *
 * The REAL row and the REAL shared fleet store run; only the fleet transport is replaced.
 * The fleet registry id — not the CloudCLI project id — is the address the link must carry,
 * and a project the fleet does not register must not draw the action at all.
 */

const apiMock = vi.hoisted(() => ({ quayFleetSummary: vi.fn() }));
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

const fleetProject = (projectId: string, fleetProjectId: string | null) => ({
  projectId,
  ...(fleetProjectId === null ? {} : { fleetProjectId }),
  projectPath: `/work/${projectId}`,
  driver: { state: 'idle' },
  tasks: { total: 0, todo: 0, ready: 0, needsHuman: 0, done: 0 },
  cached: false,
  error: null,
});

const FLEET_SUMMARY = {
  projects: [fleetProject('registered', 'claudecodeui'), fleetProject('plain', null)],
  fleet: { available: true, reason: null, state: 'ok' },
  generatedAt: '2026-10-24T00:00:00.000Z',
  ttlPerProjectMs: 120_000,
  cached: false,
};

const noop = () => {};
const t = ((key: string) => key) as unknown as TFunction;

function makeProject(projectId: string): Project {
  return {
    projectId,
    displayName: projectId,
    fullPath: `/tmp/${projectId}`,
    hasQuayConfig: true,
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
  currentTime: new Date('2026-10-24T00:00:00.000Z'),
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

const renderRow = async (project: Project) => {
  const { default: SidebarProjectItem } = await import('@/modules/sidebar/SidebarProjectItem');
  return render(
    <MemoryRouter>
      <SidebarProjectItem {...(rowProps(project) as unknown as SidebarProjectItemProps)} />
    </MemoryRouter>,
  );
};

beforeEach(() => {
  compactState.compact = false;
  apiMock.quayFleetSummary.mockReset();
  apiMock.quayFleetSummary.mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => FLEET_SUMMARY,
  }));
  // The fleet reading is module-level in the shared store; a cold import per case keeps it so.
  vi.resetModules();
});

vi.setConfig({ testTimeout: 20_000 });

test('a registered project links to its board in the cockpit, addressed by the fleet id', async () => {
  const { container } = await renderRow(makeProject('registered'));

  await waitFor(() =>
    assert.notEqual(container.querySelector('[data-testid="cockpit-project-link"]'), null),
  );
  const link = container.querySelector('[data-testid="cockpit-project-link"]') as HTMLAnchorElement;
  assert.equal(link.getAttribute('data-cockpit-project'), 'claudecodeui');
  assert.equal(link.getAttribute('href'), '/cockpit?view=board&project=claudecodeui');
  assert.equal(link.getAttribute('aria-label'), 'common:cockpit.openProject');
  // The CloudCLI id is not an address: it must never appear in the link.
  assert.doesNotMatch(link.getAttribute('href') ?? '', /project=registered/);
});

test('a project the fleet does not register has no such action', async () => {
  const { container } = await renderRow(makeProject('plain'));

  // The fleet read still happens (the store covers the whole fleet); the row simply has no
  // addressable board for this project.
  await waitFor(() => assert.equal(apiMock.quayFleetSummary.mock.calls.length, 1));
  assert.equal(container.querySelector('[data-testid="cockpit-project-link"]'), null);
});

test('the compact (mobile) card draws the same action', async () => {
  compactState.compact = true;
  const { container } = await renderRow(makeProject('registered'));

  await waitFor(() =>
    assert.notEqual(container.querySelector('[data-testid="cockpit-project-link"]'), null),
  );
  const link = container.querySelector('[data-testid="cockpit-project-link"]') as HTMLAnchorElement;
  assert.equal(link.getAttribute('href'), '/cockpit?view=board&project=claudecodeui');
});
