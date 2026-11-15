---
id: gap-routine-architecture-analysis-dup-compare-notices
title: "architecture-analysis: archguard duplicate group 83bd173111f40177: 6
  statements / 89 tokens / 6 savable lines, and the SEVERITY_RANK table is
  duplicated too (server:112 vs client:2"
status: done
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
- [x] `.quay/routine-findings.jsonl` 中 finding `dup-compare-notices`（routine `architecture-analysis`，runId `architecture-analysis-1794746479180`）所描述的问题被复核并处置
- [x] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [x] 上面的判据实跑通过
- [x] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## 验证记录
- 复核：用与例程同一产者（archguard 0.1.45 `detectDuplicates`，sources=server,src,shared）在 develop 与 worktree 各跑一次。develop 读出 totalGroups=2，其中 83bd173111f40177 = `server/modules/notices/notice-registry.service.ts:132-137` + `src/modules/notices/NoticeSlot.tsx:48-53`（6 statements / 89 tokens / 6 savable lines），与 finding 逐字段吻合。
- 处置：`SEVERITY_RANK` 与 `compareNotices` 移到 `shared/noticeOrder.ts`（repo-root shared，两个 tsconfig 都编译；ADR-004 decision 2），registry 与 slot 改为 `@shared/noticeOrder(.js)`；slot 仍自行 `.sort(compareNotices)`，独立性判据保留。
- 修复后同一探测：totalGroups_before=2, totalGroups_after=1, fixedGroup=83bd173111f40177（不再出现）, controlGroup=816ec1a3b49021eb（仍出现，证明探测非空转）。
- 声明计数：`export const SEVERITY_RANK` ×1、`export function compareNotices` ×1，均在 `shared/noticeOrder.ts`。
- L_D archguard duplicates: totalGroups_before=2, totalGroups_after=1, fixedGroup=83bd173111f40177, controlGroup=816ec1a3b49021eb
- 实跑：server `tsx --test server/modules/notices/tests/notice-registry.test.ts` → 5 pass / 0 fail；client vitest `src/modules/notices/tests` + `src/shared/tests/wireContractTypeSync.test.ts` → 27 pass / 0 fail；棘轮（architecture-ratchet、frontend/server-import-cycle-budget、cloudpit-goal-exit-gate）→ 33 pass / 0 fail；`tsc --noEmit` 两个 tsconfig 通过；oxlint 三个改动文件无告警。
- 独立性：NoticeSlot.test.tsx「renders exactly one entry and folds the remaining count」仍以未排序的 `[older, newer, blocking]` 输入断言 blocking 居首，slot 自己排序。
- Effect Prediction：本轮探测已看不到该 group；concept_recurs_after_merge 由下一轮 architecture-analysis 例行复核（同 subject 后续记录数应为 0）。

## Touches
- `server/modules/notices/notice-registry.service.ts`
- `src/modules/notices/NoticeSlot.tsx`
- `shared/noticeOrder.ts`
- `tasks/gap-routine-architecture-analysis-dup-compare-notices.md`