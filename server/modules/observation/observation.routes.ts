/**
 * The observation layer's HTTP face.
 *
 *   GET    /api/observation/wall        — the user's wall (objects + deltas + producer liveness)
 *   POST   /api/observation/seen        — { uri, revision } advances the cross-device cursor
 *   PUT    /api/observation/watch/:uri  — pins one object
 *   DELETE /api/observation/watch/:uri  — unpins it
 *
 * The routes only parse transport input, call one store method, and format the result. The URI
 * is validated here (a 400 naming the grammar) and again in the store, so neither a typo in the
 * path nor one in a JSON body can mint an object. `req.user` is the caller's identity; the
 * routes answer 401 themselves when it is absent, which also makes the authentication path
 * testable without importing the auth module (the observation module stays a leaf).
 *
 * THE COCKPIT GATE. The wall is the cockpit's reading surface; the sidebar's pin controls are
 * the same feature. When the cockpit is switched off, every route here answers 404 and the
 * producer-side `POST /view-events` (mounted beside this router) is untouched. The gate is an
 * explicit 404 handler rather than an unmounted router because the SPA catch-all is mounted
 * after every API route and would otherwise answer `/api/observation/wall` with HTML 200.
 *
 * Consumers: `server/modules/observation/observation.module.ts` (composition) and
 * `server/modules/observation/tests/observation-routes.test.ts`.
 */
import express, { type Request, type Response, type Router } from 'express';

import { AppError } from '@/shared/utils.js';

import { parseObservationUri } from './observation-uri.js';
import type { ObservationStore } from './observation-store.js';

type AuthenticatedRequest = Request & { user?: { id?: number | string } };

/** The authenticated user's key, or null when the request carries no user. */
function userKey(req: Request): string | null {
  const id = (req as AuthenticatedRequest).user?.id;
  if (id === undefined || id === null) return null;
  const key = `${id}`.trim();
  return key === '' ? null : key;
}

/** Answers 401 and returns true when there is no user; otherwise returns false. */
function rejectAnonymous(req: Request, res: Response): boolean {
  if (userKey(req) !== null) return false;
  res.status(401).json({ error: 'Authentication required' });
  return true;
}

function invalidRequest(message: string): AppError {
  return new AppError(message, { code: 'INVALID_REQUEST', statusCode: 400 });
}

/** Reads the required `uri` field from a JSON body and validates its grammar. */
function requireBodyUri(body: unknown): string {
  const uri = body !== null && typeof body === 'object' ? (body as Record<string, unknown>).uri : undefined;
  if (parseObservationUri(uri) === null) {
    throw invalidRequest('`uri` must be one of cloudcli://session/<id>, cloudcli://architecture/<id>, quay://<id>/board');
  }
  return uri as string;
}

/**
 * Builds the router over one store.
 *
 * `cockpitEnabled` is REQUIRED: a caller must state the feature's state rather than inherit a
 * default that could expose the wall by omission. `observation.module.ts` supplies the
 * process-wide port; the route criterion supplies both arms explicitly.
 *
 * Consumers: `server/modules/observation/observation.module.ts`.
 */
export function createObservationRoutes(
  store: ObservationStore,
  cockpitEnabled: () => boolean,
): Router {
  const router = express.Router();

  // One gate for all four routes: the wall, the seen cursor and the pin list are the cockpit's
  // reading surface, not a general-purpose API.
  router.use((_req, res, next) => {
    if (cockpitEnabled()) {
      next();
      return;
    }
    res.status(404).json({ error: 'Not found' });
  });

  router.get('/wall', (req, res) => {
    if (rejectAnonymous(req, res)) return;
    res.json(store.getWall(userKey(req)!));
  });

  router.post('/seen', (req, res) => {
    if (rejectAnonymous(req, res)) return;
    const uri = requireBodyUri(req.body);
    const revision = (req.body as Record<string, unknown>).revision;
    if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) {
      throw invalidRequest('`revision` must be a positive integer');
    }
    res.json(store.markSeen(userKey(req)!, uri, revision));
  });

  router.put('/watch/:uri', (req, res) => {
    if (rejectAnonymous(req, res)) return;
    const uri = req.params.uri;
    if (parseObservationUri(uri) === null) throw invalidRequest('`uri` is not a valid observation URI');
    res.json({ watch: store.pin(userKey(req)!, uri) });
  });

  router.delete('/watch/:uri', (req, res) => {
    if (rejectAnonymous(req, res)) return;
    const uri = req.params.uri;
    if (parseObservationUri(uri) === null) throw invalidRequest('`uri` is not a valid observation URI');
    res.json({ removed: store.unpin(userKey(req)!, uri) });
  });

  return router;
}
