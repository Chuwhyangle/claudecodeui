import type { Project } from '@/shared/types';

export type ProjectSelectionMetadata = Pick<
  Project,
  'projectId' | 'displayName' | 'fullPath' | 'path' | 'isStarred' | 'taskmaster' | 'hasQuayConfig' | 'hasArchguardCache'
>;

const valuesMatch = (left: unknown, right: unknown): boolean => (
  Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right)
);

/**
 * Keep the project object consumed by the main workspace independent from the
 * sidebar's paginated session list. Session-only updates stay in `projects`;
 * this selected value changes only when workspace metadata changes.
 */
export function mergeProjectSelectionMetadata(
  current: Project,
  incoming: ProjectSelectionMetadata,
): Project {
  if (current.projectId !== incoming.projectId) {
    return current;
  }

  const nextPath = incoming.path ?? current.path;
  const nextIsStarred = incoming.isStarred ?? current.isStarred;
  const nextTaskmaster = incoming.taskmaster ?? current.taskmaster;
  // `??` (not `Boolean(...) ??`) so an incoming `false` overrides a stale
  // `true`: a project that gains or loses `.quay/config.yml` while the app is
  // open must flip the Quay tab without a project re-select. An *absent* field
  // (the `session_upserted` project block omits it) keeps the current value, so
  // that existing caller can never clear a live reading.
  const nextHasQuayConfig = incoming.hasQuayConfig ?? current.hasQuayConfig;
  // Same `??` semantics as `hasQuayConfig`: an incoming `false` flips the
  // architecture tab off when the project loses `.archguard/query/manifest.json`.
  const nextHasArchguardCache = incoming.hasArchguardCache ?? current.hasArchguardCache;

  if (
    current.displayName === incoming.displayName
    && current.fullPath === incoming.fullPath
    && current.path === nextPath
    && current.isStarred === nextIsStarred
    && valuesMatch(current.taskmaster, nextTaskmaster)
    && current.hasQuayConfig === nextHasQuayConfig
    && current.hasArchguardCache === nextHasArchguardCache
  ) {
    return current;
  }

  return {
    ...current,
    displayName: incoming.displayName,
    fullPath: incoming.fullPath,
    path: nextPath,
    isStarred: nextIsStarred,
    taskmaster: nextTaskmaster,
    hasQuayConfig: nextHasQuayConfig,
    hasArchguardCache: nextHasArchguardCache,
  };
}
