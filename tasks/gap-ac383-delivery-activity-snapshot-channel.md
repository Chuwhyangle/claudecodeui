---
id: gap-ac383-delivery-activity-snapshot-channel
title: AC-383 delivery 状态通道（S2）：activity 快照带 deliveries[]、每次 delivery 变化 rev 恰
  +1 并发 activity.upsert（心跳携带当前 rev）、晚加入者与重连者取完整队列（终态按保留窗 + 每会话 ≤50）、旧
  command_lifecycle 降级为无 runId 无 seq 的会话级帧双发；交付
  server/modules/websocket/tests/activity-deliveries-snapshot.test.ts（五条腿 +
  取假形态）
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
goal_ac: AC-383
---
## Proposal

<!-- dedup-ref --> 机制去重读数（立案时实测，2026-10-16）：`grep -rl '^goal_ac: *AC-383' tasks/*.md` → **0** 命中；全库 `grep -rln 'AC-383' tasks/` → 只命中 `tasks/gap-ac382-run-is-turn-resident-init-minted-run.md`（其正文在「S2 的另两条 `AC-383`、`AC-384` 尚无任务」一句里提到本条，非认领）⇒ 无任何状态（含 todo / ready / needs-human）的任务认领 AC-383。机制词 grep：`activity-deliveries-snapshot` 在 `server/`、`src/` 下 **0** 命中；`DeliveryEntry` 全库 **0** 命中；`deliveries` 在 `server/modules/websocket/` 下 **0** 命中（别处命中全是语音中继与 driver 注释里无关的英文词）⇒ 快照上的 delivery 状态通道尚不存在。合并候选（`node /data/home/yale/.claude/plugins/cache/quay/quay/0.19.0/scripts/dist/task-granularity-advice.js --root /data/home/yale/work/claudecodeui --touches server/modules/websocket/services/activity-protocol.service.ts --touches server/shared/types.ts --touches server/modules/providers/list/claude/claude-host-driver.provider.ts --touches server/modules/websocket/tests/activity-deliveries-snapshot.test.ts --json`）报 `peers: [gap-ac378 (ready), gap-ac380 (todo), gap-ac381 (todo), gap-ac382 (todo)]`，唯一共享文件同为 resident driver（`claude-host-driver.provider.ts`）。判定 **separate**：那四条各有自己的判据文件与独立验收（S1 账本 / interrupt / 无人 turn / run 即 turn），本条是 SPEC §7 的 delivery 状态通道，判据文件 `activity-deliveries-snapshot.test.ts` 与它们全不同；调度器对 Touches 重叠的任务本就按 Touches 串行，合并省不下并行度却把两条 AC 的验收搅在一起。本条对 S1 的先后已在任务层以结构化 `depends_on` 声明（SPEC §12：后一阶段任务不得先于前一阶段出口 AC 落地），正文不复述这层关系。

### 机制（SPEC §4.1、§5.1、§7.1–§7.3、§12 S2、§15）

现状（即 S1 止步处）：activity 协议已经是「每会话单调 `rev` + 每次变更发**整份快照** + 晚加入者订阅即得快照 + `bootId` + 心跳」的形态——`server/modules/websocket/services/activity-protocol.service.ts:41` 的 `ActivityProtocolSnapshot = { sessionId, bootId, rev, asOf, turn, tasks, schedules }`，`recordChange`（:217）是唯一让 rev 前进的入口（每次 +1 并发 `activity.upsert`），`subscribe`（:234）先送一帧 `activity.snapshot`，REST `GET /api/sessions/:id/activity`（`activity.routes.ts:31`）返回同一个 store 的快照，心跳读同一个 rev。**但没有一条通道把 delivery 的状态带给浏览器**：`deliveries` / `DeliveryEntry` 全库 0 命中，「被接受的投递，其终态投影必须抵达正在看的 socket」（`id-relations` B-7）今天靠 writer 受众，重连即丢。

SPEC §7 的修法是**复用**这套协议，而不是新造一条流（§7.2：整份快照天然幂等、重连无需重放、结构性解决 B-7）：

- `ActivityProtocolSnapshot` 增 `deliveries: DeliveryEntry[]`（§7.1），条目十项：`deliveryId`（= `commandUuid`）、`state`（`queued | started | completed | cancelled`）、`source`、`priority`（`later | next | now | null`）、`enqueuedAt`、`startedAt`、`endedAt`、`turnId`、`reason?`（`withdrawn | interrupt | process-exit | owed-terminal-missing`）、`text?`。`text` **只在 queued / started 时携带且长度有界**（默认 ≤ 400 字符）；`turn` 增加 `runId`、`startedAt`（§7.1 末行）。
- 数据源不是新账本：S1（AC-378）已在 driver 内建了 `deliveries: Map<commandUuid, { state, turnId, source, priority, enqueuedAt, startedAt, endedAt, reason? }>`（§5.1）。本条把它**投影**成快照字段：给 `ActivityStoreOptions` 加一个注入读数 `readDeliveries?: (sessionId) => readonly DeliveryEntry[]`，与既有 `readTasks` / `readSchedules` 同形，`buildSnapshot` 照读第四个投影；生产的默认读数由 providers 模块导出（`readSessionDeliveries`），与 `readSessionTasks`（`claude-runtime.provider.ts:1141`）同一位置同一形。
- **rev 恰好 +1**：每次 delivery 状态变化，driver 侧经既有 `setActivityChangeNotifier` 这条 tick（`claude-runtime.provider.ts:1133`，生产由 `server/index.ts:1098` 装成 `(sessionId) => activityStore.recordChange(sessionId)`）**恰好** tick 一次 ⇒ `rev += 1` 且发一帧整份 `activity.upsert`（§7.1 第二条）。心跳携带当前 rev（既有面，`activityAnnouncement` / `resolveActivityHeartbeatConfig`）。
- **保留窗与上限**（§7.1 第三条）：终态条目保留与 run 相同的 `DEFAULT_RUN_RETENTION_MS`（`chat-run-registry.service.ts:174`，5 分钟），每会话**至多 50 条**。排队 / 在飞条目不受这两条约束。
- **旧帧双发**（§7.3）：旧 `command_lifecycle` 帧**继续发**，但降级为**会话级帧**——不带 `runId`、不带 `seq`，且**不进任何 run 的事件缓冲**（`chatRunRegistry` 的 `events` / `lastSeq`，`chat-run-registry.service.ts:420`），因为承载它的「顶替 run」正是 S2 退役的东西。
- 整体是一个开关（`RESIDENT_RUN_IS_TURN`，名称 [P]、由 AC-382 落地时定稿，§12 N-2），默认**关**，回滚即关；关态对外行为逐字节不变（§12 N-1 的精神：既有判据在关态下不得变红）。

### 交付（两件，同一任务）

1. **delivery 状态通道实现**：`server/shared/types.ts` 增 `DeliveryEntry`（分组注释，与 `ChatRunSource`(:3101) / `HostInputPriority`(:3219) 同区）；`activity-protocol.service.ts` 的 `ActivityProtocolSnapshot` 增 `deliveries[]`、`ActivityStoreOptions` 增 `readDeliveries`、`buildSnapshot` 读第四个投影、`turn` 增 `runId` / `startedAt`；driver 把账本投影成 `DeliveryEntry[]`（`text` 有界化、终态保留窗、≤50 上限），并在每次 delivery 状态变化时 tick 一次，导出 `readSessionDeliveries`；旧 `command_lifecycle` 降级为无 `runId` 无 `seq` 的会话级帧。全部置于 `RESIDENT_RUN_IS_TURN` 之后，默认关。
2. **判据文件**（新文件 `server/modules/websocket/tests/activity-deliveries-snapshot.test.ts`，AC-383 判据）：**真实** `createActivityStore`（注入读数 = 钉死的钟、固定 `bootId`、假的 turn/tasks/schedules 投影 + 注入的 `readDeliveries`）+ **真实** `createActivityRouter` 挂真实 express app + 真实 socket（照 `server/modules/websocket/tests/activity-protocol.test.ts` 的装配，晚加入者那条腿走**真 HTTP GET** 而不是直接调 store）+ **真实** `chat-control.service` / `chat-run-registry.service` + 注入的 **scripted fake 进程**（照 `server/modules/providers/tests/claude-resident-merged-queued-turn.test.ts` 的 scripted 臂；**不要**搬那份文件的真实 `claude` 二进制臂），以 `RESIDENT_RUN_IS_TURN` 开运行；装配骨架取 `server/modules/websocket/tests/chat-control-busy.test.ts`（临时 `DATABASE_PATH` + `initializeDatabase` + `sessionsDb.createSession` + 注入 fake runtime，全程不建真实 `WebSocket`）。旧帧降级腿 (d) 的读数取自真实 `chatRunRegistry.listRecentRuns()` / `getRunById(runId).events`，不是 driver 内部读数。

### 与 S2 另两条的关系（为什么本条不替 AC-382 / AC-384 验收）

SPEC §12 把 S2 判给 AC-382 / AC-383 / AC-384，三者共享同一份 S2 实现（N-2「整体、一个开关」），但各有自己的判据文件与独立验收。AC-382 落 **run 即 turn 的注册表 / 帧归属那半加开关本体**（判据 `chat-run-turn-semantics.test.ts`），AC-384 落「**处理中**单一写者」（判据 `processing-single-writer.test.ts`），本条落 **delivery 进 activity 快照的状态通道那半**（判据 `activity-deliveries-snapshot.test.ts`）。实现上若一次把三件事做完，本任务仍**只**验收自己的五条腿。

### 假形态（(e) 为什么承重）

(e-i) 去掉 `started` 时的 rev 递增 ⇒ (b) 腿的 `upsertCount` / `revSequence` 读数必须变红——这正是「状态变了但快照没动」的缺陷签名（`id-relations` B-7 的另一面）。(e-ii) 去掉订阅时的快照 ⇒ (c) 腿的 `lateJoinerQueued` 读数归零（晚加入者读到空队列），即 §7.2 要结构性堵掉的那条。红落在别的腿（超时、更早的断言、别的读数）不算数。

## AC

- [ ] (a) `npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/activity-deliveries-snapshot.test.ts` 退出 **0**（当前必红：文件不存在，文案含 `Could not find`）。同一次运行先打印**形状腿**：`RESIDENT_RUN_IS_TURN` 开的一个会话里驱动一条 delivery 走 `queued → started`，读 `activityStore.snapshot(session)` 的 `deliveries[]` ⇒ 每条条目的键集**恰等于** SPEC §7.1 的十项（`deliveryId`、`state`、`source`、`priority`、`enqueuedAt`、`startedAt`、`endedAt`、`turnId`、`reason`、`text`），`text` 只在 `state ∈ {queued, started}` 时出现、其长度 `<= DELIVERY_TEXT_MAX_CHARS`（默认 400；判据读实现导出的常量，不重打 400）⇒ 读数 `deliveryKeysExact=true textOnQueued>0 textOnCompleted=0 maxTextLen<=cap`，打印读数后再断言。
- [ ] (b) 同一次运行内**rev 腿**：订阅一个监听器后驱动 K 次 delivery 状态变化 ⇒ 除订阅时那一帧 `activity.snapshot` 外**恰**收到 K 帧 `activity.upsert`（`upsertCount=K`），`rev` 逐帧**恰好 +1**（`revSequence=[1..K]` 无洞无跳），每帧体与同刻 `activityStore.snapshot(session)` **逐字相等**（`isDeepStrictEqual`：整份快照，不是增量）；且心跳携带的 rev 等于 store 当前 rev（`heartbeatRev == storeRev`，经既有 `activityAnnouncement` 那条面读）。
- [ ] (c) 同一次运行内**晚加入 / 重连 / 保留窗 / 上限腿**：(c1) 状态变化之后再 `subscribe` ⇒ 第一帧是 `activity.snapshot` 且 `deliveries[]` 含当前队列（`lateJoinerQueued>0`，不是空队列）；(c2) 退订再订阅 ⇒ 排队行与**保留窗内**的终态条目都恢复（`restoredQueuedIds` 与 `restoredTerminalIds` 各按集合相等）；(c3) 把注入的钟推过 `DEFAULT_RUN_RETENTION_MS`（读实现导出的同一常量，判据不重打 5 分钟）后再读快照 ⇒ 超窗终态条目被丢弃、`queued` / `started` 仍在（`droppedTerminal>0 keptLive>0`）；(c4) 灌入 51 条以上终态条目 ⇒ 每会话**恰**留 50 条（`terminalCap=50`，最旧先丢）。
- [ ] (d) 同一次运行内**旧帧降级腿**：同一状态变化仍发旧 `command_lifecycle` 帧，但它**不带 `runId`、不带 `seq`**，且不进任何 run 的事件缓冲——对真实 `chatRunRegistry` 读 `listRecentRuns()` / `getRunById(runId).events` ⇒ `legacyRunId=undefined legacySeq=undefined legacyInRunEvents=0 legacyLastSeqDelta=0`（旧帧不推进任何 run 的 `lastSeq`）。
- [ ] (e) **取假形态可复现**（两条）：(e-i) 去掉 `started` 时的 rev 递增 ⇒ (b) 腿红（`upsertCount` / `revSequence` 读数错，**不是别的腿先红**）；(e-ii) 去掉订阅时的快照 ⇒ (c) 腿红（晚加入者读到空队列，`lateJoinerQueued=0`）。每条用后还原、重跑 (a)–(d) 恢复绿。逐字红态读数、退出码与命令行抄进完成记录，`git diff` 最终不含该临时代码。
- [ ] (f) **开关默认关 + 关态零变化**：`RESIDENT_RUN_IS_TURN` 默认关（实现落地时定名并写进判据读取处，与 AC-382 同一开关）；关态下 `npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/activity-protocol.test.ts`、`... activity-heartbeat.process.test.ts`、`... chat-run-registry.test.ts`、`... chat-control-busy.test.ts` 各退出 **0**，且这四个文件在 `git diff --name-only` 里不出现（若实现上必须改动其中任一文件，在完成记录里逐条列出并说明、不得悄悄让它们变红）。
- [ ] (g) 该判据文件单次运行墙钟 **< 45s**（SPEC §11：goal gate 默认 60 s，须留余量）；每条读数在断言之前先采齐（红要落在错的读数上，不落在超时或更早的腿上）；进程预算守卫照兄弟文件用 `exit 3`（进程级杀，不是单用例失败）。
- [ ] (h) collateral：新增一个 `server/**/*.test.ts` ⇒ **先复量** `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l`（立案时为 347，以执行时实测为准），按 `server/shared/tests/quay-test-script.test.ts` 自身两条计数 pin（立案读数 AC2 的 `known=3 unknown=344`、AC3 的 `known=1 unknown=346`，即 `base+1`）各 +1，并改写其上方注释里的算术（立案读数注释为 `347 - 3 = 344` / `347 - 1 = 346`）；`scripts/suite-duration-baseline.tsv` **仅当** AC7 覆盖率地板跌破 90% 才追加一行（先量，通常不动，免得给 diff 添未声明文件）。单文件复跑 `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0。
- [ ] (i) 遵守 `$backend-module-standards`：判据落 `server/modules/websocket/tests/`、跨模块只经 `index.ts` barrel、无 `any`；`npx tsc --noEmit -p server/tsconfig.json` 退出 0。

## DoD

真实落地判据（不是「测试存在」、也不是「字段存在」）：在交付的树上以 `RESIDENT_RUN_IS_TURN` 开跑 `server/modules/websocket/tests/activity-deliveries-snapshot.test.ts`——它经**真实 `createActivityStore` + 真实 `createActivityRouter`（真 HTTP）+ 真实 `chat-control.service` + 真实 `chat-run-registry.service` + 注入的 scripted fake 进程**：

(a) 一条 delivery 走 `queued → started` ⇒ 快照 `deliveries[]` 的键集恰等于 SPEC §7.1 十项，`text` 只在 queued / started 出现且长度有界；
(b) 每次 delivery 状态变化 ⇒ `rev` **恰 +1** 且发一帧**整份快照** `activity.upsert`（帧体与同刻 REST 快照逐字相等），心跳 rev 与 store rev 相同；
(c) 晚加入者订阅即拿到含当前队列的快照；重连恢复排队行与保留窗内终态；超窗终态被丢弃；每会话 ≤50 条；
(d) 同一变化仍发旧 `command_lifecycle` 帧，但无 `runId`、无 `seq`，且不进任何 run 的事件缓冲、不推进任何 `lastSeq`；
(e) 两条假形态（去 `started` 的 rev 递增 ⇒ (b) 红；去订阅时的快照 ⇒ (c) 红且晚加入者读空队列）可复现，还原后恢复绿——即红的是那条读数本身，判据有洞会被看见；
(f) 开关默认**关**，关态下 `activity-protocol` / `activity-heartbeat.process` / `chat-run-registry` / `chat-control-busy` 四条既有判据逐字不改、各退出 0。

`git diff` 须只含：delivery 状态通道的实现（`server/shared/types.ts`、`server/modules/websocket/services/activity-protocol.service.ts`、`server/modules/providers/list/claude/claude-host-driver.provider.ts`、`server/modules/websocket/services/chat-run-registry.service.ts` 中实际改动者，含 provider 新导出 `readSessionDeliveries` 那一处）、这一个新判据文件、`server/shared/tests/quay-test-script.test.ts` 的两条计数 pin（地板未破时不动 baseline），以及本任务的 task 文件。

## Touches

- `server/shared/types.ts` （新增 `DeliveryEntry`（SPEC §7.1 十项；`text` 仅 queued / started），与 `ChatRunSource`(:3101)、`HostInputPriority`(:3219) 同区分组注释；`DELIVERY_TEXT_MAX_CHARS` 常量若落此处）
- `server/modules/websocket/services/activity-protocol.service.ts` （`ActivityProtocolSnapshot` 增 `deliveries: DeliveryEntry[]`；`ActivityStoreOptions` 增 `readDeliveries`，`buildSnapshot`(:186) 读第四个投影、与 `readTasks` / `readSchedules` 同形；`turn` 增 `runId` / `startedAt`）
- `server/modules/providers/list/claude/claude-host-driver.provider.ts` （把 S1 账本的 deliveries 投影成 `DeliveryEntry[]`——含 `text` 有界化、终态 `DEFAULT_RUN_RETENTION_MS` 保留窗、每会话 ≤50 上限；每次 delivery 状态变化经既有 `setActivityChangeNotifier`（`claude-runtime.provider.ts:1133`）**恰好** tick 一次；导出 `readSessionDeliveries`；旧 `command_lifecycle` 降级为无 `runId` 无 `seq` 的会话级帧）
- `server/modules/websocket/services/chat-run-registry.service.ts` （旧 `command_lifecycle` 帧不进 run 的 `events`(:420)、不推进 `lastSeq`——**仅当** (d) 的落地落在注册表侧；若落在 driver 侧则不动此文件，并在完成记录里说明）
- `server/modules/websocket/tests/activity-deliveries-snapshot.test.ts` （新：AC-383 判据文件——真实 activityStore + 真实 activity router（真 HTTP）+ 真实 chat-control / registry + scripted fake 进程，(a)–(e) 五条腿）
- `server/shared/tests/quay-test-script.test.ts` （collateral：新增一个 server 测试文件 ⇒ AC2 / AC3 两条计数 pin 各 +1，并改写其上方注释的算术）
- `scripts/suite-duration-baseline.tsv` （collateral：仅当 AC7 覆盖率地板被新增文件压破 90% 才追加一行；先量，通常不动）
- `tasks/gap-ac383-delivery-activity-snapshot-channel.md` （自触）
