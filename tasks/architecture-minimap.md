---
id: architecture-minimap
title: 画布角落缩略图：全图缩影 + 当前可见范围框，点击/拖框快速定位
status: done
labels:
  - feature
parent: null
children: []
extra: {}
depends_on:
  - architecture-canvas-wheel-zoom-and-drag-pan
---
## Proposal

评审实测：Entity 图的自然尺寸可达 49052×6930（1045 个框），用户在大图里没有任何「我在哪」的参照，只能靠滚动条盲找。VS Code 一类产品的经验是：角落放一张缩略图，框出当前可见范围，点击或拖框即可快速移动视野。本任务实现它：

1. 新组件 `src/modules/architecture/ArchitectureMinimap.tsx`：固定在画布右下角、缩放簇的左侧或上方（不遮挡簇），PC 默认 `160×100`，保持图的宽高比并 letterbox。
2. **绘制用节点矩形，不克隆 SVG**：从渲染后的 SVG 读出每个 `.uml-node` 的 bbox（一次读取，随图重排才重读），用一张 `<canvas>` 画成小矩形；包/组框画成淡色大矩形；种子节点用强调色。大图（千级节点）也只是千次 `fillRect`，不进入 React 渲染树。
3. **可见范围框**：由视口控制器（缩放 + 滚动偏移）派生，随缩放/平移实时更新（`requestAnimationFrame` 合并）。
4. **交互**：点击缩略图把视野中心移到该点；拖动范围框平移视野；指针事件与画布的拖动/滚轮互不干扰（缩略图上的滚轮不缩放主图）。键盘：缩略图可聚焦，方向键移动视野。
5. **显隐**：图能被一屏装下（适应后缩放 ≥ 100%）时不显示；缩略图右上角有收起按钮，收起状态按本地存储记忆；手机视口默认收起，只露一个 44px 的小按钮（展开形态由手机布局任务统一安排）。
6. 无障碍：`role="img"` 加可访问名（「图概览，当前视野占 X%」），可聚焦；颜色之外用线宽区分范围框。

## AC

- [x] `npx vitest run src/modules/architecture/tests/minimap.test.tsx` exit 0（新文件）：给定节点矩形集合与视口，范围框的位置/大小换算正确（含缩放、偏移、letterbox）；点击缩略图后主视口中心移到对应点；拖动范围框改变偏移且被钳制在图范围内；图一屏装得下时不渲染
- [x] 同文件：1000 个节点矩形的绘制只发生一次读取与一轮 `fillRect`（以注入的 canvas 上下文 mock 计数），缩放/平移只重画范围框而不重画节点（计数不变）
- [x] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0：缩略图在画布容器之内、不与缩放簇重叠（bounding box 不相交）；收起后再展开状态被记忆；既有用例不回归
- [x] `npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` exit 0；`npm run typecheck` 与 `npm run build` 通过

## DoD

真实浏览器（PC）打开 quay 会话 architecture tab（Entity 视角，大图）：右下角出现缩略图，能看出整图形状；平移/缩放时范围框实时跟随；点缩略图上远处的一点，主视野立刻跳过去；拖范围框能连续移动。缩略图与缩放簇不重叠。贴操作前后截图与范围框读数。

## Touches

- src/modules/architecture/ArchitectureMinimap.tsx (new)
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/svgViewport.ts
- src/modules/architecture/tests/minimap.test.tsx (new)
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
- tasks/architecture-minimap.md