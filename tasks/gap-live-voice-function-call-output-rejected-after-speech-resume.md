---
id: gap-live-voice-function-call-output-rejected-after-speech-resume
title: function_call_output 被上游拒（Unknown function call id → Cannot create
  response after rejected
  function_call_output）：调用后、上游确认前用户再开口即必现——归因竞争/取消时序并设计安全回执状态机
status: todo
labels:
  - gap
  - P0
parent: null
children: []
extra:
  acceptance: test -f
    server/modules/voice-realtime/tests/voice-realtime-function-call-output-receipt.test.ts
    && npx tsx --tsconfig server/tsconfig.json --test
    server/modules/voice-realtime/tests/voice-realtime-function-call-output-receipt.test.ts
---
## Proposal

**现象（2026-10-13 真实 live voice，journal `b5d01c21`）**：每次出错都是一对上游错误：

```
<< ERROR invalid_request_error "Unknown function call id: call_…" param=call_id
<< ERROR invalid_request_error "Cannot create response after rejected function_call_output; submit valid input or retry for the current input" param=response
```

本连接共 8 次。**相关性（12/12 吻合，测试主段；之后 1 次同样吻合）**：模型发出 `function_call` 后，若在上游回 `conversation.item.created(type=function_call_output)` **之前**出现 `input_audio_buffer.speech_started`（用户再开口）⇒ 必被拒（6/6）；没开口 ⇒ 必成功（6/6）。上游确认 output 的耗时 0.3–3 s 不等。

**影响**：消息本身已由 proxy 投递（投递与回执独立），但①浏览器每次收到两条 `UPSTREAM_ERROR (recoverable)`；②上游会话缺该 call 的 output 与随后的 response，模型上下文出现空洞；③与 `turn_detected` 取消（同场 2 次 `MALFORMED_FUNCTION_CALL`）属同一类「用户续说打断模型回合」的时序面。

**相关代码**：`voice-realtime-bridge.service.ts:1343` `sendFunctionCallOutput` 直接 `transport.send`；`voice-realtime-dashscope-transport.ts:537` 包成 `conversation.item.create` 并合成 `response.create`；transport 文件头说明了重连时重放未确认 output 的现有机制。既有先例：`gap-voice-three-vad-filtered-pcm-real-upstream-replay` 记录「`Unknown function call id` 仍零星出现，未归因」；`gap-voice-server-vad-three-arm-replay-on-third-test-corpus` 记录 dry-run 执行器触发过一次。

人 yale 2026-10-14 批准（复盘 P0-3）：调查竞争/取消时序，设计安全回执状态机，提供复现与真实验证。

## Plan

1. **归因先于修**：写真实上游复现探针（复用 `experiments/voice-realtime-large-append-probe/probe.mts` 骨架），用 capture `b5d01c21….wav` 的真实语句：臂 R（复现）在收到 `function_call` 后延迟发送 output，并在其间推入下一段语音；臂 C（对照）不推入。记录 `speech_started`、`response.done status`、`conversation.item.created`、错误的逐事件时间线。判定：拒收是由「新用户条目已创建」、「所属 response 被 cancel」、还是「合成 `response.create` 撞上进行中的 response」触发——三者择一或写「不足以判断」。
2. 根据归因设计 transport 层**回执状态机**：每个 call 状态 `pending → output-sent → acked | rejected | superseded`；在已知会被拒的状态下（如所属 response 已 cancelled / 新用户条目已开）**不发** output 或不合成 `response.create`；收到 `Unknown function call id` 时将该 call 记为 `rejected` 并**不向浏览器冒泡为错误**（journal 照记）；随后的 `Cannot create response…` 同理吸收。重连重放逻辑与新状态机一致。
3. 不改变投递语义：`session_send` 投递与否只由 proxy 决定，与回执状态无关（加断言）。
4. 脚本测试：新文件 `voice-realtime-function-call-output-receipt.test.ts`，在 scripted fake 上游上复刻真实拒收规则（以第 1 步归因为准）。

## AC

- [ ] AC1 复现探针在真实上游上至少 1 次复现 `Unknown function call id`（臂 R）且对照臂 C 0 次；时间线、花费（上限 ¥0.3）、所用音频区间与 capture sha256 前缀 `0f2bd51fbbb28c9f` 写入 `docs/operations/voice-realtime-function-call-output-race.md`；归因结论或「不足以判断」明写。
- [ ] AC2 scripted fake 上游按归因规则拒收 ⇒ 状态机下：浏览器 0 条 `UPSTREAM_ERROR` 由该原因产生，journal 有对应 call 的 `rejected|superseded` 记录；取假形态：去掉状态机 ⇒ 浏览器收到该错误、用例红。
- [ ] AC3 正常路径（无续说）output 照常发送并被 ack，合成 `response.create` 次数不变；既有 `voice-realtime-dashscope-transport.test.ts`、`voice-realtime-connection-resilience.test.ts` 单文件运行退出 0。
- [ ] AC4 投递独立性：被 `rejected` 的 call 对应的 `session_send` 投递记录不变（delivered 仍 delivered）。
- [ ] AC5 修复后用同一探针臂 R 在真实上游重跑：拒收导致的浏览器错误为 0（或拒收本身为 0），读数写入同一文档；未重启 :3001（pid 前后相同）、未改生产 env。

## DoD

拒收的时序成因在真实上游上被复现并归因；transport 回执状态机让「用户续说」不再产生浏览器错误、不再在上游会话里留下被拒 output，且不改变任何投递结果；修复后真实复现臂读数为证。

## Touches

- server/modules/voice-realtime/voice-realtime-bridge.service.ts
- server/modules/voice-realtime/voice-realtime-dashscope-transport.ts
- server/modules/voice-realtime/tests/voice-realtime-function-call-output-receipt.test.ts (new)
- experiments/voice-realtime-function-call-output-race/probe.mts (new)
- docs/operations/voice-realtime-function-call-output-race.md (new)
- tasks/gap-live-voice-function-call-output-rejected-after-speech-resume.md

## Notes

**查重（2026-10-14）**：全库检索 `Unknown function call id` 只命中两条 done 的 VAD 实验任务（各自在 Notes 里记为「未归因」），无专门任务。本任务是首个归因与修复任务。

**证据**：journal `~/.cloudcli/voice-realtime-log/b5d01c21-3f53-4228-a28e-d18b7cb967f7.jsonl`（ERROR 行 56:54.413、57:09.557、57:22.026、57:29.557、58:33.810、58:39.869、59:24.990、00:34.524）。
