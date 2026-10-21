---
id: architecture-renderer-contract
title: architecture 渲染器契约解耦：固化 JSON 邻域 schema + 渲染器无关接口，为 plantuml-js 插拔做准备
status: done
labels:
  - feature
parent: null
children: []
extra: {}
---
## Proposal

换 plantuml-js 的前置是「渲染器可插拔」。当前 ArchitecturePanel 直接耦合 CytoscapeGraph 及其特定 props（createRenderer 注入 cytoscape 实例），换渲染器要改面板。本任务在 plantuml-js 发布前做解耦：① 后端固化 JSON 邻域 schema（nodes 带 id/label/distance、edges 带 from/to/relationType，type 字段预留可选），作为渲染器的输入契约；② 前端定义渲染器无关的接口（graph + onNodeClick/onNodeHover 回调），CytoscapeGraph 适配到该契约，PlantUmlGraph 将来实现同一契约。收益：plantuml-js 发布后换渲染器是「新实现一个契约」，不是「改 ArchitecturePanel」。不依赖 plantuml-js 发布，现在就能做。

## AC

- [x] 后端 JSON 邻域 schema 有导出类型 + 测试钉住字段（node 的 id/label/distance、edge 的 from/to/relationType；type 字段预留可选不破坏旧数据）
- [x] 前端渲染器契约类型定义（渲染器无关 props），ArchitecturePanel 只依赖契约、不再 import cytoscape 具体类型
- [x] 前端测试 exit 0：现有 cytoscape 渲染测试在适配层下不回归；`npm run typecheck` 通过

## DoD

ArchitecturePanel 的 props/回调只依赖渲染器契约类型（不 import cytoscape），CytoscapeGraph 是契约的一个实现；后端邻域 JSON schema 有类型 + 测试钉住——plantuml-js 发布后新增 PlantUmlGraph 实现同一契约即可接入，不动面板与后端。

## Touches

- server/modules/architecture/generator.ts
- server/modules/architecture/tests/architecture-routes.test.ts
- src/modules/architecture/useArchitectureGraph.ts
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/CytoscapeGraph.tsx
- src/modules/architecture/rendererContract.ts
- src/modules/architecture/tests/architectureTab.test.tsx
- tasks/architecture-renderer-contract.md