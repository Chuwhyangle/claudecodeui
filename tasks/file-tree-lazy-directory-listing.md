---
id: file-tree-lazy-directory-listing
title: Files tab 懒加载：单层目录列表端点 + per-directory 截断 + .venv 提升进硬排除
status: ready
labels:
  - feature
parent: null
children: []
extra: {}
goal_ac: AC-410
---
## Proposal

把 `listProjectFiles`（现为 depth-10 全树递归）替换为 `listProjectDirectory(projectId, path?)`：只读一层，目录条目带 `hasChildren`，超过 per-directory 上限时返回已列条目 + `truncated: true`，不再 throw `FILE_TREE_TOO_LARGE`。路由 `GET /api/file-tree/projects/:id/files?path=<dir>`（缺省 = 项目根），复用 `buildFileTree(depth=1)` 与 `collectVisibleEntries` 的流式过滤。同时把 `.venv`/`venv`/`__pycache__` 及缓存目录（`.pytest_cache`/`.mypy_cache`/`.tox`/`.cache`/`.parcel-cache`/`.gradle`/`.nyc_output`/`coverage`/`.idea`）提升进 `HARD_EXCLUDED_DIRECTORY_NAMES`，使 gitignore 模式与 fallback 模式都排除它们（对齐 node_modules 的待遇）。移除 `MAXIMUM_FILE_TREE_ENTRIES` 对展示路径的全局约束，改为 per-directory 截断常数。`hasChildren` 先采用乐观展开（目录一律给可展开箭头，展开空目录显示空态），不做 peek。

## AC

- AC-410 criterion 转绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/file-tree/tests/file-tree-lazy-listing.test.ts` 退出 0。
- 既有 `server/modules/file-tree/tests/file-tree.service.test.ts` 仍绿（其中「gitignore 模式下 `build` 仍显示」的断言不改动）。

## DoD

真实落地判据：新测试 `file-tree-lazy-listing.test.ts` 用 path-keyed 假 FS 记录 `openDirectory` 的调用路径，断言列根层只读根目录、不读任何子孙；含 5 万条目子目录的根层列表成功返回该子目录条目且不抛 413；单独列该子目录返回截断列表 + truncated 标记；`.venv` 在两种模式都被硬排除。⚠️ 新增 server 测试文件会顶高 `scripts/test.sh` 的 unknown pin：重新测量并把新文件写进 Touches；同文件涉及 duration-baseline 覆盖率地板，跑 `bash scripts/test.sh` 确认不破。

## Touches

- server/modules/file-tree/file-tree.service.ts
- server/modules/file-tree/file-tree.routes.ts
- server/shared/types.ts
- server/modules/file-tree/tests/file-tree-lazy-listing.test.ts
- tasks/file-tree-lazy-directory-listing.md