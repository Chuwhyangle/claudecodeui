---
id: GOAL-031
title: ClaudeCodeUI Live Voice 最小端到端交互闭环：语音→Qwen3.8 Realtime→语义上下文→当前会话
  session_send→执行反馈
status: draft
kind: goal
origin: docs/proposals/voice-native-control-plane.md（整体架构）；GOAL-029（离线
  bridge/benchmark infra，achieved）与 GOAL-030（真实 Qwen3.8 传输与证据，active）；2026-10-09
  人 yale 批准创建本 GOAL，并对范围做出明确纠正——不新建 Policy/Gate 或逐操作人工确认体系，不把 popup 全部实现设为硬阻塞。
---
## 背景

GOAL-029 证明了协议/schema 能跑通（确定性替身）；GOAL-030 补上了真实 `qwen3.8-omni-flash-realtime` 的连接证据（真实延迟、真实工具调用、真实并发竞态），但到目前为止这一切都**没有接到真正的 Claude Code 会话上**——执行体一直是 fixture，`session_send` 从没真的发过一条消息。本 GOAL 是第一次把链路接完整：浏览器真实语音 → Qwen3.8 Realtime 原生理解 → 读取当前 UI/project/session/turn 的真实语义上下文 → 正确选中要操作的 Claude Code resident 会话 → 调用高层 `session_send` → 执行结果在界面上真实可见。

本 GOAL **明确依赖 GOAL-030/AC-309 的真实 paired evidence**：AC-309 对应任务（`gap-voice-realtime-real-audio-paired-evidence`）跑出真实读数之前，本 GOAL 里真正"接线"的任务（见下）不应该开始实现。这不是因为协议本身需要等它——GOAL-030 Task A 已经证明协议能连、能调工具——而是因为"值不值得把这套理解能力接到真会话上"这个产品判断，部分建立在 AC-309 的 GO/NO-GO 读数上。

## 目标

最小闭环，**第一阶段只支持当前会话**（浏览器正在看的那一个 Claude Code resident 会话），覆盖：

1. 浏览器语音输入（真实 WebSocket、真实音频，不是确定性替身）；
2. Qwen3.8 Realtime 原生理解，读取当前 UI/project/session/turn 的真实语义上下文（不是 GOAL-029/030 用的 fixture）；
3. 正确选中当前会话（第一阶段不做跨项目/多会话解析，那是下一个 GOAL）；
4. 调用高层 `session_send`，真的落一轮到 Claude Code；
5. 执行结果在界面上真实反馈给用户；
6. 覆盖真实连接的韧性问题：重连、response 并发（GOAL-030 已经真实撞过的那个竞态）；
7. 用户可见的 transcript、送出前可纠正的意图；
8. PC 与移动浏览器的基本可用性（不是像素级打磨，是"能用"）。

**第二阶段（非本 GOAL 范围）**：跨项目、跨会话的选址与协调，见 `docs/proposals/voice-native-control-plane.md` §12 的长期愿景，另开 GOAL。

## 范围

四个任务：
- 真实 context 读取 + `session_send` 对接当前会话（后端，复用既有权限边界）；
- Realtime 连接的重连与并发韧性（后端，用已有真实竞态证据回归）；
- 浏览器端到端闭环（前端 + 对应后端代理路由，PC/移动基本体验）；
- AskUserQuestion/权限请求可观测性调查（只读调查，不强制实现）。

## 非目标——人 yale 的明确纠正，优先级高于下文任何具体设计细节

**不新建 Policy/Gate 层，不把"发送 prompt / 取消运行 / 批准工具调用"做成本 GOAL 的独立审批体系或逐操作人工确认硬性验收项。** 具体地：

- `session_send` 的安全边界用**参数白名单**（硬编码目标会话为语音连接绑定的那一个，不接受模型指定别的会话）落地，不是加一层"请确认是否发送"的对话框。
- 权限模式、工具批准（`canUseTool`/`approval_answer`/`AskUserQuestion`）**完全复用 Claude Code 自己已有的机制**，语音层不插手、不重复、不新建第二套。
- 用户授权保持**低摩擦**：功能工作在用户已有的浏览器会话范围内，不新增单独的"我同意"勾选框或 consent 流程（除非是复用某个已经存在、本 GOAL 之外另建的披露机制）。
- 危险操作（如果真的触发）复用**现有**的确认通道，不为语音单独造一套。
- 不要求 AskUserQuestion/权限请求弹窗的完整语音应答实现——AC-313 只要一份调查结论，可以是"现状够用，不用做"。
- 不做跨项目/多会话的会话选址（第二阶段）。
- 不做语音输出/TTS（`docs/proposals/voice-native-control-plane.md` §8 roadmap）。
- 不做 architecture-oriented workspace / multi-agent 协调（§12 长期愿景）。
- 质量/体验数字不进判据集；判据判定的是"链路真的接通、风险被参数白名单/既有机制兜住"，不是"用户体验打多少分"。

## 退出条件

- AC-310 真实 context 读取 + `session_send` 对接当前会话，参数白名单替代审批层。
- AC-311 Realtime 连接重连与并发韧性，复用真实竞态证据回归。
- AC-312 浏览器端到端闭环（当前会话），PC+移动基本体验，可纠正意图，复用既有转录渲染反馈结果。
- AC-313 AskUserQuestion/权限请求可观测性调查（只读，不阻塞）。

## 不做退出条件的范围内事

- 跨项目/跨会话选址与协调——下一个 GOAL 的事。
- AskUserQuestion/权限请求的语音应答实现——即便 AC-313 的调查结论是"现状不够用"，实现工作本身也不是本 GOAL 的退出条件，只在调查结论建议时才另外立案。
- 语音输出/TTS、architecture-oriented workspace。

## 已知限制

- 本 GOAL 的"接线"任务（AC-310/312）在 AC-309 读出真实结果前不应该开始实现；若 AC-309 最终判定 NO-GO，对应任务的执行者必须停下来找人工重新确认是否仍要推进本 GOAL，而不是假设"反正已经批准了 GOAL-031 就不用管 AC-309 的结论"——批准创建 GOAL 和批准"不管读数如何都强行推进"是两件不同的事。
- "当前会话"的边界本身依赖浏览器标签页与语音连接的绑定关系，第一阶段不处理"用户切换了标签页但语音连接还绑着旧会话"这类细节，留给实现任务自己发现并如实登记。
- 真实网络/真实麦克风的端到端验证按 ADR-004 决策 8 的一贯方式归人工，不进 CI。