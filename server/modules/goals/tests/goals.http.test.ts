/**
 * The goals loop end to end over HTTP: the real router, a real SQLite file, and a
 * real git repository — no fake service, no fake criterion runner.
 *
 *   ① a goal is created, two acceptance criteria are added, and activation creates
 *      the goal worktree and binds a session while refusing nothing (both criteria
 *      are red on the current code);
 *   ② the first round reads both criteria red and reports `progress`;
 *   ③ a commit inside the worktree makes both criteria pass, so the second round is
 *      green, merges `goal/<id>` back into the main checkout, and flips the goal to
 *      `achieved` — the merge commit is real, so the main checkout has the new file;
 *   ④ `GET /:id` reports the stored status, ACs, and both rounds;
 *   ⑤ `pause` and `resume` move a running goal along its lifecycle, and a
 *      transition that does not apply to the current status is a 409;
 *   ⑥ a second account sees none of it: the listing omits the goal and every
 *      detail/mutation route answers 404 without touching the row.
 *
 * Every case builds its own fixture — a temp database plus a temp git repo — and
 * removes both afterwards, so the cases never share state and never touch the
 * developer's database or checkout.
 *
 * Run directly:
 *   bash scripts/with-memory-cap.sh ./node_modules/.bin/tsx --tsconfig server/tsconfig.json \
 *     --import ./scripts/undici-blocked-ports-preload.mjs \
 *     --test server/modules/goals/tests/goals.http.test.ts
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import express, { type NextFunction, type Request, type Response } from 'express';

import { closeConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import type { Goal, GoalAc, GoalRound } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { createGoalsModule } from '../index.js';
import type { RunRoundResult } from '../run-round.js';

const execFileAsync = promisify(execFile);

/** Upper bound for one git invocation; the fixture's repos are local and tiny. */
const GIT_TIMEOUT_MS = 60_000;

/** The caller `authenticateToken` would have put on the request. */
const USER_ID = 7;

/** A second account used to prove goals are not readable across users. */
const OTHER_USER_ID = 99;

/**
 * Test-only identity header: the fixture's `authenticateToken` stand-in reads it
 * so one fixture can act as two users. Never sent by a real client.
 */
const USER_HEADER = 'x-test-user-id';

/** The provider an activation names; the module only stores it on the session row. */
const PROVIDER = 'claude';

/** Both criteria fail on the fixture's initial README until the worktree commit. */
const README_CRITERION = 'grep -q "goal-achieved" README.md';
const MARKER_CRITERION = 'test -f DONE.txt';

// --------------------------- HTTP helpers ------------

type ApiResponse = {
  status: number;
  /** The raw answer, used as the assertion message when a status is unexpected. */
  text: string;
  /** The parsed JSON body, or null when the answer was not JSON (e.g. express's 404). */
  body: unknown;
};

/**
 * Performs one request and keeps the raw text alongside the parsed body.
 *
 * The raw text is what makes a failed assertion explain itself: express's default
 * 404 page and a stack-trace 500 are not JSON, and a helper that only parsed JSON
 * would throw before the case could report either one.
 */
async function call(
  baseUrl: string,
  route: string,
  options?: { method?: string; body?: unknown; userId?: number },
): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  if (options?.body !== undefined) headers['content-type'] = 'application/json';
  if (options?.userId !== undefined) headers[USER_HEADER] = String(options.userId);

  const response = await fetch(`${baseUrl}${route}`, {
    method: options?.method ?? 'GET',
    headers: Object.keys(headers).length === 0 ? undefined : headers,
    body: options?.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();

  let body: unknown = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  return {
    status: response.status,
    text,
    body,
  };
}

function post(baseUrl: string, route: string, body?: unknown): Promise<ApiResponse> {
  return call(baseUrl, route, { method: 'POST', body });
}

/** Runs git in `cwd`; a non-zero exit rejects with git's own stderr. */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
  return String(stdout);
}

// --------------------------- Fixture ------------

type Fixture = {
  baseUrl: string;
  /** The main checkout the goal branch merges back into. */
  repoPath: string;
  projectId: string;
};

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'goals-http-'));
  const databasePath = path.join(tempDirectory, 'auth.db');
  const repoPath = path.join(tempDirectory, 'repo');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await writeFile(databasePath, '');
  await initializeDatabase();

  try {
    await mkdir(repoPath, { recursive: true });
    await git(repoPath, ['init']);
    await git(repoPath, ['config', 'user.email', 'goals-http@example.test']);
    await git(repoPath, ['config', 'user.name', 'Goals HTTP Test']);
    await writeFile(path.join(repoPath, 'README.md'), '# Goal loop fixture\n');
    await git(repoPath, ['add', 'README.md']);
    await git(repoPath, ['commit', '-m', 'fixture']);

    const projectId = projectsDb.createProjectPath(repoPath).project?.project_id;
    assert.ok(projectId, 'the fixture project must be recorded before a goal names it');

    const app = express();
    app.use(express.json());
    // `authenticateToken` is mounted by server/index.ts; the router only reads `req.user`.
    // The stand-in honours the test-only identity header so one fixture can be
    // driven as two different accounts.
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const header = req.header(USER_HEADER);
      const id = header === undefined ? USER_ID : Number(header);
      (req as Request & { user?: { id: number } }).user = { id };
      next();
    });
    app.use(
      '/api/goals',
      createGoalsModule({
        // The resident driver is never started here — every round is driven through
        // the HTTP endpoint — so this collaborator exists only to compose the module
        // and would only be reached by a driver tick that these cases never run.
        sendToSession: async () => ({
          ok: false,
          code: 'NOT_WIRED_IN_HTTP_TEST',
          message: 'the HTTP test drives rounds directly; the driver is never started',
        }),
      }).router,
    );
    app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (error instanceof AppError) {
        res.status(error.statusCode).json({
          success: false,
          error: { code: error.code, message: error.message },
        });
        return;
      }
      // Anything else is a real bug in the wiring; surface its message so the
      // failing case reports the cause instead of a generic 500.
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) },
      });
    });

    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;

    try {
      await run({ baseUrl: `http://127.0.0.1:${port}`, repoPath, projectId });
    } finally {
      // The cases use keep-alive fetches; closing them first lets `close` finish.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** Creates a goal in the fixture project and returns it. */
async function createGoal(
  fixture: Fixture,
  overrides: { title?: string; objective?: string } = {},
): Promise<Goal> {
  const response = await post(fixture.baseUrl, '/api/goals', {
    project: fixture.projectId,
    projectPath: fixture.repoPath,
    title: overrides.title ?? 'Ship the goal loop',
    objective: overrides.objective ?? 'Both acceptance criteria pass.',
    exitConditions: [],
  });

  assert.equal(response.status, 201, `creating a goal answered ${response.status}: ${response.text}`);
  const body = response.body as { data: Goal };
  return body.data;
}

/** Adds one AC and returns it, failing loudly if the route refused it. */
async function addAc(
  fixture: Fixture,
  goalId: string,
  input: { title: string; criterion: string; expect: string },
): Promise<GoalAc> {
  const response = await post(fixture.baseUrl, `/api/goals/${goalId}/acs`, input);
  assert.equal(response.status, 201, `adding an AC answered ${response.status}: ${response.text}`);
  return (response.body as { data: GoalAc }).data;
}

/**
 * Creates a goal with one always-red criterion and activates it.
 *
 * The red-first rule requires every criterion to fail before activation, so a
 * criterion naming a file the fixture never creates keeps the goal runnable and
 * untouched by later rounds.
 */
async function createActiveGoal(fixture: Fixture, title: string): Promise<string> {
  const goal = await createGoal(fixture, { title });
  await addAc(fixture, goal.id, {
    title: 'A marker appears',
    criterion: 'test -f NEVER.txt',
    expect: 'Fails until NEVER.txt exists; nothing in these cases creates it.',
  });

  const activated = await post(fixture.baseUrl, `/api/goals/${goal.id}/activate`, { provider: PROVIDER });
  assert.equal(activated.status, 200, `activation answered ${activated.status}: ${activated.text}`);
  const body = activated.body as { data: { goal?: Goal; refusal?: string } };
  assert.equal(body.data.refusal, undefined, 'the always-red criterion must pass red-first');
  assert.ok(body.data.goal);
  assert.equal(body.data.goal.status, 'active');

  return goal.id;
}

// --------------------------- Tests ------------

test('a goal goes red, green, and lands in the main checkout through HTTP', async () => {
  await withFixture(async (fixture) => {
    // ① Create the goal.
    const goal = await createGoal(fixture);
    assert.equal(goal.status, 'draft');
    assert.equal(goal.projectId, fixture.projectId);
    assert.equal(goal.worktreePath, null);
    assert.equal(goal.sessionId, null);

    // ② Two acceptance criteria, both runnable and both red on the current code.
    const firstAc = await addAc(fixture, goal.id, {
      title: 'README records the goal',
      criterion: README_CRITERION,
      expect: 'Fails until README.md contains "goal-achieved".',
    });
    const secondAc = await addAc(fixture, goal.id, {
      title: 'DONE marker exists',
      criterion: MARKER_CRITERION,
      expect: 'Fails until DONE.txt exists.',
    });
    assert.equal(firstAc.id, `${goal.id}-AC-001`);
    assert.equal(secondAc.id, `${goal.id}-AC-002`);

    // ③ Activation: red-first passes, the worktree and the session are recorded.
    const activated = await post(fixture.baseUrl, `/api/goals/${goal.id}/activate`, { provider: PROVIDER });
    assert.equal(activated.status, 200, activated.text);
    const activation = (activated.body as { data: { goal?: Goal; refusal?: string } }).data;
    assert.equal(activation.refusal, undefined);
    assert.ok(activation.goal);

    const active = activation.goal;
    assert.equal(active.status, 'active');
    const worktreePath = active.worktreePath;
    const branch = active.branch;
    const sessionId = active.sessionId;
    assert.ok(worktreePath, 'activation must record the goal worktree');
    assert.ok(branch, 'activation must record the goal branch');
    assert.ok(sessionId, 'activation must bind a goal session');
    assert.equal(branch, `goal/${goal.id}`);
    await access(worktreePath);
    assert.ok(active.activatedAt, 'activation must stamp activatedAt');

    // ④ The first round reads both criteria red and records them as evidence.
    const firstRoundResponse = await post(fixture.baseUrl, `/api/goals/${goal.id}/run-round`);
    assert.equal(firstRoundResponse.status, 200, firstRoundResponse.text);
    const firstRound = (firstRoundResponse.body as { data: RunRoundResult }).data;
    assert.equal(firstRound.allGreen, false);
    assert.equal(firstRound.redAcs.length, 2);
    assert.deepEqual(
      firstRound.readings.map((entry) => entry.reading.verdict),
      ['fail', 'fail'],
    );
    assert.equal(firstRound.round.seq, 1);
    assert.equal(firstRound.round.outcome, 'progress');
    assert.equal(firstRound.merge, null);
    assert.ok(firstRound.prompt.length > 0, 'a red round has a next-round prompt to send');

    // ⑤ The work the agent would do: a commit inside the goal worktree.
    await writeFile(path.join(worktreePath, 'README.md'), '# Goal loop fixture\n\ngoal-achieved\n');
    await writeFile(path.join(worktreePath, 'DONE.txt'), 'done\n');
    await git(worktreePath, ['add', 'README.md', 'DONE.txt']);
    await git(worktreePath, ['commit', '-m', 'achieve the goal']);

    // ⑥ The second round is green and merges the goal branch into the main checkout.
    const secondRoundResponse = await post(fixture.baseUrl, `/api/goals/${goal.id}/run-round`);
    assert.equal(secondRoundResponse.status, 200, secondRoundResponse.text);
    const secondRound = (secondRoundResponse.body as { data: RunRoundResult }).data;
    assert.equal(secondRound.allGreen, true);
    assert.deepEqual(
      secondRound.readings.map((entry) => entry.reading.verdict),
      ['pass', 'pass'],
    );
    assert.equal(secondRound.round.seq, 2);
    assert.equal(secondRound.round.outcome, 'green');
    assert.equal(secondRound.prompt, '', 'a green round has nobody left to prompt');
    assert.ok(secondRound.merge, 'a green round must report its merge outcome');
    assert.equal(secondRound.merge.merged, true, String(secondRound.merge.reason));
    assert.ok(secondRound.merge.commit, 'a landed goal names the merge commit');

    // The merge was real: the fixture's main checkout now has the committed file.
    await access(path.join(fixture.repoPath, 'DONE.txt'));

    // ⑦ The detail view reports the achieved goal, its ACs, and both rounds.
    const detailResponse = await call(fixture.baseUrl, `/api/goals/${goal.id}`);
    assert.equal(detailResponse.status, 200, detailResponse.text);
    const detail = (detailResponse.body as {
      data: { goal: Goal; acs: GoalAc[]; rounds: GoalRound[] };
    }).data;
    assert.equal(detail.goal.status, 'achieved');
    assert.ok(detail.goal.achievedAt, 'an achieved goal must stamp achievedAt');
    assert.deepEqual(
      detail.acs.map((ac) => ac.id),
      [`${goal.id}-AC-001`, `${goal.id}-AC-002`],
    );
    assert.deepEqual(
      detail.rounds.map((round) => round.seq),
      [1, 2],
    );
    assert.deepEqual(
      detail.rounds.map((round) => round.outcome),
      ['progress', 'green'],
    );
  });
});

test('pause moves a running goal to paused and refuses a second pause', async () => {
  await withFixture(async (fixture) => {
    const goalId = await createActiveGoal(fixture, 'Pause me');

    const paused = await post(fixture.baseUrl, `/api/goals/${goalId}/pause`);
    assert.equal(paused.status, 200, paused.text);
    assert.equal((paused.body as { data: Goal }).data.status, 'paused');

    // A paused goal is no longer running, so the same transition is refused.
    const again = await post(fixture.baseUrl, `/api/goals/${goalId}/pause`);
    assert.equal(again.status, 409, again.text);
    assert.equal((again.body as { error: { code: string } }).error.code, 'GOAL_NOT_RUNNING');
  });
});

test('resume returns a paused goal to active and refuses a running one', async () => {
  await withFixture(async (fixture) => {
    const goalId = await createActiveGoal(fixture, 'Resume me');
    const paused = await post(fixture.baseUrl, `/api/goals/${goalId}/pause`);
    assert.equal(paused.status, 200, paused.text);
    const pausedGoal = (paused.body as { data: Goal }).data;
    assert.equal(pausedGoal.status, 'paused');
    assert.ok(pausedGoal.activatedAt, 'activation stamped the first start');

    const resumed = await post(fixture.baseUrl, `/api/goals/${goalId}/resume`);
    assert.equal(resumed.status, 200, resumed.text);
    const resumedGoal = (resumed.body as { data: Goal }).data;
    assert.equal(resumedGoal.status, 'active');
    assert.ok(resumedGoal.activatedAt, 'resuming restarts the wall-clock budget');

    // Only a paused or stalled goal can be resumed; a running one is refused.
    const again = await post(fixture.baseUrl, `/api/goals/${goalId}/resume`);
    assert.equal(again.status, 409, again.text);
    assert.equal((again.body as { error: { code: string } }).error.code, 'GOAL_NOT_RESUMABLE');
  });
});

test('a second user cannot see or operate another user\'s goal', async () => {
  await withFixture(async (fixture) => {
    const goal = await createGoal(fixture);
    assert.equal(goal.userId, USER_ID, 'the fixture creates goals as the first account');
    assert.equal(goal.status, 'draft');

    // The owner sees the goal in the project listing.
    const ownerList = await call(fixture.baseUrl, `/api/goals?project=${fixture.projectId}`);
    assert.equal(ownerList.status, 200, ownerList.text);
    assert.deepEqual(
      (ownerList.body as { data: Goal[] }).data.map((entry) => entry.id),
      [goal.id],
    );

    // The second account sees an empty project, not a filtered-out row count.
    const otherList = await call(fixture.baseUrl, `/api/goals?project=${fixture.projectId}`, {
      userId: OTHER_USER_ID,
    });
    assert.equal(otherList.status, 200, otherList.text);
    assert.deepEqual((otherList.body as { data: Goal[] }).data, []);

    // The detail read is a 404 indistinguishable from a missing goal.
    const otherDetail = await call(fixture.baseUrl, `/api/goals/${goal.id}`, {
      userId: OTHER_USER_ID,
    });
    assert.equal(otherDetail.status, 404, otherDetail.text);
    assert.equal(
      (otherDetail.body as { error: { code: string } }).error.code,
      'GOAL_NOT_FOUND',
    );

    // Every mutation is a 404 too — ownership is checked before the status rules
    // that would otherwise answer 409 for a draft goal.
    for (const action of ['pause', 'resume', 'abandon', 'run-round']) {
      const response = await call(fixture.baseUrl, `/api/goals/${goal.id}/${action}`, {
        method: 'POST',
        userId: OTHER_USER_ID,
      });
      assert.equal(
        response.status,
        404,
        `${action} by the second user answered ${response.status}: ${response.text}`,
      );
      assert.equal(
        (response.body as { error: { code: string } }).error.code,
        'GOAL_NOT_FOUND',
        `${action} must report a missing goal, not reveal someone else's`,
      );
    }

    // The refused calls changed nothing: the owner still reads the draft goal
    // with no ACs, exactly as it was created.
    const ownerDetail = await call(fixture.baseUrl, `/api/goals/${goal.id}`);
    assert.equal(ownerDetail.status, 200, ownerDetail.text);
    const detail = (ownerDetail.body as {
      data: { goal: Goal; acs: GoalAc[]; rounds: GoalRound[] };
    }).data;
    assert.equal(detail.goal.status, 'draft');
    assert.equal(detail.acs.length, 0);
    assert.equal(detail.rounds.length, 0);
  });
});
