// --------------------------- Goal loop shared types ------------

/**
 * The goal loop's wire/domain types.
 *
 * These describe Cloudpit's OWN goal loop: a goal authored in a project, its
 * acceptance criteria, the rounds the resident driver opens, and the evidence a
 * round records. They are deliberately named `Goal*` and are unrelated to the
 * read-only `QuayGoal*` types above: quay goals come from an external
 * `.quay/` store that this server only reads, while these are rows this server
 * creates, owns and drives through `/api/goals` and the `goal_*` MCP tools.
 *
 * Consumers: `modules/goals/**` (the store, the lifecycle service, the round
 * runner and the driver) and `modules/database/repositories/goals/goals.db.ts`
 * (the row mapping).
 */

/**
 * Goal lifecycle. `draft` is authored but not started; `active` is looping;
 * `paused` was stopped by a person; `stalled` is the no-progress circuit
 * breaker; `achieved` means every active AC passed; `abandoned` was dropped by
 * a person.
 */
export type GoalStatus = 'draft' | 'active' | 'paused' | 'stalled' | 'achieved' | 'abandoned';

/** One acceptance criterion's own lifecycle. Only `active` ACs are evaluated. */
export type GoalAcStatus = 'active' | 'achieved' | 'superseded';

/** Why a loop round ended. `green` means every AC passed in that round. */
export type GoalRoundOutcome = 'green' | 'progress' | 'no-progress' | 'stalled' | 'budget-hit' | 'error';

/**
 * The three limits that stop a loop from spinning forever. A round that hits
 * any of them pauses the goal instead of opening another turn.
 */
export type GoalBudget = {
  /** Hard cap on rounds, counted from activation. */
  maxRounds: number;
  /** Hard cap on wall-clock time since activation, in milliseconds. */
  maxWallClockMs: number;
  /** Consecutive rounds with unchanged diff digest AND unchanged criterion output before `stalled`. */
  maxNoProgress: number;
};

/** A goal as the API and the UI read it. */
export type Goal = {
  id: string;
  /** The person who activated it; the loop sends to the bound session as this caller. */
  userId: number;
  projectId: string;
  /** The session the loop drives; created at activation. */
  sessionId: string | null;
  /** The goal worktree the session and every criterion run in; created at activation. */
  worktreePath: string | null;
  /** The branch checked out in that worktree (`goal/<id>`). */
  branch: string | null;
  title: string;
  objective: string;
  /** AC ids, listed verbatim; the exit condition is their conjunction. */
  exitConditions: string[];
  status: GoalStatus;
  budget: GoalBudget;
  createdAt: string;
  activatedAt: string | null;
  achievedAt: string | null;
};

/**
 * One acceptance criterion. `criterion` is the runnable command that decides
 * it; an empty command is fail-closed and cannot be activated.
 */
export type GoalAc = {
  id: string;
  goalId: string;
  title: string;
  criterion: string;
  /** The failure the criterion is supposed to detect; keeps the judge honest. */
  expect: string;
  status: GoalAcStatus;
  createdAt: string;
};

/** Whether one criterion run is a pass or a fail. */
export type GoalEvidenceVerdict = 'pass' | 'fail';

/** One criterion run's recorded reading, kept so a person can replay the loop. */
export type GoalEvidence = {
  id: string;
  roundId: string;
  acId: string;
  exitCode: number | null;
  timedOut: boolean;
  /** sha256 of the (truncated) output, used for no-progress detection. */
  outputDigest: string;
  /** The tail of stdout+stderr, enough to see why it failed. */
  outputExcerpt: string;
  verdict: GoalEvidenceVerdict;
  at: string;
};

/** One loop round. `diffDigest` and `promptDigest` make "no progress" measurable. */
export type GoalRound = {
  id: string;
  goalId: string;
  seq: number;
  startedAt: string;
  endedAt: string | null;
  outcome: GoalRoundOutcome | null;
  diffDigest: string | null;
  promptDigest: string | null;
};

/**
 * What one criterion invocation answered. `output` is the full (already
 * truncated) text; the digest is what the no-progress check compares.
 */
export type CriterionReading = {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  outputDigest: string;
  verdict: GoalEvidenceVerdict;
};
