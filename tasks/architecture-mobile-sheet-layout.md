---
id: architecture-mobile-sheet-layout
title: 手机布局：单行头部 + 底部抽屉承载范围/详情/搜索/导出 + 画布内缩放簇与缩略图开关
status: todo
labels:
  - feature
parent: null
children: []
extra: {}
depends_on:
  - architecture-toolbar-readout-and-legend
  - architecture-canvas-wheel-zoom-and-drag-pan
  - architecture-minimap
---
## Proposal

评审实测（390×844，`isMobile`+`hasTouch`）：头部已压成一行（File/Entity 切换 + `⋯`），图区占 81%；但范围/详情/导出都被塞进 `⋯`，没有画布内缩放按钮，触摸提示条占两行外加一个关闭键，缩略图在手机上完全没有形态。新的桌面工具栏、画布缩放簇、缩略图合起来，手机需要一个自洽的形态：

1. **头部单行**：`[类图 | 文件]` + 一个 `调节` 按钮（44×44）。读数小标签浮在画布左上角（一行、可点开），不占头部。
2. **底部抽屉（bottom sheet）**：点 `调节` 弹出，承载范围步进器、详情三档、搜索框、导出菜单项、图例；抽屉不遮挡画布的下 40% 以上时可边调边看（`max-height: 45vh`，可下拉关闭，带抓手），调节时画布实时变化。抽屉是标准对话语义（`role="dialog"`、焦点陷阱、关闭后焦点回到触发按钮）。桌面形态不变，只在粗指针/窄屏档位启用（沿用 `useTouchLayout` 的档位判断，不另造断点）。
3. **画布内控件**：右下角 44px 缩放簇（相关任务已提供，这里保证手机形态下尺寸与间距）；缩略图默认收起为一个 44px 小按钮（位于缩放簇上方），点开展示 `96×64` 的缩略图，再点收起。
4. **触摸提示**：首次使用时以画布内一次性的小气泡呈现「单指拖动，双指缩放，双击节点下钻」，3 秒后自动淡出或点击即消，不占独立一行（保持可访问：`role="status"`，可手动关闭，关闭后本地记住）。
5. 命中区：手机上所有架构相关控件 ≥ 44×44；控件间距 ≥ 8px。
6. 图区高度占比（手机）≥ 85%。

## AC

- [ ] `npx vitest run src/modules/architecture/tests/mobileCompactToolbar.test.tsx src/modules/architecture/tests/mobileGestures.test.tsx` exit 0：粗指针档位下头部只有视角切换与 `调节` 两个控件；点 `调节` 出现 `role="dialog"` 抽屉，含范围/详情/搜索/导出；抽屉关闭后焦点回到 `调节` 按钮；抽屉打开时调节范围会更新画布读数；桌面档位不渲染抽屉
- [ ] 同上命令新增用例：触摸提示是画布内气泡而不是独立一行，自动淡出或点击消失并被记住；缩略图默认收起，按钮 ≥ 44×44，点开后出现 `96×64` 缩略图且不与缩放簇重叠
- [ ] 同上命令新增用例：所有架构相关控件命中区 ≥ 44×44、相邻间距 ≥ 8px（以 `getBoundingClientRect` 在 jsdom 注入的尺寸下断言）；图区高度占比断言 ≥ 85%
- [ ] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0（桌面不回归）；`npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` exit 0；`npm run typecheck` 与 `npm run build` 通过

## DoD

真实移动视口（390×844，`isMobile`+`hasTouch`，沿用已记录的 Playwright 做法：一次调用内完成整条流程并传 storageState）打开 quay 会话 architecture tab：头部一行；点 `调节` 弹出抽屉，调范围时图实时变化，抽屉可下拉关闭；右下角有缩放簇与缩略图小按钮；单指拖动与双指缩放可用；首次进入的提示气泡不遮挡节点并自动消失。图区占高 ≥ 85%（贴读数）。PC 视口行为与改前一致。

## Touches

- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/ArchitectureMinimap.tsx
- src/modules/architecture/ArchitectureSheet.tsx (new)
- src/modules/architecture/hooks/useTouchLayout.ts
- src/modules/architecture/tests/mobileCompactToolbar.test.tsx
- src/modules/architecture/tests/mobileGestures.test.tsx
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts
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
- tasks/architecture-mobile-sheet-layout.md