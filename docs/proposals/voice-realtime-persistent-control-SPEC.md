# Live Voice 持续控制面 SPEC

**P0 = 持续输入 + 可中断 + 实时状态反馈**

| 项 | 值 |
|---|---|
| 状态 | Draft（待人裁定 §17 两项） |
| 基线 | `develop` @ `cf160d06`（2026-10-11） |
| 范围 | 控制面语义、工具接口、状态机、时序、验收矩阵 |
| 非范围 | Steer / Fork / Rollback（本期非目标，见 §2.2） |

> 本文只描述**规范**。每条事实标注来源等级：
> **[M]** 已实测（有 journal / 日志 / 测试读数）· **[I]** 已实现（代码在 develop）·
> **[U]** 未测量（能力槽保守取 false）· **[P]** 本文提案。

---

## 1. 问题与实测基线

### 1.1 主路径被当成异常

Claude Code 的一次执行（数十秒到数分钟）远长于语音句间隔（秒级）。因此
**「一次执行未结束时连续收到多轮语音」是主路径，不是边角**。今天的实现把它当异常处理：
中继在 `sending` 时直接抛 `A previous voice instruction is still being sent.`
（`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:799-813`），靠 busy-wait
（2 s / 120 s）与 2500 ms 合并窗口去凑时序。

而底层本来支持这条路：resident 进程的能力矩阵里
**`inputWhileBusy: true`（E2 实测）** —— 接受输入的同时可以继续跑
（`server/modules/providers/services/provider-capabilities.service.ts:147`）。

### 1.2 三次实测（基线证据）

| # | 时间 | 会话 / journal | 现象 |
|---|---|---|---|
| E-1 | 2026-10-11 19:22–19:30 | `9db75ad5` / `faeb9c61` | Claude 回合约 **4 分钟**；其后 8 句**全部被拒**（`session_send refused: VOICE_QUEUE_FULL depth=3 max=3`），从未进入会话；8 句合计 **< 500 字节**。屏上只剩 3 条已投递行 |
| E-2 | 2026-10-11 19:51–19:58 | `891da48b` / `c8b0ee15` | 7 句中第 2–7 句，上游模型回文本 `"OK"` 而**不调用工具** ⇒ `MODEL_TEXT_REPLY (recoverable)` ×6；连接 `mode=continuous` |
| E-3 | 2026-10-11 17:3x | `server.log` 连接 `d88c6722` | 11 次投递里 `coalesced … relayed piece(s)` **恒为 1** ⇒ 2500 ms 窗口在真实流量中未合并过任何东西，是纯等待 |

语音链路自身不慢：E-1 里说完 → 0.4 s 后模型调用 `session_send` → 2.5 s 合并窗口 → 29 ms 投递完成。
**慢的是"排队等我"**，而这一点当时对用户不可见（`queuedDepth` 只进 `data-queued-depth`
属性，从不作为文本渲染）。

### 1.3 已落地 / 在飞（写入本文时）

| 任务 | 状态 | 落地内容 |
|---|---|---|
| `gap-live-voice-queue-byte-budget-and-visible-backlog` | **done** | 准入轴由「条数」改为 **UTF-8 字节预算**：`VOICE_QUEUE_MAX_BYTES`、`bytesOf()` = `Buffer.byteLength`、seam `maxQueuedVoiceBytes`；拒收日志 `… bytes=${bytes} max=${maxBytes} depth=${depth}` [I] |
| `gap-live-voice-stop-vs-exit-affordances` | **done** | 退出键改「Exit Live Voice」（`aria-label={t('voice.realtime.exit')}`）；running 行新增停止键（`ChatMessagesPane` 的 `onStopTurn` / `onStop`）[I] |
| `gap-voice-realtime-scripted-fake-upstream` | **done** | 离线脚本化假上游 + 8 条场景判据；真 transport + 真 proxy；`fileAudioSource` 微任务 yield 未动 [I] |
| `gap-live-voice-voice-terminated-interrupt` | **ready（在飞）** | 语音面 `session_interrupt` |
| `gap-voice-realtime-paced-audio-source` | **ready（在飞）** | 实时节拍音源 |
| `gap-live-voice-e2e-scripted-upstream` | todo（依赖上一条 interrupt 任务） | 浏览器多场景 |

### 1.4 能力矩阵（决定哪些语义**可以**写进规范）

| 能力 | 值 | 来源 |
|---|---|---|
| `inputWhileBusy`（忙时接受输入） | **true** | [M] E2 |
| `interruptKeepsProcess`（中断不杀进程） | **true** | [M] E4 |
| `stopTask`（停后台任务，约 1.0 s 内 `status:'killed'`） | **true** | [M] 2026-10-04 真实 resident query |
| `liveReconfigure`（热改） | `['model','permissionMode']` | [M] AC-272 |
| `cancelQueuedInput`（撤回**已排队未开始**的消息） | **false** | [U] 未测量 ⇒ 保守 false |
| `backgroundTasks`（列后台任务，SDK 动词） | **false** | [U] 未测量 |
| `supportsAbort` | true | [I] |
| `supportsMessageEditing`（= `resumeSessionAt` 重跑） | true | [I] |
| `supportsSessionForking`（= `forkSession` 复制 transcript 前缀到新会话） | true | [I] |
| `rewindFiles`（SDK 的**文件**回滚动词） | **存在但零调用点** | [I] 仅出现在 `claude-host-driver.provider.ts:332` 的注释里 |

MCP gateway 现有 18 个工具（`overview` / `projects_list` / `quay_snapshot` / `run_get` /
`session_{cancel_queued,close,create,get,interrupt,read,search,send,start}` / `sessions_list` /
`ui_{clients_list,last_opened_session,selected_text,visible_context}`）＋ `session_background`（AC-273）[I]。
**语音面只挂 `session_send`**（`voice-realtime-tools.ts:303` 的 filter）[I]。

---

## 2. 目标与非目标

### 2.1 目标（P0）

1. **持续输入**：执行在跑时，用户说的话**默认全部被接受**，按序、可追溯、可见。
2. **可中断**：用户能用语音（与 UI）**停止当前执行**，且**不破坏会话、不丢未执行的话**。
3. **实时状态反馈**：用户与语音模型都能**持续读到**执行面在做什么（不是快照、不是轮询）。

### 2.2 非目标（本期明确不做）

| 项 | 原因 |
|---|---|
| **Steer**（边跑边改方向） | 无底层语义；近似只能 append（下一轮生效）或 interrupt+append |
| **Fork**（从语音分叉会话） | 有实现（`forkSession`）但语义重（新 session id / 新 transcript），不在 P0 |
| **Rollback / Undo** | **技术上一半不成立**：`rewindSession` 只有 Codex 有；claude 的"编辑"是 `resumeSessionAt` **重跑**；`rewindFiles` 零调用点 ⇒ **文件回滚今天做不到**。禁止在 UI/语音文案里出现 revert/rollback/undo 字样（见 §11.4） |
| 多会话/跨项目语音 | 见 §12 的恢复语义保留接口，不实现 |
| 队列撤销（cancel queued） | `cancelQueuedInput: false` [U]；且文本可能已被 CLI 取走 |

---

## 3. 角色分层

```
┌─ 用户（说 / 听 / 看）
│
├─ L1 浏览器 UI ── 采集、字幕、bar/running 行、backlog 呈现        [I]
│
├─ L2 实时语音链路 ── /voice-realtime WS → relay → realtime 模型    [I]
│     · 语音模型只做「转写 + 提议工具调用」，不做决策
│
├─ L3 控制面（本 SPEC 的主体）                                     [P]
│     · 准入（字节预算）[I]  · 排序/合并 [I]  · 工具语义 [部分]
│     · **状态聚合与推送** [P]
│
├─ L4 控制服务（ChatControlService）                               [I]
│     · abort / cancelQueued / stopTask 的单一动词层
│
└─ L5 执行面：resident claude 进程（cloudcli-resident.slice）      [I]
      · CLI 自有队列；`inputWhileBusy` [M]；`interruptKeepsProcess` [M]
```

**分层不变量**
- **I-1**：L2/L3 **永不阻塞**在 L5 上。任何工具调用必须在有限时间内返回三态之一
  （accepted / refused / stopped），不得 busy-wait 到执行结束。〔[P] 取代今天的 `:816-817` busy-wait〕
- **I-2**：L5 的繁忙只影响 L3 的**读数**，不影响 L3 能否写入（append）。
- **I-3**：L1 只呈现 L3 推送的事件；**不得**自行轮询推导状态（取代 `useFollowSentRun` 的 1.5 s 轮询作为**状态**来源，它可以保留为**transcript 追赶**手段）。

---

## 4. 身份模型

| 身份 | 由谁铸造 | 生命周期 | 稳定性 |
|---|---|---|---|
| `itemId`（utterance） | realtime 端点 | 一次说话 | 端点上，不可跨连接 |
| `sessionId`（应用会话） | app（`POST /api/providers/sessions`） | 长期 | **对用户可见的稳定 id** |
| `providerSessionId` | CLI/SDK | 会话级 | fork 后变化 |
| `runId` | 控制服务 | 一次执行 | 唯一能标识「正在跑的那件事」 |
| `queuedMessageUuid` | CLI 队列（`session_send` 返回） | 排队条目 | 撤回要靠它（但 claude 不支持 [U]） |
| `deliveryId`（中继侧） | relay | 一次投递（可能含多 utterance） | 内部；对 UI 只作行标记 |

**规范要求**
- **R-4.1**：对用户与语音模型，**只暴露 `sessionId` + `runId`**；其余为内部实现细节。
- **R-4.2**：`interrupt` 的**回执必须携带被停的 `runId`**，否则用户无法区分「停了刚才那次」与「停了别的东西」。
- **R-4.3**：`queued` 条目在 UI 上必须**逐条可见**（[I] T1 已引入 depth 读数；逐条化见 §9）。

---

## 5. 用户交互语义

| 用户说 / 做 | 规范语义 | 反馈（见 §8） |
|---|---|---|
| 继续说（执行在跑） | **append**：入队，按序执行 | 「已记下（第 N 条）」+ 队列读数 |
| 「停」/ 点 running 行停止键 | **interrupt**：停当前 run；**队列保留** | 「已停止 `<runId 摘要>`；已排队的 N 条会继续」 |
| 问「在做什么」 | **status**：读回当前 run 摘要 | 一行：`<状态> · 已跑 mm:ss · 排队 N 条` |
| 点「Exit Live Voice」 | 退出语音模式，**不中断执行**，backlog 文本转入 composer（[I] T3 语义） | 退出 + composer 出现待发文本 |
| 说「撤销 / 回滚 / 恢复」 | **不支持**：TTS 明确回「不支持回滚，只能停止或继续」 | 见 §11.4 |

**默认（写入实现）**：`interrupt` **只停当前 run**。清空队列是**另一个**命令，
本期**不提供**（`cancelQueuedInput: false` [U]），语音面**不得**暗示"停 = 清空"。

---

## 6. 语音控制面工具接口

语音面工具集从今天的 1 个扩到 **3 个**。每个都遵守 I-1（有限时间返回）。

### 6.1 `session_send`（已有 [I]）

```jsonc
// in : { session?: string, message: string, waitSeconds?: number }
// out: { runId?: string, queued: boolean, queuedMessageUuid: string|null,
//        blockedBy: PendingInteraction|null, bytesAccepted: number, queueDepthBytes: number }
```
- `session` 在语音面**可选**（连接已绑定会话）；指名单个别的会话 → 拒绝。
- **语义不变**：只入队，永不因为"会话忙"而拒绝；唯一拒绝理由是**超过字节预算**（T1 [I]）。
- 新增字段 `bytesAccepted` / `queueDepthBytes` 为 §8 的状态推送提供读数。

### 6.2 `session_interrupt`（本期新增；T2 在飞）

```jsonc
// in : { session?: string, reason?: string }
// out: { stopped: true,  runId: string, queuedStillPending: number, bytesStillPending: number }
//    | { stopped: false, reason: 'no-run' }        // 幂等：没在跑也成功
```
- **只停 run**；不关连接、不杀进程（`interruptKeepsProcess` [M]）。
- **必须绕过**中继的单飞与准入闸：它不能排在它要停的东西后面。
- **幂等**：重复调用返回 `stopped:false, reason:'no-run'`，不得报错。
- **回执必须诚实**：`queuedStillPending` 明确告知"还有 N 条会继续跑"。

### 6.3 `session_status`（本期新增）

```jsonc
// in : { session?: string }
// out: { phase: 'idle'|'running'|'awaiting-permission',
//        runId: string|null, elapsedMs: number|null,
//        queuedItems: number, queuedBytes: number,
//        lastDelivery: { at: number, bytes: number }|null,
//        pendingInteraction: { requestId, toolName, inputSummary }|null }
```
- 读的是 L3 聚合的**同一份**状态（§8），不是自己去翻 CLI —— 避免"两处读数不一致"。
- 语音模型**不需要**主动轮询它：状态由 §8 的推送送进去（见 R-8.4 的 token 取舍）。

**工具预算**：语音面每次响应都要付工具描述的 token。三个工具的**总描述**必须压到
≤ 今日一个 `session_send` 的 2 倍以内；超过则退化为"`session_status` 只在被问时暴露"。

---

## 7. 状态机与合法转移

### 7.1 条目级（一条用户说的话）

```
spoken ──▶ admitted ──▶ queued ──▶ running ──▶ done
              │            │          │
              │            │          └──interrupt──▶ aborted ──▶ (队列继续)
              │            └──(CLI 取走前)──▶ withdrawn        [U: claude 不支持]
              └──over-budget──▶ refused  (终态；词保留在屏上)
```

### 7.2 会话级（执行面）

```
idle ──append──▶ queued ──CLI 取走──▶ running ──┬──▶ idle (完成)
                                                ├──interrupt──▶ idle  (≠ 清空：队列仍在)
                                                └──needs-input(权限/提问)──▶ awaiting-permission
awaiting-permission ──answered──▶ running
awaiting-permission ──interrupt──▶ idle
```
- **合法**：`queued` 与 `running` 期间均可 append（E2 [M]）。
- **非法**：`refused → running`（被拒的话不会自动重试——不得由服务端偷偷重投）。
- **本期不提供**：`running → <先前的某个状态>`（无 rollback）。

---

## 8. 流式状态反馈事件与时序

### 8.1 为什么不能靠轮询 / 快照

- **轮询会过期**：今天 `useFollowSentRun` 1.5 s 一次、20 s 未起 run 就判"没起"（`useFollowSentRun.ts:4-6`）。
  在 4 分钟的长回合里，读数与真实状态之间的落差可达秒级，且用户看到的是"没有变化"。
- **快照会误导**：C2 context pack 是**每连接一次**的打包（`voiceContextPack`），
  它把"连接那一刻"的会话状态写进 instructions。长回合里它**必然过期**，
  而语音模型看不出自己拿的是旧快照——这正是 E-2 里模型开始瞎猜（`"Still working on it"`）的土壤。

### 8.2 事件（服务端 → 浏览器，复用 `/voice-realtime` socket）

| 事件 | 触发时机 | 载荷 |
|---|---|---|
| `status` | **状态变化即发** + running 时 **2 s 心跳** | §6.3 的字段 |
| `admitted` | 一条话被接受 | `deliveryId, bytes, queueDepthBytes` |
| `refused` | 超预算被拒（已有 [I]） | `reason:'queue-full', bytes, maxBytes, depth` |
| `started` | 该 run 真正开始 | `runId, startedAt` |
| `stopped` | interrupt 生效 | `runId, queuedStillPending` |
| `done` | run 结束 | `runId, outcome` |

### 8.3 时序要求

- **R-8.1**：`status` 的心跳周期 **2 s**；任何**变化**必须**立即**发（不得等到心跳）。
- **R-8.2**：`admitted` 必须在**准入判定完成的那一刻**发，**先于**投递完成 —— 让"我说的话进去了"这件事不被 2.5 s 合并窗口吞掉。
- **R-8.3**：`stopped` 的载荷必须与 `session_interrupt` 的工具回执**同源**（同一个 `queuedStillPending` 数字），禁止两处各算一次。
- **R-8.4（token 取舍）**：状态**推送进浏览器**永远开；**推进语音模型上下文**只在两种时机：① 每次工具回执里附一行状态；② `status` 由模型主动问时返回。**不做** per-response 的常驻注入。

### 8.4 陈旧读数的兜底

- 客户端渲染的每个状态行必须带**时间戳**与**新鲜度**读数；超过 **2×心跳（4 s）** 未更新 ⇒
  显式降级为「状态未知」而不是继续显示旧值。
- 语音模型侧同理：工具回执里的状态行带 `at`；模型若读到 `at` 明显早于当前对话轮，**不得**把它当现状复述。

---

## 9. busy 时的持续输入与 backlog UX

### 9.1 默认行为

- **默认接受**。执行在跑时继续说 ⇒ 全部入队（受字节预算约束），
  **不是**"忙即拒"。
- 拒绝是**最后手段**：仅在超预算时发生，且必须**可见 + 逐条留痕**。

### 9.2 backlog 呈现（[I] T1 已有基础，本 SPEC 收紧）

- bar 上：`Claude 正在处理 · mm:ss · 待投递 N 条 / M 字节`（**文本**，不是只进 DOM 属性）。
- transcript 上：未投递的话语**逐条成行**，带"待投递"标记；被拒的带"未发送"标记且**可重发**。
- **跨模式存活**：退出 Live Voice 后，未投递/被拒的痕迹**仍在**（今天是 `composerMode !== 'voice'` 时被早退掉）。

### 9.3 合并窗口的取舍

E-3 实测：真实流量下 2500 ms 窗口**从未合并过**（11/11 次 `coalesced 1`），
即它是纯等待，并且占据了首句延迟 3 s 中的 2.5 s。
**建议（需实测确认）**：把窗口改为**自适应**——仅在**同一 itemId 的连续 interim** 内合并，
跨 utterance 立即投递；首句路径目标 ≤ 1 s（见 §13）。

---

## 10. interrupt 后的队列处置与诚实回执

| 问题 | 规范答案 |
|---|---|
| 停的是谁 | 当前 `runId`。**仅此一个**。 |
| 已排队但未开始的话 | **保留**，按序继续。 |
| 已交给 CLI 队列的话 | **撤不回**（`cancelQueuedInput: false` [U]）。 |
| 连接 / 麦克风 / backlog | **不动**。 |
| 回执 | 「已停止 `<runId>`；已排队的 N 条会继续」——N 与 §8.3 同源。 |
| 停止后能不能立刻再说 | **能**；且 backlog 首条应**立即**投递（不等下一个窗口）。 |
| 重复说"停" | 幂等：`stopped:false, reason:'no-run'`，不报错、不产生第二条回执噪声。 |

⚠️ **禁止**任何暗示"停 = 清空"的文案。

---

## 11. 权限、安全、幂等、乱序

### 11.1 权限
- `session_interrupt` 走与 `chat.abort` **同一个**控制服务动词 [I]；不新增第二条 abort 路径。
- 语音连接的会话绑定是白名单根：任何工具**指名单个别的 session 一律拒绝**（[I] 既有约束）。
- `session_interrupt` 的 MCP 侧标注为 `destructiveHint: true`（既有 [I]）；语音面必须在**指令层**要求模型：只在用户明确要求停止时调用。

### 11.2 幂等
- `session_send`：同一 `itemId` 的重放不得产生第二次投递（[I] 既有 segment 重放门）。
- `session_interrupt`：见 §10。
- `session_status`：纯读。

### 11.3 乱序
- **准入顺序 = 说话顺序**（[I] 既有 FIFO 与 `waitingExtraMessages` 拼接）。
- 延迟不得重排（[I] 已有判据：scripted fake 的 delay 场景）。
- 上游事件乱序 / 重复 / 中途断连：scripted fake 已具备 delay 能力 [I]；
  **重复与断连两个 builder 尚缺**（见 §16 缺口 G-4）。

### 11.4 安全与文案红线
- **不得**在 UI / 语音 / 工具描述中出现 `revert` / `rollback` / `undo` / `回滚` / `撤销` 作为**可用能力**。
- 用户若要求回滚，回执必须是：「不支持回滚。可以停止当前执行，或继续追加。」
- 理由（写进实现注释）：`rewindSession` 只有 Codex 实现（`codex-sessions.provider.ts:1930`）；
  claude 的"编辑"是 `resumeSessionAt` **重跑**（`claude-runtime.provider.ts:809-813`）；
  `rewindFiles` **零调用点** ⇒ **文件副作用无法撤销**。说"回滚"会让用户以为磁盘也回去了。

---

## 12. 异常恢复

| 故障 | 规范行为 |
|---|---|
| 上游 realtime 断连 | 已实现的 `disconnected` + Retry；**backlog 不得因此丢失**（转入 composer，[I] T3 语义） |
| 执行面进程死掉 | `status` 心跳停止 ⇒ 4 s 后 UI 显式"状态未知"；不假装 running |
| run 起不来（`useFollowSentRun` 的 20 s 无 busy） | 显式报"没起 run"而不是静默 |
| 工具调用超时 | 三态之一返回，绝不悬挂；超时按 `refused(timeout)` 记，**不**自动重试投递 |
| 权限请求挂起 | `awaiting-permission` 是**一等状态**：状态推送必须报出 `pendingInteraction`，语音面可读、UI 可答（[I] 已有 banner） |

---

## 13. 性能 SLO

| 指标 | 建议值 | 状态 |
|---|---|---|
| 首句：说完 → 工具调用 | ≤ 1.0 s p50 / ≤ 2.0 s p95 | **需实测**（今天含 2.5 s 合并窗口，实测约 2.9 s） |
| 首句：说完 → 浏览器 `admitted` | ≤ 1.5 s p50 | **需实测**（R-8.2 落地后） |
| 稳态：说完 → `admitted` | ≤ 0.5 s p50 | **需实测** |
| `status` 新鲜度 | 变化 ≤ 200 ms 内推送；心跳 2 s | **需实测**（R-8.1） |
| `interrupt` → run 停止 | ≤ 1.5 s p95 | **需实测**；参考 `stopTask` 实测 ~1.0 s [M] |
| `interrupt` → 回执到达用户 | ≤ 2.0 s p95 | **需实测** |
| 准入判定不得阻塞 realtime 轮次 | ≤ 100 ms | [P] 硬约束 |
| 长回合（≥ 5 min）下不许丢话 | 丢话数 = 0 | [P] 硬约束；E-1 反例 |

**所有"需实测"项必须在 §14 的验收矩阵里取得读数后才可写入 SLO 定值。**

---

## 14. 验收矩阵

三条腿，缺一不可。**同一份脚本化上游**驱动全部场景（避免每个 spec 各写一套）。

| # | 场景 | 腿 | 断言（不变量） |
|---|---|---|---|
| A-1 | 执行中连说 8 句（≈500 B） | Scripted Fake | 8 条全 admitted、0 refused、顺序 = 说话顺序（E-1 回归） |
| A-2 | 超预算继续投递 | Scripted Fake | `refused` 出现且**逐条可见**；已接受的不受影响 |
| A-3 | interrupt 后继续说 | Scripted Fake | `stopped` 回执含 `queuedStillPending`；队列**未清空**；首条立刻投递 |
| A-4 | 重复说"停" | Scripted Fake | 幂等，无第二条噪声回执 |
| A-5 | abort 后 CLI 队列仍继续 | Scripted Fake | abort 不影响已在队列的条目按序到达 executor（**诚实回执的机械证据**） |
| A-6 | 上游自报 error / 模型自答（MODEL_TEXT_REPLY） | Scripted Fake | 浏览器收到对应 fault；executor 未被调用 |
| A-7 | 状态事件时序 | Scripted Fake | `admitted` 先于投递完成；变化即刻推；心跳 2 s；陈旧 4 s 降级 |
| A-8 | Paced Audio：播放中途 Mute / stop | Paced Audio | `atSample` 连续无 gap；中途 stop 后不再有新帧 |
| A-9 | 多轮密集输入（真实浏览器） | Playwright | 真实浏览器 + 真 proxy + 共享假上游：连说 N 轮 ⇒ 屏上逐条可见、bar 读数正确、零云调用 |
| A-10 | stop-vs-exit | Playwright | 退出键不 abort 且 backlog 转 composer；running 行停止键 abort |
| A-11 | 会话切换 | Playwright | 切换即断开连接、无重复投递 |

**云 API 严禁（默认）**：三条腿都必须在**无凭据**下跑通——
e2e 侧显式置空 `DASHSCOPE_API_KEY`，使"指错端点"只会 `MISSING_API_KEY` 而不是拨向真端点。

**取假形态要求**：A-1 / A-3 / A-7 各须有一条**可红**的假形态（例如撤掉 interrupt 的分支、或撤掉 `admitted` 帧），并在 Evidence 里给出红/绿两次读数。

---

## 15. 迁移与 rollout

| 阶段 | 内容 | 门 |
|---|---|---|
| M-0 | 本 SPEC 定稿（§17 两项裁定） | 人 |
| M-1 | T2 落地（语音面 `session_interrupt`）+ §10 诚实回执 + journal 记 interrupt | T2 现有 AC |
| M-2 | `session_status` + §8 状态推送（浏览器先行） | A-7 绿 |
| M-3 | §9.2 backlog 逐条 UX + §9.3 合并窗口自适应 | A-1/A-2 绿 + 首句 SLO 读数 |
| M-4 | 模型侧状态注入（R-8.4 的两种时机） | A-6 不再出现自答噪声 |
| M-5 | 浏览器验收矩阵 A-9..A-11 | e2e 任务 |

**回滚开关**：状态推送与自适应窗口各自独立可关（默认开）；任一开关关闭时行为退回今天。

---

## 16. 与现有 Quay tasks 的映射与缺口

| SPEC 条目 | 承载任务 | 状态 |
|---|---|---|
| §6.1 / §9.1 准入与可见 | `gap-live-voice-queue-byte-budget-and-visible-backlog` | done |
| §5 退出语义 / running 行停止键 | `gap-live-voice-stop-vs-exit-affordances` | done |
| §6.2 / §10 interrupt | `gap-live-voice-voice-terminated-interrupt` | **在飞** |
| §14 A-9..A-11 | `gap-live-voice-e2e-scripted-upstream` | todo（依赖上一条） |
| §14 A-8 paced | `gap-voice-realtime-paced-audio-source` | **在飞** |
| §14 A-1..A-7 假上游 | `gap-voice-realtime-scripted-fake-upstream` | done |

**缺口（本文识别，尚未有任务）**

| id | 缺口 | 影响 |
|---|---|---|
| G-1 | **§8 状态推送**（`status`/`admitted`/`started`/`stopped`/`done` 事件 + 心跳 + 陈旧降级） | P0 的"实时状态反馈"**整块**没任务 |
| G-2 | **§6.3 `session_status` 工具** | 语音模型无从读状态（E-2 根因） |
| G-3 | **§9.2 backlog 逐条 UX + 跨模式存活** | 用户仍可能"看不见自己说了什么" |
| G-4 | scripted fake 的 **重复 / 中途断连** 两个 builder | §11.3 的乱序与恢复无法验 |
| G-5 | §13 SLO **实测**（首句延迟 / status 新鲜度 / interrupt 时延） | SLO 目前全是建议值 |
| G-6 | journal 里 **interrupt 记录**（今天没有这条 kind） | §10 的回执无法审计 |
| G-7 | `cancelQueuedInput` 对 claude **实测**（决定"清空队列"能否成为能力） | 影响未来是否提供 clear |
| G-8 | §12 "执行面进程死掉" 的显式状态 | 今天会静默 |

---

## 17. 待决事项（2 项，已给默认值）

### D-1 状态反馈给**语音模型**的代价边界？

常驻把状态注入模型上下文，会让**每次响应**都多付 token（今天的工具面就是为省 token 才砍到 1 个工具）。
- **默认（写入 §8 R-8.4）**：浏览器侧**全量推送**；模型侧只在**工具回执**里附一行状态 + 模型主动问时返回。
  即：**不为状态付常驻 token**。
- 备选：允许一段 ≤ 80 token 的常驻状态行（换取模型更少瞎猜）。**代价**：每响应 +80 token；E-2 那类自答是否会因此消失，需实测。

### D-2 「停」的默认边界：只停当前 run，还是连队列一起停？

- **默认（写入 §5 / §10）**：**只停当前 run，队列保留**。理由：P0 的语义是"可中断 + 持续输入"，
  而 `cancelQueuedInput: false` [U] 让"清空"今天**做不到**；承诺一个做不到的语义比不承诺更糟。
- 备选：把"清空"做成**独立命令**（需要先实测 G-7，且必须回执"其中有 K 条已经交给执行面、撤不回"）。

---

## 附录 A：术语

| 词 | 含义 |
|---|---|
| append | 追加一条指令到执行面（今天的 `session_send`） |
| interrupt | 停止**当前** run，不销毁会话、不清队列 |
| cancel queued | 撤回**尚未开始**的排队条目（claude 不支持 [U]） |
| steer | 改变正在跑的方向（**本期非目标**；无底层语义） |
| fork | 复制 transcript 前缀到新会话（**本期非目标**） |
| rollback | 回到先前状态（**本期非目标**；文件侧做不到，见 §11.4） |

## 附录 B：证据索引

| 编号 | 证据 |
|---|---|
| E-1 | 会话 `9db75ad5`；journal `~/.cloudcli/voice-realtime-log/faeb9c61-7af6-4fe3-8064-74ce421e68ed.jsonl` |
| E-2 | 会话 `891da48b`；journal `~/.cloudcli/voice-realtime-log/c8b0ee15-808f-4bb9-9fde-597e8f6e7f98.jsonl` |
| E-3 | 会话 `d88c6722`（`server.log`，11 次投递 `coalesced 1`） |
| 能力矩阵 | `server/modules/providers/services/provider-capabilities.service.ts:105-215` |
| 中继 | `server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts`（`VOICE_QUEUE_MAX_BYTES` / `bytesOf` / `queuedDepth`） |
| 桥 | `server/modules/voice-realtime/voice-realtime-bridge.service.ts:690-756`（fault 与 caption 字段名） |
| 语音工具面 | `server/modules/voice-realtime/voice-realtime-tools.ts:288-306` |
| 轮询追赶 | `src/modules/chat/voice-realtime/useFollowSentRun.ts:1-90` |
| 回滚真相 | `claude-runtime.provider.ts:809-813`（resumeSessionAt）· `claude-fork.provider.ts`（fork）· `claude-host-driver.provider.ts:332`（rewindFiles 仅注释）· `codex-sessions.provider.ts:1930`（唯一 rewindSession） |
