---
id: AC-412
title: 前端共享 projectFileIndex 缓存：mention/palette/open-resolver/搜索 四个消费者同源
status: draft
kind: criterion
goal: GOAL-048
criterion: npx vitest run src/modules/file-tree/tests/projectFileIndex.test.tsx
expect: useFileMentions、useFilesSource、useFileOpenResolver 与 Files tab 搜索都从一个共享
  projectFileIndex 缓存读同一份 {name,path}[]，切项目只发一次 files-index 请求；四个消费者不再各自调已删除的
  getFiles 全树接口。新 hook 经 src/modules/file-tree barrel 导出（本仓库 boundaries
  规则，跨模块不得深导入）。取假形态：任一消费者保留自己的 getFiles 全树调用即红；hook 未 barrel
  导出导致跨模块深导入即红。当前必红：src/modules/file-tree/tests/projectFileIndex.test.tsx 不存在。
origin: 本会话（2026-10-21）调查发现四个全树消费者（useFileMentions / useFilesSource /
  useFileOpenResolver / Files tab 搜索）各自 api.getFiles 一遍且都要同一份扁平 {name,path}[]。
---
