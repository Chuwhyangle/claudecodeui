---
id: architecture-diagram-zoom-fit
title: architecture 图缩放与适应容器：默认 fit + +/−/适应/100% 控件 + Ctrl+滚轮锚点缩放
status: done
labels:
  - feature
parent: null
children: []
extra: {}
---
## Proposal

architecture tab 的图尺寸通常仍很大（plantuml-js 按自然尺寸输出 SVG，例如 overview 1586×1176、组/邻域视图更大），当前容器只有 `overflow-auto`，用户必须滚动且无法缩放到整体。plantuml-js 无任何缩放 API（`dist/*.d.ts` 与 README 中 zoom/pan/scale 0 命中，其自身定位「平移缩放是前端职责」），但 SVG 输出带 `viewBox`，故缩放可在客户端纯 SVG 属性层面实现。

实现：新建渲染器中立的 `svgViewport.ts`（操作任意 SVG 元素，将来上游若要收编可直接搬成 `attachViewport(svg)`），由 PlantUmlGraph 挂载——① 默认「适应容器」：渲染后用容器尺寸按 viewBox 等比缩放（不放大超过 100%），直接解决「图太大必须滚动」；② 工具栏控件 `−` / 百分比 / `+` / `适应` / `100%`；③ Ctrl/Cmd+滚轮以光标为锚点缩放，普通滚轮保持滚动不劫持页面；④ 范围钳制 5%–400%，缩小后居中、放大后容器滚动；⑤ ResizeObserver 在 fit 模式下随容器变化重新适配；⑥ 切视图重置为 fit（新图新自然尺寸）但保留用户选的模式。

缩放只改 SVG 的 `width`/`height` 属性（按 viewBox 换算，矢量保持清晰、滚动 extent 自动正确），不改 DOM 结构——因此既有 `restoreEntityIds`、hover 高亮、点击下钻全部照常工作。不使用 CSS transform（部分浏览器发糊且需手工补偿滚动范围）。

## AC

- [x] `npx vitest run src/modules/architecture/tests/svgViewport.test.tsx` exit 0：fit 计算正确（等比、不放大超 100%）、zoom in/out 按 viewBox 换算 width/height、范围钳制 5%–400%、缩放后 SVG 自然尺寸与滚动 extent 一致
- [x] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0（含新增用例：渲染后默认 fit、点 `+`/`−`/`适应`/`100%` 改变 SVG 尺寸、Ctrl+滚轮缩放、普通滚轮不缩放；既有 hover/click/下钻用例不回归）
- [x] `npm run typecheck` 与 `npm run build` 通过

## DoD

真实浏览器打开 architecture tab（archguard 789 节点邻域）：图默认按容器适应显示、无需先滚动；`+`/`−`/`适应`/`100%` 可用，Ctrl+滚轮以光标为锚点缩放；缩放后 hover 高亮与点击下钻行为不变——用户能在大图上自由放大看细节、缩小看全貌。

## Touches

- src/modules/architecture/svgViewport.ts
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/tests/svgViewport.test.tsx
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
- tasks/architecture-diagram-zoom-fit.md
