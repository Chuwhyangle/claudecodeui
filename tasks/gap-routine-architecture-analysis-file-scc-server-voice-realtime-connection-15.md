---
id: gap-routine-architecture-analysis-file-scc-server-voice-realtime-connection-15
title: "architecture-analysis: All 15 files of
  server/modules/voice-realtime/connection form ONE file-level SCC (shortest
  cycle: connection-frames.ts:33 → ws-proxy.service.ts:385 → connect"
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
All 15 files of server/modules/voice-realtime/connection form ONE file-level SCC (shortest cycle: connection-frames.ts:33 → ws-proxy.service.ts:385 → connection-frames.ts) because frames.ts type-imports VoiceRealtimeConnection back from ws-proxy; the AC-394 directory ratchet reads 0 cycles here (single directory), and the 2026-11-15 split registered the package with the note 'edges run one-way, sccs=[]' — a directory-level claim the file-level reading contradicts.

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1794995539540` · ts `2026-11-18T09:52:19.540Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`createDefaultVoiceRealtimeFrameRegistry`、`VoiceRealtimeConnection`、`installHostQueue`、`createVoiceRealtimeExecStatus`
- 涉及文件：
- `server/modules/voice-realtime/connection/voice-realtime-connection-frames.ts:33`
- `server/modules/voice-realtime/connection/voice-realtime-ws-proxy.service.ts:385`
- `server/modules/voice-realtime/connection/voice-realtime-frame-handlers.ts:134`
- kind：`cycle`
- verdict：`confirmed`

## Requested action
Extract a leaf contract module for the VoiceRealtimeConnection shape that frames.ts can import (breaking frames ⇄ ws-proxy), then re-measure the package with scanFileImportGraph and pin it.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-18T09:52:19.540Z

## AC
- [ ] `.quay/routine-findings.jsonl` 中 finding `file-scc-server-voice-realtime-connection-15`（routine `architecture-analysis`，runId `architecture-analysis-1794995539540`）所描述的问题被复核并处置
- [ ] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [ ] 上面的判据实跑通过
- [ ] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `server/modules/voice-realtime/connection/voice-realtime-connection-frames.ts`
- `server/modules/voice-realtime/connection/voice-realtime-ws-proxy.service.ts`
- `server/modules/voice-realtime/connection/voice-realtime-frame-handlers.ts`
- `tasks/gap-routine-architecture-analysis-file-scc-server-voice-realtime-connection-15.md`