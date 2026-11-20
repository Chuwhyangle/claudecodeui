---
id: gap-routine-architecture-analysis-cycle-websocket-services-two-pairs
title: "architecture-analysis: Two independent 2-file SCCs inside one 20-file
  package: activity-heartbeat.service.ts (239 lines) ⇄
  activity-protocol.service.ts (314), and chat-control.serv"
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
Two independent 2-file SCCs inside one 20-file package: activity-heartbeat.service.ts (239 lines) ⇄ activity-protocol.service.ts (314), and chat-control.service.ts (1149) ⇄ chat-websocket.service.ts (2005) — the two largest files in the package are mutually dependent.

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1795175197228` · ts `2026-11-20T11:46:37.228Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`attachActivityHeartbeat`、`ActivityStore`、`createChatControlService`、`dispatchRun`
- 涉及文件：
- `server/modules/websocket/services/activity-heartbeat.service.ts:9`
- `server/modules/websocket/services/activity-protocol.service.ts:11`
- `server/modules/websocket/services/chat-control.service.ts:11`
- `server/modules/websocket/services/chat-websocket.service.ts:31`
- kind：`cycle`
- verdict：`confirmed`

## Requested action
Extract the frame/port types each side needs into a leaf `activity-protocol.contract.ts` and `chat-control.contract.ts` so the service → transport direction is one-way, then pin the package's file graph.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-20T11:46:37.228Z

## AC
- [x] `.quay/routine-findings.jsonl` 中 finding `cycle-websocket-services-two-pairs`（routine `architecture-analysis`，runId `architecture-analysis-1795175197228`）所描述的问题被复核并处置
- [x] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [x] 上面的判据实跑通过
- [x] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## 处置记录

复核（2026-11-20，worktree `task/gap-routine-architecture-analysis-cycle-websocket-services-two-pairs`，使用仓库自带扫描器 `server/shared/import-graph.ts::scanFileImportGraph`，扫描集 `modules/websocket/`）：

- 修复前：`nonTrivialSccs=[["…/activity-heartbeat.service.ts","…/activity-protocol.service.ts"],["…/chat-control.service.ts","…/chat-websocket.service.ts"]]`；files=20 intraPackageEdges=45。
- 闭合边（逐边实测，不只信 finding 的点名）：heartbeat → protocol = `readActivityRevision`（值），protocol → heartbeat = `BOOT_ID`（值）；chat-control → chat-websocket = `assertSessionAccess`、`dispatchRun`（值）+ `ProviderRuntimeGateway`（类型），chat-websocket → chat-control = `createChatControlService`（值）。
- 处置：抽出两个叶契约 —— `activity-protocol.contract.ts`（`BOOT_ID` + 帧词表）与 `chat-control.contract.ts`（`ProviderRuntimeGateway` + `SessionAccessCheck` + `assertSessionAccess`）；并把控制服务需要的两个行为叶搬出 transport：`chat-run-dispatch.service.ts`（`dispatchRun`）与 `chat-attachment-filter.service.ts` / `websocket-protocol-error.ts`。heartbeat 与 transport 通过 re-export 保留原导入面（`BOOT_ID`、`filter*`、`assertSessionAccess`、`dispatchRun`、`ProviderRuntimeGateway`），因此外部 import 路径不变。
- 修复后：`nonTrivialSccs=[]`；files=25 intraPackageEdges=56（包内边增加是新增叶文件带来的合法边）。
- 图钉：`server/shared/tests/server-import-cycle-budget.test.ts` 新增 case `(k) server/modules/websocket has no file-level import cycle` —— 先跑合成双向/单向夹具证明判别力，再断言真实包 `nonTrivialSccs=[]`，并带包内边非真空下限。
- 随代码搬家的兄弟判据：`server/shared/tests/resident-run-is-turn-single-reader.test.ts` 的第三个消费者改指 `chat-run-dispatch.service.ts`；`server/modules/voice/tests/voice-lexicon.test.ts` 的唯一录制调用点改为同一路径（仍恰好一处）。

实跑验证（首轮）：

- `tsc --noEmit -p server/tsconfig.json` → exit 0。
- `server/modules/websocket/tests/*.test.ts` → 153 pass / 0 fail（含 activity-protocol、activity-deliveries-snapshot、activity-heartbeat.process、chat-control-*、chat-attachment-filter）。
- `server-import-cycle-budget.test.ts` + `resident-run-is-turn-single-reader.test.ts` + `activity-protocol.test.ts` + `chat-control-wiring.test.ts` → 25 pass / 0 fail；case (k) 打印 `websocket files=25 intraPackageEdges=56 sccs=[]`。
- `mcp-gateway-wiring` / `production-wiring` / `claude-resident-control-queue` / `scheduled-messages` → 24 pass / 0 fail（覆盖控制服务的真实 dispatch 路径）。
- `voice-lexicon` + `mcp-english-only` + `resident-legacy-path-ratchet` + `architecture-ratchet` → 通过（architecture-ratchet 五维全绿；新文件均 <800 行，无模块级可变状态）。

续做复核（2026-11-20，合入 develop 后）：

- 上一轮 suite 的唯一非基线红 `src/modules/architecture/tests/architectureTab.test.tsx: the analysis time is a relative reading` **不是本任务的 delta**：该文件的固定夹具 `GENERATED_AT='2026-10-20…'` 在 2026-11-20 跨过格式化器的 30 天月界，相对读数变成 `last month`，属 develop 全域时间炸弹；develop 已在 `2ae15aa53`（20:31 +0800，晚于上一轮 suite）改为滚动夹具（`now - 2d`）。本轮 merge develop 后已带进来。
- 合入后单跑：`architectureTab.test.tsx` → 129 pass / 0 fail。
- 合入后复验本任务判据：`tsc --noEmit -p server/tsconfig.json` → exit 0；`server-import-cycle-budget.test.ts` + `resident-run-is-turn-single-reader.test.ts` + `voice-lexicon.test.ts` → 26 pass / 0 fail，case (k) 仍打印 `[file-scc] websocket files=25 intraPackageEdges=56 sccs=[]`；`server/modules/websocket/tests/*.test.ts` → 153 pass / 0 fail。
- 同轮另一条红 `server/modules/providers/tests/provider-models.service.test.ts`（打包 CLI 账户模型目录 8 vs 预置 10）为 develop 既有红（`.quay/develop-red-set.json` 已列），不在本任务 delta 内。

ADR-007 暗轴记录：

- L_G file-graph: nonTrivialSccs=0
- L_D directory-graph: sccs=0

（读数来自仓库扫描器 `scanFileImportGraph` / `scanImportGraph`；本仓 archguard 探针在 claudecodeui 上 `analyze exited 1`，不作为读数。）

## Touches
- `server/modules/websocket/services/activity-heartbeat.service.ts`
- `server/modules/websocket/services/activity-protocol.service.ts`
- `server/modules/websocket/services/activity-protocol.contract.ts`
- `server/modules/websocket/services/chat-control.service.ts`
- `server/modules/websocket/services/chat-control.contract.ts`
- `server/modules/websocket/services/chat-websocket.service.ts`
- `server/modules/websocket/services/chat-run-dispatch.service.ts`
- `server/modules/websocket/services/chat-attachment-filter.service.ts`
- `server/modules/websocket/services/websocket-protocol-error.ts`
- `server/shared/tests/server-import-cycle-budget.test.ts`
- `server/shared/tests/resident-run-is-turn-single-reader.test.ts`
- `server/modules/voice/tests/voice-lexicon.test.ts`
- `tasks/gap-routine-architecture-analysis-cycle-websocket-services-two-pairs.md`
