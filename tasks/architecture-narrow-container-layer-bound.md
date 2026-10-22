---
id: architecture-narrow-container-layer-bound
title: 窄容器用 layerBound 收窄 flat 布局（elk.aspectRatio 在单连通 flat 图上是空操作，实测逐像素相同）
status: ready
labels:
  - feature
parent: null
children: []
extra: {}
---
## Proposal

2026-10-22 查清「移动端布局不按容器比例」的根因：`elk.aspectRatio` 在我们实际递给 ELK 的 flat 单连通图上是**空操作**。用 quay 真实图（321 个 file 节点 → Overview 18 个组框 / 17 条边，当前 main checkout 代码）五次渲染：

- ratio = default / 1.6 / 1.0 / 0.6 / 0.4 → 结果**逐像素相同** `1607×582`（aspect 2.76，7 行，最宽行 6 个节点 / 1551px），22–44ms。
- 注入确认到达 ELK：根与每个 child 收到的 layoutOptions 都是 `{"elk.aspectRatio":"0.4","elk.layered.wrapping.strategy":"2", …}`（在 `createLayoutEngine` 的注入点之后探针读出）。所以不是接线问题，是它只对**不连通分量的打包**起作用；整张图是一个连通分量时无从下手，`wrapping.strategy=2` 在单层/少层宽图上也没折行。
- `COFFMAN_GRAHAM` + `elk.layered.layering.coffmanGraham.layerBound` 立即生效：bound=2 → `578×1006`（aspect 0.57，43ms）；bound=3/4 → `892×794`（1.12）。`computeLayoutMetrics` 同图：crossings 2→2（无回归），totalEdgeLength 11752→9192，areaUtilization 0.157→0.187，edgeNode 0、textOverflow 0。

即：`elkAspectEngine.ts` 现在的 `WRAPPING_LAYOUT_OPTIONS` 对我们是死代码，窄容器（手机 390×844 量得 0.53）拿到的仍是 2.76 的宽图，于是可读缩放下限把「适应」变成「只显示左 44%」（这是 `architecture-mobile-fit-label-and-hint-overlay` 记录的现象的上游原因）。

修法：

1. 在 `withAspectHint` 里按容器比例派生 `layerBound`：窄容器（ratio 明显 < 1）→ 小 bound；宽容器 → 不设（保持现有默认）。公式用实测标定（先按 `bound ≈ clamp(round(sqrt(ratio * N * 0.25)), 1, N)` 起步，用 18/40/120 节点的三张真实形态图各测一遍再定），并把 N（当前层叶子节点数）从图里数出来，不猜。
2. **只在叶子层加**：当某层的 children 全是叶子（没有孙节点）时才设 `COFFMAN_GRAHAM`。嵌套/复合层继续只带 `elk.aspectRatio` —— 早先记录过 CG+layerBound+`INCLUDE_CHILDREN`+ratio 1.6 触发 `TypeError: Cannot read properties of undefined (reading 'c')`；本次复测嵌套层 CG 不崩但耗时 670ms → 2389ms，不该替上游背这个。
3. 每次加 bound 时必须比 crossings / totalEdgeLength / areaUtilization：bound 让 crossings 变多或让可读性变差就不采用（回退到只有 aspectRatio 的路径），并在实施记录里贴两组读数。
4. 顺手订正该模块注释里的版本读数：写在 `elkAspectEngine.ts:15/32` 的「0.1.0」与实测不符——本机 `dist` 与 registry **0.2.0** tarball 逐字节相同（0.2.2 的对应 dist 也相同），注释按 0.2.x 写；不改任何行为常量。
5. 不改 `clampAspectRatio` 的 0.4–3 带与 15% 重排阈值；`shouldRelayoutForAspect` 的既有读数不变。

## AC

- [x] `npx vitest run src/modules/architecture/tests/layoutAspect.test.tsx` exit 0：新增用例断言「宽/窄两种容器比例下，叶子层拿到的 layoutOptions 含按比例派生的 `coffmanGraham.layerBound`，复合层不含 `COFFMAN_GRAHAM`」，并保留既有「ratio 到达布局」「结构等价」「15% 阈值 + 250ms debounce」用例不回归
- [x] 同文件或新增用例用真实形态 fixture（18 个组框 + 17 条边）断言：ratio=0.4 时渲染 viewBox 宽高比 < 0.9，ratio=null 时与改动前逐字节相同（`1607×582` 或当前真值，实施时以改前实测为准并写进断言消息）；同时断言 crossings 不高于 baseline、totalEdgeLength 不高于 baseline（用 `computeLayoutMetrics`）
- [x] 嵌套形态（hierarchy 视图，26 个 package）不加 `COFFMAN_GRAHAM`，且渲染不抛错；`npx vitest run src/modules/architecture/tests/archguardToPlantUml.test.ts` 与 `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0
- [x] `npm run typecheck` 与 `npm run build` 通过

## DoD

真实移动视口（390×844，`isMobile`+`hasTouch`）打开 quay 会话的 architecture tab（Overview 与任一 group 视图各一次）：图的自然宽高比落在 0.5–1.2 区间（改前是 2.76），在可读缩放下限之上即可装下大部分图，不再需要左右拖才能看全一行；PC 视口下布局与改前一致（ratio 2.5 时不出 `layerBound`，截图对照）。证据是两次渲染的 viewBox 读数 + 截图，不是「测试绿了」。

不放水：不为了让读数变窄而降低字体/节点尺寸、不改 `MIN_ZOOM_SCALE`、不把 `OVERVIEW_GROUP_LIMIT` 调小充当布局修复。

## Touches

- src/modules/architecture/elkAspectEngine.ts
- src/modules/architecture/tests/layoutAspect.test.tsx
- src/modules/architecture/PlantUmlGraph.tsx
- tasks/architecture-narrow-container-layer-bound.md