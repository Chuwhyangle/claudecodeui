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

**查重结论（实测检查）**：`gap-voice-five-vad-offline-comparison-on-real-corpus` 只做离线、其 AC 明令不得驱动 turn detection；`gap-voice-server-vad-three-arm-replay-on-third-test-corpus`（done）只用出货 STS 门控、无任何 ML VAD；`gap-voice-vad-detector-defect-red-run-on-continuous-silence-excerpt` 仅 STS。⇒ **无一条同时含"非 STS 的 VAD + 真实上游"**，故只新增本任务，且**不复跑**离线对比与 STS 三臂。

## Evidence（本轮 28 次真实上游臂运行的 settled 记录）

窗口 **0–45000 ms**，会话体逐字节相同，`turn_detection` 由**出货解析器**给出 `{"type":"server_vad","threshold":0.5,"silence_duration_ms":400}`。花费合计 **¥0.1038**。

**（1）转写条数，n=5/臂，全部 settled（非摘要行快照）**

| 臂 | 转写（5 次样本） | 缺末句次数 | 有效 gapMax |
| --- | --- | --- | --- |
| A 原样 | 5, 5, 5, 5, 5 | **0 / 5** | 22 ms |
| Silero@0.5 | 4, 4, 4, 4, 4 | **5 / 5** | 7800 ms |
| TEN@0.5 | 4, 4, 4, 4, 4 | **5 / 5** | **11480 ms** |
| WebRTC agg1 | 5, 5, 5, 5, 3 | 1 / 5 | 2640 ms |

**（2）内容保真（修好采集后的读数，1 轮；基线为 journal 的 3 条转发）**

窗口内真值 5 句：U1 好/再次测一下 live voice mode；U2 哎/上面这句是不是很快；U3 但好像推理开始的慢一些；U4 当连续有多句的时候；U5 顺序还是错的。

| 臂 | 实际转发内容 | 内容丢失 |
| --- | --- | --- |
| 基线 | [U1+U2], [U3], [U4+U5] | 无（3 条） |
| A 原样 | [U1], [U2], [U3], [U4+U5] | **无**（4 条） |
| Silero | [U1], [U2], [U3] | **U4 与 U5 全丢** |
| TEN | [U1], [U2], [U3], [U4] | **U5 丢** |
| WebRTC | [U1], [U4+U5] | **U2 与 U3 丢**（转写有、转发无） |

⇒ **转发条数不是判据**（基线 3 / A 4 / WebRTC 2，合并粒度自变）；判据是"哪几句的内容到达了"。按此口径：**A 零丢失；Silero 丢 2 句；TEN 丢 1 句；WebRTC 丢 2 句。**

**（3）机制定位（输入侧，已量化）**

探针是**抽掉**帧、不补静音 ⇒ 上游收到的是**拼接后**的音频。窗口内投喂总时长：A 45.00 s / Silero 14.82 s / TEN 13.54 s / WebRTC 38.18 s。

| 臂 | seg4 名义 2160 ms → 投喂 | **seg4 开头被删** | seg5 名义 1185 ms → 投喂 |
| --- | --- | --- | --- |
| Silero | 1240 ms | **940 ms** | 1220 ms（**100% 保留**） |
| TEN | 1260 ms | **920 ms** | 1220 ms（**100% 保留**） |
| WebRTC | 2180 ms | 0 | 1220 ms（**100% 保留**） |

**末句的音频是 100% 完整送达的，却被 Silero/TEN 丢了**；唯一没删 seg4 起音、且 seg4 零损失的 WebRTC 保住了它。⇒ 丢的不是末句音频，是**末句在 endpoint 侧没能成为独立一项**——过滤上行 PCM 会改变 Realtime 上游自己的切分，这是**耦合**，不是纯节流。

**（4）已证伪的假说**
- **尾随静音饥饿**：三臂在每段（含末段）之后都完整保留 500 ms（26/26）与 1000 ms（51/51）尾随音频，seg4→seg5 的 172 ms 也是 9/9 全保留。
- **结算窗口伪影**：把结算从 6 s 加到 12 s 后，Silero/TEN **仍只有 4 条**；且 A 臂第 5 条转写落在 tAt=37010 ms，**早于窗口结束的 45000 ms**，不可能被截断。Silero/TEN 的 `responses` 稳定为 3（A/WebRTC 为 4），是整轮行为。

**（5）探针缺陷诊断与修复（已在本轮内存版验证）**
根因：探针在 **`response.output_item.added`** 就"接单"，而该事件**不带 `arguments`**（参数随后才流式到达），且它把 `call_id` 放进去重集合，导致真正带参数的 `response.function_call_arguments.done` 被跳过。后果：转发文本恒为空 + 上游回 `Unknown function call id`。**改为只在 `.done` 接单并累积 delta 后：A 臂错误 3 → 0、WebRTC 1 → 0、转发文本全部拿到。**残留：Silero 1 条、TEN 3 条 `Unknown function call id` 仍在，未归因。

**（6）不受上述疑点影响的正面读数**：上行字节压缩 32.9% / 30.1% / 84.8%；**TEN 有 11.48 s 完全未发任何字节而连接未断、仍产出 response** ⇒ 本时间尺度下不需要 keepalive；句内帧侵蚀（Silero 66.8% / TEN 61.2% 语音帧保留）而上游仍转写出前 4 句 ⇒ **离线帧级"语音损失"预测不了上游行为**。

## 基线（必须逐项对齐）

源会话 `af5559c0`：continuous、**STS 关闭**（服务端无任何 `VOICE_REALTIME_*`）、`turn_detection` 由出货解析器给出、模型 `qwen3.8-omni-flash-realtime`、voice `Tina`、372.66 s、**18 `committed` / 18 `transcription.completed` / 12 `session_send`**（journal 实测计数）。窗口内 **5 条转写 → 3 条转发**。

## Plan

1. 把内存版探针（只答 `.done` + delta 累积 + 到达时刻）落进 `experiments/`，并在正式实现里保留**每臂 ≥3 次重复**。
2. 结算改为**静默判定**（连续 ≥15 s 无任何帧才冻结记录），而不是固定 sleep；摘要行不得在 arm 返回时打印。
3. 四臂同一窗口、会话体逐字节相同，唯一差别是"写哪些帧"；真值取自 capture timeline 与 voice journal。
4. 扩到 18 段全长（或至少覆盖多次 seg4/seg5 型相邻短句）以检验"seg4 起音被删 ⇒ 下一句丢失"是否是可推广的形态，而不是这一处的巧合。
5. 残留的 Silero/TEN `Unknown function call id` 单独归因。

## AC

- [ ] AC1 四臂同一窗口、同一会话体（`turn_detection` 出货解析器给出且逐字节相同）；报告含与基线对齐的逐项对照表（含无法对齐项）。
- [ ] AC2 每臂齐备：上传帧/字节与占比、transcribed 条数与**到达时刻**、forwarded 条数**与文本**、保真、遗漏、首 `function_call` 延时、上游错误、连接存活、最长不发送间隔、花费。
- [ ] AC3 **参照系是 relay 自己的**：真值取自 capture timeline 与 voice journal；⛔ 不得用 CLI transcript（取假形态 ⇒ 红）。
- [ ] AC4 过滤只发生在**上行 PCM**：无 `response.create`、无 `input_audio_buffer.commit` 由本地 VAD 驱动；⛔ 不得注入 turn detection / endpointing 语义。
- [ ] AC5 费用与时长受限并实测记录。
- [ ] AC6 不改生产配置（`VOICE_REALTIME_SILENCE_TAIL` 仍为关）、不重启 :3001（pid 前后相同）；零外联（上游端点除外）。
- [ ] AC7 报告必须写明：记录的是**抽帧拼接**后的流，不等于"把非语音替换为静音"的降采样场景；两种投喂方式的差别须显式说明。
- [ ] AC8 **局限量化**：人工语音真值不足（现用 Qwen 18 段 proxy）；非确定性量级——首 call 延时实测 6961–15018 ms，转写条数 WebRTC 出现 3 与 5 两种。
- [ ] AC9 转发**条数不是判据**，判据是"哪几句内容到达了"；合并粒度基线 3 / A 4 / WebRTC 2 已实测自变。
- [ ] AC10 不得把句内帧侵蚀直接读成识别损失（前 4 句在所有臂上都转写正确）。
- [ ] AC11 **不得把"Silero/TEN 丢末句"当成已解释**：机制候选已收敛到"seg4 起音被删致上游切分改变"，但尚未在全长语料上复现验证。

## DoD

三 VAD 的过滤 PCM 在同一窗口上真实送过上游并留下可复算读数；与基线在 transcribed（含到达时刻）/ forwarded（含文本）/ 保真 / 遗漏 / 首 call 延时 / 错误 / 连接存活 / 上传字节上逐项可比；**末句丢失机制在全长语料上被验证或明确标为未验证**；探针的接单缺陷被修掉且残留错误被归因；生产配置与线上服务未被触碰。

## Touches

- experiments/voice-realtime-vad-three-arm/probe.mts
- experiments/voice-vad/engines/ (new)
- docs/operations/voice-vad-filtered-pcm-upstream-replay.md (new)
- tasks/gap-voice-three-vad-filtered-pcm-real-upstream-replay.md

## Notes

**依赖**：`gap-voice-five-vad-offline-comparison-on-real-corpus`（交付引擎适配器）。

**待裁定**：本任务由写入自动从 `todo` 变为 `ready`，而其依赖仍为 `ready` 未 done。

**不做**：不重跑离线五方案对比；不重跑 STS 三臂回放；不改任何出货默认值；不把 VAD 事件接到任何模型触发路径。