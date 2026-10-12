# Live Voice Silence Tail Suppression 真实探针（V-1..V-8 / AC-363）

本文件是 GOAL-044 / AC-363 的探针记录：在**实验脚本内的 STS 原型**（不改产品代码）上，对**真实**
`qwen3.8-omni-flash-realtime` 上游跑一次，回答决策文档 §10.3 的 V-1..V-8。**这不是模型推演，是一次运行的读数。**

运行时刻 2026-10-12T13:28:43Z；探针**直连上游**（raw WS，逐 20 ms 帧控制上传），未起第二实例；:3001 只被读 pid，从未被重启。
执行面是**合成会话**：`sessionId` 由脚本生成、任何库里都不存在；会话声明的工具由脚本的记录式执行器承接（dry-run）。
本次运行目录 `/tmp/sts-full`（journal 在 `journal/`）。

## 读数行（判据逐行检查）

V-1 时间基：上游按**音频时间轴**检测静音：触发时上游**已收到**的静音音频分别为 500 / 900 ms （对应各自的 `silence_duration_ms` 400 / 800 ms）；送的静音比 `silence_duration_ms` 少 100 ms 的 2 条全部未触发、触发 0 条，多 100 ms 的 2 条全部触发。**没有任何一次触发越过实送量**（音频轴冻结在停传点上），即上游从未拿「没收到的音频」判静音。 帧边界扫描（D=400 ms）：500 ms 真实静音触发（触发时已收静音 500 ms）、比它短的不触发。
V-2 停传空闲：停传后连接存活 1/4 档（存活的是 1 min）；被上游关闭 3 档（关闭码 1007），关闭时刻集中在连接建立后 303.6–306.3 s；其中 1 档（5 min）**恢复上传也没能救回来**；恢复上传的连接里，恢复后 20 s 内**新转写共 1 条**；qwen3.8 对 `idle_timeout_ms` 无错误帧，但 `session.updated` **未回显**该字段（文档称仅 qwen3.5 支持）。
V-3 尾音与前滚：以下语料的 item 列表与基线**不一致**（逐位置比对，位置即第几条 item；**位置不指认是哪一段**——差异既出现在第一句被拆出的分条上，也出现在恢复段，故只能读成「这两条连接对同一段音频转出了不同的字」）：wk-01(P300@第2条、P500@第4条、P800@第4条)、wk-02(P800@第2条)、fo-01(P800@第4条)；wk-01: 基线 4 条「这段逻辑我觉得应该可以了。|就这样吧。|这段逻辑我觉得应该可以了。|吧。」/ P300 4 条「这段逻辑我觉得应该可以了。|这样吧。|这段逻辑我觉得应该可以了。|这样吧。」 / P500 4 条「这段逻辑我觉得应该可以了。|就这样吧。|这段逻辑我觉得应该可以了。|就这样吧。」 / P800 4 条「这段逻辑我觉得应该可以了。|就这样吧。|这段逻辑我觉得应该可以了。|这样吧。」；wk-02: 基线 2 条「先按现在的方案做，细节回头再说。|先按现在的方案做，细节回头再说。」/ P300 2 条「先按现在的方案做，细节回头再说。|先按现在的方案做，细节回头再说。」 / P500 2 条「先按现在的方案做，细节回头再说。|先按现在的方案做，细节回头再说。」 / P800 1 条「先按现在的方案做，细节回头再说。」；fo-01: 基线 4 条「等一下。|先停下来。|等一下。|先停下来。」/ P300 4 条「等一下。|先停下来。|等一下。|先停下来。」 / P500 4 条「等一下。|先停下来。|等一下。|先停下来。」 / P800 4 条「等一下。|先停下来。|等一下。|停下来。」。
V-4 恢复前状态：tail 后上游自行 `input_audio_buffer.commit` 帧 42 次；恢复讲话时空 commit / buffer-too-small 类错误 0 次；多余条目 0（判据同表头：用户条目多于起说次数的部分）。
V-5 误判：底噪帧被判语音 0/150（0.0%）；键盘帧被判语音 147/150（98.0%）；低音量语音被判静音 lv-01=0/106、lv-02=2/68；常规/弱尾/快速起音语音被判静音 sp-01=0/96、sp-02=0/121、sp-03=2/109、wk-01=0/139、wk-02=2/129、fo-01=0/65。
V-6 模式关系：STS 原型只在 **continuous**（上游 `server_vad`）生效：它不改断句、不 commit、不发 `response.create`、不关 WS，只门控「哪些帧上传」。`VOICE_REALTIME_SEGMENT_COMMIT=server-vad` 的回退路径由客户端 `segment_start/segment_end` 驱动，断句权在客户端，STS 的 tail 门控在那里没有意义（不需要、也不启用）。本探针不改产品代码，故 V-6 为代码面陈述（见 `voice-realtime-bridge.service.ts` 的 segmented 分支与 `voice-realtime-mode.ts`），未另起产品连接对照。
V-7 等价性：条目数 基线 3 / STS 3；response 数 基线 6 / STS 6；工具调用 基线 3 / STS 3。
V-8 上传节省：上传秒数 基线 25.4 / STS 14.4（会话秒数 基线 34.5 / STS 34.5）；STS 相对基线少传 43.4%。
T 推荐：依据 V-1 帧边界扫描（**直接读数**：D=400 ms 下，送 500 ms 真实静音触发 `speech_stopped`、比它短的都不触发），与 V-1 四档判定「音频时间轴」一致，tail 必须自己跨过这个长度，故 `T ≥ 500 ms + 余量`。本探针 STS 臂取 `T = 2 s`；V-7 两臂对照：条目数 基线 3 / STS 3；response 数 基线 6 / STS 6；工具调用 基线 3 / STS 3；V-2 另给出一条**上界**：3 条停传连接在连接建立后 304–306 s 被上游以关闭码 1007 断开，故 tail 与随后任何停传都远低于该值（`{1,2,3} s` 的三个候选都低两个数量级）。候选取值 `{1, 2, 3} s` 中取**最小的、仍高出读数下界 500 ms 余量**的一档，据推荐 **T = 1 s**（读数下界 500 ms）。
P 推荐：不足以推荐：以下语料的 item 列表与基线**不一致**（逐位置比对，位置即第几条 item；**位置不指认是哪一段**——差异既出现在第一句被拆出的分条上，也出现在恢复段，故只能读成「这两条连接对同一段音频转出了不同的字」）：wk-01(P300@第2条、P500@第4条、P800@第4条)、wk-02(P800@第2条)、fo-01(P800@第4条)；wk-01: 基线 4 条「这段逻辑我觉得应该可以了。|就这样吧。|这段逻辑我觉得应该可以了。|吧。」/ P300 4 条「这段逻辑我觉得应该可以了。|这样吧。|这段逻辑我觉得应该可以了。|这样吧。」 / P500 4 条「这段逻辑我觉得应该可以了。|就这样吧。|这段逻辑我觉得应该可以了。|就这样吧。」 / P800 4 条「这段逻辑我觉得应该可以了。|就这样吧。|这段逻辑我觉得应该可以了。|这样吧。」；wk-02: 基线 2 条「先按现在的方案做，细节回头再说。|先按现在的方案做，细节回头再说。」/ P300 2 条「先按现在的方案做，细节回头再说。|先按现在的方案做，细节回头再说。」 / P500 2 条「先按现在的方案做，细节回头再说。|先按现在的方案做，细节回头再说。」 / P800 1 条「先按现在的方案做，细节回头再说。」；fo-01: 基线 4 条「等一下。|先停下来。|等一下。|先停下来。」/ P300 4 条「等一下。|先停下来。|等一下。|先停下来。」 / P500 4 条「等一下。|先停下来。|等一下。|先停下来。」 / P800 4 条「等一下。|先停下来。|等一下。|停下来。」。 注意**同一段音频在同一条连接里也会转出不同的字**（对照上表基线臂第一句与第二句，是同一个语料句），所以「与基线不一致」不能单独归因给 P；本运行区分不出 `P ∈ {300,500,800} ms` 的差别，不给出 `P` 取值，需在转写更稳定的语料上重测。
运行次数：1
花费：¥0.0450（上限 ¥0.0500 / 连接 × 33 条连接；触顶连接 0 条）
:3001 pid：运行前 1933227 → 运行后 1933227（**相同**，未重启）
执行面：dry-run（合成 `sessionId`，会话声明工具由脚本内记录式执行器承接，不落任何真实会话）

「运行次数：1」指**上表全部读数来自同一次完整运行**（`--work` 指定的那一个快照）；见「方法与限制」对取数前管线预检的交代。

## V-1 时间基

做法：语音结束后只送 `silence_duration_ms ± 100 ms` 的**真实底噪**（stand-in：低幅粉噪），然后**停传 5 s**。
判读：若上游按**音频时间轴**检测，`−100 ms` 一档在停传窗口内**不该**出现 `speech_stopped`（收到的静音不足），
而 `+100 ms` 一档应在**静音送完前不久**（≈ 语音结束后 `silence_duration_ms`）触发；
若按**墙钟**检测，停传本身被当作静音，`−100 ms` 一档也会在 `≈ silence_duration_ms` 处出现 `speech_stopped`。

管线预检已经先看到这条判据的一面：**发送端完全停帧、但 socket 不关**时（冒烟那一条），上游整段运行里
`speech_stopped` / `transcription.completed` / `response.*` 一个都没有——停传不会因为「墙钟过去了」而推进静音计时。

判读以**音频轴**为准：`触发时已收静音` = 事件到达那一刻上游**已经收到的**静音毫秒数（相对语音结束）。
这是「上游判了多少毫秒静音」的直接读数，与播放器调度抖动无关。音频时间基 ⇒ 它必然 ≤ 实送量、且落在 `D` 到实送量之间；
墙钟基 ⇒ 它会在停传期间**越过实送量**（停传冻结音频轴，而墙钟还在走），即上游拿没收到的音频判了静音。
「相对语音结束 / 相对静音送完」两列是**墙钟**数，只作对照——同一份音频两跑能差出几百毫秒，不足以承担判定。

| 条件 | `silence_duration_ms` | 实送真实静音 | `speech_stopped` | 触发时已收静音 | 越过实送量 | 相对语音结束（墙钟） | 相对静音送完（墙钟） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| v1/D400/−100ms | 400 ms | 300 ms | **未触发** | — | 否 | — | — |
| v1/D400/+100ms | 400 ms | 500 ms | 触发 | 500 ms | 否 | 3502 ms | 3021 ms |
| v1/D800/−100ms | 800 ms | 700 ms | **未触发** | — | 否 | — | — |
| v1/D800/+100ms | 800 ms | 900 ms | 触发 | 900 ms | 否 | 933 ms | 53 ms |

### 帧边界扫描（附加读数，`silence_duration_ms = 400 ms` 固定）

±100 ms 只探到配置值两侧各一格；边界到底落在哪，要在 `D = 400 ms` 上跨着 400 ms 扫一圈才读得出：
音频时间基 ⇒ 短于窗口的实送量一律不触发（停传后音频轴冻结、再也补不上），实送量跨过窗口后才触发；
墙钟基 ⇒ 只要停传够久就照样触发，与实送量无关（那一列 `越过实送量` 会亮）。
末行是**数字静音对照**：与 700 ms 档同长，但填全零帧而不是合成底噪——若两者表现不同，说明合成底噪本身参与了判定。

| 实送静音 | 填充 | `speech_stopped` | 触发时已收静音 | 越过实送量 | 相对语音结束（墙钟） |
| --- | --- | --- | --- | --- | --- |
| 200 ms | 合成底噪 | **未触发** | — | 否 | — |
| 300 ms | 合成底噪 | **未触发** | — | 否 | — |
| 400 ms | 合成底噪 | **未触发** | — | 否 | — |
| 500 ms | 合成底噪 | 触发 | 500 ms | 否 | 3228 ms |
| 700 ms | 合成底噪 | 触发 | 700 ms | 否 | 1519 ms |
| 700 ms | 数字静音 | 触发 | 560 ms | 否 | 548 ms |

**边界扫描**：200 ms 未触发；300 ms 未触发；400 ms 未触发；500 ms 触发（触发时已收静音 500 ms）；700 ms 触发（触发时已收静音 700 ms）；700 ms 触发（触发时已收静音 560 ms）。边界落在 400 ms（未触发）与 500 ms（触发）之间 —— tail 至少要送出这么多毫秒的真实静音音频，`speech_stopped` 才会出现。

### 事件时间线原文摘录（每条连接从语音结束起的关键帧）

- **v1/D400/−100ms**（连接 `99290394-ae7c-4da5-b445-14ff7088c705`）：
  - `618 ms（相对语音结束 -1785 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 -1800 ms（实送静音 300 ms）`
  - `910 ms（相对语音结束 -1493 ms）`conversation.item.created` ｜ 音频轴：已收 -1500 ms（实送静音 300 ms）`
- **v1/D400/+100ms**（连接 `0e21ff10-5663-436f-ad47-560973a29283`）：
  - `2034 ms（相对语音结束 -1168 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 -1180 ms（实送静音 500 ms）`
  - `2259 ms（相对语音结束 -943 ms）`conversation.item.created` ｜ 音频轴：已收 -960 ms（实送静音 500 ms）`
  - `6704 ms（相对语音结束 +3502 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 500 ms（实送静音 500 ms，此后停传）`
  - `6704 ms（相对语音结束 +3502 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 500 ms（实送静音 500 ms，此后停传）`
  - `6899 ms（相对语音结束 +3697 ms）`conversation.item.input_audio_transcription.completed` transcript=「帮我看看登陆页今天改了什么。」 ｜ 音频轴：已收 500 ms（实送静音 500 ms，此后停传）`
  - `6979 ms（相对语音结束 +3777 ms）`response.created` ｜ 音频轴：已收 500 ms（实送静音 500 ms，此后停传）`
  - `6979 ms（相对语音结束 +3777 ms）`conversation.item.created` ｜ 音频轴：已收 500 ms（实送静音 500 ms，此后停传）`
  - `7116 ms（相对语音结束 +3914 ms）`response.done` usage={"total_tokens":370,"input_tokens":339,"output_tokens":31,"input_tokens_details":{"text_tokens":318,"audio_tokens":21}," ｜ 音频轴：已收 500 ms（实送静音 500 ms，此后停传）`
  - `7311 ms（相对语音结束 +4109 ms）`conversation.item.created` ｜ 音频轴：已收 500 ms（实送静音 500 ms，此后停传）`
  - `7515 ms（相对语音结束 +4313 ms）`response.created` ｜ 音频轴：已收 500 ms（实送静音 500 ms，此后停传）`
  - `7515 ms（相对语音结束 +4313 ms）`conversation.item.created` ｜ 音频轴：已收 500 ms（实送静音 500 ms，此后停传）`
  - `7632 ms（相对语音结束 +4430 ms）`response.done` usage={"total_tokens":422,"input_tokens":409,"output_tokens":13,"input_tokens_details":{"text_tokens":388,"audio_tokens":21}," ｜ 音频轴：已收 500 ms（实送静音 500 ms，此后停传）`
- **v1/D800/−100ms**（连接 `73721f37-2963-4d8e-b87c-43de096cbaf1`）：
  - `1386 ms（相对语音结束 -1585 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 -1600 ms（实送静音 700 ms）`
  - `1619 ms（相对语音结束 -1352 ms）`conversation.item.created` ｜ 音频轴：已收 -1360 ms（实送静音 700 ms）`
- **v1/D800/+100ms**（连接 `3f70dd11-1ea4-4b05-a425-f07287848658`）：
  - `682 ms（相对语音结束 -1716 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 -1720 ms（实送静音 900 ms）`
  - `921 ms（相对语音结束 -1477 ms）`conversation.item.created` ｜ 音频轴：已收 -1480 ms（实送静音 900 ms）`
  - `3331 ms（相对语音结束 +933 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 900 ms（实送静音 900 ms，此后停传）`
  - `3331 ms（相对语音结束 +933 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 900 ms（实送静音 900 ms，此后停传）`
  - `3537 ms（相对语音结束 +1139 ms）`conversation.item.input_audio_transcription.completed` transcript=「帮我看看登陆页今天改了什么。」 ｜ 音频轴：已收 900 ms（实送静音 900 ms，此后停传）`
  - `3574 ms（相对语音结束 +1176 ms）`response.created` ｜ 音频轴：已收 900 ms（实送静音 900 ms，此后停传）`
  - `3574 ms（相对语音结束 +1176 ms）`conversation.item.created` ｜ 音频轴：已收 900 ms（实送静音 900 ms，此后停传）`
  - `3688 ms（相对语音结束 +1290 ms）`response.done` usage={"total_tokens":348,"input_tokens":339,"output_tokens":9,"input_tokens_details":{"text_tokens":318,"audio_tokens":21},"o ｜ 音频轴：已收 900 ms（实送静音 900 ms，此后停传）`
- **v1/D400/sent200ms**（连接 `86801fba-2e63-4ad9-b2ba-33845830b05b`）：
  - `1204 ms（相对语音结束 -1490 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 -1500 ms（实送静音 200 ms）`
  - `1525 ms（相对语音结束 -1169 ms）`conversation.item.created` ｜ 音频轴：已收 -1180 ms（实送静音 200 ms）`
- **v1/D400/sent300ms**（连接 `561a4195-1ae7-48e8-86e4-fd49bfccc911`）：
  - `1125 ms（相对语音结束 -1579 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 -1580 ms（实送静音 300 ms）`
  - `1368 ms（相对语音结束 -1336 ms）`conversation.item.created` ｜ 音频轴：已收 -1340 ms（实送静音 300 ms）`
- **v1/D400/sent400ms**（连接 `dcc72986-c4ca-44f6-a92e-70cbe9bb7459`）：
  - `616 ms（相对语音结束 -1759 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 -1760 ms（实送静音 400 ms）`
  - `897 ms（相对语音结束 -1478 ms）`conversation.item.created` ｜ 音频轴：已收 -1480 ms（实送静音 400 ms）`
- **v1/D400/sent500ms**（连接 `154f99e3-1009-467a-ad8d-b437a64a6402`）：
  - `1093 ms（相对语音结束 -1596 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 -1600 ms（实送静音 500 ms）`
  - `1489 ms（相对语音结束 -1200 ms）`conversation.item.created` ｜ 音频轴：已收 -1200 ms（实送静音 500 ms）`
  - `5917 ms（相对语音结束 +3228 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 500 ms（实送静音 500 ms，此后停传）`
  - `5917 ms（相对语音结束 +3228 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 500 ms（实送静音 500 ms，此后停传）`
  - `6140 ms（相对语音结束 +3451 ms）`conversation.item.input_audio_transcription.completed` transcript=「帮我看看登陆页今天改了什么。」 ｜ 音频轴：已收 500 ms（实送静音 500 ms，此后停传）`
  - `6175 ms（相对语音结束 +3486 ms）`response.created` ｜ 音频轴：已收 500 ms（实送静音 500 ms，此后停传）`
  - `6176 ms（相对语音结束 +3487 ms）`conversation.item.created` ｜ 音频轴：已收 500 ms（实送静音 500 ms，此后停传）`
  - `6312 ms（相对语音结束 +3623 ms）`response.done` usage={"total_tokens":370,"input_tokens":339,"output_tokens":31,"input_tokens_details":{"text_tokens":318,"audio_tokens":21}," ｜ 音频轴：已收 500 ms（实送静音 500 ms，此后停传）`
  - `6503 ms（相对语音结束 +3814 ms）`conversation.item.created` ｜ 音频轴：已收 500 ms（实送静音 500 ms，此后停传）`
  - `6744 ms（相对语音结束 +4055 ms）`response.created` ｜ 音频轴：已收 500 ms（实送静音 500 ms，此后停传）`
  - `6744 ms（相对语音结束 +4055 ms）`conversation.item.created` ｜ 音频轴：已收 500 ms（实送静音 500 ms，此后停传）`
  - `6833 ms（相对语音结束 +4144 ms）`response.done` usage={"total_tokens":418,"input_tokens":409,"output_tokens":9,"input_tokens_details":{"text_tokens":388,"audio_tokens":21},"o ｜ 音频轴：已收 500 ms（实送静音 500 ms，此后停传）`
- **v1/D400/sent700ms**（连接 `73b99f1a-48e5-452b-bd5d-2ece845b9bb8`）：
  - `1221 ms（相对语音结束 -1510 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 -1520 ms（实送静音 700 ms）`
  - `1443 ms（相对语音结束 -1288 ms）`conversation.item.created` ｜ 音频轴：已收 -1300 ms（实送静音 700 ms）`
  - `4250 ms（相对语音结束 +1519 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 700 ms（实送静音 700 ms，此后停传）`
  - `4250 ms（相对语音结束 +1519 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 700 ms（实送静音 700 ms，此后停传）`
  - `4460 ms（相对语音结束 +1729 ms）`conversation.item.input_audio_transcription.completed` transcript=「帮我看看登陆页今天改了什么。」 ｜ 音频轴：已收 700 ms（实送静音 700 ms，此后停传）`
  - `4499 ms（相对语音结束 +1768 ms）`response.created` ｜ 音频轴：已收 700 ms（实送静音 700 ms，此后停传）`
  - `4499 ms（相对语音结束 +1768 ms）`conversation.item.created` ｜ 音频轴：已收 700 ms（实送静音 700 ms，此后停传）`
  - `4643 ms（相对语音结束 +1912 ms）`response.done` usage={"total_tokens":370,"input_tokens":339,"output_tokens":31,"input_tokens_details":{"text_tokens":318,"audio_tokens":21}," ｜ 音频轴：已收 700 ms（实送静音 700 ms，此后停传）`
  - `5378 ms（相对语音结束 +2647 ms）`conversation.item.created` ｜ 音频轴：已收 700 ms（实送静音 700 ms，此后停传）`
  - `5582 ms（相对语音结束 +2851 ms）`response.created` ｜ 音频轴：已收 700 ms（实送静音 700 ms，此后停传）`
  - `5583 ms（相对语音结束 +2852 ms）`conversation.item.created` ｜ 音频轴：已收 700 ms（实送静音 700 ms，此后停传）`
  - `5696 ms（相对语音结束 +2965 ms）`response.done` usage={"total_tokens":419,"input_tokens":409,"output_tokens":10,"input_tokens_details":{"text_tokens":388,"audio_tokens":21}," ｜ 音频轴：已收 700 ms（实送静音 700 ms，此后停传）`
- **v1/D400/digital700ms**（连接 `c145ee1f-9e68-4b7f-af93-afbfcdf00974`）：
  - `1305 ms（相对语音结束 -1392 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 -1400 ms（实送静音 700 ms）`
  - `1559 ms（相对语音结束 -1138 ms）`conversation.item.created` ｜ 音频轴：已收 -1140 ms（实送静音 700 ms）`
  - `3245 ms（相对语音结束 +548 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 560 ms（实送静音 700 ms）`
  - `3245 ms（相对语音结束 +548 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 560 ms（实送静音 700 ms）`
  - `3491 ms（相对语音结束 +794 ms）`conversation.item.input_audio_transcription.completed` transcript=「帮我看看登陆页今天改了什么。」 ｜ 音频轴：已收 700 ms（实送静音 700 ms，此后停传）`
  - `3498 ms（相对语音结束 +801 ms）`response.created` ｜ 音频轴：已收 700 ms（实送静音 700 ms，此后停传）`
  - `3498 ms（相对语音结束 +801 ms）`conversation.item.created` ｜ 音频轴：已收 700 ms（实送静音 700 ms，此后停传）`
  - `3662 ms（相对语音结束 +965 ms）`response.done` usage={"total_tokens":371,"input_tokens":339,"output_tokens":32,"input_tokens_details":{"text_tokens":318,"audio_tokens":21}," ｜ 音频轴：已收 700 ms（实送静音 700 ms，此后停传）`
  - `3855 ms（相对语音结束 +1158 ms）`conversation.item.created` ｜ 音频轴：已收 700 ms（实送静音 700 ms，此后停传）`
  - `4053 ms（相对语音结束 +1356 ms）`response.created` ｜ 音频轴：已收 700 ms（实送静音 700 ms，此后停传）`
  - `4053 ms（相对语音结束 +1356 ms）`conversation.item.created` ｜ 音频轴：已收 700 ms（实送静音 700 ms，此后停传）`
  - `4165 ms（相对语音结束 +1468 ms）`response.done` usage={"total_tokens":421,"input_tokens":410,"output_tokens":11,"input_tokens_details":{"text_tokens":389,"audio_tokens":21}," ｜ 音频轴：已收 700 ms（实送静音 700 ms，此后停传）`

**结论**：上游按**音频时间轴**检测静音：触发时上游**已收到**的静音音频分别为 500 / 900 ms （对应各自的 `silence_duration_ms` 400 / 800 ms）；送的静音比 `silence_duration_ms` 少 100 ms 的 2 条全部未触发、触发 0 条，多 100 ms 的 2 条全部触发。**没有任何一次触发越过实送量**（音频轴冻结在停传点上），即上游从未拿「没收到的音频」判静音。

这条判定直接决定 STS 的 `T` 下限。上游把静音判在**音频轴**上，意味着停传期间上游的静音计时**不前进**：
tail 必须自己就是一段**真的被送出去的、长度 ≥ `silence_duration_ms` 的静音音频**，`speech_stopped` 才会触发，
即 `T ≥ silence_duration_ms + 余量`。停传本身不会替你把时钟往前推（见 §10.6 H-S3：以读数为准）。

## V-2 停传空闲

做法：语音后停传 1 / 5 / 15 / 30 min（**同一运行内 4 条连接并行**），随后恢复讲话；读连接存活、关闭码、恢复后新转写、错误事件。
「恢复上传起点」与「恢复后新转写」由本连接**已记录的事件时间线**离线定位（停传 = 相邻 `input_audio_buffer.append` 之间 ≥ 30 s 的间隔；恢复点 = 该间隔右侧那一帧；新转写 = 时刻不早于恢复点的 `…transcription.completed`），不依赖探针写下的延迟字段。
另用一条不发声的短连接验证 qwen3.8 是否接受 `idle_timeout_ms`（文档称仅 qwen3.5）。

| 请求停传 | 实际观测停传 | 连接 | 连接 id | 关闭码 | 关闭时刻 | 恢复上传起点 | 恢复后 20 s 内新转写 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 min | 60.0 s | 存活 | `9fe3c43f-133c-4dcd-bf94-0b2384f418fa` | — | — | 63.7 s | 1 条（首条 +6884 ms） |
| 5 min | 300.3 s | 关闭 | `922ec158-a668-4fd7-84a6-af1e33c5c052` | 1007 | 303.7 s | 303.7 s | 0 条 |
| 15 min | 303.0 s | 关闭 | `838637a7-1584-4a30-816a-f0dd558eb74b` | 1007 | 306.3 s | 未恢复 | — |
| 30 min | 300.2 s | 关闭 | `3666c4d4-2c5c-43b6-8189-722a026e5a6d` | 1007 | 303.6 s | 未恢复 | — |

`idle_timeout_ms`：无错误帧（被接受、未见拒绝）；`session.updated` 回显该字段=false。连接 `15f3be14-710c-47bc-98ca-55b8a7948a69`。

**连接 id 与事件摘录**

- **v2/stall1min**（连接 `9fe3c43f-133c-4dcd-bf94-0b2384f418fa`，journal `journal/9fe3c43f-133c-4dcd-bf94-0b2384f418fa.jsonl`）：
  - `1230 ms（相对语音结束 +1230 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 680 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `1449 ms（相对语音结束 +1449 ms）`conversation.item.created` ｜ 音频轴：已收 900 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3726 ms（相对语音结束 +3726 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 3160 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3726 ms（相对语音结束 +3726 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 3160 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3961 ms（相对语音结束 +3961 ms）`conversation.item.input_audio_transcription.completed` transcript=「帮我看看登陆页今天改了什么。」 ｜ 音频轴：已收 3160 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4004 ms（相对语音结束 +4004 ms）`response.created` ｜ 音频轴：已收 3160 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4005 ms（相对语音结束 +4005 ms）`conversation.item.created` ｜ 音频轴：已收 3160 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4167 ms（相对语音结束 +4167 ms）`response.done` usage={"total_tokens":371,"input_tokens":339,"output_tokens":32,"input_tokens_details":{"text_tokens":318,"audio_tokens":21}," ｜ 音频轴：已收 3160 ms（实送静音 0 ms，此后停传，**越过实送量**）`
- **v2/stall5min**（连接 `922ec158-a668-4fd7-84a6-af1e33c5c052`，journal `journal/922ec158-a668-4fd7-84a6-af1e33c5c052.jsonl`）：
  - `614 ms（相对语音结束 +614 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 380 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `884 ms（相对语音结束 +884 ms）`conversation.item.created` ｜ 音频轴：已收 660 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3130 ms（相对语音结束 +3130 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 2900 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3130 ms（相对语音结束 +3130 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 2900 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3338 ms（相对语音结束 +3338 ms）`conversation.item.input_audio_transcription.completed` transcript=「帮我看看登陆页今天改了什么。」 ｜ 音频轴：已收 3100 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3377 ms（相对语音结束 +3377 ms）`response.created` ｜ 音频轴：已收 3140 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3378 ms（相对语音结束 +3378 ms）`conversation.item.created` ｜ 音频轴：已收 3140 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3535 ms（相对语音结束 +3535 ms）`response.done` usage={"total_tokens":371,"input_tokens":339,"output_tokens":32,"input_tokens_details":{"text_tokens":318,"audio_tokens":21}," ｜ 音频轴：已收 3160 ms（实送静音 0 ms，此后停传，**越过实送量**）`
- **v2/stall15min**（连接 `838637a7-1584-4a30-816a-f0dd558eb74b`，journal `journal/838637a7-1584-4a30-816a-f0dd558eb74b.jsonl`）：
  - `1347 ms（相对语音结束 +1347 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 780 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `1582 ms（相对语音结束 +1582 ms）`conversation.item.created` ｜ 音频轴：已收 1020 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4753 ms（相对语音结束 +4753 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 3160 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4753 ms（相对语音结束 +4753 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 3160 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4981 ms（相对语音结束 +4981 ms）`conversation.item.input_audio_transcription.completed` transcript=「帮我看看登陆页今天改了什么。」 ｜ 音频轴：已收 3160 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `5005 ms（相对语音结束 +5005 ms）`response.created` ｜ 音频轴：已收 3160 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `5006 ms（相对语音结束 +5006 ms）`conversation.item.created` ｜ 音频轴：已收 3160 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `5164 ms（相对语音结束 +5164 ms）`response.done` usage={"total_tokens":371,"input_tokens":339,"output_tokens":32,"input_tokens_details":{"text_tokens":318,"audio_tokens":21}," ｜ 音频轴：已收 3160 ms（实送静音 0 ms，此后停传，**越过实送量**）`
- **v2/stall30min**（连接 `3666c4d4-2c5c-43b6-8189-722a026e5a6d`，journal `journal/3666c4d4-2c5c-43b6-8189-722a026e5a6d.jsonl`）：
  - `659 ms（相对语音结束 +659 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 380 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `942 ms（相对语音结束 +942 ms）`conversation.item.created` ｜ 音频轴：已收 660 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2965 ms（相对语音结束 +2965 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 2700 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2965 ms（相对语音结束 +2965 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 2700 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3205 ms（相对语音结束 +3205 ms）`response.created` ｜ 音频轴：已收 2940 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3205 ms（相对语音结束 +3205 ms）`conversation.item.created` ｜ 音频轴：已收 2940 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3243 ms（相对语音结束 +3243 ms）`conversation.item.input_audio_transcription.completed` transcript=「帮我看看登陆页今天改了什么。」 ｜ 音频轴：已收 2960 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3315 ms（相对语音结束 +3315 ms）`conversation.item.created` ｜ 音频轴：已收 3040 ms（实送静音 0 ms，此后停传，**越过实送量**）`
- **v2/idle_timeout_ms**（连接 `15f3be14-710c-47bc-98ca-55b8a7948a69`，journal `journal/15f3be14-710c-47bc-98ca-55b8a7948a69.jsonl`）：
  - `（本连接无关键事件帧）`

**V-2 结论**：停传后连接存活 1/4 档（存活的是 1 min）；被上游关闭 3 档（关闭码 1007），关闭时刻集中在连接建立后 303.6–306.3 s；其中 1 档（5 min）**恢复上传也没能救回来**；恢复上传的连接里，恢复后 20 s 内**新转写共 1 条**；qwen3.8 对 `idle_timeout_ms` 无错误帧，但 `session.updated` **未回显**该字段（文档称仅 qwen3.5 支持）。

## V-3 尾音截断与前滚

源时间线（每条连接相同）：`底噪 500 ms + 语料句 + 底噪 4000 ms + 同一句 + 底噪 2000 ms`。
基线臂逐帧全传；STS 臂 `T = 2 s`，`P ∈ {300, 500, 800} ms`——底噪到 2 s 时停传 ~2 s，第二句起音时先补发前滚 `P`。
**真实读数**是上游的**逐条转写列表**：与基线逐位置一致 = 没丢字；某一条不同 = 前滚/恢复有洞（差异位置直接给出）。

读这个表要知道上游的两个行为（都由本运行的 journal 读出）：**(1)** 上游会把一句按停顿/逗号切成**多条** `conversation.item.input_audio_transcription.completed`（`wk-01` 一句切成两条），所以「第几条 = 第几句」不成立，按位置比较整条列表才有效；**(2)** 转写**延迟**可以超过 4 s 的静音间隔——基线臂 `wk-01`（连接 id 见下表）第一句的完成事件落在第二句起音之后，所以按时间切恢复段的办法在本运行上是不成立的（note 里的 `secondClipStartMs` 是源时间线上的第二句起点，可对照 `inputItems` 的 `atMs` 自行核对）。

| 语料 | 类别 | 臂 | 连接 id | 上游分条转写（按顺序） | 上传/停传 | 花费 |
| --- | --- | --- | --- | --- | --- | --- |
| wk-01 | weak-tail | base | `369939b2-1495-4d11-9ba8-f25b867aaecc` | 「这段逻辑我觉得应该可以了。」 「就这样吧。」 「这段逻辑我觉得应该可以了。」 「吧。」 | 13.1s / 0s | ¥0.0016 |
| wk-01 | weak-tail | P300 | `fc385f87-867c-420e-8199-c7ca54c9df63` | 「这段逻辑我觉得应该可以了。」 「这样吧。」 「这段逻辑我觉得应该可以了。」 「这样吧。」 | 11.5s / 1.84s | ¥0.0016 |
| wk-01 | weak-tail | P500 | `3a75771c-af0f-4050-9520-8798dc021212` | 「这段逻辑我觉得应该可以了。」 「就这样吧。」 「这段逻辑我觉得应该可以了。」 「就这样吧。」 | 11.7s / 1.84s | ¥0.0026 |
| wk-01 | weak-tail | P800 | `c83453cd-054b-482f-bce5-e1b577c1cd4d` | 「这段逻辑我觉得应该可以了。」 「就这样吧。」 「这段逻辑我觉得应该可以了。」 「这样吧。」 | 12.0s / 1.84s | ¥0.0016 |
| wk-02 | weak-tail | base | `697a4ca7-dd47-4523-ac04-5fb8f4414003` | 「先按现在的方案做，细节回头再说。」 「先按现在的方案做，细节回头再说。」 | 12.9s / 0s | ¥0.0028 |
| wk-02 | weak-tail | P300 | `250e8b0e-5c5b-4410-b078-082f5e981701` | 「先按现在的方案做，细节回头再说。」 「先按现在的方案做，细节回头再说。」 | 11.4s / 1.78s | ¥0.0027 |
| wk-02 | weak-tail | P500 | `bd5544bc-3202-43c4-a395-95d4e6133773` | 「先按现在的方案做，细节回头再说。」 「先按现在的方案做，细节回头再说。」 | 11.6s / 1.78s | ¥0.0027 |
| wk-02 | weak-tail | P800 | `f46f5a7c-02d7-4c53-96ad-eb79b697271d` | 「先按现在的方案做，细节回头再说。」 | 11.9s / 1.78s | ¥0.0008 |
| fo-01 | fast-onset | base | `9d953c1a-e868-46c8-b2f5-17ccd9de451d` | 「等一下。」 「先停下来。」 「等一下。」 「先停下来。」 | 9.7s / 0s | ¥0.0015 |
| fo-01 | fast-onset | P300 | `61b52e32-b84d-4868-819b-f3e3441df3cb` | 「等一下。」 「先停下来。」 「等一下。」 「先停下来。」 | 8.6s / 1.42s | ¥0.0015 |
| fo-01 | fast-onset | P500 | `44b9d99e-c0d2-4160-a3a0-dd88f404c18c` | 「等一下。」 「先停下来。」 「等一下。」 「先停下来。」 | 8.8s / 1.42s | ¥0.0022 |
| fo-01 | fast-onset | P800 | `ce3aeb3e-e9ba-4e16-8529-fc96022c51c3` | 「等一下。」 「先停下来。」 「等一下。」 「停下来。」 | 9.1s / 1.42s | ¥0.0015 |

**连接 id 与事件摘录**

- **v3/wk-01/base**（连接 `369939b2-1495-4d11-9ba8-f25b867aaecc`，journal `journal/369939b2-1495-4d11-9ba8-f25b867aaecc.jsonl`）：
  - `1561 ms（相对语音结束 +1561 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 1020 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `1843 ms（相对语音结束 +1843 ms）`conversation.item.created` ｜ 音频轴：已收 1300 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `6238 ms（相对语音结束 +6238 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 5700 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `6238 ms（相对语音结束 +6238 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 5700 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `6405 ms（相对语音结束 +6405 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 5860 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `6431 ms（相对语音结束 +6431 ms）`conversation.item.input_audio_transcription.completed` transcript=「这段逻辑我觉得应该可以了。」 ｜ 音频轴：已收 5880 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `6689 ms（相对语音结束 +6689 ms）`conversation.item.created` ｜ 音频轴：已收 6140 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `7180 ms（相对语音结束 +7180 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 6640 ms（实送静音 0 ms，此后停传，**越过实送量**）`
- **v3/wk-01/P300**（连接 `fc385f87-867c-420e-8199-c7ca54c9df63`，journal `journal/fc385f87-867c-420e-8199-c7ca54c9df63.jsonl`）：
  - `1136 ms（相对语音结束 +1136 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 860 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `1393 ms（相对语音结束 +1393 ms）`conversation.item.created` ｜ 音频轴：已收 1120 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3676 ms（相对语音结束 +3676 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 3400 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3676 ms（相对语音结束 +3676 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 3400 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3789 ms（相对语音结束 +3789 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 3520 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3876 ms（相对语音结束 +3876 ms）`conversation.item.input_audio_transcription.completed` transcript=「这段逻辑我觉得应该可以了。」 ｜ 音频轴：已收 3600 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4288 ms（相对语音结束 +4288 ms）`conversation.item.created` ｜ 音频轴：已收 4020 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4614 ms（相对语音结束 +4614 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 4340 ms（实送静音 0 ms，此后停传，**越过实送量**）`
- **v3/wk-01/P500**（连接 `3a75771c-af0f-4050-9520-8798dc021212`，journal `journal/3a75771c-af0f-4050-9520-8798dc021212.jsonl`）：
  - `1088 ms（相对语音结束 +1088 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 860 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `1308 ms（相对语音结束 +1308 ms）`conversation.item.created` ｜ 音频轴：已收 1080 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3565 ms（相对语音结束 +3565 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 3340 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3565 ms（相对语音结束 +3565 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 3340 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3730 ms（相对语音结束 +3730 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 3500 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3754 ms（相对语音结束 +3754 ms）`conversation.item.input_audio_transcription.completed` transcript=「这段逻辑我觉得应该可以了。」 ｜ 音频轴：已收 3540 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3963 ms（相对语音结束 +3963 ms）`conversation.item.created` ｜ 音频轴：已收 3740 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4615 ms（相对语音结束 +4615 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 4400 ms（实送静音 0 ms，此后停传，**越过实送量**）`
- **v3/wk-01/P800**（连接 `c83453cd-054b-482f-bce5-e1b577c1cd4d`，journal `journal/c83453cd-054b-482f-bce5-e1b577c1cd4d.jsonl`）：
  - `1566 ms（相对语音结束 +1566 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 1020 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `1823 ms（相对语音结束 +1823 ms）`conversation.item.created` ｜ 音频轴：已收 1280 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `8668 ms（相对语音结束 +8668 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 7060 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `8668 ms（相对语音结束 +8668 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 7060 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `8834 ms（相对语音结束 +8834 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 7220 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `8862 ms（相对语音结束 +8862 ms）`conversation.item.input_audio_transcription.completed` transcript=「这段逻辑我觉得应该可以了。」 ｜ 音频轴：已收 7240 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `9120 ms（相对语音结束 +9120 ms）`conversation.item.created` ｜ 音频轴：已收 7500 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `9981 ms（相对语音结束 +9981 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 8360 ms（实送静音 0 ms，此后停传，**越过实送量**）`
- **v3/wk-02/base**（连接 `697a4ca7-dd47-4523-ac04-5fb8f4414003`，journal `journal/697a4ca7-dd47-4523-ac04-5fb8f4414003.jsonl`）：
  - `1225 ms（相对语音结束 +1225 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 980 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `1520 ms（相对语音结束 +1520 ms）`conversation.item.created` ｜ 音频轴：已收 1280 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4553 ms（相对语音结束 +4553 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 4300 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4553 ms（相对语音结束 +4553 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 4300 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4786 ms（相对语音结束 +4786 ms）`response.created` ｜ 音频轴：已收 4540 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4786 ms（相对语音结束 +4786 ms）`conversation.item.created` ｜ 音频轴：已收 4540 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4836 ms（相对语音结束 +4836 ms）`conversation.item.input_audio_transcription.completed` transcript=「先按现在的方案做，细节回头再说。」 ｜ 音频轴：已收 4580 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4988 ms（相对语音结束 +4988 ms）`conversation.item.created` ｜ 音频轴：已收 4740 ms（实送静音 0 ms，此后停传，**越过实送量**）`
- **v3/wk-02/P300**（连接 `250e8b0e-5c5b-4410-b078-082f5e981701`，journal `journal/250e8b0e-5c5b-4410-b078-082f5e981701.jsonl`）：
  - `1828 ms（相对语音结束 +1828 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 880 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2189 ms（相对语音结束 +2189 ms）`conversation.item.created` ｜ 音频轴：已收 1240 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `5346 ms（相对语音结束 +5346 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 4380 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `5346 ms（相对语音结束 +5346 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 4380 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `5535 ms（相对语音结束 +5535 ms）`response.created` ｜ 音频轴：已收 4580 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `5535 ms（相对语音结束 +5535 ms）`conversation.item.created` ｜ 音频轴：已收 4580 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `5557 ms（相对语音结束 +5557 ms）`conversation.item.input_audio_transcription.completed` transcript=「先按现在的方案做，细节回头再说。」 ｜ 音频轴：已收 4600 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `5648 ms（相对语音结束 +5648 ms）`conversation.item.created` ｜ 音频轴：已收 4700 ms（实送静音 0 ms，此后停传，**越过实送量**）`
- **v3/wk-02/P500**（连接 `bd5544bc-3202-43c4-a395-95d4e6133773`，journal `journal/bd5544bc-3202-43c4-a395-95d4e6133773.jsonl`）：
  - `1091 ms（相对语音结束 +1091 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 860 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `1481 ms（相对语音结束 +1481 ms）`conversation.item.created` ｜ 音频轴：已收 1240 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4519 ms（相对语音结束 +4519 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 4280 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4519 ms（相对语音结束 +4519 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 4280 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4761 ms（相对语音结束 +4761 ms）`conversation.item.input_audio_transcription.completed` transcript=「先按现在的方案做，细节回头再说。」 ｜ 音频轴：已收 4520 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4770 ms（相对语音结束 +4770 ms）`response.created` ｜ 音频轴：已收 4540 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4770 ms（相对语音结束 +4770 ms）`conversation.item.created` ｜ 音频轴：已收 4540 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4969 ms（相对语音结束 +4969 ms）`conversation.item.created` ｜ 音频轴：已收 4740 ms（实送静音 0 ms，此后停传，**越过实送量**）`
- **v3/wk-02/P800**（连接 `f46f5a7c-02d7-4c53-96ad-eb79b697271d`，journal `journal/f46f5a7c-02d7-4c53-96ad-eb79b697271d.jsonl`）：
  - `2390 ms（相对语音结束 +2390 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 1280 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2944 ms（相对语音结束 +2944 ms）`conversation.item.created` ｜ 音频轴：已收 1840 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `9110 ms（相对语音结束 +9110 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 7000 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `9110 ms（相对语音结束 +9110 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 7000 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `9310 ms（相对语音结束 +9310 ms）`conversation.item.input_audio_transcription.completed` transcript=「先按现在的方案做，细节回头再说。」 ｜ 音频轴：已收 7200 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `9360 ms（相对语音结束 +9360 ms）`response.created` ｜ 音频轴：已收 7260 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `9368 ms（相对语音结束 +9368 ms）`conversation.item.created` ｜ 音频轴：已收 7260 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `9518 ms（相对语音结束 +9518 ms）`response.done` usage={"total_tokens":380,"input_tokens":346,"output_tokens":34,"input_tokens_details":{"text_tokens":318,"audio_tokens":28}," ｜ 音频轴：已收 7400 ms（实送静音 0 ms，此后停传，**越过实送量**）`
- **v3/fo-01/base**（连接 `9d953c1a-e868-46c8-b2f5-17ccd9de451d`，journal `journal/9d953c1a-e868-46c8-b2f5-17ccd9de451d.jsonl`）：
  - `1681 ms（相对语音结束 +1681 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 1120 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `1914 ms（相对语音结束 +1914 ms）`conversation.item.created` ｜ 音频轴：已收 1340 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2131 ms（相对语音结束 +2131 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 1560 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2131 ms（相对语音结束 +2131 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 1560 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2266 ms（相对语音结束 +2266 ms）`conversation.item.input_audio_transcription.completed` transcript=「等一下。」 ｜ 音频轴：已收 1700 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2297 ms（相对语音结束 +2297 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 1740 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2463 ms（相对语音结束 +2463 ms）`conversation.item.created` ｜ 音频轴：已收 1900 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3497 ms（相对语音结束 +3497 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 2940 ms（实送静音 0 ms，此后停传，**越过实送量**）`
- **v3/fo-01/P300**（连接 `61b52e32-b84d-4868-819b-f3e3441df3cb`，journal `journal/61b52e32-b84d-4868-819b-f3e3441df3cb.jsonl`）：
  - `1300 ms（相对语音结束 +1300 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 780 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `1525 ms（相对语音结束 +1525 ms）`conversation.item.created` ｜ 音频轴：已收 1000 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `1945 ms（相对语音结束 +1945 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 1440 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `1945 ms（相对语音结束 +1945 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 1440 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2084 ms（相对语音结束 +2084 ms）`conversation.item.input_audio_transcription.completed` transcript=「等一下。」 ｜ 音频轴：已收 1560 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2098 ms（相对语音结束 +2098 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 1580 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2283 ms（相对语音结束 +2283 ms）`conversation.item.created` ｜ 音频轴：已收 1760 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3207 ms（相对语音结束 +3207 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 2700 ms（实送静音 0 ms，此后停传，**越过实送量**）`
- **v3/fo-01/P500**（连接 `44b9d99e-c0d2-4160-a3a0-dd88f404c18c`，journal `journal/44b9d99e-c0d2-4160-a3a0-dd88f404c18c.jsonl`）：
  - `2145 ms（相对语音结束 +2145 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 1080 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2372 ms（相对语音结束 +2372 ms）`conversation.item.created` ｜ 音频轴：已收 1320 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2966 ms（相对语音结束 +2966 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 1900 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2966 ms（相对语音结束 +2966 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 1900 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3097 ms（相对语音结束 +3097 ms）`conversation.item.input_audio_transcription.completed` transcript=「等一下。」 ｜ 音频轴：已收 2040 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3130 ms（相对语音结束 +3130 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 2080 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3406 ms（相对语音结束 +3406 ms）`conversation.item.created` ｜ 音频轴：已收 2340 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `5401 ms（相对语音结束 +5401 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 4340 ms（实送静音 0 ms，此后停传，**越过实送量**）`
- **v3/fo-01/P800**（连接 `ce3aeb3e-e9ba-4e16-8529-fc96022c51c3`，journal `journal/ce3aeb3e-e9ba-4e16-8529-fc96022c51c3.jsonl`）：
  - `1347 ms（相对语音结束 +1347 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 860 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `1573 ms（相对语音结束 +1573 ms）`conversation.item.created` ｜ 音频轴：已收 1080 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `1912 ms（相对语音结束 +1912 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 1420 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `1912 ms（相对语音结束 +1912 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 1420 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2048 ms（相对语音结束 +2048 ms）`conversation.item.input_audio_transcription.completed` transcript=「等一下。」 ｜ 音频轴：已收 1560 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2126 ms（相对语音结束 +2126 ms）`response.created` ｜ 音频轴：已收 1640 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2126 ms（相对语音结束 +2126 ms）`conversation.item.created` ｜ 音频轴：已收 1640 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2140 ms（相对语音结束 +2140 ms）`response.done` usage=null ｜ 音频轴：已收 1660 ms（实送静音 0 ms，此后停传，**越过实送量**）`

**V-3 结论**：以下语料的 item 列表与基线**不一致**（逐位置比对，位置即第几条 item；**位置不指认是哪一段**——差异既出现在第一句被拆出的分条上，也出现在恢复段，故只能读成「这两条连接对同一段音频转出了不同的字」）：wk-01(P300@第2条、P500@第4条、P800@第4条)、wk-02(P800@第2条)、fo-01(P800@第4条)；wk-01: 基线 4 条「这段逻辑我觉得应该可以了。|就这样吧。|这段逻辑我觉得应该可以了。|吧。」/ P300 4 条「这段逻辑我觉得应该可以了。|这样吧。|这段逻辑我觉得应该可以了。|这样吧。」 / P500 4 条「这段逻辑我觉得应该可以了。|就这样吧。|这段逻辑我觉得应该可以了。|就这样吧。」 / P800 4 条「这段逻辑我觉得应该可以了。|就这样吧。|这段逻辑我觉得应该可以了。|这样吧。」；wk-02: 基线 2 条「先按现在的方案做，细节回头再说。|先按现在的方案做，细节回头再说。」/ P300 2 条「先按现在的方案做，细节回头再说。|先按现在的方案做，细节回头再说。」 / P500 2 条「先按现在的方案做，细节回头再说。|先按现在的方案做，细节回头再说。」 / P800 1 条「先按现在的方案做，细节回头再说。」；fo-01: 基线 4 条「等一下。|先停下来。|等一下。|先停下来。」/ P300 4 条「等一下。|先停下来。|等一下。|先停下来。」 / P500 4 条「等一下。|先停下来。|等一下。|先停下来。」 / P800 4 条「等一下。|先停下来。|等一下。|停下来。」。

## V-4 恢复前的上游状态

做法：从 V-1 / V-3 的事件时间线读——tail 之后上游是否已 `input_audio_buffer.committed`、恢复时是否出现空 commit 错误或多余条目。

`input_audio_buffer.committed` 帧合计 42；空 commit / buffer-too-small 类错误 0；多余条目计数 0（= 上游自建的用户条目数 − `speech_started` 次数，取正）。

| 连接 | 连接 id | committed | 用户条目 / 起说 | 错误 |
| --- | --- | --- | --- | --- |
| v1/D400/−100ms | `99290394-ae7c-4da5-b445-14ff7088c705` | 0 | 1 / 1 | 0 |
| v1/D400/+100ms | `0e21ff10-5663-436f-ad47-560973a29283` | 1 | 1 / 1 | 0 |
| v1/D800/−100ms | `73721f37-2963-4d8e-b87c-43de096cbaf1` | 0 | 1 / 1 | 0 |
| v1/D800/+100ms | `3f70dd11-1ea4-4b05-a425-f07287848658` | 1 | 1 / 1 | 0 |
| v3/wk-01/base | `369939b2-1495-4d11-9ba8-f25b867aaecc` | 4 | 4 / 4 | 0 |
| v3/wk-01/P300 | `fc385f87-867c-420e-8199-c7ca54c9df63` | 4 | 4 / 4 | 0 |
| v3/wk-01/P500 | `3a75771c-af0f-4050-9520-8798dc021212` | 4 | 4 / 4 | 0 |
| v3/wk-01/P800 | `c83453cd-054b-482f-bce5-e1b577c1cd4d` | 4 | 4 / 4 | 0 |
| v3/wk-02/base | `697a4ca7-dd47-4523-ac04-5fb8f4414003` | 2 | 2 / 2 | 0 |
| v3/wk-02/P300 | `250e8b0e-5c5b-4410-b078-082f5e981701` | 2 | 2 / 2 | 0 |
| v3/wk-02/P500 | `bd5544bc-3202-43c4-a395-95d4e6133773` | 2 | 2 / 2 | 0 |
| v3/wk-02/P800 | `f46f5a7c-02d7-4c53-96ad-eb79b697271d` | 2 | 2 / 2 | 2 |
| v3/fo-01/base | `9d953c1a-e868-46c8-b2f5-17ccd9de451d` | 4 | 4 / 4 | 0 |
| v3/fo-01/P300 | `61b52e32-b84d-4868-819b-f3e3441df3cb` | 4 | 4 / 4 | 0 |
| v3/fo-01/P500 | `44b9d99e-c0d2-4160-a3a0-dd88f404c18c` | 4 | 4 / 4 | 0 |
| v3/fo-01/P800 | `ce3aeb3e-e9ba-4e16-8529-fc96022c51c3` | 4 | 4 / 4 | 0 |

**连接 id 与事件摘录**

- **v1/D400/−100ms**（连接 `99290394-ae7c-4da5-b445-14ff7088c705`，journal `journal/99290394-ae7c-4da5-b445-14ff7088c705.jsonl`）：
  - `618 ms（相对语音结束 -1785 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 -1800 ms（实送静音 300 ms）`
  - `910 ms（相对语音结束 -1493 ms）`conversation.item.created` ｜ 音频轴：已收 -1500 ms（实送静音 300 ms）`
- **v1/D400/+100ms**（连接 `0e21ff10-5663-436f-ad47-560973a29283`，journal `journal/0e21ff10-5663-436f-ad47-560973a29283.jsonl`）：
  - `2034 ms（相对语音结束 -1168 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 -1180 ms（实送静音 500 ms）`
  - `2259 ms（相对语音结束 -943 ms）`conversation.item.created` ｜ 音频轴：已收 -960 ms（实送静音 500 ms）`
  - `6704 ms（相对语音结束 +3502 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 500 ms（实送静音 500 ms，此后停传）`
  - `6704 ms（相对语音结束 +3502 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 500 ms（实送静音 500 ms，此后停传）`
  - `6899 ms（相对语音结束 +3697 ms）`conversation.item.input_audio_transcription.completed` transcript=「帮我看看登陆页今天改了什么。」 ｜ 音频轴：已收 500 ms（实送静音 500 ms，此后停传）`
  - `6979 ms（相对语音结束 +3777 ms）`response.created` ｜ 音频轴：已收 500 ms（实送静音 500 ms，此后停传）`
- **v1/D800/−100ms**（连接 `73721f37-2963-4d8e-b87c-43de096cbaf1`，journal `journal/73721f37-2963-4d8e-b87c-43de096cbaf1.jsonl`）：
  - `1386 ms（相对语音结束 -1585 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 -1600 ms（实送静音 700 ms）`
  - `1619 ms（相对语音结束 -1352 ms）`conversation.item.created` ｜ 音频轴：已收 -1360 ms（实送静音 700 ms）`
- **v1/D800/+100ms**（连接 `3f70dd11-1ea4-4b05-a425-f07287848658`，journal `journal/3f70dd11-1ea4-4b05-a425-f07287848658.jsonl`）：
  - `682 ms（相对语音结束 -1716 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 -1720 ms（实送静音 900 ms）`
  - `921 ms（相对语音结束 -1477 ms）`conversation.item.created` ｜ 音频轴：已收 -1480 ms（实送静音 900 ms）`
  - `3331 ms（相对语音结束 +933 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 900 ms（实送静音 900 ms，此后停传）`
  - `3331 ms（相对语音结束 +933 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 900 ms（实送静音 900 ms，此后停传）`
  - `3537 ms（相对语音结束 +1139 ms）`conversation.item.input_audio_transcription.completed` transcript=「帮我看看登陆页今天改了什么。」 ｜ 音频轴：已收 900 ms（实送静音 900 ms，此后停传）`
  - `3574 ms（相对语音结束 +1176 ms）`response.created` ｜ 音频轴：已收 900 ms（实送静音 900 ms，此后停传）`
- **v3/wk-01/base**（连接 `369939b2-1495-4d11-9ba8-f25b867aaecc`，journal `journal/369939b2-1495-4d11-9ba8-f25b867aaecc.jsonl`）：
  - `1561 ms（相对语音结束 +1561 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 1020 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `1843 ms（相对语音结束 +1843 ms）`conversation.item.created` ｜ 音频轴：已收 1300 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `6238 ms（相对语音结束 +6238 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 5700 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `6238 ms（相对语音结束 +6238 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 5700 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `6405 ms（相对语音结束 +6405 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 5860 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `6431 ms（相对语音结束 +6431 ms）`conversation.item.input_audio_transcription.completed` transcript=「这段逻辑我觉得应该可以了。」 ｜ 音频轴：已收 5880 ms（实送静音 0 ms，此后停传，**越过实送量**）`
- **v3/wk-01/P300**（连接 `fc385f87-867c-420e-8199-c7ca54c9df63`，journal `journal/fc385f87-867c-420e-8199-c7ca54c9df63.jsonl`）：
  - `1136 ms（相对语音结束 +1136 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 860 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `1393 ms（相对语音结束 +1393 ms）`conversation.item.created` ｜ 音频轴：已收 1120 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3676 ms（相对语音结束 +3676 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 3400 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3676 ms（相对语音结束 +3676 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 3400 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3789 ms（相对语音结束 +3789 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 3520 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3876 ms（相对语音结束 +3876 ms）`conversation.item.input_audio_transcription.completed` transcript=「这段逻辑我觉得应该可以了。」 ｜ 音频轴：已收 3600 ms（实送静音 0 ms，此后停传，**越过实送量**）`
- **v3/wk-01/P500**（连接 `3a75771c-af0f-4050-9520-8798dc021212`，journal `journal/3a75771c-af0f-4050-9520-8798dc021212.jsonl`）：
  - `1088 ms（相对语音结束 +1088 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 860 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `1308 ms（相对语音结束 +1308 ms）`conversation.item.created` ｜ 音频轴：已收 1080 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3565 ms（相对语音结束 +3565 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 3340 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3565 ms（相对语音结束 +3565 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 3340 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3730 ms（相对语音结束 +3730 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 3500 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3754 ms（相对语音结束 +3754 ms）`conversation.item.input_audio_transcription.completed` transcript=「这段逻辑我觉得应该可以了。」 ｜ 音频轴：已收 3540 ms（实送静音 0 ms，此后停传，**越过实送量**）`
- **v3/wk-01/P800**（连接 `c83453cd-054b-482f-bce5-e1b577c1cd4d`，journal `journal/c83453cd-054b-482f-bce5-e1b577c1cd4d.jsonl`）：
  - `1566 ms（相对语音结束 +1566 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 1020 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `1823 ms（相对语音结束 +1823 ms）`conversation.item.created` ｜ 音频轴：已收 1280 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `8668 ms（相对语音结束 +8668 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 7060 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `8668 ms（相对语音结束 +8668 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 7060 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `8834 ms（相对语音结束 +8834 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 7220 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `8862 ms（相对语音结束 +8862 ms）`conversation.item.input_audio_transcription.completed` transcript=「这段逻辑我觉得应该可以了。」 ｜ 音频轴：已收 7240 ms（实送静音 0 ms，此后停传，**越过实送量**）`
- **v3/wk-02/base**（连接 `697a4ca7-dd47-4523-ac04-5fb8f4414003`，journal `journal/697a4ca7-dd47-4523-ac04-5fb8f4414003.jsonl`）：
  - `1225 ms（相对语音结束 +1225 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 980 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `1520 ms（相对语音结束 +1520 ms）`conversation.item.created` ｜ 音频轴：已收 1280 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4553 ms（相对语音结束 +4553 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 4300 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4553 ms（相对语音结束 +4553 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 4300 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4786 ms（相对语音结束 +4786 ms）`response.created` ｜ 音频轴：已收 4540 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4786 ms（相对语音结束 +4786 ms）`conversation.item.created` ｜ 音频轴：已收 4540 ms（实送静音 0 ms，此后停传，**越过实送量**）`
- **v3/wk-02/P300**（连接 `250e8b0e-5c5b-4410-b078-082f5e981701`，journal `journal/250e8b0e-5c5b-4410-b078-082f5e981701.jsonl`）：
  - `1828 ms（相对语音结束 +1828 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 880 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2189 ms（相对语音结束 +2189 ms）`conversation.item.created` ｜ 音频轴：已收 1240 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `5346 ms（相对语音结束 +5346 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 4380 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `5346 ms（相对语音结束 +5346 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 4380 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `5535 ms（相对语音结束 +5535 ms）`response.created` ｜ 音频轴：已收 4580 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `5535 ms（相对语音结束 +5535 ms）`conversation.item.created` ｜ 音频轴：已收 4580 ms（实送静音 0 ms，此后停传，**越过实送量**）`
- **v3/wk-02/P500**（连接 `bd5544bc-3202-43c4-a395-95d4e6133773`，journal `journal/bd5544bc-3202-43c4-a395-95d4e6133773.jsonl`）：
  - `1091 ms（相对语音结束 +1091 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 860 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `1481 ms（相对语音结束 +1481 ms）`conversation.item.created` ｜ 音频轴：已收 1240 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4519 ms（相对语音结束 +4519 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 4280 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4519 ms（相对语音结束 +4519 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 4280 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4761 ms（相对语音结束 +4761 ms）`conversation.item.input_audio_transcription.completed` transcript=「先按现在的方案做，细节回头再说。」 ｜ 音频轴：已收 4520 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4770 ms（相对语音结束 +4770 ms）`response.created` ｜ 音频轴：已收 4540 ms（实送静音 0 ms，此后停传，**越过实送量**）`
- **v3/wk-02/P800**（连接 `f46f5a7c-02d7-4c53-96ad-eb79b697271d`，journal `journal/f46f5a7c-02d7-4c53-96ad-eb79b697271d.jsonl`）：
  - `2390 ms（相对语音结束 +2390 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 1280 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2944 ms（相对语音结束 +2944 ms）`conversation.item.created` ｜ 音频轴：已收 1840 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `9110 ms（相对语音结束 +9110 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 7000 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `9110 ms（相对语音结束 +9110 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 7000 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `9310 ms（相对语音结束 +9310 ms）`conversation.item.input_audio_transcription.completed` transcript=「先按现在的方案做，细节回头再说。」 ｜ 音频轴：已收 7200 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `9360 ms（相对语音结束 +9360 ms）`response.created` ｜ 音频轴：已收 7260 ms（实送静音 0 ms，此后停传，**越过实送量**）`
- **v3/fo-01/base**（连接 `9d953c1a-e868-46c8-b2f5-17ccd9de451d`，journal `journal/9d953c1a-e868-46c8-b2f5-17ccd9de451d.jsonl`）：
  - `1681 ms（相对语音结束 +1681 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 1120 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `1914 ms（相对语音结束 +1914 ms）`conversation.item.created` ｜ 音频轴：已收 1340 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2131 ms（相对语音结束 +2131 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 1560 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2131 ms（相对语音结束 +2131 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 1560 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2266 ms（相对语音结束 +2266 ms）`conversation.item.input_audio_transcription.completed` transcript=「等一下。」 ｜ 音频轴：已收 1700 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2297 ms（相对语音结束 +2297 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 1740 ms（实送静音 0 ms，此后停传，**越过实送量**）`
- **v3/fo-01/P300**（连接 `61b52e32-b84d-4868-819b-f3e3441df3cb`，journal `journal/61b52e32-b84d-4868-819b-f3e3441df3cb.jsonl`）：
  - `1300 ms（相对语音结束 +1300 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 780 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `1525 ms（相对语音结束 +1525 ms）`conversation.item.created` ｜ 音频轴：已收 1000 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `1945 ms（相对语音结束 +1945 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 1440 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `1945 ms（相对语音结束 +1945 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 1440 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2084 ms（相对语音结束 +2084 ms）`conversation.item.input_audio_transcription.completed` transcript=「等一下。」 ｜ 音频轴：已收 1560 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2098 ms（相对语音结束 +2098 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 1580 ms（实送静音 0 ms，此后停传，**越过实送量**）`
- **v3/fo-01/P500**（连接 `44b9d99e-c0d2-4160-a3a0-dd88f404c18c`，journal `journal/44b9d99e-c0d2-4160-a3a0-dd88f404c18c.jsonl`）：
  - `2145 ms（相对语音结束 +2145 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 1080 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2372 ms（相对语音结束 +2372 ms）`conversation.item.created` ｜ 音频轴：已收 1320 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2966 ms（相对语音结束 +2966 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 1900 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2966 ms（相对语音结束 +2966 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 1900 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3097 ms（相对语音结束 +3097 ms）`conversation.item.input_audio_transcription.completed` transcript=「等一下。」 ｜ 音频轴：已收 2040 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3130 ms（相对语音结束 +3130 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 2080 ms（实送静音 0 ms，此后停传，**越过实送量**）`
- **v3/fo-01/P800**（连接 `ce3aeb3e-e9ba-4e16-8529-fc96022c51c3`，journal `journal/ce3aeb3e-e9ba-4e16-8529-fc96022c51c3.jsonl`）：
  - `1347 ms（相对语音结束 +1347 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 860 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `1573 ms（相对语音结束 +1573 ms）`conversation.item.created` ｜ 音频轴：已收 1080 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `1912 ms（相对语音结束 +1912 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 1420 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `1912 ms（相对语音结束 +1912 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 1420 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2048 ms（相对语音结束 +2048 ms）`conversation.item.input_audio_transcription.completed` transcript=「等一下。」 ｜ 音频轴：已收 1560 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2126 ms（相对语音结束 +2126 ms）`response.created` ｜ 音频轴：已收 1640 ms（实送静音 0 ms，此后停传，**越过实送量**）`

**V-4 结论**：tail 后上游自行 `input_audio_buffer.commit` 帧 42 次；恢复讲话时空 commit / buffer-too-small 类错误 0 次；多余条目 0（判据同表头：用户条目多于起说次数的部分）。

## V-5 误判（本地确定性，不连上游）

检测器：偏向语音的低阈值 + 稳健底噪估计（1.5 s 滑窗 15 分位，只用非语音帧、排除数字静音帧）+ 320 ms 挂起。指标：误判静音率（语音帧被判静音）应尽量为 0；误判语音率仅作记录。

| 料 | 被判语音帧 / 总帧 | 比率 | 说明 |
| --- | --- | --- | --- |
| 底噪 stand-in | 0/150 | 0.0% | 误判语音（成本） |
| 键盘声 stand-in | 147/150 | 98.0% | 误判语音（成本） |
| 低音量 lv-01 | 0/106 | 0.0% | 误判静音（正确性） |
| 低音量 lv-02 | 2/68 | 2.9% | 误判静音（正确性） |
| 语音 sp-01 | 0/96 | 0.0% | 误判静音（正确性） |
| 语音 sp-02 | 0/121 | 0.0% | 误判静音（正确性） |
| 语音 sp-03 | 2/109 | 1.8% | 误判静音（正确性） |
| 语音 wk-01 | 0/139 | 0.0% | 误判静音（正确性） |
| 语音 wk-02 | 2/129 | 1.6% | 误判静音（正确性） |
| 语音 fo-01 | 0/65 | 0.0% | 误判静音（正确性） |

**V-5 结论**：语音帧被判静音合计 6 帧（**非 0**，需调检测器）；误判语音（底噪+键盘）合计 147 帧。

### V-5b —— 检测器放在 STS 臂**真正看到的那条轨**上（本地，不连上游）

上面那张表测的是**独立**的一段 3 s 底噪；STS 臂跑的是 `底噪 500 ms + 语音 + 底噪 4000 ms + 同一句 + 底噪 2000 ms` 的拼接轨。
检测器的状态（自适应底噪、挂起）在整轨上连续演进，而且 tail 要求 `T` 毫秒内**一次误判都不能有**——
噪声段里被判成语音的帧会直接打断 tail、把停传计时清零。这一项就是把检测器放回那条轨上量。

| 语料 | 轨长 | 噪声段帧 | 噪声段被判语音 | 噪声段 db 范围 | 噪声段 floor 范围 | 语音段帧 | 语音段被判语音 | 最长连续 tail | tail 段数 | 停传（T=2000 ms, P=500 ms） |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sp-01 | 10.8 s | 325 | 26（首次 2670 ms（该轨第 2670 ms 处）） | -60…-50 dB | -57…-55 dB | 216 | 208 | 1980 ms | 3 | 1.8 s |
| sp-02 | 11.6 s | 325 | 26（首次 3070 ms（该轨第 3070 ms 处）） | -60…-50 dB | -57…-55 dB | 256 | 248 | 1980 ms | 3 | 1.8 s |
| sp-03 | 11.9 s | 325 | 23（首次 3230 ms（该轨第 3230 ms 处）） | -60…-50 dB | -57…-55 dB | 272 | 262 | 1980 ms | 3 | 1.9 s |
| wk-01 | 13.1 s | 325 | 26（首次 3790 ms（该轨第 3790 ms 处）） | -60…-50 dB | -57…-55 dB | 328 | 320 | 1980 ms | 3 | 1.8 s |
| wk-02 | 12.9 s | 325 | 30（首次 3710 ms（该轨第 3710 ms 处）） | -60…-50 dB | -59…-55 dB | 320 | 310 | 1980 ms | 3 | 1.8 s |
| fo-01 | 9.7 s | 325 | 44（首次 2130 ms（该轨第 2130 ms 处）） | -60…-50 dB | -64…-55 dB | 162 | 162 | 1980 ms | 3 | 1.4 s |
| lv-01 | 12.3 s | 325 | 134（首次 3390 ms（该轨第 3390 ms 处）） | -60…-50 dB | -64…-55 dB | 288 | 280 | 1980 ms | 3 | 0.8 s |
| lv-02 | 10.3 s | 325 | 80（首次 2430 ms（该轨第 2430 ms 处）） | -60…-50 dB | -62…-55 dB | 192 | 163 | 1980 ms | 3 | 1.3 s |

**V-5b 结论**：在真正的那条轨上，一次 tail 最长连续到 1980 ms（**短于 T = 2000 ms**，tail 计时到不了阈值）；停传（T=2000 ms、P=500 ms）在 8 条语料上介于 0.8–1.9 s，**没有一条为 0**。噪声段里被判语音的帧介于 23–134 帧/条（合计 389 帧），最多的一条是 `lv-01`。这直接给出「尾音停传」在**本原型**上的实现约束：tail 计时要求 T 毫秒内**一次误判都不能有**，所以它不能在任何一帧上清零——挂起（hangover）是每帧级的，不是 tail 级的。误判集中在一段语音刚结束处（挂起刚走完、底噪估计还没收敛回环境值），低音量 stand-in 最严重：它的安静帧比环境底噪还低，会被底噪估计当成环境，把门限拖低。

## V-6 模式关系

STS 与模式的关系：

- **continuous**（上游 `server_vad`）：STS 的目标模式。上游自己断句，STS 只减少空音频上传。
- **`VOICE_REALTIME_SEGMENT_COMMIT=server-vad`（回退）**：断句权在客户端（`segment_start/segment_end`），tail 门控无意义，不启用。
- **segmented / manual**：同上，客户端已接管边界。

本项为代码面陈述（本探针不改产品代码，未起产品连接）；任务书 V-6 标注为「可选，预算允许时」，本次未花预算做产品对照。

本项**未开专用连接**：它问的是「原型挂在哪种 relay 上」，而原型只存在于本实验脚本里（不改产品代码），所以答案只能在模式模块与桥接分支的**代码面**上陈述，不存在可作为读数的上游连接。

## V-7 等价性（两臂对照）

做法：同一语料（3 条）两臂——**基线**逐帧全传（continuous）vs **STS** `T=2000ms, P=500ms`。

| 语料 | 臂 | 连接 id | 条目数 | `speech_stopped` 偏移 | response 数 | 工具调用 | usage text | usage audio | output |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sp-01 | baseline | `7b08116f-7fb1-4dc2-829f-9418445e5e2a` | 1 | 2960 ms | 2 | 1 | 388 | 21 | 25 |
| sp-02 | baseline | `001ee684-9389-4db3-953d-f090806b4938` | 1 | 5707 ms | 2 | 1 | 390 | 21 | 9 |
| sp-03 | baseline | `c032f9fb-73b6-4f4b-a9b3-679cf6775a4d` | 1 | 3430 ms | 2 | 1 | 407 | 21 | 8 |
| sp-01 | sts | `81d8cd54-41a8-4243-bc11-ec7effa61879` | 1 | 2941 ms | 2 | 1 | 389 | 21 | 13 |
| sp-02 | sts | `ba6cf7de-dad0-4197-b499-9de8e47f11d3` | 1 | 4207 ms | 2 | 1 | 390 | 21 | 7 |
| sp-03 | sts | `10a2f942-e155-4a33-b795-32769d88c6c4` | 1 | 4166 ms | 2 | 1 | 406 | 21 | 7 |

**连接 id 与事件摘录**

- **v7/baseline/sp-01**（连接 `7b08116f-7fb1-4dc2-829f-9418445e5e2a`，journal `journal/7b08116f-7fb1-4dc2-829f-9418445e5e2a.jsonl`）：
  - `643 ms（相对语音结束 +643 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 380 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `1035 ms（相对语音结束 +1035 ms）`conversation.item.created` ｜ 音频轴：已收 780 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2960 ms（相对语音结束 +2960 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 2700 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2960 ms（相对语音结束 +2960 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 2700 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3216 ms（相对语音结束 +3216 ms）`conversation.item.input_audio_transcription.completed` transcript=「帮我看看登陆页今天改了什么。」 ｜ 音频轴：已收 2960 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3237 ms（相对语音结束 +3237 ms）`response.created` ｜ 音频轴：已收 2980 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3238 ms（相对语音结束 +3238 ms）`conversation.item.created` ｜ 音频轴：已收 2980 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3373 ms（相对语音结束 +3373 ms）`response.done` usage={"total_tokens":370,"input_tokens":339,"output_tokens":31,"input_tokens_details":{"text_tokens":318,"audio_tokens":21}," ｜ 音频轴：已收 3100 ms（实送静音 0 ms，此后停传，**越过实送量**）`
- **v7/baseline/sp-02**（连接 `001ee684-9389-4db3-953d-f090806b4938`，journal `journal/001ee684-9389-4db3-953d-f090806b4938.jsonl`）：
  - `1827 ms（相对语音结束 +1827 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 780 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2025 ms（相对语音结束 +2025 ms）`conversation.item.created` ｜ 音频轴：已收 980 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `5707 ms（相对语音结束 +5707 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 4660 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `5708 ms（相对语音结束 +5708 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 4660 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `5908 ms（相对语音结束 +5908 ms）`conversation.item.input_audio_transcription.completed` transcript=「把刚才那个函数拆成两个小函数。」 ｜ 音频轴：已收 4860 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `5949 ms（相对语音结束 +5949 ms）`response.created` ｜ 音频轴：已收 4920 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `5950 ms（相对语音结束 +5950 ms）`conversation.item.created` ｜ 音频轴：已收 4920 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `6089 ms（相对语音结束 +6089 ms）`response.done` usage={"total_tokens":372,"input_tokens":339,"output_tokens":33,"input_tokens_details":{"text_tokens":318,"audio_tokens":21}," ｜ 音频轴：已收 5060 ms（实送静音 0 ms，此后停传，**越过实送量**）`
- **v7/baseline/sp-03**（连接 `c032f9fb-73b6-4f4b-a9b3-679cf6775a4d`，journal `journal/c032f9fb-73b6-4f4b-a9b3-679cf6775a4d.jsonl`）：
  - `634 ms（相对语音结束 +634 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 380 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `915 ms（相对语音结束 +915 ms）`conversation.item.created` ｜ 音频轴：已收 660 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3430 ms（相对语音结束 +3430 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 3180 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3431 ms（相对语音结束 +3431 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 3180 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3631 ms（相对语音结束 +3631 ms）`response.created` ｜ 音频轴：已收 3380 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3631 ms（相对语音结束 +3631 ms）`conversation.item.created` ｜ 音频轴：已收 3380 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3652 ms（相对语音结束 +3652 ms）`conversation.item.input_audio_transcription.completed` transcript=「测试里再补一个空输入的例子。」 ｜ 音频轴：已收 3400 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3741 ms（相对语音结束 +3741 ms）`conversation.item.created` ｜ 音频轴：已收 3500 ms（实送静音 0 ms，此后停传，**越过实送量**）`
- **v7/sts/sp-01**（连接 `81d8cd54-41a8-4243-bc11-ec7effa61879`，journal `journal/81d8cd54-41a8-4243-bc11-ec7effa61879.jsonl`）：
  - `626 ms（相对语音结束 +626 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 380 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `896 ms（相对语音结束 +896 ms）`conversation.item.created` ｜ 音频轴：已收 640 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2941 ms（相对语音结束 +2941 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 2700 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `2942 ms（相对语音结束 +2942 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 2700 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3178 ms（相对语音结束 +3178 ms）`conversation.item.input_audio_transcription.completed` transcript=「帮我看看登陆页今天改了什么。」 ｜ 音频轴：已收 2920 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3223 ms（相对语音结束 +3223 ms）`response.created` ｜ 音频轴：已收 2980 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3223 ms（相对语音结束 +3223 ms）`conversation.item.created` ｜ 音频轴：已收 2980 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `3382 ms（相对语音结束 +3382 ms）`response.done` usage={"total_tokens":371,"input_tokens":339,"output_tokens":32,"input_tokens_details":{"text_tokens":318,"audio_tokens":21}," ｜ 音频轴：已收 3140 ms（实送静音 0 ms，此后停传，**越过实送量**）`
- **v7/sts/sp-02**（连接 `ba6cf7de-dad0-4197-b499-9de8e47f11d3`，journal `journal/ba6cf7de-dad0-4197-b499-9de8e47f11d3.jsonl`）：
  - `1531 ms（相对语音结束 +1531 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 720 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `1761 ms（相对语音结束 +1761 ms）`conversation.item.created` ｜ 音频轴：已收 940 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4207 ms（相对语音结束 +4207 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 3400 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4207 ms（相对语音结束 +4207 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 3400 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4418 ms（相对语音结束 +4418 ms）`conversation.item.input_audio_transcription.completed` transcript=「把刚才那个函数拆成两个小函数。」 ｜ 音频轴：已收 3600 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4472 ms（相对语音结束 +4472 ms）`response.created` ｜ 音频轴：已收 3660 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4472 ms（相对语音结束 +4472 ms）`conversation.item.created` ｜ 音频轴：已收 3660 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4609 ms（相对语音结束 +4609 ms）`response.done` usage={"total_tokens":372,"input_tokens":339,"output_tokens":33,"input_tokens_details":{"text_tokens":318,"audio_tokens":21}," ｜ 音频轴：已收 3800 ms（实送静音 0 ms，此后停传，**越过实送量**）`
- **v7/sts/sp-03**（连接 `10a2f942-e155-4a33-b795-32769d88c6c4`，journal `journal/10a2f942-e155-4a33-b795-32769d88c6c4.jsonl`）：
  - `1157 ms（相对语音结束 +1157 ms）`input_audio_buffer.speech_started` ｜ 音频轴：已收 600 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `1708 ms（相对语音结束 +1708 ms）`conversation.item.created` ｜ 音频轴：已收 1140 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4166 ms（相对语音结束 +4166 ms）`input_audio_buffer.speech_stopped` ｜ 音频轴：已收 3600 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4166 ms（相对语音结束 +4166 ms）`input_audio_buffer.committed` ｜ 音频轴：已收 3600 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4384 ms（相对语音结束 +4384 ms）`response.created` ｜ 音频轴：已收 3820 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4384 ms（相对语音结束 +4384 ms）`conversation.item.created` ｜ 音频轴：已收 3820 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4401 ms（相对语音结束 +4401 ms）`conversation.item.input_audio_transcription.completed` transcript=「测试里再补一个空输入的例子。」 ｜ 音频轴：已收 3840 ms（实送静音 0 ms，此后停传，**越过实送量**）`
  - `4499 ms（相对语音结束 +4499 ms）`conversation.item.created` ｜ 音频轴：已收 3940 ms（实送静音 0 ms，此后停传，**越过实送量**）`

**V-7 结论**：条目数 基线 3 / STS 3；response 数 基线 6 / STS 6；工具调用 基线 3 / STS 3。两臂在这些计数上一致。 条目边界与 `speech_stopped` 时刻的逐条对照见上表；usage（text/audio 分列）见上表。

## V-8 上传节省

| 臂 | 上传秒数 | 会话秒数 | 上传/会话 |
| --- | --- | --- | --- |
| baseline | 25.4 | 34.5 | 73.8% |
| sts | 14.4 | 34.5 | 41.7% |

两臂的连接 id：baseline=`7b08116f-7fb1-4dc2-829f-9418445e5e2a` `001ee684-9389-4db3-953d-f090806b4938` `c032f9fb-73b6-4f4b-a9b3-679cf6775a4d`；sts=`81d8cd54-41a8-4243-bc11-ec7effa61879` `ba6cf7de-dad0-4197-b499-9de8e47f11d3` `10a2f942-e155-4a33-b795-32769d88c6c4`（事件摘录见 §V-7）。

**V-8 结论**：上传秒数 基线 25.4 / STS 14.4（会话秒数 基线 34.5 / STS 34.5）；STS 相对基线少传 43.4%。

## T / P 推荐

T 推荐：依据 V-1 帧边界扫描（**直接读数**：D=400 ms 下，送 500 ms 真实静音触发 `speech_stopped`、比它短的都不触发），与 V-1 四档判定「音频时间轴」一致，tail 必须自己跨过这个长度，故 `T ≥ 500 ms + 余量`。本探针 STS 臂取 `T = 2 s`；V-7 两臂对照：条目数 基线 3 / STS 3；response 数 基线 6 / STS 6；工具调用 基线 3 / STS 3；V-2 另给出一条**上界**：3 条停传连接在连接建立后 304–306 s 被上游以关闭码 1007 断开，故 tail 与随后任何停传都远低于该值（`{1,2,3} s` 的三个候选都低两个数量级）。候选取值 `{1, 2, 3} s` 中取**最小的、仍高出读数下界 500 ms 余量**的一档，据推荐 **T = 1 s**（读数下界 500 ms）。

P 推荐：不足以推荐：以下语料的 item 列表与基线**不一致**（逐位置比对，位置即第几条 item；**位置不指认是哪一段**——差异既出现在第一句被拆出的分条上，也出现在恢复段，故只能读成「这两条连接对同一段音频转出了不同的字」）：wk-01(P300@第2条、P500@第4条、P800@第4条)、wk-02(P800@第2条)、fo-01(P800@第4条)；wk-01: 基线 4 条「这段逻辑我觉得应该可以了。|就这样吧。|这段逻辑我觉得应该可以了。|吧。」/ P300 4 条「这段逻辑我觉得应该可以了。|这样吧。|这段逻辑我觉得应该可以了。|这样吧。」 / P500 4 条「这段逻辑我觉得应该可以了。|就这样吧。|这段逻辑我觉得应该可以了。|就这样吧。」 / P800 4 条「这段逻辑我觉得应该可以了。|就这样吧。|这段逻辑我觉得应该可以了。|这样吧。」；wk-02: 基线 2 条「先按现在的方案做，细节回头再说。|先按现在的方案做，细节回头再说。」/ P300 2 条「先按现在的方案做，细节回头再说。|先按现在的方案做，细节回头再说。」 / P500 2 条「先按现在的方案做，细节回头再说。|先按现在的方案做，细节回头再说。」 / P800 1 条「先按现在的方案做，细节回头再说。」；fo-01: 基线 4 条「等一下。|先停下来。|等一下。|先停下来。」/ P300 4 条「等一下。|先停下来。|等一下。|先停下来。」 / P500 4 条「等一下。|先停下来。|等一下。|先停下来。」 / P800 4 条「等一下。|先停下来。|等一下。|停下来。」。 注意**同一段音频在同一条连接里也会转出不同的字**（对照上表基线臂第一句与第二句，是同一个语料句），所以「与基线不一致」不能单独归因给 P；本运行区分不出 `P ∈ {300,500,800} ms` 的差别，不给出 `P` 取值，需在转写更稳定的语料上重测。

## 方法与限制（如实记录）

1. **直连上游**。本探针用一个 raw WS 客户端直连 `qwen3.8-omni-flash-realtime`，逐 20 ms 帧决定上传与否——
   这是产品 relay 表达不了的实验自由度（停传 / 前滚 / 尾音都要求「这一刻不发这一帧」）。`session.update` 的
   `session` 体取自出货 transport 的形状（`pcm16` 入、`pcm24` 出、`voice: Tina`、`server_vad`）。
2. **合成会话 + 记录式执行器**。会话是合成的（`sessionId` 任何库里都不存在）；会话声明的 `session_send`
   由脚本承接：模型每次调用只被记进 journal 并回一个 `{"dryRun":true}` 合成 output，绝不落到任何真实会话。
3. **stand-in 而非真人录音**。本机无麦克风，底噪 / 键盘声用合成噪声 stand-in；低音量语音用整段增益；
   弱尾音用末尾淡出；快速起音用掐头。它们足以回答「上游会不会把这些判成静音 / 语音」这类**声学类别**问题，
   但不等于真人语料。语料音频由 DashScope TTS 合成（另行计费，未计入下面 `花费：`）。
4. **花费是估算**。`estimateRealtimeCostCny` 是出货的估算公式（文本入 0.0015、音频入 0.006、文本出 0.0045 CNY / 1k token），
   账单以官方为准；这里报的是与出货花费守卫**同一个**读数，不是发票。V-2 的长停传消耗的是墙钟时间，不是 token。
5. **取数前的管线预检**。管线预演（读数一律不采用）：本报告取自唯一一次完整运行。此前为验证管线跑过 4 轮预演，读数全部不采用：① --sections v1 ×2 共 18 条连接，¥0.0053；② --sections v3,v4,v5,v6,v7,v8，¥0.0378；③ --sections v3，¥0.0279；④ --sections v3,v7，¥0.0378；另有 --sections v5 与 --report-only 为纯本地零花费。预演合计 ¥0.1088，不计入本次运行「花费」字段（该字段只统计本次运行的连接）。预演期间修正过探针的本地静音检测器（底噪估计被片段内数字静音帧带偏，导致从未停传）与 V-3 的对比对象（原先比的是被上游按逗号拆出的条目，与停传无关），因此预演读数与本次读数不可比。
   另有一处**派生量**的修正，同样没有重跑上游：V-2 的「恢复上传起点 / 恢复后新转写」在本次运行首次落盘时取错了事件（取成「连接内第一条转写」，而它落在停传**之前**，于是 1 min / 5 min 两档算出负延迟 −59.8 s / −300.3 s）。该字段已改为从**同一次运行记录的帧时间线**离线定位（停传 = 相邻 `input_audio_buffer.append` 之间 ≥ 30 s 的间隔；恢复点 = 该间隔右侧那一帧；新转写 = 时刻不早于恢复点的 `…transcription.completed`），见 §V-2 做法。§V-2 表里 4 行的数值都来自上面那**一个**快照，读数本身没有换。

## 复现

```bash
npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-silence-tail-suppression/probe.mts
```

本次运行目录 `/tmp/sts-full`（journal 在 `/tmp/sts-full/journal`）。运行目录是临时的：它不随提交保留，表本身就是读数。
