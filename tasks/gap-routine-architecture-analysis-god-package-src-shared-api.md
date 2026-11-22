---
id: gap-routine-architecture-analysis-god-package-src-shared-api
title: "architecture-analysis: shared/api is 9 files / 50 entities (fanIn 64,
  fanOut 86) with reasons highFanIn/highFanOut/tooManyEntities: the 2026-11-10
  fix measured 49 entities, and rea"
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
shared/api is 9 files / 50 entities (fanIn 64, fanOut 86) with reasons highFanIn/highFanOut/tooManyEntities: the 2026-11-10 fix measured 49 entities, and readReplySuggestionsFailure added since is the 50th, so the own AC entityCount<50 no longer holds.

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1795348048786` · ts `2026-11-22T11:47:28.786Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`readReplySuggestionsFailure`、`readCategory`、`inferCategory`
- 涉及文件：
- `src/shared/api/requests.ts:357`
- `src/shared/api/clientTail.ts:43`
- `src/shared/replySuggestionsType.ts:1`
- kind：`god-package`
- verdict：`confirmed`

## Requested action
Move readReplySuggestionsFailure plus its private readCategory/inferCategory/FAILURE_CATEGORIES out of the generic request plumbing into a sibling zero-dependency leaf src/shared/replySuggestionsFailure.ts beside replySuggestionsType.ts and import it from clientTail.ts (its only consumer); entityCount falls 50->49 with the pinned src directory cycles and src/shared file-SCC pin untouched.

## 处置（2026-11-22，worker）
已修。新建 `src/shared/replySuggestionsFailure.ts`（只 import type 自同目录 `replySuggestionsType.ts`），
把 `readReplySuggestionsFailure` 与私有的 `readCategory`/`inferCategory`/类别词表搬过去；
`src/shared/api/clientTail.ts`（唯一消费者）改为从该叶子 import，`src/shared/api/requests.ts` 不再声明失败读取器，
它的 `/status` last-failure 读取器复用叶子导出的 `REPLY_SUGGESTIONS_FAILURE_CATEGORIES`（数据常量，无实体），
因此客户端类别词表仍只有一份。

只导出一个函数是刻意的：archguard 按包统计 public function/class，`src/shared` 根包从 48 涨到 49；
若把 `readCategory` 也导出会推到 50，制造一个**新的** `shared` tooManyEntities finding。
落点留在 `src/shared` 根（而不是子包），因为 `shared/api -> shared` 目录边本已存在（`replySuggestionsType.ts`），
目录环与 file-SCC 钉子都不新增组。

实测（同一 archguard CLI，两个全新 work-dir，对同一 src 树；阈值与 `archguard_detect_god_packages` 一致：
minFanIn=5 / minFanOut=20 / minFiles=20 / minEntities=50，用 archguard dist 的 `extractPackageName` /
`computePackageFanMetricsFromRelations` / `evaluateGodPackages` 复算）：

前（develop 5f8c0e648）：
- `shared/api`：files 9, entities 50, fanIn 64, fanOut 86, reasons `highFanIn,highFanOut,tooManyEntities`
- `shared`：files 13, entities 48, fanIn 1334, fanOut 26, reasons `highFanIn,highFanOut`

后（任务分支）：
- `shared/api`：files 9, entities 49, fanIn 64, fanOut 85, reasons `highFanIn,highFanOut`（`tooManyEntities` 消失）
- `shared`：files 14, entities 49, fanIn 1333, fanOut 26, reasons `highFanIn,highFanOut`（未新增 tooManyEntities）
- 全 scope flagged 包数 96 -> 96（只搬实体，不制造新 finding）

其它判据：
- `node --test server/shared/tests/frontend-import-cycle-budget.test.ts`：15/15 绿；`src/shared files=81 edges=139 sccs=[]`（file 与 entity 两层均为 0，目录/模块/文件/实体四层钉子未动）
- `node --test server/shared/tests/architecture-ratchet.test.ts`：6/6 绿（oversize/moduleMutableState 等基线未抬）
- `vitest run src/shared/tests/replySuggestionsApi.test.ts`：14/14；`replySuggestionsController.test.ts` 19/19、`replySuggestionsTypeSync.test.ts` 6/6、`replySuggestionsFailureNotice.test.tsx` 9/9
- `tsc --noEmit`：frontend / server / scripts 三份全绿

- L_G archguard: sharedApiEntityCount=49, sharedApiTooManyEntities=false, sharedApiFanOut=85, srcSharedFileSccs=0, srcSharedEntitySccs=0

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-22T11:47:28.786Z

## Acceptance Criteria
- [x] `.quay/routine-findings.jsonl` 中 finding `god-package-src-shared-api`（routine `architecture-analysis`，runId `architecture-analysis-1795348048786`）所描述的问题被复核并处置
- [x] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## Definition of Done
- [x] 上面的判据实跑通过
- [x] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `src/shared/api/requests.ts`
- `src/shared/api/clientTail.ts`
- `src/shared/replySuggestionsType.ts`
- `src/shared/replySuggestionsFailure.ts`
- `tasks/gap-routine-architecture-analysis-god-package-src-shared-api.md`