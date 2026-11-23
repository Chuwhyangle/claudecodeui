import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// --------------------------- Worktree diff digest ------------

/**
 * Upper bound for one git read. The three reads below are local and cheap; the
 * bound exists so a wedged git (an index lock held by another process, a
 * filesystem that stopped answering) surfaces as an empty reading within one
 * round instead of stalling the goal loop.
 */
const GIT_TIMEOUT_MS = 60_000;

/**
 * Upper bound for one git read's stdout. A goal worktree whose diff exceeds
 * this is treated as an empty reading rather than allowed to grow the driver's
 * memory without limit.
 */
const GIT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/**
 * One git read's text, or `''` when it failed.
 *
 * Failures are swallowed on purpose: the digest answers "did anything visible
 * change in this worktree", and a read that could not happen observed nothing.
 * Throwing here would abort a round that already produced honest criterion
 * readings.
 */
async function readGit(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER_BYTES,
      windowsHide: true,
    });
    return String(stdout);
  } catch {
    return '';
  }
}

/**
 * Digest of everything a person would call "the worktree's state": the HEAD
 * commit, the porcelain status, and the unstaged diff.
 *
 * Consumers: `run-round.ts` (every round, after the criteria ran) which stores
 * it on the round row, and the no-progress breaker (docs/proposals/goal-loop.md
 * §5.4), which compares consecutive rounds' digests to decide that nothing
 * moved.
 *
 * Never rejects: a missing directory, a branch git does not know, a timeout, or
 * an oversized diff all read as empty text, so the digest stays a pure function
 * of what git could report. Two consecutive failures therefore produce the SAME
 * digest — which is the honest answer ("no observable change"), and the
 * criterion output digests still break the tie before `stalled` is declared.
 */
export async function computeWorktreeDigest(worktreePath: string): Promise<string> {
  // Read in parallel: three independent read-only git commands, and a round
  // already paid for its criteria serially.
  const [head, status, diff] = await Promise.all([
    readGit(['rev-parse', 'HEAD'], worktreePath),
    readGit(['status', '--porcelain'], worktreePath),
    readGit(['diff'], worktreePath),
  ]);

  // The separator is a byte that cannot appear in git's own output for these
  // three commands, so no two different readings can concatenate identically.
  return createHash('sha256').update(`${head}\0${status}\0${diff}`, 'utf8').digest('hex');
}
