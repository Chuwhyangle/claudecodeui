---
id: AC-411
title: git 对齐文件索引：git 项目用 git ls-files、非 git 回退 FS walk
status: draft
kind: criterion
goal: GOAL-048
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/file-tree/tests/file-tree-index.test.ts
expect: 对 git 项目，索引路径集 = git ls-files --cached --others --exclude-standard
  的相对路径映射到绝对路径；嵌套 .gitignore 排除的 .venv/ 文件不在索引里，被根 .gitignore 用 ! 捞回的 tracked
  文件在索引里；对非 git 项目，索引回退到 FS walk（硬排除 + 根 .gitignore + 有界上限，超界带
  truncated）。取假形态：只用根 .gitignore 手搓过滤（嵌套 .venv 会漏进）即红；非 git
  回退缺失即红。当前必红：server/modules/file-tree/tests/file-tree-index.test.ts 不存在。
origin: 本会话（2026-10-21）实测 git ls-files --cached --others --exclude-standard 在本仓库
  9ms 返回 4194 条并正确排除嵌套 .venv/ 与 data/。
---
