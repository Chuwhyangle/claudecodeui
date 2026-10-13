---
id: gap-voice-vad-detector-defect-red-run-on-continuous-silence-excerpt
title: 红先行：门控在真实录音上零过滤是检测器标定缺陷（非语料无静音）——选含连续无语音的 excerpt 重跑，必须 B
  filteredFrames&gt;0 且 C==A
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**这是对 `gap-voice-server-vad-three-arm-replay-on-third-test-corpus`（已 done）结论的复议。** 那条的 DoD 写「本语料没有给出可裁之处」并把 B==A 归因到语料；**该归因是错的**，人 yale 亲自听完整段录音确认"超过一半时间无语音"。正确归因是**检测器的自适应被一个钳位上限废掉了**。

### 根因（代码级，本轮定位）

`server/modules/voice-realtime/voice-realtime-silence-tail.ts:353-357`：

```js
const floorDb = floor === null ? SILENCE_TAIL_HARD_FLOOR_DB : rmsToDb(floor);
threshold = Math.min(
  SILENCE_TAIL_MAX_THRESHOLD_DB,                                                  // 常量 −60 dBFS
  Math.max(SILENCE_TAIL_HARD_FLOOR_DB, floorDb + SILENCE_TAIL_VOICE_MARGIN_DB),    // max(−70, floor+8)
);
```

阈值**确实自适应**（`底噪 + 8 dB`），但被 `SILENCE_TAIL_MAX_THRESHOLD_DB = −60 dBFS` **硬性封顶**。只要噪声底高于约 **−68 dBFS**（即 `floor+8 > −60`），钳位就生效 ⇒ 阈值**恒等于 −60 dBFS**，自适应完全失效。真实房间底噪普遍在 −50…−60 dBFS，**所以这个上限在实践中几乎总是胜出**。这与 STS 产品任务 `gap-live-voice-silence-tail-suppression` 第 27 行自述的「低阈值、**自适应底噪**、挂起」不一致：能力写了，但被自己的常量废掉。

### 离线实测（本轮，全文件 372.66 s = 18633 × 20 ms 帧）

- RMS dBFS：p5 −63.0 / p10 −61.6 / p25 −59.2 / **p50 −55.7** / p75 −49.6 / p90 −32.0 / max −10.3。
- 低于 −61 dBFS 的帧仅 **13.4%**；**全文件唯一** ≥16 帧（=320 ms 挂起门槛）的连续低能量段是 **235 帧 = 4.70 s，起点 offsetMs 339840（5:39.8）**。
- **实验真正用的首片 90 s**：低于 −61 dBFS 占 6.8%，**最长连续仅 13 帧 = 0.26 s —— 距 16 帧差 3 帧**。⇒ 门控一次未挂起，B 与 A 逐字节相同。

真实静音段里低于下限的帧是零散的：

| 上游判定的非语音段 | 时长 | RMS p50 | < −61 dBFS 占比 | **最长连续 < −61** |
| --- | --- | --- | --- | --- |
| 247196→298250 ms | 51.1 s | −54.5 | 6.8% | **5 帧（0.10 s）** |
| 113840→164715 ms | 50.9 s | −58.1 | 26.1% | **14 帧（0.28 s）**（差 2 帧） |
| 167016→207681 ms | 40.7 s | −58.3 | 22.1% | 10 帧（0.20 s） |
| 53167→92810 ms | 39.6 s | −55.6 | 5.4% | 3 帧（0.06 s） |

**错失的量（首片 90 s，阈值改为相对底噪）**：底噪 p10 = −60.2 dBFS；p10+5 = −55.2 ⇒ 可裁 **44.5%** 帧、最长连续 2.46 s（**挂起可达**）；p10+10 ⇒ 68.6%；p10+12 ⇒ 74.7%。**同一段音频，绝对阈值裁 0，相对阈值裁 45–75%。**

### 红在哪

旧 AC 允许「不足以判断」把 null 结果留下来，也允许把 root cause 记到语料上。本条要求**用明确含连续无语音的 excerpt 跑出 B filteredFrames > 0**——这是旧结论为假、检测器需改进的直接读数。

## Plan

1. 选 excerpt：**必须**明确含连续无语音，且用**出货未改**的 gate 就能让 B 真裁帧。按上文读数，候选是含 339840 ms 那段 4.70 s 的窗口（例如起点 320000 ms、长度 42000 ms）。
2. 同一条探针（`experiments/voice-realtime-vad-three-arm/probe.mts`；缺起点参数则最小新增 `--excerpt-start-ms`）跑真实 A/B/C。
3. 断言：**B filteredFrames > 0**；**C == A**（帧/字节/毫秒逐项相等）；**无语音损失**（未写出音频落在源 speech 区间内的毫秒数 = 0）。
4. 报告门控对**上游模型行为**（转写/转发条数、首 token 与首次 function_call 延时、保真）与**连接**（存活、最长不发送间隔、上游断线/错误）的影响。
5. 报告给出**钳位**作为根因，并列出离线阈值敏感性读数作为改进依据。

## AC

- [x] AC1 **红先行**：`B.filteredFrames > 0`（选定 excerpt 上）。取假形态：把起点移到不含连续无语音的窗口 ⇒ B.filteredFrames == 0 ⇒ AC1 红。
- [x] AC2 `C` 的上传帧/字节/毫秒与 `A` **逐项相等**，且 C 记录决策数 == C 上传帧数。
- [x] AC3 **无语音损失**：各臂未写出的音频落在源 timeline speech 区间内的毫秒数 = **0**。
- [x] AC4 报告给出 `createSilenceTailGate` 在**本次 excerpt** 上的实测读数：`stage` 是否进入挂起、`suppressedTransitions`、`withheldMs`，以及离线噪声底与阈值敏感性（p10+Δ 各档可裁占比与最长连续）。
- [x] AC5 **钳位是根因**：报告指明 `SILENCE_TAIL_MAX_THRESHOLD_DB = −60 dBFS` 在噪声底 > −68 dBFS 时使自适应失效，并给出本录音的底噪实测值；取假形态：把根因写成"语料无静音"或"阈值不自适应"（而不指出钳位）⇒ 红。
- [x] AC6 真实上游 A/B/C 一次运行；预算上限生效并记录（`--cap` 每连接 CNY、总上限、excerpt ≤ 120 s、单次）；写出实际花费与时长。
- [x] AC7 未改生产默认（`VOICE_REALTIME_SILENCE_TAIL` 仍为关）、未重启 :3001（pid 前后相同）；除上游外零外联。
- [x] AC8 服务端 VAD 仍**只过滤无语音 PCM**：无由本地 VAD 驱动的 `response.create` / `input_audio_buffer.commit`；`session.update` 的 `turn_detection` 与出货解析器逐字节一致（沿用既有 AC1 的机械判据）。

## DoD

在**明确含连续无语音**的 excerpt 上，出货、未改的门控真的裁掉了帧（`B.filteredFrames > 0`），同时 C 与 A 逐字节相等、无语音损失；报告以数值与代码位置给出「零过滤是钳位废掉自适应」的根因、更正旧结论，并给出可裁量的敏感性读数；服务端 VAD 的职责边界（只过滤无语音 PCM，不驱动 turn detection / commit / `response.create`）仍成立。

## Touches

- experiments/voice-realtime-vad-three-arm/probe.mts
- docs/operations/voice-realtime-vad-three-arm-probe.md
- docs/operations/voice-realtime-vad-three-arm-probe-run1.md
- server/modules/voice-realtime/voice-realtime-silence-tail.ts
- tasks/gap-voice-vad-detector-defect-red-run-on-continuous-silence-excerpt.md

## Notes

**与旧任务的关系**：`gap-voice-server-vad-three-arm-replay-on-third-test-corpus` 的**交付物与读数有效**（三臂、来源对应表、五条取假形态），本任务**只复议归因与结论**，**不得**删改其报告里的实测读数，只追加更正段。

**未决、需人裁定（本任务不做）**：拆除或抬高 `SILENCE_TAIL_MAX_THRESHOLD_DB` 属于**改变检测器语义**，且 STS 产品任务把「误判静音率 = 0」列为**硬要求**——抬高上限正是在拿这条做交易。因此本任务**只给读数与根因**，是否改、怎么改（更稳的相对判据 / 频域特征 / 带迟滞的滑动底噪），由人裁定后另立任务。

**预算与安全**：只做离线分析与有预算上限的实验；`--plan` 不连上游；不改生产默认值；不重启服务。