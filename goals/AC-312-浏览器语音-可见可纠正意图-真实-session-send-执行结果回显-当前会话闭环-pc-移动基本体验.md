---
id: AC-312
title: 浏览器语音→可见可纠正意图→真实 session_send→执行结果回显：当前会话闭环，PC+移动基本体验
status: achieved
kind: criterion
goal: GOAL-031
criterion: npx playwright test e2e/voice-realtime-live-session-send.spec.ts
expect: |-
  新前端模块驱动 Realtime 连接（判据环境里对假 WS 服务端，不是真实网络，按本仓库既有 e2e 惯例）：麦克风权限、音频帧转发、工具调用全链路跑通；UI 展示"正在听/理解中"状态与最终待发送的意图文本，**用户可以在送出前编辑**（低摩擦：不要求勾选框、不要求额外确认弹窗——编辑能力本身就是纠正机制）；确认后调用 AC-310 落地的 `session_send` 路径，落到当前会话；执行结果通过**现有**聊天转录渲染呈现，不新建反馈 UI（复用 `ChatRunSource==='mcp'` 的轮次已经能正常渲染这一事实）。覆盖 PC 视口与一个移动视口（375px）各一次基本流程。

  真实半区（手动，不进 CI）：至少一次真实麦克风 + 真实网络的端到端走查，人工确认结果正确渲染。
origin: 本 GOAL
  目标链路第一句（浏览器语音输入→…→执行反馈）；docs/proposals/voice-native-control-plane.md §1/§9
  的分层与鉴权设计；人 yale 的纠正——不新建确认流程，复用既有渲染与既有权限边界。
activatedAt: 2026-10-09T02:13:52.926Z
statusLog:
  - at: 2026-10-09T02:13:52.926Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-10-09T06:17:55.904Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-09T02:13:52.926Z
---
