---
id: gap-quay-pulse-strip-readable-window-axis-rows
title: Quay 脉搏条：6h 可点、行有可见标签、时间轴与带时长的任务条
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

2026-10-25 在 MCP 浏览器（PC 1440×900、手机 390×844）实测 Quay tab 顶部的脉搏条 `src/modules/quay/PulseStrip.tsx`（截图 `tmp/ux-pc-quay.png`、`tmp/ux-pc-pulse-strip.png`、`tmp/ux-m-quay.png`），新用户无法读懂，且有一个真 bug：

1. **6h 点不了（已确认）。** 窗口选择器容器 `w-11`（44px）而三个按钮实际约 71px，`justify-end` 令其向左溢出，压进行区域（`right-11`）之下；`document.elementFromPoint` 取 6h 中心命中的是 `row-inflight`，Playwright 点击超时并报被该行拦截。
2. **选择器太小。** 字号 9px、按钮 12px 高，手机上同样，没有触屏热区；选中态只有浅灰底。
3. **每行没有可见标签。** In flight / Fan-in / Suite / Blocked 只有 `aria-label`，屏幕上看不见；没有图例，没有时间轴刻度；红色 ✕、竖线高度的含义只能靠悬停 tooltip 猜。
4. **任务只画成 2px 高的线**（`height: 2`、每泳道 4px），看不出时长与任务名；In flight 行为空时整行留白、没有「当前无进行中任务」的说明。

做法：
- 把窗口选择器移出绘图区，做成正常尺寸的分段控件（≥24px 高；粗指针下 ≥44px 热区），选中态用实底色 + `aria-pressed`；6h / 24h / 72h 三个都必须可点。
- 每行左侧加可见行标签（复用既有 `cockpit.pulseRow*` 文案键），标签列宽固定、不与数据区重叠。
- 底部加时间轴：起点 `-{窗口}h`、中点、`现在`，刻度随窗口变化。
- 进行中任务画成带任务 id 的条形（高度 ≥ 8px，宽度按起止时间，过窄时只画条、id 进 tooltip），可区分 stale；行为空时显示一句灰字（如「无进行中任务」）。Suite 行的 ✕ 与竖线高度含义在行标签旁加一个 `?` 图例/tooltip 说明（「✕ = 失败轮；竖线高度 = 耗时 / 中位数」）。
- 此组件 cockpit 也在用（`src/modules/cockpit/tests/CockpitStage.test.tsx` 引用）；cockpit 仍在开发中，本任务只保证它不被改坏（其既有测试继续通过），不为它做额外设计。
- 已落地的 `gap-quay-tab-loop-pulse-gantt-integration`、`gap-quay-tab-three-timelines-share-no-time-axis` 是下方 Loop pulse 图的任务，本任务不改那张图。

## AC

- [ ] `npx vitest run src/modules/quay/tests/PulseStrip.test.tsx` 含一例：渲染后窗口按钮不是行容器（`row-*`）的后代，且选择器容器与行容器的包围盒不相交（以布局常量/类名断言，不依赖 jsdom 几何）；并对 6h、24h、72h 各点击一次，`data-window-hours` 依次变为 6、24、72，exit 0。
- [ ] 同一测试文件含一例：四行均渲染可见文本标签（`getByText`，不是只有 `aria-label`），文本取自 `cockpit.pulseRow*` 翻译键，exit 0。
- [ ] 同一测试文件含一例：strip 渲染时间轴，含 `现在`/`now` 与随窗口变化的起点标签（6h 时为 `-6h`，72h 时为 `-72h`），exit 0。
- [ ] 同一测试文件含一例：一个进行中任务渲染为带 `taskId` 文本或 `aria-label` 的条形，高度 ≥ 8px（取自导出的布局常量）；无进行中任务时 In flight 行显示空态说明文字，exit 0。
- [ ] `npx vitest run src/modules/quay/tests/QuayPanel.test.tsx src/modules/cockpit/tests/CockpitStage.test.tsx` exit 0（Quay 面板与 cockpit 既有用例不被改坏；若旧用例钉住 9px/44px 布局，按本任务设计同步改写而非删除断言）。
- [ ] 新增的可见文案键（空态、图例、时间轴 `now`）在 12 个 `src/modules/i18n/locales/*/common.json` 中键集合一致，仓库既有 i18n parity 测试 exit 0。
- [ ] `npx tsc --noEmit -p tsconfig.json` exit 0。

## DoD

真实页面验证（AGENTS.md「UI 验证」）：MCP 浏览器在 PC 1440×900 与手机 390×844 打开真实 Quay tab（隔离实例 `scripts/isolated-instance.sh`，复制库带真实任务史），截图存 `tmp/` 并贴出，须看到并实际操作：(a) 依次点击 6h、24h、72h 三个窗口，每次图都重绘、选中态清晰，且在浏览器里 `document.elementFromPoint(6h 按钮中心)` 返回该按钮本身（贴出读数）；(b) 四行都有可见标签，底部有时间轴；(c) 有进行中任务时（可用 `quay-dogfood` 类夹具或真实项目）看到带任务 id、有长度的条形，无进行中任务时看到空态说明；(d) 手机上选择器热区 ≥44px、标签不被裁。再跑 `node scripts/ui-scenario.mjs` 中涉及 Quay tab 的场景（若存在）并贴出 JSON 报告。fixture 单测只是必要条件，不算落地。

## Touches

- src/modules/quay/PulseStrip.tsx
- src/modules/quay/QuayPanel.tsx
- src/modules/quay/tests/PulseStrip.test.tsx
- src/modules/quay/tests/QuayPanel.test.tsx
- src/modules/cockpit/tests/CockpitStage.test.tsx
- src/modules/i18n/locales/en/common.json
- src/modules/i18n/locales/zh-CN/common.json
- tasks/gap-quay-pulse-strip-readable-window-axis-rows.md
