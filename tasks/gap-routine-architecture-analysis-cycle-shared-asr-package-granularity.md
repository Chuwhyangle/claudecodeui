---
id: gap-routine-architecture-analysis-cycle-shared-asr-package-granularity
title: "architecture-analysis: archguard package-granularity reading on the
  fresh 2026-11-10 tree: one non-trivial SCC of size 7 (asr + six asr/list/*
  adapter directories, 13 unique edges)"
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
archguard package-granularity reading on the fresh 2026-11-10 tree: one non-trivial SCC of size 7 (asr + six asr/list/* adapter directories, 13 unique edges) because asrContract.ts/transcriptionWire.ts sit in the same node every adapter imports; the 2026-10-29 file-level split reports value-sccs=0 but no committed ratchet pins this directory reading, and the asr package is also at entityCount=50 (tooManyEntities, minEntities=50; fanIn 103/fanOut 68).

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1794314306935` · ts `2026-11-10T12:38:26.935Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`asrRegistry`、`asrContract`、`transcriptionWire`、`baseMimeType`、`classifyUpstreamFailure`
- 涉及文件：
- `shared/asr/asrRegistry.ts:20`
- `shared/asr/asrRegistry.ts:58`
- `shared/asr/asrContract.ts:1`
- `shared/asr/transcriptionWire.ts:1`
- `shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts:89`
- `shared/asr/list/openai-compatible/openai-compatible.asr-provider.ts:27`
- kind：`cycle`
- verdict：`confirmed`

## Requested action
Move asrContract.ts + transcriptionWire.ts together into a new leaf shared/asr/contract/ (they only share a type-only cycle) and re-export from asrRegistry.ts so consumers keep @shared/asr/asrRegistry; AC: archguard_detect_cycles(scope=shared, outputScope=package) reports 0 cycles (currently 1 SCC of size 7), asr entityCount<50, and node scripts/asr-import-cycle-check.mjs stays value-sccs=0.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-10T12:38:26.935Z

## AC
- [ ] `.quay/routine-findings.jsonl` 中 finding `cycle-shared-asr-package-granularity`（routine `architecture-analysis`，runId `architecture-analysis-1794314306935`）所描述的问题被复核并处置
- [ ] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [ ] 上面的判据实跑通过
- [ ] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `shared/asr/asrRegistry.ts`
- `shared/asr/asrContract.ts`
- `shared/asr/transcriptionWire.ts`
- `shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts`
- `shared/asr/list/openai-compatible/openai-compatible.asr-provider.ts`
- `tasks/gap-routine-architecture-analysis-cycle-shared-asr-package-granularity.md`