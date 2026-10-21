import { useEffect, useState } from 'react';

import { api } from '@/shared/api';

/**
 * One file in a project's flat index.
 *
 * `path` is absolute and `name` is its basename, so a consumer can match on
 * either without re-deriving the parent.
 */
export type ProjectFileIndexEntry = {
  name: string;
  path: string;
};

export type UseProjectFileIndexResult = {
  files: ProjectFileIndexEntry[];
  loading: boolean;
};

type ProjectFileIndexState = {
  projectId: string | null;
  files: ProjectFileIndexEntry[];
  loading: boolean;
};

// One load per project for the whole session. The *promise* is cached, not its
// result: the consumers that read the index — @-mentions, the command palette,
// bare-filename resolution and Files-tab search — mount at different times and
// all join the same request instead of each walking the project.
//
// A settled failure is cached too. The degradation is the same for every
// consumer (nothing to offer), and re-asking per render or per utterance would
// put a network round trip in front of a surface that already works without it.
const indexLoads = new Map<string, Promise<ProjectFileIndexEntry[]>>();

/** Reads the fields this hook publishes, ignoring whatever else the endpoint adds. */
function isFileIndexEntry(value: unknown): value is ProjectFileIndexEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as { name?: unknown; path?: unknown };
  return typeof entry.name === 'string' && typeof entry.path === 'string';
}

/** One request for one project's index. Never rejects: every failure is `[]`. */
async function fetchProjectFileIndex(projectId: string): Promise<ProjectFileIndexEntry[]> {
  try {
    const response = await api.getFileIndex(projectId);
    if (!response.ok) return [];
    const payload = (await response.json()) as { files?: unknown };
    if (!Array.isArray(payload?.files)) return [];
    return payload.files.filter(isFileIndexEntry).map(({ name, path }) => ({ name, path }));
  } catch {
    return [];
  }
}

/**
 * The project's flat file index, fetched at most once per project id.
 *
 * Never rejects: a failed request and an empty project both resolve to `[]`,
 * which every consumer reads as "nothing to offer".
 */
export function loadProjectFileIndex(projectId: string): Promise<ProjectFileIndexEntry[]> {
  const cached = indexLoads.get(projectId);
  if (cached !== undefined) return cached;

  const started = fetchProjectFileIndex(projectId);
  indexLoads.set(projectId, started);
  return started;
}

/**
 * Subscribes one consumer to the shared project file index.
 *
 * `enabled` lets a consumer that only needs the index on demand (Files-tab
 * search) stay quiet until it does. Every enabled caller for one project still
 * reads the single cached request, so switching projects costs one new request
 * for all consumers rather than one per consumer.
 */
export function useProjectFileIndex(
  projectId: string | null | undefined,
  enabled = true,
): UseProjectFileIndexResult {
  const activeProjectId = enabled ? (projectId ?? null) : null;
  const [state, setState] = useState<ProjectFileIndexState>({
    projectId: null,
    files: [],
    loading: false,
  });

  // The effect owns the load so consumers never fetch during render: a project
  // switch clears the previous project's entries in the same commit that starts
  // the new load, and a late answer for an abandoned project is ignored.
  useEffect(() => {
    if (!activeProjectId) {
      setState({ projectId: null, files: [], loading: false });
      return;
    }

    let active = true;
    setState({ projectId: activeProjectId, files: [], loading: true });
    void loadProjectFileIndex(activeProjectId).then((files) => {
      if (active) setState({ projectId: activeProjectId, files, loading: false });
    });

    return () => {
      active = false;
    };
  }, [activeProjectId]);

  // State is one commit behind a project switch; reporting the old project's
  // entries for that render would let a mention or a search match a path the
  // newly selected project does not have.
  if (state.projectId !== activeProjectId) {
    return { files: [], loading: Boolean(activeProjectId) };
  }

  return { files: state.files, loading: state.loading };
}
