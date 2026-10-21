import path from 'node:path';

import ignore from 'ignore';

import type {
  FileTreeDirectoryEntry,
  FileTreeDirectoryListing,
  FileTreeIndex,
  FileTreeIndexEntry,
  FileTreeNode,
  FileTreeServiceDependencies,
  FileTreeServices,
  FileTreeUploadedFile,
} from '@/shared/types.js';
import { AppError, FORBIDDEN_WORKSPACE_PATHS, normalizeProjectPath } from '@/shared/utils.js';

// Always-on exclusions for the display tree in BOTH gitignore and fallback
// modes. Virtual environments and byte-code/cache directories can hold tens of
// thousands of files that no user browses in a Files tab, and a gitignore-aware
// walk only reads the root `.gitignore`, so they cannot be left to ignore rules
// (a project without a `.venv/` rule would otherwise list them).
const HARD_EXCLUDED_DIRECTORY_NAMES = new Set([
  'node_modules', '.git', '.svn', '.hg',
  '.venv', 'venv', '__pycache__',
  '.pytest_cache', '.mypy_cache', '.tox', '.cache', '.parcel-cache',
  '.gradle', '.nyc_output', 'coverage', '.idea',
]);

const IGNORED_DIRECTORY_NAMES = new Set([
  ...HARD_EXCLUDED_DIRECTORY_NAMES,
  'dist', 'build', '.next', '.nuxt', '.cache', '.parcel-cache',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', 'venv', '.venv',
  'target', 'vendor',
  '.gradle', '.idea', 'coverage', '.nyc_output',
]);

const COMMON_WORKSPACE_DIRECTORY_NAMES = [
  'Desktop',
  'Documents',
  'Projects',
  'Development',
  'Dev',
  'Code',
  'workspace',
];

// Legacy full-tree guard, kept only for `listProjectFiles` until the remaining
// consumers migrate to the lazy directory endpoint. The Files tab no longer
// uses it: opening a directory costs one level, not the whole project, so the
// display path bounds each directory instead of the tree.
const MAXIMUM_FILE_TREE_ENTRIES = 10_000;

// Per-directory bound for the lazy Files tab listing. A directory with more
// visible entries than this is returned truncated (first N + `truncated: true`)
// rather than failing the request; other directories are unaffected.
const MAXIMUM_DIRECTORY_LISTING_ENTRIES = 2_000;

// The non-git fallback for the flat index walks the whole project, so it stops
// at this many files and reports `truncated` instead of failing the request. A
// git-backed index is exact and never uses this bound.
const MAXIMUM_FILE_INDEX_ENTRIES = 10_000;

type FileTreeEntryFilter = (entryPath: string, isDirectory: boolean) => boolean;

function includeEntryByHardExclusions(entryPath: string, isDirectory: boolean): boolean {
  return !isDirectory || !HARD_EXCLUDED_DIRECTORY_NAMES.has(path.basename(entryPath));
}

function includeEntryByFallbackDirectoryNames(entryPath: string, isDirectory: boolean): boolean {
  return includeEntryByHardExclusions(entryPath, isDirectory)
    && (!isDirectory || !IGNORED_DIRECTORY_NAMES.has(path.basename(entryPath)));
}

function createFileTreeError(message: string, statusCode: number, code: string): AppError {
  return new AppError(message, { statusCode, code });
}

function readErrorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : null;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function permissionBitsToRwx(permissionBits: number): string {
  const read = permissionBits & 4 ? 'r' : '-';
  const write = permissionBits & 2 ? 'w' : '-';
  const execute = permissionBits & 1 ? 'x' : '-';
  return read + write + execute;
}

function validateFilename(name: string): void {
  if (!name.trim()) {
    throw createFileTreeError('Filename cannot be empty', 400, 'INVALID_FILENAME');
  }

  if (/[<>:"/\\|?*\x00-\x1f]/.test(name)) {
    throw createFileTreeError('Filename contains invalid characters', 400, 'INVALID_FILENAME');
  }

  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name)) {
    throw createFileTreeError('Filename is a reserved name', 400, 'INVALID_FILENAME');
  }

  if (/^\.+$/.test(name)) {
    throw createFileTreeError('Filename cannot be only dots', 400, 'INVALID_FILENAME');
  }
}

function resolvePathInsideProject(projectRoot: string, targetPath: string): string {
  const resolvedPath = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(projectRoot, targetPath);
  const normalizedProjectRoot = path.resolve(projectRoot) + path.sep;

  if (!resolvedPath.startsWith(normalizedProjectRoot)) {
    throw createFileTreeError('Path must be under project root', 403, 'PATH_OUTSIDE_PROJECT');
  }

  return resolvedPath;
}

/**
 * Resolves a directory request that may name the project root itself.
 *
 * `resolvePathInsideProject` requires a descendant of the root, which is right
 * for file paths but rejects the root directory. The lazy listing needs the
 * root as its default, so equality is allowed here while `..` escapes stay
 * forbidden.
 */
function resolveDirectoryInsideProject(projectRoot: string, targetPath: string): string {
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedPath = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(resolvedRoot, targetPath);

  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(resolvedRoot + path.sep)) {
    throw createFileTreeError('Path must be under project root', 403, 'PATH_OUTSIDE_PROJECT');
  }

  return resolvedPath;
}

function compareFileTreeNodes(left: FileTreeNode, right: FileTreeNode): number {
  if (left.type !== right.type) {
    return left.type === 'directory' ? -1 : 1;
  }
  return left.name.localeCompare(right.name);
}

function expandWorkspacePath(workspaceRoot: string, inputPath: string): string {
  if (inputPath === '~') {
    return workspaceRoot;
  }
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(workspaceRoot, inputPath.slice(2));
  }
  return inputPath;
}

function createConcurrencyLimiter(maximumConcurrency: number) {
  let activeOperations = 0;
  const pendingOperations: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (activeOperations < maximumConcurrency) {
      activeOperations += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      pendingOperations.push(resolve);
    });
  }

  function release(): void {
    const nextOperation = pendingOperations.shift();
    if (nextOperation) {
      nextOperation();
      return;
    }

    activeOperations = Math.max(0, activeOperations - 1);
  }

  return { acquire, release };
}

function mapFileSystemError(
  error: unknown,
  messages: Partial<Record<string, { message: string; statusCode: number }>>,
): never {
  const errorCode = readErrorCode(error);
  const mappedError = errorCode ? messages[errorCode] : undefined;
  if (mappedError) {
    throw createFileTreeError(mappedError.message, mappedError.statusCode, errorCode ?? 'FILE_TREE_ERROR');
  }

  throw error;
}

function createGitignoreEntryFilter(
  projectRoot: string,
  gitignoreContent: string,
): FileTreeEntryFilter {
  const gitignore = ignore().add(gitignoreContent);

  return (entryPath, isDirectory) => {
    if (!includeEntryByHardExclusions(entryPath, isDirectory)) return false;

    const relativePath = path.relative(projectRoot, entryPath).split(path.sep).join('/');
    const matchPath = isDirectory ? `${relativePath}/` : relativePath;
    return !gitignore.ignores(matchPath);
  };
}

/**
 * Creates File Tree workflows for the module composition root and route tests.
 * Every filesystem, project, workspace, environment, and logging dependency is
 * required explicitly so this service has no machine-wide production defaults.
 */
export function createFileTreeService(dependencies: FileTreeServiceDependencies): FileTreeServices {
  const fileSystem = dependencies.fileSystem;
  const concurrencyLimit = Number.isFinite(dependencies.fileSystemConcurrency)
    && dependencies.fileSystemConcurrency > 0
    ? Math.floor(dependencies.fileSystemConcurrency)
    : 1;
  const { acquire, release } = createConcurrencyLimiter(concurrencyLimit);

  async function resolveProjectRoot(projectId: string): Promise<string> {
    const projectRoot = await dependencies.projects.getProjectPathById(projectId);
    if (!projectRoot) {
      throw createFileTreeError('Project not found', 404, 'PROJECT_NOT_FOUND');
    }
    return projectRoot;
  }

  // Flat indexes are cached per project so a burst of consumers (mentions,
  // command palette, search, open-file resolution) shares one git listing or
  // walk. The cached value is the Promise, so concurrent first readers join the
  // same build; any path mutation clears the entry for that project.
  const fileIndexCache = new Map<string, Promise<FileTreeIndex>>();

  function invalidateFileIndex(projectId: string): void {
    fileIndexCache.delete(projectId);
  }

  async function readFallbackEntryFilter(projectRoot: string): Promise<FileTreeEntryFilter> {
    try {
      const gitignoreContent = await fileSystem.readTextFile(path.join(projectRoot, '.gitignore'));
      return createGitignoreEntryFilter(projectRoot, gitignoreContent);
    } catch (error) {
      if (readErrorCode(error) !== 'ENOENT') {
        dependencies.logger.error(`Error reading .gitignore in "${projectRoot}"`, error);
      }
      return includeEntryByHardExclusions;
    }
  }

  /**
   * Streams one directory for the fallback index walk, applying the same hard
   * exclusions and root-gitignore filter as the display tree.
   *
   * Unlike `collectVisibleEntries`, this does not charge a shared entry budget:
   * directories are not index entries, so only the caller's file count decides
   * when to stop and report `truncated`.
   */
  async function listIndexDirectoryEntries(
    directoryPath: string,
    includeEntry: FileTreeEntryFilter,
  ): Promise<FileTreeDirectoryEntry[]> {
    const visibleEntries: FileTreeDirectoryEntry[] = [];

    await acquire();
    try {
      for await (const entry of fileSystem.openDirectory(directoryPath)) {
        if (includeEntry(path.join(directoryPath, entry.name), entry.isDirectory())) {
          visibleEntries.push(entry);
        }
      }
    } catch (error) {
      const errorCode = readErrorCode(error);
      if (errorCode !== 'EACCES' && errorCode !== 'EPERM') {
        dependencies.logger.error(`Error reading directory "${directoryPath}"`, error);
      }
      return [];
    } finally {
      release();
    }

    return visibleEntries;
  }

  /**
   * Builds the non-git index by walking the project tree breadth-first.
   *
   * Directories are free; only files are charged against the cap, so a project
   * with a wide directory fan-out is bounded by how many files it actually
   * contains. Hitting the cap marks the result `truncated` rather than failing.
   */
  async function buildFallbackFileIndex(projectRoot: string): Promise<FileTreeIndex> {
    const includeEntry = await readFallbackEntryFilter(projectRoot);
    const files: FileTreeIndexEntry[] = [];
    const pendingDirectories = [projectRoot];

    while (pendingDirectories.length > 0) {
      const directoryPath = pendingDirectories.shift() as string;
      const entries = await listIndexDirectoryEntries(directoryPath, includeEntry);

      for (const entry of entries) {
        const entryPath = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
          // The same system-directory guard the display walk uses: /proc and
          // friends are never valid project content and can be pathologically
          // large to enumerate.
          if (!FORBIDDEN_WORKSPACE_PATHS.includes(normalizeProjectPath(entryPath))) {
            pendingDirectories.push(entryPath);
          }
          continue;
        }

        if (files.length >= MAXIMUM_FILE_INDEX_ENTRIES) {
          return { files, truncated: true };
        }
        files.push({ name: entry.name, path: entryPath, type: 'file' });
      }
    }

    return { files, truncated: false };
  }

  async function buildProjectFileIndex(projectId: string): Promise<FileTreeIndex> {
    const projectRoot = await resolveProjectRoot(projectId);
    try {
      await fileSystem.access(projectRoot);
    } catch {
      throw createFileTreeError(`Project path not found: ${projectRoot}`, 404, 'PROJECT_PATH_NOT_FOUND');
    }

    const { isGitRepository, listGitFiles } = fileSystem;
    if (isGitRepository && listGitFiles) {
      try {
        if (await isGitRepository(projectRoot)) {
          const relativePaths = await listGitFiles(projectRoot);
          return {
            files: relativePaths
              .filter((relativePath) => relativePath.length > 0)
              .map((relativePath) => ({
                name: path.basename(relativePath),
                path: path.resolve(projectRoot, relativePath),
                type: 'file' as const,
              })),
            truncated: false,
          };
        }
      } catch (error) {
        // A failed git probe must not hide the project: degrade to the walk.
        dependencies.logger.error(`Error reading git file index in "${projectRoot}"`, error);
      }
    }

    return buildFallbackFileIndex(projectRoot);
  }

  /**
   * Streams one directory and keeps only the entries the tree will show.
   *
   * Entries are filtered and charged against the shared budget one at a time,
   * so a pathologically large directory stops the walk at the cap instead of
   * being read into memory in full first.
   */
  async function collectVisibleEntries(
    directoryPath: string,
    includeEntry: FileTreeEntryFilter,
    remainingEntries: { value: number },
  ): Promise<FileTreeDirectoryEntry[]> {
    const visibleEntries: FileTreeDirectoryEntry[] = [];

    await acquire();
    try {
      for await (const entry of fileSystem.openDirectory(directoryPath)) {
        const isDirectory = entry.isDirectory();
        if (!includeEntry(path.join(directoryPath, entry.name), isDirectory)) {
          continue;
        }

        // Charged after visibility filtering so ignored entries never consume
        // the budget. Every recursive branch shares one counter, so the cap
        // applies to the whole tree rather than per directory.
        if (remainingEntries.value <= 0) {
          throw createFileTreeError(
            `Project file tree exceeds the ${MAXIMUM_FILE_TREE_ENTRIES.toLocaleString()} entry limit. Choose a narrower project directory or add ignore rules.`,
            413,
            'FILE_TREE_TOO_LARGE',
          );
        }
        remainingEntries.value -= 1;
        visibleEntries.push(entry);
      }
    } catch (error) {
      // The entry cap is a caller-visible outcome, not an unreadable directory.
      if (error instanceof AppError) {
        throw error;
      }
      const errorCode = readErrorCode(error);
      if (errorCode !== 'EACCES' && errorCode !== 'EPERM') {
        dependencies.logger.error(`Error reading directory "${directoryPath}"`, error);
      }
      return [];
    } finally {
      release();
    }

    return visibleEntries;
  }

  /**
   * Streams ONE directory for the lazy Files tab listing.
   *
   * The per-directory cap is charged only for visible entries and stopping is
   * local: reading the (cap + 1)-th visible entry marks `truncated` and closes
   * the stream, so a directory with hundreds of thousands of children costs
   * the cap, never the whole directory. No child directory is opened here.
   */
  async function collectDirectoryListingEntries(
    directoryPath: string,
    includeEntry: FileTreeEntryFilter,
  ): Promise<{ entries: FileTreeDirectoryEntry[]; truncated: boolean }> {
    const visibleEntries: FileTreeDirectoryEntry[] = [];

    await acquire();
    try {
      for await (const entry of fileSystem.openDirectory(directoryPath)) {
        if (!includeEntry(path.join(directoryPath, entry.name), entry.isDirectory())) {
          continue;
        }

        if (visibleEntries.length >= MAXIMUM_DIRECTORY_LISTING_ENTRIES) {
          return { entries: visibleEntries, truncated: true };
        }
        visibleEntries.push(entry);
      }
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      const errorCode = readErrorCode(error);
      if (errorCode !== 'EACCES' && errorCode !== 'EPERM') {
        dependencies.logger.error(`Error reading directory "${directoryPath}"`, error);
      }
      return { entries: [], truncated: false };
    } finally {
      release();
    }

    return { entries: visibleEntries, truncated: false };
  }

  /**
   * Builds the node metadata for one directory entry without traversing it.
   */
  async function createFileTreeNode(
    directoryPath: string,
    entry: FileTreeDirectoryEntry,
  ): Promise<FileTreeNode> {
    const itemPath = path.join(directoryPath, entry.name);
    const item: FileTreeNode = {
      name: entry.name,
      path: itemPath,
      type: entry.isDirectory() ? 'directory' : 'file',
      size: 0,
      modified: null,
      permissions: '000',
      permissionsRwx: '---------',
    };

    try {
      await acquire();
      try {
        const stats = await fileSystem.lstat(itemPath);
        const ownerPermissions = (stats.mode >> 6) & 7;
        const groupPermissions = (stats.mode >> 3) & 7;
        const otherPermissions = stats.mode & 7;

        item.size = stats.size;
        item.modified = stats.mtime.toISOString();
        item.permissions = `${ownerPermissions}${groupPermissions}${otherPermissions}`;
        item.permissionsRwx = permissionBitsToRwx(ownerPermissions)
          + permissionBitsToRwx(groupPermissions)
          + permissionBitsToRwx(otherPermissions);
        if (stats.isSymbolicLink()) {
          item.isSymlink = true;
        }
      } finally {
        release();
      }
    } catch {
      // Metadata failures should not hide an otherwise readable tree entry.
    }

    return item;
  }

  async function buildFileTree(
    directoryPath: string,
    maximumDepth: number,
    currentDepth = 0,
    includeEntry: FileTreeEntryFilter = includeEntryByFallbackDirectoryNames,
    remainingEntries = { value: MAXIMUM_FILE_TREE_ENTRIES },
  ): Promise<FileTreeNode[]> {
    const visibleEntries = await collectVisibleEntries(directoryPath, includeEntry, remainingEntries);

    const items = await Promise.all(visibleEntries.map(async (entry): Promise<FileTreeNode> => {
      const item = await createFileTreeNode(directoryPath, entry);

      // Skip recursing into pseudo-filesystems and other system-critical
      // directories (e.g. /proc, /sys) — they're never valid project roots,
      // and /proc in particular can contain thousands of virtual entries
      // that make traversal from a broad root (e.g. "/") pathologically slow.
      const isForbiddenSystemDir = FORBIDDEN_WORKSPACE_PATHS.includes(normalizeProjectPath(item.path));

      if (entry.isDirectory() && currentDepth < maximumDepth && !isForbiddenSystemDir) {
        item.children = await buildFileTree(
          item.path,
          maximumDepth,
          currentDepth + 1,
          includeEntry,
          remainingEntries,
        );
      }

      return item;
    }));

    return items.sort(compareFileTreeNodes);
  }

  /**
   * Builds the response for one directory of the lazy Files tab tree.
   *
   * Only `directoryPath` is opened. Directories are marked expandable
   * optimistically (`hasChildren: true`) so the client draws an expander
   * without a peek request; expanding an empty directory simply shows its
   * empty state. `truncated` is a property of this directory alone.
   */
  async function buildDirectoryListing(
    directoryPath: string,
    includeEntry: FileTreeEntryFilter,
  ): Promise<FileTreeDirectoryListing> {
    const { entries, truncated } = await collectDirectoryListingEntries(directoryPath, includeEntry);
    const items = await Promise.all(entries.map(async (entry) => {
      const item = await createFileTreeNode(directoryPath, entry);
      if (item.type === 'directory') {
        item.hasChildren = true;
      }
      return item;
    }));

    return {
      path: directoryPath,
      entries: items.sort(compareFileTreeNodes),
      truncated,
    };
  }

  async function cleanupTemporaryFiles(files: FileTreeUploadedFile[]): Promise<void> {
    await Promise.all(files.map(async (file) => {
      try {
        await fileSystem.unlink(file.temporaryPath);
      } catch {
        // A successfully moved file no longer has a temporary source to clean.
      }
    }));
  }

  return {
    async browseWorkspace(inputPath) {
      const requestedPath = inputPath
        ? expandWorkspacePath(dependencies.workspace.rootPath, inputPath)
        : dependencies.workspace.rootPath;
      const targetPath = path.resolve(requestedPath);
      const validation = await dependencies.workspace.validatePath(targetPath);
      if (!validation.valid) {
        throw createFileTreeError(validation.error ?? 'Path is outside the workspace root', 403, 'INVALID_WORKSPACE_PATH');
      }

      const resolvedPath = validation.resolvedPath || targetPath;
      try {
        await fileSystem.access(resolvedPath);
        const stats = await fileSystem.stat(resolvedPath);
        if (!stats.isDirectory()) {
          throw createFileTreeError('Path is not a directory', 400, 'NOT_A_DIRECTORY');
        }
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw createFileTreeError('Directory not accessible', 404, 'DIRECTORY_NOT_ACCESSIBLE');
      }

      const fileTree = await buildFileTree(resolvedPath, 1);
      const directories = fileTree
        .filter((item) => item.type === 'directory')
        .map((item) => ({ path: item.path, name: item.name, type: 'directory' as const }))
        .sort((left, right) => {
          const leftHidden = left.name.startsWith('.');
          const rightHidden = right.name.startsWith('.');
          if (leftHidden && !rightHidden) return 1;
          if (!leftHidden && rightHidden) return -1;
          return left.name.localeCompare(right.name);
        });

      let resolvedWorkspaceRoot = dependencies.workspace.rootPath;
      try {
        resolvedWorkspaceRoot = await fileSystem.realpath(dependencies.workspace.rootPath);
      } catch {
        // The configured workspace root remains the comparison fallback.
      }

      const suggestions = resolvedPath === resolvedWorkspaceRoot
        ? [
            ...directories.filter((directory) => COMMON_WORKSPACE_DIRECTORY_NAMES.includes(directory.name)),
            ...directories.filter((directory) => !COMMON_WORKSPACE_DIRECTORY_NAMES.includes(directory.name)),
          ]
        : directories;

      return { path: resolvedPath, suggestions };
    },

    async createWorkspaceFolder(folderPath) {
      const expandedPath = expandWorkspacePath(dependencies.workspace.rootPath, folderPath);
      const resolvedInput = path.resolve(expandedPath);
      const validation = await dependencies.workspace.validatePath(resolvedInput);
      if (!validation.valid) {
        throw createFileTreeError(validation.error ?? 'Path is outside the workspace root', 403, 'INVALID_WORKSPACE_PATH');
      }

      const targetPath = validation.resolvedPath || resolvedInput;
      try {
        await fileSystem.access(path.dirname(targetPath));
      } catch {
        throw createFileTreeError('Parent directory does not exist', 404, 'PARENT_DIRECTORY_NOT_FOUND');
      }

      try {
        await fileSystem.access(targetPath);
        throw createFileTreeError('Folder already exists', 409, 'FOLDER_ALREADY_EXISTS');
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        await fileSystem.makeDirectory(targetPath, false);
      } catch (error) {
        mapFileSystemError(error, {
          EEXIST: { message: 'Folder already exists', statusCode: 409 },
        });
      }

      return { success: true, path: targetPath };
    },

    async readTextFile(projectId, filePath) {
      const projectRoot = await resolveProjectRoot(projectId);
      const resolvedPath = resolvePathInsideProject(projectRoot, filePath);
      try {
        const content = await fileSystem.readTextFile(resolvedPath);
        return { content, path: resolvedPath };
      } catch (error) {
        mapFileSystemError(error, {
          ENOENT: { message: 'File not found', statusCode: 404 },
          EACCES: { message: 'Permission denied', statusCode: 403 },
          EISDIR: { message: 'Path is a directory, not a file', statusCode: 400 },
        });
      }
    },

    async openFile(projectId, filePath) {
      const projectRoot = await resolveProjectRoot(projectId);
      const resolvedPath = resolvePathInsideProject(projectRoot, filePath);
      try {
        await fileSystem.access(resolvedPath);
      } catch {
        throw createFileTreeError('File not found', 404, 'FILE_NOT_FOUND');
      }

      return {
        contentType: dependencies.resolveMimeType(resolvedPath),
        stream: fileSystem.createReadStream(resolvedPath),
      };
    },

    async saveTextFile(projectId, filePath, content) {
      const projectRoot = await resolveProjectRoot(projectId);
      const resolvedPath = resolvePathInsideProject(projectRoot, filePath);
      try {
        await fileSystem.writeTextFile(resolvedPath, content);
      } catch (error) {
        mapFileSystemError(error, {
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          EACCES: { message: 'Permission denied', statusCode: 403 },
        });
      }

      return { success: true, path: resolvedPath, message: 'File saved successfully' };
    },

    async listProjectFiles(projectId, options) {
      const projectRoot = await resolveProjectRoot(projectId);
      try {
        await fileSystem.access(projectRoot);
      } catch {
        throw createFileTreeError(`Project path not found: ${projectRoot}`, 404, 'PROJECT_PATH_NOT_FOUND');
      }

      let includeEntry: FileTreeEntryFilter | undefined;
      if (options?.respectGitignore) {
        try {
          const gitignoreContent = await fileSystem.readTextFile(path.join(projectRoot, '.gitignore'));
          includeEntry = createGitignoreEntryFilter(projectRoot, gitignoreContent);
        } catch (error) {
          if (readErrorCode(error) !== 'ENOENT') {
            dependencies.logger.error(`Error reading .gitignore in "${projectRoot}"`, error);
          }
        }
      }

      return buildFileTree(projectRoot, 10, 0, includeEntry);
    },

    async listProjectDirectory(projectId, directoryPath, options) {
      const projectRoot = await resolveProjectRoot(projectId);
      try {
        await fileSystem.access(projectRoot);
      } catch {
        throw createFileTreeError(`Project path not found: ${projectRoot}`, 404, 'PROJECT_PATH_NOT_FOUND');
      }

      const targetPath = directoryPath
        ? resolveDirectoryInsideProject(projectRoot, directoryPath)
        : path.resolve(projectRoot);

      try {
        const stats = await fileSystem.stat(targetPath);
        if (!stats.isDirectory()) {
          throw createFileTreeError('Path is not a directory', 400, 'NOT_A_DIRECTORY');
        }
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw createFileTreeError('Directory not accessible', 404, 'DIRECTORY_NOT_ACCESSIBLE');
      }

      let includeEntry: FileTreeEntryFilter = includeEntryByFallbackDirectoryNames;
      if (options?.respectGitignore) {
        try {
          const gitignoreContent = await fileSystem.readTextFile(path.join(projectRoot, '.gitignore'));
          includeEntry = createGitignoreEntryFilter(projectRoot, gitignoreContent);
        } catch (error) {
          if (readErrorCode(error) !== 'ENOENT') {
            dependencies.logger.error(`Error reading .gitignore in "${projectRoot}"`, error);
          }
        }
      }

      return buildDirectoryListing(targetPath, includeEntry);
    },

    async listProjectFileIndex(projectId) {
      const cachedIndex = fileIndexCache.get(projectId);
      if (cachedIndex) {
        return cachedIndex;
      }

      const indexPromise = buildProjectFileIndex(projectId);
      fileIndexCache.set(projectId, indexPromise);
      try {
        return await indexPromise;
      } catch (error) {
        // A failed build must not pin the failure for the process lifetime.
        fileIndexCache.delete(projectId);
        throw error;
      }
    },

    async createEntry(input) {
      validateFilename(input.name);
      const projectRoot = await resolveProjectRoot(input.projectId);
      const targetPath = input.parentPath
        ? path.join(input.parentPath, input.name)
        : input.name;
      const resolvedPath = resolvePathInsideProject(projectRoot, targetPath);

      try {
        await fileSystem.access(resolvedPath);
        throw createFileTreeError(
          `${input.type === 'file' ? 'File' : 'Directory'} already exists`,
          409,
          'FILE_TREE_ENTRY_EXISTS',
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        if (input.type === 'directory') {
          await fileSystem.makeDirectory(resolvedPath, false);
        } else {
          const parentDirectory = path.dirname(resolvedPath);
          try {
            await fileSystem.access(parentDirectory);
          } catch {
            await fileSystem.makeDirectory(parentDirectory, true);
          }
          await fileSystem.writeTextFile(resolvedPath, '');
        }
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'Parent directory not found', statusCode: 404 },
        });
      }

      invalidateFileIndex(input.projectId);

      return {
        success: true,
        path: resolvedPath,
        name: input.name,
        type: input.type,
        message: `${input.type === 'file' ? 'File' : 'Directory'} created successfully`,
      };
    },

    async renameEntry(input) {
      validateFilename(input.newName);
      const projectRoot = await resolveProjectRoot(input.projectId);
      const resolvedOldPath = resolvePathInsideProject(projectRoot, input.oldPath);

      try {
        await fileSystem.access(resolvedOldPath);
      } catch {
        throw createFileTreeError('File or directory not found', 404, 'FILE_TREE_ENTRY_NOT_FOUND');
      }

      const resolvedNewPath = path.join(path.dirname(resolvedOldPath), input.newName);
      resolvePathInsideProject(projectRoot, resolvedNewPath);
      try {
        await fileSystem.access(resolvedNewPath);
        throw createFileTreeError(
          'A file or directory with this name already exists',
          409,
          'FILE_TREE_ENTRY_EXISTS',
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        await fileSystem.rename(resolvedOldPath, resolvedNewPath);
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          EXDEV: { message: 'Cannot move across different filesystems', statusCode: 400 },
        });
      }

      invalidateFileIndex(input.projectId);

      return {
        success: true,
        oldPath: resolvedOldPath,
        newPath: resolvedNewPath,
        newName: input.newName,
        message: 'Renamed successfully',
      };
    },

    async deleteEntry(input) {
      const projectRoot = await resolveProjectRoot(input.projectId);
      const resolvedPath = resolvePathInsideProject(projectRoot, input.targetPath);
      let stats;
      try {
        stats = await fileSystem.stat(resolvedPath);
      } catch {
        throw createFileTreeError('File or directory not found', 404, 'FILE_TREE_ENTRY_NOT_FOUND');
      }

      if (resolvedPath === path.resolve(projectRoot)) {
        throw createFileTreeError('Cannot delete project root directory', 403, 'PROJECT_ROOT_DELETE_FORBIDDEN');
      }

      try {
        if (stats.isDirectory()) {
          await fileSystem.removeDirectory(resolvedPath);
        } else {
          await fileSystem.unlink(resolvedPath);
        }
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          ENOTEMPTY: { message: 'Directory is not empty', statusCode: 400 },
        });
      }

      const entryType = stats.isDirectory() ? 'directory' as const : 'file' as const;
      invalidateFileIndex(input.projectId);
      return {
        success: true,
        path: resolvedPath,
        type: entryType,
        message: 'Deleted successfully',
      };
    },

    async storeUploadedFiles(input) {
      if (input.files.length === 0) {
        throw createFileTreeError('No files provided', 400, 'UPLOAD_FILES_REQUIRED');
      }

      try {
        const projectRoot = await resolveProjectRoot(input.projectId);
        const resolvedTargetDirectory = !input.targetPath
          || input.targetPath === '.'
          || input.targetPath === './'
          ? path.resolve(projectRoot)
          : resolvePathInsideProject(projectRoot, input.targetPath);

        try {
          await fileSystem.access(resolvedTargetDirectory);
        } catch {
          await fileSystem.makeDirectory(resolvedTargetDirectory, true);
        }

        const uploadedFiles: Array<{ name: string; path: string; size: number; mimeType: string }> = [];
        for (let fileIndex = 0; fileIndex < input.files.length; fileIndex += 1) {
          const file = input.files[fileIndex];
          const fileName = input.relativePaths[fileIndex] || file.originalName;
          const destinationPath = path.join(resolvedTargetDirectory, fileName);

          try {
            resolvePathInsideProject(projectRoot, destinationPath);
          } catch (error) {
            if (error instanceof AppError && error.statusCode === 403) {
              await cleanupTemporaryFiles([file]);
              continue;
            }
            throw error;
          }

          const parentDirectory = path.dirname(destinationPath);
          try {
            await fileSystem.access(parentDirectory);
          } catch {
            await fileSystem.makeDirectory(parentDirectory, true);
          }

          await fileSystem.copyFile(file.temporaryPath, destinationPath);
          await fileSystem.unlink(file.temporaryPath);
          uploadedFiles.push({
            name: fileName,
            path: destinationPath,
            size: file.size,
            mimeType: file.mimeType,
          });
        }

        invalidateFileIndex(input.projectId);

        return {
          success: true,
          files: uploadedFiles,
          uploadedCount: uploadedFiles.length,
          requestedFileCount: input.requestedFileCount,
          targetPath: resolvedTargetDirectory,
          message: `Uploaded ${uploadedFiles.length} ${uploadedFiles.length === 1 ? 'file' : 'files'} successfully`,
        };      } catch (error) {
        await cleanupTemporaryFiles(input.files);
        if (readErrorCode(error) === 'EACCES') {
          throw createFileTreeError('Permission denied', 403, 'EACCES');
        }
        if (error instanceof AppError) throw error;
        dependencies.logger.error(`Error uploading files: ${readErrorMessage(error)}`, error);
        throw error;
      }
    },
  };
}
