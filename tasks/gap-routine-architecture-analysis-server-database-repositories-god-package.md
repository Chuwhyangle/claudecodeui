---
id: gap-routine-architecture-analysis-server-database-repositories-god-package
title: "architecture-analysis: Fresh archguard 2026-11-09 (scope server
  bcc56acf): modules/database/repositories = 27 files / 2 entities, fanIn 4 /
  fanOut 35 — 27 flat repository files wit"
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
- [x] `.quay/routine-findings.jsonl` 中 finding `server-database-repositories-god-package`（routine `architecture-analysis`，runId `architecture-analysis-1794227898835`）所描述的问题被复核并处置
- [x] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案 —— 已修掉，读数见 Evidence
- [x] `modules/database/repositories` 下没有任何 package 超过 fileCount 20（拆分后实测最大 9；根目录已无平铺文件）
- [x] `server-import-cycle-budget` 的 directory manifest/MANIFEST_PIN 与 AC-455 `GATE_DIRECTORY_PIN`/baseline 按并集更新，未遗漏任何新目录
- [x] database 模块及其依赖模块测试绿；server typecheck 绿

## DoD
- [x] 上面的判据实跑通过（命令与读数见 Evidence）
- [x] ⛔ 探针只立案不执行：本任务由派发链的 worker 会话执行实现；例程未代跑修复

## Evidence
实现（commit d3e9d0664，task 分支）：27 个平铺 repository 文件按领域移入 5 个子包，`modules/database/index.ts`、`migrations.ts`、`session-binding.service.ts` 及模块内测试改指新路径；三处 repository 内部 import（sessions.db → projects.db / session-binding.db，github-tokens → credentials）均落在同一个子包内。

ArchGuard 0.1.45 实测（`analyze -s server --lang typescript --no-cache`，work-dir `/tmp/archguard-dbrepos-*`）：
- 迁移前（finding 载体读数）：`modules/database/repositories` = 27 files / 2 entities，tooManyFiles 27>=20。
- 迁移后 package fileCount：`repositories/auth`=9、`repositories/sessions`=6、`repositories/notifications`=5、`repositories/providers`=4、`repositories/observation`=3；`repositories` 根已无文件（不再作为 package 出现）。全部 < 20。
- 目录图：`modules/database` barrel → 每个子包；子包只指向 `modules/database/core`、`server/shared/**` 与 node builtins，子包之间与本包根均无回边 ⇒ DAG，无新增 SCC。

结构门与测试（本次真实运行）：
- `server/shared/tests/server-import-cycle-budget.test.ts` 12/12 pass（manifest=95，measured nodes=94，missing 仅 `modules/database/repositories` 这个已消失目录，属 allowed）。
- `server/shared/tests/cloudpit-goal-exit-gate.test.ts` 3/3 pass（pin=95、baselineOutsidePin=[]、duplicatePinEntries=0）。
- `server/shared/tests/architecture-ratchet.test.ts` 6/6 pass（oversize 键已重键为 `server/modules/database/repositories/sessions/sessions.db.ts`=1433，1479→1433 为下降）。
- `server/modules/database/tests/*.test.ts` 11 个文件共 54 pass / 0 fail；`server/modules/voice/tests/voice-dashscope-settings.test.ts` 32/32 pass（其源码路径钉已同步）。
- `npx tsc --noEmit -p server/tsconfig.json` exit 0；`npx oxlint` 变更面 exit 0（仅 voice 测试文件 2 条既有 import-order 警告）。

## ADR-007
- L_G archguard: repositories_files_before=27, repositories_max_subpackage_files=9, repos_root_files=0, new_directory_scc=0

## Touches
- `server/modules/database/index.ts`
- `server/modules/database/migrations.ts`
- `server/modules/database/session-binding.service.ts`
- `server/modules/database/repositories/auth/access-tokens.ts`
- `server/modules/database/repositories/auth/credentials.ts`
- `server/modules/database/repositories/auth/github-tokens.ts`
- `server/modules/database/repositories/auth/oauth-authorization-codes.db.ts`
- `server/modules/database/repositories/auth/oauth-clients.db.ts`
- `server/modules/database/repositories/auth/oauth-code-redemptions.db.ts`
- `server/modules/database/repositories/auth/oauth-grants.db.ts`
- `server/modules/database/repositories/auth/user-preferences.db.ts`
- `server/modules/database/repositories/auth/users.ts`
- `server/modules/database/repositories/notifications/notice-dismissals.ts`
- `server/modules/database/repositories/notifications/notification-channel-endpoints.ts`
- `server/modules/database/repositories/notifications/notification-preferences.ts`
- `server/modules/database/repositories/notifications/push-subscriptions.ts`
- `server/modules/database/repositories/notifications/vapid-keys.ts`
- `server/modules/database/repositories/observation/mcp-audit-log.db.ts`
- `server/modules/database/repositories/observation/observation.repository.ts`
- `server/modules/database/repositories/observation/scan-state.db.ts`
- `server/modules/database/repositories/providers/app-config.ts`
- `server/modules/database/repositories/providers/provider-models.ts`
- `server/modules/database/repositories/providers/voice-settings.db.ts`
- `server/modules/database/repositories/providers/voice-user-identifiers.db.ts`
- `server/modules/database/repositories/sessions/projects.db.ts`
- `server/modules/database/repositories/sessions/scheduled-messages.db.ts`
- `server/modules/database/repositories/sessions/session-binding.db.ts`
- `server/modules/database/repositories/sessions/session-drafts.db.ts`
- `server/modules/database/repositories/sessions/sessions.db.ts`
- `server/modules/database/repositories/sessions/ui-last-opened.db.ts`
- `server/modules/database/tests/launch-profiles-drop-migration.test.ts`
- `server/modules/database/tests/projects.db.integration.test.ts`
- `server/modules/database/tests/sessions-provider-mapping.test.ts`
- `server/modules/database/tests/sessions.db.integration.test.ts`
- `server/modules/database/tests/voice-settings.db.integration.test.ts`
- `server/modules/voice/tests/voice-dashscope-settings.test.ts`
- `server/shared/tests/architecture-ratchet.baseline.json`
- `server/shared/tests/cloudpit-goal-exit-gate.baseline.json`
- `server/shared/tests/cloudpit-goal-exit-gate.test.ts`
- `server/shared/tests/server-import-cycle-budget.baseline.json`
- `server/shared/tests/server-import-cycle-budget.test.ts`
- `tasks/gap-routine-architecture-analysis-server-database-repositories-god-package.md`
