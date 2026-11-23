/**
 * Goals module — barrel.
 *
 * Cloudpit's OWN goal loop: a goal is a SQLite row this server creates,
 * activates, drives round by round and merges back; it is reachable through
 * `/api/goals` and the gateway's `goal_*` MCP tools, and every id is a UUID.
 *
 * This is NOT the read-only `QuayGoal*` concept: quay goals live in an external
 * `.quay/` store owned by the quay CLI — this server only READS that snapshot
 * (`quay_snapshot`). Nothing here imports quay and quay imports nothing here;
 * the two vocabularies (`Goal*` vs `QuayGoal*`) are kept apart on purpose so a
 * quay stage goal can never be mistaken for a loop this module drives.
 *
 * Exposes the composed module `server/index.ts` mounts at `/api/goals` and whose
 * driver it starts with the rest of the server, plus the driver factory itself
 * so a consumer that owns its own composition (a future supervisor, the loop's
 * tests) can build one without the SQLite/worktree wiring. Nothing else may
 * deep-import this module's services.
 */
export { createGoalsModule } from './goals.module.js';
export { createGoalDriver } from './goal-driver.service.js';
export type { GoalDriver, GoalDriverDeps } from './goal-driver.service.js';
// The lifecycle service and round runner as TYPES only: the MCP gateway's goal
// tools name them in their deps bag and call them through the instance the
// composition root hands in, so no consumer constructs a second one.
export type { GoalsService } from './goals.service.js';
export type { RunRoundResult } from './run-round.js';
