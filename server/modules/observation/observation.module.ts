/**
 * The observation module's composition entry.
 *
 * `server/index.ts` builds this ONCE per process, mounts the returned router under
 * `/api/observation`, and supplies the two seams a leaf cannot own: the clock, and the push
 * that carries `observation.update` to the user's cockpit connections. The module therefore
 * imports no sibling feature module — it reaches persistence through `modules/database`'s
 * barrel and `server/shared` only, so `modules/observation` is a registered leaf in AC-394's
 * directory manifest rather than a new cycle member.
 *
 * Consumers: `server/index.ts` only.
 */
import express, { type Router } from 'express';

import { createObservationRoutes } from './observation.routes.js';
import { createObservationStore, type ObservationStoreDeps } from './observation-store.js';
import { createViewEventRoutes } from './view-events.routes.js';
import {
  createViewEventService,
  resolveViewEventsSettings,
  type ViewEventsSettings,
} from './view-events.service.js';

/**
 * Everything the composition root can supply. `wallLimit` and `viewEvents` come from the server
 * settings file's `observation` block; `publish` is bound to the cockpit hub's per-user broadcast.
 * An omitted `viewEvents` keeps the shipped on-by-default local log.
 */
export type ObservationModuleDeps = ObservationStoreDeps & { viewEvents?: Partial<ViewEventsSettings> };

/**
 * Builds the module's router. Consumed by `server/index.ts`.
 *
 * Two sub-routers share the `/api/observation` mount: the wall's object/seen/watch endpoints and
 * the view-event log. Both stay inside this module's leaf boundary — neither reaches a sibling
 * feature module.
 */
export function createObservationModule(deps: ObservationModuleDeps = {}): Router {
  const router = express.Router();
  router.use(createObservationRoutes(createObservationStore(deps)));
  router.use(createViewEventRoutes(createViewEventService(resolveViewEventsSettings(deps.viewEvents))));
  return router;
}
