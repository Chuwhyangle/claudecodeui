---
id: gap-routine-architecture-analysis-architecture-panel-plantuml-residual-oversize
title: 'architecture-analysis: The 2026-11-04 architecture split
  (gap-routine-architecture-analysis-god-package-src-architecture, status done)
  carried AC "both panel files <=2000 lines" bu'
status: todo
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
- [ ] `.quay/routine-findings.jsonl` 中 finding `architecture-panel-plantuml-residual-oversize`（routine `architecture-analysis`，runId `architecture-analysis-1794573630786`）所描述的问题被复核并处置
- [ ] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [ ] 上面的判据实跑通过
- [ ] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `src/modules/architecture/render/ArchitecturePanel.tsx`
- `src/modules/architecture/render/PlantUmlGraph.tsx`
- `tasks/gap-routine-architecture-analysis-architecture-panel-plantuml-residual-oversize.md`