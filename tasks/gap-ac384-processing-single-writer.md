---
id: gap-ac384-processing-single-writer
title: AC-384「处理中」单写者（S2）：六读者同源于账本——静止后 registry / running 接口 / host turn lease
  / heartbeat / 调度器 / MCP overview 同时为空、活动中同时为真、空闲 send 在 init
  前即处理中、静止后排队消息恰发出一次；交付
  server/modules/websocket/tests/processing-single-writer.test.ts（六条腿 + 两条取假形态）
status: todo
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

SPEC §12 把 S2 判给三条 AC，三者共享同一份 S2 实现（N-2「整体、一个开关」），但各有自己的判据文件与独立验收：run 即 turn 那条落**注册表铸造与帧归属**（判据 `chat-run-turn-semantics.test.ts`），delivery 状态通道那条落**activity 快照**（判据 `activity-deliveries-snapshot.test.ts`），本条落**「处理中」的单一写者与静止后排队消息发出**（判据 `processing-single-writer.test.ts`）。实现上若一次把三件事做完，本任务仍**只**验收自己的六条腿。

### 假形态（(f) 为什么承重）

两条，各自钉住一个不同的缺陷签名：

- **(f-i) 空档形态**：把 `isProcessing` 改回「只认已铸且 running 的 run」（即不算 `pushed`）⇒ (d) 腿的 `preInitActiveSamples` 归零、`gapSamples > 0` 必须变红。这正是 §4.3 那句「不出现空档」要堵的形态。
- **(f-ii) 分歧形态**：让**任意一个**读者（例如 MCP overview 或调度器）继续读自己的旧闩锁（旧的 registry `status` 判定 / 位置账），而其余五个读谓词 ⇒ (c) 腿的 `restDivergence > 0` 必须变红，即「任意两者分歧」。这正是 I6 要根除的形态。

红落在别的腿（超时、更早的断言、别的读数）不算数。两条各自用后还原、重跑恢复绿，`git diff` 最终不含该临时代码。

## AC

- [ ] (a) `npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/processing-single-writer.test.ts` 退出 **0**（当前必红：文件不存在，文案含 `Could not find`）。同一次运行先打印**场景矩阵腿**：对 SPEC §2 的每个场景（空闲冷发、空闲暖发、`later` 忙时两条排空合并、`next` 忙时折叠、interrupt、无人 turn、进程退出）各跑一遍，每场景在**活动中**读六个读者 ⇒ 逐场景读数 `activeReaders[idleCold]={registry:1,listRunning:1,runningApi:1,lease:1,heartbeat:1,overview:1}` 等，并汇总 `activeDivergence=0`（六者在活动中同时为真）。
- [ ] (b) 同一次运行内**静止腿（I1）**：每场景的 turn 关闭后（fake 进程已吐 `RESULT` 且已终态）读同样六者 ⇒ `restReaders={registry:0,listRunning:0,runningApi:0,lease:0,heartbeat:0,overview:0}`，汇总 `restDivergence=0`、`restSamples>=7`（七场景各至少一次）。六者**不得任意两者分歧**：在每个状态跃迁点（每条 lifecycle 帧 / `init` / `RESULT` / send 被接受之后）都采样一次六者，断言 `disagreementSamples=0`（不是只比端点）。
- [ ] (c) 同一次运行内**空档腿（§4.3 的 pushed 窗口）**：fake 进程被一个判据控制的闸门按住，`send` 已被接受但 `system/init` 故意**尚未**到达 —— 从 `send` 返回到放闸之间的每个采样点读六者 ⇒ `preInitActiveSamples>0`（六者全真）、`gapSamples=0`（没有任何一个采样点出现「已接受但读作空闲」）；放闸后 turn 正常开合。读数逐点打印后再断言。
- [ ] (d) 同一次运行内**调度器腿（SPEC §1.4 第二条）**：在隔离库里写入一条持久化的排队消息（`sessionDraftsDb` 的 queued 行，照 `scheduled-messages.test.ts` 的装配），(d1) 会话**静止**时跑一次 `dispatchQueuedMessages` ⇒ `claimedAtRest=1`、控制服务的 `send` 恰被调用一次（`sendCalls=1`）；(d2) 紧接着再跑一次 ⇒ `claimedSecondRun=0`、`sendCalls` 仍为 **1**（恰好一次）；(d3) 会话**活动中**（一个在飞 turn）跑一次 ⇒ `claimedWhileActive=0`（账本说处理中时仍不抢跑）。三条读数在断言前先采齐。
- [ ] (e) 同一次运行内**单写者同源腿**：对六个读者的读取路径各打 spy / 打桩（例如 `chatRunRegistry.isProcessing`、`listRunningRuns`、`sessionsService.listRunningSessions`、host `addLease`/`removeLease`、heartbeat 帧的 `isProcessing`、`mcp-overview-tools` 的运行集合读数、调度器门），在一个完整场景里断言六者读到的是**同一个**谓词取值：`readersAgreeOnEveryTransition=true`，且 host 侧 `turn` lease 的加/减次数在整场景内等于账本谓词的跃迁次数（`leaseAdds==ledgerOpenEdges`、`leaseRemoves==ledgerCloseEdges`），静止后 `leaseHeld=0`。
- [ ] (f) **取假形态可复现**（两条）：(f-i) 把 `isProcessing` 改回只认已铸且 running 的 run（不算 `pushed`）⇒ (c) 腿红（`preInitActiveSamples=0 gapSamples>0`，**不是别的腿先红**）；(f-ii) 让任意一个读者（MCP overview 或调度器）继续读旧的闩锁 ⇒ (b) 腿红（`restDivergence>0`）。每条用后还原、重跑 (a)–(e) 恢复绿。逐字红态读数、退出码与命令行抄进完成记录，`git diff` 最终不含该临时代码。
- [ ] (g) **开关默认关 + 关态零变化**：`RESIDENT_RUN_IS_TURN` 默认关（实现落地时定名并写进判据读取处，与 S2 另两条同一开关）；关态下 `npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-run-registry.test.ts`、`... activity-heartbeat.process.test.ts`、`... chat-control-busy.test.ts`、`... server/modules/scheduled-messages/tests/scheduled-messages.test.ts` 各退出 **0**，且这四个文件在 `git diff --name-only` 里不出现（若实现上必须改动其中任一文件，在完成记录里逐条列出并说明、不得悄悄让它们变红）。
- [ ] (h) 该判据文件单次运行墙钟 **< 45s**（SPEC §11：goal gate 默认 60 s，须留余量）；每条读数在断言之前先采齐（红要落在错的读数上，不落在超时或更早的腿上）；进程预算守卫照兄弟文件用 `exit 3`（进程级杀，不是单用例失败）。
- [ ] (i) collateral：新增一个 `server/**/*.test.ts` ⇒ **先复量** `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l`（立案时为 346，以执行时实测为准——S2 另两条也会各加一个，须按当场读数改写），按 `server/shared/tests/quay-test-script.test.ts` 自身两条计数 pin（立案读数 AC2 的 `known=3 unknown=343`、AC3 的 `known=1 unknown=345`，即 `base+1`）各 +1，并改写其上方注释里的算术；`scripts/suite-duration-baseline.tsv` **仅当** AC7 覆盖率地板跌破 90% 才追加一行（先量，通常不动）。单文件复跑 `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0。
- [ ] (j) 遵守 `$backend-module-standards`：判据落 `server/modules/websocket/tests/`、跨模块只经 `index.ts` barrel、无 `any`；`npx tsc --noEmit -p server/tsconfig.json` 退出 0。

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
- `server/modules/providers/list/claude/claude-host-driver.provider.ts` （账本（`deliveries` / `turn` / `foreign`）导出 `processing` 与未终态集合读数；5 处手工 lease 配平（`:2487`、`:3048`、`:3559`、`:4662`、`:4697`）改为账本重算后驱动 `leaseAdded` / `leaseRemoved`（§5.4））
- `server/modules/session-hosts/session-host-manager.service.ts` （`turn` lease 只作投影落点：`deriveState`(:590) / `addLease`(:914) / `removeLease`(:915) 的输入由账本重算给出，不再由 driver 手工加减；静止后 `leaseHeld=0`）
- `server/modules/websocket/services/activity-heartbeat.service.ts` （heartbeat 的 `isProcessing`(:141) 读同一谓词，不再自行判定）
- `server/modules/websocket/services/chat-websocket.service.ts` （`:1637` 的 heartbeat 接线改读同一谓词）
- `server/modules/providers/services/sessions.service.ts` （`listRunningSessions`(:325) 同源；条目形状不变，`startedAt` 按 §4.3 取 turn 开始或最早未终态 delivery 的接受时刻）
- `server/modules/mcp-gateway/mcp-overview-tools.ts` （overview 运行集合(:423) 同源）
- `server/modules/scheduled-messages/services/scheduled-message-dispatcher.service.ts` （`dispatchQueuedMessages` 的 `isProcessing` 门同源——§1.4 第二条）
- `server/modules/websocket/tests/processing-single-writer.test.ts` （新：AC-384 判据文件——真实 chat-control + 真注册表 + 真 host lease 读数 + 真 heartbeat 装配 + 真调度器 + scripted fake 进程，(a)–(f) 六条腿）
- `server/shared/tests/quay-test-script.test.ts` （collateral：新增一个 server 测试文件 ⇒ AC2 / AC3 两条计数 pin 各 +1，并改写其上方注释的算术）
- `scripts/suite-duration-baseline.tsv` （collateral：仅当 AC7 覆盖率地板被新增文件压破 90% 才追加一行；先量，通常不动）
- `tasks/gap-ac384-processing-single-writer.md` （自触）
