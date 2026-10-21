import { execFile } from 'node:child_process';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import type { FileTreeFileSystem } from '@/shared/types.js';

const execFileAsync = promisify(execFile);

// A large monorepo's `git ls-files` output can exceed Node's 1 MB default
// maxBuffer; the index is exactly the place a big project shows up, so the
// buffer is sized for it rather than left to inherit the default.
const MAXIMUM_GIT_LS_FILES_BYTES = 64 * 1024 * 1024;

/**
 * Production git-backed probes consumed by the File Tree composition root.
 *
 * `createFileTreeService` receives these through the optional
 * `FileTreeFileSystem.isGitRepository` / `listGitFiles` ports. Keeping the
 * subprocess in an adapter means the service never shells out itself and tests
 * can supply either these real probes or hand-written fakes.
 *
 * `git ls-files --cached --others --exclude-standard` is the single source of
 * truth for the index: it applies every nested `.gitignore`, `.git/info/exclude`,
 * and `core.excludesFile` rule exactly as git does, which a root-.gitignore-only
 * filter cannot reproduce (a nested `.venv/` would leak into the index).
 */
export function createGitFileTreePorts(): Pick<
  FileTreeFileSystem,
  'isGitRepository' | 'listGitFiles'
> {
  return {
    async isGitRepository(projectRoot) {
      try {
        // `.git` is a directory for ordinary repositories and a file for linked
        // worktrees and submodules, so existence — not type — identifies one.
        await fsPromises.access(path.join(projectRoot, '.git'));
        return true;
      } catch {
        return false;
      }
    },

    async listGitFiles(projectRoot) {
      const { stdout } = await execFileAsync(
        'git',
        ['ls-files', '--cached', '--others', '--exclude-standard'],
        { cwd: projectRoot, maxBuffer: MAXIMUM_GIT_LS_FILES_BYTES },
      );
      return stdout.split('\n').filter((relativePath) => relativePath.length > 0);
    },
  };
}
