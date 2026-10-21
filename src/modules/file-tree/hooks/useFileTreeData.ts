import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@/shared/api';
import { directoryRevealChain } from '@/modules/file-tree/utils/revealDirectory';
import type { Project,FileTreeNode } from '@/shared/types';

/**
 * The Files tab used to ask for the whole project tree in one request, so
 * opening it cost the same whether the project held ten files or a hundred
 * thousand. The tree is now read one directory at a time: the hook keeps a
 * `path -> entries` cache, the root listing is the only request made on open,
 * and a directory is fetched the first time it is expanded (or revealed).
 */
export type UseFileTreeDataResult = {
  /** Root listing with every already-loaded directory nested under its node. */
  files: FileTreeNode[];
  /** True while the root listing is in flight (the tree has nothing to draw yet). */
  loading: boolean;
  error: string | null;
  /** Directories whose listing is being fetched right now. */
  loadingPaths: Set<string>;
  /** Fetches one directory's listing unless it is cached or already in flight. */
  loadDirectory: (path: string) => Promise<boolean>;
  /**
   * Loads a reveal reference's ancestors in order (root first) and returns the
   * paths that should be expanded; stops at the first layer the project does
   * not contain (a gitignored folder, a typo) so a bogus reference expands
   * nothing.
   */
  revealAncestors: (reference: string) => Promise<string[]>;
  /** Drops one directory's cached listing and reads it again. */
  invalidateDirectory: (path: string) => void;
  /** Drops every cached listing and starts over from the root. */
  refreshFiles: () => void;
};

const DEFAULT_LOAD_ERROR = 'Unable to load the file tree for this project.';

/** Cache key for the root listing; the endpoint reads an empty `path` as the root. */
const ROOT_DIRECTORY = '';

// Cache keys arrive in two separator conventions: the paths the server emits on
// tree nodes, and the paths composed for a reveal request. Both name the same
// directory, so they are levelled before they meet in the cache.
const normalizeCacheKey = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '');

// The API reports refusals such as FILE_TREE_TOO_LARGE as { error: message }.
// Surfacing that message tells the user why the tree is missing and what to do
// about it, instead of leaving them with an unexplained empty tree.
function readResponseErrorMessage(responseBody: string): string | null {
  try {
    const parsedBody = JSON.parse(responseBody) as unknown;
    const message = typeof parsedBody === 'object' && parsedBody !== null && 'error' in parsedBody
      ? (parsedBody as { error: unknown }).error
      : null;
    return typeof message === 'string' && message.trim() ? message : null;
  } catch {
    return null;
  }
}

/** Reads the `entries` of a one-directory listing, discarding unshaped rows. */
function readListingEntries(body: unknown): FileTreeNode[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const { entries } = body as { entries?: unknown };
  if (!Array.isArray(entries)) return null;

  return entries.filter((entry): entry is FileTreeNode => {
    if (typeof entry !== 'object' || entry === null) return false;
    const node = entry as { name?: unknown; path?: unknown; type?: unknown };
    return typeof node.name === 'string'
      && typeof node.path === 'string'
      && (node.type === 'file' || node.type === 'directory');
  });
}

export function useFileTreeData(selectedProject: Project | null): UseFileTreeDataResult {
  const projectId = selectedProject?.projectId ?? null;
  const projectRoot = selectedProject?.path || selectedProject?.fullPath || '';

  const [directories, setDirectories] = useState<Map<string, FileTreeNode[]>>(() => new Map());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // The async readers must see the cache synchronously (two expands in the same
  // commit both ask for the same listing), so the refs — not the state — are what
  // `loadDirectory` consults.
  const directoriesRef = useRef(directories);
  const loadingPathsRef = useRef(loadingPaths);
  const inflightRef = useRef(new Map<string, Promise<boolean>>());
  // A project switch or a refresh invalidates every request already in flight;
  // their late answers must not write into the new project's cache.
  const generationRef = useRef(0);

  const commitDirectories = useCallback((next: Map<string, FileTreeNode[]>) => {
    directoriesRef.current = next;
    setDirectories(next);
  }, []);

  const loadDirectory = useCallback(async (path: string): Promise<boolean> => {
    if (!projectId) return false;

    const key = normalizeCacheKey(path);
    if (directoriesRef.current.has(key)) return true;

    const inflight = inflightRef.current.get(key);
    if (inflight) return inflight;

    const generation = generationRef.current;
    const isRoot = key === ROOT_DIRECTORY;

    const nextLoadingPaths = new Set(loadingPathsRef.current).add(key);
    loadingPathsRef.current = nextLoadingPaths;
    setLoadingPaths(nextLoadingPaths);
    if (isRoot) setLoading(true);

    const request = (async (): Promise<boolean> => {
      try {
        const response = await api.getDirectory(projectId, path);
        if (generation !== generationRef.current) return false;

        if (!response.ok) {
          const errorText = await response.text();
          console.error('File fetch failed:', response.status, errorText);
          if (isRoot) setError(readResponseErrorMessage(errorText) ?? DEFAULT_LOAD_ERROR);
          return false;
        }

        const entries = readListingEntries(await response.json());
        if (generation !== generationRef.current) return false;
        if (entries === null) {
          if (isRoot) setError(DEFAULT_LOAD_ERROR);
          return false;
        }

        commitDirectories(new Map(directoriesRef.current).set(key, entries));
        if (isRoot) setError(null);
        return true;
      } catch (fetchError) {
        if ((fetchError as { name?: string }).name === 'AbortError') return false;

        console.error('Error fetching files:', fetchError);
        // A failed child listing is an empty folder for display purposes; only
        // the root failure leaves the whole tab without a tree to explain.
        if (isRoot) setError(DEFAULT_LOAD_ERROR);
        return false;
      } finally {
        // A request from a previous generation belongs to a cache that no
        // longer exists; clearing its entry in the *current* map would drop a
        // live request's dedupe entry.
        if (generation === generationRef.current) {
          const settledPaths = new Set(loadingPathsRef.current);
          settledPaths.delete(key);
          loadingPathsRef.current = settledPaths;
          setLoadingPaths(settledPaths);
          if (isRoot) setLoading(false);
          inflightRef.current.delete(key);
        }
      }
    })();

    inflightRef.current.set(key, request);
    return request;
  }, [commitDirectories, projectId]);

  // One root read per project (and per explicit refresh). A project switch
  // clears the cache in the same commit that starts the new read, so a node
  // path from the previous project can never be looked up in the new one.
  useEffect(() => {
    generationRef.current += 1;
    directoriesRef.current = new Map();
    loadingPathsRef.current = new Set();
    inflightRef.current = new Map();
    setDirectories(directoriesRef.current);
    setLoadingPaths(loadingPathsRef.current);
    setError(null);

    if (!projectId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    void loadDirectory(ROOT_DIRECTORY);
  }, [loadDirectory, projectId, refreshKey]);

  const refreshFiles = useCallback(() => {
    setRefreshKey((previous) => previous + 1);
  }, []);

  const invalidateDirectory = useCallback((directoryPath: string) => {
    const key = normalizeCacheKey(directoryPath);
    if (directoriesRef.current.has(key)) {
      const next = new Map(directoriesRef.current);
      next.delete(key);
      commitDirectories(next);
    }

    // Read it again rather than leaving the stale listing to be served from
    // cache on the next expand: an operation just changed what it contains.
    void loadDirectory(directoryPath);
  }, [commitDirectories, loadDirectory]);

  const revealAncestors = useCallback(async (reference: string): Promise<string[]> => {
    if (!projectId || !projectRoot) return [];
    if (!(await loadDirectory(ROOT_DIRECTORY))) return [];

    const expanded: string[] = [];
    let parentKey = ROOT_DIRECTORY;

    for (const directoryPath of directoryRevealChain(projectRoot, reference)) {
      if (!(await loadDirectory(directoryPath))) break;

      // Expand the path the server emitted for this row rather than the one
      // composed here: FileTreeNode keys expansion by node.path, and on Windows
      // the server's separators differ from the composed ones.
      const nodePath = (directoriesRef.current.get(parentKey) ?? []).find(
        (entry) => entry.type === 'directory'
          && normalizeCacheKey(entry.path) === normalizeCacheKey(directoryPath),
      )?.path;
      expanded.push(nodePath ?? directoryPath);
      parentKey = normalizeCacheKey(directoryPath);
    }

    return expanded;
  }, [loadDirectory, projectId, projectRoot]);

  // Nest each loaded listing under its directory node. Unexpanded directories
  // have no cache entry and keep whatever shape the server sent (no children,
  // `hasChildren: true`), which is what makes the arrow optimistic.
  const files = useMemo(() => {
    const rootEntries = directories.get(ROOT_DIRECTORY);
    if (!rootEntries) return [];

    const attachChildren = (nodes: FileTreeNode[]): FileTreeNode[] =>
      nodes.map((node) => {
        if (node.type !== 'directory') return node;
        const children = directories.get(normalizeCacheKey(node.path));
        return children === undefined ? node : { ...node, children: attachChildren(children) };
      });

    return attachChildren(rootEntries);
  }, [directories]);

  return {
    files,
    loading,
    error,
    loadingPaths,
    loadDirectory,
    revealAncestors,
    invalidateDirectory,
    refreshFiles,
  };
}
