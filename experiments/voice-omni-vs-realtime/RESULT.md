# 非 realtime omni flash 能否接近 realtime relay：真实 live voice 音频上的消融

日期：2026-10-22。预注册：`PREREG.md`（取数前写定）。原始读数：`out/results.jsonl`、`out/results-low.jsonl`（`out/` 被根 `.gitignore` 忽略；含用户语音文本，不入库）。

## 一句话

**能，而且差距主要不在「realtime vs 非 realtime」，在「有没有把同一份 C2 上下文放进 system instructions」和「用的是 relay prompt 还是书面化指令 prompt」。** 在 7 条边界干净的真人 live voice utterance 上，非 realtime `qwen3.8-omni-flash` + 同一份 C2 pack + relay 风格 prompt（N1）**7/7 语义等价于当时 realtime relay 的 delivered message**；无上下文的 N0 只有 4/7，且失分正好集中在 live voice 最值钱的指代/术语上。

## 数据与对账

8 条真实 utterance（5 个 connection，2026-10-21 ~ 10-22）。音频从 `~/.cloudcli/voice-realtime-capture/*.wav` 按 timeline 切出；上下文按浏览器 `buildVoiceContextPack` 的同一规则重建，并与 proxy journal 的 `context received chars=/rows=` **逐条精确相等**（8/8），不是近似上下文。R 是当时真正 delivered 的 `session_send.message`，不是人工真值。

## 主读数（人读，2 = 同义/同指令；1 = 部分/可恢复；0 = 误导或换内容）

| # | item（现象） | R（realtime） | N0 无上下文 | **N1 正确上下文** | N1-wrong 错误上下文 | N2 出货书面化 prompt | T 两阶段替换表 |
|---|---|---|---|---|---|---|---|
| 1 | architecture tab（R 把「RTX TM 这个图」改成 architecture tab） | architecture tab | 0/1（`architecture type`，一次整句幻觉） | **2**（architecture tab 架构图） | 1（`architecture type`） | 1（`architecture type` / 加「需要区分」） | 0/1（继承 N0） |
| 2 | live voice 测试（R 把「外界测试」改成 live voice） | live voice 测试 | 1（`our voice`） | **2**（live voice 测试） | 0（「暂时进行…」无关） | 1（`voice` 测试） | **2**（our voice → live voice） |
| 3 | Live Voice 术语（R 把「Live模式下」改成 Live Voice） | Live Voice | 1（`Larval`/`Larvas`） | **2**（逐字一致） | — | 1（`lavos` / 改写） | 1（无法修 Larval） |
| 4 | 长句标点 | — | **2** | **2** | — | 0（返回 raw JSON） | **2** |
| 5 | 补主语「你」 | — | **2** | **2** | — | **2** | **2** |
| 6 | commit、build | — | **2** | **2** | — | **2** | **2** |
| 7 | Live Voice 大小写 | — | **2** | **2** | — | **2** | **2** |
| 8 | 长句 + 相邻下一句（边界污染，见下） | — | 1 | 1 | — | 1/0 | 1 |

**干净子集（1–7）：N1 7/7，N0 4/7，N2 3/7，T 5/7，N1-wrong 0/2（两条指代类）。**

逐字差异（都是语义等价，但说明「接近」不是「逐字相同」）：

- N1 会把 `architecture tab` 说成 `architecture tab 架构图`，把 R 的「层级」说成「继承关系」；ASR 原词是「集成」，N1 的「继承」更贴音频。
- N1 会在 `live voice 测试` 前多一个「好」。
- N1 保留 `Live Voice` 的大小写，R 小写成 `live voice`。
- 标点/空格不同；N1 有时用「，」而不是 R 的「、」。

## 负对照：上下文真的是承重的

- **architecture 条目 + live-voice 的上下文** → `architecture type`，没有修回 `tab`。
- **live-voice 条目 + architecture 的上下文** → 「好，暂时进行。我稍后测试一下。」，与 R/ASR 都无关。

所以 N1 的修回不是模型自己「猜对了」，而是正确上下文给出的；错上下文会把结果带到更差的地方。这条与 A2 的「上下文会泄漏/竞争者替换」方向一致：**上下文必须是对的，而且要有护栏**。

## reasoning effort 不是杠杆

探索臂 `out/results-low.jsonl`（3 条指代/术语 × N0/N1 × `reasoning_effort=low`，不进预注册判定）：

- N0-low 仍然听成 `architecture type`、`architecture diagram`、`我们的测试`、`lavos` —— 加推理没有补回上下文。
- N1-low 仍然修回 `architecture tab`、`live voice`，与 N1（`none`）一致。
- N1（`none`）反而更快：p50 1.8s / p90 4.3s；N0（`none`）p50 2.0s / p90 5.3s（一次 28.2s 离群）；N2 p50 5.3s / p90 8.3s（一次 24.5s）；T p50 0.6s / p90 1.4s。

结论：**先把上下文接进去，不要先加推理预算。**

## 两个 prompt 的差别（这是最容易走错的地方）

- **N1 用的 relay prompt**：只整理、修明显听错、接碎句、不转述、不加内容、只输出文字。它与 live voice relay 的指令同义。
- **N2 是出货 `dashscope-omni` 的 E 组 prompt**：把口述改写成「给编码 agent 的书面指令」。它会把「看不出层级」改写成「请修改箭头的样式…」、把陈述改成命令，还会在语音里带引号时产出非法 JSON（`"当前这一份"` 未转义），适配器降级后把**整个 JSON 信封**当转写返回。它不适合听写；这不是 transport 的问题，是 prompt/产品行为的问题。

**要复用 live voice 的识别效果，不能只把 provider 切到 `dashscope-omni`；必须用 relay 风格的 prompt + 上下文。**

## 两阶段替换表（T）的边界

T 只从 N0 文本里改「可机械校验」的替换：

- 成功：`our voice → live voice`（上下文里有 `live voice`，编辑距离通过）。
- 失败：`Larval/Larvas → Live Voice`（编辑距离 > 0.5，被拒）；`architecture type → architecture tab`（同样被拒）；`阿K → AK`、把「继承关系」改成「透传关系」等上下文诱导的替换也被拒。
- 它拒绝的替换里有不少是**有害的**（例如把 `当前这一份` 改成 `本轮 run 开始之后到达`），说明机械护栏是必要的；但它不能替代上下文，修不了本实验最关键的指代/术语错误。

## 边界与局限（必须带着读）

1. **n=8，2 次/格，单模型。** 只报方向与逐条差异，不做显著性；不外推到全部口述。
2. **R 不是 ground truth。** R 自己会换词（`RTX TM` → `architecture tab`）、补主语、改标点；本实验比较的是「像不像当时 realtime 的产出」，不是「绝对正确」。
3. **第 8 条（long-driving）边界污染。** 该段的 `speech_stopped` 落在下一句「在办公室的时候」的起音之后；切出的音频确实包含下一句的开头，N0/N1/N2 都把它写了出来，而 R 的分段没有。这更像「VAD/committed 边界与真实句界不一致」的读数，不是模型幻觉。该条**不计入干净子集的 7/7**。
4. **第 1 条的音频切段也可能截尾。** timeline 的 `speech_stopped` 在 10.96s，而音频能量显示语音持续到约 13.3s；切段在 11.46s 结束。N1 仍从上下文/音频里恢复了 `architecture tab` 与后半句，但「逐字对齐」不应被过度解读。要做严格音频基准，需要按端点实际 buffer 或强制对齐重切。
5. **上下文重建已与 journal 的 chars/rows 对账**，但 journal 不保存 pack 正文；同一 session 后续消息会改变 history。本实验用的是取数时的 history dump。
6. **音频是桌面/手机的真实录音**，不是 TTS；但没有覆盖强噪声、远场、多人说话。

## 对工程的直接含义

这次结果支持一条**比 realtime dictation 小得多**的路：

1. **保持 one-shot 管线，不新建 realtime 连接。** 在 `transcribeVoice` / `/api/voice/transcribe` 上把 C2 pack 作为 `hints.context` 传下去；服务端把它放进 system instructions（与 live voice 的注入方式一致），不是放在 user turn 的音频旁边。
2. **新增/参数化一个 relay 风格的 provider 模式**，声明 `honors.context: true`、`style: 'written'`（transformations 记 `punctuate`/`de-disfluency`/`self-correction-applied`），prompt 用「只整理、不转述、不加内容」。**不要复用 E 组书面化 prompt。**
3. **客户端复用 `buildVoiceContextPack`**：它已经在 live voice 里；voice input 只需要在 listen 开始时按当前 session 的可见消息建一次 pack。新 session/无 session 时不带上下文，退回 N0/本地。
4. **默认仍是本地 SenseVoice**（快、隐私、置信度）；云端 relay 作为按用户选择的「高质量」模式，或对长/指代多的 listen 自动建议。实验里 N1 的 p50 1.8s / p90 4.3s，比本地慢但可接受；要设 8–10s 超时并回退。
5. **加内容护栏**：同一次调用让模型返回 `{text, transcript}`，或并用一份无上下文转写；若 `text` 出现 `transcript` 里没有的实质从句，回退到 transcript/T。第 8 条说明边界/续写是真实风险，不能只看「语义像」。
6. **T 保留为纠错层**，不承担主识别；它的价值是机械拒绝有害替换，而不是补回上下文。
7. **PTT 可以共用这个 sink**：按住说话、松开走同一条 one-shot relay；不需要第三个模式。

## 下一步（建议，不自动执行）

- 用端点实际 buffer 或强制对齐重切第 1/8 条，去掉边界污染后重跑更大样本（≥30 条，含噪声/远场）。
- 测「短上下文」（只取最近 3 行 / ≤600 字）能否保住指代修回，同时把 p90 压到 3s 内。
- 在真实 voice input 里做 A/B：本地 SenseVoice vs 云端 relay（带上下文），读用户是否编辑、发送、以及「架构 tab / live voice」这类术语的命中率。

---

# 扩样复核（2026-10-22 下午）：端点 buffer 重切 + 30 条

## 结论先说

**原来的 7/7 没有复现成一般结论。** 按端点的实际 buffer 重切、并把样本扩到 30 条可听 utterance 后：

- **原 7 条在重切后的同一跑里是 6/7**（`6c76e1cf-0` 从 2 掉到 1：N1 多出了「六层出来的图片」，关键术语 `architecture tab` 仍然正确）。
- **30 条全体：N1 21/30（judge 2），7 条 1，2 条 0；N0 18/30（2），10 条 1，2 条 0**（`qwen3.8-flash` 严格 judge，rep0；rep1 N1 19/30）。
- **干净子集（19 条：RMS≥800、无相邻语音、R 可用）：N1 16/19，N0 13/19**。
- **上下文的作用仍然成立**：N1 在 3/4 的指代/术语上修对（`architecture tab`、`live voice` ×2），N0 是 0/4；但 `pack` 仍被 N1 听成「派克」，说明上下文不是万能的。
- 因此「非 realtime omni + 上下文」能**改善**指代/术语，但**不能逐句等价** realtime relay；它需要 verbatim/内容护栏，或只在短、清晰、指代多的听写上使用。

## 怎么重切

- **端点 buffer**：`start = speech_started - 300ms`（端点的 `prefix_padding_ms=300`，见 `server/.../tests/fixtures/run-*.json` 的 `turn_detection`），`end = input_audio_buffer.committed`（不是 `speech_stopped`）。
- **音频能量**：对每条切出的 WAV 算 RMS/peak；`262537d7` 的若干段是静音/低能量（RMS 4–30，peak <600），模型在没听到音频时回退到上下文/任务文本，**不能算样本**，已替换为 `b8360029-3/4`。
- **上下文**：每条连接仍按浏览器 `buildVoiceContextPack` 重建，并与 journal 的 chars/rows 对账；30 条全部精确相等（`fixtures-30c.json`）。
- **R 的可用性**：`529f93f4-0` 的 R 是重复句；`b8360029-3/6` 的 R 本身是误听；`711e54cc-3` 的 R 被截断成「两」。这些在 clean 子集里排除，但在全 30 里保留并标注。

## 失败形态（N1 rep0 的 7 条 1）

| key | N1 的偏差 | 类型 |
|---|---|---|
| 262537d7-1 | 丢掉「我已经刷过了」 | 从句丢失（音频低能量，RMS 966） |
| 262537d7-2 | 丢掉首句、加上「在办公室的时候」 | 相邻句边界（下一句起音在 buffer 内） |
| 4eea7875-3 | 丢掉「你看上面」 | 从句丢失 |
| 6c76e1cf-0 | `architecture tab` 对，但多出「六层出来的图片」/「继承关系」 | 词级误听/增补 |
| 711e54cc-3 | 把 R 的截断「两」补成「两段」 | 判据/R 截断（人读可算 2） |
| b8360029-1 | 「是」→「如果是」 | 增加条件词 |
| b8360029-4 | 「还有个」→「我们平时呃，还有个」 | 增加从句 |
| b8360029-3/6 | 与 R 的误听互相不一致 | R 本身不可靠 |

**不是指代失分**：`architecture tab`、`live voice` 这两类上下文修复仍然成立；失分是**逐字保真/边界/低能量**。

## 对方案的含义（修正上一节）

1. **不要把「one-shot relay + 上下文」当成 realtime relay 的等价替代。** 它能修术指代，但 30 条里只有 ~2/3 达到「同义」；原 7/7 是干净子集的结果。
2. **内容护栏是必需的**：让模型同时返回 verbatim transcript，或用 N0/T 的逐字稿做对齐；出现 transcript 里没有的从句/词时回退。`262-1`、`4eea-3`、`6c76-0` 都是这类可被护栏抓住的失败。
3. **边界与能量是数据质量的一半**：端点的 `prefix_padding_ms=300` 和 `committed` 端点是可复现的，但相邻句的起音仍可能落在前一条 buffer；低能量段会让模型回退到上下文。生产上需要在 listen 开始时检查音频能量/SNR，低能量段提示重说或走本地。
4. **realtime 仍有价值**：它在长句/连续/边界模糊的场景下更保真；one-shot relay 更适合短、清晰、指代多的听写，或作为「草稿 + 确认」而不是静默替换。
5. **`pack` → 「派克」是一个未解决的术语失败**：上下文里有 `pack`，N1 仍按读音写成中文。需要 term-level 的 verbatim guard/候选，而不是只靠上下文。

---

# Verbatim 内容护栏（2026-10-22 下午）

## 设计

对每条 N1 输出 T，取一份逐字稿 V，用字符级 `SequenceMatcher` 对齐：

- **纯删除**（V 有、T 没有）且 ≥2 字 → 把 V 的片段补回 T。
- **纯插入**（T 有、V 没有）且 ≥2 字、且不是上下文里的 Latin/数字术语 → 从 T 删除。
- **替换块**：
  - `guard`（保守）：保留 T，允许上下文改写/术语修复。
  - `guard-strict`（严格）：如果 T 侧不含 Latin 字母，且 V 侧更长（补回被丢内容）或 T 侧比 V 侧长 ≥2 字（去掉增补），用 V 替换；**任何含 Latin 的 T 片段一律保护**，这样 `architecture tab` / `live voice` / `Live Voice` 不会被字符对齐拆坏。

V 有两种：

1. **现实臂**：同一个 `qwen3.8-omni-flash` 用逐字 prompt 再听一遍（`verbatim30.jsonl`）。
2. **独立参照/上界**：当时 realtime endpoint 的 `transcription.completed`（fixture 的 `asr`）。生产里的对应物应是本地 SenseVoice 或其它独立 ASR。

## 读数（同一 `qwen3.8-flash` judge，30 条）

| 臂 | rep0 | rep1 |
|---|---|---|
| N1 无护栏（基线） | 21/30 | 19/30 |
| `guard`，同模型逐字稿 | 20/30 | 20/30 |
| `guard`，独立 ASR | 24/30 | 25/30 |
| `guard-strict`，同模型逐字稿 | 19/30 | 19/30 |
| **`guard-strict`，独立 ASR** | **25/30** | **27/30** |

**结论：护栏能不能把 21 拉回 25+，取决于逐字稿是否独立。**

- **同一个 omni 再听一遍没用**（19–20/30）：它的漏句、误听与 relay 输出高度相关，护栏看不到「两边都错」的差异。
- **独立 ASR 做逐字稿 + strict 护栏：25/30（rep0）、27/30（rep1）**，达到目标。它修回的主要是：`262537d7-1` 的「我已经刷过了」、`262537d7-2` 的首句/「在办公室」、`4eea7875-3` 的「你看上面」、`b8360029-4` 的「我们平时」、`b8360029-6` 的 R 误听。
- **Latin 保护是必须的**：没有它，字符对齐会把 `architecture tab` 拆成 `architectM`，把上下文修复本身弄坏。
- 仍然修不了的：`6c76e1cf-0` 的「集成 vs 层级」（独立 ASR 说「集成」，R 说「层级」——护栏选择了逐字侧）、`b8360029-1` 的「如果」（上下文里含「如果」，被误当成可保留插入）、`711e54cc-3` 的「两 vs 两段」（R 自己截断）。这些是**逐字参照与 R 的冲突/截断**，不是护栏逻辑失效。

## 生产含义

1. **不要用同一个 omni 做护栏的第二遍**；cost 多一倍，收益为负/零。
2. **用独立逐字源**：本地 SenseVoice（已有词级置信度）最合适；realtime endpoint 的 ASR 是上界。低置信/低能量段先提示重说。
3. **strict 护栏 + Latin 保护**是推荐版本：25–27/30，且不破坏 `architecture tab` / `live voice` 这类上下文修复。
4. 仍需 term-level 修复：`pack → 派克` 只有独立逐字稿说 `pack` 时才能被 strict 修复；如果独立源也听错，需要词表/音近候选（与 correction-feedback 的 D 臂同方向）。

---

# 人读偏好样本（2026-10-22，用户提供）

用户标了两个「差异较大的样本上较好的识别/改写」：

1. `6c76e1cf-0`：`现在可以看到 architecture tab 架构图了，但是有问题：是这里头所有节点都一样箭头，看不出继承关系。`
   - **只有 `N1-guard-strict`（同模型逐字稿 + strict 护栏）在 normalized 下匹配**（rep1 逐字；rep0 只差标点/空格）。
   - `N1` 多「六层出来的图片」；`N1-guard-oracle-strict` 把「继承关系/这里头所有节点」还原成 ASR 的「集成/这个图」，**比同模型 strict 更差**；R 的「层级」也不是人读偏好。
   - 这说明独立 ASR 不是无条件更好的参照：它自己误听「集成」时，strict 护栏会把更好的 relay 术语改回去。
2. `b8360029-5`：`丢词丢得太厉害。`
   - N1 和全部 guard 臂都匹配；R 的「丢失」反而是错的；N0「丢死/屌丝」错误。

**修正：R-match 不是人读质量。** 之前用 R 当 gold 的计数（N1 21/30、oracle-strict 25–27/30）低估了
同模型 strict 护栏；人读偏好下，同模型 strict 至少 +1（`6c76e1cf-0`），且独立 ASR strict 在该条上更差。
下一步应把这两条作为 few-shot，做 human-preference judge，而不是继续用 R 当唯一参照。

---

# Human-preference judge（2026-10-22 下午，两条人读 gold 作 few-shot）

## 读数

| 臂 | rep0 2/30 | rep1 2/30 | rep0 分布 |
|---|---|---|---|
| N0 | 18 | 19 | 18×2, 10×1, 2×0 |
| N1 | 21 | 20 | 21×2, 8×1, 1×0 |
| N1-guard | 21 | 20 | 21×2, 9×1 |
| N1-guard-oracle | 26 | 25 | 26×2, 4×1 |
| N1-guard-strict | 21 | 21 | 21×2, 9×1 |
| **N1-guard-oracle-strict** | **27** | **27** | **27×2, 3×1** |

- 人读 gold 两条都复现：`6c76e1cf-0` 只有 `N1-guard-strict` 是 2（同模型 strict），`oracle-strict` 1（把「继承关系」还原成 ASR 的「集成」）；`b8360029-5` 的 N1/全部 guard 是 2，N0 是 1/0。
- 所以 **oracle-strict 以 27/30 达到 25+ 目标**，但它在 `6c76` 这条上不是最好的；同模型 strict 在那条上更好。
- oracle-strict 剩下的 3 条 1：
  1. `6c76e1cf-0`：ASR 误听「集成」；同模型 Verb 的「继承关系/这里头所有节点」更好。
  2. `b8360029-1`：「如果」被上下文白名单误保留；收窄白名单到 Latin/数字可修。
  3. `b8360029-3`：R/ASR 本身在「走 vs 总是被」上不一致，属于参照噪声。

## 结论

- **目标达成**：N1 21/30 → `N1-guard-oracle-strict` **27/30**（人读偏好口径）。
- **护栏的收益来自独立 ASR 的内容覆盖**；**同模型 Verb 的领域术语**在 `6c76` 上更好。两者各有胜场。
- 下一步是一个 **两参照 hybrid**：用 ASR 做纯增删/内容覆盖，用同模型 Verb 修领域术语（当两者不一致且 Verb 更具体时），并把上下文白名单收窄到 Latin/数字。预计可到 28–29/30（只剩 `b836-3` 的参照噪声）。

---

# 两参照 hybrid 与 best-of-two（2026-10-22 晚）

## hybrid 的做法

- 先跑 A（独立 ASR）的内容护栏：补回 T 丢掉的内容、删掉 T 多出的非术语插入。
- 再跑 V（同模型逐字稿）的领域替换：当 V 与 A 不一致、且 V 不是功能词（如果/我们平时/…）时，用 V 的领域短语；V 与 A 一致时保留 T（例如 `丢词`）；A 含 Latin 术语而 T 是音译时用 A（`派克→pack`）。
- 若 V 与 A 的近同度 ≤0.3，保留 T（避免字符级对齐把 `丢词` 改成 `丢死`）。

## 读数（human-preference judge，30 条 × 2 reps）

| 臂 | rep0 | rep1 |
|---|---|---|
| `N1-guard-oracle-strict`（单参照独立 ASR） | 27/30 | 27/30 |
| `N1-guard-hybrid`（两参照） | 27/30 | 26/30 |
| **best-of-two**（每条取 oracle-strict 与同模型 strict 的较优者） | **28/30** | **28/30** |

- hybrid **没有超过** oracle-strict：它修回了 `6c76e1cf-0`（用 V 的「这里头所有节点/继承关系」）和 `b8360029-1`（A 删掉「如果」），但**丢了** `b8360029-6`（A 的内容修复）和 `bf517472-0`（A 的 `pack`→音译修复），净持平/略降。
- **两参照是互补的**：oracle-strict 赢 7 条（262-1/2、4eea-3、711e-1、b836-4、b836-6、bf517-0），同模型 strict 只赢 1 条（`6c76e1cf-0`）。
- best-of-two 的 28/30 还差 2 条：
  1. `b8360029-1`：两个 strict 都保留了「如果」；把上下文白名单收窄到 Latin/数字即可修（→29/30）。
  2. `b8360029-3`：R 的「总是被」与 ASR 的「走」本身不一致，属于参照噪声；没有可靠无监督修法。
- 因此实际可达的上界约为 **29/30**：以 oracle-strict 为 base + 上下文白名单修正 + 一条领域替换覆盖（`6c76` 模式）。单靠一个固定护栏无法同时拿到 29。

## 建议

- 若目标是 **≥25/30**：`N1-guard-oracle-strict` 已经达到（27/30），可以直接进入 one-shot relay 的实现评估。
- 若要 **28–29/30**：采用 **oracle-strict 为 base + 同模型 Verb 的领域替换 override + 收窄上下文白名单**；这需要一个小的选择规则/选择器（human-preference judge 的 few-shot 可作离线验证）。
- `b8360029-3` 这类 R/ASR 互不一致的样本不应计入质量目标；应作为「参照噪声」单列。

---

# 样本准备修正（2026-10-22，用户指出 b836 截断）

用户指出 `out/audio30c/b8360029-3.wav` 与 `out/audio30b/b8360029-6.wav` 明显被截断。审计确认：

- `b8360029-3` 与 `b8360029-4` 的端点边界只隔 3ms，能量连续，实际是一句话被 VAD 切成两段；`-3`/`-4` 都是残片。
- `b8360029-6` 的切点 57.619s 落在语音衰减里，源 WAV 到 68.34s。
- 另有 `6c76e1cf-0`、`711e54cc-1`、`4eea7875-3`、`e8df1709-0`、`529f93f4-0` 等切点仍在语音中，需要静音谷重切或排除。

**因此，之前 30 条的 human-preference 计数（oracle-strict 27/30）包含被截断/切碎的样本，不能作为最终数字。** 新的切法：静音谷边界 + 相邻段 SPLIT 检测 + 合并或排除；b836 整个会话从质量集移除，或由人重新标注。

详见 `out/SAMPLE-AUDIT.md`；修正后的两条在 `out/audio-fixed/`，N0/N1 输出在 `out/results-fixed.jsonl`。

---

# b8360029 整组移除（2026-10-22，用户裁定）

用户裁定：`b8360029` 是**低信噪比、非典型**的样本，整组不要用。已从 `fixtures-30c.json` 移除，生成 `fixtures-24.json`（24 条）。

## 剩余 24 条的 human-preference 计数

| 臂 | rep0 | rep1 |
|---|---|---|
| N0 | 17/24 | 17/24 |
| N1 | 19/24 | 18/24 |
| N1-guard（同模型逐字稿） | 19/24 | 18/24 |
| N1-guard-oracle（独立 ASR） | 23/24 | 22/24 |
| N1-guard-strict（同模型逐字稿） | 19/24 | 19/24 |
| **N1-guard-oracle-strict（独立 ASR + strict）** | **23/24** | **23/24** |
| N1-guard-hybrid（两参照） | 23/24 | 22/24 |
| **best-of-two（oracle-strict / 同模型 strict 取优）** | **24/24** | **24/24** |

- 唯一的 oracle-strict miss 是 `6c76e1cf-0`：ASR 自己误听「集成」，同模型 strict 的「继承关系/这里头所有节点」更好。
- 两参照在 24 条上互补：oracle-strict 赢 5 条（262-1/2、4eea-3、711e-1、bf517-0），同模型 strict 赢 1 条（6c76）；其余两边都是 2。
- 因此 **24/24 的上界**已经达到：oracle-strict 为 base + 一条领域术语 override 即可。之前 30 条的 27/30 作废，b836 既低 SNR 又把计数拖低。

## 注意

- 24 条里仍有几条切点被审计标记（`6c76e1cf-0`、`711e54cc-1`、`4eea7875-3`、`e8df1709-0`、`529f93f4-0` 等）；它们的边界还需静音谷重切/排除，计数可能再变。
- `b8360029-5` 的「丢词」gold 随组作废；`6c76e1cf-0` 的 gold 仍有效。
- 本轮 human judge 的 few-shot 里含 `b8360029-5`；对剩余 24 条的分数有轻微风格影响，若需要严格口径可用只含 `6c76` 的 prompt 重评。

---

# 边界重切的敏感性（2026-10-22 晚）

## 做了什么

对 b836 之外被审计标记的 8 条（`6c76-0/1`、`711e-0/1/4`、`4eea-3`、`e8df-0`、`acf7-0`）按静音谷/宽窗口重切，生成 `fixtures-clean.json`（23 条；529 因 R 重复句也移除）。重跑 N0/N1/Verb/guard 并用只含 `6c76` gold 的 human-preference prompt 重评。

## 读数（23 条 refined）

| 臂 | rep0 | rep1 |
|---|---|---|
| N0 | 15/23 | 15/23 |
| N1 | 17/23 | 18/23 |
| N1-guard-strict（同模型） | 16/23 | 16/23 |
| **N1-guard-oracle-strict（独立 ASR）** | **21/23** | **21/23** |
| best-of（N1 / 同模型 strict / oracle strict） | 21/23 | 22/23 |

- 23 条里 oracle-strict 的 2 条 miss：`6c76e1cf-0`（ASR「集成」）、`711e54cc-0`（重切后 N1/guard 都丢了「live voice」）。
- **重切不一定更好**：`711e54cc-0` 的旧切法 N1 是「live voice 测试」，静音谷重切后变成「网络测试/按摩测试/外界测试」；`6c76e1cf-0` 的旧/同模型 strict 更接近 gold（重切后 N1 rep0 变成「这个箭头」且 guard 多出「新建之类的东西」）。只有 b836 是**明确必须排除**的极端案例（3ms 切分、10s 尾巴）。

## 主结果（b836 移除后的 24 条，保持原切法）

| 臂 | rep0 | rep1 |
|---|---|---|
| N1 | 19/24 | 18/24 |
| **N1-guard-oracle-strict** | **23/24** | **23/24** |
| best-of（oracle-strict / 同模型 strict） | **24/24** | **24/24** |

- 唯一 oracle-strict miss 是 `6c76e1cf-0`（ASR 误听「集成」）；同模型 strict 在该条是 2。
- **结论：主集用 24 条（b836 移除、其余保持原切法）**；23 条 refined 作为敏感性检查，说明「不是所有贴边切点都该重切」。
- 之前 30 条的 27/30 作废；b836 低 SNR 且被 VAD 切碎，不属于典型场景。
