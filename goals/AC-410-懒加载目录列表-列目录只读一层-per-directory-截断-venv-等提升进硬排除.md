---
id: AC-410
title: 懒加载目录列表：列目录只读一层、per-directory 截断、.venv 等提升进硬排除
status: draft
kind: criterion
goal: GOAL-048
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/file-tree/tests/file-tree-lazy-listing.test.ts
expect: 列出某目录只返回该层条目（目录与文件），绝不递归打开任何子孙目录；对一个根目录下有「含 5
  万条目的子目录」的树，列根层仍成功返回该子目录条目（目录带 hasChildren），不抛 FILE_TREE_TOO_LARGE；单独列该子目录时按
  per-directory 上限截断并带 truncated 标记；.venv/venv/__pycache__ 目录无论有无 gitignore
  都被排除。取假形态：仍走全树递归（列根层触发子孙目录读取）即红；把 .venv
  留在硬排除之外即红。当前必红：server/modules/file-tree/tests/file-tree-lazy-listing.test.ts
  不存在。
origin: 本会话（2026-10-21）Files tab 413 根因分析：eager 全树 walk 把 34k 文件的 .venv 读进来耗尽全局 10k 预算。
---
