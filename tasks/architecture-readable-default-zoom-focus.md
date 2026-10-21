---
id: architecture-readable-default-zoom-focus
title: 默认视图改为可读缩放 + 聚焦：缩放下限按最小可读字号，宽高比过大时自动退回折叠
status: todo
labels:
  - feature
parent: null
children: []
extra: {}
depends_on:
  - architecture-overview-adaptive-directory-grouping
---
## Proposal

实测（2026-10-22，Playwright MCP，PC 1440×900）暴露三个缩放层问题：

1. **fit 被下限钳制而失效**：quay 会话图自然尺寸 32880×9860，想要的缩放是 1151/32880≈0.035，被 `MIN_ZOOM_SCALE=0.05`（`svgViewport.ts:33`）钳住，SVG 仍是 1644px 宽，塞进 1151px 面板，「适应视图」之后依然要横向滚动。Explosion 视图 52040×3012（宽高比 17:1）同样被钳。
2. **fit-all 对架构图本身不可读**：好情形（claudecodeui，fit 26%）13px 字体只剩约 3.4px，标签读不出来；5% 时节点无任何标签。
3. **比例失控没有兜底**：画布宽高比远超容器比例时（17:1 vs 1.6:1）用户只得到一条细带。

修法：
- **缩放下限按最小可读字号定**，而不是固定 0.05：常量 `MIN_READABLE_FONT_PX`（如 9px）÷ 渲染字体 13px 得到「可读缩放」；fit 结果低于可读缩放时，不再追求装下全图，而是以可读缩放**聚焦**到种子密度最高的包（复用 `hierarchyIndex` 的包计数与种子标记），并在工具栏提供「全貌 / 聚焦」两个模式切换，默认聚焦。
- **全貌模式**仍可 fit-all，但此时叠加提示「缩放 N% · 放大查看 `<最大的包>` 等 K 个包」，让用户知道自己在看什么而不是一团灰。
- **宽高比兜底**：自然宽高比 / 容器宽高比 > 阈值（默认 6）时，自动退回按目录自适应分组的 Overview（依赖前置任务），并提示「图过宽，已折叠」，而不是画一条细带。
- 仅改变缩放/聚焦与回退逻辑，不改 SVG 结构与 DOM 契约（`data-package-id`、`data-entity-id`、边属性不变），因此 hover/点击下钻/爆炸 LOD 继续工作；聚焦跳转要走已有的 `centerElementInContainer`/焦点保持入口，避免与 `explosionLod` 的焦点包逻辑打架。

## AC

- [ ] `npx vitest run src/modules/architecture/tests/svgViewport.test.tsx` exit 0：缩放下限由最小可读字号推导；低于下限时 `fit` 返回可读缩放而非 0.05；既有 zoom in/out/clamp 用例按新下限更新且不回归
- [ ] `npx vitest run src/modules/architecture/tests/readableZoom.test.tsx` exit 0：fit 低于可读缩放时进入聚焦模式并选中种子密度最高的包；全貌/聚焦切换；宽高比 > 阈值时回退折叠并出现提示；提示文案含包名与计数
- [ ] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0（爆炸 LOD、焦点保持、移动手势用例不回归）；`npm run typecheck` 与 `npm run build` 通过

## DoD

真实 quay 会话在 PC 与 390px 移动视口打开 architecture tab：默认不再是 5% 的灰色一团，而是可读缩放下聚焦在某个包上，节点标签可读；切到「全貌」能看到整图并带「放大查看 …」提示；Explosion 视图画布过宽时自动给出折叠视图而不是 150px 高的细带。

## Touches

- src/modules/architecture/svgViewport.ts
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/hierarchyIndex.ts
- src/modules/architecture/readableZoom.ts
- src/modules/architecture/tests/svgViewport.test.tsx
- src/modules/architecture/tests/readableZoom.test.tsx
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
- tasks/architecture-readable-default-zoom-focus.md