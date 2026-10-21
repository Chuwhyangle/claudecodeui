---
id: file-tree-lazy-expand-and-reveal
title: 前端懒加载 FileTree 数据流：展开按 path 拉取 + reveal 逐层载入 + 按 path 失效缓存
status: todo
labels:
  - feature
  - ux
parent: null
children: []
extra: {}
depends_on:
  - file-tree-lazy-directory-listing
  - shared-project-file-index-consumers
goal_ac: AC-413
---
## Proposal

把 `useFileTreeData` 从「一次性 getFiles 全树」改为 per-path 懒加载：内部 `Map<dirPath, FileTreeNode[]>` + `loadingPaths` + `expandedDirs`，初始只拉根层，展开目录时按该 path 调 `api.getDirectory(projectId, path)` 写缓存；create/rename/delete/upload 后按受影响 path 失效。`FileTreeNode`/`FileTreeList` 用 `hasChildren`（乐观展开）画箭头并处理加载中占位。`revealDirectory` 对缺失层改为触发逐层加载再继续。搜索改用共享索引（AC-412 落地后）做 name/path 子串 filter，命中项点击 `onFileOpen`。

## AC

- AC-413 criterion 转绿：`npx vitest run src/modules/file-tree/tests/fileTreeLazy.test.tsx` 退出 0。
- `npx oxlint` 通过。

## DoD

真实落地判据：`fileTreeLazy.test.tsx` 断言初始只发根层请求、展开才发该 path 请求、未展开不发请求；reveal 深路径按层顺序载入祖先；file 操作后对应 path 缓存失效并重取。既有的 `revealDirectoryWiring.test.tsx` 与 FileTree 相关测试迁移后仍绿。

## Touches

- src/modules/file-tree/hooks/useFileTreeData.ts
- src/modules/file-tree/FileTree.tsx
- src/modules/file-tree/FileTreeNode.tsx
- src/modules/file-tree/FileTreeList.tsx
- src/modules/file-tree/utils/revealDirectory.ts
- src/shared/api.ts
- src/modules/file-tree/tests/fileTreeLazy.test.tsx
- tasks/file-tree-lazy-expand-and-reveal.md