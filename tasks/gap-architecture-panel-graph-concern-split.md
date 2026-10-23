---
id: gap-architecture-panel-graph-concern-split
title: ArchitecturePanel/PlantUmlGraph
  按关注点切分（第一刀）：存储/过滤/DOM/样式/常量/子组件迁到命名兄弟文件，两个主组件只留编排与渲染
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**机制与去重（立案时实测，2026-10-23）**：机制词 grep → 命中均为行为任务（zoom-fit / interaction-consistency / tab-ui），**「把 ArchitecturePanel/PlantUmlGraph 两个 god 文件按关注点切分」无人认领**。granularity 报 4 个 open peers 共享这两个文件（`architecture-chrome-and-mobile-drawer-polish` ready、`architecture-layout-orientation-matches-canvas` todo、`architecture-node-size-from-drawn-content` ready、`architecture-send-selection-to-chat-entry-points` ready）——**4 个行为任务都在改同一个 god 文件**，正是「god 文件导致串行」的实锤（ArchitecturePanel nLanded=32、PlantUmlGraph nLanded=36）。判定 **separate**（机制不同），理想顺序本条先落地、4 个行为任务的改动落点才分散。

### 现状（立案时实测）

- `src/modules/architecture/ArchitecturePanel.tsx` = **4055 行**、131 处 hooks，混装：存储持久化（8 个 read/write + 5 个 STORAGE_PREFIX）、类型守卫（isElementKind/isRelationPreset）、过滤状态计算（addHidden/truncationReading）、4 个子组件（ArchitectureExportMenu ~200 行 / ArchitectureEmptyState / LegendSwatch / CurationToast + useDismissiblePopover）、主面板编排（3000+ 行）。
- `src/modules/architecture/PlantUmlGraph.tsx` = **2914 行**、86 处 hooks，混装：模块级 DOM/cytoscape 操作函数（idOf/rename/normalizeDrawnPackageId/focusElementFor/neighbours/…约 15 个）、内联样式 + 常量（HIGHLIGHT_STYLE/CANVAS_UNSELECTABLE_STYLE/TOUCH_TARGET_STYLE/GROUP_PREFIX/STUB_PREFIX/DOUBLE_TAP_MS/KEYBOARD_PAN_STEP/事件名/DIM_OPACITY）、主渲染组件（~2000 行）。
- 这是「叶子拆了、主干没拆」：架构模块有 25 个小叶子（adaptiveGrouping/elkAspectEngine/readableZoom/svgViewport…），但两个主文件没拆。

### 改法（第一刀，R1 纯提取，安全）

- `ArchitecturePanel.tsx`：存储持久化 8 函数 → `panelPersistence.ts`；过滤/类型守卫纯函数 → `panelFilters.ts`；4 个子组件 → 各自兄弟文件。
- `PlantUmlGraph.tsx`：DOM/cytoscape 操作函数 → `graphDom.ts`；样式 → `graphStyles.ts`；常量 → `graphConstants.ts`。
- 两个主组件只留编排/渲染；对外公开签名不变。主面板/主图的状态机是第二刀（R1 风险高，先不碰）。

⛔ 前端护栏：新文件落 `src/modules/architecture/`（同目录）；类型用 `type` 不用 `interface`；`@/` 别名；子组件命名描述性、不放 utils.ts 收容袋。

<!-- dedup-ref --> 相关但不同机制：`architecture-chrome-and-mobile-drawer-polish`（ready）、`architecture-layout-orientation-matches-canvas`（todo）、`architecture-node-size-from-drawn-content`（ready）、`architecture-send-selection-to-chat-entry-points`（ready）四者与本条共享这两个 god 文件、机制均为行为任务，调度器串行；理想顺序本条先落地（切分后 4 个任务的落点不再争用同一文件），非硬约束。均不构成本条前置。

## Plan

1. **盘点**：把两个文件的函数/常量/子组件逐条归类，标读写点。
2. **迁纯逻辑 + 子组件 + 样式/常量**：逐字迁到命名兄弟文件；主组件 import 回来。纯位移。
3. **判据**：两个 god 文件瘦身 + 兄弟文件存在 + 既有测试绿。
4. **UI 验证 + 收口**。

## AC

- [x] (a) **兄弟文件存在且被引用**：`test -f src/modules/architecture/panelPersistence.ts -a -f src/modules/architecture/panelFilters.ts -a -f src/modules/architecture/graphDom.ts -a -f src/modules/architecture/graphStyles.ts -a -f src/modules/architecture/graphConstants.ts` 退出 0；`grep -qE "panelPersistence|panelFilters|graphDom|graphStyles|graphConstants" src/modules/architecture/ArchitecturePanel.tsx src/modules/architecture/PlantUmlGraph.tsx` 退出 0。
- [x] (b) **两个 god 文件瘦身**：`test "$(wc -l < src/modules/architecture/ArchitecturePanel.tsx)" -lt 4055 -a "$(wc -l < src/modules/architecture/PlantUmlGraph.tsx)" -lt 2914` 退出 0（基线=立案实测）。
- [x] (c) **既有行为判据不改一字仍绿**：`src/modules/architecture/tests/` 下覆盖 panel/graph 的既有 vitest 判据窄跑退出 0（执行时以实测为准；若文件名漂移用等价判据替换并记录）。
- [x] (d) **静态门**：`npm run typecheck` 退出 0；`npm run lint` 退出 0；`npm run build:client` 退出 0。
- [x] (e) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`。

## DoD

真实落地的标准是「存储/过滤/DOM/样式/常量/子组件各归其位进了命名兄弟文件、两个主组件只留编排与渲染、架构图行为不变」，不是「多了几个文件」。必须贴出：①(a) 各兄弟文件的导出清单与主组件的 import 行；②(b) 两个 `wc -l` 前后读数；③(c) 既有判据退出码；④(d) typecheck/lint/build:client；⑤**UI 验证（强制）**：(i) MCP 浏览器在真实运行页面上亲手走一遍架构 tab 的交互（打开图、缩放/拖拽、过滤隐藏 functions、切 scope/detail、选择实体、导出），截图存 `tmp/` 并贴出；(ii) 存在覆盖此功能的场景时跑 `node scripts/ui-scenario.mjs <scenario.json> …` 并贴 JSON 报告与检查点截图，无覆盖场景则说明并靠 MCP 浏览器验证；⑥纯位移核对（`git diff` 对迁出函数/子组件/样式是纯移动；无法原样迁的逐条列出）；⑦`git diff` 只含 Touches。运行结束不重启 :3001、不发布。

### 执行记录（2026-10-23，worker）

- **①导出清单**：`panelPersistence.ts` → readStoredScope / writeStoredScope / readStoredDetail / writeStoredDetail / readStoredTouchHintDismissed / writeStoredTouchHintDismissed / BROWSER_CURATION_STORAGE；`panelFilters.ts` → ArchitectureGranularity(type) / isElementKind / isRelationPreset / readStoredFilter / writeStoredFilter / addHidden / EMPTY_HIDDEN / truncationReading；`ArchitectureExportMenu.tsx` → ArchitectureExportMenu；`ArchitectureEmptyState.tsx` → ArchitectureEmptyState；`LegendSwatch.tsx` → LegendSwatch；`CurationToast.tsx` → CurationToast；`useDismissiblePopover.ts` → useDismissiblePopover；`graphDom.ts` → 39 个 DOM 助手 + 7 个类型（PlantUmlView / PlantUmlDrawnModel / PlantUmlToPlantUml / PlantUmlRenderDetailed / PlantUmlApplyView / ReadableView / MarkerRect / SemanticCapture），markerAnchor 由 `PlantUmlGraph.tsx` 原路 re-export（既有判据 `elementRelationFilter.test.ts` 的 import 一字未改）；`graphStyles.ts` → HIGHLIGHT_STYLE / CANVAS_UNSELECTABLE_STYLE / SEMANTIC_* 调色板；`graphConstants.ts` → GROUP_PREFIX / STUB_PREFIX / DOUBLE_TAP_MS / TOOLBAR_BUTTON_CLASS / KEYBOARD_PAN_STEP / ENTITY_SELECTED_EVENT / ENTITY_HIGHLIGHT_EVENT / EntitySelection(type)。主组件 import 行：ArchitecturePanel.tsx:112/121（panelFilters、panelPersistence）+ 105-110（5 个子组件）；PlantUmlGraph.tsx:92/126/130/137（graphConstants、graphDom、graphStyles、markerAnchor re-export）。
- **②行数**：ArchitecturePanel 4055(立案) / 4201(develop 实测) → **3584**；PlantUmlGraph 2914 / 3963 → **2616**。
- **③(c)**：`npx vitest run src/modules/architecture/tests/` → 27 files / **439 passed**，退出 0（merge develop 后重跑同读数）。
- **④(d)**：`npm run typecheck` 0；`npm run lint` 0（仅既有 warning）；`npm run build:client` 0。
- **⑤(i) UI 验证**：本会话没有 MCP 浏览器工具（ToolSearch 无匹配），改用 Playwright 在真实运行的 server+client（e2e fixture home 的 120 实体 `.archguard` 工程）上逐项操作并截图，存 `tmp/architecture-split-verify/`：01 打开（class diagram，Showing 60 · 60 related，Hidden 40 functions）、02 选实体（inspector 读出 kind/members/related + "1 selected · Send to chat"）、03 过滤（勾回 function 后 120 实体全部重绘）、04 scope +1（→ +3）、05 detail Core（23 实体）、06 切 File graph（5 个目录框）、07 缩放 100%→156% 并拖拽、08 Export 菜单、09 导出后；SVG 导出下载成功 7018 bytes（`tmp/architecture-split-verify/exported.svg`），JSON 读数存 `report.json`。该 spec 为一次性脚手架，跑完即删、`playwright.config.ts` 的临时登记已 `git checkout` 还原，均未进提交。
- **⑤(ii)**：仓库内唯一场景 `e2e/scenarios/quay-wall-focus-pin-utter.json` 只驱动 quay-panel（`ui-scenario.mjs` 的 opener 只认 `quay-panel`），无覆盖 architecture tab 的场景，故按 (i) 的浏览器验证记录。
- **⑥纯位移核对**：脚本对比新文件每一行与原文件对应行（allow `export ` 前缀）——非逐字行共 41 行，全部是 10 个 import 头、10 段新文件头注释、以及 ArchitectureEmptyState/LegendSwatch 两处 doc 重排（为满足「导出组件须注明消费方」补 "Used by `ArchitecturePanel` only."）；**0 行函数体/样式/常量被改写**。
- **⑦**：`git diff --name-only $(git merge-base HEAD develop) HEAD` = 12 个文件，全部落在 Touches；`anti-drift-touches-check.js` 报告 12 actual / 13 globs，OK。
- 未重启 :3001、未发布。

## Touches

- `src/modules/architecture/ArchitecturePanel.tsx`（存储/过滤/子组件迁出，公开签名不变）
- `src/modules/architecture/PlantUmlGraph.tsx`（DOM/样式/常量迁出，公开签名不变）
- `src/modules/architecture/panelPersistence.ts` (new)
- `src/modules/architecture/panelFilters.ts` (new)
- `src/modules/architecture/ArchitectureExportMenu.tsx` (new)
- `src/modules/architecture/ArchitectureEmptyState.tsx` (new)
- `src/modules/architecture/LegendSwatch.tsx` (new)
- `src/modules/architecture/CurationToast.tsx` (new)
- `src/modules/architecture/useDismissiblePopover.ts` (new)
- `src/modules/architecture/graphDom.ts` (new)
- `src/modules/architecture/graphStyles.ts` (new)
- `src/modules/architecture/graphConstants.ts` (new)
- `tasks/gap-architecture-panel-graph-concern-split.md`（自触）
