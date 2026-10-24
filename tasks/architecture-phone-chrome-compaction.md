---
id: architecture-phone-chrome-compaction
title: 手机架构图外壳压缩：竖屏画布高度占比 ≥ 74%，控制件不盖住图与包标签页
status: todo
labels:
  - feature
parent: null
children: []
extra:
  schema: execution
depends_on:
  - architecture-single-scale-fit-contract
---
## Proposal

<!-- dedup-ref -->本任务把手机竖屏上架构图的外壳压缩到让画布占大部分屏幕。2026-10-24 在 390×844 上实测（构建 09:45）：页头、两排工具栏（Class diagram / File graph、新标签打开、Text 一排，Fullscreen、Adjust 一排）、摘要条合计占去 266px，画布 `clientHeight` 只有 578px（占视口 68%）；Focus | Overview 胶囊与缩放控件叠在图的下半部分；摘要与横幅盖住左上角的包标签页（`tmp/fit-phone-quay.png`、`tmp/fit-phone-L.png`）。与已完成的 `architecture-landscape-phone-layout`（只处理横屏矮屏）、`architecture-chrome-and-mobile-drawer-polish` 不是同一个机制。依赖 `architecture-single-scale-fit-contract`（Focus 控件与横幅在那里被删除，画布高度的变化也由它的适应求解接住），故用 `depends_on` 排在其后。

要求：
1. **工具栏一行**：触摸竖屏（宽 ≤ 480）下，主要入口压成一行——视图切换（Class diagram / File graph）、Text、Adjust 各为一个入口，Fullscreen 与 Open in new tab 收进 Adjust 面板或一个 "More" 入口；不允许出现第二排。
2. **摘要条默认折叠为一行**（只显示 "Showing N · M related"），展开后才显示 Hidden / Show all / Reset filters 等；折叠状态在会话内记住。
3. **控制件不盖图**：缩放按钮、Fit、读数放在画布外的保留边（画布底部一条 40px 高的栏）或做成可收起的浮层，默认收起为一个小按钮；不得与图的包标签页、类名文字矩形相交（沿用现有的矩形相交读数）。
4. **画布占比**：390×844 竖屏缺省状态下宿主 `clientHeight` ≥ 视口高度的 74%（≥ 625px，修复前 578px）。
5. 桌面与横屏行为不变（横屏由 `architecture-landscape-phone-layout` 负责）。

## Plan

1. `ArchitecturePanel.tsx`：触摸竖屏的工具栏单行布局、More 入口、摘要条折叠状态。
2. `PlantUmlGraph.tsx`：缩放控件的位置与可收起；与适应求解的画布尺寸读数保持一致。
3. `ArchitectureExportMenu.tsx`：Export 在窄屏进入 More 的位置。
4. 文案与测试：新增文案补全 10 个 locale；单元与 e2e 读数配控制臂。

## AC

- [ ] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0：新增用例——触摸竖屏下工具栏只有一行（所有工具栏按钮的 `top` 相同，容差 2px）；Fullscreen 与 Open in new tab 在 More 入口内；摘要条默认折叠且展开后恢复全部内容；缩放控件默认不与包标签页矩形或类名文字矩形相交；桌面与横屏不进入该布局；既有用例不回归
- [ ] `npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` exit 0：十个 locale 的新增文案齐全
- [ ] `npx playwright test e2e/architecture-canvas-layout.spec.ts` exit 0（整份文件仍在单文件天花板内，必要时在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 更新条目并写明实测）：390×844 视口、S / M / L / Quay 形夹具，缺省状态宿主 `clientHeight` ≥ 视口高度的 74%；工具栏只有一行；缩放控件矩形与任何包标签页、类名文字矩形不相交
- [ ] `npx playwright test e2e/architecture-canvas-layout.spec.ts --grep "control arm"` exit 0：控制臂——恢复两排工具栏时画布占比与单行读数变红；恢复浮层位置时相交读数变红；主臂与控制臂用同一读取函数
- [ ] `npm run typecheck`、`npm run build`、`npm run lint` 对 `src/modules/architecture/` exit 0

## DoD

真实浏览器里用 390×844 触摸视口打开本会话与 Quay OO 会话的 Architecture 标签：读出宿主高度与占视口比例（修复前 578px、68%），截图确认工具栏单行、控制件不盖图；点 More 与展开摘要各一次；同时确认 PC 与横屏没有回归。截图存 `tmp/` 并贴进 Evidence；做过的任何改动必须还原。

## Touches

- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/ArchitectureExportMenu.tsx
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts
- e2e/architecture-canvas-layout.spec.ts
- playwright.config.ts
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
- tasks/architecture-phone-chrome-compaction.md
