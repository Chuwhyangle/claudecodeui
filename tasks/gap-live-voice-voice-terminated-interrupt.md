---
id: gap-live-voice-voice-terminated-interrupt
title: Live Voice 用语音终止当前回合：voice 工具面加 session_interrupt（绕过单飞与准入闸）、本地停止词兜底、停止后
  backlog 立即开闸且连接与后续输入不受影响
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

### 现状（2026-10-11 逐文件复核，带 file:line）

- **语音面没有任何停止能力**：`VOICE_REALTIME_TOOLS` 被显式 filter 到 `tool.name === 'session_send'`（`server/modules/voice-realtime/voice-realtime-tools.ts:303`，理由见其上方 `:288-302`：其余五个工具「从未被有效使用」且每次响应多付约 600 token）。操作者因此只能排队或被拒——journal `faeb9c61` 里被拒的 8 句，其中一句原文就是「需要为 Live Voice Mode 提供用语音终止之前处理的能力」。
- **停止能力在别处已经存在，不要重建**：MCP gateway 的 `session_interrupt`（`server/modules/mcp-gateway/mcp-gateway.write-tools.ts:196`，标注 `destructiveHint`；handler 在 `mcp-session-lifecycle.ts:36`「stops the run a session currently has and NOTHING ELSE」）；浏览器侧走 `chat.abort` websocket 消息（`src/modules/chat/hooks/useChatComposerState.ts:1524-1541` → `server/modules/websocket/services/chat-websocket.service.ts:1087`）。三者同源于控制服务的 abort 动词。
- **单飞是必须绕开的障碍**：`deliverSessionSend` 在 `sending` 为真时直接 `throw new Error('A previous voice instruction is still being sent.')`（`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:798-813`）。终止指令若走这条路，就会排在它要终止的东西后面——等于没有。
- **终止不能建在撤单上**：`cancelQueuedInput` 在 claude provider 为 `false`（`server/modules/providers/services/provider-capabilities.service.ts:150`），已交给 CLI 队列的消息**撤不回**。故「停止」的诚实语义只能是「停当前 run」，文案不得暗示排队的话被撤销。
- **语音模型在 Claude 忙时不忙**：journal 显示 4 分钟的回合里，语音模型照常约 2 秒回 `OK`、照常调 `session_send`。所以「说话即停」在延迟上完全可行，不需要等助手。

### 人的裁定（2026-10-11，本会话）

- 「用语音终止正在处理的能力」**是必要的**。
- 停止后要**继续接受后续输入**——停当前回合，不丢 backlog。
- 模型必须**持续积极处理**：不给它任何「hold 台词」，它只做中继。

### SCOPE BOUNDARY / 关联

<!-- dedup-ref --> `gap-live-voice-stop-vs-exit-affordances` 做的是**手势与按钮**（running 行停止键、退出键形状与退出语义），本任务做的是**语音指令**这条通路；两者必须复用同一个 abort 实现，不各造一个。`gap-live-voice-queue-byte-budget-and-visible-backlog` 定 backlog 的准入轴；本任务只要求「停止后 backlog 立即开闸」，不改准入。机制检索（`interrupt` / `终止` / `停止键` 于 open 任务）**0 命中**；`task-granularity-advice.js` 报 `peers: []`。

## Plan

1. **工具面**：`VOICE_REALTIME_TOOLS` 加入 `session_interrupt`（复用 `REALTIME_TOOLS` 里已有的同名描述符与其 zod `inputSchema`），`session` 在语音面设为**可选**——与 `session_send` 同一处理与同一理由（连接本身已绑定一个会话，指令要求模型永不指名单个会话；见 `voice-realtime-tools.ts:288-302`）。工具描述压到最短：它每次响应都要付 token。
2. **执行器**：`voice-realtime-live-executor.ts` 接 `session_interrupt`，绑定会话、拒绝别的 session id，调控制服务的 abort 动词（与 `chat.abort` 同源，不新增第二条 abort 路径）。
3. **绕过单飞与准入（本任务的核心不变量）**：`session_interrupt` **不经过** `deliverSessionSend`——不参与 `sending` 单飞、不并入合并窗口、不受字节预算判定。它必须在 `session_send` 仍处于 busy-wait 时也能执行。`voice-realtime-ws-proxy.service.ts` 里为它开一条独立分支。
4. **指令教模型**：`VOICE_REALTIME_INSTRUCTIONS` 增加一条——用户要求停止/取消当前工作时，调用 `session_interrupt`，然后回 `OK`，**不要自己说话**。
5. **本地兜底**：final caption 命中极小停止词表（「停」「停下」「stop」「别做了」）时，前端直接发一个专用帧，中继立刻 abort。理由：模型会听错——本次「Live Voice」先被听成「流氓的」又被改写成「LiveMOT」。新帧走 `src/modules/chat/voice-realtime/voiceRealtimeProtocol.ts` + `useVoiceRealtimeSession.ts` 的 `ServerFrame` 联合（`:48-62`）。
6. **停止后开闸**：abort 成功后，backlog 首条**立刻**投递（不等下一个合并窗口）。
7. **诚实文案**：工具结果与 UI 必须说清「已停止当前回合；已排队的 N 条仍会依次处理」（撤不回，见现状第 4 条）。
8. **静态门**：新增服务端测试文件 ⇒ 同步 `scripts/suite-duration-baseline.tsv` 与 `server/shared/tests/quay-test-script.test.ts`；`npm run typecheck`、`npm run lint`。

## AC

- [ ] AC1 工具面暴露（**取假形态，排在判据文件最前**）：`VOICE_REALTIME_TOOLS` 的名字集合恰为 `['session_send', 'session_interrupt']`。判据 `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-interrupt.test.ts` 退出 0，且该文件**首条断言**即该集合相等。
- [ ] AC2 绕过单飞：在一次 `session_send` 仍在 busy-wait 时调用 `session_interrupt`，它**立即**执行——未抛 `A previous voice instruction is still being sent.`，且 abort 被调用恰一次。判据同 AC1 文件退出 0 并给出该断言。
- [ ] AC3 不受准入闸影响：即使待投递字节已超预算（`VOICE_QUEUE_FULL` 生效中），`session_interrupt` 仍被执行。判据同 AC1 文件退出 0。
- [ ] AC4 只停当前 run：abort 之后，语音连接、麦克风与 backlog 均**未**被终止（**负控**：backlog 长度不变），且 backlog 首条在下一次投递时机立刻发出。判据同 AC1 文件退出 0。
- [ ] AC5 本地兜底：final caption「停」经前端产生停止帧并触发 abort；**负控**：不含停止词的普通句不触发。判据 `npm run test:client -- src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx` 退出 0，含正反两条断言。
- [ ] AC6 镜像与指令：`voice-realtime-tools.ts` 的 `session_send` 镜像逐字段未被破坏（AC-2），且 `VOICE_REALTIME_INSTRUCTIONS` 含该停止指令。判据 `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts` 退出 0。
- [ ] AC7 e2e 证据（**自证；`scripts/test.sh` 的 fan-in 套件不跑 Playwright**）：`npx playwright test e2e/voice-realtime-upload-fixture.spec.ts` 退出 0，含一条「假上游注入停止词 ⇒ 会话收到 abort」的用例。
- [ ] AC8 静态门：`npm run typecheck` 退出 0；`npm run lint` 退出 0；若新增服务端测试文件，`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0。

## DoD

一个**真实对象**被操作过：真实 Live Voice 会话中，Claude 正跑一个长回合时对着麦克风说「停」，该回合**在数秒内真的停住**；随后再说一句，它被正常投递（backlog 开闸）。证据：journal 里 abort 与随后 `session_send` 的相邻行、真实回合时长读数、UI 上「已停止当前回合；已排队的 N 条仍会依次处理」的诚实文案。单元测试必要但不充分。

## Touches

- server/modules/voice-realtime/voice-realtime-tools.ts
- server/modules/voice-realtime/voice-realtime-live-executor.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/voice-realtime-bridge.service.ts (the relay instructions)
- server/modules/voice-realtime/tests/voice-realtime-interrupt.test.ts (new)（本任务主判据文件）
- server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts
- server/modules/voice-realtime/tests/realtime-bridge-harness.ts (only if the tool-surface capture path needs it)
- src/modules/chat/voice-realtime/voiceRealtimeProtocol.ts
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx
- e2e/voice-realtime-upload-fixture.spec.ts
- server/shared/tests/quay-test-script.test.ts (only if the file-count / baseline pins move)
- scripts/suite-duration-baseline.tsv
- tasks/gap-live-voice-voice-terminated-interrupt.md (self)
