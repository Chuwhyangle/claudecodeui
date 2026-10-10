# P0a — 真实上游验证（优先三项）

`docs/proposals/voice-realtime-segmented-relay-SPEC.md` 的「分期 / P0」里，本目录只做**优先三项**
（S1 手动音频提交、S2 空闲上游会话切换、S3 上下文注入）。S4–S6 归 P0b。

这里的产物是**证据**，不是夹具：三个探针都连真实 DashScope 上游（`wss://dashscope.aliyuncs.com/api-ws/v1/realtime`），
写下的追踪里是上游真实回的帧，`RESULT.json` 的 `ranAt` 是运行时间。verdict 不是手写的字段——
`scripts/voice-realtime-p0-record-check.mjs` 从追踪的**原始帧**重新推导它，并与记录逐字段比对。

## 怎么跑

```bash
# 真实运行需要一个密钥；密钥不进任何产物（写追踪前会断言擦除后不含 sk- 形态）
set -a; . ./.env.test; set +a

npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-segmented/p0/s1-manual-commit.mts
npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-segmented/p0/s2-session-rotation.mts
npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-segmented/p0/s3-context-injection.mts

# 从刚写下的追踪生成 RESULT.json（追踪即来源，字段由脚本填）
node scripts/voice-realtime-p0-record-check.mjs experiments/voice-realtime-segmented/p0/RESULT.json --stage a --write-result

# 校验：S1–S3 的 verdict/evidence/spend/budget/guard/ranAt，以及 SPEC 的「P0 结论」
node scripts/voice-realtime-p0-record-check.mjs experiments/voice-realtime-segmented/p0/RESULT.json --stage a
node scripts/voice-realtime-p0-record-check.mjs experiments/voice-realtime-segmented/p0/RESULT.json --spec

# 校验器自己的用例（含四种取假形态 + 预算守卫对假上游的单元用例）
node --test scripts/voice-realtime-p0-record-check.test.mjs
```

## 文件

| 文件 | 是什么 |
|---|---|
| `probe-lib.mts` | 连接（出货传输 `createDashscopeTransport` + `observer` 双向抓帧）、事件收集、花费估算与预算守卫（`estimateRealtimeCostCny` 逐 `response.done` 累计，超预算立即关连接并写 `guardTriggered: true`）、写追踪前的密钥擦除 |
| `s1-manual-commit.mts` | `session.update{turn_detection:null}` → 100 ms 分块 append → `input_audio_buffer.commit` → `response.create`；再做同会话两段的变体 |
| `s2-session-rotation.mts` | 连续建立 6 个会话记 `open → session.created → session.updated`；再做「A 活动、B 预热、A 回完后第一段发往 B」的交接 |
| `s3-context-injection.mts` | 1,926 字符上下文包进 `instructions`，6 句 × 2 次全新会话，记转发、编辑距离、标识符命中、`usage.input_tokens` |
| `fixtures/context-sample.json` | 上下文包的来源与原文（行、包、字符数、取自哪些会话、抽取规则） |
| `guard-case.mts` | 预算守卫的单元用例：假上游（进程内 `socketFactory`）回一条远超预算的 `response.done`，断言守卫关闭连接并把 `guardTriggered: true` 写进记录 |
| `traces/*.json` | 三个阶段的原始追踪（可回放） |
| `RESULT.json` | 三个阶段的汇总：verdict、evidence、spend、budget、guard、ranAt、notes |
| `README.md` | 本文件 |

## 两个必须知道的读取规则

这两条都是实测踩出来的，探针与校验器**按同一条规则读同一份帧**，否则两边会对不上：

1. **转发计数按 `call_id` 去重。** 上游把**同一次**函数调用以两种方言各投递一次：
   `response.function_call_arguments.done`，以及 `response.output_item.done` 里 `item.type === 'function_call'`。
   两种都要认（只认一种会把「投递了」读成「没转发」），但**不能相加**——相加会把一次转发读成两次。
   `probe-lib.mts` 的 `sessionSendFrames` 与校验器的 `sessionSends` 都以 `call_id` 为身份、保留首次投递。
2. **错误计数 = 收到的 `error` 帧 + 传输层自己记下的 `transport.error` 条目。** 后者进 `session.errors`
   但从来不是帧，只看帧会少算。两边共用这条规则（`countSessionErrors` / `errorCount`）。

## SPEC 的「P0 结论」——被强制的格式

`--spec` 会读 SPEC 的 `## P0 结论` 一节，并要求每个阶段**恰好一行**以 `- S1` / `- S2` / `- S3` 开头的条目
（多一行少一行都红），每行都必须出现：

| 阶段 | 必须出现 |
|---|---|
| S1 | 推导出的 verdict；`s1-manual-commit.json`；`¥<六位小数>`；`commits=<n>`；`session_send=<n>` |
| S2 | 推导出的 verdict；`s2-session-rotation.json`；`¥<六位小数>`；`n=<n>`；`handover=<ok\|error\|timeout>` |
| S3 | 推导出的 verdict；`s3-context-injection.json`；`¥<六位小数>`；`forwarded=<转发数>/<完成数>` |

`<n>` 与 `<六位小数>` 都取自追踪/`RESULT.json` 本身，所以数字改了而 SPEC 没改，`--spec` 就红。
其余散文（降级路径、实测细节）自由写，但**不要**再起一行以 `- S1`（`- S1–S3 …` 也算）开头的条目。

## 花费

上限 ¥0.04（S1 ≤ ¥0.01 + S2 ≤ ¥0.005 + S3 ≤ ¥0.025）。2026-10-10 实测合计 **¥0.025480**：
S1 ¥0.003497、S2 ¥0.001506、S3 ¥0.020478（单次响应约 1.04 k 输入 token ≈ ¥0.0017）。
单价取账单：文本输入 0.0015、音频输入 0.006、文本输出 0.0045 元/千 token；音频按 7 token/秒。
`--stage a` 会拒绝 Σ 超过 `RESULT.json` 的 `totalBudgetCny`、任一阶段超过自己的 `budgetCny`、
以及 `guardTriggered: true`（守卫触发 = 这一轮被设计截断，不是一次完整运行）。
