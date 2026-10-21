import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  promises as fsPromises,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createGitFileTreePorts } from '@/modules/file-tree/file-tree.git.js';
import { createFileTreeService } from '@/modules/file-tree/file-tree.service.js';
import type {
  FileTreeDirectoryEntry,
  FileTreeFileSystem,
  FileTreeServiceDependencies,
} from '@/shared/types.js';

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function createDirectoryEntry(name: string, directory: boolean): FileTreeDirectoryEntry {
  return {
    name,
    isDirectory: () => directory,
  };
}

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
 * Builds the fixture the AC names: a real git repository whose root `.gitignore`
 * ignores `*.log` (rescuing `keep.log` with `!`) while a NESTED `.gitignore`
 * ignores `packages/nested/.venv/`. A root-.gitignore-only implementation would
 * index the `.venv` files, so the assertion against `git ls-files` discriminates.
 */
function createGitFixture(): string {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'file-tree-index-git-'));
  runGit(projectRoot, ['init', '--quiet']);
  runGit(projectRoot, ['config', 'user.email', 'file-tree-index@example.com']);
  runGit(projectRoot, ['config', 'user.name', 'File Tree Index']);

  writeFileSync(
    path.join(projectRoot, '.gitignore'),
    ['*.log', '!keep.log', 'data/'].join('\n') + '\n',
  );
  mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  writeFileSync(path.join(projectRoot, 'src', 'index.ts'), 'export {};\n');
  writeFileSync(path.join(projectRoot, 'keep.log'), 'keep me\n');
  writeFileSync(path.join(projectRoot, 'ignored.log'), 'hide me\n');
  mkdirSync(path.join(projectRoot, 'data'), { recursive: true });
  writeFileSync(path.join(projectRoot, 'data', 'dump.bin'), 'hide me\n');

  const nestedDirectory = path.join(projectRoot, 'packages', 'nested');
  mkdirSync(path.join(nestedDirectory, '.venv'), { recursive: true });
  writeFileSync(path.join(nestedDirectory, '.gitignore'), '.venv/\n');
  writeFileSync(path.join(nestedDirectory, '.venv', 'poison.txt'), 'must not be indexed\n');
  writeFileSync(path.join(nestedDirectory, 'visible.ts'), 'export {};\n');

  // `keep.log` matches `*.log`, but the tracked file plus `!keep.log` both keep it.
  runGit(projectRoot, [
    'add',
    '.gitignore',
    'src/index.ts',
    'keep.log',
    'packages/nested/.gitignore',
  ]);
  return projectRoot;
}

function readGitIndexPaths(projectRoot: string): string[] {
  return runGit(projectRoot, ['ls-files', '--cached', '--others', '--exclude-standard'])
    .split('\n')
    .filter((relativePath) => relativePath.length > 0)
    .sort();
}

test('a git project index equals the git ls-files path set, including nested gitignore semantics', async () => {
  const projectRoot = createGitFixture();
  try {
    const expectedRelativePaths = readGitIndexPaths(projectRoot);
    // Guard the guard: the fixture must really ignore the nested .venv, otherwise
    // the "absent from the index" assertion below would be vacuous.
    assert.ok(
      !expectedRelativePaths.some((relativePath) => relativePath.includes('.venv')),
      'the fixture must actually ignore packages/nested/.venv',
    );

    const fileSystem = createFakeFileSystem({
      access: async () => undefined,
      ...createGitFileTreePorts(),
    });
    const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

    const index = await service.listProjectFileIndex('project-1');

    assert.equal(index.truncated, false);
    const indexedRelativePaths = index.files
      .map((file) => path.relative(projectRoot, file.path))
      .sort();
    assert.deepEqual(indexedRelativePaths, expectedRelativePaths);

    assert.ok(
      !indexedRelativePaths.some((relativePath) => relativePath.includes('.venv')),
      'nested .gitignore must keep .venv files out of the index',
    );
    assert.ok(
      indexedRelativePaths.includes('keep.log'),
      'a tracked file rescued by a root `!` rule must be indexed',
    );
    assert.ok(indexedRelativePaths.includes('packages/nested/visible.ts'));
    assert.ok(!indexedRelativePaths.includes('ignored.log'));
    assert.ok(!indexedRelativePaths.some((relativePath) => relativePath.startsWith('data/')));

    for (const file of index.files) {
      assert.equal(file.type, 'file');
      assert.ok(path.isAbsolute(file.path), `${file.path} must be absolute`);
      assert.equal(file.name, path.basename(file.path));
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('a non-git project falls back to the bounded walk with hard exclusions and root gitignore', async () => {
  const projectRoot = path.resolve('file-tree-index-fallback-project');
  const sourceDirectory = path.join(projectRoot, 'src');
  const nestedSourceDirectory = path.join(sourceDirectory, 'nested');
  const nodeModulesDirectory = path.join(projectRoot, 'node_modules');
  const virtualEnvironmentDirectory = path.join(projectRoot, '.venv');

  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async (filePath) => {
      assert.equal(filePath, path.join(projectRoot, '.gitignore'));
      return ['*.log', '.venv/'].join('\n');
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('.gitignore', false),
          createDirectoryEntry('.venv', true),
          createDirectoryEntry('README.md', false),
          createDirectoryEntry('ignored.log', false),
          createDirectoryEntry('node_modules', true),
          createDirectoryEntry('src', true),
        ];
      }
      if (directoryPath === sourceDirectory) {
        return [
          createDirectoryEntry('index.ts', false),
          createDirectoryEntry('nested', true),
        ];
      }
      if (directoryPath === nestedSourceDirectory) {
        return [createDirectoryEntry('deep.ts', false)];
      }
      if (directoryPath === nodeModulesDirectory || directoryPath === virtualEnvironmentDirectory) {
        return [createDirectoryEntry('hidden.txt', false)];
      }
      return [];
    }),
    // Both git ports are present but say "not a repository": the index must not
    // call the git listing, and must still serve the walk.
    isGitRepository: async () => false,
    listGitFiles: async () => {
      throw new Error('listGitFiles must not run for a non-git project');
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const index = await service.listProjectFileIndex('project-1');

  assert.equal(index.truncated, false);
  assert.deepEqual(
    index.files.map((file) => path.relative(projectRoot, file.path)).sort(),
    ['.gitignore', 'README.md', 'src/index.ts', 'src/nested/deep.ts'],
  );
  assert.ok(!index.files.some((file) => file.path.startsWith(nodeModulesDirectory)));
  assert.ok(!index.files.some((file) => file.path.startsWith(virtualEnvironmentDirectory)));
});

test('the non-git fallback reports truncated instead of failing at the entry cap', async () => {
  const projectRoot = path.resolve('file-tree-index-truncated-project');
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    openDirectory: createDirectoryReader((directoryPath) => directoryPath === projectRoot
      ? Array.from({ length: 10_001 }, (_, index) => createDirectoryEntry(`file-${index}.txt`, false))
      : []),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const index = await service.listProjectFileIndex('project-1');

  assert.equal(index.files.length, 10_000);
  assert.equal(index.truncated, true);
  assert.equal(index.files.at(0)?.name, 'file-0.txt');
});

test('the git index is cached per project across repeated readers', async () => {
  const projectRoot = path.resolve('file-tree-index-cache-project');
  let listGitFilesCalls = 0;
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    isGitRepository: async () => true,
    listGitFiles: async () => {
      listGitFilesCalls += 1;
      return ['root.ts', 'src/nested.ts'];
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const firstIndex = await service.listProjectFileIndex('project-1');
  const secondIndex = await service.listProjectFileIndex('project-1');

  assert.equal(listGitFilesCalls, 1, 'a repeated read must be served from the cache');
  assert.equal(secondIndex, firstIndex, 'the cached index object is shared');
  assert.deepEqual(
    secondIndex.files.map((file) => file.name).sort(),
    ['nested.ts', 'root.ts'],
  );
});

test('a real project index contains no .venv paths', async () => {
  // server/modules/file-tree/tests -> repository root
  const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
  );
  assert.ok(
    existsSync(path.join(projectRoot, '.git')),
    `expected the test to run inside the repository checkout, not ${projectRoot}`,
  );

  const fileSystem = createFakeFileSystem({
    access: (candidatePath) => fsPromises.access(candidatePath),
    ...createGitFileTreePorts(),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const index = await service.listProjectFileIndex('project-real');

  assert.ok(index.files.length > 0, 'the real project index must not be empty');
  assert.equal(index.truncated, false);
  assert.ok(
    !index.files.some((file) => file.path.split(path.sep).includes('.venv')),
    'the real project index must not contain .venv paths',
  );
  for (const file of index.files) {
    assert.ok(path.isAbsolute(file.path));
    assert.equal(file.name, path.basename(file.path));
  }
});
