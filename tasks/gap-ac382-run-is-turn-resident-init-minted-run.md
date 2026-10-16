---
id: gap-ac382-run-is-turn-resident-init-minted-run
title: AC-382 run 即 turn（S2）：resident 的 run 在 init 由账本铸造、折叠与排空合并的 delivery 共享同一个
  run、帧只进该 run、退役 supersedeRunning；交付
  server/modules/websocket/tests/chat-run-turn-semantics.test.ts（八条腿 + 取假形态）
status: done
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
goal_ac: AC-382
---
## Proposal

<!-- dedup-ref --> 机制去重读数（立案时实测，2026-10-16）：`grep -rl '^goal_ac: *AC-382' tasks/*.md` → **0** 命中；全库 `grep -rln 'AC-382' tasks/` → **0** 命中 ⇒ 无任何状态（含 todo / ready / needs-human）的任务认领 AC-382。机制词 grep：`chat-run-turn-semantics` 在 `server/`、`src/` 下 **0** 命中（只命中 `docs/proposals/resident-delivery-turn-ledger-SPEC.md` 与 goal 记录自身）；`RESIDENT_RUN_IS_TURN` 只命中 SPEC §12 那一行（开关名仍是 [P]，S2 定稿），实现里尚不存在；`deliveryIds` 全库 **0** 命中。同 SPEC 的兄弟任务各有自己的判据文件与独立验收：`gap-ac377-cold-head-arm-stamp-and-fixture`（S0 热修）、`gap-ac378-ledger-invariants-property-test`（S1 账本 + 性质测试）、`gap-ac379-cli-contract-sentinel`（S1 契约哨兵）、`gap-ac380-interrupt-ledger-no-residue`、`gap-ac381-unattended-after-turns`；S2 的另两条 `AC-383`、`AC-384` 尚无任务。合并候选（`node /data/home/yale/.claude/plugins/cache/quay/quay/0.19.0/scripts/dist/task-granularity-advice.js --root /data/home/yale/work/claudecodeui --touches server/modules/websocket/services/chat-run-registry.service.ts --touches server/modules/websocket/services/chat-websocket.service.ts --touches server/modules/providers/list/claude/claude-host-driver.provider.ts --touches server/modules/websocket/tests/chat-run-turn-semantics.test.ts --json`）报 `peers: [gap-ac377 (ready), gap-ac378 (ready), gap-ac380 (todo), gap-ac381 (todo)]`，唯一共享文件同为 resident driver。判定 **separate**：那四条是 S0 / S1 的账本与哨兵，本条是 SPEC §6 的 S2 语义翻转，有独立判据文件；调度器对 Touches 重叠的任务本就按 Touches 串行，合并省不下并行度却把两个阶段的验收搅在一起。本条对 S1 的先后已在任务层以结构化 `depends_on` 声明（SPEC §12：后一阶段任务不得先于前一阶段出口 AC 落地），正文不复述这层关系。

### 机制（SPEC §1.2、§6.1–§6.4、§12 S2）

现状（即 S1 止步处）run 的身份仍是「两本账靠位置对账」：注册表每次 send 开一个 run（`server/modules/websocket/services/chat-run-registry.service.ts` 的 `startRun`，:508），resident driver 用 `state.rounds[]` FIFO（`server/modules/providers/list/claude/claude-host-driver.provider.ts`），帧发给 `state.rounds[0].writer`（`permissionWriter`，:4231），`result` 只 `shift()` 一个 round。resident 会话的忙时 send 走的是**顶替**那条路：`server/modules/websocket/services/chat-websocket.service.ts:804` 先探 `startRun`（返回 `null` 表示已有 run），`acceptsBusyInput` 说可以（resident 为真，`server/modules/providers/services/provider-runtime.service.ts:771`），于是 `:817` 用 `supersedeRunning: true` 再开一个 run 去顶掉会话槽位——这正是本条要退役的那半（守卫与它上面那段解释见 `chat-run-registry.service.ts:485-537`）。这不是笔误，而是「注册表一会话一 run」在 resident 上的唯一绕法；但它同时生产了现场看到的稳态：每条命令一个 run，CLI 把后来的命令折进同一个 turn 时，`queued` / `started` 落在前一条的 run、`completed` 落在自己的 run（SPEC §1.2），于是某个 run 永久 `running`、`turn` lease 一直挂着，界面底部 `Working…` 差一格不消失。

SPEC §6 的 S2 修法——**run 即 turn**：

- resident：run 在 `init` 时由账本经 host sink 铸造（`openTurn`，取代今天只服务无人 turn 的 `openUnattendedRun`：`server/modules/session-hosts/session-host-manager.service.ts:1546`，接线在 `server/index.ts:1049` 的 `setUnattendedRunOpener`），在 `RESULT` 时终结；折叠与排空合并进来的 delivery **共享同一个 run**（§6.1）。无人 turn 判定的 I5 读数由 S1 给出，本条只改铸造时机与归属。
- `ChatRun` 增加 `kind`（`delivered` / `unattended`）与 `deliveryIds[]`；`getRun(session)` = 开着的 turn，无则最近一个；`getRunById` 对 turn 语义不变（§6.1）。
- `correlationId` 与 `source` 归 **delivery**；`sessions/running` 条目的 `correlationId` 取 owner delivery 的值（兼容）。`ChatRunSource` 类型在 `server/shared/types.ts:3101`。
- **退役 `supersedeRunning`**：忙时 send 不再开顶替 run，只产生一个 **delivery**；`acceptsBusyInput` 那条「可以接」的答案仍在，但它换来的是一个 delivery 而不是一个新 run。§6.3：`chat.abort` 只向 CLI 请求 interrupt，不直接摘 lease 或关 run，活动坞在 RESULT 到达后清除。
- per-run provider **不变**：`startRun` 仍在 dispatch 时铸造，delivery 与 turn 同时产生，1:1（§6.1）。
- 帧归属：S2 起帧发给 **turn 的 run**（§6.2），不再发给某个 owner delivery 的 run；§6.4 的游标规则（`seq` 按 turn 编号、`ack.runId ≠ cursor.runId` 时复位，`replayCursor.ts`）原样成立。
- 整体一个开关 `RESIDENT_RUN_IS_TURN`（名称 [P]，落地时定稿并同时写进实现与判据），默认**关**，回滚即关（§12 N-2）。

### 交付（两件，同一任务）

1. **S2 的 run=turn 实现**（`chat-run-registry.service.ts` 加 `kind` / `deliveryIds` 与 `openTurn`；`chat-websocket.service.ts` 忙时 send 改为产生 delivery、不再 `supersedeRunning`；`claude-host-driver.provider.ts` 在 `init` 铸 run 并把帧路由到自己 turn 的 run writer，`RESULT` 终结；`session-host-manager.service.ts` / `server/index.ts` 的 host sink 从 `openUnattendedRun` 泛化为 `openTurn`）。全部置于 `RESIDENT_RUN_IS_TURN` 之后，默认关——关闭时对外行为逐字节不变（SPEC §12 N-1 的精神：既有判据在关态下不得变红）。
2. **判据文件**（新文件 `server/modules/websocket/tests/chat-run-turn-semantics.test.ts`，AC-382 判据）：**真实** `chat-control.service.ts` + **真实** `chat-run-registry.service.ts` + 注入的 **scripted fake 进程**，以 `RESIDENT_RUN_IS_TURN` 开运行。骨架取 `server/modules/websocket/tests/chat-control-busy.test.ts` 的装配（临时 `DATABASE_PATH` + `initializeDatabase` + `sessionsDb.createSession` + 注入 fake runtime，全程不建 `WebSocket`），scripted 帧序列照 `server/modules/providers/tests/claude-resident-merged-queued-turn.test.ts` 的 scripted 臂（真 driver、真 writer、`driver.busyInputReading()`、`listRunningRuns()`）；**不要**搬那份文件的真实 `claude` 二进制臂。帧归属读数取自 writer 的 per-run 事件日志（`chatRunRegistry.getRunById(runId)` 的 `events` / `lastSeq`），不是 driver 内部 FIFO。

### S2 的拆分说明（为什么本条不替 AC-383 / AC-384 验收）

SPEC §12 把 S2 判给 AC-382 / AC-383 / AC-384，三者共享同一份 S2 实现（N-2「整体、一个开关」），但各有自己的判据文件与独立验收。本任务落 **run 即 turn 的注册表 / 帧归属那半加开关本体**，判据文件是 `chat-run-turn-semantics.test.ts`；AC-383（delivery 进 activity 快照，`activity-deliveries-snapshot.test.ts`）与 AC-384（「处理中」单一写者，`processing-single-writer.test.ts`）的判据文件与本条不同。实现上若一次把三件事做完，本任务仍**只**验收自己的八条腿——另两条腿由各自的判据文件承担。

### 假形态（(h) 为什么承重）

(e) 腿是本条的承重腿：把帧路由临时改回 `state.rounds[0].writer`（S1 行为）⇒ 折叠 / 排空合并的 delivery 的帧会落到自己 run 之外的 writer 上 ⇒ (e) 的 `framesWithForeignRunId` 读数必须变红。这正是现场缺陷的签名（SPEC §1.2 的稳态）。红落在别的腿（超时、更早的断言、别的读数）不算数。

## AC

- [x] (a) `npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-run-turn-semantics.test.ts` 退出 **0**（当前必红：文件不存在，文案含 `Could not find`）。同一次运行先打印**空闲 send 腿**：`RESIDENT_RUN_IS_TURN` 开的会话静态时一次 `chat.send`（经真实 `chatControlService.send` 落到真实 `chatRunRegistry`）⇒ 读到 `idleTurns=1 idleRuns=1`，且该 run `kind=delivered`、`deliveryIds` 恰含这条 send 的 delivery id。
- [x] (b) 同一次运行内**忙时 later 排空合并腿**：一个在飞 turn 内先后两条 `later` priority 的忙时 send，scripted fake 进程按 SPEC §2 C-4 吐帧（一个 `init` + 一个 `RESULT`，两条命令被 CLI 排空合并进同一个 turn）⇒ 读数 `mergedRuns=1`（这条路径**只**铸一个 run）、`mergedDeliveryIds=2`（该 run 的 `deliveryIds` 恰含这两条 send 的 id，集合相等）、两条 delivery 各自终态独立且断言按**集合**而非顺序（`mergedOrderIrrelevant=true`）。
- [x] (c) 同一次运行内**next 折叠腿**：在飞 turn 内一条 `next` priority 的 send ⇒ 不新铸 run（`nextRunsAdded=0`），该 delivery 绑定到**开着的 turn 的 run**（`nextDeliveryRunId == openTurnRunId`，逐字相等）。
- [x] (d) 同一次运行内**无人 turn 腿**：无任何 send 时 CLI 自起一个 turn（`init` … `RESULT`，`init` 的 uuid 不在 `pushedUuids`）⇒ 开出的 run `source=unattended`、`deliveryIds` 为空（`unattendedRunSource=unattended unattendedDeliveryIds=0`）。
- [x] (e) 同一次运行内**帧归属腿**（承重）：逐 run 读 writer 的事件日志 ⇒ 每个 run 的所有帧都带自己的 `runId`（`framesWithForeignRunId=0`）、每个 run 的 `seq` 从 1 连续无洞（`seqGaps=0`）；读数取自 `chatRunRegistry.getRunById(runId).events` 的 `runId` / `seq`，不是 driver 内部读数。
- [x] (f) 同一次运行内**spy 计数腿**：对 `chatRunRegistry.startRun` 打 spy，跑完 (a)–(d) 后断言对 resident 会话带 `supersedeRunning: true` 的调用次数为 **0**（`supersedeRunningCalls=0`，打印读数后再断言）；同时打印总 `startRun` 调用次数与铸出的 run 数关系（`startRunCalls == runsMinted`）。
- [x] (g) 同一次运行内**per-run provider 腿**：`acceptsBusyInput` 为假的 provider（调试 agent 的按次进程）一次 send ⇒ 一个 delivery 一个 run（`perRunDeliveries=1 perRunRuns=1`），且忙时第二条被以 `RUN_IN_PROGRESS` 拒（不因 run=turn 改动而放开）。
- [x] (h) **取假形态可复现**：把帧路由临时改回 `state.rounds[0].writer`（S1 行为），判据文件一字不动重跑 ⇒ 退出**非 0**，且红落在 (e) 腿的 `framesWithForeignRunId` 读数上（**不是别的腿先红**）；用后还原、重跑 (a)–(g) 恢复绿。逐字红态读数、退出码与命令行抄进完成记录，`git diff` 最终不含该临时代码。
- [x] (i) **开关默认关 + 关态零变化**：`RESIDENT_RUN_IS_TURN` 默认关（实现落地时定名并写进判据读取处）；关态下 `npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-run-registry.test.ts`、`... chat-run-by-id.test.ts`、`... chat-control-busy.test.ts`、`... chat-control-send.test.ts` 各退出 **0**，且这四个文件在 `git diff --name-only` 里不出现（若实现上必须改动其中任一文件，在完成记录里逐条列出并说明、不得悄悄让它们变红）。
- [x] (j) 该判据文件单次运行墙钟 **< 45s**（SPEC §11：goal gate 默认 60 s，须留余量）；每条读数在断言之前先采齐（红要落在错的读数上，不落在超时或更早的腿上）；进程预算守卫照兄弟文件用 `exit 3`（进程级杀，不是单用例失败）。
- [x] (k) collateral：新增一个 `server/**/*.test.ts` ⇒ **先复量** `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l`（立案时为 346，以执行时实测为准），按 `server/shared/tests/quay-test-script.test.ts` 自身两条计数 pin（AC2 的 `known=3 unknown=343`、AC3 的 `known=1 unknown=345`，即 `base+1`）各 +1，并改写其上方注释里的算术；`scripts/suite-duration-baseline.tsv` **仅当** AC7 覆盖率地板跌破 90% 才追加一行（先量，通常不动，免得给 diff 添未声明文件）。单文件复跑 `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0。
- [x] (l) 遵守 `$backend-module-standards`：判据落 `server/modules/websocket/tests/`、跨模块只经 `index.ts` barrel、无 `any`；`npx tsc --noEmit -p server/tsconfig.json` 退出 0。

## DoD

真实落地判据（不是「测试存在」、也不是「开关存在」）：在交付的树上以 `RESIDENT_RUN_IS_TURN` 开跑 `server/modules/websocket/tests/chat-run-turn-semantics.test.ts`——它经**真实 `chat-control.service` + 真实 `chat-run-registry.service` + 注入的 scripted fake 进程**：

(a) 空闲 send ⇒ 一个 turn、一个 run，run `kind=delivered` 且 `deliveryIds` 含该 send；
(b) 忙时两条 `later` send 被 CLI 排空合并进同一个 turn ⇒ **仅一个 run**，其 `deliveryIds` 恰含这两条，两条 delivery 终态独立、先后任意（按集合断言）；
(c) `next` 折叠 ⇒ **不新铸 run**，delivery 绑定到开着的 turn 的 run；且全程对 resident 会话 `startRun({supersedeRunning:true})` 的 **spy 计数为 0**；
(d) 无人 turn（`init` 的 uuid 不在 `pushedUuids`）⇒ 开出的 run `source=unattended`、`deliveryIds` 为空；
(e) **每个 run 的所有帧都带自己的 `runId`、`seq` 从 1 连续、没有任何帧带别的 turn 的 runId** —— 读数取自 writer 的 per-run 事件日志；
(f) per-run provider 仍是**一个 delivery 一个 run**（1:1），忙时第二条照旧被拒；
(g) **假形态**：把帧路由改回 `rounds[0]` 的 writer 后，(e) 腿的 `framesWithForeignRunId` 必须变红、还原后恢复绿——即红的是那条读数本身，判据有洞会被看见；
(h) 开关默认**关**，关态下既有 `chat-run-registry` / `chat-run-by-id` / `chat-control-busy` / `chat-control-send` 四条判据逐字不改、各退出 0。

`git diff` 须只含：S2 的 run=turn 实现（`chat-run-registry.service.ts`、`chat-websocket.service.ts`、`claude-host-driver.provider.ts`、`session-host-manager.service.ts`、`server/index.ts` 中实际改动者）、这一个新判据文件、`server/shared/tests/quay-test-script.test.ts` 的两条计数 pin（地板未破时不动 baseline），以及本任务的 task 文件。

## Touches

- `server/modules/websocket/services/chat-run-registry.service.ts` （`ChatRun` 加 `kind` / `deliveryIds`；`openTurn` 铸造取代 `openUnattendedRun` 的唯一用途；`getRun(session)` = 开着的 turn；`supersedeRunning` 退役）
- `server/modules/websocket/services/chat-websocket.service.ts` （resident 忙时 send 改为产生一个 delivery、不再 `startRun({supersedeRunning:true})` 顶替）
- `server/modules/providers/list/claude/claude-host-driver.provider.ts` （`init` 时铸 run（delivered / unattended 两态）、帧路由到自己 turn 的 run writer、`RESULT` 终结；`rounds[0].writer` 路由退役）
- `server/modules/session-hosts/session-host-manager.service.ts` （host sink 从 `openUnattendedRun` 泛化为 `openTurn`）
- `server/index.ts` （`setUnattendedRunOpener` 接线更名为 `openTurn`）
- `server/modules/websocket/tests/chat-run-turn-semantics.test.ts` （新：AC-382 判据文件——真实 chat-control + 真实注册表 + scripted fake 进程，(a)–(g) 七条腿）
- `server/shared/tests/quay-test-script.test.ts` （collateral：新增一个 server 测试文件 ⇒ AC2 / AC3 两条计数 pin 各 +1，并改写其上方注释的算术）
- `scripts/suite-duration-baseline.tsv` （collateral：仅当 AC7 覆盖率地板被新增文件压破 90% 才追加一行；先量，通常不动）
- `tasks/gap-ac382-run-is-turn-resident-init-minted-run.md` （自触）

## Evidence

完成记录（2026-10-16，worker 在 worktree `gap-ac382-run-is-turn-resident-init-minted-run` 上执行；实现提交 `0af347562`）。

### 判据命令与读数

`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-run-turn-semantics.test.ts` → 退出 **0**，`pass 2 fail 0`，墙钟 **< 1s**（预算守卫 `exit 3` @44s，实测 elapsed≈0.5s）。同一次运行的逐字读数：

```
(a) idleSend={"ok":true,...} idleDeliveryId=<uuid> ; idleTurns=1 idleRuns=1 kind=delivered deliveryIds=["<该 send 的 delivery id>"] status=completed
(b) queuedTiers=["later","later"] ; mergedRuns=1 mergedRunId=<uuid> mergedDeliveryIds=[<B>,<C>] mergedOrderIrrelevant=true
(b) mergedDeliveryStates=["<B>:completed","<C>:completed"]   （两条各自终态独立）
(c) nextRunsAdded=0 nextDeliveryRunId=<uuid> openTurnRunId=<同一 uuid>
(d) unattendedRunSource=unattended kind=unattended unattendedDeliveryIds=0
(e) run=<idle> deliveries=1 frames=3 | run=<t2> deliveries=1 frames=2 | run=<t2-merged> deliveries=2 frames=3 |
    run=<t3> deliveries=2 frames=4 | run=<unattended> deliveries=0 frames=3 | run=<per-run> deliveries=1 frames=0
(e) framesWithForeignRunId=0 seqGaps=0 markersInRuns=10 markersEmitted=10 runsWithFrames=5 lastSeqMismatches=0 framesWithWrongRunIdField=0
(f) supersedeRunningCalls=0 startRunCalls=6 runsMinted=6 registryRuns=6
(g) perRunDeliveries=1 perRunRuns=1 runCalls=1->1 ; perRunSecond={"ok":false,"code":"RUN_IN_PROGRESS",...}
```

### (h) 取假形态（逐字）

命令不变。临时代码（`claude-host-driver.provider.ts` 的帧路由，去掉 `state.turnRun` 那一臂 ⇒ 即 S1 的 `state.rounds[0].writer` 行为）：

```
const frameWriter = state.unattended?.writer ?? round?.writer ?? state.writer;
```

逐字红态读数与退出码（**判据文件一字未动**，退出码 **1**）：

```
(e) run=<t2 的 run> … frames=4      ← 自己的 2 帧 + 被误路由进来的合并 turn 的 2 帧
(e) run=<merged 的 run> … frames=1
(e) framesWithForeignRunId=2 seqGaps=0 markersInRuns=10 markersEmitted=10 runsWithFrames=5
✖ AssertionError: no frame may be recorded in a run that does not cover its turn (read 2)
ℹ pass 1 ℹ fail 1   → 退出码 1
```

红**只**落在 (e) 腿的 `framesWithForeignRunId`：(a)(b)(c)(d)(f)(g) 与更早的读数全绿，红不落在超时或更早的腿上。还原后重跑 ⇒ `pass 2 fail 0`、退出码 0；`git diff` 最终不含该临时代码（还原后与备份逐字节比对一致）。

### (i) 关态零变化

`RESIDENT_RUN_IS_TURN` 默认关（读取处 `process.env.RESIDENT_RUN_IS_TURN === '1'`，**调用时**读，不缓存）。关态下四个文件各退出 0，且均不在 `git diff --name-only develop...HEAD` 里：`chat-run-registry.test.ts` 13 pass、`chat-run-by-id.test.ts` 6 pass、`chat-control-busy.test.ts` 5 pass、`chat-control-send.test.ts` 4 pass。兄弟判据同绿：`claude-resident-unattended-turn`(1) / `-cold-head-merge`(2) / `-ledger-invariants`(2) / `-unattended-after-turns`(3) / `-interrupt-ledger`(4)、`session-host-*`、`chat-control-wiring`(3) / `-access`(4)。

### (k) collateral

`find server \( -name '*.test.ts' -o -name '*.test.js' \) | grep -v node_modules | wc -l` → **352**（立案时记 346；执行时树上已因兄弟任务增至 351，本条 +1 ⇒ 352）。`quay-test-script.test.ts` 两条 pin 改为 AC2 `known=3 unknown=349`、AC3 `known=1 unknown=351`，并改写其上方注释的算术；单文件复跑 14 pass / 0 fail。`scripts/suite-duration-baseline.tsv` **未动**（AC7 覆盖率地板仍满足）。

### (l) 模块规范

判据落 `server/modules/websocket/tests/`；跨模块只经 `@/modules/database|providers|session-hosts` 的 `index.ts` barrel（同模块服务文件直引）；无 `any`。`npx tsc --noEmit -p server/tsconfig.json` 退出 0。

### 与 AC 文本的两处偏差（逐条说明，不悄悄变红）

1. **(e) 的事件读数取自新加的 `chatRunRegistry.readRun(runId)`**（返回该 run 的 `kind` / `deliveryIds` / `events` / `lastSeq` 副本），不是 `getRunById(runId).events`：`chat-run-by-id.test.ts`（AC (i) 要求逐字不改）把 `ChatRunSummary` 钉在**恰好七个字段**上，`events` 加不进那个投影。`getRunById(runId).lastSeq` 仍在同一次运行内一并读并断言与 `readRun` 一致（`lastSeqMismatches=0`）。
2. **(e) 的「别的 turn 的 runId」按 turn 归属判定**：注册表记录事件时总盖上该 run 自己的 `runId`（结构性成立 ⇒ 直接读 `runId` 字段无法区分取假形态）。判据把「每个 marker 属于哪条腿」与「run 的 `deliveryIds` 经 driver 账本 join 到的 turn」对照，`framesWithForeignRunId` 数的是「落在不覆盖该 turn 的 run 里」的帧；取假形态证明这条读数确实能红。`runId` 字段本身也单独计数并断言为 0（`framesWithWrongRunIdField=0`）。

### 实现要点

- `ChatRun` 加 `kind`（`delivered`/`unattended`）与 `deliveryIds[]`；`openTurn` 对交付的 turn **收养** dispatch 已铸的 run（或为「CLI 把排空命令合并成的 turn」铸一个），对无人 turn 铸 `deliveryIds: []` 的 unattended run。
- 忙时 send 在开关下**不再铸 run**：`dispatchRun` 用 `getRun` 读判（而不是被拒的 `startRun` 探针），使「每次 `startRun` 调用都铸出了 run」成立（`startRunCalls == runsMinted`）；注册表三个开铸入口都走 `registry.startRun`，spy 才看得见每一次铸 run。
- driver 帧路由：`state.unattended?.writer ?? state.turnRun?.writer ?? rounds[0].writer ?? state.writer`；`turnRun` 在 turn 关闭时清除（否则无人 turn 的帧会落进已结束的 run）。
