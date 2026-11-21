---
id: gap-routine-architecture-analysis-god-package-server-websocket-services
title: "architecture-analysis: archguard_detect_god_packages(scope=server) flags
  modules/websocket/services with tooManyFiles: 24 direct files (threshold 20),
  33 entities, fanOut 205; the "
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
archguard_detect_god_packages(scope=server) flags modules/websocket/services with tooManyFiles: 24 direct files (threshold 20), 33 entities, fanOut 205; the directory is 7,968 LOC across 24 sibling services and several of its files changed again in the last 24h.

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1795261634268` · ts `2026-11-21T11:47:14.268Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`createWebSocketServer`、`ChatSessionWriter`、`createChatRunRegistry`、`createUiNavigationService`、`createUiClientRegistry`
- 涉及文件：
- `server/modules/websocket/services/websocket-server.service.ts:94`
- `server/modules/websocket/services/chat-session-writer.service.ts:46`
- `server/modules/websocket/services/chat-run-registry.service.ts:298`
- `server/modules/websocket/services/ui-navigation.service.ts:185`
- kind：`god-package`
- verdict：`confirmed`

## Requested action
Split by lifecycle (transport: websocket-server/websocket-auth; dispatch: chat-run-*/chat-control/chat-session-writer; ui: ui-*/shell-*) behind a narrow index and record the new directories in the goal-exit-gate and AC-394 pins; AC: fileCount <= 19, websocket cycle pin unchanged-or-shrunk, websocket tests green.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-21T11:47:14.268Z

## AC
- [ ] `.quay/routine-findings.jsonl` 中 finding `god-package-server-websocket-services`（routine `architecture-analysis`，runId `architecture-analysis-1795261634268`）所描述的问题被复核并处置
- [ ] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [ ] 上面的判据实跑通过
- [ ] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `server/modules/websocket/services/websocket-server.service.ts`
- `server/modules/websocket/services/chat-session-writer.service.ts`
- `server/modules/websocket/services/chat-run-registry.service.ts`
- `server/modules/websocket/services/ui-navigation.service.ts`
- `tasks/gap-routine-architecture-analysis-god-package-server-websocket-services.md`