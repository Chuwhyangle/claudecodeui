---
id: gap-voice-three-vad-filtered-pcm-real-upstream-replay
title: 三个 ML VAD（Silero/TEN/WebRTC）过滤后的 PCM 送真实 Qwen Realtime，与第三次实测原始音频的真实识别/12
  条 session_send 对比
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-voice-five-vad-offline-comparison-on-real-corpus
---
## Proposal

**这是当前缺失的那条轴**：用 **Silero / TEN / WebRTC** 三个 ML VAD 过滤第三次实测的完整样本，把**过滤后的 PCM 送真实 Qwen Realtime**，与**原始完整音频当时的真实模型输出**（转写 + 12 条 `session_send`）对比。

**查重结论（本轮实测检查，非声明）**：

| 既有任务 | 做了什么 | 缺什么 |
| --- | --- | --- |
| `gap-voice-five-vad-offline-comparison-on-real-corpus` | 五方案**离线**指标（过滤比例/真值漏检/RTF/RSS） | **不碰上游**；其 AC 明令"不得由这些 VAD 驱动 turn detection / commit / response.create" |
| `gap-voice-server-vad-three-arm-replay-on-third-test-corpus`（done） | 真实上游 A/B/C 三臂 | **只用出货 STS 门控**，无任何 ML VAD |
| `gap-voice-vad-detector-defect-red-run-on-continuous-silence-excerpt` | STS 钳位缺陷复议 | 同上，仅 STS |

⇒ **没有任何一条同时包含"非 STS 的 VAD + 真实上游"**。离线任务的 DoD 装不下付费上游 A/B/C（代价与判据都不同），故**只新增本任务，不扩原任务**；本任务**不复跑**离线对比、**不复跑** STS 三臂。

## Evidence（本轮两轮独立实测；settled 记录，非摘要行快照）

窗口 **0–45000 ms**，四臂会话体逐字节相同，`turn_detection` 由**出货解析器**给出 `{"type":"server_vad","threshold":0.5,"silence_duration_ms":400}`。下表是**每轮全部四臂跑完后的 settled JSON**，不是各臂当时的摘要行——两者会不一致（见缺口 1）。

| 臂 | 上行帧 | 字节 | 占窗口 | 转写 (run1 / run2) | 调用 (r1/r2) | 首 call (r1/r2) | 上游错误 (r1/r2) | gapMax | ¥/臂 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A 原样 | 2250 | 1,440,000 | 100.0% | **5 / 5** | 4 / 4 | 7075 / 14891 ms | 0 / 3 | 22 ms | 0.0044 |
| Silero@0.5 | 741 | 474,240 | 32.9% | **4 / 4** | 4 / 4 | 8252 / 8218 ms | 3 / 2 | 7800 ms | 0.0042 |
| TEN@0.5 | 677 | 433,280 | 30.1% | **4 / 4** | 3 / 3 | 7915 / 7949 ms | 0 / 0 | **11480 ms** | 0.0029 |
| WebRTC agg1 | 1909 | 1,221,760 | 84.8% | **5 / 5** | 4 / 4 | 7980 / 9146 ms | 0 / 1 | 2640 ms | 0.0045 |

**可复现的读数（两轮完全一致，n=2/臂）**：A 与 WebRTC 每次都拿到 5 条转写；**Silero 与 TEN 每次都只有 4 条，都缺最后一句**（"顺序还是错的。"，音频 33916–35101 ms）。转发条数同样两轮一致（4/4/3/4）。

**不可复现的读数**：首 call 延时在**同一份 PCM** 上 7075 ↔ 14891 ms（**2.1× 摆动**）；上游错误数 0 ↔ 3。

**归因现状（必须原样带进报告）**：
- "Silero/TEN 丢最后一句"**可复现，但尚未可归因**。
- **尾随静音饥饿假说已被证伪**：三臂在**每一段**（含最后一段）语音之后都完整保留了 500 ms（26/26 帧）与 1000 ms（51/51 帧）的尾随音频，seg4→seg5 的 172 ms 间隔也是 9/9 全保留。所以不是"没有静音 ⇒ endpoint 不 commit"。
- **仍活着的替代解释：探针自身的结算窗口伪影**。30% 保留率的臂在 45 s 墙钟里只投喂了约 13.5 s 音频，endpoint 在**它自己的时间轴**上到达末句要晚得多；而本轮已**直接证实探针会丢晚到的消息**（run2 的 A 臂：摘要行打 `transcripts=3 / calls=3 / resp=3 / err=2`，settled 记录是 `5 / 4 / 4 / 3`）。⇒ 末句缺失可能是 6 s 结算窗口 + `ws.close()` 切断了它，而非模型没听见。**必须先排除这一条才能在报告里下结论。**

**已确证、不受上述疑点影响**：上行字节压缩（32.9 / 30.1 / 84.8%）；**TEN 有 11.48 s 完全未发任何字节而连接未断、仍产出 response** ⇒ 本时间尺度下不需要 keepalive；句内帧侵蚀幅度（Silero 66.8%、TEN 61.2%、WebRTC 92.5% 的语音帧保留率）而 1–4 句在**所有**臂上都转写正确 ⇒ **离线帧级"语音损失"预测不了上游行为**。

## 基线（原始完整音频的真实工作条件，必须逐项对齐）

源会话 `af5559c0`——continuous、**STS 关闭**（服务端无任何 `VOICE_REALTIME_*` 环境变量）、`turn_detection` 由**出货解析器**给出 `{"type":"server_vad","threshold":0.5,"silence_duration_ms":400}`、模型 `qwen3.8-omni-flash-realtime`、voice `Tina`、372.66 s 全程、**18 条 `committed` / 18 条 `transcription.completed` / 12 条 `session_send`**（journal 实测计数，非推测）。

**基线在窗口 0–45000 ms 内：5 条 `transcription.completed` → 3 条 `session_send`**（@12138 合并了前两句、@22280、@38078 合并了第 4/5 句）。⇒ 基线按"合并后的转发条数"只有 3，而四臂都是 3 或 4 —— 合并粒度本身不稳，**条数不可单独作判据**。

## Plan

1. 复用 `experiments/voice-realtime-vad-three-arm/probe.mts` 的协议骨架；把「门控」换成三 VAD 的**逐帧掩码**（由 `experiments/voice-vad/engines/*` 产出）。
2. **先修探针的结算缺陷**：不得在 arm 返回时就打摘要行；必须等到 socket 真正 `close` 或静默 N 秒（建议 ≥15 s 且以"连续 N 秒无任何帧"为准）才冻结记录，并记录每条消息的到达时刻。
3. 四臂同一窗口：A 原样 / B Silero / C TEN / D WebRTC；会话体逐字节相同，唯一差别是"写哪些帧"。**每臂 ≥3 次重复。**
4. 修参数采集：从 `response.function_call_arguments.delta` 累积（`.done` 的 `arguments` 可能为空）；对齐回执 `call_id` 的来路以消除 `Unknown function call id`。
5. 逐臂读：上传帧/字节与占比、transcribed 条数与**到达时刻**、forwarded 条数**与文本**、保真、遗漏、首 `function_call` 延时、上游错误、连接存活、最长不发送间隔、花费。
6. 真值取自 capture timeline 的 `committed`/`itemId` 与 voice journal 的 `transcription.completed`/`session_send`，**不使用 CLI transcript**。

## AC

- [ ] AC1 四臂同一窗口、同一会话体（`turn_detection` 由出货解析器给出且四臂逐字节相同）；报告写出与基线对齐的逐项对照表（含无法对齐项）。
- [ ] AC2 每臂齐备：上传帧/字节与占比、transcribed 条数与到达时刻、forwarded 条数与文本、保真、遗漏、首 `function_call` 延时、上游错误、连接存活、最长不发送间隔、花费。
- [ ] AC3 **参照系是 relay 自己的**：真值取自 capture timeline 与 voice journal；⛔ 不得用 CLI transcript 作转发真值（取假形态：换成 CLI/UI 侧视图 ⇒ 红）。
- [ ] AC4 过滤只发生在**上行 PCM**：无 `response.create`、无 `input_audio_buffer.commit` 由本地 VAD 驱动；⛔ 不得注入 turn detection / endpointing 语义。
- [ ] AC5 费用与时长受限并实测记录：每连接 CNY 上限、总上限、窗口长度上限；写出实际花费与时长。
- [ ] AC6 不改生产配置（`VOICE_REALTIME_SILENCE_TAIL` 仍为关）、不重启 :3001（pid 前后相同）；除上游 realtime 端点外零外联。
- [ ] AC7 **结算窗口必须先被排除**：记录每条转写的到达时刻，证明末句缺失不是探针在 endpoint 处理完之前 `close` 造成的；若无法排除，报告必须写「不足以判断」并给出该读数的上界。
- [ ] AC8 **局限量化写明**：人工语音真值仍不足（现用 Qwen 18 段 proxy，是模型边界不是真值）；模型非确定性须给出量级——已实测同一份 PCM 的首 call 延时 7075 ↔ 14891 ms（2.1×）、上游错误 0 ↔ 3。
- [ ] AC9 转发**条数不是判据**：基线自身会把两句合并成一条（窗口内 5 条转写 → 3 条转发），条数差异必须在文本层面解释后才可归因。
- [ ] AC10 **不得把句内帧侵蚀读成识别损失**：Silero 句内保留 66.8%、TEN 61.2%，而 1–4 句在所有臂上都转写正确。

## DoD

三 VAD 的过滤 PCM 在同一窗口上各自真实送过上游，读数在**排除了探针结算伪影**之后与基线在 transcribed（含到达时刻）/ forwarded（含文本）/ 保真 / 遗漏 / 首 call 延时 / 错误 / 连接存活 / 上传字节上逐项可比；模型非确定性与真值不足被**量化**写明；生产配置与线上服务未被触碰。

## Touches

- experiments/voice-realtime-vad-three-arm/probe.mts
- experiments/voice-vad/engines/ (new)
- docs/operations/voice-vad-filtered-pcm-upstream-replay.md (new)
- tasks/gap-voice-three-vad-filtered-pcm-real-upstream-replay.md

## Notes

**依赖**：`gap-voice-five-vad-offline-comparison-on-real-corpus`（交付引擎适配器，本任务复用来产出掩码）。

**本轮已知探针缺陷（必须在正式实现里修掉）**：摘要行是 arm 返回时的**过早快照**，与 settled JSON 不一致（run2 A 臂 3 vs 5 条转写）；`alive`/`closeCode`（1005 无状态、1006 异常、run2 WebRTC 甚至 `closed=false`）都是探针自己 `ws.close()` 的时序竞态，**不是断线证据**。

**不做**：不重跑离线五方案对比；不重跑 STS 三臂回放；不改任何出货默认值；不把 VAD 事件接到任何模型触发路径。