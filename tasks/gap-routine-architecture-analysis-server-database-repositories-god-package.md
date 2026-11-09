---
id: gap-routine-architecture-analysis-server-database-repositories-god-package
title: "architecture-analysis: Fresh archguard 2026-11-09 (scope server
  bcc56acf): modules/database/repositories = 27 files / 2 entities, fanIn 4 /
  fanOut 35 — 27 flat repository files wit"
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
Fresh archguard 2026-11-09 (scope server bcc56acf): modules/database/repositories = 27 files / 2 entities, fanIn 4 / fanOut 35 — 27 flat repository files with no sub-package, flagged tooManyFiles (27>=20); sessions.db.ts alone is 1,433 lines; reported 2026-11-08 but rate-blocked, no task exists.

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1794227898835` · ts `2026-11-09T12:38:18.835Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`sessionsDb`、`accessTokensDb`、`projectsDb`、`oauthCodeRedemptionsDb`、`observationDb`
- 涉及文件：
- `server/modules/database/repositories/sessions.db.ts:413`
- `server/modules/database/repositories/session-binding.db.ts:1`
- `server/modules/database/repositories/observation.repository.ts:173`
- `server/modules/database/repositories/access-tokens.ts:60`
- kind：`god-package`
- verdict：`confirmed`

## Requested action
Group the 27 repositories into domain subpackages (sessions/, auth/, notifications/, observation/, providers/) behind the existing modules/database barrel; AC: no package in the directory exceeds fileCount 20, server-import-cycle-budget directory manifest and AC-455 GATE_DIRECTORY_PIN updated by union (no missing entry), database + dependent module tests green.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-09T12:38:18.835Z

## AC
- [ ] `.quay/routine-findings.jsonl` 中 finding `server-database-repositories-god-package`（routine `architecture-analysis`，runId `architecture-analysis-1794227898835`）所描述的问题被复核并处置
- [ ] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [ ] 上面的判据实跑通过
- [ ] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `server/modules/database/repositories/sessions.db.ts`
- `server/modules/database/repositories/session-binding.db.ts`
- `server/modules/database/repositories/observation.repository.ts`
- `server/modules/database/repositories/access-tokens.ts`
- `tasks/gap-routine-architecture-analysis-server-database-repositories-god-package.md`