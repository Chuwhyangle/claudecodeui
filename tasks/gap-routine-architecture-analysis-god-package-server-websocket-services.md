---
id: gap-routine-architecture-analysis-god-package-server-websocket-services
title: "architecture-analysis: archguard_detect_god_packages(scope=server) flags
  modules/websocket/services with tooManyFiles: 24 direct files (threshold 20),
  33 entities, fanOut 205; the "
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
archguard_detect_god_packages(scope=server) flags modules/websocket/services with tooManyFiles: 24 direct files (threshold 20), 33 entities, fanOut 205; the directory is 7,968 LOC across 24 sibling services and several of its files changed again in the last 24h.

载体记录（逐字来源）：`.quay/routine-findings.jsonl` · routine `architecture-analysis` · probe `architecture-analysis` · runId `architecture-analysis-1795261634268` · ts `2026-11-21T11:47:14.268Z`。

该 finding 由例程的机械通道产出，本任务由**同一条通道**依赖 `plugin/scripts/routine-file-gate.ts` 的三道闸
（quality / dedup / rate）机械立案 —— ⛔ 不是由人转抄，也不是由探针自行执行。

- 观测符号：`createWebSocketServer`、`ChatSessionWriter`、`createChatRunRegistry`、`createUiNavigationService`、`createUiClientRegistry`
- 涉及文件：
- `server/modules/websocket/services/websocket-server.service.ts:94`
- `server/modules/websocket/services/chat-session-writer.service.ts:46`
- `server/modules/websocket/services/chat-run-registry.service.ts:298`
- `server/modules/websocket/services/ui-navigation.service.ts:185`
- kind：`god-package`
- verdict：`confirmed`

## Requested action
Split by lifecycle (transport: websocket-server/websocket-auth; dispatch: chat-run-*/chat-control/chat-session-writer; ui: ui-*/shell-*) behind a narrow index and record the new directories in the goal-exit-gate and AC-394 pins; AC: fileCount <= 19, websocket cycle pin unchanged-or-shrunk, websocket tests green.

## Effect Prediction
- metric: concept_recurs_after_merge
- expected: false
- statement: 修复后 `<none>` 不再以同一 subject 复发（同 concept_key 的后续记录数应为 0）
- recorded_at: 2026-11-21T11:47:14.268Z

## AC
- [x] `.quay/routine-findings.jsonl` 中 finding `god-package-server-websocket-services`（routine `architecture-analysis`，runId `architecture-analysis-1795261634268`）所描述的问题被复核并处置
- [x] 处置结论可核：要么修掉，要么写明「已有机制在管、失败在哪一步」，⛔ 不以「已注意到」结案

## DoD
- [x] 上面的判据实跑通过
- [x] ⛔ 探针只立案不执行：本任务若需要跑产出者/修复，由派发链执行，⛔ 不由例程代跑

## 处置记录

复核（2026-11-21，worktree `task/gap-routine-architecture-analysis-god-package-server-websocket-services`，仪器 = 仓库自带的
`@yalehwang/archguard` 0.1.45 CLI，`analyze -s server --lang typescript --work-dir /tmp/ag-wsgod-* --no-cache`，
在干净树上各量一次；同轮 `query --cycles`）：

- 修复前 `modules/websocket/services`：**files=24, entities=33, methods=13**；`query --cycles` → `No dependency cycles detected`。
- 修复：按 lifecycle 拆成三个 KNOWN 子包，共享的 activity/state/broadcast/protocol-error 留在包根（只被 dispatch 反向读取）：
  - `transport/`：`websocket-server.service.ts`、`websocket-auth.service.ts`、`plugin-websocket-proxy.service.ts`（3 files / 4 entities）。
  - `dispatch/`：`chat-run-dispatch.service.ts`、`chat-run-registry.service.ts`、`chat-control.service.ts` + `chat-control.contract.ts`、`chat-session-writer.service.ts`、`chat-websocket.service.ts`、`chat-attachment-filter.service.ts`、`chat-edit-preparation.service.ts`（8 files / 10 entities）。
  - `ui/`：`ui-client-registry.service.ts`、`ui-navigation.service.ts`、`ui-state-request.service.ts`、`shell-websocket.service.ts`（4 files / 6 entities）。
  - 包根保留 `activity-heartbeat`、`activity-protocol(.contract|.service)`、`activity.routes`、`hosts-changed-broadcast`、`session-upsert-broadcast`、`websocket-protocol-error`、`websocket-state`、`websocket-writer`。
- 修复后 `modules/websocket/services`：**files=9, entities=13, methods=5**（≤19 ✓）；三个子包分别 3/8/4 files，均远低于 20。
  顶层 `entities` 从 33 降到 13；fanIn/fanOut 不是本次判据（archguard 的 fan 指标是 Atlas/Go-only，TypeScript scope 下不可读），
  如实记录为 residual，不声称关系维度转绿。
- 目录图是 DAG：barrel(`modules/websocket`) → 三个子包；`dispatch` → 包根（activity/state/protocol-error）与 `ui`；
  `transport` → `dispatch`/`ui`；`ui` → 包根；**没有任何反向边** ⇒ 无新目录 SCC，AC-394 `cycleGroups`（G1/G2/G3 全空）不变。
  全仓目录图读数仍是 `sccs=[]`（`server-import-cycle-budget.test.ts` case (b)/(g) 绿）。
- 图钉：新增目录同批登记进**两处**目录 pin —— `server-import-cycle-budget.test.ts` 的 `MANIFEST_PIN` +
  `server-import-cycle-budget.baseline.json`（`directoryManifest` 103→106、`nodeCount` 103→106），以及
  `cloudpit-goal-exit-gate.test.ts` 的 `GATE_DIRECTORY_PIN` + `cloudpit-goal-exit-gate.baseline.json`。
- per-path 棘轮：`architecture-ratchet.baseline.json` 把 3 条 oversizeFiles 与 3 条 moduleMutableState 读数 re-key 到新路径；
  `chat-websocket.service.ts` 2005→1517 是**下调**（sibling cycle 任务早已缩小该文件），没有任何读数被抬升。
- 深引用同步：`modules/websocket/index.ts` 的 re-export 面、23 个 websocket 测试的深 import、
  `chat-control-wiring.test.ts` 的 URL 路径、`resident-run-is-turn-single-reader.test.ts` 的 REGISTRY_REL/DISPATCH_REL、
  `voice-lexicon.test.ts` 的唯一调用点路径表，全部改指新路径。

实跑验证（2026-11-21，本 worktree）：

- `npx tsc --noEmit -p server/tsconfig.json` → exit 0。
- `server/shared/tests/server-import-cycle-budget.test.ts` + `cloudpit-goal-exit-gate.test.ts` → 17 pass / 0 fail；
  case (k) 打印 `[file-scc] websocket files=25 intraPackageEdges=56 sccs=[]`（cycle pin 由空到空，未增）。
- `architecture-ratchet.test.ts` + `resident-run-is-turn-single-reader.test.ts` + `voice-lexicon.test.ts` +
  `providers-websocket-cycle.test.ts` + `server-composition-startup.test.ts` → 20 pass / 0 fail。
- `server/modules/websocket/tests/*.test.ts` → **153 pass / 0 fail**。

第二轮（exited-not-landed 后补，2026-11-21）：

- 上一轮 suite 红 3 条，逐条复核：
  - `server/modules/mcp-gateway/tests/mcp-gateway-wiring.test.ts` case (b) 与
    `server/modules/mcp-gateway/tests/mcp-english-only.test.ts` case (d) 是**真红** —— 两个兄弟探针文件里硬编码的旧路径
    `.../websocket/services/chat-run-registry.service.ts` 与 `.../websocket/services/chat-control.service.ts` 在 split 后
    `ENOENT`（import 图一跳之外，机械 delta-relatedness 看不到，正是「split 必须扫硬编码探针路径表」那条教训）。
    两处各补 `dispatch/` 段后：`mcp-gateway-wiring.test.ts` 3 pass / 0 fail，`mcp-english-only.test.ts` 10 pass / 0 fail。
  - `server/modules/providers/tests/provider-models.service.test.ts`（`[codex-models] model/list discovery`）在**干净 develop
    检出**上逐字复现同一断言差异（打包 Codex CLI 的账户目录缺 `gpt-6.2-astra`/`gpt-6.2-sol`）⇒ 既存环境红，与本任务无关，
    本轮不改动它。
- `server/shared/tests/server-import-cycle-budget.test.ts` 的 `SERVER_FILE_SCC_BASELINE` 里仍留有一组旧 websocket 双文件路径；
  在干净 develop 上 `(j)` 读数同为 `sccs=[15,8,3,2,2]`（该组本就已失效），属既存 stale baseline，containment 口径仍绿，不在本任务范围内改动。

ADR-007 暗轴记录：

L_G file-graph: sccs=0 files=25
L_D directory-graph: cycles=0

（L_G 来自仓库扫描器 `scanFileImportGraph` 的包内读数；L_D 来自 `archguard query --cycles` 与
`scanImportGraph` 的全仓 `sccs=[]`。）

## Touches
- `server/modules/mcp-gateway/tests/mcp-english-only.test.ts`
- `server/modules/mcp-gateway/tests/mcp-gateway-wiring.test.ts`
- `server/modules/websocket/index.ts`
- `server/modules/websocket/services/dispatch/chat-attachment-filter.service.ts`
- `server/modules/websocket/services/dispatch/chat-control.contract.ts`
- `server/modules/websocket/services/dispatch/chat-control.service.ts`
- `server/modules/websocket/services/dispatch/chat-edit-preparation.service.ts`
- `server/modules/websocket/services/dispatch/chat-run-dispatch.service.ts`
- `server/modules/websocket/services/dispatch/chat-run-registry.service.ts`
- `server/modules/websocket/services/dispatch/chat-session-writer.service.ts`
- `server/modules/websocket/services/dispatch/chat-websocket.service.ts`
- `server/modules/websocket/services/transport/plugin-websocket-proxy.service.ts`
- `server/modules/websocket/services/transport/websocket-auth.service.ts`
- `server/modules/websocket/services/transport/websocket-server.service.ts`
- `server/modules/websocket/services/ui/shell-websocket.service.ts`
- `server/modules/websocket/services/ui/ui-client-registry.service.ts`
- `server/modules/websocket/services/ui/ui-navigation.service.ts`
- `server/modules/websocket/services/ui/ui-state-request.service.ts`
- `server/modules/websocket/tests/activity-deliveries-snapshot.test.ts`
- `server/modules/websocket/tests/chat-attachment-filter.test.ts`
- `server/modules/websocket/tests/chat-background-task.test.ts`
- `server/modules/websocket/tests/chat-control-access.test.ts`
- `server/modules/websocket/tests/chat-control-busy.test.ts`
- `server/modules/websocket/tests/chat-control-ownership.test.ts`
- `server/modules/websocket/tests/chat-control-send.test.ts`
- `server/modules/websocket/tests/chat-control-source.test.ts`
- `server/modules/websocket/tests/chat-control-wiring.test.ts`
- `server/modules/websocket/tests/chat-edit-preparation.test.ts`
- `server/modules/websocket/tests/chat-edit-send.test.ts`
- `server/modules/websocket/tests/chat-permission-mode.test.ts`
- `server/modules/websocket/tests/chat-run-by-id.test.ts`
- `server/modules/websocket/tests/chat-run-registry.test.ts`
- `server/modules/websocket/tests/chat-run-turn-semantics.test.ts`
- `server/modules/websocket/tests/chat-stop-task.test.ts`
- `server/modules/websocket/tests/claude-stop-task-capability.test.ts`
- `server/modules/websocket/tests/processing-single-writer.test.ts`
- `server/modules/websocket/tests/session-edit-continuity.test.ts`
- `server/modules/websocket/tests/shell-resume-launch-spec.test.ts`
- `server/modules/websocket/tests/shell-websocket.service.test.ts`
- `server/modules/websocket/tests/ui-client-registry.test.ts`
- `server/modules/websocket/tests/websocket-heartbeat.service.test.ts`
- `server/modules/voice/tests/voice-lexicon.test.ts`
- `server/shared/tests/architecture-ratchet.baseline.json`
- `server/shared/tests/cloudpit-goal-exit-gate.baseline.json`
- `server/shared/tests/cloudpit-goal-exit-gate.test.ts`
- `server/shared/tests/resident-run-is-turn-single-reader.test.ts`
- `server/shared/tests/server-import-cycle-budget.baseline.json`
- `server/shared/tests/server-import-cycle-budget.test.ts`
- `tasks/gap-routine-architecture-analysis-god-package-server-websocket-services.md`

## Blocker

**2026-11-21T12:17:25.174Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: __PERFILE__ duration_ms=5488 server/modules/mcp-gateway/tests/mcp-gateway-wiring.test.ts passed=false end_ms=1795263245444 [baseline A/B: HARD RED (task-introduced-red) — the task's red set is NOT a subset of the develop baseline red set: added=server/modules/mcp-gateway/tests/mcp-gateway-wiring.test.ts,server/modules/mcp-gateway/tests/mcp-english-only.test.ts,server/modules/mcp-gateway/tests/mcp-gateway-wiring.test.ts,server/modules/mcp-gateway/tests/mcp-english-only.test.ts changed=-]
- run_id：wk-prod-anchor
- session_id：10a6d9fe-f364-4ff5-b5cd-439db97128e4
- 已处置（第二轮）：两处硬编码探针路径补 `dispatch/` 段后均绿；`provider-models.service.test.ts` 在干净 develop 上复现，属既存环境红。
