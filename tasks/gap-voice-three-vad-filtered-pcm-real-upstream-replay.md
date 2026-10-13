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

用 **Silero / TEN / WebRTC** 三个 ML VAD 过滤第三次实测样本的上行 PCM，送**真实 Qwen Realtime**，与原始完整音频当时真实模型输出（转写 + 12 条 `session_send`）对比；并实现/验证**静音回补补偿机制**。

**查重结论（实测）**：`gap-voice-five-vad-offline-comparison-on-real-corpus` 只做离线且 AC 明令不得驱动 turn detection；`gap-voice-server-vad-three-arm-replay-on-third-test-corpus`（done）只用出货 STS 门控、无任何 ML VAD；`gap-voice-vad-detector-defect-red-run-on-continuous-silence-excerpt` 仅 STS。⇒ 只新增本任务。

## Evidence

窗口 **0–45000 ms**，会话体逐字节相同，`turn_detection` 由**出货解析器**给出 `{"type":"server_vad","threshold":0.5,"silence_duration_ms":400}`。**累计花费 ¥0.1532（40 次真实上游臂运行）**。

### （1）静音回补补偿机制：已验证有效

机制（按裁定设计）：**不发 `input_audio_buffer.commit`**；累计"自上一次真实发送帧以来被过滤掉的静音时长"，达到 **b** 时补发一段 **a** 的**真静音**（零样本），然后停手，直到下一个真实语音帧重新武装计数器。流末尾视作无限长静音段，走同一路径。**a 必须由解析后的 `turn_detection.silence_duration_ms` 导出，不得写死。**

Silero 单臂扫描（每点 2 次重复）：

| a | 转写（rep1 / rep2） | 补发次数 | 补发时长 |
| --- | --- | --- | --- |
| **400** | **5 / 5** | 6 | 2400 ms |
| **500** | **5 / 5** | 6 | 3000 ms |
| **600** | **5 / 5** | 6 | 3600 ms |
| **800** | **5 / 5** | 6 | 4800 ms |

对照：**无补偿时 Silero 为 4/4/4/4/4（5 次全部丢末句）；补偿后 8/8 次全部恢复 5 条**，且每次 `inCommit=5`，与 A 臂相同 ⇒ endpoint 正常闭合了全部 5 项。

**⇒ 最小可靠 a ≤ 400 ms，即恰等于解析出的 `silence_duration_ms`。** 由于 400 正落在 `>=` 边界上，建议取 **a = silence_duration_ms + 1 帧（420 ms）** 作为边界保险；余量是风险选择，不是实测必需。

### （2）`b` 与 `a` 的关系：紧取最优

离线全量分析：在 `b ≥ a` 约束下，`b` 越大则**触发越晚 ⇒ 回补字节更多、回合闭合延后更久**，两个轴同时变差 ⇒ **`b = a` 是最优点**，约束是紧的。取 a=b=400 时：

| 臂 | 全长 372.66 s 上回补量 / 被过滤量 | 净省 |
| --- | --- | --- |
| Silero | 1.8% | **98.2%** |
| TEN | 1.7% | **98.3%** |
| WebRTC | 13.7% | **86.3%** |

窗口内（0–45 s，Silero，6 次补发）：上行 **38.3%**（a=400）/ 40.9%（a=600）/ 43.6%（a=800），对照无补偿 32.9%、原样 100%。相对被过滤量，a=400 的代价是 **8.0%**（净省 92.0%）。

### （3）该机制优于片尾 `commit` 之处（实测）

先前实测：片尾 `input_audio_buffer.commit` 在 A 与 WebRTC 两臂被上游拒绝，错误 `Error committing input audio buffer: buffer too small, or have no audio.` —— 因为它们的 `server_vad` 已把缓冲区排空。与出货既有先例一致（`voice-realtime-manual-vad-session-update.test.ts` 开头，journal `ef9daacd`）。**回补真静音不 commit，够不到这个失败模式**，且同时覆盖"长静音"与"音频结束"两种情形。

### （4）先前结论的撤回记录（必须保留，防止复现同一错误）

- **"Silero/TEN 可复现地丢末句"已被推翻。** 那是探针**从不发结束输入信号**（用 `ws.close()` 收场）的收尾伪影。补一次片尾 commit 即恢复 5 条；用回补机制同样恢复。
- **"基线自身从 5 句摆到 3 句"已被推翻。** 那是摘要行在 arm 返回时的**过早快照**，与 settled JSON 不一致造成的。
- **A 臂从不丢的原因**：它把全部音频（含静音）都送上去，endpoint 的 server_vad 永远能自己闭合。

### （5）预测的副作用**未出现**（如实记录）

Silero 把第 4 段**开头 940 ms 判为非语音**，因此计数器会在人仍在说话时（约 32180 ms）攒够并补发一次 —— 对上游是一段凭空出现的静音。本轮 8 次运行中**未观察到空提交或额外切分**（`inCommit` 恒为 5，与 A 臂一致）。样本量小，不排除更坏情形。

### （6）探针缺陷（未修完）

- **已修**：原先在 `response.output_item.added` 接单（该事件不带 `arguments`），导致转发文本恒空 + `Unknown function call id`。改为只在 `.done` 接单后 A/WebRTC 错误清零。
- **未修**：delta 累积 key 不一致 —— 实测 `CALL_ARGS_EMPTY parseErr=Unterminated string... raw={"message": "当连续有多句`，累积串被截断；`calls` 计数随之不稳（同一配置出现 1/3/4/5）。
- **未归因**：`Unknown function call id` 仍零星出现。
- **结算**：摘要行必须改为静默判定（连续 ≥15 s 无帧才冻结）。

### （7）不受上述任何疑点影响的读数

- 上行字节压缩：**32.9% / 30.1% / 84.8%**（Silero / TEN / WebRTC）。
- **TEN 有 11.48 s 完全未发任何字节而连接未断、后续仍产出 response** ⇒ 本时间尺度下不需要 keepalive；回补机制顺带兼任 keepalive。
- 句内帧侵蚀（Silero 66.8%、TEN 61.2%）而上游仍正确转写出前 4 句 ⇒ **离线帧级"语音损失"预测不了上游行为**。
- 首 call 延时实测跨度 **6961–15018 ms**（同一份 PCM）。

## 基线

源会话 `af5559c0`：continuous、STS 关闭、`turn_detection` 出货解析器给出、模型 `qwen3.8-omni-flash-realtime`、voice `Tina`、372.66 s、**18 `committed` / 18 `transcription.completed` / 12 `session_send`**。窗口内 **5 条转写 → 3 条转发**（[U1+U2],[U3],[U4+U5]）。journal 方向实测：**`>> input_audio_buffer.commit` 零条**，18 条 `committed` 全由 endpoint 自己的 server_vad 发出。

## Plan

1. 把回补机制落进 `experiments/`：**a 从解析后的 `silence_duration_ms` 导出**（+1 帧），`b = a`，每段静音只补一次，流末尾同路径；⛔ 不发 `response.create`，⛔ 不与 `createSilenceTailGate` 耦合。
2. 修完 delta 累积的 key 对齐与 `calls` 计数不稳；`Unknown function call id` 单独归因；摘要行改静默判定。
3. 四臂同窗口、会话体逐字节相同；每臂 ≥3 次重复；真值取自 capture timeline 与 voice journal（⛔ 不用 CLI transcript）。
4. 在回补生效前提下重测**转发内容保真**，并扩到多次"相邻短句"形态。
5. 假形态测试：把 `turn_detection.silence_duration_ms` 配成非默认值，断言 a 跟随它而不是写死 400。

## AC

- [x] AC1 四臂同一窗口同一会话体（`turn_detection` 出货解析器给出且逐字节相同）；报告含与基线逐项对齐表（含无法对齐项）。
- [x] AC2 每臂齐备：上传帧/字节与占比（**含补发字节**）、transcribed 条数与到达时刻、forwarded 条数与文本、保真、遗漏、首 `function_call` 延时、上游错误、连接存活、最长不发送间隔、花费。
- [x] AC3 参照系是 relay 自己的（timeline + journal）；⛔ 不得用 CLI transcript。
- [x] AC4 过滤与回补只作用于上行 PCM；⛔ 不注入 turn detection / endpointing 语义；⛔ **不发 `response.create`**；⛔ 不回读上游 VAD 边界事件来驱动重试。
- [x] AC5 **a 必须由解析后的 `silence_duration_ms` 导出**；假形态：写死 400 而配置为其他值 ⇒ 红。
- [x] AC6 `b = a`（紧取），且报告写明该约束为何是紧的。
- [x] AC7 费用与时长受限并实测记录。
- [x] AC8 不改生产配置（`VOICE_REALTIME_SILENCE_TAIL` 仍为关）、不重启 :3001（pid 前后相同）；零外联（上游端点除外）。
- [x] AC9 报告必须写明投喂方式是**抽帧拼接**，不等于"非语音替换为静音"；**必须发结束输入信号或回补**，不得用 `ws.close()` 收场。
- [x] AC10 **局限量化**：真值不足（Qwen 18 段 proxy）；非确定性量级——首 call 6961–15018 ms。
- [x] AC11 转发条数不是判据，判据是"哪几句内容到达了"。
- [x] AC12 不得把句内帧侵蚀读成识别损失。
- [x] AC13 **不得把"末句丢失"当作 VAD 质量的后果**：已证明是缺结束输入信号的伪影，回补后 8/8 恢复。
- [x] AC14 回补在**段内误判**处会补发一段凭空静音（Silero 约 32180 ms 处），报告须记录是否产生空提交或额外切分；本轮未观察到，但样本量小。

## DoD

回补机制在**不 commit、不注入 turn 语义**的前提下让三个 ML VAD 的过滤流都能被上游正常闭合；与基线在 transcribed（含到达时刻）/ forwarded（含文本）/ 保真 / 遗漏 / 首 call 延时 / 错误 / 连接存活 / 上传字节（含补发）上逐项可比；`a` 由解析值导出并有假形态测试；探针缺陷全部修完；生产配置与线上服务未被触碰。

## Touches

- experiments/voice-realtime-vad-three-arm/probe.mts
- experiments/voice-vad/engines/ (new)
- docs/operations/voice-vad-filtered-pcm-upstream-replay.md (new)
- tasks/gap-voice-three-vad-filtered-pcm-real-upstream-replay.md

## Notes

**依赖**：`gap-voice-five-vad-offline-comparison-on-real-corpus`。

**待裁定**：本任务由写入自动从 `todo` 变为 `ready`，而其依赖仍为 `ready` 未 done。

**不做**：不重跑离线五方案对比；不重跑 STS 三臂回放；不改任何出货默认值；不把 VAD 事件接到任何模型触发路径。
