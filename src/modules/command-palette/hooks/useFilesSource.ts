import { useMemo } from 'react';

import { useProjectFileIndex } from '@/modules/file-tree';

export type FileResult = {
  path: string;
  name: string;
};

const MAX_FILES = 500;

/**
 * The command palette's file source, read from the shared project file index.
 *
 * The palette only ever needed the flat `{name, path}` list, which is exactly
 * what the index publishes — so it joins the same per-project request as the
 * other reference surfaces instead of fetching and flattening the full tree.
 */
export function useFilesSource(projectId: string | undefined, enabled: boolean) {
  const { files } = useProjectFileIndex(projectId, enabled && !!projectId);

  // The palette keeps its own bound so a very large project cannot push an
  // unbounded list through the command menu.
  return useMemo(() => files.slice(0, MAX_FILES), [files]);
}
