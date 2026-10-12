---
id: gap-live-voice-double-drop-signatures-carry-actuals
title: 双断线已知缺陷签名精确到实际值 + 取假用例：夹具出错不得被判为缺陷复现（只改测试）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-370
---
## Proposal

### 证据与架构不变量（本组任务共用）

证据：journal `~/.cloudcli/voice-realtime-log/e22ac831-30c6-4600-8bcf-b5c3cc7e3a8c.jsonl`（2026-10-12 16:01–16:03 UTC，segmented，13 段，全部 `frames=1`）：
- seq2（14.6 s 单帧）写出 commit 后 206 ms 断线 1/3，未收到 `committed`；重连后重放，1.15 s 后断线 2/3；第二次重连因 `replayedSeqs`（`voice-realtime-bridge.service.ts:633, 754-760`）不再重放 ⇒ seq2 丢失。
- `pendingCommitSeqs`（`:649`，入队 `:733`，出队 `:837, :885-886`）断线不清空 ⇒ 残留 `[2,2]`，seq3/4/5 的 `committed` 错配两位；ws-proxy 的 `segmentSeqByItemId`（`:2644-2648`）据此把 seq4 的空转写记成「segment 2 dropped: no words」（`markSegmentEmpty` `:2105-2111`）。
- `openAttempts` 终身不复位（`:538/878`）；seq6（12 s 单帧）写出后 1.07 s 断线 3/3 ⇒ 连接永久关闭。
- `endSegment` / `flushOpenSegment` 无条件发 `phase: 'committed'`（`:1145-1159`），`writeSegmentClose` 在非 open 时直接返回（`:729`）⇒ 关闭后 seq7–12 仍收到 `segment_ack committed`（ws-proxy `:2615`）。
- RC-5（**未验证假设**）：3 次断线全部紧随 ≥12 s 单帧 append，10 个 ≤5.5 s 段从未断线。只由 AC-369 的真实探针判定，任何任务不得以此为前提。

不变量（验收以此为准）：
- **ACK 分级**：written（已写到上游 socket）≠ committed（上游 `input_audio_buffer.committed`）≠ recognized（转写完成）≠ delivered（`session_send` 进入 CLI 队列，`sent` 帧）。只有 delivered 叫「投递」。
- **按段至多一次投递**：同一 `seq` 跨 socket epoch 至多一次 delivered；已投递段的重放调用被丢弃（现有 `deliveredSegmentSeqs` 重放闸，`ws-proxy:2131`）；不自动补发。
- **epoch 作用域**：`committed` 只与同一 socket epoch 内未决的 commit 配对；断线即清空，未决段转 uncertain。
- **处置完备且诚实**：每段终态为 delivered / not-forwarded / empty / failed / lost(reason) 之一；lost 不得记为 empty。
- 签名纪律（AC-357 同款）：当前缺陷腿只在**记录的首行失败签名**下通过；意外通过或别的失败必须红。


### 问题（复核 AC-365 落地代码，提交 `5e483a8a`）

`server/modules/voice-realtime/tests/voice-realtime-connection-resilience.test.ts` 中 D2 / D4 / D5 / D6 的签名（`D2_SIGNATURE` 等常量）就是断言的**固定自定义消息**，例如：

```
assert.deepEqual(wire.captionSeqs(), [0, 1, 2, 3, 4, 5], D2_SIGNATURE)
```

自定义消息替换了 node `assert` 的实际值差异输出，所以**任何**偏差都会产生同一首行：夹具自身出错（比如丢了一条转写、归属变成 `[0,1,3,4,5]`）也会被 `expectKnownDefect` 判为「已知缺陷复现」而通过。这不满足 AC-357 的签名纪律：签名应是当前代码那个缺陷特有的读数，而不是「这条断言失败了」。D1 的签名挂在一个只对该缺陷成立的过滤断言上，相对严格，也应一并补上实际值。

### 要做的事（只改测试）

1. D1 / D2 / D4 / D5 / D6 的失败首行同时写出期望与**当前实际值**，例如：
   - D2 的实际 `captionSeqs` 数组；
   - D4 第几次断线后连接终止；
   - D5 关闭后收到 `committed` 的 seq 列表；
   - D6 `committed` 早于上游 `committed` 的 seq。
   签名精确匹配当前实际值（端口、时间戳等变化部分用正则）。
2. 每条再加一个取假用例 `test('Dn false form …')`：人为制造一种**不同于**该缺陷的错误（例如场景中丢掉一条转写、让第一次拨号就拒绝），断言 `expectKnownDefect` 抛出 `unexpected failure signature`，证明签名不会吞掉别的失败。D2 / D4 / D5 / D6 各至少一条。
3. D3 保持直接断言、保持绿；不改 `fixTask`（仍指向 `gap-live-voice-reconnect-epoch-scoped-commit-pairing`）。

### SCOPE BOUNDARY（GOAL-041 全体任务共用）

- ⛔ 不做 Steer / Fork / Rollback；不建独立 Active Intent Buffer（方案 B，SPEC §0.3 D-5）。
- ⛔ 模型工具面不暴露撤回 / 清空队列（D-2）；不改能力位 `cancelQueuedInput`。
- ⛔ 中断不调用 `stopTask`、不改后台任务 / cron 租约、不触碰任何 Quay worker / driver 进程或工作树（D-9）。
- ⛔ 不重启 :3001、不做生产发布；真实上游 / 真实二进制只在本任务 AC 明确要求处使用。
- 契约正本：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3、§18（Draft-3，提交 `0cbe53fc`）。


- ⛔ 只改测试文件，不改产品代码，不新增 `*.test.ts`。

## Plan

1. 读取当前实际值（单文件运行）；2. 改写 D1/D2/D4/D5/D6 的断言消息与签名；3. 加四条以上取假用例；4. 三次运行读数一致；5. typecheck / lint。

## AC

- [x] AC1：`voice-realtime-connection-resilience.test.ts` 单文件运行退出 0，含 `test('D2 false form`、`test('D4 false form`、`test('D5 false form`、`test('D6 false form` 四条用例，每条断言抛出 `unexpected failure signature`。
- [x] AC2：D1 / D2 / D4 / D5 / D6 的签名包含当前实际值（在 `## Notes` 逐条贴出签名原文与对应的 journal 症状）。
- [x] AC3：D3 仍为直接断言且绿；产品代码 diff 为空。
- [x] AC4：`npm run typecheck`、`npm run lint` 退出 0。

## DoD

本地确定性：已知缺陷腿只在当前代码那个特定读数下通过；夹具出错时必然变红；修复任务落地后仍能机械翻转。

## Touches

- server/modules/voice-realtime/tests/voice-realtime-connection-resilience.test.ts
- server/modules/voice-realtime/tests/voice-realtime-known-defect.ts（仅当需要辅助函数输出实际值）
- tasks/gap-live-voice-double-drop-signatures-carry-actuals.md

## Notes

立项：Opus 常驻会话，2026-10-13，复核 AC-365 落地代码时发现（GOAL-043 / AC-370）。

### AC2：签名原文与对应的 journal 症状

journal 正本：`~/.cloudcli/voice-realtime-log/e22ac831-30c6-4600-8bcf-b5c3cc7e3a8c.jsonl`（2026-10-12 16:01–16:03 UTC，segmented，13 段）。下列「当前实际值」为本次单文件运行实测（三次运行读数一致）。

**D1** — 签名原文：

```
seq2 must not be answered `dropped:empty-transcript`: its commit was lost with the socket on dial #1, and no dial ever transcribed it — the current code answers ["dropped:empty-transcript"]
```

- journal 症状：seq2（14.6 s 单帧）写出 commit 后 206 ms 断线 1/3，未收到 `committed`；重连重放后 1.15 s 再断线 2/3；第二次重连因 `replayedSeqs`（`:633, 754-760`）不再重放 ⇒ seq2 丢失；`pendingCommitSeqs` 残留 `[2,2]`，ws-proxy 的 `segmentSeqByItemId`（`:2644-2648`）把 seq4 的空转写误记成「segment 2 dropped: no words」（`markSegmentEmpty` `:2105-2111`）。
- 本次实测读数：seq2 的 `verdicts` = `["committed","committed","dropped:empty-transcript"]`，过滤 `dropped:empty-transcript` 后 = `["dropped:empty-transcript"]`（断言期望 `[]`）。

**D2** — 签名原文：

```
the six final transcripts must land on seqs 0-5, but the current code attributes them to [0,1,2,2,3]
```

- journal 症状：`pendingCommitSeqs`（`:649`，入队 `:733`，出队 `:837, :885-886`）断线不清空 ⇒ 残留 `[2,2]`，seq3/4/5 的 `committed` 错配两位，后续转写归属整体错位。
- 本次实测读数：`wire.captionSeqs()` = `[0,1,2,2,3]`（断言期望 `[0,1,2,3,4,5]`）。

**D4** — 签名原文：

```
three independent drops must each be reconnected — the reconnect budget is spent per connection, not carried across the whole session — but the current code ends at {"dials":3,"state":"closed","fired":[]}
```

- journal 症状：`openAttempts` 终身不复位（`:538/878`）；seq6（12 s 单帧）写出后 1.07 s 断线 3/3 ⇒ 连接永久关闭，第 3 次拨号不再发生。
- 本次实测读数：`{"dials":3,"state":"closed","fired":[]}` —— 三次断线只拨了 3 次号（第 3 次即终态），`faults.fired()` 为空（没有任何一次拨号被上游拒绝）。

**D5** — 签名原文：

```
a segment closed after the reconnect budget is spent must not be answered `committed` — nothing about it reached the endpoint — but the current code answers [10,11,12]
```

- journal 症状：`endSegment` / `flushOpenSegment` 无条件发 `phase: 'committed'`（`:1145-1159`），`writeSegmentClose` 在非 open 时直接返回（`:729`）⇒ 连接关闭后 seq7–12 仍收到 `segment_ack committed`（ws-proxy `:2615`）。
- 本次实测读数：预算耗尽、连接 `closed` 后说出的 seq10/11/12 全被 ack `committed` ⇒ `["committed"]` 列表 = `[10,11,12]`（断言期望 `[]`）。

**D6** — 签名原文：

```
a manual-mode segment may be answered `committed` only behind the endpoint's own input_audio_buffer.committed for it — the current code acks seq [2] ahead of the endpoint (per-ack upstream commit counts [1,2,2])
```

- journal 症状：同上——ack 从 close 路径发出，从不检查端点是否真的答过该 commit；e22ac831 中 seqs 7–12 在上游连接已不存在时仍被 ack `committed`。
- 本次实测读数：`committed` 的 ack seqs = `[0,1,2]`；每个 ack 背后的上游 commit 计数 `wire.commitsBehindEachCommittedAck` = `[1,2,2]`；第 3 个 ack（seq 2）没有独立的上游背书 ⇒ uncovered = `[2]`（断言期望 `[]`）。

### 取假用例（AC1 四条）

每条取假用例都让**夹具**以不同方式出错，使断言以不同的实际值失败，从而必须落到 `unexpected failure signature` 分支（而不是通过、也不是 `defect no longer reproduces`）：

| 用例 | 夹具改动 | 变体读数（≠ 缺陷读数） |
| --- | --- | --- |
| `test('D2 false form` | transcript `{kind:'never'}`（丢一条转写） | `captionSeqs` = `[0,2,3]`（缺陷为 `[0,1,2,2,3]`） |
| `test('D4 false form` | 第 1 次拨号即 `refuse` | `fired` = `[{"dial":1,"reason":"the plan refused this dial"}]`（缺陷为 `[]`；`dials/state` 恰好同形，故读数必须含 `fired`） |
| `test('D5 false form` | 只让第 2 次拨号 `refuse`（之后恢复） | 连接 `open`、dials=3（缺陷为 `closed`，前置条件不成立 ⇒ 断言先红） |
| `test('D6 false form` | `dropBeforeCommit: 2`（丢的是另一条 commit） | 计数 = `[1,1,1]`，uncovered = `[1,2]`（缺陷为 `[1,2,2]` / `[2]`） |

### 验收证据

- AC1：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-connection-resilience.test.ts` 连续三次退出 0，`tests 18 / pass 18 / fail 0`；四条 false form 用例名见上表。
- AC2：本节逐条贴出。
- AC3：D3（`test('D3 a tool call the dropped dial already delivered is not delivered again by the replay'`，`:1133`）仍为直接 `assert.equal`，绿；`fixTask` 未改。产品代码 diff 为空（本次提交只动一个测试文件）。
- AC4：`npm run typecheck` 退出 0；`npm run lint` 退出 0（仅存量 warning）。
