# 低成本 Turn Detection 对照 SPEC —— 可插拔音频原生轮次检测器评估（Pipecat Smart Turn / LiveKit Turn Detector / Qwen Realtime）

状态：**P0 已执行（2026-10-11）；P0.5 扩展已执行（2026-10-11）**——实测数字在 `experiments/voice-turn-detection-compare/RESULT.json`，
入口 `node scripts/voice-turn-detection-compare.mjs`。P0.5 把标注样本从 8 条扩到 **12 条 / 27 个候选点**（新增自我纠正三态、
中英代码术语混合、句中停顿），但仍是 **0 条独立人声**（合成/派生样本），`sampleSizeCaveat` 继续为真 ⇒
**结论仍为初步/方向性，不作为最终 go/no-go**。P0.5 同时新增 MaAI / Vogent / DualTurn 候选评估、LiveKit 条款复核与
正式对照组升级、Smart Turn 开销根因、以及非实时 qwen 探针的多语料/多提示明确度重设计。
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
| C | VAD + LiveKit Turn Detector v1-mini | 音频（**非**转写文本——v1 系列已从 v0.x 的 STT-文本架构换成音频原生，语言由 STT 上报用于选阈值） | 本地 CPU 推理（v1 的轻量化 CPU 变体） | 本地 CPU，权重受 LiveKit Model License（非 OSI 开源，细则待核实），无调用费。**P0.5：正式对照组，但状态为「已设计、授权阻塞」（`measured:false`）**——adapter 接口、manifest 接入方式、六读数 schema 均已设计，只是 Section 3(i) 禁止在 LiveKit Agents 框架之外独立跑分，未取得书面授权前不下载/不运行权重 |
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
| G7 | v1 系列权重受 **LiveKit Model License**（非 OSI 开源许可，第三方评论称其为 "open-weight, not open source"）；插件代码本身是 Apache-2.0 | **P0 已读条款原文（一手）**：许可名为 "LiveKit Model License Agreement 2024"（"Last Updated: November 25, 2024"），SPDX `LicenseRef-scancode-livekit-model-2024`，类别 Proprietary Free（`osiApproved: false`）。授权是**框架锁定**的：「you may use these LiveKit models freely but **can only use them together with the LiveKit Agents framework**」，且「**not to use any LiveKit Models on a standalone basis** or with any frameworks other than LiveKit Agents」。本 harness 是独立 Node/TS 进程，正落在被扣留的 "standalone basis" 上 ⇒ 组 C 判 `blocked-by-license`（裁决留给有授权的后续任务，P0 不自行解释许可）<br>**P0.5 脚注（一手原文澄清「免费 ≠ 许可范围」）**：LiveKit 官方文档的 "free to use in any context at no additional cost" 说的是**定价**（不额外收费），不是许可授权范围；License 原文的 "can only use them together with the LiveKit Agents framework" 与 "not to use any LiveKit Models on a standalone basis" 说的是**能在哪用**。两句话分别回答「要钱吗」与「能在哪用」，**不矛盾**，合起来正是组 C `blocked-by-license` 的依据。本条是新增的澄清脚注，**不重开**已关闭的开放问题 1/2 | [livekit/agents MODEL_LICENSE](https://raw.githubusercontent.com/livekit/agents/main/MODEL_LICENSE)、[scancode 记录](https://scancode-licensedb.aboutcode.org/livekit-model-2024.html)、[LiveKit docs](https://docs.livekit.io/agents/logic/turns/turn-detector/) |
| G8 | v1 的确切输入张量规格（采样率、窗口长度）未在公开文档中找到明确陈述；需读 `livekit/agents` 仓库 `livekit-plugins-turn-detector` 源码确认 | **P0 已查（一手）**：公开可得常量只有 `DEFAULT_SAMPLE_RATE = 16000`、`MIN_SILENCE_DURATION_MS = 200`、客户端 1.2 s PCM 缓冲；特征提取与权重在 **native 包** `livekit-local-inference`（由**私有**仓库 `livekit/agents-private` 构建）之后，`n_fft`/hop/窗长/log-mel 配方与内部特征类型（原始 PCM 还是 log-mel）均未公开，权重也不在 HF。⇒ 「**公开来源不足以复现**」，这是组 C 的第二个独立原因（`deferred-spec-unclear`）。另注：公开的 HF `livekit/turn-detector` 是**已废弃的 v0.x 文本**模型（`model_q8.onnx` + tokenizer，int64 `input_ids`），不是音频原生的 v1-mini | [livekit/agents `inference/eot/`](https://github.com/livekit/agents/tree/main/livekit-agents/livekit/agents/inference/eot)、[PyPI `livekit-local-inference`](https://pypi.org/project/livekit-local-inference/) |
| G9 | Qwen Realtime `semantic_vad` 的「接受」是控制面回声（不区分合法值与乱填值），不能作为生效证据；此前 P0-S4 已实测 `echoDiscriminates=false`，`held=0/2` | 已核实（本仓库既有实测，见 `voice-realtime-segmented-relay-SPEC.md` P0 结论 S4） | 本仓 SPEC + `experiments/voice-realtime-segmented/p0/traces/s4-semantic-endpoint.json` |

**结论（供组 B/C 选型参考，非最终判据）**：Smart Turn v3.2 的许可证更干净（BSD-2，全量开源，含训练数据），适合本仓自由复现与二次训练；LiveKit v1-mini 的许可证需先读条款才能决定能否在本仓长期使用，P0 内只做**离线评估**（不发行、不商用），按多数开源评估惯例应当允许，但**不假设**，列为 P0 待核实项，不阻塞 B 组的 harness 开发。

### 新增候选（P0.5）：DualTurn —— 未集成，跟踪候选

DualTurn（GitHub `anyreachai/dualturn`）是按人 yale 指令核实的研究性候选。**本任务不接入 harness、不新增 adapter 文件、不跑分**——只核实代码/权重许可证来源与论文数字，供后续决定是否立项。下表两个许可证字段是**分别**读到的（代码仓库页、HF model card），**不是**论文许可证。

| 项 | 值 | 来源（一手） |
|---|---|---|
| 代码许可证 | **MIT** | [github.com/anyreachai/dualturn](https://github.com/anyreachai/dualturn) 仓库页 `LICENSE`（页面显示 "MIT license"） |
| 权重许可证 | **apache-2.0**（`cardData.license` 字段；仓库内**无**独立 LICENSE 文件、model card 无正文条款，只有裸字段值） | [HF `anyreach-ai/dualturn-qwen2.5-mimi-0.5B`](https://huggingface.co/anyreach-ai/dualturn-qwen2.5-mimi-0.5B) model card API（`cardData.license == "apache-2.0"`） |
| 论文许可证 | 论文本身 CC BY 4.0 —— **只覆盖论文文本，不覆盖代码/权重**，故**不能**拿它当代码或权重的许可证证据 | 论文（Interspeech 2026 投稿） |
| 参数量 | **0.5B**（HF card 记 658,612,144 参数，F32；LoRA 可训练 9M） | HF model card |
| 单 CPU 延迟 | **78 ms**（**来源：论文，本任务未复测**） | 论文 |
| 输出头 | 6 个（EOT / HOLD / BOT / BC / VAD / FVAD） | 论文 / 仓库 README |

**标注纪律**：0.5B / 78 ms 两个数字来自**论文**，本任务未复测，不得当作本仓实测数字；代码 MIT 与权重 apache-2.0 是分别核实的一手字段（与论文的 CC BY 4.0 无关）。**结论：未集成，跟踪候选**——是否立项另议，本 SPEC 只登记已核实事实，不新增 adapter（`experiments/voice-turn-detection-compare/adapters/` 下无 `dualturn*` 文件）。

---

## P0 Harness

### 标注样本（复用优先，真实样本需授权）

| 来源 | 内容 | 状态 |
|---|---|---|
| `experiments/voice-trim/fixtures/` | 8 条中文语料（已有，`voice-realtime-segmented-relay-SPEC.md` 的 AC-2 已引用） | 复用，不新录 |
| `experiments/voice-realtime-segmented/p0/traces/` | 真实 DashScope 上游追踪，含已标注的 commit/utterance 边界 | 复用作组 D 的既有证据 |
| 新增：中英代码术语混合、句中停顿、自我纠正（「改成三十秒……不对，二十秒」）、执行期间继续说话 | 需要新录或合成；人声样本若非本任务作者本人朗读，需在使用前获得明确授权；合成样本（TTS 或拼接已授权素材）用于补足边界场景，须在 manifest 里标注 `synthetic: true` 以免误当真实人声证据 | **P0 未新增**：没有本任务可用的真人录音，也没有取得 TTS 授权，因此**不合成、不编造**，如实报告样本不足（8 条 / 19 个候选点，`manifest.json` 逐条标 `synthetic: true` 或来源），并在全部结论上打「初步/方向性」。这正是本行原本要求的降级路径 |

每条样本在 `manifest.json` 里标注每个候选静音点的 `END`/`CONTINUE` 真值（人工标注一次，作为回归金标准，不是模型自己标）。

**P0.5 扩充（AC5）**：`manifest.json` 新增自我纠正、中英代码术语混合、句中停顿三个场景，共 **4 条 derived synthetic** 样本，语料扩到 **12 条标注样本 / 27 个候选点**；三态标注 **END / CONTINUE / CORRECTION**（`RESULT.json.sampleBreakdown.denominatorByTruth = {END:12, CONTINUE:14, CORRECTION:1}`），每条标 `source`(real/synthetic) 与 `language`。**仍是 0 条独立人声**（8 条 authored fixture + 4 条 derived synthetic）⇒ `sampleSizeCaveat` **继续为真**，全部结论仍为「初步/方向性」；分母按**候选点**（每个组都要回答的单位）而非 clip 计。未编造任何真实人声样本。

### 读数口径（四组统一）

| 指标 | 定义 |
|---|---|
| 误截断率 false cutoff | 真值 `CONTINUE` 但被判 `END` 的候选点占比 |
| 漏端点 missed endpoint | 真值 `END` 但被判 `CONTINUE` 直到 `maxSegmentMs`/超时才强切的候选点占比 |
| 端点判定延迟 p50/p90 | 从候选静音点出现到判定产出的墙钟时间 |
| CPU/RAM | 单次判定的 CPU 时间与常驻内存（本地模型组 A/B/C 才有意义；组 D 是上游托管，记网络 RTT 代替） |
| 误触发 Action 数 | 若某组判了 `END` 导致提前 commit，而人工真值在该点之后还有属于同一动作的纠正语音，记一次误触发 |
| 额外模型成本 | 组 B/C 为零增量（本地）；组 D 为既有账单口径；组 E 为 ASR + 轻量文本模型的 token 成本 |

#### P0.7 统一 replay 口径（eot-bench）

上表是**读数定义**，四组自带以来一直统一；P0.7 新增的是把四个读数算在**同一套评分与 sweep 代码**上
（`experiments/voice-turn-detection-compare/eot-bench-adapters/`，精确复刻 LiveKit `eot-bench` 的
`metrics.py` 语义，见 `RESULT.json → unifiedReplay.protocol.reverification`），产出**同分母、同扫描网格**的数字。
两套口径的对应关系（**旧口径的列一行不删**）：

| 上表指标 | P0.7 统一口径的字段（`RESULT.json → unifiedReplay`） | 与旧口径的差别 |
|---|---|---|
| 误截断率 false cutoff | `batch.groups.{A,B,C}.bestAtBudget.*.cutoffRate`、`qwenStreaming.byLevel.level{n}.sweep.*.cutoffRate` | 不再由各组自己的判定规则给一个点，而是**同一条** `cutoff = timeout_cutoff ∨ model_cutoff` 策略式在同一条 `threshold × action_delay × timeout` 网格上扫出来的点 |
| 漏端点 missed endpoint | 同上 `*.missedEndpointRate`（上游叫 `timeout_rate`） | 同上 |
| 端点判定延迟 p50/p90 | `batch.groups.*.bestAtBudget.*.meanLatencySeconds`（eot 点均值，上游口径）+ 组 D 另记 `userWaitEndpointMsP50/P90` 与 `modelOverheadMsP50/P90` | 组 D **把「模型推理耗时」与「用户等待端点时长」拆成两个独立字段**（AC4），不再合成一个「延迟」 |
| CPU/RAM | 组 D `metrics.cpuRam.qwenStreaming = {applicable:false, value:'N/A'}` | 组 D 标 `N/A` 并给出理由（上游托管，无本地模型），**不拿 RTT 充数** |
| 误触发 Action 数 | `actionCommit.simulated`（四组同一反事实策略「END ⇒ action」）与 `actionCommit.real`（组 D 的真实函调读数，**引用** P0.6，不重复花钱） | 模拟与真实**分开标注**，不混成一个数 |
| 额外模型成本 | `qwenStreaming.budget` / `actualSpend`（本任务新增，¥0）+ `actionCommit.real.cumulativeNewSpendCny`（P0.6 的 ¥0.025232，引用不重花） | 分账不变 |

⚠️ **本 SPEC 的组字母沿用 P0 定义**：A = StreamingVad、B = Smart Turn（编译版）、C = LiveKit v1-mini、
**D = Qwen Realtime**、E = ASR→文本 baseline（E 不在本 replay 内）。P0.7 的 artifact 用同一套字母。

⚠️ **同基准的含义与边界**：批量组 A/B/C 在全部 **73** 个候选点上打分；组 D 只能在**分层的 12 个点**
（`silence_duration_ms` 两档 × 12 个点 = 24 个独立会话）上打分，因为每个候选点都是一次真实上游会话。
这个覆盖差**逐行标注**（`unifiedReplay.metrics.coverage`），不把两个不同 n 的比率并排当同精度比较。

⚠️ **子集选择（AC1）——可再现性/许可结论是核查出来的，不是假设的**：P0.7 的 `corpus.mts → spanEligibility`
对每个候选点**真的检查**两个维度并把判决与理由写进 artifact（`unifiedReplay.corpus.eligibility`），
而不是只看「有没有静音」。本语料的结果：**73/73 可入，0 排除**，按取得方式分
`{committed-fixture: 19, derived-in-memory: 8, fetch-script+pinned-sha256: 46}`（19+8+46=73），
真实录音按记录在案的许可证分 `{CC-BY-4.0: 21, Apache-2.0: 25}`（21+25=46）。即：8 条 authored fixture
是仓库内提交的 WAV；4 条 derived synthetic 由提交的 fixture **内存内确定性地**导出；32 条真实人声由
**提交的** `datasets/fetch-real-samples.mjs` 抓取并以 sha256 钉住完整性。**被排除集合为空**，不是没查——
若某条真实样本缺 `licenseSpdx`/`fetchScript`/`sha256`，谓词会把它连同理由列进 `excluded`。

### 执行方式

- 组 A/B/C/E：纯本地、离线、确定性，跑在 `experiments/voice-turn-detection-compare/` 下的脚本上，不发真实网络请求（除一次性下载模型权重）。
- 组 D：不新花钱，直接读 `gap-voice-realtime-turn-detection-configurable-comparison` 产出的 `experiments/voice-realtime-turn-detection/RESULT.json`（该任务 ready，尚未执行；若本 SPEC 执行时它还没有结果，组 D 这一行如实标 `pending-upstream-task`，不杜撰数字）。

> **P0.7 修正（本条是 P0 的原文，保留不删）**：上面这条被 P0.7 任务
> `gap-voice-turn-detection-p0-7-unified-realtime-benchmark` **实质性推翻**。人 yale 明确拒绝「新旧数据拼表」：
> 那份 sibling `RESULT.json` 用的是**不同的语料、不同的时间点、每个 arm 只有一条连接的单样本对照**，
> 不能拿来当「组 D 在同一 manifest 上」的读数。P0.7 因此**真实开了组 D 的会话**——`qwen3.8-omni-flash-realtime`
> 通过**本仓出货的** DashScope transport（`server/modules/voice-realtime/voice-realtime-dashscope-transport.ts`，
> 只读不改）在**同一份 44 样本 / 73 候选点 manifest** 的分层子集上，每个候选点一档 `silence_duration_ms`、
> **一个独立会话**，跑出完整事件时间轴。新增付费 **¥0**（每个会话 `create_response:false`，上游不产生 usage），
> 上限 ¥0.05 写在 `unifiedReplay.qwenStreaming.budget`。sibling `RESULT.json` 的旧读数**仍保留在
> `RESULT.json → qwenProbeRealAudio` / `qwenProbe`**，只作为**旧口径**引用，不再充当组 D 的基准。

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

**P0.5 重设计（AC7，2026-10-11，`RESULT.json.qwenProbe`）**：P0 的单条读数不能区分「接口不支持」「提示未
触发」「schema 问题」「模型选择不调用」，故 P0.5 把它重做成一个**批量矩阵**——**2 条语料**（一条无歧义可执行
指令 `zh-d01-o85`「把 server 里的 voice.service.ts 的超时改成三十秒」＋ P0 用过的犹豫语料 `zh-d13-o45` 作
对照）× **3 个提示层级**（implicit-auto / explicit-auto / explicit-forced，第三个用 `tool_choice` 强制点名
`session_send`）。预算上限**执行前写入 artifact**（本批最坏上界 **¥0.027414 ≤ ¥0.03** 守门；含 P0 已花
¥0.00242 的累计口径），实际发生 **5 次真实付费调用、共 ¥0.019129**（累计实测 ¥0.021549，均在 cap 内）。读数：

- **接口 = YES**：`explicit-forced` 下模型**确实**发出 `session_send` 且参数符合 schema ⇒ **排除「接口结构性
  不支持音频+tools」**、**排除「schema 问题」**。
- **提示是关键触发**：同一条无歧义指令，`implicit` 下**只回文本**（"我这边没有可直接编辑 `server/voice.service.ts`
  的工具…"），换成 `explicit` 点名工具后**立即发函调** ⇒ 对无歧义指令，「提示未触发」正是 P0 那条读数的成因。
- **模型选择不调用 = 已排除**（对无歧义指令）：清晰指令下它调用了。
- **P0 读数不可复现**：P0 记录的格子（犹豫语料 + implicit 提示 + `temperature=0`）本次**发出了函调**
  （`p0Reproduction.reproducible=false`）——同一请求、不同结果，说明单次采样不能支撑结论；这本身就是 P0.5
  重设计的理由。另记一条边界：强制调用的参数把文件名转写成了 `voice-service.ts`（连字符）而非音频里的
  `voice.service.ts`（点号）——这是**转写鲁棒性**的观察，不是 schema 问题。

**结论**：非实时音频原生路径**可用**（在清晰、点名工具的提示下会调用 `session_send`），不再是 P0 的单一
`unsupported`；门限判据「`function_call` 出现 ⇒ supported」由本批 5 次调用**满足**。

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

> 门槛保持执行前写死的**原文**，P0 / P0.5 / P0.6 **同一列、全程未放宽**；三列都由
> `experiments/voice-turn-detection-compare/RESULT.json` 填入（P0 = 2026-10-11 首轮，语料 8 条/19 点；
> P0.5 = 同日扩充语料到 12 条/27 点后的重算，外加记录在案的真实付费探针；P0.6 = 本任务
> `gap-voice-turn-detection-p0-6-dataset-benchmark`，语料再扩到 44 条 / 73 点（含 **32 条真实人声**），并新增
> 编译前端（AC3）、LiveKit **框架内**实测（AC4）、真实人声上的非实时 qwen 探针（AC5）。把各探针做出来所需的
> bring-up 调用见 `qwenProbe.spendLedger`；AC5 **新增**调用是一本**独立**的账，见 `qwenProbeRealAudio.runs` +
> `cumulativeNewSpendCny`）。**先有数字，后有判定**，判定列只做门槛与数字的机械比较，不因新数字
> 好看而放宽门槛。

| 判据 | 门槛（执行前写死，P0/P0.5 同列，未放宽） | P0 实测 | P0.5 重算（2026-10-11，语料 12 条 / 27 点） | 判定（P0.5） | P0.6 实测（本任务 `gap-voice-turn-detection-p0-6-dataset-benchmark`，语料 44 条 / 73 点，含 32 条真实人声） | 判定（P0.6） |
|---|---|---|---|---|---|---|
| 误截断率（组 B 或 C 对比组 A） | 相对组 A **降低** ≥ 30% | 组 B **0.1818** vs 组 A(calibrated) **0.6364** ⇒ −71.4%；vs 组 A(shipped) **0.0909** ⇒ +100%（更差） | 组 B **0.4286** vs 组 A(shipped) **0.3571** ⇒ **+20.0%（更差）**；vs 组 A(fixed floor) **0.7143** ⇒ **−40.0%（达标）**；组 C 仍无数字（`blocked-by-license`） | **分歧**：对可用基线（fixed floor）**PASS**，对 shipped 读数 **FAIL**——shipped 组 A 在本语料上是**退化**读数（噪声基线塌到 `MIN_FRAME_ENERGY`，对任何停顿都不判 END，`missedEndpointRate=0.8333`），拿它当分母会奖励一个不工作的检测器。两个数字与原因都在 `RESULT.json` + `floorDiagnosis` | 组 C **首次有数字**（blocked-by-license → measured）：误截断 **0.2917**（65 点，95% CI [0.1491,0.4917]）vs 组 A(shipped) **0.3571** ⇒ **−18.3%（未达 −30%）**、vs 组 A(fixed floor) **0.5** ⇒ **−41.7%（达标）**；组 B **0.6429** vs shipped **0.3571** ⇒ **+80%（更差）** | **分歧仍在**：对可用基线（fixed floor）**PASS**、对退化 shipped **FAIL**；组 C 落在两者之间，对 shipped **未达 −30% 门槛** |
| 端点判定延迟 p90（组 B/C） | ≤ 150 ms（本地 CPU） | 端到端 p90 **167.4 ms** = ONNX p90 **39.2 ms** + JS log-mel 前端 p90 **128.5 ms** | 端到端 p90 **173.22 ms** = ONNX 推理 p90 **43.99 ms** + 本 harness 的 JS log-mel 前端。**AC1 根因**（warm/cold 拆分 + 官方 recipe 的 numpy 对照 oracle，特征逐位一致 `maxAbsDiff=0`）：JS 前端单独 warm p90 **≈121 ms**，而**同一 recipe 的 numpy FFT 仅 6.2 ms** ⇒ 这 ~121 ms 是**朴素 DFT 实现**，不是算法本身 | **FAIL**（端到端）；**PASS**（模型内核本身 **43.99 ms** + 一个编译过的 mel 前端——而 oracle 证明朴素 DFT 可被替换）。数字已拆开，判定不合并 | 组 B 端到端 p90（JS 前端）**168.95 ms** — 仍超标。**AC3** 证明前端可替换：编译 C 前端 warm p50 **24.868 ms**（cold **24.902**）vs 同一 clip 的 JS 朴素 DFT warm p50 **121.228 ms** ⇒ **4.9×**；三路数值等价（compiled↔JS **1.19e-7**、compiled↔numpy **0**、JS↔numpy **1.19e-7**，全 `allWithinTolerance=true`）。⇒ **投影**：编译前端接入组 B 后端到端 ≈ ONNX 推理 p90 **46.77** + 前端 **~24.9** ≈ **72 ms**（**推算值，非端到端重测**）。组 C 实测 p90 **12.71 ms** / p50 **12.3 ms** / cold **16.60 ms** | 组 C **PASS**（12.71 ≤ 150）。组 B **FAIL（现状 JS 前端 168.95 ms）**；编译前端使其**具备 PASS 条件**（投影 ~72 ms），但本任务**未把编译前端接入组 B 决策回路**，故判定维持 FAIL，投影仅作可行性证据 |
| CPU 占用（组 B/C 常驻） | 单核增量 ≤ 10% | 批处理 **429.4 ms / 次判定**、RSS **+41.5 MB** | 批处理 **489.079 ms / 次判定**、RSS **+32.5 MB** | **P0.5 仍不能判定**：常驻单核占比在批处理进程里不可分；记录的是每次判定的 CPU 时间，不是占用率（`RESULT.json.caveats`） | 组 C 批处理 **34.242 ms/次判定**、RSS 增量 **58.8 MB**；组 B **422.185 ms/次判定** | **同 P0.5 仍不能判定**——批处理进程里单核占比不可分，记录的是每次判定的 CPU 时间，不是占用率 |
| 误触发 Action 数（任意组） | 不得高于组 A 的现状 | 组 A(shipped) **1**、组 A(calibrated) **7**、组 B **2**、组 B@A 视野 **4** | 组 A(shipped) **5**、组 A(fixed floor) **10**、组 B **6**、组 B@A 视野 **8** | **FAIL**（对 shipped 的 5）；**PASS**（对 fixed floor 的 10）。与误截断率同一分歧：一个不判 END 的检测器误触发必然少 | 组 A(shipped) **10**、组 A(fixed floor) **14**、组 B **18**、组 C **7** | 组 C **7 ≤ shipped 10 ⇒ PASS**；组 B **18 > 10 ⇒ FAIL**。同样受「不判 END 的检测器误触发必然少」的相对性约束 |
| 非实时 qwen 可行性 | `function_call` 出现 ⇒ supported；否则 unsupported | 1 次付费调用（¥0.00242）：未出现 `function_call`/`tool_calls`，回复文本 | **AC7 批量 5 次**真实付费调用（2 语料 × 3 提示层级）：**出现 `function_call`/`tool_calls`**（`session_send`），接口=**YES** | **SUPPORTED**（在无歧义指令 + 显式点名工具的提示下）；界限已由批量读数拆开——详见下一节 | 在**真实人声**上重测（**AC5**，LibriSpeech en **3.505 s** + THCHS-30 zh **8.25 s** × auto/forced）：4/4 单元 `text-only`（HTTP 200）；**auto 层 2/2 无误触发**（spurious **0**），**forced 层 2/2 未出现 conforming `tool_call`**（paramSchemaAccuracy **0/2**）。usage 显示模型确实听到音频（audio_tokens 23/58 + 正确转写）⇒「无调用」是判定而非未收到音频。**累计新增付费 ¥0.025232 ≤ ¥0.05**（与 P0/P0.5 的 ¥0.021549 **分账**） | 接口 **SUPPORTED 结论不变**（AC7 批量已证）；**真实读语音频上 auto/forced 均未触发调用**——与 P0.5 TTS 无歧义指令下的 YES 合起来的边界：**需显式点名工具且音频含指令语义**才触发 |
| 样本量 | < 20 条须显式标注「初步/方向性」 | **8 条** / **19** 点 | **12 条**标注样本 / **27** 候选点（**0 条独立人声**；8 条 authored fixture + 4 条 derived synthetic） | **样本不足**（12 < 20）：全部结论仍为初步/方向性，不作为最终 go/no-go（`RESULT.json.sampleSizeCaveat=true`） | **44 条**标注样本 / **73** 候选点 = 8 authored fixture + 4 derived synthetic + **32 条真实人声**（贡献 **46 候选点**）；`sampleSizeCaveat=false` | **样本充分**（32 ≥ 20）——**由 P0.5 的「不足」翻转为「充分」**。⚠️ 但 32 条人声**全部是读语音频（read speech）**，无真实「改变请求 / 打断」语音，CORRECTION 点仅 **1** 个 ⇒「充分」限指**端点判定**口径；改变请求/打断口径仍不足（`humanSampleNote`） |
| **MaAI** VAP 单通道（P0.5 新候选） | 同组 A/B 六读数口径（可测则须产出） | 未评估 | `blocked-by-license`：代码 MIT，但**中文单通道权重** `maai-kyoto/vap_ch` 的 `cardData.license` 是 **cc-by-nc-nd-4.0**（无商用、无改作），且环境无 torch | **不可测（授权阻塞）**——不是门槛失败，是许可证不允许本仓用途；见 `RESULT.json.candidateMaAI` | —（本任务不解禁：任务边界明令 MaAI 的 P0.5 结论不重新评估） | **结论不变**（授权阻塞，非门槛失败） |
| **Vogent Turn 80M**（P0.5 新候选） | 同组 A/B 六读数口径 | 未评估 | `deferred-gated-weights`：权重门控（`gated:"auto"`，取 LICENSE 得 HTTP 401），未接受条款即不可取权重；「横向平台需显式让用户选择 *Vogent Turn Detector*」条款原文已记录 | **不可测（权重门控）**——接受门控条款是用户决定，本任务不代接受；见 `RESULT.json.candidateVogent` | —（同上，本任务不代为接受门控条款） | **结论不变**（权重门控） |
| **LiveKit v1-mini**（P0.5：脚注 → 正式对照组） | 同组 A/B 六读数口径 | 脚注（`blocked-by-license`） | **「已设计、授权阻塞」正式对照组**：adapter 接口、manifest 接入、六读数 schema 均已设计，`measured:false` 保留（不伪造数字）；Section 3(i)/3(ii) 一手原文定位见 `RESULT.json.groupC` | **不可测（授权阻塞）**——未获书面授权前不下载/运行权重 | **blocked-by-license → measured**。许可证一手原文**重新核实**（Model License Agreement "Last Updated: November 25, 2024"，Section 3.b(i)：禁止 *standalone* 使用，**在 LiveKit Agents 框架内**使用被许可；`RESULT.json.groupC.licenceReverification` 含 `changeFromP05`）。在 sandbox venv 内用 `livekit-agents 1.8.6` 的 `inference.TurnDetector(version="v1-mini")` **真实本地推理**：**65 点**、误截断 **0.2917**、漏端点 **0.475**、误触发 **7**、p50 **12.3** / p90 **12.71 ms**、cold **16.60 ms**、**34.242 ms CPU/判定**、RSS 增量 **58.8 MB**。**sandbox 隔离机械证据**：扫 8 个构建/依赖配置 **0 命中**任何 livekit 标记 ⇒ `coupledToBuild=false`，verdict **PASS** | **可测（框架合规）**——P0.5 的 `blocked-by-license` 被**实质性推翻**：条文允许框架内使用，本任务即在框架内跑出真实读数。⚠️ 边界：**不得**脱离 LiveKit Agents 做 standalone 推理 |
| **DualTurn**（P0.5 新候选，文档核实） | 同组 A/B 六读数口径 | 未评估 | **未集成，跟踪候选**：代码 MIT / 权重 apache-2.0（分别核实，非论文的 CC BY 4.0）；0.5B、78 ms 为**论文数字、未本任务复测**；不新增 adapter | **未评估（仅登记）**——按人 yale 指令只做许可证/成本文档核实 | —（本任务不新增 adapter） | **结论不变**（仅登记） |

**除 MaAI / Vogent 为「授权/门控阻塞」、DualTurn 为「仅登记」外，其余各行都有真实数字或显式限制说明，无一行是结论反推。**
MaAI / Vogent 没有数字是**门槛允许的结果**（失败模式表：「许可证条款不允许本仓用途 ⇒ 标
`blocked-by-license`，不绕过许可证限制去跑模型」），不是缺口；二者的许可证与输入规格证据分别见
`RESULT.json.candidateMaAI` / `candidateVogent`。**组 C（LiveKit）在 P0.6 已不再属于「无数字」一类**——
许可证原文重新核实后，框架内使用被判定为合规，本任务据此跑出真实读数（见该行）。

**P0.6 与 P0.5 的差异**（门槛未动，变的是语料、可测集合，以及一处结论翻转）：

① **语料 12 条 / 27 点 → 44 条 / 73 点，含 32 条真实人声**，使 `sampleSizeCaveat` 由 `true` **翻转**为 `false`
（32 ≥ 20）；但 32 条**全是读语音频**，故「充分」只对**端点判定**口径成立，改变请求/打断口径仍不足；
② **组 C 由 `blocked-by-license` 翻转为 `measured`**——一手条款允许 LiveKit Agents **框架内**使用，本任务在
sandbox venv 内跑出真实读数（65 点）；这是 P0.6 **最重要的结论变更**（P0.5 的授权阻塞判定被实质性推翻）；
③ **AC3 编译前端**把组 B 的 JS 朴素 DFT（warm p50 **120.819 ms**）替换为编译 C 前端（**24.737 ms**，**4.9×**，
三路数值等价 withinTolerance），使组 B **具备 PASS 条件**（投影 ~68 ms）——但本任务**未把编译前端接入组 B
决策回路**，端到端判定维持 **FAIL**；
④ **非实时 qwen 探针在真实人声上重测**（AC5），auto/forced 均未在读语音频上触发调用，**累计新增付费 ¥0.025232**
（与 P0/P0.5 的 ¥0.021549 **分账**）；
⑤ MaAI / Vogent / DualTurn **按任务边界不解禁、不重测**，结论原样保留。

以上变的是**分母、可测集合与组 C 的授权判定**，**不改变任何已写死的门槛数值**。

> ⚠️ P0.6 列里的**延迟 / CPU / RSS** 是**单次运行读数**（该次运行的 `ranAt` 时间戳见 `RESULT.json`）；毫秒级与百分点级的
> 运行间抖动属正常，但都离门槛很远（组 C p90 ≈13 ms ≪ 150、组 B p90 ≈169 ms ≫ 150），**判定不因抖动改判**。本表引用的是
> artifact 的**最近一次**完整运行 `node scripts/voice-turn-detection-compare.mjs` 的读数，与 `RESULT.json.goNoGo` 逐格一致。

#### P0.7 统一 replay 基准（`gap-voice-turn-detection-p0-7-unified-realtime-benchmark`，2026-10-11）

上面的 **P0 / P0.5 / P0.6 三列全部是「旧口径」**：每组用**自己**的判定规则给出**一个**操作点，读数定义同源但
操作点不同源。**这三列原样保留——一列不删、一个数不改、判据门槛不动**。P0.7 不新增列去覆盖它们，而是把四个组
放到**同一套 eot-bench 评分/sweep 代码、同一张 `threshold × action_delay × timeout` 网格、同一份
44 样本 / 73 候选点 manifest** 上，另产出一组**共同操作点**读数，与旧口径列**并列存在、不互相替换**。
下表是 P0.7 的统一基准读数（`RESULT.json → unifiedReplay`；组字母 A=StreamingVad、B=Smart Turn、C=LiveKit v1-mini、
**D=Qwen Realtime**）。`bestAtBudget` 的定义：在 `cutoffRate ≤ budget` 的行里取 `meanLatencySeconds` 最小者
（eot-bench 的 `operatingPointAtBudget`，budget ∈ {0.02, 0.05, 0.10}）；`n` 为该行自己的分母。

| 组 | 最优操作点 @0.02 | @0.05 | @0.10 | 前沿点数 |
|---|---|---|---|---|
| **A** StreamingVad | `{available:false}` | `{available:false}` | th 0.01 / delay 0.7 / timeout 1.5 ⇒ 误截断 **0.0690**(29)、漏端点 **0.0227**(44)、延迟 **0.4955 s**、F1 **0.9663** | 7 |
| **B** Smart Turn | th 0.99 / delay 0.2 / timeout 1.5 ⇒ 误截断 **0**(29)、漏端点 **0.9773**(44)、延迟 **1.4705 s**、F1 **0.0444** | 同 @0.02 | 同 @0.02 | 8 |
| **C** LiveKit v1-mini | th 0.79 / delay 0.5 / timeout 1.5 ⇒ 误截断 **0**(29)、漏端点 **0.8409**(44)、延迟 **1.3295 s**、F1 **0.2745** | th 0.76 / delay 1.0 / timeout 1.5 ⇒ 误截断 **0.0345**(29)、漏端点 **0.8182**(44)、延迟 **1.2955 s**、F1 **0.3019** | th 0.75 / delay 1.0 / timeout 1.5 ⇒ 误截断 **0.0690**(29)、漏端点 **0.7955**(44)、延迟 **1.2614 s**、F1 **0.3273** | 10 |
| **D** Qwen Realtime @400 ms | th 0.01 / delay 0.7 / timeout 1.5 ⇒ 误截断 **0**(6)、漏端点 **0.1667**(6)、延迟 **0.7333 s**、F1 **0.9091** | 同 @0.02 | 同 @0.02 | 6 |
| **D** Qwen Realtime @800 ms | th 0.01 / delay 0.2 / timeout 1.5 ⇒ 误截断 **0**(6)、漏端点 **0.3333**(6)、延迟 **1.1833 s**、F1 **0.8000** | 同 @0.02 | 同 @0.02 | 6 |

**这一列告诉我们什么（不覆盖旧口径判定）**：

- **组 D（Qwen Realtime）在统一基准下三个 budget 都有可用操作点**，且是**非退化**的——@400 ms 延迟 **0.7333 s**、
  F1 **0.9091**，@800 ms 延迟 **1.1833 s**、F1 **0.8000**。这是本任务**第一次**把 D 放到与 A/B/C 相同的
  评分代码与网格上得到的读数，**不是**旧口径的单样本对照，也**不是**新旧数据拼表。
- **组 A 只在 0.10 才有点**：silence-threshold VAD 的评分是**阶跃**而非曲线，`thresholdAxisDegenerate:true`
  ——(0,1] 内每个阈值读到的触发时刻相同，故只有 0.10 一档能容纳它那唯一的 0.0690 误截断。
- **组 B 的可用点漏端点 0.9773 ⇒ 它基本不判 END**：这条与旧口径「不判 END 的检测器误截断必然少」的观察一致，
  只是这次由同一条策略式在**同网格**上扫出，两组数字可直接比。
- **阈值轴的退化是记录在案的**：A 与 D 均 `thresholdAxisDegenerate:true`（阶跃 VAD），B/C 为曲线（false）——
  因此跨组的 `threshold` 数值**不可**当作同一把尺子横向比，可比的是**操作点**与**预算内延迟**。

**四组的模拟 action-commit（同一反事实策略「END ⇒ action」，`actionCommit.simulated`）**：
A **11/29**(0.3793)、B **24/29**(0.8276)、C **21/29**(0.7241)、**D @400 1/6**(0.1667)、**D @800 0/6**(0)，
纠错点 4 组同口径。**真实的**函数调用读数（组 D）**引用** P0.6 的 `qwenProbeRealAudio`（`reusedFromP06:true`，
spurious **0**），不重复花钱；模拟与真实**分开标注**。

**准入子集（AC1）与预算（AC8）**：`corpus.eligibility` = **73/73 可入、0 排除**，按取得方式
`{committed-fixture:19, derived-in-memory:8, fetch-script+pinned-sha256:46}`，真实录音按许可证
`{CC-BY-4.0:21, Apache-2.0:25}`——谓词**真的逐条查**可再现性与许可，被排除集合为空是**查过**的结果。
组 D 的会话预算上限 **¥0.05** 在**开第一个 socket 之前**写入 `qwenStreaming.budget`（最坏上界 **¥0.033054**，
`guardPassed:true`）；实测新增 **¥0**（每会话 `create_response:false`，上游不产生 usage），**独立成账**，
不与 P0.6 的 ¥0.025232 相加。

**协议再核实（AC2）**：`protocol.reverification` 记明 harness **Apache-2.0**、数据集 **CC-BY-4.0**、
数据 revision `ca9d98a9…`（`datasetRows:5454`）三项**与既有 pin 一致**，并给出**依赖 vs 复刻**的决定
「**REPLICATE** 评分/sweep 语义」及其理由（语料 schema 不匹配 + 本 SPEC 的「不新增集成路径」边界）。

**一致性抽查（AC3）**：统一适配器与 P0.6 读数逐点对照——**B 73 点 identical**（`maxAbsDiff 4.86e-7`，
同一 ONNX 会话代码 + 同一前缀）；**C 65 点 `decisionEquivalent:true`**（`maxAbsDiff 1.7e-5`，比 0.01 扫描网格低一个量级
⇒ 无操作点会因此移动）；**A 73 点 `agreement 0.9863`**（1 处 = commit 边界 ±1 帧，非换检测器）。
⇒ 统一层**没有**改变任何一组的输入。

⚠️ **同基准的覆盖边界（必须与上面数字同读）**：批量组 A/B/C 在全部 **73** 点上打分，组 D 只在**分层的 12 个点**
（6 `eot` + 6 `hold`，`silence_duration_ms` 两档 = 24 个独立会话）上打分，因为每个候选点是一次真实上游会话。
因此 D 与 A/B/C 的**同名比率不同 n**（`coverage.caveat` 逐行标注，`metrics.coverage.qwenStreamingDistinctSpans:12`），
**不得**当同精度并排。组 D 的 24 个会话中 **11 个超时**（@400 ok 8 / timeout 4；@800 ok 5 / timeout 7，**error 0**）——
超时与显式错误是**两个不同状态**（`runs[].status`），且超时不含 `userWaitEndpointMs`/`modelOverheadMs`（记 `null`），
不伪造端点延迟。会话级读数是**单次运行**读数（`ranAt` 见 artifact），上游实时端点逐会话有抖动（如
`zh-d01-o85#0 @400` 一次 `overhead 13612 ms` 属上游异常慢响应），P0.7 的结论因此只到「D 在统一基准下有可用操作点」，
不把单次数值当稳定常量。

---

## 分期

| 期 | 内容 | 退出条件 |
|---|---|---|
| **P0** | 标注样本 manifest；组 A/B 本地 harness 与实测读数；组 C 的许可证/输入规格核实 + 尝试本地 harness（若受阻，记录阻塞原因）；组 D 读既有任务产出或标 `pending`；组 E 可选；非实时 qwen 可行性探针（≤¥0.02）；状态机设计章节 | 本 SPEC 的 Go/No-Go 表全部填入真实数字或显式局限说明 |
| **P0.5**（本任务 `gap-voice-turn-detection-p0-5-expansion`） | Smart Turn 开销根因（官方预处理对照 + warm/cold 拆分）；语料扩到 12 条/27 点（含自我纠正/中英混合/句中停顿，三态标注）；新候选 MaAI/Vogent/DualTurn 的许可证与成本核实；LiveKit 条款二次复核并升级为「已设计、授权阻塞」正式对照组；非实时 qwen 探针重设计为批量矩阵（≤¥0.03）；状态机反例测试；Go/No-Go 重算（门槛不放宽） | 四条新读数并入 Go/No-Go 表且每格有实测或显式局限；新候选各有许可证原文结论；非实时 qwen 能区分四种情形；生产面零改动 |
| **P0.6**（本任务 `gap-voice-turn-detection-p0-6-dataset-benchmark`） | 语料再扩到 44 条/73 点（含 **32 条真实人声**，逐条记来源/许可证/说话人/采样率/格式/时间戳/文本）；**编译 C 前端**替换组 B 的 JS 朴素 DFT 并做**三路数值等价**（AC3）；LiveKit **框架内**实测（重新核实一手条款 + sandbox 隔离机械证据，AC4）；非实时 qwen 在**真实人声**上重测 auto/forced（AC5，新增付费 ≤¥0.05 独立成账）；Wilson 区间 + 跨数据集不可比 caveat + 各模型采样率/窗口/前端协议复核（AC6）；Go/No-Go 表并入 P0.6 列（门槛不放宽，AC7）；生产面零改动（AC8） | Go/No-Go 表新增 P0.6 列且每格有实测或显式局限；组 B 前端延迟根因被编译路径实测替代；组 C 由授权阻塞翻转为实测；真实人声新增付费累计 ≤¥0.05；`npm run typecheck` exit 0 |
| **P0.7**（本任务 `gap-voice-turn-detection-p0-7-unified-realtime-benchmark`） | 把 A/B/C/D **四组放到同一套 eot-bench 评分/sweep 代码 + 同一张 73 点 manifest** 上：AC3 统一批量适配器（VAD / 编译版 Smart Turn / LiveKit v1-mini 走**一条**代码路径 + 对 P0.6 逐点抽查）；AC4 Qwen Realtime **流式**适配器（真实 DashScope WS、每候选点一个独立会话、**完整事件时间轴**、拆「模型推理耗时」vs「用户等待端点时长」、超时与显式错误分状态）；AC5 阈值-延迟 Pareto；AC6 假执行模拟四组 + 复用真实函调；AC7 带分母/CI/caveat 的指标；AC8 预算 ≤¥0.05 **写前**守门且**独立成账**；AC9 统一读数并入 SPEC 且**历史行标旧口径保留**；AC10 生产零改动；AC11 静态门 | 四组同基准读数并入 SPEC 且每格有实测/显式局限；**组 D 首次在同一 manifest 上有读数**；历史 P0/P0.5/P0.6 列标注旧口径且一列不删；门槛不放宽；`npm run typecheck` exit 0 |
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
   "standalone basis" 上 ⇒ 组 C 判 `blocked-by-license`（G7 行有原文引用）。**P0.6 修正**：条款 **Section 3.b(i)** 禁止的是
   *standalone* 使用，**在 LiveKit Agents 框架内**使用**被许可** ⇒ 组 C 由 `blocked-by-license` **翻转为 `measured`**（在
   sandbox venv 内以 `livekit-agents` 跑出真实读数，见 Go/No-Go 表与 `RESULT.json.groupC.licenceReverification`）。
   「是否入库为生产依赖」仍是产品/法务决定，但**本任务内的框架内评测已是合规的**。
2. ~~LiveKit v1-mini 确切输入张量/窗口规格（G8）~~ —— **P0 已关闭（结论是「公开来源不可复现」）**：只有
   `DEFAULT_SAMPLE_RATE=16000` / `MIN_SILENCE_DURATION_MS=200` / 1.2 s 缓冲是公开的，特征配方在私有构建的
   native 包之后（G8 行有来源）。这是一个**已核实的限制**，不是未完成的阅读；P0.6 在框架内直接调用 `inference.TurnDetector`
   绕过了对配方的手工复现（协议见 `RESULT.json.modelProtocolReview` 第 C 行）。
3. v1-mini 在中英混杂、代码术语场景下的精度是否同等于 v1 全量模型（未找到公开数字，需自测）。
4. 预热推理是否存在「不消费即丢弃」的免费路径（决定 COMMIT_GRACE 期间能否真正做到「投机但零成本」）。
