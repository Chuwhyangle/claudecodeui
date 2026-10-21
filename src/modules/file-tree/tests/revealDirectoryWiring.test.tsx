import assert from 'node:assert/strict';

import { render, screen, waitFor } from '@testing-library/react';
import { test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * Regression guard for the wiring, not the maths: a directory reference clicked
 * in the chat reaches the tree as the model wrote it — relative to the project
 * root — while every node here is keyed by its absolute path. Rendering the
 * real tree is what proves the two ends still meet.
 */

const ROOT = '/home/odoo/workspace/personal';

// The Files tab reads one directory at a time: the root listing carries the
// folder (marked expandable), and the folder's own listing is a second request
// made only because the reveal asks for it.
const listings: Record<string, unknown> = {
  '': {
    path: ROOT,
    entries: [
      { type: 'directory', name: 'decisions', path: `${ROOT}/decisions`, hasChildren: true },
    ],
    truncated: false,
  },
  [`${ROOT}/decisions`]: {
    path: `${ROOT}/decisions`,
    entries: [{ type: 'file', name: '0001-first.md', path: `${ROOT}/decisions/0001-first.md` }],
    truncated: false,
  },
};

vi.mock('@/shared/api', () => ({
  api: {
    getDirectory: async (_projectId: string, directoryPath: string) => ({
      ok: true,
      json: async () => listings[directoryPath] ?? { path: directoryPath, entries: [], truncated: false },
    }),
  },
}));

const { default: FileTree } = await import('@/modules/file-tree/FileTree');

const project: Project = { projectId: 'p1', displayName: 'personal', fullPath: ROOT, path: ROOT };

test('a relative directory reference expands that folder in the tree', async () => {
  render(<FileTree selectedProject={project} revealDirectory={{ path: 'decisions/' }} />);

  await waitFor(() => assert.ok(screen.getByText('decisions')));
  // Visible only because the folder was expanded for us.
  await waitFor(() => assert.ok(screen.getByText('0001-first.md')));
});

test('a folder nobody asked for stays closed', async () => {
  render(<FileTree selectedProject={project} revealDirectory={null} />);

  await waitFor(() => assert.ok(screen.getByText('decisions')));
  assert.equal(screen.queryByText('0001-first.md'), null);
});
