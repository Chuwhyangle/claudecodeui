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

## AC
- [ ] `.quay/routine-findings.jsonl` 中 finding `god-package-src-architecture-render`（routine `architecture-analysis`，runId `architecture-analysis-1794660054673`）所描述的问题被复核并处置
- [ ] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [ ] 上面的判据实跑通过
- [ ] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `src/modules/architecture/render/ArchitectureMinimap.tsx`
- `src/modules/architecture/render/ArchitectureInspector.tsx`
- `src/modules/architecture/render/ArchitectureSelectionTray.tsx`
- `src/modules/architecture/render/architectureFilterController.ts`
- `tasks/gap-routine-architecture-analysis-god-package-src-architecture-render.md`