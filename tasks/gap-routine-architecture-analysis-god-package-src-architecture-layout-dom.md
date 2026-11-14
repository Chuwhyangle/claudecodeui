---
id: gap-routine-architecture-analysis-god-package-src-architecture-layout-dom
title: "architecture-analysis: layout = 12 files / 117 entities (highest entity
  count in src) and dom = 22 files / 84 entities with fanIn 5 — both breach
  minEntities=50, and dom additional"
status: done
labels:
  - gap
  - routine-filed
  - architecture-analysis
parent: null
children: []
extra: {}
---
## Finding
layout = 12 files / 117 entities (highest entity count in src) and dom = 22 files / 84 entities with fanIn 5 — both breach minEntities=50, and dom additionally breaches minFiles=20 and minFanIn=5.

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1794660054673` · ts `2026-11-14T12:40:54.673Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`drawSemanticLayout`、`fitAvoidingCorners`、`fitToLayoutBudget`、`planEntityNameForWidth`
- 涉及文件：
- `src/modules/architecture/layout/graphDom.ts:846`
- `src/modules/architecture/layout/svgViewport.ts:189`
- `src/modules/architecture/dom/layoutBudget.ts:92`
- `src/modules/architecture/dom/semanticZoomPlan.ts:234`
- kind：`god-package`
- verdict：`confirmed`

## Requested action
Split dom/ by concern (gesture+selection controllers vs layout/readout helpers) and layout/ by pipeline vs drawing, each with its own index.ts barrel; AC: package-stats files<=20 and entities<=50 per new leaf.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-14T12:40:54.673Z

## Disposition
处置结论：**已修掉**（尺寸维度），关系维度按 archguard 口径如实记录为不能由拆包降低的 residual，不声称转绿。

拆包形状（每个新叶子都有自己的 `index.ts` barrel，barrel 用 `@/` 别名 re-export）：

- `dom/interaction/`：gesture/selection controllers + selection model + curation + navigation + hierarchy
- `dom/readout/`：detailRanking / elementRelationFilter / readoutNumbers / hoverHintPlacement / bottomSlotLayout
- `dom/planning/`：semantic-zoom plan+read / layoutBudget / layoutOrientation / adaptiveGrouping / explosionLod / useArchitectureGraph
- `dom/` 根只剩共享词表：`rendererContract.ts` / `graphConstants.ts` / `graphStyles.ts`
- `layout/drawing/`：graphDom + graphLayoutPipeline + graphViewportController + drawnFit
- `layout/engine/`：svgViewport + readableZoom（二者互为 file-level SCC，整体同包）+ semanticZoomLayout + elkAspectEngine
- `layout/plantuml/`：archguardToPlantUml + plantUmlText
- `layout/panel/`：panelFilters + panelPersistence

读数（同一 instrument：archguard 0.1.45，worktree 上 `analyze -s src --lang typescript --work-dir /tmp/ag-layout-dom --no-cache` 后 `query --package-stats 5`；develop 基线用同一 instrument 复现 finding 的 dom 22/84、layout 12/117）：

| 包 | files | entities | files<=20 / entities<=50 |
| --- | --- | --- | --- |
| `modules/architecture/dom`（共享词表） | 3 | 0 | PASS |
| `modules/architecture/dom/interaction` | 7 | 22 | PASS |
| `modules/architecture/dom/readout` | 6 | 22 | PASS |
| `modules/architecture/dom/planning` | 9 | 40 | PASS |
| `modules/architecture/layout/drawing` | 5 | 47 | PASS |
| `modules/architecture/layout/engine` | 5 | 33 | PASS |
| `modules/architecture/layout/plantuml` | 3 | 22 | PASS |
| `modules/architecture/layout/panel` | 3 | 15 | PASS |

拆前 → 拆后：`dom` 22 files / 84 entities → 根 3/0，三个叶子最大 9 files / 40 entities；`layout` 12 files / 117 entities → 四个叶子最大 5 files / 47 entities。所有新叶子均 ≤19 files、≤49 entities（archguard 在 `>=` 阈值命中，故按比 AC 多留一格实现）。

Residual（诚实记录，不声称转绿）：`archguard_detect_god_packages` 的 `fanIn`/`fanOut` 是按 entity relation 计数；拆包把原先的包内 relation 变成跨包 relation，因此关系读数不会下降（拆后 architecture 各叶子 fanIn 22–117、fanOut 17–163）。finding 的 AC 明确只钉 `files<=20` 与 `entities<=50`，尺寸维度已闭合；关系维度是 archguard 的计数口径使然，不是本次未修。

实现方式：文件 `git mv` 到新目录（verbatim 移动），全仓 import specifier 机械改写；两个按字面路径读源码的测试（`layoutAspect.test.tsx`、`architectureTab.test.tsx`）改指新路径；`architecture-ratchet.baseline.json` 把 5 条 oversize 与 1 条 moduleMutableState 读数 re-key 到新路径（`graphDom.ts` 1485→1482，是下降；无任何读数上调）。

实跑验证：
- `npx tsc --noEmit -p tsconfig.json`、`-p server/tsconfig.json`、`-p scripts/tsconfig.json` → 全部 exit 0
- `npx oxlint` 改动文件 → 0 error
- `bash scripts/with-memory-cap.sh npx vitest run src/modules/architecture` → 44 files / 691 tests pass
- `bash scripts/with-memory-cap.sh npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/architecture-ratchet.test.ts server/shared/tests/frontend-import-cycle-budget.test.ts` → 15 tests pass（目录 SCC 仍是既有 pinned 集合，未新增环）

## Axis record (ADR-007)
- L_G archguard: cycles=1 (pre-existing `shared/voice-asr` cycle, outside architecture), dom.maxFiles=9 dom.maxEntities=40, layout.maxFiles=5 layout.maxEntities=47

## AC
- [x] `.quay/routine-findings.jsonl` 中 finding `god-package-src-architecture-layout-dom`（routine `architecture-analysis`，runId `architecture-analysis-1794660054673`）所描述的问题被复核并处置
- [x] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [x] 上面的判据实跑通过
- [x] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `e2e/architecture-fullscreen-fit.spec.ts`
- `server/shared/tests/architecture-ratchet.baseline.json`
- `src/modules/architecture/dom/interaction/curationStore.ts`
- `src/modules/architecture/dom/interaction/entityNavigation.ts`
- `src/modules/architecture/dom/interaction/graphGestureController.ts`
- `src/modules/architecture/dom/interaction/graphSelectionController.ts`
- `src/modules/architecture/dom/interaction/hierarchyIndex.ts`
- `src/modules/architecture/dom/interaction/index.ts`
- `src/modules/architecture/dom/interaction/selectionModel.ts`
- `src/modules/architecture/dom/planning/adaptiveGrouping.ts`
- `src/modules/architecture/dom/planning/explosionLod.ts`
- `src/modules/architecture/dom/planning/index.ts`
- `src/modules/architecture/dom/planning/layoutBudget.ts`
- `src/modules/architecture/dom/planning/layoutOrientation.ts`
- `src/modules/architecture/dom/planning/semanticZoomPackageBounds.ts`
- `src/modules/architecture/dom/planning/semanticZoomPlan.ts`
- `src/modules/architecture/dom/planning/semanticZoomRead.ts`
- `src/modules/architecture/dom/planning/useArchitectureGraph.ts`
- `src/modules/architecture/dom/readout/bottomSlotLayout.ts`
- `src/modules/architecture/dom/readout/detailRanking.ts`
- `src/modules/architecture/dom/readout/elementRelationFilter.ts`
- `src/modules/architecture/dom/readout/hoverHintPlacement.ts`
- `src/modules/architecture/dom/readout/index.ts`
- `src/modules/architecture/dom/readout/readoutNumbers.ts`
- `src/modules/architecture/index.ts`
- `src/modules/architecture/layout/drawing/drawnFit.ts`
- `src/modules/architecture/layout/drawing/graphDom.ts`
- `src/modules/architecture/layout/drawing/graphLayoutPipeline.ts`
- `src/modules/architecture/layout/drawing/graphViewportController.ts`
- `src/modules/architecture/layout/drawing/index.ts`
- `src/modules/architecture/layout/engine/elkAspectEngine.ts`
- `src/modules/architecture/layout/engine/index.ts`
- `src/modules/architecture/layout/engine/readableZoom.ts`
- `src/modules/architecture/layout/engine/semanticZoomLayout.ts`
- `src/modules/architecture/layout/engine/svgViewport.ts`
- `src/modules/architecture/layout/panel/index.ts`
- `src/modules/architecture/layout/panel/panelFilters.ts`
- `src/modules/architecture/layout/panel/panelPersistence.ts`
- `src/modules/architecture/layout/plantuml/archguardToPlantUml.ts`
- `src/modules/architecture/layout/plantuml/index.ts`
- `src/modules/architecture/layout/plantuml/plantUmlText.ts`
- `src/modules/architecture/render/ArchitectureCurationManager.tsx`
- `src/modules/architecture/render/ArchitectureInspector.tsx`
- `src/modules/architecture/render/ArchitectureMinimap.tsx`
- `src/modules/architecture/render/ArchitecturePanel.tsx`
- `src/modules/architecture/render/ArchitectureSelectionTray.tsx`
- `src/modules/architecture/render/ArchitectureTextPanel.tsx`
- `src/modules/architecture/render/PlantUmlGraph.tsx`
- `src/modules/architecture/render/architectureChatBridge.ts`
- `src/modules/architecture/render/architectureCurationController.ts`
- `src/modules/architecture/render/architectureDeepLink.ts`
- `src/modules/architecture/render/architectureFilterController.ts`
- `src/modules/architecture/render/architectureFitExportController.ts`
- `src/modules/architecture/render/architecturePanelCanvas.tsx`
- `src/modules/architecture/render/architecturePanelFilters.tsx`
- `src/modules/architecture/render/architecturePanelGroups.tsx`
- `src/modules/architecture/render/architecturePanelReadout.tsx`
- `src/modules/architecture/render/architecturePanelShared.ts`
- `src/modules/architecture/render/architectureSearchController.ts`
- `src/modules/architecture/render/plantUmlNavigation.ts`
- `src/modules/architecture/render/useArchitecturePanelActions.ts`
- `src/modules/architecture/render/useCanvasDrawingSemantics.ts`
- `src/modules/architecture/render/useCanvasFitZoom.ts`
- `src/modules/architecture/render/useCanvasKeyboardNavigation.ts`
- `src/modules/architecture/render/useCanvasPointerInteractions.ts`
- `src/modules/architecture/render/useCanvasSurfaceBindings.ts`
- `src/modules/architecture/render/usePlantUmlDrawing.ts`
- `src/modules/architecture/tests/adaptiveGrouping.test.ts`
- `src/modules/architecture/tests/archguardToPlantUml.test.ts`
- `src/modules/architecture/tests/architectureCurationController.test.ts`
- `src/modules/architecture/tests/architectureFilterController.test.ts`
- `src/modules/architecture/tests/architectureTab.test.tsx`
- `src/modules/architecture/tests/canvasLayoutContract.test.tsx`
- `src/modules/architecture/tests/curationStore.test.ts`
- `src/modules/architecture/tests/detailRanking.test.ts`
- `src/modules/architecture/tests/elementRelationFilter.test.ts`
- `src/modules/architecture/tests/entityNavigation.test.ts`
- `src/modules/architecture/tests/explosionLod.test.tsx`
- `src/modules/architecture/tests/exportMenu.test.tsx`
- `src/modules/architecture/tests/graphGestureController.test.ts`
- `src/modules/architecture/tests/graphLayoutPipeline.test.ts`
- `src/modules/architecture/tests/graphSelectionController.test.ts`
- `src/modules/architecture/tests/graphViewportController.test.ts`
- `src/modules/architecture/tests/hierarchyIndex.test.ts`
- `src/modules/architecture/tests/layoutAspect.test.tsx`
- `src/modules/architecture/tests/layoutBudget.test.ts`
- `src/modules/architecture/tests/layoutFixtures.ts`
- `src/modules/architecture/tests/minimap.test.tsx`
- `src/modules/architecture/tests/mobileGestures.test.tsx`
- `src/modules/architecture/tests/plantUmlText.test.ts`
- `src/modules/architecture/tests/readableZoom.test.tsx`
- `src/modules/architecture/tests/readoutNumbers.test.ts`
- `src/modules/architecture/tests/selectionModel.test.ts`
- `src/modules/architecture/tests/selectionTray.test.tsx`
- `src/modules/architecture/tests/semanticZoomLayout.test.ts`
- `src/modules/architecture/tests/semanticZoomPlan.test.ts`
- `src/modules/architecture/tests/semanticZoomRead.test.ts`
- `src/modules/architecture/tests/svgViewport.test.tsx`
- `src/modules/architecture/tests/textPanel.test.tsx`
- `tasks/gap-routine-architecture-analysis-god-package-src-architecture-layout-dom.md`
