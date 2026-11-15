---
id: gap-routine-architecture-analysis-god-package-server-voice-realtime-ea9ee0c7
title: "architecture-analysis: archguard 2026-11-15: 29 direct files / 83
  entities / fanIn 73 / fanOut 305 — breaches all four default thresholds
  (minFiles 20, minEntities 50, minFanIn 5, "
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
archguard 2026-11-15: 29 direct files / 83 entities / fanIn 73 / fanOut 305 — breaches all four default thresholds (minFiles 20, minEntities 50, minFanIn 5, minFanOut 20); the done split lowered 41 files/155 entities to 29/83 but fan-in and fan-out did not fall.

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1794746479180` · ts `2026-11-15T12:41:19.180Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`VoiceRealtimeConnection`
- 涉及文件：
- `server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:397`
- `server/modules/voice-realtime/voice-realtime-connection-frames.ts:1`
- kind：`god-package`
- verdict：`confirmed`

## Requested action
Move the frame/turn dispatch stages that remain in ws-proxy.service.ts behind the existing frames/ and transport/ leaves and expose one connection port; AC: package fileCount <= 20 and entityCount <= 50 with fanOut meaningfully reduced, voice-realtime suite green.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-15T12:41:19.180Z

## AC
- [ ] `.quay/routine-findings.jsonl` 中 finding `god-package-server-voice-realtime`（routine `architecture-analysis`，runId `architecture-analysis-1794746479180`）所描述的问题被复核并处置
- [ ] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [ ] 上面的判据实跑通过
- [ ] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts`
- `server/modules/voice-realtime/voice-realtime-connection-frames.ts`
- `tasks/gap-routine-architecture-analysis-god-package-server-voice-realtime-ea9ee0c7.md`