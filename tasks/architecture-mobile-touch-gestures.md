---
id: architecture-mobile-touch-gestures
title: 移动端手势与触摸目标：双指捏合 + 单指拖拽 + ≥44px 按钮 + 点击语义拆分
status: done
labels:
  - feature
parent: null
children: []
extra: {}
---
## Proposal

architecture tab 在移动浏览器上几乎不可用：`PlantUmlGraph.tsx` / `svgViewport.ts` 中 touch/pointer/pinch **零命中**，只有 Ctrl+滚轮（触摸设备没有）与滚动条；工具栏按钮为 `text-[11px] px-1.5 py-0.5`（约 20px 高），远低于 44px 触摸目标。此外单击同时「选中高亮」与「下钻邻域」，触摸上一戳即重排，极易迷失。

修法：
① **手势**——SVG host 设 `touch-action: none`，实现双指捏合缩放（以两指中点为锚）与单指拖拽平移；与既有 `svgViewport.ts`（`fitZoomScale`/`applyZoomScale`/`clampZoomScale`，范围 0.05–4）对接，不另起缩放模型。桌面鼠标行为保持不变。
② **触摸目标**——粗指针（`pointer: coarse`）或 `isShortTouchViewport`（复用 `useDeviceSettings`）下按钮 `min-height: 44px` / 加大内边距，窄屏把缩放/导出/爆炸入口收进溢出菜单。
③ **点击语义拆分**——触摸端单击 = 选中高亮（不重排）；下钻改为显式动作（双击或选中后出现的「Drill in」按钮），避免每次点选都触发 `setView(neighborhood)` 重排。

## AC

- [x] `npx vitest run src/modules/architecture/tests/mobileGestures.test.tsx` exit 0：双指 pinch 改变缩放（锚点为两指中点）、单指拖拽平移、`touch-action` 生效；桌面 wheel 行为不变；pinch 不触发页面缩放
- [x] 触摸目标：粗指针下工具栏按钮命中区 ≥44×44（测试读计算样式或显式属性）；窄屏入口收进溢出菜单且可展开
- [x] 触摸端单击只选中不重排；下钻需显式动作（双击/Drill in 按钮）才切换视图
- [x] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0（既有桌面用例不回归）；`npm run typecheck` 与 `npm run build` 通过

## DoD

真机/移动模拟（375px 竖屏）打开 architecture tab：双指可缩放、单指可拖拽平移、按钮可稳定点中；单击节点只高亮不跳视图，双击或点「Drill in」才下钻——移动端能完成「看全貌 → 放大 → 下钻」的完整路径。

## Touches

- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/svgViewport.ts
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/rendererContract.ts
- src/modules/architecture/hooks/useTouchLayout.ts
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
- tasks/architecture-mobile-touch-gestures.md