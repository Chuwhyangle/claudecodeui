---
id: architecture-cytoscape-dynamic-rendering
title: cytoscape 力导向渲染 + 前端 maxNodes/maxHops 即时调节，服务端返回带 distance/relationType
  的邻域 JSON
status: done
labels:
  - feature
parent: null
children: []
extra: {}
depends_on:
  - architecture-seed-source-tiering
---
## Proposal

数据（2026-10-21）：quay/archguard 大项目的真实会话 1 跳邻域 300–1000，mermaid flowchart 在该量级布局退化；当前 maxNodes=200 截断在服务端、前端无调节。改为：服务端返回「带 distance 与 relationType 的邻域子图 JSON」（宽松上限 2 跳 / 2000 节点），前端换 cytoscape 力导向渲染，maxNodes/maxHops 滑条前端即时过滤重排（零网络往返），支持 hover/拖拽/缩放/点击展开下一跳。.mmd 保留为导出旁路、不再做默认渲染。依赖种子治理任务先落地，否则只是漂亮地渲染噪声。

## Plan

1. 服务端 generator：新增 JSON 输出（nodes 带 id/label/distance、edges 带 from/to/relationType），与现有 .mmd 并存；宽松上限替代 200 截断。
2. 服务端 routes/service：响应增加邻域 JSON 字段，缓存 key 与现有保持一致。
3. 前端 ArchitecturePanel：换 cytoscape 组件渲染 JSON；maxNodes/maxHops 滑条即时过滤；hover/拖拽/缩放/点击展开下一跳。
4. 测试：服务端 JSON schema 测试、前端滑条即时性测试；i18n 新文案（其余 locale 同步）。

## AC

- [x] 服务端测试 exit 0：JSON 输出含 distance/relationType，宽松上限下不丢边、distance 正确
- [x] 前端测试 exit 0：滑条调节不重新 fetch（本地过滤）、cytoscape 渲染节点可 hover/点击展开
- [x] `npm run typecheck` 与 `npm run build` 通过

## DoD

真实大项目会话（quay 仓库）在浏览器打开 architecture tab：cytoscape 力导向渲染邻域，maxNodes/maxHops 滑条即时调节无网络往返，节点 hover 显示关系类型、点击展开下一跳，且 .mmd 仍可导出。

## Touches

- server/modules/architecture/generator.ts
- server/modules/architecture/service.ts
- server/modules/architecture/routes.ts
- server/modules/architecture/tests/architecture-routes.test.ts
- package.json
- package-lock.json
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/useArchitectureGraph.ts
- src/modules/architecture/CytoscapeGraph.tsx
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/i18n/locales/en/common.json
- src/modules/i18n/locales/de/common.json
- src/modules/i18n/locales/es/common.json
- src/modules/i18n/locales/fr/common.json
- src/modules/i18n/locales/id/common.json
- src/modules/i18n/locales/it/common.json
- src/modules/i18n/locales/ja/common.json
- src/modules/i18n/locales/ko/common.json
- src/modules/i18n/locales/ru/common.json
- src/modules/i18n/locales/tr/common.json
- src/modules/i18n/locales/zh-CN/common.json
- src/modules/i18n/locales/zh-TW/common.json
- tasks/architecture-cytoscape-dynamic-rendering.md
