---
id: gap-architecture-compact-chrome-and-tab-tooltip
title: Architecture 顶部压成一行：Export+Legend 收进溢出菜单、读数行折叠为一行摘要，并修复 tab tooltip 点击后不消失
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref -->2026-10-24 在真实会话（`quay 的 qual 与 goal 状态接口`，1440×900、侧栏展开）量到：Architecture 面板头部约 140px，画布顶 y=197、画布高 657px（占视口 73%）。原因有二。其一，桌面工具栏是单个 `flex-wrap` 行（`ArchitecturePanel.tsx` 约 4114、4169-4186），内容约 1100px 而面板可用宽约 1126px，右侧的 Fullscreen / Export ▾ / Legend 折成第二行；侧栏收起时才放得下。其二，读数行在流里占约 45–60px：摘要一行，加上 `Hidden … ▸ Show mentioned / ▸ Show all / ↺ Reset filters` 的第二行。另有一个独立缺陷：点击 workspace tab 后 tooltip 不消失，并盖住旁边的 `Open in new tab`。根因是 `shared/ui/Tooltip.tsx` 只在 mouseleave 或「容器外」pointerdown 时关闭，点击触发元素本身（pointerdown 在容器内）被提前 return，鼠标仍停在原处，不会有 mouseleave。同时 `WorkspaceTabs.tsx:241` 给每个 tab 都套了 tooltip，而 lg 以上 tab 文字标签本来就可见，tooltip 内容重复。没有开放任务与本任务的核心文件重叠；已完成的 `architecture-fullscreen-view`、`gap-architecture-empty-class-view-guides-to-file-graph` 改过同一面板，不是同一机制。

已与用户商定的做法（不得改动）：
1. **桌面工具栏右侧**：`Export ▾` 与 `Legend` 并入一个 `⋯` 溢出菜单（菜单里放 Export 的全部条目和 Legend 入口，Legend 保持现有弹层内容）；`Open in new tab`、`Text`、`Fullscreen` 留在工具栏上，不进溢出菜单。`Open in new tab` 与 `Fullscreen` 改为图标按钮（`Maximize2` / `Minimize2` 与外链图标，仍用现有 `aria-label`，并有 tooltip），`data-architecture-fullscreen-toggle` 等现有 data 属性、全屏时的文案切换与 `F` 快捷键行为不变。目标：1440 宽、侧栏展开（面板约 1126px）时工具栏不折行。
2. **读数行折叠为一行摘要**，复用已有的 `data-architecture-readout-toggle` 展开机制（compact 档已有：折叠态一行，`readoutOpen` 时展开第二/三行与明细）。桌面默认折叠。折叠态保留一行：摘要、`▸`，以及当 `hiddenMentionedKinds.length > 0` 时一个**始终可见**的行内动作 `Show mentioned (N)`（这是「会话提到的实体被默认 filter 隐藏」的唯一一键恢复入口，不得只藏在展开区里）。`Show all`、`Reset filters`、scope-hidden 提示、curation 行、diff 行、预算明细进入展开区。右侧 `data-architecture-canvas-header-actions`（缩放读数）保持在这一行。
3. **tab tooltip**：(a) 共享 `Tooltip` 在触发元素内 pointerdown（点击）时立即关闭，并在指针离开前不再重新弹出（离开再进入后恢复）；触屏长按行为不变。(b) `WorkspaceTabs` 仅在该 tab 的文字标签不可见（窄屏仅图标）时才挂 tooltip，文字可见时不渲染 `Tooltip`。

本任务不改：Core/Common/All、范围步进器、`Adjusted ▾`、搜索框、手机 compact 档的现有结构（只允许因复用折叠机制而共享代码）。新增文案键（如溢出菜单的名称）必须 12 个 locale 齐全。

## AC

- [ ] 新增 vitest 用例（名含 `desktop toolbar keeps Export and Legend in the overflow menu`）：桌面档渲染面板，断言工具栏上没有可见的 `Export ▾` 与 `Legend` 顶层按钮，存在带 `aria-label` 的 `⋯` 溢出触发器；点开后菜单内含全部 `data-architecture-export-item` 条目与 Legend 入口；`Open in new tab`、`Text`、`Fullscreen`（`data-architecture-fullscreen-toggle`）仍是顶层按钮且各有 `aria-label`。
- [ ] 新增 e2e `e2e/architecture-compact-chrome.spec.ts`（沿用 `e2e/support/architectureFixture.ts`）：视口 1440×900、侧栏展开，断言 `[data-architecture-toolbar]` 只有一行（其高度 ≤ 52px，且所有顶层按钮的 `getBoundingClientRect().top` 相同），且 `[data-architecture-canvas-header]` 高度 ≤ 40px；`npx playwright test e2e/architecture-compact-chrome.spec.ts` 退出码 0。
- [ ] 新增 vitest 用例（名含 `desktop readout defaults to one line`）：桌面档首次渲染时 `data-architecture-readout-toggle` 的 `aria-expanded` 为 `false`，`data-architecture-filter-hidden` 行、`data-architecture-filter-show-all`、`data-architecture-filter-reset` 不在 DOM；点击 toggle 后三者出现。
- [ ] 新增 vitest 用例（名含 `collapsed readout keeps Show mentioned reachable`）：构造 `hiddenMentionedKinds` 非空的筛选读数，折叠态下仍存在 `data-architecture-filter-show-mentioned` 按钮，点击后会话提到的实体被显示（与现有 `showHiddenMentioned` 行为一致）；`hiddenMentionedKinds` 为空时该按钮不出现。
- [ ] 新增 vitest 用例（新文件 `src/shared/ui/tests/Tooltip.test.tsx`，名含 `tooltip closes on press and stays closed until re-enter`）：hover 触发后显示；在触发元素内 pointerdown/click 后立即消失；不离开时不再弹出；mouseleave 再 mouseenter 后恢复；触屏长按路径仍可显示。
- [ ] 在 `src/modules/project-workspace/tests/workspaceTabsResponsive.test.tsx` 新增用例（名含 `tab tooltip only when the label is hidden`）：标签文字可见的 tab 不渲染 tooltip，仅图标的 tab 渲染 tooltip，点击后 tooltip 关闭。
- [ ] 既有用例随新结构更新后全部通过：`npx vitest run src/modules/architecture/tests/exportMenu.test.tsx src/modules/architecture/tests/architectureTab.test.tsx src/modules/architecture/tests/mobileCompactToolbar.test.tsx src/modules/architecture/tests/fullscreen.test.tsx` 退出码 0（分文件逐个跑，不做多文件 fan-out）。
- [ ] `npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` 退出码 0（新增文案键 12 个 locale 齐全）。
- [ ] `npx playwright test e2e/architecture-fullscreen.spec.ts e2e/architecture-overlay-layout.spec.ts` 退出码 0（既有全屏 e2e 随新工具栏更新后仍绿）。
- [ ] `npx tsc --noEmit -p tsconfig.json` 退出码 0。

## DoD

在真实运行的页面上完成并留证（截图存 `tmp/`，在任务里贴出）：用 MCP 浏览器打开一个真实会话的 Architecture tab，（1）1440×900、侧栏展开，工具栏为一行、读数为一行，画布顶 y 与画布高度相对改动前（197 / 657）明确改善，贴前后截图和读数；（2）点开 `⋯` 溢出菜单，逐项走通 Export 条目与 Legend；（3）展开读数，点 `Show all` / `Reset filters`，并在存在被隐藏的会话相关实体时直接点折叠态的 `Show mentioned (N)`；（4）点击 workspace 的 Architecture tab 后 tooltip 立即消失且不遮挡 `Open in new tab`；（5）手机视口（390×844）确认 compact 档没有退化。同时存在可用场景时跑 `node scripts/ui-scenario.mjs <scenario.json>` 并贴 JSON 报告与检查点截图。仅有单测通过不算完成。

## Touches

- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/ArchitectureExportMenu.tsx
- src/shared/ui/Tooltip.tsx
- src/modules/project-workspace/WorkspaceTabs.tsx
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
- src/modules/architecture/tests/exportMenu.test.tsx
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/architecture/tests/mobileCompactToolbar.test.tsx
- src/modules/architecture/tests/fullscreen.test.tsx
- src/shared/ui/tests/Tooltip.test.tsx
- src/modules/project-workspace/tests/workspaceTabsResponsive.test.tsx
- e2e/architecture-compact-chrome.spec.ts
- e2e/architecture-fullscreen.spec.ts
- e2e/architecture-overlay-layout.spec.ts
- tasks/gap-architecture-compact-chrome-and-tab-tooltip.md
