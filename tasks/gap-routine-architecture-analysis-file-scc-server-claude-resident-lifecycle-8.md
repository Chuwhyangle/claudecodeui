---
id: gap-routine-architecture-analysis-file-scc-server-claude-resident-lifecycle-8
title: "architecture-analysis: 8 of the 18 files in
  modules/providers/list/claude/lifecycle sit in one SCC (registry:49 imports
  handlers, handlers:56 imports registry; resident-host.types."
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
8 of the 18 files in modules/providers/list/claude/lifecycle sit in one SCC (registry:49 imports handlers, handlers:56 imports registry; resident-host.types.ts / resident-ledger-runtime.ts / resident-settings.ts / resident-turn.types.ts close the rest); invisible to the directory ratchet and to the only file-level pin, which covers modules/mcp-gateway alone.

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1794995539540` · ts `2026-11-18T09:52:19.540Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`ClaudeResidentOutcomeRegistry`、`CLAUDE_RESIDENT_OUTCOME_HANDLERS`、`createDefaultClaudeResidentOutcomeRegistry`
- 涉及文件：
- `server/modules/providers/list/claude/lifecycle/claude-resident-outcome-handlers.ts:56`
- `server/modules/providers/list/claude/lifecycle/claude-resident-outcome-registry.ts:49`
- `server/modules/providers/list/claude/lifecycle/resident-host.types.ts:1`
- kind：`cycle`
- verdict：`confirmed`

## Requested action
Split the handler TABLE (data) from the registry (behaviour) into a leaf module so registry → handlers is the only direction, then pin the package's file graph.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-18T09:52:19.540Z

## AC
- [ ] `.quay/routine-findings.jsonl` 中 finding `file-scc-server-claude-resident-lifecycle-8`（routine `architecture-analysis`，runId `architecture-analysis-1794995539540`）所描述的问题被复核并处置
- [ ] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [ ] 上面的判据实跑通过
- [ ] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `server/modules/providers/list/claude/lifecycle/claude-resident-outcome-handlers.ts`
- `server/modules/providers/list/claude/lifecycle/claude-resident-outcome-registry.ts`
- `server/modules/providers/list/claude/lifecycle/resident-host.types.ts`
- `tasks/gap-routine-architecture-analysis-file-scc-server-claude-resident-lifecycle-8.md`