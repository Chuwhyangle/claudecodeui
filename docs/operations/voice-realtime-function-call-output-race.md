# Live Voice 工具结果被上游拒（`Unknown function call id` → `Cannot create response after rejected function_call_output`）真实探针

本文件是 `gap-live-voice-function-call-output-rejected-after-speech-resume` 的探针记录：在**真实** `qwen3.8-omni-flash-realtime` 上，把一段真实语音推进「模型已 `function_call`、上游尚未回执」的窗口，回答**拒收由哪一个时序触发**，并在修复后重跑同一臂给出基线对比。
**这不是模型推演，是一次运行的读数。** 归因结论只允许「证实 / 否证 / 不足以判断」三选一。

驱动的是**出货的** transport + bridge（不是裸 WS 客户端）：被测量的读数是「浏览器会不会收到 `UPSTREAM_ERROR`」，而那条路径是出货 transport 的 `handleInbound` → bridge 的 `UPSTREAM_ERROR` → proxy 的 error 帧。手搓协议只能证明上游会拒，证明不了这条链路的读数，也给不出修复前后的同读数对比。
执行面是**合成会话**：会话声明的 `ui_visible_context` 由探针内的记录式执行器承接，回一个常量快照，**绝不**落到任何真实会话、不触发任何真实工具。
`:3001` 只被读 pid（运行前后各一次），**从未被重启**；未改任何生产 env。

探针：`experiments/voice-realtime-function-call-output-race/probe.mts`

```
set -a; . ./.env.test; set +a
npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-function-call-output-race/probe.mts \
  --arm all --hold 6000 --cap 0.30 --phase pre|post --work <运行目录>
```

`--phase` 换的是**退出判据**，不是行为：`pre` 要的是「重现」（臂 R ≥1 次 `Unknown function call id`、臂 C 0 次）；`post` 要的是「不再发生」**且这个零来自状态机真的把结果拦下**（臂 R 的 `output发出=0` 且日志里有 `state=superseded`，同时臂 C 的常规路径一字未动）。少了后半条，一个「碰巧没重现」的连接也会被判成绿。

## 读数行（判据逐行检查）

**修复前 · 第 1 次（`/tmp/voice-race-prefix`，`--arm both --hold 6000 --cap 0.30`）**
臂 R（`sess_BzjzVt46VW4Zswg5WvZRQ`，¥0.004506）：function_call 1，output 发出 1、回执 **0**，speech_started 4，错误帧 2（`Unknown function call id` + `Cannot create response after rejected function_call_output`），拒绝 **1** 组、浏览器侧 `UPSTREAM_ERROR` **2** 条。
臂 C（`sess_XjSJJ8XBIpP8EDXYyFT9v`，¥0.004182）：output 发出 1、回执 **1**，speech_started 0，错误帧 0，拒绝 **0**。
结论：**证实**（臂 R 重现、对照臂零次）。

**修复前 · 第 2 次（`/tmp/voice-race-prefix2`，`--arm all --hold 6000 --cap 0.30`）**
臂 R（`sess_YwByqeW5KoOi4UH98miyo`，¥0.004272）：拒绝 1 组、浏览器错误 2 条，`newUserTurnInsideWindow=true` **且** `newUserTurnBeforeSend=true`。
臂 C（`sess_LsbN1waqgJSV62Lsa4QKm`，¥0.004173`）：output 发出 1、回执 1，拒绝 0。
臂 A（`sess_Sub3Fka37bkNhbmJdsbM4`，¥0.009360）：拒绝 0，但出现 **1** 条别的上游错误 `Response request cancelled by new input`。
结论：臂 R **证实**、臂 C **否证**、臂 A **否证**（未重现本缺陷）。

**修复后（`/tmp/voice-race-postfix`，`--arm all --hold 6000 --cap 0.30 --phase post`）**
臂 R（`sess_ZpMQjCeVOzZ1t7DKc1Hak`，¥0.004443）：`function_call=1  output发出=0  回执=0`，speech_started 4，错误帧 **0**，`Unknown function call id` **0**，浏览器侧 `UPSTREAM_ERROR` **0**；transport 日志 `function_call_output receipt call_id=call_6ff31e5d9b054928972fed4b state=superseded turn_seq=1 now=9`。
臂 C（`sess_RMcFfSDgYDKGKYx87Tl3V`，¥0.004218）：`output发出=1  回执=1`，错误帧 0，**无回执行**（常规路径一字未动）。
臂 A（`sess_VSMDy4hcbPLgzdLvB9ZNE`，¥0.004306）：错误帧 1（`Response request cancelled by new input`）——见「范围外」一节。
结论：**修复生效**（臂 R 的拒收与浏览器错误同时归零，且零来自结果被拦下而非没发生；臂 C 常规路径未变）。

运行次数：修复前 2 次（3 条臂共 5 条连接）+ 修复后 1 次（3 条连接）
花费：修复前 ¥0.008688 + ¥0.017805；修复后 ¥0.012967（每次上限 ¥0.30，均未触顶）
:3001 pid：三次运行全部 766174 → 766174（**相同**，未重启）
所用音频区间：捕获 `~/.cloudcli/voice-realtime-capture/b5d01c21-3f53-4228-a28e-d18b7cb967f7.wav` 第 3 段（slice #3，33607–38371 ms，samples 1075424–1227872）
capture sha256：`0f2bd51fbbb28c9f60bc381684fa7b4f38aa845c07f2d79b4f17ed8b08696e33`（前缀 `0f2bd51fbbb28c9f` 与任务书一致）

## 归因结论：**证实**——触发条件是「发出 output 时所属回合已被新用户输入取代」，而**不是**「所属 response 被 cancel」或「合成 `response.create` 撞车」

三臂各自一条**全新连接**（一次拒绝无法被归因到上一条连接的残留）：

| 臂 | 次序 | 期望 |
| --- | --- | --- |
| R（重现） | 执行器压住结果 `--hold` ms，其间按 200 ms 分块推入真实语音段；压满才返回，output 随后才发出（**语音先于 output**） | 触发拒绝 |
| C（对照） | 与 R 完全相同，只是**不推任何语音** | 零拒绝 |
| A（journal 原序） | 执行器**立即**返回（output 一发出就推语音段），复刻 `b5d01c21` 的次序（**output 先于语音**） | 见下 |

判据的 cause 三个候选，逐项读出来（取臂 R 拒绝那一次）：

| 候选成因 | 修复前臂 R | 修复前臂 A | 判定 |
| --- | --- | --- | --- |
| 窗口内出现**新的用户回合**（`speech_started` / 新 user item） | `true` | `true`（但 output 发出时还没有） | **这就是触发条件** |
| 所属 response 被 cancel | `false` | `false` | 排除 |
| 合成 `response.create` 撞上进行中的 response | `false` | `false` | 排除 |

**排除「所属 response 被 cancel」的证据**：两臂里 ownership 的那条 `response.done` 都是 `status=completed`（臂 R 修复前 `resp_PoHoE6jXilwqEWymRZGsc` @+2072 ms、臂 C `resp_AKo4EXpX4JhREKA8QIJfy` @+2681 ms），没有任何一条以 `cancelled` 收尾。
**排除「`response.create` 撞车」的证据**：臂 R 的合成 `response.create` 与 output 同刻发出（+8073 ms），其时**没有**任何进行中的 response（前一条早已 `completed`，下一条要到 +4375 ms 才由上游自己开）。

### 修复前后的同一臂对照

| 读数 | 修复前 R（run 2） | 修复后 R（post） |
| --- | --- | --- |
| function_call | 1（`call_7a928c9609424a588260ec5f`） | 1（`call_6ff31e5d9b054928972fed4b`） |
| output 发出 | 1（+8073 ms） | **0** |
| 上游回执 | 0 | 0 |
| 拒绝组数 | 1 | **0** |
| 浏览器 `UPSTREAM_ERROR` | 2 | **0** |
| 回执行 | 无（修复前无此机制） | `state=superseded turn_seq=1 now=9` |
| `newUserTurnBeforeSend` | `true` | `true` |

修复后臂 R 的 `newUserTurnBeforeSend` 与修复前**同形**——同样的竞争发生了，区别只在结果被状态机拦在发送之前，于是「必被拒」的一次发送根本没有发生。

## 事件时间线摘录

### 修复前 · 臂 R（复现）— `sess_YwByqeW5KoOi4UH98miyo`（`/tmp/voice-race-prefix2`）

```
+  1503ms >> conversation.item.create      （用户回合）
+  1503ms >> response.create
+  1692ms << conversation.item.created     item.type=message item.role=user
+  2023ms << response.created              resp_PoHoE6jXilwqEWymRZGsc
+  2024ms << conversation.item.created     item.type=function_call call_id=call_7a928c9609424a588260ec5f
+  2070ms << response.function_call_arguments.done  name=ui_visible_context
+  2072ms << response.done                 resp_PoHoE6jXilwqEWymRZGsc status=completed
+  2671ms << input_audio_buffer.speech_started      ← 用户开口（hold 期间）
+  3180ms << conversation.item.created     item.type=message item.role=user
+  3775ms << input_audio_buffer.speech_started
+  4095ms << conversation.item.created     item.type=message item.role=user
+  4375ms << response.created              resp_VGGyENKqZl7KbKhs6Fj7D
+  4631ms << response.done                 status=completed
+  7450ms << conversation.item.created     item.type=message item.role=user
+  8073ms >> conversation.item.create      ← output 发出（hold 满 6000 ms 才发）
+  8073ms >> response.create               ← 合成
+  8460ms << ERROR  param=call_id  "Unknown function call id: call_7a928c9609424a588260ec5f"
+  8461ms << ERROR  param=response "Cannot create response after rejected function_call_output; …"
```

两次 ERROR 各被 bridge 转成一条浏览器 `UPSTREAM_ERROR (recoverable)` ⇒ 浏览器共 2 条。

### 修复前 · 臂 C（对照）— `sess_LsbN1waqgJSV62Lsa4QKm`

```
+  1502ms >> conversation.item.create / response.create
+  2336ms << conversation.item.created     item.type=message item.role=user
+  2634ms << response.created              resp_AKo4EXpX4JhREKA8QIJfy
+  2634ms << conversation.item.created     item.type=function_call call_id=call_19fc7d646ba449029c17e53f
+  2681ms << response.done                 status=completed
+  8681ms >> conversation.item.create      ← output 发出（同样压满 6000 ms，但不推语音）
+  8681ms >> response.create
+  8874ms << conversation.item.created     item.type=function_call_output  ← 193 ms 后被接受
+  9175ms << response.created
+  9334ms << response.done                 status=completed
```

同样压住 6000 ms、同样在 `response.done` 之后再发 output，唯一差别是没有 `speech_started`——结果被接受。**这就是把「延迟」排除、把「新用户输入」钉住的对照。**

### 修复后 · 臂 R（同一臂）— `sess_ZpMQjCeVOzZ1t7DKc1Hak`

```
+  1501ms >> conversation.item.create / response.create
+  1600ms << conversation.item.created     item.type=message item.role=user
+  1935ms << response.created              resp_UM7IcCi2pVSETBIynWIik
+  1935ms << conversation.item.created     item.type=function_call call_id=call_6ff31e5d9b054928972fed4b
+  1980ms << response.function_call_arguments.done  name=ui_visible_context
+  1982ms << response.done                 status=completed
+  2648ms << input_audio_buffer.speech_started      ← 用户开口
+  2867ms << conversation.item.created     item.type=message item.role=user
+  3515ms << input_audio_buffer.speech_started
+  3913ms << conversation.item.created     item.type=message item.role=user
+  4215ms << response.created              resp_HenQoFCHndQDwkMAwLajr
+  4872ms << response.done                 status=completed
+  5133ms << input_audio_buffer.speech_started
+  6522ms << input_audio_buffer.speech_started
+  6849ms << conversation.item.created     item.type=message item.role=user
+  （到此 hold 满，执行器返回 —— 结果被判 superseded，没有 >> conversation.item.create、没有 >> response.create）
```

transport 日志：`function_call_output receipt call_id=call_6ff31e5d9b054928972fed4b state=superseded turn_seq=1 now=9`。
不存在「发出后被拒」的帧，因为**发送本身没有发生**。

### 修复后 · 臂 C（常规路径未变）

```
+  7929ms >> conversation.item.create / response.create
+  8018ms << conversation.item.created     item.type=function_call_output   ← 89 ms 后被接受
+  8270ms << response.created              resp_K6XWG9fAktfzn8BiUQ6BH
+  8451ms << response.done                 status=completed
```

transport 日志为空：没有出错时状态机**一个字都不记**（`output-sent`/`acked` 刻意不写 journal，避免把日志淹掉）。

## 与 live journal `b5d01c21` 的关系：为什么「预防」和「吸收」两半都必要

同一条连接（`~/.cloudcli/voice-realtime-log/b5d01c21-3f53-4228-a28e-d18b7cb967f7.jsonl`）的机械计数：**17 次 output 发出、9 次被接受（`item.created type=function_call_output`）、8 次被拒**。8 次拒绝逐条配对到它自己那次发送：

| # | call_id | output 发出 | 其后首句 `speech_started` | Δ(发出→首句) | 拒绝到达 | Δ(发出→拒绝) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `call_aedf7e189f4b4dfb8e7d7347` | +32.226 s | +35.196 s | 2.970 s | +36.129 s | 3.903 s |
| 2 | `call_7edccc16ca034026ac50fa5c` | +44.040 s | +45.658 s | 1.618 s | +51.273 s | 7.233 s |
| 3 | `call_ac1fb358db7a47cf927c9cff` | +60.343 s | +60.563 s | 0.220 s | +63.742 s | 3.399 s |
| 4 | `call_45712594c263426db939ad4a` | +69.150 s | +69.158 s | 0.008 s | +71.273 s | 2.123 s |
| 5 | `call_2176f352dd164f4dbe4feb58` | +129.418 s | +129.655 s | 0.237 s | +135.526 s | 6.108 s |
| 6 | `call_e9fde9ff7795496190bc2b5e` | +137.905 s | +137.906 s | 0.001 s | +141.585 s | 3.680 s |
| 7 | `call_de49a41f91b94174b9b79506` | +182.443 s | +184.205 s | 1.762 s | +186.706 s | 4.263 s |
| 8 | `call_c499e79a035c46a4bc55b95e` | +251.478 s | +252.421 s | 0.943 s | +256.240 s | 4.762 s |

**8/8 都是「先发 output、后开口」**（发出→首句 1 ms–2.970 s，其中两次仅 1–8 ms），拒绝在发出后 2.1–7.2 s 才到达。

这条读数决定了修复必须有两半，缺一不可：

- **预防（superseded）**：发送那一刻若回合已被新用户输入取代，就不发。这条覆盖的是**探针臂 R** 那种次序（执行器慢、人先开口），也是任务书 Plan 写下的次序。对 journal 的 8 次它**一次也覆盖不到**：那 8 次在发出时回合还没变。
- **吸收（rejected）**：上游已经拒了，就把这对错误帧在 transport 层收下、记进 journal、不冒泡给浏览器。这条覆盖 **journal 里全部 8 次**真实发生。

只做前半，journal 的 8 次一条不减；只做后半，浏览器不红了但上游会话仍留下被拒的 output（模型上下文里的空洞）。两半都做，才同时满足「浏览器零错误」与「不再在上游留下被拒 output」。

**为什么臂 A（同样是「先发 output」次序）两次都没重现。** 臂 A 的 output 在 function_call 后约 2 ms 发出、约 200 ms 就被接受，而这条连接里人开口最早也在 +2141 ms（修复后）/ +2669 ms（修复前第 2 次）——语音落在**窗口之后**，所以不触发。journal 里那 8 次则相反：它们的回执窗口比这两次长（同场被接受的 9 次回执耗时 0.2–0.7 s 不等，被拒的这 8 次根本等不到回执），人被推到窗口内 1 ms–2.97 s 处开口，于是被拒。换句话说，**触发条件是「语音落在回执窗口内」这件事本身，而不是「谁先谁后」这一条静态次序**；臂 R 之所以能稳定重现，正是因为它把语音**必然**推进了窗口。

## 范围外（已知，本次未改）

**臂 A 的 `Response request cancelled by new input`。** 修复前后都出现，各 1 条（修复前 `sess_Sub3Fka37bkNhbmJdsbM4`、修复后 `sess_VSMDy4hcbPLgzdLvB9ZNE`，两次都在 output 发出后约 74–80 ms 与人开口同刻到达）。它与本缺陷**不同因**：本缺陷是「call 已经不被持有 ⇒ 结果被拒」，这条是「output 被接受了，但为它合成的 `response.create` 撞上了用户新输入 ⇒ 该 response 被 cancel」。此时 `conversation.item.created(type=function_call_output)` 已经到达（臂 A 修复前 +2264 ms 收到回执、+2669 ms 才收到这条错误），也就是**结果已经进了上游会话**，并没有形成被拒空洞。

吸收它需要 transport 把「上游取消了它自己合成的那次 resume」回报给 bridge、并由 bridge 释放对应的 follow-up credit——那是另一条链路（`followUpResponsesExpected` 的记账），改动面在 bridge 而不在回执行，且与「工具结果被拒」不是同一个判据。因此本次**刻意不吸收**，在此记录一条独立读数，留给后续任务。

## 结论

1. **归因：证实。** 触发条件是「发送 output 时该回合已被新的用户输入取代」；`owningResponseCancelled` 与 `synthesizedCreateCollision` 两个候选在真实上游上均被排除（修复前臂 R 与臂 C 的 ownership `response.done` 都是 `status=completed`，且合成 `response.create` 时上游没有进行中的 response）。
2. **修复生效。** 同一臂 R 在修复后：拒收 0、浏览器 `UPSTREAM_ERROR` 0、`output发出=0` 且 journal 记 `state=superseded`；同一臂 C 常规路径一字未动（发出并被接受、无回执行）。
3. **journal 的 8 次真实拒绝全部由「吸收」这一半覆盖**，「预防」这一半覆盖的是探针臂 R 那种次序——两半缺一不可。
