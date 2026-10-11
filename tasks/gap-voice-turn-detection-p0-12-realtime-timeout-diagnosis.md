---
id: gap-voice-turn-detection-p0-12-realtime-timeout-diagnosis
title: Live Voice P0.12：P0.7 Qwen Realtime 超时/14s 异常归因诊断——全事件仪表化 + 本地 loopback
  校验 + 2-4 对真实网络 paired replay
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

### 现状（2026-10-11 本会话直接读 develop 上 P0.7 的 `experiments/voice-turn-detection-compare/RESULT.json` 核实）

`gap-voice-turn-detection-p0-7-unified-realtime-benchmark`（done）的 `unifiedReplay.qwenStreaming` 有 24 个真实会话（12 span × 400/800ms），11 个 `timeout`，另有 1 个 `ok` 但端点等待 14012ms 的异常（`zh-d01-o85#0@400`：`onsetAudioMs=4000`，`speechStartsRelMs=[2578]`，`speechStopsRelMs=[18012]`，`committedRelMs=[18013]`，`wallClockMs=18773`）。P0.9 依据 P0.7 自记的 `attribution` 把 11 个 timeout 分为 2 个测量假阴性（`librispeech-000#0@400/@800`）+ 9 个上游污染。

**这个归因的证据缺口**（直接读 artifact 得到，不是推测）：
1. `predictions[].events` 只记录了 `direction:"received"` 的事件（session.created/updated、speech_started/stopped、committed、transcription delta/completed、conversation.item.created），**没有任何 `sent` 事件**——音频 append 的起止时刻、发送节奏、字节数都没记；**也没有 WS open/error/close 及 close code**。因此"服务端迟迟不发 speech_stopped"无法与"本地发送方节奏慢/卡顿""网络缓冲""连接异常关闭"区分开。
2. 24 个会话的 `usage` 全部为 `null`（`create_response:false` 下没有 `response.done`），`ledger.cumulativeNewSpendCny=0` 只是"没拿到用量"，**不能证明免费**；P0.7 那一轮的真实花费是**未知**。
3. P0.7 测试时主机网络存在异常；人 yale 2026-10-11 确认网络已恢复，授权按需小规模重试。

### 方案

1. **全事件仪表化**：在本任务自己的诊断脚本里（复用 P0.10 `closing-safety-b0-b4/t-safe-probe.mts` 已验证的"直连 `createDashscopeTransport` + 自有 observer"做法，不改共用 adapter），对每个会话记录：WS open（含握手耗时）、error、close（含 code/reason）；每个外发帧（`session.update`、每次 `input_audio_buffer.append` 的时刻与字节数，记录首帧/末帧时刻与实际发送节奏 vs 音频时长）；全部接收事件；harness 的 deadline 计算值与触发时刻；归属判定（哪个 speech_stopped 被归给哪个候选点、被拒原因）。
2. **本地 loopback WS 校验 harness（零成本，付费前必须先过）**：起一个本地假 WS 服务器，按脚本在已知时刻发 speech_started/stopped/committed、延迟发送、提前关闭（带 close code）、不发任何事件等场景；用同一诊断脚本连它，断言：时间戳记录正确、deadline/归属判定与已知真值一致、"连接异常关闭""上游无事件""到达但被归属窗口拒绝"三种情况被分到不同类别。loopback 不过则不得进行付费运行。
3. **真实网络 paired replay（小额付费）**：选 2–4 个此前出问题的真实 (sample, level) 配置，优先：`zh-d01-o85#0@400`（14s 异常）、`librispeech-002#0@800`（零事件 stall）、`librispeech-003#0@400` 或 `librispeech-005#0@400`（事件迟到）、`librispeech-000#0@400`（测量假阴性，作对照）；每个配置用**与 P0.7 完全相同的音频文件（校验 sha256）与 session 参数**（server_vad、`silence_duration_ms`、`create_response:false` 等，从 P0.7 artifact 读取而不是重新手填）重跑，每配置至少 2 次以看可重复性。付费总上限 ¥0.05，执行前写入 artifact。
4. **用量与花费**：尽力取得真实用量（若 `create_response:false` 下服务端不返回 usage，则另记音频秒数与按公开单价算出的**上界估计**并标注"估计"）；拿不到真实用量时，花费字段必须标 `unknown`，不得记 0。
5. **并排报告**：原 P0.7 读数 vs 复测读数并排：timeout 数、false cutoff、missed END、端点等待 p50/p90/max，每项带分母与 Wilson 95% 区间；**timeout 单独分类**为 {网络/WS 故障、上游未发事件、事件迟到超过 deadline、到达但归属窗口拒绝（harness 判定）}，网络/WS 故障**不计入**模型漏端点。每个 P0.7 超时会话给出"复测后归因 + 证据（具体事件/时间戳/close code）"或明确写"证据缺失、无法归因"，不得猜测。

### 边界 / 不做

- ⛔ 只动 `experiments/` 与 `docs/`；不改生产 Live Voice 链路：`git diff develop -- server/modules/voice-realtime/voice-realtime-bridge.service.ts server/modules/voice-realtime/voice-realtime-dashscope-transport.ts src/modules/chat/voice-realtime/` 必须为空。
- ⛔ 不修改 P0.7/P0.9/P0.10 已落地的 artifact；不触碰 `gap-voice-turn-detection-p0-11-finegrained-pareto-sweep` 的 worktree 或 `finegrained-sweep/` 目录。
- ⛔ 不改共用的 `eot-bench-adapters/qwen-realtime-streaming-adapter.mts`；本任务的仪表化在自己的新脚本里。
- ⛔ 不跑 `scripts/voice-turn-detection-compare.mjs --replay … --all`（会重跑旧 harness 与付费探针）；只运行本任务自己的诊断脚本。
- ⛔ 新增付费上限 ¥0.05；loopback 校验通过前不得发起任何付费连接；拿不到用量即标 unknown。
- ⛔ 本测量是上游 `server_vad` 自动端点（P0.x 的 realtime arm），**不是**生产分段中继（`turn_detection:null` + 浏览器 VAD）；结论不得外推为生产链路质量。
- ⛔ 长跑命令显式传 timeout（后台 Bash 默认 10 分钟会被杀；只在末尾写 artifact 的脚本被杀即零产物）。

## Plan

1. 写诊断脚本 `realtime-timeout-diagnosis/diagnose.mts`：直连 transport + 全事件记录（WS 生命周期、外发帧、接收事件、deadline、归属判定），产出逐会话 JSONL 原始日志。
2. 写 `realtime-timeout-diagnosis/loopback-ws.mts` 假服务器与 `loopback.test.mts`：覆盖正常、迟到、零事件、异常关闭、归属窗口外五类场景，断言分类正确；跑通后记录结果。
3. 从 P0.7 artifact 读出所选配置的音频路径/sha256/session 参数，写死预算 ¥0.05，跑真实 paired replay（2–4 配置 × ≥2 次）。
4. 汇总 `RESULT.json` + `CONCLUSION.md`：并排表、Wilson 区间、timeout 分类、逐会话归因证据与缺失证据清单、花费（真实/估计/unknown）。

## AC

- [x] AC1 loopback 校验：`node_modules/.bin/tsx experiments/voice-turn-detection-compare/realtime-timeout-diagnosis/loopback.test.mts` 退出 0，覆盖正常/迟到/零事件/异常关闭（含 close code）/归属窗口外五类场景且各自分类正确；付费运行发生在 loopback 通过之后（artifact 记录两者时间戳可证）。
- [x] AC2 全事件日志：每个真实会话的原始日志含 WS open/error/close（code/reason）、外发 `session.update` 与每个 `input_audio_buffer.append` 的时刻与字节数（含首末帧与实际发送速率）、全部接收事件、deadline 与归属判定记录。
- [x] AC3 paired replay：2–4 个此前出问题的真实配置（优先列表见方案 3），音频 sha256 与 session 参数与 P0.7 一致（从 P0.7 artifact 读取并校验），每配置 ≥2 次。
- [x] AC4 预算与用量：执行前写入上限 ¥0.05；花费字段为真实用量、或标注"估计"的上界、或 `unknown`，不得以 0 代替未知；超限即中止并记录。
- [x] AC5 并排报告：原 P0.7 vs 复测的 timeout / false cutoff / missed END / 端点等待 p50/p90/max，带分母与 Wilson 95% 区间；timeout 按 {网络/WS 故障、上游未发事件、迟到超 deadline、归属窗口拒绝} 单独分类，网络故障不计入漏端点。
- [x] AC6 归因证据：P0.7 的 11 个 timeout 与 14s 异常逐个给出"复测后归因 + 具体证据（事件/时间戳/close code）"或"证据缺失、无法归因"及缺哪类日志；不得无证据推断。
- [x] AC7 范围：`git diff develop` 对三个生产路径为空；未修改共用 adapter、P0.7/P0.9/P0.10 artifact、P0.11 目录。
- [x] AC8 静态门：`npm run typecheck` 退出 0；若新增 server/** 测试文件，同步 `server/shared/tests/quay-test-script.test.ts` 文件数钉子与耗时基线。

## DoD

真实落地判据：至少一次真实 DashScope Realtime 网络会话产出含外发帧与 WS 生命周期的完整原始日志，且 loopback 校验先于它通过；P0.7 每个异常会话都有"有证据的归因"或"明确的证据缺失说明"；花费如实（真实/估计/unknown）。单测通过是必要不充分。

## Touches

- experiments/voice-turn-detection-compare/realtime-timeout-diagnosis/diagnose.mts (new)
- experiments/voice-turn-detection-compare/realtime-timeout-diagnosis/loopback-ws.mts (new)
- experiments/voice-turn-detection-compare/realtime-timeout-diagnosis/loopback.test.mts (new)
- experiments/voice-turn-detection-compare/realtime-timeout-diagnosis/sessions.jsonl (new)
- experiments/voice-turn-detection-compare/realtime-timeout-diagnosis/RESULT.json (new)
- experiments/voice-turn-detection-compare/realtime-timeout-diagnosis/CONCLUSION.md (new)
- tasks/gap-voice-turn-detection-p0-12-realtime-timeout-diagnosis.md
