---
id: shared-project-file-index-consumers
title: 前端共享 projectFileIndex 缓存，迁移 mention/palette/open-resolver/搜索 四个消费者
status: todo
labels:
  - feature
parent: null
children: []
extra: {}
depends_on:
  - file-tree-git-backed-file-index
goal_ac: AC-412
---
## Proposal

新增共享 hook `useProjectFileIndex`（`src/modules/file-tree/hooks/useProjectFileIndex.ts`，per-project 缓存，调 `api.getFileIndex`），从 `src/modules/file-tree/index.ts` barrel 导出。四个消费者改吃它：`useFileMentions`（@ 补全）、`useFilesSource`（command palette）、`useFileOpenResolver`（裸文件名解析）、Files tab 搜索（`useFileTreeSearch`）。删除 `api.getFiles` 全树调用与四处各自 flatten 的重复代码。被 `getFiles` 移除影响的既有前端测试桩（`fileOpenResolver.test.tsx`、`voiceTranscriptRepair.test.tsx`、`voiceEditLabelsHook.test.tsx`、`voiceErrorMessages.test.tsx`、`sessionPermissionMode.test.tsx`）改用新 files-index 端点桩。

## AC

- AC-412 criterion 转绿：`npx vitest run src/modules/file-tree/tests/projectFileIndex.test.tsx` 退出 0。
- `npx oxlint` 通过（barrel 导出，无跨模块深导入）。

## DoD

真实落地判据：`projectFileIndex.test.tsx` 断言四个消费者同源（切项目只发一次 files-index 请求、读同一份 {name,path}[]）；mock getFiles 的既有桩全部迁移到新 index 端点后原测试仍绿。⚠️ 新增前端测试文件同样进 Touches 并同步计数。

## Touches

- src/modules/file-tree/hooks/useProjectFileIndex.ts
- src/modules/file-tree/index.ts
- src/modules/file-tree/hooks/useFileTreeSearch.ts
- src/modules/chat/hooks/useFileMentions.tsx
- src/modules/command-palette/hooks/useFilesSource.ts
- src/modules/project-workspace/hooks/useFileOpenResolver.ts
- src/shared/api.ts
- src/modules/file-tree/tests/projectFileIndex.test.tsx
- tasks/shared-project-file-index-consumers.md