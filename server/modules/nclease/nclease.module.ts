import { createNcLeaseRoutes } from './nclease.routes.js';

/**
 * Composes the NC-lease module: one router, no state of its own.
 *
 * A leaf module over the `ncres` CLI — it imports only `server/shared/**` and
 * itself, so it never reaches into a sibling feature module.
 *
 * Consumer: `server/index.ts`, which mounts it under `/api/nclease` behind
 * `authenticateToken`.
 */
export function createNcLeaseModule() {
  return { router: createNcLeaseRoutes() };
}
