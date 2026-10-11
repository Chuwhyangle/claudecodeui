---
id: gap-live-voice-status-aggregate-and-inject
title: 执行面状态聚合 + 向 realtime 模型持续注入精简状态（S-A）：event-driven/去重/≤1 次每 2 s 坍缩/≤200 B
  且 ≤8 次每 run/自带 ageMs 陈旧标识；复用 session.update 的 compose+去重通道，不新增线上消息种类
status: done
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

- [x] AC1 注入发生且**去重**（**取假形态，排在判据文件最前**）：状态发生变化 ⇒ 上游收到一次 `session.update`，其 `instructions` 含该状态行；**同一去重键再次变化不注入**（`session.update` 发送计数不增）。判据 `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-status-injection.test.ts` 退出 0，且**首条断言**即"同键不重复注入"。
- [x] AC2 限频 + 坍缩：2 s 窗口内注入 5 次状态变化 ⇒ 实际 `session.update` ≤ 1 次，且其内容是最新一条（给出次数与内容读数）。
- [x] AC3 上限：同一 run 内触发 > 8 次变化 ⇒ 注入恰 8 次，且第 8 次的行内含 `(+N more, ask session_status)`。
- [x] AC4 陈旧标识：行内 `at` 与 `ageMs` 与注入时刻一致（给出两个读数）；**指令文本**含"`ageMs > 4000` 不得复述"的明确要求（文本断言）。
- [x] AC5 有界 + 无正文泄漏：注入行 ≤ 200 字节；且**不含**该会话的用户原文或任何文件路径（对采样文本做包含性断言）。
- [x] AC6 **单源**：S-A 注入行里的 `statusSeq` 与聚合器读数一致（同一份，非各算一次）。
- [x] AC7 离线：全程 `apiKey: ''` + scripted fake 工厂，**零云端调用**；给出"假上游收到的 `session.update` 序列"读数。
- [x] AC8 静态门：`npm run typecheck` 退出 0；`npm run lint` 退出 0；`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0。

## DoD

一个**真实对象**被操作过：真 transport + 真 proxy（scripted fake 上游）下跑一次**长回合**，其间连续产生状态变化，**上游实际收到的状态行序列**是去重 + 限频 + 上限后的结果——给出序列读数（每次注入的时刻与内容）、被抑制的次数、以及 `statusSeq` 与聚合器的一致性；并证明全程零云端调用。⛔ 本任务不做浏览器事件流，也不做全量查询工具（G-2）。单元测试必要但不充分：DoD 要求的是**上游侧真实帧序列**，不是函数返回值。

## 验证记录

判据文件：`server/modules/voice-realtime/tests/voice-realtime-status-injection.test.ts`（新，8 个 test：AC1–AC7 + DoD）。运行方式 `env -u VOICE_REALTIME_MODE npx tsx --tsconfig server/tsconfig.json --test <file>`（会话 shell 里 `VOICE_REALTIME_MODE=continuous` 会让语音类判据超时，故显式 unset）。**合并 develop 之后重跑，全绿**：`tests 8 / pass 8 / fail 0`，`duration_ms 12688`。

**AC1（去重；文件首条断言）。** 判据文件退出 0（`✔ AC1: an unchanged execution state is never injected twice; a changed one is (199ms)`），且文件**第一条 `test` 就是 AC1**、其**第一条 `assert`** 是机制级去重门，先于任何 socket：`createVoiceRealtimeExecStatus().update({phase:'running',runId:'r-1',queuedItems:0,queuedBytes:0}).changed === true`；同键再来一次 ⇒ `.changed === false`（"同键不重复注入"），且 `reading().statusSeq` 仍为 `1`。线上半：c1 投递 ⇒ 注入 1 次（`session.update` 总数 2 = open advert + 1），行内含 `[exec] phase=running run=r-1`；c2 交回**同键**结果 ⇒ 等 `calls===2` 后再睡 150 ms（若干窗口）⇒ 注入数仍为 **1**；c3 移动队列 ⇒ 第 2 条注入出现（正控：变化确实会注入，否则"从不注入"也能满足本条）。

**AC2（限频 + 坍缩，出厂窗口）。** 判据**不传** `statusRateMs`（用的是出厂的 `VOICE_REALTIME_STATUS_RATE_MS = 2000`）：5 次变化在窗口内背靠背投入，窗口未关时注入数 **0**（`nothing is injected mid-window: the edge is TRAILING`）；窗口关闭后注入 **`session.update` 恰 1 次**，再睡 2 500 ms 后仍为 1 次（没有排队第二条）。内容读数（最新一条，第 4 次 queued 投递）：
`[exec] phase=queued run=r-1 statusSeq=5 elapsed=2s queued=4/120B pending=- at=1791735641095 ageMs=1999`
同侧读数 `scenario.readings.length === 1` —— 坍缩在 seam 的两侧都只有一次。

**AC3（上限 = run 的属性）。** run `r-1` 内 12 次变化 ⇒ 注入**恰 8 次**（`lines.length === 8`，且断言等于 `VOICE_REALTIME_STATUS_MAX_INJECTIONS_PER_RUN`）；第 7 条**不含** marker，第 8 条含 `(+1 more, ask session_status)`，且 `logLines` 里有 `more=1`（上限通告自己说明它压了多少条）。第 8 条读数：
`[exec] phase=queued run=r-1 statusSeq=8 elapsed=0s queued=7/210B pending=- at=1791735645480472 ageMs=21 (+1 more, ask session_status)`（实际 `at=1791735645743`）。第 13 次投递换到 run `r-2` ⇒ **第 9 条注入**出现（`run=r-2`、无 marker）——证明上限不是"连接级永不再发"。

**AC4（`at`/`ageMs` + 指令层规则）。** 两读数：`at1` 落在投递前/后 5 ms 之内，`age1 >= 0` 且 `after1 - at1 - age1 <= 200`；第二条 `at2 > at1` 且同关系成立。指令文本断言：带状态行的 body 同时含 `VOICE_REALTIME_STATUS_HEADER` 与 `VOICE_REALTIME_STATUS_STALENESS_RULE`，正则命中字面 `/ageMs > 4000/` 与 `/session_status/`，且代码侧常量 `VOICE_REALTIME_STATUS_STALE_MS === 4000`。无状态的首个 body 与 `VOICE_REALTIME_INSTRUCTIONS` **逐字节相等**（`assert.equal(instructionTexts[0], VOICE_REALTIME_INSTRUCTIONS)`）。

**AC5（有界 + 无泄漏）。** 采样文本是真实注入行：每条 `Buffer.byteLength(line,'utf8') <= 200`；不含用户原文（含路径与"暗号"的那整句）、不含 `/data/`、不含 `.ts`；把 `queued=N/MB` 这一段换成 `queued=…` 后**不含任何 `/` 或 `\`**；CJK 正则 `[　-鿿＀-￯]` 不命中。字段级（对聚合器直接施加恶意输入）：`runId: '/data/home/yale/secret.ts'` 渲染为 `run=datahomeyalesecr`——`voiceStatusField` 只留 `[\w.:-]`，分隔符被剥净，`run=` 字段无 `/`。**追加边界**：一行极大值（16 字符 run + pending interaction + 五位数计数器）加 `(+12345 more, ask session_status)` 仍 `≤ 200 B`，且 marker 完整落在行尾——字节上限施加在 **body** 上（`bodyCap = 200 - markerBytes`），marker 永不被截断吃掉。

**AC6（单源）。** 3 次变化 ⇒ 3 条注入 ⇔ 3 条 `onExecStatus` 读数（1:1，`readings.length === lines.length`）；`statusSeq` 严格递增 `1,2,3`；逐条把行里读出的 `statusSeq / at / phase / queued=items/bytes / elapsed` 与 seam 交出的读数比对**全部相等**（行由读数渲染，非各算一次）。行里的 `statusSeq` 是 §8.4 示例形状**没有**的字段，属**增量**：§8.4 的预算是字节数而不是字段表，且正是它让"同源"能只从线上读数核对。

**AC7（离线）。** `upstream.dialedUrl` 去掉 `?model=…` 后 == `SCRIPTED_ENDPOINT_URL` = `ws://scripted.invalid/api-ws/v1/realtime`（不可路由后缀）。**且这是被强制的、不是碰巧**：同一组参数（`apiKey: ''` + 同一个 endpoint）**不带** scripted 工厂时 `open()` 拒绝 `/DASHSCOPE_API_KEY is required/`。假上游看到的 `session.update` 序列读数：
`[{update:1, status:"<no status line>"}, {update:2, status:"[exec] phase=running run=r-1 statusSeq=1 elapsed=0s queued=0/0B pending=- at=… ageMs=19"}, {update:3, status:"[exec] phase=queued run=r-1 statusSeq=2 elapsed=0s queued=1/9B pending=- at=… ageMs=20"}]`（`sequence.length === 3`，open advert + 两次注入；第 1 条是裸 prompt）。

**AC8（静态门）。** `npm run typecheck` ⇒ `TYPECHECK_EXIT=0`（三个 tsconfig 全过：根 / `server/` / `scripts/`）。`npm run lint` ⇒ `LINT_EXIT=0`（仅 warning，且全部落在既有文件；本任务新增/改动的 4 个文件零命中）。`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` ⇒ `tests 11 / pass 11 / fail 0`、退出 0（合并 develop 后复跑同样全绿）。

**DoD（真 transport + 真 proxy 的长回合，上游侧真实帧序列）。** 一轮 12 次投递（每次一问一句，run `r-long` 连续 11 次变化后切到 `r-long-2`），上游**实际收到 9 条**状态注入、被抑制 3 次：

| # | 时刻 (epoch ms) | statusSeq | 行 |
|---|---|---|---|
| 1 | 1791735646890 | 1 | `[exec] phase=running run=r-long … queued=0/0B … ageMs=151` |
| 2 | 1791735647041 | 2 | `… queued=1/30B …` |
| 3 | 1791735647192 | 3 | `… queued=2/60B …` |
| 4 | 1791735647343 | 4 | `… queued=3/90B … elapsed=1s …` |
| 5 | 1791735647492 | 5 | `… queued=4/120B …` |
| 6 | 1791735647643 | 6 | `… queued=5/150B …` |
| 7 | 1791735647794 | 7 | `… queued=6/180B …`（无 marker） |
| 8 | 1791735647945 | 8 | `… queued=7/210B … (+1 more, ask session_status)` |
| 9 | 1791735647945 | 12 | `[exec] phase=running run=r-long-2 … queued=0/0B …`（新 run，上限重置） |

断言：`lines.length === 9`；`suppressed = 12 - 9 === 3`；第 8 条的 `statusSeq === 8` 且带 marker；`scenario.readings.length === lines.length`（一次注入一条读数）；`sequence.map(statusSeq)` 与 `readings.map(statusSeq)` `deepEqual`（行与读数逐条同源）。零云端调用：`dialedUrl` 是假上游地址，且假上游的 `clientFrames` 非空（它确实是那个"端点"）。每条注入的时刻与内容通过 `t.diagnostic` 打在判据输出里（上表即取自该输出）。

**与 Touches 的偏离声明。** 无偏离：改动落在 `voice-realtime-ws-proxy.service.ts`、`voice-realtime-settings.ts`、新判据文件、`server/shared/tests/quay-test-script.test.ts`（钉子 `unknown=289→290`、`unknown=291→292`，服务端收集集 292 → 293）与 `scripts/suite-duration-baseline.tsv`（追加一行）——全部在 `## Touches` 已声明范围内。`voice-realtime-bridge.service.ts` 与 `tests/voice-realtime-dashscope-harness.ts` 按 bullet 的条件**未改**（instructions 的组合无需新 seam：去重与发送都复用了既有 `advertiseInstructions()`）。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/voice-realtime-settings.ts (only if the status line belongs in the composed template)
- server/modules/voice-realtime/tests/voice-realtime-status-injection.test.ts (new)（本任务判据文件）
- server/shared/tests/quay-test-script.test.ts (only if the collected-file set or the baseline pin moves)
- scripts/suite-duration-baseline.tsv (only if the new test file needs a baseline row)
- tasks/gap-live-voice-status-aggregate-and-inject.md (self)
