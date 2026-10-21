import assert from 'node:assert/strict';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createFileTreeService } from '@/modules/file-tree/file-tree.service.js';
import type {
  FileTreeDirectoryEntry,
  FileTreeFileSystem,
  FileTreeServiceDependencies,
} from '@/shared/types.js';

// Mirrors the service's index bound. Kept as a literal so this criterion reads
// the shipped value rather than deriving it from the implementation it
// constrains.
const SEARCH_INDEX_ENTRY_LIMIT = 10_000;

function createDirectoryEntry(name: string, directory: boolean): FileTreeDirectoryEntry {
  return {
    name,
    isDirectory: () => directory,
  };
}

/**
 * Adapts a path-keyed listing to the streaming directory contract so tests keep
 * describing directories as plain arrays.
 */
function createDirectoryReader(
  listDirectory: (directoryPath: string) => FileTreeDirectoryEntry[],
): FileTreeFileSystem['openDirectory'] {
  return async function* openDirectory(directoryPath) {
    yield* listDirectory(directoryPath);
  };
}

function createFakeFileSystem(
  overrides: Partial<FileTreeFileSystem> = {},
): FileTreeFileSystem {
  const unexpectedOperation = async (): Promise<never> => {
    throw new Error('Unexpected File Tree filesystem operation');
  };

  return {
    access: unexpectedOperation,
    stat: unexpectedOperation,
    lstat: unexpectedOperation,
    openDirectory: () => ({
      [Symbol.asyncIterator]: () => ({ next: unexpectedOperation }),
    }),
    realpath: unexpectedOperation,
    readTextFile: unexpectedOperation,
    writeTextFile: unexpectedOperation,
    makeDirectory: unexpectedOperation,
    rename: unexpectedOperation,
    removeDirectory: unexpectedOperation,
    unlink: unexpectedOperation,
    copyFile: unexpectedOperation,
    createReadStream: () => Readable.from([]),
    ...overrides,
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

/**
 * The fixture the AC names: a project whose root `.gitignore` hides
 * `.archguard/`, `node_modules/` and `*.log`, all of which really exist on
 * disk alongside `.git/`. A git-aligned index would omit every one of them, so
 * their presence in the search index is what discriminates disk truth from
 * `git ls-files` semantics.
 */
function createDiskTruthFileSystem(projectRoot: string): FileTreeFileSystem {
  const gitDirectory = path.join(projectRoot, '.git');
  const archguardDirectory = path.join(projectRoot, '.archguard');
  const archguardOverviewDirectory = path.join(archguardDirectory, 'output', 'overview');
  const nodeModulesDirectory = path.join(projectRoot, 'node_modules');
  const nodePackageDirectory = path.join(nodeModulesDirectory, 'pkg');
  const sourceDirectory = path.join(projectRoot, 'src');

  return createFakeFileSystem({
    access: async () => undefined,
    // The search index is a display-path consumer: reading ignore rules here
    // would mean it is still filtering, so any read fails the test loudly.
    readTextFile: async () => {
      throw new Error('the search index must not read .gitignore');
    },
    // Nor may it consult git: the reference index owns `git ls-files`.
    isGitRepository: async () => {
      throw new Error('the search index must not probe the repository');
    },
    listGitFiles: async () => {
      throw new Error('the search index must not list git files');
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('.archguard', true),
          createDirectoryEntry('.git', true),
          createDirectoryEntry('.gitignore', false),
          createDirectoryEntry('debug.log', false),
          createDirectoryEntry('node_modules', true),
          createDirectoryEntry('src', true),
        ];
      }
      if (directoryPath === archguardDirectory) {
        return [createDirectoryEntry('output', true)];
      }
      if (directoryPath === path.join(archguardDirectory, 'output')) {
        return [createDirectoryEntry('overview', true)];
      }
      if (directoryPath === archguardOverviewDirectory) {
        return [createDirectoryEntry('package.mmd', false)];
      }
      if (directoryPath === gitDirectory) {
        return [
          createDirectoryEntry('HEAD', false),
          createDirectoryEntry('config', false),
        ];
      }
      if (directoryPath === nodeModulesDirectory) {
        return [createDirectoryEntry('pkg', true)];
      }
      if (directoryPath === nodePackageDirectory) {
        return [createDirectoryEntry('index.js', false)];
      }
      if (directoryPath === sourceDirectory) {
        return [createDirectoryEntry('index.ts', false)];
      }
      return [];
    }),
  });
}

test('search index contains files under gitignored, .git and node_modules directories', async () => {
  const projectRoot = path.resolve('file-tree-search-index-project');
  const service = createFileTreeService(
    createDependencies(createDiskTruthFileSystem(projectRoot), projectRoot),
  );

  const index = await service.listProjectSearchIndex('project-1');

  assert.equal(index.truncated, false);
  const relativePaths = index.files
    .map((file) => path.relative(projectRoot, file.path))
    .sort();
  assert.deepEqual(relativePaths, [
    '.archguard/output/overview/package.mmd',
    '.git/HEAD',
    '.git/config',
    '.gitignore',
    'debug.log',
    'node_modules/pkg/index.js',
    'src/index.ts',
  ]);

  // Named one by one so a future filter that drops a single category fails on
  // the category it dropped rather than on an opaque list diff.
  for (const relativePath of [
    '.archguard/output/overview/package.mmd',
    '.git/HEAD',
    'node_modules/pkg/index.js',
    'debug.log',
  ]) {
    assert.ok(
      relativePaths.includes(relativePath),
      `${relativePath} exists on disk and must be searchable`,
    );
  }

  for (const file of index.files) {
    assert.equal(file.type, 'file');
    assert.ok(path.isAbsolute(file.path), `${file.path} must be absolute`);
    assert.equal(file.name, path.basename(file.path));
  }
});

test('the search index reports truncated instead of failing at the entry cap', async () => {
  const projectRoot = path.resolve('file-tree-search-index-truncated-project');
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async () => {
      throw new Error('the search index must not read .gitignore');
    },
    openDirectory: createDirectoryReader((directoryPath) => directoryPath === projectRoot
      ? Array.from({ length: SEARCH_INDEX_ENTRY_LIMIT + 1 }, (_, index) => (
          createDirectoryEntry(`file-${index}.txt`, false)
        ))
      : []),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const index = await service.listProjectSearchIndex('project-1');

  assert.equal(index.files.length, SEARCH_INDEX_ENTRY_LIMIT);
  assert.equal(index.truncated, true);
  assert.equal(index.files.at(0)?.name, 'file-0.txt');
});

test('the search index is cached per project across repeated readers', async () => {
  const projectRoot = path.resolve('file-tree-search-index-cache-project');
  let openedDirectoryCount = 0;
  const fileSystem = createDiskTruthFileSystem(projectRoot);
  const openDirectory = fileSystem.openDirectory;
  fileSystem.openDirectory = async function* openDirectoryCounting(directoryPath) {
    openedDirectoryCount += 1;
    yield* openDirectory(directoryPath);
  };
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const firstIndex = await service.listProjectSearchIndex('project-1');
  const walksAfterFirstRead = openedDirectoryCount;
  const secondIndex = await service.listProjectSearchIndex('project-1');

  assert.ok(walksAfterFirstRead > 1, 'the first read really walked the tree');
  assert.equal(
    openedDirectoryCount,
    walksAfterFirstRead,
    'a repeated read must be served from the cache',
  );
  assert.equal(secondIndex, firstIndex, 'the cached index object is shared');
});

test('a filesystem mutation invalidates the cached search index', async () => {
  const projectRoot = path.resolve('file-tree-search-index-invalidate-project');
  const fileSystem = createDiskTruthFileSystem(projectRoot);
  const directoriesReadAfterInvalidation: string[] = [];
  const openDirectory = fileSystem.openDirectory;
  fileSystem.openDirectory = async function* openDirectoryRecording(directoryPath) {
    directoriesReadAfterInvalidation.push(directoryPath);
    yield* openDirectory(directoryPath);
  };
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await service.listProjectSearchIndex('project-1');
  directoriesReadAfterInvalidation.length = 0;

  // `access` reports the new file as absent, then `writeTextFile` records it.
  fileSystem.access = async (candidatePath) => {
    if (candidatePath === path.join(projectRoot, 'created.txt')) {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    }
  };
  fileSystem.writeTextFile = async () => undefined;
  await service.createEntry({
    projectId: 'project-1',
    parentPath: projectRoot,
    type: 'file',
    name: 'created.txt',
  });

  await service.listProjectSearchIndex('project-1');

  assert.ok(
    directoriesReadAfterInvalidation.includes(projectRoot),
    'the next read after a mutation walks the tree again instead of serving the stale index',
  );
});
