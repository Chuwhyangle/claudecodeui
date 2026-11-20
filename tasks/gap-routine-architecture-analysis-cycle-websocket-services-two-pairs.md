---
id: gap-routine-architecture-analysis-cycle-websocket-services-two-pairs
title: "architecture-analysis: Two independent 2-file SCCs inside one 20-file
  package: activity-heartbeat.service.ts (239 lines) ⇄
  activity-protocol.service.ts (314), and chat-control.serv"
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
Two independent 2-file SCCs inside one 20-file package: activity-heartbeat.service.ts (239 lines) ⇄ activity-protocol.service.ts (314), and chat-control.service.ts (1149) ⇄ chat-websocket.service.ts (2005) — the two largest files in the package are mutually dependent.

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1795175197228` · ts `2026-11-20T11:46:37.228Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`attachActivityHeartbeat`、`ActivityStore`、`createChatControlService`、`dispatchRun`
- 涉及文件：
- `server/modules/websocket/services/activity-heartbeat.service.ts:9`
- `server/modules/websocket/services/activity-protocol.service.ts:11`
- `server/modules/websocket/services/chat-control.service.ts:11`
- `server/modules/websocket/services/chat-websocket.service.ts:31`
- kind：`cycle`
- verdict：`confirmed`

## Requested action
Extract the frame/port types each side needs into a leaf `activity-protocol.contract.ts` and `chat-control.contract.ts` so the service → transport direction is one-way, then pin the package's file graph.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-20T11:46:37.228Z

## AC
- [ ] `.quay/routine-findings.jsonl` 中 finding `cycle-websocket-services-two-pairs`（routine `architecture-analysis`，runId `architecture-analysis-1795175197228`）所描述的问题被复核并处置
- [ ] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [ ] 上面的判据实跑通过
- [ ] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `server/modules/websocket/services/activity-heartbeat.service.ts`
- `server/modules/websocket/services/activity-protocol.service.ts`
- `server/modules/websocket/services/chat-control.service.ts`
- `server/modules/websocket/services/chat-websocket.service.ts`
- `tasks/gap-routine-architecture-analysis-cycle-websocket-services-two-pairs.md`