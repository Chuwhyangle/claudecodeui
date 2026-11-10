---
id: gap-routine-architecture-analysis-god-package-shared-api-entity-crossing
title: "architecture-analysis: archguard scope src: shared/api is now 10 files /
  51 entities (fanIn 67, fanOut 77, reasons
  highFanIn/highFanOut/tooManyEntities), crossing minEntities=50 fr"
status: done
labels:
  - gap
  - routine-filed
  - architecture-analysis
parent: null
children: []
extra: {}
---
## Finding
archguard scope src: shared/api is now 10 files / 51 entities (fanIn 67, fanOut 77, reasons highFanIn/highFanOut/tooManyEntities), crossing minEntities=50 from the 5 files / 45 entities the 2026-11-05 src/shared split recorded, after 785282fa0 (2026-11-07) carved client/clientCore/clientTail/requests out of the barrel.

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1794314306935` · ts `2026-11-10T12:38:26.935Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`labelsFor`、`isIdentifierShaped`、`VoiceEditLabel`、`VoiceEditOp`、`VoiceSourceSegment`
- 涉及文件：
- `src/shared/api/voiceEditLabels.ts:1`
- `src/shared/api/index.ts:1`
- `src/shared/api/clientTail.ts:6`
- `src/shared/voice/index.ts:1`
- kind：`god-package`
- verdict：`confirmed`

## Requested action
Extract the pure voiceEditLabels.ts (5 entities, zero imports) into src/shared/voice and re-export it from api/index.ts; AC: archguard_detect_god_packages(scope=src) reports shared/api entityCount<50 with no tooManyEntities reason, the src/shared file-level SCC pin stays at 0, and voiceEditLabels/useVoiceInput tests stay green.

## 处置（2026-11-10，worker）
已修：`voiceEditLabels.ts`（零 import 的纯模块）整体移入 `src/shared/voice/labels/voiceEditLabels.ts`；
`src/shared/api/index.ts` 保留同名 re-export，`useVoiceInput` / `clientTail` / 测试改读叶子路径。

落点多一层 `labels/` 是被机械棘轮逼出来的，不是随手换目录：`shared/api` 里任一文件直接 import `shared/voice`
节点都会闭合 `api → voice → settings → api` 的目录级 SCC（`voiceDebug`/`voiceShortcuts` 读 settings，
`userSettings` 读 api barrel），而 `server/shared/tests/frontend-import-cycle-budget.test.ts` 的目录棘轮
只许收缩、不许新增组。零 import 的叶子子包让真实文件图保持无环，目录棘轮与文件级 SCC 钉子同时为 0。

实测（archguard 新建 work-dir 对同一 1436-entity src 树；前=develop a33ee1de7，后=任务分支）：
- `shared/api`：files 10→9，entities 51→49，reasons `highFanIn/highFanOut/tooManyEntities` → `highFanIn/highFanOut`（`tooManyEntities` 消失）
- `archguard_detect_god_packages(scope=src)`：`shared/api` entityCount=49（<50），不再带 `tooManyEntities`
- `src/shared` file-level SCC：0；`frontend-import-cycle-budget.test.ts` 9/9 绿（目录/模块/文件三层钉子均未动）
- `voiceEditLabels.test.ts` 23/23、`voiceEditLabelsHook.test.tsx` 5/5、voice 路径测试 19/19 绿
- `tsc --noEmit`：frontend / server / scripts 三份全绿；`architecture-ratchet.test.ts` 6/6 绿

- L_G archguard: sharedFileSccs=0, directoryCycleGroups=4, sharedApiEntityCount=49, sharedApiTooManyEntities=false

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-10T12:38:26.935Z

## AC
- [x] `.quay/routine-findings.jsonl` 中 finding `god-package-shared-api-entity-crossing`（routine `architecture-analysis`，runId `architecture-analysis-1794314306935`）所描述的问题被复核并处置
- [x] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [x] 上面的判据实跑通过
- [x] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `src/shared/api/voiceEditLabels.ts`
- `src/shared/voice/labels/voiceEditLabels.ts`
- `src/shared/api/index.ts`
- `src/shared/api/clientTail.ts`
- `src/shared/voice/index.ts`
- `src/shared/tests/voiceEditLabels.test.ts`
- `src/modules/chat-voice/hooks/useVoiceInput.ts`
- `scripts/voice-phase0-report.mjs`
- `server/shared/types/voice.ts`
- `tasks/gap-routine-architecture-analysis-god-package-shared-api-entity-crossing.md`