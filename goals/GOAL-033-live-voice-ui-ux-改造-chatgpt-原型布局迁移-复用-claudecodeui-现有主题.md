---
id: GOAL-033
title: Live Voice UI/UX 改造：ChatGPT 原型布局迁移，复用 ClaudeCodeUI 现有主题
status: achieved
kind: goal
origin: 2026-10-09 人 yale 正式批准：基本认可最新 Live Voice 原型，要求据此改造 GOAL-031
  已交付的浏览器语音控件——采用认可原型的布局/交互结构（互斥输入模式、持续采集、固定紧凑底部栏、实时 ASR 文本仅作用户消息展示），但视觉完全复用
  ClaudeCodeUI 现有主题/组件（不照搬原型配色）。不重开已 achieved 的 GOAL-031；本 GOAL 独立建立，AC-316 正式
  supersede GOAL-031/AC-312 的 UI 形态（草稿确认/Send/Cancel/可见 Start&Upload
  按钮），AC-310/311/313/315 的后端与协议保证不受影响、不重新验收。
activatedAt: 2026-10-09T08:07:20.011Z
statusLog:
  - at: 2026-10-09T10:45:42.199Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: all ACs achieved + sufficiency covered"
---
## 背景

GOAL-031（已 achieved）交付了 Live Voice 的第一版浏览器闭环：麦克风/文件上传按钮悬在 composer 上方、模型提议的意图以可编辑草稿+Send/Cancel 的形式展示、composer 全程保留。用户基于这一版原型截图反馈：composer 在 Live Voice 模式下没有必要同时出现，草稿确认步骤不符合"持续语音交互"的产品设想，移动端尤其明显地把转录空间挤压掉了。

人 yale 随后给出一版经认可的 ChatGPT 风格原型，批准按其布局/交互结构改造，同时明确两条硬约束：(1) 视觉**完全**复用 ClaudeCodeUI 现有主题/组件系统（颜色、字体、间距、dark mode），不照搬原型的配色方案；(2) 不重开 GOAL-031——GOAL-031 的后端/协议保证（AC-310 真实 context + session_send 接线、AC-311 重连与并发韧性、AC-313 权限可观测性调查、AC-315 上传+协议模拟）继续有效，本 GOAL 只重做 UI 层，必要处通过 `supersedes` 正式替换 AC-312 的 UI 形态，而不是编辑 GOAL-031 本体。

## 目标

把 Live Voice 从"composer 上方的附加控件"改造成"与 Chat Composer 互斥的独立输入模式"，布局与交互对齐认可原型：

1. 互斥模式：Live Voice 与普通 Chat Composer 不同时出现；两者共享同一个 Session/Transcript/工具执行结果，退出 Live Voice 回到普通 Composer。
2. 持续采集：进入即开始采集原始音频，直到用户 Mute 或 End；模型执行阶段不中断采集。语音原生推理用原始音频，不做 ASR 文本转模型输入（这条今天已经是真的，本 GOAL 只需保持，不需要新建）。
3. 实时 ASR transcript 仅作为用户消息展示（interim/final、去重、顺序正确），不得被误当成模型推理输入。
4. 桌面与移动端都保持固定、紧凑的底部采集控制栏（麦克风状态/波形、Mute/Unmute、End），从进入到执行到完成全程同一尺寸，不放大、不切全屏。
5. 隐藏不适用于该模式的交互：普通文本 Composer、草稿确认（Voice input draft/Send/Cancel）、旧的 Start voice control/Upload audio 按钮。音频文件注入保留为测试通道，不在正常 UI 出现。
6. 避免模式切换产生重复发送、连接泄漏或消息错路由。

## 范围

两个任务，AC-317 依赖 AC-316：

- **AC-316**（本轮实现）：互斥模式切换、固定紧凑底部栏、持续采集直到 Mute/End、去掉草稿确认 UI、隐藏旧按钮、音频注入保留测试通道、代理自动直接执行 session_send（不再等浏览器 decision）。
- **AC-317**（已过设计讨论，暂未实现，依赖 AC-316）：实时 ASR interim/final 文本以用户消息形式展示在 transcript 里，正确处理去重与顺序，且结构上与模型推理输入（`session_send` 的 message 参数）保持独立，不得混用。需要 `voice-realtime-dashscope-transport.ts`/`voice-realtime-bridge.service.ts` 新增对 `conversation.item.input_audio_transcription.delta`/`.completed` 事件的映射（今天这两种事件会被误判为 `UNKNOWN_EVENT`——已用真实 DashScope trace `experiments/voice-realtime-ambiguity/real-trace/qwen38-omni-realtime-trace.json` 核实），以及 transcript 侧的 provisional→final 消息渲染。

## 非目标

- 不重开 GOAL-031，不编辑 GOAL-031 的 body/退出条件；AC-310/311/313/315 原样有效。
- 不做真实麦克风人工走查相关变更（`gap-voice-realtime-microphone-human-smoke-test` 不受影响）。
- 不改变 `session_send` 的会话绑定白名单/参数校验等既有安全边界。
- 不做语音输出/TTS、跨项目/跨会话、architecture-oriented workspace（均为更长期范围，不在本 GOAL）。
- AC-317 的具体实现细节（caption 去重算法、provisional 消息的确切组件）留给该任务自己的 Proposal 展开，本 GOAL 只定边界。

## 退出条件

- AC-316：见其自身判据。
- AC-317：见其自身判据（提交时另行定义，依赖 AC-316 落地）。

## 已知限制

- Mute 在本轮实现为"暂停发送音频帧，保持连接"，不关闭 `/voice-realtime` 连接——这是刻意选择（避免每次 Mute/Unmute 都重新握手、重新计算工具白名单上下文），如实登记供后续复核。
- 麦克风路径的"thinking"（语音结束到模型决定之间的状态）在 AC-316 不单独区分，折叠进 `listening`——真正的区分需要 AC-317 的 caption 事件或语音活动检测（VAD）自动停止，属于更大改动，留给后续。