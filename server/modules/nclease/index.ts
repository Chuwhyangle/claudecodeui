/**
 * NC-lease module — barrel.
 *
 * Surfaces the `ncres` lease ledger in the sidebar so a human can see which of
 * NC-1/2/3 is busy and release one when the work is done.
 *
 * Consumer: `server/index.ts`, which mounts `createNcLeaseModule` under
 * `/api/nclease` behind `authenticateToken`. Nothing else may deep-import this
 * directory; the module's own route criterion imports the internals it drives.
 */
// consumer: server/index.ts (mounts the returned router under /api/nclease).
export { createNcLeaseModule } from './nclease.module.js';
