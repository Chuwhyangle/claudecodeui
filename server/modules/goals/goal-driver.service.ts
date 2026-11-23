import type { Goal, GoalRound, GoalStatus } from '@/shared/types.js';

import type { RunRoundResult } from './run-round.js';

// --------------------------- Resident goal driver ------------

/**
 * How often the driver looks at the active goals.
 *
 * One tick may run criterion commands (up to 120s each) and a full agent turn,
 * so this is the reopen delay, not the round's duration: a goal whose session is
 * still busy is skipped without doing anything, and the next tick picks it up
 * once the turn ends.
 */
const DEFAULT_INTERVAL_MS = 30_000;

/**
 * What the driver needs to keep a goal looping.
 *
 * Every member is injected so a test can drive the whole loop — budgets, the
 * busy-session wait, the send, the exit conditions — with fakes, and never touch
 * SQLite, git, a provider process, or a real session.
 */
export type GoalDriverDeps = {
  /** The goals currently looping; the driver's own poll is the only input to it. */
  listActiveGoals: () => Goal[];
  /** A goal's rounds, oldest first; its length is the round count for the budget. */
  listRounds: (goalId: string) => GoalRound[];
  /** Runs one round: criteria, evidence, outcome, and the prompt for a red round. */
  runRound: (goalId: string) => Promise<RunRoundResult>;
  /**
   * Hands one round's prompt to the goal's bound session. Failure is a value
   * (`ok: false`), so a refused send is a retry on the next tick rather than a
   * crashed loop.
   */
  sendToSession: (input: {
    userId: number;
    sessionId: string;
    content: string;
  }) => Promise<{ ok: boolean; code?: string; message?: string }>;
  /** Whether the session still has a running turn; a busy session is skipped. */
  isSessionBusy: (sessionId: string) => boolean;
  /** Persists a lifecycle flip the driver decided (paused / stalled). */
  updateGoal: (id: string, patch: { status?: GoalStatus; achievedAt?: string | null }) => Goal | null;
  /**
   * Reports a terminal flip (achieved / stalled / paused) to the person who
   * started the goal. Optional so a test drives the loop without a channel;
   * production wires the off-browser desktop toast.
   */
  notifyGoal?: (input: { goal: Goal; status: GoalStatus; reason: string }) => void;
  now: () => Date;
  /** Poll interval; defaults to {@link DEFAULT_INTERVAL_MS}. */
  intervalMs?: number;
  /** Where the driver's decisions are reported; defaults to `console.log`. */
  log?: (message: string) => void;
};

/**
 * The resident loop's handle.
 *
 * `tick` is public so a test (and an operator) can drive exactly one pass
 * without waiting for the timer; `start`/`stop` own the interval.
 */
export type GoalDriver = {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
  readonly running: boolean;
};

/**
 * Creates the driver that makes a goal loop by itself (docs/proposals/goal-loop.md
 * §4.2 / §4.3 / §5.4).
 *
 * Consumers: `goals.module.ts` (production composition, started by
 * `server/index.ts` with the rest of the server) and the module's own test.
 *
 * Per tick every active goal is handled serially and at most once:
 *   1. wall clock past `budget.maxWallClockMs` ⇒ `paused` (no round runs);
 *   2. `budget.maxRounds` rounds already recorded ⇒ `paused`;
 *   3. the bound session still has a running turn ⇒ skipped, so the agent gets
 *      to finish the round it was given;
 *   4. otherwise one round runs: green ⇒ already `achieved` (the round's own
 *      merge decides), `stalled` ⇒ `stalled`, red ⇒ the round prompt is sent to
 *      the session and the NEXT tick waits for that run to end.
 *
 * A tick never overlaps itself: a goal's round may take minutes, and a second
 * tick would run the criteria against a worktree the first one is still
 * measuring.
 */
export function createGoalDriver(deps: GoalDriverDeps): GoalDriver {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const log = deps.log ?? ((message: string) => console.log(`[Goals] ${message}`));

  let timer: NodeJS.Timeout | null = null;
  /** Guards `tick` against re-entry; the timer can fire while a round runs. */
  let inFlight = false;
  let running = false;

  /** Reports one terminal flip, containing a broken channel so it cannot stop a tick. */
  function notify(goal: Goal, status: GoalStatus, reason: string): void {
    try {
      deps.notifyGoal?.({ goal, status, reason });
    } catch (error) {
      log(`goal ${goal.id}: could not report the ${status} transition: ${errorText(error)}`);
    }
  }

  /** Pauses a goal the driver stopped; the caller's patch is the whole record. */
  function pause(goal: Goal, reason: string): void {
    deps.updateGoal(goal.id, { status: 'paused' });
    log(`goal ${goal.id} paused: ${reason}`);
    notify(goal, 'paused', reason);
  }

  /**
   * Budget check. Both limits are read from the goal as the store holds it now,
   * so a budget patched between ticks is honoured on the next tick.
   *
   * A missing `activatedAt` means the wall clock has no start to measure from;
   * the round cap still applies, and the goal is left running rather than
   * paused on a number nobody recorded.
   */
  function budgetStop(goal: Goal): string | null {
    const activatedAt = goal.activatedAt;
    if (activatedAt) {
      const startedMs = Date.parse(activatedAt);
      if (Number.isFinite(startedMs) && deps.now().getTime() - startedMs > goal.budget.maxWallClockMs) {
        return `wall-clock budget of ${goal.budget.maxWallClockMs}ms exhausted`;
      }
    }

    // Count only the rounds since the CURRENT activation. `resume` restarts the
    // clock by rewriting `activatedAt`, so a goal paused by `maxRounds` must not
    // resume into an already-exhausted budget and pause again on the next tick.
    const rounds = deps.listRounds(goal.id).filter((round) => {
      if (!activatedAt) return true;
      const startedMs = Date.parse(round.startedAt);
      const activationMs = Date.parse(activatedAt);
      return Number.isFinite(startedMs) && Number.isFinite(activationMs)
        ? startedMs >= activationMs
        : true;
    }).length;
    if (rounds >= goal.budget.maxRounds) {
      return `round budget of ${goal.budget.maxRounds} exhausted (${rounds} recorded since activation)`;
    }

    return null;
  }

  /** One goal's turn: budget, the busy-session wait, then at most one round. */
  async function tickGoal(goal: Goal): Promise<void> {
    const stopped = budgetStop(goal);
    if (stopped) {
      pause(goal, stopped);
      return;
    }

    const sessionId = goal.sessionId;
    if (sessionId && deps.isSessionBusy(sessionId)) {
      log(`goal ${goal.id} waiting: session ${sessionId} is still running its turn`);
      return;
    }

    const result = await deps.runRound(goal.id);

    // A green round has already merged and flipped the goal (`achieved`) or
    // paused it on a failed merge; either way there is nobody left to prompt.
    if (result.allGreen) {
      // A green round merges the branch and flips the goal: `achieved` when the
      // merge landed, `paused` when it conflicted. The round reports which, so
      // the driver does not have to re-read the row.
      if (result.merge?.merged) {
        log(`goal ${goal.id} is achieved after round ${result.round.seq}; merged ${result.merge.commit ?? 'the goal branch'}`);
        notify(goal, 'achieved', `all criteria passed; merged ${result.merge.commit ?? 'the goal branch'}`);
      } else {
        const reason = `all criteria passed but the merge did not land: ${result.merge?.reason ?? 'unknown reason'}`;
        log(`goal ${goal.id}: ${reason}`);
        notify(goal, 'paused', reason);
      }
      return;
    }

    if (result.stalled) {
      // `run-round` records the same flip; this keeps the driver's own decision
      // explicit and idempotent rather than relying on the round's side effect.
      deps.updateGoal(goal.id, { status: 'stalled' });
      log(`goal ${goal.id} stalled after round ${result.round.seq}: no diff and no reading changed`);
      notify(goal, 'stalled', `no diff and no criterion reading changed for ${goal.budget.maxNoProgress} rounds`);
      return;
    }

    if (!sessionId) {
      log(`goal ${goal.id} has no bound session; round ${result.round.seq} ran but nobody can be prompted`);
      return;
    }

    let sent: { ok: boolean; code?: string; message?: string };
    try {
      sent = await deps.sendToSession({
        userId: goal.userId,
        sessionId,
        content: result.prompt,
      });
    } catch (error) {
      // A throwing send is the same outcome as a refused one: the goal keeps its
      // status and the next tick retries against whatever the session is doing.
      log(`goal ${goal.id}: sending round ${result.round.seq} to session ${sessionId} threw: ${errorText(error)}`);
      return;
    }

    if (!sent.ok) {
      log(
        `goal ${goal.id}: session ${sessionId} refused round ${result.round.seq} ` +
          `(${sent.code ?? 'unknown'}${sent.message ? `: ${sent.message}` : ''}); retrying on the next tick`,
      );
      return;
    }

    log(`goal ${goal.id}: round ${result.round.seq} prompt sent to session ${sessionId}`);
  }

  /** One pass over every active goal, serially and never concurrently with itself. */
  async function tick(): Promise<void> {
    if (inFlight) return;
    inFlight = true;

    try {
      let goals: Goal[];
      try {
        goals = deps.listActiveGoals();
      } catch (error) {
        log(`could not read the active goals: ${errorText(error)}`);
        return;
      }

      for (const goal of goals) {
        // One goal's failure (a vanished row, a worktree git no longer tracks)
        // must not stop the goals behind it in the same tick.
        try {
          await tickGoal(goal);
        } catch (error) {
          log(`goal ${goal.id} failed during its tick: ${errorText(error)}`);
        }
      }
    } finally {
      inFlight = false;
    }
  }

  return {
    start() {
      if (timer) return;
      running = true;
      // Tick once immediately: a goal that was left active by a previous process
      // should not wait a whole interval before its next round.
      void tick();
      timer = setInterval(() => {
        void tick();
      }, intervalMs);
      // The driver must not hold the process open on its own account.
      timer.unref?.();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      running = false;
    },

    tick,

    get running() {
      return running;
    },
  };
}

/** One line for a caught value, without leaking a stack into the log. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
