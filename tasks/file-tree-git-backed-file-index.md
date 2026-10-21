---
id: file-tree-git-backed-file-index
title: git 对齐的文件索引端点：git ls-files + 非 git 回退 + 服务端缓存
status: ready
labels:
  - feature
parent: null
children: []
extra: {}
goal_ac: AC-411
---
## Proposal

新增 `listProjectFileIndex(projectId)` 返回扁平 `{name, path, type}[]`。git 项目用 `git ls-files --cached --others --exclude-standard`（相对→绝对映射；本仓库实测 9ms、正确排除嵌套 `.gitignore` 的 `.venv/` 与 `data/`）；非 git 项目回退现有全树 walk（硬排除 + 根 `.gitignore` + 有界上限，超界带 `truncated`）。`FileTreeFileSystem` 增两个端口 `isGitRepository` / `listGitFiles`（生产实现用 `git`，测试用假），服务端按 projectId 缓存索引。路由 `GET /api/file-tree/projects/:id/files-index`。

## AC

- [x] AC-411 criterion 转绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/file-tree/tests/file-tree-index.test.ts` 退出 0（实测 5/5 pass）。
- [x] 既有 `server/modules/file-tree/tests/file-tree.routes.test.ts` 仍绿（实测 5/5 pass；同跑的 `file-tree.service.test.ts` 9/9 pass）。

## DoD

真实落地判据：`file-tree-index.test.ts` 用真实 git 临时仓库 fixture 断言索引与 `git ls-files` 路径集一致（嵌套 `.gitignore` 的 `.venv/` 缺席、根 `.gitignore` 用 `!` 捞回的 tracked 文件在场）；非 git fixture 断言回退 floor + 根 gitignore + 上限。索引端点对真实项目返回不含 `.venv` 的路径。⚠️ 新增 server 测试文件同样要同步 `scripts/test.sh` 的 unknown pin 与覆盖率地板。

落地读数：git fixture 索引路径集与 `git ls-files --cached --others --exclude-standard` 逐项相等（fixture 自检 `.venv` 确实被嵌套 gitignore 排除，避免真空断言）；非 git fixture 只含 `.gitignore`/`README.md`/`src/index.ts`/`src/nested/deep.ts`（`node_modules` 与 `.venv` 缺席、`*.log` 缺席）；10,001 文件 fixture 返回 10,000 条 + `truncated: true`；同一 projectId 连续两次读取只调一次 `listGitFiles`；真实项目索引非空且无 `.venv` 路径。`scripts/test.sh` unknown pin 已随新测试文件重测（386 → 387，unknown 383→384 / 385→386），`quay-test-script.test.ts` 14/14 pass；`server/tsconfig.json` typecheck 退出 0。

## Touches

- server/modules/file-tree/file-tree.service.ts
- server/modules/file-tree/file-tree.routes.ts
- server/modules/file-tree/file-tree.module.ts
- server/modules/file-tree/file-tree.git.ts
- server/shared/types.ts
- server/modules/file-tree/tests/file-tree-index.test.ts
- server/modules/file-tree/tests/file-tree.routes.test.ts
- server/shared/tests/quay-test-script.test.ts
- tasks/file-tree-git-backed-file-index.md