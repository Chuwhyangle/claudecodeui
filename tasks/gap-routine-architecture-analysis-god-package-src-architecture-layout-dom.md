---
id: gap-routine-architecture-analysis-god-package-src-architecture-layout-dom
title: "architecture-analysis: layout = 12 files / 117 entities (highest entity
  count in src) and dom = 22 files / 84 entities with fanIn 5 — both breach
  minEntities=50, and dom additional"
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

## AC
- [ ] `.quay/routine-findings.jsonl` 中 finding `god-package-src-architecture-layout-dom`（routine `architecture-analysis`，runId `architecture-analysis-1794660054673`）所描述的问题被复核并处置
- [ ] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [ ] 上面的判据实跑通过
- [ ] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `src/modules/architecture/layout/graphDom.ts`
- `src/modules/architecture/layout/svgViewport.ts`
- `src/modules/architecture/dom/layoutBudget.ts`
- `src/modules/architecture/dom/semanticZoomPlan.ts`
- `tasks/gap-routine-architecture-analysis-god-package-src-architecture-layout-dom.md`