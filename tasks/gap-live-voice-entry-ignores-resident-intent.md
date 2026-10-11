---
id: gap-live-voice-entry-ignores-resident-intent
title: Live Voice 入口（enterVoiceMode）不消费 resident 意图：全新会话进 Live Voice 建的会话不会被转成
  resident
status: todo
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

- `src/modules/chat/ChatInterface.tsx:405` 的 `enterVoiceMode`，在全新会话（`voiceSessionId` 为空）分支里：`:417` `createChatSession({ provider, projectPath })` → `handleSessionEstablished(...)` → `:426` `setVoiceModeSession(created.sessionId)`。**全程不读 `residentEnabled`，也从不调 `api.providers.setSessionLifecycleMode`**；其依赖数组 `:440` 为 `[voiceSessionId, selectedProject, provider, handleSessionEstablished, t]`，`residentEnabled` 连作用域都没进——这本身就是这个 bug 的指纹。
- 对照文本发送路径 `src/modules/chat/hooks/useChatComposerState.ts:1036-1051`：新建会话之后 `if (residentEnabled) { await api.providers.setSessionLifecycleMode(provider, targetSessionId, 'resident') … clearResidentIntent?.() }`。resident 从来不是建会话时带的字段，而是建完之后的一次**单独写入**——两份消费路径应当同形，现在只有一份消费。
- 空状态里的 resident 开关（渲染于 `ChatInterface.tsx:898-899`，状态在 `:358`，清理器在 `:533`）是全前端唯一的意图入口。少掉的这一份消费不会有任何报错：开关画着"开"，建出来的却是 per-run 会话。

**为什么这不是小事（本会话实测的后果）**

本会话就是一次真实读数：用户在界面上勾了 resident session，然后进入 Live Voice——实际建出来的是 per-run 会话。其后果在同一天的同一会话里有直接记录：语音交付的指令被服务端拒为 `SESSION_BUSY (recoverable): Claude is still working in this session; your instruction will be sent as soon as it finishes.`，16 秒后被丢弃（`server.log` 的 voice-realtime 会话 `7e8ae374`，2026-10-11T10:12:24Z 与 10:12:40Z）。resident 形态正是"边答边收"的那一种（进程在答案仍在写时即可接住下一条），per-run 形态必然把这类指令挡在门外。也就是说：**用户明确点选的形态被静默丢弃，而它恰是让语音交付不被打回的那一种。**

**要做的事**

1. `enterVoiceMode` 的**新会话**分支在 `createChatSession` 成功之后、`setVoiceModeSession` 之前，按 `residentEnabled` 写一次 `setSessionLifecycleMode(provider, created.sessionId, 'resident')`——与 composer 路径同序、同形。`useChatComposerState.ts:1030-1035` 那段注释里的约束在这里同样成立且必须照办：服务端拒绝 host 进行中的模式切换，所以这次写入必须发生在这条会话的第一个语音轮次开始之前，也就是刚建完、还没有任何轮次的那一刻。
2. 消费语义与 composer 路径对齐：写成功或写失败之后都清意图（`clearResidentIntent`）。清意图的理由与 composer 路径逐字相同——不清理的话，一个陈旧的 "on" 会在下一次 New Session 的空状态上被画出来。写入失败**不能静默**：composer 路径往会话里插一条 error 消息，语音入口已经有一条 `voiceEntryNotice` 可见通道（`:396` 与 catch 分支），两条通道选哪一条由执行者按现状决定，但用户必须看得见。
3. 已有会话分支（`voiceSessionId` 非空）**不动**：resident 意图按既有产品决定只属于新建会话那一次（见 `gap-resident-composer-switch-removed-intent-new-session-only` 的判定），不能因为"这个旧会话正好在语音里"就把它转成 resident。
4. `enterVoiceMode` 的依赖数组补上真正被用到的 `residentEnabled` / `clearResidentIntent`。

**边界（不做）**

- 不恢复、也不新增 composer 上的 resident 开关（既有产品决定，且空状态那个开关已够用）。
- 不改 `useChatComposerState.ts` 文本发送路径的既有语义。
- 不改 `src/modules/chat/utils/sessionCreation.ts` 的会话网关封装（语音入口继续用它）。
- 不处理语音模式下"提问/权限请求没有可作答界面"那个独立缺口——那是另一条任务 `gap-live-voice-pending-request-answer-surface`，机制不同（一个是意图消费缺失，一个是作答面缺失）。

<!-- dedup-ref --> 机制去重（2026-10-11 立案时实测）：`enterVoiceMode` / `liveVoiceNewSessionEntry` / `setSessionLifecycleMode` 在 `tasks/*.md` 全仓的命中里，`gap-live-voice-new-session-entry-allocates-session`（done）建立了这条分配分支、只要求"能进入语音"，未涉及 resident；`gap-resident-composer-switch-removed-intent-new-session-only`（done）把 resident 意图收敛到"新建会话那一次"并删掉 composer 开关，未涉及语音入口。二者与本任务机制不同，都不构成前置。粒度：`task-granularity-advice.js --touches src/modules/chat/ChatInterface.tsx --touches src/modules/chat/tests/liveVoiceNewSessionEntry.test.tsx --touches tasks/gap-live-voice-entry-ignores-resident-intent.md --json` 读数为 `peers: []` / `mentions: []`（无在飞任务声明这些文件），判定 **separate / none found**。

## AC

- [ ] AC1 全新会话 + 空状态 resident 开关为开时点 Live Voice：在 `POST /api/providers/sessions` 之后必须发生一次 `setSessionLifecycleMode(provider, <刚分配的 id>, 'resident')` 写入，且顺序在分配之后。（单测用假 fetch 记录请求序列并断言；先在不改代码的树上跑该用例、把红形态输出原样贴进完成说明，再改代码使其转绿。）
- [ ] AC2 正控制——开关为关时同一条流程不得出现任何 `setSessionLifecycleMode` 调用。
- [ ] AC3 已有会话（`voiceSessionId` 非空）点 Live Voice 时不得出现任何 `setSessionLifecycleMode` 调用。
- [ ] AC4 意图消费：写入发生之后 `residentEnabled` 被清（可在同一单测里断言状态，或断言 `clearResidentIntent` 被调用）。
- [ ] AC5 `npm run typecheck` 通过（`tsc --noEmit`，client 与 server 两个 project 都无错）；`npm run lint:client` 无新增告警。
- [ ] AC6 回归：`bash scripts/with-memory-cap.sh npx vitest run src/modules/chat/tests/liveVoiceNewSessionEntry.test.tsx` 的既有用例保持绿。

## DoD

真实浏览器读数，不是"测试绿"：在一个真实浏览器里，New Session 空状态勾上 resident → 点 Live Voice 进入语音 → 读**这条新建会话确实是 resident**（UI 的 resident 标记 / 状态条，或服务端 `session_get` 的 host 形态读数，执行者二选一并贴原始读数），并且语音交付的第一句话写进了这条会话。同时给出反面对照读数：同一条流程、开关关闭时该会话是 per-run。两组读数都要来自真实运行（截图或原始返回值），不能只给代码推断。

## Touches

- src/modules/chat/ChatInterface.tsx
- src/modules/chat/tests/liveVoiceNewSessionEntry.test.tsx
- tasks/gap-live-voice-entry-ignores-resident-intent.md (self)
