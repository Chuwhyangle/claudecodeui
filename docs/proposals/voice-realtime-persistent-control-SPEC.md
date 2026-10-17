# Live Voice 持续控制面 SPEC

**P0 = 持续输入 + 可中断 + 实时状态反馈**

| 项 | 值 |
|---|---|
| 状态 | **Draft-3（D-1 / D-2 见 §0.2；2026-10-12 A+ 意图控制决议见 §0.3 与 §18）** |
| 基线 | `develop` @ `cf160d06`（2026-10-11）；Draft-3 复核基线 `develop` @ `e2bb8089`（2026-10-12） |
| 范围 | 控制面语义、工具接口、状态注入契约、状态机、时序、验收矩阵 |
| 非范围 | Steer / Fork / Rollback（本期非目标，见 §2.2）；独立 Active Intent Buffer（方案 B，见 §18.2） |

> 事实标注：**[M]** 已实测 · **[I]** 已实现（代码在 develop）· **[U]** 未测量（能力槽保守取 false）· **[P]** 本文提案。
> `[W]` = 本次为写本文而核实的**线协议边界**（带 file:line）。

---

## 0. 决议记录

### 0.1 Draft-1 → Draft-2 的两处修订（2026-10-11，人裁定）

| # | Draft-1（作废） | **Draft-2（生效）** |
|---|---|---|
| **D-1** | 状态只在**工具回执**里给模型一行 | **Realtime 模型持续注入精简执行状态**：event-driven、去重、限频、有界 token、**带陈旧标识**；同时提供**工具主动查询全量状态**。**绝非仅在工具回执给一行。** |
| **D-2** | 「停」视为可确定性映射的指令 | **自然语言的"停"不是确定性映射、也不是交互协议**：由**语音模型解释用户意图**，**自主决定**是否调用唯一 P0 中止元语 `session_interrupt`（abort current run）。**不提供** rollback / rewind / undo 等元语；**不扩充**本期"清空队列"功能。 |

### 0.2 由 D-2 派生的三条硬约束

- **C-1**：语音面**唯一**的中止元语是 `session_interrupt`；不存在第二个"停"的入口或协议。
- **C-2**：**不存在**关键词表、本地停止词兜底、或任何"用户说了 X ⇒ 必然 abort"的确定性映射。
  〔⚠️ 与在飞任务 T2 的 Plan 第 5 步冲突，见 §16 缺口 G-9——本文不改任务，只登记〕
- **C-3**：`session_interrupt` 的**决策权在模型**，其判断依据（它听到了什么）必须随调用一起被记录，使误停可审计（§6.2、§10.3）。

### 0.3 Draft-3 决议：A+ 意图控制（2026-10-12，人 yale 授权落地）

| # | 决议 |
|---|---|
| **D-5** | **A+ 为默认架构**：忙时语音照常进入 CLI 自己的队列，由 CLI 在**回合边界**把排队消息按推入顺序聚合进同一次请求（实测，§18.1；载体见 E10/U3：无中断时为一条 mid-turn system 通知，有中断时挂在带 `[Request interrupted by user for tool use]` 的 user 消息上）；L3 不另建缓冲，只做**真实观测 + 有序中断 + 栅栏**。**方案 B（独立 Active Intent Buffer + Intent Reconciliation）不实施**，仅当 §18.7 的判据实测证明 A+ 不够时再讨论。 |
| **D-6** | **中断语义从「想停」扩到「想停，或要修正当前执行的方向」**：仍由 Realtime 模型**语义判断**，**非关键词**（C-2 不变）。扩展只在阶段 1 的「先入队后中断」（§18.4 G1）落地后生效；阶段 0 只删除停止词触发规则，不扩语义。 |
| **D-7** | **runId + utteranceSeq 栅栏**：模型发起的中断只在当前 run 尚未覆盖触发它的那句话时生效，否则幂等返回 `covered`；**UI 停止键不受栅栏约束**（I-4）。 |
| **D-8** | **立即中断，不做安全点**；已落地副作用**保留**（不回滚、不暗示可撤销），由审计记录中断时在途工具并在下一轮诚实告知。 |
| **D-9** | **语音中断只作用于绑定会话的当前 run**：不停 Quay worker / driver / 工作树，不调 `stopTask`，不动后台任务与 cron 租约。 |

Steer / Fork / Rollback 仍为非目标；模型工具面**不**暴露撤回/清空队列（D-2 不变）。
| # | 2026-10-12 续裁（人 yale：「按建议推进」） |
|---|---|
| **D-10** | **worker 模型不换**：GOAL-041 任务继续由 `v4.1flash`（本机网关，`.quay/profiles.yml` `worker-default`）执行；阶段 1 每个任务落地后由 Opus 常驻会话按判据逐条核对实际代码，缺陷以后续任务修补。**升级条件**：1a 或 1b 出现一次**逻辑原因**（非负载抖动）的审查不过或 fan-in 失败 ⇒ 提请人把 `task-worker` 角色切到 `v4pro`（共享配置，须人确认后改）。 |
| **D-11** | **能力位 `cancelQueuedInput` 改为 `true`**：E9（最新条目）与 E10/U4（非最新条目）已实测撤回有效，且无运行时代码读取该位，改正只影响声明与推理。**逐条撤回**列为**阶段 2**：仅 UI 确定性按钮（I-4）、只撤单条、不给模型工具（C-1/D-2 不变）、不做清空队列；复用既有待执行行与 `cancelQueued` 链路；排在 1a/1b 之后。**该阶段 2「逐条撤回」已于 2026-10-14 按人裁定「屏上唯一一张合并卡」退役**：逐行撤回控件随它所绘的逐句行一并退役，Live Voice 不留撤回/中断的可按控件（落地提交 `9ccdc6eb7`，它删除了撤回控件与其判据文件）；AC-351 记录随之置 `superseded`，后继读数载体 `src/modules/chat/voice-realtime/tests/voicePendingMessageCard.test.tsx`（只读合并卡），**撤回能力本身无后继**（D-2 不变）。 |

---

## 1. 问题与实测基线

### 1.1 主路径被当成异常

Claude Code 的一次执行（数十秒到数分钟）远长于语音句间隔（秒级）。因此
**「一次执行未结束时连续收到多轮语音」是主路径，不是边角**。今天的实现把它当异常处理：
中继在 `sending` 时直接抛 `A previous voice instruction is still being sent.`
（`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:799-813`），靠 busy-wait
（2 s / 120 s）与 2500 ms 合并窗口去凑时序。而底层本支持这条路：
**`inputWhileBusy: true`（E2 实测）** —— 接受输入的同时可以继续跑
（`server/modules/providers/services/provider-capabilities.service.ts:147`）。

### 1.2 三次实测（基线证据）

| # | 时间 | 会话 / journal | 现象 |
|---|---|---|---|
| E-1 | 2026-10-11 19:22–19:30 | `9db75ad5` / `faeb9c61` | Claude 回合约 **4 分钟**；其后 8 句**全部被拒**（`VOICE_QUEUE_FULL depth=3 max=3`），从未进入会话；8 句合计 **< 500 字节**。屏上只剩 3 条已投递行 |
| E-2 | 2026-10-11 19:51–19:58 | `891da48b` / `c8b0ee15` | 7 句中第 2–7 句，上游模型回文本 `"OK"` 而**不调用工具** ⇒ `MODEL_TEXT_REPLY (recoverable)` ×6 |
| E-3 | 2026-10-11 17:3x | `server.log` 连接 `d88c6722` | 11 次投递里 `coalesced … relayed piece(s)` **恒为 1** ⇒ 2500 ms 窗口在真实流量中未合并过任何东西，是纯等待 |

语音链路自身不慢（E-1：说完 → 0.4 s 模型调用 → 2.5 s 窗口 → 29 ms 投递）。
**慢的是"排队等我"，而这一点当时对用户、也对语音模型都不可见** —— 后者正是 E-2 自答的土壤。

### 1.3 已落地 / 在飞（写入本文时）

| 任务 | 状态 | 内容 |
|---|---|---|
| `gap-live-voice-queue-byte-budget-and-visible-backlog` | **done** | 准入轴改为 **UTF-8 字节预算**（`VOICE_QUEUE_MAX_BYTES` / `bytesOf()` / seam `maxQueuedVoiceBytes`）[I] |
| `gap-live-voice-stop-vs-exit-affordances` | **done** | 退出键改「Exit Live Voice」；running 行新增停止键（`onStopTurn`）[I] |
| `gap-voice-realtime-scripted-fake-upstream` | **done** | 离线脚本化假上游 + 8 场景判据 [I] |
| `gap-live-voice-voice-terminated-interrupt` | done | 语音面 `session_interrupt`；浏览器侧停止词兜底已移除（`bbca2901`/`d03702bb`），但 **prompt 内停止词清单仍在**（§18.1 F-5） |
| `gap-voice-realtime-paced-audio-source` | done | 实时节拍音源 |
| `gap-live-voice-e2e-scripted-upstream` | done | 浏览器多场景 |

### 1.4 能力矩阵

| 能力 | 值 | 来源 |
|---|---|---|
| `inputWhileBusy` | **true** | [M] E2 |
| `interruptKeepsProcess` | **true** | [M] E4 |
| `stopTask`（约 1.0 s 内 `status:'killed'`） | **true** | [M] 2026-10-04 |
| `liveReconfigure` | `['model','permissionMode']` | [M] AC-272 |
| `cancelQueuedInput` | **false**（能力位） | ⚠️ 能力位过时：E9 已实测 `cancel_async_message` 对**未出队**消息有效（`state=cancelled`），driver `cancelQueuedInput` 与 MCP `session_cancel_queued`（AC-271）已实现；语音面未暴露（§18.1 F-4） |
| `backgroundTasks`（列后台任务的 SDK 动词） | **false** | [U] 未测量 |
| `supportsMessageEditing`（=`resumeSessionAt` **重跑**） | true | [I] |
| `supportsSessionForking`（=复制 transcript 前缀到新会话） | true | [I] |
| `rewindFiles`（SDK 的**文件**回滚动词） | **存在但零调用点** | [I] `claude-host-driver.provider.ts:332` 仅注释 |

MCP gateway 现有 18 个工具 + `session_background`（AC-273）[I]；**语音面只挂 `session_send`**（`voice-realtime-tools.ts:303`）[I]。

### 1.5 状态注入的**线协议边界**（`[W]` 本次核实，决定 D-1 能怎么实现）

**客户端→上游的消息联合体只有 6 个成员**（`voice-realtime-bridge.service.ts:46-70`）：
`session.update`（携带 `instructions` + `tools`，**整体替换**）、`input_audio_buffer.append`、
`input_audio_buffer.commit`、`response.create`、`session.turn_detection`（**刻意的部分更新**，不带 instructions/tools）、
`function_call_output`。

由此得到三条硬边界：

| 边界 | 事实 | 含义 |
|---|---|---|
| **B-1** | **没有**通用的 `conversation.item.create`：唯一出现处是 `function_call_output`，且它与 **`response.create` 焊死**（`voice-realtime-dashscope-transport.ts:410-417`） | 「塞一条状态消息」今天做不到；照抄这条焊法会让模型**每次状态变化都开口说话** |
| **B-2** | **没有** `conversation.item.delete` / `truncate` / `retrieve` 任何动词 | 一旦以 conversation item 注入，**无法收回**，会被此后每一次响应重复读取 ⇒ **成本累积** |
| **B-3** | 今天唯一**已经在用**的注入通道是 **`session.update` 整体重述 instructions**：`advertiseInstructions()`（`voice-realtime-ws-proxy.service.ts:737-752`）以 `advertisedContext === contextText` **去重**后重发，并打 `context injected chars= rows=` 日志 | **整体替换 ⇒ 不累积**；且去重机制**已经存在**，是 D-1 的天然落点 |

**结论**：D-1 的实现必须建在 **B-3**（compose + 仅在变化时重发 `session.update`），
**不是** B-1（会触发说话 + B-2 使其永久累积）。
固定上下文成本已有实测锚点：**约 1,280 token / 响应**，且「按每次响应读取的 token 计费」（`voice-realtime-tools.ts:290-291`）[M]。

---

## 2. 目标与非目标

### 2.1 目标（P0）

1. **持续输入**：执行在跑时，用户说的话**默认全部被接受**，按序、可追溯、可见。
2. **可中断**：**语音模型自主决定**调用唯一中止元语 `session_interrupt`，停止**当前执行**；
   不破坏会话、不丢未执行的话。（D-2 / C-1）
3. **实时状态反馈**：用户**与语音模型**都能持续读到执行面状态 —— 模型侧是**持续注入的精简状态**
   （event-driven / 去重 / 限频 / 有界 token / 带陈旧标识）**加**一个主动查询全量状态的工具。（D-1）

### 2.2 非目标（本期明确不做）

| 项 | 原因 |
|---|---|
| **Steer**（边跑边改方向） | 无底层语义 |
| **Fork** | 有实现（`forkSession`）但语义重（新 session id/transcript），不在 P0 |
| **Rollback / Undo / Rewind** | **技术上一半不成立**：`rewindSession` 只有 Codex 有；claude 的"编辑"是 `resumeSessionAt` **重跑**；`rewindFiles` 零调用点 ⇒ **文件回滚做不到**。**且 D-2 明确：不提供这些元语**（C-1）；文案红线见 §11.4 |
| **清空队列**（cancel queued） | D-2 明确本期**不扩充**；且 `cancelQueuedInput: false` [U] |
| 多会话/跨项目语音 | 保留接口，不实现 |

---

## 3. 角色分层

```
┌─ 用户（说 / 听 / 看）
├─ L1 浏览器 UI ── 采集、字幕、bar/running 行、backlog 呈现、**确定性停止键**   [I]
├─ L2 实时语音链路 ── /voice-realtime WS → relay → realtime 模型               [I]
│     · 模型做两件事：转写 + **自主决定**是否提议工具调用（含 session_interrupt）
├─ L3 控制面（本 SPEC 主体）                                                  [P]
│     · 准入（字节预算）[I] · 排序/合并 [I] · 工具语义 [部分]
│     · **状态聚合 + 注入（§8）** [P]
├─ L4 控制服务（ChatControlService）—— abort / stopTask 的单一动词层         [I]
└─ L5 执行面：resident claude 进程                                            [I]
      · CLI 自有队列；inputWhileBusy [M]；interruptKeepsProcess [M]
```

**不变量**
- **I-1**：L2/L3 **永不阻塞**在 L5 上；任何工具调用有限时间返回三态，不得 busy-wait 到执行结束。〔[P]，取代 `:816-817`〕
- **I-2**：L5 的繁忙只影响 L3 的**读数**，不影响 L3 写入。
- **I-3**：L1 只呈现 L3 推送的事件；**不得**自行轮询推导状态（取代 `useFollowSentRun` 的 1.5 s 轮询作为状态来源）。
- **I-4**：**确定性只存在于 UI**（running 行停止键 / Esc）。自然语言一侧**无**确定性映射（C-2）。

---

## 4. 身份模型

| 身份 | 铸造者 | 生命周期 | 稳定性 |
|---|---|---|---|
| `itemId`（utterance） | realtime 端点 | 一次说话 | 端点上，不跨连接 |
| `sessionId` | app（`POST /api/providers/sessions`） | 长期 | **用户可见的稳定 id** |
| `providerSessionId` | CLI/SDK | 会话级 | fork 后变化 |
| **`runId`** | **控制服务** | **一次执行** | **唯一标识"正在跑的那件事"** |
| `queuedMessageUuid` | CLI 队列（`session_send` 返回） | 排队条目 | 撤回要靠它（claude 不支持 [U]） |
| `deliveryId`（中继侧） | relay | 一次投递 | 内部；UI 只作行标记 |
| `statusSeq`（**新增**） | L3 状态聚合器 | 单调递增 | 状态注入的去重键（§8.3） |

**规范**
- **R-4.1**：对用户与模型，**只暴露 `sessionId` + `runId`**；其余为内部。
- **R-4.2**：`session_interrupt` 回执**必须携带 `runId`**。
- **R-4.3**：`runId` 的语义是"控制服务为这一次执行铸造的 id"；**不是** CLI 的 pid，**不是** `queuedMessageUuid`。
  一个 run 可能由多条排队消息先后触发，因此**同一 run 的标识不得从消息 id 推导**。
  〔[U] `runId` 是否在 resident 模式下跨 turn 稳定，需实测（G-10）〕
- **R-4.4**：状态注入必须携带 `runId` + `statusSeq`，使模型能判断"这条状态说的是不是同一件事"。

---

## 5. 用户交互语义

| 用户说 / 做 | 规范语义 | 反馈 |
|---|---|---|
| 继续说（执行在跑） | **append**：入队，按序执行 | 「已记下（第 N 条）」+ 队列读数 |
| **自然语言表达"想停下来"** | **不是映射**。模型解释意图，**自主决定**是否调用 `session_interrupt`；不调用则按 append 处理 | 模型自己的措辞；若调用则走 §10 的诚实回执 |
| 问「在做什么」 | 模型可以直接回答（它**已有**持续注入的状态，§8），必要时调 `session_status` 取全量 | 由模型组织 |
| **点 running 行停止键 / Esc** | **确定性** interrupt（UI 侧，不经模型） | §10 的诚实回执 |
| 点「Exit Live Voice」 | 退出语音模式，**不中断执行**，backlog 文本转入 composer [I] | 退出 + composer 出现待发文本 |
| 说「撤销 / 回滚 / 恢复」 | **不支持**：模型必须回「不支持回滚，只能停止或继续」 | 见 §11.4 |

**"停"不是协议（C-2）**：任何实现都**不得**包含停止词表、正则、或本地兜底帧。
模型是否 abort，取决于它对该轮语音的理解；判断依据随调用记录（§6.2 / §10.3）。

---

## 6. 语音控制面工具接口

语音面工具集从今天的 1 个扩到 **3 个**（send / interrupt / status）。全部遵守 I-1。

### 6.1 `session_send`（已有 [I]，扩字节读数）

```jsonc
// in : { session?: string, message: string, waitSeconds?: number }
// out: { runId: string|null, queued: boolean, queuedMessageUuid: string|null,
//        blockedBy: PendingInteraction|null, bytesAccepted: number, queueDepthBytes: number }
```
- `session` 在语音面**可选**（连接已绑定）；指名单个别的会话 → 拒绝。
- **语义不变**：只入队；**唯一**拒绝理由是超过字节预算（T1 [I]）。

### 6.2 `session_interrupt`（本期新增；T2 在飞）

```jsonc
// in : { session?: string,
//        intent: string,        // 【必填】模型自述：它认为用户想要什么（原话或转述）
//        heard?: string }       // 可选：触发判断的那段转写
// out: { stopped: true, runId: string, queuedStillPending: number, bytesStillPending: number }
//    | { stopped: false, reason: 'no-run' }     // 幂等：没在跑也算成功
```
- **唯一中止元语**（C-1）。只停 run；不关连接、不杀进程（`interruptKeepsProcess` [M]）。
- **必须绕过**中继的单飞与准入闸：不能排在它要停的东西后面。
- **幂等**：重复调用返回 `stopped:false, reason:'no-run'`，不报错。
- **回执必须诚实**：`queuedStillPending` 明确告知"还有 N 条会继续跑"。
- **`intent` 必填**是 D-2 的机械化：模型必须**说出它为什么认为该停**，使误停可审计（§10.3）。
  工具描述必须写清：**由模型判断**用户是否想停止当前执行，**没有**关键词可依。

### 6.3 `session_status`（本期新增，**主动查询全量状态**）

```jsonc
// in : { session?: string }
// out: { sessionId: string, phase: 'idle'|'running'|'awaiting-permission',
//        runId: string|null, elapsedMs: number|null, startedAt: number|null,
//        queuedItems: number, queuedBytes: number, maxBytes: number,
//        lastDelivery: { at: number, bytes: number }|null,
//        pendingInteraction: { requestId: string, toolName: string, inputSummary: string }|null,
//        statusSeq: number, at: number }
```
- 读的是 L3 聚合的**同一份**状态（§8），不是自己翻 CLI —— 避免两处读数打架。
- 这是 D-1 的**"全量"一侧**：注入给模型的是**精简**版（§8.4），需要细节时模型主动问。

**工具预算**：三个工具的**总描述**必须 ≤ 今日一个 `session_send` 描述的 2 倍；
超出则退化为"`session_status` 仅在模型主动询问时暴露"。

---

## 7. 状态机与合法转移

### 7.1 条目级（一条用户说的话）

```
spoken ──▶ admitted ──▶ queued ──▶ running ──▶ done
              │            │          │
              │            │          └──session_interrupt──▶ aborted ──▶ (队列继续)
              │            └──(CLI 取走前)──▶ withdrawn        [U: claude 不支持]
              └──over-budget──▶ refused  (终态；词保留在屏上)
```
**`aborted → queued` 是 P0 的核心边**：中断后继续说，立刻继续投递。

### 7.2 会话级

```
idle ──append──▶ queued ──CLI 取走──▶ running ──┬──▶ idle (完成)
                                                ├──session_interrupt──▶ idle  (队列仍在)
                                                └──needs-input──▶ awaiting-permission
awaiting-permission ──answered──▶ running
awaiting-permission ──session_interrupt──▶ idle
```
- **合法**：`queued` / `running` 期间均可 append（E2 [M]）。
- **非法**：`refused → running`（被拒的话**不得**由服务端偷偷重投）。
- **本期不提供**：回到先前状态的任何边（D-2 / §2.2）。

---

## 8. 状态注入与反馈（D-1 的实现契约）

### 8.1 为什么不能靠轮询 / 快照

- **轮询会过期**：今天 `useFollowSentRun` 1.5 s 一次、20 s 无 busy 就判"没起"（`useFollowSentRun.ts:4-6`）。
- **快照会误导**：C2 pack 是**每连接一次**的打包；长回合里它**必然过期**，而模型看不出自己拿的是旧快照 —— E-2 自答的土壤。

### 8.2 三条腿

| 腿 | 面向 | 机制 | 时机 |
|---|---|---|---|
| **S-A 精简注入** | **realtime 模型** | 折进 instructions 的**一行**状态，`advertiseInstructions()` 已有去重路径（B-3 [W]） | **变化即注入** + 上限节流（§8.3） |
| **S-B 全量查询** | **realtime 模型** | `session_status` 工具（§6.3） | 模型主动 |
| **S-C 事件流** | **浏览器 UI** | `/voice-realtime` socket 推送 | 变化即推 + 心跳 |

**S-A 是本 SPEC 相对 Draft-1 的实质变更**：Draft-1 把它降级成"只在工具回执里给一行"，已作废。

### 8.3 S-A 的四条约束（D-1 逐条落地）

| 约束 | 规范 |
|---|---|
| **event-driven** | 状态**变化**触发注入；**不**按固定周期无脑重发（`advertisedContext` 式去重是硬前置） |
| **去重** | 以 `(phase, runId, queuedItems, queuedBytes, pendingInteraction.requestId)` 为去重键；键不变 ⇒ **不注入** |
| **限频** | 最多 **1 次 / 2 s**；2 s 内的多次变化**坍缩为最新一条**（coalesce，不排队） |
| **有界 token** | 注入行 ≤ **200 字节 / ≤ 60 token**（含标记），且**总注入次数 ≤ 8 / run**：达到上限后停止注入并在行内标注 `(+N more, ask session_status)` |
| **陈旧标识** | 行内自带 `at=<epoch ms>` 与 `ageMs`；指令层要求模型：`ageMs > 4000` 的状态**不得**当作现状复述，必须改调 `session_status` |

**成本边界（诚实登记）**：固定上下文实测 **约 1,280 token/响应**，按"每次响应读取的 token"计费 [M]。
B-3 是**整体替换**（不累积），但每次注入都会重述整个 instructions 块 ——
G-5 的**离线臂已测**（`docs/operations/voice-realtime-status-cost.md`）：每次注入把块从 740 B 抬到
p50 940 B（+200 B），一个 76 次状态变化的长回合实注入 **43** 次、去重/限频抑制 56 次，
单 run 未触上限；但**计费 token 仍未实测**（离线不产生 token 读数）。
因此 §8.3 的"≤8 次/run"是**安全上限**而非最优值，
必须由 G-5 的**付费臂**读数校准后才可放宽。

### 8.4 注入行的形状（规范）

```
[exec] phase=running run=r-8f21 elapsed=137s queued=3/412B pending=- at=1791722000000 ageMs=0
```
- 单行、机器可读为主、允许模型摘取；`pending` 非空时填 `requestId+toolName`。
- **永不**包含会话正文、文件路径或用户原文（与 C2 pack 的日志纪律一致：**只记尺寸与来源，不记正文**）。

### 8.5 S-C 浏览器事件

| 事件 | 触发 | 载荷 |
|---|---|---|
| `status` | 变化即发 + running 时 **2 s** 心跳 | §6.3 字段 |
| `admitted` | 一条话被接受 | `deliveryId, bytes, queueDepthBytes` |
| `refused` | 超预算被拒（已有 [I]） | `reason:'queue-full', bytes, maxBytes, depth` |
| `started` / `stopped` / `done` | run 生命周期 | `runId`（+ `stopped` 带 `queuedStillPending`） |

**R-8.1**：变化必须**立即**发，不得等心跳。
**R-8.2**：`admitted` 必须在准入判定完成时发，**先于**投递完成（不被 2.5 s 窗口吞掉）。
**R-8.3**：`stopped` 的 `queuedStillPending` 必须与 §6.2 工具回执**同源**，禁止两处各算一次。
**R-8.4**：客户端渲染的每条状态带时间戳与新鲜度；**4 s**（2×心跳）未更新 ⇒ 显式降级为「状态未知」，不显示旧值。

---

## 9. busy 时的持续输入与 backlog UX

- **默认接受**；拒绝是**最后手段**（仅超字节预算），且必须**可见 + 逐条留痕**。
- bar 上：`Claude 正在处理 · mm:ss · 待投递 N 条 / M 字节`（**文本**，不只进 DOM 属性）。
- transcript 上：未投递的话语**逐条成行**并带标记；被拒的带"未发送"标记且**可重发**。
- **跨模式存活**：退出 Live Voice 后痕迹**仍在**（今天 `composerMode !== 'voice'` 时被早退）。
- **合并窗口自适应**（E-3 证据：真实流量 11/11 次未合并，白占首句 3 s 中的 2.5 s）：
  仅在**同一 `itemId` 的连续 interim** 内合并，跨 utterance 立即投递。目标首句 ≤ 1 s（§13）。

---

## 10. interrupt 的语义、队列处置与诚实回执

### 10.1 谁触发

**只有两条路**：① **模型**在理解用户意图后自主调用 `session_interrupt`；
② **用户在 UI 上**按 running 行停止键 / Esc（确定性，L1）。**没有第三条**，尤其**没有**关键词兜底（C-2）。

### 10.2 队列处置

| 问题 | 规范答案 |
|---|---|
| 停的是谁 | 当前 `runId`，**仅此一个** |
| 已排队未开始的话 | **保留**，按序继续 |
| 已交给 CLI 队列的话 | **撤不回**（`cancelQueuedInput:false` [U]） |
| 连接 / 麦克风 / backlog | **不动** |
| 停止后能否立刻再说 | **能**；backlog 首条**立即**投递 |
| 重复要求停止 | 幂等：`stopped:false, reason:'no-run'`，不产生第二条噪声回执 |

⚠️ **禁止**任何暗示"停 = 清空"的文案。

### 10.3 可审计性（D-2 的机械化）

每次 `session_interrupt` 的调用必须落一条记录（journal 新增 kind，见 G-6），含：
`runId`、`intent`（模型自述）、`heard`（可选转写）、`queuedStillPending`、时刻。
**误停因此可事后归因**：是模型理解错了，还是用户真的想停。

---

## 11. 权限、安全、幂等、乱序

### 11.1 权限与指令层
- `session_interrupt` 走与 `chat.abort` **同一个**控制服务动词 [I]，不新增第二条 abort 路径。
- 语音连接绑定会话是白名单根：任何工具指名单个别的 session 一律拒绝 [I]。
- MCP 侧标注 `destructiveHint: true` [I]；**语音面的指令层必须写清**：
  「当你判断用户想停止当前执行时，调用 `session_interrupt`；**没有**关键词可依，凭你对用户意图的理解判断。」
  ⛔ 指令层**不得**出现"如果用户说『停』就调用"这类条件式映射。

### 11.2 幂等
`session_send`：同一 `itemId` 重放不得二次投递 [I]。
`session_interrupt`：见 §10.2。`session_status`：纯读。

### 11.3 乱序
准入顺序 = 说话顺序 [I]；延迟不得重排（scripted fake 已有 delay 判据 [I]）；
上游乱序/重复/中途断连的 builder **尚缺**（G-4）。

### 11.4 文案红线
**不得**把 `revert` / `rollback` / `undo` / `回滚` / `撤销` 呈现为**可用能力**（C-1）。
用户要求回滚时，回执固定为：「不支持回滚。可以停止当前执行，或继续追加。」
理由写进实现注释：`rewindSession` 只有 Codex 有（`codex-sessions.provider.ts:1930`）；
claude 的"编辑"是 `resumeSessionAt` **重跑**（`claude-runtime.provider.ts:809-813`）；
`rewindFiles` **零调用点** ⇒ 文件副作用不可撤销。

---

## 12. 异常恢复

| 故障 | 规范行为 |
|---|---|
| 上游 realtime 断连 | `disconnected` + Retry [I]；**backlog 不得因此丢失**（转 composer [I]） |
| 执行面进程死掉 | S-A 心跳与 S-C 都停 ⇒ **4 s 后**显式"状态未知"，不假装 running（G-8） |
| run 起不来 | 显式报"没起 run"，不静默 |
| 工具调用超时 | 三态之一返回，绝不悬挂；按 `refused(timeout)` 记，**不**自动重投 |
| 权限请求挂起 | `awaiting-permission` 是一等状态；S-A 行内报 `pending=`，UI 可答 [I] |
| **注入失败**（bridge 未 open） | `advertiseInstructions()` 已按 `bridge.state` 守卫 [W]：**不丢**，在 `whenConnected` 后补发 |

---

## 13. 性能 SLO

| 指标 | 建议值 | 状态 |
|---|---|---|
| 首句：说完 → 工具调用 | ≤ 1.0 s p50 / ≤ 2.0 s p95 | **需实测**（今天含 2.5 s 窗口，实测约 2.9 s） |
| 首句：说完 → `admitted` | ≤ 1.5 s p50 | **需实测**（R-8.2 落地后） |
| 稳态：说完 → `admitted` | ≤ 0.5 s p50 | **需实测** |
| **S-A 注入延迟**（状态变化 → 上游 `session.update` 发出） | **管线 ≤ 50 ms p95**；端到端 ≤ 限频窗口 + 管线 | **已实测**：离线管线 p95 = 2 ms / n = 40（`docs/operations/voice-realtime-status-cost.md`）；端到端主导项是出厂 2 s 限频窗口 |
| **S-A 注入净成本** | ≤ 5% 的固定上下文（即 ≤ ~64 token 等效） | **仍为建议值（成本未实测）**：G-5 离线臂只测到字节（块 p50 +200 B），token 等效需付费端点；未测前只认 §8.3 的 ≤8 次/run 上限 |
| S-C 状态新鲜度 | 变化 ≤ 200 ms；心跳 2 s；4 s 降级 | **需实测** |
| `session_interrupt` → run 停止 | ≤ 1.5 s p95 | **需实测**（参考 `stopTask` ~1.0 s [M]） |
| `session_interrupt` → 回执达用户 | ≤ 2.0 s p95 | **需实测** |
| 准入判定不得阻塞 realtime 轮次 | ≤ 100 ms | [P] 硬约束 |
| 长回合（≥ 5 min）丢话数 | **0** | [P] 硬约束；E-1 反例 |

**所有"需实测"项必须在 §14 取得读数后才可写成定值。**

---

## 14. 验收矩阵

三条腿，**同一份脚本化上游**驱动全部场景（避免每 spec 一套）。

| # | 场景 | 腿 | 断言 |
|---|---|---|---|
| A-1 | 执行中连说 8 句（≈500 B） | Scripted Fake | 8 条全 admitted、0 refused、顺序=说话顺序（E-1 回归） |
| A-2 | 超预算继续投递 | Scripted Fake | `refused` 出现且**逐条可见**；已接受的不受影响 |
| **A-3** | **模型自主 abort** | Scripted Fake | **构造"用户表达想停"的轮次 ⇒ 模型调用 `session_interrupt`**；回执含 `intent`/`runId`/`queuedStillPending`；队列**未清空**；首条立刻投递 |
| **A-3b** | **不存在关键词路径（C-2 的机械证据）** | Scripted Fake | 只说「停」而**模型未调用工具**时，**不得**发生任何 abort：断言"没有第二个 abort 入口"（例如全链路仅一处 abort 调用点，且它只能由工具触发） |
| A-4 | 重复 abort | Scripted Fake | 幂等，无第二条噪声回执 |
| A-5 | abort 后 CLI 队列仍继续 | Scripted Fake | 已在队列的条目按序到达 executor（**诚实回执的机械证据**） |
| A-6 | 上游 error / 模型自答 | Scripted Fake | 浏览器收到对应 fault；executor 未被调用 |
| **A-7** | **S-A 注入：去重 / 限频 / 上限 / 陈旧** | Scripted Fake | ① 同键状态**不重复注入**；② 2 s 内多次变化**坍缩为 1**；③ 达 8 次后停止并标 `(+N more)`；④ 行内 `ageMs` 正确，`>4000` 时模型被告知不得复述 |
| **A-7b** | **S-B 全量查询** | Scripted Fake | `session_status` 返回字段完整、与 S-C 读数**同一份**（`statusSeq` 一致） |
| A-8 | S-C 事件时序 | Scripted Fake | `admitted` 先于投递完成；变化即刻推；心跳 2 s；4 s 降级 |
| A-9 | Paced Audio：中途 Mute / stop | Paced Audio | `atSample` 连续无 gap；中途 stop 后不再有新帧 |
| A-10 | 多轮密集输入（真实浏览器） | Playwright | 连说 N 轮 ⇒ 屏上逐条可见、bar 读数正确、**零云调用** |
| A-11 | stop-vs-exit | Playwright | 退出键不 abort 且 backlog 转 composer；**running 行停止键** abort（确定性路径） |
| A-12 | 会话切换 | Playwright | 切换即断连、无重复投递 |

**云 API 严禁**：三条腿必须在**无凭据**下跑通（e2e 侧显式置空 `DASHSCOPE_API_KEY`，
使"指错端点"只会 `MISSING_API_KEY`）。
**取假形态**：A-1 / A-3 / A-7 各须有一条**可红**的假形态（撤掉注入去重、撤掉 `admitted`、撤掉 abort 分支），Evidence 给出红/绿两次读数。

---

## 15. 迁移与 rollout

| 阶段 | 内容 | 门 |
|---|---|---|
| M-0 | 本 SPEC 定稿（D-1/D-2 已裁定） | ✅ 已完成（§0） |
| M-1 | T2 落地 `session_interrupt` **并移除本地停止词兜底**（G-9）+ §10.3 审计记录 | T2 现有 AC + G-9 修订 |
| M-2 | **S-A 注入**（compose+去重+限频+上限+陈旧标识） | A-7 绿 + G-5 成本读数 |
| M-3 | **S-B `session_status`** | A-7b 绿 |
| M-4 | S-C 浏览器事件 + §9.2 backlog 逐条 + §9.3 窗口自适应 | A-1/A-2/A-8 绿 |
| M-5 | 浏览器矩阵 A-10..A-12 | e2e 任务 |

**回滚开关**：S-A 注入与窗口自适应各自独立可关（默认开）；任一关闭 ⇒ 退回今天的行为。

---

## 16. 与现有 Quay tasks 的映射与缺口

| SPEC 条目 | 承载任务 | 状态 |
|---|---|---|
| §6.1 / §9.1 准入与可见 | `gap-live-voice-queue-byte-budget-and-visible-backlog` | done |
| §5 退出语义 / 确定性停止键 | `gap-live-voice-stop-vs-exit-affordances` | done |
| §6.2 / §10 `session_interrupt` | `gap-live-voice-voice-terminated-interrupt` | done（G-9 浏览器侧已解；prompt 侧见 AC-340） |
| §14 A-10..A-12 | `gap-live-voice-e2e-scripted-upstream` | done |
| §14 A-9 paced | `gap-voice-realtime-paced-audio-source` | done |
| §8 S-A / §6.3 S-B | `gap-live-voice-status-aggregate-and-inject` / `gap-live-voice-status-tool` | done |
| §18 A+ 意图控制 | GOAL-041：AC-338..AC-346（§18.6） | 已立项（2026-10-12） |
| §14 A-1..A-8 假上游 | `gap-voice-realtime-scripted-fake-upstream` | done |

### 缺口（本文识别；Draft-3 复核状态见末列括注）

> 2026-10-12 复核：G-1、G-2、G-5（离线臂）已由 done 任务覆盖；G-6 → AC-339；G-7 → E9 已实测撤回有效，G-7 的「清空队列」能力仍不做；G-9 → 浏览器侧已解、prompt 侧 → AC-340；G-10 → AC-338/AC-343 以 lifecycle 对账取代推导。G-3、G-4、G-8、G-11 维持原状。

| id | 缺口 | 影响 |
|---|---|---|
| **G-1** | **S-A 精简注入**（compose + 去重 + 限频 + ≤8/run + 陈旧标识） | D-1 的模型侧一半**整块**没任务 |
| **G-2** | **S-B `session_status` 工具** | 模型的"全量查询"没有 |
| **G-3** | **§9.2 backlog 逐条 UX + 跨模式存活** | 用户仍可能看不见自己说了什么 |
| **G-4** | scripted fake 的**重复 / 中途断连**两个 builder | §11.3 的乱序与恢复无法验 |
| **G-5** | **S-A 注入净成本实测**（每次注入的 token 与延迟） | §8.3 的 ≤8 次/run 无法校准，§13 无法定值 |
| **G-6** | journal 的 **interrupt 记录**（今天无此 kind） | §10.3 审计不成立 |
| **G-7** | `cancelQueuedInput` 对 claude 的**实测** | 决定未来"清空队列"能否成为能力（本期不做） |
| **G-8** | "执行面进程死掉"的显式状态 | 今天静默 |
| **G-9** | ⚠️ **T2 的本地停止词兜底与本 SPEC C-2/D-2 冲突**：T2 Plan 第 5 步设计"final caption 命中停止词表 ⇒ 前端直接发帧 ⇒ 立刻 abort"，这正是被否决的确定性映射 | **必须修订 T2**（移除该步），否则落地后即违反 D-2。本文只登记，不改在飞任务 |
| **G-10** | `runId` 在 **resident 模式**下跨 turn 的稳定性实测 | 决定 R-4.3 的实现 |
| **G-11** | 上游是否支持"更新而非追加"的上下文动词（`conversation.item.delete` 等） | 若支持则 S-A 可做得更省；若不支持则 §8.3 的上限是长期约束 |

---

## 17. 待决事项

**D-1 / D-2 已裁定（§0.2），不再是待决项。** 剩余：

| id | 事项 | 默认（已写入正文） |
|---|---|---|
| **D-3** | S-A 的注入上限（**8 次/run**）与限频（**2 s**）是否为最终值？ | **暂定**，待 G-5 成本实测后校准；未校准前按此执行 |
| **D-4** | G-11 若证实上游支持 item 删除/替换，是否改用"追加+删除"以换取更细粒度？ | **否**（默认继续用 B-3 整体替换）：更少的机制、已有的去重路径、不引入会触发 `response.create` 的路径 |

---

## 18. A+ 意图控制（Draft-3，2026-10-12）

### 18.1 实测事实（journal `99df08d8` × Claude transcript `c6493eb6`，2026-10-12 01:24–01:31 UTC）

| # | 事实 | 证据 |
|---|---|---|
| **F-1** | 所谓「5 分钟长回合」实为 **3 个连续回合**：01:24:07–01:26:18、01:26:18–01:28:48、01:28:48–01:31:05（各约 2–2.5 分钟） | transcript `queue-operation` enqueue/dequeue + `stop_hook_summary` |
| **F-2** | **CLI 在回合边界一次性出队并聚合进同一次请求**（transcript 记为一条 user 消息；请求线上的载体见 E10/U3）：01:26:18.519 七条语音同毫秒 dequeue，合为第 2 轮的一条输入；01:28:48 两条合为第 3 轮 | 同上 |
| **F-3** | **relay 报的队列深度失真**：`cliQueuedDeliveries` 只在 `queued:false` 时归零，回合排空时不减 ⇒ S-A 注入与 `sent` 帧报 `queued=8→9→10/576B`，真实 CLI 队列峰值 7（01:25:49），此后 ≤2 | `voice-realtime-ws-proxy.service.ts` `deliverSessionSend`；journal `status injected seq=17..22` |
| **F-4** | 撤回能力存在但未接入语音面：`cancel_async_message` E9 实测有效；relay 拿到 `queuedMessageUuid` 后丢弃 | `claude-host-driver.provider.ts` `cancelQueuedInput`；`mcp-session-cancel-queued.ts` |
| **F-5** | prompt 仍含停止词触发清单（`"stop"`、`"停"`、`"停下"`、`"别做了"`），违反 C-2；用户说「你应当能够更主动地去取消已经在执行的这些动作」时模型只回 OK 并转发，0 次 `session_interrupt` | `VOICE_REALTIME_INSTRUCTIONS`；journal 01:26:39–01:26:53 |
| **F-6** | `session_interrupt` 输入只有 `session`：§6.2 的 `intent`/`heard` 与 §10.3 审计**不存在** | `voice-realtime-tools.ts` `REALTIME_INTERRUPT_TOOL`；`mcp-session-lifecycle.ts` `SESSION_INTERRUPT_INPUT_SCHEMA` |
| **F-7** | 现中断路径是**先 abort、后释放合并窗口**：修正可能被排到「旧队列先单独成轮」之后（stale-first） | `voice-realtime-ws-proxy.service.ts` `sessionInterrupt` |
| **F-8** | 被中断那一轮的输入**仍留在 transcript**；重新提交旧内容会造成重复 | Claude transcript 语义 |
| 旁证 | 上游 118 s 静默（音频照常到达）导致 4 段话未被转发、退出后气泡消失；第 1 轮发起 `AskUserQuestion` 语音面不可答 | 与 A+ 正交，另行处理 |

### 18.2 方案比较结论（D-5）

在 F-1..F-3 的真实轨迹上做反事实：A+ 与 B 交给 Claude 的内容**完全相同**（B 在 01:26:18 一次性释放 7 条 = CLI 的自然聚合）。B 独有的收益（精确深度、可撤回）在 A+ 里可由 host lifecycle 对账（F-3 修复）与已有 `cancel_async_message` 取得；B 独有的风险（语音断线时缓冲丢失、语音与打字的跨通道顺序反转、新的投递语义与整套新测试）则没有对应收益。⇒ 采用 A+。

### 18.3 最小状态机

**一句话（`utteranceSeq`，L3 单调）**：`heard → pending(合并窗口) → enqueued(commandUuid) → started(runId) → settled(completed|interrupted)`；旁支终态 `refused` / `not-relayed` / `withdrawn`（本期不暴露）。

**一个 run（`runId`）**：`idle → running{covers:[utteranceSeq…], inFlightTool} → interrupting{by: model|ui, triggerSeq} → settled(aborted) → running(下一次出队) | idle`。
`covers` 由 host 的 `command_lifecycle` `started` 事件（`commandUuid → utteranceSeq`）得出，不由消息 id 推导（R-4.3）。

### 18.4 两条硬规则

- **G1 先入队、后中断**：一次「修正当前方向」的中断，必须先把修正文本（合并窗口里的待投递片段，或中断调用携带的修正）**送入 CLI 队列并取得入队确认**，再 abort。目标：中断后的下一轮输入 = 剩余排队消息 + 修正，按说话顺序；**stale-first 回合 = 0**。具体实现形态（中断工具携带修正 vs. 冲刷合并窗口）由 §18.6 的 U1/U2 读数决定。
- **G2 栅栏**：模型发起的中断仅当 `max(currentRun.covers) < triggerSeq` 时执行；否则返回 `{stopped:false, reason:'covered'}`，不产生第二条噪声回执。同一 `triggerSeq` 重复调用幂等。UI 停止键 / Esc 不经栅栏。

### 18.5 诚实状态与边界

- 队列深度、S-A 注入、`session_status`、`sent`/`stopped` 帧的 `queuedItems` 必须与 host lifecycle **对账**，回合边界处误差为 0（F-3）。
- 每次中断落一条 journal 记录（`kind:'interrupt'`）：`runId`、`triggerSeq`、`intent`（模型自述，必填于语音面）、`heard`、`queuedStillPending`、`inFlightTool`（读不到则显式 `null`）、`by`、`outcome`。gateway 的 `session_interrupt` 对不带这些字段的调用保持兼容。
- 中断后的下一轮附固定说明：上一轮在执行 `<inFlightTool>` 时被中断，可能存在部分改动；之后的话覆盖之前冲突的内容。⛔ 不出现 revert/rollback/undo/撤销 字样（§11.4）。
- 中断**不**调用 `stopTask`、**不**改变 `session_background` 租约、**不**触碰任何 Quay worker/driver 进程或工作树（D-9）。

### 18.6 分阶段落地

| 阶段 | 内容 | 判据 | AC / 任务 |
|---|---|---|---|
| 0a | 队列深度真实性（host lifecycle 对账；99df08d8 时间线回放夹具） | F1 | AC-338 / `gap-live-voice-queue-depth-host-lifecycle-truth` |
| 0b | 中断审计 `intent`/`heard`/`runId`/`triggerSeq` + 工具兼容 | F5 | AC-339 / `gap-live-voice-interrupt-audit-intent-trigger` |
| 0c | 清除 prompt 停止词触发规则（不扩语义） | F4 | AC-340 / `gap-live-voice-prompt-drop-stop-word-trigger` |
| 0d | 真实常驻 CLI 实验 E10：U1 中断后排队消息去向；U2 中断后出队时机与 0/50/200/1000 ms 后推入消息的落点；U3 N=3 排空拼接；U4 非最新条目撤回 | 记录 E10 节 | AC-341 / `gap-claude-resident-e10-enqueue-interrupt-drain` |
| 1a | G1 先入队后中断 + D-6 语义扩展 + 跨文本/语音顺序 | F2 | AC-342 / `gap-live-voice-interrupt-after-revision-enqueued` |
| 1b | G2 runId + utteranceSeq 栅栏、防抖、幂等 | F3 | AC-343 / `gap-live-voice-interrupt-run-utterance-fence` |
| 1c | 诚实善后：中断后状态、在途工具说明、Quay/后台任务边界 | F6 | AC-344 / `gap-live-voice-interrupt-honest-aftermath` |
| 1d | 浏览器：Scripted Fake + Paced Audio + Playwright，故障注入，跨文本/语音顺序，幂等 | A-10.. | AC-345 / `gap-live-voice-intent-control-browser-e2e` |
| 1e | 真实模型抽样（单次付费，有花费上限；报告不设门槛） | F7 | AC-346 / `gap-live-voice-interrupt-semantic-sampling` |
| 0e | 排空即刷新：回合边界无新事件也让 S-A 行与 `session_status` 归零（AC-338 落地复核发现） | — | AC-344 / `gap-live-voice-queue-depth-refresh-on-turn-boundary` |
| 0f | 能力位 `cancelQueuedInput` 与实测一致（D-11） | — | AC-350 / `gap-claude-resident-cancel-queued-capability-truth` |
| ~~2~~ | ~~语音待投递条目逐条撤回（UI 确定性按钮，D-11）~~ **已退役（2026-10-14 人裁定，见 D-11）** | — | AC-351 已 `superseded`（落地提交 `9ccdc6eb7`；后继读数载体 `voicePendingMessageCard.test.tsx`，撤回能力本身无后继） |

**E10 结论（0d 实测，2026-10-12，真实 `claude` 2.1.296 + mock 端点；读数原文见 `docs/proposals/claude-resident-sessions-experiments.md` §E10，AC-341 / `gap-claude-resident-e10-enqueue-interrupt-drain`）**

- **U1**：中断时队列里 k=1 与 k=3 条未出队消息**全部保留**——它们随「中断收尾的那一轮」请求一并送达（该请求的 user 消息里带 `[Request interrupted by user for tool use]` 工具结果 + 各条排队消息的文本块），一条都没丢。⇒ G1 的「先入队」不会因 abort 丢消息。
- **U2**：中断后 Δ=0 ms 推入的修正与旧排队消息落在**同一次请求**；**Δ≥50 ms 起 stale-first 窗口打开**——旧消息先随中断收尾那一轮出队，修正落到**再下一次请求**。⇒ G1 必须做到「修正与 abort 在同一次入队之后调用」（先 enqueue、后 abort），否则修正会晚一轮；这正是 F2 取假形态要钉的点。
- **U3**：N=3 条排队消息在回合边界被 CLI **拼成一条 `system` 角色消息**（每条各套一层 mid-turn 包裹模板 `The user sent a new message while you were working: …`），顺序按推入顺序 Q0→Q1→Q2。⛔ 载体**不是** user 消息——与 §0.3 D-5 里「聚合成下一轮的一条 user 消息」的措辞不同，实测是 system 角色的 mid-turn 通知（无中断路径）；有中断路径下则改为挂在带 `[Request interrupted by user for tool use]` 的那条 **user** 消息上。
- **U4**：`cancel_async_message` 撤回**非最新**（中间）未出队条目**生效**：被撤的中间条不再出现在任何一轮请求里，其前后两条照常送达（E9 只测了最新一条，本条补上非最新一条）。

### 18.7 可证伪判据（每条带取假形态）与 SLO

| # | 断言 | 取假形态（必须红） |
|---|---|---|
| F1 | 回放 F-1..F-3 时间线，每个采样点报出的深度 = 由出队记录推出的真实深度 | 撤掉 lifecycle 对账 ⇒ 报 8/9/10 |
| F2 | 中断瞬间即出队的假 host 下，下一轮输入含修正且顺序 = 说话/打字顺序 | 改成先 abort 后入队 ⇒ 修正落到再下一轮 |
| F3 | 同一句两次中断，第二次 `covered`；当前轮已覆盖该句时中断为空操作；UI 停止键仍生效 | 撤掉栅栏 ⇒ 两次 abort |
| F4 | 指令与工具描述中无停止词字面清单与条件式映射；A-3b 仍成立 | 放回词表 |
| F5 | 每条中断记录带 §18.5 全部字段；gateway 旧调用形态仍通过 | 删任一字段 |
| F6 | 中断前后 `session_background` 租约不变、假 Quay worker 进程存活、未调用 `stopTask` | 中断路径调 `stopTask` |
| F7 | 抽样：语义取消/改向措辞（含 F-5 原句）与「仅追加」措辞各 N 条，报中断召回率/精确率 | —（抽样，不设门槛） |

SLO：说完 → 模型调用中断 ≤ 1.0 s p95；中断 → 下一轮开始 ≤ 2.0 s p95；回合边界深度误差 = 0；stale-first 回合 = 0；模型发起的**有效**中断 ≤ 1 次/run。

**重开方案 B 的条件**：F1–F3 全绿后，F7 或真实使用中仍出现 stale-first 回合、跨通道顺序错误，或用户需要「修正前先编辑待投递内容」——任一项成立即回到 §18.2 重新比较。

---

## §19 Live Voice 的生产者与投递档位（R1/R2/R3，2026-10-17 裁定）

本节是 `gap-live-voice-stream-delivery-not-command` 落地的三条规则锚点。它们取代此前「模型是否/何时调用
`session_send`」作为投递触发的隐含契约——2026-10-17 丢输入审计（
`experiments/livevoice-discussion-transcripts-20261017/DROPPED-INPUT-AUDIT-2026-10-17.md`）证明那个契约会把
真实输入丢掉：六轮里四轮有丢，`764f0c7a` 一轮 5 句丢 3。

### R1 投递档位

- live voice 一律用 `HostInputPriority = 'next'`（并入在飞回合，在下一个工具边界合流）；
  `VOICE_BUSY_RELEASE_PRIORITY = 'next'`（`voice-realtime-ws-proxy.service.ts`），busy 的静窗释放与打断
  更正都带它。
- idle 投递**不写 tier**（立即开回合）。
- 绝不发送 `now`：`grep -rn "priority: 'now'" server/ --include=*.ts` 只命中类型定义/校验函数/快照归一化，
  没有 shipped 投递路径发送它。
- 残留边界：`next` 仍受「当前回合没有工具边界」约束；需要「尽快消费」的人工强干预仍然只有
  `session_interrupt`。

### R2 发送触发：确定性 settle 边界，不是模型

- 生产端是**中继**，不是模型。每一条 FINAL transcription 进入 per-session span 并启动 settle 窗口
  （`VOICE_SPAN_SETTLE_MS`，生产 2.5 s）。
- 窗口内到达的模型 response 是**质量臂**：其文本整体作为该 span 的投递（`session_send` 仍走同一条
  `control.send` 控制面）。
- 窗口内没有 response，则为**确定性臂**：endpoint 自己的 final 逐字、按说话顺序、整 span 作为**一条**消息投递。
- 无论哪一臂，投递被接受时 watermark 前移（`transcribedSinceWatermark` 清空、`speechEpoch` 记账），
  因此同一个 span 不会被投递第二次。没有新的语音时，模型再发调用只有在**复述近期已投递文本**时才被拒——
  这是「不为一次猜测丢掉用户真说的话」与「同一 span 不二次投递」两条要求的共同解。
- 空转写（endpoint 明确报告零字）不投递；它只推进 watermark。

### R3 切分不变性

- 同样的文本分/不分更细的小节被 Claude Code 收到并处理，行为语义无显著差异。允许粗合并、允许按 settle
  边界成条。
- 因此删除了按切分补偿的启发式：`voice-realtime-fragment-coverage.ts`（0.5 相邻字对覆盖阈值、
  `MIN_JUDGED_CHARACTERS = 5`、fragment 概念）与 `voice-realtime-span-guard.ts`（含
  `VOICE_REALTIME_SPAN_GUARD` 开关）**不再存在**，投递路径不比较 response 与 transcript 的字面重合。
- 表示层的同一条规则：语音投递的 `source` 是 `'voice'`（`ChatRunSource` / `ActivityDeliverySource`），
  客户端不为它画可撤回的 `PendingResidentMessage`；等待由只读的 `VoicePendingMessageCard` 表示，消息本身
  是 transcript 里的真实 user 行。

---

## 附录 A：术语

| 词 | 含义 |
|---|---|
| append | 追加一条指令（今天的 `session_send`） |
| interrupt | 停止**当前** run；不销毁会话、不清队列；**由模型自主决定或 UI 确定性触发** |
| cancel queued | 撤回尚未开始的排队条目（claude 不支持 [U]；本期不扩充） |
| steer / fork / rollback | **本期非目标**；rollback 另有 §11.4 的文案红线 |
| S-A / S-B / S-C | 精简注入（模型） / 全量查询（模型工具） / 事件流（浏览器） |

## 附录 B：证据索引

| 编号 | 证据 |
|---|---|
| E-1 | 会话 `9db75ad5`；journal `~/.cloudcli/voice-realtime-log/faeb9c61-…jsonl` |
| E-2 | 会话 `891da48b`；journal `~/.cloudcli/voice-realtime-log/c8b0ee15-…jsonl` |
| E-3 | 会话 `d88c6722`（`server.log`，11 次 `coalesced 1`） |
| 线协议边界 | `voice-realtime-bridge.service.ts:46-70`（6 成员联合体）· `voice-realtime-dashscope-transport.ts:383-417`（映射；`function_call_output` 焊 `response.create`）· `voice-realtime-ws-proxy.service.ts:737-752`（**已有的 compose+去重注入路径**） |
| 成本锚点 | `voice-realtime-tools.ts:290-291`（固定上下文 ~1,280 token/响应，按响应读取计费） |
| 能力矩阵 | `provider-capabilities.service.ts:105-215` |
| 回滚真相 | `claude-runtime.provider.ts:809-813` · `claude-fork.provider.ts` · `claude-host-driver.provider.ts:332` · `codex-sessions.provider.ts:1930` |
| 轮询追赶 | `src/modules/chat/voice-realtime/useFollowSentRun.ts:1-90` |
