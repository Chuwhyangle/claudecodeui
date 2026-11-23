import { execFile } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

// --------------------------- Goal worktree ------------

const execFileAsync = promisify(execFile);

/**
 * Upper bound for one git invocation. git's own network/lock waits are the
 * only slow paths here (worktree add, merge), and a wedged git must surface as
 * a failure the activation path can report rather than as a hung request.
 */
const GIT_TIMEOUT_MS = 120_000;

/** Enough for `git worktree list`-scale output without letting git flood us. */
const GIT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/** The worktree a goal's session and every criterion run in. */
export type GoalWorktree = {
  worktreePath: string;
  branch: string;
};

/**
 * What a merge back into the main checkout answered.
 *
 * `merged: false` is a normal outcome (conflict, dirty target, ...): the goal
 * worktree and its branch are always left in place so a person can inspect and
 * retry. Only the merge itself is attempted — the worktree is never removed
 * here.
 */
export type MergeGoalWorktreeResult = {
  merged: boolean;
  /** The main checkout's HEAD after a successful merge; null otherwise. */
  commit: string | null;
  /** git's own diagnostic when `merged` is false; null on success. */
  reason: string | null;
};

/** One git invocation's outcome. `detail` is the text a person should read. */
type GitOutcome = {
  ok: boolean;
  stdout: string;
  stderr: string;
  detail: string;
};

/** Runs git without a shell; never rejects, so callers decide on `ok`. */
async function runGit(args: string[], cwd: string): Promise<GitOutcome> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER_BYTES,
      windowsHide: true,
    });
    return { ok: true, stdout: String(stdout), stderr: String(stderr), detail: '' };
  } catch (error) {
    const failure = error as {
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
      message?: unknown;
    };
    const stdout = typeof failure.stdout === 'string' ? failure.stdout : '';
    const stderr = typeof failure.stderr === 'string' ? failure.stderr : '';
    const message = typeof failure.message === 'string' ? failure.message : String(error);
    return {
      ok: false,
      stdout,
      stderr,
      detail: (stderr || stdout || message).trim(),
    };
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** `goal/<goalId>` — fixed by the activation contract, never derived. */
function goalBranch(goalId: string): string {
  return `goal/${goalId}`;
}

/**
 * `<projectPath>-worktrees/goal-<goalId>`.
 *
 * This mirrors the worktrees module's convention — a sibling container named
 * `<repo>-worktrees`, with the branch's `/` flattened to `-` — so a goal
 * worktree sits beside the ones created from the Worktrees UI instead of
 * inventing a second location. It is based on `projectPath` (which is what the
 * goal records) rather than on the git root git reports, so the path is stable
 * even when the project points at a subdirectory. `path.resolve` strips any
 * trailing separator first, since `${dir}-worktrees` on `dir/` would otherwise
 * produce a doubled separator.
 */
function goalWorktreePath(projectPath: string, goalId: string): string {
  const base = path.resolve(projectPath);
  return path.join(`${base}-worktrees`, `goal-${goalId}`);
}

/**
 * Creates (or reuses) the worktree a goal runs in.
 *
 * Consumers: the activation path (`goals.service.ts`), which needs a real
 * directory on `goal/<goalId>` before it can bind a session or run the
 * red-first check. A failure here aborts activation, so every git failure is
 * thrown with git's own diagnostic — never swallowed.
 *
 * Reuse is deliberate: an activation retried after a crash must land in the
 * same directory with the same branch and the agent's previous work intact. An
 * existing directory that is NOT on that branch is refused rather than
 * silently reused, because the session would otherwise run somewhere the goal
 * does not own.
 */
export async function ensureGoalWorktree(input: {
  projectPath: string;
  goalId: string;
}): Promise<GoalWorktree> {
  const worktreePath = goalWorktreePath(input.projectPath, input.goalId);
  const branch = goalBranch(input.goalId);

  if (await pathExists(worktreePath)) {
    const head = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
    if (!head.ok || head.stdout.trim() !== branch) {
      throw new Error(
        `Goal worktree exists but is not on ${branch}: ${worktreePath}` +
          (head.ok ? ` (HEAD is ${head.stdout.trim() || 'detached'})` : ` (${head.detail})`),
      );
    }
    return { worktreePath, branch };
  }

  // `git worktree add` creates the final directory but not the container.
  await mkdir(path.dirname(worktreePath), { recursive: true });

  // A quiet ref check is exit-code only: no git output is parsed to decide
  // whether the branch exists.
  const branchExists = (
    await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], input.projectPath)
  ).ok;

  const addArgs = branchExists
    ? ['worktree', 'add', worktreePath, branch]
    : ['worktree', 'add', '-b', branch, worktreePath];

  const added = await runGit(addArgs, input.projectPath);
  if (!added.ok) {
    throw new Error(`git ${addArgs.join(' ')} failed: ${added.detail}`);
  }

  return { worktreePath, branch };
}

/**
 * Merges the goal branch back into the main checkout (`--no-ff`, so the round
 * history stays readable).
 *
 * Consumers: the goal driver when every AC turns green (`achieved`). It
 * reports instead of throwing, because a conflict is a state a person resolves
 * — the caller pauses the goal and notifies; the worktree and branch must
 * survive untouched so the merge can be retried once the conflict is fixed.
 *
 * Any failed merge is rolled back with `git merge --abort` (best effort) so the
 * main checkout is not left with conflict markers in the working tree; a
 * failure with no merge in progress (e.g. unknown branch) makes that a no-op.
 * A missing worktree directory is reported as a failure too — merging the bare
 * branch would otherwise claim a commit the goal never produced.
 */
export async function mergeGoalWorktree(input: {
  projectPath: string;
  worktreePath: string;
  branch: string;
  message: string;
}): Promise<MergeGoalWorktreeResult> {
  // A merge from a worktree that no longer exists would still succeed (the
  // branch survives), and would report a commit as if the goal's work had been
  // merged in. Treat the missing directory as the inconsistent state it is.
  if (!(await pathExists(input.worktreePath))) {
    return {
      merged: false,
      commit: null,
      reason: `goal worktree is missing: ${input.worktreePath}`,
    };
  }

  const merged = await runGit(
    ['merge', '--no-ff', input.branch, '-m', input.message],
    input.projectPath,
  );

  if (!merged.ok) {
    await runGit(['merge', '--abort'], input.projectPath);
    return { merged: false, commit: null, reason: merged.detail };
  }

  const head = await runGit(['rev-parse', 'HEAD'], input.projectPath);
  if (!head.ok) {
    // The merge reported success but HEAD is unreadable — do not claim a
    // commit we cannot name. `input.worktreePath` is intentionally untouched.
    return { merged: false, commit: null, reason: `git rev-parse HEAD failed: ${head.detail}` };
  }

  return { merged: true, commit: head.stdout.trim(), reason: null };
}

/**
 * Removes the goal worktree, keeping its branch.
 *
 * Consumers: the abandon path (`goals.service.ts`). The archive rule for this
 * repository is "archive, do not delete": removing the directory is safe
 * because `goal/<goalId>` still holds every commit the agent made, so the work
 * can be re-checked out later. The branch is therefore never deleted here, and
 * `input.branch` is only used in the diagnostic text.
 *
 * Idempotent: an already-removed path is not an error.
 */
export async function removeGoalWorktree(input: {
  projectPath: string;
  worktreePath: string;
  branch: string;
}): Promise<void> {
  if (!(await pathExists(input.worktreePath))) return;

  const removed = await runGit(
    ['worktree', 'remove', '--force', input.worktreePath],
    input.projectPath,
  );
  if (!removed.ok) {
    throw new Error(
      `git worktree remove failed for ${input.worktreePath} (branch ${input.branch} kept): ${removed.detail}`,
    );
  }
}
