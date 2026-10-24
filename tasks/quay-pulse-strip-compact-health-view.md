---
id: quay-pulse-strip-compact-health-view
title: 脉搏条：每项目一条 ≤48px 的高密度进展视图（在飞 / fan-in 胜负条 / suite / 阻塞及影响），常驻驾驶舱与 Quay 面板
status: ready
labels:
  - cockpit
  - quay
  - ui
  - dataviz
parent: null
children: []
extra: {}
---
## Proposal

决策出处：用户 2026-10-24 的要求。用户希望持续看到系统整体的进展：在飞的任务、最近的 suite 测试和 fan-in 情况。这些图「不用做得很大，可以更扁、线更细，或者用其它更高密度的表现形式」，目的是让用户持续看到系统在活跃、健康地处理任务，并且直观地看到阻塞的问题及其影响。这也对应 `docs/proposals/context-layers-and-delegation-ladder.md` 里驾驶舱的常驻信息（系统自述，L3）。用户的显示器是一块 2610×3840 的竖屏。

现状实读（2026-10-24）：`QuaySnapshot`（`src/shared/types.ts`）已经带有 `inFlight`（各任务的阶段、开始时间、心跳）、`gantt` 泳道、`tests.recentRounds`（每轮的开始时间、耗时、通过 / 失败数、状态）和 `fanIn.recent`（每次尝试的 task、outcome、加锁和释放时间）。Quay 面板里的 `LoopPulseGantt` / `TimelineBar` 是一张大卡片，使用 600×H 的坐标空间，带坐标轴文字，不适合常驻显示。

方案：做一条**脉搏条**（`PulseStrip`），每个项目一条，高度不超过 48 px，横向是时间（默认最近 24 小时，可切换 6 h / 72 h），共四行，线条要细：
1. **在飞行**（约 16 px）：每个在飞任务一条 2 px 横线，按泳道排列（复用 gantt 泳道），长度等于已运行时长，颜色表示阶段（实现中 / fan-in / 等待合入）；超过阈值没有心跳的任务，在线尾画一个空心点。
2. **fan-in 行**（约 10 px）：每次尝试一根细竖线。成功的从基线向上，失败的从基线向下并使用状态色 critical；重试和竞争（ff）用 serious。这是一种「胜负条」：疏密表示活跃度，上下表示健康度。
3. **suite 行**（约 10 px）：每轮一根竖线，高度按耗时（相对该项目的中位数），失败的那轮标成 critical。
4. **阻塞行**（约 10 px）：当前每个带 Blocker 或处于 needs-human 的任务画一段横线，从开始阻塞的时间到现在；线尾标出**影响**，也就是正在等它的任务数（`depends_on` 的反向计数），例如「⛔ 3」。同一失败签名（例如同一个测试文件红）重复出现时合并成一段，标出次数。

**密度和可读性**（按 dataviz 规范）：
- 线宽 2 px，背景网格只保留一条极淡的基线；不显示坐标轴文字，只在条的右端用小字写「24h」。
- 状态色只用于状态（good / warning / serious / critical），并且一定配图标或形状，不只靠颜色；在飞阶段使用固定顺序的分类色，不和状态色混用。
- 悬停显示 tooltip（任务 id、结果、耗时、失败签名）；点击把焦点移到对应对象（驾驶舱里聚焦任务卡片，会话页里打开 Quay 面板对应的条目）。
- 无数据时显示一条空基线，并注明「最近 24h 无活动」，不留白。
- 亮色和暗色模式分别用验证脚本校验配色。

**阻塞影响的数据**：服务端在 snapshot 里新增 `blockers: [{taskId, since, signature, occurrences, dependents: string[]}]`。signature 取自 Blocker 段里「未落地原因」的 step 加上首行，数字归一化；dependents 是 `depends_on` 指向它、且尚未 done 的任务。该字段为可选，旧客户端不受影响。

**放在哪里**：驾驶舱的全部项目视图中，每块项目磁贴的底部放一条；会话页的 Quay 面板顶部放当前项目的那一条，替代那张大卡片的常驻位置（大卡片保留在展开视图里）。竖屏上，多个项目的脉搏条上下叠放。

## AC

- [x] AC1: `npx tsx --tsconfig server/tsconfig.json --test server/modules/quay/tests/quay-blockers-summary.test.ts` exit 0——任务库夹具中有带 Blocker 的任务、needs-human 的任务，以及依赖它们的未完成任务：输出的 blockers 含正确的 since、signature（数字已归一化）、occurrences；同一签名的多个任务合并计数；dependents 只计未完成的依赖方。
- [x] AC2: `npx vitest run src/modules/quay/tests/PulseStrip.test.tsx` exit 0——用 snapshot 夹具渲染：四行都存在，总高度不超过 48 px；成功的 fan-in 竖线向上，失败的向下且带 critical 标记；失败的 suite 轮次带 critical 标记；阻塞段的线尾显示依赖方数量；悬停出现 tooltip；无数据时显示「最近 24h 无活动」；切换 6h / 24h / 72h 时只改变数据窗口，不改变条的高度。
- [x] AC3: 同一测试文件——状态标记同时有颜色和形状 / 图标（断言存在形状属性，而不仅是颜色类）；在飞阶段使用的颜色与状态色集合不相交。
- [x] AC4: `npx vitest run src/modules/quay/tests/QuayPanel.test.tsx src/modules/cockpit/tests/CockpitStage.test.tsx` exit 0（既有用例不弱化，并新增：项目磁贴含脉搏条，点击脉搏条上的任务竖线会产生对该任务 URI 的聚焦）；文案覆盖 12 个 locale；`npm run typecheck` 通过。

## DoD

- **MCP 浏览器（或独立 Playwright）实际操作 + 截图（必做）**：在隔离实例（复制的数据库、关闭 residentRestore、能找到 fleet CLI）上，以 1440×900 和 1305×1920（竖屏的一半）两个视口截图驾驶舱全部项目视图和会话页的 Quay 面板；悬停一根失败的 fan-in 竖线截图 tooltip；截图存 `tmp/` 并贴出。
- 运行 dataviz 的配色验证脚本，分别校验亮色和暗色模式，贴出结果。
- 用真实数据核对至少一个项目：脉搏条上 fan-in 成功和失败的数量，与该项目最近 24h 的 fan-in 记录一致。

## Evidence

### AC1 — 阻塞汇总（worktree HEAD，2026-10-24）
`npx tsx --tsconfig server/tsconfig.json --test server/modules/quay/tests/quay-blockers-summary.test.ts` → exit 0，7 passed。
- 合并：同一签名（数字归一化为 `#`）的 a/b 两组 `occurrences: 2`，`since` 取最早 08:00Z，代表 taskId=task-a。
- 影响：该组 `dependents: [task-e, task-f]`；`task-d`（done）指向 a 但不计；needs-human 组 `dependents: [task-e]`（done 的 g 不计）。
- 未读库 `null` ≠ 空库 `[]`；无时间戳的 Blocker 条目被跳过而不是伪造起点；done 任务的 Blocker 段只是历史。

### AC2 / AC3 — PulseStrip（worktree HEAD）
`npx vitest run src/modules/quay/tests/PulseStrip.test.tsx` → exit 0，10 passed。
- 四行 `row-inflight/fanin/suite/blocked` 存在；`data-height-px=48`（16+10+10+10+2）。
- fan-in `landed` → `data-direction="up"`/`good`；`red` → `down`/`critical`；`exited-not-landed` → `serious`。
- 失败 suite → `data-severity="critical"` + `data-shape="suite-fail"` + ✕ glyph。
- 阻塞段 `data-dependents="2"`，线尾 `⛔ 2`。
- 悬停失败 fan-in → tooltip 出现、离开消失；空读数 → 「最近 24h 无活动」；6/24/72 切换只改 `data-window-hours`，高度与行高不变。
- AC3：每个状态标记都有 `data-shape` 且带 `bg-*-600` 颜色类；`IN_FLIGHT_PHASE_COLORS ∩ STATUS_COLORS = ∅`。

### AC4 — 面板 / 驾驶舱 / 12 locale / 类型
`npx vitest run src/modules/quay/tests/QuayPanel.test.tsx src/modules/cockpit/tests/CockpitStage.test.tsx` → exit 0，71 passed；`i18nCockpitCompleteness.test.ts` → 9 passed。新增用例：项目磁贴含脉搏条（`cockpit-fleet-tile-pulse`）；点击竖线发出 `quay://claudecodeui/task/<id>` 的聚焦（board 上真实移动焦点，fleet 磁贴发出同一 URI）；Quay 面板顶部有脉搏条并按任务 URI 聚焦。12 个 locale 各新增 13 个 `cockpit.pulse*` 键（占位符一致）。`npm run typecheck` → exit 0（client/server/scripts 三个配置）。

### DoD — 隔离实例 + 真实浏览器
隔离实例：新库 `/tmp/pulse-dod/auth.db`，`HOME=/tmp/pulse-dod/home`（符号链接真实 `~/.claude`、`~/.claude.json`、`~/.quay-fleet`），`SERVER_SETTINGS_PATH` 关闭 residentRestore（启动日志无 `resident-restore`），`QUAY_FLEET_BIN=/data/home/yale/work/quay-fleet/bin/quay-fleet.mjs`，后端 :3191 + Vite :5191，独立 Playwright/Chromium。截图在 worktree `tmp/pulse-strip-dod/`（gitignored）：
- `fleet-1440x900.png`、`fleet-1305x1920.png`：全部项目视图，9 个磁贴 / 9 条脉搏条，全部 `data-height-px=48`。
- `session-quay-panel-1440x900.png`、`session-quay-panel-1305x1920.png`：会话页 → Quay 标签页（独立实例的 `/api/projects` 约 2 分钟才返回，首屏慢；面板随后正常渲染）。
- `panel-1440x900.png`、`panel-1305x1920.png`：驾驶舱 board 内同一 QuayPanel 的对照。
- `fanin-tooltip-1440x900.png`：悬停 claudecodeui 磁贴上失败的 fan-in 竖线，tooltip `cockpit-grid-pos-and-remote-focus-label: red`。
- `report.json`：`pageErrors: []`。

真实数据核对（claudecodeui）：`GET /api/quay/fleet-summary` 的 `pulse.fanIn.recent` 按 24h 过滤 = **68**（landed 53 / red 15）；DOM 竖线 = **68**（up 53 / down 15；good 53 / critical 15）；Quay 面板 strip 同样 68；suite 竖线 65 = API 的 24h rounds 65；阻塞 `⛔ 1`（dependents=["session-task-flow-chain-status"]）。
阻塞依赖来源：CLI `task list --json` 不含 `depends_on`，服务端对未完成任务读取 `tasks/<id>.md` frontmatter 补齐（`enrichTaskRecordsWithStoreEdges`），所以影响读数不是空的。

配色验证（WCAG 图形对象 3:1，dataviz 调色板校验口径）：8 个 token 亮色/暗色全部 PASS——in-flight: blue 5.17/6.98、violet 5.70/6.52、cyan 3.68/9.82、indigo 6.29/5.95；status: green 3.30/10.18、amber 3.19/10.63、orange 3.56/7.84、red 4.83/6.41。

## Touches

- server/modules/quay/quay.service.ts
- server/modules/quay/quay-blockers-summary.ts (new)
- server/modules/quay/tests/quay-blockers-summary.test.ts (new)
- server/modules/quay/tests/quay-fleet-summary.test.ts
- server/shared/types.ts
- src/shared/types.ts
- src/modules/quay/PulseStrip.tsx (new)
- src/modules/quay/tests/PulseStrip.test.tsx (new)
- src/modules/quay/QuayPanel.tsx
- src/modules/quay/index.ts
- src/modules/quay/tests/QuayPanel.test.tsx
- src/modules/cockpit/CockpitStage.tsx
- src/modules/cockpit/CockpitPage.tsx
- src/modules/cockpit/cockpitView.ts
- src/modules/cockpit/tests/CockpitStage.test.tsx
- src/modules/cockpit/tests/i18nCockpitCompleteness.test.ts
- src/modules/i18n/locales/de/common.json
- src/modules/i18n/locales/en/common.json
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
- tasks/quay-pulse-strip-compact-health-view.md
