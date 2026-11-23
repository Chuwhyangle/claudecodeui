/**
 * The resident goal driver: what one tick does to each active goal.
 *
 *   ① all green ⇒ nothing is sent (the round's merge already decided the goal);
 *   ② a red round ⇒ the round prompt is sent to the bound session as the goal's
 *      user;
 *   ③ a busy session ⇒ the goal is skipped, so the running turn can finish;
 *   ④ wall-clock / round budgets ⇒ the goal is paused without running a round;
 *   ⑤ stalled ⇒ the goal is flipped to `stalled` and nothing is sent;
 *   ⑥ a tick never overlaps itself;
 *   ⑦ a failed send changes no status (the next tick retries).
 *
 * Every collaborator is a fake, so this test never touches SQLite, git, a
 * provider process, or a real session.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/goals/tests/goal-driver.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { Goal, GoalRound, GoalStatus } from '../../../shared/types.js';
import type { GoalDriverDeps } from '../goal-driver.service.js';
import { createGoalDriver } from '../goal-driver.service.js';
import type { RunRoundResult } from '../run-round.js';

// --------------------------- Fakes ------------

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
    createdAt: '2026-11-11T11:50:00.000Z',
    // Ten minutes before `fixedNow`: comfortably inside the two-hour budget.
    activatedAt: '2026-11-11T11:50:00.000Z',
    achievedAt: null,
    ...overrides,
  };
}

function makeRoundResult(overrides: Partial<RunRoundResult> = {}): RunRoundResult {
  return {
    round: {
      id: 'round-1',
      goalId: 'goal-1',
      seq: 1,
      startedAt: '2026-11-11T12:00:00.000Z',
      endedAt: '2026-11-11T12:00:30.000Z',
      outcome: 'progress',
      diffDigest: 'digest-1',
      promptDigest: 'prompt-digest-1',
    },
    readings: [],
    allGreen: false,
    redAcs: [],
    prompt: '# Goal round 1: Ship the goal loop',
    merge: null,
    stalled: false,
    ...overrides,
  };
}

/** What one tick observed, so a test can assert on calls and status patches. */
type Recorder = {
  runs: string[];
  sends: Array<{ userId: number; sessionId: string; content: string }>;
  patches: Array<{ id: string; patch: { status?: GoalStatus; achievedAt?: string | null } }>;
  logs: string[];
  notifications: Array<{ goalId: string; status: GoalStatus; reason: string }>;
};

const fixedNow = () => new Date('2026-11-11T12:00:00.000Z');

/**
 * Builds a driver over fakes. `rounds` is the round count each goal reports,
 * `busy` decides which sessions are draining a turn, and `send` is the verdict
 * the session's send returns.
 */
function createHarness(options: {
  goals: Goal[];
  rounds?: (goalId: string) => GoalRound[];
  runRound?: (goalId: string) => Promise<RunRoundResult>;
  busy?: (sessionId: string) => boolean;
  send?: (input: { userId: number; sessionId: string; content: string }) => Promise<{
    ok: boolean;
    code?: string;
    message?: string;
  }>;
  intervalMs?: number;
}): { driver: ReturnType<typeof createGoalDriver>; recorder: Recorder } {
  const recorder: Recorder = { runs: [], sends: [], patches: [], logs: [], notifications: [] };

  const deps: GoalDriverDeps = {
    listActiveGoals: () => options.goals,
    listRounds: options.rounds ?? (() => []),
    runRound: async (goalId) => {
      recorder.runs.push(goalId);
      return options.runRound ? options.runRound(goalId) : makeRoundResult();
    },
    sendToSession: async (input) => {
      recorder.sends.push(input);
      return options.send ? options.send(input) : { ok: true };
    },
    isSessionBusy: options.busy ?? (() => false),
    updateGoal: (id, patch) => {
      recorder.patches.push({ id, patch });
      const goal = options.goals.find((entry) => entry.id === id) ?? null;
      return goal ? { ...goal, ...patch } : null;
    },
    notifyGoal: ({ goal, status, reason }) => {
      recorder.notifications.push({ goalId: goal.id, status, reason });
    },
    now: fixedNow,
    intervalMs: options.intervalMs ?? 1_000,
    log: (message) => recorder.logs.push(message),
  };

  return { driver: createGoalDriver(deps), recorder };
}

// --------------------------- Tests ------------

test('an all-green round sends nothing: the round already decided the goal', async () => {
  const goal = makeGoal();
  const { driver, recorder } = createHarness({
    goals: [goal],
    runRound: async () => makeRoundResult({ allGreen: true, prompt: '', round: {
      ...makeRoundResult().round,
      outcome: 'green',
    } }),
  });

  await driver.tick();

  assert.deepEqual(recorder.runs, ['goal-1']);
  assert.deepEqual(recorder.sends, [], 'an achieved goal has nobody left to prompt');
  assert.deepEqual(recorder.patches, [], 'the round, not the driver, flips an achieved goal');
});

test('a red round sends the round prompt to the bound session as the goal user', async () => {
  const goal = makeGoal();
  const { driver, recorder } = createHarness({ goals: [goal] });

  await driver.tick();

  assert.deepEqual(recorder.sends, [{
    userId: 7,
    sessionId: 'session-1',
    content: '# Goal round 1: Ship the goal loop',
  }]);
  assert.deepEqual(recorder.patches, [], 'a sent round leaves the goal active');
});

test('a busy session is skipped, so the running turn can finish', async () => {
  const goal = makeGoal();
  const { driver, recorder } = createHarness({
    goals: [goal],
    busy: (sessionId) => sessionId === 'session-1',
  });

  await driver.tick();

  assert.deepEqual(recorder.runs, [], 'no round may run against a session still working');
  assert.deepEqual(recorder.sends, []);
  assert.match(recorder.logs.join('\n'), /still running its turn/);
});

test('a goal past its wall-clock budget is paused without running a round', async () => {
  // Activated 3 hours ago with a 2-hour budget.
  const goal = makeGoal({ activatedAt: '2026-11-11T09:00:00.000Z' });
  const { driver, recorder } = createHarness({ goals: [goal] });

  await driver.tick();

  assert.deepEqual(recorder.runs, []);
  assert.deepEqual(recorder.patches, [{ id: 'goal-1', patch: { status: 'paused' } }]);
  assert.match(recorder.logs.join('\n'), /wall-clock budget/);
});

test('a goal with no wall clock start is judged by its round budget only', async () => {
  const goal = makeGoal({ activatedAt: null });
  const { driver, recorder } = createHarness({ goals: [goal] });

  await driver.tick();

  assert.deepEqual(recorder.patches, [], 'no start means the wall clock cannot have run out');
  assert.deepEqual(recorder.runs, ['goal-1']);
});

test('a goal that spent its round budget is paused without running a round', async () => {
  const goal = makeGoal({ budget: { maxRounds: 2, maxWallClockMs: 7_200_000, maxNoProgress: 3 } });
  const rounds = (): GoalRound[] => [
    { id: 'r1', goalId: 'goal-1', seq: 1, startedAt: '', endedAt: '', outcome: 'progress', diffDigest: null, promptDigest: null },
    { id: 'r2', goalId: 'goal-1', seq: 2, startedAt: '', endedAt: '', outcome: 'progress', diffDigest: null, promptDigest: null },
  ];
  const { driver, recorder } = createHarness({ goals: [goal], rounds });

  await driver.tick();

  assert.deepEqual(recorder.runs, []);
  assert.deepEqual(recorder.patches, [{ id: 'goal-1', patch: { status: 'paused' } }]);
  assert.match(recorder.logs.join('\n'), /round budget/);
});

test('rounds from before the current activation do not spend the new budget', async () => {
  const goal = makeGoal({
    activatedAt: '2026-11-11T11:50:00.000Z',
    budget: { maxRounds: 2, maxWallClockMs: 7_200_000, maxNoProgress: 3 },
  });
  // One round from the previous activation exhausted the old budget; resume
  // rewrote activatedAt, so only the 11:55 round counts against the new one.
  const rounds = (): GoalRound[] => [
    { id: 'old', goalId: 'goal-1', seq: 1, startedAt: '2026-11-11T10:00:00.000Z', endedAt: '', outcome: 'progress', diffDigest: null, promptDigest: null },
    { id: 'new', goalId: 'goal-1', seq: 2, startedAt: '2026-11-11T11:55:00.000Z', endedAt: '', outcome: 'progress', diffDigest: null, promptDigest: null },
  ];
  const { driver, recorder } = createHarness({ goals: [goal], rounds });

  await driver.tick();

  assert.deepEqual(recorder.runs, ['goal-1'], 'the resumed goal must run its next round');
  assert.deepEqual(recorder.patches.filter((entry) => entry.patch.status === 'paused'), []);
});

test('a stalled round flips the goal to stalled and sends nothing', async () => {
  const goal = makeGoal();
  const { driver, recorder } = createHarness({
    goals: [goal],
    runRound: async () => makeRoundResult({
      stalled: true,
      round: { ...makeRoundResult().round, outcome: 'stalled' },
    }),
  });

  await driver.tick();

  assert.deepEqual(recorder.patches, [{ id: 'goal-1', patch: { status: 'stalled' } }]);
  assert.deepEqual(recorder.sends, [], 'a stalled goal has nothing new to tell the agent');
  assert.match(recorder.logs.join('\n'), /stalled/);
});

test('a refused send changes no status and is retried on the next tick', async () => {
  const goal = makeGoal();
  const { driver, recorder } = createHarness({
    goals: [goal],
    send: async () => ({ ok: false, code: 'RUN_IN_PROGRESS', message: 'already running' }),
  });

  await driver.tick();

  assert.deepEqual(recorder.patches, [], 'a failed send must not pause or stall the goal');
  assert.match(recorder.logs.join('\n'), /refused round 1 \(RUN_IN_PROGRESS/);

  await driver.tick();
  assert.equal(recorder.sends.length, 2, 'the next tick retries the same round prompt');
});

test('a throwing send is contained like a refused one', async () => {
  const goal = makeGoal();
  const { driver, recorder } = createHarness({
    goals: [goal],
    send: async () => {
      throw new Error('transport gone');
    },
  });

  await driver.tick();

  assert.deepEqual(recorder.patches, []);
  assert.match(recorder.logs.join('\n'), /transport gone/);
});

test('a tick never overlaps itself', async () => {
  const goal = makeGoal();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;

  const { driver, recorder } = createHarness({
    goals: [goal],
    runRound: async () => {
      calls += 1;
      await gate;
      return makeRoundResult();
    },
  });

  const first = driver.tick();
  // The second tick arrives while the first round is still running: it must
  // return without starting a second one.
  await driver.tick();

  assert.equal(calls, 1, 'the in-flight tick owns the loop');
  assert.deepEqual(recorder.runs, ['goal-1']);

  release();
  await first;
  assert.equal(recorder.sends.length, 1);
});

test('one goal failing does not stop the goals behind it in the same tick', async () => {
  const broken = makeGoal({ id: 'goal-broken' });
  const healthy = makeGoal({ id: 'goal-healthy', sessionId: 'session-2' });

  const { driver, recorder } = createHarness({
    goals: [broken, healthy],
    runRound: async (goalId) => {
      if (goalId === 'goal-broken') throw new Error('worktree vanished');
      return makeRoundResult();
    },
  });

  await driver.tick();

  assert.equal(recorder.runs.length, 2);
  assert.equal(recorder.sends.length, 1);
  assert.equal(recorder.sends[0].sessionId, 'session-2');
  assert.match(recorder.logs.join('\n'), /worktree vanished/);
});

test('a green merge reports achieved through the notification channel', async () => {
  const { driver, recorder } = createHarness({
    goals: [makeGoal()],
    runRound: async () => makeRoundResult({
      allGreen: true,
      prompt: '',
      merge: { merged: true, commit: 'abc123', reason: null },
    }),
  });

  await driver.tick();

  assert.deepEqual(recorder.notifications, [
    { goalId: 'goal-1', status: 'achieved', reason: 'all criteria passed; merged abc123' },
  ]);
});

test('a green round whose merge failed reports paused, not achieved', async () => {
  const { driver, recorder } = createHarness({
    goals: [makeGoal()],
    runRound: async () => makeRoundResult({
      allGreen: true,
      prompt: '',
      merge: { merged: false, commit: null, reason: 'merge conflict' },
    }),
  });

  await driver.tick();

  assert.equal(recorder.notifications.length, 1);
  assert.equal(recorder.notifications[0]?.status, 'paused');
  assert.match(recorder.notifications[0]?.reason ?? '', /merge conflict/);
});

test('a stalled round reports stalled through the notification channel', async () => {
  const { driver, recorder } = createHarness({
    goals: [makeGoal()],
    runRound: async () => makeRoundResult({ stalled: true }),
  });

  await driver.tick();

  assert.deepEqual(recorder.notifications.map((entry) => entry.status), ['stalled']);
});

test('a budget pause reports paused through the notification channel', async () => {
  const goal = makeGoal({ activatedAt: '2026-11-11T09:00:00.000Z' });
  const { driver, recorder } = createHarness({ goals: [goal] });

  await driver.tick();

  assert.deepEqual(recorder.notifications.map((entry) => entry.status), ['paused']);
  assert.match(recorder.notifications[0]?.reason ?? '', /wall-clock budget/);
});

test('start ticks once immediately, and stop ends the polling', async () => {
  const goal = makeGoal();
  const { driver, recorder } = createHarness({ goals: [goal], intervalMs: 5 });

  driver.start();
  assert.equal(driver.running, true);

  // The immediate tick is asynchronous; one macrotask is enough for it to start.
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(recorder.runs.length >= 1, 'start must not wait a whole interval');

  driver.stop();
  assert.equal(driver.running, false);

  await new Promise((resolve) => setTimeout(resolve, 10));
  const afterStop = recorder.runs.length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(recorder.runs.length, afterStop, 'a stopped driver polls nothing');
});
