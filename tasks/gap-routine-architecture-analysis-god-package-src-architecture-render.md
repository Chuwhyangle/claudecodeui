---
id: gap-routine-architecture-analysis-god-package-src-architecture-render
title: "architecture-analysis: 44 direct files / 89 entities / fanOut 12 / fanIn
  1 (archguard package-stats, fresh 2026-11-14) — the 2026-11-04 architecture
  split moved the implementation "
status: ready
labels:
  - gap
  - routine-filed
  - architecture-analysis
parent: null
children: []
extra: {}
---
## Finding
44 direct files / 89 entities / fanOut 12 / fanIn 1 (archguard package-stats, fresh 2026-11-14) — the 2026-11-04 architecture split moved the implementation into this leaf, which now breaches minFiles=20 and minEntities=50 on its own.

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1794660054673` · ts `2026-11-14T12:40:54.673Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`ArchitectureMinimap`、`ArchitectureInspector`、`ArchitectureSelectionTray`、`createArchitectureFilterController`
- 涉及文件：
- `src/modules/architecture/render/ArchitectureMinimap.tsx:414`
- `src/modules/architecture/render/ArchitectureInspector.tsx:922`
- `src/modules/architecture/render/ArchitectureSelectionTray.tsx:220`
- `src/modules/architecture/render/architectureFilterController.ts:96`
- kind：`god-package`
- verdict：`confirmed`

## Requested action
Split render/ into three subpackages (inspector+selection, minimap+viewport chrome, export/curation) behind index.ts barrels; AC: package-stats reports files<=20 and entities<=50 for each, and the oversize ratchet baseline is lowered in the same commit.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-14T12:40:54.673Z

## Disposition (re-verified and split, 2026-11-14)

**复核（任务 worktree，起点 develop `62e710126`；用本机 archguard CLI `analyze -s ./src --lang typescript --work-dir /tmp/ag-render-before --format json --diagrams package` + `query --package-stats`）：**
- `modules/architecture/render` = **44 files / 89 entities**，与 finding 逐项一致，finding 仍然成立（本机 CLI 为 0.1.45，finding 用 0.1.44；同一读数口径，结果相同）。

**处置：按 requested action 拆分（不是档案化，也不是「已注意到」）。** 把 render/ 的实现按关注点迁入三个子包，每个子包有自己的 `index.ts` barrel；residual render/ 只保留面板 shell 家族（一个文件级 SCC，必须同包）与 filters/search/transport 辅助：

| 结果包 | 迁移内容 | files | entities |
| --- | --- | --- | --- |
| `render/viewport` | `ArchitectureMinimap`、`PlantUmlGraph`、`plantUmlNavigation`、`plantUmlControlArm`、5 个 `useCanvas*`、`usePlantUmlDrawing`、`ArchitectureDock`、`ArchitectureSheet`、`LegendSwatch`、`useArchitectureRefresh`、`architectureRefreshController`、`architectureChromeController` + `minimapGeometry.ts` + barrel | **18** | **45** |
| `render/inspector` | `ArchitectureInspector`（+ 拆出的 `InspectorMentions.tsx`）、`ArchitectureSelectionTray`、`ArchitectureTextPanel` + barrel | **5** | **7** |
| `render/curation` | `ArchitectureExportMenu`、`ArchitectureCurationManager`、`architectureCurationController`、`CurationToast`、`architectureFitExportController`、`exportArtifacts` + barrel | **7** | **13** |
| `render/`（residual） | `ArchitecturePanel` + 8 个 `architecturePanel*` 面板族（同一文件级 SCC）、`architecturePanelShared`、`useArchitecturePanelActions`、filter/search 控制器、chat bridge、deep link、独占组件与 hooks | **19** | **27** |

- **size AC：** 四个结果包全部满足 files<=20 且 entities<=50（最大 viewport 18/45）；residual 也从 44/89 降到 19/27。
- **barrel 边界：** 三个子包各有 `index.ts`，面板侧消费（Dock/Sheet/Inspector/TextPanel/ExportMenu/CurationToast/PlantUmlGraph/useArchitectureRefresh 等）改走 barrel；子包内部仍按文件直接 import，避免 barrel 反向依赖。
- **结构：** 依赖方向保持单向 root -> viewport（-> dom/layout/hooks），root -> inspector（TextPanel -> curation -> exportArtifacts），无子包反向 import residual；`frontend-import-cycle-budget.test.ts` 的目录环仍是同样 4 组、模块 SCC 仍是 cockpit ↔ project-workspace，没有新增组或成员。
- **oversize ratchet 下调（requested action 第二条）：** `ArchitectureInspector.tsx` 990→**749** 行（mention 行/五态区块拆到 `InspectorMentions.tsx`），`ArchitectureMinimap.tsx` 863→**624** 行（纯几何/类型拆到 `minimapGeometry.ts`），二者都落到 800 行线下，基线中两条条目**删除**（lowering）；`PlantUmlGraph.tsx` 1820 行随文件迁到 `viewport/`，基线按新路径重键、读数不变。没有任何读数上调。
- **e2e / 路径敏感判据同步：** `e2e/architecture-canvas-layout.spec.ts` 的 Vite module route 改到 `render/viewport/PlantUmlGraph.tsx`；`i18nArchitectureTabCompleteness`、`layoutAspect`、`architectureTab`、`exportMenu` 等读取源码路径/目录的判据同步到新路径。
- **⚠️ 未在本会话运行的项：** Playwright e2e 需要现场 server+browser，本 worker 只改了 import 路径与文件位置、未改 DOM 契约；fan-in 的 e2e lane 会执行该 spec。

## Evidence
- 拆分前 archguard（worktree，`/tmp/ag-render-before`）：`modules/architecture/render` = 44 files / 89 entities。
- 拆分后 archguard（同一 CLI、同一 TypeScript scope，`/tmp/ag-render-after`）：`render` 19/27、`render/viewport` 18/45、`render/inspector` 5/7、`render/curation` 7/13。
- 类型：`npx tsc --noEmit -p tsconfig.json`、`-p server/tsconfig.json`、`-p scripts/tsconfig.json` → 0 error。
- 客户端回归（memory-capped `QUAY_MEMORY_MAX=4G scripts/with-memory-cap.sh`，`--maxWorkers=2`）：`npx vitest run src/modules/architecture/tests` → **44 files / 691 tests passed**。
- 结构棘轮：`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/architecture-ratchet.test.ts server/shared/tests/frontend-import-cycle-budget.test.ts` → **15 pass / 0 fail**（架构棘轮 6、环预算 9；目录环 pin 与模块 SCC pin 未变）。
- 受影响服务端判据：`server/shared/tests/cloudpit-runtime-flip.test.ts` + `server/modules/architecture/tests/architecture-routes.test.ts` → **50 pass / 0 fail**。
- Lint：`npx oxlint src/modules/architecture server/shared/tests e2e/architecture-canvas-layout.spec.ts` → 0 error（90 warnings，与 develop 同量；其中新增/迁移文件无新错误）。
- 基线：`architecture-ratchet.baseline.json` 删除 Inspector/Minimap 两条、重键 PlantUmlGraph；`frontend-import-cycle-budget.baseline.json` 的 readings 在 merge develop 后按同一共享扫描器重测为 files=746 / staticFileEdges=2685 / nodeCount=136 / unresolvedInternal=100 / nonLiteralDynamic=2，pin 组不变。
- 探针只立案不执行：复核、拆分、验证全部由派发链的 worker 会话执行，例程没有代跑。

## ADR-007 dark-axis record
- L_D archguard: render fileCount=19 entityCount=27 (was 44/89); viewport fileCount=18 entityCount=45; inspector fileCount=5 entityCount=7; curation fileCount=7 entityCount=13; all <= minFiles20/minEntities50
- L_G archguard: directoryCycleGroups=4 (unchanged), newDirectoryCycleGroups=0, moduleSccGroups=1 (unchanged)

## AC
- [x] `.quay/routine-findings.jsonl` 中 finding `god-package-src-architecture-render`（routine `architecture-analysis`，runId `architecture-analysis-1794660054673`）所描述的问题被复核并处置
- [x] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [x] 上面的判据实跑通过（复核读数、拆分后 package 读数、三条 tsc、44 files / 691 tests、两条结构棘轮、受影响服务端判据与 lint 均见 Evidence）
- [x] ⛔ 探针只立案不执行：本任务的拆分与验证由派发链执行，例程未代跑

## Touches
- `src/modules/architecture/**`
- `e2e/architecture-canvas-layout.spec.ts`
- `server/shared/tests/architecture-ratchet.baseline.json`
- `server/shared/tests/frontend-import-cycle-budget.baseline.json`
- `tasks/gap-routine-architecture-analysis-god-package-src-architecture-render.md`

## Blocker

**2026-11-14T13:10:27.615Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=merge-develop: Auto-merging server/shared/tests/architecture-ratchet.baseline.json
CONFLICT (content): Merge conflict in server/shared/tests/architecture-ratchet.baseline.json
Auto-merging src/modules/architecture/render/ArchitecturePanel.tsx
CONFLICT (content): Merge conflict in src/modules/architecture/render/ArchitecturePanel.tsx
Auto-merging src/modules/architecture/render/architecturePanelCanvas.tsx
Auto-merging src/modules/architecture/render/architecturePanelFilters.tsx
Auto-merging src/modules/architecture/render/architecturePanelReadout.tsx
Auto-merging src/modules/architecture/render/curation/architectureFitExportController.ts
Auto-merging src/modules/architecture/render/inspector/ArchitectureInspector.tsx
CONFLICT (content): Merge conflict in src/modules/architecture/render/inspector/ArchitectureInspector.tsx
Auto-merging src/modules/architecture/render/inspector/ArchitectureTextPanel.tsx
Auto-merging src/modules/architecture/render/useArchitecturePanelActions.ts
CONFLICT (content): Merge conflict in src/modules/architecture/render/useArchitecturePanelActions.ts
Auto-merging src/modules/architecture/render/viewport/ArchitectureMinimap.tsx
Auto-merging src/modules/architecture/render/viewport/PlantUmlGraph.tsx
CONFLICT (content): Merge conflict in src/modules/architecture/render/viewport/PlantUmlGraph.tsx
Auto-merging src/modules/architecture/render/viewport/useCanvasDrawingSemantics.ts
CONFLICT (content): Merge conflict in src/modules/architecture/render/viewport/useCanvasDrawingSemantics.ts
Auto-merging src/modules/architecture/render/viewport/useCanvasFitZoom.ts
CONFLICT (content): Merge conflict in src/modules/architecture/render/viewport/useCanvasFitZoom.ts
Auto-merging src/modules/architecture/render/viewport/useCanvasKeyboardNavigation.ts
CONFLICT (content): Merge conflict in src/modules/architecture/render/viewport/useCanvasKeyboardNavigation.ts
Auto-merging src/modules/architecture/render/viewport/useCanvasSurfaceBindings.ts
CONFLICT (content): Merge conflict in src/modules/architecture/render/viewport/useCanvasSurfaceBindings.ts
Auto-merging src/modules/architecture/render/viewport/usePlantUmlDrawing.ts
Auto-merging src/modules/architecture/tests/architectureCurationController.test.ts
Auto-merging src/modules/architecture/tests/architectureTab.test.tsx
CONFLICT (content): Merge conflict in src/modules/architecture/tests/architectureTab.test.tsx
Auto-merging src/modules/architecture/tests/elementRelationFilter.test.ts
Auto-merging src/modules/architecture/tests/exportMenu.test.tsx
CONFLICT (content): Merge conflict in src/modules/architecture/tests/exportMenu.test.tsx
Auto-merging src/modules/architecture/tests/layoutAspect.test.tsx
CONFLICT (content): Merge conflict in src/modules/architecture/tests/layoutAspect.test.tsx
Auto-merging src/modules/architecture/tests/minimap.test.tsx
Auto-merging src/modules/architecture/tests/plantUmlText.test.ts
CONFLICT (content): Merge conflict in src/modules/architecture/tests/plantUmlText.test.ts
Auto-merging src/modules/architecture/tests/selectionTray.test.tsx
CONFLICT (content): Merge conflict in src/modules/architecture/tests/selectionTray.test.tsx
Auto-merging src/modules/architecture/tests/textPanel.test.tsx
CONFLICT (content): Merge conflict in src/modules/architecture/tests/textPanel.test.tsx
Automatic merge failed; fix conflicts and then commit the result.
- run_id：wk-prod-anchor
- session_id：700529e5-affc-4e9c-acba-0febf6209c64
