/**
 * The MCP gateway's goal tools.
 *
 * This module owns the one statement of "which goal tools exist and the scope
 * each requires": {@link MCP_GOAL_TOOLS}. It is a SEPARATE table from
 * `MCP_STAGE3_READ_TOOLS` / `MCP_STAGE4_WRITE_TOOLS` / `MCP_STAGE6_RESIDENT_TOOLS`
 * for the same reason the stage-6 resident tools have their own: those tables'
 * observable contents are pinned by their own criteria, and a new family of
 * tools must not silently grow a frozen name set. The transport registers these
 * through the SAME audited seam every other tool uses, gated on
 * {@link McpGoalToolDeps} being supplied by the composition root.
 *
 * Every handler answers as the calling token's principal —
 * `principal.userId`, never a caller-supplied user id — because a goal is
 * private to the person who created it. The goals service already enforces that:
 * `listGoals` filters to the owner and `getGoal` answers a goal owned by somebody
 * else exactly as it answers a missing one. This module adds no second ownership
 * rule; it only refuses the missing/other-owner case with ONE shape, so a caller
 * cannot tell "there is no such goal" from "that goal is not mine".
 *
 * Error mapping. The goals service throws `AppError` with its own vocabulary
 * (`GOAL_NOT_FOUND`, `GOAL_NOT_DRAFT`, `GOAL_HAS_NO_ACTIVE_AC`, …). The gateway's
 * audited wrapper would normalize an `AppError` to `INTERNAL_ERROR`, so each
 * handler translates it here onto the ONE gateway vocabulary: an unknown project
 * is the existing `PROJECT_NOT_FOUND`, and every other service refusal — a
 * missing goal and a goal in the wrong lifecycle state alike — is
 * `INVALID_ARGUMENT` carrying the service's own code in `details.reason`. The
 * gateway deliberately mints no new code for goals: the vocabulary in
 * `mcp-error-envelope.ts` is the single source and this module only uses its
 * existing members.
 *
 * Consumers: `mcp-gateway.transport.ts`'s `createMcpServer` (when
 * `McpGatewayDeps.goalTools` is supplied), `server/index.ts` (the production
 * assembly, over the ONE goals module instance the HTTP router also serves), and
 * `tests/mcp-goal-tools.test.ts`.
 */

import { z } from 'zod';

import type { GoalsService, RunRoundResult } from '@/modules/goals/index.js';
import { ACCESS_TOKEN_SCOPES } from '@/modules/oauth/index.js';
import type { GoalBudget } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { MCP_ERROR_CODES, McpToolError } from '../shared/mcp-error-envelope.js';
import type { McpPrincipal } from '../shared/mcp-gateway.auth.js';

// Position within AC-243's vocabulary, in the order the constant declares and
// `access-token-scopes.test.ts` pins: read, session:send, session:create,
// session:control, approve.
const [READ_SCOPE, , SESSION_CREATE_SCOPE, SESSION_CONTROL_SCOPE] = ACCESS_TOKEN_SCOPES;

// --------------------------- injected services ---------------------------

/**
 * What the goal tools answer from, both injected.
 *
 * `service` is the goals module's lifecycle service — the SAME instance the
 * `/api/goals` router serves, handed in by `server/index.ts` so an MCP call and
 * the UI cannot drift onto two stores. `runRound` is the module's one round
 * runner (also used by the manual HTTP endpoint and the resident driver), which
 * is owner-agnostic by design: `goal_run_round` therefore checks ownership
 * through `service.getGoal` BEFORE calling it, exactly as the HTTP route does.
 */
export type McpGoalToolDeps = {
  service: GoalsService;
  runRound: (goalId: string) => Promise<RunRoundResult>;
};

// --------------------------- the goal table ---------------------------

/**
 * Every goal tool, with the scope a caller's token must carry.
 *
 * The "read" pair uses `cloudcli:read`; the creation verb uses
 * `cloudcli:session:create` (the same scope `session_create` reads, because it
 * mints a new goal row); every lifecycle verb uses
 * `cloudcli:session:control`, the scope the session write tools that change
 * existing work already require.
 */
export const MCP_GOAL_TOOLS = [
  {
    name: 'goal_list',
    requiredScope: READ_SCOPE,
    description:
      'List the caller\'s goals in one project (named by id, path or unique title), newest first, with the goal row of each (id, title, status, objective, budget and timestamps).',
  },
  {
    name: 'goal_status',
    requiredScope: READ_SCOPE,
    description:
      'Read one goal the caller owns: the goal row, its acceptance criteria, its loop rounds and the evidence recorded by those rounds.',
  },
  {
    name: 'goal_create',
    requiredScope: SESSION_CREATE_SCOPE,
    description:
      'Create a draft goal in a project: title, objective, optional exit conditions (acceptance-criterion ids) and optional budget limits.',
  },
  {
    name: 'goal_add_ac',
    requiredScope: SESSION_CONTROL_SCOPE,
    description:
      'Add one acceptance criterion to a draft goal: a title, the runnable criterion command that decides it, and the failure the criterion is expected to detect.',
  },
  {
    name: 'goal_activate',
    requiredScope: SESSION_CONTROL_SCOPE,
    description:
      'Activate a draft goal: create its worktree and session and run the red-first check. A goal whose criteria already pass is refused with the reason instead of starting.',
  },
  {
    name: 'goal_pause',
    requiredScope: SESSION_CONTROL_SCOPE,
    description: 'Pause a running (active or stalled) goal so its driver stops opening rounds.',
  },
  {
    name: 'goal_resume',
    requiredScope: SESSION_CONTROL_SCOPE,
    description: 'Resume a paused or stalled goal; the wall-clock budget restarts from now.',
  },
  {
    name: 'goal_abandon',
    requiredScope: SESSION_CONTROL_SCOPE,
    description: 'Abandon a goal that is not already achieved or abandoned. Its worktree is left in place.',
  },
  {
    name: 'goal_run_round',
    requiredScope: SESSION_CONTROL_SCOPE,
    description:
      'Run one round of an active goal the caller owns: every active acceptance criterion runs in the goal worktree, evidence is recorded, and the round outcome is reported.',
  },
] as const;

/** One goal tool's name, derived from the table so the two cannot drift. */
export type McpGoalToolName = (typeof MCP_GOAL_TOOLS)[number]['name'];

// --------------------------- domain shapes ---------------------------

/** One goal row as `tools/list` advertises it. */
const GOAL_BUDGET_SHAPE: z.ZodRawShape = {
  maxRounds: z.number(),
  maxWallClockMs: z.number(),
  maxNoProgress: z.number(),
};

const GOAL_SHAPE: z.ZodRawShape = {
  id: z.string(),
  userId: z.number(),
  projectId: z.string(),
  sessionId: z.string().nullable(),
  worktreePath: z.string().nullable(),
  branch: z.string().nullable(),
  title: z.string(),
  objective: z.string(),
  exitConditions: z.array(z.string()),
  status: z.enum(['draft', 'active', 'paused', 'stalled', 'achieved', 'abandoned']),
  budget: z.object(GOAL_BUDGET_SHAPE),
  createdAt: z.string(),
  activatedAt: z.string().nullable(),
  achievedAt: z.string().nullable(),
};

const GOAL_AC_SHAPE: z.ZodRawShape = {
  id: z.string(),
  goalId: z.string(),
  title: z.string(),
  criterion: z.string(),
  expect: z.string(),
  status: z.enum(['active', 'achieved', 'superseded']),
  createdAt: z.string(),
};

const GOAL_ROUND_SHAPE: z.ZodRawShape = {
  id: z.string(),
  goalId: z.string(),
  seq: z.number(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  outcome: z
    .union([
      z.enum(['green', 'progress', 'no-progress', 'stalled', 'budget-hit', 'error']),
      z.null(),
    ]),
  diffDigest: z.string().nullable(),
  promptDigest: z.string().nullable(),
};

const GOAL_EVIDENCE_SHAPE: z.ZodRawShape = {
  id: z.string(),
  roundId: z.string(),
  acId: z.string(),
  exitCode: z.number().nullable(),
  timedOut: z.boolean(),
  outputDigest: z.string(),
  outputExcerpt: z.string(),
  verdict: z.enum(['pass', 'fail']),
  at: z.string(),
};

/** What a green round's merge back into the project checkout answered. */
const GOAL_MERGE_SHAPE: z.ZodRawShape = {
  merged: z.boolean(),
  commit: z.string().nullable(),
  reason: z.string().nullable(),
};

// --------------------------- input and output schemas ---------------------------

const GOAL_LIST_INPUT_SCHEMA: z.ZodRawShape = {
  // AC-246's target gate resolves an id, a path or a unique title; as a READ the
  // substring layer is allowed, exactly as `sessions_list` / `session_search` are.
  project: z.string().min(1),
};

const GOAL_STATUS_INPUT_SCHEMA: z.ZodRawShape = {
  goalId: z.string().min(1),
};

const GOAL_CREATE_INPUT_SCHEMA: z.ZodRawShape = {
  // AC-246's target gate resolves this reference (an exact id, a project path or
  // a unique title) to the project id before the handler runs; a project nothing
  // matches refuses the call with `PROJECT_NOT_FOUND`.
  project: z.string().min(1),
  projectPath: z.string().min(1),
  title: z.string().min(1),
  objective: z.string().min(1),
  exitConditions: z.array(z.string().min(1)).optional(),
  budget: z
    .object({
      maxRounds: z.number().int().positive().optional(),
      maxWallClockMs: z.number().int().positive().optional(),
      maxNoProgress: z.number().int().positive().optional(),
    })
    .optional(),
};

const GOAL_ADD_AC_INPUT_SCHEMA: z.ZodRawShape = {
  goalId: z.string().min(1),
  title: z.string().min(1),
  criterion: z.string().min(1),
  expect: z.string().min(1),
};

const GOAL_GOAL_ID_INPUT_SCHEMA: z.ZodRawShape = {
  goalId: z.string().min(1),
};

const GOAL_ACTIVATE_INPUT_SCHEMA: z.ZodRawShape = {
  goalId: z.string().min(1),
  provider: z.string().min(1).optional(),
};

const GOAL_LIST_OUTPUT_SCHEMA: z.ZodRawShape = {
  goals: z.array(z.object(GOAL_SHAPE)),
};

const GOAL_STATUS_OUTPUT_SCHEMA: z.ZodRawShape = {
  goal: z.object(GOAL_SHAPE),
  acs: z.array(z.object(GOAL_AC_SHAPE)),
  rounds: z.array(z.object(GOAL_ROUND_SHAPE)),
  evidence: z.array(z.object(GOAL_EVIDENCE_SHAPE)),
};

const GOAL_CREATE_OUTPUT_SCHEMA: z.ZodRawShape = {
  goal: z.object(GOAL_SHAPE),
};

const GOAL_ADD_AC_OUTPUT_SCHEMA: z.ZodRawShape = {
  ac: z.object(GOAL_AC_SHAPE),
};

const GOAL_ACTIVATE_OUTPUT_SCHEMA: z.ZodRawShape = {
  goal: z.object(GOAL_SHAPE).optional(),
  refusal: z.string().optional(),
  greenAcIds: z.array(z.string()).optional(),
};

const GOAL_LIFECYCLE_OUTPUT_SCHEMA: z.ZodRawShape = {
  goal: z.object(GOAL_SHAPE),
};

const GOAL_RUN_ROUND_OUTPUT_SCHEMA: z.ZodRawShape = {
  goalId: z.string(),
  round: z.object(GOAL_ROUND_SHAPE),
  allGreen: z.boolean(),
  stalled: z.boolean(),
  redAcIds: z.array(z.string()),
  prompt: z.string(),
  merge: z.union([z.object(GOAL_MERGE_SHAPE), z.null()]),
};

/** The default provider an activation names when the caller does not. */
const DEFAULT_PROVIDER = 'claude';

// --------------------------- shared helpers ---------------------------

/** One English sentence for a goal that does not exist or belongs to another user. */
function goalNotFoundMessage(goalId: string): string {
  return `Goal "${goalId}" does not exist.`;
}

/**
 * Translates the goals service's `AppError` onto the one gateway vocabulary.
 *
 * A missing project keeps the gateway's existing `PROJECT_NOT_FOUND`; every
 * other refusal — a missing goal, a goal in the wrong lifecycle state, a goal
 * with no runnable criterion — is `INVALID_ARGUMENT` carrying the service's own
 * code in `details.reason`, so a caller can branch on the state without the
 * gateway minting a second code per state. Anything that is not an `AppError`
 * (or is already a gateway error) is re-thrown untouched, and the audited
 * wrapper normalizes it to `INTERNAL_ERROR`.
 */
function toGoalToolError(error: unknown, goalId: string | null): never {
  if (error instanceof AppError) {
    if (error.code === 'PROJECT_NOT_FOUND') {
      throw new McpToolError(MCP_ERROR_CODES.PROJECT_NOT_FOUND, error.message);
    }
    const details: Record<string, unknown> = { reason: error.code };
    if (goalId !== null) {
      details.goalId = goalId;
    }
    throw new McpToolError(MCP_ERROR_CODES.INVALID_ARGUMENT, error.message, undefined, details);
  }
  throw error;
}

/** Calls one goals-service operation, translating its refusal onto the gateway vocabulary. */
async function callGoals<T>(goalId: string | null, run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    toGoalToolError(error, goalId);
  }
}

/** Reads a required non-empty string argument (the declared schema already checked its type). */
function readString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new McpToolError(
      MCP_ERROR_CODES.INVALID_ARGUMENT,
      `"${name}" is required and must be a non-empty string.`,
    );
  }
  return value.trim();
}

/** Reads the optional budget object, already validated by the declared schema. */
function readBudget(value: unknown): Partial<GoalBudget> | undefined {
  return value === undefined ? undefined : (value as Partial<GoalBudget>);
}

// --------------------------- handlers ---------------------------

/** `goal_list`: the caller's goals in one project. */
async function buildGoalList(
  args: Record<string, unknown>,
  ctx: { principal: McpPrincipal },
  deps: McpGoalToolDeps,
): Promise<{ goals: ReturnType<GoalsService['listGoals']> }> {
  const projectId = readString(args, 'project');
  const goals = await callGoals(null, () => deps.service.listGoals(projectId, ctx.principal.userId));
  return { goals };
}

/**
 * `goal_status`: one goal the caller owns.
 *
 * A goal owned by somebody else is answered exactly like a missing one — the
 * service returns `null` for both, and this handler renders ONE envelope — so an
 * authenticated caller cannot probe which goal ids exist.
 */
async function buildGoalStatus(
  args: Record<string, unknown>,
  ctx: { principal: McpPrincipal },
  deps: McpGoalToolDeps,
): Promise<NonNullable<ReturnType<GoalsService['getGoal']>>> {
  const goalId = readString(args, 'goalId');
  const detail = await callGoals(goalId, () => deps.service.getGoal(goalId, ctx.principal.userId));
  if (detail === null) {
    throw new McpToolError(MCP_ERROR_CODES.INVALID_ARGUMENT, goalNotFoundMessage(goalId), undefined, {
      reason: 'GOAL_NOT_FOUND',
      goalId,
    });
  }
  return detail;
}

/** `goal_create`: a draft goal owned by the calling principal. */
async function buildGoalCreate(
  args: Record<string, unknown>,
  ctx: { principal: McpPrincipal },
  deps: McpGoalToolDeps,
): Promise<{ goal: ReturnType<GoalsService['createGoal']> }> {
  const goal = await callGoals(null, () =>
    deps.service.createGoal({
      userId: ctx.principal.userId,
      projectId: readString(args, 'project'),
      projectPath: readString(args, 'projectPath'),
      title: readString(args, 'title'),
      objective: readString(args, 'objective'),
      exitConditions: Array.isArray(args.exitConditions) ? (args.exitConditions as string[]) : [],
      budget: readBudget(args.budget),
    }),
  );
  return { goal };
}

/** `goal_add_ac`: one acceptance criterion appended to a draft goal. */
async function buildGoalAddAc(
  args: Record<string, unknown>,
  ctx: { principal: McpPrincipal },
  deps: McpGoalToolDeps,
): Promise<{ ac: ReturnType<GoalsService['addAc']> }> {
  const goalId = readString(args, 'goalId');
  const ac = await callGoals(goalId, () =>
    deps.service.addAc(goalId, ctx.principal.userId, {
      title: readString(args, 'title'),
      criterion: readString(args, 'criterion'),
      expect: readString(args, 'expect'),
    }),
  );
  return { ac };
}

/** `goal_activate`: activation's own answer, including a red-first refusal. */
async function buildGoalActivate(
  args: Record<string, unknown>,
  ctx: { principal: McpPrincipal },
  deps: McpGoalToolDeps,
): Promise<Awaited<ReturnType<GoalsService['activate']>>> {
  const goalId = readString(args, 'goalId');
  const provider = args.provider === undefined ? DEFAULT_PROVIDER : readString(args, 'provider');
  return callGoals(goalId, () => deps.service.activate(goalId, ctx.principal.userId, { provider }));
}

/** `goal_pause` / `goal_resume` / `goal_abandon`: the updated goal row. */
async function buildGoalLifecycle(
  verb: 'pause' | 'resume' | 'abandon',
  args: Record<string, unknown>,
  ctx: { principal: McpPrincipal },
  deps: McpGoalToolDeps,
): Promise<{ goal: ReturnType<GoalsService['pause']> }> {
  const goalId = readString(args, 'goalId');
  const goal = await callGoals(goalId, () =>
    deps.service[verb](goalId, ctx.principal.userId),
  );
  return { goal };
}

/**
 * `goal_run_round`: one round of an active goal the caller owns.
 *
 * `runRound` is owner-agnostic (the resident driver reaches it directly), so
 * ownership is checked here through `getGoal` before a single criterion runs —
 * the same precondition the HTTP route applies.
 */
async function buildGoalRunRound(
  args: Record<string, unknown>,
  ctx: { principal: McpPrincipal },
  deps: McpGoalToolDeps,
): Promise<{
  goalId: string;
  round: RunRoundResult['round'];
  allGreen: boolean;
  stalled: boolean;
  redAcIds: string[];
  prompt: string;
  merge: RunRoundResult['merge'];
}> {
  const goalId = readString(args, 'goalId');
  const detail = await callGoals(goalId, () => deps.service.getGoal(goalId, ctx.principal.userId));
  if (detail === null) {
    throw new McpToolError(MCP_ERROR_CODES.INVALID_ARGUMENT, goalNotFoundMessage(goalId), undefined, {
      reason: 'GOAL_NOT_FOUND',
      goalId,
    });
  }

  const result = await callGoals(goalId, () => deps.runRound(goalId));
  return {
    goalId,
    round: result.round,
    allGreen: result.allGreen,
    stalled: result.stalled,
    redAcIds: result.redAcs.map((ac) => ac.id),
    prompt: result.prompt,
    merge: result.merge,
  };
}

// --------------------------- registration ---------------------------

/**
 * One goal tool as it is handed to the registration seam.
 *
 * Deliberately the same shape as the resident and write tools' registrations, so
 * the transport's one audited seam installs any of them without a special case.
 */
export type McpGoalToolRegistration = {
  name: string;
  description: string;
  requiredScope: string;
  inputSchema: z.ZodRawShape;
  outputSchema: z.ZodRawShape;
  handler: (args: Record<string, unknown>, ctx: { principal: McpPrincipal }) => unknown | Promise<unknown>;
};

/**
 * The seam `registerMcpGoalTools` installs through. The transport supplies one
 * backed by AC-244's `withMcpAudit`, so every goal tool inherits the single
 * audit row and the scope refusal without restating either.
 */
export type McpGoalToolSeam = (registration: McpGoalToolRegistration) => void;

/** Each goal tool's declared argument shape, total over {@link McpGoalToolName}. */
const GOAL_TOOL_INPUT_SCHEMAS: Record<McpGoalToolName, z.ZodRawShape> = {
  goal_list: GOAL_LIST_INPUT_SCHEMA,
  goal_status: GOAL_STATUS_INPUT_SCHEMA,
  goal_create: GOAL_CREATE_INPUT_SCHEMA,
  goal_add_ac: GOAL_ADD_AC_INPUT_SCHEMA,
  goal_activate: GOAL_ACTIVATE_INPUT_SCHEMA,
  goal_pause: GOAL_GOAL_ID_INPUT_SCHEMA,
  goal_resume: GOAL_GOAL_ID_INPUT_SCHEMA,
  goal_abandon: GOAL_GOAL_ID_INPUT_SCHEMA,
  goal_run_round: GOAL_GOAL_ID_INPUT_SCHEMA,
};

/** Each goal tool's declared result shape, total over {@link McpGoalToolName}. */
const GOAL_TOOL_OUTPUT_SCHEMAS: Record<McpGoalToolName, z.ZodRawShape> = {
  goal_list: GOAL_LIST_OUTPUT_SCHEMA,
  goal_status: GOAL_STATUS_OUTPUT_SCHEMA,
  goal_create: GOAL_CREATE_OUTPUT_SCHEMA,
  goal_add_ac: GOAL_ADD_AC_OUTPUT_SCHEMA,
  goal_activate: GOAL_ACTIVATE_OUTPUT_SCHEMA,
  goal_pause: GOAL_LIFECYCLE_OUTPUT_SCHEMA,
  goal_resume: GOAL_LIFECYCLE_OUTPUT_SCHEMA,
  goal_abandon: GOAL_LIFECYCLE_OUTPUT_SCHEMA,
  goal_run_round: GOAL_RUN_ROUND_OUTPUT_SCHEMA,
};

/** Each goal tool's handler, total over {@link McpGoalToolName}. */
const GOAL_TOOL_HANDLERS: Record<
  McpGoalToolName,
  (args: Record<string, unknown>, ctx: { principal: McpPrincipal }, deps: McpGoalToolDeps) => unknown
> = {
  goal_list: (args, ctx, deps) => buildGoalList(args, ctx, deps),
  goal_status: (args, ctx, deps) => buildGoalStatus(args, ctx, deps),
  goal_create: (args, ctx, deps) => buildGoalCreate(args, ctx, deps),
  goal_add_ac: (args, ctx, deps) => buildGoalAddAc(args, ctx, deps),
  goal_activate: (args, ctx, deps) => buildGoalActivate(args, ctx, deps),
  goal_pause: (args, ctx, deps) => buildGoalLifecycle('pause', args, ctx, deps),
  goal_resume: (args, ctx, deps) => buildGoalLifecycle('resume', args, ctx, deps),
  goal_abandon: (args, ctx, deps) => buildGoalLifecycle('abandon', args, ctx, deps),
  goal_run_round: (args, ctx, deps) => buildGoalRunRound(args, ctx, deps),
};

/**
 * Registers every goal tool exactly once through the audited seam.
 *
 * The table is the one place the pair (name, scope) is written down; the three
 * `Record<McpGoalToolName, …>` maps above are total over the same union, so a
 * name added to the table without a schema or a handler is a compile error.
 */
export function registerMcpGoalTools(seam: McpGoalToolSeam, deps: McpGoalToolDeps): void {
  for (const tool of MCP_GOAL_TOOLS) {
    seam({
      name: tool.name,
      description: tool.description,
      requiredScope: tool.requiredScope,
      inputSchema: GOAL_TOOL_INPUT_SCHEMAS[tool.name],
      outputSchema: GOAL_TOOL_OUTPUT_SCHEMAS[tool.name],
      handler: (args, ctx) => GOAL_TOOL_HANDLERS[tool.name](args, ctx, deps),
    });
  }
}
