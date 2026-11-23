import type {
  CreateGoalAcRequest,
  CreateGoalRequest,
  Goal,
  GoalAc,
  GoalActivationResult,
  GoalBudget,
  GoalDetail,
  GoalEvidence,
  GoalRound,
} from '@/shared/goalLoopType';
import type { LLMProvider } from '@/shared/types';
import { createExternalStore } from '@/shared/utils';

/**
 * How often a running goal is re-read. Only an `active` goal polls: a draft, paused, stalled,
 * achieved or abandoned goal changes only when this panel (or another person) acts on it, and
 * polling it would be a request per open tab that can never observe anything new.
 */
const DEFAULT_POLL_INTERVAL_MS = 5_000;

/**
 * One goal joined with the detail read its card and expanded body draw: the ACs for the progress
 * reading, the rounds for the timeline, and the latest evidence per criterion the AC rows render.
 */
export type GoalView = {
  goal: Goal;
  acs: GoalAc[];
  rounds: GoalRound[];
  /** Latest reading per AC id, keyed by `GoalAc.id`; empty when no detail reading carried evidence. */
  latestEvidence: Record<string, GoalEvidence>;
};

/** The three states `GoalPanel` renders; a discriminated union so an error and a list cannot coexist. */
export type GoalsPanelView =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; goals: GoalView[] };

/**
 * What the panel shows under the header when the last action refused or failed. A red-first
 * activation refusal is a SUCCESSFUL answer (200) that names the criteria which already pass, so
 * it is reported with those ids rather than as an error page.
 */
export type GoalsNotice =
  | { kind: 'refusal'; message: string; greenAcIds: string[] }
  | { kind: 'error'; message: string };

/** What the panel renders: the list (or why there is no list), the busy goal and the last notice. */
export type GoalsSnapshot = {
  view: GoalsPanelView;
  /** The goal whose lifecycle action is in flight, so its buttons can be disabled; `null` when idle. */
  pendingGoalId: string | null;
  notice: GoalsNotice | null;
};

/** What the authoring form submits: the goal's own fields, its criteria, and an optional budget. */
export type CreateGoalInput = {
  title: string;
  objective: string;
  acs: CreateGoalAcRequest[];
  /** Only the limits the person filled in; omitted or missing fields keep the server's defaults. */
  budget?: Partial<GoalBudget>;
};

/** The scope one panel is bound to: the selected project and whether its tab is on screen. */
export type GoalsInput = {
  projectId: string;
  /** The project directory activation resolves into the goal worktree. */
  projectPath: string;
  /** True while the Goals tab is on screen; a hidden tab stops polling. */
  isActive: boolean;
};

/** The nine REST verbs the controller calls; injected so the rules are testable without React. */
export type GoalsApi = {
  list: (projectId: string) => Promise<Response>;
  detail: (goalId: string) => Promise<Response>;
  create: (input: CreateGoalRequest) => Promise<Response>;
  addAc: (goalId: string, input: CreateGoalAcRequest) => Promise<Response>;
  activate: (goalId: string, provider: LLMProvider) => Promise<Response>;
  pause: (goalId: string) => Promise<Response>;
  resume: (goalId: string) => Promise<Response>;
  abandon: (goalId: string) => Promise<Response>;
  runRound: (goalId: string) => Promise<Response>;
};

/** The timer seam; injected so a test can drive the poll without sleeping. */
export type GoalsTimers = {
  setInterval: (handler: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
};

/** What `createGoalsController` needs. `api` and `readJson` are the only transport seam. */
export type GoalsControllerDeps = {
  api: GoalsApi;
  /** Reads a success envelope's payload out of a `Response`. */
  readJson: <T>(response: Response) => Promise<T>;
  pollIntervalMs?: number;
  timers?: GoalsTimers;
};

/** The controller's public surface: one snapshot plus the commands that change it. */
export type GoalsController = {
  getSnapshot: () => GoalsSnapshot;
  subscribe: (listener: () => void) => () => void;
  /** Hands the current project/tab scope to the controller; a new scope (or tab) re-reads. */
  setInput: (input: GoalsInput) => void;
  /** Re-reads the list and every goal's detail, showing the loading branch (the Refresh button). */
  refresh: () => void;
  createGoal: (input: CreateGoalInput) => Promise<string | null>;
  /** Starts the loop; the provider names the CLI the goal's own session is created with. */
  activate: (goalId: string, provider: LLMProvider) => Promise<void>;
  pause: (goalId: string) => Promise<void>;
  resume: (goalId: string) => Promise<void>;
  abandon: (goalId: string) => Promise<void>;
  runRound: (goalId: string) => Promise<void>;
  /** Stops the poll; called when the panel unmounts. */
  dispose: () => void;
};

/**
 * The envelope `createApiSuccessResponse` writes. `ok` is tolerated because older routes answer
 * it; the payload is always under `data`.
 */
type GoalEnvelope<TData> = { success?: boolean; ok?: boolean; data: TData };

/** Reads the payload out of a success envelope, or the bare body when one is already bare. */
function unwrapData<TData>(body: GoalEnvelope<TData> | TData): TData {
  if (body !== null && typeof body === 'object' && 'data' in (body as Record<string, unknown>)) {
    return (body as GoalEnvelope<TData>).data;
  }
  return body as TData;
}

/** Folds one goal's evidence rows into "the newest reading per AC". */
function latestEvidenceByAc(evidence: GoalEvidence[]): Record<string, GoalEvidence> {
  const latest: Record<string, GoalEvidence> = {};
  for (const row of evidence) {
    const previous = latest[row.acId];
    // Rows arrive oldest-first from the store; comparing timestamps keeps the reading correct
    // even if the server ever sends them in another order.
    if (previous === undefined || previous.at <= row.at) {
      latest[row.acId] = row;
    }
  }
  return latest;
}

/** Joins a goal with its detail reading, degrading to "no ACs / no rounds" when the detail read failed. */
function toGoalView(goal: Goal, detail: GoalDetail | null): GoalView {
  return {
    goal,
    acs: detail?.acs ?? [],
    rounds: detail?.rounds ?? [],
    latestEvidence: latestEvidenceByAc(detail?.evidence ?? []),
  };
}

/** The default timer seam: the browser's own `setInterval`, resolved at call time so test fakes apply. */
const defaultTimers: GoalsTimers = {
  setInterval: (handler, ms) => globalThis.setInterval(handler, ms) as unknown,
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>),
};

/** The sentence an unexpected rejection turns into when the error carries no message. */
function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Owns the Goals tab's reading and every rule behind it: the project's goals, each one's ACs and
 * rounds, the five lifecycle actions, the stale-answer guard, and the 5-second poll that runs
 * only while a goal is `active` AND the tab is on screen.
 *
 * The component layer only renders {@link getSnapshot} and forwards clicks. Every load is tagged
 * with a request id, so a slow reply for a project the user already switched away from cannot
 * overwrite the current project's view. A failed poll keeps the previous list on screen; only a
 * failure before the first reading is the panel's error state.
 *
 * Used by `useGoals` (the React binding) and by `GoalPanel`.
 */
export function createGoalsController(deps: GoalsControllerDeps): GoalsController {
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timers = deps.timers ?? defaultTimers;
  const store = createExternalStore<GoalsSnapshot>({
    view: { status: 'loading' },
    pendingGoalId: null,
    notice: null,
  });

  let input: GoalsInput = { projectId: '', projectPath: '', isActive: false };
  let requestId = 0;
  let pollHandle: unknown = null;
  let disposed = false;

  const stopPolling = (): void => {
    if (pollHandle === null) return;
    timers.clearInterval(pollHandle);
    pollHandle = null;
  };

  const startPolling = (): void => {
    if (pollHandle !== null || disposed) return;
    pollHandle = timers.setInterval(() => {
      void load(false);
    }, pollIntervalMs);
  };

  /** Starts or stops the poll from the current snapshot and scope; the only writer of `pollHandle`. */
  const syncPolling = (): void => {
    const { view } = store.getSnapshot();
    const hasActiveGoal = view.status === 'loaded' && view.goals.some((item) => item.goal.status === 'active');
    if (!disposed && input.isActive && input.projectId !== '' && hasActiveGoal) {
      startPolling();
    } else {
      stopPolling();
    }
  };

  /** Reads the list, then each goal's detail; a failed detail leaves that card readable. */
  const load = async (showLoading: boolean): Promise<void> => {
    if (input.projectId === '') return;

    const currentRequestId = requestId + 1;
    requestId = currentRequestId;
    if (showLoading) {
      store.update((snapshot) => ({ ...snapshot, view: { status: 'loading' } }));
    }

    try {
      const listBody = await deps.readJson<GoalEnvelope<Goal[]>>(await deps.api.list(input.projectId));
      const goals = unwrapData(listBody) ?? [];

      const details = await Promise.all(
        goals.map(async (goal): Promise<GoalDetail | null> => {
          try {
            return unwrapData(await deps.readJson<GoalEnvelope<GoalDetail>>(await deps.api.detail(goal.id)));
          } catch {
            return null;
          }
        }),
      );

      if (requestId !== currentRequestId) return;
      store.update((snapshot) => ({
        ...snapshot,
        view: { status: 'loaded', goals: goals.map((goal, index) => toGoalView(goal, details[index])) },
      }));
      syncPolling();
    } catch (error) {
      if (requestId !== currentRequestId) return;
      // A poll that fails after a good reading must not blank the tab; the same failure before
      // the first reading is the only one that is a page state.
      if (showLoading) {
        store.update((snapshot) => ({
          ...snapshot,
          view: { status: 'error', message: failureMessage(error, 'Failed to load goals') },
        }));
        stopPolling();
      } else {
        store.update((snapshot) => ({
          ...snapshot,
          notice: { kind: 'error', message: failureMessage(error, 'Failed to refresh goals') },
        }));
      }
    }
  };

  /** Runs one lifecycle verb, then re-reads; a refusal/HTTP error lands in `notice`. */
  const runAction = async (goalId: string, action: () => Promise<Response>): Promise<void> => {
    store.update((snapshot) => ({ ...snapshot, pendingGoalId: goalId, notice: null }));
    try {
      const data = unwrapData(await deps.readJson<GoalEnvelope<GoalActivationResult | Goal>>(await action()));
      // Activation answers 200 with `{ refusal, greenAcIds }` when a criterion already passes:
      // the call worked, the goal just cannot start. The other verbs answer the goal row, which
      // never carries a `refusal`.
      const refusal = (data as GoalActivationResult | null)?.refusal;
      if (typeof refusal === 'string' && refusal !== '') {
        const greenAcIds = (data as GoalActivationResult | null)?.greenAcIds ?? [];
        store.update((snapshot) => ({ ...snapshot, notice: { kind: 'refusal', message: refusal, greenAcIds } }));
      }
      await load(false);
    } catch (error) {
      store.update((snapshot) => ({
        ...snapshot,
        notice: { kind: 'error', message: failureMessage(error, 'The goal action failed') },
      }));
    } finally {
      store.update((snapshot) => ({ ...snapshot, pendingGoalId: null }));
    }
  };

  const setInput = (next: GoalsInput): void => {
    const projectChanged = next.projectId !== input.projectId;
    const reentered = next.isActive && !input.isActive;
    const projectPathChanged = next.projectPath !== input.projectPath;
    input = next;

    if (projectChanged) {
      // A new project's list is not the previous project's list: clear the reading rather than
      // letting the old goal cards show under the new project while the first read is in flight.
      stopPolling();
      store.update(() => ({ view: { status: 'loading' }, pendingGoalId: null, notice: null }));
    }

    const shouldReload = input.isActive && input.projectId !== '' && (projectChanged || reentered || projectPathChanged);
    if (shouldReload) {
      void load(true);
      return;
    }
    // A hidden tab stops polling; returning re-runs the reload branch above.
    syncPolling();
  };

  const refresh = (): void => {
    void load(true);
  };

  const createGoal = async (goalInput: CreateGoalInput): Promise<string | null> => {
    store.update((snapshot) => ({ ...snapshot, notice: null }));
    try {
      // AC ids are minted by the server (`<goalId>-AC-00N`), so the exit conditions cannot be
      // named at creation time; activation still refuses a goal with no runnable criterion.
      const request: CreateGoalRequest = {
        projectId: input.projectId,
        projectPath: input.projectPath,
        title: goalInput.title.trim(),
        objective: goalInput.objective.trim(),
        exitConditions: [],
        // Omitted entirely when the person left every limit blank, so the store's own defaults
        // apply rather than a copy of them kept here.
        ...(goalInput.budget === undefined ? {} : { budget: goalInput.budget }),
      };
      const goal = unwrapData(await deps.readJson<GoalEnvelope<Goal>>(await deps.api.create(request)));

      for (const [index, ac] of goalInput.acs.entries()) {
        try {
          await deps.readJson(await deps.api.addAc(goal.id, ac));
        } catch (error) {
          const reason = failureMessage(error, String(error));
          throw new Error(`Goal "${goal.title}" was created, but criterion ${index + 1} was not saved: ${reason}`);
        }
      }

      await load(false);
      return goal.id;
    } catch (error) {
      store.update((snapshot) => ({
        ...snapshot,
        notice: { kind: 'error', message: failureMessage(error, 'Failed to create the goal') },
      }));
      return null;
    }
  };

  return {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    setInput,
    refresh,
    createGoal,
    activate: (goalId, provider) => runAction(goalId, () => deps.api.activate(goalId, provider)),
    pause: (goalId) => runAction(goalId, () => deps.api.pause(goalId)),
    resume: (goalId) => runAction(goalId, () => deps.api.resume(goalId)),
    abandon: (goalId) => runAction(goalId, () => deps.api.abandon(goalId)),
    runRound: (goalId) => runAction(goalId, () => deps.api.runRound(goalId)),
    dispose: () => {
      disposed = true;
      stopPolling();
    },
  };
}
