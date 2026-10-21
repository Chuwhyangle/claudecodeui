---
id: gap-files-tab-unfiltered-decouple-index
title: Files tab 去过滤并与 files-index 解耦：显示树/搜索列磁盘真相，退役 legacy 全树路径
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

Files tab 是磁盘浏览器，应当列出磁盘上实际存在的一切——含 `.git/`、`node_modules/`、`.venv/`、`dist/` 以及被 `.gitignore` / `.git/info/exclude` 忽略的文件——不得套用 `.gitignore`、目录名猜名或任何过滤。`files-index`（`git ls-files` 语义）服务于引用面（聊天 @提及、命令面板、裸文件名解析、标识符修复），与 Files tab 无关，两者必须解耦；Files tab 搜索不得再读 `files-index`。同批退役 legacy 全树路径 `listProjectFiles`/`api.getFiles`，并为 Files tab 搜索新建一份无过滤的全量扁平索引。Touches 与 `voice-speaker-model-provisioning`（ready）在 `src/shared/api.ts` 上重叠，机制无关、独立验收，保持分开。先前 `file-tree-lazy-directory-listing`、`file-tree-git-backed-file-index`、`file-tree-lazy-expand-and-reveal`（均 done）建起了本任务要撤销的展示过滤与要解耦的索引。

## Plan

1. 展示树去过滤（server）：`listProjectDirectory` 与 `buildFileTree` 默认 `includeEntry` 改为恒真，仅保留 `FORBIDDEN_WORKSPACE_PATHS`（/proc /sys 伪文件系统）守卫；展示路径移除 `respectGitignore`、`createGitignoreEntryFilter`、`includeEntryByFallbackDirectoryNames`、`IGNORED_DIRECTORY_NAMES`；`.git/` 不作例外。`HARD_EXCLUDED_DIRECTORY_NAMES` 与 `readFallbackEntryFilter` 保留——files-index 的非 git 回退 walk 仍用它们。
2. 退役 legacy 全树（server）：删除 `listProjectFiles`；`GET /files` 去掉无 `?path=` 的 legacy 形状与 `respectGitignore` 查询参数。
3. 新增搜索索引（server）：`listProjectSearchIndex(projectId)` 复用 `buildFallbackFileIndex` 的 BFS walk 但 `includeEntry` 恒真（无过滤），上限 `MAXIMUM_FILE_INDEX_ENTRIES` + `truncated`，按 projectId 缓存；新增 `GET /api/file-tree/projects/:id/files-search-index`。`/files-index` 保持 git 语义不动。
4. 前端 api：`api.getDirectory` 去掉 `respectGitignore=true`；删除 `api.getFiles`；新增 `api.getFileTreeSearchIndex`。
5. 前端搜索解耦：`useFileTreeSearch` 改读模块私有 `useFileTreeSearchIndex`（独立 endpoint + 同款 per-project 缓存），不再 import `useProjectFileIndex`；`useProjectFileIndex` 继续服务引用面。
6. 测试：更新 server `file-tree.service.test.ts`（gitignore/`build` 显隐断言）、`file-tree-lazy-listing.test.ts`（`.venv` 两模式缺席断言）、`file-tree.routes.test.ts`；新增 server `file-tree-search-index.test.ts`；更新前端 `projectFileIndex.test.tsx`（搜索不再是 files-index 消费者）、`fileTreeLazy.test.tsx`（`getFiles` 退役）；新增 `fileTreeSearchIndex.test.tsx`。新增 server 测试文件后同步 `quay-test-script` unknown pin 与 `suite-duration-baseline.tsv` 覆盖率地板。落地位于 `server/shared/types.ts`：`FileTreeServices` 删除 `listProjectFiles`、`listProjectDirectory` 去掉 `respectGitignore` 选项、新增 `listProjectSearchIndex`——实现与契约同一处声明，故补进 Touches。

## AC

- [x] `grep -n "respectGitignore" src/shared/api.ts server/modules/file-tree/file-tree.routes.ts` 无命中
- [x] `grep -n "listProjectFiles\|getFiles" server/modules/file-tree/file-tree.service.ts server/modules/file-tree/file-tree.routes.ts src/shared/api.ts` 无命中
- [x] `grep -n "useProjectFileIndex" src/modules/file-tree/hooks/useFileTreeSearch.ts` 无命中
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/file-tree/tests/file-tree-search-index.test.ts` 退出 0，且断言一个被 `.gitignore` 忽略目录（及 `.git`/`node_modules`）里的文件出现在搜索索引结果中、超界带 `truncated`
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/file-tree/tests/file-tree.service.test.ts server/modules/file-tree/tests/file-tree-lazy-listing.test.ts server/modules/file-tree/tests/file-tree.routes.test.ts` 退出 0（过滤断言已按新语义更新）
- [x] `bash scripts/with-memory-cap.sh vitest run src/modules/file-tree/tests/fileTreeLazy.test.tsx src/modules/file-tree/tests/projectFileIndex.test.tsx src/modules/file-tree/tests/fileTreeSearchIndex.test.tsx` 退出 0
- [x] `npm run typecheck` 退出 0 且 `npm run build:client` 成功

## DoD

在真实运行的应用（浏览器）打开 quay 项目 Files tab：树里能看到被 `.gitignore` 忽略的 `.archguard/` 及其 `output/overview/package.mmd`，搜索框能搜到 `package.mmd`；聊天 @提及/命令面板仍走 `files-index`（git 语义）不受影响。即「展示/搜索 = 磁盘真相，引用面 = git 语义」这条边界真实落地，而不只是测试通过。

## Touches

- server/modules/file-tree/file-tree.service.ts
- server/modules/file-tree/file-tree.routes.ts
- server/modules/file-tree/tests/file-tree.service.test.ts
- server/modules/file-tree/tests/file-tree-lazy-listing.test.ts
- server/modules/file-tree/tests/file-tree.routes.test.ts
- server/modules/file-tree/tests/file-tree-search-index.test.ts
- server/shared/types.ts
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- src/shared/api.ts
- src/modules/file-tree/hooks/useFileTreeSearch.ts
- src/modules/file-tree/hooks/useFileTreeSearchIndex.ts
- src/modules/file-tree/tests/projectFileIndex.test.tsx
- src/modules/file-tree/tests/fileTreeLazy.test.tsx
- src/modules/file-tree/tests/fileTreeSearchIndex.test.tsx
- tasks/gap-files-tab-unfiltered-decouple-index.md
