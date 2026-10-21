---
id: AC-414
title: 回归：既有 file-tree service/routes 测试在懒加载与索引改造后仍绿
status: draft
kind: criterion
goal: GOAL-048
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/file-tree/tests/file-tree.service.test.ts
  server/modules/file-tree/tests/file-tree.routes.test.ts
expect: 懒加载与索引改造后，既有 file-tree service 与 routes
  测试仍全绿：create/rename/delete/upload/read/save/browse 的行为不回归；被 getFiles
  移除影响的前端既有测试（fileOpenResolver、voiceTranscriptRepair 等 mock getFiles 的桩）在改用新
  files-index 端点桩后仍绿。
origin: 本会话（2026-10-21）方案：getFiles 全树接口被 files?path= 懒端点与 files-index
  索引端点取代，既有桩与测试需同步迁移。
---
