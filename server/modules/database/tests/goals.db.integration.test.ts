import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  goalsDb,
  initializeDatabase,
  runMigrations,
} from '@/modules/database/index.js';

const PROJECT_ID = '/workspace/goal-project';
const BUDGET = { maxRounds: 20, maxWallClockMs: 3_600_000, maxNoProgress: 3 };

async function withDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'goals-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await writeFile(databasePath, '');
  await initializeDatabase();

  try {
    await runTest();
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

function createGoal(id: string, title = id, projectId = PROJECT_ID) {
  return goalsDb.createGoal({
    id,
    userId: 7,
    projectId,
    title,
    objective: `Objective of ${id}`,
    exitConditions: [`${id}-AC-001`, `${id}-AC-002`],
    budget: BUDGET,
  });
}

test('a goal round-trips its JSON fields and defaults to draft', async () => {
  await withDatabase(() => {
    const goal = createGoal('goal-a');

    assert.equal(goal.status, 'draft');
    assert.equal(goal.userId, 7);
    assert.equal(goal.projectId, PROJECT_ID);
    assert.equal(goal.sessionId, null);
    assert.equal(goal.worktreePath, null);
    assert.equal(goal.branch, null);
    assert.equal(goal.activatedAt, null);
    assert.equal(goal.achievedAt, null);
    assert.deepEqual(goal.exitConditions, ['goal-a-AC-001', 'goal-a-AC-002']);
    assert.deepEqual(goal.budget, BUDGET);
    // One timestamp format everywhere: JS ISO-8601 UTC, not SQLite's CURRENT_TIMESTAMP.
    assert.match(goal.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    assert.deepEqual(goalsDb.getGoal('goal-a'), goal);
    assert.equal(goalsDb.getGoal('goal-missing'), null);
  });
});

test('listGoals is scoped by project and returns creation order', async () => {
  await withDatabase(() => {
    createGoal('goal-first');
    createGoal('goal-second');
    createGoal('goal-elsewhere', 'elsewhere', '/workspace/other-project');

    assert.deepEqual(
      goalsDb.listGoals(PROJECT_ID).map((goal) => goal.id),
      ['goal-first', 'goal-second']
    );
    assert.deepEqual(
      goalsDb.listGoals('/workspace/other-project').map((goal) => goal.id),
      ['goal-elsewhere']
    );
    assert.deepEqual(goalsDb.listGoals('/workspace/none'), []);
  });
});

test('updateGoal patches only the given fields and a null clears a column', async () => {
  await withDatabase(() => {
    createGoal('goal-u');

    const activated = goalsDb.updateGoal('goal-u', {
      sessionId: 'session-1',
      worktreePath: '/workspace/goals/goal-u',
      branch: 'goal/goal-u',
      status: 'active',
      activatedAt: '2026-11-11T08:00:00.000Z',
      budget: { maxRounds: 5, maxWallClockMs: 60_000, maxNoProgress: 2 },
    });

    assert.ok(activated);
    assert.equal(activated.sessionId, 'session-1');
    assert.equal(activated.worktreePath, '/workspace/goals/goal-u');
    assert.equal(activated.branch, 'goal/goal-u');
    assert.equal(activated.status, 'active');
    assert.equal(activated.activatedAt, '2026-11-11T08:00:00.000Z');
    assert.deepEqual(activated.budget, { maxRounds: 5, maxWallClockMs: 60_000, maxNoProgress: 2 });
    // Fields absent from the patch keep their values.
    assert.equal(activated.title, 'goal-u');

    const cleared = goalsDb.updateGoal('goal-u', { sessionId: null, worktreePath: null });

    assert.ok(cleared);
    assert.equal(cleared.sessionId, null);
    assert.equal(cleared.worktreePath, null);
    // The explicit nulls did not touch the status or branch.
    assert.equal(cleared.status, 'active');
    assert.equal(cleared.branch, 'goal/goal-u');

    // An empty patch changes nothing but still returns the current row.
    assert.deepEqual(goalsDb.updateGoal('goal-u', {}), cleared);
    assert.equal(goalsDb.updateGoal('goal-missing', { title: 'nope' }), null);
  });
});

test('ACs round-trip, list per goal, and patch partially', async () => {
  await withDatabase(() => {
    createGoal('goal-ac');
    createGoal('goal-other');

    const ac = goalsDb.createAc({
      id: 'goal-ac-AC-001',
      goalId: 'goal-ac',
      title: 'Build passes',
      criterion: 'npm run build',
      expect: 'Exits non-zero while the module is unbuilt',
    });
    goalsDb.createAc({
      id: 'goal-ac-AC-002',
      goalId: 'goal-ac',
      title: 'Tests pass',
      criterion: 'npm test',
      expect: 'Fails on a missing test file',
    });
    goalsDb.createAc({
      id: 'goal-other-AC-001',
      goalId: 'goal-other',
      title: 'Unrelated',
      criterion: 'true',
      expect: 'never',
    });

    assert.equal(ac.status, 'active');
    assert.equal(ac.goalId, 'goal-ac');
    assert.equal(ac.expect, 'Exits non-zero while the module is unbuilt');
    assert.deepEqual(goalsDb.getAc('goal-ac-AC-001'), ac);
    assert.equal(goalsDb.getAc('goal-ac-AC-999'), null);

    assert.deepEqual(
      goalsDb.listAcs('goal-ac').map((row) => row.id),
      ['goal-ac-AC-001', 'goal-ac-AC-002']
    );

    const updated = goalsDb.updateAc('goal-ac-AC-001', { status: 'achieved', title: 'Build green' });

    assert.ok(updated);
    assert.equal(updated.status, 'achieved');
    assert.equal(updated.title, 'Build green');
    assert.equal(updated.criterion, 'npm run build');
    assert.equal(updated.expect, 'Exits non-zero while the module is unbuilt');

    assert.deepEqual(goalsDb.updateAc('goal-ac-AC-001', {}), updated);
    assert.equal(goalsDb.updateAc('goal-ac-AC-999', { status: 'superseded' }), null);
  });
});

test('rounds round-trip, end with digests, and limit keeps the newest', async () => {
  await withDatabase(() => {
    createGoal('goal-r');
    createGoal('goal-rn');

    const roundIds = ['round-1', 'round-2', 'round-3', 'round-4'];
    roundIds.forEach((id, index) => {
      goalsDb.createRound({
        id,
        goalId: 'goal-r',
        seq: index + 1,
        startedAt: `2026-11-11T09:0${index}:00.000Z`,
      });
    });
    goalsDb.createRound({
      id: 'round-other',
      goalId: 'goal-rn',
      seq: 1,
      startedAt: '2026-11-11T09:00:00.000Z',
    });

    const open = goalsDb.createRound({
      id: 'round-open',
      goalId: 'goal-r',
      seq: 5,
      startedAt: '2026-11-11T09:05:00.000Z',
    });
    assert.equal(open.endedAt, null);
    assert.equal(open.outcome, null);
    assert.equal(open.diffDigest, null);
    assert.equal(open.promptDigest, null);
    assert.equal(open.startedAt, '2026-11-11T09:05:00.000Z');

    const ended = goalsDb.endRound('round-1', {
      outcome: 'progress',
      endedAt: '2026-11-11T09:01:30.000Z',
      diffDigest: 'sha256:diff-1',
      promptDigest: 'sha256:prompt-1',
    });

    assert.ok(ended);
    assert.equal(ended.outcome, 'progress');
    assert.equal(ended.endedAt, '2026-11-11T09:01:30.000Z');
    assert.equal(ended.diffDigest, 'sha256:diff-1');
    assert.equal(ended.promptDigest, 'sha256:prompt-1');

    // Omitted digests are stored as NULL rather than left over from a previous write.
    const greenNoDigest = goalsDb.endRound('round-2', {
      outcome: 'green',
      endedAt: '2026-11-11T09:02:30.000Z',
    });
    assert.ok(greenNoDigest);
    assert.equal(greenNoDigest.diffDigest, null);
    assert.equal(greenNoDigest.promptDigest, null);

    assert.equal(
      goalsDb.endRound('round-missing', { outcome: 'error', endedAt: '2026-11-11T09:00:00.000Z' }),
      null
    );

    assert.deepEqual(
      goalsDb.listRounds('goal-r').map((round) => round.seq),
      [1, 2, 3, 4, 5]
    );
    // The limit keeps the newest rounds, still returned oldest-first.
    assert.deepEqual(
      goalsDb.listRounds('goal-r', 2).map((round) => round.id),
      ['round-4', 'round-open']
    );
    assert.deepEqual(goalsDb.listRounds('goal-r', 0), []);
    assert.deepEqual(goalsDb.listRounds('goal-empty'), []);
  });
});

test('evidence round-trips exit code, timeout flag, and verdict', async () => {
  await withDatabase(() => {
    createGoal('goal-e');
    goalsDb.createRound({
      id: 'round-e',
      goalId: 'goal-e',
      seq: 1,
      startedAt: '2026-11-11T10:00:00.000Z',
    });

    const failure = goalsDb.addEvidence({
      id: 'evidence-1',
      roundId: 'round-e',
      acId: 'goal-e-AC-001',
      exitCode: 1,
      timedOut: false,
      outputDigest: 'sha256:out-1',
      outputExcerpt: 'TypeError: x is undefined',
      verdict: 'fail',
      at: '2026-11-11T10:00:05.000Z',
    });
    const timeout = goalsDb.addEvidence({
      id: 'evidence-2',
      roundId: 'round-e',
      acId: 'goal-e-AC-002',
      exitCode: null,
      timedOut: true,
      outputDigest: 'sha256:out-2',
      outputExcerpt: 'killed after 120s',
      verdict: 'fail',
      at: '2026-11-11T10:02:05.000Z',
    });

    assert.deepEqual(failure, {
      id: 'evidence-1',
      roundId: 'round-e',
      acId: 'goal-e-AC-001',
      exitCode: 1,
      timedOut: false,
      outputDigest: 'sha256:out-1',
      outputExcerpt: 'TypeError: x is undefined',
      verdict: 'fail',
      at: '2026-11-11T10:00:05.000Z',
    });
    assert.equal(timeout.exitCode, null);
    assert.equal(timeout.timedOut, true);

    // timed_out is stored as 0/1, not as a boolean, and reads back as a boolean.
    const stored = getConnection()
      .prepare('SELECT timed_out FROM goal_evidence WHERE id = ?')
      .get('evidence-2') as { timed_out: number };
    assert.equal(stored.timed_out, 1);

    assert.deepEqual(
      goalsDb.listEvidence('round-e').map((evidence) => evidence.id),
      ['evidence-1', 'evidence-2']
    );
    assert.deepEqual(goalsDb.listEvidence('round-none'), []);
  });
});

test('runMigrations is idempotent and leaves the goal tables and indexes in place', async () => {
  await withDatabase(() => {
    const db = getConnection();

    // Re-running the whole chain over an installed database must be a no-op.
    runMigrations(db);
    runMigrations(db);

    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN ('goals', 'goal_acs', 'goal_rounds', 'goal_evidence')`
      )
      .all() as { name: string }[];
    assert.deepEqual(
      tables.map((table) => table.name).sort(),
      ['goal_acs', 'goal_evidence', 'goal_rounds', 'goals']
    );

    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND name LIKE 'idx_goal%'`
      )
      .all() as { name: string }[];
    assert.deepEqual(
      indexes.map((index) => index.name).sort(),
      ['idx_goal_acs_goal', 'idx_goal_evidence_round', 'idx_goal_rounds_goal_seq', 'idx_goals_project']
    );

    // The tables survived the re-run with their data intact.
    createGoal('goal-idempotent');
    runMigrations(db);
    assert.equal(goalsDb.getGoal('goal-idempotent')?.title, 'goal-idempotent');
  });
});
