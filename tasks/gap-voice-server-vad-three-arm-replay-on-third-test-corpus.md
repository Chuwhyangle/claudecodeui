---
id: gap-voice-server-vad-three-arm-replay-on-third-test-corpus
title: 服务端 VAD 三臂同源回放实验（A 无 VAD / B 门控 / C 只观察）——用第三次实测的真实上行音频，分离检测质量与模型输入干预
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

人 yale 授权：用第三次 Live Voice 实测的**真实音频**与**质量良好的模型转发文本**，研究 CloudCLI **服务端 VAD** 对 Realtime 模型行为的影响。

**素材已严格核验存在**（2026-10-13 本轮只读查证）：

- 原始音频：`~/.cloudcli/voice-realtime-capture/af5559c0-d347-41f3-a6f0-f02a597af1e9.wav` —— RIFF/WAVE，**PCM16 / 16000 Hz / 单声道**，11,925,120 数据字节 = **372.66 s 连续**（与 `final` 行的 `dataBytes`/`durationMs` 逐位吻合）。
- capture timeline：同 id 的 `.timeline.jsonl` —— `origin` 显式声明 `sampleRate/channels/offsetMs:0`；18 × `speech_started` / `speech_stopped` / `committed`，每条带 `atMs` + **`offsetMs`（音频内偏移）** + `itemId`。共 22 行。
- 模型转发文本：同 id 的 voice journal（`~/.cloudcli/voice-realtime-log/af5559c0….jsonl`）里的 `session_send` function call —— **不是** CLI transcript。

**来源对应已建立**：capture `committed` 18 条 ↔ journal `transcription.completed` 18 条 ↔ journal `session_send` **13** 条 ⇒ 本次实测 **18 句被识别、13 句被转发、5 句"听了没转发"（27.8%）**。

**为什么必须用 continuous 语料**：上行捕获**只喂连续路径**（`frame.seq === undefined` 才捕获），segmented 路径按设计不捕获——代码注释写明理由："a corpus of speech-only clips cannot answer a detector question"。失败的 `0d2e6d93` 因此**没有音频**（无 `origin`/`final`、`offsetMs` 全 null），这是缺口不是缺陷。

**服务端 VAD 的实际路径（本轮已定位）**：`voice-realtime-silence-tail.ts`，开关 `VOICE_REALTIME_SILENCE_TAIL`（`1|on|true|yes` 才开，**默认关**）；只在 **continuous** 连接上构建（`silenceTailOptions = seams.silenceTail === undefined || segmentedRelay ? null : …`），作用于**上行 PCM**（`observe()` 决定是否抑制帧）；**不改 `turn_detection`**——`turn_detection` 由 `resolveTurnDetection` 决定，进 `session.update`，与门控无关。另有 `localSpeechGate`（`reportLocalSpeechBoundary`）在 continuous 上**只观察不裁剪**，本身已是 C 臂的产品形态。

**本任务要做**：三臂同源回放，把"检测质量"与"模型输入干预"分开。

## Plan

1. 写实验脚本（复用 `experiments/voice-realtime-large-append-probe/probe.mts` 的 raw-WS Link / 手动 commit / usage 计费 / JSONL journaling 骨架）：读源 WAV → 按实时墙钟逐 20 ms 帧推进 → 三臂。
2. **A**：原样连续上传，不门控（＝第三次实测的生产形态，本次实测即 A 臂的真实现读数）。
3. **B**：用**出货的** `createSilenceTailGate` 做门控（在探针内构造，不改任何生产环境变量）。
4. **C**：同一个 gate 只**观察**、记录决策，但**不裁剪**（对齐 `localSpeechGate` 的产品语义）。
5. 每臂读：上传秒数/帧数、静音占比、首 token 延时、首次 `function_call` 延时、转发文本保真（对源语料句数）、丢段数、错误中断数。
6. 成本/时长上限写进脚本参数并实测记录；**先小样本**（excerpt ≤ 90 s，单次）。

## AC

- [ ] AC1 报告含**来源对应表**（`offsetMs → itemId → transcription → session_send`），并显式声明**未使用 CLI transcript 作转发真值**；取假形态：改用 CLI transcript 作转发真值 ⇒ 对应断言红。
- [ ] AC2 三臂跑**同一源音频、同一起点、同一 excerpt 长度**；`npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-vad-three-arm/probe.mts --work /tmp/vad3` 退出 0 并产出 `snapshot.json`。
- [ ] AC3 每臂齐备六项读数：上传秒数/帧数、静音占比、首 token 延时、首次 `function_call` 延时、转发文本保真、丢段数 + 错误中断数。
- [ ] AC4 **C 臂证明"只观察不裁剪"**：其上传帧数与 A 臂**逐帧相等**，同时检测决策被记录；取假形态：让 C 也裁剪 ⇒ AC4 红。
- [ ] AC5 上限生效且实测记录：`--cap`（每连接 CNY）、总上限、excerpt 秒数上限；报告写出**实际花费与时长**，且为小样本（excerpt ≤ 90 s、单次运行）。
- [ ] AC6 未改生产配置、未重启 :3001（pid 前后相同）；除上游本身外零外联。
- [ ] AC7 读数不足时写「不足以判断」，不得把不足写成结论。

## DoD

三臂在同源真实音频上的读数齐备；A 与 C 的对照能把「检测质量」与「模型输入干预」分开；报告给出「服务端 VAD 是否影响上游 PCM 与 `turn_detection`」的实证结论（或明确写出不足以判断），并给出 A/B/C 三臂的实际上传量与模型侧读数差异。

## Touches

- experiments/voice-realtime-vad-three-arm/probe.mts (new)
- docs/operations/voice-realtime-vad-three-arm-probe.md (new)
- tasks/gap-voice-server-vad-three-arm-replay-on-third-test-corpus.md

## Notes

**查重**：AC-362（continuous 校准 C-1..C-6，报告 `docs/operations/voice-realtime-continuous-calibration.md`）只有单次运行的读数、无同源三臂；AC-363（STS 真实探针 V-1..V-8）**已有两臂配对**（V-7「同一语料 STS 与基线两臂」），但语料是脚本内构造、且**没有 C 臂**、也没用本次真实语料；AC-364 是产品实现（开关默认关）。本任务的增量＝**真实语料 + 第三臂 + 静音占比/延迟分解**，**不得**重跑或改写 AC-362/363 的既有报告。

**成本纪律**：沿用既有探针的口径——每连接 `VOICE_REALTIME_MAX_CNY_PER_CONNECTION` 上限、总上限、`--plan` 不连上游。先小样本；本任务**不**追求统计功效，只要求三臂同源可比。