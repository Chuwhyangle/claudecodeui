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
import type { Router } from 'express';

import { createObservationRoutes } from './observation.routes.js';
import { createObservationStore, type ObservationStoreDeps } from './observation-store.js';

/**
 * Everything the composition root can supply. `wallLimit` comes from the server settings file
 * (`observation.wallLimit`); `publish` is bound to the cockpit hub's per-user broadcast.
 */
export type ObservationModuleDeps = ObservationStoreDeps;

/**
 * Builds the module's router. Consumed by `server/index.ts`.
 */
export function createObservationModule(deps: ObservationModuleDeps = {}): Router {
  return createObservationRoutes(createObservationStore(deps));
}
