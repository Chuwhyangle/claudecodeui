---
id: gap-routine-architecture-analysis-server-quay-god-package
title: "architecture-analysis: Fresh archguard 2026-11-09 (scope server
  bcc56acf): modules/quay = 24 files / 43 entities, fanIn 14 / fanOut 200 —
  tooManyFiles (24>=20) plus highFanIn/highF"
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
Fresh archguard 2026-11-09 (scope server bcc56acf): modules/quay = 24 files / 43 entities, fanIn 14 / fanOut 200 — tooManyFiles (24>=20) plus highFanIn/highFanOut; quay.service.ts is 2,992 lines and quay-uri-resolve.ts 782, so the package is a barrel over monolithic fleet/task/service files; reported 2026-11-06 and 2026-11-08 but rate-blocked, never filed as a task.

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1794227898835` · ts `2026-11-09T12:38:18.835Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`createQuayRouter`、`createQuayProcessRunner`、`createQuayFleetExec`、`createQuayDispatchCarrier`
- 涉及文件：
- `server/modules/quay/quay.service.ts:1`
- `server/modules/quay/quay.routes.ts:210`
- `server/modules/quay/quay.module.ts:1`
- `server/modules/quay/quay-uri-resolve.ts:1`
- kind：`god-package`
- verdict：`confirmed`

## Requested action
Split quay.service.ts by concern into quay/{read,mutation,fleet} subpackages behind narrow barrels; AC: archguard package-stats fileCount<=20, zero new directory SCCs in server-import-cycle-budget.test.ts, AC-394/AC-455 directory pins updated by union, quay server tests + tsc --noEmit -p server/tsconfig.json green.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-09T12:38:18.835Z

## AC
- [ ] `.quay/routine-findings.jsonl` 中 finding `server-quay-god-package`（routine `architecture-analysis`，runId `architecture-analysis-1794227898835`）所描述的问题被复核并处置
- [ ] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [ ] 上面的判据实跑通过
- [ ] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `server/modules/quay/quay.service.ts`
- `server/modules/quay/quay.routes.ts`
- `server/modules/quay/quay.module.ts`
- `server/modules/quay/quay-uri-resolve.ts`
- `tasks/gap-routine-architecture-analysis-server-quay-god-package.md`