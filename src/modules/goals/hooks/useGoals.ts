import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { LLMProvider } from '@/shared/types';

import {
  createGoalsController,
  type CreateGoalInput,
  type GoalsController,
  type GoalsNotice,
  type GoalsPanelView,
  type GoalView,
} from '@/modules/goals/utils/goalsController';

export type { CreateGoalInput, GoalsNotice, GoalsPanelView, GoalView };

/** What `GoalPanel` receives from its hook: the snapshot plus the controller's commands. */
type UseGoalsResult = {
  view: GoalsPanelView;
  /** Re-reads the list and every goal's detail, showing the loading branch (the Refresh button). */
  refresh: () => void;
  /** The goal whose lifecycle action is in flight, so its buttons can be disabled; `null` when idle. */
  pendingGoalId: string | null;
  /**
   * The last action's refusal or failure. An activation refusal (a criterion already passes) is a
   * successful answer and carries the green AC ids rather than being thrown.
   */
  notice: GoalsNotice | null;
  createGoal: (input: CreateGoalInput) => Promise<string | null>;
  /** Starts the loop; the provider names the CLI the goal's own session is created with. */
  activate: (goalId: string, provider: LLMProvider) => Promise<void>;
  pause: (goalId: string) => Promise<void>;
  resume: (goalId: string) => Promise<void>;
  abandon: (goalId: string) => Promise<void>;
  runRound: (goalId: string) => Promise<void>;
};

/**
 * The React binding over {@link createGoalsController}: the controller owns every rule (request
 * ordering, polling, retry, in-flight guards); this hook only creates it once, hands it the
 * current scope, subscribes to its snapshot and disposes it on unmount.
 *
 * Used by `GoalPanel`.
 */
export function useGoals(projectId: string, projectPath: string, isActive: boolean): UseGoalsResult {
  const controller = useMemo<GoalsController>(
    () => createGoalsController({ api: api.goals, readJson: readApiJson }),
    [],
  );

  useEffect(() => {
    controller.setInput({ projectId, projectPath, isActive });
  }, [controller, projectId, projectPath, isActive]);

  useEffect(() => () => controller.dispose(), [controller]);

  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);

  return {
    view: snapshot.view,
    refresh: controller.refresh,
    pendingGoalId: snapshot.pendingGoalId,
    notice: snapshot.notice,
    createGoal: controller.createGoal,
    activate: controller.activate,
    pause: controller.pause,
    resume: controller.resume,
    abandon: controller.abandon,
    runRound: controller.runRound,
  };
}
