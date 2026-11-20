---
id: gap-routine-architecture-analysis-file-scc-pin-scope-covers-2-of-14-directories
title: "architecture-analysis: The only file-level pins read two slices — server
  (j) scans modules/mcp-gateway alone and the frontend pin filters
  path.startsWith('shared/') — while the shi"
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
The only file-level pins read two slices — server (j) scans modules/mcp-gateway alone and the frontend pin filters path.startsWith('shared/') — while the shipped scanner measures src=768 files/2372 static edges/3 non-trivial SCCs and server=687/2310/8 non-trivial SCCs, so 11 file SCCs are read by no gate and a new one reds nothing.

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1795175197228` · ts `2026-11-20T11:46:37.228Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`scanFileImportGraph`、`nonTrivialSccs`、`collectTypeScriptSources`
- 涉及文件：
- `server/shared/tests/server-import-cycle-budget.test.ts:987`
- `server/shared/tests/frontend-import-cycle-budget.test.ts:396`
- kind：`coverage`
- verdict：`confirmed`

## Requested action
Widen both file-level pins from their two slices to the whole tree and commit the current 11 SCCs as a shrink-only baseline (ratchet), so no new file cycle can land unread.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-20T11:46:37.228Z

## AC
- [ ] `.quay/routine-findings.jsonl` 中 finding `file-scc-pin-scope-covers-2-of-14-directories`（routine `architecture-analysis`，runId `architecture-analysis-1795175197228`）所描述的问题被复核并处置
- [ ] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [ ] 上面的判据实跑通过
- [ ] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `server/shared/tests/server-import-cycle-budget.test.ts`
- `server/shared/tests/frontend-import-cycle-budget.test.ts`
- `tasks/gap-routine-architecture-analysis-file-scc-pin-scope-covers-2-of-14-directories.md`