---
id: gap-routine-architecture-analysis-cycle-voice-asr-factory-singleton
title: "architecture-analysis: Fresh archguard entity SCC (scope src 93e0a992) =
  one 2-node cycle: the standalone factory reaches into the class singleton at
  line 1011 (voiceClientAsrEngin"
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
Fresh archguard entity SCC (scope src 93e0a992) = one 2-node cycle: the standalone factory reaches into the class singleton at line 1011 (voiceClientAsrEngineInstance.noteProgress) while VoiceClientAsrEngine.install() calls the factory at line 1167; the committed file-level ratchet pins src/shared to zero FILE SCCs, so this same-file entity cycle is invisible to it.

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1794660054673` · ts `2026-11-14T12:40:54.673Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`createVoiceClientAsrEngine`、`VoiceClientAsrEngine`、`voiceClientAsrEngineInstance`
- 涉及文件：
- `src/shared/voice-asr/voiceClientAsrWorker.ts:972`
- `src/shared/voice-asr/voiceClientAsrWorker.ts:1011`
- `src/shared/voice-asr/voiceClientAsrWorker.ts:1137`
- `src/shared/voice-asr/voiceClientAsrWorker.ts:1167`
- kind：`cycle`
- verdict：`confirmed`

## Requested action
Delete the direct singleton reach at line 1011 and have install() pass an onProgress sink that calls this.noteProgress, inverting the edge; add an entity-cycle assertion over src/shared so a same-file factory/class cycle cannot return.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-14T12:40:54.673Z

## AC
- [ ] `.quay/routine-findings.jsonl` 中 finding `cycle-voice-asr-factory-singleton`（routine `architecture-analysis`，runId `architecture-analysis-1794660054673`）所描述的问题被复核并处置
- [ ] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [ ] 上面的判据实跑通过
- [ ] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `src/shared/voice-asr/voiceClientAsrWorker.ts`
- `tasks/gap-routine-architecture-analysis-cycle-voice-asr-factory-singleton.md`