/**
 * QUAY DISPLAY ROUTES
 * ===================
 *
 * Read-only endpoints that expose a project's quay status to the CloudCLI UI:
 * - `GET /api/quay/fleet-summary`       — the eager cross-project reading, driver + task counts.
 * - `GET /api/quay/:projectId/status`   — Tier 1, whether `.quay/config.yml` exists.
 * - `GET /api/quay/:projectId/snapshot` — Tier 2, task/goal/ADR/driver counts.
 *
 * The routes only parse the id, call the service and format the response; all
 * filesystem and subprocess work lives in `quay.service.ts`. There is no write
 * route here by design — this is a display surface, not a control plane.
 */

import express from 'express';

import { asyncHandler } from '@/shared/utils.js';

import type { QuayUriErrorCode } from './quay-uri-resolve.js';
import type { createQuayService } from './quay.service.js';

type QuayRouterDependencies = {
  quayService: ReturnType<typeof createQuayService>;
};

/**
 * Maps a dereference failure code to its transport status. The resolver returns failures as
 * VALUES (never throws), so the only 5xx here is the honest "the fleet read port is down and
 * this reference has no fallback" — an invalid or unknown reference is a 400, never a 500.
 */
function uriErrorStatus(code: QuayUriErrorCode): number {
  switch (code) {
    case 'not-a-quay-uri':
    case 'missing-project':
    case 'unknown-type':
    case 'empty-id':
    case 'malformed':
      return 400;
    case 'project-not-found':
    case 'task-not-found':
      return 404;
    case 'fleet-unavailable':
    case 'snapshot-unavailable':
      return 503;
  }
}

/** The `uri` query parameter, or `''` when it is absent or repeated. */
function readUriQuery(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Creates the read-only Quay routes; mounted by the server entrypoint behind auth. */
export function createQuayRouter(dependencies: QuayRouterDependencies): express.Router {
  const { quayService } = dependencies;
  const router = express.Router();

  // Declared before the `/:projectId/...` routes so the static segment is never mistaken
  // for a project id (Express matches in declaration order).
  router.get(
    '/fleet-summary',
    asyncHandler(async (_req, res) => {
      // One aggregated reading of every quay project. The service owns the fan-out,
      // the per-project TTL and the concurrency ceiling; the route only relays it.
      const summary = await quayService.getFleetSummary();
      return res.json(summary);
    }),
  );

  // The wall's dereference entry points. `uri` must arrive as one query value (a `#ac-<n>`
  // fragment has to be percent-encoded as `%23`, since a real URL fragment never reaches the
  // server). The route only validates the transport and maps the service's value-result;
  // every read and every fallback decision lives in the service.
  router.get(
    '/resolve',
    asyncHandler(async (req, res) => {
      const uri = readUriQuery(req.query.uri);
      if (uri === '') {
        return res.status(400).json({
          ok: false,
          error: { code: 'missing-uri', message: 'the `uri` query parameter is required' },
        });
      }

      const result = await quayService.resolveQuayUri(uri);
      return res.status(result.ok ? 200 : uriErrorStatus(result.error.code)).json(result);
    }),
  );

  router.get(
    '/summary',
    asyncHandler(async (req, res) => {
      const uri = readUriQuery(req.query.uri);
      if (uri === '') {
        return res.status(400).json({
          ok: false,
          error: { code: 'missing-uri', message: 'the `uri` query parameter is required' },
        });
      }

      const result = await quayService.getQuayUriSummary(uri);
      return res.status(result.ok ? 200 : uriErrorStatus(result.error.code)).json(result);
    }),
  );

  router.get(
    '/:projectId/status',
    asyncHandler(async (req, res) => {
      const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
      const status = quayService.getQuayStatus(projectId);
      if (!status) {
        return res.status(404).json({ error: 'Project not found', projectId });
      }

      return res.json(status);
    }),
  );

  router.get(
    '/:projectId/snapshot',
    asyncHandler(async (req, res) => {
      const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
      const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
      // The Loop pulse window rides the same request rather than a second endpoint: the card
      // is one reading of one snapshot, and a separate route would let the two disagree.
      const windowHours = typeof req.query.hours === 'string' ? req.query.hours : undefined;
      const snapshot = await quayService.getQuaySnapshot(projectId, { forceRefresh, windowHours });
      if (!snapshot) {
        return res.status(404).json({ error: 'Project not found', projectId });
      }

      return res.json(snapshot);
    }),
  );

  return router;
}
