/**
 * The notices module's HTTP face.
 *
 *   GET  /api/notices              — this user's `{ active, dismissed }`
 *   POST /api/notices/:id/dismiss  — { revision }; 404 / 409 / 403 on the three refusals
 *
 * The routes only parse transport input, call the registry, and translate its `AppError`s via
 * the process error middleware. `req.user` is the caller's identity; a missing user answers 401
 * here so the router is testable without importing the auth module (the module stays a leaf).
 *
 * Consumers: `server/modules/notices/index.ts` (barrel) and `server/index.ts`, which mounts the
 * router under `/api/notices` behind `authenticateToken`.
 */
import express, { type Request, type Response, type Router } from 'express';

import { AppError, asyncHandler } from '@/shared/utils.js';

import type { NoticeRegistry } from './notice-registry.service.js';

type AuthenticatedRequest = Request & { user?: { id?: number | string } };

/** The authenticated user's numeric id, or null when the request carries no usable user. */
function userIdOf(request: Request): number | null {
  const id = (request as AuthenticatedRequest).user?.id;
  if (id === undefined || id === null) return null;
  const numeric = typeof id === 'number' ? id : Number(id);
  return Number.isInteger(numeric) ? numeric : null;
}

/** Answers 401 and returns true when there is no user; otherwise returns false. */
function rejectAnonymous(request: Request, response: Response): boolean {
  if (userIdOf(request) !== null) return false;
  response.status(401).json({ error: 'Authentication required' });
  return true;
}

/** The required `revision` string from the JSON body. */
function requireBodyRevision(body: unknown): string {
  const revision = body !== null && typeof body === 'object'
    ? (body as Record<string, unknown>).revision
    : undefined;
  if (typeof revision !== 'string' || revision.trim() === '') {
    throw new AppError('`revision` must be the non-empty revision the notice was read at', {
      code: 'NOTICE_REVISION_REQUIRED',
      statusCode: 400,
    });
  }
  return revision;
}

/**
 * Builds the router over one registry.
 *
 * Consumers: `server/index.ts`.
 */
export function createNoticesRouter(registry: NoticeRegistry): Router {
  const router = express.Router();

  router.get(
    '/',
    asyncHandler(async (request, response) => {
      if (rejectAnonymous(request, response)) return;
      response.json(await registry.list(userIdOf(request)!));
    }),
  );

  router.post(
    '/:id/dismiss',
    asyncHandler(async (request, response) => {
      if (rejectAnonymous(request, response)) return;
      const revision = requireBodyRevision(request.body);
      const noticeId = typeof request.params.id === 'string' ? request.params.id : '';
      response.json(await registry.dismiss(userIdOf(request)!, noticeId, revision));
    }),
  );

  return router;
}
