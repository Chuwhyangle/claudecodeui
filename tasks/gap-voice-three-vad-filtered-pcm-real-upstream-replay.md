---
id: gap-voice-three-vad-filtered-pcm-real-upstream-replay
title: 三个 ML VAD（Silero/TEN/WebRTC）过滤后的 PCM 送真实 Qwen Realtime，与第三次实测原始音频的真实识别/13
  条 session_send 对比
status: todo
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

**这是当前缺失的那条轴**：用 **Silero / TEN / WebRTC** 三个 ML VAD 过滤第三次实测的完整样本，把**过滤后的 PCM 送真实 Qwen Realtime**，与**原始完整音频当时的真实模型输出**（转写 + 13 条 `session_send`）对比。

**查重结论（本轮实测检查，非声明）**：

| 既有任务 | 做了什么 | 缺什么 |
| --- | --- | --- |
| `gap-voice-five-vad-offline-comparison-on-real-corpus` | 五方案**离线**指标（过滤比例/真值漏检/RTF/RSS） | **不碰上游**；其 AC 明令"不得由这些 VAD 驱动 turn detection / commit / response.create" |
| `gap-voice-server-vad-three-arm-replay-on-third-test-corpus`（done） | 真实上游 A/B/C 三臂 | **只用出货 STS 门控**，无任何 ML VAD |
| `gap-voice-vad-detector-defect-red-run-on-continuous-silence-excerpt` | STS 钳位缺陷复议 | 同上，仅 STS |

⇒ **没有任何一条同时包含"非 STS 的 VAD + 真实上游"**。离线任务的 DoD 装不下付费上游 A/B/C（代价与判据都不同），故**只新增本任务，不扩原任务**；本任务**不复跑**离线对比、**不复跑** STS 三臂。

**基线（原始完整音频的真实工作条件，必须逐项对齐）**：源会话 `af5559c0`——continuous、**STS 关闭**（服务端无任何 `VOICE_REALTIME_*` 环境变量）、`turn_detection` 由**出货解析器**给出 `{"type":"server_vad","threshold":0.5,"silence_duration_ms":400}`、模型 `qwen3.8-omni-flash-realtime`、voice `Tina`、372.66 s 全程、18 条 `committed` / 18 条 `transcription.completed` / **13 条 `session_send`**。

**新 replay 必须与基线对齐的项**（不对齐则不可比，须逐项写进报告）：模型、voice、`turn_detection`（**出货解析器**，不手工拼）、instructions、tools、采样率/声道、**起点与截段长度**、墙钟推进节奏。无法对齐的（真实用户说话节奏、当时的会话历史）必须列明。

**先验已测（本轮离线）**：三 VAD 在完整 372.66 s 上 keep(speech) 比例——Silero@0.5 **18.63%**、TEN@0.5 **18.76%**、WebRTC agg1 **56.09%**（同一 20 ms 网格 + 同一 postfilter preroll 500 / hangover 320）。即上行字节可分别降到 **18.6% / 18.8% / 56.1%**。

## Plan

1. 复用既有 `experiments/voice-realtime-vad-three-arm/probe.mts` 的协议骨架（raw WS、手动不 commit、dry-run 执行器、usage 计费、上限、JSONL）；把「门控」换成三 VAD 的**逐帧掩码**（由 `experiments/voice-vad/engines/*` 产出）。
2. 四臂同一窗口：**A = 原样**（基线，复跑一次以消除跨日漂移）、**B = Silero 掩码**、**C = TEN 掩码**、**D = WebRTC 掩码**；四臂的会话体逐字节相同，唯一差别是"写哪些帧"。
3. 逐臂读：上传帧/字节（占窗口比例）、**transcribed 条数**、**forwarded(`session_send`) 条数**、**tool call 内容保真**（对基线 13 条）、遗漏、**首次 `function_call` 延时**、上游错误数、连接存活、最长不发送间隔、花费。
4. 起点/截段的选取必须让基线在该窗口内有**可比的真值**（窗口内的 committed/transcription/forward 从 journal 与 capture timeline 取，**不使用 CLI transcript**）。

## AC

- [ ] AC1 四臂同一窗口、同一会话体（`turn_detection` 由出货解析器给出且四臂逐字节相同）；报告写出与基线对齐的逐项对照表（含无法对齐项）。
- [ ] AC2 每臂齐备：上传帧/字节与占比、transcribed 条数、forwarded 条数、保真、遗漏、首 `function_call` 延时、上游错误、连接存活、最长不发送间隔、花费。
- [ ] AC3 **参照系是 relay 自己的**：窗口内真值取自 capture timeline 的 `committed`/`itemId` 与 voice journal 的 `transcription.completed`/`session_send`；⛔ 不得用 CLI transcript 作转发真值（取假形态：换成 CLI/UI 侧视图 ⇒ 红）。
- [ ] AC4 过滤只发生在**上行 PCM**：帧型里无 `response.create`、无 `input_audio_buffer.commit` 由本地 VAD 驱动；⛔ 不得注入 turn detection / endpointing 语义。
- [ ] AC5 费用与时长受限并实测记录：每连接 CNY 上限、总上限、窗口长度上限、单次运行；写出实际花费与时长。
- [ ] AC6 不改生产配置（`VOICE_REALTIME_SILENCE_TAIL` 仍为关）、不重启 :3001（pid 前后相同）；除上游 realtime 端点外零外联。
- [ ] AC7 **局限写明**：人工语音真值仍不足（现用 Qwen 18 段 proxy，是模型边界不是真值）；模型**非确定性**，同输入不保证复现 ⇒ 差异不能单独归因于过滤，报告必须写出该不确定度的量级（例如 A 臂复跑的抖动）。
- [ ] AC8 读数不足即写「不足以判断」，不得把不足写成结论。

## DoD

在同一窗口上，三个 ML VAD 的过滤 PCM 各自真实送过上游并留下可复算读数；与基线（原样 PCM）在 transcribed / forwarded / 保真 / 遗漏 / 首 call 延时 / 错误 / 连接存活 / 上传字节上逐项可比；模型非确定性与真值不足这两条局限被量化写明；生产配置与线上服务未被触碰。

## Touches

- experiments/voice-realtime-vad-three-arm/probe.mts
- experiments/voice-vad/engines/ (new)
- docs/operations/voice-vad-filtered-pcm-upstream-replay.md (new)
- tasks/gap-voice-three-vad-filtered-pcm-real-upstream-replay.md

## Notes

**依赖**：`gap-voice-five-vad-offline-comparison-on-real-corpus` —— 因为它交付引擎适配器（本任务要复用来产出掩码）。若该任务已把适配器落进 `experiments/voice-vad/engines/`，本任务直接复用，不再自建。

**不做**：不重跑离线五方案对比；不重跑 STS 三臂回放；不改任何出货默认值；不把 VAD 事件接到任何模型触发路径。