---
id: gap-live-voice-pending-request-answer-surface
title: Live Voice 模式下提问/权限请求没有可作答的界面：VoiceRealtimeBar 替换 composer 时未一并渲染
  PermissionRequestsBanner
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**现状（2026-10-11 本会话逐行复核，非推测）**

- 全前端唯一能作答的界面是 `PermissionRequestsBanner`（`src/modules/chat/composer/PermissionRequestsBanner.tsx`，`:18` 注册 `AskUserQuestionPanel`），而它只在 `ChatComposer.tsx:610-618` 被渲染，props 由 `ChatInterface.tsx:991-993` 传入。
- `ChatInterface.tsx:951` 在 `composerMode === 'voice'` 时用 `VoiceRealtimeBar` **整体替换**了 composer 子树；`VoiceRealtimeBar.tsx`（292 行）不含任何 permission/提问控件。⇒ **voice 模式期间界面上没有任何可点的作答控件。**
- 转写区那张卡片（`ToolRenderer.tsx:272` → `QuestionAnswerContent`）是只读记录：行内按钮只负责展开/收起，本就不负责作答。
- 状态行还会继续显示 "Waiting for approval…"：`ActivityIndicator` 的 dock 在 `hasTurnAnchor` 为真时走 `in-turn` 分支、用服务端上报的 phase 出标签（`activityDockView.ts:209-245` + `useActivityFreshness.ts:295`；`ChatInterface.tsx:814` 只置空传给 indicator 的 `activity`）。于是界面看着像有个可交互的东西在等你——实际没有。

**事故读数（本会话，`server.log` 的 voice-realtime 会话 `7e8ae374`）**

18:12:12 用户用语音报告「看到了 waiting for approval，还有一个对话框让我选择会话指代，但是我现在点不了这个对话框」；18:12:24 该语音指令被服务端拒为 `SESSION_BUSY`；16 秒后 `session_send failed after 16005 ms: already has a run in progress`；18:12:39 浏览器 socket 关闭（用户按下 End）。这次提问最终被记成 Skipped。

**人的裁定（2026-10-11，yale）**

voice 模式下 banner **叠在语音条上方**，保留 Live Voice 连接；只要保障用户可选即可，**不做额外引导提示**。

**要做的事**

1. `ChatInterface.tsx:951` 的 voice 分支：在 `VoiceRealtimeBar` 之上渲染 `PermissionRequestsBanner`，复用本地的 `pendingPermissionRequests` / `handlePermissionDecision` / `handleGrantToolPermission`（就是传给 ChatComposer 的那三个）。作答**不得**退出语音模式、不得重连语音连接。
2. 布局：banner 与语音条在同一 composer 外壳内上下相邻、同一宽度上限；banner 出现或消失时，语音条自身的高度与位置不变（AC-316 的固定栏高度判据不能被这次改动弄红）。
3. 按人的裁定，**不加**任何把注意力引向 banner 的提示文案，也不改状态行的语义。
4. 不改 `PermissionRequestsBanner` 与 `AskUserQuestionPanel` 的对外语义（`onDecision` 载荷保持现状）。若把该组件从 `composer/` 之外引用触发既有模块边界规则，按该目录既有约定处理。

**边界（不做）**

- 不实现"语音层代答"（`approval_answer` 那条路）——本次只补人可点的界面。相关调查见 `gap-voice-realtime-popup-observability-investigation`（AC-313，done，结论是语音层可观测性够用且明确不实现应答能力），本任务不推翻也不扩展它。
- 不改 `VoiceRealtimeBar` / `useVoiceRealtimeSession` 的协议与 phase 机。
- 不改 `ActivityIndicator` 的状态行语义（"Waiting for approval" 继续由服务端 phase 驱动）。
- 不改控制面的 busy 队列行为（本次事故里那条 `SESSION_BUSY` 是被记录下来的证据，不是本任务要改的对象；resident 形态相关的那条线是 `gap-live-voice-entry-ignores-resident-intent`，机制不同）。

<!-- dedup-ref --> 机制去重（2026-10-11 立案时实测）：`PermissionRequestsBanner` 在 `tasks/*.md` 中只被 `gap-voice-error-notice-browser-e2e` 提到（不同机制：语音失败提示的浏览器证据）。相关但不同机制、且都不构成前置：`gap-voice-realtime-popup-observability-investigation`（done，只调查语音层能否从 `approvals_list` 读到"有人在等"）、`gap-mcp-pending-interaction-visibility-and-idempotent-answer`（done，补 MCP 读工具的结构化字段）、`gap-ac231-control-busy-queue-cancel`（done，控制面 busy 队列）。粒度：`task-granularity-advice.js --touches src/modules/chat/ChatInterface.tsx --touches src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx --touches tasks/gap-live-voice-pending-request-answer-surface.md --json` 读数 `peers: []` / `mentions: []`，判定 **separate / none found**。

## AC

- [x] AC1 互斥渲染不被破坏：voice 模式下语音条 `[data-slot="live-voice-bar"]` 仍存在、文本 composer 仍不可见（`e2e/voice-realtime-composer-embedded.spec.ts` 既有断言保持绿）。
- [x] AC2 待答请求在 voice 模式下可作答：挂起一个 `AskUserQuestion` 后进入 voice 模式，banner 与其选项控件实际出现在 DOM 中且可点；点击选项后发出的决议载荷含 `allow: true` 与 `updatedInput.answers`（单测：挂载真 `ChatInterface`，断言 panel 存在并断言 onDecision 载荷）。
- [x] AC3 作答不中断语音：作答后 `composerMode` 仍为 voice、连接计数不增（不重连）、`connectedAt` 连续。
- [x] AC4 语音条几何不变：banner 出现/消失前后，`[data-slot="live-voice-bar"]` 的 boundingBox 高度变化在既有容差内（沿用该 e2e 家族已有的 ≤4px 容差判据）。
- [x] AC5 无额外引导：本次 diff 不新增任何把用户引向 banner 的 i18n 键或提示文案（grep 可查）。
- [x] AC6 `npm run typecheck` 与 `npm run lint:client` 通过；`bash scripts/with-memory-cap.sh npx vitest run src/modules/chat/tests/voiceModePermissionBanner.test.tsx` 绿。

## DoD

真实浏览器读数，不是"测试绿"：在一个真实会话里让一次 `AskUserQuestion`（或一次真实权限请求）**挂起** → 进入 Live Voice → 在语音条上方**真的点一下**某个选项 → 该轮因此继续（这次提问被记为已答，而不是 Skipped），且语音连接全程未断（语音条 elapsed 连续 / 连接计数不变）。同时给出改动前同一流程"点不动"的红形态留证。两组读数都要来自真实运行，不能只给代码推断。

## Touches

- src/modules/chat/ChatInterface.tsx
- src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx
- src/modules/chat/composer/PermissionRequestsBanner.tsx
- src/modules/chat/tests/voiceModePermissionBanner.test.tsx (new)
- e2e/voice-realtime-composer-embedded.spec.ts
- tasks/gap-live-voice-pending-request-answer-surface.md (self)
