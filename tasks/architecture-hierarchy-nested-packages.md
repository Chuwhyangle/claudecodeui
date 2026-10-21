---
id: architecture-hierarchy-nested-packages
title: 桥接发嵌套 package 块 + 前端层级索引（实体→最内层包→祖先链→计数）
status: todo
labels:
  - feature
parent: null
children: []
extra: {}
---
## Proposal

爆炸图（几何连续语义缩放）的前提是「一次布局、多层级显隐」，而当前桥接发的是**扁平** `class A as n0`（`archguardToPlantUml.ts` 无 package 块），层级信息只在 `data-package-id` 之外的路径字符串里。本任务：① 桥接按路径前缀发出**嵌套 `package "modules/chat" { package "modules/chat/hooks" { class ... } }`**，保留既有别名映射（`aliasOf` 稳定性不变）；② 前端建**层级索引**（实体 → 最内层包 → 祖先链），供显隐档位与折叠计数使用。

依据（2026-10-22 与 plantuml-js 会话实测，789 实体/462 边）：嵌套 depth≤4（78 包）布局 2.11s / crossings 783；嵌套 full（107 包）1.06s / crossings 732；nodeIntersect 恒 0。**嵌套比 flat 更快、crossings 更低**，但当前画布宽 55076–87234 px（宽高比 9–15），成比例打包已由 plantuml-js 侧另立任务修复——本任务只发结构，不依赖打包修复即可落地与测试。

entity 的 `data-package-id` 已由 plantuml-js 输出（commit 2e7289a，取自 model `parentId`，非几何推断），本任务消费它建索引，不做点-in-rect 推断。

## AC

- [ ] `npx vitest run src/modules/architecture/tests/archguardToPlantUml.test.ts` exit 0：嵌套输入产出嵌套 `package` 块（顶层无 package 的实体不包）；别名映射与改动前逐字一致（同一 graph 同一 aliasOf）；`group`/`neighborhood` 视图仍正确
- [ ] `npx vitest run src/modules/architecture/tests/hierarchyIndex.test.ts` exit 0：实体 → 最内层包、包的祖先链、包内计数（直接子实体数与后代总数）正确；无 `data-package-id` 的顶层实体归入根
- [ ] `npm run typecheck` 通过

## DoD

对真实 archguard 789 节点邻域跑新桥接：产出的 `.puml` 含嵌套 `package` 块、plantuml-js 渲染成功、SVG 中每个 `uml-node` 带正确 `data-package-id`；前端层级索引能从该 SVG + 邻域 JSON 还原出「根 → 包 → 子包 → 实体」的完整树，且包内计数与邻域 JSON 统计一致。

## Touches

- src/modules/architecture/archguardToPlantUml.ts
- src/modules/architecture/hierarchyIndex.ts (new)
- src/modules/architecture/tests/archguardToPlantUml.test.ts (new)
- src/modules/architecture/tests/hierarchyIndex.test.ts (new)
- tasks/architecture-hierarchy-nested-packages.md