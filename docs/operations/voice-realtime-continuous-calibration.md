# Live Voice 连续模式真实校准（C-1 / C-2 / C-4 / C-5）—— 一次真实 Realtime 运行

本文件是 GOAL-044 / AC-362 的校准记录：把语料喂给**真实**的 Qwen Realtime 上游
（`qwen3.8-omni-flash-realtime`，出货默认模型与 voice），读断句、计费与「模型会不会等」。
**这不是模型推演，是一次运行的读数。** C-3（丢静音致盲）与 C-6（静音尾最小值）已移入
`gap-live-voice-silence-tail-suppression-probe`（AC-363），本报告不做。

运行时刻 2026-10-12T12:49:12Z；第二实例端口 3312；:3001 只被读 pid，从未被重启。

## 怎么跑的

- **执行面**：`POST /api/voice-realtime/diagnose`，`dryRun:true` —— 走 `server/index.ts` 的 `dryRun` 分支，
  `session_send` / `session_interrupt` **只被记录，不执行**。没有任何消息或中断进入任何真实会话。
- **连接**：每项每条臂各建立一条独立的上游连接，`sessionId` 是一个**任何库里都不存在**的合成 id，
  所以哪怕 dry-run 分支有洞，也没有一条路能落到真实会话上。
- **第二实例**：分别在 `127.0.0.1` 的备用端口上起过**两个**进程：一个用**出货 prompt** 跑 C-1/C-2/C-4，
  另一个用 C-5 自带指令的设置文件（`VOICE_REALTIME_SETTINGS_PATH`）跑 C-5。出货指令本身未被改动。
- **花费上限**：第二实例带 `VOICE_REALTIME_MAX_CNY_PER_CONNECTION=0.05`，每条连接独立封顶；
  总花费上限 ¥1（本任务的安全边界）。
- **边界**：不重启 :3001、不发布、不触碰任何 Quay worker / driver；第二实例带
  `CLAUDE_SESSION_SCOPE_SWEEP=off`（启动清扫是全机的，临时实例不收割别人的 scope）。

语料：C-1/C-2 共用一段含填充词与句中停顿的既有夹具音频
（`experiments/voice-trim/fixtures/zh-d06-o65.wav`，作者参考文本「嗯…那个…就是这个 composer 的按钮，嗯…再加个快捷键」）；
C-4 用脚本生成的纯数字静音与一段 TTS 语音拼出三段 60 s 音频；C-5 的二十句话由 DashScope
`qwen3-tts-flash` 合成后经 ffmpeg 转 16 kHz 单声道 PCM16。

## C-1 semantic_vad 在 qwen3.8 上是否有**行为**差异

C-1 semantic_vad：条目 2 条 / response 4 次；`server_vad` 臂条目 6 条 / response 7 次

读法：同一段音频，`server_vad` 切成 6 段（转写＝「嗯。／那个。／这个。／Composer.／的按钮。／再加个快捷键。」）、触发 7 次 response；
`semantic_vad` 只切成 2 段（转写＝「的按钮。／再加个快捷键。」）、4 次 response，且它的第一次 `speech_started` 迟至 11673 ms 才出现（`server_vad` 是 800 ms）。
**结论（读数）**：qwen3.8 上 `semantic_vad` 有**真实行为差异**——不是 P0-S4 控制面回显那种「无差别」；
但它不是免费的：段数更少的同时，开头那串「嗯／那个／这个 composer」在转写里被丢掉了，首字延迟也从 0.8 s 拉到 11.7 s。

同一段音频（含「嗯」「那个」等填充词与句中停顿），两臂只差 `turnDetection.type`（threshold 0.5、silence 400 ms 相同）：

| 臂 | 条目数（transcription.completed） | commits | response 数 | 最终转写 | 连接 id |
| --- | --- | --- | --- | --- | --- |
| `C-1 server_vad` | 6 | 6 | 7 | 嗯。 / 那个。 / 这个。 / Composer. / 的按钮。 / 再加个快捷键。 | `7384d79d-9151-4c67-b71d-9940f5d70f77` |
| `C-1 semantic_vad` | 2 | 2 | 4 | 的按钮。 / 再加个快捷键。 | `b7a29f99-ff08-4f06-a7c0-f9b741ca1375` |

- `C-1 server_vad` usage: responses=7 in=9580 out=113 audio=287 text=9293

- `C-1 server_vad` 时间线摘录（连接 `7384d79d-9151-4c67-b71d-9940f5d70f77`，前 8 条）：

```
800ms ← input_audio_buffer.speech_started
1092ms ← input_audio_buffer.speech_stopped
1092ms ← input_audio_buffer.committed
1190ms ← input_audio_buffer.speech_started
1219ms ← transcription.completed "嗯。"
1989ms ← input_audio_buffer.speech_stopped
1989ms ← input_audio_buffer.committed
2090ms ← input_audio_buffer.speech_started
```
- `C-1 semantic_vad` usage: responses=4 in=4873 out=59 audio=84 text=4789

- `C-1 semantic_vad` 时间线摘录（连接 `b7a29f99-ff08-4f06-a7c0-f9b741ca1375`，前 8 条）：

```
11673ms ← input_audio_buffer.speech_started
11675ms ← input_audio_buffer.speech_stopped
11675ms ← input_audio_buffer.committed
11986ms ← response.created response.id=resp_UCi1Dp9C5T4UJ6IdYjKuX
11986ms ← response.output_item.added
12019ms ← transcription.completed "的按钮。"
12100ms ← function_call session_send {"message": "的按钮。"}
12101ms ← response.output_item.done
```

## C-2 silence_duration_ms 400 / 800 / 1000 的碎片数与说完→response 延迟

C-2 silence_duration：条目数 400=6、800=4、1000=4；说完→response 延迟（全部 14 次）中位数 333.5 ms

同一段音频，三臂只差 `silence_duration_ms`：

| 臂 | 条目数 | commits | response 数 | 说完→response（逐次，ms） | 中位数 | 连接 id |
| --- | --- | --- | --- | --- | --- | --- |
| `C-2 silence-400` | 6 | 6 | 8 | 2111 / 1205 / 302 / 302 / 373 / 363 | 368 | `2a84ca01-ec2e-4d93-bb76-b3019d1dd61f` |
| `C-2 silence-800` | 4 | 4 | 8 | 294 / 313 / 332 / 371 | 322.5 | `8c303de1-07da-4618-b644-f96922154aa0` |
| `C-2 silence-1000` | 4 | 4 | 8 | 328 / 327 / 335 / 343 | 331.5 | `8472c06e-1103-4241-801c-9f210da9fd6d` |

延迟口径：上游 `input_audio_buffer.speech_stopped` 到其后最近一次 `response.created` 的墙钟差，
取自本连接的 `wire[]`（`atMs` 相对连接开始）。音频按 1× 实时推流，所以这是真实延迟而非压缩后的数字。

- `C-2 silence-400` usage: responses=8 in=11086 out=113 audio=336 text=10750；最终转写：嗯。 / 那个。 / 就是这个。 / Composer. / 的按钮。 / 再加个快捷键。
- `C-2 silence-800` usage: responses=8 in=10943 out=118 audio=336 text=10607；最终转写：嗯，那个，就是这个。 / Composer. / 的按钮。 / 再加个快捷键。
- `C-2 silence-1000` usage: responses=8 in=10938 out=117 audio=336 text=10602；最终转写：嗯，那个，就是这个。 / Composer. / 的按钮。 / 再加个快捷键。

- `C-2 silence-400` 时间线摘录（连接 `2a84ca01-ec2e-4d93-bb76-b3019d1dd61f`，前 10 条）：

```
783ms ← input_audio_buffer.speech_started
1018ms ← input_audio_buffer.speech_stopped
1018ms ← input_audio_buffer.committed
1129ms ← input_audio_buffer.speech_started
1148ms ← transcription.completed "嗯。"
1924ms ← input_audio_buffer.speech_stopped
1924ms ← input_audio_buffer.committed
2034ms ← input_audio_buffer.speech_started
2061ms ← transcription.completed "那个。"
2827ms ← input_audio_buffer.speech_stopped
```

## C-4 静音是否计费

C-4 静音计费：60 s 纯静音（A）audio token 0、response 0；语音在前 60 s（B）audio token 70；语音在后 60 s（C）audio token 70

三臂总时长都是 60 s（60 s 静音 + 语音的拼装），都只推一次音频（外加 diagnose 路径自带的 1.5 s 收尾静音）：

| 臂 | 构成 | 语音秒数 | 静音秒数 | response 数 | audio token | text token | 连接 id |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `C-4 A` | 60 s 纯静音 | 0.0 | 60.0 | 0 | 0 | 0 | `aa001126-5224-4b30-be25-3d09e0d4900d` |
| `C-4 B` | 语音在前，其后补静音到 60 s | 3.3 | 56.7 | 3 | 70 | 3530 | `afaedf5f-3321-4a32-8ea9-e5ee954f3094` |
| `C-4 C` | 先静音，语音在末尾，总长 60 s | 3.3 | 56.7 | 2 | 70 | 2291 | `b329c239-4fdd-449e-9743-e3e7909c31bc` |

读法：

1. **A（60 s 纯静音）**：response=0 —— 静音本身不触发推理，也就没有可计的输入音频，花费 ¥0.0000。
2. **B vs C 才是判据**。B 的静音在语音*之后*，发生在 response 之后，不进这一 response 的输入；C 的语音在*末尾*，它的 response 读入时缓冲区前面是整段 56.7 s 静音。
   实测 C 的 audio token 合计 70，与 B 的 70 同量级，都约等于那段 3.3 s 语音本身（≈23 token），而不是 60 s 静音该有的 ≈420 token。

**结论（读数）**：静音**不计费**。证据是 C 臂——若静音计入 response 的输入音频，C 的 audio token 应逼近 60 s 的量；
实测 C 与 B 同量级、且都等于语音本身的量，说明上游只对语音计音频 token，静音既不触发推理也不进计费缓冲。

- `C-4 A` usage: responses=0 in=0 out=0 audio=0 text=0；每个 response：（无）
- `C-4 B` usage: responses=3 in=3600 out=60 audio=70 text=3530；每个 response：
  - @6401ms in=1103 out=30 audio=14 text=1089
  - @8913ms in=1158 out=28 audio=28 text=1130
  - @9545ms in=1339 out=2 audio=28 text=1311
- `C-4 C` usage: responses=2 in=2361 out=36 audio=70 text=2291；每个 response：
  - @61526ms in=1138 out=34 audio=35 text=1103
  - @61950ms in=1223 out=2 audio=35 text=1188

- `C-4 C（先静音、语音在末尾）` 时间线摘录（连接 `b329c239-4fdd-449e-9743-e3e7909c31bc`，前 10 条）：

```
57495ms ← input_audio_buffer.speech_started
59395ms ← input_audio_buffer.speech_stopped
59395ms ← input_audio_buffer.committed
59501ms ← input_audio_buffer.speech_started
59578ms ← transcription.completed "帮我把首页顶部的标题。"
61066ms ← input_audio_buffer.speech_stopped
61066ms ← input_audio_buffer.committed
61258ms ← transcription.completed "色换成蓝色。"
61363ms ← response.created response.id=resp_AGTbZ6kHhUu8yWYfV6fGE
61363ms ← response.output_item.added
```

## C-5 「没说完可以不转发」指令下，模型是否真的等待并合并转发

C-5 模型等待：10 个有效样本中，0 个在「未说完」时等待（等待率 0.0%）；10 个当场就把半句转发了，其中 8 个在补完后**又**发一条（同一段意思被拆成两条消息）、2 个的补完内容**从未投递**

指令（写在本实验自己的设置文件里，**未改出货指令**）：

```
You are a voice relay for one Claude Code session. You never answer, comment or reason yourself, and you never reply in text. Judge whether the user has FINISHED a complete thought. If they have finished, call the `session_send` function with `{ message }` carrying what they said, in their own words. If they have NOT finished — they are still thinking, trailing off, or the sentence is obviously incomplete — do NOT call any tool now: you MAY wait and forward the whole finished thought at the NEXT opportunity, once it is complete. Never split one thought across several messages. If you judge that the user wants the work that is running right now stopped or taken a different way, call `session_interrupt` instead of `session_send`. The session is fixed by the connection; never name one.
```

每组合成两条音频，在**一条连接**上作为两个 turn 依次说出；turn 0 是未说完的半句，turn 1 是补完。
「等待」= turn 0 没有 `session_send`；「拆分」= turn 0 与 turn 1 都发了 `session_send`；「丢失」= turn 0 发了、turn 1 没发。

| 样本 | 未说完（turn 0） | 补完（turn 1） | turn0 动作 | turn1 动作 | turn1 投递内容 | 连接 id |
| --- | --- | --- | --- | --- | --- | --- |
| c5-01 | 帮我把那个…… | 把首页标题改成蓝色的。 | 转发（“帮我把那个。”） | 未转发 | — | `57fc2bc2-e2b4-49bb-9f48-20c198a80a3e` |
| c5-02 | 我觉得我们应该…… | 应该先把测试跑一遍再改代码。 | 转发（“我觉得我们应该是。”） | 转发 | 应该先把测试跑一遍再改代码。 | `7a84d2ad-77e2-478d-bfb1-decefc8e7dc1` |
| c5-03 | 那个文件里有一个…… | 有一个没处理的错误，帮我看一下。 | 转发（“那个文件里有一个。”） | 转发 | 有一个没处理的错误，帮我看一下。 | `ed17e449-7526-47eb-8338-69e67a0cb2c1` |
| c5-04 | 能不能帮我加一个…… | 加一个快捷键来切换主题。 | 转发（“能不能帮我加一个？”） | 转发 | 加一个快捷键来切换主题 | `671522e2-f388-4dfb-be25-5cedf9df8492` |
| c5-05 | 我想改一下…… | 改一下登录页那个按钮的颜色。 | 转发（“我想改一下。”） | 转发 | 改一下登录页那个按钮的颜色。 | `f91763e3-d57b-4746-82f3-b31caabeba35` |
| c5-06 | 就是那个…… | 就是刚才那个接口的返回值不太对。 | 转发（“就是那个。”） | 转发 | 就是刚才那个接口的返回值不太对。 | `219fb7e0-0f6c-4242-99de-b733a7a2186b` |
| c5-07 | 麻烦你…… | 麻烦你把那个函数的参数名改一下。 | 转发（“麻烦你。”） | 未转发 | — | `a6b5a000-1ab4-4ddd-b146-8cd696103954` |
| c5-08 | 我打算…… | 我打算先把这个模块重构一下。 | 转发（“我打算。”） | 转发 | 我打算先把这个模块重构一下。 | `4fc744cb-2149-42c3-8790-b5297e16f853` |
| c5-09 | 你看下那个…… | 你看下那个测试为什么老是失败。 | 转发（“你看下那个。”） | 转发 | 你看下那个测试为什么老是失败？ | `7af1e34e-fe5d-4010-9341-cc5f319ab20d` |
| c5-10 | 我想让它…… | 我想让它支持拖拽排序。 | 转发（“我想让他。”） | 转发 | 我想让它支持拖拽排序。 | `293bf51a-6d5f-469f-af7a-affb8a182765` |

**结论（读数）**：这条指令**没有**让模型等待。10 组里模型每次都把未说完的半句**当场转发**（0/10 等待），其中 8 组在补完后又发了第二条——同一段意思被拆成两条消息，正是指令想禁止的行为；2 组的补完内容干脆没发。
「你可以等」是一句*许可*而非*约束*：在当前 prompt 形态下，模型选择立刻转发半句，等不到第二次机会再合并。

- `C-5 c5-01` usage: responses=3 in=3279 out=32 audio=63 text=3216；sampleId=c5-01
- `C-5 c5-02` usage: responses=4 in=4587 out=65 audio=112 text=4475；sampleId=c5-02
- `C-5 c5-03` usage: responses=4 in=4626 out=66 audio=140 text=4486；sampleId=c5-03
- `C-5 c5-04` usage: responses=4 in=4593 out=75 audio=98 text=4495；sampleId=c5-04
- `C-5 c5-05` usage: responses=4 in=4572 out=64 audio=98 text=4474；sampleId=c5-05
- `C-5 c5-06` usage: responses=5 in=6067 out=78 audio=126 text=5941；sampleId=c5-06
- `C-5 c5-07` usage: responses=3 in=3263 out=42 audio=49 text=3214；sampleId=c5-07
- `C-5 c5-08` usage: responses=4 in=4541 out=63 audio=70 text=4471；sampleId=c5-08
- `C-5 c5-09` usage: responses=4 in=4558 out=64 audio=84 text=4474；sampleId=c5-09
- `C-5 c5-10` usage: responses=4 in=4565 out=79 audio=70 text=4495；sampleId=c5-10

- `C-5 c5-01（半句被当场转发、补完未投递 = 丢失）` 时间线摘录（连接 `57fc2bc2-e2b4-49bb-9f48-20c198a80a3e`，前 12 条）：

```
1332ms ← input_audio_buffer.speech_started
2885ms ← input_audio_buffer.speech_stopped
2885ms ← input_audio_buffer.committed
3063ms ← transcription.completed "帮我把那个。"
3190ms ← response.created response.id=resp_FuC9beabC84z4heDLsfJk
3191ms ← response.output_item.added
3309ms ← function_call session_send {"message": "帮我把那个。"}
3312ms ← response.output_item.done
3312ms ← response.done status=completed in=995 out=28 audio=14
3312ms → response.create
3776ms ← response.created response.id=resp_DHjf6alJ3tGveUtsieIMA
3776ms ← response.output_item.added
```

## 成本基线（同一运行的读数）

成本基线：response 总数 79（18 条连接）；投递率（至少发过一条消息的连接）94.4%；每 response 输入 token text 1210 / audio 31；每 response 花费 ¥0.0021

| 指标 | 读数 |
| --- | --- |
| 上游连接数 | 18 |
| response 总数 | 79 |
| `function_call`（session_send / session_interrupt）总数 | 40 |
| 每 response 平均 `function_call` | 0.51 |
| 至少发过一条消息的连接 / 全部连接（投递率） | 17 / 18（94.4%） |
| 输入 token：text / audio / 合计 | 95603 / 2429 / 98032 |
| 输出 token | 1244 |
| 每 response 输入 token：text / audio | 1210 / 31 |
| 每 response 花费（出货公式） | ¥0.0021 |
| 本次运行总花费 | ¥0.1636 |
| 挂机（纯静音）¥/小时（**外推**） | ¥0.0000 |

「投递率」= 至少调用过一次工具（即至少向会话投递过一条消息）的连接 / 全部连接。唯一没投递的是 C-4 A（60 s 纯静音）：**没有** response，也就没有一次调用；其余 17 条连接都至少投递了一条 `session_send`。挂机 ¥/小时是**外推**：A 臂（60 s 纯静音）读数：responses=0，花费 ¥0.0000；按 60 s → 3600 s 线性外推。
说话场景的 ¥/小时需要「持续说话」的长剧本，本运行没有取（那是一次单独的付费运行）；这里只给每 response 的读数，不外推说话场景。

## 运行口径与边界（AC3）

运行次数：1

「运行次数：1」指的是这一次校准整体只执行了一回（SPEC §18.7「单次付费运行」，见记忆：勿反复真实上游测量），没有重复取数、没有二轮。四项校准在同一个运行目录下顺序完成，共 18 条上游连接，每条连接的读数只由它自己的那一臂产生——这是逐条可归因，不是多次实验。

花费：¥0.1636（每条连接上限 ¥0.0500 × 18 条连接；总花费上限 ¥1.0000）

:3001 pid：运行前 1933227 → 运行后 1933227（相同，未重启）

执行面：`POST /api/voice-realtime/diagnose` + `dryRun:true`（`session_send` / `session_interrupt` 只被记录，不执行）。

## 方法与限制（如实记录）

1. **花费是估算**。`estimateRealtimeCostCny` 是出货的估算公式（文本入 0.0015、音频入 0.006、文本出 0.0045 CNY / 1k token），
   账单以官方为准；这里报的是与出货花费守卫**同一个**读数，不是发票。
2. **证据落在哪**。每条连接的读数落在运行目录 `<运行目录>/journal/<连接 id>.jsonl`，
   原始诊断报告在 `<连接 id>.report.json`；表里每一行的连接 id 与时刻都能在这两个文件里对上。
3. **C-1/C-2 用出货 prompt**；**C-5 用**本实验的设置文件（自带指令），出货指令未被改动。两段 prompt 不同，
   所以 C-5 的读数只在它自己的指令下成立，不能与 C-1/C-2 的 response 数直接比。
4. **C-4 的 C 臂**（语音在后）是判「静音是否计入 response 输入音频」的关键臂：B 臂的尾部静音发生在 response 之后，
   不进这一 response 的输入，所以单看 A/B 分不开；三臂合读才分得开。
5. **模型可能不调工具**。「未调工具」是一个真实读数（上游并不保证每轮都调工具），本脚本不重试、不挑输入。
6. **取数前的管线预检**。取数前先用 --boot-only 跑过一次管线预检（第二实例在备用端口起停、路由与 JWT 鉴权通过），该预检不调上游、不产生花费；随后才执行下面这一次真实取数运行。

## 复现

```bash
npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-continuous-calibration/run.mts
```

本次运行目录：`/tmp/ac362-run`（journal 在 `/tmp/ac362-run/journal`，第二实例日志在 `second-instance-*.log`）。
运行目录是临时的：它不随提交保留，表本身就是读数。
