---
id: gap-routine-architecture-analysis-dup-compare-notices
title: "architecture-analysis: archguard duplicate group 83bd173111f40177: 6
  statements / 89 tokens / 6 savable lines, and the SEVERITY_RANK table is
  duplicated too (server:112 vs client:2"
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
archguard duplicate group 83bd173111f40177: 6 statements / 89 tokens / 6 savable lines, and the SEVERITY_RANK table is duplicated too (server:112 vs client:29), so notice ordering can drift between registry and slot without either side's tests failing (recurrence of dup-compare-notices, reported 2026-11-07, never filed).

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1794746479180` · ts `2026-11-15T12:41:19.180Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`compareNotices`、`SEVERITY_RANK`
- 涉及文件：
- `server/modules/notices/notice-registry.service.ts:132`
- `src/modules/notices/NoticeSlot.tsx:48`
- kind：`duplication`
- verdict：`confirmed`

## Requested action
Extract the notice severity rank table and comparator into one shared module both tsconfigs compile (repo-root shared/), import on both sides, and keep the slot's independence assertion; AC: one declaration of compareNotices and SEVERITY_RANK, duplicate group gone, notice-registry and NoticeSlot tests green.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-15T12:41:19.180Z

## AC
- [ ] `.quay/routine-findings.jsonl` 中 finding `dup-compare-notices`（routine `architecture-analysis`，runId `architecture-analysis-1794746479180`）所描述的问题被复核并处置
- [ ] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [ ] 上面的判据实跑通过
- [ ] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `server/modules/notices/notice-registry.service.ts`
- `src/modules/notices/NoticeSlot.tsx`
- `tasks/gap-routine-architecture-analysis-dup-compare-notices.md`