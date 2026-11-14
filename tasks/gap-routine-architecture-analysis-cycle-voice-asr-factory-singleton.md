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

## Disposition（复核与处置）
- 复核（finding 逐条复现）：新增的实体级读法在修复前的树上读出**恰好一个**非平凡 SCC —— `shared/voice-asr/voiceClientAsrWorker.ts#VoiceClientAsrEngine` ↔ `shared/voice-asr/voiceClientAsrWorker.ts#createVoiceClientAsrEngine`（entities=230 / edges=117 / sccs=1），与 finding 的 2-node entity SCC 逐节点一致。红先验：把 develop 版 `voiceClientAsrWorker.ts` 临时放回工作树，`server/shared/tests/frontend-import-cycle-budget.test.ts` 的实体判据红并打印该 SCC；恢复修复版后同一判据绿（sccs=[]，edges=116）。
- 修掉（反转边）：删除 `createVoiceClientAsrEngine` 的 worker `progress` 分支里对 `voiceClientAsrEngineInstance.noteProgress(...)` 的直接伸手；`VoiceClientAsrEngine.install()` 改为向工厂传入 `onProgress: this.mirroring(options.onProgress)`，`observe()` 对晚到的订阅者用同一 helper 重新包裹。工厂不再引用类或单例，依赖改为单向 class → factory；`progress()` 镜像仍随安装路径推进。
- 防回归：`server/shared/tests/frontend-import-cycle-budget.test.ts` 新增第四种粒度（ENTITY）—— 以 `src/shared` 导出的 function / class / 函数型 const 为节点，同文件 `export const x = new C()` 折为类 `C` 的别名（正是让 `voiceClientAsrEngineInstance.*` 成为回到类的边），非平凡 SCC 钉为 0；含非空读数下限（entities≥150、edges≥70）、正控（finding 的工厂/类形状必红）与负控（单向调用不闭环）。
- 行为面 collateral：`src/modules/chat/tests/voiceClientAsrRouting.test.ts` 的「下载中给出进度」用例改为经 `installVoiceClientAsrEngine`（生产装配）安装，并在 `afterEach` dispose 该 per-tab 单例；该用例原先依赖被删除的「工厂直写单例镜像」。
- 实跑：`frontend-import-cycle-budget.test.ts` 12/12 绿；`architecture-ratchet.test.ts` 6/6 绿（`voiceClientAsrWorker.ts` 保持 1533 行，未上调 oversize 基线）；`voiceClientAsrRouting.test.ts` 17/17 绿；`tsc --noEmit -p tsconfig.json`、`tsc --noEmit -p server/tsconfig.json`、`oxlint`（三个改动文件）均通过。

## Architecture axis（ADR-007）
- L_G entity-SCC (src/shared, repo-local syntax-tree reading 2026-11-14): entitySccsBefore=1, entitySccsAfter=0, entityCount=230, entityEdgesBefore=117, entityEdgesAfter=116, fileSccs=0

## AC
- [x] `.quay/routine-findings.jsonl` 中 finding `cycle-voice-asr-factory-singleton`（routine `architecture-analysis`，runId `architecture-analysis-1794660054673`）所描述的问题被复核并处置
- [x] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [x] 上面的判据实跑通过
- [x] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `src/shared/voice-asr/voiceClientAsrWorker.ts`
- `server/shared/tests/frontend-import-cycle-budget.test.ts`
- `src/modules/chat/tests/voiceClientAsrRouting.test.ts`
- `tasks/gap-routine-architecture-analysis-cycle-voice-asr-factory-singleton.md`