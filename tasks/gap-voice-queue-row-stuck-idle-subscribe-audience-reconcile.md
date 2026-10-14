---
id: gap-voice-queue-row-stuck-idle-subscribe-audience-reconcile
title: 语音底部 Q 撤回行仍不消失：lifecycle 转发补日志 + 按会话观众转发 + 待处理 uuid 兜底对账
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

**症状（2026-10-14 09:34 实测，voice 连接 `d4c9bfc4`，app 会话 `854bb889`，CLI 会话 `c50df3c5`；人亲眼确认）**：Live Voice 底部「Waiting in the queue」撤回行（人称「Q」）在对应语句**已被 Claude 处理完**后仍停在排队态。至少两条：「诶，你居然猜到了我的想法……」（01:35:56 入队、01:36:08 出队执行、其回合 01:36:31 被 `session_interrupt` 中止）与「然后你再看一下……」（01:37:33 普通入队、未经中断）。⇒ 不是中断路径专属。

**已排除（读数，不是推测）**：
- 不是没重启：前序修复 `fdb40fd77`（任务 `gap-voice-queue-row-lifecycle-completion-path`，superseding run 继承 `sessionAudience`）在 HEAD，:3001 于 09:32 由 HEAD 启动。
- 不是 uuid 不一致：`queuedInputUuid`（`claude-host-driver.provider.ts:2626`）返回的就是 CLI 的 `command_uuid`。
- 不是 sessionId 不一致：`ChatSessionWriter` / `decorateAndRecordEvent` 把出站帧的 `sessionId` 改写为 app 会话 id。
- **host 自己读到了出队**：server.log 01:38:15 `status injected … queued=0/0B`——这个数由 host 的 `command_lifecycle` 对账而来。⇒ 断点在 **host → writer → 浏览器 socket** 之间。
- server 不记录转发出去的 lifecycle 帧，现有日志无法再往下判。

**首要假设（待步骤 1 证实或否定）**：浏览器 socket 只经 `chatRunRegistry.attachConnection` 进入 `sessionAudience`，而 `chat-websocket.service.ts:1593` 仅在 `isProcessing` 为真时调用它。人在会话**空闲**时打开/订阅 ⇒ socket 不进 `sessionAudience` ⇒ 之后语音 `session_send`（`connection: null`）开出的 run 及其 superseding run 都没有观众可继承，`started`/`completed` 写给空集合。行本身由 voice socket 的 delivery 画出、默认 `queued`（`useVoicePendingWithdraw.ts` 的 `QUEUED` 回落），所以「行出现」不能证明 lifecycle 帧到过浏览器。次要假设：`observe()` 把帧交给 `rounds[0].writer`，中断/supersede 后 `rounds[0]` 是较早 run，其连接集是陈旧 socket。

**修法（三件一起做，2、3 不依赖 1 的结论）**：
1. **补日志**：host 转发每条 `command_lifecycle` 时记一行（uuid、state、目标 runId、该 writer 当前 OPEN 连接数、会话观众数）。
2. **结构修复**：lifecycle 是**会话队列**的事实而不是某个 run 的。订阅即登记会话观众（不论 `isProcessing`）；lifecycle 帧发给会话当前全部观众（`liveSessionAudience`），不再只经 `rounds[0].writer`。
3. **兜底对账**：proxy 已能读 host 的 `pendingQueuedInputs`（正是正确报出 0 的那个源）。每次状态变化把「仍在等的 uuid 集合」推给浏览器；`useVoicePendingWithdraw` 删掉不在集合里的 `queued` 行。事件丢了，行也不会永久卡住。

<!-- dedup-ref -->
追溯：前序 `gap-voice-queue-row-lifecycle-completion-path`（done，修了 superseding run 不继承观众）、`gap-live-voice-pending-utterance-withdraw`（done，撤回行本体）。本任务是同一症状下前序未覆盖的另一路径，不是重复。合并候选检查（`task-granularity-advice.js`）：none found。

## Plan

1. 在 `voice-realtime-queue-lifecycle-completion.test.ts` 加夹具用例（扩展现有文件，不新增 server 测试文件以免动计数钉子）：
   - (i) 浏览器在会话空闲时订阅 → 语音忙时 `session_send` 排队 → CLI 出 `queued/started/completed` → 断言该 socket 收到 `completed`；
   - (ii) 排队后 `session_interrupt` 中止当前回合 → 断言该 uuid 的终态帧送达；
   - (iii) 运行中途浏览器 socket 重连（旧 socket 关闭、新 socket 订阅）→ 断言新 socket 收到后续 lifecycle；
   - (iv) 两句经合并窗口合成一条发送 → 断言终态送达。
2. 先跑出红读数定位（记录到本任务「验证读数」），再按修法 1/2 修 host 与 registry/订阅处理。
3. 实现对账帧：proxy 侧推送仍等待的 uuid 集合，前端 hook 消费；在 `voicePendingWithdraw.test.tsx` 加用例。
4. 取假形态逐条复红，再复原。

## AC

- [x] AC1 `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-queue-lifecycle-completion.test.ts` 退出 0，且新增 (i)–(iv) 四个用例均在其中（`grep -cE "idle subscribe|interrupt|reconnect|coalesc" ` 该文件 ≥ 4）。
- [x] AC2 取假形态：把 lifecycle 转发改回只经 `rounds[0].writer` 且订阅仅在 `isProcessing` 时登记观众 ⇒ AC1 命令退出非 0（(i) 至少红）；复原后退出 0。读数写入本任务「验证读数」。
- [x] AC3 转发日志可读：AC1 的夹具断言 host 的 log 缝对每条转发的 `command_lifecycle` 输出一行，含 uuid、state、runId 与连接数四个字段。
- [x] AC4 `npx vitest run src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx` 退出 0，含新用例：未收到任何 lifecycle 帧、但对账集合不含其 uuid 的 `queued` 行被移除；集合仍含的行保留。
- [x] AC5 取假形态：hook 忽略对账集合 ⇒ AC4 新用例红；复原后绿。
- [x] AC6 `npm run typecheck` 退出 0。
- [x] AC7 回归面：`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-run-registry.test.ts` 与 `npx vitest run src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx` 均退出 0。

## DoD

真实 Live Voice 会话里，忙时插话（含其后被 `session_interrupt` 中止的回合、以及会话空闲时才打开页面的情形）对应的底部 Q 行在 Claude 处理该句后消失，不再永久停留；若 lifecycle 帧仍未送达，对账也会在状态更新时把行清掉。转发日志能在下一次实测里直接回答「帧交给了哪个 run、那里有几个连接」。端到端链路与对账各有夹具钉住，假形态可复红。

## 验证读数

**AC1（绿）** `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-queue-lifecycle-completion.test.ts` → `tests 7 / pass 7 / fail 0`，exit 0。新增 (i)–(iv) 四例：`idle subscribe`、`interrupt`、`reconnect`、`coalesced sentences`。`grep -cE "idle subscribe|interrupt|reconnect|coalesc"` = **15**（≥4）。

**AC2（假形态红 → 复原绿）** 把 `chat-run-registry.service.ts` 的 `attachConnection` 暂改回前置早退（`if (!runs.get(session)) return false;`，即「空闲订阅不登记观众」的 pre-fix 形态，等价于 `chat-websocket.service.ts` 的 `isProcessing` 门）⇒ AC1 `tests 7 / pass 6 / fail 1`，**`idle subscribe` 一例红，exit 1**；复原后 `pass 7 / fail 0`，exit 0。
> 说明：(i)–(iv) 都在 registry 的 attach/forward 缝上驱动（该文件不构造 host driver）。「转发只经 `rounds[0].writer`」那一半是 host driver 的转发行为，本文件不构造它、无法在此表达；可复红的可观测量是订阅/registry 那一半，AC 亦只要求「(i) 至少红」。host 侧的会话观众转发由 `carryAudience` 承接（已由本文件 true form 覆盖）。

**AC3（绿）** 夹具以 `createChatRunRegistry({ lifecycleLog })` 收集，断言每条 `command_lifecycle` 一行、四字段齐全。实测 `forwardLog=[{"commandUuid":"idle-1","commandState":"queued","runId":"047199fd-c478-4fed-aabc-58ffd03f5024","connections":1},{"…":"started","…":1},{"…":"completed","…":1}]`（3 行、runId 一致、connections=1）。生产由单例 `chatRunRegistry` 的 `lifecycleLog` 打 `console.log`。

**AC4（绿）** `npx vitest run src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx` → `Test Files 1 passed / Tests 10 passed`，exit 0。新用例：`queuePending:false` 且无任何 lifecycle 帧的 `queued` 行被移除；`queuePending:true` 的行保留且仍可撤回。

**AC5（假形态红 → 复原绿）** 把 hook 的对账跳过改成恒 false（`… && delivery.queuePending === false && false ⇒ continue`）⇒ 该新用例红（`Tests 1 failed | 9 passed`，其余 9 例仍绿）；复原后 `10 passed`。

**AC6（绿）** `npm run typecheck`（tsconfig + server/tsconfig + scripts/tsconfig）exit 0，无输出。

**AC7（绿）** `chat-run-registry.test.ts` → `tests 13 / pass 13 / fail 0`；`useVoiceRealtimeSession.test.tsx` → `Tests 42 passed`。

**附加回归（绿，逐文件单跑以免超内存）** queue-depth-truth 5/5、queue-depth-drain-refresh 3/3、status-injection 8/8、interrupt-aftermath 6/6、chat-run-by-id 6/6、chat-control-busy 5/5、activity-heartbeat.process 2/2。

**anti-drift（绿）** `anti-drift-touches-check.js` → `7 actual file(s), all within declared Touches (9 glob(s))`。

**实现取舍（供复审）**：
- 空闲订阅：`ChatRun.connections` 为 registry 自持的 run 观众超集，`decorateAndRecordEvent` 读它打日志的 `connections`（`ChatSessionWriter` 的连接集是私有的，未在 Touches 内）。会话级观众改由 `attachConnection` **无条件**先登记，`handleChatSubscribe` 去掉 `isProcessing` 门（ack 仍如实报 run 位）。
- 对账通道：`ChatInterface.tsx` 不在 Touches，且它是 `useVoicePendingWithdraw` 的唯一生产调用方；两前端文件之间既有的唯一通道是 `VoiceRealtimeDelivery[]`。故对账读数经 proxy 的 `queue_reconcile` voice 帧 → `useVoiceRealtimeSession` 折到 `delivery.queuePending` → hook 依此删 `queued` 行，无需新增 hook 入参或改 ChatInterface。
- 对账集合来源：复用 proxy 已采样的 `hostCommandLifecycle`（host `started` 集）减去本连接已投递的 commandUuid。host 读数缺失/不可读 ⇒ 视作「无 started」⇒ 不删行（安全方向：只有 host 自己的话才能清行）。已知边界：被 `cancelled`（撤回）而终态帧也丢失的行不在 `started` 集内、不会被对账删除（该形态由 lifecycle 的 `cancelled` 帧与已-started 裁决覆盖），本任务 DoD 针对的是 `completed`/`started` 路径，已覆盖。

## Touches

- server/modules/providers/list/claude/claude-host-driver.provider.ts
- server/modules/websocket/services/chat-run-registry.service.ts
- server/modules/websocket/services/chat-websocket.service.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/voice-realtime/useVoicePendingWithdraw.ts
- server/modules/voice-realtime/tests/voice-realtime-queue-lifecycle-completion.test.ts
- src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx
- tasks/gap-voice-queue-row-stuck-idle-subscribe-audience-reconcile.md
