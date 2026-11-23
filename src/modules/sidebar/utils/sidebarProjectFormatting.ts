import type { TFunction } from 'i18next';

import type {
  LLMProvider,
  Project,
  ProjectSession,
  ProjectSortOrder,
  QuayDriverState,
  SessionWithProvider,
  SettingsProject,
} from '@/shared/types';
import { groupSessionsByLineage } from '@/modules/sidebar/utils/groupSessionsByLineage';

// Presentation data the sidebar derives from a session before rendering its row.
type SessionViewModel = {
  isActive: boolean;
  sessionName: string;
  sessionTime: string;
  messageCount: number;
};

export const formatCompactAge = (
  dateString: string | null | undefined,
  currentTime: Date,
): string => {
  if (!dateString) return '';

  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return '';

  const minutes = Math.floor(Math.max(0, currentTime.getTime() - date.getTime()) / 60000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}hr` : `${Math.floor(hours / 24)}d`;
};

const getCreatedTimestamp = (session: SessionWithProvider): string => {
  return String(session.createdAt || session.created_at || '');
};

const getUpdatedTimestamp = (session: SessionWithProvider): string => {
  return String(session.lastActivity || '');
};

const getSessionProvider = (session: ProjectSession): LLMProvider => {
  const provider = session.__provider ?? session.provider;
  return typeof provider === 'string' && provider.trim()
    ? provider as LLMProvider
    : 'claude';
};

const getSessionDate = (session: SessionWithProvider): Date => {
  return new Date(getUpdatedTimestamp(session) || getCreatedTimestamp(session) || 0);
};

const getSessionName = (session: SessionWithProvider, t: TFunction): string => {
  return session.summary || session.name || t('projects.newSession');
};

const getSessionTime = (session: SessionWithProvider): string => {
  return getUpdatedTimestamp(session) || getCreatedTimestamp(session);
};

export const createSessionViewModel = (
  session: SessionWithProvider,
  currentTime: Date,
  t: TFunction,
): SessionViewModel => {
  const sessionDate = getSessionDate(session);
  const diffInMinutes = Math.floor((currentTime.getTime() - sessionDate.getTime()) / (1000 * 60));

  return {
    isActive: diffInMinutes < 10,
    sessionName: getSessionName(session, t),
    sessionTime: getSessionTime(session),
    messageCount: Number(session.messageCount || 0),
  };
};

/**
 * Cached against the project object, not its id.
 *
 * Every sidebar render asks for each project's sessions, and this builds a new
 * array of new session objects. Without the cache the array is a different
 * reference each time, which is enough on its own to defeat the memo boundary
 * on every project and session row. `useProjectsState` always replaces a
 * project rather than mutating it, so a stale entry is unreachable: a changed
 * project is a different key.
 */
const sortedSessionsByProject = new WeakMap<Project, SessionWithProvider[]>();

export const getAllSessions = (project: Project): SessionWithProvider[] => {
  const cached = sortedSessionsByProject.get(project);
  if (cached) {
    return cached;
  }

  // Grouped after sorting, not before: grouping reads the final rank to decide
  // which slot a lineage group takes, so it has to see the order the reader
  // will see.
  //
  // The order is the user's own where there is one: rows the user dragged carry
  // a `sessionOrder` and sort by it, so no amount of activity elsewhere moves
  // them again. Rows without one — a session created after the list was
  // arranged, or a project never arranged at all — sit above the arranged block
  // in recency order. That is what keeps a brand-new session visible at the top
  // instead of inheriting a position the user never chose for it.
  const sessions = groupSessionsByLineage(
    (project.sessions || []).map((session) => ({
      ...session,
      __provider: getSessionProvider(session),
    })).sort((a, b) => {
      const aOrder = typeof a.sessionOrder === 'number' ? a.sessionOrder : null;
      const bOrder = typeof b.sessionOrder === 'number' ? b.sessionOrder : null;

      if (aOrder === null && bOrder === null) {
        return getSessionDate(b).getTime() - getSessionDate(a).getTime();
      }
      if (aOrder === null) {
        return -1;
      }
      if (bOrder === null) {
        return 1;
      }
      if (aOrder !== bOrder) {
        return aOrder - bOrder;
      }
      // Equal positions should not happen (the server renumbers every row it
      // stores), but a stale optimistic overlay can produce one for a moment;
      // recency is the least surprising way to break the tie.
      return getSessionDate(b).getTime() - getSessionDate(a).getTime();
    }),
    (session) => session.id,
  );

  sortedSessionsByProject.set(project, sessions);
  return sessions;
};

const getProjectLastActivity = (project: Project): Date => {
  const sessions = getAllSessions(project);
  if (sessions.length === 0) {
    return new Date(0);
  }

  return sessions.reduce((latest, session) => {
    const sessionDate = getSessionDate(session);
    return sessionDate > latest ? sessionDate : latest;
  }, new Date(0));
};

export const sortProjects = (
  projects: Project[],
  projectSortOrder: ProjectSortOrder,
): Project[] => {
  const byName = [...projects];

  byName.sort((projectA, projectB) => {
    // Star order now comes from backend `projects.isStarred`.
    const aStarred = Boolean(projectA.isStarred);
    const bStarred = Boolean(projectB.isStarred);

    if (aStarred && !bStarred) {
      return -1;
    }

    if (!aStarred && bStarred) {
      return 1;
    }

    if (projectSortOrder === 'date') {
      return getProjectLastActivity(projectB).getTime() - getProjectLastActivity(projectA).getTime();
    }

    return (projectA.displayName || projectA.projectId).localeCompare(projectB.displayName || projectB.projectId);
  });

  return byName;
};

export const filterProjects = (projects: Project[], searchFilter: string): Project[] => {
  const normalizedSearch = searchFilter.trim().toLowerCase();
  if (!normalizedSearch) {
    return projects;
  }

  return projects.filter((project) => {
    const displayName = (project.displayName || project.projectId).toLowerCase();
    // `project.path`/`fullPath` is the most useful search target now that the
    // folder-derived name is gone; fall back to displayName above.
    const searchPath = (project.path || project.fullPath || '').toLowerCase();
    return displayName.includes(normalizedSearch) || searchPath.includes(normalizedSearch);
  });
};

export const getTaskIndicatorStatus = (
  project: Project,
  mcpServerStatus: { hasMCPServer?: boolean; isConfigured?: boolean } | null,
) => {
  const projectConfigured = Boolean(project.taskmaster?.hasTaskmaster);
  const mcpConfigured = Boolean(mcpServerStatus?.hasMCPServer && mcpServerStatus?.isConfigured);

  if (projectConfigured && mcpConfigured) {
    return 'fully-configured';
  }

  if (projectConfigured) {
    return 'taskmaster-only';
  }

  if (mcpConfigured) {
    return 'mcp-only';
  }

  return 'not-configured';
};

/**
 * Resolves the sidebar Quay indicator's state.
 *
 * Tier 1 (`hasQuayConfig`) decides whether the badge exists at all; the driver
 * reading is only known for a project whose snapshot has been fetched, so an
 * absent snapshot leaves a configured project at `idle` rather than inventing a
 * running/stale state the sidebar never observed.
 *
 * `unavailable` is the one driver state that passes through as-is: it is an
 * *observed* failed read (the snapshot exists and its driver command did not
 * answer), which is neither an absent snapshot nor a driver claim.
 */
export const getQuayIndicatorStatus = (
  project: Project,
  quayStatus: { driver?: { state?: QuayDriverState } } | null,
): QuayDriverState => {
  if (!project.hasQuayConfig) {
    return 'not-configured';
  }

  const driverState = quayStatus?.driver?.state;
  if (
    driverState === 'running'
    || driverState === 'stale'
    || driverState === 'idle'
    || driverState === 'unavailable'
  ) {
    return driverState;
  }

  return 'idle';
};

export const normalizeProjectForSettings = (project: Project): SettingsProject => {
  const fallbackPath =
    typeof project.fullPath === 'string' && project.fullPath.length > 0
      ? project.fullPath
      : typeof project.path === 'string'
        ? project.path
        : '';

  // Legacy SettingsProject still expects a `name` field; use the projectId so
  // downstream consumers that rely on a stable identifier continue to work.
  return {
    name: project.projectId,
    displayName:
      typeof project.displayName === 'string' && project.displayName.trim().length > 0
        ? project.displayName
        : project.projectId,
    fullPath: fallbackPath,
    path:
      typeof project.path === 'string' && project.path.length > 0
        ? project.path
        : fallbackPath,
  };
};

/**
 * Display names for the providers a session row can belong to.
 *
 * The four product ids stay *required*, so renaming or adding one is still a
 * compile error here, while the index signature admits an id the product's
 * union deliberately does not carry (`LLMProvider` is what settings, model menus
 * and compile-time exhaustive maps are written against). A session from such a
 * provider must still render a real name: the row's provider slot is the only
 * place a reader learns whose session they are looking at, and a missing entry
 * would leave that slot showing a raw id.
 */
export type ProviderLabels = Record<LLMProvider, string> & Record<string, string>;

export const PROVIDER_LABELS: ProviderLabels = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  debug: 'Debug Agent',
};
