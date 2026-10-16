# 常驻会话 Delivery / Turn 语义与执行账本 SPEC

**把「一次发送」「一次执行」「宿主在忙」分开记账；「处理中」只有一个写者**

| 项 | 值 |
|---|---|
| 状态 | **Draft-1（2026-10-16）** |
| 基线 | `develop` @ `976ef03b1`（`author` 同） |
| 范围 | resident 会话（`claude-host-driver`）的账本与状态机、run 的语义、delivery 状态通道、`session_send` 等 API、前端待发行与活动坞、对账与可观测、测试与上线 |
| 非范围 | CLI 自身行为；`later` / `next` / `now` 三档的含义；语音中继的投递规则（GOAL-041 / 043 / 044）；per-run provider 的行为（退化为 delivery:turn = 1:1，保持不变） |
| 目标 GOAL | `GOAL-045`（`AC-377` … `AC-391`，见 §15） |
| 缘起 | 会话「LiveWire 第一次测试」底部的 `Working…` 在 turn 早已结束后持续存在（§1） |
| 关联文档 | `docs/proposals/id-relations-and-projection-invariants.md`（身份与投影不变量，本文是它 A.2 / A.3 / A.4 / B-2 / B-7 的修订依据，并新增 B-8 / B-9）、`docs/proposals/claude-resident-sessions.md`、`docs/proposals/claude-resident-sessions-experiments.md`（E9 / E10 的 CLI 实测） |

> 事实标注：**[M]** 本次或前序实测（带原文出处） · **[I]** 已在 develop 实现 · **[U]** 未测量（保守处理，不作承重假设） · **[P]** 本文提案。
> `file:line` 均为基线 `976ef03b1` 上的位置，文件后续变动时以函数名为准。

---

## 0. 决议记录

### 0.1 2026-10-16 用户在会话中认可、并指示落成本 SPEC 的三项

| # | 决议 |
|---|---|
| **D-1** | **`session_send` 返回值**：`deliveryId` 对每一次被接受的发送必给；`runId` 可空（已绑定到 turn 才给）。给一个**一个 minor 版本**的兼容窗口：窗口内 `runId` 在未绑定时回填 `deliveryId`，`run_get` 同时认两种 id；窗口结束后 `runId` 才允许为 null（§8）。`deliveryId` 作为**纯增字段先于**语义翻转上线，不存在破坏性的中间版本。 |
| **D-2** | **delivery 状态通道**：独立于 turn 流，**不新建通道**，扩展既有 activity 协议（`ActivityProtocolSnapshot.deliveries[]`，整份快照 + 单调 `rev`，晚加入者订阅即得快照）。过渡期**双发**旧 `command_lifecycle` 帧（降级为不带 `seq` 的会话级帧），**不搭载在 turn 流里**（§7）。 |
| **D-3** | **推进方式**：账本（S1）是 run=turn（S2）的前提，不是弯路；S1 的行为等价于「每次 send 一个 run、终态等于其命令终态」。终点是 **run = turn、delivery 独立**（§12）。 |

### 0.2 由 D-3 派生的三条纪律

- **N-1**：S1 **不改任何对外语义**，也不改写 `id-relations` 的 A.3，不得把「每次 send 一个 run」写成既成事实。
- **N-2**：S2（run=turn、状态通道、退役顶替 run）**整体、同一个开关**上线，不拆。
- **N-3**：性质测试（AC-378）与契约哨兵（AC-379）**先于** S1 的实现代码落地，并先在现行代码上变红。

### 0.3 激活策略（R-4）

以用户指示「按上述方案创建 SPEC，再创建相应的 GOAL/AC 并激活」为授权。写入时：`GOAL-045` 与 S0 / S1 的 AC（AC-377 … AC-381）由作者激活，S2 及之后的 AC（AC-382 … AC-391）以 draft 写入，意图是随阶段推进逐批激活。

**实际发生的事（2026-10-16，已由用户确认为预期行为）**：goal-driver 的 triage 步骤会把活跃 GOAL 名下的 draft AC 自动激活（状态日志 `actor: goal-driver`、`reason: "triage: activate"`），AC-382 … AC-391 在写入后约 10–20 分钟内被逐条翻为 `active`，fidelity 判定均为 `faithful`。**因此 15 条 AC 全部处于 `active`，没有「手动逐批激活」这一步。**

由此留下的事实，不再作为风险回避，而是按预期行为对待：

- goal-driver 对「`active` 且名下无在飞任务」的 AC 自动立案，每轮上限 3（`GOAL_SPAWN_CAP_DEFAULT`），各 AC 的任务由它按该 AC 的 `expect` 独立立案，**不知道** §12 的阶段先后。
- 阶段先后因此由**任务层**承担：各阶段的任务以 `depends_on` 表达前后（S1 的出口 AC 对应的任务先于 S2 的任务，依此类推），或由人在任务晋升时把关；AC 的期望文本里「本条在 S1 的出口 AC 全部 achieved 之后才激活」一类句子现在只是**先后提示**，不再是门控。
- N-2（S2 整体、同一开关上线）与 N-3（性质测试与哨兵先于 S1 实现）仍然有效，须在任务的 `depends_on` 与验收里落实。

---

## 1. 问题与实测基线

### 1.1 现象

会话「LiveWire 第一次测试」（app session `fdd3e920-2b90-4af5-abf5-fe69559e1b9d`，resident）：

- 13:30:42（UTC+8）该会话的 turn 已结束（transcript 的 `stop_hook_summary`，`command_lifecycle completed`），此后 `Working…` 持续 **1h59m24s** 才消失。消失那次是人为按 `Escape` 触发的 abort（见 §1.5），不是自愈。
- 之后该会话又来了新消息（15:49:05），turn 在 15:51:54 结束，`Working…` **再次**出现，并持续到本文写成时。
- 读数：`GET /api/providers/sessions/running` 仍含该会话，`startedAt` 为最新一条消息的时刻、`lastSeq = 1`；`GET /api/session-hosts/<id>` 为 `state: busy`、leases 含一条 `turn`；活动坞 `data-activity-state="in-turn" data-activity-phase="idle"`；CLI 进程 CPU 不增长，transcript 不再写。

### 1.2 机制：两本账靠位置对账

run 的身份存在两处，键不同：

| 账本 | 位置 | 键 |
|---|---|---|
| run 注册表 | `chat-run-registry.service.ts` | 每次 send 开一个 run（忙时 `supersedeRunning`，`chat-websocket.service.ts:804-819`），按会话取「当前 run」，`:597` 直接覆盖、不结算被顶掉的那个 |
| 宿主 driver | `claude-host-driver.provider.ts` | `state.rounds[]` FIFO，每个 round 攥着派发它的那个 run 的 writer（`armRound`，`:3558-3562`） |

两者唯一的对应关系是**位置**：帧发给 `state.rounds[0].writer`（`:4533`），每个 `result` 只 `shift()` 一个 round（`:4615`）并给它的 writer 写 `complete`（`:4678`）；注册表看到 `complete` 才把 run 置为终态（`chat-run-registry.service.ts:408-418`）。10-13 的修复（`resultsSeenAtStart`，`:4343-4348`、`:4648`）在这之上叠了第二层位置代理。

**这次的洞**：冷启动（或空闲时）arm 的 round `queuedUuids` 为空（`:3539` 只在 busy 时压入），于是 `started` 事件永远给它打不上 `resultsSeenAtStart`，值恒为 `null`；`result` 处理里 `if (finished.resultsSeenAtStart !== null)`（`:4648`）把合并扫描整段跳过。而 voice 忙时发送被 CLI **折进正在跑的 turn**（§2）是常态，于是「冷 round 在队首 + 后来者折进它的 turn、只出一个 `result`」让 FIFO 永久领先一格：此后每个 turn 结束只关掉**前一条**消息的 run，最新那个永远 running，`turn` lease 一直挂着（`:4662` / `:4693`）。

**日志特征 [M]**（`server.log`，`command_lifecycle forwarded` 行；消息按 transcript `queue-operation` 对齐到毫秒）：

| 消息 | 时刻 | `queued`/`started` 落在 | `completed` 落在 |
|---|---|---|---|
| M1 `03957ea4`（冷） | 13:20:41 | `f7f1cd07` | `5f7a8db1`（13:22:25.532） |
| M2 `b5df6b7a`（忙，折叠） | 13:20:56 | `f7f1cd07` | `f7f1cd07`（13:22:25.526） |
| M3 `610a2081`（忙，折叠） | 13:21:50 | `f7f1cd07` | `f7f1cd07`（13:22:25.526） |
| M4 `a6372e19`（空闲） | 13:23:05 | `5f7a8db1`（前一格） | `360e93f0`（13:23:46） |
| M5 `722d3dc6`（空闲） | 13:24:24 | `360e93f0`（前一格） | `19f4a263`（13:30:42；推断即该会话当时的占槽 run，见表后说明） |
| M6 `06c8e557`（空闲） | 15:49:05 | `19f4a263`（前一格） | `a683ba14`（15:51:54） |

稳态规律：每条消息的 `queued`/`started` 落在**前一条**的 run 上，`completed` 才落在自己的 run 上；最新一个 run 永远收不到自己的终态。

**证据强度**：直接读数只有两样——`command_lifecycle forwarded` 行里每条 lifecycle 帧落在哪个 `runId`，以及 transcript 的 `queue-operation` 时刻。注册表只暴露 `startedAt` / `lastSeq`，**不暴露 runId**，所以「某个 run 属于哪条消息」是推断：M5 的 run 由 `startedAt = 13:24:24.438`（与 M5 的 `enqueue` 同刻）和 `lastSeq = 1`（恰为 13:30:42 那一帧 `completed`）对上 `19f4a263`；其余各格由同一规律逐条外推，并与 §1.3 的回放逐帧吻合。「前一格」一栏因此是由该模型给出的归属，不是直接观测。

### 1.3 复现与因果对照 [M]

用 fake 进程把上述序列逐帧回放进真实的 `ClaudeResidentHostDriver`（一次性探针，已删）：

```
折叠 result 之后:  roundsOpen=2 turnLeases=1 results=1 completes{ M1:1 M2:0 M3:0 }
M4 结束后:         roundsOpen=1 turnLeases=1 results=2 completes{ M1:1 M2:1 M3:1 M4:0 }
M5 结束后:         roundsOpen=1 turnLeases=1 results=3 completes{ ... M4:1 M5:0 }
interrupt 之后:    roundsOpen=1 turnLeases=0 results=3 completes{ ... M5:0 }   ← lease 摘了、round 还在
M6 结束后:         roundsOpen=1 turnLeases=1 results=4 completes{ ... M5:1 M6:0 }
```

只在 `armRound` 加三行（无在飞 turn 时 arm 的 round 立即写 `resultsSeenAtStart = state.resultTimes.length`）后，同一探针五行读数全部归零。三行补丁**未落地**，仅用于证因果（落地见 S0）。

### 1.4 连带后果（由代码推出，**未实测**）

- **无人 turn 识别失效**：`openUnattendedTurnIfOwn` 在 `state.rounds.length > 0` 时直接返回（`:3593`），陈旧 round 会让后台任务、cron、对端消息引起的无人 turn 失去识别，相应的「后台工作完成」通知不发。
- **排队消息发不出去**：`scheduled-message-dispatcher.service.ts:112` 在 `isProcessing` 为真时跳过持久化的排队消息；差一格的会话里它恒为真。
- **帧归属错位**：当前 run 的 `lastSeq` 恒为 0 或 1，实时流与按 run 的重连游标（`id-relations` B-4）读到的是空，界面正常只是靠 JSONL 同步兜着。
- **interrupt 留残**：`interrupt()` 摘掉 `turn` lease 并关掉注册表 run，但注释明写 round「deliberately not settled」（`:2487` 附近），CLI 其实空闲时没有 `result` 会来清它。

### 1.5 证据口径说明

15:30:06 那次「消失」发生在调查者点开 Resident 面板后按 `Escape`：`ChatInterface.tsx:743-756` 在 `document` 上挂了 capture 阶段的全局 `Escape → handleAbortSession()`（条件仅为 `canAbortSession`）。该次释放是被 abort 触发的，**不计入**自然恢复的证据；它同时给出了 §1.4 第四条的实证（abort 之后 round 仍在，M6 的 `queued` 行落到已被关闭的 `19f4a263`）。

---

## 2. CLI 契约 [M]

在**生产 SDK 路径**（`createSdkResidentProcess`）上，用真实 `claude` 二进制 + mock Anthropic 兼容端点（无模型费用），观测 `ClaudeResidentHostDriver.prototype.observe` 收到的原始帧顺序，四个场景各一次（原文见附录 A）：

| 场景 | 帧顺序 |
|---|---|
| 空闲发送（冷、暖） | `queued → started → system/init → … → RESULT → completed`（`completed` 在 RESULT 后 1–10 ms） |
| `later`：忙时两条 | `RESULT(A) → completed(A) → started(B), started(C)`（同毫秒）`→ 一个 init → … → RESULT → completed(B), completed(C)` |
| `next`：忙时一条 | B 在工具边界 `started`，**没有新 init**；`… → completed(B) → RESULT → completed(A)` |
| interrupt | `RESULT/error_during_execution(is_error=true) → cancelled(A) → started(B) → init → … → RESULT → completed(B)` |

由此得到本 SPEC 承重的六条：

- **C-1 命令终态唯一**：每条命令恰好一个终态 `completed` 或 `cancelled`（四个场景全部成立）。
- **C-2 绑定规则**：`started` 到来时若 turn 已开（`init` 之后、`RESULT` 之前），该命令折叠进当前 turn；否则它属于随后的那个 `init`。四个场景全部符合。
- **C-3 终态与 RESULT 的先后不固定**：折叠命令的终态在 RESULT **之前**，主命令的终态在 RESULT **之后**。账本必须与顺序无关；不得用「全部 completed」推断 turn 结束。
- **C-4 `later` 被排空合并成一个 turn**：B、C 共用一个 `init` 与一个 RESULT（与 `claude-resident-sessions.md` §8「不并进当前 turn」不矛盾，但「各自一个 turn」不成立）。
- **C-5 interrupt 只打断在飞命令**：在飞命令 `cancelled`，turn 以 `is_error` 的 RESULT 结束，排队的命令照常在新 turn 里 `started → completed`；abort 到 RESULT 约 10 ms。
- **C-6 无 `session_state_changed`**：轮次把手只有 `system/init … RESULT`（E9 §9.1 同）。

**[U] 未测量，不作承重**：`now` 优先级的抢占、进程被杀、`cancel_async_message` 各时机、权限暂停、compaction 轮、无人 turn 在 `next` 折叠时的形态、CLI 版本漂移。其中**无人 turn 没有 lifecycle**（E9 §9.5）而 **cron 发火会带 CLI 自造 uuid 的 `started`**（E9 §9.4）是既有实测，§5 据此处理。

---

## 3. 目标与非目标

### 3.1 目标

1. **根除差一格**：任何 resident 会话在静止时（turn 已关、无未终态命令）不存在 running 的 run、不存在 `turn` lease、`processing = false`（I1）。
2. **身份靠 id，不靠位置**：命令 ↔ turn 的对应读自 CLI 的 `command_uuid` 与 `init` / `RESULT`，不再由 FIFO 顺序或计数推断。
3. **语义自洽**：run 就是一次执行（turn），delivery 是独立的一等实体，二者 N:1；per-run provider 退化为 1:1。
4. **「处理中」单写者**：run、lease、heartbeat 的 `isProcessing`、`/api/providers/sessions/running`、调度器、MCP 读工具都是账本的投影。
5. **可审计**：每次状态变化有一行带 `sessionId` 的日志；错位时记异常而不是静默。
6. **不让它再发生**：状态机式性质测试 + 真实 CLI 契约哨兵。

### 3.2 非目标

- 不改 CLI；不改 `later` / `next` / `now` 的含义与选择规则（voice 静默窗口释放继续用 `next`）。
- 不改语音中继的「一段音频一条文本」「不自动补发」等投递规则。
- 不引入会话级统一 `seq`（run=turn 之后游标 `{runId, seq}` 的语义原样成立，§6.4）。
- 不在本 SPEC 内重启 `:3001` 或发布；各阶段生效需要人工 build / restart（会断开所有会话，由人决定时机）。

---

## 4. 身份模型与不变量

### 4.1 实体 [P]

| | **Delivery** | **Turn（= run）** |
|---|---|---|
| 含义 | 一次被接受的发送（一条用户消息、定时消息、MCP 写入等） | 一次执行：resident 为 `init … RESULT`；per-run 为一次进程执行 |
| id | `commandUuid`：host 在 send 时铸，CLI 在 lifecycle 里原样回带；非 resident 为 send 时铸的 uuid | resident 在 `init` 时铸；per-run 在起进程时铸（即现有 `startRun`） |
| 状态 | `queued → started → completed｜cancelled`；`cancelled` 带 `reason`（`withdrawn` / `interrupt` / `process-exit` / `owed-terminal-missing`） | `running → completed｜aborted`，终态读自 `RESULT`（`is_error` 且被 interrupt 为 `aborted`） |
| 性质 | **状态**：快照 + 单调 `rev`（§7） | **流**：append-only、`seq`、可按游标重放（现有） |
| 归属字段 | `source`（user / mcp / scheduled / voice …）、`priority`、`correlationId`、`turnId` | `phase`、`toolName`、`startedAt`、`lastSeq`、`kind`（`delivered` / `unattended`） |

### 4.2 关系与 id 的生产面

- Delivery **N:1** Turn：`started` 时绑定 `turnId`（C-2），之前为 null。无人 turn 绑定 0 个 delivery。
- 一个 id 只有一个生产面：`commandUuid` 由 host 铸、CLI 回带；`turnId` 由账本在 `init` 铸；任何消费面都不得推断（`id-relations` A.4）。
- **foreign command**：CLI 自造 uuid 的 `started`（cron 发火，E9 §9.4）不是 delivery——没有任何调用方持有它的句柄。账本记它以对账终态，但**不进快照、不对外暴露**；它所在的 turn 为 `unattended`。

### 4.3 「处理中」的定义

```
processing(session) :=  turn.open  ∨  ∃ delivery ∈ {pushed, queued, started}  ∨  ∃ foreign command 未终态
```

含「已接受、尚未 `init`」的窗口（空闲发送在冷启动时可达数百毫秒），所以发送一被接受界面就是处理中，不出现「空档」。`/api/providers/sessions/running` 的条目形状不变（`{sessionId, provider, startedAt, lastSeq, correlationId}`）：`startedAt` 取 turn 开始或最早未终态 delivery 的接受时刻，`lastSeq` 取 turn 的 `lastSeq`（无 turn 为 0）。

### 4.4 不变量

| # | 不变量 |
|---|---|
| **I1 静止** | turn 已关 ∧ 无未终态 delivery ∧ 无未终态 foreign command ⇒ 注册表无 running 的 run、无 `turn` lease、`processing = false` |
| **I2 终态唯一** | 每个 delivery 恰好一个终态；每个 turn 恰好一个终态 |
| **I3 帧归属** | 一个 turn 的帧只进该 turn 的 run，且 `seq` 从 1 连续；折叠进来的 delivery 不收过程帧，只收自己的 lifecycle 与终态 |
| **I4 绑定稳定** | `turnId` 绑定后不变；turn 关闭后，已绑定而未终态的 delivery 至多保持到**下一个 turn 开始**（`init` 或 `started`）或进程退出，否则按 `cancelled(owed-terminal-missing)` 结算并记异常 |
| **I5 无人 turn** | `init` 到来时没有待绑定的 `started`（且无 foreign `started`）⇔ 无人 turn；有待绑定的 `started` ⇔ delivered turn |
| **I6 单写者** | `processing`、run 终态、`turn` lease 只由账本写；其余读者（registry、host lease、heartbeat、`sessions/running`、调度器、MCP 读工具）均为其投影 |

---

## 5. 账本状态机 [P]

### 5.1 数据（driver 内，每个 resident host 一份）

```
deliveries : Map<commandUuid, { state, turnId | null, source, priority, enqueuedAt, startedAt, endedAt, reason? }>
foreign    : Set<commandUuid>                    // CLI 自造 uuid，不对外
turn       : { id, kind, open, ownerDeliveryId | null, interruptRequested } | null
pendingStart : commandUuid[]                     // 已 started、turn 当时已关，等随后的 init 绑定
```

### 5.2 转移表

| 事件 | 动作 |
|---|---|
| **send**（host 写 stdin 前） | `deliveries[u] = pushed`；`processing = true`；返回 `deliveryId = u` |
| lifecycle `queued u` | `pushed → queued`（幂等） |
| lifecycle `started u` | u ∈ deliveries：`state = started`；`turn.open` ⇒ 绑 `turn.id`（折叠，C-2），否则 `pendingStart.push(u)`。u 未知 ⇒ `foreign.add(u)`，同样按 turn 是否已开处理 |
| `system/init` | 铸 `turnId`；`kind = pendingStart 非空 ? delivered : unattended`；`pendingStart` 全部绑定，`owner` = 其首个；`turn.open = true` |
| 助手 / 工具等帧 | 进 `turn` 的 run writer（I3）；无 turn 时记异常 `frame-without-turn`，沿用最近 writer |
| lifecycle `completed｜cancelled u` | `deliveries[u]` 终态（`cancelled` 的 `reason`：本进程请求过撤回 ⇒ `withdrawn`；`interruptRequested` ⇒ `interrupt`；其余记 `cli`）。**不关 turn** |
| **RESULT** | `turn.open = false`；turn 终态 = `is_error ∧ interruptRequested ? aborted : completed`；unattended 走既有 `finishUnattendedTurn`（`origin` → 触发类型）。已绑定而未终态的 delivery 记为 owed（预期随即到达终态，C-3） |
| 下一个 `started` / `init` | 仍 owed 的 delivery ⇒ `cancelled(owed-terminal-missing)` + 异常日志（I4） |
| interrupt 请求 | 只向 CLI 发 interrupt，`turn.interruptRequested = true`；**账本不直接改任何状态**（不合成终态、不摘 lease）。状态由随后的 RESULT 与 `cancelled` 驱动（C-5） |
| 撤回请求 | 向 CLI 发 `cancel_async_message`；终态由 lifecycle `cancelled` 驱动 |
| 进程退出 / host 关闭 | 全部未终态 delivery ⇒ `cancelled(process-exit)`；`turn.open` ⇒ `aborted` |

### 5.3 顺序无关

C-3 决定终态与 `RESULT` 的先后不固定，所以：delivery 终态只由 lifecycle 驱动，turn 终态只由 `RESULT` 驱动，两者互不等待；一致性只靠 I4（owed 规则）做**交叉核对**，不靠顺序。

### 5.4 投影

- **lease**：不再手工加减。每次账本变更后重算：存在未终态 delivery 或 turn 已开 ⇒ 持有一条 `turn` lease（键 = `turnId`，turn 尚未铸时用 `pending`），否则无。取代现有 5 处 `leaseAdded` / `leaseRemoved`（`:2487`、`:3048`、`:3559`、`:4662`、`:4697`）。
- **registry run**：见 §6。
- **`busyInputReading` 等既有读数接口保持不变**（`roundsOpen` 由账本计算），6 个钉着它们的测试文件继续使用。

---

## 6. Registry：run 即 turn [P]

### 6.1 变更

- resident：run 在 `init` 时由账本通过 host sink 铸造（`openTurn`），在 `RESULT` 时终结；折叠进来的 delivery 共享同一个 run。
- per-run provider：保持 `startRun` 在 dispatch 时铸造，delivery 与 turn 同时产生，1:1。
- **退役 `supersedeRunning`**（`chat-websocket.service.ts:816-819`、`chat-run-registry.service.ts:597` 的覆盖）：忙时 send 不再开「顶替 run」，只产生一个 delivery。
- `ChatRun` 增加 `kind`（`delivered` / `unattended`）与 `deliveryIds[]`；`getRun(session)` = 开着的 turn，无则最近一个；`getRunById` 语义不变（对 turn）。
- `correlationId` 与 `source` 归 delivery；`sessions/running` 条目的 `correlationId` 取 owner delivery 的值（兼容）。

### 6.2 帧归属（S1 与 S2 的差别）

- **S1**（仍是每次 send 一个 run）：帧发给 **owner delivery** 的 run writer（本 turn 最早 `started` 的命令），delivery 的 run 在其**命令终态**时结算。这是现状行为在账本上的正确实现。
- **S2**：帧发给 turn 的 run。

### 6.3 interrupt

`chat.abort` → driver 向 CLI 请求 interrupt，**不**直接摘 lease 或关 run；活动坞在 RESULT 到达（实测约 10 ms）后清除。若 `interruptRequested` 且超过 `T_int`（默认 5 s）仍无 RESULT ⇒ 记 `interrupt-no-result` 异常，由 §10 的对账处理，不静默留残。

### 6.4 游标不变

run=turn 之后，客户端游标 `{runId, seq}` 的规则原样成立：`seq` 按 turn 编号、`ack.runId ≠ cursor.runId` 时复位（`id-relations` B-4，`replayCursor.ts:41,69,92`）。这是选 run=turn 而非会话级统一 `seq` 的原因之一：无人 turn 本来就是这样。

---

## 7. delivery 状态通道 [P]

### 7.1 复用既有 activity 协议

`activity-protocol.service.ts` 已有：每会话单调 `rev`、每次变更发**完整快照**（不是增量）、晚加入者订阅即得快照、`bootId`、心跳。本 SPEC 在 `ActivityProtocolSnapshot` 上新增：

```
deliveries: DeliveryEntry[]
DeliveryEntry = {
  deliveryId: string,                       // = commandUuid
  state: 'queued' | 'started' | 'completed' | 'cancelled',
  source: 'user' | 'mcp' | 'scheduled' | 'voice' | …,
  priority: 'later' | 'next' | 'now' | null,
  enqueuedAt: number, startedAt: number | null, endedAt: number | null,
  turnId: string | null,
  reason?: 'withdrawn' | 'interrupt' | 'process-exit' | 'owed-terminal-missing',
  text?: string                             // 仅 queued / started 时携带，长度有界（默认 ≤ 400 字符）
}
turn 增加: runId, startedAt
```

- 每次 delivery 状态变化 `rev += 1` 并发 `activity.upsert`（整份快照）。
- 终态条目保留与 run 相同的窗口（`DEFAULT_RUN_RETENTION_MS`，5 分钟），每会话至多 50 条。
- `text` 的受众与该会话 transcript 相同；`GET /api/sessions/:id/activity` 同样鉴权。

### 7.2 为什么是整份快照而不是增量

幂等、重连无需重放、与既有协议同形；排队深度有界，体积不是问题。它**结构性**解决 `id-relations` B-7（「被接受的投递，其终态投影必须抵达正在看的 socket」）：重连 = 取快照，不依赖谁的 writer 受众。

### 7.3 过渡期双发

- 旧 `command_lifecycle` 帧继续发，但降级为**会话级帧**：不带 `runId`、不带 `seq`，不进任何 run 的事件缓冲。客户端的游标记录必须忽略无 `seq` 的帧（S2 在客户端核对并补判据）。
- 窗口长度 = 一个 minor 版本，且必须覆盖 PWA 缓存的旧 bundle（`public/sw.js`）的存活期；窗口结束由 S4 删除旧帧。
- **不选「先搭载在 turn 流里过渡」**：搭载需要一个 run 来承载，而那个 run（顶替 run）正是要退役的东西，过渡会变成 flag day。

---

## 8. API 与兼容 [P]

### 8.1 返回值

| 入口 | 变化 |
|---|---|
| chat-control `send` | `{ ok, deliveryId, runId \| null, queued, … }`；`queuedMessageUuid` 保留为 `deliveryId` 的别名（仅排队时有） |
| MCP `session_send` | `{ deliveryId, runId, queued, queuedMessageUuid, source }` |
| MCP `session_create`（带首条消息） | `{ sessionId, deliveryId, runId }` |
| MCP `session_draft` 发送 | `runId: z.string()` 放宽为可空（`mcp-draft.ts:167`） |

- `deliveryId` 对每次被接受的发送必给；被拒绝的发送（`RUN_IN_PROGRESS` 等）**不产生** delivery。
- `runId`：per-run provider 在响应时已有 run，非 null；resident 在响应时**一般还没有**，已绑定才给。**不预铸** runId：idle 发送时若恰好有一个无人 turn 抢先开了，预铸的 run 会错配。

### 8.2 `run_get` 双 id

- 入参 `{ runId } | { deliveryId } | { session }`（互斥）。两个 uuid 空间互不相交，解析无歧义。
- `waitSeconds` 等的是 **delivery 终态**（调用方真正关心的是「我这句话处理完没有」），返回其 turn 的最终助手消息与 phase / pendingTool；折叠的两个 delivery 各自返回自己的终态、共享同一条最终消息；`cancelled` 返回 `outcome: cancelled` 与 `reason`。
- 未知 id ⇒ `RUN_NOT_FOUND` 信封，`details` 增加 `idKind`。
- 上限仍为 `MCP_RUN_GET_MAX_WAIT_SECONDS`，等待只经注入的 `now` / `sleep`。

### 8.3 兼容窗口（一个 minor 版本）

- **窗口前（S1 起）**：`deliveryId` 纯增；`runId` 语义不变。
- **窗口内（S3 起）**：`runId` **从不为 null**：未绑定 turn 时回填 `deliveryId`（调用方可用 `runId === deliveryId` 辨认）；`run_get` 同时认两种 id，所以只会拿 `runId` 去 `run_get` 的旧调用方照常工作。
- **窗口后**：`runId` 未绑定时为 null；窗口截止版本写成**带日期的常量**，由判据断言，过期后判据变红，逼着移除回填。
- MCP 工具描述在每次连接时由客户端重新拉取，LLM 类调用方自动看到新 schema；仓内调用方（`mcp-draft`、`mcp-session-lifecycle`、voice 的 live-executor / tools、quay.service）随 S3 同改。

---

## 9. 前端 [P]

- **待发行**（`PendingResidentMessage`、`useVoicePendingWithdraw`、`useSessionStore` 的 `applyLifecycle`）：行的键改为 `deliveryId`，状态从 activity 快照派生；`queued` 画「排队中」、`started` 保留文本、`completed` 离屏、`cancelled` 清空文本但保留行（`id-relations` B-2 不变）。重连后行从快照恢复，不依赖重放 run 流。
- **游标**：`replayCursor.ts` 规则不变；delivery 相关的会话级帧（无 `seq`）不进游标记录。
- **活动坞**：`processing ∧ phase = idle ∧ 长时间无帧` 时不再写 `Working…`，改为「等待服务端」类的如实文案；`elapsed` 取服务端 turn 的 `startedAt`——现在 `useActivityFreshness.ts:184` 把锚点设为 hello 时刻，刷新即归零，把卡了两小时的 turn 显示成几秒，**掩盖**这类缺陷。
- **全局 Escape**（`ChatInterface.tsx:743-756`）：只在输入框聚焦且没有打开的浮层 / 对话框 / 弹层时才 abort；弹层内的 Escape 只关弹层。
- 实现须遵守 `$frontend-module-standards`（`AGENTS.md`）。

---

## 10. 对账与可观测 [P]

### 10.1 对账不变量

在 `RESULT` 之后与 heartbeat（既有 5 s 一拍）上检查 I1 / I4。异常码：

| code | 条件 |
|---|---|
| `phantom-run` | 注册表有 running 的 run / lease，而账本静止，持续 > `T_q`（默认 10 s） |
| `owed-terminal-missing` | I4 |
| `double-init` | 未 `RESULT` 就来第二个 `init` |
| `late-started-after-unattended-init` | 一个 unattended 判定的 `init` 之后 50 ms 内到来 `started`（C-2 的顺序假设被打破的早期信号） |
| `interrupt-no-result` | §6.3 |
| `frame-without-turn` | §5.2 |

**先只打日志（`mode=log`），观察一段时间无误报后再启用 `mode=enforce`**：`enforce` 把幽灵 run 以 `aborted`、`reason: reconciled` 关闭。不用 lease 定时过期来「修」：那会结算真正在跑的 turn，也会掩盖真实积压。

### 10.2 日志

```
[ledger]    session=<app> delivery=<8> state=<s> turn=<8|-> source=<…>
[turn]      session=<app> turn=<8> kind=<delivered|unattended> open|close outcome=<completed|aborted> deliveries=<n>
[reconcile] session=<app> mode=<log|enforce> anomaly=<code> detail=<…>
```

并给既有 `[ChatRunRegistry] command_lifecycle forwarded` 行补上 `session=`（现在靠与 transcript 按时间交叉才能把行归到会话，见附录 C）。

---

## 11. 测试与哨兵 [P]

| 判据 | 内容 |
|---|---|
| **性质测试**（AC-378） | 复用 fake 进程夹具；种子化随机生成 `{冷发、忙发 later、忙发 next、queued / started / completed / cancelled、RESULT ok / error、无人 init、interrupt、进程退出}` 的交错序列，**终态与 RESULT 两种先后都覆盖**，断言 I1–I6；失败时打印最小反例序列 |
| **契约哨兵**（AC-379） | §2 探针常驻化：真 `claude` + mock 端点，四个场景断言帧顺序，打印 `claude --version`；**检查器自带取假自测**（对被篡改的合成 trace 必须报违约）。CLI 升级一旦改了顺序，它先变红 |
| 冷队首回归（AC-377） | §1.3 序列的回放，含不过度结算的反例 |
| 既有 6 个钉住 `roundsOpen` / `busyInputReading` 的测试文件 | 接口保持，持续通过 |
| 阶段内的端到端（S2 起） | 真实 chat-control + registry + fake 进程；前端 vitest |

新增测试文件一律是**新文件**，不去改共享的 pin 文件。判据文件名与阶段的对应见 §15。每条判据单次运行须在 `goal gate` 的默认 60 s 内（记录里无 `timeoutMs`，驱动对判据 spawn 另有 120 s 硬闸）。

---

## 12. 分阶段与上线

| 阶段 | 内容 | 出口 AC | 开关 / 回滚 |
|---|---|---|---|
| **S0** 热修 | `armRound`：无在飞 turn 时 arm 的 round 立即写 `resultsSeenAtStart = state.resultTimes.length`；冷队首回归夹具。独立于后续所有阶段 | AC-377 | 直接修；回退即还原 |
| **S1** 账本 | driver 内部：账本取代 `rounds[]` FIFO、`resultsSeenAtStart`、`resultTimes` 位置逻辑、5 处 lease 手工配平；interrupt 只请求不改账；无人 turn 判定改为 I5。**对外零语义变化**（N-1）；性质测试与哨兵先行（N-3）。先**影子运行**（账本与旧 FIFO 并行、分歧打日志），再切换；同时放上只打日志的对账 | AC-378、AC-379、AC-380、AC-381 | 影子开关；切换后回退 = 切回旧路径 |
| **S2** run=turn + 状态通道 | resident run 在 `init` 铸造；delivery 进 activity 快照；退役 `supersedeRunning`；旧 `command_lifecycle` 双发；前端待发行改读快照。**整体、一个开关**（N-2） | AC-382、AC-383、AC-384 | `RESIDENT_RUN_IS_TURN`（名称 [P]，S2 定稿），默认关；回滚即关 |
| **S3** API 翻转 | §8：`deliveryId`、可空 `runId`、`run_get` 双 id、`correlationId` / `source` 归 delivery、改写既有判据（§13） | AC-385、AC-386 | 兼容窗口内回填；窗口常量 |
| **S4** 前端收口 | §9：待发行读快照、删旧帧与游标特例、坞如实、elapsed 取服务端、Escape 守卫 | AC-387、AC-388、AC-389 | 随前端发布 |
| **S5** 对账转强制 | `mode=log → enforce`；补日志（§10.2） | AC-390 | 配置项切回 `log` |
| 文档 | 在 S2 / S3 重写 `id-relations` A.2 / A.3 / A.4、B-2、B-7，新增 B-8（处理中单写者）、B-9（终态与 RESULT 顺序无关）；`claude-resident-sessions.md` §8 补 C-4；`HostInputPriority` 注释补排空合并 | AC-391 | — |

- 每一阶段可独立落地且保持全绿。生效都需要**重启服务**，重启会断开所有会话，由人决定时机；各阶段执行者**不得自行重启**。
- 实现须遵守 `AGENTS.md` 中 `$backend-module-standards`（新增类型进 `server/shared/types.ts` 并分组注释；跨模块只经 `index.ts` barrel；测试放 `server/modules/<feature>/tests/`）。
- 阶段先后由任务的 `depends_on` 与晋升把关承担（§0.3）：后一阶段的任务不得先于前一阶段出口 AC 对应的任务落地。

---

## 13. 既有判据与文档的影响面

### 13.1 既有 AC（均 `achieved`，S2 / S3 须改写或在其上叠加，不得悄悄让它们变红）

| AC | 现在钉的是 | 受影响的阶段与处理 |
|---|---|---|
| AC-163 | 忙时输入进 CLI 队列、出队前可撤回 | 语义不变（档位与 uuid）；`deliveryId` = 该 uuid |
| AC-230 | 发送在运行登记后立即返回 `runId`，且就是注册表里那次运行 | **S3 改写**：`deliveryId` 必给，`runId` 已绑定才给 |
| AC-231 | 忙会话发送：常驻排队并返回可撤回 uuid，按次进程拒绝 | uuid 即 `deliveryId`；per-run 拒绝不变 |
| AC-235 | 运行可按 `runId` 寻址，被取代的与已完成的在保留期内可查 | S2 后不再有「被取代的 run」；`getRunById` 对 turn 不变 |
| AC-248 | `run_get` 按 `runId` 取摘要并可有界等待 | **S3 扩展**：加 `deliveryId` |
| AC-249 | `session_send` 立即返回 `runId`，运行与 UI 发起的是同一种 | **S3 改写**（§8） |
| AC-250 | `session_create` 返回 `runId`、`session_interrupt` 中止运行但常驻进程存活 | **S3 改写**返回值；interrupt 不变 |
| AC-271 | `session_cancel_queued` 用 `session_send` 返回的 uuid | 不变（uuid = `deliveryId`） |
| AC-337 | 写工具的 `correlationId` 记入 run 元数据与审计 | **S3 改**：记入 delivery，`sessions/running` 兼容回填 |
| AC-310 / AC-339 | 真实 context + `session_send`；`session_interrupt` 可审计 | 随 S3 回归 |

### 13.2 与在飞 / draft 目标的重叠

- `GOAL-040`（draft）下的 **AC-298**（`run_get` 参数收敛：`runId` 与 `session` 二选一）与 **AC-301**（`session_send` 返回明确状态与有类型的等待结果）与 §8 直接重叠：S3 开工前须决定「并入本 SPEC / 被取代」，**本 SPEC 不改它们**。
- `GOAL-041 / 043 / 044`（Live Voice）依赖 `command_lifecycle` 帧与队列行（`useVoicePendingWithdraw` 等）：S2 的双发窗口与 S4 的前端改动须与其串行协调，不得改变其投递规则。

### 13.3 文档修订清单（S2 / S3 执行）

`id-relations-and-projection-invariants.md`：A.2（`deliveryId` 的载体即 `commandUuid`）、A.3（`runId` 重述为 turn，`runId → 投递` 1:N 与代码一致）、A.4 关系图、B-2 / B-7（改写为状态通道版本）、新增 B-8 / B-9。`claude-resident-sessions.md` §8：补 C-4。`server/shared/types.ts` 的 `HostInputPriority` 注释：补「`later` 被排空合并成一个 turn」。

---

## 14. 风险与未测

- **CLI 契约漂移**：设计现在依赖 §2 的顺序事实，哨兵（AC-379）是唯一的保护；升级 `claude` 前先跑它。
- **未测形态**：`now` 抢占、进程被杀、`cancel_async_message` 各时机、权限暂停、compaction 轮（§2 [U]）。S1 的影子期要专门盯这几种，并把测到的补进哨兵。
- **旧客户端**：重启后 PWA 缓存的旧 bundle 仍会连上；双发窗口要足够长，客户端对未知字段须容错。
- **帧归属改变**：S2 后折叠命令的 run（若仍有）不再收过程帧；这与现状一致（`gap-resident-merged-queued-turn…` 的非目标里已登记），但须在文档里写明。
- **状态通道与流的重放排序**：重连时快照与 turn 流的先后须在 S2 前单独设计并测（`rev` 与 `seq` 的相对顺序）。
- **探针局限**：§2 每个场景只跑了一次、依赖时序，足以说明顺序，不足以说明所有竞态。
- **阶段先后失控**：15 条 AC 全部 `active` 后，goal-driver 按每轮 3 条逐步为各 AC 立案，任务之间天然不带先后（§0.3）。须在任务层补 `depends_on`，并对改同一批文件的任务依赖 quay 的 Touches 重叠串行；S2 的整体上线（N-2）尤其不能被拆开分批落地。

---

## 15. 验收矩阵

`GOAL-045`。下表「激活」列为**写入时**的状态；其后 goal-driver 的 triage 已把 draft 全部翻为 `active`（§0.3）。判据均为**单文件**命令（不用 glob、不跑整份串行 spec），文件在本 SPEC 写成时**均不存在**，故基线必红（`Could not find …`）。

| AC | 阶段 | 判据文件 | 激活 |
|---|---|---|---|
| AC-377 | S0 | `server/modules/providers/tests/claude-resident-cold-head-merge.test.ts` | 是 |
| AC-378 | S1 | `server/modules/providers/tests/claude-resident-ledger-invariants.test.ts` | 是 |
| AC-379 | S1 | `server/modules/providers/tests/claude-resident-cli-contract.test.ts` | 是 |
| AC-380 | S1 | `server/modules/providers/tests/claude-resident-interrupt-ledger.test.ts` | 是 |
| AC-381 | S1 | `server/modules/providers/tests/claude-resident-unattended-after-turns.test.ts` | 是 |
| AC-382 | S2 | `server/modules/websocket/tests/chat-run-turn-semantics.test.ts` | draft |
| AC-383 | S2 | `server/modules/websocket/tests/activity-deliveries-snapshot.test.ts` | draft |
| AC-384 | S2 | `server/modules/websocket/tests/processing-single-writer.test.ts` | draft |
| AC-385 | S3 | `server/modules/mcp-gateway/tests/mcp-session-send-delivery.test.ts` | draft |
| AC-386 | S3 | `server/modules/mcp-gateway/tests/mcp-run-get-delivery.test.ts` | draft |
| AC-387 | S4 | `src/modules/chat/tests/pendingDeliveriesSnapshot.test.tsx` | draft |
| AC-388 | S4 | `src/modules/chat/tests/activityDockHonestStatus.test.tsx` | draft |
| AC-389 | S4 | `src/modules/chat/tests/escapeAbortGuard.test.tsx` | draft |
| AC-390 | S5 | `server/modules/providers/tests/claude-resident-reconcile.test.ts` | draft |
| AC-391 | 文档 | `server/modules/websocket/tests/resident-semantics-doc-anchors.test.ts` | draft |

---

## 附录 A：实测原文帧序（生产 SDK 路径，2026-10-16）

`+ms` 为相对探针起点的毫秒；`CLI` = 驱动 `observe` 收到的原始帧（略去 `stream_event`），`HOST` = 探针的动作，`MOCK` = mock 端点收到的一次 agent 请求。每个场景之间静默 3 s。

```
+297ms ========== S1 idle send (cold start)
+297ms HOST chat.send "S1-A"
+601ms   CLI  command_lifecycle queued cmd=869a85ff
+609ms   CLI  command_lifecycle started cmd=869a85ff
+1360ms   CLI  system/init uuid=4bbbe1fc
+1363ms   CLI  system/status
+1404ms   MOCK agent request #1 -> text
+1409ms   CLI  assistant "ok"
+1441ms   CLI  RESULT/success is_error=false uuid=026d0a94 origin=null
+1451ms   CLI  command_lifecycle completed cmd=869a85ff
+4457ms ========== S1b idle send #2 (warm process)
+4458ms HOST chat.send "S1b-A"
+4466ms   CLI  command_lifecycle queued cmd=d3b60925
+4467ms   CLI  command_lifecycle started cmd=d3b60925
+4479ms   CLI  system/init uuid=d9e313ae
+4480ms   CLI  system/status
+4491ms   MOCK agent request #2 -> text
+4493ms   CLI  assistant "ok"
+4501ms   CLI  RESULT/success is_error=false uuid=34cb739e origin=null
+4502ms   CLI  command_lifecycle completed cmd=d3b60925
+7569ms ========== S2 later: two busy sends behind a running turn (queue-drain merge?)
+7569ms HOST chat.send "S2-A"
+7576ms   CLI  command_lifecycle queued cmd=55df9398
+7577ms   CLI  command_lifecycle started cmd=55df9398
+7598ms   CLI  system/init uuid=396e35bf
+7599ms   CLI  system/status
+7609ms   MOCK agent request #3 -> Bash sleep 4
+7615ms   CLI  assistant [tool_use:Bash]
+8774ms HOST chat.send "S2-B"
+8781ms HOST chat.send "S2-C"
+8787ms   CLI  command_lifecycle queued cmd=078e9512
+8788ms   CLI  command_lifecycle queued cmd=c865303c
+10656ms   CLI  system/task_started
+11658ms   CLI  system/task_notification
+11667ms   CLI  user uuid=b809020e [tool_result]
+11670ms   CLI  system/status
+11680ms   MOCK agent request #4 -> text
+11683ms   CLI  assistant "ok"
+11691ms   CLI  RESULT/success is_error=false uuid=2115fbd6 origin=null
+11693ms   CLI  command_lifecycle completed cmd=55df9398
+11694ms   CLI  command_lifecycle started cmd=078e9512
+11694ms   CLI  command_lifecycle started cmd=c865303c
+11702ms   CLI  system/init uuid=c7a860a3
+11703ms   CLI  system/status
+11712ms   MOCK agent request #5 -> text
+11714ms   CLI  assistant "ok"
+11721ms   CLI  RESULT/success is_error=false uuid=44650b13 origin=null
+11722ms   CLI  command_lifecycle completed cmd=078e9512
+11722ms   CLI  command_lifecycle completed cmd=c865303c
+14799ms ========== S3 next: one busy send folded into the running turn?
+14799ms HOST chat.send "S3-A"
+14807ms   CLI  command_lifecycle queued cmd=4e4562d0
+14808ms   CLI  command_lifecycle started cmd=4e4562d0
+14817ms   CLI  system/init uuid=260c9fc0
+14817ms   CLI  system/status
+14826ms   MOCK agent request #6 -> Bash sleep 4
+14829ms   CLI  assistant [tool_use:Bash]
+16005ms HOST chat.send "S3-B" priority=next
+16015ms   CLI  command_lifecycle queued cmd=28facb0b
+17840ms   CLI  system/task_started
+18842ms   CLI  system/task_notification
+18847ms   CLI  user uuid=79c87f46 [tool_result]
+18853ms   CLI  command_lifecycle started cmd=28facb0b
+18854ms   CLI  system/status
+18863ms   MOCK agent request #7 -> text
+18865ms   CLI  assistant "ok"
+18871ms   CLI  command_lifecycle completed cmd=28facb0b
+18871ms   CLI  RESULT/success is_error=false uuid=d7491849 origin=null
+18872ms   CLI  command_lifecycle completed cmd=4e4562d0
+21924ms ========== S4 interrupt: abort while A runs and B is queued
+21924ms HOST chat.send "S4-A"
+21933ms   CLI  command_lifecycle queued cmd=21fab2f3
+21934ms   CLI  command_lifecycle started cmd=21fab2f3
+21943ms   CLI  system/init uuid=c9b1cc8d
+21944ms   CLI  system/status
+21953ms   MOCK agent request #8 -> Bash sleep 20
+21956ms   CLI  assistant [tool_use:Bash]
+23131ms HOST chat.send "S4-B"
+23140ms   CLI  command_lifecycle queued cmd=f9364270
+23939ms HOST chat.abort
+23948ms   CLI  user uuid=2e83b95f [tool_result]
+23948ms   CLI  user uuid=6ed907e4 "[Request interrupted by user for tool us"
+23950ms   CLI  RESULT/error_during_execution is_error=true uuid=09d802cb origin=null
+23951ms   CLI  command_lifecycle cancelled cmd=21fab2f3
+23952ms   CLI  command_lifecycle started cmd=f9364270
+23958ms   CLI  system/init uuid=4bbb5249
+23959ms   CLI  system/status
+23968ms   MOCK agent request #9 -> text
+23970ms   CLI  assistant "ok"
+23977ms   CLI  RESULT/success is_error=false uuid=e6c1c929 origin=null
+23977ms   CLI  command_lifecycle completed cmd=f9364270
```

## 附录 B：复现方法

探针是 `claude-resident-merged-queued-turn.test.ts` 真实二进制臂的变体：同一套 `startMockAnthropic()`、临时 `DATABASE_PATH` / `CLAUDE_CONFIG_DIR`、`handleChatConnection` 的 fake socket 与 `chat.send` / `chat.abort` 帧；在 `ClaudeResidentHostDriver.prototype.observe` 上挂一个**只读**观测点，按到达顺序记 `type` / `subtype` / lifecycle `state` / `command_uuid`。忙时档位经 `options.priority`（`CLAUDE_TURN_PRIORITY_OPTION`）指定。探针一次性、已删除；AC-379 把它常驻化并加上检查器自测。

## 附录 C：现场诊断——差一格的日志特征

`grep "command_lifecycle forwarded" server.log`，按消息的 uuid 排列：**每条消息的 `queued`/`started` 落在前一条消息的 `runId` 上，`completed` 才落在自己的 `runId` 上**；`GET /api/providers/sessions/running` 里该会话 `lastSeq ≤ 1` 而 turn 早已结束；`GET /api/session-hosts/<id>` 为 `busy` 且 leases 含 `turn`。此行没有 `sessionId`，需按时间与 transcript 的 `queue-operation` 交叉对齐（§10.2 补上）。
