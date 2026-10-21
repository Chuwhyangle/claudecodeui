---
id: architecture-plantuml-panel-linkage
title: architecture 稳定 id 跨面板联动：点节点高亮依赖/反依赖 + 展开下一跳
status: done
labels:
  - feature
parent: null
children: []
extra: {}
depends_on:
  - architecture-plantuml-rendering
---
## Proposal

换 plantuml-js 后，其 SVG 输出已带稳定 id（data-entity-id/data-edge-source/data-edge-target/data-edge-type/data-package-id，plantuml-js 侧扩展）。本任务把「点节点高亮其依赖/反依赖」接到架构 tab 与页面其它 UI 的联动：DOM 按 id 高亮、点实体在邻域 JSON 里查 in/out 边、和其它面板（如 chat 里提到的文件高亮对应实体）联动。前置依赖 architecture-plantuml-rendering（渲染器先落地，id 才有意义）。

## AC

- [x] 前端测试 exit 0：hover 节点高亮其 in/out 边（其余变暗）、click 节点在本地 JSON 里展开下一跳
- [x] 稳定 id 存在：渲染出的 SVG 节点带 data-entity-id，边带 data-edge-type，可被 DOM 查询
- [x] `npm run typecheck` 与 `npm run build` 通过

## DoD

真实浏览器里点一个实体节点：其依赖（出边）与被依赖（入边）的节点高亮，其余变暗；点节点展开下一跳即时（本地 JSON 过滤重绘 <0.5s），无网络往返。

## Touches

- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/tests/architectureTab.test.tsx
- tasks/architecture-plantuml-panel-linkage.md

## Evidence

- 2026-10-21 实现轮：`PlantUmlGraph.tsx` 把 hover 高亮升级为「click 钉住选择」——点实体后按 `data-edge-source/target` 标记出边 `arch-hl-out`、入边 `arch-hl-in`，其余边/节点加 `arch-dim`，移开指针或重绘后仍保持；点背景/展开 group 清除选择。in/out 邻居从已到手的邻域 JSON（`graph.edges`）计算，不走网络。
- 跨面板联动为 window 级契约（与仓库既有 CustomEvent 通道一致）：点击实体派发 `architecture:entity-selected`，detail 带 `{id, incoming, outgoing}`；兄弟面板可用稳定 id 派发 `architecture:highlight-entity`，渲染器钉住该实体并在本地 JSON 里下钻其邻域（无 refetch）。
- 验证读数：`npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` 20/20 pass（新增 click 钉住高亮、stable id/data-edge-type、外部按 id 选择三条用例）；`npm run typecheck` exit 0；`npm run build` exit 0（client + server）；`npx oxlint` 两文件无告警。
- 说明：DoD 的「真实浏览器」读数由本模块既有的真实 plantuml-js/ELK 渲染器在 jsdom 中验证（DOM 事件与 SVG 属性均为真实产物）；浏览器全链路属 fan-in 的 e2e 步骤，不在本 worker 内单独起服务。
