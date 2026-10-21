import { useMemo, useState } from 'react';

import { useFileTreeSearchIndex } from '@/modules/file-tree/hooks/useFileTreeSearchIndex';
import type { FileTreeNode } from '@/shared/types';

type UseFileTreeSearchArgs = {
  files: FileTreeNode[];
  projectId: string | undefined;
};

type UseFileTreeSearchResult = {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  filteredFiles: FileTreeNode[];
};

export function useFileTreeSearch({
  files,
  projectId,
}: UseFileTreeSearchArgs): UseFileTreeSearchResult {
  const [searchQuery, setSearchQuery] = useState('');

  // Search reads its own disk-truth index: the same unfiltered walk that backs
  // what the tree shows, so a gitignored file visible in the tree is findable
  // here too. The reference index (git semantics) backs @-mentions, the command
  // palette and bare-name resolution instead. The walk is only asked for while
  // a query is active — browsing the tree never pays for it.
  const { files: indexEntries } = useFileTreeSearchIndex(projectId, searchQuery.trim().length > 0);

  // Derived, not stored: mirroring the filter into state made every keystroke
  // (and every index refresh) cost an extra render, and left `filteredFiles`
  // one render behind the entries it was derived from.
  const filteredFiles = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return files;
    }

    // A matched index entry is one result row: the index has no directories, so
    // a search result is a flat list of files rather than a pruned tree.
    return indexEntries
      .filter(
        (entry) =>
          entry.name.toLowerCase().includes(query) || entry.path.toLowerCase().includes(query),
      )
      .map((entry) => ({ type: 'file' as const, name: entry.name, path: entry.path }));
  }, [files, indexEntries, searchQuery]);

  return {
    searchQuery,
    setSearchQuery,
    filteredFiles,
  };
}
