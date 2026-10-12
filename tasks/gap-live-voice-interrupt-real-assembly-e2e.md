---
id: gap-live-voice-interrupt-real-assembly-e2e
title: 语音 session_interrupt 走真实装配链到常驻
  host（live-executor→网关→control.abort→provider-runtime→hostDriver.interrupt），只假
  host；钉住 server/index.ts 未接 hostCommandLifecycle 的已知缺口（AC-343 验证深度加深）
status: ready
labels:
  - gap
parent: null
children: []
extra: {}
goal_ac: AC-343
---
## Proposal

**性质：已 `done` / `achieved` 的 AC 的验证深度加深，不重开 GOAL-041 的退出条件。** 与 `gap-ac345-gate-deadline-below-criterion-wallclock`、`gap-ac351-criterion-ledger-red-is-merge-race` 同一精神：判据已绿，但它证明的东西比标题窄。

### 现状：停止的「逻辑」被证明了，「接线」从未被证明

AC-343（栅栏）、AC-342（先入队后中断）及 AC-339/344 的全部服务端判据——`voice-realtime-interrupt.test.ts`、`voice-realtime-interrupt-fence.test.ts`、`voice-realtime-interrupt-revision-order.test.ts`（本轮手跑 18 pass / 0 fail）——都把真 proxy（`handleVoiceRealtimeConnection`）接在**测试文件里手写的执行器**上，其 `session_interrupt` 直接回 `{aborted:true}`（如 `createStopExecutor`、`createFenceExecutor`、`createFakeBase`）。没有任何 voice-realtime 判据调用过 `createVoiceRealtimeLiveExecutor`、网关的 `buildSessionInterrupt`、`createChatControlService().abort` 或 `createProviderRuntimeService().abort` 的 resident 分支。离它最近的真实链证据是 MCP 侧的 `server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts` (d)/(e)（HTTP + MCP SDK + debug-agent），而语音不走 HTTP/MCP SDK——它在进程内直接调 `buildSessionInterrupt`。

### 本轮发现的生产缺口（立 Task B 跟进，本任务只钉住）

`server/index.ts` 的 `buildVoiceRealtimeSeams`（约 :538–:793）只接了 `hostQueueReading:`（约 :744）与 `hostRunActivity:`（约 :759），**全文没有 `hostCommandLifecycle`**。于是生产里 `refreshInterruptCovers()` 恒见 seam 为 `undefined`，`coveredSeqs` 永远为空，`decideModelInterrupt` 的 covered 半边（`max(covers) >= triggerSeq`）是死代码，只有幂等半边（同一 `triggerSeq` 只执行一次）在生效。既有判据都在自己的 harness 里手动注入该 seam，所以一直没有发现。（`gap-live-voice-scripted-scenarios-interrupt-covered-regression` 的 Notes 曾顺带记过这一事实，但没有立案跟进。）此外生产也还没有可以接的读数：claude host driver 在进程内记录了 `command_lifecycle` 事件（`claude-host-driver.provider.ts` 的 `lifecycle: CommandLifecycleEvent[]`），但 `provider-runtime.service.ts` 没有对外暴露它（只有 `pendingQueuedInputs`），所以 Task B 不是只改一行接线。

### 做法

在**既有**的 `voice-realtime-interrupt.test.ts` 里追加一块「real assembly」（不新建 `*.test.ts`，避开 `server/shared/tests/quay-test-script.test.ts` 的文件计数钉子——当前至少还有两个在飞任务要改它）。链路按 `server/index.ts` 的装配方式搭：

`假上游 function_call → handleVoiceRealtimeConnection（真 proxy/栅栏/G1）→ createVoiceRealtimeLiveExecutor（真）→ buildSessionInterrupt / buildSessionSend（真网关；sessionInterrupt 用生产同款 buildSessionInterruptDeps）→ createChatControlService（真，默认 access entry）→ createProviderRuntimeService（真 resident 路由）→ hostDriver.interrupt(host, sessionId)`

**唯一的假件是常驻 host**：通过 `createProviderRuntimeService({ resolveProvider, sessionHostManager })` 注入（只覆写这两个依赖）。resident 判定的三件事全部走真实读数：`claude` 在能力表里静态声明 `['per-run','resident']`；会话行写在**真实临时 sqlite**（`sessionsDb.createSession` + `setSessionLifecycleMode(id,'resident')`），由默认的 `resolveSessionLifecycleMode` 读回；driver 带 `run` 入口。语音的 `session_send` 也走真实链（control.send → dispatchRun → runtime.run → resident `run`）；busy 写入拿到 host 自己盖的 uuid（`queuedInputUuid`）。`hostQueueReading` 的接法与生产一致：`runtime.pendingQueuedInputs('claude', id)`。

## Plan

1. 读既有 harness（`FakeBrowserSocket` / `createFakeTransport`）与 lifecycle 判据 (d)/(e) 的读数格式；2. 写假 resident host（pid 恒为 4242；分别计数 `interrupt` 调用次数与实际中止的 round 数；记录每轮输入与有序事件日志）；3. `withRealChain` harness（临时 DB、真 control/runtime/executor、可选注入 `hostCommandLifecycle`）；4. 写用例 (a)–(e)；5. 单文件跑 3 次，再跑 typecheck / lint。

## AC

- [x] AC1：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-interrupt.test.ts` 退出 0，**13 pass / 0 fail**（原 5 条 + 新 8 条），连跑 3 次结果一致。
- [x] AC2（a，RUNNING→ABORTED，读数）：真链 `session_interrupt{intent}` ⇒ `aborted:true`；host 的 `interrupt` 恰好被调 1 次，并中止 1 个 round；pid 前后都是 4242；host 中止后仍 live；`requestAbort=0`（没有关闭 host），`perRunAbort=0`（走的是 resident 路由）；registry 中 run 状态 `running→aborted`；`stopped` 帧 `aborted:true`。
- [x] AC3（b，先入队后中断）：带 `message` 的中断——修正经真实 `deliverSessionSend`→真实 send 进入 host 队列，且在 host 事件日志里**先于** `interrupt:aborted`；中断后下一轮输入为 `["and also bump the version", <correction>]`（修正在最后），stale-first=0，修正只出现 1 次。取假形态（同一链、先中断再发修正）⇒ 事件序变为 abort→enqueue，下一轮缺修正，stale-first≥1。
- [x] AC4（c，空闲/无 run 如实拒绝）：host 在跑但没有 round ⇒ `aborted:false` + 网关的 no-run 文案（`…no run to abort.`），中止的 round 数为 0，host 的 interrupt 被调 1 次、回答 false；host 已不在（`liveHostForSession` 返回 null）⇒ 同样的回执，host 的 interrupt 被调 0 次，也不退回 per-run abort；两种情况都没有任何 `stopped{aborted:true}` 帧。
- [x] AC5（d，已覆盖不误停）：在本判据自己的 harness 里注入 `hostCommandLifecycle`（读假 host 的 `started`）⇒ `{stopped:false, reason:'covered', triggerSeq:1}`，host 的 interrupt 被调 0 次，没有 `stopped` 帧，正在答这句话的 round 继续跑。对照组（不注入，即生产现状）⇒ 同一调用 `aborted:true`、host 的 interrupt 被调 1 次——把缺口的**行为后果**读出来了；同一调用第二次 ⇒ `covered`（幂等半边在生产可达）。
- [x] AC6（e，KNOWN GAP 钉子）：用例 `KNOWN GAP (fixTask gap-live-voice-interrupt-fence-wire-host-command-lifecycle): server/index.ts does not wire hostCommandLifecycle, so the covered-fence half is dead in production` 读取 `server/index.ts` 源码，以 `const buildVoiceRealtimeSeams`…`function resolveIdleRotateMs` 为范围（先断言范围内含 `createVoiceRealtimeLiveExecutor(`、`hostQueueReading:`、`hostRunActivity:`，保证范围选对、断言非空洞），再断言范围内与全文都**不含** `hostCommandLifecycle`。今天为绿（记录缺口）；Task B 接线的那一刻转红。
- [x] AC7：生产文件零 diff。`git diff --stat develop -- server/modules/voice-realtime server/index.ts src` 只有 `server/modules/voice-realtime/tests/voice-realtime-interrupt.test.ts | 688 +++-`；`git diff --stat develop...HEAD` 同样只有这 1 个文件。
- [x] AC8：`npm run typecheck` 退出 0；`npm run lint` 退出 0（只有仓库既有的 warning，本文件无 warning / error）。
- [x] AC9：`server/shared/tests/quay-test-script.test.ts` **未改动，也无需改**——没有新增 `*.test.ts`，文件计数不变。`scripts/suite-duration-baseline.tsv` 未改（该文件单跑耗时约从 1.5 s 增到 3.8 s；基线行是派发排序数据，不是闸）。

## DoD

真实落地 = 这块判据在 **develop 合并后的树上**重跑仍为 13/0，(a) 行的 `pidBefore=4242 … pidAfter=4242 … abortCount=1` 读数原样复现，(e) 钉子仍为绿（Task B 未落地前）。本任务只改测试，不改产品代码、不开任何生产开关、不重启 :3001、零云调用（假上游 + 进程内假 host）。

## Touches

- server/modules/voice-realtime/tests/voice-realtime-interrupt.test.ts
- tasks/gap-live-voice-interrupt-real-assembly-e2e.md

## Notes

立项与实现：Opus 子代理会话，2026-10-13。**已在任务分支实现，尚未 fan-in**：分支 `task/gap-live-voice-interrupt-real-assembly-e2e`，提交 `f67ad5b3`（基于 develop `2c81479a`）。⚠️ 状态 `ready` 的含义是「实现与自检已完成、等待正常 fan-in」；需要 driver / worker 按常规流程合入 develop，不是已落地。

关联：AC-343（栅栏，本任务的主挂点）；AC-342（先入队后中断，本任务 (b) 在真链上重证）；AC-350（resident `cancelQueuedInput` 能力位，与本任务共用 resident driver 的 `queuedInputUuid` 读数，(b)/(d) 的 `queuedMessageUuid` 就是 host 自己盖的 uuid）。

### 实测读数（单文件，2026-10-13）

```
✔ real assembly (a): a spoken session_interrupt reaches the resident host through the production chain — aborted, pid unchanged
  (a) pidBefore=4242 hostBefore=true statusBefore=running runId=984e9dea-… interrupt={"aborted":true,"runId":"984e9dea-…","triggerSeq":null,"queuedStillPending":0} pidAfter=4242 hostAfter=true statusAfter=aborted abortCount=1 roundsAborted=1 perRunAbort=0 requestAbort=0
✔ real assembly (b): … enqueues the correction into the host before the abort, and it rides the next turn last
  (b) host events: dispatch-idle:start the deploy | round:["start the deploy"] | enqueue:and also bump the version | enqueue:wait — deploy to staging, not production | interrupt:aborted | round:["and also bump the version","wait — deploy to staging, not production"]
✔ real assembly (b) false form: a bare stop followed by the correction as plain voice text leaves a stale-first turn
✔ real assembly (c): with the host up but no round in flight … aborted:false with the no-run message   (abortCount=1 roundsAborted=0 pid=4242)
✔ real assembly (c): with the host gone … never reaches the driver   (abortCount=0)
✔ real assembly (d): … `covered` and never reaches the host   ({"stopped":false,"reason":"covered","triggerSeq":1,…} abortCount=0)
✔ real assembly (d) contrast — production wiring: without `hostCommandLifecycle` the same stop aborts the run that already carries the sentence   ({"aborted":true,"triggerSeq":1,…} abortCount=1)
✔ KNOWN GAP (fixTask gap-live-voice-interrupt-fence-wire-host-command-lifecycle): server/index.ts does not wire hostCommandLifecycle, so the covered-fence half is dead in production
ℹ tests 13 / pass 13 / fail 0
```

### 与立项前假设不同的地方（以实测为准）

- **resident 判定需要三件事同时成立**（`residentEntryFor` + `resolveResidentEntry`）：能力表声明 `resident`、driver 带 `run` 入口、**会话行存储的 lifecycle mode 为 `resident`**（`resolveSessionLifecycleMode`，默认读 `sessionsDb.getSessionLifecycleMode`）。只有 `liveHostForSession` 是不够的。本判据通过真实 DB 写 `setSessionLifecycleMode` 满足第三件事，没有覆写 `resolveSessionLifecycleMode`。
- **resident abort 在 host 不 live 时直接返回 false，不会调到 driver**（`provider-runtime.service.ts` 的 `abort`：`if (!driver || !host) return false`）；host live 但没有 round 时，会调到 driver，由 driver 回答 false。所以「空闲」有两种诚实形态，两种都测了。
- **控制面的默认 access entry 只检查 userId 非空**（`chat-websocket.service.ts` 的 `assertSessionAccess`），所以没有覆写 `assertSessionAccess`，用的是真默认。
- **假 host 的中止时序必须是异步的**：起初 `interrupt` 同步结束 round，run 自己的 dispatch 先 settle，registry 被记成 `completed` 而不是 `aborted`。真实 CLI 是先确认中断、aborted round 的 `result` 稍后才从 stdout 回来，因此改为在下一个宏任务结束 round。这是假件的保真修正，不是产品缺陷。
- **真实 proxy 会把 AC-344 的 aftermath note 前置到「中断后第一条消息」上**：假形态 (b) 里修正在中断之后发出，带上了这段前缀，所以按包含关系匹配。这也顺带在真链上读到了 AC-344 的行为。
- `initializeDatabase()` 会把仓库内的旧库 `database/auth.db` **复制**（不是移动）到临时路径（`migrateLegacyDatabase`）；与 `chat-control-busy.test.ts` 等先例行为一致，源文件不受影响。

### 钉子文件状态

`quay-test-script.test.ts` 的计数钉子：**未改动，也无需改**（复用既有文件，没有新增 test 文件）。Task B 落地时必须更新本文件的 (e) 钉子与 (d) 对照组（见 `gap-live-voice-interrupt-fence-wire-host-command-lifecycle`）。
