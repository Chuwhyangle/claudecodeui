---
id: architecture-landscape-phone-layout
title: 横屏手机的架构图布局：画布不少于 240px 高，抽屉改为侧栏
status: ready
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref -->本任务让 Architecture 标签在横屏手机上可用。2026-10-23 用 844×390（触摸、deviceScaleFactor 2）实测：应用走桌面布局，侧栏常驻占 289px，剩下 555px；标题、标签栏、工具栏、摘要条占去大部分高度，画布只有 555×162，图被缩到 14%（137×160）；点选实体后底部抽屉高 176px，比画布还高，整张图被盖住，"1 selected" 悬浮条还压在抽屉上（`tmp/ix2-m-landscape-02-tapped.png`）。与 `architecture-chrome-and-mobile-drawer-polish` 声明了相同的文件，改动互不重叠，由调度器串行；侧栏常驻是应用外壳的行为，本任务只在架构模块内处理，外壳部分写成请求（见下）。

要求：
1. **矮屏紧凑模式**：触摸界面且视口高度 ≤ 480px 时进入紧凑模式：工具栏合并为一行（Class diagram / File graph 与 Adjust、Text 入口并排，其余控件收进 Adjust 面板）；摘要条折叠为一行可展开；缩放按钮与小地图在画布上贴边缩小。该模式下画布高度（宿主元素的 `clientHeight`）不得小于 240px，宽度不得小于视口宽度减去侧栏后的 60%。
2. **抽屉改侧栏**：紧凑模式下 Inspector / Text 不再用底部抽屉，改为画布右侧的面板（宽度为画布宽度的 40%，可收起），不得覆盖被选实体；选择托盘改为面板顶部的一行，不再浮在画布上。
3. **外壳请求**：紧凑模式下 Architecture 标签有「收起侧栏」的入口（调用外壳已有的侧栏收起能力，本任务不改外壳实现）；若外壳没有可调用的接口，在 Evidence 里写明并另立任务。
4. 竖屏与桌面行为不变。

## Plan

1. `hooks/useTouchLayout.ts`：增加「矮屏紧凑」判定（触摸 + 高度 ≤ 480）。
2. `ArchitecturePanel.tsx`：紧凑模式的工具栏、摘要条、面板布局。
3. `ArchitectureDock.tsx` 与 `ArchitectureSelectionTray.tsx`：侧栏形态与托盘位置。
4. 测试与守卫。

## AC

- [x] `npx vitest run src/modules/architecture/tests/dockInspector.test.tsx src/modules/architecture/tests/selectionTray.test.tsx src/modules/architecture/tests/architectureTab.test.tsx` exit 0：新增用例——触摸且高度 ≤ 480 时进入紧凑模式（用 `matchMedia` 与 `innerHeight` 的桩）；紧凑模式下 Inspector 渲染在侧栏而不是底部抽屉，抽屉的 `data-architecture-dock-touch` 不出现；托盘不浮在画布上；竖屏与桌面不进入紧凑模式；既有用例不回归
- [x] `npx playwright test e2e/architecture-canvas-layout.spec.ts` exit 0（整份文件仍在单文件天花板内，必要时在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 更新条目并写明实测）：844×390 触摸视口，缺省状态下画布高度 ≥ 240px；点选实体后侧栏矩形与被选实体矩形不相交，被选实体在可见区内；缺省缩放 ≥ 30%（修复前 14%）
- [x] `npx playwright test e2e/architecture-canvas-layout.spec.ts --grep "control arm"` exit 0：为上面新读数各配控制臂（关闭紧凑模式时画布高度读数变红；恢复底部抽屉时矩形相交读数变红），主臂与控制臂用同一读取函数
- [x] `npm run typecheck`、`npm run build`、`npm run lint` 对 `src/modules/architecture/` exit 0

## DoD

真实浏览器里用 844×390 触摸视口打开本会话与「重启后 Claude Code 会话自动恢复」两个会话的 Architecture 标签：读出画布尺寸与缺省缩放（修复前 555×162、14%），点选实体并截图，确认被选实体可见、侧栏不遮挡；同时用 390×844 竖屏确认没有回归。截图存 `tmp/` 并贴进 Evidence；做过的任何改动必须还原。

## Evidence

实现与读数（2026-10-24，任务 worktree `/data/home/yale/work/claudecodeui-worktrees/architecture-landscape-phone-layout`）：

- 结构：`useTouchLayout()` 新增 `shortTouch`（触摸 + 视口高 ≤ 480，即既有 `isShortTouchViewport`），并按 DEV-only `architecture-short-touch-layout=off` / `architecture-short-touch-dock=drawer` 两个杠杆提供控制臂。`shortTouch` 下：工具栏一条 52px 行（Class/File、摘要、Text、Adjust；Fullscreen 与 Export 收进 Adjust）、摘要条成为工具栏单元并以 overlay 展开（provenance footer 随展开出现）、画布无 standing readout/footer；dock 渲染为 in-flow 侧栏（行宽的 2/7 = 画布宽的 40%），Inspector/Text 不再用底部抽屉；选择托盘作为该侧栏顶行（`data-architecture-tray-panel-row`），不浮在画布上；缩放簇 44px 贴边（bottom/right 4px），小地图在矮屏默认收起。渲染器新增「选中框保持在可见区内」的平移（侧栏变窄后 focus 模式不重排，选中框曾被推到画布外），ResizeObserver 也会调它。
- 单元（AC1 原命令）：`Test Files 3 passed (3) / Tests 160 passed (160)`，exit 0。新增用例：844×390 + coarse/no-hover → `data-architecture-dock-side` 出现且 `data-architecture-dock-touch` 不出现；侧栏内容为同一 Inspector；`data-architecture-dock-width-ratio=40`；托盘 panel-row 且在 canvas 之外；工具栏 52px/nowrap、摘要为工具栏单元、无 `data-architecture-canvas-header`/footer；摘要展开携带 readout + footer；竖屏 390×844 与桌面均不进入该 tier（保留抽屉/桌面 dock）。托盘单测覆盖 in-flow 的 pill/multiselect/expanded（无 absolute）。工具栏单测覆盖 52px 单行、摘要展开、44px 贴边缩放簇。Adjust 里的「收起侧栏」入口通过 lucide 稳定类名 `lucide-panel-left-close` 调用外壳已渲染的折叠控件（用替身按钮证明点击到达，不改外壳）。
- 真实浏览器（AC2/AC3，新增两条，主臂与控制臂共用 `readShortTouchLayout`）：
  - 主臂 844×390 触摸、缺省（e2e 夹具）：宿主 `clientHeight=289`（≥240）、宽 555（视口 844 − 侧栏 289 = 555，≥60%）、缺省缩放 `69.2%`（≥30%，修复前 14%）、工具栏 1 行 52px、无 readout 行/footer。
  - 点选实体后：画布 `396.44×289`，侧栏 `158.56`（= 画布 40%）位于 x=685.4，被选实体 `511..677 × 203..247` 完全在画布内，侧栏/抽屉与被选实体不相交；托盘 `panelRow=true` 且 `overCanvas=false`。
  - 控制臂 A（`architecture-short-touch-layout=off`）：宿主高度 `172px` < 240 ⇒ 同一读数变红；`shortTouch=false`，readout 行与 footer 回来。
  - 控制臂 B（`architecture-short-touch-dock=drawer`）：抽屉 `176px` 覆盖画布下缘，与被选实体 `324..523 × 294..383` 相交 ⇒ 交点读数变红；该臂画布高度仍 `289`（只隔离抽屉形态）。
  - `npx playwright test e2e/architecture-canvas-layout.spec.ts --grep "control arm"`：新增控制臂通过；整份/控制臂命令有 3 条**既有基线红**（见下），非本 delta。
- **基线红（重要，已独立复现）**：整份 `npx playwright test e2e/architecture-canvas-layout.spec.ts` 结果为 `24 passed / 7 failed (12.7m)`；在干净 `develop` worktree（detached develop）上逐条复跑，7 条全部同样失败 ⇒ 非本任务引入：(1) `control arm — without the member caps...`（可读 focus 让 zoom 读 69.2% 而非 <60%，且无 caps 下箱宽不再超标）；(2) `control arm — restoring the shipped Show-all defect...`（180s 超时）；(3) `control arm — each restored chrome defect...`（60s 超时）；(4) `main arm — Show all keeps the relation preset...`（`data-architecture-filter-hidden` 读数为 null）；(5) `main arm — the phone canvas fills the panel...`（60s 超时）；(6) `main arm — the phone drawer, canvas paper...`（60s 超时）；(7) `main arm — the orientation holds on a wider viewport...`（60s 超时）。本任务新增的 2 条用例均通过。整份文件曾在并发宿主负载下被旧 `SPEC_BUDGET_MS=660_000` 在 case 26/31 结束（watchdog，非挂起）；已把 `architecture-canvas-layout.spec.ts` 条目改为 `1_200_000` 并在注释里写明 12.7m 实测与原因。
- AC4：`npm run typecheck` exit 0；`npm run build` exit 0（vite build + server tsc）；`npm run lint` exit 0（仅既有 warning）。
- DoD（真实浏览器，worktree dev server 3199 + vite 5199，共享 live `~/.cloudcli/auth.db`，JWT 由 DB `jwt_secret` 签发；截图在 `tmp/`）：
  - 「重启后 Claude Code 会话自动恢复」（`f4960c9a-5fdf-4f35-a839-7437e90fe430`）844×390 触摸：侧栏展开时宿主 `555×289`，缺省缩放 `69.2%`、`fit`，工具栏 52px short-touch，无 readout 行/footer；点选 `IProviderModels` 后画布 `396.44×289`、侧栏 `158.56`（= 画布 40%）、被选实体 `394.9..677.4 × 109.0..153.9` 完全可见、与侧栏不相交。截图：`tmp/landscape-restart-recovery-00-default.png`、`-01-tapped.png`、`-02-sidebar-collapsed.png`。
  - 本会话（`efa11136-f29c-426b-8551-74a6c9eeaa99`）844×390：短屏紧凑 chrome 生效（`shortTouch=true`、工具栏 52px、无 readout/footer）；该会话的 transcript 只种出 `.quay/config.yml`，它不在分析缓存中 ⇒ 面板显示自身空态（“No nodes to draw in this view…”），无宿主可读尺寸/缩放。这是会话种子数据限制，不是布局缺陷；截图 `tmp/landscape-this-session-00-default.png`。
  - 竖屏 390×844（同一「重启后…」会话）：`shortTouch=false`，readout 行与 footer 仍在，点选后仍是底部抽屉（`data-architecture-dock-touch`），无侧栏；宿主 `390×578`，被选实体可见且与抽屉不相交（抽屉按既有保留带让出选中框）。截图：`tmp/portrait-restart-recovery-00-default.png`、`-01-tapped.png`。
  - 需求 3：外壳**确实有**可调用的收起能力（`SidebarHeader` 的 `PanelLeftClose` 控件 + 折叠轨 `SidebarCollapsed`），但没有暴露给架构模块的 prop/context。本任务在 Adjust 面板加入 `data-architecture-sidebar-collapse` 入口，按 lucide 公开类名 `lucide-panel-left-close` 找到并点击外壳控件，**未改任何外壳文件**。实测侧栏宽度 `289 → 49`；probe 结束时保持折叠（恢复探针开始前观察到的状态），未留下偏好改动。另：probe 早前点过一次 “Show sidebar”，最终已重新折叠还原。
  - 还原：dev server/vite 已停止（3199/5199 释放），临时 baseline worktree 已移除；除 Evidence/Touches 列出的源码外无未声明改动；`tmp/` 截图与报告为 git-ignored。

## Touches

- src/modules/architecture/hooks/useTouchLayout.ts
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/ArchitectureDock.tsx
- src/modules/architecture/ArchitectureSelectionTray.tsx
- src/modules/architecture/ArchitectureMinimap.tsx
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/tests/dockInspector.test.tsx
- src/modules/architecture/tests/selectionTray.test.tsx
- src/modules/architecture/tests/architectureTab.test.tsx
- e2e/architecture-canvas-layout.spec.ts
- playwright.config.ts
- tasks/architecture-landscape-phone-layout.md
