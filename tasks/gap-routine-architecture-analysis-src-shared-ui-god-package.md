---
id: gap-routine-architecture-analysis-src-shared-ui-god-package
title: "architecture-analysis: Fresh archguard 2026-11-09 (scope src 93e0a992):
  shared/ui = 24 files / 43 entities, fanIn 6 / fanOut 87 — over minFiles 20;
  the package is nominally UI prim"
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
Fresh archguard 2026-11-09 (scope src 93e0a992): shared/ui = 24 files / 43 entities, fanIn 6 / fanOut 87 — over minFiles 20; the package is nominally UI primitives but carries two feature components (ModelLibraryPanel 672 lines, which imports its own sibling barrel at line 15, and ModelEnvEditor 302 lines) consumed from three feature modules via deep paths.

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1794227898835` · ts `2026-11-09T12:38:18.835Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`ModelLibraryPanel`、`ModelEnvEditor`
- 涉及文件：
- `src/shared/ui/ModelLibraryPanel.tsx:121`
- `src/shared/ui/ModelEnvEditor.tsx:96`
- `src/shared/ui/index.ts:1`
- kind：`god-package`
- verdict：`confirmed`

## Requested action
Extract the model-library feature pair into a feature leaf and leave shared/ui as generic primitives exporting only Button/Card/Dialog-class components; AC: archguard package-stats shared/ui fileCount<=20 and no tooManyFiles reason, frontend-import-cycle-budget cycleGroups stay the same four groups, ModelLibraryPanel/ModelEnvEditor consumer tests green.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-09T12:38:18.835Z

## AC
- [ ] `.quay/routine-findings.jsonl` 中 finding `src-shared-ui-god-package`（routine `architecture-analysis`，runId `architecture-analysis-1794227898835`）所描述的问题被复核并处置
- [ ] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [ ] 上面的判据实跑通过
- [ ] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `src/shared/ui/ModelLibraryPanel.tsx`
- `src/shared/ui/ModelEnvEditor.tsx`
- `src/shared/ui/index.ts`
- `tasks/gap-routine-architecture-analysis-src-shared-ui-god-package.md`