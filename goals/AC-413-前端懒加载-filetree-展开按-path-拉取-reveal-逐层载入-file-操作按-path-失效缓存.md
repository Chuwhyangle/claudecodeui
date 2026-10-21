---
id: AC-413
title: 前端懒加载 FileTree：展开按 path 拉取、reveal 逐层载入、file 操作按 path 失效缓存
status: draft
kind: criterion
goal: GOAL-048
criterion: npx vitest run src/modules/file-tree/tests/fileTreeLazy.test.tsx
expect: 展开目录触发一次按该 path 的 files?path= 请求并把结果写入缓存；未展开目录不发请求；初始只发根层请求；reveal
  深层路径按层顺序载入祖先并展开；file 操作（create/rename/delete/upload）后对应 path
  的缓存失效并重取。取假形态：初始仍一次性拉全树即红；reveal
  不逐层载入即红。当前必红：src/modules/file-tree/tests/fileTreeLazy.test.tsx 不存在。
origin: 本会话（2026-10-21）方案：渲染已是懒的（expandedDirs 折叠），只有 fetch 是 eager 的；改为
  per-directory 懒拉后打开成本与项目规模解耦。
---
