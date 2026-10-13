# 服务端 VAD 三臂同源回放（A 不门控 / B 出货 STS 门控 / C 只观察不裁剪）

本文件由 `experiments/voice-realtime-vad-three-arm/probe.mts` 生成。三臂跑在**同一段真实上行音频**的**同一个 excerpt**（同起点、同长度）上，把「本地检测质量」与「模型输入干预」分开：A 是第三次实测的生产形态（不门控），B 用**出货的** `createSilenceTailGate` 裁剪上行，C 用**同一个** gate 只观察、记录决策、一帧不裁。

运行时刻 2026-10-13T06:58:49.476Z；运行目录 `/tmp/vad3`（每臂一份 journal 在 `journal/`，gate 逐帧决策另存 `<臂>-<conn>.gate.jsonl`）。执行面 **dry-run**：会话声明的 `session_send` 由脚本内的记录式执行器承接，模型每次调用只被记录并回一个合成 output，**不落任何真实会话**。直连上游 realtime 端点，不经 :3001。

**运行次数：1**（下表全部读数来自同一次完整运行的那一个快照）。花费 ¥0.0200（每连接上限 ¥0.05、总上限 ¥0.5；触顶连接 0 条）。:3001 pid 366403 → 366403（**相同**，未重启）。外联仅 wss://dashscope.aliyuncs.com/api-ws/v1/realtime；生产环境变量改动 0 条。

## AC1 职责边界：本实验只过滤，不参与「什么时候算说完」

人 2026-10-13 的唯一职责裁定：**「服务端 VAD」只对上行 PCM 做 speech / non-speech 分类、过滤无语音帧，减少传到 Realtime upstream 的音频数据**；它是纯传输侧的节流器，与"什么时候算说完"正交。

本探针把这条边界落成**机械判据**（断言的输入是各臂 journal 里**实际发出**的帧型，不是自述）：

| 硬禁令 | 本实验的证据 | 实测 |
| --- | --- | --- |
| 不引入 turn detection / endpointing / 语义提交 / `response.create` | 各臂上行帧型全集（见下）不含 `response.create` | 未出现 |
| — 帧型 `conversation.item.create` | 各臂发出次数 | A 5 / B 5 / C 5 |
| — 帧型 `input_audio_buffer.append` | 各臂发出次数 | A 4500 / B 4500 / C 4500 |
| — 帧型 `session.update` | 各臂发出次数 | A 1 / B 1 / C 1 |
| 不改变上游 `turn_detection` | 从各臂**实际发出的** `session.update` 里读回 `session.turn_detection`（即真正上网的那个值），与出货解析器逐字节比 | 三臂均与出货一致：`{"type":"server_vad","threshold":0.5,"silence_duration_ms":400}` |
| 不把边界事件用于模型触发 / commit | 由服务端 VAD 边界事件驱动的 `response.create` | A 0 次 / B 0 次 / C 0 次 |

**取假形态 F3**：`--falsify-b-boundary-response-create` 让 B 臂在源 timeline 的**第一个 `speech_stopped` 边界**上发一次 `response.create`——这正是禁令点名的接线形态。跑出来 AC1 即红。

另外：探针**自己没有** commit 上行音频（没有 `input_audio_buffer.commit`）；会话的 `turn_detection` 是 `server_vad`，上游按它自己的时机提交——那是**上游既有行为**，不是本功能触发的，探针既不干预也不改动它。

## 来源对应表（offsetMs → itemId → transcription → session_send）

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

**取假形态（F1）**：`--falsify-forward-truth=cli-transcript` 把转发真值换成 `to-browser caption` 流（CLI/UI 侧视图），即「拿 CLI transcript 当转发真值」。这条命令**跑得起来**，但它跑出的快照里 `forwardTruthSource=cli-transcript`、`cliTranscriptUsedAsForwardTruth=true`，支撑断言 **S1** 随即变红、脚本以非零码退出。（S1 不是 AC 集里的一条，而是 AC4「转发保真」那一列的分母来源：真值一换，整列的参照系就变了，必须红。）⛔ 本报告由**生成它的那一次运行**的一个快照渲染而成，因此这里只写**机制与它打红哪条断言**，不写实测结论；假形态各自的实测读数来自**各自独立的**一次运行（各写自己的 `--work` 目录，其 `snapshot.json` 即该次运行的快照），连同退出码与被点名的 FAIL 行由本轮任务的实施记录留证。

## AC2/AC7 运行设置

- excerpt：源音频内起点 0 ms、长度 90000 ms（上限 90000 ms）——**三臂完全相同**。
- 帧：20 ms / 帧（640 字节 PCM16），按**实时墙钟**逐帧推进（近似浏览器上行）。
- `turn_detection`（出货 `resolveTurnDetection({})`，**三臂逐字节相同**）：`{"type":"server_vad","threshold":0.5,"silence_duration_ms":400}`
- 模型 qwen3.8-omni-flash-realtime / voice Tina；工具 `session_send` 由脚本内记录式执行器承接（dry-run）。
- 上限：`--cap` ¥0.05/连接、`--total-cap` ¥0.5、`--excerpt-ms` 上限 90000；**单次运行**（runs=1）。
- 复现命令：`npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-vad-three-arm/probe.mts --work /tmp/vad3`

## AC4 每臂六项指标

| 读数 | A（不门控） | B（STS 门控） | C（只观察） |
| --- | --- | --- | --- |
| 1 上传秒数 / 帧数 | 90 s / 4500 帧 | 90 s / 4500 帧 | 90 s / 4500 帧 |
| 1b 上传字节 / 占 excerpt | 2880000 B / 100.0% | 2880000 B / 100.0% | 2880000 B / 100.0% |
| 2 静音占比（源语料侧） | 83.5%（源语音 14873 ms） | 83.5%（源语音 14873 ms） | 83.5%（源语音 14873 ms） |
| 2b 静音占比（上游侧，本臂） | 82.0%（上游判出 6 段 / 16181 ms） | 76.6%（上游判出 6 段 / 21060 ms） | 83.3%（上游判出 6 段 / 14998 ms） |
| 3 首 token 延时 | 376 ms | 278 ms | 324 ms |
| 4 首次 function_call 延时 | 435 ms | 441 ms | 460 ms |
| 5 转发文本保真 | 4/6（66.7%）（转出 6 条、转发 5 条） | 5/6（83.3%）（转出 6 条、转发 5 条） | 5/6（83.3%）（转出 6 条、转发 5 条） |
| 6 丢段数 / 错误中断数 | 0 / 0 | 0 / 1 | 0 / 0 |
| **误删语音**（本臂未写出的音频落在源 timeline speech 区间内的部分） | 0 ms / 0 帧（窗口内源语音共 14873 ms；占 0.00%） | 0 ms / 0 帧（窗口内源语音共 14873 ms；占 0.00%） | 0 ms / 0 帧（窗口内源语音共 14873 ms；占 0.00%） |
| **前滚保留**（resumed 时补发的前导帧：累计 / 单次最长） | 不适用（本臂无门控） | 补发 0 帧 / 单次最长 0 帧；suppressed 时累计被压 0 ms） | 补发 0 帧 / 单次最长 0 帧；suppressed 时累计被压 0 ms） |
| **连接存活**（excerpt 播完时仍连着 = 非上游断线、非触顶） | 是（最长不发送间隔 22 ms） | 是（最长不发送间隔 29 ms） | 是（最长不发送间隔 25 ms） |
| 上行帧型（本臂实际发出） | `{"conversation.item.create":5,"input_audio_buffer.append":4500,"session.update":1}` | `{"conversation.item.create":5,"input_audio_buffer.append":4500,"session.update":1}` | `{"conversation.item.create":5,"input_audio_buffer.append":4500,"session.update":1}` |
| 实际花费（CNY，出货估算器） | ¥0.0068 | ¥0.0066 | ¥0.0068 |
| 实际时长（连接建立到收尾） | 95.808 s | 95.799 s | 95.447 s |
| 断线读数（上游主动断线？close code/reason） | 否 / —  | 否 / —  | 否 / —  |

本批次收到的上游 / 连接错误（原样，不改写；「错误中断数」一列 = 这些错误条数 + 上游主动断线计 1 + 花费触顶计 1）：

- **A**：无
- **B**：`upstream: {"event_id":"event_FMem1aBptXgxhVBpRZvBE","type":"error","error":{"type":"invalid_request_error","message":"Unknown function call id: call_e7e532eb29bb4a069675ce09","param":"call_id"}}`
- **C**：无

- 延时的基准是**本臂自己收到的首个 `input_audio_buffer.speech_stopped`**（上游开始收尾的那一刻），不是本地帧序号；三臂同一段音频，故基准可比。保真的分母是 excerpt 窗口内**有转写**的真值句数（即上表第 5 行分数里的分母），分子是本臂转发文本里**字面覆盖**了它的条数；窗口内 committed 行数为 6，其中 0 行没有转写、不计入分母。

逐段延时（`段起点ms/首delta/首call`，`—` 代表该段之后本臂没有对应的 delta / 调用）：

| 臂 | 逐段读数 |
| --- | --- |
| A | 7460/376/435；12588/279/393；22542/284/404；36198/1867/1987；37778/287/407；55851/321/462 |
| B | 10005/278/441；16297/288/402；25165/271/384；44441/1536/1680；45688/289/433；66036/347/485 |
| C | 6939/324/460；11172/277/391；21330/312/425；35823/1593/1733；37094/322/462；55175/352/490 |

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

## AC3 C 臂证明「只观察不裁剪」

C 的上传帧数 **4500**、字节 **2880000**、毫秒 **90000** 与 A 的 **4500** / **2880000** / **90000** **逐帧相等**（断言已核对三项）。同时 C 的 gate 记录了 **4500** 条决策（== C 的上传帧数），其中 gate 建议裁掉的音频累计 **0 ms**，而 C 一帧也没裁（`ignoredSuppressions=0` 帧）——这正是 `localSpeechGate` 的产品语义：只观察、不裁剪。

**取假形态（F2，AC3）**：`--falsify-c-suppresses` 让 C 也裁剪 —— C 的上传随即小于 A，AC3 断言变红、脚本非零码退出。这条命令**独立**跑一次（自写 `--work` 目录），其快照与退出码由本轮任务的实施记录留证。

**这条假形态为什么要「额外吞掉前导 500 ms」而不是只把 C 的策略换成照抄 gate 的决定**：因为在这个语料上出货门控**一次也没裁**（见上一节：只有 6.8% 的帧低于门控实测人声下限，320 ms 的连续挂起窗口从未成形）。照抄 gate 决定的 C 会**悄悄退化成 no-op**：上传仍与 A 逐字节相同、决策数仍等于上传帧数，AC3 依旧绿 —— 那条假形态就什么也没证伪。所以 F2 做成一次**声明式违背**：C 在开头额外吞掉前导窗口，`C.uploadedFrames < A.uploadedFrames` 且 `decisionsRecorded != uploadedFrames` 必然成立，AC3 必然变红。换句话说，F2 证明的是**断言会红**（AC3 非空洞），它读的不是「门控在本语料上能否裁」—— 后者恰恰是本语料回答不了的。

## AC5 keepalive：需不需要连续静音，以及它与节流目标的冲突

- B 臂（唯一会裁剪的臂）**最长不向上游发送数据的间隔**：29 ms；被门控压住的累计时长 0 ms，其间发出的 keepalive 0 帧 / 0 ms。
- **B 臂是否出现「长时间不发送导致 upstream 断线」**：否（本臂 close：无（探针自收））；连接存活到 excerpt 结束=true。
- **本探针所用的 keepalive：出货门控自带的那个**（`SILENCE_TAIL_KEEPALIVE_MS` 默认 30 s、每帧 100 ms 数字静音），探针没有另加任何 keepalive，也没有为了「不断线」多发过一帧。门控的返回面只有「要写哪些帧」，所以这个 keepalive 就是**连续静音 PCM**。

⚠️ **与节流目标的冲突（必须写明，不得为保住节流数字而隐去）**：若为了让连接活下去而必须周期性发送**连续静音 PCM**，那么这部分字节**正是**本功能想省掉的那一类——静音越多、压得越久，keepalive 发得越多，节流收益被自己吃掉一部分；极端情形（压住的时长接近 keepalive 间隔的整数倍）下，收益会被削到接近 0。这不是理论顾虑，而是出货实现里已经存在的路径：`suppressed` 且 `keepaliveMs > 0` 时，门控每个 keepalive 周期就 push 一帧 `digitalSilence(100 ms)`。

**而且这条 keepalive 未必有效**：既有读数是上游空闲超时**按 response 计**（约 300 s 无 **response** 即 `1007 response_idle_timeout`），而连续上传底噪 297.6 s 同样不重置它（见备忘 `[[upstream-realtime-idle-timeout-is-response-based]]`）。也就是说「发静音保活」很可能既花了字节、又保不住连接 —— 本语料**不足以**判定这一点：本次 excerpt 只有 90 s，B 臂一次都没被压住（suppressed 转移 0 次），既没有触发上游空闲超时的机会，也没有触发 keepalive 的机会（keepalive 帧数见上）。**结论：本语料下无法判断 keepalive 是否必要或有效；要判断它，需要一段把 B 臂压住 ≥ 300 s 的语料。**

**取假形态 F4**：`--falsify-hide-keepalive-conflict` 隐去上面这条冲突 ⇒ AC5 红。（量一下这条假形态有多真：把冲突段删掉，报告读起来会变成「B 一次未裁、keepalive 0 帧、连接健康」——一个干净漂亮的节流故事，而代价恰好被那一段藏住了。）

## AC6 既有旁路：`localSpeechGate` / watchdog 不纳入本功能行为

**显式标注（本节即该标注）**：`localSpeechGate`（`server/modules/voice-realtime/voice-realtime-local-speech.ts`，在 proxy 侧构造）→ `reportLocalSpeechBoundary` → 看门狗这条链是**既有旁路**，**不纳入本任务的「服务端 VAD」功能范围**。本任务里的「服务端 VAD」只指 `silenceTail` / `createSilenceTailGate` 那一个（proxy 里 `decision.frames` 决定转发哪些帧的那个）。

两条链各自 `observe()` 同一帧、**互不喂对方**：STS 决策不进入 `reportLocalSpeechBoundary`，也不进入任何 commit / `response.create` 路径。唯一的相邻接触是 STS 分支内的 `bridge.noteLocalActivity?.()`（注释：a suppressed stretch is not an idle one）——那是**为切断误读而做的解耦**，不是泄漏。因此无需解耦，只需标注。

**本实验如何保证「其边界事件未被计入本功能行为」**（两半，都可机械核对）：(1) 探针从 voice-realtime barrel 只导入 `createSilenceTailGate`、`estimateRealtimeCostCny`、`resolveTurnDetection` —— **不含** `createLocalSpeechGate` / `reportLocalSpeechBoundary`，探针根本没有构造旁路链，也不可能消费它的边界事件；这条由 AC6 断言核对（符号表由探针源码手工维护，导入一变就红）。(2) AC4 的「误删语音」以**源 timeline 的 speech 区间**为分母，不以旁路或上游的边界事件为分母。

## 取假形态（机制，非本次运行的读数）

五条假形态都是**真的跑得起来**的命令，各自只把一条断言打红。`--excerpt-ms` 只影响时长与花费，不影响这五条断言的方向；下表只说明**红在哪个字段上**。各命令**独立**跑一次，其快照与退出码由本轮任务的实施记录留证（**不在**本报告的运行目录里）。

| # | 假形态命令 | 变红的断言 | 机制 |
| --- | --- | --- | --- |
| F1 | `--falsify-forward-truth=cli-transcript` | 支撑材料的真值来源 | 转发真值被换成 `to-browser caption`（CLI/UI 侧视图），`forwardTruthSource` 不再是 `journal.session_send`、`cliTranscriptUsedAsForwardTruth` 变 true |
| F2 | `--falsify-c-suppresses` | AC3 | C 也裁剪：走裁剪分支并额外吞掉前导 500 ms —— `C.uploadedFrames/Bytes/Ms` 不再等于 A 的三项，且 `decisionsRecorded != uploadedFrames`（为什么不能只换策略：见 AC3 一节） |
| F3 | `--falsify-b-boundary-response-create` | AC1 | B 臂在源 timeline 第一个 `speech_stopped` 边界上发一次 `response.create` —— 正是禁令点名的「把服务端 VAD 边界事件用于模型触发」 |
| F4 | `--falsify-hide-keepalive-conflict` | AC5 | 报告里隐去「需要连续静音存活 ⇒ 与节流目标冲突」那一段，只留干净的节流数字 |
| F5 | `--falsify-unannotated-bypass` | AC6 | 报告里省略「`localSpeechGate` / 看门狗是**既有旁路**」的标注 —— 于是它的边界事件有没有被算进本功能行为就无人交代 |

F4 / F5 的判据值得一提：AC5 / AC6 **不判开关**，判的是**渲染出来的报告文本里有没有那个标记串**（`KEEPALIVE_CONFLICT_MARKER` / `BYPASS_ANNOTATION_MARKER`）—— 所以生成器走了「隐去」分支，断言必然红；「开关到开关」的空检查在这里是不成立的。

这五次假形态运行的实测读数（命令、退出码、被点名的 FAIL 行）由本轮任务的实施记录留证；本报告由**正常形态**的那一次运行生成，所以报告里的读数不含假形态。

## DoD 结论：服务端 VAD 是否影响上游 PCM 与 turn_detection

**判定：未观察到影响 —— 且干预在本语料上未发生（门控一次未裁）**。依据：A 上传 90s、B 上传 90s、C 上传 90s（C 应与 A 相等：true）；模型侧：A 转写 6/转发 5，B 转写 6/转发 5、C 转写 6/转发 5；B 臂门控未写出 0 ms、suppressed 转移 0 次 ⇒ 干预未发生（实测人声下限 -61 dBFS，excerpt 中低于此的帧仅 305/4500 = 6.8%，挂起窗从未满足），因此 B/A 相等**不等于**「服务端 VAD 对上行无影响」

- **对 `turn_detection`：无影响（结构性）**。三臂的 `session.update` 里 `turn_detection` 都是 `{"type":"server_vad","threshold":0.5,"silence_duration_ms":400}`，由**出货解析器** `resolveTurnDetection({})` 给出；gate 的返回面只有「要写哪些帧」，没有任何写 `turn_detection` 的路径。本探针也没有在生产面设过任何 STS 环境变量（`productionEnvTouched` 为空）。
- **对上游 PCM —— 逐个臂按实测读数说，不预设结论**。B 臂的 gate **一次未裁**（未写出 0 ms、suppressed 转移 0 次），上传 90s 与 A 的 90s 逐字节相同 —— 本次回放里「裁剪」这个干预**没有发生**，所以这一行不能读成「门控对上行无影响」，只能读成「本语料没有给出可裁之处」（原因见上一节的帧分布）。 C 与 A 的逐帧相等（4500 帧 / 2880000 字节）是「只观察」这一语义的直接读数。
- **检测质量与输入干预已分离**：C 的**上行**与 A 逐字节相同（这是「只观察」的结构性保证，AC3 断言），所以 C−A 在**上传量**上的差异恒为 0；两者**模型侧**读数的差异因此不能归因于输入，只能是逐次运行的抖动。B−A 才是「干预」的效果。本次 B 的 `withheldMs` 为 0：**没有干预可供归因**，B−A 的模型侧差异（若有）也只能是采样噪声，不能算作门控的效果。
- 上游侧静音占比是独立一列（2b）：它是「上游自己怎么判这段音频」的读数。A/C 应与源语料侧的判读大体一致；B 若因裁剪而改变上游判读，会在这一列上看出来。

## AC9 读数不足时的写法

规则是**一条**：模型侧读数不齐的臂不得进入结论 —— 每个臂在成文前先自检六项读数，缺任何一项就记下缺项，该臂的 `sufficient` 变 false、`insufficientReason` 写明缺了什么，结论行**改为**「不足以判断」并带上这些缺项；缺 A 臂（生产形态基准）或缺 A/C 之一时同样直接判「不足以判断」，不允许用缺失当证据（`deriveConclusion` 的三个早退分支）。

本次运行三臂读数**均齐备**，因此结论按实测写，不触发「不足以判断」。各臂缺项：A（无）、B（无）、C（无）。

自检的六项与 AC4 的六项同源：上传帧数 > 0、上游判出至少一个语音段、至少一条转写、有首 token 延时、有首次 `function_call` 延时、转发保真可算（真值句非空）。

## 断言逐条

- [x] **AC1** — 职责边界：三臂都只发 session.update ×1 + input_audio_buffer.append；禁用帧（response.create / input_audio_buffer.commit / input_audio_buffer.clear / response.cancel）共 0 处；由边界事件驱动的 response.create 0 次；三臂 session.update 里的 turn_detection 与出货解析器输出一致=true（{"type":"server_vad","threshold":0.5,"silence_duration_ms":400}）
- [x] **S1** — 来源对应表 18 行（offsetMs → itemId → transcription → session_send）；转发真值来源=journal.session_send（应为 journal.session_send）；CLI transcript 用作转发真值=false（应为 false）；committed 18 ↔ transcription 18 ↔ function_call(session_send) 13；journal session_send 条目 12；caption 流 18 条（**未**用作真值）；excerpt 内真值句 6 条
- [x] **AC2** — 同源同起点同长度：源 af5559c0-d347-41f3-a6f0-f02a597af1e9、起点 0 ms、excerpt 90000 ms；实跑臂 A/B/C；退出码 0 且写 snapshot.json
- [x] **AC3** — C 上传 帧 4500 / 字节 2880000 / 毫秒 90000 vs A 上传 帧 4500 / 字节 2880000 / 毫秒 90000；C 记录决策 4500 条（应 == C 上传帧数）；C 本会裁掉 0 ms 但一帧未裁（ignoredSuppressions=0）
- [x] **AC4** — 三臂六项指标齐备：A 上行 4500 帧/2880000 B、误删语音 0 ms（源语音 14873 ms 内）、前滚保留 不适用（无门控）、时延 376/435 ms、保真 0.667、连接存活 是（最大上传间隔 22 ms）；B 上行 4500 帧/2880000 B、误删语音 0 ms（源语音 14873 ms 内）、前滚保留 补发 0 帧（单次最长 0 帧）、时延 278/441 ms、保真 0.833、连接存活 是（最大上传间隔 29 ms）；C 上行 4500 帧/2880000 B、误删语音 0 ms（源语音 14873 ms 内）、前滚保留 补发 0 帧（单次最长 0 帧）、时延 324/460 ms、保真 0.833、连接存活 是（最大上传间隔 25 ms）
- [x] **AC5** — keepalive：B 臂被压住累计 0 ms、其间发出 keepalive 0 帧 / 0 ms、最长不发送间隔 29 ms、连接存活 true（close=探针自收）；出货门控自带 keepalive（默认 30 s 间隔、100 ms 数字静音帧）——本探针**没有**另加 keepalive；「与节流目标的冲突」段落在报告文本中=true（判据是渲染后的报告里含标记串，不是开关）
- [x] **AC6** — localSpeechGate / reportLocalSpeechBoundary / watchdog 已在报告中显式标注为**既有旁路**=true（判据是渲染后的报告里含标记串，不是开关）；探针未 import/构造它们=true（barrel 导入符号 3 个，其中不含这两个）；其边界事件未被计入本功能行为（本探针只观测 gate 的 `frames`/`stage`，不消费任何 local-speech 边界事件）
- [x] **AC7** — excerpt 90000 ms ≤ 上限 90000 ms；单次运行（runs=1）；实际花费 ¥0.0202（每连接上限 ¥0.05、总上限 ¥0.5）；触顶连接 0 条；实际总时长 287054 ms
- [x] **AC8** — :3001 pid 运行前 366403 → 运行后 366403（相同=true，未重启）；生产环境变量改动 0 条（gate 在探针内构造）；外联仅 wss://dashscope.aliyuncs.com/api-ws/v1/realtime
- [x] **AC9** — 三臂模型侧读数均足够，结论可用

## 方法与限制

- 语料是**真实**上行捕获（continuous 路径才捕获：`frame.seq === undefined`），不是脚本内构造的片段；excerpt 取源音频的一段固定窗口。
- 转发真值来自 journal 的 `<< function_call session_send`；`committed` ↔ `transcription.completed` 按到达顺序一一对应，条数不等即抛错，不做猜测性对齐。
- 静音占比两列：**源语料侧**由真实 capture timeline 的 `speech_started/stopped` 在窗口内的部分算出（与臂无关）；**上游侧**由本臂自己收到的 `speech_started/stopped` 算出。
- 本探针**不写任何生产环境变量**：gate 在探针内 `createSilenceTailGate({})` 构造（出货默认 T=1000 ms / P=500 ms / keepalive=30 s）。
- 单次运行、每臂一条全新连接；本实验**不追求统计功效**，只要求三臂同源可比。读数差异不足以支撑跨样本的泛化结论。
- **本语料的边界（重要）**：出货门控的实测人声下限是 -61 dBFS，而这段真实上行只有 6.8% 的帧低于它 —— 所以 B 臂的门控在这段音频上**没有可裁之处**。凡涉及「裁剪会不会改变模型输入」的问题，本语料**给不出**答案（不是「给了否定答案」）；要测它需要一个帧电平落进门控判定区的语料。
- 上游 realtime 端点本身是唯一外联；`turn_detection` 由出货解析器给出，三臂相同；本探针没有任何写 `turn_detection` 的代码路径。
- **AC1 的判据只覆盖「本探针自己发出的帧」**：它核对各臂上行帧型里没有 `response.create` / commit、核对各臂**实际发出**的 `session.update` 里的 `turn_detection` 与出货解析器逐字节一致、核对外加 `response.create` 次数为 0。它**不**（也无法）核对 :3001 上的生产代码路径——那是「本实验没有引入该接线」这一命题的正确范围。
- **keepalive 的判据也受语料限制**：本次 excerpt 90 s，B 臂一次未被压住（suppressed 转移 0 次），因此既没机会触发门控的 keepalive（默认 30 s 间隔），也没有机会验证「压住 ≥ 300 s 会不会被上游以 `1007 response_idle_timeout` 断线」。报告只写「本探针未额外加 keepalive」与「出货门控自带的是连续静音 PCM，与节流目标冲突、且按既有读数未必有效」，**不**把「本次没断线」读成「静音保活有效」或「不需要保活」。
- 三臂各一条连接、**每臂只跑一次**：模型侧读数（转写/转发条数、保真、中断）在同输入下也不保证复现，因此 C−A 的模型侧差异**不是**输入差异（两者的上行逐字节相同），只能是抖动；结论只对**上传量**作断言。

来源对应表全文与逐帧读数见 `/tmp/vad3/snapshot.json` 与 `journal/`。
