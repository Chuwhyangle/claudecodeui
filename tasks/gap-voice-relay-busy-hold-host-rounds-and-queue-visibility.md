---
id: gap-voice-relay-busy-hold-host-rounds-and-queue-visibility
title: Live Voice：忙时 hold 改读宿主 rounds（不再回合中途放行）、CLI 排队期间卡片不消失、两类无害上游错误不再标红
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

**来源：2026-10-14 傍晚第七次 Live Voice 实测**（人称"第三次"；连接 `af12cbaf-9ca7-4218-b0c3-d371ec16ee1d`，app session `3af64b17`，17:51:55–17:56:32 +0800，server build gitSha `d7766ded5`）。人裁定：合并语义、近 40 s 的 hold 时长、打断延迟都可以接受；**真正的问题是"屏幕上的 Queue 空了，user message 却还要再等好几秒才出现"，人会以为消息丢了**。数据来自三处：relay journal `~/.cloudcli/voice-realtime-log/af12cbaf-….jsonl`、`server.log` 里的 `[ChatRunRegistry] command_lifecycle forwarded`、会话 transcript `81379a47-….jsonl` 的 `queue-operation enqueue/dequeue`。三处时间对得上。

**两段队列。** journal 的 `session_send delivered` = CLI **enqueue**，不是消息出现在会话里；要等 CLI 在本轮 `result` 后 dequeue（`command_lifecycle started`），user message 才会出现。本次第二段（relay 放行 → `started`）的读数：12.4 s / 10.4 s / 9.9 s / 8.5 s / **54.5 s** / 3.4 s / 9.8 s。这一段屏幕上什么都不显示。

### A（①）hold 的"忙"改读宿主自己的 rounds

现状：`server/index.ts:830` 的 `hostRunActivity.busy = activityStore.snapshot(id).turn.phase !== 'idle'`。这个 phase 来自 `claude-turn-phase.service.ts` 的 reducer：它没有"回合开始"信号，只有在 `thinking_tokens`、文本 delta、`tool_use` 时才离开 idle；`tool_result` 后恢复到 `phaseBeforeTool`。实测 7 次 busy hold 中有 **4 次在本轮未结束时放行**（53:07.0 和 54:56.7 发生在 Bash 工具执行中途；55:47.9、56:10.6 在回合中途），消息于是掉进 CLI 队列。CLI 在 dequeue 时又把它们拼了一次（53:19 两条、55:51 三条），"一条合并消息"的设计在实际中被绕开了。具体是哪个信号让 phase 变成非 busy 的，没有定位到：放行时没有记录读数。

改法：宿主驱动已经有权威读数——`ClaudeHostDriver` 的 `state.rounds`（"The turn in flight is the front one; interrupted rounds stay until their `result`"，`claude-host-driver.provider.ts:1700`；`:2193` 本身就用 `rounds.length > 0` 判忙）。
1. 在 `claude-host-driver.provider.ts` 加 `runInFlight(appSessionId): boolean | null`：返回 `rounds.length > 0`；不是本驱动托管的会话返回 `null`。写法与 `pendingQueuedInputs` / `startedQueuedCommands` 并列。
2. 在 `provider-runtime.service.ts` 的网关加同名可选方法 `runInFlight(provider, sessionId)`。驱动没实现或抛错时返回 `null`。
3. `server/index.ts` 的 `hostRunActivity`：`busy` **优先**读 `runInFlight`；只有它返回 `null` 时，才退回原来的 activity phase 读数。debug-agent、per-run 会话没有这个读数，所以行为保持不变。`inFlightTool` 照旧读 activity。
4. `voice-realtime-ws-proxy.service.ts` 的放行日志在**原文之后**追加读数后缀，例如 `busy hold released: delivering the ONE merged message (N relayed piece(s)) busy=<false|null> source=<host-rounds|turn-phase>`，让以后每次放行都能审计。原有前缀逐字保留，因为 journal 和测试可能在读它。

### B（②）CLI 排队期间卡片不消失

现状：放行时 relay 发 `pending{text:''}`，卡片 `VoicePendingMessageCard` 随即消失。宿主虽然把 `command_lifecycle queued` 推给了浏览器，但 `applyCommandLifecycleToRows`（`src/modules/chat/hooks/useSessionStore.ts`）遇到本地没有的 uuid 时原样返回，**语音投递在页面上没有对应的行**。`queue_reconcile` 写进 `deliveries[].queuePending` 的值也没有组件渲染——读它的逐行撤回控件已被 2026-10-14 裁定移除。

改法（前端，按 `$frontend-module-standards`）：凡是 delivery 的 `queuePending === true`（宿主还没 dequeue），页面就显示一张只读卡：内容是该次投递的文本，状态文案类似"已送达，等当前回答结束后处理"（i18n key，至少 zh/en）。uuid 离开 reconcile 集合后（宿主 `started`）卡片撤下。**不得**恢复已被裁掉的撤回按钮。屏幕上任一时刻仍然只能有一张"等待中"的卡（沿用 2026-10-14"屏上唯一一张卡"的裁定）：relay hold 的 `pending` 卡和这里的"已送达排队"卡不能同时各画一张，hold 卡优先。

### C（④）两类无害上游事件不再标红

本次浏览器上出现的红条中，人说的"刚才还看见红色的"就是 09:54:54.8 这两条：
- `UNKNOWN_EVENT: conversation.item.deleted`（2 次）。它跟在 relay 自己触发的截断/取消之后，属于预期事件 → 加进 `voice-realtime-bridge.service.ts` 的 `TOLERATED_ENDPOINT_EVENTS`。
- `UPSTREAM_ERROR: Response request cancelled by new input`（2 次）。这是插话打断时上游的正常行为 → 不再作为 `error` 帧发给浏览器，但仍以普通日志行写进 journal，保留审计。
其他 `UPSTREAM_ERROR`、`TRANSCRIPTION_FAILED` 不变。

<!-- dedup-ref --> **相关任务与粒度决定**：`gap-ac345-pending-card-absent-hold-not-engaged`（needs-human）读的是同一个 `readRunBusy` 缝，但问题方向相反：它是 debug-agent e2e 里 hold **从未合上**；本任务是真实 Claude 会话里 hold **提前放开**。A 部分对宿主读数为 `null` 的会话保留原 phase 读数，所以 debug-agent 路径不变，本任务不改 AC-345 的 spec、也不改它的 AC 记录。granularity 工具未发现 Touches 重叠的开放任务（peers=[]）。④ 改动很小，而且和 ①② 同属"relay → 页面这条链路让人以为消息丢了/出错了"，所以并入本任务。③（上行门控 pre-roll）是不同模块、验收方式也不同，另立 `gap-voice-uplink-vad-gate-onset-preroll`。

## AC

- [x] AC1（宿主读数）：`grep -n "runInFlight" server/modules/providers/list/claude/claude-host-driver.provider.ts server/modules/providers/services/provider-runtime.service.ts` 两个文件都有输出；`server/modules/providers/tests/provider-runtime.service.test.ts` 有用例覆盖三种读数——有 round 在飞时为 `true`、`result` 之后为 `false`、非托管会话为 `null`（`grep -n "runInFlight" server/modules/providers/tests/provider-runtime.service.test.ts` 有输出），并且 `npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/providers/tests/provider-runtime.service.test.ts` 退出 0。
- [x] AC2（hold 不在回合中途放行）：`server/modules/voice-realtime/tests/voice-realtime-single-pending-message.test.ts` 新增用例：activity phase 读数为 idle（模拟工具执行中、或 `tool_result` 后的空档），但宿主 rounds 读数为 busy——这期间**零投递**，并且一直显示 `pending`；宿主读数翻成 `false` 之后**恰好一次**投递，内容是合并后的文本。`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/voice-realtime/tests/voice-realtime-single-pending-message.test.ts` 退出 0，pass 数记入 `## Notes`。
- [x] AC3（接线与可审计）：`grep -n "runInFlight" server/index.ts` 有输出（位于 `hostRunActivity` 内）；`grep -n "source=" server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts` 能看到放行日志里的 `busy=… source=…` 后缀；放行日志原有前缀 `busy hold released: delivering the ONE merged message` 仍逐字存在（`grep -c` ≥ 1）。
- [x] AC4（假形态）：把 `server/index.ts` 的 busy 临时改回只读 activity phase，再单跑 AC2 的测试文件，新增用例**必须红**；复原后再变绿。红、绿两组读数都逐字记入 `## Notes`（改动不提交）。
- [x] AC5（CLI 排队期间卡片不消失）：`src/modules/chat/voice-realtime/tests/` 下有 vitest 用例按以下帧序驱动：`pending{text}` → `pending{text:''}` → `sent` → `queue_reconcile` 含该投递的 uuid。断言全程每一刻都恰好有一张等待卡，并且显示该文本和"已送达排队"状态；之后再来一帧不含该 uuid 的 `queue_reconcile`，卡片消失。`bash scripts/with-memory-cap.sh npx vitest run src/modules/chat/voice-realtime/tests/voicePendingMessageCard.test.tsx src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx` 退出 0。
- [x] AC6（两类无害事件不标红）：`server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts` 有用例证明：`conversation.item.deleted` 不产生 fault；`error` 帧的 message 为 `Response request cancelled by new input` 时不向浏览器发 `UPSTREAM_ERROR`，但 journal/log 有对应行；其他上游 `error` 仍然是 `UPSTREAM_ERROR`（反向腿）。`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts` 退出 0。
- [x] AC7（不削弱既有判据）：`npm run typecheck` 与 `npm run lint` 各自退出 0；按 AGENTS.md 加载 `$backend-module-standards` 和 `$frontend-module-standards`；单跑 `server/modules/voice-realtime/tests/voice-realtime-queue-depth-truth.test.ts` 和 `server/modules/voice-realtime/tests/voice-realtime-interrupt.test.ts` 退出 0。

## DoD

在真实的 `ClaudeHostDriver` 回合模型上，relay 的"忙"由宿主自己的 rounds 决定：常驻 Claude 会话执行工具或思考期间，人说的话一直留在 relay 的 hold 里，回合 `result` 之后才作为**一条**消息进入 CLI，并立即被取出。如果某条消息仍然在 CLI 队列里，页面上有一张写着原文和"已送达排队"的卡，直到宿主报告 `started`，中间不出现空白期。`conversation.item.deleted` 和"cancelled by new input"不再在页面上标红，但 journal 里仍有记录。证据是 AC2 的正形态和 AC4 的假形态两组读数——不是改宽等待时间换来的。人下一次实测时，在 server.log 里核对 `command_lifecycle queued → started` 的间隔：语音消息在 relay 放行后应几乎立即 `started`（这一条是人的观察项，不作为执行侧 AC）。

## Touches

- server/modules/providers/list/claude/claude-host-driver.provider.ts
- server/modules/providers/services/provider-runtime.service.ts
- server/modules/providers/tests/provider-runtime.service.test.ts
- server/index.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/voice-realtime-bridge.service.ts
- server/modules/voice-realtime/index.ts
- server/modules/voice-realtime/tests/voice-realtime-single-pending-message.test.ts
- server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts
- src/modules/chat/ChatInterface.tsx
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/voice-realtime/VoicePendingMessageCard.tsx
- src/modules/chat/voice-realtime/tests/voicePendingMessageCard.test.tsx
- src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx
- src/modules/i18n/locales/zh-CN/chat.json
- src/modules/i18n/locales/en/chat.json
- tasks/gap-voice-relay-busy-hold-host-rounds-and-queue-visibility.md

## Notes

（执行者在此记录 AC2/AC4/AC5 的逐字读数。）

- 2026-10-14 立案后修正：Touches 的 locale 路径原写 `src/i18n/locales/…`（不存在），已改为 `src/modules/i18n/locales/{zh-CN,en}/chat.json`。修正在任务派发之后才落到 develop；若 worktree 里的任务文件还是旧路径，请先 merge 一次 develop 再开工，否则 anti-drift 会把 locale 改动判为越界。

### 执行读数（2026-10-14 夜）

**Touches 新增两处（经 task ABI 追加，均为本任务必需）**：
- `server/modules/voice-realtime/index.ts`（模块 barrel）：`composeHostRunActivityReading` 与类型 `HostRunActivityReading` 必须经 barrel 导出，`server/index.ts` 才符合后端模块边界（只经 `index.ts` 跨模块导入）。
- `src/modules/chat/ChatInterface.tsx`：卡片唯一渲染点，必须把新的 `voice.queuedDeliveryText` 传给 `VoicePendingMessageCard`（原计划漏列）。

**AC1（宿主读数）**：`npx tsx … --test server/modules/providers/tests/provider-runtime.service.test.ts` → `pass 9 / fail 0`，退出 0（新增两条 `runInFlight` 用例：true/false + 五路 null）。

**AC2（正形态）**：新增用例 `AC2: the host rounds keep the hold through a phase-idle turn, and release it once when the turn ends`。驱动方式：`wire()` 现在按生产规则组合读数——`hostRunActivity` 调 `composeHostRunActivityReading({ roundsBusy, turn: { phase, toolName } })`（与 `server/index.ts` 的 `hostRunActivity` 同一条规则）。`npx tsx … --test server/modules/voice-realtime/tests/voice-realtime-single-pending-message.test.ts` → `tests 6 / pass 6 / fail 0`，退出 0。

**AC4（假形态，改动未提交）**：把 busy 规则临时改回"只读 activity phase"——即把 `composeHostRunActivityReading` 里的宿主优先分支去掉，只留 `busy = turn.phase !== 'idle'`（这正是 `server/index.ts` 的 `hostRunActivity` 所委托的那条规则；规则提取到该函数就是为了让它可被 AC2 的测试文件驱动）。同一条命令读数：
```
✖ AC1(a) … ✖ AC1(b) … ✖ AC1(c) … ✖ AC1(d) … ✔ AC1(e) … ✖ AC2: the host rounds keep the hold through a phase-idle turn, and release it once when the turn ends
ℹ tests 6 / pass 1 / fail 5
```
新增用例（AC2）红 — 满足。复原后再跑同一命令 → `pass 6 / fail 0` 变绿。（说明：AC4 原文写"改 `server/index.ts` 的 busy"；因 `server/index.ts` 不可被测试导入（`startServer()` 在模块加载即执行），busy 规则被提取到 `composeHostRunActivityReading`，`server/index.ts` 的 `hostRunActivity` 调用它并在其内解析 `runInFlight`——假形态施加在该规则函数上，即同一读数的同一处。）

**AC5（排队卡片不消失）**：在 `voicePendingMessageCard.test.tsx` 新增 `describe('the delivered-waiting card (AC5)')` 三条用例，经 `BarOverHook`（按 `ChatInterface` 的接线：`text={voice.pendingMessage} queuedText={voice.queuedDeliveryText}`）驱动帧序 `pending{text}` → `pending{text:''}` → `sent` → `queue_reconcile{[uuid]}` → `queue_reconcile{[]}`。`bash scripts/with-memory-cap.sh npx vitest run src/modules/chat/voice-realtime/tests/voicePendingMessageCard.test.tsx src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx` → `Test Files 2 passed (2) / Tests 53 passed (53)`，退出 0。

**AC6（两类无害事件）**：`voice-realtime-bridge.test.ts` 新增 `AC6: a deleted item and a "cancelled by new input" error are not failures — but another upstream error still is`，经 shipping proxy + fake upstream 断言：`conversation.item.deleted` 与 `cancelled by new input` 下 `errorFrames(socket)` 为空、journal 有 `upstream-cancelled-by-new-input` 行；反向腿普通 `error` 仍发 `UPSTREAM_ERROR`。`npx tsx … --test server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts` → `tests 16 / pass 16 / fail 0`，退出 0。

**AC7**：`npm run typecheck` 退出 0；`npm run lint` 退出 0（仅存量 warning）；`npx tsx … --test voice-realtime-queue-depth-truth.test.ts voice-realtime-interrupt.test.ts` → `tests 19 / pass 19 / fail 0`。已按 AGENTS.md 加载 `$backend-module-standards` 与 `$frontend-module-standards`。
