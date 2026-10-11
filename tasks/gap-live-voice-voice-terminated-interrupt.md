---
id: gap-live-voice-voice-terminated-interrupt
title: Live Voice 用语音终止当前回合：voice 工具面加
  session_interrupt（绕过单飞与准入闸）、模型自主判断（无关键词映射）、语音 socket 不接受客户端可发的 interrupt
  帧（唯一中止入口）、停止后 backlog 立即开闸
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

- **语音面没有停止能力**：`VOICE_REALTIME_TOOLS` 被显式 filter 到 `tool.name === 'session_send'`（`server/modules/voice-realtime/voice-realtime-tools.ts:303`），操作者只能说进队列或被拒——journal `faeb9c61` 里被拒的 8 句，其中一句原文就是「需要为 Live Voice Mode 提供用语音终止之前处理的能力」。
- **停止能力在别处已经存在，不要重建**：MCP gateway 的 `session_interrupt`（`mcp-gateway.write-tools.ts:196`，`destructiveHint`；handler `mcp-session-lifecycle.ts:36`「stops the run a session currently has and NOTHING ELSE」）；浏览器侧另有 `chat.abort`（`useChatComposerState.ts:1524-1541`）。
- **单飞是必须绕开的障碍**：`deliverSessionSend` 在 `sending` 为真时直接 throw（`voice-realtime-ws-proxy.service.ts:799-813`），终止指令若走这条路就排在它要终止的东西后面。
- **终止不能建在撤单上**：`cancelQueuedInput` 在 claude 为 `false`（未测量），已交给 CLI 队列的消息撤不回。

### 人的裁定（2026-10-11，晚于本任务立案）

**D-2 / C-1 / C-2**（规范全文：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.2、§5、§6.2、§10，已合入 develop `ac5c4de5`）：

- 语音面**唯一**的中止元语是 `session_interrupt`，由 **realtime model 自主决定**调用；
- **不存在**关键词表、本地停止词兜底、或任何"用户说了 X ⇒ 必然 abort"的确定性映射；
- 确定性只存在于 **UI**（running 行停止键 / Esc，走 `chat.abort`，不经语音 socket）。

⚠️ 本任务立案时的 Plan 第 5 步（本地停止词兜底）与 AC5/AC7 **违反该裁定**，已在本任务内移除并改写为"不存在第二中止入口"。

<!-- dedup-ref --> 机制去重（立案时实测）：open 任务对 `interrupt` / `终止` / `停止键` 0 命中；`task-granularity-advice.js` 报 peers `gap-live-voice-status-aggregate-and-inject` 等（共触 `voice-realtime-ws-proxy.service.ts`），由调度器串行，**keep separate**。

## Plan

1. **工具面**：`VOICE_REALTIME_TOOLS` 加入 `session_interrupt`（复用 `REALTIME_TOOLS` 里的同名描述符），`session` 在语音面设为**可选**（连接已绑定会话）。工具描述压到最短。
2. **执行器**：`voice-realtime-live-executor.ts` 接 `session_interrupt`，绑定会话、拒绝别的 session id，走控制服务的 abort 动词（与 `chat.abort` 同源）。
3. **绕过单飞与准入**：**不经过** `deliverSessionSend`——不参与 `sending` 单飞、不并入合并窗口、不受准入闸判定。
4. **指令教模型**：`VOICE_REALTIME_INSTRUCTIONS` 增加一条——**你判断用户想停止当前执行时**调用 `session_interrupt`，然后回 `OK`。⛔ 指令层**不得**出现条件式关键词映射。
5. **唯一中止入口（本任务修正项）**：移除客户端→服务端的 `{ type: 'interrupt' }` 帧——它的联合体成员、`readVoiceRealtimeInboundFrame` 分支、以及那个调用 `sessionInterrupt({})` 的 handler。该帧原本是本地停止词兜底的传输，`src/` 已无发送方，UI 的确定性停止走另一条 socket（`chat.abort`），故它是**可达的第二中止入口**，必须去掉。
6. **停止后开闸**：abort 成功后 backlog 首条**立刻**投递（不等下一个合并窗口）。
7. **诚实文案**：说清「已停止当前回合；已排队的 N 条仍会依次处理」（撤不回）。
8. **静态门**：同步 `quay-test-script.test.ts` 的 `unknown=` 钉子与 `scripts/suite-duration-baseline.tsv`；`npm run typecheck`、`npm run lint`。

## AC

- [x] AC1 工具面暴露（**取假形态，排在判据文件最前**）：`VOICE_REALTIME_TOOLS` 的名字集合恰为 `['session_send', 'session_interrupt']`。判据 `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-interrupt.test.ts` 退出 0，且该文件**首条断言**即该集合相等。
- [x] AC2 绕过单飞：一次 `session_send` 仍在 busy-wait 时调用 `session_interrupt`，它**立即**执行（未抛 `A previous voice instruction is still being sent.`），abort 恰一次。
- [x] AC3 不受准入闸影响：即使队列已达上限（`VOICE_QUEUE_FULL` 生效中），`session_interrupt` 仍被执行。
- [x] AC4 只停当前 run 且不是拆卸：**由模型调用工具触发**（`deliverFunctionCall(…, 'session_interrupt', {})`）⇒ abort 恰一次；语音连接与上游均**未**被关闭；backlog 被计数（`depth` 在释放前读取）且首条**立刻**投递；拒绝帧计数为 0。
- [x] AC5 **不存在第二中止入口**（替代原"本地兜底"）：语音 socket 的入站帧联合体**不含**任何客户端可发的 interrupt 帧；`src/` 中发送该帧的代码计数为 **0**；全链路只有一处 `sessionInterrupt` 调用点，且只能由工具触发。判据：interrupt 判据文件退出 0 + `grep -rn "type: 'interrupt'" src/ server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts` 计数为 0。
- [x] AC6 镜像与指令：`voice-realtime-tools.ts` 的 `session_send` 镜像逐字段未被破坏（AC-2）；`VOICE_REALTIME_INSTRUCTIONS` 含停止指令且**不含**关键词条件式。判据 `… --test server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts` 退出 0。
- [x] AC7 词表钉子的连带更新：本任务新增工具使语音面工具数 1→2，四个钉子已同步为 `['session_send','session_interrupt']` 语义：`voice-realtime-log-wiring.test.ts`（3/3）、`voice-realtime-empty-transcript-guard.test.ts`（17/17）、`voice-realtime-ws-proxy.real-transport.test.ts`（13/13）、`mcp-production-session-wiring.test.ts`（5/5）。
- [x] AC8 静态门：`npm run typecheck` 退出 0；`npm run lint` 退出 0；`… --test server/shared/tests/quay-test-script.test.ts` 退出 0。

## DoD

一个**真实对象**被这套机制操作过：真实 Live Voice 会话中，Claude 正跑长回合时**由模型调用 `session_interrupt`**（或用户在 UI 按 running 行停止键），该回合在数秒内真的停住；随后再说一句，它被正常投递（backlog 开闸）。并且**不存在**第二个中止入口——语音 socket 不接受任何客户端可发的 interrupt 帧。证据：journal 里 abort 与随后 `session_send` 的相邻行、真实回合时长读数、UI 上「已停止当前回合；已排队的 N 条仍会依次处理」的诚实文案。

## 验证记录

**实现（worktree `.claude/worktrees/gap-live-voice-voice-terminated-interrupt`，分支 `task/gap-live-voice-voice-terminated-interrupt`）。** worker 落地 `f981e812 feat(voice-realtime): stop the current turn by voice`（工具 + executor + 绕过单飞/准入 + 诚实回执 + `server/index.ts` 装配）。

**语义修正（人裁定后，2026-10-11）**：
- `bbca2901 fix(voice-realtime): stop the turn only through the model's session_interrupt` —— 移除**前端本地停止词兜底**：`useVoiceRealtimeSession.ts` 的 `LOCAL STOP` 块与 `stopSentRef`、`voiceRealtimeProtocol.ts` 的 `VOICE_STOP_WORDS`/`normaliseUtterance`/`isVoiceStopUtterance`/`voiceInterruptFrame`、客户端停止词用例 3 条、`e2e/voice-realtime-upload-fixture.spec.ts` 的停止词用例（该文件已回到 feature base 逐字节相同）。
- `d03702bb fix(voice-realtime): remove the browser-sendable interrupt frame` —— 移除**服务端仍可被浏览器触发的第二中止入口**：入站联合体成员 `{ type: 'interrupt' }`、`readVoiceRealtimeInboundFrame` 分支、调用 `sessionInterrupt({})` 的 handler（共 −30 行）；AC4 的断言**全部保留**，只把触发从"页面发帧"改为"模型调用工具"。

**测试（`env -u VOICE_REALTIME_MODE`，与 fan-in 条件一致）**：`voice-realtime-interrupt.test.ts` **5/5**；四个词表钉子 **3/3、17/17、13/13、5/5**；客户端 `useVoiceRealtimeSession.test.tsx` **34 passed**；`npm run typecheck` **exit 0**。既有 flake `voice-realtime-upstream-pool.test.ts` 复跑 **7/7**（未复现、未编辑）。

**第一次 fan-in 失败归因**：`suite-end exit=1 "suite red"`，红的是本任务自己造成的词表钉子（新增工具后未同步）——已在 `bbca2901` 内修好；`voice-realtime-upstream-pool` 的 `idleMs=29` 是既有 ~10% 墙钟 flake，非本任务之过。

**后续 fan-in 失败归因（2026-10-11 晚，`b06df09d` 修）**：prompt 记的"末次失败＝ upstream-pool `idleMs=29`"取自最旧的 21:17 日志；实际最新两次 suite 日志（22:51、22:56）只红一个**本任务 Touches 内**的文件 —— `voice-realtime-empty-transcript-guard.test.ts` 的 AC5：`Error: waitFor: condition not met within 2000ms`（第 414 行，等 `ready{segmented-v1}`）。逐因定位（单文件复跑、非全量）：该文件 `wire()` 未传 `segmentedRelay` seam，连接回落到环境变量 `VOICE_REALTIME_MODE`（`voice-realtime-ws-proxy.service.ts:785`）；`segmentedRelay` 为假时不发 `ready`，该等待必然 2000ms 超时。判据复现：干净 env **17/17 绿**、`VOICE_REALTIME_MODE=continuous` 下 **16/17 红且与 fan-in 逐字节同签名**。该 21:17→22:51 的环境翻转与 memory `session-shell-exports-voice-realtime-env` 记录的会话污染窗口吻合。修复：`wire()` 显式 `segmentedRelay: true`（与 `voice-realtime-log-wiring.test.ts:154` 同款旁路）——干净 env 下行为等价（原本即 true），只是不再依赖环境；该文件测的是分段守卫、不是模式解析（后者归 `voice-realtime-segmented-default.test.ts`）。修后两种 env 均 **17/17**。

**本轮复核（2026-10-11 晚，`env -u VOICE_REALTIME_MODE`，逐文件单跑）**：interrupt **5/5**、bridge **7/7**、live-executor **4/4**、log-wiring **3/3**、real-transport **13/13**、mcp-production-session-wiring **5/5**、empty-transcript-guard **17/17**、quay-test-script **11/11**；客户端 `useVoiceRealtimeSession.test.tsx` **36 passed**；`npm run typecheck` **exit 0**；`npm run lint` **exit 0**（仅既有 warning）。AC5 的 grep 计数 **0**，唯一 `sessionInterrupt` 调用点在 `voice-realtime-ws-proxy.service.ts`。

**范围外**：未跑全量 suite（会话 cgroup 8 GiB，全量只在 fan-in 跑）；未跑 Playwright；未跑真实服务 DoD。

## Touches

- server/modules/voice-realtime/voice-realtime-tools.ts
- server/modules/voice-realtime/voice-realtime-live-executor.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/voice-realtime-bridge.service.ts (the relay instructions)
- server/modules/voice-realtime/tests/voice-realtime-interrupt.test.ts (new)（本任务主判据文件）
- server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts
- server/modules/voice-realtime/tests/realtime-bridge-harness.ts (only if the tool-surface capture path needs it)
- server/modules/voice-realtime/tests/voice-realtime-log-wiring.test.ts
- server/modules/voice-realtime/tests/voice-realtime-empty-transcript-guard.test.ts
- server/modules/voice-realtime/tests/voice-realtime-ws-proxy.real-transport.test.ts
- server/modules/mcp-gateway/tests/mcp-production-session-wiring.test.ts
- src/modules/chat/voice-realtime/voiceRealtimeProtocol.ts
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx
- e2e/voice-realtime-upload-fixture.spec.ts
- server/index.ts
- server/shared/tests/quay-test-script.test.ts (only if the file-count / baseline pins move)
- scripts/suite-duration-baseline.tsv
- tasks/gap-live-voice-voice-terminated-interrupt.md (self)
- server/modules/voice-realtime/tests/voice-realtime-live-executor.test.ts
- src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx
