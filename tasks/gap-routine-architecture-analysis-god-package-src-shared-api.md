---
id: gap-routine-architecture-analysis-god-package-src-shared-api
title: "architecture-analysis: shared/api is 9 files / 50 entities (fanIn 64,
  fanOut 86) with reasons highFanIn/highFanOut/tooManyEntities: the 2026-11-10
  fix measured 49 entities, and rea"
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
shared/api is 9 files / 50 entities (fanIn 64, fanOut 86) with reasons highFanIn/highFanOut/tooManyEntities: the 2026-11-10 fix measured 49 entities, and readReplySuggestionsFailure added since is the 50th, so the own AC entityCount<50 no longer holds.

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1795348048786` · ts `2026-11-22T11:47:28.786Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`readReplySuggestionsFailure`、`readCategory`、`inferCategory`
- 涉及文件：
- `src/shared/api/requests.ts:357`
- `src/shared/api/clientTail.ts:43`
- `src/shared/replySuggestionsType.ts:1`
- kind：`god-package`
- verdict：`confirmed`

## Requested action
Move readReplySuggestionsFailure plus its private readCategory/inferCategory/FAILURE_CATEGORIES out of the generic request plumbing into a sibling zero-dependency leaf src/shared/replySuggestionsFailure.ts beside replySuggestionsType.ts and import it from clientTail.ts (its only consumer); entityCount falls 50->49 with the pinned src directory cycles and src/shared file-SCC pin untouched.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-22T11:47:28.786Z

## AC
- [ ] `.quay/routine-findings.jsonl` 中 finding `god-package-src-shared-api`（routine `architecture-analysis`，runId `architecture-analysis-1795348048786`）所描述的问题被复核并处置
- [ ] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [ ] 上面的判据实跑通过
- [ ] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `src/shared/api/requests.ts`
- `src/shared/api/clientTail.ts`
- `src/shared/replySuggestionsType.ts`
- `tasks/gap-routine-architecture-analysis-god-package-src-shared-api.md`