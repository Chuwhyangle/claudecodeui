---
id: gap-voice-realtime-browser-e2e-current-session
title: 浏览器语音→可见可纠正意图→真实 session_send→执行结果回显，PC+移动基本体验（AC-312）
status: ready
labels:
  - gap
parent: null
children: []
extra: {}
depends_on:
  - gap-voice-realtime-live-session-send-wiring
  - gap-voice-realtime-connection-resilience
goal_ac: AC-312
---
## Proposal

<!-- dedup-ref --> 立案时 `grep -rli "voice-realtime.*e2e\|browser-e2e-current-session" tasks/*.md goals/*.md` 零命中。本任务是 GOAL-031 的收口任务：`depends_on` 前两个任务——没有真实执行体（`gap-voice-realtime-live-session-send-wiring`）就没有真的能调用的 `session_send`；没有连接韧性（`gap-voice-realtime-connection-resilience`），一条真实打开的语音连接随时可能被并发竞态打断。

### 背景

本任务把前两个任务的后端能力接上浏览器前端，交付 GOAL-031 目标链路里用户能直接感知的那一半：按下麦克风、看到理解中的状态、看到待发送的意图文字、能在发送前编辑、确认后真的看到 Claude Code 执行的结果出现在对话里。

### 方案

1. 新前端模块（位置按 `.agents/skills/frontend-module-standards`，建议 `src/modules/chat/voice-realtime/`）：麦克风采集复用既有 `AudioWorklet`/`voiceFrameProcessor`；新增一个服务端 WS 代理路由，浏览器→代理→真实 DashScope transport（凭据只在服务端，浏览器不直连，沿用现有语音功能的既有约束）。
2. UI：听/理解中状态指示；最终意图文字展示，**可编辑**（这就是低摩擦的纠正机制，不需要额外确认框）；一个明确的发送动作触发 `session_send`。
3. 执行结果：**不新建反馈 UI**，复用现有聊天转录——语音发起的轮次本来就会以 `ChatRunSource==='mcp'` 的普通轮次出现在转录里，这次只需要确认这条渲染路径对这种来源确实工作正常（如果发现渲染有问题，登记为缺口，不在本任务里顺手改转录渲染的既有逻辑，除非缺口刚好在本任务声明的 Touches 内）。
4. PC 与一个移动视口（375px）各跑一次基本流程。

### 边界（不做）

不做跨会话/跨项目选址（`boundSessionId` 就是当前打开的会话）；不新建确认弹窗或 consent 流程；不做语音输出；判据环境里的 Realtime 连接是假 WS 服务端（按本仓库 e2e 惯例），真实网络+真实麦克风的走查归人工（AC6）。

## AC

- [ ] AC1 离线闭环可跑：假 WS 服务端上，麦克风权限→音频帧→工具调用→意图展示→确认发送→`session_send` 调用全链路，Playwright 退出 0。
- [ ] AC2 可编辑意图：UI 展示的待发送文字可以被用户编辑，编辑后发送的是编辑后的内容（不是原始理解结果）。
- [ ] AC3 执行结果可见：确认发送后，对应的 `mcp` 来源轮次出现在聊天转录里（复用既有渲染，不新建组件）。
- [ ] AC4 移动视口基本可用：375px 视口下跑一遍同样的基本流程，核心控件可见可操作。
- [ ] AC5 真实半区：至少一次真实麦克风+真实网络的端到端走查，人工确认结果正确渲染（手动，不进 CI）。
- [ ] AC6 静态门：`npm run typecheck` 与 `npm run lint` 退出 0。

## DoD

真实落地判据：不是"UI 画出来了"，是**用户按下麦克风说一句话、看到可编辑的理解结果、确认后真的在转录里看到 Claude Code 的回应**——这条链路要在假 WS 环境下机械可证（AC1），且至少有一次真实网络下被人工走查过（AC5）。不新建的东西（审批弹窗、反馈组件）本身也是判据的一部分：AC3 明确要求复用既有渲染，不是顺手建一个新的。

## Touches

- src/modules/chat/voice-realtime/ (new)
- server/modules/voice-realtime/voice-realtime-ws-proxy.routes.ts (new)
- e2e/voice-realtime-live-session-send.spec.ts (new)
- tasks/gap-voice-realtime-browser-e2e-current-session.md (self)