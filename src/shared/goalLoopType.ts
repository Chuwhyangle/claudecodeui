/**
 * The goal loop's browser-side wire types, a type-only leaf directly under `src/shared`.
 *
 * WHY NOT `src/shared/types.ts`: that file is an oversize-ratchet baseline entry that may only
 * shrink, and these `Goal*` shapes are a new wire surface rather than an addition to an existing
 * one — the same reason `ncLeaseType.ts` and `replySuggestionsType.ts` sit here. Every consumer
 * names this leaf directly (`@/shared/goalLoopType`), so no re-export is needed.
 *
 * These mirror `server/shared/types/goals.ts` field for field; `wireContractTypeSync.test.ts`
 * reads BOTH ends, so a field added on one side without the other reds the run. They are
 * deliberately named `Goal*` and are unrelated to the read-only `QuayGoal*` types in
 * `@/shared/types`: quay goals come from an external `.quay/` store this server only reads,
 * while these are rows this server creates, owns and drives through `/api/goals`.
 *
 * Consumers: `src/shared/api/clientTail.ts` (the nine endpoints), `src/modules/goals/**` (the
 * controller, the hook, the cards and the panel), and `src/shared/tests/wireContractTypeSync.test.ts`
 * (the client/server pin).
 */

//----------------- GOAL LOOP (the Goals tab) ------------

/**
 * Goal lifecycle. `draft` is authored but not started; `active` is looping; `paused` was stopped
 * by a person; `stalled` is the no-progress circuit breaker; `achieved` means every active AC
 * passed; `abandoned` was dropped by a person.
 */
export type GoalStatus = 'draft' | 'active' | 'paused' | 'stalled' | 'achieved' | 'abandoned';

/** One acceptance criterion's own lifecycle. Only `active` ACs are evaluated. */
export type GoalAcStatus = 'active' | 'achieved' | 'superseded';

/** Why a loop round ended. `green` means every AC passed in that round. */
export type GoalRoundOutcome = 'green' | 'progress' | 'no-progress' | 'stalled' | 'budget-hit' | 'error';

/** Whether one criterion run is a pass or a fail. */
export type GoalEvidenceVerdict = 'pass' | 'fail';

/**
 * The three limits that stop a loop from spinning forever. A round that hits any of them pauses
 * the goal instead of opening another turn.
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
 * One acceptance criterion. `criterion` is the runnable command that decides it; an empty
 * command is fail-closed and cannot be activated.
 */
export type GoalAc = {
  /** `<goalId>-AC-001`, minted server-side, so the panel never builds one. */
  id: string;
  goalId: string;
  title: string;
  criterion: string;
  /** The failure the criterion is supposed to detect; keeps the judge honest. */
  expect: string;
  status: GoalAcStatus;
  createdAt: string;
};

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
 * One goal's detail as `GET /api/goals/:id` answers it.
 *
 * `evidence` carries every recorded criterion reading for the goal (oldest first); the panel
 * folds it to "the newest reading per AC" so a criterion row can show its verdict, exit code and
 * output tail.
 */
export type GoalDetail = {
  goal: Goal;
  acs: GoalAc[];
  rounds: GoalRound[];
  evidence: GoalEvidence[];
};

/** What `POST /api/goals` accepts; the owner is the authenticated user, not a body field. */
export type CreateGoalRequest = {
  projectId: string;
  /** The project directory, used by activation to place the goal worktree. */
  projectPath: string;
  title: string;
  objective: string;
  /** AC ids; empty is allowed while authoring. */
  exitConditions: string[];
  budget?: Partial<GoalBudget>;
};

/** What `POST /api/goals/:id/acs` accepts; all three fields are required by the route. */
export type CreateGoalAcRequest = {
  title: string;
  criterion: string;
  expect: string;
};

/**
 * `POST /api/goals/:id/activate` either starts the loop (`goal` present) or refuses because a
 * criterion already passed before the first round — a refusal is a successful answer, so it
 * arrives as data, not as an HTTP error.
 */
export type GoalActivationResult = {
  goal?: Goal;
  refusal?: string;
  greenAcIds?: string[];
};
