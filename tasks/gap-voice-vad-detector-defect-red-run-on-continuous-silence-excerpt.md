---
id: gap-voice-vad-detector-defect-red-run-on-continuous-silence-excerpt
title: 红先行：门控在真实录音上零过滤是检测器标定缺陷（非语料无静音）——选含连续无语音的 excerpt 重跑，必须 B
  filteredFrames&gt;0 且 C==A
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**这是对 `gap-voice-server-vad-three-arm-replay-on-third-test-corpus`（已 done）结论的复议。** 那条的 DoD 写「本语料没有给出可裁之处」并把 B==A 归因到语料；**该归因是错的**，人 yale 亲自听完整段录音确认"超过一半时间无语音"，离线分析也证实。正确归因是**检测器标定缺陷**。

**离线实测（本轮，全文件 372.66 s = 18633 × 20 ms 帧）**：

- RMS dBFS 分布：p5 −63.0 / p10 −61.6 / p25 −59.2 / **p50 −55.7** / p75 −49.6 / p90 −32.0 / max −10.3。
- 低于 −61 dBFS 的帧仅 **13.4%**；**全文件唯一** ≥16 帧（=320 ms，挂起所需）的连续低能量段是 **235 帧 = 4.70 s，起点 offsetMs 339840（5:39.8）**。
- **实验真正用的首片 90 s**：低于 −61 dBFS 占 6.8%，**最长连续仅 13 帧 = 0.26 s —— 距挂起所需的 16 帧差 3 帧**。所以门控一次都没进入挂起，B 与 A 逐字节相同。

**判读**：门控的绝对人声下限 −61 dBFS 只比这段录音的静音电平（各静音段 p50 约 −54…−58 dBFS）低 ~5 dB，于是"耳朵里的静音"在门控眼里大量仍是"有声"；更致命的是挂起要求**连续** 320 ms 低于下限，而真实静音段里低于下限的帧是零散的：

| 上游判定的非语音段 | 时长 | RMS p50 | < −61 dBFS 占比 | **最长连续 < −61** |
| --- | --- | --- | --- | --- |
| 247196→298250 ms | 51.1 s | −54.5 | 6.8% | **5 帧（0.10 s）** |
| 113840→164715 ms | 50.9 s | −58.1 | 26.1% | **14 帧（0.28 s）**（差 2 帧） |
| 167016→207681 ms | 40.7 s | −58.3 | 22.1% | 10 帧（0.20 s） |
| 53167→92810 ms | 39.6 s | −55.6 | 5.4% | 3 帧（0.06 s） |

**错失的量（首片 90 s，若阈值改为相对本连接噪声底）**：噪声底 p10 = −60.2 dBFS；阈值 p10+5 = −55.2 dBFS ⇒ 可裁 **44.5%** 帧、最长连续 2.46 s（**挂起可达**）；p10+10 ⇒ 68.6%；p10+12 ⇒ 74.7%。**同一段音频，绝对阈值裁 0，相对阈值裁 45–75%。**

**红在哪**：旧 AC 允许「不足以判断」把 null 结果留下来，且允许把 root cause 记到语料上。本条要求**用一个明确含连续无语音的 excerpt 跑出 B filteredFrames > 0**——这是旧结论为假、检测器需改进的直接读数。

## Plan

1. 选 excerpt：**必须**明确含连续无语音，且用**出货未改**的 gate 就能让 B 真的裁掉帧。按上文读数，候选是含 339840 ms 那段 4.70 s 的窗口（例如起点 320000 ms、长度 42000 ms，含该段与其前后的语音）。
2. 用**同一条**探针（`experiments/voice-realtime-vad-three-arm/probe.mts`，`--excerpt-ms/--excerpt-start-ms` 若尚无起点参数则最小新增）跑真实 A/B/C。
3. 断言：**B filteredFrames > 0**；**C == A**（帧/字节/毫秒逐项相等）；**无语音损失**（未写出音频落在源 speech 区间内的毫秒数 = 0）。
4. 报告门控对**上游模型行为**（转写/转发条数、首 token 与首次 function_call 延时、保真）与**连接**（存活、最长不发送间隔、是否有上游断线/错误）的影响。
5. 离线产出噪声底与阈值敏感性读数（已有），写进报告作为改进依据。

## AC

- [ ] AC1 **红先行**：`B.filteredFrames > 0`（本次选定的 excerpt 上）。取假形态：把 excerpt 起点移到不含连续无语音的窗口 ⇒ B.filteredFrames == 0 ⇒ AC1 红。
- [ ] AC2 `C` 的上传帧/字节/毫秒与 `A` **逐项相等**，且 C 记录决策数 == C 上传帧数（只观察不裁剪）。
- [ ] AC3 **无语音损失**：各臂未写出的音频落在源 timeline speech 区间内的毫秒数 = **0**。
- [ ] AC4 报告给出 `createSilenceTailGate` 在**本次 excerpt** 上的实测读数：`stage` 是否进入挂起、`suppressedTransitions`、`withheldMs`、以及离线噪声底/阈值敏感性（p10+Δ 各档可裁占比与最长连续）。
- [ ] AC5 真实上游 A/B/C 一次运行；预算上限生效并记录（`--cap` 每连接 CNY、总上限、excerpt ≤ 120 s、单次）；写出实际花费与时长。
- [ ] AC6 未改生产默认（`VOICE_REALTIME_SILENCE_TAIL` 仍为关）、未重启 :3001（pid 前后相同）；除上游外零外联。
- [ ] AC7 报告显式更正旧结论：B==A 的成因是**检测器标定**而非"语料无可裁之处"，并给出上文数值；取假形态：把成因写成"语料无静音" ⇒ 红。
- [ ] AC8 服务端 VAD 仍**只过滤无语音 PCM**：帧型里无 `response.create`/`input_audio_buffer.commit` 由本地 VAD 驱动，`session.update` 的 `turn_detection` 与出货解析器逐字节一致（沿用既有 AC1 的机械判据）。

## DoD

在**明确含连续无语音**的 excerpt 上，出货、未改的门控真的裁掉了帧（`B.filteredFrames > 0`），同时 C 与 A 逐字节相等、无语音损失；报告用数值给出「零过滤是检测器标定缺陷」的根因与可裁量的敏感性读数，并显式更正旧结论；服务端 VAD 的职责边界（只过滤无语音 PCM，不驱动 turn detection / commit / `response.create`）仍成立。

## Touches

- experiments/voice-realtime-vad-three-arm/probe.mts
- docs/operations/voice-realtime-vad-three-arm-probe.md
- tasks/gap-voice-vad-detector-defect-red-run-on-continuous-silence-excerpt.md

## Notes

**与旧任务的关系**：`gap-voice-server-vad-three-arm-replay-on-third-test-corpus` 的**交付物与读数有效**（三臂、来源对应表、五条取假形态），本任务**只复议其归因与结论**，**不得**删改其报告里的实测读数，只追加更正段。

**未决、需人裁定（本任务不做）**：把绝对下限（−61 dBFS）改成**相对本连接噪声底的自适应阈值**属于**改变检测器语义**，超出本任务授权；本任务只给读数与依据。是否改，由人裁定后另立任务。

**预算与安全**：只做离线分析与有预算上限的实验；`--plan` 不连上游；不改生产默认值；不重启服务。