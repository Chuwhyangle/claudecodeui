---
id: gap-quay-tab-three-timelines-share-no-time-axis
title: Quay tab 三张时间图各用各的时间基：同一快照下 Loop pulse 3.00h / Tests 1.77h / Fan-in
  0.82h，且后两者按自身记录自适应、无轴标——改为共用一条显式时间轴与轴标
status: done
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

- [x] AC1 时间轴接受显式窗口，不再按自身记录自适应：`src/modules/quay/tests/TimelineBar.test.tsx` 新增用例 —— 同一组 ranges 在两个不同的显式窗口下，x 坐标必须不同（按窗口端点计算），且在窗口外的 range 不被绘制；取假：把实现改回 `Math.min/Math.max(ranges)` 自适应，该用例必须红。
- [x] AC2 三张图共用同一窗口端点：`src/modules/quay/tests/QuayPanel.test.tsx` 断言同一份快照渲染出的三张图（`quay-gantt`、`quay-panel-tests-timeline`、`quay-panel-fanin-timeline`）暴露的窗口端点读数相同（同一组 `data-window-start` / `data-window-end`，或等价的轴标文本）。取假：让 Tests/Fan-in 回到自适应窗口，该用例必须红。
- [x] AC3 轴标与 now 标记：Tests / Fan-in 两卡各渲染起止时刻轴标与 now 竖线 —— `data-testid` 为 `quay-panel-tests-timeline-axis-start` / `-axis-end` / `-now` 与 `quay-panel-fanin-timeline-axis-start` / `-axis-end` / `-now`，文本是本地时刻（非空、可读）。取假：去掉轴标渲染，该用例必须红。
- [x] AC4 窗口外的记录不进入图：`src/modules/quay/tests/QuayPanel.test.tsx` 注入一条落在当前窗口之外的 round 与一条窗口外的 fan-in attempt，断言它们不出现在对应图里（`-rect` 计数不含它们）；取假：去掉裁剪，该用例必须红。
- [x] AC5 窄测试与类型：`npm run typecheck` exit 0；`src/modules/quay/tests/TimelineBar.test.tsx` 与 `src/modules/quay/tests/QuayPanel.test.tsx` 全绿（窄跑，不起无界扇出）。

## DoD

真实对象过机制：真实后端 + 真实浏览器（MCP 浏览器）上打开一个真实项目的 Quay tab，同一份快照下三张图的时间轴端点一致、各带起止时刻轴标与 now 竖线，肉眼可横向对齐比较（例如同一轮的 suite round 与 fan-in attempt 落在同一 x 邻域）；切换 1h/3h/6h/12h 时三张图同步改变窗口（而不是只有甘特图动）。截图与读数记入本任务 `## 验证记录`。

## 验证记录

实现提交：`be3b3c35 fix(quay): share one explicit time axis across the tab's three charts`（worktree `gap-quay-tab-three-timelines-share-no-time-axis`，分支同名）。

**窄测试与类型（AC5）** —— 在 worktree 内直接跑，无无界扇出：
- `npx vitest run src/modules/quay/tests/TimelineBar.test.tsx src/modules/quay/tests/QuayPanel.test.tsx` → `Test Files 2 passed (2)` / `Tests 39 passed (39)`。
- `npm run typecheck`（client + server + scripts 三个 tsconfig）→ exit 0。

**取假实验（AC1 / AC2 / AC4 的「必须红」）** —— 临时把 `TimelineBar` 改回 `windowStart = Math.min(...ranges.map(r => r.startMs))` / `windowEnd = Math.max(...)` 自适应，并把裁剪 `visibleRanges = ranges.filter(intersectsWindow)` 退回 `ranges`，重跑上述两文件：
- `Tests 6 failed | 33 passed (39)`，红的是 —— `TimelineBar x is a function of the explicit window, not of the ranges' own extent`（narrow=563.8 与 wide=563.8 相等，正是自适应窗口的指纹）、`TimelineBar drops ranges outside the window and clamps the ones that straddle an edge`、`TimelineBar renders the empty state when every range falls outside the window`、`TimelineBar exposes the shared window on the plot`、`the three Quay charts are cut to one shared window: their endpoints read identically`、`a round and a fan-in attempt outside the shared window are not drawn`。
- `git checkout` 恢复后重跑 → 39 passed；`git status --porcelain` 干净。

**真实后端 + 真实浏览器读数（DoD 主体）** —— 用仓库自带的 Playwright 栈：`playwright.config.ts` 的 webServer 对在 kernel 分配的端口上真起 `tsx --tsconfig server/tsconfig.json server/index.ts` 与 `vite`（真后端 + 真前端），真实 Chromium(`~/.cache/ms-playwright/chromium-1243`)，390×844 手机视口按 `e2e/zz-quay-panel-mobile-grid.spec.ts` 的既有路径导航到 Quay tab。真实项目 = 本次 seed 的 fixture workspace（`.quay/config.yml` + `tasks/` + `.quay/plugin` 软链），经 `GET /api/projects` 索引后打开。用 `page.route('**/api/quay/**')` 把同一份快照注入到真前端：`gantt = { windowHours: <请求的 hours>, nowMs, lanes: [[{startMs: nowMs-30min, endMs: nowMs-10min,…}]] }`，`tests.recentRounds` 与 `fanIn.recent` 各放一条落在 `nowMs-30min` 附近的记录（对 1/3/6/12h **四个**窗口都在窗内）。

读数（`nowMs = 1791704191670`，即 `2026-10-11 15:36` 本地）—— 三张图的 `data-window-start` / `data-window-end` / 起止轴标 / now 竖线：

| 窗口 | gantt 轴标 | Tests `-axis-start/-axis-end` | Fan-in `-axis-start/-axis-end` | 三者 `data-window-start` | 三者 `data-window-end` | `-now` | `-rect` |
|---|---|---|---|---|---|---|---|
| 1h | 02:36 PM / 03:36 PM | 02:36 PM / 03:36 PM | 02:36 PM / 03:36 PM | `1791700591670`（= now−1h） | `1791704191670` | `<line>` `now 03:36 PM` | 1 / 1 |
| 3h | 12:36 PM / 03:36 PM | 12:36 PM / 03:36 PM | 12:36 PM / 03:36 PM | `1791693391670`（= now−3h） | `1791704191670` | `<line>` `now 03:36 PM` | 1 / 1 |
| 6h | 09:36 AM / 03:36 PM | 09:36 AM / 03:36 PM | 09:36 AM / 03:36 PM | `1791682591670`（= now−6h） | `1791704191670` | `<line>` `now 03:36 PM` | 1 / 1 |
| 12h | 03:36 AM / 03:36 PM | 03:36 AM / 03:36 PM | 03:36 AM / 03:36 PM | `1791660991670`（= now−12h） | `1791704191670` | `<line>` `now 03:36 PM` | 1 / 1 |

判读：(a) 同一窗口下三张图的起止时刻文本**逐字节相同**、`data-window-*` 相同 —— 同一时刻在三张图上 x 相同，可横向对齐；(b) 切 1→3→6→12h 时三张图的左端点**一起**移到 `now−N h`（右端点恒为 `now`），即「同步改变窗口」而不是只有甘特图动；(c) 两卡各自带 `-axis-start`/`-axis-end` 文本轴标与 `-now` **竖线**（`tagName === 'line'`，`<title>` 为 `now 03:36 PM`）；(d) 窗内记录在每个窗口下都恰好画 1 根 `-rect`。探针断言在这四个窗口上全绿（`1 passed`），跑完即删（`e2e/zz-tmp-quay-axis-dod.spec.ts`，`git status` 干净）。

截图：`/tmp/quay-axis-dod-1h.png`、`/tmp/quay-axis-dod-3h.png`、`/tmp/quay-axis-dod-6h.png`、`/tmp/quay-axis-dod-12h.png`（各窗口下 Quay tab 全景，可见三张图共享的起止轴标与 now 竖线）。

**未覆盖 / 保留意见**：读数窗口是 `windowHours` 由快照回传驱动的（fixture 让快照回显请求的 hours）；真后端对同一项目实际返回的 `gantt.windowHours` 与本读数无关——三图一致性的机制是「同一 `resolveTimelineWindow(gantt, …)` 结果被三处消费」，已在单测与上面的真浏览器读数两处各自证明。取假实验用 `git checkout` 复原，未进入提交历史。

## Touches

- src/modules/quay/TimelineBar.tsx（显式窗口取代自适应；轴标与 now 标记）
- src/modules/quay/QuayPanel.tsx（把同一快照的窗口传给 Tests 与 Fan-in 两卡，并裁剪窗口外的范围）
- src/shared/types.ts（两处以上共用的时间轴窗口类型）
- src/modules/quay/tests/TimelineBar.test.tsx（显式窗口 / 裁剪 / 轴标用例）
- src/modules/quay/tests/QuayPanel.test.tsx（三图端点一致 / 窗口外记录用例）
- tasks/gap-quay-tab-three-timelines-share-no-time-axis.md
