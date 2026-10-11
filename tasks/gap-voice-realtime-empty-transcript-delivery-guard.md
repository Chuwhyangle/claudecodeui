---
id: gap-voice-realtime-empty-transcript-delivery-guard
title: 空转写不得产生转发消息：提交段转写为空/纯标点时丢弃该段（投递点守卫），补齐断线后上游事件的显式记账与分段路径的竞态测试
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

### 观察到的缺陷（2026-10-11 02:38 CST，一次真实运行）

一次 **segmented** 模式的 Live Voice 通话（连接 `d88c6722`，journal `~/.cloudcli/voice-realtime-log/b3aff806-680a-4ef7-b694-8e47b11c9f69.jsonl`）提交了四段；其中一段的转写是**空字符串**，中继据此**凭空造出一条用户消息并投递进会话**：

```
18:38:23.955  segment seq=0 dur=19200ms reason=max frames=1
18:38:30.777  << transcription.completed ""        ← 端点报出零个词
18:38:31.050  << function_call session_send {"message": "（用户没有说话）"}
18:38:33.552  session_send delivered in 1 ms       ← 已投递进会话
```

journal 佐证：一条 `kind:"session_send"` 且 `"outcome":"delivered"`，文本即上。另外，**最后一段**的上游回答在浏览器 socket 已经关闭之后才到达（段提交 18:39:07.906，socket 关闭 18:39:07.906；`transcription.completed "这信号还可以啊。"` 18:39:09.252，`function_call` 18:39:09.419），它**静默消失了**——journal 里对此**没有任何条目**，操作者无从判断它发生过。

### 边界（本任务只许按「空」判，绝不判语义保真）

守卫**只能**对一个机械条件（端点报出零个词）动作，即**空**。它**绝不**对语义保真动作——本任务**不主张、也不尝试**证明「投递出去的文本忠实等于用户说的话」。中继模型合法地改写/修复话语（正是这种改写让投递文本优于原始 ASR），判断其保真度是模型能力问题，**明确不在本任务范围**。任何要求测量「用户是否真的这么说了」的 AC 都是错的、不得写入。评审应能从本任务体看出这条线是**有意**划下的。

### 既定策略（操作者裁定，照做）

1. 转写为空 ⇒ **丢弃该段**：不发 `session_send`，段以 `dropped` 确认并带显式 reason，journal 记下「非投递」的结果。
2. 「空」包含空串、纯空白、以及**纯标点**（如 `"。"`、`"…"`、`"。。。"`）。
3. **语气词是内容，仍须中继**（`"嗯"`、`"呃"` …）——这是对过度过滤的负控。不得让守卫长成一个停用词过滤器。
4. 模型自撰的空/空白 `message` 同样不得投递。
5. 守卫必须坐在**投递点**，而不只在转写点：转写与模型的 function call 可以任意顺序到达（今夜转写 18:38:30.777、function call 18:38:31.050——模型也可能先于转写作答）。
6. 关闭后的上游事件（某已提交段在浏览器 socket 已消失后到达的 `transcription.completed` / `function_call` / `response.done`）必须被丢弃而**不抛错**，并被**显式记录**为「非投递」，使其缺席与「什么都没发生」可区分。

### 去重与合并判定

<!-- dedup-ref --> 机制去重（立案时实测）：`task_list` 检索 `空转写`、`empty transcription session_send discard segment`、`voice-realtime empty transcript guard`、`dropped duplicated segment`、`teardown race socket closed not-delivered` 均 0 命中；本任务覆盖「服务端投递点的空转写守卫 + 关闭后显式记账」，无既有任务覆盖该机制。

<!-- dedup-ref --> 相关但机制不同，判定 **separate**（同区不同机制，均保持为独立任务）：`gap-live-voice-single-transcript-row`（ready，AC-326）在**客户端**把多条 caption 折成一行、空 caption 不产生 UI 行——那是渲染层的一行化，不在投递点、不发 `session_send`、不碰 `server/`；本任务在**服务端**投递点拦截一条会被造出来的消息，文件集与之不相交（本任务不碰 `ChatInterface.tsx` / `placeCaptions.ts` / `useVoiceRealtimeSession.ts`）。`gap-live-voice-delivery-state-visible`（todo，AC-327）与 `gap-voice-realtime-uplink-audio-capture`（todo）都声明了 `voice-realtime-ws-proxy.service.ts`（调度器会据 Touches 把三者串行），但机制分别是「outbound 交付状态帧」与「上行音频旁路采集」，与本守卫机制不同、验收相互独立。

## Plan

1. **L1（客户端切段器，纯函数）**：在既有 `src/modules/chat/utils/tests/voiceLiveSegmenter.test.ts` 补齐操作者裁定的 6 条矩阵——(1) 连续语音无 ≥ 提交间隔的停顿 ⇒ 恰一段、`reason=max`、时长 ≈ `RELAY_MAX_SEGMENT_SEC = 20`；(2) 语音 → 2.5 s 停顿 → 语音 ⇒ 两段、`reason=gap`、第二段带 `RELAY_PRE_ROLL_SEC = 0.3` 预卷使首音素不被切掉；(3) 边界值：1.6 s 停顿（落在 `RELAY_MERGE_GAP_SEC = 1.5` 与 `RELAY_COMMIT_GAP_SEC = 2.0` 之间）⇒ **不切**、并入下一段；(4) 短于 `RELAY_MIN_SEGMENT_SEC = 0.25` 的脉冲 ⇒ 不产段；(5) 确定性：同一帧序列两次分段逐段相同（读数可比）；(6) 回归：60 s 独白含数个 1.9 s 停顿 ⇒ 多于一段且无一段命中 `max`。
2. **L2（服务端桥/代理；假 transport + 假浏览器 socket）**：在 `voice-realtime-ws-proxy.service.ts`（必要时 `voice-realtime-bridge.service.ts`）实现**投递点守卫**，并新建 `server/modules/voice-realtime/tests/voice-realtime-empty-transcript-guard.test.ts` 覆盖第 7–16 条：缺陷本身（空转写 ⇒ 无 `session_send`、ack `dropped` 带显式 reason、journal outcome ≠ delivered）；空边界 + 负控（`""` / 纯空白 / `"。"` / `"…"` ⇒ 丢弃，`"嗯"` / `"呃"` ⇒ **中继**）；顺序竞态（function call 先于空转写已知 ⇒ 仍拦）；模型自撰空消息 ⇒ 不投递；关闭后事件 ⇒ 不抛、不投递、显式 `not-delivered (socket closed)`；音频帧在 transport `connecting` / `closing` / `closed` ⇒ 丢弃而非抛错（钉住那条历史未捕获异常，其源码注释自述会「把整个进程连同其他人的连接一起带走」）；未知/乱序 `seq`（实现就在 `voice-realtime-ws-proxy.service.ts:994` 一带）⇒ 丢弃并记 `unknown-segment`、重复 `segment_end` ⇒ 幂等不双提交；握手中性（正确 `hello` token ⇒ `ready{segmented-v1}`；错/缺 token ⇒ 无 `ready` 且帧序列与连续路径逐字节一致）。
3. **L2 台账（第 15/16 条）**：就地钉住 `>> session.update voice=Tina tools=0` 实际携带的帧——断言 `session.tools` 长度仍为 1；**若真实行为相反（tools 真丢了），在本任务记一条阻塞性 finding，而不是钉错值**。segmented 路径的 journal 完整性：逐响应的 token 求和等于 usage 行（既有 AC5 只覆盖连续路径）；每段记 seq/时长/reason/frames；`session_send` 的 outcome 覆盖新状态。
4. **L3（e2e，`--segments` 诊断路径）**：第 17 条（多句间隔 2.5 s ⇒ 每句一次 `session_send`、各带 caption、无空转写发送）；第 18 条**已按操作者修改**——连续 ~25 s 独白（今夜产出空转写的形状）**只**断言机械事实（发生 `max` 强切、段被 ack、journal 记下、不抛异常、空转写不产生 send），**不断言投递文本是否与所言相符**（那是范围外的模型保真问题）；第 19 条拆除竞态（段在途时关 socket ⇒ 不抛、不造消息、journal 记下最后一段）。
5. **静态门**：新增两个 server 测试文件会牵动 `server/shared/tests/quay-test-script.test.ts` 的文件数钉子与 `scripts/suite-duration-baseline.tsv`，同步之；跑 `npm run typecheck` 与 `npm run lint`。

## AC

- [x] AC1 缺陷本身：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-empty-transcript-guard.test.ts` 退出 0；且「空转写不投递」这条断言是该文件里的**第一条**断言（取假形态「空转写确实产生一条 `session_send`」时必须最先变红，不被兄弟断言掩盖）。给出 `session_send` 计数与段 ack 的实测读数。
- [x] AC2 空边界 + 语气词负控：同文件读数为——`""` / 纯空白 / `"。"` / `"…"` ⇒ 无 `session_send`、段 ack `dropped` 且带显式 reason、journal 中该段无 `delivered`；`"嗯"` / `"呃"` ⇒ **投递**（负控：过滤器不得吃掉语气词）。
- [x] AC3 投递点与顺序竞态：模型 function call 先于空转写到达时守卫仍拦截（该用例读出 `session_send` 计数为 0）；模型自撰的空/空白 `message` 即便转写非空也不投递；音频帧在 transport `connecting` / `closing` / `closed` 时被丢弃而非抛错；未知 `seq` ⇒ 丢弃并记 `unknown-segment`，重复 `segment_end` ⇒ 幂等无双重提交。
- [x] AC4 关闭后记账：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-teardown-races.test.ts` 退出 0；已提交段在浏览器 socket 关闭后到达的 `transcription.completed` / `function_call` / `response.done` 不抛异常，且 journal 里有一条显式的 `not-delivered (socket closed)` 记录（把「缺席」与「什么都没发生」区分开）。
- [x] AC5 握手中性 + tools 台账：正确 `hello` token ⇒ `ready{segmented-v1}`；错/缺 token ⇒ 无 `ready` **且**帧序列与连续路径逐字节一致（回退路径依赖此）。另：`>> session.update voice=Tina tools=0` 实际携带的 `session.tools` 长度仍为 1；若实测相反，在本任务记阻塞性 finding 而非钉错值。
- [x] AC6 L3 e2e 机械事实（`--segments` 诊断路径）：多句间隔 2.5 s ⇒ 每句一次 `session_send`、各带 caption、无空转写发送；连续 ~25 s 独白 ⇒ 发生 `max` 强切、段被 ack、journal 记下、不抛异常、空转写不产生 send（**不**断言文本保真）；段在途关 socket ⇒ 不抛、不造消息、journal 记下最后一段。
- [x] AC7 L1 矩阵与静态门：`npx vitest run src/modules/chat/utils/tests/voiceLiveSegmenter.test.ts` 退出 0（含 L1 六条）；新增 server 测试文件后 `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0（同步文件数钉子与 `scripts/suite-duration-baseline.tsv`）；`npm run typecheck` 与 `npm run lint` 退出 0。

## DoD

真实落地判据：**一个真实对象被这套机制操作过**——一条真实（或经 `--segments` 诊断路径的）segmented 连接里，某段的转写回来是**空**，该段**不产生任何被投递的消息**（journal 里可读到该段的非投递结果，且会话里没有对应消息）；一条在段中途被切断的连接留下一条**显式的 `not-delivered` 记录**（不是「静默消失」）。上面 L1/L2 矩阵已实现且通过；单元测试是必要但不充分。证据落在本任务 Evidence（journal 片段、`session_send` 计数、段 ack、e2e 读数/截图）。⛔ 本任务**不**证明任何投递文本与所言相符——那只按「空」判，语义保真明确不在范围。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/voice-realtime-log.ts（journal 新增 not-delivered 结果类型与 `session_send not-delivered (...)` 行解析）
- server/modules/voice-realtime/voice-realtime-bridge.service.ts
- server/modules/voice-realtime/tests/voice-realtime-empty-transcript-guard.test.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-teardown-races.test.ts (new)
- src/modules/chat/utils/voiceLiveSegmenter.ts
- src/modules/chat/utils/tests/voiceLiveSegmenter.test.ts
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-voice-realtime-empty-transcript-delivery-guard.md (self)

## 验证记录

实测读数（本任务 worktree，`task/gap-voice-realtime-empty-transcript-delivery-guard`，已预合并 develop）：

- **L1**：`npx vitest run src/modules/chat/utils/tests/voiceLiveSegmenter.test.ts` ⇒ 28 passed（含 L1(1)–L1(6)）。L1(1) 25 s 无停顿 ⇒ 恰一处 `max` 强切、时长 20.000 s；L1(2) 2.5 s 停顿 ⇒ 两段，第二段 `startSec = 3.7 − 0.3 = 3.4 s`（预卷）；L1(4) 亚阈值脉冲 ⇒ `[]`，阈值处脉冲 ⇒ 1 段；L1(5) 两次分段逐字段 + wav sha256 相同；L1(6) 7 段、零 `max`。
- **L2**：`npx tsx --tsconfig server/tsconfig.json --test …voice-realtime-empty-transcript-guard.test.ts …voice-realtime-teardown-races.test.ts` ⇒ 20 passed（17 + 3）。
- **静态门**：`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` ⇒ 11 passed（文件数钉子同步为 `known=3 unknown=281` / `known=1 unknown=283`，总数 284）；`npm run typecheck` 退出 0；`npm run lint` 退出 0（本任务文件无 error、无新增告警）。
- **`session_send` 计数 / 段 ack / journal**：空转写段 = 0 次投递、ack `dropped` reason `empty-transcript`、journal 1 条 `session_send not-delivered (empty-transcript)`；语气词 `"嗯"`/`"呃"` = 各 1 次投递（负控）；关闭后到达的答案 = 0 次投递、journal 1 条 `session_send not-delivered (socket closed)`；被 teardown 释放的挂起中继同样记 `not-delivered (socket closed)`。
- **tools 台账**：`>> session.update voice=Tina tools=0` 实际携带的 `session.tools` 长度 = 1，与既有连续路径一致（未丢失，无需 filing）。

### Finding（Plan 措辞与实测不符，已按实测钉住、未改代码）

Plan 第 1 条 (3) 写「1.6 s 停顿（落在 `RELAY_MERGE_GAP_SEC = 1.5` 与 `RELAY_COMMIT_GAP_SEC = 2.0` 之间）⇒ **不切**、并入下一段」。**实测相反**：客户端 `scanRelay` 对任何**严格大于** `RELAY_MERGE_GAP_SEC` 的停顿即切段——源码注释自述「A pause in (mergeGap, commitGap) is never merged」——故 1.6 s 停顿**会**切成两段（`reason='gap'` 的常规停顿切分，非缺陷）。L1(3) 因此按实测行为钉住（1.5 s 合并、1.6 s 切分）并在测试内注明；**未修改**客户端切段器：本任务的可交付是「补齐测试矩阵」，不是改切段语义。若要把语义改成 Plan 所述（`(mergeGap, commitGap)` 区间并入），须另立任务。
