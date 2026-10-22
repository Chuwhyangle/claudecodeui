---
id: architecture-canvas-wheel-zoom-and-drag-pan
title: 画布交互：滚轮直接缩放、左键/中键拖动平移、键盘平移缩放、缩放簇移进画布右下角
status: ready
labels:
  - feature
parent: null
children: []
extra: {}
---
## Proposal

评审结论：桌面上缩放只认 Ctrl/Cmd+滚轮（`PlantUmlGraph.tsx` 的 wheel 处理在没按修饰键时直接 return，滚轮会去滚页面），也没有拖动平移；缩放按钮在工具栏、离图很远。用户明确的交互约定：**滚轮（鼠标中间那个轮子）缩放；画面可拖动；手机双指缩放、单指拖动**。

1. **滚轮缩放**：在画布上直接滚轮即以光标为锚点缩放（沿用 `svgViewport.ts` 的锚点缩放与 `ZOOM_STEP`、`MIN/MAX_ZOOM_SCALE`），不再要求 Ctrl/Cmd；Ctrl/Cmd+滚轮保持同样行为（触控板捏合产生的 `ctrlKey` wheel 继续可用）。画布是滚轮的唯一消费者，`preventDefault` 防止页面滚动；画布外的滚轮不受影响。`deltaMode` 归一与既有的 level 回写节流保持。
2. **拖动平移**：在画布空白处按住**左键**拖动平移；**中键**拖动同样平移；拖动超过 4px 才算拖动（避免吞掉节点点击/双击下钻）；按在节点上的左键不触发平移，仍是选择/下钻。拖动时光标 `grab/grabbing`；拖动过程用 pointer capture，移出画布不丢事件。惯性不做。
3. **键盘**：画布获得焦点（`tabIndex=0`，焦点环清晰）后：方向键平移、`+`/`-` 缩放、`0` 适应、`1` 实际大小；不与全局快捷键冲突（遵守「聊天页全局 Escape 会 abort」的既有约束，Escape 不绑定）。
4. **缩放簇进画布**：`＋ − 适应` 三个按钮 + 百分比读数合成一个竖排簇，浮在画布右下角（桌面 32px 命中区，手机 44px），`role="group"` 带可访问名；工具栏里原有的缩放按钮删除。「Focus/Explosion」档位指示只保留一处并挨着簇显示。
5. **手机**：单指拖动平移、双指捏合缩放、双击下钻——现状已有（`useTouchLayout` + 手势控制器），本任务只保证它们与新的拖动/滚轮路径共用**同一个**视口控制器，不出现两套状态；`touch-action: none` 保持。
6. 不改 SVG/DOM 契约；hover 高亮、下钻、爆炸 LOD、焦点保持继续工作。

## AC

- [x] `npx vitest run src/modules/architecture/tests/svgViewport.test.tsx src/modules/architecture/tests/architectureTab.test.tsx` exit 0：无修饰键的 wheel 事件在画布上改变缩放且 `defaultPrevented === true`；deltaY 方向对应放大/缩小；以光标为锚点（锚点下的 viewBox 坐标缩放前后不变）；Ctrl+wheel 行为不回归；画布外的 wheel 不被拦截
- [x] 同上命令新增用例：左键在空白处拖动超过阈值后滚动偏移变化；中键（`button === 1`）拖动同样平移；在节点上按下不平移且单击/双击下钻不回归；拖动小于 4px 视为点击；`pointercancel` 后不残留拖动状态
- [x] 同上命令新增用例：画布聚焦后方向键/`+`/`-`/`0` 生效，Escape 不被消费；缩放簇在画布内（DOM 上位于画布容器之内）且工具栏里不再有缩放按钮；簇按钮命中区 PC ≥ 32px、触摸 ≥ 44px
- [x] `npx vitest run src/modules/architecture/tests/mobileGestures.test.tsx` exit 0（触摸手势与新路径共用控制器，既有用例不回归）；`npm run typecheck` 与 `npm run build` 通过

## DoD

真实浏览器（PC）打开 quay 会话 architecture tab：滚轮在图上缩放、以光标为中心；左键拖空白处图跟着走，中键拖动也一样；点击节点仍然选中/下钻；缩放按钮在画布右下角。手机视口（390×844，`isMobile`+`hasTouch`）下单指拖动、双指缩放仍然可用，右下角有 44px 缩放簇。证据是操作前后 SVG 偏移/缩放读数与截图。

## Touches

- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/svgViewport.ts
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/hooks/useTouchLayout.ts
- src/modules/architecture/tests/svgViewport.test.tsx
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/architecture/tests/mobileGestures.test.tsx
- src/modules/architecture/tests/mobileCompactToolbar.test.tsx
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
- tasks/architecture-canvas-wheel-zoom-and-drag-pan.md
