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

- [ ] `npx vitest run src/modules/architecture/tests/dockInspector.test.tsx src/modules/architecture/tests/selectionTray.test.tsx src/modules/architecture/tests/architectureTab.test.tsx` exit 0：新增用例——触摸且高度 ≤ 480 时进入紧凑模式（用 `matchMedia` 与 `innerHeight` 的桩）；紧凑模式下 Inspector 渲染在侧栏而不是底部抽屉，抽屉的 `data-architecture-dock-touch` 不出现；托盘不浮在画布上；竖屏与桌面不进入紧凑模式；既有用例不回归
- [ ] `npx playwright test e2e/architecture-canvas-layout.spec.ts` exit 0（整份文件仍在单文件天花板内，必要时在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 更新条目并写明实测）：844×390 触摸视口，缺省状态下画布高度 ≥ 240px；点选实体后侧栏矩形与被选实体矩形不相交，被选实体在可见区内；缺省缩放 ≥ 30%（修复前 14%）
- [ ] `npx playwright test e2e/architecture-canvas-layout.spec.ts --grep "control arm"` exit 0：为上面新读数各配控制臂（关闭紧凑模式时画布高度读数变红；恢复底部抽屉时矩形相交读数变红），主臂与控制臂用同一读取函数
- [ ] `npm run typecheck`、`npm run build`、`npm run lint` 对 `src/modules/architecture/` exit 0

## DoD

真实浏览器里用 844×390 触摸视口打开本会话与「重启后 Claude Code 会话自动恢复」两个会话的 Architecture 标签：读出画布尺寸与缺省缩放（修复前 555×162、14%），点选实体并截图，确认被选实体可见、侧栏不遮挡；同时用 390×844 竖屏确认没有回归。截图存 `tmp/` 并贴进 Evidence；做过的任何改动必须还原。

## Touches

- src/modules/architecture/hooks/useTouchLayout.ts
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/ArchitectureDock.tsx
- src/modules/architecture/ArchitectureSelectionTray.tsx
- src/modules/architecture/tests/dockInspector.test.tsx
- src/modules/architecture/tests/selectionTray.test.tsx
- src/modules/architecture/tests/architectureTab.test.tsx
- e2e/architecture-canvas-layout.spec.ts
- playwright.config.ts
- tasks/architecture-landscape-phone-layout.md
