---
id: gap-ac382-run-is-turn-resident-init-minted-run
title: AC-382 run 即 turn（S2）：resident 的 run 在 init 由账本铸造、折叠与排空合并的 delivery 共享同一个
  run、帧只进该 run、退役 supersedeRunning；交付
  server/modules/websocket/tests/chat-run-turn-semantics.test.ts（八条腿 + 取假形态）
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

- [ ] (a) `npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-run-turn-semantics.test.ts` 退出 **0**（当前必红：文件不存在，文案含 `Could not find`）。同一次运行先打印**空闲 send 腿**：`RESIDENT_RUN_IS_TURN` 开的会话静态时一次 `chat.send`（经真实 `chatControlService.send` 落到真实 `chatRunRegistry`）⇒ 读到 `idleTurns=1 idleRuns=1`，且该 run `kind=delivered`、`deliveryIds` 恰含这条 send 的 delivery id。
- [ ] (b) 同一次运行内**忙时 later 排空合并腿**：一个在飞 turn 内先后两条 `later` priority 的忙时 send，scripted fake 进程按 SPEC §2 C-4 吐帧（一个 `init` + 一个 `RESULT`，两条命令被 CLI 排空合并进同一个 turn）⇒ 读数 `mergedRuns=1`（这条路径**只**铸一个 run）、`mergedDeliveryIds=2`（该 run 的 `deliveryIds` 恰含这两条 send 的 id，集合相等）、两条 delivery 各自终态独立且断言按**集合**而非顺序（`mergedOrderIrrelevant=true`）。
- [ ] (c) 同一次运行内**next 折叠腿**：在飞 turn 内一条 `next` priority 的 send ⇒ 不新铸 run（`nextRunsAdded=0`），该 delivery 绑定到**开着的 turn 的 run**（`nextDeliveryRunId == openTurnRunId`，逐字相等）。
- [ ] (d) 同一次运行内**无人 turn 腿**：无任何 send 时 CLI 自起一个 turn（`init` … `RESULT`，`init` 的 uuid 不在 `pushedUuids`）⇒ 开出的 run `source=unattended`、`deliveryIds` 为空（`unattendedRunSource=unattended unattendedDeliveryIds=0`）。
- [ ] (e) 同一次运行内**帧归属腿**（承重）：逐 run 读 writer 的事件日志 ⇒ 每个 run 的所有帧都带自己的 `runId`（`framesWithForeignRunId=0`）、每个 run 的 `seq` 从 1 连续无洞（`seqGaps=0`）；读数取自 `chatRunRegistry.getRunById(runId).events` 的 `runId` / `seq`，不是 driver 内部读数。
- [ ] (f) 同一次运行内**spy 计数腿**：对 `chatRunRegistry.startRun` 打 spy，跑完 (a)–(d) 后断言对 resident 会话带 `supersedeRunning: true` 的调用次数为 **0**（`supersedeRunningCalls=0`，打印读数后再断言）；同时打印总 `startRun` 调用次数与铸出的 run 数关系（`startRunCalls == runsMinted`）。
- [ ] (g) 同一次运行内**per-run provider 腿**：`acceptsBusyInput` 为假的 provider（调试 agent 的按次进程）一次 send ⇒ 一个 delivery 一个 run（`perRunDeliveries=1 perRunRuns=1`），且忙时第二条被以 `RUN_IN_PROGRESS` 拒（不因 run=turn 改动而放开）。
- [ ] (h) **取假形态可复现**：把帧路由临时改回 `state.rounds[0].writer`（S1 行为），判据文件一字不动重跑 ⇒ 退出**非 0**，且红落在 (e) 腿的 `framesWithForeignRunId` 读数上（**不是别的腿先红**）；用后还原、重跑 (a)–(g) 恢复绿。逐字红态读数、退出码与命令行抄进完成记录，`git diff` 最终不含该临时代码。
- [ ] (i) **开关默认关 + 关态零变化**：`RESIDENT_RUN_IS_TURN` 默认关（实现落地时定名并写进判据读取处）；关态下 `npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-run-registry.test.ts`、`... chat-run-by-id.test.ts`、`... chat-control-busy.test.ts`、`... chat-control-send.test.ts` 各退出 **0**，且这四个文件在 `git diff --name-only` 里不出现（若实现上必须改动其中任一文件，在完成记录里逐条列出并说明、不得悄悄让它们变红）。
- [ ] (j) 该判据文件单次运行墙钟 **< 45s**（SPEC §11：goal gate 默认 60 s，须留余量）；每条读数在断言之前先采齐（红要落在错的读数上，不落在超时或更早的腿上）；进程预算守卫照兄弟文件用 `exit 3`（进程级杀，不是单用例失败）。
- [ ] (k) collateral：新增一个 `server/**/*.test.ts` ⇒ **先复量** `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l`（立案时为 346，以执行时实测为准），按 `server/shared/tests/quay-test-script.test.ts` 自身两条计数 pin（AC2 的 `known=3 unknown=343`、AC3 的 `known=1 unknown=345`，即 `base+1`）各 +1，并改写其上方注释里的算术；`scripts/suite-duration-baseline.tsv` **仅当** AC7 覆盖率地板跌破 90% 才追加一行（先量，通常不动，免得给 diff 添未声明文件）。单文件复跑 `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0。
- [ ] (l) 遵守 `$backend-module-standards`：判据落 `server/modules/websocket/tests/`、跨模块只经 `index.ts` barrel、无 `any`；`npx tsc --noEmit -p server/tsconfig.json` 退出 0。

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
