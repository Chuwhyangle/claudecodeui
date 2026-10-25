# Gemini 2.5 / 3.5 Flash Lite 使用 relay 式上下文：placement 能修回声，但修不了识别质量

日期：2026-10-22。工装：`experiments/voice-gemini-relay-context/run.mjs`。
原始读数：`experiments/voice-gemini-relay-context/out/results.jsonl`（`out/` 被根 `.gitignore` 忽略；含用户语音文本，不入库）。

## 一句话

**把 `dashscope-omni-relay` 的上下文方法照搬到 Gemini，能修掉旧的 prompt 回声缺陷（user 轮 5–6/8 回声 → system 轮 0/8），但 Gemini 的识别质量仍然明显低于 `qwen3.8-omni-flash` + 同一份上下文：真实 live voice 上 CER 0.265/0.333 对 omni N1 的 0.119，术语命中 3/5、1/5 对 4/5。延迟不是问题（p50 2.0–2.4 s）。结论是不要用 Gemini 替代 omni relay；如果保留 Gemini 作为选项，system 放置是最低限度的修复。**

## 一、要回答的问题

上一份 Gemini 记录（`2026-09-23-gemini.md`）测的是出货 `multimodal` 适配器的形状：**context 作为 user 轮的一个 text part**，与音频并排。那条线上 context 会被回声进转写，3/8 条整条输出 prompt 原文。

`dashscope-omni-relay` 的做法不同（`shared/asr/list/dashscope-omni-relay/dashscope-omni-relay.asr-provider.ts`）：

- relay 指令、audio-only 规则、任务句、`CONTEXT_HEADER + context` 全部放进 **systemInstruction**；
- **user 轮只有音频**，没有任何 text part；
- 模型被明确告知“任务句不是用户说的话，不要复述”。

本记录问：把同样的放置方式用在 Gemini 2.5 / 3.5 Flash Lite 上，回声是否消失？识别质量是否因此可用？

## 二、装置

### 2.1 臂

每个模型三臂，**同一批音频**：

| 臂 | systemInstruction | user 轮 | 作用 |
|---|---|---|---|
| `none` | relay prompt（无 context） | 只有音频 | 无上下文参照 |
| `system` | relay prompt + `CONTEXT_HEADER` + context | **只有音频** | relay 的方法 |
| `user` | relay prompt（无 context） | 音频 + `CONTEXT_HEADER` + context | 旧 `multimodal` 放置的对照（回声复现） |

relay prompt 的 `RELAY_SYSTEM` / `AUDIO_ONLY_RULES` / `RELAY_TASK` / `CONTEXT_HEADER` 由 runner **import 出货模块**，不是抄一份。

### 2.2 模型与解码

- `gemini-2.5-flash-lite`：`temperature: 0` + `thinkingConfig.thinkingBudget: 0`（出货适配器的规则）。
- `gemini-3.5-flash-lite`：`temperature: 0`；该模型**拒绝** `thinkingBudget`（400），默认不发送。另跑 `thinkingLevel: minimal` / `low` 两档确认思考预算不是质量差异的来源。
- 请求形状是 **runner-local**：出货 `multimodal` 适配器目前只会把 context 放进 user 轮（`contextPlacement` 默认 `'user'`），无法表达 system 放置。因此本记录的读数**不能归给出货适配器代码**，它测的是“如果这样放置会怎样”。

### 2.3 语料

| 语料 | n | 内容 | 参照 |
|---|---|---|---|
| `tts` | 8 | `voice-provider-paired-quality/fixtures/d0*-o65.wav` + 上一份 Gemini 记录同一段 synthetic 标识符 context | 喂给 TTS 的脚本原文 |
| `real` | 8 | 真实 live voice utterance（`6c76e1cf-0`、`711e54cc-0`、`acf7fc73-0`、`bf517472-0/1`、`e8df1709-2`、`4eea7875-3`、`47d5202d-0`）+ 当时精确的 C2 pack | 当时 realtime 的 delivered message（`relay`） |

`real` 的音频来自 `experiments/voice-omni-vs-realtime/out/audio-refined/`；context 与参照与 `voice-omni-vs-realtime` 的 30 条实验**逐条同源**，所以 Gemini 与 omni N0/N1 可以直接并列。

### 2.4 读数口径

- **CER**：归一化（小写、去标点/空白）后的字符错误率；`tts` 对脚本原文，`real` 对 `relay` 参照。
- **术语命中**：`real` 的 5 个目标出现——`architecture tab`、`live voice` ×3、`pack`。
- **回声**：归一化输出包含 context 的整段或任一 24 字窗口。
- **内容遗漏**：归一化输出长度 < 参照的 60%。
- 延迟：每次 `generateContent` 的墙钟，含服务端排队。
- 单次运行、串行（4.1 s 最小间隔）；`real` 与 `tts` 各自 n=8，只报方向，不做显著性。

## 三、读数

### 3.1 TTS 8 条（配对面：7 条，2.5 的 d04 none 臂超时）

| 模型 | 臂 | CER | 回声 | 标识符存活（可能含 context 带出） | 内容遗漏 |
|---|---|---|---|---|---|
| 2.5 Lite | none | **0.287** | 0/7 | 0/42 | 1/7 |
| 2.5 Lite | **system** | 0.337 | **0/7** | **6/42** | **3/7** |
| 2.5 Lite | user | **1.387** | **5/7** | 24/42（多为回声带出） | 0/7 |
| 3.5 Lite | none | 0.563 | 0/8 | 0/48 | 4/8 |
| 3.5 Lite | **system** | **0.332** | **0/8** | 1/48 | 2/8 |
| 3.5 Lite | user | 0.844 | 1/8 | 11/48（含回声带出） | 2/8 |
| 3.5 Lite | system @ minimal | 0.329 | 0/8 | — | — |
| 3.5 Lite | system @ low | 0.323 | 0/8 | — | — |

三件事：

1. **放置是回声的开关。** 2.5 的 user 臂 5/7 回声、CER 1.387；同一模型、同一 context、同一 prompt，只把 context 移到 system，回声变成 0/7。旧记录的回声缺陷是可复现的，且由放置方式决定。
2. **system 臂的回声消失，但出现了“上下文压过音频”的遗漏。** 2.5 system 在 d02 只输出 `voice.service.ts`，d03 只输出 `use voice input hook`，d08 把“啊不，是 whisper turbo”的更正截掉；3/7 条短于参照的 60%。标识符从 0/42 升到 6/42，但这是以丢内容为代价的：d02/d03/d08 的输出正是 context 里出现过的标识符或前半句，所以这 6/42 不能直接读成“识别变好”，它可能只是从 context 里取了词。
3. **3.5 的 system 臂在 TTS 上反而比 none 好（0.563 → 0.332）**，但仍有 d04 只输出“不要动”、d08 把 `whisper large, 啊不, whisper turbo` 听成 `Whisper Large Apple 是 Whisper Turbo` 这类失败。`thinkingLevel` 两档只把 CER 从 0.332 动到 0.329/0.323，**不是思考预算的问题**。

### 3.2 真实 live voice 8 条（与 omni N0/N1 同音频、同 context）

| 臂 | CER vs relay | 术语命中 | p50 延迟 |
|---|---|---|---|
| omni N1 rep0（`qwen3.8-omni-flash`，relay prompt） | **0.119** | **4/5** | 4463 ms |
| omni N1 rep1 | **0.113** | **4/5** | 2264 ms |
| omni N0 rep0（无 context） | 0.253 | 1/5 | 9263 ms |
| omni N0 rep1 | 0.271 | 1/5 | 2560 ms |
| Gemini 2.5 none | 0.303 | 2/5 | 2252 ms |
| **Gemini 2.5 system** | **0.265** | **3/5** | 2381 ms |
| Gemini 2.5 user | 6.644 | 3/5（多为回声带出） | 2125 ms |
| Gemini 3.5 none | 0.364 | 0/5 | 2500 ms |
| **Gemini 3.5 system** | **0.333** | **1/5** | 2338 ms |
| Gemini 3.5 user | 0.349 | 2/5 | 2190 ms |

读法：

- **system 放置对 Gemini 有方向性帮助**（2.5：0.303→0.265、术语 2→3；3.5：0.364→0.333、术语 0→1），但**离 omni N1 的 0.119 / 4/5 仍差一个档**。
- **延迟上 Gemini 反而更好**（2.0–2.4 s 对 omni N1 的 2.3–4.5 s）。所以 Gemini 的问题不是慢，是识别质量与稳定性。
- **2.5 的 user 臂是灾难**：长 context 被当作待处理内容，CER 6.6；即使没有命中“回声”判据，输出也已经不是这段音频的转写。
- **术语修复是局部的**：2.5 system 修回了 `architecture tab` 和 `pack`，但 `live voice` 在 2/3 条上仍失败（`Live Watch`、`live 模式`）；3.5 system 机械命中只有 `pack` 1/5；人读上 `Architecture 这个 Tab` 也算把 architecture 修回来了，但它不是 `architecture tab` 的连续匹配，`live voice` 三条全失败（`Lawless`、`live 模式`、以及 711 的整句幻觉）。

### 3.3 失败形态（人读）

- **时间戳伪输出**：2.5 system 在 `711e54cc-0`（2.9 s，低能量短句）输出 `00:00 00:01 00:02`；`4eea7875-3` 输出 `00:00 这段又没有语音输出`。这是 Gemini 在“没听清”时的退化形态，不是转写。
- **短句幻觉**：3.5 system 在 `711e54cc-0` 输出 `测试 正在 进行。 好。 我 想 试试 这个。`；3.5 none 在 `acf7` 输出 `继续测试来,看看心跳比是不是会有变化`（`live voice` → `来`、`信噪比` → `心跳比`）。
- **空格/分段噪声**：3.5 仍有逐字插空格（`测试 正在 进行`、`现在 就 改 ， 然后`），与 2026-09-23 记录里的 `g35lite` 形态一致。
- **内容遗漏**：2.5 system 在 TTS 的 d02/d03/d08 只输出 context 里出现过的标识符或前半句，句尾/自我更正被截掉。这与 `voice-omni-vs-realtime` 里“低能量段模型回退到上下文”的失败同形，但 Gemini 在有音频时也会发生。

## 四、结论

1. **relay 式 system 放置确实修掉了 Gemini 的 context 回声**：TTS 上 2.5 从 5/7 回声降到 0/7，`real` 上从 6.644 的 CER 灾难降到 0.265。这是本记录最干净的一条机制读数。
2. **但 Gemini 不能替代 `dashscope-omni-relay`。** 同一份真实音频与 context 上，Gemini 最好的臂（2.5 system）CER 0.265、术语 3/5；omni N1 是 0.119、4/5。Gemini 的延迟更好，但 dictation 的瓶颈是逐字保真、边界和短句稳定性。
3. **3.5 不是 2.5 的升级。** TTS 上 3.5 system 略好于 2.5 system（0.332 对 0.337），但真实语料上更差（0.333 对 0.265；术语 1/5 对 3/5），且空格/幻觉形态更多。`thinkingLevel` 不是杠杆。
4. **如果保留 Gemini 作为可选 provider，最低限度的修复是把 `multimodal` 的 context 放到 system、user 轮只留音频**；当前出货适配器仍是 user 放置，选中 Gemini 就会复现旧回声。但即使修了放置，它也不适合作为默认听写。
5. **本地 SenseVoice + omni relay + 独立逐字护栏仍是推荐组合**（见 `voice-omni-vs-realtime` 的 23/24、24/24 读数）。Gemini 的 system 放置只能作为一个“别再回声”的修补，不是质量方案。

## 五、局限

- n=8 TTS + 8 real，单次运行；只报方向，不做显著性。`real` 的 8 条是从 24 条里挑的指代/术语密集样本，不代表全部口述。
- `real` 的参照是当时 realtime 的 delivered message，不是人工真值；CER 对 `relay` 的差值包含风格差异（标点、空格、改写）。
- 请求形状是 runner-local，**不归给出货代码**；`multimodal` 适配器没有 system 放置的实现。
- `qwen3.8-omni-flash` / `gemini-2.5-flash-lite` / `gemini-3.5-flash-lite` 都是服务别名，可能被重新指向。
- Gemini 的 `real` 臂没有做 human-preference judge；术语命中与 CER 是机械读数，失败形态靠人读。
- 3.5 的 `thinkingLevel` 只在 TTS system 臂上测了两档，没有在 `real` 上复测。

## 六、复现

```bash
# 96 次主读数（2.5 + 3.5 × none/system/user × 8 TTS + 8 real）
node experiments/voice-gemini-relay-context/run.mjs --model=2.5 --fresh
node experiments/voice-gemini-relay-context/run.mjs --model=3.5

# 3.5 thinking 档（TTS system 臂）
node experiments/voice-gemini-relay-context/run.mjs --model=3.5 --arms=system --thinking=minimal --tts
node experiments/voice-gemini-relay-context/run.mjs --model=3.5 --arms=system --thinking=low --tts
```

凭据从主检出根 `.env.test` 的 `GEMINI_API_KEY` 读取，不打印。
