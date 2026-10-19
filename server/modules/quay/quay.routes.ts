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

import type { createQuayService } from './quay.service.js';

type QuayRouterDependencies = {
  quayService: ReturnType<typeof createQuayService>;
};

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
