import { createHash, randomUUID } from 'node:crypto';

import type {
  CriterionReading,
  Goal,
  GoalAc,
  GoalEvidence,
  GoalRound,
  GoalRoundOutcome,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import type { MergeGoalWorktreeResult } from './goal-worktree.service.js';
import type { GoalsDb } from './goals.service.js';
import { buildRoundPrompt, tailExcerpt } from './round-prompt.js';

// --------------------------- Round execution ------------

/**
 * What one manual round needs: the goals store, the criterion runner, and a
 * clock. Injected so a test can drive a round without git, subprocesses, or a
 * database.
 */
export type RunRoundDeps = {
  db: GoalsDb;
  runCriterion: (options: { command: string; cwd: string; timeoutMs?: number }) => Promise<CriterionReading>;
  /**
   * Merge the goal branch back once every AC passes. Required so an `achieved`
   * goal always names a merge outcome: a green round that could not land must
   * not report itself as finished.
   */
  mergeGoalWorktree: (input: {
    projectPath: string;
    worktreePath: string;
    branch: string;
    message: string;
  }) => Promise<MergeGoalWorktreeResult>;
  /**
   * Digest of the worktree's HEAD + working tree, taken once per round. Required
   * because the no-progress breaker (docs §5.4) compares consecutive rounds by
   * it: a loop whose worktree never changes is spending tokens for nothing.
   */
  computeDiffDigest: (worktreePath: string) => Promise<string>;
  now: () => Date;
};

/** Everything one round produced, including the prompt a driver would send next. */
export type RunRoundResult = {
  round: GoalRound;
  readings: Array<{ acId: string; reading: CriterionReading }>;
  allGreen: boolean;
  redAcs: GoalAc[];
  /** Empty when every AC passed: an achieved goal has nobody left to prompt. */
  prompt: string;
  /**
   * What happened when a green round tried to land its branch. `null` on a red
   * round, where there is nothing to merge.
   */
  merge: MergeGoalWorktreeResult | null;
  /**
   * True when the no-progress breaker fired: the round's diff digest and every
   * criterion's reading matched the previous `budget.maxNoProgress - 1` rounds,
   * so the round was `stalled` and the goal was flipped to `stalled`. A stalled
   * round never carries a prompt — there is nothing new to tell the agent.
   */
  stalled: boolean;
};

/**
 * Runs one round of a goal: every active AC's criterion in the goal worktree,
 * one evidence row per reading, then the round's outcome.
 *
 * Consumers: the goals routes' manual `run-round` endpoint now, and the resident
 * driver in the next phase. It never starts the following round — sending the
 * returned prompt and waiting for the session's turn belongs to the caller.
 *
 * The goal's status is derived from the readings only: all green flips it to
 * `achieved` (via the merge), a stall flips it to `stalled`, and anything else
 * leaves it `active` for another round.
 */
export async function runGoalRound(goalId: string, deps: RunRoundDeps): Promise<RunRoundResult> {
  const { db } = deps;

  const goal = db.getGoal(goalId);
  if (!goal) {
    throw new AppError(`Goal "${goalId}" does not exist.`, {
      code: 'GOAL_NOT_FOUND',
      statusCode: 404,
    });
  }
  if (goal.status !== 'active') {
    throw new AppError(`Only an active goal can run a round; "${goal.title}" is ${goal.status}.`, {
      code: 'GOAL_NOT_ACTIVE',
      statusCode: 409,
    });
  }
  if (!goal.worktreePath) {
    throw new AppError(`Goal "${goal.title}" has no worktree; its criteria have nowhere to run.`, {
      code: 'GOAL_WORKTREE_MISSING',
      statusCode: 409,
    });
  }

  const worktreePath = goal.worktreePath;
  const acs = db.listAcs(goalId).filter((ac) => ac.status === 'active');
  if (acs.length === 0) {
    throw new AppError('The goal has no active acceptance criteria; a round would prove nothing.', {
      code: 'GOAL_HAS_NO_ACTIVE_AC',
      statusCode: 409,
    });
  }

  const seq = db.listRounds(goalId).length + 1;
  const round = db.createRound({
    id: randomUUID(),
    goalId,
    seq,
    startedAt: deps.now().toISOString(),
  });

  // Serial on purpose (docs §5.5): criteria that build or test share one working
  // tree, so parallel runs would poison each other's readings.
  const readings: Array<{ acId: string; reading: CriterionReading }> = [];
  for (const ac of acs) {
    const reading = await deps.runCriterion({ command: ac.criterion, cwd: worktreePath });
    readings.push({ acId: ac.id, reading });

    db.addEvidence({
      id: randomUUID(),
      roundId: round.id,
      acId: ac.id,
      exitCode: reading.exitCode,
      timedOut: reading.timedOut,
      outputDigest: reading.outputDigest,
      outputExcerpt: tailExcerpt(reading.output),
      verdict: reading.verdict,
      at: deps.now().toISOString(),
    });
  }

  const redAcs = acs.filter(
    (ac) => readings.find((entry) => entry.acId === ac.id)?.reading.verdict !== 'pass',
  );
  const allGreen = redAcs.length === 0;

  // The worktree's state is read AFTER the criteria ran: that half-second's
  // files are what the next round will judge, so the digest must describe them.
  const diffDigest = await deps.computeDiffDigest(worktreePath);

  // A green round is always an achievement, never a stall: the criteria moved
  // even if the worktree digest happens to repeat.
  const stalled = !allGreen && stalledRound(goal, round, diffDigest, deps);

  const outcome: GoalRoundOutcome = allGreen ? 'green' : stalled ? 'stalled' : 'progress';

  const prompt = allGreen
    ? ''
    : buildRoundPrompt({ goal, redAcs, readings, roundSeq: round.seq });

  const ended = db.endRound(round.id, {
    outcome,
    endedAt: deps.now().toISOString(),
    diffDigest,
    promptDigest: prompt ? createHash('sha256').update(prompt, 'utf8').digest('hex') : null,
  });
  if (!ended) {
    throw new AppError(`Round "${round.id}" disappeared while it was being closed.`, {
      code: 'GOAL_ROUND_NOT_FOUND',
      statusCode: 500,
    });
  }

  if (stalled) {
    // The goal stops here rather than looping against an unchanged worktree.
    // `stalled` is resumable by a person (`POST /:id/resume`), unlike `achieved`.
    db.updateGoal(goal.id, { status: 'stalled' });
  }

  const merge = allGreen ? await landAchievedGoal(goal, deps) : null;

  return { round: ended, readings, allGreen, redAcs, prompt, merge, stalled };
}

/**
 * Whether this round made no observable progress (docs/proposals/goal-loop.md
 * §5.4): the last `budget.maxNoProgress` rounds — this one included — must all
 * carry the same worktree diff digest AND the same per-AC `verdict` +
 * `outputDigest` readings.
 *
 * Both halves are required. A worktree digest alone would call a round stalled
 * when the agent changed nothing but a criterion flipped (a flaky test, a
 * different environment); the readings alone would miss a refactor that touched
 * no criterion.
 *
 * Conservative by construction: a window with no readable digest on its oldest
 * round (a round recorded before digests existed) is not a stall — the loop
 * keeps running rather than stopping on evidence it does not have.
 */
function stalledRound(
  goal: Goal,
  round: GoalRound,
  diffDigest: string,
  deps: RunRoundDeps,
): boolean {
  const windowSize = Math.max(1, Math.floor(goal.budget.maxNoProgress));

  // Completed rounds only: an earlier round whose digest was never written cannot
  // be compared, and excluding open rounds keeps the window chronological.
  const previous = deps.db
    .listRounds(goal.id)
    .filter((entry) => entry.id !== round.id && entry.endedAt !== null);

  // `slice(-0)` is `slice(0)`, so the "all but the last" take is spelled out.
  const take = windowSize - 1;
  const window = take > 0 ? previous.slice(Math.max(0, previous.length - take)) : [];
  window.push({ ...round, diffDigest });

  if (window.length < windowSize) return false;

  const firstDigest = window[0].diffDigest;
  if (!firstDigest) return false;
  if (!window.every((entry) => entry.diffDigest === firstDigest)) return false;

  const signatures = window.map((entry) => evidenceSignature(deps.db.listEvidence(entry.id)));
  return signatures.every((signature) => signature === signatures[0]);
}

/**
 * One round's readings reduced to a comparable string: every evidence row's AC,
 * verdict and output digest, sorted so the criteria's execution order cannot
 * fake a difference.
 */
function evidenceSignature(entries: GoalEvidence[]): string {
  return entries
    .map((entry) => `${entry.acId}\u0000${entry.verdict}\u0000${entry.outputDigest}`)
    .sort()
    .join('\u0001');
}

/**
 * Lands a green goal: merge `goal/<id>` into the project's main worktree, then
 * mark the goal `achieved` only if the merge really produced a commit.
 *
 * A merge that cannot land leaves the goal `paused`, not `achieved` and not
 * `active`: `achieved` would claim code that never reached the main worktree,
 * while `active` would invite another round against a branch the main worktree
 * is already refusing. The worktree and branch stay on disk so a person can
 * resolve the conflict and resume.
 */
async function landAchievedGoal(goal: Goal, deps: RunRoundDeps): Promise<MergeGoalWorktreeResult> {
  const projectPath = deps.db.getProjectPath(goal.projectId);
  if (!projectPath || !goal.worktreePath || !goal.branch) {
    const reason = !projectPath
      ? `project "${goal.projectId}" has no directory on disk`
      : 'the goal has no worktree or branch to merge';
    deps.db.updateGoal(goal.id, { status: 'paused' });
    return { merged: false, commit: null, reason };
  }

  const result = await deps.mergeGoalWorktree({
    projectPath,
    worktreePath: goal.worktreePath,
    branch: goal.branch,
    message: `goal: ${goal.title}`,
  });

  if (result.merged) {
    deps.db.updateGoal(goal.id, { status: 'achieved', achievedAt: deps.now().toISOString() });
  } else {
    deps.db.updateGoal(goal.id, { status: 'paused' });
  }
  return result;
}
