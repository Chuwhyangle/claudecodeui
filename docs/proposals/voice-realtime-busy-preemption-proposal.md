# 提案：会话忙时新话语「主动抢占」在跑回合

> 任务：`gap-live-voice-busy-utterance-preemption-proposal`（提案，非实现）
> 日期：2026-10-14 ｜ 现场语料：capture `b5d01c21-3f53-4228-a28e-d18b7cb967f7`（sha256 前缀 `0f2bd51fbbb28c9f`，2026-10-13 23:56:18–00:01:48 +0800）
> 前置：`gap-live-voice-interrupt-missing-intent-drops-stop`（done，已在 develop 上）

**⛔ 本任务不改任何产品默认值。** 三种形态只作研究与比较，默认取哪种由人裁定（见 §5）。AC3 要求本任务 diff 不触碰 `server/` 与 `src/` 下任何产品代码——已满足（见 §5）。

---

## 0. 结论摘要（TL;DR）

1. **模型会主动抢占，但不可靠。** 在 interrupt 修复后的代码上，用同一段真实麦克风音频回放真实上游：**两处「想停」的话语，模型都主动调用了 `session_interrupt`**，执行面全部接受、schema 违例 0 条。但「先暂停一下」在**现场**被模型判成普通 `session_send`（无抢占）、在**复验**里判成 `session_interrupt`（抢占）——**同一段音频、同一模型，判断不稳定**。这是形态 (a) 的核心弱点。
2. **现状 A+（形态 a）不是「不抢占」，是「何时抢占取决于模型」。** 人不主动说「停」，一切照常进 CLI 队列、只在回合边界聚合（D-5）。
3. **排队可见性面本身正常**；人报的「气泡没上去」指向的是**另一处未覆盖形态**：被听到、模型发起 interrupt、**该 interrupt 被 schema 拒绝** ⇒ 这句话**零可见处置**（既不入队、也不成行）。其根因（缺 `intent`）已由依赖任务修，但「被拒的中断不留下任何可见痕迹」这一面仍无 owner（§3）。
4. **2500 ms 合并窗口**在本场真实流量里：**11 次开窗，6 次（55%）在 2500 ms 地板空放（未合并任何片段，纯等待）**，另 5 次被后续片段/转写重新武装、拉到 3.2–13.9 s。建议改为**同 `itemId` 内的事件驱动静默窗口**（§4）；不改默认。

---

## 1. 复验读数（AC1）

### 1.1 现场（capture `b5d01c21`，来自 journal 与 timeline）

| 时刻（+0800） | 事件 |
|---|---|
| 15:58:05.075 | `transcription.completed "终止前面操作。"` |
| 15:58:06.577 | `transcription.completed "处理我现在说的这句话。"` |
| 15:58:06.856 | `<< function_call session_interrupt {"message": "停止前面的操作，处理我现在说的这句话。"}` |
| 15:58:06.857 | `to-browser error TOOL_ARGUMENT_SCHEMA_VIOLATION (recoverable) … (intent: Invalid input: expected string, received undefined)` |
| 15:59:45.757 | `transcription.completed "嗯，先暂停一下，先统计一下这一组到底。"` |
| 15:59:51.171 | `<< function_call session_send {"message": "先暂停一下，先统计一下这次我到底输入了几段话……"}` |

即：现场唯一一次正确的 interrupt 因**缺 `intent`** 被整次拒收（依赖任务修的正是它）；「先暂停一下」被模型判成**普通 send**，进队列等完整个回合。

### 1.2 复验方法

`experiments/voice-realtime-busy-preemption-recheck/probe.mts`（本任务新建，Touches 已声明），基于依赖任务的可复用回放器改写：

- 用 `ffmpeg` 从 capture 切两段**真实麦克风音频**为裸 PCM16 16 kHz 单声道：
  - **窗口 `terminate`**：offsetMs 102800–106900（4.10 s）→「终止前面操作。」+「处理我现在说的这句话。」
  - **窗口 `pause`**：offsetMs 200800–211300（10.50 s）→「嗯，先暂停一下，先统计一下这一组到底…」
- 起**一个**备用端口实例（`:3912`，隔离 HOME/DATABASE_PATH/JWT/journal；`VOICE_REALTIME_CAPTURE=off`、`CLAUDE_SESSION_SCOPE_SWEEP=off`），把每段音频作为一次 `/api/voice-realtime/diagnose` 连接喂给**真实上游** `qwen3.8-omni-flash-realtime`（`DEFAULT_DASHSCOPE_REALTIME_MODEL`），`dryRun:true`、`quietMs:4000`、`maxMs:90000`、每连接 `VOICE_REALTIME_MAX_CNY_PER_CONNECTION=0.3`。
- 执行面是**出货代理路径**（`handleVoiceRealtimeConnection` + 出货 transport），只把 `session_send`/`session_interrupt` 换成**只记录**的替身（`server/index.ts` 的 dry-run 执行器）⇒ 不向任何真实会话注入、不真停任何 run。`sessionId` 用任何库里都不存在的随机 id。
- ⛔ **不重启 `:3001`**（只读它的 `ss -ltnpH` pid）；不触碰任何 Quay worker/driver/工作树。

### 1.3 读数（逐字，来自 `/tmp/vbp-recheck/report-{terminate,pause}.json` 与第二实例日志）

**窗口 `terminate`**（「终止前面操作」+「处理我现在说的这句话」）

- captions：`["防止前面操作。","处理我现在说的这句话。"]`（heard=true）
- 模型调用：`session_interrupt {"intent": "用户要求停止当前操作"}` **然后** `session_send {"message": "处理我现在说的这句话"}`
- `TOOL_ARGUMENT_SCHEMA_VIOLATION` 帧：**0 条**
- 执行面裁决：`stopped` 帧 = `{"type":"stopped","aborted":false,"depth":0,"runId":null}`；修正/后续文本经 G1 走投递路径，`sent` 帧带 `wouldSend.message = "处理我现在说的这句话"`，`coveredThroughItemId = item_KTUuhfi5liwP1KVSNbQSy`
- 花费：**¥0.0066**

**窗口 `pause`**（「嗯，先暂停一下，先统计…」）

- captions：`["嗯，先暂停一下，先统计一下这数到底。","几几段话。","啊，识别输出有输出几段。"]`（heard=true）
- 模型调用：先一次**上游 MALFORMED_FUNCTION_CALL**（`arguments are not JSON: Unterminated string …`，recoverable，**上游模型自身抖动**，非我方 schema），随后 `session_interrupt {"message": "先暂停一下，统计一下这次输入了几段话，识别输出了几段。", "intent": "用户要求暂停当前运行并统计输入和输出的段落数。"}`
- `TOOL_ARGUMENT_SCHEMA_VIOLATION` 帧：**0 条**；`session_send`：0 次
- 执行面裁决：该 interrupt **带 `message`** ⇒ 走 **G1 先入队后中断**：`deliverSessionSend` 在 dry-run 下返回 `queued:false, queuedMessageUuid:null` ⇒ `enqueueConfirmed` 为假 ⇒ 执行面**诚实拒绝**（第二实例日志 `session_interrupt: correction not enqueued (…); not aborting`，回执 `{stopped:false, reason:'revision-not-enqueued'}`），**不产生 `stopped` 帧、不静默丢弃**；`sent` 帧带 `wouldSend.message = "先暂停一下，统计一下这次输入了几段话，识别输出了几段。"`
- 花费：**¥0.0050**

**合计花费 ¥0.0116**（上限 ¥0.3/连接；本次 2 条连接）。
**`:3001` pid：766174 → 766174（相同，未重启）。**

### 1.4 复验的边界（须随读数一起读）

- **dry-run 的 `stopped` 帧 `aborted:false, runId:null` 是执行面边界，不是拒绝。** dry-run 没有真实在跑的 run，故 `base.session_interrupt` 只回 `{aborted:false, dryRun:true, wouldInterrupt:{…}}`。“回合是否中止”在 dry-run 下只能读成**「模型是否请求中止 + 执行面是否接受这次调用」**，读不到真实 abort。真实的 abort 与 aftermath 由 §18 的 F2/F3 判据与依赖任务的真机回放覆盖。
- **dry-run 下 G1 的「入队确认」必为假**（假 `session_send` 不返回 `queuedMessageUuid`/`queued:true`）⇒ 带 `message` 的 interrupt 一定走 `revision-not-enqueued` 分支。这是**代理面的 dry-run 边界**，不是分支缺陷。
- **本次复验没有命中「缺 `intent`」路径**：模型这两次都自带了 `intent`，所以依赖任务修的「接受无 intent 的 interrupt」这条**没有被本次回放实际走到**（该修复 `cf1673f6d` 于 2026-10-14 00:40 合入 develop，晚于 capture；本次回放跑的是含它的 develop 代码）。依赖任务自身的判据负责该路径。
- **「是否抢占」是模型随机的**：同一段「先暂停一下」音频，现场判 `session_send`、复验判 `session_interrupt`。一次回放没读到某形态 ≠ 产品无效，反之亦然。

---

## 2. 三种抢占形态（AC2）

术语按 SPEC §附录 A：**append**=`session_send`（追加一条指令）、**interrupt**=停当前 run（不清队列、不销毁会话）。硬规则 G1（先入队后中断，§18.4）、G2（runId+utteranceSeq 栅栏）、D-6（中断语义由模型**语义**判断、非关键词）、D-8（立即中断、已落地副作用保留、不回滚）、D-9（只作用于绑定会话当前 run；不动 Quay worker/driver/工作树）。

### 形态 (a) 现状 A+ + 修好的语义 interrupt

- **机制**（D-5）：忙时语音照常进 CLI 队列，CLI 在**回合边界**按推入顺序聚合；**只有** Realtime 模型语义判断为「想停或要改向」（D-6）时才自主调 `session_interrupt`。§10.1：触发只有两条路——模型，或用户按 UI 停止键；**没有关键词兜底**（C-2）。
- **保留策略**：D-8 —— 中断立即发生、不回滚、不暗示可撤销；被停回合**已落地的副作用保留**；中断时在途工具由审计记录并在下一轮诚实告知。队列里未出队的话**保留**、按序继续（§10.2）；已交给 CLI 队列的话**撤不回**。
- **stale-first 风险**：由 **G1** 压到 0——修正文本先入 CLI 队列并取得入队确认，再 abort（U1/U2 读数：κ=1/κ=3 条排队消息全部随中断收尾那一轮送达，一条不丢；修正与 abort 同一次入队之后调用，否则修正晚一轮）。**但 G1 只保证「抢了之后顺序对」，不保证「该不该抢」** —— 该不该抢完全交给模型。
- **成本**：无额外上游调用（不新增模型请求）；被停回合已产出的 token 照计费。
- **与 CLI 队列聚合的交互**：队列照常积累；中断后 backlog 首条**立即投递**（§10.2），修正与前序排队消息按说话顺序并入同一轮（U1/U2/U3）。
- **Quay worker 隔离**：D-9 / F6 —— 中断**不**调 `stopTask`、**不**改 `session_background` 租约、**不**触碰任何 Quay worker/driver 进程或工作树。
- **实测弱点**：见 §1.4——**是否抢占取决于模型，且不稳定**。同一句「先暂停一下」，现场被当普通追加（进队列等完整个回合），复验被当抢占。人若不说「停」，现状就是纯追加。

### 形态 (b) 有界抢占（回合已运行 ≥N s 且新话语与当前方向相关）

- **机制**：在语音面新增**当前 run 的起跑时刻**（可由 R-4 的 `runId` + host `command_lifecycle` `started` 事件度量，§18.3），新话语到达时若「run 已跑 ≥ N s」**且**「模型判为与当前方向相关」⇒ 自动发起中断（复用 G1/G2 与 D-8）。
- **保留策略**：同 (a)（D-8 保留 + §10.2 队列保留）。
- **stale-first 风险**：同 (a)，G1 仍必须；**新增**一类误判面——「相关性」判断错把无关插话当改向（或反之）。
- **成本**：多一次「相关性」判断。若复用 Realtime 模型已有的理解，不新增上游调用；若另起 classifier，则新增调用成本。误停的浪费 = 被停回合已产出 token。
- **与 CLI 队列聚合的交互**：同 (a)。
- **Quay worker 隔离**：同 (a)（D-9/F6 不变）。
- **未定项（须人裁定）**：N 的取值；「相关」的口径（模型语义 vs 启发式）；「≥N s」只让**短的正常回合**免于误停，**长回合里的无关插话仍会误停**。

### 形态 (c) 一律抢占（busy 时任何新话语都断当前回合）

- **机制**：忙时收到任何新 utterance ⇒ 直接中断 + 把话语作为下一轮输入。
- **保留策略**：若沿用 D-8 ⇒ 已产出副作用保留；队列保留。
- **stale-first 风险**：若每次抢占都走 G1，可压 stale-first；但**每句都 abort** 直接违反 §18.7 SLO「模型发起的**有效**中断 ≤ 1 次/run」，且与 **D-6「语义判断、非关键词」**正面冲突。
- **成本**：每句插话打断一次 ⇒ 大量被停回合的浪费 token；长回合几乎无法完成。
- **与 CLI 队列聚合的交互**：队列几乎不再积累（总被清），与 §10.2「已排队未开始的话保留」的语义存在冲突风险。
- **Quay worker 隔离**：仍需 D-9；但高频中断对**绑定会话的 resident 回合**伤害最大。
- ⚠️ **这正是任务硬约束禁止的方向**：「未经人进一步裁定，不得把一切补充话语设成中断默认」。

### 对照表

| | (a) 现状 A+ | (b) 有界抢占 | (c) 一律抢占 |
|---|---|---|---|
| 触发 | 模型语义判断 | run≥N s **且** 模型判相关 | 任何新话语 |
| 被停回合已产出内容 | 保留（D-8） | 保留（D-8） | 保留（D-8） |
| stale-first | G1 压到 0（§18.4） | G1 压到 0 | G1 压到 0（若走 G1） |
| 误停风险 | 低（模型自主）但**该抢不抢** | 中（相关性/时长门槛） | **高**（每句都停） |
| 成本 | 无额外调用 | +1 次相关性判断 + 误停浪费 | 大量误停浪费 |
| CLI 队列聚合 | 排队；边界聚合 | 同 (a) | 队列几乎不积累 |
| Quay 隔离 | D-9 保持 | D-9 保持 | D-9 保持（但 resident 伤害最大） |
| 与 SLO/红线 | 合规 | 合规（口径待定义） | **违反 ≤1 次/run 与 D-6** |
| 现状实测 | 抢占**不稳定**（§1.4） | 未实现 | **禁止** |

---

## 3. 排队可见性归因（AC4）

### 3.1 队列可见性面本身工作正常

`b5d01c21` 的 58:36–58:52 区间，服务端**如实**把「还在等」画了出来：

```
15:58:36.188  << function_call session_send {"message": "已经执行完了，然后我后一句话也说了，但是切换没上去。"}
15:58:36.188  queued: opening a 2500 ms coalescing window (the frame precedes the sent)
15:58:36.188  to-browser queued depth=1                 ← AC-327 的「进入窗口」outbound 帧
15:58:36.883  << function_call session_send {"message": "没有处理。"}
15:58:38.189  status injected seq=17 phase=queued queued=1/93B ageMs=0
15:58:39.383  coalesced 2 relayed piece(s) into one message
15:58:39.385  to-browser sent                            ← 投递到会话
15:58:41.386  status injected seq=18 phase=queued queued=1/93B ageMs=2000
15:58:52.478  status injected seq=19 phase=queued queued=0/0B ageMs=1   ← 队列清空
```

`sent`（39.385，投递**进会话**）之后状态行仍报 `phase=queued queued=1/93B` 达 **13.1 s**，是**正确**的：`queuedDepth()`/`queuedBytes()` 读的是 **CLI host 队列**，resident 会话正忙，消息在 Claude 的队列里排队直到回合结束——`sent` 与 `queued=1` 量的是**两件事**（「投递进会话」vs「会话尚未出队」），不是自相矛盾。**⇒ 队列可见性（`queued` 帧 + 状态行）工作正常，不是本项的缺陷。**

### 3.2 人报「气泡没上去」≠ 排队可见性缺陷，而是一处**未覆盖形态**

AC4 证据行——该句被**听到**、模型**发起 interrupt**、interrupt 被 **schema 拒绝**，于是这句话 **零可见处置**：

```
15:58:06.577  transcription.completed "处理我现在说的这句话。"          ← 被听到
15:58:06.856  << function_call session_interrupt {"message": "停止前面的操作，处理我现在说的这句话。"}
15:58:06.857  to-browser error TOOL_ARGUMENT_SCHEMA_VIOLATION (recoverable) … (intent: Invalid input: expected string, received undefined)
              ← 整次调用被拒；此后**没有** queued / sent / stopped 帧，该句既不入队、也不成行
15:58:36.135  transcription.completed "已经执行完了，然后我后一句话也说了，但是气泡没上去。"   ← 人报症状
```

**结论（二选一取「未覆盖形态」）**：

- **不是对既有 done 任务的回归**：`gap-live-voice-bounded-queue-refusal-visible` 覆盖的是**被拒的 `session_send`**（超字节预算）留痕可见；本处是**被拒的 `session_interrupt`**，形态不同。`gap-voice-delivered-merged-message-invisible-in-transcript` 覆盖**已投递合并消息无行**；本处那句**根本没被投递**，形态也不同。故二者皆不适用。
- **是未覆盖形态**：*「说了一句要中断的话 → 模型确实发起了 interrupt → 该 interrupt 被拒（本次因缺 `intent`）→ 这句话在人这一侧零可见处置（既没有『已听到』的承载行、也没有任何『未生效』的提示）」*。现状下这句话像**凭空消失**——正是人所报的「气泡没上去」。
- **归因**：根因（缺 `intent` 导致整次拒收）**已由依赖任务 `gap-live-voice-interrupt-missing-intent-drops-stop` 覆盖并合入**（`cf1673f6d`，2026-10-14 00:40，晚于 capture 23:56）。但**残留的是「被拒的中断不留可见痕迹」这一**面**——它与 `bounded-queue-refusal-visible` 同属「拒绝必须可见 + 逐条留痕」（§9 首行）的要求，却尚无 owner。**⇒ 建议另立缺陷任务（不在本任务内修）：给被拒的 `session_interrupt` 一个可见处置（复用 `heard_not_forwarded` / 底栏状态格的既有面），使「被听到但没生效」可被看见。**
- ⚠️ **取证限制**：承载行在**客户端**渲染，服务端 journal 读不到；本归因基于「journal 里该句确无任何处置帧」+「人报症状」两条独立证据，非推断 DOM。

---

## 4. 2500 ms 合并窗口（AC5）

### 4.1 本场实测分布（`b5d01c21`，全部 `queued: opening a 2500 ms coalescing window` → `coalesced` 配对）

| # | 开窗 | 关窗 | 实测延迟 | 合并片段数 |
|---|---|---|---|---|
| 1 | 15:56:31.100 | 15:56:33.602 | 2502 ms | 1 |
| 2 | 15:56:50.509 | 15:56:53.010 | 2501 ms | 1 |
| 3 | 15:57:10.003 | 15:57:12.504 | 2501 ms | 1 |
| 4 | 15:57:18.626 | 15:57:32.490 | **13864 ms** | **3** |
| 5 | 15:57:51.923 | 15:57:54.424 | 2501 ms | 1 |
| 6 | 15:58:27.701 | 15:58:32.708 | **5007 ms** | 1 |
| 7 | 15:58:36.188 | 15:58:39.383 | **3195 ms** | **2** |
| 8 | 15:59:20.727 | 15:59:28.123 | **7396 ms** | **2** |
| 9 | 15:59:51.172 | 15:59:53.673 | 2501 ms | 1 |
| 10 | 16:00:29.762 | 16:00:39.663 | **9901 ms** | **2** |
| 11 | 16:01:40.670 | 16:01:43.171 | 2501 ms | 1 |

- **合计 11 次开窗**（任务正文假设「本场 9 次合并」——实测为 **11**，见 §6 更正）。
- **在地板（≈2500 ms）空放：6/11（55%）**，且这 6 次**合并片段数恒为 1**（未合并任何东西，纯等待）。
- **被重新武装、拉长到 3.2–13.9 s：5/11**，其中 4 次合并 ≥2 片段。
- 合并 ≥2 片段的：**4/11**（#4=3、#7=2、#8=2、#10=2）。
- 关键：**2500 ms 不是上界**（#4 达 13.9 s）——窗口被**后续 relay 片段与转写 caption** 反复重新武装（`armCoalesce` 同时挂在 `sessionSend` 与 caption 处理器上），flush 发生在**最后一个事件之后** 2500 ms。

### 4.2 建议（只出建议，不改默认）

- **问题**：固定 2500 ms 窗口给**每一次首句投递**都强加 ≥2.5 s 的等待，而**55% 的窗口什么也没合并**（纯延迟）。这正对应 SPEC §9 E-3 的观测（另一场 11/11 次未合并、「白占首句 3 s 中的 2.5 s」）。
- **建议**：把窗口从「首片段起固定 2500 ms」改为 **`itemId` 内的事件驱动静默窗口**——首片段到达即开窗，**同一 `itemId` 的连续 interim/caption 静默一小段（≤1 s）即 flush**；跨 utterance 立即投递。目标：无后续时首句 ≤ 1 s（对齐 §13 SLO），有后续时仍能把同一句话的碎片并成一条。
- **反对「简单调小窗口」**：窗口一短，**一句话就会被拆成多条投递**（§9 E-3 关心的正是「拆成多条」的另一面）——所以建议的关键是**事件驱动（跟 `itemId`/静默走），不是把 2500 调成 800**。
- **与抢占形态的关系**：(b)/(c) 若落地，抢占决策要看「新话语是否与当前方向相关/quiet 是否够长」，**与窗口口径是同一件事的两面**，宜一并设计。
- **不改默认**：本任务只出此建议；窗口时长的默认值变更须人裁定。

---

## 5. 默认值须人裁定 + 边界（AC3）

- **默认值须人裁定**：本提案研究 (a)(b)(c) 三种形态、给建议、**不改任何产品默认值**。特别是任务硬约束——**未经人进一步裁定，不得把一切补充话语设成中断默认**（即形态 (c) 不得被默认化）。窗口时长同理（§4.2）。
- **本任务 diff 不触碰产品代码**：`git diff --name-only develop... -- server src` 为**空**（已验证）。本任务改动仅：本提案文档、`experiments/voice-realtime-busy-preemption-recheck/probe.mts`（探针，非产品路径）。
- **隔离边界（与 GOAL-041 / 本任务声明一致）**：复验用备用端口 `:3912` 第二实例 + dry-run 执行面；**不重启 `:3001`**（pid 766174 全程不变）；不触碰任何 Quay worker/driver/工作树；不向任何真实会话注入。

---

## 6. 与任务正文的偏差更正

- **合并窗口计数**：任务正文 Plan 第 4 条称「本场 9 次合并」。实测 journal 里 `queued: opening a 2500 ms coalescing window` 与 `coalesced …` 配对为 **11 次**（分布见 §4.1）。本提案按实测 11 次报告。
- **AC1 复验的定位**：任务 Plan 第 1 条要求读「执行面是否接受、回合是否中止」。dry-run 执行面**读不到真实 abort**（`stopped` 帧恒 `aborted:false, runId:null`）——「回合是否中止」只能读成「模型是否请求中止 + 执行面是否接受」。真实 abort 与 aftermath 需真机（依赖任务的回放器已具备，本任务为控成本与禁止重启 `:3001`，未做真机中断）。

---

## 附：产物

| 文件 | 内容 |
|---|---|
| `experiments/voice-realtime-busy-preemption-recheck/probe.mts` | 真实上游回放探针（本任务新建） |
| `/tmp/vbp-recheck/b5d01c21-….jsonl` | 本次回放的 run 工件（call/verdict 事件） |
| `/tmp/vbp-recheck/report-{terminate,pause}.json` | 每窗口的完整诊断报告 |
| `/tmp/vbp-recheck/second-instance.log` | 备用实例日志（含 G1 `correction not enqueued` 边界） |
