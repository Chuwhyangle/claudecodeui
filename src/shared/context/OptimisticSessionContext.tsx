import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

import type { LLMProvider, Project } from '@/shared/types';

/** The session a surface just created, as the workspace's project state registers it. */
export type OptimisticSessionRegistration = {
  sessionId: string;
  provider: LLMProvider;
  project: Project;
  summary?: string | null;
};

/**
 * The shared seam between the workspace's project state and the cockpit's card list.
 *
 * The workspace owns the project list and the optimistic-registration write; the cockpit's
 * cards list is the surface that starts a conversation and wants the new row to appear
 * before the next read. They must not import each other — the cockpit importing
 * `@/modules/project-workspace` and the workspace importing `@/modules/cockpit` is exactly the
 * feature-level cycle the frontend import-cycle ratchet pins — so the workspace *provides* this
 * narrow value and the cockpit *reads* it optionally. A cockpit surface mounted outside the
 * provider (the standalone page, the phone overlay) reads `null` and simply navigates without
 * registering.
 */
export type OptimisticSessionSeam = {
  projects: readonly Project[];
  registerOptimisticSession: (registration: OptimisticSessionRegistration) => void;
};

const OptimisticSessionContext = createContext<OptimisticSessionSeam | null>(null);

/** Provides the seam from the workspace's project state. The value must be memoized by the caller. */
export function OptimisticSessionProvider({
  seam,
  children,
}: {
  seam: OptimisticSessionSeam;
  children: ReactNode;
}) {
  return <OptimisticSessionContext.Provider value={seam}>{children}</OptimisticSessionContext.Provider>;
}

/** The seam when a `ProjectsStateProvider` is above this component, `null` otherwise. */
export function useOptionalOptimisticSession(): OptimisticSessionSeam | null {
  return useContext(OptimisticSessionContext);
}
