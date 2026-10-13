---
id: gap-chat-long-turn-progress-visibility
title: 长回合期间让「进行中」指示器反映正在做什么，而不是只有秒数在涨
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**症状（2026-10-13 实测）**：长回合（连续几十个工具调用、跑测试套件）期间，界面上只有 `Working… <elapsed>`，内容长时间完全不变，人无法判断"还在推进"还是"已经卡死"。当天这一点**直接导致人两次误判**——一次怀疑"是不是还有未完成的后台操作"，一次据此推断"指示器是错的"（该推断后来被采样器否证：服务端 `/api/providers/sessions/running` 与真实轮次精确对齐，指示器本身是准的）。

**注意区分**：指示器不是错，是**信息量不足**。elapsed 秒数在涨，但没有任何"正在做什么"的读数，于是长时间静默与卡死在屏幕上无法分辨。

## Plan

1. 让进行中指示器带上当前活动（工具名 / 步骤 / 最近一次事件），与既有 elapsed 并列显示。
2. 活动读数来自既有的实时事件流，不新增轮询。
3. 夹具断言：活动变化会反映到指示器上。

## AC

- [ ] AC1 新夹具断言：进行中状态的活动读数变化会更新指示器；`npx vitest run <新夹具>` 退出 0。
- [ ] AC2 取假形态：把活动读数去掉（只剩 elapsed）⇒ AC1 红。
- [ ] AC3 `npm run typecheck` 与 `npm run lint` 均退出 0。

## DoD

长回合期间页面能反映"正在做什么"，人不必靠刷新、也不必靠猜来判断它是否还在推进。

## Touches

- src/modules/chat/ChatInterface.tsx
- src/modules/chat/hooks/useChatRealtimeHandlers.ts
- src/modules/chat/hooks/useSessionProtection.ts
- src/shared/context/SessionProtectionContext.tsx
- tasks/gap-chat-long-turn-progress-visibility.md

## Notes

渲染 `Working…` 的具体组件尚未定位（可能是 `ResidentStatusBar` 或 `ChatInterface` 内联）；实现时先定位再改。本任务**不**改变"什么时候算进行中"的判定——那套（服务端 `chatRunRegistry` 轮询）已验证是准的。