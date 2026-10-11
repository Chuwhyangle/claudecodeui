---
id: gap-quay-tab-three-timelines-share-no-time-axis
title: Quay tab 三张时间图各用各的时间基：同一快照下 Loop pulse 3.00h / Tests 1.77h / Fan-in
  0.82h，且后两者按自身记录自适应、无轴标——改为共用一条显式时间轴与轴标
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-quay-tab-window-switch-unmounts-the-whole-panel
---
## Proposal

Quay tab 的三张时间图在同一份快照下**各用各的时间基**，横向无法比较（2026-10-11 实测同一份 3h 快照）：

| 图 | 量到的时间跨度 | 轴标 | 缩放 |
|---|---|---|---|
| Loop pulse | `00:33:32 → 03:33:32` = **3.00h**（固定 1/3/6/12h 数据窗口） | 有（起止时刻） | 600 宽 viewBox，等比 |
| Tests | `01:36:57 → 03:23:17` = **1.77h** | 无 | `preserveAspectRatio="none"` 横向拉伸 |
| Fan-in | `02:34:00 → 03:23:20` = **0.82h** | 无 | 同上 |

根因：`src/modules/quay/TimelineBar.tsx` 用**自己那组记录的 `min(start)..max(end)`** 当窗口（`windowStart = Math.min(...ranges.map(r => r.startMs))`），而这组记录是「最近 10 条」这个固定条数（`QUAY_RECENT_LIST_LIMIT = 10`，`server/modules/quay/quay.service.ts`）——于是 Tests 的窗口随轮次老化**悄悄改比例**，Fan-in 同理，而切 1h/12h 对它们**毫无影响**（同一份快照下三张图的端点相差可达 2h 以上）。再叠加「两卡无轴标、无 now 标记、拉伸模式还与甘特图不同」，同一时刻在三张图上的 x 位置必然不同，读者无法横向对齐比较。

本任务给三张图一条**共享的时间轴契约**：把快照的窗口（`windowStartMs` / `nowMs`，来自 `snapshot.gantt` 的 `windowHours` + `nowMs`）作为显式入参传进时间轴组件（不再各自自适应），三张图同一个 x 映射、同一个缩放模式、同一套「起止时刻 + now 竖线」轴标；窗口外的 round / fan-in attempt 由消费侧裁剪掉，让三张图真的是同一段时间切片。

<!-- dedup-ref -->
去重（按机制，立案前检索）：`gap-quay-panel-stage-goals-tests-fanin-cards`（done）交付的是 Tests / Fan-in 两张卡本身（含最初的 `TimelineBar`），本任务改的是**它们的时间基与轴标**；`gap-quay-tab-loop-pulse-gantt-integration`（done）交付的是甘特图卡片。两者都 done，机制不同，不是重复。合并候选检查（quay 插件的 `scripts/dist/task-granularity-advice.js`，即 `${CLAUDE_PLUGIN_ROOT}/scripts/dist/task-granularity-advice.js`）：唯一 peer 是 `gap-live-voice-caption-removal-on-shown`（ready），共享文件只有 `src/shared/types.ts`，机制无关，**分开立案**。

## AC

- [ ] AC1 时间轴接受显式窗口，不再按自身记录自适应：`src/modules/quay/tests/TimelineBar.test.tsx` 新增用例 —— 同一组 ranges 在两个不同的显式窗口下，x 坐标必须不同（按窗口端点计算），且在窗口外的 range 不被绘制；取假：把实现改回 `Math.min/Math.max(ranges)` 自适应，该用例必须红。
- [ ] AC2 三张图共用同一窗口端点：`src/modules/quay/tests/QuayPanel.test.tsx` 断言同一份快照渲染出的三张图（`quay-gantt`、`quay-panel-tests-timeline`、`quay-panel-fanin-timeline`）暴露的窗口端点读数相同（同一组 `data-window-start` / `data-window-end`，或等价的轴标文本）。取假：让 Tests/Fan-in 回到自适应窗口，该用例必须红。
- [ ] AC3 轴标与 now 标记：Tests / Fan-in 两卡各渲染起止时刻轴标与 now 竖线 —— `data-testid` 为 `quay-panel-tests-timeline-axis-start` / `-axis-end` / `-now` 与 `quay-panel-fanin-timeline-axis-start` / `-axis-end` / `-now`，文本是本地时刻（非空、可读）。取假：去掉轴标渲染，该用例必须红。
- [ ] AC4 窗口外的记录不进入图：`src/modules/quay/tests/QuayPanel.test.tsx` 注入一条落在当前窗口之外的 round 与一条窗口外的 fan-in attempt，断言它们不出现在对应图里（`-rect` 计数不含它们）；取假：去掉裁剪，该用例必须红。
- [ ] AC5 窄测试与类型：`npm run typecheck` exit 0；`src/modules/quay/tests/TimelineBar.test.tsx` 与 `src/modules/quay/tests/QuayPanel.test.tsx` 全绿（窄跑，不起无界扇出）。

## DoD

真实对象过机制：真实后端 + 真实浏览器（MCP 浏览器）上打开一个真实项目的 Quay tab，同一份快照下三张图的时间轴端点一致、各带起止时刻轴标与 now 竖线，肉眼可横向对齐比较（例如同一轮的 suite round 与 fan-in attempt 落在同一 x 邻域）；切换 1h/3h/6h/12h 时三张图同步改变窗口（而不是只有甘特图动）。截图与读数记入本任务 `## 验证记录`。

## Touches

- src/modules/quay/TimelineBar.tsx（显式窗口取代自适应；轴标与 now 标记）
- src/modules/quay/QuayPanel.tsx（把同一快照的窗口传给 Tests 与 Fan-in 两卡，并裁剪窗口外的范围）
- src/shared/types.ts（两处以上共用的时间轴窗口类型）
- src/modules/quay/tests/TimelineBar.test.tsx（显式窗口 / 裁剪 / 轴标用例）
- src/modules/quay/tests/QuayPanel.test.tsx（三图端点一致 / 窗口外记录用例）
- tasks/gap-quay-tab-three-timelines-share-no-time-axis.md
