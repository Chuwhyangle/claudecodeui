---
id: gap-voice-coalesce-window-1s-from-journal-replay
title: 语音合并窗口 2.5 s → 1.0 s：按 journal 离线回放定值（窗口已是事件驱动，只改静默时长）
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**问题（2026-10-14 实测 journal `d4c9bfc4`）**：从人说完到消息投递约 3.3–3.6 s，其中合并窗口 `VOICE_REALTIME_COALESCE_MS = 2_500`（`server/index.ts:499`）占 2.5 s，会话空闲时也照等；模型本身只用 0.2–0.6 s。

**已排除的替代路**：靠 CLI 原生「快速追发合并」（`turn_preempted`/`rapid_followup`）去掉窗口——真二进制 2.1.296 实测不可用：需 initialize 带 `rapidFollowupPreempt`、追发 `priority:"next"`，且受服务端开关 `tengu_zippy_spindle` 控制（默认关、本账号未放量、本地覆盖入口是空壳）。探针与日志在 `/tmp/cli-preempt-probe/`。

**关键读数：窗口已经是事件驱动的**。`armCoalesce` 挂在被接受的转发片段与字幕处理器上（`voice-realtime-ws-proxy.service.ts` 约 2720、2922、3611 行），说话中的中间字幕也会重新计时；所以 busy-preemption 提案 §4.2 担心的「从首片段起固定 2500 ms」并不存在，要改的只是**静默时长**。

**离线回放**（脚本 `/data/home/yale/work/voice-window-sim/sim.py`，模型：窗口在被接受的片段打开、说话期间保持、最后一个{片段, 最终字幕, speech_stopped}之后 W 秒 flush，interrupt 立即 flush）：
- 校准：6 份 continuous journal（≥ 10-12：`99df08d8 af5559c0 7cddaa59 45c8ee08 b5d01c21 d4c9bfc4`）在 W=2.5 s 下复现实际 flush **54/56**（误差 ≤ 0.15 s）。
- 扫描（76 个片段）：W=2.5 → 54 次投递；1.5 → 57；**1.0 → 60**；0.8 → 65；0.5 → 67。
- W=1.0 比现状多拆 6 次，逐条看过：多数是间隔 2.5–7.7 s 的两句完整话，拆开无害；只有一处「……包括识别延迟，然后……」半句被拆。0.8 s 以下拆分明显增多。

**修法**：常量改 `1_000`；同步改写三处仍写着旧时长的注释（`voice-realtime-ws-proxy.service.ts` 约 1948、2577 行，`useVoiceRealtimeSession.ts` 约 285 行）；把回放脚本收进仓库 `experiments/voice-coalesce-window-sim/sim.py`（从上面路径原样复制），以后每次实测都能复跑。

<!-- dedup-ref -->
合并候选检查：none found。与 `gap-voice-queue-row-stuck-idle-subscribe-audience-reconcile` 同碰 `voice-realtime-ws-proxy.service.ts`、`useVoiceRealtimeSession.ts`，但本任务只动注释与一个常量，机制与验收独立，按人的安排单独立案；调度器会按 Touches 串行。

## AC

- [ ] AC1 `grep -c "const VOICE_REALTIME_COALESCE_MS = 1_000;" server/index.ts` 输出 1。
- [ ] AC2 `grep -nE "2\.5 s window|window is 2\.5 s|in a 2\.5 s window" server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts` 退出 1（无匹配）。改写后的注释不得再出现这串旧时长字面量（含解释为何删掉它的句子）。
- [ ] AC3 `python3 -I experiments/voice-coalesce-window-sim/sim.py --calibrate` 跑上述 6 份 journal（`~/.cloudcli/voice-realtime-log/<id>-*.jsonl`）输出 `CALIBRATION matched=54/56`；`--sweep` 输出中 `W=1.0s deliveries=60`。两段输出原样写入本任务「验证读数」。
- [ ] AC4 合并窗口回归面逐文件单跑、各自退出 0：`npx tsx --tsconfig server/tsconfig.json --test` 分别跑 `server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts`、`voice-realtime-delivery-boundary.test.ts`、`voice-realtime-bounded-queue.test.ts`、`voice-realtime-interrupt.test.ts`、`voice-realtime-continuous-empty-guard-span.test.ts`（均在 `server/modules/voice-realtime/tests/` 下）。
- [ ] AC5 `npm run typecheck` 退出 0。

## DoD

真实 Live Voice 会话中，从人说完到消息投递的等待缩短约 1.5 s（合并窗口从 2.5 s 降为 1.0 s，说话期间仍保持打开，同一口气的话仍合成一条）；回放脚本在仓库里，任何一次新实测的 journal 都能复跑校准与扫描。

## Touches

- server/index.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- experiments/voice-coalesce-window-sim/sim.py
- server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts
- tasks/gap-voice-coalesce-window-1s-from-journal-replay.md
