---
id: gap-composer-header-backdrop-blur-streaming
title: composer/header 的 backdrop-blur 覆盖流式内容：隔离重算成本并条件化
status: todo
labels:
  - gap
  - defect
  - ui
  - performance
parent: null
children: []
extra:
  schema: execution
---
## Finding

线上层审计有 2 个常驻 `BackdropFilter` 层：`src/modules/chat-composer/composer/PromptInput.tsx:43` 的 composer 和 `src/modules/project-workspace/WorkspaceHeader.tsx:152` 的 header，都在流式 transcript 上方；`src/modules/chat/tools/BashCommandDisplay.tsx:101` 也有一个。Transcript 每 100ms 合并一次（`STREAM_FLUSH_INTERVAL_MS=100`），下层的文字/滚动变化可能让 backdrop-filter 反复重算。

我们还没有隔离这项成本：全动画关掉时 running 页面仍有 4–8%，其中可能包含模糊重算，也可能是 React/流式更新。本任务先做 A/B 测量，只有确认有成本才改；不要在未测量的情况下移除视觉模糊。侧栏的同类问题已由 `gap-running-session-cpu-perpetual-animations` 修过（空层 + 有运行会话时关闭 blur），这里只处理 composer/header（BashCommandDisplay 可按同样方法顺带测）。

## AC

- [ ] AC1 隔离测量：在同一 running/流式会话上，分别测 composer blur 开/关、header blur 开/关（运行时 CSS/class 注入即可），5×10s CDP，记录 total/main/GPU/recalc 到 Evidence；先打印 `composerBlurOn=... composerBlurOff=... headerBlurOn=... headerBlurOff=...`。若某项差值在噪声内（例如 <2 点 total 且 GPU 无差），记录为不显著。
- [ ] AC2 修复或证据化不改：对确认显著的表面选择最小改法（不透明背景、静态背景层、流式期间条件关闭 blur 等），保留静态视觉；对不显著的表面记录证据并保持原样。不得为了关闭 blur 破坏设计或引入新的层。
- [ ] AC3 既有判据：composer/header 相关测试（`src/modules/chat/tests/promptInputSubmit.test.tsx`、`src/modules/chat/tests/chatComposerResponsive.test.tsx` 等）、`npm run typecheck`、`npm run lint`、架构棘轮 exit 0；有视觉改动时附截图/说明。
- [ ] AC4 线上复测：`npm run build:client` 后在 running 会话复测，读数与修复前对照写入 Evidence；若选择不改，AC4 记录“无改动 + 测量证据”。无法取读数时 park `needs-human` 并说明，不得推断。

## DoD

- 每个被测量的表面都有读数与结论；显著的才改，不显著的保持原样。
- 修复保留视觉意图，不引入新的 compositor 层或持续动画；不改变 composer/header 布局。
- 既有测试/typecheck/lint 全绿；Touches 一致。

## Touches

- src/modules/chat-composer/composer/PromptInput.tsx
- src/modules/project-workspace/WorkspaceHeader.tsx
- src/modules/chat/tests/promptInputSubmit.test.tsx
- src/modules/chat/tests/chatComposerResponsive.test.tsx
- src/index.css
- tasks/gap-composer-header-backdrop-blur-streaming.md
