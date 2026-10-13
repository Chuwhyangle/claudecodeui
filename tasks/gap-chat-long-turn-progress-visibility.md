---
id: gap-chat-long-turn-progress-visibility
title: 长回合期间让「进行中」指示器反映正在做什么，而不是只有秒数在涨
status: ready
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

- [x] AC1 新夹具断言：进行中状态的活动读数变化会更新指示器；`npx vitest run <新夹具>` 退出 0。
- [x] AC2 取假形态：把活动读数去掉（只剩 elapsed）⇒ AC1 红。
- [x] AC3 `npm run typecheck` 与 `npm run lint` 均退出 0。

## DoD

长回合期间页面能反映"正在做什么"，人不必靠刷新、也不必靠猜来判断它是否还在推进。

## Touches

- src/modules/chat/tests/activityDockProgressReading.test.tsx (new)
- tasks/gap-chat-long-turn-progress-visibility.md

## Notes

渲染 `Working…` 的具体组件是 `src/modules/chat/composer/ActivityIndicator.tsx`（`[data-activity-dock]`），由 `src/modules/chat/transcript/ChatMessagesPane.tsx` 以 `sessionId={activeSessionId}` 挂载；不是 `ResidentStatusBar` 也不是 `ChatInterface` 内联。该 surface 的 label 已是 `phaseLabel ?? statusText ?? "Working"`，`phaseLabel` 来自 `activityDockView.activityPhaseLabelKey(phase, toolName)` —— 即"当前活动"读数（工具名/在写/在想/压缩/等审批）早已由服务端 tracker 经 `activity.heartbeat` 广播并在浏览器端接好，e2e 判据 `e2e/activity-dock-truthful.spec.ts`（AC-187）已在真实服务端钉住这条链路。因此本任务不需要新增生产代码：残留缺口是**客户端快速反馈**——兄弟夹具 `activityDockUnreachable.test.tsx` 只钉 unreachable / failed-send / recovery / idle-结束 / 在飞但 phase=idle，从不断言 label 会随 phase 变化。

本任务的交付 = 新增 `activityDockProgressReading.test.tsx`：用与兄弟夹具同一套 in-memory liveness 通道，把一次 phase 变化序列（hello → tool/Bash → writing → thinking）喂进去，断言 label 每次都改写、同相位内保持不动、工具名被点名、且与 elapsed 并列而非取代。取假形态已实测：把 `ActivityIndicator` 传入的 `phase` 固定为 `'idle'` 后，所有读数塌回 `Working…`，该夹具即红。

## Blocker

**2026-10-13T03:54:33.299Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: __PERFILE__ duration_ms=68616 server/modules/session-hosts/tests/resident-server-restart.test.ts passed=false end_ms=1791863622229
- run_id：wk-prod-anchor
- session_id：f0a7f0bb-b167-4e31-9f7d-bf4a0f59841c
