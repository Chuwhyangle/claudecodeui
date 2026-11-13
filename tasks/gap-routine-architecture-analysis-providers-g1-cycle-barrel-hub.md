---
id: gap-routine-architecture-analysis-providers-g1-cycle-barrel-hub
title: "architecture-analysis: Fresh archguard package-cycle reading (scope
  server, bcc56acf) finds exactly one directory SCC: modules/providers <->
  modules/providers/list/claude <-> modul"
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
Fresh archguard package-cycle reading (scope server, bcc56acf) finds exactly one directory SCC: modules/providers <-> modules/providers/list/claude <-> modules/providers/services, 68 edges — but 56 of them leave modules/providers and 43 of those originate in the 373-line barrel index.ts alone (`export { sessionSynchronizerService } from './services/session-synchronizer.service.js'` at :1, `export { readSessionTurn } from './list/claude/claude-runtime.provider.js'` at :171), so the cycle is a barrel re-export hub, not an intrinsic dependency web; AC-394's budget pin (G1, 3 members) forbids growth but never shrinks it, and no open task targets it.

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1794573630786` · ts `2026-11-13T12:40:30.786Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`sessionSynchronizerService`、`providerMcpService`、`providerRegistry`、`deriveHeldWorkLeases`
- 涉及文件：
- `server/modules/providers/index.ts:1`
- `server/modules/providers/index.ts:171`
- `server/modules/providers/services/claude-activity-lease-deriver.service.ts:56`
- `server/modules/providers/services/mcp.service.ts:1`
- kind：`dependency-cycle`
- verdict：`confirmed-pinned`

## Requested action
Route the providers -> services and providers -> list/claude re-exports through the shared/ports families (the method used for the earlier G1 shrink from 11 to 8 members) and drop the value re-exports from index.ts; re-measure G1 and lower CYCLE_GROUPS plus server-import-cycle-budget.baseline.json only if the member set actually shrinks.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-13T12:40:30.786Z

## AC
- [ ] `.quay/routine-findings.jsonl` 中 finding `providers-g1-cycle-barrel-hub`（routine `architecture-analysis`，runId `architecture-analysis-1794573630786`）所描述的问题被复核并处置
- [ ] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [ ] 上面的判据实跑通过
- [ ] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `server/modules/providers/index.ts`
- `server/modules/providers/services/claude-activity-lease-deriver.service.ts`
- `server/modules/providers/services/mcp.service.ts`
- `tasks/gap-routine-architecture-analysis-providers-g1-cycle-barrel-hub.md`