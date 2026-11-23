import { goalsDb, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { sendDesktopAlert } from '@/modules/notifications/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

import { computeWorktreeDigest } from './diff-digest.js';
import type { GoalDriverDeps } from './goal-driver.service.js';
import { createGoalDriver } from './goal-driver.service.js';
import { createGoalsRouter } from './goals.routes.js';
import { createGoalsService, type GoalsDb } from './goals.service.js';
import { runCriterion } from './criterion-runner.service.js';
import { ensureGoalWorktree, mergeGoalWorktree } from './goal-worktree.service.js';
import { verifyRedFirst } from './red-first.js';
import { runGoalRound } from './run-round.js';

/**
 * Composes the goals module: the goals store, the criterion runner, the goal
 * worktree, the red-first check, the session a goal drives, and the resident
 * driver that keeps an active goal looping — wired into one router and one
 * driver lifecycle that `server/index.ts` owns.
 *
 * This is the module's composition root: it is the only place that combines the
 * concrete repositories and processes with the independently testable service.
 *
 * `sendToSession` is injected because the ONE chat control service is built in
 * `server/index.ts` before any module router is mounted; the driver must send
 * through that same instance, exactly as a person's composer does.
 */
export function createGoalsModule(options: {
  sendToSession: GoalDriverDeps['sendToSession'];
}) {
  const now = () => new Date();

  // `goalsDb` owns the goals tables; the project DIRECTORY has to come from the
  // Projects repository because a goal row stores only the project id.
  const db: GoalsDb = {
    ...goalsDb,
    getProjectPath: (projectId: string) => projectsDb.getProjectPathById(projectId),
  };

  const service = createGoalsService({
    db,
    runCriterion,
    ensureGoalWorktree,
    verifyRedFirst,
    // The goal's session is a normal app session row pointed at the goal
    // worktree; the loop later drives it through the same send path as a person.
    createAppSession: (sessionId, provider, projectPath, customName) =>
      sessionsDb.createAppSession(sessionId, provider, projectPath, customName),
    now,
  });

  // One round runner for both callers: the manual endpoint and the driver must
  // record rounds identically, or the budget's round count would depend on who
  // ran the round.
  const runRound = (goalId: string) =>
    runGoalRound(goalId, {
      db,
      runCriterion,
      mergeGoalWorktree,
      computeDiffDigest: computeWorktreeDigest,
      now,
    });

  const router = createGoalsRouter({ service, runRound });

  const driver = createGoalDriver({
    listActiveGoals: () => db.listGoalsByStatus('active'),
    listRounds: (goalId) => goalsDb.listRounds(goalId),
    runRound,
    sendToSession: options.sendToSession,
    // The session is busy exactly while a turn is running: a goal must never
    // queue a second round into a session still working on the first one.
    isSessionBusy: (sessionId) => chatRunRegistry.getRun(sessionId)?.status === 'running',
    updateGoal: (id, patch) => goalsDb.updateGoal(id, patch),
    // The goal's terminal transition reaches the same off-browser channel the
    // awaiting-reply alerts use, so a loop that finishes while nobody is looking
    // is not silent.
    notifyGoal: ({ goal, status, reason }) => {
      sendDesktopAlert({
        sessionId: goal.sessionId ?? undefined,
        title: `CloudCLI · Goal ${status}`,
        body: `${goal.title} — ${reason}`.slice(0, 180),
      });
    },
    now,
    log: (message) => console.log(`[Goals] ${message}`),
  });

  return {
    router,
    /** The one lifecycle service this module owns; the MCP goal tools answer from it. */
    service,
    /** The one round runner the manual endpoint and the driver share; the MCP goal tools reuse it. */
    runRound,
    /** Starts polling the active goals; idempotent while already started. */
    startDriver: () => driver.start(),
    /** Stops the poll; a round already in flight finishes on its own. */
    stopDriver: () => driver.stop(),
  };
}
