# 低成本 Turn Detection 对照 SPEC —— 可插拔音频原生轮次检测器评估（Pipecat Smart Turn / LiveKit Turn Detector / Qwen Realtime）

状态：**P0 已执行（2026-10-11）**——实测数字在 `experiments/voice-turn-detection-compare/RESULT.json`，
入口 `node scripts/voice-turn-detection-compare.mjs`。标注样本只有 8 条，**结论为初步/方向性，不作为最终 go/no-go**。
决策输入：人 yale 2026-10-11
关系：

- 建立在 `voice-realtime-segmented-relay-SPEC.md`（GOAL-034，已落地分段中继 + 上下文包 + 会话池）之上；不改写它的决策，只回答**换一个更便宜的轮次检测器能否逼近 Qwen Realtime 的断句能力**这一个新问题。
- 与已 ready 的 `gap-voice-realtime-turn-detection-configurable-comparison`（只调 Qwen Realtime 自身 `silence_duration_ms` / `semantic_vad`）互补、不重叠：那条任务的三档读数本 SPEC 直接引用为「组 D」的证据，不重新花钱。

---

## 已确认的决策

| # | 决策 | 含义 |
|---|---|---|
| D1 | **音频原生检测器 ≠ 语义意图完整，也 ≠ Action Commit** | `utterance_end`（这句话说完了）与 `action_commit`（这句话可以安全地触发推理/操作）是两个不同的判定；中间留一个「纠正宽限窗」。 |
| D2 | **不退化为 ASR→文本推理** | 主路径的输入必须是音频；把转写文本当唯一依据的方案最多作为补充 baseline（组 E），不能替代音频原生评估。 |
| D3 | **不预先相信未核实的性能数字** | 本 SPEC 中任何许可证 / 延迟 / 语言覆盖 / 架构描述，凡是本任务自己在线核对过的都标「已核实（来源）」；没把握的标「未核实，需在 P0 内读源码确认」。 |
| D4 | **真实付费调用先设上限、先汇报** | 非实时 `qwen3.8-omni-flash` 的音频原生函调可行性探针是本 SPEC 唯一需要真实上游花费的部分；预算与口径见「P0 分期」。 |
| D5 | **不大改现有紧凑 Live Voice UI** | 任何状态机改动必须能在现有 `VoiceRealtimeBar` / `useVoiceRealtimeSession.ts` 的显示模型里落地；P0 只做设计与离线测量，不接入运行时。 |

## 目标

1. 用同一套标注语料和同一套读数口径（误截断率、漏端点率、端点判定延迟 p50/p90、CPU/RAM、误触发 Action 数、额外模型成本），**对照**四组方案 + 一个可选 baseline，判断哪一组最逼近 Qwen Realtime 的断句能力而成本更低。
2. 单独验证非实时 `qwen3.8-omni-flash`（非 `-realtime`）分段音频输入 + function calling 的可行性：请求格式、输出格式、是否支持工具声明、延迟——与 Realtime 路径在**同一段音频、同一上下文**下并列对照。
3. 产出一个可配置状态机设计：持续采集 → VAD 候选静音点 → Turn Detector 判 `END`/`CONTINUE` → 短暂 `commit grace window` 容许自我纠正 → 只有最终仍有效的推理结果发 `session_send`；分析投机推理的启动/取消/竞态与重连。
4. 不编造样本、不编造数字：样本不足时明确报告局限，真实只用已核实或已实测的事实。

## 非目标

- 不在本 SPEC 内切换生产默认链路（仍是 Qwen Realtime 分段中继，GOAL-034 已 shipped）。
- 不做 TTS、不做 UI 大改。
- 不在 P0 内把任何新检测器接入运行时；P0 只产出 harness + 报告 + 状态机**设计**。
- 不重复花 `gap-voice-realtime-turn-detection-configurable-comparison` 已花的钱；该任务的 `RESULT.json` 作为组 D 的既有证据引用。

---

## 四组 + 一个可选 baseline

| 组 | 方案 | 输入 | 判定方式 | 成本 |
|---|---|---|---|---|
| A | VAD 固定静音阈值 | 音频能量 | `src/shared/voiceEndpoint.ts` 的 `StreamingVad`（15th percentile 滑动噪声基线 + `ENTER_FACTOR`/`hangoverMs`），现有实现 | 纯本地，几乎零成本 |
| B | VAD + Pipecat Smart Turn v3.2 | 16 kHz 单声道音频，最近 ≤8 秒窗口（ rolling window） | 本地 ONNX int8 CPU 推理，sigmoid 概率 | 本地 CPU，无调用费 |
| C | VAD + LiveKit Turn Detector v1-mini | 音频（**非**转写文本——v1 系列已从 v0.x 的 STT-文本架构换成音频原生，语言由 STT 上报用于选阈值） | 本地 CPU 推理（v1 的轻量化 CPU 变体） | 本地 CPU，权重受 LiveKit Model License（非 OSI 开源，细则待核实），无调用费 |
| D | Qwen Realtime 既有 `server_vad` / `semantic_vad` | 音频（上游托管） | 上游 VAD / 语义 VAD | 按 token 计费（已有账单口径） |
| E（可选补充 baseline） | VAD + ASR 转写 + 轻量文本语义端点 | 音频 → ASR 文本 | 文本规则/小模型判断「话是否说完」 | ASR 成本 + 轻量文本推理，**不是**音频原生，仅作参照，不得与 A–D 混为一谈 |

**不做的事**：把 E 的结果当作 D1「音频原生」的替代；D1 决策要求 A–D 四组都保持音频输入。

---

## 已核实事实（2026-10-11 在线核对，来源见每行）

| # | 事实 | 核实状态 | 来源 |
|---|---|---|---|
| G1 | Pipecat Smart Turn v3.2 权重、代码、训练脚本、训练数据均为 **BSD-2-Clause**，完全开源 | 已核实 | [pipecat-ai/smart-turn GitHub](https://github.com/pipecat-ai/smart-turn)、[smart-turn-v3 HF](https://huggingface.co/pipecat-ai/smart-turn-v3) |
| G2 | Smart Turn v3.2 架构：Whisper-Tiny 编码器 + attention pooling + MLP + sigmoid，约 8M 参数，支持 23 种语言 | 已核实（第三方指南 soniqo.audio 复述 Pipecat 文档，权威性弱于一手文档，但与 HF model card 一致） | [Smart Turn Overview - Pipecat](https://docs.pipecat.ai/api-reference/server/utilities/turn-detection/smart-turn-overview)、[soniqo.audio](https://soniqo.audio/guides/turn) |
| G3 | Smart Turn v3.2 的 CPU 推理用 ONNX int8（≈8 MB）或 fp32（≈32 MB），`local_smart_turn_v3.py` 源码里 `_MODEL_SAMPLE_RATE = 16000`，依赖 `onnxruntime` + `soxr` + `numpy`；默认滚动窗口 **8 秒**，超过则用 rolling window | 已核实（源码阅读） | [local_smart_turn_v3 源码](https://reference-server.pipecat.ai/en/stable/_modules/pipecat/audio/turn/smart_turn/local_smart_turn_v3.html) |
| G4 | 第三方测得 ONNX int8 CPU 延迟 ≈ 20–36 ms（2–4 线程，8 秒窗口）；Pipecat 文档称可在低成本云实例上 100 ms 内完成 | **P0 已自测（一手）**：ONNX 推理本身 p50 **36.15 ms** / p90 **39.23 ms**（本机，`intraOpNumThreads=1`）——与第三方数字同量级，**第三方数字不作为最终判据**。端到端（含本 harness 的 JS log-mel 前端）p50 159.8 / p90 167.4 ms，前端才是大头 | [soniqo.audio](https://soniqo.audio/guides/turn)、Pipecat 文档、本任务 `experiments/voice-turn-detection-compare/RESULT.json` |
| G5 | LiveKit Turn Detector v1（含 v1-mini）是**音频原生**模型（直接对语音推理），取代了 v0.x 的「读 STT 转写文本」架构；v0.x 文本检测器已废弃，计划在 Agents SDK 2.0 移除 | 已核实 | [LiveKit 博客：solving end-of-turn detection](https://livekit.com/blog/solving-end-of-turn-detection)、[LiveKit turn detector 文档](https://docs.livekit.io/agents/logic/turns/turn-detector/) |
| G6 | v1 全量模型覆盖 English + 13 种语言（含 **Chinese**），语言由 STT 上报用于选每语言阈值；v1-mini 是同架构的量化/剪枝 CPU 友好版，本 SPEC 未找到 v1-mini 自身独立的语言覆盖声明（沿用 v1 的 14 语言，但未逐一验证 mini 版精度是否同等） | 已核实 14 语言列表与「音频原生」定性；**未核实** v1-mini 对中英混杂、代码术语场景的精度 | [LiveKit turn detector 文档](https://docs.livekit.io/agents/logic/turns/turn-detector.md)、[LiveKit blog](https://livekit.com/blog/solving-end-of-turn-detection) |
| G7 | v1 系列权重受 **LiveKit Model License**（非 OSI 开源许可，第三方评论称其为 "open-weight, not open source"）；插件代码本身是 Apache-2.0 | **P0 已读条款原文（一手）**：许可名为 "LiveKit Model License Agreement 2024"（"Last Updated: November 25, 2024"），SPDX `LicenseRef-scancode-livekit-model-2024`，类别 Proprietary Free（`osiApproved: false`）。授权是**框架锁定**的：「you may use these LiveKit models freely but **can only use them together with the LiveKit Agents framework**」，且「**not to use any LiveKit Models on a standalone basis** or with any frameworks other than LiveKit Agents」。本 harness 是独立 Node/TS 进程，正落在被扣留的 "standalone basis" 上 ⇒ 组 C 判 `blocked-by-license`（裁决留给有授权的后续任务，P0 不自行解释许可） | [livekit/agents MODEL_LICENSE](https://raw.githubusercontent.com/livekit/agents/main/MODEL_LICENSE)、[scancode 记录](https://scancode-licensedb.aboutcode.org/livekit-model-2024.html)、[LiveKit docs](https://docs.livekit.io/agents/logic/turns/turn-detector/) |
| G8 | v1 的确切输入张量规格（采样率、窗口长度）未在公开文档中找到明确陈述；需读 `livekit/agents` 仓库 `livekit-plugins-turn-detector` 源码确认 | **P0 已查（一手）**：公开可得常量只有 `DEFAULT_SAMPLE_RATE = 16000`、`MIN_SILENCE_DURATION_MS = 200`、客户端 1.2 s PCM 缓冲；特征提取与权重在 **native 包** `livekit-local-inference`（由**私有**仓库 `livekit/agents-private` 构建）之后，`n_fft`/hop/窗长/log-mel 配方与内部特征类型（原始 PCM 还是 log-mel）均未公开，权重也不在 HF。⇒ 「**公开来源不足以复现**」，这是组 C 的第二个独立原因（`deferred-spec-unclear`）。另注：公开的 HF `livekit/turn-detector` 是**已废弃的 v0.x 文本**模型（`model_q8.onnx` + tokenizer，int64 `input_ids`），不是音频原生的 v1-mini | [livekit/agents `inference/eot/`](https://github.com/livekit/agents/tree/main/livekit-agents/livekit/agents/inference/eot)、[PyPI `livekit-local-inference`](https://pypi.org/project/livekit-local-inference/) |
| G9 | Qwen Realtime `semantic_vad` 的「接受」是控制面回声（不区分合法值与乱填值），不能作为生效证据；此前 P0-S4 已实测 `echoDiscriminates=false`，`held=0/2` | 已核实（本仓库既有实测，见 `voice-realtime-segmented-relay-SPEC.md` P0 结论 S4） | 本仓 SPEC + `experiments/voice-realtime-segmented/p0/traces/s4-semantic-endpoint.json` |

**结论（供组 B/C 选型参考，非最终判据）**：Smart Turn v3.2 的许可证更干净（BSD-2，全量开源，含训练数据），适合本仓自由复现与二次训练；LiveKit v1-mini 的许可证需先读条款才能决定能否在本仓长期使用，P0 内只做**离线评估**（不发行、不商用），按多数开源评估惯例应当允许，但**不假设**，列为 P0 待核实项，不阻塞 B 组的 harness 开发。

---

## P0 Harness

### 标注样本（复用优先，真实样本需授权）

| 来源 | 内容 | 状态 |
|---|---|---|
| `experiments/voice-trim/fixtures/` | 8 条中文语料（已有，`voice-realtime-segmented-relay-SPEC.md` 的 AC-2 已引用） | 复用，不新录 |
| `experiments/voice-realtime-segmented/p0/traces/` | 真实 DashScope 上游追踪，含已标注的 commit/utterance 边界 | 复用作组 D 的既有证据 |
| 新增：中英代码术语混合、句中停顿、自我纠正（「改成三十秒……不对，二十秒」）、执行期间继续说话 | 需要新录或合成；人声样本若非本任务作者本人朗读，需在使用前获得明确授权；合成样本（TTS 或拼接已授权素材）用于补足边界场景，须在 manifest 里标注 `synthetic: true` 以免误当真实人声证据 | **P0 未新增**：没有本任务可用的真人录音，也没有取得 TTS 授权，因此**不合成、不编造**，如实报告样本不足（8 条 / 19 个候选点，`manifest.json` 逐条标 `synthetic: true` 或来源），并在全部结论上打「初步/方向性」。这正是本行原本要求的降级路径 |

每条样本在 `manifest.json` 里标注每个候选静音点的 `END`/`CONTINUE` 真值（人工标注一次，作为回归金标准，不是模型自己标）。

### 读数口径（四组统一）

| 指标 | 定义 |
|---|---|
| 误截断率 false cutoff | 真值 `CONTINUE` 但被判 `END` 的候选点占比 |
| 漏端点 missed endpoint | 真值 `END` 但被判 `CONTINUE` 直到 `maxSegmentMs`/超时才强切的候选点占比 |
| 端点判定延迟 p50/p90 | 从候选静音点出现到判定产出的墙钟时间 |
| CPU/RAM | 单次判定的 CPU 时间与常驻内存（本地模型组 A/B/C 才有意义；组 D 是上游托管，记网络 RTT 代替） |
| 误触发 Action 数 | 若某组判了 `END` 导致提前 commit，而人工真值在该点之后还有属于同一动作的纠正语音，记一次误触发 |
| 额外模型成本 | 组 B/C 为零增量（本地）；组 D 为既有账单口径；组 E 为 ASR + 轻量文本模型的 token 成本 |

### 执行方式

- 组 A/B/C/E：纯本地、离线、确定性，跑在 `experiments/voice-turn-detection-compare/` 下的脚本上，不发真实网络请求（除一次性下载模型权重）。
- 组 D：不新花钱，直接读 `gap-voice-realtime-turn-detection-configurable-comparison` 产出的 `experiments/voice-realtime-turn-detection/RESULT.json`（该任务 ready，尚未执行；若本 SPEC 执行时它还没有结果，组 D 这一行如实标 `pending-upstream-task`，不杜撰数字）。

---

## 非实时 `qwen3.8-omni-flash`（非 `-realtime`）音频原生可行性探针

与 Realtime 路径**并列**对照，同一段音频、同一上下文：

1. 构造一段已分段的真实语音（复用 `experiments/voice-trim/fixtures/` 其中一条，而不是新造）。
2. 请求非实时 `qwen3.8-omni-flash` 的多模态接口，携带音频输入 + 工具声明（与 `session_send` 同形的 function schema），观察：请求体格式、是否接受音频+tools 组合、响应里 `function_call`/`tool_calls` 的出现与否、延迟、token 用量。
3. 同一段音频在 Realtime 路径取 `usage`，并列放进 `RESULT.json`。**P0 执行时改为「引用」而非「再跑一次」**：
   `gap-voice-realtime-turn-detection-configurable-comparison` 已经用**同一段音频**（同一文件、同为
   15.733 s）跑了三个 Realtime arm，其 `RESULT.json` 记着 usage 与每次响应花费；本任务的 边界
   （「不重复花……已花的钱」）与本 SPEC 的非目标（同一条）都禁止重复计费，再跑一次只是同一读数的
   第二个抽样，不产生新信息。因此 step 3 的产出是那份**已记录**的 arm 与本探针并列，`RESULT.json.qwenProbe.realtimeComparison`
   记明引用来源与理由。若上游任务当时没有结果，则按第 4 行的既有规则标 `pending-upstream-task`。
4. **预算**：本探针唯一真实付费调用；上限 **≤ ¥0.02**（非实时+实时各一次最小请求，参照 GOAL-034 P0 单探针量级），超预算即中止并如实记录 `aborted-over-budget`，不得分摊到更多次重试。
5. 若非实时接口不接受音频+tools 组合，或输出里从未出现函数调用，判 `unsupported`，不强行解读。

**P0 实测（2026-10-11，`RESULT.json.qwenProbe`）**：请求被接受（HTTP 200，无协议错误），
`finish_reason: "stop"`，响应里**没有** `tool_calls` 也没有 `function_call`，只有一段文本
（「好的——想在哪个设置页面、加一个控制什么的开关？」）；`usage` 为 prompt 548（audio 107 / text 441）、
completion 250（其中 reasoning 235）。**判定 `unsupported`，不强行解读**——第 5 行要求的正是这个。
按门槛「`function_call` 出现 ⇒ supported」本行到此为止；额外记录的边界是：**该接口接受音频+tools 组合**，
所以 `unsupported` 说的是「这段音频没有产生函调」，不是「非实时路径不支持工具声明」，两者对后续
设计的含义完全不同（前者可用提示工程/换音频再试，后者根本不可行）。探针真实花费 **¥0.00242**（上限
¥0.02，调前先写入 `RESULT.json` 的上界 ¥0.006174 作为守门）；`spendLedger` 同时如实列出为把它做出来
而额外发生的 5 次 bring-up 调用及其花费。

---

## 可配置状态机设计（P0 阶段只设计，不接线）

```
IDLE ──VAD候选静音──► TURN_PENDING
TURN_PENDING ──TurnDetector(END)──► COMMIT_GRACE（计时 graceMs，默认 900ms，可配）
TURN_PENDING ──TurnDetector(CONTINUE)──► IDLE（继续采集，候选点作废）
COMMIT_GRACE ──用户在 graceMs 内继续说话──► TURN_PENDING（原判作废，版本号 +1，旧版本的推理若已投机启动必须被取消）
COMMIT_GRACE ──graceMs 到期无新语音──► ACTION_COMMIT（本版本结果发 session_send）
ACTION_COMMIT ──执行期间用户继续说话──► 新一轮 IDLE→TURN_PENDING（不打断已提交的上一轮，按既有 TOOL_LOOP_GUARD/合并窗口处理，不在本 SPEC 内改）
```

- **投机推理**：`TURN_PENDING` 判 `END` 后即可在 `COMMIT_GRACE` 内后台预热/预取下一步推理，但发往 Claude Code 的 `session_send` 必须等 `ACTION_COMMIT`；若宽限期内被作废，预热结果丢弃，不发送、不计费（如果预热本身要花钱，需先验证是否有「预热但不消费」的免费路径，否则宽限期内不做预热，只做本地判定）。
- **版本化**：每个候选点一个单调递增 `turnVersion`；只有最新 `turnVersion` 能到达 `ACTION_COMMIT`，防止竞态下旧版本的迟到结果覆盖新结果。
- **重连**：复用既有 `UpstreamPool` 的重连与幂等重放（`voice-realtime-segmented-relay-SPEC.md` C3/AC-9），状态机不新增一套重连逻辑。
- **与现有紧凑 UI 的兼容**：`graceMs` 期间 UI 展示与现有「正在聆听/已发送」态复用，不新增视觉态；D5 要求任何实现提案先说明如何落在现有组件，而不是新画一套。

### 状态机自洽性核对（P0 只设计，不接线）

五个要素各自在本文件里只有一处权威定义，没有第二处与它冲突的表述；右侧的实测数字只用来判断该要素
**在实测成本下是否可行**，不改动它的定义：

| 要素 | 本文件中的定义位置 | 与之自洽的实测数字 |
|---|---|---|
| commit grace window | 转移边 `TURN_PENDING ──END──► COMMIT_GRACE（计时 graceMs，默认 900ms）`、`COMMIT_GRACE ──graceMs 到期──► ACTION_COMMIT`，及「投机推理」段 | 默认 900 ms 必须容得下一次判定与一次作废：组 B 端到端判定 p90 **167.4 ms** ⇒ **5.4× 余量**；即使按最慢的一次（组 B@A 视野 p90 165.5 ms）也仍在 900 ms 内。反过来说，若将来换一个判定 p90 > 900 ms 的检测器，`graceMs` 必须同步上调——这两个数由同一段实测绑定，不能各自单独改 |
| `turnVersion` 版本化 | 「版本化」段：每个候选点一个单调递增 `turnVersion`，只有最新版本能到达 `ACTION_COMMIT` | 图中有**两条**回到 `TURN_PENDING` 的边（END 后被作废、`ACTION_COMMIT` 期间又说话），没有版本号则两条边都会让迟到结果覆盖新结果。同一候选点在两次判定之间会有先有后（`groupBSensitivity.readings` 里同一个 `atMs` 在不同窗口、不同样本下各出现一次），这正是「迟到结果」会发生的地方，不是假想 |
| 投机推理的启动/取消 | 「投机推理」段：`END` 后可在宽限期内预热，但 `session_send` 必须等 `ACTION_COMMIT`；被作废则丢弃、不发送、不计费 | 开放问题 4（是否存在「预热但不消费」的免费路径）**未解决** ⇒ 该段已写的保守分支（否则宽限期内只做本地判定）是默认路径，与 D4「先设上限、先汇报」一致：在免费路径被证实前，宽限期内不产生可计费动作 |
| `UpstreamPool` 重连复用 | 「重连」段：复用既有幂等重放（`voice-realtime-segmented-relay-SPEC.md` C3/AC-9），状态机不新增重连逻辑 | 与本 SPEC 非目标「不切换生产默认链路」自洽：状态机若自带第二套重连，就等于在生产链路旁另起一条，与非目标冲突 |
| 不新增 UI 视觉态 | 「与现有紧凑 UI 的兼容」段 + D5 | `graceMs` 只有 900 ms，短于一次有意义的视觉过渡；因此该段要求的「复用正在聆听/已发送态」不是省事，而是唯一能落在 `VoiceRealtimeBar` / `useVoiceRealtimeSession.ts` 现有显示模型里的做法 |

**未接线声明**：以上全是设计。P0 没有改动任何运行时文件——见 `RESULT.json.methodology` 与 AC8 的
零生产改动判据（`git diff develop` 对 `voice-realtime-bridge.service.ts`、
`voice-realtime-dashscope-transport.ts`、`src/modules/chat/voice-realtime/` 为空）。

---

## Go / No-Go 判据（执行前写死，不得事后调整）

> 门槛保持执行前写死的原文；`实测` 一列由 `experiments/voice-turn-detection-compare/RESULT.json`
> 填入（2026-10-11，本任务自己的本地 ONNX 运行，以及记录在案的那一次真实付费探针；把探针做出来所
> 需要的另外 5 次 bring-up 调用见 `qwenProbe.spendLedger`）。**先有数字，后有判定**，
> 判定列只做门槛与数字的机械比较。

| 判据 | 门槛（执行前写死） | 实测 | 判定 |
|---|---|---|---|
| 误截断率（组 B 或 C 对比组 A） | 相对组 A **降低** ≥ 30% | 组 C 无数字（`blocked-by-license`，见下）。组 B **0.1818** vs 组 A(calibrated) **0.6364** ⇒ **−71.4%**；vs 组 A(shipped) **0.0909** ⇒ **+100%（更差）** | **PASS** 对可用的组 A；**FAIL** 对 shipped 读数——而 shipped 组 A 在本语料上是**退化**读数（噪声基线塌到 `MIN_FRAME_ENERGY`，它对任何停顿都不判 END，`missedEndpointRate=0.75`），拿它当分母会奖励一个不工作的检测器。两个数字都在 `RESULT.json` 里，判定分歧的原因也在 |
| 端点判定延迟 p90（组 B/C） | ≤ 150 ms（本地 CPU） | 端到端 p90 **167.4 ms** = ONNX 推理 p90 **39.2 ms** + 本 harness 的 JS log-mel 前端 p90 **128.5 ms** | **FAIL**（端到端）；**PASS**（模型内核本身）。谁该被这条门槛卡住，取决于生产实现是否用编译过的 mel 前端替换本 harness 的朴素 DFT——数字已拆开，判定不合并 |
| CPU 占用（组 B/C 常驻） | 单核增量 ≤ 10% | 批处理 `cpuUsage` **429.4 ms / 次判定**、RSS **+41.5 MB** | **P0 不能判定**：常驻单核占比在批处理进程里不可分。记录的是每次判定的 CPU 时间，不是占用率——限制已写进 `RESULT.json.caveats` |
| 误触发 Action 数（任意组） | 不得高于组 A 的现状 | 组 A(shipped) **1**、组 A(calibrated) **7**、组 B **2**、组 B@A 视野 **4** | **FAIL**（对 shipped 的 1）；**PASS**（对 calibrated 的 7）。与误截断率同一分歧：一个不判 END 的检测器误触发必然少 |
| 非实时 qwen 可行性 | `function_call` 出现 ⇒ supported；否则 unsupported | 真实付费调用一次（**¥0.00242**，HTTP 200，声明 `session_send` + `tool_choice=auto`，同一段 15.733 s 音频）：**未出现** `function_call`/`tool_calls`，回复为文本「好的——想在哪个设置页面、加一个控制什么的开关？」 | **unsupported（本段音频）**。补一条实测边界：请求**被接受**（HTTP 200，无协议错误），所以这是「模型在这段音频上没有发函调」，不是「该接口不接受工具声明」 |
| 样本量 | < 20 条须显式标注「初步/方向性」 | **8 条**标注样本 / **19** 个候选点（TTS 合成，非 20 条独立人声） | **样本不足**：全部结论为初步/方向性，不作为最终 go/no-go。已写进 `RESULT.json.sampleSizeCaveat` |

**除样本量一行为「不足」外，其余五行都有真实数字或显式限制说明，无一行是结论反推。**
组 C 没有数字是**门槛允许的结果**（失败模式表：「LiveKit Model License 条款不允许本仓用途 ⇒ 组 C 标
`blocked-by-license`，不绕过许可证限制去跑模型」），不是缺口；其许可证与输入规格的证据见
`RESULT.json.groupC`。

---

## 分期

| 期 | 内容 | 退出条件 |
|---|---|---|
| **P0** | 标注样本 manifest；组 A/B 本地 harness 与实测读数；组 C 的许可证/输入规格核实 + 尝试本地 harness（若受阻，记录阻塞原因）；组 D 读既有任务产出或标 `pending`；组 E 可选；非实时 qwen 可行性探针（≤¥0.02）；状态机设计章节 | 本 SPEC 的 Go/No-Go 表全部填入真实数字或显式局限说明 |
| **P1（视 P0 结果决定是否启动）** | 把 P0 判定「go」的检测器接成可插拔 adapter（接口先行，不默认开启），灰度开关，不改默认链路 | 另立任务，依赖本 SPEC P0 结论 |

---

## 失败模式与降级

| 失败 | 处理 |
|---|---|
| LiveKit Model License 条款不允许本仓用途 | 组 C 标 `blocked-by-license`，不绕过许可证限制去跑模型 |
| Smart Turn v3.2 本地 CPU 实测延迟远高于第三方数字 | 如实记录，不采信第三方 benchmark 作为最终结论 |
| 标注样本不足 20 条 | 报告局限，不编造样本凑数 |
| 非实时 qwen 不支持音频+tools 组合 | 判 unsupported，状态机设计里的「非实时路径」分支标为不可行，仅保留 Realtime 路径 |
| 预算超支（任一本地步骤意外触发了计费调用） | 立即中止，记录实际花费，不得「先超支再解释」 |

---

## 开放问题

1. ~~LiveKit Model License 完整条款（G7）~~ —— **P0 已关闭**：条款已读，授权是框架锁定的，独立进程落在被扣留的
   "standalone basis" 上 ⇒ 组 C 判 `blocked-by-license`（G7 行有原文引用）。**是否接受该条款是产品/法务决定，不是 P0 能自答的**，故从「开放问题」降级为「已核实事实 + 一个待授权决定」。
2. ~~LiveKit v1-mini 确切输入张量/窗口规格（G8）~~ —— **P0 已关闭（结论是「公开来源不可复现」）**：只有
   `DEFAULT_SAMPLE_RATE=16000` / `MIN_SILENCE_DURATION_MS=200` / 1.2 s 缓冲是公开的，特征配方在私有构建的
   native 包之后（G8 行有来源）。这是一个**已核实的限制**，不是未完成的阅读。
3. v1-mini 在中英混杂、代码术语场景下的精度是否同等于 v1 全量模型（未找到公开数字，需自测）。
4. 预热推理是否存在「不消费即丢弃」的免费路径（决定 COMMIT_GRACE 期间能否真正做到「投机但零成本」）。
