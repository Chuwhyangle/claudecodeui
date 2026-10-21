import { useEffect, useState } from 'react';

import { api } from '@/shared/api';

/**
 * One file in the Files-tab search index.
 *
 * Same shape as the reference index entry, but a different set: this index is
 * the unfiltered walk of what is on disk, so it includes gitignored paths and
 * `.git/` / `node_modules/` files the tree can show.
 */
export type FileTreeSearchIndexEntry = {
  name: string;
  path: string;
};

export type UseFileTreeSearchIndexResult = {
  files: FileTreeSearchIndexEntry[];
  loading: boolean;
};

type FileTreeSearchIndexState = {
  projectId: string | null;
  files: FileTreeSearchIndexEntry[];
  loading: boolean;
};

// One load per project for the whole session. The *promise* is cached, not its
// result, so every Files-tab tree mounted for one project joins the same walk
// instead of each paying for its own.
//
// Deliberately a SEPARATE cache from `useProjectFileIndex`: the reference
// surfaces (@-mentions, command palette, bare-name resolution) read the
// git-aligned index, and a search must not consume that set.
const searchIndexLoads = new Map<string, Promise<FileTreeSearchIndexEntry[]>>();

/** Reads the fields this hook publishes, ignoring whatever else the endpoint adds. */
function isFileTreeSearchIndexEntry(value: unknown): value is FileTreeSearchIndexEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as { name?: unknown; path?: unknown };
  return typeof entry.name === 'string' && typeof entry.path === 'string';
}

/** One request for one project's search index. Never rejects: every failure is `[]`. */
async function fetchFileTreeSearchIndex(projectId: string): Promise<FileTreeSearchIndexEntry[]> {
  try {
    const response = await api.getFileTreeSearchIndex(projectId);
    if (!response.ok) return [];
    const payload = (await response.json()) as { files?: unknown };
    if (!Array.isArray(payload?.files)) return [];
    return payload.files.filter(isFileTreeSearchIndexEntry).map(({ name, path }) => ({ name, path }));
  } catch {
    return [];
  }
}

/**
 * The project's unfiltered search index, fetched at most once per project id.
 *
 * Never rejects: a failed request and an empty project both resolve to `[]`,
 * which the search reads as "nothing to offer".
 */
export function loadFileTreeSearchIndex(projectId: string): Promise<FileTreeSearchIndexEntry[]> {
  const cached = searchIndexLoads.get(projectId);
  if (cached !== undefined) return cached;

  const started = fetchFileTreeSearchIndex(projectId);
  searchIndexLoads.set(projectId, started);
  return started;
}

/**
 * Subscribes the Files-tab search to the project's search index.
 *
 * `enabled` keeps the walk off the wire until a query is actually active;
 * browsing the tree never pays for it.
 */
export function useFileTreeSearchIndex(
  projectId: string | null | undefined,
  enabled = true,
): UseFileTreeSearchIndexResult {
  const activeProjectId = enabled ? (projectId ?? null) : null;
  const [state, setState] = useState<FileTreeSearchIndexState>({
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
    void loadFileTreeSearchIndex(activeProjectId).then((files) => {
      if (active) setState({ projectId: activeProjectId, files, loading: false });
    });

    return () => {
      active = false;
    };
  }, [activeProjectId]);

  // State is one commit behind a project switch; reporting the old project's
  // entries for that render would let a search match a path the newly selected
  // project does not have.
  if (state.projectId !== activeProjectId) {
    return { files: [], loading: Boolean(activeProjectId) };
  }

  return { files: state.files, loading: state.loading };
}
