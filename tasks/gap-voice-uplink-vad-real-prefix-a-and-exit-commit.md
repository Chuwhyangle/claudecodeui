---
id: gap-voice-uplink-vad-real-prefix-a-and-exit-commit
title: 上行 VAD 改版实现：非语音段保留开头 a 的真实音频（段首段丢弃）、退出路径
  commit+response.create，deterministic 测试 + 真实 Realtime 复验
status: ready
labels:
  - gap
parent: null
children: []
extra: {}
depends_on:
  - gap-voice-uplink-vad-scheme-doc
---
## Proposal

把定稿方案（`docs/operations/voice-realtime-uplink-vad-scheme.md`）的第 5 节与第 6 节**实现并复验**。范围**刻意收窄**：只改实验侧的下行投喂实现，不碰生产默认值、不接线到服务端 continuous 路径。

**要实现的三件事**：

1. **非语音段保留开头 a 的真实音频**（取代现有的合成零样本补发）：后置滤波后每个非语音段的开头 `a` 毫秒原样转发真实样本，其余丢弃；`a` 由**解析后的** `turn_detection.silence_duration_ms` + 1 帧导出（不得写死）；**不合成任何样本**。
2. **段首段整段丢弃**：流开头、任何语音帧之前的非语音段不保留 —— 上游此时没有待闭合的东西。这是相对已验证变体的**刻意偏离**，必须单独复验。
3. **退出路径**：由**用户动作**（模拟退出）触发一次 `input_audio_buffer.commit` + `response.create`，随后有界等待 `input_audio_buffer.committed` / 转写 / 转发再关闭 socket。**这是「不发 response.create」的唯一有界例外**，作用域仅限退出；正常流的发送决策仍完全由「掩码 + 保留窗」决定，⛔ 不得由上游 VAD 边界事件触发任何提交。

**现状（已落地的旧形态）**：`experiments/voice-realtime-vad-three-arm/probe.mts` 的 `--vad-filtered` 目前用 `Buffer.alloc` 造**全零样本**补发，且**退出时不发任何帧**（`ws.close()` 收场）。

**查重**：`gap-voice-three-vad-filtered-pcm-real-upstream-replay`（done）是旧形态的实测，其读数保持有效但设计已被取代；本任务不复跑离线五方案对比、不复跑 STS 三臂回放。已确认没有其它非 done 任务承载这件事。

## Plan

1. 把门控逻辑从 290 KB 的 `probe.mts` 里抽成可单测的小模块 `uplinkVadGate.mts`：输入 = 逐帧掩码 + `aFrames` + 是否已见过语音；输出 = 每帧的动作（`send-real` / `drop` / `send-head-kept`）。纯函数、无 IO。
2. 按方案实现三条规则，并把 `a` 的导出接到**出货解析器**给出的 `silence_duration_ms`（不写死）。
3. deterministic 测试：段首段丢弃、每段只保留开头 a 且样本**逐字节等于原流**（非零样本）、`a` 跟随非默认 `silence_duration_ms`（假形态：写死 400 ⇒ 红）、短于 a 的段整段保留。
4. 退出路径：在 `--vad-filtered` 的收尾改为 `commit` + `response.create` → 有界等待 → 关闭；断言顺序，并断言退出后末句仍被转写/转发。
5. 真实 Realtime 复验：Silero 单臂 × 2 次重复（先验证规则成立），通过后再四臂 × 1 次；`a` 取解析值 + 1 帧。
6. 读数写进 `docs/operations/voice-vad-filtered-pcm-upstream-replay.md` 的新一节，并标注它取代该报告头部的合成零样本形态。
7. 经 Provider ABI 逐条勾选后退出，由 worker-driver 机械 fan-in 落地。

## AC

- [ ] AC1 `experiments/voice-realtime-vad-three-arm/uplinkVadGate.mts` 存在，导出纯函数式门控；**不含任何 `Buffer.alloc` 造的零样本**。假形态：`grep -c "Buffer.alloc" <模块>` > 0 且用途是造补发样本 ⇒ 红。
- [ ] AC2 deterministic 测试 `npx tsx --tsconfig server/tsconfig.json --test experiments/voice-realtime-vad-three-arm/uplinkVadGate.test.mts` 退出 0，且至少覆盖四条：段首段整段丢弃；非语音段保留开头 a；被保留的样本**逐字节等于原流对应位置**（证明不是合成）；短于 a 的段整段保留。逐条给出测试名与断言文本。
- [ ] AC3 假形态（`a` 的导出）：把解析出的 `silence_duration_ms` 设为非默认值（如 800），断言保留窗随之变化；硬编码 400 的实现 ⇒ 该用例必须红。`## Evidence` 写出「写死版」确实读红的证据（把实现临时改成写死后该用例红，再改回）。
- [ ] AC4 退出路径：实测日志显示顺序为 `input_audio_buffer.commit` → `response.create` → 等待 → 关闭；且退出后末句仍出现在 `transcription.completed` 中。假形态：把收尾改回直接 `ws.close()` ⇒ 该断言红。
- [ ] AC5 ⛔ 正常流的发送决策**不得**由上游 VAD 边界事件驱动：`## Evidence` 给出该模块与探针里 `speech_started`/`speech_stopped`/`committed` 的全部引用点，并逐点说明它们只被读作读数、不进入任何发送分支。
- [ ] AC6 真实 Realtime 复验：Silero 单臂 × 2 次先行；通过后四臂 × 1 次。每臂给出上行帧/字节（含被保留的段首字节）、transcribed 条数、forwarded 条数与文本、首 `function_call` 延时、上游错误数、最长无发送间隔、花费。
- [ ] AC7 费用上限：单次连接 ≤ ¥0.05、本任务总计 ≤ ¥0.15；写出实际花费。时长上限：单次运行 ≤ 8 分钟。
- [ ] AC8 生产默认值零改动：`git diff --name-only <fan-in 基线>..HEAD` 不含 `server/**` 与 `src/**`；`VOICE_REALTIME_SILENCE_TAIL` 仍为关。
- [ ] AC9 不重启服务：运行前后 :3001 pid 相同，`## Evidence` 写出前后 pid。
- [ ] AC10 与旧形态的对照：同一窗口下给出「旧（合成零样本，已实测）」与「新（真实开头 a）」的上行字节与转写条数对照；若新形态**更差**必须如实写出并停下，不得只报好的。

## DoD

门控实现按定稿方案成立：真实音频、段首段丢弃、`a` 由解析值导出、退出由用户动作触发 commit+response.create；deterministic 测试可跑且假形态可红；真实 Realtime 上复验通过并留下可复算读数；生产默认值与线上服务未被触碰。

## Touches

- experiments/voice-realtime-vad-three-arm/probe.mts
- experiments/voice-realtime-vad-three-arm/uplinkVadGate.mts (new)
- experiments/voice-realtime-vad-three-arm/uplinkVadGate.test.mts (new)
- docs/operations/voice-vad-filtered-pcm-upstream-replay.md
- tasks/gap-voice-uplink-vad-real-prefix-a-and-exit-commit.md

## Notes

**依赖**：本任务的实现依据是 `gap-voice-uplink-vad-scheme-doc` 落地的方案文档（`depends_on` 已设该边）。

**边界**：只改实验侧。服务端 continuous 路径的接线（`sendAudioFrame` 上的门控、默认关闭的开关）**不在本任务**，需另立任务。

**不做**：不重跑离线五方案对比；不重跑 STS 三臂回放；不改任何出货默认值。