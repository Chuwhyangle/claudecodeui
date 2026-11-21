import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

import type { Project, SidebarProjectListProps } from '@/shared/types';

/**
 * A 587-project workspace was mounting every project row: 14,683 DOM nodes, 154 of the
 * 172 nesting levels owned by the project list. The list now mounts a bounded window,
 * with the selected and expanded rows pinned so the budget can never hide the row the
 * user is interacting with, and a "Show all projects" control that restores the full set.
 *
 * The row is stubbed: these readings are about HOW MANY rows mount and WHICH ones, and
 * the row's own interactions are covered by SidebarProjectItem.test.tsx and
 * projectToggleExpansion.test.tsx. The stub keeps the real row testid so the readings
 * are the same DOM query a live audit uses.
 */
vi.mock('@/modules/sidebar/SidebarProjectItem', () => ({
  default: ({ project }: { project: Project }) =>
    React.createElement('div', {
      'data-testid': 'sidebar-project-row',
      'data-project-id': project.projectId,
    }),
}));

const { default: SidebarProjectList, PROJECT_LIST_RENDER_BUDGET } =
  await import('@/modules/sidebar/SidebarProjectList');

const makeProject = (index: number): Project => ({
  projectId: `project-${index}`,
  name: `Project ${index}`,
  displayName: `Project ${index}`,
  fullPath: `/tmp/project-${index}`,
  sessions: [],
}) as unknown as Project;

const PROJECTS: Project[] = Array.from({ length: 120 }, (_, index) => makeProject(index));

const noop = () => {};
const t = ((key: string) => key) as unknown as SidebarProjectListProps['t'];

const listProps = (overrides: Partial<SidebarProjectListProps> = {}): SidebarProjectListProps => ({
  projects: PROJECTS,
  filteredProjects: PROJECTS,
  selectedProject: null,
  selectedSession: null,
  isLoading: false,
  loadingProgress: null,
  isProjectExpanded: () => false,
  activeRename: null,
  initialSessionsLoaded: new Set(),
  currentTime: new Date('2026-11-21T10:00:00.000Z'),
  deletingProjects: new Set(),
  tasksEnabled: false,
  mcpServerStatus: null,
  getProjectSessions: () => [],
  onLoadMoreSessions: noop,
  loadingMoreProjects: new Set(),
  activeSessions: new Set(),
  attentionSessionIds: new Set(),
  isProjectStarred: () => false,
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
  onForkSession: noop,
  onNewSession: noop,
  onStartEditingSession: noop,
  onCancelEditingSession: noop,
  onSaveEditingSession: noop,
  t,
  ...overrides,
});

/** The exact DOM query a live audit runs, so a reading here means the same thing. */
const mountedProjectIds = (): string[] =>
  Array.from(document.querySelectorAll('[data-testid="sidebar-project-row"]'))
    .map((element) => element.getAttribute('data-project-id') ?? '');

test('bounded window pins selection and expansion, and "show all" restores every project', () => {
  const selectedProject = PROJECTS[110];
  const expandedProjectId = PROJECTS[75].projectId;

  render(
    React.createElement(SidebarProjectList, listProps({
      // Both stateful rows sort past the window: the budget has to reach them anyway.
      selectedProject,
      isProjectExpanded: (projectId) => projectId === expandedProjectId,
    })),
  );

  const initialIds = mountedProjectIds();
  const initialRows = initialIds.length;
  const selectedRendered = initialIds.includes(selectedProject.projectId);
  const expandedRendered = initialIds.includes(expandedProjectId);
  const totalProjects = PROJECTS.length;

  console.log(
    `initialRows<=50 selectedRendered=${selectedRendered} expandedRendered=${expandedRendered} totalProjects=${totalProjects} (measured initialRows=${initialRows})`,
  );

  assert.equal(totalProjects, 120);
  assert.equal(initialRows, PROJECT_LIST_RENDER_BUDGET);
  assert.equal(initialRows, 50);
  assert.equal(selectedRendered, true);
  assert.equal(expandedRendered, true);
  // The window is the pinned rows plus the top of the list — never an arbitrary slice.
  assert.deepEqual(
    initialIds,
    [
      ...PROJECTS.slice(0, 48).map((project) => project.projectId),
      expandedProjectId,
      selectedProject.projectId,
    ],
  );

  fireEvent.click(screen.getByTestId('sidebar-project-show-all'));

  const allIds = mountedProjectIds();
  console.log(`allRows=${allIds.length}`);

  assert.equal(allIds.length, 120);
  assert.deepEqual(allIds, PROJECTS.map((project) => project.projectId));
  // The control has nothing left to reveal, so it leaves the DOM.
  assert.equal(document.querySelector('[data-testid="sidebar-project-show-all"]'), null);
});

test('a project search is the requested set, so a match past the window still renders', () => {
  const match = PROJECTS[110];

  render(
    React.createElement(SidebarProjectList, listProps({
      // What the sidebar hands down while a name filter is narrowing the list: the full
      // project set stays intact, `filteredProjects` is the match. The match at index
      // 110 is far past the 50-row window.
      filteredProjects: [match],
    })),
  );

  const ids = mountedProjectIds();
  const searchMatchRendered = ids.includes(match.projectId);
  console.log(`searchMatchRendered=${searchMatchRendered} rows=${ids.length}`);

  assert.equal(searchMatchRendered, true);
  assert.deepEqual(ids, [match.projectId]);
  // Nothing is withheld, so the reveal control is not offered.
  assert.equal(document.querySelector('[data-testid="sidebar-project-show-all"]'), null);
});
