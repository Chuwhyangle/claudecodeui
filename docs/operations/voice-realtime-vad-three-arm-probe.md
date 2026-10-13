# 服务端 VAD 三臂同源回放（A 不门控 / B 出货 STS 门控 / C 只观察不裁剪）

本文件由 `experiments/voice-realtime-vad-three-arm/probe.mts` 生成。三臂跑在**同一段真实上行音频**的**同一个 excerpt**（同起点、同长度）上，把「本地检测质量」与「模型输入干预」分开：A 是第三次实测的生产形态（不门控），B 用**出货的** `createSilenceTailGate` 裁剪上行，C 用**同一个** gate 只观察、记录决策、一帧不裁。

**本版是对 `gap-voice-server-vad-three-arm-replay-on-third-test-corpus`（已 done）结论的复议。**那条任务的交付物与实测读数**依然有效**（三臂、来源对应表、五条取假形态都在，且已**逐字冻结**在 `docs/operations/voice-realtime-vad-three-arm-probe-run1.md`）；被推翻的只有**归因**：它把「B 与 A 逐字节相同」写成「本语料没有给出可裁之处」，本轮在**同一条录音的另一段**（明确含连续无语音）上用**同一份未改的**门控跑出了裁剪 ⇒ 那句话是错的。正确成因见 **AC5**（钳位 `SHIPPED_STS_MAX_THRESHOLD_DB = -60 dBFS` 废掉了自适应），更正段见文末「更正旧结论」。

运行时刻 2026-10-13T09:49:17.399Z；运行目录 `/tmp/voice-realtime-vad-three-arm-1791884809369`（每臂一份 journal 在 `journal/`，gate 逐帧决策另存 `<臂>-<conn>.gate.jsonl`）。执行面 **dry-run**：会话声明的 `session_send` 由脚本内的记录式执行器承接，模型每次调用只被记录并回一个合成 output，**不落任何真实会话**。直连上游 realtime 端点，不经 :3001。

**运行次数：1**（下表全部读数来自同一次完整运行的那一个快照）。花费 ¥0.0070（每连接上限 ¥0.05、总上限 ¥0.5；触顶连接 0 条）。:3001 pid 366403 → 366403（**相同**，未重启）。外联仅 wss://dashscope.aliyuncs.com/api-ws/v1/realtime；生产环境变量改动 0 条。

## 报告小节 ↔ AC 对照

| AC | 本节 | 判据读的是什么 |
| --- | --- | --- |
| AC1 | [AC1 红先行](#ac1-红先行出货门控在选定-excerpt-上真的裁了帧) | `B.filteredFrames > 0` + 离线回放同值 + 取假形态窗口为 0 |
| AC2 | [AC2 只观察不裁剪](#ac2-c-臂证明只观察不裁剪) | C 的上传帧/字节/毫秒逐项 == A，且决策数 == 上传帧数 |
| AC3 | [AC3 无语音损失](#ac3-无语音损失) | 各臂未写出音频落在源 speech 区间内的毫秒数 = 0 |
| AC4 | [AC4 门控实测读数](#ac4-出货门控在本次-excerpt-上的实测读数) | `createSilenceTailGate` 在本 excerpt 的 stage/suppressedTransitions/withheldMs + 噪声底 + 阈值敏感性 |
| AC5 | [AC5 钳位是根因](#ac5-根因钳位废掉自适应) | 钳位上限使自适应失效（逐电平实测）+ 本录音底噪实测值 |
| AC6 | [AC6 运行设置与成本](#ac6-运行设置与成本) | 单次运行、excerpt ≤ 上限、实际花费与时长 |
| AC7 | [AC7 生产面未动](#ac7-生产面未动) | `VOICE_REALTIME_SILENCE_TAIL` 仍未设、:3001 pid 相同、外联仅上游 |
| AC8 | [AC8 职责边界](#ac8-职责边界只过滤无语音-pcm) | 三臂上行帧型无 `response.create`/commit、`turn_detection` 逐字节一致 |
| S1 | [来源对应表](#来源对应表支撑材料) | 转发真值取自 journal `session_send`，非 CLI transcript |
| S2 | [keepalive 与节流目标的冲突](#s2-keepalive-与节流目标的冲突) | 报告显式写出该冲突（标记串判据） |
| S3 | [既有旁路标注](#s3-既有旁路-localspeechgate--watchdog) | 报告显式标注既有旁路（标记串判据）+ 探针未导入它们 |
| S4 | [读数不足时的写法](#s4-读数不足时的写法) | 读数不齐的臂不得进入结论 |

AC4 / AC5 / S2 / S3 的判据落在**渲染出来的报告文本**上（标记串），不是落在生成器的布尔开关上：「开关到开关」的空检查只能证明「我没把开关关掉」，而这里要证明的是**写出去的这段文字里有没有那一句**。

## AC8 职责边界：只过滤无语音 PCM

人 2026-10-13 的唯一职责裁定：**「服务端 VAD」只对上行 PCM 做 speech / non-speech 分类、过滤无语音帧，减少传到 Realtime upstream 的音频数据**；它是纯传输侧的节流器，与「什么时候算说完」正交。

本探针把这条边界落成**机械判据**（断言的输入是各臂 journal 里**实际发出**的帧型，不是自述）：

| 硬禁令 | 本实验的证据 | 实测 |
| --- | --- | --- |
| 不引入 turn detection / endpointing / 语义提交 / `response.create` | 各臂上行帧型全集（见下）不含 `response.create` | 未出现 |
| — 帧型 `conversation.item.create` | 各臂发出次数 | A 2 / B 2 / C 2 |
| — 帧型 `input_audio_buffer.append` | 各臂发出次数 | A 2100 / B 1884 / C 2100 |
| — 帧型 `session.update` | 各臂发出次数 | A 1 / B 1 / C 1 |
| 不改变上游 `turn_detection` | 从各臂**实际发出的** `session.update` 里读回 `session.turn_detection`（即真正上网的那个值），与出货解析器逐字节比 | 三臂均与出货一致：`{"type":"server_vad","threshold":0.5,"silence_duration_ms":400}` |
| 不把边界事件用于模型触发 / commit | 由服务端 VAD 边界事件驱动的 `response.create` | A 0 次 / B 0 次 / C 0 次 |

**取假形态 F3**：`--falsify-b-boundary-response-create` 让 B 臂在源 timeline 的**第一个 `speech_stopped` 边界**上发一次 `response.create`——这正是禁令点名的接线形态。跑出来 **AC8** 即红。

另外：探针**自己没有** commit 上行音频（没有 `input_audio_buffer.commit`）；会话的 `turn_detection` 是 `server_vad`，上游按它自己的时机提交——那是**上游既有行为**，不是本功能触发的，探针既不干预也不改动它。

**这条判据只覆盖「本探针自己发出的帧」**：它核对各臂上行帧型里没有 `response.create` / commit、核对各臂**实际发出**的 `session.update` 里的 `turn_detection` 与出货解析器逐字节一致、核对外加 `response.create` 次数为 0。它**不**（也无法）核对 :3001 上的生产代码路径——那是「本实验没有引入该接线」这一命题的正确范围。

## AC1 红先行：出货门控在**选定 excerpt** 上真的裁了帧

选定 excerpt：源音频内起点 **320000 ms**、长度 **42000 ms**（2100 帧 × 20 ms）。本段是**离线逐帧回放**出货门控（`createSilenceTailGate({})`，**未改**）得到的读数；B 臂真实跑出来的 `filteredFrames` = **244**，与离线回放**逐值相同**。

| 读数 | 选定 excerpt（真形态） | 取假形态靶子（首片 90 s） |
| --- | --- | --- |
| 窗口 | 320000 ms / 42000 ms | 0 ms / 90000 ms |
| **裁掉的帧数**（本帧有音频没被写出去） | **244** | **0** |
| 未写出的音频 | 4880 ms | 0 ms |
| suppressed / resumed 转移 | 1 / 1 | 0 / 0 |
| 首次挂起 / 恢复（源音频时刻） | 341140 ms / 346040 ms | — / — |
| stage 序列 | `streaming → tail → suppressed → streaming` | `streaming` |

**AC1 = 红先行**：要求 `B.filteredFrames > 0`。取假形态把起点移回**不含连续无语音**的窗口（`--replay-only --start-ms 0 --excerpt-ms 90000`）⇒ 上表右列 0 帧 ⇒ AC1 红。

**净上传差 = 裁掉的帧数 − 恢复时补发的帧数**：本窗口裁掉 4880 ms（244 帧），恢复时补发前导 29 帧（580 ms），故净少传约 4300 ms。C 臂的 `filteredFrames` 恒为 0（一帧不裁），这就是它与 B 的结构性差别。

## AC2 C 臂证明「只观察不裁剪」

C 的上传帧数 **2100**、字节 **1344000**、毫秒 **42000** 与 A 的 **2100** / **1344000** / **42000** **逐项相等**（断言已核对三项）。同时 C 的 gate 记录了 **2100** 条决策（== C 的上传帧数），其中 gate 建议裁掉的音频累计 **4880 ms**，而 C 一帧也没裁（`ignoredSuppressions=244` 帧）——这正是「只观察、不裁剪」的产品语义：本窗口里出货门控**确实建议裁** 4880 ms（与 B 臂同值），而 C 把每一条建议都记下来、又原样放行。

**取假形态（F2）**：`--falsify-c-suppresses` 让 C 也裁剪 —— C 的上传随即小于 A，AC2 断言变红、脚本非零码退出。这条命令**独立**跑一次（自写 `--work` 目录），其快照与退出码由本轮任务的实施记录留证。

**F2 为什么额外吞掉前导 500 ms**，而不是只把 C 的策略换成照抄 gate 的决定：照抄决定仍然逐项等于 A（那是「只观察」的定义），AC2 依旧绿，这条假形态就什么也没证伪。所以 F2 做成一次**声明式违背**：C 在开头额外吞掉前导窗口，`C.uploaded* < A.uploaded*` 且 `decisionsRecorded != uploadedFrames` 必然成立，AC2 必然变红。它证明的是**断言会红**（AC2 非空洞）。

## AC3 无语音损失

分母是**源 timeline 的 speech 区间在窗口内的部分**（与臂无关），分子是各臂**未写出的音频落在这些区间内**的毫秒数。本窗口源语音共 8418 ms。

| 臂 | 未写出的源语音（ms / 帧） | 占窗口内源语音 |
| --- | --- | --- |
| A | 0 ms / 0 帧 | 0.00% |
| B | 0 ms / 0 帧 | 0.00% |
| C | 0 ms / 0 帧 | 0.00% |
| **离线回放（B 的判定）** | **0 ms / 0 帧** | 0.00% |

**读数**：本窗口出货门控裁掉的 4880 ms **全部落在非语音侧**——落在源 speech 区间内的是 **0 ms**。恢复时补发的前导帧（`SHIPPED_STS_PREROLL_MS` 默认 500 ms）正是为此而存在：挂起期间被压住的帧先入 ring，一旦 `voicedRun` 连续 3 帧达标就整段补发（本窗口补发 29 帧），所以「裁剪」与「丢语音」不是同一件事。

## AC4 出货门控在本次 excerpt 上的实测读数

**出货门控在本次 excerpt 上的实测读数（离线回放 + 真实 B 臂）**

对象：出货的 `createSilenceTailGate({})`（**未改**，默认 T=1000 ms 尾巴 / P=500 ms 前滚 / keepalive 30000 ms），喂入本 excerpt 的 2100 帧。下表左列是**离线逐帧回放**的读数，右列是**真实 B 臂**（同一次运行的连接）的读数。

| 读数 | 离线回放 | 真实 B 臂 |
| --- | --- | --- |
| 是否进入 `suppressed` | **是**（streaming → tail → suppressed → streaming） | **是**（转移 1 次） |
| `suppressedTransitions` | 1 | 1 |
| `withheldMs`（本臂未写出的音频） | 4880 | 4880 |
| `filteredFrames`（本帧有音频没被写出去的帧数） | 244 | 244 |
| 首次挂起 / 恢复 | 341140 / 346040 ms | — / — ms |
| suppressed 期间累计被压 | 4900 ms | 4900 ms |
| 恢复时补发前导帧 | 29 帧 | 29 帧 |
| 连接的**最长不发送间隔** | — （离线无连接） | 4900 ms |
| 连接存活到 excerpt 结束 | — | 是 |

**这段 excerpt 的低能量部分是什么**（决定了上表能不能读成「真实房间噪声被裁掉」）：

| 量 | 值 |
| --- | --- |
| 窗口帧数 | 2100 |
| 其中**数字静音**帧（PCM 全零） | 307（14.6%） |
| 窗口内**最长连续数字静音段** | 235 帧 = 4700 ms，起点 = 窗口内 19840 ms（源音频 339840 ms） |
| 非数字静音帧 dBFS 分位（p10/p25/p50/p75/p90） | -59.56 dBFS / -57.438 dBFS / -54.442 dBFS / -46.3 dBFS / -26.014 dBFS |
| 全体帧 dBFS 分位（含数字静音） | -90.309 dBFS / -59.182 dBFS / -55.496 dBFS / -48.519 dBFS / -27.662 dBFS |

⛔ **必须把这两件事分开读**：本窗口的挂起是由**一段数字静音**（PCM 全零，`readFrame` 判 `silent`）推进 `quietMs` 打开的 —— 它在源音频 341140 ms 处转 `suppressed`，而全零段起点是 339840 ms、长 4700 ms。也就是说：**这一段证明的是「门控确实会裁、且裁对了（无语音损失）」**，它**不是**「真实房间噪声被裁掉」的样本。为什么真实噪声段裁不动，见下一节的钳位分析。

**离线噪声底与阈值敏感性（同一段音频在相对判据下能裁多少）**

**若**把判据换成「非数字静音帧的 p10 + Δ」（基准 -59.56 dBFS），同一段音频能裁多少 —— 这是**错失量**的读数，不是「建议这么改」：

| Δ (dB) | 阈值 (dBFS) | 可裁帧 | 占比 | 最长连续（帧 / ms，窗口内起点） |
| --- | --- | --- | --- | --- |
| +0 | -59.56 | 487 / 2100 | **23.2%** | 235 帧 / 4700 ms（@19840 ms） |
| +2 | -57.56 | 745 / 2100 | **35.5%** | 235 帧 / 4700 ms（@19840 ms） |
| +4 | -55.56 | 1039 / 2100 | **49.5%** | 235 帧 / 4700 ms（@19840 ms） |
| +5 | -54.56 | 1178 / 2100 | **56.1%** | 235 帧 / 4700 ms（@19840 ms） |
| +6 | -53.56 | 1286 / 2100 | **61.2%** | 235 帧 / 4700 ms（@19840 ms） |
| +8 | -51.56 | 1443 / 2100 | **68.7%** | 242 帧 / 4840 ms（@19700 ms） |
| +10 | -49.56 | 1537 / 2100 | **73.2%** | 316 帧 / 6320 ms（@19680 ms） |
| +12 | -47.56 | 1611 / 2100 | **76.7%** | 461 帧 / 9220 ms（@31260 ms） |

读法：出货门控在本窗口上实际裁掉的是那段数字静音；上表问的是**同一段音频在相对判据下能裁多少**。「可裁」的口径与门控一致：数字静音帧（永不可能被判人声）或 RMS 低于阈值。基准取**非数字静音帧**的 p10 —— 全零帧会把这个分位压到约 −90 dBFS，用它当噪声底会把整张表压平（读数就没了信息量）。⛔ 这张表**不构成**「应该改成相对判据」的结论：改判据是在拿 STS 产品任务的「误判静音率 = 0」硬要求做交易，属于改变检测器语义，**由人裁定**（见文末「未决」）。

## AC5 根因：钳位废掉自适应

**根因：`SILENCE_TAIL_MAX_THRESHOLD_DB = -60 dBFS` 这个钳位废掉了自适应**

`server/modules/voice-realtime/voice-realtime-silence-tail.ts:361-372`（`voiceThresholdRms`）：

```js
const floorDb = floor === null ? SILENCE_TAIL_HARD_FLOOR_DB : rmsToDb(floor);   // −70
const db = Math.min(
  SHIPPED_STS_MAX_THRESHOLD_DB,                                                // 常量 −60 dBFS
  Math.max(SILENCE_TAIL_HARD_FLOOR_DB, floorDb + SHIPPED_STS_VOICE_MARGIN_DB),  // max(−70, 底噪+8)
);
```

阈值**确实自适应**（底噪 + 8 dB），但被 `SHIPPED_STS_MAX_THRESHOLD_DB = -60 dBFS` **硬性封顶**。只要噪声底高于约 **-68 dBFS**（即 `floor + 8 > -60`），钳位就生效 ⇒ 判定边界**恒等于 -60 dBFS**，自适应完全失效。更糟的是这是个**不动点**：进入底噪窗的帧恰好是「被判为非人声」的那些（`observe` 里 `!reading.silent && !voiced` 才入窗），所以被钳住之后窗里的底噪估计永远推不高，钳位再也回不来。

**逐电平实测**（对门控自己的判定做的观测，不是抄常量）—— 构造一段已知电平的底噪喂进 `createSilenceTailGate({})`，量它实际把判定边界放在哪：

| 喂入的底噪电平 (dBFS) | 门控实际判定边界 (dBFS) | 钳位是否生效 |
| --- | --- | --- |
| -80 | -69 | 否（既非钳位也非硬地板 —— 与两份常量副本都不符，需人工核对） |
| -75 | -66 | 否（随底噪移动：= 底噪 + 8） |
| -73 | -65 | 否（随底噪移动：= 底噪 + 8） |
| -71 | -63 | 否（随底噪移动：= 底噪 + 8） |
| -70 | -62 | 否（随底噪移动：= 底噪 + 8） |
| -69 | -60 | **是**（边界被钳在 -60，高于 底噪+8 = -61） |
| -68 | -60 | **是**（边界被钳在 -60，高于 底噪+8 = -60） |
| -67 | -60 | **是**（边界被钳在 -60，高于 底噪+8 = -59） |
| -66 | -60 | **是**（边界被钳在 -60，高于 底噪+8 = -58） |
| -65 | -60 | **是**（边界被钳在 -60，高于 底噪+8 = -57） |
| -63 | -60 | **是**（边界被钳在 -60，高于 底噪+8 = -55） |
| -61 | -61 | 否（既非钳位也非硬地板 —— 与两份常量副本都不符，需人工核对） |
| -60 | -61 | 否（既非钳位也非硬地板 —— 与两份常量副本都不符，需人工核对） |
| -58 | -61 | 否（既非钳位也非硬地板 —— 与两份常量副本都不符，需人工核对） |
| -55 | -61 | 否（既非钳位也非硬地板 —— 与两份常量副本都不符，需人工核对） |

**本录音的底噪实测值**（AC5 要求给出）：全文件逐帧画像（该文件共 18633 帧 = 372.66 s），**排除数字静音帧**后的 dBFS 分位 ——

| 分位 | 全文件（仅非数字静音帧） | 本 excerpt（仅非数字静音帧） |
| --- | --- | --- |
| 帧数 | 18319 / 18633（数字静音 314） | 1793 / 2100（数字静音 307） |
| p5 | -62.452 dBFS | -59.56 dBFS |
| p10 | -61.348 dBFS | -57.438 dBFS |
| p25 | -59.025 dBFS | -54.442 dBFS |
| p50 | -55.591 dBFS | -46.3 dBFS |
| p75 | -49.407 dBFS | -26.014 dBFS |
| p90 | -31.804 dBFS | -26.014 dBFS |
| max | -10.283 dBFS | -26.014 dBFS |

**把根因说完**：这段录音的底噪（非数字静音帧）中位数约 -55.591 dBFS、p10 约 -61.348 dBFS，都**高于** -68 dBFS ⇒ 钳位在这一整条录音上长期生效 ⇒ 判定边界恒为 -60 dBFS ⇒ 真实房间噪声（电平在 −60 与 −50 dBFS 之间）**永远进不了判定区**，只有**数字静音**（全零帧）才可能把 `quietMs` 推过 320 ms 的挂起门槛。这正是前一次运行「B 与 A 逐字节相同」的成因：首片 90 s 里**一段数字静音都没有**（离线回放 0 帧），而不是「本语料没有给出可裁之处」。

**这段录音里真实（非数字静音）噪声段能裁多少**：离线读数给出的最长连续「低于出货边界」的非数字静音段只有 5 帧（100 ms，窗口内 @37740 ms）—— 距挂起门槛 320 ms 还差 220 ms，所以真实噪声段**一次都挂不起来**。这说明零过滤是**判据的性质**，与「这段录音有没有静音」无关。

**取假形态（F6，AC5）**：`--falsify-clamp-not-root-cause` 把根因改写成「本语料没有给出可裁之处」（即旧结论那句）并省掉本节标记串 ⇒ AC5 断言变红、脚本非零码退出。这条命令**独立**跑一次，其快照与退出码由本轮任务的实施记录留证。

## AC6 运行设置与成本

- excerpt：源音频内起点 320000 ms、长度 42000 ms（上限 90000 ms）——**三臂完全相同**。
- 帧：20 ms / 帧（640 字节 PCM16），按**实时墙钟**逐帧推进（近似浏览器上行）。
- `turn_detection`（出货 `resolveTurnDetection({})`，**三臂逐字节相同**）：`{"type":"server_vad","threshold":0.5,"silence_duration_ms":400}`
- 模型 qwen3.8-omni-flash-realtime / voice Tina；工具 `session_send` 由脚本内记录式执行器承接（dry-run）。
- 上限：`--cap` ¥0.05/连接、`--total-cap` ¥0.5、`--excerpt-ms` 上限 90000；**单次运行**（runs=1）。
- **实际花费**：¥0.0070（逐臂：A ¥0.0022、B ¥0.0022、C ¥0.0022）。
- **实际时长**：A 51.774 s、B 47.424 s、C 47.789 s（连接建立到收尾）。
- 复现命令：`npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-vad-three-arm/probe.mts --work /tmp/vad3 --start-ms 320000 --excerpt-ms 42000`（离线复算：追加 `--replay-only`，不连上游、不花钱）

## AC7 生产面未动

| 判据 | 读数 |
| --- | --- |
| `VOICE_REALTIME_SILENCE_TAIL` 仍为关（未设） | **是**（未设） |
| :3001 pid 运行前后相同（未重启） | 366403 → 366403（**相同**） |
| 生产环境变量改动 | 0 条（gate 在探针内 `createSilenceTailGate({})` 构造，不读也不写生产配置） |
| 外联 | 仅 wss://dashscope.aliyuncs.com/api-ws/v1/realtime |

探针**不写任何生产环境变量**、**不重启服务**、**不落任何真实会话**（`session_send` 由脚本内记录式执行器承接）。唯一的对外连接是上游 realtime 端点本身，且不经 :3001。

## 三臂逐项指标（模型侧与连接侧）

| 读数 | A（不门控） | B（STS 门控） | C（只观察） |
| --- | --- | --- | --- |
| 1 上传秒数 / 帧数 | 42 s / 2100 帧 | 37.68 s / 1884 帧 | 42 s / 2100 帧 |
| 1b 上传字节 / 占 excerpt | 1344000 B / 100.0% | 1205760 B / 89.7% | 1344000 B / 100.0% |
| 2 静音占比（源语料侧） | 80.0%（源语音 8418 ms） | 80.0%（源语音 8418 ms） | 80.0%（源语音 8418 ms） |
| 2b 静音占比（上游侧，本臂） | 57.0%（上游判出 2 段 / 18045 ms） | 79.7%（上游判出 2 段 / 8542 ms） | 56.6%（上游判出 2 段 / 18247 ms） |
| 3 首 token 延时 | 278 ms | 272 ms | 279 ms |
| 4 首次 function_call 延时 | 440 ms | 460 ms | 464 ms |
| 5 转发文本保真 | 1/2（50.0%）（转出 2 条、转发 2 条） | 1/2（50.0%）（转出 2 条、转发 2 条） | 1/2（50.0%）（转出 2 条、转发 2 条） |
| 6 丢段数 / 错误中断数 | 0 / 1 | 0 / 0 | 0 / 1 |
| **误删语音**（本臂未写出的音频落在源 timeline speech 区间内的部分） | 0 ms / 0 帧（窗口内源语音共 8418 ms；占 0.00%） | 0 ms / 0 帧（窗口内源语音共 8418 ms；占 0.00%） | 0 ms / 0 帧（窗口内源语音共 8418 ms；占 0.00%） |
| **前滚保留**（resumed 时补发的前导帧：累计 / 单次最长） | 不适用（本臂无门控） | 补发 29 帧 / 单次最长 29 帧；suppressed 时累计被压 4900 ms） | 补发 29 帧 / 单次最长 29 帧；suppressed 时累计被压 4900 ms） |
| **连接存活**（excerpt 播完时仍连着 = 非上游断线、非触顶） | 是（最长不发送间隔 22 ms） | 是（最长不发送间隔 4900 ms） | 是（最长不发送间隔 61 ms） |
| 上行帧型（本臂实际发出） | `{"conversation.item.create":2,"input_audio_buffer.append":2100,"session.update":1}` | `{"conversation.item.create":2,"input_audio_buffer.append":1884,"session.update":1}` | `{"conversation.item.create":2,"input_audio_buffer.append":2100,"session.update":1}` |
| 实际花费（CNY，出货估算器） | ¥0.0022 | ¥0.0022 | ¥0.0022 |
| 实际时长（连接建立到收尾） | 51.774 s | 47.424 s | 47.789 s |
| 断线读数（上游主动断线？close code/reason） | 否 / —  | 否 / —  | 否 / —  |

本批次收到的上游 / 连接错误（原样，不改写；「错误中断数」一列 = 这些错误条数 + 上游主动断线计 1 + 花费触顶计 1）：

- **A**：`upstream: {"event_id":"event_KWk1BBp1QybqRpi5VRGbb","type":"error","error":{"type":"invalid_request_error","message":"Unknown function call id: call_60e11af7f6dd4305a0a7e7f3","param":"call_id"}}`
- **B**：无
- **C**：`upstream: {"event_id":"event_MZk2umksWp73OgcPrrM8w","type":"error","error":{"type":"invalid_request_error","message":"Unknown function call id: call_e9d05b93ea224ed395bb8cbb","param":"call_id"}}`

- 延时的基准是**本臂自己收到的首个 `input_audio_buffer.speech_stopped`**（上游开始收尾的那一刻），不是本地帧序号；三臂同一段音频，故基准可比。保真的分母是 excerpt 窗口内**有转写**的真值句数（即上表第 5 行分数里的分母），分子是本臂转发文本里**字面覆盖**了它的条数；窗口内 committed 行数为 2，其中 0 行没有转写、不计入分母。

逐段延时（`段起点ms/首delta/首call`，`—` 代表该段之后本臂没有对应的 delta / 调用）：

| 臂 | 逐段读数 |
| --- | --- |
| A | 20755/278/440；35496/281/444 |
| B | 9298/272/460；20499/371/510 |
| C | 19196/279/464；40104/295/457 |

## 来源对应表（支撑材料）

源会话 `af5559c0-d347-41f3-a6f0-f02a597af1e9`；音频 `/data/home/yale/.cloudcli/voice-realtime-capture/af5559c0-d347-41f3-a6f0-f02a597af1e9.wav`（11925120 字节 PCM16 / 16000 Hz / 1 ch / 16 bit / 共 372.66 s；data chunk 偏移 44 字节——**读出来的**，不是假设 44）。与同目录 timeline 的 `final` 行逐位吻合：`dataBytes` 11925120、`durationMs` 372660 ms（开跑前核对，不等即抛）。

**转发真值来源：journal.session_send** —— 模型自己的 `session_send` function call。**CLI transcript 未被用作转发真值**：本表的每一行都由 capture `committed` + journal `transcription.completed` + journal `function_call session_send` 三股流建立，没有任何一行取自 CLI/UI 侧视图；journal 里的 `to-browser caption` 流（18 条）只被**计数**用于对照，**不参与真值**。

三股流的条数：`committed` 18 ↔ `transcription.completed` 18 ↔ `function_call session_send` 13；journal 里真正落库的 `session_send` 条目 12 条（模型一次调用可合并同段的多句，故条目数可少于调用数）。committed ↔ transcription 按**到达顺序**一一对应，条数不等即抛。

| # | offsetMs | itemId | transcription | session_send（模型转发） | 在 excerpt 内 |
| --- | --- | --- | --- | --- | --- |
| 0 | 4930 | `item_Ss4ZScUpcvQlRJBSCLyIW` | 好，现在我们再次测一下Live Voice Mode。 | 好，现在我们再次测一下 live voice mode。 | — |
| 1 | 9178 | `item_C9iWii11txqPiJz2Gp3b1` | 哎，上面这句话是不是很快？ | **（无）** | — |
| 2 | 19372 | `item_OnNOB6Z74dQos398R6oyG` | 但好像推理开始的慢一些。 | 但好像推理开始的慢一些。 | — |
| 3 | 33744 | `item_SiU9vz99CyIiFRGXsGZTi` | 当连续有多句的时候。 | 当连续有多句的时候，顺序还是错的。 | — |
| 4 | 35101 | `item_M8JUtKbFGYOXvAIDjcAFA` | 顺序还是错的。 | 当连续有多句的时候，顺序还是错的。 | — |
| 5 | 53168 | `item_M73pcXY75Dbr48Blg6Q2Z` | 到现在为止，我第二句话还是没有被处理。 | 到现在为止，我第二句话还是没有被处理。 | — |
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
| 16 | 327360 | `item_SJB2aqJXaw3VrDB6M6Afq` | 那我希望啊，用 Fake Provider 等本地机制可以模拟所有这些问题。 | 那我希望啊，用 fake provider 等本地机制可以模拟所有这些问题。 | ✓ |
| 17 | 338594 | `item_WNyBlZzaGli1ZL4WBjESZ` | 现在屏幕上已经有三行未听的Q了。 | **（无）** | ✓ |

**「听了没转发」**（全表 18 行）：**有转写、但没有任何一条转发文本字面覆盖它**的共 7 条：#1「哎，上面这句话是不是很快？」、#7「实际上，在我的屏幕上，你的第一组后面那句话，哎，上面这句是不是很快？」、#10「现在，在我的屏幕上，底部又多出了一个“waiting in the queue”的。」、#11「呃。」、#13「我刚说这玩意儿消失了，但是又又多出了两个泡泡，以两个无法消失的气泡。」、#14「到现在为止，看呢，每句话都能够实际被识别出来，并推到 Kafka 的处理。」、#17「现在屏幕上已经有三行未听的Q了。」。 excerpt 窗口内 2 行中该缺口为 1 条（#17）。

两点必须说清楚，以免把读数读成结论：(1) 本表的「覆盖」是**字面**包含关系（归一化标点/空白/大小写后）。模型**改写**过的句子（例如把「是不是很快」写成「识别的很快」、把「Kafka」写成「Claude Code」）字面上不覆盖原句，于是被计入缺口——这是**保真**读数，不是丢句。(2) 任务 Proposal 里的「5 句听了没转发」是 `18 committed − 13 function_call` 这条**算术**；其中多数是**被合并**进邻近一次转发的（合并句的文本仍随合并体送达），按字面覆盖读出的缺口与这个算术不是同一件事，本报告按字面覆盖读数写，并把两者都点出来。

**取假形态（F1）**：`--falsify-forward-truth=cli-transcript` 把转发真值换成 `to-browser caption` 流（CLI/UI 侧视图），即「拿 CLI transcript 当转发真值」。这条命令**跑得起来**，但它跑出的快照里 `forwardTruthSource=cli-transcript`、`cliTranscriptUsedAsForwardTruth=true`，支撑断言 **S1** 随即变红、脚本以非零码退出。⛔ 本报告由**生成它的那一次运行**的一个快照渲染而成，因此这里只写**机制与它打红哪条断言**，不写实测结论；假形态各自的实测读数来自**各自独立的**一次运行（各写自己的 `--work` 目录，其 `snapshot.json` 即该次运行的快照），连同退出码与被点名的 FAIL 行由本轮任务的实施记录留证。

## S2 keepalive 与节流目标的冲突

- B 臂（唯一会裁剪的臂）**最长不向上游发送数据的间隔**：4900 ms；被门控压住的累计时长 4900 ms（真实臂 / 离线回放），其间发出的 keepalive 0 帧。
- **是否出现「长时间不发送导致 upstream 断线」**：否（本臂 close：无（探针自收））；连接存活到 excerpt 结束=true。
- **本探针所用的 keepalive：出货门控自带的那个**（`SILENCE_TAIL_KEEPALIVE_MS` 默认 30000 ms、每帧 100 ms 数字静音），探针没有另加任何 keepalive，也没有为了「不断线」多发过一帧。门控的返回面只有「要写哪些帧」，所以这个 keepalive 就是**连续静音 PCM**。

⚠️ **与节流目标的冲突（必须写明，不得为保住节流数字而隐去）**：若为了让连接活下去而必须周期性发送**连续静音 PCM**，那么这部分字节**正是**本功能想省掉的那一类——静音越多、压得越久，keepalive 发得越多，节流收益被自己吃掉一部分；极端情形（压住的时长接近 keepalive 间隔的整数倍）下，收益会被削到接近 0。这不是理论顾虑，而是出货实现里已经存在的路径：`suppressed` 且 `keepaliveMs > 0` 时，门控每个 keepalive 周期就 push 一帧 `digitalSilence(100 ms)`。

**而且这条 keepalive 未必有效**：既有读数是上游空闲超时**按 response 计**（约 300 s 无 **response** 即 `1007 response_idle_timeout`），而连续上传底噪 297.6 s 同样不重置它（见备忘 `[[upstream-realtime-idle-timeout-is-response-based]]`）。也就是说「发静音保活」很可能既花了字节、又保不住连接 —— 本次 excerpt 只有 42 s，B 臂被压住的累计时长 4900 ms（suppressed 转移 1 次 / 离线回放），远低于 30000 ms 的 keepalive 间隔，故本窗口内 keepalive 一帧未发（keepalive 0 帧）。**结论：本次读数无法判断 keepalive 是否必要或有效；要判断它，需要一段把 B 臂压住 ≥ 300 s 的语料。**

**取假形态 F4**：`--falsify-hide-keepalive-conflict` 隐去上面这条冲突 ⇒ S2 红。（量一下这条假形态有多真：把冲突段删掉，报告读起来会变成「B 一次未裁、keepalive 0 帧、连接健康」——一个干净漂亮的节流故事，而代价恰好被那一段藏住了。）

## S3 既有旁路：`localSpeechGate` / watchdog

**显式标注（本节即该标注）**：`localSpeechGate`（`server/modules/voice-realtime/voice-realtime-local-speech.ts`，在 proxy 侧构造）→ `reportLocalSpeechBoundary` → 看门狗这条链是**既有旁路**，**不纳入本任务的「服务端 VAD」功能范围**。本任务里的「服务端 VAD」只指 `silenceTail` / `createSilenceTailGate` 那一个（proxy 里 `decision.frames` 决定转发哪些帧的那个）。

两条链各自 `observe()` 同一帧、**互不喂对方**：STS 决策不进入 `reportLocalSpeechBoundary`，也不进入任何 commit / `response.create` 路径。唯一的相邻接触是 STS 分支内的 `bridge.noteLocalActivity?.()`（注释：a suppressed stretch is not an idle one）——那是**为切断误读而做的解耦**，不是泄漏。因此无需解耦，只需标注。

**本实验如何保证「其边界事件未被计入本功能行为」**（两半，都可机械核对）：(1) 探针从 voice-realtime barrel 只导入 `SILENCE_TAIL_ENV`、`createSilenceTailGate`、`estimateRealtimeCostCny`、`resolveTurnDetection` —— **不含** `createLocalSpeechGate` / `reportLocalSpeechBoundary`，探针根本没有构造旁路链，也不可能消费它的边界事件；这条由 S3 断言核对（符号表由探针源码手工维护，导入一变就红）。(2) AC3 的「误删语音」以**源 timeline 的 speech 区间**为分母，不以旁路或上游的边界事件为分母。

## S4 读数不足时的写法

规则是**一条**：模型侧读数不齐的臂不得进入结论 —— 每个臂在成文前先自检六项读数，缺任何一项就记下缺项，该臂的 `sufficient` 变 false、`insufficientReason` 写明缺了什么，结论行**改为**「不足以判断」并带上这些缺项；缺 A 臂（生产形态基准）或缺 A/C 之一时同样直接判「不足以判断」，不允许用缺失当证据（`deriveConclusion` 的三个早退分支）。

本次运行三臂读数**均齐备**，因此结论按实测写，不触发「不足以判断」。各臂缺项：A（无）、B（无）、C（无）。

自检的六项与逐项指标表同源：上传帧数 > 0、上游判出至少一个语音段、至少一条转写、有首 token 延时、有首次 `function_call` 延时、转发保真可算（真值句非空）。

## 取假形态（机制，非本次运行的读数）

六条假形态都是**真的跑得起来**的命令，各自只把一条断言打红。`--excerpt-ms` 只影响时长与花费，不影响这六条断言的方向；下表只说明**红在哪个字段上**。各命令**独立**跑一次，其快照与退出码由本轮任务的实施记录留证（**不在**本报告的运行目录里）。

| # | 假形态命令 | 变红的断言 | 机制 |
| --- | --- | --- | --- |
| F1 | `--falsify-forward-truth=cli-transcript` | S1 | 转发真值被换成 `to-browser caption`（CLI/UI 侧视图），`forwardTruthSource` 不再是 `journal.session_send`、`cliTranscriptUsedAsForwardTruth` 变 true |
| F2 | `--falsify-c-suppresses` | AC2 | C 也裁剪：走裁剪分支并额外吞掉前导 500 ms —— `C.uploadedFrames/Bytes/Ms` 不再等于 A 的三项，且 `decisionsRecorded != uploadedFrames` |
| F3 | `--falsify-b-boundary-response-create` | AC8 | B 臂在源 timeline 第一个 `speech_stopped` 边界上发一次 `response.create` —— 正是禁令点名的「把服务端 VAD 边界事件用于模型触发」 |
| F4 | `--falsify-hide-keepalive-conflict` | S2 | 报告里隐去「需要连续静音存活 ⇒ 与节流目标冲突」那一段，只留干净的节流数字 |
| F5 | `--falsify-unannotated-bypass` | S3 | 报告里省略「`localSpeechGate` / 看门狗是**既有旁路**」的标注 —— 于是它的边界事件有没有被算进本功能行为就无人交代 |
| F6 | `--falsify-clamp-not-root-cause` | **AC5** | 把根因改写成「本语料没有给出可裁之处」（即**旧结论那一句**）并省掉钳位分析段 —— 于是「关于判据的缺陷」被写成「关于语料的观察」 |

F4 / F5 / F6 / **AC4 与 AC5** 的判据值得一提：它们**不判开关**，判的是**渲染出来的报告文本里有没有那个标记串**（`KEEPALIVE_CONFLICT_MARKER` / `BYPASS_ANNOTATION_MARKER` / `GATE_READINGS_MARKER` / `SENSITIVITY_MARKER` / `CLAMP_ROOT_CAUSE_MARKER`）—— 所以生成器走了「隐去 / 改写」分支，断言必然红；「开关到开关」的空检查在这里是不成立的。⚠️ 这也意味着**不能把前次报告全文嵌进本报告**：那份报告里含 `KEEPALIVE_CONFLICT_MARKER` 与 `BYPASS_ANNOTATION_MARKER`，嵌入会让 S2 / S3 变成**空洞的真**（并让 F4 / F5 失效）。所以前次报告只作**逐字冻结的独立文件**保留，本报告只引用其路径与那两句被推翻的话。

这六次假形态运行的实测读数（命令、退出码、被点名的 FAIL 行）由本轮任务的实施记录留证；本报告由**正常形态**的那一次运行生成，所以报告里的读数不含假形态。

## DoD 结论：服务端 VAD 是否影响上游 PCM 与 turn_detection

**判定：部分影响（干预确实改了上行，但本样本的模型侧读数未见差异）**。依据：A 上传 42s、B 上传 37.68s、C 上传 42s（C 应与 A 相等：true）；模型侧：A 转写 2/转发 2，B 转写 2/转发 2、C 转写 2/转发 2；B 臂门控未写出 4880 ms、suppressed 转移 1 次

- **对 `turn_detection`：无影响（结构性）**。三臂的 `session.update` 里 `turn_detection` 都是 `{"type":"server_vad","threshold":0.5,"silence_duration_ms":400}`，由**出货解析器** `resolveTurnDetection({})` 给出；gate 的返回面只有「要写哪些帧」，没有任何写 `turn_detection` 的路径。本探针也没有在生产面设过任何 STS 环境变量（`productionEnvTouched` 为空）。
- **对上游 PCM —— 逐个臂按实测读数说，不预设结论**。B 臂的 gate 裁掉了 4880 ms（suppressed 转移 1 次），上传 37.68s vs A 的 42s —— 这就是「干预」这一变量的直接读数：**本 excerpt 上干预确实发生了**。 C 与 A 的逐项相等（2100 帧 / 1344000 字节 / 42000 ms）是「只观察」这一语义的直接读数。
- **检测质量与输入干预已分离**：C 的**上行**与 A 逐字节相同（这是「只观察」的结构性保证，AC2 断言），所以 C−A 在**上传量**上的差异恒为 0；两者**模型侧**读数的差异因此不能归因于输入，只能是逐次运行的抖动。B−A 才是「干预」的效果。本次 B 的 `withheldMs` 可观，故 B−A 的模型侧读数差异可归因到干预而非检测。
- 上游侧静音占比是独立一列（2b）：它是「上游自己怎么判这段音频」的读数。A/C 应与源语料侧的判读大体一致；B 若因裁剪而改变上游判读，会在这一列上看出来。

## 更正旧结论（本任务的核心交付）

前次任务 `gap-voice-server-vad-three-arm-replay-on-third-test-corpus`（已 done）的**全部实测读数予以保留**，其中报告全文已**逐字冻结**为独立文件：`/data/home/yale/work/claudecodeui-worktrees/gap-voice-vad-detector-defect-red-run-on-continuous-silence-excerpt/docs/operations/voice-realtime-vad-three-arm-probe-run1.md`。本节的更正**只针对归因与结论**，不改动它的任何数字。

### 被推翻的那句话

> 本语料没有给出可裁之处

（旧报告据此把「B 与 A 逐字节相同」归因到语料，并在限制一节写「本语料的边界（重要）：…所以 B 臂的门控在这段音频上**没有可裁之处**。凡涉及「裁剪会不会改变模型输入」的问题，本语料**给不出**答案」。）

### 为什么它是错的（可复算）

| # | 读数 | 值 | 说明 |
| --- | --- | --- | --- |
| 1 | 旧窗口（首片 90 s）上的离线回放 | 0 帧 | 旧读数成立：那段**确实**一帧未裁 |
| 2 | **同一条录音** 起点 320000 ms / 长度 42000 ms 上的同一份**未改**门控 | **244 帧 / 4880 ms** | 换一段就有了可裁之处 ⇒ 「本语料」为假 |
| 3 | 全文件数字静音帧 | 314 / 18633，最长连续 235 帧（4700 ms） | 旧窗口里一段数字静音都没有；能裁的那段**恰好**是全零段 |
| 4 | 全文件底噪（非数字静音帧）p10 / p50 | -61.348 dBFS / -55.591 dBFS | 都高于 -68 dBFS ⇒ 钳位长期生效 |
| 5 | 钳位扫描：底噪 ≥ -68 dBFS 时的判定边界 | 恒为 -60 dBFS | 自适应被废掉（逐电平实测，见 AC5） |
| 6 | 真实（非数字静音）噪声里最长连续低于该边界的段 | 5 帧（100 ms） | 距 320 ms 的挂起门槛还差一截 ⇒ 真实噪声**永远挂不起来** |

**正确的归因**：零过滤不是语料的性质，而是**判据的性质** —— `SHIPPED_STS_MAX_THRESHOLD_DB` 这个上限在底噪高于约 -68 dBFS 时把判定边界钉死在 -60 dBFS，自适应项再也推不上去（且这是个不动点）；真实房间噪声因此**永远进不了判定区**，只有数字静音（全零帧）才可能推开挂起窗。这与人 yale 亲自听完整段录音的判断（「超过一半时间无语音」）一致：录音里**确实有大量无语音**，是判据收不了它们。

**这条更正的实践含义**：旧结论导出「换个语料再试」，正确结论导出「判据要改」——**行动方向相反**。但它**不**导出「现在就该抬掉钳位」：见下节。

### 未决（需人裁定，本任务不做）

拆除或抬高 `SHIPPED_STS_MAX_THRESHOLD_DB` 属于**改变检测器语义**，且 STS 产品任务把「误判静音率 = 0」列为**硬要求** —— 抬高上限正是在拿这条做交易（本报告 AC4 的敏感性表给出了这笔交易的量级：Δ=+5 就多裁 40%以上 的帧）。因此本任务**只给读数与根因**：是否改、怎么改（更稳的相对判据 / 频域特征 / 带迟滞的滑动底噪），由人裁定后另立任务。⛔ 本报告里的任何数字**都不构成**「已经改过判据」或「应该改成什么」的授权。

## 断言逐条

- [x] **AC1** — 选定 excerpt 起点 320000 ms / 长度 42000 ms（B 的 filteredFrames = 本帧有音频没被写出去的帧数）：B 臂实测 244 帧、离线回放 244 帧（两者一致=true）⇒ 出货门控**真的裁了帧**=true；挂起转移 1 次 / 恢复 1 次、未写出 4880 ms、首次挂起于源音频 341140 ms；取假形态靶子（起点 0 ms / 90000 ms 的首片 90 s）同一条回放裁掉 0 帧（应为 0：把起点移出连续无语音段，本断言即红）
- [x] **S1** — 来源对应表 18 行（offsetMs → itemId → transcription → session_send）；转发真值来源=journal.session_send（应为 journal.session_send）；CLI transcript 用作转发真值=false（应为 false）；committed 18 ↔ transcription 18 ↔ function_call(session_send) 13；journal session_send 条目 12；caption 流 18 条（**未**用作真值）；excerpt 内真值句 2 条
- [x] **AC2** — C 上传 帧 2100 / 字节 1344000 / 毫秒 42000 vs A 上传 帧 2100 / 字节 1344000 / 毫秒 42000（逐项相等）；C 记录决策 2100 条（应 == C 上传帧数）；C 本会裁掉 4880 ms（ignoredSuppressions=244 帧）但一帧未裁
- [x] **AC3** — 三臂未写出的音频落在源 timeline speech 区间内的毫秒数均为 0（分母 = 窗口内源语音 8418 ms，与 A 臂读数 8418 ms 同源）；离线门控回放同样为 0（B 离线：0 ms / 0 帧）—— 被裁掉的 4880 ms 全部落在非语音侧；恢复时补发的 pre-roll 累计 29 帧（这正是「净上传差 = 裁掉的帧数 − 补发的帧数」的来源）
- [x] **AC4** — 报告含「门控在本次 excerpt 上的实测读数」段=true、含「噪声底与阈值敏感性」段=true（判据是渲染后的报告里含标记串）；读数：stage 序列 `streaming → tail → suppressed → streaming`、suppressedTransitions 1、withheldMs 4880、filteredFrames 244；excerpt 帧 2100（数字静音 307 帧、非静音 p10 -59.56 dBFS、p50 -54.442 dBFS）；敏感性表基准 = 非静音帧 p10 = -59.56 dBFS，共 8 档 （Δ=0/2/4/5/6/8/10/12）
- [x] **AC5** — 报告把根因写成「钳位废掉自适应」=true（标记串判据，不是开关；取假形态 F6 会把它改成「本语料没有给出可裁之处」并省掉标记串）；钳位扫描实测 15/15 档有效，实测上限 -60 dBFS 与副本常量 -60 dBFS 差 ≤1.5 dB=true（镜像核对①）；有 7 档的判定边界 = 底噪 + 8 dB（±1.5）=true（镜像核对②：自适应项确实存在，只是会被钳位吃掉）；本录音全文件底噪（非数字静音帧）p5 -62.452 / p10 -61.348 / p50 -55.591 / p90 -31.804 dBFS，数字静音仅 314/18633 帧；该底噪 p10 + 8 = -53.348 dBFS **高于**上限 -60 ⇒ 钳位在这一整条录音上长期生效=true
- [x] **AC6** — excerpt 42000 ms ≤ 上限 90000 ms（且 ≤ 任务书写的 120 s）；单次运行（runs=1）；实际花费 ¥0.0067（每连接上限 ¥0.05、总上限 ¥0.5）；触顶连接 0 条；实际总时长 146987 ms
- [x] **AC7** — :3001 pid 运行前 366403 → 运行后 366403（相同=true，未重启）；`VOICE_REALTIME_SILENCE_TAIL` 仍未设=true（生产默认仍是关）；生产环境变量改动 0 条（gate 在探针内构造）；外联仅 wss://dashscope.aliyuncs.com/api-ws/v1/realtime
- [x] **AC8** — 职责边界：三臂都只发 session.update ×1 + input_audio_buffer.append；禁用帧（response.create / input_audio_buffer.commit / input_audio_buffer.clear / response.cancel）共 0 处；由边界事件驱动的 response.create 0 次；三臂 session.update 里的 turn_detection 与出货解析器输出一致=true（{"type":"server_vad","threshold":0.5,"silence_duration_ms":400}）；离线回放只读 frames/stage、不消费任何 local-speech 边界事件
- [x] **S2** — keepalive：B 臂被压住累计 4900 ms、其间发出 keepalive 0 帧、最长不发送间隔 4900 ms、连接存活 true；报告中含「与节流目标的冲突」段=true（取假形态 F4 ⇒ 红）
- [x] **S3** — localSpeechGate / reportLocalSpeechBoundary / watchdog 已在报告中显式标注为**既有旁路**=true（标记串判据）；探针未 import/构造它们=true（barrel 导入符号 4 个，其中不含这两个）
- [x] **S4** — 三臂模型侧读数均足够，结论可用

## 方法与限制

- 语料是**真实**上行捕获（continuous 路径才捕获：`frame.seq === undefined`），不是脚本内构造的片段；excerpt 取源音频的一段固定窗口。
- 转发真值来自 journal 的 `<< function_call session_send`；`committed` ↔ `transcription.completed` 按到达顺序一一对应，条数不等即抛错，不做猜测性对齐。
- 静音占比两列：**源语料侧**由真实 capture timeline 的 `speech_started/stopped` 在窗口内的部分算出（与臂无关）；**上游侧**由本臂自己收到的 `speech_started/stopped` 算出。
- 本探针**不写任何生产环境变量**：gate 在探针内 `createSilenceTailGate({})` 构造（出货默认 T=1000 ms / P=500 ms / keepalive=30000 ms）。
- 单次运行、每臂一条全新连接；本实验**不追求统计功效**，只要求三臂同源可比。读数差异不足以支撑跨样本的泛化结论。
- **离线回放与真实臂同源**：同一条 PCM、同一个 `createSilenceTailGate({})`，逐帧喂入。`nowMs` 只影响 keepalive，而本窗口的挂起累计时长 4900 ms 远低于 30000 ms 的 keepalive 间隔，故离线回放与真实 B 臂**逐值相同**（见 AC4 表）。
- **本窗口的挂起由数字静音驱动**（见 AC4）⇒ 本窗口**不能**用来回答「真实房间噪声被裁掉会不会改变模型输入」；它能回答的是「门控确实会裁、且裁得对（无语音损失）」。真实噪声为何裁不动，见 AC5 的钳位分析。
- 上游 realtime 端点本身是唯一外联；`turn_detection` 由出货解析器给出，三臂相同；本探针没有任何写 `turn_detection` 的代码路径。
- **keepalive 的判据也受窗口长度限制**：本次 excerpt 只有 42 s，被压住的累计 4900 ms 远低于 keepalive 间隔，因此既没机会触发门控的 keepalive，也没有机会验证「压住 ≥ 300 s 会不会被上游以 `1007 response_idle_timeout` 断线」。报告只写「本探针未额外加 keepalive」与「出货门控自带的是连续静音 PCM，与节流目标冲突、且按既有读数未必有效」，**不**把「本次没断线」读成「静音保活有效」或「不需要保活」。
- 三臂各一条连接、**每臂只跑一次**：模型侧读数（转写/转发条数、保真、中断）在同输入下也不保证复现，因此 C−A 的模型侧差异**不是**输入差异（两者的上行逐字节相同），只能是抖动；结论只对**上传量**作断言。

来源对应表全文与逐帧读数见 `/tmp/voice-realtime-vad-three-arm-1791884809369/snapshot.json` 与 `journal/`。
