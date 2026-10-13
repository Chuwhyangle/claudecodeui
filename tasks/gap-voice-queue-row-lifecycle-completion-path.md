---
id: gap-voice-queue-row-lifecycle-completion-path
title: 语音「Waiting in the queue」撤回行累积不消：定位并修复 CLI command_lifecycle 的 completed 到不了浏览器
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**症状（2026-10-13 实测）**：Live Voice 期间底部「Waiting in the queue」撤回行会累积——从一行涨到三行，都不消失。

**已排除的两层**：

- **客户端契约是好的**：`voicePendingWithdraw.test.tsx` 里 "a completed command drops the row entirely" 已是绿的。
- **uuid 契约在设计中就是对的**：`claude-host-driver.provider.ts:2580` 写明 "an entry's uuid is the CLI's own `command_uuid` … the CLI's `command_lifecycle` reports it back"。

所以缺的是**`command_lifecycle` 的 `completed` 到不了浏览器**——三种可能：(a) CLI 没为语音发起的发送发这行；(b) 发了但没被规范化（`claude-sessions.provider.ts:1223` 的两信封）；(c) 规范化了但没推给订阅者。本任务先**定位**再修。

## Plan

1. 写 driver 级夹具：语音 `session_send` 排队 → CLI 流里出现 `command_lifecycle: completed` → 断言它被规范化并推给客户端。
2. 夹具红/绿的读数直接指出是哪一层；据此修。
3. 修完复跑确认绿，并回跑 `voicePendingWithdraw.test.tsx` 确认客户端侧未被动。

## AC

- [ ] AC1 新夹具断言上述链路端到端可达；`npx tsx --tsconfig server/tsconfig.json --test <新夹具>` 退出 0。
- [ ] AC2 取假形态：把 `completed` 行的规范化或推送去掉 ⇒ AC1 红。
- [ ] AC3 `npm run typecheck` 退出 0。
- [ ] AC4 `npx vitest run src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx` 仍退出 0。

## DoD

一条语音排队投递在 CLI 开始并完成之后，其撤回行会在浏览器端消失，不再永久累积；端到端链路有夹具钉住。

## Touches

- server/modules/providers/list/claude/claude-sessions.provider.ts
- server/modules/providers/list/claude/claude-host-driver.provider.ts
- server/modules/websocket/services/chat-run-registry.service.ts
- src/modules/chat/voice-realtime/useVoicePendingWithdraw.ts
- server/modules/voice-realtime/tests/voice-realtime-queue-lifecycle-completion.test.ts

## Notes

与 gap-voice-unforwarded-utterance-visible-disposition 同属"终态必须对浏览器可见"这一类，但机制不同（这条是 CLI 队列行，那条是模型处置），**不设依赖**；两者可能都改 `voice-realtime-ws-proxy.service.ts`，文件重叠交由工作树/合并机制处理。