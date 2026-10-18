---
id: gap-voice-realtime-silent-closing-orphans-tool-resume-overflow
title: Live Voice：silent 收尾轮连 tool-resume 的 response.create 一起砍，上游 turn queue 第
  9 段溢出后静默丢话——resume 恒发、该轮静默
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

### 现象（2026-10-18 操作者实测，journal 逐行复核）

连续语音到第 9 段起，Live Voice 不再产出任何 ASR、也不再投递任何消息，且不自愈。两轮都精确卡在同一位置：

- 首轮 `b87cc63e-0def-4dce-8cb9-d5777de8d88d.jsonl`（silent 默认）：第 1–8 段全 delivered，第 9 段起 `Turn queue overflow: capacity=8`（首个 11:15:03.946Z，共 5 次），此后 0 条 `transcription.completed`、0 条 `session_send`；teardown 报 `buffer too small, or have no audio` + `Conversation already has an active response`。
- 复现轮 `4b0caf30-ecfa-4377-95d9-7981dc45b87b.jsonl`：同样 8 delivered → 第 9 段起 overflow（首个 11:20:27.476Z），timeline 里第 9 段连 `speech_started` 都没有（8 个 speech 段、无第 9）；但采集 wav 在 offset 65s 后仍有 ≥3 段说话能量（ffmpeg silencedetect），证明是上游拒绝接收新 turn，不是麦克风/采集丢。

### 根因

`VOICE_REALTIME_CLOSING_TURN=silent`（2026-10-16 起的出货默认）把 `respondToToolOutputs` 设成 false（`server/index.ts:737`），transport 据此在 `sendClientFrames` 里跳过为每个 `function_call_output` 合成的 tool-resume `response.create`（`voice-realtime-dashscope-transport.ts:986` 的 `continue`）。但 DashScope 协议要求「function_call_output 之后必须 `response.create` 来 resume 这个 turn」（`voice-realtime-dashscope-transport.ts:20-24` 模块注释原文）。于是每个 `session_send` 的执行结果都成为没被消费的孤儿 turn；上游 turn queue 容量 8，8 个孤儿填满后第 9 个用户 turn 被拒（`capacity=8`），此后整会话静默失联。证据对齐：失败轮 journal 均为 8 个 `function_call_output`、0 个会话内 `response.create`；`respond` 实验轮（`41a662a7-0b71-4402-8630-a3e46b790461.jsonl`）每段一个 `response.create`、0 overflow、第 9/10/11 段全过。

### 正确行为（修复方向）

把「resume 这个 turn」与「让模型再说一声 OK」解耦：合成的 tool-resume `response.create` 恒发（协议必需，queue 靠它排空）；省钱只砍「要不要出声」——resume 那轮让模型产空响应。`silent` 的措辞 `acceptedResultTail('silent')` 已经是「Nothing more is needed from you: say nothing and wait…」，所以改的是 `respondToToolOutputs` 的接法（不再 gate resume），不是改提示词。`respond` 是「正确行为 + 46% OK 开销」的止血版，本任务的落点是恢复 silent 的零开销且不丢话。

<!-- dedup-ref --> 去重（机制词 `Turn queue overflow`/`capacity=8`/`tool-resume`/`respondToToolOutputs` 逐词检索）：open 任务零命中。同区域相关但已 done、机制各异：`gap-voice-realtime-followup-credit-blind-consumption`（同一条 `respondToToolOutputs: false` 触发，但修的是桥的「盲额度」计数器，不是 queue overflow）、`gap-live-voice-continuous-duplicate-session-send-without-new-audio`（记录过「去掉 tool-resume 后模型回 'No response requested.'、5 句丢 3 句」的历史回滚，属重复投递机制）。merge-candidate：无开放 peer 共享 Touches，判 separate（none found）。

## AC

- [x] AC1 判据入口：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-tool-resume-always-sent.test.ts` 退出码 0。断言：`respondToToolOutputs === false`（silent）下，transport 对每个 `function_call_output` 仍外发一次合成的 `response.create`（`sendClientFrames` 不再跳过 resume）。
- [x] AC2 默认与措辞不倒退：同一命令（或 `--test-name-pattern` 子集）内断言 `resolveVoiceRealtimeClosingTurn({})`（未设 env）仍返回 `silent`，且 `acceptedResultTail('silent')`/`afterStopSentence('silent')` 仍产出「say nothing」、不含「Reply with the single word OK」——修复不得把 silent 回退成 46% 开销的 respond。
- [ ] AC3 真实会话复测（只能由人 yale 语音执行）：出货默认（silent）下连续 ≥12 段全部 delivered，journal 0 条 `Turn queue overflow`（修复前第 9 段必溢出）（待外部）

## DoD

silent 默认下真实 Live Voice 会话连续 ≥12 段全投递、journal 0 条 `Turn queue overflow`（此前第 9 段必溢出的同一探针翻绿），即「resume 恒发、该轮静默」在真实上游上成立；AC1/AC2 单元测试随代码落地并通过，且 `npm run typecheck`、`npm run lint` 退出码 0。

## Touches

- server/modules/voice-realtime/voice-realtime-dashscope-transport.ts
- server/modules/voice-realtime/voice-realtime-closing-turn.ts
- server/modules/voice-realtime/voice-realtime-bridge.service.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/index.ts
- server/index.ts
- server/modules/voice-realtime/tests/voice-realtime-tool-resume-always-sent.test.ts
- server/modules/voice-realtime/tests/voice-realtime-follow-up-credit.test.ts
- server/modules/voice-realtime/tests/voice-realtime-ws-proxy.real-transport.test.ts
- server/shared/tests/quay-test-script.test.ts
- tasks/gap-voice-realtime-silent-closing-orphans-tool-resume-overflow.md