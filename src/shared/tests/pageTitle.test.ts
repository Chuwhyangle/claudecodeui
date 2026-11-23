import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { Project, ProjectSession } from '@/shared/types';
import { getPageTitle, syncAwaitingReplyTitleIndicator } from '@/shared/utils';

const project: Project = {
  projectId: 'project-1',
  displayName: 'My Project',
  fullPath: '/projects/my-project',
};

test('uses the selected session summary as the page title', () => {
  const session: ProjectSession = {
    id: 'session-1',
    summary: 'Fix browser tab title',
    __provider: 'claude',
  };

  assert.equal(getPageTitle(project, session), 'Fix browser tab title');
});

test('uses the selected Cursor session name as the page title', () => {
  const session: ProjectSession = {
    id: 'session-1',
    name: 'Cursor session name',
    __provider: 'cursor',
  };

  assert.equal(getPageTitle(project, session), 'Cursor session name');
});

test('falls back to the project title when no session is selected', () => {
  assert.equal(getPageTitle(project, null), 'My Project - Cloudpit');
});

test('falls back to the app title when no project or session is selected', () => {
  assert.equal(getPageTitle(null, null), 'Cloudpit');
});

test('the awaiting-reply marker counts the list and is replaced, not stacked', () => {
  document.title = 'Cloudpit';

  syncAwaitingReplyTitleIndicator(2);
  assert.equal(document.title, '[待回复 2] Cloudpit');

  syncAwaitingReplyTitleIndicator(5);
  assert.equal(document.title, '[待回复 5] Cloudpit', 'one marker, always the newest count');

  syncAwaitingReplyTitleIndicator(0);
  assert.equal(document.title, 'Cloudpit', 'an empty list takes the marker away');
});

test('the awaiting-reply marker is inserted after the completion marker, so its strip still works', () => {
  document.title = '[Done] Cloudpit';

  syncAwaitingReplyTitleIndicator(1);

  assert.equal(document.title, '[Done] [待回复 1] Cloudpit');
  assert.ok(document.title.startsWith('[Done] '), 'pageTitleNotification strips by this prefix');
});
