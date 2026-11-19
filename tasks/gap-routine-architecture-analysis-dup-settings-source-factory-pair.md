---
id: gap-routine-architecture-analysis-dup-settings-source-factory-pair
title: "architecture-analysis: archguard --duplicates (loose threshold) top
  group: 28-line, 162-token copy-paste factory; bodies are identical except the
  createSettingsBlockSource block st"
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
archguard --duplicates (loose threshold) top group: 28-line, 162-token copy-paste factory; bodies are identical except the createSettingsBlockSource block string ('observation.sessionDigest' vs 'cockpit.counterVoice') and the return type annotation.

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1795081962018` · ts `2026-11-19T09:52:42.018Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`createSessionDigestLlmSettingsSource`、`createCounterVoiceSettingsSource`
- 涉及文件：
- `server/modules/observation/core/session-digest-llm-settings.ts:198`
- `server/modules/quay/counter-voice-settings.ts:192`
- kind：`duplication`
- verdict：`confirmed`

## Requested action
Extract a generic createServerSettingsSource(options) factory parameterised by block name and return type; both modules keep only their type + a one-line wrapper.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-19T09:52:42.018Z

## AC
- [ ] `.quay/routine-findings.jsonl` 中 finding `dup-settings-source-factory-pair`（routine `architecture-analysis`，runId `architecture-analysis-1795081962018`）所描述的问题被复核并处置
- [ ] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [ ] 上面的判据实跑通过
- [ ] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `server/modules/observation/core/session-digest-llm-settings.ts`
- `server/modules/quay/counter-voice-settings.ts`
- `tasks/gap-routine-architecture-analysis-dup-settings-source-factory-pair.md`