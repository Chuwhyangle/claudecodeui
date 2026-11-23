import express from 'express';
import type { Request } from 'express';

import type { GoalBudget } from '@/shared/types.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

import type { GoalsService } from './goals.service.js';
import type { RunRoundResult } from './run-round.js';

// --------------------------- Transport parsing ------------

/** `authenticateToken` puts the caller here; goals are owned by a user id. */
type AuthenticatedRequest = Request & { user?: { id?: number | string } };

/** The goal routes' two collaborators: lifecycle operations and the manual round. */
export type GoalsRoutesDeps = {
  service: GoalsService;
  runRound: (goalId: string) => Promise<RunRoundResult>;
};

function readRequiredString(value: unknown, name: string): string {
  const parsed = typeof value === 'string' ? value.trim() : '';
  if (!parsed) {
    throw new AppError(`${name} is required.`, {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }
  return parsed;
}

function readProjectId(value: unknown): string {
  const projectId = typeof value === 'string' ? value.trim() : '';
  if (!projectId) {
    throw new AppError('project is required.', {
      code: 'PROJECT_ID_REQUIRED',
      statusCode: 400,
    });
  }
  return projectId;
}

function readUserId(request: Request): number {
  const userId = Number((request as AuthenticatedRequest).user?.id);
  if (!Number.isInteger(userId)) {
    throw new AppError('Authenticated user is required.', {
      code: 'USER_REQUIRED',
      statusCode: 401,
    });
  }
  return userId;
}

/** Exit conditions are AC ids; an empty list is allowed while authoring. */
function readExitConditions(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new AppError('exitConditions must be an array of acceptance-criterion ids.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }
  return value.map((entry) => readRequiredString(entry, 'exitConditions[]'));
}

/** Accepts only the three budget limits, each a positive integer. */
function readBudget(value: unknown): Partial<GoalBudget> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('budget must be an object.', { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
  }

  const record = value as Record<string, unknown>;
  const budget: Partial<GoalBudget> = {};
  for (const field of ['maxRounds', 'maxWallClockMs', 'maxNoProgress'] as const) {
    const raw = record[field];
    if (raw === undefined) continue;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
      throw new AppError(`budget.${field} must be a positive integer.`, {
        code: 'INVALID_REQUEST_BODY',
        statusCode: 400,
      });
    }
    budget[field] = raw;
  }

  return budget;
}

// --------------------------- Router ------------

/**
 * Builds the goals HTTP router around an injected service.
 *
 * Consumers: `goals.module.ts`, which composes the production service and mounts
 * the router at `/api/goals`. Every handler below only parses input, calls one
 * service function, and formats the response.
 */
export function createGoalsRouter(deps: GoalsRoutesDeps): express.Router {
  const router = express.Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const projectId = readProjectId(req.query.project);
      res.json(createApiSuccessResponse(deps.service.listGoals(projectId, readUserId(req))));
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const goal = deps.service.createGoal({
        userId: readUserId(req),
        projectId: readProjectId(body.project ?? body.projectId),
        projectPath: readRequiredString(body.projectPath, 'projectPath'),
        title: readRequiredString(body.title, 'title'),
        objective: readRequiredString(body.objective, 'objective'),
        exitConditions: readExitConditions(body.exitConditions),
        budget: readBudget(body.budget),
      });

      res.status(201).json(createApiSuccessResponse(goal));
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const detail = deps.service.getGoal(readRequiredString(req.params.id, 'id'), readUserId(req));
      if (!detail) {
        throw new AppError(`Goal "${req.params.id}" does not exist.`, {
          code: 'GOAL_NOT_FOUND',
          statusCode: 404,
        });
      }

      res.json(createApiSuccessResponse(detail));
    }),
  );

  router.post(
    '/:id/acs',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const ac = deps.service.addAc(readRequiredString(req.params.id, 'id'), readUserId(req), {
        title: readRequiredString(body.title, 'title'),
        criterion: readRequiredString(body.criterion, 'criterion'),
        expect: readRequiredString(body.expect, 'expect'),
      });

      res.status(201).json(createApiSuccessResponse(ac));
    }),
  );

  router.post(
    '/:id/activate',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await deps.service.activate(
        readRequiredString(req.params.id, 'id'),
        readUserId(req),
        { provider: readRequiredString(body.provider, 'provider') },
      );

      // A refusal is a successful answer — the criteria ran and one was already
      // green — so it is 200 with the refusal detail, not an error status.
      res.json(createApiSuccessResponse(result));
    }),
  );

  router.post(
    '/:id/pause',
    asyncHandler(async (req, res) => {
      const goal = deps.service.pause(readRequiredString(req.params.id, 'id'), readUserId(req));
      res.json(createApiSuccessResponse(goal));
    }),
  );

  router.post(
    '/:id/resume',
    asyncHandler(async (req, res) => {
      const goal = deps.service.resume(readRequiredString(req.params.id, 'id'), readUserId(req));
      res.json(createApiSuccessResponse(goal));
    }),
  );

  router.post(
    '/:id/abandon',
    asyncHandler(async (req, res) => {
      const goal = deps.service.abandon(readRequiredString(req.params.id, 'id'), readUserId(req));
      res.json(createApiSuccessResponse(goal));
    }),
  );

  router.post(
    '/:id/run-round',
    asyncHandler(async (req, res) => {
      const goalId = readRequiredString(req.params.id, 'id');
      // The round runner itself is owner-agnostic (the resident driver reaches it
      // directly), so ownership is checked here before a single criterion runs.
      if (!deps.service.getGoal(goalId, readUserId(req))) {
        throw new AppError(`Goal "${goalId}" does not exist.`, {
          code: 'GOAL_NOT_FOUND',
          statusCode: 404,
        });
      }

      const result = await deps.runRound(goalId);
      res.json(createApiSuccessResponse(result));
    }),
  );

  return router;
}
