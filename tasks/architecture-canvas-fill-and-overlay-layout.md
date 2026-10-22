---
id: architecture-canvas-fill-and-overlay-layout
title: 画布布局修复：画布占满可用高度；读数与缩放档位并成画布上方一行（不再盖住图的第一行）；角落浮层让图避让并垂直居中
status: ready
labels:
  - feature
parent: null
children: []
extra: {}
---
## Proposal

2026-10-22 用 MCP 浏览器在真实会话（archguard 项目、claudecodeui 项目，视口 1440×765）复现并量到三处布局缺陷，它们来自已落地的工具栏/读数/缩放簇/缩略图任务，各自只在 jsdom 里测过内联样式，没有任何一处断言过真实几何。

### 一、画布没有占满高度（根因已定位）

量到的数据：可用区域 669px，画布 342px，下面 327px 空白。祖先链：画布 `div.h-full`（342）→ `relative min-h-0 flex-1`（块级，342）→ `flex h-full min-h-0 flex-col`（PlantUmlGraph 根，`flex: 0 1 auto`，342）→ `relative min-h-0 flex-1`（块级，342，即 `graphAreaRef`）→ **`relative min-h-0 flex-1 overflow-hidden`（`display: block`，669）**。最后这一层 `ArchitecturePanel.tsx` 第 1278 行附近是块级容器，它里面的 `flex-1` 不生效，`h-full` 对自动高度的父级也不生效，于是整条链退化成「内容高度」。本轮早些时候的截图里画布是占满的（666px），这是后来落地的工具栏重构引入的回归；没有逐提交二分，以代码和实测为准。

修法：把这一层改成 flex 列（`flex min-h-0 flex-col`），并保证其下每一个带 `flex-1` 的元素的父级都是 flex 容器、每一个带 `h-full` 的元素的父级都有确定高度。

### 二、浮层盖在图的第一行上

量到的数据：读数标签 `[301,108,721,27]`、缩放档位条 `[704,108,724,39]`，SVG 第一行顶端也是 y=108（画布内边距 12px，浮层 `top: 12`，没有给浮层留空间）。右下角的缩略图与缩放簇同理，会盖住图的右边缘。

修法：
1. **读数标签与缩放档位条合并成画布上方的一行**，正常文档流（不是 `position: absolute`），高度约 28px：左侧读数（可点开），右侧缩放档位（Focus/Overview/Explosion 与缩放百分比）；行内可换行但不得超过两行，档位条里原先的长文案（`…zoom in on data/home/yale/work/archguard/src/cli/mcp and 62 other package(s)`）改为只显示包的短名（路径最后两段），超长以省略号截断，`title` 给全名。手机/粗指针档位同样在文档流里占一行，不再浮在图上。
2. **缩略图与缩放簇仍然浮在画布右下角**（地图类产品的惯例），但 `fit` 要避让它们：在 `svgViewport.ts` 增加纯函数 `fitAvoidingCorners(diagramSize, hostSize, corners)`，若适应后的图与任一角落浮层的矩形相交，则取不相交的最大缩放值；不相交时与改前结果逐字相同。
3. **图在画布里垂直居中**（宽而矮的图不再贴着顶端，把大片空白留在底部）；水平方向保持现状。

### 三、不改的东西

读数里的数字与措辞由相关任务处理，本任务只搬位置、不改文案；SVG/DOM 契约（`data-entity-id`、`data-package-id`、`uml-node`）不变；停靠区、检查器等后续功能不在本任务内。

## AC

- [ ] `npx vitest run src/modules/architecture/tests/canvasLayoutContract.test.tsx` exit 0（新文件）：沿画布的祖先链向上到面板根，凡带 `flex-1` 类的元素，其父元素必带 `flex` 类（结构不变量，防止再出现块级父级里的 `flex-1`）；凡带 `h-full` 的元素，其父元素或为 flex 容器、或带确定高度的类；读数与缩放档位位于画布之前的同一行容器内，且该行容器及其子元素都不是 `position: absolute`；缩略图与缩放簇仍是绝对定位的角落浮层
- [ ] `npx vitest run src/modules/architecture/tests/svgViewport.test.tsx` exit 0：`fitAvoidingCorners` 在不相交时与 `fitZoomScale` 结果逐字相同、相交时返回使图与角落矩形不相交的最大缩放值、多个角落同时存在时取最保守值、角落比画布还大时退化为原 fit 而不抛错；既有用例不回归
- [ ] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx src/modules/architecture/tests/mobileCompactToolbar.test.tsx src/modules/architecture/tests/mobileGestures.test.tsx src/modules/architecture/tests/readableZoom.test.tsx` exit 0：缩放档位条里的包名只显示最后两段且带 `title` 全名；既有用例不回归（档位条与读数的位置断言已改为「在画布上方的一行里」，改动逐处列在实施记录）
- [ ] `npm run typecheck` 与 `npm run build` 通过

## DoD

真实浏览器（1440×765 与 390×844）打开 archguard 项目的会话 `/session/f3a974c3-510c-4761-ba48-96dff3d5220c` 的 architecture tab：画布的底边贴着面板底边（用 `getBoundingClientRect` 读画布高度与可用高度，贴两个数，画布 ≥ 可用高度的 95%）；读数与缩放档位在画布上方的一行里，图的第一行不再被遮挡（读 SVG 首行顶端与该行底端，前者不小于后者）；缩略图与缩放簇不与图相交；宽而矮的图在画布里垂直居中。再打开 claudecodeui 项目的会话复测一次。证据是几何读数与前后截图，不是「测试绿了」。

## Touches

- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/ArchitectureMinimap.tsx
- src/modules/architecture/svgViewport.ts
- src/modules/architecture/readableZoom.ts
- src/modules/architecture/tests/canvasLayoutContract.test.tsx (new)
- src/modules/architecture/tests/svgViewport.test.tsx
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/architecture/tests/mobileCompactToolbar.test.tsx
- src/modules/architecture/tests/mobileGestures.test.tsx
- src/modules/architecture/tests/readableZoom.test.tsx
- tasks/architecture-canvas-fill-and-overlay-layout.md