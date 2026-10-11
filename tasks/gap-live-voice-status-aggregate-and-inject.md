---
id: gap-live-voice-status-aggregate-and-inject
title: 执行面状态聚合 + 向 realtime 模型持续注入精简状态（S-A）：event-driven/去重/≤1 次每 2 s 坍缩/≤200 B
  且 ≤8 次每 run/自带 ageMs 陈旧标识；复用 session.update 的 compose+去重通道，不新增线上消息种类
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-live-voice-voice-terminated-interrupt
---
## Proposal

### 现状（2026-10-11 逐文件复核，带 file:line）

**语音模型对执行面状态一无所知，而这是实测事故的土壤。**
`891da48b`（journal `c8b0ee15`）里用户说了 7 句，第 2–7 句上游模型回文本 `"OK"` 而**不调用工具**，服务端逐条记 `MODEL_TEXT_REPLY (recoverable)`。它为什么自答？因为**没有任何通道告诉它 Claude 正在忙**：今天唯一的状态类信息是 C2 context pack，而那是**每连接一次**的打包（`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:713-752`，`contextText` 一次读入、`advertisedContext` 一次记账），长回合里必然过期。

**线协议边界已核实（`voice-realtime-bridge.service.ts:46-70`）**：客户端→上游的消息联合体只有 6 个成员，由此三条硬约束——
- **没有**通用 `conversation.item.create`：唯一出现处是 `function_call_output`，且与 **`response.create` 焊死**（`voice-realtime-dashscope-transport.ts:410-417`）⇒ 照抄会**让模型每次状态变化都开口说话**；
- **没有** `item.delete` / `truncate` ⇒ 以 conversation item 注入会**永久累积**、被此后每次响应重复读取；
- **今天唯一在用**的注入通道是 `session.update` **整体重述 instructions**：`advertiseInstructions()`（`ws-proxy.service.ts:737-752`）已带 `advertisedContext === contextText` **去重**并打 `context injected chars= rows=` 日志 ⇒ **整体替换、不累积**。

**成本锚点（实测）**：固定上下文约 **1,280 token/响应**，按"每次响应读取的 token"计费（`voice-realtime-tools.ts:290-291`）。

### 人的裁定（2026-10-11）

D-1：**Realtime 模型持续注入精简执行状态**（event-driven、去重、限频、有界 token、**带陈旧标识**），另加工具主动查询全量（见 `gap-live-voice-status-tool`）。**绝非仅在工具回执给一行。**

规范全文见 `docs/proposals/voice-realtime-persistent-control-SPEC.md` §8（Draft-2，已合入 develop `ac5c4de5`）与 §16 的 **G-1**。

### SCOPE BOUNDARY

- ⛔ 不新增客户端→上游的消息种类（不碰 §B-1/B-2 那两条死路）。
- ⛔ 不做 `session_status` 工具（那是 G-2 / `gap-live-voice-status-tool`）。
- ⛔ 不做浏览器侧事件流 S-C（`status`/`admitted`/… 帧）——本任务只做**模型侧 S-A**。
- ⛔ 不改语音工具面（本任务不新增工具，仅改 instructions 的组合）。

<!-- dedup-ref --> 机制去重（立案时实测，2026-10-11）：open 任务对 `状态注入` / `status inject` / `状态聚合` / `statusSeq` / `注入成本` 均 0 命中（`陈旧` / `ageMs` 命中的是 MCP 新鲜度类任务，机制不同）。`task-granularity-advice.js` 报 peer `gap-live-voice-voice-terminated-interrupt`（共触 `voice-realtime-ws-proxy.service.ts`）——本任务声明 `depends_on` 它，按 SPEC §15 的 M-1→M-2 顺序串行，**keep separate**。

## Plan

1. **状态聚合器（L3 的唯一真源）**：在 `voice-realtime-ws-proxy.service.ts` 里建一份**每连接**的状态读数，含
   `phase / runId / elapsedMs / queuedItems / queuedBytes / pendingInteraction / statusSeq / at`，
   由既有事件点驱动更新（`sent` 帧、准入判定、executor 起跑与结束、权限请求、abort）。
   **`statusSeq` 单调递增**，是去重键与"同源"证明（S-A 与将来的 S-B/S-C 都读它）。
2. **折进 composed instructions**：把状态渲染成**一行**（`[exec] phase=… run=… elapsed=… queued=…B pending=… at=… ageMs=…`），
   并入 `composeVoiceRealtimeInstructions()` 的产物，经**已有的** `advertiseInstructions()` 通道发出——
   复用它的 `bridge.state === 'open'` 守卫与去重记账，**不新建发送路径**。
3. **四条约束（D-1 逐条落地，全部要有机械判据）**：
   - **event-driven**：状态**变化**才注入；去重键 = `(phase, runId, queuedItems, queuedBytes, pendingInteraction.requestId)`，键不变 ⇒ **不注入**。
   - **限频**：≤ **1 次 / 2 s**；窗口内多次变化**坍缩为最新一条**（coalesce，不排队）。
   - **有界**：单行 ≤ **200 字节 / ≤ 60 token**；总注入 ≤ **8 次 / run**；达上限后停止注入并在行内标 `(+N more, ask session_status)`。
   - **陈旧标识**：行内 `at=<epoch ms>` 与 `ageMs`；指令层写明 `ageMs > 4000` 的状态**不得当作现状复述**。
4. **纪律**：注入行**永不**含会话正文、文件路径或用户原文（与 C2 pack 的日志纪律一致：只记尺寸与来源）。
5. **静态门**：新增服务端测试文件 ⇒ 同步 `server/shared/tests/quay-test-script.test.ts` 的 `unknown=` 钉子与 `scripts/suite-duration-baseline.tsv`；`npm run typecheck`、`npm run lint`。

## AC

- [ ] AC1 注入发生且**去重**（**取假形态，排在判据文件最前**）：状态发生变化 ⇒ 上游收到一次 `session.update`，其 `instructions` 含该状态行；**同一去重键再次变化不注入**（`session.update` 发送计数不增）。判据 `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-status-injection.test.ts` 退出 0，且**首条断言**即"同键不重复注入"。
- [ ] AC2 限频 + 坍缩：2 s 窗口内注入 5 次状态变化 ⇒ 实际 `session.update` ≤ 1 次，且其内容是最新一条（给出次数与内容读数）。
- [ ] AC3 上限：同一 run 内触发 > 8 次变化 ⇒ 注入恰 8 次，且第 8 次的行内含 `(+N more, ask session_status)`。
- [ ] AC4 陈旧标识：行内 `at` 与 `ageMs` 与注入时刻一致（给出两个读数）；**指令文本**含"`ageMs > 4000` 不得复述"的明确要求（文本断言）。
- [ ] AC5 有界 + 无正文泄漏：注入行 ≤ 200 字节；且**不含**该会话的用户原文或任何文件路径（对采样文本做包含性断言）。
- [ ] AC6 **单源**：S-A 注入行里的 `statusSeq` 与聚合器读数一致（同一份，非各算一次）。
- [ ] AC7 离线：全程 `apiKey: ''` + scripted fake 工厂，**零云端调用**；给出"假上游收到的 `session.update` 序列"读数。
- [ ] AC8 静态门：`npm run typecheck` 退出 0；`npm run lint` 退出 0；`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0。

## DoD

一个**真实对象**被操作过：真 transport + 真 proxy（scripted fake 上游）下跑一次**长回合**，其间连续产生状态变化，**上游实际收到的状态行序列**是去重 + 限频 + 上限后的结果——给出序列读数（每次注入的时刻与内容）、被抑制的次数、以及 `statusSeq` 与聚合器的一致性；并证明全程零云端调用。⛔ 本任务不做浏览器事件流，也不做全量查询工具（G-2）。单元测试必要但不充分：DoD 要求的是**上游侧真实帧序列**，不是函数返回值。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/voice-realtime-bridge.service.ts (only if the instruction composition needs a seam)
- server/modules/voice-realtime/voice-realtime-settings.ts (only if the status line belongs in the composed template)
- server/modules/voice-realtime/tests/voice-realtime-status-injection.test.ts (new)（本任务判据文件）
- server/modules/voice-realtime/tests/voice-realtime-dashscope-harness.ts (only if the fake upstream must observe session.update contents)
- server/shared/tests/quay-test-script.test.ts (only if the collected-file set or the baseline pin moves)
- scripts/suite-duration-baseline.tsv (only if the new test file needs a baseline row)
- tasks/gap-live-voice-status-aggregate-and-inject.md (self)
