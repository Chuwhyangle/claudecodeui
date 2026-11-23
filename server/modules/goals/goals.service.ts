import { randomUUID } from 'node:crypto';

import type {
  CriterionReading,
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
import { AppError } from '@/shared/utils.js';

// --------------------------- Database contract ------------

/**
 * The persistence surface the goals module reads and writes.
 *
 * It mirrors `goalsDb` from the Database module field for field; naming it
 * structurally is what lets the service be tested against an in-memory fake and
 * keeps SQLite out of this file.
 *
 * `getProjectPath` is the one member `goalsDb` does not provide: a goal row
 * stores a project id, so activation has to resolve the project directory
 * through the Projects repository. `goals.module.ts` composes it in.
 */
export type GoalsDb = {
  createGoal(input: {
    id: string;
    userId: number;
    projectId: string;
    title: string;
    objective: string;
    exitConditions: string[];
    budget: GoalBudget;
    status?: GoalStatus;
  }): Goal;
  getGoal(id: string): Goal | null;
  listGoals(projectId: string): Goal[];
  /**
   * Every goal in one lifecycle state, oldest first. The resident driver reads
   * `'active'` through it: that poll is what keeps a goal looping across ticks
   * and across process restarts.
   */
  listGoalsByStatus(status: GoalStatus): Goal[];
  /** Applies a partial update; an explicit `null` clears the field. */
  updateGoal(
    id: string,
    patch: {
      sessionId?: string | null;
      worktreePath?: string | null;
      branch?: string | null;
      status?: GoalStatus;
      exitConditions?: string[];
      budget?: GoalBudget;
      activatedAt?: string | null;
      achievedAt?: string | null;
    },
  ): Goal | null;
  createAc(input: {
    id: string;
    goalId: string;
    title: string;
    criterion: string;
    expect: string;
    status?: GoalAcStatus;
  }): GoalAc;
  listAcs(goalId: string): GoalAc[];
  createRound(input: { id: string; goalId: string; seq: number; startedAt: string }): GoalRound;
  endRound(
    id: string,
    patch: {
      outcome: GoalRoundOutcome;
      endedAt: string;
      diffDigest?: string | null;
      promptDigest?: string | null;
    },
  ): GoalRound | null;
  listRounds(goalId: string, limit?: number): GoalRound[];
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
  }): GoalEvidence;
  /**
   * One round's evidence, oldest first. Read by `run-round.ts`'s no-progress
   * breaker, which compares each round's `verdict`/`outputDigest` readings.
   */
  listEvidence(roundId: string): GoalEvidence[];
  /** Resolves a project id to its directory; `null` when the project is unknown. */
  getProjectPath(projectId: string): string | null;
};

// --------------------------- Defaults ------------

/**
 * Budget applied when a goal is created without one: 20 rounds, two hours of
 * wall clock, and three consecutive no-progress rounds. These are deliberately
 * finite — an unbounded loop is what spends tokens without producing evidence.
 */
const DEFAULT_GOAL_BUDGET: GoalBudget = {
  maxRounds: 20,
  maxWallClockMs: 2 * 60 * 60 * 1_000,
  maxNoProgress: 3,
};

/** Every goal id this module mints for an AC follows `<goalId>-AC-001`. */
const AC_ID_SEPARATOR = '-AC-';

// --------------------------- Service ------------

/**
 * What the goal service needs from the rest of the system.
 *
 * Every member is injected so the service can be exercised with fakes: no test
 * ever spawns a criterion, touches git, or writes to the real database.
 */
export type GoalsServiceDeps = {
  db: GoalsDb;
  runCriterion: (options: { command: string; cwd: string; timeoutMs?: number }) => Promise<CriterionReading>;
  ensureGoalWorktree: (input: {
    projectPath: string;
    goalId: string;
  }) => Promise<{ worktreePath: string; branch: string }>;
  verifyRedFirst: (
    readings: Array<{ acId: string; reading: CriterionReading }>,
  ) => { ok: true } | { ok: false; greenAcIds: string[] };
  createAppSession: (
    sessionId: string,
    provider: string,
    projectPath: string,
    customName?: string,
  ) => string;
  now: () => Date;
};

/**
 * The goal lifecycle API the HTTP layer calls.
 *
 * Every method takes the caller's user id: a goal is private to the user who
 * created it, and the routes never pass the id through unchecked.
 *
 * Consumers: `goals.routes.ts` (every route; the manual round uses `getGoal` as
 * its ownership gate before calling the owner-agnostic round runner) and
 * `goals.module.ts` (composition).
 */
export type GoalsService = {
  createGoal(input: {
    userId: number;
    projectId: string;
    projectPath: string;
    title: string;
    objective: string;
    exitConditions: string[];
    budget?: Partial<GoalBudget>;
  }): Goal;
  /**
   * The caller's goals in one project. A goal owned by another user is never
   * returned: the project id alone does not grant read access.
   */
  listGoals(projectId: string, userId: number): Goal[];
  /**
   * The goal detail, or `null` when the goal does not exist OR belongs to another
   * user. The two cases are deliberately indistinguishable so a 404 leaks nothing.
   */
  getGoal(
    goalId: string,
    userId: number,
  ): { goal: Goal; acs: GoalAc[]; rounds: GoalRound[]; evidence: GoalEvidence[] } | null;
  addAc(goalId: string, userId: number, input: { title: string; criterion: string; expect: string }): GoalAc;
  activate(
    goalId: string,
    userId: number,
    input: { provider: string },
  ): Promise<{ goal: Goal } | { refusal: string; greenAcIds?: string[] }>;
  pause(goalId: string, userId: number): Goal;
  /**
   * Restarts a `paused` or `stalled` goal. The wall clock is measured from
   * `activatedAt`, so resuming moves that start to now: otherwise a goal that sat
   * paused longer than its budget would be paused again on the driver's first
   * tick, and resuming would appear to do nothing.
   */
  resume(goalId: string, userId: number): Goal;
  abandon(goalId: string, userId: number): Goal;
};

/** Builds the id of the AC authored after `existing`, keeping the gap-proof sequence. */
function nextAcId(goalId: string, existing: GoalAc[]): string {
  const prefix = `${goalId}${AC_ID_SEPARATOR}`;
  let highest = 0;

  for (const ac of existing) {
    if (!ac.id.startsWith(prefix)) continue;
    const seq = Number.parseInt(ac.id.slice(prefix.length), 10);
    if (Number.isInteger(seq) && seq > highest) highest = seq;
  }

  return `${prefix}${String(highest + 1).padStart(3, '0')}`;
}

/**
 * Creates the goal lifecycle service.
 *
 * Consumers: `goals.module.ts` (production composition) and the module's tests,
 * which pass a fake database and fake criterion runner.
 */
export function createGoalsService(deps: GoalsServiceDeps): GoalsService {
  const { db } = deps;

  /**
   * Reads a goal the caller owns or refuses with 404; every mutating method
   * starts here.
   *
   * A goal owned by someone else is reported exactly like a missing one: any
   * distinguishable answer (403, a different code, a longer message) would tell
   * an unauthenticated-by-identity caller which goal ids exist.
   */
  function requireOwnedGoal(goalId: string, userId: number): Goal {
    const goal = db.getGoal(goalId);
    if (!goal || goal.userId !== userId) {
      throw new AppError(`Goal "${goalId}" does not exist.`, {
        code: 'GOAL_NOT_FOUND',
        statusCode: 404,
      });
    }
    return goal;
  }

  /** Persists a partial goal update, treating a vanished row as an error. */
  function updateGoalOrThrow(goalId: string, patch: Parameters<GoalsDb['updateGoal']>[1]): Goal {
    const updated = db.updateGoal(goalId, patch);
    if (!updated) {
      throw new AppError(`Goal "${goalId}" disappeared while it was being updated.`, {
        code: 'GOAL_NOT_FOUND',
        statusCode: 404,
      });
    }
    return updated;
  }

  return {
    createGoal(input) {
      const projectPath = input.projectPath.trim();
      if (!projectPath) {
        throw new AppError('projectPath is required.', {
          code: 'PROJECT_PATH_REQUIRED',
          statusCode: 400,
        });
      }

      // The goals table stores only `project_id`, so the path is not persisted:
      // activation re-resolves it from the project id. Accepting it here keeps
      // the caller's intent explicit and rejects a body that names no project.
      return db.createGoal({
        id: randomUUID(),
        userId: input.userId,
        projectId: input.projectId,
        title: input.title.trim(),
        objective: input.objective.trim(),
        exitConditions: input.exitConditions.map((condition) => condition.trim()).filter(Boolean),
        budget: { ...DEFAULT_GOAL_BUDGET, ...input.budget },
        status: 'draft',
      });
    },

    listGoals(projectId, userId) {
      // Scoped on the way out rather than in SQL: the driver's own reads
      // (`listGoalsByStatus`) stay owner-agnostic, and the route never sees a row
      // belonging to another user.
      return db.listGoals(projectId).filter((goal) => goal.userId === userId);
    },

    getGoal(goalId, userId) {
      const goal = db.getGoal(goalId);
      if (!goal || goal.userId !== userId) return null;

      const rounds = db.listRounds(goalId);
      return {
        goal,
        acs: db.listAcs(goalId),
        rounds,
        // The readings behind each round, flattened for the detail read: the
        // panel shows the latest evidence per AC without a second request.
        evidence: rounds.flatMap((round) => db.listEvidence(round.id)),
      };
    },

    addAc(goalId, userId, input) {
      const goal = requireOwnedGoal(goalId, userId);
      if (goal.status !== 'draft') {
        throw new AppError(
          `Acceptance criteria can only be added while the goal is a draft; "${goal.title}" is ${goal.status}.`,
          { code: 'GOAL_ACS_CLOSED', statusCode: 409 },
        );
      }

      return db.createAc({
        id: nextAcId(goalId, db.listAcs(goalId)),
        goalId,
        title: input.title.trim(),
        criterion: input.criterion.trim(),
        expect: input.expect.trim(),
        status: 'active',
      });
    },

    async activate(goalId, userId, input) {
      const goal = requireOwnedGoal(goalId, userId);
      if (goal.status !== 'draft') {
        throw new AppError(
          `Only a draft goal can be activated; "${goal.title}" is ${goal.status}.`,
          { code: 'GOAL_NOT_DRAFT', statusCode: 409 },
        );
      }

      const acs = db.listAcs(goalId).filter((ac) => ac.status === 'active');
      if (acs.length === 0) {
        throw new AppError('A goal needs at least one active acceptance criterion to be activated.', {
          code: 'GOAL_HAS_NO_ACTIVE_AC',
          statusCode: 409,
        });
      }

      const emptyCriterion = acs.find((ac) => !ac.criterion.trim());
      if (emptyCriterion) {
        throw new AppError(
          `Acceptance criterion "${emptyCriterion.id}" has no runnable command; an empty criterion cannot be activated.`,
          { code: 'GOAL_AC_CRITERION_REQUIRED', statusCode: 409 },
        );
      }

      const projectPath = db.getProjectPath(goal.projectId);
      if (!projectPath) {
        throw new AppError(`Project "${goal.projectId}" does not exist.`, {
          code: 'PROJECT_NOT_FOUND',
          statusCode: 404,
        });
      }

      // The worktree is where both the session and every criterion run, so the
      // agent's edits and the next reading see the same files.
      const worktree = await deps.ensureGoalWorktree({ projectPath, goalId });
      const sessionId = deps.createAppSession(
        randomUUID(),
        input.provider,
        worktree.worktreePath,
        goal.title,
      );

      // Red first (docs §5.1): a criterion that already passes cannot prove the
      // agent did anything, so activation is refused rather than starting a loop
      // against a permanently green check. Runs are serial by design (§5.5).
      const readings: Array<{ acId: string; reading: CriterionReading }> = [];
      for (const ac of acs) {
        readings.push({
          acId: ac.id,
          reading: await deps.runCriterion({ command: ac.criterion, cwd: worktree.worktreePath }),
        });
      }

      const redFirst = deps.verifyRedFirst(readings);
      if (!redFirst.ok) {
        return {
          refusal: `Activation refused: ${redFirst.greenAcIds.join(', ')} already pass(es) before the first round, so a green round could not show the agent fixed anything. Make the criterion fail on the current code and try again.`,
          greenAcIds: redFirst.greenAcIds,
        };
      }

      // Not started here: the loop is a separate, explicit step in this phase.
      const activated = updateGoalOrThrow(goalId, {
        status: 'active',
        sessionId,
        worktreePath: worktree.worktreePath,
        branch: worktree.branch,
        activatedAt: deps.now().toISOString(),
        // The AC ids first exist now, so a goal authored without naming them
        // records the full active set as its exit condition at activation.
        ...(goal.exitConditions.length === 0
          ? { exitConditions: acs.map((ac) => ac.id) }
          : {}),
      });

      return { goal: activated };
    },

    pause(goalId, userId) {
      const goal = requireOwnedGoal(goalId, userId);
      if (goal.status !== 'active' && goal.status !== 'stalled') {
        throw new AppError(
          `Only a running goal can be paused; "${goal.title}" is ${goal.status}.`,
          { code: 'GOAL_NOT_RUNNING', statusCode: 409 },
        );
      }

      return updateGoalOrThrow(goalId, { status: 'paused' });
    },

    resume(goalId, userId) {
      const goal = requireOwnedGoal(goalId, userId);
      if (goal.status !== 'paused' && goal.status !== 'stalled') {
        throw new AppError(
          `Only a paused or stalled goal can be resumed; "${goal.title}" is ${goal.status}.`,
          { code: 'GOAL_NOT_RESUMABLE', statusCode: 409 },
        );
      }

      // The wall clock restarts here (see `GoalsService['resume']`): a resumed
      // goal gets the whole budget again rather than being paused on the tick
      // that follows.
      return updateGoalOrThrow(goalId, {
        status: 'active',
        activatedAt: deps.now().toISOString(),
      });
    },

    abandon(goalId, userId) {
      const goal = requireOwnedGoal(goalId, userId);
      if (goal.status === 'achieved' || goal.status === 'abandoned') {
        throw new AppError(`Goal "${goal.title}" is ${goal.status} and cannot be abandoned.`, {
          code: 'GOAL_NOT_ABANDONABLE',
          statusCode: 409,
        });
      }

      // The worktree is left in place: discarding it is an archive decision, and
      // this phase does not remove anything the person can still inspect.
      return updateGoalOrThrow(goalId, { status: 'abandoned' });
    },
  };
}
