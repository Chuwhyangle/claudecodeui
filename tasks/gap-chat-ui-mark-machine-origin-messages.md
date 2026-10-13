---
id: gap-chat-ui-mark-machine-origin-messages
title: 聊天 UI：区分机器/自动来源消息与真人消息（视觉标记/默认折叠），为跨项目通知管线落地铺路
status: ready
labels:
  - gap
  - ux
parent: null
children: []
extra: {}
---
## Proposal

**背景（来自 quay-fleet 项目 2026-10-13 的一次跨项目架构讨论，非本仓库内部发现）**：quay-fleet（一个跨项目常驻 AI Fleet Manager）正在实现一条新的通知管线（quay-fleet 的 ADR-006 / Goal AC-056）：由 Fleet 自己完成候选筛选、语义判断、终稿正文后，经 CloudCLI 的 `session_send` 直接把消息投进一个人类 Manager 的 Claude Code 会话。这类消息的作者是一个自动化系统，不是真人在打字——如果本仓库（ClaudeCodeUI）渲染的聊天界面最终会呈现这类会话，人类读 transcript 时需要能一眼分辨这条是机器自动发的通知还是这条是某个人真的在说话，否则容易误读。

**本任务不紧急、不阻塞 quay-fleet 侧的任何工作**——只是把这个跨项目观察点记录下来，供本仓库维护者按自己的节奏评估是否要做、何时做。

## AC

- [x] 消息若带有可识别的机器来源标记（具体字段名/协议由实现者决定，可以是消息元数据里的 `origin: machine` 或等价约定），渲染时有与真人消息视觉上可区分的处理（例如：不同背景色/图标前缀/默认折叠为一行摘要，点击展开）
- [x] 不带该标记的既有消息渲染方式不变（零回归）
- [x] 有至少一条回归测试覆盖带标记消息与不带标记消息两种渲染路径

## DoD

真实验证：至少有一条端到端/组件测试证明两种消息类型渲染出可观察的差异（非纯样式 snapshot 臆造）。本任务不要求实现具体的机器消息协议本身——协议由上游系统（如 quay-fleet）定义，本仓库只需要在收到**已标记**的消息时正确渲染；若协议尚不存在，本任务可以先做渲染层支持该标记，上游何时真正开始发送带标记的消息是另一件事。

## Touches

- src/modules/chat/transcript/MessageComponent.tsx
- src/modules/chat/tests/machineOriginRow.test.tsx
- tasks/gap-chat-ui-mark-machine-origin-messages.md

## Context

- 触发讨论：quay-fleet 的 `fleet-p2-notification-pipeline-v0`（AC-056）。该任务本身完全独立于本仓库，不依赖本任务完成。
- 本任务不设优先级/不设 goal_ac——留给本仓库维护者按自己的路线图评估。

### 实现记录（2026-10-13）

**标记用的是本仓库既有的约定，不是新造字段。** `src/shared/types.ts` 的 `MessageOrigin`（"UNATTENDED TURN ORIGIN" 段）就是本仓库对「这一轮不是浏览器前的人发起的」的既有、由服务端发布的约定，等价于本 AC 里写的 `origin: machine`。它已经流经 `NormalizedMessage.origin` → `normalizedToChatMessages` → `ChatMessage.origin`，所以渲染层直接读它，不再加一个并行字段。

**渲染层的改动**（`MessageComponent`）：带 `origin` 的行在行根上多一个 `data-message-origin="machine"`，气泡内多一个图标标记（`data-machine-origin-mark`，带 accessible name、**不含文案**）。图标不带文案是刻意的：这一行的 textContent 就是发送方自己的原话，而 transcript 导出与 e2e walk 都是把这一行的文本当作消息读回去的，所以任何标签都会被读成消息正文的一部分。

**未覆盖的另一半，明确记在这里**：MCP 网关的 `session_send` 目前只把来源记在 run 注册表上（`ChatRunSource = 'mcp'`，见 `server/shared/types.ts` 与 `chat-control.service.ts` 的 `SOURCE_BY_VIA`），没有把它落到 transcript 行上——所以今天这类消息仍以普通 user 轮次出现、不带 `origin`，走不到本任务的标记分支。要让 quay-fleet 的实际通知带上标记，需要上游/服务端把该来源写成行上的 `origin`；这正是 DoD 里写明「协议由上游系统（如 quay-fleet）定义」的那一半，不在本任务范围内。今天能走到标记分支的真实路径是 CLI 原生的跨会话 peer 消息（`readClaudeRowOrigin` → `{ trigger: 'cross-session', sender }`）。
