# Live Voice 整体架构审查（Draft-0，供讨论）

| 项 | 值 |
|---|---|
| 状态 | **Draft-1（§13 Decision proposal，2026-10-12）：收敛三处争议、给出最小可实现架构；仍未经人裁定，不得据此直接立实现任务**。Draft-0（§0–§12）保留作背景，凡与 §13 冲突以 §13 为准 |
| 排序修订 | **2026-10-12 人 yale 改为体验优先**：落地顺序以 `live-voice-experience-first-decision-2026-10.md`（Decision-E0）为准——先 continuous 基线体验与本地验证（GOAL-044），本文的控制请求串行化（H-2）、停止周期注入（H-8）与 segmented 精确归属降为成本阶段；目标架构方向不变 |
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

---

## 13. Draft-1 / Decision proposal（2026-10-12）

本节收敛 Draft-0 的三处争议：(1) 账本要不要持久化；(2) 上游协议到底保证了什么、无法确定的归属如何处理；(3) Intent 要不要成为实体。结论先行，再给最小可实现架构、对象/事件/状态、不变量、接口伪代码、M0–M3 与任务清单、本地模型测试。**凡标 ⚖️ 处需人裁定。**

### 13.0 三项结论

| 争议 | 结论 | 一句话理由 |
|---|---|---|
| **(1) 事件账本** | **内存中的结构化事实日志 + 纯函数 reducer 足够；不做持久 Event Sourcing。** journal 文件只是同一批事实的**只写**审计副本，从不读回重建状态 | 语音会话的执行目标（常驻 CLI）随服务进程退出（E5：父进程被杀 ⇒ 常驻进程 EOF 退出），持久 outbox 没有可交付的对象；跨重启的事实已由 CLI transcript 与会话库承载 |
| **(2) 协议归属** | **只有三种映射有真实保证**：`committed.item_id`、转写事件的 `item_id`、输出事件的 `response_id`/`call_id`。其余（commit↔item 的客户端配对、response 的输入窗口、VAD 条目的音频来源）**协议都不保证**，只能靠**我方串行化**做成「构造上精确」；任何串行化前提被破坏，就显式记为 `unknown(reason)`，**禁止按时序猜** | 官方文档：error 不回指客户端事件；`committed` 无相关字段；response 不引用输入；VAD 两个毫秒字段基准不同且无对齐说明；转写与 response 之间无顺序保证 |
| **(3) Intent** | **Intent 不是实体，不持久化。** 它就是不可变事实 `ToolCalled{responseId, callId, args}`；唯一有生命周期的执行侧对象是 `Delivery`。用一条**反缓冲不变量**钉死「CLI 忙时不持有、系统不改写」，从结构上排除 Active Intent Buffer（方案 B） | 有生命周期的 Intent 一旦存在，「合并/取代/延迟提交」就有了落脚点，B 会以「改进」之名回来 |

### 13.1 争议 (1)：事实日志与 reducer，何时才需要持久 ES

**最小形态**：
- 每个语音连接一个 `VoiceSession`，内含追加式 `facts: Fact[]` 与纯函数 `reduce(state, fact) → {state, commands}`。
- `state` 是由 `facts` 唯一决定的派生物。
- 对浏览器的投影、对模型的状态读数、journal 行，全部从同一个 `state` 或 `facts` 派生。

**有界**：终态满 `T_gc`（建议 60 s）的条目从 `state` 回收；`facts` 只保留一个滚动窗口，供浏览器续传（§13.4 `lastEventSeq`），完整副本只写 journal。

**升级到持久 ES 的触发条件**（任一成立再议，⚖️ 当前全部不成立）：
1. 要求「已被接受的话语」在**服务进程重启后**仍能投递，且执行目标在重启后仍存活（例如常驻宿主独立于 Web 服务进程）。
2. 多实例部署，语音连接可在实例间迁移。
3. 需要在服务进程内回放历史事实来**恢复**状态（而不只是审计或离线测试）。

**今天的 journal 怎么办**：保留，改为事实的结构化序列化（journal v2），不再由正则解析自由文本日志。它是测试种子来源（journal → 事实序列 → 回放），但**不是**运行时恢复来源。

### 13.2 争议 (2)：协议事实表与 Unknown Attribution

依据：官方服务端事件文档 [server-events](https://help.aliyun.com/zh/model-studio/server-events)、客户端事件文档 [client-events](https://help.aliyun.com/zh/model-studio/client-events)，以及本仓真实录制 `server/modules/voice-realtime/tests/fixtures/real-run-qwen38-four-utterances.json`（qwen3.8-omni-flash-realtime，2026-10-09）。D = 文档承诺，O = 仅观测，U = 未知 / 文档不承诺。

| # | 协议事实 | 级别 | 架构含义 |
|---|---|---|---|
| P-1 | `session.update` 省略 `turn_detection` ⇒「系统将使用默认参数启用 VAD」；`null` 才禁用 | **D** | manual 模式下**每一次** `session.update` 都必须显式携带 `turn_detection: null`。这是 2026-10-12 VAD 重开的文档级根因，与「展开默认值」无关 |
| P-2 | `session.update` 是整体替换还是增量合并 | **U** | 由 `SessionConfig` 单一所有者每次发送完整配置，规避该未知 |
| P-3 | server_vad 下客户端 commit「无需发送」；手动模式必须 commit 才生成用户条目；commit **不触发** response；缓冲为空 ⇒ error | **D** | VAD 一旦被重开，手动 commit 失去意义；空 commit 的错误是预期，不是偶发 |
| P-4 | 最小可提交音频长度 | **U** | 「buffer too small」阈值作为模型参数，测试扫描，不硬编码 |
| P-5 | `input_audio_buffer.committed{item_id}`：只有 `item_id`，无客户端事件关联 | **D** | commit↔条目配对**协议不保证**，只能靠「同一时刻至多一个未决 commit」构造 |
| P-6 | `error{error:{type,code,message,param}}` 不回指触发它的客户端事件 | **D**（无此字段） | 错误归属同样只能靠「至多一个未决控制请求」构造；否则 `unknown` |
| P-7 | 转写 `completed/failed{item_id}`；`completed.transcript` 为最终结果 | **D** | 转写↔条目精确；转写**内容**与模型理解可能不同（文档原话），因此转写只用于显示，不用于归属 |
| P-8 | 转写事件与 response 事件之间无顺序保证 | **D**（未承诺） | 不得以「先到的转写」归属工具调用 |
| P-9 | `response.created/done` 不引用任何输入条目；输出事件带 `response_id`，函数调用带 `call_id` | **D** | 工具调用 → response 精确；response 的**输入窗口协议不给**，只能由「我方发出的唯一 `response.create`」构造 |
| P-10 | `conversation.item.created` 顶层带 `previous_item_id`（message / function_call） | **O**（文档称仅 MCP 审批项有；真实 trace 每条都有） | 可用作**一致性检查**与诊断，**不得**作为归属依据 |
| P-11 | `speech_started.audio_start_ms`（基准：缓冲写入开始）与 `speech_stopped.audio_end_ms`（基准：会话开始）基准不同，文档未对齐 | **D**（不一致） | VAD 条目的音频来源**不可确定** ⇒ 一律 `unknown(vad-provenance)` |
| P-12 | `response.create` 无按次参数（文档未列 instructions 等） | **D**（未列） | 状态无法随单个 response 下发 |
| P-13 | `conversation.item.create` 只接受 `function_call_output` / `mcp_approval_response`；无 `item.delete` | **D** | 不能以条目注入状态；注入的条目也无法收回 |
| P-14 | `response.cancel` 存在；无进行中 response 时返回 error | **D** | 可用于中止孤儿 response |
| P-15 | VAD barge-in 吞掉手动 `response.create`（`speech_started` 早于 `response.created` 则不再创建） | **O**（ef9daacd，4 次） | 只在 VAD 被错误开启时出现；P-1 修复后应消失，模型测试中保留为「降级」场景 |
| P-16 | 同一 WebSocket 上服务端事件按发送顺序到达 | 传输层保证（TCP/WS） | 上游**条目顺序**是事实，可用于排序（不是归属） |

**由此得到的归属规则（构造上精确，否则 Unknown）**：

```
UpstreamControlQueue: 同一时刻至多一个未决控制请求
  commit(seq)         → 等 committed{item_id} | error | timeout   ⇒ 配对 exact(seq ↔ item) 或 segment.commitFailed
  response.create(w)  → 等 response.created{id} | error | timeout ⇒ response.window = w（exact）
  session.update(cfg) → 等 session.updated | error | timeout
  response.cancel     → 等 response.done(status≠completed) | error
音频 append 无回执：只在没有未决 commit 时发送本段音频
```

- `response.create` 只在两种时刻发出：本段的 `committed` 已到，或 post-tool（见 13.6 ⚖️）。其窗口 `w` = 上一个由我方创建的 response 之后、被 exact 配对的条目集合。
- **降级检测（任一出现 ⇒ 该会话进入 `attribution: degraded`）**：
  - manual 模式下收到 `speech_started` / `speech_stopped`（说明 VAD 实际开启）；
  - 收到一个不配对任何未决 commit 的 `committed` / `item.created`（用户条目）；
  - 收到一个不配对我方未决 `response.create` 的 `response.created`；
  - 未决请求的 error 与另一请求在超时窗口内交叠。
- **降级后的处理**：
  - 受影响的条目、response、工具调用一律 `attribution = unknown(reason)`，不做任何时序推断；
  - 投影按**上游事件顺序（P-16）**显示，并显式标注「无法对应到哪一段话」；
  - journal 记 `AttributionDegraded{reason, firstEvidence}`；
  - 会话可尝试**重建**：先发送完整配置（P-1）、等待 `session.updated`，再在下一个 commit 起恢复 `exact`。
  - ⚖️ 降级后是否自动重建配置，还是只提示用户。
- `previous_item_id`（P-10）只做断言：exact 配对结果与观测链不一致 ⇒ 记 `ProtocolAnomaly`，并把该条目改为 `unknown(chain-mismatch)`。
- **代价**：commit 回执实测 115–150 ms，串行化使每段从说完到 `response.create` 多出约一个回执 RTT（今天是同 tick 发出，P-15 的孤儿 OK 正是这种并发的产物）。⚖️ 接受该延迟换取精确归属。

### 13.3 争议 (3)：Intent 不是实体，而是事实

| 方案 | 形态 | 风险 |
|---|---|---|
| **推荐 R** | `ToolCalled{responseId, callId, tool, args}` 是不可变事实；`Delivery.sources = [(responseId, callId)…]` 引用它；中断是一次执行命令 `InterruptAttempt` | 无 |
| 备选 E | 独立 Intent 实体：带状态（pending / merged / superseded / submitted），可被系统合并、取代、延迟 | 就是 Active Intent Buffer（方案 B）的换名，违反 A+ 裁定 D-5 |
| 备选 P | 持久化 Intent | 见 13.1，没有可交付对象 |

**反缓冲不变量（INV-B，把 A+ 写成可测试的条款）**：
- **B-1 不持有**：执行面忙（存在未结束回合或未出队命令）时，任何 `ToolCalled(session_send)` 在 `≤ ε`（处理时间）内产生 `Delivery.submitting`。唯一例外是转写闸（见下 ⚖️，≤ 600 ms）。
- **B-2 仅空闲防抖**：执行面空闲时，允许把 `≤ D` 毫秒内连续到达的 send 合成一个 Delivery（起轮防抖）。⚖️ D 取值，建议 1500 ms，替代今天固定的 2500 ms 合并窗口。
- **B-3 不改写**：`Delivery.text` = 其 `sources` 的 `args.message` 按到达顺序以固定分隔符拼接；系统从不删除、改写、去重、重排模型给出的文本。今天按文本归一化的连续模式去重属于违反项，迁移中删除；重复防护改为按 `(responseId, callId)` 精确去重。
- **B-4 不补发**：未被任何 `ToolCalled` 引用的条目永远不会进入任何 Delivery（沿用人裁定）。
- **B-5 不取代**：已 `submitting` 及之后的 Delivery 不会被系统撤回或合并。撤回只由用户 UI 触发（D-11 阶段 2）。

⚖️ **转写闸**：今天 `session_send` 在其段的转写未知时最多保持 600 ms（防止模型凭空编一句）。保留会成为 B-1 的唯一例外，且必须计入深度与投影；删除则接受「转写为空但模型仍转发」的极少数情况（由用户在投影中看到）。建议保留，状态记为 `Delivery.gated`。

### 13.4 最小可实现架构（M3 终态）

```
Browser ──frames(seq)──▶ BrowserPort ─┐                              ┌─▶ ExecutionPort ──▶ chat-control / host driver
                                       ├─ facts ─▶ VoiceCore.reduce ──┤
DashScope ◀─▶ UpstreamSession ────────┘   (pure)       │              ├─▶ UpstreamSession (control commands)
            (SessionConfig + ControlQueue)              │              ├─▶ BrowserPort (projection diffs)
                                                        ▼              └─▶ Timers (virtual in tests)
                                                   journal v2 (write-only)
```

**组件（4 个有状态外壳 + 1 个纯核心）**：
- **`UpstreamSession`**（T）：拥有 `SessionConfig` 与 `UpstreamControlQueue`；翻译上游事件为事实；检测降级。吸收今天 transport 与 bridge 中的协议部分。
- **`ExecutionPort`**（E）：`submit` 同步返回 `commandUuid`，订阅宿主 lifecycle（`started` 带回合 id，回合结束），`abort(turnId)`，`withdraw(commandUuid)`。改造 chat-control 与 host driver 的忙时路径：语音路径不再 `supersedeRunning`。
- **`BrowserPort`**（T）：带序号帧，`resume(lastEventSeq)`。
- **`Timers`**：注入时钟。
- **`VoiceCore`**（纯）：对象表与 reducer。ws-proxy 闭包降为装配层（目标 ≤ 300 行）。

### 13.5 对象、事实与状态

**对象（全部只存在于内存 `state`）**：

| 对象 | 键 | 状态 |
|---|---|---|
| Segment | `seq` | `open → closed → committing → {committed(itemId) \| commitFailed(code)}` |
| Item | `itemId` | `committed(attribution: exact(seq) \| unknown(r)) → {transcribed(text) \| empty \| unrecognized(timeout) \| failed}` |
| Response | `responseId` | `requested(window) → created → {done(outputs) \| cancelled \| failed}`；`window: exact(itemIds) \| unknown(r)` |
| ToolCall | `(responseId, callId)` | **无状态（事实）** |
| Delivery | `deliveryId` | `gated? → submitting → submitted(commandUuid) → started(turnId) → {completed \| interrupted} \| failed(r) \| withdrawn` |
| Turn | `turnId` | `running(commands) → {ended \| aborted}`（来自宿主） |
| InterruptAttempt | `(turnId, triggerSeq)` | `requested → {fenced(covered) \| enqueuing → aborting → done \| failed}` |
| Disposition（派生） | `itemId` | `delivered(turnId) \| pending \| notForwarded(responseId) \| unrecognized \| failed \| withdrawn \| abandoned(exit) \| unknown(r)` |

**事实（输入，全部带单调 `factSeq` 与时钟读数）**：
- 浏览器：`SegmentOpened`、`SegmentClosed{seq, frames, durationMs}`、`UserExit`、`UserWithdraw{deliveryId}`、`UserStop`。
- 上游：`Committed{itemId}`、`CommitError{code}`、`SpeechStarted{itemId}`（manual 模式下即为降级证据）、`ItemCreated{itemId, role, previousItemId?}`、`TranscriptFinal{itemId, text}`、`TranscriptFailed{itemId}`、`ResponseCreated{responseId}`、`ToolCalled{responseId, callId, tool, args}`、`ResponseDone{responseId, status, outputs, usage}`、`UpstreamError{code, param}`、`UpstreamClosed`。
- 执行：`Submitted{deliveryId, commandUuid}`、`SubmitFailed{deliveryId, code}`、`CommandStarted{commandUuid, turnId}`、`TurnEnded{turnId, aborted}`、`CommandCancelled{commandUuid}`。
- 时钟：`TimerFired{name, key}`。

**命令（输出）**：`Upstream.append/commit/responseCreate/responseCancel/updateSession`、`Exec.submit/abort/withdraw`、`Browser.project`、`Timer.set/clear`、`Journal.write`。

### 13.6 不变量（Draft-1 定稿候选，替代 §7）

| # | 不变量 | 违反示例 |
|---|---|---|
| **N-1** | manual 模式下每个出站 `session.update` 显式含 `turn_detection: null`（P-1） | 2026-10-12 |
| **N-2** | 同一时刻至多一个未决控制请求；每个都以 ack、error 或超时事实结束 | 同 tick 发 commit + response.create |
| **N-3** | `attribution` 只有 `exact`（来自 N-2 配对）与 `unknown(reason)` 两种取值；**没有任何代码路径由到达时刻赋值** | `activeSegmentSeq` 归属 |
| **N-4** | 降级证据出现后，受影响对象均为 `unknown`，且已投影、已入 journal | — |
| **N-5** | 每个 Segment / Item / Response / Delivery / InterruptAttempt 在各自上限内到达终态，或随关闭转为终态 | Q26n 永无终态 |
| **N-6** | 每个 Item 恰有一个 Disposition 终态，并已投影 | 静默丢失 |
| **N-7** | INV-B 的 B-1 至 B-5（反缓冲） | 合并窗口在忙时等待；文本去重 |
| **N-8** | 对 CLI 而言 `deliveryId → commandUuid` 至多一个；`submitting` 最终变为 `submitted` 或 `failed` | 失败只发错误帧 |
| **N-9** | 中断：带修正的中断，其修正的 Delivery 先 `submitted` 再 `abort(turnId)`；`covers(turnId) ∋ triggerSeq` ⇒ 被栅栏挡住（fenced）；同一 `(turnId, triggerSeq)` 至多一次 abort；目标永远是绑定会话 | 覆盖判定未接线；run 错位 |
| **N-10** | 投影的队列深度 = 宿主未出队数（每次对账）；回合结束后 Δ 内刷新 | 7 处副本 |
| **N-11** | 每个 Segment 至多一次 `response.create`（另加 ⚖️ post-tool 一次）；有 response 在途时不再发起新的 | 64% token 无投递 |
| **N-12** | 退出时：未终态的条目在宽限内到达终态，或恰好一次回填 composer；回填文本不与之后的迟到投递重复 | 最后一段必丢 |
| **N-13** | 投影顺序：exact 条目按 `seq`；unknown 条目按上游事件顺序并带标注；跨会话隔离 | 到达序、关闭痕迹泄漏 |

### 13.7 接口伪代码

```ts
// ---- pure core -------------------------------------------------------------
type Attribution = { kind: 'exact'; seq: number } | { kind: 'unknown'; reason: UnknownReason };
type UnknownReason = 'vad-active' | 'unpaired-commit' | 'unpaired-response' | 'error-overlap'
                   | 'chain-mismatch' | 'reconnect' | 'commit-timeout';

interface CoreState {
  mode: 'manual-segmented';                 // continuous 不进新核心（⚖️ A-7）
  config: SessionConfig;                    // 单一所有者的期望配置
  control: { pending: ControlRequest | null; queue: ControlRequest[] };
  degraded: { since: number; reason: UnknownReason } | null;
  segments: Map<number, Segment>;  items: Map<string, Item>;
  responses: Map<string, Response>; lastOurResponseCut: number;  // 窗口切分点（factSeq）
  deliveries: Map<string, Delivery>; turns: Map<string, Turn>;
  interrupts: Map<string, InterruptAttempt>;
  exec: { busy: boolean; unstarted: Set<string> };              // 由宿主 lifecycle 事实派生
}
type Command =
  | { to: 'upstream'; op: 'append' | 'commit' | 'responseCreate' | 'responseCancel' | 'updateSession'; payload?: unknown; requestId: string }
  | { to: 'exec'; op: 'submit'; deliveryId: string; text: string }
  | { to: 'exec'; op: 'abort'; turnId: string } | { to: 'exec'; op: 'withdraw'; commandUuid: string }
  | { to: 'browser'; op: 'project'; diff: ProjectionDiff }
  | { to: 'timer'; op: 'set' | 'clear'; name: TimerName; key: string; ms?: number }
  | { to: 'journal'; fact: Fact };

function reduce(s: CoreState, f: Fact): { s: CoreState; out: Command[] };   // 无 IO、无 Date.now、无随机

// ---- shells ----------------------------------------------------------------
interface UpstreamSession {          // 执行 Command(to:'upstream')，把上游帧翻译为 Fact
  send(cmd: UpstreamCommand): void;  // ControlQueue 由 core 决定，本层只负责序列化和 requestId
  onFact(cb: (f: Fact) => void): void;
}
interface ExecutionPort {
  submit(input: { deliveryId: string; text: string }): Promise<
    { ok: true; commandUuid: string; startedTurnId: string | null } | { ok: false; code: string }>;
  abort(turnId: string): Promise<{ aborted: boolean }>;
  withdraw(commandUuid: string): Promise<'cancelled' | 'already-started'>;
  onLifecycle(cb: (e: CommandStarted | TurnEnded | CommandCancelled) => void): () => void;
}
interface BrowserPort { project(diff: ProjectionDiff, eventSeq: number): void; resume(lastEventSeq: number): void; }
interface Clock { now(): number; set(name: TimerName, key: string, ms: number): void; clear(name: TimerName, key: string): void; }

// ---- relay shell（替代 1430 行闭包）-----------------------------------------
function runVoiceSession(ports: { up: UpstreamSession; exec: ExecutionPort; browser: BrowserPort; clock: Clock; journal: (f: Fact) => void }) {
  let state = initialState();
  const apply = (f: Fact) => {
    const { s, out } = reduce(state, f);
    state = s;
    for (const c of out) dispatch(c, ports, apply);   // dispatch 的异步结果再以 Fact 形式回到 apply
  };
  ports.up.onFact(apply); ports.exec.onLifecycle(apply); /* browser frames, timers 同理 */
}
```

`ExecutionPort.submit` 需要的执行面改动：
- host driver 在推入时铸造 uuid，并把它沿 `dispatch` 返回值带回（今天的 `turnMessages` 已在推入时盖 uuid，只需带回，而不是事后读「最新未出队」）；
- 回合 id 取自宿主的 `rounds`；
- 语音路径不调用 `supersedeRunning`。
- ⚖️ 这是 chat-control 与 host driver 的公共路径改动，会影响打字发送；需确认打字路径同步受益（同一个 run 错位缺陷），还是只给语音开新入口。

### 13.8 迁移 M0–M3 与现有任务处置

| 期 | 内容 | 兼容方式 | 退出判据（全部本地运行） |
|---|---|---|---|
| **M0 止血** | (a) N-1：每个 `session.update` 显式携带模式派生的 `turn_detection`；(b) 装配 `hostCommandLifecycle`（栅栏覆盖半边生效）；(c) `openAttempts` 在成功打开后重置；(d) manual 模式收到 `speech_started` ⇒ journal 与浏览器给出降级提示（只观测，不改归属） | 直接替换 | 现有回放 spec 缺陷腿 (a) 转绿；新增 N-1 契约测试；`speech_started` 降级提示有判据 |
| **M1 事实与模型** | journal v2 结构化事实（与旧日志并行）；上游协议模型（P-1..P-16，D/O/U 可配置）；CLI 宿主模型（E9/E10）；虚拟时钟；journal→事实回放；N-1..N-13 预言库；旧实现在模型下**红先行**复现 2026-10-12 | 只增不改行为 | `ef9daacd` 与 `real-run-qwen38` 被模型接受；预言在旧实现上复现 N-1/N-3/N-5/N-6/N-11 的违反 |
| **M2 核心与执行** | `VoiceCore` + `UpstreamControlQueue`（影子运行，随后切换）；`ExecutionPort`（同步 uuid、回合 id、不顶替 run）；Delivery、INV-B、G1 中断与栅栏；深度从 lifecycle 派生 | 开关切换，影子期记录分歧 | L0 性质测试（≥ 1000 个种子）在 N-1..N-11 上全绿；影子分歧仅限已知缺陷类别 |
| **M3 投影** | 服务端权威 `utterance.upsert` 帧与续传；客户端改为渲染器；删除 5 条文本匹配规则；Disposition 诚实显示（含 unknown）；退出语义 N-12；撤回 UI | 新旧帧并存一个版本 | N-6/N-12/N-13 在 L0 与 L2 成立；五句话回放全绿；人工复测 |

**现有任务处置建议**（本轮不改任务；⚖️ 由人决定是否以及何时执行这些调整）：

| 任务 | AC | 当前 | 建议 | 落入 |
|---|---|---|---|---|
| `gap-live-voice-manual-mode-session-update-keeps-vad-off` | 353 | ready | **KEEP**；其判据「任何完整 session.update 都带 `turn_detection: null`」已与 P-1 一致 | M0 |
| `gap-live-voice-replay-local-egress-guard` | 360 | todo | **KEEP**，去掉对 357 的依赖 | M0/M1 |
| `gap-live-voice-scripted-upstream-protocol-state-machine` | 359 | todo | **CHANGE**：改为 M1 上游协议模型（种子驱动，D/O/U 开关），去掉对 358 的依赖 | M1 |
| `gap-live-voice-caption-segment-attribution-by-item-id` | 354 | todo | **CHANGE**：归属改为 ControlQueue 配对，无法配对时为显式 unknown；原「按 commit 的 item_id」规则在 VAD 开启时会错 | M2 |
| `gap-live-voice-interrupt-after-revision-enqueued` | 342 | **ready** | **DEFER**（⚖️ 是否退回 todo，防止在被改造的 run 身份上落地） | M2 |
| `gap-live-voice-queue-depth-refresh-on-turn-boundary` | 344 | **ready** | **DEFER**（⚖️ 同上）；深度改由 lifecycle 派生 | M2 |
| `gap-live-voice-interrupt-honest-aftermath` | 344 | todo | DEFER | M2 |
| `gap-live-voice-segment-honest-heard-unrecognized-state` | 355 | todo | **CHANGE**：Disposition 由核心给出，客户端只渲染 | M3 |
| `gap-live-voice-pending-utterance-withdraw` | 351 | todo | DEFER | M3 |
| `gap-live-voice-segmented-replay-closure` | 356 | todo | **CHANGE**：作为 M3 验收，用模型种子加少量 L2 | M3 |
| `gap-live-voice-intent-control-browser-e2e` | 345 | todo | **CHANGE**：降为 L2 渲染验收 | M3 |
| `gap-live-voice-replay-known-defect-signatures` / `…event-synced-waits` | 357 / 358 | todo | **DEFER / 可放弃**：模型测试取代逐缺陷回放加固 | — |
| `gap-live-voice-interrupt-semantic-sampling` | 346 | todo | DEFER 到 M2 之后（付费单次） | M2+ |
| GOAL-041 已 done（338/339/340/341/343/350） | — | done | **KEEP**：事实与审计字段保留，实现将被核心取代 | — |

**当前风险**：AC-342 与 depth-refresh 两个 **ready** 任务随时可能被派发（本轮按要求不停 worker、不改任务）。若被派发，它们会在 M2 要替换的 run 身份与 7 处深度副本上再加一层；建议在裁定时一并决定是否退回 todo。

### 13.9 完全本地运行的模型测试

| 层 | 组成 | 运行方式 | 外联 |
|---|---|---|---|
| **L0 核心性质测试** | 生成器：浏览器动作（说话、静默、退出、撤回、停止）× 上游协议模型 × CLI 宿主模型 × 时钟推进，按种子交错；每步跑 `reduce`，检查 N-1..N-13；失败自动收缩为最短事实序列 | `npx tsx --test`，单文件；⚖️ 引入 `fast-check`（devDependency）或自研种子调度器 | 无 |
| **L1 外壳契约** | `UpstreamSession` 对协议模型（真实帧编解码，进程内 WS 假）；`ExecutionPort` 对 debug-agent 宿主（补齐 E10：回合边界聚合 N 条、中断保留队列、stale-first ≥ 50 ms、非最新撤回） | 单文件 node:test | 无 |
| **L1′ 回放一致性** | `ef9daacd`、`99df08d8`、`real-run-qwen38` 的事实序列必须被协议模型**接受**，且其中的观测事件被正确分类（D/O/U） | 单文件 | 无 |
| **L2 渲染** | 少量固定种子，经 e2e 本地 WS 假上游（`e2e/voiceRealtimeScriptedUpstream.ts`）驱动真实页面，只验证投影帧被正确渲染、排序与标注 | 单 spec，`DASHSCOPE_API_KEY` 置空，加 AC-360 外联守卫 | 仅 127.0.0.1 |
| L3 抽样 | 付费真实运行（AC-346） | 不进 CI | 付费 |

**协议模型的可配置项**（一个开关对应一条协议事实，测试按 D/O/U 覆盖全部取值）：
- `sessionUpdateOmitsTurnDetection → vad: 'default-on'`（P-1，D）
- `updateSemantics: 'replace' | 'merge'`（P-2，U：两种都跑）
- `minCommitMs: 0..500`（P-4，U：扫描）
- `previousItemIdOnCreated: on | off`（P-10，O）
- `transcriptOrder: 'in-order' | 'shuffled' | 'drop(k)'`（P-8）
- `vadBargeInSuppressesResponse`（P-15，O）
- `errorCorrelation: none`（P-6，D）

### 13.10 ⚖️ 需人裁定（Draft-1）

| # | 事项 | 推荐 |
|---|---|---|
| **H-1** | 事实日志 + 纯函数 reducer，内存有界；journal 只写；不做持久 ES；升级触发条件按 13.1 | 采纳 |
| **H-2** | 用 `UpstreamControlQueue` 串行化换取精确归属（每段多约一个回执 RTT，实测 115–150 ms）；做不到即 `unknown`，永不按时序推断 | 采纳 |
| **H-3** | 降级后：自动重发完整配置并在下一个 commit 起恢复 exact，还是只提示 | 自动重建 + 提示 |
| **H-4** | unknown 条目的界面形态：按上游顺序显示并标注「无法对应到哪一段话」 | 采纳 |
| **H-5** | Intent 不是实体；以 INV-B（B-1..B-5）钉死反缓冲；删除文本去重 | 采纳 |
| **H-6** | 转写闸（≤ 600 ms）保留为 B-1 唯一例外 | 保留 |
| **H-7** | 空闲防抖 D（建议 1500 ms），忙时 0 | 采纳，数值待定 |
| **H-8** | 状态通道：P-12 / P-13 使「随 response 下发」和「条目注入」都不可行；剩下的选项是全量 `session.update`（需 N-1 保证、有成本）或只靠工具回执 + `session_status` 拉取。这会改动 SPEC D-1（人裁定的持续注入） | 建议 manual 模式下停止周期注入，改为工具回执 + 拉取；需重新裁定 D-1 |
| **H-9** | post-tool response（今天每次投递后自动一次）：manual 模式下实测能否省略 | 先在 M1 模型里做成开关，再实测一次 |
| **H-10** | `ExecutionPort` 改造是否同时作用于打字路径（同一个 run 错位缺陷） | 同时修 |
| **H-11** | continuous 模式不进入新核心（M3 后弃用） | 采纳 |
| **H-12** | AC-342 / depth-refresh 两个 ready 任务是否退回 todo；按 13.8 是否调整其他任务 | 退回；其余按表在 M1 立项时一并调整 |
| **H-13** | `fast-check` devDependency | 采纳 |

### 13.11 参考
- 官方服务端事件：<https://help.aliyun.com/zh/model-studio/server-events>
- 官方客户端事件：<https://help.aliyun.com/zh/model-studio/client-events>
- 英文版（Qwen-Audio Realtime）：<https://help.aliyun.com/en/model-studio/qwen-audio-realtime-server-events>
- 本仓真实录制：`server/modules/voice-realtime/tests/fixtures/real-run-qwen38-four-utterances.json`；五句话 journal `~/.cloudcli/voice-realtime-log/ef9daacd-….jsonl`；E9/E10 记录 `docs/proposals/claude-resident-sessions-experiments.md`

---

## 14. 重连语义（2026-10-13，journal `e22ac831` 双断线）

**证据**：
- 13 段中 9 段丢失或被错标。
- seq2（14.6 s 单帧）两次断线后不再重放；`pendingCommitSeqs` 断线不清空，导致其后段的 `committed` 错配两位。
- `openAttempts` 不复位，第三次断线（seq6，12 s 单帧）后连接永久关闭；关闭后 seq7–12 仍收到 `segment_ack committed`。
- 三次断线均紧随 ≥12 s 单帧 append。这是**未验证假设 RC-5**，由 AC-369 判定，任何修复不得以它为前提。

**不变量（补入 §13.6）**：

| # | 不变量 |
|---|---|
| **R-1 ACK 分级** | written（写到上游 socket）≠ committed（上游 `input_audio_buffer.committed`）≠ recognized（转写完成）≠ delivered（`session_send` 进入 CLI 队列）。只有 delivered 叫投递；浏览器帧与 UI 文案不得把前三者说成已发送 |
| **R-2 epoch 作用域** | `committed` 只与同一 socket epoch 内未决的 commit 配对；断线时该 epoch 的未决 commit 全部转为 `uncertain` 并移出配对 |
| **R-3 按段至多一次投递** | 同一 `seq` 跨 epoch 至多一次 delivered；已投递段的重放调用丢弃；不自动补发 |
| **R-4 有界重试** | 每段重放有显式预算；预算耗尽或连接终止 ⇒ `lost(reason)`，绝不记为 `empty` |
| **R-5 连接寿命** | 成功打开并稳定后复位重连计数；连续失败仍有上限 |
| **R-6 关闭后诚实** | 连接不在 open 时结束的段只得 `lost(connection-closed)`，状态栏必须显示断开 |

**无法保证 exactly-once 的情形**（只承诺 R-3 + 有界重试）：
- 写出 commit 后、收到 `committed` 前断线：上游可能已处理但事件丢失；新 socket 是新会话，重放会让模型重新决定。
- 旧 socket 上已投递后再重放：靠 R-3 丢弃第二次调用。
- 重放本身触发断线：只能以 R-4 收口。

**任务（GOAL-043）**：

| 任务 | AC | 阶段 | 内容 | 依赖 |
|---|---|---|---|---|
| `gap-live-voice-double-drop-fault-injection-red-first` | 365 | 1 | 故障注入 F1–F6 + node:test 已知缺陷签名，D1–D6 红先行（只改测试） | — |
| `gap-live-voice-reconnect-epoch-scoped-commit-pairing` | 366 | 2 | R-1/R-2/R-4/R-5/R-6 修复，翻转 D 腿 | 365、STS 实现任务 |
| `gap-live-voice-segment-lost-uncertain-honest-state` | 367 | 2b | 浏览器 uncertain/lost 诚实状态 | 366、AC-355 任务 |
| `gap-live-voice-double-drop-browser-e2e` | 368 | 3 | Playwright 双断线与永久断开 | 367 |
| `gap-live-voice-large-append-vs-chunked-probe` | 369 | 3 | 真实上游大帧 vs 分块，验证或否证 RC-5 | 365 |

**待裁定**：
- 重放预算 K（建议每段 2 次）；
- 连接终止后由浏览器自动重开整条上游连接，还是只提示并由用户点"重试"；
- lost 段退出时是否回填 composer（建议不回填，因为那不是模型不转发）。
