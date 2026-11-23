import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  ensureGoalWorktree,
  mergeGoalWorktree,
  removeGoalWorktree,
} from '@/modules/goals/goal-worktree.service.js';

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

function goalWorktreeDir(projectPath: string, goalId: string): string {
  return path.join(`${projectPath}-worktrees`, `goal-${goalId}`);
}

type Fixture = {
  projectPath: string;
  cleanup: () => Promise<void>;
};

/** A throwaway repository with one commit and a committed `shared.txt`. */
async function createRepo(): Promise<Fixture> {
  const projectPath = await mkdtemp(path.join(os.tmpdir(), 'goal-worktree-'));
  await git(['init'], projectPath);
  await git(['config', 'user.email', 'goal-loop@test.local'], projectPath);
  await git(['config', 'user.name', 'Goal Loop Test'], projectPath);
  await writeFile(path.join(projectPath, 'shared.txt'), 'base\n', 'utf8');
  await git(['add', '.'], projectPath);
  await git(['commit', '-m', 'initial'], projectPath);

  return {
    projectPath,
    cleanup: async () => {
      await rm(`${projectPath}-worktrees`, { recursive: true, force: true });
      await rm(projectPath, { recursive: true, force: true });
    },
  };
}

async function commitFile(worktreePath: string, file: string, content: string, message: string) {
  await writeFile(path.join(worktreePath, file), content, 'utf8');
  await git(['add', '.'], worktreePath);
  await git(['commit', '-m', message], worktreePath);
}

test('ensure creates the goal worktree on goal/<id> and reuses it', async () => {
  const fixture = await createRepo();
  try {
    const first = await ensureGoalWorktree({ projectPath: fixture.projectPath, goalId: 'g1' });
    assert.equal(first.worktreePath, goalWorktreeDir(fixture.projectPath, 'g1'));
    assert.equal(first.branch, 'goal/g1');
    assert.equal(
      (await git(['rev-parse', '--abbrev-ref', 'HEAD'], first.worktreePath)).trim(),
      'goal/g1',
    );

    // Activation retried after a crash must land in the same place.
    const second = await ensureGoalWorktree({ projectPath: fixture.projectPath, goalId: 'g1' });
    assert.deepEqual(second, first);
  } finally {
    await fixture.cleanup();
  }
});

test('ensure creates the branch when it does not exist yet', async () => {
  const fixture = await createRepo();
  try {
    const branches = await git(['branch', '--list', 'goal/g2'], fixture.projectPath);
    assert.equal(branches.trim(), '');

    await ensureGoalWorktree({ projectPath: fixture.projectPath, goalId: 'g2' });
    assert.match(await git(['branch', '--list', 'goal/g2'], fixture.projectPath), /goal\/g2/);
  } finally {
    await fixture.cleanup();
  }
});

test('ensure refuses an existing directory that is not on the goal branch', async () => {
  const fixture = await createRepo();
  try {
    await mkdir(goalWorktreeDir(fixture.projectPath, 'g3'), { recursive: true });
    await assert.rejects(
      () => ensureGoalWorktree({ projectPath: fixture.projectPath, goalId: 'g3' }),
      /exists but is not on goal\/g3/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test('merge fast-forwards nothing and reports the merge commit', async () => {
  const fixture = await createRepo();
  try {
    const worktree = await ensureGoalWorktree({ projectPath: fixture.projectPath, goalId: 'g4' });
    await commitFile(worktree.worktreePath, 'goal.txt', 'goal work\n', 'goal change');

    const result = await mergeGoalWorktree({
      projectPath: fixture.projectPath,
      worktreePath: worktree.worktreePath,
      branch: worktree.branch,
      message: 'merge goal g4',
    });

    assert.equal(result.merged, true);
    assert.equal(result.reason, null);
    assert.match(result.commit ?? '', /^[0-9a-f]{40}$/);
    assert.equal((await git(['rev-parse', 'HEAD'], fixture.projectPath)).trim(), result.commit);
    assert.equal(
      await readFile(path.join(fixture.projectPath, 'goal.txt'), 'utf8'),
      'goal work\n',
    );
  } finally {
    await fixture.cleanup();
  }
});

test('a conflicting merge reports instead of throwing and keeps the worktree', async () => {
  const fixture = await createRepo();
  try {
    const worktree = await ensureGoalWorktree({ projectPath: fixture.projectPath, goalId: 'g5' });

    await commitFile(worktree.worktreePath, 'shared.txt', 'goal side\n', 'goal side change');
    await commitFile(fixture.projectPath, 'shared.txt', 'main side\n', 'main side change');

    const result = await mergeGoalWorktree({
      projectPath: fixture.projectPath,
      worktreePath: worktree.worktreePath,
      branch: worktree.branch,
      message: 'merge goal g5',
    });

    assert.equal(result.merged, false);
    assert.equal(result.commit, null);
    assert.ok(result.reason && result.reason.length > 0, 'the reason must carry git output');

    // The worktree and its branch survive so a person can resolve and retry.
    await access(worktree.worktreePath);
    assert.equal(
      (await git(['rev-parse', '--abbrev-ref', 'HEAD'], worktree.worktreePath)).trim(),
      'goal/g5',
    );

    // The main checkout is rolled back to its pre-merge state: no conflict
    // markers, no half-finished merge.
    assert.equal((await git(['status', '--porcelain'], fixture.projectPath)).trim(), '');
    await assert.rejects(() => git(['rev-parse', '--verify', 'MERGE_HEAD'], fixture.projectPath));
    assert.equal(
      await readFile(path.join(fixture.projectPath, 'shared.txt'), 'utf8'),
      'main side\n',
    );
  } finally {
    await fixture.cleanup();
  }
});

test('merge refuses a missing worktree instead of claiming a commit', async () => {
  const fixture = await createRepo();
  try {
    const worktree = await ensureGoalWorktree({ projectPath: fixture.projectPath, goalId: 'g6b' });
    await commitFile(worktree.worktreePath, 'gone.txt', 'gone\n', 'work left on the branch');
    await removeGoalWorktree({
      projectPath: fixture.projectPath,
      worktreePath: worktree.worktreePath,
      branch: worktree.branch,
    });

    const result = await mergeGoalWorktree({
      projectPath: fixture.projectPath,
      worktreePath: worktree.worktreePath,
      branch: worktree.branch,
      message: 'merge goal g6b',
    });

    assert.equal(result.merged, false);
    assert.equal(result.commit, null);
    assert.match(result.reason ?? '', /goal worktree is missing/);
  } finally {
    await fixture.cleanup();
  }
});

test('remove drops the worktree but keeps the branch, and is idempotent', async () => {
  const fixture = await createRepo();
  try {
    const worktree = await ensureGoalWorktree({ projectPath: fixture.projectPath, goalId: 'g6' });
    await commitFile(worktree.worktreePath, 'kept.txt', 'kept\n', 'work to keep');

    await removeGoalWorktree({
      projectPath: fixture.projectPath,
      worktreePath: worktree.worktreePath,
      branch: worktree.branch,
    });

    await assert.rejects(() => access(worktree.worktreePath));
    assert.match(await git(['branch', '--list', 'goal/g6'], fixture.projectPath), /goal\/g6/);
    assert.ok(!(await git(['worktree', 'list'], fixture.projectPath)).includes('goal-g6'));

    // Removing an already-removed worktree is not an error.
    await removeGoalWorktree({
      projectPath: fixture.projectPath,
      worktreePath: worktree.worktreePath,
      branch: worktree.branch,
    });
  } finally {
    await fixture.cleanup();
  }
});
