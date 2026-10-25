---
id: gap-cockpit-pulse-strip-composes-existing-charts-aligned
title: Cockpit 脉搏条实验：内部改用 Loop pulse / Tests / Fan-in 三张图的现有画法，叠成一列、时间轴对齐
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-quay-tab-drop-pulse-strip
---
## Proposal

<!-- dedup-ref --> 接续 `gap-quay-tab-drop-pulse-strip`（Quay tab 先去掉脉搏条）；同时取代已 done 的 `gap-quay-pulse-strip-readable-window-axis-rows`（`a2b876d97`）的设计方向。用户裁定（2026-10-25）：cockpit 继续实验 `PulseStrip`，但**内部必须用 Loop pulse / Tests / Fan-in 三张图的现有画法并对齐**，不再另造图形编码。本任务是 cockpit 侧的实验，Quay tab 不涉及。

现状：`src/modules/quay/PulseStrip.tsx`（783 行）自己画四行（in flight 条形、fan-in 竖线、suite 竖线 + ✕、blocked 横条 + `⛔`），并带行标签列、`?` 图例、窗口分段控件和自有时间轴——这是对三张现有图的「重画」。而 `LoopPulseGantt.tsx` 与 `TimelineBar.tsx` 本来就共用同一套几何：固定 600 宽 viewBox、`PAD=4`、`PLOT_LEFT=PAD`、内宽 `600-2*PAD`、按宿主宽度整体等比缩放（`w-full h-auto`），同一窗口端点下同一时刻 x 相同；Quay tab 里它们不对齐只是因为被放在左右两列。

做法：
- `PulseStrip` 内部不再自绘：把 `QuayGanttLanes` → `LoopPulseGantt`（原 in flight）、`QuayFanInSummary` → `TimelineBar`（Fan-in）、`QuayTestsSummary` → `TimelineBar`（Tests/Suite）三个**现有组件**纵向叠成一列，同一宿主宽度、同一窗口端点（`gantt` 的 `windowHours` + `nowMs`），三者的 plot 左右边缘一致。把「快照 → TimelineBar 的 ranges/window」的映射从 `QuayPanel.tsx` 抽成共用函数（放在 `src/modules/quay/` 内一个新文件），`QuayPanel` 与 `PulseStrip` 共用，禁止在 `PulseStrip` 里再写一份。
- 三张图的几何常量（`PLOT_WIDTH`、`PAD` 等）现在在 `LoopPulseGantt.tsx` 与 `TimelineBar.tsx` 各写一份；抽成同一个共享模块，两个组件改为从那里读取（绘制逻辑与像素输出不变），让「对齐」由单一常量保证，而不是巧合相等。
- **不新增任何图形编码**：删除 `PulseStrip` 里自造的 ✕、`⛔`、blocked 横条、行标签列、`?` 图例、窗口分段控件与自有时间轴。注意：这意味着 **Blocked 行不再显示**（三张图里没有对应的现有画法）；`blockers` 属性保留在接口里但不渲染，并在组件文档里写明原因。
- 保持 `PulseStrip` 的对外接口（props、`testId` 前缀、`index.ts` 导出）以免打断 `CockpitStage.tsx`；`onFocusTask` 因现有三图的标记不可点击而不再被触发（接口保留、注明实验期间无效）。`PULSE_STRIP_HEIGHT_PX` 等依赖「48px 固定高度」的常量与 cockpit 布局引用同步调整（三图叠起来比 48px 高）。
- cockpit 本来就在开发中：本任务是实验，卡片变高可以接受，但不得溢出或遮挡 fleet 卡片其它内容。

## AC

- [x] `PulseStrip.tsx` 复用现有组件：`git grep -c "LoopPulseGantt" -- src/modules/quay/PulseStrip.tsx` ≥ 1 且 `git grep -c "TimelineBar" -- src/modules/quay/PulseStrip.tsx` ≥ 1（用 `|| true` 形式处理零命中）。
- [x] 无自造编码：`src/modules/quay/PulseStrip.tsx` 的代码与注释中不再含 `✕`、`⛔`、`fail-glyph`（`git grep -c` 逐个为 0）。
- [x] 几何常量单一来源：`git grep -n "const PLOT_WIDTH = " -- src/modules/quay | wc -l` 输出 1（只剩共享模块里那一处定义）。
- [x] 映射单一来源：`QuayPanel.tsx` 与 `PulseStrip.tsx` 都 import 同一个映射函数，`git grep -c` 该函数的定义名只在新文件出现 1 次。
- [x] `npx vitest run src/modules/quay/tests/PulseStrip.test.tsx` 含例：同一份快照下渲染出的三张图（Loop pulse、Tests、Fan-in）为同一父容器的纵向兄弟，暴露的窗口端点读数相同，且各自 viewBox 宽度同为共享常量；取假：把其中一张换成独立宽度，该例必须红。exit 0。
- [x] `npx vitest run src/modules/quay/tests/TimelineBar.test.tsx src/modules/quay/tests/LoopPulseGantt.test.tsx src/modules/quay/tests/QuayPanel.test.tsx src/modules/cockpit/tests/CockpitStage.test.tsx` exit 0，其中 `TimelineBar.test.tsx` 与 `LoopPulseGantt.test.tsx` 无被删减或放宽的既有 `expect`（`git diff` 只允许新增）。
- [x] `npx tsc --noEmit -p tsconfig.json` exit 0。

## DoD

真实页面验证（AGENTS.md「UI 验证」，cockpit 走隔离实例，参照 `cockpit-verify-isolated-instance-and-scenario-runner-gap` 的做法，不碰 live 实例）：MCP 浏览器打开 cockpit 的 fleet 视图，PC 1440×900 与手机 390×844 各截图存 `tmp/` 并贴出，并用 `browser_evaluate` 贴出读数：某个有 `pulse` 读数的项目卡片底部，三张图 plot 区 `getBoundingClientRect()` 左、右边缘逐一相等（±1px），窗口中点的时间戳在三张图上换算的 x 相等（±1px）；卡片内容未被遮挡或溢出；同一项目在 Quay tab 里的 Loop pulse / Tests / Fan-in 图形与 cockpit 里的画法一致（贴并排截图，肉眼确认没有新增叉号、图例或标签列）。再跑 `node scripts/ui-scenario.mjs` 中涉及 cockpit 的场景并贴 JSON 报告。fixture 单测只是必要条件，不算落地。

### DoD 实跑（2026-10-25）

本会话没有浏览器 MCP，按 `no-mcp-browser-use-throwaway-playwright-spec` 的等价路径，用一次性 Playwright spec（真实 client+server+Chromium，quay 两读在 HTTP 边界打桩；spec 跑完已删除，未提交）在隔离 e2e 实例上执行：

- 截图：`tmp/pulse-strip-cockpit-1440.png`、`tmp/pulse-strip-cockpit-390.png`、`tmp/pulse-strip-quay-tab-1440.png`。
- 读数（`tmp/pulse-strip-reading-1440.json` / `-390.json`）：
  - 1440×900：三图 `plotLeft=223.4755`、`plotRight=589.8526`、`midX=406.6641`，逐对相等；viewBox 宽均 600；`occluded={gantt:false,tests:false,fanIn:false}`；`chartCount=3`；strip `bottom=376` ≤ tile `bottom=389`、`right=592.33` ≤ tile `right=605.33`；`glyphs=false`、`hasLegend=false`、`hasLabelColumn=false`。
  - 390×844：三图 `plotLeft=31.2133`、`plotRight=358.7867`、`midX=195.0000`，逐对相等；无遮挡；strip 未越出 tile。
- Quay tab 并排（`tmp/pulse-strip-quay-tab-1440.png`）：三图 `viewBoxWidths=[600,600,600]`，window start/end 三图一致，面板文本无 `✕`/`⛔`；与 cockpit 的图形画法一致，无新增叉号、图例或标签列。
- `node scripts/ui-scenario.mjs`（cockpit 语义场景，报告 `tmp/pulse-strip-scenario-report.json`）：`ok=true`，`route="/cockpit?view=fleet"`，`cockpit.view="fleet"`，`cockpitFocusIs=null`，1 个 checkpoint 截图。

## Touches

- src/modules/quay/PulseStrip.tsx
- src/modules/quay/LoopPulseGantt.tsx
- src/modules/quay/TimelineBar.tsx
- src/modules/quay/chartGeometry.ts
- src/modules/quay/timelineMapping.ts
- src/modules/quay/QuayPanel.tsx
- src/modules/quay/index.ts
- src/modules/cockpit/CockpitStage.tsx
- src/modules/quay/tests/PulseStrip.test.tsx
- src/modules/quay/tests/TimelineBar.test.tsx
- src/modules/quay/tests/LoopPulseGantt.test.tsx
- src/modules/quay/tests/QuayPanel.test.tsx
- src/modules/cockpit/tests/CockpitStage.test.tsx
- tasks/gap-cockpit-pulse-strip-composes-existing-charts-aligned.md
