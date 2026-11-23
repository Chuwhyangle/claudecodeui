/**
 * The worktree diff digest: what it answers, and what it answers on failure.
 *
 *   ① the same worktree read twice gives the same digest;
 *   ② an uncommitted edit changes it (that is the "did the agent change
 *      anything" reading the no-progress breaker compares);
 *   ③ a new commit changes it;
 *   ④ a path git cannot read at all is an EMPTY reading that resolves — never a
 *      rejection — and stays stable across calls.
 *
 * The repository is a throwaway `git init` under the OS temp directory, so this
 * test never touches the project's own worktrees.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/goals/tests/diff-digest.test.ts
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { computeWorktreeDigest } from '../diff-digest.js';

const execFileAsync = promisify(execFile);

/** Git needs an identity to commit; set it locally so the host config is untouched. */
async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true });
}

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'goal-digest-'));
  await git(directory, 'init', '-q');
  // `git init -b` needs git 2.28; the checkout spelling works on the older git
  // this repository's hosts still carry.
  await git(directory, 'checkout', '-q', '-b', 'main');
  await git(directory, 'config', 'user.email', 'goal-loop@example.invalid');
  await git(directory, 'config', 'user.name', 'Goal Loop Test');
  await writeFile(path.join(directory, 'notes.txt'), 'first version\n', 'utf8');
  await git(directory, 'add', 'notes.txt');
  await git(directory, 'commit', '-q', '-m', 'initial');
  return directory;
}

test('the same worktree reads the same digest twice', async () => {
  const repository = await createRepository();
  try {
    const first = await computeWorktreeDigest(repository);
    const second = await computeWorktreeDigest(repository);

    assert.match(first, /^[0-9a-f]{64}$/, 'the digest is hex sha256');
    assert.equal(second, first);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('an uncommitted edit changes the digest', async () => {
  const repository = await createRepository();
  try {
    const before = await computeWorktreeDigest(repository);

    await writeFile(path.join(repository, 'notes.txt'), 'edited in the worktree\n', 'utf8');
    const afterEdit = await computeWorktreeDigest(repository);

    assert.notEqual(afterEdit, before, 'a dirty worktree must read differently from a clean one');
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('a new commit changes the digest', async () => {
  const repository = await createRepository();
  try {
    const before = await computeWorktreeDigest(repository);

    await writeFile(path.join(repository, 'notes.txt'), 'committed version\n', 'utf8');
    await git(repository, 'add', 'notes.txt');
    await git(repository, 'commit', '-q', '-m', 'second');
    const afterCommit = await computeWorktreeDigest(repository);

    assert.notEqual(afterCommit, before, 'HEAD is part of the digest');
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('a path git cannot read resolves to a stable empty digest', async () => {
  const missing = path.join(os.tmpdir(), `goal-digest-missing-${process.pid}-${Date.now()}`);

  const first = await computeWorktreeDigest(missing);
  const second = await computeWorktreeDigest(missing);

  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(second, first, 'a failed read must not flicker between rounds');
});

test('a plain directory that is not a repository behaves like a missing one', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'goal-digest-plain-'));
  try {
    const plain = await computeWorktreeDigest(directory);
    const missing = await computeWorktreeDigest(`${directory}-nope`);

    // Both git reads failed, so both are the empty reading: equal, and still a
    // sha256 rather than a rejection.
    assert.equal(plain, missing);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
