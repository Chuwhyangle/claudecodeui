---
id: gap-voice-context-pack-refresh-and-stale-summary-gate
title: Live Voice context pack 只在连接建立时发送一次 ⇒ run-end summary 播报过期内容：对话变化时重发 + 摘要过期闸
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

2026-10-21 07:23–07:33 实测。浏览器只在 `socket.onopen` 发一次 C2 context 帧（`src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts:2179-2184`），之后对话再增长也不重发；服务端每次 `session.update` 都注入同一份（`server.log` 里 `context injected chars=1981 rows=9` 在 23:28:50–23:32:47 出现五次，一字不差）。run-end summary 读的是这份「最新」pack（`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:4073` 的注释写明读的是那一刻的 pack），于是每轮结束都在总结连接建立那一刻的旧对话。

复现：从会话 transcript 取 23:23:57（连接建立时刻）之前的可见行，按每行 600 字、总预算 2000 字打包（得到 8 行 / 1945 字；服务端日志为 9 行 / 1981 字，差异来自前端可见行的取舍），用线上同一提示词与 `qwen-flash` 得到「声音已经发到你页面了，问题出在浏览器没播放，刷新页面就能解决。」——与当时实际在谈的输入/输出统计毫无关系。23:33:32 实际播报的 `run-end-summary` 为 30 字，就是这条过期结论。

修复两处，一起做：

1. **客户端节流重发 context 帧。** 对话可见行变化后（去抖 2–3 s），若 pack 文本与上次发送的不同就重发一次；socket 关闭/新连接时重置。服务端已支持中途更新（收到 `context` 帧即 `context received … advertiseInstructions()`）。
2. **服务端 summary 过期闸。** 记录每个 context 帧的到达时间与文本；run 结束时若「pack 到达时间早于本轮 run 开始」（说明它不可能包含本轮输出），或「pack 文本与上一次已播报摘要所用的 pack 相同」，则不调用摘要、不注入 `run-end-summary`；确认语 ack 仍按原语义独立发出。宁可沉默，不播错。

<!-- dedup-ref -->
关联（仅追溯，不是依赖）：gap-voice-realtime-context-pack-and-hot-settings（done）交付的是「每次新连接构建并注入」的一次性 pack；本任务是它的更新缺口。

## AC

- [x] 客户端重发：`npx vitest run src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx -t "context"` 退出码 0；用例断言 (a) 新增可见行并跨过去抖窗口后，客户端发出第二个 `context` 帧且文本/字数随之变化；(b) pack 内容未变时不重发；(c) socket 关闭后不再发送。
- [x] 服务端过期闸：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-run-end-summary.test.ts` 退出码 0；用例断言 (a) pack 到达早于本轮 run 开始 ⇒ 不调用 summarize、不注入 run-end-summary，但 run-end ack 仍发出；(b) 与上一次已播报的 pack 文本相同 ⇒ 跳过并记录可归因日志；(c) pack 在本轮 run 开始后更新 ⇒ 正常注入并播报。
- [x] 真实读数：在真实 proxy 的 WS 路径（真实连接或 `voice-realtime-ws-proxy.protocol-simulation.test.ts` 同一路径）上，跨至少两个回合出现**两个不同的** `context injected chars=` 值；被闸掉的那次出现 `run-end summary skipped: stale context pack` 且无 `narrator_speak utterance=run-end-summary`。
- [x] 假形态必须变红：删掉重发逻辑 ⇒ 第一条用例红；删掉过期闸 ⇒ 第二条 (a) 红。
- [x] `npm run typecheck` 与 `npm run lint` 退出码 0。
- [x] 不新增 server 测试文件（`server/shared/tests/quay-test-script.test.ts` 的收集数 pin 不动），新用例加进下面列出的既有测试文件。

## DoD

- 两条测试腿（客户端重发、服务端过期闸）全绿，既有 narrator / run-end ack 用例保持绿。
- 真实落地：在真实 Live Voice 连接（浏览器或对真实 proxy 的 WS 客户端）上，对话增长后服务端日志的 `context injected chars=` 随新回合变化（不再恒定）；过期 pack 的回合只播 `run-end ack`、不播 `run-end-summary`。把这两段实测日志原文贴进本任务 Notes。
- 不新增 server 测试文件。

## Notes

实测（`handleVoiceRealtimeConnection` 的 WS 路径，浏览器 socket 与上游 transport 均为进程内 fake；同一条连接跑三个回合，`voice-realtime-run-end-summary.test.ts` 的 `real proxy WS path` 用例打印原文）：

```
context injected chars=68 rows=2 template=default
to-browser narrator_speak utterance=run-end-ack-0
run-end summary injected chars=16 verbatimTail=1 run=run-1
to-browser narrator_speak utterance=run-end-summary-0
context injected chars=73 rows=2 template=default
to-browser narrator_speak utterance=run-end-ack-1
run-end summary injected chars=16 verbatimTail=3 run=run-2
to-browser narrator_speak utterance=run-end-summary-1
to-browser narrator_speak utterance=run-end-ack-2
run-end summary skipped: stale context pack (it arrived before this run started)
```

两回合的 `context injected chars=` 不再恒定（68 → 73）；第三个回合的 pack 未随对话更新，过期闸跳过摘要，该回合只出现 `narrator_speak utterance=run-end-ack-2`，没有 `run-end-summary`。

客户端重发读数（`useVoiceRealtimeSession.test.tsx -t "context"`）：ack 之后 `[voice-realtime] context chars=15 rows=1`（onopen）→ 新增可见行并跨过 2.5 s 去抖后 `[voice-realtime] context chars=43 rows=2`；pack 未变的那一腿只有一次 `chars=29 rows=2`；socket 关闭后追加对话行不再产生任何 `context` 帧。

假形态（就地消融后恢复）：移除重发 effect ⇒ 客户端第一条用例红；移除两段过期闸 ⇒ 服务端 (a)(b) 与真实读数用例红，(c) 保持绿。

## Touches

- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/voice-realtime/tests/useVoiceRealtimeSession.test.tsx
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/tests/voice-realtime-run-end-summary.test.ts
- tasks/gap-voice-context-pack-refresh-and-stale-summary-gate.md