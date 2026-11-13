---
id: gap-routine-architecture-analysis-architecture-panel-plantuml-residual-oversize
title: 'architecture-analysis: The 2026-11-04 architecture split
  (gap-routine-architecture-analysis-god-package-src-architecture, status done)
  carried AC "both panel files <=2000 lines" bu'
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
The 2026-11-04 architecture split (gap-routine-architecture-analysis-god-package-src-architecture, status done) carried AC "both panel files <=2000 lines" but delivered 4685 (ArchitecturePanel) and 3569 (PlantUmlGraph); the fresh archguard src scope still ranks them #2 and #1 by out-degree (105 and 159), and architecture-ratchet.baseline.json pins exactly those two values (4685/3569), so the ratchet can only forbid growth and never force the shrink; no open (non-done) task mentions ArchitecturePanel.

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1794573630786` · ts `2026-11-13T12:40:30.786Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`ArchitecturePanel`、`PlantUmlGraph`
- 涉及文件：
- `src/modules/architecture/render/ArchitecturePanel.tsx:1`
- `src/modules/architecture/render/PlantUmlGraph.tsx:1`
- kind：`god-package`
- verdict：`confirmed-unmet-ac`

## Requested action
File a split task on the two panels: move ArchitecturePanel's hook-wiring/JSX blocks and PlantUmlGraph's remaining DOM/navigation blocks into leaf subcomponents; AC = wc -l <=2000 for both, archguard out-degree falls, and the oversize ratchet baseline is lowered in the same commit.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-13T12:40:30.786Z

## AC
- [x] `.quay/routine-findings.jsonl` 中 finding `architecture-panel-plantuml-residual-oversize`（routine `architecture-analysis`，runId `architecture-analysis-1794573630786`）所描述的问题被复核并处置
- [x] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [x] 上面的判据实跑通过
- [x] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Evidence

**处置结论：修掉（不再留 residual）。** 两个文件都降到 requested action 的 ≤2000 行，oversize ratchet 基线在同一分支下调。

- 行数（2026-11-13，merge develop 后的树，`wc -l`）：
  - `src/modules/architecture/render/ArchitecturePanel.tsx` **4685 → 1795**
  - `src/modules/architecture/render/PlantUmlGraph.tsx` **3569 → 1820**
- 拆出的叶子模块全部在 800 行棘轮地板以下（最大 `architecturePanelFilters.tsx` 753、`architecturePanelReadyView.tsx` 729、`architecturePanelReadout.tsx` 681、`architectureRender` 其余更小）：
  - Panel：`architecturePanelShell.tsx`（分支屏 + 组合）、`architecturePanelReadyView.tsx`（ready 渲染树）、`architecturePanelToolbar/Groups/Filters/Readout/Canvas/MobileChrome.tsx`、`architecturePanelShared.ts`（纯 helper）、`useArchitecturePanelActions.ts`（compose/export 动作）
  - Renderer：`usePlantUmlDrawing.ts`、`useCanvasPointerInteractions.ts`、`useCanvasKeyboardNavigation.ts`、`useCanvasFitZoom.ts`、`useCanvasDrawingSemantics.ts`、`useCanvasSurfaceBindings.ts`、`plantUmlControlArm.ts`
- 基线同提交下调：`server/shared/tests/architecture-ratchet.baseline.json` 的 `oversizeFiles` 两条改为实测 **1795 / 1820**（原 4685 / 3569），`note` 里追加本任务的 RECORDED CHANGE 段；复跑 `architecture-ratchet.test.ts` 6 pass / 0 fail，两条不再打印「可下调基线」。
- archguard out-degree（同一 CLI、同一 `src` scope、各自全新的 `--work-dir`，按 sourceLocation.file 聚合 entity relations）：
  - `ArchitecturePanel.tsx` **141 → 3**；`PlantUmlGraph.tsx` **202 → 102**
  - 诚实读数：静态度量里这两个文件的 import 说明符 46→49、28→34（新增叶子模块被 import）。PlantUmlGraph 的下降是 hook 代码真的搬走（调用关系随实体迁出）；ArchitecturePanel 的 entity 出度大幅下降还叠加了「owner wiring 现在是文件内非导出函数，archguard 不再把它的调用记在导出组件实体上」这一归因效应 —— 文件本身仍 import 控制器，这点不掩盖。
- 验证（均在 worktree 内实跑）：
  - `npx vitest run src/modules/architecture/tests`：**44 files / 691 tests pass**（merge develop 前后各一次）
  - `architecture-ratchet.test.ts` 6 pass；`frontend-import-cycle-budget.test.ts` 9 pass（目录/模块级 SCC 无新增）
  - `tsc --noEmit` client 与 server 两套配置均 clean
  - `oxlint`：新增/搬移文件 0 条 `rules-of-hooks` 违规。第一次抽取把 action hook 放在 status 分支之后，被 linter 判 `useArchitecturePanelActions is called conditionally`，随后把 ready 树拆成独立组件 `ArchitecturePanelReadyView`（分支判定留在 shell），hook 恢复无条件调用后才提交。
- 跟随路径的判据同步：`architectureTab.test.tsx`（动态 import 的 ELK 入口改读 `usePlantUmlDrawing.ts`）、`layoutAspect.test.tsx`（单一 `createLayoutEngine(` 构造点）、`exportMenu.test.tsx`（`architectureExportFilename` 的消费者改指 `useArchitecturePanelActions.ts`）、`i18nArchitectureTabCompleteness.test.ts`（把 9 个新模块纳入 `t('architecture.…')` 完整性扫描）。
- UI 验证边界（诚实记录）：纯结构重构，无预期视觉变更；仓库内没有 architecture tab 的 `scripts/ui-scenario.mjs` 场景 JSON，未跑浏览器臂，渲染树由上述 691 个组件测试覆盖。
- 范围外残留（只报告、不修改）：`e2e/architecture-canvas-layout.spec.ts` 的 control arm 路由仍指向 `PlantUmlGraph.tsx` 去找 2026-11-04 已迁到 `plantUmlNavigation.ts` 的 `PLANTUML_MEMBER_DETAIL` 常量；该 spec 不在 fan-in e2e lane（l批只跑 `session-lifecycle-scenario.spec.ts`），且不在本任务 Touches，留待单独处理。
- 该轴仍暗,理由:本任务处置的是文件行数/oversize 拆分（行数与 archguard 出度读数已记在上文），未改动 L_D/L_G 依赖分层轴，故该轴无新读数

## Touches
- `src/modules/architecture/render/ArchitecturePanel.tsx`
- `src/modules/architecture/render/PlantUmlGraph.tsx`
- `src/modules/architecture/render/architecturePanelShell.tsx`
- `src/modules/architecture/render/architecturePanelReadyView.tsx`
- `src/modules/architecture/render/architecturePanelToolbar.tsx`
- `src/modules/architecture/render/architecturePanelGroups.tsx`
- `src/modules/architecture/render/architecturePanelFilters.tsx`
- `src/modules/architecture/render/architecturePanelReadout.tsx`
- `src/modules/architecture/render/architecturePanelCanvas.tsx`
- `src/modules/architecture/render/architecturePanelMobileChrome.tsx`
- `src/modules/architecture/render/architecturePanelShared.ts`
- `src/modules/architecture/render/useArchitecturePanelActions.ts`
- `src/modules/architecture/render/usePlantUmlDrawing.ts`
- `src/modules/architecture/render/useCanvasPointerInteractions.ts`
- `src/modules/architecture/render/useCanvasKeyboardNavigation.ts`
- `src/modules/architecture/render/useCanvasFitZoom.ts`
- `src/modules/architecture/render/useCanvasDrawingSemantics.ts`
- `src/modules/architecture/render/useCanvasSurfaceBindings.ts`
- `src/modules/architecture/render/plantUmlControlArm.ts`
- `server/shared/tests/architecture-ratchet.baseline.json`
- `src/modules/architecture/tests/architectureTab.test.tsx`
- `src/modules/architecture/tests/layoutAspect.test.tsx`
- `src/modules/architecture/tests/exportMenu.test.tsx`
- `src/modules/architecture/tests/i18nArchitectureTabCompleteness.test.ts`
- `tasks/gap-routine-architecture-analysis-architecture-panel-plantuml-residual-oversize.md`
