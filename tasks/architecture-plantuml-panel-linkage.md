---
id: architecture-plantuml-panel-linkage
title: architecture 稳定 id 跨面板联动：点节点高亮依赖/反依赖 + 展开下一跳
status: todo
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

- [ ] 前端测试 exit 0：hover 节点高亮其 in/out 边（其余变暗）、click 节点在本地 JSON 里展开下一跳
- [ ] 稳定 id 存在：渲染出的 SVG 节点带 data-entity-id，边带 data-edge-type，可被 DOM 查询
- [ ] `npm run typecheck` 与 `npm run build` 通过

## DoD

真实浏览器里点一个实体节点：其依赖（出边）与被依赖（入边）的节点高亮，其余变暗；点节点展开下一跳即时（本地 JSON 过滤重绘 <0.5s），无网络往返。

## Touches

- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/tests/architectureTab.test.tsx
- tasks/architecture-plantuml-panel-linkage.md