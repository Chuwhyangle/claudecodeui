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

用 **Silero / TEN / WebRTC** 三个 ML VAD 过滤第三次实测样本的上行 PCM，送**真实 Qwen Realtime**，与原始完整音频当时真实模型输出（转写 + 12 条 `session_send`）对比。

**查重结论（实测）**：`gap-voice-five-vad-offline-comparison-on-real-corpus` 只做离线且 AC 明令不得驱动 turn detection；`gap-voice-server-vad-three-arm-replay-on-third-test-corpus`（done）只用出货 STS 门控、无任何 ML VAD；`gap-voice-vad-detector-defect-red-run-on-continuous-silence-excerpt` 仅 STS。⇒ 无一条同时含"非 STS 的 VAD + 真实上游"，故只新增本任务。

## Evidence

窗口 **0–45000 ms**，会话体逐字节相同，`turn_detection` 由**出货解析器**给出 `{"type":"server_vad","threshold":0.5,"silence_duration_ms":400}`。**累计花费 ¥0.1188（32 次真实上游臂运行）**。

### （1）决定性实验：片尾 `input_audio_buffer.commit` = "输入音频结束"

先前各轮探针**从不发结束输入信号**，靠 `ws.close()` 收场，把未闭合的尾巴留在上游。补上**一次**片尾 `commit`（`commitAt=44980 ms`；**不发 `response.create`** —— 按裁定它属回合触发，禁止注入）后：

| 臂 | 转写（无 commit，n=5） | **转写（有片尾 commit，n=1）** | 转发内容（有 commit） |
| --- | --- | --- | --- |
| A 原样 | 5,5,5,5,5 | **5** | [U1],[U2],[U3],[U4+U5] — 全在 |
| Silero | 4,4,4,4,4 | **5** ✅ | [U1],[?],[U3] — **U4+U5 未转发** |
| TEN | 4,4,4,4,4 | **5** ✅ | [U1],[U2],[U3],[U4] — **U5 未转发** |
| WebRTC | 5,5,5,5,3 | **5** | [U1],[U2],[U3],[U4+U5] — 全在 |

⇒ **"Silero/TEN 可复现地丢末句"这一结论被推翻。** 它是探针从不告知"音频结束"的**收尾伪影**，不是 VAD 质量造成的。末句音频本就 100% 完整送达，缺的只是"音频到此为止"这个信号。**这也解释了 A 臂为什么从不丢**：它把全部音频（含静音）都送上去，endpoint 的 server_vad 永远能自己闭合。

### （2）片尾 commit 不是普遍安全的

两条臂返回上游错误 `Error committing input audio buffer: buffer too small, or have no audio.`（A 与 WebRTC）——它们的 `server_vad` 已把缓冲区排空，commit 无处可落。这与出货代码的既有先例一致（`voice-realtime-manual-vad-session-update.test.ts` 开头，journal `ef9daacd`：commit 被拒、随后 `response.create` 不产生 `response.created`，"听见了、转写了、从未转发"），也是出货保留 `server-vad` 回退路径（**片尾补 `commitGapMs` 真静音**）的原因。⇒ **过滤帧之后如何闭合，必须实测选型，不能假定 commit 可用。**

### （3）仍开放：转发内容与转写不同步

补 commit 后三臂都**转写**出了 5 句，但**转发**仍有缺：Silero 缺 U4+U5、TEN 缺 U5（WebRTC 与 A 全在）。且 Silero `responses=3`、TEN `responses=4`。n=1 且探针有下述 bug ⇒ **不足以归因，不得当结论。**

### （4）探针缺陷（均已定位，未全部修完）

- **已修**：原先在 `response.output_item.added` 接单（该事件不带 `arguments`），导致转发文本恒空 + `Unknown function call id`。改为只在 `response.function_call_arguments.done` 接单后，A/WebRTC 错误清零、文本拿到。
- **未修**：delta 累积**不可靠** —— 实测 `CALL_ARGS_EMPTY parseErr=Expected ',' or '}' ... raw={"message": "诶，上面这句话识别得很快。"`，说明 delta 与 `.done` 的 key（`call_id` vs `item_id`）不一致，累积串被截断。Silero 因此丢了一条转发文本。
- **未归因**：`Unknown function call id` 在修完后仍零星出现（a 1 / silero 2 / ten 3 / webrtc 0）。
- **结算**：摘要行是 arm 返回时的过早快照，与 settled JSON 不一致（曾导致一次错误结论）。必须改为静默判定（连续 ≥15 s 无帧才冻结）。

### （5）不受上述任何疑点影响的读数

- 上行字节压缩：**32.9% / 30.1% / 84.8%**（Silero / TEN / WebRTC），窗口内投喂音频时长 14.82 s / 13.54 s / 38.18 s（A 为 45.00 s）。
- **TEN 有 11.48 s 完全未发任何字节而连接未断、后续仍产出 response** ⇒ 本时间尺度下**不需要 keepalive**。
- 句内帧侵蚀（Silero 语音帧保留 66.8%、TEN 61.2%）而上游仍正确转写出前 4 句 ⇒ **离线帧级"语音损失"预测不了上游行为**。
- 首 call 延时实测跨度 **6961–15018 ms**（同一份 PCM），这是该通路真实非确定性量级。

## 基线

源会话 `af5559c0`：continuous、STS 关闭、`turn_detection` 出货解析器给出、模型 `qwen3.8-omni-flash-realtime`、voice `Tina`、372.66 s、**18 `committed` / 18 `transcription.completed` / 12 `session_send`**（journal 实测）。窗口内 **5 条转写 → 3 条转发**（[U1+U2],[U3],[U4+U5]）。journal 方向实测：**`>> input_audio_buffer.commit` 一条都没有**，18 条 `committed` 全由 endpoint 自己的 server_vad 发出。

## Plan

1. 落进 `experiments/`：只在 `.done` 接单、**正确对齐 delta 的 key**、记录每帧到达时刻、片尾发一次 `commit`（语义＝输入结束，不发 `response.create`）。
2. 片尾闭合做**选型对照**：`commit` vs 补 `commitGapMs` 真静音，各 ≥3 次，实测哪个被这个上游接受。
3. 四臂同窗口、会话体逐字节相同；每臂 ≥3 次重复；真值取自 capture timeline 与 voice journal（⛔ 不用 CLI transcript）。
4. 在**闭合正确**的前提下重测转发内容保真；扩到多次"相邻短句"形态以检验（3）是否可推广。
5. 归因残留的 `Unknown function call id`。

## AC

- [ ] AC1 四臂同一窗口同一会话体（`turn_detection` 出货解析器给出且逐字节相同）；报告含与基线逐项对齐表（含无法对齐项）。
- [ ] AC2 每臂齐备：上传帧/字节与占比、transcribed 条数与**到达时刻**、forwarded 条数与**文本**、保真、遗漏、首 `function_call` 延时、上游错误、连接存活、最长不发送间隔、花费。
- [ ] AC3 参照系是 relay 自己的（timeline + journal）；⛔ 不得用 CLI transcript。
- [ ] AC4 过滤只在上行 PCM；⛔ 不注入 turn detection / endpointing 语义；⛔ **不发 `response.create`**；片尾 commit 只作"输入结束"，不得用于触发模型或 Claude Code 动作。
- [ ] AC5 费用与时长受限并实测记录。
- [ ] AC6 不改生产配置（`VOICE_REALTIME_SILENCE_TAIL` 仍为关）、不重启 :3001（pid 前后相同）；零外联（上游端点除外）。
- [ ] AC7 报告必须写明投喂方式是**抽帧拼接**，不等于"非语音替换为静音"；且**必须发结束输入信号**，不得用 `ws.close()` 收场。
- [ ] AC8 **局限量化**：真值不足（Qwen 18 段 proxy）；非确定性量级——首 call 6961–15018 ms，转写条数 WebRTC 曾出现 3 与 5。
- [ ] AC9 转发条数不是判据，判据是"哪几句内容到达了"（合并粒度基线 3 / A 4 / WebRTC 2 已实测自变）。
- [ ] AC10 不得把句内帧侵蚀直接读成识别损失。
- [ ] AC11 **不得把"末句丢失"当作 VAD 质量的后果**：已证明那是缺结束输入信号的伪影，Silero/TEN 补 commit 后均恢复为 5 条。
- [ ] AC12 片尾闭合方式（commit vs 真静音）必须实测选型，并记录 `buffer too small, or have no audio` 的出现条件。

## DoD

三个 ML VAD 的过滤 PCM 在**正确的结束输入信号**下真实送过上游并留下可复算读数；与基线在 transcribed（含到达时刻）/ forwarded（含文本）/ 保真 / 遗漏 / 首 call 延时 / 错误 / 连接存活 / 上传字节上逐项可比；片尾闭合方式经实测选定；转发内容与转写不同步的现象被解释或明确标为未解释；探针缺陷全部修完；生产配置与线上服务未被触碰。

## Touches

- experiments/voice-realtime-vad-three-arm/probe.mts
- experiments/voice-vad/engines/ (new)
- docs/operations/voice-vad-filtered-pcm-upstream-replay.md (new)
- tasks/gap-voice-three-vad-filtered-pcm-real-upstream-replay.md

## Notes

**依赖**：`gap-voice-five-vad-offline-comparison-on-real-corpus`。

**待裁定**：本任务由写入自动从 `todo` 变为 `ready`，而其依赖仍为 `ready` 未 done。

**不做**：不重跑离线五方案对比；不重跑 STS 三臂回放；不改任何出货默认值；不把 VAD 事件接到任何模型触发路径。