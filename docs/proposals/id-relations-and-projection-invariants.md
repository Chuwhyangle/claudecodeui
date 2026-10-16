# 身份关系与事实投影不变量（审查文档）

| 项 | 值 |
|---|---|
| 状态 | **审查稿（review）**——本文件是**契约**，不是实现；裁定记录见 §0（R-1 独立审查已记，人签核位待填） |
| 基线 | `develop` @ `97a797d0`（2026-10-13） |
| 范围 | `inputId` / `deliveryId` / `runId` 的分配点、生命周期、关系边；事实→行/状态的投影不变量；重构闸门；现状缺口 |
| 配套 | 扩展 `docs/proposals/chat-transcript-streaming-architecture.md`（§1 原则、§11.7 裁定）与 `docs/proposals/voice-realtime-persistent-control-SPEC.md`（§4 身份模型、§7.1 条目级状态机）；本文件不重述二者，只补它们缺的那一层 |
| 非范围 | 本任务**不改产品代码**。写作中发现的实现与 (b) 的冲突只登记为缺口（§(d)），不在本任务内修。 |

> 全篇的「现状实现位置」一律为 `文件:行`，指 `develop` @ `97a797d0` 的**当前**行号。
> 行号会随代码漂移；**本文的判据是「引用存在且指向该符号」，不是行号恒等**——改动该符号时必须同步本文（见 §(c) 闸门）。

---

## 0. 裁定记录（R）

| id | 日期 | 裁定者 | 对象 | 决定 |
|---|---|---|---|---|
| **R-1** | 2026-10-13 | 独立审查者（adversarial subagent，非作者） | 本文件 §(a)(b)(c)(d) 全篇 | 见 §0.1 |
| R-2 | —（待填） | 人（yale） | 本文件作为后续重构的强制引用 | 待签核 |

### 0.1 R-1 独立审查结论

对 (a)：三个 id 的「分配点 / 生命周期 / 关系边」均有 `文件:行` 落点，且**如实登记了 `inputId` / `deliveryId` 在设计名与代码符号之间的缺口**（二者在 `develop` 中并无同名字面符号）——这是审查的价值，不是缺陷。对 (b)：每条不变量给了**可检查断言**而非散文，其中 B-1 明确写出「退休的键 = **替代物可见**」。对 (c)：闸门给了可执行的检查式。对 (d)：四次实测缺陷逐条映射到 (a)/(b) 的某一条并给了缺口编号。

**结论：通过。** 遗留——R-2 的人签核位待填；本文件在 R-2 签核前不得被当作「已生效闸门」引用。

---

## (a) 稳定 id 关系

### A.0 命名现状（先说清楚缺口，再谈关系）

设计文档提出了三个身份名，**代码里只有第三个是真实符号**：

| 设计名 | 代码里是否有同名字面符号 | 现状载体（de-facto carrier） |
|---|---|---|
| `inputId` | **无**——`grep -rn inputId server src` 零命中 | 一句话的身份被**四段不同的 id** 各管一段：端点的 `itemId`、客户端的乐观 `local_*`、助手流式行的 `live:*`、落盘行的 provider id。**没有任何一个 id 贯穿全程**——这正是 (d)/G-A1、G-B5 的根 |
| `deliveryId` | **无**——`grep -rn deliveryId server src` 零命中（该名只出现在 `docs/proposals/live-voice-architecture-review-2026-10.md` 的**提案**里） | 一次投递的**唯一**可用地址是 CLI 铸的 `queuedMessageUuid`（= CLI 的 `command_uuid`），仅在该投递**入队**时存在；开 run 的投递没有 |
| `runId` | **有** | `ChatRun.runId`，控制服务铸造 |

本节的写法：对每个设计名先给它的**角色定义**，再给现状载体的「分配点 / 生命周期 / 关系边」三栏，每栏带 `文件:行`。

---

### A.1 `inputId` —— 「一句话」的身份

**角色定义**：一个人说/写的一句话，从**被采集**到**成为转写里的一行**，全程应当只有一个身份。现状是四段 id 接力，交接处靠启发式。

#### 分配点（谁、在什么时刻铸）

| 载体 | 谁铸 | 何时 | 现状实现位置 |
|---|---|---|---|
| `itemId`（语音一句话） | 上游 realtime 端点 | 端点识别出一段输入时；随 `caption` 帧下行 | `server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:683`（`{type:'caption'; itemId; …}`）；客户端类型 `src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts:103` |
| `seq`（一句话所在的**中继分段**） | 客户端 | 分段发出时，本连接单调自 0 | `src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts:713`（`const seqRef = useRef(0)`）；端点的 `item_id ↔ seq` 配对在 `server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:2926-2929` |
| `local_*`（乐观打字行） | 客户端 | 提交输入时 | `src/modules/chat/hooks/useChatSessionState.ts:262`（`local_${Date.now()}_${…}`） |
| `live:*`（助手流式行） | 客户端 | 每个回合铸一次（非每 delta） | `src/modules/chat/utils/liveRowIdentity.ts:30`（`createLiveRowId`） |

#### 生命周期（何时生效、何时退休）

| 载体 | 生效 | 退休 | 现状实现位置 |
|---|---|---|---|
| `itemId` | caption 帧到达（interim 也生效） | 被某个 delivery 认领后随其行退休 | `src/modules/chat/voice-realtime/placeCaptions.ts:519`（`absorbed.add('voice-caption-'+id)`）；`placeCaptions.ts:186`（行 id `voice-caption-${first.itemId}`） |
| `seq` | 分段发出 | 本连接结束（**不跨连接**） | `useVoiceRealtimeSession.ts:713`（reset per connection）；caption 类型里 `seq` 可缺省 ⇒ 读作「按到达放置」`useVoiceRealtimeSession.ts:132` |
| `local_*` | 提交时 | 被一条落盘行回声（text 匹配）后退休 | `src/modules/chat/utils/sessionMessageReconciliation.ts:48,59` |
| `live:*` | 回合开始 | 回合结算后**保留**（换 kind 不换 id，保 React key） | `useSessionStore.ts:1429`（`finalizeStreaming` 保留 `stream.id`）；`liveRowIdentity.ts` 文件头注释 |

#### 关系边（1:1 / 1:N / N:1）

| 边 | 基数 | 现状实现位置 |
|---|---|---|
| `itemId → delivery` | **N:1**——一个 delivery 认领多个 `itemId` | 类型 `useVoiceRealtimeSession.ts:147`（`itemIds: string[]`）；消费 `placeCaptions.ts:169-171` |
| `seq → itemId` | **1:N / N:N**——一个分段的多条 caption 共享 seq；一句也可能 `seq:null` | 配对 `server/…/voice-realtime-ws-proxy.service.ts:2926-2929`；反向映射 `placeCaptions.ts:736-740` |
| `local_* → persisted` | **1:1**（文本+时钟窗口） | `sessionMessageReconciliation.ts:4-5`（5 分钟窗口 + 10s 时钟偏移）、`:48`（`local_` 判别） |

**（a.1）引用计数 = 4 处**（`useVoiceRealtimeSession.ts:713`、`placeCaptions.ts:519`、`useChatSessionState.ts:262`、`liveRowIdentity.ts:30`）+ 上报的 type/frame 落点，≥3。

---

### A.2 `deliveryId` —— 「一次投递」的身份

<!-- anchor: delivery-id -->

**角色定义（S2 修订，2026-10-16）**：一次把「一句话」交给执行面的**投递**，在 S2 之后是一等实体，其 id 就是 SPEC §4.2 的 `commandUuid`（我们这一侧读作 `queuedMessageUuid`）：**host 在 `send` 时铸、CLI 在 `command_lifecycle` 里原样回带**——这个 id 只有**一个生产面**，任何消费面都不得推断它（SPEC §4.2 的身份式）。因此「开 run 的投递没有地址」这个缺口在 S2 之后不再存在：**每次被接受的发送必给 `deliveryId`**（被拒绝的发送不产生投递）。投递与 turn 是**分离**的两个实体，关系为 **N:1**（一条投递绑一个 turn；一个 turn 可由多条排队投递触发）：`started` 到来时绑定，之前为 null。

**要核对的两条不变量（SPEC §4.4）**：投递状态是 `queued → started → completed｜cancelled`，**每个投递恰好一个终态**（**I2**）；`turnId` 绑定后不变，turn 关闭后仍已绑定而未终态的投递至多保持到下一个 turn 开始（`init` / `started`）或进程退出，否则按 `cancelled(owed-terminal-missing)` 结算并记异常（**I4**）。

#### 分配点

| 载体 | 谁铸 | 何时 | 现状实现位置 |
|---|---|---|---|
| `command_uuid` | **host**（send 时铸；CLI 在 `command_lifecycle` 里原样回带） | 投递被接受、写入 CLI 输入时 | 铸造 `server/modules/providers/list/claude/claude-host-driver.provider.ts:3410`（`message.uuid` ⇒ `commandUuid`）；回带读入 `claude-sessions.provider.ts:1231`（`command_uuid`） |
| `queuedMessageUuid`（横跨 `session_send` 的真名） | 同上 | 同上，随 `session_send` 的 result 回给调用方 | `server/modules/mcp-gateway/mcp-session-send.ts:107,272,473` |
| 中继读它 | relay | delivery result 到达时 | `server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:1948`（`queuedMessageUuidOf`） |
| 浏览器读它 | 客户端 | `sent` 帧到达时 | `src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts:1433`（`queuedMessageUuid: readQueuedMessageUuid(frame.result)`）；读法 `useVoiceRealtimeSession.ts:535-545` |

#### 生命周期

| 阶段 | 事实 | 现状实现位置 |
|---|---|---|
| 生效 | 入队确认（`queued:true` + uuid）起 | `useVoicePendingWithdraw.ts:186`（`started`/`cancelled`/`completed` 三态由 host lifecycle 驱动） |
| 中继记录 | `commandUuid → utteranceSeq`，供中断栅栏反查 | `server/…/voice-realtime-ws-proxy.service.ts:1973-1980`；`server/index.ts:771-778` |
| 退休 | `command_lifecycle: completed`（回合接管）或 `cancelled`（被撤回） | 客户端 `useVoicePendingWithdraw.ts:121-144`（`completed` ⇒ tombstone，行消失） |
| ~~**不存在**~~（S2 后作废） | S2 之前：开 run 的投递 ⇒ `queuedMessageUuid: null`，**不可撤回**。S2 之后：开 turn 的投递与入队的投递都是 delivery，`deliveryId` 必给，`queuedMessageUuid` 只是它的别名（SPEC §8.1）；顶替 run 退役（§6.1） | `useVoiceRealtimeSession.ts:163`；类型注释 `useVoiceRealtimeSession.ts:149-163`；`mcp-session-send.ts:272` |

#### 关系边

| 边 | 基数 | 现状实现位置 |
|---|---|---|
| `delivery → runId` | **N:1**（同一 run 可由多条排队消息先后触发，SPEC R-4.3） | `server/…/voice-realtime-ws-proxy.service.ts:474`（`runIdOf`）、`:2127`（`noteStatus({runId: runIdOf(result)})`）、`:797`（`stopped` 帧带 `runId`） |
| `delivery → itemId` | **N:1**，但**由客户端按文本猜**，不是生产者给出 | 违规点 `useVoiceRealtimeSession.ts:1412`（`carried = matched.length>0 ? matched : thought`）——见 (d)/G-A1 |

**（a.2）引用计数 = 5 处**（`claude-host-driver.provider.ts:3410`、`mcp-session-send.ts:473`、`voice-realtime-ws-proxy.service.ts:1948`、`useVoiceRealtimeSession.ts:1433`、`useVoicePendingWithdraw.ts:121`），≥3。

---

### A.3 `runId` —— 「一次执行」的身份

<!-- anchor: run-is-turn -->

**角色定义（S2 修订，2026-10-16）**：`runId` 就是 **turn**（一次执行）的身份。常驻会话里 turn 是 `system/init … RESULT` 的那一段，run 由账本在 `system/init` 时铸（SPEC §6.1）；per-run provider 仍在起进程时铸（现有 `startRun`），退化为 1:1。`runId → 投递` 是 **1:N**——一个 turn 可由多条排队投递（忙时折叠进来的、或 `later` 排空合并的）触发，这些投递共享同一个 `runId`；反之每条投递恰好绑一个 turn。**同一 run 的标识不得从消息 id 推导**（SPEC §4.2：一个 id 只有一个生产面），它是让客户端游标**跨 run 边界**仍然有意义的那个维度。

**要核对的两条不变量（SPEC §4.4）**：每个 turn 恰好一个终态（`completed` / `aborted`，**I2**）；一个 turn 的帧只进该 turn 的 run，且 `seq` 从 1 连续——折叠进来的投递不收过程帧，只收自己的 lifecycle 与终态（**I3**）。

**S2 退役**：忙时 `send` 不再开「顶替 run」（`supersedeRunning` 退役，SPEC §6.1）。下表「顶替 run」一行是 S2 之前的形态，保留为历史坐标。

#### 分配点

| 载体 | 谁铸 | 何时 | 现状实现位置 |
|---|---|---|---|
| `ChatRun.runId` | 控制服务 `startRun` | 每次开 run | `server/modules/websocket/services/chat-run-registry.service.ts:450`（`runId: randomUUID()`，函数体 `:415`） |
| 普通 run | 聊天 socket | 收到一次用户回合 | `server/modules/websocket/services/chat-websocket.service.ts:804` |
| **顶替 run** | 聊天 socket | 常驻会话忙时输入 ⇒ 开一个**顶替** run | `chat-websocket.service.ts:817`（`startRun({…, supersedeRunning: true})`） |

#### 生命周期

| 阶段 | 事实 | 现状实现位置 |
|---|---|---|
| 生效 | `startRun` 内一次铸定，永不复用 | `chat-run-registry.service.ts:415-450` |
| 终态 | `completed` 或 `aborted`（各自终态，不互为同义词） | `chat-run-registry.service.ts:22-30`（`ChatRunStatus` 定义） |
| 退休 | 保留 5 分钟后按 id 查询报 `expired` | `chat-run-registry.service.ts`（`DEFAULT_RUN_RETENTION_MS`，`:133`）；`server/modules/websocket/services/chat-run-registry.service.ts:518`（`getRunById`） |

#### 关系边

| 边 | 基数 | 现状实现位置 |
|---|---|---|
| `runId → 客户端游标` | **1:1**（游标 = `{runId, seq}`；`seq` 按 run 编号） | 类型 `src/shared/types.ts:953`（`ChatReplayCursor`）；规则 `src/modules/chat/utils/replayCursor.ts:41,69,90` |
| `runId → 帧` | **1:N**（一个 run 的每帧都带同一 runId，供重连判同源） | `src/modules/chat/hooks/useChatRealtimeHandlers.ts:326`（`recordReplayCursor(..., {runId, seq})`）、`:354`（`reconcileReplayCursorOnAck`） |
| `runId → 投递` | **1:N**（含顶替合并），见 A.2 |

**（a.3）引用计数 = 5 处**（`chat-run-registry.service.ts:450`、`chat-websocket.service.ts:817`、`types.ts:953`、`replayCursor.ts:69`、`useChatRealtimeHandlers.ts:326`），≥3。

---

### A.4 关系边总表（一张图看全）

```
 采集/识别            投递                 执行
 ┌──────────┐      ┌──────────────┐     ┌──────────┐
 │ itemId   │─N:1─▶│ queuedMessage│─N:1▶│ runId    │
 │ (端点)   │      │ Uuid(=CLI    │     │ (控制服务)│
 │ seq      │      │  command_uuid│     │          │
 └────┬─────┘      └──────┬───────┘     └────┬─────┘
      │ seq↔itemId 1:N/N:N │ 文本猜(缺口G-A1)  │ {runId,seq} 游标
      ▼                   ▼                  ▼
   caption 行        delivery 行        重连补发/(缺口G-B4)
   (voice-caption-*)  (persisted user)
```

* **同一 id 只能有一个生产者面**：`itemId` 由端点、`command_uuid` 由 CLI、`runId` 由控制服务。任何**由消费面推断**的身份（当前 `delivery→itemId`）都是缺口。
* **跨面交接必须携带 id**，不得回退到「文本 + 时钟窗口」。

---

## (b) 事实投影不变量

每条格式：**不变量（散文一句）** → **可检查断言（形式）** → **现状实现位置** → **违反时的读数**。
「退休的键」一词在此有固定含义：一条**临时**行从屏幕退休的**充要条件**，本文一律沿用已写对的那条口径——**替代物可见**（不是「服务端说了某个状态」）。

> 断言里的 `visibleItems` 指该面**实际呈现**的行集合；`persisted` 指已落盘的会话行；`provisional` 指尚未落盘的临时行。

---

### B-1 用户输入的投影：临时行的退休键 = **替代物可见**

**不变量**：一句话的**临时行**（语音 caption 行、忙时发送的 `command_lifecycle` 行）只在**它将成为的那条落盘行已经可见**时退休；服务端说「已接受 / 已开始」都**不是**退休理由。

**可检查断言**：

```
∀ 临时行 r（belongs to delivery d 或 resident pending p）：
    r ∈ visibleItems  ⟺  ¬existsPersistedReplacement(r)
其中
    existsPersistedReplacement(语音 r) := deliveryIsShown(d, visibleMessages)
    existsPersistedReplacement(忙时 r) := ∃ persisted user row m:
        text(m) == text(r) ∧ time(m) ≥ time(send) − SKEW
```

**取假形态**：把 `command_lifecycle: started` 改回「清空 content」（而不是等替代行）⇒ 断言红（临时行消失但无替代行）；把 `deliveryIsShown` 改回「看 `sent` 帧是否到过」⇒ 断言红（服务端已答、替代行未到，字被抹掉）。

**现状实现位置**：语音侧 `src/modules/chat/voice-realtime/placeCaptions.ts:111`（`deliveryIsShown`，注释明写「removal key is *the real message is visible*, not *the server said sent*」）、`:504`（`markDeliveredVoiceMessages`）、`:519`（absorbed）；聊天侧 `src/modules/chat/hooks/useSessionStore.ts:754`（`retireDeliveredResidentPending`，注释「the key is the one the voice side uses: the replacement is *visible*」）、`:1537`（`content: event.state === 'cancelled' ? '' : …`）。

**违反时的读数**：临时行消失而替代行未到 ⇒ 屏幕空白、刷新才补（D3）；或替代行已到而临时行不退休 ⇒ 一句话两行。

---

### B-2 队列命令行的投影：`started` 不是终态，`completed`/`cancelled` 才是

<!-- anchor: b2-state-channel -->

**S2 修订（2026-10-16，SPEC §7）**：投递状态的通道不再是「某一帧是否抵达」。`command_lifecycle` 降级为**会话级帧**（不带 `runId`、不带 `seq`，不进任何 run 的事件缓冲），投递状态改由 **activity 协议快照**承载（SPEC §7）：`ActivityProtocolSnapshot.deliveries[]` 每次变化 `rev += 1` 并发**整份快照**，晚加入者与重连者订阅即得当前态。于是「行状态」是快照的投影，而不是「本 socket 收没收到某条帧」的投影。投递恰好一个终态（SPEC §4.4 **I2**）。

**不变量**：一条被 CLI 队列持有的命令行，`queued → started → completed` 三态中，**只有 `completed` 让它离屏**；`started` 保留文本（回合自己的行是异步来的）；`cancelled` 清空文本但**保留行**（「那句话被撤回了」本身是读数）。

**可检查断言**：

```
∀ 命令行 r：
    state(r) == 'queued'    ⇒ r ∈ visible ∧ content(r) 非空 ∧ 可撤回
    state(r) == 'started'   ⇒ r ∈ visible ∧ content(r) 不变 ∧ ¬可撤回
    state(r) == 'completed' ⇒ r ∉ visible
    state(r) == 'cancelled' ⇒ r ∈ visible ∧ content(r) == ''
且  ∀ 被接受投递 d：d 的每次状态变化 ⇒ 随该次变化发出一份整份快照（rev 单调 +1，SPEC §7）；
                    晚加入者 / 重连者 S 订阅即读到当前态 ⇒ state(d) 的终态在 S 上可见
```

**取假形态**：撤掉客户端契约里「`completed` 掉整行」⇒ 行残留且永不离屏（D2 的客户端半）；把 `deliveries[]` 从 activity 快照里撤掉（或让 `rev` 不随变化递增）⇒ 终态在重连者那里不可见，行同样残留（D2 的服务器半，S2 的形态）。

**现状实现位置**：客户端状态机 `src/modules/chat/voice-realtime/useVoicePendingWithdraw.ts:121-144`（`applyLifecycle`）、`:186`（`completed` 为 tombstone）；渲染 `src/modules/chat/voice-realtime/VoicePendingUtterance.tsx:92`（`Waiting in the queue` 仅在 `queued` 态画）；聊天侧同构 `src/modules/chat/transcript/PendingResidentMessage.tsx`（`started` 不画气泡）。

**违反时的读数**：语音 bar 上「Waiting in the queue」行从 1 涨到 3 再也不消失（D2）。

---

### B-3 助手块的投影：一块一实体，key 跨三态不变

**不变量**：助手的一个内容块从 `streaming → complete → 落盘` 只有**一个 key**；「结算」是同一 key 的 `state` 变化，不是行的替换。

**可检查断言**：

```
∀ key k：|{ i ∈ visibleItems : i.key == k }| ≤ 1      （任何时刻）
且  k 从 streaming 经 complete 到被 history 覆盖，其视图 key 不变：
    key(streaming k) == key(complete k) == key(persisted k)
```

**取假形态**：让 `finalizeStreaming` 换 id ⇒ React 卸载重挂、key 断言红。

**现状实现位置**：`src/modules/chat/hooks/useSessionStore.ts:1429`（`finalizeStreaming` 保留 `stream.id`，注释「The row's own id is kept … a key that changes here is an unmount followed by a mount」）；`src/modules/chat/utils/liveRowIdentity.ts`（文件头：id 每回合一次，非每 delta）。原则出处见 `docs/proposals/chat-transcript-streaming-architecture.md` §1 I1/I6。

**违反时的读数**：同一段文字渲染两次（旧模型），或结算帧整行跳动。

---

### B-4 游标的投影：`seq` 只在其 run 内有意义

**不变量**：客户端每个会话的重连游标必须带 `runId`；`seq` 是按 run 编号的，跨 run 的 `seq` 不可比。收到 `chat_subscribed` ack 且 `ack.runId ≠ cursor.runId` 时，游标必须**复位到该 run 的起点**（而非沿用旧 `seq` 抑制补发）。

**可检查断言**：

```
∀ ack：ack.runId ≠ cursor.runId  ⇒  cursor' == {runId: ack.runId, seq: 0}
∀ frame：frame.runId ≠ cursor.runId  ⇒  cursor' == {runId: frame.runId, seq: frame.seq}
∀ frame：frame.runId == cursor.runId ⇒  cursor'.seq == max(cursor.seq, frame.seq)
```

**取假形态**：让 `subscribeTargetFor` 不带 `runId`，或让 ack 不复位 ⇒ 第二个 run 里重连补发为空（断言红：`visibleItems` 在重连后小于「从未断线」）。

**现状实现位置**：`src/modules/chat/utils/replayCursor.ts:41`（`recordReplayCursor`）、`:69`（`reconcileReplayCursorOnAck`）、`:92`（`subscribeTargetFor`）；接线 `src/modules/chat/hooks/useChatRealtimeHandlers.ts:326,354`；类型 `src/shared/types.ts:953`。注册表侧同源：`chat-run-registry.service.ts:37-44`（`runId` 就是为「游标是否还属于当前 run」而存在）。

**违反时的读数**：常驻会话第二个回合起，重连/切回后页面长时间不更新（D4 的身份面）。

---

### B-5 归属不变量：一次投递认领它**实际转发**的那些话语，不靠比对转述文本

**不变量**：一次投递 `d` 认领的 `itemId` 集合，必须等于中继**实际**交给执行面的那些话语；且「模型听了但没转发」必须有**显式处置**，不得让「没被转发」表现为「永久悬空」或「被后面的投递冒领」。

**可检查断言**：

```
∀ delivery d：d.itemIds == { itemId(x) : x ∈ utterancesTheRelayFunctionCallCarried }
且  该集合由生产者（中继，唯一同时看到 commit/转写/function_call 的面）在 sent 帧上给出，
    不是由客户端按 text(d.message) 推断
∀ utterance x：x 已 heard 且 未被任何 d 认领 ⇒ ∃ 显式处置帧（not-forwarded / dropped）
```

**取假形态**：让归属回到 `carried = matched.length>0 ? matched : thought` ⇒ 当模型在一次 tool call 里**省掉**某句（`coalesced 1 relayed piece`）时，逐字命中只覆盖部分 caption，`matched` 非空 ⇒ 整窗兜底不触发 ⇒ 未命中的 caption 永远无人认领（断言红）。

**现状实现位置（= 违规点）**：`src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts:1412`（`carried` 的文本推断）。**正面的半成品**：`sent` 帧已能带投递文本（`server/…/voice-realtime-ws-proxy.service.ts:2117`），但**不带 item id 集**——生产者有信息（`segmentSeqByItemId`，`server/…/voice-realtime-ws-proxy.service.ts:2926-2929`），却没在 `sent` 上给。

**违反时的读数**：屏幕上的 caption 泡泡永久保留，与「模型掉的那句」一一对应（D1）。

---

### B-6 队列深度的投影：报出的深度 = host lifecycle 推出的真实深度

**不变量**：bar/S-A/`session_status` 上的队列深度、字节数，必须与 host 的 `command_lifecycle` 推出的真实值**对账**，回合边界处误差为 0。

**可检查断言**：

```
∀ 采样点 t：reportedDepth(t) == depthFromLifecycle(t)
特别地，回合边界（CLI 一次性出队聚合）处：reported - real == 0
```

**取假形态**：撤掉 lifecycle 对账、退回中继自己数的 `cliQueuedDeliveries` ⇒ 报 `8/9/10` 而真实峰值 7（断言红）。

**现状实现位置**：`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts`（`cliQueueTerm` / `refreshHostQueue`、`hostQueueSource` 分支，`:1721` 附近与 `deliverSessionSend` 内）；口径出处 SPEC §18.1 F-3、§18.6 阶段 0a。

**违反时的读数**：队列读数虚高，用户与模型都被骗。

---

### B-7 投递的活性：被接受的投递，其终态投影必须抵达正在看的 socket

<!-- anchor: b7-state-channel -->

**S2 修订（2026-10-16，SPEC §7）**：本条的「终态投影」在 S2 之后指 **activity 快照**，不是「一条终态帧是否抵达某个 writer 的受众」。快照是**会话级**的：每个看这个会话的 socket 订阅即得当前态、重连即重取整份快照，因此「被接受的投递，其终态投影必须抵达正在看的 socket」是**结构性**满足的——不再依赖谁的 writer 受众（这正是选整份快照而非增量的原因，SPEC §7.2）。投递恰好一个终态（SPEC §4.4 **I2**），终态条目在快照里按与 run 相同的窗口保留（SPEC §7.1）。

**不变量**：对每一条**被接受**的投递，其终态投影（快照里该 `deliveryId` 的 `state` 落到 `completed` 或 `cancelled`）**必须**能被「正在看这个会话的 socket」读到。一条只到 `queued`/`started`、永无终态的投递，是**构造性**的行残留。

**可检查断言**：

```
∀ 被接受投递 d：
    ∃ 时刻 t：snapshot(S).deliveries[d].state ∈ {completed, cancelled}
    （S = { 用户此刻正在看的 socket }；晚加入者 / 重连者订阅即得当前快照，SPEC §7）
```

**取假形态**：把 `deliveries[]` 从 `ActivityProtocolSnapshot` 撤掉、或让 `rev` 与快照内容脱钩（晚加入者拿到陈旧态）⇒ 终态在正在看的 socket 上不可见，断言红。（S2 之前同一条的形态是：顶替 run 的 writer 以 `connection: null` 建、不把已附着会话的 socket 挂上去 ⇒ `completed` 帧写进「空受众」。）

**现状实现位置**：回归夹具 `server/modules/voice-realtime/tests/voice-realtime-queue-lifecycle-completion.test.ts:1-26`（文件头把缺陷、根因与三读数写全：`startRun({supersedeRunning:true})` 的 writer 是 `connection: null`，回合帧写进了空受众）；顶替分支 `server/modules/websocket/services/chat-websocket.service.ts:817`。

**违反时的读数**：语音 bar 的 withdraw 行累积不消失（D2）。

---

### B-8 「处理中」只有一个写者

<!-- anchor: b8-processing-single-writer -->

**新增（S2，2026-10-16，SPEC §4.3 / §4.4）**：账本对「处理中」的定义是 SPEC §4.3 的那一条——

```
processing(session) :=  turn.open  ∨  ∃ delivery ∈ {pushed, queued, started}  ∨  ∃ foreign command 未终态
```

**不变量**：`processing`、run 终态、`turn` lease **只由账本写**；其余读者（registry、host lease、heartbeat、`/api/providers/sessions/running`、调度器、MCP 读工具）都是账本的**投影**（SPEC §4.4 **I6**）。静止条件（SPEC §4.4 **I1**）：turn 已关 ∧ 无未终态投递 ∧ 无未终态 foreign command ⇒ 注册表无 running 的 run、无 `turn` lease、`processing = false`。

**可检查断言**：

```
∀ 会话 s、∀ 读者面 R ∈ {registry, host lease, heartbeat, sessions/running, scheduler, MCP 读工具}：
    读数(R, s) 与 ledger.processing(s) 一致（R 不得有独立的写路径）      （I6）
∀ 会话 s：静止(s) ⇒ ¬∃ running run ∧ ¬∃ turn lease ∧ processing = false  （I1）
```

**取假形态**：让任一读者面自己手工加减 `turn` lease（而不是重算账本投影）⇒ 静止时仍有 lease，I1 红；让调度器读自己的 `isProcessing` 而不是账本 ⇒ 差一格的会话里排队消息永远发不出去。

**违反时的读数**：turn 早已结束而 `Working…` 常驻、`sessions/running` 仍含该会话、`turn` lease 挂着不退（本题的缘起现象，SPEC §1.1）。

---

### B-9 终态与 `RESULT` 的顺序无关

<!-- anchor: b9-terminal-order-independent -->

**新增（S2，2026-10-16，SPEC §2 / §5.3）**：CLI 契约实测（SPEC §2 **C-3**）给出：**折叠命令的终态在 `RESULT` 之前，主命令的终态在 `RESULT` 之后**——终态与 `RESULT` 的先后不固定。因此账本**不得**用「全部 `completed`」推断 turn 结束，也不得假设某个投递的终态一定在 turn 终结之后到达。

**不变量（SPEC §5.3 顺序无关）**：投递终态只由 `command_lifecycle` 驱动（`completed`/`cancelled`），turn 终态只由 `RESULT` 驱动，两者**互不等待**；一致性只靠 SPEC §4.4 **I4** 的 owed 规则做**交叉核对**，不靠顺序（turn 关闭后仍绑定而未终态的投递，至多保持到下一个 turn 开始或进程退出，否则按 `cancelled(owed-terminal-missing)` 结算）。

**可检查断言**：

```
∀ turn T、∀ 投递给 d 绑定到 T：
    终态(d) 与 终态(T) 的先后可以不固定（C-3）；
    断言只要求「终态(d) 最终到达」与「终态(T) 最终到达」，二者互不蕴含
∀ turn T：¬∃ 未终态投递 owed(T) 跨越到下一个 turn（否则 I4 结算 + 记异常）
```

**取假形态**：把账本改成「收到 `RESULT` 就结算全部投递」⇒ 主命令的终态（`RESULT` 之后）被提前合成，I2/I4 红；或改成「等全部投递终态才关 turn」⇒ 无人 turn（无投递）永不关闭。

**违反时的读数**：折叠命令与主命令的终态被互相覆盖，`completes` 计数错位、run 永远 running（SPEC §1.2 / §1.3）。

---

## (c) 重构闸门

**规则**：后续**任何**触及 (a) 中任一 id 的**分配/生命周期/关系边**、或 (b) 中任一不变量所覆盖的**投影**的改动（含 PR、quay task、以及「顺手」的小改），必须：

1. 在触达点**引用本文的对应章节号**（`§(a.x)` / `§B-n`）；
2. 在 §0 的 R 表取得一条**裁定记录**（`决定:` 非空）后，才可合入；
3. 若改动**改变**了某条不变量或关系边，必须**同步修订本文**并在 §0 记一条 `R-nn`，注明它取代/新增哪条。

**可检查形式（机械）**：

```bash
# 1. 闸门必须被引用：触碰身份/投影的改动，其 body/PR 描述须含本文档名 + 章节锚
grep -Eq 'id-relations-and-projection-invariants\.md#(a|b|c|d|B-|R-)' <变更说明>
# 2. 引用的章节必须真的存在于本文
grep -Eq '^#{2,4} \(?(a|b|c|d)\)?|^### B-[0-9]' docs/proposals/id-relations-and-projection-invariants.md
# 3. 触达点打机读标记（可选但推荐），供 reviewer 一眼定位
grep -rn 'IDENTITY-GATE: §' <被改动的源文件>
```

**取假形态**：把某处 id 分配点改掉、但变更说明中既无章节锚、§0 也无对应 `R-nn` ⇒ 上述检查式 1 或 2 红，改动**不得**合入。

---

## (d) 现状缺口清单（本会话四次实测缺陷 → 缺哪条 / 编号）

四次实测的**表面各异**，根因分两类：**(i) 身份不足**（该带的 id 没带，消费面只好猜）与 **(ii) 投影不变量缺一条**（该退休的不退休 / 不该退休的提前退休）。

| # | 实测缺陷（本会话） | 缺的那条 | 缺口编号 | 归属面 | 现状 |
|---|---|---|---|---|---|
| **D1** | **气泡永久悬空**：屏幕上 caption 泡泡永不消失 | (a) 缺关系边 `delivery →itemIds`（生产者不给出，客户端按文本猜）；(b) 缺「听了未转发」的显式处置（B-5 后半） | **G-A1** / **G-B5** | 中继须在 `sent` 上带 `itemIds`（或单调水位线） | **未修**。违规点 `useVoiceRealtimeSession.ts:1412`；信息已在中继 `voice-realtime-ws-proxy.service.ts:2926-2929`，只差搬上帧 |
| **D2** | **「Waiting in the queue」行残留**：语音 bar withdraw 行 1→3 不消失 | (a) 缺约束 `commandUuid` 的 lifecycle 帧**受众**；(b) 缺活性不变量 B-7 | **G-A2** / **G-B2** | 顶替 run 的 writer 须承接正在看会话的 socket | **已修（夹具在）**：`server/modules/voice-realtime/tests/voice-realtime-queue-lifecycle-completion.test.ts`（假形态=空受众，真形态=三帧到达） |
| **D3** | **busy 发送的消息气泡消失**：忙时打字发的消息不出现、刷新才补 | (b) 违反 B-1：`command_lifecycle:started` 清空文本，早于替代行可见 | **G-B1** | 聊天侧 `command_lifecycle` 投影 | **已修**：`useSessionStore.ts:1537` 改为仅 `cancelled` 清空 + `retireDeliveredResidentPending`（`:754`）按「替代物可见」退休 |
| **D4** | **页面长时间不更新** | (b) 违反 B-4：游标未带 run 身份，`seq` 跨 run 沿用 | **G-B4** | 聊天侧重连游标 | **已修（聊天侧）**：`replayCursor.ts:41,69,90`。**旁支（非身份面）**：`public/sw.js` 把瞬时 fetch 失败变成 `<h1>Offline</h1>` 页 —— 与身份/投影无关，单列 |

### 未映射进四次缺陷、但同源的缺口（登记，不在本任务内修）

| 编号 | 缺口 | 缺的那条 | 现状实现位置 |
|---|---|---|---|
| **G-A3** | `seq` 不跨连接，且 caption 的 `seq` 可缺省 | (a) A.1 生命周期：一句的身份在连接边界断裂 | `useVoiceRealtimeSession.ts:713`（per-connection reset）、`:132`（`seq?`） |
| **G-B6** | 队列深度对账 | (b) B-6 | SPEC §18.1 F-3；proxy `cliQueueTerm` |
| **G-B8** | `inputId` 在设计名与代码之间**没有单一载体** | (a) A.0/A.1：四段 id 接力 | 见 A.0 表 |

### 缺口 → 不变量的补法（本任务只给「补哪条」，不给实现）

* **G-A1 / G-B5** ⇒ 修 (a)：给 `sent` 帧加 `itemIds`（中继已持有 `segmentSeqByItemId`）；修 (b)：B-5 断言化，并为「听了未转发」补一条处置帧。
* **G-A2 / G-B2** ⇒ 已由 D2 修复满足；把 B-7 写成回归断言（该夹具已是取假形态）。
* **G-B1** ⇒ 已由 D3 修复满足；B-1 的聊天侧断言即该夹具。
* **G-B4** ⇒ 已由 D4 修复满足（聊天侧）；`public/sw.js` 单列，不属本节。
* **G-A3 / G-B6 / G-B8** ⇒ 待立任务，修前须先在本文取得 `R-nn`。

---

## 附录：AC 自查与取假形态

**AC1**：本文件含 (a)(b)(c)(d) 四节且每节非空。✔

**AC2**：三个 id 各自 `文件:行` 引用计数 = `inputId` 4+ / `deliveryId` 5 / `runId` 5，均 ≥3。✔
**AC5 取假形态**：`grep -oE '\S+\.(ts|tsx):[0-9]+' docs/proposals/id-relations-and-projection-invariants.md | ...` 若把全部 `文件:行` 抽掉，则每个 id 的引用计数 = 0 < 3 ⇒ **AC2 红**。这证明 AC2 不是散文自证——它数的是**可定位的实现坐标**。

**AC3**：每条不变量均有可检查断言（B-1..B-9 各含 `∀ …⇒…` 形式）；**B-1 明确写出「退休的键 = 替代物可见」**。✔

**AC4**：D1–D4 逐条映射到 (a)/(b) 的某一条并给出缺口编号（G-A1…）。✔
