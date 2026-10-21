import assert from 'node:assert/strict';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createFileTreeService } from '@/modules/file-tree/file-tree.service.js';
import type {
  FileTreeDirectoryEntry,
  FileTreeFileSystem,
  FileTreeServiceDependencies,
  FileTreeStats,
} from '@/shared/types.js';

// Mirrors the service's per-directory bound. Kept as a literal so this
// criterion reads the shipped value rather than deriving it from the
// implementation it is meant to constrain.
const PER_DIRECTORY_ENTRY_LIMIT = 2_000;

function createDirectoryEntry(name: string, directory: boolean): FileTreeDirectoryEntry {
  return {
    name,
    isDirectory: () => directory,
  };
}

function createStats(directory: boolean, mode: number): FileTreeStats {
  return {
    size: directory ? 0 : 24,
    mtime: new Date('2026-01-02T03:04:05.000Z'),
    mode,
    isDirectory: () => directory,
    isSymbolicLink: () => false,
  };
}

type DirectoryContent = FileTreeDirectoryEntry[] | (() => AsyncIterable<FileTreeDirectoryEntry>);

type FakeTree = {
  // Path-keyed directory contents. A function form lets one directory stream
  // tens of thousands of entries without materializing them first, so the test
  // can prove the service stops at the cap instead of reading the whole list.
  contents: Map<string, DirectoryContent>;
  directories: Set<string>;
  openedDirectories: string[];
  gitignore: string | null;
};

function createFakeTree(): FakeTree {
  return {
    contents: new Map(),
    directories: new Set(),
    openedDirectories: [],
    gitignore: null,
  };
}

function createFakeFileSystem(tree: FakeTree): FileTreeFileSystem {
  const unexpectedOperation = async (): Promise<never> => {
    throw new Error('Unexpected File Tree filesystem operation');
  };

  return {
    access: async () => undefined,
    stat: async (candidatePath) => {
      if (!tree.directories.has(candidatePath)) {
        throw Object.assign(new Error('ENOENT: no such directory'), { code: 'ENOENT' });
      }
      return createStats(true, 0o755);
    },
    lstat: async (candidatePath) => createStats(tree.directories.has(candidatePath), 0o644),
    openDirectory: async function* openDirectory(directoryPath) {
      tree.openedDirectories.push(directoryPath);
      const content = tree.contents.get(directoryPath);
      if (!content) {
        return;
      }
      if (typeof content === 'function') {
        yield* content();
        return;
      }
      yield* content;
    },
    realpath: async (candidatePath) => candidatePath,
    readTextFile: async (filePath) => {
      assert.equal(path.basename(filePath), '.gitignore');
      if (tree.gitignore === null) {
        throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      }
      return tree.gitignore;
    },
    writeTextFile: unexpectedOperation,
    makeDirectory: unexpectedOperation,
    rename: unexpectedOperation,
    removeDirectory: unexpectedOperation,
    unlink: unexpectedOperation,
    copyFile: unexpectedOperation,
    createReadStream: () => Readable.from([]),
  };
}

function createDependencies(
  fileSystem: FileTreeFileSystem,
  projectRoot: string,
): FileTreeServiceDependencies {
  return {
    fileSystem,
    projects: {
      getProjectPathById: async () => projectRoot,
    },
    workspace: {
      rootPath: projectRoot,
      validatePath: async (candidatePath) => ({ valid: true, resolvedPath: candidatePath }),
    },
    resolveMimeType: () => 'text/plain',
    fileSystemConcurrency: 4,
    logger: { error: () => undefined },
  };
}

test('lazy listing opens only the requested directory and no descendant', async () => {
  const projectRoot = path.resolve('file-tree-lazy-project');
  const sourceDirectory = path.join(projectRoot, 'src');
  const tree = createFakeTree();
  tree.directories.add(projectRoot);
  tree.directories.add(sourceDirectory);
  tree.contents.set(projectRoot, [
    createDirectoryEntry('src', true),
    createDirectoryEntry('README.md', false),
  ]);
  tree.contents.set(sourceDirectory, [createDirectoryEntry('index.ts', false)]);
  const service = createFileTreeService(createDependencies(createFakeFileSystem(tree), projectRoot));

  const rootListing = await service.listProjectDirectory('project-1');

  assert.equal(rootListing.path, projectRoot);
  assert.equal(rootListing.truncated, false);
  assert.deepEqual(rootListing.entries.map((entry) => entry.name), ['src', 'README.md']);
  // Directories advertise an expander without a peek; files carry no such flag.
  assert.equal(rootListing.entries[0]?.hasChildren, true);
  assert.equal(rootListing.entries[1]?.hasChildren, undefined);
  // The whole point of the change: listing the root must not descend into src.
  assert.deepEqual(tree.openedDirectories, [projectRoot]);

  const sourceListing = await service.listProjectDirectory('project-1', sourceDirectory);

  assert.equal(sourceListing.path, sourceDirectory);
  assert.deepEqual(sourceListing.entries.map((entry) => entry.name), ['index.ts']);
  // The second request opens exactly its own directory — still no grandchild.
  assert.deepEqual(tree.openedDirectories, [projectRoot, sourceDirectory]);
});

test('a root listing succeeds when a child directory holds 50,000 entries', async () => {
  const projectRoot = path.resolve('file-tree-lazy-project');
  const hugeDirectory = path.join(projectRoot, 'generated');
  let streamedEntries = 0;
  const tree = createFakeTree();
  tree.directories.add(projectRoot);
  tree.directories.add(hugeDirectory);
  tree.contents.set(projectRoot, [
    createDirectoryEntry('generated', true),
    createDirectoryEntry('README.md', false),
  ]);
  tree.contents.set(hugeDirectory, () => (async function* generateEntries() {
    for (let index = 0; index < 50_000; index += 1) {
      streamedEntries += 1;
      yield createDirectoryEntry(`file-${index}.txt`, false);
    }
  })());
  const service = createFileTreeService(createDependencies(createFakeFileSystem(tree), projectRoot));

  // The root is one level deep, so the huge child is listed as a single entry
  // and must never be opened (which used to exhaust the global 10,000 budget
  // and fail the whole tree with 413 FILE_TREE_TOO_LARGE).
  const rootListing = await service.listProjectDirectory('project-1');

  assert.equal(rootListing.truncated, false);
  assert.deepEqual(rootListing.entries.map((entry) => entry.name), ['generated', 'README.md']);
  assert.equal(rootListing.entries[0]?.type, 'directory');
  assert.equal(rootListing.entries[0]?.hasChildren, true);
  assert.deepEqual(tree.openedDirectories, [projectRoot]);
  assert.equal(streamedEntries, 0);

  const hugeListing = await service.listProjectDirectory('project-1', hugeDirectory);

  assert.equal(hugeListing.truncated, true);
  assert.equal(hugeListing.entries.length, PER_DIRECTORY_ENTRY_LIMIT);
  // The service reads exactly one entry past the cap to know it truncated, then
  // closes the stream; it does not drain the remaining ~48,000 entries.
  assert.equal(streamedEntries, PER_DIRECTORY_ENTRY_LIMIT + 1);
  assert.deepEqual(tree.openedDirectories, [projectRoot, hugeDirectory]);
});

test('virtualenv and byte-code cache directories are hard-excluded in both modes', async () => {
  const projectRoot = path.resolve('file-tree-lazy-project');
  const sourceDirectory = path.join(projectRoot, 'src');
  const excludedDirectoryNames = ['.venv', 'venv', '__pycache__', '.pytest_cache', '.cache'];
  const tree = createFakeTree();
  tree.directories.add(projectRoot);
  tree.directories.add(sourceDirectory);
  for (const name of excludedDirectoryNames) {
    tree.directories.add(path.join(projectRoot, name));
  }
  tree.contents.set(projectRoot, [
    ...excludedDirectoryNames.map((name) => createDirectoryEntry(name, true)),
    createDirectoryEntry('src', true),
    createDirectoryEntry('keep.ts', false),
  ]);
  tree.contents.set(sourceDirectory, []);
  // A root .gitignore that says nothing about the excluded names: exclusion has
  // to come from the always-on hard list, not from ignore rules.
  tree.gitignore = '*.log\n';
  const fileSystem = createFakeFileSystem(tree);
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const gitignoreListing = await service.listProjectDirectory(
    'project-1',
    undefined,
    { respectGitignore: true },
  );
  const fallbackListing = await service.listProjectDirectory(
    'project-1',
    undefined,
    { respectGitignore: false },
  );

  for (const listing of [gitignoreListing, fallbackListing]) {
    assert.deepEqual(
      listing.entries.map((entry) => entry.name),
      ['src', 'keep.ts'],
      'cache directories must be absent in both gitignore and fallback modes',
    );
  }
});
