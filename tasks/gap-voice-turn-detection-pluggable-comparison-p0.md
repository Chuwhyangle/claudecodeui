---
id: gap-voice-turn-detection-pluggable-comparison-p0
title: 低成本 Turn Detection 可插拔对照 P0：Pipecat Smart Turn v3.2 / LiveKit Turn
  Detector v1-mini / Qwen Realtime 四组harness + 非实时 qwen3.8-omni-flash 音频原生可行性探针
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

### 现状

GOAL-034（分段中继，已 shipped）解决了 Live Voice 的成本结构问题，但没有回答「换一个更便宜的轮次检测器能否逼近 Qwen Realtime 的断句能力」。已 ready 的 `gap-voice-realtime-turn-detection-configurable-comparison` 只调 Qwen Realtime 自身的 `silence_duration_ms`/`semantic_vad`，不涉及第三方音频原生检测器（Pipecat Smart Turn、LiveKit Turn Detector）、不涉及非实时 `qwen3.8-omni-flash`（非 `-realtime`）的音频原生函调可行性、也不涉及 utterance_end 与 action_commit 分离的状态机设计。本任务是全新研究范围，去重确认无重叠任务（本 agent 已再次核实）。

### 去重结论

<!-- dedup-ref --> 与 `gap-voice-realtime-turn-detection-configurable-comparison`（status: done，机检索核实，2026-10-11）不重叠：该任务只测 Qwen Realtime 自身参数（`server_vad@400`/`@800`/`semantic_vad`）；本任务测的是**换一个检测器**（本地 Pipecat/LiveKit 模型）以及**换一个非实时音频原生模型**，并把前者的 RESULT.json 作为本任务「组 D」的既有证据引用，不重复花钱。本 agent 另行机检索 "Smart Turn" / "LiveKit" / "Pipecat" / "轮次检测" 均无命中，确认无既有任务覆盖本任务范围。

### 方案

完整设计见新 SPEC `docs/proposals/voice-turn-detection-pluggable-comparison-SPEC.md`（本次会话已撰写，含已在线核实的 Pipecat Smart Turn v3.2 / LiveKit Turn Detector v1-mini 的许可证、架构、CPU 推理、语言覆盖事实及来源链接）。概要：

1. 四组对照（A VAD固定静音 / B VAD+Smart Turn v3.2 / C VAD+LiveKit v1-mini / D 既有 Qwen Realtime 结果) + 一个可选 baseline（E VAD+ASR转写+轻量文本端点，仅作参照，不得替代音频原生评估）。
2. 标注样本 manifest（复用 `experiments/voice-trim/fixtures/` 等既有 fixture；新场景——中英代码术语混合、句中停顿、自我纠正、执行期间继续说话——若无法合规获取真实人声，须用明确标注 `synthetic:true` 的合成样本或如实报告样本不足，不得编造 100-200 条）。
3. 统一读数口径：误截断率、漏端点率、端点判定延迟 p50/p90、CPU/RAM、误触发 Action 数、额外模型成本。
4. 非实时 `qwen3.8-omni-flash` 音频原生函调可行性探针，与 Realtime 路径同音频同上下文并列对照，真实付费调用预算上限 ¥0.02（执行前必须先在 artifact 里写死这个上限，超支即中止）。
5. 可配置状态机**设计**（P0 阶段只写设计章节，不接线、不改运行时）：IDLE→TURN_PENDING→COMMIT_GRACE（容许自我纠正）→ACTION_COMMIT，含 turnVersion 版本化防竞态、投机推理启动/取消分析、复用既有 UpstreamPool 重连幂等机制、兼容现有紧凑 UI（不新增视觉态）。
6. Go/No-Go 判据在 SPEC 内已写死（执行前定，不得事后调整），例如：组B/C 误截断率相对组A降低≥30%才算「逼近」，端点延迟p90≤150ms，CPU增量≤10%，样本<20条须显式标「初步/方向性」。

### 边界 / 不做

- ⛔ 不接入运行时、不改默认 Live Voice 生产链路（`voice-realtime-bridge.service.ts`、`voice-realtime-dashscope-transport.ts` 等既有生产文件本任务零改动，diff against develop 必须为空）。
- ⛔ 不重跑 `gap-voice-realtime-turn-detection-configurable-comparison` 已覆盖的 Qwen Realtime 参数对照，只引用其 RESULT.json。
- ⛔ 不把 ASR+文本端点（组E）的结果包装成「音频原生」证据。
- ⛔ 不在无权条款核实前假设 LiveKit Model License 允许任意用途；若受阻，组C如实标 `blocked-by-license` 或 `deferred-spec-unclear`，不绕过许可证。
- ⛔ 非实时 qwen 探针的真实花费严格 ≤ ¥0.02，超支即中止并记录，不得分摊更多次重试。

## Plan

1. 建 `experiments/voice-turn-detection-compare/`：`manifest.json`（标注样本 + 真值 END/CONTINUE）、`fixtures/`（复用+新增）、`adapters/`（组A复用现有 `src/shared/voiceEndpoint.ts` 的 StreamingVad；组B 封装 Pipecat Smart Turn v3.2 ONNX 本地推理；组C 尝试封装 LiveKit v1-mini，若许可证/输入规格受阻则记录阻塞）、`run.mts`（统一跑四组+可选E并产出读数）、`RESULT.json`。
2. 组D：读取（若已存在）`experiments/voice-realtime-turn-detection/RESULT.json`；不存在则标 `pending-upstream-task`。
3. 非实时 qwen 可行性探针脚本（独立于上面的 harness，真实一次调用，预算守卫内置）。
4. 把状态机设计章节写入 SPEC（已完成初稿，执行时按实测结果校订开放问题）。
5. 汇总 Go/No-Go 表，产出报告。

## AC

- [x] AC1 标注样本 manifest 存在，每条样本的候选静音点有人工真值 END/CONTINUE 标注；若总样本 < 20 条，`RESULT.json` 顶层字段 `sampleSizeCaveat` 必须为真并给出原因。
- [x] AC2 组A（现有StreamingVad）与组B（Smart Turn v3.2，真实本地 CPU 推理，非估算)在同一 manifest 上产出误截断率/漏端点率/延迟p50p90/CPU 占用，数字写入 `RESULT.json`。
- [x] AC3 组C（LiveKit v1-mini）尝试同样测量；若许可证条款或输入规格在 P0 内无法确认，`RESULT.json` 对应字段显式为 `blocked-by-license` 或 `deferred-spec-unclear` 并写明已读到的许可证/源码出处，不得静默跳过也不得编造数字。
- [x] AC4 组D 读取既有 `gap-voice-realtime-turn-detection-configurable-comparison` 的 RESULT.json（若存在）或标记 `pending-upstream-task`（若不存在），不重复花钱重跑。
- [x] AC5 非实时 `qwen3.8-omni-flash` 音频原生函调可行性探针：真实付费调用 ≤ ¥0.02（`RESULT.json` 记录实际花费数字），输出是否出现 function_call 的判定（supported/unsupported），与同段音频 Realtime 路径的 usage 并列。
- [x] AC6 SPEC 的 Go/No-Go 判据表全部由本任务的实测数字填入（不得先写结论再找数字），样本不足的判据显式标注局限。
- [x] AC7 状态机设计章节内部一致：commit grace window、turnVersion 版本化、投机推理取消、复用既有 UpstreamPool 重连幂等、不新增 UI 视觉态，均在 SPEC 文本中有对应段落。
- [x] AC8 生产面零改动：`git diff develop -- server/modules/voice-realtime/voice-realtime-bridge.service.ts server/modules/voice-realtime/voice-realtime-dashscope-transport.ts src/modules/chat/voice-realtime/` 输出为空。
- [x] AC9 静态门：`npm run typecheck` 退出0；若新增 server/** 测试文件，同步 `server/shared/tests/quay-test-script.test.ts` 的文件数钉子与 `scripts/suite-duration-baseline.tsv`。

## DoD

Smart Turn v3.2 的 CPU 延迟/误截断率数字必须来自本任务真实跑的本地 ONNX 推理（不是抄第三方 benchmark）；LiveKit v1-mini 的结论必须基于本任务真实读到的许可证文本/源码（不是猜测）；非实时 qwen 探针必须是一次真实付费调用、响应原文存入 artifact；Go/No-Go 判据表的每一格要么是真实数字要么是显式局限说明，不得留空也不得虚构。本任务零改动生产默认 Live Voice 链路。

## Touches

- docs/proposals/voice-turn-detection-pluggable-comparison-SPEC.md (已由本次会话创建，非 new)
- experiments/voice-turn-detection-compare/manifest.json (new)
- experiments/voice-turn-detection-compare/adapters/smart-turn-v3.mts (new)
- experiments/voice-turn-detection-compare/adapters/livekit-v1-mini.mts (new)
- experiments/voice-turn-detection-compare/run.mts (new)
- experiments/voice-turn-detection-compare/RESULT.json (new)
- scripts/voice-turn-detection-compare.mjs (new)
- tasks/gap-voice-turn-detection-pluggable-comparison-p0.md
## Needs-Human

**执行 2026-10-10T17:43:50.483Z — 停派终止（失败无法归因，⛔ 不再重派）**

- 阻碍原因：exited-not-landed 失败无法归因（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (parser attributed 1 failing file(s) in this round: server/modules/providers/tests/claude-resident-unattended-turn.test.ts); stopping instead of spending another worker session
- 失败步/判词：step=suite: __PERFILE__ duration_ms=5107 server/modules/providers/tests/claude-resident-unattended-turn.test.ts passed=false end_ms=1791654133556
- run_id：wk-prod-anchor
- session_id：26e89e85-97cf-42ff-9fc6-896aac9ed866
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-voice-turn-detection-pluggable-comparison-p0~wk-prod-anchor~1791654060086-b5b490.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-voice-turn-detection-pluggable-comparison-p0-wk-prod-anchor.log
