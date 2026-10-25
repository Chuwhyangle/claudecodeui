/**
 * The server-level feature switches a client reads before it renders an entry point.
 *
 * WHY A ROUTE. The client bundle cannot know the deployment's settings file: the cockpit's
 * switch is read once at server boot and must reach the browser without a rebuild. This is
 * the one reading that carries it — `GET /api/settings/features` → `{ cockpit: { enabled } }`.
 * The client treats anything but a positive `true` as off (see `useServerFeatures`), so a
 * server too old to answer, or a malformed answer, cannot expose the cockpit by accident.
 *
 * WHY HERE. The reading is a SERVER-level setting, and `modules/settings` already owns the
 * file it comes from. The route receives the assembled value rather than reading the file a
 * second time: `server/index.ts` is the ONE composition root holding the boot reading, so a
 * second reader could disagree with the gate the same process applies.
 *
 * Consumers: `server/index.ts` (mounts it under `/api/settings/features` behind auth) and the
 * settings criterion, which mounts it over a literal reading.
 */
import express, { type Router } from 'express';

import type { ServerFeatures } from './server-settings.js';

/** Creates the read-only features router over the boot-time reading. */
export function createServerFeaturesRouter(features: ServerFeatures): Router {
  const router = express.Router();
  // A plain relay: the value was decided at boot and never changes while this process lives.
  router.get('/', (_req, res) => {
    res.json(features);
  });
  return router;
}
