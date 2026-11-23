/**
 * The goals routes: parsing, status codes, and nothing else.
 *
 *   ① every route answers with the success envelope and hands the service the
 *      parsed input (the authenticated user id included);
 *   ② a missing field is a 400 that calls no service;
 *   ③ an unknown goal is a 404, and a red-first refusal is a 200 (the criteria
 *      ran; refusing is a successful answer);
 *   ④ the manual round is routed to its own injected function, and a resume is
 *      routed to the lifecycle service like pause/abandon.
 *
 * The service and the round runner are fakes; this test never touches the
 * database, git, or a subprocess.
 *
 * Run directly:
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *     server/modules/goals/tests/goals.routes.test.ts
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import type { Goal, GoalAc, GoalRound } from '../../../shared/types.js';
import { AppError } from '../../../shared/utils.js';
import { createGoalsRouter, type GoalsRoutesDeps } from '../goals.routes.js';
import { createGoalsService, type GoalsDb, type GoalsService } from '../goals.service.js';
import type { RunRoundResult } from '../run-round.js';

// --------------------------- Fakes ------------

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: 'goal-1',
    userId: 7,
    projectId: 'proj-1',
    sessionId: null,
    worktreePath: null,
    branch: null,
    title: 'Ship the goal loop',
    objective: 'Every acceptance criterion must pass.',
    exitConditions: [],
    status: 'draft',
    budget: { maxRounds: 20, maxWallClockMs: 7_200_000, maxNoProgress: 3 },
    createdAt: '2026-11-11T00:00:00.000Z',
    activatedAt: null,
    achievedAt: null,
    ...overrides,
  };
}

function makeAc(overrides: Partial<GoalAc> = {}): GoalAc {
  return {
    id: 'goal-1-AC-001',
    goalId: 'goal-1',
    title: 'Criterion one',
    criterion: 'node --test one.test.ts',
    expect: 'Fails while the feature is missing.',
    status: 'active',
    createdAt: '2026-11-11T00:00:00.000Z',
    ...overrides,
  };
}

function makeRound(): GoalRound {
  return {
    id: 'round-1',
    goalId: 'goal-1',
    seq: 1,
    startedAt: '2026-11-11T00:00:00.000Z',
    endedAt: '2026-11-11T00:01:00.000Z',
    outcome: 'progress',
    diffDigest: null,
    promptDigest: 'digest',
  };
}

function makeService(overrides: Partial<GoalsService> = {}): GoalsService {
  const base: GoalsService = {
    createGoal: (input) => makeGoal({
      id: 'goal-new',
      userId: input.userId,
      projectId: input.projectId,
      title: input.title,
      objective: input.objective,
      exitConditions: input.exitConditions,
    }),
    listGoals: () => [makeGoal()],
    getGoal: () => null,
    addAc: (goalId, _userId, input) => makeAc({ id: `${goalId}-AC-001`, title: input.title }),
    activate: async () => ({ goal: makeGoal({ status: 'active' }) }),
    pause: () => makeGoal({ status: 'paused' }),
    resume: () => makeGoal({ status: 'active' }),
    abandon: () => makeGoal({ status: 'abandoned' }),
  };

  return { ...base, ...overrides };
}

/**
 * A real `createGoalsService` over an in-memory store — ownership lives in the
 * service, so the route tests check it against the code that actually enforces
 * it rather than against a fake that repeats the rule.
 */
function makeOwnershipService(goals: Goal[]): GoalsService {
  const rows = goals.map((goal) => ({ ...goal }));

  const db: GoalsDb = {
    createGoal: () => {
      throw new Error('the ownership tests never create a goal');
    },
    getGoal: (id) => rows.find((goal) => goal.id === id) ?? null,
    listGoals: (projectId) => rows.filter((goal) => goal.projectId === projectId),
    listGoalsByStatus: (status) => rows.filter((goal) => goal.status === status),
    updateGoal: (id, patch) => {
      const index = rows.findIndex((goal) => goal.id === id);
      if (index === -1) return null;
      rows[index] = { ...rows[index], ...patch };
      return rows[index];
    },
    createAc: () => {
      throw new Error('the ownership tests never add an AC');
    },
    listAcs: () => [],
    createRound: () => {
      throw new Error('the ownership tests never run a round');
    },
    endRound: () => null,
    listRounds: () => [],
    addEvidence: () => {
      throw new Error('the ownership tests never record evidence');
    },
    listEvidence: () => [],
    getProjectPath: () => '/home/wenhao/cloudcli-dev',
  };

  return createGoalsService({
    db,
    runCriterion: async () => ({
      exitCode: 1,
      timedOut: false,
      output: '',
      outputDigest: 'digest:red',
      verdict: 'fail',
    }),
    ensureGoalWorktree: async () => ({ worktreePath: '/tmp/goal-wt', branch: 'goal/test' }),
    verifyRedFirst: () => ({ ok: true }),
    createAppSession: () => 'session-1',
    now: () => new Date('2026-11-12T00:00:00.000Z'),
  });
}

function makeRoundResult(): RunRoundResult {
  const ac = makeAc();
  return {
    round: makeRound(),
    readings: [{
      acId: ac.id,
      reading: {
        exitCode: 1,
        timedOut: false,
        output: 'boom',
        outputDigest: 'digest:boom',
        verdict: 'fail',
      },
    }],
    allGreen: false,
    redAcs: [ac],
    prompt: '# Goal round 1',
    merge: null,
    stalled: false,
  };
}

/**
 * Serves the router with a fixed authenticated caller. `userId` is the third
 * parameter rather than the second so every existing case keeps its shape.
 */
async function withServer(
  deps: GoalsRoutesDeps,
  run: (baseUrl: string) => Promise<void>,
  userId = 7,
): Promise<void> {
  const app = express();
  app.use(express.json());
  // `authenticateToken` is mounted by server/index.ts; the routes only read `req.user`.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: { id: number } }).user = { id: userId };
    next();
  });
  app.use('/api/goals', createGoalsRouter(deps));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message } });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });

  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function noopRound(): (goalId: string) => Promise<RunRoundResult> {
  return async () => makeRoundResult();
}

// --------------------------- Tests ------------

test('GET / answers the project goals in the success envelope', async () => {
  let seenProject = '';
  await withServer(
    {
      service: makeService({
        listGoals: (projectId) => {
          seenProject = projectId;
          return [makeGoal()];
        },
      }),
      runRound: noopRound(),
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/goals?project=proj-1`);
      assert.equal(response.status, 200);
      assert.equal(seenProject, 'proj-1');
      const body = await response.json() as { success: boolean; data: Goal[] };
      assert.equal(body.success, true);
      assert.equal(body.data.length, 1);
    },
  );
});

test('GET / without a project is a 400 that calls no service', async () => {
  let called = false;
  await withServer(
    {
      service: makeService({
        listGoals: () => {
          called = true;
          return [];
        },
      }),
      runRound: noopRound(),
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/goals`);
      assert.equal(response.status, 400);
      const body = await response.json() as { error: { code: string } };
      assert.equal(body.error.code, 'PROJECT_ID_REQUIRED');
      assert.equal(called, false);
    },
  );
});

test('POST / parses the body, uses the authenticated user, and answers 201', async () => {
  let seen: Parameters<GoalsService['createGoal']>[0] | null = null;
  await withServer(
    {
      service: makeService({
        createGoal: (input) => {
          seen = input;
          return makeGoal({ title: input.title });
        },
      }),
      runRound: noopRound(),
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/goals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project: 'proj-1',
          projectPath: '/home/wenhao/cloudcli-dev',
          title: '  Ship the goal loop  ',
          objective: 'Every criterion passes.',
          exitConditions: ['goal-1-AC-001'],
          budget: { maxRounds: 3 },
        }),
      });

      assert.equal(response.status, 201);
      assert.deepEqual(seen, {
        userId: 7,
        projectId: 'proj-1',
        projectPath: '/home/wenhao/cloudcli-dev',
        title: 'Ship the goal loop',
        objective: 'Every criterion passes.',
        exitConditions: ['goal-1-AC-001'],
        budget: { maxRounds: 3 },
      });
    },
  );
});

test('POST / refuses a body without a title and calls no service', async () => {
  let called = false;
  await withServer(
    {
      service: makeService({
        createGoal: () => {
          called = true;
          return makeGoal();
        },
      }),
      runRound: noopRound(),
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/goals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project: 'proj-1',
          projectPath: '/p',
          objective: 'O',
        }),
      });

      assert.equal(response.status, 400);
      assert.equal(called, false);
    },
  );
});

test('POST / refuses a non-positive budget limit', async () => {
  await withServer(
    { service: makeService(), runRound: noopRound() },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/goals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project: 'proj-1',
          projectPath: '/p',
          title: 'T',
          objective: 'O',
          budget: { maxRounds: 0 },
        }),
      });

      assert.equal(response.status, 400);
    },
  );
});

test('GET /:id answers 404 for an unknown goal and the detail otherwise', async () => {
  await withServer(
    { service: makeService(), runRound: noopRound() },
    async (baseUrl) => {
      const missing = await fetch(`${baseUrl}/api/goals/goal-404`);
      assert.equal(missing.status, 404);
      const body = await missing.json() as { error: { code: string } };
      assert.equal(body.error.code, 'GOAL_NOT_FOUND');
    },
  );

  await withServer(
    {
      service: makeService({ getGoal: () => ({ goal: makeGoal(), acs: [makeAc()], rounds: [], evidence: [] }) }),
      runRound: noopRound(),
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/goals/goal-1`);
      assert.equal(response.status, 200);
      const body = await response.json() as { data: { goal: Goal; acs: GoalAc[] } };
      assert.equal(body.data.acs.length, 1);
    },
  );
});

test('POST /:id/acs parses the criterion and answers 201', async () => {
  let seen: { title: string; criterion: string; expect: string } | null = null;
  await withServer(
    {
      service: makeService({
        addAc: (goalId, _userId, input) => {
          seen = input;
          return makeAc({ goalId, title: input.title });
        },
      }),
      runRound: noopRound(),
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/goals/goal-1/acs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: ' AC one ', criterion: 'node --test a.ts', expect: 'red first' }),
      });

      assert.equal(response.status, 201);
      assert.deepEqual(seen, {
        title: 'AC one',
        criterion: 'node --test a.ts',
        expect: 'red first',
      });
    },
  );
});

test('POST /:id/activate passes the provider and hands a refusal back as 200', async () => {
  let seenProvider = '';
  await withServer(
    {
      service: makeService({
        activate: async (_goalId, _userId, input) => {
          seenProvider = input.provider;
          return { refusal: 'already green', greenAcIds: ['goal-1-AC-001'] };
        },
      }),
      runRound: noopRound(),
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/goals/goal-1/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'claude' }),
      });

      assert.equal(response.status, 200);
      assert.equal(seenProvider, 'claude');
      const body = await response.json() as { data: { refusal: string; greenAcIds: string[] } };
      assert.equal(body.data.refusal, 'already green');
      assert.deepEqual(body.data.greenAcIds, ['goal-1-AC-001']);
    },
  );
});

test('POST /:id/activate refuses a missing provider without calling the service', async () => {
  let called = false;
  await withServer(
    {
      service: makeService({
        activate: async () => {
          called = true;
          return { goal: makeGoal() };
        },
      }),
      runRound: noopRound(),
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/goals/goal-1/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });

      assert.equal(response.status, 400);
      assert.equal(called, false);
    },
  );
});

test('POST /:id/pause, /:id/resume and /:id/abandon reach the service', async () => {
  const calls: string[] = [];
  await withServer(
    {
      service: makeService({
        pause: (goalId) => {
          calls.push(`pause:${goalId}`);
          return makeGoal({ status: 'paused' });
        },
        resume: (goalId) => {
          calls.push(`resume:${goalId}`);
          return makeGoal({ status: 'active' });
        },
        abandon: (goalId) => {
          calls.push(`abandon:${goalId}`);
          return makeGoal({ status: 'abandoned' });
        },
      }),
      runRound: noopRound(),
    },
    async (baseUrl) => {
      const paused = await fetch(`${baseUrl}/api/goals/goal-1/pause`, { method: 'POST' });
      const resumed = await fetch(`${baseUrl}/api/goals/goal-1/resume`, { method: 'POST' });
      const abandoned = await fetch(`${baseUrl}/api/goals/goal-1/abandon`, { method: 'POST' });

      assert.equal(paused.status, 200);
      assert.equal(resumed.status, 200);
      assert.equal(abandoned.status, 200);
      assert.deepEqual(calls, ['pause:goal-1', 'resume:goal-1', 'abandon:goal-1']);
      const body = await resumed.json() as { data: Goal };
      assert.equal(body.data.status, 'active');
    },
  );
});

test('POST /:id/resume surfaces the service refusal as its own status', async () => {
  await withServer(
    {
      service: makeService({
        resume: () => {
          throw new AppError('Only a paused or stalled goal can be resumed; "x" is achieved.', {
            code: 'GOAL_NOT_RESUMABLE',
            statusCode: 409,
          });
        },
      }),
      runRound: noopRound(),
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/goals/goal-1/resume`, { method: 'POST' });
      assert.equal(response.status, 409);
      const body = await response.json() as { error: { code: string } };
      assert.equal(body.error.code, 'GOAL_NOT_RESUMABLE');
    },
  );
});

test('POST /:id/run-round answers the round result', async () => {
  let seenGoal = '';
  await withServer(
    {
      // The route now gates the round on an owned detail read before calling it.
      service: makeService({
        getGoal: () => ({ goal: makeGoal(), acs: [makeAc()], rounds: [], evidence: [] }),
      }),
      runRound: async (goalId) => {
        seenGoal = goalId;
        return makeRoundResult();
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/goals/goal-1/run-round`, { method: 'POST' });

      assert.equal(response.status, 200);
      assert.equal(seenGoal, 'goal-1');
      const body = await response.json() as { data: RunRoundResult };
      assert.equal(body.data.round.seq, 1);
      assert.equal(body.data.allGreen, false);
      assert.equal(body.data.redAcs.length, 1);
      assert.match(body.data.prompt, /Goal round 1/);
    },
  );
});

test('POST /:id/run-round answers 404 for a goal the caller does not own and runs nothing', async () => {
  let roundCalls = 0;
  const service = makeOwnershipService([makeGoal({ id: 'goal-owned', userId: 7 })]);

  await withServer(
    {
      service,
      runRound: async () => {
        roundCalls += 1;
        return makeRoundResult();
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/goals/goal-owned/run-round`, { method: 'POST' });
      assert.equal(response.status, 404);
      const body = await response.json() as { error: { code: string } };
      assert.equal(body.error.code, 'GOAL_NOT_FOUND');
      assert.equal(roundCalls, 0, 'a round must not start for a goal the caller does not own');
    },
    99,
  );
});

// --------------------------- Ownership ------------

const OTHER_USER_ID = 99;

test('GET /:id answers 404 for another user\'s goal and the detail for the owner', async () => {
  const service = makeOwnershipService([makeGoal({ id: 'goal-owned', userId: 7 })]);

  await withServer(
    { service, runRound: noopRound() },
    async (baseUrl) => {
      const own = await fetch(`${baseUrl}/api/goals/goal-owned`);
      assert.equal(own.status, 200);
      const body = await own.json() as { data: { goal: Goal } };
      assert.equal(body.data.goal.id, 'goal-owned');
    },
  );

  await withServer(
    { service, runRound: noopRound() },
    async (baseUrl) => {
      const other = await fetch(`${baseUrl}/api/goals/goal-owned`);
      assert.equal(other.status, 404);
      const body = await other.json() as { error: { code: string; message: string } };
      assert.equal(body.error.code, 'GOAL_NOT_FOUND');
      // The message must not distinguish "someone else's" from "does not exist".
      assert.match(body.error.message, /does not exist/);
    },
    OTHER_USER_ID,
  );
});

test('POST /:id/pause and /:id/abandon answer 404 for another user\'s goal', async () => {
  const service = makeOwnershipService([makeGoal({ id: 'goal-owned', userId: 7, status: 'active' })]);

  await withServer(
    { service, runRound: noopRound() },
    async (baseUrl) => {
      const paused = await fetch(`${baseUrl}/api/goals/goal-owned/pause`, { method: 'POST' });
      const abandoned = await fetch(`${baseUrl}/api/goals/goal-owned/abandon`, { method: 'POST' });
      assert.equal(paused.status, 404, paused.status === 409 ? 'ownership must be checked before status' : '');
      assert.equal(abandoned.status, 404);

      const pausedBody = await paused.json() as { error: { code: string } };
      const abandonedBody = await abandoned.json() as { error: { code: string } };
      assert.equal(pausedBody.error.code, 'GOAL_NOT_FOUND');
      assert.equal(abandonedBody.error.code, 'GOAL_NOT_FOUND');
    },
    OTHER_USER_ID,
  );

  // The refused calls touched nothing: the owner still reads the active goal.
  await withServer(
    { service, runRound: noopRound() },
    async (baseUrl) => {
      const detail = await fetch(`${baseUrl}/api/goals/goal-owned`);
      assert.equal(detail.status, 200);
      const body = await detail.json() as { data: { goal: Goal } };
      assert.equal(body.data.goal.status, 'active');
    },
  );
});

test('POST /:id/resume and /:id/acs answer 404 for another user\'s goal', async () => {
  const service = makeOwnershipService([makeGoal({ id: 'goal-owned', userId: 7, status: 'paused' })]);

  await withServer(
    { service, runRound: noopRound() },
    async (baseUrl) => {
      const resumed = await fetch(`${baseUrl}/api/goals/goal-owned/resume`, { method: 'POST' });
      assert.equal(resumed.status, 404);

      const added = await fetch(`${baseUrl}/api/goals/goal-owned/acs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'T', criterion: 'true', expect: 'E' }),
      });
      assert.equal(added.status, 404);
    },
    OTHER_USER_ID,
  );
});

test('GET /?project= lists only the caller\'s goals in that project', async () => {
  const service = makeOwnershipService([
    makeGoal({ id: 'goal-mine', userId: 7, projectId: 'proj-1' }),
    makeGoal({ id: 'goal-theirs', userId: OTHER_USER_ID, projectId: 'proj-1' }),
    makeGoal({ id: 'goal-other-project', userId: 7, projectId: 'proj-2' }),
  ]);

  await withServer(
    { service, runRound: noopRound() },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/goals?project=proj-1`);
      assert.equal(response.status, 200);
      const body = await response.json() as { data: Goal[] };
      assert.deepEqual(body.data.map((goal) => goal.id), ['goal-mine']);
    },
  );

  await withServer(
    { service, runRound: noopRound() },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/goals?project=proj-1`);
      assert.equal(response.status, 200);
      const body = await response.json() as { data: Goal[] };
      assert.deepEqual(body.data.map((goal) => goal.id), ['goal-theirs']);
    },
    OTHER_USER_ID,
  );
});
