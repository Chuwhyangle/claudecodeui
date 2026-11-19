---
id: gap-routine-architecture-analysis-dup-settings-source-factory-pair
title: "architecture-analysis: archguard --duplicates (loose threshold) top
  group: 28-line, 162-token copy-paste factory; bodies are identical except the
  createSettingsBlockSource block st"
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

## Disposition
已修掉。`createServerSettingsSource<T, D>(options)` 落在共享机制文件
`server/shared/settings/settings-file.ts`：它统一做 env/home 默认、`resolveSettingsPath`
（explicit → `envVar` → `defaultServerSettingsPath`）、`dependencies(homeDir)` 一次构建，
再交给 `createSettingsBlockSource`。两个模块只保留自己的 shipped defaults、reading 类型、
`buildReading` 与一个声明式的薄包装（block 串 + reply-suggestions 依赖）。

复现闸门（archguard 0.1.45 `detectDuplicates`，与 finding 同一 loose 阈值
`minStatements=3, minTokens=30`，scope=`server/modules/observation/core` + `server/modules/quay`）：

- before: 1 group — tokens=162 lines=28 stmts=5
  [session-digest-llm-settings.ts:198-225 `createSessionDigestLlmSettingsSource` |
   counter-voice-settings.ts:192-219 `createCounterVoiceSettingsSource`]
- after: 0 groups（同 scope 同阈值；剩余 79-token/10-line 组为 `parseFleetJsonObject`/`readJsonRecord`，与本 finding 无关）

残余：`minStatements=1, minTokens=10`（远严于 finding 的 loose 阈值）仍会把两个薄包装归为一组
（tokens=116 lines=23 stmts=1）——两者本就同为「`return createServerSettingsSource({…})`」一条语句，
差异只剩 block 串与类型，属于任务要求的声明式包装本身，不是被修复的 28 行机制复制。

行为保持的证据（窄测实跑，均绿）：
- `server/modules/quay/tests/counter-voice.test.ts`：6 pass，0 fail
- `server/modules/observation/tests/session-digest-llm.test.ts`：9 pass，0 fail
- `server/modules/observation/tests/session-ask-decision-digest.test.ts`：58 pass，0 fail
- `server/shared/tests/settings-file.test.ts`：15 pass，0 fail
- `npx tsc --noEmit -p server/tsconfig.json`：通过；`oxlint` 三文件：无输出

- L_D phase-declare: docLines=0 codeLines=165 ratio=0 verdict=PASS

## AC
- [x] `.quay/routine-findings.jsonl` 中 finding `dup-settings-source-factory-pair`（routine `architecture-analysis`，runId `architecture-analysis-1795081962018`）所描述的问题被复核并处置
- [x] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [x] 上面的判据实跑通过
- [x] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `server/modules/observation/core/session-digest-llm-settings.ts`
- `server/modules/quay/counter-voice-settings.ts`
- `server/shared/settings/settings-file.ts`
- `tasks/gap-routine-architecture-analysis-dup-settings-source-factory-pair.md`
