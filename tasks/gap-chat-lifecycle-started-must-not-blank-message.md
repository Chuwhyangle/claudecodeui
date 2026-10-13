---
id: gap-chat-lifecycle-started-must-not-blank-message
title: 忙时发送的消息不得在 command_lifecycle:started 被清空——移除键是「替代行可见」而不是「宿主说了 started」
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**症状（2026-10-13 实测）**：会话正忙时打字发送的消息，**气泡整条消失**，刷新后才出现；期间 "Working…" 照常显示（来自另一条线），所以人看到的是"我的话不见了，但它在处理"。

**机制（已定位到行）**：忙时发送走 `useChatComposerState.ts:1091` 的 resident-pending 分支 → `useSessionStore.addResidentPending` 建一条 `command_lifecycle` 实时行（**此时气泡是出现的**，content 就是原话）→ CLI 开始执行 → 宿主发 `command_lifecycle: started` → `useSessionStore.ts:1413-1417`：

```ts
content: event.state === 'queued' ? rows[index].content : '',
```

**除 `queued` 外一律把 content 置空**，依据是"started 表示它已经是一个回合，回合自己的行会带着这条消息"。但那些行是**异步**从会话流/重读来的——**在它们真的可见之前，字已经被抹掉了**。

**为什么这是错的**：`markDeliveredVoiceMessages` 的注释已经写对了这条规则并守住：移除的键是 **"the real message is VISIBLE"**，不是"服务端说了 `sent`/`started`"。聊天这条路径违反了同一原则。

## Plan

1. `started` 不再清空 content；在该命令对应的回合行**确实可见**之前保留文本（可降级成"已进入回合"的形态，但不能为空）。
2. 只在该回合行可见时移除这条 lifecycle 行（沿用语音侧同一口径）。
3. 夹具：忙时发送 → `command_lifecycle: started` → 替代行未到 ⇒ 文本必须仍在。

## AC

- [ ] AC1 新夹具断言：忙时发送 + `command_lifecycle: started` + 替代行未到 ⇒ 该行文本仍在屏幕上；`npx vitest run <新夹具>` 退出 0。
- [ ] AC2 取假形态：把 `started` 的清空行为改回 ⇒ AC1 红。
- [ ] AC3 `npm run typecheck` 退出 0。

## DoD

忙时发送的消息在替代行到达之前不会从屏幕上消失；这条行的移除由"替代行可见"决定，而不是由"宿主说了 started"决定。

## Touches

- src/modules/chat/hooks/useSessionStore.ts
- src/modules/chat/hooks/useChatComposerState.ts
- src/modules/chat/hooks/tests/useSessionStoreCommandLifecycle.test.tsx
- tasks/gap-chat-lifecycle-started-must-not-blank-message.md

## Notes

与 live-voice-attribution-cannot-rest-on-relayed-text 是同一设计错误：把"替代物已就位"当成"可以移除了"。