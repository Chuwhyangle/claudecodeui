import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

/**
 * One flat file index for every filename-reference surface.
 *
 * Three frontend consumers used to ask the project for its whole tree and then
 * flatten it themselves: @-mentions (`useFileMentions`), the command palette
 * (`useFilesSource`) and bare-filename resolution (`useFileOpenResolver`). They
 * all need the same flat `{name, path}[]`, so the readings are:
 *
 *  - one project asks the endpoint once, no matter how many consumers mount,
 *    and every consumer reads the same cached array;
 *  - a project switch is one new request for all of them, not one per consumer;
 *  - none of the three keeps its own full-tree fetch.
 *
 * Files-tab search used to be a fourth consumer; it now reads its own
 * unfiltered search index (disk truth) and is pinned by
 * `fileTreeSearchIndex.test.tsx`, so this file also asserts it stays out.
 *
 * The last reading is taken from the shipped sources as text, because the
 * consumers live in different modules and this test lives in `file-tree`: a
 * cross-module deep import here would itself violate the barrel rule the
 * criterion asserts. The request-count readings above are taken on the shared
 * hook the three now read, mounted three times.
 */

const state = vi.hoisted(() => ({
  getFileIndex: vi.fn(),
}));

vi.mock('@/shared/api', () => ({
  api: {
    getFileIndex: state.getFileIndex,
  },
}));

type IndexEntry = { name: string; path: string };

const PROJECT_A = 'project-a';
const PROJECT_B = 'project-b';

const FILES_A: IndexEntry[] = [
  { name: 'voice.routes.ts', path: '/repo-a/src/voice.routes.ts' },
  { name: 'README.md', path: '/repo-a/README.md' },
];
const FILES_B: IndexEntry[] = [{ name: 'other.tsx', path: '/repo-b/src/other.tsx' }];

const okJson = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
  // The index cache is module scope, so each case gets a fresh module graph;
  // an ambient copy would carry a previous case's project ids and make "one
  // request per project" true for the wrong reason.
  vi.resetModules();
  state.getFileIndex.mockReset();
  state.getFileIndex.mockImplementation((projectId: string) =>
    okJson({
      files: (projectId === PROJECT_A ? FILES_A : FILES_B).map((entry) => ({
        ...entry,
        type: 'file',
      })),
      truncated: false,
    }),
  );
});

const loadIndexHook = async () => {
  const { useProjectFileIndex } = await import('@/modules/file-tree');
  return useProjectFileIndex;
};

type Consumer = {
  result: { current: { files: IndexEntry[] } };
  rerender: (props: { projectId: string }) => void;
};

const mountConsumers = (
  useProjectFileIndex: Awaited<ReturnType<typeof loadIndexHook>>,
  count: number,
): Consumer[] =>
  Array.from({ length: count }, () =>
    renderHook(({ projectId }) => useProjectFileIndex(projectId), {
      initialProps: { projectId: PROJECT_A },
    }),
  );

const settleOn = async (consumers: Consumer[], files: IndexEntry[]) => {
  await waitFor(() => {
    for (const consumer of consumers) {
      assert.deepEqual(consumer.result.current.files, files);
    }
  });
};

test('three consumers on one project join one files-index request and read one list', async () => {
  const useProjectFileIndex = await loadIndexHook();
  const consumers = mountConsumers(useProjectFileIndex, 3);

  await settleOn(consumers, FILES_A);

  assert.equal(state.getFileIndex.mock.calls.length, 1, 'one project, one request');
  assert.deepEqual(state.getFileIndex.mock.calls[0], [PROJECT_A]);

  const sharedList = consumers[0].result.current.files;
  for (const consumer of consumers) {
    assert.equal(
      consumer.result.current.files,
      sharedList,
      'every consumer reads the same cached {name,path}[]',
    );
  }
});

test('switching projects starts one new request for all consumers', async () => {
  const useProjectFileIndex = await loadIndexHook();
  const consumers = mountConsumers(useProjectFileIndex, 3);
  await settleOn(consumers, FILES_A);
  assert.equal(state.getFileIndex.mock.calls.length, 1);

  for (const consumer of consumers) {
    consumer.rerender({ projectId: PROJECT_B });
  }
  await settleOn(consumers, FILES_B);

  assert.equal(
    state.getFileIndex.mock.calls.length,
    2,
    'a project switch is one more request, not one per consumer',
  );
  assert.deepEqual(state.getFileIndex.mock.calls[1], [PROJECT_B]);

  const sharedList = consumers[0].result.current.files;
  for (const consumer of consumers) {
    assert.equal(consumer.result.current.files, sharedList);
  }
});

test('no project open, or a consumer that has not asked, sends nothing', async () => {
  const useProjectFileIndex = await loadIndexHook();
  const idle = renderHook(() => useProjectFileIndex(null));
  const gated = renderHook(
    ({ enabled }: { enabled: boolean }) => useProjectFileIndex(PROJECT_A, enabled),
    { initialProps: { enabled: false } },
  );

  assert.deepEqual(idle.result.current.files, []);
  assert.deepEqual(gated.result.current.files, []);
  assert.equal(state.getFileIndex.mock.calls.length, 0);

  gated.rerender({ enabled: true });
  await waitFor(() => assert.deepEqual(gated.result.current.files, FILES_A));
  assert.equal(state.getFileIndex.mock.calls.length, 1);
});

test('an unreadable index degrades to an empty list and is not re-asked', async () => {
  state.getFileIndex.mockImplementation(() =>
    okJson({
      files: [{ name: 'ok.ts', path: '/repo/ok.ts' }, { path: '/repo/no-name.ts' }, null],
      truncated: false,
    }),
  );

  const useProjectFileIndex = await loadIndexHook();
  const first = renderHook(() => useProjectFileIndex(PROJECT_A));
  await waitFor(() => assert.equal(first.result.current.loading, false));
  assert.deepEqual(first.result.current.files, [{ name: 'ok.ts', path: '/repo/ok.ts' }]);

  // A second consumer joins the settled (failed-shape) answer instead of paying
  // another round trip.
  const second = renderHook(() => useProjectFileIndex(PROJECT_A));
  await waitFor(() => assert.equal(second.result.current.loading, false));
  assert.deepEqual(second.result.current.files, first.result.current.files);
  assert.equal(state.getFileIndex.mock.calls.length, 1);
});

test('the three reference consumers read the shared index and keep no full-tree fetch', async () => {
  const consumers = [
    ['@-mentions', 'src/modules/chat/hooks/useFileMentions.tsx'],
    ['command palette', 'src/modules/command-palette/hooks/useFilesSource.ts'],
    ['bare-name resolution', 'src/modules/project-workspace/hooks/useFileOpenResolver.ts'],
  ] as const;
  const root = process.cwd();

  for (const [label, relativePath] of consumers) {
    const source = readFileSync(resolve(root, relativePath), 'utf8');
    assert.match(source, /useProjectFileIndex|loadProjectFileIndex/, `${label} reads the shared index`);
    assert.doesNotMatch(source, /\bgetFiles\b/, `${label} keeps no full-tree fetch`);

    assert.match(source, /from '@\/modules\/file-tree'/, `${label} reaches the hook through the barrel`);
    assert.doesNotMatch(
      source,
      /from '@\/modules\/file-tree\//,
      `${label} does not deep-import the file-tree module`,
    );
  }

  // Files-tab search is no longer a reference consumer: it reads the
  // unfiltered search index. Leaving it wired to this one would make the Files
  // tab offer exactly what git tracks while the tree above it shows more.
  const searchSource = readFileSync(
    resolve(root, 'src/modules/file-tree/hooks/useFileTreeSearch.ts'),
    'utf8',
  );
  assert.doesNotMatch(searchSource, /useProjectFileIndex|loadProjectFileIndex/);

  // Importing the hook in this file happens through `@/modules/file-tree`; the
  // barrel is what makes that legal, so the barrel must really export it.
  const barrel = readFileSync(resolve(root, 'src/modules/file-tree/index.ts'), 'utf8');
  assert.match(barrel, /useProjectFileIndex/);
  assert.match(barrel, /loadProjectFileIndex/);
  assert.equal(typeof (await loadIndexHook()), 'function');
});
