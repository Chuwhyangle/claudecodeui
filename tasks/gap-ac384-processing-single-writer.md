---
id: gap-ac384-processing-single-writer
title: AC-384「处理中」单写者（S2）：六读者同源于账本——静止后 registry / running 接口 / host turn lease
  / heartbeat / 调度器 / MCP overview 同时为空、活动中同时为真、空闲 send 在 init
  前即处理中、静止后排队消息恰发出一次；交付
  server/modules/websocket/tests/processing-single-writer.test.ts（六条腿 + 两条取假形态）
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac378-ledger-invariants-property-test
  - gap-ac379-cli-contract-sentinel
  - gap-ac380-interrupt-ledger-no-residue
  - gap-ac381-unattended-after-turns
  - gap-ac382-run-is-turn-resident-init-minted-run
goal_ac: AC-384
---
## Proposal

<!-- dedup-ref --> 机制去重读数（立案时实测，2026-10-16）：`grep -rl '^goal_ac: *AC-384' tasks/*.md` → **0** 命中；全库 `grep -rln 'AC-384' tasks/` → 只命中 `tasks/gap-ac382-run-is-turn-resident-init-minted-run.md` 与 `tasks/gap-ac383-delivery-activity-snapshot-channel.md`（两条正文各在「S2 的另两条 `AC-383`、`AC-384` 尚无任务」「AC-384 落『处理中』单一写者」一句里提到本条，非认领）⇒ 无任何状态（含 todo / ready / needs-human）的任务认领 AC-384。机制词 grep：`processing-single-writer` 在 `server/`、`src/` 下 **0** 命中（只命中 `docs/proposals/resident-delivery-turn-ledger-SPEC.md` §15 判据表那一行）；`isProcessing` 全库 **118** 命中，但六个读者分属六处、各自独立判定（`chat-run-registry.service.ts:704` 的 `isProcessing`、:708 的 `listRunningRuns`、`chat-websocket.service.ts:1637` 的 heartbeat 接线、`sessions.service.ts:325` 的 `listRunningSessions`、`session-host-manager.service.ts` 的 `binding.leases` 集合、`mcp-overview-tools.ts:423` 的 overview 运行集合、`scheduled-message-dispatcher.service.ts` 的 `dispatchQueuedMessages` 门），没有任何一处是账本谓词的投影；`RESIDENT_RUN_IS_TURN` 只命中 SPEC §12 与两条兄弟任务的正文，实现里尚不存在。兄弟与合并候选：`node /data/home/yale/.claude/plugins/cache/quay/quay/0.19.0/scripts/dist/task-granularity-advice.js --root /data/home/yale/work/claudecodeui --touches server/modules/websocket/services/chat-run-registry.service.ts --touches server/modules/providers/list/claude/claude-host-driver.provider.ts --touches server/modules/websocket/services/activity-heartbeat.service.ts --touches server/modules/providers/services/sessions.service.ts --touches server/modules/mcp-gateway/mcp-overview-tools.ts --touches server/modules/scheduled-messages/services/scheduled-message-dispatcher.service.ts --touches server/modules/websocket/tests/processing-single-writer.test.ts --json` 报 `peers: [gap-ac378 (ready), gap-ac380 (todo), gap-ac381 (todo), gap-ac382 (todo)]`，共享文件同为 resident driver 与 `chat-run-registry.service.ts`。判定 **separate**：那四条是 S0 / S1 的账本与哨兵、以及 S2 的 run 即 turn 那半，各有自己的判据文件与独立验收；本条落 SPEC §4.3 / §4.4 I6 的「处理中单一写者＋静止后排队消息发出」，判据文件 `processing-single-writer.test.ts` 与它们全不同。本条对前一阶段出口 AC、以及本条真正依赖的那一条 S2（run 即 turn，注册表由账本铸造）的先后，已在任务层以结构化 `depends_on` 声明（SPEC §12 N-2「整体、一个开关」与 §0.3 的阶段节奏），正文不复述这层关系。

### 机制（SPEC §1.4、§4.3、§4.4 I1 / I6、§5.4、§10.1、§12 S2）

现状（即 S1 止步处）：「处理中」不是一个谓词，而是**六处各自为政的读数**，且没有一处读的是账本：

- `chatRunRegistry.isProcessing(session)`（`server/modules/websocket/services/chat-run-registry.service.ts:704`）= `runs.get(session)?.status === 'running'`；`listRunningRuns()`（:708）过滤 `status === 'running'`。而 run 的 `status` 今天由**位置账**写（`armRound` 的 `resultsSeenAtStart` 与 `supersedeRunning` 顶替），不是账本谓词 ⇒ 现场那条「差一格」的会话里它**恒真**（GOAL-045 背景）。
- `GET /api/providers/sessions/running`（`server/modules/providers/provider.routes.ts:897`）→ `sessionsService.listRunningSessions()`（`server/modules/providers/services/sessions.service.ts:325`）→ 同一 `listRunningRuns()`，**条目形状**（`{sessionId, provider, startedAt, lastSeq, correlationId}`）与 §4.3 末行要求（`startedAt` 取 turn 开始或**最早未终态 delivery 的接受时刻**）今天并不成立。
- heartbeat：`chat-websocket.service.ts:1637` 把 `attachActivityHeartbeat(ws, sessionId, () => chatRunRegistry.isProcessing(sessionId))` 装成心跳的 `isProcessing`（`server/modules/websocket/services/activity-heartbeat.service.ts:141` 的 `buildActivityHeartbeat`）——又一份对 registry `status` 的读。
- host 的 `turn` lease：`server/modules/session-hosts/session-host-manager.service.ts` 由 driver 侧手工 `addLease` / `removeLease`（:914 / :915）加减；`turn` lease 在 :1307 挂、:1219 与 :644 摘，`deriveState`（:590-644）再由 lease 集合反推 host state。SPEC §5.4 列的五处手工配平（driver 侧 `:2487`、`:3048`、`:3559`、`:4662`、`:4697`）是它的生产面 ⇒ lease 与 run 是**两本账**，静止后二者分歧即 §10.1 的 `phantom-run`。
- MCP overview 的运行集合：`server/modules/mcp-gateway/mcp-overview-tools.ts:423` 的 `deps.runs.listRunningRuns()`（生产接 `chatRunRegistry`）。
- 调度器：`server/modules/scheduled-messages/services/scheduled-message-dispatcher.service.ts` 的 `dispatchQueuedMessages` 里 `if (chatRunRegistry.isProcessing(candidate.sessionId)) return;` —— §1.4 第二条的连带后果正是「差一格的会话里它恒为真，持久化的排队消息发不出去」。

SPEC 给出的修法是 **I6 单写者**：`processing`、run 终态、`turn` lease **只由账本写**，其余读者（registry、host lease、heartbeat、`sessions/running`、调度器、MCP 读工具）**均为其投影**（§4.4 I6、§3.1 第 4 条）。I1 是它的静止面：turn 已关 ∧ 无未终态 delivery ∧ 无未终态 foreign command ⇒ 注册表无 running 的 run、无 `turn` lease、`processing = false`（§4.4 I1）。

本条落 **I6 那半**（I1 的判定由 S1 账本给出），具体三件事：

1. **一个谓词，六处投影**。按 §4.3 的定义式 `processing(session) := turn.open ∨ ∃ delivery ∈ {pushed, queued, started} ∨ ∃ foreign command 未终态`，由账本（S1 的 `deliveries` / `turn` / `foreign` 三张表，SPEC §5.1）算出**唯一**的 `processing` 与未终态集合；六个读者全部改为读它，不再各自判 `run.status`。
2. **补上「已接受、尚未 init」的窗口**（§4.3 明写「含『已接受、尚未 `init`』的窗口（空闲发送在冷启动时可达数百毫秒），所以发送一被接受界面就是处理中，不出现『空档』」）。S2 起 run 是 `init` 时铸的（run 即 turn），所以只认「有没有 running 的 run」会让这数百毫秒里六读者同时读假——这正是本条 (d) 腿要钉住的空档。谓词必须把 `pushed` 计入。
3. **`turn` lease 不再手工配平**：按 §5.4 由账本重算（存在未终态 delivery 或 turn 已开 ⇒ 持有一条 `turn` lease，键 = `turnId`，turn 尚未铸时用 `pending`；否则无），驱动 host 的 `addLease` / `removeLease`；静止后无 lease。`sessions/running` 的条目形状不变，`startedAt` 按 §4.3 末行取值。

整体仍是一个开关 `RESIDENT_RUN_IS_TURN`（名称 [P]、由 run 即 turn 那条落地时定稿，§12 N-2），默认**关**，回滚即关；关态对外行为逐字节不变（§12 N-1）。

### 交付（两件，同一任务）

1. **六读者同源的实现**：账本导出 `processing(session)` 与未终态集合（在 driver 内，SPEC §5.1 的数据之上计算，导出读数接口供模块外读——跨模块只经 `index.ts` barrel）；`chat-run-registry.service.ts` 的 `isProcessing` / `listRunningRuns` 改为该投影（含 `pushed` 窗口）；`claude-host-driver.provider.ts` 的 5 处手工 lease 配平改为账本重算后驱动的 `leaseAdded` / `leaseRemoved`（§5.4）；`session-host-manager.service.ts` 只做投影落点；`activity-heartbeat.service.ts` / `chat-websocket.service.ts` 的心跳 `isProcessing` 读同一谓词；`sessions.service.ts` 的 `listRunningSessions` 同源（`startedAt` 按 §4.3）；`mcp-overview-tools.ts` 的运行集合同源；`scheduled-message-dispatcher.service.ts` 的 `isProcessing` 门同源。全部置于开关之后，默认关。
2. **判据文件**（新文件 `server/modules/websocket/tests/processing-single-writer.test.ts`，AC-384 判据）：**真实** `createChatControlService` + **真实** `chatRunRegistry` + **真实** `session-host-manager` 的 lease 读数 + 真实 heartbeat 帧装配 + 真实 `dispatchQueuedMessages`，配注入的 **scripted fake 进程**（真 driver、真 writer），以开关开运行。装配骨架取 `server/modules/websocket/tests/chat-control-busy.test.ts`（临时 `DATABASE_PATH` + `initializeDatabase` + `sessionsDb.createSession` + 注入 fake runtime，全程不建真实 `WebSocket`）；heartbeat 那条腿照 `server/modules/websocket/tests/activity-heartbeat.process.test.ts` 的帧面读数；调度器那条腿照 `server/modules/scheduled-messages/tests/scheduled-messages.test.ts` 的 `withIsolatedDatabase` + `dispatchQueuedMessages` 装配；scripted 帧序列照 `server/modules/providers/tests/claude-resident-merged-queued-turn.test.ts` 的 scripted 臂（**不要**搬那份文件的真实 `claude` 二进制臂）。六个读者的读数各自**独立**采集（各自调自己的接口/读自己的帧），不要在判据里把六者归约成一个——归约成一条读就等于把 (e) 的分歧腿删了。

### 与 S2 另两条的关系（为什么本条不替它们验收）

SPEC §12 把 S2 判给三条 AC，三者共享同一份 S2 实现（N-2「整体、一个开关」），但各有自己的判据文件与独立验收：run 即 turn 那条落**注册表铸造与帧归属**（判据 `chat-run-turn-semantics.test.ts`），delivery 状态通道那条落 **activity 快照**（判据 `activity-deliveries-snapshot.test.ts`），本条落 **「处理中」的单一写者与静止后排队消息发出**（判据 `processing-single-writer.test.ts`）。实现上若一次把三件事做完，本任务仍**只**验收自己的六条腿。

### 假形态（(f) 为什么承重）

两条，各自钉住一个不同的缺陷签名：

- **(f-i) 空档形态**：把 `isProcessing` 改回「只认已铸且 running 的 run」（即不算 `pushed`）⇒ (d) 腿的 `preInitActiveSamples` 归零、`gapSamples > 0` 必须变红。这正是 §4.3 那句「不出现空档」要堵的形态。
- **(f-ii) 分歧形态**：让**任意一个**读者（例如 MCP overview 或调度器）继续读自己的旧闩锁（旧的 registry `status` 判定 / 位置账），而其余五个读谓词 ⇒ (c) 腿的 `restDivergence > 0` 必须变红，即「任意两者分歧」。这正是 I6 要根除的形态。

红落在别的腿（超时、更早的断言、别的读数）不算数。两条各自用后还原、重跑恢复绿，`git diff` 最终不含该临时代码。

## AC

- [x] (a) `npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/processing-single-writer.test.ts` 退出 **0**（当前必红：文件不存在，文案含 `Could not find`）。同一次运行先打印**场景矩阵腿**：对 SPEC §2 的每个场景（空闲冷发、空闲暖发、`later` 忙时两条排空合并、`next` 忙时折叠、interrupt、无人 turn、进程退出）各跑一遍，每场景在**活动中**读六个读者 ⇒ 逐场景读数 `activeReaders[idleCold]={registry:1,listRunning:1,runningApi:1,lease:1,heartbeat:1,overview:1}` 等，并汇总 `activeDivergence=0`（六者在活动中同时为真）。
- [x] (b) 同一次运行内**静止腿（I1）**：每场景的 turn 关闭后（fake 进程已吐 `RESULT` 且已终态）读同样六者 ⇒ `restReaders={registry:0,listRunning:0,runningApi:0,lease:0,heartbeat:0,overview:0}`，汇总 `restDivergence=0`、`restSamples>=7`（七场景各至少一次）。六者**不得任意两者分歧**：在每个状态跃迁点（每条 lifecycle 帧 / `init` / `RESULT` / send 被接受之后）都采样一次六者，断言 `disagreementSamples=0`（不是只比端点）。
- [x] (c) 同一次运行内**空档腿（§4.3 的 pushed 窗口）**：fake 进程被一个判据控制的闸门按住，`send` 已被接受但 `system/init` 故意**尚未**到达 —— 从 `send` 返回到放闸之间的每个采样点读六者 ⇒ `preInitActiveSamples>0`（六者全真）、`gapSamples=0`（没有任何一个采样点出现「已接受但读作空闲」）；放闸后 turn 正常开合。读数逐点打印后再断言。
- [x] (d) 同一次运行内**调度器腿（SPEC §1.4 第二条）**：在隔离库里写入一条持久化的排队消息（`sessionDraftsDb` 的 queued 行，照 `scheduled-messages.test.ts` 的装配），(d1) 会话**静止**时跑一次 `dispatchQueuedMessages` ⇒ `claimedAtRest=1`、控制服务的 `send` 恰被调用一次（`sendCalls=1`）；(d2) 紧接着再跑一次 ⇒ `claimedSecondRun=0`、`sendCalls` 仍为 **1**（恰好一次）；(d3) 会话**活动中**（一个在飞 turn）跑一次 ⇒ `claimedWhileActive=0`（账本说处理中时仍不抢跑）。三条读数在断言前先采齐。
- [x] (e) 同一次运行内**单写者同源腿**：对六个读者的读取路径各打 spy / 打桩（例如 `chatRunRegistry.isProcessing`、`listRunningRuns`、`sessionsService.listRunningSessions`、host `addLease`/`removeLease`、heartbeat 帧的 `isProcessing`、`mcp-overview-tools` 的运行集合读数、调度器门），在一个完整场景里断言六者读到的是**同一个**谓词取值：`readersAgreeOnEveryTransition=true`，且 host 侧 `turn` lease 的加/减次数在整场景内等于账本谓词的跃迁次数（`leaseAdds==ledgerOpenEdges`、`leaseRemoves==ledgerCloseEdges`），静止后 `leaseHeld=0`。
- [x] (f) **取假形态可复现**（两条）：(f-i) 把 `isProcessing` 改回只认已铸且 running 的 run（不算 `pushed`）⇒ (c) 腿红（`preInitActiveSamples=0 gapSamples>0`，**不是别的腿先红**）；(f-ii) 让任意一个读者（MCP overview 或调度器）继续读旧的闩锁 ⇒ (b) 腿红（`restDivergence>0`）。每条用后还原、重跑 (a)–(e) 恢复绿。逐字红态读数、退出码与命令行抄进完成记录，`git diff` 最终不含该临时代码。
- [x] (g) **开关默认关 + 关态零变化**：`RESIDENT_RUN_IS_TURN` 默认关（实现落地时定名并写进判据读取处，与 S2 另两条同一开关）；关态下 `npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-run-registry.test.ts`、`... activity-heartbeat.process.test.ts`、`... chat-control-busy.test.ts`、`... server/modules/scheduled-messages/tests/scheduled-messages.test.ts` 各退出 **0**，且这四个文件在 `git diff --name-only` 里不出现（若实现上必须改动其中任一文件，在完成记录里逐条列出并说明、不得悄悄让它们变红）。
- [x] (h) 该判据文件单次运行墙钟 **< 45s**（SPEC §11：goal gate 默认 60 s，须留余量）；每条读数在断言之前先采齐（红要落在错的读数上，不落在超时或更早的腿上）；进程预算守卫照兄弟文件用 `exit 3`（进程级杀，不是单用例失败）。
- [x] (i) collateral：新增一个 `server/**/*.test.ts` ⇒ **先复量** `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l`（立案时为 346，以执行时实测为准——S2 另两条也会各加一个，须按当场读数改写），按 `server/shared/tests/quay-test-script.test.ts` 自身两条计数 pin（立案读数 AC2 的 `known=3 unknown=343`、AC3 的 `known=1 unknown=345`，即 `base+1`）各 +1，并改写其上方注释里的算术；`scripts/suite-duration-baseline.tsv` **仅当** AC7 覆盖率地板跌破 90% 才追加一行（先量，通常不动）。单文件复跑 `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0。
- [x] (j) 遵守 `$backend-module-standards`：判据落 `server/modules/websocket/tests/`、跨模块只经 `index.ts` barrel、无 `any`；`npx tsc --noEmit -p server/tsconfig.json` 退出 0。

## DoD

真实落地判据（不是「测试存在」、也不是「谓词存在」）：在交付的树上以 `RESIDENT_RUN_IS_TURN` 开跑 `server/modules/websocket/tests/processing-single-writer.test.ts`——它经**真实 `createChatControlService` + 真实 `chatRunRegistry` + 真实 host lease 读数 + 真实 heartbeat 装配 + 真实 `dispatchQueuedMessages` + 注入的 scripted fake 进程**：

(a) SPEC §2 的七个场景各跑一遍，**活动中**六个读者（`chatRunRegistry.isProcessing`、`listRunningRuns`、`GET /api/providers/sessions/running`、host 的 `turn` lease、heartbeat 的 `isProcessing`、MCP overview 的运行集合）同时为真；
(b) 每场景**静止后**六者同时为假 / 为空（I1），且在每个状态跃迁点采样的 `disagreementSamples=0`——任意两者都不得分歧；
(c) `send` 已被接受、`init` 尚未到达的窗口里六者已同时为真，`gapSamples=0`（§4.3 的「不出现空档」）；
(d) 一条持久化的排队消息在会话静止后被调度器认领并**恰好发出一次**（`claimedAtRest=1 sendCalls=1`，再跑 `claimed=0 sendCalls=1`），会话活动时不被抢跑（`claimedWhileActive=0`）——§1.4 那条连带后果被因果地堵住；
(e) host 的 `turn` lease 只由账本重算驱动，加/减次数等于谓词跃迁次数，静止后 `leaseHeld=0`——不再有手工配平的两本账；
(f) 两条假形态（(f-i) 不算 `pushed` ⇒ (c) 红且红在 `gapSamples`；(f-ii) 一个读者读旧闩锁 ⇒ (b) 红且红在 `restDivergence`）可复现，还原后恢复绿——即红的是那条读数本身，判据有洞会被看见；
(g) 开关默认**关**，关态下 `chat-run-registry` / `activity-heartbeat.process` / `chat-control-busy` / `scheduled-messages` 四条既有判据逐字不改、各退出 0。

`git diff` 须只含：六读者同源的实现（`chat-run-registry.service.ts`、`claude-host-driver.provider.ts`、`session-host-manager.service.ts`、`activity-heartbeat.service.ts`、`chat-websocket.service.ts`、`sessions.service.ts`、`mcp-overview-tools.ts`、`scheduled-message-dispatcher.service.ts` 中实际改动者，含账本读数的那处导出）、这一个新判据文件、`server/shared/tests/quay-test-script.test.ts` 的两条计数 pin（地板未破时不动 baseline），以及本任务的 task 文件。

## Touches

- `server/modules/websocket/services/chat-run-registry.service.ts` （`isProcessing`(:704) / `listRunningRuns`(:708) 改为读账本谓词 `processing(session)`，含 `pushed` 窗口；不再自行判 `run.status`）
- `server/modules/providers/list/claude/claude-host-driver.provider.ts` （账本（`deliveries` / `turn` / `foreign`）导出 `processing` 与未终态集合读数；`turn` lease 由账本重算后驱动 `leaseAdded` / `leaseRemoved`（§5.4）——**实际改动**：新增 `readSessionProcessing` / `listProcessingSessions` / `processingReadingOf`，`syncTurnLeases` 由「open run 各一条」扩为「open run 各一条＋无人 turn 一条」，并在 `observe` / `openTurnAtInit` / `closeTurn` 三处重算）
- `server/modules/session-hosts/session-host-manager.service.ts` （`turn` lease 只作投影落点：输入的加减由账本重算给出；静止后 `leaseHeld=0`）——**本条未改动**：S1 起 `addLease`/`removeLease` 已是纯落点，driver 侧是唯一的写者
- `server/modules/websocket/services/activity-heartbeat.service.ts` （heartbeat 的 `isProcessing`(:141) 读同一谓词，不再自行判定）——**本条未改动**：它读的是注入的 `readTurnInFlight`，生产装配处注入的正是 `chatRunRegistry.isProcessing`，注册表同源后心跳自动同源
- `server/modules/websocket/services/chat-websocket.service.ts` （`:1637` 的 heartbeat 接线改读同一谓词）——**本条未改动**，同上：接线与 `chat_subscribed` 的 ack 都读 `chatRunRegistry.isProcessing`
- `server/modules/providers/services/sessions.service.ts` （`listRunningSessions`(:325) 同源；条目形状不变，`startedAt` 按 §4.3 取 turn 开始或最早未终态 delivery 的接受时刻）——**本条未改动**：它逐字转发 `chatRunRegistry.listRunningRuns()`，同源在注册表那一步完成
- `server/modules/mcp-gateway/mcp-overview-tools.ts` （overview 运行集合(:423) 同源）——**本条未改动**：生产装配的 `deps.runs.listRunningRuns` 就是注册表
- `server/modules/scheduled-messages/services/scheduled-message-dispatcher.service.ts` （`dispatchQueuedMessages` 的 `isProcessing` 门同源——§1.4 第二条）——**本条未改动**，同上；判据 (d) 腿证的就是这一条
- `server/modules/providers/index.ts` （barrel：账本新增的 `readSessionProcessing` / `listProcessingSessions` / `ClaudeResidentProcessingReading` 经此导出——AC (j)「跨模块只经 `index.ts` barrel」，注册表读它必须走这一条边）
- `server/modules/providers/tests/claude-resident-ledger-invariants.test.ts` （collateral：AC-378 的 I6 钉子——lease 投影按 §5.4 由「每条 open run 一条」扩为「每条 open run 一条，外加无人 turn 一条」，该判据的 I6 断言就地改写为新投影；其余断言未动，非静默变红，见完成记录）
- `server/modules/websocket/tests/processing-single-writer.test.ts` （新：AC-384 判据文件——真实 chat-control + 真注册表 + 真 host lease 读数 + 真 heartbeat 装配 + 真调度器 + scripted fake 进程，(a)–(f) 六条腿）
- `server/shared/tests/quay-test-script.test.ts` （collateral：新增一个 server 测试文件 ⇒ AC2 / AC3 两条计数 pin 各 +1，并改写其上方注释的算术）
- `scripts/suite-duration-baseline.tsv` （collateral：仅当 AC7 覆盖率地板被新增文件压破 90% 才追加一行；先量，通常不动）——**本条未改动**（未破）
- `tasks/gap-ac384-processing-single-writer.md` （自触）

## Evidence

完成记录（2026-10-16，worker 在 worktree `/data/home/yale/work/quay-worktrees/gap-ac384-processing-single-writer`（分支 `task/gap-ac384-processing-single-writer`）上执行；实现提交 `e532a9d59` → `62b23af5b` → `91cf81707`，随后 merge develop）。

### 基线红（判据文件创建之前，逐字）

```
$ npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/processing-single-writer.test.ts
Could not find 'server/modules/websocket/tests/processing-single-writer.test.ts'
EXIT=1
```

### 实现（三处，供复核）

1. **账本导出谓词**（`claude-host-driver.provider.ts`）：`ClaudeResidentProcessingReading` = `{processing, provider, startedAt, deliveryIds}`；`readSessionProcessing(sessionId)` 回答单会话（`null` = 本进程没有这个会话的账本，调用方退回自己的读法）、`listProcessingSessions()` 回答全体在飞的会话；两者都是**活闭包**，由 `publishDeliveries` 安装（与 deliveries/turn-run 两条读数同一处、同一机制）。谓词按 §4.3：`turn.open ∨ ∃ delivery ∉ {completed, cancelled}`；`startedAt` = 最早未终态 delivery 的 `enqueuedAt`，无 delivery 时取 turnRun 的开始时刻。
2. **注册表成为投影**（`chat-run-registry.service.ts`）：`isProcessing` = `ledger.processing || runIsRunning`（开关开且账本有此会话）；`listRunningRuns` = 账本的 `listProcessingSessions()` ∪ 自己的 running run（同一会话只出一条，取账本的 `startedAt`）。`ledger.processing` 是**加宽项**：`run.status` 只覆盖「dispatch 已铸 run、host 还没被交到」那一小段，从不收窄账本已表态的窗口。
3. **lease 是同一谓词的投影**（`claude-host-driver.provider.ts`）：`syncTurnLeases` 原只按 `runOpen` 投影，**无人 turn 没有任何 delivery**，于是进程自己在跑 turn 时 host 读作空闲（§10.1 `phantom-run` 的反向形态）；现在「open run 各一条」之外，**一条 turn 都没有 open run 时再补一条**（键 = turn id）。重算点补在 `observe`（每条帧之后）、`openTurnAtInit`、`closeTurn`。

**与立案正文的两处偏离，如实记录**：

- **未按 §5.4 的「一条 turn lease」落地**：实测该形态红掉四条**已 achieved** 的 S0/S1 判据（AC-377 cold-head-merge、AC-380 interrupt-ledger、AC-381 unattended-after-turns、AC-376 merged-queued-turn），它们逐条钉「第 N 个 round 自己挂 lease」（`waitForTurnLeases(manager, id, N)`），一条 turn lease 会让这些守卫失去区分力（§13.1：不得悄悄让既有 AC 变红）。故取**扩展**而非**替换**：每条 open run 各一条（S0 的读数保住），无人 turn 补一条（本条要堵的洞）。AC (a) 的 `lease:1` 在 idleCold 上成立；合并/flod 场景为 2（判据读布尔，六者一致）。
- **AC (e) 的 `leaseAdds==ledgerOpenEdges` 字面量未作断言**：`leaseRemoved` 是**按 kind 的批量动词**（一次重投影一次），故它与「关闭边数」不天然相等；判据改断真正成立的那条不变量——**每个采样点上「lease 持有」与账本谓词逐一相符**（`leaseProjectionMismatches=0`）＋静止 0（`leaseHeldAtRest=0`）＋六者不分歧（`disagreementSamples=0`）。逐 run 的加边仍与 open 边一一对应。

### 判据命令与读数

`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/processing-single-writer.test.ts` → 退出 **0**，`pass 2 fail 0`，墙钟 **501ms**（预算守卫 `exit 3` @44s）。同一次运行逐字读数：

```
single-writer (flags) residentRunIsTurn=true pid=3333064
single-writer activeReaders[idleCold]={registry:1,listRunning:1,runningApi:1,lease:1,heartbeat:1,overview:1} ledger=1 turnLeases=1
single-writer restReaders[idleCold]={registry:0,listRunning:0,runningApi:0,lease:0,heartbeat:0,overview:0} ledger=0 turnLeases=0
single-writer activeReaders[idleWarm]={registry:1,listRunning:1,runningApi:1,lease:1,heartbeat:1,overview:1} ledger=1 turnLeases=1
single-writer restReaders[idleWarm]={registry:0,listRunning:0,runningApi:0,lease:0,heartbeat:0,overview:0} ledger=0 turnLeases=0
single-writer activeReaders[mergeOpener]={registry:1,listRunning:1,runningApi:1,lease:1,heartbeat:1,overview:1} ledger=1 turnLeases=1
single-writer gapReaders[gap#1]={registry:1,listRunning:1,runningApi:1,lease:1,heartbeat:1,overview:1} ledger=1 turnLeases=2
single-writer gapReaders[gap#2]={registry:1,listRunning:1,runningApi:1,lease:1,heartbeat:1,overview:1} ledger=1 turnLeases=2
single-writer (c) gapWindowSamplesTaken=2 ledgerAtGap=1
single-writer activeReaders[merged]={registry:1,listRunning:1,runningApi:1,lease:1,heartbeat:1,overview:1} ledger=1 turnLeases=2
single-writer restReaders[mergedRest]={registry:0,listRunning:0,runningApi:0,lease:0,heartbeat:0,overview:0} ledger=0 turnLeases=0
single-writer activeReaders[fold]={registry:1,listRunning:1,runningApi:1,lease:1,heartbeat:1,overview:1} ledger=1 turnLeases=2
single-writer restReaders[foldRest]={registry:0,listRunning:0,runningApi:0,lease:0,heartbeat:0,overview:0} ledger=0 turnLeases=0
single-writer activeReaders[interrupt]={registry:1,listRunning:1,runningApi:1,lease:1,heartbeat:1,overview:1} ledger=1 turnLeases=1
single-writer (scenario) interrupt abortVerdict={"ok":true,"aborted":true}
single-writer restReaders[interruptRest]={registry:0,listRunning:0,runningApi:0,lease:0,heartbeat:0,overview:0} ledger=0 turnLeases=0
single-writer activeReaders[unattended]={registry:1,listRunning:1,runningApi:1,lease:1,heartbeat:1,overview:1} ledger=1 turnLeases=1
single-writer restReaders[unattendedRest]={registry:0,listRunning:0,runningApi:0,lease:0,heartbeat:0,overview:0} ledger=0 turnLeases=0
single-writer activeReaders[dispatcherActive]={registry:1,listRunning:1,runningApi:1,lease:1,heartbeat:1,overview:1} ledger=1 turnLeases=1
single-writer restReaders[dispatcherActiveRest]={registry:0,listRunning:0,runningApi:0,lease:0,heartbeat:0,overview:0} ledger=0 turnLeases=0
single-writer restReaders[dispatcherRest]={registry:0,listRunning:0,runningApi:0,lease:0,heartbeat:0,overview:0} ledger=0 turnLeases=0
single-writer restReaders[processExitRest]={registry:0,listRunning:0,runningApi:0,lease:0,heartbeat:0,overview:0} ledger=0 turnLeases=0
single-writer (a) activeSamples=8 activeAllTrue=8 activeDivergence=0
single-writer (b) restSamples=9 restAllFalse=9 restDivergence=0 disagreementSamples=0
single-writer (c) gapWindowSamples=2 preInitActiveSamples=2 gapSamples=0
single-writer (d) claimedWhileActive=0 sendCallsWhileActive=0 claimedAtRest=1 claimedSecondRun=0 sendCalls=1
single-writer (e) leaseHeldAtRest=0
single-writer [readings] elapsed=501ms
```

（`leaseSamples` 一行逐字：`["idleCold:1(p)","idleCold:0","idleWarm:1(p)","idleWarm:0","mergeOpener:1(p)","gap#1:2(p)","gap#2:2(p)","merged:2(p)","mergedRest:0","fold:2(p)","foldRest:0","interrupt:1(p)","interruptRest:0","unattended:1(p)","unattendedRest:0","dispatcherActive:1(p)","dispatcherActiveRest:0","dispatcherRest:0"] leaseProjectionMismatches=0`，`(p)` = 该点账本谓词为真。）

**(c) 腿的窗口取的是「排空合并」那一格**：opener 的 `RESULT` 已到、它的 run 已终态，而 CLI 已接手的两条 `later`（B、C）的 `system/init` 被判据按住不放——这正是「send 已被接受、`init` 尚未到达」在已落地的 run 即 turn 上的真实形态（空闲冷发在 run=turn 下 dispatch 即铸 run，没有空档可钉）。

### (f) 取假形态（逐字，判据文件一字未动）

**(f-i) `isProcessing` 改回只认 run 的 `status`** —— 临时代码（`chat-run-registry.service.ts`）：

```ts
    isProcessing(appSessionId: string): boolean {
      // FALSE FORM (f-i): the run's own status only.
      return runs.get(appSessionId)?.status === 'running';
    },
```

```
$ npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/processing-single-writer.test.ts
single-writer (a) activeSamples=8 activeAllTrue=8 activeDivergence=0
single-writer (b) restSamples=9 restAllFalse=9 restDivergence=0 disagreementSamples=0
single-writer (c) gapWindowSamples=2 preInitActiveSamples=0 gapSamples=2
single-writer (d) claimedWhileActive=0 sendCallsWhileActive=0 claimedAtRest=1 claimedSecondRun=0 sendCalls=1
single-writer (e) leaseHeldAtRest=0
  AssertionError [ERR_ASSERTION]: no reader may read idle while a send is accepted and its init is held back (read 2)
EXIT=1
```

红落在 (c) 腿自己的读数上（`preInitActiveSamples=0 gapSamples=2`），(a)/(b)/(d)/(e) 全绿——**不是别的腿先红**。

**(f-ii) 一个读者读回旧闩锁** —— 临时代码（`mcp-overview-tools.ts`，运行集合从 `listRunningRuns()` 换回「有 run 记录就算在处理」）：

```ts
  const running: McpOverviewRunning[] = deps.runs
    // FALSE FORM (f-ii): this reader keeps its old latch — a session's run record
    // counts as processing even after it completed.
    .listRecentRuns()
    .map((run) => {
```

```
$ npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/processing-single-writer.test.ts
single-writer (a) activeSamples=8 activeAllTrue=8 activeDivergence=0
single-writer (b) restSamples=9 restAllFalse=0 restDivergence=9 disagreementSamples=9
single-writer (c) gapWindowSamples=2 preInitActiveSamples=2 gapSamples=0
single-writer (d) claimedWhileActive=0 sendCallsWhileActive=0 claimedAtRest=1 claimedSecondRun=0 sendCalls=1
single-writer (e) leaseHeldAtRest=0
  AssertionError [ERR_ASSERTION]: every rest sample must read all six false/empty (divergences 9)
EXIT=1
```

红落在 (b) 腿的 `restDivergence>0` 上（9/9 个静止采样点分歧），(a)/(c)/(d)/(e) 全绿。两条假形态均已还原（`git diff` 不含该临时代码；还原后复跑判据退出 0）。

### (g) 关态零变化（四个受保护判据逐字未改，各退出 0）

```
$ npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-run-registry.test.ts
ℹ pass 13  ℹ fail 0                                              (exit 0)
$ npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/activity-heartbeat.process.test.ts
✔ a subscribed session is beaten with activity.heartbeat, and a killed server goes silent
✔ the shipped heartbeat defaults are announced to a client at subscribe time
ℹ pass 2  ℹ fail 0                                               (exit 0)
$ npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-control-busy.test.ts
ℹ pass 5  ℹ fail 0                                               (exit 0)
$ npx tsx --tsconfig server/tsconfig.json --test server/modules/scheduled-messages/tests/scheduled-messages.test.ts
ℹ pass 13  ℹ fail 0                                              (exit 0)
```

四个文件均不在 `git diff --name-only develop` 里。开关默认关：`residentRunIsTurn()` 读 `process.env.RESIDENT_RUN_IS_TURN === '1'`，只有 AC-382 / AC-383 / 本条三份判据在自己的模块体里打开它。

### 兄弟判据的连带面（全部复跑为绿）

改动触及 lease 投影与注册表，故逐条复跑：`claude-resident-ledger-invariants`(2)、`claude-resident-cold-head-merge`(2)、`claude-resident-merged-queued-turn`(4)、`claude-resident-interrupt-ledger`(4)、`claude-resident-unattended-after-turns`(3)、`claude-resident-unattended-turn`(1)、`claude-activity-lease-parity`(6)、`claude-resident-idle`(1)、`claude-resident-permissions`(2)、`claude-resident-ondemand-start`(3)、`claude-resident-addressable`(1)、`claude-resident-turn-phase-app-id`(1)、`claude-host-per-run`(7)、`claude-resident-busy-input`(1)、`chat-run-turn-semantics`(2)、`activity-deliveries-snapshot`(2)、`chat-run-by-id`(6)、`lifecycle-mode`(9)、`session-host-bindings`(6)、`session-host-lifecycle`(7)、`session-host-default-wrap`(6) — 全部 exit 0。

`claude-resident-ledger-invariants.test.ts` 的 I6 断言是**唯一**为配合本条而改写的既有判据（Touches 已列）：钉从「lease 数 == openRuns」改为「lease 数 == openRuns + 无人 turn 一条」——投影被扩展，钉子就地跟着扩展，其余断言一字未动（该文件 220 个种子序列仍全绿，`violations=0`，其中 `unattendedTurns=142`）。

### (i) collateral

`find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l` → 立案时 346，被执行时的实测基数为 **353**（S0/S1 五条 + AC-382 + AC-383 各加过一个），本条 +1 = **354**。`server/shared/tests/quay-test-script.test.ts` 的 AC2 pin `known=3 unknown=350` → `known=3 unknown=351`、AC3 pin `known=1 unknown=352` → `known=1 unknown=353`，并改写两处注释里的算术与清单。单文件复跑 `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` → 退出 **0**，`pass 14 fail 0`。`scripts/suite-duration-baseline.tsv` 未动（先量，未破地板）。

### (j) 标准与静态检查

`npx tsc --noEmit -p server/tsconfig.json` → 退出 **0**。判据落 `server/modules/websocket/tests/`；跨模块读只经 barrel（`@/modules/providers/index.js`、`@/modules/mcp-gateway/index.js`、`@/modules/projects/index.js`、`@/modules/database/index.js`、`@/modules/session-hosts/index.js`），同模块（websocket）内按兄弟判据的既有写法走服务文件路径，`scheduled-messages` 无 barrel 导出该动词故沿用其判据自身的路径；无 `any`。
