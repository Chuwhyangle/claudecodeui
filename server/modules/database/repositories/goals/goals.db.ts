import { getConnection } from '@/modules/database/core/index.js';
import type {
  Goal,
  GoalAc,
  GoalAcStatus,
  GoalBudget,
  GoalEvidence,
  GoalEvidenceVerdict,
  GoalRound,
  GoalRoundOutcome,
  GoalStatus,
} from '@/shared/types.js';

/**
 * goalsDb: used by the goals module (goals.service and goal-driver.service) to
 * persist a goal, its acceptance criteria, one row per loop round, and one row
 * per criterion run. Every method speaks the shared Goal* domain types; the
 * snake_case columns and the JSON-text columns stay inside this file.
 */

// --------------------------- Row shapes ------------

/** `goals` as stored: `exit_conditions` and `budget` are JSON text. */
export type GoalRow = {
  id: string;
  user_id: number;
  project_id: string;
  session_id: string | null;
  worktree_path: string | null;
  branch: string | null;
  title: string;
  objective: string;
  exit_conditions: string;
  status: string;
  budget: string;
  created_at: string;
  activated_at: string | null;
  achieved_at: string | null;
};

export type GoalAcRow = {
  id: string;
  goal_id: string;
  title: string;
  criterion: string;
  expect: string;
  status: string;
  created_at: string;
};

export type GoalRoundRow = {
  id: string;
  goal_id: string;
  seq: number;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  diff_digest: string | null;
  prompt_digest: string | null;
};

export type GoalEvidenceRow = {
  id: string;
  round_id: string;
  ac_id: string;
  exit_code: number | null;
  timed_out: number;
  output_digest: string;
  output_excerpt: string;
  verdict: string;
  at: string;
};

const GOAL_COLUMNS =
  'id, user_id, project_id, session_id, worktree_path, branch, title, objective, exit_conditions, status, budget, created_at, activated_at, achieved_at';

const AC_COLUMNS = 'id, goal_id, title, criterion, expect, status, created_at';

const ROUND_COLUMNS = 'id, goal_id, seq, started_at, ended_at, outcome, diff_digest, prompt_digest';

const EVIDENCE_COLUMNS =
  'id, round_id, ac_id, exit_code, timed_out, output_digest, output_excerpt, verdict, at';

// --------------------------- Mapping ------------

function toGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    sessionId: row.session_id,
    worktreePath: row.worktree_path,
    branch: row.branch,
    title: row.title,
    objective: row.objective,
    exitConditions: JSON.parse(row.exit_conditions) as string[],
    status: row.status as GoalStatus,
    budget: JSON.parse(row.budget) as GoalBudget,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    achievedAt: row.achieved_at,
  };
}

function toAc(row: GoalAcRow): GoalAc {
  return {
    id: row.id,
    goalId: row.goal_id,
    title: row.title,
    criterion: row.criterion,
    expect: row.expect,
    status: row.status as GoalAcStatus,
    createdAt: row.created_at,
  };
}

function toRound(row: GoalRoundRow): GoalRound {
  return {
    id: row.id,
    goalId: row.goal_id,
    seq: row.seq,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    outcome: row.outcome === null ? null : (row.outcome as GoalRoundOutcome),
    diffDigest: row.diff_digest,
    promptDigest: row.prompt_digest,
  };
}

function toEvidence(row: GoalEvidenceRow): GoalEvidence {
  return {
    id: row.id,
    roundId: row.round_id,
    acId: row.ac_id,
    exitCode: row.exit_code,
    timedOut: row.timed_out !== 0,
    outputDigest: row.output_digest,
    outputExcerpt: row.output_excerpt,
    verdict: row.verdict as GoalEvidenceVerdict,
    at: row.at,
  };
}

/** Every timestamp this file writes is JS ISO-8601, so ORDER BY on TEXT sorts by time. */
function nowIso(): string {
  return new Date().toISOString();
}

export const goalsDb = {
  createGoal(input: {
    id: string;
    userId: number;
    projectId: string;
    title: string;
    objective: string;
    exitConditions: string[];
    budget: GoalBudget;
    status?: GoalStatus;
  }): Goal {
    const db = getConnection();

    db.prepare(
      `INSERT INTO goals
         (id, user_id, project_id, title, objective, exit_conditions, status, budget, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.id,
      input.userId,
      input.projectId,
      input.title,
      input.objective,
      JSON.stringify(input.exitConditions),
      input.status ?? 'draft',
      JSON.stringify(input.budget),
      nowIso()
    );

    const row = db.prepare(`SELECT ${GOAL_COLUMNS} FROM goals WHERE id = ?`).get(input.id) as
      | GoalRow
      | undefined;
    return toGoal(row!);
  },

  getGoal(id: string): Goal | null {
    const row = getConnection()
      .prepare(`SELECT ${GOAL_COLUMNS} FROM goals WHERE id = ?`)
      .get(id) as GoalRow | undefined;

    return row ? toGoal(row) : null;
  },

  /** A project's goals, oldest first; `rowid` breaks ties between same-instant rows. */
  listGoals(projectId: string): Goal[] {
    const rows = getConnection()
      .prepare(
        `SELECT ${GOAL_COLUMNS} FROM goals
         WHERE project_id = ?
         ORDER BY created_at ASC, rowid ASC`
      )
      .all(projectId) as GoalRow[];

    return rows.map(toGoal);
  },

  /**
   * Every goal in one lifecycle state, oldest first; `rowid` breaks ties between
   * same-instant rows. The resident driver reads `'active'` through it on every
   * tick, so this is the query that decides which goals are looping at all.
   */
  listGoalsByStatus(status: GoalStatus): Goal[] {
    const rows = getConnection()
      .prepare(
        `SELECT ${GOAL_COLUMNS} FROM goals
         WHERE status = ?
         ORDER BY created_at ASC, rowid ASC`
      )
      .all(status) as GoalRow[];

    return rows.map(toGoal);
  },

  updateGoal(
    id: string,
    patch: {
      sessionId?: string | null;
      worktreePath?: string | null;
      branch?: string | null;
      title?: string;
      objective?: string;
      exitConditions?: string[];
      status?: GoalStatus;
      budget?: GoalBudget;
      activatedAt?: string | null;
      achievedAt?: string | null;
    }
  ): Goal | null {
    const assignments: string[] = [];
    const values: unknown[] = [];

    const assign = (column: string, value: unknown) => {
      assignments.push(`${column} = ?`);
      values.push(value);
    };

    if (patch.sessionId !== undefined) assign('session_id', patch.sessionId);
    if (patch.worktreePath !== undefined) assign('worktree_path', patch.worktreePath);
    if (patch.branch !== undefined) assign('branch', patch.branch);
    if (patch.title !== undefined) assign('title', patch.title);
    if (patch.objective !== undefined) assign('objective', patch.objective);
    if (patch.exitConditions !== undefined) {
      assign('exit_conditions', JSON.stringify(patch.exitConditions));
    }
    if (patch.status !== undefined) assign('status', patch.status);
    if (patch.budget !== undefined) assign('budget', JSON.stringify(patch.budget));
    if (patch.activatedAt !== undefined) assign('activated_at', patch.activatedAt);
    if (patch.achievedAt !== undefined) assign('achieved_at', patch.achievedAt);

    const db = getConnection();
    if (assignments.length > 0) {
      db.prepare(`UPDATE goals SET ${assignments.join(', ')} WHERE id = ?`).run(...values, id);
    }

    const row = db.prepare(`SELECT ${GOAL_COLUMNS} FROM goals WHERE id = ?`).get(id) as
      | GoalRow
      | undefined;
    return row ? toGoal(row) : null;
  },

  createAc(input: {
    id: string;
    goalId: string;
    title: string;
    criterion: string;
    expect: string;
    status?: GoalAcStatus;
  }): GoalAc {
    const db = getConnection();

    db.prepare(
      `INSERT INTO goal_acs (id, goal_id, title, criterion, expect, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.id,
      input.goalId,
      input.title,
      input.criterion,
      input.expect,
      input.status ?? 'active',
      nowIso()
    );

    const row = db.prepare(`SELECT ${AC_COLUMNS} FROM goal_acs WHERE id = ?`).get(input.id) as
      | GoalAcRow
      | undefined;
    return toAc(row!);
  },

  getAc(id: string): GoalAc | null {
    const row = getConnection()
      .prepare(`SELECT ${AC_COLUMNS} FROM goal_acs WHERE id = ?`)
      .get(id) as GoalAcRow | undefined;

    return row ? toAc(row) : null;
  },

  /** A goal's ACs in the order they were authored; `rowid` breaks same-instant ties. */
  listAcs(goalId: string): GoalAc[] {
    const rows = getConnection()
      .prepare(
        `SELECT ${AC_COLUMNS} FROM goal_acs
         WHERE goal_id = ?
         ORDER BY created_at ASC, rowid ASC`
      )
      .all(goalId) as GoalAcRow[];

    return rows.map(toAc);
  },

  /** Applies a partial update; an omitted field is left alone. */
  updateAc(
    id: string,
    patch: { title?: string; criterion?: string; expect?: string; status?: GoalAcStatus }
  ): GoalAc | null {
    const assignments: string[] = [];
    const values: unknown[] = [];

    const assign = (column: string, value: unknown) => {
      assignments.push(`${column} = ?`);
      values.push(value);
    };

    if (patch.title !== undefined) assign('title', patch.title);
    if (patch.criterion !== undefined) assign('criterion', patch.criterion);
    if (patch.expect !== undefined) assign('expect', patch.expect);
    if (patch.status !== undefined) assign('status', patch.status);

    if (assignments.length > 0) {
      getConnection()
        .prepare(`UPDATE goal_acs SET ${assignments.join(', ')} WHERE id = ?`)
        .run(...values, id);
    }

    const row = getConnection()
      .prepare(`SELECT ${AC_COLUMNS} FROM goal_acs WHERE id = ?`)
      .get(id) as GoalAcRow | undefined;
    return row ? toAc(row) : null;
  },

  /** Opens a round. The caller owns `startedAt` so a round can be replayed with its real start. */
  createRound(input: { id: string; goalId: string; seq: number; startedAt: string }): GoalRound {
    const db = getConnection();

    db.prepare(
      `INSERT INTO goal_rounds (id, goal_id, seq, started_at)
       VALUES (?, ?, ?, ?)`
    ).run(input.id, input.goalId, input.seq, input.startedAt);

    const row = db.prepare(`SELECT ${ROUND_COLUMNS} FROM goal_rounds WHERE id = ?`).get(input.id) as
      | GoalRoundRow
      | undefined;
    return toRound(row!);
  },

  /** Closes a round: the outcome, the end instant, and the two no-progress digests. */
  endRound(
    id: string,
    patch: {
      outcome: GoalRoundOutcome;
      endedAt: string;
      diffDigest?: string | null;
      promptDigest?: string | null;
    }
  ): GoalRound | null {
    const db = getConnection();

    const result = db
      .prepare(
        `UPDATE goal_rounds
         SET outcome = ?, ended_at = ?, diff_digest = ?, prompt_digest = ?
         WHERE id = ?`
      )
      .run(patch.outcome, patch.endedAt, patch.diffDigest ?? null, patch.promptDigest ?? null, id);

    if (result.changes === 0) return null;

    const row = db.prepare(`SELECT ${ROUND_COLUMNS} FROM goal_rounds WHERE id = ?`).get(id) as
      | GoalRoundRow
      | undefined;
    return row ? toRound(row) : null;
  },

  /**
   * A goal's rounds in ascending `seq`. With `limit`, keeps the most recent
   * `limit` rounds (still returned oldest-first); an empty goal yields [].
   */
  listRounds(goalId: string, limit?: number): GoalRound[] {
    const db = getConnection();

    if (limit === undefined) {
      const rows = db
        .prepare(
          `SELECT ${ROUND_COLUMNS} FROM goal_rounds
           WHERE goal_id = ?
           ORDER BY seq ASC`
        )
        .all(goalId) as GoalRoundRow[];
      return rows.map(toRound);
    }

    const bounded = Math.max(0, Math.floor(limit));
    const rows = db
      .prepare(
        `SELECT ${ROUND_COLUMNS} FROM goal_rounds
         WHERE goal_id = ?
         ORDER BY seq DESC
         LIMIT ?`
      )
      .all(goalId, bounded) as GoalRoundRow[];

    // The query walks backwards to take the newest N; hand them back chronologically.
    return rows.reverse().map(toRound);
  },

  /** Records one criterion run's reading for a round. */
  addEvidence(input: {
    id: string;
    roundId: string;
    acId: string;
    exitCode: number | null;
    timedOut: boolean;
    outputDigest: string;
    outputExcerpt: string;
    verdict: GoalEvidenceVerdict;
    at: string;
  }): GoalEvidence {
    const db = getConnection();

    db.prepare(
      `INSERT INTO goal_evidence
         (id, round_id, ac_id, exit_code, timed_out, output_digest, output_excerpt, verdict, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.id,
      input.roundId,
      input.acId,
      input.exitCode,
      input.timedOut ? 1 : 0,
      input.outputDigest,
      input.outputExcerpt,
      input.verdict,
      input.at
    );

    const row = db
      .prepare(`SELECT ${EVIDENCE_COLUMNS} FROM goal_evidence WHERE id = ?`)
      .get(input.id) as GoalEvidenceRow | undefined;
    return toEvidence(row!);
  },

  /** A round's evidence, oldest first; `rowid` keeps same-instant rows in write order. */
  listEvidence(roundId: string): GoalEvidence[] {
    const rows = getConnection()
      .prepare(
        `SELECT ${EVIDENCE_COLUMNS} FROM goal_evidence
         WHERE round_id = ?
         ORDER BY at ASC, rowid ASC`
      )
      .all(roundId) as GoalEvidenceRow[];

    return rows.map(toEvidence);
  },
};
