---
id: gap-routine-architecture-analysis-cycle-shared-types-type-only-3
title: "architecture-analysis: 3-file SCC closed entirely by `import type` edges
  (claude-events → cli-session → provider-launch → claude-events, plus
  provider-launch → cli-session); a type"
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
3-file SCC closed entirely by `import type` edges (claude-events → cli-session → provider-launch → claude-events, plus provider-launch → cli-session); a type-only cycle in the shared type tree forces every consumer of any one of them to see all three, and no gate reads it.

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1795175197228` · ts `2026-11-20T11:46:37.228Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`ChatRunSource`、`ProviderRuntimeContext`、`CommandLifecycleState`、`HostMode`
- 涉及文件：
- `server/shared/types/claude-events.ts:1`
- `server/shared/types/cli-session.ts:1`
- `server/shared/types/provider-launch.ts:1`
- `server/shared/types/provider-launch.ts:2`
- kind：`cycle`
- verdict：`confirmed`

## Requested action
Extract the primitive types (ChatRunSource / CommandLifecycleState / HostMode) into a leaf `server/shared/types/primitives.ts` that all three import one-way, then pin the package's file graph.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-20T11:46:37.228Z

## AC
- [ ] `.quay/routine-findings.jsonl` 中 finding `cycle-shared-types-type-only-3`（routine `architecture-analysis`，runId `architecture-analysis-1795175197228`）所描述的问题被复核并处置
- [ ] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [ ] 上面的判据实跑通过
- [ ] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `server/shared/types/claude-events.ts`
- `server/shared/types/cli-session.ts`
- `server/shared/types/provider-launch.ts`
- `tasks/gap-routine-architecture-analysis-cycle-shared-types-type-only-3.md`