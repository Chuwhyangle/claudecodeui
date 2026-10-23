---
id: architecture-text-and-export-lossless
title: 架构图文本与导出无损：显式 detail:full，Text 面板与托盘附件与 Export 菜单读同一完整来源
status: ready
labels:
  - feature
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref -->本任务让 Architecture 标签里所有「PlantUML 文本」无损。2026-10-23 在真实浏览器里复现：55 个实体的图（claudecodeui 的一个会话），Text 面板的文本是 300 行 / 15044 个字符，其中 26 个实体被截成 4 行成员加一行 `+ … +3 more (7 members)`、`+ … +16 more (20 members)` 这样的标记；同一个图用 Export 菜单的 "PlantUML (.puml)" 下载是 562 行 / 27568 个字符、成员完整、没有任何标记。Quay OO 的 19 实体图没有这个现象（实体数不到 40）。这种省略是不可接受的：复制、下载、发给会话的文本必须是完整的。与 `architecture-node-size-from-drawn-content` 声明了相同的 `PlantUmlGraph.tsx`，改动互不重叠，由调度器串行；与已完成的 `architecture-plantuml-panel-linkage`、`architecture-plantuml-export-menu` 不是同一个机制。

原因（已读 plantuml-js 0.4.0 源码与应用代码，并经 plantuml-js 会话确认）：
1. 应用调用 `renderDetailed` 时没有传 `detail`，plantuml-js 按实体数自动选择：超过 40 个实体用 `compact`，在布局前把每个实体的成员截成 `COMPACT_MEMBER_ROWS = 4` 行，并把标记 `… +N more (M members)` 作为真实成员写进 `model.entities[].members`。`detailed.model` 因此已经有损。
2. 上游序列化的 `memberLine` 还给这个标记补上 `+` 前缀，于是 PlantUML 里多出一个假成员。
3. 应用的 Text 面板（`plantUmlText.ts` 的 `buildPlantUmlDocument`，约 486–497 行，用 `options.drawn.toPlantUml(drawnModelForScope(...))`）用的正是这个已 detail 的绘制模型。同一条路径还带出 Text 面板的 Copy、Download .puml、"Copy as session context"，以及选择托盘的 "Attach the selected subgraph's PlantUML"。
4. Export 菜单的 .puml 走 `ArchitecturePanel.tsx` 的 `currentPlantUml()`，即 `archguardToPlantUml(drawnGraph)`，直接来自完整数据，所以无损——于是同一个视图有两份内容不同的文本。

上游处理：plantuml-js 已立案 `gap-detail-truncation-lossless-export`（给 `PlantUmlMember` 加 `synthetic` 标记、序列化跳过合成成员、`renderDetailed` 新增 `sourceModel`，随 0.5.1 或 0.6.0）。本任务不等它。

要求：
1. 向 `renderDetailed` 显式传 `detail: 'full'`，关掉按实体数自动 compact；常量集中定义。
2. 所有 PlantUML 文本（Text 面板的三个范围、Copy、Download .puml、"Copy as session context"、选择托盘的附件、Export 菜单的 .puml 与 Copy PlantUML）读**同一个完整来源**：以应用自己的 `archguardToPlantUml` 文档（或经 `detail: 'full'` 得到的完整绘制模型）为准，范围（Whole filtered graph / Current viewport / Selected + 1 neighbour）只做筛选，不做任何截断。不得再存在「一份截断、一份完整」的两条路径。
3. 任何导出文本里都不得出现匹配 `… +N more` 或 `(M members)` 的行；每个实体的成员行数必须等于载荷里的成员数。
4. 画面上的成员行数上限（`… +N more` 只出现在 SVG 里）由语义缩放的显示规则负责（见 `architecture-node-size-from-drawn-content`），与文本导出无关。

## Plan

1. `PlantUmlGraph.tsx`：给 `renderDetailed` 传 `detail: 'full'`（常量）。
2. `plantUmlText.ts`：`buildPlantUmlDocument` 的完整来源与范围筛选；确认回退路径 `bridgePlantUmlText` 与主路径内容一致。
3. `ArchitectureTextPanel.tsx` 与 `ArchitectureSelectionTray.tsx`：附件与文本面板读同一来源；`ArchitecturePanel.tsx` 的 `currentPlantUml()` 保持无损。
4. 夹具与守卫：`e2e/support/architectureFixture.ts` 增加 41、150、600 个实体、每个实体 7–25 个成员的夹具；单元测试与 e2e 读数各配控制臂。

## AC

- [x] `npx vitest run src/modules/architecture/tests/plantUmlText.test.ts` exit 0：新增用例——用 41、150、600 个实体的夹具，Text 面板三个范围的文本、Copy、Download、"Copy as session context" 与托盘附件文本都不含匹配 `… \+\d+ more` 或 `\(\d+ members\)` 的行；每个实体块里的成员行数等于夹具里该实体的成员数；`renderDetailed` 被调用时带 `detail: 'full'`；Text 面板「Whole filtered graph」文本与 Export 菜单的 .puml 文本逐行相等（同一来源）；既有用例不回归
- [x] `npx vitest run src/modules/architecture/tests/textPanel.test.tsx src/modules/architecture/tests/selectionTray.test.tsx src/modules/architecture/tests/architectureTab.test.tsx` exit 0：Text 面板的字符数、行数读数随之变为完整文本的读数；托盘附件的体量分档（normal / large / huge）按完整文本重新计算；既有用例不回归
- [x] `npx playwright test e2e/architecture-canvas-layout.spec.ts` exit 0（整份文件仍在单文件天花板内，必要时在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 更新条目并写明实测）：用 ≥ 41 个实体的夹具，在真实页面里读出 Text 面板的完整文本，不含 `… +N more` 行，成员行数与夹具一致
- [x] `npx playwright test e2e/architecture-canvas-layout.spec.ts --grep "control arm"` exit 0：新增控制臂——恢复默认 detail（不传 `detail`）时 ≥ 41 个实体夹具里出现标记行、读数变红，主臂与控制臂用同一读取函数
- [x] `npm run typecheck`、`npm run build`、`npm run lint` 对 `src/modules/architecture/` exit 0

## DoD

真实浏览器里（PC 1440×765）在 55 个实体的会话（claudecodeui 的那个，Text 面板修复前 300 行含 26 个标记）打开 Architecture 标签：读出 Text 面板的行数与字符数（修复前 300 / 15044），确认无标记行，并与 Export 菜单下载的 .puml 逐行比较一致；用托盘 "Attach the selected subgraph's PlantUML" 选中两个实体后读出附件文本；截图存 `tmp/` 并贴进 Evidence。过程中做过的选中、托盘、输入框草稿必须还原。

## Evidence

2026-10-23，worktree `architecture-text-and-export-lossless`（branch `task/architecture-text-and-export-lossless`），真实 Chromium（PC 1440×765）跑 `e2e/architecture-canvas-layout.spec.ts`。被测图：quay-oo fixture 的 class graph，60 个带成员实体（30 classes × 5 members + 30 interfaces × 1 member），经过真实 renderer / ELK / 语义缩放。

修复前（控制臂：把 served `PlantUmlGraph.tsx` 的 `PLANTUML_MEMBER_DETAIL` 改写为 `void 0`，即不传 `detail`）：Text 面板下载的 .puml 是 9,873 字符 / 374 行，每个 class 只有 4 行真实成员 + 一行 `+ … +1 more (5 members)`；同一 reading 报 60 条 violation（30 条 marker 行 + 30 个实体 "4 of 5 member rows"）。
修复后：10,173 字符 / 374 行，0 marker 行、0 缺成员；Export 菜单下载的 .puml 与 Text 面板下载的 .puml 逐行相等（`expect(exportPuml).toBe(textPuml)`）。托盘：Shift 选中两个 class（IoStage0 / IoStage0Step0），展开托盘、勾选 "Attach the selected subgraph's PlantUML"、Copy PlantUML 读出 519 字符 / 148 tokens，两个实体块成员齐全、无 marker。

截图（worktree `tmp/`）：
- `tmp/lossless-text-panel.png` — Text 页 10,173 字符 / 374 行 / approx. 2.9K tokens，Syntax OK，IoStage0 的 5 行成员完整
- `tmp/lossless-control-text-panel.png` — 同一图在默认 detail 下 9,873 字符，含 `+ … +1 more (5 members)`（对照）
- `tmp/lossless-tray-attachment.png` — 两个实体被选中、托盘展开、approx. 148 tokens
- `tmp/lossless-dock-selects-text.png` — dock 的文本仍可被选中（修复未波及可复制面）

说明：Proposal 里 55 实体会话的 300 行 / 15,044 字符是 2026-10-23 在 claudecodeui 实机会话上的最初复现；本 worktree 的可复现实例是 60 实体 class graph（上表读数），机制、判据与修复一致。

AC 实测：
- AC1 `npx vitest run src/modules/architecture/tests/plantUmlText.test.ts` → 25 passed（新增 41/150/600 夹具、`renderDetailed` 收到 `detail:'full'`、默认 detail 控制臂）
- AC2 三个组件文件 → 132 passed（textPanel 17 / selectionTray 16 / architectureTab 99）
- AC3 整份 spec → 17 passed (3.4m)，exit 0；整份 invocation 在 `SPEC_BUDGET_MS` 的 360_000 ms 内，无需改 `playwright.config.ts`
- AC4 `npx playwright test e2e/architecture-canvas-layout.spec.ts --grep "control arm"` → 10 passed (1.2m)，exit 0
- AC5 `npm run typecheck` 0；`npm run build` 0（client 36.1s + server tsc）；`npx oxlint src/modules/architecture/` 0（42 warnings、0 error）

## Touches

- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/plantUmlText.ts
- src/modules/architecture/ArchitectureTextPanel.tsx
- src/modules/architecture/ArchitectureSelectionTray.tsx
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/tests/plantUmlText.test.ts
- src/modules/architecture/tests/textPanel.test.tsx
- src/modules/architecture/tests/selectionTray.test.tsx
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/architecture/tests/exportMenu.test.tsx
- e2e/architecture-canvas-layout.spec.ts
- e2e/support/architectureFixture.ts
- playwright.config.ts
- tasks/architecture-text-and-export-lossless.md
