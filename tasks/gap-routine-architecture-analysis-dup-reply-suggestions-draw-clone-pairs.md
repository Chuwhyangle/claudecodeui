---
id: gap-routine-architecture-analysis-dup-reply-suggestions-draw-clone-pairs
title: "architecture-analysis: archguard_detect_duplicates (minStatements 6 /
  minTokens 50, tests excluded) reports totalGroups=2 for scope server and both
  sit in this file: logCompletion "
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
archguard_detect_duplicates (minStatements 6 / minTokens 50, tests excluded) reports totalGroups=2 for scope server and both sit in this file: logCompletion vs logRewrite (hash 3ed8be0b, 213 tokens, 18 savable lines, identical body after literal normalization) and describeAttempt vs describeRewriteAttempt (hash b2117fe1, 119 tokens, 11 savable lines, same failure-to-category mapping).

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1795261634268` · ts `2026-11-21T11:47:14.268Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`logCompletion`、`logRewrite`、`describeAttempt`、`describeRewriteAttempt`
- 涉及文件：
- `server/modules/reply-suggestions/reply-suggestions-draw.ts:127`
- `server/modules/reply-suggestions/reply-suggestions-draw.ts:94`
- `server/modules/reply-suggestions/reply-suggestions-draw.ts:372`
- `server/modules/reply-suggestions/reply-suggestions-draw.ts:344`
- kind：`duplication`
- verdict：`confirmed`

## Requested action
Extract one logCompletionOutcome(prefix, ...) and one describeUpstreamFailure(failure) helper and call both from the two runners; AC: archguard_detect_duplicates(scope=server) returns totalGroups 0 and the reply-suggestions draft-rewrite tests stay green.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-21T11:47:14.268Z

## AC
- [ ] `.quay/routine-findings.jsonl` 中 finding `dup-reply-suggestions-draw-clone-pairs`（routine `architecture-analysis`，runId `architecture-analysis-1795261634268`）所描述的问题被复核并处置
- [ ] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [ ] 上面的判据实跑通过
- [ ] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `server/modules/reply-suggestions/reply-suggestions-draw.ts`
- `tasks/gap-routine-architecture-analysis-dup-reply-suggestions-draw-clone-pairs.md`