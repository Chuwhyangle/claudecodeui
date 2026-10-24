/**
 * The view-event log's HTTP face.
 *
 *   POST /api/observation/view-events — one batch of viewing episodes to append
 *
 * The route only parses the caller's identity, hands the body to the service and answers 204:
 * validation, the enable switch and the disk write all belong to
 * `view-events.service.ts`. A 204 is returned for both "written" and "switch off", because from
 * the caller's side nothing is wrong in either case — the server simply keeps the log only when
 * the operator has not opted out.
 *
 * `req.user` is the caller's identity; the route answers 401 itself when it is absent, matching
 * the observation routes' pattern so the module stays a leaf and the auth path is testable
 * without importing the auth module.
 *
 * Consumers: `server/modules/observation/observation.module.ts` (composition) and
 * `server/modules/observation/tests/view-events.test.ts`.
 */
import express, { type NextFunction, type Request, type Response, type Router } from 'express';

import type { ViewEventService } from './view-events.service.js';

type AuthenticatedRequest = Request & { user?: { id?: number | string } };

/** The authenticated user's key, or null when the request carries no user. */
function userKey(req: Request): string | null {
  const id = (req as AuthenticatedRequest).user?.id;
  if (id === undefined || id === null) return null;
  const key = `${id}`.trim();
  return key === '' ? null : key;
}

/**
 * Builds the router over one service.
 *
 * Consumers: `server/modules/observation/observation.module.ts`.
 */
export function createViewEventRoutes(service: ViewEventService): Router {
  const router = express.Router();

  router.post('/view-events', (req: Request, res: Response, next: NextFunction) => {
    if (userKey(req) === null) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    // Express 4 does not forward a rejected promise to the error middleware on its own.
    service
      .appendBatch(req.body)
      .then(() => {
        res.status(204).end();
      })
      .catch(next);
  });

  return router;
}
