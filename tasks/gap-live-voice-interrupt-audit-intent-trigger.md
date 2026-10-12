---
id: gap-live-voice-interrupt-audit-intent-trigger
title: session_interrupt 可审计：语音面 intent/heard + journal
  kind:interrupt（runId/triggerSeq/queuedStillPending/inFlightTool），gateway 兼容（阶段
  0b，F5）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-339
---
## Proposal

### 现状（2026-10-12 复核）

- 语音面中断描述符只有 `session`：`server/modules/voice-realtime/voice-realtime-tools.ts:311` `REALTIME_INTERRUPT_TOOL`（`description: 'Stop what the session is doing right now.'`，`inputSchema: { session }`）；gateway 侧 `server/modules/mcp-gateway/mcp-session-lifecycle.ts:232` `SESSION_INTERRUPT_INPUT_SCHEMA` 同样只有 `session`。
- 中断处理 `server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:1705` `sessionInterrupt` 只打一行 `session_interrupt: aborted=… backlog=…` 日志；journal（`server/modules/voice-realtime/voice-realtime-log.ts:110-150` 的 kind 联合）没有 `interrupt` 这一种。
- 后果：SPEC §6.2 的 `intent` 必填、§10.3 / C-3「误停可审计」均不成立（§18.1 F-6）。

### 要做的事

1. 语音面描述符增加 `intent`（必填，模型自述它认为用户想要什么）与 `heard`（可选，触发判断的转写）；描述保持在 §6.3 工具预算内。
2. ws-proxy 在中断时生成审计记录并写 journal `kind:'interrupt'`：`runId`（当前聚合器读数，没有则 `null`）、`triggerSeq`（触发该调用时最近一条**非空** `transcription.completed` 的 L3 序号 `utteranceSeq`——本任务引入该单调计数）、`intent`、`heard`、`queuedStillPending`、`inFlightTool`（读不到则显式 `null`，不猜）、`by:'model'`、`outcome`（`aborted` / `no-run` / `refused`）。回执同样带 `runId`、`triggerSeq`、`queuedStillPending`。
3. **工具兼容**：gateway 的 `session_interrupt` 输入/输出 schema **不改**；语音面独有字段在 executor 里剥离后再调用 gateway 处理器，MCP 客户端零感知。缺 `intent` 的语音面调用报参数错误并点名 `intent`。

<!-- dedup-ref --> 机制去重：open 任务对 `kind:'interrupt'` / `intent` / `triggerSeq` 0 命中；SPEC G-6 无承载任务。与 `gap-live-voice-queue-depth-host-lifecycle-truth`、`gap-live-voice-prompt-drop-stop-word-trigger` 共触 ws-proxy，由调度器按 Touches 串行。

### SCOPE BOUNDARY（GOAL-041 全体任务共用）

- ⛔ 不做 Steer / Fork / Rollback；不建独立 Active Intent Buffer（方案 B，SPEC §0.3 D-5）。
- ⛔ 模型工具面不暴露撤回 / 清空队列（D-2）；不改能力位 `cancelQueuedInput`。
- ⛔ 中断不调用 `stopTask`、不改后台任务 / cron 租约、不触碰任何 Quay worker / driver 进程或工作树（D-9）。
- ⛔ 不重启 :3001、不做生产发布；真实上游 / 真实二进制只在本任务 AC 明确要求处使用。
- 契约正本：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3、§18（Draft-3，提交 `0cbe53fc`）。


## Plan

1. 描述符 + executor 剥离；2. `utteranceSeq` 计数与 `triggerSeq` 捕获；3. journal kind 与写入；4. 判据文件与受影响钉子；5. 新测试文件同步 quay-test-script 钉子与基线；typecheck / lint。

## AC

- [x] AC1（取假形态排最前）：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-interrupt-audit.test.ts` 退出 0；首条断言：journal 的 `kind:'interrupt'` 记录字段集合恰为 `runId,triggerSeq,intent,heard,queuedStillPending,inFlightTool,by,outcome`（加 `at`/`connectionId`），删任一字段的假形态下该断言红。
- [x] AC2：语音面缺 `intent` ⇒ 参数错误且错误文本点名 `intent`；`heard` 省略 ⇒ 记录中为 `null`。
- [x] AC3：两句话之后调用中断，`triggerSeq` 等于第二句的 `utteranceSeq`；空转写不推进 `utteranceSeq`。
- [x] AC4：gateway 兼容：`npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-session-lifecycle.test.ts server/modules/mcp-gateway/tests/mcp-invalid-argument.test.ts` 退出 0，且 gateway 处理器收到的参数不含 `intent`/`heard`。
- [x] AC5：既有 `voice-realtime-interrupt.test.ts`、`voice-realtime-live-executor.test.ts`、`voice-realtime-bridge.test.ts`、`voice-realtime-bridge.false-forms.test.ts` 退出 0。
- [x] AC6：`npm run typecheck`、`npm run lint`、`server/shared/tests/quay-test-script.test.ts` 退出 0。

## DoD

真 transport + 真 proxy（scripted fake 上游）下，模型侧发起一次带 `intent` 的中断，journal 文件中读到完整 `kind:'interrupt'` 行（原文摘录写入 `## Notes`），同时 MCP 客户端以旧形态调用 gateway `session_interrupt` 成功；零云调用。

## Touches

- server/modules/voice-realtime/voice-realtime-tools.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/voice-realtime-live-executor.ts
- server/modules/voice-realtime/voice-realtime-log.ts（journal 新 kind）
- server/modules/voice-realtime/tests/voice-realtime-interrupt-audit.test.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-interrupt.test.ts（描述符形状钉子）
- server/modules/voice-realtime/tests/voice-realtime-live-executor.test.ts（路由与参数钉子）
- server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts（仅当镜像断言受影响）
- server/modules/voice-realtime/tests/voice-realtime-ws-proxy.real-transport.test.ts（仅当 session.update 工具形状钉子受影响）
- server/modules/voice-realtime/tests/voice-realtime-log.test.ts（仅当 journal kind 联合钉子受影响）
- server/shared/tests/quay-test-script.test.ts（新增测试文件计数钉子）
- scripts/suite-duration-baseline.tsv（新增测试文件基线行）
- tasks/gap-live-voice-interrupt-audit-intent-trigger.md

## Notes

立项：Opus 常驻架构会话，2026-10-12，人 yale 授权（GOAL-041 / AC-339）。

### 落地读取（2026-10-12，worker 回合）

AC 状态：AC1–AC6 逐条跑过、全绿（AC1/AC2/AC3 见新判据文件 4 例，AC4 = gateway 19/19，AC5 = 23/23，AC6 = typecheck/lint/quay-test-script 均 exit 0）。

DoD 原文摘录（`voice-realtime-interrupt-audit.test.ts` 的 DoD 例：真 `createDashscopeTransport` + 真 `handleVoiceRealtimeConnection` + 真 `createVoiceRealtimeRecorder`，scripted fake 上游，`apiKey: ''`、dial 地址 `ws://scripted.invalid/...` ⇒ 零云调用）：

```
{"at":"2026-10-12T06:54:35.641Z","kind":"interrupt","connectionId":"conn-audit","runId":null,"triggerSeq":1,"intent":"the user said stop","heard":"open the failing test","queuedStillPending":0,"inFlightTool":null,"by":"model","outcome":"aborted"}
```

同一次运行里，`conversation.item.create` 回执（transport 写出的线上原文，`item.output` 解析后）为 `{"aborted":true,"runId":null,"triggerSeq":1,"queuedStillPending":0}`。

MCP 客户端以旧形态调用 gateway `session_interrupt` 成功：`mcp-session-lifecycle.test.ts` 用真实 MCP harness 的 `harness.call('session_interrupt', { session })`（(d) 运行中 run 报 `aborted:true`、(e) 空闲报 `aborted:false` + no-run 文案、(f) scope 拒/准）在本次改动后仍 19/19 全绿——gateway 的 `SESSION_INTERRUPT_INPUT_SCHEMA` 与 handler 一行未动。

### 设计要点（供后续任务）

- 审计走既有 `log` seam 的一行 `session_interrupt audit {json}`，由 recorder 分类成 `kind:'interrupt'`；该 kind **不带** `line` 字段（其余被分类的 kind 都带），因为负载本身就是记录、字段集合就是判据。
- `utteranceSeq` 是连接级单调计数，起点 1（0 表示「还没听到任何非空转写」⇒ `triggerSeq: null`，不与「第一句」混淆）；只有**非空** final 转写推进它。
- `inFlightTool` 恒为 `null`：proxy 没有 run 内工具的可读窗口，按 C-3 规则记「已知」、其余显式 `null`。
- 语音面独有字段 (`intent`/`heard`) 只在 `voiceInterruptGatewayArgs()` 一处剥离，该函数导出给判据直接读（经 `readSessionInterruptInput` 观测不到——它自己就窄化成 `{ session }`，删掉剥离也照样绿）。
- 描述符字节预算：三个语音描述合计 281B / 上限 2×`session_send`=290B（`voice-realtime-status-tool.test.ts` AC6）。
- 假形态实证（临时改产品码后跑新判据文件、随即还原）：把空转写也计数 ⇒ 仅 AC3 红；从审计负载里删掉 `inFlightTool` ⇒ 三条全红（记录无法解析 ⇒ 退回 `kind:'log'`）。

### 续做回合分类（2026-10-12，第二次 exited-not-landed）

本轮**零产品码改动**（续用分支上既有实现），只做分类 + 合 develop + 重新确认判据。AC1 判据文件重跑 4/4 绿，DoD 行原文与上文摘录逐字段一致（`triggerSeq:1`、`outcome:"aborted"`）。

两次 exited-not-landed 的 suite 红都落在 `server/modules/voice-realtime/tests/voice-realtime-upstream-pool.test.ts`，且都是同一行：

```
AssertionError [ERR_ASSERTION]: the switch must follow the idle threshold, got idleMs=29
```

分类结论：**环境性边界 flake，非本任务 delta 造成**。证据：

1. 该测试文件与其被测模块 `voice-realtime-upstream-pool.ts` **对 develop 逐字节相同**（`git diff develop HEAD -- <两者>` 均为 0 行），且都不在本任务 Touches/delta 内 ⇒ 本轮的复现运行跑的**就是 develop 的版本**，红不是本分支引入的。
2. 机制在源码里可读：`voice-realtime-upstream-pool.ts:143` `const now = options.now ?? Date.now`、`:346` `idleMs: triggeredAt - lastActivityAt`（两个 `Date.now()`），而轮转由 `:171` `setTimeout(idleRotateMs)` 布防——libuv 按 `CLOCK_MONOTONIC` 计时。判据 `:211` 取 `thresholdMs = 30`、`:220` 断言 `rotation.idleMs >= 30`。两钟只需偏 ~1ms，定时器就在 monotonic 走了 30ms、而 `Date.now()` 只走了 29ms 时触发 ⇒ `idleMs = 29 < 30`。
3. 间歇而非确定性：单文件直跑 6 次 = **3 红 / 3 绿**（每次红都是同一个 `idleMs=29`）。确定性失败才是 delta 造成的；间歇红是环境。
4. 偏置方向相反（决定性）：要得到 `idleMs = 29`，必须让 realtime 落后 monotonic。事件循环负载（本 delta 唯一可能的间接影响，且本任务在 pool 路径上不增加任何负载）只会让 `setTimeout` **晚**触发 ⇒ `idleMs >= 30` ⇒ 绿。故本 delta 在原理上无法产生该红。
5. 该 flake 有 4 次既往记录（`gap-quay-tab-window-switch-unmounts-the-whole-panel`、`gap-voice-realtime-paced-audio-source`、`gap-live-voice-e2e-scripted-upstream`、`gap-claude-resident-e10-enqueue-interrupt-drain`），处理一律为「分类、不改文件、合 develop、重退」。

为何**不改**该文件：它在任何任务的 `## Touches` 之外；改它 (a) 需要回溯性加 Touches 行（范围蔓延），(b) 会篡改另一个**已 done** 任务（`gap-voice-realtime-upstream-pool-rotation`，AC-321）的已落地判据——那是治理越界，不是服务。仓库既有先例（`.quay/anchor.log` ≈ 25076 行「did not touch claude-sessions.test.ts」）即「分类、记录、重退让 driver 重跑」。

⚠️ 本轮实测红率 **3/6 ≈ 50%**，明显高于既往记录的 ~10%（空载基线）——与本机当前高负载一致（多 worktree/会话并发），方向与既往记录「负载下更糟」相符。但这意味着 driver 的机械重跑在本机有**相当概率**再次红在同一文件上；若后续仍反复红，正解是给该文件加 `// @load-sensitive <kind>` 标注（或在 driver 侧重跑），而不是本任务去改它。

## Blocker

**2026-10-12T07:34:51.905Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: not ok - src/shared/tests/voiceErrorClassification.test.ts: AssertionError: the run left files behind: /src/shared/tests/__criterion-falsify-cjk-1.ts:35013: expected [ Array(1) ] to deeply equal []
- run_id：wk-prod-anchor
- session_id：7a63f87f-080f-42d7-b75d-44a36dd6a62f
