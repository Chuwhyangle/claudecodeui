# P0.10 Live Voice 分割安全性（B0–B4）——结论

**任务**：`gap-voice-turn-detection-p0-10-closing-safety-b0-b4`
**artifact**：`RESULT.json`（本目录；四段 B0/B1/B2/B3 各自带 `schema` 与 `budget`）
**口径**：全部动作 mock/dry-run，无真实副作用。**B4 未做**（本任务范围外，见 §5）。

---

## 0. 一句话结论

用户真正关心的不是 500 ms 级 EOT，而是**分割错误造成的真实语义损失，以及它能否被恢复**。四个阶段的机械证据给出一个一致的答复：**缩短等待确实制造分割错误（B2），但这批语料上没有出现最危险的“把被取代的指令送进 agent”——真正危险的那一类在 `T≤500 ms` 才开始出现，且本语料里是 clause/durational 级、不是 retraction 级（B2）；而一旦允许一个 grace 窗口，这类错误在版本化作废 + Action Commit Gate 下可 100% 恢复（B3）。B1 修正后的评分显示：把「中继逐字转发」判成错，是评分规则的错误、不是中继的错误。**

诚实边界：**B0 的真实付费测量跑了（网络稳定、7/7 warm），三个事件时间戳齐备，但 `T_safe` 没能被可靠钉死到一个单点**（§4）——保守读法是「必须 > 2000 ms」。不编造单点数字。

---

## 1. B1 —— P0.8 重新评分（零成本，只读 P0.8）

- **只读**：读 `paired-pilot/RESULT.json` + `samples.json`，**未覆盖/未删除** P0.8 原文件；结果写入本目录的 `RESULT.json` 的 `b1` 段。自检 `allRowsReproduce: true`（我们复现的出 P0.8 原判分与它自己记录的一致）。
- **规则修正（D4 依据）**：`docs/proposals/voice-realtime-segmented-relay-SPEC.md` 的中继**不解析、不决策、只逐字转发**，解析在下游。原规则的「禁用词」把中继在做它**本不该做**的事上扣分。
  - `complete` = 命中全部 intent group（禁用词不再一票否决）；`safe` = 没有**只**指向未纠正目标而不带上已纠正目标的调用；`spurious := unsafe`；`unscorable := 调用了但没有可用 message`。
  - 保留为真实 miss：**s6**（连续指令里只转发了两个动作中的一个）——不是评分假象。
- **修正后分数**：

  | 链路 | 原始 | complete | complete∪ | safe | spurious | missed | unscorable |
  |---|---|---|---|---|---|---|---|
  | A（Realtime 直连中继） | 0.1429 | 0.3333 (2/6) | 0.5 (3/6) | 0.8333 (5/6) | 0.1667 | 0 | 1 |
  | B（VAD + 非 realtime Omni，声明 700 ms） | 0.8571 | 1.0 (7/7) | 1.0 | 1.0 | 0 | 0 | 0 |

  - **A 的具体变化**：`s4-self-correction` 由 spurious → 正确——中继逐字保留了「改一下 voiceService.ts，嗯不对，应该是 voiceRoutes.ts。」，这正是 D4 要求的行为，**不能判错**。
  - A 相对 B 的真正缺口：`complete`（单次调用完整覆盖全部 intent）0.33 vs 1.0，`unscorable` 1（s1，见下）；`safe` 已接近 B（0.83 vs 1.0）。**「完整语义等价」A 明显弱于 B；「安全工具载荷等价」A 已接近 B**——两个口径给出的 A/B 比较不同，必须分别陈述。
- **s1 截断根因（代码级证据，不是从 JSON 形状猜）**：
  `qwen-realtime-streaming-adapter.mts` 的 wire observer 对函数调用参数**只**取 `.done.arguments` **原样**（`wire.arguments ?? null`），`response.function_call_arguments.delta` 落进 `default: break`（从未拼接）；`voice-realtime-dashscope-transport.ts` 把 `.done.arguments` 直通；`voice-realtime-bridge.service.ts` 把 `...delta` 列在 `TOLERATED_ENDPOINT_EVENTS` 里**有意忽略**增量半边。
  即：**没有任何本地截断点**——`.done` 帧里的前缀本身就是**上游发出**的，而 harness **丢弃了那次运行的 5 个 delta 分片与 output_item 载体**，所以残缺**无法本地重建**。（诚实限制：delta 载荷未持久化，完整重建不可证。）
  结论：**上游起源的截断，被一个丢弃 delta 流的 harness 不可恢复地保留下来的形状**；不是 harness 累积 bug（它根本没累积）。

---

## 2. B2 —— 离线缩短回放（零成本，真实重放不插值）

- 语料：**28 samples / 51 scorable spans（23 hold / 28 eot）+ 1 CORRECTION**，真实 PCM（LibriSpeech/THCHS-30），用**出货的** `StreamingVad`+`thresholdsFor`（`src/shared/voiceEndpoint.ts`，即中继自己的模块）在四档等待离线 **re-decode**。
- **交叉校验**：与 P0.9 已提交的 Stage 1 逐点读数在重叠两档（500/1500 ms）上 **102/102 完全一致**——扫描就是出货规则，不是新写的一套。

| 等待 | 误切 (hold) | 漏端 (eot) | 语义损失质量 | 相对基线**新增**误切 | 损失类别 |
|---|---|---|---|---|---|
| 1500 ms（基线） | 0/23 | 8/28 | 8 | — | 仅 `turn-not-closed`×8 |
| 1000 ms | 2/23 | 4/28 | 6 | 2 | +`durational-split`×2 |
| **700 ms** | 2/23 | 2/28 | **4（最低）** | 2 | +`durational-split`×2 |
| 500 ms | 7/23 | 1/28 | **12** | 7 | `clause-split`×4、`durational-split`×3 |

- **逐例记录**（不只通过率）：每例每档记录 `fireMs / falseCutoff / lossClass / newVsBaseline`（`RESULT.json.b2.perSpan`）。损失按**切在哪里**分类：`retraction-split`(3) > `identifier-split`(3) > `clause-split`(2) > `durational-split`(1)。
- 读法：缩短是**权衡**——越短越少漏端、越多误切。**700 ms 是这批语料的最优操作点**（损失质量最低）；**500 ms 出现悬崖**（损失质量翻三倍，新增 7 例误切，绝大多数是 mid-sentence-pause 被切）。
- **诚实修正（重要）**：本语料上 `retraction-split`/`identifier-split`（最危险的两类，即“把纠正前的话当成完整指令提交”“把英文标识符劈开”）**在四档等待下从未真正触发**——1 个 self-correction 与 4 个 code-mix 的停顿都没短到被切。真正被触发的是 clause/durational 级。这条**不被 B3 的构造场景替代**：它说明真实语料里最危险的类别需要更短的等待才会出现，本任务无法用现有录音把那条路径打出来。
- 1500 ms 的 8 例漏端中有一部分是**协议地平线效应**：`causalGrid` 的静音上限就是 1.5 s，等待 1500 ms 等于把 horizon 用满，边界样本（silence≈1502 ms）结构性测不到——这是“长等待漏端”成本的机制，不只是模型行为。

---

## 3. B3 —— 状态机与安全机制（零成本，真实运行的测试）

三机制，**9/9 测试真实通过**（`node_modules/.bin/tsx action-commit-gate.test.mts`）：

1. **AudioWindowMerger**：按**原始时间轴偏移**重拼窗口（顺序无关、幂等、混采样率直接报错），并保留 `concatenate()` 作**负对照**——测试证明两者**不同**（拼接会把后窗静默前移，破坏下游时间戳）。用例含一个非相邻切分，merged 逐样点等于未切分的原始流。
2. **VersionedToolCallGate**：调用携带其生成时的 `turnVersion`；版本不匹配在**到达时、版本推进时、finalize 时**三处都被作废，绝不盲目执行。
3. **Action Commit Gate**：副作用**只在 finalize** 释放，且**只**释放当前版本；`DryRunToolSink` 自己写 `deliveredToRealSession:false` 且**没有任何 transport**——「无副作用」是机械证据。

**恢复成功率（「后到纠正被正确作废、修正后的调用正确提交」）**：8 个构造场景（`grace∈{内,外}` × `late-stale∈{有,无}` × `gate∈{versioned,naive}`）

| | 版本化 gate | naive（到达即执行）对照 |
|---|---|---|
| 纠正落在 grace **内**（gate 能管） | **1.0（2/2）** | 0.0（0/2） |
| 纠正落在 grace **外**（结构性不可恢复） | 0.0 | 0.0 |

- **1.0** 是 AC3 要的具体数字：`proposed`（30 s）从未进 sink，`corrected`（20 s）正确提交；晚到的重复 stale 调用也被按版本作废，无法破坏。
- **0.0 的 naive 对照**是关键：证明是 gate 在干活，不是场景本身宽松。
- **grace 外 = 结构性上限，单独报告、不并入 gate 的分数**：副作用已释放，任何 commit gate 都无法“反释放”。这是有限宽 grace 窗口无法消除的残余成本——**诚实的边界，不是 gate 失败**。

---

## 4. B0 —— 真实事件测量（小额付费）——**真跑了；三个事件时间戳齐备；`T_safe` 未被可靠钉死**

- 预算 **≤¥0.05 执行前写死**（`BUDGET_CNY=0.05`，由会话自身的 spend 钩子强制）；**实付 ¥0.002754**（远低于上限，`withinBudget: true`）。
- **网络稳定**：预检两次 WS 握手成功（543 ms / 456 ms）；真实阶梯里 **7/7 会话全部 warm**。故走的是 AC4 的**稳定分支**，执行了真实测量（T=500/1000/1500/2000/3000 + 边界重复各一次）。
- **仪器修复（相对首轮）**：首轮经共用流式适配器（其 `attributeEndpoint` 单候选归因对 A+B 结构性 `timeout`）失败；本轮改为**直连** `createDashscopeTransport + connect`（中继自身模块）+ 本文件自有 observer，自己数 `speech_stopped`——协议不变，只换读数方式。
- **三个事件的独立时间戳（AC4 要求）**：每一轮、每条轮次分别记录 turn-closing（`input_audio_buffer.speech_stopped`）、function-call generation（`response.function_call_arguments.done`）、tool commit（`response.done`）。三者**不是同一时刻**，按 turn 对齐记录在 `b0.threeEventEvidence`。例（T=1500，turn 0）：closing=`…228830`、generation=`…229264`、commit=`…229265`——closing 比 generation 早约 **434 ms**。**未用 `silence_duration_ms` 配置值顶替任何测量事件**。
- **原始读数**（`b0.readings`，均为真实收到的帧时间戳）：

  | T (ms) | 运行 | stops（轮次关闭） | 切分 | 备注 |
  |---|---|---|---|---|
  | 500 | 1 | 3 | 是 | 过分割最重 |
  | 1000 | 1 | 2 | 是 | |
  | 1500 | 1 | 1 | 否 | |
  | 2000 | 1 | 2 | 是 | |
  | 3000 | 1 | 0 | — | **会话截断**：仅 1×`speech_started` + 44 `transcription.delta`，无 `committed`/`stop`/`response` |
  | 2000 | 重复 | 2 | 是 | |
  | 1500 | 重复 | 2 | 是 | 与首次**矛盾**（run-to-run 方差） |

- **`T_safe` 结论（保守，不硬凑）**：**没有一档等待能可靠地避免切分**——T=1500 两次运行一次切一次不切；T≤2000 的每一档都至少切过一次；唯一在边界之上（T=3000）又发生**会话截断**（no-reading，不能读作“干净”）。故 `b0.tSafeMs = null`（未钉死单点），**保守读法：`T_safe` 必须 > 2000 ms**（`b0.conservativeTSafeMs` / `b0.summary`）。
- **必须披露的混淆（不是 bug）**：固定音频由**两段真实语料**拼成，各段自带首尾近静音，端点看到的**有效内部间隔 > 插入的 1500 ms**，故切分翻转点落在 1500 ms **之上**。这是真实音频的性质，如实记录（`b0.audioConfound`）。
- **P0.7 污染说明（按 AC5 携带，未稀释）**：P0.7 在 T=400/800 ms 测得 11/24 会话受污染（约 9 条真实网络异常、2 条测量假阴性、1 条长尾延迟 outlier）——**不覆盖本阶段 500–3000 ms 的阶梯**，故 B0 自跑新会话、**不引用 P0.7 交差**。B0 自身 1 条 no-reading（T=3000）如实计入 `b0.noReadingCount`/`derived.noReadingTs`。
- **判定**：B0 按 AC4 **稳定分支真实执行**，产出三个事件的独立时间戳证据 + 预算纪律（写死 ≤¥0.05、实付 ¥0.002754）；`T_safe` 以**保守下界（>2000 ms）**形式产出、如实标注 `reliable=false` 与原因，**未编造单点值、未做昂贵硬重跑**。读数/花费为运行原样；`derived`/`summary` 由已提交的判定器 `deriveTSafe` 计算（`--rederive`，零成本，不动原始读数）。

---

## 5. B4 —— 明确未做

B4（**扩大到更大样本**）**不在本任务范围内**：按任务体，B4 只在 B0–B3 产出小样本「go」结论后由人另立任务。本任务未尝试扩大样本；`RESULT.json` 与本文均不作 B4 结论。

---

## 6. 交叉要求：区分「模型是否理解/转写正确」与「下游 agent 最终执行了什么」

- B1 的 `message` 判读 = **模型/中继输出层**（它转写/转发了什么，是否完整、是否安全）。
- B3 的 `DryRunToolSink` = **下游执行层**（如果有 agent 消费了这个工具调用，它会被执行成什么）。二者在 `RESULT.json` 里是不同字段、不同 sink，从不混为一谈。
- 本任务所有「执行」都是 dry-run：`deliveredToRealSession:false`，无 transport，**未投递给任何真实 Claude Code 会话**（AC7 的机械证据）。

---

## 7. 阶段执行台账（哪些真跑、哪些没跑）

| 阶段 | 状态 | 真实运行物 | 花费 |
|---|---|---|---|
| B1 重新评分 | ✅ 真跑 | `rescore-p0.8.mts` → `RESULT.json.b1`（P0.8 只读、未被覆盖） | ¥0 |
| B2 离线重塑回放 | ✅ 真跑 | `offline-shortened-replay.mts` → `b2`；P0.9 交叉校验 102/102 | ¥0 |
| B3 安全机制 | ✅ 真跑 | `action-commit-gate.mts` + `.test.mts`（9/9 通过）→ `b3` | ¥0 |
| B0 真实测量 | ✅ 真跑（直连）、`T_safe` 保守下界 | `t-safe-probe.mts` → `b0`（7/7 warm 真实会话 + 三个事件独立时间戳） | **¥0.002754 / ¥0.05** |
| B4 扩样本 | ⛔ 未做（范围外） | — | ¥0 |
