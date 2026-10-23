/**
 * QUAY DISPLAY ROUTES
 * ===================
 *
 * Endpoints that expose a project's quay state to the CloudCLI UI:
 * - `GET  /api/quay/fleet-summary`                        — the eager cross-project reading.
 * - `GET  /api/quay/last-opened-session`                  — the browser's last-opened pointer.
 * - `GET  /api/quay/:projectId/status`                    — Tier 1, whether `.quay/config.yml` exists.
 * - `GET  /api/quay/:projectId/snapshot`                  — Tier 2, task/goal/ADR/driver counts.
 * - `GET  /api/quay/:projectId/interface-session`         — the fleet's pinned target conversation.
 * - `PUT  /api/quay/:projectId/interface-session`         — pin that conversation.
 * - `DELETE /api/quay/:projectId/interface-session`       — un-pin it.
 *
 * The routes only parse the id, call the service and format the response; all filesystem and
 * subprocess work lives in `quay.service.ts` / `quay-fleet-registry.ts`. The interface-session
 * verbs are the ONE write surface here, and they exist because the cockpit's「钉选为目标会话」
 * must land in the fleet registry (the authority) rather than in a second local store.
 */

import express from 'express';

import { asyncHandler } from '@/shared/utils.js';

import type { QuayFleetRegistryService } from './quay-fleet-registry.js';
import type { createQuayService } from './quay.service.js';

/** The browser's last-opened session, as the server's pointer store answers it. */
export type QuayLastOpenedSession = { sessionId: string; openedAt: number };

type QuayRouterDependencies = {
  quayService: ReturnType<typeof createQuayService>;
  /**
   * The fleet registry seam behind the cockpit's pinned-target read/write.
   *
   * OPTIONAL so a display-only composition stays valid (and a criterion that mounts the router
   * with just the display service keeps its shape). Absent answers `fleet-cli-unavailable`, which
   * is the same document the fleet CLI produces when it cannot be reached — the cockpit's fallback
   * then applies unchanged. Production (`quay.module.ts`) always binds it.
   */
  fleetRegistry?: QuayFleetRegistryService;
  /** Reads the `ui_last_opened_session` pointer; absent means no fallback target. */
  readLastOpenedSession?: () => QuayLastOpenedSession | null;
};

/** What the router answers when no fleet registry was composed in. */
const UNAVAILABLE_FLEET: QuayFleetRegistryService = {
  readInterfaceSession: async () => ({ ok: false, reason: 'fleet-cli-unavailable' }),
  writeInterfaceSession: async () => ({ ok: false, reason: 'fleet-cli-unavailable' }),
};

/** Reads the `sessionId` out of a PUT body; `null` when it is absent or not a usable id. */
function parseInterfaceSessionId(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const value = (body as { sessionId?: unknown }).sessionId;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Creates the Quay routes; mounted by the server entrypoint behind auth. */
export function createQuayRouter(dependencies: QuayRouterDependencies): express.Router {
  const { quayService } = dependencies;
  const fleetRegistry = dependencies.fleetRegistry ?? UNAVAILABLE_FLEET;
  const readLastOpenedSession = dependencies.readLastOpenedSession ?? (() => null);
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

  // One segment, so it can never be read as a project id by the routes below.
  router.get(
    '/last-opened-session',
    asyncHandler(async (_req, res) => {
      const record = readLastOpenedSession();
      return res.json({
        sessionId: record?.sessionId ?? null,
        openedAt: record?.openedAt ?? null,
      });
    }),
  );

  /**
   * The project's pinned 「对人接口会话」. The answer is the fleet CLI's own document, relayed
   * verbatim: a caller that gets `{ok:false, reason}` must be able to state why (the fleet is not
   * installed, the project is not registered, …) instead of reading every failure as "no pin".
   */
  router.get(
    '/:projectId/interface-session',
    asyncHandler(async (req, res) => {
      const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
      const reading = await fleetRegistry.readInterfaceSession(projectId);
      return res.json(reading);
    }),
  );

  // The one write surface: the cockpit's pin un-pins with DELETE, and a refusal keeps the fleet's
  // own reason (`interface-session-is-dev-session`, `unknown-project`, …) so the UI can show it.
  router.put(
    '/:projectId/interface-session',
    asyncHandler(async (req, res) => {
      const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
      const sessionId = parseInterfaceSessionId(req.body);
      if (sessionId === null) {
        return res.status(400).json({ ok: false, reason: 'session-id-required' });
      }
      const result = await fleetRegistry.writeInterfaceSession(projectId, sessionId);
      return res.json(result);
    }),
  );

  router.delete(
    '/:projectId/interface-session',
    asyncHandler(async (req, res) => {
      const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
      const result = await fleetRegistry.writeInterfaceSession(projectId, null);
      return res.json(result);
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
