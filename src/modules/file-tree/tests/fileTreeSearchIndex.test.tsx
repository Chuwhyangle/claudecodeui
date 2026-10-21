import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

/**
 * The Files-tab search reads disk truth, not the git-aligned reference index.
 *
 * The tree shows everything on disk (including gitignored paths, `.git/` and
 * `node_modules/`), so a search that offered only `git ls-files` paths would
 * hide files the user can see. The readings here are:
 *
 *  - a query reads the dedicated search-index endpoint and returns matches
 *    from it, including a file under a gitignored directory;
 *  - the reference index endpoint is never asked — search is not a reference
 *    surface any more;
 *  - the walk is not paid for while browsing (no query, no request), and one
 *    project's index is one request shared by every mounted tree.
 */

const state = vi.hoisted(() => ({
  getFileTreeSearchIndex: vi.fn(),
  getFileIndex: vi.fn(),
}));

vi.mock('@/shared/api', () => ({
  api: {
    getFileTreeSearchIndex: state.getFileTreeSearchIndex,
    getFileIndex: state.getFileIndex,
  },
}));

type IndexEntry = { name: string; path: string };

const PROJECT_A = 'project-a';

// A gitignored `.archguard/` output file is the discriminator: it exists on
// disk and the tree shows it, but `git ls-files` never lists it.
const SEARCH_FILES_A: IndexEntry[] = [
  { name: 'package.mmd', path: '/repo-a/.archguard/output/overview/package.mmd' },
  { name: 'index.ts', path: '/repo-a/src/index.ts' },
];
const SEARCH_FILES_B: IndexEntry[] = [{ name: 'other.tsx', path: '/repo-b/src/other.tsx' }];

const okJson = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
  // The search-index cache is module scope, so each case gets a fresh module
  // graph; an ambient copy would make "one request per project" true for the
  // wrong reason.
  vi.resetModules();
  state.getFileTreeSearchIndex.mockReset();
  state.getFileIndex.mockReset();
  state.getFileTreeSearchIndex.mockImplementation((projectId: string) =>
    okJson({
      files: (projectId === PROJECT_A ? SEARCH_FILES_A : SEARCH_FILES_B).map((entry) => ({
        ...entry,
        type: 'file',
      })),
      truncated: false,
    }),
  );
  state.getFileIndex.mockImplementation(() => {
    throw new Error('the Files-tab search must not read the reference file index');
  });
});

const loadSearchHook = async () => {
  const { useFileTreeSearch } = await import('@/modules/file-tree/hooks/useFileTreeSearch');
  return useFileTreeSearch;
};

test('a query returns matches from the search index, including gitignored paths', async () => {
  const useFileTreeSearch = await loadSearchHook();
  const { result } = renderHook(() => useFileTreeSearch({ files: [], projectId: PROJECT_A }));

  act(() => result.current.setSearchQuery('package'));

  await waitFor(() => assert.deepEqual(result.current.filteredFiles, [
    {
      type: 'file',
      name: 'package.mmd',
      path: '/repo-a/.archguard/output/overview/package.mmd',
    },
  ]));

  assert.equal(state.getFileTreeSearchIndex.mock.calls.length, 1);
  assert.deepEqual(state.getFileTreeSearchIndex.mock.calls[0], [PROJECT_A]);
  assert.equal(state.getFileIndex.mock.calls.length, 0, 'search is not a reference consumer');
});

test('browsing without a query pays for no index walk', async () => {
  const useFileTreeSearch = await loadSearchHook();
  const treeFiles = [{ type: 'directory' as const, name: 'src', path: '/repo-a/src' }];
  const { result } = renderHook(() => useFileTreeSearch({ files: treeFiles, projectId: PROJECT_A }));

  assert.deepEqual(result.current.filteredFiles, treeFiles, 'an empty query shows the tree as-is');
  assert.equal(state.getFileTreeSearchIndex.mock.calls.length, 0);

  act(() => result.current.setSearchQuery('index'));
  await waitFor(() => assert.deepEqual(
    result.current.filteredFiles.map((file) => file.name),
    ['index.ts'],
  ));
  assert.equal(state.getFileTreeSearchIndex.mock.calls.length, 1);
});

test('one project is one search-index request shared by every mounted tree', async () => {
  const useFileTreeSearch = await loadSearchHook();
  const first = renderHook(() => useFileTreeSearch({ files: [], projectId: PROJECT_A }));
  const second = renderHook(() => useFileTreeSearch({ files: [], projectId: PROJECT_A }));

  act(() => first.result.current.setSearchQuery('index'));
  act(() => second.result.current.setSearchQuery('index'));

  await waitFor(() => {
    assert.deepEqual(first.result.current.filteredFiles.map((file) => file.name), ['index.ts']);
    assert.deepEqual(second.result.current.filteredFiles.map((file) => file.name), ['index.ts']);
  });
  assert.equal(state.getFileTreeSearchIndex.mock.calls.length, 1, 'one project, one walk');
  assert.equal(second.result.current.filteredFiles[0]?.path, first.result.current.filteredFiles[0]?.path);
});

test('search reads the search index and never imports the reference hook', () => {
  const root = process.cwd();
  const searchSource = readFileSync(
    resolve(root, 'src/modules/file-tree/hooks/useFileTreeSearch.ts'),
    'utf8',
  );
  assert.match(searchSource, /useFileTreeSearchIndex/);
  assert.doesNotMatch(searchSource, /useProjectFileIndex|loadProjectFileIndex/);

  const apiSource = readFileSync(resolve(root, 'src/shared/api.ts'), 'utf8');
  assert.match(apiSource, /files-search-index/, 'the search endpoint is shipped in the api surface');
  assert.doesNotMatch(apiSource, /\bgetFiles\b/, 'the retired full-tree fetch stays retired');
});
