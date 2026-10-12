import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { Project } from '@/shared/types';
import { mergeProjectSelectionMetadata } from '@/modules/project-workspace/utils/projectSelectionMetadata';

const selectedProject: Project = {
  projectId: 'project-1',
  displayName: 'Project One',
  fullPath: '/workspace/project-one',
  path: '/workspace/project-one',
  isStarred: false,
  sessions: [{ id: 'session-1', summary: 'Original session' }],
  sessionMeta: { total: 1, hasMore: false },
  taskmaster: { hasTaskmaster: true, status: 'ready' },
};

test('keeps selected-project identity when only sidebar sessions change', () => {
  const sidebarProject: Project = {
    ...selectedProject,
    sessions: [{ id: 'session-2', summary: 'New sidebar session' }],
    sessionMeta: { total: 2, hasMore: false },
  };
  const result = mergeProjectSelectionMetadata(selectedProject, sidebarProject);

  assert.equal(result, selectedProject);
});

test('updates workspace metadata without replacing selected-project sessions', () => {
  const result = mergeProjectSelectionMetadata(selectedProject, {
    ...selectedProject,
    displayName: 'Renamed Project',
    isStarred: true,
  });

  assert.notEqual(result, selectedProject);
  assert.equal(result.displayName, 'Renamed Project');
  assert.equal(result.isStarred, true);
  assert.equal(result.sessions, selectedProject.sessions);
  assert.equal(result.sessionMeta, selectedProject.sessionMeta);
});

test('keeps taskmaster metadata when a realtime project snapshot omits it', () => {
  const result = mergeProjectSelectionMetadata(selectedProject, {
    projectId: selectedProject.projectId,
    displayName: selectedProject.displayName,
    fullPath: selectedProject.fullPath,
    path: selectedProject.path,
    isStarred: selectedProject.isStarred,
  });

  assert.equal(result, selectedProject);
  assert.equal(result.taskmaster, selectedProject.taskmaster);
});

// `hasQuayConfig` is carried by the same merge, because the deep-link copy that
// the session-details payload synthesizes is only corrected by re-merging the
// list. A websocket `session_upserted` project block omits the field entirely,
// so that existing caller must never clear a live reading.
test('keeps the Tier-1 hasQuayConfig reading when a realtime snapshot omits it', () => {
  const withQuayConfig: Project = { ...selectedProject, hasQuayConfig: true };
  const result = mergeProjectSelectionMetadata(withQuayConfig, {
    projectId: withQuayConfig.projectId,
    displayName: withQuayConfig.displayName,
    fullPath: withQuayConfig.fullPath,
    path: withQuayConfig.path,
    isStarred: withQuayConfig.isStarred,
  });

  assert.equal(result, withQuayConfig);
  assert.equal(result.hasQuayConfig, true);
});

test('an incoming hasQuayConfig overrides by value, including false over true', () => {
  const withQuayConfig: Project = { ...selectedProject, hasQuayConfig: true };
  const flippedOff = mergeProjectSelectionMetadata(withQuayConfig, {
    ...withQuayConfig,
    hasQuayConfig: false,
  });

  assert.notEqual(flippedOff, withQuayConfig);
  assert.equal(flippedOff.hasQuayConfig, false);

  const withoutQuayConfig: Project = { ...selectedProject, hasQuayConfig: false };
  const flippedOn = mergeProjectSelectionMetadata(withoutQuayConfig, {
    ...withoutQuayConfig,
    hasQuayConfig: true,
  });

  assert.notEqual(flippedOn, withoutQuayConfig);
  assert.equal(flippedOn.hasQuayConfig, true);
});

test('an unchanged hasQuayConfig keeps the selected object identity', () => {
  const withQuayConfig: Project = { ...selectedProject, hasQuayConfig: true };
  const result = mergeProjectSelectionMetadata(withQuayConfig, { ...withQuayConfig });

  assert.equal(result, withQuayConfig);
});
