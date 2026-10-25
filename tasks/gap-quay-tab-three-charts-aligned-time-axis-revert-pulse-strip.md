---
id: gap-quay-tab-three-charts-aligned-time-axis-revert-pulse-strip
title: Quay tab：撤掉脉搏条，把 Loop pulse / Tests / Fan-in 三张现有图的时间轴对齐（不新增任何图形编码）
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 取代 `gap-quay-pulse-strip-readable-window-axis-rows`（done，提交 `a2b876d97`）的设计方向，并接续 `gap-quay-tab-three-timelines-share-no-time-axis`（done，只统一了窗口端点）。用户裁定（2026-10-25）：脉搏条 `src/modules/quay/PulseStrip.tsx` 的方向根本是错的——它另造了一套图形编码（行标签、`?` 图例、✕ 失败叉、`⛔`、阻塞条等）来「重画」那三张图；唯一该做的事，是把 **Loop pulse / Tests / Fan-in 三张图的时间轴对齐**，且**严格沿用这三张图现有的可视化实现**（`LoopPulseGantt.tsx`、`TimelineBar.tsx`）。我之前加的行标签、时间轴、窗口分段控件、进行中任务条形等其它改动一律作废。

现状读数（2026-10-25，隔离实例 PC 1440×900）：Loop pulse 卡 x 为 305–857，Tests 与 Fan-in 卡 x 为 873–1424——三张图分处左右两列，plot 区的左右边缘不同，同一时刻在三张图上的 x 位置不可能相同；顶部脉搏条（x 305–1424、24h）是第四套时间基，与下面三张图又不对齐。窗口端点已由前一个任务统一（`data-window-start/-end` 相同），缺的是**版面上的 x 对齐**。

做法（只做这件事）：
- **撤掉脉搏条**：从 `QuayPanel.tsx` 移除 `PulseStrip` 的 import 与 `quay-panel-pulse` 区块；并把 `a2b876d97` 对 `PulseStrip.tsx`、其测试与 12 个 locale 里新增的 3 个键整体 `git revert`（cockpit 仍引用 `PulseStrip`，revert 后它回到 `0a5a93aa5` 的状态，不为 cockpit 另做设计——cockpit 在开发中）。
- **三张图同一列、同一 plot 左右边缘**：Loop pulse、Tests、Fan-in 三张现有图在 Quay tab 纵向叠成一列（宽屏下也不再分左右两列），三张图的 plot 区（`quay-gantt-svg` 与两张 `TimelineBar` 的 svg）左右边缘像素一致，同一时间戳映射到同一 x（±1px）。图本身的绘制（条形、颜色、轴标、now 竖线、窗口选择器 1/3/6/12h）一律沿用现有实现，必要时只改版面/内边距/共用的 plot 宽度常量，让三者同一个 x 映射。
- **不新增任何图形编码**：不加 ✕、`?` 图例、行标签列、新的条形种类、新的时间轴；`LoopPulseGantt.tsx` / `TimelineBar.tsx` 的绘制逻辑不改，只允许为对齐而改布局类名与传入的宽度/边距。
- 窗口切换仍由现有 Loop pulse 的 1/3/6/12h 选择器驱动，三张图同步变窗（沿用前一任务的机制）。

## AC

- [ ] `QuayPanel.tsx` 不再引用脉搏条：`grep -c "PulseStrip" src/modules/quay/QuayPanel.tsx` 输出 0，且 `grep -c "quay-panel-pulse" src/modules/quay/QuayPanel.tsx` 输出 0（用 `git grep -c ... || true` 形式，避免零命中退出码；旧脉搏条相关用例同步删除）。
- [ ] `PulseStrip.tsx` 回到 `a2b876d97` 之前：`git diff 0a5a93aa5 HEAD -- src/modules/quay/PulseStrip.tsx` 无输出；12 个 `src/modules/i18n/locales/*/common.json` 不含 `a2b876d97` 新增的 3 个键（`git show a2b876d97 -- src/modules/i18n/locales/en/common.json` 的 `+` 行里的键逐个在 12 个文件中查不到）。
- [ ] `npx vitest run src/modules/quay/tests/QuayPanel.test.tsx` 含一例：同一份快照下三张图（`quay-gantt`、`quay-panel-tests-timeline`、`quay-panel-fanin-timeline`）是同一个父容器的子孙、按同一列纵向排列，并共用同一个 plot 宽度/边距常量（取自导出的布局常量）；窗口端点读数仍相同；exit 0。取假：把 Tests/Fan-in 放回右列或改用各自宽度，该用例必须红。
- [ ] `npx vitest run src/modules/quay/tests/TimelineBar.test.tsx src/modules/quay/tests/LoopPulseGantt.test.tsx` exit 0，且这两个文件相对本任务前**没有被改弱的断言**（`git diff -- src/modules/quay/tests/TimelineBar.test.tsx src/modules/quay/tests/LoopPulseGantt.test.tsx` 只允许新增用例，不得删减或放宽已有 `expect`）。
- [ ] `npx vitest run src/modules/cockpit/tests/CockpitStage.test.tsx` exit 0（cockpit 用的 `PulseStrip` 回退后其既有用例通过）。
- [ ] `npx tsc --noEmit -p tsconfig.json` exit 0。

## DoD

真实页面验证（AGENTS.md「UI 验证」）：隔离实例（`scripts/isolated-instance.sh`）里 MCP 浏览器打开真实项目的 Quay tab，PC 1440×900 与手机 390×844 各截图存 `tmp/` 并贴出，并用 `browser_evaluate` 贴出读数：(a) 页面上不再有脉搏条；(b) 三张图 plot 区的 `getBoundingClientRect()` 左、右边缘逐一相等（±1px），并取同一个时间戳（如窗口中点）在三张图上换算出的 x 相等（±1px）；(c) 依次点击 Loop pulse 的 1h/3h/6h/12h，三张图同步变窗、仍对齐；(d) 三张图的图形与改动前一致，没有新增叉号、图例或标签列（贴改前后对比截图）。再跑 `node scripts/ui-scenario.mjs e2e/scenarios/quay-wall*.json`（若涉及 Quay tab）并贴 JSON 报告。fixture 单测只是必要条件，不算落地。

## Touches

- src/modules/quay/QuayPanel.tsx
- src/modules/quay/PulseStrip.tsx
- src/modules/quay/LoopPulseGantt.tsx
- src/modules/quay/TimelineBar.tsx
- src/modules/quay/tests/QuayPanel.test.tsx
- src/modules/quay/tests/TimelineBar.test.tsx
- src/modules/quay/tests/LoopPulseGantt.test.tsx
- src/modules/cockpit/tests/CockpitStage.test.tsx
- src/modules/i18n/locales/en/common.json
- src/modules/i18n/locales/zh-CN/common.json
- e2e/zz-quay-panel-mobile-grid.spec.ts
- tasks/gap-quay-tab-three-charts-aligned-time-axis-revert-pulse-strip.md
