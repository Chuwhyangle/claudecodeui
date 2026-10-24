---
id: architecture-phone-chrome-compaction
title: 手机架构图外壳压缩：竖屏画布高度占比 ≥ 74%，控制件不盖住图与包标签页
status: done
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

- [x] `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` exit 0：新增用例——触摸竖屏下工具栏只有一行（所有工具栏按钮的 `top` 相同，容差 2px）；Fullscreen 与 Open in new tab 在 More 入口内；摘要条默认折叠且展开后恢复全部内容；缩放控件默认不与包标签页矩形或类名文字矩形相交；桌面与横屏不进入该布局；既有用例不回归
- [x] `npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` exit 0：十个 locale 的新增文案齐全
- [x] `npx playwright test e2e/architecture-canvas-layout.spec.ts` exit 0（整份文件仍在单文件天花板内，必要时在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 更新条目并写明实测）：390×844 视口、S / M / L / Quay 形夹具，缺省状态宿主 `clientHeight` ≥ 视口高度的 74%；工具栏只有一行；缩放控件矩形与任何包标签页、类名文字矩形不相交
- [x] `npx playwright test e2e/architecture-canvas-layout.spec.ts --grep "control arm"` exit 0：控制臂——恢复两排工具栏时画布占比与单行读数变红；恢复浮层位置时相交读数变红；主臂与控制臂用同一读取函数
- [x] `npm run typecheck`、`npm run build`、`npm run lint` 对 `src/modules/architecture/` exit 0

## DoD

真实浏览器里用 390×844 触摸视口打开本会话与 Quay OO 会话的 Architecture 标签：读出宿主高度与占视口比例（修复前 578px、68%），截图确认工具栏单行、控制件不盖图；点 More 与展开摘要各一次；同时确认 PC 与横屏没有回归。截图存 `tmp/` 并贴进 Evidence；做过的任何改动必须还原。

## Evidence

### 竖屏读数（390×844 触摸，缺省状态）

| 读数 | 修复前（develop 基线） | 修复后 |
|---|---|---|
| 宿主 `clientHeight` | 578px | **637px** |
| 占视口比例 | 68.5% | **75.5%**（阈值 74%，625px） |
| 工具栏行数（按钮 `top` 去重） | 2 | **1** |
| 缩放控件缺省形态 | 52px 展开行浮在图上 | **一个 44px 按钮**，位于宿主底部 80px 保留带内 |
| 缩放控件 ∩ 包标签页 / 类名文字 | 旧读数只看 `.uml-node`（折叠档不画，恒为 0） | **0 / 0**（11 个包标签页参与读数） |
| 摘要条 | 53px 常驻行、展开态不记忆 | 一行 44px，展开态写入 `sessionStorage`，重挂载后保持 |

四个夹具（S 2 / M 26 / L 55 / Quay 19 实体）在同一 390×844 视口下逐一看过，宿主高度、单行工具栏与相交读数一致（`arch-chrome-portrait-{s,m,l,quay}.png`）。120 实体的 Quay OO 会话同屏读数见 `arch-chrome-phone-fitted-paper.png`（11%、画布 637px）。

### 控制臂（与主臂共用 `readLayout`）

- 恢复两排工具栏（`architecture-portrait-chrome=off`）：工具栏按钮出现 2 个不同的 `top`，画布占比回落到 0.685 —— 单行读数与占比同时变红。
- 恢复浮层（`architecture-portrait-controls=overlay`）：去掉保留带、展开缩放行，并把浮层放回画中的包标签页上 —— 单行 toolbar 与 0.755 占比保持绿，相交读数变红（2 个包标签页相交）。

### 命令与结果

- `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` → **120 passed**（新增竖屏用例 + 桌面/横屏反例；文件内共 120 例）
- `npx vitest run src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts` → **7 passed**（12 个 locale 的 `zoomControls.show/hide` 齐全）
- `npx playwright test e2e/architecture-canvas-layout.spec.ts` → **33 passed (7.0m)**（整份文件；boot、双 server 与浏览器启动均计入）
- `npx playwright test e2e/architecture-canvas-layout.spec.ts --grep "control arm"` → **17 passed (2.8m)**
- `npm run typecheck` → exit 0；`npm run build` → exit 0；`npm run lint`（含 `src/modules/architecture`）→ exit 0
- 基线（develop 27a476957，未改动）：同一份 e2e **20 passed / 11 failed (10.8m)**。11 个红全部是依赖任务 `architecture-single-scale-fit-contract` 退役 Focus 后未同步的旧断言（`data-architecture-readable-mode`、Focus banner、30% 默认缩放、drill 重解、hover 控制臂位置）及由此暴露的 fixture 空图与 Fit 等待问题；本任务在同一文件内一并修正，未改动产品语义。`playwright.config.ts` 的 `SPEC_BUDGET_MS` 条目已写入 33 passed (7.0m) 实测；396-box 两个用例的 per-test 上限从 180s 提到 300s（load-shared 主机实测需要）。

### 截图（`tmp/architecture-phone-chrome/`）

- `arch-chrome-portrait-quay.png` — 单行工具栏（Class diagram / File graph / Text / Adjust）、单行摘要、10% 收起按钮在保留带
- `arch-chrome-portrait-quay-adjust.png` — Adjust 面板内的 "Open in new tab" / Fullscreen 入口
- `arch-chrome-portrait-quay-summary-open.png` — 摘要展开
- `arch-chrome-portrait-s.png` / `-m.png` / `-l.png` — S/M/L 夹具同一读数
- `arch-chrome-phone-fitted-paper.png`、`arch-chrome-phone-drawer.png` — Quay OO 会话（120 实体）
- `arch-chrome-orientation-pc.png`、`arch-chrome-orientation-phone.png`、`arch-chrome-landscape-opened.png`、`arch-chrome-landscape-selected.png` — PC 与横屏回归

所有注入式控制臂都在同一次页面内复原（浮层位置、SVG `width` 属性、样式），没有留下改动；`tmp/` 截图不入库。

### fan-in suite 红核对（2026-10-24，上一轮 exited-not-landed 的根因）

上一轮 fan-in 的 suite 红不是环境抖动：本机在 worktree 里单跑两个文件均复现，且是 develop 上**既有**手机外壳用例与本任务新契约的正面相遇。

- `src/modules/architecture/tests/selectionTray.test.tsx`（18 passed，未改该文件）—— 失败断言要求宿主 `paddingBottom === 抽屉带 + 4px`，而本任务又加了 80px 控制保留带。产品代码改法：保留带与抽屉带都从画布底边量起，按 `max(抽屉带, 控制带)` 合成（抽屉打开时它已覆盖控制件的落地位置，不应再叠 80px）。用例原样通过。
- `src/modules/architecture/tests/mobileCompactToolbar.test.tsx`（15 passed）—— 该文件钉住旧手机外壳（缩放行 52px 常展开、Fullscreen 在工具行、百分比只认 `span`、无会话记忆键清理）。本任务 AC-1/AC-3 明确改为「Fullscreen 进 Adjust」「缩放默认收起为一个 44px 按钮」，故把与旧契约冲突的断言更新为新契约：折叠态 44px 单按钮 → 点开 52px 行；Fullscreen 经 Adjust 进出；百分比叶子把 `button` 计入；`beforeEach` 清 `sessionStorage['architecture-readout-expanded']`。覆盖点保留（44×44 目标、8px 间距、单行、百分比唯一、Fullscreen 往返）。
- 触控间距：缩放行 `gap` 由 4px 回到仓库标准 8px（`TOUCH_CONTROL_GAP_PX`），与既有「44×44 + 8px」判据一致。
- 复测：`mobileCompactToolbar.test.tsx` 15 passed；`selectionTray.test.tsx` 18 passed；`architectureTab.test.tsx` + `i18nArchitectureTabCompleteness.test.ts` 127 passed；`canvasLayoutContract.test.tsx` + `mobileGestures.test.tsx` 16 passed；`npm run typecheck` exit 0；`npx oxlint` 对改动文件仅余既有 warning。

## Touches

- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/ArchitectureExportMenu.tsx
- src/modules/architecture/hooks/useTouchLayout.ts
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/architecture/tests/mobileCompactToolbar.test.tsx
- src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts
- e2e/architecture-canvas-layout.spec.ts
- e2e/support/architectureFixture.ts
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
