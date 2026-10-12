# Live Voice 整体架构审查（Draft-0，供讨论）

| 项 | 值 |
|---|---|
| 状态 | **Draft-0：只读审查结论 + to-be 提案，未经人裁定；不得据此直接立实现任务** |
| 基线 | `develop` = `author` @ `c8e0277b`（2026-10-12 17:40 CST） |
| 审查范围 | `server/modules/voice-realtime/**`、`src/modules/chat/voice-realtime/**`、聊天投影（`ChatInterface.tsx`、`transcript/**`）、执行链（`mcp-session-send.ts`、`chat-control.service.ts`、`chat-websocket.service.ts`、`claude-host-driver.provider.ts`）、测试设施（scripted upstream、debug-agent、Playwright voice specs）、GOAL-041 / GOAL-043 与其任务、Quay↔CloudCLI 边界 |
| 证据 | journal `ef9daacd`（五句话 segmented 测试，绑定会话 `4810bf08`，transcript `676b4c76`）、`99df08d8`×`c6493eb6`（长回合）、E9/E10 实验记录、代码 file:line（下文） |
| 立场 | **不默认现有 SPEC（`voice-realtime-persistent-control-SPEC.md`）与 A+ 正确**；A+ 中经实测成立的事实（E9/E10）保留为输入，其余一律重审 |

---

## 0. 结论摘要

1. **根因是缺一个“话语账本”（Utterance Ledger），不是缺某个补丁。** 一句话从音频段到 Claude 回合，要经过 5 种身份（segment `seq`、upstream `itemId`、`responseId`/`callId`、`queuedMessageUuid`/`commandUuid`、CLI 回合）。今天**没有任何一层持有它们之间的映射**：服务端靠「到达时刻正在提交的段」(`activeSegmentSeq`) 归属转写与工具调用，客户端靠文本包含关系把字幕和真实消息对上，执行侧靠「最新未出队条目」推断 uuid。三层各自用时序/文本启发式重建同一张图，于是乱序、误归属、静默丢失、重复回填成批出现。
2. **一个共享通道被三种职责复用。** 完整 `session.update` 同时承担「会话配置」「上下文」「执行状态注入」；配置没有唯一所有者，状态注入每次都把默认的 `turn_detection: server_vad` 写回去（`server/index.ts:623` + `voice-realtime-dashscope-transport.ts:483-492`），manual 分段模式下 VAD 被重开——这是 2026-10-12 五句话测试里「buffer too small」「response 被吞」「句子错位一格」「模型没被问到」四个症状的共同源头。
3. **“已接受”是一句没有兑现机制的承诺。** 工具调用一进合并窗口就回复模型 accepted；之后的 flush 失败、单飞冲突、120 s 忙等超时、浏览器断开都会让话语丢失，没有 outbox、没有 `deliveryId`、没有幂等键。
4. **执行身份是推断出来的，且在关键处错位。** 忙时常驻发送用 `supersedeRunning` 顶替 registry run（`chat-websocket.service.ts:815-819`），`abort` 随后 `completeRun` 的是**排队消息的 run**而非被中断的回合（`chat-control.service.ts:695-703`）；栅栏的覆盖半边依赖的 `hostCommandLifecycle` 在生产装配中**未接线**（只在 ws-proxy:880/1535 出现）。
5. **复杂度集中在一个 1430 行闭包里。** `handleVoiceRealtimeConnection`（ws-proxy:1106-2537）持有约 39 个可变单元（含 `execStatus` 约 50），覆盖传输/感知/意图/执行/投影/观测六类职责；「队列深度」一个事实有 7 处副本仍不完整（`heldDelivery` 未计入）。
6. **测试设施是逐缺陷的场景脚本，不是模型。** 4 个假上游都是命令式脚本；没有协议状态机、没有 CLI 宿主模型（E10 的回合边界聚合、stale-first 窗口都未建模）、没有虚拟时钟、没有性质测试；大量 pin（工具数、指令文本、测试文件数）让重构昂贵。
7. **建议**：以「事件溯源的话语账本 + 纯函数核心 + 适配器外壳 + 服务端权威投影」重建，按 strangler 方式分 5 期迁移；用「协议模型 + CLI 宿主模型 + 虚拟时钟 + 不变量预言」的确定性模型测试取代逐缺陷 spec。GOAL-041/043 的进行中任务大部分应**暂停或并入**新架构（§9）。

---

## 1. As-is：五层职责与所有权

| 目标层 | 今天落在哪里 | 混杂点（证据） |
|---|---|---|
| **T 传输** | `dashscope-transport`（1106 行）、`bridge`（1068）、`upstream-pool`（484）、ws-proxy 浏览器帧解析（1013-1092） | transport 内含工具校验/数值强转（903-926）、响应仲裁（694-797）；bridge 内含 TOOL_LOOP_GUARD、MODEL_TEXT_REPLY 判定；pool 只给每个 session 下发一次指令（192-197），开启 pool 时状态/上下文更新被静默吞掉 |
| **P 感知** | 浏览器 `StreamingVad`+`LiveSegmenter`（客户端切段、铸 `seq`）；bridge `writeSegmentClose`（637-652）；ws-proxy 段簿记（1327-1412）、转写保持（1965-1984） | 段↔条目映射不存在：`caption.itemId` 原样透传、从不与 `seq` 关联；转写按到达时的 `activeSegmentSeq` 记账（2289-2290）；`response.done` 不核对 responseId 就结算段（bridge 721-726）；客户端切段器 O(n²) 且无界缓冲（`voiceLiveSegmenter.ts:325-347`） |
| **I 意图控制** | ws-proxy：合并窗口（1659-1747）、连续模式去重（文本归一化 1820-1836）、字节准入（1850-1876）、单飞+忙等（1556-1656）、重放闸（1800-1806）、中断栅栏（703-724, 2105-2117） | 4 个等待处（hold / 合并窗口 / `waitingExtraMessages` / CLI 队列），各自的拼接与准入规则不同；去重靠文本；`unforwardedUserUtterances` 在 commit 与 final 各加一次（2240, 2277） |
| **E 执行适配** | ws-proxy 宿主对账（1452-1554）、live-executor、`mcp-session-send`、`chat-control`、host driver | `queuedMessageUuid` = 读取时刻的「最新未出队」（host 2597-2610 / chat-control 596）；`commandUuid→utteranceSeq` 取 flush 时刻的序号（1519-1523），合并窗口内已被后续话语推进；run 被忙时发送顶替；`hostCommandLifecycle` 未装配 |
| **V 投影/UI** | 服务端 13 种帧（543-642）；客户端 `useVoiceRealtimeSession` 帧归约（802-1048）、`placeCaptions.ts`（469）、`ChatInterface` useMemo（540-575）、`VoiceRealtimeBar` 自有优先级（198-310） | 至少 5 条文本匹配规则（hook 归属 971-985、`messageIsDeliveryRow` 86-95、`dropCaptionsDeliveredAsMessages` 375-397、`messageWordsAlreadyVisible` 242-252、「思路窗口」兜底 984）；两种放置算法按时间戳可读性切换（431-447）；折叠行 id 随首条 pending 变化导致重挂载（180）；拒绝行被追加到更新的活动行之后（`ChatInterface.tsx:565-566`） |
| **O 观测** | `voice-realtime-log.ts` 用正则从自由文本日志重建结构化 journal（414-434） | 生产代码为迁就解析器改写日志措辞（1828-1830）；journal 的 `session.update` 行分不清 VAD-off 与状态注入，caption 行无 itemId |

**所有权缺口**：没有任何组件拥有「这句话现在在哪、最终怎样了」。每一层只拥有自己那段时序，跨层事实靠启发式重建。

---

## 2. 2026-10-12 五句话测试的根因链（证据 `ef9daacd`）

| 症状 | 事实 | 根因链 | 所属层 |
|---|---|---|---|
| VAD 被重开 | 3 次重开均紧随成功投递后的状态注入；之后 `speech_started` 出现、`speech_stopped` 0 次 | 状态注入 = 完整 `session.update` ⇒ 展开默认 `server_vad`；`vadDisabledOnSocket` 已为 true 不再补发 null | **T 配置无唯一所有者** × E 状态投影借道 |
| buffer too small（seq1/6/8） | 均为注入后的第一次 commit | VAD 开启后 commit 只看到 VAD 已捕获的音频（或更新清空缓冲，二者未区分） | T/P |
| 句子错位一格 | item B5xb 在 seq1 音频上传后由 VAD 创建、被 seq2 的 commit 提交；时长只在「滞后一段」假设下吻合 | VAD 自建条目 + 按「到达时提交的段」归属 | **P 无 provenance** |
| 模型“不转发”第 2、4 句 | seq2/3/4/6 的 `speech_started` 比 `response.created` 早 110–280 ms，**无 response 被创建** | VAD barge-in 吞掉 response：模型根本没被问到；仅 seq5 的 response 一次性看到 4 个条目、只转发了最新一句 | T（主）+ I（一次模型选择） |
| 第三句丢失 | item Q26n 已提交，既无 completed 也无 failed | 感知层没有「超时 ⇒ 未识别」的终态 | **P 无终态保证** |
| 字幕乱序/消失 | journal 中字幕按条目顺序到达 | 投影按到达排序、按文本归属、折叠行 id 漂移 | **V 无身份** |
| OK 文本回复 | commit 失败后仍发出 `response.create` | bridge 不等 `committed` 就发 response；投递后的结构性「OK」回合 | T 排序 |

成本：8 次 response、9,372 输入 token；**无投递的 response 占 64% token**（5 次：3 次结构性 post-tool OK + 2 次孤儿 OK）；4 次 commit 根本没有 response。延迟：第 4、6 句的话从说完到投递 14.0 s / 15.9 s（一段滞后 + 2.5 s 固定合并窗口）。

GOAL-043 已有结论的偏差：(a) AC-354「按 commit 的 item_id 归属」在 VAD 开启时会把 B5xb 错归到 seq2——只有在 VAD-off 被保证后才成立，一般情形需按音频 provenance；(b) 未识别 response 被 VAD 吞掉这一机制，把一部分「模型不转发」误归为模型行为；(c) 漏计 seq8 的 buffer-too-small、第三次投递，以及 seq5/7/8 音频的去向。

---

## 3. To-be：分层与所有权

```
浏览器                         服务端（每个语音连接一个 VoiceSession）                         执行面
┌───────────┐  typed frames  ┌───────────────────────────────────────────────────────────┐  submit/abort/withdraw  ┌──────────┐
│ Capture   │ ─────────────▶ │ Shell（适配器，唯一做 IO/计时的地方）                          │ ─────────────────────▶ │ Claude   │
│ Segmenter │ ◀───────────── │  T: UpstreamAdapter(SessionConfig 唯一所有者) │ BrowserChannel│ ◀───────────────────── │ resident │
│ Renderer  │  projection    │  E: ExecutionAdapter(outbox, commandUuid, turn lifecycle)    │   lifecycle events     │ host     │
└───────────┘   events       │ ──────── facts ────────▶  Core（纯函数 reducer） ── commands ─▶│                        └──────────┘
                             │   P: Perception（段/条目 provenance、终态计时）                 │
                             │   I: IntentControl（response 窗口归属、准入、合并、栅栏）       │
                             │   L: UtteranceLedger（身份图 + 处置状态，唯一事实源）           │
                             │   V: Projection（服务端权威视图 → 浏览器）                       │
                             │   O: 账本事件即 journal（结构化，取代正则日志）                  │
                             └───────────────────────────────────────────────────────────┘
```

| 层 | 拥有 | 不得做 |
|---|---|---|
| **T UpstreamAdapter** | 上游协议状态机；**`SessionConfig` 唯一所有者**（模式派生 `turn_detection`，任何更新都由完整配置序列化）；response 串行化（同一时刻至多一个 response）；把上游事件翻译为**带身份的事实** | 判断要不要投递；改写配置的某一字段而不经所有者 |
| **T BrowserChannel** | 带序号的帧、`connectionId`+`lastEventSeq` 断线续传、背压 | 投影逻辑 |
| **P Perception** | `AudioSegment`、`PerceptionItem`、段↔条目 provenance、每个条目有界时间内到达终态（transcribed / unrecognized / empty / failed） | 依据文本做任何判断 |
| **I IntentControl** | 模型的工具调用 → `Intent`（带 `responseId` 与该 response 的输入窗口）；准入；合并；中断栅栏 | 语义判断（那是模型的）；文本去重 |
| **E ExecutionAdapter** | `Delivery` outbox、幂等键、**同步取得 `commandUuid`**、`ExecutionTurn`（`system/init`..`result`）与其覆盖的命令集、按回合 id 中断、按 uuid 撤回 | 推断「最新未出队」；顶替 registry run |
| **L UtteranceLedger** | 身份图与每个话语的处置状态；所有派生读数（深度、覆盖、未投递）的唯一来源 | IO |
| **V Projection** | `utterance.update{utteranceId, order, text, state, deliveryId?, turnId?}` 视图；按**说话顺序**排序；客户端只渲染 | 文本匹配；到达顺序排序 |

**语义判断 vs 事实**：只有三件事是模型的语义判断——是否转发、如何改写、是否中断（及其 `intent`）。其余一切（归属、顺序、终态、深度、覆盖）都是可由事实事件确定性推导的，**禁止**用文本或时序启发式。

---

## 4. 身份与多对多关系

| 实体 | 身份 | 铸造者 |
|---|---|---|
| AudioSegment | `(connectionId, seq)` | 浏览器切段器 |
| PerceptionItem | upstream `itemId` | 上游（commit 或 VAD） |
| ModelResponse | `responseId` | 上游；其**输入窗口** = 上一个 response 创建后新提交的条目集合 |
| Intent | `(responseId, callId)` | 上游工具调用 |
| Delivery | `deliveryId`（服务端铸、作幂等键） | ExecutionAdapter |
| QueuedCommand | `commandUuid` | 宿主在**推入时**铸并同步返回 |
| ExecutionTurn | `turnId`（宿主按 `system/init`..`result` 切分） | 宿主 |

关系：Segment ⟷ Item **M:N**（manual 模式期望 1:1；VAD 可拆可并）；Item ⟷ Response **N:1**（窗口）；Response → Intent **1:N**；Intent ⟷ Item **M:N**，取 response 窗口作确定性上界；Intent → Delivery **N:1**（合并）；Delivery → Command **1:1**；Command → Turn **N:1**（E10/U3 回合边界聚合）；Interrupt-Intent → 目标 Turn **1:1**。

**覆盖**：条目 i 被回合 T 覆盖 ⇔ ∃ Delivery d：i ∈ items(intents(d)) ∧ d.commandUuid ∈ T.commands。
**未转发**（确定性可知）：response R 已 `done`、i ∈ window(R)、R 产生的 send 意图集合为空 ⇒ i 处置为 `not-forwarded`（模型选择，诚实显示，**不自动补发**——沿用人裁定）。

替代方案：(a) 让模型在 `session_send` 中引用 itemId——不可信、增加 token；(b) 文本匹配——即今天的做法，已证伪。**推荐 response 窗口归属**：粒度是「这一轮模型看过的条目」，与模型真实可见的信息一致。

---

## 5. 状态机

**PerceptionItem**：`appended → committed(item) → transcribing → {transcribed | unrecognized(timeout) | empty | failed}`；终态必须在 `T_dispose`（建议 8 s，可配）内到达或随上游断线转 `failed`。

**Utterance（以条目为单位的处置）**：`heard → considered(responseId) → {not-forwarded | intended(intentId)} → pending-delivery(deliveryId) → submitted(commandUuid) → {started(turnId) → completed | interrupted} | withdrawn | failed(reason) | abandoned(exit)`。每个终态都投影到 UI 与 journal。

**ModelResponse**：`requested → created(responseId) → {done | cancelled | error}`；任一时刻至多一个 `requested|created`（串行化，消灭 RESPONSE_CONCURRENCY_CONFLICT 与孤儿 response）；commit 失败 ⇒ 不发该段的 response。

**Delivery（outbox）**：`queued → submitting → submitted(commandUuid) → started(turnId) → {completed | interrupted}`；`submitting` 失败按幂等键重试 N 次后 `failed`（可见）；`submitted ∧ ¬started` 可 `withdrawn`。

**ExecutionTurn**：`started(commands) → interrupting(trigger) → ended(aborted|completed)`；中断 = G1（修正先成为 `submitted`）+ 目标 turnId + 栅栏（trigger 已被 T 覆盖 ⇒ no-op）。

**VoiceSession**：`connecting → live → {reconnecting(upstream) | resuming(browser)} → closing(exit grace) → closed`；`closing` 期间未终态条目只能 `delivered`（宽限内）或**恰好一次**回填 composer。

---

## 6. 交付、取消、乱序、重放、断线、成本延迟

| 主题 | 保证（to-be） | 今天 |
|---|---|---|
| 投递 | outbox：**accepted ⇒ 最终 submitted 或可见 failed**；对 CLI **至多一次**（`deliveryId` 幂等） | 至多一次、best effort、无键；失败只发错误帧 |
| 撤回 | `submitted ∧ ¬started` 按 `commandUuid` 撤回（E9/E10-U4 实测可用） | 语音面无路径；uuid 靠推断 |
| 中断 | 修正先 submitted 再 abort（E10/U2：≥50 ms 即 stale-first）；目标 turnId；每 (turn, trigger) 至多一次 | abort 后才释放修正；run 身份错位；覆盖半边未接线 |
| 乱序 | 一切排序用 `seq`/条目 provenance；到达顺序只用于等待 | 归属与排序均按到达 |
| 重放 | 上游重连：未 commit 段重放、未终态条目转 `failed`；`openAttempts` 在成功打开后重置 | `openAttempts` 终身累计（bridge 538/878） |
| 浏览器断线 | `lastEventSeq` 续传投影；服务端账本保留宽限期 | 断开即丢客户端全部投影状态 |
| 退出 | 关闭前等待在途 commit 的终态（有界）；回填恰好一次 | flush 后立即 close，最后一段必丢；回填可能与迟到投递重复 |
| 成本 | 每 commit ≤ 1 次 response；状态不再走全量 `session.update`（或至少由配置所有者序列化）；post-tool response 在 manual 模式下待实测是否可省 | 64% token 无投递；每 2 s 重发整份指令 |
| 延迟 | 合并只在**CLI 空闲**时做起轮防抖；CLI 忙时立即入队（CLI 自会在回合边界聚合，E10/U3） | 固定 2.5 s 窗口，忙时纯等待 |

---

## 7. 可形式化不变量（模型测试的预言）

| # | 不变量 | 类型 | 今天 |
|---|---|---|---|
| INV-1 | manual 模式下每个出站会话配置 `turn_detection = null` | 安全 | **违反**（2026-10-12） |
| INV-2 | 任一时刻至多一个在途 ModelResponse；commit 失败的段不发 response | 安全 | 违反（孤儿 OK、并发冲突） |
| INV-3 | 每个已提交条目在 `T_dispose` 内到达感知终态 | 活性 | 违反（Q26n 永无终态） |
| INV-4 | 每个话语最终有且仅有一个处置终态，且已投影与入 journal | 活性+完备 | 违反（静默丢失多处） |
| INV-5 | `not-forwarded` 条目不会被系统自动投递（人裁定） | 安全 | 成立 |
| INV-6 | 每个 `deliveryId` 至多对应一个 `commandUuid`；accepted 的投递最终 submitted 或 failed-可见 | 安全+活性 | 违反（无键、失败即丢） |
| INV-7 | 投递到 CLI 的顺序 = 其条目的最小说话序；投影行序 = 说话序 | 安全 | 违反（到达序） |
| INV-8 | 中断：修正先 submitted；目标为 trigger 未被覆盖的回合；每 (turn, trigger) 至多一次 abort；从不触及非绑定会话/后台任务 | 安全 | 部分（覆盖半边未接线、run 错位） |
| INV-9 | 投影队列深度 = 宿主未出队数（每个对账点）；回合边界后 Δ 内刷新 | 安全+活性 | 部分（事件驱动刷新、7 处副本） |
| INV-10 | 每 commit 的 response 数 ≤ 1（+ 可配置的 post-tool 1 次）；状态注入次数有界 | 成本 | 违反（64% 浪费） |
| INV-11 | 退出时每个未终态话语恰好一次：宽限内投递，或回填 composer | 安全 | 违反（最后一段必丢、可能重复） |
| INV-12 | 投影按会话隔离（A 的关闭痕迹不出现在 B） | 安全 | 违反（`ChatInterface.tsx:574`） |

---

## 8. 确定性模型测试框架

**核心原则**：to-be 的 Core 本身是纯函数 `reduce(state, fact) → (state, commands)`；IO 与计时只在 Shell。于是测试 = 生成事实序列、跑 Core、每步检查不变量。

| 组件 | 内容 | 复用 |
|---|---|---|
| 上游协议模型 | `turn_detection`、缓冲计账、条目（commit/VAD 两种来源）、response 生命周期（含被 VAD 吞掉）、转写策略（准时/延迟/乱序/永不/失败）、错误（buffer too small、active response）；**带种子的非确定性调度** | 由 AC-359 的设计升级为生成式模型；帧 builders、`onClientFrame` 复用 |
| CLI 宿主模型 | E9/E10 语义：回合边界聚合 N 条、中断保留队列、stale-first ≥50 ms、按 uuid 撤回（含非最新） | 合并两份 ad-hoc `createScriptedHost`；扩展 debug-agent `dequeue` 批量 |
| 虚拟时钟 | Core 只经注入时钟；所有窗口（合并、终态、状态限频）由模型时钟驱动 | `pacedFileAudioSource` 的 schedule seam 思路 |
| 生成与收缩 | 引入 `fast-check`（待裁定）或自研种子调度器 | — |
| 不变量预言 | §7 INV-1..12 作为每步断言 | 现有 fence/depth/segmented 不变量测试改写为性质 |
| journal → 种子 | 生产 journal 自动转为事实序列回放（新 journal 用结构化账本事件，无需正则） | 现有 replay fixtures |
| 一致性 | 模型必须接受真实 trace（`ef9daacd`、`99df08d8`、qwen38 trace）——防止模型与真实上游漂移 | 现有录制 |
| 分层 | L0 Core 性质测试（千级种子、毫秒级、无 IO）；L1 适配器契约（T 对协议模型、E 对 debug-agent 宿主）；L2 少量 Playwright（固定种子，只验渲染）；L3 抽样真实运行（付费，单次） | 现有 Playwright 规格大部分可降为 L2 少量用例 |

**pin 治理**：工具数/指令逐字/测试文件数 pin 改为对**契约**断言（工具名集合来自单一注册表；指令按语义要素断言），减少重构摩擦。

---

## 9. 差距矩阵与进行中任务建议

| 任务 | AC | 状态 | 建议 | 理由 |
|---|---|---|---|---|
| `gap-live-voice-manual-mode-session-update-keeps-vad-off` | 353 | ready | **KEEP（改范围）** | 唯一的线上安全缺陷修复；实现应为「SessionConfig 单一所有者、任何更新都由完整配置序列化」，而非在注入点补 null |
| `gap-live-voice-replay-local-egress-guard` | 360 | todo | **KEEP（解依赖）** | 保护性、低成本；去掉对 357 的依赖 |
| `gap-live-voice-caption-segment-attribution-by-item-id` | 354 | todo | **PAUSE → 并入 P 层** | 按 commit item_id 归属在 VAD 开启时错误；应为 provenance |
| `gap-live-voice-segment-honest-heard-unrecognized-state` | 355 | todo | **PAUSE → 并入 V 层** | 需服务端权威处置状态，客户端再加规则会成为第 6 条启发式 |
| `gap-live-voice-segmented-replay-closure` | 356 | todo | **CHANGE** | 保留为验收目标；以模型框架的种子 + 少量 L2 实现 |
| `gap-live-voice-replay-known-defect-signatures` / `…event-synced-waits` | 357 / 358 | todo | **PAUSE** | 继续加固逐缺陷 Playwright 回放的边际价值低 |
| `gap-live-voice-scripted-upstream-protocol-state-machine` | 359 | todo | **CHANGE → 新框架的上游协议模型** | 从场景配置升级为生成式模型 |
| `gap-live-voice-interrupt-after-revision-enqueued` | 342 | ready | **PAUSE → 并入 E 层** | 需同步 `commandUuid` 与回合身份，否则在错位的 run 身份上再加补丁 |
| `gap-live-voice-queue-depth-refresh-on-turn-boundary` | 344 | ready | **PAUSE → 并入 E 层** | 深度应由账本派生，不再给 7 处副本加刷新 |
| `gap-live-voice-interrupt-honest-aftermath` | 344 | todo | **PAUSE → 并入 E 层** | 同上 |
| `gap-live-voice-pending-utterance-withdraw` | 351 | todo | **PAUSE → E+V** | 依赖可靠的 `commandUuid` 身份 |
| `gap-live-voice-intent-control-browser-e2e` | 345 | todo | **PAUSE → L2** | 由模型框架承担主体覆盖 |
| `gap-live-voice-interrupt-semantic-sampling` | 346 | todo | **DEFER** | 与架构正交，但应在新 prompt/response 策略稳定后再付费抽样 |
| GOAL-041 已 done 任务（338/339/340/341/343/350） | — | done | **KEEP（事实）** | E10 读数、审计字段、无停止词规则保留为输入；栅栏/对账实现将被新 Core 取代 |

额外发现的线上缺陷（建议在讨论后决定是否作为「止血」处理，而非逐个立补丁）：`hostCommandLifecycle` 未装配（栅栏覆盖失效）；abort 结束错误的 run；`openAttempts` 不重置；退出必丢最后一段；关闭痕迹跨会话泄漏；`heldDelivery` 不计入深度。

---

## 10. 分阶段兼容迁移（strangler）

| 期 | 内容 | 兼容方式 | 退出判据 |
|---|---|---|---|
| **M0 止血** | AC-353（配置单一所有者）+ 经裁定的少量线上缺陷 | 直接替换 | INV-1、INV-11（最后一段）在 L1 契约测试成立 |
| **M1 账本事件与框架骨架** | 结构化账本事件与 journal v2（与旧日志并行）；上游协议模型 + CLI 宿主模型 + 虚拟时钟 + journal→种子 | 只增不改行为 | 真实 trace 被模型接受；INV 预言能在旧实现上**复现**已知违反（红先行） |
| **M2 纯函数 Core（影子模式）** | 抽出 P/I/L 为 reducer；ws-proxy 同时跑旧逻辑与 Core，记录分歧 | 影子，不改输出 | L0 性质测试全绿；影子分歧仅限已知缺陷类别 |
| **M3 执行适配器** | outbox、`deliveryId`、同步 `commandUuid`、`turnId`、按回合中断（G1+栅栏）、撤回；移除语音路径的 run 顶替 | 开关切换 | INV-6/8/9 在 L0+L1 成立 |
| **M4 服务端权威投影** | `utterance.update` 帧；客户端改为渲染器；删除文本匹配规则 | 新旧帧并存一个版本 | INV-4/7/11/12 在 L0+L2 成立；人工复测 |
| **M5 清理** | 删除旧闭包状态、continuous 模式（若裁定弃用）、pin 改契约 | — | 代码量与状态单元数下降（量化目标待定） |

---

## 11. 设计取舍（需人裁定）

| # | 取舍 | 推荐 | 备选与代价 |
|---|---|---|---|
| **A-1** | 架构形态 | 事件溯源账本 + 纯函数 Core + 适配器 Shell | 在 ws-proxy 内渐进重构：改动小，但无法获得确定性测试与单一事实源 |
| **A-2** | 投影权威 | 服务端权威视图，客户端只渲染 | 保留客户端启发式：继续出现乱序/重复回填 |
| **A-3** | 条目↔意图归属 | response 输入窗口 | 模型引用 itemId（不可信）/ 文本匹配（已证伪） |
| **A-4** | 状态如何到达模型 | 由 SessionConfig 所有者序列化（配置始终完整正确），并降低频率；评估「仅工具回执 + `session_status` 拉取」 | 继续 2 s 全量注入：成本与配置风险；逐 response 指令覆盖：DashScope 支持度未知 [U] |
| **A-5** | 合并策略 | 仅在 CLI 空闲时做起轮防抖；忙时立即入队 | 固定 2.5 s：每句多等 2.5 s |
| **A-6** | post-tool response | manual 模式下实测能否省略（省约 38% token） | 保留：稳定但贵；旧证据来自 continuous/server_vad 模式，不能直接外推 |
| **A-7** | continuous 模式 | M5 后弃用，只保留 segmented-manual | 保留：分支与测试面翻倍 |
| **A-8** | 测试框架依赖 | 引入 `fast-check`（devDependency） | 自研种子调度器：无收缩能力 |
| **A-9** | 进行中任务 | 按 §9 暂停/并入 | 继续逐缺陷推进：与新架构返工冲突 |
| **A-10** | Quay 执行方式 | 新建 GOAL（账本架构），每期 AC = 一组不变量性质测试；先有人工评审过的设计文档 | 沿用逐缺陷 AC：已证明会制造补丁堆叠 |

---

## 12. Quay ↔ CloudCLI 边界

- 语音架构完全属于 CloudCLI；语音面只作用于绑定会话（`live-executor.ts:323`），不触达 Quay 任务、worker、driver、工作树（今天已成立，to-be 保持并以 INV-8 钉住）。
- Quay 是开发过程的承载者：本审查的 to-be 一经裁定，应以「设计文档评审（人）→ 每期一个 AC 集（不变量性质测试为判据）→ 任务」的方式交给 Quay；避免再以单个缺陷为单位立 AC。
- 执行 worker 为 `v4.1flash`（SPEC D-10）。纯函数 Core 与模型框架是高复杂度工作，建议 M1/M2 的设计与关键接口由 Opus 会话起草并评审，worker 负责按接口实现与补测试；是否为这两期切换 worker 模型，按 D-10 的升级条件或人另行裁定。
