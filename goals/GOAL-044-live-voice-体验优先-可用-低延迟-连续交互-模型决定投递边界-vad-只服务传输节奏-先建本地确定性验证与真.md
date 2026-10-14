---
id: GOAL-044
title: Live Voice 体验优先：可用、低延迟、连续交互，模型决定投递边界、VAD 只服务传输节奏；先建本地确定性验证与真实校准
status: achieved
kind: goal
origin: 人 yale 2026-10-12 调整 Live Voice 优先级：体验优先、模型决定何时输出、VAD
  只服务传输与成本、成本为第二阶段（Opus 常驻会话；决策文档
  docs/proposals/live-voice-experience-first-decision-2026-10.md，提交 038730f0）。
activatedAt: 2026-10-12T12:26:58.235Z
statusLog:
  - at: 2026-10-12T19:44:22.381Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: all ACs achieved + sufficiency covered"
---
## 背景

人 yale 2026-10-12 调整 Live Voice 优先级：首先实现可用、低延迟、连续的交互体验；何时语义输出或调用工具由模型决定；VAD 只用于降低无意义传输与响应成本，不承担业务断句；成本优化列为第二阶段；允许先用连续（上游 server_vad）基线换取体验；不做未经验证的生产切换。现状与依据见 docs/proposals/live-voice-experience-first-decision-2026-10.md（§1 两条路径的语义能力差异、§3 体验验收 X-1..X-7、§5 静音与计费四概念）。

## 目标

1. 用本地确定性 E2E（fake mic + 声学 VAD 仿真的 fake upstream + 执行面夹具）测出当前连续路径在 X-1..X-7 上的基线，并区分我方错误与协议/模型限制。
2. 用一次真实校准（C-1..C-6）回答 semantic_vad 行为、silence_duration 取舍、丢静音致盲、静音计费、模型可否等待转发、静音尾门控最小值，并给出成本基线。
3. 在上述读数与人裁定之后，再立体验修复与默认模式切换任务。

## 范围

AC-361（本地 E2E 基线）、AC-362（真实校准 C-1/C-2/C-4/C-5）、AC-363（Silence Tail Suppression 真实探针 V-1..V-8）、AC-364（STS 产品实现，本地 S-1..S-7；2026-10-14 裁定「STS 已证实无效，取消生产调用」后已 superseded，本 GOAL 不再以它为在域保证）。不在本 GOAL：产品代码的体验修复、默认模式切换（待读数与裁定后另立）、成本优化（第二阶段）。

## 退出条件

AC-361 判据通过且读数表覆盖 X-1..X-7；AC-362、AC-363 报告读数齐全；AC-364 已按 2026-10-14 裁定 superseded（STS 已断开生产调用，`VOICE_REALTIME_SILENCE_TAIL` 在生产装配里不 arm，其判据由 `voice-realtime-silence-tail-deprecated.test.ts` 承担）。