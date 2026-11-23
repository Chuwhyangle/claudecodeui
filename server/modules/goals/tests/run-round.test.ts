/**
 * One goal round: what a round records, decides, and refuses.
 *
 *   ① only an active goal with a worktree and an active AC can run a round;
 *   ② the round takes the next sequence number and one evidence row per active AC,
 *      carrying that reading's digest and the tail of its output;
 *   ③ a red round ends `progress`, keeps the goal active, and returns the prompt;
 *   ④ an all-green round ends `green` and flips the goal to achieved;
 *   ⑤ criteria run serially, in the goal worktree, and only for active ACs;
 *   ⑥ every round records the worktree diff digest, and `budget.maxNoProgress`
 *      consecutive rounds with the same digest AND the same readings end
 *      `stalled`, flipping the goal to stalled.
 *
 * The database is an in-memory fake and the criterion runner is injected, so this
 * test never touches SQLite, git, or a subprocess.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/goals/tests/run-round.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  CriterionReading,
  Goal,
  GoalAc,
  GoalEvidence,
  GoalRound,
} from '../../../shared/types.js';
import { AppError } from '../../../shared/utils.js';
import type { MergeGoalWorktreeResult } from '../goal-worktree.service.js';
import type { GoalsDb } from '../goals.service.js';
import { runGoalRound } from '../run-round.js';

// --------------------------- Fakes ------------

type FakeState = {
  goal: Goal;
  acs: GoalAc[];
  rounds: GoalRound[];
  evidence: GoalEvidence[];
};

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: 'goal-1',
    userId: 7,
    projectId: 'proj-1',
    sessionId: 'session-1',
    worktreePath: '/tmp/worktrees/goal-1',
    branch: 'goal/goal-1',
    title: 'Ship the goal loop',
    objective: 'Every acceptance criterion must pass.',
    exitConditions: [],
    status: 'active',
    budget: { maxRounds: 20, maxWallClockMs: 7_200_000, maxNoProgress: 3 },
    createdAt: '2026-11-11T00:00:00.000Z',
    activatedAt: '2026-11-11T00:01:00.000Z',
    achievedAt: null,
    ...overrides,
  };
}

function makeAc(id: string, overrides: Partial<GoalAc> = {}): GoalAc {
  return {
    id,
    goalId: 'goal-1',
    title: `Criterion ${id}`,
    criterion: `run ${id}`,
    expect: 'It fails before the fix.',
    status: 'active',
    createdAt: '2026-11-11T00:00:00.000Z',
    ...overrides,
  };
}

function createFakeDb(goalOverrides: Partial<Goal> = {}, acs: GoalAc[] = []): { db: GoalsDb; state: FakeState } {
  const state: FakeState = {
    goal: makeGoal(goalOverrides),
    acs: acs.map((ac) => ({ ...ac })),
    rounds: [],
    evidence: [],
  };

  const db: GoalsDb = {
    createGoal: () => {
      throw new Error('run-round must not create a goal');
    },
    getGoal: (id) => (id === state.goal.id ? state.goal : null),
    listGoals: () => [state.goal],
    listGoalsByStatus: (status) => (state.goal.status === status ? [state.goal] : []),
    updateGoal: (id, patch) => {
      if (id !== state.goal.id) return null;
      state.goal = { ...state.goal, ...patch };
      return state.goal;
    },
    createAc: () => {
      throw new Error('run-round must not create an AC');
    },
    listAcs: (goalId) => state.acs.filter((ac) => ac.goalId === goalId),
    createRound: (input) => {
      const round: GoalRound = {
        id: input.id,
        goalId: input.goalId,
        seq: input.seq,
        startedAt: input.startedAt,
        endedAt: null,
        outcome: null,
        diffDigest: null,
        promptDigest: null,
      };
      state.rounds.push(round);
      return round;
    },
    endRound: (id, patch) => {
      const round = state.rounds.find((entry) => entry.id === id);
      if (!round) return null;
      round.endedAt = patch.endedAt;
      round.outcome = patch.outcome;
      round.diffDigest = patch.diffDigest ?? null;
      round.promptDigest = patch.promptDigest ?? null;
      return round;
    },
    listRounds: (goalId) => state.rounds.filter((round) => round.goalId === goalId),
    addEvidence: (input) => {
      state.evidence.push({ ...input });
      return state.evidence[state.evidence.length - 1];
    },
    listEvidence: (roundId) => state.evidence.filter((entry) => entry.roundId === roundId),
    getProjectPath: () => '/home/wenhao/cloudcli-dev',
  };

  return { db, state };
}

function reading(verdict: 'pass' | 'fail', output: string): CriterionReading {
  return {
    exitCode: verdict === 'pass' ? 0 : 1,
    timedOut: false,
    output,
    outputDigest: `digest:${output}`,
    verdict,
  };
}

const fixedNow = () => new Date('2026-11-11T12:00:00.000Z');

/**
 * A worktree digest that never changes. Most tests are about the readings, not
 * the no-progress breaker, so a steady digest keeps them from tripping it; the
 * stalled tests below swap in a scripted digester.
 */
const steadyDiff = async (): Promise<string> => 'digest:steady';

const mergeOk = async (): Promise<MergeGoalWorktreeResult> => ({
  merged: true,
  commit: 'commit-1',
  reason: null,
});

function isAppError(code: string) {
  return (error: unknown): boolean => error instanceof AppError && error.code === code;
}

// --------------------------- Tests ------------

test('refuses an unknown goal', async () => {
  const { db } = createFakeDb();

  await assert.rejects(
    () => runGoalRound('goal-404', { db, runCriterion: async () => reading('fail', ''), mergeGoalWorktree: mergeOk, computeDiffDigest: steadyDiff, now: fixedNow }),
    isAppError('GOAL_NOT_FOUND'),
  );
});

test('refuses a goal that is not active', async () => {
  const { db, state } = createFakeDb({ status: 'draft' }, [makeAc('goal-1-AC-001')]);

  await assert.rejects(
    () => runGoalRound('goal-1', { db, runCriterion: async () => reading('fail', ''), mergeGoalWorktree: mergeOk, computeDiffDigest: steadyDiff, now: fixedNow }),
    (error: unknown) => isAppError('GOAL_NOT_ACTIVE')(error)
      && (error as AppError).statusCode === 409,
  );
  assert.equal(state.rounds.length, 0);
});

test('refuses a goal whose worktree is missing', async () => {
  const { db } = createFakeDb({ worktreePath: null }, [makeAc('goal-1-AC-001')]);

  await assert.rejects(
    () => runGoalRound('goal-1', { db, runCriterion: async () => reading('fail', ''), mergeGoalWorktree: mergeOk, computeDiffDigest: steadyDiff, now: fixedNow }),
    isAppError('GOAL_WORKTREE_MISSING'),
  );
});

test('refuses a goal with no active criterion', async () => {
  const { db } = createFakeDb({}, [makeAc('goal-1-AC-001', { status: 'superseded' })]);

  await assert.rejects(
    () => runGoalRound('goal-1', { db, runCriterion: async () => reading('fail', ''), mergeGoalWorktree: mergeOk, computeDiffDigest: steadyDiff, now: fixedNow }),
    isAppError('GOAL_HAS_NO_ACTIVE_AC'),
  );
});

test('opens the next round and records one evidence row per active criterion', async () => {
  const activeAc = makeAc('goal-1-AC-001');
  const otherActiveAc = makeAc('goal-1-AC-002');
  const superseded = makeAc('goal-1-AC-003', { status: 'superseded' });
  const { db, state } = createFakeDb({}, [activeAc, otherActiveAc, superseded]);
  state.rounds.push({
    id: 'earlier',
    goalId: 'goal-1',
    seq: 1,
    startedAt: '2026-11-11T11:00:00.000Z',
    endedAt: '2026-11-11T11:05:00.000Z',
    outcome: 'progress',
    diffDigest: null,
    promptDigest: null,
  });

  const outputs: Record<string, CriterionReading> = {
    [activeAc.id]: reading('fail', `failure for ${activeAc.id}`),
    [otherActiveAc.id]: reading('fail', `failure for ${otherActiveAc.id}`),
  };
  const commands: string[] = [];

  const result = await runGoalRound('goal-1', {
    db,
    mergeGoalWorktree: mergeOk,
    computeDiffDigest: steadyDiff,
    now: fixedNow,
    runCriterion: async (options) => {
      commands.push(options.command);
      return outputs[options.command.replace('run ', '')];
    },
  });

  assert.equal(commands.length, 2);
  assert.ok(!commands.includes('run goal-1-AC-003'), 'a superseded AC must not run');

  assert.equal(result.round.seq, 2);
  assert.equal(state.rounds.length, 2);
  assert.equal(result.round.startedAt, '2026-11-11T12:00:00.000Z');

  assert.equal(state.evidence.length, 2);
  const firstEvidence = state.evidence.find((entry) => entry.acId === activeAc.id);
  assert.ok(firstEvidence);
  assert.equal(firstEvidence.roundId, result.round.id);
  assert.equal(firstEvidence.verdict, 'fail');
  assert.equal(firstEvidence.outputDigest, `digest:failure for ${activeAc.id}`);
  assert.equal(firstEvidence.outputExcerpt, `failure for ${activeAc.id}`);
});

test('a red round ends progress, keeps the goal active, and returns the prompt', async () => {
  const redAc = makeAc('goal-1-AC-001');
  const greenAc = makeAc('goal-1-AC-002');
  const { db, state } = createFakeDb({}, [redAc, greenAc]);

  const result = await runGoalRound('goal-1', {
    db,
    mergeGoalWorktree: mergeOk,
    computeDiffDigest: steadyDiff,
    now: fixedNow,
    runCriterion: async (options) => (options.command === redAc.criterion
      ? reading('fail', 'boom: expected 3, got 2')
      : reading('pass', 'ok')),
  });

  assert.equal(result.allGreen, false);
  assert.deepEqual(result.redAcs.map((ac) => ac.id), [redAc.id]);
  assert.equal(result.round.outcome, 'progress');
  assert.equal(result.round.endedAt, '2026-11-11T12:00:00.000Z');
  assert.match(result.prompt, /boom: expected 3, got 2/);
  assert.match(result.prompt, new RegExp(redAc.id));
  assert.ok(result.round.promptDigest, 'the prompt digest is recorded for no-progress detection');
  assert.equal(state.goal.status, 'active');
  assert.equal(state.goal.achievedAt, null);
});

test('an all-green round merges the branch and marks the goal achieved', async () => {
  const { db, state } = createFakeDb({}, [makeAc('goal-1-AC-001'), makeAc('goal-1-AC-002')]);
  const merges: Array<{ projectPath: string; worktreePath: string; branch: string }> = [];

  const result = await runGoalRound('goal-1', {
    db,
    computeDiffDigest: steadyDiff,
    now: fixedNow,
    runCriterion: async () => reading('pass', 'all good'),
    mergeGoalWorktree: async (input) => {
      merges.push(input);
      return { merged: true, commit: 'commit-1', reason: null };
    },
  });

  assert.equal(result.allGreen, true);
  assert.deepEqual(result.redAcs, []);
  assert.equal(result.round.outcome, 'green');
  assert.equal(result.round.promptDigest, null, 'nothing is promptable once the goal is achieved');
  assert.equal(result.prompt, '');
  assert.deepEqual(merges, [{
    projectPath: '/home/wenhao/cloudcli-dev',
    worktreePath: '/tmp/worktrees/goal-1',
    branch: 'goal/goal-1',
    message: 'goal: Ship the goal loop',
  }]);
  assert.deepEqual(result.merge, { merged: true, commit: 'commit-1', reason: null });
  assert.equal(state.goal.status, 'achieved');
  assert.equal(state.goal.achievedAt, '2026-11-11T12:00:00.000Z');
  assert.equal(state.evidence.length, 2);
});

test('a green round whose merge conflicts pauses instead of claiming achieved', async () => {
  const { db, state } = createFakeDb({}, [makeAc('goal-1-AC-001')]);

  const result = await runGoalRound('goal-1', {
    db,
    computeDiffDigest: steadyDiff,
    now: fixedNow,
    runCriterion: async () => reading('pass', 'all good'),
    mergeGoalWorktree: async () => ({ merged: false, commit: null, reason: 'merge conflict' }),
  });

  assert.equal(result.allGreen, true, 'the criteria really did pass');
  assert.deepEqual(result.merge, { merged: false, commit: null, reason: 'merge conflict' });
  assert.equal(state.goal.status, 'paused', 'an unlanded goal must not read as achieved');
  assert.equal(state.goal.achievedAt, null);
});

test('runs criteria serially, each in the goal worktree', async () => {
  const { db } = createFakeDb({}, [makeAc('goal-1-AC-001'), makeAc('goal-1-AC-002')]);
  const seen: Array<{ command: string; cwd: string }> = [];
  let inFlight = 0;
  let overlapped = false;

  await runGoalRound('goal-1', {
    db,
    mergeGoalWorktree: mergeOk,
    computeDiffDigest: steadyDiff,
    now: fixedNow,
    runCriterion: async (options) => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      seen.push({ command: options.command, cwd: options.cwd });
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return reading('fail', 'red');
    },
  });

  assert.deepEqual(seen, [
    { command: 'run goal-1-AC-001', cwd: '/tmp/worktrees/goal-1' },
    { command: 'run goal-1-AC-002', cwd: '/tmp/worktrees/goal-1' },
  ]);
  assert.equal(overlapped, false, 'criteria must not share the worktree concurrently');
});

test('records the worktree diff digest on the round it measured', async () => {
  const { db, state } = createFakeDb({}, [makeAc('goal-1-AC-001')]);
  const digests: string[] = [];

  const result = await runGoalRound('goal-1', {
    db,
    mergeGoalWorktree: mergeOk,
    now: fixedNow,
    runCriterion: async () => reading('fail', 'red'),
    computeDiffDigest: async (worktreePath) => {
      digests.push(worktreePath);
      return 'digest:worktree';
    },
  });

  assert.deepEqual(digests, ['/tmp/worktrees/goal-1'], 'the digest is taken in the goal worktree');
  assert.equal(result.round.diffDigest, 'digest:worktree');
  assert.equal(state.rounds.length, 1);
  assert.equal(result.stalled, false);
});

// --------------------------- No-progress breaker ------------

/**
 * Appends one finished round with one failing evidence row, the shape the
 * breaker compares: `diffDigest` on the round and `verdict`/`outputDigest` on
 * the evidence.
 */
function addCompletedRound(
  state: FakeState,
  seq: number,
  diffDigest: string,
  outputDigest: string,
): void {
  const startIso = `2026-11-11T0${seq}:00:00.000Z`;
  state.rounds.push({
    id: `round-${seq}`,
    goalId: 'goal-1',
    seq,
    startedAt: startIso,
    endedAt: `2026-11-11T0${seq}:05:00.000Z`,
    outcome: 'progress',
    diffDigest,
    promptDigest: null,
  });
  state.evidence.push({
    id: `evidence-${seq}`,
    roundId: `round-${seq}`,
    acId: 'goal-1-AC-001',
    exitCode: 1,
    timedOut: false,
    outputDigest,
    outputExcerpt: '',
    verdict: 'fail',
    at: startIso,
  });
}

test('maxNoProgress identical rounds stall the goal instead of prompting again', async () => {
  const { db, state } = createFakeDb({}, [makeAc('goal-1-AC-001')]);
  // `reading('fail', 'boom')` digests to `digest:boom`; both earlier rounds say
  // the same thing, and the worktree digest below matches them too.
  addCompletedRound(state, 1, 'digest:same', 'digest:boom');
  addCompletedRound(state, 2, 'digest:same', 'digest:boom');

  const result = await runGoalRound('goal-1', {
    db,
    mergeGoalWorktree: mergeOk,
    now: fixedNow,
    computeDiffDigest: async () => 'digest:same',
    runCriterion: async () => reading('fail', 'boom'),
  });

  assert.equal(result.stalled, true);
  assert.equal(result.round.outcome, 'stalled');
  assert.equal(result.round.diffDigest, 'digest:same');
  assert.equal(state.goal.status, 'stalled', 'a stalled goal stops looping until a person resumes it');
});

test('a changing worktree digest is progress, not a stall', async () => {
  const { db, state } = createFakeDb({}, [makeAc('goal-1-AC-001')]);
  addCompletedRound(state, 1, 'digest:a', 'digest:boom');
  addCompletedRound(state, 2, 'digest:b', 'digest:boom');

  const result = await runGoalRound('goal-1', {
    db,
    mergeGoalWorktree: mergeOk,
    now: fixedNow,
    computeDiffDigest: async () => 'digest:c',
    runCriterion: async () => reading('fail', 'boom'),
  });

  assert.equal(result.stalled, false);
  assert.equal(result.round.outcome, 'progress');
  assert.equal(state.goal.status, 'active');
});

test('a changing criterion reading is progress even when the digest repeats', async () => {
  const { db, state } = createFakeDb({}, [makeAc('goal-1-AC-001')]);
  addCompletedRound(state, 1, 'digest:same', 'digest:boom');
  addCompletedRound(state, 2, 'digest:same', 'digest:boom');

  const result = await runGoalRound('goal-1', {
    db,
    mergeGoalWorktree: mergeOk,
    now: fixedNow,
    computeDiffDigest: async () => 'digest:same',
    // A different failure is a new reading: the agent did something, even if
    // the worktree's digest happens to repeat.
    runCriterion: async () => reading('fail', 'a different failure'),
  });

  assert.equal(result.stalled, false);
  assert.equal(result.round.outcome, 'progress');
  assert.equal(state.goal.status, 'active');
});

test('fewer rounds than maxNoProgress can never be a stall', async () => {
  const { db, state } = createFakeDb({}, [makeAc('goal-1-AC-001')]);
  addCompletedRound(state, 1, 'digest:same', 'digest:boom');

  const result = await runGoalRound('goal-1', {
    db,
    mergeGoalWorktree: mergeOk,
    now: fixedNow,
    computeDiffDigest: async () => 'digest:same',
    runCriterion: async () => reading('fail', 'boom'),
  });

  assert.equal(result.stalled, false, 'two identical rounds are not yet a pattern');
  assert.equal(result.round.outcome, 'progress');
});

test('an all-green round is never a stall, even with an unchanged digest', async () => {
  const { db, state } = createFakeDb({}, [makeAc('goal-1-AC-001')]);
  addCompletedRound(state, 1, 'digest:same', 'digest:pass');
  addCompletedRound(state, 2, 'digest:same', 'digest:pass');

  const result = await runGoalRound('goal-1', {
    db,
    mergeGoalWorktree: mergeOk,
    now: fixedNow,
    computeDiffDigest: async () => 'digest:same',
    runCriterion: async () => reading('pass', 'pass'),
  });

  assert.equal(result.allGreen, true);
  assert.equal(result.stalled, false);
  assert.equal(result.round.outcome, 'green');
  assert.equal(state.goal.status, 'achieved');
});

