---
id: gap-routine-architecture-analysis-file-scc-src-architecture-render-9
title: "architecture-analysis: 9 files of src/modules/architecture/render form a
  file-level SCC (ArchitecturePanel.tsx:48 → architecturePanelShell.tsx:24 →
  ArchitecturePanel.tsx); the fron"
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
9 files of src/modules/architecture/render form a file-level SCC (ArchitecturePanel.tsx:48 → architecturePanelShell.tsx:24 → ArchitecturePanel.tsx); the frontend's file-level pin (frontend-import-cycle-budget.test.ts:380-396) scans src/shared only, so no gate reads it — 753 src files / 2329 resolved file edges, 4 non-trivial file SCCs, 0 of them pinned.

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1794995539540` · ts `2026-11-18T09:52:19.540Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`ArchitecturePanel`、`ArchitecturePanelShell`、`createArchitecturePanelModel`
- 涉及文件：
- `src/modules/architecture/render/ArchitecturePanel.tsx:48`
- `src/modules/architecture/render/architecturePanelShell.tsx:24`
- `src/modules/architecture/render/architecturePanelCanvas.tsx:1`
- kind：`cycle`
- verdict：`confirmed`

## Requested action
Move the panel model type into a leaf `architecturePanelModel.ts` (as src/shared/api did for the voiceConfig barrel) and widen the frontend file-level pin from src/shared to all of src/.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-18T09:52:19.540Z

## AC
- [ ] `.quay/routine-findings.jsonl` 中 finding `file-scc-src-architecture-render-9`（routine `architecture-analysis`，runId `architecture-analysis-1794995539540`）所描述的问题被复核并处置
- [ ] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [ ] 上面的判据实跑通过
- [ ] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `src/modules/architecture/render/ArchitecturePanel.tsx`
- `src/modules/architecture/render/architecturePanelShell.tsx`
- `src/modules/architecture/render/architecturePanelCanvas.tsx`
- `tasks/gap-routine-architecture-analysis-file-scc-src-architecture-render-9.md`