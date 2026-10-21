---
id: architecture-mobile-compact-toolbar
title: 移动端精简布局：工具栏合并为一行、去掉 hover 提示、hops 带文字，图区占满剩余高度
status: ready
labels:
  - feature
parent: null
children: []
extra: {}
---
## Proposal

实测（2026-10-22，Playwright MCP，390×844，`isMobile`+`hasTouch`、`pointer: coarse`）：触摸目标已达 44px、`touch-action: none` 已生效、整页无横向溢出——这些保持不变。但**工具栏吃掉约 40% 屏幕**：图区（`[data-architecture-plantuml]`）高 521px，顶部 323px 都是工具栏；panel 总高 799px。逐项问题：

1. 标题行 + 粒度切换、hops「1 2 3」、honesty 栏、hover 提示栏、手势提示 + Overview 标签、「5% … 242 of 312 nodes」行，一共 **6 行**，各自占一行。
2. **hover 提示在触摸设备上没有意义**：`ArchitectureHoverBar` 显示「Hover a node for its relation types; click a node to expand its next hop.」，与其下一行触摸提示「Tap a node to select it; drag to pan and pinch to zoom. Double-tap or choose Drill in…」互相矛盾。
3. **hops「1 2 3」没有任何文字说明**，PC 与移动端都一样，用户不知道这是什么。

修法（复用已有 `useTouchLayout` 的 `coarsePointer`/`compactToolbar`，`ArchitecturePanel.tsx:219`，不另起检测）：
- **紧凑模式下工具栏合并为一行**：标题 + 粒度切换 + 「…」菜单；hops、honesty（快照时间、未解析种子数、截断提示）、导出、Explosion、缩放控件全部进「…」菜单或折叠成一个可展开的摘要行（默认收起，点开才显示），截断提示只在真正截断时才以紧凑徽标露出。
- **粗指针（`pointer: coarse`）下不渲染 hover 提示栏**，只保留触摸提示，且触摸提示做成一次性/可关闭的小提示，而不是常驻一整行。
- **hops 旋钮加文字**：PC 与移动端都改为「跳数 1 / 2 / 3」（`aria-label` 同步，12 个 locale）。
- 图区 `flex-1` 占满剩余高度，目标：375–390px 宽、844px 高的竖屏下图区 ≥ 70% 屏幕高度。
- 桌面行为不变（工具栏布局保持），仅 hops 文字化两端共享。

## AC

- [x] `npx vitest run src/modules/architecture/tests/mobileCompactToolbar.test.tsx` exit 0：紧凑模式下工具栏只有一行（标题/粒度/「…」）；hops、honesty、导出、缩放控件可在「…」菜单里找到；粗指针下无 hover 提示栏；hops 控件带可读文字与 `aria-label`
- [x] 触摸目标不回归：粗指针下所有可点控件命中区 ≥44×44（沿用 `mobileGestures.test.tsx` 既有断言）；截断提示在真正截断时仍可见
- [x] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0（桌面用例不回归）；`npm run typecheck` 与 `npm run build` 通过

## DoD

真实移动视口（390×844）打开 quay 会话的 architecture tab：工具栏只占顶部一行，图区高度 ≥ 70% 屏幕；没有「Hover a node…」提示；hops 控件旁有「跳数」文字；点「…」可看到 honesty 信息、hops、导出与缩放控件。PC 视口布局与行为不变（hops 文字化除外）。

## Touches

- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/hooks/useTouchLayout.ts
- src/modules/architecture/tests/mobileCompactToolbar.test.tsx
- src/modules/architecture/tests/mobileGestures.test.tsx
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
- tasks/architecture-mobile-compact-toolbar.md