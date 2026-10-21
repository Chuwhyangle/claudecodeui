---
id: shared-project-file-index-consumers
title: 前端共享 projectFileIndex 缓存，迁移 mention/palette/open-resolver/搜索 四个消费者
status: done
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

- [x] AC-412 criterion 转绿：`npx vitest run src/modules/file-tree/tests/projectFileIndex.test.tsx` 退出 0。
- [x] `npx oxlint` 通过（barrel 导出，无跨模块深导入）。

## DoD

真实落地判据：`projectFileIndex.test.tsx` 断言四个消费者同源（切项目只发一次 files-index 请求、读同一份 {name,path}[]）；mock getFiles 的既有桩全部迁移到新 index 端点后原测试仍绿。⚠️ 新增前端测试文件同样进 Touches 并同步计数。

落地读数：`projectFileIndex.test.tsx` 5/5 pass（四个消费者同项目只发一次 files-index；切项目只再发一次且都读同一份缓存数组；四个消费者源码静态断言均读共享索引且无 `getFiles`；hook 经 file-tree barrel 导出）。迁移后的 `fileOpenResolver` / `voiceTranscriptRepair` / `voiceEditLabelsHook` / `voiceErrorMessages` / `sessionPermissionMode` / `projectIdentifiers` 六个测试文件 30/30 pass。`npx oxlint src/ server/ scripts/ shared/`（`npm run lint` 口径）退出 0，无跨模块深导入；无路径的 `npx oxlint` 会扫 e2e/experiments/plugin 的既有红，与本 delta 无关。`npx tsc --noEmit -p tsconfig.json` 退出 0。

## Touches

- src/modules/file-tree/hooks/useProjectFileIndex.ts
- src/modules/file-tree/index.ts
- src/modules/file-tree/hooks/useFileTreeSearch.ts
- src/modules/file-tree/FileTree.tsx
- src/modules/chat/hooks/useFileMentions.tsx
- src/modules/command-palette/hooks/useFilesSource.ts
- src/modules/project-workspace/hooks/useFileOpenResolver.ts
- src/shared/api.ts
- src/shared/projectIdentifiers.ts
- src/modules/file-tree/tests/projectFileIndex.test.tsx
- src/modules/chat/tests/sessionPermissionMode.test.tsx
- src/modules/chat/tests/voiceEditLabelsHook.test.tsx
- src/modules/chat/tests/voiceErrorMessages.test.tsx
- src/modules/chat/tests/voiceTranscriptRepair.test.tsx
- src/modules/project-workspace/tests/fileOpenResolver.test.tsx
- src/shared/tests/projectIdentifiers.test.ts
- tasks/shared-project-file-index-consumers.md