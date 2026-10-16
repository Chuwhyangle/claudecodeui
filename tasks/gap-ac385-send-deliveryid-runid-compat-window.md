---
id: gap-ac385-send-deliveryid-runid-compat-window
title: AC-385 S3 API 翻转：session_send / session_create（带首条消息）/ session_draft
  发送每次被接受的发送必给 deliveryId（= 随后 lifecycle 帧的 commandUuid，排队时 queuedMessageUuid
  同值），per-run 的 runId 非空且等于 getRun 的 runId，resident 忙时的 runId 在兼容窗口内回填
  deliveryId、窗口（带日期常量）过期后为 null 直到绑定后经 run_get 读到，被拒绝的发送不产生
  delivery，correlationId 归 delivery 且可按它检索；交付
  server/modules/mcp-gateway/tests/mcp-session-send-delivery.test.ts（六条腿 + 取假形态）
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac382-run-is-turn-resident-init-minted-run
  - gap-ac383-delivery-activity-snapshot-channel
  - gap-ac384-processing-single-writer
goal_ac: AC-385
---
## Proposal

<!-- dedup-ref --> 机制去重读数（立案时实测，2026-10-16）：`grep -rl '^goal_ac: *AC-385' tasks/*.md` → **0** 命中；全库 `grep -rln 'AC-385' tasks/` → **0** 命中 ⇒ 无任何状态（含 todo / ready / needs-human）的任务认领 AC-385。机制词 grep：`mcp-session-send-delivery` 只命中 `docs/proposals/resident-delivery-turn-ledger-SPEC.md:454`（§15 判据表那一行）与 goal 记录自身；`deliveryId` 在 `server/`、`src/` 下 **0** 命中 ⇒ deliveryId 的返回面尚不存在。合并候选（`node /data/home/yale/.claude/plugins/cache/quay/quay/0.20.0/scripts/dist/task-granularity-advice.js --root /data/home/yale/work/claudecodeui --touches server/modules/mcp-gateway/mcp-session-send.ts --touches server/modules/mcp-gateway/mcp-session-lifecycle.ts --touches server/modules/mcp-gateway/mcp-draft.ts --touches server/modules/mcp-gateway/mcp-correlation-id.ts --touches server/modules/mcp-gateway/tests/mcp-session-send-delivery.test.ts --json`）报 `peers: []`、`mentions: []`（无 todo/ready 任务声明同批文件）⇒ 判定 **none found / separate**。同 SPEC 的 S2 出口三条（`gap-ac382` / `gap-ac383` / `gap-ac384`）各有独立判据文件；本条是 SPEC §8 的 S3 API 翻转，判据文件 `mcp-session-send-delivery.test.ts` 与它们全不同，也与 S3 的另一条 AC-386（`mcp-run-get-delivery.test.ts`，run_get 双 id）不同——本条只经既有 `run_get(runId)` 面读绑定后的 turn，不落 run_get 认 deliveryId 那半。本条对 S2 出口 AC 的先后已在任务层以结构化 `depends_on` 声明（SPEC §12：后一阶段任务不得先于前一阶段出口 AC 落地），正文不复述这层关系。

### 机制（SPEC §4.1、§4.2、§5.2、§6.1、§8.1–§8.3、§13.1）

现状（即 S2 止步处）三个入口都只有 `runId`、没有 `deliveryId`，且 `runId` 被类型钉成非空：

- chat-control `send` 返回 `SendResult = { ok: true, runId: string, queued: boolean, queuedMessageUuid: string | null, completion }`（`server/modules/websocket/services/chat-control.service.ts:123`；两处成功返回在 `:597`（queued）与 `:600`（非 queued））。
- MCP `session_send` 载荷 `SessionSendPayload = { runId: string, queued, queuedMessageUuid, source, blockedBy, run? }`（`server/modules/mcp-gateway/mcp-session-send.ts:291`），其控制缝 `McpControlSendResult` 同样只声明 `runId`（`:106`）。
- MCP `session_create`（带首条消息）返回 `SessionCreatePayload = { sessionId, runId? }`（`server/modules/mcp-gateway/mcp-session-lifecycle.ts:236`、返回在 `:452`）。
- MCP `draft_submit` 返回 `{ session, runId: z.string(), queued, source }`（`server/modules/mcp-gateway/mcp-draft.ts:165`/`:167`/`:292`）——`runId` 的 schema 是 `z.string()`，不认 null。
- `correlationId` 今天记在 **run** 上（`mcp-session-send.ts:499`、`mcp-session-lifecycle.ts:449` 的 `setRunCorrelationId`）并进审计行。

SPEC §8 的 S3 修法（本条要落的那半）：

- **deliveryId 必给**：每次**被接受**的发送返回 `deliveryId`。它的生产面不是本条新铸的——`deliveryId = commandUuid`（SPEC §4.1 表、§4.2「一个 id 只有一个生产面」）：resident 由 host 在 send 时铸、CLI 在 lifecycle 里原样回带；非 resident 为 send 时铸的 uuid。所以 S3 的返回值是 **S1 账本**（`gap-ac378`，SPEC §5.2 send 行：`deliveries[u] = pushed; 返回 deliveryId = u`）已经产生的那个 uuid 的对外投影；`queuedMessageUuid` 退化为 `deliveryId` 的别名（仅排队时有，§8.1）。
- **runId 可空 + 兼容窗口**（§8.1、§8.3）：per-run provider 在响应时已有 run，`runId` 非 null；resident 在响应时一般还没有，已绑定才给，**不预铸**。`runId` 的 schema 放宽为可空（起点即 `mcp-draft.ts:167` 的 `z.string()`）。
  - **窗口内**（S3 起）：`runId` **从不为 null**——未绑定 turn 时**回填** `deliveryId`（调用方可凭 `runId === deliveryId` 辨认）；绑定后给真实的 turn id。`run_get` 同时认两种 id（AC-386 落），所以只会拿 `runId` 去 `run_get` 的旧调用方在窗口内照常工作。
  - **窗口后**：`runId` 未绑定时为 `null`。
  - **窗口截止写成带日期的常量**（§8.3 第三条）：由判据读取并断言；过期后判据变红，逼着移除回填。
- **被拒绝的发送不产生 delivery**（§8.1）：`RUN_IN_PROGRESS`（网关 `SESSION_BUSY`）等拒绝发生在 delivery 进账本之前，故账本里没有它的条目、返回值里也没有 `deliveryId`。
- **correlationId 归 delivery 且可按它检索**（§6.1、§13.1 的 AC-337 行）：`correlationId` 与 `source` 从 run 改记到 **delivery** 上；`sessions/running` 条目的 `correlationId` 取 owner delivery 的值做**兼容回填**，`sessions_list` 按 correlationId 的收敛与 `mcp_usage_stats` 的聚合（AC-337 既有两条读数面）随之改读 delivery——即「按它可检索」仍经这三个既有面读到，不新造 API。

### 交付（两件，同一任务）

1. **S3 API 翻转实现**：`chat-control.service.ts` 的 `SendResult` 增 `deliveryId: string` 且 `runId` 放宽为 `string | null`（兼容窗口内未绑定时回填 `deliveryId`，窗口判定只读注入的 `now`）；`mcp-session-send.ts` 的 `SessionSendPayload` / `McpControlSendResult` 增 `deliveryId`、`runId` 转可空，拒绝路径不产出 `deliveryId`；`mcp-session-lifecycle.ts` 的 `session_create`（带首条消息）返回 `deliveryId`；`mcp-draft.ts` 的 `draft_submit` 输出 schema 的 `runId` 放宽为可空并增 `deliveryId`；`correlationId` 的落点从 run 移向 delivery（记入处 `mcp-session-send.ts:499` / `mcp-session-lifecycle.ts:449` 改为按 delivery 记），`sessions/running` 与 `sessions_list` 的 correlationId 读数改取 owner delivery。窗口截止常量带日期、导出（落处按 `$backend-module-standards` 进 `server/shared/types.ts` 或账本模块，实现时定名写进判据读取处）。全部置于 S2 的开关之后（N-1 精神：关态对外行为不变）。
2. **判据文件**（新文件 `server/modules/mcp-gateway/tests/mcp-session-send-delivery.test.ts`，AC-385 判据）：**真实** `chat-control.service` + **真实** `chat-run-registry.service` + 注入的 **scripted fake 进程**（照 S2 判据（`gap-ac383` / `gap-ac382`）同一套装配：临时 `DATABASE_PATH` + `initializeDatabase` + `sessionsDb.createSession` + 注入 fake runtime，全程不建真实 `WebSocket`），三个 MCP builder（`buildSessionSend` / `buildSessionCreate` / `buildDraftSubmit`）架在同一控制缝上；lifecycle 的 `commandUuid` 从 injected scripted fake 宿主发出的**帧流**读（S2 之后 `command_lifecycle` 已降级为会话级帧、不进任何 run 的事件缓冲，故不读注册表事件——见 SPEC §7.3）；窗口关闭那条腿经注入的 `now` 越过导出的截止常量得到，**不重打日期**。

### 假形态（(f) 为什么承重）

(f) 忙时发送不给 `deliveryId`（把 busy 路径的 `deliveryId` 抹掉/返回 undefined）⇒ (a) 腿的 `deliveryId` 读数必须变红——这正是「兼容窗口内旧调用方拿不到投递句柄」的缺陷签名（§8.1「deliveryId 对每次被接受的发送必给」的另一面）。红必须落在 (a) 的 `deliveryId` 读数上，不是别的腿（超时、更早断言、别的读数）；还原后 (a)–(e) 恢复绿。

### 与 S3 另一条（AC-386）的边界

`run_get` **接受 `deliveryId`**、等待 delivery 终态、`RUN_NOT_FOUND.details.idKind`（SPEC §8.2）是 **AC-386** 的判据（`mcp-run-get-delivery.test.ts`）；本条 (c) 只在 delivery 绑定 turn 之后用**既有 `run_get(runId)`** 面读回该 turn，不实现也不验收 run_get 的双 id。

## AC

- [x] (a) `npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-session-send-delivery.test.ts` 退出 **0**（当前必红：文件不存在，文案含 `Could not find`）。同一次运行先打印**返回腿**：对 `session_send`、`session_create`（带首条消息）、`draft_submit` 三个入口各做一次**被接受**的发送 ⇒ 每次返回 `deliveryId`（非空字符串），且**等于**随后由 injected scripted fake 宿主发出的 lifecycle 帧里该条命令的 `commandUuid`；排队时 `queuedMessageUuid === deliveryId` ⇒ 读数 `sendDeliveryId=true createDeliveryId=true draftDeliveryId=true lifecycleCommandUuidMatch=true queuedAliasHolds=true`，打印读数后再断言。
- [x] (b) 同一次运行内 **per-run 腿**：对按次（非常驻）provider 的一次被接受发送 ⇒ `runId` 非空，且等于真实 `chatRunRegistry.getRun(session).runId`（经注册表按会话读回的同一次运行），`deliveryId` 亦非空 ⇒ 读数 `perRunRunIdMatches=true perRunRunIdNonNull=true`。
- [x] (c) 同一次运行内 **resident 忙时 + 兼容窗口腿**：(c1) 常驻会话忙时发送，窗口**开**（注入的 `now` 早于导出的截止常量）⇒ 连续 K 次发送的 `runId` **从不为 null**（`windowOpenRunIdNonNull=true`）；未绑定 turn 时 `runId === deliveryId`（`unboundRunIdEqualsDeliveryId=true`）。(c2) 把注入的 `now` 推过导出的**带日期**截止常量（窗口**关**）后同一次发送 ⇒ `runId === null`（`windowClosedRunIdNull=true`），直到该 delivery 绑定 turn（fake 宿主发 `init`）后，用**既有** `run_get(runId)` 读到该 turn（`boundRunIdReadableViaRunGet=true`）。(c3) **熔丝**：判据读实现导出的同一个截止常量并断言它仍晚于真实当下（`windowDeadlineInFuture=true`）——判据**不重打日期**，日期一过该断言变红，逼着移除回填（§8.3）。
- [x] (d) 同一次运行内 **拒绝不产生 delivery 腿**：对按次 provider 在运行中再发一次 ⇒ 得到 `RUN_IN_PROGRESS` / `SESSION_BUSY` 失败信封，且**账本无该条 delivery**——断言信封里无 `deliveryId`、且发送前后未终态 delivery 计数**不变**（`rejectedNoDelivery=true rejectedEnvelopeHasNoDeliveryId=true`）。
- [x] (e) 同一次运行内 **correlationId 归 delivery 腿**：一次带 `correlationId=L` 的被接受发送 ⇒ 该 delivery 记着 `L`（从 delivery 记录读回，`correlationOnDelivery=true`），并**按 `L` 可检索**到承载它的会话/delivery（经既有面：`sessions/running` 条目的 `correlationId` 兼容回填 / `sessions_list` 的 correlationId 收敛，`retrievableByCorrelationId=true`）。
- [x] (f) **取假形态可复现**：忙时发送不给 `deliveryId` ⇒ **(a) 腿红**，且红落在 (a) 的 `deliveryId` 读数上、**不是别的腿先红**。逐字红态读数、退出码与命令行抄进完成记录；用后还原、重跑 (a)–(e) 恢复绿，`git diff` 最终不含该临时代码。
- [x] (g) 该判据文件单次运行墙钟 **< 45s**（SPEC §11：goal gate 默认 60 s，须留余量）；每条读数在断言之前先采齐（红要落在错的读数上，不落在超时或更早的腿上）；进程预算守卫照兄弟文件用 `exit 3`（进程级杀，不是单用例失败）。
- [x] (h) collateral：新增一个 `server/**/*.test.ts` ⇒ **先复量** `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l`（立案时为 **347**，以执行时实测为准），按 `server/shared/tests/quay-test-script.test.ts` 自身两条计数 pin（立案读数 AC2 的 `known=3 unknown=344`、AC3 的 `known=1 unknown=346`，即 `base+1`）各 +1，并改写其上方注释里的算术（立案读数注释为 `347 - 3 = 344` / `347 - 1 = 346`）；`scripts/suite-duration-baseline.tsv` **仅当** AC7 覆盖率地板跌破 90% 才追加一行（先量，通常不动）。单文件复跑 `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0。
- [x] (i) 既有 S3 影响面判据在兼容窗口**开**态下不被悄悄变红：`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-session-send.test.ts`、`... mcp-session-lifecycle.test.ts`、`... mcp-correlation-id.test.ts`、`... mcp-cancel-queued.test.ts`、`... server/modules/websocket/tests/chat-control-send.test.ts`、`... server/modules/websocket/tests/chat-control-busy.test.ts` 各退出 **0**；若实现上必须改动其中任一文件（SPEC §13.1 的 AC-230 / AC-231 / AC-249 / AC-250 / AC-271 / AC-337 行），在完成记录里**逐条列出并说明**，不得悄悄让它们变红。（`mcp-run-get.test.ts` 的 run_get 双 id 变更属 AC-386，不在本条验收内。）
- [x] (j) 遵守 `$backend-module-standards`：判据落 `server/modules/mcp-gateway/tests/`、跨模块只经 `index.ts` barrel、无 `any`；`npx tsc --noEmit -p server/tsconfig.json` 退出 0。

## DoD

真实落地判据（不是「测试存在」、也不是「字段存在」）：在交付的树上跑 `server/modules/mcp-gateway/tests/mcp-session-send-delivery.test.ts`——它经**真实 chat-control.service + 真实 chat-run-registry.service + 注入的 scripted fake 进程 + 三个真实 MCP builder**：

(a) `session_send` / `session_create`（带首条消息）/ `draft_submit` 每次被接受的发送都返回 `deliveryId`，且等于随后 lifecycle 帧的 `commandUuid`，排队时 `queuedMessageUuid === deliveryId`；
(b) per-run provider 的 `runId` 非空且等于真实 `getRun(session).runId`；
(c) resident 忙时：窗口内 `runId` 从不为 null、未绑定等于 `deliveryId`；窗口（带日期常量）关后为 null，直到绑定后经既有 `run_get(runId)` 读到；常量仍晚于当下的熔丝断言在位；
(d) 被拒绝的发送（`RUN_IN_PROGRESS`）不产生 delivery（账本无条目、信封无 `deliveryId`、未终态计数不变）；
(e) `correlationId` 记在 delivery 上且按它可检索（既有面回填）；
(f) 假形态（忙时不给 `deliveryId` ⇒ (a) 红，红落在 `deliveryId` 读数上）可复现，还原后恢复绿——即判据有洞会被看见。

`git diff` 须只含：S3 翻转实现（`server/modules/mcp-gateway/mcp-session-send.ts`、`server/modules/mcp-gateway/mcp-session-lifecycle.ts`、`server/modules/mcp-gateway/mcp-draft.ts`、`server/modules/websocket/services/chat-control.service.ts`、`server/modules/mcp-gateway/mcp-correlation-id.ts` 及实际承载窗口常量/`deliveryId` 类型的那一处，以及在 §13.1 里必须随之改读的 `sessions/running` / `sessions_list` 读数处）、这一个新判据文件、`server/shared/tests/quay-test-script.test.ts` 的两条计数 pin（地板未破时不动 baseline），以及本任务的 task 文件。

## Touches

- `server/modules/mcp-gateway/mcp-session-send.ts` （`McpControlSendResult`(:106) 与 `SessionSendPayload`(:291) 增 `deliveryId`、`runId` 转可空；成功路径按 §8.1 填 `deliveryId`，拒绝路径（`:475`）不产出它；`correlationId` 落点由 run 改 delivery）
- `server/modules/mcp-gateway/mcp-session-lifecycle.ts` （`SessionCreatePayload`(:236) 增 `deliveryId`；`session_create` 带首条消息的返回 `:452` 与 `correlationId` 落点 `:449`）
- `server/modules/mcp-gateway/mcp-draft.ts` （`DRAFT_SUBMIT_OUTPUT_SCHEMA`(:165) 的 `runId` 放宽为可空、增 `deliveryId`；`buildDraftSubmit`(:288) 返回体）
- `server/modules/websocket/services/chat-control.service.ts` （`SendResult`(:123) 增 `deliveryId`、`runId` 转 `string | null`；两处成功返回 `:597`/`:600` 填 `deliveryId` 与兼容窗口回填；窗口判定只读注入的 `now`）
- `server/modules/mcp-gateway/mcp-correlation-id.ts` （correlationId 的 contract 说明与落点：从 run 改记 delivery——**仅当**落点改动落在此模块）
- `server/shared/types.ts` （`deliveryId` / 兼容窗口**带日期截止常量**的类型或常量落处，按 `$backend-module-standards` 分组注释；若实现选址在账本模块则改列该模块）
- `server/modules/websocket/services/sessions.service.ts` （§13.1：`sessions/running` 的 correlationId 读数改取 owner delivery——**仅当** (e) 的「按它可检索」经此落地）
- `server/modules/mcp-gateway/mcp-gateway.read-tools.ts` （§13.1：`sessions_list` 的 correlationId 收敛改取 owner delivery——**仅当** (e) 的「按它可检索」经此落地）
- `server/modules/websocket/services/chat-run-registry.service.ts` （**实现上必需、立案时未列**：S3 把 correlationId 的落点从 run 移到 **delivery**，而 `sessions/running` 条目与 `sessions_list` 的收敛读的是本模块的 `listRunningRuns`——它就是 §13.1 那句「必须随之改读的 `sessions/running` 读数处」。新增按 delivery id 存取的标签表 + `setDeliveryCorrelationId` / `getDeliveryCorrelationId`，并让 `listRunningRuns` 取 run **owner delivery**（`deliveryIds[0]`）的标签、回落到 run 级字段；`clearAll` 一并清该表）
- `server/modules/mcp-gateway/tests/mcp-correlation-id.test.ts` （**实现上必需、立案时未列**：该判据以 `deepEqual(Object.keys(payload))` 钉住 label-less `session_send` 的**精确字段集**（AC-337 的「pre-AC-337 payload shape」pin）。S3 按 §8.1 给每次被接受的发送加 `deliveryId`，该 pin 必须随之加一项并断言 flag-off 下它是 `null`——这是 §13.1 AC-337 行要求「不得悄悄变红」的那类既有判据改写，逐条列在完成记录里）
- `server/modules/websocket/tests/chat-control-busy.test.ts` （**实现上必需、立案时未列**：`SendResult.runId` 依 §8.1 放宽为 `string | null` 后，该文件三处 `chatRunRegistry.getRunById(result.runId)` 不再通过 `tsc`；补 `assertNonEmptyString(result.runId, ...)` 断言式收窄——flag 关态下控制面本就返回注册表 runId，这是把既有事实写成读数，不是放宽断言。属 AC (i) 明列文件，逐条列在完成记录里）
- `server/modules/mcp-gateway/tests/mcp-session-send-delivery.test.ts` （新：AC-385 判据文件——真实 chat-control / registry + scripted fake 进程 + 三个真实 builder，(a)–(f) 六条腿）
- `server/shared/tests/quay-test-script.test.ts` （collateral：新增一个 server 测试文件 ⇒ AC2 / AC3 两条计数 pin 各 +1，并改写其上方注释的算术）
- `scripts/suite-duration-baseline.tsv` （collateral：仅当 AC7 覆盖率地板被新增文件压破 90% 才追加一行；先量，通常不动）
- `tasks/gap-ac385-send-deliveryid-runid-compat-window.md` （自触）

## Evidence

完成记录（2026-10-16，worker 在 worktree `/data/home/yale/work/claudecodeui-worktrees/gap-ac385-send-deliveryid-runid-compat-window`（分支 `task/gap-ac385-send-deliveryid-runid-compat-window`）上执行；实现提交 `5ec056496`）。

### 基线红（判据文件创建之前，逐字）

```
$ npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-session-send-delivery.test.ts
Could not find 'server/modules/mcp-gateway/tests/mcp-session-send-delivery.test.ts'
EXIT=1
```

### 判据命令与读数

`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-session-send-delivery.test.ts` → 退出 **0**，`pass 1 fail 0`，墙钟 **521–945ms**（预算守卫 `exit 3` @44s）。同一次运行的逐字读数：

```
(flags) residentRunIsTurn=true deadline=1799971200000 pid=2353661
(a) send="39bafc96-…"/"39bafc96-…" create="be4f552a-…" draft="765fbe91-…"
    hostUuids=[39bafc96-…,be4f552a-…,765fbe91-…] ledgerStates=[queued,queued,queued]
    sendDeliveryId=true createDeliveryId=true draftDeliveryId=true
    lifecycleCommandUuidMatch=true queuedAliasHolds=true draftQueued=true
(b) returnedRunId="f2d96284-…" registryRunId="f2d96284-…" deliveryId="d728ca32-…"
    perRunRunIdMatches=true perRunRunIdNonNull=true perRunDeliveryIdNonNull=true
(c1) sends=[{deliveryId:"722395d7-…",runId:"722395d7-…"},{…},{…}]
     windowOpenRunIdNonNull=true unboundRunIdEqualsDeliveryId=true
(c2) closedRunId=null closedDeliveryId="eb8641fe-…" hostUuid=eb8641fe-… boundRunId="cffa53da-…"
     runGet="cffa53da-…" windowClosedRunIdNull=true closedDeliveryIdNonNull=true
     boundRunIdReadableViaRunGet=true
(c3) deadline=1799971200000 windowDeadlineInFuture=true
(d) code=SESSION_BUSY details={"runId":"c71860ff-…","hint":"This session already has a run in progress; use run_get to follow it, or retry later."}
    liveBefore=6 liveAfter=6 rejectedNoDelivery=true rejectedEnvelopeHasNoDeliveryId=true
(e) deliveryId="69581a06-…" stored="ac385-delivery-label" correlationOnDelivery=true retrievableByCorrelationId=true
(summary) perRunParked=1 elapsedMs=521
```

（UUID 在全长输出里是完整值，此处只截断尾段以保持行宽；`(a)` 三处 `hostUuids` 与返回的 `deliveryId` 逐字相等。）

判据经**真实** `createChatControlService` + **真实** `chatRunRegistry` + **真实** `ClaudeResidentHostDriver`（进程注入：一个 scripted fake `claude` 流，按 host 分开——四个 resident 会话各有一条流，否则一帧会被别的 host 的读循环偷走并被记成 foreign），三个 MCP builder 架在同一 `control.send` 上；全程不建 `WebSocket`、不起真实 CLI。`deliveryId` 的对照物取**宿主的账本**（`ledgerReading().deliveries[].deliveryId`）与**宿主自己的 busy 队列记录**（`busyInputReading().queuedInputs[].uuid`），不是 API 自己造的值。

### (f) 取假形态：逐字红态与还原

注入（`chat-control.service.ts` 忙时返回分支，`git diff` 临时改一行）：

```diff
-        deliveryId: queuedMessageUuid ?? deliveryId,
+        deliveryId: null, // FALSE FORM (AC-385 (f)): a busy send names no delivery.
```

```
$ npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-session-send-delivery.test.ts
(a) send=null/"d925adce-…" create="fab63b00-…" draft=null hostUuids=[…] ledgerStates=[queued,queued,queued]
    sendDeliveryId=false createDeliveryId=true draftDeliveryId=false
    lifecycleCommandUuidMatch=false queuedAliasHolds=false draftQueued=true
AssertionError [ERR_ASSERTION]: session_send.deliveryId must be a non-empty string (got null)
ℹ fail 1
EXIT=1
```

红落在 **(a) 腿的 `deliveryId` 读数**上（`sendDeliveryId=false` / `draftDeliveryId=false`／`lifecycleCommandUuidMatch=false`／`queuedAliasHolds=false`），且是该腿第一条断言先红——不是超时、不是 (b)–(e)、不是别的读数。`git checkout --` 还原后复跑：`pass 1 fail 0`（读数见上节），`git diff` 最终不含该行。

### (h) collateral

复量：`find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l` → **355**（立案时 347，gab-ac377…ac384 各 +1 后为 354，本条 +1）。`quay-test-script.test.ts` 两条 pin 各 +1（AC2 `known=3 unknown=352`、AC3 `known=1 unknown=354`）并改写上方注释的算术（`355 - 3 = 352` / `355 - 1 = 354`）。单文件复跑该文件：`pass 14 fail 0`，退出 **0**。`scripts/suite-duration-baseline.tsv` **未动**：AC7 的覆盖率地板按新增一个文件后仍在 90% 以上（该 pin 由 `quay-test-script.test.ts` 的 AC7 用例在本次运行中判绿）。

### (i) 既有 S3 影响面

全部退出 **0**（flag 关态逐字不变）：

```
chat-control-send.test.ts          pass 4  fail 0
chat-control-busy.test.ts          pass 5  fail 0
mcp-session-send.test.ts           pass 8  fail 0
mcp-session-lifecycle.test.ts      pass 15 fail 0
mcp-correlation-id.test.ts         pass 8  fail 0
mcp-cancel-queued.test.ts          pass 6  fail 0
```

另按类型面复跑未在 (i) 列名但被 S3 类型影响的两支：`mcp-draft.test.ts` pass 3、`mcp-production-session-wiring.test.ts` pass 5、`mcp-session-create-library-model.test.ts` pass 1，均退出 0。

**实现上必须改动的既有判据文件（逐条列出并说明）**：

1. `server/modules/mcp-gateway/tests/mcp-correlation-id.test.ts`（AC-337）——`(b)` 腿以 `deepEqual(Object.keys(plainPayload).sort(), ['blockedBy','queued','queuedMessageUuid','runId','source'])` 钉住 label-less `session_send` 的精确字段集。S3 §8.1 要求每次被接受的发送都带 `deliveryId`，故期望集合加 `deliveryId` 一项，并断言 flag 关态下它为 `null`（该判据不设 `RESIDENT_RUN_IS_TURN`）。这是该 pin 唯一被触及的读数，其余断言未动。
2. `server/modules/websocket/tests/chat-control-busy.test.ts`（AC-231 / AC-233 面）——`SendResult.runId` 放宽为 `string | null` 后，三处 `chatRunRegistry.getRunById(first/second.runId)` 不再是 `string`；补 `assertNonEmptyString(<send>.runId, 'runId')` 收窄。flag 关态下控制面返回的仍是注册表 mint 的 runId，故这是把既有事实写成读数；该文件其余断言（`notEqual(runId2, runId1)`、`getRunById` 可达性）原样保留。

`mcp-session-send.test.ts` 的 `waitSeconds` 腿、`mcp-session-lifecycle.test.ts` 的 create 返回面未改：flag 关态下 `runId` 仍是注册表 runId、`run` 读数照旧挂载（新增的 `deliveryId` 为 `null`，不改变任何被断言的字段）。（`mcp-run-get.test.ts` 的双 id 变更属 AC-386，本条未触碰。）

### 实现要点（判据之外的落地选择）

- **窗口常量**：`server/shared/types.ts` 的 `RUN_ID_COMPAT_WINDOW_END_MS = Date.parse('2027-01-15T00:00:00Z')` + `isRunIdCompatWindowOpen(nowMs)`，与 delivery 常量同区分组注释。判据读同一个导出（`(c3)` 的熔丝）。
- **deliveryId 的来源**：resident 会话经 `@/modules/providers/index.js` barrel 读宿主账本的投影（`readSessionDeliveries`，有界交接，超时降级 `null`）；per-run 会话读本 run 的 `deliveryIds`（`dispatchRun` 在 send 时铸的 uuid，SPEC §4.1）。queued 时以 `queuedMessageUuid` 为准，使 §8.1 的别名按构造成立。
- **runId 的三种答案**：per-run ⇒ 注册表 runId；resident 且 delivery 已绑 turn ⇒ `readSessionTurnRun` 的 runId；否则窗口开 ⇒ `deliveryId`、窗口关 ⇒ `null`。窗口判定只读 `deps.now`（新增可选 seam，默认 `Date.now`）。
- **correlationId 归 delivery**：registry 新增按 delivery id 存取的标签表（有界 1000 条），`listRunningRuns` 取 run owner delivery（`deliveryIds[0]`）的标签并回落到 run 级字段——`sessions/running` 与 `sessions_list` 的收敛因此自动改读 delivery；两个 builder 以 delivery id 落标签、`setRunCorrelationId` 退为 fallback，故 AC-337 的 run-addressed 写仍原样成立。
- **关态不变**：全部新增行为置于 `residentRunIsTurn()` + `acceptsBusyInput` 之下；flag 关时 `deliveryId` 为 `null`、`runId` 原样、不做账本读（既有判据因此逐字不变）。

## Blocker

**2026-10-16T13:28:04.034Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: not ok - server/modules/voice-realtime/tests/voice-realtime-live-executor.false-forms.test.ts:   AssertionError [ERR_ASSERTION]: the mutant is crafted to return an equal payload
- run_id：wk-prod-anchor
- session_id：07aafc33-f971-409a-b2e7-c61bf5a97231
