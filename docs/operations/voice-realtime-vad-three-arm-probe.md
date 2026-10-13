# 服务端 VAD 三臂同源回放（A 不门控 / B 出货 STS 门控 / C 只观察不裁剪）

本文件由 `experiments/voice-realtime-vad-three-arm/probe.mts` 生成。三臂跑在**同一段真实上行音频**的**同一个 excerpt**（同起点、同长度）上，把「本地检测质量」与「模型输入干预」分开：A 是第三次实测的生产形态（不门控），B 用**出货的** `createSilenceTailGate` 裁剪上行，C 用**同一个** gate 只观察、记录决策、一帧不裁。

运行时刻 2026-10-13T06:29:45.831Z；运行目录 `/tmp/vad3`（每臂一份 journal 在 `journal/`，gate 逐帧决策另存 `<臂>-<conn>.gate.jsonl`）。执行面 **dry-run**：会话声明的 `session_send` 由脚本内的记录式执行器承接，模型每次调用只被记录并回一个合成 output，**不落任何真实会话**。直连上游 realtime 端点，不经 :3001。

**运行次数：1**（下表全部读数来自同一次完整运行的那一个快照）。花费 ¥0.0200（每连接上限 ¥0.05、总上限 ¥0.5；触顶连接 0 条）。:3001 pid 366403 → 366403（**相同**，未重启）。外联仅 wss://dashscope.aliyuncs.com/api-ws/v1/realtime；生产环境变量改动 0 条。

## AC1 来源对应表（offsetMs → itemId → transcription → session_send）

源会话 `af5559c0-d347-41f3-a6f0-f02a597af1e9`；音频 `/data/home/yale/.cloudcli/voice-realtime-capture/af5559c0-d347-41f3-a6f0-f02a597af1e9.wav`（11925120 字节 PCM16 / 16000 Hz / 1 ch / 16 bit / 共 372.66 s；data chunk 偏移 44 字节——**读出来的**，不是假设 44）。与同目录 timeline 的 `final` 行逐位吻合：`dataBytes` 11925120、`durationMs` 372660 ms（开跑前核对，不等即抛）。

**转发真值来源：journal.session_send** —— 模型自己的 `session_send` function call。**CLI transcript 未被用作转发真值**：本表的每一行都由 capture `committed` + journal `transcription.completed` + journal `function_call session_send` 三股流建立，没有任何一行取自 CLI/UI 侧视图；journal 里的 `to-browser caption` 流（18 条）只被**计数**用于对照，**不参与真值**。

三股流的条数：`committed` 18 ↔ `transcription.completed` 18 ↔ `function_call session_send` 13；journal 里真正落库的 `session_send` 条目 12 条（模型一次调用可合并同段的多句，故条目数可少于调用数）。committed ↔ transcription 按**到达顺序**一一对应，条数不等即抛。

| # | offsetMs | itemId | transcription | session_send（模型转发） | 在 excerpt 内 |
| --- | --- | --- | --- | --- | --- |
| 0 | 4930 | `item_Ss4ZScUpcvQlRJBSCLyIW` | 好，现在我们再次测一下Live Voice Mode。 | 好，现在我们再次测一下 live voice mode。 | ✓ |
| 1 | 9178 | `item_C9iWii11txqPiJz2Gp3b1` | 哎，上面这句话是不是很快？ | **（无）** | ✓ |
| 2 | 19372 | `item_OnNOB6Z74dQos398R6oyG` | 但好像推理开始的慢一些。 | 但好像推理开始的慢一些。 | ✓ |
| 3 | 33744 | `item_SiU9vz99CyIiFRGXsGZTi` | 当连续有多句的时候。 | 当连续有多句的时候，顺序还是错的。 | ✓ |
| 4 | 35101 | `item_M8JUtKbFGYOXvAIDjcAFA` | 顺序还是错的。 | 当连续有多句的时候，顺序还是错的。 | ✓ |
| 5 | 53168 | `item_M73pcXY75Dbr48Blg6Q2Z` | 到现在为止，我第二句话还是没有被处理。 | 到现在为止，我第二句话还是没有被处理。 | ✓ |
| 6 | 95448 | `item_OoJbtp6rIOWaseAynUHfe` | 是的，就是你列出的第一组。 | 是的，就是你列出的第一组。 | — |
| 7 | 111201 | `item_VfnCOM58iNZhT4tavlZxf` | 实际上，在我的屏幕上，你的第一组后面那句话，哎，上面这句是不是很快？ | **（无）** | — |
| 8 | 113841 | `item_WOpR9irqG43T1Ufkde2PI` | 一直被作为一个气泡被保留着。 | 实际上在我的屏幕上，你的第一组后面那句话“哎，上面这句是不是很快？”一直被作为一个气泡被保留着。 | — |
| 9 | 167017 | `item_Urd3Y3rczPtw5ThhjFC2h` | 请讨论更根本的解决方案。 | 请讨论更根本的解决方案。 | — |
| 10 | 212714 | `item_HcAVysgzCZASAmTNELSfp` | 现在，在我的屏幕上，底部又多出了一个“waiting in the queue”的。 | **（无）** | — |
| 11 | 215067 | `item_FAO7Cc18YYz2bjdQVEvqK` | 呃。 | **（无）** | — |
| 12 | 216789 | `item_KdqElEuAxsYOW9rr9Hm4M` | 不管叫泡泡，或者说label。 | 现在在我的屏幕上，底部又多出了一个“waiting in the queue”这么一个不管叫泡泡或者说 label。 | — |
| 13 | 247196 | `item_CzPil1pDLHizxIPRQI75Q` | 我刚说这玩意儿消失了，但是又又多出了两个泡泡，以两个无法消失的气泡。 | **（无）** | — |
| 14 | 305041 | `item_DvhprZUhlVBuhPH5sL8Xl` | 到现在为止，看呢，每句话都能够实际被识别出来，并推到 Kafka 的处理。 | **（无）** | — |
| 15 | 308078 | `item_O4YS7K2b2tajKWOyJNqNY` | 但是在前端交互上还有非常多的问题。 | 到现在为止看呢，每句话都能够实际被识别出来并推到 Claude Code 的处理，但是在前端交互上还有非常多的问题。 | — |
| 16 | 327360 | `item_SJB2aqJXaw3VrDB6M6Afq` | 那我希望啊，用 Fake Provider 等本地机制可以模拟所有这些问题。 | 那我希望啊，用 fake provider 等本地机制可以模拟所有这些问题。 | — |
| 17 | 338594 | `item_WNyBlZzaGli1ZL4WBjESZ` | 现在屏幕上已经有三行未听的Q了。 | **（无）** | — |

**「听了没转发」**（全表 18 行）：**有转写、但没有任何一条转发文本字面覆盖它**的共 7 条：#1「哎，上面这句话是不是很快？」、#7「实际上，在我的屏幕上，你的第一组后面那句话，哎，上面这句是不是很快？」、#10「现在，在我的屏幕上，底部又多出了一个“waiting in the queue”的。」、#11「呃。」、#13「我刚说这玩意儿消失了，但是又又多出了两个泡泡，以两个无法消失的气泡。」、#14「到现在为止，看呢，每句话都能够实际被识别出来，并推到 Kafka 的处理。」、#17「现在屏幕上已经有三行未听的Q了。」。 excerpt 窗口内 6 行中该缺口为 1 条（#1）。

两点必须说清楚，以免把读数读成结论：(1) 本表的「覆盖」是**字面**包含关系（归一化标点/空白/大小写后）。模型**改写**过的句子（例如把「是不是很快」写成「识别的很快」、把「Kafka」写成「Claude Code」）字面上不覆盖原句，于是被计入缺口——这是**保真**读数，不是丢句。(2) 任务 Proposal 里的「5 句听了没转发」是 `18 committed − 13 function_call` 这条**算术**；其中多数是**被合并**进邻近一次转发的（合并句的文本仍随合并体送达），按字面覆盖读出的缺口与这个算术不是同一件事，本报告按字面覆盖读数写，并把两者都点出来。

**取假形态（AC1）**：`--falsify-forward-truth=cli-transcript` 把转发真值换成 `to-browser caption` 流（CLI/UI 侧视图），即「拿 CLI transcript 当转发真值」。这条命令**跑得起来**，但它跑出的快照里 `forwardTruthSource=cli-transcript`、`cliTranscriptUsedAsForwardTruth=true`，AC1 断言随即变红、脚本以非零码退出。⛔ 本报告由**生成它的那一次运行**的一个快照渲染而成，因此这里只写**机制与它打红哪条断言**，不写实测结论；假形态各自的实测快照、日志与退出码是**独立**跑的，落在运行目录的 `falsify-*/` 子目录里（同一目录下 `snapshot.json` 即该次运行）。

## AC2/AC5 运行设置

- excerpt：源音频内起点 0 ms、长度 90000 ms（上限 90000 ms）——**三臂完全相同**。
- 帧：20 ms / 帧（640 字节 PCM16），按**实时墙钟**逐帧推进（近似浏览器上行）。
- `turn_detection`（出货 `resolveTurnDetection({})`，**三臂逐字节相同**）：`{"type":"server_vad","threshold":0.5,"silence_duration_ms":400}`
- 模型 qwen3.8-omni-flash-realtime / voice Tina；工具 `session_send` 由脚本内记录式执行器承接（dry-run）。
- 上限：`--cap` ¥0.05/连接、`--total-cap` ¥0.5、`--excerpt-ms` 上限 90000；**单次运行**（runs=1）。
- 复现命令：`npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-vad-three-arm/probe.mts --work /tmp/vad3`

## AC3 每臂六项读数

| 读数 | A（不门控） | B（STS 门控） | C（只观察） |
| --- | --- | --- | --- |
| 1 上传秒数 / 帧数 | 90 s / 4500 帧 | 90 s / 4500 帧 | 90 s / 4500 帧 |
| 1b 上传字节 / 占 excerpt | 2880000 B / 100.0% | 2880000 B / 100.0% | 2880000 B / 100.0% |
| 2 静音占比（源语料侧） | 83.5%（源语音 14873 ms） | 83.5%（源语音 14873 ms） | 83.5%（源语音 14873 ms） |
| 2b 静音占比（上游侧，本臂） | 82.1%（上游判出 6 段 / 16118 ms） | 83.4%（上游判出 6 段 / 14906 ms） | 80.3%（上游判出 6 段 / 17763 ms） |
| 3 首 token 延时 | 279 ms | 312 ms | 276 ms |
| 4 首次 function_call 延时 | 422 ms | 452 ms | 419 ms |
| 5 转发文本保真 | 5/6（83.3%）（转出 6 条、转发 5 条） | 5/6（83.3%）（转出 6 条、转发 5 条） | 4/6（66.7%）（转出 6 条、转发 5 条） |
| 6 丢段数 / 错误中断数 | 0 / 0 | 0 / 0 | 0 / 1 |
| 实际花费（CNY，出货估算器） | ¥0.0068 | ¥0.0068 | ¥0.0066 |
| 实际时长（连接建立到收尾） | 96.369 s | 95.437 s | 95.802 s |
| 断线读数（上游主动断线？close code/reason） | 否 / —  | 否 / —  | 否 / —  |

本批次收到的上游 / 连接错误（原样，不改写；「错误中断数」一列 = 这些错误条数 + 上游主动断线计 1 + 花费触顶计 1）：

- **A**：无
- **B**：无
- **C**：`upstream: {"event_id":"event_QUStX8eyIg5FGENnkpbVr","type":"error","error":{"type":"invalid_request_error","message":"Unknown function call id: call_59d9ca89da3e4f02981e594b","param":"call_id"}}`

- 延时的基准是**本臂自己收到的首个 `input_audio_buffer.speech_stopped`**（上游开始收尾的那一刻），不是本地帧序号；三臂同一段音频，故基准可比。保真的分母是 excerpt 窗口内**有转写**的真值句数（即上表第 5 行分数里的分母），分子是本臂转发文本里**字面覆盖**了它的条数；窗口内 committed 行数为 6，其中 0 行没有转写、不计入分母。

逐段延时（`段起点ms/首delta/首call`，`—` 代表该段之后本臂没有对应的 delta / 调用）：

| 臂 | 逐段读数 |
| --- | --- |
| A | 7982/279/422；13014/305/442；22427/358/494；36746/1757/1901；38207/296/440；57224/321/461 |
| B | 6932/312/452；11170/277/393；21329/289/405；35730/1671/1810；37099/302/441；55172/329/469 |
| C | 8521/276/419；13259/287/424；24588/307/423；42240/1158/1253；43088/310/405；62922/323/463 |

## B 臂为何与 A 臂逐字节相同：语料帧分布 vs 出货门控的实测人声下限

B 臂的上传与 A 臂逐字节相同，**同时** B 臂门控的读数是「本臂未写出 0 ms、suppressed 转移 0 次」——也就是说：**这一次回放里干预根本没有发生**。这两句话必须分开说：B==A 只能说明「本语料上没有产生干预」，**不能**推广成「服务端 VAD 对上行没有影响」。下面是支持这个读法的数（全部由本探针离线实测）。

| 量 | 值 |
| --- | --- |
| excerpt 帧数 | 4500（每帧 20 ms） |
| excerpt 逐帧 RMS 分位数 | p15 35.706（-59.254 dBFS） / p50 62.406（-54.404 dBFS） / p95 1764.25（-25.378 dBFS） |
| excerpt 最低帧 | 0（-90.309 dBFS） |
| **出货门控实测人声下限** | **-61 dBFS**（对 `createSilenceTailGate({})` 逐电平实测，见 `measureShippedVoiceFloorDb`） |
| excerpt 中低于该下限的帧（唯一能推进挂起窗的部分） | 305 / 4500 = **6.8%** |

读法：出货 STS 的挂起要靠**连续 320 ms 的非人声帧**（16 帧）把 `quietMs` 推过 `SILENCE_TAIL_HANGOVER_MS`。上表显示这段真实上行的帧电平几乎全部高于门控自己的人声下限（只有 6.8% 低于它），连续 16 帧非人声的窗口从未出现，挂起态因此从未进入 —— 门控全程停在 `streaming`，一帧不裁，B 与 A 自然逐字节相同。上面那个「人声下限」是**量出来的**，不是从源码抄的：门控的阈值常数（`SILENCE_TAIL_MAX_THRESHOLD_DB` / `SILENCE_TAIL_HARD_FLOOR_DB` / `SILENCE_TAIL_VOICE_MARGIN_DB`）没有从 barrel 导出，而 `stage` 是门控自己的公开读数 —— 逐电平实测得到的下限因此是对门控**真实判定**的一次观测，而不是一份会漂移的常数副本。

**这条边界的实际含义**：B 臂在这个语料上不是「门控无效」的证据，而是「门控在这段音频上没有可裁之处」。要真正测出裁剪对模型输入的影响，需要一个**帧电平能落进门控判定区的语料**（例如远场低电平录音，或把门控的 tail/preroll 之外的判定阈值做成可注入参数）——这超出本任务的 Touches 与授权范围，本报告只把它作为限制写明。

**与第 2 行的表面矛盾，以及它为什么不矛盾**：AC3 表里「静音占比（源语料侧）」是 83.5%，看起来「八成是静音」，门控却一次未裁。两者量的**不是同一件事**：源语料侧那一列用的是 capture timeline 记录的**上游** `speech_started/stopped` —— 上游判「没人说话」；而门控判的是**帧电平**。这段录音的底噪本身就在门控的人声下限之上（帧 RMS 的 p15 = 35.706 ≈ -59.254 dBFS，中位数 62.406 ≈ -54.404 dBFS，都远高于下限对应的 RMS），所以「上游眼里的静音」在门控眼里仍然是**有人声的电平**。更要紧的是挂起要求**连续 16 帧**低于下限，而低于下限的帧只占 6.8% 且分散 —— 连续窗口从未成形。这也说明为什么「静音占比高」推不出「门控会裁」：后者取决于**电平是否跌穿门控自己的阈值**，而不是上游怎么断句。

## AC4 C 臂证明「只观察不裁剪」

C 的上传帧数 **4500**、字节 **2880000**、毫秒 **90000** 与 A 的 **4500** / **2880000** / **90000** **逐帧相等**（断言已核对三项）。同时 C 的 gate 记录了 **4500** 条决策（== C 的上传帧数），其中 gate 建议裁掉的音频累计 **0 ms**，而 C 一帧也没裁（`ignoredSuppressions=0` 帧）——这正是 `localSpeechGate` 的产品语义：只观察、不裁剪。

**取假形态（F2，AC4）**：`--falsify-c-suppresses` 让 C 也裁剪 —— C 的上传随即小于 A，AC4 断言变红、脚本非零码退出。这条命令的实测快照落在运行目录的 `falsify-c-suppresses/` 子目录。

**这条假形态为什么要「额外吞掉前导 500 ms」而不是只把 C 的策略换成照抄 gate 的决定**：因为在这个语料上出货门控**一次也没裁**（见上一节：只有 6.8% 的帧低于门控实测人声下限，320 ms 的连续挂起窗口从未成形）。照抄 gate 决定的 C 会**悄悄退化成 no-op**：上传仍与 A 逐字节相同、决策数仍等于上传帧数，AC4 依旧绿 —— 那条假形态就什么也没证伪。所以 F2 做成一次**声明式违背**：C 在开头额外吞掉前导窗口，`C.uploadedFrames < A.uploadedFrames` 且 `decisionsRecorded != uploadedFrames` 必然成立，AC4 必然变红。换句话说，F2 证明的是**断言会红**（AC4 非空洞），它读的不是「门控在本语料上能否裁」—— 后者恰恰是本语料回答不了的。

## 取假形态（机制，非本次运行的读数）

两条假形态都是**真的跑得起来**的命令，各自只把一条断言打红。`--excerpt-ms` 只影响时长与花费，不影响这两条断言的方向；下表只说明**红在哪个字段上**。两条命令各自的实测快照与退出码见运行目录的 `falsify-forward-truth-cli-transcript/` 与 `falsify-c-suppresses/`。

| # | 假形态命令 | 变红的断言 | 机制 |
| --- | --- | --- | --- |
| F1 | `--falsify-forward-truth=cli-transcript` | AC1 | 转发真值被换成 `to-browser caption`（CLI/UI 侧视图），`forwardTruthSource` 不再是 `journal.session_send`、`cliTranscriptUsedAsForwardTruth` 变 true |
| F2 | `--falsify-c-suppresses` | AC4 | C 也裁剪：走裁剪分支并额外吞掉前导 500 ms —— `C.uploadedFrames/Bytes/Ms` 不再等于 A 的三项，且 `decisionsRecorded != uploadedFrames`（为什么不能只换策略：见上一节） |

两次假形态运行的实测读数（命令、退出码、被点名的 FAIL 行）由本轮任务的实施记录留证；本报告由**正常形态**的那一次运行生成，所以下表读数里不含假形态。

## DoD 结论：服务端 VAD 是否影响上游 PCM 与 turn_detection

**判定：未观察到影响 —— 且干预在本语料上未发生（门控一次未裁）**。依据：A 上传 90s、B 上传 90s、C 上传 90s（C 应与 A 相等：true）；模型侧：A 转写 6/转发 5，B 转写 6/转发 5、C 转写 6/转发 5；B 臂门控未写出 0 ms、suppressed 转移 0 次 ⇒ 干预未发生（实测人声下限 -61 dBFS，excerpt 中低于此的帧仅 305/4500 = 6.8%，挂起窗从未满足），因此 B/A 相等**不等于**「服务端 VAD 对上行无影响」

- **对 `turn_detection`：无影响（结构性）**。三臂的 `session.update` 里 `turn_detection` 都是 `{"type":"server_vad","threshold":0.5,"silence_duration_ms":400}`，由**出货解析器** `resolveTurnDetection({})` 给出；gate 的返回面只有「要写哪些帧」，没有任何写 `turn_detection` 的路径。本探针也没有在生产面设过任何 STS 环境变量（`productionEnvTouched` 为空）。
- **对上游 PCM —— 逐个臂按实测读数说，不预设结论**。B 臂的 gate **一次未裁**（未写出 0 ms、suppressed 转移 0 次），上传 90s 与 A 的 90s 逐字节相同 —— 本次回放里「裁剪」这个干预**没有发生**，所以这一行不能读成「门控对上行无影响」，只能读成「本语料没有给出可裁之处」（原因见上一节的帧分布）。 C 与 A 的逐帧相等（4500 帧 / 2880000 字节）是「只观察」这一语义的直接读数。
- **检测质量与输入干预已分离**：C 的**上行**与 A 逐字节相同（这是「只观察」的结构性保证，AC4 断言），所以 C−A 在**上传量**上的差异恒为 0；两者**模型侧**读数的差异因此不能归因于输入，只能是逐次运行的抖动。B−A 才是「干预」的效果。本次 B 的 `withheldMs` 为 0：**没有干预可供归因**，B−A 的模型侧差异（若有）也只能是采样噪声，不能算作门控的效果。
- **本批次里 C 与 A 的模型侧读数并不相同**（A 转写 6/转发 5/中断 0；C 转写 6/转发 5/中断 1），而两者的上行逐字节相同 —— 这正是「单次运行、每臂一条连接」下**固有的抖动**：同一份输入重复喂给同一个上游模型，转发文本条数与逐字保真都不保证复现。C 臂的那次中断是一条上游错误（见 AC3 表格下方的错误列表）。结论行因此只对**上传量**作断言，不对模型侧条数作断言。
- 上游侧静音占比是独立一列（2b）：它是「上游自己怎么判这段音频」的读数。A/C 应与源语料侧的判读大体一致；B 若因裁剪而改变上游判读，会在这一列上看出来。

## AC7 读数不足时的写法

规则是**一条**：模型侧读数不齐的臂不得进入结论 —— 每个臂在成文前先自检六项读数，缺任何一项就记下缺项，该臂的 `sufficient` 变 false、`insufficientReason` 写明缺了什么，结论行**改为**「不足以判断」并带上这些缺项；缺 A 臂（生产形态基准）或缺 A/C 之一时同样直接判「不足以判断」，不允许用缺失当证据（`deriveConclusion` 的三个早退分支）。

本次运行三臂读数**均齐备**，因此结论按实测写，不触发「不足以判断」。各臂缺项：A（无）、B（无）、C（无）。

自检的六项与 AC3 的六项同源：上传帧数 > 0、上游判出至少一个语音段、至少一条转写、有首 token 延时、有首次 `function_call` 延时、转发保真可算（真值句非空）。

## 断言逐条

- [x] **AC1** — 来源对应表 18 行（offsetMs → itemId → transcription → session_send）；转发真值来源=journal.session_send；CLI transcript 用作转发真值=false；committed 18 ↔ transcription 18 ↔ function_call 13（journal session_send 条目 12；caption 流 18 条，**未**用作真值）；excerpt 内真值句 6 条
- [x] **AC2** — 同源同起点同长度：源 af5559c0-d347-41f3-a6f0-f02a597af1e9、起点 0 ms、excerpt 90000 ms；实跑臂 A/B/C；退出码 0 且写 snapshot.json
- [x] **AC3** — 三臂六项读数齐备：上传秒数/帧数、静音占比、首 token 延时、首次 function_call 延时、转发保真、丢段+错误中断
- [x] **AC4** — C 上传 帧 4500 / 字节 2880000 / 毫秒 90000 vs A 上传 帧 4500 / 字节 2880000 / 毫秒 90000；C 记录决策 4500 条（应 == C 上传帧数）；C 本会裁掉 0 ms 但一帧未裁（ignoredSuppressions=0）
- [x] **AC5** — excerpt 90000 ms ≤ 上限 90000 ms；单次运行（runs=1）；实际花费 ¥0.0202（每连接上限 ¥0.05、总上限 ¥0.5）；触顶连接 0 条；实际总时长 287608 ms
- [x] **AC6** — :3001 pid 运行前 366403 → 运行后 366403（相同=true，未重启）；生产环境变量改动 0 条（gate 在探针内构造）；外联仅 wss://dashscope.aliyuncs.com/api-ws/v1/realtime
- [x] **AC7** — 三臂模型侧读数均足够，结论可用

## 方法与限制

- 语料是**真实**上行捕获（continuous 路径才捕获：`frame.seq === undefined`），不是脚本内构造的片段；excerpt 取源音频的一段固定窗口。
- 转发真值来自 journal 的 `<< function_call session_send`；`committed` ↔ `transcription.completed` 按到达顺序一一对应，条数不等即抛错，不做猜测性对齐。
- 静音占比两列：**源语料侧**由真实 capture timeline 的 `speech_started/stopped` 在窗口内的部分算出（与臂无关）；**上游侧**由本臂自己收到的 `speech_started/stopped` 算出。
- 本探针**不写任何生产环境变量**：gate 在探针内 `createSilenceTailGate({})` 构造（出货默认 T=1000 ms / P=500 ms / keepalive=30 s）。
- 单次运行、每臂一条全新连接；本实验**不追求统计功效**，只要求三臂同源可比。读数差异不足以支撑跨样本的泛化结论。
- **本语料的边界（重要）**：出货门控的实测人声下限是 -61 dBFS，而这段真实上行只有 6.8% 的帧低于它 —— 所以 B 臂的门控在这段音频上**没有可裁之处**。凡涉及「裁剪会不会改变模型输入」的问题，本语料**给不出**答案（不是「给了否定答案」）；要测它需要一个帧电平落进门控判定区的语料。
- 上游 realtime 端点本身是唯一外联；`turn_detection` 由出货解析器给出，三臂相同；本探针没有任何写 `turn_detection` 的代码路径。

来源对应表全文与逐帧读数见 `/tmp/vad3/snapshot.json` 与 `journal/`。
