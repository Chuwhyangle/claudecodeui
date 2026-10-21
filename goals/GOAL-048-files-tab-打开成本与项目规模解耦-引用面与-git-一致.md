---
id: GOAL-048
title: Files tab 打开成本与项目规模解耦，引用面与 git 一致
status: draft
kind: goal
origin: 本会话（2026-10-21）对 Files tab 报「Project file tree exceeds the 10,000 entry
  limit」的根因分析与方案讨论，人 yale 指令落成 quay goal。
---
## 背景

Files tab 在当前仓库点开时报「Project file tree exceeds the 10,000 entry limit」，根因不是项目真的超过 1 万文件，而是 `listProjectFiles` 一次性 eager 递归整棵树（depth 10），把 `experiments/voice-turn-detection-compare/worst-cases-replay/.venv`（34,257 文件）也读进来，耗尽全局 `MAXIMUM_FILE_TREE_ENTRIES = 10_000` 预算后整体 413。git 视角下该仓库只有 4,194 个应显示文件。根因有三：`.venv` 不在 always-on 硬排除名单（只有 fallback 名单有）；gitignore 模式只读根 `.gitignore`、不读嵌套；全局上限让「总文件数」有资格阻挡「当前目录」的显示。

方案拆成两条正交路径：浏览（Files tab 树）改为懒加载 per-directory，打开成本与项目规模解耦；引用（@-mention / command palette / 聊天裸文件名解析 / 搜索）收敛到一个共享的文件索引，git 项目用 `git ls-files --cached --others --exclude-standard`（本仓库实测 9ms、精确 git 语义，正确排除嵌套 `.gitignore` 的 `.venv/`），非 git 回退 FS walk。全局 10k 上限移除，改为 per-directory 截断 + 索引有界。

## 退出条件

- AC-410 懒加载目录列表：列目录只读一层、绝不递归；per-directory 截断带 truncated；`.venv/venv/__pycache__` 等提升进硬排除。
- AC-411 git 对齐文件索引：git 项目索引 = git ls-files 路径集（嵌套 .gitignore 生效）；非 git 回退 floor + 根 gitignore + 上限。
- AC-412 前端共享索引：四个消费者（mention/palette/open-resolver/搜索）共享一份索引缓存，切项目只 fetch 一次。
- AC-413 前端懒树 + reveal：展开按 path 拉取；reveal 逐层载入祖先；file 操作按 path 失效缓存。
- AC-414 回归：既有 file-tree service/routes 测试不回归。

## 非目标

`.git/info/exclude` 与全局 `core.excludesFile`（索引靠 git ls-files 天然含，展示树不做）；服务端文件名/全文搜索端点（搜索用索引客户端 filter）；`dist/build/vendor/target/.next/.nuxt` 进硬排除（仍交给 gitignore）。