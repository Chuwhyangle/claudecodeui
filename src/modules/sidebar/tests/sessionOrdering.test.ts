import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { Project } from '@/shared/types';
import { getAllSessions } from '@/modules/sidebar/utils/sidebarProjectFormatting';

/**
 * The sidebar's session order. A row the user has dragged carries a
 * `sessionOrder` and must never move again because another session became
 * active; a row without one — a session created after the list was arranged —
 * sits above the arranged block, newest first. A project nobody arranged keeps
 * the plain recency order it had before the column existed.
 */

const projectWith = (sessions: Array<{ id: string; lastActivity: string; sessionOrder?: number | null }>): Project => ({
  projectId: 'project-1',
  name: 'project-1',
  displayName: 'project-1',
  fullPath: '/tmp/project-1',
  sessions,
}) as unknown as Project;

const idsOf = (project: Project): string[] => getAllSessions(project).map((session) => session.id);

test('arranged rows keep the order the user dropped them into, whatever their activity', () => {
  const project = projectWith([
    { id: 'second', lastActivity: '2026-08-25T12:00:00.000Z', sessionOrder: 1 },
    { id: 'first', lastActivity: '2026-08-19T08:00:00.000Z', sessionOrder: 0 },
    { id: 'third', lastActivity: '2026-08-21T08:00:00.000Z', sessionOrder: 2 },
  ]);

  assert.deepEqual(idsOf(project), ['first', 'second', 'third']);
});

test('a session created after the list was arranged sits above it, newest first', () => {
  const project = projectWith([
    { id: 'arranged-second', lastActivity: '2026-08-25T12:00:00.000Z', sessionOrder: 1 },
    { id: 'newest-unarranged', lastActivity: '2026-08-26T09:00:00.000Z', sessionOrder: null },
    { id: 'arranged-first', lastActivity: '2026-08-19T08:00:00.000Z', sessionOrder: 0 },
    { id: 'older-unarranged', lastActivity: '2026-08-24T09:00:00.000Z' },
  ]);

  assert.deepEqual(
    idsOf(project),
    ['newest-unarranged', 'older-unarranged', 'arranged-first', 'arranged-second'],
  );
});

test('a project nobody arranged keeps the pure recency order it had before', () => {
  const project = projectWith([
    { id: 'older', lastActivity: '2026-08-19T08:00:00.000Z' },
    { id: 'newest', lastActivity: '2026-08-22T08:00:00.000Z' },
    { id: 'middle', lastActivity: '2026-08-20T08:00:00.000Z' },
  ]);

  assert.deepEqual(idsOf(project), ['newest', 'middle', 'older']);
});
