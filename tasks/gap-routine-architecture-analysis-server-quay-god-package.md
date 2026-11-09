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

## 处置（worker 实跑，已修复）

结论：**已修复**。`server/modules/quay` 由 24 files / 43 entities 拆成五个按关注点划分的子包，根包只剩 10 files / 12 entities；2,992 行的 `quay.service.ts` 被拆成读者文件与三个有状态工厂：

- `cli/` — quay-fleet 二进制定位与 runner（叶子，只依赖 node 内建与 `server/shared/**`）
- `fleet/` — project-id join、registry、initiatives、liveness 读口
- `read/` — command port、只读白名单、gantt 解析、summarizers、carrier readers、loop status、dashboard carrier、blockers、suite/fan-in、entrypoint 与 wall URI 解析
- `service/` — 组合根 + 快照读 / 任务索引 / fleet 汇总三个工厂（所有缓存与信号量都在工厂闭包内，模块级无可变状态）
- `task/` — capability probe、task-log 读者/游标存储、事件刷新

目录边单向：root -> 五个子包，read/fleet/task -> cli，service -> 其余四个；没有子包回指根包，所以目录图仍是 DAG。

实测读数（本树 fresh archguard analyze，server scope，work-dir `/tmp/ag-quay-split`）：

- `modules/quay`：**24 files / 43 entities → 10 files / 12 entities**；子包最大 `read`=12 files，五个子包全部 < 20 阈值（archguard `tooManyFiles` 阈值为 `>=20`）。
- 原有 fanIn/fanOut 随文件搬出而下降；根包不再承载 monolithic service。

验收实跑：

- `tsc --noEmit -p server/tsconfig.json` 绿；`npm run typecheck`（root + server + scripts）绿。
- quay 服务器测试：209 项，208 pass / 0 fail / 1 skip（无安装插件的既有 skip）。
- 跨模块消费者（mcp-gateway `changes`/`overview`、observation project-truth、composition-root-wiring）35 项全绿。
- AC-394（目录 manifest + cycle budget）、AC-455（exit-gate 目录棘轮）、architecture-ratchet 共 21 项全绿；`newSCC=0`，实测 SCC 仍是既有 G1 三成员。
- 5 个新目录按 recorded-change 同时写入 AC-394 的 `MANIFEST_PIN` + baseline JSON 与 AC-455 的 `GATE_DIRECTORY_PIN` + baseline JSON（nodeCount 90 -> 100，含同批 develop 的 database 拆包并集）。
- architecture-ratchet：移除 `quay.service.ts` 的 2,993 行 oversize 条目（下降），并把三个随文件搬家的读数 re-key 到新路径（值不变）。

### ADR-007 暗轴记录
- L_G archguard: cycles=0 entities=1430 relations=7613
- L_G directory-graph: newSCC=0 existingGroups=G1(3)

## AC
- [x] `.quay/routine-findings.jsonl` 中 finding `server-quay-god-package`（routine `architecture-analysis`，runId `architecture-analysis-1794227898835`）所描述的问题被复核并处置
- [x] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [x] 上面的判据实跑通过
- [x] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## Touches
- `server/modules/quay/cli/index.ts`
- `server/modules/quay/cli/quay-fleet-cli.ts`
- `server/modules/quay/cli/quay-fleet-locator.ts`
- `server/modules/quay/fleet/index.ts`
- `server/modules/quay/fleet/quay-fleet-liveness.service.ts`
- `server/modules/quay/fleet/quay-fleet-project-id.ts`
- `server/modules/quay/fleet/quay-fleet-registry.ts`
- `server/modules/quay/fleet/quay-initiatives.ts`
- `server/modules/quay/index.ts`
- `server/modules/quay/quay-dispatch-carrier.ts`
- `server/modules/quay/quay.module.ts`
- `server/modules/quay/quay-process.ts`
- `server/modules/quay/quay.routes.ts`
- `server/modules/quay/quay.service.ts`
- `server/modules/quay/read/index.ts`
- `server/modules/quay/read/quay-blockers-summary.ts`
- `server/modules/quay/read/quay-carrier-readers.ts`
- `server/modules/quay/read/quay-command-port.ts`
- `server/modules/quay/read/quay-dashboard-carrier.ts`
- `server/modules/quay/read/quay-entrypoint-resolver.ts`
- `server/modules/quay/read/quay-loop-status.ts`
- `server/modules/quay/read/quay-read-verbs.ts`
- `server/modules/quay/read/quay-snapshot-summaries.ts`
- `server/modules/quay/read/quay-snapshot-types.ts`
- `server/modules/quay/read/quay-suite-fanin-reader.ts`
- `server/modules/quay/read/quay-uri-resolve.ts`
- `server/modules/quay/service/index.ts`
- `server/modules/quay/service/quay-fleet-summary.service.ts`
- `server/modules/quay/service/quay-service-dependencies.ts`
- `server/modules/quay/service/quay.service.ts`
- `server/modules/quay/service/quay-snapshot-read.service.ts`
- `server/modules/quay/service/quay-task-index.service.ts`
- `server/modules/quay/task/index.ts`
- `server/modules/quay/task/quay-capabilities.ts`
- `server/modules/quay/task/quay-task-events.service.ts`
- `server/modules/quay/task/quay-task-log-cursor-store.ts`
- `server/modules/quay/task/quay-task-log-parse.ts`
- `server/modules/quay/tests/contracts/fleet-cli-contracts.test.ts`
- `server/modules/quay/tests/quay-blockers-summary.test.ts`
- `server/modules/quay/tests/quay-entrypoint-resolver.test.ts`
- `server/modules/quay/tests/quay-fleet-cli.test.ts`
- `server/modules/quay/tests/quay-fleet-locator.test.ts`
- `server/modules/quay/tests/quay-fleet-project-id.test.ts`
- `server/modules/quay/tests/quay-fleet-summary.test.ts`
- `server/modules/quay/tests/quay-initiatives.test.ts`
- `server/modules/quay/tests/quay-live-refresh.test.ts`
- `server/modules/quay/tests/quay-process.test.ts`
- `server/modules/quay/tests/quay.service.test.ts`
- `server/modules/quay/tests/quay-suite-fanin-reader.test.ts`
- `server/modules/quay/tests/quay-uri-resolve.test.ts`
- `server/modules/quay/tests/session-mentions.test.ts`
- `server/shared/tests/architecture-ratchet.baseline.json`
- `server/shared/tests/cloudpit-goal-exit-gate.baseline.json`
- `server/shared/tests/cloudpit-goal-exit-gate.test.ts`
- `server/shared/tests/server-import-cycle-budget.baseline.json`
- `server/shared/tests/server-import-cycle-budget.test.ts`
- `tasks/gap-routine-architecture-analysis-server-quay-god-package.md`
