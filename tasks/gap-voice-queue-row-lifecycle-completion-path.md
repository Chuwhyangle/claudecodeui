---
id: gap-voice-queue-row-lifecycle-completion-path
title: 语音「Waiting in the queue」撤回行累积不消：定位并修复 CLI command_lifecycle 的 completed 到不了浏览器
status: ready
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

**定位结论（哪些层被排除，缺的到底是哪一层）**：

- (b) **规范化排除**。`readCommandLifecycleState` 接受四态、`normalizeMessageRows` 对两种信封（顶层 `type: command_lifecycle` 与 `type: system + subtype: command_lifecycle`）都产出一帧 `kind: command_lifecycle` 且带 `commandUuid` / `commandState`。规范化本身正确。
- (a) **CLI 是否发这行不再是阻塞点**：夹具直接把 CLI 的原始行喂进驱动真正的 normalize-and-forward 缝（`forwardNormalizedFrames`），链路仍断。
- (c) **命中：订阅者这一层（run 的观众）**。一张浏览器 socket 进入某个 run 的 writer 只有一条路——`chatRunRegistry.attachConnection`，而它只被 `handleChatSubscribe` 在 `isProcessing` 时调用。语音/MCP 的 `session_send` 用 `connection: null` 派发；而常驻会话里一句「在轮中到达」的话会开一个 **superseding run**，那个 run 的新 writer 同样是 `connection: null`，并且**从不继承被顶掉那个 run 的 connections**。于是驱动的路由：排队命令的 `queued` 帧走**前一个** run 的 writer（浏览器正在其上）→ 行出现；而它的 `started` / `completed` 帧走 **superseding** run 的 writer（观众为空）→ 行永远不消。这正是「1 行涨到 3 行且都不消失」。

## Plan

1. 写 driver 级夹具：语音 `session_send` 排队 → CLI 流里出现 `command_lifecycle: completed` → 断言它被规范化并推给客户端。
2. 夹具红/绿的读数直接指出是哪一层；据此修。
3. 修完复跑确认绿，并回跑 `voicePendingWithdraw.test.tsx` 确认客户端侧未被动。

**修法**：观众属于**会话**而不是某个 run 的化身。`chat-run-registry.service.ts` 里新增一张按会话记录的 socket 表 `sessionAudience`：`attachConnection` 在交给当前 run 的同时把这个 socket 记在会话名下；`startRun` 建好新 writer 后，把该会话仍 `OPEN` 的 socket（顺带剪掉已关闭的）交给新 writer。跨 run 变更时在看这个会话的人继续收到它的帧。新增工厂选项 `carryAudience`（默认 `true`），置 `false` 即复现修前形态，作为夹具的假形态。

## AC

- [x] AC1 新夹具断言上述链路端到端可达；`npx tsx --tsconfig server/tsconfig.json --test <新夹具>` 退出 0。
- [x] AC2 取假形态：把 `completed` 行的规范化或推送去掉 ⇒ AC1 红。
- [x] AC3 `npm run typecheck` 退出 0。
- [x] AC4 `npx vitest run src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx` 仍退出 0。

## 验证读数

新夹具 `server/modules/voice-realtime/tests/voice-realtime-queue-lifecycle-completion.test.ts`，三条读数：

- 假形态（`createChatRunRegistry({ carryAudience: false })`）：`lifecycleStates=["queued"]` —— 行出现、永不消。
- 真形态（默认 registry，同一驱动序列）：`lifecycleStates=["queued","started","completed"]`，末帧 `commandUuid` 与 `sessionId` 都对（CLI 原生 id 已重映射为 app session id）。
- 端到端：真 `createChatControlService` 走忙时语音 `session_send` 拿回 `queued: true` + `queuedMessageUuid`，CLI 的三行经真 `ClaudeSessionsProvider().normalizeMessage` + `forwardNormalizedFrames` 推给浏览器：`uuid=spoken-command-2 lifecycleStates=["queued","started","completed"]`。

- AC1：上面三条命令 `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-queue-lifecycle-completion.test.ts` → `tests 3 / pass 3 / fail 0`，退出 0。
- AC2：把 `carryAudience` 默认临时改为 `false` 复跑 → 真形态读作 `["queued"]`、端到端读作 `[]`，`pass 1 / fail 2`，退出 1；改回 `true` 后复跑恢复退出 0。（修前未实现时同一夹具同样是这个红读数。）
- AC3：`npm run typecheck`（tsc × 3 个 project）退出 0。
- AC4：`npx vitest run src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx` → `1 passed (1) / 9 passed (9)`，退出 0。
- 回归面：改动共享 registry，回跑 `chat-run-registry.test.ts` + `chat-run-by-id.test.ts` + `chat-control-busy.test.ts` → `tests 24 / pass 24 / fail 0`。
- 计数钉子：新增 server 夹具使 collected 317→318，`server/shared/tests/quay-test-script.test.ts` 两处 literals 同步 +1（AC2 `unknown=314→315`、AC3 `unknown=316→317`）；单文件复跑 `tests 11 / pass 11 / fail 0`，退出 0。

## DoD

一条语音排队投递在 CLI 开始并完成之后，其撤回行会在浏览器端消失，不再永久累积；端到端链路有夹具钉住。

## Touches

- server/modules/providers/list/claude/claude-sessions.provider.ts
- server/modules/providers/list/claude/claude-host-driver.provider.ts
- server/modules/websocket/services/chat-run-registry.service.ts
- src/modules/chat/voice-realtime/useVoicePendingWithdraw.ts
- server/modules/voice-realtime/tests/voice-realtime-queue-lifecycle-completion.test.ts
- server/shared/tests/quay-test-script.test.ts
- tasks/gap-voice-queue-row-lifecycle-completion-path.md

## Notes

与 gap-voice-unforwarded-utterance-visible-disposition 同属"终态必须对浏览器可见"这一类，但两者的机制不同（这条是 CLI 队列行，那条是模型处置），因此**两条之间没有关系边**。两者可能都改 `voice-realtime-ws-proxy.service.ts`，文件重叠交由工作树与合并机制处理。

**未触动的声明的文件**：`claude-sessions.provider.ts` 与 `claude-host-driver.provider.ts` 只被读来定位（两者都正确），`useVoicePendingWithdraw.ts` 的客户端契约本就绿；本任务的实现改动只落在 `chat-run-registry.service.ts` 与新夹具上。
