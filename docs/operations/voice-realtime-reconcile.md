# Live Voice 分段中继 —— 一次真实运行的成本对账

本文件是 GOAL-034 / AC-322 的对账记录：一次**真实** Qwen Realtime 运行，走**分段中继路径**，
把连接自己报出的读数与端点自己回的 `response.done.usage` 摊开来核对。

**这不是模型推演，是一次运行的读数。** 运行时点 2026-10-10；端点
`wss://dashscope.aliyuncs.com/api-ws/v1/realtime`，模型与 voice 取出货默认；音频是仓库里的
中文听写片段 `experiments/voice-trim/fixtures/zh-d01-o85.wav`（11.887 s，单声道 16 kHz PCM16），
在**本侧**切成 2 段后经 `segment_start` / `audio{seq}` / `segment_end` 送出。

连接由**出货的** `runVoiceRealtimeDiagnosis` 驱动，它调用**出货的**
`handleVoiceRealtimeConnection` —— 所以这里的结论也是麦克风路径的结论。传输是出货的
`createDashscopeTransport`，直连线上端点。唯一的替身是执行器：`session_send` 被记录而不投递
（HTTP 诊断路由的 `--dry-run` 就是这么做的——一次测量不该往真实会话里注入消息）。

运行结果：`ok=true`、`heard=true`、`answered=true`、`elapsedMs=23032`、
`errors=[]`。运行结束时无残留连接（传输由连接自身关闭，报告是连接关闭后的读数）。

**一处如实记录。** 本次运行里模型在最后**反复调用同一个工具**，连接的
`TOOL_LOOP_GUARD` 在 7 次后把它停住了（报告 `problems` 里两条 `recoverable`）：这是
dry-run 执行器每次都回同一个结果的已知后果，也是 SPEC F8 里花钱失控的那一类行为——
守卫把它按住了，代价没有越过预算。后面的 `input_tokens` 因此一路增长到 1,271，
把这一次运行的总花费推到了 ¥0.0254（预算 ¥0.05 内）。

## 读数

| 指标 | 值 |
| --- | --- |
| segments | 2 |
| audioSecondsUpstream | 11.8870625 |
| textInputTokens | 12684 |
| audioInputTokens | 784 |
| textOutputTokens | 378 |
| logEstimateCny | 0.025431 |
| usageSumCny | 0.025431 |
| bill | pending-external |

- `segments` / `audioSecondsUpstream` 来自诊断报告：两段都 `commit=manual`
  （各一次 `input_audio_buffer.commit`），`ack=committed`，上行音频 11.887 s。
- 三类 token 来自**端点自己回的** `response.done.usage`：`input_tokens_details.text_tokens`、
  `input_tokens_details.audio_tokens`、`output_tokens`，逐响应相加。
  （诊断报告的 `usage` 只聚合 `in`/`out` 两个数，没有这个拆分——所以拆分取自原始帧。）
- `logEstimateCny` 是连接日志的 `cost~CNY`（出货 `estimateRealtimeCostCny`，逐 `response.done` 累加）；
  `usageSumCny` 是按同一批原始帧的 token 重算的价格。两者相等，是因为它们算的确实是同一次运行。

## 逐响应

| textInput | audioInput | textOutput | logEstimateCny | usageSumCny |
| --- | --- | --- | --- | --- |
| 541 | 21 | 27 | 0.001059 | 0.001059 |
| 600 | 21 | 27 | 0.001147 | 0.001147 |
| 659 | 21 | 27 | 0.001236 | 0.001236 |
| 718 | 21 | 27 | 0.001324 | 0.001324 |
| 777 | 21 | 27 | 0.001413 | 0.001413 |
| 836 | 21 | 27 | 0.001501 | 0.001501 |
| 895 | 21 | 27 | 0.001590 | 0.001590 |
| 917 | 91 | 27 | 0.002043 | 0.002043 |
| 976 | 91 | 27 | 0.002132 | 0.002132 |
| 1035 | 91 | 27 | 0.002220 | 0.002220 |
| 1094 | 91 | 27 | 0.002309 | 0.002309 |
| 1153 | 91 | 27 | 0.002397 | 0.002397 |
| 1212 | 91 | 27 | 0.002485 | 0.002485 |
| 1271 | 91 | 27 | 0.002574 | 0.002574 |

## 逐段

| seq | audioSeconds |
| --- | --- |
| 0 | 2.37740625 |
| 1 | 9.50965625 |

## 账单

`bill` 列写的是 `pending-external`：阿里云**账单行尚未取得**，所以本地估算**没有**与账单核对过。
`--check` 必须把这一状态**如实报告为未对账**，而不是当作通过——把账单列留空则直接判红。

## `--check` 原始输出

\`\`\`
$ node scripts/voice-realtime-reconcile.mjs --check docs/operations/voice-realtime-reconcile.md
record: docs/operations/voice-realtime-reconcile.md
  segments = 2
  audioSecondsUpstream = 11.8870625
  textInputTokens = 12684
  audioInputTokens = 784
  textOutputTokens = 378
  logEstimateCny = 0.025431
  usageSumCny = 0.025431
  bill = pending-external
  · 账单：pending-external —— 本地估算 ¥0.0254 尚**未**与阿里云账单核对（待外部提供账单行）
RECONCILE OK（本地一致）
\`\`\`

## `--self-test` 原始输出

\`\`\`
$ node scripts/voice-realtime-reconcile.mjs --self-test
ok   well-formed，账单 pending-external ⇒ 通过（并如实报告未对账）: ok=true（期望 true）
ok   日志估算 ≠ response.done.usage 之和 ⇒ 红: ok=false（期望 false） — log-vs-usage: response #1 日志估算=¥0.002382 与 response.done.usage 之和=¥0.003500 偏差 > 1%
ok   估算 ≠ 单价×token ⇒ 红: ok=false（期望 false） — estimate-vs-price: response #1 单价×token=¥0.002382 与记录的 logEstimateCny=¥0.010000 偏差 > 1%
ok   账单列为空 ⇒ 红（空账单不当成功）: ok=false（期望 false） — reading-missing: 读数表缺少非空的「bill」
ok   逐响应合计 ≠ 读数合计 ⇒ 红: ok=false（期望 false） — summary-vs-detail: 读数「textInputTokens」=9999 与逐响应合计=2900 偏差 > 1%
ok   pending 账单被如实报告为未对账
SELF-TEST PASS
\`\`\`
