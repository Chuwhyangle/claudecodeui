---
id: architecture-explosion-zoom-lod
title: 爆炸图语义缩放：档位显隐 + 焦点保持 + 包级聚合边 + 折叠计数（C+D）
status: ready
labels:
  - feature
parent: null
children: []
extra: {}
depends_on:
  - architecture-hierarchy-nested-packages
  - architecture-diagram-zoom-fit
---
## Proposal

用户裁定：爆炸图按 C + D 做，即**几何连续的语义缩放**——一次完整层级布局、缩放时按档位切换显隐（不重排，位置天然稳定），并保持焦点包居中。

与 plantuml-js 会话实测（789 实体/462 边）：嵌套 full（107 包）布局 1.06s / crossings 732 / nodeIntersect 0，画布 55076×6150。**性能不是风险**，画布过宽由对方「compound 嵌套成比例打包」任务修复（gating，但只有几何变化、DOM 契约不变），故本任务可并行开发、先在小图验证。

实现：① **档位显隐**——按层级深度定义 LOD 档位（包 → 子包 → 实体），缩放跨档时切换 `display`/opacity（不重新渲染），档位间留 5–10% 死区 + 150–250ms 防抖避免边界抖动；② **焦点保持（D）**——跨档时把焦点包（用户点选或居中项）的 rect 滚回视口中心，避免「跳到哪里去了」；③ **包级聚合边**——远档隐藏实体边，按端点 → 最内层包聚合成加权包边（带 ×N 标签）叠一层，客户端计算（plantuml-js 确认客户端做更省事）；④ **折叠态计数标签**——远档包框标签改写为 `modules/chat (37)`，计数来自层级索引。

复用已完成的 `svgViewport.ts`（`fitZoomScale`/`applyZoomScale`/`clampZoomScale`，min 0.05 / max 4）作为缩放底座；显隐与聚合只操作既有 DOM（`data-package-id`、`data-entity-id`、`data-edge-source/target/type`），不改 SVG 结构。

风险登记：若 plantuml-js 的成比例打包迟迟不落地，全量视图仍会是一张 55k 宽的图；届时本任务的档位/焦点/聚合逻辑仍可工作，但「爆炸体验」受限——不要在本任务内自研布局引擎去绕过。

## AC

- [ ] `npx vitest run src/modules/architecture/tests/explosionLod.test.tsx` exit 0：档位计算（缩放因子 → 层级深度，含死区与防抖）、跨档只切显隐不触发重渲染、焦点包保持居中、折叠标签显示 `(N)` 计数
- [ ] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0：既有 hover/click/下钻/缩放用例不回归；新增用例覆盖远档显示包级聚合边、近档显示实体 UML 边
- [ ] `npm run typecheck` 与 `npm run build` 通过

## DoD

真实浏览器（archguard 789 节点邻域）打开 architecture tab：缩小看到包级爆炸图（包框带 `(N)` 计数与加权包边），放大连续展开到子包、再到实体 UML 关系图，**全程不重新布局、焦点包不跑丢**；hover/点击下钻与既有缩放控件行为不变。

## Touches

- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/svgViewport.ts
- src/modules/architecture/hierarchyIndex.ts
- src/modules/architecture/explosionLod.ts
- src/modules/architecture/tests/explosionLod.test.tsx
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
- tasks/architecture-explosion-zoom-lod.md