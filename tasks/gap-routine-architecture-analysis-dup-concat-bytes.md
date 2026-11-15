---
id: gap-routine-architecture-analysis-dup-concat-bytes
title: "architecture-analysis: archguard duplicate group 816ec1a3b49021eb: 8
  statements / 85 tokens / 8 savable lines — one Uint8Array merge helper
  implemented on both server and client, s"
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
archguard duplicate group 816ec1a3b49021eb: 8 statements / 85 tokens / 8 savable lines — one Uint8Array merge helper implemented on both server and client, still byte-identical at HEAD develop 56d1bfe9b (recurrence of finding dup-concat-bytes, reported 2026-11-07 and never filed by the rate gate).

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1794746479180` · ts `2026-11-15T12:41:19.180Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`concatBytes`、`concatNarratorBytes`
- 涉及文件：
- `server/modules/voice-realtime/voice-realtime-tts.ts:614`
- `src/modules/chat-voice/voice-realtime/narratorWav.ts:87`
- kind：`duplication`
- verdict：`confirmed`

## Requested action
Move the single implementation into the repo-root shared byte module (shared/asr/transcriptionWire.ts already owns byte arithmetic) and import from voice-realtime-tts.ts and narratorWav.ts; AC: one declaration of the helper, archguard_detect_duplicates no longer reports group 816ec1a3b49021eb, and the voice-realtime TTS and narrator-WAV tests stay green.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-15T12:41:19.180Z

## AC
- [ ] `.quay/routine-findings.jsonl` 中 finding `dup-concat-bytes`（routine `architecture-analysis`，runId `architecture-analysis-1794746479180`）所描述的问题被复核并处置
- [ ] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [ ] 上面的判据实跑通过
- [ ] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `server/modules/voice-realtime/voice-realtime-tts.ts`
- `src/modules/chat-voice/voice-realtime/narratorWav.ts`
- `tasks/gap-routine-architecture-analysis-dup-concat-bytes.md`