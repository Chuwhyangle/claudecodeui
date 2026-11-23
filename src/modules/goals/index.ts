/**
 * Goals module — barrel.
 *
 * The workspace's「Goals」tab: the goal loop's own write surface (create a goal, author
 * acceptance criteria, activate/pause/resume/abandon it and run one round). It is deliberately
 * distinct from `modules/quay`, which mirrors an external quay project read-only
 * (docs/proposals/goal-loop.md §8).
 */
export { GoalPanel } from '@/modules/goals/GoalPanel';
