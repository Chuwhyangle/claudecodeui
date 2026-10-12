# Live Voice 体验优先：架构补充决策与最小验收（Decision-E）

| 项 | 值 |
|---|---|
| 状态 | **Decision-E0（2026-10-12）**：落实人 yale 当日的优先级调整；**§9 的 ⚖️ 项仍待人裁定**。本文是 `live-voice-architecture-review-2026-10.md`（Draft-0/Draft-1）的**补充与排序修订**，不推翻其方向 |
| 基线 | `develop` @ `aab42631`（GOAL-041 AC-342/343/344-refresh/346/353/357/358/360 已落地；`gap-live-voice-interrupt-honest-aftermath` 在飞） |
| 人裁定（原话要旨） | ① 首先实现**可用、低延迟、连续**的交互体验；② **模型负责何时语义输出 / 调用工具**；③ VAD 只为降低无意义传输与响应成本服务，**不承担业务断句**；④ 成本优化是第二阶段；⑤ 允许先用连续基线以优先体验；⑥ 不做未经验证的生产切换 |
| 证据 | 会话 `c620ef9b`（服务端 VAD 对 qwen3.8 调用的影响）、journal `ef9daacd` / `99df08d8`、`real-run-qwen38-four-utterances.json`、`voice-realtime-segmented-relay-SPEC.md` F1–F12 / P0-S4、`docs/operations/voice-realtime-interrupt-sampling.md`（AC-346 真实抽样）、官方 [client-events](https://help.aliyun.com/zh/model-studio/client-events) / [server-events](https://help.aliyun.com/zh/model-studio/server-events) |

---

## 1. 两条路径的现状与语义能力（VAD ≠ 模型决策）

| 维度 | **continuous**（上游原生 `server_vad`） | **segmented**（浏览器 VAD + 手动 commit，**当前默认**） |
|---|---|---|
| 选择方式 | `VOICE_REALTIME_MODE=continuous`，或握手未得到 `ready` 时的回退 | 服务端默认回应 `hello`（`voice-realtime-mode.ts`） |
| 上传内容 | 整条麦克风流（含静音） | 只有语音段（relay 档：≤1.5 s 停顿合并，≥2.0 s 提交，>20 s 强切） |
| 谁判定「说完」 | 上游声学 VAD：`threshold 0.5`、`silence_duration_ms 400`（本仓设置；文档默认 800） | 浏览器 `StreamingVad` + `LiveSegmenter` |
| 谁创建 response | 上游「通常根据语音活动自动开始响应」（文档） | 我方每段 `commit` 后发 `response.create` |
| 说完 → 模型被问到 | ≈ silence_duration（0.4 s）+ 模型首包 | ≈ 2.0 s（commit gap）+ 回执 + 模型首包 |
| 碎片化 | 高：3 段语料 → 13 条转发（F9） | 低：停顿合并，但边界由我方声学规则决定 |
| 归属 | 字幕↔条目精确（`item_id`，P-7）；工具调用↔条目只能按上游事件顺序 | 构造上精确的前提是 VAD 真关（AC-353 已落地）与单一未决请求（Draft-1 H-2，未实现） |
| 已知缺陷 | 文本归一化去重；固定 2.5 s 合并窗口；`unforwardedUserUtterances` 双计；投影按文本归属 | 2026-10-12 五句话全部症状（VAD 重开已由 AC-353 修复）；GOAL-043 其余项未修 |
| 成本主因 | **response 次数 ×（指令 + 工具 + 历史）文本上下文**（F1：8 次 response 读入 6,360 token，其中音频仅 546） | 同左；response 次数较少 |

**两条路径共同的语义事实**：
- 「何时结束一句」都是**声学**判定：上游 VAD 或我方浏览器 VAD。没有一条路径让模型决定说话边界。
- 模型只在**每一次 response 机会**上做语义决定：`session_send` / `session_interrupt` / `session_status` / 不调工具（AC-346：语义中断召回 83.3%、精确 100%）。
- 今天的 prompt 要求「EVERYTHING … must be passed on」，所以模型实际上**没有**被允许选择「这句还没说完，先不转发」。
- `semantic_vad`：官方文档写「基于语义有效性检测语音结束」，并列为 Qwen3.8-Omni-Flash-Realtime 支持；但本仓 P0-S4（2026-10-10）只证明控制面**回显**（与乱写的类型同样回显），**没有行为证据**。状态为 **U（待校准）**。

⇒ **术语约定（本文起生效）**
- **response 机会**（opportunity）：一次 response 被创建，由 VAD 或我方触发。
- **投递边界**（delivery boundary）：模型调用 `session_send` 的那一刻。
- VAD 只决定前者的**节奏与成本**，**永远不是**业务断句；业务断句只有模型的投递边界。

---

## 2. 原则（E-1..E-6）

| # | 原则 |
|---|---|
| **E-1** | 投递边界只由模型决定。系统不得以声学停顿替模型断句，也不得以文本规则改写、拆分、合并模型的输出（Draft-1 INV-B 的 B-3 继续有效） |
| **E-2** | 模型可以选择**不输出**：不转发、不中断、稍后再转发。系统如实显示「未转发」，**不自动补发**（沿用人裁定） |
| **E-3** | VAD 的职责只有两项：(a) 减少无意义音频上传；(b) 以有界节奏提供 response 机会。它的参数按**体验**调优（延迟与碎片），成本是第二目标 |
| **E-4** | 执行面忙时，系统不持有语音指令（立即入 CLI 队列，由 CLI 在回合边界聚合，E10/U3）；空闲时只允许一个短的起轮防抖（Draft-1 B-2） |
| **E-5** | 每条指令可追溯：话语（`item_id`）→ response → 工具调用 → 投递 → CLI 命令 → 回合；任何一环无法确定都**显式**标记，不推测 |
| **E-6** | 状态可感知：用户在任何时刻都能看到「在听 / 听到了 / 模型在想 / 已转发·排队 / 执行中 / 未转发 / 未识别 / 断线」之一，且状态来自事实而不是前端计时器 |

---

## 3. 体验优先的最小验收（X-1..X-7）

全部可在本地确定性环境（§6）中测量；数值是**首版上线线**，可由人调整（⚖️ H-E3）。

| # | 验收 | 判定（本地 E2E 读数） |
|---|---|---|
| **X-1 连续交互正确** | 连续说 N≥5 句（句间 0.3–3 s 停顿、执行面忙闲交替），每句恰有一个可见处置（已转发 / 未转发 / 未识别），顺序与说话顺序一致，**静默丢失 = 0** | 逐句处置表；丢失计数 |
| **X-2 模型可不输出** | 语料含无意义片段（「嗯」「那个…」）与自言自语；模型不转发时界面显示「未转发」，之后不会被补发 | 处置表；投递集合 ∩ 未转发集合 = ∅ |
| **X-3 指令可追溯** | 每条投递在 journal 中可链到其 response 与条目集合（或显式 unknown），并链到 CLI `commandUuid` 与回合 | 追溯链完整率 = 100%（unknown 计入完整） |
| **X-4 暂停续说修正** | 一个想法中间停顿 1–2 s 再说完，或说完立刻修正：执行面空闲时 Claude 收到**一条**完整消息（防抖或模型自行等待）；执行面忙时两者落入同一个下一轮 | Claude 侧收到的消息条数与内容 |
| **X-5 打断** | 执行中说「停 / 改成…」：模型发起中断（语义，非关键词），修正先入队后 abort（G1，已落地），UI 停止键始终确定性有效 | 中断事件与回合时间线 |
| **X-6 状态可感知** | 任何时刻状态行非空且新鲜（≤ 2 s 无更新须显示降级）；未识别 / 未转发 / 断线有可见标注 | 帧时间线采样 |
| **X-7 交互延迟** | 说完 → 字幕定型 ≤ 1.0 s p50；说完 → 模型工具调用 ≤ 1.5 s p50 / ≤ 2.5 s p95；空闲时说完 → Claude 收到 ≤ 2.5 s p50；忙时说完 → 「已排队」可见 ≤ 1.5 s p50 | 本地读数（模型首包用固定假延迟）+ 校准运行里的真实首包分布 |

---

## 4. 最小可上线体验路线

**R-1 连续基线优先**（推荐，⚖️ H-E1）：以 continuous（上游 `server_vad`）作为体验基线，因为它的说完→response 机会最短、不依赖我方 commit 时序，也不存在「VAD 被重开」这一类故障面。需要做到的最小改动（实现任务在验证读数之后才立，见 §8）：

1. **把断句还给模型**：prompt 从「EVERYTHING must be passed on」改为「判断用户是否说完一个完整意思，说完再转发；没说完可以不调用工具，等下一次机会」，同时保留「从不文本作答」。是否可行由校准 C-5 决定（P0-S4 的 prompt 等待 held=0/2 只有 2 个样本，不足以下结论）。
2. **VAD 参数按体验调**：`silence_duration_ms` 从 400 调到实测最优（候选 600 / 800 / 1000），在延迟（X-7）与碎片（X-4）之间取舍，由本地 E2E + 校准 C-2 定值。
3. **合并窗口**：忙时立即入队，空闲时起轮防抖 D（候选 1.0–1.5 s），替代固定 2.5 s（Draft-1 B-1/B-2）。
4. **去重**：删除连续模式的文本归一化去重，改为按 `(responseId, callId)` 精确去重（E-1）。
5. **可追溯与诚实状态**：字幕按 `item_id`；投递↔条目按上游事件顺序归入 response 窗口（⚖️ H-E2）；处置终态投影（复用 GOAL-043 AC-355 的语义，但面向连续路径）。

**切换**：默认模式切换是改环境变量 `VOICE_REALTIME_MODE`，回退同样是改它。**只在** X-1..X-7 本地全绿 + 校准 C-1..C-6 有读数 + 人确认之后切换，不做未经验证的生产切换（⚖️ H-E4）。

**R-2 segmented 保留为第二阶段的成本模式候选**：GOAL-043 剩余的分段专属任务（AC-354/355/356/359 中的分段部分）降为第二阶段，不再是体验路径的前置。

**R-3 混合「静音尾门控」作为成本阶段候选**：浏览器 VAD 只门控长静音，但在每段语音之后发出**有界的真实静音尾**（≥ `silence_duration_ms` + 余量），让上游 `server_vad` 照常断句。本仓已有该机制的雏形（`VOICE_REALTIME_SEGMENT_COMMIT=server-vad`，`voice-realtime-bridge.service.ts:243-334, 622-662`）。它在不改变语义（上游声学断句 + 模型决定投递）的前提下减少上传。

---

## 5. 为什么不能「简单丢静音、仍依赖 server_vad」，以及四个必须分开的概念

**上游 VAD 判定说完的唯一依据，是它收到的音频流里出现 ≥ `silence_duration_ms` 的静音**（文档：「基于声学特征检测语音结束」）。丢掉静音帧之后：

1. 各句语音首尾相接，上游看不到停顿，不会发 `speech_stopped`，也不会自动 commit。response 机会消失或被推迟到不可预测的时刻（X-7 失守），多句话糊进一个条目（X-1、X-3 失守）。
2. `idle_timeout_ms`（静默后主动响应）只对 qwen3.5 系列的 `server_vad` 生效（文档），qwen3.8 上没有兜底。
3. 若同时改成手动 commit 来补救，就是 segmented 路径，断句又回到我方声学规则；文档写明 server_vad 下客户端 commit 无需发送，混用只会产生空 commit 错误（P-3）。
4. 正确的「少传静音」做法只有两种：**静音尾门控**（R-3：保留足够让上游断句的真实静音）或**手动模式**（segmented）。两者都必须端到端验证。

**必须分开的四个概念**（成本讨论只用这套词）：

| 概念 | 是什么 | 是否计费 | 证据 |
|---|---|---|---|
| ① 静音音频上传 | `input_audio_buffer.append` 中的无语音帧 | **未证实**：F4 由 205 s 输入只记 546 音频 token **推断**不计；文档只说「累计媒体时长不是会话总时长」 | F3/F4；须校准 C-4 |
| ② VAD 事件 | `speech_started/stopped`、自动 commit | 事件本身不是计费单位 | 账单按连接汇总 token（F6） |
| ③ response 创建 | 一次模型推理（含 post-tool 收尾、孤儿 OK） | **计费单位**：每次重读整个上下文 | F1；2026-10-12 五句话 64% token 无投递 |
| ④ 文本上下文 token | 每次 response 读入的指令 + 工具 + 历史（含转写文本、工具输出、模型文字） | 主成本，随 response 次数与历史线性增长 | F1、F2；F11 平台裁剪历史 |

**不假定静音必然收费**：静音上传是否影响账单，要用校准 C-4 实测，然后进入第二阶段的成本目标。

---

## 6. 本地确定性 E2E 与少量真实校准

**本地栈（零外联）**：

| 部件 | 来源 | 需要补的 |
|---|---|---|
| fake mic | `src/modules/chat/voice-realtime/audioSource.ts` 的 `pacedFileAudioSource`（可注入时钟）与 e2e 的 `window.__voiceFake.speak` | 「语音 / 静音时间线」脚本（句长、停顿、背景噪声），确定性 PCM |
| fake upstream | `e2e/voiceRealtimeScriptedUpstream.ts`（本地 `ws`）+ AC-359 的协议状态机（todo） | **按收到的 PCM 做声学 VAD 仿真**（能量阈值 + `silence_duration_ms`，与文档语义一致）；server_vad 下自动 commit + 自动 response；可配置的**模型策略**（逐条目：转发 / 不转发 / 等待 / 中断 / 文本作答）；D/O/U 开关（如 `semantic_vad` 行为、静音计费） |
| 执行面 | debug-agent provider（`server/modules/debug-agent/`）或现有 e2e 夹具会话 | E10 语义：回合边界聚合 N 条、中断保留队列（AC-359 / Draft-1 已列） |
| 外联守卫 | AC-360（已落地：回放禁止非 loopback 外联） | 复用到新 spec |

**归因规则（区分协议限制与我方错误）**：
- 在 fake 上游按**文档语义（D）**配置时就能复现的失败，归**我方错误**，必须修。
- 只在真实上游出现、fake 按文档无法复现的现象，归**协议或模型行为**，记入校准事实表并在 fake 中加 O 开关复现。
- 两者都不能复现的，记为 U，不下结论。

**真实校准（每项单次付费运行、带 `VOICE_REALTIME_MAX_CNY_PER_CONNECTION` 上限、备用端口实例、dry-run 执行面，不重启 :3001）**：

| # | 校准问题 | 读数 |
|---|---|---|
| C-1 | qwen3.8 上 `semantic_vad` 是否有**行为**差异（不是回显）：同一段含「嗯…那个…」与句中停顿的音频，比较 `server_vad` 与 `semantic_vad` 的条目数与 response 数 | 条目 / response 计数对照 |
| C-2 | `silence_duration_ms` 400 / 800 / 1000 下同一语料的碎片数、说完→response 延迟 | 分布 |
| C-3 | 丢静音致盲：只发语音帧时上游是否还会 `speech_stopped`（验证 §5 的推论） | 是 / 否 + 时间线 |
| C-4 | 静音是否计费：60 s 纯静音（mic 开着）与 60 s 含 5 s 语音，比较 usage 的 audio token 与账单 | token / ¥ |
| C-5 | 允许「没说完可以不转发」的 prompt 下，模型是否真的等待并在后续机会合并转发（≥ 10 样本） | 等待率、误等待率 |
| C-6 | 静音尾门控（R-3）的最小静音尾，使上游仍稳定断句 | 最小 ms |

---

## 7. 成本阶段（M-C，次级）：指标与实测计划

**指标定义**（全部取自 journal `usage` 行与账单对账，不估算）：
- response 数 / 小时；有效投递数 / 小时；**有效投递率** = 产生投递的 response / 全部 response。
- 每 response 输入 token（text / audio 分开）与输出 token；post-tool 与孤儿 response 占比。
- **¥ / 小时**：分「持续说话的一小时」与「挂机静默的一小时」两种场景。
- 每条有效投递的 ¥。

**实测计划**：在体验路线定型（R-1 切换后）跑三种固定剧本：5 句话、10 分钟口述、30 分钟挂机。对比 continuous / R-3 静音尾门控 / segmented 三种模式，各一次付费运行，带上限。**先拿基线，再定目标**；目标数值不在本阶段预设。候选手段（只列不做）：降低 post-tool 收尾 response（Draft-1 H-9）、停止周期状态注入（Draft-1 H-8）、R-3 门控、segmented 模式。

---

## 8. 与 Draft-1、GOAL-041/043 及 Quay 任务的关系

**Draft-1 方向不变，排序调整**：账本 + 纯函数核心 + 服务端权威投影、INV-B 反缓冲、显式 unknown 归属仍是目标架构。但第一批落地以**连续基线体验**为准；控制请求串行化（H-2）属于 segmented 精确归属，降到第二阶段。

**现有任务处置（本轮只新增，不改既有任务状态）**：

| 任务 | 状态 | 处置 |
|---|---|---|
| `gap-live-voice-interrupt-honest-aftermath`（AC-344） | 在飞 | 不抢占；与体验路线兼容（X-5） |
| `gap-live-voice-pending-utterance-withdraw`（AC-351） | ready | 不动；与体验路线兼容 |
| `gap-live-voice-scripted-upstream-protocol-state-machine`（AC-359） | todo | **作为新 E2E 任务的前置**（新任务在其上补声学 VAD 仿真与模型策略，不重复造） |
| `gap-live-voice-intent-control-browser-e2e`（AC-345） | todo | 保留；其打断场景将被新 E2E 的 X-5 覆盖，裁定后再决定合并 |
| `gap-live-voice-caption-segment-attribution-by-item-id`（AC-354）、`…honest-heard-unrecognized-state`（AC-355）、`…segmented-replay-closure`（AC-356） | todo | **降为第二阶段**（分段专属）；⚖️ H-E5 是否退回或改挂新 GOAL |
| GOAL-034（分段中继，AC-319 active） | active | 与 R-2 一并降为成本阶段候选；⚖️ H-E5 |

**本轮新增**（GOAL-044 体验优先）：

| AC | 任务 | 内容 | 派发条件 |
|---|---|---|---|
| AC-361 | `gap-live-voice-continuous-experience-e2e-harness` | 本地确定性 E2E：fake mic 时间线 + fake upstream 声学 VAD 仿真与模型策略 + 执行面夹具；对**当前 continuous 代码**测出 X-1..X-7 的基线读数（当前不达标的项以已知缺陷签名记录，不改产品代码） | 依赖 AC-359 |
| AC-362 | `gap-live-voice-continuous-calibration-run` | 真实校准 C-1..C-6 单次运行，产出事实表与成本基线 | 无依赖；单次付费，有上限 |

体验修复（§4 R-1 的 1–5 项）与默认模式切换**不在本轮立项**：要等 AC-361 的基线与 AC-362 的读数出来、人裁定 §9 之后再立，避免在未验证的参数上实现。

---

## 9. ⚖️ 需人裁定

| # | 事项 | 推荐 |
|---|---|---|
| **H-E1** | 体验基线采用 continuous（上游 `server_vad`），segmented 降为第二阶段的成本模式候选 | 采纳 |
| **H-E2** | 连续模式下「投递↔条目」按**上游事件顺序**（WebSocket 保序）归入 response 窗口，作为显式的第三类归属 `upstream-ordered`（区别于 exact / unknown）；顺序不明确的交错仍标 unknown | 采纳 |
| **H-E3** | X-1..X-7 的首版数值 | 按 §3 先行，基线读数出来后再定 |
| **H-E4** | 默认模式切换的门槛：X 全绿（本地）+ C 有读数 + 人确认；回退方式为改 `VOICE_REALTIME_MODE` | 采纳 |
| **H-E5** | GOAL-043 分段专属任务（AC-354/355/356）与 GOAL-034 是否退回 todo / 改挂成本阶段 GOAL | 退回并改挂（另行执行） |
| **H-E6** | prompt 是否从「一切都转发」改为「说完一个意思再转发、可以不转发」 | 取决于 C-5；先立校准 |
| **H-E7** | Draft-1 的 H-2（控制请求串行化）与 H-8（停止周期注入）延后到成本阶段 | 采纳 |
