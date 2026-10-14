---
id: gap-voice-malformed-call-truncated-by-turn-detected
title: 语音 MALFORMED_FUNCTION_CALL：被 turn_detected 截断的调用归类为「被新话截断」，不向前端报错
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**现状（2026-10-14 09:34 实测，journal `~/.cloudcli/voice-realtime-log/d4c9bfc4-….jsonl`）**：5 次 `MALFORMED_FUNCTION_CALL`（01:35:03、01:36:45、01:36:47、01:37:20、01:37:23），**全部**同一机理：模型正在流式写 `session_send` 参数，人接着说话 ⇒ 上游 `server_vad` 判新回合 ⇒ `response.done status=cancelled reason=turn_detected` ⇒ 参数被截断（`Unexpected end of JSON input` / `Unterminated string`）⇒ bridge（`voice-realtime-bridge.service.ts:1335`）报 MALFORMED ⇒ proxy 向浏览器发 `to-browser error MALFORMED_FUNCTION_CALL (recoverable)`。时序：MALFORMED 在 `.664`，`response.done cancelled` 在 `.665`，同一 response。**5/5 次模型下一次调用都把整句补全了，无丢话**（watermark 设计正是为此：`voice-realtime-ws-proxy.service.ts:1995` 注释）。所以这是预期中的截断，被当成错误展示给人，是噪声。

**修法**：MALFORMED 先挂起到**同一 response 的 `response.done`**：
- `status=cancelled` 且 `reason=turn_detected` ⇒ 记为「被新话截断」：journal 写一行 `truncated-by-turn`（含 callId），计数，**不**向浏览器发 error 帧；
- 其余（`completed` 或其它原因）⇒ 照旧报 `MALFORMED_FUNCTION_CALL`。
- `response.done` 迟迟不到（超时或连接关闭）⇒ 按原样报错，保守方向。

不改 VAD 静音时长（400 ms）：调大可减少截断，但直接加大投递延迟。

<!-- dedup-ref -->
合并候选检查（`task-granularity-advice.js`）：none found。按人的要求单独立案（改动小、独立验收），不并入 Q 行任务 `gap-voice-queue-row-stuck-idle-subscribe-audience-reconcile`。

## AC

- [x] AC1 夹具（scripted upstream）：一次 `session_send` 参数被截断、随后同一 response 以 `cancelled/turn_detected` 结束 ⇒ 浏览器侧**不**收到 `MALFORMED_FUNCTION_CALL` error 帧，journal 出现一行含 `truncated-by-turn` 的日志；`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts` 退出 0。
- [x] AC2 同一夹具的对照：参数非 JSON 但 response 以 `completed` 结束 ⇒ 浏览器仍收到 `MALFORMED_FUNCTION_CALL` error 帧（真正的畸形不被吞）。
- [x] AC3 不丢话：截断后模型重发完整调用 ⇒ 截断前已转写的句子由重发那次投递覆盖（投递文本含截断前那段转写），同一测试文件内断言。
- [x] AC4 取假形态：去掉挂起、立即上报 ⇒ AC1 红；复原后绿。读数写入本任务。读数（2026-10-14）：把挂起点 `holdMalformed(fault)` 换成 `emitError(fault)`（收到即报，即本任务前的行为）后，同一夹具在浏览器侧收到的 `MALFORMED_FUNCTION_CALL` error 帧数 **0 → 1**（AC1 首条断言红）；复原后回到 **0**，AC1 绿。假形态施加在 bridge 的副本上，proxy 副本指向该副本，读数取自浏览器帧（`AC4 false form: …`）。
- [x] AC5 `npm run typecheck` 退出 0；`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-continuous-empty-guard-span.test.ts` 退出 0（span/watermark 回归面）。

## DoD

真实 Live Voice 会话中，人在模型写调用时接着说话造成的截断不再在页面冒出错误帧，journal 以 `truncated-by-turn` 计数；真正的畸形调用照常报错；截断前的话仍随重发投递到会话，不丢。

## Touches

- server/modules/voice-realtime/voice-realtime-bridge.service.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/tests/voice-realtime-bridge.test.ts
- tasks/gap-voice-malformed-call-truncated-by-turn-detected.md
