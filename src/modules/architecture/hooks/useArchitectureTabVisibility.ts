import { useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { AppTab, Project } from '@/shared/types';

/**
 * The architecture tab's Tier-1 gate (ADR-005 decision 1): only a project the
 * listing marked `hasArchguardCache` — i.e. one carrying
 * `.archguard/query/manifest.json` — offers the view. Kept as a pure function so
 * `WorkspaceMain` and its test read the same rule instead of restating
 * `Boolean(project?.hasArchguardCache)`.
 */
export const isArchitectureTabVisible = (project: Project | null): boolean =>
  Boolean(project?.hasArchguardCache);

/**
 * Closes the architecture tab when the selected project no longer offers it.
 *
 * Mirrors WorkspaceMain's Tasks/Browser/Quay guards: a tab that is no longer in
 * the list must not stay the active view, so a project switch — or a Tier-1
 * reading that flips to false — snaps back to chat rather than leaving an
 * unreachable pane mounted.
 */
export function useEnsureArchitectureTabVisible(
  shouldShowArchitectureTab: boolean,
  activeTab: AppTab,
  setActiveTab: Dispatch<SetStateAction<AppTab>>,
): void {
  useEffect(() => {
    if (!shouldShowArchitectureTab && activeTab === 'architecture') {
      setActiveTab('chat');
    }
  }, [shouldShowArchitectureTab, activeTab, setActiveTab]);
}
