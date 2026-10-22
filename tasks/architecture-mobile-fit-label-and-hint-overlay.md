---
id: architecture-mobile-fit-label-and-hint-overlay
title: 移动端小修：「适应」文案与真实行为一致，触摸提示不再遮挡图
status: todo
labels:
  - feature
parent: null
children: []
extra: {}
---
## Proposal

2026-10-22 复测（390×844，`isMobile`+`hasTouch`，quay 会话 e2dd27de）发现两处移动端小问题：

1. **「Fit to view」名不副实。** 面板状态是 `zoomMode: fit`，但 SVG 宽 882px、视口只有 390px，只显示图的左侧约 44%。原因是「可读缩放下限」（`readableZoom.ts`，`PlantUmlGraph.tsx:1027` 附近的 fit 逻辑）在起作用：fit 结果低于最小可读缩放时，按可读缩放聚焦而不是真的装下全图。行为本身合理，但按钮文案（`architecture.plantuml.zoomFit` = 「Fit to view」，`PlantUmlGraph.tsx:1224`）与 `aria-pressed`/`data-architecture-zoom-mode="fit"` 都仍说 fit，用户以为已装下全图、实际被裁掉了一半。
2. **触摸提示浮层盖住图的顶部节点。** `ArchitecturePanel.tsx:504` 的 `data-architecture-touch-hint` 是叠在图区上方的可关闭浮层，首次进入时遮住最上面一行节点（实测遮住 `quay/dist`、`gate-scripts` 等）；关闭按钮 44px，但默认状态就遮挡内容。

修法：
- **文案与状态一致**：当可读缩放下限生效（fit 未能装下全图）时，缩放模式在界面上显示为「聚焦」而不是「适应」——`aria-pressed`、`data-architecture-zoom-mode`（新增值或附加属性，既有测试读数不能被悄悄改义，新读数一律可选）、按钮文案同步；并在工具栏给出一句「已按可读缩放聚焦，点『全貌』查看整图」的提示。整图装得下时仍叫「适应」，行为不变。
- **提示不遮挡**：触摸提示不再覆盖图区内容——放到图区之外（工具栏下方、占位高度由内容撑开且可收起），或首次出现后自动淡出（保持可手动关闭、不丢可访问性：`role="status"`/可聚焦的关闭按钮）；二者择一，实现时看哪个对 44px 触摸目标和图区高度（≥70% 屏幕）影响更小。
- 桌面行为不变。

## AC

- [ ] `npx vitest run src/modules/architecture/tests/readableZoom.test.tsx` exit 0：可读缩放下限生效时模式读数为聚焦且文案/`aria-pressed` 同步；整图装得下时仍为「适应」；既有可读缩放用例不回归
- [ ] `npx vitest run src/modules/architecture/tests/mobileCompactToolbar.test.tsx` exit 0：触摸提示不与图区重叠（提示的 bounding box 不覆盖 `[data-architecture-plantuml]` 的上缘，或首次出现后自动淡出并保持可手动关闭）；图区高度占比 ≥70% 的既有断言不回归；关闭按钮命中区 ≥44×44
- [ ] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0（桌面用例不回归）；12 个 locale 的新文案键齐全；`npm run typecheck` 与 `npm run build` 通过

## DoD

真实移动视口（390×844）打开 quay 会话的 architecture tab：按钮不再在「只显示左 44%」时说「适应视图」，而是「聚焦」并附带切到「全貌」的提示；触摸提示不遮挡顶部节点。PC 视口行为与文案不变。

## Touches

- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/readableZoom.ts
- src/modules/architecture/tests/readableZoom.test.tsx
- src/modules/architecture/tests/mobileCompactToolbar.test.tsx
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
- tasks/architecture-mobile-fit-label-and-hint-overlay.md