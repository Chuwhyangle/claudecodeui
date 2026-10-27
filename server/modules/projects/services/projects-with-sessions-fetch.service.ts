import fs from 'node:fs/promises';
import path from 'node:path';

import { hasArchguardCache } from '@/modules/architecture/index.js';
import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { quayService } from '@/modules/quay/index.js';
import { readProjectsSessionFetchPort } from '@/shared/ports/projects-session-fetch.port.js';
import { AppError } from '@/shared/utils.js';
import {
  compileSessionFilter,
  compileStoredSessionFilter,
  parseStoredSessionFilter,
  validateSessionFilter,
} from '@/modules/projects/services/session-name-filter.service.js';
import type { SessionNameVisibility } from '@/modules/database/index.js';

type SessionSummary = {
  id: string;
  provider: string;
  summary: string;
  messageCount: number;
  lastActivity: string;
  /**
   * App id of the session this one was branched from, or null for a session
   * that started on its own. The sidebar renders a branch marker from it and
   * keeps a fork beside its source, instead of letting recency order split the
   * pair into two rows that read as unrelated duplicates.
   */
  forkedFromSessionId: string | null;
  /**
   * The position the user dragged this session to, or null for a session that
   * has never been part of a manual order. The sidebar sorts on it; the SQL
   * behind this page does too, so a row deep in the arranged block still lands
   * on the page it belongs to.
   */
  sessionOrder: number | null;
};

type SessionRepositoryRow = {
  provider: string;
  session_id: string;
  custom_name?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
  forked_from_session_id?: string | null;
  session_order?: number | null;
};

export type ProjectListItem = {
  projectId: string;
  path: string;
  displayName: string;
  fullPath: string;
  isStarred: boolean;
  /** Tier-1 quay reading: whether the project directory carries a `.quay/config.yml`. */
  hasQuayConfig: boolean;
  /**
   * Tier-1 architecture reading (ADR-005 decision 1): whether the project
   * carries `.archguard/query/manifest.json`. Mirrors {@link hasQuayConfig} — a
   * pure path check, never a parse — and gates the architecture tab.
   */
  hasArchguardCache: boolean;
  sessions: SessionSummary[];
  sessionMeta: {
    hasMore: boolean;
    total: number;
    hiddenCount: number;
  };
  sessionFilter: { hide: string[] } | null;
};

export type ArchivedProjectListItem = ProjectListItem & {
  isArchived: true;
};

type ProgressUpdate = {
  phase: 'loading' | 'complete';
  current: number;
  total: number;
  currentProject?: string;
};

type GetProjectsWithSessionsOptions = {
  skipSynchronization?: boolean;
  sessionsLimit?: number;
  sessionsOffset?: number;
  includeHidden?: boolean;
  keepSessionIds?: string[];
};

type SessionPaginationOptions = {
  limit?: number;
  offset?: number;
  /** Skip the project's name filter and return every session. */
  includeHidden?: boolean;
  /** Sessions that stay visible even when they match the filter (running / attention / selected). */
  keepSessionIds?: string[];
};

type ProjectSessionsPageResult = {
  sessions: SessionSummary[];
  total: number;
  hasMore: boolean;
  hiddenCount: number;
};

export type ProjectSessionsPageApiView = {
  projectId: string;
  sessions: SessionSummary[];
  sessionMeta: {
    hasMore: boolean;
    total: number;
    hiddenCount: number;
  };
  hiddenCount: number;
};

export type SessionFilterPreview = {
  matchedCount: number;
  unmatchedCount: number;
  matchedSessionNames: string[];
  unmatchedSessionNames: string[];
};

const SESSION_FILTER_PREVIEW_SAMPLE_SIZE = 5;

const DEFAULT_PROJECT_SESSIONS_PAGE_SIZE = 20;
const MAX_PROJECT_SESSIONS_PAGE_SIZE = 200;

/**
 * Generate better display name from path.
 */
export async function generateDisplayName(projectName: string, actualProjectDir: string | null = null): Promise<string> {
  // Use actual project directory if provided, otherwise decode from project name.
  const projectPath = actualProjectDir || projectName.replace(/-/g, '/');

  // Try to read package.json from the project path.
  try {
    const packageJsonPath = path.join(projectPath, 'package.json');
    const packageData = await fs.readFile(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageData) as { name?: string };

    // Return the name from package.json if it exists.
    if (packageJson.name) {
      return packageJson.name;
    }
  } catch {
    // Fall back to path-based naming if package.json doesn't exist or can't be read.
  }

  // If it starts with /, it's an absolute path.
  if (projectPath.startsWith('/')) {
    const parts = projectPath.split('/').filter(Boolean);
    // Return only the last folder name.
    return parts[parts.length - 1] || projectPath;
  }

  return projectPath;
}

function normalizeSessionPagination(options: SessionPaginationOptions = {}): { limit: number; offset: number } {
  const rawLimit = Number.isFinite(options.limit) ? Math.floor(Number(options.limit)) : DEFAULT_PROJECT_SESSIONS_PAGE_SIZE;
  const rawOffset = Number.isFinite(options.offset) ? Math.floor(Number(options.offset)) : 0;

  return {
    limit: Math.min(Math.max(1, rawLimit), MAX_PROJECT_SESSIONS_PAGE_SIZE),
    offset: Math.max(0, rawOffset),
  };
}

function mapSessionRowToSummary(row: SessionRepositoryRow): SessionSummary {
  return {
    id: row.session_id,
    provider: row.provider,
    summary: row.custom_name || '',
    messageCount: 0,
    lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
    forkedFromSessionId: row.forked_from_session_id ?? null,
    sessionOrder: typeof row.session_order === 'number' ? row.session_order : null,
  };
}

function readProjectSessionsIncludingArchived(projectPath: string): ProjectSessionsPageResult {
  const rows = sessionsDb.getSessionsByProjectPathIncludingArchived(projectPath) as SessionRepositoryRow[];

  return {
    sessions: rows.map(mapSessionRowToSummary),
    total: rows.length,
    hasMore: false,
    hiddenCount: 0,
  };
}

/** Builds the SQL visibility rule for a project, or undefined when nothing should be hidden. */
function buildSessionVisibility(
  storedFilterJson: string | null,
  options: SessionPaginationOptions,
): SessionNameVisibility | undefined {
  if (options.includeHidden || parseStoredSessionFilter(storedFilterJson).length === 0) {
    return undefined;
  }
  return {
    isHidden: compileStoredSessionFilter(storedFilterJson),
    keepSessionIds: options.keepSessionIds ?? [],
  };
}

/**
 * Reads one paginated project session slice from the DB and groups rows by provider.
 */
function readProjectSessionsPageByPath(
  projectPath: string,
  storedFilterJson: string | null,
  options: SessionPaginationOptions = {},
): ProjectSessionsPageResult {
  const pagination = normalizeSessionPagination(options);
  const visibility = buildSessionVisibility(storedFilterJson, options);
  const rows = sessionsDb.getSessionsByProjectPathPage(
    projectPath,
    pagination.limit,
    pagination.offset,
    visibility,
  ) as SessionRepositoryRow[];
  const total = sessionsDb.countSessionsByProjectPath(projectPath, visibility);
  const hiddenCount = visibility ? sessionsDb.countHiddenSessionsByProjectPath(projectPath, visibility) : 0;

  return {
    sessions: rows.map(mapSessionRowToSummary),
    total,
    hasMore: pagination.offset + rows.length < total,
    hiddenCount,
  };
}

// Broadcast progress to all connected WebSocket clients.
// Uses the unified `kind` envelope like every other websocket frame. The frame
// is built here; iterating the connection set and testing `readyState` is the
// port's job (it owns the websocket module's set), which is what keeps this
// group from importing `modules/websocket`. An uninstalled port means no
// websocket module was composed in this process — there is nobody to send to.
function broadcastProgress(progress: ProgressUpdate) {
  const message = JSON.stringify({
    kind: 'loading_progress',
    ...progress,
  });

  readProjectsSessionFetchPort()?.broadcast(message);
}

/**
 * Runs the provider-wide session scan before a listing is read.
 *
 * The scan itself lives in the providers module; the composition root installs
 * it on the port. A caller asking for a refresh in a process that never
 * assembled that layer is a wiring error — answering with the stale listing
 * would hide it.
 */
async function synchronizeSessionsThroughPort(): Promise<void> {
  const port = readProjectsSessionFetchPort();
  if (!port) {
    throw new Error(
      'projects-session-fetch port is not installed: server/index.ts must install it before the projects routes can synchronize sessions',
    );
  }
  await port.synchronizeSessions();
}

/**
 * Reads all projects from DB and returns normalized session summaries.
 */
export async function getProjectsWithSessions(
  options: GetProjectsWithSessionsOptions = {}
): Promise<ProjectListItem[]> {
  if (!options.skipSynchronization) {
    await synchronizeSessionsThroughPort();
  }

  const projectRows = projectsDb.getProjectPaths() as Array<{
    project_id: string;
    project_path: string;
    custom_project_name?: string | null;
    isStarred?: number;
    session_filter?: string | null;
  }>;
  const totalProjects = projectRows.length;
  const projects: ProjectListItem[] = [];
  let processedProjects = 0;

  for (const row of projectRows) {
    processedProjects += 1;

    const projectId = row.project_id;
    const projectPath = row.project_path;

    broadcastProgress({
      phase: 'loading',
      current: processedProjects,
      total: totalProjects,
      currentProject: projectPath,
    });

    const displayName =
      row.custom_project_name && row.custom_project_name.trim().length > 0
        ? row.custom_project_name
        : await generateDisplayName(path.basename(projectPath) || projectPath, projectPath);

    const storedFilter = row.session_filter ?? null;
    const filterRules = parseStoredSessionFilter(storedFilter);
    const sessionsPage = readProjectSessionsPageByPath(projectPath, storedFilter, {
      limit: options.sessionsLimit,
      offset: options.sessionsOffset,
      includeHidden: options.includeHidden,
      keepSessionIds: options.keepSessionIds,
    });

    projects.push({
      projectId,
      path: projectPath,
      displayName,
      fullPath: projectPath,
      isStarred: Boolean(row.isStarred),
      hasQuayConfig: quayService.detectQuayConfig(projectPath),
      hasArchguardCache: hasArchguardCache(projectPath),
      sessions: sessionsPage.sessions,
      sessionMeta: {
        hasMore: sessionsPage.hasMore,
        total: sessionsPage.total,
        hiddenCount: sessionsPage.hiddenCount,
      },
      sessionFilter: filterRules.length > 0 ? { hide: filterRules } : null,
    });
  }

  broadcastProgress({
    phase: 'complete',
    current: totalProjects,
    total: totalProjects,
  });

  return projects;
}

/**
 * Reads archived projects from DB and includes every session row for each
 * project path, because an archived workspace should surface all preserved
 * conversation history in the archive view regardless of each session's flag.
 */
export async function getArchivedProjectsWithSessions(
  options: Pick<GetProjectsWithSessionsOptions, 'skipSynchronization'> = {},
): Promise<ArchivedProjectListItem[]> {
  if (!options.skipSynchronization) {
    await synchronizeSessionsThroughPort();
  }

  const projectRows = projectsDb.getArchivedProjectPaths() as Array<{
    project_id: string;
    project_path: string;
    custom_project_name?: string | null;
    isStarred?: number;
  }>;

  const archivedProjects: ArchivedProjectListItem[] = [];

  for (const row of projectRows) {
    const displayName =
      row.custom_project_name && row.custom_project_name.trim().length > 0
        ? row.custom_project_name
        : await generateDisplayName(path.basename(row.project_path) || row.project_path, row.project_path);

    const sessionsPage = readProjectSessionsIncludingArchived(row.project_path);

    archivedProjects.push({
      projectId: row.project_id,
      path: row.project_path,
      displayName,
      fullPath: row.project_path,
      isStarred: Boolean(row.isStarred),
      hasQuayConfig: quayService.detectQuayConfig(row.project_path),
      hasArchguardCache: hasArchguardCache(row.project_path),
      isArchived: true,
      sessions: sessionsPage.sessions,
      sessionMeta: {
        hasMore: sessionsPage.hasMore,
        total: sessionsPage.total,
        hiddenCount: 0,
      },
      sessionFilter: null,
    });
  }

  return archivedProjects;
}

/**
 * Loads one paginated session slice for a specific project id.
 */
export async function getProjectSessionsPage(
  projectId: string,
  options: SessionPaginationOptions = {},
): Promise<ProjectSessionsPageApiView> {
  const projectRow = projectsDb.getProjectById(projectId);
  if (!projectRow) {
    throw new AppError(`Project "${projectId}" was not found.`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  const sessionsPage = readProjectSessionsPageByPath(projectRow.project_path, projectRow.session_filter ?? null, options);
  return {
    projectId: projectRow.project_id,
    sessions: sessionsPage.sessions,
    sessionMeta: {
      hasMore: sessionsPage.hasMore,
      total: sessionsPage.total,
      hiddenCount: sessionsPage.hiddenCount,
    },
    hiddenCount: sessionsPage.hiddenCount,
  };
}

function requireProjectRow(projectId: string) {
  const projectRow = projectsDb.getProjectById(projectId);
  if (!projectRow) {
    throw new AppError(`Project "${projectId}" was not found.`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }
  return projectRow;
}

function requireValidSessionFilter(hide: unknown): string[] {
  const validation = validateSessionFilter(hide);
  if (!validation.ok) {
    throw new AppError(validation.error, {
      code: 'INVALID_SESSION_FILTER',
      statusCode: 400,
      details: { line: validation.line },
    });
  }
  return validation.hide;
}

/** Validates and persists a project's hide rules; an empty list clears them (NULL). */
export function saveProjectSessionFilter(projectId: string, hide: unknown): { hide: string[] } {
  requireProjectRow(projectId);
  const rules = requireValidSessionFilter(hide);
  projectsDb.updateProjectSessionFilterById(projectId, rules.length > 0 ? JSON.stringify({ hide: rules }) : null);
  return { hide: rules };
}

/** Evaluates draft rules against a project's sessions without touching the database row. */
export function previewProjectSessionFilter(projectId: string, hide: unknown): SessionFilterPreview {
  const projectRow = requireProjectRow(projectId);
  const matcher = compileSessionFilter(requireValidSessionFilter(hide));
  const allCount = sessionsDb.countSessionsByProjectPath(projectRow.project_path);
  const rows = sessionsDb.getSessionsByProjectPathPage(projectRow.project_path, Math.max(allCount, 1), 0) as SessionRepositoryRow[];

  const matched: string[] = [];
  const unmatched: string[] = [];
  let matchedCount = 0;
  // Rows arrive newest first, so the first few names per bucket are the latest.
  for (const row of rows) {
    const name = row.custom_name || '';
    if (matcher(name)) {
      matchedCount += 1;
      if (matched.length < SESSION_FILTER_PREVIEW_SAMPLE_SIZE) matched.push(name || row.session_id);
    } else if (unmatched.length < SESSION_FILTER_PREVIEW_SAMPLE_SIZE) {
      unmatched.push(name || row.session_id);
    }
  }

  return {
    matchedCount,
    unmatchedCount: rows.length - matchedCount,
    matchedSessionNames: matched,
    unmatchedSessionNames: unmatched,
  };
}
