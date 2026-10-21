import assert from 'node:assert/strict';

import { beforeEach, test, vi } from 'vitest';

import { repairIdentifiers } from '@/shared/identifierRepair';

/**
 * The candidate source the transcript repair is fed from.
 *
 * `identifierRepair.test.ts` already covers what the repair does with a list of
 * names; nothing covered where that list comes from, and every way the source can
 * fail is a way the dictation path has to survive. The two readings that matter
 * are "the names arrive in the shape the repair matches against" and "one session
 * asks the project once".
 *
 * The module memoises its request at module scope, so each test loads a fresh copy
 * after resetting the registry — the ambient copy would otherwise carry the
 * previous test's project ids in its cache and quietly answer from them.
 */

const { getFileIndex } = vi.hoisted(() => ({ getFileIndex: vi.fn() }));

vi.mock('@/shared/api', () => ({ api: { getFileIndex } }));

const load = async () => {
  vi.resetModules();
  return import('@/shared/projectIdentifiers');
};

/** One `200` carrying `body`, in the `Response`-shaped subset the module reads. */
const okJson = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

/** The tree the first flattening reading is written against. */
const TREE = [
  {
    type: 'directory',
    name: 'src',
    path: '/project/src',
    children: [
      { type: 'file', name: 'voice.routes.ts', path: '/project/src/voice.routes.ts' },
      { type: 'file', name: 'useVoiceInput.tsx', path: '/project/src/useVoiceInput.tsx' },
    ],
  },
  { type: 'file', name: 'README.md', path: '/project/README.md' },
];

/** The flat index `GET /api/file-tree/projects/:id/files-index` answers with. */
const INDEX = [
  { type: 'file', name: 'voice.routes.ts', path: '/project/src/voice.routes.ts' },
  { type: 'file', name: 'useVoiceInput.tsx', path: '/project/src/useVoiceInput.tsx' },
  { type: 'file', name: 'README.md', path: '/project/README.md' },
];

beforeEach(() => {
  getFileIndex.mockReset();
  getFileIndex.mockResolvedValue(okJson({ files: INDEX, truncated: false }));
});

test('a file tree is flattened to the two shapes a recogniser breaks', async () => {
  const { flattenProjectIdentifiers } = await load();

  assert.deepEqual(
    [...flattenProjectIdentifiers(TREE)].sort(),
    [
      // The basename: what a dotted, mis-spelled reference is matched against.
      'README.md',
      'useVoiceInput.tsx',
      'voice.routes.ts',
      // The bare stem — the whole name minus its last extension, so `voice.routes.ts`
      // offers `voice.routes` and `README.md` offers `README`. This is the shape a
      // symbol rendered as ordinary words is matched against: "use voice input" carries
      // no dot, so the basename can never reach it.
      'README',
      'useVoiceInput',
      'voice.routes',
    ].sort(),
  );
});

test('a file tree with no files yields no candidates', async () => {
  const { flattenProjectIdentifiers } = await load();

  assert.deepEqual(flattenProjectIdentifiers([]), []);
  // A response the module does not recognise is a smaller list, never a throw.
  assert.deepEqual(flattenProjectIdentifiers(undefined), []);
  assert.deepEqual(flattenProjectIdentifiers([{ type: 'directory', name: 'src' }]), []);
});

test('one session asks the project for its files once', async () => {
  const { loadProjectIdentifiers } = await load();

  // Concurrent callers — the composer mounting, a second one for the same project —
  // and a later one, which must still be answered from what the first already learnt.
  const [first, second] = await Promise.all([
    loadProjectIdentifiers('project-1'),
    loadProjectIdentifiers('project-1'),
  ]);
  const third = await loadProjectIdentifiers('project-1');

  assert.deepEqual(first, second);
  assert.deepEqual(third, first);
  assert.equal(getFileIndex.mock.calls.length, 1, 'the file index is a session-level read, not a per-utterance one');
  assert.deepEqual(getFileIndex.mock.calls[0], ['project-1']);

  // A different project is a different question.
  await loadProjectIdentifiers('project-2');
  assert.equal(getFileIndex.mock.calls.length, 2);
});

test('a failed request leaves the transcript something to fall back on', async () => {
  const { loadProjectIdentifiers } = await load();

  getFileIndex.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
  assert.deepEqual(await loadProjectIdentifiers('project-1'), [], 'an error status is no candidates, not a throw');

  getFileIndex.mockRejectedValue(new Error('offline'));
  assert.deepEqual(await loadProjectIdentifiers('project-2'), [], 'a rejected fetch is no candidates, not a throw');

  // The failure is remembered like any other answer, so a project that cannot be listed
  // does not pay a round trip in front of every dictation for the rest of the session.
  const before = getFileIndex.mock.calls.length;
  await loadProjectIdentifiers('project-2');
  assert.equal(getFileIndex.mock.calls.length, before);

  assert.deepEqual(await loadProjectIdentifiers(null), [], 'no project open is no candidates');
  assert.deepEqual(await loadProjectIdentifiers(undefined), []);
  assert.equal(getFileIndex.mock.calls.length, before, 'and nothing was asked for them');
});

test('no candidates is the utterance unchanged — the degradation is silent', async () => {
  const { flattenProjectIdentifiers, loadProjectIdentifiers } = await load();

  getFileIndex.mockResolvedValue(okJson({ files: [], truncated: false }));
  const candidates = await loadProjectIdentifiers('project-1');
  assert.deepEqual(candidates, []);

  // This is the whole reading of the fallback: the repair is a pure function of its
  // candidate list, so the empty list it can always be handed costs the recogniser's
  // own sentence nothing.
  const utterance = 'please open voice.rouse.ts and fix the proxy';
  assert.equal(repairIdentifiers(utterance, candidates), utterance);
  assert.deepEqual(flattenProjectIdentifiers([]), []);
});
